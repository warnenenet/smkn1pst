# Absensi SMK Face AI — Panduan Lengkap & Dokumentasi Teknis

Sistem manajemen absensi sekolah berbasis **pengenalan wajah AI otomatis melalui kamera CCTV RTSP** yang dirancang khusus untuk skala produksi hingga **5.000+ siswa**, multi-gerbang, multi-kamera, dengan batas penyimpanan ketat **maksimal 10 GB**, panggilan suara kiosk otomatis Bahasa Indonesia, notifikasi WhatsApp anti-blokir, serta portal cek absensi untuk orang tua.

Dokumentasi ini disusun dalam **dua bagian utama** agar mudah dipahami siapa saja:
1. **Penjelasan Sederhana & Alur Kerja Sistem** — bagaimana aplikasi bekerja dari kamera menyala hingga pesan WhatsApp terkirim ke orang tua.
2. **Panduan Teknis Lengkap, Instalasi, Keamanan & Operasional** — arsitektur, aturan AI/storage/absensi, setup ala WordPress, deployment banyak sekolah dalam 1 VPS, auto-update GitHub, hingga pemecahan masalah.

---

## Daftar Isi

1. [Gambaran Sederhana: Bagaimana Aplikasi Ini Bekerja?](#1-gambaran-sederhana-bagaimana-aplikasi-ini-bekerja)
2. [Alur Kerja End-to-End (CCTV → AI → Absensi → Kiosk & WA)](#2-alur-kerja-end-to-end-cctv--ai--absensi--kiosk--wa)
3. [Fitur Lengkap & Pembagian Hak Akses (Role)](#3-fitur-lengkap--pembagian-hak-akses-role)
4. [Pengetahuan Mendalam Setiap Subsistem](#4-pengetahuan-mendalam-setiap-subsistem)
   - [4.1 Dua Mesin AI Wajah (Python InsightFace + Node.js WASM) & Akselerasi Rust](#41-dua-mesin-ai-wajah-python-insightface--nodejs-wasm--akselerasi-rust)
   - [4.2 Mesin Absensi, Gate, Deduplikasi, Observasi & Cutoff WIB Otomatis](#42-mesin-absensi-gate-deduplikasi-observasi--cutoff-wib-otomatis)
   - [4.3 Deteksi Wajah Anonim (Maks 5 Foto Terbaik, Zoom Crosscheck & Koreksi)](#43-deteksi-wajah-anonim-maks-5-foto-terbaik-zoom-crosscheck--koreksi)
   - [4.4 Pemeliharaan Kualitas Wajah Otomatis & Review Bulanan BK](#44-pemeliharaan-kualitas-wajah-otomatis--review-bulanan-bk)
   - [4.5 Manajemen Storage Ketat Maksimal 10 GB (Anti-Penumpukan Data)](#45-manajemen-storage-ketat-maksimal-10-gb-anti-penumpukan-data)
   - [4.6 WhatsApp Gateway Anti-Blokir (Baileys QR / Meta / Fonnte / WABLAS)](#46-whatsapp-gateway-anti-blokir-baileys-qr--meta--fonnte--wablas)
   - [4.7 Kiosk Panggil Suara Offline (`/panggil/:cameraId`) & Portal Orang Tua (`/ortu`)](#47-kiosk-panggil-suara-offline-panggilcameraid--portal-orang-tua-ortu)
5. [Arsitektur Teknis & Struktur Database (24 Tabel SQLite)](#5-arsitektur-teknis--struktur-database-24-tabel-sqlite)
6. [Instalasi & Menjalankan Secara Lokal (Development)](#6-instalasi--menjalankan-secara-lokal-development)
7. [Deploy Produksi di VPS / aaPanel / PM2 (Anti-Error 404 & EACCES)](#7-deploy-produksi-di-vps--aapanel--pm2-anti-error-404--eacces)
8. [Deploy Banyak Sekolah / Banyak Domain di 1 VPS (Multi-Tenant Terisolasi)](#8-deploy-banyak-sekolah--banyak-domain-di-1-vps-multi-tenant-terisolasi)
9. [Deploy via Docker & Docker Hub (All-in-One Image)](#9-deploy-via-docker--docker-hub-all-in-one-image)
10. [Setup Awal ala WordPress & Keamanan Produksi](#10-setup-awal-ala-wordpress--keamanan-produksi)
11. [Auto-Update Otomatis dari GitHub (1 Jam Sekali & Universal)](#11-auto-update-otomatis-dari-github-1-jam-sekali--universal)
12. [Referensi Environment Variables (`.env`) & Endpoint Penting](#12-referensi-environment-variables-env--endpoint-penting)
13. [Panduan Operasional Harian Sekolah & Troubleshooting](#13-panduan-operasional-harian-sekolah--troubleshooting)

---

## 1. Gambaran Sederhana: Bagaimana Aplikasi Ini Bekerja?

Bayangkan gerbang sekolah memiliki beberapa kamera CCTV (RTSP):

1. **Siswa berjalan melewati gerbang sekolah** — tanpa perlu berhenti, tanpa antre kartu RFID, dan tanpa menempelkan sidik jari.
2. **Kamera RTSP mengirim video live ke server** (default diproses pada ~5 FPS dengan filter deteksi gerakan agar CPU hemat).
3. **AI mendeteksi wajah**, menyaring foto blur/terlalu kecil, lalu mencocokkan vektor wajah siswa dengan database sekolah dalam hitungan milidetik:
   - **Jika cocok dengan siswa terdaftar:**
     - Status masuk tercatat (`HADIR` atau `TERLAMBAT` sesuai jam kelas/jurusan).
     - Layar Kiosk di gerbang (`/panggil/:cameraId`) langsung menampilkan foto + nama siswa dan **memanggil nama siswa dengan suara Bahasa Indonesia** (*"Selamat pagi, Ahmad Fauzan"*).
     - Notifikasi WhatsApp untuk orang tua dijadwalkan dengan jeda aman anti-ban.
   - **Jika wajah tidak dikenal (belum ada foto siswa / tamu):**
     - Wajah dikelompokkan sebagai **Wajah Anonim** dan sistem menyimpan **maksimal 5 foto terbaik** (berdasarkan ketajaman, ukuran wajah, dan pose hadap depan).
     - Guru BK dapat klik foto untuk **memperbesar & zoom (`1x / 2x / 3x`)**, menghapus foto yang salah (misalnya foto topi saja atau wajah siswa lain masuk), lalu memberi nama siswa tersebut agar keesokan harinya langsung dikenali otomatis.
4. **Jika tidak terpasang Python AI terpisah**, server Node.js sudah membawa **mesin AI bawaan (`@vladmandic/human` WASM)** dan **FFmpeg bawaan**, sehingga instalasi tetap berjalan di VPS Node.js standar maupun di Docker All-in-One.
5. **Semua file & database dijaga ketat di bawah 10 GB** secara otomatis — tidak ada penumpukan log atau foto sampah yang memenuhi hardisk server.

---

## 2. Alur Kerja End-to-End (CCTV → AI → Absensi → Kiosk & WA)

```text
+--------------------+       RTSP (TCP, 5 FPS / Native)
| Kamera CCTV Gerbang| -------------------------------------+
+--------------------+                                      |
                                                            v
+-----------------------------------------------------------------------+
|                       WORKER DETEKSI WAJAH                            |
|  1) Mode Lengkap (Docker / VPS Python):                               |
|     services/face-service (InsightFace buffalo_l 512-D + IoU Tracker  |
|     + Rust face_accel 1:N Cosine Similarity)                          |
|  2) Mode Node.js Bawaan (Zero-Python Fallback):                       |
|     nodeFaceWorker.ts (FFmpeg + @vladmandic/human WASM 1024-D)        |
+-----------------------------------------------------------------------+
          |
          |  Filter Kualitas: conf >= 0.80, size >= 60px, quality >= 0.70
          |  POST /api/internal/face-event (loopback / X-Internal-Token)
          v
+-----------------------------------------------------------------------+
|                    MESIN ABSENSI (server.ts)                          |
|  * Cek jadwal efektif (Exception -> Override Kelas -> Jadwal Jurusan) |
|  * Cek Gate (MASUK / KELUAR / BOTH) & Deduplikasi agar tidak spam     |
|  * Simpan foto crop <= 360px JPEG (OBSERVASI langsung dihapus dari disk)|
|  * Jika wajah cocok & kualitas > lama -> Auto-blend & review bulanan  |
|  * Jika wajah tak cocok -> Cluster Anonim (maks 5 hit kualitas tinggi)|
+-----------------------------------------------------------------------+
      |                          |                           |
      v                          v                           v
+-----------+          +-------------------+       +-------------------+
| SQLite DB |          | WebSocket /ws     |       | Antrean WhatsApp  |
| (WAL Mode)|          | Kiosk /panggil/id |       | Baileys / API     |
| <= 10 GB  |          | + Piper TTS Audio |       | + Cutoff WIB 60s  |
+-----------+          +-------------------+       +-------------------+
```

---

## 3. Fitur Lengkap & Pembagian Hak Akses (Role)

### Rute Halaman Web
| URL | Akses | Fungsi |
|---|---|---|
| `/` | Setup / Dashboard / Portal Ortu | Otomatis menampilkan **Setup Wizard** saat baru di-install (`needs_setup=true`), **Dashboard Staf** jika sudah login, atau **Portal Orang Tua** jika belum login. |
| `/login` | Publik (dengan rate limit) | Halaman login khusus **Admin, Guru BK, dan Guru**. |
| `/setup` | Sekali pakai saat instalasi | Setup Admin pertama ala WordPress; otomatis terkunci permanen (`HTTP 409`) begitu 1 Admin aktif dibuat. |
| `/ortu` atau `/guest` | Publik (CAPTCHA + rate limit) | Orang tua / siswa cek rekap absensi bulanan dengan **NISN + Tanggal Lahir**. |
| `/panggil/:cameraId` | Publik (Kiosk Layar Gerbang) | Tampilan layar monitor gerbang per kamera: live nama siswa masuk/keluar, tingkat kemiripan, & panggilan suara otomatis. |

### Hak Akses Staf (`ADMIN`, `BK`, `GURU`)
| Menu / Tab | ADMIN | BK | GURU | Fungsi Utama |
|---|---|---|---|---|
| **Dashboard Utama** | Ya | Ya | Ya | Ringkasan absensi hari ini, statistik keterlambatan, status worker AI/RTSP, migrasi dimensi AI, & monitor kuota **Storage 10 GB**. |
| **Absensi Harian & Koreksi** | Ya | Ya | Baca | Tabel kehadiran per tanggal/jurusan/kelas, **Autocomplete cari siswa** (5.000+ siswa cepat), input cepat **SAKIT / IZIN**, override status, serta zoom foto bukti hit kamera. |
| **Laporan & Export** | Ya | Ya | Ya | Rekap bulanan/harian per kelas atau siswa dan export **CSV** / cetak laporan. |
| **Siswa, Jurusan & Excel** | Ya | Ya | — | Kelola jurusan, kelas, data siswa, **Import Excel** (mendukung kenaikan kelas, pindah kelas, tinggal kelas, & kelulusan otomatis), enroll foto tunggal/batch, dan uji banding 2 foto. |
| **Penamaan Wajah Anonim** | Ya | Ya | — | Daftar klaster wajah tak dikenal (maks 5 foto terbaik), zoom crosscheck **`1x / 2x / 3x`**, jadikan foto acuan, hapus foto salah (reset ke `PENDING`), assign ke siswa / siswa baru / tamu. |
| **Face Update Review (BK)** | Ya | Ya | — | Review bulanan peningkatan kualitas foto wajah siswa otomatis (Approve / Rollback versi embedding sebelumnya). |
| **Gerbang & Kamera RTSP** | Ya | — | — | Kelola gerbang (`MASUK` / `KELUAR` / `BOTH`), tambah kamera RTSP, **Uji Probe & Preview Live MJPEG (`5 FPS` atau `Native RTSP`)**, atur resolusi capture (`720p` / `1080p` / `Native`). |
| **Jadwal, Override & Libur** | Ya | Ya | — | Jadwal Senin–Sabtu (global atau per jurusan), override jam per kelas, dan pengecualian tanggal (`LIBUR`, `PULANG_CEPAT`, `EKSKUL`, `SHIFT_SWAP`). |
| **WhatsApp Gateway** | Ya | Ya | — | Tambah akun pengirim, **Pairing QR Code Baileys** langsung di web, mode **WARMUP (20/hari)** vs **ACTIVE (800/hari)**, edit 10 template pesan, pantau & kirim ulang antrean. |
| **Pengaturan & User** | Ya | — | — | Threshold AI, bobot skor kualitas, suara Kiosk (`AUTO_ADAPTIVE` / `FULL_NAME` / `CHIME_ONLY`), mode Produksi, user staf, pembersihan storage manual, & **Backup/Restore `.sqlite.gz`**. |

---

## 4. Pengetahuan Mendalam Setiap Subsistem

### 4.1 Dua Mesin AI Wajah (Python InsightFace + Node.js WASM) & Akselerasi Rust

Aplikasi memiliki arsitektur AI **Dual-Engine dengan Auto-Failover**:

1. **Engine Utama (Rekomendasi 5.000+ Siswa & 4+ Kamera): Python `services/face-service/` (Port `8001` internal)**
   - Model: **InsightFace `buffalo_l`** (vektor wajah **512-dimensi**), deteksi wajah `det_size=(640, 640)`, **anti-spoofing dinonaktifkan** agar siswa yang berjalan cepat di depan CCTV gerbang tidak gagal absen karena pencahayaan luar ruangan.
   - **IoU Tracker (`tracker.py`)**: Melacak pergerakan wajah antar frame sehingga wajah yang sama tidak dikirim berulang-ulang setiap frame.
   - **Rust Acceleration (`services/rust-accel/` → `/app/bin/face_accel`)**: Melakukan perkalian *Cosine Similarity 1:N* terhadap 5.000+ vektor siswa secara native (jika binary tidak tersedia, otomatis fallback ke NumPy).
   - **Auto-Sync & Auto-Heal**: Node.js memeriksa kesehatan `FACE_SERVICE_URL` setiap 60 detik (`executeAutoAiHealTick`), otomatis menyinkronkan galeri embedding dan pengaturan kamera saat Python aktif atau baru menyala kembali.

2. **Engine Bawaan Node.js (Zero-Python Default): `src/server/nodeFaceWorker.ts`**
   - Berjalan **langsung di dalam Node.js** menggunakan `@vladmandic/human` + `@tensorflow/tfjs-backend-wasm` (vektor wajah **1024-dimensi**) dan FFmpeg (`@ffmpeg-installer/ffmpeg` atau `/usr/bin/ffmpeg`).
   - **Koordinasi Cerdas**: Jika layanan Python `face-service` sedang online, worker RTSP di Node.js **otomatis berhenti sementara** agar kamera tidak ditarik dua kali (*double-stream*). Jika layanan Python mati atau tidak terpasang (misalnya pada instalasi aaPanel Node.js murni), worker Node.js **otomatis aktif**.
   - Dilengkapi **Motion Gate**: Membandingkan delta kecerahan frame berturut-turut sehingga frame yang statis/kosong tidak membebani CPU inferensi AI.

3. **Keamanan Perbedaan Dimensi Embedding (`512-D` vs `1024-D` vs `16-D`)**
   - Server dan worker **tidak pernah** mencocokkan vektor beda dimensi secara paksa.
   - Jika Anda berpindah dari mode Node.js (1024-D) ke Docker Python InsightFace (512-D) atau sebaliknya, Dashboard otomatis menampilkan jumlah foto yang belum cocok dimensinya beserta tombol **1-Klik Migrasi Embedding (`POST /api/system/migrate-embeddings`)** yang mengekstrak ulang embedding dari foto profil lokal siswa tanpa menghapus data absensi.

**Parameter Default Kualitas & Ambang Batas AI:**
- `threshold_confidence`: **`0.80`** (minimum keyakinan deteksi wajah dari kamera)
- `threshold_recognition`: **`0.70`** (minimum kemiripan *cosine similarity* untuk dianggap cocok dengan siswa)
- `threshold_clustering`: **`0.70`** (minimum kemiripan untuk masuk klaster wajah anonim yang sama)
- `min_face_size`: **`60 px`** (wajah lebih kecil dari 60px diabaikan; bisa diatur per kamera)
- `min_snapshot_quality`: **`0.70`** (lantai minimal dikunci server `>= 0.70` agar foto buram/gelap tidak pernah merusak database atau klaster)
- **Rumus Skor Kualitas Wajah (`0.0 – 1.0`)**:
  `0.30 × Confidence + 0.25 × Ukuran Wajah + 0.25 × Ketajaman (Laplacian) + 0.20 × Pose Hadap Depan (Yaw/Pitch)`

---

### 4.2 Mesin Absensi, Gate, Deduplikasi, Observasi & Cutoff WIB Otomatis

1. **Prioritas Jadwal Efektif (Setiap Hari, Zona Waktu `Asia/Jakarta` / WIB):**
   - Prioritas 1: **Schedule Exception** (tanggal tertentu: `LIBUR`, `PULANG_CEPAT`, `EKSKUL`, `SHIFT_SWAP` — global atau per jurusan).
   - Prioritas 2: **Override Kelas** (jadwal khusus per kelas pada hari 1–7, misal kelas XII masuk lebih awal atau shift siang).
   - Prioritas 3: **Jadwal Jurusan / Jadwal Global** (Senin–Sabtu).
   - Status siswa **`PKL`**, **`LULUS`**, **`CUTI`**, **`IZIN_PANJANG`** tidak pernah ditandai `ALPA` oleh sistem.

2. **Tipe Gerbang (`MASUK`, `KELUAR`, `BOTH`) & Deduplikasi Anti-Spam:**
   - **Gerbang `MASUK`**: Di jam kedatangan mencatat `jam_masuk` + status `HADIR` atau `TERLAMBAT` (jika melewati `jam_masuk_selesai + toleransi_terlambat_menit`). Setelah masuk, deteksi ulang di gerbang masuk dalam jendela deduplikasi hanya dicatat sebagai **`OBSERVASI`** (tanpa spam WA/Kiosk dan **foto scan langsung dihapus** dari disk).
   - **Gerbang `KELUAR`**: Mencatat `jam_keluar` hanya jika sudah masuk jam pulang (atau sesuai override/pulang cepat) dan melakukan update `daily_attendance`.
   - **Gerbang `BOTH` (Gerbang Tunggal Pagi & Sore)**: Sebelum tengah/awal jam keluar berlaku sebagai `MASUK`, setelah memasuki jendela `jam_keluar_mulai` otomatis berfungsi sebagai `KELUAR`.

3. **Otomasi Harian Latar Belakang (`executeDailyTick` setiap 60 detik):**
   - **Auto-Alpa**: 1 jam setelah `jam_masuk_selesai`, siswa `AKTIF` yang belum punya catatan masuk atau `IZIN`/`SAKIT` otomatis ditandai **`ALPA`** (kecuali hari `LIBUR`) dan masuk antrean WA orang tua.
   - **Auto Tidak Keluar**: Setelah melewati `cutoff_keluar` (default **`18:00:00` WIB**), siswa yang statusnya masih `HADIR`/`TERLAMBAT` tanpa `jam_keluar` otomatis ditandai **`TIDAK_KELUAR`**.
   - **Auto Antrean WA Pulang**: Menjadwalkan pesan rekap pulang ke orang tua setelah jeda `wa_delay_after_pulang_menit` (default **`60` menit**).

---

### 4.3 Deteksi Wajah Anonim (Maks 5 Foto Terbaik, Zoom Crosscheck & Koreksi)

Saat kamera menangkap wajah berulang dengan kualitas baik (`>= 0.70`) yang belum cocok dengan siswa mana pun:

1. **Maksimal 5 Foto Terbaik per Klaster (`CLUSTER_MAX_HITS = 5`):**
   - Klaster hanya menyimpan hingga **5 foto terbaik** sebagai acuan training/verifikasi.
   - Jika datang deteksi ke-6 dan seterusnya: sistem membandingkan `quality_score` foto baru terhadap foto non-acuan yang paling rendah kualitasnya.
     - Jika foto baru lebih bagus: foto lama terlemah **diganti dan file JPEG-nya langsung dihapus dari disk**.
     - Jika foto baru lebih buruk: file sementara dibuang agar **tidak terjadi penumpukan foto anonim**.
   - Klaster berstatus **`PENDING`** sampai mencapai syarat minimal (`cluster_ready_hits = 5`, `cluster_ready_days = 1`), lalu naik ke status **`READY`** agar diprioritaskan untuk ditinjau Guru BK.

2. **Tampilan Penamaan Anonim yang Sederhana & Akurat:**
   - Setiap kartu klaster menampilkan maksimal **5 thumbnail foto train**, skor kualitas, jumlah kemunculan, dan tombol aksi yang jelas:
     - **Klik Foto / Tombol Perbesar**: Membuka *Lightbox Crosscheck* dengan **Zoom `1x / 2x / 3x`** yang bisa di-scroll penuh tanpa terpotong di tepi layar.
     - **Jadikan Acuan (`Acuan`)**: Memilih foto paling jelas menghadap depan sebagai foto referensi utama siswa.
     - **Hapus Foto (`Hapus`)**: Menghapus foto yang tidak sesuai — misalnya **tertangkap bagian topi saja, wajah buram, atau wajah siswa lain yang kebetulan mirip**.
   - **Aturan Otomatis Saat Foto Dihapus:**
     - File JPEG tersebut langsung dihapus dari server.
     - Centroid klaster dihitung ulang (*recompute centroid*) hanya dari foto-foto bersih yang tersisa.
     - Status klaster otomatis kembali ke **`PENDING`** sehingga kamera dapat melanjutkan *training* mengambil foto bersih tambahan hingga mencapai 5 foto terbaik.

3. **Tindak Lanjut Penamaan:**
   - **Pasangkan ke Siswa Existing** (menggabungkan centroid ke profil siswa jika siswa sebelumnya belum punya foto bagus).
   - **Buat Siswa Baru** (langsung mendaftarkan siswa baru lengkap dengan foto & embedding terbaik).
   - **Tandai sebagai Tamu (`VISITOR`)** (misalnya kurir, orang tua, atau teknisi yang sering lewat gerbang agar tidak muncul terus sebagai anonim baru).
   - **Hapus Klaster** (jika benar-benar noise/tidak dibutuhkan).

---

### 4.4 Pemeliharaan Kualitas Wajah Otomatis & Review Bulanan BK

Agar akurasi tetap tinggi seiring perubahan gaya rambut, kacamata, atau pertumbuhan wajah siswa:
- Ketika seorang siswa dikenali dengan skor keyakinan tinggi dan `quality_score` foto baru **lebih baik** dari `embedding_quality_score` miliknya (menuju target `face_maintenance_target = 0.80`), sistem:
  1. Memperbarui vektor wajah secara halus (*weighted blend*) dan menyimpan maksimal **3 versi riwayat terbaru** di `face_update_history`.
  2. Mencatat kandidat di **Face Update Review (Guru BK)** agar pihak sekolah dapat meng-**Approve** atau **Rollback** ke foto/embedding versi sebelumnya kapan saja.

---

### 4.5 Manajemen Storage Ketat Maksimal 10 GB (Anti-Penumpukan Data)

Sistem dirancang untuk sekolah berkapasitas **5.000+ siswa** agar **total seluruh folder `data/` tidak pernah melewati 10 GB**, bahkan setelah berjalan bertahun-tahun:

| Komponen Data | Batas / Aturan Ketat | Mekanisme Otomatis |
|---|---|---|
| **Batas Total Hardisk (`data/`)** | **Hard Cap `10.0 GB`** | Target aman **`8.0 GB`**. Jika menyentuh **`9.0 GB`**, *Emergency Trim* otomatis memangkas data sekunder tertua hingga turun kembali ke `<= 8.0 GB`. |
| **Semua Foto Profil & Crop Kamera** | Maks sisi **`360 px`**, JPEG quality **`<= 82`** (~10–25 KB/file) | Tidak pernah menyimpan Base64 (`data:image/*`) mentah ke SQLite; upload Base64 otomatis dikompresi & disimpan ke `data/snapshots/`. |
| **Folder `data/snapshots/`** | Kuota maks **`4.5 GB`** | Foto profil utama (`students.foto_ref`, `best_snapshot_path`) selalu **dilindungi**. File yatim (*orphan*) & foto scan lama dipangkas otomatis. |
| **Snapshot Log Scan `OBSERVASI`** | **`0 hari` (langsung dihapus)** | Jika bukan untuk perbaikan foto wajah, foto `OBSERVASI` langsung dihapus saat itu juga agar tidak menumpuk. |
| **Snapshot Log Scan `MASUK` / `KELUAR`** | **`3 hari`** atau maks **`1.500`** file terbaru | Foto lama dihapus dari disk sambil mempertahankan teks log jam masuk/keluarnya di database. |
| **Klaster Anonim** | Maks **`5` hit/klaster**, maks **`1.500`** klaster aktif | Embedding di JSON dibulatkan **4 desimal**. Klaster `PENDING` 1–2 hit tak aktif **> 14 hari** otomatis dibersihkan. Klaster `NAMED`/`ARCHIVED` disisakan 1 foto. |
| **Riwayat Review / Tamu / Log** | Review selesai **`60 hari`** (maks 500); Tamu **`365 hari`** (maks 2.000); Rekap harian **`730 hari`** (2 tahun) | Log detail scan maks `5.000` baris / 30 hari; antrean WA `3.000` baris / 30 hari; log akses guest `2.000` baris / 30 hari. |
| **Cache Suara (`data/tts_cache/`)** | Maks **`120 MB`** | Pembersihan LRU (*Least Recently Used*) otomatis saat kuota cache tercapai. |
| **Backup (`data/backups/`)** | Maks **`200 MB`** | Disimpan terkompresi `.sqlite.gz` (default `backup_retention_count = 2` file terbaru). |
| **File Log (`.log`) & SQLite WAL** | **`1 MB` per file log** (`5 MB` total); WAL maks **`8 MB`** | Log dipangkas (*tail-truncate*) otomatis saat startup & setiap jam. `PRAGMA wal_checkpoint(TRUNCATE)` dan auto-`VACUUM` menjaga ukuran `.sqlite` tetap ramping. |

> Admin dapat memantau pemakaian ruang per kategori (*Database SQLite, Snapshots, TTS Cache, Backups, WA Auth, Logs*) langsung dari **Dashboard → Panel Storage** atau menjalankan pembersihan manual di **Pengaturan**.

---

### 4.6 WhatsApp Gateway Anti-Blokir (Baileys QR / Meta / Fonnte / WABLAS)

- **Multi-Akun & Multi-Provider**:
  - **`BAILEYS` (Bawaan Gratis)**: Scan QR langsung di halaman WhatsApp Gateway; sesi terisolasi di `data/wa_auth/acc_<id>`. Logger internal dibuat senyap agar tidak membanjiri log disk.
  - **`META_CLOUD`**, **`FONNTE`**, **`WABLAS`**: Dapat diaktifkan jika sekolah memakai API WhatsApp resmi atau pihak ketiga.
- **Proteksi Anti-Ban Bawaan**:
  - Mode **`WARMUP`**: Batas ketat **20 pesan/hari** (cocok untuk nomor baru selama 1–2 minggu awal).
  - Mode **`ACTIVE`**: Batas **800 pesan/hari** (reset otomatis per tanggal WIB).
  - Jeda pengiriman acak antar pesan (default `60–120 detik`, dapat disesuaikan di Pengaturan) dengan antrean `wa_queue` yang mendukung retry manual maupun otomatis.
- **10 Template Pesan Siap Pakai (`TPL_1` – `TPL_10`)**: Mencakup pesan `TERLAMBAT`, `ALPA`, `TIDAK_KELUAR`, konfirmasi `SAKIT`/`IZIN`, hingga rekap pulang sore dengan variabel dinamis (`{nama}`, `{kelas}`, `{jam}`, `{tanggal}`, `{status}`).

---

### 4.7 Kiosk Panggil Suara Offline (`/panggil/:cameraId`) & Portal Orang Tua (`/ortu`)

- **Kiosk `/panggil/:cameraId`**:
  - Terhubung via **WebSocket (`/ws`)** secara real-time saat siswa melewati gerbang kamera terkait.
  - Mode suara dapat dipilih di Pengaturan: `FULL_NAME` (panggil nama lengkap), `AUTO_ADAPTIVE` (adaptif saat gerbang padat), atau `CHIME_ONLY`.
  - **Piper TTS Offline (`id_ID-news_tts-medium.onnx`)**: Menghasilkan audio WAV Bahasa Indonesia jernih lewat `/api/tts` dan di-cache di `data/tts_cache/` (maks 120 MB). Jika binary Piper tidak tersedia di VPS Node.js biasa, browser Kiosk otomatis beralih menggunakan **Web Speech API (`id-ID`)** bawaan browser.
- **Portal Orang Tua (`/ortu` atau `/guest`)**:
  - Orang tua/siswa memasukkan **NISN**, **Tanggal Lahir**, memilih **Bulan**, dan menjawab **Captcha Matematika sederhana** (`POST /api/guest/lookup`).
  - Dibatasi **10 permintaan/jam per IP** untuk melindungi privasi data siswa dan setiap akses dicatat di `guest_access_logs`.

---

## 5. Arsitektur Teknis & Struktur Database (24 Tabel SQLite)

### Stack Teknologi
- **Backend & Server**: Node.js `>= 22.18` (disarankan **Node.js 22 LTS / 24 LTS**), Express 4, WebSocket (`ws`), `node:sqlite` (`DatabaseSync` bawaan Node — **tanpa perlu kompilasi C++ `better-sqlite3`**).
- **Frontend**: React 19, TypeScript, Vite 8, Tailwind CSS v4, Lucide Icons, `xlsx` (import Excel), `qrcode`.
- **AI & Media**:
  - Mode Python + Rust: FastAPI, OpenCV, InsightFace `buffalo_l`, ONNX Runtime CPU, binary Rust `face_accel`.
  - Mode Node Bawaan: `@vladmandic/human`, `@tensorflow/tfjs-backend-wasm`, `@ffmpeg-installer/ffmpeg`, `jpeg-js`.

### Struktur Direktori Penting
```text
/
├── server.ts                  # Server utama Express + WebSocket + API + Worker manager + Daily ticks
├── src/
│   ├── App.tsx                # Router halaman (/, /login, /setup, /ortu, /panggil/:id) & state UI
│   ├── components/            # Seluruh tampilan modul + StudentAutocomplete + FaceLightboxModal
│   ├── lib/                   # Logika murni teruji unit test (attendanceEngine, storageBudget, security, dll)
│   └── server/                # store.ts (SQLite 24 tabel), nodeFaceWorker.ts, waGateway.ts, ttsService.ts, autoUpdater.ts
├── services/
│   ├── face-service/          # Layanan Python InsightFace buffalo_l + IoU tracker (port 8001 internal)
│   └── rust-accel/            # Engine Rust 1:N Cosine Similarity berkecepatan tinggi
├── scripts/
│   ├── setup-school.sh        # Installer otomatis per sekolah (port unik, .env, build, chmod, Nginx)
│   └── auto-update.sh         # Script auto-update GitHub universal (cron/aaPanel/PM2/systemd/Docker)
└── data/                      # Data persisten terisolasi (DIJAGA <= 10 GB, di-ignore Git)
    ├── absensi.sqlite         # Database utama SQLite (WAL mode)
    ├── snapshots/             # Crop wajah <= 360px & foto siswa
    ├── wa_auth/               # Sesi login multi-device WhatsApp Baileys
    ├── tts_cache/             # Cache suara WAV Piper (maks 120 MB)
    ├── backups/               # File backup otomatis/manual .sqlite.gz (maks 200 MB)
    └── auto-update.log        # Log auto-update (maks 1 MB)
```

### 24 Tabel SQLite (`data/absensi.sqlite`)
1. `app_state` — Metadata inti & penanda migrasi/snapshot cleanup
2. `storage_events` — Jejak audit pembersihan & trim storage 10 GB
3. `auth_sessions` — Token sesi login server-side staf + masa berlaku
4. `users` — Akun `ADMIN`, `BK`, `GURU` (password di-hash `scrypt` per-user salt)
5. `jurusans` — Master jurusan SMK (`kode`, `nama`)
6. `kelas` — Master kelas (`jurusan_id`, `tingkat`, `nama`, `shift`)
7. `students` — Profil siswa, NIS/NISN, status (`AKTIF`/`PKL`/`LULUS`/`CUTI`), nomor WA ortu, embedding & skor kualitas
8. `gates` — Gerbang sekolah (`MASUK`, `KELUAR`, `BOTH`)
9. `cameras` — Konfigurasi kamera RTSP, FPS, resolusi, `min_face_size`, status & `last_error`
10. `schedules` — Jadwal masuk/keluar mingguan (global & per jurusan)
11. `kelas_overrides` — Jadwal khusus per kelas pada hari tertentu
12. `schedule_exceptions` — Pengecualian tanggal (`LIBUR`, `PULANG_CEPAT`, `EKSKUL`, `SHIFT_SWAP`)
13. `attendance_logs` — Log mentah deteksi (`MASUK`, `KELUAR`, `OBSERVASI`, skor kemiripan, path foto)
14. `daily_attendance` — Rekap final kehadiran harian per siswa per tanggal
15. `anonymous_clusters` — Klaster wajah tak dikenal + centroid + maksimal 5 hit terbaik JSON
16. `visitors` — Daftar tamu teridentifikasi agar tidak berulang masuk klaster anonim
17. `face_update_history` — Maks 3 versi terakhir embedding setiap siswa (untuk rollback aman)
18. `face_update_reviews` — Antrean review peningkatan kualitas wajah bulanan untuk Guru BK
19. `wa_queue` — Antrean pesan WhatsApp keluar (`PENDING`, `SENT`, `FAILED`, `PAUSED`)
20. `wa_accounts` — Daftar akun/provider pengirim WA beserta status `WARMUP`/`ACTIVE` & kuota harian
21. `wa_templates` — 10 template pesan notifikasi WhatsApp
22. `notifications` — Notifikasi internal dashboard Admin/BK
23. `guest_access_logs` — Audit akses portal orang tua (`/ortu`)
24. `settings` — Seluruh konfigurasi AI, kamera, WhatsApp, kiosk, dan mode produksi

---

## 6. Instalasi & Menjalankan Secara Lokal (Development)

**Prasyarat:** Node.js `>= 22.18` (disarankan v22 LTS atau v24 LTS).

```bash
npm install
npm run dev
```

Buka di browser: **`http://localhost:3000`**

### Menjalankan Unit Test, Typecheck, & Build
```bash
npm run lint
npx --yes tsx --test src/lib/*.test.ts
npm run build
```

---

## 7. Deploy Produksi di VPS / aaPanel / PM2 (Anti-Error 404 & EACCES)

> **PERINGATAN PENTING:** Jangan pernah menjalankan server produksi dengan mode `dev` (`tsx server.ts`) dan jangan mengarahkan web root Nginx langsung ke folder utama repo (`/`) karena `index.html` sumber memanggil `/src/main.tsx` yang akan menghasilkan error **404 / MIME `application/octet-stream`** di browser. Selalu jalankan `npm run build` lalu start dengan **`npm start`** (`node server.ts`).

### Langkah 1: Persiapan VPS Sekali Saja (Membutuhkan `root` / `sudo`)
Install paket sistem pendukung (termasuk `/usr/bin/ffmpeg` sebagai cadangan apabila partisi server memblokir binary executable di `node_modules`):
```bash
apt update && apt install -y ffmpeg git curl sqlite3
```
*(Di aaPanel, install juga **Node.js v22 LTS atau v24 LTS** melalui **App Store → Node.js Version Manager**.)*

### Langkah 2: Install & Setup Project di Folder Sekolah
Masuk ke folder project (contoh `/www/wwwroot/smkn1pst`), lalu jalankan:
```bash
cd /www/wwwroot/smkn1pst

# Jika awalnya upload dari ZIP, bersihkan node_modules lama agar binary cocok dengan arsitektur VPS
rm -rf node_modules
npm install --no-audit --no-fund

# Jalankan script setup terisolasi:
# - Memilih port kosong otomatis (3001, 3002, ...)
# - Membuat .env dengan SESSION_SECRET & INTERNAL_API_TOKEN acak unik
# - Mem-build dist/ produksi
# - Memperbaiki izin chmod +x binary FFmpeg/esbuild & cek SQLite
# - Mengatur kepemilikan folder untuk user www (jika aaPanel)
npm run setup:school -- --domain absensi.smkpercut.store
```

### Langkah 3: Jalankan Aplikasi (User `www` — Tidak Perlu `root`)
- **Melalui aaPanel → Website → Node project → Add Node project**:
  - **Project dir**: `/www/wwwroot/smkn1pst`
  - **Run opt**: **`start`** *(wajib `start`, bukan `dev`!)*
  - **Port**: masukkan nomor port dari hasil `setup:school` / isi file `.env` (contoh `3001`)
  - **User**: `www`
  - Isi domain sekolah, aktifkan **Mapping**, lalu pasang **SSL Let's Encrypt**.
- **Atau melalui PM2**:
  ```bash
  pm2 start npm --name "absensi-smkn1pst" -- start
  pm2 save
  ```

### Langkah 4: Konfigurasi Nginx Reverse Proxy
Di **aaPanel → Website → Site Settings → Config**, **hapus atau komentari** blok cache statis bawaan seperti:
```nginx
# location ~ .*\.(js|css)?$ { ... }
```
agar seluruh file `/assets/*.js`, `/assets/*.css`, file `.wasm`, dan koneksi **WebSocket `/ws`** diteruskan sempurna ke aplikasi Node:

```nginx
server {
  listen 80;
  server_name absensi.smkpercut.store;

  location / {
    proxy_pass http://127.0.0.1:3001; # Sesuaikan dengan PORT di .env sekolah
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
  }
}
```

### Langkah 5: Verifikasi Kesehatan Server
```bash
curl -s http://127.0.0.1:3001/api/health
```
Pastikan respons JSON menampilkan `"ok":true` dan `"ffmpeg_ready":true`.

### Matriks Operasi: Mana yang Membutuhkan `root` vs Cukup `www`?
| Aktivitas | Butuh `root`? | Penjelasan |
|---|---|---|
| Menjalankan web server (`npm start` di port `3001+`) | **Tidak (`www`)** | Node berjalan di atas port `1024` di belakang Nginx. |
| SQLite, Snapshots, WhatsApp Baileys, AI WASM | **Tidak (`www`)** | Cukup folder project dimiliki oleh `www:www`. |
| FFmpeg RTSP kamera (`@ffmpeg-installer` / `/usr/bin/ffmpeg`) | **Tidak (`www`)** | Butuh permission `+x` atau otomatis memakai `/usr/bin/ffmpeg`. |
| Install paket sistem (`apt install ffmpeg git sqlite3`) | **Ya (`root`/`sudo`)** | Hanya 1 kali saat menyiapkan VPS baru. |
| Memperbaiki owner folder (`chown -R www:www`) setelah upload root | **Ya (`root`/`sudo`)** | Hanya jika `npm install` awalnya dijalankan sebagai `root`. |
| Mengikat port `80`/`443` & reload Nginx | **Ya (`root`/aaPanel)** | Sudah ditangani otomatis oleh panel Nginx. |

---

## 8. Deploy Banyak Sekolah / Banyak Domain di 1 VPS (Multi-Tenant Terisolasi)

Aplikasi dapat dijalankan untuk banyak sekolah di satu VPS dengan **database, sesi WhatsApp, kamera, dan port yang 100% terisolasi** satu sama lain (tidak pernah bentrok di port `3000`):

### Mode Node.js / aaPanel
- **Sekolah 1** (`/www/wwwroot/smk1.sch.id`):
  `npm run setup:school -- --domain smk1.sch.id` → otomatis mendapat `PORT=3001` → Reverse Proxy Nginx ke `http://127.0.0.1:3001`
- **Sekolah 2** (`/www/wwwroot/smk2.sch.id`):
  `npm run setup:school -- --domain smk2.sch.id` → otomatis mendapat `PORT=3002` → Reverse Proxy Nginx ke `http://127.0.0.1:3002`
- **Sekolah 3** (`/www/wwwroot/smk3.sch.id`):
  `npm run setup:school -- --domain smk3.sch.id` → otomatis mendapat `PORT=3003` → Reverse Proxy Nginx ke `http://127.0.0.1:3003`

*(Script `setup-school.sh` otomatis memindai file `.env` di folder tetangga maupun port yang sedang terpakai agar tidak pernah memakai port kembar.)*

### Mode Docker Compose per Sekolah
Salin `docker-compose.yml` ke folder masing-masing sekolah dengan file `.env` berbeda:
```env
CONTAINER_NAME="absensi-smk2"
HOST_PORT="3082"
DATA_PATH="./data"
APP_URL="https://smk2.sch.id"
```
Jalankan `docker compose up -d` lalu arahkan Reverse Proxy domain sekolah tersebut ke `http://127.0.0.1:3082`.

---

## 9. Deploy via Docker & Docker Hub (All-in-One Image)

Jika ingin menggunakan **paket lengkap All-in-One** (*Node.js 22 + Python InsightFace `buffalo_l` + Rust `face_accel` + Piper TTS Offline + Supervisord*):

### Cara A: Otomatis Publish ke Docker Hub via GitHub Actions
File `.github/workflows/docker-publish.yml` sudah siap pakai:
1. Buat Access Token di Docker Hub (**Account Settings → Personal Access Tokens → Read & Write**).
2. Di GitHub Repo → **Settings → Secrets and variables → Actions**, tambahkan Secrets:
   - `DOCKERHUB_USERNAME`
   - `DOCKERHUB_TOKEN`
   *(Opsional)* tambahkan Variable `DOCKERHUB_REPO` (default: `absensi-smk-face-ai`).
3. Push ke branch `main` atau jalankan workflow secara manual.

### Cara B: Build & Run di VPS
```bash
# Build & push dari PC/VPS
docker build --platform linux/amd64 -t <username>/absensi-smk-face-ai:latest .
docker push <username>/absensi-smk-face-ai:latest

# Jalankan di server (binding aman ke 127.0.0.1:3080 untuk Reverse Proxy Nginx)
docker run -d \
  --name absensi-smk-face-ai \
  --restart unless-stopped \
  -p 127.0.0.1:3080:80 \
  -e TZ=Asia/Jakarta \
  -v absensi_data:/app/data \
  <username>/absensi-smk-face-ai:latest
```
Atau dengan `docker-compose.yml`:
```bash
DOCKERHUB_IMAGE=<username>/absensi-smk-face-ai:latest docker compose up -d
```

---

## 10. Setup Awal ala WordPress & Keamanan Produksi

Aplikasi ini dirancang untuk skenario **jual putus / multi-sekolah**, sehingga dibuat sesederhana mungkin tanpa memaksa teknisi membuat token acak secara manual:

### 1. Tidak Ada Password Bawaan (`admin123` Sudah Dihapus Total)
Server baru yang langsung diakses publik tidak bisa dibobol memakai password default karena **tidak memiliki akun bawaan**.
- **Cara Web (Setup Wizard ala WordPress — Paling Mudah)**:
  1. Jalankan server lalu buka `https://domain-sekolah.sch.id/` di browser.
  2. Layar **Setup Awal Sistem Absensi Sekolah** akan muncul otomatis.
  3. Isi **Nama Sekolah**, **Nama Admin**, **Email Login**, dan **Password Admin** (minimal 8 karakter).
  4. Klik **Selesaikan Setup & Masuk Dashboard**. Halaman `/setup` langsung **terkunci permanen (`HTTP 409`)** setelah Admin pertama tersimpan.
- **Cara CLI Langsung Saat Deploy**:
  ```bash
  npm run setup:school -- \
    --domain absensi.smkpercut.store \
    --school-name "SMK Negeri 1 Percut" \
    --admin-email admin@smkpercut.sch.id \
    --admin-password "PasswordKuatSekolah#2025"
  ```

### 2. Pengamanan Rahasia & Endpoint Otomatis
- **Tidak perlu isi `SESSION_SECRET` / `INTERNAL_API_TOKEN` manual**: Bila belum diset di `.env`, `server.ts` atau `setup-school.sh` otomatis membangkitkan token kriptografis acak dan menyimpannya dengan izin aman (`chmod 600 .env`, `chmod 700 data/`).
- **Perlindungan Internal AI (`/api/internal/*`)**: Diblokir otomatis dari traffic internet atau header proxy publik (`X-Forwarded-For` / `Via`); hanya menerima koneksi langsung dari loopback server (`127.0.0.1`) atau header `X-Internal-Token` yang valid.
- **Perlindungan RTSP URL**: Validasi ketat hanya menerima `rtsp://` / `rtsps://`, menolak injeksi argumen FFmpeg/karakter kontrol, dan **menyensor username/password kamera** pada log serta antarmuka saat bukan editor.
- **Perlindungan Sesi & CSRF**: Cookie `HttpOnly` + `SameSite=Lax` (+ `Secure` otomatis saat HTTPS), pengecekan *same-origin* untuk aksi mutasi, dan *rate limiter* pada `/api/auth/login`, `/api/setup/initialize`, serta `/api/guest/lookup`.

---

## 11. Auto-Update Otomatis dari GitHub (1 Jam Sekali & Universal)

Script `scripts/auto-update.sh` membuat aplikasi di VPS/aaPanel selalu ter-update aman tanpa menimpa database sekolah:
- **Database SQLite (`data/`) & `.env` tidak di-track Git**, sehingga tidak pernah tertimpa `git pull`.
- **Backup pre-update otomatis** di `data/backups/pre-update-*.bak` sebelum menarik commit baru.
- **Build sebelum restart**: Jika `npm run build` gagal, aplikasi yang sedang live tidak dimatikan.
- **Auto-fix izin aaPanel**: Menjalankan `chmod +x node_modules/.bin/*` dan `chown -R www:www` bila perlu.

### Opsi A: Cron 1 Jam Sekali (Paling Disarankan)
```bash
cd /www/wwwroot/smkn1pst
npm run update:cron
```
Perintah ini memasang cron `0 * * * *` (setiap jam ke-0) dengan log di `data/auto-update.log`.
- Cek status cron & Git: `bash scripts/auto-update.sh --status`
- Uji tanpa mengubah file: `npm run update:check`
- Hapus jadwal cron: `bash scripts/auto-update.sh --uninstall-cron`

### Opsi B: Auto-Update dari Dalam Aplikasi (`.env`)
Jika server tidak memakai akses `crontab`, tambahkan di `.env`:
```env
AUTO_UPDATE_ENABLED="1"
AUTO_UPDATE_INTERVAL_MINUTES="60"
AAPANEL_PROJECT_NAME="absen"
```

### Opsi C: Auto-Update Instan via aaPanel Webhook / GitHub Actions
- Di **aaPanel Git Manager / Webhook**, isi script: `bash /www/wwwroot/smkn1pst/scripts/auto-update.sh`
- Di **GitHub Actions (`.github/workflows/deploy-nodejs.yml`)**, isi Secrets `VPS_HOST`, `VPS_USER`, `VPS_SSH_KEY` serta Variable `VPS_APP_DIR`.

### Menyambungkan Folder Upload ZIP ke GitHub (Tanpa Hapus `data/` & `.env`)
```bash
cd /www/wwwroot/smkn1pst
cp -a data data_cadangan_aman
git init -b main
git remote add origin https://github.com/<username>/<repo>.git
git fetch origin
git reset --mixed origin/main
git checkout -- .
chown -R www:www /www/wwwroot/smkn1pst
npm run update:check
```

---

## 12. Referensi Environment Variables (`.env`) & Endpoint Penting

### Variabel `.env` Utama
| Variabel | Default | Fungsi |
|---|---|---|
| `PORT` | `3000` | Port HTTP/WebSocket aplikasi Node.js. Gunakan port berbeda (`3001`, `3002`, ...) per sekolah. |
| `DATA_DIR` | `./data` | Lokasi database SQLite, snapshots, backup, cache TTS, sesi WA, dan log. |
| `TZ` | `Asia/Jakarta` | Wajib untuk konsistensi jadwal masuk/pulang dan antrean WhatsApp WIB. |
| `NODE_ENV` | `production` | Di set `production` saat deploy agar server melayani hasil build `dist/`. |
| `APP_URL` | *(opsional)* | URL publik domain sekolah (contoh `https://absensi.smk1.sch.id`). |
| `FACE_SERVICE_URL` | `http://127.0.0.1:8001` | Alamat layanan Python InsightFace internal (jika aktif). |
| `NODE_WASM_LIVE` | `1` | Mengaktifkan worker wajah bawaan Node.js saat Python face-service tidak aktif. |
| `DISABLE_NODE_RTSP_WORKER` | `0` | Set `1` jika hanya ingin menggunakan worker Python atau mode hemat CPU. |
| `PIPER_BIN` / `PIPER_MODEL` | `/usr/local/piper/piper` | Lokasi binary dan model ONNX Piper TTS Bahasa Indonesia (opsional; fallback ke browser TTS). |
| `SESSION_SECRET` / `INTERNAL_API_TOKEN` | *(auto-generated)* | Token kriptografis sesi login dan API internal; otomatis dibuat jika kosong. |
| `AUTO_UPDATE_ENABLED` | `0` | Set `1` untuk mengaktifkan pengecekan update GitHub otomatis dari dalam aplikasi Node. |

### Endpoint API Ringkas
- **Kesehatan & Setup**: `GET /api/health`, `GET /api/setup/status`, `POST /api/setup/initialize`
- **Autentikasi**: `GET /api/auth/me`, `POST /api/auth/login`, `POST /api/auth/logout`, `POST /api/auth/change-password`
- **Data & Pencarian**: `GET /api/bootstrap` (mendukung `ETag`), `GET /api/students/autocomplete?q=...`, `GET /api/worker/status`
- **Siswa & Akademik**: `GET /api/students/import-template`, `POST /api/students/import-excel`, CRUD `/api/students`, `/api/jurusans`, `/api/kelas`, `POST /api/students/:id/enroll`, `POST /api/students/enroll-batch`, `POST /api/compare-face`
- **Absensi & Laporan**: `POST /api/attendance/override`, `GET /api/reports/csv`, `POST /api/guest/lookup`
- **Kamera & Gerbang**: CRUD `/api/gates` & `/api/cameras`, `POST /api/cameras/probe`, `GET /api/cameras/preview-stream` (`fps=5` atau `fps=native`)
- **Wajah Anonim & Review**: `POST /api/clusters/:id/assign`, `/new-student`, `/visitor`, `/hits/remove`, `/hits/set-primary`, `DELETE /api/clusters/:id`, `POST /api/face-reviews/:id/approve`, `/rollback`, `/approve-all`
- **Storage, Backup & Migrasi AI**: `GET /api/storage/breakdown`, `POST /api/storage/cleanup`, `GET /api/backups`, `POST /api/backups/run`, `POST /api/backups/restore`, `POST /api/system/migrate-embeddings`
- **WhatsApp & Kiosk**: `/api/wa/accounts`, `/api/wa/accounts/:id/pair`, `/api/wa/templates/:id`, `POST /api/wa/dispatch-daily-now`, `GET /api/kiosk/:cameraId`, `GET /api/tts`, WebSocket `/ws`

---

## 13. Panduan Operasional Harian Sekolah & Troubleshooting

### Checklist Hari Pertama di Sekolah
1. **Setup Awal (`/setup`)**: Buat akun Admin utama dan pastikan **Mode Produksi** aktif.
2. **Struktur Sekolah**: Masukkan **Jurusan** & **Kelas** (atau langsung pakai **Import Excel Siswa** — kelas yang belum ada otomatis dibuatkan).
3. **Jadwal Sekolah**: Atur jam masuk, toleransi terlambat, dan jam pulang di menu **Jadwal**.
4. **Daftarkan Gerbang & Kamera**: Tambahkan kamera RTSP, klik **Uji Probe & Preview Live** (pilih **5 FPS** atau **Bawaan RTSP**) untuk memastikan sudut kamera mengarah lurus ke wajah siswa dengan ukuran minimal `60 px`.
5. **Pairing WhatsApp & Kiosk**: Scan QR di menu **WhatsApp** (mulai dengan status `WARMUP`), lalu buka `/panggil/1` di layar TV/monitor gerbang dengan mode fullscreen (`F11`).
6. **Cek Rutin Mingguan Guru BK**: Buka tab **Penamaan Wajah Anonim** untuk memeriksa klaster berstatus `READY` (zoom 2x/3x untuk verifikasi foto) dan tinjau **Face Update Review**.

### Pemecahan Masalah Umum (Troubleshooting)

| Gejala / Error | Penyebab Utama | Solusi Cepat |
|---|---|---|
| **Halaman putih / Error 404 pada `/node_modules/.vite/...` atau MIME `octet-stream`** | Server dijalankan dengan mode `dev` atau Nginx mencegat file `.js`/`.css`. | Jalankan `npm run build`, ubah Run Opt di aaPanel dari `dev` ke **`start`**, dan hapus blok `location ~ .*\.(js\|css)?$` di config Nginx. |
| **Kamera gagal / Error `EACCES` pada FFmpeg** | Izin `+x` binary `@ffmpeg-installer` hilang (sering setelah upload ZIP) atau partisi server `noexec`. | Jalankan `npm run setup:school -- --domain <domain>` atau install FFmpeg sistem (`apt install -y ffmpeg`). Cek `curl -s http://127.0.0.1:<PORT>/api/health` hingga `"ffmpeg_ready":true`. |
| **Kamera berstatus `OFFLINE` / gambar patah-patah** | Alamat RTSP salah, firewall memblokir port 554, atau stream UDP putus. | Uji URL RTSP dengan tombol **Probe Kamera** di menu Kamera. Pastikan format `rtsp://user:pass@ip:554/...` dan jaringan lokal/VPN kamera lancar. |
| **Wajah siswa terdeteksi sebagai Anonim terus setelah ganti engine** | Perbedaan dimensi vektor antara `1024-D` (Node WASM) dan `512-D` (Python InsightFace). | Buka **Dashboard** lalu klik tombol **Sinkronkan / Migrasi Embedding** agar seluruh foto profil siswa diekstrak ulang ke dimensi mesin aktif. |
| **Foto klaster anonim ada topi / orang lain ikut masuk** | Pose samping atau wajah orang lain mirip sementara di klaster. | Buka **Penamaan Wajah Anonim** → klik foto → **Zoom `2x / 3x`** → klik **Hapus Foto** pada foto yang salah. Klaster otomatis kembali ke `PENDING` untuk merekam foto pengganti yang bersih. |
| **WhatsApp berhenti mengirim / terputus** | Sesi WA ter-logout dari HP atau kuota harian mode `WARMUP` (20/hari) habis. | Cek status akun di menu **WhatsApp**. Scan ulang QR jika `Disconnected`, atau ubah ke `ACTIVE` setelah nomor cukup matang. |
| **Ukuran folder `data/` mendekati batas 10 GB** | Banyak backup manual atau snapshot lama menumpuk. | Buka **Pengaturan → Pembersihan Storage**, atau sistem akan otomatis menjalankan *Emergency Trim* saat menyentuh `9.0 GB` untuk mengembalikannya di bawah `8.0 GB`. |
