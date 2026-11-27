use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::{Path, PathBuf};

pub const PIPELINE_VERSION: &str = "rust-scrfd-arcface-b1";
pub const MAX_RTSP_WORKERS_HARD_CAP: usize = 8;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ThresholdsConfig {
    pub threshold_confidence: f32,
    pub threshold_recognition: f32,
    pub threshold_clustering: f32,
    pub match_margin_min: f32,
    pub vote_threshold: f32,
    pub vote_window_sec: u64,
    pub vote_min_count: usize,
    pub adaptive_threshold_enabled: bool,
    pub threshold_high_quality: f32,
    pub threshold_mid_quality: f32,
    pub track_min_face_px: u32,
    pub embed_min_face_px: u32,
    pub max_face_size_px: u32,
    pub blur_threshold: f64,
    pub max_yaw_deg: f32,
    pub max_pitch_deg: f32,
    pub dedup_cooldown_sec: u64,
    pub min_snapshot_quality: f32,
    pub capture_max_width: u32,
    pub capture_jpeg_quality: u8,
    pub debug_detection: bool,
    pub weight_confidence: f32,
    pub weight_size: f32,
    pub weight_sharpness: f32,
    pub weight_frontal: f32,
}

impl ThresholdsConfig {
    /// Conservative baseline defaults (uncalibrated — marked BELUM TERKALIBRASI until VPS evaluation).
    pub fn conservative_defaults() -> Self {
        Self {
            threshold_confidence: 0.60,
            threshold_recognition: 0.70,
            threshold_clustering: 0.70,
            match_margin_min: 0.08,
            vote_threshold: 0.65,
            vote_window_sec: 10,
            vote_min_count: 2,
            adaptive_threshold_enabled: true,
            threshold_high_quality: 0.60,
            threshold_mid_quality: 0.75,
            track_min_face_px: 40,
            embed_min_face_px: 80,
            max_face_size_px: 0,
            blur_threshold: 100.0,
            max_yaw_deg: 30.0,
            max_pitch_deg: 30.0,
            dedup_cooldown_sec: 6,
            min_snapshot_quality: 0.70,
            capture_max_width: 1280,
            capture_jpeg_quality: 86,
            debug_detection: false,
            weight_confidence: 0.30,
            weight_size: 0.25,
            weight_sharpness: 0.25,
            weight_frontal: 0.20,
        }
    }

