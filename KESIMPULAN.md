# KESIMPULAN — Migrasi Penuh Pipeline Wajah ke Rust Murni (`face-engine`) & Docker All-in-One

Dokumen ini adalah laporan akhir penyelesaian tugas migrasi big-bang: mengganti seluruh pipeline ekstraksi fitur wajah berbasis Python (InsightFace), percepatan terpisah `rust-accel`, dan microservice WhatsApp berbasis Selenium/Chromium menjadi **SATU binary Rust murni `face-engine`** serta **gateway Baileys Node.js murni**, yang dikelola oleh **`s6-overlay v3.2.3.2`** di dalam satu container Docker All-in-One.

---

## 1. Executive Verdict

### **STATUS: BELUM SIAP — MENUNGGU VERIFIKASI & KALIBRASI VPS**

> **Mengapa bukan "SIAP DEPLOY"?**
> Mengikuti disiplin Karpathy: *"Jangan menebak. Ukur. Jika tidak bisa dibuktikan dengan angka, itu belum selesai."*
> 
> Seluruh kode sumber Rust (`services/face-engine`), gateway WA Baileys (`services/wa-gateway-node`), konfigurasi s6-overlay, Dockerfile multi-stage, dan integrasi TypeScript telah selesai ditulis dan lolos seluruh pengujian lokal (`88/88` test TypeScript lulus, typecheck lulus, Vite build lulus, `node --check` lulus, dan sintaksis bash lulus).
> 
> Namun, karena lingkungan sandbox pembuatan kode **tidak memiliki hardware video/kamera nyata, daemon Docker, maupun compiler `rustc`/`cargo`**, seluruh benchmark latensi (`<15ms`, `<250ms`, `<1ms`), uji konkurensi 8 stream RTSP, uji fail-fast kill-switch s6, dan kalibrasi ambang batas wajah anak-anak pada data riil berstatus **`UNVERIFIED`** dan **`BELUM TERKALIBRASI`**.
> 
> Sistem **baru dinyatakan siap produksi** setelah pemilik proyek menjalankan **`bash scripts/verify_all.sh`** di VPS target dan semua 10 checkpoint bertatus **PASS**.

---

## 2. Arsitektur Terkirim (Jalur B Terpilih)

Pipeline yang diimplementasikan adalah **Jalur B (SCRFD + LMEDS + ArcFace via `ort`)**:
1. **Deteksi Wajah**: SCRFD (`det_10g.onnx` via crate `ort 2.0.0-rc.10` / ONNX Runtime 1.22.0) dengan stride 8, 16, 32, dynamic NMS IoU 0.45, dan ekstraksi 5 titik landmark (mata kiri, mata kanan, hidung, sudut mulut kiri, sudut mulut kanan).
2. **Alignment 5-Titik Deterministic**: Algoritma Umeyama dengan kemiripan parsial (LMEDS) memetakan 5 titik ke template standar `ARCFACE_DST_112` (112x112 px) menggunakan bilinear warp berkecepatan tinggi.
3. **Quality Gate Terisolasi**:
   - Penghitungan blur Laplacian variance dihitung **secara ketat hanya pada crop 112x112 RGB hasil alignment** (bukan pada bounding box mentah yang sering terkontaminasi latar belakang bergerak).
   - Filter pose ekstrem: yaw `<= 30°` dan pitch `<= 30°`.
   - Tier resolusi wajah: `track_min_face_px = 40` (untuk pelacakan posisi) dan `embed_min_face_px = 80` (untuk ekstraksi biometrik absensi).
