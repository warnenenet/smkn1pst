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
  if (nodeEnv === 'development' || params.npmLifecycleEvent === 'dev') {
    return false;
  }
  const execUsesTsx = (params.execArgv ?? []).some((arg) => arg.includes('tsx'));
  const argvUsesTsx = (params.argv ?? []).some((arg) => arg.includes('tsx'));
  if (execUsesTsx || argvUsesTsx) {
    return false;
  }
  return params.distIndexExists;
}

export function isNonSpaResourcePath(reqPath: string): boolean {
  const cleanPath = reqPath.split('?')[0] ?? reqPath;
  if (
    cleanPath.startsWith('/assets/') ||
    cleanPath.startsWith('/api/') ||
    cleanPath.startsWith('/data/') ||
    cleanPath.startsWith('/src/')
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
