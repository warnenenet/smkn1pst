import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateAttendancePercentage,
  checkClusterReadyStatus,
  checkWaAccountQuota,
  computeQualityScore,
  cosineSimilarity,
  evaluateAttendanceRecognition,
  formatWaMessage,
  normalizeExcelBirthDate,
  normalizeStudentStatus,
  normalizeWaPhone,
  parseKelasHierarchy,
  classifyAcademicTransition,
  computeScheduledWaDispatchTime,
  shouldTriggerPeakChime,
  buildKioskSpeechSentence,
  blendFaceEmbeddings,
  evaluateFaceMaintenanceProgress,
  extractJpegFramesFromChunk,
  maskRtspCredentials,
  parseFfmpegStreamOutput,
  parseRtspProbeOutput,
  resolveScheduleForStudent,
  stripDemoRecordsForProduction,
  validateAndNormalizeScheduleTimes,
} from './attendanceEngine';
import type { Kelas, KelasScheduleOverride, Schedule, ScheduleException, Student } from '../types';

const sampleKelas: Kelas = { id: 1, jurusan_id: 10, tingkat: 'XI', nama: 'XI RPL 1', shift: 'PAGI' };
const sampleStudent: Student = {
  id: 1,
  nis: '2025001',
  nisn: '0081122334',
  nama: 'Raka Pratama',
  nickname: 'Raka',
  kelas_id: 1,
  tanggal_lahir: '2008-05-14',
  status: 'AKTIF',
  embedding: [1, 0, 0],
  embedding_quality_score: 0.85,
  embedding_updated_at: '2026-11-01T07:00:00Z',
  foto_ref: null,
  wa_ortu: '6281234567890',
  created_at: '2026-07-01T00:00:00Z',
};

const baseSchedules: Schedule[] = [
  {
    id: 1,
    jurusan_id: null,
    hari: 1,
    jam_masuk_mulai: '06:00:00',
    jam_masuk_selesai: '07:15:00',
    jam_keluar_mulai: '15:00:00',
    jam_keluar_selesai: '17:00:00',
    toleransi_terlambat_menit: 5,
  },
  {
    id: 2,
    jurusan_id: 10,
    hari: 1,
    jam_masuk_mulai: '06:30:00',
    jam_masuk_selesai: '07:30:00',
    jam_keluar_mulai: '15:30:00',
    jam_keluar_selesai: '17:30:00',
    toleransi_terlambat_menit: 10,
  },
];

test('resolveScheduleForStudent prioritizes kelas override > jurusan > global, and returns null on PKL or LIBUR', () => {
  const kelasOverride: KelasScheduleOverride[] = [
    {
      id: 1,
      kelas_id: 1,
      hari: 1,
      jam_masuk_mulai: '12:00:00',
      jam_masuk_selesai: '13:00:00',
      jam_keluar_mulai: '17:00:00',
      jam_keluar_selesai: '18:00:00',
      alasan: 'Shift Siang',
    },
  ];
  const exceptions: ScheduleException[] = [];

  // Override wins
  const resOverride = resolveScheduleForStudent({
    student: sampleStudent,
    kelas: sampleKelas,
    dateStr: '2026-11-16',
    dayIso: 1,
    schedules: baseSchedules,
    kelasOverrides: kelasOverride,
    exceptions,
  });
  assert.equal(resOverride?.jam_masuk_mulai, '12:00:00');

  // Without class override, jurusan wins over global
  const resJurusan = resolveScheduleForStudent({
    student: sampleStudent,
    kelas: sampleKelas,
    dateStr: '2026-11-16',
    dayIso: 1,
    schedules: baseSchedules,
    kelasOverrides: [],
    exceptions,
  });
  assert.equal(resJurusan?.jam_masuk_mulai, '06:30:00');

  // LIBUR exception returns null
  const resLibur = resolveScheduleForStudent({
    student: sampleStudent,
    kelas: sampleKelas,
    dateStr: '2026-11-16',
    dayIso: 1,
    schedules: baseSchedules,
    kelasOverrides: [],
    exceptions: [{ id: 1, tanggal: '2026-11-16', scope: 'GLOBAL', ref_id: null, tipe: 'LIBUR', catatan: 'Hari Guru', jam_masuk_override: null, jam_keluar_override: null }],
  });
  assert.equal(resLibur, null);

  // PKL student returns null (never ALPA)
  const resPkl = resolveScheduleForStudent({
    student: { ...sampleStudent, status: 'PKL' },
    kelas: sampleKelas,
    dateStr: '2026-11-16',
    dayIso: 1,
    schedules: baseSchedules,
    kelasOverrides: [],
    exceptions: [],
  });
  assert.equal(resPkl, null);
});

