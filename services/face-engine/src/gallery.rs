use crate::embedder::{dot_product, l2_norm, l2_normalize, EMBEDDING_DIM};

#[derive(Debug, Clone)]
pub struct GalleryEntry {
    pub student_id: i64,
    pub embedding: Vec<f32>,
    pub is_legacy: bool,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Top2Match {
    pub best_id: Option<i64>,
    pub best_score: f32,
    pub second_id: Option<i64>,
    pub second_score: f32,
    pub margin: f32,
}

#[derive(Debug, Clone, Default)]
pub struct GalleryIndex {
    student_ids: Vec<i64>,
    /// Contiguous row-major packed [N x 512] L2-normalized vectors for cache-friendly batch dot products.
    packed_unit_vectors: Vec<f32>,
    non_unit_count: usize,
    legacy_count: usize,
}

impl GalleryIndex {
    pub fn from_entries(entries: Vec<GalleryEntry>) -> Self {
        let mut student_ids = Vec::with_capacity(entries.len());
        let mut packed_unit_vectors = Vec::with_capacity(entries.len() * EMBEDDING_DIM);
        let mut non_unit_count = 0usize;
        let mut legacy_count = 0usize;

        for entry in entries {
            if entry.embedding.len() != EMBEDDING_DIM {
                continue;
            }
            let norm = l2_norm(&entry.embedding);
            if !norm.is_finite() || norm <= 1e-12 {
                continue;
            }
            if (norm - 1.0).abs() > 1e-3 {
                non_unit_count += 1;
            }
            if entry.is_legacy {
                legacy_count += 1;
            }
            let normed = if (norm - 1.0).abs() <= 1e-5 {
                entry.embedding
            } else {
                l2_normalize(&entry.embedding)
            };
            student_ids.push(entry.student_id);
            packed_unit_vectors.extend_from_slice(&normed);
        }

        Self {
            student_ids,
            packed_unit_vectors,
            non_unit_count,
            legacy_count,
        }
    }

    pub fn len(&self) -> usize {
        self.student_ids.len()
    }

    pub fn is_empty(&self) -> bool {
        self.student_ids.is_empty()
    }

    pub fn non_unit_count(&self) -> usize {
        self.non_unit_count
    }

    pub fn legacy_count(&self) -> usize {
        self.legacy_count
    }

    pub fn top2(&self, query_emb: &[f32]) -> Top2Match {
        if self.student_ids.is_empty() || query_emb.len() != EMBEDDING_DIM {
            return Top2Match {
                best_id: None,
                best_score: 0.0,
                second_id: None,
                second_score: 0.0,
                margin: 0.0,
            };
        }

        let q_norm = l2_norm(query_emb);
        if !q_norm.is_finite() || q_norm <= 1e-12 {
            return Top2Match {
                best_id: None,
                best_score: 0.0,
                second_id: None,
                second_score: 0.0,
                margin: 0.0,
            };
        }
        let q_owned;
        let q = if (q_norm - 1.0).abs() <= 1e-5 {
            query_emb
        } else {
            q_owned = l2_normalize(query_emb);
            &q_owned
        };

        let mut best_id: Option<i64> = None;
        let mut best_score = f32::NEG_INFINITY;
        let mut second_id: Option<i64> = None;
        let mut second_score = f32::NEG_INFINITY;

        for (idx, &student_id) in self.student_ids.iter().enumerate() {
            let offset = idx * EMBEDDING_DIM;
            let row = &self.packed_unit_vectors[offset..offset + EMBEDDING_DIM];
            let score = dot_product(q, row).clamp(-1.0, 1.0);
            if score > best_score {
                second_score = best_score;
                second_id = best_id;
                best_score = score;
                best_id = Some(student_id);
            } else if score > second_score {
                second_score = score;
                second_id = Some(student_id);
            }
        }

        let clean_best = if best_score.is_finite() { best_score } else { 0.0 };
        let clean_second = if second_score.is_finite() { second_score } else { 0.0 };
        let margin = if second_id.is_some() {
            (clean_best - clean_second).max(0.0)
        } else {
            clean_best.max(0.0)
        };

        Top2Match {
            best_id,
            best_score: clean_best,
            second_id,
            second_score: clean_second,
            margin,
        }
    }
}
