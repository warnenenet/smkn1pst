# PROGRESS.md — Eksekusi Otomatis Gate B–E (`rust-engine`)

Catatan Lingkungan Sandbox: `rustc`, `cargo`, dan `docker` **tidak terpasang** di sandbox pembuatan kode (`node v22.23.5`, `python3 3.11.2`, `git`, `ffmpeg` CLI tersedia). Semua pengujian Rust, benchmark, Docker build, dan uji live RTSP/s6 kill-switch ditandai secara jujur sebagai **`UNVERIFIED`** sampai dieksekusi di VPS target melalui `bash scripts/verify_all.sh`.

| Gate | Modul / Deliverable | Test Ditulis Dulu | Status Kode | Verifikasi Sandbox | Verifikasi VPS (`scripts/verify_all.sh`) |
|---|---|---|---|---|---|
| Baseline | Snapshot awal `main` + branch `rust-engine` + docs | N/A | SELESAI (`22a15fb`) | PASS (`git log`) | N/A |
| Baseline | `DECISIONS.md` (arsitektur, SLA, keputusan tetap) | N/A | SELESAI (`6cdc0e6`) | PASS | N/A |
| Gate B | Kolom DB aditif (`pipeline_version`, `model_sha256`) & TS codec round-trip | `src/lib/faceInterop.test.ts` (`cda977d`) | SELESAI (`c916163`) | **PASS** (`88/88` TS tests) | PENDING |
| Gate B | `config` & `models` (SHA256 fail-fast, load SQLite settings) | `tests/config_models_test.rs` (`352df2d`) | SELESAI (`80f1bb7`) | `UNVERIFIED` (tanpa cargo) | Cargo test |
| Gate B | `det_scrfd` (SCRFD det_10g, 5-pt landmark, 6 kasus uji) | `tests/det_scrfd_test.rs` (`462bfc1`) | SELESAI (`3d3acef`) | `UNVERIFIED` | Cargo test |
| Gate B | `align` (deterministic 5-pt LMEDS -> 112x112 bilinear warp) | `tests/align_test.rs` (`6d4a009`) | SELESAI (`f9c4465`) | `UNVERIFIED` | Cargo test (`<2px` err) |
| Gate B | `quality_gate` (tier ukuran, Laplacian blur di 112x112, yaw/pitch) | `tests/quality_gate_test.rs` (`72af409`) | SELESAI (`f17aa30`) | `UNVERIFIED` | Cargo test |
| Gate B | `embedder` (ort ArcFace) + `gallery` + `matching` + `voting` | `tests/matching_gallery_test.rs` (`8302134`) | SELESAI (`7267856`) | `UNVERIFIED` | Cargo test + Paritas |
| Gate B | `tracker` (IoU + 6s cooldown + single-slot `LatestFrameSlot`) | `tests/tracker_test.rs` (`4c29675`) | SELESAI (`dc9dfe0`) | `UNVERIFIED` | Cargo test + 6s dedup |
| Gate B | `clustering` (`hdbscan 0.12.0` + incremental centroid) | `tests/clustering_test.rs` (`afb4a6f`) | SELESAI (`c0b159c`) | `UNVERIFIED` | Cargo test |
| Gate B | `db` (SQLite WAL + `busy_timeout=5000`, norm check, CLI subcommands) | `tests/db_test.rs` (`5b33de4`) | SELESAI (`3c77892`) | `UNVERIFIED` | Cargo test + audit |
| Gate C | `rtsp` (`ffmpeg-next` in-process, cap 8 stream, backoff) + `pipeline` | `tests/rtsp_pipeline_test.rs` (`1eb0eea`) | SELESAI (`426732e`) | `UNVERIFIED` | 8-stream bench 5m |
| Gate C | `snapshot` writer (`<1MB/s`) + `debug_png` tmpfs + `http_api` + telemetry | `tests/http_snapshot_test.rs` (`b2c1ecc`) | SELESAI (`96da0b0`) | `UNVERIFIED` | Debug PNG + metrics |
| Gate C | `bench` CLI (`detect`, `embed`, `match 5000`, `pipeline`) | `tests/bench_smoke_test.rs` (`3621c61`) | SELESAI (`3621c61`) | `UNVERIFIED` | Bench targets (<15ms/<250ms/<1ms) |
| Gate C | Standalone `wa-gateway-node` (Baileys ESM, port 8003, no Python/Chrome) | `src/lib/waGatewayContract.test.ts` (`e39f554`) | SELESAI (`ab48210`) | **PASS** (`node --check`, TS contract) | Send + reconnect test |
| Gate E | Multi-stage `Dockerfile` + `s6-overlay v3.2.3.2` + Compose override staging | `docker/s6-rc.d/**` | SELESAI (`abb963e`) | **PASS** (`bash -n` scripts) | Docker build + hygiene + kill-switch |
| Gate D | `scripts/verify_all.sh` + `scripts/parity_check.py` (Gate D VPS runner) | Test suite Gate D (`bedf120`) | SELESAI (`bedf120`) | **PASS** (`bash -n`, dry-run OK) | Full run di VPS |
| CI | Pembersihan script CI & update setup untuk All-in-One | `src/lib/*.test.ts` | SELESAI (`b73a734`) | **PASS** (`tsc`, Vite build) | GitHub Actions |
| Cutover | Penghapusan layanan Python & supervisord (commit TERAKHIR) | N/A | SIAP DIKOMIT | **PASS** (Zero Python runtime di Dockerfile) | Container audit (0 Python/WASM/Chrome) |
| Final | `KESIMPULAN.md` | N/A | DOKUMENTASI FINAL | **PASS** | Panduan eksekusi VPS |