4. **Ekstraksi Embedding 512-D**: ResNet-50 ArcFace (`w600k_r50.onnx` via `ort`) dengan normalisasi L2 deterministik.
5. **Matching & Gallery**: Pencocokan 1:N batch cosine similarity terhadap 5.000+ profil siswa terdaftar (< 1 ms), dilengkapi pengecekan selisih margin skor tertinggi (`match_margin_min = 0.08`), multi-frame voting window (10 detik, minimal 2 vote valid), dan cooldown dedup anti-spam 6 detik.
6. **Clustering Anonim**: Algoritma `hdbscan 0.12.0` untuk pengelompokan wajah tidak dikenal tanpa melanggar privasi, dengan penugasan centroid inkremental.
7. **Dekoder RTSP In-Process**: Dekoder video internal berbasis `ffmpeg-next 7.1.0` (tanpa proses `ffmpeg` eksternal yang bocor di host), pembatasan ketat maksimal 8 worker kamera simultan, loopback guard, dan exponential backoff (1s hingga 30s).
8. **Budget I/O & Snapshot**: Writer snapshot asynchronous berbasis `tokio::task::spawn_blocking` dengan batas throughput `< 1 MB/s`, direktori debug PNG di `/tmp` (tmpfs RAM) dengan throttle 30s dan pembatasan maksimal 40 file.
9. **WhatsApp Gateway Node.js Mandiri**: `services/wa-gateway-node` berbasis Baileys v7 ESM di port `8003`, menggantikan total dependensi Python Selenium/Chromium/Xvfb.
10. **Process Supervisor**: `s6-overlay v3.2.3.2` sebagai PID 1. Jika `face-engine` mengalami fatal error, s6 langsung menghentikan container dengan exit code != 0 (**Fail-Fast SLA, tanpa fallback diam-diam ke Python**). Jika `node-web` atau `wa-gateway` mengalami crash, s6 me-restart otomatis dalam 2 detik.

---

## 3. Matriks Verifikasi

| Komponen / Checkpoint | Lingkungan Sandbox (Saat Ini) | Lingkungan VPS Target (`scripts/verify_all.sh`) | Kriteria Keberhasilan (SLA) |
|---|:---:|:---:|---|
| **TypeScript / Node Tests** | **PASS** (`88/88` test lulus) | Wajib PASS | `npx tsx --test src/lib/*.test.ts` tanpa error |
| **TypeScript Linting** | **PASS** (`tsc --noEmit`) | Wajib PASS | Zero warning & zero error |
| **Vite Bundle Build** | **PASS** | Wajib PASS | `npm run build` menghasilkan `dist/` bersih |
| **Baileys WA Gateway Syntax** | **PASS** (`node --check`) | Wajib PASS | Syntax ESM valid tanpa modul eksternal Python |
| **Bash Scripts Syntax** | **PASS** (`bash -n`) | Wajib PASS | Seluruh script lolos validasi POSIX/Bash |
| **Rust Unit Tests & Clippy** | `UNVERIFIED` (tanpa cargo) | Wajib PASS | `cargo test --release --locked` & `clippy` 0 warning |
| **Container Hygiene Audit** | `UNVERIFIED` (tanpa docker) | Wajib PASS | `0` Python, `0` Chromium, `0` WASM, `0` Supervisord di image |
| **Deteksi Latensi SCRFD** | `UNVERIFIED` | Target SLA | p95 `< 15 ms` per frame |
| **Ekstraksi Embedding ArcFace** | `UNVERIFIED` | Target SLA | p95 `< 250 ms` per wajah |
| **Pencocokan 5000 Galeri** | `UNVERIFIED` | Target SLA | p95 `< 1 ms` batch cosine |
| **Penggunaan RAM (RSS)** | `UNVERIFIED` | Target SLA | RSS `< 500 MB` saat 8 kamera aktif |
| **Beban Disk I/O** | `UNVERIFIED` | Target SLA | Laju tulis disk `< 1 MB/s` |
| **8-Stream RTSP Concurrency** | `UNVERIFIED` | Target SLA | Maksimal 8 thread aktif, drop frame terkendali |
| **Paritas Python vs Rust** | `UNVERIFIED` | Target SLA | Cosine similarity `>= 0.999` pada crop yang sama |
| **s6 Kill-Switch SLA** | `UNVERIFIED` | Target SLA | `face-engine` mati -> container exit != 0 |

---

## 4. Tabel Ambang Batas Wajah (`BELUM TERKALIBRASI`)

