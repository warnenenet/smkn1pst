import type {
  AnonymousCluster,
  AttendanceLog,
  ClusterHitSnapshot,
  FaceUpdateReview,
  StorageBreakdown,
  Visitor,
} from '../types';

export const TOTAL_STORAGE_LIMIT_BYTES = 10 * 1024 * 1024 * 1024; // 10 GB hard cap
export const STORAGE_SOFT_TARGET_BYTES = 8 * 1024 * 1024 * 1024; // 8.0 GB target
export const STORAGE_EMERGENCY_TRIM_BYTES = 9 * 1024 * 1024 * 1024; // 9.0 GB emergency threshold

export const SNAPSHOTS_MAX_BYTES = Math.round(4.5 * 1024 * 1024 * 1024); // 4.5 GB max snapshots
export const TTS_CACHE_MAX_BYTES = 120 * 1024 * 1024; // 120 MB
export const BACKUPS_MAX_BYTES = 200 * 1024 * 1024; // 200 MB
export const LOGS_MAX_BYTES = 5 * 1024 * 1024; // 5 MB across .log files
export const SQLITE_WAL_MAX_BYTES = 8 * 1024 * 1024; // 8 MB WAL limit

export const ATTENDANCE_SNAPSHOT_RETENTION_DAYS = 3;
export const ATTENDANCE_SNAPSHOT_MAX_KEEP = 1500;
export const CLUSTER_MAX_HITS = 5;
export const CLUSTER_ACTIVE_MAX_COUNT = 1500;
export const CLUSTER_NOISE_MAX_AGE_DAYS = 14;
export const REVIEW_DONE_RETENTION_DAYS = 60;
export const REVIEW_MAX_COUNT = 500;
export const VISITOR_RETENTION_DAYS = 365;
export const VISITOR_MAX_COUNT = 2000;
export const STORED_SNAPSHOT_MAX_SIDE_PX = 360;

export interface SnapshotDiskEntry {
  relPath: string;
  size: number;
  mtimeMs: number;
}

export interface SecondaryRetentionInput {
  anonymous_clusters: AnonymousCluster[];
  face_update_reviews: FaceUpdateReview[];
  visitors: Visitor[];
  attendance_logs: AttendanceLog[];
}

export interface SecondaryRetentionResult {
  anonymous_clusters: AnonymousCluster[];
  face_update_reviews: FaceUpdateReview[];
  visitors: Visitor[];
  attendance_logs: AttendanceLog[];
  removedClusterIds: number[];
  removedReviewIds: number[];
  removedVisitorIds: number[];
  strippedSnapshotPaths: string[];
}

function parseTsMs(raw: string | null | undefined): number {
  if (!raw || typeof raw !== 'string') return NaN;
  const t = raw.trim();
  if (!t) return NaN;
  return Date.parse(t.includes(' ') && !t.includes('T') ? t.replace(' ', 'T') : t);
}

export function roundEmbeddingForJson(vec: number[] | undefined): number[] | undefined {
  if (!Array.isArray(vec) || vec.length === 0) return vec;
  const out = new Array<number>(vec.length);
  for (let i = 0; i < vec.length; i++) {
    out[i] = Math.round(Number(vec[i]) * 10000) / 10000;
  }
  return out;
}

export function computeDownscaleDimensions(
  width: number,
  height: number,
  maxSide = STORED_SNAPSHOT_MAX_SIDE_PX
): { width: number; height: number; scaled: boolean } {
  const safeW = Math.max(2, Math.round(width));
  const safeH = Math.max(2, Math.round(height));
  const longest = Math.max(safeW, safeH);
  if (longest <= maxSide) {
    return { width: safeW, height: safeH, scaled: false };
  }
  const ratio = maxSide / longest;
  return {
    width: Math.max(2, Math.round(safeW * ratio)),
    height: Math.max(2, Math.round(safeH * ratio)),
    scaled: true,
  };
}

