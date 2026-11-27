use face_engine::clustering::{
    assign_incremental_centroid, cluster_embeddings_hdbscan, AnonymousCentroid,
};
use face_engine::embedder::{cosine_similarity, l2_norm, l2_normalize};

fn perturbed_basis_vec(basis_dim: usize, delta_dim: usize, delta: f32) -> Vec<f32> {
    let mut v = vec![0.0f32; 512];
    v[basis_dim] = 1.0;
    v[delta_dim] = delta;
    l2_normalize(&v)
}

#[test]
fn hdbscan_groups_two_tight_clusters_and_marks_outlier_as_noise() {
    let mut vectors = Vec::new();
    // Cluster A near dim 0 (6 samples)
    for i in 0..6 {
        vectors.push(perturbed_basis_vec(0, 1 + i, 0.02 * (i as f32 + 1.0)));
    }
    // Cluster B near dim 50 (6 samples)
    for i in 0..6 {
        vectors.push(perturbed_basis_vec(50, 51 + i, 0.02 * (i as f32 + 1.0)));
    }
    // Noise outlier far away near dim 200
    vectors.push(perturbed_basis_vec(200, 201, 0.01));

    let res = cluster_embeddings_hdbscan(&vectors, 3, 2).expect("HDBSCAN clustering should succeed");
    assert_eq!(res.labels.len(), vectors.len());

    // First 6 share one positive cluster label
    let label_a = res.labels[0];
    assert!(label_a >= 0, "expected cluster A >= 0, got {label_a}");
    for idx in 0..6 {
        assert_eq!(res.labels[idx], label_a);
    }

    // Next 6 share a distinct positive cluster label
    let label_b = res.labels[6];
    assert!(label_b >= 0 && label_b != label_a, "expected distinct cluster B, got {label_b}");
    for idx in 6..12 {
        assert_eq!(res.labels[idx], label_b);
    }

    // Outlier marked as noise (-1)
    assert_eq!(res.labels[12], -1);
    assert_eq!(res.centroids.len(), 2);
    for c in &res.centroids {
        assert!((l2_norm(&c.centroid) - 1.0).abs() < 1e-4);
    }
    assert!(cosine_similarity(&res.centroids[0].centroid, &res.centroids[1].centroid).abs() < 0.2);
}

#[test]
fn incremental_centroid_assigner_matches_closest_above_threshold_or_none() {
    let c1 = AnonymousCentroid {
        cluster_id: 11,
        centroid: perturbed_basis_vec(0, 1, 0.0),
    };
    let c2 = AnonymousCentroid {
        cluster_id: 22,
        centroid: perturbed_basis_vec(100, 101, 0.0),
    };
    let centroids = vec![c1, c2];

    let near_c2 = perturbed_basis_vec(100, 102, 0.05);
    let m = assign_incremental_centroid(&near_c2, &centroids, 0.70);
    assert_eq!(m.map(|(id, _)| id), Some(22));

    let novel = perturbed_basis_vec(300, 301, 0.0);
    assert!(assign_incremental_centroid(&novel, &centroids, 0.70).is_none());
}
