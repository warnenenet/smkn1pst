use crate::align::{estimate_similarity_lmeds, warp_rgb_112, ARCFACE_DST_112};
use crate::config::{EngineConfig, ThresholdsConfig};
use crate::det_scrfd::ScrfdDetector;
use crate::embedder::{cosine_similarity, ArcFaceEmbedder};
use crate::gallery::GalleryIndex;
use crate::quality_gate::evaluate_aligned_quality_gate;
use crate::telemetry::{read_process_rss_mb, EngineTelemetry, LatencySummary};
use axum::extract::State;
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex, RwLock};
use tokio::sync::Notify;

pub struct InferenceEngine {
    pub detector: ScrfdDetector,
    pub embedder: ArcFaceEmbedder,
}

impl InferenceEngine {
    pub fn embed_best_face(
        &mut self,
        rgb: &[u8],
        width: u32,
        height: u32,
        cfg: &ThresholdsConfig,
    ) -> Result<(f32, u32, f32, Vec<f32>), (StatusCode, String)> {
        self.detector.set_det_thresh(cfg.threshold_confidence.min(0.35));
        let mut faces = self
            .detector
            .detect_rgb(rgb, width, height)
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;

        if faces.is_empty() {
            return Err((
                StatusCode::UNPROCESSABLE_ENTITY,
                "Wajah tidak terdeteksi pada foto.".to_string(),
            ));
        }

        // Prioritize largest face cleanly
        faces.sort_by(|a, b| {
            let area_a = (a.bbox[2] - a.bbox[0]) * (a.bbox[3] - a.bbox[1]);
            let area_b = (b.bbox[2] - b.bbox[0]) * (b.bbox[3] - b.bbox[1]);
            area_b.total_cmp(&area_a)
        });

        let mut last_reason = "no_face".to_string();
        for face in &faces {
            let Some(affine) = estimate_similarity_lmeds(&face.kps, &ARCFACE_DST_112) else {
                last_reason = "align_failed".to_string();
                continue;
            };
            let Some(aligned) = warp_rgb_112(rgb, width, height, &affine) else {
                last_reason = "warp_failed".to_string();
                continue;
            };
            let qgate = evaluate_aligned_quality_gate(face, &aligned, cfg);
            if !qgate.passed {
                last_reason = qgate
                    .detail
                    .unwrap_or_else(|| "quality_gate_rejected".to_string());
                continue;
            }
            let emb = self
                .embedder
                .embed_aligned_rgb112(&aligned)
                .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
            return Ok((
                (face.score * 10_000.0).round() / 10_000.0,
                qgate.face_size_px,
                qgate.quality_score,
                emb,
            ));
        }

        Err((
            StatusCode::UNPROCESSABLE_ENTITY,
            format!("Wajah ditolak filter kualitas ({last_reason})."),
        ))
    }
}

pub struct AppSharedState {
    pub config: EngineConfig,
    pub model_sha256: String,
    pub inference: Arc<Mutex<InferenceEngine>>,
    pub gallery: Arc<RwLock<GalleryIndex>>,
    pub thresholds: Arc<RwLock<ThresholdsConfig>>,
    pub telemetry: Arc<EngineTelemetry>,
    pub reload_notify: Arc<Notify>,
}

pub fn decode_image_data_url(data_url: &str) -> Result<(Vec<u8>, u32, u32), String> {
    let b64 = match data_url.split_once(',') {
        Some((_, rhs)) => rhs.trim(),
        None => data_url.trim(),
    };
    if b64.is_empty() {
        return Err("image payload is empty".to_string());
    }
    let raw = B64
        .decode(b64)
        .map_err(|e| format!("base64 decode failed: {e}"))?;
    let dyn_img = image::load_from_memory(&raw)
        .map_err(|e| format!("image decode failed: {e}"))?;
    let rgb = dyn_img.to_rgb8();
    let (w, h) = rgb.dimensions();
    if w == 0 || h == 0 {
        return Err("decoded image has zero dimensions".to_string());
    }
    Ok((rgb.into_raw(), w, h))
}

#[derive(Serialize)]
pub struct HealthResponse {
    pub ok: bool,
    pub engine: &'static str,
    pub model: &'static str,
    pub pipeline_version: String,
    pub model_sha256: String,
    pub ort_intra_threads: usize,
    pub ort_inter_threads: usize,
    pub active_camera_workers: usize,
    pub gallery_size: usize,
    pub gallery_non_unit_count: usize,
    pub gallery_legacy_count: usize,
    pub web_backend_url: String,
    pub backend_reachable: bool,
    pub backend_error: Option<String>,
    pub rss_mb: f64,
}

