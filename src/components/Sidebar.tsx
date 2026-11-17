import React from 'react';
import {
  LayoutDashboard,
  ClipboardCheck,
  FileBarChart2,
  Users,
  UserCheck,
  ScanFace,
  Camera,
  CalendarClock,
  MessageSquare,
  Settings,
  Bell,
  ExternalLink,
  ShieldCheck,
  LogOut,
} from 'lucide-react';
import type { User } from '../types';

export type NavTab =
  | 'dashboard'
  | 'attendance'
  | 'reports'
  | 'students'
  | 'clusters'
  | 'reviews'
  | 'cameras'
  | 'schedules'
  | 'whatsapp'
  | 'settings';

interface SidebarProps {
  activeTab: NavTab;
  onSelectTab: (tab: NavTab) => void;
  currentUser: User;
  onLogout: () => void;
  readyClustersCount: number;
  pendingReviewsCount: number;
  unreadNotificationsCount: number;
  onOpenPanggil: (camId: number) => void;
  onOpenGuest: () => void;
  mobileOpen: boolean;
  onCloseMobile: () => void;
  defaultCameraId?: number;
}

export const Sidebar: React.FC<SidebarProps> = ({
  activeTab,
  onSelectTab,
  currentUser,
  onLogout,
  readyClustersCount,
  pendingReviewsCount,
  unreadNotificationsCount,
  onOpenPanggil,
  onOpenGuest,
  mobileOpen,
  onCloseMobile,
  defaultCameraId = 1,
}) => {
  const role = currentUser.role;
  const allItems: Array<{
    id: NavTab;
    label: string;
    icon: React.ReactNode;
    count?: number;
    roles: Array<User['role']>;
  }> = [
    { id: 'dashboard', label: 'Dashboard', icon: <LayoutDashboard className="w-4 h-4" />, roles: ['ADMIN', 'BK', 'GURU'] },
    { id: 'attendance', label: 'Absensi Harian', icon: <ClipboardCheck className="w-4 h-4" />, roles: ['ADMIN', 'BK', 'GURU'] },
    { id: 'reports', label: 'Laporan & Export', icon: <FileBarChart2 className="w-4 h-4" />, roles: ['ADMIN', 'BK', 'GURU'] },
    { id: 'students', label: 'Siswa, Jurusan & Excel', icon: <Users className="w-4 h-4" />, roles: ['ADMIN', 'BK'] },
    { id: 'clusters', label: 'Penamaan Anonim', icon: <UserCheck className="w-4 h-4" />, count: readyClustersCount, roles: ['ADMIN', 'BK'] },
    { id: 'reviews', label: 'Face Update Review', icon: <ScanFace className="w-4 h-4" />, count: pendingReviewsCount, roles: ['ADMIN', 'BK'] },
    { id: 'cameras', label: 'Gerbang & Kamera', icon: <Camera className="w-4 h-4" />, roles: ['ADMIN'] },
    { id: 'schedules', label: 'Jadwal & Exception', icon: <CalendarClock className="w-4 h-4" />, roles: ['ADMIN', 'BK'] },
    { id: 'whatsapp', label: 'WhatsApp Gateway', icon: <MessageSquare className="w-4 h-4" />, roles: ['ADMIN', 'BK'] },
    { id: 'settings', label: 'Pengaturan & User', icon: <Settings className="w-4 h-4" />, count: unreadNotificationsCount, roles: ['ADMIN'] },
  ];

  const navItems = allItems.filter((item) => item.roles.includes(role));

  return (
    <>
      {mobileOpen && (
        <div
          className="fixed inset-0 bg-slate-900/40 z-30 lg:hidden"
          onClick={onCloseMobile}
          aria-hidden="true"
        />
      )}
      <aside
        className={`fixed lg:static inset-y-0 left-0 z-40 w-64 bg-slate-900 text-slate-200 flex flex-col border-r border-slate-800 transition-transform duration-200 ${
          mobileOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'
        }`}
      >
        <div className="px-5 py-4 border-b border-slate-800">
          <div className="text-sm font-bold tracking-tight text-white">Absensi SMK Face AI</div>
          <div className="text-xs text-slate-400 mt-0.5">Multi-Gerbang &amp; RTSP</div>
        </div>

        <div className="px-4 py-3 border-b border-slate-800">
          <div className="flex items-center gap-2.5">
            <ShieldCheck className="w-4 h-4 text-blue-400 shrink-0" />
            <div className="min-w-0 flex-1">
              <div className="text-xs font-semibold text-white truncate">{currentUser.name}</div>
              <div className="text-[11px] font-mono text-blue-300">{currentUser.role}</div>
            </div>
          </div>
        </div>

        <nav className="flex-1 overflow-y-auto px-3 py-3 space-y-0.5" aria-label="Navigasi Utama">
          {navItems.map((item) => {
            const active = activeTab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => {
                  onSelectTab(item.id);
                  onCloseMobile();
                }}
                className={`w-full flex items-center justify-between px-3 py-2 text-sm rounded-md transition-colors text-left ${
                  active
                    ? 'bg-blue-600 text-white font-medium'
                    : 'text-slate-300 hover:bg-slate-800 hover:text-white'
                }`}
              >
                <span className="flex items-center gap-2.5 truncate">
                  {item.icon}
                  <span className="truncate">{item.label}</span>
                </span>
                {typeof item.count === 'number' && item.count > 0 && (
                  <span className="text-xs font-mono tabular-nums text-amber-300 font-semibold ml-2">
                    {item.count}
                  </span>
                )}
              </button>
            );
          })}
        </nav>

        <div className="p-3 border-t border-slate-800 space-y-1.5">
          <button
            type="button"
            onClick={() => onOpenPanggil(defaultCameraId)}
            className="w-full flex items-center justify-between px-3 py-2 text-xs font-medium text-slate-200 bg-slate-800 hover:bg-slate-700 rounded-md transition-colors"
          >
            <span>Buka Kiosk Panggil #{defaultCameraId}</span>
            <ExternalLink className="w-3.5 h-3.5 text-slate-400" />
          </button>
          <button
            type="button"
            onClick={onOpenGuest}
            className="w-full flex items-center justify-between px-3 py-2 text-xs font-medium text-slate-200 bg-slate-800 hover:bg-slate-700 rounded-md transition-colors"
          >
            <span>Portal Orang Tua (/ortu)</span>
            <Bell className="w-3.5 h-3.5 text-slate-400" />
          </button>
          <button
            type="button"
            onClick={onLogout}
            className="w-full flex items-center justify-between px-3 py-2 text-xs font-medium text-red-300 bg-slate-800/60 hover:bg-red-950/60 rounded-md transition-colors"
          >
            <span>Keluar (Logout)</span>
            <LogOut className="w-3.5 h-3.5" />
          </button>
        </div>
      </aside>
    </>
  );
};
