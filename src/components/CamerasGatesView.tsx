import React, { useEffect, useState } from 'react';
import {
  Activity,
  Crosshair,
  ExternalLink,
  Eye,
  RefreshCw,
  SlidersHorizontal,
  Trash2,
  X,
} from 'lucide-react';
import {
  computeCalibratedMinFacePx,
  describeCaptureResolutionMode,
  formatManualResolution,
  maskRtspCredentials,
  normalizeCaptureMaxWidth,
  normalizeMaxFaceSize,
  normalizeMinFaceSize,
  parseResolutionDimensions,
} from '../lib/attendanceEngine';
import type { AppDatabase, Camera, GateType, WorkerStatusResponse } from '../types';

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
  onUpdateCamera: (id: number, payload: Partial<Camera>) => Promise<void>;
  onToggleCamera: (id: number, aktif: boolean) => Promise<void>;
  onDeleteCamera: (id: number) => Promise<void>;
  onProbeCamera: (payload: { camera_id?: number; rtsp_url?: string }) => Promise<RtspProbeResult>;
  onOpenPanggil: (camId: number) => void;
}

const PRESET_RESOLUTIONS = ['1280x720', '1920x1080', '2304x1296', '2560x1440', '3840x2160'];
const PRESET_CAPTURE_WIDTHS = [0, 640, 960, 1280, 1920, 2560, 3840];

