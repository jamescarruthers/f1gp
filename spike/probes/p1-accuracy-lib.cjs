// p1-accuracy-lib.cjs - shared helpers for the Phase 1 accuracy test:
// a PNG decoder (for offline checks of saved screenshots), the dash LCD
// reader, key codes, a time warp for the emulator, and small statistics.
//
// The dash reader is my own: it checks which labels the LCD shows (by their
// colour masks) before it reads the digit cells; only the 6x6 digit font
// table is copied from lib/route.cjs (DIGITS), which does not export it.
'use strict';
const zlib = require('node:zlib');
const fs = require('node:fs');

// ---------------------------------------------------------------- PNG
function decodePng(buf) {
  if (typeof buf === 'string') buf = fs.readFileSync(buf);
  let p = 8, w = 0, h = 0, ct = 0, depth = 0;
  const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p), type = buf.toString('latin1', p + 4, p + 8), d = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); depth = d[8]; ct = d[9]; if (d[12]) throw new Error('interlaced PNG'); }
    else if (type === 'IDAT') idat.push(d);
    else if (type === 'IEND') break;
    p += 12 + len;
  }
  if (depth !== 8 || (ct !== 6 && ct !== 2)) throw new Error(`unsupported PNG ${depth}/${ct}`);
  const ch = ct === 6 ? 4 : 3, stride = w * ch;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const out = new Uint8Array(w * h * 4);
  const prev = new Uint8Array(stride), cur = new Uint8Array(stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? cur[x - ch] : 0, b = prev[x], c = x >= ch ? prev[x - ch] : 0;
      let v = row[x];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      cur[x] = v & 255;
    }
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      out[o] = cur[x * ch]; out[o + 1] = cur[x * ch + 1]; out[o + 2] = cur[x * ch + 2]; out[o + 3] = ch === 4 ? cur[x * ch + 3] : 255;
    }
    prev.set(cur);
  }
  return { width: w, height: h, data: out };
}

// ---------------------------------------------------------------- dash LCD
// RGB at logical (x, y) in 320x200 space (same sampling as route.cjs px()).
function px(img, x, y) {
  const sx = img.width === 320 ? x : Math.floor((x * img.width) / 320);
  const sy = img.height === 200 ? y : Math.floor((y * img.height) / 200);
  const o = (sy * img.width + sx) * 4;
  return [img.data[o], img.data[o + 1], img.data[o + 2]];
}
const dark = (img, x, y) => { const [r, g, b] = px(img, x, y); return r + g + b < 60; };

// 6x6 digit font of the dash LCD (copy of lib/route.cjs DIGITS).
const DIGITS = {
  '.####.#....##....##....##....#.####.': 0, '..#....##.....#.....#.....#....###..': 1,
  '.####.#....#...##..##...#.....######': 2, '######....#....##......##....#.####.': 3,
  '....#....##...#.#..#..#.######....#.': 4, '#######.....#####......#.....######.': 5,
  '.####.#.....#####.#....##....#.####.': 6, '######....#....#....#....#.....#....': 7,
  '.####.#....#.####.#....##....#.####.': 8, '.####.#....#.####.....#....#....#...': 9,
};
function glyphAt(img, x0, y0) {
  let g = '';
  for (let y = y0; y < y0 + 6; y++) for (let x = x0; x < x0 + 6; x++) g += dark(img, x, y) ? '#' : '.';
  return g;
}

