# Manual Lengkap Instalasi aaPanel & Auto-Update GitHub (Untuk Pemula / Non-Programmer)

Panduan ini dibuat khusus agar siapa pun—**tanpa perlu paham pemrograman**—bisa memasang, menjalankan, dan memperbarui aplikasi **Absensi SMK Face AI** di VPS **aaPanel** (menggunakan **Node Project** non-Docker + **Docker pendamping untuk AI Wajah**).

---

## 1. Apakah Cukup 1 Perintah `npm run setup:school` Saja?

**Hampir semua berjalan otomatis dengan 1 perintah itu, KECUALI 2 hal di awal & di akhir:**
1. **Sebelum perintah dijalankan (1x seumur hidup VPS)**: pastikan **Node.js (v22 atau v24)** dan **Docker** sudah terpasang di aaPanel.
2. **Setelah perintah selesai**: Anda perlu **menyalakan aplikasi web-nya 1x di menu aaPanel → Website → Node project** (pilih folder, isi port yang muncul di layar, isi domain, klik Start).

### Apa Saja yang Otomatis Dikerjakan oleh `npm run setup:school`?
Saat Anda menjalankan `npm run setup:school`, skrip langsung mengerjakan semua pekerjaan teknis ini untuk Anda:
- Mencari **port kosong otomatis** (misal web di `3001`, AI wajah di `8001`) supaya tidak bentrok dengan website lain.
- Membuat file konfigurasi `.env` dan membuat **token keamanan acak otomatis** (`data/secrets/internal_token`) — Anda **tidak perlu** mengisi environment variable secara manual.
- Menginstal dependensi Node.js dan membangun file web produksi (`dist/`).
- Menginstal Python + Chromium untuk **WhatsApp Gateway** (scan QR multi-nomor / Round-Robin).
- Membangun dan menyalakan **container Docker AI Wajah** (`docker-compose.face.yml` dengan InsightFace `buffalo_l` 512-D + Rust) di background secara otomatis (`restart: unless-stopped`).
- Menyalakan **Auto-Update GitHub otomatis** (`AUTO_UPDATE_ENABLED=1` & `UPDATE_ONLY_NEW_VERSION=1`) jika folder berasal dari GitHub (`git clone`).
- Mengatur kepemilikan folder ke user `www:www` agar Node Project di aaPanel bisa jalan tanpa error hak akses.

---

## 2. Langkah 1 — Siapkan VPS aaPanel (Hanya 1 Kali di VPS Baru)

Lakukan langkah ini hanya sekali saat VPS baru disiapkan:

1. Login ke **aaPanel** lewat browser.
2. Buka menu **App Store** di aaPanel, lalu install:
   - **Node.js Version Manager** → di dalamnya klik install **Node v22.x** atau **v24.x** *(wajib minimal v22.18)*.
   - **Docker** *(atau lewat menu Docker di sidebar kiri aaPanel → klik Install Docker + Docker Compose)*.
3. Buka menu **Terminal** di aaPanel (atau login SSH sebagai `root`), lalu jalankan perintah ini untuk memasang alat bantu sistem:
   ```bash
   apt update && apt install -y git curl ffmpeg sqlite3
   ```

---

## 3. Langkah 2 — Download Aplikasi & Jalankan Setup (1 Perintah)

Masuk ke Terminal aaPanel sebagai `root`, lalu ikuti persis langkah ini:

```bash
# 1. Masuk ke folder website aaPanel
cd /www/wwwroot

# 2. Download source dari GitHub Anda (ganti dengan link repo GitHub Anda)
git clone https://github.com/USERNAME/NAMA-REPO.git smkn1
cd /www/wwwroot/smkn1

# 3. Install modul dasar & jalankan setup lengkap satu pintu
npm install --no-audit --no-fund
npm run setup:school -- --domain absensi.sekolahanda.sch.id
```

> **Catatan penting saat setup berjalan:**
> - Tunggu 3–8 menit pada instalasi pertama karena Docker mengunduh & menyiapkan model AI wajah **InsightFace `buffalo_l`**.
> - Di bagian paling bawah setelah selesai, perhatikan tulisan seperti ini:
>   ```text
>   Port Terpilih  : 3001
>   Face AI (Docker): SIAP (Docker InsightFace port 8001)
>   WA Gateway     : SIAP (port 8003)
>   ```
> - **Catat angka `Port Terpilih`** (misalnya `3001`), atau `3002` kalau Anda pasang untuk sekolah kedua.

---

## 4. Langkah 3 — Nyalakan Web di aaPanel (Node Project)

Sekarang tinggal mendaftarkan aplikasi di panel aaPanel agar bisa diakses lewat domain/HTTPS:

