import fs from 'fs';
import path from 'path';
import { spawn, type ChildProcess } from 'child_process';
import { createRequire } from 'module';
import jpeg from 'jpeg-js';
import {
  computeQualityScore,
  cosineSimilarity,
  extractJpegFramesFromChunk,
  maskRtspCredentials,
} from '../lib/attendanceEngine.ts';
import type { AppDatabase, Camera, WorkerCameraStat } from '../types';

const requireCjs = createRequire(import.meta.url);

export function resolveFfmpegBinary(): string {
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

interface HumanFaceResult {
  box?: [number, number, number, number];
  boxScore?: number;
  faceScore?: number;
  embedding?: number[] | Float32Array;
  rotation?: {
    angle?: { roll?: number; yaw?: number; pitch?: number };
  };
}

interface HumanInstance {
  tf: {
    tensor3d: (values: Uint8Array, shape: [number, number, number], dtype: 'int32') => unknown;
    dispose: (tensor: unknown) => void;
  };
  load: () => Promise<void>;
  detect: (input: unknown) => Promise<{ face: HumanFaceResult[] }>;
}

let humanSingleton: HumanInstance | null = null;
let humanInitPromise: Promise<HumanInstance> | null = null;
let fetchShimApplied = false;
let detectMutex: Promise<void> = Promise.resolve();

function runSerialized<T>(fn: () => Promise<T>): Promise<T> {
  const next = detectMutex.then(fn, fn);
  detectMutex = next.then(
    () => undefined,
    () => undefined
  );
  return next;
}

export async function initNodeFaceAi(): Promise<HumanInstance> {
  if (humanSingleton) return humanSingleton;
  if (humanInitPromise) return humanInitPromise;

  humanInitPromise = (async () => {
    const modelDir = path.resolve(process.cwd(), 'node_modules/@vladmandic/human/models');
    const wasmDir = path.resolve(process.cwd(), 'node_modules/@tensorflow/tfjs-backend-wasm/dist') + path.sep;

    if (!fetchShimApplied) {
      const origFetch = globalThis.fetch.bind(globalThis);
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        if (urlStr.startsWith(`file://${modelDir}`)) {
          const filePath = decodeURIComponent(urlStr.slice(7));
          const buf = fs.readFileSync(filePath);
          return new Response(buf, { status: 200 });
        }
        return origFetch(input, init);
      };
      fetchShimApplied = true;
    }

    const tf = await import('@tensorflow/tfjs');
    const wasm = await import('@tensorflow/tfjs-backend-wasm');
    wasm.setWasmPaths(wasmDir);
    await tf.setBackend('wasm');
    await tf.ready();

    const humanModulePath = path.resolve(
      process.cwd(),
      'node_modules/@vladmandic/human/dist/human.node-wasm.js'
    );
    const { Human } = (await import(humanModulePath)) as {
      Human: new (config: Record<string, unknown>) => HumanInstance;
    };

    const human = new Human({
      modelBasePath: `file://${modelDir}/`,
      backend: 'wasm',
      debug: false,
      cacheSensitivity: 0,
      face: {
        enabled: true,
        detector: { enabled: true, return: true, maxDetected: 12, minConfidence: 0.45, iouThreshold: 0.35 },
        mesh: { enabled: true },
        iris: { enabled: false },
        emotion: { enabled: false },
        description: { enabled: true },
        antispoof: { enabled: false },
        liveness: { enabled: false },
      },
      body: { enabled: false },
      hand: { enabled: false },
      object: { enabled: false },
      gesture: { enabled: false },
    });

    await human.load();
    humanSingleton = human;
    return human;
  })();

  try {
    return await humanInitPromise;
  } catch (err) {
    humanInitPromise = null;
    throw err;
  }
}

