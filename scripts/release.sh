#!/usr/bin/env bash
set -Eeuo pipefail

# ==============================================================================
# Release Helper — Bump Versi Semver + Verifikasi Build + Commit + Tag + Push
#
# Digunakan di komputer/repo pusat sebelum push ke GitHub supaya semua server
# sekolah otomatis mendeteksi versi baru (v1.0.1, v1.1.0, dst.) dan auto-pull.
# ==============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$APP_DIR"

BUMP_TYPE="${1:-patch}"
if [[ "$BUMP_TYPE" == "-h" || "$BUMP_TYPE" == "--help" ]]; then
  cat <<'EOF'
Penggunaan:
  npm run release:patch -- "Keterangan perbaikan bug"
  npm run release:minor -- "Keterangan fitur baru"
  npm run release:major -- "Keterangan perubahan besar"
  bash scripts/release.sh <patch|minor|major|X.Y.Z> [--message "..."] [--no-push] [--dry-run] [--skip-checks]

Opsi:
  -m, --message <teks>   Pesan commit rilis
  --no-push              Hanya commit & buat tag lokal tanpa git push ke GitHub
  --dry-run              Simulasi tanpa mengubah file atau git
  --skip-checks          Lewati npm run lint, unit test, & npm run build
EOF
  exit 0
fi
shift || true

COMMIT_MSG=""
NO_PUSH=0
DRY_RUN=0
SKIP_CHECKS=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    -m|--message)
      COMMIT_MSG="${2:-}"
      shift 2
      ;;
    --no-push)
      NO_PUSH=1
      shift
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --skip-checks)
      SKIP_CHECKS=1
      shift
      ;;
    --)
      shift
      ;;
    *)
      if [[ -z "$COMMIT_MSG" ]]; then
        COMMIT_MSG="$1"
      else
        COMMIT_MSG="${COMMIT_MSG} $1"
      fi
      shift
      ;;
  esac
done

command -v node >/dev/null 2>&1 || { echo "ERROR: Node.js tidak ditemukan." >&2; exit 1; }
command -v git >/dev/null 2>&1 || { echo "ERROR: Git tidak ditemukan." >&2; exit 1; }

git rev-parse --is-inside-work-tree >/dev/null 2>&1 || {
  echo "ERROR: Folder ini bukan repositori Git." >&2
  exit 1
}

CURRENT_VER="$(node -e 'const p=require("./package.json"); process.stdout.write(String(p.version||"1.0.0"));')"
NEXT_VER="$(node -e '
  const cur = process.argv[1].replace(/^v/i, "").trim();
  const mode = process.argv[2].trim();
  const explicit = mode.match(/^v?(\d+)\.(\d+)\.(\d+)$/i);
  if (explicit) {
    process.stdout.write(`${Number(explicit[1])}.${Number(explicit[2])}.${Number(explicit[3])}`);
    process.exit(0);
  }
  const m = cur.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) {
    console.error("Versi package.json tidak valid:", cur);
    process.exit(1);
  }
  let maj = Number(m[1]), min = Number(m[2]), pat = Number(m[3]);
  if (mode === "major") { maj += 1; min = 0; pat = 0; }
  else if (mode === "minor") { min += 1; pat = 0; }
  else if (mode === "patch") { pat += 1; }
  else {
    console.error("Tipe rilis tidak dikenal (pakai patch | minor | major | X.Y.Z):", mode);
    process.exit(1);
  }
  process.stdout.write(`${maj}.${min}.${pat}`);
' "$CURRENT_VER" "$BUMP_TYPE")"

echo "[release] Versi saat ini : v${CURRENT_VER}"
echo "[release] Versi berikutnya: v${NEXT_VER}"

if [[ "$SKIP_CHECKS" -eq 0 ]]; then
  echo "[release] Memeriksa TypeScript (npm run lint)..."
  npm run lint
  echo "[release] Menjalankan unit test inti..."
  npx --yes tsx --test src/lib/*.test.ts
  echo "[release] Memverifikasi build produksi (npm run build)..."
  npm run build
fi

FINAL_MSG="release: v${NEXT_VER}"
if [[ -n "$COMMIT_MSG" ]]; then
  FINAL_MSG="release: v${NEXT_VER} — ${COMMIT_MSG}"
fi

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "[release][DRY-RUN] Akan memperbarui package.json ke ${NEXT_VER}"
  echo "[release][DRY-RUN] Akan commit: ${FINAL_MSG} + tag v${NEXT_VER}"
  [[ "$NO_PUSH" -eq 0 ]] && echo "[release][DRY-RUN] Akan menjalankan: git push origin HEAD --tags"
  exit 0
fi

node -e '
  const fs = require("fs");
  const nextVer = process.argv[1];
  const pkg = JSON.parse(fs.readFileSync("./package.json", "utf8"));
  pkg.version = nextVer;
  fs.writeFileSync("./package.json", JSON.stringify(pkg, null, 2) + "\n");
  if (fs.existsSync("./package-lock.json")) {
    try {
      const lock = JSON.parse(fs.readFileSync("./package-lock.json", "utf8"));
      lock.version = nextVer;
      if (lock.packages && lock.packages[""]) {
        lock.packages[""].version = nextVer;
      }
      fs.writeFileSync("./package-lock.json", JSON.stringify(lock, null, 2) + "\n");
    } catch {}
  }
' "$NEXT_VER"

git add -A
if git diff --cached --quiet; then
  echo "[release] Tidak ada perubahan baru untuk di-commit."
else
  git commit -m "$FINAL_MSG"
fi

if git rev-parse "v${NEXT_VER}" >/dev/null 2>&1; then
  echo "[release] Tag v${NEXT_VER} sudah ada; melewati pembuatan tag."
else
  git tag -a "v${NEXT_VER}" -m "$FINAL_MSG"
fi

if [[ "$NO_PUSH" -eq 1 ]]; then
  echo "[release] Selesai lokal (--no-push): v${NEXT_VER}. Jalankan 'git push origin HEAD --tags' saat siap kirim ke semua sekolah."
else
  REMOTE_NAME="${GIT_REMOTE:-origin}"
  BRANCH_NAME="$(git symbolic-ref --quiet --short HEAD 2>/dev/null || echo 'main')"
  echo "[release] Mengirim v${NEXT_VER} ke GitHub (${REMOTE_NAME}/${BRANCH_NAME} + tag)..."
  git push "$REMOTE_NAME" "$BRANCH_NAME" --tags
  echo "[release] SUKSES! Rilis v${NEXT_VER} sudah di GitHub. Semua server sekolah akan auto-pull otomatis."
fi