1. Di aaPanel, buka **Website → Node project → Add Node project**.
2. Isi formulir **persis seperti tabel ini** (kolom yang tidak disebut biarkan standar):

   | Kolom di aaPanel | Isi dengan | Keterangan |
   |---|---|---|
   | **Path** | `/www/wwwroot/smkn1` | Folder project hasil clone |
   | **Project Name** | `absensi-smkn1` | Bebas, tanpa spasi |
   | **Run opt** | `start` *(dari package.json)* | **WAJIB `start`**, JANGAN pilih `dev`! |
   | **Port** | `3001` | Samakan persis dengan `Port Terpilih` tadi |
   | **Run user** | `www` | Jangan pakai `root` |
   | **Node version** | `v22.x` atau `v24.x` | Pilih yang sudah di-install di Langkah 1 |
   | **Domain name** | `absensi.sekolahanda.sch.id` | Isi domain sekolah Anda |
   | **Mapping** | **Centang / Aktifkan** | Agar aaPanel otomatis membuatkan Nginx + WebSocket |

   > **PENTING:** Jangan mengedit file konfigurasi Nginx secara manual jika Anda mengaktifkan **Mapping**. Setelah project statusnya **Running**, cukup klik tab **SSL** pada project tersebut untuk mengaktifkan HTTPS (Let's Encrypt).

---

## 5. Langkah 4 — Pengaturan Awal di Browser & Menu Penting

1. Buka browser dan kunjungi **`https://absensi.sekolahanda.sch.id`**.
2. Karena baru pertama kali dipasang, layar **Setup Awal Sistem Absensi Sekolah** akan muncul otomatis:
   - Isi **Nama Sekolah**
   - Isi **Nama Administrator** & **Email Login**
   - Buat **Password minimal 8 karakter**
   - Klik **Selesaikan Setup & Masuk Dashboard** *(halaman setup otomatis terkunci permanen setelah ini)*.
3. Cek di Dashboard: kotak status harus bertuliskan **`INSIGHTFACE_PYTHON (512-D)`** dan **Model AI: SIAP**.

### Ringkasan Pengaturan Kamera & Deteksi Wajah (Menu UI)
- **Rentang Bounding Box Wajah (`Min` – `Max` px)**:
  - Buka **Pengaturan & User** untuk mengatur batas global, atau **Gerbang & Kamera → Kalibrasi** untuk mengatur per kamera.
  - Kotak **Hijau (`MIN`)** = ukuran wajah terkecil yang masih boleh dideteksi (misal `80 px`).
  - Kotak **Kuning Putus-Putus (`MAX`)** = ukuran wajah terbesar (isi `0` jika bebas; isi misal `350 px` kalau kamera terlalu dekat agar wajah raksasa yang buram tidak ikut ter-capture).
  - Untuk kamera CCTV yang kurang tajam/buram, naikkan `Minimal Wajah` (misalnya `120`–`160 px`) supaya hanya wajah dekat yang jelas yang di-capture AI.
- **Kacamata & Masker**:
  - **Kacamata** didukung otomatis oleh AI tanpa setting tambahan.
  - **Masker** otomatis ditolak oleh gerbang (`DROP:landmark`) agar wajah tertutup tidak salah dikenali sebagai siswa lain.

---

## 6. Panduan Auto-Update ke GitHub (Multi-Server Sekolah Otomatis Ikut Update)

Sistem ini sudah dilengkapi mekanisme **rilis berbasis nomor versi** (contoh: `1.0.0` → `1.0.1` → `1.1.0`):
- Anda mengubah kode di repo pusat lalu menaikkan nomor versi dan push ke GitHub.
- Semua server sekolah mengecek GitHub setiap **1 jam sekali**.
- Server sekolah **hanya melakukan `git pull` & rebuild otomatis jika nomor versi di GitHub lebih tinggi** dari versi yang terpasang saat itu. Jadi jika Anda baru menyimpan draft/catatan ke GitHub tanpa menaikkan nomor versi, server sekolah tidak akan terganggu/restart mendadak.

### A. Di Komputer / Repo Pusat Anda (Cara Kirim Update ke Semua Sekolah)

Setiap kali Anda selesai menambah fitur atau memperbaiki bug dan siap mengirimnya ke seluruh server sekolah, cukup jalankan **SATU** perintah sesuai jenis perubahannya:

- **Jika perbaikan bug kecil** (`1.0.0` → `1.0.1`):
  ```bash
  npm run release:patch -- "Perbaikan akurasi deteksi kamera malam"
  ```
- **Jika menambah fitur baru** (`1.0.0` → `1.1.0`):
  ```bash
  npm run release:minor -- "Tambah filter kelas di laporan"
  ```
- **Jika perubahan besar/merombak sistem** (`1.0.0` → `2.0.0`):
  ```bash
  npm run release:major -- "Pembaruan besar sistem absensi"
  ```

**Apa yang dilakukan perintah di atas secara otomatis?**
1. Mengecek kode dengan `npm run lint`, unit test, dan `npm run build` (jika ada error, proses dibatalkan sehingga kode rusak tidak pernah terkirim ke sekolah).
2. Menaikkan nomor `version` di `package.json`.
3. Membuat commit Git, memberi tag versi (`v1.0.1`), lalu langsung melakukan `git push` ke GitHub.

### B. Di Setiap Server Sekolah (Otomatis Tarik Update)

1. **Sudah Aktif Otomatis dari `setup:school`:**
   - Saat Anda menjalankan `npm run setup:school` di folder hasil `git clone`, di `.env` otomatis tertulis `AUTO_UPDATE_ENABLED="1"` dan `UPDATE_ONLY_NEW_VERSION="1"`.
   - Server akan mengecek GitHub setiap **60 menit**. Begitu terdeteksi versi baru (misal `v1.0.0` → `v1.0.1`), skrip otomatis:
     1. Membackup database `data/absensi.sqlite` ke `data/backups/`.
     2. Menarik update (`git pull --ff-only`).
     3. Menginstal paket baru (hanya jika `package.json` berubah).
     4. Menjalankan `npm run build`.
     5. Membangun ulang Docker Face AI secara otomatis jika ada perubahan pada folder `services/face-service/` atau `services/rust-accel/`.
     6. Menyelaraskan kepemilikan ke `www:www` & merestart **aaPanel Node Project**.
     7. Memeriksa `/api/health` untuk memastikan web hidup normal kembali.

2. **Opsional — Pasang Cron aaPanel (Cadangan Agar Tetap Update Walau Node Sempat Mati):**
   Jalankan perintah ini 1x di terminal sekolah:
   ```bash
   cd /www/wwwroot/smkn1
   npm run update:cron
   ```
   *(Atau di menu **aaPanel → Cron**, buat tugas Shell Script tiap 1 jam berisi: `cd /www/wwwroot/smkn1 && bash scripts/auto-update.sh`)*

3. **Perintah Cek / Update Manual Kapan Saja (Saat Ingin Cepat Tanpa Menunggu 1 Jam):**
   ```bash
   cd /www/wwwroot/smkn1
   npm run update:check    # Cek saja apakah ada versi baru (tidak mengubah file)
   npm run update          # Tarik update sekarang jika versi baru tersedia
   bash scripts/auto-update.sh --force   # Paksa tarik & rebuild meski nomor versi sama
   bash scripts/auto-update.sh --status  # Lihat versi saat ini & status Git/Cron
   ```
   Untuk melihat riwayat log auto-update di server sekolah:
   ```bash
   tail -n 50 /www/wwwroot/smkn1/data/auto-update.log
   ```

> **Catatan Repo GitHub Private:** Jika repo GitHub Anda bersifat **Private**, simpan *GitHub Personal Access Token (Read-only Content)* 1x di tiap server sekolah agar `git pull` otomatis tidak meminta password:
> ```bash
> git config --global credential.helper store
> git fetch origin   # masukkan username GitHub & Personal Access Token saat diminta (sekali saja)
> ```

---

## 7. Memasang Banyak Sekolah di 1 VPS yang Sama

Anda cukup ulangi Langkah 2 & 3 di folder berbeda (misalnya `/www/wwwroot/smkn2`):
```bash
cd /www/wwwroot
git clone https://github.com/USERNAME/NAMA-REPO.git smkn2
cd /www/wwwroot/smkn2
npm install --no-audit --no-fund
npm run setup:school -- --domain absensi.smkn2.sch.id
```
`setup:school` otomatis memindai folder sebelah sehingga sekolah kedua langsung mendapat port yang terpisah (misal Web `3002`, Face AI `8002`) tanpa bentrok database maupun sesi WhatsApp.

---

## 8. Pemecahan Masalah Cepat (Troubleshooting Pemula)

| Masalah | Penyebab Umum | Cara Mengatasi |
|---|---|---|
| **Banner kuning di Dashboard: `Engine AI Wajah Docker Belum Aktif`** | Docker belum menyala atau belum di-build saat setup | Di terminal masuk folder project lalu jalankan:<br>`docker compose -f docker-compose.face.yml up -d --build`<br>Tunggu ±1 menit lalu cek dengan `curl http://127.0.0.1:8001/health` |
| **Web tidak bisa dibuka (`502 Bad Gateway`)** | Node Project di aaPanel belum di-Start atau port beda | Cek **aaPanel → Website → Node project**, pastikan status **Running**, `Run opt = start`, dan angkanya sama dengan `PORT=` di file `.env`. |
| **Kamera gagal / Error `EACCES` FFmpeg** | Izin eksekusi file FFmpeg belum aktif | Jalankan `apt install -y ffmpeg` sebagai root, lalu restart Node Project di aaPanel. |
| **Server sekolah tidak auto-pull setelah `git push` biasa** | Nomor `version` di `package.json` belum naik | Selalu push lewat `npm run release:patch -- "pesan"` (atau naikkan manual `version` di `package.json`), karena server sekolah menunggu versi lebih baru. |
