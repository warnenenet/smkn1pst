import type { AppDatabase } from '../types';

export const CONFIG_FORM_TABS = new Set<string>([
  'production-setup',
  'settings',
  'schedules',
  'whatsapp',
  'students',
  'cameras',
]);

export function isConfigFormTab(tab: string): boolean {
  return CONFIG_FORM_TABS.has(tab);
}

export function shouldPauseBackgroundBootstrap(params: {
  activeTab: string;
  activeElementTag?: string | null;
  isContentEditable?: boolean;
  hasDirtyForm?: boolean;
}): boolean {
  if (isConfigFormTab(params.activeTab)) {
    return true;
  }
  if (params.hasDirtyForm || params.isContentEditable) {
    return true;
  }
  const tag = (params.activeElementTag ?? '').toUpperCase();
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
    return true;
  }
  return false;
}

export function shouldSyncFormFromServer(params: {
  isDirty: boolean;
  nextSerialized: string;
  lastSyncedSerialized: string;
}): boolean {
  if (params.isDirty) {
    return false;
  }
  return params.nextSerialized !== params.lastSyncedSerialized;
}

export function stripEmbeddingsForBootstrap(db: AppDatabase): AppDatabase {
  return {
    ...db,
    students: db.students.map((s) => ({
      ...s,
      embedding: Array.isArray(s.embedding) && s.embedding.length > 0 ? [1] : null,
    })),
    anonymous_clusters: db.anonymous_clusters.map((c) => ({
      ...c,
      centroid: [],
      best_embedding: [],
      hit_snapshots: Array.isArray(c.hit_snapshots)
        ? c.hit_snapshots.map(({ embedding, has_embedding, ...rest }) => ({
            ...rest,
            has_embedding: Boolean(has_embedding || (Array.isArray(embedding) && embedding.length > 0)),
          }))
        : [],
    })),
    face_update_history: db.face_update_history.map((h) => ({
      ...h,
      embedding: [],
    })),
  };
}
