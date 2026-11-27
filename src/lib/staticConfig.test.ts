import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildFfmpegLivePreviewArgs,
  buildLocalWebBackendUrl,
  computeFrameMotionDeltaRatio,
  diagnoseFfmpegError,
  extractRgbaLumaSample,
  getStaticAssetContentType,
  getStaticCacheControl,
  isNonSpaResourcePath,
  resolveCameraTelemetryConnected,
  resolveExecutableBinary,
  resolveListenConfig,
  shouldScanMotionFrame,
  shouldServeProductionBuild,
} from './staticConfig';

test('getStaticAssetContentType resolves explicit JavaScript, Wasm, and CSS MIME types', () => {
  assert.equal(getStaticAssetContentType('/app/dist/assets/index-123.js'), 'application/javascript; charset=utf-8');
  assert.equal(getStaticAssetContentType('/app/dist/assets/worker.MJS'), 'application/javascript; charset=utf-8');
  assert.equal(getStaticAssetContentType('/app/dist/assets/tfjs.wasm'), 'application/wasm');
  assert.equal(getStaticAssetContentType('/app/dist/assets/index-123.css'), 'text/css; charset=utf-8');
  assert.equal(getStaticAssetContentType('/app/dist/index.html'), 'text/html; charset=utf-8');
  assert.equal(getStaticAssetContentType('/app/src/main.tsx'), null);
});

test('shouldServeProductionBuild chooses dist in production or bare node start, and Vite in dev', () => {
  assert.equal(
    shouldServeProductionBuild({ nodeEnv: 'production', distIndexExists: true }),
    true
  );
  assert.equal(
    shouldServeProductionBuild({ nodeEnv: 'development', npmLifecycleEvent: 'dev', distIndexExists: true }),
    false
  );
  assert.equal(
    shouldServeProductionBuild({
      nodeEnv: '',
      execArgv: ['--import', 'file:///app/node_modules/tsx/dist/loader.mjs'],
      distIndexExists: true,
    }),
    false
  );
  assert.equal(
    shouldServeProductionBuild({
      nodeEnv: undefined,
      npmLifecycleEvent: 'start',
      execArgv: [],
      argv: ['node', 'server.ts'],
      distIndexExists: true,
    }),
    true
  );
  assert.equal(
    shouldServeProductionBuild({
      nodeEnv: undefined,
      npmLifecycleEvent: 'start',
      execArgv: [],
      argv: ['node', 'server.ts'],
      distIndexExists: false,
    }),
    true
  );
  assert.equal(
    shouldServeProductionBuild({
      nodeEnv: 'development',
      npmLifecycleEvent: 'start',
      execArgv: [],
      argv: ['node', 'server.ts'],
      distIndexExists: false,
    }),
    true
  );
});

test('isNonSpaResourcePath blocks assets, api, src, node_modules, vite dev paths, and asset extensions from SPA HTML fallback', () => {
  assert.equal(isNonSpaResourcePath('/assets/index-missing.js'), true);
  assert.equal(isNonSpaResourcePath('/src/main.tsx'), true);
  assert.equal(isNonSpaResourcePath('/api/unknown'), true);
  assert.equal(isNonSpaResourcePath('/module.mjs'), true);
  assert.equal(isNonSpaResourcePath('/@vite/client'), true);
  assert.equal(isNonSpaResourcePath('/@react-refresh'), true);
  assert.equal(isNonSpaResourcePath('/node_modules/vite/dist/client/env.mjs'), true);
  assert.equal(isNonSpaResourcePath('/node_modules/.vite/deps/react_jsx-dev-runtime.js'), true);
  assert.equal(isNonSpaResourcePath('/'), false);
  assert.equal(isNonSpaResourcePath('/ortu'), false);
  assert.equal(isNonSpaResourcePath('/login'), false);
  assert.equal(isNonSpaResourcePath('/panggil/4'), false);
});

test('getStaticCacheControl disables cache for index.html and makes hashed assets immutable', () => {
  assert.equal(getStaticCacheControl('/app/dist/index.html'), 'no-cache, no-store, must-revalidate');
  assert.equal(getStaticCacheControl('/app/dist/assets/index-BGWKy8BM.js'), 'public, max-age=31536000, immutable');
});

