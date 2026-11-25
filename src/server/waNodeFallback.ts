import fs from 'fs';
import path from 'path';
import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
  type WASocket,
} from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import pino from 'pino';
import { WA_AUTH_DIR, loadDb, saveDb } from './store.ts';
import { cleanPhoneDigits, extractPhoneFromWaJid } from '../lib/waPhone.ts';

export interface NodePairingState {
  qrDataUrl: string | null;
  status: string;
  error: string | null;
  phoneNumber?: string | null;
  updatedAt: number | string;
}

interface NodeWaSession {
  accountId: number;
  sock: WASocket | null;
  status: 'NEW' | 'QR_READY' | 'CONNECTED' | 'DISCONNECTED' | 'PAUSED' | 'ERROR';
  qrDataUrl: string | null;
  phoneNumber: string | null;
  error: string | null;
  updatedAt: number;
  startPromise: Promise<void> | null;
  reconnectTimer: NodeJS.Timeout | null;
  reconnectAttempts: number;
  manualClose: boolean;
  onBroadcast?: (payload: Record<string, unknown>) => void;
}

const sessions = new Map<number, NodeWaSession>();
const silentLogger = pino({ level: 'silent' });
let cachedWaVersion: { version: [number, number, number]; fetchedAt: number } | null = null;
const FALLBACK_WA_VERSION: [number, number, number] = [2, 3000, 1043857760];

async function getWaProtocolVersion(): Promise<[number, number, number]> {
  if (cachedWaVersion && Date.now() - cachedWaVersion.fetchedAt < 3600_000) {
    return cachedWaVersion.version;
  }
  try {
    const res = await Promise.race([
      fetchLatestBaileysVersion(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('version_timeout')), 4000)),
    ]);
    if (Array.isArray(res?.version) && res.version.length === 3) {
      cachedWaVersion = {
        version: [Number(res.version[0]), Number(res.version[1]), Number(res.version[2])],
        fetchedAt: Date.now(),
      };
      return cachedWaVersion.version;
    }
  } catch {
    // Gunakan fallback version terbaru agar koneksi QR tetap instan
  }
  return cachedWaVersion?.version ?? FALLBACK_WA_VERSION;
}

function getAuthDir(accountId: number): string {
  return path.join(WA_AUTH_DIR, `acc_${accountId}`);
}

function getOrCreateSession(accountId: number): NodeWaSession {
  let s = sessions.get(accountId);
  if (!s) {
    s = {
      accountId,
      sock: null,
      status: 'NEW',
      qrDataUrl: null,
      phoneNumber: null,
      error: null,
      updatedAt: Date.now(),
      startPromise: null,
      reconnectTimer: null,
      reconnectAttempts: 0,
      manualClose: false,
    };
    sessions.set(accountId, s);
  }
  return s;
}

function closeSessionSocket(s: NodeWaSession, manual = true): void {
  s.manualClose = manual;
  if (s.reconnectTimer) {
    clearTimeout(s.reconnectTimer);
    s.reconnectTimer = null;
  }
  if (s.sock) {
    try {
      s.sock.ev.removeAllListeners('connection.update');
      s.sock.ev.removeAllListeners('creds.update');
      s.sock.end(undefined);
    } catch {
      // ignore socket cleanup error
    }
    s.sock = null;
  }
}

function syncDbOnConnected(accountId: number, linkedPhone: string | null, broadcast?: (payload: Record<string, unknown>) => void): void {
  const db = loadDb();
  const acc = db.wa_accounts.find((a) => a.id === accountId);
  if (!acc) return;

  let changed = false;
  if (!acc.qr_connected) {
    acc.qr_connected = true;
    changed = true;
  }
  if (linkedPhone && (!acc.phone_number || acc.phone_number.startsWith('WA ') || acc.phone_number.startsWith('628000'))) {
    acc.phone_number = linkedPhone;
    changed = true;
  }
  if (acc.last_error) {
    acc.last_error = null;
    changed = true;
  }
  if (changed) {
    saveDb(db);
    broadcast?.({ event: 'wa_connected', account_id: accountId, phone_number: acc.phone_number });
  }
}

