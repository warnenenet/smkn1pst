use image::{imageops::FilterType, RgbImage};
use ort::session::{builder::GraphOptimizationLevel, Session};
use ort::value::TensorRef;
use std::collections::HashMap;
use std::fmt;
use std::path::Path;

#[derive(Debug, Clone)]
pub struct DetectedFace {
    /// Bounding box [x1, y1, x2, y2] in source image pixels.
    pub bbox: [f32; 4],
    pub score: f32,
    /// Five facial landmarks: [left_eye, right_eye, nose, mouth_left, mouth_right].
    pub kps: [[f32; 2]; 5],
}

impl DetectedFace {
    pub fn width_px(&self) -> f32 {
        (self.bbox[2] - self.bbox[0]).max(0.0)
    }

    pub fn height_px(&self) -> f32 {
        (self.bbox[3] - self.bbox[1]).max(0.0)
    }

    pub fn min_side_px(&self) -> f32 {
        self.width_px().min(self.height_px())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LandmarkRejectionReason {
    IncompleteLandmarks,
    InvalidBbox,
    LandmarkOutsideBbox,
    SwappedEyes,
    SwappedMouth,
    NoseNotBetweenEyesAndMouth,
    EyesTooClose,
    ProportionOutOfRange,
}

impl fmt::Display for LandmarkRejectionReason {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let code = match self {
            Self::IncompleteLandmarks => "incomplete_landmarks",
            Self::InvalidBbox => "invalid_bbox",
            Self::LandmarkOutsideBbox => "landmark_outside_bbox",
            Self::SwappedEyes => "swapped_eyes",
            Self::SwappedMouth => "swapped_mouth",
            Self::NoseNotBetweenEyesAndMouth => "nose_not_between_eyes_and_mouth",
            Self::EyesTooClose => "eyes_too_close",
            Self::ProportionOutOfRange => "proportion_out_of_range",
        };
        f.write_str(code)
    }
}

/// Validates anatomical sanity of 5 landmarks inside the face bbox in O(1) time.
pub fn validate_five_landmarks(
    bbox: [f32; 4],
    kps: &[[f32; 2]; 5],
) -> Result<(), LandmarkRejectionReason> {
    for pt in kps {
        if !pt[0].is_finite() || !pt[1].is_finite() {
            return Err(LandmarkRejectionReason::IncompleteLandmarks);
        }
    }

    let bw = bbox[2] - bbox[0];
    let bh = bbox[3] - bbox[1];
    if bw <= 1.0 || bh <= 1.0 || !bw.is_finite() || !bh.is_finite() {
        return Err(LandmarkRejectionReason::InvalidBbox);
    }

    // 1. All 5 landmarks must fall within bbox (+5% tolerance margin).
    let mx = bw * 0.05;
    let my = bh * 0.05;
    let min_x = bbox[0] - mx;
    let max_x = bbox[2] + mx;
    let min_y = bbox[1] - my;
    let max_y = bbox[3] + my;
    for pt in kps {
        if pt[0] < min_x || pt[0] > max_x || pt[1] < min_y || pt[1] > max_y {
            return Err(LandmarkRejectionReason::LandmarkOutsideBbox);
        }
    }

    let left_eye = kps[0];
    let right_eye = kps[1];
    let nose = kps[2];
    let mouth_left = kps[3];
    let mouth_right = kps[4];

    // 2. Left eye and mouth-left must be to the left of right eye and mouth-right in image space.
    if left_eye[0] >= right_eye[0] {
        return Err(LandmarkRejectionReason::SwappedEyes);
    }
    if mouth_left[0] >= mouth_right[0] {
        return Err(LandmarkRejectionReason::SwappedMouth);
    }

    // 3. Nose Y must sit vertically between eye midpoint and mouth midpoint.
    let eye_mean_y = (left_eye[1] + right_eye[1]) * 0.5;
    let mouth_mean_y = (mouth_left[1] + mouth_right[1]) * 0.5;
    if !(nose[1] > eye_mean_y && nose[1] < mouth_mean_y) {
        return Err(LandmarkRejectionReason::NoseNotBetweenEyesAndMouth);
    }

    // 4. Inter-ocular distance must be >= 15% of bbox width.
    let eye_dist = ((right_eye[0] - left_eye[0]).powi(2) + (right_eye[1] - left_eye[1]).powi(2)).sqrt();
    if eye_dist < 0.15 * bw {
        return Err(LandmarkRejectionReason::EyesTooClose);
    }

    // 5. Vertical nose span ratio must be within [0.50, 2.0].
    let upper_span = nose[1] - eye_mean_y;
    let lower_span = mouth_mean_y - nose[1];
    if lower_span <= 1e-3 {
        return Err(LandmarkRejectionReason::ProportionOutOfRange);
    }
    let ratio = upper_span / lower_span;
    if !(0.50..=2.0).contains(&ratio) {
        return Err(LandmarkRejectionReason::ProportionOutOfRange);
    }

    Ok(())
}

pub struct ScrfdDetector {
    session: Session,
    input_size: usize,
    det_thresh: f32,
    nms_thresh: f32,
    anchor_cache: HashMap<(usize, usize, usize), Vec<[f32; 2]>>,
}

impl ScrfdDetector {
    pub fn load(
        model_path: &Path,
        intra_threads: usize,
        input_size: usize,
        det_thresh: f32,
        nms_thresh: f32,
    ) -> Result<Self, String> {
        let session = Session::builder()
            .map_err(|e| format!("ort Session::builder failed: {e}"))?
            .with_optimization_level(GraphOptimizationLevel::Level3)
            .map_err(|e| format!("ort opt level failed: {e}"))?
            .with_intra_threads(intra_threads.max(1))
            .map_err(|e| format!("ort with_intra_threads failed: {e}"))?
            .with_inter_threads(1)
            .map_err(|e| format!("ort with_inter_threads failed: {e}"))?
            .with_parallel_execution(false)
            .map_err(|e| format!("ort with_parallel_execution failed: {e}"))?
            .commit_from_file(model_path)
            .map_err(|e| format!("ort commit_from_file({}) failed: {e}", model_path.display()))?;

        Ok(Self {
            session,
            input_size: input_size.max(128),
            det_thresh,
            nms_thresh,
            anchor_cache: HashMap::new(),
        })
    }

