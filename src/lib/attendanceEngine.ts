import type {
  AnonymousCluster,
  AttendanceLog,
  ClusterStatus,
  DailyAttendance,
  GateType,
  Kelas,
  KelasScheduleOverride,
  Schedule,
  ScheduleException,
  SettingsMap,
  Student,
  WaAccount,
} from '../types';

export interface ResolvedSchedule {
  jam_masuk_mulai: string;
  jam_masuk_selesai: string;
  jam_keluar_mulai: string;
  jam_keluar_selesai: string;
  toleransi_terlambat_menit: number;
}

/**
 * Prioritas fallback jadwal SMK (Bagian 4.3):
 * 1. kelas_schedule_override (kelas_id + hari)
 * 2. schedules (jurusan_id + hari)
 * 3. schedules global (jurusan_id === null + hari)
 * 4. schedule_exceptions untuk tanggal tersebut (LIBUR -> null, override jam -> terapkan)
 * 5. Tidak ada jadwal -> null (tidak dihitung ALPA)
 */
export function resolveScheduleForStudent(params: {
  student: Student;
  kelas: Kelas | undefined;
  dateStr: string; // YYYY-MM-DD
  dayIso: number; // 1=Senin .. 7=Minggu
  schedules: Schedule[];
  kelasOverrides: KelasScheduleOverride[];
  exceptions: ScheduleException[];
}): ResolvedSchedule | null {
  const { student, kelas, dateStr, dayIso, schedules, kelasOverrides, exceptions } = params;
  if (!kelas || student.status === 'PKL' || student.status !== 'AKTIF') {
    return null;
  }

  // Cek exception: prioritas JURUSAN di atas GLOBAL
  const jurusanException = exceptions.find(
    (e) => e.tanggal === dateStr && e.scope === 'JURUSAN' && e.ref_id === kelas.jurusan_id
  );
  const globalException = exceptions.find(
    (e) => e.tanggal === dateStr && e.scope === 'GLOBAL'
  );
  const exception = jurusanException ?? globalException;

  if (exception && exception.tipe === 'LIBUR') {
    return null;
  }

  const override = kelasOverrides.find((o) => o.kelas_id === kelas.id && o.hari === dayIso);
  const jurusanSched = schedules.find((s) => s.jurusan_id === kelas.jurusan_id && s.hari === dayIso);
  const globalSched = schedules.find((s) => s.jurusan_id === null && s.hari === dayIso);

  const base = override ?? jurusanSched ?? globalSched;
  if (!base) {
    return null;
  }

  return {
    jam_masuk_mulai: exception?.jam_masuk_override ?? base.jam_masuk_mulai,
    jam_masuk_selesai: base.jam_masuk_selesai,
    jam_keluar_mulai: base.jam_keluar_mulai,
    jam_keluar_selesai: exception?.jam_keluar_override ?? base.jam_keluar_selesai,
    toleransi_terlambat_menit: 'toleransi_terlambat_menit' in base ? base.toleransi_terlambat_menit : 0,
  };
}

function timeToSeconds(hhmmss: string): number {
  const [h = 0, m = 0, s = 0] = String(hhmmss || '00:00:00').split(':').map(Number);
  return (Number.isFinite(h) ? h : 0) * 3600 + (Number.isFinite(m) ? m : 0) * 60 + (Number.isFinite(s) ? s : 0);
}

function addMinutesToTime(hhmmss: string, minutes: number): string {
  const totalSec = timeToSeconds(hhmmss) + minutes * 60;
  const clamped = Math.max(0, Math.min(86399, totalSec));
  const nh = String(Math.floor(clamped / 3600)).padStart(2, '0');
  const nm = String(Math.floor((clamped % 3600) / 60)).padStart(2, '0');
  const ns = String(clamped % 60).padStart(2, '0');
  return `${nh}:${nm}:${ns}`;
}

/**
 * Evaluasi event pengenalan wajah menjadi MASUK / KELUAR / OBSERVASI
 * serta aturan deduplikasi 30 detik lintas kamera dan 1 MASUK + 1 KELUAR per hari.
 */
export function evaluateAttendanceRecognition(params: {
  student: Student;
  gateType: GateType;
  timeNow: string; // HH:MM:SS
  dateStr: string; // YYYY-MM-DD
  schedule: ResolvedSchedule | null;
  existingDaily: DailyAttendance | undefined;
  recentLogs: AttendanceLog[];
  nowEpochMs: number;
}): {
  deduplicated: boolean;
  logType: 'MASUK' | 'KELUAR' | 'OBSERVASI';
  logStatus: 'HADIR' | 'TERLAMBAT';
  updateDaily: Partial<DailyAttendance> | null;
} {
  const { student, gateType, timeNow, schedule, existingDaily, recentLogs, nowEpochMs } = params;

  let logType: 'MASUK' | 'KELUAR' | 'OBSERVASI' = 'OBSERVASI';
  let logStatus: 'HADIR' | 'TERLAMBAT' = 'HADIR';

  if (schedule) {
    const masukWindowEnd = addMinutesToTime(schedule.jam_masuk_selesai, 120);
    const inMasuk = timeNow >= schedule.jam_masuk_mulai && timeNow <= masukWindowEnd;
    const inKeluar = timeNow >= schedule.jam_keluar_mulai && timeNow <= schedule.jam_keluar_selesai;

    if ((gateType === 'MASUK' || gateType === 'BOTH') && inMasuk) {
      logType = 'MASUK';
      const lateCutoff = addMinutesToTime(schedule.jam_masuk_selesai, schedule.toleransi_terlambat_menit);
      logStatus = timeNow > lateCutoff ? 'TERLAMBAT' : 'HADIR';
    } else if ((gateType === 'KELUAR' || gateType === 'BOTH') && inKeluar) {
      logType = 'KELUAR';
    }
  }

  // Deduplikasi lintas kamera window 30 detik untuk (student_id, logType)
  const isDup = recentLogs.some((l) => {
    if (l.student_id !== student.id || l.tipe !== logType) return false;
    const logMs = Date.parse(l.timestamp);
    return !Number.isNaN(logMs) && Math.abs(nowEpochMs - logMs) < 30_000;
  });

  if (isDup) {
    return { deduplicated: true, logType, logStatus, updateDaily: null };
  }

  let updateDaily: Partial<DailyAttendance> | null = null;
  if (logType === 'MASUK') {
    if (!existingDaily) {
      updateDaily = { jam_masuk: timeNow, status: logStatus };
    } else if (!existingDaily.jam_masuk && !existingDaily.manual_override_by) {
      updateDaily = { jam_masuk: timeNow, status: logStatus };
    }
  } else if (logType === 'KELUAR') {
    if (existingDaily && !existingDaily.jam_keluar) {
      updateDaily = { jam_keluar: timeNow };
    }
  }

  return { deduplicated: false, logType, logStatus, updateDaily };
}

