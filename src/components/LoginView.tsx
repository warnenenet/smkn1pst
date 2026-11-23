import React, { useState } from 'react';
import { Lock, ArrowLeft, Eye, EyeOff } from 'lucide-react';
import type { User } from '../types';

interface LoginViewProps {
  schoolName: string;
  onSuccess: (user: User) => void;
  onBackToPortal: () => void;
}

export const LoginView: React.FC<LoginViewProps> = ({
  schoolName,
  onSuccess,
  onBackToPortal,
}) => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Login gagal.');
        return;
      }
      onSuccess(data.user);
    } catch {
      setError('Gagal terhubung ke server.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col justify-center py-10 px-4">
      <div className="max-w-md w-full mx-auto space-y-5">
        <button
          type="button"
          onClick={onBackToPortal}
          className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-600 hover:text-slate-900"
        >
          <ArrowLeft className="w-3.5 h-3.5" /> Kembali ke Portal Kehadiran Orang Tua
        </button>

        <section className="bg-white border border-slate-200 rounded-xl p-6 sm:p-7 shadow-xs">
          <div className="flex items-center gap-3 mb-2">
            <div className="w-9 h-9 rounded-lg bg-blue-700 text-white flex items-center justify-center shrink-0">
              <Lock className="w-4 h-4" />
            </div>
            <div className="min-w-0">
              <h1 className="text-base font-bold text-slate-900">Login Dashboard Internal</h1>
              <p className="text-xs text-slate-500 truncate">{schoolName} · Admin, Guru BK &amp; Wali Kelas</p>
            </div>
          </div>

          {error && (
            <div role="alert" className="mt-4 p-3 rounded-md bg-red-50 border border-red-200 text-xs text-red-700 font-medium">
              {error}
            </div>
          )}

          <form onSubmit={handleSubmit} className="mt-5 space-y-4">
            <div className="field-group">
              <label htmlFor="login-email" className="block text-xs font-medium text-slate-700 mb-1.5">
                Email Staff
              </label>
              <input
                id="login-email"
                name="email"
                type="email"
                required
                autoComplete="username"
                spellCheck={false}
                autoCapitalize="none"
                enterKeyHint="next"
                placeholder="admin@sekolah.local"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full border border-slate-300 rounded-md px-3 py-2 text-xs font-mono bg-white focus:border-blue-700 focus:outline-2 focus:outline-blue-600/20"
              />
            </div>

            <div className="field-group">
              <label htmlFor="login-password" className="block text-xs font-medium text-slate-700 mb-1.5">
                Password
              </label>
              <div className="relative">
                <input
                  id="login-password"
                  name="password"
                  type={showPassword ? 'text' : 'password'}
                  required
                  autoComplete="current-password"
                  enterKeyHint="done"
                  placeholder="Masukkan password akun"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full border border-slate-300 rounded-md pl-3 pr-10 py-2 text-xs font-mono bg-white focus:border-blue-700 focus:outline-2 focus:outline-blue-600/20"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((prev) => !prev)}
                  aria-pressed={showPassword}
                  aria-label={showPassword ? 'Sembunyikan password' : 'Tampilkan password'}
                  className="absolute inset-y-0 right-0 px-2.5 flex items-center text-slate-500 hover:text-slate-800"
                >
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full py-2.5 text-xs font-semibold text-white bg-blue-700 hover:bg-blue-800 rounded-md disabled:opacity-60 transition-colors"
            >
              {loading ? 'Memeriksa Sesi...' : 'Masuk ke Dashboard'}
            </button>
          </form>

          <div className="mt-5 pt-4 border-t border-slate-100 text-[11px] text-slate-500">
            Masuk menggunakan akun Administrator, Guru BK, atau Wali Kelas yang dibuat saat setup awal atau melalui menu Pengaturan User.
          </div>
        </section>
      </div>
    </div>
  );
};
