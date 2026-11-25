import base64
import json
import os
import queue
import subprocess
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

WIB_TZ = timezone(timedelta(hours=7))


def now_wib_str() -> str:
    return datetime.now(WIB_TZ).strftime("%Y-%m-%d %H:%M:%S")


import cv2
import httpx
import numpy as np
import onnxruntime as ort
from fastapi import FastAPI, HTTPException
from insightface.app import FaceAnalysis
from pydantic import BaseModel

from quality_gate import (
    align_face_5pt_112,
    compute_downscale_plan,
    compute_laplacian_variance_bgr,
    compute_ort_thread_budget,
    evaluate_pre_embedding_gates,
    evaluate_top1_top2_margin,
    resolve_adaptive_recognition_threshold,
)
from tracker import IoUTracker, TrackVoteBuffer

_CPU_COUNT = os.cpu_count() or 4
_ENV_WORKERS = os.environ.get("FACE_WORKER_INSTANCES")
_ENV_INTRA = os.environ.get("ORT_INTRA_THREADS")
FACE_WORKER_INSTANCES, _ORT_INTRA_THREADS, _ORT_INTER_THREADS = compute_ort_thread_budget(
    _CPU_COUNT,
    worker_instances=int(_ENV_WORKERS) if _ENV_WORKERS else None,
    intra_override=int(_ENV_INTRA) if _ENV_INTRA else None,
)

# Optimasi thread CPU & FFmpeg untuk VPS 4-8 vCPU (sisakan 2-4 core untuk Node + SQLite + WA Gateway)
os.environ.setdefault("OMP_NUM_THREADS", str(_ORT_INTRA_THREADS))
os.environ.setdefault("OPENBLAS_NUM_THREADS", "1")
os.environ.setdefault("OPENCV_FFMPEG_CAPTURE_OPTIONS", "rtsp_transport;tcp|rw_timeout;5000000|fflags;nobuffer|flags;low_delay")

WEB_BACKEND_URL = os.environ.get("WEB_BACKEND_URL", f"http://127.0.0.1:{os.environ.get('PORT', '3000')}")
MODEL_DIR = os.environ.get("INSIGHTFACE_HOME", "/app/models/insightface")
RUST_ACCEL_BIN = os.environ.get("RUST_ACCEL_BIN", "/app/bin/face_accel")
DATA_DIR_PATH = Path(os.environ.get("DATA_DIR", "/app/data"))
WA_STORAGE_DIR = Path(os.environ.get("WA_STORAGE_DIR", "/app/storage"))
SNAPSHOT_DIR = DATA_DIR_PATH / "snapshots"
DEBUG_DIR = WA_STORAGE_DIR / "debug"
SNAPSHOT_DIR.mkdir(parents=True, exist_ok=True)


def load_internal_token() -> str:
    env_token_file = os.environ.get("INTERNAL_TOKEN_FILE", "").strip()
    candidates = []
    if env_token_file:
        candidates.append(Path(env_token_file))
    candidates.extend(
        [
            Path("/app/storage/secrets/internal_token"),
            DATA_DIR_PATH / "secrets" / "internal_token",
        ]
    )
    for candidate in candidates:
        try:
            if candidate.exists() and candidate.stat().st_size > 0:
                return candidate.read_text(encoding="utf-8").strip()
        except OSError:
            continue
    return ""


PROCESS_EVERY_N_FRAMES = max(1, min(5, int(os.environ.get("PROCESS_EVERY_N_FRAMES", "2"))))
USE_INT8_FACE_MODEL = os.environ.get("USE_INT8_FACE_MODEL", "0") == "1"

analyzer_pool: "queue.Queue[FaceAnalysis]" = queue.Queue()
analyzer_init_lock = threading.Lock()
analyzer_initialized = False
gallery_lock = threading.Lock()
gallery_cache: List[Dict[str, Any]] = []
gallery_matrix: Optional[np.ndarray] = None
gallery_ids: Optional[np.ndarray] = None
gallery_dims: int = 0
settings_cache: Dict[str, Any] = {
    "threshold_confidence": 0.60,
    "threshold_recognition": 0.70,
    "threshold_clustering": 0.70,
    "match_margin_min": 0.08,
    "vote_threshold": 0.65,
    "vote_window_sec": 10,
    "adaptive_threshold_enabled": True,
    "threshold_high_quality": 0.60,
    "threshold_mid_quality": 0.75,
    "min_face_size": 60,
    "max_face_size": 0,
    "blur_threshold": 100,
    "max_yaw_deg": 30,
    "max_pitch_deg": 25,
    "debug_detection": False,
    "min_snapshot_quality": 0.70,
    "capture_max_width": 1280,
    "capture_jpeg_quality": 86,
    "weight_confidence": 0.30,
    "weight_size": 0.25,
    "weight_sharpness": 0.25,
    "weight_frontal": 0.20,
}

camera_threads: Dict[int, threading.Event] = {}
camera_mgr_lock = threading.Lock()
inference_pool = ThreadPoolExecutor(max_workers=max(2, min(8, _CPU_COUNT)))
last_debug_saved_by_cam: Dict[int, float] = {}
debug_lock = threading.Lock()


