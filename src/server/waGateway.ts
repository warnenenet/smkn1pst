import { APP_ROOT } from './envBootstrap.ts';
import { spawn, type ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import { capLogFileSize, DATA_DIR, loadDb, saveDb } from './store.ts';
import type { WaAccount, WaAccountStatus } from '../types';
import { getOrCreateInternalToken } from '../lib/internalToken.ts';
import { isTransientGatewayFetchError } from '../lib/waPhone.ts';
import {
  bootstrapSavedNodeSessions,
  deleteNodeAccount,
  getActiveNodeWaCount,
  getNodeQrState,
  pauseNodeAccount,
  reconnectNodeAccount,
  sendNodeWaMessage,
  startNodePairing,
  stopAllNodeWaSessions,
} from './waNodeFallback.ts';
import {
  applyWaQuotaResetIfDue,
  formatWaMessage,
  getJakartaNowParts,
  normalizeWaProvider,
  selectNextWaAccountRoundRobin,
} from '../lib/attendanceEngine.ts';

export interface PairingState {
  qrDataUrl: string | null;
  status: string;
  error: string | null;
  phoneNumber?: string | null;
  updatedAt: number | string;
}

export interface WaGatewayHealth {
  online: boolean;
  service_url: string;
  active_browsers: number;
  max_chrome: number;
  accounts_total: number;
  accounts_connected: number;
  chromium_bin: string | null;
  xvfb_available: boolean;
  error?: string;
}

// WA_GATEWAY_PORT & WA_GATEWAY_URL di-hardcode di kode (satu container = satu network namespace)
export const DEFAULT_WA_GATEWAY_PORT = 8003;
export const WA_GATEWAY_URL = 'http://127.0.0.1:8003';

let gatewayChild: ChildProcess | null = null;
let gatewayStopping = false;
let gatewayRestartTimer: NodeJS.Timeout | null = null;
let lastRoundRobinAccountId: number | null = null;

export function getRoundRobinCursorId(): number | null {
  return lastRoundRobinAccountId;
}

export function setRoundRobinCursorId(accountId: number | null): void {
  lastRoundRobinAccountId = accountId;
}

function getGatewayToken(): string {
  return getOrCreateInternalToken({ dataDir: DATA_DIR });
}

function isLocalGatewayUrl(urlStr: string): boolean {
  try {
    const u = new URL(urlStr);
    return u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '::1';
  } catch {
    return false;
  }
}

function isNodeFallbackEnabled(): boolean {
  return process.env.NODE_ENV !== 'test' && process.env.WA_NODE_FALLBACK !== '0';
}

function clearStaleFetchErrorsInDb(): void {
  const db = loadDb();
  let changed = false;
  for (const acc of db.wa_accounts) {
    if (isTransientGatewayFetchError(acc.last_error)) {
      acc.last_error = null;
      changed = true;
    }
  }
  if (changed) {
    saveDb(db);
  }
}

async function callWaGateway<T = Record<string, unknown>>(
  pathname: string,
  options: { method?: string; body?: Record<string, unknown>; timeoutMs?: number } = {}
): Promise<{ status: number; ok: boolean; data: T & { ok?: boolean; error?: string } }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 15_000);
  try {
    const headers: Record<string, string> = {};
    const token = getGatewayToken();
    if (token) {
      headers['X-Internal-Token'] = token;
    }
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }
    const resp = await fetch(`${WA_GATEWAY_URL}${pathname}`, {
      method: options.method || (options.body !== undefined ? 'POST' : 'GET'),
      headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      signal: controller.signal,
    });
    const text = await resp.text();
    let parsed: Record<string, unknown> = {};
    try {
      parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      parsed = { ok: false, error: text || `HTTP ${resp.status}` };
    }
    return {
      status: resp.status,
      ok: resp.ok && parsed.ok !== false,
      data: parsed as T & { ok?: boolean; error?: string },
    };
  } catch (err) {
    const rawMsg = err instanceof Error ? err.message : '';
    const msg =
      err instanceof Error && err.name === 'AbortError'
        ? 'Timeout menghubungi layanan WA Gateway (Baileys).'
        : isTransientGatewayFetchError(rawMsg) || !rawMsg
          ? 'Layanan WA Gateway Baileys (127.0.0.1:8003) belum aktif.'
          : rawMsg;
    return {
      status: 0,
      ok: false,
      data: { ok: false, error: msg } as T & { ok?: boolean; error?: string },
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function getWaGatewayHealth(): Promise<WaGatewayHealth> {
  const res = await callWaGateway<Partial<WaGatewayHealth>>('/health', { timeoutMs: 2000 });
  if (!res.ok) {
    if (res.status === 0 && isNodeFallbackEnabled()) {
      const db = loadDb();
      return {
        online: true,
        service_url: WA_GATEWAY_URL,
        active_browsers: getActiveNodeWaCount(),
        max_chrome: 3,
        accounts_total: db.wa_accounts.length,
        accounts_connected: db.wa_accounts.filter((a) => a.qr_connected).length,
        chromium_bin: 'node-baileys-builtin',
        xvfb_available: false,
      };
    }
    return {
      online: false,
      service_url: WA_GATEWAY_URL,
      active_browsers: 0,
      max_chrome: 3,
      accounts_total: 0,
      accounts_connected: 0,
      chromium_bin: null,
      xvfb_available: false,
      error: res.data.error,
    };
  }
  return {
    online: true,
    service_url: WA_GATEWAY_URL,
    active_browsers: Number(res.data.active_browsers ?? 0),
    max_chrome: Number(res.data.max_chrome ?? 3),
    accounts_total: Number(res.data.accounts_total ?? 0),
    accounts_connected: Number(res.data.accounts_connected ?? 0),
    chromium_bin: (res.data.chromium_bin as string | null) ?? null,
    xvfb_available: Boolean(res.data.xvfb_available),
  };
}

export async function ensureWaGatewayRunning(): Promise<void> {
  if (
    process.env.NODE_ENV === 'test' ||
    process.env.WA_GATEWAY_AUTO_SPAWN === '0' ||
    !isLocalGatewayUrl(WA_GATEWAY_URL)
  ) {
    return;
  }

  const health = await getWaGatewayHealth();
  if (health.online) {
    return;
  }
  if (gatewayChild && !gatewayChild.killed) {
    return;
  }

  const nodeGatewayEntry = path.join(APP_ROOT, 'services', 'wa-gateway-node', 'server.mjs');
  if (!fs.existsSync(nodeGatewayEntry)) {
    void bootstrapSavedNodeSessions();
    return;
  }

  clearStaleFetchErrorsInDb();

  const port = DEFAULT_WA_GATEWAY_PORT;
  getOrCreateInternalToken({ dataDir: DATA_DIR });

  const waStorageDir = path.join(DATA_DIR, 'wa_gateway');
  fs.mkdirSync(path.join(waStorageDir, 'baileys_auth'), { recursive: true });
  const logFile = path.join(waStorageDir, 'process.log');
  capLogFileSize(logFile, 2 * 1024 * 1024);
  const outFd = fs.openSync(logFile, 'a');

  gatewayStopping = false;
  const child = spawn(process.execPath, [nodeGatewayEntry], {
    cwd: APP_ROOT,
    stdio: ['ignore', outFd, outFd],
    env: {
      ...process.env,
      WA_GATEWAY_PORT: String(port),
      DATA_DIR,
      WA_STORAGE_DIR: waStorageDir,
    },
  });
  fs.closeSync(outFd);
  gatewayChild = child;

  console.log(`[WA-Gateway] Menjalankan Baileys WA Gateway pada http://127.0.0.1:${port} (storage=${waStorageDir})`);

  child.once('exit', (code, signal) => {
    if (gatewayChild === child) {
      gatewayChild = null;
    }
    if (!gatewayStopping && process.env.WA_GATEWAY_AUTO_SPAWN !== '0') {
      console.warn(`[WA-Gateway] Proses Baileys berhenti (code=${code ?? '-'}, signal=${signal ?? '-'}); coba hidupkan ulang dalam 8 dtk...`);
      if (gatewayRestartTimer) clearTimeout(gatewayRestartTimer);
      gatewayRestartTimer = setTimeout(() => {
        gatewayRestartTimer = null;
        void ensureWaGatewayRunning();
      }, 8000);
    }
  });
}

export function stopWaGatewayChild(): void {
  gatewayStopping = true;
  if (gatewayRestartTimer) {
    clearTimeout(gatewayRestartTimer);
    gatewayRestartTimer = null;
  }
  if (gatewayChild && !gatewayChild.killed) {
    try {
      gatewayChild.kill('SIGTERM');
    } catch {
      // ignore kill error
    }
    gatewayChild = null;
  }
  stopAllNodeWaSessions();
}

export async function ensureGatewayAccountForDbAccount(dbAccountId: number): Promise<number | null> {
  const db = loadDb();
  const acc = db.wa_accounts.find((a) => a.id === dbAccountId);
  if (!acc) return null;

  if (isTransientGatewayFetchError(acc.last_error)) {
    acc.last_error = null;
    saveDb(db);
  }

  if (acc.gateway_account_id) {
    const check = await callWaGateway<{ account?: { id: number } }>(`/accounts/${acc.gateway_account_id}`, {
      timeoutMs: 2500,
    });
    if (check.ok && check.data.account?.id) {
      return Number(check.data.account.id);
    }
    if (check.status === 0) {
      // Python gateway offline; pertahankan ID tersimpan
      return acc.gateway_account_id;
    }
  }

  const label = (acc.label || acc.phone_number || `WA Sekolah #${acc.id}`).trim();
  const created = await callWaGateway<{ id: number; status?: string; phone_number?: string | null }>('/accounts', {
    method: 'POST',
    body: {
      label,
      phone_number: acc.phone_number || undefined,
    },
    timeoutMs: 5000,
  });

  if (created.ok && created.data.id) {
    acc.gateway_account_id = Number(created.data.id);
    acc.last_error = null;
    saveDb(db);
    return acc.gateway_account_id;
  }

  if (created.status === 0 && isNodeFallbackEnabled()) {
    // Python gateway belum berjalan -> biarkan Node.js WA Web built-in engine menangani tanpa error palsu
    acc.last_error = null;
    saveDb(db);
    return null;
  }

  acc.last_error = created.data.error ?? 'Python WA Gateway belum aktif.';
  saveDb(db);
  return null;
}

export async function startGatewayPairing(
  dbAccountId: number,
  onQrUpdate?: (payload: Record<string, unknown>) => void
): Promise<PairingState> {
  const gid = await ensureGatewayAccountForDbAccount(dbAccountId);
  if (!gid) {
    if (isNodeFallbackEnabled()) {
      return await startNodePairing(dbAccountId, onQrUpdate);
    }
    const db = loadDb();
    const acc = db.wa_accounts.find((a) => a.id === dbAccountId);
    return {
      qrDataUrl: null,
      status: 'ERROR',
      error: acc?.last_error || 'Layanan Python WA Gateway belum berjalan. Cek npm run setup:school.',
      updatedAt: Date.now(),
    };
  }

  const qrRes = await getGatewayQrState(dbAccountId, onQrUpdate);
  if (qrRes.status === 'DISCONNECTED' || qrRes.status === 'ERROR') {
    const rec = await callWaGateway(`/accounts/${gid}/reconnect`, { method: 'POST', timeoutMs: 6000 });
    if (rec.status === 0 && isNodeFallbackEnabled()) {
      return await startNodePairing(dbAccountId, onQrUpdate);
    }
    return await getGatewayQrState(dbAccountId, onQrUpdate);
  }
  return qrRes;
}

export async function getGatewayQrState(
  dbAccountId: number,
  onQrUpdate?: (payload: Record<string, unknown>) => void
): Promise<PairingState> {
  const db = loadDb();
  const acc = db.wa_accounts.find((a) => a.id === dbAccountId);
  if (!acc) {
    return { qrDataUrl: null, status: 'ERROR', error: 'Akun tidak ditemukan.', updatedAt: Date.now() };
  }

  if (isTransientGatewayFetchError(acc.last_error)) {
    acc.last_error = null;
    saveDb(db);
  }

  let gid = acc.gateway_account_id ?? null;
  if (!gid) {
    gid = await ensureGatewayAccountForDbAccount(dbAccountId);
    if (!gid) {
      if (isNodeFallbackEnabled()) {
        return await getNodeQrState(dbAccountId, onQrUpdate);
      }
      return {
        qrDataUrl: null,
        status: 'ERROR',
        error: acc.last_error || 'Python WA Gateway belum siap.',
        updatedAt: Date.now(),
      };
    }
  }

  const res = await callWaGateway<{
    status?: string;
    qr_base64?: string | null;
    phone_number?: string | null;
    last_error?: string | null;
    updated_at?: string | null;
  }>(`/accounts/${gid}/qr`, { timeoutMs: 5000 });

  if (!res.ok) {
    if (res.status === 0 && isNodeFallbackEnabled()) {
      return await getNodeQrState(dbAccountId, onQrUpdate);
    }
    if (res.status === 404) {
      // Akun di-reset di gateway; buat ulang otomatis
      acc.gateway_account_id = null;
      acc.qr_connected = false;
      saveDb(db);
      const newGid = await ensureGatewayAccountForDbAccount(dbAccountId);
      if (newGid) {
        return getGatewayQrState(dbAccountId, onQrUpdate);
      }
    }
    return {
      qrDataUrl: null,
      status: 'ERROR',
      error: res.data.error || 'Gagal mengambil status QR dari Python WA Gateway.',
      updatedAt: Date.now(),
    };
  }

  const status = String(res.data.status || 'NEW');
  const phoneNumber = res.data.phone_number ? String(res.data.phone_number) : null;
  const lastError = res.data.last_error ? String(res.data.last_error) : null;

  let changed = false;
  if (status === 'CONNECTED') {
    if (!acc.qr_connected) {
      acc.qr_connected = true;
      changed = true;
    }
    if (phoneNumber && (!acc.phone_number || acc.phone_number.startsWith('WA ') || acc.phone_number.startsWith('628000'))) {
      acc.phone_number = phoneNumber;
      changed = true;
    }
    if (acc.last_error) {
      acc.last_error = null;
      changed = true;
    }
    if (changed) {
      saveDb(db);
      onQrUpdate?.({ event: 'wa_connected', account_id: dbAccountId, phone_number: acc.phone_number });
    }
  } else {
    if (lastError !== (acc.last_error ?? null)) {
      acc.last_error = lastError;
      changed = true;
    }
    if (status === 'DISCONNECTED' && acc.qr_connected) {
      acc.qr_connected = false;
      changed = true;
    }
    if (changed) {
      saveDb(db);
    }
  }

  return {
    qrDataUrl: res.data.qr_base64 ?? null,
    status,
    error: lastError,
    phoneNumber,
    updatedAt: res.data.updated_at || Date.now(),
  };
}

export async function reconnectGatewayAccount(
  dbAccountId: number,
  onQrUpdate?: (payload: Record<string, unknown>) => void
): Promise<PairingState> {
  const gid = await ensureGatewayAccountForDbAccount(dbAccountId);
  if (!gid) {
    if (isNodeFallbackEnabled()) {
      return await reconnectNodeAccount(dbAccountId, onQrUpdate);
    }
    return {
      qrDataUrl: null,
      status: 'ERROR',
      error: 'Python WA Gateway belum terhubung.',
      updatedAt: Date.now(),
    };
  }
  const rec = await callWaGateway(`/accounts/${gid}/reconnect`, { method: 'POST', timeoutMs: 6000 });
  if (rec.status === 0 && isNodeFallbackEnabled()) {
    return await reconnectNodeAccount(dbAccountId, onQrUpdate);
  }
  return getGatewayQrState(dbAccountId, onQrUpdate);
}

export async function syncGatewayAccountStatus(dbAccountId: number, nextStatus: WaAccountStatus): Promise<boolean> {
  const db = loadDb();
  const acc = db.wa_accounts.find((a) => a.id === dbAccountId);
  if (!acc) return false;

  acc.status = nextStatus;
  if (nextStatus !== 'PAUSED') {
    acc.last_error = null;
  }
  saveDb(db);

  if (nextStatus === 'PAUSED' || nextStatus === 'BANNED') {
    pauseNodeAccount(dbAccountId);
  }

  if (acc.gateway_account_id) {
    if (nextStatus === 'PAUSED' || nextStatus === 'BANNED') {
      await callWaGateway(`/accounts/${acc.gateway_account_id}/pause`, { method: 'POST', timeoutMs: 4000 });
    } else {
      await callWaGateway(`/accounts/${acc.gateway_account_id}/resume`, { method: 'POST', timeoutMs: 4000 });
    }
  }
  return true;
}

export async function deleteGatewayAccount(dbAccountId: number): Promise<boolean> {
  const db = loadDb();
  const idx = db.wa_accounts.findIndex((a) => a.id === dbAccountId);
  if (idx < 0) return false;
  const [removed] = db.wa_accounts.splice(idx, 1);
  saveDb(db);

  deleteNodeAccount(dbAccountId);
  if (removed.gateway_account_id) {
    await callWaGateway(`/accounts/${removed.gateway_account_id}`, { method: 'DELETE', timeoutMs: 4000 });
  }
  return true;
}

export async function dispatchWaMessage(
  account: WaAccount | undefined,
  providerRaw: string,
  apiKey: string,
  phoneNumberId: string,
  phone: string,
  text: string,
  isProductionMode = false
): Promise<{ sent: boolean; simulated: boolean; statusCode?: number; error?: string }> {
  const provider = normalizeWaProvider(providerRaw);
  const cleanPhone = phone.replace(/[^0-9]/g, '');
  if (!cleanPhone) {
    return { sent: false, simulated: false, error: 'Nomor tujuan tidak valid' };
  }

  if (provider === 'META_CLOUD' && apiKey && phoneNumberId) {
    const resp = await fetch(`https://graph.facebook.com/v20.0/${phoneNumberId}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: cleanPhone,
        type: 'text',
        text: { body: text },
      }),
    });
    if (!resp.ok) {
      return { sent: false, simulated: false, statusCode: resp.status, error: `Meta API HTTP ${resp.status}` };
    }
    return { sent: true, simulated: false };
  }

  if (provider === 'FONNTE' && apiKey) {
    const resp = await fetch('https://api.fonnte.com/send', {
      method: 'POST',
      headers: {
        Authorization: apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ target: cleanPhone, message: text }),
    });
    if (!resp.ok) {
      return { sent: false, simulated: false, statusCode: resp.status, error: `Fonnte HTTP ${resp.status}` };
    }
    return { sent: true, simulated: false };
  }

  if (provider === 'WABLAS' && apiKey) {
    const resp = await fetch('https://pati.wablas.com/api/send-message', {
      method: 'POST',
      headers: {
        Authorization: apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ phone: cleanPhone, message: text }),
    });
    if (!resp.ok) {
      return { sent: false, simulated: false, statusCode: resp.status, error: `WABLAS HTTP ${resp.status}` };
    }
    return { sent: true, simulated: false };
  }

  if (provider === 'WA_WEB' && account && account.qr_connected) {
    let gid = account.gateway_account_id ?? null;
    if (!gid) {
      gid = await ensureGatewayAccountForDbAccount(account.id);
    }
    let pythonOffline = !gid;
    if (gid) {
      const sendRes = await callWaGateway('/send', {
        method: 'POST',
        body: {
          account_id: gid,
          to: cleanPhone,
          message: text,
        },
        timeoutMs: 45_000,
      });
      if (sendRes.ok) {
        return { sent: true, simulated: false, statusCode: sendRes.status };
      }
      if (sendRes.status > 0) {
        return {
          sent: false,
          simulated: false,
          statusCode: sendRes.status,
          error: sendRes.data.error || `WA Gateway HTTP ${sendRes.status}`,
        };
      }
      pythonOffline = true;
    }

    if (pythonOffline && isNodeFallbackEnabled()) {
      const nodeRes = await sendNodeWaMessage(account.id, cleanPhone, text);
      if (nodeRes.sent) {
        return { sent: true, simulated: false, statusCode: 200 };
      }
      if (isProductionMode || nodeRes.statusCode === 422) {
        return {
          sent: false,
          simulated: false,
          statusCode: nodeRes.statusCode ?? 503,
          error: nodeRes.error || 'Sesi WhatsApp Web belum terhubung.',
        };
      }
    }

    if (isProductionMode) {
      return {
        sent: false,
        simulated: false,
        statusCode: 503,
        error: 'Layanan Python WA Gateway tidak merespons.',
      };
    }
  }

  if (isProductionMode) {
    return {
      sent: false,
      simulated: false,
      error: 'Gateway WA belum tersambung (scan QR WhatsApp Web Chromium atau isi API key di menu WhatsApp Gateway).',
    };
  }

  // Fallback aman hanya untuk mode demo / preview sebelum produksi
  return { sent: true, simulated: true };
}

export function startWaQueueWorker(onBroadcast?: (payload: Record<string, unknown>) => void): () => void {
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;

  const scheduleNext = () => {
    if (stopped) return;
    // Strategi anti-blokir: jeda acak 60–120 detik antar pengiriman
    const delayMs = 60_000 + Math.floor(Math.random() * 60_000);
    timer = setTimeout(async () => {
      try {
        const db = loadDb();
        const nowWib = getJakartaNowParts().dateTimeStr;
        let resetAny = false;
        for (const acc of db.wa_accounts) {
          if (applyWaQuotaResetIfDue(acc, nowWib)) {
            resetAny = true;
          }
        }
        const pending = db.wa_queue.find((q) => q.status === 'PENDING');
        if (pending) {
          const activeTpls = db.wa_templates.filter((t) => t.is_active);
          const tpl = activeTpls[Math.floor(Math.random() * activeTpls.length)];
          const msg = tpl
            ? formatWaMessage(tpl.template_text, pending.payload)
            : `Info Absensi ${pending.payload.nama}: ${pending.payload.status}`;

          const provider = normalizeWaProvider(db.settings.wa_provider);
          const rr = selectNextWaAccountRoundRobin(db.wa_accounts, lastRoundRobinAccountId, provider === 'WA_WEB');
          const candidates = rr.orderedCandidates;

          let usedAccount: WaAccount | undefined = candidates[0];
          let finalResult: { sent: boolean; simulated: boolean; statusCode?: number; error?: string } = {
            sent: false,
            simulated: false,
            error: 'Tidak ada akun WA aktif yang tersedia.',
          };

          if (candidates.length === 0) {
            finalResult = await dispatchWaMessage(
              undefined,
              provider,
              db.settings.wa_api_key,
              db.settings.wa_phone_number_id,
              pending.phone,
              msg,
              Boolean(db.settings.production_mode)
            );
          } else {
            // Round-Robin: coba kandidat utama; bila gagal sementara/rate-limit, failover ke nomor berikutnya di rotasi!
            for (const candidate of candidates) {
              usedAccount = candidate;
              lastRoundRobinAccountId = candidate.id;
              const attempt = await dispatchWaMessage(
                candidate,
                provider,
                db.settings.wa_api_key,
                db.settings.wa_phone_number_id,
                pending.phone,
                msg,
                Boolean(db.settings.production_mode)
              );
              finalResult = attempt;
              if (attempt.sent) {
                break;
              }
              if (attempt.statusCode === 503 || attempt.statusCode === 409) {
                candidate.qr_connected = false;
                candidate.last_error = attempt.error ?? 'Sesi terputus';
              }
              // Jika penolakan karena nomor tujuan invalid (422) atau anti-spam 24h di sisi gateway, tidak perlu coba semua nomor kecuali rate limit akun
              if (attempt.statusCode === 422) {
                break;
              }
            }
          }

          if (finalResult.sent) {
            pending.status = 'SENT';
            pending.sent_at = nowWib;
            pending.error_msg = null;
            if (usedAccount) {
              usedAccount.daily_count += 1;
              usedAccount.hourly_count += 1;
              usedAccount.last_error = null;
            }
            console.log(
              `[WA] Antrean #${pending.id} (${pending.phone}) SENT via Acc #${usedAccount?.id ?? '-'} (sim=${finalResult.simulated}, timeWIB=${nowWib})`
            );
          } else {
            pending.retry_count += 1;
            pending.error_msg = finalResult.error ?? 'Gagal mengirim';
            if (pending.retry_count >= 3) {
              pending.status = 'FAILED';
            }
            console.warn(
              `[WA] Antrean #${pending.id} gagal (retry=${pending.retry_count}): ${pending.error_msg}`
            );
          }
          saveDb(db);
          onBroadcast?.({ event: 'wa_queue_updated', queue_id: pending.id, status: pending.status });
        } else if (resetAny) {
          saveDb(db);
        }
      } catch (err) {
        console.error('[WA] Error di worker antrean WA:', err instanceof Error ? err.message : err);
      }
      scheduleNext();
    }, delayMs);
  };

  scheduleNext();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
