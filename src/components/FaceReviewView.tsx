import React, { useState } from 'react';
import { CheckCircle2, RotateCcw, ZoomIn } from 'lucide-react';
import type { AppDatabase } from '../types';
import { FaceLightboxModal, type FaceGalleryItem } from './FaceLightboxModal';

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
  const [lightboxState, setLightboxState] = useState<{
    title: string;
    subtitle: string;
    referenceItem: FaceGalleryItem | null;
    items: FaceGalleryItem[];
    initialIndex: number;
  } | null>(null);
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
            const recentStudentHits = db.attendance_logs
              .filter((l) => l.student_id === rev.student_id && Boolean(l.snapshot_path))
              .slice(0, 6);
            const galleryItems: FaceGalleryItem[] = [
              ...rev.candidate_snapshots.map((cand, idx) => ({
                src: cand.snapshot_path,
                label: `Kandidat #${idx + 1}`,
                qualityScore: cand.quality_score,
                timestamp: cand.created_at,
              })),
              ...recentStudentHits.map((l) => ({
                src: String(l.snapshot_path),
                label: `Hit ${l.tipe} (${l.status})`,
                similarity: l.similarity_score ?? null,
                timestamp: l.timestamp.replace('T', ' '),
                cameraName: db.cameras.find((cm) => cm.id === l.camera_id)?.nama_kamera ?? null,
              })),
            ];
            const referenceItem: FaceGalleryItem | null = st?.foto_ref
              ? {
                  src: st.foto_ref,
                  label: `Foto Kanonik Saat Ini (${st.nama})`,
                  meta: `Skor ${rev.current_quality.toFixed(3)}`,
                }
              : null;

            return (
              <section key={rev.id} className="bg-white border border-slate-200 rounded-lg p-5 space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-4 pb-4 border-b border-slate-100">
                  <div className="flex items-center gap-3">
                    {st?.foto_ref && (
                      <button
                        type="button"
                        onClick={() =>
                          setLightboxState({
                            title: `Dobel Crosscheck Wajah — ${st.nama}`,
                            subtitle: `${kelas?.nama ?? '-'} · NISN ${st.nisn}`,
                            referenceItem,
                            items: galleryItems,
                            initialIndex: 0,
                          })
                        }
                        aria-label={`Perbesar foto kanonik ${st.nama}`}
                        className="group relative shrink-0 rounded-md overflow-hidden border border-slate-200 hover:border-blue-500"
                      >
                        <img
                          src={st.foto_ref}
                          alt={`Foto kanonik ${st.nama}`}
                          referrerPolicy="no-referrer"
                          className="w-20 h-20 object-cover bg-slate-100"
                        />
                        <span className="absolute inset-x-0 bottom-0 bg-slate-900/75 text-white text-[9px] font-medium py-0.5 flex items-center justify-center gap-0.5">
                          <ZoomIn className="w-2.5 h-2.5" /> Kanonik
                        </span>
                      </button>
                    )}
                    <div>
                      <h3 className="text-sm font-semibold text-slate-900">
                        {st?.nama ?? '-'} <span className="font-mono text-xs text-slate-500">· {st?.nisn}</span>
                      </h3>
                      <div className="text-xs text-slate-500 mt-0.5 font-mono tabular-nums">
                        {kelas?.nama ?? '-'} · Periode {rev.month}/{rev.year} · Quality Kanonik Lama:{' '}
                        <strong>{rev.current_quality.toFixed(3)}</strong> · Terbaik Baru:{' '}
                        <strong className="text-emerald-700">{rev.best_new_quality.toFixed(3)}</strong>
                      </div>
                      <button
                        type="button"
                        onClick={() =>
                          setLightboxState({
                            title: `Dobel Crosscheck Wajah — ${st?.nama ?? '-'}`,
                            subtitle: `${kelas?.nama ?? '-'} · ${galleryItems.length} foto tersedia`,
                            referenceItem,
                            items: galleryItems,
                            initialIndex: 0,
                          })
                        }
                        className="mt-1.5 inline-flex items-center gap-1 text-xs font-semibold text-blue-700 hover:underline"
                      >
                        <ZoomIn className="w-3.5 h-3.5" /> Perbesar &amp; Bandingkan Semua ({galleryItems.length} Foto)
                      </button>
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

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                  {rev.candidate_snapshots.map((cand, idx) => (
                    <div key={cand.history_id} className="border border-slate-200 rounded-md p-3 flex items-center gap-3">
                      <button
                        type="button"
                        onClick={() =>
                          setLightboxState({
                            title: `Dobel Crosscheck Wajah — ${st?.nama ?? '-'}`,
                            subtitle: `${kelas?.nama ?? '-'} · Kandidat #${idx + 1}`,
                            referenceItem,
                            items: galleryItems,
                            initialIndex: idx,
                          })
                        }
                        aria-label={`Perbesar kandidat ${idx + 1} untuk ${st?.nama ?? 'siswa'}`}
                        className="group relative shrink-0 rounded overflow-hidden border border-slate-200 hover:border-blue-500"
                      >
                        <img
                          src={cand.snapshot_path}
                          alt={`Kandidat ${idx + 1} untuk ${st?.nama ?? 'siswa'}`}
                          referrerPolicy="no-referrer"
                          className="w-24 h-24 object-cover bg-slate-100"
                        />
                        <span className="absolute bottom-1 right-1 bg-slate-900/75 text-white rounded p-0.5">
                          <ZoomIn className="w-3 h-3" />
                        </span>
                      </button>
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

      <FaceLightboxModal
        isOpen={Boolean(lightboxState)}
        onClose={() => setLightboxState(null)}
        title={lightboxState?.title ?? ''}
        subtitle={lightboxState?.subtitle}
        referenceItem={lightboxState?.referenceItem}
        items={lightboxState?.items ?? []}
        initialIndex={lightboxState?.initialIndex ?? 0}
      />
    </div>
  );
};
