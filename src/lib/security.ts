import crypto from 'crypto';
import type { User } from '../types';

const WEAK_PASSWORDS = new Set([
  'admin',
  'admin123',
  'admin1234',
  'administrator',
  'password',
  'password123',
  '123456',
  '12345678',
  '123456789',
  'qwerty123',
  'sekolah123',
  'bk123',
  'guru123',
  'rahasia123',
]);

export function hasActiveAdminUser(users: readonly Pick<User, 'role' | 'is_active' | 'password_hash'>[]): boolean {
  return users.some(
    (u) => u.role === 'ADMIN' && u.is_active && typeof u.password_hash === 'string' && u.password_hash.includes(':')
  );
}

export function isStrongSetupPassword(password: unknown): { valid: boolean; reason?: string } {
  if (typeof password !== 'string') {
    return { valid: false, reason: 'Password wajib diisi.' };
  }
  const trimmed = password.trim();
  if (trimmed.length < 8) {
    return { valid: false, reason: 'Password minimal 8 karakter agar aman dari serangan brute-force.' };
  }
  if (trimmed.length > 128) {
    return { valid: false, reason: 'Password maksimal 128 karakter.' };
  }
  if (WEAK_PASSWORDS.has(trimmed.toLowerCase())) {
    return { valid: false, reason: 'Password terlalu umum/mudah ditebak. Gunakan kombinasi huruf, angka, atau simbol.' };
  }
  return { valid: true };
}

export function timingSafeStringEqual(a: string, b: string): boolean {
  const hashA = crypto.createHash('sha256').update(a).digest();
  const hashB = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(hashA, hashB) && a.length === b.length;
}

export function validateRtspStreamUrl(
  rawUrl: unknown,
  opts: { allowDummy?: boolean } = {}
): { valid: boolean; url: string; reason?: string } {
  if (typeof rawUrl !== 'string') {
    return { valid: false, url: '', reason: 'URL kamera harus berupa teks.' };
  }
  const trimmed = rawUrl.trim();
  if (!trimmed || trimmed.length > 512) {
    return { valid: false, url: '', reason: 'URL kamera kosong atau melebihi 512 karakter.' };
  }
  if (/[\r\n\0]/.test(trimmed) || trimmed.startsWith('-')) {
    return { valid: false, url: '', reason: 'Format URL RTSP mengandung karakter tidak valid.' };
  }
  if (opts.allowDummy && /^dummy:\/\/[a-zA-Z0-9_.-]+$/i.test(trimmed)) {
    return { valid: true, url: trimmed };
  }
  if (!/^rtsps?:\/\//i.test(trimmed)) {
    return { valid: false, url: '', reason: 'URL stream wajib diawali rtsp:// atau rtsps://.' };
  }
  try {
    const parsed = new URL(trimmed);
    if ((parsed.protocol !== 'rtsp:' && parsed.protocol !== 'rtsps:') || !parsed.hostname) {
      return { valid: false, url: '', reason: 'Hostname kamera RTSP tidak valid.' };
    }
    return { valid: true, url: trimmed };
  } catch {
    return { valid: false, url: '', reason: 'Format URL RTSP tidak valid.' };
  }
}

function isLoopbackAddress(addr: string | undefined | null): boolean {
  if (!addr) return false;
  const norm = addr.trim().toLowerCase();
  return norm === '127.0.0.1' || norm === '::1' || norm === '::ffff:127.0.0.1';
}

export function isAuthorizedInternalRequest(params: {
  remoteAddress: string | undefined | null;
  headers: Record<string, string | string[] | undefined>;
  expectedToken?: string | null;
}): boolean {
  const { remoteAddress, headers, expectedToken } = params;
  const rawTokenHeader = headers['x-internal-token'];
  const providedToken = Array.isArray(rawTokenHeader) ? rawTokenHeader[0] : rawTokenHeader;
  const configuredToken = (expectedToken ?? '').trim();

  if (configuredToken.length > 0 && typeof providedToken === 'string' && providedToken.length > 0) {
    if (timingSafeStringEqual(providedToken.trim(), configuredToken)) {
      return true;
    }
  }

  // Izinkan koneksi loopback langsung dari sidecar Python lokal tanpa proxy forwarding eksternal
  const hasProxyForwarding = Boolean(
    headers['x-forwarded-for'] || headers['x-real-ip'] || headers['forwarded'] || headers['cf-connecting-ip']
  );
  if (isLoopbackAddress(remoteAddress) && !hasProxyForwarding) {
    return true;
  }

  return false;
}

export function isSameOriginMutationRequest(params: {
  method: string;
  originHeader?: string | string[];
  hostHeader?: string | string[];
  forwardedHostHeader?: string | string[];
}): boolean {
  const method = params.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
    return true;
  }
  const rawOrigin = Array.isArray(params.originHeader) ? params.originHeader[0] : params.originHeader;
  if (!rawOrigin || rawOrigin === 'null') {
    return !rawOrigin;
  }
  const rawHost = Array.isArray(params.forwardedHostHeader)
    ? params.forwardedHostHeader[0]
    : params.forwardedHostHeader || (Array.isArray(params.hostHeader) ? params.hostHeader[0] : params.hostHeader);
  if (!rawHost) return false;
  const expectedHost = rawHost.split(',')[0].trim().toLowerCase();
  try {
    const originHost = new URL(rawOrigin).host.toLowerCase();
    return originHost === expectedHost;
  } catch {
    return false;
  }
}

export function buildSessionCookieHeader(params: {
  cookieName: string;
  token: string;
  maxAgeSec: number;
  isHttps: boolean;
}): string {
  const encoded = encodeURIComponent(params.token);
  if (params.isHttps) {
    return `${params.cookieName}=${encoded}; HttpOnly; Secure; SameSite=None; Partitioned; Path=/; Max-Age=${params.maxAgeSec}`;
  }
  return `${params.cookieName}=${encoded}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${params.maxAgeSec}`;
}

export interface RateLimiter {
  checkAndConsume: (key: string, nowMs?: number) => { allowed: boolean; remaining: number; retryAfterSec: number };
  reset: (key: string) => void;
}

export function createRateLimiter(maxAttempts: number, windowMs: number): RateLimiter {
  const entries = new Map<string, { count: number; resetAt: number }>();

  const prune = (nowMs: number) => {
    if (entries.size < 500) return;
    for (const [k, v] of entries.entries()) {
      if (v.resetAt <= nowMs) entries.delete(k);
    }
  };

  return {
    checkAndConsume(key: string, nowMs = Date.now()) {
      prune(nowMs);
      const current = entries.get(key);
      if (!current || current.resetAt <= nowMs) {
        entries.set(key, { count: 1, resetAt: nowMs + windowMs });
        return {
          allowed: true,
          remaining: Math.max(0, maxAttempts - 1),
          retryAfterSec: Math.ceil(windowMs / 1000),
        };
      }
      if (current.count >= maxAttempts) {
        return {
          allowed: false,
          remaining: 0,
          retryAfterSec: Math.max(1, Math.ceil((current.resetAt - nowMs) / 1000)),
        };
      }
      current.count += 1;
      return {
        allowed: true,
        remaining: Math.max(0, maxAttempts - current.count),
        retryAfterSec: Math.max(1, Math.ceil((current.resetAt - nowMs) / 1000)),
      };
    },
    reset(key: string) {
      entries.delete(key);
    },
  };
}
