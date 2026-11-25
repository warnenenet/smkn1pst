# Manual Lengkap Instalasi All-in-One Docker + aaPanel (Reverse Proxy Domain)

Panduan ini memakai **1 Container Docker All-in-One** (`docker-compose.yml`).
Artinya: **Web Server (Node.js 24), AI Wajah (InsightFace `buffalo_l` 512-D + Rust), WhatsApp Gateway (Chromium), dan Suara Kiosk (Piper TTS)** semuanya berjalan **di dalam 1 container Docker yang terisolasi**.

> **Kenapa cara ini paling aman untuk VPS aaPanel?**
> - **TIDAK menyentuh / merusak Nginx, Node.js, atau Python bawaan aaPanel.**
> - **aaPanel hanya bertugas mengurus Domain, Reverse Proxy (`http://127.0.0.1:3080`), dan SSL (HTTPS).**
> - Tidak perlu install Node Version Manager, Python, FFmpeg, atau Chromium di server utama.
> - Tidak perlu `npm run setup:school` dan tidak perlu mengisi environment variable manual.

---

## 1. Persiapan di VPS aaPanel (1x Saja di VPS Baru)

Pastikan di **aaPanel → App Store** sudah terpasang:
1. **Nginx** (bawaan aaPanel — untuk domain & SSL)
2. **Docker** (atau lewat menu **Docker** di sidebar kiri aaPanel → klik **Install Docker**)

*(Jika memakai VPS baru yang belum ada `git` / `curl`, buka Terminal SSH/aaPanel sebagai `root` dan jalankan 1x:)*
```bash
apt update && apt install -y git curl
```

---

## 2. Jalankan 1 Container All-in-One Docker

Masuk ke **Terminal** (SSH atau menu Terminal di aaPanel) sebagai `root`, lalu jalankan 3 langkah ini:

```bash
# 1. Buat / masuk ke folder project (contoh di /opt/absensi-smkn1)
cd /opt
git clone https://github.com/USERNAME/NAMA-REPO.git absensi-smkn1
cd /opt/absensi-smkn1

# 2. Build & nyalakan 1 container All-in-One di background
docker compose up -d --build
```

> **Catatan Build Pertama (Sekali Saja):**
> - Build pertama memakan waktu sekitar **5–10 menit** karena Docker mengkompilasi akselerasi Rust dan mengunduh model AI wajah **InsightFace `buffalo_l`** serta suara **Piper TTS Bahasa Indonesia** ke dalam image agar nantinya berjalan 100% offline.
> - Selama proses ini, database `./data` dan sesi `./storage` tetap tersimpan aman di luar container (tidak hilang saat update/restart).

### Cek Apakah Container Sudah Sehat

Tunggu ±20–30 detik setelah build selesai, lalu cek:
```bash
docker compose ps
curl -s http://127.0.0.1:3080/api/health
```
Pastikan status container **`Up (healthy)`** dan output `curl` menampilkan `"ok":true`.
Jika masih loading model AI, tunggu 20 detik lalu ulangi `curl` di atas.

Untuk melihat log langsung jika perlu:
```bash
docker compose logs -f --tail=50
```
*(Tekan `Ctrl + C` untuk keluar dari tampilan log tanpa mematikan container).*

---

## 3. Pasang Domain & SSL Lewat aaPanel (Biarkan aaPanel yang Manage)

Container Docker sudah aktif di alamat lokal VPS: **`http://127.0.0.1:3080`** (hanya bisa diakses dari dalam VPS, aman dari akses langsung internet).
Sekarang hubungkan domain sekolah Anda lewat UI aaPanel tanpa mengotak-atik file Nginx server secara manual:

1. Login ke **aaPanel** → buka menu **Website** (tab **PHP Project** / standar).
2. Klik **Add site** lalu isi:
   - **Domain**: `absensi.sekolahanda.sch.id`
   - **Database**: `No Database`
   - **PHP version**: **`Pure static`** *(Static site biasa)*
   - Klik **Submit / Confirm**.
3. Klik nama website `absensi.sekolahanda.sch.id` yang baru dibuat untuk membuka pengaturannya:
   - Buka tab **SSL** → pilih **Let's Encrypt** → centang domain Anda → klik **Apply** (opsional: aktifkan **Force HTTPS**).
   - Buka tab **Reverse proxy** → klik **Add Reverse proxy**, isi:
     - **Proxy name**: `absensi`
     - **Target URL**: `http://127.0.0.1:3080`
     - **Sent Domain**: `$host`
     - Klik **Save**.

> **Catatan WebSocket (`/ws`) untuk Layar Kiosk `/panggil/1`:**
> Jika layar Kiosk di gerbang belum memunculkan panggilan suara otomatis secara real-time melalui domain HTTPS, buka tab **Reverse proxy** pada situs tersebut → klik **Conf** pada proxy `absensi`, dan pastikan di dalam blok `location ^~ /` sudah terdapat 3 baris standar ini (jika belum ada, tambahkan di dalam `location`):
> ```nginx
> proxy_http_version 1.1;
> proxy_set_header Upgrade $http_upgrade;
> proxy_set_header Connection "upgrade";
> ```
> Jangan ubah file Nginx utama aaPanel di luar menu website ini.

---

## 4. Pengaturan Awal di Browser

1. Buka browser dan kunjungi **`https://absensi.sekolahanda.sch.id`**.
2. Layar **Setup Awal Sistem Absensi Sekolah** muncul otomatis:
   - Isi **Nama Sekolah**
   - Isi **Nama Administrator** & **Email Login**
   - Buat **Password minimal 8 karakter**
   - Klik **Selesaikan Setup & Masuk Dashboard** *(halaman setup otomatis terkunci permanen setelah ini)*.
