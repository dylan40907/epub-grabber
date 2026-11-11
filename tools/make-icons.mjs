/*
 * Generates extension/icons/*.png (an open book). No dependencies - a PNG is a handful of
 * length-prefixed, CRC'd chunks wrapped around zlib-deflated scanlines, and
 * node ships zlib.
 *
 *   node tools/make-icons.mjs
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'extension', 'icons');
const SIZES = [16, 32, 48, 128];
const SS = 4; // supersampling factor per axis, for cheap antialiasing

const BG = [0x1e, 0x3a, 0x8a];
const PAGE = [0xf8, 0xfa, 0xfc];
const LINE = [0x93, 0xa3, 0xb8];

// ------------------------------------------------------------------ shapes --

/** Signed distance to a rounded box centred at (0,0) with half-extent h. */
function sdRoundBox(x, y, hx, hy, r) {
  const qx = Math.abs(x) - hx + r;
  const qy = Math.abs(y) - hy + r;
  return Math.min(Math.max(qx, qy), 0) + Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) - r;
}

/** Colour of the icon at unit coordinates (0..1), or null for transparent. */
function sample(u, v) {
  const x = u - 0.5, y = v - 0.5;
  if (sdRoundBox(x, y, 0.48, 0.48, 0.22) > 0) return null;

  // An open book: two pages that sag towards the spine.
  const ax = Math.abs(x);
  const sag = 0.06 * (1 - ax / 0.36);
  const top = -0.22 + sag, bottom = 0.24 + sag * 0.6;
  if (ax > 0.025 && ax < 0.36 && y > top && y < bottom) {
    // Text lines on the pages, only where there is room for them to read.
    const rows = [-0.1, 0.0, 0.1];
    for (const ry of rows) {
      if (ax > 0.08 && ax < 0.29 && Math.abs(y - (ry + sag)) < 0.022) return LINE;
    }
    return PAGE;
  }
  return BG;
}

function render(size) {
  const px = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let pxi = 0; pxi < size; pxi++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const c = sample((pxi + (sx + 0.5) / SS) / size, (py + (sy + 0.5) / SS) / size);
          if (c) { r += c[0]; g += c[1]; b += c[2]; a += 255; }
        }
      }
      const n = SS * SS;
      const i = (py * size + pxi) * 4;
      // Un-premultiply: colour is the average of the covered subsamples only.
      const covered = a / 255;
      px[i] = covered ? Math.round(r / covered) : 0;
      px[i + 1] = covered ? Math.round(g / covered) : 0;
      px[i + 2] = covered ? Math.round(b / covered) : 0;
      px[i + 3] = Math.round(a / n);
    }
  }
  return px;
}

// -------------------------------------------------------------------- png --

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(size, pixels) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // colour type: RGBA
  // 10,11,12 = compression, filter, interlace - all zero

  // Each scanline gets a leading filter byte; 0 means "no filtering".
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    pixels.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

mkdirSync(OUT, { recursive: true });
for (const size of SIZES) {
  const file = join(OUT, `icon${size}.png`);
  writeFileSync(file, png(size, render(size)));
  console.log('wrote', file);
}
