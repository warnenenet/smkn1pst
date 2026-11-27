use serde::{Deserialize, Serialize};

pub const ARCFACE_DST_112: [[f32; 2]; 5] = [
    [38.2946, 51.6963], // left eye (viewer left)
    [73.5318, 51.5014], // right eye (viewer right)
    [56.0252, 71.7366], // nose tip
    [41.5493, 92.3655], // mouth left (viewer left)
    [70.7299, 92.2041], // mouth right (viewer right)
];

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct Affine2x3 {
    pub m00: f64,
    pub m01: f64,
    pub m02: f64,
    pub m10: f64,
    pub m11: f64,
    pub m12: f64,
}

impl Affine2x3 {
    pub fn to_rows(self) -> [[f64; 3]; 2] {
        [[self.m00, self.m01, self.m02], [self.m10, self.m11, self.m12]]
    }

    pub fn apply(&self, p: [f32; 2]) -> [f64; 2] {
        let x = p[0] as f64;
        let y = p[1] as f64;
        [
            self.m00 * x + self.m01 * y + self.m02,
            self.m10 * x + self.m11 * y + self.m12,
        ]
    }

    pub fn invert(&self) -> Option<Self> {
        let det = self.m00 * self.m11 - self.m01 * self.m10;
        if det.abs() < 1e-12 {
            return None;
        }
        let inv_det = 1.0 / det;
        let i00 = self.m11 * inv_det;
        let i01 = -self.m01 * inv_det;
        let i10 = -self.m10 * inv_det;
        let i11 = self.m00 * inv_det;
        let i02 = -(i00 * self.m02 + i01 * self.m12);
        let i12 = -(i10 * self.m02 + i11 * self.m12);
        Some(Self {
            m00: i00,
            m01: i01,
            m02: i02,
            m10: i10,
            m11: i11,
            m12: i12,
        })
    }

    pub fn max_abs_diff(&self, other: &Self) -> f64 {
        [
            (self.m00 - other.m00).abs(),
            (self.m01 - other.m01).abs(),
            (self.m02 - other.m02).abs(),
            (self.m10 - other.m10).abs(),
            (self.m11 - other.m11).abs(),
            (self.m12 - other.m12).abs(),
        ]
        .into_iter()
        .fold(0.0, f64::max)
    }
}

/// Exact 2D proper similarity transform (rotation + uniform scale + translation, 4 DOF)
/// minimizing sum of squared errors sum_i || M * src[i] - dst[i] ||^2.
/// Equivalent to 2D Umeyama without reflection (appropriate for upright face alignment).
pub fn estimate_similarity_ls(src: &[[f32; 2]], dst: &[[f32; 2]]) -> Option<Affine2x3> {
    let n = src.len();
    if n < 2 || n != dst.len() {
        return None;
    }
    let nf = n as f64;
    let mut sx = 0.0;
    let mut sy = 0.0;
    let mut dx = 0.0;
    let mut dy = 0.0;
    for i in 0..n {
        sx += src[i][0] as f64;
        sy += src[i][1] as f64;
        dx += dst[i][0] as f64;
        dy += dst[i][1] as f64;
    }
    sx /= nf;
    sy /= nf;
    dx /= nf;
    dy /= nf;

    let mut denom = 0.0;
    let mut num_a = 0.0;
    let mut num_b = 0.0;
    for i in 0..n {
        let px = src[i][0] as f64 - sx;
        let py = src[i][1] as f64 - sy;
        let qx = dst[i][0] as f64 - dx;
        let qy = dst[i][1] as f64 - dy;
        denom += px * px + py * py;
        num_a += px * qx + py * qy;
        num_b += px * qy - py * qx;
    }
    if denom < 1e-12 {
        return None;
    }
    let a = num_a / denom;
    let b = num_b / denom;
    let tx = dx - (a * sx - b * sy);
    let ty = dy - (b * sx + a * sy);
    Some(Affine2x3 {
        m00: a,
        m01: -b,
        m02: tx,
        m10: b,
        m11: a,
        m12: ty,
    })
}

