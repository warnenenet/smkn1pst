use crate::config::ThresholdsConfig;
use crate::db::DbStore;
use crate::gallery::{GalleryEntry, GalleryIndex};
use crate::http_api::AppSharedState;
use crate::matching::TrackVoteBuffer;
use crate::pipeline::{
    process_detected_faces_frame, CameraRuntimeState, FrameStepDisposition,
};
use crate::rtsp::{
    plan_camera_reconcile, run_rtsp_decoder_loop, unix_now_ms, CameraDescriptor,
    StreamStatusEvent,
};
use crate::snapshot::{encode_face_crop_jpeg, SnapshotWriteJob, SnapshotWriterHandle};
use crate::tracker::{DedupCooldownMap, IoUTracker, LatestFrameSlot};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

struct RunningCameraWorker {
    state: CameraRuntimeState,
    stop_flag: Arc<AtomicBool>,
    slot: Arc<LatestFrameSlot>,
}

pub fn load_internal_token(token_file: &Path) -> String {
    if let Ok(text) = std::fs::read_to_string(token_file) {
        let trimmed = text.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }
    std::env::var("INTERNAL_TOKEN").unwrap_or_default().trim().to_string()
}

pub fn run_supervisor_loop(
    shared: Arc<AppSharedState>,
    snapshots: SnapshotWriterHandle,
    global_stop: Arc<AtomicBool>,
) {
    let rt = tokio::runtime::Handle::current();
    rt.spawn(async move {
        // Seed gallery & thresholds directly from SQLite if present while Node boots
        if shared.config.sqlite_path.is_file() {
            let db_path = shared.config.sqlite_path.clone();
            if let Ok(Ok((idx, cfg))) = tokio::task::spawn_blocking(move || {
                let store = DbStore::open(&db_path)?;
                let g = store.load_gallery()?;
                let t = store.load_thresholds()?;
                Ok::<_, String>((g, t))
            })
            .await
            {
                shared
                    .telemetry
                    .gallery_size
                    .store(idx.len(), Ordering::Relaxed);
                shared
                    .telemetry
                    .gallery_non_unit_count
                    .store(idx.non_unit_count(), Ordering::Relaxed);
                shared
                    .telemetry
                    .gallery_legacy_count
                    .store(idx.legacy_count(), Ordering::Relaxed);
                *shared.gallery.write().expect("gallery rwlock") = idx;
                *shared.thresholds.write().expect("thresholds rwlock") = cfg;
            }
        }

        let debug_writer = Arc::new(Mutex::new(crate::debug_png::DebugPngWriter::new(
            shared.config.debug_tmp_dir.clone(),
            shared.config.debug_png_interval_sec,
            40,
        )));
        let mut running: HashMap<i64, RunningCameraWorker> = HashMap::new();

        // Give Node a tiny window on cold boot before first HTTP sync
        tokio::time::sleep(Duration::from_millis(1200)).await;

        while !global_stop.load(Ordering::Relaxed) {
            let shared_sync = Arc::clone(&shared);
            let sync_res = tokio::task::spawn_blocking(move || sync_from_backend(&shared_sync)).await;
            if let Ok(Ok(cams)) = sync_res {
                let running_sigs: HashMap<i64, CameraRuntimeState> = running
                    .iter()
                    .map(|(&id, w)| (id, w.state.clone()))
                    .collect();

                let plan =
                    plan_camera_reconcile(&cams, &running_sigs, shared.config.max_camera_workers);

                if !plan.capped_dropped_ids.is_empty() {
                    eprintln!(
                        "[RTSP] Hard cap {} streams active; ignored excess camera IDs {:?}",
                        shared.config.max_camera_workers, plan.capped_dropped_ids
                    );
                }

                for stop_id in plan.to_stop {
                    if let Some(worker) = running.remove(&stop_id) {
                        worker.stop_flag.store(true, Ordering::Relaxed);
                        worker.slot.wake();
                    }
                }

                for cam in plan.to_start {
                    let cam_id = cam.id;
                    let sig = cam.signature();
                    let stop_flag = Arc::new(AtomicBool::new(false));
                    let slot = Arc::new(LatestFrameSlot::new());

                    let rtsp_cam = cam.clone();
                    let rtsp_slot = Arc::clone(&slot);
                    let rtsp_stop = Arc::clone(&stop_flag);
                    let rtsp_shared = Arc::clone(&shared);
                    let global_cfg_max_w = shared
                        .thresholds
                        .read()
                        .expect("thresholds rwlock")
                        .capture_max_width;
                    let cam_max_w = cam.capture_max_width.unwrap_or(global_cfg_max_w);
                    let every_n = shared.config.process_every_n_frames;

                    tokio::task::spawn_blocking(move || {
                        run_rtsp_decoder_loop(
                            rtsp_cam,
                            cam_max_w,
                            every_n,
                            rtsp_slot,
                            rtsp_stop,
                            move |ev| match ev {
                                StreamStatusEvent::Online { camera_id } => {
                                    post_heartbeat(&rtsp_shared, camera_id, true, None, &json!({}));
                                }
                                StreamStatusEvent::Offline { camera_id, error } => {
                                    post_heartbeat(
                                        &rtsp_shared,
                                        camera_id,
                                        false,
                                        Some(&error),
                                        &json!({}),
                                    );
                                }
                            },
                        );
                    });

                    let inf_shared = Arc::clone(&shared);
                    let inf_slot = Arc::clone(&slot);
                    let inf_stop = Arc::clone(&stop_flag);
                    let inf_snaps = SnapshotWriterHandle::spawn(
                        shared.config.snapshots_dir.clone(),
                        shared.config.snapshot_max_bytes_per_sec,
                    );
                    let inf_debug = Arc::clone(&debug_writer);
                    let _ = &snapshots;
                    tokio::spawn(run_camera_inference_loop(
                        cam,
                        inf_shared,
                        inf_slot,
                        inf_stop,
                        inf_snaps,
                        inf_debug,
                    ));

                    running.insert(
                        cam_id,
                        RunningCameraWorker {
                            state: CameraRuntimeState { signature: sig },
                            stop_flag,
                            slot,
                        },
                    );
                }

                shared
                    .telemetry
                    .active_camera_workers
                    .store(running.len(), Ordering::Relaxed);
            }

            tokio::select! {
                _ = tokio::time::sleep(Duration::from_secs(20)) => {}
                _ = shared.reload_notify.notified() => {}
            }
        }

        for (_, worker) in running {
            worker.stop_flag.store(true, Ordering::Relaxed);
            worker.slot.wake();
        }
    });
}

