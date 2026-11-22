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