/// Deterministic LMEDS-style 5-point similarity estimator mirroring cv2.estimateAffinePartial2D(LMEDS):
/// 1) Evaluates all C(n, 2) minimal 2-point similarity hypotheses (10 deterministic pairs for n=5).
/// 2) Selects the hypothesis minimizing the median squared residual across all points.
/// 3) Computes robust scale sigma = 1.4826 * sqrt(best_median_sq) and refines by LS over inliers.
pub fn estimate_similarity_lmeds(src: &[[f32; 2]; 5], dst: &[[f32; 2]; 5]) -> Option<Affine2x3> {
    let mut best_med = f64::INFINITY;
    let mut best_model: Option<Affine2x3> = None;

    for i in 0..5 {
        for j in (i + 1)..5 {
            let pair_src = [src[i], src[j]];
            let pair_dst = [dst[i], dst[j]];
            let Some(m) = estimate_similarity_ls(&pair_src, &pair_dst) else {
                continue;
            };
            let mut errs = [0.0f64; 5];
            for k in 0..5 {
                let p = m.apply(src[k]);
                let ex = p[0] - dst[k][0] as f64;
                let ey = p[1] - dst[k][1] as f64;
                errs[k] = ex * ex + ey * ey;
            }
            errs.sort_by(|a, b| a.total_cmp(b));
            let median_sq = errs[2];
            if median_sq < best_med {
                best_med = median_sq;
                best_model = Some(m);
            }
        }
    }

    let model = best_model?;
    // Outlier threshold following Huber/OpenCV LMEDS scale estimate (1.4826 * sqrt(med))
    let sigma = 1.4826 * best_med.sqrt();
    let thresh_sq = (2.5 * sigma).max(2.0).powi(2);

    let mut in_src = Vec::with_capacity(5);
    let mut in_dst = Vec::with_capacity(5);
    for k in 0..5 {
        let p = model.apply(src[k]);
        let ex = p[0] - dst[k][0] as f64;
        let ey = p[1] - dst[k][1] as f64;
        if ex * ex + ey * ey <= thresh_sq {
            in_src.push(src[k]);
            in_dst.push(dst[k]);
        }
    }
    if in_src.len() >= 2 {
        estimate_similarity_ls(&in_src, &in_dst).or(Some(model))
    } else {
        Some(model)
    }
}

pub fn rmse_5pt(m: &Affine2x3, src: &[[f32; 2]; 5], dst: &[[f32; 2]; 5]) -> f64 {
    let mut sum = 0.0;
    for i in 0..5 {
        let p = m.apply(src[i]);
        let ex = p[0] - dst[i][0] as f64;
        let ey = p[1] - dst[i][1] as f64;
        sum += ex * ex + ey * ey;
    }
    (sum / 5.0).sqrt()
}

/// Bilinear RGB warp into a 112x112 tight RGB24 buffer matching cv2.warpAffine(..., (112, 112), borderValue=0.0).
pub fn warp_rgb_112(
    rgb: &[u8],
    src_w: u32,
    src_h: u32,
    forward: &Affine2x3,
) -> Option<Vec<u8>> {
    let inv = forward.invert()?;
    let out_size = 112usize;
    let mut out = vec![0u8; out_size * out_size * 3];
    let w = src_w as i32;
    let h = src_h as i32;

    for dy in 0..out_size {
        for dx in 0..out_size {
            let sx = inv.m00 * dx as f64 + inv.m01 * dy as f64 + inv.m02;
            let sy = inv.m10 * dx as f64 + inv.m11 * dy as f64 + inv.m12;

            let x0 = sx.floor() as i32;
            let y0 = sy.floor() as i32;
            let fx = sx - x0 as f64;
            let fy = sy - y0 as f64;

            let w00 = (1.0 - fx) * (1.0 - fy);
            let w10 = fx * (1.0 - fy);
            let w01 = (1.0 - fx) * fy;
            let w11 = fx * fy;

            let sample = |x: i32, y: i32| -> [f64; 3] {
                if x < 0 || y < 0 || x >= w || y >= h {
                    [0.0, 0.0, 0.0]
                } else {
                    let idx = ((y as usize) * (src_w as usize) + (x as usize)) * 3;
                    [rgb[idx] as f64, rgb[idx + 1] as f64, rgb[idx + 2] as f64]
                }
            };

            let p00 = sample(x0, y0);
            let p10 = sample(x0 + 1, y0);
            let p01 = sample(x0, y0 + 1);
            let p11 = sample(x0 + 1, y0 + 1);

            let out_idx = (dy * out_size + dx) * 3;
            for c in 0..3 {
                let v = p00[c] * w00 + p10[c] * w10 + p01[c] * w01 + p11[c] * w11;
                out[out_idx + c] = v.round().clamp(0.0, 255.0) as u8;
            }
        }
    }
    Some(out)
}

pub fn l2_norm(v: &[f32]) -> f32 {
    let sum_sq: f64 = v.iter().map(|&x| (x as f64) * (x as f64)).sum();
    sum_sq.sqrt() as f32
}

