import test from 'node:test';
import assert from 'node:assert/strict';
import type { AppDatabase } from '../types';
import { evaluateProductionReadiness } from './productionReadiness';

function makeBaseDb(): AppDatabase {
  return {
    users: [{ id: 1, name: 'Admin', email: 'admin@smk.sch.id', role: 'ADMIN', is_active: true }],
    jurusans: [{ id: 1, kode: 'TKJ', nama: 'Teknik Komputer Jaringan' }],
    kelas: [{ id: 1, jurusan_id: 1, tingkat: 'X', nama: 'X TKJ 1', shift: 'PAGI' }],
    students: [],
    gates: [{ id: 1, nama_gerbang: 'Gerbang Utama', lokasi: 'Depan', tipe: 'BOTH' }],
    cameras: [],
    schedules: [
      {
        id: 1,
        jurusan_id: null,
        hari: 1,
        jam_masuk_mulai: '06:00',
        jam_masuk_selesai: '07:15',
        jam_keluar_mulai: '14:30',
        jam_keluar_selesai: '17:00',
        toleransi_terlambat_menit: 10,
      },
    ],
    kelas_overrides: [],
    schedule_exceptions: [],
    attendance_logs: [],
    daily_attendance: [],
    anonymous_clusters: [],
    visitors: [],
    face_update_history: [],
    face_update_reviews: [],
    wa_queue: [],
    wa_accounts: [],
    wa_templates: [],
    notifications: [],
    guest_access_logs: [],
    storage_bytes_simulated: 1024 * 1024,
    settings: {
      school_name: 'SMK Negeri 1 Percut',
      threshold_confidence: 0.8,
      threshold_recognition: 0.7,
      threshold_clustering: 0.7,
      min_face_size: 60,
      min_snapshot_quality: 0.7,
      capture_max_width: 1280,
      capture_jpeg_quality: 86,
      cluster_ready_hits: 5,
      cluster_ready_days: 1,
      cluster_sighting_interval_min: 10,
      cluster_archive_days: 14,
      cluster_delete_days: 30,
      weight_confidence: 0.3,
      weight_size: 0.25,
      weight_sharpness: 0.25,
      weight_frontal: 0.2,
      cutoff_keluar: '18:00:00',
      wa_provider: 'BAILEYS',
      wa_api_key: '',
      wa_phone_number_id: '',
      wa_delay_after_pulang_menit: 60,
      wa_auto_dispatch_enabled: true,
      tts_mode: 'AUTO_ADAPTIVE',
      tts_max_age_sec: 30,
      tts_burst_threshold: 10,
      face_maintenance_target: 0.8,
      auto_backup_enabled: true,
      backup_retention_count: 2,
      production_mode: true,
    },
  };
}

test('evaluateProductionReadiness scores partial setup accurately', () => {
  const db = makeBaseDb();
  const report = evaluateProductionReadiness({
    db,
    ffmpegReady: true,
    backupCount: 0,
  });

  assert.equal(report.totalSteps, 6);
  assert.equal(report.completedCount, 2);
  assert.equal(report.percent, 33);
  assert.equal(report.isReadyForProduction, false);
});

test('evaluateProductionReadiness reaches 100% when all 6 production prerequisites pass', () => {
  const db = makeBaseDb();
  db.students.push({
    id: 1,
    nis: '1001',
    nisn: '0081001',
    nama: 'Ahmad',
    nickname: 'Ahmad',
    kelas_id: 1,
    tanggal_lahir: '2008-05-01',
    status: 'AKTIF',
    embedding: [1],
    embedding_quality_score: 0.9,
    embedding_updated_at: '2026-11-23 07:00:00',
    foto_ref: '/api/snapshots/1.jpg',
    wa_ortu: '08123456789',
    created_at: '2026-11-23 07:00:00',
  });
  db.cameras.push({
    id: 1,
    nama_kamera: 'Gerbang Depan',
    gate_id: 1,
    rtsp_url: 'rtsp://admin:pass@192.168.1.10:554/stream1',
    resolusi: '1920x1080',
    fps: 5,
    aktif: true,
    status: 'ONLINE',
    last_error: null,
    last_online_at: '2026-11-23 07:00:00',
  });
  db.wa_accounts.push({
    id: 1,
    provider: 'BAILEYS',
    phone_number: '6281234567890',
    api_key: '',
    status: 'ACTIVE',
    daily_count: 0,
    hourly_count: 0,
    last_reset_at: '2026-11-23 07:00:00',
    created_at: '2026-11-23 07:00:00',
    qr_connected: true,
  });

  const report = evaluateProductionReadiness({
    db,
    ffmpegReady: true,
    backupCount: 1,
  });

  assert.equal(report.completedCount, 6);
  assert.equal(report.percent, 100);
  assert.equal(report.isReadyForProduction, true);
});
