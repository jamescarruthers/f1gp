// p2-capture-lib.cjs - helpers for the Phase 2 reference frames
// (probes/p2-capture.cjs, probes/p2-capture-check.cjs):
//   - PNG decode (our own encoder's output and general 8-bit RGB/RGBA PNGs)
//   - the game's projection (maths copied from probes/p2-overlay.mjs, with
//     near-plane clipping added and SS:017C read from the frame's JSON)
//   - a rasteriser for the road surface (lap and pit-lane quads)
//   - the road-edge measurement: projected road edges vs the game's road
//     boundary found by colour along screen rows
//   - small statistics
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

// ---------------------------------------------------------------- projection
// From probes/p2-overlay.mjs (docs/memory-map.md, image 0F47:20D9):
// camera-relative in 1/8 ft, depth = dx*sin(yaw) + dy*cos(yaw),
// lat = dx*cos(yaw) - dy*sin(yaw), x = 160 + 256*lat/depth,
// y = Y0 + horizon - ((dz*SS:017C*2) >> 16)*32/depth. Y0 = the viewport's top
// screen row: 16 in the external views, 0 in the cockpit view.
const NEAR = 8; // 1 ft, in 1/8 ft
function camera(cam, viewMode, k017c = 0x6e80) {
  const yaw = (cam.heading / 65536) * 2 * Math.PI;
  const sa = Math.sin(yaw), ca = Math.cos(yaw);
  const K = (k017c * 2) / 65536;
  const Y0 = viewMode === 'cockpit' ? 0 : 16;
  // world point -> camera space [lat, depth, dz]
  const toCam = ([wx, wy], z) => {
    const dx = (wx - cam.x) / 2048, dy = (wy - cam.y) / 2048;
    return [dx * ca - dy * sa, dx * sa + dy * ca, z - cam.z];
  };
  const toScreen = ([lat, depth, dz]) => [160 + (256 * lat) / depth, Y0 + cam.horizonRow - (dz * K * 32) / depth, depth];
  const project = (pt, z) => { const c = toCam(pt, z); return c[1] < 4 ? null : toScreen(c); };
  return { toCam, toScreen, project, Y0, K, horizonY: Y0 + cam.horizonRow };
}

// Clip a camera-space polygon to depth >= NEAR (Sutherland-Hodgman, one plane).
function clipNear(poly) {
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const ia = a[1] >= NEAR, ib = b[1] >= NEAR;
    if (ia) out.push(a);
    if (ia !== ib) {
      const t = (NEAR - a[1]) / (b[1] - a[1]);
      out.push([a[0] + (b[0] - a[0]) * t, NEAR, a[2] + (b[2] - a[2]) * t]);
    }
  }
  return out;
}

// Road quads of the lap (and the pit lane) as camera-space polygons.
// Each quad: segment i to i+1, corners left_i, right_i, right_i+1, left_i+1.
function roadQuads(track, cam3, { maxDepth = 4000, pit = true } = {}) {
  const quads = [];
  const add = (s, t, kind, index) => {
    if (!s || !t) return;
    const poly = [cam3.toCam(s.left, s.z), cam3.toCam(s.right, s.z), cam3.toCam(t.right, t.z), cam3.toCam(t.left, t.z)];
    let minD = Infinity, maxD = -Infinity;
    for (const v of poly) { minD = Math.min(minD, v[1]); maxD = Math.max(maxD, v[1]); }
    if (maxD < NEAR || minD > maxDepth) return;
    const c = clipNear(poly);
    if (c.length < 3) return;
    quads.push({ kind, index, poly: c.map((v) => cam3.toScreen(v)), depth: (minD + maxD) / 2, minD, maxD });
  };
  const lap = track.lap, n = lap.length;
  for (let i = 0; i < n; i++) add(lap[i], lap[(i + 1) % n], 1, i);
  if (pit && track.pit) for (let i = 0; i + 1 < track.pit.length; i++) add(track.pit[i], track.pit[i + 1], 2, track.pit[i].index);
  return quads;
}

