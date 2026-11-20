import React, { useEffect, useState } from 'react';
import { Activity, ExternalLink, Eye, RefreshCw, Trash2, X } from 'lucide-react';
import { maskRtspCredentials } from '../lib/attendanceEngine';
import type { AppDatabase, GateType, WorkerStatusResponse } from '../types';

export interface RtspProbeResult {
  ok: boolean;
  online: boolean;
  camera_id: number | null;
  codec: string;
  width: number;
  height: number;
  resolusi: string;
  fps: number;
  latency_ms: number;
  snapshotDataUrl: string;
  face_service_online: boolean;
}

interface CamerasGatesViewProps {
  db: AppDatabase;
  workerStatus?: WorkerStatusResponse | null;
  onAddGate: (payload: { nama_gerbang: string; lokasi: string; tipe: GateType }) => Promise<void>;
  onDeleteGate: (id: number) => Promise<void>;
  onAddCamera: (payload: { nama_kamera: string; gate_id: number; rtsp_url: string; resolusi: string; fps: number }) => Promise<void>;
  onToggleCamera: (id: number, aktif: boolean) => Promise<void>;
  onDeleteCamera: (id: number) => Promise<void>;
  onProbeCamera: (payload: { camera_id?: number; rtsp_url?: string }) => Promise<RtspProbeResult>;
  onOpenPanggil: (camId: number) => void;
}

