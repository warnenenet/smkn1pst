import { APP_ROOT } from './envBootstrap.ts';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import zlib from 'zlib';
import { DatabaseSync } from 'node:sqlite';
import type {
  AnonymousCluster,
  AppDatabase,
  AttendanceLog,
  BackupEntry,
  Camera,
  DailyAttendance,
  FaceUpdateHistory,
  FaceUpdateReview,
  Gate,
  GuestAccessLog,
  Jurusan,
  Kelas,
  KelasScheduleOverride,
  NotificationItem,
  Schedule,
  ScheduleException,
  SettingsMap,
  Student,
  User,
  Visitor,
  WaAccount,
  WaQueue,
  WaTemplate,
} from '../types';
import {
  normalizeCaptureJpegQuality,
  normalizeCaptureMaxWidth,
  normalizeMinFaceSize,
  normalizeMinSnapshotQuality,
  stripDemoRecordsForProduction,
} from '../lib/attendanceEngine.ts';
import { buildFaceVectorIndex, type FaceVectorIndex } from '../lib/faceIndex.ts';

export const DATA_DIR = path.resolve(APP_ROOT, process.env.DATA_DIR || 'data');
export const SQLITE_FILE = path.join(DATA_DIR, 'absensi.sqlite');
export const LEGACY_JSON_FILE = path.join(DATA_DIR, 'absensi_db.json');
export const SNAPSHOTS_DIR = path.join(DATA_DIR, 'snapshots');
export const TTS_CACHE_DIR = path.join(DATA_DIR, 'tts_cache');
export const WA_AUTH_DIR = path.join(DATA_DIR, 'wa_auth');
export const BACKUPS_DIR = path.join(DATA_DIR, 'backups');

const BACKUP_MAX_BYTES = 150 * 1024 * 1024; // Maks total folder backup 150 MB agar tidak memenuhi limit 10 GB
const DAILY_WINDOW_DAYS = 180;

let sqliteDb: DatabaseSync | null = null;
let schemaInitialized = false;
let cachedDb: AppDatabase | null = null;
let dbVersion = 0;

const embeddingTagMap = new WeakMap<number[], number>();
let nextEmbTag = 1;
function getEmbeddingTag(vec: number[] | null | undefined): string {
  if (!Array.isArray(vec) || vec.length === 0) return '0';
  let tag = embeddingTagMap.get(vec);
  if (!tag) {
    tag = nextEmbTag++;
    embeddingTagMap.set(vec, tag);
  }
  const mid = vec[vec.length >> 1] ?? 0;
  return `${tag}:${vec.length}:${vec[0] ?? 0}:${mid}`;
}

interface PersistedStateTrackers {
  initialized: boolean;
  smallHashes: Record<string, string>;
  students: Map<number, string>;
  clusters: Map<number, string>;
  history: Map<number, string>;
  reviews: Map<number, string>;
  logs: Map<number, string>;
  daily: Map<number, string>;
  waQueue: Map<number, string>;
  notifications: Map<number, string>;
  guestLogs: Set<number>;
}

const persisted: PersistedStateTrackers = {
  initialized: false,
  smallHashes: {},
  students: new Map(),
  clusters: new Map(),
  history: new Map(),
  reviews: new Map(),
  logs: new Map(),
  daily: new Map(),
  waQueue: new Map(),
  notifications: new Map(),
  guestLogs: new Set(),
};

function resetPersistedTrackers(): void {
  persisted.initialized = false;
  persisted.smallHashes = {};
  persisted.students.clear();
  persisted.clusters.clear();
  persisted.history.clear();
  persisted.reviews.clear();
  persisted.logs.clear();
  persisted.daily.clear();
  persisted.waQueue.clear();
  persisted.notifications.clear();
  persisted.guestLogs.clear();
}

function studentSignature(s: Student): string {
  return `${s.nis}|${s.nisn}|${s.nama}|${s.nickname}|${s.kelas_id}|${s.tanggal_lahir}|${s.status}|${getEmbeddingTag(s.embedding)}|${s.embedding_quality_score}|${s.embedding_updated_at ?? ''}|${s.foto_ref ?? ''}|${s.wa_ortu ?? ''}`;
}

function clusterSignature(c: AnonymousCluster): string {
  return `${getEmbeddingTag(c.centroid)}|${c.hit_count}|${c.distinct_days}|${c.last_seen}|${c.best_snapshot_path}|${c.best_quality_score}|${getEmbeddingTag(c.best_embedding)}|${c.hit_snapshots?.length ?? 0}|${c.status}|${c.named_student_id ?? ''}|${c.last_camera_id ?? ''}`;
}

function historySignature(h: FaceUpdateHistory): string {
  return `${h.student_id}|${h.version}|${getEmbeddingTag(h.embedding)}|${h.quality_score}|${h.snapshot_path}|${h.approved_by ?? ''}|${h.approved_at ?? ''}|${h.is_canonical ? 1 : 0}`;
}

function reviewSignature(r: FaceUpdateReview): string {
  return `${r.student_id}|${r.month}|${r.year}|${r.candidate_snapshots.length}|${r.current_quality}|${r.best_new_quality}|${r.status}|${r.reviewed_by ?? ''}|${r.reviewed_at ?? ''}`;
}

function logSignature(l: AttendanceLog): string {
  return `${l.student_id}|${l.gate_id}|${l.camera_id}|${l.timestamp}|${l.tipe}|${l.status}|${l.is_manual_override ? 1 : 0}|${l.similarity_score ?? ''}|${l.snapshot_path ?? ''}`;
}

function dailySignature(d: DailyAttendance): string {
  return `${d.student_id}|${d.tanggal}|${d.jam_masuk ?? ''}|${d.jam_keluar ?? ''}|${d.status}|${d.manual_override_by ?? ''}|${d.manual_override_at ?? ''}|${d.catatan ?? ''}`;
}

function waQueueSignature(q: WaQueue): string {
  return `${q.student_id ?? ''}|${q.phone}|${q.status}|${q.retry_count}|${q.scheduled_at}|${q.sent_at ?? ''}|${q.error_msg ?? ''}`;
}

function notifSignature(n: NotificationItem): string {
  return `${n.is_read ? 1 : 0}|${n.title}|${n.message}`;
}

function seedTrackersFromDb(db: AppDatabase): void {
  resetPersistedTrackers();
  persisted.smallHashes = {
    users: JSON.stringify(db.users),
    jurusans: JSON.stringify(db.jurusans),
    kelas: JSON.stringify(db.kelas),
    gates: JSON.stringify(db.gates),
    cameras: JSON.stringify(db.cameras),
    schedules: JSON.stringify(db.schedules),
    kelas_overrides: JSON.stringify(db.kelas_overrides),
    schedule_exceptions: JSON.stringify(db.schedule_exceptions),
    visitors: JSON.stringify(db.visitors),
    wa_accounts: JSON.stringify(db.wa_accounts),
    wa_templates: JSON.stringify(db.wa_templates),
    settings: JSON.stringify(db.settings) + '|' + String(db.storage_bytes_simulated),
  };
  for (const s of db.students) persisted.students.set(s.id, studentSignature(s));
  for (const c of db.anonymous_clusters) persisted.clusters.set(c.id, clusterSignature(c));
  for (const h of db.face_update_history) persisted.history.set(h.id, historySignature(h));
  for (const r of db.face_update_reviews) persisted.reviews.set(r.id, reviewSignature(r));
  for (const l of db.attendance_logs) persisted.logs.set(l.id, logSignature(l));
  for (const d of db.daily_attendance) persisted.daily.set(d.id, dailySignature(d));
  for (const q of db.wa_queue) persisted.waQueue.set(q.id, waQueueSignature(q));
  for (const n of db.notifications) persisted.notifications.set(n.id, notifSignature(n));
  for (const g of db.guest_access_logs) persisted.guestLogs.add(g.id);
  persisted.initialized = true;
}

let cachedStudentIndex: { fingerprint: string; index: FaceVectorIndex } | null = null;
let cachedClusterIndex: { fingerprint: string; index: FaceVectorIndex } | null = null;

export function getCachedStudentFaceIndex(students: readonly Student[]): FaceVectorIndex {
  let activeCount = 0;
  let tagSum = 0;
  let fpParts = '';
  for (let i = 0; i < students.length; i++) {
    const s = students[i];
    if (s.status === 'LULUS' || !Array.isArray(s.embedding) || s.embedding.length === 0) continue;
    activeCount++;
    let t = embeddingTagMap.get(s.embedding);
    if (!t) {
      t = nextEmbTag++;
      embeddingTagMap.set(s.embedding, t);
    }
    tagSum = (tagSum + t * (s.id + 1)) | 0;
  }
  fpParts = `${activeCount}:${tagSum}:${dbVersion}`;
  if (cachedStudentIndex && cachedStudentIndex.fingerprint === fpParts) {
    return cachedStudentIndex.index;
  }
  const entries = students
    .filter((s) => s.status !== 'LULUS' && Array.isArray(s.embedding) && s.embedding.length > 0)
    .map((s) => ({ id: s.id, embedding: s.embedding }));
  const index = buildFaceVectorIndex(entries, dbVersion + 1);
  cachedStudentIndex = { fingerprint: fpParts, index };
  return index;
}

export function getCachedClusterFaceIndex(clusters: readonly AnonymousCluster[]): FaceVectorIndex {
  let activeCount = 0;
  let tagSum = 0;
  for (let i = 0; i < clusters.length; i++) {
    const c = clusters[i];
    if ((c.status !== 'PENDING' && c.status !== 'READY') || !Array.isArray(c.centroid) || c.centroid.length === 0) continue;
    activeCount++;
    let t = embeddingTagMap.get(c.centroid);
    if (!t) {
      t = nextEmbTag++;
      embeddingTagMap.set(c.centroid, t);
    }
    tagSum = (tagSum + t * (c.id + 1)) | 0;
  }
  const fp = `${activeCount}:${tagSum}:${dbVersion}`;
  if (cachedClusterIndex && cachedClusterIndex.fingerprint === fp) {
    return cachedClusterIndex.index;
  }
  const entries = clusters
    .filter((c) => (c.status === 'PENDING' || c.status === 'READY') && Array.isArray(c.centroid) && c.centroid.length > 0)
    .map((c) => ({ id: c.id, embedding: c.centroid }));
  const index = buildFaceVectorIndex(entries, dbVersion + 1);
  cachedClusterIndex = { fingerprint: fp, index };
  return index;
}

export function invalidateDbCache(): void {
  cachedDb = null;
  cachedStudentIndex = null;
  cachedClusterIndex = null;
  resetPersistedTrackers();
}

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, 32).toString('hex');
  return `${salt}:${derived}`;
}

export function verifyPassword(password: string, storedHash: string | undefined): boolean {
  if (!storedHash || !storedHash.includes(':')) return false;
  const [salt, hex] = storedHash.split(':');
  const derived = crypto.scryptSync(password, salt, 32);
  const expected = Buffer.from(hex, 'hex');
  if (derived.length !== expected.length) return false;
  return crypto.timingSafeEqual(derived, expected);
}

