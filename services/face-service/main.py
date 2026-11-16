import base64
import json
import os
import queue
import subprocess
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import cv2
import httpx
import numpy as np
from fastapi import FastAPI, HTTPException
from insightface.app import FaceAnalysis
from pydantic import BaseModel

from tracker import IoUTracker

# Tuned for 40-core Intel x86_64 server with 2-16 parallel 1080p 5 FPS RTSP streams
os.environ.setdefault("OMP_NUM_THREADS", "4")
os.environ.setdefault("OPENBLAS_NUM_THREADS", "4")
os.environ.setdefault("OPENCV_FFMPEG_CAPTURE_OPTIONS", "rtsp_transport;tcp|stimeout;5000000|fflags;nobuffer|flags;low_delay")

WEB_BACKEND_URL = os.environ.get("WEB_BACKEND_URL", f"http://127.0.0.1:{os.environ.get('PORT', '80')}")
MODEL_DIR = os.environ.get("INSIGHTFACE_HOME", "/app/models/insightface")
RUST_ACCEL_BIN = os.environ.get("RUST_ACCEL_BIN", "/app/bin/face_accel")
SNAPSHOT_DIR = Path(os.environ.get("DATA_DIR", "/app/data")) / "snapshots"
SNAPSHOT_DIR.mkdir(parents=True, exist_ok=True)
FACE_WORKER_INSTANCES = max(1, min(8, int(os.environ.get("FACE_WORKER_INSTANCES", "4"))))
PROCESS_EVERY_N_FRAMES = max(1, min(5, int(os.environ.get("PROCESS_EVERY_N_FRAMES", "2"))))

analyzer_pool: "queue.Queue[FaceAnalysis]" = queue.Queue()
analyzer_init_lock = threading.Lock()
analyzer_initialized = False
gallery_lock = threading.Lock()
gallery_cache: List[Dict[str, Any]] = []
settings_cache: Dict[str, Any] = {
    "threshold_confidence": 0.80,
    "threshold_recognition": 0.40,
    "min_face_size": 60,
    "weight_confidence": 0.30,
    "weight_size": 0.25,
    "weight_sharpness": 0.25,
    "weight_frontal": 0.20,
}

camera_threads: Dict[int, threading.Event] = {}
camera_mgr_lock = threading.Lock()
inference_pool = ThreadPoolExecutor(max_workers=16)


def init_insightface() -> None:
    global analyzer_initialized
    with analyzer_init_lock:
        if analyzer_initialized:
            return
        for _ in range(FACE_WORKER_INSTANCES):
            fa = FaceAnalysis(
                name="buffalo_l",
                root=MODEL_DIR,
                providers=["CPUExecutionProvider"],
            )
            fa.prepare(ctx_id=-1, det_size=(640, 640), det_thresh=0.5)
            analyzer_pool.put(fa)
        analyzer_initialized = True


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


def compute_sharpness_norm(crop: np.ndarray) -> float:
    if crop.size == 0:
        return 0.0
    gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
    lap_var = float(cv2.Laplacian(gray, cv2.CV_64F).var())
    return float(min(1.0, max(0.0, lap_var / 300.0)))


def compute_frontal_score(face: Any) -> float:
    pose = getattr(face, "pose", None)
    if pose is None or len(pose) < 2:
        return 0.85
    pitch, yaw = abs(float(pose[0])), abs(float(pose[1]))
    penalty = min(1.0, (yaw / 45.0) * 0.65 + (pitch / 35.0) * 0.35)
    return float(max(0.1, 1.0 - penalty))


def compute_quality(conf: float, face_size_px: int, sharpness_norm: float, frontal_score: float) -> float:
    w_c = float(settings_cache.get("weight_confidence", 0.30))
    w_s = float(settings_cache.get("weight_size", 0.25))
    w_sh = float(settings_cache.get("weight_sharpness", 0.25))
    w_f = float(settings_cache.get("weight_frontal", 0.20))
    size_norm = min(1.0, max(0.0, face_size_px / 220.0))
    score = w_c * conf + w_s * size_norm + w_sh * sharpness_norm + w_f * frontal_score
    return round(float(min(1.0, max(0.0, score))), 4)


def cosine_sim(a: np.ndarray, b: np.ndarray) -> float:
    na = float(np.linalg.norm(a))
    nb = float(np.linalg.norm(b))
    if na <= 1e-12 or nb <= 1e-12:
        return 0.0
    return float(np.dot(a, b) / (na * nb))


