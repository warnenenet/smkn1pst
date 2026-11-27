#!/usr/bin/env bash
set -Eeuo pipefail

# ==============================================================================
# Setup 100% All-in-One Docker (Rust face-engine + Node.js + Baileys WA + Piper)
# Seluruh proses berjalan di dalam 1 container Docker dengan s6-overlay PID 1.
# Juga menyediakan --cleanup-host untuk membersihkan proses lama di host VPS
# (mis. /opt/mediamtx, ffmpeg testsrc, /var/www/face_engine/face_engine.py).
# ==============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$APP_DIR"

HOST_PORT="${HOST_PORT:-3080}"
CLEANUP_HOST=0
DRY_RUN=0
SKIP_BUILD=0

usage() {
  cat <<'EOF'
Penggunaan: bash scripts/setup-docker-allinone.sh [opsi]

Opsi:
  --port <angka>     Port host untuk container All-in-One (default: 3080)
  --cleanup-host     Deteksi & hentikan proses lama di HOST (mediamtx, ffmpeg testsrc,
                     face_engine.py, atau container standalone face-service) sebelum
                     menyalakan container All-in-One
  --dry-run          Tampilkan proses/service host yang ditemukan tanpa mematikannya
  --skip-build       Lewati --build saat docker compose up
  -h, --help         Tampilkan bantuan ini
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --port) HOST_PORT="${2:-3080}"; shift 2 ;;
    --cleanup-host) CLEANUP_HOST=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --skip-build) SKIP_BUILD=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Opsi tidak dikenal: $1" >&2; exit 1 ;;
  esac
done

command -v docker >/dev/null 2>&1 || {
  echo "ERROR: Docker belum terpasang. Install Docker + docker compose plugin terlebih dahulu." >&2
  exit 1
}

COMPOSE_CMD=""
if docker compose version >/dev/null 2>&1; then
  COMPOSE_CMD="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE_CMD="docker-compose"
else
  echo "ERROR: Plugin 'docker compose' tidak ditemukan." >&2
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  echo "ERROR: Docker daemon tidak bisa diakses (jalankan sebagai root/sudo atau pastikan service docker aktif)." >&2
  exit 1
fi

inspect_host_processes() {
  echo "[allinone] Memeriksa proses & service lama yang berjalan langsung di HOST..."
  ps -eo pid,ppid,user:12,stat,args | grep -E "face_engine\.py|face_worker\.py|face-everytime-worker|mediamtx|testsrc=size=|/opt/xiu" | grep -v grep || echo "  (tidak ada proses host face_engine/face_worker/mediamtx/testsrc yang aktif)"
  if command -v systemctl >/dev/null 2>&1; then
    echo "[allinone] Memeriksa systemd unit terkait:"
    systemctl list-units --type=service --all --no-pager 2>/dev/null | grep -iE "mediamtx|face_engine|face-engine|face_worker|face-everytime|xiu|rtsp-test" || echo "  (tidak ada unit systemd terkait)"
  fi
  if command -v supervisorctl >/dev/null 2>&1; then
    echo "[allinone] Memeriksa supervisorctl:"
    supervisorctl status 2>/dev/null | grep -iE "mediamtx|face|xiu|ffmpeg|absensi" || echo "  (tidak ada program supervisor terkait)"
  fi
}

