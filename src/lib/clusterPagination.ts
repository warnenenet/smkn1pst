import type { AnonymousCluster, Camera, Gate } from '../types';

export const CLUSTER_PAGE_SIZE_OPTIONS = [12, 24, 48] as const;
export const DEFAULT_CLUSTER_PAGE_SIZE = 12;

export interface PaginatedSlice<T> {
  items: T[];
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
  startIndex: number; // 1-based inclusive display index (0 when empty)
  endIndex: number; // 1-based inclusive display index (0 when empty)
}

export function clampPage(page: number, totalPages: number): number {
  const safeTotal = Math.max(1, Math.floor(Number.isFinite(totalPages) ? totalPages : 1));
  const parsed = Math.floor(Number.isFinite(page) ? page : 1);
  return Math.min(safeTotal, Math.max(1, parsed));
}

export function paginateItems<T>(items: readonly T[], page: number, pageSize: number): PaginatedSlice<T> {
  const safeSize = Math.max(1, Math.floor(Number.isFinite(pageSize) ? pageSize : DEFAULT_CLUSTER_PAGE_SIZE));
  const totalItems = items.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / safeSize));
  const safePage = clampPage(page, totalPages);
  const startOffset = (safePage - 1) * safeSize;
  const sliced = items.slice(startOffset, startOffset + safeSize);

  return {
    items: sliced,
    page: safePage,
    pageSize: safeSize,
    totalItems,
    totalPages,
    startIndex: totalItems === 0 ? 0 : startOffset + 1,
    endIndex: totalItems === 0 ? 0 : startOffset + sliced.length,
  };
}

/**
 * Generates compact page number tokens for pagination UI:
 * e.g. [1, 'ellipsis', 4, 5, 6, 'ellipsis', 12]
 */
export function buildPageTokens(currentPage: number, totalPages: number): Array<number | 'ellipsis'> {
  const safeTotal = Math.max(1, Math.floor(totalPages));
  const current = clampPage(currentPage, safeTotal);
  if (safeTotal <= 7) {
    return Array.from({ length: safeTotal }, (_, i) => i + 1);
  }

  const pages = new Set<number>([1, safeTotal, current]);
  if (current - 1 >= 1) pages.add(current - 1);
  if (current + 1 <= safeTotal) pages.add(current + 1);
  if (current <= 3) {
    pages.add(2);
    pages.add(3);
    pages.add(4);
  }
  if (current >= safeTotal - 2) {
    pages.add(safeTotal - 3);
    pages.add(safeTotal - 2);
    pages.add(safeTotal - 1);
  }

  const sorted = Array.from(pages)
    .filter((p) => p >= 1 && p <= safeTotal)
    .sort((a, b) => a - b);

  const tokens: Array<number | 'ellipsis'> = [];
  for (let i = 0; i < sorted.length; i++) {
    const p = sorted[i];
    if (i > 0 && p - sorted[i - 1] > 1) {
      tokens.push('ellipsis');
    }
    tokens.push(p);
  }
  return tokens;
}

export function sortAndFilterClusters(params: {
  clusters: readonly AnonymousCluster[];
  status: 'READY' | 'PENDING';
  searchQuery?: string;
  cameras?: readonly Camera[];
  gates?: readonly Gate[];
}): AnonymousCluster[] {
  const { clusters, status, searchQuery = '', cameras = [], gates = [] } = params;
  const q = searchQuery.trim().toLowerCase().replace(/^#/, '');
  const cameraMap = new Map(cameras.map((c) => [c.id, c]));
  const gateMap = new Map(gates.map((g) => [g.id, g]));

  return clusters
    .filter((c) => {
      if (c.status !== status) return false;
      if (!q) return true;
      if (String(c.id).includes(q)) return true;
      const cam = c.last_camera_id !== null ? cameraMap.get(c.last_camera_id) : undefined;
      const gate = cam ? gateMap.get(cam.gate_id) : undefined;
      if (cam && cam.nama_kamera.toLowerCase().includes(q)) return true;
      if (gate && gate.nama_gerbang.toLowerCase().includes(q)) return true;
      if ((c.last_seen || '').toLowerCase().includes(q)) return true;
      return false;
    })
    .sort((a, b) => b.last_seen.localeCompare(a.last_seen) || b.id - a.id);
}
