#!/usr/bin/env python3
"""
Gate A Offline Python Comparison & Report Composer.
Runs strictly offline outside the production Docker image to cross-check:
  1) w600k_r50.onnx embedding parity on identical 112x112 crop vs Rust ort
  2) cv2.estimateAffinePartial2D(LMEDS) vs Least-Squares (Umeyama) on identical 5 keypoints
  3) SCRFD det_10g.onnx + LMEDS + w600k_r50.onnx baseline on identical decoded video frames + SQLite gallery
  4) Unified Gate A report (gate_a_report.json + gate_a_report.md)
"""
import argparse
import json
import math
import os
import resource
import sqlite3
import struct
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import cv2
import numpy as np
import onnxruntime as ort

ARCFACE_DST_112 = np.asarray(
    [
        [38.2946, 51.6963],
        [73.5318, 51.5014],
        [56.0252, 71.7366],
        [41.5493, 92.3655],
        [70.7299, 92.2041],
    ],
    dtype=np.float32,
)


def make_ort_session(model_path: str, intra_threads: int) -> ort.InferenceSession:
    opts = ort.SessionOptions()
    opts.intra_op_num_threads = max(1, int(intra_threads))
    opts.inter_op_num_threads = 1
    opts.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
    opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    return ort.InferenceSession(model_path, sess_options=opts, providers=["CPUExecutionProvider"])


def l2_normalize(vec: np.ndarray) -> np.ndarray:
    v = vec.astype(np.float32).ravel()
    n = float(np.linalg.norm(v))
    if not math.isfinite(n) or n <= 1e-12:
        return np.zeros_like(v)
    return v / n


def cosine_sim(a: np.ndarray, b: np.ndarray) -> float:
    na = float(np.linalg.norm(a))
    nb = float(np.linalg.norm(b))
    if na <= 1e-12 or nb <= 1e-12:
        return 0.0
    return float(np.dot(a, b) / (na * nb))


def embed_arcface_bgr112(sess: ort.InferenceSession, bgr112: np.ndarray) -> np.ndarray:
    blob = cv2.dnn.blobFromImages(
        [bgr112],
        1.0 / 127.5,
        (112, 112),
        (127.5, 127.5, 127.5),
        swapRB=True,
    )
    inp_name = sess.get_inputs()[0].name
    out_name = sess.get_outputs()[0].name
    out = sess.run([out_name], {inp_name: np.ascontiguousarray(blob, dtype=np.float32)})[0]
    return l2_normalize(out[0])


def estimate_similarity_ls_2d(src: np.ndarray, dst: np.ndarray) -> np.ndarray:
    src64 = np.asarray(src, dtype=np.float64)
    dst64 = np.asarray(dst, dtype=np.float64)
    s_mean = src64.mean(axis=0)
    d_mean = dst64.mean(axis=0)
    p = src64 - s_mean
    q = dst64 - d_mean
    denom = float(np.sum(p[:, 0] ** 2 + p[:, 1] ** 2))
    if denom < 1e-12:
        return np.asarray([[1.0, 0.0, 0.0], [0.0, 1.0, 0.0]], dtype=np.float64)
    a = float(np.sum(p[:, 0] * q[:, 0] + p[:, 1] * q[:, 1])) / denom
    b = float(np.sum(p[:, 0] * q[:, 1] - p[:, 1] * q[:, 0])) / denom
    tx = d_mean[0] - (a * s_mean[0] - b * s_mean[1])
    ty = d_mean[1] - (b * s_mean[0] + a * s_mean[1])
    return np.asarray([[a, -b, tx], [b, a, ty]], dtype=np.float64)


def bucket_for_width(w: float) -> str:
    if w < 40.0:
        return "<40"
    if w < 60.0:
        return "40-59"
    if w < 80.0:
        return "60-79"
    if w < 100.0:
        return "80-99"
    if w < 130.0:
        return "100-129"
    return "130+"


def load_sqlite_gallery(db_path: str) -> Tuple[List[int], Optional[np.ndarray]]:
    if not os.path.exists(db_path):
        return [], None
    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True, timeout=5.0)
    cur = conn.cursor()
    cur.execute("SELECT id, embedding FROM students WHERE embedding IS NOT NULL ORDER BY id ASC")
    ids: List[int] = []
    vecs: List[np.ndarray] = []
    for sid, blob in cur.fetchall():
        if blob is None or len(blob) != 512 * 4:
            continue
        arr = np.asarray(struct.unpack("<512f", blob), dtype=np.float32)
        if not np.all(np.isfinite(arr)):
            continue
        ids.append(int(sid))
        vecs.append(l2_normalize(arr))
    conn.close()
    if not vecs:
        return [], None
    return ids, np.vstack(vecs).astype(np.float32)