def build_ort_session_options() -> ort.SessionOptions:
    """
    Konfigurasi SessionOptions ONNX Runtime untuk CPU VPS kelas menengah (4 vCPU / 4-8 GB RAM):
    - ORT_ENABLE_ALL: constant folding, operator fusion, layout optimization
    - ORT_SEQUENTIAL: hemat RAM & bebas lonjakan thread contention antar kamera
    - intra_op_num_threads = max(1, cpu_count - 1) (tidak pernah 0)
    - inter_op_num_threads = 1
    """
    opts = ort.SessionOptions()
    opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    opts.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
    opts.intra_op_num_threads = max(1, _ORT_INTRA_THREADS)
    opts.inter_op_num_threads = 1
    opts.enable_mem_pattern = True
    opts.enable_cpu_mem_arena = True
    return opts


def init_insightface() -> None:
    global analyzer_initialized
    with analyzer_init_lock:
        if analyzer_initialized:
            return

        sess_opts = build_ort_session_options()
        orig_inference_session = ort.InferenceSession

        class TunedInferenceSession(orig_inference_session):
            def __init__(self, path_or_bytes: Any, sess_options: Any = None, providers: Any = None, **kwargs: Any) -> None:
                model_path = path_or_bytes
                if USE_INT8_FACE_MODEL and isinstance(path_or_bytes, str) and path_or_bytes.endswith(".onnx"):
                    int8_candidate = path_or_bytes[:-5] + "_int8.onnx"
                    if os.path.isfile(int8_candidate):
                        model_path = int8_candidate
                super().__init__(
                    model_path,
                    sess_options=sess_opts,
                    providers=providers or ["CPUExecutionProvider"],
                    **kwargs,
                )

        ort.InferenceSession = TunedInferenceSession  # type: ignore[misc]
        try:
            for _ in range(FACE_WORKER_INSTANCES):
                # Hanya muat modul detection + recognition (lewati 2d106det, 1k3d68, genderage yang boros RAM)
                fa = FaceAnalysis(
                    name="buffalo_l",
                    root=MODEL_DIR,
                    providers=["CPUExecutionProvider"],
                    allowed_modules=["detection", "recognition"],
                )
                fa.prepare(ctx_id=-1, det_size=(640, 640), det_thresh=0.35)
                analyzer_pool.put(fa)
            analyzer_initialized = True
        finally:
            ort.InferenceSession = orig_inference_session  # type: ignore[misc]


def decode_data_url(data_url: str) -> np.ndarray:
    if "," in data_url:
        _, b64 = data_url.split(",", 1)
    else:
        b64 = data_url
    raw = base64.b64decode(b64)
    arr = np.frombuffer(raw, dtype=np.uint8)
    img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError("Gambar tidak valid atau gagal di-decode.")
    return img


def compute_sharpness_norm_from_var(lap_var: float) -> float:
    if lap_var <= 0.0:
        return 0.0
    return float(min(1.0, max(0.0, lap_var / 200.0)))


def compute_quality(conf: float, face_size_px: int, sharpness_norm: float, frontal_score: float) -> float:
    w_c = float(settings_cache.get("weight_confidence", 0.30))
    w_s = float(settings_cache.get("weight_size", 0.25))
    w_sh = float(settings_cache.get("weight_sharpness", 0.25))
    w_f = float(settings_cache.get("weight_frontal", 0.20))
    size_norm = min(1.0, max(0.0, face_size_px / 160.0))
    score = w_c * conf + w_s * size_norm + w_sh * sharpness_norm + w_f * frontal_score
    return round(float(min(1.0, max(0.0, score))), 4)


def cosine_sim(a: np.ndarray, b: np.ndarray) -> float:
    na = float(np.linalg.norm(a))
    nb = float(np.linalg.norm(b))
    if na <= 1e-12 or nb <= 1e-12:
        return 0.0
    return float(np.dot(a, b) / (na * nb))


def rebuild_gallery_matrix_locked(students: List[Dict[str, Any]]) -> None:
    global gallery_matrix, gallery_ids, gallery_dims
    rows: List[np.ndarray] = []
    ids: List[int] = []
    target_dim = 0
    for item in students:
        emb = item.get("embedding")
        if not emb:
            continue
        vec = np.asarray(emb, dtype=np.float32)
        if vec.ndim != 1 or vec.shape[0] == 0:
            continue
        norm = float(np.linalg.norm(vec))
        if norm <= 1e-12:
            continue
        if target_dim == 0:
            target_dim = int(vec.shape[0])
        if int(vec.shape[0]) != target_dim:
            continue
        rows.append(vec / norm)
        ids.append(int(item["id"]))

    if rows:
        gallery_matrix = np.vstack(rows).astype(np.float32, copy=False)
        gallery_ids = np.asarray(ids, dtype=np.int64)
        gallery_dims = target_dim
    else:
        gallery_matrix = None
        gallery_ids = None
        gallery_dims = 0


