# DECISIONS.md — Architectural & Engineering Decisions (Gate B–E)

Last updated: 2026-11-27
Branch: `rust-engine`

## 1. Selected Pipeline Path: Jalur B (SCRFD `det_10g.onnx` + LMEDS 5-pt + ArcFace `w600k_r50.onnx` via `ort`)
- **Decision:** Use `det_10g.onnx` (SCRFD 5-keypoint face detector) + deterministic 5-point LMEDS similarity alignment (`ARCFACE_DST_112`) + `w600k_r50.onnx` (ResNet-50 512-D ArcFace embedder) loaded via `ort = "2.0.0-rc.10"` (`load-dynamic` linking `/usr/local/lib/libonnxruntime.so`).
- **Reason:** `gate_a_report` was not present in the workspace, so the fallback/tie-breaker rule mandates Jalur B. Legacy embeddings in `students.embedding` were produced with InsightFace (`buffalo_l`: SCRFD `det_10g` + `cv2.estimateAffinePartial2D(LMEDS)` + `w600k_r50`). Using the identical ONNX models + LMEDS alignment preserves legacy gallery compatibility without forced immediate reindex.
- **Alternatives Rejected:**
  - MediaPipe BlazeFace + FaceMesh (`Jalur A`): different detector/landmark geometry requiring gallery reindex on tie.
  - Python InsightFace (`services/face-service`): suffered from multi-worker thread oversubscription (`OMP`/`OpenBLAS`/`ORT`), high RSS (~1.6 GB per worker), and process explosion outside Docker.
  - Node.js WASM (`human` / `@tensorflow/tfjs-wasm`): already eliminated; permanently banned.

## 2. Threshold & Parameter Policy (`BELUM TERKALIBRASI` — Externalized to SQLite/Config)
- **Decision:** Store ALL detection, quality-gate, matching, voting, and cooldown thresholds in runtime config hydrated from SQLite `settings` table (`app_settings` JSON key, synchronized via `/api/internal/gallery` and startup SQLite read). Conservative defaults when DB/setting is absent:
  - `embed_min_face_px = 80` (`min_face_size` used as embedding gate tier; detections `40..79 px` are tracked/counted without embedding or can track-only)
  - `threshold_recognition = 0.70`
  - `match_margin_min = 0.08` (`top1 - top2 >= 0.08`, critical for 5000 children profiles)
  - `max_pitch_deg = 30`, `max_yaw_deg = 30`
  - `blur_threshold = 100.0` (Laplacian variance computed strictly on **aligned 112x112 RGB crop**, NOT raw unaligned bbox)
  - `vote_threshold = 0.65`, `vote_window_sec = 10`, `min_votes = 2`
  - `dedup_cooldown_sec = 6` (tracker + attendance dedup window)
- **Reason:** Child faces have higher inter-similarity than adults; prioritizing precision avoids false attendance / wrong parent WA notifications.
- **Calibration Status:** **BELUM TERKALIBRASI** (no VPS recordings in sandbox; owner must run `scripts/verify_all.sh` and calibrate ROC/FAR on real school footage).

## 3. ORT Binary Packaging & Airgapped Rust Build
- **Decision:** Enable `ort` with `default-features = false, features = ["std", "ndarray", "load-dynamic"]` (ORT `2.0.0-rc.10`, ONNX Runtime `1.22.0`). Pre-download Microsoft/pyke ORT `1.22.0` (`ED1716DE95974BF47AB0223CA33734A0B5A5D09A181225D0E8ED62D070AEA893`) into `/usr/local/lib/libonnxruntime.so` during Docker build and vendor Rust crates with `cargo vendor`. Verify SHA256 of `.onnx` models AND `libonnxruntime.so` at `face-engine` startup (`exit != 0` on mismatch).
- **Reason:** Guarantees `cargo build --release --locked --offline` runs airgapped inside Docker without runtime downloads and enforces supply-chain integrity on fail-fast startup.

## 4. In-Process RTSP Decoding (`ffmpeg-next 7.1.0`) & Zero Frame Backlog
- **Decision:** Decode up to **8** active RTSP streams directly inside `face-engine` via `ffmpeg-next` (linking Debian Bookworm `libavcodec59`/`libavformat59`/`libswscale6`) using dedicated camera tasks writing into a **single-slot `LatestFrameSlot` (`watch`/overwrite)** with exponential backoff reconnect (`1s..30s`). Never spawn `ffmpeg` subprocesses from `face-engine` and never queue frames in FIFO channels.
- **Reason:** Eliminates host/container ffmpeg process explosion while keeping per-camera memory O(1 frame) and latency minimal under bursts.

## 5. Tracker, Dedup, and Bounded Concurrency
- **Decision:** Per-camera IoU + centroid fallback tracker (`ttl = 4000ms`), `TrackVoteBuffer` (`min_votes = 2`, `vote_window_sec = 10s`), per-student+camera **6s** dedup cooldown, and bounded inference threadpool (`ORT_INTRA_THREADS` capped, `inter_threads = 1`, `parallel_execution = false`).
- **Reason:** Prevents rapid frame-by-frame duplicate API posts/snapshots and avoids thread oversubscription on 8c/16t hardware.

## 6. Anonymous Clustering via `hdbscan 0.12.0`
- **Decision:** Run incremental centroid assignment at live capture time (consistent with existing `anonymous_clusters` table) PLUS `hdbscan 0.12.0` batch/sub-clustering (`DistanceMetric::Euclidean`) over L2-normalized 512-D embeddings.
- **Mathematical Equivalence:** For unit vectors $\|a\|_2 = \|b\|_2 = 1$, $\|a - b\|_2^2 = 2(1 - a \cdot b)$, so Euclidean HDBSCAN preserves exact monotonic rank order with cosine distance.

## 7. Database Schema Extension & Interop (`Float32` LE `BLOB`)
- **Decision:** Keep SQLite WAL (`synchronous = NORMAL`, `busy_timeout = 5000ms`) and add strictly additive nullable columns via `ensureColumn`:
  - `students.pipeline_version TEXT` (`NULL` = legacy)
  - `students.model_sha256 TEXT`
  - `face_update_history.pipeline_version TEXT`
  - `face_update_history.model_sha256 TEXT`
- **Reason:** Zero-downtime migration preserving all legacy rows while letting `/enroll`, `/reindex`, and `face-engine` detect legacy vs current-pipeline embeddings.

## 8. Process Supervision (`s6-overlay v3.2.3.2`) & Standalone Node Baileys WA Gateway
- **Decision:** Replace `supervisord` + Python Selenium/Chromium WA gateway with `s6-overlay v3.2.3.2` managing 3 foreground services:
  1. `face-engine` (fatal exit `!= 0` writes exit code to `/run/s6-linux-init-container-results/exitcode` and invokes `/run/s6/basedir/bin/halt` -> container stops with `exit != 0`)
  2. `node-web` (Main Express + Vite dist server on port `80`/`PORT`, auto-restarts on crash)
  3. `wa-gateway` (Standalone Node.js Baileys daemon on `127.0.0.1:8003`, auto-restarts on crash)
- **Reason:** Zero Python, zero Chromium/Xvfb, explicit fail-fast SLA for biometric engine while preserving resilient restart for web & WhatsApp delivery.
