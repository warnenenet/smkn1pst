import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSessionCookieHeader,
  createRateLimiter,
  hasActiveAdminUser,
  isAuthorizedInternalRequest,
  isSameOriginMutationRequest,
  isStrongSetupPassword,
  timingSafeStringEqual,
  validateRtspStreamUrl,
} from './security';

test('hasActiveAdminUser detects valid claimed admin and rejects empty or inactive admin', () => {
  assert.equal(hasActiveAdminUser([]), false);
  assert.equal(hasActiveAdminUser([{ role: 'BK', is_active: true, password_hash: 'aa:bb' }]), false);
  assert.equal(hasActiveAdminUser([{ role: 'ADMIN', is_active: false, password_hash: 'aa:bb' }]), false);
  assert.equal(hasActiveAdminUser([{ role: 'ADMIN', is_active: true, password_hash: '' }]), false);
  assert.equal(hasActiveAdminUser([{ role: 'ADMIN', is_active: true, password_hash: 'salt:hash' }]), true);
});

test('isStrongSetupPassword enforces min 8 chars and rejects weak defaults like admin123', () => {
  assert.equal(isStrongSetupPassword('short').valid, false);
  assert.equal(isStrongSetupPassword('admin123').valid, false);
  assert.equal(isStrongSetupPassword('12345678').valid, false);
  assert.equal(isStrongSetupPassword('SmkPercut#2026!').valid, true);
});

test('validateRtspStreamUrl accepts valid rtsp/rtsps URLs and blocks control chars or options', () => {
  assert.equal(validateRtspStreamUrl('rtsp://admin:pass@192.168.1.50:554/stream1').valid, true);
  assert.equal(validateRtspStreamUrl('rtsps://cam.school.local/live').valid, true);
  assert.equal(validateRtspStreamUrl('dummy://cam_1', { allowDummy: true }).valid, true);
  assert.equal(validateRtspStreamUrl('dummy://cam_1', { allowDummy: false }).valid, false);
  assert.equal(validateRtspStreamUrl('rtsp://host/stream\n-malicious').valid, false);
  assert.equal(validateRtspStreamUrl('-i /etc/passwd').valid, false);
  assert.equal(validateRtspStreamUrl('http://example.com/test').valid, false);
});

test('isAuthorizedInternalRequest allows direct loopback or valid X-Internal-Token and blocks proxied internet traffic', () => {
  // Direct local sidecar on 127.0.0.1 without proxy forwarding headers
  assert.equal(
    isAuthorizedInternalRequest({
      remoteAddress: '::ffff:127.0.0.1',
      headers: {},
      expectedToken: 'secret-token',
    }),
    true
  );

  // Request from Nginx proxy (remoteAddress=127.0.0.1 BUT X-Forwarded-For is present) WITHOUT token -> BLOCKED
  assert.equal(
    isAuthorizedInternalRequest({
      remoteAddress: '127.0.0.1',
      headers: { 'x-forwarded-for': '203.0.113.5' },
      expectedToken: 'secret-token',
    }),
    false
  );

  // Proxied request WITH valid X-Internal-Token -> ALLOWED
  assert.equal(
    isAuthorizedInternalRequest({
      remoteAddress: '127.0.0.1',
      headers: { 'x-forwarded-for': '203.0.113.5', 'x-internal-token': 'secret-token' },
      expectedToken: 'secret-token',
    }),
    true
  );

  // Remote non-loopback without token -> BLOCKED
  assert.equal(
    isAuthorizedInternalRequest({
      remoteAddress: '10.0.0.5',
      headers: {},
      expectedToken: 'secret-token',
    }),
    false
  );
});

test('isSameOriginMutationRequest and timingSafeStringEqual work safely', () => {
  assert.equal(timingSafeStringEqual('abc123', 'abc123'), true);
  assert.equal(timingSafeStringEqual('abc123', 'abc124'), false);
  assert.equal(timingSafeStringEqual('abc', 'abcd'), false);

  assert.equal(
    isSameOriginMutationRequest({
      method: 'POST',
      originHeader: 'https://absensi.sekolah.sch.id',
      forwardedHostHeader: 'absensi.sekolah.sch.id',
    }),
    true
  );
  assert.equal(
    isSameOriginMutationRequest({
      method: 'POST',
      originHeader: 'https://evil.attacker.com',
      hostHeader: 'absensi.sekolah.sch.id',
    }),
    false
  );
});

test('buildSessionCookieHeader and createRateLimiter enforce security flags and thresholds', () => {
  const httpsCookie = buildSessionCookieHeader({
    cookieName: 'absensi_sid',
    token: 'tok123',
    maxAgeSec: 86400,
    isHttps: true,
  });
  assert.match(httpsCookie, /HttpOnly; Secure; SameSite=None; Partitioned/);

  const httpCookie = buildSessionCookieHeader({
    cookieName: 'absensi_sid',
    token: 'tok123',
    maxAgeSec: 86400,
    isHttps: false,
  });
  assert.match(httpCookie, /HttpOnly; SameSite=Lax/);

  const limiter = createRateLimiter(3, 60_000);
  const t0 = 1_000_000;
  assert.equal(limiter.checkAndConsume('1.2.3.4', t0).allowed, true);
  assert.equal(limiter.checkAndConsume('1.2.3.4', t0 + 100).allowed, true);
  assert.equal(limiter.checkAndConsume('1.2.3.4', t0 + 200).allowed, true);
  assert.equal(limiter.checkAndConsume('1.2.3.4', t0 + 300).allowed, false);
  limiter.reset('1.2.3.4');
  assert.equal(limiter.checkAndConsume('1.2.3.4', t0 + 400).allowed, true);
});
