export interface Point2D {
  x: number;
  y: number;
}

export interface BBoxXYXY {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/**
 * 5 landmark wajib dalam koordinat gambar:
 * - leftEye: mata sisi kiri gambar (x lebih kecil dari rightEye.x)
 * - rightEye: mata sisi kanan gambar
 * - nose: puncak/titik tengah hidung
 * - mouthLeft: sudut mulut sisi kiri gambar
 * - mouthRight: sudut mulut sisi kanan gambar
 */
export interface FiveLandmarks {
  leftEye: Point2D;
  rightEye: Point2D;
  nose: Point2D;
  mouthLeft: Point2D;
  mouthRight: Point2D;
}

export type PartialFiveLandmarks = Partial<{
  leftEye: Point2D | null;
  rightEye: Point2D | null;
  nose: Point2D | null;
  mouthLeft: Point2D | null;
  mouthRight: Point2D | null;
}> | null | undefined;

export type GateRejectionReason = 'confidence' | 'landmark' | 'size' | 'blur' | 'pose';

export interface FaceQualityGateConfig {
  threshold_confidence: number;
  min_face_size: number;
  max_face_size?: number;
  blur_threshold: number;
  max_yaw_deg: number;
  max_pitch_deg: number;
}

export const DEFAULT_QUALITY_GATE_CONFIG: FaceQualityGateConfig = {
  threshold_confidence: 0.60,
  min_face_size: 60,
  max_face_size: 0,
  blur_threshold: 100,
  max_yaw_deg: 30,
  max_pitch_deg: 25,
};

/**
 * Koordinat referensi ArcFace standar 112x112 (InsightFace alignment).
 */
export const ARCFACE_DST_112: readonly [Point2D, Point2D, Point2D, Point2D, Point2D] = [
  { x: 38.2946, y: 51.6963 },
  { x: 73.5318, y: 51.5014 },
  { x: 56.0252, y: 71.7366 },
  { x: 41.5493, y: 92.3655 },
  { x: 70.7299, y: 92.2041 },
];

export interface DetectorResizePlan {
  width: number;
  height: number;
  scaleX: number;
  scaleY: number;
  scaled: boolean;
}

export function computeDownscaleForDetector(
  srcWidth: number,
  srcHeight: number,
  maxSide = 640
): DetectorResizePlan {
  const w = Math.max(1, Math.round(srcWidth));
  const h = Math.max(1, Math.round(srcHeight));
  const cap = Math.max(160, Math.round(maxSide));
  const longest = Math.max(w, h);
  if (longest <= cap) {
    return { width: w, height: h, scaleX: 1, scaleY: 1, scaled: false };
  }
  const ratio = cap / longest;
  const dstW = Math.max(2, Math.round(w * ratio));
  const dstH = Math.max(2, Math.round(h * ratio));
  return {
    width: dstW,
    height: dstH,
    scaleX: w / dstW,
    scaleY: h / dstH,
    scaled: true,
  };
}

export function downscaleRgbForDetector(
  srcRgb: Uint8Array,
  srcW: number,
  srcH: number,
  maxSide = 640
): { rgb: Uint8Array; plan: DetectorResizePlan } {
  const plan = computeDownscaleForDetector(srcW, srcH, maxSide);
  if (!plan.scaled) {
    return { rgb: srcRgb, plan };
  }
  const { width: dstW, height: dstH } = plan;
  const out = new Uint8Array(dstW * dstH * 3);
  for (let dy = 0; dy < dstH; dy++) {
    const sy = Math.min(srcH - 1, Math.floor((dy * srcH) / dstH));
    const dstRow = dy * dstW * 3;
    const srcRow = sy * srcW * 3;
    for (let dx = 0; dx < dstW; dx++) {
      const sx = Math.min(srcW - 1, Math.floor((dx * srcW) / dstW));
      const s = srcRow + sx * 3;
      const d = dstRow + dx * 3;
      out[d] = srcRgb[s];
      out[d + 1] = srcRgb[s + 1];
      out[d + 2] = srcRgb[s + 2];
    }
  }
  return { rgb: out, plan };
}

function isFinitePoint(pt: Point2D | null | undefined): pt is Point2D {
  return Boolean(pt && Number.isFinite(pt.x) && Number.isFinite(pt.y));
}

export interface LandmarkValidationResult {
  valid: boolean;
  reason?: string;
  eyeDistancePx?: number;
  noseRatio?: number;
}

/**
 * Validasi 5 landmark O(1) — WAJIB menolak jika < 5 landmark atau anatomi tidak masuk akal.
 * Tidak ada fallback bbox-only!
 */
export function validateFiveLandmarks(
  bbox: BBoxXYXY,
  landmarks: PartialFiveLandmarks
): LandmarkValidationResult {
  if (!landmarks) {
    return { valid: false, reason: 'missing_landmarks' };
  }
  const { leftEye, rightEye, nose, mouthLeft, mouthRight } = landmarks;
  if (
    !isFinitePoint(leftEye) ||
    !isFinitePoint(rightEye) ||
    !isFinitePoint(nose) ||
    !isFinitePoint(mouthLeft) ||
    !isFinitePoint(mouthRight)
  ) {
    return { valid: false, reason: 'incomplete_landmarks' };
  }

  const bw = bbox.x2 - bbox.x1;
  const bh = bbox.y2 - bbox.y1;
  if (!(bw > 1) || !(bh > 1)) {
    return { valid: false, reason: 'invalid_bbox' };
  }

  // 1. Semua 5 landmark wajib berada di dalam bbox (margin toleransi 5%)
  const mx = bw * 0.05;
  const my = bh * 0.05;
  const minX = bbox.x1 - mx;
  const maxX = bbox.x2 + mx;
  const minY = bbox.y1 - my;
  const maxY = bbox.y2 + my;
  const pts = [leftEye, rightEye, nose, mouthLeft, mouthRight];
  for (const p of pts) {
    if (p.x < minX || p.x > maxX || p.y < minY || p.y > maxY) {
      return { valid: false, reason: 'landmark_outside_bbox' };
    }
  }

  // 2. Mata kiri (koordinat gambar) harus lebih kiri daripada mata kanan
  if (!(leftEye.x < rightEye.x)) {
    return { valid: false, reason: 'swapped_eyes' };
  }
  if (!(mouthLeft.x < mouthRight.x)) {
    return { valid: false, reason: 'swapped_mouth' };
  }

  // 3. Hidung berada di antara rata-rata mata dan rata-rata mulut secara vertikal
  const eyeMeanY = (leftEye.y + rightEye.y) * 0.5;
  const mouthMeanY = (mouthLeft.y + mouthRight.y) * 0.5;
  if (!(nose.y > eyeMeanY && nose.y < mouthMeanY)) {
    return { valid: false, reason: 'nose_not_between_eyes_and_mouth' };
  }

  // 4. Mulut harus berada di bawah hidung (and automatically below eyes)
  if (!(mouthMeanY > nose.y)) {
    return { valid: false, reason: 'mouth_above_nose' };
  }

  // 5. Jarak antarmata >= 15% lebar bbox
  const eyeDist = Math.hypot(rightEye.x - leftEye.x, rightEye.y - leftEye.y);
  if (eyeDist < 0.15 * bw) {
    return { valid: false, reason: 'eyes_too_close', eyeDistancePx: eyeDist };
  }

  // 6. Rasio proporsi vertikal (nose.y - eye_mean.y) / (mouth_mean.y - nose.y) dalam [0.50, 2.0]
  // Rentang [0.50, 2.0] mengakomodasi sudut CCTV atas (15-25 deg) & kuantisasi wajah kecil, sambil menolak landmark acak.
  const upperSpan = nose.y - eyeMeanY;
  const lowerSpan = mouthMeanY - nose.y;
  if (lowerSpan <= 1e-3) {
    return { valid: false, reason: 'degenerate_lower_face', eyeDistancePx: eyeDist };
  }
  const ratio = upperSpan / lowerSpan;
  if (ratio < 0.5 || ratio > 2.0) {
    return { valid: false, reason: 'proportion_out_of_range', eyeDistancePx: eyeDist, noseRatio: ratio };
  }

  return {
    valid: true,
    eyeDistancePx: eyeDist,
    noseRatio: ratio,
  };
}

export interface PoseEstimateDeg {
  yawDeg: number;
  pitchDeg: number;
  rollDeg: number;
}

/**
 * Estimasi yaw, pitch, dan roll (dalam derajat) secara konsisten dari 5 landmark wajah (O(1)).
 */
export function estimatePoseDegFrom5Pts(landmarks: FiveLandmarks): PoseEstimateDeg {
  const { leftEye, rightEye, nose, mouthLeft, mouthRight } = landmarks;
  const dxEye = rightEye.x - leftEye.x;
  const dyEye = rightEye.y - leftEye.y;
  const eyeDist = Math.max(1e-3, Math.hypot(dxEye, dyEye));
  const rollRad = Math.atan2(dyEye, dxEye);

  const eyeMidX = (leftEye.x + rightEye.x) * 0.5;
  const eyeMidY = (leftEye.y + rightEye.y) * 0.5;
  const mouthMidX = (mouthLeft.x + mouthRight.x) * 0.5;
  const mouthMidY = (mouthLeft.y + mouthRight.y) * 0.5;

  // Putar ke kerangka horizontal mata agar yaw & pitch invarian terhadap roll
  const cosR = Math.cos(-rollRad);
  const sinR = Math.sin(-rollRad);
  const rotNoseX = (nose.x - eyeMidX) * cosR - (nose.y - eyeMidY) * sinR;
  const rotNoseY = (nose.x - eyeMidX) * sinR + (nose.y - eyeMidY) * cosR;
  const rotMouthX = (mouthMidX - eyeMidX) * cosR - (mouthMidY - eyeMidY) * sinR;
  const rotMouthY = (mouthMidX - eyeMidX) * sinR + (mouthMidY - eyeMidY) * cosR;

  // Offset horizontal hidung terhadap titik tengah mata-mulut
  const faceCenterX = rotMouthX * 0.5;
  const halfEye = Math.max(1e-3, eyeDist * 0.5);
  const yawNorm = Math.max(-1, Math.min(1, ((rotNoseX - faceCenterX) / halfEye) * 0.72));
  const yawDeg = (Math.asin(yawNorm) * 180) / Math.PI;

  // Proporsi vertikal hidung antara mata (y=0) dan mulut (y=rotMouthY)
  // Posisi kanonik frontal ~0.495; kepala menengadah -> mengecil, menunduk -> membesar
  const eyeToMouth = Math.max(1e-3, rotMouthY);
  const relNoseY = rotNoseY / eyeToMouth;
  const pitchNorm = (relNoseY - 0.5) / 0.35;
  const pitchDeg = Math.max(-80, Math.min(80, pitchNorm * 45));

  return {
    yawDeg: Math.round(yawDeg * 100) / 100,
    pitchDeg: Math.round(pitchDeg * 100) / 100,
    rollDeg: Math.round(((rollRad * 180) / Math.PI) * 100) / 100,
  };
}

/**
 * Hitung Variance of Laplacian (kernel 3x3 standar: [0,1,0; 1,-4,1; 0,1,0]) pada buffer grayscale.
 */
export function computeLaplacianVarianceGray(gray: Float32Array | Uint8Array, width: number, height: number): number {
  if (width < 3 || height < 3) return 0;
  let sum = 0;
  let sumSq = 0;
  let count = 0;
  for (let y = 1; y < height - 1; y++) {
    const rowOffset = y * width;
    for (let x = 1; x < width - 1; x++) {
      const idx = rowOffset + x;
      const lap =
        gray[idx - width] +
        gray[idx - 1] -
        4 * gray[idx] +
        gray[idx + 1] +
        gray[idx + width];
      sum += lap;
      sumSq += lap * lap;
      count++;
    }
  }
  if (count === 0) return 0;
  const mean = sum / count;
  return Math.max(0, sumSq / count - mean * mean);
}

/**
 * Ekstrak luma (BT.601) dari crop RGBA dan hitung Variance of Laplacian.
 */
export function computeCropLaplacianVarianceRgba(
  rgba: Uint8Array,
  imgW: number,
  imgH: number,
  bbox: BBoxXYXY
): number {
  const x1 = Math.max(0, Math.floor(bbox.x1));
  const y1 = Math.max(0, Math.floor(bbox.y1));
  const x2 = Math.min(imgW, Math.ceil(bbox.x2));
  const y2 = Math.min(imgH, Math.ceil(bbox.y2));
  const cw = x2 - x1;
  const ch = y2 - y1;
  if (cw < 3 || ch < 3) return 0;

  const gray = new Float32Array(cw * ch);
  for (let y = 0; y < ch; y++) {
    const srcRow = (y1 + y) * imgW;
    const dstRow = y * cw;
    for (let x = 0; x < cw; x++) {
      const i = (srcRow + x1 + x) * 4;
      gray[dstRow + x] = 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
    }
  }
  return computeLaplacianVarianceGray(gray, cw, ch);
}

export function laplacianToSharpnessNorm(lapVariance: number): number {
  if (!Number.isFinite(lapVariance) || lapVariance <= 0) return 0;
  return Math.min(1, Math.max(0, lapVariance / 200));
}

export interface GateEvaluationInput {
  confidence: number;
  bbox: BBoxXYXY;
  landmarks: PartialFiveLandmarks;
  minFaceSizeOverridePx?: number;
  maxFaceSizeOverridePx?: number;
  computeBlurVariance: () => number;
  poseOverrideDeg?: { yawDeg: number; pitchDeg: number } | null;
}

export interface GateEvaluationResult {
  passed: boolean;
  reason: GateRejectionReason | null;
  detail: string | null;
  faceSizePx: number;
  blurVariance: number | null;
  yawDeg: number | null;
  pitchDeg: number | null;
  frontalScore: number;
}

/**
 * Pipeline bertingkat (termurah -> termahal). Berhenti seketika pada langkah yang gagal.
 * Urutan:
 * 2. Confidence < threshold_confidence
 * 3. Validasi 5 landmark O(1)
 * 4. Ukuran wajah < min_face_size
 * 5. Blur check (Variance of Laplacian < blur_threshold)
 * 6. Pose check (|yaw| > max_yaw_deg || |pitch| > max_pitch_deg)
 */
export function evaluatePreEmbeddingGates(
  input: GateEvaluationInput,
  config: FaceQualityGateConfig
): GateEvaluationResult {
  const bw = Math.max(0, input.bbox.x2 - input.bbox.x1);
  const bh = Math.max(0, input.bbox.y2 - input.bbox.y1);
  const faceSizePx = Math.round(Math.min(bw, bh));

  // Langkah 2: Confidence
  if (!Number.isFinite(input.confidence) || input.confidence < config.threshold_confidence) {
    return {
      passed: false,
      reason: 'confidence',
      detail: `conf=${input.confidence.toFixed(2)}<${config.threshold_confidence.toFixed(2)}`,
      faceSizePx,
      blurVariance: null,
      yawDeg: null,
      pitchDeg: null,
      frontalScore: 0,
    };
  }

  // Langkah 3: Sanity check 5 landmark O(1)
  const lmCheck = validateFiveLandmarks(input.bbox, input.landmarks);
  if (!lmCheck.valid) {
    return {
      passed: false,
      reason: 'landmark',
      detail: lmCheck.reason ?? 'invalid_landmarks',
      faceSizePx,
      blurVariance: null,
      yawDeg: null,
      pitchDeg: null,
      frontalScore: 0,
    };
  }

  // Langkah 4: Ukuran wajah dalam rentang [min_face_size, max_face_size]
  const effMinSize = Math.max(16, input.minFaceSizeOverridePx ?? config.min_face_size);
  if (faceSizePx < effMinSize) {
    return {
      passed: false,
      reason: 'size',
      detail: `px=${faceSizePx}<${effMinSize}`,
      faceSizePx,
      blurVariance: null,
      yawDeg: null,
      pitchDeg: null,
      frontalScore: 0,
    };
  }
  const rawMaxSize = input.maxFaceSizeOverridePx ?? config.max_face_size ?? 0;
  const effMaxSize = rawMaxSize > 0 ? Math.max(effMinSize, Math.round(rawMaxSize)) : 0;
  if (effMaxSize > 0 && faceSizePx > effMaxSize) {
    return {
      passed: false,
      reason: 'size',
      detail: `px=${faceSizePx}>${effMaxSize}`,
      faceSizePx,
      blurVariance: null,
      yawDeg: null,
      pitchDeg: null,
      frontalScore: 0,
    };
  }

  // Langkah 5: Blur check (Variance of Laplacian) — dipanggil hanya jika lolos Langkah 2–4
  const blurVar = input.computeBlurVariance();
  if (!Number.isFinite(blurVar) || blurVar < config.blur_threshold) {
    return {
      passed: false,
      reason: 'blur',
      detail: `lap=${blurVar.toFixed(0)}<${config.blur_threshold}`,
      faceSizePx,
      blurVariance: Math.round(blurVar * 100) / 100,
      yawDeg: null,
      pitchDeg: null,
      frontalScore: 0,
    };
  }

  // Langkah 6: Pose check dari 5 landmark (atau gabungan dengan pose detector jika tersedia)
  const validLm = input.landmarks as FiveLandmarks;
  const pose5 = estimatePoseDegFrom5Pts(validLm);
  const yawDeg = input.poseOverrideDeg ? input.poseOverrideDeg.yawDeg : pose5.yawDeg;
  const pitchDeg = input.poseOverrideDeg ? input.poseOverrideDeg.pitchDeg : pose5.pitchDeg;

  if (Math.abs(yawDeg) > config.max_yaw_deg || Math.abs(pitchDeg) > config.max_pitch_deg) {
    return {
      passed: false,
      reason: 'pose',
      detail: `yaw=${Math.round(yawDeg)}/pitch=${Math.round(pitchDeg)}`,
      faceSizePx,
      blurVariance: Math.round(blurVar * 100) / 100,
      yawDeg,
      pitchDeg,
      frontalScore: 0,
    };
  }

  const frontalScore = Math.max(
    0.1,
    Math.min(1, 1 - (Math.abs(yawDeg) / 45) * 0.65 - (Math.abs(pitchDeg) / 35) * 0.35)
  );

  return {
    passed: true,
    reason: null,
    detail: null,
    faceSizePx,
    blurVariance: Math.round(blurVar * 100) / 100,
    yawDeg,
    pitchDeg,
    frontalScore: Math.round(frontalScore * 10000) / 10000,
  };
}

/**
 * Matriks transformasi similarity 2D (4-DOF: skala + rotasi + translasi):
 *   x' = a*x - b*y + tx
 *   y' = b*x + a*y + ty
 */
export interface SimilarityMatrix2x3 {
  a: number;
  b: number;
  tx: number;
  ty: number;
}

/**
 * Hitung transformasi similarity 5-titik closed-form least squares (Umeyama 4-DOF)
 * dari koordinat sumber (gambar) ke target ArcFace 112x112.
 */
export function estimateSimilarityTransform2D(
  src: readonly [Point2D, Point2D, Point2D, Point2D, Point2D],
  dst: readonly [Point2D, Point2D, Point2D, Point2D, Point2D] = ARCFACE_DST_112
): SimilarityMatrix2x3 {
  const n = 5;
  let sx = 0, sy = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    sx += src[i].x;
    sy += src[i].y;
    dx += dst[i].x;
    dy += dst[i].y;
  }
  const msx = sx / n, msy = sy / n;
  const mdx = dx / n, mdy = dy / n;

