import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ARCFACE_DST_112,
  IoUFaceTracker,
  TrackVoteBuffer,
  applySimilarityTransformPoint,
  buildDetectorTiles,
  computeDropRatio,
  computeLaplacianVarianceGray,
  dedupeByIoU,
  DEFAULT_QUALITY_GATE_CONFIG,
  estimatePoseDegFrom5Pts,
  estimateSimilarityTransform2D,
  evaluatePreEmbeddingGates,
  isCameraDropAlert,
  laplacianToSharpnessNorm,
  resolveAdaptiveRecognitionThreshold,
  validateFiveLandmarks,
  warpAffineRgb112,
  type BBoxXYXY,
  type FiveLandmarks,
} from './faceQualityGate.ts';

const VALID_BBOX: BBoxXYXY = { x1: 100, y1: 100, x2: 220, y2: 240 }; // 120 x 140
const VALID_LM: FiveLandmarks = {
  leftEye: { x: 138, y: 152 },
  rightEye: { x: 182, y: 152 },
  nose: { x: 160, y: 178 },
  mouthLeft: { x: 142, y: 204 },
  mouthRight: { x: 178, y: 204 },
};

test('Landmark #1: wajah frontal valid dengan 5 landmark lolos semua cek', () => {
  const res = validateFiveLandmarks(VALID_BBOX, VALID_LM);
  assert.equal(res.valid, true);
  assert.ok((res.eyeDistancePx ?? 0) >= 0.15 * 120);
  assert.ok((res.noseRatio ?? 0) >= 0.7 && (res.noseRatio ?? 0) <= 1.5);
});

test('Landmark #2: mata kiri & kanan tertukar (left_eye.x >= right_eye.x) ditolak', () => {
  const res = validateFiveLandmarks(VALID_BBOX, {
    ...VALID_LM,
    leftEye: { x: 185, y: 152 },
    rightEye: { x: 135, y: 152 },
  });
  assert.equal(res.valid, false);
  assert.equal(res.reason, 'swapped_eyes');
});

test('Landmark #3: hidung di luar bbox (>5% margin) ditolak', () => {
  const res = validateFiveLandmarks(VALID_BBOX, {
    ...VALID_LM,
    nose: { x: 245, y: 178 },
  });
  assert.equal(res.valid, false);
  assert.equal(res.reason, 'landmark_outside_bbox');
});

test('Landmark #4: mulut berada di atas mata / di atas hidung ditolak', () => {
  const res = validateFiveLandmarks(VALID_BBOX, {
    ...VALID_LM,
    mouthLeft: { x: 142, y: 140 },
    mouthRight: { x: 178, y: 140 },
  });
  assert.equal(res.valid, false);
  assert.equal(res.reason, 'nose_not_between_eyes_and_mouth');
});

test('Landmark #5: jarak mata terlalu sempit (< 15% lebar bbox) ditolak', () => {
  const res = validateFiveLandmarks(VALID_BBOX, {
    ...VALID_LM,
    leftEye: { x: 155, y: 152 },
    rightEye: { x: 165, y: 152 }, // 10 px < 18 px (15% dari 120)
  });
  assert.equal(res.valid, false);
  assert.equal(res.reason, 'eyes_too_close');
});

test('Landmark #6: landmark < 5 titik (tanpa fallback bbox-only) wajib ditolak', () => {
  const res = validateFiveLandmarks(VALID_BBOX, {
    leftEye: VALID_LM.leftEye,
    rightEye: VALID_LM.rightEye,
    nose: VALID_LM.nose,
    mouthLeft: VALID_LM.mouthLeft,
  });
  assert.equal(res.valid, false);
  assert.equal(res.reason, 'incomplete_landmarks');
});