def match_1_to_n(query_emb: List[float], gallery: List[Dict[str, Any]]) -> Tuple[Optional[int], float]:
    if not gallery:
        return None, 0.0

    # Gunakan Rust binary statis jika tersedia untuk akselerasi 1:N hingga 5000+ siswa
    if os.path.isfile(RUST_ACCEL_BIN) and os.access(RUST_ACCEL_BIN, os.X_OK):
        try:
            payload = json.dumps({"query": query_emb, "gallery": gallery})
            proc = subprocess.run(
                [RUST_ACCEL_BIN],
                input=payload,
                text=True,
                capture_output=True,
                timeout=2.0,
            )
            if proc.returncode == 0:
                res = json.loads(proc.stdout)
                return res.get("best_id"), float(res.get("similarity", 0.0))
        except Exception:
            pass

    # Fallback ke NumPy tervektorisasi
    q = np.asarray(query_emb, dtype=np.float32)
    q_norm = np.linalg.norm(q)
    if q_norm <= 1e-12:
        return None, 0.0
    q = q / q_norm

    best_id: Optional[int] = None
    best_sim = -1.0
    for item in gallery:
        v = np.asarray(item["embedding"], dtype=np.float32)
        if v.shape != q.shape:
            continue
        vn = np.linalg.norm(v)
        if vn <= 1e-12:
            continue
        sim = float(np.dot(q, v / vn))
        if sim > best_sim:
            best_sim = sim
            best_id = int(item["id"])
    return best_id, max(0.0, best_sim)


def detect_faces(img: np.ndarray) -> List[Any]:
    init_insightface()
    fa = analyzer_pool.get()
    try:
        return fa.get(img)
    finally:
        analyzer_pool.put(fa)


def sync_gallery_and_settings() -> None:
    global gallery_cache, settings_cache
    try:
        with httpx.Client(timeout=5.0) as client:
            resp = client.get(f"{WEB_BACKEND_URL}/api/internal/gallery")
            if resp.status_code == 200:
                data = resp.json()
                with gallery_lock:
                    gallery_cache = data.get("students", [])
                    if isinstance(data.get("settings"), dict):
                        settings_cache.update(data["settings"])
    except Exception:
        pass


def send_heartbeat(camera_id: int, online: bool, error: Optional[str] = None) -> None:
    try:
        with httpx.Client(timeout=3.0) as client:
            client.post(
                f"{WEB_BACKEND_URL}/api/internal/cameras/{camera_id}/heartbeat",
                json={"online": online, "error": error},
            )
    except Exception:
        pass


def rtsp_camera_worker(cam: Dict[str, Any], stop_event: threading.Event) -> None:
    cam_id = int(cam["id"])
    rtsp_url = str(cam.get("rtsp_url", ""))
    target_fps = max(1, min(15, int(cam.get("fps", 5))))
    frame_interval = 1.0 / float(target_fps)
    tracker = IoUTracker(iou_threshold=0.35, ttl_seconds=4.0, dispatch_cooldown_sec=12.0)

    while not stop_event.is_set():
        cap = cv2.VideoCapture(rtsp_url, cv2.CAP_FFMPEG)
        cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
        if not cap.isOpened():
            send_heartbeat(cam_id, False, "Gagal membuka stream RTSP (retry 10 detik)")
            stop_event.wait(10.0)
            continue

        send_heartbeat(cam_id, True, None)
        last_hb = time.time()
        last_proc = 0.0
        fail_reads = 0
        frame_counter = 0

        try:
            while not stop_event.is_set():
                ret, frame = cap.read()
                if not ret or frame is None:
                    fail_reads += 1
                    if fail_reads >= 15:
                        send_heartbeat(cam_id, False, "Koneksi RTSP terputus, menghubungkan ulang...")
                        break
                    time.sleep(0.1)
                    continue
                fail_reads = 0
                frame_counter += 1

                now = time.time()
                if now - last_hb >= 30.0:
                    send_heartbeat(cam_id, True, None)
                    last_hb = now

                if frame_counter % PROCESS_EVERY_N_FRAMES != 0:
                    continue
                if now - last_proc < frame_interval:
                    continue
                last_proc = now

                faces = detect_faces(frame)
                if not faces:
                    continue

                min_conf = float(settings_cache.get("threshold_confidence", 0.80))
                min_size = int(settings_cache.get("min_face_size", 60))
                rec_thresh = float(settings_cache.get("threshold_recognition", 0.40))

                valid_faces = []
                boxes = []
                for f in faces:
                    conf = float(getattr(f, "det_score", 0.0))
                    x1, y1, x2, y2 = [int(v) for v in f.bbox]
                    w = max(0, x2 - x1)
                    h = max(0, y2 - y1)
                    if conf < min_conf or min(w, h) < min_size:
                        continue
                    valid_faces.append(f)
                    boxes.append((float(x1), float(y1), float(x2), float(y2)))

                if not boxes:
                    continue

                tracked = tracker.update(boxes, now)
                with gallery_lock:
                    cur_gallery = list(gallery_cache)

                h_img, w_img = frame.shape[:2]
                for f, (track_id, should_dispatch) in zip(valid_faces, tracked):
                    if not should_dispatch:
                        continue
                    x1, y1, x2, y2 = [int(v) for v in f.bbox]
                    pad = int(max(x2 - x1, y2 - y1) * 0.2)
                    cx1, cy1 = max(0, x1 - pad), max(0, y1 - pad)
                    cx2, cy2 = min(w_img, x2 + pad), min(h_img, y2 + pad)
                    crop = frame[cy1:cy2, cx1:cx2]

                    conf = float(getattr(f, "det_score", 0.9))
                    face_px = min(x2 - x1, y2 - y1)
                    sharp = compute_sharpness_norm(crop)
                    frontal = compute_frontal_score(f)
                    q_score = compute_quality(conf, face_px, sharp, frontal)

                    emb = f.normed_embedding.astype(np.float32).tolist()
                    best_id, sim = match_1_to_n(emb, cur_gallery)
                    recognized_id = best_id if (best_id is not None and sim >= rec_thresh) else None

                    snap_name = f"cam{cam_id}_t{track_id}_{int(now)}.jpg"
                    snap_path = SNAPSHOT_DIR / snap_name
                    if crop.size > 0:
                        cv2.imwrite(str(snap_path), crop, [int(cv2.IMWRITE_JPEG_QUALITY), 88])

                    try:
                        with httpx.Client(timeout=4.0) as client:
                            client.post(
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
                            )
                    except Exception:
                        pass
        finally:
            cap.release()
        stop_event.wait(5.0)