  let denom = 0;
  let numA = 0;
  let numB = 0;
  for (let i = 0; i < n; i++) {
    const ux = src[i].x - msx;
    const uy = src[i].y - msy;
    const vx = dst[i].x - mdx;
    const vy = dst[i].y - mdy;
    denom += ux * ux + uy * uy;
    numA += ux * vx + uy * vy;
    numB += ux * vy - uy * vx;
  }
  if (denom < 1e-6) {
    return { a: 1, b: 0, tx: mdx - msx, ty: mdy - msy };
  }
  const a = numA / denom;
  const b = numB / denom;
  const tx = mdx - (a * msx - b * msy);
  const ty = mdy - (b * msx + a * msy);
  return { a, b, tx, ty };
}

export function applySimilarityTransformPoint(m: SimilarityMatrix2x3, p: Point2D): Point2D {
  return {
    x: m.a * p.x - m.b * p.y + m.tx,
    y: m.b * p.x + m.a * p.y + m.ty,
  };
}

/**
 * Langkah 7: Warp bilinear 5-titik ke kanvas RGB 112x112 menggunakan invers matriks similarity.
 */
export function warpAffineRgb112(
  rgba: Uint8Array,
  imgW: number,
  imgH: number,
  forward: SimilarityMatrix2x3
): Uint8Array {
  const SIZE = 112;
  const out = new Uint8Array(SIZE * SIZE * 3);
  const det = forward.a * forward.a + forward.b * forward.b;
  if (det < 1e-8) return out;

  // Invers: M^-1 = (1/det) * [[a, b], [-b, a]] * ([x', y'] - [tx, ty])
  const invScale = 1 / det;
  const ia = forward.a * invScale;
  const ib = forward.b * invScale;

  for (let dy = 0; dy < SIZE; dy++) {
    const yRel = dy - forward.ty;
    const dstRow = dy * SIZE * 3;
    for (let dx = 0; dx < SIZE; dx++) {
      const xRel = dx - forward.tx;
      const sx = ia * xRel + ib * yRel;
      const sy = -ib * xRel + ia * yRel;

      const dIdx = dstRow + dx * 3;
      if (sx < 0 || sy < 0 || sx >= imgW - 1 || sy >= imgH - 1) {
        const cx = Math.min(imgW - 1, Math.max(0, Math.round(sx)));
        const cy = Math.min(imgH - 1, Math.max(0, Math.round(sy)));
        const sIdx = (cy * imgW + cx) * 4;
        out[dIdx] = rgba[sIdx];
        out[dIdx + 1] = rgba[sIdx + 1];
        out[dIdx + 2] = rgba[sIdx + 2];
        continue;
      }

      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      const fx = sx - x0;
      const fy = sy - y0;
      const w00 = (1 - fx) * (1 - fy);
      const w10 = fx * (1 - fy);
      const w01 = (1 - fx) * fy;
      const w11 = fx * fy;

      const i00 = (y0 * imgW + x0) * 4;
      const i10 = i00 + 4;
      const i01 = i00 + imgW * 4;
      const i11 = i01 + 4;

      out[dIdx] = Math.round(rgba[i00] * w00 + rgba[i10] * w10 + rgba[i01] * w01 + rgba[i11] * w11);
      out[dIdx + 1] = Math.round(
        rgba[i00 + 1] * w00 + rgba[i10 + 1] * w10 + rgba[i01 + 1] * w01 + rgba[i11 + 1] * w11
      );
      out[dIdx + 2] = Math.round(
        rgba[i00 + 2] * w00 + rgba[i10 + 2] * w10 + rgba[i01 + 2] * w01 + rgba[i11 + 2] * w11
      );
    }
  }
  return out;
}

