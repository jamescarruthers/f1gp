// p1-accuracy-map.cjs - side-by-side pictures for the check by eye: the
// game's screen next to a top-down map drawn only from the state read out of
// memory (frames.jsonl of a run).
//
//   node probes/p1-accuracy-map.cjs out/p1-accuracy/race1 [shot.png ...]
//
// For each screenshot in <run>/shots (or the ones named) it finds the frame
// recorded at the moment of the screenshot and writes <run>/map/<shot>.png,
// 1440 x 400:
//   left    the screenshot, 2x
//   middle  the view from above, turned so the camera looks up the picture
//           (so what is ahead on screen is above the camera, screen left is
//           map left); 160 m across. Track edges grey, pit lane blue-grey,
//           camera = cyan dot with its 60 deg view cone, cars as boxes
//           (4.5 x 2 m) along their heading: player red, viewed car yellow,
//           other cars white, retired grey.
//   right   the whole circuit, north up, same colours, the camera cyan.
// The game time (s) and the frame number are printed top left of the map.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const L = require('./p1-accuracy-lib.cjs');
const { encodePng } = require('../lib/node-emu.cjs');

const WPM = 16384 / 0.3048; // world units per metre
const C = { x: 0, y: 1, src: 2, speed: 3, idx: 4, lap: 7, inPit: 8, racePos: 9, retired: 10, heading: 13 };

function canvas(w, h, bg = [24, 28, 32]) {
  const d = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) { d[i * 4] = bg[0]; d[i * 4 + 1] = bg[1]; d[i * 4 + 2] = bg[2]; d[i * 4 + 3] = 255; }
  const set = (x, y, c) => { x |= 0; y |= 0; if (x < 0 || y < 0 || x >= w || y >= h) return; const o = (y * w + x) * 4; d[o] = c[0]; d[o + 1] = c[1]; d[o + 2] = c[2]; };
  const line = (x0, y0, x1, y1, c) => {
    const n = Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0))) || 1;
    if (n > 4000) return;
    for (let i = 0; i <= n; i++) set(x0 + ((x1 - x0) * i) / n, y0 + ((y1 - y0) * i) / n, c);
  };
  const disc = (cx, cy, r, c) => { for (let y = -r; y <= r; y++) for (let x = -r; x <= r; x++) if (x * x + y * y <= r * r) set(cx + x, cy + y, c); };
  const poly = (pts, c) => { // convex fill by scanline
    const ys = pts.map((p) => p[1]);
    for (let y = Math.floor(Math.min(...ys)); y <= Math.ceil(Math.max(...ys)); y++) {
      const xs = [];
      for (let i = 0; i < pts.length; i++) {
        const [ax, ay] = pts[i], [bx, by] = pts[(i + 1) % pts.length];
        if ((ay <= y && by > y) || (by <= y && ay > y)) xs.push(ax + ((y - ay) * (bx - ax)) / (by - ay));
      }
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) for (let x = Math.ceil(xs[k]); x <= xs[k + 1]; x++) set(x, y, c);
    }
  };
  const glyphs = Object.fromEntries(Object.entries(L.DIGITS).map(([g, d]) => [d, g]));
  const text = (x, y, s, c, k = 2) => { // digits, '.', '/', ' ' only, 6x6 font scaled k
    for (const ch of String(s)) {
      if (ch === '.') { for (let a = 0; a < k; a++) for (let b = 0; b < k; b++) set(x + 2 * k + a, y + 5 * k + b, c); }
      else if (ch === '/') { for (let i = 0; i < 6 * k; i++) set(x + 5 * k - (i * 5) / 6, y + i, c); }
      else if (glyphs[ch] !== undefined) for (let gy = 0; gy < 6; gy++) for (let gx = 0; gx < 6; gx++) if (glyphs[ch][gy * 6 + gx] === '#') for (let a = 0; a < k; a++) for (let b = 0; b < k; b++) set(x + gx * k + a, y + gy * k + b, c);
      x += 7 * k;
    }
  };
  return { w, h, d, set, line, disc, poly, text };
}