test('evaluateAttendanceRecognition classifies HADIR, TERLAMBAT, KELUAR, OBSERVASI and deduplicates within 30s', () => {
  const sched = {
    jam_masuk_mulai: '06:00:00',
    jam_masuk_selesai: '07:15:00',
    jam_keluar_mulai: '15:00:00',
    jam_keluar_selesai: '17:00:00',
    toleransi_terlambat_menit: 5,
  };

  // On time (07:10) -> HADIR
  const onTime = evaluateAttendanceRecognition({
    student: sampleStudent,
    gateType: 'BOTH',
    timeNow: '07:10:00',
    dateStr: '2026-11-16',
    schedule: sched,
    existingDaily: undefined,
    recentLogs: [],
    nowEpochMs: Date.parse('2026-11-16T07:10:00Z'),
  });
  assert.equal(onTime.logType, 'MASUK');
  assert.equal(onTime.logStatus, 'HADIR');
  assert.equal(onTime.updateDaily?.status, 'HADIR');

  // Late (07:25 > 07:15 + 5m) -> TERLAMBAT
  const late = evaluateAttendanceRecognition({
    student: sampleStudent,
    gateType: 'MASUK',
    timeNow: '07:25:00',
    dateStr: '2026-11-16',
    schedule: sched,
    existingDaily: undefined,
    recentLogs: [],
    nowEpochMs: Date.parse('2026-11-16T07:25:00Z'),
  });
  assert.equal(late.logType, 'MASUK');
  assert.equal(late.logStatus, 'TERLAMBAT');

  // Duplicate within 30s is suppressed
  const dup = evaluateAttendanceRecognition({
    student: sampleStudent,
    gateType: 'MASUK',
    timeNow: '07:10:15',
    dateStr: '2026-11-16',
    schedule: sched,
    existingDaily: undefined,
    recentLogs: [
      { id: 1, student_id: 1, gate_id: 1, camera_id: 1, timestamp: '2026-11-16T07:10:00Z', tipe: 'MASUK', status: 'HADIR', is_manual_override: false },
    ],
    nowEpochMs: Date.parse('2026-11-16T07:10:15Z'),
  });
  assert.equal(dup.deduplicated, true);
});

test('computeQualityScore, cosineSimilarity, and cluster readiness adhere to thresholds', () => {
  const q = computeQualityScore(
    { confidence: 0.92, faceSizePx: 240, sharpnessNorm: 0.8, frontalScore: 0.9 },
    { weight_confidence: 0.3, weight_size: 0.25, weight_sharpness: 0.25, weight_frontal: 0.2 }
  );
  assert.ok(q > 0.85 && q <= 1);
  assert.equal(cosineSimilarity([1, 0, 0], [1, 0, 0]), 1);
  assert.equal(cosineSimilarity([1, 0, 0], [0, 1, 0]), 0);

  assert.equal(checkClusterReadyStatus({ hitCount: 5, distinctDays: 2, hasBestSnapshot: true, readyHits: 5, readyDays: 2 }), true);
  assert.equal(checkClusterReadyStatus({ hitCount: 4, distinctDays: 2, hasBestSnapshot: true, readyHits: 5, readyDays: 2 }), false);
});

test('WA template formatting, warm-up quota, and monthly percentage work accurately', () => {
  const msg = formatWaMessage('Ananda {nama} ({kelas}) status *{status}* pada {tanggal}.', {
    nama: 'Raka',
    kelas: 'XI RPL 1',
    tanggal: '2026-11-16',
    jam_masuk: '07:05:00',
    jam_keluar: '-',
    status: 'HADIR',
  });
  assert.equal(msg, 'Ananda Raka (XI RPL 1) status *HADIR* pada 2026-11-16.');

  assert.equal(checkWaAccountQuota({ status: 'WARMUP', daily_count: 19, hourly_count: 5 }), true);
  assert.equal(checkWaAccountQuota({ status: 'WARMUP', daily_count: 20, hourly_count: 5 }), false);
  assert.equal(checkWaAccountQuota({ status: 'PAUSED', daily_count: 0, hourly_count: 0 }), false);

  assert.equal(
    calculateAttendancePercentage([{ status: 'HADIR' }, { status: 'TERLAMBAT' }, { status: 'ALPA' }, { status: 'IZIN' }]),
    50
  );
});

