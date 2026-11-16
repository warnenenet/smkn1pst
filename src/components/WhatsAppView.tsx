import React, { useEffect, useState } from 'react';
import { Download, RefreshCw, QrCode } from 'lucide-react';
import type { AppDatabase, SettingsMap, WaProvider } from '../types';

interface WhatsAppViewProps {
  db: AppDatabase;
  onSaveSettings: (patch: Partial<SettingsMap>) => Promise<void>;
  onAddAccount: (phone: string) => Promise<void>;
  onConnectAccount: (id: number) => Promise<void>;
  onTestSend: (phone: string, message: string) => Promise<string>;
  onUpdateTemplate: (id: number, text: string) => Promise<void>;
  onRetryQueue: (id: number) => Promise<void>;
  onDispatchDailyNow: () => Promise<{ queued: number; markedAlpa: number; markedNoCheckout: number }>;
}

export const WhatsAppView: React.FC<WhatsAppViewProps> = ({
  db,
  onSaveSettings,
  onAddAccount,
  onConnectAccount,
  onTestSend,
  onUpdateTemplate,
  onRetryQueue,
  onDispatchDailyNow,
}) => {
  const [provider, setProvider] = useState<WaProvider>(db.settings.wa_provider);
  const [apiKey, setApiKey] = useState(db.settings.wa_api_key);
  const [phoneNumId, setPhoneNumId] = useState(db.settings.wa_phone_number_id);
  const [delayAfterPulang, setDelayAfterPulang] = useState<number>(db.settings.wa_delay_after_pulang_menit ?? 60);
  const [autoDispatchEnabled, setAutoDispatchEnabled] = useState<boolean>(db.settings.wa_auto_dispatch_enabled ?? true);
  const [dispatchResult, setDispatchResult] = useState('');
  const [newPhone, setNewPhone] = useState('');
  const [testPhone, setTestPhone] = useState('6281234560001');
  const [testMsg, setTestMsg] = useState('Tes notifikasi WhatsApp Absensi SMK.');
  const [testPreview, setTestPreview] = useState('');
  const [qrModalId, setQrModalId] = useState<number | null>(null);
  const [qrState, setQrState] = useState<{ qrDataUrl: string | null; status: string; error: string | null }>({
    qrDataUrl: null,
    status: 'IDLE',
    error: null,
  });
  const [tplDrafts, setTplDrafts] = useState<Record<number, string>>({});

  useEffect(() => {
    if (qrModalId === null) return;
    let active = true;
    fetch(`/api/wa/accounts/${qrModalId}/pair`, { method: 'POST' })
      .then((r) => r.json())
      .then((d) => {
        if (active) setQrState({ qrDataUrl: d.qrDataUrl ?? null, status: d.status ?? 'CONNECTING', error: d.error ?? null });
      })
      .catch(() => {});

    const iv = window.setInterval(async () => {
      try {
        const res = await fetch(`/api/wa/accounts/${qrModalId}/qr`);
        const d = await res.json();
        if (!active) return;
        setQrState({ qrDataUrl: d.qrDataUrl ?? null, status: d.status ?? 'CONNECTING', error: d.error ?? null });
        if (d.status === 'CONNECTED') {
          window.clearInterval(iv);
          await onConnectAccount(qrModalId);
          setQrModalId(null);
        }
      } catch {
        // ignore poll error
      }
    }, 2000);

    return () => {
      active = false;
      window.clearInterval(iv);
    };
  }, [qrModalId]);

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <section className="bg-white border border-slate-200 rounded-lg p-5 space-y-4">
          <h2 className="text-sm font-semibold text-slate-900">Konfigurasi Provider &amp; Jadwal Rekap Pulang</h2>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              await onSaveSettings({
                wa_provider: provider,
                wa_api_key: apiKey,
                wa_phone_number_id: phoneNumId,
                wa_delay_after_pulang_menit: delayAfterPulang,
                wa_auto_dispatch_enabled: autoDispatchEnabled,
              });
            }}
            className="space-y-3"
          >
            <div>
              <label htmlFor="wa-prov" className="block text-xs text-slate-600 mb-1">Provider Aktif</label>
              <select id="wa-prov" value={provider} onChange={(e) => setProvider(e.target.value as WaProvider)} className="w-full border border-slate-300 rounded px-2.5 py-2 text-xs bg-white">
                <option value="BAILEYS">Baileys (Gratis Nomor Pribadi + Anti-Blokir)</option>
                <option value="META_CLOUD">Meta WhatsApp Cloud API (1000 conv gratis/bln)</option>
                <option value="FONNTE">Fonnte (Provider Lokal)</option>
                <option value="WABLAS">WABLAS (Provider Lokal)</option>
              </select>
            </div>
            {provider !== 'BAILEYS' && (
              <>
                <input placeholder="API Key Provider" value={apiKey} onChange={(e) => setApiKey(e.target.value)} className="w-full border border-slate-300 rounded px-2.5 py-2 text-xs font-mono" />
                {provider === 'META_CLOUD' && (
                  <input placeholder="Meta Phone Number ID" value={phoneNumId} onChange={(e) => setPhoneNumId(e.target.value)} className="w-full border border-slate-300 rounded px-2.5 py-2 text-xs font-mono" />
                )}
              </>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
              <div>
                <label htmlFor="wa-delay-pulang" className="block text-xs text-slate-600 mb-1">
                  Kirim Rekap WA (Menit Setelah Jam Pulang)
                </label>
                <input
                  id="wa-delay-pulang"
                  type="number"
                  min={0}
                  max={240}
                  value={delayAfterPulang}
                  onChange={(e) => setDelayAfterPulang(Math.max(0, Number(e.target.value)))}
                  className="w-full border border-slate-300 rounded px-2.5 py-1.5 text-xs font-mono"
                />
              </div>
              <label className="flex items-center gap-2 text-xs text-slate-700 pt-5 select-none">
                <input
                  type="checkbox"
                  checked={autoDispatchEnabled}
                  onChange={(e) => setAutoDispatchEnabled(e.target.checked)}
                />
                <span>Aktifkan rekap WA otomatis pasca-pulang</span>
              </label>
            </div>
            <p className="text-[11px] text-slate-500">
              Sistem otomatis menghitung jam pulang tiap kelas/jurusan (termasuk exception pulang cepat/libur), menandai ALPA / TIDAK_KELUAR, lalu mengantrekan 1 rekap WA per siswa +{delayAfterPulang} menit setelah bel pulang.
            </p>

            <div className="flex flex-wrap items-center gap-2">
              <button type="submit" className="px-4 py-2 text-xs font-semibold text-white bg-blue-700 hover:bg-blue-800 rounded-md">
                Simpan Konfigurasi WA
              </button>
              <button
                type="button"
                onClick={async () => {
                  const res = await onDispatchDailyNow();
                  setDispatchResult(
                    `Rekap dijadwalkan: ${res.queued} pesan WA baru · ${res.markedAlpa} siswa ditandai ALPA · ${res.markedNoCheckout} TIDAK_KELUAR.`
                  );
                }}
                className="px-3.5 py-2 text-xs font-semibold text-slate-800 bg-amber-100 hover:bg-amber-200 border border-amber-300 rounded-md"
              >
                Jadwalkan Rekap Pulang Hari Ini
              </button>
            </div>
            {dispatchResult && (
              <p className="text-xs text-emerald-800 bg-emerald-50 border border-emerald-200 rounded p-2">
                {dispatchResult}
              </p>
            )}
          </form>

          <hr className="border-slate-200" />
          <h3 className="text-xs font-semibold text-slate-900">Test Kirim Pesan</h3>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              const prev = await onTestSend(testPhone, testMsg);
              setTestPreview(prev);
            }}
            className="flex flex-col sm:flex-row gap-2"
          >
            <input placeholder="628xxx" value={testPhone} onChange={(e) => setTestPhone(e.target.value)} required className="border border-slate-300 rounded px-2.5 py-1.5 text-xs font-mono sm:w-40" />
            <input placeholder="Pesan tes..." value={testMsg} onChange={(e) => setTestMsg(e.target.value)} required className="border border-slate-300 rounded px-2.5 py-1.5 text-xs flex-1" />
            <button type="submit" className="px-3 py-1.5 text-xs font-semibold text-white bg-emerald-700 hover:bg-emerald-800 rounded whitespace-nowrap">Kirim Tes</button>
          </form>
          {testPreview && <p className="text-xs text-slate-600 bg-slate-50 p-2.5 rounded border border-slate-200">{testPreview}</p>}
        </section>

        <section className="bg-white border border-slate-200 rounded-lg p-5 space-y-4">
          <h2 className="text-sm font-semibold text-slate-900">Multi-Nomor Baileys &amp; Strategi Anti-Blokir</h2>
          <p className="text-xs text-slate-500">
            Delay acak 60–120 detik · Maks 150/jam &amp; 800/hari · Nomor baru otomatis mode WARMUP (20/hari selama 7 hari) · Jeda 24 jam nomor tujuan sama.
          </p>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              if (!newPhone) return;
              await onAddAccount(newPhone);
              setNewPhone('');
            }}
            className="flex gap-2"
          >
            <input placeholder="Tambah Nomor Pengirim (628xxx)" value={newPhone} onChange={(e) => setNewPhone(e.target.value)} required className="border border-slate-300 rounded px-2.5 py-1.5 text-xs font-mono flex-1" />
            <button type="submit" className="px-3 py-1.5 text-xs font-semibold text-white bg-blue-700 hover:bg-blue-800 rounded">Tambah Nomor</button>
          </form>

          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-slate-200 text-slate-500">
                <th className="py-2 font-medium">Nomor</th>
                <th className="py-2 font-medium">Status</th>
                <th className="py-2 font-medium">Kuota Harian</th>
                <th className="py-2 font-medium text-right">Koneksi</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {db.wa_accounts.map((acc) => (
                <tr key={acc.id}>
                  <td className="py-2 font-mono">{acc.phone_number}</td>
                  <td className="py-2 font-semibold text-slate-800">{acc.status}</td>
                  <td className="py-2 font-mono tabular-nums">{acc.daily_count} / {acc.status === 'WARMUP' ? 20 : 800}</td>
                  <td className="py-2 text-right">
                    {acc.qr_connected ? (
                      <span className="text-emerald-700 font-medium">Terhubung</span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setQrModalId(acc.id)}
                        className="inline-flex items-center gap-1 text-blue-700 hover:underline font-medium"
                      >
                        <QrCode className="w-3.5 h-3.5" /> Scan QR
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {qrModalId !== null && (
            <div className="p-4 border border-slate-200 rounded-md bg-slate-50 flex flex-col sm:flex-row items-center justify-between gap-4">
              <div className="text-xs space-y-1.5">
                <div className="font-semibold text-slate-900">
                  Pairing QR Baileys (Akun #{qrModalId}) · <span className="font-mono text-blue-700">{qrState.status}</span>
                </div>
                <p className="text-slate-600">Buka WhatsApp &rarr; Perangkat Tertaut &rarr; Tautkan Perangkat.</p>
                {qrState.error && <p className="text-red-700 font-medium">{qrState.error}</p>}
                <div className="flex items-center gap-2 pt-1">
                  <button
                    type="button"
                    onClick={async () => {
                      await onConnectAccount(qrModalId);
                      setQrModalId(null);
                    }}
                    className="px-3 py-1.5 text-xs font-semibold text-white bg-emerald-700 hover:bg-emerald-800 rounded"
                  >
                    Tandai Terhubung
                  </button>
                  <button
                    type="button"
                    onClick={() => setQrModalId(null)}
                    className="px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 hover:bg-slate-100 rounded"
                  >
                    Tutup
                  </button>
                </div>
              </div>
              {qrState.qrDataUrl ? (
                <img
                  src={qrState.qrDataUrl}
                  alt="QR Code Pairing WhatsApp Baileys"
                  className="w-36 h-36 bg-white border border-slate-300 rounded p-1 shrink-0"
                />
              ) : (
                <div className="w-28 h-28 bg-white border border-slate-300 rounded flex items-center justify-center text-[11px] text-slate-500 text-center p-2 shrink-0">
                  Menyiapkan QR Baileys...
                </div>
              )}
            </div>
          )}
        </section>
      </div>

      {/* WA Queue */}
      <section className="bg-white border border-slate-200 rounded-lg p-5">
        <div className="flex items-center justify-between gap-4 mb-3">
          <h2 className="text-sm font-semibold text-slate-900">WA Queue &amp; Log Pengiriman</h2>
          <a href="/api/wa/export" download="wa_queue_log.csv" className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded">
            <Download className="w-3.5 h-3.5" /> Export Log CSV
          </a>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-slate-200 text-slate-500">
                <th className="py-2 font-medium">Siswa</th>
                <th className="py-2 font-medium">Nomor</th>
                <th className="py-2 font-medium">Status</th>
                <th className="py-2 font-medium">Retry</th>
                <th className="py-2 font-medium">Waktu Kirim</th>
                <th className="py-2 font-medium text-right">Aksi</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {db.wa_queue.map((q) => (
                <tr key={q.id}>
                  <td className="py-2 font-medium text-slate-900">{q.payload.nama}</td>
                  <td className="py-2 font-mono">{q.phone}</td>
                  <td className={`py-2 font-semibold ${q.status === 'SENT' ? 'text-emerald-700' : q.status === 'PENDING' ? 'text-amber-700' : 'text-red-700'}`}>
                    {q.status}
                  </td>
                  <td className="py-2 font-mono tabular-nums">{q.retry_count}/3</td>
                  <td className="py-2 font-mono text-slate-500">{q.sent_at ?? q.scheduled_at}</td>
                  <td className="py-2 text-right">
                    {q.status !== 'SENT' && (
                      <button type="button" onClick={() => onRetryQueue(q.id)} className="inline-flex items-center gap-1 text-blue-700 hover:underline font-medium">
                        <RefreshCw className="w-3 h-3" /> Retry
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* 10 Variasi Template */}
      <section className="bg-white border border-slate-200 rounded-lg p-5">
        <h2 className="text-sm font-semibold text-slate-900 mb-3">10 Variasi Template Pesan Acak (Anti-Blokir)</h2>
        <div className="space-y-2">
          {db.wa_templates.map((tpl) => (
            <div key={tpl.id} className="flex flex-col sm:flex-row gap-2 items-stretch sm:items-center">
              <span className="text-xs font-mono text-slate-500 w-16 shrink-0">{tpl.code}</span>
              <input
                value={tplDrafts[tpl.id] ?? tpl.template_text}
                onChange={(e) => setTplDrafts((p) => ({ ...p, [tpl.id]: e.target.value }))}
                className="flex-1 border border-slate-300 rounded px-2.5 py-1.5 text-xs"
              />
              <button
                type="button"
                onClick={() => onUpdateTemplate(tpl.id, tplDrafts[tpl.id] ?? tpl.template_text)}
                className="px-3 py-1.5 text-xs font-medium bg-slate-800 hover:bg-slate-900 text-white rounded shrink-0"
              >
                Simpan
              </button>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
};
