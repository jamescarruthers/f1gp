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
// The game's road boundary vs the projected road edges.
//   img: decoded screenshot; state (or { camera, view: { mode } }); track: readTrack output.
//   opts.ignore: Uint8Array(W*H), 1 = pixel not part of the 3D view (cockpit,
//   own car in chase view, banner); samples whose search touches it are skipped.
// 1. Rasterise the road (lap + pit lane, depth < maxDepth) into a mask.
// 2. Learn the frame's colours: R (road surface) = common in the mask's
//    interior (eroded 2 px) and rare in a band 3-12 px outside it; G (verge)
//    = common in that band and rare inside. Anything else (white lines,
//    kerbs, cars) is "other".
// 3. Sample the projected left/right edges of the lap: steep edge pieces
//    where they cross every rowStep-th row (search along the row), flat
//    pieces where they cross every colStep-th column (search along the
//    column). Skip samples hidden by nearer road.
// 4. Along the search line find, nearest to the projected edge within
//    +-win px: the inner boundary (2 R pixels on the road side, then 2 non-R)
//    and the outer boundary (2 non-G on the road side, then 2 G).
// 5. Error of a sample = 0 when the projected edge lies between the two
//    boundaries (in the painted line or kerb band), else the distance to the
//    nearer one; converted to the distance perpendicular to the edge.
function edgeCheck(img, state, track, { k017c = 0x6e80, maxDepth = 4000, win = 10, rowStep = 3, colStep = 4, minBelowHorizon = 2, ignore = null } = {}) {
  const W = img.width, H = img.height;
  const view = state.view.mode;
  const cam3 = camera(state.camera, view, k017c);
  const vy0 = cam3.Y0, vy1 = view === 'cockpit' ? 103 : 180;
  const quads = roadQuads(track, cam3, { maxDepth, pit: true });
  const rm = roadMask(quads, { W, H, vy0, vy1 });
  const yTop = Math.max(vy0, Math.ceil(cam3.horizonY) + minBelowHorizon);
  const inView = (x, y) => x >= 0 && x < W && y >= yTop && y < vy1 && !(ignore && ignore[y * W + x]);
  const inBin = new Uint8Array(W * H), outBin = new Uint8Array(W * H);
  for (let y = yTop; y < vy1; y++) for (let x = 0; x < W; x++) {
    const o = y * W + x;
    if (ignore && ignore[o]) continue;
    if (rm.mask[o]) inBin[o] = 1; else outBin[o] = 1;
  }
  const inE = erode(inBin, W, H, 2);
  // band 3-12 px outside the mask
  const near12 = dilate(rm.mask, W, H, 12), near3 = dilate(rm.mask, W, H, 3);
  const hIn = histogram(img, (x, y) => inE[y * W + x]);
  const hBand = histogram(img, (x, y) => outBin[y * W + x] && near12[y * W + x] && !near3[y * W + x]);
  let nIn = 0, nBand = 0;
  for (const v of hIn.values()) nIn += v;
  for (const v of hBand.values()) nBand += v;
  const R = new Set(), G = new Set();
  const keys = new Set([...hIn.keys(), ...hBand.keys()]);
  for (const k of keys) {
    const fi = (hIn.get(k) || 0) / Math.max(1, nIn), fb = (hBand.get(k) || 0) / Math.max(1, nBand);
    if (fi >= 0.02 && fi > 3 * fb) R.add(k);
    if (fb >= 0.02 && fb > 3 * fi) G.add(k);
  }
  const colourAt = (x, y) => { const o = (y * W + x) * 4; return key(img.data[o], img.data[o + 1], img.data[o + 2]); };
  // samples
  const samples = [];
  const lap = track.lap, n = lap.length;
  for (let i = 0; i < n; i++) {
    const s = lap[i], t = lap[(i + 1) % n];
    if (!s || !t) continue;
    for (const side of ['left', 'right']) {
      let a = cam3.toCam(s[side], s.z), b = cam3.toCam(t[side], t.z);
      if ((a[1] < NEAR && b[1] < NEAR) || (a[1] > maxDepth && b[1] > maxDepth)) continue;
      if (a[1] < NEAR) { const k = (NEAR - a[1]) / (b[1] - a[1]); a = [a[0] + (b[0] - a[0]) * k, NEAR, a[2] + (b[2] - a[2]) * k]; }
      if (b[1] < NEAR) { const k = (NEAR - b[1]) / (a[1] - b[1]); b = [b[0] + (a[0] - b[0]) * k, NEAR, b[2] + (a[2] - b[2]) * k]; }
      const A = cam3.toScreen(a), B = cam3.toScreen(b);
      const dx = B[0] - A[0], dy = B[1] - A[1], len = Math.hypot(dx, dy);
      if (len < 0.5) continue;
      const steep = Math.abs(dy) >= Math.abs(dx);
      if (steep) {
        const ya = Math.min(A[1], B[1]), yb = Math.max(A[1], B[1]);
        for (let y = Math.ceil((ya - 0.5) / rowStep) * rowStep; y + 0.5 <= yb; y += rowStep) {
          if (y + 0.5 < ya) continue;
          const tt = (y + 0.5 - A[1]) / dy;
          samples.push({ axis: 'x', q: y, p: A[0] + dx * tt, depth: A[2] + (B[2] - A[2]) * tt, f: Math.abs(dy) / len, side, index: s.index });
        }
      } else {
        const xa = Math.min(A[0], B[0]), xb = Math.max(A[0], B[0]);
        for (let x = Math.ceil((xa - 0.5) / colStep) * colStep; x + 0.5 <= xb; x += colStep) {
          if (x + 0.5 < xa) continue;
          const tt = (x + 0.5 - A[0]) / dx;
          samples.push({ axis: 'y', q: x, p: A[1] + dy * tt, depth: A[2] + (B[2] - A[2]) * tt, f: Math.abs(dx) / len, side, index: s.index });
        }
      }
    }
  }
  const meas = [];
  for (const sm of samples) {
    const isX = sm.axis === 'x';
    const at = (t) => (isX ? [t, sm.q] : [sm.q, t]);
    const pr = Math.round(sm.p - 0.5); // pixel containing the edge point
    const [px0, py0] = at(Math.max(0, pr));
    if (!inView(Math.min(W - 1, px0), Math.min(H - 1, py0))) continue;
    const o = py0 * W + px0;
    if (rm.depth[o] < sm.depth * 0.9) continue; // hidden by nearer road
    const lo = at(pr - 3), hi = at(pr + 3);
    const roadLo = rm.mask[lo[1] * W + lo[0]] ? 1 : 0, roadHi = rm.mask[hi[1] * W + hi[0]] ? 1 : 0;
    if (roadLo === roadHi) continue;
    const roadBefore = roadLo === 1; // road at the lower coordinate
    // class of the pixel at axis position t: 'R', 'G', 'U' (other) or null (not in the 3D view)
    const cls = (t) => { const [x, y] = at(t); if (!inView(x, y)) return null; const c = colourAt(x, y); return R.has(c) ? 'R' : G.has(c) ? 'G' : 'U'; };
    const is = (t, c) => cls(t) === c;
    const not = (t, c) => { const v = cls(t); return v !== null && v !== c; };
    // boundary b lies between pixel b-1 and b
    const isInner = (b) => roadBefore
      ? is(b - 1, 'R') && is(b - 2, 'R') && not(b, 'R') && not(b + 1, 'R')
      : is(b, 'R') && is(b + 1, 'R') && not(b - 1, 'R') && not(b - 2, 'R');
    const isOuter = (b) => roadBefore
      ? not(b - 1, 'G') && not(b - 2, 'G') && is(b, 'G') && is(b + 1, 'G')
      : not(b, 'G') && not(b + 1, 'G') && is(b - 1, 'G') && is(b - 2, 'G');
    const nearest = (test) => {
      const c0 = Math.round(sm.p);
      for (let d = 0; d <= win; d++) for (const b of d === 0 ? [c0] : [c0 + d, c0 - d]) if (test(b)) return b;
      return null;
    };
    const bi = nearest(isInner), bo = nearest(isOuter);
    const eIn = bi === null ? null : bi - sm.p, eOut = bo === null ? null : bo - sm.p;
    let e = null;
    if (bi !== null && bo !== null && sm.p >= Math.min(bi, bo) && sm.p <= Math.max(bi, bo)) e = 0;
    else if (bi !== null || bo !== null) e = Math.min(bi === null ? Infinity : Math.abs(eIn), bo === null ? Infinity : Math.abs(eOut));
    meas.push({ axis: sm.axis, q: sm.q, p: +sm.p.toFixed(2), side: sm.side, index: sm.index, depth: Math.round(sm.depth), roadBefore,
      inner: bi, outer: bo, errInner: eIn === null ? null : +(eIn * sm.f).toFixed(2), errOuter: eOut === null ? null : +(eOut * sm.f).toFixed(2),
      err: e === null ? null : +(e * sm.f).toFixed(2) });
  }
  const errs = meas.filter((m) => m.err !== null).map((m) => m.err);
  const abs = (k) => meas.filter((m) => m[k] !== null).map((m) => Math.abs(m[k]));
  const signed = (k) => meas.filter((m) => m[k] !== null).map((m) => m[k]);
  return {
    samples: meas.length, found: errs.length,
    medianErr: errs.length ? median(errs) : null, p90Err: errs.length ? quantile(errs, 0.9) : null,
    within1: errs.filter((e) => e <= 1).length, within2: errs.filter((e) => e <= 2).length,
    medianAbsInner: abs('errInner').length ? median(abs('errInner')) : null,
    medianAbsOuter: abs('errOuter').length ? median(abs('errOuter')) : null,
    // signed, in the search axis' direction (+ = right/down), perpendicular distance
    medianInner: signed('errInner').length ? median(signed('errInner')) : null,
    medianOuter: signed('errOuter').length ? median(signed('errOuter')) : null,
    roadColours: [...R].map(hex), vergeColours: [...G].map(hex),
    measurements: meas, mask: rm, cam3, horizonY: cam3.horizonY, viewport: [vy0, vy1], yTop,
  };
}

