import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import {
  getJakartaNowParts,
  normalizeCaptureJpegQuality,
  normalizeCaptureMaxWidth,
} from '../lib/attendanceEngine.ts';
import { resolveExecutableBinary, type ExecutableResolution } from '../lib/staticConfig.ts';
import { APP_ROOT } from './envBootstrap.ts';
import { getCachedStudentFaceIndex } from './store.ts';
import type { AppDatabase, WorkerCameraStat } from '../types';

const requireCjs = createRequire(import.meta.url);
const loggedFfmpegNotices = new Set<string>();

function logFfmpegOnce(key: string, level: 'log' | 'warn', message: string): void {
  if (loggedFfmpegNotices.has(key)) return;
  loggedFfmpegNotices.add(key);
  console[level](message);
}

export function resolveFfmpegDetails(excludePaths?: Set<string>): ExecutableResolution {
  const candidates: Array<string | null | undefined> = [process.env.FFMPEG_PATH];

  try {
    const mod = requireCjs('@ffmpeg-installer/ffmpeg') as { path?: string };
    if (mod?.path) {
      candidates.push(mod.path);
    }
  } catch {
    // fallback ke path sistem
  }

  const exeName = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  candidates.push(
    path.join(APP_ROOT, 'node_modules/@ffmpeg-installer', `${process.platform}-${process.arch}`, exeName),
    '/usr/bin/ffmpeg',
    '/usr/local/bin/ffmpeg',
    '/bin/ffmpeg',
    '/opt/homebrew/bin/ffmpeg'
  );

  const filtered = excludePaths
    ? candidates.filter((c) => typeof c === 'string' && c.trim() && !excludePaths.has(c.trim()))
    : candidates;

  const resolution = resolveExecutableBinary({
    candidates: filtered,
    binaryName: exeName,
    envPath: excludePaths ? '' : process.env.PATH || '',
    ops: {
      existsSync: (p) => fs.existsSync(p),
      isFileSync: (p) => {
        try {
          return fs.statSync(p).isFile();
        } catch {
          return false;
        }
      },
      canExecuteSync: (p) => {
        fs.accessSync(p, fs.constants.X_OK);
        return true;
      },
      chmodSync: (p, mode) => fs.chmodSync(p, mode),
    },
  });

  for (const repaired of resolution.repairedPaths) {
    logFfmpegOnce(`repaired:${repaired}`, 'log', `[FFmpeg] Memperbaiki izin eksekusi (+x) pada ${repaired}`);
  }
  for (const blocked of resolution.nonExecutablePaths) {
    logFfmpegOnce(
      `blocked:${blocked}`,
      'warn',
      `[FFmpeg] Binary "${blocked}" tidak dapat dieksekusi (EACCES). Mencoba fallback sistem atau jalankan: chmod +x "${blocked}"`
    );
  }

  return resolution;
}

export function resolveFfmpegBinary(): string {
  return resolveFfmpegDetails().binary;
}

const pythonCameraTelemetry = new Map<number, Partial<WorkerCameraStat>>();
let syncTimer: ReturnType<typeof setInterval> | null = null;
let pythonActive = false;
let pythonModelLoaded = false;

export function updatePythonCameraTelemetry(cameraId: number, patch: Partial<WorkerCameraStat>): void {
  const prev = pythonCameraTelemetry.get(cameraId) ?? {};
  pythonCameraTelemetry.set(cameraId, { ...prev, ...patch });
}

export function setPythonFaceServiceOnline(online: boolean, modelLoaded = online): void {
  pythonActive = Boolean(online);
  pythonModelLoaded = Boolean(online && modelLoaded);
}

export function startFaceServiceMonitor(deps: {
  isPythonFaceServiceOnline: () => Promise<boolean>;
}): void {
  const poll = () => {
    deps
      .isPythonFaceServiceOnline()
      .then((online) => {
        setPythonFaceServiceOnline(online, online);
      })
      .catch(() => {
        setPythonFaceServiceOnline(false, false);
      });
  };
  poll();
  if (syncTimer) clearInterval(syncTimer);
  syncTimer = setInterval(poll, 30_000);
}

let cachedAppVersion: string | null = null;

export function getAppVersion(): string {
  if (cachedAppVersion) return cachedAppVersion;
  try {
    const raw = fs.readFileSync(path.join(APP_ROOT, 'package.json'), 'utf8');
    const parsed = JSON.parse(raw) as { version?: unknown };
    const v = typeof parsed.version === 'string' ? parsed.version.trim() : '';
    cachedAppVersion = v || '1.0.0';
  } catch {
    cachedAppVersion = '1.0.0';
  }
  return cachedAppVersion;
}

export function getNodeWorkerStatus(db: AppDatabase): {
  app_version: string;
  engine: 'INSIGHTFACE_PYTHON' | 'IDLE';
  node_env: string;
  timezone: string;
  server_time_wib: string;
  production_mode: boolean;
  model_loaded: boolean;
  expected_embedding_dims: number;
  capture_max_width: number;
  capture_jpeg_quality: number;
  active_workers: number;
  indexed_students: number;
  cameras: WorkerCameraStat[];
} {
  const engine: 'INSIGHTFACE_PYTHON' | 'IDLE' = pythonActive ? 'INSIGHTFACE_PYTHON' : 'IDLE';
  const indexedStudents = getCachedStudentFaceIndex(db.students).totalIndexed;
  const captureMaxWidth = normalizeCaptureMaxWidth(db.settings.capture_max_width);
  const captureJpegQuality = normalizeCaptureJpegQuality(db.settings.capture_jpeg_quality);

  const cameras: WorkerCameraStat[] = db.cameras.map((cam) => {
    const pyTel = pythonCameraTelemetry.get(cam.id);
    return {
      camera_id: cam.id,
      nama_kamera: cam.nama_kamera,
      aktif: Boolean(cam.aktif),
      connected: Boolean(pyTel?.connected ?? (pythonActive && cam.status === 'ONLINE')),
      fps: pyTel?.fps ?? 0,
      frames_decoded: pyTel?.frames_decoded ?? 0,
      raw_faces_seen: pyTel?.raw_faces_seen ?? 0,
      dropped_filter: pyTel?.dropped_filter ?? 0,
      faces_detected_total: pyTel?.faces_detected_total ?? 0,
      matched_dispatched: pyTel?.matched_dispatched ?? 0,
      anonymous_dispatched: pyTel?.anonymous_dispatched ?? 0,
      watchdog_restarts: pyTel?.watchdog_restarts ?? 0,
      last_frame_at: pyTel?.last_frame_at ?? null,
      last_face_at: pyTel?.last_face_at ?? null,
      last_detect_at: pyTel?.last_detect_at ?? pyTel?.last_face_at ?? null,
      last_error: pyTel?.last_error ?? cam.last_error,
    };
  });

  return {
    app_version: getAppVersion(),
    engine,
    node_env: process.env.NODE_ENV || 'development',
    timezone: 'Asia/Jakarta',
    server_time_wib: getJakartaNowParts().dateTimeStr,
    production_mode: Boolean(db.settings.production_mode),
    model_loaded: pythonActive && pythonModelLoaded,
    expected_embedding_dims: 512,
    capture_max_width: captureMaxWidth,
    capture_jpeg_quality: captureJpegQuality,
    active_workers: cameras.filter((c) => c.connected).length,
    indexed_students: indexedStudents,
    cameras,
  };
}
