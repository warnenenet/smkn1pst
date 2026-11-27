use face_engine::align::ARCFACE_DST_112;
use face_engine::config::ThresholdsConfig;
use face_engine::det_scrfd::DetectedFace;
use face_engine::quality_gate::{
    classify_face_size_tier, compute_laplacian_variance_rgb112, estimate_pose_deg_5pt,
    evaluate_aligned_quality_gate, FaceSizeTier, GateRejectReason,
};

fn sharp_112_rgb() -> Vec<u8> {
    let mut rgb = vec![0u8; 112 * 112 * 3];
    for y in 0..112 {
        for x in 0..112 {
            let v: u8 = if (x + y) % 2 == 0 { 220 } else { 20 };
            let i = (y * 112 + x) * 3;
            rgb[i] = v;
            rgb[i + 1] = v;
            rgb[i + 2] = v;
        }
    }
    rgb
}

fn blurry_112_rgb() -> Vec<u8> {
    vec![128u8; 112 * 112 * 3]
}

fn make_face(size_px: f32) -> DetectedFace {
    let x1 = 100.0;
    let y1 = 100.0;
    let x2 = x1 + size_px;
    let y2 = y1 + size_px;
    let scale = size_px / 112.0;
    let mut kps = [[0.0f32; 2]; 5];
    for i in 0..5 {
        kps[i] = [x1 + ARCFACE_DST_112[i][0] * scale, y1 + ARCFACE_DST_112[i][1] * scale];
    }
    DetectedFace {
        bbox: [x1, y1, x2, y2],
        score: 0.92,
        kps,
    }
}

#[test]
fn size_tiers_enforce_track_vs_embed_thresholds() {
    let mut cfg = ThresholdsConfig::conservative_defaults();
    assert_eq!(classify_face_size_tier(32, &cfg), FaceSizeTier::RejectTooSmall);
    assert_eq!(classify_face_size_tier(55, &cfg), FaceSizeTier::TrackOnlySkipEmbed);
    assert_eq!(classify_face_size_tier(79, &cfg), FaceSizeTier::TrackOnlySkipEmbed);
    assert_eq!(classify_face_size_tier(80, &cfg), FaceSizeTier::EmbedEligible);
    assert_eq!(classify_face_size_tier(180, &cfg), FaceSizeTier::EmbedEligible);

    cfg.max_face_size_px = 260;
    assert_eq!(classify_face_size_tier(280, &cfg), FaceSizeTier::RejectTooLarge);
}

#[test]
fn laplacian_variance_runs_on_aligned_112x112_rgb_crop() {
    let sharp = sharp_112_rgb();
    let blur = blurry_112_rgb();
    let v_sharp = compute_laplacian_variance_rgb112(&sharp).unwrap();
    let v_blur = compute_laplacian_variance_rgb112(&blur).unwrap();
    assert!(v_sharp > 1000.0, "expected sharp laplacian > 1000, got {v_sharp}");
    assert!(v_blur < 1.0, "expected flat blur laplacian < 1, got {v_blur}");
}

#[test]
fn aligned_quality_gate_rejects_blur_and_extreme_pose_and_accepts_clean() {
    let cfg = ThresholdsConfig::conservative_defaults();
    let face = make_face(112.0);

    // 1. Clean frontal sharp 112 crop -> PASS
    let res = evaluate_aligned_quality_gate(&face, &sharp_112_rgb(), &cfg);
    assert!(res.passed, "expected clean aligned face to pass: {:?}", res.reason);
    assert!(res.quality_score > 0.7 && res.quality_score <= 1.0);

    // 2. Blurry 112 crop -> REJECT Blur
    let res_blur = evaluate_aligned_quality_gate(&face, &blurry_112_rgb(), &cfg);
    assert!(!res_blur.passed);
    assert_eq!(res_blur.reason, Some(GateRejectReason::Blur));

    // 3. Extreme yaw -> REJECT Pose
    let mut yaw_face = make_face(112.0);
    // Push nose strongly toward right eye while staying inside bbox
    yaw_face.kps[2][0] = yaw_face.kps[1][0] - 1.0;
    let res_yaw = evaluate_aligned_quality_gate(&yaw_face, &sharp_112_rgb(), &cfg);
    assert!(!res_yaw.passed);
    assert_eq!(res_yaw.reason, Some(GateRejectReason::Pose));

    // 4. Extreme pitch -> REJECT Pose
    let mut pitch_face = make_face(112.0);
    // Push nose very high near eyes (relNoseY << 0.5 -> |pitch| > 30 deg)
    let eye_y = pitch_face.kps[0][1];
    pitch_face.kps[2][1] = eye_y + 11.0; // eye->mouth ~ 40.7 -> rel ~ 0.27 -> pitch ~ -30 deg
    // Actually make it tighter while staying >= 0.50 nose ratio? Wait: 0.50 ratio => nose is 1/3 down -> pitch = (0.333-0.5)/0.35*45 = -21.4 deg.
    //Wait: if lower_span is shorter than upper_span (head pitched strongly DOWN, nose near mouth): upper=26, lower=14 (ratio=1.85 <= 2.0) -> rel=26/40=0.65 => pitch = (0.65-0.5)/0.35*45 = 19.3 deg; if max_pitch_deg=15:
    let mut strict_cfg = cfg.clone();
    strict_cfg.max_pitch_deg = 15.0;
    pitch_face.kps[2][1] = eye_y + 27.0;
    let pose = estimate_pose_deg_5pt(&pitch_face.kps);
    assert!(pose.pitch_deg.abs() > 15.0);
    let res_pitch = evaluate_aligned_quality_gate(&pitch_face, &sharp_112_rgb(), &strict_cfg);
    assert!(!res_pitch.passed);
    assert_eq!(res_pitch.reason, Some(GateRejectReason::Pose));
}