def refresh_camera_workers() -> int:
    try:
        with httpx.Client(timeout=5.0) as client:
            resp = client.get(f"{WEB_BACKEND_URL}/api/internal/cameras")
            if resp.status_code != 200:
                return 0
            cams = resp.json().get("cameras", [])
    except Exception:
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
    # Tunggu backend web siap saat container baru boot
    time.sleep(2.5)
    while not stop_ev.is_set():
        sync_gallery_and_settings()
        refresh_camera_workers()
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

    faces = detect_faces(img)
    if not faces:
        raise HTTPException(status_code=422, detail="Wajah tidak terdeteksi pada foto.")

    # Pilih wajah terbesar
    best_face = max(faces, key=lambda f: (f.bbox[2] - f.bbox[0]) * (f.bbox[3] - f.bbox[1]))
    conf = float(getattr(best_face, "det_score", 0.0))
    if conf < float(settings_cache.get("threshold_confidence", 0.80)):
        raise HTTPException(
            status_code=422,
            detail=f"Confidence wajah {conf:.2f} di bawah threshold {settings_cache['threshold_confidence']}.",
        )

    x1, y1, x2, y2 = [max(0, int(v)) for v in best_face.bbox]
    crop = img[y1:y2, x1:x2]
    face_px = min(max(1, x2 - x1), max(1, y2 - y1))
    sharp = compute_sharpness_norm(crop)
    frontal = compute_frontal_score(best_face)
    q_score = compute_quality(conf, face_px, sharp, frontal)

    return {
        "ok": True,
        "confidence": round(conf, 4),
        "face_size_px": face_px,
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

    faces1 = detect_faces(img1)
    faces2 = detect_faces(img2)
    if not faces1 or not faces2:
        raise HTTPException(status_code=422, detail="Pastikan kedua foto menampilkan wajah yang jelas.")

    f1 = max(faces1, key=lambda f: (f.bbox[2] - f.bbox[0]) * (f.bbox[3] - f.bbox[1]))
    f2 = max(faces2, key=lambda f: (f.bbox[2] - f.bbox[0]) * (f.bbox[3] - f.bbox[1]))
    sim = cosine_sim(f1.normed_embedding, f2.normed_embedding)
    threshold = float(settings_cache.get("threshold_recognition", 0.40))
    match = sim >= threshold
    return {
        "similarity": round(sim, 4),
        "threshold": threshold,
        "match": match,
        "status": "COCOK (IDENTITAS SAMA)" if match else "TIDAK COCOK (BERBEDA)",
    }