function encodeEmbeddingBlob(vec: number[] | null | undefined): Uint8Array | null {
  if (!Array.isArray(vec) || vec.length === 0) return null;
  const f32 = new Float32Array(vec.length);
  for (let i = 0; i < vec.length; i++) {
    f32[i] = Number(vec[i]) || 0;
  }
  return new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength);
}

function decodeEmbeddingBlob(raw: unknown): number[] | null {
  if (!raw || !(raw instanceof Uint8Array) || raw.byteLength < 4 || raw.byteLength % 4 !== 0) {
    return null;
  }
  const buf = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
  const count = buf.byteLength / 4;
  const out = new Array<number>(count);
  for (let i = 0; i < count; i++) {
    out[i] = Math.round(buf.readFloatLE(i * 4) * 100000) / 100000;
  }
  return out;
}

function getSqlite(): DatabaseSync {
  if (!sqliteDb) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.mkdirSync(SNAPSHOTS_DIR, { recursive: true });
    fs.mkdirSync(TTS_CACHE_DIR, { recursive: true });
    fs.mkdirSync(WA_AUTH_DIR, { recursive: true });
    fs.mkdirSync(BACKUPS_DIR, { recursive: true });

    sqliteDb = new DatabaseSync(SQLITE_FILE);
  }
  if (!schemaInitialized) {
    sqliteDb.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA foreign_keys = OFF;

      CREATE TABLE IF NOT EXISTS app_state (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS storage_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        category TEXT NOT NULL,
        bytes INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS auth_sessions (
        token TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT NOT NULL UNIQUE,
        role TEXT NOT NULL,
        is_active INTEGER NOT NULL,
        password_hash TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS jurusans (
        id INTEGER PRIMARY KEY,
        kode TEXT NOT NULL UNIQUE,
        nama TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS kelas (
        id INTEGER PRIMARY KEY,
        jurusan_id INTEGER NOT NULL,
        tingkat TEXT NOT NULL,
        nama TEXT NOT NULL,
        shift TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_kelas_jurusan ON kelas(jurusan_id);

      CREATE TABLE IF NOT EXISTS students (
        id INTEGER PRIMARY KEY,
        nis TEXT NOT NULL,
        nisn TEXT NOT NULL,
        nama TEXT NOT NULL,
        nickname TEXT NOT NULL,
        kelas_id INTEGER NOT NULL,
        tanggal_lahir TEXT NOT NULL,
        status TEXT NOT NULL,
        embedding BLOB,
        embedding_quality_score REAL NOT NULL DEFAULT 0,
        embedding_updated_at TEXT,
        foto_ref TEXT,
        wa_ortu TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_students_nisn ON students(nisn);
      CREATE INDEX IF NOT EXISTS idx_students_nis ON students(nis);
      CREATE INDEX IF NOT EXISTS idx_students_kelas ON students(kelas_id);
      CREATE INDEX IF NOT EXISTS idx_students_status ON students(status);

      CREATE TABLE IF NOT EXISTS gates (
        id INTEGER PRIMARY KEY,
        nama_gerbang TEXT NOT NULL,
        lokasi TEXT NOT NULL,
        tipe TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS cameras (
        id INTEGER PRIMARY KEY,
        nama_kamera TEXT NOT NULL,
        gate_id INTEGER NOT NULL,
        rtsp_url TEXT NOT NULL,
        resolusi TEXT NOT NULL,
        fps INTEGER NOT NULL,
        aktif INTEGER NOT NULL,
        status TEXT NOT NULL,
        last_error TEXT,
        last_online_at TEXT,
        min_face_size INTEGER,
        capture_max_width INTEGER
      );
      CREATE TABLE IF NOT EXISTS schedules (
        id INTEGER PRIMARY KEY,
        jurusan_id INTEGER,
        hari INTEGER NOT NULL,
        jam_masuk_mulai TEXT NOT NULL,
        jam_masuk_selesai TEXT NOT NULL,
        jam_keluar_mulai TEXT NOT NULL,
        jam_keluar_selesai TEXT NOT NULL,
        toleransi_terlambat_menit INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS kelas_overrides (
        id INTEGER PRIMARY KEY,
        kelas_id INTEGER NOT NULL,
        hari INTEGER NOT NULL,
        jam_masuk_mulai TEXT NOT NULL,
        jam_masuk_selesai TEXT NOT NULL,
        jam_keluar_mulai TEXT NOT NULL,
        jam_keluar_selesai TEXT NOT NULL,
        alasan TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS schedule_exceptions (
        id INTEGER PRIMARY KEY,
        tanggal TEXT NOT NULL,
        scope TEXT NOT NULL,
        ref_id INTEGER,
        tipe TEXT NOT NULL,
        catatan TEXT NOT NULL,
        jam_masuk_override TEXT,
        jam_keluar_override TEXT
      );

      CREATE TABLE IF NOT EXISTS attendance_logs (
        id INTEGER PRIMARY KEY,
        student_id INTEGER NOT NULL,
        gate_id INTEGER NOT NULL,
        camera_id INTEGER NOT NULL,
        timestamp TEXT NOT NULL,
        tipe TEXT NOT NULL,
        status TEXT NOT NULL,
        is_manual_override INTEGER NOT NULL DEFAULT 0,
        similarity_score REAL,
        snapshot_path TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_att_logs_student_tipe ON attendance_logs(student_id, tipe, timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_att_logs_ts ON attendance_logs(timestamp DESC);

      CREATE TABLE IF NOT EXISTS daily_attendance (
        id INTEGER PRIMARY KEY,
        student_id INTEGER NOT NULL,
        tanggal TEXT NOT NULL,
        jam_masuk TEXT,
        jam_keluar TEXT,
        status TEXT NOT NULL,
        manual_override_by INTEGER,
        manual_override_at TEXT,
        catatan TEXT,
        UNIQUE(student_id, tanggal)
      );
      CREATE INDEX IF NOT EXISTS idx_daily_att_tanggal ON daily_attendance(tanggal, status);

      CREATE TABLE IF NOT EXISTS anonymous_clusters (
        id INTEGER PRIMARY KEY,
        centroid BLOB,
        hit_count INTEGER NOT NULL,
        distinct_days INTEGER NOT NULL,
        first_seen TEXT NOT NULL,
        last_seen TEXT NOT NULL,
        best_snapshot_path TEXT NOT NULL,
        best_quality_score REAL NOT NULL,
        best_embedding BLOB,
        hit_snapshots_json TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL,
        named_student_id INTEGER,
        last_camera_id INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_clusters_status ON anonymous_clusters(status, last_seen);

      CREATE TABLE IF NOT EXISTS visitors (
        id INTEGER PRIMARY KEY,
        nama TEXT NOT NULL,
        kategori TEXT NOT NULL,
        snapshot_path TEXT NOT NULL,
        catatan TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS face_update_history (
        id INTEGER PRIMARY KEY,
        student_id INTEGER NOT NULL,
        version INTEGER NOT NULL,
        embedding BLOB,
        quality_score REAL NOT NULL,
        snapshot_path TEXT NOT NULL,
        created_at TEXT NOT NULL,
        approved_by INTEGER,
        approved_at TEXT,
        is_canonical INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_face_hist_student ON face_update_history(student_id, version DESC);

      CREATE TABLE IF NOT EXISTS face_update_reviews (
        id INTEGER PRIMARY KEY,
        student_id INTEGER NOT NULL,
        month INTEGER NOT NULL,
        year INTEGER NOT NULL,
        candidate_snapshots_json TEXT NOT NULL,
        current_quality REAL NOT NULL,
        best_new_quality REAL NOT NULL,
        status TEXT NOT NULL,
        reviewed_by INTEGER,
        reviewed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_face_rev_status ON face_update_reviews(status, student_id);

      CREATE TABLE IF NOT EXISTS wa_queue (
        id INTEGER PRIMARY KEY,
        student_id INTEGER,
        phone TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL,
        retry_count INTEGER NOT NULL DEFAULT 0,
        scheduled_at TEXT NOT NULL,
        sent_at TEXT,
        error_msg TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_wa_queue_status ON wa_queue(status, scheduled_at);

      CREATE TABLE IF NOT EXISTS wa_accounts (
        id INTEGER PRIMARY KEY,
        provider TEXT NOT NULL,
        phone_number TEXT NOT NULL,
        api_key TEXT NOT NULL,
        status TEXT NOT NULL,
        daily_count INTEGER NOT NULL,
        hourly_count INTEGER NOT NULL,
        last_reset_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        qr_connected INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS wa_templates (
        id INTEGER PRIMARY KEY,
        code TEXT NOT NULL,
        name TEXT NOT NULL,
        template_text TEXT NOT NULL,
        is_active INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE IF NOT EXISTS notifications (
        id INTEGER PRIMARY KEY,
        user_id INTEGER,
        role_target TEXT NOT NULL,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        message TEXT NOT NULL,
        is_read INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS guest_access_logs (
        id INTEGER PRIMARY KEY,
        ip TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        success INTEGER NOT NULL,
        nisn_attempted TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_guest_logs_ip ON guest_access_logs(ip, timestamp DESC);

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL
      );
    `);
    const ensureColumn = (table: string, column: string, ddl: string) => {
      const cols = sqliteDb!.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
      if (!cols.some((c) => c.name === column)) {
        sqliteDb!.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
      }
    };
    ensureColumn('attendance_logs', 'snapshot_path', 'TEXT');
    ensureColumn('anonymous_clusters', 'hit_snapshots_json', "TEXT NOT NULL DEFAULT '[]'");
    ensureColumn('cameras', 'min_face_size', 'INTEGER');
    ensureColumn('cameras', 'capture_max_width', 'INTEGER');
    schemaInitialized = true;
  }
  return sqliteDb;
}

export function createAuthSession(userId: number): { token: string; expiresAt: number } {
  const sqlite = getSqlite();
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = Date.now() + 24 * 3600_000;
  sqlite
    .prepare('INSERT INTO auth_sessions (token, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
    .run(token, userId, expiresAt, new Date().toISOString());
  return { token, expiresAt };
}

export function getSessionUserId(token: string | undefined | null): number | null {
  if (!token) return null;
  const sqlite = getSqlite();
  const row = sqlite
    .prepare('SELECT user_id, expires_at FROM auth_sessions WHERE token = ?')
    .get(token) as { user_id: number; expires_at: number } | undefined;
  if (!row) return null;
  if (row.expires_at < Date.now()) {
    sqlite.prepare('DELETE FROM auth_sessions WHERE token = ?').run(token);
    return null;
  }
  return row.user_id;
}

export function deleteAuthSession(token: string | undefined | null): void {
  if (!token) return;
  const sqlite = getSqlite();
  sqlite.prepare('DELETE FROM auth_sessions WHERE token = ?').run(token);
}

export function sanitizeUser(user: User): User {
  const { password_hash: _ignored, ...rest } = user;
  return rest;
}

export function getDirectorySizeBytes(dirPath: string): number {
  if (!fs.existsSync(dirPath)) return 0;
  let total = 0;
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        total += getDirectorySizeBytes(full);
      } else if (entry.isFile()) {
        total += fs.statSync(full).size;
      }
    }
  } catch {
    // ignore permission or transient errors
  }
  return total;
}

export function createInitialSeed(): AppDatabase {
  return {
    users: [
      { id: 1, name: 'Administrator Sekolah', email: 'admin@sekolah.local', role: 'ADMIN', is_active: true, password_hash: hashPassword('admin123') },
      { id: 2, name: 'Ibu Sari Wulandari, S.Pd', email: 'bk@sekolah.local', role: 'BK', is_active: true, password_hash: hashPassword('bk123') },
      { id: 3, name: 'Pak Budi Santoso', email: 'guru@sekolah.local', role: 'GURU', is_active: true, password_hash: hashPassword('guru123') },
    ],
    jurusans: [
      { id: 1, kode: 'TKJ', nama: 'Teknik Komputer & Jaringan' },
      { id: 2, kode: 'RPL', nama: 'Rekayasa Perangkat Lunak' },
      { id: 3, kode: 'MM', nama: 'Multimedia & DKV' },
    ],
    kelas: [
      { id: 1, jurusan_id: 1, tingkat: 'X', nama: 'X TKJ 1', shift: 'PAGI' },
      { id: 2, jurusan_id: 2, tingkat: 'XI', nama: 'XI RPL 1', shift: 'PAGI' },
      { id: 3, jurusan_id: 2, tingkat: 'XI', nama: 'XI RPL 2', shift: 'SIANG' },
      { id: 4, jurusan_id: 3, tingkat: 'XII', nama: 'XII MM 1', shift: 'PAGI' },
    ],
    students: [],
    gates: [
      { id: 1, nama_gerbang: 'Gerbang Utama', lokasi: 'Pos Satpam Depan', tipe: 'BOTH' },
      { id: 2, nama_gerbang: 'Gerbang Bengkel Utara', lokasi: 'Gedung Praktik TKJ/RPL', tipe: 'MASUK' },
    ],
    cameras: [],
    schedules: [
      ...[1, 2, 3, 4, 5, 6].map((hari) => ({
        id: hari,
        jurusan_id: null,
        hari,
        jam_masuk_mulai: '06:00:00',
        jam_masuk_selesai: '07:15:00',
        jam_keluar_mulai: hari === 6 ? '12:00:00' : '15:00:00',
        jam_keluar_selesai: hari === 6 ? '14:00:00' : '17:00:00',
        toleransi_terlambat_menit: 5,
      })),
    ],
    kelas_overrides: [],
    schedule_exceptions: [],
    attendance_logs: [],
    daily_attendance: [],
    anonymous_clusters: [],
    visitors: [],
    face_update_history: [],
    face_update_reviews: [],
    wa_queue: [],
    wa_accounts: [],
    wa_templates: [
      { id: 1, code: 'TPL_1', name: 'Variasi 1 - Formal', template_text: 'Yth. Bapak/Ibu Wali Murid dari {nama} ({kelas}), absensi tanggal {tanggal}: Masuk {jam_masuk}, Keluar {jam_keluar}, Status: *{status}*.', is_active: true },
      { id: 2, code: 'TPL_2', name: 'Variasi 2 - Sore', template_text: 'Selamat sore Bapak/Ibu, laporan kehadiran {nama} ({kelas}) tgl {tanggal}. Masuk: {jam_masuk} | Pulang: {jam_keluar} | Status: *{status}*.', is_active: true },
      { id: 3, code: 'TPL_3', name: 'Variasi 3 - Ringkas', template_text: 'Info Absensi SMK: Ananda {nama} ({kelas}) tercatat pada {tanggal} dengan status *{status}* (Masuk: {jam_masuk}, Keluar: {jam_keluar}).', is_active: true },
      { id: 4, code: 'TPL_4', name: 'Variasi 4 - Ramah', template_text: 'Halo Bapak/Ibu Orang Tua {nama}, rekap kehadiran hari ini ({tanggal}) kelas {kelas}: Masuk {jam_masuk}, Pulang {jam_keluar}, Status: *{status}*.', is_active: true },
      { id: 5, code: 'TPL_5', name: 'Variasi 5 - Harian', template_text: 'Laporan Harian Sekolah ({tanggal}): Nama {nama}, Kelas {kelas}, Datang {jam_masuk}, Pulang {jam_keluar}. Status: *{status}*.', is_active: true },
      { id: 6, code: 'TPL_6', name: 'Variasi 6 - Notifikasi', template_text: 'Pemberitahuan Kehadiran Siswa: {nama} ({kelas}) tanggal {tanggal}. Datang: {jam_masuk}, Pulang: {jam_keluar}. Status akhir: *{status}*.', is_active: true },
      { id: 7, code: 'TPL_7', name: 'Variasi 7 - Salam', template_text: 'Salam sejahtera Wali Murid {nama} ({kelas}). Catatan absensi {tanggal}: Masuk {jam_masuk}, Keluar {jam_keluar}, Status *{status}*.', is_active: true },
      { id: 8, code: 'TPL_8', name: 'Variasi 8 - Gerbang', template_text: 'Catatan Gerbang Sekolah ({tanggal}): {nama} - {kelas}. Masuk: {jam_masuk}, Keluar: {jam_keluar}. Keterangan: *{status}*.', is_active: true },
      { id: 9, code: 'TPL_9', name: 'Variasi 9 - Rekap', template_text: 'Rekapitulasi Kehadiran Ananda {nama} kelas {kelas} tgl {tanggal}: Masuk {jam_masuk}, Keluar {jam_keluar}, Status: *{status}*.', is_active: true },
      { id: 10, code: 'TPL_10', name: 'Variasi 10 - Resmi', template_text: 'Informasi Orang Tua: Pada {tanggal}, siswa a.n. {nama} ({kelas}) berstatus *{status}* (Masuk: {jam_masuk}, Pulang: {jam_keluar}).', is_active: true },
    ],
    notifications: [],
    guest_access_logs: [],
    settings: {
      school_name: 'SMK Negeri Unggulan',
      threshold_confidence: 0.80,
      threshold_recognition: 0.70,
      threshold_clustering: 0.70,
      min_face_size: 60,
      min_snapshot_quality: 0.70,
      capture_max_width: 1280,
      capture_jpeg_quality: 86,
      cluster_ready_hits: 5,
      cluster_ready_days: 1,
      cluster_sighting_interval_min: 30,
      cluster_archive_days: 90,
      cluster_delete_days: 180,
      weight_confidence: 0.30,
      weight_size: 0.25,
      weight_sharpness: 0.25,
      weight_frontal: 0.20,
      cutoff_keluar: '18:00:00',
      wa_provider: 'BAILEYS',
      wa_api_key: '',
      wa_phone_number_id: '',
      wa_delay_after_pulang_menit: 60,
      wa_auto_dispatch_enabled: true,
      tts_mode: 'AUTO_ADAPTIVE',
      tts_max_age_sec: 3,
      tts_burst_threshold: 3,
      face_maintenance_target: 0.80,
      auto_backup_enabled: true,
      backup_retention_count: 2,
      production_mode: true,
    },
    storage_bytes_simulated: 12 * 1024 * 1024,
  };
}

function hydrateDefaults(parsed: AppDatabase): AppDatabase {
  const defaults = createInitialSeed().settings;
  if (!parsed.settings) {
    parsed.settings = { ...defaults };
  } else {
    parsed.settings = { ...defaults, ...parsed.settings };
  }
  parsed.settings.min_snapshot_quality = normalizeMinSnapshotQuality(parsed.settings.min_snapshot_quality);
  parsed.settings.min_face_size = normalizeMinFaceSize(parsed.settings.min_face_size);
  parsed.settings.capture_max_width = normalizeCaptureMaxWidth(parsed.settings.capture_max_width);
  parsed.settings.capture_jpeg_quality = normalizeCaptureJpegQuality(parsed.settings.capture_jpeg_quality);
  for (const u of parsed.users) {
    if (!u.password_hash) {
      const fallbackPwd = u.role === 'ADMIN' ? 'admin123' : u.role === 'BK' ? 'bk123' : 'guru123';
      u.password_hash = hashPassword(fallbackPwd);
    }
  }
  return parsed;
}

function dailyWindowCutoffDate(): string {
  return new Date(Date.now() - DAILY_WINDOW_DAYS * 86_400_000).toISOString().slice(0, 10);
}

function readRelationalDb(sqlite: DatabaseSync): AppDatabase {
  const users = (sqlite.prepare('SELECT id, name, email, role, is_active, password_hash FROM users ORDER BY id').all() as Array<Record<string, unknown>>).map((r) => ({
    id: Number(r.id),
    name: String(r.name),
    email: String(r.email),
    role: r.role as User['role'],
    is_active: Boolean(r.is_active),
    password_hash: String(r.password_hash),
  }));

  const jurusans = (sqlite.prepare('SELECT id, kode, nama FROM jurusans ORDER BY id').all() as Array<Record<string, unknown>>).map((r) => ({
    id: Number(r.id),
    kode: String(r.kode),
    nama: String(r.nama),
  })) as Jurusan[];

  const kelas = (sqlite.prepare('SELECT id, jurusan_id, tingkat, nama, shift FROM kelas ORDER BY id').all() as Array<Record<string, unknown>>).map((r) => ({
    id: Number(r.id),
    jurusan_id: Number(r.jurusan_id),
    tingkat: String(r.tingkat),
    nama: String(r.nama),
    shift: r.shift as Kelas['shift'],
  }));

  const students = (sqlite.prepare('SELECT * FROM students ORDER BY id').all() as Array<Record<string, unknown>>).map((r) => ({
    id: Number(r.id),
    nis: String(r.nis),
    nisn: String(r.nisn),
    nama: String(r.nama),
    nickname: String(r.nickname),
    kelas_id: Number(r.kelas_id),
    tanggal_lahir: String(r.tanggal_lahir),
    status: r.status as Student['status'],
    embedding: decodeEmbeddingBlob(r.embedding),
    embedding_quality_score: Number(r.embedding_quality_score ?? 0),
    embedding_updated_at: r.embedding_updated_at ? String(r.embedding_updated_at) : null,
    foto_ref: r.foto_ref ? String(r.foto_ref) : null,
    wa_ortu: String(r.wa_ortu ?? ''),
    created_at: String(r.created_at),
  }));

  const gates = (sqlite.prepare('SELECT * FROM gates ORDER BY id').all() as Array<Record<string, unknown>>).map((r) => ({
    id: Number(r.id),
    nama_gerbang: String(r.nama_gerbang),
    lokasi: String(r.lokasi),
    tipe: r.tipe as Gate['tipe'],
  }));

  const cameras = (sqlite.prepare('SELECT * FROM cameras ORDER BY id').all() as Array<Record<string, unknown>>).map((r) => ({
    id: Number(r.id),
    nama_kamera: String(r.nama_kamera),
    gate_id: Number(r.gate_id),
    rtsp_url: String(r.rtsp_url),
    resolusi: String(r.resolusi),
    fps: Number(r.fps),
    aktif: Boolean(r.aktif),
    status: r.status as Camera['status'],
    last_error: r.last_error ? String(r.last_error) : null,
    last_online_at: r.last_online_at ? String(r.last_online_at) : null,
    min_face_size: r.min_face_size !== null && r.min_face_size !== undefined ? Number(r.min_face_size) : null,
    capture_max_width: r.capture_max_width !== null && r.capture_max_width !== undefined ? Number(r.capture_max_width) : null,
  }));

  const schedules = (sqlite.prepare('SELECT * FROM schedules ORDER BY id').all() as Array<Record<string, unknown>>).map((r) => ({
    id: Number(r.id),
    jurusan_id: r.jurusan_id !== null && r.jurusan_id !== undefined ? Number(r.jurusan_id) : null,
    hari: Number(r.hari),
    jam_masuk_mulai: String(r.jam_masuk_mulai),
    jam_masuk_selesai: String(r.jam_masuk_selesai),
    jam_keluar_mulai: String(r.jam_keluar_mulai),
    jam_keluar_selesai: String(r.jam_keluar_selesai),
    toleransi_terlambat_menit: Number(r.toleransi_terlambat_menit),
  })) as Schedule[];

  const kelas_overrides = (sqlite.prepare('SELECT * FROM kelas_overrides ORDER BY id').all() as Array<Record<string, unknown>>).map((r) => ({
    id: Number(r.id),
    kelas_id: Number(r.kelas_id),
    hari: Number(r.hari),
    jam_masuk_mulai: String(r.jam_masuk_mulai),
    jam_masuk_selesai: String(r.jam_masuk_selesai),
    jam_keluar_mulai: String(r.jam_keluar_mulai),
    jam_keluar_selesai: String(r.jam_keluar_selesai),
    alasan: String(r.alasan),
  })) as KelasScheduleOverride[];

  const schedule_exceptions = (sqlite.prepare('SELECT * FROM schedule_exceptions ORDER BY id').all() as Array<Record<string, unknown>>).map((r) => ({
    id: Number(r.id),
    tanggal: String(r.tanggal),
    scope: r.scope as ScheduleException['scope'],
    ref_id: r.ref_id !== null && r.ref_id !== undefined ? Number(r.ref_id) : null,
    tipe: r.tipe as ScheduleException['tipe'],
    catatan: String(r.catatan),
    jam_masuk_override: r.jam_masuk_override ? String(r.jam_masuk_override) : null,
    jam_keluar_override: r.jam_keluar_override ? String(r.jam_keluar_override) : null,
  }));

  const attendance_logs = (sqlite.prepare('SELECT * FROM attendance_logs ORDER BY timestamp DESC, id DESC LIMIT 3000').all() as Array<Record<string, unknown>>).map((r) => ({
    id: Number(r.id),
    student_id: Number(r.student_id),
    gate_id: Number(r.gate_id),
    camera_id: Number(r.camera_id),
    timestamp: String(r.timestamp),
    tipe: r.tipe as AttendanceLog['tipe'],
    status: r.status as AttendanceLog['status'],
    is_manual_override: Boolean(r.is_manual_override),
    similarity_score: r.similarity_score !== null && r.similarity_score !== undefined ? Number(r.similarity_score) : undefined,
    snapshot_path: r.snapshot_path ? String(r.snapshot_path) : null,
  }));

  const cutoffDaily = dailyWindowCutoffDate();
  const daily_attendance = (
    sqlite
      .prepare('SELECT * FROM daily_attendance WHERE tanggal >= ? ORDER BY tanggal DESC, id DESC')
      .all(cutoffDaily) as Array<Record<string, unknown>>
  ).map((r) => ({
    id: Number(r.id),
    student_id: Number(r.student_id),
    tanggal: String(r.tanggal),
    jam_masuk: r.jam_masuk ? String(r.jam_masuk) : null,
    jam_keluar: r.jam_keluar ? String(r.jam_keluar) : null,
    status: r.status as DailyAttendance['status'],
    manual_override_by: r.manual_override_by !== null && r.manual_override_by !== undefined ? Number(r.manual_override_by) : null,
    manual_override_at: r.manual_override_at ? String(r.manual_override_at) : null,
    catatan: r.catatan ? String(r.catatan) : null,
  }));

  const anonymous_clusters = (sqlite.prepare('SELECT * FROM anonymous_clusters ORDER BY last_seen DESC, id DESC').all() as Array<Record<string, unknown>>).map((r) => {
    const bestSnap = String(r.best_snapshot_path);
    const bestQ = Number(r.best_quality_score);
    const lastCam = r.last_camera_id !== null && r.last_camera_id !== undefined ? Number(r.last_camera_id) : null;
    const lastSeen = String(r.last_seen);
    let hitSnaps: AnonymousCluster['hit_snapshots'] = [];
    try {
      const parsed = JSON.parse(String(r.hit_snapshots_json || '[]'));
      if (Array.isArray(parsed)) hitSnaps = parsed;
    } catch {
      hitSnaps = [];
    }
    if (hitSnaps.length === 0 && bestSnap) {
      hitSnaps = [
        {
          snapshot_path: bestSnap,
          quality_score: bestQ,
          similarity: 1,
          camera_id: lastCam,
          detected_at: lastSeen,
        },
      ];
    }
    return {
      id: Number(r.id),
      centroid: decodeEmbeddingBlob(r.centroid) ?? [],
      hit_count: Number(r.hit_count),
      distinct_days: Number(r.distinct_days),
      first_seen: String(r.first_seen),
      last_seen: lastSeen,
      best_snapshot_path: bestSnap,
      best_quality_score: bestQ,
      best_embedding: decodeEmbeddingBlob(r.best_embedding) ?? [],
      hit_snapshots: hitSnaps,
      status: r.status as AnonymousCluster['status'],
      named_student_id: r.named_student_id !== null && r.named_student_id !== undefined ? Number(r.named_student_id) : null,
      last_camera_id: lastCam,
    };
  });

  const visitors = (sqlite.prepare('SELECT * FROM visitors ORDER BY id DESC').all() as Array<Record<string, unknown>>).map((r) => ({
    id: Number(r.id),
    nama: String(r.nama),
    kategori: r.kategori as Visitor['kategori'],
    snapshot_path: String(r.snapshot_path),
    catatan: String(r.catatan),
    created_at: String(r.created_at),
  }));

  const face_update_history = (sqlite.prepare('SELECT * FROM face_update_history ORDER BY id').all() as Array<Record<string, unknown>>).map((r) => ({
    id: Number(r.id),
    student_id: Number(r.student_id),
    version: Number(r.version),
    embedding: decodeEmbeddingBlob(r.embedding) ?? [],
    quality_score: Number(r.quality_score),
    snapshot_path: String(r.snapshot_path),
    created_at: String(r.created_at),
    approved_by: r.approved_by !== null && r.approved_by !== undefined ? Number(r.approved_by) : null,
    approved_at: r.approved_at ? String(r.approved_at) : null,
    is_canonical: Boolean(r.is_canonical),
  })) as FaceUpdateHistory[];

  const face_update_reviews = (sqlite.prepare('SELECT * FROM face_update_reviews ORDER BY id DESC').all() as Array<Record<string, unknown>>).map((r) => ({
    id: Number(r.id),
    student_id: Number(r.student_id),
    month: Number(r.month),
    year: Number(r.year),
    candidate_snapshots: JSON.parse(String(r.candidate_snapshots_json || '[]')),
    current_quality: Number(r.current_quality),
    best_new_quality: Number(r.best_new_quality),
    status: r.status as FaceUpdateReview['status'],
    reviewed_by: r.reviewed_by !== null && r.reviewed_by !== undefined ? Number(r.reviewed_by) : null,
    reviewed_at: r.reviewed_at ? String(r.reviewed_at) : null,
  }));

  const wa_queue = (sqlite.prepare('SELECT * FROM wa_queue ORDER BY id DESC LIMIT 2000').all() as Array<Record<string, unknown>>).map((r) => ({
    id: Number(r.id),
    student_id: r.student_id !== null && r.student_id !== undefined ? Number(r.student_id) : null,
    phone: String(r.phone),
    payload: JSON.parse(String(r.payload_json || '{}')),
    status: r.status as WaQueue['status'],
    retry_count: Number(r.retry_count),
    scheduled_at: String(r.scheduled_at),
    sent_at: r.sent_at ? String(r.sent_at) : null,
    error_msg: r.error_msg ? String(r.error_msg) : null,
  }));

  const wa_accounts = (sqlite.prepare('SELECT * FROM wa_accounts ORDER BY id').all() as Array<Record<string, unknown>>).map((r) => ({
    id: Number(r.id),
    provider: r.provider as WaAccount['provider'],
    phone_number: String(r.phone_number),
    api_key: String(r.api_key),
    status: r.status as WaAccount['status'],
    daily_count: Number(r.daily_count),
    hourly_count: Number(r.hourly_count),
    last_reset_at: String(r.last_reset_at),
    created_at: String(r.created_at),
    qr_connected: Boolean(r.qr_connected),
  }));

  const wa_templates = (sqlite.prepare('SELECT * FROM wa_templates ORDER BY id').all() as Array<Record<string, unknown>>).map((r) => ({
    id: Number(r.id),
    code: String(r.code),
    name: String(r.name),
    template_text: String(r.template_text),
    is_active: Boolean(r.is_active),
  })) as WaTemplate[];

  const notifications = (sqlite.prepare('SELECT * FROM notifications ORDER BY id DESC LIMIT 500').all() as Array<Record<string, unknown>>).map((r) => ({
    id: Number(r.id),
    user_id: r.user_id !== null && r.user_id !== undefined ? Number(r.user_id) : null,
    role_target: r.role_target as NotificationItem['role_target'],
    type: String(r.type),
    title: String(r.title),
    message: String(r.message),
    is_read: Boolean(r.is_read),
    created_at: String(r.created_at),
  }));

  const guest_access_logs = (sqlite.prepare('SELECT * FROM guest_access_logs ORDER BY id DESC LIMIT 1000').all() as Array<Record<string, unknown>>).map((r) => ({
    id: Number(r.id),
    ip: String(r.ip),
    timestamp: String(r.timestamp),
    success: Boolean(r.success),
    nisn_attempted: String(r.nisn_attempted),
  })) as GuestAccessLog[];

  const settingsRow = sqlite.prepare('SELECT value_json FROM settings WHERE key = ?').get('app_settings') as { value_json: string } | undefined;
  const storageRow = sqlite.prepare('SELECT value_json FROM settings WHERE key = ?').get('storage_bytes_simulated') as { value_json: string } | undefined;

  const defaultSettings = createInitialSeed().settings;
  let parsedSettings: SettingsMap = settingsRow
    ? { ...defaultSettings, ...(JSON.parse(settingsRow.value_json) as Partial<SettingsMap>) }
    : defaultSettings;

  // One-time idempotent migration for existing SQLite DBs: quality 70%, face similarity 70%
  const migKey = 'migration_quality70_sim70_v1';
  const hasMig = sqlite.prepare('SELECT value_json FROM app_state WHERE key = ?').get(migKey) as { value_json: string } | undefined;
  if (!hasMig) {
    if (settingsRow) {
      parsedSettings = {
        ...parsedSettings,
        min_snapshot_quality: 0.7,
        threshold_recognition: 0.7,
        threshold_clustering: 0.7,
      };
      sqlite
        .prepare('INSERT INTO settings (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json')
        .run('app_settings', JSON.stringify(parsedSettings));
    }
    sqlite
      .prepare('INSERT INTO app_state (key, value_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at')
      .run(migKey, '"done"', new Date().toISOString());
  }
  parsedSettings.min_snapshot_quality = normalizeMinSnapshotQuality(parsedSettings.min_snapshot_quality);

  const realDiskBytes = getDirectorySizeBytes(DATA_DIR);
  const storedSimBytes = storageRow ? Number(JSON.parse(storageRow.value_json)) : 0;

  let loadedDb: AppDatabase = {
    users,
    jurusans,
    kelas,
    students,
    gates,
    cameras,
    schedules,
    kelas_overrides,
    schedule_exceptions,
    attendance_logs,
    daily_attendance,
    anonymous_clusters,
    visitors,
    face_update_history,
    face_update_reviews,
    wa_queue,
    wa_accounts,
    wa_templates,
    notifications,
    guest_access_logs,
    settings: parsedSettings,
    storage_bytes_simulated: Math.max(realDiskBytes, Number.isFinite(storedSimBytes) ? storedSimBytes : realDiskBytes),
  };

  // One-time idempotent cutover to Production Mode for existing demo-seeded SQLite DBs
  const prodMigKey = 'migration_auto_production_v1';
  const hasProdMig = sqlite.prepare('SELECT value_json FROM app_state WHERE key = ?').get(prodMigKey) as { value_json: string } | undefined;
  if (!hasProdMig) {
    const demoNisns = new Set([
      '0081122001',
      '0081122002',
      '0081122003',
      '0081122004',
      '0081122005',
      '0081122006',
      '0081122007',
      '0081122008',
    ]);
    const removedStudentIds = loadedDb.students.filter((s) => demoNisns.has(s.nisn)).map((s) => s.id);
    const onlyDemoStudents = loadedDb.students.length > 0 && loadedDb.students.every((s) => demoNisns.has(s.nisn));
    const realClusters = loadedDb.anonymous_clusters.filter(
      (c) => Array.isArray(c.centroid) && c.centroid.length !== 16
    );
    loadedDb = stripDemoRecordsForProduction(loadedDb);
    if (realClusters.length > 0) {
      loadedDb.anonymous_clusters = realClusters;
    }
    saveDb(loadedDb);
    purgeDemoRowsFromSqlite(removedStudentIds, onlyDemoStudents);
    sqlite
      .prepare('INSERT INTO app_state (key, value_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at')
      .run(prodMigKey, '"done"', new Date().toISOString());
  }

  return loadedDb;
}

export function loadDb(): AppDatabase {
  if (cachedDb) {
    return cachedDb;
  }

  const sqlite = getSqlite();

  // Cek apakah tabel relasional sudah terisi
  const userCountRow = sqlite.prepare('SELECT COUNT(*) as c FROM users').get() as { c: number } | undefined;
  if ((userCountRow?.c ?? 0) > 0) {
    cachedDb = hydrateDefaults(readRelationalDb(sqlite));
    seedTrackersFromDb(cachedDb);
    return cachedDb;
  }

  // Migrasi satu kali otomatis dari app_state JSON blob lama -> tabel relasional SQLite terindeks
  try {
    const legacyRow = sqlite.prepare('SELECT value_json FROM app_state WHERE key = ?').get('main') as
      | { value_json: string }
      | undefined;
    if (legacyRow?.value_json) {
      const migrated = hydrateDefaults(JSON.parse(legacyRow.value_json) as AppDatabase);
      resetPersistedTrackers();
      saveDb(migrated);
      sqlite.prepare('DELETE FROM app_state WHERE key = ?').run('main');
      try {
        sqlite.exec('VACUUM');
      } catch {
        // ignore vacuum failure if concurrent read
      }
      cachedDb = readRelationalDb(sqlite);
      seedTrackersFromDb(cachedDb);
      return cachedDb;
    }

    if (fs.existsSync(LEGACY_JSON_FILE)) {
      const raw = fs.readFileSync(LEGACY_JSON_FILE, 'utf-8');
      const migrated = hydrateDefaults(JSON.parse(raw) as AppDatabase);
      resetPersistedTrackers();
      saveDb(migrated);
      cachedDb = readRelationalDb(sqlite);
      seedTrackersFromDb(cachedDb);
      return cachedDb;
    }
  } catch {
    // Fallback ke seed awal jika JSON lama korup
  }

  const seed = createInitialSeed();
  resetPersistedTrackers();
  saveDb(seed);
  cachedDb = readRelationalDb(sqlite);
  seedTrackersFromDb(cachedDb);
  return cachedDb;
}

export function saveDb(db: AppDatabase): void {
  const sqlite = getSqlite();
  cachedDb = db;
  dbVersion += 1;

  if (!persisted.initialized) {
    saveDbFull(sqlite, db);
    seedTrackersFromDb(db);
    return;
  }

  const hashUsers = JSON.stringify(db.users);
  const hashJurusans = JSON.stringify(db.jurusans);
  const hashKelas = JSON.stringify(db.kelas);
  const hashGates = JSON.stringify(db.gates);
  const hashCameras = JSON.stringify(db.cameras);
  const hashSchedules = JSON.stringify(db.schedules);
  const hashOverrides = JSON.stringify(db.kelas_overrides);
  const hashExceptions = JSON.stringify(db.schedule_exceptions);
  const hashVisitors = JSON.stringify(db.visitors);
  const hashWaAcc = JSON.stringify(db.wa_accounts);
  const hashWaTpl = JSON.stringify(db.wa_templates);
  const hashSettings = JSON.stringify(db.settings) + '|' + String(db.storage_bytes_simulated);

  sqlite.exec('BEGIN IMMEDIATE');
  try {
    if (persisted.smallHashes.users !== hashUsers) {
      sqlite.exec('DELETE FROM users');
      const insUser = sqlite.prepare('INSERT INTO users (id, name, email, role, is_active, password_hash) VALUES (?, ?, ?, ?, ?, ?)');
      for (const u of db.users) insUser.run(u.id, u.name, u.email, u.role, u.is_active ? 1 : 0, u.password_hash ?? '');
      persisted.smallHashes.users = hashUsers;
    }
    if (persisted.smallHashes.jurusans !== hashJurusans) {
      sqlite.exec('DELETE FROM jurusans');
      const insJur = sqlite.prepare('INSERT INTO jurusans (id, kode, nama) VALUES (?, ?, ?)');
      for (const j of db.jurusans) insJur.run(j.id, j.kode, j.nama);
      persisted.smallHashes.jurusans = hashJurusans;
    }
    if (persisted.smallHashes.kelas !== hashKelas) {
      sqlite.exec('DELETE FROM kelas');
      const insKls = sqlite.prepare('INSERT INTO kelas (id, jurusan_id, tingkat, nama, shift) VALUES (?, ?, ?, ?, ?)');
      for (const k of db.kelas) insKls.run(k.id, k.jurusan_id, k.tingkat, k.nama, k.shift);
      persisted.smallHashes.kelas = hashKelas;
    }
    if (persisted.smallHashes.gates !== hashGates) {
      sqlite.exec('DELETE FROM gates');
      const insGate = sqlite.prepare('INSERT INTO gates (id, nama_gerbang, lokasi, tipe) VALUES (?, ?, ?, ?)');
      for (const g of db.gates) insGate.run(g.id, g.nama_gerbang, g.lokasi, g.tipe);
      persisted.smallHashes.gates = hashGates;
    }
    if (persisted.smallHashes.cameras !== hashCameras) {
      sqlite.exec('DELETE FROM cameras');
      const insCam = sqlite.prepare(`
        INSERT INTO cameras (id, nama_kamera, gate_id, rtsp_url, resolusi, fps, aktif, status, last_error, last_online_at, min_face_size, capture_max_width)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const c of db.cameras) {
        insCam.run(
          c.id,
          c.nama_kamera,
          c.gate_id,
          c.rtsp_url,
          c.resolusi,
          c.fps,
          c.aktif ? 1 : 0,
          c.status,
          c.last_error ?? null,
          c.last_online_at ?? null,
          c.min_face_size ?? null,
          c.capture_max_width ?? null
        );
      }
      persisted.smallHashes.cameras = hashCameras;
    }
    if (persisted.smallHashes.schedules !== hashSchedules) {
      sqlite.exec('DELETE FROM schedules');
      const insSched = sqlite.prepare(`
        INSERT INTO schedules (id, jurusan_id, hari, jam_masuk_mulai, jam_masuk_selesai, jam_keluar_mulai, jam_keluar_selesai, toleransi_terlambat_menit)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const sc of db.schedules) {
        insSched.run(sc.id, sc.jurusan_id ?? null, sc.hari, sc.jam_masuk_mulai, sc.jam_masuk_selesai, sc.jam_keluar_mulai, sc.jam_keluar_selesai, sc.toleransi_terlambat_menit);
      }
      persisted.smallHashes.schedules = hashSchedules;
    }
    if (persisted.smallHashes.kelas_overrides !== hashOverrides) {
      sqlite.exec('DELETE FROM kelas_overrides');
      const insOverride = sqlite.prepare(`
        INSERT INTO kelas_overrides (id, kelas_id, hari, jam_masuk_mulai, jam_masuk_selesai, jam_keluar_mulai, jam_keluar_selesai, alasan)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const o of db.kelas_overrides) {
        insOverride.run(o.id, o.kelas_id, o.hari, o.jam_masuk_mulai, o.jam_masuk_selesai, o.jam_keluar_mulai, o.jam_keluar_selesai, o.alasan);
      }
      persisted.smallHashes.kelas_overrides = hashOverrides;
    }
    if (persisted.smallHashes.schedule_exceptions !== hashExceptions) {
      sqlite.exec('DELETE FROM schedule_exceptions');
      const insExc = sqlite.prepare(`
        INSERT INTO schedule_exceptions (id, tanggal, scope, ref_id, tipe, catatan, jam_masuk_override, jam_keluar_override)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const ex of db.schedule_exceptions) {
        insExc.run(ex.id, ex.tanggal, ex.scope, ex.ref_id ?? null, ex.tipe, ex.catatan, ex.jam_masuk_override ?? null, ex.jam_keluar_override ?? null);
      }
      persisted.smallHashes.schedule_exceptions = hashExceptions;
    }
    if (persisted.smallHashes.visitors !== hashVisitors) {
      sqlite.exec('DELETE FROM visitors');
      const insVisitor = sqlite.prepare('INSERT INTO visitors (id, nama, kategori, snapshot_path, catatan, created_at) VALUES (?, ?, ?, ?, ?, ?)');
      for (const v of db.visitors) insVisitor.run(v.id, v.nama, v.kategori, v.snapshot_path, v.catatan, v.created_at);
      persisted.smallHashes.visitors = hashVisitors;
    }
    if (persisted.smallHashes.wa_accounts !== hashWaAcc) {
      sqlite.exec('DELETE FROM wa_accounts');
      const insWaAcc = sqlite.prepare(`
        INSERT INTO wa_accounts (id, provider, phone_number, api_key, status, daily_count, hourly_count, last_reset_at, created_at, qr_connected)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const a of db.wa_accounts) {
        insWaAcc.run(a.id, a.provider, a.phone_number, a.api_key ?? '', a.status, a.daily_count, a.hourly_count, a.last_reset_at, a.created_at, a.qr_connected ? 1 : 0);
      }
      persisted.smallHashes.wa_accounts = hashWaAcc;
    }
    if (persisted.smallHashes.wa_templates !== hashWaTpl) {
      sqlite.exec('DELETE FROM wa_templates');
      const insWaTpl = sqlite.prepare('INSERT INTO wa_templates (id, code, name, template_text, is_active) VALUES (?, ?, ?, ?, ?)');
      for (const t of db.wa_templates) insWaTpl.run(t.id, t.code, t.name, t.template_text, t.is_active ? 1 : 0);
      persisted.smallHashes.wa_templates = hashWaTpl;
    }
    if (persisted.smallHashes.settings !== hashSettings) {
      const insSetting = sqlite.prepare(`
        INSERT INTO settings (key, value_json) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json
      `);
      insSetting.run('app_settings', JSON.stringify(db.settings));
      insSetting.run('storage_bytes_simulated', JSON.stringify(db.storage_bytes_simulated));
      persisted.smallHashes.settings = hashSettings;
    }

    // Incremental Students upsert/delete (avoids rewriting 5,000 embedding BLOBs on every attendance scan!)
    const nextStudents = new Map<number, string>();
    const upsertStudent = sqlite.prepare(`
      INSERT INTO students (
        id, nis, nisn, nama, nickname, kelas_id, tanggal_lahir, status,
        embedding, embedding_quality_score, embedding_updated_at, foto_ref, wa_ortu, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        nis = excluded.nis,
        nisn = excluded.nisn,
        nama = excluded.nama,
        nickname = excluded.nickname,
        kelas_id = excluded.kelas_id,
        tanggal_lahir = excluded.tanggal_lahir,
        status = excluded.status,
        embedding = excluded.embedding,
        embedding_quality_score = excluded.embedding_quality_score,
        embedding_updated_at = excluded.embedding_updated_at,
        foto_ref = excluded.foto_ref,
        wa_ortu = excluded.wa_ortu
    `);
    for (const s of db.students) {
      const sig = studentSignature(s);
      nextStudents.set(s.id, sig);
      if (persisted.students.get(s.id) !== sig) {
        upsertStudent.run(
          s.id, s.nis, s.nisn, s.nama, s.nickname, s.kelas_id, s.tanggal_lahir, s.status,
          encodeEmbeddingBlob(s.embedding), s.embedding_quality_score, s.embedding_updated_at ?? null,
          s.foto_ref ?? null, s.wa_ortu ?? '', s.created_at
        );
      }
    }
    const delStudent = sqlite.prepare('DELETE FROM students WHERE id = ?');
    for (const prevId of persisted.students.keys()) {
      if (!nextStudents.has(prevId)) delStudent.run(prevId);
    }
    persisted.students = nextStudents;

    // Incremental Anonymous Clusters upsert/delete
    const nextClusters = new Map<number, string>();
    const upsertCluster = sqlite.prepare(`
      INSERT INTO anonymous_clusters (
        id, centroid, hit_count, distinct_days, first_seen, last_seen,
        best_snapshot_path, best_quality_score, best_embedding, hit_snapshots_json, status, named_student_id, last_camera_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        centroid = excluded.centroid,
        hit_count = excluded.hit_count,
        distinct_days = excluded.distinct_days,
        last_seen = excluded.last_seen,
        best_snapshot_path = excluded.best_snapshot_path,
        best_quality_score = excluded.best_quality_score,
        best_embedding = excluded.best_embedding,
        hit_snapshots_json = excluded.hit_snapshots_json,
        status = excluded.status,
        named_student_id = excluded.named_student_id,
        last_camera_id = excluded.last_camera_id
    `);
    for (const c of db.anonymous_clusters) {
      const sig = clusterSignature(c);
      nextClusters.set(c.id, sig);
      if (persisted.clusters.get(c.id) !== sig) {
        upsertCluster.run(
          c.id, encodeEmbeddingBlob(c.centroid), c.hit_count, c.distinct_days, c.first_seen, c.last_seen,
          c.best_snapshot_path, c.best_quality_score, encodeEmbeddingBlob(c.best_embedding),
          JSON.stringify(c.hit_snapshots ?? []), c.status, c.named_student_id ?? null, c.last_camera_id ?? null
        );
      }
    }
    const delCluster = sqlite.prepare('DELETE FROM anonymous_clusters WHERE id = ?');
    for (const prevId of persisted.clusters.keys()) {
      if (!nextClusters.has(prevId)) delCluster.run(prevId);
    }
    persisted.clusters = nextClusters;

    // Incremental Face History
    const nextHist = new Map<number, string>();
    const upsertHist = sqlite.prepare(`
      INSERT INTO face_update_history (id, student_id, version, embedding, quality_score, snapshot_path, created_at, approved_by, approved_at, is_canonical)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        approved_by = excluded.approved_by,
        approved_at = excluded.approved_at,
        is_canonical = excluded.is_canonical
    `);
    for (const h of db.face_update_history) {
      const sig = historySignature(h);
      nextHist.set(h.id, sig);
      if (persisted.history.get(h.id) !== sig) {
        upsertHist.run(
          h.id, h.student_id, h.version, encodeEmbeddingBlob(h.embedding), h.quality_score,
          h.snapshot_path, h.created_at, h.approved_by ?? null, h.approved_at ?? null, h.is_canonical ? 1 : 0
        );
      }
    }
    const delHist = sqlite.prepare('DELETE FROM face_update_history WHERE id = ?');
    for (const prevId of persisted.history.keys()) {
      if (!nextHist.has(prevId)) delHist.run(prevId);
    }
    persisted.history = nextHist;

    // Incremental Face Reviews
    const nextRev = new Map<number, string>();
    const upsertRev = sqlite.prepare(`
      INSERT INTO face_update_reviews (id, student_id, month, year, candidate_snapshots_json, current_quality, best_new_quality, status, reviewed_by, reviewed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        candidate_snapshots_json = excluded.candidate_snapshots_json,
        current_quality = excluded.current_quality,
        best_new_quality = excluded.best_new_quality,
        status = excluded.status,
        reviewed_by = excluded.reviewed_by,
        reviewed_at = excluded.reviewed_at
    `);
    for (const r of db.face_update_reviews) {
      const sig = reviewSignature(r);
      nextRev.set(r.id, sig);
      if (persisted.reviews.get(r.id) !== sig) {
        upsertRev.run(
          r.id, r.student_id, r.month, r.year, JSON.stringify(r.candidate_snapshots),
          r.current_quality, r.best_new_quality, r.status, r.reviewed_by ?? null, r.reviewed_at ?? null
        );
      }
    }
    const delRev = sqlite.prepare('DELETE FROM face_update_reviews WHERE id = ?');
    for (const prevId of persisted.reviews.keys()) {
      if (!nextRev.has(prevId)) delRev.run(prevId);
    }
    persisted.reviews = nextRev;

    // Incremental Attendance Logs (insert/update changed only)
    const nextLogs = new Map<number, string>();
    const upsertLog = sqlite.prepare(`
      INSERT INTO attendance_logs (id, student_id, gate_id, camera_id, timestamp, tipe, status, is_manual_override, similarity_score, snapshot_path)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status,
        is_manual_override = excluded.is_manual_override,
        similarity_score = excluded.similarity_score,
        snapshot_path = excluded.snapshot_path
    `);
    for (const l of db.attendance_logs) {
      const sig = logSignature(l);
      nextLogs.set(l.id, sig);
      if (persisted.logs.get(l.id) !== sig) {
        upsertLog.run(l.id, l.student_id, l.gate_id, l.camera_id, l.timestamp, l.tipe, l.status, l.is_manual_override ? 1 : 0, l.similarity_score ?? null, l.snapshot_path ?? null);
      }
    }
    persisted.logs = nextLogs;

    // Incremental Daily Attendance (upsert changed/new only; preserves historical rows > 180 days)
    const nextDaily = new Map<number, string>();
    const upsertDaily = sqlite.prepare(`
      INSERT INTO daily_attendance (id, student_id, tanggal, jam_masuk, jam_keluar, status, manual_override_by, manual_override_at, catatan)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(student_id, tanggal) DO UPDATE SET
        jam_masuk = excluded.jam_masuk,
        jam_keluar = excluded.jam_keluar,
        status = excluded.status,
        manual_override_by = excluded.manual_override_by,
        manual_override_at = excluded.manual_override_at,
        catatan = excluded.catatan
    `);
    for (const d of db.daily_attendance) {
      const sig = dailySignature(d);
      nextDaily.set(d.id, sig);
      if (persisted.daily.get(d.id) !== sig) {
        upsertDaily.run(d.id, d.student_id, d.tanggal, d.jam_masuk ?? null, d.jam_keluar ?? null, d.status, d.manual_override_by ?? null, d.manual_override_at ?? null, d.catatan ?? null);
      }
    }
    persisted.daily = nextDaily;

    // Incremental WA Queue
    const nextWaQ = new Map<number, string>();
    const upsertWaQ = sqlite.prepare(`
      INSERT INTO wa_queue (id, student_id, phone, payload_json, status, retry_count, scheduled_at, sent_at, error_msg)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status,
        retry_count = excluded.retry_count,
        scheduled_at = excluded.scheduled_at,
        sent_at = excluded.sent_at,
        error_msg = excluded.error_msg
    `);
    for (const q of db.wa_queue) {
      const sig = waQueueSignature(q);
      nextWaQ.set(q.id, sig);
      if (persisted.waQueue.get(q.id) !== sig) {
        upsertWaQ.run(q.id, q.student_id ?? null, q.phone, JSON.stringify(q.payload), q.status, q.retry_count, q.scheduled_at, q.sent_at ?? null, q.error_msg ?? null);
      }
    }
    persisted.waQueue = nextWaQ;

    // Incremental Notifications
    const nextNotif = new Map<number, string>();
    const upsertNotif = sqlite.prepare(`
      INSERT INTO notifications (id, user_id, role_target, type, title, message, is_read, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET is_read = excluded.is_read
    `);
    for (const n of db.notifications) {
      const sig = notifSignature(n);
      nextNotif.set(n.id, sig);
      if (persisted.notifications.get(n.id) !== sig) {
        upsertNotif.run(n.id, n.user_id ?? null, n.role_target, n.type, n.title, n.message, n.is_read ? 1 : 0, n.created_at);
      }
    }
    const delNotif = sqlite.prepare('DELETE FROM notifications WHERE id = ?');
    for (const prevId of persisted.notifications.keys()) {
      if (!nextNotif.has(prevId)) delNotif.run(prevId);
    }
    persisted.notifications = nextNotif;

    // Append-only Guest Access Logs
    const insGuest = sqlite.prepare(`
      INSERT INTO guest_access_logs (id, ip, timestamp, success, nisn_attempted)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO NOTHING
    `);
    for (const g of db.guest_access_logs) {
      if (!persisted.guestLogs.has(g.id)) {
        insGuest.run(g.id, g.ip, g.timestamp, g.success ? 1 : 0, g.nisn_attempted);
        persisted.guestLogs.add(g.id);
      }
    }

    sqlite.exec('COMMIT');
  } catch (err) {
    try {
      sqlite.exec('ROLLBACK');
    } catch {
      // ignore rollback failure
    }
    throw err;
  }
}

function saveDbFull(sqlite: DatabaseSync, db: AppDatabase): void {
  sqlite.exec('BEGIN IMMEDIATE');
  try {
    sqlite.exec(`
      DELETE FROM users;
      DELETE FROM jurusans;
      DELETE FROM kelas;
      DELETE FROM students;
      DELETE FROM gates;
      DELETE FROM cameras;
      DELETE FROM schedules;
      DELETE FROM kelas_overrides;
      DELETE FROM schedule_exceptions;
      DELETE FROM anonymous_clusters;
      DELETE FROM visitors;
      DELETE FROM face_update_history;
      DELETE FROM face_update_reviews;
      DELETE FROM wa_accounts;
      DELETE FROM wa_templates;
      DELETE FROM notifications;
    `);

    const insUser = sqlite.prepare('INSERT INTO users (id, name, email, role, is_active, password_hash) VALUES (?, ?, ?, ?, ?, ?)');
    for (const u of db.users) {
      insUser.run(u.id, u.name, u.email, u.role, u.is_active ? 1 : 0, u.password_hash ?? '');
    }

    const insJur = sqlite.prepare('INSERT INTO jurusans (id, kode, nama) VALUES (?, ?, ?)');
    for (const j of db.jurusans) {
      insJur.run(j.id, j.kode, j.nama);
    }

    const insKls = sqlite.prepare('INSERT INTO kelas (id, jurusan_id, tingkat, nama, shift) VALUES (?, ?, ?, ?, ?)');
    for (const k of db.kelas) {
      insKls.run(k.id, k.jurusan_id, k.tingkat, k.nama, k.shift);
    }

    const insStudent = sqlite.prepare(`
      INSERT INTO students (
        id, nis, nisn, nama, nickname, kelas_id, tanggal_lahir, status,
        embedding, embedding_quality_score, embedding_updated_at, foto_ref, wa_ortu, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const s of db.students) {
      insStudent.run(
        s.id,
        s.nis,
        s.nisn,
        s.nama,
        s.nickname,
        s.kelas_id,
        s.tanggal_lahir,
        s.status,
        encodeEmbeddingBlob(s.embedding),
        s.embedding_quality_score,
        s.embedding_updated_at ?? null,
        s.foto_ref ?? null,
        s.wa_ortu ?? '',
        s.created_at
      );
    }

    const insGate = sqlite.prepare('INSERT INTO gates (id, nama_gerbang, lokasi, tipe) VALUES (?, ?, ?, ?)');
    for (const g of db.gates) {
      insGate.run(g.id, g.nama_gerbang, g.lokasi, g.tipe);
    }

    const insCam = sqlite.prepare(`
      INSERT INTO cameras (id, nama_kamera, gate_id, rtsp_url, resolusi, fps, aktif, status, last_error, last_online_at, min_face_size, capture_max_width)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const c of db.cameras) {
      insCam.run(
        c.id,
        c.nama_kamera,
        c.gate_id,
        c.rtsp_url,
        c.resolusi,
        c.fps,
        c.aktif ? 1 : 0,
        c.status,
        c.last_error ?? null,
        c.last_online_at ?? null,
        c.min_face_size ?? null,
        c.capture_max_width ?? null
      );
    }

    const insSched = sqlite.prepare(`
      INSERT INTO schedules (id, jurusan_id, hari, jam_masuk_mulai, jam_masuk_selesai, jam_keluar_mulai, jam_keluar_selesai, toleransi_terlambat_menit)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const sc of db.schedules) {
      insSched.run(sc.id, sc.jurusan_id ?? null, sc.hari, sc.jam_masuk_mulai, sc.jam_masuk_selesai, sc.jam_keluar_mulai, sc.jam_keluar_selesai, sc.toleransi_terlambat_menit);
    }

    const insOverride = sqlite.prepare(`
      INSERT INTO kelas_overrides (id, kelas_id, hari, jam_masuk_mulai, jam_masuk_selesai, jam_keluar_mulai, jam_keluar_selesai, alasan)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const o of db.kelas_overrides) {
      insOverride.run(o.id, o.kelas_id, o.hari, o.jam_masuk_mulai, o.jam_masuk_selesai, o.jam_keluar_mulai, o.jam_keluar_selesai, o.alasan);
    }

    const insExc = sqlite.prepare(`
      INSERT INTO schedule_exceptions (id, tanggal, scope, ref_id, tipe, catatan, jam_masuk_override, jam_keluar_override)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const ex of db.schedule_exceptions) {
      insExc.run(ex.id, ex.tanggal, ex.scope, ex.ref_id ?? null, ex.tipe, ex.catatan, ex.jam_masuk_override ?? null, ex.jam_keluar_override ?? null);
    }

    const insLog = sqlite.prepare(`
      INSERT INTO attendance_logs (id, student_id, gate_id, camera_id, timestamp, tipe, status, is_manual_override, similarity_score, snapshot_path)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        student_id = excluded.student_id,
        gate_id = excluded.gate_id,
        camera_id = excluded.camera_id,
        timestamp = excluded.timestamp,
        tipe = excluded.tipe,
        status = excluded.status,
        is_manual_override = excluded.is_manual_override,
        similarity_score = excluded.similarity_score,
        snapshot_path = excluded.snapshot_path
    `);
    for (const l of db.attendance_logs) {
      insLog.run(l.id, l.student_id, l.gate_id, l.camera_id, l.timestamp, l.tipe, l.status, l.is_manual_override ? 1 : 0, l.similarity_score ?? null, l.snapshot_path ?? null);
    }

    const cutoffDaily = dailyWindowCutoffDate();
    sqlite.prepare('DELETE FROM daily_attendance WHERE tanggal >= ?').run(cutoffDaily);
    const insDaily = sqlite.prepare(`
      INSERT INTO daily_attendance (id, student_id, tanggal, jam_masuk, jam_keluar, status, manual_override_by, manual_override_at, catatan)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(student_id, tanggal) DO UPDATE SET
        jam_masuk = excluded.jam_masuk,
        jam_keluar = excluded.jam_keluar,
        status = excluded.status,
        manual_override_by = excluded.manual_override_by,
        manual_override_at = excluded.manual_override_at,
        catatan = excluded.catatan
    `);
    for (const d of db.daily_attendance) {
      insDaily.run(
        d.id,
        d.student_id,
        d.tanggal,
        d.jam_masuk ?? null,
        d.jam_keluar ?? null,
        d.status,
        d.manual_override_by ?? null,
        d.manual_override_at ?? null,
        d.catatan ?? null
      );
    }

    const insCluster = sqlite.prepare(`
      INSERT INTO anonymous_clusters (
        id, centroid, hit_count, distinct_days, first_seen, last_seen,
        best_snapshot_path, best_quality_score, best_embedding, hit_snapshots_json, status, named_student_id, last_camera_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const c of db.anonymous_clusters) {
      insCluster.run(
        c.id,
        encodeEmbeddingBlob(c.centroid),
        c.hit_count,
        c.distinct_days,
        c.first_seen,
        c.last_seen,
        c.best_snapshot_path,
        c.best_quality_score,
        encodeEmbeddingBlob(c.best_embedding),
        JSON.stringify(c.hit_snapshots ?? []),
        c.status,
        c.named_student_id ?? null,
        c.last_camera_id ?? null
      );
    }

    const insVisitor = sqlite.prepare('INSERT INTO visitors (id, nama, kategori, snapshot_path, catatan, created_at) VALUES (?, ?, ?, ?, ?, ?)');
    for (const v of db.visitors) {
      insVisitor.run(v.id, v.nama, v.kategori, v.snapshot_path, v.catatan, v.created_at);
    }

    const insHist = sqlite.prepare(`
      INSERT INTO face_update_history (id, student_id, version, embedding, quality_score, snapshot_path, created_at, approved_by, approved_at, is_canonical)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const h of db.face_update_history) {
      insHist.run(h.id, h.student_id, h.version, encodeEmbeddingBlob(h.embedding), h.quality_score, h.snapshot_path, h.created_at, h.approved_by ?? null, h.approved_at ?? null, h.is_canonical ? 1 : 0);
    }

    const insRev = sqlite.prepare(`
      INSERT INTO face_update_reviews (id, student_id, month, year, candidate_snapshots_json, current_quality, best_new_quality, status, reviewed_by, reviewed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const r of db.face_update_reviews) {
      insRev.run(r.id, r.student_id, r.month, r.year, JSON.stringify(r.candidate_snapshots), r.current_quality, r.best_new_quality, r.status, r.reviewed_by ?? null, r.reviewed_at ?? null);
    }

    const insWaQ = sqlite.prepare(`
      INSERT INTO wa_queue (id, student_id, phone, payload_json, status, retry_count, scheduled_at, sent_at, error_msg)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status,
        retry_count = excluded.retry_count,
        scheduled_at = excluded.scheduled_at,
        sent_at = excluded.sent_at,
        error_msg = excluded.error_msg
    `);
    for (const q of db.wa_queue) {
      insWaQ.run(q.id, q.student_id ?? null, q.phone, JSON.stringify(q.payload), q.status, q.retry_count, q.scheduled_at, q.sent_at ?? null, q.error_msg ?? null);
    }

    const insWaAcc = sqlite.prepare(`
      INSERT INTO wa_accounts (id, provider, phone_number, api_key, status, daily_count, hourly_count, last_reset_at, created_at, qr_connected)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const a of db.wa_accounts) {
      insWaAcc.run(a.id, a.provider, a.phone_number, a.api_key ?? '', a.status, a.daily_count, a.hourly_count, a.last_reset_at, a.created_at, a.qr_connected ? 1 : 0);
    }

    const insWaTpl = sqlite.prepare('INSERT INTO wa_templates (id, code, name, template_text, is_active) VALUES (?, ?, ?, ?, ?)');
    for (const t of db.wa_templates) {
      insWaTpl.run(t.id, t.code, t.name, t.template_text, t.is_active ? 1 : 0);
    }

    const insNotif = sqlite.prepare('INSERT INTO notifications (id, user_id, role_target, type, title, message, is_read, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    for (const n of db.notifications) {
      insNotif.run(n.id, n.user_id ?? null, n.role_target, n.type, n.title, n.message, n.is_read ? 1 : 0, n.created_at);
    }

    const insGuest = sqlite.prepare(`
      INSERT INTO guest_access_logs (id, ip, timestamp, success, nisn_attempted)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO NOTHING
    `);
    for (const g of db.guest_access_logs) {
      insGuest.run(g.id, g.ip, g.timestamp, g.success ? 1 : 0, g.nisn_attempted);
    }

    const insSetting = sqlite.prepare(`
      INSERT INTO settings (key, value_json) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json
    `);
    insSetting.run('app_settings', JSON.stringify(db.settings));
    insSetting.run('storage_bytes_simulated', JSON.stringify(db.storage_bytes_simulated));

    sqlite.exec('COMMIT');
  } catch (err) {
    try {
      sqlite.exec('ROLLBACK');
    } catch {
      // ignore rollback failure
    }
    throw err;
  }
}

export function purgeDemoRowsFromSqlite(removedStudentIds: number[], clearAllDemoLogs: boolean): void {
  const sqlite = getSqlite();
  if (clearAllDemoLogs) {
    sqlite.exec(`
      DELETE FROM attendance_logs;
      DELETE FROM daily_attendance;
      DELETE FROM wa_queue;
      DELETE FROM guest_access_logs;
    `);
    return;
  }
  for (const sid of removedStudentIds) {
    sqlite.prepare('DELETE FROM attendance_logs WHERE student_id = ?').run(sid);
    sqlite.prepare('DELETE FROM daily_attendance WHERE student_id = ?').run(sid);
    sqlite.prepare('DELETE FROM wa_queue WHERE student_id = ?').run(sid);
  }
}

export function deleteStudentFromSqlite(studentId: number): void {
  const sqlite = getSqlite();
  sqlite.prepare('DELETE FROM daily_attendance WHERE student_id = ?').run(studentId);
  sqlite.prepare('DELETE FROM attendance_logs WHERE student_id = ?').run(studentId);
  sqlite.prepare('DELETE FROM face_update_history WHERE student_id = ?').run(studentId);
  sqlite.prepare('DELETE FROM face_update_reviews WHERE student_id = ?').run(studentId);
  sqlite.prepare('DELETE FROM students WHERE id = ?').run(studentId);
  persisted.students.delete(studentId);
}

export function runStorageCleanup(db: AppDatabase): { freedMb: number } {
  const beforeBytes = db.storage_bytes_simulated + getDirectorySizeBytes(TTS_CACHE_DIR);
  const fourMonthsAgoMs = Date.now() - 120 * 86_400_000;

  // 1. Keep max 3 version histories per student and delete > 4 months (non-canonical)
  const byStudent = new Map<number, typeof db.face_update_history>();
  for (const h of db.face_update_history) {
    const list = byStudent.get(h.student_id) ?? [];
    list.push(h);
    byStudent.set(h.student_id, list);
  }
  const keptHistory: typeof db.face_update_history = [];
  for (const list of byStudent.values()) {
    list.sort((a, b) => b.version - a.version);
    const filtered = list.filter((h, idx) => {
      if (h.is_canonical) return true;
      if (idx >= 3) return false;
      const ts = Date.parse(h.created_at.replace(' ', 'T'));
      return Number.isNaN(ts) || ts >= fourMonthsAgoMs;
    });
    keptHistory.push(...filtered);
  }
  db.face_update_history = keptHistory;

  // 2. Archive/delete expired clusters
  const archiveMs = db.settings.cluster_archive_days * 86_400_000;
  const deleteMs = db.settings.cluster_delete_days * 86_400_000;
  const now = Date.now();
  db.anonymous_clusters = db.anonymous_clusters.filter((c) => {
    const lastMs = Date.parse(c.last_seen.replace(' ', 'T'));
    if (Number.isNaN(lastMs)) return true;
    const age = now - lastMs;
    if (age > deleteMs) return false;
    if (age > archiveMs && c.status === 'PENDING') c.status = 'ARCHIVED';
    return true;
  });

  // 3. Cap TTS cache at 200 MB (LRU) & rotate backups under 150 MB
  enforceDirQuota(TTS_CACHE_DIR, 200 * 1024 * 1024);
  rotateBackups(db.settings.backup_retention_count ?? 2);

  // 4. Prune very old attendance_logs (> 400 days) & guest_access_logs (> 30 days) directly in SQLite
  try {
    const sqlite = getSqlite();
    const logCutoff = new Date(Date.now() - 400 * 86_400_000).toISOString().slice(0, 10);
    const guestCutoff = new Date(Date.now() - 30 * 86_400_000).toISOString();
    sqlite.prepare('DELETE FROM attendance_logs WHERE timestamp < ?').run(logCutoff);
    sqlite.prepare('DELETE FROM guest_access_logs WHERE timestamp < ?').run(guestCutoff);
  } catch {
    // ignore cleanup query failures
  }

  // 5. Prune unreferenced or expired (>30 days) local snapshot files to keep storage compact
  try {
    if (fs.existsSync(SNAPSHOTS_DIR)) {
      const keepRel = new Set<string>();
      const recentAttCutoff = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
      for (const s of db.students) if (s.foto_ref) keepRel.add(s.foto_ref);
      for (const h of db.face_update_history) if (h.snapshot_path) keepRel.add(h.snapshot_path);
      for (const v of db.visitors) if (v.snapshot_path) keepRel.add(v.snapshot_path);
      for (const c of db.anonymous_clusters) {
        if (c.best_snapshot_path) keepRel.add(c.best_snapshot_path);
        for (const hs of c.hit_snapshots ?? []) {
          if (hs.snapshot_path) keepRel.add(hs.snapshot_path);
        }
      }
      for (const l of db.attendance_logs) {
        if (l.snapshot_path && l.timestamp >= recentAttCutoff) keepRel.add(l.snapshot_path);
      }
      const expireMs = Date.now() - 7 * 86_400_000;
      for (const name of fs.readdirSync(SNAPSHOTS_DIR)) {
        const rel = `/data/snapshots/${name}`;
        if (keepRel.has(rel)) continue;
        const full = path.join(SNAPSHOTS_DIR, name);
        const st = fs.statSync(full);
        if (st.isFile() && st.mtimeMs < expireMs) {
          fs.unlinkSync(full);
        }
      }
    }
  } catch {
    // ignore snapshot cleanup failures
  }

  const realBytes = getDirectorySizeBytes(DATA_DIR);
  db.storage_bytes_simulated = Math.max(realBytes, Math.round(db.storage_bytes_simulated * 0.72));
  saveDb(db);

  const afterBytes = db.storage_bytes_simulated + getDirectorySizeBytes(TTS_CACHE_DIR);
  return { freedMb: Math.max(0, Math.round((beforeBytes - afterBytes) / (1024 * 1024))) };
}

export function enforceDirQuota(dirPath: string, maxBytes: number): void {
  if (!fs.existsSync(dirPath)) return;
  try {
    const files = fs
      .readdirSync(dirPath)
      .map((name) => {
        const full = path.join(dirPath, name);
        const st = fs.statSync(full);
        return { full, isFile: st.isFile(), size: st.size, mtimeMs: st.mtimeMs };
      })
      .filter((f) => f.isFile)
      .sort((a, b) => a.mtimeMs - b.mtimeMs);

    let total = files.reduce((acc, f) => acc + f.size, 0);
    for (const f of files) {
      if (total <= maxBytes) break;
      fs.unlinkSync(f.full);
      total -= f.size;
    }
  } catch {
    // ignore cleanup failures
  }
}

// ============================================================================
// COMPACT ROTATING GZIP SQLITE BACKUP & RESTORE
// ============================================================================

function rotateBackups(retentionCount: number): void {
  if (!fs.existsSync(BACKUPS_DIR)) return;
  const maxFiles = Math.max(1, Math.min(5, Math.round(retentionCount || 2)));
  try {
    const files = fs
      .readdirSync(BACKUPS_DIR)
      .filter((n) => n.endsWith('.sqlite.gz'))
      .map((name) => {
        const full = path.join(BACKUPS_DIR, name);
        const st = fs.statSync(full);
        return { name, full, size: st.size, mtimeMs: st.mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);

    for (let i = maxFiles; i < files.length; i++) {
      fs.unlinkSync(files[i].full);
    }
  } catch {
    // ignore rotation failure
  }
  enforceDirQuota(BACKUPS_DIR, BACKUP_MAX_BYTES);
}

export function listBackups(): BackupEntry[] {
  fs.mkdirSync(BACKUPS_DIR, { recursive: true });
  try {
    return fs
      .readdirSync(BACKUPS_DIR)
      .filter((n) => n.endsWith('.sqlite.gz'))
      .map((filename) => {
        const st = fs.statSync(path.join(BACKUPS_DIR, filename));
        return {
          filename,
          bytes: st.size,
          created_at: st.mtime.toISOString(),
        };
      })
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
  } catch {
    return [];
  }
}

export function getBackupFilePath(filename: string): string | null {
  if (!/^[a-zA-Z0-9._-]+\.sqlite\.gz$/.test(filename)) return null;
  const full = path.join(BACKUPS_DIR, filename);
  return fs.existsSync(full) ? full : null;
}

export function runCompactBackup(retentionCount = 2): BackupEntry {
  const sqlite = getSqlite();
  fs.mkdirSync(BACKUPS_DIR, { recursive: true });

  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  const tmpSqlite = path.join(BACKUPS_DIR, `.tmp-${stamp}-${process.pid}.sqlite`);
  const gzName = `absensi-backup-${stamp}.sqlite.gz`;
  const gzPath = path.join(BACKUPS_DIR, gzName);

  try {
    if (fs.existsSync(tmpSqlite)) fs.unlinkSync(tmpSqlite);
    const escapedPath = tmpSqlite.replace(/'/g, "''");
    sqlite.exec(`VACUUM INTO '${escapedPath}'`);
    const rawBuf = fs.readFileSync(tmpSqlite);
    const gzBuf = zlib.gzipSync(rawBuf, { level: 9 });
    fs.writeFileSync(gzPath, gzBuf);
  } finally {
    try {
      if (fs.existsSync(tmpSqlite)) fs.unlinkSync(tmpSqlite);
    } catch {
      // ignore temp cleanup
    }
  }

  rotateBackups(retentionCount);
  const st = fs.statSync(gzPath);
  return {
    filename: gzName,
    bytes: st.size,
    created_at: st.mtime.toISOString(),
  };
}

export function restoreFromBackupBuffer(rawInput: Buffer): AppDatabase {
  let sqliteBuf = rawInput;
  if (rawInput.length >= 2 && rawInput[0] === 0x1f && rawInput[1] === 0x8b) {
    sqliteBuf = zlib.gunzipSync(rawInput);
  }
  const header = sqliteBuf.subarray(0, 16).toString('utf-8');
  if (!header.startsWith('SQLite format 3')) {
    throw new Error('File backup tidak valid (bukan format database SQLite / .sqlite.gz).');
  }

  fs.mkdirSync(BACKUPS_DIR, { recursive: true });
  const testTmp = path.join(BACKUPS_DIR, `.restore-verify-${process.pid}.sqlite`);
  fs.writeFileSync(testTmp, sqliteBuf);

  try {
    const checkConn = new DatabaseSync(testTmp);
    const qc = checkConn.prepare('PRAGMA quick_check').get() as Record<string, unknown> | undefined;
    const qcVal = qc ? String(Object.values(qc)[0]) : '';
    const hasUsers = checkConn.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('users','app_state')").all();
    checkConn.close();
    if (qcVal !== 'ok' || hasUsers.length === 0) {
      throw new Error('Integritas database backup gagal diverifikasi.');
    }

    // Close active SQLite connection cleanly before swapping file
    if (sqliteDb) {
      try {
        sqliteDb.close();
      } catch {
        // ignore
      }
      sqliteDb = null;
      schemaInitialized = false;
    }

    for (const suffix of ['', '-wal', '-shm']) {
      const target = `${SQLITE_FILE}${suffix}`;
      if (fs.existsSync(target) && suffix !== '') {
        fs.unlinkSync(target);
      }
    }
    fs.copyFileSync(testTmp, SQLITE_FILE);
    invalidateDbCache();
  } finally {
    try {
      if (fs.existsSync(testTmp)) fs.unlinkSync(testTmp);
    } catch {
      // ignore
    }
  }

  return loadDb();
}