def match_1_to_n(
    query_emb: List[float],
    gallery: List[Dict[str, Any]],
    cached_matrix: Optional[np.ndarray] = None,
    cached_ids: Optional[np.ndarray] = None,
    threshold: float = 0.70,
    min_margin: float = 0.08,
) -> Tuple[Optional[int], float, float, float, Optional[str]]:
    q = np.asarray(query_emb, dtype=np.float32)
    q_norm = float(np.linalg.norm(q))
    if q_norm <= 1e-12:
        return None, 0.0, 0.0, 0.0, "no_match"
    q = q / q_norm

    if cached_matrix is not None and cached_ids is not None and cached_matrix.shape[0] > 0 and cached_matrix.shape[1] == q.shape[0]:
        sims = cached_matrix @ q
        pairs = [(int(cached_ids[i]), float(sims[i])) for i in range(int(sims.shape[0]))]
        return evaluate_top1_top2_margin(pairs, threshold=threshold, min_margin=min_margin)

    if not gallery:
        return None, 0.0, 0.0, 0.0, "no_match"

    if os.environ.get("USE_RUST_SUBPROCESS") == "1" and os.path.isfile(RUST_ACCEL_BIN) and os.access(RUST_ACCEL_BIN, os.X_OK):
        try:
            payload = json.dumps({"query": query_emb, "gallery": gallery, "threshold": threshold, "min_margin": min_margin})
            proc = subprocess.run(
                [RUST_ACCEL_BIN],
                input=payload,
                text=True,
                capture_output=True,
                timeout=2.0,
            )
            if proc.returncode == 0:
                res = json.loads(proc.stdout)
                bid = res.get("best_id")
                bsim = float(res.get("similarity", 0.0))
                if bid is not None and bsim >= threshold:
                    return int(bid), bsim, float(res.get("second_similarity", 0.0)), float(res.get("margin", bsim)), None
        except Exception:
            pass

    pairs_list: List[Tuple[int, float]] = []
    for item in gallery:
        v = np.asarray(item["embedding"], dtype=np.float32)
        if v.shape != q.shape:
            continue
        vn = float(np.linalg.norm(v))
        if vn <= 1e-12:
            continue
        pairs_list.append((int(item["id"]), float(np.dot(q, v / vn))))
    return evaluate_top1_top2_margin(pairs_list, threshold=threshold, min_margin=min_margin)


@dataclass
class GatedFace:
    bbox: Tuple[int, int, int, int]
    kps: np.ndarray
    det_score: float
    face_size_px: int
    blur_variance: float
    sharpness_norm: float
    frontal_score: float
    yaw_deg: float
    pitch_deg: float
    normed_embedding: np.ndarray


def save_debug_frame_if_due(
    img: np.ndarray,
    camera_id: int,
    annotations: List[Dict[str, Any]],
) -> Optional[str]:
    if not annotations:
        return None
    now = time.time()
    with debug_lock:
        last_ts = last_debug_saved_by_cam.get(camera_id, 0.0)
        if now - last_ts < 30.0:
            return None
        last_debug_saved_by_cam[camera_id] = now

    canvas = img.copy()
    for item in annotations:
        x1, y1, x2, y2 = item["bbox"]
        passed = bool(item["passed"])
        label = str(item["label"])
        color = (94, 197, 34) if passed else (68, 68, 239)  # BGR hijau / merah
        cv2.rectangle(canvas, (x1, y1), (x2, y2), color, 2)
        cv2.putText(canvas, label, (x1, max(16, y1 - 6)), cv2.FONT_HERSHEY_SIMPLEX, 0.5, color, 2, cv2.LINE_AA)
        kps = item.get("kps")
        if kps is not None:
            for pt in kps[:5]:
                px, py = int(round(float(pt[0]))), int(round(float(pt[1])))
                cv2.circle(canvas, (px, py), 4, (246, 130, 59), -1)  # BGR biru

    DEBUG_DIR.mkdir(parents=True, exist_ok=True)
    ts_ms = int(now * 1000)
    out_path = DEBUG_DIR / f"cam{camera_id}_{ts_ms}.png"
    cv2.imwrite(str(out_path), canvas)

    prefix = f"cam{camera_id}_"
    files = sorted(p for p in DEBUG_DIR.iterdir() if p.is_file() and p.name.startswith(prefix) and p.name.endswith(".png"))
    while len(files) > 50:
        oldest = files.pop(0)
        try:
            oldest.unlink()
        except OSError:
            pass
    return str(out_path)


