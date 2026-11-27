#!/usr/bin/env bash
set -Eeuo pipefail

# ==============================================================================
# Helper Setup Multi-Sekolah / Multi-Domain di 1 VPS (aaPanel / PM2 / Node.js)
#
# Otomatis memilih port kosong unik (3001, 3002, 3003, ...), membuat file .env
# terisolasi untuk folder sekolah ini, mem-build dist/ produksi, dan mencetak
# konfigurasi Reverse Proxy Nginx yang bebas konflik port maupun konflik aset JS.
# ==============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$APP_DIR"

DOMAIN=""
REQUESTED_PORT=""
START_PORT=3001
AUTO_UPDATE="auto"
AAPANEL_PROJECT=""
SKIP_BUILD=0
SCHOOL_NAME=""
ADMIN_NAME=""
ADMIN_EMAIL=""
ADMIN_PASSWORD=""

usage() {
  cat <<'EOF'
Penggunaan: bash scripts/setup-school.sh [opsi]

Opsi:
  --domain <domain>         Domain sekolah (mis. absensi.smk2.sch.id)
  --port <angka>            Paksa nomor port tertentu (default: cari port kosong mulai 3001)
  --start-port <angka>      Port awal pencarian port kosong (default: 3001)
  --school-name <nama>      Nama sekolah (opsional; bisa diisi lewat browser saat buka pertama kali)
  --admin-name <nama>       Nama lengkap Admin (opsional; jika ingin langsung buat Admin via CLI)
  --admin-email <email>     Email login Admin (opsional; jika ingin langsung buat Admin via CLI)
  --admin-password <pass>   Password Admin min. 8 karakter (opsional; jika buat Admin via CLI)
  --aapanel-name <nama>     Nama Node Project di aaPanel (untuk auto-update)
  --auto-update             Aktifkan AUTO_UPDATE_ENABLED="1" (otomatis aktif jika repo Git ada)
  --no-auto-update          Matikan auto-update GitHub otomatis
  --skip-build              Lewati npm run build
  -h, --help                Tampilkan bantuan ini
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain) DOMAIN="${2:-}"; shift 2 ;;
    --port) REQUESTED_PORT="${2:-}"; shift 2 ;;
    --start-port) START_PORT="${2:-3001}"; shift 2 ;;
    --school-name) SCHOOL_NAME="${2:-}"; shift 2 ;;
    --admin-name) ADMIN_NAME="${2:-}"; shift 2 ;;
    --admin-email) ADMIN_EMAIL="${2:-}"; shift 2 ;;
    --admin-password) ADMIN_PASSWORD="${2:-}"; shift 2 ;;
    --aapanel-name) AAPANEL_PROJECT="${2:-}"; shift 2 ;;
    --auto-update) AUTO_UPDATE=1; shift ;;
    --no-auto-update) AUTO_UPDATE=0; shift ;;
    --skip-build) SKIP_BUILD=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Opsi tidak dikenal: $1" >&2; exit 1 ;;
  esac
done

if [[ "$AUTO_UPDATE" == "auto" ]]; then
  if [[ -d "$APP_DIR/.git" ]]; then
    AUTO_UPDATE=1
  else
    AUTO_UPDATE=0
  fi
fi

command -v node >/dev/null 2>&1 || { echo "ERROR: Node.js tidak ditemukan. Install Node.js 22 LTS atau 24 LTS terlebih dahulu." >&2; exit 1; }

NODE_MAJOR="$(node -e 'process.stdout.write(String(process.versions.node.split(".")[0]))')"
NODE_MINOR="$(node -e 'process.stdout.write(String(process.versions.node.split(".")[1]))')"
if [[ "$NODE_MAJOR" -lt 22 ]] || [[ "$NODE_MAJOR" -eq 22 && "$NODE_MINOR" -lt 18 ]]; then
  echo "ERROR: Node.js v$(node -v) terlalu lama. Aplikasi ini membutuhkan Node.js >= v22.18 (atau v24 LTS) untuk node:sqlite & native TypeScript." >&2
  exit 1
fi

is_port_free() {
  local p="$1"
  node -e '
    const net = require("net");
    const port = Number(process.argv[1]);
    const s = net.createServer();
    s.once("error", () => process.exit(1));
    s.listen(port, "127.0.0.1", () => {
      s.close(() => process.exit(0));
    });
  ' "$p" >/dev/null 2>&1
}

