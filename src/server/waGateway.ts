import fs from 'fs';
import path from 'path';
import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
  type WASocket,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import QRCode from 'qrcode';
import { WA_AUTH_DIR, loadDb, saveDb } from './store.ts';
import type { WaAccount } from '../types';
import {
  applyWaQuotaResetIfDue,
  checkWaAccountQuota,
  formatWaMessage,
  getJakartaNowParts,
} from '../lib/attendanceEngine.ts';

interface PairingState {
  qrDataUrl: string | null;
  status: 'IDLE' | 'CONNECTING' | 'QR_READY' | 'CONNECTED' | 'ERROR';
  error: string | null;
  updatedAt: number;
}

const activeSockets = new Map<number, WASocket>();
const pairingStates = new Map<number, PairingState>();
const reconnectTimers = new Map<number, NodeJS.Timeout>();
const logger = pino({ level: 'silent' });

export function getLiveBaileysSocketCount(): number {
  return activeSockets.size;
}

export function getPairingState(accountId: number): PairingState {
  return (
    pairingStates.get(accountId) ?? {
      qrDataUrl: null,
      status: 'IDLE',
      error: null,
      updatedAt: Date.now(),
    }
  );
}

export async function startBaileysPairing(
  accountId: number,
  onQrUpdate?: (payload: Record<string, unknown>) => void
): Promise<PairingState> {
  const pendingTimer = reconnectTimers.get(accountId);
  if (pendingTimer) {
    clearTimeout(pendingTimer);
    reconnectTimers.delete(accountId);
  }
  const existingSock = activeSockets.get(accountId);
  if (existingSock) {
    try {
      existingSock.end(undefined);
    } catch {
      // ignore close errors
    }
    activeSockets.delete(accountId);
  }

  const authFolder = path.join(WA_AUTH_DIR, `acc_${accountId}`);
  fs.mkdirSync(authFolder, { recursive: true });

  pairingStates.set(accountId, {
    qrDataUrl: null,
    status: 'CONNECTING',
    error: null,
    updatedAt: Date.now(),
  });

  try {
    const { state, saveCreds } = await useMultiFileAuthState(authFolder);
    const { version } = await fetchLatestBaileysVersion().catch(() => ({
      version: [2, 3000, 1015901307] as [number, number, number],
    }));

    const sock = makeWASocket({
      version,
      auth: state,
      logger,
      printQRInTerminal: false,
      browser: ['Absensi SMK Face AI', 'Chrome', '120.0.0'],
      syncFullHistory: false,
    });

    activeSockets.set(accountId, sock);

    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;
      if (qr) {
        try {
          const qrDataUrl = await QRCode.toDataURL(qr, { width: 220, margin: 1 });
          const next: PairingState = {
            qrDataUrl,
            status: 'QR_READY',
            error: null,
            updatedAt: Date.now(),
          };
          pairingStates.set(accountId, next);
          onQrUpdate?.({ event: 'wa_qr', account_id: accountId, ...next });
        } catch (err) {
          pairingStates.set(accountId, {
            qrDataUrl: null,
            status: 'ERROR',
            error: err instanceof Error ? err.message : 'Gagal membuat QR',
            updatedAt: Date.now(),
          });
        }
      }

      if (connection === 'open') {
        const next: PairingState = {
          qrDataUrl: null,
          status: 'CONNECTED',
          error: null,
          updatedAt: Date.now(),
        };
        pairingStates.set(accountId, next);
        const db = loadDb();
        const acc = db.wa_accounts.find((a) => a.id === accountId);
        if (acc) {
          acc.qr_connected = true;
          saveDb(db);
        }
        onQrUpdate?.({ event: 'wa_connected', account_id: accountId });
      } else if (connection === 'close') {
        const statusCode = (lastDisconnect?.error as { output?: { statusCode?: number } })?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        activeSockets.delete(accountId);
        if (!shouldReconnect) {
          pairingStates.set(accountId, {
            qrDataUrl: null,
            status: 'IDLE',
            error: 'Sesi WhatsApp logout, silakan scan ulang QR.',
            updatedAt: Date.now(),
          });
          console.warn(`[WA][Acc #${accountId}] Sesi Baileys loggedOut; perlu scan ulang QR.`);
        } else {
          pairingStates.set(accountId, {
            qrDataUrl: null,
            status: 'CONNECTING',
            error: 'Koneksi WA terputus sementara, menyambung ulang...',
            updatedAt: Date.now(),
          });
          console.warn(`[WA][Acc #${accountId}] Koneksi Baileys putus (code=${statusCode ?? '-'}), auto-reconnect 8 dtk...`);
          const timerId = setTimeout(() => {
            reconnectTimers.delete(accountId);
            startBaileysPairing(accountId, onQrUpdate).catch((err) => {
              console.error(`[WA][Acc #${accountId}] Gagal reconnect Baileys:`, err);
            });
          }, 8000);
          reconnectTimers.set(accountId, timerId);
        }
      }
    });
  } catch (err) {
    pairingStates.set(accountId, {
      qrDataUrl: null,
      status: 'ERROR',
      error: err instanceof Error ? err.message : 'Koneksi Baileys gagal dimulai.',
      updatedAt: Date.now(),
    });
  }

  return getPairingState(accountId);
}

