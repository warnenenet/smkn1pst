#!/usr/bin/env bash
set -Eeuo pipefail

# ==============================================================================
# Universal GitHub Auto-Update Script untuk aaPanel, PM2, systemd, Docker,
# dan Project Node.js / TypeScript lainnya.
#
# Prioritas konfigurasi: CLI flags > file .env project > Env OS > Default
#
# Fitur utama:
# - Aman untuk SQLite / data persisten (backup otomatis sebelum pull)
# - Anti-race condition via directory lock
# - Auto-deteksi package manager (npm / pnpm / yarn / bun) & script build
# - Auto-fix permission binary node_modules/.bin/* & owner user (mis. www:www aaPanel)
# - Build dijalankan SEBELUM restart agar downtime minimal & gagal build tidak mematikan app
# - Auto-deteksi process manager: Custom RESTART_CMD -> Docker -> PM2 -> systemd -> aaPanel -> PID signal
# - Verifikasi endpoint health check setelah restart
# - Mendukung pemasangan Cron otomatis setiap 1 jam sekali (--install-cron)
# ==============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEFAULT_APP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

FORCE=0
DRY_RUN=0
SKIP_RESTART=0
SKIP_BACKUP=0
ACTION="update"

CLI_APP_DIR=""
CLI_BRANCH=""
CLI_PORT=""
CLI_MANAGER=""
CLI_SCHEDULE=""

log() {
  printf '[auto-update %s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"
}

warn() {
  printf '[auto-update %s] PERINGATAN: %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >&2
}

die() {
  printf '[auto-update %s] ERROR: %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >&2
  exit 1
}

