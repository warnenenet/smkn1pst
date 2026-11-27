#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
OUT_DIR="${OUT_DIR:-$SCRIPT_DIR/out}"

DB_PATH="${DB_PATH:-$REPO_ROOT/data/absensi.sqlite}"
MODELS_DIR="${MODELS_DIR:-/opt/face-models}"
VIDEO_PATH="${VIDEO_PATH:-}"
PORTRAIT_PATH="${PORTRAIT_PATH:-}"
MAX_FRAMES="${MAX_FRAMES:-300}"
SAMPLE_FPS="${SAMPLE_FPS:-}"
INTRA_THREADS="${INTRA_THREADS:-4}"
DET_THRESH="${DET_THRESH:-0.50}"
MATCH_THRESH="${MATCH_THRESH:-0.60}"
MIN_MARGIN="${MIN_MARGIN:-0.08}"
PYTHON_BIN="${PYTHON_BIN:-python3}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --db) DB_PATH="$2"; shift 2 ;;
    --models-dir) MODELS_DIR="$2"; shift 2 ;;
    --video) VIDEO_PATH="$2"; shift 2 ;;
    --portrait) PORTRAIT_PATH="$2"; shift 2 ;;
    --max-frames) MAX_FRAMES="$2"; shift 2 ;;
    --sample-fps) SAMPLE_FPS="$2"; shift 2 ;;
    --intra-threads) INTRA_THREADS="$2"; shift 2 ;;
    --det-thresh) DET_THRESH="$2"; shift 2 ;;
    --match-thresh) MATCH_THRESH="$2"; shift 2 ;;
    --min-margin) MIN_MARGIN="$2"; shift 2 ;;
    --python) PYTHON_BIN="$2"; shift 2 ;;
    *) echo "Unknown arg: $1" >&2; exit 2 ;;
  esac
done

mkdir -p "$OUT_DIR" "$MODELS_DIR"

echo "[Gate A] Checking prerequisites..."
command -v rustc >/dev/null 2>&1 || { echo "FATAL: rustc not found" >&2; exit 1; }
command -v cargo >/dev/null 2>&1 || { echo "FATAL: cargo not found" >&2; exit 1; }
command -v ffmpeg >/dev/null 2>&1 || { echo "FATAL: ffmpeg not found" >&2; exit 1; }
command -v "$PYTHON_BIN" >/dev/null 2>&1 || { echo "FATAL: $PYTHON_BIN not found" >&2; exit 1; }

RUSTC_VER="$(rustc --version)"
echo "[Gate A] rustc: $RUSTC_VER"

# Verify libmediapipe.so (airgapped/wheel path)
if [[ -z "${MEDIAPIPE_LIB:-}" || ! -f "${MEDIAPIPE_LIB:-}" ]]; then
  FOUND_MP="$(find "$MODELS_DIR" /root/.cache /opt -name 'libmediapipe.so' 2>/dev/null | head -n 1 || true)"
  if [[ -z "$FOUND_MP" ]]; then
    echo "[Gate A] libmediapipe.so not set; extracting from official mediapipe==0.10.35 manylinux wheel into $MODELS_DIR..."
    WHL_PATH="$MODELS_DIR/mediapipe-0.10.35-py3-none-manylinux_2_28_x86_64.whl"
    if [[ ! -f "$WHL_PATH" ]]; then
      curl -fsSL -o "$WHL_PATH" "https://files.pythonhosted.org/packages/py3/m/mediapipe/mediapipe-0.10.35-py3-none-manylinux_2_28_x86_64.whl" || \
        "$PYTHON_BIN" -m pip download --no-deps --only-binary=:all: -d "$MODELS_DIR" mediapipe==0.10.35
      WHL_PATH="$(ls -1 "$MODELS_DIR"/mediapipe-*.whl | head -n 1)"
    fi
    "$PYTHON_BIN" -c "
import zipfile, sys
whl = sys.argv[1]
dst = sys.argv[2]
with zipfile.ZipFile(whl) as z:
    targets = [n for n in z.namelist() if n.endswith('libmediapipe.so')]
    if not targets:
        raise SystemExit('libmediapipe.so not found inside wheel')
    with z.open(targets[0]) as src, open(dst, 'wb') as out:
        out.write(src.read())
" "$WHL_PATH" "$MODELS_DIR/libmediapipe.so"
    FOUND_MP="$MODELS_DIR/libmediapipe.so"
  fi
  export MEDIAPIPE_LIB="$FOUND_MP"
fi
echo "[Gate A] Using MEDIAPIPE_LIB=$MEDIAPIPE_LIB"

DET_TFLITE="$MODELS_DIR/blaze_face_short_range.tflite"
LM_TASK="$MODELS_DIR/face_landmarker.task"
DET_ONNX="${DET_ONNX:-$MODELS_DIR/det_10g.onnx}"
ARC_ONNX="${ARC_ONNX:-$MODELS_DIR/w600k_r50.onnx}"