pub fn l2_normalize(v: &[f32]) -> Vec<f32> {
    let norm = l2_norm(v);
    if !norm.is_finite() || norm <= 1e-12 {
        return vec![0.0; v.len()];
    }
    v.iter().map(|&x| x / norm).collect()
}

pub fn cosine_similarity(a: &[f32], b: &[f32]) -> f32 {
    if a.len() != b.len() || a.is_empty() {
        return 0.0;
    }
    let mut dot = 0.0f64;
    let mut na = 0.0f64;
    let mut nb = 0.0f64;
    for i in 0..a.len() {
        let xa = a[i] as f64;
        let xb = b[i] as f64;
        dot += xa * xb;
        na += xa * xa;
        nb += xb * xb;
    }
    let denom = (na * nb).sqrt();
    if denom <= 1e-12 {
        0.0
    } else {
        (dot / denom) as f32
    }
}

pub fn percentile_sorted(sorted: &[f64], p: f64) -> f64 {
    if sorted.is_empty() {
        return 0.0;
    }
    if sorted.len() == 1 {
        return sorted[0];
    }
    let idx = p.clamp(0.0, 1.0) * (sorted.len() - 1) as f64;
    let lo = idx.floor() as usize;
    let hi = idx.ceil() as usize;
    if lo == hi {
        sorted[lo]
    } else {
        let frac = idx - lo as f64;
        sorted[lo] * (1.0 - frac) + sorted[hi] * frac
    }
}

pub fn bucket_for_face_width(width_px: f32) -> &'static str {
    if width_px < 40.0 {
        "<40"
    } else if width_px < 60.0 {
        "40-59"
    } else if width_px < 80.0 {
        "60-79"
    } else if width_px < 100.0 {
        "80-99"
    } else if width_px < 130.0 {
        "100-129"
    } else {
        "130+"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn similarity_recovers_exact_transform() {
        let src = ARCFACE_DST_112;
        let scale = 2.0f32;
        let theta = 0.25f32;
        let tx = 310.0f32;
        let ty = 145.0f32;
        let mut warped_src = [[0.0f32; 2]; 5];
        for i in 0..5 {
            let x = src[i][0] * scale;
            let y = src[i][1] * scale;
            warped_src[i] = [
                x * theta.cos() - y * theta.sin() + tx,
                x * theta.sin() + y * theta.cos() + ty,
            ];
        }
        let m_ls = estimate_similarity_ls(&warped_src, &ARCFACE_DST_112).unwrap();
        let m_lmeds = estimate_similarity_lmeds(&warped_src, &ARCFACE_DST_112).unwrap();
        assert!(rmse_5pt(&m_ls, &warped_src, &ARCFACE_DST_112) < 1e-3);
        assert!(rmse_5pt(&m_lmeds, &warped_src, &ARCFACE_DST_112) < 1e-3);
        assert!(m_ls.max_abs_diff(&m_lmeds) < 1e-3);
    }

    #[test]
    fn lmeds_resists_single_landmark_outlier() {
        let mut pts = ARCFACE_DST_112;
        // Scale by 2x
        for p in &mut pts {
            p[0] *= 2.0;
            p[1] *= 2.0;
        }
        // Corrupt nose landmark by +30 px
        pts[2][0] += 30.0;
        let m_ls = estimate_similarity_ls(&pts, &ARCFACE_DST_112).unwrap();
        let m_lmeds = estimate_similarity_lmeds(&pts, &ARCFACE_DST_112).unwrap();
        // LMEDS ignores nose outlier and preserves exact scale 0.5 for the 4 clean points
        let p0 = m_lmeds.apply(pts[0]);
        let err0 = ((p0[0] - ARCFACE_DST_112[0][0] as f64).powi(2)
            + (p0[1] - ARCFACE_DST_112[0][1] as f64).powi(2))
        .sqrt();
        let p0_ls = m_ls.apply(pts[0]);
        let err0_ls = ((p0_ls[0] - ARCFACE_DST_112[0][0] as f64).powi(2)
            + (p0_ls[1] - ARCFACE_DST_112[0][1] as f64).powi(2))
        .sqrt();
        assert!(err0 < 0.05, "LMEDS error on clean point was {err0}");
        assert!(err0_ls > 1.0, "LS should be pulled by outlier, got {err0_ls}");
    }

    #[test]
    fn cosine_and_l2_normalize_work() {
        let a = l2_normalize(&[3.0, 4.0, 0.0]);
        assert!((l2_norm(&a) - 1.0).abs() < 1e-6);
        assert!((cosine_similarity(&a, &a) - 1.0).abs() < 1e-6);
        assert!(cosine_similarity(&[1.0, 0.0], &[0.0, 1.0]).abs() < 1e-6);
    }
}