is_port_claimed_in_siblings() {
  local p="$1"
  local var_name="${2:-PORT}"
  local parent_dir
  parent_dir="$(dirname "$APP_DIR")"
  for env_f in "$parent_dir"/*/.env; do
    [[ -f "$env_f" ]] || continue
    [[ "$env_f" == "$APP_DIR/.env" ]] && continue
    if grep -Eq "^[[:space:]]*${var_name}=[\"']?${p}[\"']?[[:space:]]*$" "$env_f" 2>/dev/null; then
      return 0
    fi
  done
  return 1
}

CHOSEN_PORT=""
if [[ -n "$REQUESTED_PORT" ]]; then
  CHOSEN_PORT="$REQUESTED_PORT"
elif [[ -f "$APP_DIR/.env" ]] && grep -Eq "^[[:space:]]*PORT=[\"']?[0-9]+[\"']?" "$APP_DIR/.env"; then
  EXISTING_PORT="$(grep -E "^[[:space:]]*PORT=" "$APP_DIR/.env" | head -n 1 | sed -E 's/^PORT=["'\'']?([0-9]+)["'\'']?.*/\1/')"
  if [[ -n "$EXISTING_PORT" ]]; then
    CHOSEN_PORT="$EXISTING_PORT"
  fi
fi

if [[ -z "$CHOSEN_PORT" ]]; then
  for p in $(seq "$START_PORT" 3999); do
    if ! is_port_claimed_in_siblings "$p" "PORT" && is_port_free "$p"; then
      CHOSEN_PORT="$p"
      break
    fi
  done
fi

[[ -n "$CHOSEN_PORT" ]] || { echo "ERROR: Tidak menemukan port kosong di rentang ${START_PORT}..3999." >&2; exit 1; }

CHOSEN_FACE_PORT=""
if [[ -f "$APP_DIR/.env" ]] && grep -Eq "^[[:space:]]*FACE_PORT=[\"']?[0-9]+[\"']?" "$APP_DIR/.env"; then
  EXISTING_FACE_PORT="$(grep -E "^[[:space:]]*FACE_PORT=" "$APP_DIR/.env" | head -n 1 | sed -E 's/^FACE_PORT=["'\'']?([0-9]+)["'\'']?.*/\1/')"
  if [[ -n "$EXISTING_FACE_PORT" ]]; then
    CHOSEN_FACE_PORT="$EXISTING_FACE_PORT"
  fi
fi

if [[ -z "$CHOSEN_FACE_PORT" ]]; then
  for p in $(seq 8001 8099); do
    if ! is_port_claimed_in_siblings "$p" "FACE_PORT" && is_port_free "$p"; then
      CHOSEN_FACE_PORT="$p"
      break
    fi
  done
fi
[[ -n "$CHOSEN_FACE_PORT" ]] || CHOSEN_FACE_PORT=8001

TARGET_OWNER=""
if [[ "$(id -u)" -eq 0 ]]; then
  if [[ -d "/www/server" ]] && id -u www >/dev/null 2>&1; then
    TARGET_OWNER="www:www"
  else
    PKG_OWNER="$(stat -c '%U:%G' "$APP_DIR/package.json" 2>/dev/null || echo 'root:root')"
    if [[ "$PKG_OWNER" != "root:root" && "$PKG_OWNER" != ":" ]]; then
      TARGET_OWNER="$PKG_OWNER"
    fi
  fi
fi

FACE_UID="$(id -u)"
FACE_GID="$(id -g)"
if [[ "$TARGET_OWNER" == "www:www" ]] && id -u www >/dev/null 2>&1; then
  FACE_UID="$(id -u www)"
  FACE_GID="$(id -g www)"
elif [[ -n "$TARGET_OWNER" ]]; then
  OWNER_USER="${TARGET_OWNER%%:*}"
  if id -u "$OWNER_USER" >/dev/null 2>&1; then
    FACE_UID="$(id -u "$OWNER_USER")"
    FACE_GID="$(id -g "$OWNER_USER")"
  fi
fi

SECRETS_DIR="$APP_DIR/data/secrets"
TOKEN_FILE="$SECRETS_DIR/internal_token"
mkdir -p "$SECRETS_DIR"
chmod 700 "$SECRETS_DIR" 2>/dev/null || true
if [[ ! -s "$TOKEN_FILE" ]]; then
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 48 > "$TOKEN_FILE"
  else
    node -e 'process.stdout.write(require("crypto").randomBytes(48).toString("hex") + "\n")' > "$TOKEN_FILE"
  fi
fi
chmod 600 "$TOKEN_FILE" 2>/dev/null || true

upsert_env() {
  local key="$1"
  local val="$2"
  local file="$APP_DIR/.env"
  touch "$file"
  if grep -Eq "^[[:space:]]*${key}=" "$file"; then
    node -e '
      const fs = require("fs");
      const [file, key, val] = process.argv.slice(1);
      const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
      let replaced = false;
      const out = lines.map((l) => {
        if (!replaced && new RegExp("^\\s*" + key + "=").test(l)) {
          replaced = true;
          return `${key}="${val}"`;
        }
        return l;
      });
      fs.writeFileSync(file, out.join("\n"));
    ' "$file" "$key" "$val"
  else
    printf '%s="%s"\n' "$key" "$val" >> "$file"
  fi
}

remove_env_key() {
  local key="$1"
  local file="$APP_DIR/.env"
  [[ -f "$file" ]] || return 0
  node -e '
    const fs = require("fs");
    const [file, key] = process.argv.slice(1);
    const re = new RegExp("^\\s*" + key + "=");
    const lines = fs.readFileSync(file, "utf8").split(/\r?\n/).filter((l) => !re.test(l));
    fs.writeFileSync(file, lines.join("\n").replace(/\n*$/, "\n"));
  ' "$file" "$key"
}

remove_env_key "NODE_WASM_LIVE"
upsert_env "NODE_ENV" "production"
upsert_env "TZ" "Asia/Jakarta"
upsert_env "PORT" "$CHOSEN_PORT"
upsert_env "HOST" "127.0.0.1"
upsert_env "DATA_DIR" "./data"
upsert_env "FACE_PORT" "$CHOSEN_FACE_PORT"
upsert_env "FACE_SERVICE_URL" "http://127.0.0.1:${CHOSEN_FACE_PORT}"
upsert_env "WEB_BACKEND_URL" "http://127.0.0.1:${CHOSEN_PORT}"
upsert_env "COMPOSE_PROJECT_NAME" "absensi_${CHOSEN_PORT}"
upsert_env "FACE_UID" "$FACE_UID"
upsert_env "FACE_GID" "$FACE_GID"
if [[ -n "$DOMAIN" ]]; then
  upsert_env "APP_URL" "https://${DOMAIN}"
fi
if [[ "$AUTO_UPDATE" -eq 1 ]]; then
  upsert_env "AUTO_UPDATE_ENABLED" "1"
  upsert_env "AUTO_UPDATE_INTERVAL_MINUTES" "60"
  upsert_env "UPDATE_ONLY_NEW_VERSION" "1"
else
  upsert_env "AUTO_UPDATE_ENABLED" "0"
fi
if [[ -n "$AAPANEL_PROJECT" ]]; then
  upsert_env "AAPANEL_PROJECT_NAME" "$AAPANEL_PROJECT"
fi
chmod 600 "$APP_DIR/.env" 2>/dev/null || true

fix_binary_permissions() {
  shopt -s nullglob
  local targets=(
    "$APP_DIR"/node_modules/.bin/*
    "$APP_DIR"/node_modules/@ffmpeg-installer/*/ffmpeg*
    "$APP_DIR"/node_modules/@ffprobe-installer/*/ffprobe*
    "$APP_DIR"/node_modules/@esbuild/*/bin/*
    "$APP_DIR"/node_modules/esbuild/bin/*
    "$APP_DIR"/scripts/*.sh
  )
  shopt -u nullglob
  for bin_path in "${targets[@]}"; do
    [[ -f "$bin_path" ]] && chmod +x "$bin_path" 2>/dev/null || true
  done
}

mkdir -p "$APP_DIR/data/snapshots" "$APP_DIR/data/tts_cache" "$APP_DIR/data/secrets" "$APP_DIR/data/wa_gateway/wa_sessions" "$APP_DIR/data/wa_gateway/wa_qr" "$APP_DIR/data/backups" "$APP_DIR/storage/debug"
chmod 700 "$APP_DIR/data" "$APP_DIR/data/secrets" 2>/dev/null || true

if [[ "$SKIP_BUILD" -eq 0 ]]; then
  if [[ ! -f "$APP_DIR/node_modules/ws/lib/stream.js" ]] || [[ ! -f "$APP_DIR/node_modules/express/package.json" ]] || [[ ! -f "$APP_DIR/node_modules/vite/package.json" ]] || [[ ! -f "$APP_DIR/node_modules/@ffmpeg-installer/ffmpeg/package.json" ]]; then
    echo "[setup-school] node_modules belum lengkap/rusak; menjalankan npm install..."
    rm -rf "$APP_DIR/node_modules/ws" 2>/dev/null || true
    npm install --no-audit --no-fund
  fi
  fix_binary_permissions
  echo "[setup-school] Membangun bundle produksi Vite (dist/)..."
  npm run build
else
  fix_binary_permissions
fi

# Cek apakah binary FFmpeg benar-benar dapat dieksekusi (anti-EACCES / noexec)
verify_ffmpeg_runtime() {
  node --input-type=module -e '
    import { execFileSync } from "node:child_process";
    import { resolveFfmpegDetails } from "./src/server/nodeFaceWorker.ts";
    const res = resolveFfmpegDetails();
    if (!res.foundExecutable) process.exit(2);
    execFileSync(res.binary, ["-version"], { stdio: "ignore", timeout: 5000 });
  ' >/dev/null 2>&1
}

if ! verify_ffmpeg_runtime; then
  echo "[setup-school] PERINGATAN: FFmpeg bawaan belum dapat dieksekusi (misal partisi noexec)."
  if [[ "$(id -u)" -eq 0 ]]; then
    if command -v apt-get >/dev/null 2>&1; then
      echo "[setup-school] Menginstal ffmpeg sistem via apt-get (sebagai root)..."
      DEBIAN_FRONTEND=noninteractive apt-get update -qq && apt-get install -y -qq ffmpeg || true
    elif command -v dnf >/dev/null 2>&1; then
      echo "[setup-school] Menginstal ffmpeg sistem via dnf..."
      dnf install -y -q ffmpeg || true
    elif command -v yum >/dev/null 2>&1; then
      echo "[setup-school] Menginstal ffmpeg sistem via yum..."
      yum install -y -q ffmpeg || true
    fi
  else
    echo "[setup-school] Jalankan sebagai root bila perlu FFmpeg sistem: sudo apt install -y ffmpeg"
  fi
fi

# Setup Python + Chromium Headless WA Gateway Service (otomatis dalam satu setup)
WA_GATEWAY_DIR="$APP_DIR/services/wa-gateway"
WA_GATEWAY_READY="TIDAK_AKTIF"
if [[ -d "$WA_GATEWAY_DIR" && -f "$WA_GATEWAY_DIR/requirements.txt" ]]; then
  echo "[setup-school] Menyiapkan Python WA Gateway (Chromium + Selenium anti-deteksi)..."
  HAS_CHROME=0
  if command -v chromium >/dev/null 2>&1 || command -v chromium-browser >/dev/null 2>&1 || command -v google-chrome >/dev/null 2>&1; then
    HAS_CHROME=1
  fi
  if [[ "$HAS_CHROME" -eq 0 ]] || ! command -v python3 >/dev/null 2>&1 || ! python3 -m venv --help >/dev/null 2>&1; then
    if [[ "$(id -u)" -eq 0 ]]; then
      if command -v apt-get >/dev/null 2>&1; then
        echo "[setup-school] Menginstal Python3 venv, Chromium, Chromedriver, Xvfb & fonts..."
        DEBIAN_FRONTEND=noninteractive apt-get update -qq || true
        DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
          python3 python3-venv python3-pip \
          chromium chromium-driver xvfb \
          fonts-liberation fonts-noto-color-emoji || \
        DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
          python3 python3-venv python3-pip \
          chromium-browser chromium-chromedriver xvfb \
          fonts-liberation fonts-noto-color-emoji || true
      elif command -v dnf >/dev/null 2>&1; then
        dnf install -y -q python3 chromium chromedriver xorg-x11-server-Xvfb liberation-fonts google-noto-emoji-color-fonts || true
      fi
    else
      echo "[setup-school] PERINGATAN: Chromium / python3-venv belum lengkap. Jalankan sebagai root:"
      echo "  sudo apt-get update && sudo apt-get install -y python3-venv chromium chromium-driver xvfb fonts-liberation fonts-noto-color-emoji"
    fi
  fi

  if command -v python3 >/dev/null 2>&1 && python3 -m venv --help >/dev/null 2>&1; then
    if [[ ! -x "$WA_GATEWAY_DIR/.venv/bin/pip" ]]; then
      python3 -m venv "$WA_GATEWAY_DIR/.venv" || true
    fi
    if [[ -x "$WA_GATEWAY_DIR/.venv/bin/pip" ]]; then
      "$WA_GATEWAY_DIR/.venv/bin/pip" install --quiet --upgrade pip || true
      if "$WA_GATEWAY_DIR/.venv/bin/pip" install --quiet -r "$WA_GATEWAY_DIR/requirements.txt"; then
        WA_GATEWAY_READY="SIAP (port 8003)"
      else
        echo "[setup-school] PERINGATAN: Gagal memasang Python packages WA Gateway; cek koneksi pip."
      fi
    fi
  fi
fi

# Inisialisasi SQLite & status Setup Awal
echo "[setup-school] Memverifikasi kesiapan modul Node, FFmpeg & status Admin..."
ADMIN_CHECK_STATUS="$(
  SETUP_CLI_SCHOOL="$SCHOOL_NAME" \
  SETUP_CLI_NAME="$ADMIN_NAME" \
  SETUP_CLI_EMAIL="$ADMIN_EMAIL" \
  SETUP_CLI_PASSWORD="$ADMIN_PASSWORD" \
  node --input-type=module -e '
    import { execFileSync } from "node:child_process";
    import { loadDb, saveDb, hashPassword } from "./src/server/store.ts";
    import { hasActiveAdminUser, isStrongSetupPassword } from "./src/lib/security.ts";
    import { resolveFfmpegDetails } from "./src/server/nodeFaceWorker.ts";

    const db = loadDb();
    const ff = resolveFfmpegDetails();
    if (!ff.foundExecutable) {
      console.error("[setup-school] ERROR: FFmpeg belum siap dieksekusi:", ff.nonExecutablePaths);
      process.exit(1);
    }
    execFileSync(ff.binary, ["-version"], { stdio: "ignore", timeout: 5000 });

    const cliSchool = (process.env.SETUP_CLI_SCHOOL || "").trim();
    if (cliSchool.length >= 3) {
      db.settings.school_name = cliSchool;
    }

    const cliEmail = (process.env.SETUP_CLI_EMAIL || "").trim().toLowerCase();
    const cliPassword = process.env.SETUP_CLI_PASSWORD || "";
    const cliName = (process.env.SETUP_CLI_NAME || "Administrator Sekolah").trim();

    if (!hasActiveAdminUser(db.users) && cliEmail && cliPassword) {
      const check = isStrongSetupPassword(cliPassword);
      if (!check.valid) {
        console.error("[setup-school] ERROR Password Admin CLI:", check.reason);
        process.exit(1);
      }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cliEmail)) {
        console.error("[setup-school] ERROR Email Admin CLI tidak valid:", cliEmail);
        process.exit(1);
      }
      db.users.push({
        id: db.users.length === 0 ? 1 : Math.max(...db.users.map((u) => u.id)) + 1,
        name: cliName,
        email: cliEmail,
        role: "ADMIN",
        is_active: true,
        password_hash: hashPassword(cliPassword),
      });
      db.settings.production_mode = true;
      saveDb(db);
      console.log("[setup-school] OK: Admin dibuat via CLI & halaman setup otomatis dikunci:", cliEmail);
    } else if (cliSchool.length >= 3) {
      saveDb(db);
    }

    const hasAdmin = hasActiveAdminUser(loadDb().users);
    process.stdout.write(hasAdmin ? "HAS_ADMIN\n" : "NEEDS_SETUP\n");
  ' | tail -n 1
)"

if [[ -n "$TARGET_OWNER" ]]; then
  echo "[setup-school] Menyelaraskan owner file ke ${TARGET_OWNER}..."
  chown -R "$TARGET_OWNER" "$APP_DIR"
  chmod 600 "$APP_DIR/.env" "$TOKEN_FILE" 2>/dev/null || true
  chmod 700 "$APP_DIR/data" "$APP_DIR/data/secrets" 2>/dev/null || true
  OWNER_USER_ONLY="${TARGET_OWNER%%:*}"
  if getent group docker >/dev/null 2>&1 && id -u "$OWNER_USER_ONLY" >/dev/null 2>&1; then
    usermod -aG docker "$OWNER_USER_ONLY" 2>/dev/null || true
  fi
fi

# Setup Docker Face AI Service (All-in-One Pure Rust face-engine atau legacy)
FACE_AI_READY="TIDAK_AKTIF"
if [[ -f "$APP_DIR/docker-compose.yml" ]] && command -v docker >/dev/null 2>&1; then
  echo "[setup-school] Terdeteksi konfigurasi Docker All-in-One (Rust face-engine + Node.js + Baileys WA)."
  echo "[setup-school] Untuk menyalakan 100% di dalam Docker All-in-One, jalankan: npm run setup:docker"
  FACE_AI_READY="SIAP_DIJALANKAN (jalankan: npm run setup:docker)"
elif [[ -f "$APP_DIR/docker-compose.face.yml" ]] && command -v docker >/dev/null 2>&1; then
  if ! docker info >/dev/null 2>&1 && [[ "$(id -u)" -eq 0 ]]; then
    systemctl start docker >/dev/null 2>&1 || service docker start >/dev/null 2>&1 || true
    sleep 2
  fi
  COMPOSE_CMD=""
  if docker compose version >/dev/null 2>&1; then
    COMPOSE_CMD="docker compose"
  elif command -v docker-compose >/dev/null 2>&1; then
    COMPOSE_CMD="docker-compose"
  fi

  if [[ -z "$COMPOSE_CMD" ]]; then
    FACE_AI_READY="BELUM_AKTIF (docker compose plugin belum terpasang)"
    echo "[setup-school] PERINGATAN: Docker ditemukan tetapi plugin 'docker compose' belum terpasang."
  elif ! docker info >/dev/null 2>&1; then
    FACE_AI_READY="BELUM_AKTIF (Docker daemon mati atau butuh akses root/grup docker)"
    echo "[setup-school] PERINGATAN: Docker daemon tidak dapat diakses saat ini."
  else
    echo "[setup-school] Membangun & menyalakan Docker Face AI..."
    if $COMPOSE_CMD -f "$APP_DIR/docker-compose.face.yml" up -d --build; then
      FACE_AI_READY="SIAP (Docker port ${CHOSEN_FACE_PORT})"
    else
      FACE_AI_READY="GAGAL_BUILD"
    fi
  fi
fi

DOMAIN_LABEL="${DOMAIN:-domain-sekolah-anda.sch.id}"
echo ""
echo "========================================================================"
echo " SETUP SEKOLAH SELESAI — SIAP DIJALANKAN"
echo "========================================================================"
echo " Folder Project : $APP_DIR"
echo " Port Terpilih  : $CHOSEN_PORT (tersimpan di .env, bind 127.0.0.1)"
echo " Face AI (Docker): ${FACE_AI_READY}"
echo " WA Gateway     : ${WA_GATEWAY_READY} (auto-start bersama Node server)"
echo " Folder Data DB : $APP_DIR/data/absensi.sqlite"
echo " Password Default: TIDAK ADA (aman dari login bawaan)"
echo ""
if [[ "$ADMIN_CHECK_STATUS" == "NEEDS_SETUP" ]]; then
  echo " 1) SETUP AWAL ALA WORDPRESS (SUPER MUDAH):"
  echo "    Setelah server berjalan, langsung buka di browser:"
  echo "      https://${DOMAIN_LABEL}/"
  echo "    Isi Nama Sekolah, Email & Password Admin Anda -> selesai & otomatis terkunci."
  echo ""
else
  echo " 1) STATUS ADMIN : Akun Administrator aktif & halaman setup sudah terkunci."
  echo ""
fi
echo " 2) Cara Menjalankan Server (User Non-Root www / PM2):"
echo "    - aaPanel Node Project: Project dir=$APP_DIR | Run opt=start | Port=$CHOSEN_PORT | User=www"
echo "      Isi Domain ($DOMAIN_LABEL) dan aktifkan Mapping (aaPanel otomatis buat config Nginx, JANGAN edit manual)."
echo "    - Atau PM2 (VPS tanpa aaPanel): pm2 start npm --name \"absensi-${CHOSEN_PORT}\" -- start"
echo ""
echo " 3) Jika TIDAK pakai aaPanel Mapping (mis. PM2/systemd/Docker), pakai Reverse Proxy ke 127.0.0.1:${CHOSEN_PORT}:"
echo "    location / { proxy_pass http://127.0.0.1:${CHOSEN_PORT}; proxy_http_version 1.1; proxy_set_header Host \$host; proxy_set_header Upgrade \$http_upgrade; proxy_set_header Connection \"upgrade\"; }"
echo ""
echo " 4) Verifikasi Server Hidup:"
echo "    curl -s http://127.0.0.1:${CHOSEN_PORT}/api/health"
echo "========================================================================"