def match_gallery_matrix(
    emb: np.ndarray,
    ids: List[int],
    mat: Optional[np.ndarray],
    threshold: float,
    min_margin: float,
) -> Tuple[Optional[int], float, float, bool]:
    if mat is None or len(ids) == 0:
        return None, 0.0, 0.0, False
    sims = mat @ emb
    if sims.size == 1:
        s1 = max(0.0, float(sims[0]))
        ok = s1 >= threshold
        return (ids[0] if ok else None), s1, s1, ok
    order = np.argsort(-sims)
    i1, i2 = int(order[0]), int(order[1])
    s1 = max(0.0, float(sims[i1]))
    s2 = max(0.0, float(sims[i2]))
    margin = max(0.0, s1 - s2)
    ok = s1 >= threshold and margin >= min_margin
    return (ids[i1] if ok else None), s1, margin, ok


class ScrfdPython:
    def __init__(self, model_path: str, intra_threads: int, det_thresh: float = 0.5, nms_thresh: float = 0.4):
        self.sess = make_ort_session(model_path, intra_threads)
        self.input_name = self.sess.get_inputs()[0].name
        self.output_names = [o.name for o in self.sess.get_outputs()]
        self.det_thresh = det_thresh
        self.nms_thresh = nms_thresh
        self.center_cache: Dict[Tuple[int, int, int], np.ndarray] = {}

    def detect(self, bgr: np.ndarray, input_size: int = 640) -> List[Tuple[np.ndarray, float, np.ndarray]]:
        h, w = bgr.shape[:2]
        im_ratio = float(h) / float(w)
        if im_ratio > 1.0:
            new_h = input_size
            new_w = max(1, int(new_h / im_ratio))
        else:
            new_w = input_size
            new_h = max(1, int(new_w * im_ratio))
        det_scale = float(new_h) / float(h)
        resized = cv2.resize(bgr, (new_w, new_h))
        det_img = np.zeros((input_size, input_size, 3), dtype=np.uint8)
        det_img[:new_h, :new_w, :] = resized
        blob = cv2.dnn.blobFromImage(
            det_img,
            1.0 / 128.0,
            (input_size, input_size),
            (127.5, 127.5, 127.5),
            swapRB=True,
        )
        outs = self.sess.run(self.output_names, {self.input_name: np.ascontiguousarray(blob, dtype=np.float32)})
        batched = len(outs[0].shape) == 3
        fmc = 3
        strides = (8, 16, 32)
        num_anchors = 2
        scores_all, bboxes_all, kpss_all = [], [], []
        for idx, stride in enumerate(strides):
            scores = outs[idx][0] if batched else outs[idx]
            bbox_preds = (outs[idx + fmc][0] if batched else outs[idx + fmc]) * stride
            kps_preds = (outs[idx + fmc * 2][0] if batched else outs[idx + fmc * 2]) * stride
            fh, fw = input_size // stride, input_size // stride
            key = (fh, fw, stride)
            if key not in self.center_cache:
                ac = np.stack(np.mgrid[:fh, :fw][::-1], axis=-1).astype(np.float32)
                ac = (ac * stride).reshape((-1, 2))
                ac = np.stack([ac] * num_anchors, axis=1).reshape((-1, 2))
                self.center_cache[key] = ac
            centers = self.center_cache[key]
            pos = np.where(scores.ravel() >= self.det_thresh)[0]
            if pos.size == 0:
                continue
            sc = scores.ravel()[pos]
            bp = bbox_preds[pos]
            cp = centers[pos]
            kp = kps_preds[pos]
            x1 = (cp[:, 0] - bp[:, 0]) / det_scale
            y1 = (cp[:, 1] - bp[:, 1]) / det_scale
            x2 = (cp[:, 0] + bp[:, 2]) / det_scale
            y2 = (cp[:, 1] + bp[:, 3]) / det_scale
            kps = np.zeros((pos.size, 5, 2), dtype=np.float32)
            for k in range(5):
                kps[:, k, 0] = (cp[:, 0] + kp[:, k * 2]) / det_scale
                kps[:, k, 1] = (cp[:, 1] + kp[:, k * 2 + 1]) / det_scale
            scores_all.append(sc)
            bboxes_all.append(np.stack([x1, y1, x2, y2], axis=-1))
            kpss_all.append(kps)
        if not scores_all:
            return []
        sc = np.concatenate(scores_all)
        bb = np.vstack(bboxes_all)
        kp = np.vstack(kpss_all)
        order = np.argsort(-sc, kind="stable")
        bb, sc, kp = bb[order], sc[order], kp[order]
        keep = self._nms(bb, sc)
        return [(bb[i], float(sc[i]), kp[i]) for i in keep]

    def _nms(self, bb: np.ndarray, sc: np.ndarray) -> List[int]:
        x1, y1, x2, y2 = bb[:, 0], bb[:, 1], bb[:, 2], bb[:, 3]
        areas = np.maximum(0.0, x2 - x1 + 1.0) * np.maximum(0.0, y2 - y1 + 1.0)
        order = np.argsort(-sc, kind="stable")
        keep = []
        while order.size > 0:
            i = int(order[0])
            keep.append(i)
            xx1 = np.maximum(x1[i], x1[order[1:]])
            yy1 = np.maximum(y1[i], y1[order[1:]])
            xx2 = np.minimum(x2[i], x2[order[1:]])
            yy2 = np.minimum(y2[i], y2[order[1:]])
            inter = np.maximum(0.0, xx2 - xx1 + 1.0) * np.maximum(0.0, yy2 - yy1 + 1.0)
            ovr = inter / np.maximum(1e-6, areas[i] + areas[order[1:]] - inter)
            order = order[np.where(ovr <= self.nms_thresh)[0] + 1]
        return keep


