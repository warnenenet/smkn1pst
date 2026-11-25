import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPageTokens, clampPage, paginateItems, sortAndFilterClusters } from './clusterPagination';
import type { AnonymousCluster, Camera, Gate } from '../types';

function makeCluster(id: number, status: 'READY' | 'PENDING', lastSeen: string, camId = 1): AnonymousCluster {
  return {
    id,
    centroid: [],
    hit_count: status === 'READY' ? 5 : 2,
    distinct_days: 1,
    first_seen: lastSeen,
    last_seen: lastSeen,
    best_snapshot_path: `/data/snapshots/c_${id}.jpg`,
    best_quality_score: 0.85,
    best_embedding: [],
    status,
    named_student_id: null,
    last_camera_id: camId,
  };
}

test('paginateItems slices accurately and clamps out-of-range pages when items are removed', () => {
  const items = Array.from({ length: 27 }, (_, i) => i + 1);

  const p1 = paginateItems(items, 1, 12);
  assert.equal(p1.totalPages, 3);
  assert.equal(p1.page, 1);
  assert.equal(p1.startIndex, 1);
  assert.equal(p1.endIndex, 12);
  assert.deepEqual(p1.items, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);

  const p3 = paginateItems(items, 3, 12);
  assert.equal(p3.page, 3);
  assert.equal(p3.startIndex, 25);
  assert.equal(p3.endIndex, 27);
  assert.deepEqual(p3.items, [25, 26, 27]);

  // If page 3 items get deleted so only 24 remain, clamp back to page 2
  const clamped = paginateItems(items.slice(0, 24), 3, 12);
  assert.equal(clamped.totalPages, 2);
  assert.equal(clamped.page, 2);
  assert.equal(clamped.startIndex, 13);
  assert.equal(clamped.endIndex, 24);

  const empty = paginateItems([], 4, 12);
  assert.equal(empty.totalPages, 1);
  assert.equal(empty.page, 1);
  assert.equal(empty.startIndex, 0);
  assert.equal(empty.endIndex, 0);
  assert.deepEqual(empty.items, []);
  assert.equal(clampPage(-5, 3), 1);
});

test('buildPageTokens keeps short lists complete and inserts ellipses cleanly for large page counts', () => {
  assert.deepEqual(buildPageTokens(2, 5), [1, 2, 3, 4, 5]);
  assert.deepEqual(buildPageTokens(1, 12), [1, 2, 3, 4, 'ellipsis', 12]);
  assert.deepEqual(buildPageTokens(6, 12), [1, 'ellipsis', 5, 6, 7, 'ellipsis', 12]);
  assert.deepEqual(buildPageTokens(12, 12), [1, 'ellipsis', 9, 10, 11, 12]);
});

test('sortAndFilterClusters orders newest first and filters by cluster id, camera, gate, or timestamp', () => {
  const gates: Gate[] = [
    { id: 1, nama_gerbang: 'Gerbang Utama', tipe: 'BOTH', lokasi: 'Depan' },
    { id: 2, nama_gerbang: 'Gerbang Belakang', tipe: 'KELUAR', lokasi: 'Belakang' },
  ];
  const cameras: Camera[] = [
    { id: 1, nama_kamera: 'Kamera Lobby', gate_id: 1, rtsp_url: 'rtsp://127.0.0.1/1', resolusi: '1280x720', fps: 5, aktif: true, status: 'ONLINE', last_error: null, last_online_at: null },
    { id: 2, nama_kamera: 'Kamera Parkir', gate_id: 2, rtsp_url: 'rtsp://127.0.0.1/2', resolusi: '1280x720', fps: 5, aktif: true, status: 'ONLINE', last_error: null, last_online_at: null },
  ];
  const clusters: AnonymousCluster[] = [
    makeCluster(10, 'READY', '2026-11-24 07:05:00', 1),
    makeCluster(15, 'READY', '2026-11-24 07:15:00', 2),
    makeCluster(12, 'PENDING', '2026-11-24 07:20:00', 1),
  ];

  const readyAll = sortAndFilterClusters({ clusters, status: 'READY', cameras, gates });
  assert.deepEqual(readyAll.map((c) => c.id), [15, 10]);

  const byHashId = sortAndFilterClusters({ clusters, status: 'READY', searchQuery: '#10', cameras, gates });
  assert.deepEqual(byHashId.map((c) => c.id), [10]);

  const byGate = sortAndFilterClusters({ clusters, status: 'READY', searchQuery: 'belakang', cameras, gates });
  assert.deepEqual(byGate.map((c) => c.id), [15]);

  const byCam = sortAndFilterClusters({ clusters, status: 'PENDING', searchQuery: 'lobby', cameras, gates });
  assert.deepEqual(byCam.map((c) => c.id), [12]);
});
