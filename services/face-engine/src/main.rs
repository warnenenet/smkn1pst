use clap::{Parser, Subcommand};
use face_engine::align::{estimate_similarity_lmeds, warp_rgb_112, ARCFACE_DST_112};
use face_engine::bench::{embed_aligned_image_file, run_benchmark_suite};
use face_engine::config::EngineConfig;
use face_engine::db::DbStore;
use face_engine::det_scrfd::ScrfdDetector;
use face_engine::embedder::{init_ort_environment, ArcFaceEmbedder};
use face_engine::gallery::GalleryIndex;
use face_engine::http_api::{build_router, AppSharedState, InferenceEngine};
use face_engine::models::verify_startup_assets;
use face_engine::quality_gate::evaluate_aligned_quality_gate;
use face_engine::snapshot::SnapshotWriterHandle;
use face_engine::supervisor::run_supervisor_loop;
use face_engine::telemetry::EngineTelemetry;
use serde_json::json;
use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use tokio::sync::Notify;

#[derive(Parser)]
#[command(name = "face-engine", version, about = "Pure Rust SCRFD + LMEDS + ArcFace facial engine")]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// Start HTTP inference server + up to 8 in-process RTSP workers
    Serve,
    /// Verify ONNX models, ORT library SHA256, and configuration bounds (fails fast on mismatch)
    CheckConfig,
    /// Inspect SQLite WAL pragmas and audit gallery vector norms / legacy counts
    AuditDb {
        #[arg(long)]
        db: Option<PathBuf>,
    },
    /// Enroll/update a single student embedding directly into SQLite
    Enroll {
        #[arg(long)]
        student_id: i64,
        #[arg(long)]
        image: PathBuf,
        #[arg(long)]
        db: Option<PathBuf>,
    },
    /// Batch reindex active student embeddings from stored foto_ref files
    Reindex {
        #[arg(long)]
        db: Option<PathBuf>,
        #[arg(long, default_value_t = false)]
        legacy_only: bool,
    },
    /// Run performance benchmarks (detect, embed, 5000x512 batch cosine, RSS)
    Bench {
        #[arg(long, default_value_t = 30)]
        iterations: usize,
        #[arg(long)]
        image: Option<PathBuf>,
    },
    /// Compute L2-normalized 512-D embedding JSON for a pre-aligned 112x112 crop (parity check)
    EmbedCrop {
        #[arg(long)]
        image: PathBuf,
    },
}

fn main() -> ExitCode {
    let cli = Cli::parse();
    let cfg = EngineConfig::from_env();

    let exit = match cli.command {
        Commands::CheckConfig => cmd_check_config(&cfg),
        Commands::AuditDb { db } => cmd_audit_db(&cfg, db),
        Commands::Enroll {
            student_id,
            image,
            db,
        } => cmd_enroll(&cfg, student_id, &image, db),
        Commands::Reindex { db, legacy_only } => cmd_reindex(&cfg, db, legacy_only),
        Commands::Bench { iterations, image } => cmd_bench(&cfg, iterations, image),
        Commands::EmbedCrop { image } => cmd_embed_crop(&cfg, &image),
        Commands::Serve => cmd_serve(cfg),
    };

    match exit {
        Ok(()) => ExitCode::SUCCESS,
        Err(err) => {
            eprintln!("[FATAL][face-engine] {err}");
            ExitCode::from(1)
        }
    }
}

fn cmd_check_config(cfg: &EngineConfig) -> Result<(), String> {
    let assets = verify_startup_assets(cfg)?;
    println!(
        "{}",
        json!({
            "ok": true,
            "pipeline_version": cfg.pipeline_version,
            "det_sha256": assets.det_sha256,
            "rec_sha256": assets.rec_sha256,
            "ort_sha256": assets.ort_sha256,
            "combined_model_sha256": assets.combined_model_sha256,
            "max_camera_workers": cfg.max_camera_workers,
            "ort_intra_threads": cfg.ort_intra_threads,
        })
    );
    Ok(())
}

fn cmd_audit_db(cfg: &EngineConfig, db_override: Option<PathBuf>) -> Result<(), String> {
    let path = db_override.unwrap_or_else(|| cfg.sqlite_path.clone());
    let store = DbStore::open(&path)?;
    let pragmas = store.inspect_pragmas()?;
    let audit = store.audit_gallery()?;
    println!(
        "{}",
        json!({
            "ok": true,
            "db_path": path.display().to_string(),
            "pragmas": pragmas,
            "audit": audit,
        })
    );
    Ok(())
}

