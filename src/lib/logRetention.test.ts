import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createLogThrottle,
  pruneInMemoryLogs,
  truncateTextTailBytes,
} from './logRetention';
import type {
  AttendanceLog,
  GuestAccessLog,
  NotificationItem,
  WaQueue,
} from '../types';

test('pruneInMemoryLogs caps attendance_logs, wa_queue, notifications, and guest_access_logs by age and row limit', () => {
  const nowMs = Date.parse('2026-11-23T00:00:00Z');
  const oldDate = '2026-06-01T07:00:00'; // > 170 days ago
  const readOldNotifDate = '2026-11-10 08:00:00'; // 13 days ago (> 7 days read cutoff)
  const freshDate = '2026-11-22T07:00:00';

  const att: AttendanceLog[] = [
    { id: 1, student_id: 1, gate_id: 1, camera_id: 1, timestamp: freshDate, tipe: 'MASUK', status: 'HADIR', is_manual_override: false },
    { id: 2, student_id: 1, gate_id: 1, camera_id: 1, timestamp: oldDate, tipe: 'MASUK', status: 'HADIR', is_manual_override: false },
  ];

  const wa: WaQueue[] = [
    {
      id: 1,
      student_id: 1,
      phone: '62811',
      payload: { nama: 'A', kelas: 'X', tanggal: '2026-06-01', jam_masuk: '07:00', jam_keluar: '-', status: 'HADIR' },
      status: 'SENT',
      retry_count: 0,
      scheduled_at: oldDate,
      sent_at: oldDate,
      error_msg: null,
    },
    {
      id: 2,
      student_id: 2,
      phone: '62812',
      payload: { nama: 'B', kelas: 'X', tanggal: '2026-06-01', jam_masuk: '07:00', jam_keluar: '-', status: 'HADIR' },
      status: 'PENDING',
      retry_count: 0,
      scheduled_at: oldDate,
      sent_at: null,
      error_msg: null,
    },
    {
      id: 3,
      student_id: 3,
      phone: '62813',
      payload: { nama: 'C', kelas: 'X', tanggal: '2026-11-22', jam_masuk: '07:00', jam_keluar: '-', status: 'HADIR' },
      status: 'SENT',
      retry_count: 0,
      scheduled_at: freshDate,
      sent_at: freshDate,
      error_msg: null,
    },
  ];

  const notifs: NotificationItem[] = [
    { id: 1, user_id: null, role_target: 'BK', type: 'CLUSTER_READY', title: 'Read old', message: 'm', is_read: true, created_at: readOldNotifDate },
    { id: 2, user_id: null, role_target: 'BK', type: 'CLUSTER_READY', title: 'Unread recent', message: 'm', is_read: false, created_at: readOldNotifDate },
    { id: 3, user_id: null, role_target: 'BK', type: 'CLUSTER_READY', title: 'Very old unread', message: 'm', is_read: false, created_at: oldDate },
  ];

  const guests: GuestAccessLog[] = [
    { id: 1, ip: '1.1.1.1', timestamp: freshDate, success: true, nisn_attempted: '123' },
    { id: 2, ip: '1.1.1.2', timestamp: oldDate, success: false, nisn_attempted: '999' },
  ];

  const res = pruneInMemoryLogs(
    { attendance_logs: att, wa_queue: wa, notifications: notifs, guest_access_logs: guests },
    { nowMs }
  );

  assert.equal(res.attendance_logs.length, 1);
  assert.equal(res.attendance_logs[0].id, 1);

  assert.equal(res.wa_queue.length, 2); // PENDING old + SENT fresh
  assert.deepEqual(res.wa_queue.map((x) => x.id), [2, 3]);

  assert.equal(res.notifications.length, 1); // only unread recent kept
  assert.equal(res.notifications[0].id, 2);

  assert.equal(res.guest_access_logs.length, 1);
  assert.equal(res.guest_access_logs[0].id, 1);

  assert.deepEqual(res.removedCounts, {
    attendance_logs: 1,
    wa_queue: 1,
    notifications: 2,
    guest_access_logs: 1,
  });
});

test('truncateTextTailBytes trims oversized log strings cleanly at line boundaries', () => {
  const lines = Array.from({ length: 200 }, (_, i) => `2026-11-23 log entry number ${i + 1} with extra text payload`).join('\n');
  const res = truncateTextTailBytes(lines, 2048);
  assert.equal(res.truncated, true);
  assert.ok(Buffer.byteLength(res.content, 'utf8') < 2048);
  assert.ok(res.content.includes('log entry number 200'));
  assert.ok(!res.content.includes('log entry number 1 '));

  const untouched = truncateTextTailBytes('short\nlog', 4096);
  assert.equal(untouched.truncated, false);
  assert.equal(untouched.content, 'short\nlog');
});

test('createLogThrottle suppresses repeated per-frame logs within cooldown window', () => {
  const throttle = createLogThrottle(60_000);
  assert.equal(throttle.shouldLog('cam:1', 1000), true);
  assert.equal(throttle.shouldLog('cam:1', 2000), false);
  assert.equal(throttle.shouldLog('cam:1', 60_999), false);
  assert.equal(throttle.shouldLog('cam:2', 2000), true);
  assert.equal(throttle.shouldLog('cam:1', 61_000), true);
});
