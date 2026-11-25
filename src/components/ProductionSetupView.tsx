import React, { useCallback, useEffect, useState } from 'react';
import {
  CheckCircle2,
  CircleDashed,
  ArrowRight,
  ShieldCheck,
  Rocket,
  HardDrive,
  RefreshCw,
  ExternalLink,
  Save,
} from 'lucide-react';
import type { AppDatabase, SettingsMap, TTSMode, WorkerStatusResponse } from '../types';
import { summarizeEmbeddingDimensions } from '../lib/attendanceEngine';
import { evaluateProductionReadiness, type SetupStepActionTab } from '../lib/productionReadiness';
import { TOTAL_STORAGE_LIMIT_BYTES } from '../lib/storageBudget';

interface ProductionSetupViewProps {
  db: AppDatabase;
  workerStatus: WorkerStatusResponse | null;
  onSaveSettings: (patch: Partial<SettingsMap>) => Promise<void>;
  onActivateProduction: (opts: { cleanDemoData: boolean; production_mode: boolean }) => Promise<void>;
  onMigrateEmbeddings: () => Promise<void>;
  onCleanupStorage: () => Promise<void>;
  onNavigateTab: (tab: SetupStepActionTab) => void;
  onOpenPanggil: (cameraId: number) => void;
  onOpenGuest: () => void;
}

interface HealthSummary {
  ok: boolean;
  ffmpeg_ready: boolean;
  ffmpeg_error: string | null;
  piper_offline: boolean;
  server_time_wib: string;
}