test('Excel student import normalizers parse dates, phones, statuses, and classes cleanly', () => {
  assert.equal(normalizeExcelBirthDate('14/05/2008'), '2008-05-14');
  assert.equal(normalizeExcelBirthDate('2008-05-14'), '2008-05-14');
  assert.equal(normalizeExcelBirthDate(39582), '2008-05-14');
  assert.equal(normalizeWaPhone('0812-3456-7890'), '6281234567890');
  assert.equal(normalizeWaPhone('+62 813 1111 2222'), '6281311112222');
  assert.equal(normalizeStudentStatus('pkl'), 'PKL');
  assert.equal(normalizeStudentStatus(''), 'AKTIF');
  assert.deepEqual(parseKelasHierarchy('XI RPL 1'), { tingkat: 'XI', jurusanKode: 'RPL', nama: 'XI RPL 1' });
});

test('classifyAcademicTransition distinguishes NAIK_KELAS, TINGGAL_KELAS, PINDAH_KELAS, and LULUS', () => {
  assert.equal(
    classifyAcademicTransition({ oldKelasNama: null, newKelasNama: 'X TKJ 1', newStatus: 'AKTIF' }),
    'BARU'
  );
  assert.equal(
    classifyAcademicTransition({ oldKelasNama: 'X TKJ 1', newKelasNama: 'XI TKJ 1', newStatus: 'AKTIF' }),
    'NAIK_KELAS'
  );
  assert.equal(
    classifyAcademicTransition({ oldKelasNama: 'XI RPL 1', newKelasNama: 'XI RPL 1', newStatus: 'AKTIF' }),
    'TINGGAL_KELAS'
  );
  assert.equal(
    classifyAcademicTransition({ oldKelasNama: 'X TKJ 1', newKelasNama: 'X RPL 2', newStatus: 'AKTIF' }),
    'PINDAH_KELAS'
  );
  assert.equal(
    classifyAcademicTransition({ oldKelasNama: 'XII MM 1', newKelasNama: 'XII MM 1', newStatus: 'LULUS' }),
    'LULUS'
  );
});

test('computeScheduledWaDispatchTime and shouldTriggerPeakChime handle dismissal delay and peak bursts', () => {
  assert.equal(computeScheduledWaDispatchTime('15:00:00', 60), '16:00:00');
  assert.equal(computeScheduledWaDispatchTime('17:15:00', 60), '18:15:00');
  assert.equal(shouldTriggerPeakChime({ mode: 'CHIME_ONLY', recentEvents5s: 0, burstThreshold: 3 }), true);
  assert.equal(shouldTriggerPeakChime({ mode: 'FULL_NAME', recentEvents5s: 10, burstThreshold: 3 }), false);
  assert.equal(shouldTriggerPeakChime({ mode: 'AUTO_ADAPTIVE', recentEvents5s: 2, burstThreshold: 3 }), false);
  assert.equal(shouldTriggerPeakChime({ mode: 'AUTO_ADAPTIVE', recentEvents5s: 3, burstThreshold: 3 }), true);
  assert.equal(buildKioskSpeechSentence({ names: ['Raka'], mode: 'CHIME_ONLY', isPeak: true }), null);
  assert.equal(
    buildKioskSpeechSentence({ names: ['Raka'], mode: 'AUTO_ADAPTIVE', isPeak: false }),
    'Silakan masuk, Raka'
  );
  assert.equal(
    buildKioskSpeechSentence({ names: ['Raka', 'Siti', 'Dimas', 'Fajar', 'Budi'], mode: 'AUTO_ADAPTIVE', isPeak: true }),
    'Raka, Siti, Dimas, Fajar'
  );
});

