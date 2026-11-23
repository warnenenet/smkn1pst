import React, { useState } from 'react';
import { ScanEye, FileText, ZoomIn } from 'lucide-react';
import type { AppDatabase, AttendanceStatus, UserRole } from '../types';
import { getJakartaNowParts } from '../lib/attendanceEngine';
import { FaceLightboxModal, type FaceGalleryItem } from './FaceLightboxModal';
import { StudentAutocomplete } from './StudentAutocomplete';

interface AttendanceViewProps {
  db: AppDatabase;
  currentUserRole: UserRole;
  onOverrideStatus: (studentId: number, tanggal: string, status: AttendanceStatus, catatan?: string) => Promise<void>;
  onSimulateRecognition: (payload: {
    camera_id: number;
    student_id?: number;
    anonymous?: boolean;
    confidence: number;
    simulatedTime?: string;
    forceCall?: boolean;
  }) => Promise<string>;
}

export const AttendanceView: React.FC<AttendanceViewProps> = ({
  db,
  currentUserRole,
  onOverrideStatus,
  onSimulateRecognition,
}) => {
  const canManageIzinSakit = currentUserRole === 'BK' || currentUserRole === 'ADMIN';
  const today = getJakartaNowParts().dateStr;
  const [tanggal, setTanggal] = useState(today);
  const [jurusanId, setJurusanId] = useState('');
  const [kelasId, setKelasId] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const pageSize = 50;
  const [overrideDraft, setOverrideDraft] = useState<Record<number, AttendanceStatus>>({});
  const [lightboxState, setLightboxState] = useState<{
    title: string;
    subtitle: string;
    referenceItem: FaceGalleryItem | null;
    items: FaceGalleryItem[];
    initialIndex: number;
  } | null>(null);

  // Quick Input Izin / Sakit Khusus Guru BK
  const [bkStudentId, setBkStudentId] = useState('');
  const [bkStatus, setBkStatus] = useState<'SAKIT' | 'IZIN'>('SAKIT');
  const [bkCatatan, setBkCatatan] = useState('');

  // Simulator Camera Event
  const [simCameraId, setSimCameraId] = useState(String(db.cameras[0]?.id ?? 1));
  const [simTarget, setSimTarget] = useState(String(db.students[0]?.id ?? 'ANONIM'));
  const [simConf, setSimConf] = useState('0.94');
  const [simTime, setSimTime] = useState('07:05:00');
  const [simFeedback, setSimFeedback] = useState('');

  const filteredStudents = db.students.filter((s) => {
    const k = db.kelas.find((kl) => kl.id === s.kelas_id);
    if (jurusanId && String(k?.jurusan_id) !== jurusanId) return false;
    if (kelasId && String(s.kelas_id) !== kelasId) return false;
    if (search) {
      const q = search.toLowerCase();
      if (!s.nama.toLowerCase().includes(q) && !s.nisn.toLowerCase().includes(q)) return false;
    }
    return true;
  });
  const totalPages = Math.max(1, Math.ceil(filteredStudents.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const pagedStudents = filteredStudents.slice((safePage - 1) * pageSize, safePage * pageSize);

  const handleSimSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const isAnon = simTarget === 'ANONIM';
    const msg = await onSimulateRecognition({
      camera_id: Number(simCameraId),
      student_id: isAnon ? undefined : Number(simTarget),
      anonymous: isAnon,
      confidence: Number(simConf),
      simulatedTime: simTime,
      forceCall: true,
    });
    setSimFeedback(msg);
  };

  const statusColor = (st: string) => {
    if (st === 'HADIR' || st === 'PKL') return 'text-emerald-700';
    if (st === 'TERLAMBAT' || st === 'IZIN' || st === 'SAKIT') return 'text-amber-700';
    return 'text-red-700';
  };

  return (
    <div className="space-y-6">
      {/* Live Camera Event Simulator (hidden in Production Mode) */}
      {!db.settings.production_mode && (
        <section className="bg-white border border-slate-200 rounded-lg p-5">
          <div className="flex items-center gap-2 mb-3">
            <ScanEye className="w-4 h-4 text-blue-700" />
            <h2 className="text-sm font-semibold text-slate-900">Simulasi Deteksi Kamera RTSP (Uji Real-Time ke Kiosk &amp; Log)</h2>
          </div>
          <form onSubmit={handleSimSubmit} className="grid grid-cols-1 sm:grid-cols-5 gap-3 items-end">
            <div>
              <label htmlFor="sim-cam" className="block text-xs text-slate-600 mb-1">Kamera Gerbang</label>
              <select
                id="sim-cam"
                value={simCameraId}
                onChange={(e) => setSimCameraId(e.target.value)}
                className="w-full border border-slate-300 rounded-md px-2.5 py-2 text-xs bg-white"
              >
                {db.cameras.map((c) => (
                  <option key={c.id} value={c.id}>{c.nama_kamera}</option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="sim-target" className="block text-xs text-slate-600 mb-1">Subjek Wajah</label>
              <StudentAutocomplete
                id="sim-target"
                students={db.students}
                kelasList={db.kelas}
                value={simTarget}
                onChange={setSimTarget}
                placeholder="Cari siswa atau pilih Anonim..."
                extraOptions={[
                  { value: 'ANONIM', label: 'Wajah Anonim (Tak Dikenal)', meta: 'Uji Klaster' },
                ]}
              />
            </div>
            <div>
              <label htmlFor="sim-conf" className="block text-xs text-slate-600 mb-1">Confidence (Min 0.80)</label>
              <input
                id="sim-conf"
                type="number"
                step="0.01"
                min="0.1"
                max="1"
                value={simConf}
                onChange={(e) => setSimConf(e.target.value)}
                className="w-full border border-slate-300 rounded-md px-2.5 py-2 text-xs font-mono tabular-nums"
              />
            </div>
            <div>
              <label htmlFor="sim-time" className="block text-xs text-slate-600 mb-1">Jam Deteksi</label>
              <input
                id="sim-time"
                type="time"
                step="1"
                value={simTime}
                onChange={(e) => setSimTime(e.target.value)}
                className="w-full border border-slate-300 rounded-md px-2.5 py-2 text-xs font-mono tabular-nums"
              />
            </div>
            <button
              type="submit"
              className="px-4 py-2 text-xs font-semibold text-white bg-blue-700 hover:bg-blue-800 rounded-md transition-colors whitespace-nowrap"
            >
              Kirim Event Wajah
            </button>
          </form>
          {simFeedback && (
            <p className="mt-2.5 text-xs text-slate-700 font-medium">{simFeedback}</p>
          )}
        </section>
      )}

      {/* Panel Input Izin & Sakit Khusus Guru BK */}
      {canManageIzinSakit ? (
        <section className="bg-white border border-slate-200 rounded-lg p-5">
          <div className="flex items-center gap-2 mb-3">
            <FileText className="w-4 h-4 text-amber-700" />
            <h2 className="text-sm font-semibold text-slate-900">Input Izin / Sakit Siswa (Wewenang Guru BK)</h2>
          </div>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              if (!bkStudentId) return;
              await onOverrideStatus(Number(bkStudentId), tanggal, bkStatus, bkCatatan);
              setBkCatatan('');
            }}
            className="grid grid-cols-1 sm:grid-cols-5 gap-3 items-end"
          >
            <div className="sm:col-span-2">
              <label htmlFor="bk-student" className="block text-xs text-slate-600 mb-1">
                Cari Siswa ({db.students.length.toLocaleString('id-ID')} terdaftar)
              </label>
              <StudentAutocomplete
                id="bk-student"
                students={db.students}
                kelasList={db.kelas}
                value={bkStudentId}
                onChange={setBkStudentId}
                placeholder="Ketik nama, NISN, atau kelas..."
              />
            </div>
            <div>
              <label htmlFor="bk-status" className="block text-xs text-slate-600 mb-1">Status Keterangan</label>
              <select
                id="bk-status"
                value={bkStatus}
                onChange={(e) => setBkStatus(e.target.value as 'SAKIT' | 'IZIN')}
                className="w-full border border-slate-300 rounded-md px-2.5 py-2 text-xs bg-white"
              >
                <option value="SAKIT">SAKIT</option>
                <option value="IZIN">IZIN</option>
              </select>
            </div>
            <div>
              <label htmlFor="bk-note" className="block text-xs text-slate-600 mb-1">Alasan / Keterangan BK</label>
              <input
                id="bk-note"
                type="text"
                placeholder="Mis: Surat dokter / izin keluarga"
                value={bkCatatan}
                onChange={(e) => setBkCatatan(e.target.value)}
                className="w-full border border-slate-300 rounded-md px-2.5 py-2 text-xs"
              />
            </div>
            <button
              type="submit"
              disabled={!bkStudentId}
              className="px-4 py-2 text-xs font-semibold text-white bg-amber-700 hover:bg-amber-800 disabled:opacity-50 disabled:cursor-not-allowed rounded-md transition-colors whitespace-nowrap"
            >
              Simpan Izin / Sakit
            </button>
          </form>
        </section>
      ) : (
        <div className="bg-slate-100 border border-slate-200 rounded-lg px-4 py-3 text-xs text-slate-700">
          Mode baca untuk peran <strong className="font-mono">{currentUserRole}</strong>. Pencatatan dan persetujuan status <strong>SAKIT / IZIN</strong> dikelola oleh <strong>Guru BK</strong>.
        </div>
      )}

      {/* Filter Bar & Table */}
      <section className="bg-white border border-slate-200 rounded-lg p-5">
        <div className="grid grid-cols-1 sm:grid-cols-4 gap-3 mb-4">
          <div>
            <label htmlFor="att-date" className="block text-xs text-slate-600 mb-1">Tanggal</label>
            <input
              id="att-date"
              type="date"
              value={tanggal}
              onChange={(e) => setTanggal(e.target.value)}
              className="w-full border border-slate-300 rounded-md px-2.5 py-2 text-xs font-mono"
            />
          </div>
          <div>
            <label htmlFor="att-jur" className="block text-xs text-slate-600 mb-1">Jurusan</label>
            <select
              id="att-jur"
              value={jurusanId}
              onChange={(e) => {
                setJurusanId(e.target.value);
                setPage(1);
              }}
              className="w-full border border-slate-300 rounded-md px-2.5 py-2 text-xs bg-white"
            >
              <option value="">Semua Jurusan</option>
              {db.jurusans.map((j) => (
                <option key={j.id} value={j.id}>{j.kode} - {j.nama}</option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="att-kls" className="block text-xs text-slate-600 mb-1">Kelas</label>
            <select
              id="att-kls"
              value={kelasId}
              onChange={(e) => {
                setKelasId(e.target.value);
                setPage(1);
              }}
              className="w-full border border-slate-300 rounded-md px-2.5 py-2 text-xs bg-white"
            >
              <option value="">Semua Kelas</option>
              {db.kelas.map((k) => (
                <option key={k.id} value={k.id}>{k.nama}</option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="att-search" className="block text-xs text-slate-600 mb-1">Cari Nama / NISN</label>
            <input
              id="att-search"
              type="text"
              placeholder="Ketik nama atau NISN..."
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
              className="w-full border border-slate-300 rounded-md px-2.5 py-2 text-xs"
            />
          </div>
        </div>

        <div className="flex items-center justify-between text-xs text-slate-500 mb-3">
          <span>Menampilkan {pagedStudents.length} dari {filteredStudents.length} siswa</span>
          {totalPages > 1 && (
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={safePage <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                className="px-2 py-1 border border-slate-300 rounded disabled:opacity-40"
              >
                &larr;
              </button>
              <span className="font-mono">Hal {safePage}/{totalPages}</span>
              <button
                type="button"
                disabled={safePage >= totalPages}
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                className="px-2 py-1 border border-slate-300 rounded disabled:opacity-40"
              >
                &rarr;
              </button>
            </div>
          )}
        </div>

        {/* Table */}
        <div tabIndex={0} role="region" aria-label="Tabel Absensi Harian Siswa" className="table-wrapper">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-slate-200 text-slate-500">
                <th className="py-2.5 font-medium">Foto &amp; Hit Kamera</th>
                <th className="py-2.5 font-medium">NISN</th>
                <th className="py-2.5 font-medium">Nama Siswa</th>
                <th className="py-2.5 font-medium">Kelas</th>
                <th className="py-2.5 font-medium">Masuk</th>
                <th className="py-2.5 font-medium">Keluar</th>
                <th className="py-2.5 font-medium">Status &amp; Catatan</th>
                {canManageIzinSakit && <th className="py-2.5 font-medium text-right">Override (BK / Admin)</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {pagedStudents.map((s) => {
                const kelas = db.kelas.find((k) => k.id === s.kelas_id);
                const rec = db.daily_attendance.find((d) => d.student_id === s.id && d.tanggal === tanggal);
                const currentStatus = rec?.status ?? (s.status === 'PKL' ? 'PKL' : 'BELUM_ABSEN');
                const draftVal = overrideDraft[s.id] ?? (rec?.status ?? 'HADIR');
                const dayHitLogs = db.attendance_logs.filter(
                  (l) => l.student_id === s.id && l.timestamp.startsWith(tanggal) && Boolean(l.snapshot_path)
                );
                const galleryHits: FaceGalleryItem[] = dayHitLogs.map((l) => ({
                  src: String(l.snapshot_path),
                  label: `Hit ${l.tipe} (${l.status})`,
                  similarity: l.similarity_score ?? null,
                  timestamp: l.timestamp.replace('T', ' '),
                  cameraName: db.cameras.find((cm) => cm.id === l.camera_id)?.nama_kamera ?? null,
                }));
                if (galleryHits.length === 0 && s.foto_ref) {
                  galleryHits.push({
                    src: s.foto_ref,
                    label: 'Foto Profil Siswa',
                    qualityScore: s.embedding_quality_score || null,
                    timestamp: s.embedding_updated_at ?? null,
                  });
                }
                const referenceItem: FaceGalleryItem | null = s.foto_ref
                  ? {
                      src: s.foto_ref,
                      label: `Foto Profil Referensi (${s.nama})`,
                      meta: `NISN ${s.nisn} · Skor ${(s.embedding_quality_score || 0).toFixed(3)}`,
                    }
                  : null;
                const primaryHit = dayHitLogs[0];

                return (
                  <tr key={s.id} className="hover:bg-slate-50">
                    <td className="py-2 pr-3">
                      <div className="flex items-center gap-1.5">
                        {s.foto_ref && (
                          <button
                            type="button"
                            onClick={() =>
                              setLightboxState({
                                title: `Crosscheck Foto Absensi — ${s.nama}`,
                                subtitle: `${kelas?.nama ?? '-'} · Tanggal ${tanggal}`,
                                referenceItem,
                                items: galleryHits,
                                initialIndex: 0,
                              })
                            }
                            aria-label={`Perbesar foto profil ${s.nama}`}
                            className="relative rounded overflow-hidden border border-slate-200 hover:border-blue-500 shrink-0"
                          >
                            <img
                              src={s.foto_ref}
                              alt={s.nama}
                              referrerPolicy="no-referrer"
                              className="w-10 h-10 object-cover bg-slate-100"
                            />
                          </button>
                        )}
                        {primaryHit?.snapshot_path && (
                          <button
                            type="button"
                            onClick={() =>
                              setLightboxState({
                                title: `Crosscheck Foto Absensi — ${s.nama}`,
                                subtitle: `${kelas?.nama ?? '-'} · ${dayHitLogs.length} hit kamera pada ${tanggal}`,
                                referenceItem,
                                items: galleryHits,
                                initialIndex: 0,
                              })
                            }
                            aria-label={`Lihat ${dayHitLogs.length} foto hit kamera ${s.nama}`}
                            className="group relative rounded overflow-hidden border border-emerald-300 hover:border-blue-600 shrink-0"
                          >
                            <img
                              src={primaryHit.snapshot_path}
                              alt={`Hit kamera ${s.nama}`}
                              referrerPolicy="no-referrer"
                              className="w-10 h-10 object-cover bg-slate-100"
                            />
                            <span className="absolute bottom-0 inset-x-0 bg-emerald-800/85 text-white text-[9px] font-mono text-center">
                              {typeof primaryHit.similarity_score === 'number'
                                ? `${Math.round(primaryHit.similarity_score * 100)}%`
                                : `${dayHitLogs.length}x`}
                            </span>
                          </button>
                        )}
                        {galleryHits.length > 0 && (
                          <button
                            type="button"
                            onClick={() =>
                              setLightboxState({
                                title: `Crosscheck Foto Absensi — ${s.nama}`,
                                subtitle: `${kelas?.nama ?? '-'} · Tanggal ${tanggal}`,
                                referenceItem,
                                items: galleryHits,
                                initialIndex: 0,
                              })
                            }
                            aria-label={`Buka crosscheck foto ${s.nama}`}
                            className="p-1 text-blue-700 hover:bg-blue-50 rounded"
                            title="Perbesar & Crosscheck"
                          >
                            <ZoomIn className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                    </td>
                    <td className="py-2.5 font-mono tabular-nums text-slate-600">{s.nisn}</td>
                    <td className="py-2.5 font-medium text-slate-900">{s.nama}</td>
                    <td className="py-2.5 text-slate-600">{kelas?.nama ?? '-'}</td>
                    <td className="py-2.5 font-mono tabular-nums text-slate-700">{rec?.jam_masuk ?? '-'}</td>
                    <td className="py-2.5 font-mono tabular-nums text-slate-700">{rec?.jam_keluar ?? '-'}</td>
                    <td className="py-2.5">
                      <div className={`font-semibold ${statusColor(currentStatus)}`}>{currentStatus}</div>
                      {rec?.catatan && <div className="text-[11px] text-slate-500 mt-0.5">{rec.catatan}</div>}
                    </td>
                    {canManageIzinSakit && (
                      <td className="py-2.5 text-right">
                        <div className="inline-flex items-center gap-1.5">
                          <select
                            aria-label={`Override status ${s.nama}`}
                            value={draftVal}
                            onChange={(e) =>
                              setOverrideDraft((prev) => ({ ...prev, [s.id]: e.target.value as AttendanceStatus }))
                            }
                            className="border border-slate-300 rounded px-2 py-1 text-xs bg-white"
                          >
                            <option value="HADIR">HADIR</option>
                            <option value="TERLAMBAT">TERLAMBAT</option>
                            <option value="ALPA">ALPA</option>
                            <option value="TIDAK_KELUAR">TIDAK_KELUAR</option>
                            <option value="IZIN">IZIN</option>
                            <option value="SAKIT">SAKIT</option>
                          </select>
                          <button
                            type="button"
                            onClick={() => onOverrideStatus(s.id, tanggal, draftVal)}
                            className="px-2.5 py-1 text-xs font-medium text-white bg-slate-800 hover:bg-slate-900 rounded transition-colors"
                          >
                            Simpan
                          </button>
                        </div>
                      </td>
                    )}
                  </tr>
                );
              })}
              {filteredStudents.length === 0 && (
                <tr>
                  <td colSpan={canManageIzinSakit ? 8 : 7} className="py-6 text-center text-slate-500">
                    Tidak ada siswa yang sesuai filter.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
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