test('resolveListenConfig prioritizes CLI --port over .env PORT and supports multi-school hosts', () => {
  assert.deepEqual(resolveListenConfig({ argv: [], env: {} }), {
    port: 3000,
    host: undefined,
    autoPortFallback: false,
  });
  assert.deepEqual(resolveListenConfig({ argv: [], env: { PORT: '3002', HOST: '127.0.0.1' } }), {
    port: 3002,
    host: '127.0.0.1',
    autoPortFallback: false,
  });
  assert.deepEqual(
    resolveListenConfig({
      argv: ['node', 'server.ts', '--port', '3015', '--host=0.0.0.0'],
      env: { PORT: '3002', AUTO_PORT_FALLBACK: '1' },
    }),
    {
      port: 3015,
      host: '0.0.0.0',
      autoPortFallback: true,
    }
  );
  assert.deepEqual(
    resolveListenConfig({ argv: ['node', 'server.ts', '--port=3025'], env: { PORT: '3000' } }),
    {
      port: 3025,
      host: undefined,
      autoPortFallback: false,
    }
  );
});

test('resolveExecutableBinary repairs 0644 binary via chmod 0755 on real temp file', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'absensi-bin-test-'));
  try {
    const fakeFfmpeg = path.join(tmpDir, 'ffmpeg');
    fs.writeFileSync(fakeFfmpeg, '#!/bin/sh\necho ok\n', { mode: 0o644 });
    fs.chmodSync(fakeFfmpeg, 0o644);

    const res = resolveExecutableBinary({
      candidates: [fakeFfmpeg],
      binaryName: 'ffmpeg',
      ops: {
        existsSync: (p) => fs.existsSync(p),
        isFileSync: (p) => fs.statSync(p).isFile(),
        canExecuteSync: (p) => {
          fs.accessSync(p, fs.constants.X_OK);
          return true;
        },
        chmodSync: (p, mode) => fs.chmodSync(p, mode),
      },
    });

    assert.equal(res.foundExecutable, true);
    assert.equal(res.binary, fakeFfmpeg);
    assert.deepEqual(res.repairedPaths, [fakeFfmpeg]);
    assert.deepEqual(res.nonExecutablePaths, []);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('resolveExecutableBinary skips blocked EACCES candidate and falls back to executable system binary', () => {
  const blocked = '/www/wwwroot/smkn1pst/node_modules/@ffmpeg-installer/linux-x64/ffmpeg';
  const sysFfmpeg = '/usr/bin/ffmpeg';

  const res = resolveExecutableBinary({
    candidates: [blocked, sysFfmpeg],
    binaryName: 'ffmpeg',
    ops: {
      existsSync: (p) => p === blocked || p === sysFfmpeg,
      isFileSync: (p) => p === blocked || p === sysFfmpeg,
      canExecuteSync: (p) => p === sysFfmpeg,
      chmodSync: (p) => {
        if (p === blocked) {
          throw new Error('EPERM: operation not permitted');
        }
      },
    },
  });

  assert.equal(res.foundExecutable, true);
  assert.equal(res.binary, sysFfmpeg);
  assert.deepEqual(res.nonExecutablePaths, [blocked]);
});

test('diagnoseFfmpegError produces clear actionable fix for EACCES and non-executable binaries', () => {
  const blocked = '/www/wwwroot/smkn1pst/node_modules/@ffmpeg-installer/linux-x64/ffmpeg';
  const diag = diagnoseFfmpegError(`spawn ${blocked} EACCES`, {
    binary: blocked,
    foundExecutable: false,
    nonExecutablePaths: [blocked],
  });
  assert.match(diag, /EACCES/);
  assert.match(diag, /chmod \+x/);
  assert.match(diag, /apt install -y ffmpeg/);
});

test('buildFfmpegLivePreviewArgs builds 5fps and native RTSP stream filters safely', () => {
  const res5 = buildFfmpegLivePreviewArgs({
    url: 'rtsp://admin:pass@10.0.0.5:554/ch1',
    fpsMode: '5',
    timeoutFlag: '-stimeout',
    maxWidth: 1280,
  });
  assert.equal(res5.mode, '5');
  assert.ok(res5.args.includes('-threads'));
  assert.equal(res5.args[res5.args.indexOf('-threads') + 1], '2');
  assert.ok(res5.args.includes("fps=5,scale='min(1280,iw)':-2"));
  assert.ok(res5.args.includes('-stimeout'));
  assert.ok(res5.args.includes('image2pipe'));

  const resNative = buildFfmpegLivePreviewArgs({
    url: 'rtsp://admin:pass@10.0.0.5:554/ch1',
    fpsMode: 'native',
    timeoutFlag: '-rw_timeout',
    maxWidth: 960,
  });
  assert.equal(resNative.mode, 'native');
  assert.ok(resNative.args.includes('-threads'));
  assert.ok(resNative.args.includes("scale='min(960,iw)':-2"));
  assert.equal(resNative.args.some((a) => a.includes('fps=')), false);
  assert.ok(resNative.args.includes('-rw_timeout'));
});

test('extractRgbaLumaSample and computeFrameMotionDeltaRatio distinguish static vs changed frames', () => {
  const staticFrameA = new Uint8Array(64 * 4).fill(100);
  const staticFrameB = new Uint8Array(64 * 4).fill(101);
  const movedFrame = new Uint8Array(64 * 4).fill(210);

  const sampleA = extractRgbaLumaSample(staticFrameA, 16);
  const sampleB = extractRgbaLumaSample(staticFrameB, 16);
  const sampleMoved = extractRgbaLumaSample(movedFrame, 16);

  assert.ok(computeFrameMotionDeltaRatio(sampleA, sampleB) < 0.01);
  assert.ok(computeFrameMotionDeltaRatio(sampleA, sampleMoved) > 0.35);
  assert.equal(computeFrameMotionDeltaRatio(null, sampleA), 1);
});

test('shouldScanMotionFrame detects localized walking person in small subset of pixels and honors 1500ms heartbeat', () => {
  const prev = new Uint8Array(256).fill(120);
  const staticCur = new Uint8Array(256).fill(121);
  assert.equal(shouldScanMotionFrame(prev, staticCur, 400), false);
  assert.equal(shouldScanMotionFrame(prev, staticCur, 1600), true);

  // Hanya ~4% area frame berubah (10 dari 256 sel berubah >= 25 luma -> satu siswa lewat di gerbang lebar)
  const localizedWalk = new Uint8Array(256).fill(120);
  for (let i = 100; i < 110; i++) {
    localizedWalk[i] = 155;
  }
  assert.equal(shouldScanMotionFrame(prev, localizedWalk, 300), true);
});

test('compareSemver and isNewerVersionAvailable detect new releases accurately', async () => {
  const { compareSemver, isNewerVersionAvailable } = await import('./staticConfig');

  assert.equal(compareSemver('1.0.0', 'v1.0.0'), 0);
  assert.equal(compareSemver('1.0.1', '1.0.0'), 1);
  assert.equal(compareSemver('1.10.0', '1.2.0'), 1);
  assert.equal(compareSemver('2.0.0', '1.99.99'), 1);
  assert.equal(compareSemver('1.0.0', '1.0.1'), -1);

  assert.equal(isNewerVersionAvailable('1.0.0', '1.0.1'), true);
  assert.equal(isNewerVersionAvailable('1.0.1', 'v1.1.0'), true);
  assert.equal(isNewerVersionAvailable('1.0.1', '1.0.1'), false);
  assert.equal(isNewerVersionAvailable('1.2.0', '1.1.9'), false);
  assert.equal(isNewerVersionAvailable('invalid', '1.0.1'), false);
});

test('buildLocalWebBackendUrl normalizes host bindings to reachable loopback URL', () => {
  assert.equal(buildLocalWebBackendUrl(3000), 'http://127.0.0.1:3000');
  assert.equal(buildLocalWebBackendUrl(3001, '0.0.0.0'), 'http://127.0.0.1:3001');
  assert.equal(buildLocalWebBackendUrl(3002, '::'), 'http://127.0.0.1:3002');
  assert.equal(buildLocalWebBackendUrl(3003, 'localhost'), 'http://127.0.0.1:3003');
  assert.equal(buildLocalWebBackendUrl(3004, '::1'), 'http://[::1]:3004');
  assert.equal(buildLocalWebBackendUrl(3005, '127.0.0.1'), 'http://127.0.0.1:3005');
});

test('resolveCameraTelemetryConnected never marks camera LIVE without active Python heartbeat telemetry', () => {
  assert.equal(resolveCameraTelemetryConnected({ pyTelConnected: undefined, aktif: true, pythonActive: true }), false);
  assert.equal(resolveCameraTelemetryConnected({ pyTelConnected: false, aktif: true, pythonActive: true }), false);
  assert.equal(resolveCameraTelemetryConnected({ pyTelConnected: true, aktif: false, pythonActive: true }), false);
  assert.equal(resolveCameraTelemetryConnected({ pyTelConnected: true, aktif: true, pythonActive: false }), false);
  assert.equal(resolveCameraTelemetryConnected({ pyTelConnected: true, aktif: true, pythonActive: true }), true);
});


