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
AUTO_UPDATE=0
AAPANEL_PROJECT=""
SKIP_BUILD=0

usage() {
  cat <<'EOF'
Penggunaan: bash scripts/setup-school.sh [opsi]

Opsi:
  --domain <domain>       Domain sekolah (mis. absensi.smk2.sch.id)
  --port <angka>          Paksa nomor port tertentu (default: cari port kosong mulai 3001)
  --start-port <angka>    Port awal pencarian port kosong (default: 3001)
  --aapanel-name <nama>   Nama Node Project di aaPanel (untuk auto-update)
  --auto-update           Aktifkan AUTO_UPDATE_ENABLED="1" (tiap 60 menit)
  --skip-build            Lewati npm run build
  -h, --help              Tampilkan bantuan ini
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain) DOMAIN="${2:-}"; shift 2 ;;
    --port) REQUESTED_PORT="${2:-}"; shift 2 ;;
    --start-port) START_PORT="${2:-3001}"; shift 2 ;;
    --aapanel-name) AAPANEL_PROJECT="${2:-}"; shift 2 ;;
    --auto-update) AUTO_UPDATE=1; shift ;;
    --skip-build) SKIP_BUILD=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Opsi tidak dikenal: $1" >&2; exit 1 ;;
  esac
done

command -v node >/dev/null 2>&1 || { echo "ERROR: Node.js tidak ditemukan." >&2; exit 1; }

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
  local parent_dir
  parent_dir="$(dirname "$APP_DIR")"
  for env_f in "$parent_dir"/*/.env; do
    [[ -f "$env_f" ]] || continue
    [[ "$env_f" == "$APP_DIR/.env" ]] && continue
    if grep -Eq "^[[:space:]]*PORT=[\"']?${p}[\"']?[[:space:]]*$" "$env_f" 2>/dev/null; then
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
    if ! is_port_claimed_in_siblings "$p" && is_port_free "$p"; then
      CHOSEN_PORT="$p"
      break
    fi
  done
fi

[[ -n "$CHOSEN_PORT" ]] || { echo "ERROR: Tidak menemukan port kosong di rentang ${START_PORT}..3999." >&2; exit 1; }

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

upsert_env "NODE_ENV" "production"
upsert_env "TZ" "Asia/Jakarta"
upsert_env "PORT" "$CHOSEN_PORT"
upsert_env "HOST" "127.0.0.1"
upsert_env "DATA_DIR" "./data"
upsert_env "NODE_WASM_LIVE" "1"
if [[ -n "$DOMAIN" ]]; then
  upsert_env "APP_URL" "https://${DOMAIN}"
fi
if [[ "$AUTO_UPDATE" -eq 1 ]]; then
  upsert_env "AUTO_UPDATE_ENABLED" "1"
  upsert_env "AUTO_UPDATE_INTERVAL_MINUTES" "60"
fi
if [[ -n "$AAPANEL_PROJECT" ]]; then
  upsert_env "AAPANEL_PROJECT_NAME" "$AAPANEL_PROJECT"
fi

if [[ -d "$APP_DIR/node_modules/.bin" ]]; then
  chmod +x "$APP_DIR"/node_modules/.bin/* 2>/dev/null || true
fi

if [[ "$SKIP_BUILD" -eq 0 ]]; then
  echo "[setup-school] Membangun bundle produksi Vite (dist/)..."
  npm run build
fi

if [[ "$(id -u)" -eq 0 ]] && [[ -d "/www/server" ]] && id -u www >/dev/null 2>&1; then
  chown -R www:www "$APP_DIR"
fi

DOMAIN_LABEL="${DOMAIN:-domain-sekolah-anda.sch.id}"
echo ""
echo "========================================================================"
echo " SETUP SEKOLAH SELESAI — TERISOLASI & BEBAS KONFLIK PORT"
echo "========================================================================"
echo " Folder Project : $APP_DIR"
echo " Port Terpilih  : $CHOSEN_PORT (tersimpan di $APP_DIR/.env)"
echo " Folder Data DB : $APP_DIR/data/absensi.sqlite"
echo ""
echo " 1) Pengaturan aaPanel -> Node Project:"
echo "    - Project dir : $APP_DIR"
echo "    - Run opt     : start   (PENTING: JANGAN pilih 'dev'!)"
echo "    - Port        : $CHOSEN_PORT"
echo "    - User        : www"
echo ""
echo " 2) Pengaturan Nginx Reverse Proxy ($DOMAIN_LABEL):"
echo "    (Hapus/komentari blok 'location ~ .*\\.(js|css)?$' di Config Nginx!)"
echo "    location / {"
echo "      proxy_pass http://127.0.0.1:${CHOSEN_PORT};"
echo "      proxy_http_version 1.1;"
echo "      proxy_set_header Host \$host;"
echo "      proxy_set_header X-Real-IP \$remote_addr;"
echo "      proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;"
echo "      proxy_set_header X-Forwarded-Proto \$scheme;"
echo "      proxy_set_header Upgrade \$http_upgrade;"
echo "      proxy_set_header Connection \"upgrade\";"
echo "    }"
echo "========================================================================"
