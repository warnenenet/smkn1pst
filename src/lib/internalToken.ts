import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

export const CONTAINER_INTERNAL_TOKEN_PATH = '/app/storage/secrets/internal_token';
export const CONTAINER_RUNTIME_ENV_PATH = '/app/storage/secrets/runtime.env';

let cachedToken: string | null = null;
let cachedPath: string | null = null;

export function resolveInternalTokenFilePath(options: {
  dataDir?: string;
  containerTokenPath?: string;
} = {}): string {
  const containerPath = options.containerTokenPath ?? CONTAINER_INTERNAL_TOKEN_PATH;
  try {
    if (fs.existsSync(containerPath) && fs.statSync(containerPath).size > 0) {
      return containerPath;
    }
  } catch {
    // ignore stat/exists errors and fall back to dataDir
  }

  if (options.dataDir) {
    return path.join(path.resolve(options.dataDir), 'secrets', 'internal_token');
  }

  return containerPath;
}

export function readInternalTokenFromFile(filePath: string): string | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf8').trim();
    return raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
}

export function getOrCreateInternalToken(options: {
  dataDir?: string;
  containerTokenPath?: string;
  forceRefresh?: boolean;
} = {}): string {
  const tokenPath = resolveInternalTokenFilePath(options);
  if (!options.forceRefresh && cachedToken && cachedPath === tokenPath) {
    return cachedToken;
  }

  const existing = readInternalTokenFromFile(tokenPath);
  if (existing) {
    try {
      fs.chmodSync(tokenPath, 0o600);
    } catch {
      // ignore chmod errors on unsupported filesystems
    }
    cachedToken = existing;
    cachedPath = tokenPath;
    return existing;
  }

  // Fallback otomatis bila dijalankan di luar container Docker (tanpa entrypoint.sh)
  const dir = path.dirname(tokenPath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const generated = crypto.randomBytes(48).toString('hex');
  fs.writeFileSync(tokenPath, `${generated}\n`, { encoding: 'utf8', mode: 0o600 });
  try {
    fs.chmodSync(tokenPath, 0o600);
  } catch {
    // ignore chmod error
  }
  cachedToken = generated;
  cachedPath = tokenPath;
  return generated;
}

export function resetInternalTokenCacheForTests(): void {
  cachedToken = null;
  cachedPath = null;
}
