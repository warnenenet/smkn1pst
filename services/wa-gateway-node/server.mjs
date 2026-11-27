import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import express from 'express';
import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import pino from 'pino';

const HOST = '127.0.0.1';
const PORT = Math.max(1024, Math.min(65535, Number(process.env.WA_GATEWAY_PORT || 8003)));
const DATA_DIR = path.resolve(process.env.DATA_DIR || '/app/data');
const WA_STORAGE_DIR = path.resolve(process.env.WA_STORAGE_DIR || path.join(DATA_DIR, 'wa_gateway'));
const WA_AUTH_BASE = path.join(WA_STORAGE_DIR, 'baileys_auth');
const ACCOUNTS_FILE = path.join(WA_STORAGE_DIR, 'accounts.json');
const TOKEN_FILE = path.resolve(
  process.env.INTERNAL_TOKEN_FILE || '/app/storage/secrets/internal_token'
);

fs.mkdirSync(WA_STORAGE_DIR, { recursive: true });
fs.mkdirSync(WA_AUTH_BASE, { recursive: true });

const logger = pino({ level: process.env.WA_LOG_LEVEL || 'silent' });
const FALLBACK_WA_VERSION = [2, 3000, 1043857760];
let cachedWaVersion = null;

function loadInternalToken() {
  const candidates = [TOKEN_FILE, path.join(DATA_DIR, 'secrets', 'internal_token')];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p) && fs.statSync(p).size > 0) {
        return fs.readFileSync(p, 'utf8').trim();
      }
    } catch {
      // try next candidate
    }
  }
  return (process.env.INTERNAL_TOKEN || '').trim();
}

function timingSafeEqualStr(a, b) {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function requireInternalAuth(req, res, next) {
  if (req.path === '/health') return next();
  const expected = loadInternalToken();
  if (!expected) return next();
  const provided = String(req.header('x-internal-token') || '').trim();
  if (!provided || !timingSafeEqualStr(provided, expected)) {
    return res.status(401).json({ ok: false, error: 'Unauthorized internal token' });
  }
  return next();
}

function cleanDigits(raw) {
  let digits = String(raw || '').replace(/[^0-9]/g, '');
  if (digits.startsWith('0')) {
    digits = '62' + digits.slice(1);
  }
  return digits;
}

function extractPhoneFromJid(jid) {
  if (!jid) return null;
  const user = String(jid).split(':')[0].split('@')[0];
  const digits = user.replace(/[^0-9]/g, '');
  return digits || null;
}

function loadRegistry() {
  try {
    if (fs.existsSync(ACCOUNTS_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));
      if (Array.isArray(parsed.accounts)) return parsed.accounts;
    }
  } catch {
    // ignore corrupt file
  }
  return [];
}

function saveRegistry(list) {
  const tmp = ACCOUNTS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ accounts: list }, null, 2), 'utf8');
  fs.renameSync(tmp, ACCOUNTS_FILE);
}

const sessions = new Map();

function hydrateAccounts() {
  const list = loadRegistry();
  for (const acc of list) {
    sessions.set(acc.id, {
      id: acc.id,
      label: acc.label || `WA Sekolah #${acc.id}`,
      phone_number: acc.phone_number || null,
      status: acc.status || 'NEW',
      qr_base64: null,
      last_error: null,
      updated_at: new Date().toISOString(),
      sock: null,
      startPromise: null,
      reconnectTimer: null,
      reconnectAttempts: 0,
      manualClose: false,
      paused: acc.status === 'PAUSED',
    });
  }
}

function persistRegistry() {
  const list = Array.from(sessions.values()).map((s) => ({
    id: s.id,
    label: s.label,
    phone_number: s.phone_number,
    status: s.status,
  }));
  saveRegistry(list);
}

async function getWaVersion() {
  if (cachedWaVersion && Date.now() - cachedWaVersion.fetchedAt < 3600_000) {
    return cachedWaVersion.version;
  }
  try {
    const res = await Promise.race([
      fetchLatestBaileysVersion(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 4000)),
    ]);
    if (Array.isArray(res?.version) && res.version.length === 3) {
      cachedWaVersion = {
        version: [Number(res.version[0]), Number(res.version[1]), Number(res.version[2])],
        fetchedAt: Date.now(),
      };
      return cachedWaVersion.version;
    }
  } catch {
    // fallback version
  }
  return cachedWaVersion?.version || FALLBACK_WA_VERSION;
}

function closeSocket(s, manual = true) {
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
      // ignore cleanup error
    }
    s.sock = null;
  }
}

