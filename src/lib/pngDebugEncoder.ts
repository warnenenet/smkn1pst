import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import type { BBoxXYXY, PartialFiveLandmarks } from './faceQualityGate.ts';

export interface DebugAnnotatedFace {
  bbox: BBoxXYXY;
  passed: boolean;
  label: string;
  landmarks?: PartialFiveLandmarks;
}

const FONT_5X7: Record<string, string[]> = {
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  B: ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
  C: ['01110', '10001', '10000', '10000', '10000', '10001', '01110'],
  D: ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  F: ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
  G: ['01110', '10001', '10000', '10111', '10001', '10001', '01110'],
  H: ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
  I: ['01110', '00100', '00100', '00100', '00100', '00100', '01110'],
  K: ['10001', '10010', '10100', '11000', '10100', '10010', '10001'],
  L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
  M: ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
  N: ['10001', '11001', '10101', '10011', '10001', '10001', '10001'],
  O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  P: ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
  Q: ['01110', '10001', '10001', '10001', '10101', '10010', '01101'],
  R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
  T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
  U: ['10001', '10001', '10001', '10001', '10001', '10001', '01110'],
  V: ['10001', '10001', '10001', '10001', '10001', '01010', '00100'],
  W: ['10001', '10001', '10001', '10101', '10101', '11011', '10001'],
  X: ['10001', '10001', '01010', '00100', '01010', '10001', '10001'],
  Y: ['10001', '10001', '01010', '00100', '00100', '00100', '00100'],
  Z: ['11111', '00001', '00010', '00100', '01000', '10000', '11111'],
  '0': ['01110', '10011', '10101', '10101', '11001', '10001', '01110'],
  '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  '2': ['01110', '10001', '00001', '00110', '01000', '10000', '11111'],
  '3': ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
  '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  '5': ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  '6': ['01110', '10000', '10000', '11110', '10001', '10001', '01110'],
  '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  '9': ['01110', '10001', '10001', '01111', '00001', '00001', '01110'],
  ':': ['00000', '00100', '00100', '00000', '00100', '00100', '00000'],
  '.': ['00000', '00000', '00000', '00000', '00000', '01100', '01100'],
  '-': ['00000', '00000', '00000', '11111', '00000', '00000', '00000'],
  '=': ['00000', '00000', '11111', '00000', '11111', '00000', '00000'],
  '/': ['00001', '00010', '00010', '00100', '01000', '01000', '10000'],
  '<': ['00010', '00100', '01000', '10000', '01000', '00100', '00010'],
  '>': ['01000', '00100', '00010', '00001', '00010', '00100', '01000'],
  ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000'],
};

function setPx(rgba: Uint8Array, w: number, h: number, x: number, y: number, r: number, g: number, b: number) {
  if (x < 0 || y < 0 || x >= w || y >= h) return;
  const i = (y * w + x) * 4;
  rgba[i] = r;
  rgba[i + 1] = g;
  rgba[i + 2] = b;
  rgba[i + 3] = 255;
}

function drawRectOutline(
  rgba: Uint8Array,
  w: number,
  h: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  color: [number, number, number],
  thickness = 2
) {
  for (let t = 0; t < thickness; t++) {
    for (let x = x1; x <= x2; x++) {
      setPx(rgba, w, h, x, y1 + t, color[0], color[1], color[2]);
      setPx(rgba, w, h, x, y2 - t, color[0], color[1], color[2]);
    }
    for (let y = y1; y <= y2; y++) {
      setPx(rgba, w, h, x1 + t, y, color[0], color[1], color[2]);
      setPx(rgba, w, h, x2 - t, y, color[0], color[1], color[2]);
    }
  }
}

function drawCircleDot(
  rgba: Uint8Array,
  w: number,
  h: number,
  cx: number,
  cy: number,
  radius: number,
  color: [number, number, number]
) {
  const r2 = radius * radius;
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      if (dx * dx + dy * dy <= r2) {
        setPx(rgba, w, h, cx + dx, cy + dy, color[0], color[1], color[2]);
      }
    }
  }
}