// Fill a polygon (screen coords) into a label image with pixel-centre sampling.
function fillPoly(poly, W, H, cb) {
  let y0 = Infinity, y1 = -Infinity;
  for (const p of poly) { y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]); }
  const ya = Math.max(0, Math.ceil(y0 - 0.5)), yb = Math.min(H - 1, Math.floor(y1 - 0.5));
  for (let y = ya; y <= yb; y++) {
    const yc = y + 0.5, xs = [];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      if ((a[1] <= yc && b[1] > yc) || (b[1] <= yc && a[1] > yc)) xs.push(a[0] + ((yc - a[1]) * (b[0] - a[0])) / (b[1] - a[1]));
    }
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const xa = Math.max(0, Math.ceil(xs[k] - 0.5)), xb = Math.min(W - 1, Math.floor(xs[k + 1] - 0.5));
      for (let x = xa; x <= xb; x++) cb(x, y);
    }
  }
}

// Predicted road mask (0 none, 1 lap, 2 pit) inside the viewport rows
// [vy0, vy1), painter's order (far quads first).
function roadMask(quads, { W = 320, H = 200, vy0 = 0, vy1 = 200 } = {}) {
  const mask = new Uint8Array(W * H), depth = new Float32Array(W * H).fill(Infinity), seg = new Int32Array(W * H).fill(-1);
  const sorted = quads.slice().sort((a, b) => b.depth - a.depth);
  for (const q of sorted) {
    fillPoly(q.poly, W, H, (x, y) => {
      if (y < vy0 || y >= vy1) return;
      const o = y * W + x;
      mask[o] = q.kind; depth[o] = q.depth; seg[o] = q.index;
    });
  }
  return { mask, depth, seg, W, H };
}

// Analytic edge crossings of one screen row: x where the projected left/right
// edge polylines cross row y (sub-pixel), with the depth there.
function edgeCrossings(track, cam3, y, { maxDepth = 4000, pit = false } = {}) {
  const out = [];
  const lines = (arr, closed, kind) => {
    const n = arr.length;
    for (const side of ['left', 'right']) {
      for (let i = 0; i < (closed ? n : n - 1); i++) {
        const s = arr[i], t = arr[(i + 1) % n];
        if (!s || !t) continue;
        let a = cam3.toCam(s[side], s.z), b = cam3.toCam(t[side], t.z);
        if (a[1] < NEAR && b[1] < NEAR) continue;
        if (a[1] > maxDepth && b[1] > maxDepth) continue;
        if (a[1] < NEAR) { const k = (NEAR - a[1]) / (b[1] - a[1]); a = [a[0] + (b[0] - a[0]) * k, NEAR, a[2] + (b[2] - a[2]) * k]; }
        if (b[1] < NEAR) { const k = (NEAR - b[1]) / (a[1] - b[1]); b = [b[0] + (a[0] - b[0]) * k, NEAR, b[2] + (a[2] - b[2]) * k]; }
        const A = cam3.toScreen(a), B = cam3.toScreen(b);
        const yc = y + 0.5;
        if ((A[1] <= yc && B[1] > yc) || (B[1] <= yc && A[1] > yc)) {
          const t2 = (yc - A[1]) / (B[1] - A[1]);
          out.push({ x: A[0] + (B[0] - A[0]) * t2, depth: A[2] + (B[2] - A[2]) * t2, side, kind, index: s.index });
        }
      }
    }
  };
  lines(track.lap, true, 1);
  if (pit && track.pit) lines(track.pit, false, 2);
  return out;
}

// ---------------------------------------------------------------- colours
const key = (r, g, b) => (r << 16) | (g << 8) | b;
const hex = (k) => `#${k.toString(16).padStart(6, '0')}`;
const rgbOf = (k) => [(k >> 16) & 255, (k >> 8) & 255, k & 255];

// Histogram of colours over pixels where pred(x, y) holds.
function histogram(img, pred) {
  const h = new Map();
  for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) {
    if (!pred(x, y)) continue;
    const o = (y * img.width + x) * 4, k = key(img.data[o], img.data[o + 1], img.data[o + 2]);
    h.set(k, (h.get(k) || 0) + 1);
  }
  return h;
}