def detect_faces_gated(
    img: np.ndarray,
    min_face_size_px: int,
    stats_bucket: Optional[Dict[str, Any]] = None,
    camera_id: int = 0,
    debug_enabled: bool = False,
    max_face_size_px: int = 0,
) -> Tuple[List[GatedFace], Optional[str]]:
    """
    Pipeline deteksi 8-langkah (termurah -> termahal).
    ArcFace rec_model TIDAK PERNAH dipanggil untuk wajah yang gagal Langkah 1-7!
    """
    init_insightface()
    h_img, w_img = img.shape[:2]
    dst_w, dst_h, scale_x, scale_y, scaled = compute_downscale_plan(w_img, h_img, 640)
    det_img = cv2.resize(img, (dst_w, dst_h), interpolation=cv2.INTER_AREA) if scaled else img

    fa = analyzer_pool.get()
    try:
        # Langkah 1: Jalankan HANYA detector SCRFD (tanpa recognition model)
        bboxes, kpss = fa.det_model.detect(det_img, max_num=0, metric="default")
        if bboxes is None or len(bboxes) == 0:
            return [], None

        rec_model = fa.models.get("recognition")
        if rec_model is None:
            raise RuntimeError("Model recognition InsightFace belum termuat.")

        survivors: List[Dict[str, Any]] = []
        debug_annots: List[Dict[str, Any]] = []
        last_reject_reason: Optional[str] = None

        for i in range(bboxes.shape[0]):
            if stats_bucket is not None:
                stats_bucket["total_raw"] += 1

            raw_box = bboxes[i]
            x1 = max(0, int(round(float(raw_box[0]) * scale_x)))
            y1 = max(0, int(round(float(raw_box[1]) * scale_y)))
            x2 = min(w_img, int(round(float(raw_box[2]) * scale_x)))
            y2 = min(h_img, int(round(float(raw_box[3]) * scale_y)))
            conf = float(raw_box[4])

            kps_scaled = None
            if kpss is not None and i < len(kpss) and kpss[i] is not None:
                kps_scaled = kpss[i].copy().astype(np.float32)
                kps_scaled[:, 0] *= scale_x
                kps_scaled[:, 1] *= scale_y

            def _compute_blur(bx1: int = x1, by1: int = y1, bx2: int = x2, by2: int = y2) -> float:
                crop = img[by1:by2, bx1:bx2]
                return compute_laplacian_variance_bgr(crop)

            # Langkah 2-6: confidence -> 5-landmark -> size -> blur -> pose
            gate = evaluate_pre_embedding_gates(
                confidence=conf,
                bbox=(x1, y1, x2, y2),
                kps=kps_scaled,
                min_face_size_px=min_face_size_px,
                compute_blur_fn=_compute_blur,
                settings=settings_cache,
                max_face_size_px=max_face_size_px,
            )

            if not gate.passed:
                last_reject_reason = gate.reason
                if stats_bucket is not None and gate.reason:
                    key = f"dropped_{gate.reason}"
                    if key in stats_bucket:
                        stats_bucket[key] += 1
                if debug_enabled:
                    debug_annots.append(
                        {
                            "bbox": (x1, y1, x2, y2),
                            "passed": False,
                            "label": f"DROP:{gate.reason}",
                            "kps": kps_scaled,
                        }
                    )
                continue

            survivors.append(
                {
                    "bbox": (x1, y1, x2, y2),
                    "kps": kps_scaled,
                    "conf": conf,
                    "gate": gate,
                }
            )
            if debug_enabled:
                debug_annots.append(
                    {
                        "bbox": (x1, y1, x2, y2),
                        "passed": True,
                        "label": f"PASS:{conf:.2f}",
                        "kps": kps_scaled,
                    }
                )

        # Langkah 7 & 8: Warp 5-pt ke 112x112 + ArcFace embedding HANYA untuk wajah yang lolos!
        gated_out: List[GatedFace] = []
        aligned_batch: List[np.ndarray] = []
        valid_survivors: List[Dict[str, Any]] = []
        for s in survivors:
            aligned = align_face_5pt_112(img, s["kps"])
            if aligned is None:
                continue
            aligned_batch.append(aligned)
            valid_survivors.append(s)

        if aligned_batch:
            feats = rec_model.get_feat(aligned_batch)
            for s, feat in zip(valid_survivors, feats):
                vec = np.asarray(feat, dtype=np.float32).flatten()
                norm = float(np.linalg.norm(vec))
                if norm <= 1e-12:
                    continue
                normed = vec / norm
                if stats_bucket is not None:
                    stats_bucket["passed_embedding"] += 1
                g = s["gate"]
                gated_out.append(
                    GatedFace(
                        bbox=s["bbox"],
                        kps=s["kps"],
                        det_score=float(s["conf"]),
                        face_size_px=int(g.face_size_px),
                        blur_variance=float(g.blur_variance or 0.0),
                        sharpness_norm=compute_sharpness_norm_from_var(float(g.blur_variance or 0.0)),
                        frontal_score=float(g.frontal_score),
                        yaw_deg=float(g.yaw_deg or 0.0),
                        pitch_deg=float(g.pitch_deg or 0.0),
                        normed_embedding=normed,
                    )
                )

        if debug_enabled and debug_annots:
            save_debug_frame_if_due(img, camera_id, debug_annots)

        return gated_out, last_reject_reason
    finally:
        analyzer_pool.put(fa)


def internal_headers() -> Dict[str, str]:
    token = load_internal_token()
    if not token:
        return {}
    return {"X-Internal-Token": token}


def sync_gallery_and_settings() -> None:
    global gallery_cache, settings_cache
    try:
        with httpx.Client(timeout=8.0) as client:
            resp = client.get(f"{WEB_BACKEND_URL}/api/internal/gallery", headers=internal_headers())
            if resp.status_code == 200:
                data = resp.json()
                students = data.get("students", [])
                with gallery_lock:
                    gallery_cache = students
                    rebuild_gallery_matrix_locked(students)
                    if isinstance(data.get("settings"), dict):
                        settings_cache.update(data["settings"])
    except Exception:
        pass


def send_heartbeat(
    camera_id: int,
    online: bool,
    error: Optional[str] = None,
    telemetry: Optional[Dict[str, Any]] = None,
) -> None:
    payload: Dict[str, Any] = {"online": online, "error": error}
    if telemetry:
        payload.update(telemetry)
    try:
        with httpx.Client(timeout=3.0) as client:
            resp = client.post(
                f"{WEB_BACKEND_URL}/api/internal/cameras/{camera_id}/heartbeat",
                json=payload,
                headers=internal_headers(),
            )
            if resp.status_code >= 400:
                print(
                    f"[HEARTBEAT][Cam #{camera_id}] HTTP {resp.status_code}: {resp.text[:160]}",
                    flush=True,
                )
    except Exception as exc:
        print(f"[HEARTBEAT][Cam #{camera_id}] Gagal kirim heartbeat: {exc}", flush=True)