function syncDbErrorOrDisconnected(accountId: number, errorMsg: string | null, markDisconnected = false): void {
  const db = loadDb();
  const acc = db.wa_accounts.find((a) => a.id === accountId);
  if (!acc) return;

  let changed = false;
  if (markDisconnected && acc.qr_connected) {
    acc.qr_connected = false;
    changed = true;
  }
  if (errorMsg !== (acc.last_error ?? null)) {
    acc.last_error = errorMsg;
    changed = true;
  }
  if (changed) {
    saveDb(db);
  }
}

async function startSocket(accountId: number, onBroadcast?: (payload: Record<string, unknown>) => void): Promise<NodeWaSession> {
  const s = getOrCreateSession(accountId);
  if (onBroadcast) s.onBroadcast = onBroadcast;

  if (s.status === 'CONNECTED' && s.sock) {
    return s;
  }
  if (s.startPromise) {
    await s.startPromise;
    return s;
  }

  s.startPromise = (async () => {
    closeSessionSocket(s, false);
    s.manualClose = false;
    s.status = 'NEW';
    s.error = null;
    s.updatedAt = Date.now();

    const authDir = getAuthDir(accountId);
    fs.mkdirSync(authDir, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    const version = await getWaProtocolVersion();

    const sock = makeWASocket({
      version,
      auth: state,
      logger: silentLogger,
      browser: Browsers.ubuntu('Chrome'),
      printQRInTerminal: false,
      markOnlineOnConnect: false,
      syncFullHistory: false,
      connectTimeoutMs: 25_000,
    });

    s.sock = sock;
    sock.ev.on('creds.update', () => {
      saveCreds().catch(() => {});
    });

    sock.ev.on('connection.update', async (update) => {
      if (s.sock !== sock) return;

      if (update.qr) {
        try {
          const dataUrl = await QRCode.toDataURL(update.qr, {
            width: 320,
            margin: 2,
            color: { dark: '#0f172a', light: '#ffffff' },
          });
          s.qrDataUrl = dataUrl;
          s.status = 'QR_READY';
          s.error = null;
          s.updatedAt = Date.now();
          syncDbErrorOrDisconnected(accountId, null, false);
        } catch (qrErr) {
          s.status = 'ERROR';
          s.error = qrErr instanceof Error ? qrErr.message : 'Gagal membuat gambar QR.';
          s.updatedAt = Date.now();
        }
      }

      if (update.connection === 'open') {
        const linkedPhone = extractPhoneFromWaJid(sock.user?.id);
        s.status = 'CONNECTED';
        s.qrDataUrl = null;
        s.phoneNumber = linkedPhone;
        s.error = null;
        s.reconnectAttempts = 0;
        s.updatedAt = Date.now();
        syncDbOnConnected(accountId, linkedPhone, s.onBroadcast);
        console.log(`[WA-Node] Akun #${accountId} terhubung ke WhatsApp Web (${linkedPhone ?? '-'}).`);
      }

      if (update.connection === 'close') {
        const rawErr = update.lastDisconnect?.error as { output?: { statusCode?: number }; message?: string } | undefined;
        const statusCode = rawErr?.output?.statusCode;
        s.sock = null;

        if (s.manualClose) {
          return;
        }

        // Logged out atau sesi rusak total -> hapus auth agar bisa scan QR ulang dengan bersih
        if (statusCode === DisconnectReason.loggedOut || statusCode === DisconnectReason.badSession) {
          s.status = 'DISCONNECTED';
          s.qrDataUrl = null;
          s.error = statusCode === DisconnectReason.loggedOut
            ? 'Sesi WhatsApp logout. Silakan scan ulang QR.'
            : 'Sesi WhatsApp kedaluwarsa. Silakan scan ulang QR.';
          s.updatedAt = Date.now();
          try {
            fs.rmSync(authDir, { recursive: true, force: true });
          } catch {
            // ignore rm error
          }
          syncDbErrorOrDisconnected(accountId, s.error, true);
          return;
        }

        // 515 restartRequired selalu muncul sesaat setelah QR berhasil di-scan -> auto-reconnect instan
        const shouldAutoRestart =
          statusCode === DisconnectReason.restartRequired ||
          statusCode === DisconnectReason.connectionLost ||
          statusCode === DisconnectReason.connectionClosed ||
          statusCode === DisconnectReason.timedOut ||
          s.reconnectAttempts < 4;

        if (shouldAutoRestart && s.reconnectAttempts < 6) {
          s.reconnectAttempts += 1;
          const delayMs = statusCode === DisconnectReason.restartRequired ? 400 : 2000;
          s.status = statusCode === DisconnectReason.restartRequired ? 'NEW' : s.status;
          s.error = null;
          s.updatedAt = Date.now();
          if (s.reconnectTimer) clearTimeout(s.reconnectTimer);
          s.reconnectTimer = setTimeout(() => {
            s.reconnectTimer = null;
            void startSocket(accountId, s.onBroadcast).catch(() => {});
          }, delayMs);
          return;
        }

        s.status = 'ERROR';
        s.error = rawErr?.message || `Koneksi WhatsApp Web terputus (kode ${statusCode ?? '-'}).`;
        s.updatedAt = Date.now();
        syncDbErrorOrDisconnected(accountId, s.error, false);
      }
    });
  })().finally(() => {
    s.startPromise = null;
  });

  await s.startPromise;
  return s;
}

async function waitForQrOrConnected(s: NodeWaSession, maxWaitMs = 6000): Promise<void> {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    if (s.status === 'QR_READY' || s.status === 'CONNECTED' || s.status === 'ERROR' || s.status === 'DISCONNECTED') {
      return;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
}

export async function startNodePairing(
  dbAccountId: number,
  onBroadcast?: (payload: Record<string, unknown>) => void
): Promise<NodePairingState> {
  const s = getOrCreateSession(dbAccountId);
  if (s.status === 'CONNECTED' && s.sock) {
    return {
      qrDataUrl: null,
      status: 'CONNECTED',
      error: null,
      phoneNumber: s.phoneNumber,
      updatedAt: s.updatedAt,
    };
  }
  if (s.status === 'QR_READY' && s.qrDataUrl && s.sock) {
    return {
      qrDataUrl: s.qrDataUrl,
      status: 'QR_READY',
      error: null,
      phoneNumber: s.phoneNumber,
      updatedAt: s.updatedAt,
    };
  }

  try {
    await startSocket(dbAccountId, onBroadcast);
    await waitForQrOrConnected(s, 6500);
  } catch (err) {
    s.status = 'ERROR';
    s.error = err instanceof Error ? err.message : 'Gagal memulai sesi WhatsApp Web.';
  }

  return {
    qrDataUrl: s.qrDataUrl,
    status: s.status,
    error: s.error,
    phoneNumber: s.phoneNumber,
    updatedAt: s.updatedAt,
  };
}

export async function getNodeQrState(
  dbAccountId: number,
  onBroadcast?: (payload: Record<string, unknown>) => void
): Promise<NodePairingState> {
  const db = loadDb();
  const acc = db.wa_accounts.find((a) => a.id === dbAccountId);
  if (!acc) {
    return { qrDataUrl: null, status: 'ERROR', error: 'Akun tidak ditemukan.', updatedAt: Date.now() };
  }

  const s = getOrCreateSession(dbAccountId);
  if (onBroadcast) s.onBroadcast = onBroadcast;

  if (!s.sock && !s.startPromise && !s.reconnectTimer && s.status !== 'PAUSED') {
    if (s.status === 'NEW' || s.status === 'DISCONNECTED' || s.status === 'ERROR') {
      try {
        await startSocket(dbAccountId, onBroadcast);
        await waitForQrOrConnected(s, 4500);
      } catch (err) {
        s.status = 'ERROR';
        s.error = err instanceof Error ? err.message : 'Gagal menyiapkan QR WhatsApp Web.';
      }
    }
  }

  if (s.status === 'CONNECTED') {
    syncDbOnConnected(dbAccountId, s.phoneNumber, onBroadcast);
  }

  return {
    qrDataUrl: s.qrDataUrl,
    status: s.status,
    error: s.error,
    phoneNumber: s.phoneNumber,
    updatedAt: s.updatedAt,
  };
}

export async function reconnectNodeAccount(
  dbAccountId: number,
  onBroadcast?: (payload: Record<string, unknown>) => void
): Promise<NodePairingState> {
  const s = getOrCreateSession(dbAccountId);
  closeSessionSocket(s, true);
  s.reconnectAttempts = 0;
  s.qrDataUrl = null;
  s.error = null;
  s.status = 'NEW';
  return startNodePairing(dbAccountId, onBroadcast);
}

export function pauseNodeAccount(dbAccountId: number): void {
  const s = sessions.get(dbAccountId);
  if (!s) return;
  closeSessionSocket(s, true);
  s.status = 'PAUSED';
  s.qrDataUrl = null;
}

export function deleteNodeAccount(dbAccountId: number): void {
  const s = sessions.get(dbAccountId);
  if (s) {
    closeSessionSocket(s, true);
    sessions.delete(dbAccountId);
  }
  try {
    fs.rmSync(getAuthDir(dbAccountId), { recursive: true, force: true });
  } catch {
    // ignore rm error
  }
}

export async function sendNodeWaMessage(
  dbAccountId: number,
  toPhone: string,
  text: string
): Promise<{ sent: boolean; statusCode?: number; error?: string }> {
  const cleanTo = cleanPhoneDigits(toPhone);
  if (cleanTo.length < 9) {
    return { sent: false, statusCode: 422, error: 'Nomor tujuan tidak valid.' };
  }

  const s = getOrCreateSession(dbAccountId);
  const authDir = getAuthDir(dbAccountId);
  if (!s.sock || s.status !== 'CONNECTED') {
    if (fs.existsSync(path.join(authDir, 'creds.json'))) {
      try {
        await startSocket(dbAccountId);
        const deadline = Date.now() + 15_000;
        while (Date.now() < deadline && s.status !== 'CONNECTED' && s.status !== 'ERROR' && s.status !== 'DISCONNECTED') {
          await new Promise((r) => setTimeout(r, 250));
        }
      } catch {
        // handled below
      }
    }
  }

  if (!s.sock || s.status !== 'CONNECTED') {
    return {
      sent: false,
      statusCode: 503,
      error: s.error || 'Sesi WhatsApp Web belum terhubung (silakan scan QR).',
    };
  }

  const jid = `${cleanTo}@s.whatsapp.net`;
  try {
    if (typeof s.sock.onWhatsApp === 'function') {
      const checks = await s.sock.onWhatsApp(jid).catch(() => null);
      if (Array.isArray(checks) && checks.length > 0 && checks[0] && checks[0].exists === false) {
        return {
          sent: false,
          statusCode: 422,
          error: `Nomor tujuan ${cleanTo} tidak terdaftar di WhatsApp.`,
        };
      }
    }
    await s.sock.sendMessage(jid, { text });
    return { sent: true, statusCode: 200 };
  } catch (err) {
    return {
      sent: false,
      statusCode: 502,
      error: err instanceof Error ? err.message : 'Gagal mengirim pesan WhatsApp Web.',
    };
  }
}

export function getActiveNodeWaCount(): number {
  let count = 0;
  for (const s of sessions.values()) {
    if (s.sock && (s.status === 'CONNECTED' || s.status === 'QR_READY' || s.status === 'NEW')) {
      count += 1;
    }
  }
  return count;
}

export async function bootstrapSavedNodeSessions(
  onBroadcast?: (payload: Record<string, unknown>) => void
): Promise<void> {
  if (process.env.NODE_ENV === 'test' || process.env.WA_NODE_FALLBACK === '0') {
    return;
  }
  const db = loadDb();
  for (const acc of db.wa_accounts) {
    if (acc.qr_connected && acc.status !== 'PAUSED' && acc.status !== 'BANNED') {
      const credsPath = path.join(getAuthDir(acc.id), 'creds.json');
      if (fs.existsSync(credsPath)) {
        void startSocket(acc.id, onBroadcast).catch(() => {});
      }
    }
  }
}

export function stopAllNodeWaSessions(): void {
  for (const s of sessions.values()) {
    closeSessionSocket(s, true);
  }
  sessions.clear();
}