// Erode a 0/1 predicate image by r pixels (square), within W x H.
function erode(bin, W, H, r) {
  const out = new Uint8Array(W * H);
  for (let y = r; y < H - r; y++) for (let x = r; x < W - r; x++) {
    let ok = 1;
    for (let dy = -r; dy <= r && ok; dy++) for (let dx = -r; dx <= r; dx++) if (!bin[(y + dy) * W + x + dx]) { ok = 0; break; }
    out[y * W + x] = ok;
  }
  return out;
}

// ---------------------------------------------------------------- edge check
// The game's road boundary vs the projected edges, along screen rows.
//   img: decoded screenshot; state: readState output; track: readTrack output.
// Steps: rasterise the road (lap + pit, depth < maxDepth) into a mask; learn
// the frame's road colours (common inside the eroded mask, rare in the eroded
// outside below the horizon); then on sample rows take every analytic edge
// crossing of the lap whose pixel is not hidden by nearer road, and look for
// the nearest road/not-road colour transition of the same orientation within
// +-win px. Error = found - predicted (px, + = to the right).
function edgeCheck(img, state, track, { k017c = 0x6e80, maxDepth = 4000, win = 12, rowStep = 3, minBelowHorizon = 3, vyEnd = null } = {}) {
  const W = img.width, H = img.height;
  const view = state.view.mode;
  const cam3 = camera(state.camera, view, k017c);
  const vy0 = cam3.Y0;
  const vy1 = vyEnd !== null ? vyEnd : view === 'cockpit' ? 103 : 180;
  const quads = roadQuads(track, cam3, { maxDepth, pit: true });
  const rm = roadMask(quads, { W, H, vy0, vy1 });
  const hy = Math.ceil(cam3.horizonY);
  const below = (y) => y >= Math.max(vy0, hy + 1) && y < vy1;
  // road colours
  const inBin = new Uint8Array(W * H), outBin = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const o = y * W + x;
    if (!below(y)) continue;
    if (rm.mask[o]) inBin[o] = 1; else outBin[o] = 1;
  }
  const inE = erode(inBin, W, H, 2), outE = erode(outBin, W, H, 2);
  const hIn = histogram(img, (x, y) => inE[y * W + x]), hOut = histogram(img, (x, y) => outE[y * W + x]);
  let nIn = 0, nOut = 0;
  for (const v of hIn.values()) nIn += v;
  for (const v of hOut.values()) nOut += v;
  const roadSet = new Set();
  for (const [k, v] of hIn) {
    const fi = v / Math.max(1, nIn), fo = (hOut.get(k) || 0) / Math.max(1, nOut);
    if (fi >= 0.01 && fi > 3 * fo) roadSet.add(k);
  }
  const isRoad = (x, y) => {
    if (x < 0 || x >= W) return false;
    const o = (y * W + x) * 4;
    return roadSet.has(key(img.data[o], img.data[o + 1], img.data[o + 2]));
  };
  // sample rows
  const rows = [];
  for (let y = Math.max(vy0, hy + minBelowHorizon); y < vy1; y += rowStep) rows.push(y);
  const meas = [];
  for (const y of rows) {
    const xs = edgeCrossings(track, cam3, y, { maxDepth, pit: false });
    for (const c of xs) {
      if (c.x < 2 || c.x > W - 3) continue;
      const px = Math.round(c.x - 0.5);
      const o = y * W + Math.min(W - 1, Math.max(0, px));
      // hidden by nearer road (another part of the lap in front)?
      if (rm.depth[o] < c.depth * 0.9) continue;
      // orientation: where is the road? Look at the predicted mask 3 px either side
      const l = rm.mask[y * W + Math.max(0, px - 3)] ? 1 : 0, r = rm.mask[y * W + Math.min(W - 1, px + 3)] ? 1 : 0;
      if (l === r) continue; // a corner of the mask or road on both sides: skip
      const roadLeft = l === 1;
      // nearest transition in the image: boundary b between pixel b-1 and b
      let best = null;
      for (let d = 0; d <= win; d++) {
        for (const b of d === 0 ? [Math.round(c.x)] : [Math.round(c.x) + d, Math.round(c.x) - d]) {
          if (b < 2 || b > W - 2) continue;
          const A = roadLeft ? isRoad(b - 1, y) && isRoad(b - 2, y) : !isRoad(b - 1, y) && !isRoad(b - 2, y);
          const B = roadLeft ? !isRoad(b, y) && !isRoad(b + 1, y) : isRoad(b, y) && isRoad(b + 1, y);
          if (A && B) { best = b; break; }
        }
        if (best !== null) break;
      }
      meas.push({ y, side: c.side, predicted: +c.x.toFixed(2), depth: Math.round(c.depth), index: c.index, roadLeft,
        found: best, err: best === null ? null : +(best - c.x).toFixed(2) });
    }
  }
  const errs = meas.filter((m) => m.err !== null).map((m) => Math.abs(m.err));
  return {
    rows, measurements: meas, roadColours: [...roadSet].map(hex),
    medianAbsErr: errs.length ? median(errs) : null,
    p90AbsErr: errs.length ? quantile(errs, 0.9) : null,
    found: errs.length, total: meas.length,
    within2: errs.filter((e) => e <= 2).length,
    mask: rm, cam3, quads: quads.length, horizonY: cam3.horizonY, viewport: [vy0, vy1],
  };
}

