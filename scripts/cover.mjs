// -----------------------------------------------------------------------------
// Generates cover.png (800×534, the store size): a sky-to-green gradient, a
// lawn, a garden tap with a round water timer and its hose, a sprinkler
// throwing arcs of water drops, and the gateway with its light. Plain Node
// (zlib), no dependency.
// Run: npm run cover
// -----------------------------------------------------------------------------

import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const WIDTH = 800;
const HEIGHT = 534;

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return c >>> 0;
});

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) {
    c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
const smooth = (edge, distance) => Math.min(1, Math.max(0, edge - distance + 0.5));

const SKY = [14, 40, 70];
const DUSK = [30, 110, 140];
const GRASS = [40, 130, 70];
const DEEP = [20, 80, 45];
const WATER = [150, 215, 255];
const WHITE = [255, 255, 255];
const GREY = [70, 80, 90];
const LED = [120, 230, 140];

/** Distance to the border of a rounded rectangle (negative inside). */
function roundedBox(x, y, cx, cy, halfW, halfH, radius) {
  const qx = Math.abs(x - cx) - halfW + radius;
  const qy = Math.abs(y - cy) - halfH + radius;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius;
}

const HEAD = [560, 410];
const TAP = [170, 210];

function pixel(x, y) {
  let color = mix(SKY, DUSK, y / 380);
  // The lawn, a gentle hill.
  const horizon = 380 - 30 * Math.sin((x / WIDTH) * Math.PI);
  if (y > horizon) {
    color = mix(GRASS, DEEP, Math.min(1, (y - horizon) / 160));
    if ((x * 7 + y * 13) % 23 === 0) {
      color = mix(color, DEEP, 0.6);
    }
  }
  // The arcs of water: parabolas from the sprinkler, drawn as drops.
  for (const [reach, height] of [
    [-200, 170],
    [-130, 210],
    [130, 210],
    [200, 170],
  ]) {
    const t = (x - HEAD[0]) / reach;
    if (t > 0.04 && t < 1) {
      const arcY = HEAD[1] - 4 * height * t * (1 - t);
      if (Math.floor(t * 18) % 2 === 0) {
        color = mix(color, WATER, smooth(3, Math.abs(y - arcY)) * 0.95);
      }
    }
  }
  // The hose, from the timer down to the sprinkler.
  const hoseY =
    300 +
    110 * Math.sin(Math.min(1, Math.max(0, (x - TAP[0]) / (HEAD[0] - TAP[0]))) * Math.PI * 0.5);
  if (x > TAP[0] && x < HEAD[0]) {
    color = mix(color, DEEP, smooth(5, Math.abs(y - hoseY)) * 0.9);
  }
  // The sprinkler head.
  color = mix(color, GREY, smooth(1, roundedBox(x, y, HEAD[0], HEAD[1] + 14, 14, 18, 5)));
  // The wall pipe and the tap.
  color = mix(color, GREY, smooth(1, roundedBox(x, y, TAP[0] - 90, TAP[1] - 40, 40, 12, 4)));
  color = mix(color, GREY, smooth(1, roundedBox(x, y, TAP[0] - 40, TAP[1] - 40, 22, 22, 6)));
  // The round water timer under the tap, its ring and its light.
  const d = Math.hypot(x - TAP[0], y - TAP[1]);
  color = mix(color, WHITE, smooth(1, d - 62) * 0.95);
  color = mix(color, SKY, smooth(1, Math.abs(d - 44) - 4) * 0.8);
  color = mix(color, LED, smooth(1, Math.hypot(x - TAP[0], y - TAP[1] + 20) - 7));
  // The outlet towards the hose.
  color = mix(color, GREY, smooth(1, roundedBox(x, y, TAP[0], TAP[1] + 78, 12, 18, 4)));
  // The gateway on the shelf, with its light.
  color = mix(color, WHITE, smooth(1, roundedBox(x, y, 660, 140, 60, 38, 12)) * 0.95);
  color = mix(color, LED, smooth(1, Math.hypot(x - 690, y - 140) - 6));
  return color;
}

const raw = Buffer.alloc((WIDTH * 3 + 1) * HEIGHT);
for (let y = 0; y < HEIGHT; y += 1) {
  const row = y * (WIDTH * 3 + 1);
  raw[row] = 0;
  for (let x = 0; x < WIDTH; x += 1) {
    const [r, g, b] = pixel(x, y);
    raw.set([r, g, b], row + 1 + x * 3);
  }
}

const header = Buffer.alloc(13);
header.writeUInt32BE(WIDTH, 0);
header.writeUInt32BE(HEIGHT, 4);
header[8] = 8; // bit depth
header[9] = 2; // RGB
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', header),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
writeFileSync(new URL('../cover.png', import.meta.url), png);
console.log(`cover.png: ${WIDTH}×${HEIGHT}, ${png.length} bytes`);