async fn run_camera_inference_loop(
    cam: CameraDescriptor,
    shared: Arc<AppSharedState>,
    slot: Arc<LatestFrameSlot>,
    stop_flag: Arc<AtomicBool>,
    snapshots: SnapshotWriterHandle,
    debug_writer: Arc<Mutex<crate::debug_png::DebugPngWriter>>,
) {
    let mut tracker = IoUTracker::default();
    let mut votes = TrackVoteBuffer::default();
    let initial_dedup = shared
        .thresholds
        .read()
        .expect("thresholds rwlock")
        .dedup_cooldown_sec;
    let mut dedup = DedupCooldownMap::new(initial_dedup);

    let mut stats_window_start_ms = unix_now_ms();
    let mut last_heartbeat_ms = unix_now_ms();
    let mut bucket = StatsBucket::default();
    let mut last_seen_dropped = 0u64;

    while !stop_flag.load(Ordering::Relaxed) {
        if let Some(frame) = slot.take_latest() {
            let now_dropped = slot.frames_dropped();
            if now_dropped > last_seen_dropped {
                shared
                    .telemetry
                    .frames_dropped
                    .fetch_add(now_dropped - last_seen_dropped, Ordering::Relaxed);
                last_seen_dropped = now_dropped;
            }

            let mut cfg = shared.thresholds.read().expect("thresholds rwlock").clone();
            if let Some(cam_min) = cam.min_face_size {
                if cam_min >= 60 {
                    cfg.embed_min_face_px = cam_min;
                }
            }
            if let Some(cam_max) = cam.max_face_size {
                cfg.max_face_size_px = cam_max;
            }
            dedup.set_cooldown_sec(cfg.dedup_cooldown_sec);

            let gallery_snapshot = shared.gallery.read().expect("gallery rwlock").clone();
            let inf_arc = Arc::clone(&shared.inference);
            let telemetry = Arc::clone(&shared.telemetry);
            let dbg_arc = Arc::clone(&debug_writer);
            let cam_id = cam.id;

            let step_res = tokio::task::spawn_blocking(move || {
                let t_total = Instant::now();
                let mut inf = inf_arc.lock().expect("inference mutex");
                inf.detector.set_det_thresh(cfg.threshold_confidence.min(0.35));

                let t_det = Instant::now();
                let faces = inf
                    .detector
                    .detect_rgb(&frame.rgb, frame.width, frame.height)
                    .unwrap_or_default();
                let det_ms = t_det.elapsed().as_secs_f64() * 1000.0;
                telemetry.detect.lock().expect("lock").record(det_ms);

                let now_ms = unix_now_ms();
                let step = process_detected_faces_frame(
                    cam_id,
                    &frame.rgb,
                    frame.width,
                    frame.height,
                    &faces,
                    now_ms,
                    &cfg,
                    &gallery_snapshot,
                    &mut tracker,
                    &mut votes,
                    &mut dedup,
                    |aligned| {
                        let t_emb = Instant::now();
                        let res = inf.embedder.embed_aligned_rgb112(aligned);
                        let emb_ms = t_emb.elapsed().as_secs_f64() * 1000.0;
                        telemetry.embed.lock().expect("lock").record(emb_ms);
                        res
                    },
                );

                if cfg.debug_detection && !step.debug_annotations.is_empty() {
                    if let Ok(mut dw) = dbg_arc.lock() {
                        dw.maybe_write_sync(
                            cam_id,
                            &frame.rgb,
                            frame.width,
                            frame.height,
                            &step.debug_annotations,
                            now_ms,
                        );
                    }
                }

                let pipe_ms = t_total.elapsed().as_secs_f64() * 1000.0;
                telemetry.pipeline.lock().expect("lock").record(pipe_ms);
                telemetry.frames_processed.fetch_add(1, Ordering::Relaxed);

                (step, tracker, votes, dedup, cfg.capture_jpeg_quality)
            })
            .await;

            let Ok((step, next_tracker, next_votes, next_dedup, jpeg_q)) = step_res else {
                continue;
            };
            tracker = next_tracker;
            votes = next_votes;
            dedup = next_dedup;

            bucket.total_raw += step.raw_faces as u64;
            bucket.dropped_confidence += step.dropped_confidence as u64;
            bucket.dropped_landmark += step.dropped_landmark as u64;
            bucket.dropped_size += step.dropped_size as u64;
            bucket.dropped_blur += step.dropped_blur as u64;
            bucket.dropped_pose += step.dropped_pose as u64;
            bucket.passed_embedding += step.passed_embedding as u64;
            bucket.frames_decoded += 1;
            for d in &step.dispositions {
                match d {
                    FrameStepDisposition::DispatchedMatched => bucket.matched_dispatched += 1,
                    FrameStepDisposition::DispatchedAnonymous => bucket.anonymous_dispatched += 1,
                    _ => {}
                }
            }

            for ev in step.dispatches {
                let snap_name = format!(
                    "cam{}_t{}_{}.jpg",
                    ev.camera_id,
                    ev.track_id,
                    unix_now_ms() / 1000
                );
                if let Ok(jpg) =
                    encode_face_crop_jpeg(&ev.crop_rgb, ev.crop_w, ev.crop_h, jpeg_q)
                {
                    if snapshots.try_enqueue(SnapshotWriteJob {
                        file_name: snap_name.clone(),
                        jpeg_bytes: jpg,
                    }) {
                        shared
                            .telemetry
                            .snapshots_enqueued
                            .fetch_add(1, Ordering::Relaxed);
                    } else {
                        shared
                            .telemetry
                            .snapshots_dropped
                            .fetch_add(1, Ordering::Relaxed);
                    }
                }
                let shared_ev = Arc::clone(&shared);
                tokio::task::spawn_blocking(move || {
                    post_face_event(&shared_ev, &ev, &snap_name);
                });
            }

            let now_ms = unix_now_ms();
            if now_ms.saturating_sub(last_heartbeat_ms) >= 15_000 {
                last_heartbeat_ms = now_ms;
                let hb_shared = Arc::clone(&shared);
                let tel_json = json!({
                    "frames_decoded": bucket.frames_decoded,
                    "raw_faces_seen": bucket.total_raw,
                    "faces_detected_total": bucket.passed_embedding,
                    "matched_dispatched": bucket.matched_dispatched,
                    "anonymous_dispatched": bucket.anonymous_dispatched,
                });
                tokio::task::spawn_blocking(move || {
                    post_heartbeat(&hb_shared, cam.id, true, None, &tel_json);
                });
            }
            if now_ms.saturating_sub(stats_window_start_ms) >= 300_000 {
                let snapshot_bucket = std::mem::take(&mut bucket);
                stats_window_start_ms = now_ms;
                if snapshot_bucket.total_raw > 0 {
                    let st_shared = Arc::clone(&shared);
                    tokio::task::spawn_blocking(move || {
                        post_detection_stats(&st_shared, cam.id, &snapshot_bucket);
                    });
                }
            }
        } else {
            tokio::select! {
                _ = slot.notified() => {}
                _ = tokio::time::sleep(Duration::from_millis(500)) => {}
            }
        }
    }
}

