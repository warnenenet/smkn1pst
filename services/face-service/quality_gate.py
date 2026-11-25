import math
from dataclasses import dataclass
from typing import Any, Callable, Dict, Optional, Sequence, Tuple
from urllib.parse import urlparse

try:
    import cv2  # type: ignore
except Exception:
    cv2 = None

try:
    import numpy as np  # type: ignore
except Exception:
    np = None


ARCFACE_DST_112 = (
    (38.2946, 51.6963),
    (73.5318, 51.5014),
    (56.0252, 71.7366),
    (41.5493, 92.3655),
    (70.7299, 92.2041),
)


@dataclass
class GateResult:
    passed: bool
    reason: Optional[str]
    detail: Optional[str]
    face_size_px: int
    blur_variance: Optional[float]
    yaw_deg: Optional[float]
    pitch_deg: Optional[float]
    frontal_score: float


def compute_downscale_plan(src_w: int, src_h: int, max_side: int = 640) -> Tuple[int, int, float, float, bool]:
    w = max(1, int(src_w))
    h = max(1, int(src_h))
    longest = max(w, h)
    if longest <= max_side:
        return w, h, 1.0, 1.0, False
    ratio = float(max_side) / float(longest)
    dst_w = max(2, int(round(w * ratio)))
    dst_h = max(2, int(round(h * ratio)))
    return dst_w, dst_h, float(w) / float(dst_w), float(h) / float(dst_h), True


def _valid_pt(pt: Any) -> bool:
    if pt is None or len(pt) < 2:
        return False
    x, y = float(pt[0]), float(pt[1])
    return math.isfinite(x) and math.isfinite(y)


def validate_five_landmarks(bbox: Sequence[float], kps: Optional[Sequence[Sequence[float]]]) -> Tuple[bool, str]:
    """
    Validasi 5 landmark O(1):
    Urutan kps: [left_eye, right_eye, nose, mouth_left, mouth_right].
    TANPA fallback bbox-only jika landmark < 5 atau invalid.
    """
    if kps is None or len(kps) < 5:
        return False, "incomplete_landmarks"
    for i in range(5):
        if not _valid_pt(kps[i]):
            return False, "incomplete_landmarks"

    x1, y1, x2, y2 = float(bbox[0]), float(bbox[1]), float(bbox[2]), float(bbox[3])
    bw = x2 - x1
    bh = y2 - y1
    if bw <= 1.0 or bh <= 1.0:
        return False, "invalid_bbox"

    # 1. Semua 5 landmark berada di dalam bbox dengan margin 5%
    mx = bw * 0.05
    my = bh * 0.05
    for i in range(5):
        px, py = float(kps[i][0]), float(kps[i][1])
        if px < x1 - mx or px > x2 + mx or py < y1 - my or py > y2 + my:
            return False, "landmark_outside_bbox"

    le_x, le_y = float(kps[0][0]), float(kps[0][1])
    re_x, re_y = float(kps[1][0]), float(kps[1][1])
    nose_x, nose_y = float(kps[2][0]), float(kps[2][1])
    ml_x, ml_y = float(kps[3][0]), float(kps[3][1])
    mr_x, mr_y = float(kps[4][0]), float(kps[4][1])

    # 2. left_eye.x < right_eye.x & mouth_left.x < mouth_right.x
    if not (le_x < re_x):
        return False, "swapped_eyes"
    if not (ml_x < mr_x):
        return False, "swapped_mouth"

    eye_mean_y = (le_y + re_y) * 0.5
    mouth_mean_y = (ml_y + mr_y) * 0.5

    # 3 & 4. Hidung di antara mata dan mulut, mulut di bawah hidung
    if not (nose_y > eye_mean_y and nose_y < mouth_mean_y):
        return False, "nose_not_between_eyes_and_mouth"
    if not (mouth_mean_y > nose_y):
        return False, "mouth_above_nose"

    # 5. Jarak antarmata >= 15% lebar bbox
    eye_dist = math.hypot(re_x - le_x, re_y - le_y)
    if eye_dist < 0.15 * bw:
        return False, "eyes_too_close"

    # 6. Proporsi vertikal hidung dalam [0.50, 2.0] (mengakomodasi sudut CCTV atas 15-25 deg)
    upper = nose_y - eye_mean_y
    lower = mouth_mean_y - nose_y
    if lower <= 1e-3:
        return False, "degenerate_lower_face"
    ratio = upper / lower
    if ratio < 0.50 or ratio > 2.0:
        return False, "proportion_out_of_range"

    return True, "ok"


