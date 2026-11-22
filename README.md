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

### Khusus Deploy di **aaPanel** (Anti-Error 404 `env.mjs` / `react_jsx-dev-runtime.js` & MIME `application/octet-stream`)
Error `404` pada `/node_modules/.vite/deps/react_jsx-dev-runtime.js` & `env.mjs` (atau error MIME `application/octet-stream`) terjadi bila Node Project dijalankan memakai **`dev`** (`tsx server.ts`) alih-alih **`start`**, atau ada blok statis Nginx aaPanel yang mencegat file `.js`/`.css`.

1. **Install Node.js v22 LTS** di aaPanel (**App Store → Node.js Version Manager**).
2. Masuk ke terminal folder proyek (misal `/www/wwwroot/absensi.smkpercut.store`) lalu jalankan 1 perintah setup otomatis:
   ```bash
   npm install
   npm run setup:school -- --domain absensi.smkpercut.store
   ```
   Script otomatis memilih port kosong unik (`3001`, `3002`, `3003`, dst.), membuat `.env` terisolasi, mengisolasi `DATA_DIR=./data`, mem-build folder `dist/`, dan mencetak config Nginx Reverse Proxy siap tempel.
3. Di aaPanel → **Website → Node project → Add Node project**:
   - **Project dir**: folder sekolah (misal `/www/wwwroot/absensi.smkpercut.store`)
   - **Run opt**: **`start`** *(PENTING: jangan pilih `dev`!)*
   - **Port**: masukkan port unik dari `.env` (misal `3001` untuk sekolah ke-1, `3002` untuk sekolah ke-2, dst.)
   - Isi domain sekolah, centang **Mapping**, lalu pasang **SSL**.
4. **Jika memakai Reverse Proxy manual pada Website Nginx aaPanel**:
   Buka **Site Settings → Config** di aaPanel dan **hapus/komentari** blok bawaan aaPanel seperti:
   ```nginx
   # location ~ .*\.(js|css)?$ { ... }
   ```
   agar seluruh request (termasuk `/assets/*.js`, `/assets/*.css`, dan WebSocket `/ws`) benar-benar masuk ke `proxy_pass http://127.0.0.1:3001;` (sesuai `PORT` sekolah tersebut).

### Deploy Banyak Domain / Banyak Sekolah di 1 Server (Tanpa Konflik Port 3000)
Setiap folder sekolah terisolasi penuh (`PORT`, `.env`, `DATA_DIR=./data/absensi.sqlite`, `wa_auth/`, dan `snapshots/`):
- **Mode aaPanel / Node.js**:
  - Sekolah 1 (`/www/wwwroot/smk1.sch.id`): `npm run setup:school -- --domain smk1.sch.id` → otomatis mendapat `PORT=3001` → Reverse Proxy ke `127.0.0.1:3001`
  - Sekolah 2 (`/www/wwwroot/smk2.sch.id`): `npm run setup:school -- --domain smk2.sch.id` → otomatis mendapat `PORT=3002` → Reverse Proxy ke `127.0.0.1:3002`
  - Sekolah 3 (`/www/wwwroot/smk3.sch.id`): `npm run setup:school -- --domain smk3.sch.id` → otomatis mendapat `PORT=3003` → Reverse Proxy ke `127.0.0.1:3003`
- **Mode Docker Compose**:
  Salin `docker-compose.yml` ke folder per sekolah dan isi `.env` masing-masing:
  ```env
  CONTAINER_NAME="absensi-smk2"
  HOST_PORT="3082"
  DATA_PATH="./data"
  APP_URL="https://smk2.sch.id"
  ```
  Lalu jalankan `docker compose up -d` dan arahkan Reverse Proxy domain ke `http://127.0.0.1:3082`.

---

## Auto-Update Otomatis dari GitHub (1 Jam Sekali & Universal aaPanel / Node.js)

Repositori menyediakan `scripts/auto-update.sh` dan workflow `.github/workflows/deploy-nodejs.yml` yang dirancang **universal** untuk project Node.js di **aaPanel Node Project, PM2, systemd, Supervisor, maupun Docker Compose**.

Keamanan & fitur bawaan script:
- **Database SQLite & `.env` aman**: File di `data/` (seperti `data/absensi.sqlite`, `wa_auth/`, `snapshots/`) dan `.env` tidak di-track Git sehingga tidak tertimpa `git pull`. Sebelum menarik commit baru, script juga otomatis membuat cadangan di `data/backups/pre-update-*.bak` (maksimal 5 file terbaru).
- **Build sebelum restart**: `npm install` (hanya jika `package.json`/lockfile berubah) dan `npm run build` dijalankan sebelum service di-restart. Jika build gagal, aplikasi live tidak ikut mati.
- **Anti `Permission denied` di aaPanel**: Otomatis menjalankan `chmod +x node_modules/.bin/*` dan `chown -R www:www` bila dieksekusi sebagai `root`.
- **Auto-deteksi universal**: Otomatis mendeteksi `npm`/`pnpm`/`yarn`/`bun`, script `build` di `package.json`, dan process manager (`RESTART_CMD` → aaPanel vhost script/Supervisor → PM2 → `systemd` → sinyal PID).

