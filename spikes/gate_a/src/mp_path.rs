use mediapipe::{
    Confidence, Delegate, FaceDetector, FaceLandmarker, Image, IouThreshold, ModelSource, Size,
};
use serde::Serialize;
use std::num::NonZeroU32;
use std::path::Path;

#[derive(Debug, Clone, Serialize)]
pub struct MediaPipeFaceExtract {
    pub bbox: [f32; 4],      // [x1, y1, x2, y2] in pixel coordinates
    pub width_px: f32,
    pub landmark_count: usize,
    pub kps_5pt: [[f32; 2]; 5], // [viewer_left_eye, viewer_right_eye, nose, viewer_mouth_left, viewer_mouth_right]
    pub iris_left_eye: Option<[f32; 2]>,
    pub iris_right_eye: Option<[f32; 2]>,
    pub orientation_ok: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct MediaPipeVerification {
    pub mediapipe_lib_env: Option<String>,
    pub detector_model_path: String,
    pub detector_format: String,
    pub detector_loaded: bool,
    pub detector_faces_found: usize,
    pub detector_boxes: Vec<[i32; 4]>,
    pub detector_keypoint_count: Option<usize>,
    pub landmarker_model_path: String,
    pub landmarker_format: String,
    pub landmarker_loaded: bool,
    pub landmarker_faces_found: usize,
    pub faces: Vec<MediaPipeFaceExtract>,
}

pub struct MediaPipePathA {
    pub detector: Option<FaceDetector>,
    pub landmarker: FaceLandmarker,
}

impl MediaPipePathA {
    pub fn load(
        detector_tflite: Option<&Path>,
        landmarker_task: &Path,
        max_faces: u32,
        min_conf: f32,
    ) -> Result<Self, String> {
        let detector = match detector_tflite {
            Some(p) if p.exists() => Some(
                FaceDetector::builder(ModelSource::path(p))
                    .delegate(Delegate::Cpu)
                    .min_detection_confidence(
                        Confidence::new(min_conf).map_err(|e| format!("bad conf: {e}"))?,
                    )
                    .min_suppression_threshold(
                        IouThreshold::new(0.3).map_err(|e| format!("bad iou: {e}"))?,
                    )
                    .build()
                    .map_err(|e| format!("FaceDetector build({}) failed: {e}", p.display()))?,
            ),
            _ => None,
        };

        let nf = NonZeroU32::new(max_faces.max(1)).expect("non-zero");
        let conf = Confidence::new(min_conf).map_err(|e| format!("bad conf: {e}"))?;
        let landmarker = FaceLandmarker::builder(ModelSource::path(landmarker_task))
            .delegate(Delegate::Cpu)
            .num_faces(nf)
            .min_face_detection_confidence(conf)
            .min_face_presence_confidence(conf)
            .build()
            .map_err(|e| {
                format!(
                    "FaceLandmarker build({}) failed: {e}",
                    landmarker_task.display()
                )
            })?;

        Ok(Self {
            detector,
            landmarker,
        })
    }

    pub fn detect_landmarker_rgb(
        &mut self,
        rgb: &[u8],
        width: u32,
        height: u32,
    ) -> Result<Vec<MediaPipeFaceExtract>, String> {
        let size = Size { width, height };
        let mp_img =
            Image::from_rgb(size, rgb).map_err(|e| format!("MediaPipe Image::from_rgb failed: {e}"))?;
        let res = self
            .landmarker
            .detect(&mp_img)
            .map_err(|e| format!("FaceLandmarker::detect failed: {e}"))?;

        let mut out = Vec::with_capacity(res.landmarks.len());
        for lms in &res.landmarks {
            if let Some(extracted) = extract_5pt_from_mesh(lms, size) {
                out.push(extracted);
            }
        }
        Ok(out)
    }

