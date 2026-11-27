#!/usr/bin/env python3
"""
scripts/parity_check.py — Offline Cosine Parity Verification: Python InsightFace vs Rust face-engine.

This script verifies that the Rust ArcFace implementation (w600k_r50.onnx via ort)
matches Python InsightFace w600k_r50.onnx on the exact same 112x112 aligned face crop.
Expected Cosine Similarity: >= 0.999.
"""

import sys
import os
import json
import subprocess
import tempfile

def check_requirements():
    try:
        import numpy as np
        import onnxruntime as ort
        return True
    except ImportError:
        return False

def generate_synthetic_aligned_crop(output_path: str):
    """Generates a deterministic synthetic 112x112 RGB test crop (PPM format)."""
    width = 112
    height = 112
    # Deterministic pattern: gradient + circle simulating face features
    ppm_header = f"P6\n{width} {height}\n255\n".encode("ascii")
    pixels = bytearray(width * height * 3)
    idx = 0
    for y in range(height):
        for x in range(width):
            # Centered ellipse + gradient
            dx = (x - 56) / 40.0
            dy = (y - 56) / 50.0
            in_ellipse = (dx * dx + dy * dy) <= 1.0
            r = int(180 + 40 * dx) if in_ellipse else int(30 + y)
            g = int(140 + 30 * dy) if in_ellipse else int(40 + x)
            b = int(120 - 20 * dx) if in_ellipse else int(50)
            pixels[idx] = max(0, min(255, r))
            pixels[idx + 1] = max(0, min(255, g))
            pixels[idx + 2] = max(0, min(255, b))
            idx += 3

    # Convert to PNG using ffmpeg or write raw PPM
    # ffmpeg is universally available in our environment
    with tempfile.NamedTemporaryFile(suffix=".ppm", delete=False) as f_ppm:
        f_ppm.write(ppm_header + pixels)
        ppm_name = f_ppm.name

    try:
        cmd = ["ffmpeg", "-y", "-i", ppm_name, output_path]
        subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)
    finally:
        if os.path.exists(ppm_name):
            os.remove(ppm_name)

def run_python_arcface(model_path: str, image_path: str):
    import numpy as np
    import onnxruntime as ort
    from PIL import Image

    # Load image and ensure 112x112 RGB
    img = Image.open(image_path).convert("RGB")
    if img.size != (112, 112):
        img = img.resize((112, 112))

    arr = np.array(img, dtype=np.float32)
    # ArcFace preprocessing: (pixel - 127.5) / 127.5, shape (1, 3, 112, 112)
    arr = (arr - 127.5) / 127.5
    # HWC to CHW
    arr = np.transpose(arr, (2, 0, 1))
    arr = np.expand_dims(arr, axis=0)

    session = ort.InferenceSession(model_path, providers=["CPUExecutionProvider"])
    input_name = session.get_inputs()[0].name
    outputs = session.run(None, {input_name: arr})
    emb = outputs[0][0].astype(np.float64)
    # L2 normalize
    norm = np.linalg.norm(emb)
    if norm > 1e-9:
        emb = emb / norm
    return emb

def run_rust_arcface(engine_bin: str, image_path: str):
    cmd = [engine_bin, "embed-crop", "--image", image_path]
    res = subprocess.run(cmd, capture_output=True, text=True, check=True)
    emb_data = json.loads(res.stdout)
    return emb_data

def main():
    if len(sys.argv) < 3:
        print(f"Usage: {sys.argv[0]} <face-engine-bin> <w600k_r50.onnx> [test-crop.png]")
        sys.exit(1)

    engine_bin = sys.argv[1]
    model_path = sys.argv[2]
    crop_path = sys.argv[3] if len(sys.argv) > 3 else None

    if not os.path.exists(engine_bin):
        print(json.dumps({"ok": False, "error": f"Engine binary not found: {engine_bin}"}))
        sys.exit(1)

    if not os.path.exists(model_path):
        print(json.dumps({"ok": False, "error": f"Model not found: {model_path}"}))
        sys.exit(1)

    if not check_requirements():
        print(json.dumps({
            "ok": True,
            "skipped": True,
            "reason": "Host python lacks numpy / onnxruntime. Parity will be evaluated inside docker."
        }))
        sys.exit(0)

    import numpy as np

    temp_crop = False
    if not crop_path or not os.path.exists(crop_path):
        with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as f:
            crop_path = f.name
            temp_crop = True
        generate_synthetic_aligned_crop(crop_path)

    try:
        emb_py = run_python_arcface(model_path, crop_path)
        emb_rust_raw = run_rust_arcface(engine_bin, crop_path)
        emb_rust = np.array(emb_rust_raw, dtype=np.float64)

        if len(emb_py) != 512 or len(emb_rust) != 512:
            print(json.dumps({
                "ok": False,
                "error": f"Dimension mismatch: py={len(emb_py)}, rust={len(emb_rust)}"
            }))
            sys.exit(1)

        cosine = float(np.dot(emb_py, emb_rust))
        diff_max = float(np.max(np.abs(emb_py - emb_rust)))

        passed = cosine >= 0.999
        result = {
            "ok": True,
            "passed": passed,
            "cosine_similarity": cosine,
            "max_abs_diff": diff_max,
            "dims": 512,
            "threshold": 0.999
        }
        print(json.dumps(result, indent=2))
        sys.exit(0 if passed else 1)
    finally:
        if temp_crop and os.path.exists(crop_path):
            os.remove(crop_path)

if __name__ == "__main__":
    main()
