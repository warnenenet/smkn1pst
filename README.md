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

## Publish Langsung ke Docker Hub (All-in-One Image)

### Cara A: Otomatis via GitHub Actions (Disarankan — Tanpa Build di Server)
Repositori sudah menyiapkan `.github/workflows/docker-publish.yml` untuk mem-build image `linux/amd64` (Node 22 + Vite `dist/` + InsightFace `buffalo_l` + Rust + Piper TTS + Supervisord) dan langsung mem-publish ke **Docker Hub**:

1. Buat Access Token di Docker Hub: **hub.docker.com → Account Settings → Personal Access Tokens → Generate New Token** (izin `Read & Write`).
2. Upload proyek ini ke repository GitHub Anda, lalu masuk ke **Settings → Secrets and variables → Actions → Repository secrets** dan tambahkan:
   - `DOCKERHUB_USERNAME`: username Docker Hub Anda (misal `smkpercut`)
   - `DOCKERHUB_TOKEN`: token dari langkah 1
   *(Opsional)* Di tab **Variables**, tambahkan `DOCKERHUB_REPO` jika ingin mengganti nama image (default: `absensi-smk-face-ai`).
3. Push ke branch `main` (atau klik **Actions → Build & Publish Docker Hub → Run workflow**). Image akan otomatis ter-publish sebagai:
   `<username-dockerhub>/absensi-smk-face-ai:latest`

### Cara B: Build & Push Langsung dari Terminal PC / VPS ke Docker Hub
```bash
docker login
docker build --platform linux/amd64 -t <username-dockerhub>/absensi-smk-face-ai:latest .
docker push <username-dockerhub>/absensi-smk-face-ai:latest
```

---

## Deploy Image Docker Hub di aaPanel / VPS / Portainer
Jika server memakai **aaPanel** (Nginx sudah memakai port 80), jalankan container di port `3080:80` lalu arahkan Reverse Proxy domain (misal `hadir.smkpercut.store`) ke `http://127.0.0.1:3080`:

```bash
docker run -d \
  --name absensi-smk-face-ai \
  --restart unless-stopped \
  -p 3080:80 \
  -e TZ=Asia/Jakarta \
  -v absensi_data:/app/data \
  <username-dockerhub>/absensi-smk-face-ai:latest
```

Atau gunakan file `docker-compose.yml` yang sudah tersedia:
```bash
DOCKERHUB_IMAGE=<username-dockerhub>/absensi-smk-face-ai:latest docker compose up -d
```

Di **aaPanel → Website**:
1. Buat site domain `hadir.smkpercut.store` (Static/HTML cukup, pasang SSL Let's Encrypt).
2. Buka **Site Settings → Reverse Proxy → Add Reverse Proxy** ke `http://127.0.0.1:3080`.
3. Pastikan blok statis `location ~ .*\.(js|css)?$` di config Nginx site dihapus/dikomentari agar semua aset `/assets/*.js` dan WebSocket `/ws` diteruskan ke container Docker.

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

### Khusus Deploy di **aaPanel** (Agar Tidak Terkena Error MIME `application/octet-stream`)
Error `Failed to load module script ... MIME type of "application/octet-stream"` di aaPanel terjadi bila Nginx masih membaca `index.html` mentah (yang berisi `/src/main.tsx`) atau ada blok cache statis aaPanel yang mencegat request `/assets/*.js`.

1. **Install Node.js v22 LTS** di aaPanel (**App Store → Node.js Version Manager**), karena `node server.ts` membutuhkan Node `>= 22.6` (jika terpaksa memakai Node 20, ubah command start menjadi `npx tsx server.ts`).
2. Masuk ke terminal folder proyek (misal `/www/wwwroot/hadir.smkpercut.store`) lalu jalankan:
   ```bash
   npm install
   npm run build
   ```
   Pastikan folder `dist/` dan file `dist/index.html` sudah terbentuk.
3. Di aaPanel → **Website → Node project → Add Node project**:
   - **Project dir**: `/www/wwwroot/hadir.smkpercut.store`
   - **Run opt**: `start` (atau custom: `NODE_ENV=production PORT=3000 node server.ts`)
   - **Port**: `3000`
   - Isi domain `hadir.smkpercut.store`, centang **Mapping**, lalu pasang **SSL**.
4. **Jika memakai Reverse Proxy manual pada Website Nginx aaPanel**:
   Buka **Site Settings → Config** di aaPanel dan **hapus/komentari** blok bawaan aaPanel seperti:
   ```nginx
   # location ~ .*\.(js|css)?$ { ... }
   ```
   agar seluruh request (termasuk `/assets/*.js`, `/assets/*.css`, dan WebSocket `/ws`) benar-benar masuk ke `proxy_pass http://127.0.0.1:3000;` dan tidak dilayani sebagai file mentah dari folder root.


