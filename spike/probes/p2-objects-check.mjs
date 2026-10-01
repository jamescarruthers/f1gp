// Check lib/objects.mjs against the game: for RAM captures paired with the
// game's screenshot (taken while paused), rebuild the track (scene.mjs) and
// the trackside objects (objects.mjs) from the RAM, draw them at 320x200 from
// the game's camera with the game's projection, and compare pixel colours
// with the game's frame inside the areas our objects cover.
//
// The objects are drawn the way the game draws them in that frame (decoded in
// docs/renderer-notes.md, "Objects: shapes and placement"): which segments'
// objects the walk reaches, the detail level, the LOD by depth, the display
// list of the view sector (so one-sided faces drop out as in the game), haze
// by depth, scaled bitmaps with the game's integer scaling and mirroring, and
// one-pixel poles. Visibility between objects and the track uses a depth
// buffer; inside one object the display-list order wins (as the game).
//
//   node probes/p2-objects-check.mjs <capture dir> [name ...] [--out DIR] [--json FILE]
//
// Writes <out>/<name>-objects.png: the game's frame, ours, the pixels that
// differ (red: differs inside our objects, dark red: differs elsewhere), and
// the object mask (white: same colour as the game, red: different).

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fromRam } from '../lib/f1gp-mem.mjs';
import { createReader } from '../lib/f1gp-state.mjs';
import { readScene, buildSceneMesh, horizonOff } from '../lib/scene.mjs';
import { cameraFromState, renderMesh } from '../lib/soft-render.mjs';
import { decodePng } from '../lib/png.mjs';
import { readObjects, readCrowd, CROWD_COLOUR, shapePoints, polygonLoop, worldPoint, spriteLodFrame, shownAtDetail } from '../lib/objects.mjs';

const require = createRequire(import.meta.url);
const { encodePng } = require('../lib/node-emu.cjs');

const args = process.argv.slice(2);
const opt = { out: null, json: null };
const pos = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--out') opt.out = args[++i];
  else if (args[i] === '--json') opt.json = args[++i];
  else pos.push(args[i]);
}
const dir = pos[0];
const outDir = opt.out ?? dir;
fs.mkdirSync(outDir, { recursive: true });
const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
const names = pos.slice(1).length ? pos.slice(1) : fs.readdirSync(dir).filter((f) => f.endsWith('.ram')).map((f) => f.slice(0, -4)).sort();

const W = 320, HGT = 200, NEAR = 8;
const K = ((0x6e80 * 2) / 65536) * 32;

// --------------------------------------------------------------- camera space
function toCam(cam, p) {
  const dx = p[0] / 8 - cam.x8, dy = p[1] / 8 - cam.y8;
  return [dx * cam.cos - dy * cam.sin, dx * cam.sin + dy * cam.cos, p[2] - cam.z];
}
// the game's point projection (0F47:9110, 2168): x = 160 + lateral*256/depth
// (idiv truncates); y = horizon - q, q = (hi16(dz*SS:017C*2) << 5) / depth, where
// a negative q rounds to nearest but a positive one is truncated (the game
// compares the quotient, not the remainder, with the depth). Near objects
// (within 250 ft) use 1/64 ft units (hi = true): the same ratios, finer steps.
function projGame(cam, v, hi = false) {
  const k = hi ? 8 : 1;
  const L = Math.floor(v[0] * k), D = Math.max(1, Math.floor(v[1] * k));
  const x = 160 + Math.trunc((L * 256) / D);
  const dz = Math.floor((v[2] * cam.vscale * 2) / 65536);
  const n = dz * 32 * k;
  let q = Math.trunc(n / D);
  const r = n - q * D;
  if (r >= 0) { if ((q & 0xffff) >= D) q += 1; } else if (-2 * r >= D) q -= 1;
  return [x, cam.horizon - q];
}
function clipNear(poly) {
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const ina = a[1] >= NEAR, inb = b[1] >= NEAR;
    if (ina) out.push(a);
    if (ina !== inb) {
      const t = (NEAR - a[1]) / (b[1] - a[1]);
      out.push([a[0] + (b[0] - a[0]) * t, NEAR, a[2] + (b[2] - a[2]) * t]);
    }
  }
  return out;
}

