// Shared code of the object checks (probes/p2-objects-check.mjs on RAM
// captures, probes/p2-objects-ref.mjs on the 16-circuit reference frames):
// draw the track (scene.mjs) and the trackside objects (objects.mjs) for one
// game frame at 320x200 with the game's projection, and compare with the
// game's screenshot inside the areas our objects cover.
//
// Modes:
//   'game'  - the objects as the game draws them that frame (renderer-notes,
//             "Objects: shapes and placement"): the walk's segments, the
//             detail level, LOD by depth, the view sector's display list in
//             its order (inside one object later elements paint over earlier
//             ones), per-object haze, the crowd fill, the game's integer
//             projection (truncation quirk included), its scaled bitmaps and
//             one-pixel poles, one-sided polygons. Against the track: a depth
//             buffer; between objects: a depth buffer, but objects come in the
//             game's order (far to near, setting +0A) and a later one wins
//             where both are within 0.5 % of the same depth (decal objects).
//             Env: OBJ_ORDER=painter (pure painter's order between objects),
//             OBJ_TIE (the tie fraction), NO_CULL=1, DEBUG_OBJ=1.
//   'mesh'  - what a WebGL renderer draws from buildSectorMesh/frameObjects:
//             triangles with a depth buffer (decal layers pulled forward),
//             camera-facing sprite quads from the atlas, float projection.
//   'meshr' - the same mesh data, but vertices and bitmaps placed with the
//             game's integer projection and bitmap scaling: checks the mesh
//             data without the rasteriser differences.

import { readScene, buildSceneMesh, horizonOff } from '../lib/scene.mjs';
import { cameraFromState, renderMesh } from '../lib/soft-render.mjs';
import {
  readObjects, readCrowd, CROWD_COLOUR, shapePoints, polygonLoop, worldPoint, spriteLodFrame, shownAtDetail,
  buildSectorMesh, frameObjects, buildSpriteAtlas, spriteQuads, hazeLevel, drawSprite,
} from '../lib/objects.mjs';

export const W = 320, HGT = 200, NEAR = 8;
const K = ((0x6e80 * 2) / 65536) * 32;

