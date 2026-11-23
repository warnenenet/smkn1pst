import React, { useState } from 'react';
import { ShieldCheck, Eye, EyeOff, Building2, UserPlus } from 'lucide-react';
import type { User } from '../types';

interface SetupWizardViewProps {
  initialSchoolName: string;
  onSuccess: (payload: { user: User; school_name: string }) => void;
}

export const SetupWizardView: React.FC<SetupWizardViewProps> = ({
  initialSchoolName,
  onSuccess,
}) => {
  const [schoolName, setSchoolName] = useState(
    initialSchoolName && initialSchoolName !== 'SMK Negeri Unggulan' ? initialSchoolName : ''
  );
  const [adminName, setAdminName] = useState('');
  const [adminEmail, setAdminEmail] = useState('');
  const [adminPassword, setAdminPassword] = useState('');
  const [adminPasswordConfirm, setAdminPasswordConfirm] = useState('');
  const [showAdminPassword, setShowAdminPassword] = useState(false);

  const [createBk, setCreateBk] = useState(false);
  const [bkName, setBkName] = useState('');
  const [bkEmail, setBkEmail] = useState('');
  const [bkPassword, setBkPassword] = useState('');

  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (schoolName.trim().length < 3) {
      setError('Nama Sekolah wajib diisi minimal 3 karakter.');
      return;
    }
    if (adminPassword.length < 8) {
      setError('Password Administrator wajib minimal 8 karakter.');
      return;
    }
    if (adminPassword !== adminPasswordConfirm) {
      setError('Konfirmasi password Administrator tidak cocok.');
      return;
    }
    if (createBk && bkPassword.length < 8) {
      setError('Password akun Guru BK wajib minimal 8 karakter.');
      return;
    }

    setLoading(true);
    try {
      const res = await fetch('/api/setup/initialize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          school_name: schoolName.trim(),
          admin_name: adminName.trim(),
          admin_email: adminEmail.trim().toLowerCase(),
          admin_password: adminPassword,
          create_bk: createBk,
          bk_name: createBk ? bkName.trim() || 'Guru BK Sekolah' : undefined,
          bk_email: createBk ? bkEmail.trim().toLowerCase() : undefined,
          bk_password: createBk ? bkPassword : undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Setup awal gagal disimpan.');
        return;
      }
      onSuccess({ user: data.user, school_name: data.school_name });
    } catch {
      setError('Gagal terhubung ke server untuk menyimpan konfigurasi setup.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col justify-center py-10 px-4">
      <div className="max-w-lg w-full mx-auto space-y-5">
        <section className="bg-white border border-slate-200 rounded-xl p-6 sm:p-7 shadow-xs">
          <div className="flex items-start gap-3 pb-4 border-b border-slate-100">
            <div className="w-10 h-10 rounded-lg bg-emerald-700 text-white flex items-center justify-center shrink-0">
              <ShieldCheck className="w-5 h-5" />
            </div>
            <div className="min-w-0">
              <h1 className="text-base font-bold text-slate-900">
                Setup Awal Sistem Absensi Sekolah
              </h1>
              <p className="text-xs text-slate-500 mt-0.5">
                Lengkapi nama sekolah dan buat akun Administrator utama Anda (1 kali setup, setelah itu halaman ini otomatis dikunci).
              </p>
            </div>
          </div>

          {error && (
            <div
              role="alert"
              className="mt-4 p-3 rounded-md bg-red-50 border border-red-200 text-xs text-red-700 font-medium"
            >
              {error}
            </div>
          )}

          <form onSubmit={handleSubmit} className="mt-5 space-y-4">
            <div className="field-group">
              <label htmlFor="setup-school-name" className="block text-xs font-medium text-slate-700 mb-1.5">
                <span className="inline-flex items-center gap-1.5">
                  <Building2 className="w-3.5 h-3.5 text-slate-500" />
                  Nama Sekolah
                </span>
              </label>
              <input
                id="setup-school-name"
                name="school_name"
                type="text"
                required
                minLength={3}
                maxLength={120}
                placeholder="Contoh: SMK Negeri 1 Percut Sei Tuan"
                value={schoolName}
                onChange={(e) => setSchoolName(e.target.value)}
                className="w-full border border-slate-300 rounded-md px-3 py-2 text-xs bg-white focus:border-blue-700 focus:outline-2 focus:outline-blue-600/20"
              />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="field-group">
                <label htmlFor="setup-admin-name" className="block text-xs font-medium text-slate-700 mb-1.5">
                  Nama Administrator
                </label>
                <input
                  id="setup-admin-name"
                  name="admin_name"
                  type="text"
                  required
                  minLength={2}
                  maxLength={80}
                  autoComplete="name"
                  placeholder="Nama Lengkap Admin IT"
                  value={adminName}
                  onChange={(e) => setAdminName(e.target.value)}
                  className="w-full border border-slate-300 rounded-md px-3 py-2 text-xs bg-white focus:border-blue-700 focus:outline-2 focus:outline-blue-600/20"
                />
              </div>

              <div className="field-group">
                <label htmlFor="setup-admin-email" className="block text-xs font-medium text-slate-700 mb-1.5">
                  Email Login Administrator
                </label>
                <input
                  id="setup-admin-email"
                  name="admin_email"
                  type="email"
                  required
                  autoComplete="username"
                  spellCheck={false}
                  autoCapitalize="none"
                  placeholder="admin@sekolahanda.sch.id"
                  value={adminEmail}
                  onChange={(e) => setAdminEmail(e.target.value)}
                  className="w-full border border-slate-300 rounded-md px-3 py-2 text-xs font-mono bg-white focus:border-blue-700 focus:outline-2 focus:outline-blue-600/20"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="field-group">
                <label htmlFor="setup-admin-password" className="block text-xs font-medium text-slate-700 mb-1.5">
                  Password (Min. 8 Karakter)
                </label>
                <div className="relative">
                  <input
                    id="setup-admin-password"
                    name="admin_password"
                    type={showAdminPassword ? 'text' : 'password'}
                    required
                    minLength={8}
                    autoComplete="new-password"
                    placeholder="Minimal 8 karakter unik"
                    value={adminPassword}
                    onChange={(e) => setAdminPassword(e.target.value)}
                    className="w-full border border-slate-300 rounded-md pl-3 pr-9 py-2 text-xs font-mono bg-white focus:border-blue-700 focus:outline-2 focus:outline-blue-600/20"
                  />
                  <button
                    type="button"
                    onClick={() => setShowAdminPassword((p) => !p)}
                    aria-pressed={showAdminPassword}
                    aria-label={showAdminPassword ? 'Sembunyikan password admin' : 'Tampilkan password admin'}
                    className="absolute inset-y-0 right-0 px-2.5 flex items-center text-slate-500 hover:text-slate-800"
                  >
                    {showAdminPassword ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                  </button>
                </div>
              </div>

              <div className="field-group">
                <label htmlFor="setup-admin-password-confirm" className="block text-xs font-medium text-slate-700 mb-1.5">
                  Ulangi Password
                </label>
                <input
                  id="setup-admin-password-confirm"
                  name="admin_password_confirm"
                  type={showAdminPassword ? 'text' : 'password'}
                  required
                  minLength={8}
                  autoComplete="new-password"
                  placeholder="Ketik ulang password"
                  value={adminPasswordConfirm}
                  onChange={(e) => setAdminPasswordConfirm(e.target.value)}
                  className="w-full border border-slate-300 rounded-md px-3 py-2 text-xs font-mono bg-white focus:border-blue-700 focus:outline-2 focus:outline-blue-600/20"
                />
              </div>
            </div>

            <div className="pt-2 border-t border-slate-100">
              <label className="inline-flex items-center gap-2 text-xs font-medium text-slate-700 cursor-pointer">
                <input
                  type="checkbox"
                  checked={createBk}
                  onChange={(e) => setCreateBk(e.target.checked)}
                />
                <UserPlus className="w-3.5 h-3.5 text-slate-500" />
                Sekaligus buat 1 akun Guru BK (bisa ditambah nanti di Pengaturan)
              </label>

              {createBk && (
                <div className="mt-3 p-3.5 rounded-lg bg-slate-50 border border-slate-200 grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                  <div>
                    <label htmlFor="setup-bk-name" className="block text-[11px] font-medium text-slate-600 mb-1">
                      Nama Guru BK
                    </label>
                    <input
                      id="setup-bk-name"
                      type="text"
                      required={createBk}
                      placeholder="Guru BK"
                      value={bkName}
                      onChange={(e) => setBkName(e.target.value)}
                      className="w-full border border-slate-300 rounded px-2.5 py-1.5 text-xs bg-white"
                    />
                  </div>
                  <div>
                    <label htmlFor="setup-bk-email" className="block text-[11px] font-medium text-slate-600 mb-1">
                      Email Guru BK
                    </label>
                    <input
                      id="setup-bk-email"
                      type="email"
                      required={createBk}
                      spellCheck={false}
                      placeholder="bk@sekolahanda.sch.id"
                      value={bkEmail}
                      onChange={(e) => setBkEmail(e.target.value)}
                      className="w-full border border-slate-300 rounded px-2.5 py-1.5 text-xs font-mono bg-white"
                    />
                  </div>
                  <div>
                    <label htmlFor="setup-bk-password" className="block text-[11px] font-medium text-slate-600 mb-1">
                      Password BK (Min. 8)
                    </label>
                    <input
                      id="setup-bk-password"
                      type="password"
                      required={createBk}
                      minLength={8}
                      autoComplete="new-password"
                      placeholder="Min. 8 karakter"
                      value={bkPassword}
                      onChange={(e) => setBkPassword(e.target.value)}
                      className="w-full border border-slate-300 rounded px-2.5 py-1.5 text-xs font-mono bg-white"
                    />
                  </div>
                </div>
              )}
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full py-2.5 text-xs font-semibold text-white bg-emerald-700 hover:bg-emerald-800 rounded-md disabled:opacity-60 transition-colors"
            >
              {loading ? 'Menyimpan Konfigurasi...' : 'Selesaikan Setup & Masuk Dashboard'}
            </button>
          </form>
        </section>
      </div>
    </div>
  );
};
