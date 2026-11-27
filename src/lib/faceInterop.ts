import type { SettingsMap } from '../types';

export const CONSERVATIVE_FACE_DEFAULTS = {
  embed_min_face_px: 80,
  threshold_recognition: 0.7,
  match_margin_min: 0.08,
  max_pitch_deg: 30,
  max_yaw_deg: 30,
  blur_threshold: 100,
  dedup_cooldown_sec: 6,
  vote_threshold: 0.65,
  vote_window_sec: 10,
} as const;

export function encodeEmbeddingBlobLe(vec: readonly number[] | null | undefined): Uint8Array | null {
  if (!Array.isArray(vec) || vec.length === 0) return null;
  const f32 = new Float32Array(vec.length);
  for (let i = 0; i < vec.length; i++) {
    f32[i] = Number(vec[i]) || 0;
  }
  return new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength);
}

export function decodeEmbeddingBlobLe(raw: unknown): number[] | null {
  if (!raw || !(raw instanceof Uint8Array) || raw.byteLength < 4 || raw.byteLength % 4 !== 0) {
    return null;
  }
  const buf = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
  const count = buf.byteLength / 4;
  const out = new Array<number>(count);
  for (let i = 0; i < count; i++) {
    out[i] = Math.round(buf.readFloatLE(i * 4) * 100000) / 100000;
  }
  return out;
}

export function isLegacyPipelineRow(row: {
  pipeline_version?: string | null;
  model_sha256?: string | null;
}): boolean {
  return !row.pipeline_version || String(row.pipeline_version).trim().length === 0;
}

export function normalizeConservativeThresholds(settings: Partial<SettingsMap> | undefined): {
  embed_min_face_px: number;
  threshold_recognition: number;
  match_margin_min: number;
  max_pitch_deg: number;
  max_yaw_deg: number;
  blur_threshold: number;
  dedup_cooldown_sec: number;
} {
  const rawMin = Number(settings?.embed_min_face_px ?? settings?.min_face_size);
  const embedMinFacePx = Number.isFinite(rawMin) && rawMin >= 32 ? Math.round(rawMin) : CONSERVATIVE_FACE_DEFAULTS.embed_min_face_px;

  const rawRec = Number(settings?.threshold_recognition);
  const thresholdRecognition =
    Number.isFinite(rawRec) && rawRec > 0 && rawRec <= 1 ? rawRec : CONSERVATIVE_FACE_DEFAULTS.threshold_recognition;

  const rawMargin = Number(settings?.match_margin_min);
  const matchMarginMin =
    Number.isFinite(rawMargin) && rawMargin >= 0 && rawMargin <= 0.5 ? rawMargin : CONSERVATIVE_FACE_DEFAULTS.match_margin_min;

  const rawPitch = Number(settings?.max_pitch_deg);
  const maxPitchDeg =
    Number.isFinite(rawPitch) && rawPitch >= 5 && rawPitch <= 65 ? Math.round(rawPitch) : CONSERVATIVE_FACE_DEFAULTS.max_pitch_deg;

  const rawYaw = Number(settings?.max_yaw_deg);
  const maxYawDeg =
    Number.isFinite(rawYaw) && rawYaw >= 5 && rawYaw <= 65 ? Math.round(rawYaw) : CONSERVATIVE_FACE_DEFAULTS.max_yaw_deg;

  const rawBlur = Number(settings?.blur_threshold);
  const blurThreshold =
    Number.isFinite(rawBlur) && rawBlur >= 10 ? rawBlur : CONSERVATIVE_FACE_DEFAULTS.blur_threshold;

  const rawDedup = Number(settings?.dedup_cooldown_sec);
  const dedupCooldownSec =
    Number.isFinite(rawDedup) && rawDedup >= 1 ? Math.round(rawDedup) : CONSERVATIVE_FACE_DEFAULTS.dedup_cooldown_sec;

  return {
    embed_min_face_px: embedMinFacePx,
    threshold_recognition: thresholdRecognition,
    match_margin_min: matchMarginMin,
    max_pitch_deg: maxPitchDeg,
    max_yaw_deg: maxYawDeg,
    blur_threshold: blurThreshold,
    dedup_cooldown_sec: dedupCooldownSec,
  };
}