def estimate_pose_deg_from_5pts(kps: Sequence[Sequence[float]]) -> Tuple[float, float, float]:
    le_x, le_y = float(kps[0][0]), float(kps[0][1])
    re_x, re_y = float(kps[1][0]), float(kps[1][1])
    nose_x, nose_y = float(kps[2][0]), float(kps[2][1])
    ml_x, ml_y = float(kps[3][0]), float(kps[3][1])
    mr_x, mr_y = float(kps[4][0]), float(kps[4][1])

    dx_eye = re_x - le_x
    dy_eye = re_y - le_y
    eye_dist = max(1e-3, math.hypot(dx_eye, dy_eye))
    roll_rad = math.atan2(dy_eye, dx_eye)

    eye_mid_x = (le_x + re_x) * 0.5
    eye_mid_y = (le_y + re_y) * 0.5
    mouth_mid_x = (ml_x + mr_x) * 0.5
    mouth_mid_y = (ml_y + mr_y) * 0.5

    cos_r = math.cos(-roll_rad)
    sin_r = math.sin(-roll_rad)
    rot_nose_x = (nose_x - eye_mid_x) * cos_r - (nose_y - eye_mid_y) * sin_r
    rot_nose_y = (nose_x - eye_mid_x) * sin_r + (nose_y - eye_mid_y) * cos_r
    rot_mouth_x = (mouth_mid_x - eye_mid_x) * cos_r - (mouth_mid_y - eye_mid_y) * sin_r
    rot_mouth_y = (mouth_mid_x - eye_mid_x) * sin_r + (mouth_mid_y - eye_mid_y) * cos_r

    face_center_x = rot_mouth_x * 0.5
    half_eye = max(1e-3, eye_dist * 0.5)
    yaw_norm = max(-1.0, min(1.0, ((rot_nose_x - face_center_x) / half_eye) * 0.72))
    yaw_deg = math.degrees(math.asin(yaw_norm))

    eye_to_mouth = max(1e-3, rot_mouth_y)
    rel_nose_y = rot_nose_y / eye_to_mouth
    pitch_norm = (rel_nose_y - 0.5) / 0.35
    pitch_deg = max(-80.0, min(80.0, pitch_norm * 45.0))

    return round(yaw_deg, 2), round(pitch_deg, 2), round(math.degrees(roll_rad), 2)


def compute_laplacian_variance_bgr(crop: Any) -> float:
    if crop is None or getattr(crop, "size", 0) == 0:
        return 0.0
    if cv2 is not None:
        h, w = crop.shape[:2]
        if h < 3 or w < 3:
            return 0.0
        gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY) if len(crop.shape) == 3 else crop
        return float(cv2.Laplacian(gray, cv2.CV_64F).var())
    return 0.0