function blit(dst, src, ox, oy, scale) {
  for (let y = 0; y < src.height * scale; y++) for (let x = 0; x < src.width * scale; x++) {
    const s = ((Math.floor(y / scale) * src.width) + Math.floor(x / scale)) * 4, o = ((oy + y) * dst.w + ox + x) * 4;
    dst.d[o] = src.data[s]; dst.d[o + 1] = src.data[s + 1]; dst.d[o + 2] = src.data[s + 2];
  }
}

const COL = { player: [255, 60, 60], viewed: [255, 220, 0], car: [235, 235, 235], retired: [110, 110, 110], pit: [120, 170, 255], edge: [150, 150, 150], pitEdge: [90, 110, 150], cam: [0, 230, 230], cone: [0, 120, 120], text: [200, 200, 200], sf: [255, 255, 255] };

function drawMap(cv, ox, oy, size, track, f, player, mode) {
  // transform world -> panel pixels
  let tf;
  const cam = { x: f.cam[0], y: f.cam[1], h: f.cam[3] };
  if (mode === 'zoom') {
    const scale = size / (160 * WPM); // 160 m across
    const ch = (cam.h / 65536) * 2 * Math.PI, sn = Math.sin(ch), cs = Math.cos(ch);
    const cx = ox + size / 2, cy = oy + size * 0.72;
    tf = (x, y) => { const dx = x - cam.x, dy = y - cam.y; const fw = dx * sn + dy * cs, rt = dx * cs - dy * sn; return [cx + rt * scale, cy - fw * scale]; };
    tf.scale = scale; tf.rot = (h) => h - cam.h;
  } else {
    const pts = track.lap.filter(Boolean).map((e) => e.centre);
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    const scale = (size - 20) / Math.max(x1 - x0, y1 - y0);
    const mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
    tf = (x, y) => [ox + size / 2 + (x - mx) * scale, oy + size / 2 - (y - my) * scale];
    tf.scale = scale; tf.rot = (h) => h;
  }
  const clipLine = (a, b, c) => {
    const inside = (p) => p[0] >= ox && p[0] < ox + size && p[1] >= oy && p[1] < oy + size;
    if (inside(a) || inside(b)) {
      const n = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1])) || 1;
      if (n > 3000) return;
      for (let i = 0; i <= n; i++) { const x = a[0] + ((b[0] - a[0]) * i) / n, y = a[1] + ((b[1] - a[1]) * i) / n; if (x >= ox && x < ox + size && y >= oy && y < oy + size) cv.set(x, y, c); }
    }
  };
  const edges = (list, closed, col) => {
    for (const side of ['left', 'right']) {
      const pts = list.filter(Boolean).map((e) => tf(e[side][0], e[side][1]));
      for (let i = 0; i + 1 < pts.length; i++) clipLine(pts[i], pts[i + 1], col);
      if (closed && pts.length) clipLine(pts[pts.length - 1], pts[0], col);
    }
  };
  edges(track.lap, true, COL.edge);
  edges(track.pit, false, COL.pitEdge);
  if (track.lap[0]) clipLine(tf(...track.lap[0].left), tf(...track.lap[0].right), COL.sf);
  // camera and its view cone (60 deg)
  const cp = tf(cam.x, cam.y);
  if (mode === 'zoom') {
    for (const s of [-1, 1]) { const a = (s * 30 * Math.PI) / 180, r = size; clipLine(cp, [cp[0] + Math.sin(a) * r, cp[1] - Math.cos(a) * r], COL.cone); }
  }
  // cars
  for (let i = 0; i < f.cars.length; i++) {
    const c = f.cars[i];
    const col = c[C.retired] ? COL.retired : i === f.viewed ? COL.viewed : i === player ? COL.player : c[C.inPit] ? COL.pit : COL.car;
    const p = tf(c[C.x], c[C.y]);
    if (p[0] < ox || p[0] >= ox + size || p[1] < oy || p[1] >= oy + size) continue;
    if (mode === 'zoom' && c.length > C.heading) {
      const h = (tf.rot(c[C.heading]) / 65536) * 2 * Math.PI, fx = Math.sin(h), fy = -Math.cos(h);
      const len = 2.25 * WPM * tf.scale, wid = 1.0 * WPM * tf.scale;
      const pts = [[1, 1], [1, -1], [-1, -1], [-1, 1]].map(([a, b]) => [p[0] + fx * len * a - fy * wid * b, p[1] + fy * len * a + fx * wid * b]);
      cv.poly(pts, col);
      cv.disc(p[0] + fx * len, p[1] + fy * len, 1, [0, 0, 0]); // nose
    } else cv.disc(p[0], p[1], mode === 'zoom' ? 3 : 2, col);
  }
  cv.disc(cp[0], cp[1], 3, COL.cam);
}