def probe_video_wh(video_path: str) -> Tuple[int, int]:
    out = subprocess.check_output(
        [
            "ffprobe",
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=width,height",
            "-of",
            "csv=s=x:p=0",
            video_path,
        ],
        text=True,
    )
    w, h = out.strip().splitlines()[0].split("x")
    return int(w), int(h)


def decode_frames_ffmpeg(video_path: str, max_frames: int, sample_fps: Optional[float]) -> List[np.ndarray]:
    w, h = probe_video_wh(video_path)
    frame_bytes = w * h * 3
    cmd = ["ffmpeg", "-v", "error", "-i", video_path]
    if sample_fps and sample_fps > 0.0:
        cmd.extend(["-vf", f"fps={sample_fps:.3f}"])
    cmd.extend(["-frames:v", str(max_frames), "-f", "rawvideo", "-pix_fmt", "rgb24", "-"])
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    assert proc.stdout is not None
    frames: List[np.ndarray] = []
    while len(frames) < max_frames:
        raw = proc.stdout.read(frame_bytes)
        if not raw or len(raw) < frame_bytes:
            break
        rgb = np.frombuffer(raw, dtype=np.uint8).reshape((h, w, 3))
        frames.append(cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR))
    proc.wait()
    return frames


def cmd_embedder(args: argparse.Namespace) -> None:
    crop_bgr = cv2.imread(args.crop_112)
    if crop_bgr is None or crop_bgr.shape[:2] != (112, 112):
        raise SystemExit(f"invalid 112x112 crop: {args.crop_112}")
    sess = make_ort_session(args.arcface_onnx, args.intra_threads)
    py_emb = embed_arcface_bgr112(sess, crop_bgr)

    rust_json = json.loads(Path(args.rust_json).read_text())
    rust_emb = np.asarray(rust_json["embedding"], dtype=np.float32)
    cos = cosine_sim(py_emb, rust_emb)
    max_diff = float(np.max(np.abs(py_emb - rust_emb)))

    out = {
        "onnxruntime_version": ort.__version__,
        "opencv_version": cv2.__version__,
        "cosine_rust_vs_python": cos,
        "max_abs_diff": max_diff,
        "python_l2_norm": float(np.linalg.norm(py_emb)),
        "rust_l2_norm": float(rust_json["l2_norm"]),
        "parity_pass_ge_0_999": cos >= 0.999,
    }
    print(json.dumps(out, indent=2))


