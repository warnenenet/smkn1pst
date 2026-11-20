import React, { useState } from 'react';
import { ArrowLeft, LogIn, ShieldCheck } from 'lucide-react';
import type { DailyAttendance } from '../types';

interface GuestPortalViewProps {
  schoolName?: string;
  isAuthenticated?: boolean;
  productionMode?: boolean;
  onBack?: () => void;
  onLoginClick?: () => void;
}

interface GuestResult {
  student: { nama: string; nisn: string; kelas: string; status: string };
  month: string;
  percentage: number;
  records: DailyAttendance[];
}

export const GuestPortalView: React.FC<GuestPortalViewProps> = ({
  schoolName = 'SMK Negeri Unggulan',
  isAuthenticated = false,
  productionMode = false,
  onBack,
  onLoginClick,
}) => {
  const [nisn, setNisn] = useState('');
  const [tanggalLahir, setTanggalLahir] = useState('');
  const [month, setMonth] = useState(new Date().toISOString().slice(0, 7));
  const [captchaNums, setCaptchaNums] = useState(() => ({
    a: Math.floor(Math.random() * 8) + 2,
    b: Math.floor(Math.random() * 8) + 1,
  }));
  const [captchaAns, setCaptchaAns] = useState('');
  const [error, setError] = useState('');
  const [result, setResult] = useState<GuestResult | null>(null);

  const regenCaptcha = () => {
    setCaptchaNums({
      a: Math.floor(Math.random() * 8) + 2,
      b: Math.floor(Math.random() * 8) + 1,
    });
    setCaptchaAns('');
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    const res = await fetch('/api/guest/lookup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        nisn,
        tanggal_lahir: tanggalLahir,
        month,
        captchaAnswer: Number(captchaAns),
        captchaExpected: captchaNums.a + captchaNums.b,
      }),
    });
    const data = await res.json();
    regenCaptcha();
    if (!res.ok) {
      setResult(null);
      setError(data.error || 'Gagal mencari data absensi.');
      return;
    }
    setResult(data);
  };

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col">
      <header className="bg-white border-b border-slate-200 px-6 py-3.5">
        <div className="max-w-4xl mx-auto flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-md bg-blue-700 text-white flex items-center justify-center">
              <ShieldCheck className="w-4 h-4" />
            </div>
            <div>
              <div className="text-sm font-bold text-slate-900">{schoolName}</div>
              <div className="text-xs text-slate-500">Portal Cek Kehadiran Siswa — Orang Tua &amp; Wali (<code className="font-mono">/ortu</code>)</div>
            </div>
          </div>

          <div className="flex items-center gap-3">
            {isAuthenticated && onBack ? (
              <button
                type="button"
                onClick={onBack}
                className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold text-white bg-slate-800 hover:bg-slate-900 rounded-md"
              >
                <ArrowLeft className="w-3.5 h-3.5" /> Kembali ke Dashboard
              </button>
            ) : (
              onLoginClick && (
                <button
                  type="button"
                  onClick={onLoginClick}
                  className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold text-white bg-blue-700 hover:bg-blue-800 rounded-md"
                >
                  <LogIn className="w-3.5 h-3.5" /> Login Admin / Guru / BK
                </button>
              )
            )}
          </div>
        </div>
      </header>

      <main className="flex-1 py-8 px-4">
        <div className="max-w-3xl mx-auto space-y-6">
          <section className="bg-white border border-slate-200 rounded-lg p-6">
            <h1 className="text-lg font-bold text-slate-900">Cek Rekap Kehadiran Siswa</h1>
            <p className="text-xs text-slate-500 mt-1 mb-5">
              Masukkan NISN dan tanggal lahir putra/putri Anda untuk memantau kehadiran bulanan secara langsung (read-only). Maks 10 percobaan/jam per IP.
            </p>

            {error && (
              <div className="mb-4 p-3 rounded-md bg-red-50 border border-red-200 text-xs text-red-700 font-medium">
                {error}
              </div>
            )}

            <form onSubmit={handleSubmit} className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="field-group">
                <label htmlFor="guest-nisn" className="block text-xs font-medium text-slate-700 mb-1">NISN Siswa</label>
                <input
                  id="guest-nisn"
                  name="nisn"
                  type="text"
                  inputMode="numeric"
                  required
                  autoComplete="off"
                  enterKeyHint="next"
                  placeholder="Contoh: 0081122001"
                  value={nisn}
                  onChange={(e) => setNisn(e.target.value)}
                  className="w-full border border-slate-300 rounded-md px-3 py-2 text-xs font-mono"
                />
              </div>
              <div className="field-group">
                <label htmlFor="guest-dob" className="block text-xs font-medium text-slate-700 mb-1">Tanggal Lahir</label>
                <input
                  id="guest-dob"
                  name="tanggal_lahir"
                  type="date"
                  required
                  value={tanggalLahir}
                  onChange={(e) => setTanggalLahir(e.target.value)}
                  className="w-full border border-slate-300 rounded-md px-3 py-2 text-xs font-mono"
                />
              </div>
              <div className="field-group">
                <label htmlFor="guest-month" className="block text-xs font-medium text-slate-700 mb-1">Bulan Rekap</label>
                <input
                  id="guest-month"
                  name="month"
                  type="month"
                  value={month}
                  onChange={(e) => setMonth(e.target.value)}
                  className="w-full border border-slate-300 rounded-md px-3 py-2 text-xs font-mono"
                />
              </div>
              <div className="field-group">
                <label htmlFor="guest-captcha" className="block text-xs font-medium text-slate-700 mb-1">
                  Verifikasi: Berapa <strong className="font-mono">{captchaNums.a} + {captchaNums.b}</strong> ?
                </label>
                <input
                  id="guest-captcha"
                  name="captcha"
                  type="number"
                  inputMode="numeric"
                  required
                  enterKeyHint="done"
                  placeholder="Jawaban angka"
                  value={captchaAns}
                  onChange={(e) => setCaptchaAns(e.target.value)}
                  className="w-full border border-slate-300 rounded-md px-3 py-2 text-xs font-mono"
                />
              </div>
              <div className="sm:col-span-2 flex items-center justify-between gap-3 pt-1">
                {!productionMode ? (
                  <button
                    type="button"
                    onClick={() => {
                      setNisn('0081122001');
                      setTanggalLahir('2008-05-14');
                    }}
                    className="text-xs text-blue-700 hover:underline"
                  >
                    Isi Contoh NISN Siswa (Raka)
                  </button>
                ) : (
                  <span className="text-xs text-slate-400">Gunakan NISN resmi terdaftar dari sekolah.</span>
                )}
                <button
                  type="submit"
                  className="px-5 py-2 text-xs font-semibold text-white bg-blue-700 hover:bg-blue-800 rounded-md"
                >
                  Lihat Rekap Kehadiran
                </button>
              </div>
            </form>
          </section>

          {result && (
            <section className="bg-white border border-slate-200 rounded-lg p-6">
              <div className="flex flex-wrap items-center justify-between gap-4 pb-4 border-b border-slate-100">
                <div>
                  <h2 className="text-base font-bold text-slate-900">{result.student.nama}</h2>
                  <div className="text-xs text-slate-500 font-mono">
                    {result.student.kelas} · NISN {result.student.nisn} · Status {result.student.status}
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-xs text-slate-500">Kehadiran Bulan {result.month}</div>
                  <div className="text-2xl font-bold font-mono tabular-nums text-emerald-700">{result.percentage}%</div>
                </div>
              </div>

              <div tabIndex={0} role="region" aria-label="Rekap Kehadiran Bulanan Siswa" className="table-wrapper mt-4">
                <table className="w-full text-left text-xs">
                  <thead>
                    <tr className="border-b border-slate-200 text-slate-500">
                      <th className="py-2 font-medium">Tanggal</th>
                      <th className="py-2 font-medium">Jam Masuk</th>
                      <th className="py-2 font-medium">Jam Keluar</th>
                      <th className="py-2 font-medium text-right">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {result.records.map((r) => (
                      <tr key={r.id}>
                        <td className="py-2 font-mono tabular-nums text-slate-800">{r.tanggal}</td>
                        <td className="py-2 font-mono tabular-nums text-slate-600">{r.jam_masuk ?? '-'}</td>
                        <td className="py-2 font-mono tabular-nums text-slate-600">{r.jam_keluar ?? '-'}</td>
                        <td className="py-2 text-right font-semibold text-slate-900">{r.status}</td>
                      </tr>
                    ))}
                    {result.records.length === 0 && (
                      <tr>
                        <td colSpan={4} className="py-6 text-center text-slate-500">
                          Belum ada catatan absensi pada bulan ini.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </div>
      </main>
    </div>
  );
};
