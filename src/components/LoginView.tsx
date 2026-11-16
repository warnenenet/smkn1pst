import React, { useState } from 'react';
import { Lock, ArrowLeft } from 'lucide-react';
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

        <section className="bg-white border border-slate-200 rounded-lg p-6 shadow-xs">
          <div className="flex items-center gap-2.5 mb-2">
            <div className="w-8 h-8 rounded-md bg-blue-700 text-white flex items-center justify-center">
              <Lock className="w-4 h-4" />
            </div>
            <div>
              <h1 className="text-base font-bold text-slate-900">Login Dashboard Internal</h1>
              <p className="text-xs text-slate-500">{schoolName} · Admin, Guru BK &amp; Wali Kelas</p>
            </div>
          </div>

          {error && (
            <div role="alert" className="mt-4 p-3 rounded-md bg-red-50 border border-red-200 text-xs text-red-700 font-medium">
              {error}
            </div>
          )}

          <form onSubmit={handleSubmit} className="mt-5 space-y-4">
            <div>
              <label htmlFor="login-email" className="block text-xs font-medium text-slate-700 mb-1">
                Email Staff
              </label>
              <input
                id="login-email"
                type="email"
                required
                placeholder="admin@sekolah.local"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full border border-slate-300 rounded-md px-3 py-2 text-xs font-mono"
              />
            </div>

            <div>
              <label htmlFor="login-password" className="block text-xs font-medium text-slate-700 mb-1">
                Password
              </label>
              <input
                id="login-password"
                type="password"
                required
                placeholder="••••••••"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full border border-slate-300 rounded-md px-3 py-2 text-xs font-mono"
              />
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full py-2.5 text-xs font-semibold text-white bg-blue-700 hover:bg-blue-800 rounded-md disabled:opacity-60"
            >
              {loading ? 'Memeriksa Sesi...' : 'Masuk ke Dashboard'}
            </button>
          </form>

          <div className="mt-5 pt-4 border-t border-slate-100 text-[11px] text-slate-500 space-y-1">
            <div className="font-semibold text-slate-700">Akun Default Deployment (segera ganti password di Pengaturan):</div>
            <div className="font-mono">ADMIN: admin@sekolah.local / admin123</div>
            <div className="font-mono">BK: bk@sekolah.local / bk123</div>
            <div className="font-mono">GURU: guru@sekolah.local / guru123</div>
          </div>
        </section>
      </div>
    </div>
  );
};
