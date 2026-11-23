import type {
  AttendanceLog,
  GuestAccessLog,
  NotificationItem,
  WaQueue,
} from '../types';

export interface PruneLogsOptions {
  nowMs?: number;
  attendanceMaxRows?: number;
  attendanceMaxAgeDays?: number;
  waMaxRows?: number;
  waDoneMaxAgeDays?: number;
  notificationMaxRows?: number;
  notificationMaxAgeDays?: number;
  notificationReadMaxAgeDays?: number;
  guestMaxRows?: number;
  guestMaxAgeDays?: number;
}

export interface PrunedLogsResult {
  attendance_logs: AttendanceLog[];
  wa_queue: WaQueue[];
  notifications: NotificationItem[];
  guest_access_logs: GuestAccessLog[];
  removedCounts: {
    attendance_logs: number;
    wa_queue: number;
    notifications: number;
    guest_access_logs: number;
  };
}

function parseTimestampMs(raw: string | null | undefined): number {
  if (!raw || typeof raw !== 'string') return NaN;
  const trimmed = raw.trim();
  if (!trimmed) return NaN;
  const normalized = trimmed.includes(' ') && !trimmed.includes('T')
    ? trimmed.replace(' ', 'T')
    : trimmed;
  return Date.parse(normalized);
}

export function pruneInMemoryLogs(
  input: {
    attendance_logs: AttendanceLog[];
    wa_queue: WaQueue[];
    notifications: NotificationItem[];
    guest_access_logs: GuestAccessLog[];
  },
  opts: PruneLogsOptions = {}
): PrunedLogsResult {
  const nowMs = opts.nowMs ?? Date.now();
  const attMaxRows = Math.max(100, opts.attendanceMaxRows ?? 3000);
  const attCutoffMs = nowMs - Math.max(7, opts.attendanceMaxAgeDays ?? 90) * 86_400_000;

  const waMaxRows = Math.max(100, opts.waMaxRows ?? 2000);
  const waDoneCutoffMs = nowMs - Math.max(3, opts.waDoneMaxAgeDays ?? 30) * 86_400_000;

  const notifMaxRows = Math.max(50, opts.notificationMaxRows ?? 500);
  const notifMaxCutoffMs = nowMs - Math.max(7, opts.notificationMaxAgeDays ?? 30) * 86_400_000;
  const notifReadCutoffMs = nowMs - Math.max(1, opts.notificationReadMaxAgeDays ?? 7) * 86_400_000;

  const guestMaxRows = Math.max(50, opts.guestMaxRows ?? 1000);
  const guestCutoffMs = nowMs - Math.max(1, opts.guestMaxAgeDays ?? 30) * 86_400_000;

  const nextAttendance = input.attendance_logs
    .filter((l) => {
      const ts = parseTimestampMs(l.timestamp);
      return Number.isNaN(ts) || ts >= attCutoffMs;
    })
    .slice(0, attMaxRows);

  const nextWaQueue = input.wa_queue
    .filter((q) => {
      if (q.status === 'PENDING') return true;
      const ts = parseTimestampMs(q.sent_at ?? q.scheduled_at);
      return Number.isNaN(ts) || ts >= waDoneCutoffMs;
    })
    .slice(0, waMaxRows);

  const nextNotifications = input.notifications
    .filter((n) => {
      const ts = parseTimestampMs(n.created_at);
      if (Number.isNaN(ts)) return true;
      if (n.is_read && ts < notifReadCutoffMs) return false;
      return ts >= notifMaxCutoffMs;
    })
    .slice(0, notifMaxRows);

  const nextGuestLogs = input.guest_access_logs
    .filter((g) => {
      const ts = parseTimestampMs(g.timestamp);
      return Number.isNaN(ts) || ts >= guestCutoffMs;
    })
    .slice(0, guestMaxRows);

  return {
    attendance_logs: nextAttendance,
    wa_queue: nextWaQueue,
    notifications: nextNotifications,
    guest_access_logs: nextGuestLogs,
    removedCounts: {
      attendance_logs: Math.max(0, input.attendance_logs.length - nextAttendance.length),
      wa_queue: Math.max(0, input.wa_queue.length - nextWaQueue.length),
      notifications: Math.max(0, input.notifications.length - nextNotifications.length),
      guest_access_logs: Math.max(0, input.guest_access_logs.length - nextGuestLogs.length),
    },
  };
}

export function truncateTextTailBytes(raw: string, maxBytes: number): { content: string; truncated: boolean } {
  const buf = Buffer.from(raw, 'utf8');
  if (buf.byteLength <= maxBytes) {
    return { content: raw, truncated: false };
  }
  const keepBytes = Math.max(1024, Math.floor(maxBytes * 0.6));
  const slice = buf.subarray(Math.max(0, buf.byteLength - keepBytes)).toString('utf8');
  const firstNewline = slice.indexOf('\n');
  const cleanTail = firstNewline >= 0 && firstNewline < slice.length - 1 ? slice.slice(firstNewline + 1) : slice;
  return { content: cleanTail, truncated: true };
}

export function createLogThrottle(windowMs = 60_000): {
  shouldLog: (key: string, nowMs?: number) => boolean;
  reset: () => void;
} {
  const lastByKey = new Map<string, number>();

  return {
    shouldLog(key: string, nowMs = Date.now()): boolean {
      const prev = lastByKey.get(key);
      if (prev !== undefined && nowMs - prev < windowMs) {
        return false;
      }
      if (lastByKey.size > 500) {
        for (const [k, ts] of lastByKey.entries()) {
          if (nowMs - ts >= windowMs) lastByKey.delete(k);
        }
      }
      lastByKey.set(key, nowMs);
      return true;
    },
    reset(): void {
      lastByKey.clear();
    },
  };
}