test('Landmark #7: rasio vertikal hidung tidak proporsional (di luar [0.7, 1.5]) ditolak', () => {
  const res = validateFiveLandmarks(VALID_BBOX, {
    ...VALID_LM,
    nose: { x: 160, y: 156 }, // terlalu dekat mata: 4 / 48 = 0.083
  });
  assert.equal(res.valid, false);
  assert.equal(res.reason, 'proportion_out_of_range');
});

test('Pipeline berurutan berhenti seketika sebelum langkah mahal (blur callback tidak dipanggil jika conf/landmark/size gagal)', () => {
  let blurCalled = 0;
  const failConf = evaluatePreEmbeddingGates(
    {
      confidence: 0.42,
      bbox: VALID_BBOX,
      landmarks: VALID_LM,
      computeBlurVariance: () => {
        blurCalled++;
        return 500;
      },
    },
    DEFAULT_QUALITY_GATE_CONFIG
  );
  assert.equal(failConf.passed, false);
  assert.equal(failConf.reason, 'confidence');
  assert.equal(blurCalled, 0);

  const failSize = evaluatePreEmbeddingGates(
    {
      confidence: 0.91,
      bbox: { x1: 10, y1: 10, x2: 50, y2: 58 }, // 40x48 < 60
      landmarks: {
        leftEye: { x: 22, y: 26 },
        rightEye: { x: 38, y: 26 },
        nose: { x: 30, y: 36 },
        mouthLeft: { x: 24, y: 45 },
        mouthRight: { x: 36, y: 45 },
      },
      computeBlurVariance: () => {
        blurCalled++;
        return 500;
      },
    },
    DEFAULT_QUALITY_GATE_CONFIG
  );
  assert.equal(failSize.passed, false);
  assert.equal(failSize.reason, 'size');
  assert.equal(blurCalled, 0);

  const failBlur = evaluatePreEmbeddingGates(
    {
      confidence: 0.91,
      bbox: VALID_BBOX,
      landmarks: VALID_LM,
      computeBlurVariance: () => {
        blurCalled++;
        return 42;
      },
    },
    DEFAULT_QUALITY_GATE_CONFIG
  );
  assert.equal(failBlur.passed, false);
  assert.equal(failBlur.reason, 'blur');
  assert.equal(blurCalled, 1);
});

test('Blur Laplacian 3x3: pola datar/blur < 100, tepi tajam >= 100', () => {
  const flat = new Float32Array(32 * 32).fill(128);
  assert.equal(computeLaplacianVarianceGray(flat, 32, 32), 0);

  const sharp = new Float32Array(32 * 32);
  for (let y = 0; y < 32; y++) {
    for (let x = 0; x < 32; x++) {
      sharp[y * 32 + x] = (x + y) % 2 === 0 ? 220 : 30;
    }
  }
  assert.ok(computeLaplacianVarianceGray(sharp, 32, 32) > 100);
});

test('Pose check 5-landmark menolak pose yaw > 30 deg', () => {
  const extremeYawLm: FiveLandmarks = {
    leftEye: { x: 135, y: 152 },
    rightEye: { x: 185, y: 152 },
    nose: { x: 182, y: 178 }, // sangat miring ke kanan (>30 deg)
    mouthLeft: { x: 145, y: 204 },
    mouthRight: { x: 180, y: 204 },
  };
  const pose = estimatePoseDegFrom5Pts(extremeYawLm);
  assert.ok(Math.abs(pose.yawDeg) > 30, `yaw=${pose.yawDeg}`);
  const res = evaluatePreEmbeddingGates(
    {
      confidence: 0.92,
      bbox: VALID_BBOX,
      landmarks: extremeYawLm,
      computeBlurVariance: () => 250,
    },
    DEFAULT_QUALITY_GATE_CONFIG
  );
  assert.equal(res.passed, false);
  assert.equal(res.reason, 'pose');
});