def evaluate_pre_embedding_gates(
    confidence: float,
    bbox: Sequence[float],
    kps: Optional[Sequence[Sequence[float]]],
    min_face_size_px: int,
    compute_blur_fn: Callable[[], float],
    settings: Dict[str, Any],
    max_face_size_px: int = 0,
) -> GateResult:
    x1, y1, x2, y2 = float(bbox[0]), float(bbox[1]), float(bbox[2]), float(bbox[3])
    face_px = int(round(min(max(0.0, x2 - x1), max(0.0, y2 - y1))))

    thresh_conf = float(settings.get("threshold_confidence", 0.60))
    if not math.isfinite(confidence) or confidence < thresh_conf:
        return GateResult(False, "confidence", f"conf={confidence:.2f}<{thresh_conf:.2f}", face_px, None, None, None, 0.0)

    lm_ok, lm_reason = validate_five_landmarks(bbox, kps)
    if not lm_ok:
        return GateResult(False, "landmark", lm_reason, face_px, None, None, None, 0.0)

    eff_min_size = max(16, int(min_face_size_px))
    if face_px < eff_min_size:
        return GateResult(False, "size", f"px={face_px}<{eff_min_size}", face_px, None, None, None, 0.0)

    raw_max_size = int(max_face_size_px or 0)
    if raw_max_size > 0:
        eff_max_size = max(eff_min_size, raw_max_size)
        if face_px > eff_max_size:
            return GateResult(False, "size", f"px={face_px}>{eff_max_size}", face_px, None, None, None, 0.0)

    blur_thresh = float(settings.get("blur_threshold", 100.0))
    blur_var = float(compute_blur_fn())
    if not math.isfinite(blur_var) or blur_var < blur_thresh:
        return GateResult(False, "blur", f"lap={blur_var:.0f}<{blur_thresh:.0f}", face_px, round(blur_var, 2), None, None, 0.0)

    yaw_deg, pitch_deg, _ = estimate_pose_deg_from_5pts(kps)  # type: ignore[arg-type]
    max_yaw = float(settings.get("max_yaw_deg", 30.0))
    max_pitch = float(settings.get("max_pitch_deg", 25.0))
    if abs(yaw_deg) > max_yaw or abs(pitch_deg) > max_pitch:
        return GateResult(False, "pose", f"yaw={yaw_deg:.0f}/pitch={pitch_deg:.0f}", face_px, round(blur_var, 2), yaw_deg, pitch_deg, 0.0)

    frontal_score = max(0.1, min(1.0, 1.0 - (abs(yaw_deg) / 45.0) * 0.65 - (abs(pitch_deg) / 35.0) * 0.35))
    return GateResult(True, None, None, face_px, round(blur_var, 2), yaw_deg, pitch_deg, round(frontal_score, 4))


def align_face_5pt_112(img: Any, kps: Sequence[Sequence[float]]) -> Optional[Any]:
    if cv2 is None or np is None or img is None:
        return None
    src = np.asarray(kps[:5], dtype=np.float32)
    dst = np.asarray(ARCFACE_DST_112, dtype=np.float32)
    m, _ = cv2.estimateAffinePartial2D(src, dst, method=cv2.LMEDS)
    if m is None:
        return None
    return cv2.warpAffine(img, m, (112, 112), borderValue=0.0)


def resolve_adaptive_recognition_threshold(
    quality_score: float,
    settings: Optional[Dict[str, Any]] = None,
) -> Tuple[bool, float, str]:
    """
    Adaptive threshold berdasar quality_score:
    - quality_score < 0.70 -> (False, 1.0, 'low_quality')
    - adaptive_threshold_enabled == False -> (True, threshold_recognition, 'fixed')
    - quality_score >= 0.85 -> (True, threshold_high_quality (0.60), 'high_quality')
    - 0.70 <= quality_score < 0.85 -> (True, threshold_mid_quality (0.75), 'mid_quality')
    """
    cfg = settings or {}
    q = float(quality_score) if math.isfinite(quality_score) else 0.0
    if q < 0.70:
        return False, 1.0, "low_quality"
    enabled = cfg.get("adaptive_threshold_enabled", True)
    if enabled is False:
        base = float(cfg.get("threshold_recognition", 0.70))
        return True, base, "fixed"
    if q >= 0.85:
        high_t = float(cfg.get("threshold_high_quality", 0.60))
        return True, high_t, "high_quality"
    mid_t = float(cfg.get("threshold_mid_quality", 0.75))
    return True, mid_t, "mid_quality"