#[derive(Default)]
struct StatsBucket {
    total_raw: u64,
    dropped_confidence: u64,
    dropped_landmark: u64,
    dropped_size: u64,
    dropped_blur: u64,
    dropped_pose: u64,
    passed_embedding: u64,
    frames_decoded: u64,
    matched_dispatched: u64,
    anonymous_dispatched: u64,
}

fn sync_from_backend(shared: &AppSharedState) -> Result<Vec<CameraDescriptor>, String> {
    let base_url = shared.telemetry.web_backend_url.lock().expect("lock").clone();
    let token = load_internal_token(&shared.config.internal_token_file);
    let agent = ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(6))
        .build();

    let mut gal_req = agent.get(&format!("{base_url}/api/internal/gallery"));
    if !token.is_empty() {
        gal_req = gal_req.set("X-Internal-Token", &token);
    }
    let gal_resp = match gal_req.call() {
        Ok(r) => r,
        Err(e) => {
            shared
                .telemetry
                .backend_reachable
                .store(false, Ordering::Relaxed);
            *shared.telemetry.backend_error.lock().expect("lock") = Some(e.to_string());
            return Err(e.to_string());
        }
    };
    let gal_body = gal_resp.into_string().map_err(|e| e.to_string())?;
    let gal_json: Value = serde_json::from_str(&gal_body).map_err(|e| e.to_string())?;

    if let Some(settings_val) = gal_json.get("settings") {
        let cfg = ThresholdsConfig::from_settings_json(settings_val);
        *shared.thresholds.write().expect("thresholds rwlock") = cfg;
    }

    if let Some(arr) = gal_json.get("students").and_then(|v| v.as_array()) {
        let mut entries = Vec::with_capacity(arr.len());
        for item in arr {
            let Some(id) = item.get("id").and_then(|v| v.as_i64()) else {
                continue;
            };
            let Some(emb_arr) = item.get("embedding").and_then(|v| v.as_array()) else {
                continue;
            };
            let emb: Vec<f32> = emb_arr
                .iter()
                .filter_map(|x| x.as_f64().map(|f| f as f32))
                .collect();
            let is_legacy = item
                .get("pipeline_version")
                .map(|v| v.is_null())
                .unwrap_or(true);
            entries.push(GalleryEntry {
                student_id: id,
                embedding: emb,
                is_legacy,
            });
        }
        let idx = GalleryIndex::from_entries(entries);
        shared
            .telemetry
            .gallery_size
            .store(idx.len(), Ordering::Relaxed);
        shared
            .telemetry
            .gallery_non_unit_count
            .store(idx.non_unit_count(), Ordering::Relaxed);
        shared
            .telemetry
            .gallery_legacy_count
            .store(idx.legacy_count(), Ordering::Relaxed);
        *shared.gallery.write().expect("gallery rwlock") = idx;
    }

    let mut cam_req = agent.get(&format!("{base_url}/api/internal/cameras"));
    if !token.is_empty() {
        cam_req = cam_req.set("X-Internal-Token", &token);
    }
    let cam_body = cam_req
        .call()
        .map_err(|e| e.to_string())?
        .into_string()
        .map_err(|e| e.to_string())?;
    let cam_json: Value = serde_json::from_str(&cam_body).map_err(|e| e.to_string())?;

    let mut cams = Vec::new();
    if let Some(arr) = cam_json.get("cameras").and_then(|v| v.as_array()) {
        for item in arr {
            let Some(id) = item.get("id").and_then(|v| v.as_i64()) else {
                continue;
            };
            let rtsp_url = item
                .get("rtsp_url")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let fps = item.get("fps").and_then(|v| v.as_u64()).unwrap_or(10) as u32;
            let aktif = item
                .get("aktif")
                .and_then(|v| v.as_bool().or_else(|| v.as_i64().map(|n| n != 0)))
                .unwrap_or(false);
            let capture_max_width = item
                .get("capture_max_width")
                .and_then(|v| v.as_u64())
                .map(|v| v as u32);
            let min_face_size = item
                .get("min_face_size")
                .and_then(|v| v.as_u64())
                .map(|v| v as u32);
            let max_face_size = item
                .get("max_face_size")
                .and_then(|v| v.as_u64())
                .map(|v| v as u32);
            cams.push(CameraDescriptor {
                id,
                rtsp_url,
                fps,
                aktif,
                capture_max_width,
                min_face_size,
                max_face_size,
            });
        }
    }

    shared
        .telemetry
        .backend_reachable
        .store(true, Ordering::Relaxed);
    *shared.telemetry.backend_error.lock().expect("lock") = None;
    Ok(cams)
}

