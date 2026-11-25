import { APP_ROOT } from './src/server/envBootstrap.ts';
import fs from 'fs';
import http from 'http';
import path from 'path';
import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import * as XLSX from 'xlsx';
import {
  DATA_DIR,
  SNAPSHOTS_DIR,
  capLogFileSize,
  createAuthSession,
  deleteAuthSession,
  deleteStudentFromSqlite,
  getBackupFilePath,
  getCachedClusterFaceIndex,
  getDataStorageBreakdown,
  getDbVersion,
  getDebugDetectionFilePath,
  getDetectionStatsSummary,
  getSessionUserId,
  hashPassword,
  invalidateDbCache,
  listBackups,
  listDebugDetectionFiles,
  loadDb,
  normalizeQualityGateSettingsFields,
  persistCompactPhotoDataUrl,
  purgeDemoRowsFromSqlite,
  recordDetectionStatsWindow,
  restoreFromBackupBuffer,
  runCompactBackup,
  runStorageCleanup,
  sanitizeUser,
  saveDb,
  verifyPassword,
} from './src/server/store.ts';
import {
  getNodeWorkerStatus,
  resolveFfmpegDetails,
  setPythonFaceServiceOnline,
  startFaceServiceMonitor,
  updatePythonCameraTelemetry,
} from './src/server/nodeFaceWorker.ts';
import { isPiperAvailable, prewarmStudentNamesTts, synthesizeIndonesianWav } from './src/server/ttsService.ts';
import {
  deleteGatewayAccount,
  dispatchWaMessage,
  ensureGatewayAccountForDbAccount,
  ensureWaGatewayRunning,
  getGatewayQrState,
  getRoundRobinCursorId,
  getWaGatewayHealth,
  reconnectGatewayAccount,
  setRoundRobinCursorId,
  startGatewayPairing,
  startWaQueueWorker,
  stopWaGatewayChild,
  syncGatewayAccountStatus,
} from './src/server/waGateway.ts';
import {
  appendClusterHitSnapshot,
  applyWaQuotaResetIfDue,
  blendFaceEmbeddings,
  calculateAttendancePercentage,
  checkClusterReadyStatus,
  classifyAcademicTransition,
  computeQualityScore,
  computeScheduledWaDispatchTime,
  cosineSimilarity,
  evaluateAttendanceRecognition,
  evaluateFaceMaintenanceProgress,
  extractJpegFramesFromChunk,
  formatManualResolution,
  formatWaMessage,
  getJakartaNowParts,
  maskRtspCredentials,
  mergeAnonymousClustersState,
  normalizeCaptureJpegQuality,
  normalizeCaptureMaxWidth,
  normalizeExcelBirthDate,
  normalizeMaxFaceSize,
  normalizeMinFaceSize,
  normalizeMinSnapshotQuality,
  normalizeStudentStatus,
  normalizeWaPhone,
  normalizeWaProvider,
  parseFfmpegStreamOutput,
  parseKelasHierarchy,
  parseResolutionDimensions,
  passesSnapshotQualityThreshold,
  promoteHitInClusterState,
  removeHitFromClusterState,
  removeMultipleHitsFromClusterState,
  resolveScheduleForStudent,
  selectNextWaAccountRoundRobin,
  stripDemoRecordsForProduction,
  summarizeEmbeddingDimensions,
  validateAndNormalizeScheduleTimes,
} from './src/lib/attendanceEngine.ts';
import {
  buildFfmpegLivePreviewArgs,
  diagnoseFfmpegError,
  getStaticAssetContentType,
  getStaticCacheControl,
  isNonSpaResourcePath,
  resolveListenConfig,
  shouldServeProductionBuild,
} from './src/lib/staticConfig.ts';
import {
  buildSessionCookieHeader,
  createRateLimiter,
  hasActiveAdminUser,
  isAuthorizedInternalRequest,
  isSameOriginMutationRequest,
  isStrongSetupPassword,
  validateRtspStreamUrl,
} from './src/lib/security.ts';
import { stripEmbeddingsForBootstrap } from './src/lib/uiRefreshGuard.ts';
import { findBestFaceMatch } from './src/lib/faceIndex.ts';
import { createLogThrottle, pruneInMemoryLogs } from './src/lib/logRetention.ts';
import { CLUSTER_MAX_HITS, roundEmbeddingForJson } from './src/lib/storageBudget.ts';
import { getOrCreateInternalToken } from './src/lib/internalToken.ts';
import type { AcademicTransitionType, AppDatabase, AttendanceStatus, Student, User, UserRole } from './src/types';

const FACE_SERVICE_URL = process.env.FACE_SERVICE_URL || 'http://127.0.0.1:8001';
const execFileAsync = promisify(execFile);
const SERVER_START_MS = Date.now();
let pythonGallerySynced = false;