test('Alignment 5-point similarity affine memetakan landmark ke referensi ArcFace 112x112', () => {
  const src: [FiveLandmarks['leftEye'], FiveLandmarks['leftEye'], FiveLandmarks['leftEye'], FiveLandmarks['leftEye'], FiveLandmarks['leftEye']] = [
    VALID_LM.leftEye,
    VALID_LM.rightEye,
    VALID_LM.nose,
    VALID_LM.mouthLeft,
    VALID_LM.mouthRight,
  ];
  const m = estimateSimilarityTransform2D(src, ARCFACE_DST_112);
  const mappedEyeL = applySimilarityTransformPoint(m, VALID_LM.leftEye);
  const mappedEyeR = applySimilarityTransformPoint(m, VALID_LM.rightEye);
  assert.ok(Math.abs(mappedEyeL.x - ARCFACE_DST_112[0].x) < 4);
  assert.ok(Math.abs(mappedEyeL.y - ARCFACE_DST_112[0].y) < 4);
  assert.ok(Math.abs(mappedEyeR.x - ARCFACE_DST_112[1].x) < 4);

  const rgba = new Uint8Array(320 * 320 * 4).fill(200);
  const aligned = warpAffineRgb112(rgba, 320, 320, m);
  assert.equal(aligned.length, 112 * 112 * 3);
});

test('Alert drop rate > 70% pada detection_stats terdeteksi akurat', () => {
  assert.equal(
    isCameraDropAlert({
      total_raw: 100,
      dropped_confidence: 20,
      dropped_landmark: 30,
      dropped_size: 10,
      dropped_blur: 15,
      dropped_pose: 5,
      passed_embedding: 20,
    }),
    true
  );
  assert.equal(
    computeDropRatio({
      total_raw: 100,
      dropped_confidence: 10,
      dropped_landmark: 10,
      dropped_size: 5,
      dropped_blur: 5,
      dropped_pose: 5,
      passed_embedding: 65,
    }),
    0.35
  );
  assert.equal(
    isCameraDropAlert({
      total_raw: 100,
      dropped_confidence: 10,
      dropped_landmark: 10,
      dropped_size: 5,
      dropped_blur: 5,
      dropped_pose: 5,
      passed_embedding: 65,
    }),
    false
  );
});

test('Multi-frame voting: 1 frame hold, 2 konsisten dispatch, 2 berbeda tidak dispatch, dan reset window 10s', () => {
  const tracker = new IoUFaceTracker(0.35, 4000);
  const voter = new TrackVoteBuffer();
  const [tid] = tracker.assignTracks([VALID_BBOX], 10_000);

  // Kasus 1: Hanya 1 frame -> hold (tidak dispatch)
  const v1 = voter.recordAndEvaluate({
    trackId: tid,
    studentId: 42,
    similarity: 0.72,
    nowMs: 10_000,
    voteThreshold: 0.65,
    voteWindowSec: 10,
  });
  assert.equal(v1.shouldDispatch, false);
  assert.equal(v1.voteCount, 1);
  assert.equal(v1.reason, 'awaiting_second_vote');

  // Kasus 2: Frame ke-2 berbeda student_id -> belum dispatch
  const vDiff = voter.recordAndEvaluate({
    trackId: tid,
    studentId: 99,
    similarity: 0.74,
    nowMs: 11_000,
    voteThreshold: 0.65,
    voteWindowSec: 10,
  });
  assert.equal(vDiff.shouldDispatch, false);
  assert.equal(vDiff.voteCount, 1);

  // Kasus 3: Frame ke-3 konsisten ke student_id 42 dalam 10 detik -> DISPATCH!
  const v2 = voter.recordAndEvaluate({
    trackId: tid,
    studentId: 42,
    similarity: 0.76,
    nowMs: 12_500,
    voteThreshold: 0.65,
    voteWindowSec: 10,
  });
  assert.equal(v2.shouldDispatch, true);
  assert.equal(v2.studentId, 42);
  assert.equal(v2.voteCount, 2);
  assert.equal(v2.reason, 'confirmed');
  assert.equal(voter.getTrackVotes(tid).length, 0);

  // Kasus 4: Window 10 detik kedaluwarsa mereset buffer lama
  const first = voter.recordAndEvaluate({
    trackId: tid,
    studentId: 77,
    similarity: 0.71,
    nowMs: 20_000,
    voteThreshold: 0.65,
    voteWindowSec: 10,
  });
  assert.equal(first.shouldDispatch, false);
  const afterExpiry = voter.recordAndEvaluate({
    trackId: tid,
    studentId: 77,
    similarity: 0.71,
    nowMs: 31_000, // 11 detik kemudian (>10s)
    voteThreshold: 0.65,
    voteWindowSec: 10,
  });
  assert.equal(afterExpiry.shouldDispatch, false);
  assert.equal(afterExpiry.voteCount, 1);
});

