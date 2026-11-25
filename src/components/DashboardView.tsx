import React, { useState } from 'react';
import { Activity, AlertTriangle, CheckCheck, ExternalLink, HardDrive, RefreshCw, ShieldCheck, Trash2 } from 'lucide-react';
import { describeCaptureResolutionMode, getJakartaNowParts, summarizeEmbeddingDimensions } from '../lib/attendanceEngine';
import type { AppDatabase, WorkerStatusResponse } from '../types';

interface DashboardViewProps {
  db: AppDatabase;
  workerStatus?: WorkerStatusResponse | null;
  onCleanupStorage: () => Promise<void>;
  onMarkAllRead: () => Promise<void>;
  onActivateProduction?: () => Promise<void>;
  onMigrateEmbeddings?: () => Promise<void>;
  onOpenPanggil: (cameraId: number) => void;
  onNavigateTab: (tab: 'clusters' | 'reviews' | 'cameras' | 'whatsapp' | 'settings') => void;
}

export const DashboardView: React.FC<DashboardViewProps> = ({
  db,
  workerStatus,
  onCleanupStorage,
  onMarkAllRead,
  onActivateProduction,
  onMigrateEmbeddings,
  onOpenPanggil,
  onNavigateTab,
}) => {
  const [confirmProd, setConfirmProd] = useState(false);
  const [activatingProd, setActivatingProd] = useState(false);
  const [migratingEmb, setMigratingEmb] = useState(false);

  const today = getJakartaNowParts().dateStr;
  const todayRecords = db.daily_attendance.filter((d) => d.tanggal === today);

  const countStatus = (st: string) => todayRecords.filter((d) => d.status === st).length;
  const totalAktif = db.students.filter((s) => s.status === 'AKTIF').length;
  const totalPkl = db.students.filter((s) => s.status === 'PKL').length;
  const readyClusters = db.anonymous_clusters.filter((c) => c.status === 'READY').length;
  const pendingClusters = db.anonymous_clusters.filter((c) => c.status === 'PENDING').length;

  const totalUsedBytes = workerStatus?.storage_breakdown?.total_bytes ?? db.storage_bytes_simulated;
  const storageGb = Math.round((totalUsedBytes / (1024 * 1024 * 1024)) * 100) / 100;
  const storageMb = Math.round((totalUsedBytes / (1024 * 1024)) * 100) / 100;
  const storagePct = Math.min(100, Math.round((totalUsedBytes / (10 * 1024 * 1024 * 1024)) * 1000) / 10);
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
    {
      label: 'Cluster Anonim',
      value: readyClusters,
      note: `Siap dinamai (>=${db.settings.cluster_ready_hits} hit, ${db.settings.cluster_ready_days} hr) · ${pendingClusters} dilatih`,
      tone: readyClusters > 0 ? 'text-blue-700' : undefined,
    },
  ];

  const isProd = Boolean(db.settings.production_mode);
  const totalFacesLive = workerStatus?.cameras.reduce((acc, c) => acc + c.faces_detected_total, 0) ?? 0;
  const expectedDims = workerStatus?.expected_embedding_dims ?? 512;
  const dimSummary = summarizeEmbeddingDimensions(
    db.students.filter((s) => s.status !== 'LULUS'),
    db.anonymous_clusters.filter((c) => c.status === 'PENDING' || c.status === 'READY')
  );
  const mismatchedStudentsCount =
    (expectedDims !== 16 ? dimSummary.students.dim_16_demo : 0) +
    (expectedDims !== 512 ? dimSummary.students.dim_512_insightface : 0) +
    (expectedDims !== 1024 ? dimSummary.students.dim_1024_node_wasm : 0) +
    dimSummary.students.other;
  const mismatchedClustersCount =
    (expectedDims !== 16 ? dimSummary.clusters.dim_16_demo : 0) +
    (expectedDims !== 512 ? dimSummary.clusters.dim_512_insightface : 0) +
    (expectedDims !== 1024 ? dimSummary.clusters.dim_1024_node_wasm : 0) +
    dimSummary.clusters.other;
  const hasDimMismatch = mismatchedStudentsCount > 0 || mismatchedClustersCount > 0;

  return (
    <div className="space-y-6">
      {/* Production mode banner if still in Demo/Test mode */}
      {!isProd && onActivateProduction && (
        <section className="bg-amber-50 border border-amber-200 rounded-lg p-4 flex flex-wrap items-center justify-between gap-3">
          <div className="text-xs text-amber-900">
            <div className="font-semibold flex items-center gap-1.5">
              <ShieldCheck className="w-4 h-4 text-amber-700" />
              Sistem masih dalam Mode Uji / Demo (berisi data contoh)
            </div>
            <p className="text-amber-800 mt-0.5">
              Aktifkan Mode Produksi untuk menghapus data siswa &amp; kamera dummy sambil tetap mempertahankan kamera RTSP asli, gerbang, jurusan, dan jadwal Anda.
            </p>
          </div>
          <div className="flex items-center gap-2">
            {!confirmProd ? (
              <button
                type="button"
                onClick={() => setConfirmProd(true)}
                className="px-3.5 py-2 text-xs font-semibold text-white bg-emerald-700 hover:bg-emerald-800 rounded-md whitespace-nowrap"
              >
                Aktifkan Mode Produksi
              </button>
            ) : (
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={activatingProd}
                  onClick={async () => {
                    setActivatingProd(true);
                    try {
                      await onActivateProduction();
                      setConfirmProd(false);
                    } finally {
                      setActivatingProd(false);
                    }
                  }}
                  className="px-3 py-1.5 text-xs font-semibold text-white bg-emerald-700 hover:bg-emerald-800 disabled:opacity-50 rounded"
                >
                  {activatingProd ? 'Memproses...' : 'Ya, Bersihkan Data Demo'}
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmProd(false)}
                  className="px-2.5 py-1.5 text-xs text-slate-700 bg-white border border-slate-300 rounded"
                >
                  Batal
                </button>
              </div>
            )}
          </div>
        </section>
      )}

      {/* Embedding dimension mismatch alert + non-destructive sync action */}
      {hasDimMismatch && (
        <section className="bg-blue-50 border border-blue-200 rounded-lg p-4 flex flex-wrap items-center justify-between gap-3">
          <div className="text-xs text-blue-950">
            <div className="font-semibold">
              Terdeteksi Ketidakcocokan Dimensi Embedding (Engine Aktif: {expectedDims}-D)
            </div>
            <p className="text-blue-900 mt-0.5">
              Ada <strong>{mismatchedStudentsCount} siswa</strong> dan <strong>{mismatchedClustersCount} cluster anonim</strong> dengan vektor dimensi berbeda (misal 16-D demo atau antar engine 512/1024-D). Sinkronkan ulang secara non-destruktif agar wajah bisa langsung cocok tanpa menghapus data.
            </p>
          </div>
          {onMigrateEmbeddings && (
            <button
              type="button"
              disabled={migratingEmb}
              onClick={async () => {
                setMigratingEmb(true);
                try {
                  await onMigrateEmbeddings();
                } finally {
                  setMigratingEmb(false);
                }
              }}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-white bg-blue-700 hover:bg-blue-800 disabled:opacity-50 rounded-md whitespace-nowrap"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${migratingEmb ? 'animate-spin' : ''}`} />
              {migratingEmb ? 'Menyinkronkan...' : `Sinkronkan ke ${expectedDims}-D`}
            </button>
          )}
        </section>
      )}

      {workerStatus && workerStatus.engine !== 'INSIGHTFACE_PYTHON' && (
        <section
          role="alert"
          className="bg-amber-50 border border-amber-200 rounded-lg p-4 flex flex-wrap items-center justify-between gap-3"
        >
          <div className="flex items-start gap-2.5 text-xs text-amber-950">
            <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
            <div>
              <div className="font-semibold">
                Engine AI Wajah Docker (InsightFace buffalo_l 512-D) belum aktif
              </div>
              <p className="text-amber-900 mt-0.5">
                Deteksi RTSP, pendaftaran foto, dan pencocokan wajah membutuhkan container{' '}
                <span className="font-mono font-semibold">docker-compose.face.yml</span>. Jalankan{' '}
                <span className="font-mono font-semibold">npm run setup:school</span> di server agar container aktif otomatis.
              </p>
            </div>
          </div>
        </section>
      )}

      {workerStatus?.engine === 'INSIGHTFACE_PYTHON' && workerStatus.face_backend_error && (
        <section
          role="alert"
          className="bg-red-50 border border-red-200 rounded-lg p-4 flex flex-wrap items-center justify-between gap-3"
        >
          <div className="flex items-start gap-2.5 text-xs text-red-950">
            <AlertTriangle className="w-4 h-4 text-red-600 shrink-0 mt-0.5" />
            <div>
              <div className="font-semibold">
                Container Docker Face AI belum terhubung ke server Node ({workerStatus.face_backend_url ?? 'WEB_BACKEND_URL'})
              </div>
              <p className="text-red-900 mt-0.5 font-mono break-all">
                {workerStatus.face_backend_error}
              </p>
              <p className="text-red-800 mt-1">
                Pastikan Project Port di aaPanel sama dengan <span className="font-mono font-semibold">PORT</span> di file{' '}
                <span className="font-mono font-semibold">.env</span> lalu perbarui container Face AI (<span className="font-mono">npm run update</span>).
              </p>
            </div>
          </div>
        </section>
      )}

      {(workerStatus?.detection_stats ?? []).filter((ds) => ds.bad_quality_alert).map((ds) => (
        <section
          key={`alert-${ds.camera_id}`}
          role="alert"
          className="bg-red-50 border border-red-200 rounded-lg p-4 flex flex-wrap items-center justify-between gap-3"
        >
          <div className="flex items-start gap-2.5 text-xs text-red-900">
            <AlertTriangle className="w-4 h-4 text-red-600 shrink-0 mt-0.5" />
            <div>
              <div className="font-semibold">
                Kualitas gambar kamera {ds.camera_name ?? `Kamera #${ds.camera_id}`} buruk — cek fokus/pencahayaan.
              </div>
              <p className="text-red-800 mt-0.5 font-mono tabular-nums">
                Rasio ditolak 5 menit terakhir: {(ds.drop_ratio * 100).toFixed(1)}% ({ds.total_raw - ds.passed_embedding}/{ds.total_raw} deteksi ditolak sebelum embedding).
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => onNavigateTab('settings')}
            className="px-3 py-1.5 text-xs font-semibold text-red-800 bg-white border border-red-300 hover:bg-red-100 rounded-md whitespace-nowrap"
          >
            Periksa Threshold AI
          </button>
        </section>
      ))}

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

      {/* Live Face AI & RTSP Worker Monitor */}
      <section className="bg-white border border-slate-200 rounded-lg p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <Activity className="w-4 h-4 text-emerald-700" />
            <h2 className="text-sm font-semibold text-slate-900">
              Monitor Engine Face AI &amp; Otomasi Sistem
            </h2>
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs font-mono">
            <span className={isProd ? 'text-emerald-700 font-semibold' : 'text-amber-700 font-semibold'}>
              {isProd ? 'PRODUKSI' : 'MODE UJI'}
            </span>
            <span className="text-slate-600">
              Engine: <strong className="text-slate-900">{workerStatus?.engine ?? 'MEMUAT...'}</strong> ({expectedDims}-D)
            </span>
            <span className="text-slate-600">
              Capture: <strong className="text-slate-900">{describeCaptureResolutionMode(workerStatus?.capture_max_width ?? db.settings.capture_max_width ?? 1280)}</strong> · Min–Max Wajah:{' '}
              <strong className="text-slate-900 tabular-nums">
                {db.settings.min_face_size}
                {(db.settings.max_face_size ?? 0) > 0 ? `–${db.settings.max_face_size}` : '+'} px
              </strong>
            </span>
            <span className="text-slate-600">
              Indeks RAM: <strong className="text-slate-900 tabular-nums">{workerStatus?.indexed_students ?? 0}</strong> vektor
            </span>
            <span className="text-slate-600">
              WIB: <strong className="text-slate-900 tabular-nums">{workerStatus?.server_time_wib?.slice(11, 19) ?? '-'}</strong>
            </span>
            <span className="text-slate-600">
              Model AI:{' '}
              <strong className={workerStatus?.model_loaded ? 'text-emerald-700' : 'text-amber-700'}>
                {workerStatus?.model_loaded ? 'SIAP' : workerStatus?.engine === 'IDLE' ? 'OFFLINE (DOCKER)' : 'INISIALISASI'}
              </strong>
            </span>
            <span className="text-slate-600">
              Wajah Terdeteksi: <strong className="text-slate-900 tabular-nums">{totalFacesLive}</strong>
            </span>
          </div>
        </div>

        <div className="text-[11px] text-slate-500">
          Kebijakan Deteksi: <strong>Kacamata</strong> didukung otomatis (threshold 0.70); <strong>masker penutup hidung/mulut</strong> ditolak di gerbang (<span className="font-mono">DROP:landmark</span>).
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 pt-2 border-t border-slate-100 text-xs">
          <div className="rounded-md bg-slate-50 border border-slate-200/80 px-3 py-2">
            <div className="text-[11px] text-slate-500">Scheduler Harian WIB</div>
            <div className="font-semibold text-emerald-700 mt-0.5">
              {workerStatus?.automation?.daily_scheduler_active === false ? 'Nonaktif' : 'Otomatis (60 dtk)'}
            </div>
          </div>
          <div className="rounded-md bg-slate-50 border border-slate-200/80 px-3 py-2">
            <div className="text-[11px] text-slate-500">Antrean WhatsApp</div>
            <div className={`font-semibold mt-0.5 ${db.settings.wa_auto_dispatch_enabled ? 'text-emerald-700' : 'text-slate-700'}`}>
              {db.settings.wa_auto_dispatch_enabled ? 'Auto-Kirim Aktif' : 'Manual / Dijeda'}
            </div>
          </div>
          <div className="rounded-md bg-slate-50 border border-slate-200/80 px-3 py-2">
            <div className="text-[11px] text-slate-500">Auto-Backup SQLite</div>
            <div className={`font-semibold mt-0.5 ${db.settings.auto_backup_enabled !== false ? 'text-emerald-700' : 'text-slate-700'}`}>
              {db.settings.auto_backup_enabled !== false ? 'Harian (.sqlite.gz)' : 'Nonaktif'}
            </div>
          </div>
          <div className="rounded-md bg-slate-50 border border-slate-200/80 px-3 py-2">
            <div className="text-[11px] text-slate-500">
              Auto-Update GitHub ({workerStatus?.app_version ? `v${workerStatus.app_version}` : 'v1.0.0'})
            </div>
            <div className={`font-semibold mt-0.5 ${workerStatus?.automation?.auto_update_enabled ? 'text-emerald-700' : 'text-slate-600'}`}>
              {workerStatus?.automation?.auto_update_enabled ? 'Aktif (Cek Versi / 1 Jam)' : 'Manual (Cron / CLI)'}
            </div>
          </div>
        </div>

        {workerStatus && workerStatus.cameras.length > 0 ? (
          <div tabIndex={0} role="region" aria-label="Status Worker Kamera RTSP Live" className="table-wrapper">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-slate-200 text-slate-500">
                  <th className="py-2 pr-3 font-medium">Kamera RTSP</th>
                  <th className="py-2 px-3 font-medium">Stream</th>
                  <th className="py-2 px-3 font-medium text-right">FPS</th>
                  <th className="py-2 px-3 font-medium text-right">Frame</th>
                  <th className="py-2 px-3 font-medium text-right">Lolos / Ditolak</th>
                  <th className="py-2 px-3 font-medium text-right">Watchdog</th>
                  <th className="py-2 px-3 font-medium">Frame Terakhir</th>
                  <th className="py-2 pl-3 font-medium">Deteksi Terakhir</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {workerStatus.cameras.map((wc) => {
                  const lastDetect = wc.last_detect_at ?? wc.last_face_at;
                  return (
                    <tr key={wc.camera_id}>
                      <td className="py-2 pr-3 font-medium text-slate-900">
                        {wc.nama_kamera}
                        {wc.last_error && (
                          <div className="text-[11px] font-normal text-red-600 truncate max-w-xs">{wc.last_error}</div>
                        )}
                      </td>
                      <td className="py-2 px-3">
                        <span className={`font-semibold ${wc.connected ? 'text-emerald-700' : 'text-amber-700'}`}>
                          {wc.connected ? 'LIVE' : wc.aktif ? 'RETRY / OFFLINE' : 'NONAKTIF'}
                        </span>
                      </td>
                      <td className="py-2 px-3 text-right font-mono tabular-nums">{wc.fps.toFixed(1)}</td>
                      <td className="py-2 px-3 text-right font-mono tabular-nums">{wc.frames_decoded}</td>
                      <td className="py-2 px-3 text-right font-mono tabular-nums">
                        <strong className="text-slate-900">{wc.faces_detected_total}</strong>
                        <span className="text-slate-400"> / {wc.dropped_filter}</span>
                      </td>
                      <td className="py-2 px-3 text-right font-mono tabular-nums">{wc.watchdog_restarts}x</td>
                      <td className="py-2 px-3 font-mono text-slate-500">
                        {wc.last_frame_at ? wc.last_frame_at.slice(11, 19) : '-'}
                      </td>
                      <td className="py-2 pl-3 font-mono text-slate-500">
                        {lastDetect ? lastDetect.slice(11, 19) : '-'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-xs text-slate-500">
            Belum ada kamera RTSP aktif. Tambahkan URL kamera <span className="font-mono">rtsp://...</span> di menu Gerbang &amp; Kamera agar worker AI memproses video secara real-time.
          </p>
        )}

        {(workerStatus?.detection_stats?.length ?? 0) > 0 && (
          <div className="pt-3 border-t border-slate-100 space-y-2">
            <div className="flex items-center justify-between text-xs">
              <h3 className="font-semibold text-slate-800">Statistik Quality Gate Pre-Embedding (Per 5 Menit)</h3>
              <span className="text-[11px] text-slate-500">
                Blur Min: <strong className="font-mono">{db.settings.blur_threshold ?? 100}</strong> · Yaw/Pitch:{' '}
                <strong className="font-mono">{db.settings.max_yaw_deg ?? 30}°/{db.settings.max_pitch_deg ?? 25}°</strong>
              </span>
            </div>
            <div tabIndex={0} role="region" aria-label="Statistik Quality Gate per Kamera" className="table-wrapper">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="border-b border-slate-200 text-slate-500">
                    <th className="py-1.5 pr-3 font-medium">Kamera</th>
                    <th className="py-1.5 px-2 font-medium text-right">Raw</th>
                    <th className="py-1.5 px-2 font-medium text-right">Lolos Emb</th>
                    <th className="py-1.5 px-2 font-medium text-right">Conf</th>
                    <th className="py-1.5 px-2 font-medium text-right">Landmark</th>
                    <th className="py-1.5 px-2 font-medium text-right">Size</th>
                    <th className="py-1.5 px-2 font-medium text-right">Blur</th>
                    <th className="py-1.5 px-2 font-medium text-right">Pose</th>
                    <th className="py-1.5 pl-2 font-medium text-right">Drop %</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 font-mono tabular-nums">
                  {(workerStatus?.detection_stats ?? []).map((ds) => (
                    <tr key={`ds-${ds.camera_id}`}>
                      <td className="py-1.5 pr-3 font-sans font-medium text-slate-800">
                        {ds.camera_name ?? `Kamera #${ds.camera_id}`}
                      </td>
                      <td className="py-1.5 px-2 text-right">{ds.total_raw}</td>
                      <td className="py-1.5 px-2 text-right text-emerald-700 font-semibold">{ds.passed_embedding}</td>
                      <td className="py-1.5 px-2 text-right text-slate-600">{ds.dropped_confidence}</td>
                      <td className="py-1.5 px-2 text-right text-slate-600">{ds.dropped_landmark}</td>
                      <td className="py-1.5 px-2 text-right text-slate-600">{ds.dropped_size}</td>
                      <td className="py-1.5 px-2 text-right text-slate-600">{ds.dropped_blur}</td>
                      <td className="py-1.5 px-2 text-right text-slate-600">{ds.dropped_pose}</td>
                      <td className={`py-1.5 pl-2 text-right font-semibold ${ds.bad_quality_alert ? 'text-red-700' : 'text-slate-700'}`}>
                        {(ds.drop_ratio * 100).toFixed(1)}%
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
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
              {storageGb.toFixed(2)} GB
              {storageGb < 0.1 && (
                <span className="ml-1.5 text-xs font-semibold text-slate-500">({storageMb.toFixed(2)} MB)</span>
              )}{' '}
              / 10.00 GB
            </span>
            <span className={`text-xs font-medium ${storageTone.text}`}>
              {storageTone.label} · {storagePct}%
            </span>
          </div>
          <progress
            max={100}
            value={storagePct}
            aria-label={`Penggunaan storage ${storageGb.toFixed(2)} GB dari 10 GB`}
            style={{
              ['--progress-fill' as string]: storageGb < 7 ? '#059669' : storageGb <= 9 ? '#d97706' : '#dc2626',
            }}
            className="storage-progress"
          />
          <p className="text-xs text-slate-500 mt-3">
            Batas keras 10 GB: Snapshot maks 4.5 GB (scan foto 3 hari, cluster maks 5 foto, no Base64 DB), Cache TTS 120 MB, Backup 200 MB, File Log maks 1 MB, serta auto-VACUUM SQLite.
          </p>
          {workerStatus?.storage_breakdown && (
            <div className="mt-3 pt-3 border-t border-slate-100 grid grid-cols-2 sm:grid-cols-4 gap-2 text-[11px]">
              <div className="rounded bg-slate-50 border border-slate-200/70 px-2.5 py-1.5">
                <div className="text-slate-500">SQLite + WAL</div>
                <div className="font-mono font-semibold text-slate-900 tabular-nums">
                  {((workerStatus.storage_breakdown.sqlite_bytes + workerStatus.storage_breakdown.wal_bytes) / (1024 * 1024)).toFixed(2)} MB
                </div>
              </div>
              <div className="rounded bg-slate-50 border border-slate-200/70 px-2.5 py-1.5">
                <div className="text-slate-500">Snapshots &amp; Backup</div>
                <div className="font-mono font-semibold text-slate-900 tabular-nums">
                  {((workerStatus.storage_breakdown.snapshots_bytes + workerStatus.storage_breakdown.backups_bytes) / (1024 * 1024)).toFixed(2)} MB
                </div>
              </div>
              <div className="rounded bg-slate-50 border border-slate-200/70 px-2.5 py-1.5">
                <div className="text-slate-500">Cache TTS &amp; Log</div>
                <div className="font-mono font-semibold text-slate-900 tabular-nums">
                  {((workerStatus.storage_breakdown.tts_cache_bytes + workerStatus.storage_breakdown.logs_bytes) / (1024 * 1024)).toFixed(2)} MB
                </div>
              </div>
              <div className="rounded bg-slate-50 border border-slate-200/70 px-2.5 py-1.5">
                <div className="text-slate-500">Baris Log Aktif</div>
                <div className="font-mono font-semibold text-slate-900 tabular-nums">
                  {workerStatus.storage_breakdown.rows.attendance_logs +
                    workerStatus.storage_breakdown.rows.wa_queue +
                    workerStatus.storage_breakdown.rows.notifications +
                    workerStatus.storage_breakdown.rows.guest_access_logs} baris
                </div>
              </div>
            </div>
          )}
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
          <div tabIndex={0} role="region" aria-label="Status Akun WhatsApp Gateway" className="table-wrapper">
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
                      <td className="py-2.5 text-slate-600">{acc.provider === 'WA_WEB' ? 'WA Web Chromium' : acc.provider}</td>
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
          <div tabIndex={0} role="region" aria-label="Status Kamera Gerbang" className="table-wrapper">
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
                {db.cameras.length === 0 && (
                  <tr>
                    <td colSpan={4} className="py-4 text-center text-slate-500">
                      Belum ada kamera terdaftar.
                    </td>
                  </tr>
                )}
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
              Tinjau Cluster Anonim ({readyClusters} ready / {pendingClusters} dilatih)
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