#[derive(Serialize)]
pub struct MetricsResponse {
    pub engine: &'static str,
    pub pipeline_version: String,
    pub rss_mb: f64,
    pub active_camera_workers: usize,
    pub gallery_size: usize,
    pub frames_processed: u64,
    pub frames_dropped: u64,
    pub snapshots_enqueued: u64,
    pub snapshots_dropped: u64,
    pub detect: LatencySummary,
    pub embed: LatencySummary,
    pub match5000: LatencySummary,
    pub pipeline: LatencySummary,
}

#[derive(Deserialize)]
pub struct EnrollRequest {
    #[serde(rename = "photoDataUrl")]
    pub photo_data_url: String,
}

#[derive(Serialize)]
pub struct EnrollResponse {
    pub ok: bool,
    pub confidence: f32,
    pub face_size_px: u32,
    pub quality_score: f32,
    pub embedding: Vec<f32>,
    pub pipeline_version: String,
    pub model_sha256: String,
}

#[derive(Deserialize)]
pub struct CompareRequest {
    #[serde(rename = "photo1DataUrl")]
    pub photo1_data_url: String,
    #[serde(rename = "photo2DataUrl")]
    pub photo2_data_url: String,
}

#[derive(Serialize)]
pub struct CompareResponse {
    pub similarity: f32,
    pub threshold: f32,
    #[serde(rename = "match")]
    pub is_match: bool,
    pub status: &'static str,
}

#[derive(Deserialize, Default)]
pub struct ReloadCamerasRequest {
    pub web_backend_url: Option<String>,
}

#[derive(Serialize)]
pub struct ReloadCamerasResponse {
    pub ok: bool,
    pub active_camera_workers: usize,
    pub gallery_size: usize,
    pub web_backend_url: String,
    pub backend_reachable: bool,
    pub backend_error: Option<String>,
}

#[derive(Serialize)]
struct ErrorBody {
    detail: String,
}

pub fn build_router(state: Arc<AppSharedState>) -> Router {
    Router::new()
        .route("/health", get(handle_health))
        .route("/metrics", get(handle_metrics))
        .route("/enroll", post(handle_enroll))
        .route("/compare", post(handle_compare))
        .route("/cameras/reload", post(handle_reload))
        .with_state(state)
}

async fn handle_health(State(state): State<Arc<AppSharedState>>) -> Json<HealthResponse> {
    let url = state.telemetry.web_backend_url.lock().expect("lock").clone();
    let err = state.telemetry.backend_error.lock().expect("lock").clone();
    Json(HealthResponse {
        ok: true,
        engine: "rust",
        model: "buffalo_l",
        pipeline_version: state.config.pipeline_version.clone(),
        model_sha256: state.model_sha256.clone(),
        ort_intra_threads: state.config.ort_intra_threads,
        ort_inter_threads: 1,
        active_camera_workers: state.telemetry.active_camera_workers.load(std::sync::atomic::Ordering::Relaxed),
        gallery_size: state.telemetry.gallery_size.load(std::sync::atomic::Ordering::Relaxed),
        gallery_non_unit_count: state.telemetry.gallery_non_unit_count.load(std::sync::atomic::Ordering::Relaxed),
        gallery_legacy_count: state.telemetry.gallery_legacy_count.load(std::sync::atomic::Ordering::Relaxed),
        web_backend_url: url,
        backend_reachable: state.telemetry.backend_reachable.load(std::sync::atomic::Ordering::Relaxed),
        backend_error: err,
        rss_mb: read_process_rss_mb(),
    })
}

async fn handle_metrics(State(state): State<Arc<AppSharedState>>) -> Json<MetricsResponse> {
    use std::sync::atomic::Ordering::Relaxed;
    Json(MetricsResponse {
        engine: "rust",
        pipeline_version: state.config.pipeline_version.clone(),
        rss_mb: read_process_rss_mb(),
        active_camera_workers: state.telemetry.active_camera_workers.load(Relaxed),
        gallery_size: state.telemetry.gallery_size.load(Relaxed),
        frames_processed: state.telemetry.frames_processed.load(Relaxed),
        frames_dropped: state.telemetry.frames_dropped.load(Relaxed),
        snapshots_enqueued: state.telemetry.snapshots_enqueued.load(Relaxed),
        snapshots_dropped: state.telemetry.snapshots_dropped.load(Relaxed),
        detect: state.telemetry.detect.lock().expect("lock").snapshot(),
        embed: state.telemetry.embed.lock().expect("lock").snapshot(),
        match5000: state.telemetry.match5000.lock().expect("lock").snapshot(),
        pipeline: state.telemetry.pipeline.lock().expect("lock").snapshot(),
    })
}