test('blendFaceEmbeddings normalizes centroid and evaluateFaceMaintenanceProgress tracks 80% target', () => {
  const blended = blendFaceEmbeddings([1, 0, 0], [0, 1, 0], 0.72, 0.86);
  const norm = Math.sqrt(blended.reduce((acc, v) => acc + v * v, 0));
  assert.ok(Math.abs(norm - 1) < 0.001, 'Blended embedding must be L2-normalized');
  assert.ok(blended[0] > 0 && blended[1] > 0, 'Blended vector should shift toward incoming embedding');

  const init = blendFaceEmbeddings(null, [3, 4, 0], 0, 0.85);
  assert.deepEqual(init, [0.6, 0.8, 0]);

  const training = evaluateFaceMaintenanceProgress({ currentQuality: 0.74, matchedSimilarity: 0.62, targetScore: 0.80 });
  assert.equal(training.isOptimal, false);
  assert.equal(training.needsTraining, true);
  assert.equal(training.qualityPct, 74);
  assert.equal(training.similarityPct, 62);

  const optimal = evaluateFaceMaintenanceProgress({ currentQuality: 0.845, matchedSimilarity: 0.81, targetScore: 0.80 });
  assert.equal(optimal.isOptimal, true);
  assert.equal(optimal.needsTraining, false);
  assert.equal(optimal.targetPct, 80);
});

test('maskRtspCredentials hides password and parseRtspProbeOutput extracts HEVC/1080p/5fps', () => {
  assert.equal(
    maskRtspCredentials('rtsp://admin:p3p3kl4h!!@103.166.36.59/cam/realmonitor?channel=1&subtype=0'),
    'rtsp://admin:****@103.166.36.59/cam/realmonitor?channel=1&subtype=0'
  );
  assert.equal(maskRtspCredentials('dummy://test'), 'dummy://test');

  const meta = parseRtspProbeOutput(
    JSON.stringify({ streams: [{ codec_name: 'hevc', width: 1920, height: 1080, r_frame_rate: '5/1' }] })
  );
  assert.deepEqual(meta, { codec: 'HEVC', width: 1920, height: 1080, resolusi: '1920x1080', fps: 5 });

  assert.equal(
    maskRtspCredentials('Connection refused rtsp://admin:secret!!@10.0.0.5:554/stream1'),
    'Connection refused rtsp://admin:****@10.0.0.5:554/stream1'
  );

  const ffmpegStderr = [
    "Input #0, rtsp, from 'rtsp://admin:secret@103.166.36.59/cam/realmonitor':",
    '  Stream #0:0: Video: hevc (Main), yuv420p(tv), 1920x1080, 5 fps, 5 tbr, 90k tbn',
    "Output #0, image2pipe, to 'pipe:1':",
    '  Stream #0:0: Video: mjpeg, yuvj420p(pc), 1920x1080, 5 fps',
  ].join('\n');
  assert.deepEqual(parseFfmpegStreamOutput(ffmpegStderr), {
    codec: 'HEVC',
    width: 1920,
    height: 1080,
    resolusi: '1920x1080',
    fps: 5,
  });

  const h264Stderr = 'Stream #0:0: Video: h264 (High), yuv420p, 1280x720 [SAR 1:1 DAR 16:9], 25 tbr, 90k tbn';
  assert.deepEqual(parseFfmpegStreamOutput(h264Stderr), {
    codec: 'H264',
    width: 1280,
    height: 720,
    resolusi: '1280x720',
    fps: 25,
  });
});

test('extractJpegFramesFromChunk handles partial chunks and multiple frames cleanly', () => {
  const f1 = new Uint8Array([0xff, 0xd8, 0x01, 0x02, 0xff, 0xd9]);
  const f2a = new Uint8Array([0xff, 0xd8, 0xaa, 0xbb]);
  const f2b = new Uint8Array([0xcc, 0xff, 0xd9]);

  const combined1 = new Uint8Array([0x00, 0x11, ...f1, ...f2a]);
  const res1 = extractJpegFramesFromChunk(new Uint8Array(0), combined1);
  assert.equal(res1.frames.length, 1);
  assert.deepEqual(Array.from(res1.frames[0]), Array.from(f1));
  assert.deepEqual(Array.from(res1.remainder), Array.from(f2a));

  const res2 = extractJpegFramesFromChunk(res1.remainder, f2b);
  assert.equal(res2.frames.length, 1);
  assert.deepEqual(Array.from(res2.frames[0]), [0xff, 0xd8, 0xaa, 0xbb, 0xcc, 0xff, 0xd9]);
  assert.equal(res2.remainder.length, 0);
});

