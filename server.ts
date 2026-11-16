import fs from 'fs';
import http from 'http';
import path from 'path';
import { execFile } from 'child_process';
import { createRequire } from 'module';
import { promisify } from 'util';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import * as XLSX from 'xlsx';
import {
  DATA_DIR,
  SNAPSHOTS_DIR,
  createAuthSession,
  deleteAuthSession,
  deleteStudentFromSqlite,
  getBackupFilePath,
  getSessionUserId,
  hashPassword,
  listBackups,
  loadDb,
  restoreFromBackupBuffer,
  runCompactBackup,
  runStorageCleanup,
  sanitizeUser,
  saveDb,
  verifyPassword,
} from './src/server/store.ts';
import { isPiperAvailable, prewarmStudentNamesTts, synthesizeIndonesianWav } from './src/server/ttsService.ts';
import {
  dispatchWaMessage,
  getPairingState,
  restoreSavedBaileysSessions,
  startBaileysPairing,
  startWaQueueWorker,
} from './src/server/waGateway.ts';
import {
  blendFaceEmbeddings,
  calculateAttendancePercentage,
  checkClusterReadyStatus,
  classifyAcademicTransition,
  computeQualityScore,
  computeScheduledWaDispatchTime,
  cosineSimilarity,
  evaluateAttendanceRecognition,
  evaluateFaceMaintenanceProgress,
  formatWaMessage,
  maskRtspCredentials,
  normalizeExcelBirthDate,
  normalizeStudentStatus,
  normalizeWaPhone,
  parseFfmpegStreamOutput,
  parseKelasHierarchy,
  resolveScheduleForStudent,
} from './src/lib/attendanceEngine.ts';
import type { AcademicTransitionType, AppDatabase, AttendanceStatus, Student, User, UserRole } from './src/types';

const FACE_SERVICE_URL = process.env.FACE_SERVICE_URL || 'http://127.0.0.1:8001';
const execFileAsync = promisify(execFile);
const requireCjs = createRequire(import.meta.url);

function resolveFfmpegBinary(): string {
  try {
    const mod = requireCjs('@ffmpeg-installer/ffmpeg') as { path?: string };
    if (mod?.path && fs.existsSync(mod.path)) {
      return mod.path;
    }
  } catch {
    // fallback to system ffmpeg
  }
  if (fs.existsSync('/usr/bin/ffmpeg')) return '/usr/bin/ffmpeg';
  if (fs.existsSync('/usr/local/bin/ffmpeg')) return '/usr/local/bin/ffmpeg';
  return 'ffmpeg';
}

const app = express();
app.use(express.json({ limit: '25mb' }));
app.use('/data/snapshots', express.static(SNAPSHOTS_DIR));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

interface WsMeta {
  cameraId: string | null;
}
const wsClients = new Map<WebSocket, WsMeta>();
const panggilCooldown = new Map<string, number>();

wss.on('connection', (ws, req) => {
  const url = new URL(req.url ?? '/ws', 'http://localhost:3000');
  const cameraId = url.searchParams.get('camera_id');
  wsClients.set(ws, { cameraId });
  ws.send(JSON.stringify({ event: 'connected', camera_id: cameraId }));
  ws.on('close', () => wsClients.delete(ws));
});

function broadcastWs(payload: Record<string, unknown>) {
  const targetCam = payload.camera_id ? String(payload.camera_id) : null;
  const serialized = JSON.stringify(payload);
  for (const [client, meta] of wsClients.entries()) {
    if (client.readyState !== WebSocket.OPEN) continue;
    if (!meta.cameraId || !targetCam || meta.cameraId === targetCam) {
      client.send(serialized);
    }
  }
}

function nextId(items: Array<{ id: number }>): number {
  return items.length === 0 ? 1 : Math.max(...items.map((x) => x.id)) + 1;
}

function deterministicVecFromSeed(seedStr: string): number[] {
  let hash = 0;
  for (let i = 0; i < seedStr.length; i++) {
    hash = (hash * 31 + seedStr.charCodeAt(i)) | 0;
  }
  const vec: number[] = [];
  for (let i = 0; i < 16; i++) {
    vec.push(Math.round(Math.sin((hash + i * 17) * 0.13) * 1000) / 1000);
  }
  return vec;
}

async function callFaceService<T>(endpoint: string, body?: unknown): Promise<T | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const resp = await fetch(`${FACE_SERVICE_URL}${endpoint}`, {
      method: body !== undefined ? 'POST' : 'GET',
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!resp.ok) return null;
    return (await resp.json()) as T;
  } catch {
    return null;
  }
}

function triggerPythonCameraReload(): void {
  callFaceService('/cameras/reload', {}).catch(() => {});
}

function removeSnapshotIfLocal(relPath: string | null | undefined): void {
  if (!relPath || !relPath.startsWith('/data/snapshots/')) return;
  const full = path.join(DATA_DIR, relPath.replace(/^\/data\//, ''));
  try {
    if (fs.existsSync(full)) fs.unlinkSync(full);
  } catch {
    // ignore unlink error
  }
}

function applyContinuousFaceMaintenance(params: {
  db: AppDatabase;
  student: Student;
  incomingEmbedding: number[];
  incomingQuality: number;
  snapshotPath: string;
  nowStr: string;
}): { updated: boolean; keptSnapshot: boolean; reachedTarget: boolean } {
  const { db, student, incomingEmbedding, incomingQuality, snapshotPath, nowStr } = params;
  const target = db.settings.face_maintenance_target ?? 0.80;
  const prevQuality = student.embedding_quality_score || 0;
  const blended = blendFaceEmbeddings(student.embedding, incomingEmbedding, prevQuality, incomingQuality);

  const qualityImproved = incomingQuality > prevQuality;
  const stillTrainingBelowTarget = prevQuality < target && incomingQuality >= 0.65;

  if (!qualityImproved && !stillTrainingBelowTarget) {
    return { updated: false, keptSnapshot: false, reachedTarget: prevQuality >= target };
  }

  student.embedding = blended;
  student.embedding_updated_at = nowStr;
  if (qualityImproved) {
    student.embedding_quality_score = incomingQuality;
  }

  if (qualityImproved) {
    const newVer = db.face_update_history.filter((h) => h.student_id === student.id).length + 1;
    const histId = nextId(db.face_update_history);
    db.face_update_history.push({
      id: histId,
      student_id: student.id,
      version: newVer,
      embedding: blended,
      quality_score: incomingQuality,
      snapshot_path: snapshotPath || student.foto_ref || '/src/assets/images/student_portrait_one_1794810213963.jpg',
      created_at: nowStr,
      approved_by: null,
      approved_at: null,
      is_canonical: false,
    });

    // Daftarkan kandidat ke review bulanan BK jika melewati ambang >= target atau peningkatan signifikan
    const nowDate = new Date();
    const curMonth = nowDate.getMonth() + 1;
    const curYear = nowDate.getFullYear();
    const pendingRev = db.face_update_reviews.find(
      (r) => r.student_id === student.id && r.status === 'PENDING'
    );
    if (pendingRev) {
      pendingRev.candidate_snapshots = [
        {
          history_id: histId,
          snapshot_path: snapshotPath || student.foto_ref || '/src/assets/images/student_portrait_one_1794810213963.jpg',
          quality_score: incomingQuality,
          created_at: nowStr,
        },
        ...pendingRev.candidate_snapshots,
      ].slice(0, 3);
      pendingRev.best_new_quality = Math.max(pendingRev.best_new_quality, incomingQuality);
    } else if (incomingQuality >= Math.min(0.75, target)) {
      db.face_update_reviews.unshift({
        id: nextId(db.face_update_reviews),
        student_id: student.id,
        month: curMonth,
        year: curYear,
        candidate_snapshots: [
          {
            history_id: histId,
            snapshot_path: snapshotPath || student.foto_ref || '/src/assets/images/student_portrait_one_1794810213963.jpg',
            quality_score: incomingQuality,
            created_at: nowStr,
          },
        ],
        current_quality: prevQuality,
        best_new_quality: incomingQuality,
        status: 'PENDING',
        reviewed_by: null,
        reviewed_at: null,
      });
    }
  }

  return {
    updated: true,
    keptSnapshot: qualityImproved,
    reachedTarget: student.embedding_quality_score >= target,
  };
}

// ============================================================================
// AUTHENTICATION HELPERS & MIDDLEWARE
// ============================================================================

const SESSION_COOKIE = 'absensi_sid';

function extractSessionToken(req: express.Request): string | null {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7).trim();
  }
  const rawCookie = req.headers.cookie;
  if (!rawCookie) return null;
  for (const part of rawCookie.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === SESSION_COOKIE) {
      return decodeURIComponent(v.join('='));
    }
  }
  return null;
}

function resolveAuthenticatedUser(req: express.Request): { user: User; token: string } | null {
  const token = extractSessionToken(req);
  if (!token) return null;
  const userId = getSessionUserId(token);
  if (!userId) return null;
  const db = loadDb();
  const user = db.users.find((u) => u.id === userId && u.is_active);
  if (!user) return null;
  return { user: sanitizeUser(user), token };
}

function requireAuth(allowedRoles?: UserRole[]): express.RequestHandler {
  return (req, res, next) => {
    const auth = resolveAuthenticatedUser(req);
    if (!auth) {
      res.status(401).json({ error: 'Sesi login diperlukan. Silakan login terlebih dahulu.' });
      return;
    }
    if (allowedRoles && !allowedRoles.includes(auth.user.role)) {
      res.status(403).json({ error: `Akses ditolak untuk peran ${auth.user.role}.` });
      return;
    }
    (req as express.Request & { authUser?: User }).authUser = auth.user;
    next();
  };
}

// ============================================================================
// API ROUTES
// ============================================================================

app.get('/api/health', async (_req, res) => {
  const faceHealth = await callFaceService<Record<string, unknown>>('/health');
  res.json({
    ok: true,
    sqlite: true,
    piper_offline: isPiperAvailable(),
    face_service: faceHealth ?? { ok: false, mode: 'node-fallback' },
  });
});

app.get('/api/auth/me', (req, res) => {
  const db = loadDb();
  const auth = resolveAuthenticatedUser(req);
  res.json({
    authenticated: Boolean(auth),
    user: auth?.user ?? null,
    school_name: db.settings.school_name,
  });
});

app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body ?? {};
  if (!email || !password) {
    res.status(400).json({ error: 'Email dan password wajib diisi.' });
    return;
  }
  const db = loadDb();
  const user = db.users.find((u) => u.email.toLowerCase() === String(email).trim().toLowerCase());
  if (!user || !user.is_active || !verifyPassword(String(password), user.password_hash)) {
    res.status(401).json({ error: 'Email atau password salah, atau akun tidak aktif.' });
    return;
  }
  const session = createAuthSession(user.id);
  res.setHeader(
    'Set-Cookie',
    `${SESSION_COOKIE}=${encodeURIComponent(session.token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${24 * 3600}`
  );
  res.json({ ok: true, token: session.token, user: sanitizeUser(user) });
});

