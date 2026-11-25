import type { AppDatabase, WorkerStatusResponse } from '../types';
import { TOTAL_STORAGE_LIMIT_BYTES } from './storageBudget';

export type SetupStepActionTab =
  | 'settings'
  | 'students'
  | 'cameras'
  | 'schedules'
  | 'whatsapp';

export interface ProductionReadinessStep {
  id:
    | 'admin_school'
    | 'students_faces'
    | 'gates_cameras'
    | 'schedules'
    | 'wa_kiosk'
    | 'production_hardening';
  number: number;
  title: string;
  description: string;
  done: boolean;
  summary: string;
  actionTab: SetupStepActionTab;
  actionLabel: string;
}

export interface ProductionReadinessReport {
  percent: number;
  completedCount: number;
  totalSteps: number;
  isReadyForProduction: boolean;
  steps: ProductionReadinessStep[];
}

export function evaluateProductionReadiness(params: {
  db: AppDatabase;
  workerStatus?: WorkerStatusResponse | null;
  ffmpegReady?: boolean;
  backupCount?: number;
}): ProductionReadinessReport {
  const { db, workerStatus, ffmpegReady = true, backupCount = 0 } = params;

  const activeAdmins = db.users.filter((u) => u.role === 'ADMIN' && u.is_active);
  const schoolConfigured =
    typeof db.settings.school_name === 'string' &&
    db.settings.school_name.trim().length >= 3 &&
    db.settings.school_name.trim() !== 'SMK Negeri Unggulan';
  const adminReady = activeAdmins.length > 0 && schoolConfigured;

  const activeStudents = db.students.filter((s) => s.status !== 'LULUS');
  const enrolledStudents = activeStudents.filter(
    (s) => Array.isArray(s.embedding) && s.embedding.length > 0
  );
  const studentsReady =
    db.jurusans.length > 0 && db.kelas.length > 0 && enrolledStudents.length > 0;

  const realCameras = db.cameras.filter((c) => {
    const u = (c.rtsp_url || '').trim().toLowerCase();
    return c.aktif && (u.startsWith('rtsp://') || u.startsWith('rtsps://')) && !u.includes('demo-gate');
  });
  const onlineRealCameras = realCameras.filter((c) => c.status === 'ONLINE');
  const camerasReady = db.gates.length > 0 && realCameras.length > 0 && ffmpegReady;

  const schedulesReady = db.schedules.length > 0;

  const connectedWa = db.wa_accounts.filter(
    (a) => (a.qr_connected || a.provider !== 'WA_WEB') && a.status !== 'BANNED'
  );
  const waAndKioskReady = connectedWa.length > 0;

  const totalBytes = workerStatus?.storage_breakdown?.total_bytes ?? db.storage_bytes_simulated;
  const underStorageLimit = totalBytes < TOTAL_STORAGE_LIMIT_BYTES * 0.9;
  const productionHardeningReady =
    Boolean(db.settings.production_mode) && underStorageLimit && ffmpegReady && backupCount >= 1;

  const steps: ProductionReadinessStep[] = [
    {
      id: 'admin_school',
      number: 1,
      title: 'Identitas Sekolah & Akun Admin',
      description: 'Nama sekolah valid dan minimal 1 akun Administrator aktif (setup awal terkunci).',
      done: adminReady,
      summary: adminReady
        ? `${db.settings.school_name} · ${activeAdmins.length} Admin aktif`
        : 'Lengkapi nama sekolah & akun Administrator',
      actionTab: 'settings',
      actionLabel: 'Kelola User & Sekolah',
    },
    {
      id: 'students_faces',
      number: 2,
      title: 'Jurusan, Kelas, Data Siswa & Foto Wajah AI',
      description: 'Struktur kelas terisi dan minimal 1 siswa sudah memiliki foto wajah AI.',
      done: studentsReady,
      summary: `${db.jurusans.length} jurusan · ${db.kelas.length} kelas · ${enrolledStudents.length}/${activeStudents.length} siswa berfoto AI`,
      actionTab: 'students',
      actionLabel: 'Kelola Siswa & Import Excel',
    },
    {
      id: 'gates_cameras',
      number: 3,
      title: 'Gerbang & Kamera CCTV RTSP Live',
      description: 'Minimal 1 gerbang dan 1 kamera RTSP aktif serta binary FFmpeg siap.',
      done: camerasReady,
      summary: `${db.gates.length} gerbang · ${realCameras.length} kamera RTSP aktif (${onlineRealCameras.length} online) · FFmpeg ${ffmpegReady ? 'SIAP' : 'BELUM SIAP'}`,
      actionTab: 'cameras',
      actionLabel: 'Atur Gerbang & Kamera RTSP',
    },
    {
      id: 'schedules',
      number: 4,
      title: 'Jadwal Masuk & Pulang Sekolah',
      description: 'Jadwal harian Senin–Sabtu (global atau per jurusan) dan toleransi terlambat.',
      done: schedulesReady,
      summary: schedulesReady
        ? `${db.schedules.length} aturan jadwal aktif`
        : 'Belum ada jadwal masuk/pulang terdaftar',
      actionTab: 'schedules',
      actionLabel: 'Atur Jadwal Sekolah',
    },
    {
      id: 'wa_kiosk',
      number: 5,
      title: 'WhatsApp Gateway & Kiosk Panggil Gerbang',
      description: 'Hubungkan akun WhatsApp sekolah (QR Chromium / API) dan cek layar Kiosk gerbang.',
      done: waAndKioskReady,
      summary: waAndKioskReady
        ? `${connectedWa.length} akun WhatsApp terhubung`
        : `${db.wa_accounts.length} akun WA terdaftar (belum terhubung)`,
      actionTab: 'whatsapp',
      actionLabel: 'Hubungkan WhatsApp',
    },
    {
      id: 'production_hardening',
      number: 6,
      title: 'Mode Produksi Live, Kuota 10 GB & Backup Awal',
      description: 'Mode Produksi aktif (tanpa data demo), storage aman < 9 GB, dan backup awal tersedia.',
      done: productionHardeningReady,
      summary: `${db.settings.production_mode ? 'Mode Produksi AKTIF' : 'Masih Mode Demo'} · ${backupCount} backup tersimpan`,
      actionTab: 'settings',
      actionLabel: 'Lihat Pengaturan Lengkap',
    },
  ];

  const completedCount = steps.filter((s) => s.done).length;
  const totalSteps = steps.length;
  const percent = Math.round((completedCount / totalSteps) * 100);

  return {
    percent,
    completedCount,
    totalSteps,
    isReadyForProduction: completedCount === totalSteps,
    steps,
  };
}
