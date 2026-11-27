mod db_audit;
mod math;
mod mp_path;
mod ort_infer;
mod video_io;

use clap::{Parser, Subcommand};
use db_audit::{StudentGalleryEntry, audit_students_db};
use math::{
    ARCFACE_DST_112, bucket_for_face_width, cosine_similarity, estimate_similarity_lmeds,
    estimate_similarity_ls, percentile_sorted, rmse_5pt, warp_rgb_112,
};
use mp_path::{MediaPipePathA, verify_mediapipe_once};
use ort_infer::{ArcFaceEmbedder, ScrfdDetector};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Instant;
use video_io::decode_video_frames_ffmpeg;

#[derive(Parser)]
#[command(name = "gate_a_spike", about = "Gate A Spike CLI (MediaPipe vs SCRFD + ort ArcFace)")]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Clone, Copy, PartialEq, Eq, clap::ValueEnum)]
enum BenchMode {
    Both,
    PathA,
    PathB,
}

#[derive(Subcommand)]
enum Commands {
    /// Inspect SQLite students.embedding column (L2 normalization, NULL count, dimensions)
    AuditDb {
        #[arg(long)]
        db: PathBuf,
    },
    /// Verify mediapipe-rs .tflite and .task bundle formats and 5-pt mesh orientation
    VerifyMediapipe {
        #[arg(long)]
        detector_tflite: PathBuf,
        #[arg(long)]
        landmarker_task: PathBuf,
        #[arg(long)]
        image: PathBuf,
    },
    /// Embed an identical 112x112 crop PNG/JPEG with w600k_r50.onnx via ort
    CompareEmbedder {
        #[arg(long)]
        arcface_onnx: PathBuf,
        #[arg(long)]
        crop_112: PathBuf,
        #[arg(long, default_value_t = 4)]
        intra_threads: usize,
    },
    /// Compare LMEDS vs Least-Squares (Umeyama) alignment on identical 5 keypoints
    CompareAlignment {
        #[arg(long)]
        arcface_onnx: PathBuf,
        #[arg(long)]
        det_onnx: PathBuf,
        #[arg(long)]
        image: PathBuf,
        #[arg(long, default_value_t = 4)]
        intra_threads: usize,
        #[arg(long)]
        save_lmeds_crop: Option<PathBuf>,
        #[arg(long)]
        save_ls_crop: Option<PathBuf>,
    },
    /// Benchmark Path A (MediaPipe) and/or Path B (SCRFD + LMEDS) on the same video and SQLite gallery
    BenchPaths {
        #[arg(long)]
        video: PathBuf,
        #[arg(long)]
        db: PathBuf,
        #[arg(long)]
        detector_tflite: PathBuf,
        #[arg(long)]
        landmarker_task: PathBuf,
        #[arg(long)]
        det_onnx: PathBuf,
        #[arg(long)]
        arcface_onnx: PathBuf,
        #[arg(long, default_value_t = 300)]
        max_frames: usize,
        #[arg(long)]
        sample_fps: Option<f32>,
        #[arg(long, default_value_t = 4)]
        intra_threads: usize,
        #[arg(long, default_value_t = 0.50)]
        det_thresh: f32,
        #[arg(long, default_value_t = 0.60)]
        match_thresh: f32,
        #[arg(long, default_value_t = 0.08)]
        min_margin: f32,
        #[arg(long, value_enum, default_value_t = BenchMode::Both)]
        mode: BenchMode,
    },
}

#[derive(Serialize)]
struct AlignmentCompareReport {
    image_path: String,
    width: u32,
    height: u32,
    det_score: f32,
    src_kps_5pt: [[f32; 2]; 5],
    dst_arcface_112: [[f32; 2]; 5],
    matrix_ls: [[f64; 3]; 2],
    matrix_lmeds: [[f64; 3]; 2],
    matrix_max_abs_diff: f64,
    rmse_ls_px: f64,
    rmse_lmeds_px: f64,
    embedding_cosine_ls_vs_lmeds: f32,
    embedding_ls: Vec<f32>,
    embedding_lmeds: Vec<f32>,
}