app.post('/api/auth/logout', (req, res) => {
  const token = extractSessionToken(req);
  deleteAuthSession(token);
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
  res.json({ ok: true });
});

app.post('/api/auth/change-password', requireAuth(), (req, res) => {
  const authUser = (req as express.Request & { authUser?: User }).authUser!;
  const { oldPassword, newPassword } = req.body ?? {};
  if (!oldPassword || !newPassword || String(newPassword).length < 6) {
    res.status(400).json({ error: 'Password baru minimal 6 karakter.' });
    return;
  }
  const db = loadDb();
  const user = db.users.find((u) => u.id === authUser.id);
  if (!user || !verifyPassword(String(oldPassword), user.password_hash)) {
    res.status(400).json({ error: 'Password lama tidak sesuai.' });
    return;
  }
  user.password_hash = hashPassword(String(newPassword));
  saveDb(db);
  res.json({ ok: true });
});

app.get('/api/kiosk/:cameraId', (req, res) => {
  const db = loadDb();
  const cid = Number(req.params.cameraId) || 1;
  const camera = db.cameras.find((c) => c.id === cid) ?? db.cameras[0] ?? null;
  const gate = camera ? db.gates.find((g) => g.id === camera.gate_id) ?? null : null;
  res.json({
    school_name: db.settings.school_name,
    camera,
    gate,
    tts_mode: db.settings.tts_mode,
    tts_max_age_sec: db.settings.tts_max_age_sec,
    tts_burst_threshold: db.settings.tts_burst_threshold,
    demo_student_id: db.students[0]?.id ?? null,
  });
});

app.get('/api/tts', async (req, res) => {
  const text = String(req.query.text ?? '').trim();
  if (!text) {
    res.status(400).end();
    return;
  }
  try {
    const wavPath = await synthesizeIndonesianWav(text);
    if (!wavPath) {
      res.status(204).end();
      return;
    }
    res.setHeader('Content-Type', 'audio/wav');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.sendFile(wavPath);
  } catch {
    res.status(204).end();
  }
});

app.get('/api/bootstrap', requireAuth(), (_req, res) => {
  const db = loadDb();
  res.json({
    ...db,
    users: db.users.map(sanitizeUser),
  });
});

app.get('/api/students/autocomplete', requireAuth(), (req, res) => {
  const q = String(req.query.q ?? '').trim().toLowerCase();
  if (q.length < 3) {
    res.json([]);
    return;
  }
  const db = loadDb();
  const kelasMap = new Map(db.kelas.map((k) => [k.id, k.nama]));
  const matches = db.students
    .filter((s) => s.nama.toLowerCase().includes(q) || s.nisn.toLowerCase().includes(q) || s.nis.toLowerCase().includes(q))
    .slice(0, 15)
    .map((s) => ({
      id: s.id,
      nama: s.nama,
      nisn: s.nisn,
      nis: s.nis,
      kelas: kelasMap.get(s.kelas_id) ?? '-',
    }));
  res.json(matches);
});

app.get('/api/students/import-template', requireAuth(), (_req, res) => {
  const db = loadDb();
  const sampleKelas1 = db.kelas[0]?.nama ?? 'X TKJ 1';
  const sampleKelas2 = db.kelas[1]?.nama ?? 'XI RPL 1';

  const templateRows = [
    {
      NIS: '2402001',
      NISN: '0091234501',
      Nama: 'Ahmad Fauzan',
      Nickname: 'Fauzan',
      Kelas: sampleKelas1,
      Tanggal_Lahir: '2009-04-12',
      Status: 'AKTIF',
      WA_Ortu: '081234567890',
    },
    {
      NIS: '2402002',
      NISN: '0091234502',
      Nama: 'Nabila Putri',
      Nickname: 'Nabila',
      Kelas: sampleKelas2,
      Tanggal_Lahir: '2008-11-23',
      Status: 'AKTIF',
      WA_Ortu: '6281298765432',
    },
  ];

  const wsSiswa = XLSX.utils.json_to_sheet(templateRows);
  wsSiswa['!cols'] = [
    { wch: 12 },
    { wch: 15 },
    { wch: 24 },
    { wch: 14 },
    { wch: 14 },
    { wch: 15 },
    { wch: 14 },
    { wch: 16 },
  ];

  const jurusanMap = new Map(db.jurusans.map((j) => [j.id, j]));
  const refKelasRows = db.kelas.map((k) => {
    const jur = jurusanMap.get(k.jurusan_id);
    return {
      Kelas: k.nama,
      Tingkat: k.tingkat,
      Kode_Jurusan: jur?.kode ?? '-',
      Nama_Jurusan: jur?.nama ?? '-',
      Shift: k.shift,
    };
  });
  const wsRef = XLSX.utils.json_to_sheet(refKelasRows);
  wsRef['!cols'] = [{ wch: 15 }, { wch: 10 }, { wch: 14 }, { wch: 28 }, { wch: 10 }];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, wsSiswa, 'Data_Siswa');
  XLSX.utils.book_append_sheet(wb, wsRef, 'Referensi_Kelas');

  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="template_import_siswa.xlsx"');
  res.send(buf);
});

app.post('/api/students/import-excel', requireAuth(['ADMIN', 'BK']), (req, res) => {
  const { fileBase64, updateExisting = false, markMissingGraduated = false } = req.body ?? {};
  if (!fileBase64 || typeof fileBase64 !== 'string') {
    res.status(400).json({ error: 'File Excel/CSV wajib diunggah.' });
    return;
  }

  let rows: Array<Record<string, unknown>> = [];
  try {
    const cleanBase64 = fileBase64.includes(',') ? fileBase64.split(',').slice(1).join(',') : fileBase64;
    const buffer = Buffer.from(cleanBase64, 'base64');
    const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
    const firstSheetName = wb.SheetNames[0];
    if (!firstSheetName) {
      res.status(400).json({ error: 'Workbook Excel kosong (tidak ada sheet).' });
      return;
    }
    const ws = wb.Sheets[firstSheetName];
    rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, { defval: '' });
  } catch {
    res.status(400).json({ error: 'Gagal membaca file Excel/CSV. Pastikan format .xlsx, .xls, atau .csv valid.' });
    return;
  }

  if (rows.length === 0) {
    res.status(400).json({ error: 'Sheet pertama tidak memiliki baris data siswa.' });
    return;
  }

  const db = loadDb();
  let imported = 0;
  let updated = 0;
  let skipped = 0;
  let promoted = 0;
  let retained = 0;
  let transferred = 0;
  let graduated = 0;
  const createdClasses: string[] = [];
  const errors: string[] = [];
  const transitions: Array<{
    nisn: string;
    nama: string;
    oldKelas: string;
    newKelas: string;
    transition: AcademicTransitionType;
  }> = [];
  const seenStudentIds = new Set<number>();

  const pickVal = (norm: Record<string, unknown>, keys: string[]): unknown => {
    for (const k of keys) {
      if (norm[k] !== undefined && String(norm[k]).trim() !== '') {
        return norm[k];
      }
    }
    return '';
  };

  for (let i = 0; i < rows.length; i++) {
    const rowNum = i + 2;
    const rawRow = rows[i];
    const norm: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(rawRow)) {
      const nk = k.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
      norm[nk] = v;
    }

    const nis = String(pickVal(norm, ['NIS', 'NO_INDUK'])).trim();
    const nisn = String(pickVal(norm, ['NISN'])).trim();
    const nama = String(pickVal(norm, ['NAMA', 'NAMA_LENGKAP', 'NAMA_SISWA'])).trim();
    const nicknameRaw = String(pickVal(norm, ['NICKNAME', 'PANGGILAN', 'NAMA_PANGGILAN'])).trim();
    const kelasRaw = String(pickVal(norm, ['KELAS', 'NAMA_KELAS', 'ROMBEL'])).trim();
    const tglRaw = pickVal(norm, ['TANGGAL_LAHIR', 'TGL_LAHIR', 'LAHIR', 'DOB']);
    const statusRaw = pickVal(norm, ['STATUS', 'STATUS_SISWA']);
    const waRaw = pickVal(norm, ['WA_ORTU', 'NO_WA', 'WHATSAPP', 'HP_ORTU', 'NO_HP']);

    if (!nis && !nisn && !nama) {
      continue;
    }

    if (!nis || !nisn || !nama || !kelasRaw) {
      skipped++;
      errors.push(`Baris ${rowNum}: Kolom NIS, NISN, Nama, dan Kelas wajib diisi.`);
      continue;
    }

    const tanggalLahir = normalizeExcelBirthDate(tglRaw);
    if (!tanggalLahir) {
      skipped++;
      errors.push(`Baris ${rowNum} (${nama}): Tanggal lahir "${String(tglRaw)}" tidak valid (gunakan YYYY-MM-DD atau DD/MM/YYYY).`);
      continue;
    }

    const parsedKelas = parseKelasHierarchy(kelasRaw);
    let kelasObj = db.kelas.find((k) => k.nama.toLowerCase() === parsedKelas.nama.toLowerCase());
    if (!kelasObj) {
      let jurusanObj = db.jurusans.find((j) => j.kode.toLowerCase() === parsedKelas.jurusanKode.toLowerCase());
      if (!jurusanObj) {
        jurusanObj = {
          id: nextId(db.jurusans),
          kode: parsedKelas.jurusanKode,
          nama: `Jurusan ${parsedKelas.jurusanKode}`,
        };
        db.jurusans.push(jurusanObj);
      }
      kelasObj = {
        id: nextId(db.kelas),
        jurusan_id: jurusanObj.id,
        tingkat: parsedKelas.tingkat,
        nama: parsedKelas.nama,
        shift: 'PAGI',
      };
      db.kelas.push(kelasObj);
      createdClasses.push(kelasObj.nama);
    }

    const waOrtu = normalizeWaPhone(waRaw);
    const status = normalizeStudentStatus(statusRaw);
    const nickname = nicknameRaw || nama.split(' ')[0];

    const existing = db.students.find((s) => s.nisn === nisn || s.nis === nis);
    if (existing) {
      seenStudentIds.add(existing.id);
      if (updateExisting) {
        const oldKelas = db.kelas.find((k) => k.id === existing.kelas_id)?.nama ?? '-';
        const transition = classifyAcademicTransition({
          oldKelasNama: oldKelas,
          newKelasNama: kelasObj.nama,
          newStatus: status,
        });
        if (transition === 'NAIK_KELAS') promoted++;
        else if (transition === 'TINGGAL_KELAS') retained++;
        else if (transition === 'PINDAH_KELAS') transferred++;
        else if (transition === 'LULUS') graduated++;

        if (transitions.length < 100) {
          transitions.push({
            nisn,
            nama,
            oldKelas,
            newKelas: status === 'LULUS' ? 'LULUS' : kelasObj.nama,
            transition,
          });
        }

        // Pertahankan embedding & foto wajah agar tidak perlu enrollment ulang saat naik kelas!
        existing.nis = nis;
        existing.nisn = nisn;
        existing.nama = nama;
        existing.nickname = nickname;
        existing.kelas_id = kelasObj.id;
        existing.tanggal_lahir = tanggalLahir;
        existing.status = status;
        if (waOrtu) existing.wa_ortu = waOrtu;
        updated++;
      } else {
        skipped++;
        errors.push(`Baris ${rowNum} (${nama}): NISN ${nisn} / NIS ${nis} sudah terdaftar.`);
      }
      continue;
    }

    const newId = nextId(db.students);
    seenStudentIds.add(newId);
    db.students.push({
      id: newId,
      nis,
      nisn,
      nama,
      nickname,
      kelas_id: kelasObj.id,
      tanggal_lahir: tanggalLahir,
      status,
      embedding: null,
      embedding_quality_score: 0,
      embedding_updated_at: null,
      foto_ref: null,
      wa_ortu: waOrtu,
      created_at: new Date().toISOString(),
    });
    imported++;
  }

  if (updateExisting && markMissingGraduated) {
    for (const s of db.students) {
      if (seenStudentIds.has(s.id) || s.status === 'LULUS') continue;
      const oldK = db.kelas.find((k) => k.id === s.kelas_id);
      if (oldK && (oldK.tingkat === 'XII' || oldK.tingkat === 'XIII')) {
        s.status = 'LULUS';
        graduated++;
        if (transitions.length < 100) {
          transitions.push({
            nisn: s.nisn,
            nama: s.nama,
            oldKelas: oldK.nama,
            newKelas: 'LULUS (Alumni)',
            transition: 'LULUS',
          });
        }
      }
    }
  }

  if (imported > 0 || updated > 0 || graduated > 0 || createdClasses.length > 0) {
    saveDb(db);
    triggerPythonCameraReload();
    prewarmStudentNamesTts(db.students.slice(-50).map((s) => s.nickname || s.nama));
  }

  res.json({
    ok: true,
    total: rows.length,
    imported,
    updated,
    skipped,
    promoted,
    retained,
    transferred,
    graduated,
    createdClasses,
    transitions,
    errors,
  });
});

