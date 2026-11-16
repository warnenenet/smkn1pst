import React, { useState } from 'react';
import type { AppDatabase, ExceptionScope, ExceptionType } from '../types';

interface SchedulesViewProps {
  db: AppDatabase;
  onAddSchedule: (payload: {
    jurusan_id: number | null;
    hari: number;
    jam_masuk_mulai: string;
    jam_masuk_selesai: string;
    jam_keluar_mulai: string;
    jam_keluar_selesai: string;
    toleransi_terlambat_menit: number;
  }) => Promise<void>;
  onAddOverride: (payload: {
    kelas_id: number;
    hari: number;
    jam_masuk_mulai: string;
    jam_masuk_selesai: string;
    jam_keluar_mulai: string;
    jam_keluar_selesai: string;
    alasan: string;
  }) => Promise<void>;
  onAddException: (payload: {
    tanggal: string;
    scope: ExceptionScope;
    ref_id: number | null;
    tipe: ExceptionType;
    catatan: string;
  }) => Promise<void>;
}

const HARI_LABELS: Record<number, string> = {
  1: 'Senin',
  2: 'Selasa',
  3: 'Rabu',
  4: 'Kamis',
  5: 'Jumat',
  6: 'Sabtu',
  7: 'Minggu',
};

export const SchedulesView: React.FC<SchedulesViewProps> = ({
  db,
  onAddSchedule,
  onAddOverride,
  onAddException,
}) => {
  const [jurId, setJurId] = useState('');
  const [hari, setHari] = useState('1');
  const [masukMulai, setMasukMulai] = useState('06:00:00');
  const [masukSelesai, setMasukSelesai] = useState('07:15:00');
  const [keluarMulai, setKeluarMulai] = useState('15:00:00');
  const [keluarSelesai, setKeluarSelesai] = useState('17:00:00');
  const [toleransi, setToleransi] = useState('5');

  const [ovKelasId, setOvKelasId] = useState(String(db.kelas[0]?.id ?? 1));
  const [ovHari, setOvHari] = useState('1');
  const [ovMasuk1, setOvMasuk1] = useState('12:00:00');
  const [ovMasuk2, setOvMasuk2] = useState('13:00:00');
  const [ovKeluar1, setOvKeluar1] = useState('17:00:00');
  const [ovKeluar2, setOvKeluar2] = useState('18:00:00');
  const [ovAlasan, setOvAlasan] = useState('');

  const [exTanggal, setExTanggal] = useState(new Date().toISOString().slice(0, 10));
  const [exScope, setExScope] = useState<ExceptionScope>('GLOBAL');
  const [exRefId, setExRefId] = useState('');
  const [exTipe, setExTipe] = useState<ExceptionType>('LIBUR');
  const [exCatatan, setExCatatan] = useState('');

  return (
    <div className="space-y-6">
      <section className="bg-white border border-slate-200 rounded-lg p-5">
        <h2 className="text-sm font-semibold text-slate-900 mb-3">Jadwal Absensi (Global &amp; Per Jurusan)</h2>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            await onAddSchedule({
              jurusan_id: jurId ? Number(jurId) : null,
              hari: Number(hari),
              jam_masuk_mulai: masukMulai,
              jam_masuk_selesai: masukSelesai,
              jam_keluar_mulai: keluarMulai,
              jam_keluar_selesai: keluarSelesai,
              toleransi_terlambat_menit: Number(toleransi),
            });
          }}
          className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-2 mb-4"
        >
          <select value={jurId} onChange={(e) => setJurId(e.target.value)} className="border border-slate-300 rounded px-2 py-1.5 text-xs bg-white">
            <option value="">GLOBAL</option>
            {db.jurusans.map((j) => <option key={j.id} value={j.id}>{j.kode}</option>)}
          </select>
          <select value={hari} onChange={(e) => setHari(e.target.value)} className="border border-slate-300 rounded px-2 py-1.5 text-xs bg-white">
            {Object.entries(HARI_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          <input type="time" step="1" value={masukMulai} onChange={(e) => setMasukMulai(e.target.value)} className="border border-slate-300 rounded px-2 py-1.5 text-xs font-mono" />
          <input type="time" step="1" value={masukSelesai} onChange={(e) => setMasukSelesai(e.target.value)} className="border border-slate-300 rounded px-2 py-1.5 text-xs font-mono" />
          <input type="time" step="1" value={keluarMulai} onChange={(e) => setKeluarMulai(e.target.value)} className="border border-slate-300 rounded px-2 py-1.5 text-xs font-mono" />
          <input type="time" step="1" value={keluarSelesai} onChange={(e) => setKeluarSelesai(e.target.value)} className="border border-slate-300 rounded px-2 py-1.5 text-xs font-mono" />
          <input type="number" min="0" value={toleransi} onChange={(e) => setToleransi(e.target.value)} placeholder="Toleransi" className="border border-slate-300 rounded px-2 py-1.5 text-xs font-mono" />
          <button type="submit" className="py-1.5 text-xs font-semibold text-white bg-blue-700 hover:bg-blue-800 rounded">Tambah</button>
        </form>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-slate-200 text-slate-500">
                <th className="py-2 font-medium">Scope</th>
                <th className="py-2 font-medium">Hari</th>
                <th className="py-2 font-medium">Jendela Masuk</th>
                <th className="py-2 font-medium">Jendela Keluar</th>
                <th className="py-2 font-medium text-right">Toleransi</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {db.schedules.map((sc) => {
                const jur = db.jurusans.find((j) => j.id === sc.jurusan_id);
                return (
                  <tr key={sc.id}>
                    <td className="py-2 font-medium text-slate-900">{jur ? jur.kode : 'GLOBAL'}</td>
                    <td className="py-2 text-slate-600">{HARI_LABELS[sc.hari] ?? sc.hari}</td>
                    <td className="py-2 font-mono tabular-nums">{sc.jam_masuk_mulai} – {sc.jam_masuk_selesai}</td>
                    <td className="py-2 font-mono tabular-nums">{sc.jam_keluar_mulai} – {sc.jam_keluar_selesai}</td>
                    <td className="py-2 text-right font-mono tabular-nums">{sc.toleransi_terlambat_menit} mnt</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <section className="bg-white border border-slate-200 rounded-lg p-5">
          <h2 className="text-sm font-semibold text-slate-900 mb-3">Override Jadwal Per Kelas (Shift Pagi / Siang)</h2>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              await onAddOverride({
                kelas_id: Number(ovKelasId),
                hari: Number(ovHari),
                jam_masuk_mulai: ovMasuk1,
                jam_masuk_selesai: ovMasuk2,
                jam_keluar_mulai: ovKeluar1,
                jam_keluar_selesai: ovKeluar2,
                alasan: ovAlasan,
              });
              setOvAlasan('');
            }}
            className="grid grid-cols-2 gap-2 mb-4"
          >
            <select value={ovKelasId} onChange={(e) => setOvKelasId(e.target.value)} className="border border-slate-300 rounded px-2 py-1.5 text-xs bg-white">
              {db.kelas.map((k) => <option key={k.id} value={k.id}>{k.nama} ({k.shift})</option>)}
            </select>
            <select value={ovHari} onChange={(e) => setOvHari(e.target.value)} className="border border-slate-300 rounded px-2 py-1.5 text-xs bg-white">
              {Object.entries(HARI_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
            <input type="time" step="1" value={ovMasuk1} onChange={(e) => setOvMasuk1(e.target.value)} className="border border-slate-300 rounded px-2 py-1.5 text-xs font-mono" />
            <input type="time" step="1" value={ovMasuk2} onChange={(e) => setOvMasuk2(e.target.value)} className="border border-slate-300 rounded px-2 py-1.5 text-xs font-mono" />
            <input type="time" step="1" value={ovKeluar1} onChange={(e) => setOvKeluar1(e.target.value)} className="border border-slate-300 rounded px-2 py-1.5 text-xs font-mono" />
            <input type="time" step="1" value={ovKeluar2} onChange={(e) => setOvKeluar2(e.target.value)} className="border border-slate-300 rounded px-2 py-1.5 text-xs font-mono" />
            <input placeholder="Alasan Override" value={ovAlasan} onChange={(e) => setOvAlasan(e.target.value)} className="border border-slate-300 rounded px-2 py-1.5 text-xs col-span-2" />
            <button type="submit" className="col-span-2 py-2 text-xs font-semibold text-white bg-blue-700 hover:bg-blue-800 rounded">Simpan Override Kelas</button>
          </form>
          <ul className="divide-y divide-slate-100 text-xs">
            {db.kelas_overrides.map((o) => {
              const k = db.kelas.find((kl) => kl.id === o.kelas_id);
              return (
                <li key={o.id} className="py-2 flex justify-between">
                  <span><strong>{k?.nama}</strong> ({HARI_LABELS[o.hari]}) · {o.alasan}</span>
                  <span className="font-mono text-slate-600">{o.jam_masuk_mulai}–{o.jam_keluar_selesai}</span>
                </li>
              );
            })}
          </ul>
        </section>

        <section className="bg-white border border-slate-200 rounded-lg p-5">
          <h2 className="text-sm font-semibold text-slate-900 mb-3">Exception Tanggal (Libur, Pulang Cepat, Ekskul)</h2>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              await onAddException({
                tanggal: exTanggal,
                scope: exScope,
                ref_id: exScope === 'JURUSAN' && exRefId ? Number(exRefId) : null,
                tipe: exTipe,
                catatan: exCatatan,
              });
              setExCatatan('');
            }}
            className="grid grid-cols-2 gap-2 mb-4"
          >
            <input type="date" required value={exTanggal} onChange={(e) => setExTanggal(e.target.value)} className="border border-slate-300 rounded px-2 py-1.5 text-xs font-mono" />
            <select value={exTipe} onChange={(e) => setExTipe(e.target.value as ExceptionType)} className="border border-slate-300 rounded px-2 py-1.5 text-xs bg-white">
              <option value="LIBUR">LIBUR (Bebas Alpa)</option>
              <option value="PULANG_CEPAT">PULANG_CEPAT</option>
              <option value="EKSUKUL">EKSUKUL</option>
              <option value="SHIFT_SWAP">SHIFT_SWAP</option>
            </select>
            <select value={exScope} onChange={(e) => setExScope(e.target.value as ExceptionScope)} className="border border-slate-300 rounded px-2 py-1.5 text-xs bg-white">
              <option value="GLOBAL">GLOBAL</option>
              <option value="JURUSAN">JURUSAN</option>
            </select>
            <select value={exRefId} onChange={(e) => setExRefId(e.target.value)} disabled={exScope !== 'JURUSAN'} className="border border-slate-300 rounded px-2 py-1.5 text-xs bg-white disabled:bg-slate-100">
              <option value="">-- Pilih Jurusan --</option>
              {db.jurusans.map((j) => <option key={j.id} value={j.id}>{j.kode}</option>)}
            </select>
            <input placeholder="Catatan (mis. Hari Guru)" value={exCatatan} onChange={(e) => setExCatatan(e.target.value)} className="border border-slate-300 rounded px-2 py-1.5 text-xs col-span-2" />
            <button type="submit" className="col-span-2 py-2 text-xs font-semibold text-white bg-blue-700 hover:bg-blue-800 rounded">Simpan Exception</button>
          </form>
          <ul className="divide-y divide-slate-100 text-xs">
            {db.schedule_exceptions.map((ex) => (
              <li key={ex.id} className="py-2 flex justify-between">
                <span><strong className="font-mono">{ex.tanggal}</strong> · {ex.tipe} ({ex.scope})</span>
                <span className="text-slate-500">{ex.catatan}</span>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
};