async function ensureSessionStarted(accountId) {
  const s = sessions.get(accountId);
  if (!s || s.paused) return null;
  if (s.status === 'CONNECTED' && s.sock) return s;
  if (s.startPromise) {
    await s.startPromise;
    return s;
  }

  s.startPromise = (async () => {
    closeSocket(s, false);
    s.manualClose = false;
    s.status = 'NEW';
    s.last_error = null;
    s.updated_at = new Date().toISOString();

    const authDir = path.join(WA_AUTH_BASE, `acc_${accountId}`);
    fs.mkdirSync(authDir, { recursive: true });
    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    const version = await getWaVersion();

    const sock = makeWASocket({
      version,
      auth: state,
      logger,
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
          s.qr_base64 = await QRCode.toDataURL(update.qr, {
            width: 320,
            margin: 2,
            color: { dark: '#0f172a', light: '#ffffff' },
          });
          s.status = 'QR_READY';
          s.last_error = null;
          s.updated_at = new Date().toISOString();
        } catch (err) {
          s.status = 'ERROR';
          s.last_error = err instanceof Error ? err.message : 'Gagal membuat gambar QR';
          s.updated_at = new Date().toISOString();
        }
      }

      if (update.connection === 'open') {
        s.status = 'CONNECTED';
        s.qr_base64 = null;
        s.phone_number = extractPhoneFromJid(sock.user?.id) || s.phone_number;
        s.last_error = null;
        s.reconnectAttempts = 0;
        s.updated_at = new Date().toISOString();
        persistRegistry();
        console.log(`[WA-Baileys] Akun #${accountId} CONNECTED (${s.phone_number || '-'})`);
      }

      if (update.connection === 'close') {
        const rawErr = update.lastDisconnect?.error;
        const statusCode = rawErr?.output?.statusCode;
        s.sock = null;
        if (s.manualClose || s.paused) return;

        if (statusCode === DisconnectReason.loggedOut || statusCode === DisconnectReason.badSession) {
          s.status = 'DISCONNECTED';
          s.qr_base64 = null;
          s.last_error =
            statusCode === DisconnectReason.loggedOut
              ? 'Sesi WhatsApp logout. Silakan scan ulang QR.'
              : 'Sesi WhatsApp kedaluwarsa. Silakan scan ulang QR.';
          s.updated_at = new Date().toISOString();
          try {
            fs.rmSync(authDir, { recursive: true, force: true });
          } catch {
            // ignore
          }
          persistRegistry();
          return;
        }

        const retryable =
          statusCode === DisconnectReason.restartRequired ||
          statusCode === DisconnectReason.connectionLost ||
          statusCode === DisconnectReason.connectionClosed ||
          statusCode === DisconnectReason.timedOut ||
          s.reconnectAttempts < 5;

        if (retryable && s.reconnectAttempts < 8) {
          s.reconnectAttempts += 1;
          const delayMs = statusCode === DisconnectReason.restartRequired ? 400 : Math.min(15000, 1500 * s.reconnectAttempts);
          s.status = statusCode === DisconnectReason.restartRequired ? 'NEW' : s.status;
          s.last_error = null;
          s.updated_at = new Date().toISOString();
          if (s.reconnectTimer) clearTimeout(s.reconnectTimer);
          s.reconnectTimer = setTimeout(() => {
            s.reconnectTimer = null;
            void ensureSessionStarted(accountId).catch(() => {});
          }, delayMs);
          return;
        }

        s.status = 'ERROR';
        s.last_error = rawErr?.message || `Koneksi terputus (code ${statusCode ?? '-'})`;
        s.updated_at = new Date().toISOString();
        persistRegistry();
      }
    });
  })().finally(() => {
    s.startPromise = null;
  });

  await s.startPromise;
  return s;
}

hydrateAccounts();

// Auto-resume accounts that already have stored Baileys credentials
for (const s of sessions.values()) {
  if (!s.paused && fs.existsSync(path.join(WA_AUTH_BASE, `acc_${s.id}`, 'creds.json'))) {
    void ensureSessionStarted(s.id).catch(() => {});
  }
}

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(requireInternalAuth);

app.get('/health', (_req, res) => {
  let connected = 0;
  let activeSockets = 0;
  for (const s of sessions.values()) {
    if (s.status === 'CONNECTED') connected += 1;
    if (s.sock) activeSockets += 1;
  }
  res.json({
    ok: true,
    engine: 'baileys-node',
    active_browsers: activeSockets,
    max_chrome: 0,
    accounts_total: sessions.size,
    accounts_connected: connected,
    chromium_bin: 'baileys-node',
    xvfb_available: false,
  });
});

app.post('/accounts', (req, res) => {
  const label = String(req.body?.label || '').trim() || `WA Sekolah #${sessions.size + 1}`;
  const phone = req.body?.phone_number ? String(req.body.phone_number).trim() : null;
  const maxId = Array.from(sessions.keys()).reduce((m, v) => Math.max(m, v), 0);
  const id = maxId + 1;
  const sess = {
    id,
    label,
    phone_number: phone,
    status: 'NEW',
    qr_base64: null,
    last_error: null,
    updated_at: new Date().toISOString(),
    sock: null,
    startPromise: null,
    reconnectTimer: null,
    reconnectAttempts: 0,
    manualClose: false,
    paused: false,
  };
  sessions.set(id, sess);
  persistRegistry();
  res.json({ ok: true, id, status: sess.status, phone_number: sess.phone_number });
});