export function compactSecondaryRecords(
  input: SecondaryRetentionInput,
  nowMs = Date.now()
): SecondaryRetentionResult {
  const removedClusterIds: number[] = [];
  const removedReviewIds: number[] = [];
  const removedVisitorIds: number[] = [];
  const strippedSnapshotPaths = new Set<string>();

  const noiseCutoffMs = nowMs - CLUSTER_NOISE_MAX_AGE_DAYS * 86_400_000;
  const attSnapCutoffMs = nowMs - ATTENDANCE_SNAPSHOT_RETENTION_DAYS * 86_400_000;
  const revDoneCutoffMs = nowMs - REVIEW_DONE_RETENTION_DAYS * 86_400_000;
  const visitorCutoffMs = nowMs - VISITOR_RETENTION_DAYS * 86_400_000;

  // 1. Compact anonymous clusters:
  //    - Drop 1-2 hit PENDING noise older than 14 days
  //    - Cap hit_snapshots to 5 best-quality hits per cluster & strip redundant embeddings on ARCHIVED/NAMED or > 14d hits
  //    - Cap total PENDING/READY clusters at 1,500 (keep highest hits & most recent)
  const keptClusters: AnonymousCluster[] = [];
  for (const c of input.anonymous_clusters) {
    const lastMs = parseTsMs(c.last_seen);
    const isOldNoise =
      c.status === 'PENDING' &&
      c.hit_count <= 2 &&
      !Number.isNaN(lastMs) &&
      lastMs < noiseCutoffMs;
    if (isOldNoise) {
      removedClusterIds.push(c.id);
      if (c.best_snapshot_path) strippedSnapshotPaths.add(c.best_snapshot_path);
      for (const h of c.hit_snapshots ?? []) {
        if (h.snapshot_path) strippedSnapshotPaths.add(h.snapshot_path);
      }
      continue;
    }

    const rawHits = Array.isArray(c.hit_snapshots) ? [...c.hit_snapshots] : [];
    let nextHits: ClusterHitSnapshot[] = rawHits;
    if (c.status === 'ARCHIVED' || c.status === 'NAMED') {
      // Keep only the canonical best snapshot once archived/named
      for (const h of rawHits) {
        if (h.snapshot_path && h.snapshot_path !== c.best_snapshot_path) {
          strippedSnapshotPaths.add(h.snapshot_path);
        }
      }
      nextHits = c.best_snapshot_path
        ? [
            {
              snapshot_path: c.best_snapshot_path,
              quality_score: c.best_quality_score,
              similarity: 1,
              camera_id: c.last_camera_id,
              detected_at: c.last_seen,
            },
          ]
        : [];
    } else if (rawHits.length > CLUSTER_MAX_HITS) {
      // Sort preserving best_snapshot_path + highest quality hits + newest hits
      const sorted = [...rawHits].sort((a, b) => {
        if (a.snapshot_path === c.best_snapshot_path) return -1;
        if (b.snapshot_path === c.best_snapshot_path) return 1;
        if (b.quality_score !== a.quality_score) return b.quality_score - a.quality_score;
        return String(b.detected_at).localeCompare(String(a.detected_at));
      });
      nextHits = sorted.slice(0, CLUSTER_MAX_HITS);
      for (const dropped of sorted.slice(CLUSTER_MAX_HITS)) {
        if (dropped.snapshot_path && dropped.snapshot_path !== c.best_snapshot_path) {
          strippedSnapshotPaths.add(dropped.snapshot_path);
        }
      }
    }

    // Round hit embeddings to 4 decimals & drop stale hit embeddings when cluster already has >=5 hits
    nextHits = nextHits.map((h, idx) => {
      const hMs = parseTsMs(h.detected_at);
      const keepEmb =
        Array.isArray(h.embedding) &&
        h.embedding.length > 0 &&
        (idx < 5 || Number.isNaN(hMs) || hMs >= noiseCutoffMs);
      return keepEmb
        ? { ...h, embedding: roundEmbeddingForJson(h.embedding) }
        : {
            snapshot_path: h.snapshot_path,
            quality_score: h.quality_score,
            similarity: h.similarity,
            camera_id: h.camera_id,
            detected_at: h.detected_at,
          };
    });

    keptClusters.push({
      ...c,
      hit_snapshots: nextHits,
    });
  }

  let finalClusters = keptClusters;
  if (finalClusters.length > CLUSTER_ACTIVE_MAX_COUNT) {
    finalClusters = [...finalClusters].sort((a, b) => {
      const rank = (st: AnonymousCluster['status']) => (st === 'READY' ? 3 : st === 'PENDING' ? 2 : 1);
      if (rank(b.status) !== rank(a.status)) return rank(b.status) - rank(a.status);
      if (b.hit_count !== a.hit_count) return b.hit_count - a.hit_count;
      return String(b.last_seen).localeCompare(String(a.last_seen));
    });
    const droppedClusters = finalClusters.slice(CLUSTER_ACTIVE_MAX_COUNT);
    finalClusters = finalClusters.slice(0, CLUSTER_ACTIVE_MAX_COUNT);
    for (const dc of droppedClusters) {
      removedClusterIds.push(dc.id);
      if (dc.best_snapshot_path) strippedSnapshotPaths.add(dc.best_snapshot_path);
      for (const h of dc.hit_snapshots ?? []) {
        if (h.snapshot_path) strippedSnapshotPaths.add(h.snapshot_path);
      }
    }
  }

  // 2. Prune resolved face_update_reviews (> 60 days) & cap total at 500
  const filteredReviews: FaceUpdateReview[] = [];
  for (const r of input.face_update_reviews) {
    if (r.status !== 'PENDING') {
      const rMs = parseTsMs(r.reviewed_at);
      if (!Number.isNaN(rMs) && rMs < revDoneCutoffMs) {
        removedReviewIds.push(r.id);
        continue;
      }
    }
    filteredReviews.push(r);
  }
  const finalReviews =
    filteredReviews.length > REVIEW_MAX_COUNT
      ? filteredReviews
          .sort((a, b) => {
            if (a.status === 'PENDING' && b.status !== 'PENDING') return -1;
            if (b.status === 'PENDING' && a.status !== 'PENDING') return 1;
            return b.id - a.id;
          })
          .slice(0, REVIEW_MAX_COUNT)
      : filteredReviews;
  if (filteredReviews.length > REVIEW_MAX_COUNT) {
    const keptSet = new Set(finalReviews.map((x) => x.id));
    for (const r of filteredReviews) {
      if (!keptSet.has(r.id)) removedReviewIds.push(r.id);
    }
  }

  // 3. Prune old visitors (> 365 days or > 2,000 rows)
  const keptVisitors: Visitor[] = [];
  for (const v of input.visitors) {
    const vMs = parseTsMs(v.created_at);
    if (!Number.isNaN(vMs) && vMs < visitorCutoffMs) {
      removedVisitorIds.push(v.id);
      if (v.snapshot_path) strippedSnapshotPaths.add(v.snapshot_path);
      continue;
    }
    keptVisitors.push(v);
  }
  const finalVisitors = keptVisitors.slice(0, VISITOR_MAX_COUNT);
  for (const droppedV of keptVisitors.slice(VISITOR_MAX_COUNT)) {
    removedVisitorIds.push(droppedV.id);
    if (droppedV.snapshot_path) strippedSnapshotPaths.add(droppedV.snapshot_path);
  }

  // 4. Detach local snapshot_path on old/OBSERVASI attendance_logs (> 3 days or > 1,500 newest snapshots)
  //    Note: Attendance record stays intact in attendance_logs & daily_attendance; only temporary scan JPEG ref is cleared!
  let attSnapCount = 0;
  const finalAttendance = input.attendance_logs.map((l) => {
    if (!l.snapshot_path || !l.snapshot_path.startsWith('/data/snapshots/')) return l;
    const lMs = parseTsMs(l.timestamp);
    const expired = !Number.isNaN(lMs) && lMs < attSnapCutoffMs;
    const isObsOnly = l.tipe === 'OBSERVASI';
    if (expired || isObsOnly || attSnapCount >= ATTENDANCE_SNAPSHOT_MAX_KEEP) {
      strippedSnapshotPaths.add(l.snapshot_path);
      return { ...l, snapshot_path: null };
    }
    attSnapCount += 1;
    return l;
  });

  // Never mark any still-referenced file for deletion
  for (const c of finalClusters) {
    if (c.best_snapshot_path) strippedSnapshotPaths.delete(c.best_snapshot_path);
    for (const h of c.hit_snapshots ?? []) {
      if (h.snapshot_path) strippedSnapshotPaths.delete(h.snapshot_path);
    }
  }
  for (const v of finalVisitors) {
    if (v.snapshot_path) strippedSnapshotPaths.delete(v.snapshot_path);
  }
  for (const l of finalAttendance) {
    if (l.snapshot_path) strippedSnapshotPaths.delete(l.snapshot_path);
  }

  return {
    anonymous_clusters: finalClusters,
    face_update_reviews: finalReviews,
    visitors: finalVisitors,
    attendance_logs: finalAttendance,
    removedClusterIds,
    removedReviewIds,
    removedVisitorIds,
    strippedSnapshotPaths: Array.from(strippedSnapshotPaths),
  };
}

