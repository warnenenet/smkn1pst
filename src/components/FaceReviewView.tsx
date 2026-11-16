import React from 'react';
import { CheckCircle2, RotateCcw } from 'lucide-react';
import type { AppDatabase } from '../types';

interface FaceReviewViewProps {
  db: AppDatabase;
  onApprove: (reviewId: number, historyId: number) => Promise<void>;
  onRollback: (reviewId: number) => Promise<void>;
  onApproveAll: () => Promise<void>;
}

export const FaceReviewView: React.FC<FaceReviewViewProps> = ({
  db,
  onApprove,
  onRollback,
  onApproveAll,
}) => {
  const pending = db.face_update_reviews.filter((r) => r.status === 'PENDING');
  const targetScore = db.settings.face_maintenance_target ?? 0.80;
  const targetPct = Math.round(targetScore * 100);
  const enrolledStudents = db.students.filter((s) => Array.isArray(s.embedding) && s.embedding.length > 0 && s.status !== 'LULUS');
  const optimalStudents = enrolledStudents.filter((s) => (s.embedding_quality_score || 0) >= targetScore);
  const trainingStudents = enrolledStudents.filter((s) => (s.embedding_quality_score || 0) < targetScore);

  return (
    <div className="space-y-6">
      <div className="bg-white border border-slate-200 rounded-lg p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h2 className="text-sm font-semibold text-slate-900">
              Auto-Training &amp; Maintenance Wajah Berkelanjutan (Target Optimal &ge; {targetPct}%)
            </h2>
            <p className="text-xs text-slate-600 mt-1">
              Setiap kali siswa berjalan melewati kamera CCTV, sistem memadukan embedding (centroid blending) dan memperbarui snapshot jika lebih baik hingga mencapai kualitas &ge; {targetPct}%.
            </p>
          </div>
          <div className="flex items-center gap-4 text-xs font-mono tabular-nums">
            <span className="text-emerald-700 font-semibold">Optimal (&ge;{targetPct}%): {optimalStudents.length}</span>
            <span className="text-amber-700 font-semibold">Dalam Pelatihan (&lt;{targetPct}%): {trainingStudents.length}</span>
          </div>
        </div>

        {trainingStudents.length > 0 && (
          <div className="border-t border-slate-100 pt-3">
            <div className="text-xs font-medium text-slate-700 mb-2">Siswa Sedang Dalam Peningkatan Otomatis Menuju {targetPct}%:</div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
              {trainingStudents.slice(0, 6).map((s) => {
                const pct = Math.round((s.embedding_quality_score || 0) * 1000) / 10;
                return (
                  <div key={s.id} className="border border-slate-200 rounded px-3 py-2 text-xs flex items-center justify-between gap-2">
                    <span className="truncate font-medium text-slate-800">{s.nama}</span>
                    <span className="font-mono tabular-nums text-amber-700 shrink-0">{pct}% / {targetPct}%</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      <div className="bg-white border border-slate-200 rounded-lg p-4 flex flex-wrap items-center justify-between gap-4">
        <div className="text-xs text-slate-600">
          Kandidat pembaruan wajah bulanan (Top-3 Quality Score). Menunggu persetujuan BK:{' '}
          <strong className="font-mono text-slate-900">{pending.length}</strong> siswa.
        </div>
        {pending.length > 0 && (
          <button
            type="button"
            onClick={onApproveAll}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-white bg-emerald-700 hover:bg-emerald-800 rounded-md transition-colors whitespace-nowrap"
          >
            <CheckCircle2 className="w-3.5 h-3.5" /> Setujui Semua
          </button>
        )}
      </div>

      {pending.length === 0 ? (
        <div className="bg-white border border-slate-200 rounded-lg p-8 text-center">
          <p className="text-sm font-medium text-slate-700">Semua review pembaruan wajah bulan ini telah diproses.</p>
          <p className="text-xs text-slate-500 mt-1">
            Embedding real-time replace-if-better &amp; centroid blending tetap aktif otomatis di semua kamera hingga skor melampaui {targetPct}%.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {pending.map((rev) => {
            const st = db.students.find((s) => s.id === rev.student_id);
            const kelas = db.kelas.find((k) => k.id === st?.kelas_id);
            return (
              <section key={rev.id} className="bg-white border border-slate-200 rounded-lg p-5">
                <div className="flex flex-wrap items-center justify-between gap-4 pb-4 border-b border-slate-100">
                  <div>
                    <h3 className="text-sm font-semibold text-slate-900">
                      {st?.nama ?? '-'} <span className="font-mono text-xs text-slate-500">· {st?.nisn}</span>
                    </h3>
                    <div className="text-xs text-slate-500 mt-0.5 font-mono tabular-nums">
                      {kelas?.nama ?? '-'} · Periode {rev.month}/{rev.year} · Quality Kanonik Lama:{' '}
                      <strong>{rev.current_quality.toFixed(3)}</strong> · Terbaik Baru:{' '}
                      <strong className="text-emerald-700">{rev.best_new_quality.toFixed(3)}</strong>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => onRollback(rev.id)}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-red-700 border border-red-200 hover:bg-red-50 rounded-md transition-colors"
                  >
                    <RotateCcw className="w-3.5 h-3.5" /> Rollback ke Kanonik Lama
                  </button>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 pt-4">
                  {rev.candidate_snapshots.map((cand, idx) => (
                    <div key={cand.history_id} className="border border-slate-200 rounded-md p-3 flex items-center gap-3">
                      <img
                        src={cand.snapshot_path}
                        alt={`Kandidat ${idx + 1} untuk ${st?.nama ?? 'siswa'}`}
                        referrerPolicy="no-referrer"
                        className="w-16 h-16 rounded object-cover border border-slate-200 shrink-0"
                      />
                      <div className="flex-1 min-w-0 text-xs">
                        <div className="font-semibold text-slate-900">Kandidat #{idx + 1}</div>
                        <div className="font-mono tabular-nums text-emerald-700 font-medium">
                          Skor: {cand.quality_score.toFixed(3)}
                        </div>
                        <div className="text-[11px] text-slate-400 truncate font-mono">{cand.created_at}</div>
                        <button
                          type="button"
                          onClick={() => onApprove(rev.id, cand.history_id)}
                          className="mt-2 px-2.5 py-1 text-xs font-medium text-white bg-blue-700 hover:bg-blue-800 rounded transition-colors"
                        >
                          Approve Kanonik
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
};