// --------------------------------------------------------------- rasterising
// fill a polygon (screen points with depth) at pixel centres; cb(x, y, depth)
function fillPoly(scr, y0, y1, cb) {
  let minY = Infinity, maxY = -Infinity;
  for (const p of scr) { if (p[1] < minY) minY = p[1]; if (p[1] > maxY) maxY = p[1]; }
  const ys = Math.max(y0, Math.ceil(minY - 0.5)), ye = Math.min(y1 - 1, Math.floor(maxY - 0.5));
  for (let y = ys; y <= ye; y++) {
    const yc = y + 0.5, xs = [];
    for (let i = 0; i < scr.length; i++) {
      const a = scr[i], b = scr[(i + 1) % scr.length];
      if ((a[1] <= yc) !== (b[1] <= yc)) {
        const t = (yc - a[1]) / (b[1] - a[1]);
        xs.push([a[0] + t * (b[0] - a[0]), a[2] + t * (b[2] - a[2])]); // x, 1/depth
      }
    }
    xs.sort((p, q) => p[0] - q[0]);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const [xa, ia] = xs[k], [xb, ib] = xs[k + 1];
      const x0 = Math.max(0, Math.ceil(xa - 0.5)), x1 = Math.min(W - 1, Math.floor(xb - 0.5));
      for (let x = x0; x <= x1; x++) {
        const t = xb > xa ? (x + 0.5 - xa) / (xb - xa) : 0;
        cb(x, y, 1 / (ia + t * (ib - ia)));
      }
    }
  }
}

// depth of the nearest track surface per pixel (the colours come from renderMesh)
function trackDepth(data, origin, cam) {
  const depth = new Float32Array(W * HGT).fill(Infinity);
  const y0 = cam.top, y1 = cam.top + cam.rows;
  for (let i = 0; i < data.length; i += 18) {
    const cs = [];
    for (let k = 0; k < 3; k++) { const o = i + 6 * k; cs.push(toCam(cam, [data[o] + origin[0], data[o + 1] + origin[1], data[o + 2]])); }
    if (cs.every((v) => v[1] < NEAR) || cs.every((v) => v[1] > 60000)) continue;
    const c = clipNear(cs);
    if (c.length < 3) continue;
    const scr = c.map((v) => [160 + (256 * v[0]) / v[1], cam.top + cam.horizon - (v[2] * K) / v[1], 1 / v[1]]);
    fillPoly(scr, y0, y1, (x, y, d) => { const p = y * W + x; if (d < depth[p]) depth[p] = d; });
  }
  return depth;
}

// --------------------------------------------------------------- the walk
// Which segments' objects the game draws this frame (renderer-notes section 2):
// n segments ahead from seg +20 (parity rule), 9 behind; the object's band
// limit from its setting flags.
function walkRange(mem, scene) {
  const H = mem.heap(), B = mem.memBase, ds = mem.DS << 4, ss = mem.SS << 4;
  const r16 = (a) => H[B + a] | (H[B + a + 1] << 8);
  const lin = (r16(ds + 0x0971) << 4) + r16(ds + 0x096f);
  const nr = r16(lin + 0x1a) & 0x0fff;
  const reverse = (r16(ss + 0x0136) & 0x8000) !== 0;
  const n = scene.lap.length;
  const seg = (i) => scene.lap[((i % n) + n) % n];
  const raw = (i) => { const s = seg(i); return s ? s : null; };
  const H20 = (i) => { const s = raw(i); return s ? H[B + s.__lin + 0x20] : 0; };
  return { cam: nr, reverse, n, H20, lin, H, B };
}