test('Adaptive threshold berdasarkan quality_score (tinggi 0.60, sedang 0.75, rendah reject, non-adaptif 0.70)', () => {
  const cfg = {
    threshold_recognition: 0.7,
    adaptive_threshold_enabled: true,
    threshold_high_quality: 0.6,
    threshold_mid_quality: 0.75,
  };

  // High quality (>= 0.85) -> 0.60
  const highQ = resolveAdaptiveRecognitionThreshold(0.88, cfg);
  assert.equal(highQ.allowed, true);
  assert.equal(highQ.effectiveThreshold, 0.6);
  assert.equal(highQ.band, 'high_quality');

  // Mid quality (0.70 .. <0.85) -> 0.75
  const midQ = resolveAdaptiveRecognitionThreshold(0.76, cfg);
  assert.equal(midQ.allowed, true);
  assert.equal(midQ.effectiveThreshold, 0.75);
  assert.equal(midQ.band, 'mid_quality');

  // Low quality (< 0.70) -> reject
  const lowQ = resolveAdaptiveRecognitionThreshold(0.64, cfg);
  assert.equal(lowQ.allowed, false);
  assert.equal(lowQ.band, 'low_quality');

  // Disabled -> tetap threshold_recognition (0.70)
  const fixed = resolveAdaptiveRecognitionThreshold(0.88, { ...cfg, adaptive_threshold_enabled: false });
  assert.equal(fixed.allowed, true);
  assert.equal(fixed.effectiveThreshold, 0.7);
  assert.equal(fixed.band, 'fixed');
});

test('Overhead CCTV noseRatio (1.65) lolos validasi landmark, sementara rasio ekstrem (2.5) ditolak', () => {
  const overheadLm: FiveLandmarks = {
    leftEye: { x: 138, y: 148 },
    rightEye: { x: 182, y: 148 },
    nose: { x: 160, y: 181 }, // upper=33, lower=20 -> ratio=1.65
    mouthLeft: { x: 142, y: 201 },
    mouthRight: { x: 178, y: 201 },
  };
  const ok = validateFiveLandmarks(VALID_BBOX, overheadLm);
  assert.equal(ok.valid, true);

  const extremeLm: FiveLandmarks = {
    ...overheadLm,
    nose: { x: 160, y: 190 }, // upper=42, lower=11 -> ratio=3.81
  };
  const bad = validateFiveLandmarks(VALID_BBOX, extremeLm);
  assert.equal(bad.valid, false);
  assert.equal(bad.reason, 'proportion_out_of_range');
});