def cmd_alignment(args: argparse.Namespace) -> None:
    rust_align = json.loads(Path(args.rust_align_json).read_text())
    img_bgr = cv2.imread(rust_align["image_path"])
    if img_bgr is None:
        raise SystemExit(f"failed to read {rust_align['image_path']}")
    src = np.asarray(rust_align["src_kps_5pt"], dtype=np.float32)
    dst = ARCFACE_DST_112

    m_cv_lmeds, _ = cv2.estimateAffinePartial2D(src, dst, method=cv2.LMEDS)
    m_py_ls = estimate_similarity_ls_2d(src, dst)
    crop_cv_lmeds = cv2.warpAffine(img_bgr, m_cv_lmeds, (112, 112), borderValue=0.0)
    crop_py_ls = cv2.warpAffine(img_bgr, m_py_ls, (112, 112), borderValue=0.0)

    sess = make_ort_session(args.arcface_onnx, args.intra_threads)
    emb_cv_lmeds = embed_arcface_bgr112(sess, crop_cv_lmeds)
    emb_py_ls = embed_arcface_bgr112(sess, crop_py_ls)
    emb_rust_lmeds = np.asarray(rust_align["embedding_lmeds"], dtype=np.float32)
    emb_rust_ls = np.asarray(rust_align["embedding_ls"], dtype=np.float32)

    m_rust_lmeds = np.asarray(rust_align["matrix_lmeds"], dtype=np.float64)
    m_rust_ls = np.asarray(rust_align["matrix_ls"], dtype=np.float64)

    out = {
        "matrix_cv2_lmeds": m_cv_lmeds.tolist(),
        "matrix_python_ls": m_py_ls.tolist(),
        "matrix_diff_cv2_lmeds_vs_python_ls": float(np.max(np.abs(m_cv_lmeds - m_py_ls))),
        "matrix_diff_rust_lmeds_vs_cv2_lmeds": float(np.max(np.abs(m_rust_lmeds - m_cv_lmeds))),
        "matrix_diff_rust_ls_vs_python_ls": float(np.max(np.abs(m_rust_ls - m_py_ls))),
        "cosine_python_cv2_lmeds_vs_python_ls": cosine_sim(emb_cv_lmeds, emb_py_ls),
        "cosine_rust_lmeds_vs_cv2_lmeds": cosine_sim(emb_rust_lmeds, emb_cv_lmeds),
        "cosine_rust_ls_vs_python_ls": cosine_sim(emb_rust_ls, emb_py_ls),
        "cosine_rust_lmeds_vs_rust_ls": float(rust_align["embedding_cosine_ls_vs_lmeds"]),
    }
    print(json.dumps(out, indent=2))


def cmd_video_baseline(args: argparse.Namespace) -> None:
    ids, mat = load_sqlite_gallery(args.db)
    frames = decode_frames_ffmpeg(args.video, args.max_frames, args.sample_fps)
    det = ScrfdPython(args.det_onnx, args.intra_threads, det_thresh=args.det_thresh)
    emb_sess = make_ort_session(args.arcface_onnx, args.intra_threads)

    if frames:
        _ = det.detect(frames[0])

    buckets = {k: 0 for k in ["<40", "40-59", "60-79", "80-99", "100-129", "130+"]}
    lats = []
    total_faces = 0
    ge_80 = 0
    matched_ge = 0
    accepted = 0
    sims = []
    events = []

    for idx, bgr in enumerate(frames):
        t0 = time.perf_counter()
        faces = det.detect(bgr)
        for bb, sc, kps in faces:
            total_faces += 1
            wpx = max(0.0, float(bb[2] - bb[0]))
            bkt = bucket_for_width(wpx)
            buckets[bkt] += 1
            if wpx >= 80.0:
                ge_80 += 1
            m, _ = cv2.estimateAffinePartial2D(kps.astype(np.float32), ARCFACE_DST_112, method=cv2.LMEDS)
            if m is None:
                continue
            crop = cv2.warpAffine(bgr, m, (112, 112), borderValue=0.0)
            emb = embed_arcface_bgr112(emb_sess, crop)
            sid, sim, margin, acc = match_gallery_matrix(emb, ids, mat, args.match_thresh, args.min_margin)
            sims.append(sim)
            if sim >= args.match_thresh:
                matched_ge += 1
            if acc:
                accepted += 1
            events.append(
                {
                    "frame_index": idx,
                    "width_px": wpx,
                    "bucket": bkt,
                    "top1_student_id": sid,
                    "top1_sim": sim,
                    "margin": margin,
                }
            )
        lats.append((time.perf_counter() - t0) * 1000.0)

    peak_rss_mb = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024.0
    out = {
        "path_name": "Python Baseline (SCRFD det_10g + cv2.LMEDS + w600k_r50)",
        "onnxruntime_version": ort.__version__,
        "opencv_version": cv2.__version__,
        "frames_processed": len(frames),
        "gallery_size": len(ids),
        "total_faces_detected": total_faces,
        "faces_ge_80px": ge_80,
        "detections_per_width_bucket": buckets,
        "latency_ms_p50": float(np.percentile(lats, 50)) if lats else 0.0,
        "latency_ms_p95": float(np.percentile(lats, 95)) if lats else 0.0,
        "latency_ms_mean": float(np.mean(lats)) if lats else 0.0,
        "gallery_matched_top1_count": matched_ge,
        "gallery_margin_accepted_count": accepted,
        "top1_similarity_mean": float(np.mean(sims)) if sims else 0.0,
        "peak_rss_mb": peak_rss_mb,
        "frame_events": events,
    }
    print(json.dumps(out, indent=2))


