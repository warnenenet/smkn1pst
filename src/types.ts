export type UserRole = 'ADMIN' | 'BK' | 'GURU';
export type StudentStatus = 'AKTIF' | 'PKL' | 'LULUS' | 'CUTI' | 'IZIN_PANJANG';
export type GateType = 'MASUK' | 'KELUAR' | 'BOTH';
export type AttendanceStatus = 'HADIR' | 'TERLAMBAT' | 'ALPA' | 'TIDAK_KELUAR' | 'IZIN' | 'SAKIT';
export type LogType = 'MASUK' | 'KELUAR' | 'OBSERVASI';
export type ExceptionScope = 'GLOBAL' | 'JURUSAN';
export type ExceptionType = 'LIBUR' | 'PULANG_CEPAT' | 'EKSUKUL' | 'SHIFT_SWAP';
export type ClusterStatus = 'PENDING' | 'READY' | 'NAMED' | 'ARCHIVED';
export type ReviewStatus = 'PENDING' | 'APPROVED' | 'ROLLED_BACK';
export type WaQueueStatus = 'PENDING' | 'SENT' | 'FAILED' | 'PAUSED';
export type WaAccountStatus = 'ACTIVE' | 'WARMUP' | 'PAUSED' | 'BANNED';
export type WaProvider = 'BAILEYS' | 'META_CLOUD' | 'FONNTE' | 'WABLAS';
export type TTSMode = 'AUTO_ADAPTIVE' | 'CHIME_ONLY' | 'FULL_NAME';
export type AcademicTransitionType =
  | 'BARU'
  | 'NAIK_KELAS'
  | 'TINGGAL_KELAS'
  | 'PINDAH_KELAS'
  | 'LULUS'
  | 'TETAP';

export interface User {
  id: number;
  name: string;
  email: string;
  role: UserRole;
  is_active: boolean;
  password_hash?: string;
}

export interface Jurusan {
  id: number;
  kode: string;
  nama: string;
}

export interface Kelas {
  id: number;
  jurusan_id: number;
  tingkat: string;
  nama: string;
  shift: 'PAGI' | 'SIANG' | 'NONE';
}

export interface Student {
  id: number;
  nis: string;
  nisn: string;
  nama: string;
  nickname: string;
  kelas_id: number;
  tanggal_lahir: string;
  status: StudentStatus;
  embedding: number[] | null;
  embedding_quality_score: number;
  embedding_updated_at: string | null;
  foto_ref: string | null;
  wa_ortu: string;
  created_at: string;
}

export interface Gate {
  id: number;
  nama_gerbang: string;
  lokasi: string;
  tipe: GateType;
}

export interface Camera {
  id: number;
  nama_kamera: string;
  gate_id: number;
  rtsp_url: string;
  resolusi: string;
  fps: number;
  aktif: boolean;
  status: 'ONLINE' | 'OFFLINE' | 'ERROR';
  last_error: string | null;
  last_online_at: string | null;
}

export interface Schedule {
  id: number;
  jurusan_id: number | null;
  hari: number; // 1=Senin .. 7=Minggu
  jam_masuk_mulai: string;
  jam_masuk_selesai: string;
  jam_keluar_mulai: string;
  jam_keluar_selesai: string;
  toleransi_terlambat_menit: number;
}

export interface KelasScheduleOverride {
  id: number;
  kelas_id: number;
  hari: number;
  jam_masuk_mulai: string;
  jam_masuk_selesai: string;
  jam_keluar_mulai: string;
  jam_keluar_selesai: string;
  alasan: string;
}

export interface ScheduleException {
  id: number;
  tanggal: string;
  scope: ExceptionScope;
  ref_id: number | null;
  tipe: ExceptionType;
  catatan: string;
  jam_masuk_override: string | null;
  jam_keluar_override: string | null;
}

export interface AttendanceLog {
  id: number;
  student_id: number;
  gate_id: number;
  camera_id: number;
  timestamp: string;
  tipe: LogType;
  status: 'HADIR' | 'TERLAMBAT';
  is_manual_override: boolean;
  similarity_score?: number;
}

export interface DailyAttendance {
  id: number;
  student_id: number;
  tanggal: string;
  jam_masuk: string | null;
  jam_keluar: string | null;
  status: AttendanceStatus;
  manual_override_by: number | null;
  manual_override_at: string | null;
  catatan?: string | null;
}

export interface AnonymousCluster {
  id: number;
  centroid: number[];
  hit_count: number;
  distinct_days: number;
  first_seen: string;
  last_seen: string;
  best_snapshot_path: string;
  best_quality_score: number;
  best_embedding: number[];
  status: ClusterStatus;
  named_student_id: number | null;
  last_camera_id: number | null;
}

