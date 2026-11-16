import React, { useEffect, useState } from 'react';
import { Download, HardDriveUpload, RefreshCw } from 'lucide-react';
import type { AppDatabase, BackupEntry, SettingsMap, TTSMode, UserRole } from '../types';

interface SettingsUsersViewProps {
  db: AppDatabase;
  onSaveSettings: (patch: Partial<SettingsMap>) => Promise<void>;
  onAddUser: (payload: { name: string; email: string; role: UserRole; password: string }) => Promise<void>;
  onToggleUser: (id: number) => Promise<void>;
  onMarkRead: (id: number) => Promise<void>;
  onChangePassword: (payload: { oldPassword: string; newPassword: string }) => Promise<void>;
  onBackupFinished?: () => Promise<void>;
}

export const SettingsUsersView: React.FC<SettingsUsersViewProps> = ({
  db,
  onSaveSettings,
  onAddUser,
  onToggleUser,
  onMarkRead,
  onChangePassword,
  onBackupFinished,
}) => {
  const [form, setForm] = useState<SettingsMap>(db.settings);
  const [uName, setUName] = useState('');
  const [uEmail, setUEmail] = useState('');
  const [uRole, setURole] = useState<UserRole>('BK');
  const [uPassword, setUPassword] = useState('');
  const [oldPwd, setOldPwd] = useState('');
  const [newPwd, setNewPwd] = useState('');

  const [backups, setBackups] = useState<BackupEntry[]>([]);
  const [backupTotalBytes, setBackupTotalBytes] = useState(0);
  const [backupBusy, setBackupBusy] = useState(false);
  const [backupMsg, setBackupMsg] = useState('');

  const loadBackups = async () => {
    try {
      const res = await fetch('/api/backups');
      if (!res.ok) return;
      const data = await res.json();
      setBackups(data.backups ?? []);
      setBackupTotalBytes(Number(data.total_bytes ?? 0));
    } catch {
      // ignore network fetch issue
    }
  };

  useEffect(() => {
    loadBackups();
  }, []);

  const handleRunBackup = async () => {
    setBackupBusy(true);
    setBackupMsg('');
    try {
      const res = await fetch('/api/backups/run', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) {
        setBackupMsg(data.error || 'Gagal membuat backup.');
      } else {
        setBackups(data.backups ?? []);
        await loadBackups();
        setBackupMsg(`Backup terkompresi ${data.backup.filename} (${Math.max(1, Math.round(data.backup.bytes / 1024))} KB) berhasil dibuat.`);
      }
    } finally {
      setBackupBusy(false);
    }
  };

  const handleRestoreFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setBackupBusy(true);
    setBackupMsg('');
    try {
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      const res = await fetch('/api/backups/restore', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileBase64: base64 }),
      });
      const data = await res.json();
      if (!res.ok) {
        setBackupMsg(data.error || 'Gagal restore database.');
      } else {
        setBackupMsg(`Database berhasil di-restore (${data.students} siswa, ${data.users} user).`);
        if (onBackupFinished) await onBackupFinished();
      }
    } finally {
      setBackupBusy(false);
      e.target.value = '';
    }
  };

  const formatBytes = (b: number) => {
    if (b < 1024) return `${b} B`;
    if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
    return `${(b / (1024 * 1024)).toFixed(2)} MB`;
  };

  return (
    <div className="space-y-6">
      <section className="bg-white border border-slate-200 rounded-lg p-5">
        <h2 className="text-sm font-semibold text-slate-900 mb-4">Pengaturan Threshold AI, Maintenance 80%, Backup &amp; Audio Gerbang</h2>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            await onSaveSettings(form);
          }}
          className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4"
        >
          <div>
            <label className="block text-xs text-slate-600 mb-1">Nama Sekolah</label>
            <input value={form.school_name} onChange={(e) => setForm({ ...form, school_name: e.target.value })} className="w-full border border-slate-300 rounded px-2.5 py-1.5 text-xs" />
          </div>
          <div>
            <label className="block text-xs text-slate-600 mb-1">Cutoff TIDAK_KELUAR</label>
            <input type="time" step="1" value={form.cutoff_keluar} onChange={(e) => setForm({ ...form, cutoff_keluar: e.target.value })} className="w-full border border-slate-300 rounded px-2.5 py-1.5 text-xs font-mono" />
          </div>
          <div>
            <label className="block text-xs text-slate-600 mb-1">Confidence Deteksi Min (Default 0.80)</label>
            <input type="number" step="0.01" min="0.5" max="0.99" value={form.threshold_confidence} onChange={(e) => setForm({ ...form, threshold_confidence: Number(e.target.value) })} className="w-full border border-slate-300 rounded px-2.5 py-1.5 text-xs font-mono" />
          </div>
          <div>
            <label className="block text-xs text-slate-600 mb-1">Threshold Pengenalan 1:N (Default 0.40)</label>
            <input type="number" step="0.01" min="0.2" max="0.9" value={form.threshold_recognition} onChange={(e) => setForm({ ...form, threshold_recognition: Number(e.target.value) })} className="w-full border border-slate-300 rounded px-2.5 py-1.5 text-xs font-mono" />
          </div>
          <div>
            <label className="block text-xs text-slate-600 mb-1">Threshold Clustering Anonim (Default 0.50)</label>
            <input type="number" step="0.01" min="0.2" max="0.9" value={form.threshold_clustering} onChange={(e) => setForm({ ...form, threshold_clustering: Number(e.target.value) })} className="w-full border border-slate-300 rounded px-2.5 py-1.5 text-xs font-mono" />
          </div>
          <div>
            <label htmlFor="face-maint-target" className="block text-xs text-slate-600 mb-1">Target Maintenance Wajah (Default 0.80 = 80%)</label>
            <input
              id="face-maint-target"
              type="number"
              step="0.01"
              min="0.5"
              max="0.99"
              value={form.face_maintenance_target ?? 0.80}
              onChange={(e) => setForm({ ...form, face_maintenance_target: Number(e.target.value) })}
              className="w-full border border-slate-300 rounded px-2.5 py-1.5 text-xs font-mono"
            />
          </div>
          <div>
            <label className="block text-xs text-slate-600 mb-1">Ukuran Wajah Min (px)</label>
            <input type="number" value={form.min_face_size} onChange={(e) => setForm({ ...form, min_face_size: Number(e.target.value) })} className="w-full border border-slate-300 rounded px-2.5 py-1.5 text-xs font-mono" />
          </div>
          <div>
            <label className="block text-xs text-slate-600 mb-1">Syarat READY: Min Hit Count</label>
            <input type="number" value={form.cluster_ready_hits} onChange={(e) => setForm({ ...form, cluster_ready_hits: Number(e.target.value) })} className="w-full border border-slate-300 rounded px-2.5 py-1.5 text-xs font-mono" />
          </div>
          <div>
            <label className="block text-xs text-slate-600 mb-1">Syarat READY: Min Hari Berbeda</label>
            <input type="number" value={form.cluster_ready_days} onChange={(e) => setForm({ ...form, cluster_ready_days: Number(e.target.value) })} className="w-full border border-slate-300 rounded px-2.5 py-1.5 text-xs font-mono" />
          </div>
          <div>
            <label className="block text-xs text-slate-600 mb-1">Auto-Arsip / Hapus Cluster (Hari)</label>
            <div className="flex gap-2">
              <input type="number" value={form.cluster_archive_days} onChange={(e) => setForm({ ...form, cluster_archive_days: Number(e.target.value) })} className="w-full border border-slate-300 rounded px-2.5 py-1.5 text-xs font-mono" />
              <input type="number" value={form.cluster_delete_days} onChange={(e) => setForm({ ...form, cluster_delete_days: Number(e.target.value) })} className="w-full border border-slate-300 rounded px-2.5 py-1.5 text-xs font-mono" />
            </div>
          </div>

          <div>
            <label htmlFor="tts-mode" className="block text-xs text-slate-600 mb-1">Mode Suara Kiosk Gerbang</label>
            <select
              id="tts-mode"
              value={form.tts_mode ?? 'AUTO_ADAPTIVE'}
              onChange={(e) => setForm({ ...form, tts_mode: e.target.value as TTSMode })}
              className="w-full border border-slate-300 rounded px-2.5 py-1.5 text-xs bg-white"
            >
              <option value="AUTO_ADAPTIVE">AUTO_ADAPTIVE (Sepi=Nama, Sibuk=Chime Kilat)</option>
              <option value="CHIME_ONLY">CHIME_ONLY (Selalu Nada Bip Instan Tanpa Antre)</option>
              <option value="FULL_NAME">FULL_NAME (Selalu Panggil Nama)</option>
            </select>
          </div>
          <div>
            <label htmlFor="tts-max-age" className="block text-xs text-slate-600 mb-1">TTL Kadaluarsa Audio TTS (Detik)</label>
            <input
              id="tts-max-age"
              type="number"
              min={1}
              max={15}
              value={form.tts_max_age_sec ?? 3}
              onChange={(e) => setForm({ ...form, tts_max_age_sec: Number(e.target.value) })}
              className="w-full border border-slate-300 rounded px-2.5 py-1.5 text-xs font-mono"
            />
          </div>
          <div>
            <label htmlFor="tts-burst" className="block text-xs text-slate-600 mb-1">Ambang Jam Sibuk (Siswa / 5 Detik)</label>
            <input
              id="tts-burst"
              type="number"
              min={2}
              max={20}
              value={form.tts_burst_threshold ?? 3}
              onChange={(e) => setForm({ ...form, tts_burst_threshold: Number(e.target.value) })}
              className="w-full border border-slate-300 rounded px-2.5 py-1.5 text-xs font-mono"
            />
          </div>
          <div>
            <label htmlFor="backup-ret" className="block text-xs text-slate-600 mb-1">Retensi Backup Terkompresi (Max File)</label>
            <input
              id="backup-ret"
              type="number"
              min={1}
              max={5}
              value={form.backup_retention_count ?? 2}
              onChange={(e) => setForm({ ...form, backup_retention_count: Number(e.target.value) })}
              className="w-full border border-slate-300 rounded px-2.5 py-1.5 text-xs font-mono"
            />
          </div>
          <div className="flex items-end pb-1">
            <label className="inline-flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
              <input
                type="checkbox"
                checked={form.auto_backup_enabled ?? true}
                onChange={(e) => setForm({ ...form, auto_backup_enabled: e.target.checked })}
              />
              Aktifkan Auto-Backup Harian (.sqlite.gz)
            </label>
          </div>

          <div className="sm:col-span-2 lg:col-span-3 flex items-center justify-between pt-2 border-t border-slate-100">
            <span className="text-xs text-slate-500">
              Anti-spoofing &amp; liveness detection DINONAKTIFKAN total sesuai kebijakan gerbang sekolah.
            </span>
            <button type="submit" className="px-4 py-2 text-xs font-semibold text-white bg-blue-700 hover:bg-blue-800 rounded-md">
              Simpan Pengaturan
            </button>
          </div>
        </form>
      </section>

      {/* Compact Rotating Gzip Backup & Restore */}
      <section className="bg-white border border-slate-200 rounded-lg p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h2 className="text-sm font-semibold text-slate-900">Backup &amp; Restore Database Otomatis (Anti-Penuh Storage)</h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Menggunakan SQLite <span className="font-mono">VACUUM INTO</span> + kompresi Gzip level 9. Maksimal {form.backup_retention_count ?? 2} snapshot terbaru disimpan (total terpakai:{' '}
              <strong className="font-mono text-slate-800">{formatBytes(backupTotalBytes)}</strong> / 150 MB batas backup).
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={backupBusy}
              onClick={handleRunBackup}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-white bg-emerald-700 hover:bg-emerald-800 disabled:opacity-50 rounded-md"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${backupBusy ? 'animate-spin' : ''}`} />
              Backup Sekarang
            </button>
            <label className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-md cursor-pointer">
              <HardDriveUpload className="w-3.5 h-3.5" />
              Restore (.sqlite.gz / .sqlite)
              <input type="file" accept=".gz,.sqlite" onChange={handleRestoreFile} className="hidden" />
            </label>
          </div>
        </div>

        {backupMsg && (
          <div className="text-xs font-medium text-emerald-800 bg-emerald-50 border border-emerald-200 rounded px-3 py-2">
            {backupMsg}
          </div>
        )}

        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-slate-200 text-slate-500">
                <th className="py-2 font-medium">Nama File Backup</th>
                <th className="py-2 font-medium">Waktu Dibuat</th>
                <th className="py-2 font-medium text-right">Ukuran</th>
                <th className="py-2 font-medium text-right">Unduh</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {backups.map((b) => (
                <tr key={b.filename}>
                  <td className="py-2 font-mono text-slate-900">{b.filename}</td>
                  <td className="py-2 font-mono text-slate-500">{b.created_at.replace('T', ' ').slice(0, 19)}</td>
                  <td className="py-2 text-right font-mono tabular-nums text-slate-700">{formatBytes(b.bytes)}</td>
                  <td className="py-2 text-right">
                    <a
                      href={`/api/backups/${encodeURIComponent(b.filename)}/download`}
                      className="inline-flex items-center gap-1 text-blue-700 hover:underline font-medium"
                    >
                      <Download className="w-3.5 h-3.5" /> Download
                    </a>
                  </td>
                </tr>
              ))}
              {backups.length === 0 && (
                <tr>
                  <td colSpan={4} className="py-4 text-center text-slate-500">
                    Belum ada snapshot backup. Klik &quot;Backup Sekarang&quot; atau tunggu jadwal auto-backup harian.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <section className="bg-white border border-slate-200 rounded-lg p-5 space-y-5">
          <div>
            <h2 className="text-sm font-semibold text-slate-900 mb-3">Manajemen User (Admin / BK / Guru)</h2>
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                await onAddUser({ name: uName, email: uEmail, role: uRole, password: uPassword });
                setUName('');
                setUEmail('');
                setUPassword('');
              }}
              className="grid grid-cols-1 sm:grid-cols-2 gap-2 mb-4"
            >
              <input placeholder="Nama Lengkap" required value={uName} onChange={(e) => setUName(e.target.value)} className="border border-slate-300 rounded px-2.5 py-1.5 text-xs" />
              <input type="email" placeholder="Email" required value={uEmail} onChange={(e) => setUEmail(e.target.value)} className="border border-slate-300 rounded px-2.5 py-1.5 text-xs" />
              <input
                type="password"
                minLength={6}
                required
                placeholder="Password awal (min 6)"
                value={uPassword}
                onChange={(e) => setUPassword(e.target.value)}
                className="border border-slate-300 rounded px-2.5 py-1.5 text-xs font-mono"
              />
              <div className="flex gap-2">
                <select value={uRole} onChange={(e) => setURole(e.target.value as UserRole)} className="border border-slate-300 rounded px-2 py-1.5 text-xs bg-white flex-1">
                  <option value="ADMIN">ADMIN</option>
                  <option value="BK">BK</option>
                  <option value="GURU">GURU</option>
                </select>
                <button type="submit" className="px-3 py-1.5 text-xs font-semibold text-white bg-blue-700 hover:bg-blue-800 rounded">Tambah</button>
              </div>
            </form>

            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-slate-200 text-slate-500">
                  <th className="py-2 font-medium">Nama &amp; Email</th>
                  <th className="py-2 font-medium">Role</th>
                  <th className="py-2 font-medium text-right">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {db.users.map((u) => (
                  <tr key={u.id}>
                    <td className="py-2">
                      <div className="font-medium text-slate-900">{u.name}</div>
                      <div className="text-[11px] text-slate-400 font-mono">{u.email}</div>
                    </td>
                    <td className="py-2 font-mono text-slate-700">{u.role}</td>
                    <td className="py-2 text-right">
                      <button
                        type="button"
                        onClick={() => onToggleUser(u.id)}
                        className={`text-xs font-medium hover:underline ${u.is_active ? 'text-emerald-700' : 'text-red-700'}`}
                      >
                        {u.is_active ? 'Aktif (Nonaktifkan)' : 'Nonaktif (Aktifkan)'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <hr className="border-slate-200" />
          <div>
            <h3 className="text-xs font-semibold text-slate-900 mb-2">Ganti Password Akun Saya</h3>
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                await onChangePassword({ oldPassword: oldPwd, newPassword: newPwd });
                setOldPwd('');
                setNewPwd('');
              }}
              className="flex flex-col sm:flex-row gap-2"
            >
              <input
                type="password"
                required
                placeholder="Password lama"
                value={oldPwd}
                onChange={(e) => setOldPwd(e.target.value)}
                className="border border-slate-300 rounded px-2.5 py-1.5 text-xs flex-1"
              />
              <input
                type="password"
                required
                minLength={6}
                placeholder="Password baru (min 6)"
                value={newPwd}
                onChange={(e) => setNewPwd(e.target.value)}
                className="border border-slate-300 rounded px-2.5 py-1.5 text-xs flex-1"
              />
              <button type="submit" className="px-3 py-1.5 text-xs font-semibold text-white bg-slate-800 hover:bg-slate-900 rounded">
                Ubah Password
              </button>
            </form>
          </div>
        </section>

        <section className="bg-white border border-slate-200 rounded-lg p-5">
          <h2 className="text-sm font-semibold text-slate-900 mb-3">Pusat Notifikasi</h2>
          <ul className="divide-y divide-slate-100 text-xs">
            {db.notifications.map((n) => (
              <li key={n.id} className={`py-2.5 flex items-start justify-between gap-3 ${n.is_read ? 'opacity-60' : ''}`}>
                <div>
                  <div className="font-semibold text-slate-900">{n.title}</div>
                  <p className="text-slate-600 mt-0.5">{n.message}</p>
                  <span className="font-mono text-[11px] text-slate-400">{n.created_at}</span>
                </div>
                {!n.is_read && (
                  <button type="button" onClick={() => onMarkRead(n.id)} className="text-blue-700 hover:underline shrink-0">
                    Dibaca
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
};