    pub fn detect_blazeface_rgb(
        &mut self,
        rgb: &[u8],
        width: u32,
        height: u32,
    ) -> Result<Vec<[f32; 4]>, String> {
        let Some(det) = self.detector.as_mut() else {
            return Ok(Vec::new());
        };
        let size = Size { width, height };
        let mp_img =
            Image::from_rgb(size, rgb).map_err(|e| format!("MediaPipe Image::from_rgb failed: {e}"))?;
        let detections = det
            .detect(&mp_img)
            .map_err(|e| format!("FaceDetector::detect failed: {e}"))?;
        Ok(detections
            .into_iter()
            .map(|d| {
                [
                    d.bounding_box.left() as f32,
                    d.bounding_box.top() as f32,
                    d.bounding_box.right() as f32,
                    d.bounding_box.bottom() as f32,
                ]
            })
            .collect())
    }
}

/// Canonical Google MediaPipe FaceMesh indices:
/// - Person's right eye (viewer LEFT in non-mirrored camera image): outer=33, inner=133, iris=468
/// - Person's left eye (viewer RIGHT in non-mirrored camera image): inner=362, outer=263, iris=473
/// - Nose tip: 1
/// - Mouth corners: person's right (viewer LEFT) = 61, person's left (viewer RIGHT) = 291
pub fn extract_5pt_from_mesh(
    lms: &[mediapipe::NormalizedLandmark],
    size: Size,
) -> Option<MediaPipeFaceExtract> {
    if lms.len() < 468 {
        return None;
    }

    let pt = |idx: usize| -> [f32; 2] {
        let p = lms[idx].point.to_pixels(size);
        [p.x(), p.y()]
    };

    // Viewer left eye = midpoint(33, 133); Viewer right eye = midpoint(362, 263)
    let p33 = pt(33);
    let p133 = pt(133);
    let mut left_eye = [(p33[0] + p133[0]) * 0.5, (p33[1] + p133[1]) * 0.5];

    let p362 = pt(362);
    let p263 = pt(263);
    let mut right_eye = [(p362[0] + p263[0]) * 0.5, (p362[1] + p263[1]) * 0.5];

    let nose = pt(1);
    let mut mouth_left = pt(61);
    let mut mouth_right = pt(291);

    let iris_left_eye = if lms.len() >= 478 { Some(pt(468)) } else { None };
    let iris_right_eye = if lms.len() >= 478 { Some(pt(473)) } else { None };

    // Orientation check in image coordinates (viewer left < viewer right)
    let orientation_ok = left_eye[0] < right_eye[0]
        && mouth_left[0] < mouth_right[0]
        && nose[1] > (left_eye[1] + right_eye[1]) * 0.5
        && nose[1] < (mouth_left[1] + mouth_right[1]) * 0.5;

    if !orientation_ok && left_eye[0] > right_eye[0] {
        // Record canonical anatomical flip only if needed, though orientation_ok=false alerts Gate A
        std::mem::swap(&mut left_eye, &mut right_eye);
        std::mem::swap(&mut mouth_left, &mut mouth_right);
    }

    let mut min_x = f32::INFINITY;
    let mut min_y = f32::INFINITY;
    let mut max_x = f32::NEG_INFINITY;
    let mut max_y = f32::NEG_INFINITY;
    for lm in lms.iter().take(468) {
        let p = lm.point.to_pixels(size);
        min_x = min_x.min(p.x());
        min_y = min_y.min(p.y());
        max_x = max_x.max(p.x());
        max_y = max_y.max(p.y());
    }
    let width_px = (max_x - min_x).max(0.0);

    Some(MediaPipeFaceExtract {
        bbox: [min_x, min_y, max_x, max_y],
        width_px,
        landmark_count: lms.len(),
        kps_5pt: [left_eye, right_eye, nose, mouth_left, mouth_right],
        iris_left_eye,
        iris_right_eye,
        orientation_ok,
    })
}

pub fn verify_mediapipe_once(
    detector_tflite: &Path,
    landmarker_task: &Path,
    image_path: &Path,
) -> Result<MediaPipeVerification, String> {
    let mp_img = Image::from_file(image_path)
        .map_err(|e| format!("Image::from_file({}) failed: {e}", image_path.display()))?;
    let size = image::image_dimensions(image_path)
        .map(|(w, h)| Size { width: w, height: h })
        .map_err(|e| format!("image_dimensions failed: {e}"))?;

    let mut detector = FaceDetector::builder(ModelSource::path(detector_tflite))
        .delegate(Delegate::Cpu)
        .min_detection_confidence(Confidence::new(0.3).unwrap())
        .min_suppression_threshold(IouThreshold::new(0.3).unwrap())
        .build()
        .map_err(|e| format!("FaceDetector::builder failed: {e}"))?;
    let detections = detector
        .detect(&mp_img)
        .map_err(|e| format!("FaceDetector::detect failed: {e}"))?;

    let detector_boxes: Vec<[i32; 4]> = detections
        .iter()
        .map(|d| {
            [
                d.bounding_box.left(),
                d.bounding_box.top(),
                d.bounding_box.right(),
                d.bounding_box.bottom(),
            ]
        })
        .collect();
    let detector_keypoint_count = detections.first().map(|d| d.keypoints.len());

    let mut landmarker = FaceLandmarker::builder(ModelSource::path(landmarker_task))
        .delegate(Delegate::Cpu)
        .num_faces(NonZeroU32::new(10).unwrap())
        .min_face_detection_confidence(Confidence::new(0.3).unwrap())
        .min_face_presence_confidence(Confidence::new(0.3).unwrap())
        .build()
        .map_err(|e| format!("FaceLandmarker::builder failed: {e}"))?;
    let lm_res = landmarker
        .detect(&mp_img)
        .map_err(|e| format!("FaceLandmarker::detect failed: {e}"))?;

    let faces: Vec<MediaPipeFaceExtract> = lm_res
        .landmarks
        .iter()
        .filter_map(|lms| extract_5pt_from_mesh(lms, size))
        .collect();

    Ok(MediaPipeVerification {
        mediapipe_lib_env: std::env::var("MEDIAPIPE_LIB").ok(),
        detector_model_path: detector_tflite.display().to_string(),
        detector_format: ".tflite (FlatBuffer LiteRT)".to_string(),
        detector_loaded: true,
        detector_faces_found: detections.len(),
        detector_boxes,
        detector_keypoint_count,
        landmarker_model_path: landmarker_task.display().to_string(),
        landmarker_format: ".task (MediaPipe Task Zip Bundle)".to_string(),
        landmarker_loaded: true,
        landmarker_faces_found: faces.len(),
        faces,
    })
}