function dilate(bin, W, H, r) {
  // separable square dilation
  const tmp = new Uint8Array(W * H), out = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    let last = -1e9;
    for (let x = 0; x < W; x++) { if (bin[y * W + x]) last = x; if (x - last <= r) tmp[y * W + x] = 1; }
    last = 1e9;
    for (let x = W - 1; x >= 0; x--) { if (bin[y * W + x]) last = x; if (last - x <= r) tmp[y * W + x] = 1; }
  }
  for (let x = 0; x < W; x++) {
    let last = -1e9;
    for (let y = 0; y < H; y++) { if (tmp[y * W + x]) last = y; if (y - last <= r) out[y * W + x] = 1; }
    last = 1e9;
    for (let y = H - 1; y >= 0; y--) { if (tmp[y * W + x]) last = y; if (last - y <= r) out[y * W + x] = 1; }
  }
  return out;
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
  // detected boundaries: outer (verge starts) green, inner (road grey ends) orange; short ticks across the search line
  if (check) for (const m of check.measurements) {
    for (const [b, rgb] of [[m.outer, [0, 255, 0]], [m.inner, [255, 128, 0]]]) {
      if (b === null) continue;
      if (m.axis === 'x') { plot(b, m.q - 1, rgb); plot(b, m.q + 1, rgb); } else { plot(m.q - 1, b, rgb); plot(m.q + 1, b, rgb); }
    }
  }
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
  histogram, erode, dilate, key, hex, rgbOf, quantile, median, NEAR,
};
