use face_engine::det_scrfd::{
    build_anchor_centers, decode_scrfd_level, nms, validate_five_landmarks, DetectedFace,
    LandmarkRejectionReason,
};

fn valid_face() -> DetectedFace {
    DetectedFace {
        bbox: [100.0, 100.0, 220.0, 240.0], // 120x140
        score: 0.94,
        kps: [
            [135.0, 150.0], // left eye
            [185.0, 150.0], // right eye
            [160.0, 180.0], // nose
            [140.0, 210.0], // mouth left
            [180.0, 210.0], // mouth right
        ],
    }
}

#[test]
fn five_point_sanity_accepts_valid_anatomy() {
    let f = valid_face();
    assert!(validate_five_landmarks(f.bbox, &f.kps).is_ok());
}

#[test]
fn five_point_sanity_case1_rejects_non_finite_landmark() {
    let mut f = valid_face();
    f.kps[2][0] = f32::NAN;
    assert_eq!(
        validate_five_landmarks(f.bbox, &f.kps),
        Err(LandmarkRejectionReason::IncompleteLandmarks)
    );
}

#[test]
fn five_point_sanity_case2_rejects_landmark_outside_bbox() {
    let mut f = valid_face();
    f.kps[0][0] = 50.0; // far outside x1=100
    assert_eq!(
        validate_five_landmarks(f.bbox, &f.kps),
        Err(LandmarkRejectionReason::LandmarkOutsideBbox)
    );
}

#[test]
fn five_point_sanity_case3_rejects_swapped_eyes() {
    let mut f = valid_face();
    f.kps.swap(0, 1);
    assert_eq!(
        validate_five_landmarks(f.bbox, &f.kps),
        Err(LandmarkRejectionReason::SwappedEyes)
    );
}

#[test]
fn five_point_sanity_case4_rejects_swapped_mouth() {
    let mut f = valid_face();
    f.kps.swap(3, 4);
    assert_eq!(
        validate_five_landmarks(f.bbox, &f.kps),
        Err(LandmarkRejectionReason::SwappedMouth)
    );
}

#[test]
fn five_point_sanity_case5_rejects_nose_outside_eye_mouth_span() {
    let mut f = valid_face();
    f.kps[2][1] = 140.0; // above eyes (y=150)
    assert_eq!(
        validate_five_landmarks(f.bbox, &f.kps),
        Err(LandmarkRejectionReason::NoseNotBetweenEyesAndMouth)
    );
}

#[test]
fn five_point_sanity_case6_rejects_eyes_too_close_and_bad_vertical_proportion() {
    let mut f = valid_face();
    // eye dist = 6 px on 120 px width (< 0.15 * 120 = 18)
    f.kps[0][0] = 157.0;
    f.kps[1][0] = 163.0;
    assert_eq!(
        validate_five_landmarks(f.bbox, &f.kps),
        Err(LandmarkRejectionReason::EyesTooClose)
    );

    let mut f2 = valid_face();
    // nose almost at mouth -> upper=58, lower=2 -> ratio = 29 (> 2.0)
    f2.kps[2][1] = 208.0;
    assert_eq!(
        validate_five_landmarks(f2.bbox, &f2.kps),
        Err(LandmarkRejectionReason::ProportionOutOfRange)
    );
}

#[test]
fn scrfd_anchor_grid_decode_and_nms_work() {
    let centers = build_anchor_centers(20, 20, 32, 2);
    assert_eq!(centers.len(), 800);
    assert_eq!(centers[0], [0.0, 0.0]);
    assert_eq!(centers[2], [32.0, 0.0]);
    assert_eq!(centers[40], [0.0, 32.0]);

    // Synthesize 2 detections on anchor idx=2 (center=[32, 0], stride=32) and idx=100
    let mut scores = vec![0.05f32; 800];
    let mut bboxes = vec![0.0f32; 800 * 4];
    let mut kpss = vec![0.0f32; 800 * 10];
    scores[2] = 0.91;
    // distances * stride (32): left=1.0 -> 32, top=0.0, right=2.0 -> 64, bottom=3.0 -> 96
    bboxes[2 * 4] = 1.0;
    bboxes[2 * 4 + 1] = 0.0;
    bboxes[2 * 4 + 2] = 2.0;
    bboxes[2 * 4 + 3] = 3.0;
    kpss[2 * 10] = -0.2;
    kpss[2 * 10 + 1] = 0.5;

    let mut out = Vec::new();
    decode_scrfd_level(
        &scores,
        &bboxes,
        Some(&kpss),
        &centers,
        32,
        1.0,
        0.5,
        640,
        640,
        &mut out,
    );
    assert_eq!(out.len(), 1);
    assert!((out[0].bbox[0] - 0.0).abs() < 1e-4);
    assert!((out[0].bbox[2] - 96.0).abs() < 1e-4);
    assert!((out[0].bbox[3] - 96.0).abs() < 1e-4);
    assert!((out[0].kps[0][0] - (32.0 - 0.2 * 32.0)).abs() < 1e-4);

    // Duplicate overlapping box should be suppressed by NMS
    let mut dup = out[0].clone();
    dup.score = 0.70;
    let kept = nms(vec![out[0].clone(), dup], 0.4);
    assert_eq!(kept.len(), 1);
    assert!((kept[0].score - 0.91).abs() < 1e-5);
}
