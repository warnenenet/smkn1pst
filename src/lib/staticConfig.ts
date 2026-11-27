import path from 'path';

const MIME_BY_EXTENSION: Record<string, string> = {
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.cjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.wasm': 'application/wasm',
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.wav': 'audio/wav',
};

const NON_SPA_ASSET_EXT_RE = /\.(?:js|mjs|cjs|css|wasm|map|tsx?|jsx?|json|png|jpe?g|webp|gif|svg|ico|woff2?|ttf|eot|wav|mp3|mp4|webm)$/i;

export function getStaticAssetContentType(filePath: string): string | null {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_BY_EXTENSION[ext] ?? null;
}

export function shouldServeProductionBuild(params: {
  nodeEnv?: string;
  npmLifecycleEvent?: string;
  execArgv?: string[];
  argv?: string[];
  distIndexExists: boolean;
}): boolean {
  const nodeEnv = (params.nodeEnv ?? '').trim().toLowerCase();
  if (nodeEnv === 'production') {
    return true;
  }
  const execUsesTsx = (params.execArgv ?? []).some((arg) => arg.includes('tsx'));
  const argvUsesTsx = (params.argv ?? []).some((arg) => arg.includes('tsx'));
  if (params.npmLifecycleEvent === 'dev' || execUsesTsx || argvUsesTsx) {
    return false;
  }
  if (params.npmLifecycleEvent === 'start') {
    return true;
  }
  // Bare `node server.ts` (even if host environment leaves NODE_ENV=development) is a production/deploy entrypoint.
  return true;
}

export function isNonSpaResourcePath(reqPath: string): boolean {
  const cleanPath = reqPath.split('?')[0] ?? reqPath;
  if (
    cleanPath.startsWith('/assets/') ||
    cleanPath.startsWith('/api/') ||
    cleanPath.startsWith('/data/') ||
    cleanPath.startsWith('/src/') ||
    cleanPath.startsWith('/node_modules/') ||
    cleanPath.startsWith('/@vite/') ||
    cleanPath.startsWith('/@id/') ||
    cleanPath.startsWith('/@fs/') ||
    cleanPath === '/@react-refresh'
  ) {
    return true;
  }
  return NON_SPA_ASSET_EXT_RE.test(cleanPath);
}

export function getStaticCacheControl(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  if (normalized.endsWith('/index.html') || normalized === 'index.html') {
    return 'no-cache, no-store, must-revalidate';
  }
  if (normalized.includes('/assets/')) {
    return 'public, max-age=31536000, immutable';
  }
  return 'public, max-age=3600';
}

export interface ListenConfig {
  port: number;
  host?: string;
  autoPortFallback: boolean;
}

export function resolveListenConfig(params: {
  argv?: string[];
  env?: Record<string, string | undefined>;
}): ListenConfig {
  const argv = params.argv ?? [];
  const env = params.env ?? {};

  let cliPortRaw: string | undefined;
  let cliHostRaw: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    if (arg === '--port' || arg === '-p') {
      cliPortRaw = argv[i + 1];
      i++;
    } else if (arg.startsWith('--port=')) {
      cliPortRaw = arg.slice('--port='.length);
    } else if (arg === '--host') {
      cliHostRaw = argv[i + 1];
      i++;
    } else if (arg.startsWith('--host=')) {
      cliHostRaw = arg.slice('--host='.length);
    }
  }

  const parseValidPort = (val: string | undefined): number | null => {
    if (!val) return null;
    const n = Number(val.trim());
    if (Number.isInteger(n) && n >= 1 && n <= 65535) return n;
    return null;
  };

  const port = parseValidPort(cliPortRaw) ?? parseValidPort(env.PORT) ?? 3000;
  const host = (cliHostRaw ?? env.HOST)?.trim() || undefined;
  const autoPortFallback = env.AUTO_PORT_FALLBACK === '1' || env.AUTO_PORT_FALLBACK === 'true';

  return { port, host, autoPortFallback };
}

export function buildLocalWebBackendUrl(activePort: number, listenHost?: string): string {
  const safePort = Number.isInteger(activePort) && activePort >= 1 && activePort <= 65535 ? activePort : 3000;
  const rawHost = (listenHost ?? '').trim();
  if (
    !rawHost ||
    rawHost === '0.0.0.0' ||
    rawHost === '::' ||
    rawHost === '127.0.0.1' ||
    rawHost.toLowerCase() === 'localhost'
  ) {
    return `http://127.0.0.1:${safePort}`;
  }
  if (rawHost === '::1' || rawHost === '[::1]') {
    return `http://[::1]:${safePort}`;
  }
  return `http://${rawHost}:${safePort}`;
}

