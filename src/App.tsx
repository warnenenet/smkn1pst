import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Menu } from 'lucide-react';
import { Sidebar, type NavTab } from './components/Sidebar';
import { DashboardView } from './components/DashboardView';
import { AttendanceView } from './components/AttendanceView';
import { ReportsView } from './components/ReportsView';
import { StudentsView } from './components/StudentsView';
import { ClustersView } from './components/ClustersView';
import { FaceReviewView } from './components/FaceReviewView';
import { CamerasGatesView } from './components/CamerasGatesView';
import {
  SchedulesView,
  type ExceptionPayload,
  type OverridePayload,
  type SchedulePayload,
} from './components/SchedulesView';
import { WhatsAppView } from './components/WhatsAppView';
import { SettingsUsersView } from './components/SettingsUsersView';
import { CallPageView } from './components/CallPageView';
import { GuestPortalView } from './components/GuestPortalView';
import { LoginView } from './components/LoginView';
import { shouldPauseBackgroundBootstrap } from './lib/uiRefreshGuard';
import type {
  AppDatabase,
  AttendanceStatus,
  GateType,
  SettingsMap,
  StudentStatus,
  User,
  WorkerStatusResponse,
} from './types';

const TAB_TITLES: Record<NavTab, string> = {
  dashboard: 'Dashboard Utama',
  attendance: 'Absensi Harian & Koreksi BK',
  reports: 'Laporan & Export CSV / PDF',
  students: 'Manajemen Siswa, Jurusan & Excel',
  clusters: 'Penamaan Wajah Anonim (Guru BK)',
  reviews: 'Face Update Review Bulanan (Guru BK)',
  cameras: 'Gerbang & Kamera RTSP',
  schedules: 'Jadwal, Override Kelas & Exception',
  whatsapp: 'WhatsApp Gateway & Antrean',
  settings: 'Pengaturan Sistem, User & Notifikasi',
};

const ROLE_ALLOWED_TABS: Record<User['role'], NavTab[]> = {
  ADMIN: ['dashboard', 'attendance', 'reports', 'students', 'clusters', 'reviews', 'cameras', 'schedules', 'whatsapp', 'settings'],
  BK: ['dashboard', 'attendance', 'reports', 'students', 'clusters', 'reviews', 'schedules', 'whatsapp'],
  GURU: ['dashboard', 'attendance', 'reports'],
};

type RouteMode = 'home' | 'ortu' | 'login' | 'panggil';

function parseRoute(pathname: string): { mode: RouteMode; cameraId: number } {
  if (pathname.startsWith('/panggil/')) {
    return { mode: 'panggil', cameraId: Number(pathname.split('/')[2]) || 1 };
  }
  if (pathname === '/ortu' || pathname === '/guest') {
    return { mode: 'ortu', cameraId: 1 };
  }
  if (pathname === '/login') {
    return { mode: 'login', cameraId: 1 };
  }
  return { mode: 'home', cameraId: 1 };
}

