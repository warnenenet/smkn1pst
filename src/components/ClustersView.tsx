import React, { useState } from 'react';
import { ChevronLeft, ChevronRight, Search, Star, Trash2, ZoomIn } from 'lucide-react';
import type { AnonymousCluster, AppDatabase, WorkerStatusResponse } from '../types';
import { FaceLightboxModal, type FaceGalleryItem } from './FaceLightboxModal';
import {
  buildPageTokens,
  CLUSTER_PAGE_SIZE_OPTIONS,
  DEFAULT_CLUSTER_PAGE_SIZE,
  paginateItems,
  sortAndFilterClusters,
} from '../lib/clusterPagination';

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
  onRemoveClusterHit?: (clusterId: number, payload: { snapshot_path: string; hit_index: number }) => Promise<void>;
  onSetPrimaryClusterHit?: (clusterId: number, payload: { snapshot_path: string; hit_index: number }) => Promise<void>;
}

export const ClustersView: React.FC<ClustersViewProps> = ({
  db,
  workerStatus,
  onAssignCluster,
  onCreateStudentFromCluster,
  onMarkVisitor,
  onDeleteCluster,
  onRemoveClusterHit,
  onSetPrimaryClusterHit,
}) => {
  const allReadyClusters = sortAndFilterClusters({
    clusters: db.anonymous_clusters,
    status: 'READY',
    cameras: db.cameras,
    gates: db.gates,
  });
  const allPendingClusters = sortAndFilterClusters({
    clusters: db.anonymous_clusters,
    status: 'PENDING',
    cameras: db.cameras,
    gates: db.gates,
  });
  const activeClusters = [...allReadyClusters, ...allPendingClusters];

  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'ALL' | 'READY' | 'PENDING'>('ALL');
  const [pageSize, setPageSize] = useState<number>(DEFAULT_CLUSTER_PAGE_SIZE);
  const [readyPage, setReadyPage] = useState<number>(1);
  const [pendingPage, setPendingPage] = useState<number>(1);

  const filteredReadyClusters = sortAndFilterClusters({
    clusters: db.anonymous_clusters,
    status: 'READY',
    searchQuery,
    cameras: db.cameras,
    gates: db.gates,
  });
  const filteredPendingClusters = sortAndFilterClusters({
    clusters: db.anonymous_clusters,
    status: 'PENDING',
    searchQuery,
    cameras: db.cameras,
    gates: db.gates,
  });

  const pagedReady = paginateItems(filteredReadyClusters, readyPage, pageSize);
  const pagedPending = paginateItems(filteredPendingClusters, pendingPage, pageSize);

  const [queryMap, setQueryMap] = useState<Record<number, string>>({});
  const [suggestionsMap, setSuggestionsMap] = useState<Record<number, AutocompleteItem[]>>({});
  const [selectedStudentMap, setSelectedStudentMap] = useState<Record<number, number>>({});
  const [modeMap, setModeMap] = useState<Record<number, 'assign' | 'new' | 'visitor'>>({});
  const [expandedPendingMap, setExpandedPendingMap] = useState<Record<number, boolean>>({});
  const [busyKey, setBusyKey] = useState<string | null>(null);

  // Draft siswa baru / tamu per cluster
  const [newDraft, setNewDraft] = useState<
    Record<number, { nis: string; nisn: string; nama: string; kelas_id: string; tanggal_lahir: string; wa_ortu: string }>
  >({});
  const [visDraft, setVisDraft] = useState<Record<number, { nama: string; kategori: 'TAMU' | 'STAF'; catatan: string }>>({});
  const [lightboxTarget, setLightboxTarget] = useState<{ clusterId: number; initialIndex: number } | null>(null);

  const targetHits = Math.max(1, db.settings.cluster_ready_hits ?? 5);
  const targetDays = Math.max(1, db.settings.cluster_ready_days ?? 1);

  const renderPaginationBar = (params: {
    sectionLabel: string;
    slice: ReturnType<typeof paginateItems<AnonymousCluster>>;
    onPageChange: (nextPage: number) => void;
  }) => {
    const { sectionLabel, slice, onPageChange } = params;
    if (slice.totalItems === 0) return null;
    const tokens = buildPageTokens(slice.page, slice.totalPages);

    return (
      <div className="flex flex-wrap items-center justify-between gap-2 bg-white border border-slate-200 rounded-md px-3 py-2 text-xs text-slate-600">
        <span className="font-mono tabular-nums">
          Menampilkan <strong>{slice.startIndex}&ndash;{slice.endIndex}</strong> dari{' '}
          <strong>{slice.totalItems}</strong> cluster {sectionLabel}
        </span>
        {slice.totalPages > 1 && (
          <nav aria-label={`Navigasi halaman ${sectionLabel}`} className="flex flex-wrap items-center gap-1">
            <button
              type="button"
              disabled={slice.page <= 1}
              onClick={() => onPageChange(Math.max(1, slice.page - 1))}
              aria-label={`Halaman sebelumnya ${sectionLabel}`}
              className="inline-flex items-center gap-1 px-2 py-1 border border-slate-300 rounded hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <ChevronLeft className="w-3.5 h-3.5" />
              <span>Sebelumnya</span>
            </button>
            {tokens.map((tok, idx) =>
              tok === 'ellipsis' ? (
                <span key={`el-${idx}`} className="px-1.5 text-slate-400 select-none">
                  ...
                </span>
              ) : (
                <button
                  key={`pg-${tok}`}
                  type="button"
                  onClick={() => onPageChange(tok)}
                  aria-label={`Halaman ${tok} ${sectionLabel}`}
                  aria-current={tok === slice.page ? 'page' : undefined}
                  className={`min-w-[28px] px-2 py-1 rounded font-mono tabular-nums border transition-colors ${
                    tok === slice.page
                      ? 'bg-slate-900 text-white border-slate-900 font-semibold'
                      : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50'
                  }`}
                >
                  {tok}
                </button>
              )
            )}
            <button
              type="button"
              disabled={slice.page >= slice.totalPages}
              onClick={() => onPageChange(Math.min(slice.totalPages, slice.page + 1))}
              aria-label={`Halaman berikutnya ${sectionLabel}`}
              className="inline-flex items-center gap-1 px-2 py-1 border border-slate-300 rounded hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <span>Berikutnya</span>
              <ChevronRight className="w-3.5 h-3.5" />
            </button>
          </nav>
        )}
      </div>
    );
  };

  const getClusterHits = (c: AnonymousCluster): FaceGalleryItem[] => {
    const rawHits =
      Array.isArray(c.hit_snapshots) && c.hit_snapshots.length > 0
        ? c.hit_snapshots.slice(0, 5)
        : [
            {
              snapshot_path: c.best_snapshot_path,
              quality_score: c.best_quality_score,
              similarity: 1,
              camera_id: c.last_camera_id,
              detected_at: c.last_seen,
              has_embedding: false,
            },
          ];
    return rawHits.map((h, idx) => {
      const camName = db.cameras.find((cm) => cm.id === h.camera_id)?.nama_kamera ?? 'Kamera Gerbang';
      return {
        src: h.snapshot_path,
        label: h.snapshot_path === c.best_snapshot_path ? `Hit #${idx + 1} (Acuan)` : `Hit #${idx + 1}`,
        timestamp: h.detected_at,
        cameraName: camName,
        similarity: h.similarity,
        qualityScore: h.quality_score,
        isReference: h.snapshot_path === c.best_snapshot_path,
        hasEmbedding: Boolean(h.has_embedding || (Array.isArray(h.embedding) && h.embedding.length > 0)),
      };
    });
  };

  const openClusterLightbox = (c: AnonymousCluster, index = 0) => {
    setLightboxTarget({ clusterId: c.id, initialIndex: index });
  };

  const runBusy = async (key: string, fn: () => Promise<void>) => {
    setBusyKey(key);
    try {
      await fn();
    } finally {
      setBusyKey(null);
    }
  };

  const renderHitsGallery = (c: AnonymousCluster) => {
    const hits = getClusterHits(c);

    return (
      <div className="pt-2.5 border-t border-slate-100 space-y-2.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-xs font-semibold text-slate-700">
            Foto Train Wajah ({hits.length}/5 foto terbaik)
          </span>
          <button
            type="button"
            onClick={() => openClusterLightbox(c, 0)}
            className="inline-flex items-center gap-1 text-xs font-semibold text-blue-700 hover:underline"
          >
            <ZoomIn className="w-3.5 h-3.5" />
            Perbesar &amp; Zoom Crosscheck
          </button>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
          {hits.map((h, idx) => {
            const isPrimary = h.src === c.best_snapshot_path;
            const removeKey = `rm-${c.id}-${idx}`;
            const promoteKey = `prom-${c.id}-${idx}`;
            const simPct = typeof h.similarity === 'number' ? Math.round(h.similarity * 100) : null;
            const qualPct = typeof h.qualityScore === 'number' ? Math.round(h.qualityScore * 100) : null;
            const simColorClass =
              isPrimary
                ? 'text-emerald-800 font-semibold'
                : simPct !== null && simPct < 60
                  ? 'text-red-700 font-semibold'
                  : simPct !== null && simPct < 75
                    ? 'text-amber-700 font-semibold'
                    : 'text-slate-700';

            return (
              <div
                key={`${c.id}-${h.src}-${idx}`}
                className={`rounded-md border p-1.5 transition-colors ${
                  isPrimary ? 'border-emerald-400 bg-emerald-50/40' : 'border-slate-200 bg-slate-50'
                }`}
              >
                <button
                  type="button"
                  onClick={() => openClusterLightbox(c, idx)}
                  aria-label={`Perbesar Hit #${idx + 1} untuk Cluster #${c.id}`}
                  className="group relative block w-full text-left"
                >
                  <img
                    src={h.src}
                    alt={`${h.label} Cluster ${c.id}`}
                    referrerPolicy="no-referrer"
                    className="w-full h-20 rounded object-cover bg-slate-200"
                  />
                  <span className="absolute bottom-1 right-1 bg-slate-900/75 text-white rounded p-0.5 opacity-85 group-hover:opacity-100">
                    <ZoomIn className="w-3 h-3" />
                  </span>
                </button>

                <div className={`mt-1 text-[10px] font-mono truncate tabular-nums ${simColorClass}`}>
                  {isPrimary ? 'ACUAN' : simPct !== null ? `Match ${simPct}%` : h.label}
                </div>
                <div className="flex items-center justify-between gap-1 text-[9px] font-mono text-slate-500 tabular-nums">
                  <span>{qualPct !== null ? `Q ${qualPct}%` : '-'}</span>
                  <span>{h.timestamp ? h.timestamp.slice(11, 16) : '-'}</span>
                </div>

                <div className="mt-1.5 flex items-center gap-1">
                  {!isPrimary && onSetPrimaryClusterHit && (
                    <button
                      type="button"
                      disabled={busyKey !== null}
                      onClick={() =>
                        runBusy(promoteKey, () => onSetPrimaryClusterHit(c.id, { snapshot_path: h.src, hit_index: idx }))
                      }
                      aria-label={`Jadikan Hit #${idx + 1} sebagai foto acuan Cluster #${c.id}`}
                      title="Jadikan foto acuan utama"
                      className="flex-1 inline-flex items-center justify-center gap-0.5 py-1 text-[10px] font-medium bg-white border border-slate-200 hover:border-emerald-500 hover:text-emerald-700 text-slate-700 rounded disabled:opacity-50"
                    >
                      <Star className="w-2.5 h-2.5" /> Acuan
                    </button>
                  )}
                  {onRemoveClusterHit && (
                    <button
                      type="button"
                      disabled={busyKey !== null}
                      onClick={() =>
                        runBusy(removeKey, () => onRemoveClusterHit(c.id, { snapshot_path: h.src, hit_index: idx }))
                      }
                      aria-label={`Hapus Hit #${idx + 1} dari Cluster #${c.id}`}
                      title="Hapus foto jika bukan wajahnya / hanya topi / blur"
                      className={`${isPrimary || !onSetPrimaryClusterHit ? 'flex-1' : ''} inline-flex items-center justify-center gap-0.5 px-1.5 py-1 text-[10px] font-medium bg-white border border-red-200 hover:bg-red-50 text-red-700 rounded disabled:opacity-50`}
                    >
                      <Trash2 className="w-2.5 h-2.5" />
                      Hapus
                    </button>
                  )}
                </div>
              </div>
            );
          })}
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
            Setiap wajah anonim menyimpan maksimal <strong className="text-slate-900">5 foto train kualitas terbaik</strong> (foto berlebih otomatis dihapus). Klik foto untuk memperbesar &amp; zoom, lalu hapus jika ada foto yang salah orang atau hanya menangkap topi/bagian tidak sesuai.
          </span>
          <span className="font-mono font-semibold text-slate-900 tabular-nums">
            Siap Dinamai (READY): {allReadyClusters.length} · Sedang Dilatih (PENDING): {allPendingClusters.length}
          </span>
        </div>
        <p className="text-slate-500">
          Jika foto salah/topi dihapus saat koreksi, grup otomatis kembali ke status <strong>PENDING</strong> agar kamera dapat melanjutkan training wajah bersih sampai mencapai <strong>&ge; {targetHits} hit</strong>.
        </p>
        <div className="pt-2 border-t border-slate-100 flex flex-wrap items-center justify-between gap-2.5">
          <div className="relative flex-1 min-w-[220px] max-w-md">
            <label htmlFor="cluster-search-input" className="sr-only">
              Cari cluster anonim berdasarkan nomor ID, nama kamera, gerbang, atau waktu
            </label>
            <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              id="cluster-search-input"
              type="text"
              value={searchQuery}
              onChange={(e) => {
                setSearchQuery(e.target.value);
                setReadyPage(1);
                setPendingPage(1);
              }}
              placeholder="Cari Cluster #ID, kamera, atau gerbang..."
              className="w-full border border-slate-300 rounded-md pl-8 pr-3 py-1.5 text-xs text-slate-900"
            />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <label htmlFor="cluster-status-filter" className="text-[11px] font-medium text-slate-600">
              Tampilkan:
            </label>
            <select
              id="cluster-status-filter"
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as 'ALL' | 'READY' | 'PENDING')}
              className="border border-slate-300 rounded-md px-2.5 py-1.5 text-xs bg-white text-slate-800"
            >
              <option value="ALL">Semua ({allReadyClusters.length + allPendingClusters.length})</option>
              <option value="READY">READY ({allReadyClusters.length})</option>
              <option value="PENDING">PENDING ({allPendingClusters.length})</option>
            </select>
            <label htmlFor="cluster-page-size" className="text-[11px] font-medium text-slate-600 ml-1">
              Per halaman:
            </label>
            <select
              id="cluster-page-size"
              value={pageSize}
              onChange={(e) => {
                setPageSize(Number(e.target.value));
                setReadyPage(1);
                setPendingPage(1);
              }}
              className="border border-slate-300 rounded-md px-2.5 py-1.5 text-xs bg-white text-slate-800 font-mono"
            >
              {CLUSTER_PAGE_SIZE_OPTIONS.map((opt) => (
                <option key={opt} value={opt}>
                  {opt}
                </option>
              ))}
            </select>
          </div>
        </div>
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
      {(statusFilter === 'ALL' || statusFilter === 'READY') && (
        <section className="space-y-3">
          <h2 className="text-sm font-semibold text-slate-900">
            Cluster Siap Dinamai — READY ({filteredReadyClusters.length}
            {searchQuery.trim() ? ` dari ${allReadyClusters.length}` : ''})
          </h2>

          {renderPaginationBar({
            sectionLabel: 'READY',
            slice: pagedReady,
            onPageChange: setReadyPage,
          })}

          {filteredReadyClusters.length === 0 ? (
            <div className="bg-white border border-slate-200 rounded-lg p-6 text-center">
              <p className="text-sm font-medium text-slate-700">
                {searchQuery.trim()
                  ? 'Tidak ada cluster READY yang cocok dengan pencarian.'
                  : 'Belum ada cluster wajah anonim berstatus READY.'}
              </p>
              <p className="text-xs text-slate-500 mt-1">
                Wajah anonim promosi ke READY setelah &ge; {targetHits} hit match &amp; &ge; {targetDays} hari berbeda. Deteksi sementara tampil di bagian <strong>Sedang Dilatih Live (PENDING)</strong> di bawah.
              </p>
            </div>
          ) : (
            <>
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                {pagedReady.items.map((c) => {
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
              {pagedReady.totalPages > 1 &&
                renderPaginationBar({
                  sectionLabel: 'READY',
                  slice: pagedReady,
                  onPageChange: setReadyPage,
                })}
            </>
          )}
        </section>
      )}

      {/* Section 2: PENDING live training clusters */}
      {(statusFilter === 'ALL' || statusFilter === 'PENDING') && (
        <section className="space-y-3">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-slate-900">
              Sedang Dilatih Live — PENDING ({filteredPendingClusters.length}
              {searchQuery.trim() ? ` dari ${allPendingClusters.length}` : ''})
            </h2>
            <span className="text-xs text-slate-500">
              Wajah baru yang tertangkap RTSP terus dilatih di sini hingga siap dinamai.
            </span>
          </div>

          {renderPaginationBar({
            sectionLabel: 'PENDING',
            slice: pagedPending,
            onPageChange: setPendingPage,
          })}

          {filteredPendingClusters.length === 0 ? (
            <div className="bg-white border border-slate-200 rounded-lg p-5 text-xs text-slate-500 text-center">
              {searchQuery.trim()
                ? 'Tidak ada cluster PENDING yang cocok dengan pencarian.'
                : 'Belum ada deteksi wajah anonim berstatus PENDING.'}
            </div>
          ) : (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              {pagedPending.items.map((c) => {
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
                      <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
                        <h3 className="text-sm font-semibold text-slate-900">
                          Anonim #{c.id} <span className="text-amber-700 font-mono text-xs">(PENDING)</span>
                        </h3>
                        <div className="flex items-center gap-2 shrink-0">
                          <span className="font-mono tabular-nums text-slate-700 font-semibold whitespace-nowrap">
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
                      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5 text-[11px] font-mono text-slate-600 tabular-nums">
                        <span className="whitespace-nowrap">
                          Progres Hit: <strong>{c.hit_count} / {targetHits}</strong>
                        </span>
                        <span className="whitespace-nowrap">
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
          {pagedPending.totalPages > 1 &&
            renderPaginationBar({
              sectionLabel: 'PENDING',
              slice: pagedPending,
              onPageChange: setPendingPage,
            })}
        </section>
      )}

      {(() => {
        const activeCluster = lightboxTarget
          ? activeClusters.find((c) => c.id === lightboxTarget.clusterId) ?? null
          : null;
        const lightboxItems = activeCluster ? getClusterHits(activeCluster) : [];
        return (
          <FaceLightboxModal
            isOpen={Boolean(activeCluster && lightboxItems.length > 0)}
            onClose={() => setLightboxTarget(null)}
            title={
              activeCluster
                ? `Cluster Anonim #${activeCluster.id} (${activeCluster.status}) — Crosscheck & Zoom`
                : ''
            }
            subtitle={
              activeCluster
                ? `${lightboxItems.length}/5 foto train tersimpan · Gunakan Zoom 1x/2x/3x lalu hapus jika ada foto topi atau wajah yang berbeda`
                : undefined
            }
            referenceItem={
              activeCluster
                ? {
                    src: activeCluster.best_snapshot_path,
                    label: 'Foto Acuan Cluster',
                    meta: `Skor ${(activeCluster.best_quality_score * 100).toFixed(1)}% · ${activeCluster.last_seen}`,
                  }
                : null
            }
            items={lightboxItems}
            initialIndex={lightboxTarget?.initialIndex ?? 0}
            renderItemActions={
              activeCluster
                ? (item, itemIdx) => {
                    const isPrimary = item.src === activeCluster.best_snapshot_path;
                    return (
                      <>
                        <span className="text-[11px] text-slate-300">
                          {isPrimary
                            ? 'Foto ini sedang menjadi acuan utama.'
                            : 'Apakah wajah ini sama dan bukan sekadar foto topi / blur?'}
                        </span>
                        <div className="flex flex-wrap items-center gap-2">
                          {!isPrimary && onSetPrimaryClusterHit && (
                            <button
                              type="button"
                              disabled={busyKey !== null}
                              onClick={() =>
                                runBusy(`lb-prom-${activeCluster.id}-${itemIdx}`, () =>
                                  onSetPrimaryClusterHit(activeCluster.id, { snapshot_path: item.src, hit_index: itemIdx })
                                )
                              }
                              className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-semibold rounded bg-emerald-700 hover:bg-emerald-600 text-white disabled:opacity-50"
                            >
                              <Star className="w-3.5 h-3.5" /> Jadikan Foto Acuan
                            </button>
                          )}
                          {onRemoveClusterHit && (
                            <button
                              type="button"
                              disabled={busyKey !== null}
                              onClick={() =>
                                runBusy(`lb-rm-${activeCluster.id}-${itemIdx}`, async () => {
                                  await onRemoveClusterHit(activeCluster.id, {
                                    snapshot_path: item.src,
                                    hit_index: itemIdx,
                                  });
                                  if (lightboxItems.length <= 1) {
                                    setLightboxTarget(null);
                                  }
                                })
                              }
                              className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-semibold rounded bg-red-600 hover:bg-red-500 text-white disabled:opacity-50"
                            >
                              <Trash2 className="w-3.5 h-3.5" /> Hapus Foto Ini
                            </button>
                          )}
                        </div>
                      </>
                    );
                  }
                : undefined
            }
          />
        );
      })()}
    </div>
  );
};
