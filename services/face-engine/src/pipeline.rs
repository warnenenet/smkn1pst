use crate::align::{estimate_similarity_lmeds, warp_rgb_112, ARCFACE_DST_112};
use crate::config::ThresholdsConfig;
use crate::det_scrfd::DetectedFace;
use crate::gallery::GalleryIndex;
use crate::matching::{evaluate_gallery_match, MatchOutcome, TrackVoteBuffer, VoteOutcome};
use crate::quality_gate::{
    evaluate_aligned_quality_gate, evaluate_pre_alignment_gates, FaceSizeTier, GateRejectReason,
};
use crate::tracker::{DedupCooldownMap, IoUTracker};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CameraRuntimeState {
    pub signature: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum FrameStepDisposition {
    RejectedPreGate(GateRejectReason),
    SkippedTrackOnly,
    AlignFailed,
    RejectedAlignedGate(GateRejectReason),
    EmbedError,
    RejectedQualityThreshold,
    AwaitingSecondVote,
    SuppressedByDedup,
    DispatchedMatched,
    DispatchedAnonymous,
}

#[derive(Debug, Clone)]
pub struct DebugAnnotation {
    pub bbox: [f32; 4],
    pub kps: [[f32; 2]; 5],
    pub passed: bool,
    pub label: String,
}

#[derive(Debug, Clone)]
pub struct DispatchEvent {
    pub camera_id: i64,
    pub track_id: u64,
    pub student_id: Option<i64>,
    pub similarity: f32,
    pub confidence: f32,
    pub quality_score: f32,
    pub embedding: Vec<f32>,
    pub crop_bbox: [u32; 4],
    pub crop_rgb: Vec<u8>,
    pub crop_w: u32,
    pub crop_h: u32,
}

#[derive(Debug, Default)]
pub struct FrameStepOutput {
    pub dispositions: Vec<FrameStepDisposition>,
    pub dispatches: Vec<DispatchEvent>,
    pub debug_annotations: Vec<DebugAnnotation>,
    pub raw_faces: usize,
    pub dropped_confidence: usize,
    pub dropped_landmark: usize,
    pub dropped_size: usize,
    pub dropped_blur: usize,
    pub dropped_pose: usize,
    pub passed_embedding: usize,
}

/// Crops a padded RGB24 region around `bbox` for snapshot generation without keeping full frame bytes.
pub fn extract_padded_face_crop_rgb(
    rgb: &[u8],
    frame_w: u32,
    frame_h: u32,
    bbox: [f32; 4],
) -> Option<([u32; 4], Vec<u8>, u32, u32)> {
    if frame_w == 0 || frame_h == 0 || rgb.len() != (frame_w as usize) * (frame_h as usize) * 3 {
        return None;
    }
    let bw = (bbox[2] - bbox[0]).max(1.0);
    let bh = (bbox[3] - bbox[1]).max(1.0);
    let pad = bw.max(bh) * 0.45;
    let x1 = (bbox[0] - pad).floor().max(0.0) as u32;
    let y1 = (bbox[1] - pad).floor().max(0.0) as u32;
    let x2 = ((bbox[2] + pad).ceil() as u32).min(frame_w);
    let y2 = ((bbox[3] + pad).ceil() as u32).min(frame_h);
    if x2 <= x1 || y2 <= y1 {
        return None;
    }
    let cw = x2 - x1;
    let ch = y2 - y1;
    let mut crop = Vec::with_capacity((cw as usize) * (ch as usize) * 3);
    let frame_stride = (frame_w as usize) * 3;
    let row_bytes = (cw as usize) * 3;
    let start_col = (x1 as usize) * 3;
    for y in y1..y2 {
        let row_start = (y as usize) * frame_stride + start_col;
        crop.extend_from_slice(&rgb[row_start..row_start + row_bytes]);
    }
    Some(([x1, y1, x2, y2], crop, cw, ch))
}

#[allow(clippy::too_many_arguments)]
pub fn process_detected_faces_frame<F>(
    camera_id: i64,
    rgb: &[u8],
    frame_w: u32,
    frame_h: u32,
    faces: &[DetectedFace],
    now_ms: u64,
    cfg: &ThresholdsConfig,
    gallery: &GalleryIndex,
    tracker: &mut IoUTracker,
    votes: &mut TrackVoteBuffer,
    dedup: &mut DedupCooldownMap,
    mut embed_fn: F,
) -> FrameStepOutput
where
    F: FnMut(&[u8]) -> Result<Vec<f32>, String>,
{
    let mut out = FrameStepOutput {
        raw_faces: faces.len(),
        ..Default::default()
    };

    if faces.is_empty() {
        votes.clear_expired(now_ms, cfg.vote_window_sec);
        return out;
    }

    // Step 1: Pre-filter and assign stable track IDs to track-eligible (>=40px) & embed-eligible faces.
    let mut track_boxes = Vec::new();
    let mut face_indices = Vec::new();
    for (idx, face) in faces.iter().enumerate() {
        match evaluate_pre_alignment_gates(face, cfg) {
            Ok(_) => {
                track_boxes.push(face.bbox);
                face_indices.push((idx, true));
            }
            Err((reason, detail, tier, _sz)) => {
                match reason {
                    GateRejectReason::Confidence => out.dropped_confidence += 1,
                    GateRejectReason::Landmark => out.dropped_landmark += 1,
                    GateRejectReason::Size => out.dropped_size += 1,
                    GateRejectReason::Blur => out.dropped_blur += 1,
                    GateRejectReason::Pose => out.dropped_pose += 1,
                }
                if tier == FaceSizeTier::TrackOnlySkipEmbed && reason == GateRejectReason::Size {
                    track_boxes.push(face.bbox);
                    face_indices.push((idx, false));
                    out.dispositions.push(FrameStepDisposition::SkippedTrackOnly);
                } else {
                    out.dispositions
                        .push(FrameStepDisposition::RejectedPreGate(reason));
                }
                if cfg.debug_detection {
                    out.debug_annotations.push(DebugAnnotation {
                        bbox: face.bbox,
                        kps: face.kps,
                        passed: false,
                        label: format!("DROP:{detail}"),
                    });
                }
            }
        }
    }

    let ttl_ms = (cfg.vote_window_sec.max(4)) * 1000;
    let track_ids = tracker.assign_tracks(&track_boxes, now_ms, Some(ttl_ms));
    votes.clear_expired(now_ms, cfg.vote_window_sec);

    for (&(face_idx, embed_eligible), &track_id) in face_indices.iter().zip(track_ids.iter()) {
        if !embed_eligible {
            continue;
        }
        let face = &faces[face_idx];
        let Some(affine) = estimate_similarity_lmeds(&face.kps, &ARCFACE_DST_112) else {
            out.dispositions.push(FrameStepDisposition::AlignFailed);
            continue;
        };
        let Some(aligned_112) = warp_rgb_112(rgb, frame_w, frame_h, &affine) else {
            out.dispositions.push(FrameStepDisposition::AlignFailed);
            continue;
        };

        // Step 2: Aligned 112x112 Laplacian blur + 5-pt pose gate (BEFORE calling ArcFace!)
        let qgate = evaluate_aligned_quality_gate(face, &aligned_112, cfg);
        if !qgate.passed {
            let reason = qgate.reason.unwrap_or(GateRejectReason::Blur);
            match reason {
                GateRejectReason::Confidence => out.dropped_confidence += 1,
                GateRejectReason::Landmark => out.dropped_landmark += 1,
                GateRejectReason::Size => out.dropped_size += 1,
                GateRejectReason::Blur => out.dropped_blur += 1,
                GateRejectReason::Pose => out.dropped_pose += 1,
            }
            if cfg.debug_detection {
                out.debug_annotations.push(DebugAnnotation {
                    bbox: face.bbox,
                    kps: face.kps,
                    passed: false,
                    label: format!("DROP:{}", qgate.detail.as_deref().unwrap_or("qgate")),
                });
            }
            out.dispositions
                .push(FrameStepDisposition::RejectedAlignedGate(reason));
            continue;
        }

        if qgate.quality_score < cfg.min_snapshot_quality {
            out.dispositions
                .push(FrameStepDisposition::RejectedQualityThreshold);
            continue;
        }

        if cfg.debug_detection {
            out.debug_annotations.push(DebugAnnotation {
                bbox: face.bbox,
                kps: face.kps,
                passed: true,
                label: format!("PASS:{:.2} q={:.2}", face.score, qgate.quality_score),
            });
        }

        // Step 3: ArcFace 512-D embedding (only for aligned faces passing all quality gates!)
        let emb = match embed_fn(&aligned_112) {
            Ok(v) => v,
            Err(_) => {
                out.dispositions.push(FrameStepDisposition::EmbedError);
                continue;
            }
        };
        out.passed_embedding += 1;

        // Step 4: Batch 5000 matching + 4-case margin check + multi-frame voting
        let eval = evaluate_gallery_match(gallery, &emb, qgate.quality_score, cfg);
        match eval.outcome {
            MatchOutcome::Matched { student_id } => {
                let vote = votes.record_and_evaluate(
                    track_id,
                    Some(student_id),
                    eval.best_score,
                    now_ms,
                    cfg.vote_threshold,
                    cfg.vote_window_sec,
                    cfg.vote_min_count,
                );
                if vote.outcome != VoteOutcome::Confirmed || !vote.should_dispatch {
                    out.dispositions
                        .push(FrameStepDisposition::AwaitingSecondVote);
                    continue;
                }
                if !dedup.try_acquire(camera_id as u64, student_id, now_ms) {
                    out.dispositions
                        .push(FrameStepDisposition::SuppressedByDedup);
                    continue;
                }
                let Some((crop_bbox, crop_rgb, crop_w, crop_h)) =
                    extract_padded_face_crop_rgb(rgb, frame_w, frame_h, face.bbox)
                else {
                    continue;
                };
                out.dispatches.push(DispatchEvent {
                    camera_id,
                    track_id,
                    student_id: Some(student_id),
                    similarity: eval.best_score,
                    confidence: face.score,
                    quality_score: qgate.quality_score,
                    embedding: emb,
                    crop_bbox,
                    crop_rgb,
                    crop_w,
                    crop_h,
                });
                out.dispositions
                    .push(FrameStepDisposition::DispatchedMatched);
            }
            _ => {
                // Anonymous track event deduped using negative key so an unknown face isn't flooded per frame.
                let anon_key = -(track_id as i64);
                if !dedup.try_acquire(camera_id as u64, anon_key, now_ms) {
                    out.dispositions
                        .push(FrameStepDisposition::SuppressedByDedup);
                    continue;
                }
                let Some((crop_bbox, crop_rgb, crop_w, crop_h)) =
                    extract_padded_face_crop_rgb(rgb, frame_w, frame_h, face.bbox)
                else {
                    continue;
                };
                out.dispatches.push(DispatchEvent {
                    camera_id,
                    track_id,
                    student_id: None,
                    similarity: eval.best_score,
                    confidence: face.score,
                    quality_score: qgate.quality_score,
                    embedding: emb,
                    crop_bbox,
                    crop_rgb,
                    crop_w,
                    crop_h,
                });
                out.dispositions
                    .push(FrameStepDisposition::DispatchedAnonymous);
            }
        }
    }

    out
}