    /// Hydrates thresholds from SQLite `settings` / `/api/internal/gallery` JSON without resetting unspecified fields.
    pub fn from_settings_json(v: &Value) -> Self {
        let mut cfg = Self::conservative_defaults();
        let Some(obj) = v.as_object() else {
            return cfg;
        };

        let get_f32 = |key: &str, min: f32, max: f32, fallback: f32| -> f32 {
            obj.get(key)
                .and_then(|x| x.as_f64())
                .map(|x| (x as f32).clamp(min, max))
                .unwrap_or(fallback)
        };
        let get_u64 = |key: &str, min: u64, max: u64, fallback: u64| -> u64 {
            obj.get(key)
                .and_then(|x| x.as_u64().or_else(|| x.as_f64().map(|f| f.max(0.0) as u64)))
                .map(|x| x.clamp(min, max))
                .unwrap_or(fallback)
        };

        cfg.threshold_confidence = get_f32("threshold_confidence", 0.30, 0.99, cfg.threshold_confidence);
        cfg.threshold_recognition = get_f32("threshold_recognition", 0.40, 0.99, cfg.threshold_recognition);
        cfg.threshold_clustering = get_f32("threshold_clustering", 0.40, 0.99, cfg.threshold_clustering);
        cfg.match_margin_min = get_f32("match_margin_min", 0.0, 0.50, cfg.match_margin_min);
        cfg.vote_threshold = get_f32("vote_threshold", 0.30, 0.95, cfg.vote_threshold);
        cfg.vote_window_sec = get_u64("vote_window_sec", 2, 60, cfg.vote_window_sec);
        cfg.vote_min_count = get_u64("vote_min_count", 1, 10, cfg.vote_min_count as u64) as usize;
        if let Some(b) = obj.get("adaptive_threshold_enabled").and_then(|x| x.as_bool()) {
            cfg.adaptive_threshold_enabled = b;
        }
        cfg.threshold_high_quality = get_f32("threshold_high_quality", 0.40, 0.95, cfg.threshold_high_quality);
        cfg.threshold_mid_quality = get_f32("threshold_mid_quality", 0.40, 0.99, cfg.threshold_mid_quality);

        // Support both `embed_min_face_px` and explicit >=80 `min_face_size` overrides from settings
        if obj.contains_key("embed_min_face_px") {
            cfg.embed_min_face_px = get_u64("embed_min_face_px", 32, 600, cfg.embed_min_face_px as u64) as u32;
        } else if let Some(min_face) = obj.get("min_face_size").and_then(|x| x.as_u64()) {
            if min_face >= 60 {
                cfg.embed_min_face_px = (min_face as u32).clamp(32, 600);
            }
        }
        cfg.track_min_face_px = get_u64("track_min_face_px", 24, cfg.embed_min_face_px as u64, cfg.track_min_face_px as u64) as u32;
        cfg.max_face_size_px = get_u64("max_face_size", 0, 2000, cfg.max_face_size_px as u64) as u32;
        cfg.blur_threshold = obj
            .get("blur_threshold")
            .and_then(|x| x.as_f64())
            .map(|x| x.clamp(5.0, 5000.0))
            .unwrap_or(cfg.blur_threshold);
        cfg.max_yaw_deg = get_f32("max_yaw_deg", 5.0, 65.0, cfg.max_yaw_deg);
        cfg.max_pitch_deg = get_f32("max_pitch_deg", 5.0, 65.0, cfg.max_pitch_deg);
        cfg.dedup_cooldown_sec = get_u64("dedup_cooldown_sec", 1, 120, cfg.dedup_cooldown_sec);
        cfg.min_snapshot_quality = get_f32("min_snapshot_quality", 0.30, 0.99, cfg.min_snapshot_quality);
        cfg.capture_max_width = get_u64("capture_max_width", 320, 3840, cfg.capture_max_width as u64) as u32;
        cfg.capture_jpeg_quality = get_u64("capture_jpeg_quality", 50, 95, cfg.capture_jpeg_quality as u64) as u8;
        if let Some(d) = obj.get("debug_detection").and_then(|x| x.as_bool()) {
            cfg.debug_detection = d;
        }
        cfg.weight_confidence = get_f32("weight_confidence", 0.0, 1.0, cfg.weight_confidence);
        cfg.weight_size = get_f32("weight_size", 0.0, 1.0, cfg.weight_size);
        cfg.weight_sharpness = get_f32("weight_sharpness", 0.0, 1.0, cfg.weight_sharpness);
        cfg.weight_frontal = get_f32("weight_frontal", 0.0, 1.0, cfg.weight_frontal);
        cfg
    }
}

#[derive(Debug, Clone)]
pub struct EngineConfig {
    pub listen_addr: String,
    pub web_backend_url: String,
    pub data_dir: PathBuf,
    pub sqlite_path: PathBuf,
    pub snapshots_dir: PathBuf,
    pub debug_tmp_dir: PathBuf,
    pub internal_token_file: PathBuf,
    pub det_model_path: PathBuf,
    pub rec_model_path: PathBuf,
    pub ort_dylib_path: PathBuf,
    pub expected_det_sha256: Option<String>,
    pub expected_rec_sha256: Option<String>,
    pub expected_ort_sha256: Option<String>,
    pub ort_intra_threads: usize,
    pub max_camera_workers: usize,
    pub detector_input_size: usize,
    pub process_every_n_frames: u64,
    pub snapshot_max_bytes_per_sec: usize,
    pub debug_png_interval_sec: u64,
    pub pipeline_version: String,
    pub thresholds: ThresholdsConfig,
}

impl EngineConfig {
    pub fn conservative_defaults(base_dir: PathBuf) -> Self {
        let data_dir = base_dir.join("data");
        let models_dir = base_dir.join("models/insightface/models/buffalo_l");
        Self {
            listen_addr: "127.0.0.1:8001".to_string(),
            web_backend_url: "http://127.0.0.1:3001".to_string(),
            sqlite_path: data_dir.join("absensi.sqlite"),
            snapshots_dir: data_dir.join("snapshots"),
            data_dir,
            debug_tmp_dir: PathBuf::from("/tmp/face-engine-debug"),
            internal_token_file: base_dir.join("storage/secrets/internal_token"),
            det_model_path: models_dir.join("det_10g.onnx"),
            rec_model_path: models_dir.join("w600k_r50.onnx"),
            ort_dylib_path: PathBuf::from("/usr/local/lib/libonnxruntime.so"),
            expected_det_sha256: None,
            expected_rec_sha256: None,
            expected_ort_sha256: None,
            ort_intra_threads: 2,
            max_camera_workers: MAX_RTSP_WORKERS_HARD_CAP,
            detector_input_size: 640,
            process_every_n_frames: 2,
            snapshot_max_bytes_per_sec: 700 * 1024, // < 1 MB/s budget
            debug_png_interval_sec: 30,
            pipeline_version: PIPELINE_VERSION.to_string(),
            thresholds: ThresholdsConfig::conservative_defaults(),
        }
    }