export function resolveCameraTelemetryConnected(params: {
  pyTelConnected?: boolean | null;
  aktif: boolean;
  pythonActive: boolean;
}): boolean {
  if (!params.aktif || !params.pythonActive) return false;
  return Boolean(params.pyTelConnected);
}

export interface BinaryProbeOps {
  existsSync: (filePath: string) => boolean;
  isFileSync: (filePath: string) => boolean;
  canExecuteSync: (filePath: string) => boolean;
  chmodSync?: (filePath: string, mode: number) => void;
}

export interface ExecutableResolution {
  binary: string;
  foundExecutable: boolean;
  candidatesChecked: string[];
  repairedPaths: string[];
  nonExecutablePaths: string[];
}

export function resolveExecutableBinary(params: {
  candidates: Array<string | null | undefined>;
  binaryName: string;
  envPath?: string;
  pathDelimiter?: string;
  ops: BinaryProbeOps;
}): ExecutableResolution {
  const { candidates, binaryName, envPath = '', pathDelimiter = path.delimiter, ops } = params;

  const rawList: string[] = [];
  for (const c of candidates) {
    const trimmed = typeof c === 'string' ? c.trim() : '';
    if (trimmed) rawList.push(trimmed);
  }
  if (envPath && binaryName) {
    for (const dir of envPath.split(pathDelimiter)) {
      const cleanDir = dir.trim();
      if (cleanDir) {
        rawList.push(path.join(cleanDir, binaryName));
      }
    }
  }

  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const item of rawList) {
    if (!seen.has(item)) {
      seen.add(item);
      ordered.push(item);
    }
  }

  const candidatesChecked: string[] = [];
  const repairedPaths: string[] = [];
  const nonExecutablePaths: string[] = [];

  for (const candidate of ordered) {
    candidatesChecked.push(candidate);
    let exists = false;
    try {
      exists = ops.existsSync(candidate) && ops.isFileSync(candidate);
    } catch {
      exists = false;
    }
    if (!exists) continue;

    let executable = false;
    try {
      executable = ops.canExecuteSync(candidate);
    } catch {
      executable = false;
    }

    if (!executable && ops.chmodSync) {
      try {
        ops.chmodSync(candidate, 0o755);
        executable = ops.canExecuteSync(candidate);
        if (executable) {
          repairedPaths.push(candidate);
        }
      } catch {
        executable = false;
      }
    }

    if (executable) {
      return {
        binary: candidate,
        foundExecutable: true,
        candidatesChecked,
        repairedPaths,
        nonExecutablePaths,
      };
    }

    nonExecutablePaths.push(candidate);
  }

  return {
    binary: binaryName,
    foundExecutable: false,
    candidatesChecked,
    repairedPaths,
    nonExecutablePaths,
  };
}

export function diagnoseFfmpegError(
  rawMessage: string,
  resolution: Pick<ExecutableResolution, 'binary' | 'nonExecutablePaths' | 'foundExecutable'>
): string {
  const msg = String(rawMessage || '').trim();
  const isEacces = /\bEACCES\b|permission denied/i.test(msg);
  if (isEacces) {
    const targetPath = resolution.nonExecutablePaths[0] || resolution.binary;
    return (
      `Izin eksekusi FFmpeg ditolak (EACCES) pada "${targetPath}". ` +
      `Jalankan di terminal server: chmod +x "${targetPath}" atau install FFmpeg sistem (apt install -y ffmpeg).`
    );
  }
  const isEnoent = /\bENOENT\b/i.test(msg) && /ffmpeg|spawn/i.test(msg);
  if (isEnoent || (!resolution.foundExecutable && resolution.nonExecutablePaths.length > 0)) {
    if (resolution.nonExecutablePaths.length > 0) {
      const blocked = resolution.nonExecutablePaths[0];
      return (
        `Binary FFmpeg ada di "${blocked}" namun tidak memiliki izin eksekusi (+x). ` +
        `Jalankan: chmod +x "${blocked}" atau install FFmpeg sistem (apt install -y ffmpeg).`
      );
    }
    return `Binary FFmpeg tidak ditemukan (${resolution.binary}). Install FFmpeg sistem (apt install -y ffmpeg) atau jalankan npm install.`;
  }
  return msg;
}

export type LivePreviewFpsMode = '5' | 'native';