Semua ambang batas tersimpan dinamis di SQLite tabel `settings` (kunci `app_settings`), bukan hardcoded di kode sumber. Nilai awal menggunakan default konservatif yang memprioritaskan presisi (mencegah salah-cocok pada wajah anak):

| Parameter | Nilai Default | Status | Rasional & Panduan Kalibrasi di VPS |
|---|:---:|:---:|---|
| `threshold_recognition` | `0.70` | **BELUM TERKALIBRASI** | Mengutamakan presisi. Jika anak sulit terdeteksi saat pencahayaan sore, turunkan bertahap ke `0.65`. Jangan di bawah `0.60`. |
| `match_margin_min` | `0.08` | **BELUM TERKALIBRASI** | Mencegah salah identifikasi antar siswa mirip. Selisih skor top-1 dan top-2 harus `>= 0.08`. |
| `embed_min_face_px` | `80 px` | **BELUM TERKALIBRASI** | Wajah di bawah 80px diabaikan untuk absensi biometrik guna menghindari false-match akibat resolusi rendah. |
| `track_min_face_px` | `40 px` | **BELUM TERKALIBRASI** | Wajah 40–79px hanya dipakai untuk tracking lintasan, tidak dicocokkan ke database siswa. |
| `blur_threshold` | `100.0` | **BELUM TERKALIBRASI** | Variansi Laplacian pada crop 112x112. Wajah buram akibat lari/gerak cepat akan ditolak. |
| `max_pitch_deg` | `30°` | **BELUM TERKALIBRASI** | Kamera terpasang 2.5m di atas lantai mengharuskan sudut pandang menunduk. Jika kamera terlalu curam, sesuaikan ke `35°`. |
| `max_yaw_deg` | `30°` | **BELUM TERKALIBRASI** | Sudut wajah menoleh ke samping maksimal 30 derajat. |
| `dedup_cooldown_sec` | `6 detik` | Tetap | Mencegah log absensi tercatat berulang kali untuk siswa yang sama dalam jeda singkat. |
| `vote_threshold` | `0.65` | Tetap | Ambang kemiripan minimal untuk frame voting. |
| `vote_window_sec` | `10 detik` | Tetap | Jendela akumulasi voting identitas. |
| `vote_min_count` | `2 frame` | Tetap | Minimal 2 frame harus menyepakati identitas siswa yang sama sebelum absensi disahkan. |

*Semua parameter di atas dapat disesuaikan sewaktu-waktu melalui menu **Pengaturan -> Kalibrasi Kamera & Wajah** di dashboard web admin.*

---

## 4.1 Status Konfigurasi & Pin Hash SHA256

Telah diisikan 7 variabel konfigurasi pada file `.env` dan `docker-compose.yml` untuk lingkungan server 8 core / 16 thread:
- `HOST_PORT=3081` (port uji coba side-by-side)
- `DOCKER_CPU_LIMIT=12` (alokasi 12 vCPU)
- `DOCKER_MEM_LIMIT=4g` (batas RAM 4 GB)
- `DOCKER_PIDS_LIMIT=512` (pagar anti flood thread)
- `ORT_INTRA_THREADS=4` (4 thread inferensi per wajah)
- `MAX_CAMERA_WORKERS=8` (8 RTSP worker simultan)
- `PROCESS_EVERY_N_FRAMES=2` (rasio sampel frame 1:2)

### **STATUS PIN SHA256: BELUM DIPIN DARI INPUT MANUAL**
Tiga variabel sidik jari biometrik dibiarkan kosong:
- `DET_MODEL_SHA256=` *(kosong)*
- `REC_MODEL_SHA256=` *(kosong)*
- `ORT_DYLIB_SHA256=` *(kosong)*

**Implikasi & Mekanisme Pengamanan:**
1. Container **TIDAK** berjalan tanpa verifikasi. File `docker/entrypoint.sh` secara otomatis membaca file pin resmi (`/app/models/det_10g.sha256`, `/app/models/w600k_r50.sha256`, dan `/app/models/ort_dylib.sha256`) yang dihitung saat tahap multi-stage `docker build` langsung dari sumber resmi.
2. Binary `/app/bin/face-engine check-config` tetap memvalidasi integritas ketiga file tersebut sebelum service dinyalakan.
3. Jika di masa mendatang pemilik ingin mengunci hash secara manual dari luar container, jalankan `bash scripts/print_hashes.sh --apply` setelah image selesai di-build untuk menyalin string 64-karakter ke `.env`.

