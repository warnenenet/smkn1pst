import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isConfigFormTab,
  shouldPauseBackgroundBootstrap,
  shouldSyncFormFromServer,
  stripEmbeddingsForBootstrap,
} from './uiRefreshGuard';
import type { AppDatabase } from '../types';

test('isConfigFormTab identifies settings, users, schedules, whatsapp, students, and cameras', () => {
  assert.equal(isConfigFormTab('settings'), true);
  assert.equal(isConfigFormTab('schedules'), true);
  assert.equal(isConfigFormTab('whatsapp'), true);
  assert.equal(isConfigFormTab('students'), true);
  assert.equal(isConfigFormTab('cameras'), true);
  assert.equal(isConfigFormTab('dashboard'), false);
  assert.equal(isConfigFormTab('attendance'), false);
  assert.equal(isConfigFormTab('clusters'), false);
});

test('shouldPauseBackgroundBootstrap prevents polling resets on config tabs and active form inputs', () => {
  assert.equal(shouldPauseBackgroundBootstrap({ activeTab: 'settings' }), true);
  assert.equal(shouldPauseBackgroundBootstrap({ activeTab: 'whatsapp' }), true);
  assert.equal(shouldPauseBackgroundBootstrap({ activeTab: 'clusters', activeElementTag: 'INPUT' }), true);
  assert.equal(shouldPauseBackgroundBootstrap({ activeTab: 'attendance', activeElementTag: 'select' }), true);
  assert.equal(shouldPauseBackgroundBootstrap({ activeTab: 'dashboard', isContentEditable: true }), true);
  assert.equal(shouldPauseBackgroundBootstrap({ activeTab: 'dashboard', hasDirtyForm: true }), true);
  assert.equal(shouldPauseBackgroundBootstrap({ activeTab: 'dashboard', activeElementTag: 'BODY' }), false);
  assert.equal(shouldPauseBackgroundBootstrap({ activeTab: 'clusters', activeElementTag: 'BUTTON' }), false);
});

test('shouldSyncFormFromServer never overwrites dirty local drafts', () => {
  assert.equal(
    shouldSyncFormFromServer({ isDirty: true, nextSerialized: '{"a":2}', lastSyncedSerialized: '{"a":1}' }),
    false
  );
  assert.equal(
    shouldSyncFormFromServer({ isDirty: false, nextSerialized: '{"a":1}', lastSyncedSerialized: '{"a":1}' }),
    false
  );
  assert.equal(
    shouldSyncFormFromServer({ isDirty: false, nextSerialized: '{"a":2}', lastSyncedSerialized: '{"a":1}' }),
    true
  );
});

test('stripEmbeddingsForBootstrap drops large float vectors while preserving presence flag', () => {
  const dummy = {
    students: [
      { id: 1, embedding: new Array(1024).fill(0.25), nama: 'A' },
      { id: 2, embedding: null, nama: 'B' },
    ],
    anonymous_clusters: [{ id: 10, centroid: [0.1, 0.2], best_embedding: [0.3, 0.4] }],
    face_update_history: [{ id: 20, embedding: [0.5, 0.6] }],
  } as unknown as AppDatabase;

  const stripped = stripEmbeddingsForBootstrap(dummy);
  assert.deepEqual(stripped.students[0].embedding, [1]);
  assert.equal(stripped.students[1].embedding, null);
  assert.deepEqual(stripped.anonymous_clusters[0].centroid, []);
  assert.deepEqual(stripped.anonymous_clusters[0].best_embedding, []);
  assert.deepEqual(stripped.face_update_history[0].embedding, []);
});