test('validateAndNormalizeScheduleTimes and stripDemoRecordsForProduction enforce rules accurately', () => {
  const ok = validateAndNormalizeScheduleTimes({
    jam_masuk_mulai: '06:00',
    jam_masuk_selesai: '07:15:00',
    jam_keluar_mulai: '15:00',
    jam_keluar_selesai: '17:00',
  });
  assert.equal(ok.ok, true);
  if (ok.ok) {
    assert.equal(ok.jam_masuk_mulai, '06:00:00');
    assert.equal(ok.jam_keluar_selesai, '17:00:00');
  }

  const bad = validateAndNormalizeScheduleTimes({
    jam_masuk_mulai: '08:00:00',
    jam_masuk_selesai: '07:00:00',
    jam_keluar_mulai: '15:00:00',
    jam_keluar_selesai: '17:00:00',
  });
  assert.equal(bad.ok, false);

  const cleaned = stripDemoRecordsForProduction({
    students: [{ nisn: '0081122001' }, { nisn: '9999999999' }],
    cameras: [
      { rtsp_url: 'dummy://ganti-dengan-rtsp-kamera' },
      { rtsp_url: 'rtsp://admin:smk2026@192.168.10.21:554/Streaming/Channels/101' },
      { rtsp_url: 'rtsp://admin:pass@103.166.36.59/cam/realmonitor?channel=1&subtype=0' },
    ],
    wa_accounts: [
      { phone_number: '6281122334455' },
      { phone_number: '6281998877665' },
      { phone_number: '6285211223344' },
    ],
    daily_attendance: [{ id: 1 }],
    attendance_logs: [{ id: 1 }],
    anonymous_clusters: [{ id: 101 }],
    face_update_history: [{ id: 1 }],
    face_update_reviews: [{ id: 1 }],
    wa_queue: [{ id: 1 }],
    notifications: [{ id: 1 }],
    guest_access_logs: [{ id: 1 }],
    settings: { production_mode: false },
    storage_bytes_simulated: 685 * 1024 * 1024,
  });

  assert.equal(cleaned.settings.production_mode, true);
  assert.equal(cleaned.students.length, 1);
  assert.equal(cleaned.students[0].nisn, '9999999999');
  assert.equal(cleaned.cameras.length, 1);
  assert.ok(cleaned.cameras[0].rtsp_url.includes('103.166.36.59'));
  assert.equal(cleaned.wa_accounts?.length, 1);
  assert.equal(cleaned.wa_accounts?.[0].phone_number, '6285211223344');
  assert.equal(cleaned.anonymous_clusters.length, 0);
});

test('getJakartaNowParts converts UTC midnight/early morning to WIB date/time and summarizeEmbeddingDimensions tallies vectors', async () => {
  const { getJakartaNowParts, summarizeEmbeddingDimensions } = await import('./attendanceEngine');
  // 2026-11-18T23:30:00Z = 2026-11-19 06:30:00 WIB (Thursday, dayIso=4)
  const sample = new Date('2026-11-18T23:30:00Z');
  const wib = getJakartaNowParts(sample, 'Asia/Jakarta');
  assert.equal(wib.dateStr, '2026-11-19');
  assert.equal(wib.timeStr, '06:30:00');
  assert.equal(wib.dayIso, 4);
  assert.equal(wib.dateTimeStr, '2026-11-19 06:30:00');

  const summary = summarizeEmbeddingDimensions(
    [
      { embedding: new Array(16).fill(0.1) },
      { embedding: new Array(512).fill(0.1) },
      { embedding: new Array(1024).fill(0.1) },
      { embedding: null },
    ],
    [{ centroid: new Array(1024).fill(0.2) }]
  );
  assert.deepEqual(summary.students, {
    dim_16_demo: 1,
    dim_512_insightface: 1,
    dim_1024_node_wasm: 1,
    empty: 1,
    other: 0,
  });
  assert.equal(summary.clusters.dim_1024_node_wasm, 1);
});

