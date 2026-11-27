import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildWaGatewayHeaders,
  isLoopbackWaUrl,
  parseWaGatewayHealthPayload,
} from './waGatewayContract.ts';

test('WA gateway contract builds auth headers and parses Baileys health payload', () => {
  const headers = buildWaGatewayHeaders('secret-token-123', true);
  assert.equal(headers['X-Internal-Token'], 'secret-token-123');
  assert.equal(headers['Content-Type'], 'application/json');

  const noBody = buildWaGatewayHeaders('', false);
  assert.deepEqual(noBody, {});

  assert.equal(isLoopbackWaUrl('http://127.0.0.1:8003'), true);
  assert.equal(isLoopbackWaUrl('http://localhost:8003'), true);
  assert.equal(isLoopbackWaUrl('https://evil.example.com:8003'), false);

  const parsed = parseWaGatewayHealthPayload({
    ok: true,
    engine: 'baileys-node',
    active_browsers: 1,
    max_chrome: 0,
    accounts_total: 2,
    accounts_connected: 1,
    chromium_bin: null,
    xvfb_available: false,
  });
  assert.equal(parsed.online, true);
  assert.equal(parsed.engine, 'baileys-node');
  assert.equal(parsed.accounts_connected, 1);
  assert.equal(parsed.xvfb_available, false);
});
