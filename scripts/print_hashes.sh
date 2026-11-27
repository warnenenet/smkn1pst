#!/usr/bin/env bash
set -Eeuo pipefail

# ==============================================================================
# scripts/print_hashes.sh — Cetak Hash SHA256 Model & Library ONNX Runtime
#
# Membaca atau menghitung sidik jari SHA256 dari 3 komponen biometrik:
#   1. det_10g.onnx (SCRFD Face Detector)
#   2. w600k_r50.onnx (ArcFace 512-D Embedding)
#   3. libonnxruntime.so (ONNX Runtime Engine)
#
# Sumber pemeriksaan:
#   - Jika Docker image absensi-smk-face-ai:latest sudah ter-build, membaca
#     file pin SHA256 resmi dari dalam container.
#   - Jika container aktif, membaca dari container yang sedang berjalan.
#   - Jika file ada di host lokal, menghitung langsung dengan sha256sum.
# ==============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$APP_DIR"

APPLY_ENV=0
IMAGE_NAME="absensi-smk-face-ai:latest"
CONTAINER_NAME="absensi-smk-allinone"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --apply) APPLY_ENV=1; shift ;;
    --image) IMAGE_NAME="$2"; shift 2 ;;
    --container) CONTAINER_NAME="$2"; shift 2 ;;
    -h|--help)
      cat <<'EOF'
Penggunaan: bash scripts/print_hashes.sh [opsi]

Opsi:
  --apply        Tulis/perbarui nilai hash yang ditemukan langsung ke file .env
  --image <tag>  Nama image Docker yang diperiksa (default: absensi-smk-face-ai:latest)
  -h, --help     Tampilkan bantuan ini
EOF
      exit 0
      ;;
    *) echo "Opsi tidak dikenal: $1" >&2; exit 1 ;;
  esac
done

DET_HASH=""
REC_HASH=""
ORT_HASH=""
SOURCE_DETECTED="NONE"

# 1. Coba baca dari container aktif
if command -v docker >/dev/null 2>&1 && docker ps --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
  SOURCE_DETECTED="Container aktif (${CONTAINER_NAME})"
  DET_HASH="$(docker exec "$CONTAINER_NAME" sh -c "cat /app/models/det_10g.sha256 2>/dev/null || sha256sum /app/models/insightface/models/buffalo_l/det_10g.onnx 2>/dev/null" | awk '{print $1}')"
  REC_HASH="$(docker exec "$CONTAINER_NAME" sh -c "cat /app/models/w600k_r50.sha256 2>/dev/null || sha256sum /app/models/insightface/models/buffalo_l/w600k_r50.onnx 2>/dev/null" | awk '{print $1}')"
  ORT_HASH="$(docker exec "$CONTAINER_NAME" sh -c "cat /app/models/ort_dylib.sha256 2>/dev/null || sha256sum /usr/local/lib/libonnxruntime.so 2>/dev/null" | awk '{print $1}')"
fi

# 2. Coba baca dari image Docker lokal (jika belum didapat dari container aktif)
if [[ -z "$DET_HASH" || -z "$REC_HASH" || -z "$ORT_HASH" ]]; then
  if command -v docker >/dev/null 2>&1 && docker image inspect "$IMAGE_NAME" >/dev/null 2>&1; then
    SOURCE_DETECTED="Docker image (${IMAGE_NAME})"
    DET_HASH="$(docker run --rm --entrypoint /bin/sh "$IMAGE_NAME" -c "cat /app/models/det_10g.sha256 2>/dev/null || sha256sum /app/models/insightface/models/buffalo_l/det_10g.onnx 2>/dev/null" | awk '{print $1}')"
    REC_HASH="$(docker run --rm --entrypoint /bin/sh "$IMAGE_NAME" -c "cat /app/models/w600k_r50.sha256 2>/dev/null || sha256sum /app/models/insightface/models/buffalo_l/w600k_r50.onnx 2>/dev/null" | awk '{print $1}')"
    ORT_HASH="$(docker run --rm --entrypoint /bin/sh "$IMAGE_NAME" -c "cat /app/models/ort_dylib.sha256 2>/dev/null || sha256sum /usr/local/lib/libonnxruntime.so 2>/dev/null" | awk '{print $1}')"
  fi
fi