app.get('/accounts/:id', (req, res) => {
  const id = Number(req.params.id);
  const s = sessions.get(id);
  if (!s) return res.status(404).json({ ok: false, error: 'Account not found' });
  return res.json({
    ok: true,
    account: {
      id: s.id,
      label: s.label,
      status: s.status,
      phone_number: s.phone_number,
    },
  });
});

app.get('/accounts/:id/qr', async (req, res) => {
  const id = Number(req.params.id);
  const s = sessions.get(id);
  if (!s) return res.status(404).json({ ok: false, error: 'Account not found' });

  if (!s.paused && !s.sock && !s.startPromise && !s.reconnectTimer) {
    if (s.status === 'NEW' || s.status === 'DISCONNECTED' || s.status === 'ERROR') {
      await ensureSessionStarted(id).catch(() => {});
      const deadline = Date.now() + 4500;
      while (Date.now() < deadline && s.status === 'NEW') {
        await new Promise((r) => setTimeout(r, 180));
      }
    }
  }

  return res.json({
    ok: true,
    status: s.status,
    qr_base64: s.qr_base64,
    phone_number: s.phone_number,
    last_error: s.last_error,
    updated_at: s.updated_at,
  });
});

app.post('/accounts/:id/reconnect', async (req, res) => {
  const id = Number(req.params.id);
  const s = sessions.get(id);
  if (!s) return res.status(404).json({ ok: false, error: 'Account not found' });
  s.paused = false;
  closeSocket(s, true);
  s.reconnectAttempts = 0;
  s.qr_base64 = null;
  s.last_error = null;
  s.status = 'NEW';
  await ensureSessionStarted(id).catch(() => {});
  return res.json({ ok: true, status: s.status });
});

app.post('/accounts/:id/pause', (req, res) => {
  const id = Number(req.params.id);
  const s = sessions.get(id);
  if (!s) return res.status(404).json({ ok: false, error: 'Account not found' });
  s.paused = true;
  closeSocket(s, true);
  s.status = 'PAUSED';
  s.qr_base64 = null;
  persistRegistry();
  return res.json({ ok: true });
});

app.post('/accounts/:id/resume', async (req, res) => {
  const id = Number(req.params.id);
  const s = sessions.get(id);
  if (!s) return res.status(404).json({ ok: false, error: 'Account not found' });
  s.paused = false;
  s.status = 'NEW';
  persistRegistry();
  await ensureSessionStarted(id).catch(() => {});
  return res.json({ ok: true });
});

app.delete('/accounts/:id', (req, res) => {
  const id = Number(req.params.id);
  const s = sessions.get(id);
  if (s) {
    closeSocket(s, true);
    sessions.delete(id);
    persistRegistry();
  }
  try {
    fs.rmSync(path.join(WA_AUTH_BASE, `acc_${id}`), { recursive: true, force: true });
  } catch {
    // ignore
  }
  return res.json({ ok: true });
});

app.post('/send', async (req, res) => {
  const accountId = Number(req.body?.account_id);
  const to = cleanDigits(req.body?.to);
  const message = String(req.body?.message || '');

  if (!Number.isFinite(accountId) || !sessions.has(accountId)) {
    return res.status(404).json({ ok: false, error: 'WA Gateway account not found' });
  }
  if (to.length < 9 || !message.trim()) {
    return res.status(422).json({ ok: false, error: 'Nomor tujuan atau isi pesan tidak valid.' });
  }

  const s = sessions.get(accountId);
  if (!s.sock || s.status !== 'CONNECTED') {
    await ensureSessionStarted(accountId).catch(() => {});
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && s.status !== 'CONNECTED' && s.status !== 'ERROR') {
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  if (!s.sock || s.status !== 'CONNECTED') {
    return res.status(503).json({
      ok: false,
      error: s.last_error || 'Sesi WhatsApp Baileys belum terhubung.',
    });
  }

  const jid = `${to}@s.whatsapp.net`;
  try {
    if (typeof s.sock.onWhatsApp === 'function') {
      const checks = await s.sock.onWhatsApp(jid).catch(() => null);
      if (Array.isArray(checks) && checks.length > 0 && checks[0] && checks[0].exists === false) {
        return res.status(422).json({
          ok: false,
          error: `Nomor tujuan ${to} tidak terdaftar di WhatsApp.`,
        });
      }
    }
    await s.sock.sendMessage(jid, { text: message });
    return res.json({ ok: true });
  } catch (err) {
    return res.status(502).json({
      ok: false,
      error: err instanceof Error ? err.message : 'Gagal mengirim pesan via Baileys.',
    });
  }
});

const server = app.listen(PORT, HOST, () => {
  console.log(`[BOOT] wa-gateway-node (Baileys) listening on http://${HOST}:${PORT} | storage=${WA_STORAGE_DIR}`);
});

function shutdown() {
  for (const s of sessions.values()) {
    closeSocket(s, true);
  }
  server.close(() => process.exit(0));
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
