import React from 'react';
import { HardDrive, Trash2, ExternalLink, CheckCheck } from 'lucide-react';
import type { AppDatabase } from '../types';

interface DashboardViewProps {
  db: AppDatabase;
  onCleanupStorage: () => Promise<void>;
  onMarkAllRead: () => Promise<void>;
  onOpenPanggil: (cameraId: number) => void;
  onNavigateTab: (tab: 'clusters' | 'reviews' | 'cameras' | 'whatsapp') => void;
}

export const DashboardView: React.FC<DashboardViewProps> = ({
  db,
  onCleanupStorage,
  onMarkAllRead,
  onOpenPanggil,
  onNavigateTab,
}) => {
  const today = new Date().toISOString().slice(0, 10);
  const todayRecords = db.daily_attendance.filter((d) => d.tanggal === today);

  const countStatus = (st: string) => todayRecords.filter((d) => d.status === st).length;
  const totalAktif = db.students.filter((s) => s.status === 'AKTIF').length;
  const totalPkl = db.students.filter((s) => s.status === 'PKL').length;
  const readyClusters = db.anonymous_clusters.filter((c) => c.status === 'READY').length;

  const storageGb = Math.round((db.storage_bytes_simulated / (1024 * 1024 * 1024)) * 100) / 100;
  const storagePct = Math.min(100, Math.round((storageGb / 10) * 1000) / 10);
  const storageTone =
    storageGb < 7
      ? { bar: 'bg-emerald-600', text: 'text-emerald-700', label: 'Normal (< 7 GB)' }
      : storageGb <= 9
        ? { bar: 'bg-amber-500', text: 'text-amber-700', label: 'Peringatan (7–9 GB)' }
        : { bar: 'bg-red-600', text: 'text-red-700', label: 'Kritis (> 9 GB)' };

  const unreadNotifs = db.notifications.filter((n) => !n.is_read);
  const waPending = db.wa_queue.filter((q) => q.status === 'PENDING').length;

  const kpis = [
    { label: 'Siswa Aktif', value: totalAktif, note: 'Wajib absen harian' },
    { label: 'Hadir Hari Ini', value: countStatus('HADIR'), note: 'Tepat waktu', tone: 'text-emerald-700' },
    { label: 'Terlambat', value: countStatus('TERLAMBAT'), note: 'Melewati toleransi', tone: 'text-amber-700' },
    { label: 'Alpa', value: countStatus('ALPA'), note: 'Cutoff +1 jam', tone: 'text-red-700' },
    { label: 'Tidak Keluar', value: countStatus('TIDAK_KELUAR'), note: 'Cutoff 18:00', tone: 'text-amber-700' },
    { label: 'Izin / Sakit', value: countStatus('IZIN') + countStatus('SAKIT'), note: 'Dikelola Guru BK' },
    { label: 'Siswa PKL', value: totalPkl, note: 'Bebas hitung Alpa' },
    { label: 'Cluster Siap Dinamai', value: readyClusters, note: '>=5 hit, >=2 hari', tone: readyClusters > 0 ? 'text-blue-700' : undefined },
  ];

  return (
    <div className="space-y-6">
      {/* KPI Summary Grid */}
      <section aria-label="Ringkasan Kehadiran Hari Ini">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {kpis.map((k) => (
            <div key={k.label} className="bg-white border border-slate-200 rounded-lg p-4">
              <div className="text-xs font-medium text-slate-500">{k.label}</div>
              <div className={`text-2xl font-bold font-mono tabular-nums mt-1 ${k.tone ?? 'text-slate-900'}`}>
                {k.value}
              </div>
              <div className="text-xs text-slate-400 mt-1">{k.note}</div>
            </div>
          ))}
        </div>
      </section>

      {/* Storage + WhatsApp Status */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <section className="bg-white border border-slate-200 rounded-lg p-5">
          <div className="flex items-center justify-between gap-4 mb-4">
            <div className="flex items-center gap-2.5">
              <HardDrive className="w-4 h-4 text-slate-500" />
              <h2 className="text-sm font-semibold text-slate-900">Manajemen Storage (Batas Maks 10 GB)</h2>
            </div>
            <button
              type="button"
              onClick={onCleanupStorage}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-md transition-colors whitespace-nowrap shrink-0"
            >
              <Trash2 className="w-3.5 h-3.5" />
              Bersihkan Sekarang
            </button>
          </div>
          <div className="flex items-baseline justify-between mb-2">
            <span className={`text-xl font-bold font-mono tabular-nums ${storageTone.text}`}>
              {storageGb.toFixed(2)} GB / 10.00 GB
            </span>
            <span className={`text-xs font-medium ${storageTone.text}`}>
              {storageTone.label} · {storagePct}%
            </span>
          </div>
          <div className="w-full h-2.5 bg-slate-100 rounded-md overflow-hidden">
            <div className={`h-full ${storageTone.bar} transition-all duration-300`} style={{ width: `${storagePct}%` }} />
          </div>
          <p className="text-xs text-slate-500 mt-3">
            Hanya 1 best snapshot per cluster dan maks 3 versi history per siswa (&gt;4 bulan auto-hapus). Cache TTS dibatasi 200 MB.
          </p>
        </section>

        <section className="bg-white border border-slate-200 rounded-lg p-5">
          <div className="flex items-center justify-between gap-4 mb-3">
            <h2 className="text-sm font-semibold text-slate-900">Status WhatsApp Gateway</h2>
            <button
              type="button"
              onClick={() => onNavigateTab('whatsapp')}
              className="text-xs font-medium text-blue-700 hover:underline whitespace-nowrap"
            >
              Kelola WA &amp; Antrean ({waPending} pending)
            </button>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-slate-200 text-slate-500">
                  <th className="py-2 font-medium">Nomor</th>
                  <th className="py-2 font-medium">Provider</th>
                  <th className="py-2 font-medium">Mode</th>
                  <th className="py-2 font-medium text-right">Kuota Hari Ini</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {db.wa_accounts.map((acc) => {
                  const limit = acc.status === 'WARMUP' ? 20 : 800;
                  return (
                    <tr key={acc.id}>
                      <td className="py-2.5 font-mono tabular-nums text-slate-900">{acc.phone_number}</td>
                      <td className="py-2.5 text-slate-600">{acc.provider}</td>
                      <td className="py-2.5 font-medium">
                        <span className={acc.status === 'ACTIVE' ? 'text-emerald-700' : acc.status === 'WARMUP' ? 'text-amber-700' : 'text-red-700'}>
                          {acc.status}
                        </span>
                      </td>
                      <td className="py-2.5 text-right font-mono tabular-nums text-slate-700">
                        {acc.daily_count} / {limit}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      </div>

      {/* Realtime Cameras + Notifications */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <section className="bg-white border border-slate-200 rounded-lg p-5">
          <div className="flex items-center justify-between gap-4 mb-3">
            <h2 className="text-sm font-semibold text-slate-900">Status Kamera Gerbang</h2>
            <button
              type="button"
              onClick={() => onNavigateTab('cameras')}
              className="text-xs font-medium text-blue-700 hover:underline"
            >
              Atur Kamera
            </button>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-slate-200 text-slate-500">
                  <th className="py-2 font-medium">Kamera</th>
                  <th className="py-2 font-medium">Gerbang</th>
                  <th className="py-2 font-medium">Status</th>
                  <th className="py-2 font-medium text-right">Halaman Panggil</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {db.cameras.map((cam) => {
                  const gate = db.gates.find((g) => g.id === cam.gate_id);
                  return (
                    <tr key={cam.id}>
                      <td className="py-2.5 font-medium text-slate-900">{cam.nama_kamera}</td>
                      <td className="py-2.5 text-slate-600">
                        {gate?.nama_gerbang ?? '-'} · {gate?.tipe ?? '-'}
                      </td>
                      <td className="py-2.5">
                        <span className={`font-medium ${cam.status === 'ONLINE' ? 'text-emerald-700' : 'text-red-700'}`}>
                          {cam.status}
                        </span>
                        {cam.last_error && <div className="text-[11px] text-slate-500">{cam.last_error}</div>}
                      </td>
                      <td className="py-2.5 text-right">
                        <button
                          type="button"
                          onClick={() => onOpenPanggil(cam.id)}
                          className="inline-flex items-center gap-1 text-blue-700 hover:underline font-medium"
                        >
                          Buka Kiosk <ExternalLink className="w-3 h-3" />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>

        <section className="bg-white border border-slate-200 rounded-lg p-5">
          <div className="flex items-center justify-between gap-4 mb-3">
            <h2 className="text-sm font-semibold text-slate-900">
              Notifikasi BK &amp; Sistem ({unreadNotifs.length} belum dibaca)
            </h2>
            {unreadNotifs.length > 0 && (
              <button
                type="button"
                onClick={onMarkAllRead}
                className="inline-flex items-center gap-1 text-xs font-medium text-slate-600 hover:text-slate-900"
              >
                <CheckCheck className="w-3.5 h-3.5" /> Tandai Semua Dibaca
              </button>
            )}
          </div>
          {db.notifications.length === 0 ? (
            <p className="text-xs text-slate-500 py-4">Belum ada notifikasi.</p>
          ) : (
            <ul className="divide-y divide-slate-100">
              {db.notifications.slice(0, 5).map((n) => (
                <li key={n.id} className={`py-2.5 text-xs ${n.is_read ? 'opacity-60' : ''}`}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-semibold text-slate-900">{n.title}</span>
                    <span className="font-mono text-slate-400">{n.role_target} · {n.created_at.slice(11, 16)}</span>
                  </div>
                  <p className="text-slate-600 mt-0.5">{n.message}</p>
                </li>
              ))}
            </ul>
          )}
          <div className="mt-3 pt-3 border-t border-slate-100 flex items-center gap-4 text-xs">
            <button type="button" onClick={() => onNavigateTab('clusters')} className="text-blue-700 hover:underline font-medium">
              Tinjau Cluster Anonim ({readyClusters})
            </button>
            <button type="button" onClick={() => onNavigateTab('reviews')} className="text-blue-700 hover:underline font-medium">
              Review Update Wajah ({db.face_update_reviews.filter((r) => r.status === 'PENDING').length})
            </button>
          </div>
        </section>
      </div>
    </div>
  );
};
