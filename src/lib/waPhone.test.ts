import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanPhoneDigits, extractPhoneFromWaJid, isTransientGatewayFetchError } from './waPhone.ts';

test('cleanPhoneDigits normalizes Indonesian 08xx, 8xx, and +62 formats cleanly', () => {
  assert.equal(cleanPhoneDigits('085362487820'), '6285362487820');
  assert.equal(cleanPhoneDigits('853-6248-7820'), '6285362487820');
  assert.equal(cleanPhoneDigits('+62 812-3456-7890'), '6281234567890');
  assert.equal(cleanPhoneDigits(''), '');
});

test('extractPhoneFromWaJid extracts phone number from Baileys multi-device JID', () => {
  assert.equal(extractPhoneFromWaJid('6285362487820:14@s.whatsapp.net'), '6285362487820');
  assert.equal(extractPhoneFromWaJid('628111222333@s.whatsapp.net'), '628111222333');
  assert.equal(extractPhoneFromWaJid(null), null);
  assert.equal(extractPhoneFromWaJid('invalid'), null);
});

test('isTransientGatewayFetchError recognizes raw fetch failed and connection refused errors', () => {
  assert.equal(isTransientGatewayFetchError('fetch failed'), true);
  assert.equal(isTransientGatewayFetchError('connect ECONNREFUSED 127.0.0.1:8003'), true);
  assert.equal(isTransientGatewayFetchError('Python WA Gateway belum aktif.'), true);
  assert.equal(isTransientGatewayFetchError('Nomor tujuan tidak terdaftar di WhatsApp.'), false);
  assert.equal(isTransientGatewayFetchError(null), false);
});
