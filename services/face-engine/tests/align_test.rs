use face_engine::align::{
    estimate_similarity_lmeds, estimate_similarity_ls, reprojection_rmse_5pt, warp_rgb_112,
    ARCFACE_DST_112,
};

#[test]
fn lmeds_and_ls_recover_similarity_below_2px_error() {
    let scale = 2.2f32;
    let theta = 0.21f32;
    let tx = 280.0f32;
    let ty = 130.0f32;

    let mut src = [[0.0f32; 2]; 5];
    for (i, dst) in ARCFACE_DST_112.iter().enumerate() {
        let x = dst[0] * scale;
        let y = dst[1] * scale;
        src[i] = [
            x * theta.cos() - y * theta.sin() + tx,
            x * theta.sin() + y * theta.cos() + ty,
        ];
    }

    let m_ls = estimate_similarity_ls(&src, &ARCFACE_DST_112).expect("LS must solve");
    let m_lmeds = estimate_similarity_lmeds(&src, &ARCFACE_DST_112).expect("LMEDS must solve");

    assert!(reprojection_rmse_5pt(&m_ls, &src, &ARCFACE_DST_112) < 1e-3);
    assert!(reprojection_rmse_5pt(&m_lmeds, &src, &ARCFACE_DST_112) < 1e-3);
    assert!(m_ls.max_abs_diff(&m_lmeds) < 1e-3);
}

#[test]
fn lmeds_resists_outlier_landmark_and_keeps_clean_points_under_2px() {
    let mut pts = ARCFACE_DST_112;
    for p in &mut pts {
        p[0] = p[0] * 2.0 + 40.0;
        p[1] = p[1] * 2.0 + 50.0;
    }
    // Corrupt nose landmark by +35 px
    pts[2][0] += 35.0;

    let m_ls = estimate_similarity_ls(&pts, &ARCFACE_DST_112).unwrap();
    let m_lmeds = estimate_similarity_lmeds(&pts, &ARCFACE_DST_112).unwrap();

    for idx in [0usize, 1, 3, 4] {
        let proj = m_lmeds.apply(pts[idx]);
        let err = ((proj[0] - ARCFACE_DST_112[idx][0] as f64).powi(2)
            + (proj[1] - ARCFACE_DST_112[idx][1] as f64).powi(2))
        .sqrt();
        assert!(err < 0.05, "LMEDS error on clean point {idx} was {err}");
    }

    let p0_ls = m_ls.apply(pts[0]);
    let err0_ls = ((p0_ls[0] - ARCFACE_DST_112[0][0] as f64).powi(2)
        + (p0_ls[1] - ARCFACE_DST_112[0][1] as f64).powi(2))
    .sqrt();
    assert!(err0_ls > 1.5, "LS should be pulled by outlier, got {err0_ls}");
}

#[test]
fn warp_rgb_112_places_synthetic_eye_beacon_at_arcface_template_coords() {
    let w = 640u32;
    let h = 480u32;
    let mut img = vec![0u8; (w * h * 3) as usize];

    // Place face landmarks at 2x scale + translation (150, 80)
    let mut src_kps = [[0.0f32; 2]; 5];
    for i in 0..5 {
        src_kps[i][0] = ARCFACE_DST_112[i][0] * 2.0 + 150.0;
        src_kps[i][1] = ARCFACE_DST_112[i][1] * 2.0 + 80.0;
    }

    // Paint bright white 3x3 pixel dot centered at src_kps[0] (left eye)
    let ex = src_kps[0][0].round() as i32;
    let ey = src_kps[0][1].round() as i32;
    for dy in -1..=1 {
        for dx in -1..=1 {
            let px = (ex + dx) as usize;
            let py = (ey + dy) as usize;
            let idx = (py * w as usize + px) * 3;
            img[idx] = 255;
            img[idx + 1] = 255;
            img[idx + 2] = 255;
        }
    }

    let m = estimate_similarity_lmeds(&src_kps, &ARCFACE_DST_112).unwrap();
    let aligned = warp_rgb_112(&img, w, h, &m).expect("warp_rgb_112 must succeed");
    assert_eq!(aligned.len(), 112 * 112 * 3);

    // Find brightest pixel in 112x112 output -> must be within < 2px of ARCFACE_DST_112[0]
    let mut best_x = 0usize;
    let mut best_y = 0usize;
    let mut best_val = 0u32;
    for y in 0..112 {
        for x in 0..112 {
            let idx = (y * 112 + x) * 3;
            let sum = aligned[idx] as u32 + aligned[idx + 1] as u32 + aligned[idx + 2] as u32;
            if sum > best_val {
                best_val = sum;
                best_x = x;
                best_y = y;
            }
        }
    }
    assert!(best_val > 200, "beacon pixel lost during warp");
    let dist = ((best_x as f32 - ARCFACE_DST_112[0][0]).powi(2)
        + (best_y as f32 - ARCFACE_DST_112[0][1]).powi(2))
    .sqrt();
    assert!(dist < 2.0, "aligned beacon distance from ARCFACE_DST_112[0] was {dist}");
}
