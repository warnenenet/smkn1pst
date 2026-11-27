use crate::math::l2_normalize;
use image::{RgbImage, imageops::FilterType};
use ort::session::{Session, builder::GraphOptimizationLevel};
use ort::value::TensorRef;
use std::collections::HashMap;
use std::path::Path;

#[derive(Debug, Clone)]
pub struct DetectedFace {
    pub bbox: [f32; 4],      // [x1, y1, x2, y2] in original frame pixels
    pub score: f32,
    pub kps: [[f32; 2]; 5],  // [left_eye, right_eye, nose, mouth_left, mouth_right]
}

impl DetectedFace {
    pub fn width_px(&self) -> f32 {
        (self.bbox[2] - self.bbox[0]).max(0.0)
    }
}

pub struct ArcFaceEmbedder {
    session: Session,
}

impl ArcFaceEmbedder {
    pub fn load(model_path: &Path, intra_threads: usize) -> Result<Self, String> {
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
        Ok(Self { session })
    }

    /// Expects tight 112x112 RGB24 bytes (112 * 112 * 3).
    /// Matches InsightFace ArcFaceONNX: NCHW RGB with (x - 127.5) / 127.5, L2-normalized.
    pub fn embed_rgb_112(&mut self, rgb112: &[u8]) -> Result<Vec<f32>, String> {
        let plane = 112 * 112;
        if rgb112.len() != plane * 3 {
            return Err(format!(
                "expected 112x112x3 ({}) bytes, got {}",
                plane * 3,
                rgb112.len()
            ));
        }

        let mut blob = vec![0.0f32; 3 * plane];
        for i in 0..plane {
            let p = i * 3;
            blob[i] = (rgb112[p] as f32 - 127.5) / 127.5;
            blob[plane + i] = (rgb112[p + 1] as f32 - 127.5) / 127.5;
            blob[2 * plane + i] = (rgb112[p + 2] as f32 - 127.5) / 127.5;
        }

        let input = TensorRef::from_array_view(([1usize, 3, 112, 112], blob.as_slice()))
            .map_err(|e| format!("arcface TensorRef failed: {e}"))?;
        let outputs = self
            .session
            .run(ort::inputs![input])
            .map_err(|e| format!("arcface session.run failed: {e}"))?;
        let (_shape, data) = outputs[0]
            .try_extract_tensor::<f32>()
            .map_err(|e| format!("arcface try_extract_tensor failed: {e}"))?;
        if data.len() != 512 {
            return Err(format!("expected 512-D embedding, got {}", data.len()));
        }
        Ok(l2_normalize(data))
    }
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

    pub fn detect_rgb(&mut self, rgb: &[u8], src_w: u32, src_h: u32) -> Result<Vec<DetectedFace>, String> {
        let target = self.input_size as u32;
        let im_ratio = src_h as f32 / src_w as f32;
        let model_ratio = 1.0f32;
        let (new_w, new_h) = if im_ratio > model_ratio {
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
            .ok_or_else(|| "invalid RGB buffer size for ScrfdDetector".to_string())?;
        let resized = image::imageops::resize(&src_img, new_w, new_h, FilterType::Triangle);

        let side = target as usize;
        let plane = side * side;
        // Pad bottom/right with 0 -> (-127.5 / 128.0) matching InsightFace det_img = np.zeros(...)
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

        let mut candidates: Vec<DetectedFace> = Vec::new();
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

            let stride_f = stride as f32;
            for (a_idx, &score) in scores.iter().enumerate() {
                if score < self.det_thresh || a_idx >= centers.len() {
                    continue;
                }
                let cx = centers[a_idx][0];
                let cy = centers[a_idx][1];
                let b_off = a_idx * 4;
                if b_off + 3 >= bboxes.len() {
                    continue;
                }
                let x1 = (cx - bboxes[b_off] * stride_f) / det_scale;
                let y1 = (cy - bboxes[b_off + 1] * stride_f) / det_scale;
                let x2 = (cx + bboxes[b_off + 2] * stride_f) / det_scale;
                let y2 = (cy + bboxes[b_off + 3] * stride_f) / det_scale;

                let mut kps = [[0.0f32; 2]; 5];
                if let Some(kps_raw) = kpss_slice {
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

                candidates.push(DetectedFace {
                    bbox: [
                        x1.clamp(0.0, src_w as f32),
                        y1.clamp(0.0, src_h as f32),
                        x2.clamp(0.0, src_w as f32),
                        y2.clamp(0.0, src_h as f32),
                    ],
                    score,
                    kps,
                });
            }
        }

        candidates.sort_by(|a, b| b.score.total_cmp(&a.score));
        Ok(nms(candidates, self.nms_thresh))
    }
}

pub fn build_anchor_centers(feat_h: usize, feat_w: usize, stride: usize, num_anchors: usize) -> Vec<[f32; 2]> {
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

pub fn nms(sorted_desc: Vec<DetectedFace>, iou_thresh: f32) -> Vec<DetectedFace> {
    let mut keep = Vec::new();
    let mut suppressed = vec![false; sorted_desc.len()];

    for i in 0..sorted_desc.len() {
        if suppressed[i] {
            continue;
        }
        let a = &sorted_desc[i];
        keep.push(a.clone());
        let area_a = (a.bbox[2] - a.bbox[0] + 1.0).max(0.0) * (a.bbox[3] - a.bbox[1] + 1.0).max(0.0);
        for j in (i + 1)..sorted_desc.len() {
            if suppressed[j] {
                continue;
            }
            let b = &sorted_desc[j];
            let xx1 = a.bbox[0].max(b.bbox[0]);
            let yy1 = a.bbox[1].max(b.bbox[1]);
            let xx2 = a.bbox[2].min(b.bbox[2]);
            let yy2 = a.bbox[3].min(b.bbox[3]);
            let w = (xx2 - xx1 + 1.0).max(0.0);
            let h = (yy2 - yy1 + 1.0).max(0.0);
            let inter = w * h;
            let area_b = (b.bbox[2] - b.bbox[0] + 1.0).max(0.0) * (b.bbox[3] - b.bbox[1] + 1.0).max(0.0);
            let union = area_a + area_b - inter;
            let iou = if union > 0.0 { inter / union } else { 0.0 };
            if iou > iou_thresh {
                suppressed[j] = true;
            }
        }
    }
    keep
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn anchor_centers_match_scrfd_order() {
        // 640 / 32 = 20 -> 20 * 20 * 2 = 800 anchors
        let c = build_anchor_centers(20, 20, 32, 2);
        assert_eq!(c.len(), 800);
        assert_eq!(c[0], [0.0, 0.0]);
        assert_eq!(c[1], [0.0, 0.0]);
        assert_eq!(c[2], [32.0, 0.0]);
        assert_eq!(c[40], [0.0, 32.0]);
    }
}
