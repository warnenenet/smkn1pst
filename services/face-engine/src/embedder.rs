use ort::session::{builder::GraphOptimizationLevel, Session};
use ort::value::TensorRef;
use std::path::Path;
use std::sync::OnceLock;

pub const EMBEDDING_DIM: usize = 512;

static ORT_INIT_RESULT: OnceLock<Result<(), String>> = OnceLock::new();

pub fn init_ort_environment(ort_dylib_path: &Path) -> Result<(), String> {
    let res = ORT_INIT_RESULT.get_or_init(|| {
        ort::init_from(ort_dylib_path.to_string_lossy().as_ref())
            .map_err(|e| format!("ort::init_from({}) failed: {e}", ort_dylib_path.display()))?
            .commit()
            .map(|_| ())
            .map_err(|e| format!("ort env commit({}) failed: {e}", ort_dylib_path.display()))
    });
    res.clone()
}

pub fn l2_norm(v: &[f32]) -> f32 {
    let sum_sq: f64 = v.iter().map(|&x| (x as f64) * (x as f64)).sum();
    sum_sq.sqrt() as f32
}

pub fn l2_normalize(v: &[f32]) -> Vec<f32> {
    let n = l2_norm(v);
    if !n.is_finite() || n <= 1e-12 {
        return vec![0.0; v.len()];
    }
    let inv = 1.0f32 / n;
    v.iter().map(|&x| x * inv).collect()
}

pub fn dot_product(a: &[f32], b: &[f32]) -> f32 {
    if a.len() != b.len() {
        return 0.0;
    }
    let mut acc0 = 0.0f32;
    let mut acc1 = 0.0f32;
    let mut acc2 = 0.0f32;
    let mut acc3 = 0.0f32;
    let chunks_a = a.chunks_exact(4);
    let chunks_b = b.chunks_exact(4);
    let rem_a = chunks_a.remainder();
    let rem_b = chunks_b.remainder();
    for (ca, cb) in chunks_a.zip(chunks_b) {
        acc0 += ca[0] * cb[0];
        acc1 += ca[1] * cb[1];
        acc2 += ca[2] * cb[2];
        acc3 += ca[3] * cb[3];
    }
    let mut sum = (acc0 + acc1) + (acc2 + acc3);
    for (&x, &y) in rem_a.iter().zip(rem_b.iter()) {
        sum += x * y;
    }
    sum
}

pub fn cosine_similarity(a: &[f32], b: &[f32]) -> f32 {
    if a.len() != b.len() || a.is_empty() {
        return 0.0;
    }
    let na = l2_norm(a);
    let nb = l2_norm(b);
    if !na.is_finite() || !nb.is_finite() || na <= 1e-12 || nb <= 1e-12 {
        return 0.0;
    }
    (dot_product(a, b) / (na * nb)).clamp(-1.0, 1.0)
}

pub struct ArcFaceEmbedder {
    session: Session,
}

impl ArcFaceEmbedder {
    pub fn load(model_path: &Path, intra_threads: usize) -> Result<Self, String> {
        let session = Session::builder()
            .map_err(|e| format!("ort Session::builder failed: {e}"))?
            .with_optimization_level(GraphOptimizationLevel::Level3)
            .map_err(|e| format!("ort opt level failed: {e}"))?
            .with_intra_threads(intra_threads.max(1))
            .map_err(|e| format!("ort with_intra_threads failed: {e}"))?
            .with_inter_threads(1)
            .map_err(|e| format!("ort with_inter_threads failed: {e}"))?
            .with_parallel_execution(false)
            .map_err(|e| format!("ort with_parallel_execution failed: {e}"))?
            .commit_from_file(model_path)
            .map_err(|e| format!("ort commit_from_file({}) failed: {e}", model_path.display()))?;
        Ok(Self { session })
    }

    /// Runs ArcFace w600k_r50 on a single aligned 112x112 RGB24 crop and returns an L2-normalized 512-D embedding.
    pub fn embed_aligned_rgb112(&mut self, rgb112: &[u8]) -> Result<Vec<f32>, String> {
        const SIDE: usize = 112;
        const PLANE: usize = SIDE * SIDE;
        if rgb112.len() != PLANE * 3 {
            return Err(format!(
                "expected 112x112 RGB24 ({} bytes), got {}",
                PLANE * 3,
                rgb112.len()
            ));
        }

        // Matches InsightFace ArcFaceONNX preprocessing: (pixel - 127.5) / 127.5 in RGB order.
        let mut blob = vec![0.0f32; 3 * PLANE];
        let inv_std = 1.0f32 / 127.5f32;
        for (idx, px) in rgb112.chunks_exact(3).enumerate() {
            blob[idx] = (px[0] as f32 - 127.5) * inv_std;
            blob[PLANE + idx] = (px[1] as f32 - 127.5) * inv_std;
            blob[2 * PLANE + idx] = (px[2] as f32 - 127.5) * inv_std;
        }

        let input = TensorRef::from_array_view(([1usize, 3, SIDE, SIDE], blob.as_slice()))
            .map_err(|e| format!("arcface TensorRef failed: {e}"))?;
        let outputs = self
            .session
            .run(ort::inputs![input])
            .map_err(|e| format!("arcface session.run failed: {e}"))?;
        if outputs.is_empty() {
            return Err("arcface model returned 0 outputs".to_string());
        }
        let (_shape, raw) = outputs[0]
            .try_extract_tensor::<f32>()
            .map_err(|e| format!("arcface extract output failed: {e}"))?;
        if raw.len() != EMBEDDING_DIM {
            return Err(format!(
                "expected {EMBEDDING_DIM}-D ArcFace output, got {}",
                raw.len()
            ));
        }

        let norm = l2_norm(raw);
        if !norm.is_finite() || norm <= 1e-12 {
            return Err("arcface produced near-zero embedding".to_string());
        }
        Ok(l2_normalize(raw))
    }
}
