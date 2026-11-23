import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CLUSTER_MAX_HITS,
  TOTAL_STORAGE_LIMIT_BYTES,
  compactSecondaryRecords,
  computeDownscaleDimensions,
  computeStorageBudgetStatus,
  roundEmbeddingForJson,
  selectSnapshotsToPruneByQuota,
} from './storageBudget';
import type { AnonymousCluster, AttendanceLog, FaceUpdateReview, Visitor } from '../types';

test('compactSecondaryRecords evicts stale 1-hit PENDING noise, caps hits at 5, and clears old/OBSERVASI scan snapshots', () => {
  const nowMs = Date.parse('2026-11-23T00:00:00Z');
  const oldSeen = '2026-10-01 08:00:00'; // > 50 days ago
  const freshSeen = '2026-11-22 08:00:00';

  const bigHits = Array.from({ length: 20 }, (_, i) => ({
    snapshot_path: `/data/snapshots/c2_hit_${i}.jpg`,
    quality_score: 0.7 + i * 0.01,
    similarity: 0.8,
    camera_id: 1,
    detected_at: freshSeen,
    embedding: [0.1234567, -0.9876543],
  }));

  const clusters: AnonymousCluster[] = [
    {
      id: 1,
      centroid: [0.1, 0.2],
      hit_count: 1,
      distinct_days: 1,
      first_seen: oldSeen,
      last_seen: oldSeen,
      best_snapshot_path: '/data/snapshots/noise.jpg',
      best_quality_score: 0.72,
      best_embedding: [0.1, 0.2],
      hit_snapshots: [{ snapshot_path: '/data/snapshots/noise.jpg', quality_score: 0.72, similarity: 1, camera_id: 1, detected_at: oldSeen }],
      status: 'PENDING',
      named_student_id: null,
      last_camera_id: 1,
    },
    {
      id: 2,
      centroid: [0.3, 0.4],
      hit_count: 20,
      distinct_days: 3,
      first_seen: freshSeen,
      last_seen: freshSeen,
      best_snapshot_path: '/data/snapshots/c2_hit_19.jpg',
      best_quality_score: 0.89,
      best_embedding: [0.3, 0.4],
      hit_snapshots: bigHits,
      status: 'READY',
      named_student_id: null,
      last_camera_id: 1,
    },
  ];

  const reviews: FaceUpdateReview[] = [
    {
      id: 10,
      student_id: 1,
      month: 8,
      year: 2026,
      candidate_snapshots: [],
      current_quality: 0.7,
      best_new_quality: 0.8,
      status: 'APPROVED',
      reviewed_by: 1,
      reviewed_at: '2026-08-01 08:00:00',
    },
    {
      id: 11,
      student_id: 2,
      month: 11,
      year: 2026,
      candidate_snapshots: [],
      current_quality: 0.7,
      best_new_quality: 0.85,
      status: 'PENDING',
      reviewed_by: null,
      reviewed_at: null,
    },
  ];

  const visitors: Visitor[] = [
    { id: 1, nama: 'Old Guest', kategori: 'TAMU', snapshot_path: '/data/snapshots/old_guest.jpg', catatan: '', created_at: '2025-01-01T00:00:00Z' },
    { id: 2, nama: 'Fresh Guest', kategori: 'TAMU', snapshot_path: '/data/snapshots/fresh_guest.jpg', catatan: '', created_at: '2026-11-22T07:00:00Z' },
  ];

  const logs: AttendanceLog[] = [
    { id: 1, student_id: 1, gate_id: 1, camera_id: 1, timestamp: '2026-11-22T07:00:00', tipe: 'OBSERVASI', status: 'HADIR', is_manual_override: false, snapshot_path: '/data/snapshots/obs.jpg' },
    { id: 2, student_id: 1, gate_id: 1, camera_id: 1, timestamp: '2026-11-10T07:00:00', tipe: 'MASUK', status: 'HADIR', is_manual_override: false, snapshot_path: '/data/snapshots/old_att.jpg' },
    { id: 3, student_id: 1, gate_id: 1, camera_id: 1, timestamp: '2026-11-22T06:50:00', tipe: 'MASUK', status: 'HADIR', is_manual_override: false, snapshot_path: '/data/snapshots/fresh_att.jpg' },
  ];

  const res = compactSecondaryRecords(
    { anonymous_clusters: clusters, face_update_reviews: reviews, visitors, attendance_logs: logs },
    nowMs
  );

  assert.deepEqual(res.removedClusterIds, [1]);
  assert.equal(res.anonymous_clusters.length, 1);
  assert.equal(res.anonymous_clusters[0].hit_snapshots?.length, CLUSTER_MAX_HITS);
  assert.deepEqual(res.removedReviewIds, [10]);
  assert.deepEqual(res.removedVisitorIds, [1]);

  assert.equal(res.attendance_logs[0].snapshot_path, null); // OBSERVASI detached
  assert.equal(res.attendance_logs[1].snapshot_path, null); // > 3 days detached
  assert.equal(res.attendance_logs[2].snapshot_path, '/data/snapshots/fresh_att.jpg'); // fresh kept

  assert.ok(res.strippedSnapshotPaths.includes('/data/snapshots/noise.jpg'));
  assert.ok(res.strippedSnapshotPaths.includes('/data/snapshots/obs.jpg'));
  assert.ok(res.strippedSnapshotPaths.includes('/data/snapshots/old_att.jpg'));
  assert.ok(!res.strippedSnapshotPaths.includes('/data/snapshots/c2_hit_19.jpg'));
});