def flush_detection_stats_if_due(
    camera_id: int,
    bucket: Dict[str, Any],
    now_ts: float,
    force: bool = False,
) -> None:
    if not force and (now_ts - float(bucket["window_start_ts"])) < 300.0:
        return
    if int(bucket["total_raw"]) > 0:
        try:
            with httpx.Client(timeout=4.0) as client:
                client.post(
                    f"{WEB_BACKEND_URL}/api/internal/detection-stats",
                    json={
                        "camera_id": camera_id,
                        "window_start": bucket["window_start"],
                        "window_end": now_wib_str(),
                        "total_raw": int(bucket["total_raw"]),
                        "dropped_confidence": int(bucket["dropped_confidence"]),
                        "dropped_landmark": int(bucket["dropped_landmark"]),
                        "dropped_size": int(bucket["dropped_size"]),
                        "dropped_blur": int(bucket["dropped_blur"]),
                        "dropped_pose": int(bucket["dropped_pose"]),
                        "passed_embedding": int(bucket["passed_embedding"]),
                    },
                    headers=internal_headers(),
                )
        except Exception:
            pass
    bucket["window_start_ts"] = now_ts
    bucket["window_start"] = now_wib_str()
    for k in (
        "total_raw",
        "dropped_confidence",
        "dropped_landmark",
        "dropped_size",
        "dropped_blur",
        "dropped_pose",
        "passed_embedding",
    ):
        bucket[k] = 0