3. Cek di Dashboard:
   - Engine AI otomatis terbaca **`INSIGHTFACE_PYTHON (512-D)`** dan **Model AI: SIAP** *(karena AI Wajah + Web Node sudah berada di dalam 1 container yang sama!)*.
   - **WhatsApp Gateway Chromium** & **Piper TTS Offline** juga sudah langsung aktif tanpa setup terpisah.

---

## 5. Cara Update dari GitHub (Manual Maupun Otomatis)

Database (`./data/absensi.sqlite`), foto siswa (`./data/snapshots`), dan sesi WhatsApp (`./storage`) disimpan di folder luar container (`volumes`), jadi **data tidak akan terhapus** saat container di-rebuild.

### Cara A: Update Manual Cepat (1 Perintah)
Kapan pun Anda selesai push perubahan ke GitHub, jalankan di terminal VPS:
```bash
cd /opt/absensi-smkn1
git pull
docker compose up -d --build
```
Docker otomatis membangun image baru dan menukar container dengan downtime hanya beberapa detik.

### Cara B: Auto-Update Otomatis Tiap 1 Jam Berdasarkan Nomor Versi
Jika Anda ingin semua server sekolah otomatis menarik update saat nomor `version` di `package.json` GitHub naik:

1. **Di komputer/repo pusat Anda (saat mengirim update ke GitHub):**
   ```bash
   npm run release:patch -- "Catatan perbaikan"   # 1.0.1 -> 1.0.2
   ```
   *(Atau `npm run release:minor -- "..."` untuk fitur baru, atau naikkan `version` di `package.json` lalu push).*

2. **Di setiap VPS sekolah (aktifkan cron 1x saja):**
   ```bash
   cd /opt/absensi-smkn1
   bash scripts/auto-update.sh --manager docker --install-cron
   ```
   Setiap **1 jam sekali**, skrip akan:
   - Mengecek apakah `version` di `package.json` GitHub lebih baru dari versi yang terpasang.
   - Jika ada versi baru: membackup `./data/absensi.sqlite` → `git pull --ff-only` → `docker compose up -d --build` → cek `http://127.0.0.1:3080/api/health`.
   - Untuk cek status atau test manual kapan saja:
     ```bash
     cd /opt/absensi-smkn1
     bash scripts/auto-update.sh --manager docker --dry-run   # Cek saja tanpa rebuild
     bash scripts/auto-update.sh --manager docker             # Update sekarang jika versi baru tersedia
     tail -n 50 data/auto-update.log                          # Lihat log auto-update
     ```

> **Jika Repo GitHub Bersifat Private:** simpan *GitHub Personal Access Token (Read-only)* 1x di VPS:
> ```bash
> git config --global credential.helper store
> git fetch origin   # masukkan username GitHub & token saat diminta (sekali saja)
> ```

---

## 6. Memasang Banyak Sekolah di 1 VPS yang Sama (Semua All-in-One Docker)

Setiap sekolah tinggal ditaruh di folder terpisah dengan **`HOST_PORT`** berbeda (tidak bentrok dengan sekolah lain):

- **Sekolah 1** (`/opt/absensi-smkn1` — default port **`3080`**):
  ```bash
  cd /opt && git clone https://github.com/USERNAME/NAMA-REPO.git absensi-smkn1
  cd /opt/absensi-smkn1 && docker compose up -d --build
  ```
  → Di aaPanel Reverse Proxy arahkan ke `http://127.0.0.1:3080`.

- **Sekolah 2** (`/opt/absensi-smkn2` — pakai port **`3081`**):
  ```bash
  cd /opt && git clone https://github.com/USERNAME/NAMA-REPO.git absensi-smkn2
  cd /opt/absensi-smkn2
  echo "HOST_PORT=3081" > .env
  docker compose up -d --build
  ```
  → Di aaPanel Reverse Proxy arahkan ke `http://127.0.0.1:3081`.

---

## 7. Ringkasan Pengaturan Kamera & Pemecahan Masalah Cepat

### Tips Deteksi Kamera Gerbang
- **Wajah Tidak Masuk Anonim / Terlewat**:
  - Cek di **Gerbang & Kamera → Uji Probe / Preview Live** apakah gambar kamera tampil jelas.
  - Perhatikan **Bounding Wajah Minimal (`min_face_size`)**: jika di Pengaturan Anda mengisi `200 px`, wajah siswa yang berdiri agak jauh dari kamera (misal `90–150 px`) akan diabaikan oleh filter. Turunkan ke `80`–`120 px` jika jarak kamera ke gerbang agak jauh.
  - **Masker** ditolak otomatis (`DROP:landmark`); **Kacamata** didukung otomatis.

### Troubleshooting
| Masalah | Cara Cek & Solusi |
|---|---|
| **Domain menampilkan `502 Bad Gateway` di browser** | Cek container dengan `docker compose ps` dan `curl -s http://127.0.0.1:3080/api/health`. Pastikan container sudah `healthy` dan Target URL di aaPanel Reverse Proxy adalah `http://127.0.0.1:3080`. |
| **Ingin merestart seluruh layanan (Web + AI + WA)** | Jalankan `cd /opt/absensi-smkn1 && docker compose restart` |
| **Melihat error Python AI / Node / WA Gateway** | Jalankan `cd /opt/absensi-smkn1 && docker compose logs -f --tail=100` |
| **Perlu mem-backup database manual** | File database ada langsung di folder `./data/absensi.sqlite` atau unduh `.sqlite.gz` dari menu **Pengaturan → Backup & Restore**. |
