# WA Gateway Microservice (Python + Flask + Selenium + Chromium)

Layanan internal HTTP untuk menghubungkan beberapa nomor WhatsApp pribadi (multi-akun + rotasi **Round-Robin**) melalui WhatsApp Web menggunakan **Chromium anti-deteksi** (`undetected-chromedriver` + fallback `Xvfb`), menyimpan sesi persisten di disk (`user-data-dir`), serta menyediakan REST API untuk scan QR dan pengiriman notifikasi absensi sekolah.

## Fitur Utama & Default Tertanam di Kode

- **Zero Config / Tanpa Environment Variable Manual**:
  - `DEFAULT_PORT = 8003` & `DEFAULT_MAX_CHROME = 3` tertanam langsung di `config.py`.
  - Token autentikasi internal (`X-Internal-Token`) otomatis dibangkitkan oleh `entrypoint.sh` (`openssl rand -hex 48`) ke `/app/storage/secrets/internal_token` (`chmod 600`) pada first boot dan dibaca langsung dari **file tersebut**, bukan dari env.
- **Multi-Akun & Sesi Persisten**: Setiap nomor WA memiliki profil Chrome terisolasi di `/app/storage/wa_sessions/acc_<id>/`. Setelah scan berhasil, sesi tersimpan di disk sehingga tidak perlu scan ulang saat restart.
- **Anti-Deteksi & Fallback Xvfb**: Memakai `undetected-chromedriver` + flag `--headless=new`, CDP spoofing (`navigator.webdriver`, `plugins`, `languages`), jitter viewport, serta fallback otomatis ke virtual display `Xvfb` bila headless gagal memunculkan QR.
- **QR Polling Otomatis**: Mengekstrak `<canvas>` QR WhatsApp Web secara periodik tiap 3 detik ke PNG (`/app/storage/wa_qr/<id>.png`) dan Base64 Data URL.
- **Hemat RAM (Maks 3 Chrome Aktif)**: Membatasi maksimal `3` proses Chrome aktif bersamaan (`DEFAULT_MAX_CHROME = 3`). Akun idle dimatikan proses browsernya sementara, lalu dihidupkan kembali otomatis saat mengirim pesan.
- **Anti-Blokir & Anti-Spam**:
  - Jeda manusiawi acak `3–8 detik` di dalam browser sebelum menekan Kirim.
  - Batas default `150 pesan/jam` dan `800 pesan/hari` per akun.
  - Aturan **1 pesan per nomor tujuan per 24 jam** (`HTTP 429` bila melebihi).

## Menjalankan Secara Lokal / VPS

Saat memakai aplikasi utama Absensi SMK, cukup jalankan `npm run setup:school` di root project untuk menginstal virtualenv Python, Chromium, dan file secret otomatis. Untuk menjalankan microservice ini secara manual:

```bash
cd services/wa-gateway
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/gunicorn --bind 127.0.0.1:8003 --workers 1 --threads 4 --timeout 120 app:app
```

## Menjalankan dengan Docker Standalone

```bash
docker run -d --name wa-gateway --restart unless-stopped -p 127.0.0.1:8003:8003 -v wa_storage:/app/storage absensi-wa-gateway
```

## Dokumentasi REST API

Semua endpoint (kecuali `GET /health`) wajib menyertakan header `X-Internal-Token` sesuai isi file `/app/storage/secrets/internal_token`.

### 1. Health Check
```bash
curl -s http://127.0.0.1:8003/health
```

### 2. Tambah Nomor WA Baru (Mulai Browser + Generate QR)
```bash
TOKEN=$(cat /app/storage/secrets/internal_token)
curl -X POST http://127.0.0.1:8003/accounts \
  -H "Content-Type: application/json" \
  -H "X-Internal-Token: $TOKEN" \
  -d '{"label": "WA Sekolah 1"}'
```

### 3. Ambil Status & QR Terbaru (Polling Tiap 3 Detik)
```bash
curl -s http://127.0.0.1:8003/accounts/1/qr \
  -H "X-Internal-Token: $TOKEN"
```
`qr_base64` hanya terisi saat `status == "QR_READY"`.

### 4. Daftar Akun & Detail Akun
```bash
curl -s http://127.0.0.1:8003/accounts -H "X-Internal-Token: $TOKEN"
curl -s http://127.0.0.1:8003/accounts/1 -H "X-Internal-Token: $TOKEN"
```

### 5. Reconnect / Pause / Resume / Hapus Akun
```bash
curl -X POST http://127.0.0.1:8003/accounts/1/reconnect -H "X-Internal-Token: $TOKEN"
curl -X POST http://127.0.0.1:8003/accounts/1/pause -H "X-Internal-Token: $TOKEN"
curl -X POST http://127.0.0.1:8003/accounts/1/resume -H "X-Internal-Token: $TOKEN"
curl -X DELETE http://127.0.0.1:8003/accounts/1 -H "X-Internal-Token: $TOKEN"
```

### 6. Kirim Pesan WhatsApp
```bash
curl -X POST http://127.0.0.1:8003/send \
  -H "Content-Type: application/json" \
  -H "X-Internal-Token: $TOKEN" \
  -d '{"account_id": 1, "to": "6281234567890", "message": "Info absensi siswa."}'
```

## Troubleshooting

- **QR Tidak Muncul di Mode Headless**: Pastikan paket `xvfb`, `fonts-liberation`, dan `fonts-noto-color-emoji` terpasang di OS. Service akan otomatis mencoba fallback non-headless via `Xvfb`.
- **Perubahan DOM WhatsApp Web**: Perbarui selector fallback pada `selectors.py` lalu restart service.
- **Error `Chrome binary not found`**: Instal `chromium` dan `chromium-driver` (`sudo apt-get install -y chromium chromium-driver`).