---

## 5. Prosedur Verifikasi VPS & Cutover Produksi

Ikuti langkah-langkah berikut di terminal VPS (sebagai user `root` atau user dengan akses Docker):

### Langkah 1: Jalankan Uji Verifikasi Otomatis (Non-Destruktif)
```bash
cd /opt/absensi-smk-face-ai   # sesuaikan dengan path instalasi Anda
git checkout rust-engine
bash scripts/verify_all.sh --db ./data/absensi.sqlite
```
Script ini akan:
- Menguji seluruh test suite TypeScript & Rust.
- Membangun image Docker dan mengaudit Container Hygiene (0 Python/Chromium).
- Menjalankan benchmark latensi dan konkurensi 8 stream RTSP.
- Menguji s6 kill-switch pada container staging terisolasi di port `3081`.
- Menulis laporan terstruktur ke `verify_reports/verify_report.md` dan `.json`.

### Langkah 2: Uji Coba Side-by-Side di Staging (Port 3081)
Tanpa mematikan sistem yang sedang berjalan, nyalakan container staging untuk evaluasi web dashboard:
```bash
cp docker-compose.override.example.yml docker-compose.override.staging.yml
mkdir -p ./staging-data ./staging-storage
cp ./data/absensi.sqlite ./staging-data/absensi.sqlite

docker compose -f docker-compose.yml -f docker-compose.override.staging.yml -p absensi-staging up -d --build
```
Buka browser di `http://IP-VPS:3081` dan periksa:
1. Status engine di Dashboard: pastikan menampilkan `Engine: Pure Rust (face-engine)`.
2. Halaman Kamera: periksa konektivitas 8 stream RTSP.
3. Halaman WhatsApp: hubungkan nomor WA via scan QR Baileys.

### Langkah 3: Eksekusi Cutover Produksi (Port 3080 atau Port 80)
Jika hasil uji coba staging memuaskan:
```bash
# 1. Hentikan container staging
docker compose -f docker-compose.yml -f docker-compose.override.staging.yml -p absensi-staging down

# 2. Hentikan seluruh proses lama di host VPS (mediamtx, ffmpeg testsrc, python lama)
bash scripts/setup-docker-allinone.sh --cleanup-host

# 3. Nyalakan sistem produksi All-in-One Docker
docker compose -f docker-compose.yml up -d --build
```

### Langkah 4: Prosedur Rollback Cepat (Jika Ditemukan Masalah)
Karena penghapusan Python dilakukan pada commit terpisah paling akhir (`cutover`), rollback dapat dilakukan seketika dalam hitungan detik:
```bash
# Kembalikan repository ke commit sebelum cutover:
git revert HEAD

# Atau kembali ke branch main:
git checkout main
docker compose -f docker-compose.face.yml up -d --build
```

---

## 6. Risiko & Rekomendasi Pemilik Proyek

1. **Ketinggian Kamera 2.5 Meter**:
   Kamera yang dipasang 2.5m di atas lantai menghadap siswa (terutama anak-anak yang tingginya 140–165 cm) menghasilkan sudut pitch yang tajam jika siswa terlalu dekat dengan kamera. Pastikan posisi fokus kamera mengarah ke titik 3–5 meter di depan lensa agar sudut pitch tidak melebihi `30°`.
2. **Konektivitas Jaringan RTSP**:
   Dengan 8 stream 1080p simultan, pastikan switch jaringan PoE kamera menggunakan switch Gigabit non-blocking untuk mencegah frame corruption pada socket TCP/UDP.
3. **Sesi WhatsApp Baileys**:
   Data sesi tersimpan di volume `./storage/wa_gateway/baileys_auth`. Volume ini wajib di-backup secara berkala dan dipertahankan saat rebuild image agar tidak perlu scan QR ulang.