/**
 * Formula Quality Score (Bagian 7.3):
 * 30% detection_confidence + 25% face_size_normalized + 25% sharpness + 20% frontal_score
 */
export function computeQualityScore(
  metrics: {
    confidence: number;
    faceSizePx: number;
    sharpnessNorm: number; // 0..1
    frontalScore: number; // 0..1
  },
  weights: Pick<SettingsMap, 'weight_confidence' | 'weight_size' | 'weight_sharpness' | 'weight_frontal'>
): number {
  const conf = Math.min(1, Math.max(0, metrics.confidence));
  const sizeNorm = Math.min(1, Math.max(0, metrics.faceSizePx / 160));
  const sharp = Math.min(1, Math.max(0, metrics.sharpnessNorm));
  const frontal = Math.min(1, Math.max(0, metrics.frontalScore));

  const totalW = Math.max(
    1e-6,
    weights.weight_confidence + weights.weight_size + weights.weight_sharpness + weights.weight_frontal
  );
  const raw =
    (weights.weight_confidence * conf +
      weights.weight_size * sizeNorm +
      weights.weight_sharpness * sharp +
      weights.weight_frontal * frontal) /
    totalW;
  return Math.round(raw * 10000) / 10000;
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom < 1e-12 ? 0 : Math.round((dot / denom) * 10000) / 10000;
}

export function checkClusterReadyStatus(params: {
  hitCount: number;
  distinctDays: number;
  hasBestSnapshot: boolean;
  readyHits: number;
  readyDays: number;
}): boolean {
  return (
    params.hasBestSnapshot &&
    params.hitCount >= params.readyHits &&
    params.distinctDays >= params.readyDays
  );
}

export function formatWaMessage(
  templateText: string,
  payload: { nama: string; kelas: string; tanggal: string; jam_masuk: string; jam_keluar: string; status: string }
): string {
  return templateText
    .replace(/\{nama\}/g, payload.nama || '-')
    .replace(/\{kelas\}/g, payload.kelas || '-')
    .replace(/\{tanggal\}/g, payload.tanggal || '-')
    .replace(/\{jam_masuk\}/g, payload.jam_masuk || '-')
    .replace(/\{jam_keluar\}/g, payload.jam_keluar || '-')
    .replace(/\{status\}/g, payload.status || '-');
}

export function checkWaAccountQuota(account: Pick<WaAccount, 'status' | 'daily_count' | 'hourly_count'>): boolean {
  if (account.status === 'PAUSED' || account.status === 'BANNED') return false;
  const maxDaily = account.status === 'WARMUP' ? 20 : 800;
  const maxHourly = account.status === 'WARMUP' ? 10 : 150;
  return account.daily_count < maxDaily && account.hourly_count < maxHourly;
}

export function applyWaQuotaResetIfDue(
  account: Pick<WaAccount, 'daily_count' | 'hourly_count' | 'last_reset_at'>,
  nowWibDateTimeStr: string
): boolean {
  const prev = String(account.last_reset_at || '');
  const curDate = nowWibDateTimeStr.slice(0, 10);
  const curHour = nowWibDateTimeStr.slice(0, 13);
  if (!prev || prev.slice(0, 10) !== curDate) {
    account.daily_count = 0;
    account.hourly_count = 0;
    account.last_reset_at = nowWibDateTimeStr;
    return true;
  }
  if (prev.slice(0, 13) !== curHour) {
    account.hourly_count = 0;
    account.last_reset_at = nowWibDateTimeStr;
    return true;
  }
  return false;
}

export function calculateAttendancePercentage(records: Array<Pick<DailyAttendance, 'status'>>): number {
  if (records.length === 0) return 0;
  const present = records.filter((r) =>
    r.status === 'HADIR' || r.status === 'TERLAMBAT' || r.status === 'TIDAK_KELUAR'
  ).length;
  return Math.round((present / records.length) * 1000) / 10;
}