export default function App() {
  const [authLoading, setAuthLoading] = useState(true);
  const [authUser, setAuthUser] = useState<User | null>(null);
  const [schoolName, setSchoolName] = useState('SMK Negeri Unggulan');
  const [productionMode, setProductionMode] = useState(true);
  const [db, setDb] = useState<AppDatabase | null>(null);
  const [workerStatus, setWorkerStatus] = useState<WorkerStatusResponse | null>(null);
  const [activeTab, setActiveTab] = useState<NavTab>('dashboard');
  const [mobileOpen, setMobileOpen] = useState(false);
  const [toast, setToast] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);
  const toastTimerRef = useRef<number | null>(null);

  const [routeView, setRouteView] = useState<{ mode: RouteMode; cameraId: number }>(() =>
    parseRoute(window.location.pathname)
  );

  const notify = useCallback((text: string, type: 'ok' | 'err' = 'ok') => {
    setToast({ text, type });
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => setToast(null), 4500);
  }, []);

  const navigateRoute = (mode: RouteMode, cameraId = 1) => {
    const target =
      mode === 'panggil'
        ? `/panggil/${cameraId}`
        : mode === 'ortu'
          ? '/ortu'
          : mode === 'login'
            ? '/login'
            : '/';
    if (window.location.pathname !== target) {
      window.history.pushState({}, '', target);
    }
    setRouteView({ mode, cameraId });
  };

  const fetchBootstrap = useCallback(async () => {
    const res = await fetch('/api/bootstrap');
    if (res.status === 401) {
      setAuthUser(null);
      setDb(null);
      return;
    }
    if (!res.ok) return;
    const data: AppDatabase = await res.json();
    setDb(data);
    if (data.settings?.school_name) setSchoolName(data.settings.school_name);
    setProductionMode(Boolean(data.settings?.production_mode));
  }, []);

  const fetchWorkerStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/worker/status');
      if (!res.ok) return;
      const data: WorkerStatusResponse = await res.json();
      setWorkerStatus(data);
    } catch {
      // ignore transient poll error
    }
  }, []);

  useEffect(() => {
    let active = true;
    fetch('/api/auth/me')
      .then((r) => r.json())
      .then(async (data) => {
        if (!active) return;
        if (data.school_name) setSchoolName(data.school_name);
        setProductionMode(Boolean(data.production_mode));
        if (data.authenticated && data.user) {
          setAuthUser(data.user);
          await Promise.all([fetchBootstrap(), fetchWorkerStatus()]);
        } else {
          setAuthUser(null);
          setDb(null);
        }
      })
      .catch(() => {
        if (active) setAuthUser(null);
      })
      .finally(() => {
        if (active) setAuthLoading(false);
      });

    const onPop = () => {
      setRouteView(parseRoute(window.location.pathname));
    };
    window.addEventListener('popstate', onPop);
    return () => {
      active = false;
      window.removeEventListener('popstate', onPop);
    };
  }, [fetchBootstrap, fetchWorkerStatus]);

  useEffect(() => {
    if (authUser && !ROLE_ALLOWED_TABS[authUser.role].includes(activeTab)) {
      setActiveTab('dashboard');
    }
  }, [authUser, activeTab]);

  useEffect(() => {
    if (authUser && routeView.mode === 'login') {
      window.history.replaceState({}, '', '/');
      setRouteView({ mode: 'home', cameraId: 1 });
    }
  }, [authUser, routeView.mode]);

  const activeTabRef = useRef<NavTab>(activeTab);
  useEffect(() => {
    activeTabRef.current = activeTab;
  }, [activeTab]);

  // Poll worker status every 10s + bootstrap every 15s (ONLY when not on config/form tabs and not typing) + WebSocket
  useEffect(() => {
    if (!authUser || routeView.mode !== 'home') return;

    let disposed = false;
    let ws: WebSocket | null = null;
    let reconnectTimer: number | null = null;
    let reconnectAttempt = 0;
    let refreshInFlight = false;

    const canRefreshBootstrapNow = () => {
      const el = document.activeElement as HTMLElement | null;
      return !shouldPauseBackgroundBootstrap({
        activeTab: activeTabRef.current,
        activeElementTag: el?.tagName ?? null,
        isContentEditable: Boolean(el?.isContentEditable),
      });
    };

    const refreshAll = async (includeBootstrap: boolean) => {
      if (disposed || refreshInFlight) return;
      const shouldFetchBoot = includeBootstrap && canRefreshBootstrapNow();
      refreshInFlight = true;
      try {
        if (shouldFetchBoot) {
          await Promise.all([fetchBootstrap(), fetchWorkerStatus()]);
        } else {
          await fetchWorkerStatus();
        }
      } finally {
        refreshInFlight = false;
      }
    };

    refreshAll(false);
    const poll = window.setInterval(() => {
      if (document.visibilityState === 'visible') {
        refreshAll(true);
      }
    }, 15000);

    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        refreshAll(true);
      }
    };
    document.addEventListener('visibilitychange', onVisibility);

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const connectWs = () => {
      if (disposed) return;
      try {
        ws = new WebSocket(`${protocol}//${window.location.host}/ws`);
        ws.onopen = () => {
          reconnectAttempt = 0;
        };
        ws.onmessage = (ev) => {
          try {
            const msg = JSON.parse(String(ev.data));
            const evName = msg.event ?? msg.type;
            if (evName === 'face_detected' || evName === 'student_recognized') {
              refreshAll(true);
              if (msg.nama || msg.studentName) {
                notify(`Terdeteksi: ${msg.nama ?? msg.studentName} (${msg.kelas ?? 'CCTV'})`);
              } else if (msg.message) {
                notify(String(msg.message));
              } else if (msg.cluster_id ?? msg.clusterId) {
                notify(`Wajah anonim terdeteksi — Cluster #${msg.cluster_id ?? msg.clusterId}`);
              }
            } else if (evName === 'attendance_updated' || evName === 'face_update_approved') {
              refreshAll(true);
            } else if (evName === 'camera_heartbeat') {
              refreshAll(false);
            } else if (evName === 'cluster_ready' || evName === 'anonymous_cluster_ready') {
              refreshAll(true);
              notify(`Cluster Anonim #${msg.cluster_id ?? msg.clusterId ?? ''} siap dinamai oleh Guru BK!`);
            }
          } catch {
            // ignore non-json message
          }
        };
        ws.onclose = () => {
          if (disposed) return;
          reconnectAttempt += 1;
          const delay = Math.min(10000, 3000 + reconnectAttempt * 1500);
          reconnectTimer = window.setTimeout(connectWs, delay);
        };
      } catch {
        // ignore ws init failure
      }
    };
    connectWs();

    return () => {
      disposed = true;
      window.clearInterval(poll);
      document.removeEventListener('visibilitychange', onVisibility);
      if (reconnectTimer) window.clearTimeout(reconnectTimer);
      if (ws) {
        try {
          ws.close();
        } catch {
          // ignore
        }
      }
    };
  }, [authUser, routeView.mode, fetchBootstrap, fetchWorkerStatus, notify]);

  const apiPost = async (url: string, body: unknown = {}, method: 'POST' | 'PUT' | 'DELETE' = 'POST') => {
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: method === 'DELETE' ? undefined : JSON.stringify(body),
    });
    if (res.status === 401) {
      setAuthUser(null);
      setDb(null);
      navigateRoute('login');
      throw new Error('Sesi berakhir, silakan login ulang.');
    }
    const data = await res.json();
    if (!res.ok) {
      notify(data.error || 'Terjadi kesalahan permintaan.', 'err');
      throw new Error(data.error || 'Request failed');
    }
    await Promise.all([fetchBootstrap(), fetchWorkerStatus()]);
    return data;
  };

  const handleActivateProduction = async (
    opts: { cleanDemoData: boolean; production_mode: boolean } = { cleanDemoData: true, production_mode: true }
  ) => {
    const res = await apiPost('/api/system/activate-production', opts);
    if (opts.production_mode) {
      notify(
        `Mode Produksi aktif (${res.remaining_cameras} kamera RTSP dipertahankan, ${res.remaining_students} siswa tersisa).`
      );
    } else {
      notify('Tombol simulasi uji diaktifkan kembali.');
    }
  };

  const handleLogout = async () => {
    await fetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
    setAuthUser(null);
    setDb(null);
    setWorkerStatus(null);
    setActiveTab('dashboard');
    navigateRoute('ortu');
  };

  // Kiosk Panggil (/panggil/:cameraId) berjalan mandiri untuk layar monitor gerbang tanpa perlu login admin
  if (routeView.mode === 'panggil') {
    return (
      <CallPageView
        cameraId={routeView.cameraId}
        isAuthenticated={Boolean(authUser)}
        onBack={() => navigateRoute(authUser ? 'home' : 'ortu')}
        onTriggerDemoEvent={
          authUser
            ? async (studentId) => {
                await apiPost('/api/simulate-recognition', {
                  camera_id: routeView.cameraId,
                  student_id: studentId,
                  anonymous: !studentId,
                  confidence: 0.94,
                  forceCall: true,
                });
              }
            : undefined
        }
      />
    );
  }

  if (authLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 text-sm text-slate-500">
        Memeriksa sesi sistem Absensi SMK Face AI...
      </div>
    );
  }

  if (routeView.mode === 'login') {
    return (
      <LoginView
        schoolName={schoolName}
        onSuccess={async (user) => {
          setAuthUser(user);
          setActiveTab('dashboard');
          navigateRoute('home');
          await Promise.all([fetchBootstrap(), fetchWorkerStatus()]);
        }}
        onBackToPortal={() => navigateRoute('ortu')}
      />
    );
  }

  // Halaman depan publik (/) saat belum login dan route /ortu langsung membuka Portal Orang Tua
  if (routeView.mode === 'ortu' || !authUser) {
    return (
      <GuestPortalView
        schoolName={schoolName}
        isAuthenticated={Boolean(authUser)}
        productionMode={productionMode}
        onBack={() => navigateRoute('home')}
        onLoginClick={() => navigateRoute('login')}
      />
    );
  }

  if (!db) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 text-sm text-slate-500">
        Memuat data dashboard Absensi SMK Face AI...
      </div>
    );
  }

  const readyClustersCount = db.anonymous_clusters.filter((c) => c.status === 'READY').length;
  const pendingReviewsCount = db.face_update_reviews.filter((r) => r.status === 'PENDING').length;
  const unreadNotifsCount = db.notifications.filter((n) => !n.is_read).length;
  const isProduction = Boolean(db.settings.production_mode);
  const defaultCameraId = db.cameras.find((c) => c.aktif)?.id ?? db.cameras[0]?.id ?? 1;

  return (
    <div className="min-h-screen flex bg-slate-50 text-slate-900">
      <Sidebar
        activeTab={activeTab}
        onSelectTab={setActiveTab}
        currentUser={authUser}
        onLogout={handleLogout}
        readyClustersCount={readyClustersCount}
        pendingReviewsCount={pendingReviewsCount}
        unreadNotificationsCount={unreadNotifsCount}
        onOpenPanggil={(camId) => navigateRoute('panggil', camId)}
        onOpenGuest={() => navigateRoute('ortu')}
        mobileOpen={mobileOpen}
        onCloseMobile={() => setMobileOpen(false)}
        defaultCameraId={defaultCameraId}
      />

      <div className="flex-1 flex flex-col min-w-0">
        <header className="bg-white border-b border-slate-200 px-6 py-3.5 flex items-center justify-between gap-8">
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              onClick={() => setMobileOpen(true)}
              aria-label="Buka menu navigasi"
              className="lg:hidden p-1.5 rounded-md border border-slate-200 text-slate-700"
            >
              <Menu className="w-4 h-4" />
            </button>
            <h1 className="text-base font-bold text-slate-900 truncate">
              {activeTab === 'attendance' && !isProduction
                ? 'Absensi Harian & Simulasi Kamera'
                : TAB_TITLES[activeTab]}
            </h1>
          </div>

          <div className="flex items-center gap-4 shrink-0">
            <span className="hidden sm:inline text-xs text-slate-500 whitespace-nowrap">
              {db.settings.school_name} · <span className="font-mono">{authUser.role}</span>
            </span>
            {isProduction ? (
              <span className="text-xs font-mono font-semibold text-emerald-700 whitespace-nowrap shrink-0">
                PRODUKSI LIVE
              </span>
            ) : (
              <button
                type="button"
                onClick={() => setActiveTab('attendance')}
                className="px-3.5 py-1.5 text-xs font-semibold text-white bg-blue-700 hover:bg-blue-800 rounded-md whitespace-nowrap shrink-0"
              >
                Simulasi Kamera
              </button>
            )}
          </div>
        </header>

        <main className="flex-1 p-6 max-w-7xl w-full mx-auto">
          {toast && (
            <div
              role="status"
              className={`mb-5 px-4 py-2.5 rounded-md border text-xs font-medium ${
                toast.type === 'ok'
                  ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
                  : 'bg-red-50 border-red-200 text-red-800'
              }`}
            >
              {toast.text}
            </div>
          )}

          {activeTab === 'dashboard' && (
            <DashboardView
              db={db}
              workerStatus={workerStatus}
              onCleanupStorage={async () => {
                const res = await apiPost('/api/storage/cleanup');
                notify(`Pembersihan storage selesai (${res.freed_mb} MB dibebaskan).`);
              }}
              onMarkAllRead={async () => {
                await apiPost('/api/notifications/read-all');
                notify('Semua notifikasi ditandai sudah dibaca.');
              }}
              onActivateProduction={
                authUser.role === 'ADMIN'
                  ? async () => {
                      await handleActivateProduction({ cleanDemoData: true, production_mode: true });
                    }
                  : undefined
              }
              onMigrateEmbeddings={
                authUser.role === 'ADMIN'
                  ? async () => {
                      const res = await apiPost('/api/system/migrate-embeddings', {});
                      notify(
                        `Migrasi non-destruktif selesai: ${res.migrated_students} siswa & ${res.migrated_clusters} cluster disinkronkan ke ${res.expected_dims}-D (${res.skipped_no_local_photo} tanpa foto lokal).`
                      );
                    }
                  : undefined
              }
              onOpenPanggil={(camId) => navigateRoute('panggil', camId)}
              onNavigateTab={(tab) => setActiveTab(tab)}
            />
          )}

          {activeTab === 'attendance' && (
            <AttendanceView
              db={db}
              currentUserRole={authUser.role}
              onOverrideStatus={async (studentId, tanggal, status: AttendanceStatus, catatan?: string) => {
                await apiPost('/api/attendance/override', { student_id: studentId, tanggal, status, catatan });
                notify(`Status absensi diperbarui menjadi ${status}.`);
              }}
              onSimulateRecognition={async (payload) => {
                const res = await apiPost('/api/simulate-recognition', payload);
                if (res.ignored) return res.reason;
                if (res.anonymous) return `Wajah anonim dicatat (Quality ${res.quality_score}) & dikirim ke Kiosk.`;
                return `Event ${res.logType} (${res.logStatus}) dicatat · Quality ${res.quality_score}${res.embeddingUpdated ? ' · Embedding Real-Time Diperbarui' : ''}`;
              }}
            />
          )}

          {activeTab === 'reports' && <ReportsView db={db} />}

          {activeTab === 'students' && (
            <StudentsView
              db={db}
              onAddStudent={async (payload: {
                nis: string;
                nisn: string;
                nama: string;
                nickname: string;
                kelas_id: number;
                tanggal_lahir: string;
                status: StudentStatus;
                wa_ortu: string;
              }) => {
                await apiPost('/api/students', payload);
                notify('Siswa baru berhasil ditambahkan.');
              }}
              onDeleteStudent={async (id) => {
                await apiPost(`/api/students/${id}`, {}, 'DELETE');
                notify('Data siswa dihapus.');
              }}
              onEnrollSingle={async (id, photoDataUrl) => {
                const res = await apiPost(`/api/students/${id}/enroll`, { photoDataUrl });
                notify(`Enrollment wajah berhasil (Skor ${res.quality_score}).`);
              }}
              onEnrollBatch={async (entries) => {
                const res = await apiPost('/api/students/enroll-batch', { entries });
                const msg = `Batch enrollment selesai: ${res.success}/${res.processed} siswa berhasil.`;
                notify(msg);
                return msg;
              }}
              onImportExcel={async (payload) => {
                const res = await apiPost('/api/students/import-excel', payload);
                notify(
                  `Import Excel selesai: ${res.imported} baru, ${res.promoted ?? 0} naik kelas, ${res.retained ?? 0} tinggal kelas, ${res.graduated ?? 0} lulus.`
                );
                return res;
              }}
              onAddJurusan={async (payload) => {
                await apiPost('/api/jurusans', payload);
                notify(`Jurusan ${payload.kode} ditambahkan.`);
              }}
              onDeleteJurusan={async (id) => {
                await apiPost(`/api/jurusans/${id}`, {}, 'DELETE');
                notify('Jurusan dihapus.');
              }}
              onAddKelas={async (payload) => {
                await apiPost('/api/kelas', payload);
                notify(`Kelas ${payload.nama} ditambahkan.`);
              }}
              onDeleteKelas={async (id) => {
                await apiPost(`/api/kelas/${id}`, {}, 'DELETE');
                notify('Kelas dihapus.');
              }}
              onCompareFace={async (p1, p2) => {
                const res = await fetch('/api/compare-face', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    name1: p1.name,
                    size1: p1.size,
                    photo1DataUrl: p1.photoDataUrl,
                    name2: p2.name,
                    size2: p2.size,
                    photo2DataUrl: p2.photoDataUrl,
                  }),
                });
                return res.json();
              }}
            />
          )}

          {activeTab === 'clusters' && (
            <ClustersView
              db={db}
              workerStatus={workerStatus}
              onAssignCluster={async (cid, sid) => {
                await apiPost(`/api/clusters/${cid}/assign`, { student_id: sid });
                notify('Cluster anonim berhasil ditautkan ke siswa.');
              }}
              onCreateStudentFromCluster={async (cid, payload) => {
                await apiPost(`/api/clusters/${cid}/new-student`, payload);
                notify('Siswa baru dibuat dan embedding dipindahkan.');
              }}
              onMarkVisitor={async (cid, payload) => {
                await apiPost(`/api/clusters/${cid}/visitor`, payload);
                notify('Wajah ditandai sebagai Tamu/Staf.');
              }}
              onDeleteCluster={async (cid) => {
                await apiPost(`/api/clusters/${cid}`, {}, 'DELETE');
                notify(`Cluster anonim #${cid} dihapus.`);
              }}
            />
          )}

          {activeTab === 'reviews' && (
            <FaceReviewView
              db={db}
              onApprove={async (revId, histId) => {
                await apiPost(`/api/face-reviews/${revId}/approve`, { history_id: histId });
                notify('Kandidat wajah disetujui sebagai versi kanonik.');
              }}
              onRollback={async (revId) => {
                await apiPost(`/api/face-reviews/${revId}/rollback`);
                notify('Embedding dikembalikan ke versi kanonik sebelumnya.');
              }}
              onApproveAll={async () => {
                await apiPost('/api/face-reviews/approve-all');
                notify('Semua kandidat PENDING berhasil disetujui.');
              }}
            />
          )}

          {activeTab === 'cameras' && (
            <CamerasGatesView
              db={db}
              workerStatus={workerStatus}
              onAddGate={async (payload: { nama_gerbang: string; lokasi: string; tipe: GateType }) => {
                await apiPost('/api/gates', payload);
                notify('Gerbang ditambahkan.');
              }}
              onDeleteGate={async (id) => {
                await apiPost(`/api/gates/${id}`, {}, 'DELETE');
                notify('Gerbang dihapus.');
              }}
              onAddCamera={async (payload) => {
                await apiPost('/api/cameras', payload);
                notify('Kamera ditambahkan.');
              }}
              onToggleCamera={async (id, aktif) => {
                await apiPost(`/api/cameras/${id}`, { aktif }, 'PUT');
                notify('Status kamera diperbarui.');
              }}
              onDeleteCamera={async (id) => {
                await apiPost(`/api/cameras/${id}`, {}, 'DELETE');
                notify('Kamera dihapus.');
              }}
              onProbeCamera={async (payload) => {
                const res = await apiPost('/api/cameras/probe', payload);
                notify(`Kamera RTSP ONLINE (${res.codec} ${res.resolusi} @ ${res.fps} FPS, ${res.latency_ms} ms).`);
                return res;
              }}
              onOpenPanggil={(camId) => navigateRoute('panggil', camId)}
            />
          )}

          {activeTab === 'schedules' && (
            <SchedulesView
              db={db}
              onAddSchedule={async (payload: SchedulePayload) => {
                await apiPost('/api/schedules', payload);
                notify('Jadwal berhasil ditambahkan.');
              }}
              onUpdateSchedule={async (id: number, payload: SchedulePayload) => {
                await apiPost(`/api/schedules/${id}`, payload, 'PUT');
                notify(`Jadwal #${id} berhasil diperbarui.`);
              }}
              onDeleteSchedule={async (id: number) => {
                await apiPost(`/api/schedules/${id}`, {}, 'DELETE');
                notify('Jadwal berhasil dihapus.');
              }}
              onAddOverride={async (payload: OverridePayload) => {
                await apiPost('/api/schedules/override', payload);
                notify('Override jadwal kelas disimpan.');
              }}
              onUpdateOverride={async (id: number, payload: OverridePayload) => {
                await apiPost(`/api/schedules/override/${id}`, payload, 'PUT');
                notify(`Override kelas #${id} diperbarui.`);
              }}
              onDeleteOverride={async (id: number) => {
                await apiPost(`/api/schedules/override/${id}`, {}, 'DELETE');
                notify('Override jadwal kelas dihapus.');
              }}
              onAddException={async (payload: ExceptionPayload) => {
                await apiPost('/api/schedules/exception', payload);
                notify('Exception tanggal disimpan.');
              }}
              onUpdateException={async (id: number, payload: ExceptionPayload) => {
                await apiPost(`/api/schedules/exception/${id}`, payload, 'PUT');
                notify(`Exception tanggal #${id} diperbarui.`);
              }}
              onDeleteException={async (id: number) => {
                await apiPost(`/api/schedules/exception/${id}`, {}, 'DELETE');
                notify('Exception tanggal dihapus.');
              }}
            />
          )}

          {activeTab === 'whatsapp' && (
            <WhatsAppView
              db={db}
              onSaveSettings={async (patch: Partial<SettingsMap>) => {
                await apiPost('/api/settings', patch);
                notify('Konfigurasi WhatsApp disimpan.');
              }}
              onAddAccount={async (phone) => {
                await apiPost('/api/wa/accounts', { phone_number: phone });
                notify('Nomor Baileys ditambahkan dalam mode WARMUP.');
              }}
              onConnectAccount={async (id) => {
                await apiPost(`/api/wa/accounts/${id}/connect`);
                notify('Akun Baileys berhasil terhubung via QR.');
              }}
              onTestSend={async (phone, message) => {
                const res = await apiPost('/api/wa/test', { phone, message });
                notify('Pesan tes WhatsApp dikirim ke log.');
                return res.preview;
              }}
              onUpdateTemplate={async (id, text) => {
                await apiPost(`/api/wa/templates/${id}`, { template_text: text }, 'PUT');
                notify('Template WhatsApp diperbarui.');
              }}
              onRetryQueue={async (id) => {
                await apiPost(`/api/wa/queue/${id}/retry`);
                notify('Pesan dijadwalkan ulang.');
              }}
              onDispatchDailyNow={async () => {
                const res = await apiPost('/api/wa/dispatch-daily-now');
                notify(`Rekap WA dijadwalkan: ${res.queued} pesan baru.`);
                return res;
              }}
            />
          )}

          {activeTab === 'settings' && (
            <SettingsUsersView
              db={db}
              workerStatus={workerStatus}
              onSaveSettings={async (patch) => {
                await apiPost('/api/settings', patch);
                notify('Pengaturan sistem disimpan.');
              }}
              onActivateProduction={handleActivateProduction}
              onAddUser={async (payload) => {
                await apiPost('/api/users', payload);
                notify('User baru ditambahkan.');
              }}
              onToggleUser={async (id) => {
                await apiPost(`/api/users/${id}/toggle`);
                notify('Status user diperbarui.');
              }}
              onMarkRead={async (id) => {
                await apiPost(`/api/notifications/${id}/read`);
              }}
              onChangePassword={async (payload) => {
                await apiPost('/api/auth/change-password', payload);
                notify('Password berhasil diperbarui.');
              }}
              onBackupFinished={async () => {
                await fetchBootstrap();
                notify('Database berhasil di-restore dan dimuat ulang.');
              }}
            />
          )}
        </main>
      </div>
    </div>
  );
}