// --------------------------------------------------------------- sprites
// The game's scaled bitmap (0F47:19E8) with its integer arithmetic.
function drawSprite(objs, spr, id, x0, y0, D8, mirrored, colourOf, plot, rows) {
  if (!spr || D8 <= 0) return;
  let s = Math.floor((spr.size * 8192) / D8);
  if (s === 0) s = 1;
  if (s > 0x8000) s = 0x8000;
  const hs = s * 8, hint = Math.floor(hs / 65536), hfrac = hs % 65536;
  // column table X[c], c = -128..127
  const X = new Map();
  let cx = x0, dx = x0, frac = 0;
  const dir = mirrored ? -1 : 1;
  X.set(0, x0);
  for (let k = 1; k <= 128; k++) {
    frac += hfrac;
    if (frac >= 65536) { frac -= 65536; cx += dir; dx -= dir; }
    cx += dir * hint; dx -= dir * hint;
    X.set(k, cx); X.set(-k, dx);
  }
  const clampX = (v) => Math.max(0, Math.min(320, v));
  const sv = [0xaf, 0xaa, 0xab].includes(id) ? s : Math.floor((s * objs.spriteVscale) / 65536);
  if (!sv) return;
  const dy = Math.floor((spr.bottom * sv) / 8192);
  let cy = y0 + dy;
  let q = Math.floor(0x1000000 / sv);
  if (q > 0xffff) q = 0xffff;
  if (!q) return;
  const step = q * 32;
  let acc = spr.bottom * 65536 - ((q * dy * 32) | 0);
  while (acc < 0) acc += step;
  if (cy < 0) return;
  for (; cy >= 0; cy--) {
    const r = Math.floor(acc / 65536);
    acc += step;
    if (r >= spr.rows) break;
    if (cy >= rows) continue;
    for (const [c0, c1, k] of spr.runs[r]) {
      const a = clampX(X.get(c0)), b = clampX(X.get(c1));
      const lo = Math.min(a, b), hi = Math.max(a, b);
      const col = colourOf(k);
      for (let x = lo; x < hi; x++) plot(x, cy, col);
    }
  }
}