#[derive(Serialize)]
struct PathBenchStats {
    path_name: String,
    frames_processed: usize,
    total_faces_detected: usize,
    faces_ge_80px: usize,
    detections_per_width_bucket: BTreeMap<String, usize>,
    latency_ms_p50: f64,
    latency_ms_p95: f64,
    latency_ms_p99: f64,
    latency_ms_mean: f64,
    gallery_matched_top1_count: usize,
    gallery_margin_accepted_count: usize,
    top1_similarity_mean: f64,
    top1_similarity_p50: f64,
    top1_similarity_p95: f64,
    peak_rss_mb_after: f64,
}

#[derive(Serialize)]
struct BenchPathsReport {
    video_path: String,
    frame_width: u32,
    frame_height: u32,
    frames_decoded: usize,
    gallery_size: usize,
    det_thresh: f32,
    match_thresh: f32,
    min_margin: f32,
    models_sha256: BTreeMap<String, String>,
    blazeface_tflite_total_detections: usize,
    blazeface_tflite_ge_80px: usize,
    blazeface_tflite_p50_ms: f64,
    blazeface_tflite_p95_ms: f64,
    path_a_mediapipe: PathBenchStats,
    path_b_scrfd: PathBenchStats,
    frame_events_path_a: Vec<FrameMatchSummary>,
    frame_events_path_b: Vec<FrameMatchSummary>,
}

#[derive(Serialize)]
struct FrameMatchSummary {
    frame_index: usize,
    width_px: f32,
    bucket: String,
    top1_student_id: Option<i64>,
    top1_sim: f32,
    margin: f32,
}

fn read_proc_rss_mb() -> (f64, f64) {
    let Ok(status) = fs::read_to_string("/proc/self/status") else {
        return (0.0, 0.0);
    };
    let mut rss_kb = 0.0f64;
    let mut hwm_kb = 0.0f64;
    for line in status.lines() {
        if let Some(rest) = line.strip_prefix("VmRSS:") {
            rss_kb = rest
                .split_whitespace()
                .next()
                .and_then(|s| s.parse::<f64>().ok())
                .unwrap_or(0.0);
        } else if let Some(rest) = line.strip_prefix("VmHWM:") {
            hwm_kb = rest
                .split_whitespace()
                .next()
                .and_then(|s| s.parse::<f64>().ok())
                .unwrap_or(0.0);
        }
    }
    (rss_kb / 1024.0, hwm_kb / 1024.0)
}

fn sha256_file(path: &Path) -> Result<String, String> {
    let bytes = fs::read(path).map_err(|e| format!("read {} failed: {e}", path.display()))?;
    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    Ok(format!("{:x}", hasher.finalize()))
}

fn match_gallery(
    emb: &[f32],
    gallery: &[StudentGalleryEntry],
    threshold: f32,
    min_margin: f32,
) -> (Option<i64>, f32, f32, bool) {
    if gallery.is_empty() {
        return (None, 0.0, 0.0, false);
    }
    let mut top1_id: Option<i64> = None;
    let mut top1_sim = f32::NEG_INFINITY;
    let mut top2_sim = f32::NEG_INFINITY;
    for entry in gallery {
        let s = cosine_similarity(emb, &entry.embedding);
        if s > top1_sim {
            if top1_id.is_some() && s > top2_sim {
                top2_sim = top1_sim;
            }
            top1_sim = s;
            top1_id = Some(entry.id);
        } else if s > top2_sim {
            top2_sim = s;
        }
    }
    let safe_t1 = if top1_sim.is_finite() { top1_sim.max(0.0) } else { 0.0 };
    let safe_t2 = if top2_sim.is_finite() { top2_sim.max(0.0) } else { 0.0 };
    let margin = if gallery.len() > 1 {
        (safe_t1 - safe_t2).max(0.0)
    } else {
        safe_t1
    };
    let accepted = top1_id.is_some() && safe_t1 >= threshold && (gallery.len() <= 1 || margin >= min_margin);
    (if accepted { top1_id } else { None }, safe_t1, margin, accepted)
}