fn cmd_enroll(
    cfg: &EngineConfig,
    student_id: i64,
    image_path: &PathBuf,
    db_override: Option<PathBuf>,
) -> Result<(), String> {
    let assets = verify_startup_assets(cfg)?;
    init_ort_environment(&cfg.ort_dylib_path)?;
    let db_path = db_override.unwrap_or_else(|| cfg.sqlite_path.clone());
    let store = DbStore::open(&db_path)?;
    let thresholds = store.load_thresholds()?;

    let img = image::open(image_path)
        .map_err(|e| format!("failed opening {}: {e}", image_path.display()))?
        .to_rgb8();
    let (w, h) = img.dimensions();

    let mut inf = InferenceEngine {
        detector: ScrfdDetector::load(
            &cfg.det_model_path,
            cfg.ort_intra_threads,
            cfg.detector_input_size,
            thresholds.threshold_confidence.min(0.35),
            0.40,
        )?,
        embedder: ArcFaceEmbedder::load(&cfg.rec_model_path, cfg.ort_intra_threads)?,
    };

    let (conf, face_px, q_score, emb) = inf
        .embed_best_face(img.as_raw(), w, h, &thresholds)
        .map_err(|(_, msg)| msg)?;

    store.update_student_embedding(
        student_id,
        &emb,
        q_score,
        &cfg.pipeline_version,
        &assets.combined_model_sha256,
    )?;

    println!(
        "{}",
        json!({
            "ok": true,
            "student_id": student_id,
            "confidence": conf,
            "face_size_px": face_px,
            "quality_score": q_score,
            "pipeline_version": cfg.pipeline_version,
            "model_sha256": assets.combined_model_sha256,
        })
    );
    Ok(())
}

fn cmd_reindex(
    cfg: &EngineConfig,
    db_override: Option<PathBuf>,
    legacy_only: bool,
) -> Result<(), String> {
    let assets = verify_startup_assets(cfg)?;
    init_ort_environment(&cfg.ort_dylib_path)?;
    let db_path = db_override.unwrap_or_else(|| cfg.sqlite_path.clone());
    let store = DbStore::open(&db_path)?;
    let thresholds = store.load_thresholds()?;
    let candidates = store.list_reindex_candidates(legacy_only)?;

    let mut detector = ScrfdDetector::load(
        &cfg.det_model_path,
        cfg.ort_intra_threads,
        cfg.detector_input_size,
        thresholds.threshold_confidence.min(0.35),
        0.40,
    )?;
    let mut embedder = ArcFaceEmbedder::load(&cfg.rec_model_path, cfg.ort_intra_threads)?;

    let mut updated = 0usize;
    let mut skipped = 0usize;

    for cand in candidates {
        let Some(ref ref_str) = cand.foto_ref else {
            skipped += 1;
            continue;
        };
        let resolved = resolve_image_path(cfg, ref_str);
        if !resolved.is_file() {
            skipped += 1;
            continue;
        }
        let Ok(dyn_img) = image::open(&resolved) else {
            skipped += 1;
            continue;
        };
        let rgb = dyn_img.to_rgb8();
        let (w, h) = rgb.dimensions();
        let Ok(faces) = detector.detect_rgb(rgb.as_raw(), w, h) else {
            skipped += 1;
            continue;
        };
        let Some(face) = faces.into_iter().max_by(|a, b| {
            ((a.bbox[2] - a.bbox[0]) * (a.bbox[3] - a.bbox[1]))
                .total_cmp(&((b.bbox[2] - b.bbox[0]) * (b.bbox[3] - b.bbox[1])))
        }) else {
            skipped += 1;
            continue;
        };
        let Some(affine) = estimate_similarity_lmeds(&face.kps, &ARCFACE_DST_112) else {
            skipped += 1;
            continue;
        };
        let Some(aligned) = warp_rgb_112(rgb.as_raw(), w, h, &affine) else {
            skipped += 1;
            continue;
        };
        let qgate = evaluate_aligned_quality_gate(&face, &aligned, &thresholds);
        if !qgate.passed {
            skipped += 1;
            continue;
        }
        let Ok(emb) = embedder.embed_aligned_rgb112(&aligned) else {
            skipped += 1;
            continue;
        };
        if store
            .update_student_embedding(
                cand.student_id,
                &emb,
                qgate.quality_score,
                &cfg.pipeline_version,
                &assets.combined_model_sha256,
            )
            .is_ok()
        {
            updated += 1;
        } else {
            skipped += 1;
        }
    }

    println!(
        "{}",
        json!({
            "ok": true,
            "legacy_only": legacy_only,
            "updated": updated,
            "skipped": skipped,
            "pipeline_version": cfg.pipeline_version,
            "model_sha256": assets.combined_model_sha256,
        })
    );
    Ok(())
}