/**
 * Konversi RGB 112x112 ter-align menjadi tensor input faceres [1, 224, 224, 3] float32 [0..255].
 */
export function rgb112ToFaceresFloat224(rgb112: Uint8Array): Float32Array {
  const SRC = 112;
  const DST = 224;
  const out = new Float32Array(DST * DST * 3);
  const scale = (SRC - 1) / (DST - 1);
  for (let dy = 0; dy < DST; dy++) {
    const sy = dy * scale;
    const y0 = Math.floor(sy);
    const y1 = Math.min(SRC - 1, y0 + 1);
    const fy = sy - y0;
    const dstRow = dy * DST * 3;
    for (let dx = 0; dx < DST; dx++) {
      const sx = dx * scale;
      const x0 = Math.floor(sx);
      const x1 = Math.min(SRC - 1, x0 + 1);
      const fx = sx - x0;

      const w00 = (1 - fx) * (1 - fy);
      const w10 = fx * (1 - fy);
      const w01 = (1 - fx) * fy;
      const w11 = fx * fy;

      const i00 = (y0 * SRC + x0) * 3;
      const i10 = (y0 * SRC + x1) * 3;
      const i01 = (y1 * SRC + x0) * 3;
      const i11 = (y1 * SRC + x1) * 3;

      const dIdx = dstRow + dx * 3;
      out[dIdx] = rgb112[i00] * w00 + rgb112[i10] * w10 + rgb112[i01] * w01 + rgb112[i11] * w11;
      out[dIdx + 1] = rgb112[i00 + 1] * w00 + rgb112[i10 + 1] * w10 + rgb112[i01 + 1] * w01 + rgb112[i11 + 1] * w11;
      out[dIdx + 2] = rgb112[i00 + 2] * w00 + rgb112[i10 + 2] * w10 + rgb112[i01 + 2] * w01 + rgb112[i11 + 2] * w11;
    }
  }
  return out;
}