export const CamerasGatesView: React.FC<CamerasGatesViewProps> = ({
  db,
  workerStatus,
  onAddGate,
  onDeleteGate,
  onAddCamera,
  onToggleCamera,
  onDeleteCamera,
  onProbeCamera,
  onOpenPanggil,
}) => {
  const [namaGerbang, setNamaGerbang] = useState('');
  const [lokasi, setLokasi] = useState('');
  const [tipe, setTipe] = useState<GateType>('BOTH');

  const [namaKamera, setNamaKamera] = useState('');
  const [gateId, setGateId] = useState(String(db.gates[0]?.id ?? 1));
  const [rtspUrl, setRtspUrl] = useState('');
  const [resolusi, setResolusi] = useState('1920x1080');
  const [fps, setFps] = useState('5');

  const [probing, setProbing] = useState(false);
  const [probeError, setProbeError] = useState('');
  const [previewTarget, setPreviewTarget] = useState<{ label: string; camera_id?: number; rtsp_url?: string } | null>(null);
  const [previewData, setPreviewData] = useState<RtspProbeResult | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(false);

  const runProbe = async (target: { label: string; camera_id?: number; rtsp_url?: string }, updateDraftMeta = false) => {
    setProbing(true);
    setProbeError('');
    setPreviewTarget(target);
    try {
      const res = await onProbeCamera({ camera_id: target.camera_id, rtsp_url: target.rtsp_url });
      setPreviewData(res);
      if (updateDraftMeta) {
        if (res.resolusi && res.resolusi !== '-') setResolusi(res.resolusi);
        if (res.fps > 0) setFps(String(Math.round(res.fps)));
      }
    } catch (err) {
      setProbeError(err instanceof Error ? err.message : 'Gagal terhubung ke kamera RTSP.');
      setAutoRefresh(false);
    } finally {
      setProbing(false);
    }
  };

  useEffect(() => {
    if (!autoRefresh || !previewTarget) return;
    const timer = window.setInterval(() => {
      if (!probing) {
        runProbe(previewTarget, false).catch(() => {});
      }
    }, 2500);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoRefresh, previewTarget]);

  const handleGateSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    await onAddGate({ nama_gerbang: namaGerbang, lokasi, tipe });
    setNamaGerbang('');
    setLokasi('');
  };

  const handleCamSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    await onAddCamera({
      nama_kamera: namaKamera.trim(),
      gate_id: Number(gateId),
      rtsp_url: rtspUrl.trim(),
      resolusi,
      fps: Number(fps),
    });
    setNamaKamera('');
    setRtspUrl('');
  };

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <section className="bg-white border border-slate-200 rounded-lg p-5">
          <h2 className="text-sm font-semibold text-slate-900 mb-3">Tambah Gerbang Sekolah</h2>
          <form onSubmit={handleGateSubmit} className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
            <input placeholder="Nama Gerbang" required value={namaGerbang} onChange={(e) => setNamaGerbang(e.target.value)} className="border border-slate-300 rounded px-2.5 py-1.5 text-xs" />
            <input placeholder="Lokasi" value={lokasi} onChange={(e) => setLokasi(e.target.value)} className="border border-slate-300 rounded px-2.5 py-1.5 text-xs" />
            <select value={tipe} onChange={(e) => setTipe(e.target.value as GateType)} className="border border-slate-300 rounded px-2.5 py-1.5 text-xs bg-white">
              <option value="BOTH">BOTH (Masuk &amp; Keluar)</option>
              <option value="MASUK">MASUK</option>
              <option value="KELUAR">KELUAR</option>
            </select>
            <button type="submit" className="sm:col-span-3 py-2 text-xs font-semibold text-white bg-blue-700 hover:bg-blue-800 rounded-md">
              Simpan Gerbang
            </button>
          </form>

          <table className="w-full text-left text-xs mt-4">
            <thead>
              <tr className="border-b border-slate-200 text-slate-500">
                <th className="py-2 font-medium">Gerbang</th>
                <th className="py-2 font-medium">Tipe</th>
                <th className="py-2 font-medium text-right">Aksi</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {db.gates.map((g) => (
                <tr key={g.id}>
                  <td className="py-2">
                    <div className="font-medium text-slate-900">{g.nama_gerbang}</div>
                    <div className="text-[11px] text-slate-400">{g.lokasi || '-'}</div>
                  </td>
                  <td className="py-2 font-mono text-slate-700">{g.tipe}</td>
                  <td className="py-2 text-right">
                    <button type="button" onClick={() => onDeleteGate(g.id)} aria-label={`Hapus gerbang ${g.nama_gerbang}`} className="p-1 text-slate-400 hover:text-red-600">
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section className="bg-white border border-slate-200 rounded-lg p-5">
          <h2 className="text-sm font-semibold text-slate-900 mb-3">Tambah &amp; Uji Kamera RTSP (Multi-Kamera, 1080p @ 5 FPS)</h2>
          <form onSubmit={handleCamSubmit} className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
            <input placeholder="Nama Kamera Unik" required value={namaKamera} onChange={(e) => setNamaKamera(e.target.value)} className="border border-slate-300 rounded px-2.5 py-1.5 text-xs sm:col-span-2" />
            <select value={gateId} onChange={(e) => setGateId(e.target.value)} className="border border-slate-300 rounded px-2.5 py-1.5 text-xs bg-white">
              {db.gates.map((g) => <option key={g.id} value={g.id}>{g.nama_gerbang} ({g.tipe})</option>)}
            </select>
            <input placeholder="rtsp://user:pass@ip:554/stream" required value={rtspUrl} onChange={(e) => setRtspUrl(e.target.value)} className="border border-slate-300 rounded px-2.5 py-1.5 text-xs font-mono sm:col-span-3" />
            <select aria-label="Resolusi Kamera" value={resolusi} onChange={(e) => setResolusi(e.target.value)} className="border border-slate-300 rounded px-2.5 py-1.5 text-xs font-mono bg-white">
              <option value="1920x1080">1920x1080 (1080p)</option>
              <option value="2560x1440">2560x1440 (2K)</option>
              <option value="3840x2160">3840x2160 (4K)</option>
              <option value="1280x720">1280x720 (720p)</option>
            </select>
            <input type="number" min="1" max="30" value={fps} onChange={(e) => setFps(e.target.value)} placeholder="FPS (5)" className="border border-slate-300 rounded px-2.5 py-1.5 text-xs font-mono" />
            <div className="flex gap-1.5">
              <button
                type="button"
                disabled={probing || !/^rtsps?:\/\//i.test(rtspUrl.trim())}
                onClick={() => runProbe({ label: namaKamera.trim() || 'Uji RTSP Draft', rtsp_url: rtspUrl.trim() }, true)}
                className="px-2.5 py-2 text-xs font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 disabled:opacity-40 rounded-md whitespace-nowrap"
              >
                Uji RTSP
              </button>
              <button type="submit" className="flex-1 py-2 text-xs font-semibold text-white bg-blue-700 hover:bg-blue-800 rounded-md">
                Tambah
              </button>
            </div>
          </form>
        </section>
      </div>

      {/* Live Preview Panel */}
      {(previewTarget || probeError) && (
        <section className="bg-white border border-slate-200 rounded-lg p-5 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold text-slate-900">
                Live Preview Stream RTSP — {previewTarget?.label}
              </h2>
              {previewData && (
                <div className="text-xs font-mono text-slate-600 mt-0.5 tabular-nums">
                  Status: <strong className="text-emerald-700">ONLINE</strong> · Codec: <strong>{previewData.codec}</strong> · Resolusi: <strong>{previewData.resolusi}</strong> · FPS: <strong>{previewData.fps}</strong> · Latensi: <strong>{previewData.latency_ms} ms</strong>
                </div>
              )}
            </div>
            <div className="flex items-center gap-3">
              <label className="inline-flex items-center gap-1.5 text-xs text-slate-700 cursor-pointer">
                <input
                  type="checkbox"
                  checked={autoRefresh}
                  onChange={(e) => setAutoRefresh(e.target.checked)}
                />
                Auto-Refresh (2.5 dtk)
              </label>
              <button
                type="button"
                disabled={probing || !previewTarget}
                onClick={() => previewTarget && runProbe(previewTarget, false)}
                className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-white bg-blue-700 hover:bg-blue-800 disabled:opacity-50 rounded-md"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${probing ? 'animate-spin' : ''}`} />
                Refresh Frame
              </button>
              <button
                type="button"
                aria-label="Tutup Preview RTSP"
                onClick={() => {
                  setAutoRefresh(false);
                  setPreviewTarget(null);
                  setPreviewData(null);
                  setProbeError('');
                }}
                className="p-1.5 text-slate-500 hover:text-slate-900 border border-slate-200 rounded-md"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>

          {probeError && (
            <div className="p-3 bg-red-50 border border-red-200 rounded-md text-xs text-red-700 font-medium">
              {probeError}
            </div>
          )}

          {previewData?.snapshotDataUrl && (
            <div className="space-y-2">
              <img
                src={previewData.snapshotDataUrl}
                alt={`Live frame ${previewTarget?.label}`}
                className="w-full max-h-[460px] object-contain bg-slate-950 rounded-md border border-slate-200"
              />
              <p className="text-[11px] text-slate-500">
                {previewData.face_service_online
                  ? 'Engine InsightFace aktif dan terhubung ke kamera ini.'
                  : workerStatus?.engine === 'NODE_WASM_LIVE'
                    ? 'Preview FFmpeg RTSP berhasil & Worker Face AI Node (WASM) aktif memantau deteksi wajah anonim/siswa secara live dari stream kamera ini.'
                    : 'Preview FFmpeg RTSP berhasil langsung dari kamera.'}
              </p>
            </div>
          )}
        </section>
      )}

      <section className="bg-white border border-slate-200 rounded-lg p-5 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-slate-900">Daftar Kamera Aktif &amp; Link Halaman Panggil</h2>
          {workerStatus && (
            <div className="inline-flex items-center gap-2 text-xs font-mono text-slate-600">
              <Activity className="w-3.5 h-3.5 text-emerald-700" />
              <span>Engine: <strong className="text-slate-900">{workerStatus.engine}</strong></span>
              <span>· Worker Aktif: <strong className="text-slate-900">{workerStatus.active_workers}</strong></span>
            </div>
          )}
        </div>

        <div tabIndex={0} role="region" aria-label="Daftar Kamera RTSP Gerbang" className="table-wrapper">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-slate-200 text-slate-500">
                <th className="py-2 font-medium">Nama Kamera</th>
                <th className="py-2 font-medium">Gerbang</th>
                <th className="py-2 font-medium">URL RTSP &amp; Spec</th>
                <th className="py-2 font-medium">Status &amp; Statistik AI Live</th>
                <th className="py-2 font-medium">Kiosk Panggil</th>
                <th className="py-2 font-medium text-right">Kontrol</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {db.cameras.map((c) => {
                const gate = db.gates.find((g) => g.id === c.gate_id);
                const isDummy = !c.rtsp_url || c.rtsp_url.startsWith('dummy://');
                const stat = workerStatus?.cameras.find((wc) => wc.camera_id === c.id);
                return (
                  <tr key={c.id}>
                    <td className="py-2.5 font-medium text-slate-900">{c.nama_kamera}</td>
                    <td className="py-2.5 text-slate-600">{gate?.nama_gerbang ?? '-'} · {gate?.tipe}</td>
                    <td className="py-2.5 max-w-xs">
                      <div className="font-mono text-[11px] text-slate-600 truncate">{maskRtspCredentials(c.rtsp_url)}</div>
                      <div className="text-[11px] text-slate-400 font-mono">{c.resolusi} · {c.fps} FPS</div>
                    </td>
                    <td className="py-2.5">
                      <span className={`font-semibold ${c.status === 'ONLINE' ? 'text-emerald-700' : 'text-red-700'}`}>{c.status}</span>
                      {stat && (
                        <div className="text-[11px] font-mono text-slate-600 tabular-nums">
                          Frame: <strong>{stat.frames_decoded}</strong> · Wajah: <strong>{stat.faces_detected_total}</strong>
                          {stat.last_frame_at ? ` · Last ${stat.last_frame_at.slice(11, 19)}` : ''}
                        </div>
                      )}
                      {c.last_error && <div className="text-[11px] text-slate-400 max-w-xs truncate">{c.last_error}</div>}
                    </td>
                    <td className="py-2.5">
                      <button type="button" onClick={() => onOpenPanggil(c.id)} className="inline-flex items-center gap-1 text-blue-700 hover:underline font-medium">
                        /panggil/{c.id} <ExternalLink className="w-3 h-3" />
                      </button>
                    </td>
                    <td className="py-2.5 text-right whitespace-nowrap space-x-1.5">
                      <button
                        type="button"
                        disabled={probing || isDummy}
                        onClick={() => runProbe({ label: c.nama_kamera, camera_id: c.id }, false)}
                        className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-blue-700 border border-blue-200 bg-blue-50 hover:bg-blue-100 disabled:opacity-40 rounded"
                      >
                        <Eye className="w-3 h-3" /> Uji &amp; Preview
                      </button>
                      <button
                        type="button"
                        onClick={() => onToggleCamera(c.id, !c.aktif)}
                        className="px-2 py-1 text-xs border border-slate-300 rounded hover:bg-slate-100"
                      >
                        {c.aktif ? 'Nonaktifkan' : 'Aktifkan'}
                      </button>
                      <button type="button" onClick={() => onDeleteCamera(c.id)} aria-label={`Hapus kamera ${c.nama_kamera}`} className="p-1 text-slate-400 hover:text-red-600 align-middle">
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </td>
                  </tr>
                );
              })}
              {db.cameras.length === 0 && (
                <tr>
                  <td colSpan={6} className="py-4 text-center text-slate-500">
                    Belum ada kamera RTSP terdaftar.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
};