fn init_bucket_map() -> BTreeMap<String, usize> {
    let mut m = BTreeMap::new();
    for k in ["<40", "40-59", "60-79", "80-99", "100-129", "130+"] {
        m.insert(k.to_string(), 0);
    }
    m
}

fn summarize_stats(
    path_name: &str,
    frames_processed: usize,
    total_faces_detected: usize,
    faces_ge_80px: usize,
    buckets: BTreeMap<String, usize>,
    mut latencies_ms: Vec<f64>,
    matched_top1_count: usize,
    margin_accepted_count: usize,
    mut top1_sims: Vec<f64>,
    peak_rss_mb_after: f64,
) -> PathBenchStats {
    latencies_ms.sort_by(|a, b| a.total_cmp(b));
    top1_sims.sort_by(|a, b| a.total_cmp(b));
    let lat_mean = if latencies_ms.is_empty() {
        0.0
    } else {
        latencies_ms.iter().sum::<f64>() / latencies_ms.len() as f64
    };
    let sim_mean = if top1_sims.is_empty() {
        0.0
    } else {
        top1_sims.iter().sum::<f64>() / top1_sims.len() as f64
    };
    PathBenchStats {
        path_name: path_name.to_string(),
        frames_processed,
        total_faces_detected,
        faces_ge_80px,
        detections_per_width_bucket: buckets,
        latency_ms_p50: percentile_sorted(&latencies_ms, 0.50),
        latency_ms_p95: percentile_sorted(&latencies_ms, 0.95),
        latency_ms_p99: percentile_sorted(&latencies_ms, 0.99),
        latency_ms_mean: lat_mean,
        gallery_matched_top1_count: matched_top1_count,
        gallery_margin_accepted_count: margin_accepted_count,
        top1_similarity_mean: sim_mean,
        top1_similarity_p50: percentile_sorted(&top1_sims, 0.50),
        top1_similarity_p95: percentile_sorted(&top1_sims, 0.95),
        peak_rss_mb_after,
    }
}

