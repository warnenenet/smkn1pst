use crate::config::ThresholdsConfig;
use crate::det_scrfd::{validate_five_landmarks, DetectedFace, LandmarkRejectionReason};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum FaceSizeTier {
    RejectTooSmall,
    TrackOnlySkipEmbed,
    EmbedEligible,
    RejectTooLarge,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum GateRejectReason {
    Confidence,
    Landmark,
    Size,
    Blur,
    Pose,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct PoseDeg {
    pub yaw_deg: f32,
    pub pitch_deg: f32,
    pub roll_deg: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AlignedQualityGateResult {
    pub passed: bool,
    pub reason: Option<GateRejectReason>,
    pub detail: Option<String>,
    pub size_tier: FaceSizeTier,
    pub face_size_px: u32,
    pub blur_variance: Option<f64>,
    pub yaw_deg: Option<f32>,
    pub pitch_deg: Option<f32>,
    pub frontal_score: f32,
    pub quality_score: f32,
}

pub fn classify_face_size_tier(face_size_px: u32, cfg: &ThresholdsConfig) -> FaceSizeTier {
    if face_size_px < cfg.track_min_face_px {
        return FaceSizeTier::RejectTooSmall;
    }
    if face_size_px < cfg.embed_min_face_px {
        return FaceSizeTier::TrackOnlySkipEmbed;
    }
    if cfg.max_face_size_px > 0 && face_size_px > cfg.max_face_size_px {
        return FaceSizeTier::RejectTooLarge;
    }
    FaceSizeTier::EmbedEligible
}

/// Estimates yaw, pitch, and roll in degrees from 5 facial landmarks.
pub fn estimate_pose_deg_5pt(kps: &[[f32; 2]; 5]) -> PoseDeg {
    let left_eye = kps[0];
    let right_eye = kps[1];
    let nose = kps[2];
    let mouth_left = kps[3];
    let mouth_right = kps[4];

    let dx_eye = right_eye[0] - left_eye[0];
    let dy_eye = right_eye[1] - left_eye[1];
    let eye_dist = (dx_eye * dx_eye + dy_eye * dy_eye).sqrt().max(1e-3);
    let roll_rad = dy_eye.atan2(dx_eye);

    let eye_mid_x = (left_eye[0] + right_eye[0]) * 0.5;
    let eye_mid_y = (left_eye[1] + right_eye[1]) * 0.5;
    let mouth_mid_x = (mouth_left[0] + mouth_right[0]) * 0.5;
    let mouth_mid_y = (mouth_left[1] + mouth_right[1]) * 0.5;

    let cos_r = (-roll_rad).cos();
    let sin_r = (-roll_rad).sin();
    let rot_nose_x = (nose[0] - eye_mid_x) * cos_r - (nose[1] - eye_mid_y) * sin_r;
    let rot_nose_y = (nose[0] - eye_mid_x) * sin_r + (nose[1] - eye_mid_y) * cos_r;
    let rot_mouth_x = (mouth_mid_x - eye_mid_x) * cos_r - (mouth_mid_y - eye_mid_y) * sin_r;
    let rot_mouth_y = (mouth_mid_x - eye_mid_x) * sin_r + (mouth_mid_y - eye_mid_y) * cos_r;

    let face_center_x = rot_mouth_x * 0.5;
    let half_eye = (eye_dist * 0.5).max(1e-3);
    let yaw_norm = (((rot_nose_x - face_center_x) / half_eye) * 0.72).clamp(-1.0, 1.0);
    let yaw_deg = yaw_norm.asin().to_degrees();

    let eye_to_mouth = rot_mouth_y.max(1e-3);
    let rel_nose_y = rot_nose_y / eye_to_mouth;
    let pitch_norm = (rel_nose_y - 0.5) / 0.35;
    let pitch_deg = (pitch_norm * 45.0).clamp(-80.0, 80.0);

    PoseDeg {
        yaw_deg: (yaw_deg * 100.0).round() / 100.0,
        pitch_deg: (pitch_deg * 100.0).round() / 100.0,
        roll_deg: (roll_rad.to_degrees() * 100.0).round() / 100.0,
    }
}

/// Computes Variance of Laplacian on the ALIGNED 112x112 RGB24 crop (BT.601 luminance).
/// Evaluating blur after alignment keeps the metric invariant to face scale and background clutter.
pub fn compute_laplacian_variance_rgb112(rgb112: &[u8]) -> Result<f64, String> {
    const SIDE: usize = 112;
    if rgb112.len() != SIDE * SIDE * 3 {
        return Err(format!(
            "expected aligned 112x112 RGB24 ({} bytes), got {}",
            SIDE * SIDE * 3,
            rgb112.len()
        ));
    }

    let mut gray = [0.0f64; SIDE * SIDE];
    for (i, px) in rgb112.chunks_exact(3).enumerate() {
        gray[i] = 0.299 * (px[0] as f64) + 0.587 * (px[1] as f64) + 0.114 * (px[2] as f64);
    }

    let mut sum = 0.0f64;
    let mut sum_sq = 0.0f64;
    let mut count = 0usize;

    for y in 1..(SIDE - 1) {
        let row = y * SIDE;
        for x in 1..(SIDE - 1) {
            let idx = row + x;
            let lap = gray[idx - SIDE] + gray[idx - 1] - 4.0 * gray[idx] + gray[idx + 1] + gray[idx + SIDE];
            sum += lap;
            sum_sq += lap * lap;
            count += 1;
        }
    }

    if count == 0 {
        return Ok(0.0);
    }
    let n = count as f64;
    let mean = sum / n;
    Ok((sum_sq / n - mean * mean).max(0.0))
}

pub fn evaluate_pre_alignment_gates(
    face: &DetectedFace,
    cfg: &ThresholdsConfig,
) -> Result<(u32, FaceSizeTier), (GateRejectReason, String, FaceSizeTier, u32)> {
    let face_size_px = face.min_side_px().round().max(0.0) as u32;
    let tier = classify_face_size_tier(face_size_px, cfg);

    if !face.score.is_finite() || face.score < cfg.threshold_confidence {
        return Err((
            GateRejectReason::Confidence,
            format!("conf={:.2}<{:.2}", face.score, cfg.threshold_confidence),
            tier,
            face_size_px,
        ));
    }

    if let Err(lm_err) = validate_five_landmarks(face.bbox, &face.kps) {
        let reason_str = match lm_err {
            LandmarkRejectionReason::IncompleteLandmarks => "incomplete_landmarks",
            LandmarkRejectionReason::InvalidBbox => "invalid_bbox",
            LandmarkRejectionReason::LandmarkOutsideBbox => "landmark_outside_bbox",
            LandmarkRejectionReason::SwappedEyes => "swapped_eyes",
            LandmarkRejectionReason::SwappedMouth => "swapped_mouth",
            LandmarkRejectionReason::NoseNotBetweenEyesAndMouth => "nose_not_between_eyes_and_mouth",
            LandmarkRejectionReason::EyesTooClose => "eyes_too_close",
            LandmarkRejectionReason::ProportionOutOfRange => "proportion_out_of_range",
        };
        return Err((GateRejectReason::Landmark, reason_str.to_string(), tier, face_size_px));
    }

    match tier {
        FaceSizeTier::RejectTooSmall | FaceSizeTier::TrackOnlySkipEmbed => {
            return Err((
                GateRejectReason::Size,
                format!("px={face_size_px}<{}", cfg.embed_min_face_px),
                tier,
                face_size_px,
            ));
        }
        FaceSizeTier::RejectTooLarge => {
            return Err((
                GateRejectReason::Size,
                format!("px={face_size_px}>{}", cfg.max_face_size_px),
                tier,
                face_size_px,
            ));
        }
        FaceSizeTier::EmbedEligible => {}
    }

    Ok((face_size_px, tier))
}

pub fn evaluate_aligned_quality_gate(
    face: &DetectedFace,
    aligned_rgb_112: &[u8],
    cfg: &ThresholdsConfig,
) -> AlignedQualityGateResult {
    let (face_size_px, size_tier) = match evaluate_pre_alignment_gates(face, cfg) {
        Ok(ok) => ok,
        Err((reason, detail, tier, sz)) => {
            return AlignedQualityGateResult {
                passed: false,
                reason: Some(reason),
                detail: Some(detail),
                size_tier: tier,
                face_size_px: sz,
                blur_variance: None,
                yaw_deg: None,
                pitch_deg: None,
                frontal_score: 0.0,
                quality_score: 0.0,
            };
        }
    };

    let blur_var = compute_laplacian_variance_rgb112(aligned_rgb_112).unwrap_or(0.0);
    if !blur_var.is_finite() || blur_var < cfg.blur_threshold {
        return AlignedQualityGateResult {
            passed: false,
            reason: Some(GateRejectReason::Blur),
            detail: Some(format!("lap={:.0}<{:.0}", blur_var, cfg.blur_threshold)),
            size_tier,
            face_size_px,
            blur_variance: Some((blur_var * 100.0).round() / 100.0),
            yaw_deg: None,
            pitch_deg: None,
            frontal_score: 0.0,
            quality_score: 0.0,
        };
    }

    let pose = estimate_pose_deg_5pt(&face.kps);
    if pose.yaw_deg.abs() > cfg.max_yaw_deg || pose.pitch_deg.abs() > cfg.max_pitch_deg {
        return AlignedQualityGateResult {
            passed: false,
            reason: Some(GateRejectReason::Pose),
            detail: Some(format!(
                "yaw={:.0}/pitch={:.0}",
                pose.yaw_deg, pose.pitch_deg
            )),
            size_tier,
            face_size_px,
            blur_variance: Some((blur_var * 100.0).round() / 100.0),
            yaw_deg: Some(pose.yaw_deg),
            pitch_deg: Some(pose.pitch_deg),
            frontal_score: 0.0,
            quality_score: 0.0,
        };
    }

    let frontal_score = (1.0 - (pose.yaw_deg.abs() / 45.0) * 0.65 - (pose.pitch_deg.abs() / 35.0) * 0.35)
        .clamp(0.1, 1.0);
    let size_norm = (face_size_px as f32 / 180.0).clamp(0.0, 1.0);
    let sharp_norm = ((blur_var as f32) / 200.0).clamp(0.0, 1.0);
    let conf_norm = face.score.clamp(0.0, 1.0);

    let w_sum = (cfg.weight_confidence + cfg.weight_size + cfg.weight_sharpness + cfg.weight_frontal).max(1e-6);
    let q = (conf_norm * cfg.weight_confidence
        + size_norm * cfg.weight_size
        + sharp_norm * cfg.weight_sharpness
        + frontal_score * cfg.weight_frontal)
        / w_sum;

    AlignedQualityGateResult {
        passed: true,
        reason: None,
        detail: None,
        size_tier,
        face_size_px,
        blur_variance: Some((blur_var * 100.0).round() / 100.0),
        yaw_deg: Some(pose.yaw_deg),
        pitch_deg: Some(pose.pitch_deg),
        frontal_score: (frontal_score * 10_000.0).round() / 10_000.0,
        quality_score: (q.clamp(0.0, 1.0) * 10_000.0).round() / 10_000.0,
    }
}
