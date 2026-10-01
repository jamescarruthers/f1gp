// Draw the road edges from the game's segment array, projected with the
// game's camera and projection, over a frame captured by p2-proto.cjs.
//
//   node probes/p2-overlay.mjs out/p2-proto/chase
//
// Projection (memory-map.md): camera-relative in 1/8 ft,
//   depth = dx*sin(yaw) + dy*cos(yaw), lat = dx*cos(yaw) - dy*sin(yaw),
//   x = 160 + 256*lat/depth, y = horizon - ((dz*SS:017C*2) >> 16)*32/depth.

import fs from 'node:fs';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { encodePng } = require('../lib/node-emu.cjs');

const base = process.argv[2];
const { state, track } = JSON.parse(fs.readFileSync(`${base}.json`, 'utf8'));
const png = fs.readFileSync(`${base}.png`);

// decode our own PNGs (RGBA, filter 0 on every row)
function decodePng(buf) {
  const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
  const idat = [];
  for (let p = 8; p < buf.length;) {
    const len = buf.readUInt32BE(p), type = buf.toString('ascii', p + 4, p + 8);
    if (type === 'IDAT') idat.push(buf.subarray(p + 8, p + 8 + len));
    p += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) raw.copy(data, y * w * 4, y * (w * 4 + 1) + 1, (y + 1) * (w * 4 + 1));
  return { width: w, height: h, data };
}
const img = decodePng(png);

const cam = state.camera;
const yaw = (cam.heading / 65536) * 2 * Math.PI;
const sa = Math.sin(yaw), ca = Math.cos(yaw);
const K = (0x6e80 * 2) / 65536;
// The 3D viewport's top screen row: external views draw 164 rows from row 16.
const Y0 = state.view.mode === 'cockpit' ? 0 : 16;
function project([wx, wy], z) {
  const dx = (wx - cam.x) / 2048, dy = (wy - cam.y) / 2048; // world 1/16384 ft -> 1/8 ft
  const depth = dx * sa + dy * ca, lat = dx * ca - dy * sa;
  if (depth < 4) return null;
  const dz = z - cam.z;
  return [160 + (256 * lat) / depth, Y0 + cam.horizonRow - (dz * K * 32) / depth, depth];
}

function plot(x, y, rgb) {
  x = Math.round(x); y = Math.round(y);
  if (x < 0 || y < 0 || x >= img.width || y >= img.height) return;
  const o = (y * img.width + x) * 4;
  img.data[o] = rgb[0]; img.data[o + 1] = rgb[1]; img.data[o + 2] = rgb[2]; img.data[o + 3] = 255;
}
function line(a, b, rgb) {
  const n = Math.ceil(Math.max(Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]))) + 1;
  for (let i = 0; i <= n; i++) plot(a[0] + ((b[0] - a[0]) * i) / n, a[1] + ((b[1] - a[1]) * i) / n, rgb);
}

const lap = track.lap;
let drawn = 0;
for (let i = 0; i < lap.length; i++) {
  const s = lap[i], t = lap[(i + 1) % lap.length];
  for (const [side, rgb] of [['left', [255, 0, 255]], ['right', [0, 255, 255]]]) {
    const a = project(s[side], s.z), b = project(t[side], t.z);
    if (a && b && a[2] < 4000 && b[2] < 4000) { line(a, b, rgb); drawn++; }
  }
}
fs.writeFileSync(`${base}-overlay.png`, encodePng(img.width, img.height, img.data, 4));
console.log(JSON.stringify({ base, drawn, camera: cam }));
