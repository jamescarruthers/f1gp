// p1-fields-map.cjs - draw a top-down map from a p1-fields recording, to
// check by eye that the positions make sense.
//
//   node probes/p1-fields-map.cjs drive1 [--at 20] [--zoom 0.25] [--center x19,y19]
//
// Writes out/p1-fields/<tag>/map[-zoom].png: track segment centre line (grey),
// pit-lane segments (blue), every computer car's trail computed from its
// track-relative fields (thin colours), the player's car+28/+2C trail (red),
// and dots for every car at sample --at seconds (white ring = player).
// X is drawn to the right and Y up (heading 0 = +Y, clockwise).
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const L = require('./p1-fields-lib.cjs');

const args = process.argv.slice(2);
const tag = args[0];
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const AT = +opt('at', 20);
const ZOOM = +opt('zoom', 1);
const dir = path.join(__dirname, '..', 'out', 'p1-fields', tag);
const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json')));
const ram = fs.readFileSync(path.join(dir, 'ram-start.bin'));
const m = L.ramReader(ram);
const cos = L.makeCos((i) => m.s16(meta.SS, 0x3264 + i * 2));
const S = L.openSamples(path.join(dir, 'samples.bin'));

// ---------------------------------------------------------------- png
function crc32(buf) { let c, crc = 0xffffffff; for (let n = 0; n < buf.length; n++) { c = (crc ^ buf[n]) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; } return (crc ^ 0xffffffff) >>> 0; }
function chunk(t, d) { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc32(td)); return Buffer.concat([l, td, c]); }
function png(w, h, rgb) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; rgb.copy(raw, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3); }
  const ih = Buffer.alloc(13); ih.writeUInt32BE(w, 0); ih.writeUInt32BE(h, 4); ih[8] = 8; ih[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ih), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// ---------------------------------------------------------------- geometry
const track = []; for (let j = 0; j <= meta.nSegs; j++) track.push(L.decodeSeg(m, meta.trackSeg, meta.trackBase + j * 0x2e));
const pit = []; // pit array: from pitBase until the track array or a zero entry
for (let j = 0; j < 600; j++) {
  const off = meta.pitBase + j * 0x2e; if (off > 0xffd0) break;
  const lin = (meta.pitSeg << 4) + off; if (lin >= (meta.trackSeg << 4) + meta.trackBase) break;
  const s = L.decodeSeg(m, meta.pitSeg, off); if (!s.posX && !s.posY && !s.angleZ) break; pit.push(s);
}
const xs = track.map((s) => s.x19), ys = track.map((s) => s.y19);
let minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
const H = 1400, pad = 30;
let scale = (H - 2 * pad) / (maxY - minY);
let W = Math.ceil((maxX - minX) * scale + 2 * pad);
let cx0 = minX, cy0 = minY;
const k0 = Math.min(S.length - 1, Math.max(0, Math.round(AT * 10)));
const carsAt = Array.from({ length: L.NCARS }, (_, i) => L.decodeCar(S[k0].ds, i));
const posOf = (c) => ((c.autoFlags & 1) ? { x19: c.X >> 8, y19: c.Y >> 8 } : L.trackToWorld(L.decodeSeg(m, c.segSeg, c.segOff), c, cos));
if (ZOOM !== 1) {
  const ctr = opt('center', null);
  const carSel = +opt('car', meta.player);
  const p = ctr ? ctr.split(',').map(Number) : (() => { const q = posOf(carsAt[carSel]); return [q.x19, q.y19]; })();
  scale = scale / ZOOM; W = H;
  cx0 = p[0] - (H / 2) / scale; cy0 = p[1] - (H / 2) / scale;
}
const img = Buffer.alloc(W * H * 3, 24);
const toPx = (x, y) => [Math.round((x - cx0) * scale + (ZOOM === 1 ? pad : 0)), Math.round(H - 1 - ((y - cy0) * scale + (ZOOM === 1 ? pad : 0)))];
function dot(px, py, r, col) { for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) { if (dx * dx + dy * dy > r * r) continue; const x = px + dx, y = py + dy; if (x < 0 || y < 0 || x >= W || y >= H) continue; const o = (y * W + x) * 3; img[o] = col[0]; img[o + 1] = col[1]; img[o + 2] = col[2]; } }
function line(a, b, r, col) { const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]))); for (let i = 0; i <= n; i++) dot(Math.round(a[0] + ((b[0] - a[0]) * i) / n), Math.round(a[1] + ((b[1] - a[1]) * i) / n), r, col); }
// track centre line (edges not drawn: the half-width encoding is not checked)
for (let j = 0; j < track.length - 1; j++) {
  const a = track[j], b = track[j + 1];
  line(toPx(a.x19, a.y19), toPx(b.x19, b.y19), ZOOM === 1 ? 2 : 1, [110, 110, 110]);
}
for (let j = 0; j < pit.length - 1; j++) line(toPx(pit[j].x19, pit[j].y19), toPx(pit[j + 1].x19, pit[j + 1].y19), 1, [60, 90, 200]);
// s/f line marker
dot(...toPx(track[0].x19, track[0].y19), 6, [255, 255, 255]);
const palette = (i) => [80 + ((i * 97) % 176), 80 + ((i * 53 + 90) % 176), 80 + ((i * 151 + 40) % 176)];
for (let i = 0; i < L.NCARS; i++) {
  let prev = null;
  for (let k = 0; k < S.length; k++) {
    const c = L.decodeCar(S[k].ds, i);
    const p = i === meta.player ? { x19: c.X >> 8, y19: c.Y >> 8 } : posOf(c);
    const q = toPx(p.x19, p.y19);
    if (prev && Math.hypot(q[0] - prev[0], q[1] - prev[1]) < 40) line(prev, q, 0, i === meta.player ? [255, 40, 40] : palette(i));
    prev = q;
  }
}
for (let i = 0; i < L.NCARS; i++) {
  const p = posOf(carsAt[i]); const q = toPx(p.x19, p.y19);
  if (i === meta.player) dot(q[0], q[1], ZOOM === 1 ? 8 : 10, [255, 255, 255]);
  dot(q[0], q[1], ZOOM === 1 ? 5 : 7, i === meta.player ? [255, 40, 40] : [255, 220, 0]);
}
const file = path.join(dir, ZOOM === 1 ? 'map.png' : `map-zoom-${AT}s${opt('car', null) !== null ? '-car' + opt('car') : ''}.png`);
fs.writeFileSync(file, png(W, H, img));
console.log(file, `${W}x${H}`, `scale ${(1 / scale).toFixed(1)} X19 units/px = ${((1 / scale) / 64 * 0.3048).toFixed(2)} m/px`, `sample ${k0}`, 'pit segments', pit.length);