function computeCropSharpnessNorm(rgba: Uint8Array, imgW: number, x1: number, y1: number, x2: number, y2: number): number {
  const step = Math.max(1, Math.floor((x2 - x1) / 48));
  let sumGrad = 0;
  let samples = 0;
  for (let y = y1 + step; y < y2 - step; y += step) {
    for (let x = x1 + step; x < x2 - step; x += step) {
      const idx = (y * imgW + x) * 4;
      const idxR = (y * imgW + (x + step)) * 4;
      const idxD = ((y + step) * imgW + x) * 4;
      const luma = 0.299 * rgba[idx] + 0.587 * rgba[idx + 1] + 0.114 * rgba[idx + 2];
      const lumaR = 0.299 * rgba[idxR] + 0.587 * rgba[idxR + 1] + 0.114 * rgba[idxR + 2];
      const lumaD = 0.299 * rgba[idxD] + 0.587 * rgba[idxD + 1] + 0.114 * rgba[idxD + 2];
      sumGrad += Math.abs(luma - lumaR) + Math.abs(luma - lumaD);
      samples++;
    }
  }
  if (samples === 0) return 0.75;
  const meanGrad = sumGrad / samples;
  return Math.min(1, Math.max(0.25, meanGrad / 32));
}

function encodeRgbaCropJpeg(rgba: Uint8Array, imgW: number, imgH: number, x1: number, y1: number, x2: number, y2: number): Buffer {
  const cx1 = Math.max(0, Math.min(imgW - 2, x1));
  const cy1 = Math.max(0, Math.min(imgH - 2, y1));
  const cx2 = Math.max(cx1 + 2, Math.min(imgW, x2));
  const cy2 = Math.max(cy1 + 2, Math.min(imgH, y2));
  const cw = cx2 - cx1;
  const ch = cy2 - cy1;
  const out = Buffer.alloc(cw * ch * 4);
  for (let row = 0; row < ch; row++) {
    const srcStart = ((cy1 + row) * imgW + cx1) * 4;
    const srcEnd = srcStart + cw * 4;
    Buffer.from(rgba.buffer, rgba.byteOffset + srcStart, srcEnd - srcStart).copy(out, row * cw * 4);
  }
  const encoded = jpeg.encode({ data: out, width: cw, height: ch }, 86);
  return Buffer.from(encoded.data);
}

export interface DetectedFaceOutput {
  confidence: number;
  faceSizePx: number;
  sharpnessNorm: number;
  frontalScore: number;
  embedding: number[];
  bbox: [number, number, number, number];
  cropJpeg: Buffer;
}

export async function detectFacesInJpeg(jpegBuffer: Buffer): Promise<DetectedFaceOutput[]> {
  const human = await initNodeFaceAi();
  const decoded = jpeg.decode(jpegBuffer, { useTArray: true, formatAsRGBA: true });
  const { width, height, data } = decoded;
  if (!width || !height || data.length === 0) return [];

  const rgb = new Uint8Array(width * height * 3);
  for (let i = 0, j = 0; i < data.length; i += 4, j += 3) {
    rgb[j] = data[i];
    rgb[j + 1] = data[i + 1];
    rgb[j + 2] = data[i + 2];
  }

  const res = await runSerialized(async () => {
    const tensor = human.tf.tensor3d(rgb, [height, width, 3], 'int32');
    try {
      return await human.detect(tensor);
    } finally {
      human.tf.dispose(tensor);
    }
  });

  const facesOut: DetectedFaceOutput[] = [];
  for (const f of res.face ?? []) {
    if (!f.box || !f.embedding || f.embedding.length === 0) continue;
    const [bx, by, bw, bh] = f.box;
    const x1 = Math.max(0, Math.round(bx));
    const y1 = Math.max(0, Math.round(by));
    const x2 = Math.min(width, Math.round(bx + bw));
    const y2 = Math.min(height, Math.round(by + bh));
    const faceSizePx = Math.min(Math.max(0, x2 - x1), Math.max(0, y2 - y1));
    if (faceSizePx <= 0) continue;

    const conf = Math.min(1, Math.max(0, Math.max(f.boxScore ?? 0, f.faceScore ?? 0)));
    const yawDeg = Math.abs(((f.rotation?.angle?.yaw ?? 0) * 180) / Math.PI);
    const pitchDeg = Math.abs(((f.rotation?.angle?.pitch ?? 0) * 180) / Math.PI);
    const frontalScore = Math.max(0.2, Math.min(1, 1 - (yawDeg / 45) * 0.6 - (pitchDeg / 35) * 0.4));
    const sharpnessNorm = computeCropSharpnessNorm(data, width, x1, y1, x2, y2);

    const pad = Math.round(Math.max(x2 - x1, y2 - y1) * 0.25);
    const cropJpeg = encodeRgbaCropJpeg(data, width, height, x1 - pad, y1 - pad, x2 + pad, y2 + pad);

    const emb = Array.from(f.embedding, (v) => Math.round(Number(v) * 100000) / 100000);
    facesOut.push({
      confidence: Math.round(conf * 10000) / 10000,
      faceSizePx,
      sharpnessNorm: Math.round(sharpnessNorm * 10000) / 10000,
      frontalScore: Math.round(frontalScore * 10000) / 10000,
      embedding: emb,
      bbox: [x1, y1, x2, y2],
      cropJpeg,
    });
  }

  return facesOut;
}