// --------------------------------------------------------------- one capture
const results = [];
for (const name of names) {
  const ram = new Uint8Array(fs.readFileSync(path.join(dir, `${name}.ram`)));
  const game = decodePng(fs.readFileSync(path.join(dir, `${name}.png`)));
  const mem = fromRam(ram, { imageSeg: meta.imageSeg });
  const st = createReader(mem).read();
  const cam = { ...cameraFromState(st), vscale: mem.ss.u16(0x017c) };
  const scene = readScene(mem);
  const mesh = buildSceneMesh(scene);
  const pal = scene.palette;
  const rgb = (i) => [pal[i * 3], pal[i * 3 + 1], pal[i * 3 + 2]];
  // background as probes/p2-scene-check.mjs
  const noImage = horizonOff(mem);
  const skySteps = [];
  for (const e of scene.tables.sky) { for (let r = 0; r < Math.min(e.rows, 200); r++) skySteps.push(e.colour); skySteps.push(e.colour); }
  const yawCol = st.camera.heading >> 5;
  const background = (x, y) => {
    const above = cam.top + cam.horizon - y;
    if (above <= 0) return rgb(scene.grass);
    if (!noImage && above <= 8) return rgb(scene.horizon[(8 - above) * 512 + ((yawCol + x) & 511)]);
    const r = above - (noImage ? 1 : 9);
    return rgb(skySteps[Math.min(r, skySteps.length - 1)]);
  };
  const base = renderMesh(mesh.data, mesh.origin, cam, { background });
  const tdepth = trackDepth(mesh.data, mesh.origin, cam);

  // ---- objects
  const objs = readObjects(mem);
  const haze = objs.haze;
  const atan = (k) => mem.ss.u16(0x5268 + 16 * k);
  const detail = mem.ds.u8(0x0068);
  const camYaw = st.camera.heading & 0xffff;
  const hazeLevel = (d8) => {
    let v = Math.min(Math.max(Math.floor(d8) + 0x80, 0), 0x3c00) >> 8;
    v -= 5; if (v < 0) v = 0; v >>= 3; return Math.min(v, 4);
  };
  const hazed = (c, lvl) => (lvl > 0 && haze ? haze[(lvl - 1) * 256 + c] : c);
  const objCol = new Int16Array(W * HGT).fill(-1);
  const objDepth = new Float32Array(W * HGT).fill(Infinity);
  const objId = new Int32Array(W * HGT).fill(-1);
  const counts = { placed: 0, drawn: 0, polys: 0, crowdPolys: 0, sprites: 0, lines: 0, skippedWalk: 0, skippedDetail: 0 };
  const crowd = readCrowd(mem);
  const crowdPix = new Uint8Array(W * HGT);

  // walk: segments ahead / behind the camera's segment
  const H = mem.heap();
  const ds = mem.DS << 4, ss = mem.SS << 4;
  const r16 = (a) => H[a] | (H[a + 1] << 8);
  const camLin = (r16(ds + 0x0971) << 4) + r16(ds + 0x096f);
  const camNr = r16(camLin + 0x1a) & 0x0fff;
  const reverse = (r16(ss + 0x0136) & 0x8000) !== 0;
  const lapN = scene.lap.length;
  const segLin = (i) => camLin + 0x2e * (i - camNr); // only used near the camera's array position
  let nAhead;
  {
    const nb = (k) => H[segLin(camNr + k) + 0x20];
    if (!reverse) nAhead = camNr & 1 ? nb(1) + 1 : nb(0);
    else nAhead = r16(segLin(camNr + 1) + 0x1a) & 1 ? nb(1) : nb(2) - 1;
  }
  const walkOk = (p) => {
    if (p.pit) return false; // pit-lane objects are drawn by the second pass (0F47:9C05), not modelled
    let ahead = ((p.segment - camNr) % lapN + lapN) % lapN;
    if (reverse) ahead = ((camNr - p.segment) % lapN + lapN) % lapN;
    const behind = lapN - ahead;
    if (ahead <= nAhead) return ahead <= p.maxSegments;
    return behind <= 9;
  };

  const ray = (xs) => { const d = xs - 160, k = Math.min(Math.abs(d), 255); return d < 0 ? atan(k) : -atan(k); };
  let objIndex = 0;
  for (const p of objs.placements) {
    counts.placed++;
    if (!walkOk(p)) { counts.skippedWalk++; continue; }
    if (!shownAtDetail(p, detail)) { counts.skippedDetail++; continue; }
    const shape = objs.shapeAt(p);
    if (!shape) continue;
    const id = objIndex++;
    // the object's centre (Z + shape +14) in camera space
    const vc = toCam(cam, [p.x, p.y, p.z + shape.z14]);
    // within 3E80h fine units (with the shape's size) the game works in 1/64 ft
    const hi = Math.abs(p.x - cam.x8 * 8) + shape.size < 0x3e80 && Math.abs(p.y - cam.y8 * 8) + shape.size < 0x3e80;
    const d8 = vc[1];
    let xc;
    if (d8 < NEAR) xc = vc[0] < 0 ? 0 : 0x140;
    else xc = projGame(cam, vc, hi)[0];
    const r44 = ray(xc);
    const r42 = (p.yaw - camYaw) & 0xffff;
    const aRay = (r42 + r44) & 0xffff;
    // painter's order inside the object: a temporary buffer
    const tmp = new Map();
    const put = (x, y, col, depth) => { if (x < 0 || x >= W || y < 0 || y >= cam.rows) return; tmp.set((y + cam.top) * W + x, [col, depth]); };
    let lodIdx = shape.lods.findIndex((l) => Math.floor(Math.max(d8, 0)) <= l.max);
    if (lodIdx < 0) lodIdx = shape.lods.length - 1;
    let lod = shape.lods[lodIdx];
    const spriteAt = (sid, mirrored, palOff, v, depthTag) => {
      if (v[1] < NEAR) return;
      const [sx, sy] = projGame(cam, v, hi);
      const spr = objs.sprite(sid);
      if (!spr) return;
      const D8 = Math.floor(v[1]);
      const lvl = hazeLevel(D8);
      drawSprite(objs, spr, sid, sx, sy, D8, mirrored, (k) => hazed(objs.palettes[(palOff + k) & 0xffff], lvl), (x, y, col) => put(x, y, col, depthTag ?? v[1]), cam.rows);
      counts.sprites++;
    };
    if (lod.sprite) {
      if (d8 < NEAR) continue;
      const f = spriteLodFrame(lod, aRay);
      if (!f) continue;
      if (f.polygons) { lodIdx = shape.lods.findIndex((l) => !l.sprite); lod = shape.lods[lodIdx]; }
      else { spriteAt(f.id, f.mirrored, p.palette, vc); }
    }
    if (!lod.sprite) {
      const pts = shapePoints(shape, lod);
      const wp = pts.map((pt) => worldPoint(objs, p, shape, pt));
      const cp = wp.map((w) => toCam(cam, w));
      const lvl = hazeLevel(Math.max(Math.floor(d8), shape.size >> 3));
      const palOf = (k) => objs.palettes[(p.palette + k) & 0xffff];
      const sector = (aRay >> ((lod.shift & 15) + 1)) % lod.dirs.length;
      for (const o of lod.dirs[sector]) {
        const el = shape.elements.get(o);
        if (el.kind === 'poly') {
          const loop = polygonLoop(shape, el);
          const c = clipNear(loop.map((i) => cp[i]));
          if (c.length < 3) continue;
          const scr = c.map((v) => { const s = projGame(cam, v, hi); return [s[0], s[1] + cam.top, 1 / v[1]]; });
          const col = hazed(palOf(el.colour), lvl);
          if (col === CROWD_COLOUR) {
            // the crowd: spans from the bottom row up, pixels from the strip
            const spans = new Map();
            fillPoly(scr, cam.top, cam.top + cam.rows, (x, y, d) => {
              if (!spans.has(y)) spans.set(y, []);
              spans.get(y).push([x, d]);
            });
            let k = 0, end = 0;
            const strip = crowd.strips[lvl];
            for (const y of [...spans.keys()].sort((a, b) => b - a)) {
              const row = spans.get(y).sort((a, b) => a[0] - b[0]);
              k = (k + 1) & 63;
              const off = (crowd.rows[k] + end) & 0x1ff;
              row.forEach(([x, d], i) => tmp.set(y * W + x, [crowd.active ? strip[off + i] : crowd.practiceColour, d, 1]));
              end = off + row.length;
            }
            counts.crowdPolys++;
          } else fillPoly(scr, cam.top, cam.top + cam.rows, (x, y, d) => tmp.set(y * W + x, [col, d]));
          counts.polys++;
        } else if (el.kind === 'line') {
          const [a, b] = shape.vector(el.vector);
          const va = cp[a], vb = cp[b];
          if (va[1] < NEAR || vb[1] < NEAR) continue;
          const pa = projGame(cam, va, hi), pb = projGame(cam, vb, hi);
          const col = hazed(palOf(0), lvl);
          if (pa[0] < 0 || pa[0] >= W) continue;
          const ya = Math.max(0, Math.min(pa[1], cam.rows - 1)), yb = Math.max(0, Math.min(pb[1] - 1, cam.rows - 1));
          for (let y = Math.min(ya, yb); y <= Math.max(ya, yb); y++) put(pa[0], y, col, va[1]);
          counts.lines++;
        } else if (el.kind === 'bitmap') {
          if (el.type & 0x10) continue;
          const v = cp[el.point];
          if (v[1] < NEAR || Math.floor(v[1]) > el.maxDepth) continue;
          let m;
          if (el.type & 4) m = 1; else m = (r42 + 0x4000) & 0xffff;
          if (el.type & 8) m = -m & 0xffff;
          spriteAt(el.id, (m & 0x8000) !== 0, el.palette ?? p.palette, v);
        }
      }
    }
    // composite with the depth test against the track and other objects
    for (const [pix, [col, depth, isCrowd]] of tmp) {
      if (depth > tdepth[pix] * 1.0005) continue;
      if (depth >= objDepth[pix]) continue;
      objDepth[pix] = depth; objCol[pix] = col; objId[pix] = id; crowdPix[pix] = isCrowd ? 1 : 0;
    }
    counts.drawn++;
  }

  // ---- compose, compare
  const ours = base.slice();
  const mask = new Uint8Array(W * HGT);
  for (let pix = 0; pix < W * HGT; pix++) if (objCol[pix] >= 0) { const c = rgb(objCol[pix]); ours.set([c[0], c[1], c[2], 255], pix * 4); mask[pix] = 1; }
  // overlays the game draws over the 3D view: the PAUSED sign and the viewing banner
  const masked = (x, y) => (y >= 50 && y < 72 && x >= 124 && x < 196) || (cam.top > 0 && y < 24);
  let objPix = 0, objSame = 0, trackWrong = 0, fixed = 0, broke = 0, crowdN = 0;
  const diff = new Uint8Array(W * HGT * 4), mpng = new Uint8Array(W * HGT * 4);
  for (let y = cam.top; y < cam.top + cam.rows; y++) for (let x = 0; x < W; x++) {
    const pix = y * W + x, o = pix * 4;
    if (masked(x, y)) continue;
    const eq = (a) => a[o] === game.data[o] && a[o + 1] === game.data[o + 1] && a[o + 2] === game.data[o + 2];
    const eqOurs = eq(ours), eqBase = eq(base);
    if (mask[pix] && crowdPix[pix]) { crowdN++; mpng.set([0, 0, 160, 255], o); }
    else if (mask[pix]) { objPix++; if (eqOurs) objSame++; mpng.set(eqOurs ? [255, 255, 255, 255] : [255, 0, 0, 255], o); } else mpng.set([0, 0, 0, 255], o);
    if (!eqBase) { trackWrong++; if (eqOurs) fixed++; }
    if (eqBase && !eqOurs) broke++;
    diff.set(eqOurs ? [0, 0, 0, 255] : mask[pix] ? [255, 0, 0, 255] : [110, 0, 0, 255], o);
  }
  const sheet = new Uint8Array(1280 * 200 * 4);
  for (let y = 0; y < 200; y++) {
    sheet.set(game.data.subarray(y * 1280, (y + 1) * 1280), y * 5120);
    const row = ours.slice(y * 1280, (y + 1) * 1280);
    for (let x = 0; x < 320; x++) row[x * 4 + 3] = 255;
    sheet.set(row, y * 5120 + 1280);
    sheet.set(diff.subarray(y * 1280, (y + 1) * 1280), y * 5120 + 2560);
    sheet.set(mpng.subarray(y * 1280, (y + 1) * 1280), y * 5120 + 3840);
  }
  fs.writeFileSync(path.join(outDir, `${name}-objects.png`), encodePng(1280, 200, sheet, 4));
  const r = {
    name, view: st.view.mode, detail, nAhead, camSeg: camNr, reverse, ...counts,
    crowdPixels: crowdN, objectPixels: objPix, objectSamePct: +(100 * objSame / Math.max(objPix, 1)).toFixed(1),
    trackOnlyWrong: trackWrong, fixedByObjects: fixed, fixedPct: +(100 * fixed / Math.max(trackWrong, 1)).toFixed(1), brokeTrack: broke,
  };
  results.push(r);
  console.log(JSON.stringify(r));
}
if (opt.json) fs.writeFileSync(opt.json, JSON.stringify(results, null, 1));
