use crate::config::ThresholdsConfig;
use crate::gallery::{GalleryIndex, Top2Match};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum MatchOutcome {
    Matched { student_id: i64 },
    RejectedEmptyGallery,
    RejectedQualityGate,
    RejectedBelowThreshold,
    RejectedAmbiguousMargin,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct MatchEvaluation {
    pub outcome: MatchOutcome,
    pub threshold_used: Option<f32>,
    pub best_candidate_id: Option<i64>,
    pub best_score: f32,
    pub second_candidate_id: Option<i64>,
    pub second_score: f32,
    pub margin: f32,
}

/// Computes the active similarity threshold based on aligned face quality score.
/// Returns `None` if snapshot quality is below `cfg.min_snapshot_quality`.
pub fn resolve_effective_threshold(quality_score: f32, cfg: &ThresholdsConfig) -> Option<f32> {
    if !quality_score.is_finite() || quality_score < cfg.min_snapshot_quality {
        return None;
    }
    if !cfg.adaptive_threshold_enabled {
        return Some(cfg.threshold_recognition);
    }
    if quality_score >= 0.85 {
        Some(cfg.threshold_high_quality)
    } else {
        Some(cfg.threshold_mid_quality)
    }
}

pub fn evaluate_gallery_match(
    gallery: &GalleryIndex,
    query_emb: &[f32],
    quality_score: f32,
    cfg: &ThresholdsConfig,
) -> MatchEvaluation {
    let Some(threshold_used) = resolve_effective_threshold(quality_score, cfg) else {
        return MatchEvaluation {
            outcome: MatchOutcome::RejectedQualityGate,
            threshold_used: None,
            best_candidate_id: None,
            best_score: 0.0,
            second_candidate_id: None,
            second_score: 0.0,
            margin: 0.0,
        };
    };

    if gallery.is_empty() {
        return MatchEvaluation {
            outcome: MatchOutcome::RejectedEmptyGallery,
            threshold_used: Some(threshold_used),
            best_candidate_id: None,
            best_score: 0.0,
            second_candidate_id: None,
            second_score: 0.0,
            margin: 0.0,
        };
    }

    let Top2Match {
        best_id,
        best_score,
        second_id,
        second_score,
        margin,
    } = gallery.top2(query_emb);

    let Some(candidate_id) = best_id else {
        return MatchEvaluation {
            outcome: MatchOutcome::RejectedBelowThreshold,
            threshold_used: Some(threshold_used),
            best_candidate_id: None,
            best_score: 0.0,
            second_candidate_id: None,
            second_score: 0.0,
            margin: 0.0,
        };
    };

    if best_score < threshold_used {
        return MatchEvaluation {
            outcome: MatchOutcome::RejectedBelowThreshold,
            threshold_used: Some(threshold_used),
            best_candidate_id: Some(candidate_id),
            best_score,
            second_candidate_id: second_id,
            second_score,
            margin,
        };
    }

    // Margin check enforces clear separation between #1 and #2 when gallery has >= 2 students.
    if gallery.len() >= 2 && second_id.is_some() && margin < cfg.match_margin_min {
        return MatchEvaluation {
            outcome: MatchOutcome::RejectedAmbiguousMargin,
            threshold_used: Some(threshold_used),
            best_candidate_id: Some(candidate_id),
            best_score,
            second_candidate_id: second_id,
            second_score,
            margin,
        };
    }

    MatchEvaluation {
        outcome: MatchOutcome::Matched {
            student_id: candidate_id,
        },
        threshold_used: Some(threshold_used),
        best_candidate_id: Some(candidate_id),
        best_score,
        second_candidate_id: second_id,
        second_score,
        margin,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum VoteOutcome {
    Confirmed,
    AwaitingSecondVote,
    RejectedAnonymous,
    RejectedBelowVoteThreshold,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct VoteDecision {
    pub outcome: VoteOutcome,
    pub should_dispatch: bool,
    pub student_id: Option<i64>,
    pub vote_count: usize,
}

#[derive(Debug, Clone, Copy)]
struct VoteRecord {
    ts_ms: u64,
    student_id: i64,
    _similarity: f32,
}

#[derive(Debug, Default)]
pub struct TrackVoteBuffer {
    by_track: HashMap<u64, Vec<VoteRecord>>,
}

impl TrackVoteBuffer {
    #[allow(clippy::too_many_arguments)]
    pub fn record_and_evaluate(
        &mut self,
        track_id: u64,
        student_id: Option<i64>,
        similarity: f32,
        now_ms: u64,
        vote_threshold: f32,
        vote_window_sec: u64,
        min_votes: usize,
    ) -> VoteDecision {
        let window_ms = vote_window_sec.max(1) * 1000;
        let needed = min_votes.max(1);

        let mut active = self
            .by_track
            .remove(&track_id)
            .unwrap_or_default()
            .into_iter()
            .filter(|v| now_ms.saturating_sub(v.ts_ms) <= window_ms)
            .collect::<Vec<_>>();

        let Some(sid) = student_id else {
            if !active.is_empty() {
                self.by_track.insert(track_id, active);
            }
            return VoteDecision {
                outcome: VoteOutcome::RejectedAnonymous,
                should_dispatch: false,
                student_id: None,
                vote_count: 0,
            };
        };

        if !similarity.is_finite() || similarity < vote_threshold {
            if !active.is_empty() {
                self.by_track.insert(track_id, active);
            }
            return VoteDecision {
                outcome: VoteOutcome::RejectedBelowVoteThreshold,
                should_dispatch: false,
                student_id: Some(sid),
                vote_count: 0,
            };
        }

        active.push(VoteRecord {
            ts_ms: now_ms,
            student_id: sid,
            _similarity: similarity,
        });

        let same_count = active.iter().filter(|v| v.student_id == sid).count();
        if same_count >= needed {
            // Buffer cleared upon confirmation so subsequent dispatches require fresh consensus.
            return VoteDecision {
                outcome: VoteOutcome::Confirmed,
                should_dispatch: true,
                student_id: Some(sid),
                vote_count: same_count,
            };
        }

        self.by_track.insert(track_id, active);
        VoteDecision {
            outcome: VoteOutcome::AwaitingSecondVote,
            should_dispatch: false,
            student_id: Some(sid),
            vote_count: same_count,
        }
    }

    pub fn clear_expired(&mut self, now_ms: u64, vote_window_sec: u64) {
        let window_ms = vote_window_sec.max(1) * 1000;
        self.by_track.retain(|_, list| {
            list.retain(|v| now_ms.saturating_sub(v.ts_ms) <= window_ms);
            !list.is_empty()
        });
    }
}
