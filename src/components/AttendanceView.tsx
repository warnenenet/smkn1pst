import React, { useState } from 'react';
import { ScanEye, FileText } from 'lucide-react';
import type { AppDatabase, AttendanceStatus, UserRole } from '../types';

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
  const today = new Date().toISOString().slice(0, 10);
  const [tanggal, setTanggal] = useState(today);
  const [jurusanId, setJurusanId] = useState('');
  const [kelasId, setKelasId] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const pageSize = 50;
  const [overrideDraft, setOverrideDraft] = useState<Record<number, AttendanceStatus>>({});

  // Quick Input Izin / Sakit Khusus Guru BK
  const [bkStudentId, setBkStudentId] = useState(String(db.students[0]?.id ?? ''));
  const [bkStatus, setBkStatus] = useState<'SAKIT' | 'IZIN'>('SAKIT');
  const [bkCatatan, setBkCatatan] = useState('');

  // Simulator Camera Event
  const [simCameraId, setSimCameraId] = useState(String(db.cameras[0]?.id ?? 1));
  const [simTarget, setSimTarget] = useState(String(db.students[0]?.id ?? 1));
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
              <select
                id="sim-target"
                value={simTarget}
                onChange={(e) => setSimTarget(e.target.value)}
                className="w-full border border-slate-300 rounded-md px-2.5 py-2 text-xs bg-white"
              >
                {(filteredStudents.length > 0 ? filteredStudents : db.students).slice(0, 100).map((s) => (
                  <option key={s.id} value={s.id}>{s.nama} ({s.nisn})</option>
                ))}
                <option value="ANONIM">Wajah Anonim (Tak Dikenal)</option>
              </select>
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
              <label htmlFor="bk-student" className="block text-xs text-slate-600 mb-1">Siswa</label>
              <select
                id="bk-student"
                value={bkStudentId}
                onChange={(e) => setBkStudentId(e.target.value)}
                className="w-full border border-slate-300 rounded-md px-2.5 py-2 text-xs bg-white"
              >
                {db.students.slice(0, 200).map((s) => (
                  <option key={s.id} value={s.id}>{s.nama} ({s.nisn})</option>
                ))}
              </select>
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
              className="px-4 py-2 text-xs font-semibold text-white bg-amber-700 hover:bg-amber-800 rounded-md transition-colors whitespace-nowrap"
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
              onChange={(e) => setJurusanId(e.target.value)}
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
              onChange={(e) => setKelasId(e.target.value)}
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
              onChange={(e) => setSearch(e.target.value)}
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
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-slate-200 text-slate-500">
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
                return (
                  <tr key={s.id} className="hover:bg-slate-50">
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
                  <td colSpan={canManageIzinSakit ? 7 : 6} className="py-6 text-center text-slate-500">
                    Tidak ada siswa yang sesuai filter.
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
