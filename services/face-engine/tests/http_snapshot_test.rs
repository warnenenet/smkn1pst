use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use face_engine::debug_png::DebugPngWriter;
use face_engine::http_api::decode_image_data_url;
use face_engine::pipeline::DebugAnnotation;
use face_engine::snapshot::{encode_face_crop_jpeg, SnapshotByteBudget};
use face_engine::telemetry::LatencyTracker;
use image::{ImageFormat, RgbImage};
use std::io::Cursor;
use tempfile::tempdir;

#[test]
fn snapshot_byte_budget_enforces_below_1mb_per_sec_and_resizes_crop() {
    let mut budget = SnapshotByteBudget::new(700 * 1024);
    assert!(budget.try_consume(400_000, 1_000));
    assert!(budget.try_consume(250_000, 1_500));
    // Next write pushes window over 700 KB/s -> dropped cleanly
    assert!(!budget.try_consume(100_000, 1_800));
    // After 1000ms window slides -> allowed again
    assert!(budget.try_consume(100_000, 2_100));

    let large_crop = vec![140u8; 720 * 720 * 3];
    let jpg = encode_face_crop_jpeg(&large_crop, 720, 720, 80).expect("encode crop jpeg");
    assert!(!jpg.is_empty());
    // Decoded crop should be <= 360px longest side
    let decoded = image::load_from_memory(&jpg).expect("decode crop jpeg");
    assert!(decoded.width() <= 360 && decoded.height() <= 360);
}

#[test]
fn debug_png_writer_throttles_30s_and_caps_tmpfs_files() {
    let dir = tempdir().expect("tempdir");
    let mut writer = DebugPngWriter::new(dir.path().to_path_buf(), 30, 3);
    let rgb = vec![90u8; 160 * 120 * 3];
    let annots = vec![DebugAnnotation {
        bbox: [20.0, 20.0, 100.0, 100.0],
        kps: [
            [42.0, 48.0],
            [78.0, 48.0],
            [60.0, 64.0],
            [45.0, 82.0],
            [75.0, 82.0],
        ],
        passed: true,
        label: "PASS:0.95".to_string(),
    }];

    // t=1000ms -> writes cam1
    assert!(writer.maybe_write_sync(1, &rgb, 160, 120, &annots, 1_000).is_some());
    // t=5000ms -> throttled (< 30s)
    assert!(writer.maybe_write_sync(1, &rgb, 160, 120, &annots, 5_000).is_none());
    // t=32_000ms -> writes cam1 again
    assert!(writer.maybe_write_sync(1, &rgb, 160, 120, &annots, 32_000).is_some());
    // Write on cam2 & cam3 -> cap=3 prunes oldest so total PNG files <= 3
    assert!(writer.maybe_write_sync(2, &rgb, 160, 120, &annots, 32_100).is_some());
    assert!(writer.maybe_write_sync(3, &rgb, 160, 120, &annots, 32_200).is_some());

    let png_count = std::fs::read_dir(dir.path())
        .expect("read dir")
        .filter_map(Result::ok)
        .filter(|e| e.path().extension().and_then(|s| s.to_str()) == Some("png"))
        .count();
    assert!(png_count <= 3, "expected <= 3 capped debug PNGs, got {png_count}");
}

#[test]
fn telemetry_percentiles_and_data_url_image_decoding_work_accurately() {
    let mut tracker = LatencyTracker::new(100);
    for ms in [1.0, 2.0, 3.0, 4.0, 5.0, 10.0, 20.0] {
        tracker.record(ms);
    }
    let stats = tracker.snapshot();
    assert_eq!(stats.count, 7);
    assert!((stats.p50_ms - 4.0).abs() < 1e-6);
    assert!(stats.p95_ms >= 10.0);

    let img = RgbImage::from_pixel(32, 24, image::Rgb([10, 200, 30]));
    let mut png_bytes = Vec::new();
    img.write_to(&mut Cursor::new(&mut png_bytes), ImageFormat::Png)
        .expect("encode png");
    let data_url = format!("data:image/png;base64,{}", B64.encode(&png_bytes));

    let (rgb, w, h) = decode_image_data_url(&data_url).expect("decode image data url");
    assert_eq!((w, h), (32, 24));
    assert_eq!(rgb.len(), 32 * 24 * 3);
    assert!(decode_image_data_url("data:image/png;base64,!!!invalid!!!").is_err());
}
