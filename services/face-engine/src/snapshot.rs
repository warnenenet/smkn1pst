use image::codecs::jpeg::JpegEncoder;
use image::{imageops::FilterType, RgbImage};
use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use tokio::sync::mpsc;

#[derive(Debug, Clone)]
pub struct SnapshotWriteJob {
    pub file_name: String,
    pub jpeg_bytes: Vec<u8>,
}

/// Sliding 1-second byte budget enforcing disk write throughput strictly below `< 1 MB/s`.
#[derive(Debug)]
pub struct SnapshotByteBudget {
    max_bytes_per_sec: usize,
    entries: VecDeque<(u64, usize)>,
    window_bytes: usize,
}

impl SnapshotByteBudget {
    pub fn new(max_bytes_per_sec: usize) -> Self {
        Self {
            max_bytes_per_sec: max_bytes_per_sec.max(32 * 1024),
            entries: VecDeque::new(),
            window_bytes: 0,
        }
    }

    pub fn try_consume(&mut self, bytes: usize, now_ms: u64) -> bool {
        while let Some(&(ts, sz)) = self.entries.front() {
            if now_ms.saturating_sub(ts) >= 1_000 {
                self.entries.pop_front();
                self.window_bytes = self.window_bytes.saturating_sub(sz);
            } else {
                break;
            }
        }
        if self.window_bytes.saturating_add(bytes) > self.max_bytes_per_sec {
            return false;
        }
        self.entries.push_back((now_ms, bytes));
        self.window_bytes += bytes;
        true
    }
}

/// Encodes ONLY a padded face crop (never a raw camera frame), scaled down to <= 360px longest side.
pub fn encode_face_crop_jpeg(
    rgb: &[u8],
    width: u32,
    height: u32,
    quality: u8,
) -> Result<Vec<u8>, String> {
    if width == 0 || height == 0 || rgb.len() != (width as usize) * (height as usize) * 3 {
        return Err("invalid RGB crop buffer for JPEG encoding".to_string());
    }
    let img = RgbImage::from_raw(width, height, rgb.to_vec())
        .ok_or_else(|| "failed creating RgbImage from crop bytes".to_string())?;

    let longest = width.max(height);
    let final_img = if longest > 360 {
        let scale = 360.0f64 / (longest as f64);
        let nw = ((width as f64 * scale).round() as u32).max(2);
        let nh = ((height as f64 * scale).round() as u32).max(2);
        image::imageops::resize(&img, nw, nh, FilterType::Triangle)
    } else {
        img
    };

    let q = quality.clamp(50, 82);
    let mut out = Vec::with_capacity(24 * 1024);
    let encoder = JpegEncoder::new_with_quality(&mut out, q);
    final_img
        .write_with_encoder(encoder)
        .map_err(|e| format!("JPEG encode failed: {e}"))?;
    Ok(out)
}

pub struct SnapshotWriterHandle {
    tx: mpsc::Sender<SnapshotWriteJob>,
}

impl SnapshotWriterHandle {
    pub fn spawn(snapshots_dir: PathBuf, max_bytes_per_sec: usize) -> Self {
        let (tx, mut rx) = mpsc::channel::<SnapshotWriteJob>(64);
        tokio::spawn(async move {
            let dir_init = snapshots_dir.clone();
            let _ = tokio::task::spawn_blocking(move || std::fs::create_dir_all(&dir_init)).await;
            let mut budget = SnapshotByteBudget::new(max_bytes_per_sec);
            while let Some(job) = rx.recv().await {
                let now_ms = crate::rtsp::unix_now_ms();
                if !budget.try_consume(job.jpeg_bytes.len(), now_ms) {
                    continue;
                }
                let safe_name = sanitize_file_name(&job.file_name);
                let target = snapshots_dir.join(safe_name);
                let bytes = job.jpeg_bytes;
                let _ = tokio::task::spawn_blocking(move || write_bytes_atomic(&target, &bytes)).await;
            }
        });
        Self { tx }
    }

    pub fn try_enqueue(&self, job: SnapshotWriteJob) -> bool {
        self.tx.try_send(job).is_ok()
    }
}

fn sanitize_file_name(raw: &str) -> String {
    let base = Path::new(raw)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("snap.jpg");
    base.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

fn write_bytes_atomic(target: &Path, bytes: &[u8]) -> Result<(), std::io::Error> {
    let tmp = target.with_extension("tmp");
    std::fs::write(&tmp, bytes)?;
    std::fs::rename(&tmp, target)?;
    Ok(())
}
