import React, { useState } from 'react';
import { Trash2, ZoomIn } from 'lucide-react';
import type { AnonymousCluster, AppDatabase, WorkerStatusResponse } from '../types';
import { FaceLightboxModal, type FaceGalleryItem } from './FaceLightboxModal';

interface AutocompleteItem {
  id: number;
  nama: string;
  nisn: string;
  kelas: string;
}

interface ClustersViewProps {
  db: AppDatabase;
  workerStatus?: WorkerStatusResponse | null;
  onAssignCluster: (clusterId: number, studentId: number) => Promise<void>;
  onCreateStudentFromCluster: (
    clusterId: number,
    payload: { nis: string; nisn: string; nama: string; kelas_id: number; tanggal_lahir: string; wa_ortu: string }
  ) => Promise<void>;
  onMarkVisitor: (clusterId: number, payload: { nama: string; kategori: 'TAMU' | 'STAF'; catatan: string }) => Promise<void>;
  onDeleteCluster?: (clusterId: number) => Promise<void>;
}

export const ClustersView: React.FC<ClustersViewProps> = ({
  db,
  workerStatus,
  onAssignCluster,
  onCreateStudentFromCluster,
  onMarkVisitor,
  onDeleteCluster,
}) => {
  const readyClusters = db.anonymous_clusters.filter((c) => c.status === 'READY');
  const pendingClusters = db.anonymous_clusters
    .filter((c) => c.status === 'PENDING')
    .sort((a, b) => b.last_seen.localeCompare(a.last_seen));

  const [queryMap, setQueryMap] = useState<Record<number, string>>({});
  const [suggestionsMap, setSuggestionsMap] = useState<Record<number, AutocompleteItem[]>>({});
  const [selectedStudentMap, setSelectedStudentMap] = useState<Record<number, number>>({});
  const [modeMap, setModeMap] = useState<Record<number, 'assign' | 'new' | 'visitor'>>({});
  const [expandedPendingMap, setExpandedPendingMap] = useState<Record<number, boolean>>({});

  // New student / visitor drafts per cluster
  const [newDraft, setNewDraft] = useState<Record<number, { nis: string; nisn: string; nama: string; kelas_id: string; tanggal_lahir: string; wa_ortu: string }>>({});
  const [visDraft, setVisDraft] = useState<Record<number, { nama: string; kategori: 'TAMU' | 'STAF'; catatan: string }>>({});
  const [lightboxState, setLightboxState] = useState<{
    title: string;
    subtitle: string;
    referenceItem: FaceGalleryItem;
    items: FaceGalleryItem[];
    initialIndex: number;
  } | null>(null);

  const targetHits = Math.max(1, db.settings.cluster_ready_hits ?? 5);
  const targetDays = Math.max(1, db.settings.cluster_ready_days ?? 1);

  const getClusterHits = (c: AnonymousCluster): FaceGalleryItem[] => {
    const rawHits =
      Array.isArray(c.hit_snapshots) && c.hit_snapshots.length > 0
        ? c.hit_snapshots
        : [
            {
              snapshot_path: c.best_snapshot_path,
              quality_score: c.best_quality_score,
              similarity: 1,
              camera_id: c.last_camera_id,
              detected_at: c.last_seen,
            },
          ];
    return rawHits.map((h, idx) => {
      const camName = db.cameras.find((cm) => cm.id === h.camera_id)?.nama_kamera ?? 'Kamera Gerbang';
      return {
        src: h.snapshot_path,
        label: h.snapshot_path === c.best_snapshot_path ? `Hit #${idx + 1} (Terbaik)` : `Hit #${idx + 1}`,
        timestamp: h.detected_at,
        cameraName: camName,
        similarity: h.similarity,
        qualityScore: h.quality_score,
      };
    });
  };

  const openClusterLightbox = (c: AnonymousCluster, index = 0) => {
    const items = getClusterHits(c);
    setLightboxState({
      title: `Cluster Anonim #${c.id} (${c.status}) — Dobel Crosscheck Semua Hit`,
      subtitle: `${c.hit_count}x terdeteksi · ${c.distinct_days} hari berbeda · Threshold clustering ${db.settings.threshold_clustering}`,
      referenceItem: {
        src: c.best_snapshot_path,
        label: 'Foto Terbaik Cluster (Acuan)',
        meta: `Skor ${(c.best_quality_score * 100).toFixed(1)}% · ${c.last_seen}`,
      },
      items,
      initialIndex: index,
    });
  };

  const renderHitsGallery = (c: AnonymousCluster) => {
    const hits = getClusterHits(c);
    return (
      <div className="pt-2 border-t border-slate-100 space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-xs font-semibold text-slate-700">
            Gambar Hit yang Dinyatakan Sama ({hits.length} foto tersimpan dari {c.hit_count} hit)
          </span>
          <button
            type="button"
            onClick={() => openClusterLightbox(c, 0)}
            className="inline-flex items-center gap-1 text-xs font-semibold text-blue-700 hover:underline"
          >
            <ZoomIn className="w-3.5 h-3.5" />
            Perbesar &amp; Crosscheck Semua
          </button>
        </div>
        <div className="flex items-center gap-2 overflow-x-auto pb-1">
          {hits.map((h, idx) => (
            <button
              key={`${c.id}-${h.src}-${idx}`}
              type="button"
              onClick={() => openClusterLightbox(c, idx)}
              aria-label={`Perbesar ${h.label} untuk Cluster #${c.id}`}
              className="group shrink-0 rounded-md border border-slate-200 hover:border-blue-500 p-1 bg-slate-50 text-left transition-colors"
            >
              <div className="relative">
                <img
                  src={h.src}
                  alt={`${h.label} Cluster ${c.id}`}
                  referrerPolicy="no-referrer"
                  className="w-16 h-16 rounded object-cover bg-slate-200"
                />
                <span className="absolute bottom-1 right-1 bg-slate-900/75 text-white rounded p-0.5 opacity-80 group-hover:opacity-100">
                  <ZoomIn className="w-3 h-3" />
                </span>
              </div>
              <div className="mt-1 text-[10px] font-mono text-slate-700 truncate max-w-[64px]">
                {typeof h.similarity === 'number' ? `Sim ${Math.round(h.similarity * 100)}%` : h.label}
              </div>
              <div className="text-[9px] font-mono text-slate-400 truncate max-w-[64px]">
                {h.timestamp ? h.timestamp.slice(11, 16) : '-'}
              </div>
            </button>
          ))}
        </div>
      </div>
    );
  };

  const handleAutocomplete = async (clusterId: number, text: string) => {
    setQueryMap((prev) => ({ ...prev, [clusterId]: text }));
    setSelectedStudentMap((prev) => {
      const copy = { ...prev };
      delete copy[clusterId];
      return copy;
    });
    if (text.trim().length < 3) {
      setSuggestionsMap((prev) => ({ ...prev, [clusterId]: [] }));
      return;
    }
    const res = await fetch(`/api/students/autocomplete?q=${encodeURIComponent(text.trim())}`);
    const items: AutocompleteItem[] = await res.json();
    setSuggestionsMap((prev) => ({ ...prev, [clusterId]: items }));
  };

  const renderActionControls = (c: AnonymousCluster) => {
    const mode = modeMap[c.id] ?? 'assign';
    const suggestions = suggestionsMap[c.id] ?? [];
    const selectedId = selectedStudentMap[c.id];
    const nd = newDraft[c.id] ?? {
      nis: '',
      nisn: '',
      nama: '',
      kelas_id: String(db.kelas[0]?.id ?? 1),
      tanggal_lahir: '2008-06-01',
      wa_ortu: '',
    };
    const vd = visDraft[c.id] ?? { nama: '', kategori: 'TAMU', catatan: '' };

    return (
      <div className="space-y-3 pt-2 border-t border-slate-100">
        <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-md">
          <button
            type="button"
            onClick={() => setModeMap((p) => ({ ...p, [c.id]: 'assign' }))}
            className={`flex-1 py-1.5 text-xs font-medium rounded transition-colors ${
              mode === 'assign' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            Tautkan Siswa
          </button>
          <button
            type="button"
            onClick={() => setModeMap((p) => ({ ...p, [c.id]: 'new' }))}
            className={`flex-1 py-1.5 text-xs font-medium rounded transition-colors ${
              mode === 'new' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            Buat Siswa Baru
          </button>
          <button
            type="button"
            onClick={() => setModeMap((p) => ({ ...p, [c.id]: 'visitor' }))}
            className={`flex-1 py-1.5 text-xs font-medium rounded transition-colors ${
              mode === 'visitor' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            Tandai Tamu/Staf
          </button>
        </div>

        {mode === 'assign' && (
          <div className="space-y-2.5 relative">
            <label htmlFor={`ac-${c.id}`} className="block text-xs font-medium text-slate-700">
              Cari Nama atau NISN Siswa (ketik min 3 huruf)
            </label>
            <input
              id={`ac-${c.id}`}
              type="text"
              placeholder="Contoh: Aul atau 0081..."
              value={queryMap[c.id] ?? ''}
              onChange={(e) => handleAutocomplete(c.id, e.target.value)}
              autoComplete="off"
              className="w-full border border-slate-300 rounded-md px-3 py-2 text-xs"
            />
            {suggestions.length > 0 && (
              <ul className="border border-slate-200 rounded-md divide-y divide-slate-100 bg-white max-h-40 overflow-y-auto">
                {suggestions.map((item) => (
                  <li key={item.id}>
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedStudentMap((p) => ({ ...p, [c.id]: item.id }));
                        setQueryMap((p) => ({ ...p, [c.id]: `${item.nama} (${item.nisn}) - ${item.kelas}` }));
                        setSuggestionsMap((p) => ({ ...p, [c.id]: [] }));
                      }}
                      className="w-full text-left px-3 py-2 text-xs hover:bg-blue-50 flex items-center justify-between"
                    >
                      <span className="font-medium text-slate-900">{item.nama}</span>
                      <span className="font-mono text-slate-500">{item.nisn} · {item.kelas}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <button
              type="button"
              disabled={!selectedId}
              onClick={() => selectedId && onAssignCluster(c.id, selectedId)}
              className="w-full py-2 text-xs font-semibold text-white bg-emerald-700 hover:bg-emerald-800 disabled:bg-slate-200 disabled:text-slate-500 disabled:cursor-not-allowed rounded-md transition-colors"
            >
              Simpan &amp; Tautkan ke Siswa Terpilih
            </button>
          </div>
        )}

        {mode === 'new' && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              onCreateStudentFromCluster(c.id, {
                nis: nd.nis,
                nisn: nd.nisn,
                nama: nd.nama,
                kelas_id: Number(nd.kelas_id),
                tanggal_lahir: nd.tanggal_lahir,
                wa_ortu: nd.wa_ortu,
              });
            }}
            className="grid grid-cols-2 gap-2"
          >
            <input placeholder="NIS" required value={nd.nis} onChange={(e) => setNewDraft((p) => ({ ...p, [c.id]: { ...nd, nis: e.target.value } }))} className="border border-slate-300 rounded px-2.5 py-1.5 text-xs font-mono" />
            <input placeholder="NISN" required value={nd.nisn} onChange={(e) => setNewDraft((p) => ({ ...p, [c.id]: { ...nd, nisn: e.target.value } }))} className="border border-slate-300 rounded px-2.5 py-1.5 text-xs font-mono" />
            <input placeholder="Nama Lengkap" required value={nd.nama} onChange={(e) => setNewDraft((p) => ({ ...p, [c.id]: { ...nd, nama: e.target.value } }))} className="border border-slate-300 rounded px-2.5 py-1.5 text-xs col-span-2" />
            <select value={nd.kelas_id} onChange={(e) => setNewDraft((p) => ({ ...p, [c.id]: { ...nd, kelas_id: e.target.value } }))} className="border border-slate-300 rounded px-2.5 py-1.5 text-xs bg-white">
              {db.kelas.map((k) => <option key={k.id} value={k.id}>{k.nama}</option>)}
            </select>
            <input type="date" required value={nd.tanggal_lahir} onChange={(e) => setNewDraft((p) => ({ ...p, [c.id]: { ...nd, tanggal_lahir: e.target.value } }))} className="border border-slate-300 rounded px-2.5 py-1.5 text-xs font-mono" />
            <input placeholder="WA Ortu (628xxx)" value={nd.wa_ortu} onChange={(e) => setNewDraft((p) => ({ ...p, [c.id]: { ...nd, wa_ortu: e.target.value } }))} className="border border-slate-300 rounded px-2.5 py-1.5 text-xs col-span-2 font-mono" />
            <button type="submit" className="col-span-2 py-2 text-xs font-semibold text-white bg-blue-700 hover:bg-blue-800 rounded-md">
              Buat Siswa Baru &amp; Pindahkan Embedding
            </button>
          </form>
        )}

        {mode === 'visitor' && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              onMarkVisitor(c.id, vd);
            }}
            className="grid grid-cols-2 gap-2"
          >
            <input placeholder="Nama Tamu / Staf" required value={vd.nama} onChange={(e) => setVisDraft((p) => ({ ...p, [c.id]: { ...vd, nama: e.target.value } }))} className="border border-slate-300 rounded px-2.5 py-1.5 text-xs" />
            <select value={vd.kategori} onChange={(e) => setVisDraft((p) => ({ ...p, [c.id]: { ...vd, kategori: e.target.value as 'TAMU' | 'STAF' } }))} className="border border-slate-300 rounded px-2.5 py-1.5 text-xs bg-white">
              <option value="TAMU">TAMU</option>
              <option value="STAF">STAF</option>
            </select>
            <input placeholder="Catatan (Opsional)" value={vd.catatan} onChange={(e) => setVisDraft((p) => ({ ...p, [c.id]: { ...vd, catatan: e.target.value } }))} className="border border-slate-300 rounded px-2.5 py-1.5 text-xs col-span-2" />
            <button type="submit" className="col-span-2 py-2 text-xs font-semibold text-white bg-slate-800 hover:bg-slate-900 rounded-md">
              Simpan ke Daftar Visitors
            </button>
          </form>
        )}
      </div>
    );
  };

  return (
    <div className="space-y-6">
      <div className="bg-white border border-slate-200 rounded-lg p-4 text-xs text-slate-600 space-y-1.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span>
            Siswa anonim yang melewati kamera CCTV akan dikelompokkan otomatis hingga memenuhi syarat <strong className="text-slate-900">&ge; {targetHits} hit match</strong> (status <strong className="text-slate-900">READY</strong>) agar diberi nama oleh Guru BK.
          </span>
          <span className="font-mono font-semibold text-slate-900 tabular-nums">
            Siap Dinamai (READY): {readyClusters.length} · Sedang Dilatih (PENDING): {pendingClusters.length}
          </span>
        </div>
        <p className="text-slate-500">
          Hanya foto wajah dengan kualitas <strong>&ge; {Math.round((db.settings.min_snapshot_quality ?? 0.7) * 100)}%</strong> yang diambil &amp; disimpan kamera. Setelah diberi nama, embedding terbaik digabung (centroid blending) dan sistem terus melakukan auto-maintenance di semua CCTV hingga target optimal <strong>&ge; {Math.round((db.settings.face_maintenance_target ?? 0.8) * 100)}%</strong>.
        </p>
        {workerStatus && (
          <div className="pt-1.5 mt-1 border-t border-slate-100 flex flex-wrap items-center gap-3 text-[11px] font-mono text-slate-600">
            <span>
              Engine AI: <strong className="text-slate-900">{workerStatus.engine}</strong>
            </span>
            <span>
              Worker RTSP Aktif: <strong className="text-slate-900">{workerStatus.active_workers}</strong>
            </span>
            <span>
              Total Wajah Terdeteksi Live:{' '}
              <strong className="text-slate-900">
                {workerStatus.cameras.reduce((acc, cm) => acc + cm.faces_detected_total, 0)}
              </strong>
            </span>
          </div>
        )}
      </div>

      {/* Section 1: READY clusters */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-slate-900">
          Cluster Siap Dinamai — READY ({readyClusters.length})
        </h2>

        {readyClusters.length === 0 ? (
          <div className="bg-white border border-slate-200 rounded-lg p-6 text-center">
            <p className="text-sm font-medium text-slate-700">Belum ada cluster wajah anonim berstatus READY.</p>
            <p className="text-xs text-slate-500 mt-1">
              Wajah anonim promosi ke READY otomatis setelah &ge; {targetHits} hit match &amp; &ge; {targetDays} hari berbeda. Deteksi hit ke-1 s/d ke-{Math.max(1, targetHits - 1)} tampil langsung di bagian <strong>Sedang Dilatih Live (PENDING)</strong> di bawah.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {readyClusters.map((c) => {
              const cam = db.cameras.find((cm) => cm.id === c.last_camera_id);
              const gate = db.gates.find((g) => g.id === cam?.gate_id);
              return (
                <article key={c.id} className="bg-white border border-slate-200 rounded-lg p-5 space-y-4">
                  <div className="flex items-start gap-4">
                    <button
                      type="button"
                      onClick={() => openClusterLightbox(c, 0)}
                      aria-label={`Perbesar foto Cluster #${c.id}`}
                      className="group relative shrink-0 rounded-md overflow-hidden border border-slate-200 hover:border-blue-500"
                    >
                      <img
                        src={c.best_snapshot_path}
                        alt={`Cluster anonim ${c.id}`}
                        referrerPolicy="no-referrer"
                        className="w-28 h-28 object-cover bg-slate-100"
                      />
                      <span className="absolute inset-x-0 bottom-0 bg-slate-900/75 text-white text-[10px] font-medium py-0.5 flex items-center justify-center gap-1">
                        <ZoomIn className="w-3 h-3" /> Perbesar
                      </span>
                    </button>
                    <div className="text-xs space-y-1 flex-1 min-w-0">
                      <div className="flex items-center justify-between gap-2">
                        <h3 className="text-sm font-semibold text-slate-900">Cluster #{c.id} (READY)</h3>
                        <div className="flex items-center gap-2">
                          <span className="font-mono tabular-nums text-emerald-700 font-semibold">
                            Skor {c.best_quality_score.toFixed(3)}
                          </span>
                          {onDeleteCluster && (
                            <button
                              type="button"
                              onClick={() => onDeleteCluster(c.id)}
                              aria-label={`Hapus Cluster #${c.id}`}
                              title="Hapus / abaikan cluster ini"
                              className="p-1 text-slate-400 hover:text-red-600 rounded"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          )}
                        </div>
                      </div>
                      <div className="text-slate-600 font-mono tabular-nums">
                        Hit: <strong>{c.hit_count}x</strong> · Hari Berbeda: <strong>{c.distinct_days}</strong>
                      </div>
                      <div className="text-slate-500 font-mono">First Seen: {c.first_seen}</div>
                      <div className="text-slate-500 font-mono">Last Seen: {c.last_seen}</div>
                      <div className="text-slate-600 truncate">
                        Lokasi: {cam?.nama_kamera ?? '-'} ({gate?.nama_gerbang ?? '-'})
                      </div>
                    </div>
                  </div>
                  {renderHitsGallery(c)}
                  {renderActionControls(c)}
                </article>
              );
            })}
          </div>
        )}
      </section>

      {/* Section 2: PENDING live training clusters (Hit 1..4) */}
      <section className="space-y-3">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-slate-900">
            Baru Terdeteksi / Sedang Dilatih Live — PENDING ({pendingClusters.length})
          </h2>
          <span className="text-xs text-slate-500">
            Setiap kali wajah baru melewati kamera RTSP, progres hit (1/{targetHits}) tercatat di sini secara real-time.
          </span>
        </div>

        {pendingClusters.length === 0 ? (
          <div className="bg-white border border-slate-200 rounded-lg p-5 text-xs text-slate-500 text-center">
            Belum ada deteksi wajah anonim yang sedang dalam tahap pengumpulan hit (PENDING).
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {pendingClusters.map((c) => {
              const cam = db.cameras.find((cm) => cm.id === c.last_camera_id);
              const gate = db.gates.find((g) => g.id === cam?.gate_id);
              const pct = Math.min(100, Math.round((c.hit_count / targetHits) * 100));
              const expanded = Boolean(expandedPendingMap[c.id]);

              return (
                <article key={c.id} className="bg-white border border-amber-200 rounded-lg p-4 space-y-3">
                  <div className="flex items-start gap-3.5">
                    <button
                      type="button"
                      onClick={() => openClusterLightbox(c, 0)}
                      aria-label={`Perbesar foto Anonim #${c.id}`}
                      className="group relative shrink-0 rounded-md overflow-hidden border border-slate-200 hover:border-blue-500"
                    >
                      <img
                        src={c.best_snapshot_path}
                        alt={`Snapshot anonim pending ${c.id}`}
                        referrerPolicy="no-referrer"
                        className="w-24 h-24 object-cover bg-slate-100"
                      />
                      <span className="absolute inset-x-0 bottom-0 bg-slate-900/75 text-white text-[10px] font-medium py-0.5 flex items-center justify-center gap-1">
                        <ZoomIn className="w-3 h-3" /> Perbesar
                      </span>
                    </button>
                    <div className="text-xs space-y-1 flex-1 min-w-0">
                      <div className="flex items-center justify-between gap-2">
                        <h3 className="text-sm font-semibold text-slate-900">
                          Anonim #{c.id} <span className="text-amber-700 font-mono text-xs">(PENDING)</span>
                        </h3>
                        <div className="flex items-center gap-2">
                          <span className="font-mono tabular-nums text-slate-700 font-semibold">
                            Skor {c.best_quality_score.toFixed(3)}
                          </span>
                          {onDeleteCluster && (
                            <button
                              type="button"
                              onClick={() => onDeleteCluster(c.id)}
                              aria-label={`Hapus Anonim #${c.id}`}
                              title="Hapus / abaikan cluster ini"
                              className="p-1 text-slate-400 hover:text-red-600 rounded"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center justify-between text-[11px] font-mono text-slate-600 tabular-nums">
                        <span>
                          Progres Hit: <strong>{c.hit_count} / {targetHits}</strong>
                        </span>
                        <span>
                          Hari: <strong>{c.distinct_days} / {targetDays}</strong>
                        </span>
                      </div>
                      <div className="w-full h-1.5 bg-slate-100 rounded overflow-hidden">
                        <div className="h-full bg-amber-500 transition-all" style={{ width: `${pct}%` }} />
                      </div>
                      <div className="text-[11px] text-slate-500 font-mono">
                        Last Seen: {c.last_seen}
                      </div>
                      <div className="text-[11px] text-slate-600 truncate">
                        Kamera: {cam?.nama_kamera ?? '-'} ({gate?.nama_gerbang ?? '-'})
                      </div>
                    </div>
                  </div>

                  {renderHitsGallery(c)}

                  <div className="flex justify-end">
                    <button
                      type="button"
                      onClick={() => setExpandedPendingMap((p) => ({ ...p, [c.id]: !expanded }))}
                      className="text-xs font-medium text-blue-700 hover:underline"
                    >
                      {expanded ? 'Tutup Form Penamaan Awal' : 'Beri Nama / Tandai Sekarang (Opsional)'}
                    </button>
                  </div>

                  {expanded && renderActionControls(c)}
                </article>
              );
            })}
          </div>
        )}
      </section>

      <FaceLightboxModal
        isOpen={Boolean(lightboxState)}
        onClose={() => setLightboxState(null)}
        title={lightboxState?.title ?? ''}
        subtitle={lightboxState?.subtitle}
        referenceItem={lightboxState?.referenceItem}
        items={lightboxState?.items ?? []}
        initialIndex={lightboxState?.initialIndex ?? 0}
      />
    </div>
  );
};
