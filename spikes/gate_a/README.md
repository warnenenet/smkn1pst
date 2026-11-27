# Gate A Spike — MediaPipe vs SCRFD + ArcFace (`ort`)

Proyek spike **khusus Gate A** (terpisah dari binary produksi dan **tidak** mengubah skema database SQLite atau menghapus pipeline Python).

## Kriteria Pemilihan Jalur A vs Jalur B (Dinyatakan Sebelum Angka Masuk)

Keputusan pemilihan antara **Jalur A (MediaPipe)** dan **Jalur B (SCRFD `det_10g.onnx` via `ort` + alignment LMEDS)** dievaluasi berdasarkan 3 kriteria objektif dan 1 aturan seri:

1. **Recall wajah `>= 80 px` pada rekaman CCTV nyata**
   - Jalur terpilih harus mampu mendeteksi minimal **>= 95%** wajah berukuran lebar `>= 80 px` (dalam koordinat frame asli, e.g. 1080p) dibanding baseline Python SCRFD pada rekaman kelas/gerbang nyata.
   - Dilaporkan per bucket lebar wajah: `<40`, `40-59`, `60-79`, `80-99`, `100-129`, `>=130` px.
2. **Latensi `p95` ms/frame dalam anggaran 8 stream @ 10 FPS**
   - Anggaran total pipeline produksi: 8 kamera @ 10 FPS = 80 frame/detik pada host 8 core / 16 thread.
   - Dengan arsitektur terukur, `p95` per frame harus masuk anggaran (`<= 80 ms/frame` per worker, target sehat `<= 50 ms/frame` agar ada headroom untuk Node.js, SQLite, dan WA Gateway) dan **RSS** terukur stabil.
3. **Kompatibilitas dengan galeri lama (`students.embedding`)**
   - Pada crop `112x112` identik, embedding Rust `w600k_r50.onnx` (`ort`) harus mencapai cosine **>= 0.999** terhadap Python `onnxruntime`.
   - Top-1 student match dan distribusi skor terhadap `students.embedding` lama harus konsisten (tidak menurunkan margin `top1 - top2` atau memicu lonjakan false match pada wajah anak).
4. **Aturan Seri (Tie-Breaker)**
   - **Jika Jalur A mengharuskan reindex galeri lama (5000 profil siswa harus di-re-enroll) dan Jalur B tidak mengharuskan reindex, maka Jalur B menang saat hasil seri.**

## Cara Menjalankan di VPS

```bash
cd /path/ke/repo
chmod +x spikes/gate_a/run_gate_a.sh

# Contoh dengan 1 atau beberapa rekaman CCTV nyata + database SQLite + direktori model:
./spikes/gate_a/run_gate_a.sh \
  --db data/absensi.sqlite \
  --models-dir /opt/face-models \
  --video /path/ke/rekaman_gate_1080p.mp4 \
  --max-frames 300
```

Skrip `run_gate_a.sh` akan:
1. Mengecek `rustc >= 1.85`, mengekstrak `libmediapipe.so` (atau memakai `$MEDIAPIPE_LIB`), dan memverifikasi format & SHA256 model (`.tflite` vs `.task` vs `.onnx`).
2. Menjalankan `cargo test` & `cargo build --release`.
3. Menjalankan audit SQLite `students.embedding` (L2 norm, NULL count, dimensi).
4. Memverifikasi format model & orientasi landmark `mediapipe` (`FaceDetector` `.tflite` dan `FaceLandmarker` `.task`).
5. Mengukur kesetaraan embedder `w600k_r50.onnx` Rust vs Python pada crop `112x112` identik.
6. Mengukur dampak alignment **LMEDS vs Least-Squares (Umeyama)** pada 5 titik yang sama (matriks transform + cosine embedding).
7. Menjalankan **Jalur A**, **Jalur B**, dan **Python baseline** pada rekaman dan galeri yang sama.
8. Menulis **satu laporan gabungan**: `spikes/gate_a/gate_a_report.json` dan `spikes/gate_a/gate_a_report.md`.