if [[ ! -f "$DET_TFLITE" ]]; then
  curl -fsSL -o "$DET_TFLITE" "https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite"
fi
if [[ ! -f "$LM_TASK" ]]; then
  curl -fsSL -o "$LM_TASK" "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task"
fi
if [[ ! -f "$DET_ONNX" ]]; then
  FOUND_DET="$(find /root /opt /var/www -name 'det_10g.onnx' 2>/dev/null | head -n 1 || true)"
  if [[ -n "$FOUND_DET" ]]; then DET_ONNX="$FOUND_DET"; fi
fi
if [[ ! -f "$ARC_ONNX" ]]; then
  FOUND_ARC="$(find /root /opt /var/www -name 'w600k_r50.onnx' 2>/dev/null | head -n 1 || true)"
  if [[ -n "$FOUND_ARC" ]]; then ARC_ONNX="$FOUND_ARC"; fi
fi

for req in "$DET_TFLITE" "$LM_TASK" "$DET_ONNX" "$ARC_ONNX"; do
  [[ -f "$req" ]] || { echo "FATAL: missing required model file: $req" >&2; exit 1; }
done

if [[ -z "$PORTRAIT_PATH" ]]; then
  if [[ -f "$REPO_ROOT/src/assets/images/student_portrait_one_e4214b46.jpg" ]]; then
    PORTRAIT_PATH="$REPO_ROOT/src/assets/images/student_portrait_one_e4214b46.jpg"
  else
    PORTRAIT_PATH="$MODELS_DIR/portrait.jpg"
    [[ -f "$PORTRAIT_PATH" ]] || curl -fsSL -o "$PORTRAIT_PATH" "https://storage.googleapis.com/mediapipe-assets/portrait.jpg"
  fi
fi

echo "[Gate A] Running Rust unit tests and release build..."
cd "$SCRIPT_DIR"
cargo test --release
cargo build --release
BIN="$SCRIPT_DIR/target/release/gate_a_spike"

FFMPEG_DEV_HEADERS="no"
if pkg-config --exists libavcodec libavformat libavutil libswscale 2>/dev/null; then
  FFMPEG_DEV_HEADERS="yes"
fi

CPU_MODEL="$(lscpu | awk -F: '/Model name/{gsub(/^ +/, "", $2); print $2; exit}')"
NPROC="$(nproc)"
CRATE_VERSIONS="$("$PYTHON_BIN" -c '
import pathlib, re
lock = pathlib.Path("Cargo.lock")
res = {}
if lock.exists():
    txt = lock.read_text()
    for blk in txt.split("[[package]]"):
        m_n = re.search(r"name = \"([^\"]+)\"", blk)
        m_v = re.search(r"version = \"([^\"]+)\"", blk)
        if m_n and m_v and m_n.group(1) in ("mediapipe", "ort", "rusqlite", "image", "clap", "sha2"):
            res[m_n.group(1)] = m_v.group(1)
import json; print(json.dumps(res))
')"

"$PYTHON_BIN" -c '
import json, os, sys
meta = {
    "rustc_version": sys.argv[1],
    "cpu_model": sys.argv[2],
    "nproc": int(sys.argv[3]),
    "mediapipe_lib": sys.argv[4],
    "ffmpeg_dev_headers": sys.argv[5],
    "crate_versions": json.loads(sys.argv[6]),
}
with open(sys.argv[7], "w") as f:
    json.dump(meta, f, indent=2)
' "$RUSTC_VER" "$CPU_MODEL" "$NPROC" "$MEDIAPIPE_LIB" "$FFMPEG_DEV_HEADERS" "$CRATE_VERSIONS" "$OUT_DIR/env_meta.json"

echo "[Gate A] 1/5 Auditing SQLite DB: $DB_PATH"
"$BIN" audit-db --db "$DB_PATH" > "$OUT_DIR/audit_db.json"

echo "[Gate A] 2/5 Verifying MediaPipe .tflite and .task formats on $PORTRAIT_PATH"
"$BIN" verify-mediapipe \
  --detector-tflite "$DET_TFLITE" \
  --landmarker-task "$LM_TASK" \
  --image "$PORTRAIT_PATH" > "$OUT_DIR/verify_mp.json"

echo "[Gate A] 3/5 Comparing LMEDS vs LS alignment & saving identical 112x112 crop"
"$BIN" compare-alignment \
  --arcface-onnx "$ARC_ONNX" \
  --det-onnx "$DET_ONNX" \
  --image "$PORTRAIT_PATH" \
  --intra-threads "$INTRA_THREADS" \
  --save-lmeds-crop "$OUT_DIR/crop_lmeds_112.png" \
  --save-ls-crop "$OUT_DIR/crop_ls_112.png" > "$OUT_DIR/alignment_rust.json"