export function buildFfmpegLivePreviewArgs(params: {
  url: string;
  fpsMode?: string;
  timeoutFlag?: '-stimeout' | '-rw_timeout';
  maxWidth?: number;
}): { args: string[]; mode: LivePreviewFpsMode; effectiveMaxWidth: number } {
  const mode: LivePreviewFpsMode = params.fpsMode === 'native' ? 'native' : '5';
  const timeoutFlag = params.timeoutFlag === '-rw_timeout' ? '-rw_timeout' : '-stimeout';
  const rawW = Number(params.maxWidth);
  const effectiveMaxWidth = Number.isFinite(rawW) && rawW >= 320 ? Math.min(3840, Math.round(rawW)) : 1280;

  const scaleFilter = `scale='min(${effectiveMaxWidth},iw)':-2`;
  const vf = mode === 'native' ? scaleFilter : `fps=5,${scaleFilter}`;

  return {
    mode,
    effectiveMaxWidth,
    args: [
      '-hide_banner',
      '-loglevel',
      'error',
      '-threads',
      '2',
      '-rtsp_transport',
      'tcp',
      timeoutFlag,
      '7000000',
      '-i',
      params.url,
      '-vf',
      vf,
      '-q:v',
      '5',
      '-f',
      'image2pipe',
      '-vcodec',
      'mjpeg',
      'pipe:1',
    ],
  };
}

export function extractRgbaLumaSample(rgba: Uint8Array, sampleCount = 64): Uint8Array {
  if (!rgba || rgba.length < 4 || sampleCount <= 0) return new Uint8Array(0);
  const totalPixels = Math.floor(rgba.length / 4);
  const count = Math.min(sampleCount, totalPixels);
  const out = new Uint8Array(count);
  const step = Math.max(1, Math.floor(totalPixels / count));
  for (let i = 0; i < count; i++) {
    const pxIdx = Math.min(totalPixels - 1, i * step) * 4;
    out[i] = Math.round(0.299 * rgba[pxIdx] + 0.587 * rgba[pxIdx + 1] + 0.114 * rgba[pxIdx + 2]);
  }
  return out;
}

export function computeFrameMotionDeltaRatio(prevSample: Uint8Array | null, curSample: Uint8Array): number {
  if (!prevSample || prevSample.length === 0 || prevSample.length !== curSample.length) {
    return 1;
  }
  let diffSum = 0;
  for (let i = 0; i < curSample.length; i++) {
    diffSum += Math.abs(curSample[i] - prevSample[i]);
  }
  return diffSum / (curSample.length * 255);
}

export function shouldScanMotionFrame(
  prevSample: Uint8Array | null,
  curSample: Uint8Array,
  elapsedSinceLastScanMs: number,
  options?: {
    meanDeltaMin?: number;
    pixelDeltaThreshold?: number;
    changedCellRatioMin?: number;
    heartbeatIntervalMs?: number;
  }
): boolean {
  if (!prevSample || prevSample.length === 0 || prevSample.length !== curSample.length) {
    return true;
  }
  const heartbeatMs = options?.heartbeatIntervalMs ?? 1500;
  if (elapsedSinceLastScanMs >= heartbeatMs) {
    return true;
  }
  const meanDeltaMin = options?.meanDeltaMin ?? 0.006;
  const pxThresh = options?.pixelDeltaThreshold ?? 18;
  const cellRatioMin = options?.changedCellRatioMin ?? 0.03;

  let diffSum = 0;
  let changedCells = 0;
  for (let i = 0; i < curSample.length; i++) {
    const d = Math.abs(curSample[i] - prevSample[i]);
    diffSum += d;
    if (d >= pxThresh) changedCells += 1;
  }
  const meanDelta = diffSum / (curSample.length * 255);
  const changedRatio = changedCells / curSample.length;
  return meanDelta >= meanDeltaMin || changedRatio >= cellRatioMin;
}

export function parseSemverTuple(raw: string | null | undefined): [number, number, number] | null {
  const clean = String(raw ?? '').trim().replace(/^v/i, '');
  const m = clean.match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

export function compareSemver(a: string | null | undefined, b: string | null | undefined): number {
  const ta = parseSemverTuple(a);
  const tb = parseSemverTuple(b);
  if (!ta && !tb) return 0;
  if (!ta) return -1;
  if (!tb) return 1;
  for (let i = 0; i < 3; i++) {
    if (ta[i] !== tb[i]) return ta[i] > tb[i] ? 1 : -1;
  }
  return 0;
}

export function isNewerVersionAvailable(localVersion: string | null | undefined, remoteVersion: string | null | undefined): boolean {
  const localTuple = parseSemverTuple(localVersion);
  const remoteTuple = parseSemverTuple(remoteVersion);
  if (!localTuple || !remoteTuple) return false;
  return compareSemver(remoteVersion, localVersion) > 0;
}

