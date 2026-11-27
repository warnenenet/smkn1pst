import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  decodeEmbeddingBlobLe,
  encodeEmbeddingBlobLe,
  isLegacyPipelineRow,
  normalizeConservativeThresholds,
} from './faceInterop.ts';

test('Test #12: 512-D Float32 LE BLOB round-trip TS <-> SQLite <-> Rust binary layout', () => {
  const raw = new Array<number>(512);
  let sumSq = 0;
  for (let i = 0; i < 512; i++) {
    const v = Math.sin(i * 0.173) - Math.cos(i * 0.041) * 0.5;
    raw[i] = v;
    sumSq += v * v;
  }
  const norm = Math.sqrt(sumSq);
  const unit = raw.map((v) => v / norm);

  const blob = encodeEmbeddingBlobLe(unit);
  assert.ok(blob instanceof Uint8Array);
  assert.equal(blob.byteLength, 512 * 4);

  // Write and read back through real SQLite BLOB column
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'absensi-blob-test-'));
  const dbFile = path.join(tmpDir, 'test.sqlite');
  try {
    const db = new DatabaseSync(dbFile);
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, embedding BLOB, pipeline_version TEXT, model_sha256 TEXT);');
    db.prepare('INSERT INTO t (id, embedding, pipeline_version, model_sha256) VALUES (?, ?, ?, ?)').run(
      1,
      blob,
      'rust-scrfd-arcface-b1',
      'a'.repeat(64)
    );
    const row = db.prepare('SELECT embedding, pipeline_version, model_sha256 FROM t WHERE id = 1').get() as {
      embedding: Uint8Array;
      pipeline_version: string | null;
      model_sha256: string | null;
    };
    db.close();

    const decoded = decodeEmbeddingBlobLe(row.embedding);
    assert.ok(decoded !== null);
    assert.equal(decoded.length, 512);

    let maxErr = 0;
    for (let i = 0; i < 512; i++) {
      maxErr = Math.max(maxErr, Math.abs(decoded[i] - unit[i]));
    }
    assert.ok(maxErr < 1e-5, `Expected max float32/5-decimal error < 1e-5, got ${maxErr}`);
    assert.equal(row.pipeline_version, 'rust-scrfd-arcface-b1');
    assert.equal(isLegacyPipelineRow(row), false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Test #13: NULL pipeline_version identifies legacy embeddings without breaking decode', () => {
  assert.equal(isLegacyPipelineRow({ pipeline_version: null, model_sha256: null }), true);
  assert.equal(isLegacyPipelineRow({ pipeline_version: '', model_sha256: null }), true);
  assert.equal(
    isLegacyPipelineRow({ pipeline_version: 'rust-scrfd-arcface-b1', model_sha256: 'abc' }),
    false
  );
  assert.equal(decodeEmbeddingBlobLe(null), null);
  assert.equal(decodeEmbeddingBlobLe(new Uint8Array([1, 2, 3])), null);
});

test('Test #14: Conservative thresholds defaults & calibration override structure', () => {
  const defaults = normalizeConservativeThresholds(undefined);
  assert.equal(defaults.embed_min_face_px, 80);
  assert.equal(defaults.threshold_recognition, 0.7);
  assert.equal(defaults.match_margin_min, 0.08);
  assert.equal(defaults.max_pitch_deg, 30);

  const custom = normalizeConservativeThresholds({
    min_face_size: 96,
    threshold_recognition: 0.74,
    match_margin_min: 0.1,
    max_pitch_deg: 22,
  });
  assert.equal(custom.embed_min_face_px, 96);
  assert.equal(custom.threshold_recognition, 0.74);
  assert.equal(custom.match_margin_min, 0.1);
  assert.equal(custom.max_pitch_deg, 22);
});