print_help() {
  cat <<'EOF'
Penggunaan: bash scripts/auto-update.sh [opsi]

Opsi Update:
  --app-dir <path>   Path root project (default: parent folder dari scripts/)
  --branch <nama>    Target branch Git (default: branch aktif atau main)
  --port <angka>     Port aplikasi untuk healthcheck (default: dari .env atau 3000)
  --manager <nama>   auto | aapanel | pm2 | systemd | supervisor | docker | custom | none
  --force            Tetap install/build/restart walaupun commit Git tidak berubah
  --dry-run          Cek apakah ada update dari GitHub tanpa mengubah file
  --skip-restart     Jangan restart service setelah update
  --skip-backup      Lewati backup SQLite pre-update

Opsi Penjadwalan (Default 1 Jam Sekali):
  --install-cron     Pasang cron job otomatis di server (default: 0 * * * * / setiap 1 jam)
  --uninstall-cron   Hapus cron job auto-update untuk folder project ini
  --schedule "<str>" Ubah jadwal cron (contoh: "0 * * * *" = 1 jam, "*/30 * * * *" = 30 menit)
  --status           Tampilkan status Git, cron aktif, dan konfigurasi terdeteksi
  -h, --help         Tampilkan bantuan ini

Variabel Lingkungan / .env yang Didukung:
  GIT_REMOTE           Nama remote Git (default: origin)
  GIT_BRANCH           Nama branch Git target
  PKG_MANAGER          auto | npm | pnpm | yarn | bun (default: auto)
  INSTALL_STRATEGY     auto | always | never (default: auto)
  BUILD_SCRIPT         auto | <script_name> | none (default: auto)
  APP_MANAGER          auto | aapanel | pm2 | systemd | supervisor | docker | custom | none
  AAPANEL_PROJECT_NAME Nama project Node di aaPanel (opsional, auto-deteksi path)
  PM2_APP_NAME         Nama proses PM2 (opsional, auto-deteksi)
  SYSTEMD_SERVICE      Nama unit systemd (opsional)
  SUPERVISOR_PROGRAM   Nama program supervisorctl (opsional)
  RESTART_CMD          Perintah restart kustom (prioritas tertinggi bila diisi)
  RUN_USER / RUN_GROUP Pemilik file (default: auto, mis. www:www di aaPanel)
  DATA_DIR             Folder penyimpanan data / SQLite (default: ./data)
  PORT                 Port aplikasi untuk verifikasi healthcheck (default: 3000)
  HEALTH_URL           URL penuh healthcheck (default: http://127.0.0.1:$PORT$HEALTH_PATH)
  AUTO_STASH           1 = otomatis git stash jika ada perubahan file tracked lokal
  CRON_SCHEDULE        Jadwal cron default untuk --install-cron (default: "0 * * * *")
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --force) FORCE=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --skip-restart) SKIP_RESTART=1; shift ;;
    --skip-backup) SKIP_BACKUP=1; shift ;;
    --install-cron) ACTION="install-cron"; shift ;;
    --uninstall-cron) ACTION="uninstall-cron"; shift ;;
    --status) ACTION="status"; shift ;;
    --app-dir)
      [[ $# -ge 2 ]] || die "--app-dir membutuhkan path direktori"
      CLI_APP_DIR="$2"
      shift 2
      ;;
    --branch)
      [[ $# -ge 2 ]] || die "--branch membutuhkan nama branch"
      CLI_BRANCH="$2"
      shift 2
      ;;
    --port)
      [[ $# -ge 2 ]] || die "--port membutuhkan nomor port"
      CLI_PORT="$2"
      shift 2
      ;;
    --manager)
      [[ $# -ge 2 ]] || die "--manager membutuhkan nama manager"
      CLI_MANAGER="$2"
      shift 2
      ;;
    --schedule)
      [[ $# -ge 2 ]] || die "--schedule membutuhkan ekspresi cron (mis. \"0 * * * *\")"
      CLI_SCHEDULE="$2"
      shift 2
      ;;
    -h|--help)
      print_help
      exit 0
      ;;
    *)
      die "Opsi tidak dikenal: $1 (jalankan --help untuk bantuan)"
      ;;
  esac
done

APP_DIR="${CLI_APP_DIR:-$DEFAULT_APP_DIR}"
cd "$APP_DIR"
APP_DIR="$(pwd)"

# Baca variabel dari .env secara aman (tanpa mengeksekusi perintah shell sembarangan).
# Nilai dari .env project diprioritaskan di atas env OS global (mis. PORT container).
load_dotenv_safe() {
  local env_file="$1"
  [[ -f "$env_file" ]] || return 0
  while IFS= read -r raw_line || [[ -n "$raw_line" ]]; do
    local line="${raw_line%$'\r'}"
    [[ -z "${line//[[:space:]]/}" || "${line#"${line%%[![:space:]]*}"}" == \#* ]] && continue
    line="${line#export }"
    if [[ "$line" =~ ^[[:space:]]*([A-Za-z_][A-Za-z0-9_]*)[[:space:]]*=(.*)$ ]]; then
      local key="${BASH_REMATCH[1]}"
      local val="${BASH_REMATCH[2]}"
      val="${val#"${val%%[![:space:]]*}"}"
      val="${val%"${val##*[![:space:]]}"}"
      if [[ "$val" =~ ^\"(.*)\"$ ]]; then
        val="${BASH_REMATCH[1]}"
      elif [[ "$val" =~ ^\'(.*)\'$ ]]; then
        val="${BASH_REMATCH[1]}"
      fi
      export "$key=$val"
    fi
  done < "$env_file"
}

load_dotenv_safe "$APP_DIR/.env"

# Konfigurasi final (CLI flags menang atas .env dan env OS)
GIT_REMOTE="${GIT_REMOTE:-origin}"
GIT_BRANCH="${CLI_BRANCH:-${GIT_BRANCH:-}}"
PKG_MANAGER="${PKG_MANAGER:-auto}"           # auto | npm | pnpm | yarn | bun
INSTALL_STRATEGY="${INSTALL_STRATEGY:-auto}" # auto | always | never
BUILD_SCRIPT="${BUILD_SCRIPT:-auto}"         # auto | <nama_script> | none
APP_MANAGER="${CLI_MANAGER:-${APP_MANAGER:-auto}}"
AAPANEL_PROJECT_NAME="${AAPANEL_PROJECT_NAME:-}"
PM2_APP_NAME="${PM2_APP_NAME:-}"
SYSTEMD_SERVICE="${SYSTEMD_SERVICE:-}"
SUPERVISOR_PROGRAM="${SUPERVISOR_PROGRAM:-}"
RESTART_CMD="${RESTART_CMD:-}"
RUN_USER="${RUN_USER:-auto}"
RUN_GROUP="${RUN_GROUP:-auto}"
DATA_DIR="${DATA_DIR:-./data}"
BACKUP_KEEP="${BACKUP_KEEP:-5}"
PORT="${CLI_PORT:-${PORT:-3000}}"
HEALTH_PATH="${HEALTH_PATH:-/api/health}"
HEALTH_URL="${HEALTH_URL:-}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-25}"
AUTO_STASH="${AUTO_STASH:-0}"
UPDATE_ONLY_NEW_VERSION="${UPDATE_ONLY_NEW_VERSION:-1}"
CRON_SCHEDULE="${CLI_SCHEDULE:-${CRON_SCHEDULE:-0 * * * *}}" # Default: 1 jam sekali
LOG_FILE="${LOG_FILE:-}"

# Resolusi path absolut DATA_DIR & LOG_FILE
if [[ "$DATA_DIR" != /* ]]; then
  DATA_DIR="$APP_DIR/${DATA_DIR#./}"
fi
if [[ -z "$LOG_FILE" ]]; then
  if [[ -d "$DATA_DIR" ]] || [[ -f "$APP_DIR/server.ts" ]]; then
    LOG_FILE="$DATA_DIR/auto-update.log"
  else
    LOG_FILE="/tmp/auto-update-$(basename "$APP_DIR").log"
  fi
fi

# Jaga ukuran LOG_FILE agar tidak menumpuk (> 1 MB otomatis dipangkas ke 1.500 baris terakhir)
rotate_log_file() {
  local target="$1"
  [[ -f "$target" ]] || return 0
  local sz
  sz="$(wc -c < "$target" 2>/dev/null || echo 0)"
  if [[ "${sz:-0}" -gt 1048576 ]]; then
    local tmp_log="${target}.trim.$$"
    tail -n 1500 "$target" > "$tmp_log" 2>/dev/null && mv "$tmp_log" "$target" || rm -f "$tmp_log"
  fi
}
if [[ "$ACTION" == "update" ]]; then
  rotate_log_file "$LOG_FILE"
fi

# ------------------------------------------------------------------------------
# Manajemen Cron Job Otomatis (Default: 1 Jam Sekali -> "0 * * * *")
# ------------------------------------------------------------------------------
CRON_TAG="# auto-update:${APP_DIR}"

install_cron_job() {
  command -v crontab >/dev/null 2>&1 || die "Perintah 'crontab' tidak tersedia di server. Gunakan menu Cron di aaPanel dan tempel: bash $APP_DIR/scripts/auto-update.sh"
  mkdir -p "$(dirname "$LOG_FILE")"
  local existing
  existing="$(crontab -l 2>/dev/null || true)"
  local filtered
  filtered="$(printf '%s\n' "$existing" | grep -vF "$CRON_TAG" || true)"
  local entry="${CRON_SCHEDULE} cd \"${APP_DIR}\" && /usr/bin/env bash \"${APP_DIR}/scripts/auto-update.sh\" >> \"${LOG_FILE}\" 2>&1 ${CRON_TAG}"
  if [[ -n "$filtered" ]]; then
    printf '%s\n%s\n' "$filtered" "$entry" | crontab -
  else
    printf '%s\n' "$entry" | crontab -
  fi
  log "Cron auto-update berhasil dipasang (jadwal: '$CRON_SCHEDULE' = 1 jam sekali jika default)."
  log "Log eksekusi akan ditulis ke: $LOG_FILE"
}

uninstall_cron_job() {
  command -v crontab >/dev/null 2>&1 || die "Perintah 'crontab' tidak tersedia di server."
  local existing
  existing="$(crontab -l 2>/dev/null || true)"
  if [[ -z "$existing" ]] || ! printf '%s\n' "$existing" | grep -qF "$CRON_TAG"; then
    log "Tidak ada cron auto-update aktif untuk '$APP_DIR'."
    return 0
  fi
  printf '%s\n' "$existing" | { grep -vF "$CRON_TAG" || true; } | crontab -
  log "Cron auto-update untuk '$APP_DIR' telah dihapus."
}

print_status() {
  log "APP_DIR      : $APP_DIR"
  log "DATA_DIR     : $DATA_DIR"
  log "PORT         : $PORT"
  log "APP_MANAGER  : $APP_MANAGER"
  log "LOG_FILE     : $LOG_FILE"
  if [[ -f "$APP_DIR/package.json" ]] && command -v node >/dev/null 2>&1; then
    local app_ver
    app_ver="$(node -e 'try{process.stdout.write(String(require("./package.json").version||"1.0.0"))}catch{process.stdout.write("1.0.0")}' 2>/dev/null || echo '1.0.0')"
    log "APP_VERSION  : v${app_ver} (UPDATE_ONLY_NEW_VERSION=${UPDATE_ONLY_NEW_VERSION})"
  fi
  if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    log "GIT_BRANCH   : $(git symbolic-ref --quiet --short HEAD 2>/dev/null || echo 'detached')"
    log "GIT_HEAD     : $(git rev-parse --short HEAD 2>/dev/null || echo '-')"
    log "GIT_REMOTE   : $(git remote get-url "$GIT_REMOTE" 2>/dev/null || echo '-')"
  else
    log "GIT          : Belum diinisialisasi (.git tidak ditemukan)"
  fi
  if command -v crontab >/dev/null 2>&1; then
    local c_line
    c_line="$(crontab -l 2>/dev/null | grep -F "$CRON_TAG" || true)"
    if [[ -n "$c_line" ]]; then
      log "CRON         : AKTIF -> $c_line"
    else
      log "CRON         : Tidak terpasang"
    fi
  fi
}

case "$ACTION" in
  install-cron)
    install_cron_job
    exit 0
    ;;
  uninstall-cron)
    uninstall_cron_job
    exit 0
    ;;
  status)
    print_status
    exit 0
    ;;
esac

# ------------------------------------------------------------------------------
# Guard anti-eksekusi paralel (Locking)
# ------------------------------------------------------------------------------
LOCK_DIR="/tmp/auto-update-$(printf '%s' "$APP_DIR" | cksum | awk '{print $1}').lock"
cleanup_lock() {
  rmdir "$LOCK_DIR" 2>/dev/null || rm -rf "$LOCK_DIR" 2>/dev/null || true
}

if [[ "$DRY_RUN" -eq 0 ]]; then
  if ! mkdir "$LOCK_DIR" 2>/dev/null; then
    if [[ -f "$LOCK_DIR/pid" ]]; then
      EXISTING_PID="$(cat "$LOCK_DIR/pid" 2>/dev/null || true)"
      if [[ -n "$EXISTING_PID" ]] && kill -0 "$EXISTING_PID" 2>/dev/null; then
        die "Proses auto-update lain sedang berjalan (PID $EXISTING_PID)."
      fi
      rm -rf "$LOCK_DIR"
      mkdir "$LOCK_DIR"
    else
      die "Proses auto-update lain sedang berjalan ($LOCK_DIR)."
    fi
  fi
  echo "$$" > "$LOCK_DIR/pid"
  trap cleanup_lock EXIT
fi

# ------------------------------------------------------------------------------
# Validasi Git Repository
# ------------------------------------------------------------------------------
command -v git >/dev/null 2>&1 || die "Perintah 'git' tidak ditemukan di server."

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  die "Folder '$APP_DIR' belum berupa repositori Git (.git tidak ditemukan). Jika di-upload via ZIP, inisialisasi Git terlebih dahulu sesuai panduan di README.md."
fi

git config --global --add safe.directory "$APP_DIR" >/dev/null 2>&1 || true

if [[ -n "$GIT_BRANCH" ]]; then
  TARGET_BRANCH="$GIT_BRANCH"
else
  TARGET_BRANCH="$(git symbolic-ref --quiet --short HEAD 2>/dev/null || true)"
  if [[ -z "$TARGET_BRANCH" ]]; then
    TARGET_BRANCH="main"
  fi
fi

if ! git remote get-url "$GIT_REMOTE" >/dev/null 2>&1; then
  die "Remote Git '$GIT_REMOTE' belum dikonfigurasi di '$APP_DIR'."
fi

log "Memeriksa pembaruan di $GIT_REMOTE/$TARGET_BRANCH (dir: $APP_DIR)..."
git fetch "$GIT_REMOTE" "$TARGET_BRANCH" --prune --tags

LOCAL_SHA="$(git rev-parse HEAD)"
REMOTE_SHA="$(git rev-parse "$GIT_REMOTE/$TARGET_BRANCH")"

read_local_pkg_version() {
  if [[ -f "$APP_DIR/package.json" ]] && command -v node >/dev/null 2>&1; then
    node -e 'try{process.stdout.write(String(require("./package.json").version||"0.0.0"))}catch{process.stdout.write("0.0.0")}' 2>/dev/null || echo "0.0.0"
  else
    echo "0.0.0"
  fi
}

read_remote_pkg_version() {
  local raw
  raw="$(git show "$GIT_REMOTE/$TARGET_BRANCH:package.json" 2>/dev/null || true)"
  if [[ -n "$raw" ]] && command -v node >/dev/null 2>&1; then
    node -e 'try{const p=JSON.parse(process.argv[1]); process.stdout.write(String(p.version||"0.0.0"))}catch{process.stdout.write("0.0.0")}' "$raw" 2>/dev/null || echo "0.0.0"
  else
    echo "0.0.0"
  fi
}

is_remote_version_newer() {
  local local_v="$1"
  local remote_v="$2"
  command -v node >/dev/null 2>&1 || return 0
  node -e '
    const parse = (s) => {
      const m = String(s || "").trim().replace(/^v/i, "").match(/^(\d+)\.(\d+)\.(\d+)/);
      return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
    };
    const a = parse(process.argv[1]);
    const b = parse(process.argv[2]);
    if (!a || !b) process.exit(2);
    for (let i = 0; i < 3; i++) {
      if (b[i] !== a[i]) process.exit(b[i] > a[i] ? 0 : 1);
    }
    process.exit(1);
  ' "$local_v" "$remote_v" >/dev/null 2>&1
}

LOCAL_VER="$(read_local_pkg_version)"
REMOTE_VER="$(read_remote_pkg_version)"

if [[ "$LOCAL_SHA" == "$REMOTE_SHA" && "$FORCE" -eq 0 ]]; then
  log "Sudah versi terbaru (v${LOCAL_VER} · ${LOCAL_SHA:0:7}). Tidak ada perubahan."
  exit 0
fi

if [[ "$FORCE" -eq 0 && "$UPDATE_ONLY_NEW_VERSION" == "1" && "$LOCAL_VER" != "0.0.0" && "$REMOTE_VER" != "0.0.0" ]]; then
  if ! is_remote_version_newer "$LOCAL_VER" "$REMOTE_VER"; then
    log "Commit remote berubah (${REMOTE_SHA:0:7}), tetapi versi masih v${REMOTE_VER} <= v${LOCAL_VER}. Menunggu nomor versi baru (atau jalankan --force)."
    exit 0
  fi
fi

if [[ "$DRY_RUN" -eq 1 ]]; then
  if [[ "$LOCAL_SHA" == "$REMOTE_SHA" ]]; then
    log "[DRY-RUN] Tidak ada update baru (v${LOCAL_VER} · ${LOCAL_SHA:0:7})."
  else
    log "[DRY-RUN] Tersedia update versi v${LOCAL_VER} -> v${REMOTE_VER} (${LOCAL_SHA:0:7} -> ${REMOTE_SHA:0:7})"
    git log --oneline "${LOCAL_SHA}..${REMOTE_SHA}" | head -n 15 || true
  fi
  exit 0
fi

if [[ "$LOCAL_SHA" != "$REMOTE_SHA" ]]; then
  if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
    if [[ "$AUTO_STASH" == "1" ]]; then
      log "Menyimpan sementara perubahan lokal file tracked (AUTO_STASH=1)..."
      git stash push -m "auto-update-$(date +%Y%m%d-%H%M%S)"
    else
      die "Ada perubahan file tracked yang belum di-commit di '$APP_DIR'. Jalankan 'git status' atau set AUTO_STASH=1."
    fi
  fi
fi

# ------------------------------------------------------------------------------
# Backup database SQLite sebelum update (mis. data/absensi.sqlite)
# ------------------------------------------------------------------------------
backup_sqlite_databases() {
  [[ "$SKIP_BACKUP" -eq 1 ]] && return 0
  [[ -d "$DATA_DIR" ]] || return 0

  local found_db=0
  local backup_dir="$DATA_DIR/backups"
  local ts
  ts="$(date '+%Y%m%d-%H%M%S')"

  shopt -s nullglob
  for db_file in "$DATA_DIR"/*.sqlite "$DATA_DIR"/*.db; do
    [[ -f "$db_file" ]] || continue
    found_db=1
    mkdir -p "$backup_dir"
    local base_name
    base_name="$(basename "$db_file")"
    local dest="$backup_dir/pre-update-${ts}-${base_name}.bak"

    if command -v sqlite3 >/dev/null 2>&1; then
      sqlite3 "$db_file" ".backup '$dest'"
    else
      cp -p "$db_file" "$dest"
      [[ -f "${db_file}-wal" ]] && cp -p "${db_file}-wal" "${dest}-wal" || true
      [[ -f "${db_file}-shm" ]] && cp -p "${db_file}-shm" "${dest}-shm" || true
    fi
    log "Backup pre-update tersimpan: $dest"
  done
  shopt -u nullglob

  if [[ "$found_db" -eq 1 && "$BACKUP_KEEP" =~ ^[0-9]+$ && "$BACKUP_KEEP" -gt 0 ]]; then
    local old_backups
    old_backups="$(ls -1t "$backup_dir"/pre-update-*.bak 2>/dev/null | tail -n +"$((BACKUP_KEEP + 1))" || true)"
    if [[ -n "$old_backups" ]]; then
      while IFS= read -r old_f; do
        [[ -n "$old_f" ]] && rm -f "$old_f" "${old_f}-wal" "${old_f}-shm"
      done <<< "$old_backups"
    fi
  fi
}

backup_sqlite_databases

# ------------------------------------------------------------------------------
# Pull fast-forward dari GitHub
# ------------------------------------------------------------------------------
if [[ "$LOCAL_SHA" != "$REMOTE_SHA" ]]; then
  log "Menarik commit baru: ${LOCAL_SHA:0:7} -> ${REMOTE_SHA:0:7}..."
  git pull --ff-only "$GIT_REMOTE" "$TARGET_BRANCH"
else
  log "Mode --force aktif; menjalankan ulang install/build/restart pada commit ${LOCAL_SHA:0:7}."
fi

NEW_SHA="$(git rev-parse HEAD)"

# ------------------------------------------------------------------------------
# Deteksi Package Manager & Script di package.json
# ------------------------------------------------------------------------------
detect_pkg_manager() {
  if [[ "$PKG_MANAGER" != "auto" ]]; then
    echo "$PKG_MANAGER"
    return
  fi
  if [[ -f "$APP_DIR/pnpm-lock.yaml" ]] && command -v pnpm >/dev/null 2>&1; then
    echo "pnpm"
  elif [[ -f "$APP_DIR/yarn.lock" ]] && command -v yarn >/dev/null 2>&1; then
    echo "yarn"
  elif { [[ -f "$APP_DIR/bun.lockb" ]] || [[ -f "$APP_DIR/bun.lock" ]]; } && command -v bun >/dev/null 2>&1; then
    echo "bun"
  else
    echo "npm"
  fi
}

has_pkg_script() {
  local script_name="$1"
  [[ -f "$APP_DIR/package.json" ]] || return 1
  if command -v node >/dev/null 2>&1; then
    node -e "const p=require('./package.json'); process.exit(p.scripts && p.scripts[process.argv[1]] ? 0 : 1)" "$script_name" 2>/dev/null
    return $?
  fi
  grep -q "\"$script_name\"[[:space:]]*:" "$APP_DIR/package.json"
}

PM="$(detect_pkg_manager)"
log "Package manager terdeteksi: $PM"

has_broken_node_modules() {
  [[ -d "$APP_DIR/node_modules" ]] || return 0
  if [[ -f "$APP_DIR/package.json" ]] && grep -q '"ws"' "$APP_DIR/package.json" && [[ ! -f "$APP_DIR/node_modules/ws/lib/stream.js" ]]; then
    return 0
  fi
  if [[ -f "$APP_DIR/package.json" ]] && grep -q '"express"' "$APP_DIR/package.json" && [[ ! -f "$APP_DIR/node_modules/express/package.json" ]]; then
    return 0
  fi
  if [[ -f "$APP_DIR/package.json" ]] && grep -q '"vite"' "$APP_DIR/package.json" && [[ ! -f "$APP_DIR/node_modules/vite/package.json" ]]; then
    return 0
  fi
  if [[ -f "$APP_DIR/package.json" ]] && grep -q '"@ffmpeg-installer/ffmpeg"' "$APP_DIR/package.json" && [[ ! -f "$APP_DIR/node_modules/@ffmpeg-installer/ffmpeg/package.json" ]]; then
    return 0
  fi
  return 1
}

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

SHOULD_INSTALL=0
if [[ "$INSTALL_STRATEGY" == "always" ]]; then
  SHOULD_INSTALL=1
elif [[ "$INSTALL_STRATEGY" == "auto" ]]; then
  if [[ ! -d "$APP_DIR/node_modules" ]]; then
    SHOULD_INSTALL=1
  elif has_broken_node_modules; then
    warn "Folder node_modules terdeteksi tidak lengkap/rusak (misal ws/lib/stream.js hilang); memperbaiki dengan reinstall..."
    rm -rf "$APP_DIR/node_modules/ws" 2>/dev/null || true
    SHOULD_INSTALL=1
  elif [[ "$LOCAL_SHA" != "$NEW_SHA" ]]; then
    if git diff --name-only "$LOCAL_SHA" "$NEW_SHA" | grep -qE '^(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?)$'; then
      SHOULD_INSTALL=1
    fi
  elif [[ "$FORCE" -eq 1 && ! -d "$APP_DIR/node_modules/.bin" ]]; then
    SHOULD_INSTALL=1
  fi
fi

if [[ "$SHOULD_INSTALL" -eq 1 ]]; then
  log "Menginstal dependensi dengan $PM..."
  case "$PM" in
    npm)  npm install --no-audit --no-fund ;;
    pnpm) pnpm install --frozen-lockfile || pnpm install ;;
    yarn) yarn install ;;
    bun)  bun install ;;
    *)    die "PKG_MANAGER tidak didukung: $PM" ;;
  esac
else
  log "Dependensi tidak berubah; melewati tahap install."
fi

fix_binary_permissions

if [[ -x "$APP_DIR/services/wa-gateway/.venv/bin/pip" ]] && [[ -f "$APP_DIR/services/wa-gateway/requirements.txt" ]]; then
  if [[ "$FORCE" -eq 1 ]] || { [[ "$LOCAL_SHA" != "$NEW_SHA" ]] && git diff --name-only "$LOCAL_SHA" "$NEW_SHA" | grep -q '^services/wa-gateway/requirements\.txt$'; }; then
    log "Memperbarui dependensi Python WA Gateway..."
    "$APP_DIR/services/wa-gateway/.venv/bin/pip" install --quiet -r "$APP_DIR/services/wa-gateway/requirements.txt" || true
  fi
fi

# ------------------------------------------------------------------------------
# Build Produksi (Sebelum Restart)
# ------------------------------------------------------------------------------
run_pkg_script() {
  local sname="$1"
  case "$PM" in
    npm)  npm run "$sname" ;;
    pnpm) pnpm run "$sname" ;;
    yarn) yarn "$sname" ;;
    bun)  bun run "$sname" ;;
  esac
}

if [[ "$BUILD_SCRIPT" != "none" ]]; then
  if [[ "$BUILD_SCRIPT" == "auto" ]]; then
    if has_pkg_script "build"; then
      log "Menjalankan build produksi ($PM run build)..."
      run_pkg_script "build"
    else
      log "Tidak ada script 'build' di package.json; melewati tahap build."
    fi
  else
    log "Menjalankan script build kustom ($PM run $BUILD_SCRIPT)..."
    run_pkg_script "$BUILD_SCRIPT"
  fi
fi

# Rebuild & restart Docker Face AI companion container apabila ada perubahan kode AI/Rust/Docker
if [[ -f "$APP_DIR/docker-compose.face.yml" ]] && command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  SHOULD_REBUILD_FACE_DOCKER=0
  if [[ "$FORCE" -eq 1 ]]; then
    SHOULD_REBUILD_FACE_DOCKER=1
  elif [[ "$LOCAL_SHA" != "$NEW_SHA" ]] && git diff --name-only "$LOCAL_SHA" "$NEW_SHA" | grep -qE '^(services/face-service/|services/rust-accel/|Dockerfile\.face-service|docker-compose\.face\.yml)'; then
    SHOULD_REBUILD_FACE_DOCKER=1
  fi
  if [[ "$SHOULD_REBUILD_FACE_DOCKER" -eq 1 ]]; then
    if docker compose version >/dev/null 2>&1; then
      log "Memperbarui container Docker Face AI (docker-compose.face.yml)..."
      docker compose -f "$APP_DIR/docker-compose.face.yml" up -d --build || warn "Gagal rebuild Docker Face AI; cek manual docker compose -f docker-compose.face.yml logs"
    elif command -v docker-compose >/dev/null 2>&1; then
      log "Memperbarui container Docker Face AI (docker-compose)..."
      docker-compose -f "$APP_DIR/docker-compose.face.yml" up -d --build || warn "Gagal rebuild Docker Face AI"
    fi
  fi
fi

# ------------------------------------------------------------------------------
# Perbaikan Ownership File (Khusus aaPanel user www / multi-user setup)
# ------------------------------------------------------------------------------
fix_ownership_if_root() {
  [[ "$(id -u)" -eq 0 ]] || return 0

  local target_user="$RUN_USER"
  local target_group="$RUN_GROUP"

  if [[ "$target_user" == "auto" ]]; then
    if [[ -d "/www/server" ]] && id -u www >/dev/null 2>&1; then
      target_user="www"
    else
      target_user="$(stat -c '%U' "$APP_DIR/package.json" 2>/dev/null || echo 'root')"
    fi
  fi

  if [[ "$target_group" == "auto" ]]; then
    if [[ "$target_user" == "www" ]] && getent group www >/dev/null 2>&1; then
      target_group="www"
    else
      target_group="$(stat -c '%G' "$APP_DIR/package.json" 2>/dev/null || echo "$target_user")"
    fi
  fi

  if [[ -n "$target_user" && "$target_user" != "root" ]] && id -u "$target_user" >/dev/null 2>&1; then
    log "Menyelaraskan kepemilikan file ke ${target_user}:${target_group}..."
    chown -R "${target_user}:${target_group}" "$APP_DIR"
  fi
}

fix_ownership_if_root

# ------------------------------------------------------------------------------
# Restart Service Secara Universal
# ------------------------------------------------------------------------------
find_aapanel_vhost_script() {
  local candidate=""
  if [[ -n "$AAPANEL_PROJECT_NAME" ]]; then
    for p in \
      "/www/server/nodejs/vhost/scripts/${AAPANEL_PROJECT_NAME}.sh" \
      "/etc/init.d/node_${AAPANEL_PROJECT_NAME}" \
      "/etc/init.d/${AAPANEL_PROJECT_NAME}"; do
      if [[ -e "$p" ]]; then
        echo "$p"
        return 0
      fi
    done
  fi

  if [[ -d "/www/server/nodejs/vhost/scripts" ]]; then
    candidate="$(grep -lF "$APP_DIR" /www/server/nodejs/vhost/scripts/*.sh 2>/dev/null | head -n 1 || true)"
    if [[ -n "$candidate" ]]; then
      echo "$candidate"
      return 0
    fi
  fi
  return 1
}

restart_via_aapanel() {
  local script_path
  if script_path="$(find_aapanel_vhost_script)"; then
    log "Merestart aaPanel Node project melalui: $script_path"
    if grep -qE 'restart' "$script_path" 2>/dev/null; then
      bash "$script_path" restart
    else
      bash "$script_path" stop || true
      sleep 1
      bash "$script_path" start
    fi
    return 0
  fi

  if command -v supervisorctl >/dev/null 2>&1; then
    local sup_target="${SUPERVISOR_PROGRAM:-$AAPANEL_PROJECT_NAME}"
    if [[ -n "$sup_target" ]] && supervisorctl status "$sup_target" >/dev/null 2>&1; then
      log "Merestart service Supervisor '$sup_target'..."
      supervisorctl restart "$sup_target"
      return 0
    fi
  fi

  return 1
}

detect_pm2_name() {
  command -v pm2 >/dev/null 2>&1 || return 1
  if [[ -n "$PM2_APP_NAME" ]]; then
    if pm2 describe "$PM2_APP_NAME" >/dev/null 2>&1; then
      echo "$PM2_APP_NAME"
      return 0
    fi
  fi
  local matched
  matched="$(pm2 jlist 2>/dev/null | node -e "
    let d=''; process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>{
      try {
        const arr=JSON.parse(d||'[]');
        const dir=process.argv[1];
        const hit=arr.find(p => p.pm2_env && (p.pm2_env.pm_cwd === dir || (p.pm2_env.pm_exec_path||'').startsWith(dir)));
        if (hit && hit.name) console.log(hit.name);
      } catch {}
    });
  " "$APP_DIR" 2>/dev/null || true)"
  if [[ -n "$matched" ]]; then
    echo "$matched"
    return 0
  fi
  return 1
}

restart_via_pid_graceful() {
  local pids=""
  if command -v pgrep >/dev/null 2>&1; then
    pids="$(pgrep -f "$APP_DIR" 2>/dev/null || true)"
  fi
  local target_pids=()
  for pid in $pids; do
    [[ "$pid" == "$$" || "$pid" == "$PPID" ]] && continue
    local cmd
    cmd="$(ps -p "$pid" -o args= 2>/dev/null || true)"
    if [[ "$cmd" == *"node"* || "$cmd" == *"tsx"* || "$cmd" == *"bun"* ]]; then
      target_pids+=("$pid")
    fi
  done

  if [[ "${#target_pids[@]}" -gt 0 ]]; then
    log "Mengirim SIGTERM ke proses aplikasi aktif (${target_pids[*]})..."
    kill -TERM "${target_pids[@]}" 2>/dev/null || true
    return 0
  fi
  return 1
}

restart_service() {
  if [[ "$SKIP_RESTART" -eq 1 || "$APP_MANAGER" == "none" ]]; then
    log "Tahap restart dilewati (--skip-restart / APP_MANAGER=none)."
    return 0
  fi

  if [[ -n "$RESTART_CMD" ]]; then
    log "Menjalankan RESTART_CMD kustom..."
    bash -c "$RESTART_CMD"
    return 0
  fi

  if [[ -f "/.dockerenv" ]]; then
    warn "Script berjalan di dalam container Docker; melewati restart service host."
    return 0
  fi

  local manager="$APP_MANAGER"

  if [[ "$manager" == "custom" ]]; then
    die "APP_MANAGER=custom dipilih namun RESTART_CMD belum diisi."
  fi

  if [[ "$manager" == "docker" ]]; then
    command -v docker >/dev/null 2>&1 || die "Perintah 'docker' tidak ditemukan."
    log "Membangun ulang dan merestart Docker Compose..."
    docker compose up -d --build
    return 0
  fi

  if [[ "$manager" == "aapanel" ]]; then
    if restart_via_aapanel; then
      return 0
    fi
    warn "Script vhost aaPanel tidak ditemukan; mencoba sinyal graceful reload..."
    restart_via_pid_graceful && return 0
    warn "Tidak menemukan service aaPanel secara otomatis. Isi AAPANEL_PROJECT_NAME atau RESTART_CMD di .env."
    return 0
  fi

  if [[ "$manager" == "pm2" ]]; then
    local pm2_name
    pm2_name="$(detect_pm2_name || true)"
    [[ -n "$pm2_name" ]] || die "Proses PM2 untuk '$APP_DIR' tidak ditemukan. Set PM2_APP_NAME di .env."
    log "Merestart PM2 process '$pm2_name'..."
    pm2 restart "$pm2_name" --update-env
    return 0
  fi

  if [[ "$manager" == "systemd" ]]; then
    [[ -n "$SYSTEMD_SERVICE" ]] || die "SYSTEMD_SERVICE belum diset."
    log "Merestart unit systemd '$SYSTEMD_SERVICE'..."
    systemctl restart "$SYSTEMD_SERVICE"
    return 0
  fi

  if [[ "$manager" == "supervisor" ]]; then
    local sup="${SUPERVISOR_PROGRAM:-$AAPANEL_PROJECT_NAME}"
    [[ -n "$sup" ]] || die "SUPERVISOR_PROGRAM belum diset."
    log "Merestart supervisorctl '$sup'..."
    supervisorctl restart "$sup"
    return 0
  fi

  # Mode AUTO: deteksi berurutan
  if [[ -d "/www/server" ]] && restart_via_aapanel; then
    return 0
  fi

  local pm2_auto
  pm2_auto="$(detect_pm2_name || true)"
  if [[ -n "$pm2_auto" ]]; then
    log "PM2 terdeteksi otomatis ('$pm2_auto'); merestart..."
    pm2 restart "$pm2_auto" --update-env
    return 0
  fi

  if [[ -n "$SYSTEMD_SERVICE" ]] && command -v systemctl >/dev/null 2>&1; then
    log "Systemd unit terdeteksi ('$SYSTEMD_SERVICE'); merestart..."
    systemctl restart "$SYSTEMD_SERVICE"
    return 0
  fi

  if restart_via_pid_graceful; then
    warn "Proses lama dihentikan via SIGTERM. Jika Anda menjalankan Node Project lewat aaPanel tanpa script vhost, klik Restart di aaPanel atau isi RESTART_CMD di .env bila server tidak otomatis bangkit."
    return 0
  fi

  warn "Tidak ada process manager aktif yang terdeteksi (aaPanel/PM2/systemd). Jalankan restart service secara manual atau atur RESTART_CMD di .env."
}

restart_service

# ------------------------------------------------------------------------------
# Verifikasi Healthcheck Pasca-Update
# ------------------------------------------------------------------------------
verify_health() {
  [[ "$SKIP_RESTART" -eq 1 || "$APP_MANAGER" == "none" ]] && return 0
  command -v curl >/dev/null 2>&1 || {
    warn "'curl' tidak tersedia; melewati verifikasi HTTP healthcheck."
    return 0
  }

  local target_url="${HEALTH_URL:-http://127.0.0.1:${PORT}${HEALTH_PATH}}"
  local fallback_url="http://127.0.0.1:${PORT}/"
  local elapsed=0

  sleep 1
  log "Memeriksa kesehatan aplikasi di $target_url (maks ${HEALTH_TIMEOUT}s)..."
  while [[ "$elapsed" -lt "$HEALTH_TIMEOUT" ]]; do
    local code
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "$target_url" || echo '000')"
    if [[ "$code" =~ ^[23] ]]; then
      log "Aplikasi sehat (HTTP $code pada $target_url). Auto-update selesai pada commit ${NEW_SHA:0:7}."
      return 0
    fi
    if [[ "$code" == "404" && -z "$HEALTH_URL" && "$HEALTH_PATH" == "/api/health" ]]; then
      local root_code
      root_code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "$fallback_url" || echo '000')"
      if [[ "$root_code" =~ ^(2|3|401|403) ]]; then
        log "Aplikasi aktif di $fallback_url (HTTP $root_code). Auto-update selesai pada commit ${NEW_SHA:0:7}."
        return 0
      fi
    fi
    sleep 1
    elapsed=$((elapsed + 1))
  done

  warn "Server belum merespons 2xx/3xx di $target_url setelah ${HEALTH_TIMEOUT}s. Cek Project Log / status service di panel Anda."
  return 1
}

verify_health