export interface DetectionStatsCounts {
  total_raw: number;
  dropped_confidence: number;
  dropped_landmark: number;
  dropped_size: number;
  dropped_blur: number;
  dropped_pose: number;
  passed_embedding: number;
}

export function computeDropRatio(stats: DetectionStatsCounts): number {
  if (stats.total_raw <= 0) return 0;
  const dropped =
    stats.dropped_confidence +
    stats.dropped_landmark +
    stats.dropped_size +
    stats.dropped_blur +
    stats.dropped_pose;
  return Math.min(1, Math.max(0, dropped / stats.total_raw));
}

export function isCameraDropAlert(stats: DetectionStatsCounts): boolean {
  if (stats.total_raw <= 0) return false;
  return computeDropRatio(stats) > 0.70;
}

export interface AdaptiveThresholdConfig {
  threshold_recognition?: number;
  adaptive_threshold_enabled?: boolean;
  threshold_high_quality?: number;
  threshold_mid_quality?: number;
}

export interface AdaptiveThresholdDecision {
  allowed: boolean;
  effectiveThreshold: number;
  band: 'high_quality' | 'mid_quality' | 'low_quality' | 'fixed';
}

/**
 * Adaptive threshold berdasar quality_score:
 * - quality_score < 0.70 -> reject (terlalu rendah)
 * - adaptive_threshold_enabled = false -> pakai threshold_recognition (default 0.70)
 * - quality_score >= 0.85 -> threshold_high_quality (default 0.60)
 * - 0.70 <= quality_score < 0.85 -> threshold_mid_quality (default 0.75)
 */