async fn handle_enroll(
    State(state): State<Arc<AppSharedState>>,
    Json(req): Json<EnrollRequest>,
) -> Result<Json<EnrollResponse>, (StatusCode, Json<ErrorBody>)> {
    let (rgb, w, h) = decode_image_data_url(&req.photo_data_url)
        .map_err(|e| (StatusCode::BAD_REQUEST, Json(ErrorBody { detail: e })))?;

    let cfg = state.thresholds.read().expect("rwlock").clone();
    let inf_arc = Arc::clone(&state.inference);
    let result = tokio::task::spawn_blocking(move || {
        let mut inf = inf_arc.lock().expect("inference mutex");
        inf.embed_best_face(&rgb, w, h, &cfg)
    })
    .await
    .map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorBody {
                detail: format!("inference task panic: {e}"),
            }),
        )
    })?;

    let (confidence, face_size_px, quality_score, embedding) =
        result.map_err(|(code, msg)| (code, Json(ErrorBody { detail: msg })))?;

    Ok(Json(EnrollResponse {
        ok: true,
        confidence,
        face_size_px,
        quality_score,
        embedding,
        pipeline_version: state.config.pipeline_version.clone(),
        model_sha256: state.model_sha256.clone(),
    }))
}

async fn handle_compare(
    State(state): State<Arc<AppSharedState>>,
    Json(req): Json<CompareRequest>,
) -> Result<Json<CompareResponse>, (StatusCode, Json<ErrorBody>)> {
    let img1 = decode_image_data_url(&req.photo1_data_url)
        .map_err(|e| (StatusCode::BAD_REQUEST, Json(ErrorBody { detail: e })))?;
    let img2 = decode_image_data_url(&req.photo2_data_url)
        .map_err(|e| (StatusCode::BAD_REQUEST, Json(ErrorBody { detail: e })))?;

    let cfg = state.thresholds.read().expect("rwlock").clone();
    let inf_arc = Arc::clone(&state.inference);
    let res = tokio::task::spawn_blocking(move || {
        let mut inf = inf_arc.lock().expect("inference mutex");
        let (_, _, _, e1) = inf.embed_best_face(&img1.0, img1.1, img1.2, &cfg)?;
        let (_, _, _, e2) = inf.embed_best_face(&img2.0, img2.1, img2.2, &cfg)?;
        Ok::<_, (StatusCode, String)>((e1, e2, cfg.threshold_recognition))
    })
    .await
    .map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorBody {
                detail: format!("compare task panic: {e}"),
            }),
        )
    })?;

    let (e1, e2, thresh) = res.map_err(|(code, msg)| (code, Json(ErrorBody { detail: msg })))?;
    let sim = ((cosine_similarity(&e1, &e2) * 10_000.0).round()) / 10_000.0;
    let is_match = sim >= thresh;
    Ok(Json(CompareResponse {
        similarity: sim,
        threshold: thresh,
        is_match,
        status: if is_match {
            "COCOK (IDENTITAS SAMA)"
        } else {
            "TIDAK COCOK (BERBEDA)"
        },
    }))
}

async fn handle_reload(
    State(state): State<Arc<AppSharedState>>,
    req: Option<Json<ReloadCamerasRequest>>,
) -> Json<ReloadCamerasResponse> {
    if let Some(Json(body)) = req {
        if let Some(raw_url) = body.web_backend_url {
            if let Some(clean) = crate::rtsp::validate_loopback_backend_url(&raw_url) {
                *state.telemetry.web_backend_url.lock().expect("lock") = clean;
            }
        }
    }
    state.reload_notify.notify_one();
    let url = state.telemetry.web_backend_url.lock().expect("lock").clone();
    let err = state.telemetry.backend_error.lock().expect("lock").clone();
    Json(ReloadCamerasResponse {
        ok: true,
        active_camera_workers: state.telemetry.active_camera_workers.load(std::sync::atomic::Ordering::Relaxed),
        gallery_size: state.telemetry.gallery_size.load(std::sync::atomic::Ordering::Relaxed),
        web_backend_url: url,
        backend_reachable: state.telemetry.backend_reachable.load(std::sync::atomic::Ordering::Relaxed),
        backend_error: err,
    })
}