export const CamerasGatesView: React.FC<CamerasGatesViewProps> = ({
  db,
  workerStatus,
  onAddGate,
  onDeleteGate,
  onAddCamera,
  onUpdateCamera,
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
  const [customAddRes, setCustomAddRes] = useState(false);
  const [addWidth, setAddWidth] = useState(1920);
  const [addHeight, setAddHeight] = useState(1080);
  const [fps, setFps] = useState('5');

  const [probing, setProbing] = useState(false);
  const [probeError, setProbeError] = useState('');
  const [previewTarget, setPreviewTarget] = useState<{ label: string; camera_id?: number; rtsp_url?: string } | null>(null);
  const [previewData, setPreviewData] = useState<RtspProbeResult | null>(null);
  const [previewMode, setPreviewMode] = useState<'5' | 'native' | 'snapshot'>('5');
  const [streamNonce, setStreamNonce] = useState(1);
  const [streamError, setStreamError] = useState('');
  const [autoRefresh, setAutoRefresh] = useState(false);

  // Kalibrasi Manual Resolusi & Bounding Wajah per Kamera
  const [calCamId, setCalCamId] = useState<number | null>(null);
  const [calWidth, setCalWidth] = useState(1920);
  const [calHeight, setCalHeight] = useState(1080);
  const [calFps, setCalFps] = useState(5);
  const [calUseManualFace, setCalUseManualFace] = useState(true);
  const [calFacePx, setCalFacePx] = useState(100);
  const [calMaxFacePx, setCalMaxFacePx] = useState(0);
  const [calCapMode, setCalCapMode] = useState<'GLOBAL' | 'CUSTOM' | 'PRESET'>('GLOBAL');
  const [calCapWidth, setCalCapWidth] = useState(1280);
  const [calSaving, setCalSaving] = useState(false);
  const [reticlePos, setReticlePos] = useState<{ xPct: number; yPct: number }>({ xPct: 50, yPct: 58 });

  const openCalibrationForCamera = (cam: Camera) => {
    const parsed = parseResolutionDimensions(cam.resolusi);
    setCalCamId(cam.id);
    setCalWidth(parsed.width);
    setCalHeight(parsed.height);
    setCalFps(cam.fps || 5);
    const hasManualRange =
      (cam.min_face_size !== null && cam.min_face_size !== undefined) ||
      (cam.max_face_size !== null && cam.max_face_size !== undefined);
    if (hasManualRange) {
      const nextMin = normalizeMinFaceSize(cam.min_face_size ?? db.settings.min_face_size);
      setCalUseManualFace(true);
      setCalFacePx(nextMin);
      setCalMaxFacePx(normalizeMaxFaceSize(cam.max_face_size ?? db.settings.max_face_size ?? 0, nextMin));
    } else {
      const globalMin = normalizeMinFaceSize(db.settings.min_face_size);
      setCalUseManualFace(false);
      setCalFacePx(globalMin);
      setCalMaxFacePx(normalizeMaxFaceSize(db.settings.max_face_size ?? 0, globalMin));
    }
    if (cam.capture_max_width === null || cam.capture_max_width === undefined) {
      setCalCapMode('GLOBAL');
      setCalCapWidth(db.settings.capture_max_width ?? 1280);
    } else if (PRESET_CAPTURE_WIDTHS.includes(cam.capture_max_width)) {
      setCalCapMode('PRESET');
      setCalCapWidth(cam.capture_max_width);
    } else {
      setCalCapMode('CUSTOM');
      setCalCapWidth(cam.capture_max_width);
    }
  };

  const runProbe = async (target: { label: string; camera_id?: number; rtsp_url?: string }, updateDraftMeta = false) => {
    setProbing(true);
    setProbeError('');
    setStreamError('');
    setPreviewTarget(target);
    setStreamNonce((n) => n + 1);
    try {
      const res = await onProbeCamera({ camera_id: target.camera_id, rtsp_url: target.rtsp_url });
      setPreviewData(res);
      if (updateDraftMeta) {
        if (res.resolusi && res.resolusi !== '-') {
          const p = parseResolutionDimensions(res.resolusi);
          const norm = formatManualResolution(p.width, p.height);
          setResolusi(norm);
          setAddWidth(p.width);
          setAddHeight(p.height);
          setCustomAddRes(!PRESET_RESOLUTIONS.includes(norm));
        }
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
    if (previewMode !== 'snapshot' || !autoRefresh || !previewTarget) return;
    const timer = window.setInterval(() => {
      if (!probing) {
        runProbe(previewTarget, false).catch(() => {});
      }
    }, 2500);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewMode, autoRefresh, previewTarget]);

  const liveStreamUrl =
    previewTarget && previewData?.online && previewMode !== 'snapshot'
      ? (() => {
          const params = new URLSearchParams();
          if (previewTarget.camera_id) params.set('camera_id', String(previewTarget.camera_id));
          if (previewTarget.rtsp_url) params.set('rtsp_url', previewTarget.rtsp_url);
          params.set('fps_mode', previewMode === 'native' ? 'native' : '5');
          params.set('nonce', String(streamNonce));
          return `/api/cameras/preview-stream?${params.toString()}`;
        })()
      : null;

  const handleGateSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    await onAddGate({ nama_gerbang: namaGerbang, lokasi, tipe });
    setNamaGerbang('');
    setLokasi('');
  };

  const handleCamSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const finalResolusi = customAddRes ? formatManualResolution(addWidth, addHeight) : resolusi;
    await onAddCamera({
      nama_kamera: namaKamera.trim(),
      gate_id: Number(gateId),
      rtsp_url: rtspUrl.trim(),
      resolusi: finalResolusi,
      fps: Number(fps),
    });
    setNamaKamera('');
    setRtspUrl('');
  };

  const calCamera = calCamId !== null ? db.cameras.find((c) => c.id === calCamId) ?? null : null;
  const calEffectiveCapSetting =
    calCapMode === 'GLOBAL' ? null : normalizeCaptureMaxWidth(calCapWidth);
  const calResolusiStr = formatManualResolution(calWidth, calHeight);
  const calStats = computeCalibratedMinFacePx({
    cameraResolution: calResolusiStr,
    globalMinFaceSize: db.settings.min_face_size,
    cameraMinFaceSize: calUseManualFace ? calFacePx : null,
    globalMaxFaceSize: db.settings.max_face_size ?? 0,
    cameraMaxFaceSize: calUseManualFace ? calMaxFacePx : null,
    globalCaptureMaxWidth: db.settings.capture_max_width,
    cameraCaptureMaxWidth: calEffectiveCapSetting,
  });

  const handleSaveCalibration = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!calCamera) return;
    setCalSaving(true);
    try {
      const nextMinFace = calUseManualFace ? normalizeMinFaceSize(calFacePx) : null;
      await onUpdateCamera(calCamera.id, {
        resolusi: calResolusiStr,
        fps: Math.max(1, Math.min(30, Math.round(Number(calFps) || 5))),
        min_face_size: nextMinFace,
        max_face_size: calUseManualFace
          ? normalizeMaxFaceSize(calMaxFacePx, nextMinFace ?? db.settings.min_face_size)
          : null,
        capture_max_width: calEffectiveCapSetting,
      });
    } finally {
      setCalSaving(false);
    }
  };

  const boxWidthPct = Math.min(95, Math.max(1, (calStats.targetCameraPx / Math.max(1, calStats.cameraWidth)) * 100));
  const boxHeightPct = Math.min(95, Math.max(1, (calStats.targetCameraPx / Math.max(1, calStats.cameraHeight)) * 100));
  const maxBoxWidthPct =
    calStats.targetCameraMaxPx > 0
      ? Math.min(95, Math.max(boxWidthPct, (calStats.targetCameraMaxPx / Math.max(1, calStats.cameraWidth)) * 100))
      : 0;
  const maxBoxHeightPct =
    calStats.targetCameraMaxPx > 0
      ? Math.min(95, Math.max(boxHeightPct, (calStats.targetCameraMaxPx / Math.max(1, calStats.cameraHeight)) * 100))
      : 0;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <section className="bg-white border border-slate-200 rounded-lg p-5">
          <h2 className="text-sm font-semibold text-slate-900 mb-3">Tambah Gerbang Sekolah</h2>
          <form onSubmit={handleGateSubmit} className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
            <input placeholder="Nama Gerbang" required value={namaGerbang} onChange={(e) => setNamaGerbang(e.target.value)} className="border border-slate-300 rounded px-2.5 py-1.5 text-xs" />
            <input placeholder="Lokasi" value={lokasi} onChange={(e) => setLokasi(e.target.value)} className="border border-slate-300 rounded px-2.5 py-1.5 text-xs" />
            <select aria-label="Tipe Gerbang" value={tipe} onChange={(e) => setTipe(e.target.value as GateType)} className="border border-slate-300 rounded px-2.5 py-1.5 text-xs bg-white">
              <option value="BOTH">BOTH (Masuk &amp; Keluar)</option>
              <option value="MASUK">MASUK</option>
              <option value="KELUAR">KELUAR</option>
            </select>
            <button type="submit" className="sm:col-span-3 py-2 text-xs font-semibold text-white bg-blue-700 hover:bg-blue-800 rounded-md">
              Simpan Gerbang
            </button>
          </form>

          <div tabIndex={0} role="region" aria-label="Daftar Gerbang Sekolah" className="table-wrapper mt-4">
            <table className="w-full text-left text-xs">
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
          </div>
        </section>

        <section className="bg-white border border-slate-200 rounded-lg p-5">
          <h2 className="text-sm font-semibold text-slate-900 mb-3">Tambah &amp; Uji Kamera RTSP (Multi-Kamera &amp; Resolusi Manual)</h2>
          <form onSubmit={handleCamSubmit} className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
            <input placeholder="Nama Kamera Unik" required value={namaKamera} onChange={(e) => setNamaKamera(e.target.value)} className="border border-slate-300 rounded px-2.5 py-1.5 text-xs sm:col-span-2" />
            <select aria-label="Pilih Gerbang Kamera" value={gateId} onChange={(e) => setGateId(e.target.value)} className="border border-slate-300 rounded px-2.5 py-1.5 text-xs bg-white">
              {db.gates.map((g) => <option key={g.id} value={g.id}>{g.nama_gerbang} ({g.tipe})</option>)}
            </select>
            <input placeholder="rtsp://user:pass@ip:554/stream" required value={rtspUrl} onChange={(e) => setRtspUrl(e.target.value)} className="border border-slate-300 rounded px-2.5 py-1.5 text-xs font-mono sm:col-span-3" />
            <select
              aria-label="Resolusi Kamera"
              value={customAddRes ? 'CUSTOM' : resolusi}
              onChange={(e) => {
                if (e.target.value === 'CUSTOM') {
                  setCustomAddRes(true);
                } else {
                  setCustomAddRes(false);
                  setResolusi(e.target.value);
                  const p = parseResolutionDimensions(e.target.value);
                  setAddWidth(p.width);
                  setAddHeight(p.height);
                }
              }}
              className="border border-slate-300 rounded px-2.5 py-1.5 text-xs font-mono bg-white"
            >
              <option value="1280x720">1280x720 (720p)</option>
              <option value="1920x1080">1920x1080 (1080p)</option>
              <option value="2304x1296">2304x1296 (3MP)</option>
              <option value="2560x1440">2560x1440 (2K)</option>
              <option value="3840x2160">3840x2160 (4K)</option>
              <option value="CUSTOM">Custom Manual (WxH px)</option>
            </select>
            <input type="number" min="1" max="30" aria-label="FPS Kamera" value={fps} onChange={(e) => setFps(e.target.value)} placeholder="FPS (5)" className="border border-slate-300 rounded px-2.5 py-1.5 text-xs font-mono" />
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
            {customAddRes && (
              <div className="sm:col-span-3 grid grid-cols-2 gap-2 pt-1">
                <div>
                  <label htmlFor="add-res-w" className="block text-[11px] text-slate-500 mb-0.5">Lebar Kamera Manual (px)</label>
                  <input
                    id="add-res-w"
                    type="number"
                    min="160"
                    max="7680"
                    step="2"
                    value={addWidth}
                    onChange={(e) => setAddWidth(Number(e.target.value))}
                    className="w-full border border-slate-300 rounded px-2.5 py-1 text-xs font-mono"
                  />
                </div>
                <div>
                  <label htmlFor="add-res-h" className="block text-[11px] text-slate-500 mb-0.5">Tinggi Kamera Manual (px)</label>
                  <input
                    id="add-res-h"
                    type="number"
                    min="120"
                    max="4320"
                    step="2"
                    value={addHeight}
                    onChange={(e) => setAddHeight(Number(e.target.value))}
                    className="w-full border border-slate-300 rounded px-2.5 py-1 text-xs font-mono"
                  />
                </div>
              </div>
            )}
          </form>
        </section>
      </div>

      {/* Panel Kalibrasi Manual Resolusi Kamera & Bounding Wajah */}
      {calCamera && (
        <section
          aria-label={`Kalibrasi Manual Kamera ${calCamera.nama_kamera}`}
          className="bg-white border-2 border-blue-200 rounded-lg p-5 space-y-4"
        >
          <div className="flex items-start justify-between gap-3 pb-3 border-b border-slate-200">
            <div className="flex-1 min-w-0">
              <h2 className="text-sm font-bold text-slate-900 flex items-center gap-2">
                <SlidersHorizontal className="w-4 h-4 text-blue-700 shrink-0" />
                <span className="truncate">Kalibrasi Manual Resolusi &amp; Bounding Wajah — {calCamera.nama_kamera}</span>
              </h2>
              <p className="text-xs text-slate-500 mt-0.5">
                Atur resolusi asli kamera secara manual dan tentukan ukuran kotak bounding wajah (misal 100 px atau bebas). Sistem otomatis mengkalibrasi skala detektor AI.
              </p>
            </div>
            <button
              type="button"
              onClick={() => setCalCamId(null)}
              aria-label="Tutup Panel Kalibrasi"
              className="shrink-0 p-1.5 text-slate-500 hover:text-slate-900 border border-slate-200 rounded-md"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
            {/* Pratinjau Visual Kalibrasi Proporsional */}
            <div className="lg:col-span-7 space-y-2">
              <div className="flex items-center justify-between text-xs text-slate-600">
                  <span className="font-medium flex items-center gap-1.5">
                    <Crosshair className="w-3.5 h-3.5 text-emerald-600" />
                    Simulasi Rentang Bounding ({calStats.targetCameraPx}
                    {calStats.targetCameraMaxPx > 0 ? `–${calStats.targetCameraMaxPx}` : '+'} px di frame {calStats.cameraWidth}×{calStats.cameraHeight})
                  </span>
                  <span className="font-mono text-[11px] text-slate-500">
                    Klik area gambar untuk menggeser kotak uji
                  </span>
                </div>

                <div className="bg-slate-950 rounded-lg p-3 flex items-center justify-center border border-slate-800">
                  <div
                    role="button"
                    tabIndex={0}
                    aria-label="Area simulasi bounding wajah pada resolusi kamera"
                    onClick={(e) => {
                      const rect = e.currentTarget.getBoundingClientRect();
                      const xPct = Math.max(8, Math.min(92, ((e.clientX - rect.left) / rect.width) * 100));
                      const yPct = Math.max(10, Math.min(90, ((e.clientY - rect.top) / rect.height) * 100));
                      setReticlePos({ xPct, yPct });
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'ArrowLeft') setReticlePos((p) => ({ ...p, xPct: Math.max(10, p.xPct - 5) }));
                      if (e.key === 'ArrowRight') setReticlePos((p) => ({ ...p, xPct: Math.min(90, p.xPct + 5) }));
                      if (e.key === 'ArrowUp') setReticlePos((p) => ({ ...p, yPct: Math.max(10, p.yPct - 5) }));
                      if (e.key === 'ArrowDown') setReticlePos((p) => ({ ...p, yPct: Math.min(90, p.yPct + 5) }));
                    }}
                    style={{ aspectRatio: `${calStats.cameraWidth} / ${calStats.cameraHeight}` }}
                    className="relative w-full max-h-[340px] bg-slate-900 rounded overflow-hidden border border-slate-700 cursor-crosshair select-none"
                  >
                    {previewData?.camera_id === calCamera.id && previewData.snapshotDataUrl ? (
                      <img
                        src={previewData.snapshotDataUrl}
                        alt={`Snapshot kalibrasi ${calCamera.nama_kamera}`}
                        className="w-full h-full object-fill opacity-95"
                      />
                    ) : (
                      <div className="w-full h-full flex flex-col items-start justify-start p-3 text-slate-400 font-mono text-xs text-left bg-[radial-gradient(#334155_1px,transparent_1px)] [background-size:20px_20px]">
                        <div className="bg-slate-950/75 border border-slate-800 rounded px-2.5 py-1.5 max-w-full">
                          <div className="text-slate-200 font-semibold text-[11px] sm:text-xs">
                            Frame Kamera Kalibrasi {calStats.cameraWidth} × {calStats.cameraHeight} px
                          </div>
                          <div className="text-[10px] sm:text-[11px] text-slate-400 mt-0.5">
                            Klik &quot;Uji &amp; Preview&quot; untuk melihat video asli di belakang kotak uji.
                          </div>
                        </div>
                      </div>
                    )}

                    {/* Kotak Maksimal Bounding (Amber Dashed) jika diatur > 0 */}
                    {calStats.targetCameraMaxPx > 0 && (
                      <div
                        data-testid="cal-max-face-box"
                        style={{
                          width: `${maxBoxWidthPct}%`,
                          height: `${maxBoxHeightPct}%`,
                          left: `${reticlePos.xPct}%`,
                          top: `${reticlePos.yPct}%`,
                          transform: 'translate(-50%, -50%)',
                        }}
                        className="absolute border-2 border-dashed border-amber-400 bg-amber-400/10 pointer-events-none flex items-start justify-center"
                      >
                        <span className="-translate-y-full mb-1 px-1.5 py-0.5 rounded bg-slate-950/90 text-amber-300 font-mono text-[10px] whitespace-nowrap border border-amber-500/40 tabular-nums">
                          MAX {calStats.targetCameraMaxPx}×{calStats.targetCameraMaxPx} px ({calStats.maxWidthPercent}%)
                        </span>
                      </div>
                    )}

                    {/* Kotak Minimal Bounding Wajah Proporsional (Hijau) */}
                    <div
                      data-testid="cal-min-face-box"
                      style={{
                        width: `${boxWidthPct}%`,
                        height: `${boxHeightPct}%`,
                        left: `${reticlePos.xPct}%`,
                        top: `${reticlePos.yPct}%`,
                        transform: 'translate(-50%, -50%)',
                      }}
                      className="absolute border-2 border-emerald-400 bg-emerald-400/15 shadow-[0_0_0_1px_rgba(0,0,0,0.6)] pointer-events-none flex items-end justify-center"
                    >
                      <span className="translate-y-full mt-1 px-1.5 py-0.5 rounded bg-slate-950/90 text-emerald-300 font-mono text-[10px] whitespace-nowrap border border-emerald-500/40 tabular-nums">
                        MIN {calStats.targetCameraPx}×{calStats.targetCameraPx} px ({calStats.widthPercent}%)
                      </span>
                    </div>
                  </div>
                </div>
            </div>

            {/* Kontrol Form Kalibrasi */}
            <form onSubmit={handleSaveCalibration} className="lg:col-span-5 space-y-4">
              <div className="bg-slate-50 border border-slate-200 rounded-md p-3 space-y-2.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-semibold text-slate-800">1. Kalibrasi Resolusi Kamera Manual</span>
                  {previewData?.camera_id === calCamera.id && previewData.width > 0 && (
                    <button
                      type="button"
                      onClick={() => {
                        setCalWidth(previewData.width);
                        setCalHeight(previewData.height);
                      }}
                      className="text-[11px] font-medium text-blue-700 hover:underline"
                    >
                      Pakai Hasil Uji ({previewData.width}×{previewData.height})
                    </button>
                  )}
                </div>

                <div className="flex flex-wrap gap-1.5">
                  {PRESET_RESOLUTIONS.map((preset) => {
                    const active = calResolusiStr === preset;
                    return (
                      <button
                        key={preset}
                        type="button"
                        onClick={() => {
                          const p = parseResolutionDimensions(preset);
                          setCalWidth(p.width);
                          setCalHeight(p.height);
                        }}
                        className={`px-2 py-1 text-[11px] font-mono rounded border ${
                          active
                            ? 'bg-blue-700 text-white border-blue-700'
                            : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-100'
                        }`}
                      >
                        {preset}
                      </button>
                    );
                  })}
                </div>

                <div className="grid grid-cols-3 gap-2">
                  <div>
                    <label htmlFor="cal-cam-w" className="block text-[11px] text-slate-600 mb-0.5">Lebar (px)</label>
                    <input
                      id="cal-cam-w"
                      type="number"
                      min="160"
                      max="7680"
                      step="2"
                      value={calWidth}
                      onChange={(e) => setCalWidth(Number(e.target.value))}
                      className="w-full border border-slate-300 rounded px-2 py-1 text-xs font-mono bg-white"
                    />
                  </div>
                  <div>
                    <label htmlFor="cal-cam-h" className="block text-[11px] text-slate-600 mb-0.5">Tinggi (px)</label>
                    <input
                      id="cal-cam-h"
                      type="number"
                      min="120"
                      max="4320"
                      step="2"
                      value={calHeight}
                      onChange={(e) => setCalHeight(Number(e.target.value))}
                      className="w-full border border-slate-300 rounded px-2 py-1 text-xs font-mono bg-white"
                    />
                  </div>
                  <div>
                    <label htmlFor="cal-cam-fps" className="block text-[11px] text-slate-600 mb-0.5">FPS</label>
                    <input
                      id="cal-cam-fps"
                      type="number"
                      min="1"
                      max="30"
                      value={calFps}
                      onChange={(e) => setCalFps(Number(e.target.value))}
                      className="w-full border border-slate-300 rounded px-2 py-1 text-xs font-mono bg-white"
                    />
                  </div>
                </div>
              </div>

              <div className="bg-slate-50 border border-slate-200 rounded-md p-3 space-y-2.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-semibold text-slate-800">2. Rentang Bounding Wajah (px)</span>
                  <select
                    aria-label="Mode Bounding Wajah Kamera"
                    value={calUseManualFace ? 'MANUAL' : 'GLOBAL'}
                    onChange={(e) => setCalUseManualFace(e.target.value === 'MANUAL')}
                    className="border border-slate-300 rounded px-2 py-1 text-[11px] bg-white font-medium"
                  >
                    <option value="MANUAL">Set Manual Per Kamera</option>
                    <option value="GLOBAL">
                      Ikuti Global ({db.settings.min_face_size}
                      {(db.settings.max_face_size ?? 0) > 0 ? `–${db.settings.max_face_size}` : '+'} px)
                    </option>
                  </select>
                </div>

                {calUseManualFace && (
                  <div className="space-y-2.5">
                    <div className="flex items-center gap-2">
                      <label htmlFor="cal-face-px" className="text-xs text-slate-600 whitespace-nowrap">
                        Minimal Wajah:
                      </label>
                      <input
                        id="cal-face-px"
                        type="number"
                        min="16"
                        max="4096"
                        value={calFacePx}
                        onChange={(e) => setCalFacePx(Number(e.target.value))}
                        className="w-24 border border-slate-300 rounded px-2.5 py-1 text-xs font-mono bg-white font-semibold"
                      />
                      <span className="text-xs font-mono text-slate-500">px (16–4096)</span>
                    </div>
                    <input
                      aria-label="Slider Bounding Wajah px"
                      type="range"
                      min="16"
                      max={Math.max(400, Math.min(1200, calStats.cameraHeight))}
                      value={Math.min(1200, Math.max(16, calFacePx || 16))}
                      onChange={(e) => setCalFacePx(Number(e.target.value))}
                      className="w-full accent-blue-700"
                    />
                    <div className="flex flex-wrap gap-1.5">
                      {[60, 100, 140, 200, 300, 450].map((px) => (
                        <button
                          key={px}
                          type="button"
                          onClick={() => setCalFacePx(px)}
                          className={`px-2 py-0.5 text-[11px] font-mono rounded border ${
                            calFacePx === px
                              ? 'bg-emerald-700 text-white border-emerald-700'
                              : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-100'
                          }`}
                        >
                          {px} px
                        </button>
                      ))}
                    </div>

                    <div className="pt-2 border-t border-slate-200 space-y-1.5">
                      <div className="flex items-center gap-2">
                        <label htmlFor="cal-max-face-px" className="text-xs text-slate-600 whitespace-nowrap">
                          Maksimal Wajah:
                        </label>
                        <input
                          id="cal-max-face-px"
                          type="number"
                          min="0"
                          max="4096"
                          value={calMaxFacePx}
                          onChange={(e) => setCalMaxFacePx(Number(e.target.value))}
                          className="w-24 border border-slate-300 rounded px-2.5 py-1 text-xs font-mono bg-white font-semibold"
                        />
                        <span className="text-xs font-mono text-slate-500">px (0 = Bebas)</span>
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {[0, 250, 400, 600, 900].map((px) => (
                          <button
                            key={`max-${px}`}
                            type="button"
                            onClick={() => setCalMaxFacePx(px)}
                            className={`px-2 py-0.5 text-[11px] font-mono rounded border ${
                              calMaxFacePx === px
                                ? 'bg-amber-600 text-white border-amber-600'
                                : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-100'
                            }`}
                          >
                            {px === 0 ? 'Bebas' : `${px} px`}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                )}
              </div>

              <div className="bg-slate-50 border border-slate-200 rounded-md p-3 space-y-2">
                <label htmlFor="cal-cap-mode" className="block text-xs font-semibold text-slate-800">
                  3. Skala Capture ke Detektor AI
                </label>
                <select
                  id="cal-cap-mode"
                  value={calCapMode === 'GLOBAL' ? 'GLOBAL' : calCapMode === 'CUSTOM' ? 'CUSTOM' : String(calCapWidth)}
                  onChange={(e) => {
                    if (e.target.value === 'GLOBAL') {
                      setCalCapMode('GLOBAL');
                    } else if (e.target.value === 'CUSTOM') {
                      setCalCapMode('CUSTOM');
                      setCalCapWidth(calCapWidth > 0 ? calCapWidth : calWidth);
                    } else {
                      setCalCapMode('PRESET');
                      setCalCapWidth(Number(e.target.value));
                    }
                  }}
                  className="w-full border border-slate-300 rounded px-2.5 py-1.5 text-xs font-mono bg-white"
                >
                  <option value="GLOBAL">
                    Ikuti Global ({describeCaptureResolutionMode(db.settings.capture_max_width ?? 1280)})
                  </option>
                  <option value="0">Native Kamera (Asli {calStats.cameraWidth}×{calStats.cameraHeight} — Tanpa Resize)</option>
                  <option value="640">640 px (360p)</option>
                  <option value="960">960 px (540p)</option>
                  <option value="1280">1280 px (HD 720p)</option>
                  <option value="1920">1920 px (Full HD 1080p)</option>
                  <option value="2560">2560 px (2K QHD)</option>
                  <option value="3840">3840 px (4K UHD)</option>
                  <option value="CUSTOM">Custom Manual (Isi Pixel Bebas)</option>
                </select>
                {calCapMode === 'CUSTOM' && (
                  <div className="flex items-center gap-2">
                    <label htmlFor="cal-cap-custom" className="text-xs text-slate-600">Lebar Capture (px):</label>
                    <input
                      id="cal-cap-custom"
                      type="number"
                      min="320"
                      max="7680"
                      step="2"
                      value={calCapWidth}
                      onChange={(e) => setCalCapWidth(Number(e.target.value))}
                      className="w-28 border border-slate-300 rounded px-2 py-1 text-xs font-mono bg-white"
                    />
                  </div>
                )}
              </div>

              {/* Ringkasan Matematika Kalibrasi */}
              <div className="bg-blue-50 border border-blue-200 rounded-md p-3 text-xs space-y-1 font-mono tabular-nums text-blue-950">
                <div>
                  Resolusi Kamera: <strong>{calStats.cameraWidth}×{calStats.cameraHeight} px</strong>
                </div>
                <div>
                  Rentang Bounding di Kamera:{' '}
                  <strong>
                    {calStats.targetCameraPx}
                    {calStats.targetCameraMaxPx > 0 ? `–${calStats.targetCameraMaxPx}` : '+'} px
                  </strong>{' '}
                  ({calStats.widthPercent}%{calStats.maxWidthPercent > 0 ? `–${calStats.maxWidthPercent}%` : '+'} lebar)
                </div>
                <div>
                  Frame Capture AI: <strong>{calStats.effectiveFrameWidth}×{calStats.effectiveFrameHeight} px</strong>
                </div>
                <div className="text-emerald-800 pt-0.5">
                  Batas Efektif Detektor AI:{' '}
                  <strong>
                    {calStats.effectiveMinFacePx}
                    {calStats.effectiveMaxFacePx > 0 ? `–${calStats.effectiveMaxFacePx}` : '+'} px
                  </strong>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="submit"
                  disabled={calSaving}
                  className="flex-1 py-2 text-xs font-semibold text-white bg-blue-700 hover:bg-blue-800 disabled:opacity-50 rounded-md"
                >
                  {calSaving ? 'Menyimpan...' : 'Simpan Kalibrasi Kamera'}
                </button>
                <button
                  type="button"
                  onClick={() => setCalCamId(null)}
                  className="px-4 py-2 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-md"
                >
                  Batal
                </button>
              </div>
            </form>
          </div>
        </section>
      )}

      {/* Live Preview Panel */}
      {(previewTarget || probeError) && (
        <section
          aria-label={`Live Preview RTSP ${previewTarget?.label ?? ''}`}
          className="bg-white border border-slate-200 rounded-lg p-5 space-y-4"
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-sm font-semibold text-slate-900">
                  Live Preview Stream RTSP — {previewTarget?.label}
                </h2>
                {liveStreamUrl && !streamError && (
                  <span className="inline-flex items-center gap-1.5 px-2 py-0.5 text-[11px] font-mono font-semibold text-emerald-800 bg-emerald-50 border border-emerald-200 rounded">
                    <span className="w-2 h-2 rounded-full bg-emerald-600 animate-pulse" />
                    {previewMode === 'native' ? 'LIVE (FPS BAWAAN RTSP)' : 'LIVE (5 FPS)'}
                  </span>
                )}
              </div>
              {previewData && (
                <div className="text-xs font-mono text-slate-600 mt-0.5 tabular-nums">
                  Status: <strong className="text-emerald-700">ONLINE</strong> · Codec: <strong>{previewData.codec}</strong> · Resolusi: <strong>{previewData.resolusi}</strong> · FPS Asli Kamera: <strong>{previewData.fps}</strong> · Latensi Awal: <strong>{previewData.latency_ms} ms</strong>
                </div>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <div
                role="group"
                aria-label="Mode Kecepatan Preview RTSP"
                className="inline-flex rounded-md border border-slate-300 bg-slate-50 p-0.5 text-xs"
              >
                <button
                  type="button"
                  onClick={() => {
                    setPreviewMode('5');
                    setAutoRefresh(false);
                    setStreamError('');
                    setStreamNonce((n) => n + 1);
                  }}
                  className={`px-2.5 py-1 rounded font-medium transition-colors ${
                    previewMode === '5'
                      ? 'bg-blue-700 text-white'
                      : 'text-slate-700 hover:bg-slate-200/70'
                  }`}
                >
                  Live 5 FPS
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setPreviewMode('native');
                    setAutoRefresh(false);
                    setStreamError('');
                    setStreamNonce((n) => n + 1);
                  }}
                  className={`px-2.5 py-1 rounded font-medium transition-colors ${
                    previewMode === 'native'
                      ? 'bg-blue-700 text-white'
                      : 'text-slate-700 hover:bg-slate-200/70'
                  }`}
                >
                  Live Bawaan RTSP{previewData?.fps ? ` (${previewData.fps} FPS)` : ''}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setPreviewMode('snapshot');
                    setStreamError('');
                  }}
                  className={`px-2.5 py-1 rounded font-medium transition-colors ${
                    previewMode === 'snapshot'
                      ? 'bg-slate-800 text-white'
                      : 'text-slate-700 hover:bg-slate-200/70'
                  }`}
                >
                  Snapshot
                </button>
              </div>

              {previewMode === 'snapshot' && (
                <label className="inline-flex items-center gap-1.5 text-xs text-slate-700 cursor-pointer px-1">
                  <input
                    type="checkbox"
                    checked={autoRefresh}
                    onChange={(e) => setAutoRefresh(e.target.checked)}
                  />
                  Auto-Refresh (2.5 dtk)
                </label>
              )}

              <button
                type="button"
                disabled={probing || !previewTarget}
                onClick={() => previewTarget && runProbe(previewTarget, false)}
                className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-white bg-blue-700 hover:bg-blue-800 disabled:opacity-50 rounded-md"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${probing ? 'animate-spin' : ''}`} />
                {previewMode === 'snapshot' ? 'Refresh Frame' : 'Sambungkan Ulang'}
              </button>
              <button
                type="button"
                aria-label="Tutup Preview RTSP"
                onClick={() => {
                  setAutoRefresh(false);
                  setPreviewTarget(null);
                  setPreviewData(null);
                  setProbeError('');
                  setStreamError('');
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

          {streamError && (
            <div className="p-2.5 bg-amber-50 border border-amber-200 rounded-md text-xs text-amber-800 flex flex-wrap items-center justify-between gap-2">
              <span>{streamError}</span>
              <button
                type="button"
                onClick={() => {
                  setStreamError('');
                  setStreamNonce((n) => n + 1);
                }}
                className="px-2.5 py-1 text-xs font-semibold bg-amber-700 text-white rounded hover:bg-amber-800"
              >
                Coba Live Stream Lagi
              </button>
            </div>
          )}

          {(liveStreamUrl || previewData?.snapshotDataUrl) && (
            <div className="space-y-2">
              <img
                key={`${liveStreamUrl ?? 'snap'}-${streamNonce}`}
                src={liveStreamUrl && !streamError ? liveStreamUrl : previewData?.snapshotDataUrl}
                alt={`Live frame ${previewTarget?.label}`}
                onError={() => {
                  if (liveStreamUrl && !streamError) {
                    setStreamError(
                      'Aliran video live MJPEG terputus/timeout — menampilkan snapshot terakhir. Klik "Coba Live Stream Lagi" atau pilih mode Live 5 FPS.'
                    );
                  }
                }}
                className="w-full max-h-[460px] object-contain bg-slate-950 rounded-md border border-slate-200"
              />
              <p className="text-[11px] text-slate-500">
                {previewMode === 'snapshot'
                  ? 'Mode Snapshot aktif (hemat bandwidth). Pilih "Live 5 FPS" atau "Live Bawaan RTSP" di atas untuk video bergerak real-time.'
                  : previewMode === 'native'
                    ? 'Mode Live FPS Bawaan RTSP aktif: stream dipancarkan mengikuti FPS asli kamera (direkomendasikan 1 admin menonton bersamaan untuk hemat CPU/bandwidth).'
                    : 'Mode Live 5 FPS aktif via FFmpeg MJPEG stream (stabil untuk uji arah hadap kamera & verifikasi gerbang).'}
              </p>
            </div>
          )}
        </section>
      )}

      <section className="bg-white border border-slate-200 rounded-lg p-5 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-slate-900">Daftar Kamera Aktif &amp; Kalibrasi Per Kamera</h2>
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
                <th className="py-2 font-medium">Resolusi &amp; Kalibrasi Bounding</th>
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
                const camCal = computeCalibratedMinFacePx({
                  cameraResolution: c.resolusi,
                  globalMinFaceSize: db.settings.min_face_size,
                  cameraMinFaceSize: c.min_face_size,
                  globalMaxFaceSize: db.settings.max_face_size ?? 0,
                  cameraMaxFaceSize: c.max_face_size,
                  globalCaptureMaxWidth: db.settings.capture_max_width,
                  cameraCaptureMaxWidth: c.capture_max_width,
                });
                const isManualFace =
                  (c.min_face_size !== null && c.min_face_size !== undefined) ||
                  (c.max_face_size !== null && c.max_face_size !== undefined);

                return (
                  <tr key={c.id}>
                    <td className="py-2.5 font-medium text-slate-900">{c.nama_kamera}</td>
                    <td className="py-2.5 text-slate-600">{gate?.nama_gerbang ?? '-'} · {gate?.tipe}</td>
                    <td className="py-2.5 max-w-xs">
                      <div className="font-mono text-[11px] text-slate-600 truncate">{maskRtspCredentials(c.rtsp_url)}</div>
                      <div className="text-[11px] text-slate-700 font-mono tabular-nums">
                        {c.resolusi} · {c.fps} FPS · Capture {camCal.effectiveFrameWidth} px
                      </div>
                      <div className="text-[11px] font-mono tabular-nums text-emerald-700">
                        Bounding: {isManualFace ? 'Manual' : 'Global'} {camCal.targetCameraPx}
                        {camCal.targetCameraMaxPx > 0 ? `–${camCal.targetCameraMaxPx}` : '+'} px → Efektif{' '}
                        {camCal.effectiveMinFacePx}
                        {camCal.effectiveMaxFacePx > 0 ? `–${camCal.effectiveMaxFacePx}` : '+'} px
                      </div>
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
                        onClick={() => openCalibrationForCamera(c)}
                        aria-label={`Kalibrasi kamera ${c.nama_kamera}`}
                        className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-emerald-800 border border-emerald-200 bg-emerald-50 hover:bg-emerald-100 rounded"
                      >
                        <SlidersHorizontal className="w-3 h-3" /> Kalibrasi
                      </button>
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