// The LCD (x 88-232) has two text rows. Labels are drawn in olive
// (93,93,16), 5 px high (rows 185 and 194); values in black, 6x6 digits
// (rows 184 and 193), in fixed right-aligned cells. Which layout is shown is
// told by the labels: row 1 is "MPH nnn LAP n OF m" or "MPH nnn LAPTIME
// m:ss.mmm"; row 2 is "CAR n POS n RUNNERS n" or "CAR n POS n BEST m:ss.mmm".
// Label masks below were taken from out/p1-state/drive/shots/t030.png and
// t120.png (box x0, x1, top row; '#' = label colour).
const LABELS = {
  MPH: [90, 108, 185, '..#...#.###..#..#...##.##.#..#.#..#...#.#.#.###..####...#...#.#....#..#...#...#.#....#..#.'],
  LAP: [164, 181, 185, '..#....##..###.....#...#..#.#..#....#...####.###.....#...#..#.#.......###.#..#.#.....'],
  OF: [202, 215, 185, '..##..####....#..#.#.......#..#.###.....#..#.#........##..#......'],
  LAPTIME: [141, 181, 185, '..#.....##..###..#####.#.#...#.####.......#....#..#.#..#...#...#.##.##.#..........#....####.###....#...#.#.#.#.###........#....#..#.#......#...#.#...#.#..........####.#..#.#......#...#.#...#.####.....'],
  CAR: [90, 107, 194, '...###..##..###....#....#..#.#..#...#....####.###....#....#..#.#.#.....###.#..#.#..#.'],
  POS: [122, 141, 194, '...###...##...###.....#..#.#..#.#........###..#..#...#...........#..#....#.....#.....##..###...'],
  RUNNERS: [164, 204, 194, '..###..#..#.#...#.#...#.####.###...###....#..#.#..#.##..#.##..#.#....#..#.#.......###..#..#.#.#.#.#.#.#.###..###...##.....#.#..#..#.#..##.#..##.#....#.#.....#....#..#..##..#...#.#...#.####.#..#.###...'],
  BEST: [154, 175, 194, '..###..####..###.####..#..#.#....#......#...###..###...##....#...#..#.#.......#...#...###..####.###....#.'],
};
const isLabelPx = ([r, g, b]) => r > 70 && r < 125 && g > 70 && g < 125 && b < 45;
// true when the label's pixels match the reference (>= 95% of the box, and
// at least 85% of the reference ink present)
function hasLabel(img, name) {
  const [x0, x1, y0, ref] = LABELS[name];
  let same = 0, ink = 0, hit = 0, i = 0;
  for (let y = y0; y < y0 + 5; y++) for (let x = x0; x < x1; x++, i++) {
    const on = isLabelPx(px(img, x, y)), want = ref[i] === '#';
    if (on === want) same++;
    if (want) { ink++; if (on) hit++; }
  }
  return same / ref.length >= 0.95 && hit / ink >= 0.85;
}
const BLANK = '.'.repeat(36);
// right-aligned number in cells xs (leading blank cells allowed), or null
function numAt(img, xs, y) {
  let v = '', started = false;
  for (let i = 0; i < xs.length; i++) {
    const g = glyphAt(img, xs[i], y), d = DIGITS[g];
    if (d === undefined) { if (!started && g === BLANK && i < xs.length - 1) continue; return null; }
    started = true; v += d;
  }
  return started ? Number(v) : null;
}
// "m:ss.mmm": minute cell 178, seconds 189/196, ms 207/214/221
function timeAt(img, y) {
  const d = [178, 189, 196, 207, 214, 221].map((x) => DIGITS[glyphAt(img, x, y)]);
  if (d.some((v) => v === undefined)) return null;
  return d[0] * 60000 + (d[1] * 10 + d[2]) * 1000 + d[3] * 100 + d[4] * 10 + d[5];
}

// Read the dash. Every field is null unless its label is on screen and the
// digits read cleanly: { mph, lap, laps, lapTime (ms), car, pos, runners,
// best (ms), layout: [row1, row2] } with row1 'lap' | 'laptime' | null and
// row2 'runners' | 'best' | null.
function readDash(img) {
  const d = { mph: null, lap: null, laps: null, lapTime: null, car: null, pos: null, runners: null, best: null, layout: [null, null] };
  if (hasLabel(img, 'MPH')) d.mph = numAt(img, [111, 118, 125], 184);
  if (hasLabel(img, 'LAP') && hasLabel(img, 'OF')) { d.layout[0] = 'lap'; d.lap = numAt(img, [181, 188], 184); d.laps = numAt(img, [214, 221], 184); }
  else if (hasLabel(img, 'LAPTIME')) { d.layout[0] = 'laptime'; d.lapTime = timeAt(img, 184); }
  if (hasLabel(img, 'CAR')) d.car = numAt(img, [108, 115], 193);
  if (hasLabel(img, 'POS')) d.pos = numAt(img, [140, 147], 193);
  if (hasLabel(img, 'RUNNERS')) { d.layout[1] = 'runners'; d.runners = numAt(img, [214, 221], 193); }
  else if (hasLabel(img, 'BEST')) { d.layout[1] = 'best'; d.best = timeAt(img, 193); }
  return d;
}

// ---------------------------------------------------------------- keys and warp
// GLFW key codes (route.cjs JSDOS_KEYS plus the navigation keys it lacks).
const EXTRA_KEYS = { home: 268, end: 269, pageup: 266, pagedown: 267, delete: 261, insert: 260 };

// Scale the clock DOSBox paces itself by (wdosbox.js: _emscripten_get_now =
// () => performance.now()). Returns the real clock.
function installWarp(warp) {
  const realNow = performance.now.bind(performance);
  if (warp && warp !== 1) {
    const base = realNow();
    performance.now = () => base + (realNow() - base) * warp;
  }
  return realNow;
}

// ---------------------------------------------------------------- stats
function quantiles(arr, qs = [0, 0.5, 0.9, 0.99, 1]) {
  if (!arr.length) return null;
  const a = Float64Array.from(arr).sort();
  const out = {};
  for (const q of qs) out[q === 0 ? 'min' : q === 1 ? 'max' : `p${Math.round(q * 100)}`] = +a[Math.min(a.length - 1, Math.floor(q * (a.length - 1) + 0.5))].toFixed(4);
  out.n = a.length;
  return out;
}
function hist(arr) { const h = {}; for (const v of arr) h[v] = (h[v] || 0) + 1; return h; }

module.exports = { decodePng, px, glyphAt, readDash, hasLabel, LABELS, DIGITS, EXTRA_KEYS, installWarp, quantiles, hist };
