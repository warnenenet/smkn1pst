import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { TTS_CACHE_DIR, enforceDirQuota } from './store.ts';

const PIPER_BIN = process.env.PIPER_BIN || '/usr/local/piper/piper';
const PIPER_MODEL = process.env.PIPER_MODEL || '/app/models/piper/id_ID-news_tts-medium.onnx';
const MAX_TTS_CACHE_BYTES = 200 * 1024 * 1024; // 200 MB
const inFlightTts = new Map<string, Promise<string | null>>();

export function isPiperAvailable(): boolean {
  return fs.existsSync(PIPER_BIN) && fs.existsSync(PIPER_MODEL);
}

export async function synthesizeIndonesianWav(text: string): Promise<string | null> {
  if (!isPiperAvailable()) {
    return null;
  }

  const clean = text.trim().slice(0, 160);
  if (!clean) return null;

  fs.mkdirSync(TTS_CACHE_DIR, { recursive: true });
  const hash = crypto.createHash('sha256').update(clean.toLowerCase()).digest('hex').slice(0, 24);
  const wavPath = path.join(TTS_CACHE_DIR, `${hash}.wav`);

  if (fs.existsSync(wavPath)) {
    const now = new Date();
    try {
      fs.utimesSync(wavPath, now, now);
    } catch {
      // ignore touch error
    }
    return wavPath;
  }

  const existing = inFlightTts.get(hash);
  if (existing) {
    return existing;
  }

  const task = (async () => {
    const tmpPath = `${wavPath}.${process.pid}.${Date.now()}.tmp`;
    try {
      await new Promise<void>((resolve, reject) => {
        const proc = spawn(PIPER_BIN, ['--model', PIPER_MODEL, '--output_file', tmpPath], {
          stdio: ['pipe', 'ignore', 'pipe'],
        });
        let stderr = '';
        proc.stderr.on('data', (d) => {
          stderr += String(d);
        });
        proc.on('error', reject);
        proc.on('close', (code) => {
          if (code === 0 && fs.existsSync(tmpPath)) {
            resolve();
          } else {
            reject(new Error(`Piper exit ${code}: ${stderr}`));
          }
        });
        proc.stdin.write(clean + '\n');
        proc.stdin.end();
      });

      fs.renameSync(tmpPath, wavPath);
      enforceDirQuota(TTS_CACHE_DIR, MAX_TTS_CACHE_BYTES);
      return wavPath;
    } finally {
      if (fs.existsSync(tmpPath)) {
        try {
          fs.unlinkSync(tmpPath);
        } catch {
          // ignore cleanup
        }
      }
      inFlightTts.delete(hash);
    }
  })();

  inFlightTts.set(hash, task);
  return task;
}

export function prewarmStudentNamesTts(names: string[]): void {
  if (!isPiperAvailable() || names.length === 0) return;
  const unique = Array.from(new Set(names.map((n) => n.trim()).filter(Boolean))).slice(0, 50);
  void (async () => {
    for (const name of unique) {
      try {
        await synthesizeIndonesianWav(name);
      } catch {
        // ignore prewarm failure
      }
    }
  })();
}
