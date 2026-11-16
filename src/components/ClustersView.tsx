import React, { useState } from 'react';
import type { AppDatabase } from '../types';

interface AutocompleteItem {
  id: number;
  nama: string;
  nisn: string;
  kelas: string;
}

interface ClustersViewProps {
  db: AppDatabase;
  onAssignCluster: (clusterId: number, studentId: number) => Promise<void>;
  onCreateStudentFromCluster: (
    clusterId: number,
    payload: { nis: string; nisn: string; nama: string; kelas_id: number; tanggal_lahir: string; wa_ortu: string }
  ) => Promise<void>;
  onMarkVisitor: (clusterId: number, payload: { nama: string; kategori: 'TAMU' | 'STAF'; catatan: string }) => Promise<void>;
}

export const ClustersView: React.FC<ClustersViewProps> = ({
  db,
  onAssignCluster,
  onCreateStudentFromCluster,
  onMarkVisitor,
}) => {
  const readyClusters = db.anonymous_clusters.filter((c) => c.status === 'READY');
  const pendingClusters = db.anonymous_clusters.filter((c) => c.status === 'PENDING');
  const [queryMap, setQueryMap] = useState<Record<number, string>>({});
  const [suggestionsMap, setSuggestionsMap] = useState<Record<number, AutocompleteItem[]>>({});
  const [selectedStudentMap, setSelectedStudentMap] = useState<Record<number, number>>({});
  const [modeMap, setModeMap] = useState<Record<number, 'assign' | 'new' | 'visitor'>>({});

  // New student / visitor drafts per cluster
  const [newDraft, setNewDraft] = useState<Record<number, { nis: string; nisn: string; nama: string; kelas_id: string; tanggal_lahir: string; wa_ortu: string }>>({});
  const [visDraft, setVisDraft] = useState<Record<number, { nama: string; kategori: 'TAMU' | 'STAF'; catatan: string }>>({});

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

  return (
    <div className="space-y-6">
      <div className="bg-white border border-slate-200 rounded-lg p-4 text-xs text-slate-600 space-y-1.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span>
            Siswa anonim yang melewati kamera CCTV akan dikelompokkan otomatis hingga memenuhi syarat <strong className="text-slate-900">&ge; {db.settings.cluster_ready_hits} hit match</strong> (status <strong className="text-slate-900">READY</strong>) agar diberi nama oleh Guru BK.
          </span>
          <span className="font-mono font-semibold text-slate-900 tabular-nums">
            Siap Dinamai (READY): {readyClusters.length} · Sedang Dilatih (PENDING): {pendingClusters.length}
          </span>
        </div>
        <p className="text-slate-500">
          Setelah diberi nama, embedding terbaik digabung (centroid blending) dan sistem terus melakukan auto-maintenance di semua CCTV hingga kualitas wajah mencapai target optimal <strong>&ge; {Math.round((db.settings.face_maintenance_target ?? 0.8) * 100)}%</strong>.
        </p>
      </div>

      {readyClusters.length === 0 ? (
        <div className="bg-white border border-slate-200 rounded-lg p-8 text-center">
          <p className="text-sm font-medium text-slate-700">Tidak ada cluster wajah anonim yang menunggu penamaan.</p>
          <p className="text-xs text-slate-500 mt-1">
            Wajah anonim baru akan muncul otomatis setelah memenuhi syarat (&ge; {db.settings.cluster_ready_hits} hit &amp; &ge; {db.settings.cluster_ready_days} hari berbeda).
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {readyClusters.map((c) => {
            const cam = db.cameras.find((cm) => cm.id === c.last_camera_id);
            const gate = db.gates.find((g) => g.id === cam?.gate_id);
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
              <article key={c.id} className="bg-white border border-slate-200 rounded-lg p-5 space-y-4">
                <div className="flex items-start gap-4">
                  <img
                    src={c.best_snapshot_path}
                    alt={`Cluster anonim ${c.id}`}
                    referrerPolicy="no-referrer"
                    className="w-24 h-24 rounded-md object-cover border border-slate-200 shrink-0"
                  />
                  <div className="text-xs space-y-1 flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-2">
                      <h3 className="text-sm font-semibold text-slate-900">Cluster #{c.id}</h3>
                      <span className="font-mono tabular-nums text-emerald-700 font-semibold">
                        Skor {c.best_quality_score.toFixed(3)}
                      </span>
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

                {/* Action Mode Tabs */}
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
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
};
