import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFaceVectorIndex, findBestFaceMatch, normalizeToFloat32 } from './faceIndex';

test('normalizeToFloat32 produces unit vector and rejects empty or zero vectors', () => {
  assert.equal(normalizeToFloat32([]), null);
  assert.equal(normalizeToFloat32([0, 0, 0]), null);

  const unit = normalizeToFloat32([3, 4]);
  assert.ok(unit);
  assert.ok(Math.abs(unit[0] - 0.6) < 1e-5);
  assert.ok(Math.abs(unit[1] - 0.8) < 1e-5);
});

test('findBestFaceMatch matches highest similarity across matching dimension and counts mismatches', () => {
  const index = buildFaceVectorIndex([
    { id: 10, embedding: [1, 0, 0, 0] },
    { id: 20, embedding: [0.6, 0.8, 0, 0] },
    { id: 30, embedding: Array(16).fill(0.25) },
  ]);

  const res = findBestFaceMatch(index, [0.58, 0.81, 0, 0], 0.7);
  assert.equal(res.bestId, 20);
  assert.ok(res.bestSimilarity > 0.99);
  assert.equal(res.dimMismatchCount, 1);

  const belowThresh = findBestFaceMatch(index, [-1, 0, 0, 0], 0.7);
  assert.equal(belowThresh.bestId, null);
  assert.equal(belowThresh.bestSimilarity, 0);
});

test('findBestFaceMatch handles 5,000 512-dim students accurately and rapidly', () => {
  const entries = [];
  for (let i = 1; i <= 5000; i++) {
    const vec = new Array<number>(512).fill(0);
    vec[i % 512] = 1;
    vec[(i * 7) % 512] += 0.25;
    vec[(Math.floor(i / 512) * 37 + 13) % 512] += 0.45;
    entries.push({ id: i, embedding: vec });
  }
  const targetVec = new Array<number>(512).fill(0);
  targetVec[4242 % 512] = 1;
  targetVec[(4242 * 7) % 512] += 0.25;
  targetVec[(Math.floor(4242 / 512) * 37 + 13) % 512] += 0.45;

  const index = buildFaceVectorIndex(entries, 1);
  assert.equal(index.totalIndexed, 5000);

  const t0 = performance.now();
  const match = findBestFaceMatch(index, targetVec, 0.7);
  const elapsedMs = performance.now() - t0;

  assert.ok(match.bestSimilarity > 0.999);
  assert.equal(match.bestId, 4242);
  assert.ok(elapsedMs < 50, `Expected <50ms for 5000x512 match, got ${elapsedMs.toFixed(2)}ms`);
});

test('findBestFaceMatch enforces top-1 vs top-2 margin check (ambiguous_margin)', () => {
  // Basis ortonormal di R^4:
  // Siswa 101 = [1, 0, 0, 0]
  // Siswa 102 = [0, 1, 0, 0]
  const index = buildFaceVectorIndex([
    { id: 101, embedding: [1, 0, 0, 0] },
    { id: 102, embedding: [0, 1, 0, 0] },
  ]);

  // 1. Margin cukup: query [0.85, 0.52678, 0, 0] -> sim1=0.85, sim2=0.527, margin=0.323 >= 0.08 -> match 101
  const clearMatch = findBestFaceMatch(index, [0.85, 0.52678, 0, 0], 0.7, 0.08);
  assert.equal(clearMatch.bestId, 101);
  assert.equal(clearMatch.rejectedReason, null);
  assert.ok(clearMatch.margin >= 0.08);

  // 2. Margin sempit: query [0.73, 0.68345, 0, 0] -> sim1=0.73 (>=0.70), sim2=0.683, margin=0.047 < 0.08 -> ambiguous_margin
  const tightMargin = findBestFaceMatch(index, [0.73, 0.68345, 0, 0], 0.7, 0.08);
  assert.equal(tightMargin.bestId, null);
  assert.equal(tightMargin.rejectedReason, 'ambiguous_margin');
  assert.ok(tightMargin.topAnySimilarity >= 0.7);
  assert.ok(tightMargin.margin < 0.08);

  // 3. Top-1 di bawah threshold: query [0.65, 0.7599, 0, 0] terhadap threshold 0.80 -> below_threshold
  const lowTop1 = findBestFaceMatch(index, [0.65, 0.7599, 0, 0], 0.8, 0.08);
  assert.equal(lowTop1.bestId, null);
  assert.equal(lowTop1.rejectedReason, 'below_threshold');

  // 4. Top-2 persis sama dengan Top-1: query [Math.SQRT1_2, Math.SQRT1_2, 0, 0] (0.7071 == 0.7071, margin=0) -> ambiguous_margin
  const tieMatch = findBestFaceMatch(index, [Math.SQRT1_2, Math.SQRT1_2, 0, 0], 0.7, 0.08);
  assert.equal(tieMatch.bestId, null);
  assert.equal(tieMatch.rejectedReason, 'ambiguous_margin');
  assert.ok(tieMatch.margin < 1e-4);
});