"$PYTHON_BIN" "$SCRIPT_DIR/python_baseline.py" alignment \
  --arcface-onnx "$ARC_ONNX" \
  --rust-align-json "$OUT_DIR/alignment_rust.json" \
  --intra-threads "$INTRA_THREADS" > "$OUT_DIR/alignment_py.json"

echo "[Gate A] 4/5 Comparing Rust ort vs Python onnxruntime on identical 112x112 crop"
"$BIN" compare-embedder \
  --arcface-onnx "$ARC_ONNX" \
  --crop-112 "$OUT_DIR/crop_lmeds_112.png" \
  --intra-threads "$INTRA_THREADS" > "$OUT_DIR/embedder_rust.json"

"$PYTHON_BIN" "$SCRIPT_DIR/python_baseline.py" embedder \
  --arcface-onnx "$ARC_ONNX" \
  --crop-112 "$OUT_DIR/crop_lmeds_112.png" \
  --rust-json "$OUT_DIR/embedder_rust.json" \
  --intra-threads "$INTRA_THREADS" > "$OUT_DIR/embedder_py.json"

if [[ -n "$VIDEO_PATH" ]]; then
  [[ -f "$VIDEO_PATH" ]] || { echo "FATAL: video not found: $VIDEO_PATH" >&2; exit 1; }
  echo "[Gate A] 5/5 Benchmarking Path A, Path B, and Python baseline on $VIDEO_PATH"
  EXTRA_FPS_ARGS=()
  if [[ -n "$SAMPLE_FPS" ]]; then
    EXTRA_FPS_ARGS+=(--sample-fps "$SAMPLE_FPS")
  fi

  "$BIN" bench-paths \
    --video "$VIDEO_PATH" \
    --db "$DB_PATH" \
    --detector-tflite "$DET_TFLITE" \
    --landmarker-task "$LM_TASK" \
    --det-onnx "$DET_ONNX" \
    --arcface-onnx "$ARC_ONNX" \
    --max-frames "$MAX_FRAMES" \
    --intra-threads "$INTRA_THREADS" \
    --det-thresh "$DET_THRESH" \
    --match-thresh "$MATCH_THRESH" \
    --min-margin "$MIN_MARGIN" \
    --mode path-a "${EXTRA_FPS_ARGS[@]}" > "$OUT_DIR/bench_path_a.json"

  "$BIN" bench-paths \
    --video "$VIDEO_PATH" \
    --db "$DB_PATH" \
    --detector-tflite "$DET_TFLITE" \
    --landmarker-task "$LM_TASK" \
    --det-onnx "$DET_ONNX" \
    --arcface-onnx "$ARC_ONNX" \
    --max-frames "$MAX_FRAMES" \
    --intra-threads "$INTRA_THREADS" \
    --det-thresh "$DET_THRESH" \
    --match-thresh "$MATCH_THRESH" \
    --min-margin "$MIN_MARGIN" \
    --mode path-b "${EXTRA_FPS_ARGS[@]}" > "$OUT_DIR/bench_path_b.json"

  "$PYTHON_BIN" "$SCRIPT_DIR/python_baseline.py" video-baseline \
    --video "$VIDEO_PATH" \
    --db "$DB_PATH" \
    --det-onnx "$DET_ONNX" \
    --arcface-onnx "$ARC_ONNX" \
    --max-frames "$MAX_FRAMES" \
    --intra-threads "$INTRA_THREADS" \
    --det-thresh "$DET_THRESH" \
    --match-thresh "$MATCH_THRESH" \
    --min-margin "$MIN_MARGIN" "${EXTRA_FPS_ARGS[@]}" > "$OUT_DIR/video_py.json"
else
  echo "[Gate A] NOTE: --video not provided; skipping video Path A vs Path B benchmark."
fi

"$PYTHON_BIN" "$SCRIPT_DIR/python_baseline.py" compose-report \
  --env-json "$OUT_DIR/env_meta.json" \
  --audit-db-json "$OUT_DIR/audit_db.json" \
  --verify-mp-json "$OUT_DIR/verify_mp.json" \
  --embedder-py-json "$OUT_DIR/embedder_py.json" \
  --alignment-py-json "$OUT_DIR/alignment_py.json" \
  --bench-a-json "$OUT_DIR/bench_path_a.json" \
  --bench-b-json "$OUT_DIR/bench_path_b.json" \
  --video-py-json "$OUT_DIR/video_py.json" \
  --out-json "$SCRIPT_DIR/gate_a_report.json" \
  --out-md "$SCRIPT_DIR/gate_a_report.md"

echo "[Gate A] COMPLETE. Report written to:"
echo "  - $SCRIPT_DIR/gate_a_report.json"
echo "  - $SCRIPT_DIR/gate_a_report.md"
cat "$SCRIPT_DIR/gate_a_report.md"