fn resolve_image_path(cfg: &EngineConfig, foto_ref: &str) -> PathBuf {
    let trimmed = foto_ref.trim();
    if trimmed.starts_with("/data/") {
        return cfg.data_dir.join(trimmed.trim_start_matches("/data/"));
    }
    let p = PathBuf::from(trimmed);
    if p.is_absolute() {
        p
    } else {
        cfg.data_dir.join(p)
    }
}

fn cmd_bench(
    cfg: &EngineConfig,
    iterations: usize,
    image_path: Option<PathBuf>,
) -> Result<(), String> {
    let report = run_benchmark_suite(cfg, iterations, image_path.as_deref())?;
    println!(
        "{}",
        serde_json::to_string_pretty(&report).map_err(|e| e.to_string())?
    );
    Ok(())
}

fn cmd_embed_crop(cfg: &EngineConfig, image_path: &PathBuf) -> Result<(), String> {
    let emb = embed_aligned_image_file(cfg, image_path)?;
    println!("{}", json!({ "ok": true, "embedding": emb }));
    Ok(())
}

fn cmd_serve(cfg: EngineConfig) -> Result<(), String> {
    // Fail-fast on missing/corrupt ONNX models or ONNX Runtime dylib BEFORE opening HTTP port!
    let assets = verify_startup_assets(&cfg)?;
    init_ort_environment(&cfg.ort_dylib_path)?;

    let detector = ScrfdDetector::load(
        &cfg.det_model_path,
        cfg.ort_intra_threads,
        cfg.detector_input_size,
        cfg.thresholds.threshold_confidence.min(0.35),
        0.40,
    )?;
    let embedder = ArcFaceEmbedder::load(&cfg.rec_model_path, cfg.ort_intra_threads)?;

    let initial_thresholds = if cfg.sqlite_path.is_file() {
        DbStore::open(&cfg.sqlite_path)
            .and_then(|s| s.load_thresholds())
            .unwrap_or_else(|_| cfg.thresholds.clone())
    } else {
        cfg.thresholds.clone()
    };

    let telemetry = Arc::new(EngineTelemetry::new(cfg.web_backend_url.clone()));
    let listen_addr = cfg.listen_addr.clone();
    let shared = Arc::new(AppSharedState {
        config: cfg.clone(),
        model_sha256: assets.combined_model_sha256,
        inference: Arc::new(Mutex::new(InferenceEngine { detector, embedder })),
        gallery: Arc::new(RwLock::new(GalleryIndex::default())),
        thresholds: Arc::new(RwLock::new(initial_thresholds)),
        telemetry,
        reload_notify: Arc::new(Notify::new()),
    });

    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .thread_name("face-engine-rt")
        .build()
        .map_err(|e| format!("failed building tokio runtime: {e}"))?;

    rt.block_on(async move {
        let snapshots = SnapshotWriterHandle::spawn(
            shared.config.snapshots_dir.clone(),
            shared.config.snapshot_max_bytes_per_sec,
        );
        let global_stop = Arc::new(AtomicBool::new(false));
        run_supervisor_loop(Arc::clone(&shared), snapshots, Arc::clone(&global_stop));

        let listener = tokio::net::TcpListener::bind(&listen_addr)
            .await
            .map_err(|e| format!("failed binding {listen_addr}: {e}"))?;

        eprintln!(
            "[BOOT] face-engine (rust) listening on http://{listen_addr} | pipeline={} | ort_intra={}",
            shared.config.pipeline_version, shared.config.ort_intra_threads
        );

        let app = build_router(Arc::clone(&shared));
        let stop_sig = Arc::clone(&global_stop);
        axum::serve(listener, app)
            .with_graceful_shutdown(async move {
                let _ = tokio::signal::ctrl_c().await;
                stop_sig.store(true, Ordering::Relaxed);
            })
            .await
            .map_err(|e| format!("axum serve error: {e}"))?;

        Ok::<(), String>(())
    })
}