export function resolveAdaptiveRecognitionThreshold(
  qualityScore: number,
  config?: AdaptiveThresholdConfig
): AdaptiveThresholdDecision {
  const q = Number.isFinite(qualityScore) ? qualityScore : 0;
  if (q < 0.7) {
    return { allowed: false, effectiveThreshold: 1.0, band: 'low_quality' };
  }
  const enabled = config?.adaptive_threshold_enabled !== false;
  if (!enabled) {
    const base = Number.isFinite(Number(config?.threshold_recognition))
      ? Number(config?.threshold_recognition)
      : 0.7;
    return { allowed: true, effectiveThreshold: base, band: 'fixed' };
  }
  if (q >= 0.85) {
    const highT = Number.isFinite(Number(config?.threshold_high_quality))
      ? Number(config?.threshold_high_quality)
      : 0.6;
    return { allowed: true, effectiveThreshold: highT, band: 'high_quality' };
  }
  const midT = Number.isFinite(Number(config?.threshold_mid_quality))
    ? Number(config?.threshold_mid_quality)
    : 0.75;
  return { allowed: true, effectiveThreshold: midT, band: 'mid_quality' };
}

export function computeBoxIoU(a: BBoxXYXY, b: BBoxXYXY): number {
  const ix1 = Math.max(a.x1, b.x1);
  const iy1 = Math.max(a.y1, b.y1);
  const ix2 = Math.min(a.x2, b.x2);
  const iy2 = Math.min(a.y2, b.y2);
  const iw = Math.max(0, ix2 - ix1);
  const ih = Math.max(0, iy2 - iy1);
  const inter = iw * ih;
  if (inter <= 0) return 0;
  const areaA = Math.max(0, (a.x2 - a.x1) * (a.y2 - a.y1));
  const areaB = Math.max(0, (b.x2 - b.x1) * (b.y2 - b.y1));
  const union = areaA + areaB - inter;
  return union > 0 ? inter / union : 0;
}