def agreement_vs_python(py_events: List[Dict[str, Any]], rust_events: List[Dict[str, Any]]) -> Dict[str, Any]:
    py_by_frame: Dict[int, List[int]] = {}
    for ev in py_events:
        if ev.get("top1_student_id") is not None:
            py_by_frame.setdefault(int(ev["frame_index"]), []).append(int(ev["top1_student_id"]))

    rust_by_frame: Dict[int, List[int]] = {}
    for ev in rust_events:
        if ev.get("top1_student_id") is not None:
            rust_by_frame.setdefault(int(ev["frame_index"]), []).append(int(ev["top1_student_id"]))

    compared = 0
    matched = 0
    for fidx, py_ids in py_by_frame.items():
        r_ids = set(rust_by_frame.get(fidx, []))
        for pid in py_ids:
            compared += 1
            if pid in r_ids:
                matched += 1
    return {
        "python_accepted_events": compared,
        "same_student_id_in_frame": matched,
        "top1_agreement_rate": (matched / compared) if compared > 0 else None,
    }


def cmd_compose_report(args: argparse.Namespace) -> None:
    def load(p: Optional[str]) -> Any:
        if not p or not os.path.exists(p):
            return None
        return json.loads(Path(p).read_text())

    env_meta = load(args.env_json) or {}
    db_audit = load(args.audit_db_json)
    verify_mp = load(args.verify_mp_json)
    emb_cmp = load(args.embedder_py_json)
    align_cmp = load(args.alignment_py_json)
    bench_a = load(args.bench_a_json)
    bench_b = load(args.bench_b_json)
    py_vid = load(args.video_py_json)

    stats_a = (bench_a or {}).get("path_a_mediapipe")
    stats_b = (bench_b or {}).get("path_b_scrfd")

    agree_a = (
        agreement_vs_python(py_vid.get("frame_events", []), bench_a.get("frame_events_path_a", []))
        if py_vid and bench_a
        else None
    )
    agree_b = (
        agreement_vs_python(py_vid.get("frame_events", []), bench_b.get("frame_events_path_b", []))
        if py_vid and bench_b
        else None
    )

    py_ge80 = (py_vid or {}).get("faces_ge_80px", 0)
    rec_a_ge80 = (stats_a["faces_ge_80px"] / py_ge80) if (stats_a and py_ge80 > 0) else None
    rec_b_ge80 = (stats_b["faces_ge_80px"] / py_ge80) if (stats_b and py_ge80 > 0) else None

    report = {
        "env": env_meta,
        "db_audit": db_audit,
        "mediapipe_verification": verify_mp,
        "embedder_parity": emb_cmp,
        "alignment_lmeds_vs_ls": align_cmp,
        "benchmark": {
            "blazeface_tflite": {
                "total": (bench_a or {}).get("blazeface_tflite_total_detections"),
                "ge_80px": (bench_a or {}).get("blazeface_tflite_ge_80px"),
                "p50_ms": (bench_a or {}).get("blazeface_tflite_p50_ms"),
                "p95_ms": (bench_a or {}).get("blazeface_tflite_p95_ms"),
            },
            "path_a_mediapipe": stats_a,
            "path_b_scrfd": stats_b,
            "python_baseline": {k: v for k, v in (py_vid or {}).items() if k != "frame_events"},
            "recall_ge_80px_vs_python": {
                "path_a": rec_a_ge80,
                "path_b": rec_b_ge80,
            },
            "top1_agreement_vs_python_gallery": {
                "path_a": agree_a,
                "path_b": agree_b,
            },
        },
    }

    Path(args.out_json).write_text(json.dumps(report, indent=2))

    # Build concise Markdown summary
    lines = [
        "# Gate A Spike Report",
        "",
        "## Kriteria Pemilihan (Dinyatakan Sebelum Angka Masuk)",
        "- Recall wajah `>= 80 px` pada rekaman CCTV nyata (`>= 95%` vs Python SCRFD).",
        "- Latensi `p95` ms/frame dalam anggaran 8 stream @ 10 FPS (`<= 80 ms/frame`, target `<= 50 ms/frame`).",
        "- Kompatibilitas dengan galeri lama `students.embedding` (crop cosine `>= 0.999`, top-1 agreement tinggi).",
        "- **Tie-breaker**: Jika Jalur A mengharuskan reindex galeri lama dan Jalur B tidak, Jalur B menang saat hasil seri.",
        "",
        "## 1. Environment & Crate Versions",
        f"- `rustc`: `{env_meta.get('rustc_version', 'N/A')}`",
        f"- `lscpu`: `{env_meta.get('cpu_model', 'N/A')}` ({env_meta.get('nproc', 'N/A')} threads)",
        f"- `MEDIAPIPE_LIB`: `{env_meta.get('mediapipe_lib', 'N/A')}`",
        f"- `ffmpeg-next` dev headers present: `{env_meta.get('ffmpeg_dev_headers', 'N/A')}`",
        "",
        "## 2. SQLite `students.embedding` Audit",
        f"- Total siswa: `{(db_audit or {}).get('total_students')}` | NULL: `{(db_audit or {}).get('null_embedding_rows')}` | Valid 512-D: `{(db_audit or {}).get('valid_512d_rows')}`",
        f"- L2-normalized?: `{(db_audit or {}).get('is_l2_normalized')}` (norm min/mean/max: `{(db_audit or {}).get('norm_min')}` / `{(db_audit or {}).get('norm_mean')}` / `{(db_audit or {}).get('norm_max')}`)",
        "",
        "## 3. Format Model `mediapipe` Crate & Orientasi 5-Titik",
        f"- `FaceDetector`: format `{(verify_mp or {}).get('detector_format')}` | faces=`{(verify_mp or {}).get('detector_faces_found')}`",
        f"- `FaceLandmarker`: format `{(verify_mp or {}).get('landmarker_format')}` | faces=`{(verify_mp or {}).get('landmarker_faces_found')}`",
        "",
        "## 4. Embedder Parity (`w600k_r50.onnx` Crop 112x112 Identik)",
        f"- Cosine Rust (`ort`) vs Python (`onnxruntime`): `{(emb_cmp or {}).get('cosine_rust_vs_python')}` | Max abs diff: `{(emb_cmp or {}).get('max_abs_diff')}`",
        "",
        "## 5. Alignment LMEDS vs Least-Squares (5 Titik Sama)",
        f"- Cosine Python `cv2.LMEDS` vs Python LS: `{(align_cmp or {}).get('cosine_python_cv2_lmeds_vs_python_ls')}`",
        f"- Cosine Rust LMEDS vs Python `cv2.LMEDS`: `{(align_cmp or {}).get('cosine_rust_lmeds_vs_cv2_lmeds')}` (matrix max diff: `{(align_cmp or {}).get('matrix_diff_rust_lmeds_vs_cv2_lmeds')}`)",
        f"- Cosine Rust LMEDS vs Rust LS: `{(align_cmp or {}).get('cosine_rust_lmeds_vs_rust_ls')}`",
        "",
        "## 6. Perbandingan Jalur A (MediaPipe) vs Jalur B (SCRFD) vs Python Baseline",
        "| Metrik | Python Baseline | Jalur A (MediaPipe .task) | Jalur B (SCRFD .onnx) |",
        "|---|---:|---:|---:|",
        f"| Frame diproses | {(py_vid or {}).get('frames_processed')} | {(stats_a or {}).get('frames_processed')} | {(stats_b or {}).get('frames_processed')} |",
        f"| Total deteksi | {(py_vid or {}).get('total_faces_detected')} | {(stats_a or {}).get('total_faces_detected')} | {(stats_b or {}).get('total_faces_detected')} |",
        f"| Deteksi >= 80 px | {py_ge80} | {(stats_a or {}).get('faces_ge_80px')} | {(stats_b or {}).get('faces_ge_80px')} |",
        f"| Recall >= 80 px vs Python | 1.000 | {rec_a_ge80} | {rec_b_ge80} |",
        f"| Latensi p50 (ms/frame) | {(py_vid or {}).get('latency_ms_p50')} | {(stats_a or {}).get('latency_ms_p50')} | {(stats_b or {}).get('latency_ms_p50')} |",
        f"| Latensi p95 (ms/frame) | {(py_vid or {}).get('latency_ms_p95')} | {(stats_a or {}).get('latency_ms_p95')} | {(stats_b or {}).get('latency_ms_p95')} |",
        f"| Peak RSS (MB) | {(py_vid or {}).get('peak_rss_mb')} | {(stats_a or {}).get('peak_rss_mb_after')} | {(stats_b or {}).get('peak_rss_mb_after')} |",
        f"| Gallery Top-1 Accepted | {(py_vid or {}).get('gallery_margin_accepted_count')} | {(stats_a or {}).get('gallery_margin_accepted_count')} | {(stats_b or {}).get('gallery_margin_accepted_count')} |",
        f"| Top-1 Agreement vs Python | 1.000 | {(agree_a or {}).get('top1_agreement_rate')} | {(agree_b or {}).get('top1_agreement_rate')} |",
        "",
        f"- BlazeFace `.tflite` only: total=`{(bench_a or {}).get('blazeface_tflite_total_detections')}`, >=80px=`{(bench_a or {}).get('blazeface_tflite_ge_80px')}`, p50=`{(bench_a or {}).get('blazeface_tflite_p50_ms')}` ms, p95=`{(bench_a or {}).get('blazeface_tflite_p95_ms')}` ms",
        f"- Bucket width Jalur A: `{json.dumps((stats_a or {}).get('detections_per_width_bucket'))}`",
        f"- Bucket width Jalur B: `{json.dumps((stats_b or {}).get('detections_per_width_bucket'))}`",
        f"- Bucket width Python: `{json.dumps((py_vid or {}).get('detections_per_width_bucket'))}`",
    ]
    Path(args.out_md).write_text("\n".join(lines) + "\n")


