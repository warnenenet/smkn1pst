# Absensi SMK Face AI (All-in-One Docker)

Sistem manajemen absensi Sekolah Menengah Kejuruan (SMK) berbasis pengenalan wajah (*InsightFace `buffalo_l`*), multi-gerbang, multi-kamera RTSP (1080p @ 5 FPS I-frame 5), akselerasi Rust, halaman panggil kiosk real-time (WebSocket + Piper TTS Bahasa Indonesia offline), WhatsApp gateway (Baileys + strategi anti-blokir / Meta Cloud / Fonnte / WABLAS), serta portal guest orang tua/siswa.

## Arsitektur All-in-One (1 Image Docker via Supervisord)
Semua layanan pendukung otomatis berjalan bersama saat container dinyalakan:
1. **Web App, API, WebSocket `/ws` & SQLite (`server.ts`, Port 80)**: Dashboard admin/BK/guru, penyimpanan SQLite WAL (`/app/data/absensi.sqlite`), kiosk `/panggil/:cameraId`, portal `/guest`, dan worker antrean WhatsApp.
2. **Python Face Recognition & RTSP Workers (`services/face-service/`, Port 8001 internal)**: Deteksi & embedding 512-dim *InsightFace `buffalo_l`* (anti-spoofing dinonaktifkan total), IoU tracker, dan worker RTSP TCP paralel untuk kamera 1080p @ 5 FPS.
3. **Rust Acceleration Binary (`services/rust-accel/`)**: Pencocokan 1:N *Cosine Similarity* berkecepatan tinggi hingga 5000+ siswa (dengan fallback NumPy).
4. **Piper TTS Offline (`id_ID-news_tts-medium`)**: Sintesis suara panggilan Bahasa Indonesia offline dengan cache disk maksimal 200 MB (`/app/data/tts_cache`).
5. **WhatsApp Gateway (`@whiskeysockets/baileys`)**: Pairing QR nyata di dashboard dengan sesi persisten di `/app/data/wa_auth`, delay acak 60–120 detik, mode WARMUP 20 pesan/hari, dan opsi Meta Cloud / Fonnte / WABLAS.

---

## Menjalankan Secara Lokal (Mode Web Dev)
```bash
npm install
npm run dev
```
Buka `http://localhost:3000`.

### Uji Lokal
```bash
npm run lint
npx tsx --test src/lib/attendanceEngine.test.ts
npm run build
```

---

## Upload ke GitHub & Auto-Publish Docker Image
Repositori ini dilengkapi GitHub Actions:
- `.github/workflows/ci.yml`: Menguji TypeScript, unit test Node, Vite build, Python syntax, dan `cargo test` Rust.
- `.github/workflows/docker-publish.yml`: Mem-build image all-in-one `linux/amd64` (lengkap dengan model `buffalo_l`, Piper `id_ID`, Rust binary, dan `supervisord`) lalu mem-publish otomatis ke **GitHub Container Registry (`ghcr.io`)**.

### Langkah Push ke GitHub
```bash
git init
git add .
git commit -m "Initial commit: Absensi SMK Face AI All-in-One"
git branch -M main
git remote add origin https://github.com/<username-github>/<nama-repo>.git
git push -u origin main
```
*(Opsional)* Untuk ikut mem-publish ke Docker Hub, tambahkan `DOCKERHUB_USERNAME` dan `DOCKERHUB_TOKEN` di **Repository Settings → Secrets and variables → Actions**.

---

## Deploy di Server / Portainer (1 Container)
Setelah workflow `Build & Publish Docker Image` selesai hijau di tab **Actions** GitHub:

```bash
docker run -d \
  --name absensi-sekolah \
  --restart unless-stopped \
  -p 80:80 \
  -v absensi_data:/app/data \
  ghcr.io/<username-github>/<nama-repo>:latest
```

Atau di **Portainer**:
1. **Containers → Add Container**
2. **Image**: `ghcr.io/<username-github>/<nama-repo>:latest`
3. **Ports**: `80` → `80` (`TCP`)
4. **Volumes**: `/app/data` → volume `absensi_data`
5. **Restart policy**: `Unless stopped` → **Deploy the container**.

---

## Deploy Produksi di Website / VPS (Node.js + Reverse Proxy Nginx)
> **Penting:** Jangan mengarahkan web root Nginx/Apache ke folder utama repositori (`/`) karena `index.html` sumber memuat `/src/main.tsx` yang akan ditolak browser dengan error MIME `application/octet-stream`. Selalu jalankan build Vite (`npm run build`) dan teruskan traffic ke server Node (`server.ts`).

```bash
npm install
npm run build
NODE_ENV=production PORT=3000 npm start
```

Contoh konfigurasi **Nginx** reverse proxy (lengkap dengan WebSocket `/ws` dan dukungan MIME `.js`/`.mjs`/`.wasm`):
```nginx
server {
  listen 80;
  server_name domain-sekolah.sch.id;

  location / {
    proxy_pass http://127.0.0.1:3000;
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