function render(run, frame, img, outFile) {
  const cv = canvas(1440, 400);
  if (img) blit(cv, img, 0, 0, 2);
  drawMap(cv, 640, 0, 400, run.track, frame, run.player, 'zoom');
  drawMap(cv, 1040, 0, 400, run.track, frame, run.player, 'full');
  cv.line(1040, 0, 1040, 399, [60, 60, 60]); cv.line(640, 0, 640, 399, [60, 60, 60]);
  cv.text(648, 6, `${((frame.tick - run.greenTick) / 1000).toFixed(1)} ${frame.frame}`, COL.text, 2);
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, encodePng(cv.w, cv.h, cv.d, 4));
}

function main() {
  const [dir, ...names] = process.argv.slice(2);
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
  const track = JSON.parse(fs.readFileSync(path.join(dir, 'track.json'), 'utf8'));
  const frames = fs.readFileSync(path.join(dir, 'frames.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const dash = fs.readFileSync(path.join(dir, 'dash.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const shotTicks = fs.existsSync(path.join(dir, 'shots.jsonl')) ? Object.fromEntries(fs.readFileSync(path.join(dir, 'shots.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => { const s = JSON.parse(l); return [s.name, s.tick]; })) : {};
  const greenTick = meta.atGreen.tick;
  const run = { meta, track, frames, player: meta.atGreen.playerSlot, greenTick };
  const keys = fs.existsSync(path.join(dir, 'keys.jsonl')) ? fs.readFileSync(path.join(dir, 'keys.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  const list = names.length ? names : fs.readdirSync(path.join(dir, 'shots')).filter((n) => /\.png$/.test(n)).sort();
  // tick of a screenshot: shots.jsonl if present; else from its name (tNNN = the dash sample at NNN game s;
  // key-NNN-k = the first dash sample 1.5 s after that key tap)
  const tickOf = (name) => {
    if (shotTicks[name] !== undefined) return shotTicks[name];
    let m = /^(?:t|finish-)(\d+)\.png$/.exec(name);
    if (m) { const g = +m[1]; const d = dash.reduce((b, x) => (Math.abs(x.gt - g) < Math.abs(b.gt - g) ? x : b)); return d.tick; }
    m = /^key-(\d+)-/.exec(name);
    if (m) { const k = keys.find((x) => x.t === +m[1]); const d = k && dash.find((x) => x.tick >= k.tick + 1500); return d ? d.tick : null; }
    if (name === 'green.png') return greenTick;
    if (name === 'end.png') return frames[frames.length - 1].tick;
    return null;
  };
  let n = 0;
  for (const name of list) {
    const t = tickOf(name);
    if (t === null || t === undefined) continue;
    let fi = frames.findIndex((f) => f.tick > t) - 1;
    if (fi < 0) fi = fi === -2 ? frames.length - 1 : 0;
    const img = L.decodePng(path.join(dir, 'shots', name));
    render(run, frames[fi], img, path.join(dir, 'map', name));
    n++;
  }
  console.log(`${n} map pictures in ${path.join(dir, 'map')}`);
}
main();