export function selectSnapshotsToPruneByQuota(params: {
  files: SnapshotDiskEntry[];
  canonicalProtectedPaths: Set<string>;
  secondaryProtectedPaths: Set<string>;
  maxBytes: number;
  orphanMaxAgeMs?: number;
  nowMs?: number;
}): { deletePaths: string[]; reclaimBytes: number } {
  const {
    files,
    canonicalProtectedPaths,
    secondaryProtectedPaths,
    maxBytes,
    orphanMaxAgeMs = 86_400_000,
    nowMs = Date.now(),
  } = params;

  const deleteSet = new Set<string>();
  let totalBytes = files.reduce((acc, f) => acc + f.size, 0);
  let reclaimBytes = 0;

  // Pass 1: Delete unreferenced orphan files older than orphanMaxAgeMs
  const remaining: SnapshotDiskEntry[] = [];
  for (const f of files) {
    const isProtected = canonicalProtectedPaths.has(f.relPath) || secondaryProtectedPaths.has(f.relPath);
    if (!isProtected && nowMs - f.mtimeMs > orphanMaxAgeMs) {
      deleteSet.add(f.relPath);
      totalBytes -= f.size;
      reclaimBytes += f.size;
    } else {
      remaining.push(f);
    }
  }

  if (totalBytes <= maxBytes) {
    return { deletePaths: Array.from(deleteSet), reclaimBytes };
  }

  // Pass 2: Delete even fresh unreferenced files oldest-first
  const orphansFresh = remaining
    .filter((f) => !canonicalProtectedPaths.has(f.relPath) && !secondaryProtectedPaths.has(f.relPath))
    .sort((a, b) => a.mtimeMs - b.mtimeMs);
  for (const f of orphansFresh) {
    if (totalBytes <= maxBytes) break;
    deleteSet.add(f.relPath);
    totalBytes -= f.size;
    reclaimBytes += f.size;
  }

  if (totalBytes <= maxBytes) {
    return { deletePaths: Array.from(deleteSet), reclaimBytes };
  }

  // Pass 3: Delete secondary-protected files (excess history, attendance scan snapshots, old cluster hits) oldest-first
  const secondaryFiles = remaining
    .filter((f) => !canonicalProtectedPaths.has(f.relPath) && secondaryProtectedPaths.has(f.relPath))
    .sort((a, b) => a.mtimeMs - b.mtimeMs);
  for (const f of secondaryFiles) {
    if (totalBytes <= maxBytes) break;
    deleteSet.add(f.relPath);
    totalBytes -= f.size;
    reclaimBytes += f.size;
  }

  return { deletePaths: Array.from(deleteSet), reclaimBytes };
}

export function computeStorageBudgetStatus(breakdown: StorageBreakdown): {
  totalBytes: number;
  limitBytes: number;
  usedPct: number;
  remainingBytes: number;
  level: 'NORMAL' | 'WARNING' | 'CRITICAL';
  needsEmergencyTrim: boolean;
} {
  const totalBytes = Math.max(0, breakdown.total_bytes);
  const usedPct = Math.min(100, Math.round((totalBytes / TOTAL_STORAGE_LIMIT_BYTES) * 1000) / 10);
  const remainingBytes = Math.max(0, TOTAL_STORAGE_LIMIT_BYTES - totalBytes);
  const level =
    totalBytes >= STORAGE_EMERGENCY_TRIM_BYTES
      ? 'CRITICAL'
      : totalBytes >= 7 * 1024 * 1024 * 1024
        ? 'WARNING'
        : 'NORMAL';
  return {
    totalBytes,
    limitBytes: TOTAL_STORAGE_LIMIT_BYTES,
    usedPct,
    remainingBytes,
    level,
    needsEmergencyTrim: totalBytes >= STORAGE_EMERGENCY_TRIM_BYTES,
  };
}
