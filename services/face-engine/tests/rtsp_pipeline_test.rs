use face_engine::config::ThresholdsConfig;
use face_engine::det_scrfd::DetectedFace;
use face_engine::embedder::l2_normalize;
use face_engine::gallery::{GalleryEntry, GalleryIndex};
use face_engine::matching::TrackVoteBuffer;
use face_engine::pipeline::{
    process_detected_faces_frame, CameraRuntimeState, FrameStepDisposition,
};
use face_engine::rtsp::{
    compute_reconnect_backoff_ms, plan_camera_reconcile, validate_loopback_backend_url,
    CameraDescriptor,
};
use face_engine::tracker::{DedupCooldownMap, IoUTracker};
use std::collections::HashMap;

fn make_synthetic_frame_with_textured_face(w: u32, h: u32) -> Vec<u8> {
    let mut rgb = vec![120u8; (w as usize) * (h as usize) * 3];
    for y in 0..h as usize {
        for x in 0..w as usize {
            let idx = (y * w as usize + x) * 3;
            // High-frequency texture around center face region so Laplacian variance passes > 100
            let checker = ((x / 3 + y / 3) % 2) as u8 * 180;
            rgb[idx] = checker.saturating_add((x % 50) as u8);
            rgb[idx + 1] = checker.saturating_add((y % 50) as u8);
            rgb[idx + 2] = 200u8.saturating_sub(checker);
        }
    }
    rgb
}

fn clean_frontal_face() -> DetectedFace {
    DetectedFace {
        bbox: [200.0, 100.0, 320.0, 220.0], // 120x120 >= 80px embed tier
        score: 0.94,
        kps: [
            [236.0, 146.0],
            [284.0, 146.0],
            [260.0, 170.0],
            [240.0, 194.0],
            [280.0, 194.0],
        ],
    }
}

#[test]
fn rtsp_reconcile_enforces_hard_cap_8_and_preserves_unchanged_streams() {
    let cams: Vec<CameraDescriptor> = (1..=12i64)
        .map(|id| CameraDescriptor {
            id,
            rtsp_url: format!("rtsp://127.0.0.1:8554/cam{id}"),
            fps: 10,
            aktif: true,
            capture_max_width: Some(1280),
            min_face_size: Some(80),
            max_face_size: None,
        })
        .collect();

    let mut running = HashMap::new();
    running.insert(
        1,
        CameraRuntimeState {
            signature: cams[0].signature(),
        },
    );
    running.insert(
        99,
        CameraRuntimeState {
            signature: "old-removed".to_string(),
        },
    );

    let plan = plan_camera_reconcile(&cams, &running, 8);
    assert_eq!(plan.kept_ids, vec![1]);
    assert_eq!(plan.to_stop, vec![99]);
    // Max 8 active: 1 kept + 7 started = 8 total
    assert_eq!(plan.to_start.len(), 7);
    assert_eq!(plan.capped_dropped_ids, vec![9, 10, 11, 12]);
}

#[test]
fn reconnect_backoff_grows_exponentially_up_to_30s_and_loopback_url_is_validated() {
    assert_eq!(compute_reconnect_backoff_ms(0), 1_000);
    assert_eq!(compute_reconnect_backoff_ms(1), 2_000);
    assert_eq!(compute_reconnect_backoff_ms(2), 4_000);
    assert_eq!(compute_reconnect_backoff_ms(4), 16_000);
    assert_eq!(compute_reconnect_backoff_ms(8), 30_000);

    assert!(validate_loopback_backend_url("http://127.0.0.1:3001/").is_some());
    assert!(validate_loopback_backend_url("http://localhost:3000").is_some());
    assert!(validate_loopback_backend_url("https://evil.example.com").is_none());
}

#[test]
fn pure_pipeline_step_enforces_2_frame_vote_and_6s_dedup() {
    let mut cfg = ThresholdsConfig::conservative_defaults();
    cfg.adaptive_threshold_enabled = false;
    cfg.threshold_recognition = 0.70;
    cfg.dedup_cooldown_sec = 6;
    cfg.vote_min_count = 2;

    let student_vec = l2_normalize(&{
        let mut v = vec![0.0f32; 512];
        v[0] = 0.95;
        v[1] = 0.312;
        v
    });
    let mut rival = vec![0.0f32; 512];
    rival[200] = 1.0;

    let gallery = GalleryIndex::from_entries(vec![
        GalleryEntry {
            student_id: 7,
            embedding: student_vec.clone(),
            is_legacy: false,
        },
        GalleryEntry {
            student_id: 8,
            embedding: rival,
            is_legacy: false,
        },
    ]);

    let rgb = make_synthetic_frame_with_textured_face(640, 360);
    let faces = vec![clean_frontal_face()];

    let mut tracker = IoUTracker::default();
    let mut votes = TrackVoteBuffer::default();
    let mut dedup = DedupCooldownMap::new(6);

    // Frame 1 at t=1000ms -> passes quality gate, matches student 7, awaits 2nd vote
    let out1 = process_detected_faces_frame(
        1,
        &rgb,
        640,
        360,
        &faces,
        1_000,
        &cfg,
        &gallery,
        &mut tracker,
        &mut votes,
        &mut dedup,
        |_aligned_112| Ok(student_vec.clone()),
    );
    assert_eq!(out1.dispatches.len(), 0);
    assert_eq!(out1.dispositions, vec![FrameStepDisposition::AwaitingSecondVote]);

    // Frame 2 at t=1400ms -> 2nd consistent vote -> Confirmed & dispatched!
    let out2 = process_detected_faces_frame(
        1,
        &rgb,
        640,
        360,
        &faces,
        1_400,
        &cfg,
        &gallery,
        &mut tracker,
        &mut votes,
        &mut dedup,
        |_aligned_112| Ok(student_vec.clone()),
    );
    assert_eq!(out2.dispatches.len(), 1);
    assert_eq!(out2.dispatches[0].student_id, Some(7));

    // Frame 3 & 4 at t=3000ms & 3400ms (< 6s dedup) -> suppressed by 6s dedup!
    let _ = process_detected_faces_frame(
        1,
        &rgb,
        640,
        360,
        &faces,
        3_000,
        &cfg,
        &gallery,
        &mut tracker,
        &mut votes,
        &mut dedup,
        |_aligned_112| Ok(student_vec.clone()),
    );
    let out4 = process_detected_faces_frame(
        1,
        &rgb,
        640,
        360,
        &faces,
        3_400,
        &cfg,
        &gallery,
        &mut tracker,
        &mut votes,
        &mut dedup,
        |_aligned_112| Ok(student_vec.clone()),
    );
    assert_eq!(out4.dispatches.len(), 0);
    assert!(out4.dispositions.contains(&FrameStepDisposition::SuppressedByDedup));
}