fn post_heartbeat(
    shared: &AppSharedState,
    camera_id: i64,
    online: bool,
    error: Option<&str>,
    extra: &Value,
) {
    let base_url = shared.telemetry.web_backend_url.lock().expect("lock").clone();
    let token = load_internal_token(&shared.config.internal_token_file);
    let mut body = json!({ "online": online, "error": error });
    if let (Some(map), Some(ext_map)) = (body.as_object_mut(), extra.as_object()) {
        for (k, v) in ext_map {
            map.insert(k.clone(), v.clone());
        }
    }
    let agent = ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(3))
        .build();
    let mut req = agent
        .post(&format!("{base_url}/api/internal/cameras/{camera_id}/heartbeat"))
        .set("Content-Type", "application/json");
    if !token.is_empty() {
        req = req.set("X-Internal-Token", &token);
    }
    let _ = req.send_string(&body.to_string());
}

fn post_detection_stats(shared: &AppSharedState, camera_id: i64, bucket: &StatsBucket) {
    let base_url = shared.telemetry.web_backend_url.lock().expect("lock").clone();
    let token = load_internal_token(&shared.config.internal_token_file);
    let body = json!({
        "camera_id": camera_id,
        "total_raw": bucket.total_raw,
        "dropped_confidence": bucket.dropped_confidence,
        "dropped_landmark": bucket.dropped_landmark,
        "dropped_size": bucket.dropped_size,
        "dropped_blur": bucket.dropped_blur,
        "dropped_pose": bucket.dropped_pose,
        "passed_embedding": bucket.passed_embedding,
    });
    let agent = ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(4))
        .build();
    let mut req = agent
        .post(&format!("{base_url}/api/internal/detection-stats"))
        .set("Content-Type", "application/json");
    if !token.is_empty() {
        req = req.set("X-Internal-Token", &token);
    }
    let _ = req.send_string(&body.to_string());
}

fn post_face_event(
    shared: &AppSharedState,
    ev: &crate::pipeline::DispatchEvent,
    snap_name: &str,
) {
    let base_url = shared.telemetry.web_backend_url.lock().expect("lock").clone();
    let token = load_internal_token(&shared.config.internal_token_file);
    let body = json!({
        "camera_id": ev.camera_id,
        "student_id": ev.student_id,
        "similarity": (ev.similarity * 10_000.0).round() / 10_000.0,
        "confidence": (ev.confidence * 10_000.0).round() / 10_000.0,
        "quality_score": ev.quality_score,
        "embedding": ev.embedding,
        "snapshot_rel_path": format!("/data/snapshots/{snap_name}"),
    });
    let agent = ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(4))
        .build();
    let mut req = agent
        .post(&format!("{base_url}/api/internal/face-event"))
        .set("Content-Type", "application/json");
    if !token.is_empty() {
        req = req.set("X-Internal-Token", &token);
    }
    let _ = req.send_string(&body.to_string());
}
