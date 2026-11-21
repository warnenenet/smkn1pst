import fs from 'fs';
import path from 'path';
import { spawn, type ChildProcess } from 'child_process';
import { createRequire } from 'module';
import jpeg from 'jpeg-js';
import {
  buildFfmpegCaptureVideoFilter,
  computeCalibratedMinFacePx,
  computeQualityScore,
  extractJpegFramesFromChunk,
  getJakartaNowParts,
  maskRtspCredentials,
  normalizeCaptureJpegQuality,
  normalizeCaptureMaxWidth,
  passesSnapshotQualityThreshold,
} from '../lib/attendanceEngine.ts';
import { findBestFaceMatch } from '../lib/faceIndex.ts';
import { getCachedStudentFaceIndex } from './store.ts';
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

function encodeRgbaCropJpeg(
  rgba: Uint8Array,
  imgW: number,
  imgH: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  jpegQuality = 86
): Buffer {
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
  const encoded = jpeg.encode({ data: out, width: cw, height: ch }, normalizeCaptureJpegQuality(jpegQuality));
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

export async function detectFacesInJpeg(jpegBuffer: Buffer, jpegQuality = 86): Promise<DetectedFaceOutput[]> {
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

    const pad = Math.round(Math.max(x2 - x1, y2 - y1) * 0.45);
    const cropJpeg = encodeRgbaCropJpeg(data, width, height, x1 - pad, y1 - pad, x2 + pad, y2 + pad, jpegQuality);

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
  captureMaxWidth: number;
  stop: boolean;
  child: ChildProcess | null;
  stat: WorkerCameraStat;
  timeoutFlag: '-stimeout' | '-rw_timeout';
  frameTimestamps: number[];
}

const workers = new Map<number, WorkerRuntime>();
const pythonCameraTelemetry = new Map<number, Partial<WorkerCameraStat>>();
const dispatchCooldown = new Map<string, number>();
let managerDeps: NodeWorkerDeps | null = null;
let syncTimer: ReturnType<typeof setInterval> | null = null;
let pythonActive = false;

export function updatePythonCameraTelemetry(cameraId: number, patch: Partial<WorkerCameraStat>): void {
  const prev = pythonCameraTelemetry.get(cameraId) ?? {};
  pythonCameraTelemetry.set(cameraId, { ...prev, ...patch });
}

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
  console.log(`[RTSP][Cam #${camId}] Worker dihentikan.`);
}

