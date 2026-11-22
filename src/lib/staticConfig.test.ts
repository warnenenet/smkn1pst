import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getStaticAssetContentType,
  getStaticCacheControl,
  isNonSpaResourcePath,
  resolveListenConfig,
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