export const ProductionSetupView: React.FC<ProductionSetupViewProps> = ({
  db,
  workerStatus,
  onSaveSettings,
  onActivateProduction,
  onMigrateEmbeddings,
  onCleanupStorage,
  onNavigateTab,
  onOpenPanggil,
  onOpenGuest,
}) => {
  const [health, setHealth] = useState<HealthSummary | null>(null);
  const [backupCount, setBackupCount] = useState(0);
  const [loadingInfra, setLoadingInfra] = useState(true);
  const [actionBusy, setActionBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  // Quick production core settings
  const [schoolName, setSchoolName] = useState(db.settings.school_name);
  const [cutoffKeluar, setCutoffKeluar] = useState(db.settings.cutoff_keluar);
  const [waDelayMin, setWaDelayMin] = useState(String(db.settings.wa_delay_after_pulang_menit));
  const [ttsMode, setTtsMode] = useState<TTSMode>(db.settings.tts_mode);
  const [backupRetention, setBackupRetention] = useState(String(db.settings.backup_retention_count ?? 2));
  const [savingQuick, setSavingQuick] = useState(false);

  const loadInfraStatus = useCallback(async () => {
    setLoadingInfra(true);
    try {
      const [hRes, bRes] = await Promise.all([fetch('/api/health'), fetch('/api/backups')]);
      if (hRes.ok) {
        const hData = await hRes.json();
        setHealth({
          ok: Boolean(hData.ok),
          ffmpeg_ready: Boolean(hData.ffmpeg_ready),
          ffmpeg_error: hData.ffmpeg_error ?? null,
          piper_offline: Boolean(hData.piper_offline),
          server_time_wib: String(hData.server_time_wib ?? ''),
        });
      }
      if (bRes.ok) {
        const bData = await bRes.json();
        setBackupCount(Array.isArray(bData.backups) ? bData.backups.length : 0);
      }
    } catch {
      // ignore transient network fetch issue
    } finally {
      setLoadingInfra(false);
    }
  }, []);

  useEffect(() => {
    void loadInfraStatus();
  }, [loadInfraStatus]);

  const readiness = evaluateProductionReadiness({
    db,
    workerStatus,
    ffmpegReady: health?.ffmpeg_ready ?? true,
    backupCount,
  });

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

  const totalUsedBytes = workerStatus?.storage_breakdown?.total_bytes ?? db.storage_bytes_simulated;
  const usedGb = (totalUsedBytes / (1024 * 1024 * 1024)).toFixed(2);
  const usedMb = Math.round((totalUsedBytes / (1024 * 1024)) * 10) / 10;
  const storagePct = Math.min(100, Math.round((totalUsedBytes / TOTAL_STORAGE_LIMIT_BYTES) * 1000) / 10);
  const defaultCameraId = db.cameras.find((c) => c.aktif)?.id ?? db.cameras[0]?.id ?? 1;

  const handleQuickSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (schoolName.trim().length < 3) {
      setFeedback({ type: 'err', text: 'Nama sekolah minimal 3 karakter.' });
      return;
    }
    setSavingQuick(true);
    setFeedback(null);
    try {
      await onSaveSettings({
        school_name: schoolName.trim(),
        cutoff_keluar: cutoffKeluar,
        wa_delay_after_pulang_menit: Math.max(0, Number(waDelayMin) || 60),
        tts_mode: ttsMode,
        backup_retention_count: Math.max(1, Math.min(10, Number(backupRetention) || 2)),
      });
      setFeedback({ type: 'ok', text: 'Konfigurasi inti produksi berhasil disimpan.' });
    } finally {
      setSavingQuick(false);
    }
  };

  const handleRunFirstBackup = async () => {
    setActionBusy(true);
    setFeedback(null);
    try {
      const res = await fetch('/api/backups/run', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) {
        setFeedback({ type: 'err', text: data.error || 'Gagal membuat backup awal.' });
      } else {
        setFeedback({
          type: 'ok',
          text: `Backup produksi ${data.backup?.filename ?? ''} berhasil dibuat.`,
        });
        await loadInfraStatus();
      }
    } finally {
      setActionBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Banner Progres Kesiapan Produksi */}
      <section className="bg-white border border-slate-200 rounded-lg p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-1 max-w-2xl">
            <div className="flex items-center gap-2">
              <Rocket className="w-5 h-5 text-blue-700" />
              <h2 className="text-base font-bold text-slate-900">
                Panduan Setup Produksi Sekolah (0% → 100%)
              </h2>
            </div>
            <p className="text-xs text-slate-600">
              Ikuti 6 langkah di bawah untuk memastikan seluruh sistem — database siswa, kamera CCTV RTSP, AI wajah, jadwal, WhatsApp orang tua, serta batas storage 10 GB — berjalan otomatis di produksi.
            </p>
          </div>
          <div className="text-right shrink-0">
            <div className="text-2xl font-bold font-mono tabular-nums text-slate-900">
              {readiness.percent}%
            </div>
            <div className="text-xs text-slate-500">
              {readiness.completedCount} dari {readiness.totalSteps} langkah siap
            </div>
          </div>
        </div>

        <div className="mt-4 w-full h-2.5 bg-slate-100 rounded-full overflow-hidden">
          <div
            className={`h-full transition-all duration-300 ${
              readiness.isReadyForProduction ? 'bg-emerald-600' : 'bg-blue-600'
            }`}
            style={{ width: `${readiness.percent}%` }}
          />
        </div>

        <div className="mt-4 grid grid-cols-2 sm:grid-cols-4 gap-3 pt-4 border-t border-slate-100 text-xs">
          <div>
            <div className="text-slate-500">Engine AI Aktif</div>
            <div className="font-semibold font-mono text-slate-900 mt-0.5 truncate">
              {workerStatus?.engine ?? 'MEMUAT...'} ({expectedDims}-D)
            </div>
          </div>
          <div>
            <div className="text-slate-500">FFmpeg RTSP</div>
            <div className={`font-semibold mt-0.5 ${health?.ffmpeg_ready ? 'text-emerald-700' : 'text-red-700'}`}>
              {loadingInfra ? 'Memeriksa...' : health?.ffmpeg_ready ? 'SIAP LIVE' : 'PERLU PERBAIKAN'}
            </div>
          </div>
          <div>
            <div className="text-slate-500">Storage Data (Max 10 GB)</div>
            <div className="font-semibold font-mono tabular-nums text-slate-900 mt-0.5">
              {usedMb < 1024 ? `${usedMb} MB` : `${usedGb} GB`} ({storagePct}%)
            </div>
          </div>
          <div>
            <div className="text-slate-500">Mode Operasi</div>
            <div className={`font-semibold mt-0.5 ${db.settings.production_mode ? 'text-emerald-700' : 'text-amber-700'}`}>
              {db.settings.production_mode ? 'PRODUKSI LIVE' : 'MODE UJI / DEMO'}
            </div>
          </div>
        </div>
      </section>

      {feedback && (
        <div
          role="status"
          className={`px-4 py-3 rounded-md border text-xs font-medium ${
            feedback.type === 'ok'
              ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
              : 'bg-red-50 border-red-200 text-red-800'
          }`}
        >
          {feedback.text}
        </div>
      )}

      {workerStatus && workerStatus.engine !== 'INSIGHTFACE_PYTHON' && (
        <div role="alert" className="bg-amber-50 border border-amber-200 rounded-lg p-4 text-xs text-amber-950">
          <div className="font-semibold">Engine AI Wajah Docker (InsightFace buffalo_l 512-D) Belum Aktif</div>
          <p className="mt-1">
            Jalankan <span className="font-mono font-semibold">npm run setup:school</span> (atau{' '}
            <span className="font-mono font-semibold">docker compose -f docker-compose.face.yml up -d --build</span>) agar worker RTSP &amp; enrollment 512-D aktif.
          </p>
        </div>
      )}

      {health && !health.ffmpeg_ready && health.ffmpeg_error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-xs text-red-800">
          <div className="font-semibold">FFmpeg Belum Siap untuk Kamera RTSP Live</div>
          <p className="mt-1">{health.ffmpeg_error}</p>
        </div>
      )}

      {/* Checklist 6 Langkah Setup Produksi */}
      <section className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {readiness.steps.map((step) => (
          <div
            key={step.id}
            className={`bg-white border rounded-lg p-4 flex flex-col justify-between gap-3 ${
              step.done ? 'border-emerald-200' : 'border-slate-200'
            }`}
          >
            <div className="space-y-1.5">
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-center gap-2">
                  {step.done ? (
                    <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
                  ) : (
                    <CircleDashed className="w-4 h-4 text-amber-600 shrink-0" />
                  )}
                  <h3 className="text-sm font-semibold text-slate-900">
                    {step.number}. {step.title}
                  </h3>
                </div>
                <span
                  className={`text-[10px] font-mono font-semibold px-2 py-0.5 rounded border shrink-0 ${
                    step.done
                      ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
                      : 'bg-amber-50 border-amber-200 text-amber-800'
                  }`}
                >
                  {step.done ? 'SELESAI' : 'PERLU SETUP'}
                </span>
              </div>
              <p className="text-xs text-slate-500">{step.description}</p>
              <div className="text-xs font-mono text-slate-700 bg-slate-50 border border-slate-100 rounded px-2.5 py-1.5">
                {step.summary}
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-slate-100">
              <button
                type="button"
                onClick={() => onNavigateTab(step.actionTab)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-blue-700 bg-blue-50 hover:bg-blue-100 rounded-md transition-colors"
              >
                <span>{step.actionLabel}</span>
                <ArrowRight className="w-3.5 h-3.5" />
              </button>

              {step.id === 'wa_kiosk' && (
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => onOpenPanggil(defaultCameraId)}
                    className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-md"
                  >
                    <span>Kiosk #{defaultCameraId}</span>
                    <ExternalLink className="w-3 h-3" />
                  </button>
                  <button
                    type="button"
                    onClick={onOpenGuest}
                    className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-md"
                  >
                    <span>Portal Ortu</span>
                    <ExternalLink className="w-3 h-3" />
                  </button>
                </div>
              )}
            </div>
          </div>
        ))}
      </section>

      {/* Konfigurasi Cepat Produksi & Aksi Hardening */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <section className="lg:col-span-2 bg-white border border-slate-200 rounded-lg p-5">
          <h3 className="text-sm font-semibold text-slate-900 mb-3">
            Pengaturan Cepat Produksi Sekolah
          </h3>
          <form onSubmit={handleQuickSave} className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="sm:col-span-2">
              <label htmlFor="prod-school-name" className="block text-xs text-slate-600 mb-1">
                Nama Resmi Sekolah
              </label>
              <input
                id="prod-school-name"
                type="text"
                required
                value={schoolName}
                onChange={(e) => setSchoolName(e.target.value)}
                className="w-full border border-slate-300 rounded-md px-3 py-2 text-xs"
              />
            </div>

            <div>
              <label htmlFor="prod-cutoff" className="block text-xs text-slate-600 mb-1">
                Batas Cutoff Pulang (WIB)
              </label>
              <input
                id="prod-cutoff"
                type="text"
                value={cutoffKeluar}
                onChange={(e) => setCutoffKeluar(e.target.value)}
                placeholder="18:00:00"
                className="w-full border border-slate-300 rounded-md px-3 py-2 text-xs font-mono"
              />
            </div>

            <div>
              <label htmlFor="prod-wa-delay" className="block text-xs text-slate-600 mb-1">
                Jeda Kirim WA Pulang (Menit)
              </label>
              <input
                id="prod-wa-delay"
                type="number"
                min={0}
                max={240}
                value={waDelayMin}
                onChange={(e) => setWaDelayMin(e.target.value)}
                className="w-full border border-slate-300 rounded-md px-3 py-2 text-xs font-mono"
              />
            </div>

            <div>
              <label htmlFor="prod-tts-mode" className="block text-xs text-slate-600 mb-1">
                Mode Suara Kiosk Panggil
              </label>
              <select
                id="prod-tts-mode"
                value={ttsMode}
                onChange={(e) => setTtsMode(e.target.value as TTSMode)}
                className="w-full border border-slate-300 rounded-md px-3 py-2 text-xs bg-white"
              >
                <option value="AUTO_ADAPTIVE">AUTO_ADAPTIVE (Pintar saat gerbang ramai)</option>
                <option value="FULL_NAME">FULL_NAME (Selalu panggil nama siswa)</option>
                <option value="CHIME_ONLY">CHIME_ONLY (Bel saja tanpa suara nama)</option>
              </select>
            </div>

            <div>
              <label htmlFor="prod-backup-ret" className="block text-xs text-slate-600 mb-1">
                Jumlah Backup Tersimpan (Kuota 200 MB)
              </label>
              <input
                id="prod-backup-ret"
                type="number"
                min={1}
                max={10}
                value={backupRetention}
                onChange={(e) => setBackupRetention(e.target.value)}
                className="w-full border border-slate-300 rounded-md px-3 py-2 text-xs font-mono"
              />
            </div>

            <div className="sm:col-span-2 flex justify-end pt-2">
              <button
                type="submit"
                disabled={savingQuick}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-blue-700 hover:bg-blue-800 disabled:opacity-50 rounded-md"
              >
                <Save className="w-3.5 h-3.5" />
                {savingQuick ? 'Menyimpan...' : 'Simpan Pengaturan Produksi'}
              </button>
            </div>
          </form>
        </section>

        <section className="bg-white border border-slate-200 rounded-lg p-5 space-y-3">
          <h3 className="text-sm font-semibold text-slate-900 flex items-center gap-2">
            <ShieldCheck className="w-4 h-4 text-emerald-700" />
            Aksi Finalisasi Produksi
          </h3>
          <p className="text-xs text-slate-500">
            Jalankan tindakan berikut sebelum kamera sekolah dibuka untuk ribuan siswa.
          </p>

          <div className="space-y-2.5 pt-1">
            {!db.settings.production_mode ? (
              <button
                type="button"
                disabled={actionBusy}
                onClick={async () => {
                  setActionBusy(true);
                  try {
                    await onActivateProduction({ cleanDemoData: true, production_mode: true });
                    await loadInfraStatus();
                  } finally {
                    setActionBusy(false);
                  }
                }}
                className="w-full px-3.5 py-2 text-xs font-semibold text-white bg-emerald-700 hover:bg-emerald-800 disabled:opacity-50 rounded-md text-left"
              >
                Aktifkan Mode Produksi &amp; Bersihkan Data Contoh
              </button>
            ) : (
              <div className="px-3 py-2 rounded-md bg-emerald-50 border border-emerald-200 text-xs text-emerald-800 font-medium">
                Mode Produksi sudah aktif (simulator &amp; data contoh dinonaktifkan).
              </div>
            )}

            {hasDimMismatch && (
              <button
                type="button"
                disabled={actionBusy}
                onClick={async () => {
                  setActionBusy(true);
                  try {
                    await onMigrateEmbeddings();
                  } finally {
                    setActionBusy(false);
                  }
                }}
                className="w-full inline-flex items-center justify-between px-3.5 py-2 text-xs font-semibold text-white bg-blue-700 hover:bg-blue-800 disabled:opacity-50 rounded-md"
              >
                <span>Sinkronkan Dimensi Wajah ke {expectedDims}-D</span>
                <RefreshCw className="w-3.5 h-3.5" />
              </button>
            )}

            <button
              type="button"
              disabled={actionBusy}
              onClick={handleRunFirstBackup}
              className="w-full inline-flex items-center justify-between px-3.5 py-2 text-xs font-medium text-slate-800 bg-slate-100 hover:bg-slate-200 disabled:opacity-50 rounded-md"
            >
              <span>Buat Backup Database Awal (.sqlite.gz)</span>
              <HardDrive className="w-3.5 h-3.5 text-slate-600" />
            </button>

            <button
              type="button"
              disabled={actionBusy}
              onClick={async () => {
                setActionBusy(true);
                try {
                  await onCleanupStorage();
                  await loadInfraStatus();
                } finally {
                  setActionBusy(false);
                }
              }}
              className="w-full inline-flex items-center justify-between px-3.5 py-2 text-xs font-medium text-slate-800 bg-slate-100 hover:bg-slate-200 disabled:opacity-50 rounded-md"
            >
              <span>Jalankan Pembersihan Storage (Cap 10 GB)</span>
              <RefreshCw className="w-3.5 h-3.5 text-slate-600" />
            </button>
          </div>
        </section>
      </div>
    </div>
  );
};