    pub fn from_env() -> Self {
        let app_root = std::env::var("APP_ROOT")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from("/app"));
        let mut cfg = Self::conservative_defaults(app_root.clone());

        let face_port = std::env::var("FACE_PORT")
            .ok()
            .and_then(|s| s.parse::<u16>().ok())
            .unwrap_or(8001);
        cfg.listen_addr = format!("127.0.0.1:{face_port}");

        if let Ok(url) = std::env::var("WEB_BACKEND_URL") {
            if !url.trim().is_empty() {
                cfg.web_backend_url = url.trim().trim_end_matches('/').to_string();
            }
        } else if let Ok(p) = std::env::var("PORT") {
            if !p.trim().is_empty() {
                cfg.web_backend_url = format!("http://127.0.0.1:{}", p.trim());
            }
        }

        if let Ok(d) = std::env::var("DATA_DIR") {
            if !d.trim().is_empty() {
                cfg.data_dir = PathBuf::from(d);
                cfg.sqlite_path = cfg.data_dir.join("absensi.sqlite");
                cfg.snapshots_dir = cfg.data_dir.join("snapshots");
            }
        }
        if let Ok(s) = std::env::var("SQLITE_PATH") {
            if !s.trim().is_empty() {
                cfg.sqlite_path = PathBuf::from(s);
            }
        }
        if let Ok(d) = std::env::var("DEBUG_TMP_DIR") {
            if !d.trim().is_empty() {
                cfg.debug_tmp_dir = PathBuf::from(d);
            }
        }
        if let Ok(t) = std::env::var("INTERNAL_TOKEN_FILE") {
            if !t.trim().is_empty() {
                cfg.internal_token_file = PathBuf::from(t);
            }
        }
        if let Ok(p) = std::env::var("DET_MODEL_PATH") {
            if !p.trim().is_empty() {
                cfg.det_model_path = PathBuf::from(p);
            }
        } else if let Ok(home) = std::env::var("INSIGHTFACE_HOME") {
            let candidate = Path::new(&home).join("models/buffalo_l/det_10g.onnx");
            cfg.det_model_path = candidate;
        }
        if let Ok(p) = std::env::var("REC_MODEL_PATH") {
            if !p.trim().is_empty() {
                cfg.rec_model_path = PathBuf::from(p);
            }
        } else if let Ok(home) = std::env::var("INSIGHTFACE_HOME") {
            let candidate = Path::new(&home).join("models/buffalo_l/w600k_r50.onnx");
            cfg.rec_model_path = candidate;
        }
        if let Ok(p) = std::env::var("ORT_DYLIB_PATH") {
            if !p.trim().is_empty() {
                cfg.ort_dylib_path = PathBuf::from(p);
            }
        }

        cfg.expected_det_sha256 = non_empty_env("DET_MODEL_SHA256");
        cfg.expected_rec_sha256 = non_empty_env("REC_MODEL_SHA256");
        cfg.expected_ort_sha256 = non_empty_env("ORT_DYLIB_SHA256");

        if let Ok(v) = std::env::var("ORT_INTRA_THREADS") {
            if let Ok(n) = v.parse::<usize>() {
                cfg.ort_intra_threads = n.clamp(1, 8);
            }
        }
        if let Ok(v) = std::env::var("MAX_CAMERA_WORKERS") {
            if let Ok(n) = v.parse::<usize>() {
                cfg.max_camera_workers = n;
            }
        }
        if let Ok(v) = std::env::var("PROCESS_EVERY_N_FRAMES") {
            if let Ok(n) = v.parse::<u64>() {
                cfg.process_every_n_frames = n.clamp(1, 10);
            }
        }

        cfg
    }

    pub fn validate(&self) -> Result<(), String> {
        if self.max_camera_workers == 0 || self.max_camera_workers > MAX_RTSP_WORKERS_HARD_CAP {
            return Err(format!(
                "max_camera_workers={} violates hard cap [1..={MAX_RTSP_WORKERS_HARD_CAP}]",
                self.max_camera_workers
            ));
        }
        if self.ort_intra_threads == 0 {
            return Err("ort_intra_threads must be >= 1".to_string());
        }
        if self.detector_input_size < 128 {
            return Err("detector_input_size must be >= 128".to_string());
        }
        Ok(())
    }
}

fn non_empty_env(name: &str) -> Option<String> {
    std::env::var(name).ok().and_then(|v| {
        let t = v.trim().to_ascii_lowercase();
        if t.is_empty() { None } else { Some(t) }
    })
}
