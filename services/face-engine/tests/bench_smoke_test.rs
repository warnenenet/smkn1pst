use face_engine::bench::compare_embeddings_cos;
use face_engine::config::EngineConfig;
use face_engine::embedder::l2_normalize;

#[test]
fn bench_helpers_and_default_config_are_consistent() {
    let a = l2_normalize(&vec![1.0f32; 512]);
    let b = l2_normalize(&vec![1.0f32; 512]);
    assert!((compare_embeddings_cos(&a, &b) - 1.0).abs() < 1e-5);

    let cfg = EngineConfig::from_env();
    assert_eq!(cfg.max_camera_workers, 8);
    assert!(cfg.snapshot_max_bytes_per_sec < 1_000_000);
}