async function runCameraLoop(w: WorkerRuntime, deps: NodeWorkerDeps) {
  const ffmpegBin = resolveFfmpegBinary();
  let failStreak = 0;

  while (!w.stop) {
    try {
      const cam = w.camera;
      const url = String(cam.rtsp_url || '').trim();
      if (!cam.aktif || !/^rtsps?:\/\//i.test(url)) {
        break;
      }

      const captureWidth = normalizeCaptureMaxWidth(w.captureMaxWidth);
      const vfArg = buildFfmpegCaptureVideoFilter(1, captureWidth);
      console.log(
        `[RTSP][Cam #${cam.id}] Memulai stream FFmpeg (fps=1, capture=${captureWidth === 0 ? 'NATIVE' : `max-${captureWidth}px`}, timeoutFlag=${w.timeoutFlag}, url=${maskRtspCredentials(url)})`
      );

      let stderrTail = '';
      let remainder: Uint8Array = new Uint8Array(0);
      let latestFrame: Buffer | null = null;
      let processingFrame = false;
      let lastFrameEpochMs = Date.now();
      let lastSummaryLogMs = Date.now();

      const processPendingFrames = async () => {
        if (processingFrame || w.stop) return;
        processingFrame = true;
        try {
          while (latestFrame && !w.stop) {
            const frameBuf = latestFrame;
            latestFrame = null;
            const nowEpoch = Date.now();
            const nowWib = getJakartaNowParts(new Date(nowEpoch)).dateTimeStr;
            w.stat.frames_decoded += 1;
            w.stat.last_frame_at = nowWib;

            w.frameTimestamps.push(nowEpoch);
            while (w.frameTimestamps.length > 0 && nowEpoch - w.frameTimestamps[0] > 10_000) {
              w.frameTimestamps.shift();
            }
            w.stat.fps = Math.round((w.frameTimestamps.length / 10) * 10) / 10;

            if (nowEpoch - lastSummaryLogMs >= 60_000) {
              lastSummaryLogMs = nowEpoch;
              console.log(
                `[RTSP][Cam #${cam.id}] Heartbeat 60s: decoded=${w.stat.frames_decoded} fps=${w.stat.fps} rawFaces=${w.stat.raw_faces_seen} passed=${w.stat.faces_detected_total} dropped=${w.stat.dropped_filter}`
              );
            }

            try {
              const db = deps.loadDb();
              const jpegQuality = normalizeCaptureJpegQuality(db.settings.capture_jpeg_quality);
              const faces = await detectFacesInJpeg(frameBuf, jpegQuality);
              if (faces.length === 0) continue;

              const effMinConf = Math.min(db.settings.threshold_confidence, 0.5);
              const liveCam = db.cameras.find((c) => c.id === cam.id) ?? cam;
              const calibrated = computeCalibratedMinFacePx({
                cameraResolution: liveCam.resolusi,
                globalMinFaceSize: db.settings.min_face_size,
                cameraMinFaceSize: liveCam.min_face_size,
                globalCaptureMaxWidth: db.settings.capture_max_width,
                cameraCaptureMaxWidth: liveCam.capture_max_width,
              });
              const effMinSize = calibrated.effectiveMinFacePx;
              let passedCount = 0;
              let droppedCount = 0;

              for (const f of faces) {
                w.stat.raw_faces_seen += 1;
                if (f.confidence < effMinConf || f.faceSizePx < effMinSize) {
                  w.stat.dropped_filter += 1;
                  droppedCount += 1;
                  continue;
                }

                const qScore = computeQualityScore(
                  {
                    confidence: f.confidence,
                    faceSizePx: f.faceSizePx,
                    sharpnessNorm: f.sharpnessNorm,
                    frontalScore: f.frontalScore,
                  },
                  db.settings
                );
                const qualityCheck = passesSnapshotQualityThreshold(qScore, db.settings.min_snapshot_quality);
                if (!qualityCheck.passed) {
                  w.stat.dropped_filter += 1;
                  droppedCount += 1;
                  console.log(
                    `[DETECT][Cam #${cam.id}] Wajah diabaikan kualitas ${(qScore * 100).toFixed(1)}% < ${Math.round(qualityCheck.threshold * 100)}% (conf=${f.confidence.toFixed(2)} px=${f.faceSizePx})`
                  );
                  continue;
                }

                passedCount += 1;
                w.stat.faces_detected_total += 1;
                const detectWib = getJakartaNowParts().dateTimeStr;
                w.stat.last_face_at = detectWib;
                w.stat.last_detect_at = detectWib;

                // Cocokkan 1:N dengan indeks vektor Float32Array pre-normalisasi (optimal 5000+ siswa <1ms)
                const studentIdx = getCachedStudentFaceIndex(db.students);
                const match = findBestFaceMatch(studentIdx, f.embedding, db.settings.threshold_recognition);
                const bestStudentId = match.bestId;
                const bestSim = match.bestSimilarity;
                const topAnySim = match.topAnySimilarity;
                const dimMismatches = match.dimMismatchCount;

                const cooldownKey = `${cam.id}:${bestStudentId ?? 'anon'}`;
                const lastSent = dispatchCooldown.get(cooldownKey) ?? 0;
                const nowMs = Date.now();
                if (nowMs - lastSent < 6000) {
                  continue;
                }
                if (dispatchCooldown.size > 500) {
                  for (const [k, ts] of dispatchCooldown.entries()) {
                    if (nowMs - ts > 300_000) dispatchCooldown.delete(k);
                  }
                }
                dispatchCooldown.set(cooldownKey, nowMs);

                const snapName = `cam${cam.id}_node_${nowMs}.jpg`;
                const snapFull = path.join(deps.snapshotsDir, snapName);
                fs.mkdirSync(deps.snapshotsDir, { recursive: true });
                fs.writeFileSync(snapFull, f.cropJpeg);

                if (bestStudentId) {
                  w.stat.matched_dispatched += 1;
                  console.log(
                    `[MATCH][Cam #${cam.id}] Siswa #${bestStudentId} sim=${bestSim.toFixed(3)} q=${qScore.toFixed(3)} conf=${f.confidence.toFixed(2)} px=${f.faceSizePx}`
                  );
                } else {
                  w.stat.anonymous_dispatched += 1;
                  console.log(
                    `[MATCH][Cam #${cam.id}] Anonim dims=${f.embedding.length} bestSim=${topAnySim.toFixed(3)} thresh=${db.settings.threshold_recognition} dimMismatchStudents=${dimMismatches} q=${qScore.toFixed(3)}`
                  );
                }

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

              console.log(
                `[DETECT][Cam #${cam.id}] raw=${faces.length} lolos=${passedCount} ditolak_filter=${droppedCount} (minConf=${effMinConf}, minPx=${effMinSize})`
              );
            } catch (err) {
              console.error(
                `[DETECT][Cam #${cam.id}] Error analisis frame:`,
                err instanceof Error ? err.message : err
              );
            }
          }
        } finally {
          processingFrame = false;
        }
      };

      const exitResult = await new Promise<{ code: number | null; gotFrame: boolean }>((resolve) => {
        let gotFrame = false;
        let settled = false;
        const finish = (code: number | null) => {
          if (settled) return;
          settled = true;
          clearInterval(watchdogTimer);
          w.child = null;
          resolve({ code, gotFrame });
        };

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
          vfArg,
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

        const watchdogTimer = setInterval(() => {
          if (w.stop || settled) return;
          const idleMs = Date.now() - lastFrameEpochMs;
          if (idleMs > 45_000) {
            w.stat.watchdog_restarts += 1;
            stderrTail = `Watchdog timeout: 0 frame selama ${Math.round(idleMs / 1000)} dtk`;
            console.warn(`[RTSP][Cam #${cam.id}] ${stderrTail}, me-restart FFmpeg (#${w.stat.watchdog_restarts})...`);
            try {
              child.kill('SIGKILL');
            } catch {
              // ignore kill error
            }
            finish(137);
          }
        }, 5000);

        child.stdout.on('data', (chunk: Buffer) => {
          const res = extractJpegFramesFromChunk(remainder, chunk);
          remainder = res.remainder;
          if (res.frames.length > 0) {
            lastFrameEpochMs = Date.now();
            if (!gotFrame) {
              gotFrame = true;
              failStreak = 0;
              w.stat.connected = true;
              w.stat.last_error = null;
              console.log(`[RTSP][Cam #${cam.id}] Terhubung LIVE (frame pertama diterima)`);
              deps.onHeartbeat(cam.id, true, null);
            }
            latestFrame = Buffer.from(res.frames[res.frames.length - 1]);
            processPendingFrames().catch((err) => {
              console.error(`[DETECT][Cam #${cam.id}] Unhandled frame error:`, err);
            });
          }
        });

        child.stderr.on('data', (chunk: Buffer) => {
          stderrTail = (stderrTail + chunk.toString('utf8')).slice(-600);
        });

        child.on('close', (code) => {
          finish(code);
        });

        child.on('error', (err) => {
          stderrTail = err.message;
          finish(1);
        });
      });

      if (w.stop) break;

      if (/Option stimeout not found/i.test(stderrTail) && w.timeoutFlag === '-stimeout') {
        w.timeoutFlag = '-rw_timeout';
        console.log(`[RTSP][Cam #${cam.id}] Switch timeout flag ke -rw_timeout`);
        continue;
      }

      w.stat.connected = false;
      w.stat.fps = 0;
      failStreak = exitResult.gotFrame ? 0 : failStreak + 1;
      const maskedErr = maskRtspCredentials(
        stderrTail.trim() || `Stream RTSP terputus (kode ${exitResult.code ?? '-'})`
      ).slice(0, 140);
      w.stat.last_error = maskedErr;
      deps.onHeartbeat(cam.id, false, maskedErr);

      const retryMs = failStreak === 0 ? 4000 : failStreak === 1 ? 10000 : 30000;
      console.warn(
        `[RTSP][Cam #${cam.id}] Terputus/gagal (kode=${exitResult.code ?? '-'}, retry=${retryMs}ms): ${maskedErr}`
      );
      await new Promise((r) => setTimeout(r, retryMs));
    } catch (loopErr) {
      const msg = loopErr instanceof Error ? loopErr.message : String(loopErr);
      w.stat.connected = false;
      w.stat.fps = 0;
      w.stat.last_error = msg.slice(0, 140);
      console.error(`[RTSP][Cam #${w.camera.id}] Exception fatal di worker loop (auto-retry 5s):`, msg);
      await new Promise((r) => setTimeout(r, 5000));
    }
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
    if (workers.size > 0) {
      console.log('[RTSP] Python InsightFace aktif; mengalihkan worker kamera dari Node WASM ke Python.');
    }
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
    const camCaptureWidth = nextCam
      ? normalizeCaptureMaxWidth(nextCam.capture_max_width ?? db.settings.capture_max_width)
      : 0;
    if (!nextCam || nextCam.rtsp_url !== existing.camera.rtsp_url || existing.captureMaxWidth !== camCaptureWidth) {
      stopSingleWorker(cid);
    } else {
      existing.camera = nextCam;
      existing.stat.nama_kamera = nextCam.nama_kamera;
      existing.stat.aktif = Boolean(nextCam.aktif);
    }
  }

  for (const [cid, cam] of desired.entries()) {
    if (!workers.has(cid)) {
      const camCaptureWidth = normalizeCaptureMaxWidth(cam.capture_max_width ?? db.settings.capture_max_width);
      const runtime: WorkerRuntime = {
        camera: cam,
        captureMaxWidth: camCaptureWidth,
        stop: false,
        child: null,
        timeoutFlag: '-stimeout',
        frameTimestamps: [],
        stat: {
          camera_id: cam.id,
          nama_kamera: cam.nama_kamera,
          aktif: Boolean(cam.aktif),
          connected: false,
          fps: 0,
          frames_decoded: 0,
          raw_faces_seen: 0,
          dropped_filter: 0,
          faces_detected_total: 0,
          matched_dispatched: 0,
          anonymous_dispatched: 0,
          watchdog_restarts: 0,
          last_frame_at: null,
          last_face_at: null,
          last_detect_at: null,
          last_error: null,
        },
      };
      workers.set(cid, runtime);
      runCameraLoop(runtime, managerDeps).catch((err) => {
        console.error(`[RTSP][Cam #${cid}] Worker crash tak terduga:`, err);
        workers.delete(cid);
      });
    }
  }
}

export function startNodeRtspWorkers(deps: NodeWorkerDeps): void {
  managerDeps = deps;
  console.log('[FaceWorker] Memulai inisialisasi model Node WASM (@vladmandic/human) dan worker RTSP...');
  initNodeFaceAi()
    .then(() => {
      console.log('[FaceWorker] Model Human WASM siap (1024-dim embedding).');
    })
    .catch((err) => {
      console.error('[FaceWorker] Gagal memuat model Human WASM:', err);
    });
  refreshNodeRtspWorkers().catch(() => {});
  if (syncTimer) clearInterval(syncTimer);
  syncTimer = setInterval(() => {
    refreshNodeRtspWorkers().catch(() => {});
  }, 30_000);
}

export function getNodeWorkerStatus(db: AppDatabase): {
  engine: 'INSIGHTFACE_PYTHON' | 'NODE_WASM_LIVE' | 'IDLE';
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
  const engine: 'INSIGHTFACE_PYTHON' | 'NODE_WASM_LIVE' | 'IDLE' = pythonActive
    ? 'INSIGHTFACE_PYTHON'
    : workers.size > 0 || humanSingleton !== null
      ? 'NODE_WASM_LIVE'
      : 'IDLE';
  const indexedStudents = getCachedStudentFaceIndex(db.students).totalIndexed;
  const captureMaxWidth = normalizeCaptureMaxWidth(db.settings.capture_max_width);
  const captureJpegQuality = normalizeCaptureJpegQuality(db.settings.capture_jpeg_quality);

  const cameras: WorkerCameraStat[] = db.cameras.map((cam) => {
    const nodeWorker = workers.get(cam.id);
    if (nodeWorker) {
      return { ...nodeWorker.stat };
    }
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
    engine,
    node_env: process.env.NODE_ENV || 'development',
    timezone: 'Asia/Jakarta',
    server_time_wib: getJakartaNowParts().dateTimeStr,
    production_mode: Boolean(db.settings.production_mode),
    model_loaded: pythonActive ? true : Boolean(humanSingleton),
    expected_embedding_dims: pythonActive ? 512 : 1024,
    capture_max_width: captureMaxWidth,
    capture_jpeg_quality: captureJpegQuality,
    active_workers: cameras.filter((c) => c.connected).length,
    indexed_students: indexedStudents,
    cameras,
  };
}