def rtsp_camera_worker(cam: Dict[str, Any], stop_event: threading.Event) -> None:
    cam_id = int(cam["id"])
    rtsp_url = str(cam.get("rtsp_url", ""))
    target_fps = max(1, min(15, int(cam.get("fps", 5))))
    frame_interval = 1.0 / float(target_fps)
    tracker = IoUTracker(iou_threshold=0.20, ttl_seconds=4.0, dispatch_cooldown_sec=12.0)
    vote_buffer = TrackVoteBuffer()

    tel: Dict[str, Any] = {
        "frames_decoded": 0,
        "raw_faces_seen": 0,
        "dropped_filter": 0,
        "faces_detected_total": 0,
        "matched_dispatched": 0,
        "anonymous_dispatched": 0,
        "watchdog_restarts": 0,
        "last_frame_at": None,
        "last_face_at": None,
        "last_detect_at": None,
        "fps": 0.0,
    }
    stats_bucket: Dict[str, Any] = {
        "window_start_ts": time.time(),
        "window_start": now_wib_str(),
        "total_raw": 0,
        "dropped_confidence": 0,
        "dropped_landmark": 0,
        "dropped_size": 0,
        "dropped_blur": 0,
        "dropped_pose": 0,
        "passed_embedding": 0,
    }
    recent_frame_ts: List[float] = []

    while not stop_event.is_set():
        cap = None
        try:
            cap = cv2.VideoCapture(rtsp_url, cv2.CAP_FFMPEG)
            cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
            if not cap.isOpened():
                err_msg = "Gagal membuka stream RTSP (retry 10 detik)"
                print(f"[RTSP][Cam #{cam_id}] {err_msg}", flush=True)
                send_heartbeat(cam_id, False, err_msg, tel)
                stop_event.wait(10.0)
                continue

            print(f"[RTSP][Cam #{cam_id}] Stream RTSP terhubung (target_fps={target_fps})", flush=True)
            send_heartbeat(cam_id, True, None, tel)
            last_hb = time.time()
            last_good_frame_ts = time.time()
            last_proc = 0.0
            last_detect_log = 0.0
            last_quality_log = 0.0
            verbose_logs = os.environ.get("VERBOSE_FACE_LOGS") == "1"
            fail_reads = 0
            frame_counter = 0

            while not stop_event.is_set():
                grabbed = cap.grab()
                now = time.time()
                flush_detection_stats_if_due(cam_id, stats_bucket, now)

                if not grabbed:
                    fail_reads += 1
                    if fail_reads >= 15 or (now - last_good_frame_ts > 45.0):
                        tel["watchdog_restarts"] += 1
                        tel["fps"] = 0.0
                        err_msg = (
                            f"Watchdog RTSP restart #{tel['watchdog_restarts']}: "
                            f"fail_reads={fail_reads}, idle={int(now - last_good_frame_ts)}s"
                        )
                        print(f"[RTSP][Cam #{cam_id}] {err_msg}", flush=True)
                        send_heartbeat(cam_id, False, err_msg, tel)
                        break
                    time.sleep(0.05)
                    continue

                fail_reads = 0
                frame_counter += 1
                last_good_frame_ts = now

                if now - last_hb >= 15.0:
                    send_heartbeat(cam_id, True, None, tel)
                    last_hb = now

                # Lewati decode BGR penuh untuk frame yang tidak diproses agar bebas lag buffer RTSP & hemat CPU
                if frame_counter % PROCESS_EVERY_N_FRAMES != 0:
                    continue
                if now - last_proc < frame_interval:
                    continue

                ret, frame = cap.retrieve()
                if not ret or frame is None:
                    continue

                last_proc = now
                tel["frames_decoded"] += 1
                tel["last_frame_at"] = now_wib_str()

                recent_frame_ts.append(now)
                while recent_frame_ts and (now - recent_frame_ts[0]) > 10.0:
                    recent_frame_ts.pop(0)
                tel["fps"] = round(len(recent_frame_ts) / 10.0, 1)

                cam_res_parts = str(cam.get("resolusi", "1920x1080")).lower().split("x")
                try:
                    cam_native_w = max(160, min(7680, int(cam_res_parts[0])))
                except Exception:
                    cam_native_w = max(160, int(frame.shape[1]))

                cam_cap_override = cam.get("capture_max_width")
                if cam_cap_override is not None:
                    max_capture_w = int(cam_cap_override or 0)
                else:
                    max_capture_w = int(settings_cache.get("capture_max_width", 1280) or 0)

                if max_capture_w > 0 and frame.shape[1] > max_capture_w:
                    scale_ratio = float(max_capture_w) / float(frame.shape[1])
                    new_h = max(2, int(round(frame.shape[0] * scale_ratio)) & ~1)
                    frame = cv2.resize(frame, (max_capture_w, new_h), interpolation=cv2.INTER_AREA)

                cam_min_override = cam.get("min_face_size")
                raw_target_px = cam_min_override if cam_min_override is not None else settings_cache.get("min_face_size", 60)
                target_camera_px = max(16, min(4096, int(raw_target_px or 60)))
                cam_max_override = cam.get("max_face_size")
                raw_max_px = cam_max_override if cam_max_override is not None else settings_cache.get("max_face_size", 0)
                parsed_max_px = int(raw_max_px or 0)
                target_max_px = max(target_camera_px, min(4096, parsed_max_px)) if parsed_max_px > 0 else 0
                frame_scale_ratio = min(1.0, float(frame.shape[1]) / float(cam_native_w)) if cam_native_w > 0 else 1.0
                min_size = max(16, min(4096, int(round(target_camera_px * frame_scale_ratio))))
                max_size = (
                    max(min_size, min(4096, int(round(target_max_px * frame_scale_ratio))))
                    if target_max_px > 0
                    else 0
                )
                debug_enabled = bool(settings_cache.get("debug_detection", False))

                before_raw = int(stats_bucket["total_raw"])
                valid_faces, _ = detect_faces_gated(
                    frame,
                    min_face_size_px=min_size,
                    stats_bucket=stats_bucket,
                    camera_id=cam_id,
                    debug_enabled=debug_enabled,
                    max_face_size_px=max_size,
                )
                delta_raw = int(stats_bucket["total_raw"]) - before_raw
                if delta_raw > 0:
                    dropped_now = delta_raw - len(valid_faces)
                    tel["raw_faces_seen"] += delta_raw
                    tel["dropped_filter"] += max(0, dropped_now)

                if verbose_logs or (now - last_detect_log >= 60.0):
                    last_detect_log = now
                    print(
                        f"[DETECT][Cam #{cam_id}] raw5m={stats_bucket['total_raw']} lolos5m={stats_bucket['passed_embedding']} "
                        f"total_lolos={tel['faces_detected_total']} total_ditolak={tel['dropped_filter']}",
                        flush=True,
                    )

                if not valid_faces:
                    continue

                boxes = [(float(f.bbox[0]), float(f.bbox[1]), float(f.bbox[2]), float(f.bbox[3])) for f in valid_faces]

                detect_wib = now_wib_str()
                tel["last_face_at"] = detect_wib
                tel["last_detect_at"] = detect_wib
                tel["faces_detected_total"] += len(valid_faces)

                vote_thresh = float(settings_cache.get("vote_threshold", 0.65))
                vote_window_sec = float(settings_cache.get("vote_window_sec", 10))
                match_margin_min = float(settings_cache.get("match_margin_min", 0.08))
                track_ids = tracker.assign_tracks(boxes, now, ttl_override=max(4.0, vote_window_sec))
                vote_buffer.clear_expired(now, vote_window_sec)

                with gallery_lock:
                    cur_gallery = list(gallery_cache)
                    cur_mat = gallery_matrix
                    cur_ids = gallery_ids

                h_img, w_img = frame.shape[:2]
                for f, track_id in zip(valid_faces, track_ids):
                    if not tracker.can_dispatch(track_id, now):
                        continue
                    x1, y1, x2, y2 = f.bbox
                    pad = int(max(x2 - x1, y2 - y1) * 0.45)
                    cx1, cy1 = max(0, x1 - pad), max(0, y1 - pad)
                    cx2, cy2 = min(w_img, x2 + pad), min(h_img, y2 + pad)
                    crop = frame[cy1:cy2, cx1:cx2]

                    conf = f.det_score
                    face_px = f.face_size_px
                    native_face_px = int(round(float(face_px) / max(0.1, float(frame_scale_ratio))))
                    q_score = compute_quality(conf, native_face_px, f.sharpness_norm, f.frontal_score)

                    min_quality = max(0.70, min(0.99, float(settings_cache.get("min_snapshot_quality", 0.70))))
                    adaptive_ok, rec_thresh, adaptive_band = resolve_adaptive_recognition_threshold(q_score, settings_cache)
                    if q_score < min_quality or not adaptive_ok:
                        tel["dropped_filter"] += 1
                        tracker.reset_dispatch_cooldown(track_id)
                        if verbose_logs or (now - last_quality_log >= 60.0):
                            last_quality_log = now
                            print(
                                f"[DETECT][Cam #{cam_id}] Wajah diabaikan kualitas {(q_score * 100):.1f}% < {(max(min_quality, 0.70) * 100):.0f}%",
                                flush=True,
                            )
                        continue

                    emb = f.normed_embedding.astype(np.float32).tolist()
                    best_id, sim, second_sim, margin, reject_reason = match_1_to_n(
                        emb,
                        cur_gallery,
                        cur_mat,
                        cur_ids,
                        threshold=rec_thresh,
                        min_margin=match_margin_min,
                    )
                    if reject_reason == "ambiguous_margin":
                        print(
                            f"[MATCH][Cam #{cam_id}] ambiguous_margin top2={second_sim:.3f} margin={margin:.3f}<{match_margin_min:.2f} "
                            f"thresh={rec_thresh:.2f} band={adaptive_band}",
                            flush=True,
                        )

                    recognized_id: Optional[int] = best_id
                    if recognized_id is not None:
                        should_dispatch, vote_count, vote_reason = vote_buffer.record_and_evaluate(
                            track_id=track_id,
                            student_id=recognized_id,
                            similarity=sim,
                            now=now,
                            vote_threshold=vote_thresh,
                            vote_window_sec=vote_window_sec,
                            min_votes=2,
                        )
                        if not should_dispatch:
                            if verbose_logs:
                                print(
                                    f"[VOTE][Cam #{cam_id}] track={track_id} siswa=#{recognized_id} sim={sim:.3f} votes={vote_count}/2 ({vote_reason})",
                                    flush=True,
                                )
                            continue
                        tracker.mark_dispatched(track_id, now)
                        tel["matched_dispatched"] += 1
                        print(
                            f"[MATCH][Cam #{cam_id}] Siswa #{recognized_id} track={track_id} sim={sim:.3f} q={q_score:.3f} "
                            f"band={adaptive_band} thresh={rec_thresh:.2f} conf={conf:.2f} px={face_px}",
                            flush=True,
                        )
                    else:
                        tracker.mark_dispatched(track_id, now)
                        tel["anonymous_dispatched"] += 1
                        print(
                            f"[MATCH][Cam #{cam_id}] Anonim dims={len(emb)} best_sim={sim:.3f} margin={margin:.3f} "
                            f"reason={reject_reason or 'none'} thresh={rec_thresh:.2f} q={q_score:.3f}",
                            flush=True,
                        )

                    snap_name = f"cam{cam_id}_t{track_id}_{int(now)}.jpg"
                    snap_path = SNAPSHOT_DIR / snap_name
                    jpeg_q = max(50, min(82, int(settings_cache.get("capture_jpeg_quality", 82) or 82)))
                    if crop.size > 0:
                        ch, cw = crop.shape[:2]
                        longest = max(ch, cw)
                        if longest > 360:
                            scale_c = 360.0 / float(longest)
                            crop_save = cv2.resize(
                                crop,
                                (max(2, int(round(cw * scale_c))), max(2, int(round(ch * scale_c)))),
                                interpolation=cv2.INTER_AREA,
                            )
                        else:
                            crop_save = crop
                        cv2.imwrite(str(snap_path), crop_save, [int(cv2.IMWRITE_JPEG_QUALITY), jpeg_q])

                    try:
                        with httpx.Client(timeout=4.0) as client:
                            ev_resp = client.post(
                                f"{WEB_BACKEND_URL}/api/internal/face-event",
                                json={
                                    "camera_id": cam_id,
                                    "student_id": recognized_id,
                                    "similarity": round(sim, 4),
                                    "confidence": round(conf, 4),
                                    "quality_score": q_score,
                                    "embedding": emb,
                                    "snapshot_rel_path": f"/data/snapshots/{snap_name}",
                                },
                                headers=internal_headers(),
                            )
                            if ev_resp.status_code >= 400:
                                print(
                                    f"[EVENT][Cam #{cam_id}] Backend error HTTP {ev_resp.status_code}: {ev_resp.text[:160]}",
                                    flush=True,
                                )
                    except Exception as exc:
                        print(f"[EVENT][Cam #{cam_id}] Gagal POST /api/internal/face-event: {exc}", flush=True)
        except Exception as exc:
            err_msg = f"Exception worker RTSP: {str(exc)[:120]}"
            print(f"[RTSP][Cam #{cam_id}] {err_msg}", flush=True)
            send_heartbeat(cam_id, False, err_msg, tel)
        finally:
            if cap is not None:
                cap.release()
        stop_event.wait(5.0)
    flush_detection_stats_if_due(cam_id, stats_bucket, time.time(), force=True)


