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
    entries.push({ id: i, embedding: vec });
  }
  const targetVec = new Array<number>(512).fill(0);
  targetVec[4242 % 512] = 1;
  targetVec[(4242 * 7) % 512] += 0.25;

  const index = buildFaceVectorIndex(entries, 1);
  assert.equal(index.totalIndexed, 5000);

  const t0 = performance.now();
  const match = findBestFaceMatch(index, targetVec, 0.7);
  const elapsedMs = performance.now() - t0;

  assert.ok(match.bestSimilarity > 0.999);
  assert.ok(match.bestId !== null);
  assert.ok(elapsedMs < 50, `Expected <50ms for 5000x512 match, got ${elapsedMs.toFixed(2)}ms`);
});