export function restoreSavedBaileysSessions(onQrUpdate?: (payload: Record<string, unknown>) => void): void {
  const db = loadDb();
  for (const acc of db.wa_accounts) {
    if (acc.provider !== 'BAILEYS' || !acc.qr_connected) continue;
    const credsFile = path.join(WA_AUTH_DIR, `acc_${acc.id}`, 'creds.json');
    if (fs.existsSync(credsFile)) {
      startBaileysPairing(acc.id, onQrUpdate).catch(() => {});
    }
  }
}

export async function dispatchWaMessage(
  account: WaAccount | undefined,
  provider: string,
  apiKey: string,
  phoneNumberId: string,
  phone: string,
  text: string,
  isProductionMode = false
): Promise<{ sent: boolean; simulated: boolean; error?: string }> {
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
      return { sent: false, simulated: false, error: `Meta API HTTP ${resp.status}` };
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
      return { sent: false, simulated: false, error: `Fonnte HTTP ${resp.status}` };
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
      return { sent: false, simulated: false, error: `WABLAS HTTP ${resp.status}` };
    }
    return { sent: true, simulated: false };
  }

  if (account) {
    const sock = activeSockets.get(account.id);
    if (sock) {
      await sock.sendMessage(`${cleanPhone}@s.whatsapp.net`, { text });
      return { sent: true, simulated: false };
    }
  }

  if (isProductionMode) {
    return {
      sent: false,
      simulated: false,
      error: 'Gateway WA belum tersambung (scan QR Baileys atau isi API key di menu WhatsApp Gateway).',
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

          const quotaEligible = db.wa_accounts.filter((a) =>
            checkWaAccountQuota({
              status: a.status,
              daily_count: a.daily_count,
              hourly_count: a.hourly_count,
            })
          );
          const eligibleAccount =
            quotaEligible.find((a) => activeSockets.has(a.id)) ?? quotaEligible[0];

          const result = await dispatchWaMessage(
            eligibleAccount,
            db.settings.wa_provider,
            db.settings.wa_api_key,
            db.settings.wa_phone_number_id,
            pending.phone,
            msg,
            Boolean(db.settings.production_mode)
          );

          if (result.sent) {
            pending.status = 'SENT';
            pending.sent_at = nowWib;
            pending.error_msg = null;
            if (eligibleAccount) {
              eligibleAccount.daily_count += 1;
              eligibleAccount.hourly_count += 1;
            }
            console.log(
              `[WA] Antrean #${pending.id} (${pending.phone}) SENT (sim=${result.simulated}, timeWIB=${nowWib})`
            );
          } else {
            pending.retry_count += 1;
            pending.error_msg = result.error ?? 'Gagal mengirim';
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