const loginRateLimiter = createRateLimiter(10, 15 * 60_000);
const setupRateLimiter = createRateLimiter(8, 15 * 60_000);
const serverLogThrottle = createLogThrottle(60_000);
const lastCameraDbPersistMs = new Map<number, number>();

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 'loopback');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (
    req.path.startsWith('/api/') &&
    req.headers.cookie?.includes('absensi_sid=') &&
    !isSameOriginMutationRequest({
      method: req.method,
      originHeader: req.headers.origin,
      hostHeader: req.headers.host,
      forwardedHostHeader: req.headers['x-forwarded-host'],
    })
  ) {
    res.status(403).json({ error: 'Origin permintaan tidak valid.' });
    return;
  }
  next();
});
app.use(express.json({ limit: '25mb' }));
app.use('/data/snapshots', express.static(SNAPSHOTS_DIR, { dotfiles: 'ignore' }));
app.get('/favicon.ico', (_req, res) => {
  const candidates = [
    path.join(APP_ROOT, 'dist', 'favicon.ico'),
    path.join(APP_ROOT, 'public', 'favicon.ico'),
    path.join(APP_ROOT, 'favicon.ico'),
  ];
  const found = candidates.find((p) => fs.existsSync(p));
  if (found) {
    res.setHeader('Content-Type', 'image/x-icon');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.sendFile(found);
    return;
  }
  res.status(204).end();
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('error', (err: NodeJS.ErrnoException) => {
  // HTTP server error listener handles EADDRINUSE fallback/exit cleanly; avoid crashing via unattached wss error.
  if (err.code !== 'EADDRINUSE') {
    console.error('[WebSocketServer] Error:', err.message);
  }
});

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

type FaceServiceCallResult<T> =
  | { reachable: true; ok: true; status: number; data: T }
  | { reachable: true; ok: false; status: number; error: string }
  | { reachable: false; ok: false; status: 0; error: string };

async function callFaceServiceWithStatus<T>(endpoint: string, body?: unknown): Promise<FaceServiceCallResult<T>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const resp = await fetch(`${FACE_SERVICE_URL}${endpoint}`, {
      method: body !== undefined ? 'POST' : 'GET',
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    if (!resp.ok) {
      let errDetail = `Face service menolak permintaan (HTTP ${resp.status}).`;
      try {
        const errBody = (await resp.json()) as { detail?: unknown; error?: unknown };
        if (typeof errBody?.detail === 'string' && errBody.detail.trim()) errDetail = errBody.detail.trim();
        else if (typeof errBody?.error === 'string' && errBody.error.trim()) errDetail = errBody.error.trim();
      } catch {
        // ignore JSON parse failure on error body
      }
      return { reachable: true, ok: false, status: resp.status, error: errDetail };
    }
    const data = (await resp.json()) as T;
    return { reachable: true, ok: true, status: resp.status, data };
  } catch (err) {
    return {
      reachable: false,
      ok: false,
      status: 0,
      error: err instanceof Error ? err.message : 'Python face service tidak terjangkau',
    };
  } finally {
    clearTimeout(timer);
  }
}

async function callFaceService<T>(endpoint: string, body?: unknown): Promise<T | null> {
  const result = await callFaceServiceWithStatus<T>(endpoint, body);
  return result.ok ? result.data : null;
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
    const jktNow = getJakartaNowParts();
    const curMonth = jktNow.month;
    const curYear = jktNow.year;
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

function requireInternalAccess(): express.RequestHandler {
  return (req, res, next) => {
    if (
      !isAuthorizedInternalRequest({
        remoteAddress: req.socket.remoteAddress,
        headers: req.headers,
        expectedToken: getOrCreateInternalToken({ dataDir: DATA_DIR }),
      })
    ) {
      res.status(403).json({ error: 'Akses endpoint internal dibatasi khusus layanan lokal.' });
      return;
    }
    next();
  };
}

function isRequestHttps(req: express.Request): boolean {
  const fwdProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  return req.secure || fwdProto === 'https';
}

// ============================================================================
// API ROUTES
// ============================================================================

app.get('/api/health', async (_req, res) => {
  const db = loadDb();
  const jkt = getJakartaNowParts();
  const [faceHealth, waHealth] = await Promise.all([
    callFaceService<Record<string, unknown>>('/health'),
    getWaGatewayHealth(),
  ]);
  const nodeWorker = getNodeWorkerStatus(db);
  const ffmpegRes = resolveFfmpegDetails();
  const embeddingDimensions = summarizeEmbeddingDimensions(db.students, db.anonymous_clusters);
  res.json({
    ok: true,
    version: nodeWorker.app_version,
    sqlite: true,
    needs_setup: !hasActiveAdminUser(db.users),
    timezone: 'Asia/Jakarta',
    server_time_wib: jkt.dateTimeStr,
    uptime_sec: Math.round((Date.now() - SERVER_START_MS) / 1000),
    piper_offline: isPiperAvailable(),
    ffmpeg_ready: ffmpegRes.foundExecutable,
    ffmpeg_error: ffmpegRes.foundExecutable
      ? null
      : diagnoseFfmpegError(
          ffmpegRes.nonExecutablePaths.length > 0 ? `spawn ${ffmpegRes.nonExecutablePaths[0]} EACCES` : 'spawn ffmpeg ENOENT',
          ffmpegRes
        ),
    face_service: faceHealth ?? { ok: false, mode: nodeWorker.engine },
    node_worker: nodeWorker,
    embedding_dimensions: embeddingDimensions,
    today_stats: {
      date_wib: jkt.dateStr,
      attendance_logs_today: db.attendance_logs.filter((l) => l.timestamp.startsWith(jkt.dateStr)).length,
      daily_attendance_today: db.daily_attendance.filter((d) => d.tanggal === jkt.dateStr).length,
      anonymous_clusters_pending: db.anonymous_clusters.filter((c) => c.status === 'PENDING').length,
      anonymous_clusters_ready: db.anonymous_clusters.filter((c) => c.status === 'READY').length,
    },
    wa_gateway: {
      auto_dispatch: Boolean(db.settings.wa_auto_dispatch_enabled),
      provider: normalizeWaProvider(db.settings.wa_provider),
      connected_accounts: db.wa_accounts.filter((a) => a.qr_connected && a.status !== 'BANNED' && a.status !== 'PAUSED').length,
      service_online: waHealth.online,
      active_browsers: waHealth.active_browsers,
      max_chrome: waHealth.max_chrome,
      round_robin_cursor: getRoundRobinCursorId(),
      pending_queue: db.wa_queue.filter((q) => q.status === 'PENDING').length,
    },
  });
});

app.get('/api/worker/status', requireAuth(), (_req, res) => {
  const db = loadDb();
  const base = getNodeWorkerStatus(db);
  const autoUpdateEnabled =
    process.env.AUTO_UPDATE_ENABLED === '1' || process.env.AUTO_UPDATE_ENABLED === 'true';
  res.json({
    ...base,
    storage_breakdown: getDataStorageBreakdown(),
    detection_stats: getDetectionStatsSummary(db.cameras),
    automation: {
      daily_scheduler_active: true,
      wa_worker_active: Boolean(db.settings.wa_auto_dispatch_enabled),
      auto_backup_enabled: db.settings.auto_backup_enabled !== false,
      auto_update_enabled: autoUpdateEnabled,
      python_gallery_synced: pythonGallerySynced,
    },
  });
});

app.get('/api/debug/detection', requireAuth(['ADMIN', 'BK']), (_req, res) => {
  const db = loadDb();
  res.json({
    debug_detection: Boolean(db.settings.debug_detection),
    files: listDebugDetectionFiles(),
  });
});

app.get('/api/debug/detection/:filename', requireAuth(['ADMIN', 'BK']), (req, res) => {
  const filePath = getDebugDetectionFilePath(String(req.params.filename || ''));
  if (!filePath) {
    res.status(404).json({ error: 'Snapshot debug tidak ditemukan.' });
    return;
  }
  res.setHeader('Content-Type', 'image/png');
  res.sendFile(filePath);
});

app.get('/api/setup/status', (_req, res) => {
  const db = loadDb();
  res.json({
    needs_setup: !hasActiveAdminUser(db.users),
    school_name: db.settings.school_name,
  });
});

app.post('/api/setup/initialize', (req, res) => {
  const ip = req.ip || '127.0.0.1';
  const rl = setupRateLimiter.checkAndConsume(ip);
  if (!rl.allowed) {
    res.setHeader('Retry-After', String(rl.retryAfterSec));
    res.status(429).json({ error: 'Terlalu banyak percobaan setup. Tunggu beberapa menit sebelum mencoba lagi.' });
    return;
  }

  const db = loadDb();
  if (hasActiveAdminUser(db.users)) {
    res.status(409).json({ error: 'Setup awal sudah selesai dan dikunci. Silakan masuk melalui halaman Login.' });
    return;
  }

  const schoolName = String(req.body?.school_name || '').trim();
  const adminName = String(req.body?.admin_name || '').trim();
  const adminEmail = String(req.body?.admin_email || '').trim().toLowerCase();
  const adminPassword = String(req.body?.admin_password || '');
  const createBk = Boolean(req.body?.create_bk);
  const bkName = String(req.body?.bk_name || 'Guru BK Sekolah').trim();
  const bkEmail = String(req.body?.bk_email || '').trim().toLowerCase();
  const bkPassword = String(req.body?.bk_password || '');

  if (schoolName.length < 3 || schoolName.length > 120) {
    res.status(400).json({ error: 'Nama sekolah wajib diisi (minimal 3 karakter).' });
    return;
  }
  if (adminName.length < 2 || adminName.length > 80) {
    res.status(400).json({ error: 'Nama lengkap Administrator wajib diisi (minimal 2 karakter).' });
    return;
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(adminEmail)) {
    res.status(400).json({ error: 'Format email Administrator tidak valid.' });
    return;
  }
  const pwdCheck = isStrongSetupPassword(adminPassword);
  if (!pwdCheck.valid) {
    res.status(400).json({ error: pwdCheck.reason });
    return;
  }

  if (createBk) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(bkEmail) || bkEmail === adminEmail) {
      res.status(400).json({ error: 'Email Guru BK tidak valid atau sama dengan email Administrator.' });
      return;
    }
    const bkPwdCheck = isStrongSetupPassword(bkPassword);
    if (!bkPwdCheck.valid) {
      res.status(400).json({ error: `Password Guru BK: ${bkPwdCheck.reason}` });
      return;
    }
  }

  const adminUser: User = {
    id: nextId(db.users),
    name: adminName,
    email: adminEmail,
    role: 'ADMIN',
    is_active: true,
    password_hash: hashPassword(adminPassword),
  };
  db.users.push(adminUser);

  if (createBk) {
    db.users.push({
      id: nextId(db.users),
      name: bkName || 'Guru BK',
      email: bkEmail,
      role: 'BK',
      is_active: true,
      password_hash: hashPassword(bkPassword),
    });
  }

  db.settings.school_name = schoolName;
  db.settings.production_mode = true;
  saveDb(db);
  setupRateLimiter.reset(ip);

  const session = createAuthSession(adminUser.id);
  res.setHeader(
    'Set-Cookie',
    buildSessionCookieHeader({
      cookieName: SESSION_COOKIE,
      token: session.token,
      maxAgeSec: 24 * 3600,
      isHttps: isRequestHttps(req),
    })
  );
  res.json({ ok: true, token: session.token, user: sanitizeUser(adminUser), school_name: schoolName });
});

app.get('/api/auth/me', (req, res) => {
  const db = loadDb();
  const auth = resolveAuthenticatedUser(req);
  res.json({
    authenticated: Boolean(auth),
    needs_setup: !hasActiveAdminUser(db.users),
    user: auth?.user ?? null,
    school_name: db.settings.school_name,
    production_mode: Boolean(db.settings.production_mode),
  });
});

app.post('/api/auth/login', (req, res) => {
  const ip = req.ip || '127.0.0.1';
  const db = loadDb();
  if (!hasActiveAdminUser(db.users)) {
    res.status(403).json({ error: 'Setup awal belum selesai. Silakan buat akun Administrator utama terlebih dahulu.' });
    return;
  }

  const { email, password } = req.body ?? {};
  if (!email || !password) {
    res.status(400).json({ error: 'Email dan password wajib diisi.' });
    return;
  }

  const rl = loginRateLimiter.checkAndConsume(ip);
  if (!rl.allowed) {
    res.setHeader('Retry-After', String(rl.retryAfterSec));
    res.status(429).json({ error: 'Terlalu banyak percobaan login gagal. Coba lagi dalam 15 menit.' });
    return;
  }

  const user = db.users.find((u) => u.email.toLowerCase() === String(email).trim().toLowerCase());
  if (!user || !user.is_active || !verifyPassword(String(password), user.password_hash)) {
    res.status(401).json({ error: 'Email atau password salah, atau akun tidak aktif.' });
    return;
  }

  loginRateLimiter.reset(ip);
  const session = createAuthSession(user.id);
  res.setHeader(
    'Set-Cookie',
    buildSessionCookieHeader({
      cookieName: SESSION_COOKIE,
      token: session.token,
      maxAgeSec: 24 * 3600,
      isHttps: isRequestHttps(req),
    })
  );
  res.json({ ok: true, token: session.token, user: sanitizeUser(user) });
});

app.post('/api/auth/logout', (req, res) => {
  const token = extractSessionToken(req);
  deleteAuthSession(token);
  res.setHeader(
    'Set-Cookie',
    buildSessionCookieHeader({
      cookieName: SESSION_COOKIE,
      token: '',
      maxAgeSec: 0,
      isHttps: isRequestHttps(req),
    })
  );
  res.json({ ok: true });
});

app.post('/api/auth/change-password', requireAuth(), (req, res) => {
  const authUser = (req as express.Request & { authUser?: User }).authUser!;
  const { oldPassword, newPassword } = req.body ?? {};
  const pwdCheck = isStrongSetupPassword(newPassword);
  if (!oldPassword || !pwdCheck.valid) {
    res.status(400).json({ error: pwdCheck.reason || 'Password baru minimal 8 karakter.' });
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
    production_mode: Boolean(db.settings.production_mode),
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

app.get('/api/bootstrap', requireAuth(), (req, res) => {
  const db = loadDb();
  const etag = `W/"db-v${getDbVersion()}"`;
  res.setHeader('ETag', etag);
  res.setHeader('Cache-Control', 'no-cache');
  if (req.headers['if-none-match'] === etag) {
    res.status(304).end();
    return;
  }
  const lite = stripEmbeddingsForBootstrap(db);
  res.json({
    ...lite,
    users: lite.users.map(sanitizeUser),
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
  if (photoDataUrl) {
    const pyCall = await callFaceServiceWithStatus<{ quality_score: number; embedding: number[] }>('/enroll', {
      photoDataUrl,
    });
    if (!pyCall.reachable) {
      res.status(503).json({
        error: 'Engine AI Wajah Docker (InsightFace) sedang offline. Jalankan "npm run setup:school" atau aktifkan docker-compose.face.yml.',
      });
      return;
    }
    if (!pyCall.ok) {
      res.status(pyCall.status >= 400 && pyCall.status < 500 ? pyCall.status : 422).json({ error: pyCall.error });
      return;
    }
    qScore = pyCall.data.quality_score;
    emb = pyCall.data.embedding;
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

  const nowStr = getJakartaNowParts().dateTimeStr;
  st.embedding = emb;
  st.embedding_quality_score = qScore;
  st.embedding_updated_at = nowStr;
  if (photoDataUrl) {
    const compactPath = persistCompactPhotoDataUrl(String(photoDataUrl), `stu_${st.id}_profile`);
    if (compactPath) {
      if (st.foto_ref && st.foto_ref !== compactPath) {
        removeSnapshotIfLocal(st.foto_ref);
      }
      st.foto_ref = compactPath;
    }
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
  const nowStr = getJakartaNowParts().dateTimeStr;

  for (const item of entries) {
    const stem = path.basename(item.filename, path.extname(item.filename)).split('_')[0].trim();
    const st = db.students.find((s) => s.nisn === stem || s.nis === stem);
    if (!st) {
      failed.push({ file: item.filename, error: `NISN/NIS ${stem} tidak ditemukan di database.` });
      continue;
    }

    let aiRes: { quality_score: number; embedding: number[] } | null = null;
    if (item.photoDataUrl) {
      const pyCall = await callFaceServiceWithStatus<{ quality_score: number; embedding: number[] }>('/enroll', {
        photoDataUrl: item.photoDataUrl,
      });
      if (!pyCall.reachable) {
        failed.push({
          file: item.filename,
          error: 'Engine AI Wajah Docker (InsightFace) sedang offline. Jalankan "npm run setup:school" atau aktifkan docker-compose.face.yml.',
        });
        continue;
      }
      if (!pyCall.ok) {
        failed.push({ file: item.filename, error: pyCall.error });
        continue;
      }
      aiRes = pyCall.data;
    }

    const qScore =
      aiRes?.quality_score ??
      computeQualityScore({ confidence: 0.91, faceSizePx: 195, sharpnessNorm: 0.86, frontalScore: 0.89 }, db.settings);
    st.embedding = aiRes?.embedding ?? deterministicVecFromSeed(`${st.nisn}:${item.filename}`);
    st.embedding_quality_score = qScore;
    st.embedding_updated_at = nowStr;
    if (item.photoDataUrl) {
      const compactPath = persistCompactPhotoDataUrl(String(item.photoDataUrl), `stu_${st.id}_profile`);
      if (compactPath) {
        if (st.foto_ref && st.foto_ref !== compactPath) {
          removeSnapshotIfLocal(st.foto_ref);
        }
        st.foto_ref = compactPath;
      }
    }
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
    const pyCompare = await callFaceServiceWithStatus<{
      similarity: number;
      threshold: number;
      match: boolean;
      status: string;
    }>('/compare', { photo1DataUrl, photo2DataUrl });
    if (!pyCompare.reachable) {
      res.status(503).json({
        error: 'Engine AI Wajah Docker (InsightFace) sedang offline. Jalankan "npm run setup:school" atau aktifkan docker-compose.face.yml.',
      });
      return;
    }
    if (!pyCompare.ok) {
      res.status(pyCompare.status >= 400 && pyCompare.status < 500 ? pyCompare.status : 422).json({ error: pyCompare.error });
      return;
    }
    res.json(pyCompare.data);
    return;
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
  const nowStr = getJakartaNowParts().dateTimeStr;
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

  const jkt = getJakartaNowParts();
  const todayStr = jkt.dateStr;
  const timeNow = simulatedTime ? String(simulatedTime) : jkt.timeStr;
  const dayIso = jkt.dayIso;
  const nowStr = `${todayStr} ${timeNow}`;

  const qScore = computeQualityScore(
    { confidence: Number(confidence), faceSizePx: Number(faceSizePx), sharpnessNorm: 0.89, frontalScore: 0.92 },
    db.settings
  );
  const qualityCheck = passesSnapshotQualityThreshold(qScore, db.settings.min_snapshot_quality);
  if (!qualityCheck.passed) {
    res.status(200).json({
      ignored: true,
      quality_score: qScore,
      reason: `Kualitas wajah ${(qScore * 100).toFixed(1)}% < minimal ${Math.round(qualityCheck.threshold * 100)}% (hanya mengambil gambar >= ${Math.round(qualityCheck.threshold * 100)}%).`,
    });
    return;
  }

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

  if (!evalRes.deduplicated) {
    broadcastWs({
      event: 'attendance_updated',
      camera_id: cam.id,
      student_id: student.id,
      tipe: evalRes.logType,
      status: evalRes.logStatus,
      timestamp: timeNow,
    });
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

// Internal Python Face Service Hooks (Loopback / X-Internal-Token)
app.get('/api/internal/cameras', requireInternalAccess(), (_req, res) => {
  const db = loadDb();
  res.json({ cameras: db.cameras });
});

app.get('/api/internal/gallery', requireInternalAccess(), (_req, res) => {
  const db = loadDb();
  const students = db.students
    .filter((s) => Array.isArray(s.embedding) && s.embedding.length > 0 && s.status !== 'LULUS')
    .map((s) => ({ id: s.id, embedding: s.embedding }));
  res.json({ students, settings: db.settings });
});

function updateCameraHeartbeat(cameraId: number, online: boolean, error: string | null): void {
  const db = loadDb();
  const cam = db.cameras.find((c) => c.id === Number(cameraId));
  if (!cam) return;

  const prevOnline = cam.status === 'ONLINE';
  const prevError = cam.last_error ?? null;
  const nextError = error ? String(error) : null;
  cam.status = online ? 'ONLINE' : 'OFFLINE';
  cam.last_error = nextError;
  if (online) {
    cam.last_online_at = getJakartaNowParts().dateTimeStr;
  }

  const nowMs = Date.now();
  const lastPersist = lastCameraDbPersistMs.get(cam.id) ?? 0;
  const statusChanged = prevOnline !== online || prevError !== nextError;
  // Hanya tulis ke SQLite saat status/error berubah atau minimal setiap 120 detik agar tidak memicu penumpukan WAL
  if (statusChanged || nowMs - lastPersist >= 120_000) {
    lastCameraDbPersistMs.set(cam.id, nowMs);
    saveDb(db);
  }
  if (statusChanged) {
    broadcastWs({ event: 'camera_heartbeat', camera_id: cam.id, online, error: cam.last_error });
  }
}

app.post('/api/internal/cameras/:id/heartbeat', requireInternalAccess(), (req, res) => {
  const camId = Number(req.params.id);
  const body = req.body ?? {};
  const online = Boolean(body.online);
  const errStr = body.error ? String(body.error) : null;
  updateCameraHeartbeat(camId, online, errStr);
  updatePythonCameraTelemetry(camId, {
    connected: online,
    last_error: errStr,
    ...(typeof body.fps === 'number' ? { fps: body.fps } : {}),
    ...(typeof body.frames_decoded === 'number' ? { frames_decoded: body.frames_decoded } : {}),
    ...(typeof body.raw_faces_seen === 'number' ? { raw_faces_seen: body.raw_faces_seen } : {}),
    ...(typeof body.dropped_filter === 'number' ? { dropped_filter: body.dropped_filter } : {}),
    ...(typeof body.faces_detected_total === 'number' ? { faces_detected_total: body.faces_detected_total } : {}),
    ...(typeof body.matched_dispatched === 'number' ? { matched_dispatched: body.matched_dispatched } : {}),
    ...(typeof body.anonymous_dispatched === 'number' ? { anonymous_dispatched: body.anonymous_dispatched } : {}),
    ...(typeof body.watchdog_restarts === 'number' ? { watchdog_restarts: body.watchdog_restarts } : {}),
    ...(body.last_frame_at !== undefined ? { last_frame_at: body.last_frame_at } : {}),
    ...(body.last_face_at !== undefined ? { last_face_at: body.last_face_at } : {}),
    ...(body.last_detect_at !== undefined ? { last_detect_at: body.last_detect_at } : {}),
  });
  res.json({ ok: true });
});

app.post('/api/internal/detection-stats', requireInternalAccess(), (req, res) => {
  const b = req.body ?? {};
  const camId = Number(b.camera_id);
  if (!Number.isFinite(camId) || camId <= 0) {
    res.status(400).json({ error: 'camera_id tidak valid.' });
    return;
  }
  const nowStr = getJakartaNowParts().dateTimeStr;
  recordDetectionStatsWindow({
    camera_id: camId,
    window_start: String(b.window_start || nowStr),
    window_end: String(b.window_end || nowStr),
    total_raw: Number(b.total_raw || 0),
    dropped_confidence: Number(b.dropped_confidence || 0),
    dropped_landmark: Number(b.dropped_landmark || 0),
    dropped_size: Number(b.dropped_size || 0),
    dropped_blur: Number(b.dropped_blur || 0),
    dropped_pose: Number(b.dropped_pose || 0),
    passed_embedding: Number(b.passed_embedding || 0),
  });
  res.json({ ok: true });
});

function processFaceEvent(payload: {
  camera_id: number;
  student_id?: number | null;
  similarity?: number;
  confidence?: number;
  quality_score?: number;
  embedding?: number[];
  snapshot_rel_path?: string;
}): { statusCode: number; body: Record<string, unknown> } {
  const db = loadDb();
  const { camera_id, student_id, similarity = 0, confidence = 0.9, quality_score = 0.7, embedding, snapshot_rel_path } = payload;
  const cam = db.cameras.find((c) => c.id === Number(camera_id));
  if (!cam) {
    removeSnapshotIfLocal(snapshot_rel_path);
    return { statusCode: 404, body: { error: 'Kamera tidak ditemukan.' } };
  }
  const qualityCheck = passesSnapshotQualityThreshold(Number(quality_score), db.settings.min_snapshot_quality);
  if (!qualityCheck.passed) {
    removeSnapshotIfLocal(snapshot_rel_path);
    if (process.env.VERBOSE_FACE_LOGS === '1' || serverLogThrottle.shouldLog(`quality:${cam.id}`)) {
      console.log(
        `[QUALITY][Cam #${cam.id}] Snapshot diabaikan: skor ${(qualityCheck.score * 100).toFixed(1)}% < batas minimal ${Math.round(qualityCheck.threshold * 100)}%`
      );
    }
    return {
      statusCode: 200,
      body: {
        ok: true,
        skipped: true,
        quality_score: qualityCheck.score,
        min_snapshot_quality: qualityCheck.threshold,
        reason: `Kualitas gambar ${(qualityCheck.score * 100).toFixed(1)}% di bawah batas minimal ${Math.round(qualityCheck.threshold * 100)}%.`,
      },
    };
  }
  const gate = db.gates.find((g) => g.id === cam.gate_id);
  const jkt = getJakartaNowParts();
  const todayStr = jkt.dateStr;
  const timeNow = jkt.timeStr;
  const nowStr = jkt.dateTimeStr;
  const dayIso = jkt.dayIso;

  if (!student_id) {
    let bestCluster = null as (typeof db.anonymous_clusters)[number] | null;
    let bestClusterSim = -1;
    let topClusterAnySim = 0;
    let clusterDimMismatch = 0;
    if (Array.isArray(embedding) && embedding.length > 0) {
      const clusterIdx = getCachedClusterFaceIndex(db.anonymous_clusters);
      const clusterMatch = findBestFaceMatch(clusterIdx, embedding, db.settings.threshold_clustering);
      topClusterAnySim = clusterMatch.topAnySimilarity;
      clusterDimMismatch = clusterMatch.dimMismatchCount;
      if (clusterMatch.bestId !== null) {
        bestCluster = db.anonymous_clusters.find((c) => c.id === clusterMatch.bestId) ?? null;
        bestClusterSim = clusterMatch.bestSimilarity;
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
        bestCluster.best_quality_score = Number(quality_score);
        if (snapshot_rel_path) bestCluster.best_snapshot_path = String(snapshot_rel_path);
        if (Array.isArray(embedding)) bestCluster.best_embedding = embedding;
      }
      const incomingSnap = String(snapshot_rel_path || '');
      if (incomingSnap) {
        const hitRes = appendClusterHitSnapshot(
          bestCluster.hit_snapshots,
          {
            snapshot_path: incomingSnap,
            quality_score: Number(quality_score),
            similarity: Math.round(Math.max(0, bestClusterSim) * 10000) / 10000,
            camera_id: cam.id,
            detected_at: nowStr,
            embedding: Array.isArray(embedding) ? roundEmbeddingForJson(embedding) : undefined,
          },
          bestCluster.best_snapshot_path,
          CLUSTER_MAX_HITS
        );
        bestCluster.hit_snapshots = hitRes.hits;
        for (const droppedPath of hitRes.removedPaths) {
          removeSnapshotIfLocal(droppedPath);
        }
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
        console.log(
          `[CLUSTER][Cam #${cam.id}] PROMOTED READY cluster=#${bestCluster.id} hits=${bestCluster.hit_count} days=${bestCluster.distinct_days}`
        );
        broadcastWs({ event: 'anonymous_cluster_ready', cluster_id: bestCluster.id, camera_id: cam.id });
      } else {
        console.log(
          `[CLUSTER][Cam #${cam.id}] HIT cluster=#${bestCluster.id} hits=${bestCluster.hit_count}/${db.settings.cluster_ready_hits} sim=${bestClusterSim.toFixed(3)} status=${bestCluster.status}`
        );
      }
    } else if (Array.isArray(embedding) && embedding.length > 0) {
      const initSnap = String(snapshot_rel_path || '/src/assets/images/student_portrait_four_1794810215936.jpg');
      bestCluster = {
        id: nextId(db.anonymous_clusters),
        centroid: embedding,
        hit_count: 1,
        distinct_days: 1,
        first_seen: nowStr,
        last_seen: nowStr,
        best_snapshot_path: initSnap,
        best_quality_score: Number(quality_score),
        best_embedding: embedding,
        hit_snapshots: [
          {
            snapshot_path: initSnap,
            quality_score: Number(quality_score),
            similarity: 1,
            camera_id: cam.id,
            detected_at: nowStr,
            embedding: roundEmbeddingForJson(embedding),
          },
        ],
        status: 'PENDING',
        named_student_id: null,
        last_camera_id: cam.id,
      };
      db.anonymous_clusters.unshift(bestCluster);
      console.log(
        `[CLUSTER][Cam #${cam.id}] NEW cluster=#${bestCluster.id} dims=${embedding.length} q=${Number(quality_score).toFixed(3)} bestExistingSim=${topClusterAnySim.toFixed(3)} thresh=${db.settings.threshold_clustering} dimSkippedClusters=${clusterDimMismatch}`
      );
    } else {
      console.warn(`[CLUSTER][Cam #${cam.id}] Event anonim diabaikan: embedding kosong`);
    }

    saveDb(db);
    broadcastWs({
      event: 'face_detected',
      camera_id: cam.id,
      anonymous: true,
      cluster_id: bestCluster?.id ?? null,
      hit_count: bestCluster?.hit_count ?? 1,
      message: `Wajah anonim #${bestCluster?.id ?? ''} terdeteksi (${bestCluster?.hit_count ?? 1}/${db.settings.cluster_ready_hits} hit).`,
      timestamp: timeNow,
    });
    return { statusCode: 200, body: { ok: true, anonymous: true, cluster_id: bestCluster?.id ?? null } };
  }

  const student = db.students.find((s) => s.id === Number(student_id));
  if (!student) {
    removeSnapshotIfLocal(snapshot_rel_path);
    return { statusCode: 404, body: { error: 'Siswa tidak ditemukan.' } };
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
      snapshot_path: evalRes.logType !== 'OBSERVASI' && snapshot_rel_path ? String(snapshot_rel_path) : null,
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
  console.log(
    `[ATTENDANCE][Cam #${cam.id}] student=#${student.id} (${student.nama}) type=${evalRes.logType} status=${evalRes.logStatus} dedup=${evalRes.deduplicated} timeWIB=${timeNow}`
  );

  let embeddingUpdated = false;
  let keptForMaintenance = false;
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
    keptForMaintenance = resMaint.keptSnapshot;
  }
  if ((evalRes.deduplicated || evalRes.logType === 'OBSERVASI') && !keptForMaintenance) {
    if (snapshot_rel_path && snapshot_rel_path !== student.foto_ref) {
      removeSnapshotIfLocal(snapshot_rel_path);
    }
  }

  if (db.attendance_logs.length > 3200 || db.notifications.length > 550) {
    const trimmed = pruneInMemoryLogs({
      attendance_logs: db.attendance_logs,
      wa_queue: db.wa_queue,
      notifications: db.notifications,
      guest_access_logs: db.guest_access_logs,
    });
    db.attendance_logs = trimmed.attendance_logs;
    db.wa_queue = trimmed.wa_queue;
    db.notifications = trimmed.notifications;
    db.guest_access_logs = trimmed.guest_access_logs;
  }

  saveDb(db);
  if (embeddingUpdated) {
    triggerPythonCameraReload();
  }
  if (!evalRes.deduplicated) {
    broadcastWs({
      event: 'attendance_updated',
      camera_id: cam.id,
      student_id: student.id,
      tipe: evalRes.logType,
      status: evalRes.logStatus,
      timestamp: timeNow,
    });
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
  return { statusCode: 200, body: { ok: true, deduplicated: evalRes.deduplicated, embeddingUpdated } };
}

app.post('/api/internal/face-event', requireInternalAccess(), (req, res) => {
  const result = processFaceEvent(req.body ?? {});
  res.status(result.statusCode).json(result.body);
});

app.post('/api/cameras', requireAuth(['ADMIN']), (req, res) => {
  const db = loadDb();
  const {
    nama_kamera,
    gate_id,
    rtsp_url,
    resolusi = '1920x1080',
    fps = 5,
    aktif = true,
    min_face_size = null,
    max_face_size = null,
    capture_max_width = null,
  } = req.body;
  const rtspCheck = validateRtspStreamUrl(rtsp_url, { allowDummy: true });
  if (!rtspCheck.valid) {
    res.status(400).json({ error: rtspCheck.reason || 'URL RTSP kamera tidak valid.' });
    return;
  }
  const parsedRes = parseResolutionDimensions(String(resolusi));
  const normResolusi = formatManualResolution(parsedRes.width, parsedRes.height);
  const isDummy = !rtspCheck.url || rtspCheck.url.startsWith('dummy://');
  const resolvedMinFace =
    min_face_size !== null && min_face_size !== undefined && min_face_size !== ''
      ? normalizeMinFaceSize(min_face_size)
      : null;
  const resolvedMaxFace =
    max_face_size !== null && max_face_size !== undefined && max_face_size !== ''
      ? normalizeMaxFaceSize(max_face_size, resolvedMinFace ?? db.settings.min_face_size)
      : null;
  const cam = {
    id: nextId(db.cameras),
    nama_kamera: String(nama_kamera || '').trim() || 'Kamera Gerbang',
    gate_id: Number(gate_id),
    rtsp_url: rtspCheck.url,
    resolusi: normResolusi,
    fps: Math.max(1, Math.min(30, Math.round(Number(fps) || 5))),
    aktif: Boolean(aktif),
    status: (isDummy || !aktif ? 'OFFLINE' : 'ONLINE') as 'ONLINE' | 'OFFLINE',
    last_error: isDummy ? 'Dummy / URL RTSP belum dikonfigurasi' : null,
    last_online_at: isDummy ? null : getJakartaNowParts().dateTimeStr,
    min_face_size: resolvedMinFace,
    max_face_size: resolvedMaxFace,
    capture_max_width: capture_max_width !== null && capture_max_width !== undefined && capture_max_width !== ''
      ? normalizeCaptureMaxWidth(capture_max_width)
      : null,
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
  const rawUrl = String(req.body?.rtsp_url || cam?.rtsp_url || '').trim();
  const urlCheck = validateRtspStreamUrl(rawUrl, { allowDummy: false });

  if (!urlCheck.valid) {
    res.status(400).json({ error: urlCheck.reason || 'URL harus diawali rtsp:// atau rtsps:// (bukan dummy://).' });
    return;
  }
  const targetUrl = urlCheck.url;

  const initialRes = resolveFfmpegDetails();
  let activeRes = initialRes;

  const runCapture = (binPath: string, timeoutFlag: '-stimeout' | '-rw_timeout') =>
    execFileAsync(
      binPath,
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

  const probeWithBinary = async (binPath: string) => {
    try {
      return await runCapture(binPath, '-stimeout');
    } catch (firstErr) {
      const errStderr = (firstErr as { stderr?: Buffer | string })?.stderr?.toString() || '';
      if (/Option stimeout not found/i.test(errStderr)) {
        return await runCapture(binPath, '-rw_timeout');
      }
      throw firstErr;
    }
  };

  const startedAt = Date.now();
  try {
    let frameRes;
    try {
      frameRes = await probeWithBinary(activeRes.binary);
    } catch (primaryErr) {
      const primaryCode = (primaryErr as NodeJS.ErrnoException)?.code;
      const primaryMsg = primaryErr instanceof Error ? primaryErr.message : '';
      if (primaryCode === 'EACCES' || primaryCode === 'ENOENT' || /\b(EACCES|ENOENT)\b/i.test(primaryMsg)) {
        const fallbackRes = resolveFfmpegDetails(new Set([activeRes.binary]));
        if (fallbackRes.foundExecutable && fallbackRes.binary !== activeRes.binary) {
          activeRes = fallbackRes;
          frameRes = await probeWithBinary(fallbackRes.binary);
        } else {
          throw primaryErr;
        }
      } else {
        throw primaryErr;
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
    const nowStr = getJakartaNowParts().dateTimeStr;

    if (cam) {
      cam.status = 'ONLINE';
      cam.last_error = null;
      cam.last_online_at = nowStr;
      if ((!cam.resolusi || cam.resolusi === '-') && meta.resolusi !== '-') {
        cam.resolusi = meta.resolusi;
      }
      if (meta.fps > 0 && !cam.fps) cam.fps = Math.round(meta.fps);
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
    const diagnosedMsg = diagnoseFfmpegError(rawMsg, activeRes);
    const safeMsg = maskRtspCredentials(diagnosedMsg).slice(0, 220);
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

app.get('/api/cameras/preview-stream', requireAuth(['ADMIN']), (req, res) => {
  const db = loadDb();
  const cameraId = req.query?.camera_id ? Number(req.query.camera_id) : null;
  const cam = cameraId ? db.cameras.find((c) => c.id === cameraId) : null;
  const rawUrl = String(req.query?.rtsp_url || cam?.rtsp_url || '').trim();
  const urlCheck = validateRtspStreamUrl(rawUrl, { allowDummy: false });
  const fpsMode = String(req.query?.fps_mode || '5').trim() === 'native' ? 'native' : '5';
  const maxWidth = req.query?.max_width ? Number(req.query.max_width) : 1280;

  if (!urlCheck.valid) {
    res.status(400).json({ error: urlCheck.reason || 'URL harus diawali rtsp:// atau rtsps:// (bukan dummy://).' });
    return;
  }
  const targetUrl = urlCheck.url;

  const boundary = 'ffmpegframe';
  res.writeHead(200, {
    'Content-Type': `multipart/x-mixed-replace; boundary=${boundary}`,
    'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
    Pragma: 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  let closed = false;
  let activeChild: ReturnType<typeof spawn> | null = null;
  const blockedBins = new Set<string>();
  let timeoutFlag: '-stimeout' | '-rw_timeout' = '-stimeout';

  const cleanup = () => {
    closed = true;
    if (activeChild && !activeChild.killed) {
      try {
        activeChild.kill('SIGTERM');
      } catch {
        // ignore kill error
      }
      const killTimer = setTimeout(() => {
        if (activeChild && !activeChild.killed) {
          try {
            activeChild.kill('SIGKILL');
          } catch {
            // ignore force kill
          }
        }
      }, 800);
      killTimer.unref();
    }
  };

  req.on('close', cleanup);
  res.on('close', cleanup);

  const launchPreview = () => {
    if (closed) return;
    const resolution = resolveFfmpegDetails(blockedBins.size > 0 ? blockedBins : undefined);
    const { args } = buildFfmpegLivePreviewArgs({
      url: targetUrl,
      fpsMode,
      timeoutFlag,
      maxWidth,
    });

    const child = spawn(resolution.binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    activeChild = child;
    let remainder: Uint8Array = new Uint8Array(0);
    let stderrTail = '';
    let gotAnyFrame = false;

    child.stdout?.on('data', (chunk: Buffer) => {
      if (closed) return;
      const parsed = extractJpegFramesFromChunk(remainder, chunk);
      remainder = parsed.remainder;
      for (const frame of parsed.frames) {
        if (closed) break;
        gotAnyFrame = true;
        const header = `--${boundary}\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.length}\r\n\r\n`;
        try {
          res.write(header);
          res.write(frame);
          res.write('\r\n');
        } catch {
          cleanup();
          break;
        }
      }
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString('utf8')).slice(-500);
    });

    child.on('error', (err: NodeJS.ErrnoException) => {
      if (closed) return;
      if (err.code === 'EACCES' || err.code === 'ENOENT') {
        const alt = resolveFfmpegDetails(new Set([...blockedBins, resolution.binary]));
        if (alt.foundExecutable && alt.binary !== resolution.binary) {
          blockedBins.add(resolution.binary);
          launchPreview();
          return;
        }
      }
      if (!res.writableEnded) res.end();
    });

    child.on('close', () => {
      if (closed) return;
      if (!gotAnyFrame && /Option stimeout not found/i.test(stderrTail) && timeoutFlag === '-stimeout') {
        timeoutFlag = '-rw_timeout';
        launchPreview();
        return;
      }
      if (!res.writableEnded) res.end();
    });
  };

  launchPreview();
});

app.put('/api/cameras/:id', requireAuth(['ADMIN']), (req, res) => {
  const db = loadDb();
  const cam = db.cameras.find((c) => c.id === Number(req.params.id));
  if (!cam) {
    res.status(404).json({ error: 'Kamera tidak ditemukan.' });
    return;
  }
  let nextResolusi = cam.resolusi;
  if (req.body.resolusi !== undefined && String(req.body.resolusi).trim() !== '') {
    const parsedRes = parseResolutionDimensions(String(req.body.resolusi));
    nextResolusi = formatManualResolution(parsedRes.width, parsedRes.height);
  }
  let nextMinFace = cam.min_face_size ?? null;
  if (req.body.min_face_size !== undefined) {
    nextMinFace =
      req.body.min_face_size === null || req.body.min_face_size === ''
        ? null
        : normalizeMinFaceSize(req.body.min_face_size);
  }
  let nextMaxFace = cam.max_face_size ?? null;
  if (req.body.max_face_size !== undefined) {
    nextMaxFace =
      req.body.max_face_size === null || req.body.max_face_size === ''
        ? null
        : normalizeMaxFaceSize(req.body.max_face_size, nextMinFace ?? db.settings.min_face_size);
  } else if (nextMaxFace !== null && nextMaxFace > 0) {
    nextMaxFace = normalizeMaxFaceSize(nextMaxFace, nextMinFace ?? db.settings.min_face_size);
  }
  let nextCapWidth = cam.capture_max_width ?? null;
  if (req.body.capture_max_width !== undefined) {
    nextCapWidth =
      req.body.capture_max_width === null || req.body.capture_max_width === ''
        ? null
        : normalizeCaptureMaxWidth(req.body.capture_max_width);
  }
  let nextRtspUrl = cam.rtsp_url;
  if (req.body.rtsp_url !== undefined) {
    const rtspCheck = validateRtspStreamUrl(req.body.rtsp_url, { allowDummy: true });
    if (!rtspCheck.valid) {
      res.status(400).json({ error: rtspCheck.reason || 'URL RTSP kamera tidak valid.' });
      return;
    }
    nextRtspUrl = rtspCheck.url;
  }
  Object.assign(cam, {
    nama_kamera: req.body.nama_kamera !== undefined ? String(req.body.nama_kamera).trim() || cam.nama_kamera : cam.nama_kamera,
    gate_id: req.body.gate_id !== undefined ? Number(req.body.gate_id) || cam.gate_id : cam.gate_id,
    rtsp_url: nextRtspUrl,
    resolusi: nextResolusi,
    fps: req.body.fps !== undefined ? Math.max(1, Math.min(30, Math.round(Number(req.body.fps) || cam.fps))) : cam.fps,
    aktif: req.body.aktif !== undefined ? Boolean(req.body.aktif) : cam.aktif,
    min_face_size: nextMinFace,
    max_face_size: nextMaxFace,
    capture_max_width: nextCapWidth,
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
function cleanupClusterSnapshotsExcept(
  cluster: { best_snapshot_path: string; hit_snapshots?: Array<{ snapshot_path: string }> },
  keepPath: string | null
): void {
  const candidates = new Set<string>();
  if (cluster.best_snapshot_path) candidates.add(cluster.best_snapshot_path);
  for (const hs of cluster.hit_snapshots ?? []) {
    if (hs.snapshot_path) candidates.add(hs.snapshot_path);
  }
  for (const p of candidates) {
    if (keepPath && p === keepPath) continue;
    removeSnapshotIfLocal(p);
  }
}

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
  student.embedding_updated_at = getJakartaNowParts().dateTimeStr;
  if (!student.foto_ref || cluster.best_quality_score >= student.embedding_quality_score) {
    student.foto_ref = cluster.best_snapshot_path;
  }
  cleanupClusterSnapshotsExcept(cluster, student.foto_ref);
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
    embedding_updated_at: getJakartaNowParts().dateTimeStr,
    foto_ref: cluster.best_snapshot_path,
    wa_ortu: String(wa_ortu),
    created_at: new Date().toISOString(),
  };
  db.students.push(student);
  cleanupClusterSnapshotsExcept(cluster, student.foto_ref);
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
  cleanupClusterSnapshotsExcept(cluster, cluster.best_snapshot_path);
  db.anonymous_clusters = db.anonymous_clusters.filter((c) => c.id !== cid);
  saveDb(db);
  res.json({ ok: true });
});

app.delete('/api/clusters/:id', requireAuth(['ADMIN', 'BK']), (req, res) => {
  const db = loadDb();
  const cid = Number(req.params.id);
  const cluster = db.anonymous_clusters.find((c) => c.id === cid);
  if (!cluster) {
    res.status(404).json({ error: 'Cluster tidak ditemukan.' });
    return;
  }
  cleanupClusterSnapshotsExcept(cluster, null);
  db.anonymous_clusters = db.anonymous_clusters.filter((c) => c.id !== cid);
  saveDb(db);
  res.json({ ok: true });
});

app.post('/api/clusters/:id/hits/remove', requireAuth(['ADMIN', 'BK']), (req, res) => {
  const db = loadDb();
  const cid = Number(req.params.id);
  const idx = db.anonymous_clusters.findIndex((c) => c.id === cid);
  if (idx === -1) {
    res.status(404).json({ error: 'Cluster tidak ditemukan.' });
    return;
  }
  const cluster = db.anonymous_clusters[idx];
  const snapshotPath = typeof req.body?.snapshot_path === 'string' ? req.body.snapshot_path : undefined;
  const hitIndex = typeof req.body?.hit_index === 'number' ? req.body.hit_index : undefined;

  const result = removeHitFromClusterState({
    cluster,
    snapshotPath,
    hitIndex,
    readyHits: Math.max(1, db.settings.cluster_ready_hits ?? 5),
    readyDays: Math.max(1, db.settings.cluster_ready_days ?? 1),
  });
  if (!result.found) {
    res.status(404).json({ error: 'Foto hit tidak ditemukan di cluster ini.' });
    return;
  }
  if (result.shouldRemoveFile && result.removedHit?.snapshot_path) {
    removeSnapshotIfLocal(result.removedHit.snapshot_path);
  }
  if (result.deletedCluster || !result.updatedCluster) {
    db.anonymous_clusters = db.anonymous_clusters.filter((c) => c.id !== cid);
    saveDb(db);
    res.json({ ok: true, deleted_cluster: true });
    return;
  }
  db.anonymous_clusters[idx] = result.updatedCluster;
  saveDb(db);
  res.json({ ok: true, deleted_cluster: false, cluster: result.updatedCluster });
});

app.post('/api/clusters/:id/hits/remove-batch', requireAuth(['ADMIN', 'BK']), (req, res) => {
  const db = loadDb();
  const cid = Number(req.params.id);
  const idx = db.anonymous_clusters.findIndex((c) => c.id === cid);
  if (idx === -1) {
    res.status(404).json({ error: 'Cluster tidak ditemukan.' });
    return;
  }
  const snapshotPaths = Array.isArray(req.body?.snapshot_paths)
    ? req.body.snapshot_paths.filter((p: unknown): p is string => typeof p === 'string' && p.length > 0)
    : [];
  if (snapshotPaths.length === 0) {
    res.status(400).json({ error: 'Pilih minimal 1 gambar untuk dihapus.' });
    return;
  }

  const result = removeMultipleHitsFromClusterState({
    cluster: db.anonymous_clusters[idx],
    snapshotPaths,
    readyHits: Math.max(1, db.settings.cluster_ready_hits ?? 5),
    readyDays: Math.max(1, db.settings.cluster_ready_days ?? 1),
  });
  if (result.removedHits.length === 0) {
    res.status(404).json({ error: 'Gambar yang dipilih tidak ditemukan pada cluster ini.' });
    return;
  }

  for (const fp of result.removedFilePaths) {
    removeSnapshotIfLocal(fp);
  }
  if (result.deletedCluster || !result.updatedCluster) {
    db.anonymous_clusters = db.anonymous_clusters.filter((c) => c.id !== cid);
    saveDb(db);
    res.json({ ok: true, deleted_cluster: true, removed_count: result.removedHits.length });
    return;
  }
  db.anonymous_clusters[idx] = result.updatedCluster;
  saveDb(db);
  res.json({
    ok: true,
    deleted_cluster: false,
    removed_count: result.removedHits.length,
    cluster: result.updatedCluster,
  });
});

app.post('/api/clusters/:id/hits/set-primary', requireAuth(['ADMIN', 'BK']), (req, res) => {
  const db = loadDb();
  const cid = Number(req.params.id);
  const idx = db.anonymous_clusters.findIndex((c) => c.id === cid);
  if (idx === -1) {
    res.status(404).json({ error: 'Cluster tidak ditemukan.' });
    return;
  }
  const result = promoteHitInClusterState({
    cluster: db.anonymous_clusters[idx],
    snapshotPath: typeof req.body?.snapshot_path === 'string' ? req.body.snapshot_path : undefined,
    hitIndex: typeof req.body?.hit_index === 'number' ? req.body.hit_index : undefined,
  });
  if (!result.found || !result.updatedCluster) {
    res.status(404).json({ error: 'Foto hit tidak ditemukan di cluster ini.' });
    return;
  }
  db.anonymous_clusters[idx] = result.updatedCluster;
  saveDb(db);
  res.json({ ok: true, cluster: result.updatedCluster });
});

app.post('/api/clusters/:id/hits/split', requireAuth(['ADMIN', 'BK']), (req, res) => {
  const db = loadDb();
  const cid = Number(req.params.id);
  const idx = db.anonymous_clusters.findIndex((c) => c.id === cid);
  if (idx === -1) {
    res.status(404).json({ error: 'Cluster tidak ditemukan.' });
    return;
  }
  const cluster = db.anonymous_clusters[idx];
  const hitList = Array.isArray(cluster.hit_snapshots) ? cluster.hit_snapshots : [];
  if (hitList.length <= 1) {
    res.status(400).json({ error: 'Cluster hanya memiliki 1 foto. Gunakan hapus jika ingin membuangnya.' });
    return;
  }

  const snapshotPath = typeof req.body?.snapshot_path === 'string' ? req.body.snapshot_path : undefined;
  const hitIndex = typeof req.body?.hit_index === 'number' ? req.body.hit_index : undefined;
  let targetHitIdx = snapshotPath ? hitList.findIndex((h) => h.snapshot_path === snapshotPath) : -1;
  if (targetHitIdx === -1 && typeof hitIndex === 'number' && hitIndex >= 0 && hitIndex < hitList.length) {
    targetHitIdx = hitIndex;
  }
  if (targetHitIdx === -1) {
    res.status(404).json({ error: 'Foto hit tidak ditemukan di cluster ini.' });
    return;
  }
  const targetHit = hitList[targetHitIdx];
  const hitEmbedding = Array.isArray(targetHit.embedding) && targetHit.embedding.length > 0 ? targetHit.embedding : null;
  if (!hitEmbedding) {
    res.status(400).json({
      error: 'Foto lama ini belum menyimpan vektor embedding terpisah. Gunakan tombol "Buang dari Grup" untuk menghapusnya.',
    });
    return;
  }

  const removed = removeHitFromClusterState({
    cluster,
    snapshotPath: targetHit.snapshot_path,
    hitIndex: targetHitIdx,
    readyHits: Math.max(1, db.settings.cluster_ready_hits ?? 5),
    readyDays: Math.max(1, db.settings.cluster_ready_days ?? 1),
  });
  if (!removed.found || removed.deletedCluster || !removed.updatedCluster) {
    res.status(400).json({ error: 'Gagal memisahkan foto dari grup.' });
    return;
  }
  db.anonymous_clusters[idx] = removed.updatedCluster;

  const newClusterId = nextId(db.anonymous_clusters);
  const newCluster = {
    id: newClusterId,
    centroid: hitEmbedding,
    hit_count: 1,
    distinct_days: 1,
    first_seen: targetHit.detected_at || cluster.last_seen,
    last_seen: targetHit.detected_at || cluster.last_seen,
    best_snapshot_path: targetHit.snapshot_path,
    best_quality_score: targetHit.quality_score || 0.75,
    best_embedding: hitEmbedding,
    hit_snapshots: [
      {
        snapshot_path: targetHit.snapshot_path,
        quality_score: targetHit.quality_score || 0.75,
        similarity: 1,
        camera_id: targetHit.camera_id ?? cluster.last_camera_id,
        detected_at: targetHit.detected_at || cluster.last_seen,
        embedding: hitEmbedding,
      },
    ],
    status: 'PENDING' as const,
    named_student_id: null,
    last_camera_id: targetHit.camera_id ?? cluster.last_camera_id,
  };
  db.anonymous_clusters.unshift(newCluster);
  saveDb(db);
  res.json({ ok: true, new_cluster_id: newClusterId });
});

app.post('/api/clusters/:id/merge', requireAuth(['ADMIN', 'BK']), (req, res) => {
  const db = loadDb();
  const sourceId = Number(req.params.id);
  const targetId = Number(req.body?.target_cluster_id);
  if (!sourceId || !targetId || sourceId === targetId) {
    res.status(400).json({ error: 'Pilih grup tujuan yang berbeda.' });
    return;
  }
  const source = db.anonymous_clusters.find((c) => c.id === sourceId);
  const targetIdx = db.anonymous_clusters.findIndex((c) => c.id === targetId);
  if (!source || targetIdx === -1) {
    res.status(404).json({ error: 'Cluster sumber atau tujuan tidak ditemukan.' });
    return;
  }
  const mergedRes = mergeAnonymousClustersState({
    source,
    target: db.anonymous_clusters[targetIdx],
    readyHits: Math.max(1, db.settings.cluster_ready_hits ?? 5),
    readyDays: Math.max(1, db.settings.cluster_ready_days ?? 1),
    maxHits: CLUSTER_MAX_HITS,
  });
  db.anonymous_clusters[targetIdx] = mergedRes.merged;
  db.anonymous_clusters = db.anonymous_clusters.filter((c) => c.id !== sourceId);
  for (const droppedPath of mergedRes.removedPaths) {
    removeSnapshotIfLocal(droppedPath);
  }
  saveDb(db);
  res.json({ ok: true, target_cluster_id: targetId });
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
  const nowStr = getJakartaNowParts().dateTimeStr;

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
  const nowStr = getJakartaNowParts().dateTimeStr;
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
  const nowStr = getJakartaNowParts().dateTimeStr;
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
  const validated = validateAndNormalizeScheduleTimes({
    jam_masuk_mulai: String(req.body?.jam_masuk_mulai ?? ''),
    jam_masuk_selesai: String(req.body?.jam_masuk_selesai ?? ''),
    jam_keluar_mulai: String(req.body?.jam_keluar_mulai ?? ''),
    jam_keluar_selesai: String(req.body?.jam_keluar_selesai ?? ''),
  });
  if (!validated.ok) {
    res.status(400).json({ error: validated.error });
    return;
  }
  const db = loadDb();
  db.schedules.push({
    id: nextId(db.schedules),
    jurusan_id: req.body.jurusan_id ? Number(req.body.jurusan_id) : null,
    hari: Number(req.body.hari),
    jam_masuk_mulai: validated.jam_masuk_mulai,
    jam_masuk_selesai: validated.jam_masuk_selesai,
    jam_keluar_mulai: validated.jam_keluar_mulai,
    jam_keluar_selesai: validated.jam_keluar_selesai,
    toleransi_terlambat_menit: Math.max(0, Number(req.body.toleransi_terlambat_menit ?? 5)),
  });
  saveDb(db);
  res.json({ ok: true });
});

app.put('/api/schedules/:id', requireAuth(['ADMIN', 'BK']), (req, res) => {
  const validated = validateAndNormalizeScheduleTimes({
    jam_masuk_mulai: String(req.body?.jam_masuk_mulai ?? ''),
    jam_masuk_selesai: String(req.body?.jam_masuk_selesai ?? ''),
    jam_keluar_mulai: String(req.body?.jam_keluar_mulai ?? ''),
    jam_keluar_selesai: String(req.body?.jam_keluar_selesai ?? ''),
  });
  if (!validated.ok) {
    res.status(400).json({ error: validated.error });
    return;
  }
  const db = loadDb();
  const sc = db.schedules.find((s) => s.id === Number(req.params.id));
  if (!sc) {
    res.status(404).json({ error: 'Jadwal tidak ditemukan.' });
    return;
  }
  sc.jurusan_id = req.body.jurusan_id ? Number(req.body.jurusan_id) : null;
  sc.hari = Number(req.body.hari ?? sc.hari);
  sc.jam_masuk_mulai = validated.jam_masuk_mulai;
  sc.jam_masuk_selesai = validated.jam_masuk_selesai;
  sc.jam_keluar_mulai = validated.jam_keluar_mulai;
  sc.jam_keluar_selesai = validated.jam_keluar_selesai;
  sc.toleransi_terlambat_menit = Math.max(0, Number(req.body.toleransi_terlambat_menit ?? sc.toleransi_terlambat_menit));
  saveDb(db);
  res.json({ ok: true, schedule: sc });
});

app.delete('/api/schedules/:id', requireAuth(['ADMIN', 'BK']), (req, res) => {
  const db = loadDb();
  const id = Number(req.params.id);
  const before = db.schedules.length;
  db.schedules = db.schedules.filter((s) => s.id !== id);
  if (db.schedules.length === before) {
    res.status(404).json({ error: 'Jadwal tidak ditemukan.' });
    return;
  }
  saveDb(db);
  res.json({ ok: true });
});

app.post('/api/schedules/override', requireAuth(['ADMIN', 'BK']), (req, res) => {
  const validated = validateAndNormalizeScheduleTimes({
    jam_masuk_mulai: String(req.body?.jam_masuk_mulai ?? ''),
    jam_masuk_selesai: String(req.body?.jam_masuk_selesai ?? ''),
    jam_keluar_mulai: String(req.body?.jam_keluar_mulai ?? ''),
    jam_keluar_selesai: String(req.body?.jam_keluar_selesai ?? ''),
  });
  if (!validated.ok) {
    res.status(400).json({ error: validated.error });
    return;
  }
  const db = loadDb();
  db.kelas_overrides.push({
    id: nextId(db.kelas_overrides),
    kelas_id: Number(req.body.kelas_id),
    hari: Number(req.body.hari),
    jam_masuk_mulai: validated.jam_masuk_mulai,
    jam_masuk_selesai: validated.jam_masuk_selesai,
    jam_keluar_mulai: validated.jam_keluar_mulai,
    jam_keluar_selesai: validated.jam_keluar_selesai,
    alasan: String(req.body.alasan || ''),
  });
  saveDb(db);
  res.json({ ok: true });
});

app.put('/api/schedules/override/:id', requireAuth(['ADMIN', 'BK']), (req, res) => {
  const validated = validateAndNormalizeScheduleTimes({
    jam_masuk_mulai: String(req.body?.jam_masuk_mulai ?? ''),
    jam_masuk_selesai: String(req.body?.jam_masuk_selesai ?? ''),
    jam_keluar_mulai: String(req.body?.jam_keluar_mulai ?? ''),
    jam_keluar_selesai: String(req.body?.jam_keluar_selesai ?? ''),
  });
  if (!validated.ok) {
    res.status(400).json({ error: validated.error });
    return;
  }
  const db = loadDb();
  const ov = db.kelas_overrides.find((o) => o.id === Number(req.params.id));
  if (!ov) {
    res.status(404).json({ error: 'Override jadwal kelas tidak ditemukan.' });
    return;
  }
  ov.kelas_id = Number(req.body.kelas_id ?? ov.kelas_id);
  ov.hari = Number(req.body.hari ?? ov.hari);
  ov.jam_masuk_mulai = validated.jam_masuk_mulai;
  ov.jam_masuk_selesai = validated.jam_masuk_selesai;
  ov.jam_keluar_mulai = validated.jam_keluar_mulai;
  ov.jam_keluar_selesai = validated.jam_keluar_selesai;
  ov.alasan = String(req.body.alasan ?? ov.alasan);
  saveDb(db);
  res.json({ ok: true, override: ov });
});

app.delete('/api/schedules/override/:id', requireAuth(['ADMIN', 'BK']), (req, res) => {
  const db = loadDb();
  const id = Number(req.params.id);
  db.kelas_overrides = db.kelas_overrides.filter((o) => o.id !== id);
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

app.put('/api/schedules/exception/:id', requireAuth(['ADMIN', 'BK']), (req, res) => {
  const db = loadDb();
  const ex = db.schedule_exceptions.find((x) => x.id === Number(req.params.id));
  if (!ex) {
    res.status(404).json({ error: 'Exception tanggal tidak ditemukan.' });
    return;
  }
  ex.tanggal = String(req.body.tanggal ?? ex.tanggal);
  ex.scope = req.body.scope === 'JURUSAN' ? 'JURUSAN' : 'GLOBAL';
  ex.ref_id = ex.scope === 'JURUSAN' && req.body.ref_id ? Number(req.body.ref_id) : null;
  ex.tipe = req.body.tipe ?? ex.tipe;
  ex.catatan = String(req.body.catatan ?? ex.catatan);
  ex.jam_masuk_override = req.body.jam_masuk_override || null;
  ex.jam_keluar_override = req.body.jam_keluar_override || null;
  saveDb(db);
  res.json({ ok: true, exception: ex });
});

app.delete('/api/schedules/exception/:id', requireAuth(['ADMIN', 'BK']), (req, res) => {
  const db = loadDb();
  const id = Number(req.params.id);
  db.schedule_exceptions = db.schedule_exceptions.filter((x) => x.id !== id);
  saveDb(db);
  res.json({ ok: true });
});

// Settings, Production Cutover, Storage Cleanup & Compact Rotating Backup
app.post('/api/settings', requireAuth(['ADMIN']), (req, res) => {
  const db = loadDb();
  const patch = { ...(req.body ?? {}) };
  if (patch.min_snapshot_quality !== undefined) {
    patch.min_snapshot_quality = normalizeMinSnapshotQuality(patch.min_snapshot_quality);
  }
  if (patch.min_face_size !== undefined) {
    patch.min_face_size = normalizeMinFaceSize(patch.min_face_size);
  }
  if (patch.max_face_size !== undefined) {
    patch.max_face_size = normalizeMaxFaceSize(
      patch.max_face_size,
      patch.min_face_size ?? db.settings.min_face_size
    );
  }
  if (patch.capture_max_width !== undefined) {
    patch.capture_max_width = normalizeCaptureMaxWidth(patch.capture_max_width);
  }
  if (patch.capture_jpeg_quality !== undefined) {
    patch.capture_jpeg_quality = normalizeCaptureJpegQuality(patch.capture_jpeg_quality);
  }
  db.settings = {
    ...db.settings,
    ...patch,
    ...normalizeQualityGateSettingsFields({ ...db.settings, ...patch }),
  };
  db.settings.min_snapshot_quality = normalizeMinSnapshotQuality(db.settings.min_snapshot_quality);
  db.settings.min_face_size = normalizeMinFaceSize(db.settings.min_face_size);
  db.settings.max_face_size = normalizeMaxFaceSize(db.settings.max_face_size, db.settings.min_face_size);
  db.settings.capture_max_width = normalizeCaptureMaxWidth(db.settings.capture_max_width);
  db.settings.capture_jpeg_quality = normalizeCaptureJpegQuality(db.settings.capture_jpeg_quality);
  saveDb(db);
  triggerPythonCameraReload();
  res.json({ ok: true, settings: db.settings });
});

app.post('/api/system/activate-production', requireAuth(['ADMIN']), (req, res) => {
  const { cleanDemoData = true, production_mode = true } = req.body ?? {};
  let db = loadDb();
  let removedIds: number[] = [];
  let onlyDemo = false;
  if (production_mode && cleanDemoData) {
    const beforeStudents = db.students;
    db = stripDemoRecordsForProduction(db);
    const remainingIds = new Set(db.students.map((s) => s.id));
    removedIds = beforeStudents.filter((s) => !remainingIds.has(s.id)).map((s) => s.id);
    onlyDemo = beforeStudents.length > 0 && db.students.length === 0;
  } else {
    db.settings.production_mode = Boolean(production_mode);
  }
  saveDb(db);
  if (production_mode && cleanDemoData) {
    purgeDemoRowsFromSqlite(removedIds, onlyDemo);
    invalidateDbCache();
    db = loadDb();
  }
  triggerPythonCameraReload();
  res.json({
    ok: true,
    production_mode: Boolean(db.settings.production_mode),
    remaining_students: db.students.length,
    remaining_cameras: db.cameras.length,
  });
});

function readLocalPhotoAsDataUrl(relOrData: string | null | undefined): string | null {
  if (!relOrData) return null;
  if (relOrData.startsWith('data:image/')) return relOrData;
  let diskPath: string | null = null;
  if (relOrData.startsWith('/data/snapshots/')) {
    diskPath = path.join(DATA_DIR, relOrData.replace(/^\/data\//, ''));
  } else if (relOrData.startsWith('/src/') || relOrData.startsWith('src/')) {
    diskPath = path.resolve(APP_ROOT, relOrData.replace(/^\/+/, ''));
  }
  if (!diskPath || !fs.existsSync(diskPath)) return null;
  const ext = path.extname(diskPath).toLowerCase();
  const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
  const buf = fs.readFileSync(diskPath);
  return `data:${mime};base64,${buf.toString('base64')}`;
}

app.post('/api/system/migrate-embeddings', requireAuth(['ADMIN']), async (_req, res) => {
  const db = loadDb();
  const faceHealth = await callFaceService<{ ok?: boolean }>('/health');
  const pythonOnline = Boolean(faceHealth?.ok);
  if (!pythonOnline) {
    res.status(503).json({
      error: 'Engine AI Wajah Docker (InsightFace) sedang offline. Jalankan "npm run setup:school" atau aktifkan docker-compose.face.yml sebelum menyinkronkan ke 512-D.',
    });
    return;
  }
  const expectedDims = 512;
  const nowStr = getJakartaNowParts().dateTimeStr;

  let migratedStudents = 0;
  let migratedClusters = 0;
  let skippedNoLocalPhoto = 0;
  const errors: string[] = [];

  const extractWithActiveEngine = async (dataUrl: string) =>
    callFaceService<{ quality_score: number; embedding: number[] }>('/enroll', { photoDataUrl: dataUrl });

  for (const st of db.students) {
    if (st.status === 'LULUS') continue;
    const curDims = Array.isArray(st.embedding) ? st.embedding.length : 0;
    if (curDims === expectedDims) continue;
    const dataUrl = readLocalPhotoAsDataUrl(st.foto_ref);
    if (!dataUrl) {
      skippedNoLocalPhoto += 1;
      continue;
    }
    try {
      const extracted = await extractWithActiveEngine(dataUrl);
      if (extracted?.embedding?.length === expectedDims) {
        st.embedding = extracted.embedding;
        st.embedding_quality_score = Math.max(st.embedding_quality_score || 0, extracted.quality_score);
        st.embedding_updated_at = nowStr;
        migratedStudents += 1;
      } else {
        errors.push(`Siswa #${st.id} (${st.nama}): wajah tidak terbaca pada foto_ref`);
      }
    } catch (err) {
      errors.push(`Siswa #${st.id}: ${err instanceof Error ? err.message : 'gagal ekstrak'}`);
    }
  }

  for (const cl of db.anonymous_clusters) {
    if (cl.status !== 'PENDING' && cl.status !== 'READY') continue;
    const curDims = Array.isArray(cl.centroid) ? cl.centroid.length : 0;
    if (curDims === expectedDims) continue;
    const dataUrl = readLocalPhotoAsDataUrl(cl.best_snapshot_path);
    if (!dataUrl) {
      skippedNoLocalPhoto += 1;
      continue;
    }
    try {
      const extracted = await extractWithActiveEngine(dataUrl);
      if (extracted?.embedding?.length === expectedDims) {
        cl.centroid = extracted.embedding;
        cl.best_embedding = extracted.embedding;
        cl.best_quality_score = Math.max(cl.best_quality_score || 0, extracted.quality_score);
        migratedClusters += 1;
      } else {
        errors.push(`Cluster #${cl.id}: wajah tidak terbaca pada snapshot`);
      }
    } catch (err) {
      errors.push(`Cluster #${cl.id}: ${err instanceof Error ? err.message : 'gagal ekstrak'}`);
    }
  }

  if (migratedStudents > 0 || migratedClusters > 0) {
    saveDb(db);
    triggerPythonCameraReload();
  }

  res.json({
    ok: true,
    engine: 'INSIGHTFACE_PYTHON',
    expected_dims: expectedDims,
    migrated_students: migratedStudents,
    migrated_clusters: migratedClusters,
    skipped_no_local_photo: skippedNoLocalPhoto,
    errors,
    embedding_dimensions: summarizeEmbeddingDimensions(db.students, db.anonymous_clusters),
  });
});

app.get('/api/storage/breakdown', requireAuth(['ADMIN']), (_req, res) => {
  res.json({ ok: true, breakdown: getDataStorageBreakdown() });
});

app.post('/api/storage/cleanup', requireAuth(['ADMIN']), (_req, res) => {
  const db = loadDb();
  const resCleanup = runStorageCleanup(db, { manual: true });
  res.json({
    ok: true,
    freed_mb: resCleanup.freedMb,
    freed_bytes: resCleanup.freedBytes,
    removed_logs: resCleanup.removedLogs,
    breakdown: resCleanup.breakdown,
  });
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

// WhatsApp Gateway (Python Chromium Selenium + Round-Robin + Meta Cloud + Fonnte + WABLAS)
app.post('/api/wa/accounts', requireAuth(['ADMIN', 'BK']), async (req, res) => {
  const db = loadDb();
  const rawInput = String(req.body.phone_number || req.body.label || '').trim();
  const rawLabel = String(req.body.label || '').trim();
  const digits = rawInput.replace(/[^0-9]/g, '');
  const phoneNumber = digits.length >= 9 ? digits : rawInput || `WA Sekolah ${db.wa_accounts.length + 1}`;
  const label = rawLabel || (digits.length >= 9 ? `WA ${digits}` : phoneNumber);
  const provider = normalizeWaProvider(db.settings.wa_provider);

  const acc = {
    id: nextId(db.wa_accounts),
    provider,
    label,
    phone_number: phoneNumber,
    api_key: '',
    status: 'WARMUP' as const,
    daily_count: 0,
    hourly_count: 0,
    last_reset_at: getJakartaNowParts().dateTimeStr,
    created_at: new Date().toISOString(),
    qr_connected: false,
    gateway_account_id: null as number | null,
    last_error: null as string | null,
  };
  db.wa_accounts.push(acc);
  saveDb(db);

  if (provider === 'WA_WEB') {
    await ensureGatewayAccountForDbAccount(acc.id);
  }
  const latest = loadDb().wa_accounts.find((a) => a.id === acc.id) ?? acc;
  res.json({ ok: true, account: latest });
});

app.post('/api/wa/accounts/:id/pair', requireAuth(['ADMIN', 'BK']), async (req, res) => {
  const id = Number(req.params.id);
  const state = await startGatewayPairing(id, broadcastWs);
  res.json({ ok: state.status !== 'ERROR', ...state });
});

app.get('/api/wa/accounts/:id/qr', requireAuth(['ADMIN', 'BK']), async (req, res) => {
  const id = Number(req.params.id);
  const state = await getGatewayQrState(id, broadcastWs);
  res.json({ ok: state.status !== 'ERROR', ...state });
});

app.post('/api/wa/accounts/:id/reconnect', requireAuth(['ADMIN', 'BK']), async (req, res) => {
  const id = Number(req.params.id);
  const state = await reconnectGatewayAccount(id, broadcastWs);
  res.json({ ok: state.status !== 'ERROR', ...state });
});

app.post('/api/wa/accounts/:id/status', requireAuth(['ADMIN', 'BK']), async (req, res) => {
  const id = Number(req.params.id);
  const rawStatus = String(req.body.status || '').toUpperCase();
  if (!['ACTIVE', 'WARMUP', 'PAUSED', 'BANNED'].includes(rawStatus)) {
    res.status(400).json({ error: 'Status akun tidak valid.' });
    return;
  }
  const ok = await syncGatewayAccountStatus(id, rawStatus as 'ACTIVE' | 'WARMUP' | 'PAUSED' | 'BANNED');
  if (!ok) {
    res.status(404).json({ error: 'Akun tidak ditemukan.' });
    return;
  }
  const updated = loadDb().wa_accounts.find((a) => a.id === id);
  res.json({ ok: true, account: updated });
});

app.delete('/api/wa/accounts/:id', requireAuth(['ADMIN', 'BK']), async (req, res) => {
  const id = Number(req.params.id);
  const ok = await deleteGatewayAccount(id);
  if (!ok) {
    res.status(404).json({ error: 'Akun tidak ditemukan.' });
    return;
  }
  res.json({ ok: true, deleted_id: id });
});

app.post('/api/wa/accounts/:id/connect', requireAuth(['ADMIN', 'BK']), (req, res) => {
  const db = loadDb();
  const acc = db.wa_accounts.find((a) => a.id === Number(req.params.id));
  if (!acc) {
    res.status(404).json({ error: 'Akun tidak ditemukan.' });
    return;
  }
  acc.qr_connected = true;
  acc.last_error = null;
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
  const waJkt = getJakartaNowParts();
  const activeTpls = db.wa_templates.filter((t) => t.is_active);
  const tpl = activeTpls[Math.floor(Math.random() * activeTpls.length)];
  const formatted = tpl
    ? formatWaMessage(tpl.template_text, {
        nama: 'Raka Pratama (Tes)',
        kelas: 'XI RPL 1',
        tanggal: waJkt.dateStr,
        jam_masuk: '06:55:00',
        jam_keluar: '15:10:00',
        status: 'HADIR',
      })
    : String(message);

  for (const candidateAcc of db.wa_accounts) {
    applyWaQuotaResetIfDue(candidateAcc, waJkt.dateTimeStr);
  }
  const provider = normalizeWaProvider(db.settings.wa_provider);
  const rr = selectNextWaAccountRoundRobin(db.wa_accounts, getRoundRobinCursorId(), provider === 'WA_WEB');
  let acc = rr.selected ?? undefined;
  let dispatch: { sent: boolean; simulated: boolean; statusCode?: number; error?: string };

  if (rr.orderedCandidates.length === 0) {
    dispatch = await dispatchWaMessage(
      undefined,
      provider,
      db.settings.wa_api_key,
      db.settings.wa_phone_number_id,
      String(phone),
      formatted,
      Boolean(db.settings.production_mode)
    );
  } else {
    dispatch = { sent: false, simulated: false, error: 'Tidak ada akun WA aktif yang tersedia.' };
    for (const candidate of rr.orderedCandidates) {
      acc = candidate;
      setRoundRobinCursorId(candidate.id);
      const attempt = await dispatchWaMessage(
        candidate,
        provider,
        db.settings.wa_api_key,
        db.settings.wa_phone_number_id,
        String(phone),
        formatted,
        Boolean(db.settings.production_mode)
      );
      dispatch = attempt;
      if (attempt.sent) break;
      if (attempt.statusCode === 503 || attempt.statusCode === 409) {
        candidate.qr_connected = false;
        candidate.last_error = attempt.error ?? 'Sesi terputus';
      }
      if (attempt.statusCode === 422) break;
    }
  }

  if (dispatch.sent && acc && !dispatch.simulated) {
    acc.daily_count += 1;
    acc.hourly_count += 1;
    acc.last_error = null;
  }

  db.wa_queue.unshift({
    id: nextId(db.wa_queue),
    student_id: null,
    phone: String(phone),
    payload: { nama: 'Tes Manual', kelas: '-', tanggal: waJkt.dateStr, jam_masuk: '-', jam_keluar: '-', status: 'TEST' },
    status: dispatch.sent ? 'SENT' : 'FAILED',
    retry_count: 0,
    scheduled_at: waJkt.dateTimeStr,
    sent_at: dispatch.sent ? waJkt.dateTimeStr : null,
    error_msg: dispatch.error ?? null,
  });
  saveDb(db);
  res.json({
    ok: dispatch.sent,
    simulated: dispatch.simulated,
    sender_account: acc ? acc.phone_number : null,
    error: dispatch.error ?? null,
    preview: `${formatted}${
      dispatch.error
        ? ` (${dispatch.error})`
        : dispatch.simulated
          ? ' (Simulasi preview · scan QR WhatsApp Web atau isi API Key untuk kirim live)'
          : ` (Terkirim Live${acc ? ` via ${acc.phone_number}` : ''})`
    }`,
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
  const jkt = getJakartaNowParts();
  const todayStr = jkt.dateStr;
  const timeNow = jkt.timeStr;
  const dayIso = jkt.dayIso;

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
  const normEmail = String(email).trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normEmail)) {
    res.status(400).json({ error: 'Format email user tidak valid.' });
    return;
  }
  const pwdCheck = isStrongSetupPassword(password);
  if (!pwdCheck.valid) {
    res.status(400).json({ error: pwdCheck.reason || 'Password user minimal 8 karakter dan tidak boleh lemah.' });
    return;
  }
  if (db.users.some((u) => u.email.toLowerCase() === normEmail)) {
    res.status(409).json({ error: 'Email sudah terdaftar.' });
    return;
  }
  const allowedRoles: UserRole[] = ['ADMIN', 'BK', 'GURU'];
  const cleanRole: UserRole = allowedRoles.includes(role) ? role : 'GURU';
  db.users.push({
    id: nextId(db.users),
    name: String(name).trim(),
    email: normEmail,
    role: cleanRole,
    is_active: true,
    password_hash: hashPassword(String(password)),
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

  const targetMonth = String(month || getJakartaNowParts().dateStr.slice(0, 7));
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
  const appRoot = APP_ROOT;
  const distDir = path.resolve(appRoot, 'dist');
  const distIndexPath = path.join(distDir, 'index.html');
  let distIndexExists = fs.existsSync(distIndexPath);

  const useProductionDist = shouldServeProductionBuild({
    nodeEnv: process.env.NODE_ENV,
    npmLifecycleEvent: process.env.npm_lifecycle_event,
    execArgv: process.execArgv,
    argv: process.argv,
    distIndexExists,
  });

  if (!useProductionDist) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      root: appRoot,
      server: {
        middlewareMode: true,
        ...(process.env.DISABLE_HMR === 'true' ? { hmr: false } : {}),
      },
      appType: 'spa',
    });
    app.use((req, res, next) => {
      if (
        req.method === 'GET' &&
        (req.path === '/' ||
          req.path === '/index.html' ||
          req.path.startsWith('/@vite/') ||
          req.path.startsWith('/src/') ||
          !isNonSpaResourcePath(req.path))
      ) {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
      }
      next();
    });
    app.use(vite.middlewares);
    console.log('[Absensi SMK Server] Frontend mode: DEV (Vite middleware)');
  } else {
    if (!distIndexExists && fs.existsSync(path.join(appRoot, 'index.html'))) {
      console.warn(
        `[Absensi SMK Server] File build produksi "${distIndexPath}" belum tersedia — menjalankan Vite production build otomatis...`
      );
      try {
        const { build: viteBuild } = await import('vite');
        await viteBuild({ root: appRoot, mode: 'production' });
        distIndexExists = fs.existsSync(distIndexPath);
      } catch (err) {
        console.error(
          '[Absensi SMK Server] Gagal menjalankan auto-build Vite produksi:',
          err instanceof Error ? err.message : err
        );
      }
    }

    if (!distIndexExists) {
      console.error(
        `[Absensi SMK Server] ERROR: File build produksi "${distIndexPath}" tidak ditemukan. Jalankan "npm run build" terlebih dahulu sebelum menjalankan server produksi.`
      );
      app.get('*', (_req, res) => {
        res
          .status(503)
          .type('text/html; charset=utf-8')
          .send(
            '<!doctype html><html lang="id"><body style="font-family:sans-serif;padding:2rem"><h1>Build Produksi Belum Tersedia</h1><p>Folder <code>dist/</code> belum dibuat. Jalankan <code>npm run build</code> lalu mulai ulang server.</p></body></html>'
          );
      });
    } else {
      app.use(
        express.static(distDir, {
          index: false,
          setHeaders: (res, filePath) => {
            const contentType = getStaticAssetContentType(filePath);
            if (contentType) {
              res.setHeader('Content-Type', contentType);
            }
            res.setHeader('Cache-Control', getStaticCacheControl(filePath));
            res.setHeader('X-Content-Type-Options', 'nosniff');
          },
        })
      );

      app.use((req, res, next) => {
        if (req.method === 'GET' && !isNonSpaResourcePath(req.path)) {
          next();
          return;
        }
        if (req.method === 'GET' && isNonSpaResourcePath(req.path)) {
          res.status(404).type('text/plain; charset=utf-8').send('Asset atau endpoint tidak ditemukan.');
          return;
        }
        next();
      });

      app.get('*', (_req, res) => {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.sendFile(distIndexPath);
      });
      console.log(`[Absensi SMK Server] Frontend mode: PRODUCTION (${distDir})`);
    }
  }

  // Jalankan worker antrean WA (Round-Robin), auto-spawn Python WA Gateway, scheduler harian + cleanup otomatis
  getOrCreateInternalToken({ dataDir: DATA_DIR });
  void ensureWaGatewayRunning();
  startWaQueueWorker(broadcastWs);

  const executeDailyTick = () => {
    try {
      const res = runDailyScheduleAndWaTick(false);
      if (res.queued > 0 || res.markedAlpa > 0 || res.markedNoCheckout > 0) {
        console.log(
          `[Scheduler] Auto-tick WIB: alpa=${res.markedAlpa}, tidak_keluar=${res.markedNoCheckout}, wa_antre=${res.queued}`
        );
        broadcastWs({ event: 'attendance_updated', source: 'scheduler' });
      }
    } catch (err) {
      console.error('[Scheduler] Error pada daily tick:', err instanceof Error ? err.message : err);
    }
  };
  const executeMaintenanceTick = () => {
    try {
      const db = loadDb();
      runStorageCleanup(db);
      if (db.settings.auto_backup_enabled !== false) {
        const latest = listBackups()[0];
        const ageMs = latest ? Date.now() - Date.parse(latest.created_at) : Infinity;
        if (ageMs >= 20 * 3600_000) {
          const bk = runCompactBackup(db.settings.backup_retention_count ?? 2);
          console.log(`[Backup] Auto-backup harian tersimpan: ${bk.filename} (${bk.bytes} bytes)`);
        }
      }
    } catch (err) {
      console.error('[Maintenance] Error cleanup/auto-backup:', err instanceof Error ? err.message : err);
    }
  };

  setTimeout(executeDailyTick, 5000);
  setInterval(executeDailyTick, 60_000);
  setTimeout(executeMaintenanceTick, 10_000);
  setInterval(executeMaintenanceTick, 6 * 3600_000);

  // Auto-sync galeri 5000+ siswa ke Python InsightFace saat service boot/pulih + prewarm TTS offline
  const executeAutoAiHealTick = async () => {
    try {
      const db = loadDb();
      if (panggilCooldown.size > 1000) {
        const now = Date.now();
        for (const [k, ts] of panggilCooldown.entries()) {
          if (now - ts > 600_000) panggilCooldown.delete(k);
        }
      }
      const enrolledCount = db.students.filter(
        (s) => s.status !== 'LULUS' && Array.isArray(s.embedding) && s.embedding.length > 0
      ).length;
      const pyHealth = await callFaceService<{ ok?: boolean; gallery_size?: number }>('/health');
      if (pyHealth?.ok) {
        setPythonFaceServiceOnline(true, true);
        if (enrolledCount > 0 && (pyHealth.gallery_size ?? 0) === 0) {
          await callFaceService('/cameras/reload', {});
          console.log(`[AutoSync] Memulihkan galeri ${enrolledCount} wajah ke InsightFace Python.`);
        }
        pythonGallerySynced = true;
      } else {
        setPythonFaceServiceOnline(false, false);
        pythonGallerySynced = false;
      }
    } catch {
      setPythonFaceServiceOnline(false, false);
      pythonGallerySynced = false;
    }
  };
  setTimeout(() => void executeAutoAiHealTick(), 8000);
  setInterval(() => void executeAutoAiHealTick(), 60_000);

  if (isPiperAvailable()) {
    setTimeout(() => {
      try {
        const db = loadDb();
        const names = db.students.filter((s) => s.status !== 'LULUS').map((s) => s.nickname || s.nama);
        if (names.length > 0) {
          prewarmStudentNamesTts(names.slice(0, 500));
        }
      } catch {
        // ignore prewarm failure
      }
    }, 15_000);
  }

  // Auto-update GitHub terjadwal opsional (default 60 menit = 1 jam sekali bila AUTO_UPDATE_ENABLED=1)
  const autoUpdateEnabled =
    process.env.AUTO_UPDATE_ENABLED === '1' || process.env.AUTO_UPDATE_ENABLED === 'true';
  if (autoUpdateEnabled) {
    const intervalMin = Math.max(5, Number(process.env.AUTO_UPDATE_INTERVAL_MINUTES) || 60);
    const intervalMs = intervalMin * 60_000;
    const scriptPath = path.resolve(APP_ROOT, 'scripts/auto-update.sh');
    const gitDirPath = path.resolve(APP_ROOT, '.git');

    const triggerScheduledAutoUpdate = async () => {
      if (!fs.existsSync(scriptPath) || !fs.existsSync(gitDirPath)) return;
      try {
        const { spawn } = await import('child_process');
        fs.mkdirSync(DATA_DIR, { recursive: true });
        const logPath = path.join(DATA_DIR, 'auto-update.log');
        capLogFileSize(logPath, 1024 * 1024);
        const outFd = fs.openSync(logPath, 'a');
        const child = spawn('bash', [scriptPath], {
          cwd: APP_ROOT,
          detached: true,
          stdio: ['ignore', outFd, outFd],
          env: process.env,
        });
        child.unref();
        fs.closeSync(outFd);
      } catch (err) {
        console.error('[AutoUpdate] Gagal menjadwalkan pemeriksaan update:', err instanceof Error ? err.message : err);
      }
    };

    console.log(`[AutoUpdate] Scheduler GitHub aktif setiap ${intervalMin} menit (${scriptPath})`);
    setTimeout(() => void triggerScheduledAutoUpdate(), 120_000);
    setInterval(() => void triggerScheduledAutoUpdate(), intervalMs);
  }

  const listenCfg = resolveListenConfig({ argv: process.argv, env: process.env });
  let activePort = listenCfg.port;
  const listenHost = listenCfg.host;
  let portAttempts = 0;

  const onListen = () => {
    console.log(`[Absensi SMK Server] Running on http://${listenHost || '0.0.0.0'}:${activePort}`);
    startFaceServiceMonitor({
      isPythonFaceServiceOnline: async () => {
        const health = await callFaceService<{ ok?: boolean }>('/health');
        return Boolean(health?.ok);
      },
    });
  };

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      if (listenCfg.autoPortFallback && portAttempts < 50) {
        portAttempts++;
        const prevPort = activePort;
        activePort += 1;
        console.warn(
          `[Absensi SMK Server] Port ${prevPort} sudah dipakai aplikasi lain; mencoba port berikutnya ${activePort} (AUTO_PORT_FALLBACK=1)...`
        );
        setTimeout(tryListen, 100);
        return;
      }
      console.error(
        `[Absensi SMK Server] ERROR: Port ${activePort} sudah dipakai oleh aplikasi/sekolah lain (EADDRINUSE). ` +
          `Untuk multi-domain/multi-sekolah di 1 VPS, ubah PORT di .env (mis. PORT=3001, 3002, ...), jalankan "npm run setup:school -- --domain <domain>", atau gunakan flag "--port 3001".`
      );
      process.exit(1);
    }
    throw err;
  });

  server.once('listening', onListen);

  const tryListen = () => {
    if (listenHost) {
      server.listen(activePort, listenHost);
    } else {
      server.listen(activePort);
    }
  };
  tryListen();
}

process.on('unhandledRejection', (reason) => {
  console.error('[Absensi SMK Server] Unhandled promise rejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[Absensi SMK Server] Uncaught exception:', err);
});

const handleShutdown = () => {
  stopWaGatewayChild();
  process.exit(0);
};
process.once('SIGTERM', handleShutdown);
process.once('SIGINT', handleShutdown);

start();