export interface DetectorTileRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Membagi frame lebar (> 768px) menjadi 2 tile horizontal overlapping (58% lebar, ~16% overlap tengah)
 * agar rasio tile mendekati 1:1 dan wajah kecil CCTV (45-80px) tidak hilang saat BlazeFace resize ke 128x128.
 */
export function buildDetectorTiles(frameWidth: number, frameHeight: number): DetectorTileRect[] {
  const w = Math.max(1, Math.round(frameWidth));
  const h = Math.max(1, Math.round(frameHeight));
  if (w <= 768) {
    return [{ x: 0, y: 0, w, h }];
  }
  const tileW = Math.min(w, Math.max(320, Math.round(w * 0.58)));
  if (tileW >= w) {
    return [{ x: 0, y: 0, w, h }];
  }
  return [
    { x: 0, y: 0, w: tileW, h },
    { x: w - tileW, y: 0, w: tileW, h },
  ];
}

export function dedupeByIoU<T extends { bbox: BBoxXYXY; confidence: number }>(
  items: readonly T[],
  iouThreshold = 0.4
): T[] {
  if (items.length <= 1) return [...items];
  const sorted = [...items].sort((a, b) => b.confidence - a.confidence);
  const kept: T[] = [];
  for (const item of sorted) {
    const overlaps = kept.some((k) => computeBoxIoU(item.bbox, k.bbox) >= iouThreshold);
    if (!overlaps) {
      kept.push(item);
    }
  }
  return kept;
}