### Opsi A: Otomatis 1 Jam Sekali via Cron Linux / aaPanel Cron (Disarankan)
1. **Lewat terminal proyek (1 perintah saja)**:
   ```bash
   cd /www/wwwroot/smkn1pst
   npm run update:cron
   ```
   Perintah ini memasang cron `0 * * * *` (**setiap 1 jam sekali** tepat di menit ke-0) dan menulis log ke `data/auto-update.log`.
   Untuk menghapus atau mengecek status cron:
   ```bash
   bash scripts/auto-update.sh --status
   bash scripts/auto-update.sh --uninstall-cron
   ```
2. **Atau lewat Panel aaPanel → Menu Cron**:
   - **Type of Task**: `Shell Script`
   - **Name**: `Auto Update Absensi SMK (1 Jam)`
   - **Execution Cycle**: `Every Hour` (`1 Hour`, Minute `0`)
   - **Script content**:
     ```bash
     bash /www/wwwroot/smkn1pst/scripts/auto-update.sh
     ```

### Opsi B: Otomatis 1 Jam Sekali dari Dalam Aplikasi (`.env`)
Jika server tidak memakai akses `crontab`, tambahkan di file `.env` pada root proyek (`server.ts` sudah memuat `.env` otomatis saat start):
```env
AUTO_UPDATE_ENABLED="1"
AUTO_UPDATE_INTERVAL_MINUTES="60"
AAPANEL_PROJECT_NAME="absen"
```
Lalu restart Node Project sekali saja. Setelah itu, aplikasi akan memeriksa GitHub setiap **60 menit (1 jam)** dan menjalankan `scripts/auto-update.sh` bila ada commit baru.

### Opsi C: Auto-Update Instan saat `git push` via aaPanel Git Manager / Webhook
Pada **aaPanel → Website → Node Project → Site modification → Git Manager** (atau **Webhook**), tempel skrip eksekusi berikut:
```bash
bash /www/wwwroot/smkn1pst/scripts/auto-update.sh
```

### Opsi D: Auto-Deploy Otomatis saat `git push` via GitHub Actions (SSH)
Workflow `.github/workflows/deploy-nodejs.yml` otomatis mengecek build/lint/test lalu masuk ke VPS via SSH untuk menjalankan `scripts/auto-update.sh --force`.
Tambahkan di **Repository Settings → Secrets and variables → Actions**:
- **Secrets**: `VPS_HOST` (IP/domain VPS), `VPS_USER` (mis. `root`), `VPS_SSH_KEY` (private key SSH), (opsional) `VPS_PORT` (default `22`).
- **Variables**: `VPS_APP_DIR` (mis. `/www/wwwroot/smkn1pst`), (opsional) `APP_MANAGER` (`auto` / `aapanel` / `pm2` / `systemd` / `docker`), `AAPANEL_PROJECT_NAME` (`absen`), `PM2_APP_NAME`, `SYSTEMD_SERVICE`, `RESTART_CMD`.

### Menjadikan Folder Upload ZIP Tersambung ke GitHub (Tanpa Menghapus `data/` & `.env`)
Jika folder di aaPanel awalnya di-upload via ZIP/FTP (belum ada `.git`), jalankan sekali di terminal proyek:
```bash
cd /www/wwwroot/smkn1pst
cp -a data data_cadangan_aman
git init -b main
git remote add origin https://github.com/<username>/<repo>.git
git fetch origin
git reset --mixed origin/main
git checkout -- .
chown -R www:www /www/wwwroot/smkn1pst
```
Setelah tersambung, cek dry-run:
```bash
npm run update:check
```

### Memakai `scripts/auto-update.sh` untuk Project Node.js / aaPanel Lainnya
Salin file `scripts/auto-update.sh` ke folder `scripts/` pada project Node.js lain (Express, Next.js, NestJS, Vite, Astro, Fastify, dll.). Script akan otomatis membaca `.env` project tersebut dan menyesuaikan:
- `PORT` & `HEALTH_URL` (mis. `HEALTH_URL="http://127.0.0.1:4000/"` atau `HEALTH_PATH="/"` bila project lain tidak memiliki `/api/health`)
- `PKG_MANAGER=auto` (`npm`, `pnpm`, `yarn`, `bun`)
- `BUILD_SCRIPT=auto` (otomatis melewati build jika `package.json` tidak punya script `build`, atau bisa diisi nama script kustom)
- `APP_MANAGER=auto` (`aapanel`, `pm2`, `systemd`, `supervisor`, `docker`, atau `RESTART_CMD="..."`)

