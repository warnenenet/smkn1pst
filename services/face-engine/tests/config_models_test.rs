use face_engine::config::{EngineConfig, ThresholdsConfig};
use face_engine::models::{compute_file_sha256_hex, verify_startup_assets, StartupAssetError};
use std::fs;
use tempfile::tempdir;

#[test]
fn startup_fails_fast_when_model_missing() {
    let dir = tempdir().unwrap();
    let mut cfg = EngineConfig::conservative_defaults(dir.path().to_path_buf());
    cfg.det_model_path = dir.path().join("missing_det_10g.onnx");
    cfg.rec_model_path = dir.path().join("missing_w600k_r50.onnx");
    cfg.ort_dylib_path = dir.path().join("libonnxruntime.so");

    let err = verify_startup_assets(&cfg).expect_err("missing model must fail startup");
    assert!(matches!(err, StartupAssetError::MissingFile(_)));
}

#[test]
fn startup_fails_fast_on_sha256_mismatch() {
    let dir = tempdir().unwrap();
    let det = dir.path().join("det_10g.onnx");
    let rec = dir.path().join("w600k_r50.onnx");
    let ort_so = dir.path().join("libonnxruntime.so");
    fs::write(&det, b"dummy det bytes").unwrap();
    fs::write(&rec, b"dummy rec bytes").unwrap();
    fs::write(&ort_so, b"dummy ort bytes").unwrap();

    let det_sha = compute_file_sha256_hex(&det).unwrap();
    let ort_sha = compute_file_sha256_hex(&ort_so).unwrap();

    let mut cfg = EngineConfig::conservative_defaults(dir.path().to_path_buf());
    cfg.det_model_path = det;
    cfg.rec_model_path = rec;
    cfg.ort_dylib_path = ort_so;
    cfg.expected_det_sha256 = Some(det_sha);
    cfg.expected_rec_sha256 = Some("0".repeat(64));
    cfg.expected_ort_sha256 = Some(ort_sha);

    let err = verify_startup_assets(&cfg).expect_err("corrupt model sha256 must fail startup");
    assert!(matches!(err, StartupAssetError::Sha256Mismatch { .. }));
}

#[test]
fn startup_succeeds_with_matching_sha256_and_loads_conservative_thresholds() {
    let dir = tempdir().unwrap();
    let det = dir.path().join("det_10g.onnx");
    let rec = dir.path().join("w600k_r50.onnx");
    let ort_so = dir.path().join("libonnxruntime.so");
    fs::write(&det, b"det payload").unwrap();
    fs::write(&rec, b"rec payload").unwrap();
    fs::write(&ort_so, b"ort payload").unwrap();

    let mut cfg = EngineConfig::conservative_defaults(dir.path().to_path_buf());
    cfg.det_model_path = det.clone();
    cfg.rec_model_path = rec.clone();
    cfg.ort_dylib_path = ort_so.clone();
    cfg.expected_det_sha256 = Some(compute_file_sha256_hex(&det).unwrap());
    cfg.expected_rec_sha256 = Some(compute_file_sha256_hex(&rec).unwrap());
    cfg.expected_ort_sha256 = Some(compute_file_sha256_hex(&ort_so).unwrap());

    let verified = verify_startup_assets(&cfg).expect("valid assets must pass");
    assert_eq!(verified.det_sha256.len(), 64);
    assert_eq!(verified.rec_sha256.len(), 64);
    assert_eq!(verified.combined_model_sha256.len(), 64);

    let t = ThresholdsConfig::conservative_defaults();
    assert_eq!(t.embed_min_face_px, 80);
    assert!((t.threshold_recognition - 0.70).abs() < 1e-6);
    assert!((t.match_margin_min - 0.08).abs() < 1e-6);
    assert!((t.max_pitch_deg - 30.0).abs() < 1e-6);
    assert_eq!(t.dedup_cooldown_sec, 6);
}

#[test]
fn thresholds_hydrate_from_settings_json_without_hardcode_lock() {
    let json = serde_json::json!({
        "threshold_confidence": 0.65,
        "threshold_recognition": 0.74,
        "match_margin_min": 0.11,
        "embed_min_face_px": 92,
        "max_pitch_deg": 22,
        "blur_threshold": 135,
        "dedup_cooldown_sec": 8,
        "debug_detection": true
    });
    let t = ThresholdsConfig::from_settings_json(&json);
    assert!((t.threshold_confidence - 0.65).abs() < 1e-6);
    assert!((t.threshold_recognition - 0.74).abs() < 1e-6);
    assert!((t.match_margin_min - 0.11).abs() < 1e-6);
    assert_eq!(t.embed_min_face_px, 92);
    assert!((t.max_pitch_deg - 22.0).abs() < 1e-6);
    assert!((t.blur_threshold - 135.0).abs() < 1e-6);
    assert_eq!(t.dedup_cooldown_sec, 8);
    assert!(t.debug_detection);
}

#[test]
fn engine_rejects_excessive_camera_worker_limit() {
    let dir = tempdir().unwrap();
    let mut cfg = EngineConfig::conservative_defaults(dir.path().to_path_buf());
    cfg.max_camera_workers = 9;
    assert!(cfg.validate().is_err());
}