interface NodeTrackState {
  trackId: number;
  bbox: BBoxXYXY;
  lastSeenMs: number;
}

export class IoUFaceTracker {
  private nextId = 1;
  private tracks = new Map<number, NodeTrackState>();
  private readonly iouThreshold: number;
  private readonly ttlMs: number;

  constructor(iouThreshold = 0.35, ttlMs = 4000) {
    this.iouThreshold = iouThreshold;
    this.ttlMs = ttlMs;
  }

  assignTracks(boxes: readonly BBoxXYXY[], nowMs = Date.now(), ttlOverrideMs?: number): number[] {
    const ttl = ttlOverrideMs !== undefined && Number.isFinite(ttlOverrideMs) ? Math.max(500, ttlOverrideMs) : this.ttlMs;
    for (const [tid, tr] of this.tracks.entries()) {
      if (nowMs - tr.lastSeenMs > ttl) {
        this.tracks.delete(tid);
      }
    }
    const used = new Set<number>();
    const assigned: number[] = [];
    for (const box of boxes) {
      let bestTid: number | null = null;
      let bestIou = this.iouThreshold;
      for (const [tid, tr] of this.tracks.entries()) {
        if (used.has(tid)) continue;
        const score = computeBoxIoU(box, tr.bbox);
        if (score >= bestIou) {
          bestIou = score;
          bestTid = tid;
        }
      }
      // Fallback jarak pusat untuk siswa yang berjalan cepat sehingga IoU antar frame sempat < threshold
      if (bestTid === null) {
        const bw = Math.max(1, box.x2 - box.x1);
        const bh = Math.max(1, box.y2 - box.y1);
        const bSize = Math.max(bw, bh);
        const bcx = (box.x1 + box.x2) * 0.5;
        const bcy = (box.y1 + box.y2) * 0.5;
        let bestDist = Infinity;
        for (const [tid, tr] of this.tracks.entries()) {
          if (used.has(tid)) continue;
          if (nowMs - tr.lastSeenMs > 2000) continue;
          const tw = Math.max(1, tr.bbox.x2 - tr.bbox.x1);
          const th = Math.max(1, tr.bbox.y2 - tr.bbox.y1);
          const tSize = Math.max(tw, th);
          const sizeRatio = bSize / tSize;
          if (sizeRatio < 0.55 || sizeRatio > 1.85) continue;
          const tcx = (tr.bbox.x1 + tr.bbox.x2) * 0.5;
          const tcy = (tr.bbox.y1 + tr.bbox.y2) * 0.5;
          const dist = Math.hypot(bcx - tcx, bcy - tcy);
          const maxDist = Math.max(bSize, tSize) * 1.15;
          if (dist <= maxDist && dist < bestDist) {
            bestDist = dist;
            bestTid = tid;
          }
        }
      }
      if (bestTid !== null) {
        used.add(bestTid);
        const tr = this.tracks.get(bestTid)!;
        tr.bbox = box;
        tr.lastSeenMs = nowMs;
        assigned.push(bestTid);
      } else {
        const tid = this.nextId++;
        this.tracks.set(tid, { trackId: tid, bbox: box, lastSeenMs: nowMs });
        used.add(tid);
        assigned.push(tid);
      }
    }
    return assigned;
  }
}