test('buildDetectorTiles & dedupeByIoU memecah frame HD menjadi 2 tile overlapping dan menggabungkan duplikat tengah', () => {
  const smallTiles = buildDetectorTiles(640, 480);
  assert.equal(smallTiles.length, 1);

  const hdTiles = buildDetectorTiles(1280, 720);
  assert.equal(hdTiles.length, 2);
  assert.equal(hdTiles[0].x, 0);
  assert.equal(hdTiles[1].x + hdTiles[1].w, 1280);
  // Pastikan ada overlap di tengah agar wajah tepat di tengah tidak terpotong
  assert.ok(hdTiles[0].w > hdTiles[1].x + 120);

  const merged = dedupeByIoU(
    [
      { bbox: { x1: 600, y1: 200, x2: 680, y2: 290 }, confidence: 0.78 },
      { bbox: { x1: 604, y1: 202, x2: 682, y2: 292 }, confidence: 0.86 },
      { bbox: { x1: 200, y1: 210, x2: 260, y2: 280 }, confidence: 0.81 },
    ],
    0.4
  );
  assert.equal(merged.length, 2);
  assert.equal(merged[0].confidence, 0.86);
  assert.equal(merged[1].confidence, 0.81);
});

test('IoUFaceTracker menjaga trackId yang sama saat siswa berjalan cepat antar frame dan kalibrasi sharpness >= 140', () => {
  const tracker = new IoUFaceTracker(0.2, 4000);
  const [t1] = tracker.assignTracks([{ x1: 100, y1: 100, x2: 170, y2: 180 }], 10_000);
  // Geser 55px ke kanan dalam 350ms (IoU rendah, namun masih jarak wajar siswa berjalan)
  const [t2] = tracker.assignTracks([{ x1: 155, y1: 105, x2: 225, y2: 185 }], 10_350);
  assert.equal(t2, t1);
  // Orang jauh di sisi lain mendapat track baru
  const [tFar] = tracker.assignTracks([{ x1: 600, y1: 120, x2: 670, y2: 200 }], 10_700);
  assert.notEqual(tFar, t1);

  assert.ok(laplacianToSharpnessNorm(140) >= 0.7);
});

test('evaluatePreEmbeddingGates rejects oversized faces before computeBlurVariance when max_face_size > 0', () => {
  // Large face: 360x400px (bw=360, bh=400 -> faceSizePx=360)
  const bigBbox = { x1: 100, y1: 100, x2: 460, y2: 500 };
  const bigLm: FiveLandmarks = {
    leftEye: { x: 205, y: 240 },
    rightEye: { x: 355, y: 240 },
    nose: { x: 280, y: 315 },
    mouthLeft: { x: 220, y: 390 },
    mouthRight: { x: 340, y: 390 },
  };

  let blurCalls = 0;
  const rejected = evaluatePreEmbeddingGates(
    {
      confidence: 0.92,
      bbox: bigBbox,
      landmarks: bigLm,
      computeBlurVariance: () => {
        blurCalls += 1;
        return 250;
      },
    },
    { ...DEFAULT_QUALITY_GATE_CONFIG, min_face_size: 60, max_face_size: 280 }
  );
  assert.equal(rejected.passed, false);
  assert.equal(rejected.reason, 'size');
  assert.equal(rejected.detail, 'px=360>280');
  assert.equal(blurCalls, 0);

  // Override maxFaceSizeOverridePx = 0 disables upper bound
  const passedUnlimited = evaluatePreEmbeddingGates(
    {
      confidence: 0.92,
      bbox: bigBbox,
      landmarks: bigLm,
      maxFaceSizeOverridePx: 0,
      computeBlurVariance: () => {
        blurCalls += 1;
        return 250;
      },
    },
    { ...DEFAULT_QUALITY_GATE_CONFIG, min_face_size: 60, max_face_size: 0 }
  );
  assert.equal(passedUnlimited.passed, true);
  assert.equal(blurCalls, 1);

  // Within calibrated [min, max] range -> passes
  const passedInRange = evaluatePreEmbeddingGates(
    {
      confidence: 0.92,
      bbox: bigBbox,
      landmarks: bigLm,
      minFaceSizeOverridePx: 80,
      maxFaceSizeOverridePx: 380,
      computeBlurVariance: () => 250,
    },
    DEFAULT_QUALITY_GATE_CONFIG
  );
  assert.equal(passedInRange.passed, true);
});

