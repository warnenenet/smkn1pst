import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  getOrCreateInternalToken,
  readInternalTokenFromFile,
  resetInternalTokenCacheForTests,
  resolveInternalTokenFilePath,
} from './internalToken';

test('resolveInternalTokenFilePath prioritizes existing container secret file over dataDir fallback', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'absensi-token-test-'));
  try {
    const containerToken = path.join(tmp, 'container_secrets', 'internal_token');
    const dataDir = path.join(tmp, 'data');

    // Container file belum ada -> fallback ke <dataDir>/secrets/internal_token
    assert.equal(
      resolveInternalTokenFilePath({ dataDir, containerTokenPath: containerToken }),
      path.join(dataDir, 'secrets', 'internal_token')
    );

    // Setelah container file dibuat oleh entrypoint.sh -> selalu pakai container file
    fs.mkdirSync(path.dirname(containerToken), { recursive: true });
    fs.writeFileSync(containerToken, 'abcdef0123456789\n', 'utf8');
    assert.equal(
      resolveInternalTokenFilePath({ dataDir, containerTokenPath: containerToken }),
      containerToken
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('getOrCreateInternalToken generates 96-hex-char secret (chmod 600) and ignores env vars', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'absensi-token-gen-'));
  const prevEnv = process.env.INTERNAL_API_TOKEN;
  process.env.INTERNAL_API_TOKEN = 'env-should-be-ignored';
  resetInternalTokenCacheForTests();
  try {
    const dataDir = path.join(tmp, 'data');
    const missingContainerToken = path.join(tmp, 'missing', 'internal_token');

    const token1 = getOrCreateInternalToken({ dataDir, containerTokenPath: missingContainerToken });
    assert.match(token1, /^[0-9a-f]{96}$/);
    assert.notEqual(token1, 'env-should-be-ignored');

    const expectedFile = path.join(dataDir, 'secrets', 'internal_token');
    assert.equal(readInternalTokenFromFile(expectedFile), token1);
    const mode = fs.statSync(expectedFile).mode & 0o777;
    assert.equal(mode, 0o600);

    // Pembacaan berikutnya mengembalikan token yang sama
    resetInternalTokenCacheForTests();
    const token2 = getOrCreateInternalToken({ dataDir, containerTokenPath: missingContainerToken });
    assert.equal(token2, token1);
  } finally {
    if (prevEnv === undefined) {
      delete process.env.INTERNAL_API_TOKEN;
    } else {
      process.env.INTERNAL_API_TOKEN = prevEnv;
    }
    resetInternalTokenCacheForTests();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
