use crate::config::MAX_RTSP_WORKERS_HARD_CAP;
use crate::pipeline::CameraRuntimeState;
use crate::tracker::{LatestFrameSlot, RawFrame};
use ffmpeg_next::format::Pixel;
use ffmpeg_next::frame::Video;
use ffmpeg_next::media::Type as MediaType;
use ffmpeg_next::software::scaling::{context::Context as ScalingContext, flag::Flags as ScaleFlags};
use ffmpeg_next::Dictionary;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

static FFMPEG_INIT_RESULT: OnceLock<Result<(), String>> = OnceLock::new();

pub fn ensure_ffmpeg_init() -> Result<(), String> {
    let res = FFMPEG_INIT_RESULT.get_or_init(|| {
        ffmpeg_next::init().map_err(|e| format!("ffmpeg_next::init failed: {e}"))
    });
    res.clone()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CameraDescriptor {
    pub id: i64,
    pub rtsp_url: String,
    pub fps: u32,
    pub aktif: bool,
    pub capture_max_width: Option<u32>,
    pub min_face_size: Option<u32>,
    pub max_face_size: Option<u32>,
}

impl CameraDescriptor {
    pub fn signature(&self) -> String {
        format!(
            "{}|{}|{}|{:?}|{:?}|{:?}",
            self.rtsp_url.trim(),
            self.fps,
            self.aktif,
            self.capture_max_width,
            self.min_face_size,
            self.max_face_size
        )
    }

    pub fn is_valid_active_stream(&self) -> bool {
        let u = self.rtsp_url.trim();
        self.aktif
            && !u.is_empty()
            && !u.starts_with("dummy://")
            && (u.starts_with("rtsp://") || u.starts_with("rtsps://") || u.starts_with("file://") || u.starts_with('/'))
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReconcilePlan {
    pub kept_ids: Vec<i64>,
    pub to_stop: Vec<i64>,
    pub to_start: Vec<CameraDescriptor>,
    pub capped_dropped_ids: Vec<i64>,
}

/// Computes a deterministic camera worker diff respecting the hard cap of 8 active RTSP streams
/// without restarting streams whose configuration signature has not changed.
pub fn plan_camera_reconcile(
    desired: &[CameraDescriptor],
    running: &HashMap<i64, CameraRuntimeState>,
    max_workers: usize,
) -> ReconcilePlan {
    let cap = max_workers.min(MAX_RTSP_WORKERS_HARD_CAP);

    let mut eligible: Vec<CameraDescriptor> = desired
        .iter()
        .filter(|c| c.is_valid_active_stream())
        .cloned()
        .collect();
    eligible.sort_by_key(|c| c.id);

    let mut capped_dropped_ids = Vec::new();
    if eligible.len() > cap {
        for extra in eligible.drain(cap..) {
            capped_dropped_ids.push(extra.id);
        }
    }

    let mut desired_by_id: HashMap<i64, CameraDescriptor> = HashMap::new();
    for cam in eligible {
        desired_by_id.insert(cam.id, cam);
    }

    let mut kept_ids = Vec::new();
    let mut to_stop = Vec::new();
    let mut to_start = Vec::new();

    for (&running_id, state) in running {
        match desired_by_id.get(&running_id) {
            Some(cam) if cam.signature() == state.signature => {
                kept_ids.push(running_id);
            }
            _ => {
                to_stop.push(running_id);
            }
        }
    }

    let kept_set: HashSet<i64> = kept_ids.iter().copied().collect();
    let mut sorted_desired: Vec<CameraDescriptor> = desired_by_id.into_values().collect();
    sorted_desired.sort_by_key(|c| c.id);
    for cam in sorted_desired {
        if !kept_set.contains(&cam.id) {
            to_start.push(cam);
        }
    }

    kept_ids.sort_unstable();
    to_stop.sort_unstable();

    ReconcilePlan {
        kept_ids,
        to_stop,
        to_start,
        capped_dropped_ids,
    }
}

/// Exponential backoff starting at 1s and capped at 30s.
pub fn compute_reconnect_backoff_ms(attempt: u32) -> u64 {
    let shift = attempt.min(6);
    let ms = 1_000u64.saturating_mul(1u64 << shift);
    ms.min(30_000)
}

/// SSRF defense: restricts backend sync URLs strictly to loopback hosts over HTTP.
pub fn validate_loopback_backend_url(raw: &str) -> Option<String> {
    let trimmed = raw.trim().trim_end_matches('/');
    let rest = trimmed.strip_prefix("http://")?;
    let host_port = rest.split('/').next()?;
    let host = host_port.split(':').next()?;
    if host == "127.0.0.1" || host == "localhost" {
        Some(trimmed.to_string())
    } else {
        None
    }
}

pub fn compute_target_decode_dims(src_w: u32, src_h: u32, max_width: u32) -> (u32, u32) {
    let sw = src_w.max(2);
    let sh = src_h.max(2);
    if max_width == 0 || sw <= max_width {
        return (sw & !1, sh & !1);
    }
    let ratio = max_width as f64 / sw as f64;
    let tw = (max_width & !1).max(2);
    let th = (((sh as f64 * ratio).round() as u32) & !1).max(2);
    (tw, th)
}

fn copy_rgb24_frame(frame: &Video, width: u32, height: u32) -> Vec<u8> {
    let stride = frame.stride(0);
    let data = frame.data(0);
    let row_bytes = (width as usize) * 3;
    let mut out = Vec::with_capacity(row_bytes * (height as usize));
    for y in 0..(height as usize) {
        let start = y * stride;
        let end = start + row_bytes;
        if end <= data.len() {
            out.extend_from_slice(&data[start..end]);
        } else {
            out.resize(out.len() + row_bytes, 0);
        }
    }
    out
}

pub fn unix_now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[derive(Debug, Clone)]
pub enum StreamStatusEvent {
    Online { camera_id: i64 },
    Offline { camera_id: i64, error: String },
}

/// Blocking in-process RTSP reader using `ffmpeg-next`. Designed to run on a dedicated OS thread
/// (`tokio::task::spawn_blocking`) per camera (max 8 cameras total). Never spawns `ffmpeg` CLI subprocesses.
pub fn run_rtsp_decoder_loop<F>(
    cam: CameraDescriptor,
    max_capture_width: u32,
    process_every_n: u64,
    slot: Arc<LatestFrameSlot>,
    stop_flag: Arc<AtomicBool>,
    mut on_status: F,
) where
    F: FnMut(StreamStatusEvent),
{
    if let Err(err) = ensure_ffmpeg_init() {
        on_status(StreamStatusEvent::Offline {
            camera_id: cam.id,
            error: err,
        });
        return;
    }

    let mut attempt: u32 = 0;
    let min_interval_ms = 1_000u64 / (cam.fps.clamp(1, 15) as u64);
    let every_n = process_every_n.max(1);

    while !stop_flag.load(Ordering::Relaxed) {
        match decode_rtsp_session(
            &cam,
            max_capture_width,
            every_n,
            min_interval_ms,
            &slot,
            &stop_flag,
            &mut on_status,
        ) {
            Ok(()) => {
                attempt = 0;
            }
            Err(err) => {
                on_status(StreamStatusEvent::Offline {
                    camera_id: cam.id,
                    error: err,
                });
                attempt = attempt.saturating_add(1);
            }
        }

        if stop_flag.load(Ordering::Relaxed) {
            break;
        }
        let sleep_ms = compute_reconnect_backoff_ms(attempt);
        let mut waited = 0u64;
        while waited < sleep_ms && !stop_flag.load(Ordering::Relaxed) {
            let chunk = (sleep_ms - waited).min(200);
            std::thread::sleep(std::time::Duration::from_millis(chunk));
            waited += chunk;
        }
    }
}

fn decode_rtsp_session<F>(
    cam: &CameraDescriptor,
    max_capture_width: u32,
    every_n: u64,
    min_interval_ms: u64,
    slot: &LatestFrameSlot,
    stop_flag: &AtomicBool,
    on_status: &mut F,
) -> Result<(), String>
where
    F: FnMut(StreamStatusEvent),
{
    let mut opts = Dictionary::new();
    opts.set("rtsp_transport", "tcp");
    opts.set("stimeout", "7000000");
    opts.set("fflags", "nobuffer");
    opts.set("flags", "low_delay");

    let mut ictx = ffmpeg_next::format::input_with_dictionary(&cam.rtsp_url, opts)
        .map_err(|e| format!("RTSP open failed: {e}"))?;

    let stream = ictx
        .streams()
        .best(MediaType::Video)
        .ok_or_else(|| "no video stream found in RTSP input".to_string())?;
    let video_stream_index = stream.index();

    let codec_ctx = ffmpeg_next::codec::context::Context::from_parameters(stream.parameters())
        .map_err(|e| format!("codec context init failed: {e}"))?;
    let mut decoder = codec_ctx
        .decoder()
        .video()
        .map_err(|e| format!("video decoder open failed: {e}"))?;

    let src_w = decoder.width().max(2);
    let src_h = decoder.height().max(2);
    let (target_w, target_h) = compute_target_decode_dims(src_w, src_h, max_capture_width);

    let mut scaler = ScalingContext::get(
        decoder.format(),
        src_w,
        src_h,
        Pixel::RGB24,
        target_w,
        target_h,
        ScaleFlags::BILINEAR,
    )
    .map_err(|e| format!("swscale context init failed: {e}"))?;

    on_status(StreamStatusEvent::Online { camera_id: cam.id });

    let mut frame_seq: u64 = 0;
    let mut last_pushed_ms: u64 = 0;

    for (pkt_stream, packet) in ictx.packets() {
        if stop_flag.load(Ordering::Relaxed) {
            return Ok(());
        }
        if pkt_stream.index() != video_stream_index {
            continue;
        }
        if decoder.send_packet(&packet).is_err() {
            continue;
        }
        let mut decoded = Video::empty();
        while decoder.receive_frame(&mut decoded).is_ok() {
            frame_seq += 1;
            if every_n > 1 && (frame_seq % every_n) != 0 {
                continue;
            }
            let now_ms = unix_now_ms();
            if now_ms.saturating_sub(last_pushed_ms) < min_interval_ms {
                continue;
            }
            last_pushed_ms = now_ms;

            let mut rgb_frame = Video::empty();
            if scaler.run(&decoded, &mut rgb_frame).is_err() {
                continue;
            }
            let rgb_bytes = copy_rgb24_frame(&rgb_frame, target_w, target_h);
            slot.push(RawFrame {
                seq: frame_seq,
                captured_ms: now_ms,
                width: target_w,
                height: target_h,
                rgb: rgb_bytes,
            });
        }
    }

    Err("RTSP stream ended (EOF)".to_string())
}