app.post('/api/students', requireAuth(['ADMIN', 'BK']), (req, res) => {
  const db = loadDb();
  const { nis, nisn, nama, nickname, kelas_id, tanggal_lahir, status, wa_ortu } = req.body;
  if (!nis || !nisn || !nama || !kelas_id || !tanggal_lahir) {
    res.status(400).json({ error: 'NIS, NISN, nama, kelas, dan tanggal lahir wajib diisi.' });
    return;
  }
  if (db.students.some((s) => s.nis === nis || s.nisn === nisn)) {
    res.status(409).json({ error: 'NIS atau NISN sudah terdaftar.' });
    return;
  }
  const student = {
    id: nextId(db.students),
    nis: String(nis).trim(),
    nisn: String(nisn).trim(),
    nama: String(nama).trim(),
    nickname: String(nickname || nama.split(' ')[0]).trim(),
    kelas_id: Number(kelas_id),
    tanggal_lahir: String(tanggal_lahir),
    status: (status || 'AKTIF') as typeof db.students[number]['status'],
    embedding: null,
    embedding_quality_score: 0,
    embedding_updated_at: null,
    foto_ref: null,
    wa_ortu: String(wa_ortu || ''),
    created_at: new Date().toISOString(),
  };
  db.students.push(student);
  saveDb(db);
  res.json({ ok: true, student });
});

app.put('/api/students/:id', requireAuth(['ADMIN', 'BK']), (req, res) => {
  const db = loadDb();
  const id = Number(req.params.id);
  const st = db.students.find((s) => s.id === id);
  if (!st) {
    res.status(404).json({ error: 'Siswa tidak ditemukan.' });
    return;
  }
  Object.assign(st, {
    nama: req.body.nama ?? st.nama,
    nickname: req.body.nickname ?? st.nickname,
    kelas_id: req.body.kelas_id ? Number(req.body.kelas_id) : st.kelas_id,
    tanggal_lahir: req.body.tanggal_lahir ?? st.tanggal_lahir,
    status: req.body.status ?? st.status,
    wa_ortu: req.body.wa_ortu ?? st.wa_ortu,
  });
  saveDb(db);
  res.json({ ok: true, student: st });
});

app.delete('/api/students/:id', requireAuth(['ADMIN', 'BK']), (req, res) => {
  const db = loadDb();
  const id = Number(req.params.id);
  db.students = db.students.filter((s) => s.id !== id);
  db.daily_attendance = db.daily_attendance.filter((d) => d.student_id !== id);
  deleteStudentFromSqlite(id);
  saveDb(db);
  triggerPythonCameraReload();
  res.json({ ok: true });
});