// ------------------------------------------------------------------ camera space
export function toCam(cam, p) {
  const dx = p[0] / 8 - cam.x8, dy = p[1] / 8 - cam.y8;
  return [dx * cam.cos - dy * cam.sin, dx * cam.sin + dy * cam.cos, p[2] - cam.z];
}
// The game's point projection (0F47:9110, 2168): x = 160 + lateral*256/depth
// (idiv truncates); y = horizon - q, q = (hi16(dz*SS:017C*2) << 5) / depth, where
// a negative q rounds to nearest but a positive one is truncated (the game
// compares the quotient, not the remainder, with the depth). Near objects
// (within 250 ft) use 1/64 ft units (hi = true): the same ratios, finer steps.
export function projGame(cam, v, hi = false) {
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
export function clipNear(poly) {
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

// fill a polygon (screen points [x, y, 1/depth]) at pixel centres; cb(x, y, depth)
export function fillPoly(scr, y0, y1, cb) {
  let minY = Infinity, maxY = -Infinity;
  for (const p of scr) { if (p[1] < minY) minY = p[1]; if (p[1] > maxY) maxY = p[1]; }
  const ys = Math.max(y0, Math.ceil(minY - 0.5)), ye = Math.min(y1 - 1, Math.floor(maxY - 0.5));
  for (let y = ys; y <= ye; y++) {
    const yc = y + 0.5, xs = [];
    for (let i = 0; i < scr.length; i++) {
      const a = scr[i], b = scr[(i + 1) % scr.length];
      if ((a[1] <= yc) !== (b[1] <= yc)) {
        const t = (yc - a[1]) / (b[1] - a[1]);
        xs.push([a[0] + t * (b[0] - a[0]), a[2] + t * (b[2] - a[2])]);
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

// signed area of a screen outline (x right, y down): > 0 = clockwise as seen
export function screenArea(scr) {
  let a = 0;
  for (let i = 0; i < scr.length; i++) { const p = scr[i], q = scr[(i + 1) % scr.length]; a += p[0] * q[1] - q[0] * p[1]; }
  return a / 2;
}

// depth of the nearest track surface per pixel (the colours come from renderMesh)
function trackDepth(data, origin, cam) {
  const depth = new Float32Array(W * HGT).fill(Infinity);
  for (let i = 0; i < data.length; i += 18) {
    const cs = [];
    for (let k = 0; k < 3; k++) { const o = i + 6 * k; cs.push(toCam(cam, [data[o] + origin[0], data[o + 1] + origin[1], data[o + 2]])); }
    if (cs.every((v) => v[1] < NEAR) || cs.every((v) => v[1] > 60000)) continue;
    const c = clipNear(cs);
    if (c.length < 3) continue;
    const scr = c.map((v) => [160 + (256 * v[0]) / v[1], cam.top + cam.horizon - (v[2] * K) / v[1], 1 / v[1]]);
    fillPoly(scr, cam.top, cam.top + cam.rows, (x, y, d) => { const p = y * W + x; if (d < depth[p]) depth[p] = d; });
  }
  return depth;
}

// The game's scaled bitmap (0F47:19E8): lib/objects.mjs drawSprite
export { drawSprite };

// ------------------------------------------------------------------ the walk
// Segment entries by number (track and pit arrays), for +20 (view distance).
function segmentsByNumber(mem) {
  const H = mem.heap(), B = mem.memBase, ds = mem.DS << 4, ss = mem.SS << 4;
  const r16 = (a) => H[B + a] | (H[B + a + 1] << 8);
  const map = new Map();
  const tOff = r16(ds + 0x879f), tSeg = r16(ds + 0x87a1), lapEnd = r16(ss + 0x015c);
  for (let i = 0; tOff + i * 0x2e < lapEnd; i++) { const lin = (tSeg << 4) + tOff + i * 0x2e; const nr = r16(lin + 0x1a) & 0x2fff; if (!map.has(nr)) map.set(nr, lin); }
  const pOff = r16(ds + 0x8797), pSeg = r16(ds + 0x8799);
  for (let i = 0; i < 600; i++) { const lin = (pSeg << 4) + pOff + i * 0x2e; const nr = r16(lin + 0x1a) & 0x2fff; if (i && map.has(nr)) break; map.set(nr, lin); }
  return { map, u8: (a) => H[B + a], r16 };
}

/**
 * The camera's segment and the walk's view distance (renderer-notes section 2):
 * from memory (DS:096F, SS:0136), or for a stored camera from the nearest lap
 * segment and the angle between the camera and that segment's heading.
 */
export function walkOf(mem, scene, st, fromMemory) {
  const segs = segmentsByNumber(mem);
  const lapN = scene.lap.length;
  const keyOf = (p) => (p.pit ? p.segment | 0x2000 : p.segment);
  if (fromMemory) {
    // walk the array the camera's segment is in (with the pit lane spliced in, or
    // the pit array), n entries ahead and 9 behind, wrapping at the lap's end
    const ds = mem.DS << 4, ss = mem.SS << 4;
    const r16 = segs.r16;
    const camSeg = r16(ds + 0x0971), camOff = r16(ds + 0x096f);
    const tSeg = r16(ds + 0x87a1), tOff = r16(ds + 0x879f), lapEnd = r16(ss + 0x015c);
    const pSeg = r16(ds + 0x8799), pOff = r16(ds + 0x8797);
    const inTrack = camSeg === tSeg && camOff >= tOff && camOff < lapEnd;
    const base = inTrack ? tOff : pOff, seg = inTrack ? tSeg : pSeg;
    const count = inTrack ? (lapEnd - tOff) / 0x2e : 600;
    const idx = (camOff - base) / 0x2e;
    const at = (k) => (seg << 4) + base + 0x2e * (inTrack ? ((k % count) + count) % count : Math.max(0, k));
    const nrAt = (k) => r16(at(k) + 0x1a) & 0x2fff;
    const camNr = nrAt(idx);
    const reverse = (r16(ss + 0x0136) & 0x8000) !== 0;
    const dir = reverse ? -1 : 1;
    const v20 = (k) => segs.u8(at(idx + k) + 0x20);
    let nAhead;
    if (!reverse) nAhead = nrAt(idx) & 1 ? v20(1) + 1 : v20(0);
    else nAhead = nrAt(idx + 1) & 1 ? v20(1) : v20(2) - 1;
    const where = new Map();
    for (let k = nAhead; k >= -9; k--) where.set(nrAt(idx + dir * k), k);
    const ok = (p) => {
      const k = where.get(keyOf(p));
      if (k === undefined) return false;
      return k >= 0 ? k <= p.maxSegments : true;
    };
    return { camNr: camNr & 0x0fff, inPit: (camNr & 0x2000) !== 0, reverse, nAhead, ok };
  }
  // a stored camera: the nearest lap segment, by number
  const cx = st.camera.x / 256, cy = st.camera.y / 256;
  let best = Infinity, camNr = 0;
  scene.lap.forEach((s, i) => { if (!s) return; const d = (s.x - cx) ** 2 + (s.y - cy) ** 2; if (d < best) { best = d; camNr = i; } });
  // the segment the camera is in: the nearest start point, or the one before it
  // when the camera has not reached that start yet
  const s0 = scene.lap[camNr], h = (s0.heading / 65536) * 2 * Math.PI;
  if ((cx - s0.x) * Math.sin(h) + (cy - s0.y) * Math.cos(h) < 0) camNr = (camNr - 1 + lapN) % lapN;
  const dh = ((st.camera.heading - scene.lap[camNr].heading) & 0xffff);
  const reverse = dh > 0x4000 && dh < 0xc000;
  const v20 = (nr) => { const lin = segs.map.get(((nr % lapN) + lapN) % lapN); return lin === undefined ? 0 : segs.u8(lin + 0x20); };
  let nAhead;
  if (!reverse) nAhead = camNr & 1 ? v20(camNr + 1) + 1 : v20(camNr);
  else nAhead = (camNr + 1) & 1 ? v20(camNr + 1) : v20(camNr + 2) - 1;
  const ok = (p) => {
    // pit-lane objects: only when the walk runs on the pit lane (camera in the pit
    // lane); the second pass over the pit lane (0F47:9C05) sets SS:0172, which makes
    // 0F47:9E2A skip every object
    if (p.pit) return false;
    const sg = p.segment % lapN;
    const ahead = reverse ? ((camNr - sg) % lapN + lapN) % lapN : ((sg - camNr) % lapN + lapN) % lapN;
    if (ahead <= nAhead) return ahead <= p.maxSegments;
    return lapN - ahead <= 9;
  };
  return { camNr, inPit: false, reverse, nAhead, ok };
}

// ------------------------------------------------------------------ one frame
/**
 * @param {object} a { mem, st (readState), game (decoded PNG), detail (0-3), fromMemory (walk from RAM),
 *                     mode: 'game' | 'mesh' | 'meshr' }
 * @returns {{ result: object, sheet: Uint8Array (1280 x 200 RGBA) }}
 */
export function checkFrame(a) {
  const { mem, st, game } = a;
  const mode = a.mode ?? 'game';
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

  const objs = readObjects(mem);
  const crowd = readCrowd(mem);
  const detail = a.detail;
  const camYaw = st.camera.heading & 0xffff;
  const hazed = (c, lvl) => (lvl > 0 && objs.haze ? objs.haze[(lvl - 1) * 256 + c] : c);
  const walk = walkOf(mem, scene, st, a.fromMemory);
  const objCol = new Int16Array(W * HGT).fill(-1);
  const objDepth = new Float32Array(W * HGT).fill(Infinity);
  const crowdPix = new Uint8Array(W * HGT);
  const counts = { placed: objs.placements.length, drawn: 0, polys: 0, crowdPolys: 0, sprites: 0, lines: 0, shapes: new Set() };
  const keep = objs.placements.filter((p) => walk.ok(p) && shownAtDetail(p, detail));
  // the game's drawing order of objects: far to near by segments ahead of the
  // camera, each moved by its setting's +0A (0F47:5233, see objects.mjs orderKey;
  // long buildings are drawn before what stands near their far end)
  const lapN = scene.lap.length;
  const orderKey = (p) => {
    const sg = p.segment % lapN;
    let ahead = walk.reverse ? ((walk.camNr - sg) % lapN + lapN) % lapN : ((sg - walk.camNr) % lapN + lapN) % lapN;
    if (ahead > lapN / 2) ahead -= lapN;
    const st = objs.settings[p.setting];
    const shift = ((st.range >> 8) & 0x3f) + Math.max(st.range & 0xff, 2) - 2;
    return ahead + (st.flags & 0x80 ? -shift : shift);
  };
  keep.sort((u, v) => orderKey(v) - orderKey(u));
  const painter = process.env.OBJ_ORDER === 'painter';
  const HYBRID = 1 + +(process.env.OBJ_TIE ?? 0.005);
  const atan = (k) => mem.ss.u16(0x5268 + 16 * k);
  const ray = (xs) => { const d = xs - 160, k = Math.min(Math.abs(d), 255); return d < 0 ? atan(k) : -atan(k); };

  if (mode === 'game') {
    for (const p of keep) {
      const shape = objs.shapeAt(p);
      if (!shape) continue;
      counts.shapes.add(p.shape);
      const vc = toCam(cam, [p.x, p.y, p.z + shape.z14]);
      // within 3E80h fine units (with the shape's size) the game works in 1/64 ft
      const hi = Math.abs(p.x - cam.x8 * 8) + shape.size < 0x3e80 && Math.abs(p.y - cam.y8 * 8) + shape.size < 0x3e80;
      const d8 = vc[1];
      const xc = d8 < NEAR ? (vc[0] < 0 ? 0 : 0x140) : projGame(cam, vc, hi)[0];
      const r42 = (p.yaw - camYaw) & 0xffff;
      const aRay = (r42 + ray(xc)) & 0xffff;
      // painter's order inside the object: a temporary buffer, later elements win
      const tmp = new Map();
      const put = (x, y, col, depth) => { if (x < 0 || x >= W || y < 0 || y >= cam.rows) return; tmp.set((y + cam.top) * W + x, [col, depth]); };
      let lodIdx = shape.lods.findIndex((l) => Math.floor(Math.max(d8, 0)) <= l.max);
      if (lodIdx < 0) lodIdx = shape.lods.length - 1;
      let lod = shape.lods[lodIdx];
      const spriteAt = (sid, mirrored, palOff, v) => {
        if (v[1] < NEAR) return;
        const [sx, sy] = projGame(cam, v, hi);
        const spr = objs.sprite(sid);
        if (!spr) return;
        const D8 = Math.floor(v[1]);
        const lvl = hazeLevel(D8);
        drawSprite(objs, spr, sid, sx, sy, D8, mirrored, (k) => hazed(objs.palettes[(palOff + k) & 0xffff], lvl), (x, y, col) => put(x, y, col, v[1]), cam.rows);
        counts.sprites++;
      };
      if (lod.sprite) {
        if (d8 < NEAR) continue;
        const f = spriteLodFrame(lod, aRay);
        if (!f) continue;
        if (f.polygons) lod = shape.lods.find((l) => !l.sprite);
        else spriteAt(f.id, f.mirrored, p.palette, vc);
      }
      if (lod && !lod.sprite) {
        const pts = shapePoints(shape, lod);
        const cp = pts.map((pt) => toCam(cam, worldPoint(objs, p, shape, pt)));
        const lvl = hazeLevel(Math.max(Math.floor(d8), shape.size >> 3));
        const palOf = (k) => objs.palettes[(p.palette + k) & 0xffff];
        const sector = (aRay >> ((lod.shift & 15) + 1)) % lod.dirs.length;
        for (const o of lod.dirs[sector]) {
          const el = shape.elements.get(o);
          if (el.kind === 'poly') {
            const c = clipNear(polygonLoop(shape, el).map((i) => cp[i]));
            if (c.length < 3) continue;
            const scr = c.map((v) => { const s = projGame(cam, v, hi); return [s[0], s[1] + cam.top, 1 / v[1]]; });
            // the span filler pairs left and right edges by their direction: an outline
            // that runs anticlockwise on the screen (seen from its back) fills nothing
            if (process.env.NO_CULL !== '1' && screenArea(scr) <= 0) continue;
            const col = hazed(palOf(el.colour), lvl);
            if (col === CROWD_COLOUR) {
              // the crowd: spans from the bottom row up, pixels copied from the strip
              const spans = new Map();
              fillPoly(scr, cam.top, cam.top + cam.rows, (x, y, d) => { if (!spans.has(y)) spans.set(y, []); spans.get(y).push([x, d]); });
              let k = 0, end = 0;
              const strip = crowd.strips[lvl];
              for (const y of [...spans.keys()].sort((u, v) => v - u)) {
                const row = spans.get(y).sort((u, v) => u[0] - v[0]);
                k = (k + 1) & 63;
                const off = (crowd.rows[k] + end) & 0x1ff;
                row.forEach(([x, d], i) => tmp.set(y * W + x, [crowd.active ? strip[off + i] : crowd.practiceColour, d, 1]));
                end = off + row.length;
              }
              counts.crowdPolys++;
            } else fillPoly(scr, cam.top, cam.top + cam.rows, (x, y, d) => tmp.set(y * W + x, [col, d]));
            counts.polys++;
          } else if (el.kind === 'line') {
            // a one-pixel vertical line at the first point's column (0F47:878D)
            const [ia, ib] = shape.vector(el.vector);
            const va = cp[ia], vb = cp[ib];
            if (va[1] < NEAR || vb[1] < NEAR) continue;
            const pa = projGame(cam, va, hi), pb = projGame(cam, vb, hi);
            if (pa[0] < 0 || pa[0] >= W) continue;
            const ya = Math.max(0, Math.min(pa[1], cam.rows - 1)), yb = Math.max(0, Math.min(pb[1] - 1, cam.rows - 1));
            for (let y = Math.min(ya, yb); y <= Math.max(ya, yb); y++) put(pa[0], y, hazed(palOf(0), lvl), va[1]);
            counts.lines++;
          } else if (el.kind === 'bitmap') {
            if (el.type & 0x10) continue;
            const v = cp[el.point];
            if (v[1] < NEAR || Math.floor(v[1]) > el.maxDepth) continue;
            let m = el.type & 4 ? 1 : (r42 + 0x4000) & 0xffff;
            if (el.type & 8) m = -m & 0xffff;
            spriteAt(el.id, (m & 0x8000) !== 0, el.palette ?? p.palette, v);
          }
        }
      }
      if (process.env.DEBUG_OBJ) {
        let x0 = 999, x1 = -1, y0 = 999, y1 = -1;
        for (const pix of tmp.keys()) { const x = pix % W, y = Math.floor(pix / W); x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
        if (x1 >= 0) console.error('obj seg', p.segment, 'set', p.setting, 'shape', p.shape, 'depth', Math.round(d8), 'bbox', x0, y0, x1, y1, 'lod', lodIdx, 'angle', aRay.toString(16));
      }
      for (const [pix, [col, depth, isCrowd]] of tmp) {
        if (depth > tdepth[pix] * 1.0005) continue;
        // objects come in the game's order (far to near): a later one wins over an
        // earlier one at about the same depth (decal objects such as window bands)
        if (!painter && depth > objDepth[pix] * HYBRID) continue;
        objDepth[pix] = depth; objCol[pix] = col; crowdPix[pix] = isCrowd ? 1 : 0;
      }
      counts.drawn++;
    }
  } else {
    const m = buildSectorMesh({ ...objs, placements: keep }, { indexed: true, crowd: crowd.active, set: 'all' });
    const camFine = { x: cam.x8 * 8, y: cam.y8 * 8, heading: camYaw };
    const fr = frameObjects(m, camFine, { lod: true });
    counts.drawn = m.placements.length;
    for (const p of keep) counts.shapes.add(p.shape);
    const atlas = buildSpriteAtlas(objs, fr.sprites.map((q) => q.id));
    const quads = spriteQuads(m.sprites, atlas, camFine, objs, m.origin, fr.sprites, m.placements);
    const crowdV = new Set(fr.crowd);
    const objLevel = m.objects.map((ob) => {
      const v = toCam(cam, [ob.x + m.origin[0], ob.y + m.origin[1], ob.z]);
      return hazeLevel(Math.max(Math.floor(v[1]), ob.size >> 3));
    });
    const lvlBuf = new Int8Array(W * HGT).fill(-1);
    const plot = (pix, col, depth, bias = 0, lvl = -1) => {
      const d = depth * (1 - bias);
      if (depth > tdepth[pix] * 1.0005 || d >= objDepth[pix]) return;
      objDepth[pix] = d; objCol[pix] = col; crowdPix[pix] = col === -2 ? 1 : 0; lvlBuf[pix] = lvl;
    };
    const project = (v) => {
      if (mode === 'mesh') return [160 + (256 * v[0]) / v[1], cam.top + cam.horizon - (v[2] * K) / v[1], 1 / v[1]];
      const g = projGame(cam, v, v[1] < 2000);
      return [g[0], g[1] + cam.top, 1 / v[1]];
    };
    const D = m.data, o = m.origin;
    fr.layers.forEach((idx, layer) => {
      for (let t = 0; t < idx.length; t += 3) {
        const c = clipNear([0, 1, 2].map((k) => { const q = idx[t + k] * 6; return toCam(cam, [D[q] + o[0], D[q + 1] + o[1], D[q + 2]]); }));
        if (c.length < 3) continue;
        const isCrowd = crowdV.has(idx[t]);
        const col = D[idx[t] * 6 + 3], lvl = objLevel[m.vertexObject[idx[t]]];
        const scr = c.map(project);
        if (screenArea(scr) >= 0) continue; // back face: the mesh's front faces run anticlockwise (y down)
        fillPoly(scr, cam.top, cam.top + cam.rows, (x, y, d) => plot(y * W + x, isCrowd ? -2 : col, d, 0.0015 * layer, lvl));
        counts.polys++;
      }
    });
    for (let li = 0; li < fr.lines.length; li += 2) {
      const v = fr.lines[li] * 6;
      const va = toCam(cam, [m.lines[v] + o[0], m.lines[v + 1] + o[1], m.lines[v + 2]]);
      const vb = toCam(cam, [m.lines[v + 6] + o[0], m.lines[v + 7] + o[1], m.lines[v + 8]]);
      if (va[1] < NEAR || vb[1] < NEAR) continue;
      const pa = projGame(cam, va), pb = projGame(cam, vb);
      if (pa[0] < 0 || pa[0] >= W) continue;
      for (let y = Math.max(0, Math.min(pa[1], pb[1])); y <= Math.min(cam.rows - 1, Math.max(pa[1], pb[1]) - 1); y++) {
        plot((y + cam.top) * W + pa[0], m.lines[v + 3], va[1], 0, objLevel[m.lineObject[v / 6]]);
      }
      counts.lines++;
    }
    if (mode === 'meshr') {
      for (const f of fr.sprites) {
        const sp = f.centre !== undefined ? { at: m.placements[f.centre].centre, palette: m.placements[f.centre].palette } : m.sprites[f.sprite];
        const v = toCam(cam, [sp.at[0] + o[0], sp.at[1] + o[1], sp.at[2]]);
        if (v[1] < NEAR) continue;
        const [sx, sy] = projGame(cam, v, v[1] < 2000);
        const lvl = hazeLevel(Math.floor(v[1]));
        const r = atlas.rects.get(f.id);
        const bias = f.centre !== undefined || !sp.onPolygons || !r ? 0 : (r.w * (r.size / 32)) / 2 / 8;
        drawSprite(objs, objs.sprite(f.id), f.id, sx, sy, Math.floor(v[1]), f.mirrored, (k) => objs.palettes[(sp.palette + k) & 0xffff],
          (x, y, col) => { if (y < cam.rows) plot((y + cam.top) * W + x, col, Math.max(v[1] - bias, 1), 0, lvl); }, cam.rows);
        counts.sprites++;
      }
    } else {
      // camera-facing quads textured from the atlas
      for (let q = 0; q < quads.length; q += 42) {
        const V = [0, 1, 2, 5].map((k) => { const b = q + k * 7; return { p: toCam(cam, [quads[b] + o[0], quads[b + 1] + o[1], quads[b + 2]]), u: quads[b + 3], v: quads[b + 4] }; });
        if (V[0].p[1] < NEAR) continue;
        const palOff = quads[q + 5], bias = quads[q + 6] / 8;
        const scr = V.map((w) => [160 + (256 * w.p[0]) / w.p[1], cam.top + cam.horizon - (w.p[2] * K) / w.p[1]]);
        const xa = scr[0][0], xb = scr[1][0], ya = scr[0][1], yb = scr[2][1];
        const x0 = Math.max(0, Math.ceil(Math.min(xa, xb) - 0.5)), x1 = Math.min(W - 1, Math.floor(Math.max(xa, xb) - 0.5));
        const y0 = Math.max(cam.top, Math.ceil(Math.min(ya, yb) - 0.5)), y1 = Math.min(cam.top + cam.rows - 1, Math.floor(Math.max(ya, yb) - 0.5));
        const lvl = hazeLevel(Math.floor(V[0].p[1]));
        for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
          const u = V[0].u + ((x + 0.5 - xa) / (xb - xa)) * (V[1].u - V[0].u);
          const v = V[0].v + ((y + 0.5 - ya) / (yb - ya)) * (V[2].v - V[0].v);
          const code = atlas.data[Math.floor(v) * atlas.width + Math.floor(u)];
          if (code === 255 || code === undefined) continue;
          plot(y * W + x, objs.palettes[(palOff + code) & 0xffff], Math.max(V[0].p[1] - bias, 1), 0, lvl);
        }
        counts.sprites++;
      }
    }
    // haze per object (sprites: by their own depth); crowd as a pattern from the strip
    for (let pix = 0; pix < W * HGT; pix++) {
      if (objCol[pix] === -1) continue;
      if (objCol[pix] === -2) { objCol[pix] = crowd.active ? crowd.strips[0][(pix * 7919) & 0x1ff] : crowd.practiceColour; continue; }
      objCol[pix] = hazed(objCol[pix], lvlBuf[pix] >= 0 ? lvlBuf[pix] : 0);
    }
  }

  // ---- compose, compare
  const ours = base.slice();
  const mask = new Uint8Array(W * HGT);
  for (let pix = 0; pix < W * HGT; pix++) if (objCol[pix] >= 0) { const c = rgb(objCol[pix]); ours.set([c[0], c[1], c[2], 255], pix * 4); mask[pix] = 1; }
  // left out: what the game draws over the 3D view (the PAUSED sign, the
  // banners in the top rows) and the cars (Phase 3), as boxes of 17 x 8 x 4.5 ft
  const carMask = new Uint8Array(W * HGT);
  for (const car of st.cars) {
    if (car.pos === 'none' || !car.visible) continue;
    if (st.view.mode === 'cockpit' && car.slot === st.view.viewedSlot) continue; // the camera's own car
    const ang = (car.heading / 65536) * 2 * Math.PI, sn = Math.sin(ang), cs = Math.cos(ang);
    const L = 8.5 * 64, Wd = 4 * 64, Ht = 4.5 * 64, cx = car.x / 256, cy = car.y / 256, cz = car.z;
    const C = [];
    for (const f of [-L, L]) for (const r of [-Wd, Wd]) for (const z of [0, Ht]) C.push(toCam(cam, [cx + f * sn + r * cs, cy + f * cs - r * sn, cz + z]));
    let x0 = 999, x1 = -999, y0 = 999, y1 = -999;
    for (const f of [[0, 1, 3, 2], [4, 5, 7, 6], [0, 1, 5, 4], [2, 3, 7, 6], [0, 2, 6, 4], [1, 3, 7, 5]]) {
      for (const v of clipNear(f.map((i) => C[i]))) {
        const sx = 160 + (256 * v[0]) / v[1], sy = cam.top + cam.horizon - (v[2] * K) / v[1];
        x0 = Math.min(x0, sx); x1 = Math.max(x1, sx); y0 = Math.min(y0, sy); y1 = Math.max(y1, sy);
      }
    }
    for (let y = Math.max(0, Math.floor(y0) - 1); y <= Math.min(HGT - 1, Math.ceil(y1) + 1); y++)
      for (let x = Math.max(0, Math.floor(x0) - 1); x <= Math.min(W - 1, Math.ceil(x1) + 1); x++) carMask[y * W + x] = 1;
  }
  const masked = (x, y) => (y >= 50 && y < 72 && x >= 124 && x < 196) || y < 24 || carMask[y * W + x];
  let objPix = 0, objSame = 0, trackWrong = 0, fixed = 0, broke = 0, crowdN = 0;
  const diff = new Uint8Array(W * HGT * 4), mpng = new Uint8Array(W * HGT * 4);
  for (let y = 0; y < HGT; y++) for (let x = 0; x < W; x++) { const o = (y * W + x) * 4; diff.set([255, 255, 255, 255], o); mpng.set([255, 255, 255, 255], o); }
  for (let y = cam.top; y < cam.top + cam.rows; y++) for (let x = 0; x < W; x++) {
    const pix = y * W + x, o = pix * 4;
    if (masked(x, y)) { diff.set([60, 60, 60, 255], o); mpng.set([60, 60, 60, 255], o); continue; }
    const eq = (img) => img[o] === game.data[o] && img[o + 1] === game.data[o + 1] && img[o + 2] === game.data[o + 2];
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
  const result = {
    view: st.view.mode, mode, detail, camSeg: walk.camNr, reverse: walk.reverse, nAhead: walk.nAhead,
    placed: counts.placed, drawn: counts.drawn, polys: counts.polys, crowdPolys: counts.crowdPolys, sprites: counts.sprites, lines: counts.lines,
    shapes: [...counts.shapes].sort((u, v) => u - v),
    objectPixels: objPix, objectSame: objSame, objectSamePct: +(100 * objSame / Math.max(objPix, 1)).toFixed(1), crowdPixels: crowdN,
    trackOnlyWrong: trackWrong, fixedByObjects: fixed, fixedPct: +(100 * fixed / Math.max(trackWrong, 1)).toFixed(1), brokeTrack: broke,
  };
  return { result, sheet };
}