def evaluate_top1_top2_margin(
    candidates: Sequence[Tuple[int, float]],
    threshold: float,
    min_margin: float = 0.08,
) -> Tuple[Optional[int], float, float, float, Optional[str]]:
    """
    Evaluasi top-1 dan top-2 lintas ID siswa unik.
    Mengembalikan: (best_id, best_similarity, second_similarity, margin, rejected_reason).
    Jika top1 >= threshold namun (top1 - top2) < min_margin -> best_id = None, reason = 'ambiguous_margin'.
    """
    top1_id: Optional[int] = None
    top1_sim = -math.inf
    top2_id: Optional[int] = None
    top2_sim = -math.inf

    for sid, sim in candidates:
        s = float(sim)
        if not math.isfinite(s):
            continue
        if s > top1_sim:
            if top1_id is not None and top1_id != sid and top1_sim > top2_sim:
                top2_sim = top1_sim
                top2_id = top1_id
            top1_sim = s
            top1_id = int(sid)
        elif sid != top1_id and s > top2_sim:
            top2_sim = s
            top2_id = int(sid)

    safe_top1 = max(0.0, top1_sim) if math.isfinite(top1_sim) else 0.0
    safe_top2 = max(0.0, top2_sim) if (top2_id is not None and math.isfinite(top2_sim)) else 0.0
    has_runner_up = top2_id is not None
    margin = max(0.0, safe_top1 - safe_top2) if has_runner_up else safe_top1
    eff_margin = max(0.0, float(min_margin))

    if top1_id is None or safe_top1 < threshold:
        reason = "no_match" if top1_id is None else "below_threshold"
        return None, 0.0, safe_top2, margin, reason

    if has_runner_up and eff_margin > 0.0 and margin < eff_margin - 1e-9:
        return None, 0.0, safe_top2, margin, "ambiguous_margin"

    return top1_id, safe_top1, safe_top2, margin, None


def compute_ort_thread_budget(
    cpu_count: int,
    worker_instances: Optional[int] = None,
    intra_override: Optional[int] = None,
) -> Tuple[int, int, int]:
    """
    Optimasi thread ONNX Runtime agar menyisakan 2-4 core untuk Node + SQLite + WA Gateway:
    - 8 vCPU -> 2 workers x 3 intra_op_num_threads = 6 thread ORT total (sisa 2 core bebas).
    - 4 vCPU -> 2 workers x 1 intra_op_num_threads = 2 thread ORT total (atau 2 thread pada 1 worker).
    Returns: (face_worker_instances, intra_op_num_threads, inter_op_num_threads)
    """
    cpus = max(1, int(cpu_count or 4))
    if worker_instances is not None:
        workers = max(1, min(8, int(worker_instances)))
    else:
        workers = 2 if cpus >= 4 else 1

    if intra_override is not None:
        intra = max(1, min(cpus, int(intra_override)))
    else:
        available_for_ort = max(1, cpus - 2) if cpus >= 4 else 1
        intra = max(1, min(3, available_for_ort // workers))

    return workers, intra, 1


def resolve_safe_loopback_backend_url(raw_url: Optional[str]) -> Optional[str]:
    """
    Validasi URL backend internal dari Node agar hanya menerima alamat loopback lokal
    (127.0.0.1 / localhost / ::1) pada protokol http/https dengan port valid 1..65535.
    """
    if not raw_url or not isinstance(raw_url, str):
        return None
    candidate = raw_url.strip()
    if not candidate:
        return None
    try:
        parsed = urlparse(candidate)
    except Exception:
        return None
    scheme = (parsed.scheme or "").lower()
    if scheme not in ("http", "https"):
        return None
    host = (parsed.hostname or "").strip().lower()
    if host not in ("127.0.0.1", "localhost", "::1"):
        return None
    try:
        port = parsed.port
    except ValueError:
        return None
    if port is None or port < 1 or port > 65535:
        return None
    formatted_host = "[::1]" if host == "::1" else host
    return f"{scheme}://{formatted_host}:{port}"