cleanup_host_processes() {
  echo "[allinone] Menghentikan service & proses lama di HOST agar 100% berjalan di Docker..."

  if command -v systemctl >/dev/null 2>&1; then
    while IFS= read -r unit; do
      [[ -n "$unit" ]] || continue
      echo "  -> systemctl stop & disable: $unit"
      systemctl stop "$unit" 2>/dev/null || true
      systemctl disable "$unit" 2>/dev/null || true
    done < <(systemctl list-units --type=service --all --no-legend --no-pager 2>/dev/null | awk '{print $1}' | grep -iE "mediamtx|face_engine|face-engine|face_worker|face-everytime|xiu|rtsp-test" || true)
  fi

  if command -v supervisorctl >/dev/null 2>&1; then
    while IFS= read -r prog; do
      [[ -n "$prog" ]] || continue
      echo "  -> supervisorctl stop: $prog"
      supervisorctl stop "$prog" 2>/dev/null || true
    done < <(supervisorctl status 2>/dev/null | awk '{print $1}' | grep -iE "mediamtx|face_engine|face-engine|face_worker|face-everytime|xiu|ffmpeg" || true)
  fi

  # Hentikan proses orphan di host (di luar container Docker: cgroup host)
  for pat in "/opt/mediamtx" "/var/www/face_engine/face_engine.py" "face_worker.py" "lavfi -i testsrc="; do
    while IFS= read -r pid; do
      [[ -n "$pid" ]] || continue
      # Lewati proses yang berada di dalam container Docker/containerd
      if grep -qaE "docker|containerd|kubepods" "/proc/${pid}/cgroup" 2>/dev/null; then
        continue
      fi
      echo "  -> Menghentikan proses host PID=${pid} (${pat})"
      kill -TERM "$pid" 2>/dev/null || true
    done < <(pgrep -f "$pat" 2>/dev/null || true)
  done

  sleep 2
  for pat in "/opt/mediamtx" "/var/www/face_engine/face_engine.py" "face_worker.py" "lavfi -i testsrc="; do
    while IFS= read -r pid; do
      [[ -n "$pid" ]] || continue
      if grep -qaE "docker|containerd|kubepods" "/proc/${pid}/cgroup" 2>/dev/null; then
        continue
      fi
      kill -KILL "$pid" 2>/dev/null || true
    done < <(pgrep -f "$pat" 2>/dev/null || true)
  done

  # Matikan container standalone face-service lama bila sebelumnya pakai mode hybrid
  if [[ -f "$APP_DIR/docker-compose.face.yml" ]]; then
    $COMPOSE_CMD -f "$APP_DIR/docker-compose.face.yml" down --remove-orphans >/dev/null 2>&1 || true
  fi
}

inspect_host_processes
if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "[allinone] Mode --dry-run aktif; tidak ada perubahan dilakukan."
  exit 0
fi

if [[ "$CLEANUP_HOST" -eq 1 ]]; then
  cleanup_host_processes
fi

mkdir -p "$APP_DIR/data/snapshots" "$APP_DIR/data/tts_cache" "$APP_DIR/data/backups" \
         "$APP_DIR/storage/secrets" "$APP_DIR/storage/wa_sessions" "$APP_DIR/storage/wa_qr" "$APP_DIR/storage/debug"
chmod 700 "$APP_DIR/storage/secrets" 2>/dev/null || true

TOKEN_FILE="$APP_DIR/storage/secrets/internal_token"
if [[ ! -s "$TOKEN_FILE" ]]; then
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 48 > "$TOKEN_FILE"
  else
    head -c 48 /dev/urandom | od -An -tx1 | tr -d ' \n' > "$TOKEN_FILE"
  fi
fi
chmod 600 "$TOKEN_FILE" 2>/dev/null || true

export HOST_PORT
if [[ "$SKIP_BUILD" -eq 1 ]]; then
  echo "[allinone] Menyalakan container All-in-One Docker di 127.0.0.1:${HOST_PORT}..."
  $COMPOSE_CMD -f "$APP_DIR/docker-compose.yml" up -d --remove-orphans
else
  echo "[allinone] Membangun & menyalakan container All-in-One Docker di 127.0.0.1:${HOST_PORT}..."
  $COMPOSE_CMD -f "$APP_DIR/docker-compose.yml" up -d --build --remove-orphans
fi

HEALTH_OK=0
for _ in $(seq 1 45); do
  if curl -sf "http://127.0.0.1:${HOST_PORT}/api/health" >/dev/null 2>&1; then
    HEALTH_OK=1
    break
  fi
  sleep 2
done

echo ""
$COMPOSE_CMD -f "$APP_DIR/docker-compose.yml" ps
echo ""
docker stats --no-stream --format "table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.PIDs}}" 2>/dev/null || true
echo ""
if [[ "$HEALTH_OK" -eq 1 ]]; then
  echo "[allinone] OK: Absensi SMK Face AI (All-in-One Docker) aktif di http://127.0.0.1:${HOST_PORT}"
else
  echo "[allinone] PERINGATAN: Healthcheck belum merespons dalam 90s. Cek log: $COMPOSE_CMD -f docker-compose.yml logs -f"
fi
