export interface WaGatewayHealthContract {
  online: boolean;
  engine: 'baileys-node' | 'unknown';
  active_browsers: number;
  max_chrome: number;
  accounts_total: number;
  accounts_connected: number;
  chromium_bin: string | null;
  xvfb_available: boolean;
  error?: string;
}

export function buildWaGatewayHeaders(token: string, hasBody: boolean): Record<string, string> {
  const headers: Record<string, string> = {};
  if (token.trim()) {
    headers['X-Internal-Token'] = token.trim();
  }
  if (hasBody) {
    headers['Content-Type'] = 'application/json';
  }
  return headers;
}

export function isLoopbackWaUrl(urlStr: string): boolean {
  try {
    const u = new URL(urlStr);
    return u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '::1';
  } catch {
    return false;
  }
}

export function parseWaGatewayHealthPayload(raw: Record<string, unknown>): WaGatewayHealthContract {
  const engine = raw.engine === 'baileys-node' ? 'baileys-node' : 'unknown';
  return {
    online: Boolean(raw.ok),
    engine,
    active_browsers: Number(raw.active_browsers ?? 0),
    max_chrome: Number(raw.max_chrome ?? 0),
    accounts_total: Number(raw.accounts_total ?? 0),
    accounts_connected: Number(raw.accounts_connected ?? 0),
    chromium_bin: typeof raw.chromium_bin === 'string' ? raw.chromium_bin : null,
    xvfb_available: Boolean(raw.xvfb_available),
  };
}