export interface Visitor {
  id: number;
  nama: string;
  kategori: 'TAMU' | 'STAF';
  snapshot_path: string;
  catatan: string;
  created_at: string;
}

export interface FaceUpdateHistory {
  id: number;
  student_id: number;
  version: number;
  embedding: number[];
  quality_score: number;
  snapshot_path: string;
  created_at: string;
  approved_by: number | null;
  approved_at: string | null;
  is_canonical: boolean;
}

export interface FaceUpdateReview {
  id: number;
  student_id: number;
  month: number;
  year: number;
  candidate_snapshots: Array<{
    history_id: number;
    snapshot_path: string;
    quality_score: number;
    created_at: string;
  }>;
  current_quality: number;
  best_new_quality: number;
  status: ReviewStatus;
  reviewed_by: number | null;
  reviewed_at: string | null;
}

export interface WaQueue {
  id: number;
  student_id: number | null;
  phone: string;
  payload: {
    nama: string;
    kelas: string;
    tanggal: string;
    jam_masuk: string;
    jam_keluar: string;
    status: string;
  };
  status: WaQueueStatus;
  retry_count: number;
  scheduled_at: string;
  sent_at: string | null;
  error_msg: string | null;
}

export interface WaAccount {
  id: number;
  provider: WaProvider;
  phone_number: string;
  api_key: string;
  status: WaAccountStatus;
  daily_count: number;
  hourly_count: number;
  last_reset_at: string;
  created_at: string;
  qr_connected?: boolean;
}

export interface WaTemplate {
  id: number;
  code: string;
  name: string;
  template_text: string;
  is_active: boolean;
}

export interface NotificationItem {
  id: number;
  user_id: number | null;
  role_target: UserRole;
  type: string;
  title: string;
  message: string;
  is_read: boolean;
  created_at: string;
}

export interface GuestAccessLog {
  id: number;
  ip: string;
  timestamp: string;
  success: boolean;
  nisn_attempted: string;
}

export interface SettingsMap {
  school_name: string;
  threshold_confidence: number;
  threshold_recognition: number;
  threshold_clustering: number;
  min_face_size: number;
  cluster_ready_hits: number;
  cluster_ready_days: number;
  cluster_sighting_interval_min: number;
  cluster_archive_days: number;
  cluster_delete_days: number;
  weight_confidence: number;
  weight_size: number;
  weight_sharpness: number;
  weight_frontal: number;
  cutoff_keluar: string;
  wa_provider: WaProvider;
  wa_api_key: string;
  wa_phone_number_id: string;
  wa_delay_after_pulang_menit: number;
  wa_auto_dispatch_enabled: boolean;
  tts_mode: TTSMode;
  tts_max_age_sec: number;
  tts_burst_threshold: number;
  face_maintenance_target: number;
  auto_backup_enabled: boolean;
  backup_retention_count: number;
  production_mode?: boolean;
}

export interface BackupEntry {
  filename: string;
  bytes: number;
  created_at: string;
}

export interface WorkerCameraStat {
  camera_id: number;
  nama_kamera: string;
  connected: boolean;
  frames_decoded: number;
  faces_detected_total: number;
  last_frame_at: string | null;
  last_face_at: string | null;
  last_error: string | null;
}

export interface WorkerStatusResponse {
  engine: 'INSIGHTFACE_PYTHON' | 'NODE_WASM_LIVE' | 'IDLE';
  node_env: string;
  production_mode: boolean;
  model_loaded: boolean;
  active_workers: number;
  cameras: WorkerCameraStat[];
}

export interface AppDatabase {
  users: User[];
  jurusans: Jurusan[];
  kelas: Kelas[];
  students: Student[];
  gates: Gate[];
  cameras: Camera[];
  schedules: Schedule[];
  kelas_overrides: KelasScheduleOverride[];
  schedule_exceptions: ScheduleException[];
  attendance_logs: AttendanceLog[];
  daily_attendance: DailyAttendance[];
  anonymous_clusters: AnonymousCluster[];
  visitors: Visitor[];
  face_update_history: FaceUpdateHistory[];
  face_update_reviews: FaceUpdateReview[];
  wa_queue: WaQueue[];
  wa_accounts: WaAccount[];
  wa_templates: WaTemplate[];
  notifications: NotificationItem[];
  guest_access_logs: GuestAccessLog[];
  settings: SettingsMap;
  storage_bytes_simulated: number;
}