def refresh_camera_workers() -> int:
    try:
        with httpx.Client(timeout=5.0) as client:
            resp = client.get(f"{WEB_BACKEND_URL}/api/internal/cameras", headers=internal_headers())
            if resp.status_code != 200:
                return 0
            cams = resp.json().get("cameras", [])
    except Exception as exc:
        print(f"[RTSP] Gagal fetch /api/internal/cameras: {exc}", flush=True)
        return 0

    active_ids = set()
    with camera_mgr_lock:
        for cam in cams:
            cid = int(cam["id"])
            url = str(cam.get("rtsp_url", ""))
            if not cam.get("aktif") or not url or url.startswith("dummy://"):
                continue
            active_ids.add(cid)
            if cid not in camera_threads:
                stop_ev = threading.Event()
                camera_threads[cid] = stop_ev
                t = threading.Thread(target=rtsp_camera_worker, args=(cam, stop_ev), daemon=True)
                t.start()

        for cid in list(camera_threads.keys()):
            if cid not in active_ids:
                camera_threads[cid].set()
                del camera_threads[cid]

    return len(active_ids)


def background_sync_loop(stop_ev: threading.Event) -> None:
    time.sleep(2.5)
    while not stop_ev.is_set():
        try:
            sync_gallery_and_settings()
            refresh_camera_workers()
        except Exception as exc:
            print(f"[SYNC] Error di background_sync_loop (auto-retry 25s): {exc}", flush=True)
        stop_ev.wait(25.0)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    init_insightface()
    stop_ev = threading.Event()
    t = threading.Thread(target=background_sync_loop, args=(stop_ev,), daemon=True)
    t.start()
    yield
    stop_ev.set()
    with camera_mgr_lock:
        for ev in camera_threads.values():
            ev.set()
        camera_threads.clear()