export async function analyzePhotoWithNodeAi(
  photoDataUrl: string,
  settings: AppDatabase['settings']
): Promise<{ quality_score: number; embedding: number[]; confidence: number } | null> {
  try {
    const cleanB64 = photoDataUrl.includes(',') ? photoDataUrl.split(',').slice(1).join(',') : photoDataUrl;
    const buf = Buffer.from(cleanB64, 'base64');
    if (buf.length < 64) return null;
    const faces = await detectFacesInJpeg(buf);
    if (faces.length === 0) return null;
    const best = faces.sort(
      (a, b) => (b.bbox[2] - b.bbox[0]) * (b.bbox[3] - b.bbox[1]) - (a.bbox[2] - a.bbox[0]) * (a.bbox[3] - a.bbox[1])
    )[0];
    const quality_score = computeQualityScore(
      {
        confidence: best.confidence,
        faceSizePx: best.faceSizePx,
        sharpnessNorm: best.sharpnessNorm,
        frontalScore: best.frontalScore,
      },
      settings
    );
    return {
      quality_score,
      embedding: best.embedding,
      confidence: best.confidence,
    };
  } catch {
    return null;
  }
}

export interface NodeWorkerDeps {
  loadDb: () => AppDatabase;
  snapshotsDir: string;
  isPythonFaceServiceOnline: () => Promise<boolean>;
  onHeartbeat: (cameraId: number, online: boolean, error: string | null) => void;
  onFaceEvent: (payload: {
    camera_id: number;
    student_id: number | null;
    similarity: number;
    confidence: number;
    quality_score: number;
    embedding: number[];
    snapshot_rel_path: string;
  }) => void;
}

interface WorkerRuntime {
  camera: Camera;
  stop: boolean;
  child: ChildProcess | null;
  stat: WorkerCameraStat;
  timeoutFlag: '-stimeout' | '-rw_timeout';
}

const workers = new Map<number, WorkerRuntime>();
const dispatchCooldown = new Map<string, number>();
let managerDeps: NodeWorkerDeps | null = null;
let syncTimer: ReturnType<typeof setInterval> | null = null;
let pythonActive = false;

function stopSingleWorker(camId: number) {
  const w = workers.get(camId);
  if (!w) return;
  w.stop = true;
  if (w.child && !w.child.killed) {
    try {
      w.child.kill('SIGTERM');
    } catch {
      // ignore kill error
    }
  }
  workers.delete(camId);
}

