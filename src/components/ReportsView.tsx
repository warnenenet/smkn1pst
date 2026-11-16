import React, { useState } from 'react';
import { Download, Printer } from 'lucide-react';
import { calculateAttendancePercentage } from '../lib/attendanceEngine';
import type { AppDatabase } from '../types';

interface ReportsViewProps {
  db: AppDatabase;
}

export const ReportsView: React.FC<ReportsViewProps> = ({ db }) => {
  const [mode, setMode] = useState<'daily' | 'weekly' | 'monthly'>('monthly');
  const [refDate, setRefDate] = useState(new Date().toISOString().slice(0, 10));
  const [jurusanId, setJurusanId] = useState('');
  const [kelasId, setKelasId] = useState('');
  const [page, setPage] = useState(1);
  const pageSize = 50;

  // Hitung rentang tanggal
  const d = new Date(refDate);
  let start = refDate;
  let end = refDate;
  if (mode === 'weekly') {
    const day = d.getDay() === 0 ? 7 : d.getDay();
    const mon = new Date(d);
    mon.setDate(d.getDate() - (day - 1));
    const sat = new Date(mon);
    sat.setDate(mon.getDate() + 5);
    start = mon.toISOString().slice(0, 10);
    end = sat.toISOString().slice(0, 10);
  } else if (mode === 'monthly') {
    start = `${refDate.slice(0, 7)}-01`;
    end = `${refDate.slice(0, 7)}-31`;
  }

  const rows = db.students
    .filter((s) => {
      const k = db.kelas.find((kl) => kl.id === s.kelas_id);
      if (jurusanId && String(k?.jurusan_id) !== jurusanId) return false;
      if (kelasId && String(s.kelas_id) !== kelasId) return false;
      return true;
    })
    .map((s) => {
      const k = db.kelas.find((kl) => kl.id === s.kelas_id);
      const recs = db.daily_attendance.filter(
        (rec) => rec.student_id === s.id && rec.tanggal >= start && rec.tanggal <= end
      );
      const hadir = recs.filter((r) => r.status === 'HADIR' || r.status === 'TERLAMBAT' || r.status === 'TIDAK_KELUAR').length;
      const terlambat = recs.filter((r) => r.status === 'TERLAMBAT').length;
      const alpa = recs.filter((r) => r.status === 'ALPA').length;
      const izinSakit = recs.filter((r) => r.status === 'IZIN' || r.status === 'SAKIT').length;
      const persen = calculateAttendancePercentage(recs);
      return {
        id: s.id,
        nisn: s.nisn,
        nama: s.nama,
        kelas: k?.nama ?? '-',
        statusSiswa: s.status,
        hadir,
        terlambat,
        alpa,
        izinSakit,
        persen,
      };
    });

  const totalPages = Math.max(1, Math.ceil(rows.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const pagedRows = rows.slice((safePage - 1) * pageSize, safePage * pageSize);

  const csvParams = new URLSearchParams({ start, end });
  if (jurusanId) csvParams.set('jurusan_id', jurusanId);
  if (kelasId) csvParams.set('kelas_id', kelasId);

  return (
    <div className="space-y-6">
      <section className="bg-white border border-slate-200 rounded-lg p-5">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 flex-1">
            <div>
              <label htmlFor="rep-mode" className="block text-xs text-slate-600 mb-1">Periode</label>
              <select
                id="rep-mode"
                value={mode}
                onChange={(e) => {
                  setMode(e.target.value as 'daily' | 'weekly' | 'monthly');
                  setPage(1);
                }}
                className="w-full border border-slate-300 rounded-md px-2.5 py-2 text-xs bg-white"
              >
                <option value="daily">Harian</option>
                <option value="weekly">Mingguan (Senin–Sabtu)</option>
                <option value="monthly">Bulanan</option>
              </select>
            </div>
            <div>
              <label htmlFor="rep-date" className="block text-xs text-slate-600 mb-1">Tanggal Acuan</label>
              <input
                id="rep-date"
                type="date"
                value={refDate}
                onChange={(e) => {
                  setRefDate(e.target.value);
                  setPage(1);
                }}
                className="w-full border border-slate-300 rounded-md px-2.5 py-2 text-xs font-mono"
              />
            </div>
            <div>
              <label htmlFor="rep-jur" className="block text-xs text-slate-600 mb-1">Jurusan</label>
              <select
                id="rep-jur"
                value={jurusanId}
                onChange={(e) => {
                  setJurusanId(e.target.value);
                  setPage(1);
                }}
                className="w-full border border-slate-300 rounded-md px-2.5 py-2 text-xs bg-white"
              >
                <option value="">Semua Jurusan</option>
                {db.jurusans.map((j) => (
                  <option key={j.id} value={j.id}>{j.kode}</option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="rep-kls" className="block text-xs text-slate-600 mb-1">Kelas</label>
              <select
                id="rep-kls"
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
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <a
              href={`/api/reports/csv?${csvParams.toString()}`}
              download="laporan_absensi_smk.csv"
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-white bg-emerald-700 hover:bg-emerald-800 rounded-md transition-colors"
            >
              <Download className="w-3.5 h-3.5" /> Export CSV
            </a>
            <button
              type="button"
              onClick={() => window.print()}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-md transition-colors"
            >
              <Printer className="w-3.5 h-3.5" /> Cetak PDF
            </button>
          </div>
        </div>
      </section>

      <section className="bg-white border border-slate-200 rounded-lg p-5">
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500 mb-3">
          <span>
            Rentang laporan: <span className="font-mono font-semibold text-slate-800">{start}</span> s/d{' '}
            <span className="font-mono font-semibold text-slate-800">{end}</span> ({rows.length} siswa)
          </span>
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
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-slate-200 text-slate-500">
                <th className="py-2.5 font-medium">NISN</th>
                <th className="py-2.5 font-medium">Nama Siswa</th>
                <th className="py-2.5 font-medium">Kelas</th>
                <th className="py-2.5 font-medium text-right">Hadir</th>
                <th className="py-2.5 font-medium text-right">Terlambat</th>
                <th className="py-2.5 font-medium text-right">Alpa</th>
                <th className="py-2.5 font-medium text-right">Izin / Sakit</th>
                <th className="py-2.5 font-medium text-right">Persentase</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {pagedRows.map((r) => (
                <tr key={r.id}>
                  <td className="py-2.5 font-mono tabular-nums text-slate-600">{r.nisn}</td>
                  <td className="py-2.5 font-medium text-slate-900">
                    {r.nama} {r.statusSiswa === 'PKL' ? <span className="text-slate-400">· PKL</span> : null}
                  </td>
                  <td className="py-2.5 text-slate-600">{r.kelas}</td>
                  <td className="py-2.5 text-right font-mono tabular-nums">{r.hadir}</td>
                  <td className="py-2.5 text-right font-mono tabular-nums">{r.terlambat}</td>
                  <td className="py-2.5 text-right font-mono tabular-nums text-red-700">{r.alpa}</td>
                  <td className="py-2.5 text-right font-mono tabular-nums">{r.izinSakit}</td>
                  <td className="py-2.5 text-right font-mono tabular-nums font-semibold text-slate-900">{r.persen}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
};