app = FastAPI(title="Absensi SMK InsightFace Service", lifespan=lifespan)


class EnrollRequest(BaseModel):
    photoDataUrl: str


class CompareRequest(BaseModel):
    photo1DataUrl: str
    photo2DataUrl: str


@app.get("/health")
def health() -> Dict[str, Any]:
    return {
        "ok": True,
        "model": "buffalo_l",
        "allowed_modules": ["detection", "recognition"],
        "ort_intra_threads": _ORT_INTRA_THREADS,
        "ort_inter_threads": 1,
        "ort_graph_opt": "ORT_ENABLE_ALL",
        "ort_exec_mode": "ORT_SEQUENTIAL",
        "int8_enabled": USE_INT8_FACE_MODEL,
        "anti_spoofing": False,
        "rust_accel": os.path.isfile(RUST_ACCEL_BIN),
        "face_worker_instances": FACE_WORKER_INSTANCES,
        "active_camera_workers": len(camera_threads),
        "gallery_size": len(gallery_cache),
    }


@app.post("/cameras/reload")
def reload_cameras() -> Dict[str, Any]:
    sync_gallery_and_settings()
    count = refresh_camera_workers()
    return {"ok": True, "active_camera_workers": count}


@app.post("/enroll")
def enroll_face(req: EnrollRequest) -> Dict[str, Any]:
    try:
        img = decode_data_url(req.photoDataUrl)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    min_sz = max(16, int(settings_cache.get("min_face_size", 60) or 60))
    faces, reject_reason = detect_faces_gated(img, min_face_size_px=min_sz)
    if not faces:
        detail_msg = (
            f"Wajah ditolak filter kualitas ({reject_reason})."
            if reject_reason
            else "Wajah tidak terdeteksi pada foto."
        )
        raise HTTPException(status_code=422, detail=detail_msg)

    best_face = max(faces, key=lambda f: (f.bbox[2] - f.bbox[0]) * (f.bbox[3] - f.bbox[1]))
    q_score = compute_quality(
        best_face.det_score,
        best_face.face_size_px,
        best_face.sharpness_norm,
        best_face.frontal_score,
    )

    return {
        "ok": True,
        "confidence": round(best_face.det_score, 4),
        "face_size_px": best_face.face_size_px,
        "quality_score": q_score,
        "embedding": best_face.normed_embedding.astype(np.float32).tolist(),
    }


@app.post("/compare")
def compare_faces(req: CompareRequest) -> Dict[str, Any]:
    try:
        img1 = decode_data_url(req.photo1DataUrl)
        img2 = decode_data_url(req.photo2DataUrl)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    min_sz = max(16, int(settings_cache.get("min_face_size", 60) or 60))
    faces1, r1 = detect_faces_gated(img1, min_face_size_px=min_sz)
    faces2, r2 = detect_faces_gated(img2, min_face_size_px=min_sz)
    if not faces1 or not faces2:
        raise HTTPException(
            status_code=422,
            detail=f"Pastikan kedua foto menampilkan wajah yang jelas dan lolos gerbang kualitas ({r1 or r2 or 'no_face'}).",
        )

    f1 = max(faces1, key=lambda f: (f.bbox[2] - f.bbox[0]) * (f.bbox[3] - f.bbox[1]))
    f2 = max(faces2, key=lambda f: (f.bbox[2] - f.bbox[0]) * (f.bbox[3] - f.bbox[1]))
    sim = cosine_sim(f1.normed_embedding, f2.normed_embedding)
    threshold = float(settings_cache.get("threshold_recognition", 0.70))
    match = sim >= threshold
    return {
        "similarity": round(sim, 4),
        "threshold": threshold,
        "match": match,
        "status": "COCOK (IDENTITAS SAMA)" if match else "TIDAK COCOK (BERBEDA)",
    }