test('selectSnapshotsToPruneByQuota protects canonical portraits and evicts orphans then secondary files', () => {
  const nowMs = Date.parse('2026-11-23T00:00:00Z');
  const res = selectSnapshotsToPruneByQuota({
    files: [
      { relPath: '/data/snapshots/canonical.jpg', size: 500, mtimeMs: nowMs - 10_000_000 },
      { relPath: '/data/snapshots/secondary_old.jpg', size: 400, mtimeMs: nowMs - 5_000_000 },
      { relPath: '/data/snapshots/orphan_old.jpg', size: 300, mtimeMs: nowMs - 200_000_000 },
    ],
    canonicalProtectedPaths: new Set(['/data/snapshots/canonical.jpg']),
    secondaryProtectedPaths: new Set(['/data/snapshots/secondary_old.jpg']),
    maxBytes: 600,
    nowMs,
  });

  assert.deepEqual(res.deletePaths, ['/data/snapshots/orphan_old.jpg', '/data/snapshots/secondary_old.jpg']);
  assert.equal(res.reclaimBytes, 700);
});

test('computeDownscaleDimensions, roundEmbeddingForJson, and computeStorageBudgetStatus enforce 10GB cap math', () => {
  assert.deepEqual(computeDownscaleDimensions(1080, 720, 360), { width: 360, height: 240, scaled: true });
  assert.deepEqual(computeDownscaleDimensions(240, 180, 360), { width: 240, height: 180, scaled: false });
  assert.deepEqual(roundEmbeddingForJson([0.123456, -0.987654]), [0.1235, -0.9877]);

  const critical = computeStorageBudgetStatus({
    sqlite_bytes: 2 * 1024 ** 3,
    wal_bytes: 0,
    snapshots_bytes: 7.5 * 1024 ** 3,
    backups_bytes: 0,
    tts_cache_bytes: 0,
    logs_bytes: 0,
    other_bytes: 0,
    total_bytes: 9.5 * 1024 ** 3,
    rows: { attendance_logs: 0, wa_queue: 0, notifications: 0, guest_access_logs: 0, auth_sessions: 0 },
  });
  assert.equal(critical.limitBytes, TOTAL_STORAGE_LIMIT_BYTES);
  assert.equal(critical.level, 'CRITICAL');
  assert.equal(critical.needsEmergencyTrim, true);
});
