export interface FaceIndexEntry {
  id: number;
  embedding: number[] | null | undefined;
}

export interface DimensionBucket {
  dim: number;
  ids: Int32Array;
  matrix: Float32Array; // Pre-normalized unit vectors concatenated row-major: count * dim
  count: number;
}

export interface FaceVectorIndex {
  version: number;
  totalIndexed: number;
  buckets: Map<number, DimensionBucket>;
}

export type FaceMatchRejectionReason = 'ambiguous_margin' | 'below_threshold' | 'no_match';

export interface FaceMatchResult {
  bestId: number | null;
  bestSimilarity: number;
  topAnySimilarity: number;
  secondBestSimilarity: number;
  margin: number;
  rejectedReason: FaceMatchRejectionReason | null;
  dimMismatchCount: number;
}

/**
 * Normalizes a vector to unit L2 length into a Float32Array.
 * Returns null if the vector is empty or zero-norm.
 */
export function normalizeToFloat32(vec: readonly number[]): Float32Array | null {
  const len = vec.length;
  if (len === 0) return null;
  let normSq = 0;
  for (let i = 0; i < len; i++) {
    const v = vec[i];
    if (!Number.isFinite(v)) return null;
    normSq += v * v;
  }
  if (normSq <= 1e-12) return null;
  const invNorm = 1 / Math.sqrt(normSq);
  const out = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    out[i] = vec[i] * invNorm;
  }
  return out;
}

/**
 * Builds a pre-normalized contiguous Float32Array index grouped by embedding dimension.
 * Scanning 5,000 faces (512-D or 1024-D) takes < 1 ms per query frame.
 */
export function buildFaceVectorIndex(entries: readonly FaceIndexEntry[], version = 1): FaceVectorIndex {
  const grouped = new Map<number, Array<{ id: number; vec: Float32Array }>>();
  let totalIndexed = 0;

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (!Array.isArray(entry.embedding) || entry.embedding.length === 0) continue;
    const normVec = normalizeToFloat32(entry.embedding);
    if (!normVec) continue;
    const dim = normVec.length;
    let list = grouped.get(dim);
    if (!list) {
      list = [];
      grouped.set(dim, list);
    }
    list.push({ id: entry.id, vec: normVec });
    totalIndexed += 1;
  }

  const buckets = new Map<number, DimensionBucket>();
  for (const [dim, list] of grouped.entries()) {
    const count = list.length;
    const ids = new Int32Array(count);
    const matrix = new Float32Array(count * dim);
    for (let row = 0; row < count; row++) {
      ids[row] = list[row].id;
      matrix.set(list[row].vec, row * dim);
    }
    buckets.set(dim, { dim, ids, matrix, count });
  }

  return { version, totalIndexed, buckets };
}

/**
 * Finds the best matching entity ID above `threshold` with top-1 vs top-2 margin check
 * in O(N * D) flat Float32Array dot products.
 * If (top1 - top2) < minMargin (across distinct entity IDs), returns bestId = null with rejectedReason = 'ambiguous_margin'.
 */
export function findBestFaceMatch(
  index: FaceVectorIndex,
  queryEmbedding: readonly number[],
  threshold: number,
  minMargin = 0.08
): FaceMatchResult {
  const dim = queryEmbedding.length;
  const query = normalizeToFloat32(queryEmbedding);
  let dimMismatchCount = 0;

  for (const [bucketDim, bucket] of index.buckets.entries()) {
    if (bucketDim !== dim) {
      dimMismatchCount += bucket.count;
    }
  }

  if (!query) {
    return {
      bestId: null,
      bestSimilarity: 0,
      topAnySimilarity: 0,
      secondBestSimilarity: 0,
      margin: 0,
      rejectedReason: 'no_match',
      dimMismatchCount,
    };
  }

  const bucket = index.buckets.get(dim);
  if (!bucket || bucket.count === 0) {
    return {
      bestId: null,
      bestSimilarity: 0,
      topAnySimilarity: 0,
      secondBestSimilarity: 0,
      margin: 0,
      rejectedReason: 'no_match',
      dimMismatchCount,
    };
  }

  const { ids, matrix, count } = bucket;
  let top1Id: number | null = null;
  let top1Sim = -Infinity;
  let top2Id: number | null = null;
  let top2Sim = -Infinity;

  for (let row = 0; row < count; row++) {
    const offset = row * dim;
    let dot = 0;
    // Unrolled 4-at-a-time loop speeds up V8 Float32Array dot product on 512/1024-D vectors
    let k = 0;
    const limit = dim - 3;
    for (; k < limit; k += 4) {
      dot +=
        query[k] * matrix[offset + k] +
        query[k + 1] * matrix[offset + k + 1] +
        query[k + 2] * matrix[offset + k + 2] +
        query[k + 3] * matrix[offset + k + 3];
    }
    for (; k < dim; k++) {
      dot += query[k] * matrix[offset + k];
    }

    const rowId = ids[row];
    if (dot > top1Sim) {
      if (top1Id !== null && top1Id !== rowId && top1Sim > top2Sim) {
        top2Sim = top1Sim;
        top2Id = top1Id;
      }
      top1Sim = dot;
      top1Id = rowId;
    } else if (rowId !== top1Id && dot > top2Sim) {
      top2Sim = dot;
      top2Id = rowId;
    }
  }

  const safeTop1 = Number.isFinite(top1Sim) ? Math.max(0, top1Sim) : 0;
  const safeTop2 = top2Id !== null && Number.isFinite(top2Sim) ? Math.max(0, top2Sim) : 0;
  const hasRunnerUp = top2Id !== null;
  const margin = hasRunnerUp ? Math.max(0, safeTop1 - safeTop2) : safeTop1;
  const effectiveMinMargin = Number.isFinite(minMargin) ? Math.max(0, minMargin) : 0.08;

  if (top1Id === null || safeTop1 < threshold) {
    return {
      bestId: null,
      bestSimilarity: 0,
      topAnySimilarity: safeTop1,
      secondBestSimilarity: safeTop2,
      margin,
      rejectedReason: top1Id === null ? 'no_match' : 'below_threshold',
      dimMismatchCount,
    };
  }

  if (hasRunnerUp && effectiveMinMargin > 0 && margin < effectiveMinMargin - 1e-9) {
    return {
      bestId: null,
      bestSimilarity: 0,
      topAnySimilarity: safeTop1,
      secondBestSimilarity: safeTop2,
      margin,
      rejectedReason: 'ambiguous_margin',
      dimMismatchCount,
    };
  }

  return {
    bestId: top1Id,
    bestSimilarity: safeTop1,
    topAnySimilarity: safeTop1,
    secondBestSimilarity: safeTop2,
    margin,
    rejectedReason: null,
    dimMismatchCount,
  };
}
