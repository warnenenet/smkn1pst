use face_engine::config::ThresholdsConfig;
use face_engine::embedder::{cosine_similarity, l2_norm, l2_normalize};
use face_engine::gallery::{GalleryEntry, GalleryIndex};
use face_engine::matching::{
    evaluate_gallery_match, resolve_effective_threshold, MatchOutcome, TrackVoteBuffer, VoteOutcome,
};

fn pseudo_unit_vec(seed: u64) -> Vec<f32> {
    let mut raw = vec![0.0f32; 512];
    let mut x = seed ^ 0x9E37_79B9_7F4A_7C15;
    for slot in &mut raw {
        x = x.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        let u = ((x >> 32) as u32) as f32 / (u32::MAX as f32);
        *slot = u * 2.0 - 1.0;
    }
    l2_normalize(&raw)
}

#[test]
fn batch_cosine_5000x512_matches_naive_within_1e5() {
    let mut entries = Vec::with_capacity(5000);
    for i in 1..=5000i64 {
        entries.push(GalleryEntry {
            student_id: i,
            embedding: pseudo_unit_vec(i as u64),
            is_legacy: false,
        });
    }
    let idx = GalleryIndex::from_entries(entries);
    assert_eq!(idx.len(), 5000);
    assert_eq!(idx.non_unit_count(), 0);

    // Query near entry #3421 with tiny perturbation
    let mut probe = pseudo_unit_vec(3421);
    probe[0] += 0.05;
    let probe = l2_normalize(&probe);

    let top = idx.top2(&probe);
    assert_eq!(top.best_id, Some(3421));

    // Naive verification across all 5000 vectors
    let mut naive_best = -1.0f32;
    let mut naive_second = -1.0f32;
    for i in 1..=5000i64 {
        let v = pseudo_unit_vec(i as u64);
        let s = cosine_similarity(&probe, &v);
        if s > naive_best {
            naive_second = naive_best;
            naive_best = s;
        } else if s > naive_second {
            naive_second = s;
        }
    }
    assert!((top.best_score - naive_best).abs() < 1e-5);
    assert!((top.second_score - naive_second).abs() < 1e-5);
}

#[test]
fn margin_check_covers_all_4_cases() {
    let mut cfg = ThresholdsConfig::conservative_defaults();
    cfg.adaptive_threshold_enabled = false;
    cfg.threshold_recognition = 0.70;
    cfg.match_margin_min = 0.08;

    let mut base = vec![0.0f32; 512];
    base[0] = 1.0;

    // Helper vector having exact dot = target_cos with base = [1, 0, ...]
    let vec_with_cos = |cos: f32, ortho_dim: usize| -> Vec<f32> {
        let mut v = vec![0.0f32; 512];
        v[0] = cos;
        v[ortho_dim] = (1.0 - cos * cos).max(0.0).sqrt();
        v
    };

    // Case 1: top1 >= 0.70 AND margin (0.88 - 0.72 = 0.16 >= 0.08) -> Matched
    let g1 = GalleryIndex::from_entries(vec![
        GalleryEntry { student_id: 1, embedding: vec_with_cos(0.88, 1), is_legacy: false },
        GalleryEntry { student_id: 2, embedding: vec_with_cos(0.72, 2), is_legacy: false },
    ]);
    let res1 = evaluate_gallery_match(&g1, &base, 0.90, &cfg);
    assert_eq!(res1.outcome, MatchOutcome::Matched { student_id: 1 });

    // Case 2: top1 >= 0.70 BUT ambiguous margin (0.85 - 0.80 = 0.05 < 0.08) -> RejectedAmbiguousMargin
    let g2 = GalleryIndex::from_entries(vec![
        GalleryEntry { student_id: 1, embedding: vec_with_cos(0.85, 1), is_legacy: false },
        GalleryEntry { student_id: 2, embedding: vec_with_cos(0.80, 2), is_legacy: false },
    ]);
    let res2 = evaluate_gallery_match(&g2, &base, 0.90, &cfg);
    assert_eq!(res2.outcome, MatchOutcome::RejectedAmbiguousMargin);

    // Case 3: top1 < 0.70 -> RejectedBelowThreshold
    let g3 = GalleryIndex::from_entries(vec![
        GalleryEntry { student_id: 1, embedding: vec_with_cos(0.62, 1), is_legacy: false },
        GalleryEntry { student_id: 2, embedding: vec_with_cos(0.40, 2), is_legacy: false },
    ]);
    let res3 = evaluate_gallery_match(&g3, &base, 0.90, &cfg);
    assert_eq!(res3.outcome, MatchOutcome::RejectedBelowThreshold);

    // Case 4: single-entry gallery -> margin skipped, Matched if >= threshold
    let g4 = GalleryIndex::from_entries(vec![
        GalleryEntry { student_id: 99, embedding: vec_with_cos(0.82, 1), is_legacy: false },
    ]);
    let res4 = evaluate_gallery_match(&g4, &base, 0.90, &cfg);
    assert_eq!(res4.outcome, MatchOutcome::Matched { student_id: 99 });
}

#[test]
fn multi_frame_voting_confirms_on_second_consistent_vote_within_window() {
    let mut votes = TrackVoteBuffer::default();
    let d1 = votes.record_and_evaluate(10, Some(42), 0.78, 1_000, 0.65, 10, 2);
    assert_eq!(d1.outcome, VoteOutcome::AwaitingSecondVote);
    assert!(!d1.should_dispatch);

    let d2 = votes.record_and_evaluate(10, Some(42), 0.81, 3_500, 0.65, 10, 2);
    assert_eq!(d2.outcome, VoteOutcome::Confirmed);
    assert!(d2.should_dispatch);
    assert_eq!(d2.student_id, Some(42));

    // After confirmation, track vote buffer clears -> next single hit awaits again
    let d3 = votes.record_and_evaluate(10, Some(42), 0.80, 4_000, 0.65, 10, 2);
    assert_eq!(d3.outcome, VoteOutcome::AwaitingSecondVote);

    // Expired first vote outside 10s window does not confirm immediately
    let d4 = votes.record_and_evaluate(10, Some(42), 0.82, 20_000, 0.65, 10, 2);
    assert_eq!(d4.outcome, VoteOutcome::AwaitingSecondVote);
}

#[test]
fn gallery_detects_non_unit_vectors_and_adaptive_threshold_checks_quality() {
    let unnorm = vec![2.0f32; 512];
    assert!(l2_norm(&unnorm) > 10.0);
    let idx = GalleryIndex::from_entries(vec![GalleryEntry {
        student_id: 1,
        embedding: unnorm,
        is_legacy: true,
    }]);
    assert_eq!(idx.non_unit_count(), 1);
    assert_eq!(idx.legacy_count(), 1);

    let cfg = ThresholdsConfig::conservative_defaults();
    assert!(resolve_effective_threshold(0.60, &cfg).is_none());
    assert!(resolve_effective_threshold(0.86, &cfg).is_some());
}
