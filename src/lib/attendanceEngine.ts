import type {
  AttendanceLog,
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
  const sizeNorm = Math.min(1, Math.max(0, (metrics.faceSizePx - 60) / 180));
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