// Draw the projected edges (lap magenta/cyan, pit yellow) over a copy of img.
function overlay(img, state, track, { k017c = 0x6e80, maxDepth = 4000, check = null } = {}) {
  const out = { width: img.width, height: img.height, data: Uint8Array.from(img.data) };
  const cam3 = camera(state.camera, state.view.mode, k017c);
  const plot = (x, y, rgb) => {
    x = Math.round(x); y = Math.round(y);
    if (x < 0 || y < 0 || x >= out.width || y >= out.height) return;
    const o = (y * out.width + x) * 4;
    out.data[o] = rgb[0]; out.data[o + 1] = rgb[1]; out.data[o + 2] = rgb[2]; out.data[o + 3] = 255;
  };
  const line = (a, b, rgb) => {
    const n = Math.ceil(Math.max(Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]))) + 1;
    if (n > 2000) return;
    for (let i = 0; i <= n; i++) plot(a[0] + ((b[0] - a[0]) * i) / n, a[1] + ((b[1] - a[1]) * i) / n, rgb);
  };
  const seg = (s, t, side, rgb) => {
    let a = cam3.toCam(s[side], s.z), b = cam3.toCam(t[side], t.z);
    if ((a[1] < NEAR && b[1] < NEAR) || (a[1] > maxDepth && b[1] > maxDepth)) return;
    if (a[1] < NEAR) { const k = (NEAR - a[1]) / (b[1] - a[1]); a = [a[0] + (b[0] - a[0]) * k, NEAR, a[2] + (b[2] - a[2]) * k]; }
    if (b[1] < NEAR) { const k = (NEAR - b[1]) / (a[1] - b[1]); b = [b[0] + (a[0] - b[0]) * k, NEAR, b[2] + (a[2] - b[2]) * k]; }
    line(cam3.toScreen(a), cam3.toScreen(b), rgb);
  };
  const lap = track.lap, n = lap.length;
  for (let i = 0; i < n; i++) {
    const s = lap[i], t = lap[(i + 1) % n];
    if (!s || !t) continue;
    seg(s, t, 'left', [255, 0, 255]); seg(s, t, 'right', [0, 255, 255]);
  }
  if (track.pit) for (let i = 0; i + 1 < track.pit.length; i++) { seg(track.pit[i], track.pit[i + 1], 'left', [255, 255, 0]); seg(track.pit[i], track.pit[i + 1], 'right', [255, 160, 0]); }
  // found boundaries as small green ticks
  if (check) for (const m of check.measurements) if (m.found !== null) { plot(m.found, m.y - 1, [0, 255, 0]); plot(m.found, m.y + 1, [0, 255, 0]); }
  return out;
}

// ---------------------------------------------------------------- stats
function quantile(arr, q) {
  if (!arr.length) return null;
  const a = Float64Array.from(arr).sort();
  const pos = q * (a.length - 1), lo = Math.floor(pos), hi = Math.ceil(pos);
  return +(a[lo] + (a[hi] - a[lo]) * (pos - lo)).toFixed(3);
}
const median = (arr) => quantile(arr, 0.5);

module.exports = {
  decodePng, camera, clipNear, roadQuads, fillPoly, roadMask, edgeCrossings, edgeCheck, overlay,
  histogram, erode, key, hex, rgbOf, quantile, median, NEAR,
};