test('applyWaQuotaResetIfDue resets hourly_count per WIB hour and daily_count per WIB day', async () => {
  const { applyWaQuotaResetIfDue } = await import('./attendanceEngine');
  const acc = { daily_count: 19, hourly_count: 10, last_reset_at: '2026-11-19 07:45:00' };
  // Same hour -> no reset
  assert.equal(applyWaQuotaResetIfDue(acc, '2026-11-19 07:59:10'), false);
  assert.equal(acc.hourly_count, 10);
  // Next hour same day -> reset hourly_count only
  assert.equal(applyWaQuotaResetIfDue(acc, '2026-11-19 08:01:00'), true);
  assert.equal(acc.hourly_count, 0);
  assert.equal(acc.daily_count, 19);
  // Next WIB day -> reset both daily_count & hourly_count
  acc.hourly_count = 5;
  assert.equal(applyWaQuotaResetIfDue(acc, '2026-11-20 06:00:00'), true);
  assert.equal(acc.hourly_count, 0);
  assert.equal(acc.daily_count, 0);
});

test('appendClusterHitSnapshot preserves hit gallery up to limit and returns pruned paths except best_snapshot_path', async () => {
  const { appendClusterHitSnapshot } = await import('./attendanceEngine');
  const h1 = { snapshot_path: '/data/snapshots/h1.jpg', quality_score: 0.72, similarity: 0.81, camera_id: 1, detected_at: '2026-11-19 07:00:00' };
  const h2 = { snapshot_path: '/data/snapshots/h2.jpg', quality_score: 0.91, similarity: 0.88, camera_id: 1, detected_at: '2026-11-19 07:01:00' };
  const h3 = { snapshot_path: '/data/snapshots/h3.jpg', quality_score: 0.80, similarity: 0.84, camera_id: 2, detected_at: '2026-11-19 07:02:00' };
  const h4 = { snapshot_path: '/data/snapshots/h4.jpg', quality_score: 0.78, similarity: 0.82, camera_id: 2, detected_at: '2026-11-19 07:03:00' };

  const step1 = appendClusterHitSnapshot([h2, h1], h3, '/data/snapshots/h2.jpg', 3);
  assert.equal(step1.hits.length, 3);
  assert.equal(step1.removedPaths.length, 0);

  // Pushing h4 with maxHits=3 drops h1 (not best) while never removing best_snapshot_path
  const step2 = appendClusterHitSnapshot(step1.hits, h4, '/data/snapshots/h1.jpg', 3);
  assert.equal(step2.hits.length, 3);
  assert.deepEqual(step2.removedPaths, []);

  const step3 = appendClusterHitSnapshot(step1.hits, h4, '/data/snapshots/h2.jpg', 3);
  assert.deepEqual(step3.removedPaths, ['/data/snapshots/h1.jpg']);
});

test('passesSnapshotQualityThreshold enforces minimum 70% quality gate and calibrates realistic CCTV faces', async () => {
  const { normalizeMinSnapshotQuality, passesSnapshotQualityThreshold } = await import('./attendanceEngine');
  const weights = { weight_confidence: 0.3, weight_size: 0.25, weight_sharpness: 0.25, weight_frontal: 0.2 };

  // Threshold floor always stays >= 0.70 (70%)
  assert.equal(normalizeMinSnapshotQuality(undefined), 0.7);
  assert.equal(normalizeMinSnapshotQuality(0.55), 0.7);
  assert.equal(normalizeMinSnapshotQuality(0.86), 0.86);

  // < 70% is rejected, >= 70% passes
  assert.equal(passesSnapshotQualityThreshold(0.699, 0.7).passed, false);
  assert.equal(passesSnapshotQualityThreshold(0.7, 0.7).passed, true);
  assert.equal(passesSnapshotQualityThreshold(0.74, 0.75).passed, false);

  // Realistic CCTV gate crop achieves >= 0.70, very blurry/small crop stays < 0.70
  const clearGateScore = computeQualityScore(
    { confidence: 0.92, faceSizePx: 112, sharpnessNorm: 0.84, frontalScore: 0.91 },
    weights
  );
  const blurrySmallScore = computeQualityScore(
    { confidence: 0.65, faceSizePx: 64, sharpnessNorm: 0.35, frontalScore: 0.55 },
    weights
  );
  assert.ok(clearGateScore >= 0.7, `Expected clear CCTV score >= 0.70, got ${clearGateScore}`);
  assert.ok(blurrySmallScore < 0.7, `Expected blurry CCTV score < 0.70, got ${blurrySmallScore}`);
});
