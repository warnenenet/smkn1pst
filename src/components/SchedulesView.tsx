import React, { useState } from 'react';
import { Pencil, Trash2, X } from 'lucide-react';
import type {
  AppDatabase,
  ExceptionScope,
  ExceptionType,
  KelasScheduleOverride,
  Schedule,
  ScheduleException,
} from '../types';

export interface SchedulePayload {
  jurusan_id: number | null;
  hari: number;
  jam_masuk_mulai: string;
  jam_masuk_selesai: string;
  jam_keluar_mulai: string;
  jam_keluar_selesai: string;
  toleransi_terlambat_menit: number;
}

export interface OverridePayload {
  kelas_id: number;
  hari: number;
  jam_masuk_mulai: string;
  jam_masuk_selesai: string;
  jam_keluar_mulai: string;
  jam_keluar_selesai: string;
  alasan: string;
}

export interface ExceptionPayload {
  tanggal: string;
  scope: ExceptionScope;
  ref_id: number | null;
  tipe: ExceptionType;
  catatan: string;
  jam_masuk_override?: string | null;
  jam_keluar_override?: string | null;
}

interface SchedulesViewProps {
  db: AppDatabase;
  onAddSchedule: (payload: SchedulePayload) => Promise<void>;
  onUpdateSchedule: (id: number, payload: SchedulePayload) => Promise<void>;
  onDeleteSchedule: (id: number) => Promise<void>;
  onAddOverride: (payload: OverridePayload) => Promise<void>;
  onUpdateOverride: (id: number, payload: OverridePayload) => Promise<void>;
  onDeleteOverride: (id: number) => Promise<void>;
  onAddException: (payload: ExceptionPayload) => Promise<void>;
  onUpdateException: (id: number, payload: ExceptionPayload) => Promise<void>;
  onDeleteException: (id: number) => Promise<void>;
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
  onUpdateSchedule,
  onDeleteSchedule,
  onAddOverride,
  onUpdateOverride,
  onDeleteOverride,
  onAddException,
  onUpdateException,
  onDeleteException,
}) => {
  // Schedule form & edit state
  const [editingScheduleId, setEditingScheduleId] = useState<number | null>(null);
  const [confirmDeleteScheduleId, setConfirmDeleteScheduleId] = useState<number | null>(null);
  const [jurId, setJurId] = useState('');
  const [hari, setHari] = useState('1');
  const [masukMulai, setMasukMulai] = useState('06:00:00');
  const [masukSelesai, setMasukSelesai] = useState('07:15:00');
  const [keluarMulai, setKeluarMulai] = useState('15:00:00');
  const [keluarSelesai, setKeluarSelesai] = useState('17:00:00');
  const [toleransi, setToleransi] = useState('5');

  // Override form & edit state
  const [editingOverrideId, setEditingOverrideId] = useState<number | null>(null);
  const [confirmDeleteOverrideId, setConfirmDeleteOverrideId] = useState<number | null>(null);
  const [ovKelasId, setOvKelasId] = useState(String(db.kelas[0]?.id ?? 1));
  const [ovHari, setOvHari] = useState('1');
  const [ovMasuk1, setOvMasuk1] = useState('12:00:00');
  const [ovMasuk2, setOvMasuk2] = useState('13:00:00');
  const [ovKeluar1, setOvKeluar1] = useState('17:00:00');
  const [ovKeluar2, setOvKeluar2] = useState('18:00:00');
  const [ovAlasan, setOvAlasan] = useState('');

  // Exception form & edit state
  const [editingExceptionId, setEditingExceptionId] = useState<number | null>(null);
  const [confirmDeleteExceptionId, setConfirmDeleteExceptionId] = useState<number | null>(null);
  const [exTanggal, setExTanggal] = useState(new Date().toISOString().slice(0, 10));
  const [exScope, setExScope] = useState<ExceptionScope>('GLOBAL');
  const [exRefId, setExRefId] = useState('');
  const [exTipe, setExTipe] = useState<ExceptionType>('LIBUR');
  const [exCatatan, setExCatatan] = useState('');
  const [exMasukOverride, setExMasukOverride] = useState('');
  const [exKeluarOverride, setExKeluarOverride] = useState('');

  const resetScheduleForm = () => {
    setEditingScheduleId(null);
    setJurId('');
    setHari('1');
    setMasukMulai('06:00:00');
    setMasukSelesai('07:15:00');
    setKeluarMulai('15:00:00');
    setKeluarSelesai('17:00:00');
    setToleransi('5');
  };

  const startEditSchedule = (sc: Schedule) => {
    setEditingScheduleId(sc.id);
    setConfirmDeleteScheduleId(null);
    setJurId(sc.jurusan_id ? String(sc.jurusan_id) : '');
    setHari(String(sc.hari));
    setMasukMulai(sc.jam_masuk_mulai);
    setMasukSelesai(sc.jam_masuk_selesai);
    setKeluarMulai(sc.jam_keluar_mulai);
    setKeluarSelesai(sc.jam_keluar_selesai);
    setToleransi(String(sc.toleransi_terlambat_menit));
  };

  const resetOverrideForm = () => {
    setEditingOverrideId(null);
    setOvKelasId(String(db.kelas[0]?.id ?? 1));
    setOvHari('1');
    setOvMasuk1('12:00:00');
    setOvMasuk2('13:00:00');
    setOvKeluar1('17:00:00');
    setOvKeluar2('18:00:00');
    setOvAlasan('');
  };

  const startEditOverride = (o: KelasScheduleOverride) => {
    setEditingOverrideId(o.id);
    setConfirmDeleteOverrideId(null);
    setOvKelasId(String(o.kelas_id));
    setOvHari(String(o.hari));
    setOvMasuk1(o.jam_masuk_mulai);
    setOvMasuk2(o.jam_masuk_selesai);
    setOvKeluar1(o.jam_keluar_mulai);
    setOvKeluar2(o.jam_keluar_selesai);
    setOvAlasan(o.alasan);
  };

  const resetExceptionForm = () => {
    setEditingExceptionId(null);
    setExTanggal(new Date().toISOString().slice(0, 10));
    setExScope('GLOBAL');
    setExRefId('');
    setExTipe('LIBUR');
    setExCatatan('');
    setExMasukOverride('');
    setExKeluarOverride('');
  };

  const startEditException = (ex: ScheduleException) => {
    setEditingExceptionId(ex.id);
    setConfirmDeleteExceptionId(null);
    setExTanggal(ex.tanggal);
    setExScope(ex.scope);
    setExRefId(ex.ref_id ? String(ex.ref_id) : '');
    setExTipe(ex.tipe);
    setExCatatan(ex.catatan);
    setExMasukOverride(ex.jam_masuk_override ?? '');
    setExKeluarOverride(ex.jam_keluar_override ?? '');
  };

  return (
    <div className="space-y-6">
      <section className="bg-white border border-slate-200 rounded-lg p-5">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
          <h2 className="text-sm font-semibold text-slate-900">
            Jadwal Absensi (Global &amp; Per Jurusan)
          </h2>
          {editingScheduleId !== null && (
            <div className="inline-flex items-center gap-2 px-2.5 py-1 bg-amber-50 border border-amber-200 rounded text-xs text-amber-800">
              <span>Mengedit Jadwal #{editingScheduleId}</span>
              <button
                type="button"
                onClick={resetScheduleForm}
                className="inline-flex items-center gap-0.5 font-semibold hover:underline"
              >
                <X className="w-3 h-3" /> Batal
              </button>
            </div>
          )}
        </div>

        <form
          onSubmit={async (e) => {
            e.preventDefault();
            const payload: SchedulePayload = {
              jurusan_id: jurId ? Number(jurId) : null,
              hari: Number(hari),
              jam_masuk_mulai: masukMulai,
              jam_masuk_selesai: masukSelesai,
              jam_keluar_mulai: keluarMulai,
              jam_keluar_selesai: keluarSelesai,
              toleransi_terlambat_menit: Number(toleransi),
            };
            if (editingScheduleId !== null) {
              await onUpdateSchedule(editingScheduleId, payload);
              resetScheduleForm();
            } else {
              await onAddSchedule(payload);
            }
          }}
          className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-2 mb-4"
        >
          <select
            aria-label="Scope Jadwal"
            value={jurId}
            onChange={(e) => setJurId(e.target.value)}
            className="border border-slate-300 rounded px-2 py-1.5 text-xs bg-white"
          >
            <option value="">GLOBAL</option>
            {db.jurusans.map((j) => (
              <option key={j.id} value={j.id}>
                {j.kode}
              </option>
            ))}
          </select>
          <select
            aria-label="Hari Jadwal"
            value={hari}
            onChange={(e) => setHari(e.target.value)}
            className="border border-slate-300 rounded px-2 py-1.5 text-xs bg-white"
          >
            {Object.entries(HARI_LABELS).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
          <input
            aria-label="Jam Masuk Mulai"
            type="time"
            step="1"
            value={masukMulai}
            onChange={(e) => setMasukMulai(e.target.value)}
            className="border border-slate-300 rounded px-2 py-1.5 text-xs font-mono"
          />
          <input
            aria-label="Jam Masuk Selesai"
            type="time"
            step="1"
            value={masukSelesai}
            onChange={(e) => setMasukSelesai(e.target.value)}
            className="border border-slate-300 rounded px-2 py-1.5 text-xs font-mono"
          />
          <input
            aria-label="Jam Keluar Mulai"
            type="time"
            step="1"
            value={keluarMulai}
            onChange={(e) => setKeluarMulai(e.target.value)}
            className="border border-slate-300 rounded px-2 py-1.5 text-xs font-mono"
          />
          <input
            aria-label="Jam Keluar Selesai"
            type="time"
            step="1"
            value={keluarSelesai}
            onChange={(e) => setKeluarSelesai(e.target.value)}
            className="border border-slate-300 rounded px-2 py-1.5 text-xs font-mono"
          />
          <input
            aria-label="Toleransi Terlambat Menit"
            type="number"
            min="0"
            value={toleransi}
            onChange={(e) => setToleransi(e.target.value)}
            placeholder="Toleransi (mnt)"
            className="border border-slate-300 rounded px-2 py-1.5 text-xs font-mono"
          />
          <button
            type="submit"
            className={`py-1.5 text-xs font-semibold text-white rounded ${
              editingScheduleId !== null ? 'bg-amber-600 hover:bg-amber-700' : 'bg-blue-700 hover:bg-blue-800'
            }`}
          >
            {editingScheduleId !== null ? 'Simpan Edit' : 'Tambah'}
          </button>
        </form>

        <div tabIndex={0} role="region" aria-label="Daftar Jadwal Masuk dan Pulang" className="table-wrapper">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-slate-200 text-slate-500">
                <th className="py-2 font-medium">Scope</th>
                <th className="py-2 font-medium">Hari</th>
                <th className="py-2 font-medium">Jendela Masuk</th>
                <th className="py-2 font-medium">Jendela Keluar</th>
                <th className="py-2 font-medium text-right">Toleransi</th>
                <th className="py-2 font-medium text-right">Aksi</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {db.schedules.map((sc) => {
                const jur = db.jurusans.find((j) => j.id === sc.jurusan_id);
                const isEditing = editingScheduleId === sc.id;
                const isConfirmDel = confirmDeleteScheduleId === sc.id;
                return (
                  <tr key={sc.id} className={isEditing ? 'bg-amber-50/70' : undefined}>
                    <td className="py-2 font-medium text-slate-900">{jur ? jur.kode : 'GLOBAL'}</td>
                    <td className="py-2 text-slate-600">{HARI_LABELS[sc.hari] ?? sc.hari}</td>
                    <td className="py-2 font-mono tabular-nums">
                      {sc.jam_masuk_mulai} – {sc.jam_masuk_selesai}
                    </td>
                    <td className="py-2 font-mono tabular-nums">
                      {sc.jam_keluar_mulai} – {sc.jam_keluar_selesai}
                    </td>
                    <td className="py-2 text-right font-mono tabular-nums">{sc.toleransi_terlambat_menit} mnt</td>
                    <td className="py-2 text-right whitespace-nowrap space-x-1">
                      <button
                        type="button"
                        onClick={() => startEditSchedule(sc)}
                        aria-label={`Edit jadwal ${jur ? jur.kode : 'GLOBAL'} ${HARI_LABELS[sc.hari] ?? sc.hari}`}
                        className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-blue-700 border border-blue-200 bg-blue-50 hover:bg-blue-100 rounded"
                      >
                        <Pencil className="w-3 h-3" /> Edit
                      </button>
                      {isConfirmDel ? (
                        <span className="inline-flex items-center gap-1">
                          <button
                            type="button"
                            onClick={async () => {
                              await onDeleteSchedule(sc.id);
                              setConfirmDeleteScheduleId(null);
                              if (editingScheduleId === sc.id) resetScheduleForm();
                            }}
                            className="px-2 py-1 text-xs font-semibold text-white bg-red-600 hover:bg-red-700 rounded"
                          >
                            Hapus?
                          </button>
                          <button
                            type="button"
                            onClick={() => setConfirmDeleteScheduleId(null)}
                            className="px-1.5 py-1 text-xs text-slate-600 border border-slate-200 rounded"
                          >
                            Batal
                          </button>
                        </span>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setConfirmDeleteScheduleId(sc.id)}
                          aria-label={`Hapus jadwal ${jur ? jur.kode : 'GLOBAL'} ${HARI_LABELS[sc.hari] ?? sc.hari}`}
                          className="p-1 text-slate-400 hover:text-red-600 align-middle"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
              {db.schedules.length === 0 && (
                <tr>
                  <td colSpan={6} className="py-4 text-center text-slate-500">
                    Belum ada jadwal absensi tersimpan.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <section className="bg-white border border-slate-200 rounded-lg p-5">
          <div className="flex items-center justify-between gap-2 mb-3">
            <h2 className="text-sm font-semibold text-slate-900">Override Jadwal Per Kelas (Shift Pagi / Siang)</h2>
            {editingOverrideId !== null && (
              <button
                type="button"
                onClick={resetOverrideForm}
                className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium text-amber-800 bg-amber-50 border border-amber-200 rounded"
              >
                <X className="w-3 h-3" /> Batal Edit
              </button>
            )}
          </div>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              const payload: OverridePayload = {
                kelas_id: Number(ovKelasId),
                hari: Number(ovHari),
                jam_masuk_mulai: ovMasuk1,
                jam_masuk_selesai: ovMasuk2,
                jam_keluar_mulai: ovKeluar1,
                jam_keluar_selesai: ovKeluar2,
                alasan: ovAlasan,
              };
              if (editingOverrideId !== null) {
                await onUpdateOverride(editingOverrideId, payload);
              } else {
                await onAddOverride(payload);
              }
              resetOverrideForm();
            }}
            className="grid grid-cols-2 gap-2 mb-4"
          >
            <select
              aria-label="Kelas Override"
              value={ovKelasId}
              onChange={(e) => setOvKelasId(e.target.value)}
              className="border border-slate-300 rounded px-2 py-1.5 text-xs bg-white"
            >
              {db.kelas.map((k) => (
                <option key={k.id} value={k.id}>
                  {k.nama} ({k.shift})
                </option>
              ))}
            </select>
            <select
              aria-label="Hari Override"
              value={ovHari}
              onChange={(e) => setOvHari(e.target.value)}
              className="border border-slate-300 rounded px-2 py-1.5 text-xs bg-white"
            >
              {Object.entries(HARI_LABELS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
            <input
              aria-label="Override Masuk Mulai"
              type="time"
              step="1"
              value={ovMasuk1}
              onChange={(e) => setOvMasuk1(e.target.value)}
              className="border border-slate-300 rounded px-2 py-1.5 text-xs font-mono"
            />
            <input
              aria-label="Override Masuk Selesai"
              type="time"
              step="1"
              value={ovMasuk2}
              onChange={(e) => setOvMasuk2(e.target.value)}
              className="border border-slate-300 rounded px-2 py-1.5 text-xs font-mono"
            />
            <input
              aria-label="Override Keluar Mulai"
              type="time"
              step="1"
              value={ovKeluar1}
              onChange={(e) => setOvKeluar1(e.target.value)}
              className="border border-slate-300 rounded px-2 py-1.5 text-xs font-mono"
            />
            <input
              aria-label="Override Keluar Selesai"
              type="time"
              step="1"
              value={ovKeluar2}
              onChange={(e) => setOvKeluar2(e.target.value)}
              className="border border-slate-300 rounded px-2 py-1.5 text-xs font-mono"
            />
            <input
              placeholder="Alasan Override"
              value={ovAlasan}
              onChange={(e) => setOvAlasan(e.target.value)}
              className="border border-slate-300 rounded px-2 py-1.5 text-xs col-span-2"
            />
            <button
              type="submit"
              className={`col-span-2 py-2 text-xs font-semibold text-white rounded ${
                editingOverrideId !== null ? 'bg-amber-600 hover:bg-amber-700' : 'bg-blue-700 hover:bg-blue-800'
              }`}
            >
              {editingOverrideId !== null ? 'Simpan Perubahan Override' : 'Simpan Override Kelas'}
            </button>
          </form>
          <ul className="divide-y divide-slate-100 text-xs">
            {db.kelas_overrides.map((o) => {
              const k = db.kelas.find((kl) => kl.id === o.kelas_id);
              const isConfirmDel = confirmDeleteOverrideId === o.id;
              return (
                <li
                  key={o.id}
                  className={`py-2 flex items-center justify-between gap-2 ${
                    editingOverrideId === o.id ? 'bg-amber-50/70 px-1.5 rounded' : ''
                  }`}
                >
                  <div className="min-w-0">
                    <div>
                      <strong>{k?.nama ?? `Kelas #${o.kelas_id}`}</strong> ({HARI_LABELS[o.hari]}) · {o.alasan || '-'}
                    </div>
                    <div className="font-mono text-[11px] text-slate-500">
                      Masuk {o.jam_masuk_mulai}–{o.jam_masuk_selesai} · Keluar {o.jam_keluar_mulai}–{o.jam_keluar_selesai}
                    </div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      type="button"
                      onClick={() => startEditOverride(o)}
                      className="px-2 py-1 text-xs font-medium text-blue-700 border border-blue-200 bg-blue-50 hover:bg-blue-100 rounded"
                    >
                      Edit
                    </button>
                    {isConfirmDel ? (
                      <>
                        <button
                          type="button"
                          onClick={async () => {
                            await onDeleteOverride(o.id);
                            setConfirmDeleteOverrideId(null);
                            if (editingOverrideId === o.id) resetOverrideForm();
                          }}
                          className="px-2 py-1 text-xs font-semibold text-white bg-red-600 rounded"
                        >
                          Hapus?
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmDeleteOverrideId(null)}
                          className="px-1.5 py-1 text-xs border border-slate-200 rounded"
                        >
                          Batal
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        aria-label={`Hapus override ${k?.nama ?? o.id}`}
                        onClick={() => setConfirmDeleteOverrideId(o.id)}
                        className="p-1 text-slate-400 hover:text-red-600"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
            {db.kelas_overrides.length === 0 && (
              <li className="py-3 text-center text-slate-500">Belum ada override kelas.</li>
            )}
          </ul>
        </section>

        <section className="bg-white border border-slate-200 rounded-lg p-5">
          <div className="flex items-center justify-between gap-2 mb-3">
            <h2 className="text-sm font-semibold text-slate-900">Exception Tanggal (Libur, Pulang Cepat, Ekskul)</h2>
            {editingExceptionId !== null && (
              <button
                type="button"
                onClick={resetExceptionForm}
                className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium text-amber-800 bg-amber-50 border border-amber-200 rounded"
              >
                <X className="w-3 h-3" /> Batal Edit
              </button>
            )}
          </div>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              const payload: ExceptionPayload = {
                tanggal: exTanggal,
                scope: exScope,
                ref_id: exScope === 'JURUSAN' && exRefId ? Number(exRefId) : null,
                tipe: exTipe,
                catatan: exCatatan,
                jam_masuk_override: exMasukOverride.trim() || null,
                jam_keluar_override: exKeluarOverride.trim() || null,
              };
              if (editingExceptionId !== null) {
                await onUpdateException(editingExceptionId, payload);
              } else {
                await onAddException(payload);
              }
              resetExceptionForm();
            }}
            className="grid grid-cols-2 gap-2 mb-4"
          >
            <input
              aria-label="Tanggal Exception"
              type="date"
              required
              value={exTanggal}
              onChange={(e) => setExTanggal(e.target.value)}
              className="border border-slate-300 rounded px-2 py-1.5 text-xs font-mono"
            />
            <select
              aria-label="Tipe Exception"
              value={exTipe}
              onChange={(e) => setExTipe(e.target.value as ExceptionType)}
              className="border border-slate-300 rounded px-2 py-1.5 text-xs bg-white"
            >
              <option value="LIBUR">LIBUR (Bebas Alpa)</option>
              <option value="PULANG_CEPAT">PULANG_CEPAT</option>
              <option value="EKSUKUL">EKSUKUL</option>
              <option value="SHIFT_SWAP">SHIFT_SWAP</option>
            </select>
            <select
              aria-label="Scope Exception"
              value={exScope}
              onChange={(e) => setExScope(e.target.value as ExceptionScope)}
              className="border border-slate-300 rounded px-2 py-1.5 text-xs bg-white"
            >
              <option value="GLOBAL">GLOBAL</option>
              <option value="JURUSAN">JURUSAN</option>
            </select>
            <select
              aria-label="Jurusan Exception"
              value={exRefId}
              onChange={(e) => setExRefId(e.target.value)}
              disabled={exScope !== 'JURUSAN'}
              className="border border-slate-300 rounded px-2 py-1.5 text-xs bg-white disabled:bg-slate-100"
            >
              <option value="">-- Pilih Jurusan --</option>
              {db.jurusans.map((j) => (
                <option key={j.id} value={j.id}>
                  {j.kode}
                </option>
              ))}
            </select>
            <input
              aria-label="Jam Masuk Override (Opsional)"
              type="time"
              step="1"
              value={exMasukOverride}
              onChange={(e) => setExMasukOverride(e.target.value)}
              title="Jam masuk khusus (opsional)"
              className="border border-slate-300 rounded px-2 py-1.5 text-xs font-mono"
            />
            <input
              aria-label="Jam Keluar Override (Opsional)"
              type="time"
              step="1"
              value={exKeluarOverride}
              onChange={(e) => setExKeluarOverride(e.target.value)}
              title="Jam keluar khusus (opsional, mis. Pulang Cepat)"
              className="border border-slate-300 rounded px-2 py-1.5 text-xs font-mono"
            />
            <input
              placeholder="Catatan (mis. Hari Guru / Rapat Pleno)"
              value={exCatatan}
              onChange={(e) => setExCatatan(e.target.value)}
              className="border border-slate-300 rounded px-2 py-1.5 text-xs col-span-2"
            />
            <button
              type="submit"
              className={`col-span-2 py-2 text-xs font-semibold text-white rounded ${
                editingExceptionId !== null ? 'bg-amber-600 hover:bg-amber-700' : 'bg-blue-700 hover:bg-blue-800'
              }`}
            >
              {editingExceptionId !== null ? 'Simpan Perubahan Exception' : 'Simpan Exception'}
            </button>
          </form>
          <ul className="divide-y divide-slate-100 text-xs">
            {db.schedule_exceptions.map((ex) => {
              const jur = ex.scope === 'JURUSAN' ? db.jurusans.find((j) => j.id === ex.ref_id)?.kode : null;
              const isConfirmDel = confirmDeleteExceptionId === ex.id;
              return (
                <li
                  key={ex.id}
                  className={`py-2 flex items-center justify-between gap-2 ${
                    editingExceptionId === ex.id ? 'bg-amber-50/70 px-1.5 rounded' : ''
                  }`}
                >
                  <div className="min-w-0">
                    <div>
                      <strong className="font-mono">{ex.tanggal}</strong> · {ex.tipe} ({jur ? `JURUSAN ${jur}` : ex.scope})
                    </div>
                    <div className="text-slate-500 truncate">
                      {ex.catatan || '-'}
                      {(ex.jam_masuk_override || ex.jam_keluar_override) && (
                        <span className="font-mono ml-1.5 text-slate-600">
                          [{ex.jam_masuk_override ?? '-'} / {ex.jam_keluar_override ?? '-'}]
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      type="button"
                      onClick={() => startEditException(ex)}
                      className="px-2 py-1 text-xs font-medium text-blue-700 border border-blue-200 bg-blue-50 hover:bg-blue-100 rounded"
                    >
                      Edit
                    </button>
                    {isConfirmDel ? (
                      <>
                        <button
                          type="button"
                          onClick={async () => {
                            await onDeleteException(ex.id);
                            setConfirmDeleteExceptionId(null);
                            if (editingExceptionId === ex.id) resetExceptionForm();
                          }}
                          className="px-2 py-1 text-xs font-semibold text-white bg-red-600 rounded"
                        >
                          Hapus?
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmDeleteExceptionId(null)}
                          className="px-1.5 py-1 text-xs border border-slate-200 rounded"
                        >
                          Batal
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        aria-label={`Hapus exception ${ex.tanggal}`}
                        onClick={() => setConfirmDeleteExceptionId(ex.id)}
                        className="p-1 text-slate-400 hover:text-red-600"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
            {db.schedule_exceptions.length === 0 && (
              <li className="py-3 text-center text-slate-500">Belum ada exception tanggal.</li>
            )}
          </ul>
        </section>
      </div>
    </div>
  );
};
