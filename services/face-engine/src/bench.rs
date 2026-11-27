use crate::config::EngineConfig;
use crate::det_scrfd::ScrfdDetector;
use crate::embedder::{cosine_similarity, l2_normalize, ArcFaceEmbedder, EMBEDDING_DIM};
use crate::gallery::{GalleryEntry, GalleryIndex};
use crate::models::verify_startup_assets;
use crate::telemetry::{read_process_rss_mb, LatencySummary, LatencyTracker};
use serde::Serialize;
use std::path::Path;
use std::time::Instant;

#[derive(Debug, Serialize)]
pub struct BenchReport {
    pub iterations: usize,
    pub cpu_cores: usize,
    pub rss_mb: f64,
    pub det_sha256: String,
    pub rec_sha256: String,
    pub ort_sha256: String,
    pub detect_640x360: LatencySummary,
    pub embed_112x112: LatencySummary,
    pub match_5000x512: LatencySummary,
    pub targets_met: BenchTargetsEvaluation,
}

#[derive(Debug, Serialize)]
pub struct BenchTargetsEvaluation {
    pub detect_p95_under_15ms: bool,
    pub embed_p95_under_250ms: bool,
    pub match5000_p95_under_1ms: bool,
    pub rss_under_500mb: bool,
}

pub fn run_benchmark_suite(
    cfg: &EngineConfig,
    iterations: usize,
    sample_image_path: Option<&Path>,
) -> Result<BenchReport, String> {
    let assets = verify_startup_assets(cfg)?;
    crate::embedder::init_ort_environment(&cfg.ort_dylib_path)?;

    let mut detector = ScrfdDetector::load(
        &cfg.det_model_path,
        cfg.ort_intra_threads,
        cfg.detector_input_size,
        cfg.thresholds.threshold_confidence.min(0.35),
        0.40,
    )?;
    let mut embedder = ArcFaceEmbedder::load(&cfg.rec_model_path, cfg.ort_intra_threads)?;

    // Build synthetic or loaded 640x360 RGB input and 112x112 aligned crop
    let (frame_rgb, fw, fh) = if let Some(path) = sample_image_path {
        let dyn_img = image::open(path)
            .map_err(|e| format!("failed reading sample image {}: {e}", path.display()))?;
        let rgb = dyn_img.to_rgb8();
        let (w, h) = rgb.dimensions();
        (rgb.into_raw(), w, h)
    } else {
        (vec![128u8; 640 * 360 * 3], 640, 360)
    };
    let crop112 = vec![140u8; 112 * 112 * 3];

    // Build deterministic 5000-entry normalized gallery
    let mut entries = Vec::with_capacity(5000);
    for i in 1..=5000i64 {
        let mut raw = vec![0.0f32; EMBEDDING_DIM];
        raw[(i as usize) % EMBEDDING_DIM] = 1.0;
        raw[((i as usize) * 7 + 13) % EMBEDDING_DIM] = 0.25;
        entries.push(GalleryEntry {
            student_id: i,
            embedding: l2_normalize(&raw),
            is_legacy: false,
        });
    }
    let gallery = GalleryIndex::from_entries(entries);
    let probe = l2_normalize(&vec![0.1f32; EMBEDDING_DIM]);

    // Warmup pass
    for _ in 0..3 {
        let _ = detector.detect_rgb(&frame_rgb, fw, fh)?;
        let _ = embedder.embed_aligned_rgb112(&crop112)?;
        let _ = gallery.top2(&probe);
    }

    let iters = iterations.max(5);
    let mut det_lat = LatencyTracker::new(iters);
    let mut emb_lat = LatencyTracker::new(iters);
    let mut match_lat = LatencyTracker::new(iters);

    for _ in 0..iters {
        let t0 = Instant::now();
        let _ = detector.detect_rgb(&frame_rgb, fw, fh)?;
        det_lat.record(t0.elapsed().as_secs_f64() * 1000.0);

        let t1 = Instant::now();
        let _ = embedder.embed_aligned_rgb112(&crop112)?;
        emb_lat.record(t1.elapsed().as_secs_f64() * 1000.0);

        let t2 = Instant::now();
        let _ = gallery.top2(&probe);
        match_lat.record(t2.elapsed().as_secs_f64() * 1000.0);
    }

    let detect_sum = det_lat.snapshot();
    let embed_sum = emb_lat.snapshot();
    let match_sum = match_lat.snapshot();
    let rss_mb = read_process_rss_mb();

    let cpu_cores = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(1);

    Ok(BenchReport {
        iterations: iters,
        cpu_cores,
        rss_mb,
        det_sha256: assets.det_sha256,
        rec_sha256: assets.rec_sha256,
        ort_sha256: assets.ort_sha256,
        targets_met: BenchTargetsEvaluation {
            detect_p95_under_15ms: detect_sum.p95_ms < 15.0,
            embed_p95_under_250ms: embed_sum.p95_ms < 250.0,
            match5000_p95_under_1ms: match_sum.p95_ms < 1.0,
            rss_under_500mb: rss_mb < 500.0,
        },
        detect_640x360: detect_sum,
        embed_112x112: embed_sum,
        match_5000x512: match_sum,
    })
}

/// Computes ArcFace embedding directly from a pre-aligned 112x112 image (for Python parity tests).
pub fn embed_aligned_image_file(cfg: &EngineConfig, image_path: &Path) -> Result<Vec<f32>, String> {
    verify_startup_assets(cfg)?;
    crate::embedder::init_ort_environment(&cfg.ort_dylib_path)?;
    let mut embedder = ArcFaceEmbedder::load(&cfg.rec_model_path, cfg.ort_intra_threads)?;
    let img = image::open(image_path)
        .map_err(|e| format!("failed opening {}: {e}", image_path.display()))?
        .to_rgb8();
    if img.width() != 112 || img.height() != 112 {
        return Err(format!(
            "expected pre-aligned 112x112 image, got {}x{}",
            img.width(),
            img.height()
        ));
    }
    embedder.embed_aligned_rgb112(img.as_raw())
}

pub fn compare_embeddings_cos(a: &[f32], b: &[f32]) -> f32 {
    cosine_similarity(a, b)
}
