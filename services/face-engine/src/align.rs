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
        if det.abs() < 1e-12 || !det.is_finite() {
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

/// 4-DOF proper similarity least squares (rotation + uniform scale + translation).
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

/// Deterministic 5-point LMEDS similarity estimator mirroring OpenCV estimateAffinePartial2D(LMEDS).
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

pub fn reprojection_rmse_5pt(m: &Affine2x3, src: &[[f32; 2]; 5], dst: &[[f32; 2]; 5]) -> f64 {
    let mut sum = 0.0;
    for i in 0..5 {
        let p = m.apply(src[i]);
        let ex = p[0] - dst[i][0] as f64;
        let ey = p[1] - dst[i][1] as f64;
        sum += ex * ex + ey * ey;
    }
    (sum / 5.0).sqrt()
}

/// Bilinear RGB24 warp into a tight 112x112 buffer (border = 0.0, matching InsightFace norm_crop).
pub fn warp_rgb_112(rgb: &[u8], src_w: u32, src_h: u32, forward: &Affine2x3) -> Option<Vec<u8>> {
    if src_w == 0 || src_h == 0 || rgb.len() != (src_w as usize) * (src_h as usize) * 3 {
        return None;
    }
    let inv = forward.invert()?;
    let out_size = 112usize;
    let mut out = vec![0u8; out_size * out_size * 3];
    let w = src_w as i32;
    let h = src_h as i32;
    let stride_px = src_w as usize;

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
                    let idx = ((y as usize) * stride_px + (x as usize)) * 3;
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