function drawLabel(
  rgba: Uint8Array,
  w: number,
  h: number,
  x: number,
  y: number,
  text: string,
  bg: [number, number, number],
  fg: [number, number, number] = [255, 255, 255]
) {
  const clean = text.toUpperCase().slice(0, 32);
  const scale = 2;
  const charW = 6 * scale;
  const boxW = clean.length * charW + 6;
  const boxH = 7 * scale + 6;
  const startY = Math.max(0, y - boxH - 2);
  const startX = Math.max(0, Math.min(w - boxW - 1, x));

  for (let py = startY; py < startY + boxH && py < h; py++) {
    for (let px = startX; px < startX + boxW && px < w; px++) {
      setPx(rgba, w, h, px, py, bg[0], bg[1], bg[2]);
    }
  }

  for (let idx = 0; idx < clean.length; idx++) {
    const ch = FONT_5X7[clean[idx]] ?? FONT_5X7[' '];
    const ox = startX + 3 + idx * charW;
    const oy = startY + 3;
    for (let row = 0; row < 7; row++) {
      for (let col = 0; col < 5; col++) {
        if (ch[row][col] === '1') {
          for (let sy = 0; sy < scale; sy++) {
            for (let sx = 0; sx < scale; sx++) {
              setPx(rgba, w, h, ox + col * scale + sx, oy + row * scale + sy, fg[0], fg[1], fg[2]);
            }
          }
        }
      }
    }
  }
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Buffer {
  const out = Buffer.alloc(4 + 4 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 4, 'ascii');
  Buffer.from(data.buffer, data.byteOffset, data.byteLength).copy(out, 8);
  const crc = crc32(out.subarray(4, 8 + data.length));
  out.writeUInt32BE(crc, 8 + data.length);
  return out;
}

export function encodeRgbaToPng(rgba: Uint8Array, width: number, height: number): Buffer {
  const stride = width * 4 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const rowOut = y * stride;
    raw[rowOut] = 0; // filter None
    const rowIn = y * width * 4;
    Buffer.from(rgba.buffer, rgba.byteOffset + rowIn, width * 4).copy(raw, rowOut + 1);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const idat = zlib.deflateSync(raw, { level: 6 });
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

export function renderAndSaveDebugDetectionPng(params: {
  rgba: Uint8Array;
  width: number;
  height: number;
  cameraId: number;
  debugDir: string;
  faces: DebugAnnotatedFace[];
  maxFilesPerCamera?: number;
  timestampMs?: number;
}): string {
  const { rgba, width, height, cameraId, debugDir, faces, maxFilesPerCamera = 50, timestampMs = Date.now() } = params;
  // Salin buffer hanya saat debug_detection ON (fungsi ini tidak pernah dipanggil saat OFF)
  const canvas = new Uint8Array(rgba);

  for (const f of faces) {
    const x1 = Math.max(0, Math.min(width - 2, Math.round(f.bbox.x1)));
    const y1 = Math.max(0, Math.min(height - 2, Math.round(f.bbox.y1)));
    const x2 = Math.max(x1 + 2, Math.min(width - 1, Math.round(f.bbox.x2)));
    const y2 = Math.max(y1 + 2, Math.min(height - 1, Math.round(f.bbox.y2)));
    const color: [number, number, number] = f.passed ? [34, 197, 94] : [239, 68, 68]; // hijau lolos / merah ditolak

    drawRectOutline(canvas, width, height, x1, y1, x2, y2, color, 3);
    drawLabel(canvas, width, height, x1, y1, f.label, color);

    const lm = f.landmarks;
    if (lm) {
      const pts = [lm.leftEye, lm.rightEye, lm.nose, lm.mouthLeft, lm.mouthRight];
      for (const p of pts) {
        if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) {
          drawCircleDot(canvas, width, height, Math.round(p.x), Math.round(p.y), 4, [59, 130, 246]); // biru 5 landmark
        }
      }
    }
  }

  fs.mkdirSync(debugDir, { recursive: true });
  const filename = `cam${cameraId}_${timestampMs}.png`;
  const fullPath = path.join(debugDir, filename);
  fs.writeFileSync(fullPath, encodeRgbaToPng(canvas, width, height));

  // Rotasi maksimal N file per kamera (default 50)
  const prefix = `cam${cameraId}_`;
  const existing = fs
    .readdirSync(debugDir)
    .filter((n) => n.startsWith(prefix) && n.endsWith('.png'))
    .sort();
  while (existing.length > maxFilesPerCamera) {
    const oldest = existing.shift();
    if (oldest) {
      try {
        fs.unlinkSync(path.join(debugDir, oldest));
      } catch {
        // ignore rotation unlink failure
      }
    }
  }

  return fullPath;
}