# 3. Coba cari file model di sistem file host lokal
if [[ -z "$DET_HASH" || -z "$REC_HASH" ]]; then
  for dir in "$APP_DIR/models" "$APP_DIR/data/models" "$HOME/.insightface/models/buffalo_l" "/root/.insightface/models/buffalo_l"; do
    if [[ -f "$dir/det_10g.onnx" ]] && [[ -z "$DET_HASH" ]]; then
      DET_HASH="$(sha256sum "$dir/det_10g.onnx" | awk '{print $1}')"
      SOURCE_DETECTED="File host ($dir)"
    fi
    if [[ -f "$dir/w600k_r50.onnx" ]] && [[ -z "$REC_HASH" ]]; then
      REC_HASH="$(sha256sum "$dir/w600k_r50.onnx" | awk '{print $1}')"
      SOURCE_DETECTED="File host ($dir)"
    fi
  done
fi

if [[ -z "$ORT_HASH" ]]; then
  for so in "/usr/local/lib/libonnxruntime.so" "/usr/lib/libonnxruntime.so"; do
    if [[ -f "$so" ]]; then
      ORT_HASH="$(sha256sum "$so" | awk '{print $1}')"
    fi
  done
fi

echo "========================================================================"
echo " HASIL PEMERIKSAAN SIDIK JARI (SHA256) BIOMETRIK ENGINE"
echo " Sumber Deteksi: ${SOURCE_DETECTED}"
echo "========================================================================"
echo ""

if [[ -n "$DET_HASH" && -n "$REC_HASH" && -n "$ORT_HASH" ]]; then
  echo "Nilai SHA256 berhasil diperoleh. Salin teks di bawah ke form konfigurasi Anda:"
  echo ""
  echo "------------------------------------------------------------------------"
  printf "DET_MODEL_SHA256=%s\n" "$DET_HASH"
  printf "REC_MODEL_SHA256=%s\n" "$REC_HASH"
  printf "ORT_DYLIB_SHA256=%s\n" "$ORT_HASH"
  echo "------------------------------------------------------------------------"
  echo ""
  echo "Penjelasan Ringkas:"
  echo "  - DET_MODEL_SHA256 : Hash dari model deteksi SCRFD (det_10g.onnx)"
  echo "  - REC_MODEL_SHA256 : Hash dari model pengenal ArcFace (w600k_r50.onnx)"
  echo "  - ORT_DYLIB_SHA256 : Hash dari binary pustaka ONNX Runtime (libonnxruntime.so)"
  echo ""

  if [[ "$APPLY_ENV" -eq 1 ]]; then
    ENV_FILE="$APP_DIR/.env"
    if [[ ! -f "$ENV_FILE" ]] && [[ -f "$APP_DIR/.env.example" ]]; then
      cp "$APP_DIR/.env.example" "$ENV_FILE"
    fi
    if [[ -f "$ENV_FILE" ]]; then
      # Ganti atau tambahkan
      for var in "DET_MODEL_SHA256" "REC_MODEL_SHA256" "ORT_DYLIB_SHA256"; do
        val="${!var}"
        if grep -q "^${var}=" "$ENV_FILE"; then
          sed -i "s|^${var}=.*|${var}=${val}|" "$ENV_FILE"
        else
          echo "${var}=${val}" >> "$ENV_FILE"
        fi
      done
      echo "[OK] Nilai hash otomatis diperbarui di file .env!"
    fi
  fi
else
  echo "PERHATIAN: Image Docker belum dibangun atau file model belum ada di host."
  echo ""
  echo "Langkah termudah untuk mendapatkan hash persis yang masuk ke container:"
  echo "1. Bangun image Docker terlebih dahulu:"
  echo "     docker compose build"
  echo ""
  echo "2. Jalankan ulang script ini:"
  echo "     bash scripts/print_hashes.sh"
  echo ""
  echo "Catatan penting untuk form konfigurasi Anda:"
  echo "- Jika Anda mengosongkan DET_MODEL_SHA256, REC_MODEL_SHA256, dan ORT_DYLIB_SHA256,"
  echo "  container All-in-One secara otomatis memakai hash resmi yang tertanam saat build,"
  echo "  sehingga container TETAP aman dan TETAP lolos pemeriksaan integritas startup."
  echo "- Jika form mewajibkan isi, jalankan 'docker compose build' terlebih dahulu lalu"
  echo "  jalankan 'bash scripts/print_hashes.sh'."
fi
echo "========================================================================"
