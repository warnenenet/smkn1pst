use crate::embedder::{cosine_similarity, l2_norm, l2_normalize, EMBEDDING_DIM};
use hdbscan::{Center, DistanceMetric, Hdbscan, HdbscanHyperParams};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClusterCentroid {
    pub cluster_label: i32,
    pub sample_count: usize,
    pub centroid: Vec<f32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HdbscanClusteringResult {
    pub labels: Vec<i32>,
    pub centroids: Vec<ClusterCentroid>,
    pub noise_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnonymousCentroid {
    pub cluster_id: i64,
    pub centroid: Vec<f32>,
}

/// Clusters L2-normalized 512-D embeddings using `hdbscan 0.12.0`.
/// For unit vectors ||a|| = ||b|| = 1, ||a - b||^2 = 2 * (1 - cos(a, b)),
/// so Euclidean HDBSCAN preserves exact monotonic ordering with cosine distance.
pub fn cluster_embeddings_hdbscan(
    embeddings: &[Vec<f32>],
    min_cluster_size: usize,
    min_samples: usize,
) -> Result<HdbscanClusteringResult, String> {
    if embeddings.is_empty() {
        return Ok(HdbscanClusteringResult {
            labels: Vec::new(),
            centroids: Vec::new(),
            noise_count: 0,
        });
    }

    let min_cs = min_cluster_size.max(2);
    let min_sm = min_samples.max(1);
    if embeddings.len() < min_cs {
        return Ok(HdbscanClusteringResult {
            labels: vec![-1; embeddings.len()],
            centroids: Vec::new(),
            noise_count: embeddings.len(),
        });
    }

    let normalized: Vec<Vec<f32>> = embeddings
        .iter()
        .map(|v| {
            if v.len() != EMBEDDING_DIM {
                return Err(format!(
                    "expected {EMBEDDING_DIM}-D embedding for HDBSCAN, got {}",
                    v.len()
                ));
            }
            let n = l2_norm(v);
            if !n.is_finite() || n <= 1e-12 {
                return Err("zero-norm embedding cannot be clustered".to_string());
            }
            Ok(l2_normalize(v))
        })
        .collect::<Result<Vec<_>, String>>()?;

    let params = HdbscanHyperParams::builder()
        .min_cluster_size(min_cs)
        .min_samples(min_sm)
        .dist_metric(DistanceMetric::Euclidean)
        .build();

    let clusterer = Hdbscan::new(&normalized, params);
    let labels = clusterer
        .cluster()
        .map_err(|e| format!("HDBSCAN clustering failed: {e}"))?;

    let noise_count = labels.iter().filter(|&&l| l < 0).count();
    let unique_clusters: Vec<i32> = labels
        .iter()
        .copied()
        .filter(|&l| l >= 0)
        .collect::<BTreeSet<i32>>()
        .into_iter()
        .collect();

    if unique_clusters.is_empty() {
        return Ok(HdbscanClusteringResult {
            labels,
            centroids: Vec::new(),
            noise_count,
        });
    }

    let raw_centers = clusterer
        .calc_centers(Center::Centroid, &labels)
        .map_err(|e| format!("HDBSCAN calc_centers failed: {e}"))?;

    let mut centroids = Vec::with_capacity(unique_clusters.len());
    for (idx, &cluster_label) in unique_clusters.iter().enumerate() {
        let sample_count = labels.iter().filter(|&&l| l == cluster_label).count();
        let center_vec = if let Some(c) = raw_centers.get(idx) {
            l2_normalize(c)
        } else {
            let mut sum = vec![0.0f32; EMBEDDING_DIM];
            for (row_idx, &lbl) in labels.iter().enumerate() {
                if lbl == cluster_label {
                    for d in 0..EMBEDDING_DIM {
                        sum[d] += normalized[row_idx][d];
                    }
                }
            }
            l2_normalize(&sum)
        };
        centroids.push(ClusterCentroid {
            cluster_label,
            sample_count,
            centroid: center_vec,
        });
    }

    Ok(HdbscanClusteringResult {
        labels,
        centroids,
        noise_count,
    })
}

/// Incremental nearest-centroid assignment consistent with live anonymous cluster tracking.
pub fn assign_incremental_centroid(
    query_emb: &[f32],
    centroids: &[AnonymousCentroid],
    threshold_clustering: f32,
) -> Option<(i64, f32)> {
    if query_emb.len() != EMBEDDING_DIM || centroids.is_empty() {
        return None;
    }
    let mut best: Option<(i64, f32)> = None;
    for entry in centroids {
        if entry.centroid.len() != EMBEDDING_DIM {
            continue;
        }
        let sim = cosine_similarity(query_emb, &entry.centroid);
        if sim >= threshold_clustering && best.map(|(_, bs)| sim > bs).unwrap_or(true) {
            best = Some((entry.cluster_id, sim));
        }
    }
    best
}