// Jurusan & Kelas CRUD
app.post('/api/jurusans', requireAuth(['ADMIN']), (req, res) => {
  const db = loadDb();
  const kode = String(req.body?.kode ?? '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  const nama = String(req.body?.nama ?? '').trim();
  if (!kode || !nama) {
    res.status(400).json({ error: 'Kode dan Nama Jurusan wajib diisi.' });
    return;
  }
  if (db.jurusans.some((j) => j.kode.toUpperCase() === kode)) {
    res.status(409).json({ error: `Kode jurusan ${kode} sudah ada.` });
    return;
  }
  const jur = { id: nextId(db.jurusans), kode, nama };
  db.jurusans.push(jur);
  saveDb(db);
  res.json({ ok: true, jurusan: jur });
});

app.delete('/api/jurusans/:id', requireAuth(['ADMIN']), (req, res) => {
  const db = loadDb();
  const id = Number(req.params.id);
  const kelasInJurusan = db.kelas.filter((k) => k.jurusan_id === id);
  const kelasIds = new Set(kelasInJurusan.map((k) => k.id));
  const studentCount = db.students.filter((s) => kelasIds.has(s.kelas_id)).length;
  if (studentCount > 0) {
    res.status(409).json({
      error: `Tidak dapat menghapus jurusan karena masih memiliki ${studentCount} siswa aktif/terdaftar. Pindahkan atau hapus siswa terlebih dahulu.`,
    });
    return;
  }
  db.jurusans = db.jurusans.filter((j) => j.id !== id);
  db.kelas = db.kelas.filter((k) => k.jurusan_id !== id);
  db.schedules = db.schedules.filter((s) => s.jurusan_id !== id);
  saveDb(db);
  res.json({ ok: true });
});

app.post('/api/kelas', requireAuth(['ADMIN']), (req, res) => {
  const db = loadDb();
  const jurusan_id = Number(req.body?.jurusan_id);
  const tingkat = String(req.body?.tingkat ?? 'X').trim().toUpperCase();
  const nama = String(req.body?.nama ?? '').trim();
  const shift = (['PAGI', 'SIANG', 'NONE'].includes(req.body?.shift) ? req.body.shift : 'PAGI') as 'PAGI' | 'SIANG' | 'NONE';
  if (!jurusan_id || !nama) {
    res.status(400).json({ error: 'Jurusan dan nama kelas wajib diisi.' });
    return;
  }
  if (db.kelas.some((k) => k.nama.toLowerCase() === nama.toLowerCase())) {
    res.status(409).json({ error: `Kelas "${nama}" sudah terdaftar.` });
    return;
  }
  const kelas = { id: nextId(db.kelas), jurusan_id, tingkat, nama, shift };
  db.kelas.push(kelas);
  saveDb(db);
  res.json({ ok: true, kelas });
});

app.delete('/api/kelas/:id', requireAuth(['ADMIN']), (req, res) => {
  const db = loadDb();
  const id = Number(req.params.id);
  const studentCount = db.students.filter((s) => s.kelas_id === id).length;
  if (studentCount > 0) {
    res.status(409).json({ error: `Kelas masih memiliki ${studentCount} siswa. Pindahkan siswa terlebih dahulu.` });
    return;
  }
  db.kelas = db.kelas.filter((k) => k.id !== id);
  db.kelas_overrides = db.kelas_overrides.filter((o) => o.kelas_id !== id);
  saveDb(db);
  res.json({ ok: true });
});

app.post('/api/students/:id/enroll', requireAuth(['ADMIN', 'BK']), async (req, res) => {
  const db = loadDb();
  const id = Number(req.params.id);
  const st = db.students.find((s) => s.id === id);
  if (!st) {
    res.status(404).json({ error: 'Siswa tidak ditemukan.' });
    return;
  }
  const { photoDataUrl, confidence = 0.93, faceSizePx = 210 } = req.body;

  let qScore: number;
  let emb: number[];
  const aiRes = photoDataUrl
    ? await callFaceService<{ quality_score: number; embedding: number[] }>('/enroll', { photoDataUrl })
    : null;

  if (aiRes?.embedding) {
    qScore = aiRes.quality_score;
    emb = aiRes.embedding;
  } else {
    if (Number(confidence) < db.settings.threshold_confidence) {
      res.status(422).json({ error: `Confidence ${confidence} < threshold ${db.settings.threshold_confidence}. Wajah diabaikan.` });
      return;
    }
    qScore = computeQualityScore(
      { confidence: Number(confidence), faceSizePx: Number(faceSizePx), sharpnessNorm: 0.88, frontalScore: 0.91 },
      db.settings
    );
    emb = deterministicVecFromSeed(`${st.nisn}:${Date.now()}`);
  }

  const nowStr = new Date().toISOString().replace('T', ' ').slice(0, 19);
  st.embedding = emb;
  st.embedding_quality_score = qScore;
  st.embedding_updated_at = nowStr;
  if (photoDataUrl) {
    st.foto_ref = String(photoDataUrl);
  }

  db.face_update_history.push({
    id: nextId(db.face_update_history),
    student_id: st.id,
    version: db.face_update_history.filter((h) => h.student_id === st.id).length + 1,
    embedding: emb,
    quality_score: qScore,
    snapshot_path: st.foto_ref ?? '/src/assets/images/student_portrait_one_1794810213963.jpg',
    created_at: nowStr,
    approved_by: 1,
    approved_at: nowStr,
    is_canonical: true,
  });

  saveDb(db);
  triggerPythonCameraReload();
  res.json({ ok: true, quality_score: qScore, student: st });
});

app.post('/api/students/enroll-batch', requireAuth(['ADMIN', 'BK']), async (req, res) => {
  const db = loadDb();
  const entries: Array<{ filename: string; photoDataUrl?: string }> = req.body.entries ?? [];
  let success = 0;
  const failed: Array<{ file: string; error: string }> = [];
  const nowStr = new Date().toISOString().replace('T', ' ').slice(0, 19);

  for (const item of entries) {
    const stem = path.basename(item.filename, path.extname(item.filename)).split('_')[0].trim();
    const st = db.students.find((s) => s.nisn === stem || s.nis === stem);
    if (!st) {
      failed.push({ file: item.filename, error: `NISN/NIS ${stem} tidak ditemukan di database.` });
      continue;
    }

    const aiRes = item.photoDataUrl
      ? await callFaceService<{ quality_score: number; embedding: number[] }>('/enroll', {
          photoDataUrl: item.photoDataUrl,
        })
      : null;

    const qScore =
      aiRes?.quality_score ??
      computeQualityScore({ confidence: 0.91, faceSizePx: 195, sharpnessNorm: 0.86, frontalScore: 0.89 }, db.settings);
    st.embedding = aiRes?.embedding ?? deterministicVecFromSeed(`${st.nisn}:${item.filename}`);
    st.embedding_quality_score = qScore;
    st.embedding_updated_at = nowStr;
    if (item.photoDataUrl) st.foto_ref = item.photoDataUrl;
    success++;
  }

  saveDb(db);
  triggerPythonCameraReload();
  res.json({ processed: entries.length, success, failed });
});

app.post('/api/compare-face', requireAuth(), async (req, res) => {
  const db = loadDb();
  const { name1, size1 = 1000, photo1DataUrl, name2, size2 = 1000, photo2DataUrl } = req.body;
  if (!name1 || !name2) {
    res.status(400).json({ error: 'Kedua foto wajib diunggah.' });
    return;
  }

  if (photo1DataUrl && photo2DataUrl) {
    const aiCompare = await callFaceService<{
      similarity: number;
      threshold: number;
      match: boolean;
      status: string;
    }>('/compare', { photo1DataUrl, photo2DataUrl });
    if (aiCompare) {
      res.json(aiCompare);
      return;
    }
  }

  const stem1 = path.basename(String(name1), path.extname(String(name1))).toLowerCase();
  const stem2 = path.basename(String(name2), path.extname(String(name2))).toLowerCase();
  const v1 = deterministicVecFromSeed(`${stem1}:${Math.floor(Number(size1) / 100)}`);
  const v2 = stem1 === stem2
    ? v1
    : deterministicVecFromSeed(`${stem2}:${Math.floor(Number(size2) / 100)}`);

  const similarity = cosineSimilarity(v1, v2);
  const threshold = db.settings.threshold_recognition;
  const match = similarity >= threshold;
  res.json({
    similarity,
    threshold,
    match,
    status: match ? 'COCOK (IDENTITAS SAMA)' : 'TIDAK COCOK (BERBEDA)',
  });
});

app.post('/api/attendance/override', requireAuth(['ADMIN', 'BK']), (req, res) => {
  const authUser = (req as express.Request & { authUser?: User }).authUser!;
  const db = loadDb();
  const { student_id, tanggal, status, catatan } = req.body;
  const validStatuses: AttendanceStatus[] = ['HADIR', 'TERLAMBAT', 'ALPA', 'TIDAK_KELUAR', 'IZIN', 'SAKIT'];
  if (!student_id || !tanggal || !validStatuses.includes(status)) {
    res.status(400).json({ error: 'Parameter override tidak valid.' });
    return;
  }
  const nowStr = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const cleanCatatan = catatan !== undefined && catatan !== null ? String(catatan).trim().slice(0, 240) : null;
  const existing = db.daily_attendance.find((d) => d.student_id === Number(student_id) && d.tanggal === tanggal);
  if (existing) {
    existing.status = status;
    existing.manual_override_by = authUser.id;
    existing.manual_override_at = nowStr;
    if (catatan !== undefined) existing.catatan = cleanCatatan;
  } else {
    db.daily_attendance.push({
      id: nextId(db.daily_attendance),
      student_id: Number(student_id),
      tanggal,
      jam_masuk: status === 'HADIR' || status === 'TERLAMBAT' ? '07:00:00' : null,
      jam_keluar: null,
      status,
      manual_override_by: authUser.id,
      manual_override_at: nowStr,
      catatan: cleanCatatan,
    });
  }
  saveDb(db);
  res.json({ ok: true, by_role: authUser.role });
});

app.post('/api/simulate-recognition', requireAuth(), (req, res) => {
  const db = loadDb();
  const {
    camera_id = 1,
    student_id,
    anonymous = false,
    confidence = 0.93,
    faceSizePx = 200,
    simulatedTime,
  } = req.body;

  const cam = db.cameras.find((c) => c.id === Number(camera_id));
  if (!cam) {
    res.status(404).json({ error: 'Kamera tidak ditemukan.' });
    return;
  }
  const gate = db.gates.find((g) => g.id === cam.gate_id);

  // Filter confidence (Bagian 7.1)
  if (Number(confidence) < db.settings.threshold_confidence) {
    res.status(200).json({
      ignored: true,
      reason: `Detection confidence ${confidence} < ${db.settings.threshold_confidence} (diabaikan total).`,
    });
    return;
  }

  const now = new Date();
  const todayStr = now.toISOString().slice(0, 10);
  const timeNow = simulatedTime ? String(simulatedTime) : now.toTimeString().slice(0, 8);
  const dayIso = now.getDay() === 0 ? 7 : now.getDay();
  const nowStr = `${todayStr} ${timeNow}`;

  const qScore = computeQualityScore(
    { confidence: Number(confidence), faceSizePx: Number(faceSizePx), sharpnessNorm: 0.89, frontalScore: 0.92 },
    db.settings
  );

  if (anonymous || !student_id) {
    // Cek cluster anonim atau tambah baru / replace-if-better
    const existing = db.anonymous_clusters.find((c) => c.status === 'PENDING' || c.status === 'READY');
    if (existing) {
      existing.hit_count += 1;
      existing.last_seen = nowStr;
      existing.last_camera_id = cam.id;
      if (qScore > existing.best_quality_score) {
        existing.best_quality_score = qScore;
      }
      if (
        existing.status === 'PENDING' &&
        checkClusterReadyStatus({
          hitCount: existing.hit_count,
          distinctDays: existing.distinct_days,
          hasBestSnapshot: Boolean(existing.best_snapshot_path),
          readyHits: db.settings.cluster_ready_hits,
          readyDays: db.settings.cluster_ready_days,
        })
      ) {
        existing.status = 'READY';
        broadcastWs({ event: 'anonymous_cluster_ready', cluster_id: existing.id, camera_id: cam.id });
      }
    }
    saveDb(db);
    broadcastWs({
      event: 'face_detected',
      camera_id: cam.id,
      anonymous: true,
      message: 'Wajah baru terdeteksi. Menunggu verifikasi.',
      timestamp: timeNow,
    });
    res.json({ ok: true, anonymous: true, quality_score: qScore });
    return;
  }

  const student = db.students.find((s) => s.id === Number(student_id));
  if (!student) {
    res.status(404).json({ error: 'Siswa tidak ditemukan.' });
    return;
  }
  const kelas = db.kelas.find((k) => k.id === student.kelas_id);
  const sched = resolveScheduleForStudent({
    student,
    kelas,
    dateStr: todayStr,
    dayIso,
    schedules: db.schedules,
    kelasOverrides: db.kelas_overrides,
    exceptions: db.schedule_exceptions,
  });

  const existingDaily = db.daily_attendance.find((d) => d.student_id === student.id && d.tanggal === todayStr);
  const evalRes = evaluateAttendanceRecognition({
    student,
    gateType: gate?.tipe ?? 'BOTH',
    timeNow,
    dateStr: todayStr,
    schedule: sched,
    existingDaily,
    recentLogs: db.attendance_logs,
    nowEpochMs: Date.now(),
  });

  if (!evalRes.deduplicated) {
    db.attendance_logs.unshift({
      id: nextId(db.attendance_logs),
      student_id: student.id,
      gate_id: gate?.id ?? 1,
      camera_id: cam.id,
      timestamp: `${todayStr}T${timeNow}`,
      tipe: evalRes.logType,
      status: evalRes.logStatus,
      is_manual_override: false,
      similarity_score: Math.round(Math.min(0.99, Math.max(0.55, qScore * 0.92)) * 10000) / 10000,
    });

    if (evalRes.updateDaily) {
      if (existingDaily) {
        Object.assign(existingDaily, evalRes.updateDaily);
      } else {
        db.daily_attendance.push({
          id: nextId(db.daily_attendance),
          student_id: student.id,
          tanggal: todayStr,
          jam_masuk: evalRes.updateDaily.jam_masuk ?? null,
          jam_keluar: evalRes.updateDaily.jam_keluar ?? null,
          status: (evalRes.updateDaily.status as AttendanceStatus) ?? 'HADIR',
          manual_override_by: null,
          manual_override_at: null,
          catatan: null,
        });
      }
    }
  }

  // Real-time continuous face maintenance & centroid blending menuju target >= 80%
  const incomingVec = deterministicVecFromSeed(`${student.nisn}:${nowStr}`);
  const maintenance = applyContinuousFaceMaintenance({
    db,
    student,
    incomingEmbedding: incomingVec,
    incomingQuality: qScore,
    snapshotPath: student.foto_ref ?? '/src/assets/images/student_portrait_one_1794810213963.jpg',
    nowStr,
  });

  saveDb(db);
  if (maintenance.updated) {
    triggerPythonCameraReload();
  }

  // Anti-spam halaman panggil (60 detik per siswa per kamera, bypass jika forceCall=true)
  const cooldownKey = `${student.id}:${cam.id}`;
  const lastCall = panggilCooldown.get(cooldownKey) ?? 0;
  if (req.body.forceCall || Date.now() - lastCall >= 60_000) {
    panggilCooldown.set(cooldownKey, Date.now());
    broadcastWs({
      event: 'student_recognized',
      camera_id: cam.id,
      gate_id: gate?.id ?? 1,
      student_id: student.id,
      nama: student.nama,
      nickname: student.nickname || student.nama,
      nisn: student.nisn,
      kelas: kelas?.nama ?? '-',
      tipe: evalRes.logType,
      status: evalRes.logStatus,
      timestamp: timeNow,
    });
  }

  const evalProgress = evaluateFaceMaintenanceProgress({
    currentQuality: student.embedding_quality_score,
    targetScore: db.settings.face_maintenance_target,
  });

  res.json({
    ok: true,
    deduplicated: evalRes.deduplicated,
    logType: evalRes.logType,
    logStatus: evalRes.logStatus,
    quality_score: qScore,
    embeddingUpdated: maintenance.updated,
    maintenanceOptimal: evalProgress.isOptimal,
  });
});

// Gates & Cameras
app.post('/api/gates', requireAuth(['ADMIN']), (req, res) => {
  const db = loadDb();
  const gate = {
    id: nextId(db.gates),
    nama_gerbang: String(req.body.nama_gerbang),
    lokasi: String(req.body.lokasi || ''),
    tipe: req.body.tipe || 'BOTH',
  };
  db.gates.push(gate);
  saveDb(db);
  res.json({ ok: true, gate });
});

app.delete('/api/gates/:id', requireAuth(['ADMIN']), (req, res) => {
  const db = loadDb();
  const id = Number(req.params.id);
  db.gates = db.gates.filter((g) => g.id !== id);
  db.cameras = db.cameras.filter((c) => c.gate_id !== id);
  saveDb(db);
  res.json({ ok: true });
});

// Internal Python Face Service Hooks (Loopback Container)
app.get('/api/internal/cameras', (_req, res) => {
  const db = loadDb();
  res.json({ cameras: db.cameras });
});

app.get('/api/internal/gallery', (_req, res) => {
  const db = loadDb();
  const students = db.students
    .filter((s) => Array.isArray(s.embedding) && s.embedding.length > 0 && s.status !== 'LULUS')
    .map((s) => ({ id: s.id, embedding: s.embedding }));
  res.json({ students, settings: db.settings });
});

app.post('/api/internal/cameras/:id/heartbeat', (req, res) => {
  const db = loadDb();
  const cam = db.cameras.find((c) => c.id === Number(req.params.id));
  if (cam) {
    const online = Boolean(req.body.online);
    cam.status = online ? 'ONLINE' : 'OFFLINE';
    cam.last_error = req.body.error ? String(req.body.error) : null;
    if (online) {
      cam.last_online_at = new Date().toISOString().replace('T', ' ').slice(0, 19);
    }
    saveDb(db);
  }
  res.json({ ok: true });
});

app.post('/api/internal/face-event', (req, res) => {
  const db = loadDb();
  const { camera_id, student_id, similarity = 0, confidence = 0.9, quality_score = 0.8, embedding, snapshot_rel_path } = req.body;
  const cam = db.cameras.find((c) => c.id === Number(camera_id));
  if (!cam) {
    res.status(404).json({ error: 'Kamera tidak ditemukan.' });
    return;
  }
  const gate = db.gates.find((g) => g.id === cam.gate_id);
  const now = new Date();
  const todayStr = now.toISOString().slice(0, 10);
  const timeNow = now.toTimeString().slice(0, 8);
  const nowStr = `${todayStr} ${timeNow}`;
  const dayIso = now.getDay() === 0 ? 7 : now.getDay();

  if (!student_id) {
    // Cluster anonim dengan pencocokan cosine similarity + centroid blending lintas CCTV + replace-if-better snapshot
    let bestCluster = null as (typeof db.anonymous_clusters)[number] | null;
    let bestClusterSim = -1;
    for (const c of db.anonymous_clusters) {
      if ((c.status !== 'PENDING' && c.status !== 'READY') || !Array.isArray(embedding)) continue;
      const cSim = cosineSimilarity(embedding, c.centroid);
      if (cSim >= db.settings.threshold_clustering && cSim > bestClusterSim) {
        bestClusterSim = cSim;
        bestCluster = c;
      }
    }

    if (bestCluster) {
      bestCluster.hit_count += 1;
      if (!bestCluster.last_seen.startsWith(todayStr)) {
        bestCluster.distinct_days += 1;
      }
      bestCluster.last_seen = nowStr;
      bestCluster.last_camera_id = cam.id;
      if (Array.isArray(embedding)) {
        bestCluster.centroid = blendFaceEmbeddings(
          bestCluster.centroid,
          embedding,
          bestCluster.best_quality_score,
          Number(quality_score)
        );
      }
      if (Number(quality_score) > bestCluster.best_quality_score) {
        removeSnapshotIfLocal(bestCluster.best_snapshot_path);
        bestCluster.best_quality_score = Number(quality_score);
        if (snapshot_rel_path) bestCluster.best_snapshot_path = String(snapshot_rel_path);
        if (Array.isArray(embedding)) bestCluster.best_embedding = embedding;
      } else {
        removeSnapshotIfLocal(snapshot_rel_path);
      }
      if (
        bestCluster.status === 'PENDING' &&
        checkClusterReadyStatus({
          hitCount: bestCluster.hit_count,
          distinctDays: bestCluster.distinct_days,
          hasBestSnapshot: Boolean(bestCluster.best_snapshot_path),
          readyHits: db.settings.cluster_ready_hits,
          readyDays: db.settings.cluster_ready_days,
        })
      ) {
        bestCluster.status = 'READY';
        db.notifications.unshift({
          id: nextId(db.notifications),
          user_id: null,
          role_target: 'BK',
          type: 'CLUSTER_READY',
          title: `Wajah Anonim #${bestCluster.id} Siap Dinamai`,
          message: `Wajah anonim sudah terdeteksi ${bestCluster.hit_count}x di kamera sekolah (skor ${Math.round(bestCluster.best_quality_score * 100)}%). Mohon diberi nama oleh Guru BK.`,
          is_read: false,
          created_at: nowStr,
        });
        broadcastWs({ event: 'anonymous_cluster_ready', cluster_id: bestCluster.id, camera_id: cam.id });
      }
    } else if (Array.isArray(embedding)) {
      bestCluster = {
        id: nextId(db.anonymous_clusters),
        centroid: embedding,
        hit_count: 1,
        distinct_days: 1,
        first_seen: nowStr,
        last_seen: nowStr,
        best_snapshot_path: String(snapshot_rel_path || '/src/assets/images/student_portrait_four_1794810215936.jpg'),
        best_quality_score: Number(quality_score),
        best_embedding: embedding,
        status: 'PENDING',
        named_student_id: null,
        last_camera_id: cam.id,
      };
      db.anonymous_clusters.unshift(bestCluster);
    }

    saveDb(db);
    broadcastWs({
      event: 'face_detected',
      camera_id: cam.id,
      anonymous: true,
      message: 'Wajah baru terdeteksi. Menunggu verifikasi.',
      timestamp: timeNow,
    });
    res.json({ ok: true, anonymous: true, cluster_id: bestCluster?.id ?? null });
    return;
  }

  const student = db.students.find((s) => s.id === Number(student_id));
  if (!student) {
    removeSnapshotIfLocal(snapshot_rel_path);
    res.status(404).json({ error: 'Siswa tidak ditemukan.' });
    return;
  }

  const kelas = db.kelas.find((k) => k.id === student.kelas_id);
  const sched = resolveScheduleForStudent({
    student,
    kelas,
    dateStr: todayStr,
    dayIso,
    schedules: db.schedules,
    kelasOverrides: db.kelas_overrides,
    exceptions: db.schedule_exceptions,
  });
  const existingDaily = db.daily_attendance.find((d) => d.student_id === student.id && d.tanggal === todayStr);
  const evalRes = evaluateAttendanceRecognition({
    student,
    gateType: gate?.tipe ?? 'BOTH',
    timeNow,
    dateStr: todayStr,
    schedule: sched,
    existingDaily,
    recentLogs: db.attendance_logs,
    nowEpochMs: Date.now(),
  });

  if (!evalRes.deduplicated) {
    db.attendance_logs.unshift({
      id: nextId(db.attendance_logs),
      student_id: student.id,
      gate_id: gate?.id ?? 1,
      camera_id: cam.id,
      timestamp: `${todayStr}T${timeNow}`,
      tipe: evalRes.logType,
      status: evalRes.logStatus,
      is_manual_override: false,
      similarity_score: Number(similarity) || undefined,
    });
    if (evalRes.updateDaily) {
      if (existingDaily) {
        Object.assign(existingDaily, evalRes.updateDaily);
      } else {
        db.daily_attendance.push({
          id: nextId(db.daily_attendance),
          student_id: student.id,
          tanggal: todayStr,
          jam_masuk: evalRes.updateDaily.jam_masuk ?? null,
          jam_keluar: evalRes.updateDaily.jam_keluar ?? null,
          status: (evalRes.updateDaily.status as AttendanceStatus) ?? 'HADIR',
          manual_override_by: null,
          manual_override_at: null,
          catatan: null,
        });
      }
    }
  }

  let embeddingUpdated = false;
  if (Array.isArray(embedding) && embedding.length > 0) {
    const resMaint = applyContinuousFaceMaintenance({
      db,
      student,
      incomingEmbedding: embedding,
      incomingQuality: Number(quality_score),
      snapshotPath: String(snapshot_rel_path || student.foto_ref || ''),
      nowStr,
    });
    embeddingUpdated = resMaint.updated;
    if (!resMaint.keptSnapshot) {
      removeSnapshotIfLocal(snapshot_rel_path);
    }
  } else {
    removeSnapshotIfLocal(snapshot_rel_path);
  }

  saveDb(db);
  if (embeddingUpdated) {
    triggerPythonCameraReload();
  }
  const cooldownKey = `${student.id}:${cam.id}`;
  const lastCall = panggilCooldown.get(cooldownKey) ?? 0;
  if (Date.now() - lastCall >= 60_000) {
    panggilCooldown.set(cooldownKey, Date.now());
    broadcastWs({
      event: 'student_recognized',
      camera_id: cam.id,
      gate_id: gate?.id ?? 1,
      student_id: student.id,
      nama: student.nama,
      nickname: student.nickname || student.nama,
      nisn: student.nisn,
      kelas: kelas?.nama ?? '-',
      tipe: evalRes.logType,
      status: evalRes.logStatus,
      confidence,
      similarity,
      timestamp: timeNow,
    });
  }
  res.json({ ok: true, deduplicated: evalRes.deduplicated, embeddingUpdated });
});

app.post('/api/cameras', requireAuth(['ADMIN']), (req, res) => {
  const db = loadDb();
  const { nama_kamera, gate_id, rtsp_url, resolusi = '1920x1080', fps = 5, aktif = true } = req.body;
  const isDummy = !rtsp_url || String(rtsp_url).startsWith('dummy://');
  const cam = {
    id: nextId(db.cameras),
    nama_kamera: String(nama_kamera),
    gate_id: Number(gate_id),
    rtsp_url: String(rtsp_url),
    resolusi: String(resolusi),
    fps: Number(fps),
    aktif: Boolean(aktif),
    status: (isDummy || !aktif ? 'OFFLINE' : 'ONLINE') as 'ONLINE' | 'OFFLINE',
    last_error: isDummy ? 'Dummy / URL RTSP belum dikonfigurasi' : null,
    last_online_at: isDummy ? null : new Date().toISOString().replace('T', ' ').slice(0, 19),
  };
  db.cameras.push(cam);
  saveDb(db);
  triggerPythonCameraReload();
  res.json({ ok: true, camera: cam });
});

app.post('/api/cameras/probe', requireAuth(['ADMIN']), async (req, res) => {
  const db = loadDb();
  const cameraId = req.body?.camera_id ? Number(req.body.camera_id) : null;
  const cam = cameraId ? db.cameras.find((c) => c.id === cameraId) : null;
  const targetUrl = String(req.body?.rtsp_url || cam?.rtsp_url || '').trim();

  if (!targetUrl || !/^rtsps?:\/\//i.test(targetUrl)) {
    res.status(400).json({ error: 'URL harus diawali rtsp:// atau rtsps:// (bukan dummy://).' });
    return;
  }

  const ffmpegBin = resolveFfmpegBinary();
  const runCapture = (timeoutFlag: '-stimeout' | '-rw_timeout') =>
    execFileAsync(
      ffmpegBin,
      [
        '-hide_banner',
        '-loglevel', 'info',
        '-rtsp_transport', 'tcp',
        timeoutFlag, '7000000',
        '-i', targetUrl,
        '-frames:v', '1',
        '-q:v', '4',
        '-f', 'image2pipe',
        '-vcodec', 'mjpeg',
        'pipe:1',
      ],
      { timeout: 14000, encoding: 'buffer', maxBuffer: 10 * 1024 * 1024 }
    );

  const startedAt = Date.now();
  try {
    let frameRes;
    try {
      frameRes = await runCapture('-stimeout');
    } catch (firstErr) {
      const errStderr = (firstErr as { stderr?: Buffer | string })?.stderr?.toString() || '';
      if (/Option stimeout not found/i.test(errStderr)) {
        frameRes = await runCapture('-rw_timeout');
      } else {
        throw firstErr;
      }
    }

    const stderrText = frameRes.stderr ? Buffer.from(frameRes.stderr).toString('utf8') : '';
    const meta = parseFfmpegStreamOutput(stderrText);
    const jpegBuf = frameRes.stdout as unknown as Buffer;
    if (!jpegBuf || jpegBuf.length < 100) {
      throw new Error('Stream terhubung namun tidak mengirim frame gambar.');
    }

    const latencyMs = Date.now() - startedAt;
    const snapshotDataUrl = `data:image/jpeg;base64,${jpegBuf.toString('base64')}`;
    const nowStr = new Date().toISOString().replace('T', ' ').slice(0, 19);

    if (cam) {
      cam.status = 'ONLINE';
      cam.last_error = null;
      cam.last_online_at = nowStr;
      if (meta.resolusi !== '-') cam.resolusi = meta.resolusi;
      if (meta.fps > 0) cam.fps = Math.round(meta.fps);
      saveDb(db);
    }

    const faceHealth = await callFaceService<Record<string, unknown>>('/health');
    res.json({
      ok: true,
      online: true,
      camera_id: cam?.id ?? null,
      codec: meta.codec,
      width: meta.width,
      height: meta.height,
      resolusi: meta.resolusi,
      fps: meta.fps,
      latency_ms: latencyMs,
      snapshotDataUrl,
      face_service_online: Boolean(faceHealth?.ok),
    });
  } catch (err) {
    const stderrHint = (err as { stderr?: Buffer | string })?.stderr?.toString()?.trim().split('\n').slice(-2).join(' ') || '';
    const rawMsg = stderrHint || (err instanceof Error ? err.message : 'Gagal terhubung ke stream RTSP.');
    const safeMsg = maskRtspCredentials(rawMsg).slice(0, 180);
    if (cam) {
      cam.status = 'ERROR';
      cam.last_error = safeMsg;
      saveDb(db);
    }
    res.status(502).json({
      ok: false,
      online: false,
      error: `Koneksi RTSP gagal: ${safeMsg}`,
    });
  }
});

app.put('/api/cameras/:id', requireAuth(['ADMIN']), (req, res) => {
  const db = loadDb();
  const cam = db.cameras.find((c) => c.id === Number(req.params.id));
  if (!cam) {
    res.status(404).json({ error: 'Kamera tidak ditemukan.' });
    return;
  }
  Object.assign(cam, {
    nama_kamera: req.body.nama_kamera ?? cam.nama_kamera,
    rtsp_url: req.body.rtsp_url ?? cam.rtsp_url,
    resolusi: req.body.resolusi ?? cam.resolusi,
    fps: req.body.fps !== undefined ? Number(req.body.fps) : cam.fps,
    aktif: req.body.aktif !== undefined ? Boolean(req.body.aktif) : cam.aktif,
  });
  const isDummy = !cam.rtsp_url || cam.rtsp_url.startsWith('dummy://');
  cam.status = !cam.aktif || isDummy ? 'OFFLINE' : 'ONLINE';
  cam.last_error = isDummy ? 'Dummy / URL RTSP belum dikonfigurasi' : null;
  saveDb(db);
  triggerPythonCameraReload();
  res.json({ ok: true, camera: cam });
});

app.delete('/api/cameras/:id', requireAuth(['ADMIN']), (req, res) => {
  const db = loadDb();
  db.cameras = db.cameras.filter((c) => c.id !== Number(req.params.id));
  saveDb(db);
  triggerPythonCameraReload();
  res.json({ ok: true });
});

// Clusters Anonim (Guru BK)
app.post('/api/clusters/:id/assign', requireAuth(['ADMIN', 'BK']), (req, res) => {
  const db = loadDb();
  const cid = Number(req.params.id);
  const cluster = db.anonymous_clusters.find((c) => c.id === cid);
  const student = db.students.find((s) => s.id === Number(req.body.student_id));
  if (!cluster || !student) {
    res.status(404).json({ error: 'Cluster atau siswa tidak ditemukan.' });
    return;
  }
  const combinedEmb = blendFaceEmbeddings(
    student.embedding,
    cluster.best_embedding.length > 0 ? cluster.best_embedding : cluster.centroid,
    student.embedding_quality_score,
    cluster.best_quality_score
  );
  student.embedding = combinedEmb;
  student.embedding_quality_score = Math.max(student.embedding_quality_score || 0, cluster.best_quality_score);
  student.embedding_updated_at = new Date().toISOString().replace('T', ' ').slice(0, 19);
  if (!student.foto_ref || cluster.best_quality_score >= student.embedding_quality_score) {
    student.foto_ref = cluster.best_snapshot_path;
  }
  db.anonymous_clusters = db.anonymous_clusters.filter((c) => c.id !== cid);
  saveDb(db);
  triggerPythonCameraReload();
  res.json({ ok: true, student });
});

app.post('/api/clusters/:id/new-student', requireAuth(['ADMIN', 'BK']), (req, res) => {
  const db = loadDb();
  const cid = Number(req.params.id);
  const cluster = db.anonymous_clusters.find((c) => c.id === cid);
  if (!cluster) {
    res.status(404).json({ error: 'Cluster tidak ditemukan.' });
    return;
  }
  const { nis, nisn, nama, kelas_id, tanggal_lahir, wa_ortu = '' } = req.body;
  if (!nis || !nisn || !nama || !kelas_id || !tanggal_lahir) {
    res.status(400).json({ error: 'Semua kolom wajib diisi.' });
    return;
  }
  const student = {
    id: nextId(db.students),
    nis: String(nis),
    nisn: String(nisn),
    nama: String(nama),
    nickname: String(nama).split(' ')[0],
    kelas_id: Number(kelas_id),
    tanggal_lahir: String(tanggal_lahir),
    status: 'AKTIF' as const,
    embedding: cluster.best_embedding,
    embedding_quality_score: cluster.best_quality_score,
    embedding_updated_at: new Date().toISOString().replace('T', ' ').slice(0, 19),
    foto_ref: cluster.best_snapshot_path,
    wa_ortu: String(wa_ortu),
    created_at: new Date().toISOString(),
  };
  db.students.push(student);
  db.anonymous_clusters = db.anonymous_clusters.filter((c) => c.id !== cid);
  saveDb(db);
  res.json({ ok: true, student });
});

app.post('/api/clusters/:id/visitor', requireAuth(['ADMIN', 'BK']), (req, res) => {
  const db = loadDb();
  const cid = Number(req.params.id);
  const cluster = db.anonymous_clusters.find((c) => c.id === cid);
  if (!cluster) {
    res.status(404).json({ error: 'Cluster tidak ditemukan.' });
    return;
  }
  db.visitors.push({
    id: nextId(db.visitors),
    nama: String(req.body.nama || 'Tamu Sekolah'),
    kategori: req.body.kategori === 'STAF' ? 'STAF' : 'TAMU',
    snapshot_path: cluster.best_snapshot_path,
    catatan: String(req.body.catatan || ''),
    created_at: new Date().toISOString(),
  });
  db.anonymous_clusters = db.anonymous_clusters.filter((c) => c.id !== cid);
  saveDb(db);
  res.json({ ok: true });
});

// Face Update Review (BK)
app.post('/api/face-reviews/:id/approve', requireAuth(['ADMIN', 'BK']), (req, res) => {
  const db = loadDb();
  const rev = db.face_update_reviews.find((r) => r.id === Number(req.params.id));
  if (!rev) {
    res.status(404).json({ error: 'Review tidak ditemukan.' });
    return;
  }
  const hid = Number(req.body.history_id ?? rev.candidate_snapshots[0]?.history_id);
  const hist = db.face_update_history.find((h) => h.id === hid);
  const nowStr = new Date().toISOString().replace('T', ' ').slice(0, 19);

  if (hist) {
    for (const h of db.face_update_history) {
      if (h.student_id === rev.student_id) h.is_canonical = false;
    }
    hist.is_canonical = true;
    hist.approved_by = 2;
    hist.approved_at = nowStr;

    const st = db.students.find((s) => s.id === rev.student_id);
    if (st) {
      st.embedding = hist.embedding;
      st.embedding_quality_score = hist.quality_score;
      st.embedding_updated_at = nowStr;
    }
  }
  rev.status = 'APPROVED';
  rev.reviewed_by = 2;
  rev.reviewed_at = nowStr;
  saveDb(db);
  broadcastWs({ event: 'face_update_approved', student_id: rev.student_id });
  res.json({ ok: true });
});

app.post('/api/face-reviews/:id/rollback', requireAuth(['ADMIN', 'BK']), (req, res) => {
  const db = loadDb();
  const rev = db.face_update_reviews.find((r) => r.id === Number(req.params.id));
  if (!rev) {
    res.status(404).json({ error: 'Review tidak ditemukan.' });
    return;
  }
  const canonical = db.face_update_history.find((h) => h.student_id === rev.student_id && h.is_canonical);
  const nowStr = new Date().toISOString().replace('T', ' ').slice(0, 19);
  if (canonical) {
    const st = db.students.find((s) => s.id === rev.student_id);
    if (st) {
      st.embedding = canonical.embedding;
      st.embedding_quality_score = canonical.quality_score;
      st.embedding_updated_at = nowStr;
    }
  }
  rev.status = 'ROLLED_BACK';
  rev.reviewed_by = 2;
  rev.reviewed_at = nowStr;
  saveDb(db);
  res.json({ ok: true });
});

app.post('/api/face-reviews/approve-all', requireAuth(['ADMIN', 'BK']), (_req, res) => {
  const db = loadDb();
  const nowStr = new Date().toISOString().replace('T', ' ').slice(0, 19);
  for (const rev of db.face_update_reviews) {
    if (rev.status !== 'PENDING') continue;
    const hid = rev.candidate_snapshots[0]?.history_id;
    const hist = db.face_update_history.find((h) => h.id === hid);
    if (hist) {
      for (const h of db.face_update_history) {
        if (h.student_id === rev.student_id) h.is_canonical = false;
      }
      hist.is_canonical = true;
      hist.approved_by = 2;
      hist.approved_at = nowStr;
      const st = db.students.find((s) => s.id === rev.student_id);
      if (st) {
        st.embedding = hist.embedding;
        st.embedding_quality_score = hist.quality_score;
        st.embedding_updated_at = nowStr;
      }
    }
    rev.status = 'APPROVED';
    rev.reviewed_by = 2;
    rev.reviewed_at = nowStr;
  }
  saveDb(db);
  res.json({ ok: true });
});

// Schedules & Exceptions
app.post('/api/schedules', requireAuth(['ADMIN', 'BK']), (req, res) => {
  const db = loadDb();
  db.schedules.push({
    id: nextId(db.schedules),
    jurusan_id: req.body.jurusan_id ? Number(req.body.jurusan_id) : null,
    hari: Number(req.body.hari),
    jam_masuk_mulai: String(req.body.jam_masuk_mulai),
    jam_masuk_selesai: String(req.body.jam_masuk_selesai),
    jam_keluar_mulai: String(req.body.jam_keluar_mulai),
    jam_keluar_selesai: String(req.body.jam_keluar_selesai),
    toleransi_terlambat_menit: Number(req.body.toleransi_terlambat_menit ?? 5),
  });
  saveDb(db);
  res.json({ ok: true });
});

app.post('/api/schedules/override', requireAuth(['ADMIN', 'BK']), (req, res) => {
  const db = loadDb();
  db.kelas_overrides.push({
    id: nextId(db.kelas_overrides),
    kelas_id: Number(req.body.kelas_id),
    hari: Number(req.body.hari),
    jam_masuk_mulai: String(req.body.jam_masuk_mulai),
    jam_masuk_selesai: String(req.body.jam_masuk_selesai),
    jam_keluar_mulai: String(req.body.jam_keluar_mulai),
    jam_keluar_selesai: String(req.body.jam_keluar_selesai),
    alasan: String(req.body.alasan || ''),
  });
  saveDb(db);
  res.json({ ok: true });
});

app.post('/api/schedules/exception', requireAuth(['ADMIN', 'BK']), (req, res) => {
  const db = loadDb();
  db.schedule_exceptions.push({
    id: nextId(db.schedule_exceptions),
    tanggal: String(req.body.tanggal),
    scope: req.body.scope === 'JURUSAN' ? 'JURUSAN' : 'GLOBAL',
    ref_id: req.body.ref_id ? Number(req.body.ref_id) : null,
    tipe: req.body.tipe || 'LIBUR',
    catatan: String(req.body.catatan || ''),
    jam_masuk_override: req.body.jam_masuk_override || null,
    jam_keluar_override: req.body.jam_keluar_override || null,
  });
  saveDb(db);
  res.json({ ok: true });
});

// Settings, Storage Cleanup & Compact Rotating Backup
app.post('/api/settings', requireAuth(['ADMIN']), (req, res) => {
  const db = loadDb();
  db.settings = { ...db.settings, ...req.body };
  saveDb(db);
  triggerPythonCameraReload();
  res.json({ ok: true, settings: db.settings });
});

app.post('/api/storage/cleanup', requireAuth(['ADMIN']), (_req, res) => {
  const db = loadDb();
  const { freedMb } = runStorageCleanup(db);
  res.json({ ok: true, freed_mb: freedMb });
});

app.get('/api/backups', requireAuth(['ADMIN']), (_req, res) => {
  const db = loadDb();
  const backups = listBackups();
  const totalBytes = backups.reduce((acc, b) => acc + b.bytes, 0);
  res.json({
    backups,
    total_bytes: totalBytes,
    auto_backup_enabled: db.settings.auto_backup_enabled ?? true,
    backup_retention_count: db.settings.backup_retention_count ?? 2,
  });
});

app.post('/api/backups/run', requireAuth(['ADMIN']), (_req, res) => {
  const db = loadDb();
  const backup = runCompactBackup(db.settings.backup_retention_count ?? 2);
  res.json({ ok: true, backup, backups: listBackups() });
});

app.get('/api/backups/:filename/download', requireAuth(['ADMIN']), (req, res) => {
  const filePath = getBackupFilePath(String(req.params.filename || ''));
  if (!filePath) {
    res.status(404).json({ error: 'File backup tidak ditemukan.' });
    return;
  }
  res.download(filePath, path.basename(filePath));
});

app.post('/api/backups/restore', requireAuth(['ADMIN']), (req, res) => {
  const { fileBase64 } = req.body ?? {};
  if (!fileBase64 || typeof fileBase64 !== 'string') {
    res.status(400).json({ error: 'File backup (.sqlite.gz atau .sqlite) wajib diunggah.' });
    return;
  }
  try {
    const cleanB64 = fileBase64.includes(',') ? fileBase64.split(',').slice(1).join(',') : fileBase64;
    const buf = Buffer.from(cleanB64, 'base64');
    const restored = restoreFromBackupBuffer(buf);
    triggerPythonCameraReload();
    res.json({ ok: true, students: restored.students.length, users: restored.users.length });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Gagal me-restore database backup.' });
  }
});

// WhatsApp Gateway (Baileys + Meta Cloud + Fonnte + WABLAS)
app.post('/api/wa/accounts', requireAuth(['ADMIN', 'BK']), (req, res) => {
  const db = loadDb();
  const acc = {
    id: nextId(db.wa_accounts),
    provider: db.settings.wa_provider,
    phone_number: String(req.body.phone_number),
    api_key: '',
    status: 'WARMUP' as const,
    daily_count: 0,
    hourly_count: 0,
    last_reset_at: new Date().toISOString().replace('T', ' ').slice(0, 19),
    created_at: new Date().toISOString(),
    qr_connected: false,
  };
  db.wa_accounts.push(acc);
  saveDb(db);
  res.json({ ok: true, account: acc });
});

app.post('/api/wa/accounts/:id/pair', requireAuth(['ADMIN', 'BK']), async (req, res) => {
  const id = Number(req.params.id);
  const state = await startBaileysPairing(id, broadcastWs);
  res.json({ ok: true, ...state });
});

app.get('/api/wa/accounts/:id/qr', requireAuth(['ADMIN', 'BK']), (req, res) => {
  const id = Number(req.params.id);
  res.json(getPairingState(id));
});

app.post('/api/wa/accounts/:id/connect', requireAuth(['ADMIN', 'BK']), (req, res) => {
  const db = loadDb();
  const acc = db.wa_accounts.find((a) => a.id === Number(req.params.id));
  if (!acc) {
    res.status(404).json({ error: 'Akun tidak ditemukan.' });
    return;
  }
  acc.qr_connected = true;
  saveDb(db);
  res.json({ ok: true, account: acc });
});

app.post('/api/wa/test', requireAuth(['ADMIN', 'BK']), async (req, res) => {
  const db = loadDb();
  const { phone, message } = req.body;
  if (!phone || !message) {
    res.status(400).json({ error: 'Nomor tujuan dan pesan wajib diisi.' });
    return;
  }
  const activeTpls = db.wa_templates.filter((t) => t.is_active);
  const tpl = activeTpls[Math.floor(Math.random() * activeTpls.length)];
  const formatted = tpl
    ? formatWaMessage(tpl.template_text, {
        nama: 'Raka Pratama (Tes)',
        kelas: 'XI RPL 1',
        tanggal: new Date().toISOString().slice(0, 10),
        jam_masuk: '06:55:00',
        jam_keluar: '15:10:00',
        status: 'HADIR',
      })
    : String(message);

  const acc = db.wa_accounts.find((a) => a.qr_connected && a.status !== 'BANNED');
  const dispatch = await dispatchWaMessage(
    acc,
    db.settings.wa_provider,
    db.settings.wa_api_key,
    db.settings.wa_phone_number_id,
    String(phone),
    formatted
  );

  db.wa_queue.unshift({
    id: nextId(db.wa_queue),
    student_id: null,
    phone: String(phone),
    payload: { nama: 'Tes Manual', kelas: '-', tanggal: new Date().toISOString().slice(0, 10), jam_masuk: '-', jam_keluar: '-', status: 'TEST' },
    status: dispatch.sent ? 'SENT' : 'FAILED',
    retry_count: 0,
    scheduled_at: new Date().toISOString().replace('T', ' ').slice(0, 19),
    sent_at: dispatch.sent ? new Date().toISOString().replace('T', ' ').slice(0, 19) : null,
    error_msg: dispatch.error ?? null,
  });
  saveDb(db);
  res.json({
    ok: dispatch.sent,
    simulated: dispatch.simulated,
    preview: `${formatted}${dispatch.simulated ? ' (Tercatat di log · scan QR Baileys atau isi API Key untuk kirim live)' : ' (Terkirim Live)'}`,
  });
});

app.put('/api/wa/templates/:id', requireAuth(['ADMIN', 'BK']), (req, res) => {
  const db = loadDb();
  const tpl = db.wa_templates.find((t) => t.id === Number(req.params.id));
  if (!tpl) {
    res.status(404).json({ error: 'Template tidak ditemukan.' });
    return;
  }
  tpl.template_text = String(req.body.template_text ?? tpl.template_text);
  saveDb(db);
  res.json({ ok: true });
});

app.post('/api/wa/queue/:id/retry', requireAuth(['ADMIN', 'BK']), (req, res) => {
  const db = loadDb();
  const q = db.wa_queue.find((x) => x.id === Number(req.params.id));
  if (q) {
    q.status = 'PENDING';
    q.retry_count = 0;
    q.error_msg = null;
    saveDb(db);
  }
  res.json({ ok: true });
});

function runDailyScheduleAndWaTick(forceDispatchNow = false): { queued: number; markedAlpa: number; markedNoCheckout: number } {
  const db = loadDb();
  const now = new Date();
  const todayStr = now.toISOString().slice(0, 10);
  const timeNow = now.toTimeString().slice(0, 8);
  const dayIso = now.getDay() === 0 ? 7 : now.getDay();

  let queued = 0;
  let markedAlpa = 0;
  let markedNoCheckout = 0;
  let dirty = false;

  for (const s of db.students) {
    if (s.status !== 'AKTIF') continue;
    const kelas = db.kelas.find((k) => k.id === s.kelas_id);
    const sched = resolveScheduleForStudent({
      student: s,
      kelas,
      dateStr: todayStr,
      dayIso,
      schedules: db.schedules,
      kelasOverrides: db.kelas_overrides,
      exceptions: db.schedule_exceptions,
    });
    if (!sched) continue;

    let daily = db.daily_attendance.find((d) => d.student_id === s.id && d.tanggal === todayStr);
    const alpaCutoff = computeScheduledWaDispatchTime(sched.jam_masuk_selesai, 60);
    if (!daily && timeNow >= alpaCutoff) {
      daily = {
        id: nextId(db.daily_attendance),
        student_id: s.id,
        tanggal: todayStr,
        jam_masuk: null,
        jam_keluar: null,
        status: 'ALPA',
        manual_override_by: null,
        manual_override_at: null,
      };
      db.daily_attendance.push(daily);
      markedAlpa++;
      dirty = true;
    } else if (daily && (daily.status === 'HADIR' || daily.status === 'TERLAMBAT') && !daily.jam_keluar && timeNow >= db.settings.cutoff_keluar) {
      daily.status = 'TIDAK_KELUAR';
      markedNoCheckout++;
      dirty = true;
    }

    const waDelayMin = db.settings.wa_delay_after_pulang_menit ?? 60;
    const waDispatchTime = computeScheduledWaDispatchTime(sched.jam_keluar_selesai, waDelayMin);
    const shouldQueueWa =
      s.wa_ortu &&
      ((db.settings.wa_auto_dispatch_enabled && timeNow >= waDispatchTime) || forceDispatchNow);

    if (shouldQueueWa) {
      const alreadyQueued = db.wa_queue.some((q) => q.student_id === s.id && q.payload.tanggal === todayStr);
      if (!alreadyQueued) {
        db.wa_queue.unshift({
          id: nextId(db.wa_queue),
          student_id: s.id,
          phone: s.wa_ortu,
          payload: {
            nama: s.nama,
            kelas: kelas?.nama ?? '-',
            tanggal: todayStr,
            jam_masuk: daily?.jam_masuk ?? '-',
            jam_keluar: daily?.jam_keluar ?? '-',
            status: daily?.status ?? 'ALPA',
          },
          status: 'PENDING',
          retry_count: 0,
          scheduled_at: `${todayStr} ${waDispatchTime}`,
          sent_at: null,
          error_msg: null,
        });
        queued++;
        dirty = true;
      }
    }
  }

  if (dirty) {
    saveDb(db);
  }
  return { queued, markedAlpa, markedNoCheckout };
}

app.post('/api/wa/dispatch-daily-now', requireAuth(['ADMIN', 'BK']), (_req, res) => {
  const result = runDailyScheduleAndWaTick(true);
  res.json({ ok: true, ...result });
});

// Users & Notifications
app.post('/api/users', requireAuth(['ADMIN']), (req, res) => {
  const db = loadDb();
  const { name, email, role, password } = req.body;
  if (!name || !email) {
    res.status(400).json({ error: 'Nama dan email wajib diisi.' });
    return;
  }
  if (db.users.some((u) => u.email.toLowerCase() === String(email).trim().toLowerCase())) {
    res.status(409).json({ error: 'Email sudah terdaftar.' });
    return;
  }
  const pwd = password && String(password).length >= 6 ? String(password) : 'sekolah123';
  db.users.push({
    id: nextId(db.users),
    name: String(name).trim(),
    email: String(email).trim().toLowerCase(),
    role: role || 'GURU',
    is_active: true,
    password_hash: hashPassword(pwd),
  });
  saveDb(db);
  res.json({ ok: true });
});

app.post('/api/users/:id/toggle', requireAuth(['ADMIN']), (req, res) => {
  const db = loadDb();
  const u = db.users.find((x) => x.id === Number(req.params.id));
  if (u) {
    u.is_active = !u.is_active;
    saveDb(db);
  }
  res.json({ ok: true });
});

app.post('/api/notifications/read-all', requireAuth(), (_req, res) => {
  const db = loadDb();
  for (const n of db.notifications) n.is_read = true;
  saveDb(db);
  res.json({ ok: true });
});

app.post('/api/notifications/:id/read', requireAuth(), (req, res) => {
  const db = loadDb();
  const n = db.notifications.find((x) => x.id === Number(req.params.id));
  if (n) {
    n.is_read = true;
    saveDb(db);
  }
  res.json({ ok: true });
});

// Guest Mode Lookup (Rate limit 10/jam per IP + Math CAPTCHA)
app.post('/api/guest/lookup', (req, res) => {
  const db = loadDb();
  const ip = req.ip || '127.0.0.1';
  const oneHourAgo = Date.now() - 3600_000;
  const recentAttempts = db.guest_access_logs.filter(
    (g) => g.ip === ip && Date.parse(g.timestamp) >= oneHourAgo
  );
  if (recentAttempts.length >= 10) {
    res.status(429).json({ error: 'Batas 10 percobaan per jam tercapai. Silakan coba lagi nanti.' });
    return;
  }

  const { nisn, tanggal_lahir, captchaAnswer, captchaExpected, month } = req.body;
  if (Number(captchaAnswer) !== Number(captchaExpected)) {
    db.guest_access_logs.push({
      id: nextId(db.guest_access_logs),
      ip,
      timestamp: new Date().toISOString(),
      success: false,
      nisn_attempted: String(nisn || ''),
    });
    saveDb(db);
    res.status(400).json({ error: 'Jawaban CAPTCHA matematika salah.' });
    return;
  }

  const student = db.students.find((s) => s.nisn === String(nisn).trim() && s.tanggal_lahir === String(tanggal_lahir).trim());
  db.guest_access_logs.push({
    id: nextId(db.guest_access_logs),
    ip,
    timestamp: new Date().toISOString(),
    success: Boolean(student),
    nisn_attempted: String(nisn || ''),
  });
  saveDb(db);

  if (!student) {
    res.status(404).json({ error: 'Kombinasi NISN dan Tanggal Lahir tidak ditemukan.' });
    return;
  }

  const targetMonth = String(month || new Date().toISOString().slice(0, 7));
  const records = db.daily_attendance
    .filter((d) => d.student_id === student.id && d.tanggal.startsWith(targetMonth))
    .sort((a, b) => b.tanggal.localeCompare(a.tanggal));
  const kelas = db.kelas.find((k) => k.id === student.kelas_id);

  res.json({
    ok: true,
    student: { nama: student.nama, nisn: student.nisn, kelas: kelas?.nama ?? '-', status: student.status },
    month: targetMonth,
    percentage: calculateAttendancePercentage(records),
    records,
  });
});

// CSV Exports
app.get('/api/reports/csv', requireAuth(), (req, res) => {
  const db = loadDb();
  const start = String(req.query.start ?? '').trim();
  const end = String(req.query.end ?? '').trim();
  const jurusanId = String(req.query.jurusan_id ?? '').trim();
  const kelasId = String(req.query.kelas_id ?? '').trim();

  const kelasObjMap = new Map(db.kelas.map((k) => [k.id, k]));
  const lines = ['NISN,Nama,Kelas,Hadir,Terlambat,Alpa,Izin/Sakit,Persentase'];
  for (const s of db.students) {
    const kObj = kelasObjMap.get(s.kelas_id);
    if (jurusanId && String(kObj?.jurusan_id) !== jurusanId) continue;
    if (kelasId && String(s.kelas_id) !== kelasId) continue;

    const recs = db.daily_attendance.filter((d) => {
      if (d.student_id !== s.id) return false;
      if (start && d.tanggal < start) return false;
      if (end && d.tanggal > end) return false;
      return true;
    });
    const hadir = recs.filter((r) => r.status === 'HADIR' || r.status === 'TERLAMBAT' || r.status === 'TIDAK_KELUAR').length;
    const terlambat = recs.filter((r) => r.status === 'TERLAMBAT').length;
    const alpa = recs.filter((r) => r.status === 'ALPA').length;
    const iz = recs.filter((r) => r.status === 'IZIN' || r.status === 'SAKIT').length;
    const pct = calculateAttendancePercentage(recs);
    lines.push(`${s.nisn},"${s.nama.replace(/"/g, '""')}","${kObj?.nama ?? '-'}",${hadir},${terlambat},${alpa},${iz},${pct}%`);
  }
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="laporan_absensi_smk.csv"');
  res.send(lines.join('\n'));
});

app.get('/api/wa/export', requireAuth(['ADMIN', 'BK']), (_req, res) => {
  const db = loadDb();
  const lines = ['ID,Tujuan,Siswa,Status,Retry,Terkirim,Error'];
  for (const q of db.wa_queue) {
    lines.push(`${q.id},"${q.phone}","${q.payload.nama}",${q.status},${q.retry_count},"${q.sent_at ?? ''}","${q.error_msg ?? ''}"`);
  }
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="wa_queue_log.csv"');
  res.send(lines.join('\n'));
});

// ============================================================================
// VITE MIDDLEWARE / STATIC DIST & SPA FALLBACK
// ============================================================================
async function start() {
  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  // Jalankan worker antrean WA, restore sesi Baileys tersimpan, scheduler harian + pembersihan storage otomatis
  restoreSavedBaileysSessions(broadcastWs);
  startWaQueueWorker(broadcastWs);
  setInterval(() => {
    try {
      runDailyScheduleAndWaTick(false);
    } catch {
      // ignore scheduler error
    }
  }, 60_000);
  setInterval(() => {
    try {
      const db = loadDb();
      runStorageCleanup(db);
      if (db.settings.auto_backup_enabled !== false) {
        const latest = listBackups()[0];
        const ageMs = latest ? Date.now() - Date.parse(latest.created_at) : Infinity;
        if (ageMs >= 20 * 3600_000) {
          runCompactBackup(db.settings.backup_retention_count ?? 2);
        }
      }
    } catch {
      // ignore scheduled cleanup/backup error
    }
  }, 6 * 3600_000);

  const port = Number(process.env.PORT) || 3000;
  server.listen(port, '0.0.0.0', () => {
    console.log(`[Absensi SMK Server] Running on http://0.0.0.0:${port}`);
  });
}

start();