    pub fn set_det_thresh(&mut self, thresh: f32) {
        self.det_thresh = thresh.clamp(0.15, 0.99);
    }

    pub fn detect_rgb(&mut self, rgb: &[u8], src_w: u32, src_h: u32) -> Result<Vec<DetectedFace>, String> {
        if src_w == 0 || src_h == 0 || rgb.len() != (src_w as usize) * (src_h as usize) * 3 {
            return Err("invalid RGB buffer for ScrfdDetector".to_string());
        }

        let target = self.input_size as u32;
        let im_ratio = src_h as f32 / src_w as f32;
        let (new_w, new_h) = if im_ratio > 1.0 {
            let nh = target;
            let nw = ((nh as f32) / im_ratio).max(1.0) as u32;
            (nw, nh)
        } else {
            let nw = target;
            let nh = ((nw as f32) * im_ratio).max(1.0) as u32;
            (nw, nh)
        };
        let det_scale = new_h as f32 / src_h as f32;

        let src_img = RgbImage::from_raw(src_w, src_h, rgb.to_vec())
            .ok_or_else(|| "invalid RGB image dimensions for ScrfdDetector".to_string())?;
        let resized = image::imageops::resize(&src_img, new_w, new_h, FilterType::Triangle);

        let side = target as usize;
        let plane = side * side;
        let zero_norm = -127.5f32 / 128.0f32;
        let mut blob = vec![zero_norm; 3 * plane];
        let rw = new_w as usize;
        let rh = new_h as usize;
        let raw_resized = resized.as_raw();
        for y in 0..rh {
            for x in 0..rw {
                let src_idx = (y * rw + x) * 3;
                let dst_idx = y * side + x;
                blob[dst_idx] = (raw_resized[src_idx] as f32 - 127.5) / 128.0;
                blob[plane + dst_idx] = (raw_resized[src_idx + 1] as f32 - 127.5) / 128.0;
                blob[2 * plane + dst_idx] = (raw_resized[src_idx + 2] as f32 - 127.5) / 128.0;
            }
        }

        let input = TensorRef::from_array_view(([1usize, 3, side, side], blob.as_slice()))
            .map_err(|e| format!("scrfd TensorRef failed: {e}"))?;
        let outputs = self
            .session
            .run(ort::inputs![input])
            .map_err(|e| format!("scrfd session.run failed: {e}"))?;

        let out_count = outputs.len();
        if out_count != 9 && out_count != 6 {
            return Err(format!(
                "expected 9 (det_10g with kps) or 6 outputs from SCRFD, got {out_count}"
            ));
        }

        let fmc = 3usize;
        let strides = [8usize, 16, 32];
        let num_anchors = 2usize;
        let use_kps = out_count == 9;

        let mut candidates = Vec::new();
        for (idx, &stride) in strides.iter().enumerate() {
            let feat_h = side / stride;
            let feat_w = side / stride;
            let centers = self
                .anchor_cache
                .entry((feat_h, feat_w, stride))
                .or_insert_with(|| build_anchor_centers(feat_h, feat_w, stride, num_anchors));

            let (_s_shape, scores) = outputs[idx]
                .try_extract_tensor::<f32>()
                .map_err(|e| format!("extract scores[{idx}] failed: {e}"))?;
            let (_b_shape, bboxes) = outputs[idx + fmc]
                .try_extract_tensor::<f32>()
                .map_err(|e| format!("extract bboxes[{idx}] failed: {e}"))?;
            let kpss_slice = if use_kps {
                Some(
                    outputs[idx + fmc * 2]
                        .try_extract_tensor::<f32>()
                        .map_err(|e| format!("extract kpss[{idx}] failed: {e}"))?
                        .1,
                )
            } else {
                None
            };

            decode_scrfd_level(
                scores,
                bboxes,
                kpss_slice,
                centers,
                stride,
                det_scale,
                self.det_thresh,
                src_w,
                src_h,
                &mut candidates,
            );
        }

        candidates.sort_by(|a, b| b.score.total_cmp(&a.score));
        Ok(nms(candidates, self.nms_thresh))
    }
}

pub fn build_anchor_centers(
    feat_h: usize,
    feat_w: usize,
    stride: usize,
    num_anchors: usize,
) -> Vec<[f32; 2]> {
    let mut out = Vec::with_capacity(feat_h * feat_w * num_anchors);
    let s = stride as f32;
    for y in 0..feat_h {
        for x in 0..feat_w {
            let cx = x as f32 * s;
            let cy = y as f32 * s;
            for _ in 0..num_anchors {
                out.push([cx, cy]);
            }
        }
    }
    out
}

#[allow(clippy::too_many_arguments)]
pub fn decode_scrfd_level(
    scores: &[f32],
    bboxes: &[f32],
    kpss: Option<&[f32]>,
    centers: &[[f32; 2]],
    stride: usize,
    det_scale: f32,
    det_thresh: f32,
    src_w: u32,
    src_h: u32,
    out: &mut Vec<DetectedFace>,
) {
    let stride_f = stride as f32;
    let max_w = src_w as f32;
    let max_h = src_h as f32;
    for (a_idx, &score) in scores.iter().enumerate() {
        if score < det_thresh || a_idx >= centers.len() {
            continue;
        }
        let b_off = a_idx * 4;
        if b_off + 3 >= bboxes.len() {
            continue;
        }
        let cx = centers[a_idx][0];
        let cy = centers[a_idx][1];
        let x1 = (cx - bboxes[b_off] * stride_f) / det_scale;
        let y1 = (cy - bboxes[b_off + 1] * stride_f) / det_scale;
        let x2 = (cx + bboxes[b_off + 2] * stride_f) / det_scale;
        let y2 = (cy + bboxes[b_off + 3] * stride_f) / det_scale;

        let mut kps = [[f32::NAN; 2]; 5];
        if let Some(kps_raw) = kpss {
            let k_off = a_idx * 10;
            if k_off + 9 < kps_raw.len() {
                for k in 0..5 {
                    kps[k] = [
                        (cx + kps_raw[k_off + k * 2] * stride_f) / det_scale,
                        (cy + kps_raw[k_off + k * 2 + 1] * stride_f) / det_scale,
                    ];
                }
            }
        }

        out.push(DetectedFace {
            bbox: [
                x1.clamp(0.0, max_w),
                y1.clamp(0.0, max_h),
                x2.clamp(0.0, max_w),
                y2.clamp(0.0, max_h),
            ],
            score,
            kps,
        });
    }
}

pub fn nms(mut boxes: Vec<DetectedFace>, iou_thresh: f32) -> Vec<DetectedFace> {
    boxes.sort_by(|a, b| b.score.total_cmp(&a.score));
    let mut keep = Vec::with_capacity(boxes.len());
    let mut suppressed = vec![false; boxes.len()];

    for i in 0..boxes.len() {
        if suppressed[i] {
            continue;
        }
        let a = &boxes[i];
        keep.push(a.clone());
        let area_a =
            (a.bbox[2] - a.bbox[0] + 1.0).max(0.0) * (a.bbox[3] - a.bbox[1] + 1.0).max(0.0);
        for j in (i + 1)..boxes.len() {
            if suppressed[j] {
                continue;
            }
            let b = &boxes[j];
            let xx1 = a.bbox[0].max(b.bbox[0]);
            let yy1 = a.bbox[1].max(b.bbox[1]);
            let xx2 = a.bbox[2].min(b.bbox[2]);
            let yy2 = a.bbox[3].min(b.bbox[3]);
            let w = (xx2 - xx1 + 1.0).max(0.0);
            let h = (yy2 - yy1 + 1.0).max(0.0);
            let inter = w * h;
            let area_b =
                (b.bbox[2] - b.bbox[0] + 1.0).max(0.0) * (b.bbox[3] - b.bbox[1] + 1.0).max(0.0);
            let union = area_a + area_b - inter;
            let iou = if union > 0.0 { inter / union } else { 0.0 };
            if iou > iou_thresh {
                suppressed[j] = true;
            }
        }
    }
    keep
}