export function normalizeExcelBirthDate(raw: unknown): string | null {
  if (raw === null || raw === undefined || raw === '') return null;
  if (raw instanceof Date && !Number.isNaN(raw.getTime())) {
    return raw.toISOString().slice(0, 10);
  }
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 1000) {
    // Excel serial date (epoch 1899-12-30 UTC)
    const utcMs = Math.round((raw - 25569) * 86_400_000);
    const d = new Date(utcMs);
    return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
  }
  const str = String(raw).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;
  const dmy = str.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (dmy) {
    const [, dd, mm, yyyy] = dmy;
    return `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
  }
  const parsed = Date.parse(str);
  if (!Number.isNaN(parsed)) {
    return new Date(parsed).toISOString().slice(0, 10);
  }
  return null;
}

export function normalizeWaPhone(raw: unknown): string {
  const digits = String(raw ?? '').replace(/[^0-9]/g, '');
  if (!digits) return '';
  if (digits.startsWith('0')) return `62${digits.slice(1)}`;
  if (digits.startsWith('8')) return `62${digits}`;
  return digits;
}

export function normalizeStudentStatus(raw: unknown): Student['status'] {
  const s = String(raw ?? 'AKTIF').trim().toUpperCase().replace(/\s+/g, '_');
  if (s === 'PKL' || s === 'LULUS' || s === 'CUTI' || s === 'IZIN_PANJANG') return s;
  return 'AKTIF';
}

export function parseKelasHierarchy(kelasName: string): { tingkat: string; jurusanKode: string; nama: string } {
  const clean = kelasName.trim().replace(/\s+/g, ' ');
  const parts = clean.split(' ');
  const tingkat = parts[0]?.toUpperCase() || 'X';
  const jurusanKode = (parts[1] || 'UMUM').toUpperCase().replace(/[^A-Z0-9]/g, '') || 'UMUM';
  return { tingkat, jurusanKode, nama: clean };
}

function tingkatRank(tingkat: string): number {
  const t = tingkat.trim().toUpperCase();
  if (t === 'X' || t === '10') return 10;
  if (t === 'XI' || t === '11') return 11;
  if (t === 'XII' || t === '12') return 12;
  if (t === 'XIII' || t === '13') return 13;
  return 0;
}

export function classifyAcademicTransition(params: {
  oldKelasNama: string | null;
  newKelasNama: string;
  newStatus: Student['status'];
}): 'BARU' | 'NAIK_KELAS' | 'TINGGAL_KELAS' | 'PINDAH_KELAS' | 'LULUS' | 'TETAP' {
  const { oldKelasNama, newKelasNama, newStatus } = params;
  if (!oldKelasNama) return 'BARU';
  if (newStatus === 'LULUS') return 'LULUS';

  const oldClean = oldKelasNama.trim().replace(/\s+/g, ' ');
  const newClean = newKelasNama.trim().replace(/\s+/g, ' ');
  const oldParsed = parseKelasHierarchy(oldClean);
  const newParsed = parseKelasHierarchy(newClean);
  const rOld = tingkatRank(oldParsed.tingkat);
  const rNew = tingkatRank(newParsed.tingkat);

  if (rOld > 0 && rNew > rOld) {
    return 'NAIK_KELAS';
  }
  if (oldClean.toLowerCase() !== newClean.toLowerCase()) {
    // Jika tingkat sama namun pindah jurusan/rombel
    return 'PINDAH_KELAS';
  }
  // Tingkat & kelas sama saat upload ulang data tahunan -> terdeteksi tinggal kelas
  return 'TINGGAL_KELAS';
}

export function computeScheduledWaDispatchTime(jamKeluarSelesai: string, delayMinutes = 60): string {
  const baseSec = timeToSeconds(jamKeluarSelesai || '16:00:00');
  const targetSec = Math.min(23 * 3600 + 59 * 60, Math.max(0, baseSec + Math.max(0, delayMinutes) * 60));
  const hh = String(Math.floor(targetSec / 3600)).padStart(2, '0');
  const mm = String(Math.floor((targetSec % 3600) / 60)).padStart(2, '0');
  const ss = String(targetSec % 60).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

export function shouldTriggerPeakChime(params: {
  mode: 'AUTO_ADAPTIVE' | 'CHIME_ONLY' | 'FULL_NAME';
  recentEvents5s: number;
  burstThreshold: number;
}): boolean {
  if (params.mode === 'CHIME_ONLY') return true;
  if (params.mode === 'FULL_NAME') return false;
  return params.recentEvents5s >= Math.max(2, params.burstThreshold);
}

/**
 * Menyusun kalimat TTS gerbang:
 * - CHIME_ONLY -> null (hanya nada bip instan)
 * - FULL_NAME atau kondisi sepi -> "Silakan masuk, <nama>"
 * - AUTO_ADAPTIVE saat jam sibuk -> gabungkan maks 4 nama sekaligus menjadi satu panggilan cepat ("Raka, Siti, Dimas, Fajar")
 */
export function buildKioskSpeechSentence(params: {
  names: string[];
  mode: 'AUTO_ADAPTIVE' | 'CHIME_ONLY' | 'FULL_NAME';
  isPeak: boolean;
}): string | null {
  const cleanNames = params.names.map((n) => n.trim()).filter(Boolean);
  if (cleanNames.length === 0) return null;
  if (params.mode === 'CHIME_ONLY') return null;

  if (params.mode === 'FULL_NAME' || !params.isPeak) {
    return cleanNames.length === 1 ? `Silakan masuk, ${cleanNames[0]}` : cleanNames.slice(0, 4).join(', ');
  }
  return cleanNames.slice(0, 4).join(', ');
}

/**
 * Menggabungkan embedding wajah lama dengan tangkapan CCTV terbaru menggunakan bobot kualitas,
 * lalu menormalisasi panjang vektor (L2-normalization) sehingga template wajah siswa semakin akurat
 * seiring siswa berjalan melewati berbagai kamera gerbang hingga melampaui target >= 80%.
 */
export function blendFaceEmbeddings(
  current: number[] | null,
  incoming: number[],
  currentQuality: number,
  incomingQuality: number
): number[] {
  if (!Array.isArray(incoming) || incoming.length === 0) {
    return Array.isArray(current) ? current : [];
  }
  if (!Array.isArray(current) || current.length !== incoming.length) {
    return normalizeVectorL2(incoming);
  }

  const wCurr = Math.max(0.15, Math.min(1, currentQuality || 0.5));
  const wInc = Math.max(0.15, Math.min(1, incomingQuality || 0.5));
  // Jika kualitas baru jauh lebih tinggi atau kualitas lama masih < 0.80, beri bobot adaptif hingga 45% pada tangkapan baru
  const ratio = Math.min(0.48, Math.max(0.18, (wInc / (wCurr + wInc)) * 0.7));
  const blended = new Array<number>(current.length);
  for (let i = 0; i < current.length; i++) {
    blended[i] = current[i] * (1 - ratio) + incoming[i] * ratio;
  }
  return normalizeVectorL2(blended);
}

function normalizeVectorL2(vec: number[]): number[] {
  let normSq = 0;
  for (let i = 0; i < vec.length; i++) {
    normSq += vec[i] * vec[i];
  }
  const norm = Math.sqrt(normSq);
  if (norm < 1e-12) return vec.slice();
  return vec.map((v) => Math.round((v / norm) * 100000) / 100000);
}

export function evaluateFaceMaintenanceProgress(params: {
  currentQuality: number;
  matchedSimilarity?: number;
  targetScore?: number;
}): {
  isOptimal: boolean;
  needsTraining: boolean;
  qualityPct: number;
  similarityPct: number;
  targetPct: number;
} {
  const target = Math.max(0.5, Math.min(0.99, params.targetScore ?? 0.80));
  const q = Math.max(0, Math.min(1, params.currentQuality || 0));
  const sim = Math.max(0, Math.min(1, params.matchedSimilarity ?? q));
  return {
    isOptimal: q >= target,
    needsTraining: q < target,
    qualityPct: Math.round(q * 1000) / 10,
    similarityPct: Math.round(sim * 1000) / 10,
    targetPct: Math.round(target * 1000) / 10,
  };
}

export function maskRtspCredentials(url: string): string {
  const raw = String(url || '').trim();
  if (!raw) return '-';
  return raw.replace(/(rtsps?:\/\/[^:/@\s]+):([^@\s]+)@/gi, '$1:****@');
}

export function parseRtspProbeOutput(jsonText: string): {
  codec: string;
  width: number;
  height: number;
  resolusi: string;
  fps: number;
} {
  try {
    const parsed = JSON.parse(jsonText) as {
      streams?: Array<{ codec_name?: string; width?: number; height?: number; r_frame_rate?: string; avg_frame_rate?: string }>;
    };
    const stream = parsed.streams?.[0];
    if (!stream) {
      return { codec: 'unknown', width: 0, height: 0, resolusi: '-', fps: 0 };
    }
    const width = Number(stream.width) || 0;
    const height = Number(stream.height) || 0;
    const rateStr = stream.r_frame_rate && stream.r_frame_rate !== '0/0' ? stream.r_frame_rate : stream.avg_frame_rate || '0/1';
    const [numStr, denStr = '1'] = rateStr.split('/');
    const num = Number(numStr) || 0;
    const den = Number(denStr) || 1;
    const fps = den > 0 ? Math.round((num / den) * 10) / 10 : 0;
    return {
      codec: String(stream.codec_name || 'unknown').toUpperCase(),
      width,
      height,
      resolusi: width > 0 && height > 0 ? `${width}x${height}` : '-',
      fps,
    };
  } catch {
    return { codec: 'unknown', width: 0, height: 0, resolusi: '-', fps: 0 };
  }
}

export function parseFfmpegStreamOutput(stderrText: string): {
  codec: string;
  width: number;
  height: number;
  resolusi: string;
  fps: number;
} {
  const raw = String(stderrText || '');
  const inputSection = raw.split(/Output #0/i)[0] || raw;
  const videoMatch = inputSection.match(/Stream #\d+:\d+[^:]*:\s*Video:\s*([^\r\n]+)/i);
  if (!videoMatch) {
    return { codec: 'unknown', width: 0, height: 0, resolusi: '-', fps: 0 };
  }
  const line = videoMatch[1];
  const codecMatch = line.match(/^([a-z0-9_]+)/i);
  const resMatch = line.match(/\b(\d{3,5})x(\d{3,5})\b/);
  const fpsMatch = line.match(/\b(\d+(?:\.\d+)?)\s*(?:fps|tbr)\b/i);

  const codec = codecMatch ? codecMatch[1].toUpperCase() : 'UNKNOWN';
  const width = resMatch ? Number(resMatch[1]) || 0 : 0;
  const height = resMatch ? Number(resMatch[2]) || 0 : 0;
  const fps = fpsMatch ? Math.round((Number(fpsMatch[1]) || 0) * 10) / 10 : 0;
  return {
    codec,
    width,
    height,
    resolusi: width > 0 && height > 0 ? `${width}x${height}` : '-',
    fps,
  };
}

export function extractJpegFramesFromChunk(
  existingBuf: Uint8Array,
  incomingChunk: Uint8Array
): { frames: Uint8Array[]; remainder: Uint8Array } {
  const combined = new Uint8Array(existingBuf.length + incomingChunk.length);
  combined.set(existingBuf, 0);
  combined.set(incomingChunk, existingBuf.length);

  const frames: Uint8Array[] = [];
  let offset = 0;

  while (offset < combined.length - 1) {
    let soi = -1;
    for (let i = offset; i < combined.length - 1; i++) {
      if (combined[i] === 0xff && combined[i + 1] === 0xd8) {
        soi = i;
        break;
      }
    }
    if (soi === -1) {
      return { frames, remainder: new Uint8Array(0) };
    }

    let eoi = -1;
    for (let i = soi + 2; i < combined.length - 1; i++) {
      if (combined[i] === 0xff && combined[i + 1] === 0xd9) {
        eoi = i;
        break;
      }
    }
    if (eoi === -1) {
      return { frames, remainder: combined.slice(soi) };
    }

    frames.push(combined.slice(soi, eoi + 2));
    offset = eoi + 2;
  }

  return { frames, remainder: combined.slice(offset) };
}

function normalizeTimeHhMmSs(raw: string): string | null {
  const clean = String(raw || '').trim();
  const m = clean.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  const ss = Number(m[3] ?? '0');
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59 || ss < 0 || ss > 59) return null;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}

export function validateAndNormalizeScheduleTimes(params: {
  jam_masuk_mulai: string;
  jam_masuk_selesai: string;
  jam_keluar_mulai: string;
  jam_keluar_selesai: string;
}):
  | {
      ok: true;
      jam_masuk_mulai: string;
      jam_masuk_selesai: string;
      jam_keluar_mulai: string;
      jam_keluar_selesai: string;
    }
  | { ok: false; error: string } {
  const m1 = normalizeTimeHhMmSs(params.jam_masuk_mulai);
  const m2 = normalizeTimeHhMmSs(params.jam_masuk_selesai);
  const k1 = normalizeTimeHhMmSs(params.jam_keluar_mulai);
  const k2 = normalizeTimeHhMmSs(params.jam_keluar_selesai);
  if (!m1 || !m2 || !k1 || !k2) {
    return { ok: false, error: 'Format jam jadwal harus HH:MM atau HH:MM:SS yang valid.' };
  }
  if (m1 >= m2) {
    return { ok: false, error: 'Jam masuk mulai harus lebih awal dari jam masuk selesai.' };
  }
  if (k1 >= k2) {
    return { ok: false, error: 'Jam keluar mulai harus lebih awal dari jam keluar selesai.' };
  }
  return {
    ok: true,
    jam_masuk_mulai: m1,
    jam_masuk_selesai: m2,
    jam_keluar_mulai: k1,
    jam_keluar_selesai: k2,
  };
}

export function isDemoPlaceholderCameraUrl(rtspUrl: string): boolean {
  const clean = String(rtspUrl || '').trim();
  if (!clean || clean.startsWith('dummy://')) return true;
  return /^rtsp:\/\/admin:smk2026@192\.168\.10\.(21|22):554\/Streaming\/Channels\/101$/i.test(clean);
}

export function stripDemoRecordsForProduction<
  T extends {
    students: Array<{ nisn: string }>;
    cameras: Array<{ rtsp_url: string }>;
    wa_accounts?: Array<{ phone_number: string }>;
    daily_attendance: unknown[];
    attendance_logs: unknown[];
    anonymous_clusters: unknown[];
    face_update_history: unknown[];
    face_update_reviews: unknown[];
    wa_queue: unknown[];
    notifications: unknown[];
    guest_access_logs: unknown[];
    settings: { production_mode?: boolean };
    storage_bytes_simulated: number;
  },
>(db: T): T {
  const demoNisnSet = new Set([
    '0081122001',
    '0081122002',
    '0081122003',
    '0081122004',
    '0081122005',
    '0081122006',
    '0081122007',
    '0081122008',
  ]);
  const demoWaPhones = new Set(['6281122334455', '6281998877665']);
  const onlyDemoStudents = db.students.every((s) => demoNisnSet.has(s.nisn));
  return {
    ...db,
    students: onlyDemoStudents ? [] : db.students.filter((s) => !demoNisnSet.has(s.nisn)),
    cameras: db.cameras.filter((c) => !isDemoPlaceholderCameraUrl(c.rtsp_url)),
    ...(Array.isArray(db.wa_accounts)
      ? { wa_accounts: db.wa_accounts.filter((a) => !demoWaPhones.has(String(a.phone_number || '').replace(/[^0-9]/g, ''))) }
      : {}),
    daily_attendance: onlyDemoStudents ? [] : db.daily_attendance,
    attendance_logs: onlyDemoStudents ? [] : db.attendance_logs,
    anonymous_clusters: [],
    face_update_history: onlyDemoStudents ? [] : db.face_update_history,
    face_update_reviews: onlyDemoStudents ? [] : db.face_update_reviews,
    wa_queue: [],
    notifications: [],
    guest_access_logs: [],
    settings: { ...db.settings, production_mode: true },
    storage_bytes_simulated: 12 * 1024 * 1024,
  };
}

export interface JakartaNowParts {
  dateStr: string;
  timeStr: string;
  dateTimeStr: string;
  isoTimestamp: string;
  dayIso: number; // 1=Senin .. 7=Minggu
  month: number;
  year: number;
}

const WEEKDAY_TO_ISO: Record<string, number> = {
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
  Sun: 7,
};

export function getJakartaNowParts(date: Date = new Date(), timeZone = 'Asia/Jakarta'): JakartaNowParts {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    weekday: 'short',
    hour12: false,
  });
  const parts = fmt.formatToParts(date);
  const pick = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? '';
  const yearNum = Number(pick('year')) || date.getUTCFullYear();
  const monthNum = Number(pick('month')) || date.getUTCMonth() + 1;
  const dayStr = pick('day').padStart(2, '0');
  const rawHour = Number(pick('hour'));
  const hh = String(rawHour === 24 ? 0 : rawHour).padStart(2, '0');
  const mm = pick('minute').padStart(2, '0');
  const ss = pick('second').padStart(2, '0');
  const monthStr = String(monthNum).padStart(2, '0');
  const yearStr = String(yearNum).padStart(4, '0');
  const dateStr = `${yearStr}-${monthStr}-${dayStr}`;
  const timeStr = `${hh}:${mm}:${ss}`;
  const weekday = pick('weekday');
  const dayIso = WEEKDAY_TO_ISO[weekday] ?? (date.getUTCDay() === 0 ? 7 : date.getUTCDay());
  return {
    dateStr,
    timeStr,
    dateTimeStr: `${dateStr} ${timeStr}`,
    isoTimestamp: `${dateStr}T${timeStr}`,
    dayIso,
    month: monthNum,
    year: yearNum,
  };
}

export function summarizeEmbeddingDimensions(
  students: Array<{ embedding: number[] | null | undefined }>,
  clusters: Array<{ centroid: number[] | null | undefined }>
): {
  students: { dim_16_demo: number; dim_512_insightface: number; dim_1024_node_wasm: number; empty: number; other: number };
  clusters: { dim_16_demo: number; dim_512_insightface: number; dim_1024_node_wasm: number; empty: number; other: number };
} {
  const tally = (vecs: Array<number[] | null | undefined>) => {
    const res = { dim_16_demo: 0, dim_512_insightface: 0, dim_1024_node_wasm: 0, empty: 0, other: 0 };
    for (const v of vecs) {
      if (!Array.isArray(v) || v.length === 0) res.empty += 1;
      else if (v.length === 16) res.dim_16_demo += 1;
      else if (v.length === 512) res.dim_512_insightface += 1;
      else if (v.length === 1024) res.dim_1024_node_wasm += 1;
      else res.other += 1;
    }
    return res;
  };
  return {
    students: tally(students.map((s) => s.embedding)),
    clusters: tally(clusters.map((c) => c.centroid)),
  };
}

export interface HitSnapshotRecord {
  snapshot_path: string;
  quality_score: number;
  similarity: number;
  camera_id: number | null;
  detected_at: string;
  embedding?: number[];
  has_embedding?: boolean;
}

export function appendClusterHitSnapshot(
  existingHits: HitSnapshotRecord[] | undefined,
  newHit: HitSnapshotRecord,
  bestSnapshotPath: string,
  maxHits = 5
): { hits: HitSnapshotRecord[]; removedPaths: string[] } {
  const list = Array.isArray(existingHits) ? [...existingHits] : [];
  if (!newHit.snapshot_path) {
    return { hits: list, removedPaths: [] };
  }
  const deduped = list.filter((item) => item.snapshot_path !== newHit.snapshot_path);
  const combined = [newHit, ...deduped];
  if (combined.length <= maxHits) {
    return { hits: combined, removedPaths: [] };
  }
  // Pilihan A: pertahankan foto Acuan utama + urutkan berdasar kualitas terbaik (tie-break terbaru)
  const ranked = [...combined].sort((a, b) => {
    if (a.snapshot_path === bestSnapshotPath) return -1;
    if (b.snapshot_path === bestSnapshotPath) return 1;
    if (b.quality_score !== a.quality_score) return b.quality_score - a.quality_score;
    return String(b.detected_at || '').localeCompare(String(a.detected_at || ''));
  });
  const kept = ranked.slice(0, maxHits);
  const keptSet = new Set(kept.map((item) => item.snapshot_path));
  const removedPaths: string[] = [];
  for (const dropped of ranked.slice(maxHits)) {
    if (
      dropped.snapshot_path &&
      dropped.snapshot_path !== bestSnapshotPath &&
      !keptSet.has(dropped.snapshot_path)
    ) {
      removedPaths.push(dropped.snapshot_path);
    }
  }
  return { hits: kept, removedPaths };
}

function getNormalizedClusterHits(cluster: AnonymousCluster): HitSnapshotRecord[] {
  if (Array.isArray(cluster.hit_snapshots) && cluster.hit_snapshots.length > 0) {
    return cluster.hit_snapshots.map((h) => ({ ...h }));
  }
  if (!cluster.best_snapshot_path) return [];
  return [
    {
      snapshot_path: cluster.best_snapshot_path,
      quality_score: cluster.best_quality_score,
      similarity: 1,
      camera_id: cluster.last_camera_id,
      detected_at: cluster.last_seen,
      embedding: Array.isArray(cluster.best_embedding) && cluster.best_embedding.length > 0 ? cluster.best_embedding : undefined,
    },
  ];
}

function recomputeCentroidFromHits(hits: HitSnapshotRecord[], fallbackCentroid: number[]): number[] {
  const withEmb = hits.filter((h) => Array.isArray(h.embedding) && h.embedding.length > 0);
  if (withEmb.length === 0) return fallbackCentroid;
  let centroid = [...withEmb[0].embedding!];
  let bestQ = withEmb[0].quality_score || 0.7;
  for (let i = 1; i < withEmb.length; i++) {
    const q = withEmb[i].quality_score || 0.7;
    centroid = blendFaceEmbeddings(centroid, withEmb[i].embedding!, bestQ, q);
    bestQ = Math.max(bestQ, q);
  }
  return centroid;
}

export function removeHitFromClusterState(params: {
  cluster: AnonymousCluster;
  snapshotPath?: string;
  hitIndex?: number;
  readyHits: number;
  readyDays: number;
}): {
  found: boolean;
  deletedCluster: boolean;
  removedHit: HitSnapshotRecord | null;
  shouldRemoveFile: boolean;
  updatedCluster: AnonymousCluster | null;
} {
  const { cluster, snapshotPath, hitIndex, readyHits, readyDays } = params;
  const hits = getNormalizedClusterHits(cluster);
  let targetIdx = -1;
  if (typeof snapshotPath === 'string' && snapshotPath.length > 0) {
    targetIdx = hits.findIndex((h) => h.snapshot_path === snapshotPath);
  }
  if (targetIdx === -1 && typeof hitIndex === 'number' && hitIndex >= 0 && hitIndex < hits.length) {
    targetIdx = hitIndex;
  }
  if (targetIdx === -1) {
    return { found: false, deletedCluster: false, removedHit: null, shouldRemoveFile: false, updatedCluster: null };
  }

  const removedHit = hits[targetIdx];
  const remainingHits = hits.filter((_, i) => i !== targetIdx);
  if (remainingHits.length === 0) {
    return {
      found: true,
      deletedCluster: true,
      removedHit,
      shouldRemoveFile: Boolean(removedHit.snapshot_path),
      updatedCluster: null,
    };
  }

  const bestHit = remainingHits.reduce((best, cur) => (cur.quality_score > best.quality_score ? cur : best), remainingHits[0]);
  const nextHitCount = Math.min(remainingHits.length, Math.max(0, cluster.hit_count - 1));
  const distinctDaySet = new Set(remainingHits.map((h) => String(h.detected_at || '').slice(0, 10)).filter(Boolean));
  const nextDistinctDays = Math.max(1, Math.min(cluster.distinct_days, Math.max(distinctDaySet.size, 1)));
  const sortedDates = remainingHits.map((h) => h.detected_at).filter(Boolean).sort();
  const nextFirstSeen = sortedDates[0] ?? cluster.first_seen;
  const nextLastSeen = sortedDates[sortedDates.length - 1] ?? cluster.last_seen;

  const nextBestEmbedding =
    Array.isArray(bestHit.embedding) && bestHit.embedding.length > 0
      ? bestHit.embedding
      : removedHit.snapshot_path === cluster.best_snapshot_path
        ? cluster.centroid
        : cluster.best_embedding;

  const nextCentroid = recomputeCentroidFromHits(remainingHits, nextBestEmbedding.length > 0 ? nextBestEmbedding : cluster.centroid);

  let nextStatus: ClusterStatus = cluster.status;
  if (cluster.status === 'READY' || cluster.status === 'PENDING') {
    // Setelah foto salah / foto topi dihapus manual, kembalikan ke PENDING agar wajah terus dilatih bersih lagi
    nextStatus = 'PENDING';
  }

  const stillReferenced = remainingHits.some((h) => h.snapshot_path === removedHit.snapshot_path);
  return {
    found: true,
    deletedCluster: false,
    removedHit,
    shouldRemoveFile: Boolean(removedHit.snapshot_path) && !stillReferenced,
    updatedCluster: {
      ...cluster,
      hit_count: nextHitCount,
      distinct_days: nextDistinctDays,
      first_seen: nextFirstSeen,
      last_seen: nextLastSeen,
      best_snapshot_path: bestHit.snapshot_path,
      best_quality_score: bestHit.quality_score,
      best_embedding: nextBestEmbedding,
      centroid: nextCentroid,
      hit_snapshots: remainingHits,
      status: nextStatus,
      last_camera_id: remainingHits[0]?.camera_id ?? cluster.last_camera_id,
    },
  };
}

export function removeMultipleHitsFromClusterState(params: {
  cluster: AnonymousCluster;
  snapshotPaths: string[];
  readyHits: number;
  readyDays: number;
}): {
  removedHits: HitSnapshotRecord[];
  removedFilePaths: string[];
  deletedCluster: boolean;
  updatedCluster: AnonymousCluster | null;
} {
  const { cluster, snapshotPaths, readyHits, readyDays } = params;
  const targets = new Set(snapshotPaths.filter(Boolean));
  if (targets.size === 0) {
    return { removedHits: [], removedFilePaths: [], deletedCluster: false, updatedCluster: cluster };
  }
  let working: AnonymousCluster | null = cluster;
  const removedHits: HitSnapshotRecord[] = [];
  const candidateFiles = new Set<string>();
  let deletedCluster = false;

  for (const sp of targets) {
    if (!working) break;
    const res = removeHitFromClusterState({
      cluster: working,
      snapshotPath: sp,
      readyHits,
      readyDays,
    });
    if (!res.found) continue;
    if (res.removedHit) {
      removedHits.push(res.removedHit);
      if (res.shouldRemoveFile && res.removedHit.snapshot_path) {
        candidateFiles.add(res.removedHit.snapshot_path);
      }
    }
    if (res.deletedCluster || !res.updatedCluster) {
      working = null;
      deletedCluster = true;
      break;
    }
    working = res.updatedCluster;
  }

  const stillUsed = new Set(
    working ? getNormalizedClusterHits(working).map((h) => h.snapshot_path) : []
  );
  const removedFilePaths = Array.from(candidateFiles).filter((p) => !stillUsed.has(p));

  return {
    removedHits,
    removedFilePaths,
    deletedCluster,
    updatedCluster: working,
  };
}

export function promoteHitInClusterState(params: {
  cluster: AnonymousCluster;
  snapshotPath?: string;
  hitIndex?: number;
}): { found: boolean; updatedCluster: AnonymousCluster | null } {
  const { cluster, snapshotPath, hitIndex } = params;
  const hits = getNormalizedClusterHits(cluster);
  let targetIdx = -1;
  if (typeof snapshotPath === 'string' && snapshotPath.length > 0) {
    targetIdx = hits.findIndex((h) => h.snapshot_path === snapshotPath);
  }
  if (targetIdx === -1 && typeof hitIndex === 'number' && hitIndex >= 0 && hitIndex < hits.length) {
    targetIdx = hitIndex;
  }
  if (targetIdx === -1) {
    return { found: false, updatedCluster: null };
  }
  const chosen = hits[targetIdx];
  return {
    found: true,
    updatedCluster: {
      ...cluster,
      best_snapshot_path: chosen.snapshot_path,
      best_quality_score: chosen.quality_score,
      best_embedding: Array.isArray(chosen.embedding) && chosen.embedding.length > 0 ? chosen.embedding : cluster.best_embedding,
      hit_snapshots: hits,
    },
  };
}

export function mergeAnonymousClustersState(params: {
  source: AnonymousCluster;
  target: AnonymousCluster;
  readyHits: number;
  readyDays: number;
  maxHits?: number;
}): { merged: AnonymousCluster; removedPaths: string[] } {
  const { source, target, readyHits, readyDays, maxHits = 50 } = params;
  const targetHits = getNormalizedClusterHits(target);
  const sourceHits = getNormalizedClusterHits(source);

  const mergedByPath = new Map<string, HitSnapshotRecord>();
  for (const h of [...targetHits, ...sourceHits]) {
    if (!h.snapshot_path) continue;
    const prev = mergedByPath.get(h.snapshot_path);
    if (!prev || h.quality_score > prev.quality_score) {
      mergedByPath.set(h.snapshot_path, h);
    }
  }

  const ordered = Array.from(mergedByPath.values()).sort((a, b) =>
    String(b.detected_at || '').localeCompare(String(a.detected_at || ''))
  );
  const kept = ordered.slice(0, maxHits);
  const keptPaths = new Set(kept.map((h) => h.snapshot_path));
  const bestFromTarget = target.best_quality_score >= source.best_quality_score ? target : source;
  const bestSnap =
    kept.find((h) => h.snapshot_path === bestFromTarget.best_snapshot_path)?.snapshot_path ??
    kept[0]?.snapshot_path ??
    bestFromTarget.best_snapshot_path;
  if (bestSnap && !keptPaths.has(bestSnap)) {
    keptPaths.add(bestSnap);
  }
  const removedPaths = ordered
    .slice(maxHits)
    .map((h) => h.snapshot_path)
    .filter((p) => p && !keptPaths.has(p));

  const distinctDaysSet = new Set(
    kept.map((h) => String(h.detected_at || '').slice(0, 10)).filter(Boolean)
  );
  const nextHitCount = target.hit_count + source.hit_count;
  const nextDistinctDays = Math.max(target.distinct_days, source.distinct_days, distinctDaysSet.size || 1);
  const nextCentroid =
    target.centroid.length > 0 && source.centroid.length === target.centroid.length
      ? blendFaceEmbeddings(target.centroid, source.centroid, target.best_quality_score, source.best_quality_score)
      : target.centroid.length > 0
        ? target.centroid
        : source.centroid;
  const nextStatus: ClusterStatus = checkClusterReadyStatus({
    hitCount: nextHitCount,
    distinctDays: nextDistinctDays,
    hasBestSnapshot: Boolean(bestSnap),
    readyHits,
    readyDays,
  })
    ? 'READY'
    : 'PENDING';

  return {
    merged: {
      ...target,
      centroid: nextCentroid,
      hit_count: nextHitCount,
      distinct_days: nextDistinctDays,
      first_seen: [target.first_seen, source.first_seen].filter(Boolean).sort()[0] ?? target.first_seen,
      last_seen: [target.last_seen, source.last_seen].filter(Boolean).sort().slice(-1)[0] ?? target.last_seen,
      best_snapshot_path: bestSnap,
      best_quality_score: Math.max(target.best_quality_score, source.best_quality_score),
      best_embedding:
        bestFromTarget.best_embedding.length > 0 ? bestFromTarget.best_embedding : target.best_embedding,
      hit_snapshots: kept,
      status: nextStatus,
    },
    removedPaths,
  };
}

export function normalizeMinSnapshotQuality(rawValue: unknown): number {
  const num = Number(rawValue);
  if (!Number.isFinite(num)) return 0.7;
  return Math.min(0.99, Math.max(0.7, Math.round(num * 100) / 100));
}

export function normalizeCaptureMaxWidth(rawValue: unknown): number {
  const num = Number(rawValue);
  if (!Number.isFinite(num)) return 1280;
  const rounded = Math.round(num);
  if (rounded <= 0) return 0; // 0 = Resolusi asli kamera (Native tanpa resize)
  const clamped = Math.min(7680, Math.max(320, rounded));
  // FFmpeg libx264/mjpeg -2 scale bekerja bersih pada lebar genap
  return clamped % 2 === 0 ? clamped : clamped - 1;
}

export function normalizeCaptureJpegQuality(rawValue: unknown): number {
  const num = Number(rawValue);
  if (!Number.isFinite(num)) return 86;
  return Math.min(98, Math.max(50, Math.round(num)));
}

export function normalizeMinFaceSize(rawValue: unknown): number {
  const num = Number(rawValue);
  if (!Number.isFinite(num)) return 60;
  return Math.min(4096, Math.max(16, Math.round(num)));
}

export function parseResolutionDimensions(resolusi: string | null | undefined): { width: number; height: number } {
  const match = String(resolusi || '').match(/(\d{3,4})\s*[xX×]\s*(\d{3,4})/);
  if (!match) return { width: 1920, height: 1080 };
  const width = Math.min(7680, Math.max(160, Number(match[1]) || 1920));
  const height = Math.min(4320, Math.max(120, Number(match[2]) || 1080));
  return { width, height };
}

export function formatManualResolution(width: number, height: number): string {
  const rawW = Number.isFinite(Number(width)) ? Math.round(Number(width)) : 1920;
  const rawH = Number.isFinite(Number(height)) ? Math.round(Number(height)) : 1080;
  const wClamped = Math.min(7680, Math.max(160, rawW));
  const hClamped = Math.min(4320, Math.max(120, rawH));
  const wEven = wClamped % 2 === 0 ? wClamped : wClamped - 1;
  const hEven = hClamped % 2 === 0 ? hClamped : hClamped - 1;
  return `${wEven}x${hEven}`;
}

export function resolveCameraCaptureWidth(
  cameraResolution: string | null | undefined,
  globalCaptureMaxWidth: number,
  cameraCaptureMaxWidth?: number | null
): number {
  const { width: camWidth } = parseResolutionDimensions(cameraResolution);
  const configured =
    cameraCaptureMaxWidth !== null && cameraCaptureMaxWidth !== undefined && Number.isFinite(Number(cameraCaptureMaxWidth))
      ? normalizeCaptureMaxWidth(cameraCaptureMaxWidth)
      : normalizeCaptureMaxWidth(globalCaptureMaxWidth);
  if (configured === 0) return camWidth;
  return Math.min(camWidth, configured);
}

export function computeCalibratedMinFacePx(params: {
  cameraResolution: string | null | undefined;
  globalMinFaceSize: number;
  cameraMinFaceSize?: number | null;
  globalCaptureMaxWidth: number;
  cameraCaptureMaxWidth?: number | null;
}): {
  targetCameraPx: number;
  cameraWidth: number;
  cameraHeight: number;
  effectiveFrameWidth: number;
  effectiveFrameHeight: number;
  scaleRatio: number;
  effectiveMinFacePx: number;
  widthPercent: number;
} {
  const { width: cameraWidth, height: cameraHeight } = parseResolutionDimensions(params.cameraResolution);
  const targetCameraPx = normalizeMinFaceSize(
    params.cameraMinFaceSize !== null && params.cameraMinFaceSize !== undefined
      ? params.cameraMinFaceSize
      : params.globalMinFaceSize
  );
  const effectiveFrameWidth = resolveCameraCaptureWidth(
    params.cameraResolution,
    params.globalCaptureMaxWidth,
    params.cameraCaptureMaxWidth
  );
  const scaleRatio = cameraWidth > 0 ? Math.min(1, effectiveFrameWidth / cameraWidth) : 1;
  const effectiveFrameHeight = Math.max(2, Math.round(cameraHeight * scaleRatio));
  const effectiveMinFacePx = Math.max(16, Math.round(targetCameraPx * scaleRatio));
  const widthPercent = Math.round((targetCameraPx / Math.max(1, cameraWidth)) * 1000) / 10;

  return {
    targetCameraPx,
    cameraWidth,
    cameraHeight,
    effectiveFrameWidth,
    effectiveFrameHeight,
    scaleRatio,
    effectiveMinFacePx,
    widthPercent,
  };
}

export function buildFfmpegCaptureVideoFilter(fps: number, maxWidth: number): string {
  const safeFps = Math.max(1, Math.min(15, Math.round(Number(fps) || 1)));
  const normWidth = normalizeCaptureMaxWidth(maxWidth);
  if (normWidth === 0) {
    return `fps=${safeFps}`;
  }
  return `fps=${safeFps},scale='min(${normWidth},iw)':-2`;
}

export function describeCaptureResolutionMode(maxWidth: number): string {
  const norm = normalizeCaptureMaxWidth(maxWidth);
  if (norm === 0) return 'Native (Asli Kamera)';
  if (norm === 640) return '640 px (360p)';
  if (norm === 960) return '960 px (540p)';
  if (norm === 1280) return '1280 px (HD 720p)';
  if (norm === 1920) return '1920 px (Full HD 1080p)';
  if (norm === 2560) return '2560 px (2K QHD)';
  if (norm === 3840) return '3840 px (4K UHD)';
  return `${norm} px (Custom)`;
}

export function passesSnapshotQualityThreshold(
  qualityScore: number,
  minQuality = 0.7
): { passed: boolean; threshold: number; score: number } {
  const threshold = normalizeMinSnapshotQuality(minQuality);
  const score = Number.isFinite(Number(qualityScore)) ? Number(qualityScore) : 0;
  return {
    passed: score >= threshold,
    threshold,
    score,
  };
}