async function runCameraLoop(w: WorkerRuntime, deps: NodeWorkerDeps) {
  const ffmpegBin = resolveFfmpegBinary();
  let failStreak = 0;

  while (!w.stop) {
    const cam = w.camera;
    const url = String(cam.rtsp_url || '').trim();
    if (!cam.aktif || !/^rtsps?:\/\//i.test(url)) {
      break;
    }

    let stderrTail = '';
    let remainder: Uint8Array = new Uint8Array(0);
    let latestFrame: Buffer | null = null;
    let processingFrame = false;

    const processPendingFrames = async () => {
      if (processingFrame || w.stop) return;
      processingFrame = true;
      try {
        while (latestFrame && !w.stop) {
          const frameBuf = latestFrame;
          latestFrame = null;
          w.stat.frames_decoded += 1;
          w.stat.last_frame_at = new Date().toISOString().replace('T', ' ').slice(0, 19);

          try {
            const faces = await detectFacesInJpeg(frameBuf);
            if (faces.length === 0) continue;

            const db = deps.loadDb();
            const effMinConf = Math.min(db.settings.threshold_confidence, 0.65);
            const effMinSize = Math.min(db.settings.min_face_size, 40);

            for (const f of faces) {
              if (f.confidence < effMinConf || f.faceSizePx < effMinSize) {
                continue;
              }
              w.stat.faces_detected_total += 1;
              w.stat.last_face_at = new Date().toISOString().replace('T', ' ').slice(0, 19);

              // Cocokkan 1:N dengan siswa ber-embedding sejenis
              let bestStudentId: number | null = null;
              let bestSim = 0;
              for (const st of db.students) {
                if (st.status === 'LULUS' || !Array.isArray(st.embedding) || st.embedding.length !== f.embedding.length) {
                  continue;
                }
                const sim = cosineSimilarity(f.embedding, st.embedding);
                if (sim >= db.settings.threshold_recognition && sim > bestSim) {
                  bestSim = sim;
                  bestStudentId = st.id;
                }
              }

              const cooldownKey = `${cam.id}:${bestStudentId ?? 'anon'}`;
              const lastSent = dispatchCooldown.get(cooldownKey) ?? 0;
              const nowMs = Date.now();
              if (nowMs - lastSent < 6000) {
                continue;
              }
              dispatchCooldown.set(cooldownKey, nowMs);

              const snapName = `cam${cam.id}_node_${nowMs}.jpg`;
              const snapFull = path.join(deps.snapshotsDir, snapName);
              fs.mkdirSync(deps.snapshotsDir, { recursive: true });
              fs.writeFileSync(snapFull, f.cropJpeg);

              const qScore = computeQualityScore(
                {
                  confidence: f.confidence,
                  faceSizePx: f.faceSizePx,
                  sharpnessNorm: f.sharpnessNorm,
                  frontalScore: f.frontalScore,
                },
                db.settings
              );

              deps.onFaceEvent({
                camera_id: cam.id,
                student_id: bestStudentId,
                similarity: Math.round(bestSim * 10000) / 10000,
                confidence: f.confidence,
                quality_score: qScore,
                embedding: f.embedding,
                snapshot_rel_path: `/data/snapshots/${snapName}`,
              });
            }
          } catch {
            // ignore transient frame decode/inference error
          }
        }
      } finally {
        processingFrame = false;
      }
    };

    const exitResult = await new Promise<{ code: number | null; gotFrame: boolean }>((resolve) => {
      let gotFrame = false;
      const args = [
        '-hide_banner',
        '-loglevel',
        'error',
        '-rtsp_transport',
        'tcp',
        w.timeoutFlag,
        '7000000',
        '-i',
        url,
        '-vf',
        "fps=1,scale='min(1280,iw)':-2",
        '-q:v',
        '4',
        '-f',
        'image2pipe',
        '-vcodec',
        'mjpeg',
        'pipe:1',
      ];
      const child = spawn(ffmpegBin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      w.child = child;

      child.stdout.on('data', (chunk: Buffer) => {
        const res = extractJpegFramesFromChunk(remainder, chunk);
        remainder = res.remainder;
        if (res.frames.length > 0) {
          if (!gotFrame) {
            gotFrame = true;
            failStreak = 0;
            w.stat.connected = true;
            w.stat.last_error = null;
            deps.onHeartbeat(cam.id, true, null);
          }
          latestFrame = Buffer.from(res.frames[res.frames.length - 1]);
          processPendingFrames().catch(() => {});
        }
      });

      child.stderr.on('data', (chunk: Buffer) => {
        stderrTail = (stderrTail + chunk.toString('utf8')).slice(-600);
      });

      child.on('close', (code) => {
        w.child = null;
        resolve({ code, gotFrame });
      });

      child.on('error', (err) => {
        stderrTail = err.message;
        w.child = null;
        resolve({ code: 1, gotFrame });
      });
    });

    if (w.stop) break;

    if (/Option stimeout not found/i.test(stderrTail) && w.timeoutFlag === '-stimeout') {
      w.timeoutFlag = '-rw_timeout';
      continue;
    }

    w.stat.connected = false;
    failStreak = exitResult.gotFrame ? 0 : failStreak + 1;
    const maskedErr = maskRtspCredentials(stderrTail.trim() || `Stream RTSP terputus (kode ${exitResult.code ?? '-'})`).slice(0, 140);
    w.stat.last_error = maskedErr;
    deps.onHeartbeat(cam.id, false, maskedErr);

    const retryMs = failStreak === 0 ? 4000 : failStreak === 1 ? 10000 : 45000;
    await new Promise((r) => setTimeout(r, retryMs));
  }
}

export async function refreshNodeRtspWorkers(): Promise<void> {
  if (!managerDeps) return;
  if (process.env.DISABLE_NODE_RTSP_WORKER === '1') {
    for (const cid of Array.from(workers.keys())) stopSingleWorker(cid);
    return;
  }

  pythonActive = await managerDeps.isPythonFaceServiceOnline();
  if (pythonActive) {
    for (const cid of Array.from(workers.keys())) stopSingleWorker(cid);
    return;
  }

  const db = managerDeps.loadDb();
  const desired = new Map<number, Camera>();
  for (const cam of db.cameras) {
    const url = String(cam.rtsp_url || '').trim();
    if (cam.aktif && /^rtsps?:\/\//i.test(url)) {
      desired.set(cam.id, cam);
    }
  }

  for (const cid of Array.from(workers.keys())) {
    const existing = workers.get(cid)!;
    const nextCam = desired.get(cid);
    if (!nextCam || nextCam.rtsp_url !== existing.camera.rtsp_url) {
      stopSingleWorker(cid);
    } else {
      existing.camera = nextCam;
      existing.stat.nama_kamera = nextCam.nama_kamera;
    }
  }

  for (const [cid, cam] of desired.entries()) {
    if (!workers.has(cid)) {
      const runtime: WorkerRuntime = {
        camera: cam,
        stop: false,
        child: null,
        timeoutFlag: '-stimeout',
        stat: {
          camera_id: cam.id,
          nama_kamera: cam.nama_kamera,
          connected: false,
          frames_decoded: 0,
          faces_detected_total: 0,
          last_frame_at: null,
          last_face_at: null,
          last_error: null,
        },
      };
      workers.set(cid, runtime);
      runCameraLoop(runtime, managerDeps).catch(() => {});
    }
  }
}

export function startNodeRtspWorkers(deps: NodeWorkerDeps): void {
  managerDeps = deps;
  // Pre-load WASM model in background so first camera frame analyzes immediately
  initNodeFaceAi().catch(() => {});
  refreshNodeRtspWorkers().catch(() => {});
  if (syncTimer) clearInterval(syncTimer);
  syncTimer = setInterval(() => {
    refreshNodeRtspWorkers().catch(() => {});
  }, 30_000);
}

export function getNodeWorkerStatus(db: AppDatabase): {
  engine: 'INSIGHTFACE_PYTHON' | 'NODE_WASM_LIVE' | 'IDLE';
  node_env: string;
  production_mode: boolean;
  model_loaded: boolean;
  active_workers: number;
  cameras: WorkerCameraStat[];
} {
  const list = Array.from(workers.values()).map((w) => ({ ...w.stat }));
  const engine = pythonActive ? 'INSIGHTFACE_PYTHON' : list.length > 0 || humanSingleton !== null ? 'NODE_WASM_LIVE' : 'IDLE';
  return {
    engine,
    node_env: process.env.NODE_ENV || 'development',
    production_mode: Boolean(db.settings.production_mode),
    model_loaded: Boolean(humanSingleton),
    active_workers: list.filter((c) => c.connected).length,
    cameras: list,
  };
}