export interface VoteEntry {
  timestampMs: number;
  studentId: number;
  similarity: number;
}

export interface VoteDecision {
  shouldDispatch: boolean;
  studentId: number | null;
  similarity: number;
  voteCount: number;
  reason: 'confirmed' | 'awaiting_second_vote' | 'below_vote_threshold' | 'anonymous';
}

/**
 * Multi-frame voting buffer per track_id:
 * Siswa baru di-dispatch ke face_event setelah >= minVotes (default 2) match konsisten
 * dalam voteWindowSec (default 10s) dengan similarity >= voteThreshold (default 0.65).
 */
export class TrackVoteBuffer {
  private buffer = new Map<number, VoteEntry[]>();

  recordAndEvaluate(params: {
    trackId: number;
    studentId: number | null;
    similarity: number;
    nowMs: number;
    voteThreshold?: number;
    voteWindowSec?: number;
    minVotes?: number;
  }): VoteDecision {
    const {
      trackId,
      studentId,
      similarity,
      nowMs,
      voteThreshold = 0.65,
      voteWindowSec = 10,
      minVotes = 2,
    } = params;

    const windowMs = Math.max(1000, voteWindowSec * 1000);
    const prev = this.buffer.get(trackId) ?? [];
    const active = prev.filter((e) => nowMs - e.timestampMs <= windowMs);

    if (studentId === null) {
      if (active.length === 0) this.buffer.delete(trackId);
      else this.buffer.set(trackId, active);
      return { shouldDispatch: false, studentId: null, similarity, voteCount: 0, reason: 'anonymous' };
    }

    if (similarity < voteThreshold) {
      if (active.length === 0) this.buffer.delete(trackId);
      else this.buffer.set(trackId, active);
      return {
        shouldDispatch: false,
        studentId,
        similarity,
        voteCount: 0,
        reason: 'below_vote_threshold',
      };
    }

    active.push({ timestampMs: nowMs, studentId, similarity });
    const sameStudentVotes = active.filter((e) => e.studentId === studentId);
    if (sameStudentVotes.length >= minVotes) {
      // Reset buffer track setelah dispatch terkonfirmasi
      this.buffer.delete(trackId);
      return {
        shouldDispatch: true,
        studentId,
        similarity,
        voteCount: sameStudentVotes.length,
        reason: 'confirmed',
      };
    }

    this.buffer.set(trackId, active);
    return {
      shouldDispatch: false,
      studentId,
      similarity,
      voteCount: sameStudentVotes.length,
      reason: 'awaiting_second_vote',
    };
  }

  clearExpired(nowMs: number, voteWindowSec = 10): void {
    const windowMs = Math.max(1000, voteWindowSec * 1000);
    for (const [tid, entries] of this.buffer.entries()) {
      const kept = entries.filter((e) => nowMs - e.timestampMs <= windowMs);
      if (kept.length === 0) this.buffer.delete(tid);
      else this.buffer.set(tid, kept);
    }
  }

  getTrackVotes(trackId: number): readonly VoteEntry[] {
    return this.buffer.get(trackId) ?? [];
  }
}