def main() -> None:
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest="cmd", required=True)

    pe = sub.add_parser("embedder")
    pe.add_argument("--arcface-onnx", required=True)
    pe.add_argument("--crop-112", required=True)
    pe.add_argument("--rust-json", required=True)
    pe.add_argument("--intra-threads", type=int, default=4)

    pa = sub.add_parser("alignment")
    pa.add_argument("--arcface-onnx", required=True)
    pa.add_argument("--rust-align-json", required=True)
    pa.add_argument("--intra-threads", type=int, default=4)

    pv = sub.add_parser("video-baseline")
    pv.add_argument("--video", required=True)
    pv.add_argument("--db", required=True)
    pv.add_argument("--det-onnx", required=True)
    pv.add_argument("--arcface-onnx", required=True)
    pv.add_argument("--max-frames", type=int, default=300)
    pv.add_argument("--sample-fps", type=float, default=None)
    pv.add_argument("--intra-threads", type=int, default=4)
    pv.add_argument("--det-thresh", type=float, default=0.50)
    pv.add_argument("--match-thresh", type=float, default=0.60)
    pv.add_argument("--min-margin", type=float, default=0.08)

    pc = sub.add_parser("compose-report")
    pc.add_argument("--env-json")
    pc.add_argument("--audit-db-json")
    pc.add_argument("--verify-mp-json")
    pc.add_argument("--embedder-py-json")
    pc.add_argument("--alignment-py-json")
    pc.add_argument("--bench-a-json")
    pc.add_argument("--bench-b-json")
    pc.add_argument("--video-py-json")
    pc.add_argument("--out-json", required=True)
    pc.add_argument("--out-md", required=True)

    args = p.parse_args()
    if args.cmd == "embedder":
        cmd_embedder(args)
    elif args.cmd == "alignment":
        cmd_alignment(args)
    elif args.cmd == "video-baseline":
        cmd_video_baseline(args)
    elif args.cmd == "compose-report":
        cmd_compose_report(args)


if __name__ == "__main__":
    main()