fn main() -> Result<(), String> {
    let cli = Cli::parse();
    match cli.command {
        Commands::AuditDb { db } => {
            let (report, _) = audit_students_db(&db)?;
            println!(
                "{}",
                serde_json::to_string_pretty(&report).map_err(|e| e.to_string())?
            );
        }
        Commands::VerifyMediapipe {
            detector_tflite,
            landmarker_task,
            image,
        } => {
            let res = verify_mediapipe_once(&detector_tflite, &landmarker_task, &image)?;
            println!(
                "{}",
                serde_json::to_string_pretty(&res).map_err(|e| e.to_string())?
            );
        }
        Commands::CompareEmbedder {
            arcface_onnx,
            crop_112,
            intra_threads,
        } => {
            let img = image::open(&crop_112)
                .map_err(|e| format!("open {} failed: {e}", crop_112.display()))?
                .to_rgb8();
            if img.width() != 112 || img.height() != 112 {
                return Err(format!(
                    "crop_112 must be 112x112, got {}x{}",
                    img.width(),
                    img.height()
                ));
            }
            let mut embedder = ArcFaceEmbedder::load(&arcface_onnx, intra_threads)?;
            let emb = embedder.embed_rgb_112(img.as_raw())?;
            let (rss, hwm) = read_proc_rss_mb();
            let out = serde_json::json!({
                "crop_path": crop_112.display().to_string(),
                "arcface_sha256": sha256_file(&arcface_onnx)?,
                "dim": emb.len(),
                "l2_norm": math::l2_norm(&emb),
                "embedding": emb,
                "rss_mb": rss,
                "hwm_mb": hwm,
            });
            println!("{}", serde_json::to_string_pretty(&out).map_err(|e| e.to_string())?);
        }
        Commands::CompareAlignment {
            arcface_onnx,
            det_onnx,
            image,
            intra_threads,
            save_lmeds_crop,
            save_ls_crop,
        } => {
            let img = image::open(&image)
                .map_err(|e| format!("open {} failed: {e}", image.display()))?
                .to_rgb8();
            let w = img.width();
            let h = img.height();
            let mut det = ScrfdDetector::load(&det_onnx, intra_threads, 640, 0.30, 0.40)?;
            let faces = det.detect_rgb(img.as_raw(), w, h)?;
            let best = faces
                .first()
                .ok_or_else(|| format!("no face detected in {}", image.display()))?;

            let m_ls = estimate_similarity_ls(&best.kps, &ARCFACE_DST_112)
                .ok_or_else(|| "LS similarity failed".to_string())?;
            let m_lmeds = estimate_similarity_lmeds(&best.kps, &ARCFACE_DST_112)
                .ok_or_else(|| "LMEDS similarity failed".to_string())?;

            let crop_ls = warp_rgb_112(img.as_raw(), w, h, &m_ls)
                .ok_or_else(|| "warp LS failed".to_string())?;
            let crop_lmeds = warp_rgb_112(img.as_raw(), w, h, &m_lmeds)
                .ok_or_else(|| "warp LMEDS failed".to_string())?;

            if let Some(p) = save_ls_crop {
                let rgb_img = image::RgbImage::from_raw(112, 112, crop_ls.clone())
                    .ok_or_else(|| "RgbImage LS failed".to_string())?;
                rgb_img.save(&p).map_err(|e| format!("save LS crop failed: {e}"))?;
            }
            if let Some(p) = save_lmeds_crop {
                let rgb_img = image::RgbImage::from_raw(112, 112, crop_lmeds.clone())
                    .ok_or_else(|| "RgbImage LMEDS failed".to_string())?;
                rgb_img.save(&p).map_err(|e| format!("save LMEDS crop failed: {e}"))?;
            }

            let mut embedder = ArcFaceEmbedder::load(&arcface_onnx, intra_threads)?;
            let emb_ls = embedder.embed_rgb_112(&crop_ls)?;
            let emb_lmeds = embedder.embed_rgb_112(&crop_lmeds)?;
            let cos = cosine_similarity(&emb_ls, &emb_lmeds);

            let report = AlignmentCompareReport {
                image_path: image.display().to_string(),
                width: w,
                height: h,
                det_score: best.score,
                src_kps_5pt: best.kps,
                dst_arcface_112: ARCFACE_DST_112,
                matrix_ls: m_ls.to_rows(),
                matrix_lmeds: m_lmeds.to_rows(),
                matrix_max_abs_diff: m_ls.max_abs_diff(&m_lmeds),
                rmse_ls_px: rmse_5pt(&m_ls, &best.kps, &ARCFACE_DST_112),
                rmse_lmeds_px: rmse_5pt(&m_lmeds, &best.kps, &ARCFACE_DST_112),
                embedding_cosine_ls_vs_lmeds: cos,
                embedding_ls: emb_ls,
                embedding_lmeds: emb_lmeds,
            };
            println!(
                "{}",
                serde_json::to_string_pretty(&report).map_err(|e| e.to_string())?
            );
        }
        Commands::BenchPaths {
            video,
            db,
            detector_tflite,
            landmarker_task,
            det_onnx,
            arcface_onnx,
            max_frames,
            sample_fps,
            intra_threads,
            det_thresh,
            match_thresh,
            min_margin,
            mode,
        } => {
            let (_db_audit, gallery) = audit_students_db(&db)?;
            let frames = decode_video_frames_ffmpeg(&video, max_frames, sample_fps)?;
            if frames.is_empty() {
                return Err(format!("no frames decoded from {}", video.display()));
            }
            let fw = frames[0].width;
            let fh = frames[0].height;

            let mut models_sha256 = BTreeMap::new();
            models_sha256.insert("blaze_face_short_range.tflite".into(), sha256_file(&detector_tflite)?);
            models_sha256.insert("face_landmarker.task".into(), sha256_file(&landmarker_task)?);
            models_sha256.insert("det_10g.onnx".into(), sha256_file(&det_onnx)?);
            models_sha256.insert("w600k_r50.onnx".into(), sha256_file(&arcface_onnx)?);

            let mut embedder = ArcFaceEmbedder::load(&arcface_onnx, intra_threads)?;

            let mut bf_lats = Vec::new();
            let mut bf_total = 0usize;
            let mut bf_ge_80 = 0usize;
            let mut a_lats = Vec::new();
            let mut a_buckets = init_bucket_map();
            let mut a_total = 0usize;
            let mut a_ge_80 = 0usize;
            let mut a_matched = 0usize;
            let mut a_accepted = 0usize;
            let mut a_sims = Vec::new();
            let mut a_events = Vec::new();
            let mut hwm_a = 0.0f64;

            if mode == BenchMode::Both || mode == BenchMode::PathA {
                // ---- Warmup & Path A: MediaPipe FaceDetector (.tflite) + FaceLandmarker (.task) ----
                let mut mp = MediaPipePathA::load(Some(&detector_tflite), &landmarker_task, 10, det_thresh)?;
                if let Some(first) = frames.first() {
                    let _ = mp.detect_blazeface_rgb(&first.rgb, first.width, first.height);
                    let _ = mp.detect_landmarker_rgb(&first.rgb, first.width, first.height);
                }

                bf_lats.reserve(frames.len());
                for f in &frames {
                    let t0 = Instant::now();
                    let boxes = mp.detect_blazeface_rgb(&f.rgb, f.width, f.height)?;
                    bf_lats.push(t0.elapsed().as_secs_f64() * 1000.0);
                    for b in boxes {
                        bf_total += 1;
                        if (b[2] - b[0]) >= 80.0 {
                            bf_ge_80 += 1;
                        }
                    }
                }
                bf_lats.sort_by(|a, b| a.total_cmp(b));

                a_lats.reserve(frames.len());
                for f in &frames {
                    let t0 = Instant::now();
                    let faces = mp.detect_landmarker_rgb(&f.rgb, f.width, f.height)?;
                    for face in faces {
                        a_total += 1;
                        let bucket = bucket_for_face_width(face.width_px);
                        *a_buckets.entry(bucket.to_string()).or_insert(0) += 1;
                        if face.width_px >= 80.0 {
                            a_ge_80 += 1;
                        }
                        if let Some(m) = estimate_similarity_lmeds(&face.kps_5pt, &ARCFACE_DST_112) {
                            if let Some(crop) = warp_rgb_112(&f.rgb, f.width, f.height, &m) {
                                let emb = embedder.embed_rgb_112(&crop)?;
                                let (sid, sim, margin, acc) =
                                    match_gallery(&emb, &gallery, match_thresh, min_margin);
                                a_sims.push(sim as f64);
                                if sim >= match_thresh {
                                    a_matched += 1;
                                }
                                if acc {
                                    a_accepted += 1;
                                }
                                a_events.push(FrameMatchSummary {
                                    frame_index: f.frame_index,
                                    width_px: face.width_px,
                                    bucket: bucket.to_string(),
                                    top1_student_id: sid,
                                    top1_sim: sim,
                                    margin,
                                });
                            }
                        }
                    }
                    a_lats.push(t0.elapsed().as_secs_f64() * 1000.0);
                }
                let (_rss_a, h_a) = read_proc_rss_mb();
                hwm_a = h_a;
            }

            let mut b_lats = Vec::new();
            let mut b_buckets = init_bucket_map();
            let mut b_total = 0usize;
            let mut b_ge_80 = 0usize;
            let mut b_matched = 0usize;
            let mut b_accepted = 0usize;
            let mut b_sims = Vec::new();
            let mut b_events = Vec::new();
            let mut hwm_b = 0.0f64;

            if mode == BenchMode::Both || mode == BenchMode::PathB {
                // ---- Path B: SCRFD (det_10g.onnx via ort) + LMEDS + ArcFace ----
                let mut scrfd = ScrfdDetector::load(&det_onnx, intra_threads, 640, det_thresh, 0.40)?;
                if let Some(first) = frames.first() {
                    let _ = scrfd.detect_rgb(&first.rgb, first.width, first.height);
                }

                b_lats.reserve(frames.len());
                for f in &frames {
                    let t0 = Instant::now();
                    let faces = scrfd.detect_rgb(&f.rgb, f.width, f.height)?;
                    for face in faces {
                        b_total += 1;
                        let wpx = face.width_px();
                        let bucket = bucket_for_face_width(wpx);
                        *b_buckets.entry(bucket.to_string()).or_insert(0) += 1;
                        if wpx >= 80.0 {
                            b_ge_80 += 1;
                        }
                        if let Some(m) = estimate_similarity_lmeds(&face.kps, &ARCFACE_DST_112) {
                            if let Some(crop) = warp_rgb_112(&f.rgb, f.width, f.height, &m) {
                                let emb = embedder.embed_rgb_112(&crop)?;
                                let (sid, sim, margin, acc) =
                                    match_gallery(&emb, &gallery, match_thresh, min_margin);
                                b_sims.push(sim as f64);
                                if sim >= match_thresh {
                                    b_matched += 1;
                                }
                                if acc {
                                    b_accepted += 1;
                                }
                                b_events.push(FrameMatchSummary {
                                    frame_index: f.frame_index,
                                    width_px: wpx,
                                    bucket: bucket.to_string(),
                                    top1_student_id: sid,
                                    top1_sim: sim,
                                    margin,
                                });
                            }
                        }
                    }
                    b_lats.push(t0.elapsed().as_secs_f64() * 1000.0);
                }
                let (_rss_b, h_b) = read_proc_rss_mb();
                hwm_b = h_b;
            }

            let a_frames_done = if mode == BenchMode::PathB { 0 } else { frames.len() };
            let b_frames_done = if mode == BenchMode::PathA { 0 } else { frames.len() };

            let report = BenchPathsReport {
                video_path: video.display().to_string(),
                frame_width: fw,
                frame_height: fh,
                frames_decoded: frames.len(),
                gallery_size: gallery.len(),
                det_thresh,
                match_thresh,
                min_margin,
                models_sha256,
                blazeface_tflite_total_detections: bf_total,
                blazeface_tflite_ge_80px: bf_ge_80,
                blazeface_tflite_p50_ms: percentile_sorted(&bf_lats, 0.50),
                blazeface_tflite_p95_ms: percentile_sorted(&bf_lats, 0.95),
                path_a_mediapipe: summarize_stats(
                    "Path A (MediaPipe FaceLandmarker .task + ArcFace ort)",
                    a_frames_done,
                    a_total,
                    a_ge_80,
                    a_buckets,
                    a_lats,
                    a_matched,
                    a_accepted,
                    a_sims,
                    hwm_a,
                ),
                path_b_scrfd: summarize_stats(
                    "Path B (SCRFD det_10g.onnx ort + LMEDS + ArcFace ort)",
                    b_frames_done,
                    b_total,
                    b_ge_80,
                    b_buckets,
                    b_lats,
                    b_matched,
                    b_accepted,
                    b_sims,
                    hwm_b,
                ),
                frame_events_path_a: a_events,
                frame_events_path_b: b_events,
            };

            println!(
                "{}",
                serde_json::to_string_pretty(&report).map_err(|e| e.to_string())?
            );
        }
    }
    Ok(())
}
