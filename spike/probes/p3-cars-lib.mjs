// Shared code of the car checks (probes/p3-cars-check.mjs): draw one game
// frame at 320x200 with the game's projection - the track (scene.mjs), the
// trackside objects (objects.mjs, game rules as probes/p2-objects-lib.mjs)
// and the cars (lib/cars.mjs) - and compare with the game's screenshot
// inside the pixels our cars cover.
//
// Car modes:
//   'game'  - the cars as the game draws them (renderer-notes, "Cars"): the
//             game's car selection and order (0F47:A533, by segment key among
//             the objects), the polygon LOD up to 52 ft with the view sector's
//             display list in its order (later elements paint over earlier
//             ones), one-sided polygons, the partner-depth test, wheels and
//             helmet framed by view angle and steering, the bitmap LOD beyond,
//             attached effect shapes, per-car haze, the game's integer
//             projection and bitmap scaling. Against the track: a depth test
//             with a tolerance (the road under a car never hides it).
//   'mesh'  - what lib/cars.mjs frameCars gives a WebGL renderer: triangles
//             with a depth buffer, bitmaps as quads with a depth bias, drawn
//             with the game's integer projection and bitmap scaling (so the
//             comparison checks the mesh data, not GPU rasterisation).

import { readScene, buildSceneMesh, horizonOff } from '../lib/scene.mjs';
import { cameraFromState, renderMesh } from '../lib/soft-render.mjs';
import {
  readObjects, readCrowd, CROWD_COLOUR, shapePoints, polygonLoop, worldPoint, spriteLodFrame, shownAtDetail, hazeLevel,
} from '../lib/objects.mjs';
import { readCars, carStates, selectCars, carParts, frameCars, mirrorImage, mirrorClip, gameCamera, gameProject } from '../lib/cars.mjs';
import { W, HGT, NEAR, toCam, projGame, clipNear, fillPoly, screenArea, drawSprite, walkOf } from './p2-objects-lib.mjs';

const K = ((0x6e80 * 2) / 65536) * 32;

function trackDepth(data, origin, cam, first = 0, count = data.length / 6) {
  const depth = new Float32Array(W * HGT).fill(Infinity);
  for (let i = first * 6; i < (first + count) * 6; i += 18) {
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

/**
 * Draw one frame.
 * @param {object} a { mem, st (readState: camera and cars of the frame on screen), detail, carMode: 'game'|'mesh'|'none',
 *                     carTol (fraction: a car pixel is hidden by the track only when the track is this much nearer, default 0.03) }
 * @returns {{ ours, noCars (RGBA), carSlot: Int16Array (slot + 1 per pixel), carKind: Uint8Array (1 polygon LOD, 2 bitmap LOD, 3 effect),
 *             cars: object[] (per drawn car: slot, kind, depth8, box), cam, sel }}
 */
export function drawFrame(a) {
  const { mem, st } = a;
  const carMode = a.carMode ?? 'game';
  const cam = { ...cameraFromState(st), vscale: mem.ss.u16(0x017c) };
  const scene = readScene(mem);
  const mesh = buildSceneMesh(scene);
  const pal = scene.palette;
  const rgb = (i) => [pal[i * 3], pal[i * 3 + 1], pal[i * 3 + 2]];
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

  // ---- trackside objects, game rules (as probes/p2-objects-lib.mjs, mode 'game')
  const objs = readObjects(mem);
  const crowd = readCrowd(mem);
  const detail = a.detail ?? mem.ds.u8(0x0068);
  const camYaw = st.camera.heading & 0xffff;
  const hazed = (c, lvl) => (lvl > 0 && objs.haze ? objs.haze[(lvl - 1) * 256 + c] : c);
  const walk = walkOf(mem, scene, st, true);
  const lapN = scene.lap.length;
  const keep = objs.placements.filter((p) => walk.ok(p) && shownAtDetail(p, detail));
  const objKey = (p) => {
    const sg = p.segment % lapN;
    let ahead = walk.reverse ? ((walk.camNr - sg) % lapN + lapN) % lapN : ((sg - walk.camNr) % lapN + lapN) % lapN;
    if (ahead > lapN / 2) ahead -= lapN;
    const s = objs.settings[p.setting];
    const shift = ((s.range >> 8) & 0x3f) + Math.max(s.range & 0xff, 2) - 2;
    return { key: ahead + (s.flags & 0x80 ? -shift : shift), later: (s.flags & 0x80) !== 0 };
  };
  const atan = (k) => mem.ss.u16(0x5268 + 16 * k);
  const ray = (xs) => { const d = xs - 160, k = Math.min(Math.abs(d), 255); return d < 0 ? atan(k) : -atan(k); };
  const items = [];
  for (const p of keep) {
    const { key, later } = objKey(p);
    items.push({ kind: 'object', p, key, list: later ? 0 : 1 });
  }

  // ---- cars
  const cars = readCars(mem);
  // ablations (evidence that a decoded rule matters): a.ablate = 'wobble' | 'steer' | 'alt' | 'float' | 'order'
  const states = carStates(cars, st).map((c) => {
    if (a.ablate === 'wobble') return { ...c, yaw: c.heading };
    if (a.ablate === 'steer') return { ...c, steer: 0 };
    if (a.ablate === 'alt') return { ...c, alt: false };
    if (a.ablate === 'helmet') return { ...c, helmet: c.palette };
    return c;
  });
  const sel = selectCars(cars, states);
  const camC = { x: st.camera.x >> 8, y: st.camera.y >> 8, z: st.camera.z, heading: camYaw, mode: st.view.mode };
  if (carMode !== 'none') for (const e of sel.drawn) items.push({ kind: 'car', e, key: e.key, list: 0 });
  // far to near; at equal keys the "later" list (cars, objects with setting +1 bit 7) first
  if (a.ablate === 'order') items.sort((u, v) => (u.kind === 'car' ? 1 : 0) - (v.kind === 'car' ? 1 : 0) || v.key - u.key);
  else items.sort((u, v) => v.key - u.key || u.list - v.list || (v.e?.ahead ?? 0) - (u.e?.ahead ?? 0));

  const objCol = new Int16Array(W * HGT).fill(-1);
  const objDepth = new Float32Array(W * HGT).fill(Infinity);
  const carSlot = new Int16Array(W * HGT);
  const carKind = new Uint8Array(W * HGT);
  const carTol = 1 - (a.carTol ?? 0.03);
  const HYBRID = 1.005;
  const carInfo = [];
  const mirrors = [];
  const clip = mirrorClip(cars);

  const drawObject = (p) => {
    const shape = objs.shapeAt(p);
    if (!shape) return;
    const vc = toCam(cam, [p.x, p.y, p.z + shape.z14]);
    const hi = Math.abs(p.x - cam.x8 * 8) + shape.size < 0x3e80 && Math.abs(p.y - cam.y8 * 8) + shape.size < 0x3e80;
    const d8 = vc[1];
    const xc = d8 < NEAR ? (vc[0] < 0 ? 0 : 0x140) : projGame(cam, vc, hi)[0];
    const r42 = (p.yaw - camYaw) & 0xffff;
    const aRay = (r42 + ray(xc)) & 0xffff;
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
    };
    if (lod.sprite) {
      if (d8 < NEAR) return;
      const f = spriteLodFrame(lod, aRay);
      if (!f) return;
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
          if (screenArea(scr) <= 0) continue;
          const col = hazed(palOf(el.colour), lvl);
          if (col === CROWD_COLOUR) {
            const spans = new Map();
            fillPoly(scr, cam.top, cam.top + cam.rows, (x, y, d) => { if (!spans.has(y)) spans.set(y, []); spans.get(y).push([x, d]); });
            let k = 0, end = 0;
            const strip = crowd.strips[lvl];
            for (const y of [...spans.keys()].sort((u, v) => v - u)) {
              const row = spans.get(y).sort((u, v) => u[0] - v[0]);
              k = (k + 1) & 63;
              const off = (crowd.rows[k] + end) & 0x1ff;
              row.forEach(([x, d], i) => tmp.set(y * W + x, [crowd.active ? strip[off + i] : crowd.practiceColour, d]));
              end = off + row.length;
            }
          } else fillPoly(scr, cam.top, cam.top + cam.rows, (x, y, d) => tmp.set(y * W + x, [col, d]));
        } else if (el.kind === 'line') {
          const [ia, ib] = shape.vector(el.vector);
          const va = cp[ia], vb = cp[ib];
          if (va[1] < NEAR || vb[1] < NEAR) continue;
          const pa = projGame(cam, va, hi), pb = projGame(cam, vb, hi);
          if (pa[0] < 0 || pa[0] >= W) continue;
          const ya = Math.max(0, Math.min(pa[1], cam.rows - 1)), yb = Math.max(0, Math.min(pb[1] - 1, cam.rows - 1));
          for (let y = Math.min(ya, yb); y <= Math.max(ya, yb); y++) put(pa[0], y, hazed(palOf(0), lvl), va[1]);
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
    for (const [pix, [col, depth]] of tmp) {
      if (depth > tdepth[pix] * 1.0005) continue;
      if (depth > objDepth[pix] * HYBRID) continue;
      objDepth[pix] = depth; objCol[pix] = col; carSlot[pix] = 0; carKind[pix] = 0;
    }
  };

  // one car (and its effect shapes), game rules: painter's order inside the car
  const gc = gameCamera(cars);
  const drawCarGame = (e) => {
    const c = e.state;
    const cp = carParts(cars, c, camC, { game: a.ablate === 'float' ? null : gc, cameraObject: st.view.mode === 'cockpit' && c.slot === st.view.viewedSlot });
    const tmp = new Map();
    const info = { slot: c.slot, number: c.number, team: c.team, key: e.key, parts: [] };
    for (const part of cp.parts) {
      info.parts.push({ what: part.what, kind: part.kind, depth8: part.depth8, sector: part.sector, reason: part.reason });
      if (part.kind === 'mirror') {
        const m = mirrorImage(cars, c, camC, gc);
        if (!m) continue;
        mirrors.push({ slot: c.slot, ...m });
        // the far bitmap, anchor at row 123, clipped to the mirror outlines
        const spr = cars.sprite(m.id), lvl = hazeLevel(m.depth8);
        drawSprite(cars, spr, m.id, m.x, 123, m.depth8, m.mirrored, (k) => hazed(cars.palettes[(m.palette + k) & 0xffff], lvl), (x, y, col) => {
          const cl = clip[y - 116];
          if (!cl || !cl.active || x < cl.left || x >= cl.right || (x >= cl.gapLeft && x < cl.gapRight)) return;
          tmp.set(y * W + x, [col, 0, 4]);
        }, 138);
        continue;
      }
      if (part.kind === 'none') continue;
      const kindCode = part.what !== 'car' ? 3 : part.kind === 'bitmap' ? 2 : 1;
      const near = part.near, k = near ? 8 : 1;
      const put = (x, y, col, depth) => { if (x < 0 || x >= W || y < 0 || y >= cam.rows) return; tmp.set((y + cam.top) * W + x, [col, depth, kindCode]); };
      for (const el of part.elements) {
        if (el.kind === 'poly') {
          const g = el.g;
          let scr;
          if (g.every((p) => p.dep >= 8)) scr = g.map((p, i) => [el.cols[i], gameProject(gc, p, near)[1] + cam.top, k / p.dep]);
          else {
            // clip against the near plane (dep = 8) in camera space, then project
            const out = [];
            for (let i = 0; i < g.length; i++) {
              const p = g[i], q = g[(i + 1) % g.length];
              if (p.dep >= 8) out.push(p);
              if ((p.dep >= 8) !== (q.dep >= 8)) { const t = (8 - p.dep) / (q.dep - p.dep); out.push({ lat: p.lat + (q.lat - p.lat) * t, dep: 8, dz: p.dz + (q.dz - p.dz) * t }); }
            }
            if (out.length < 3) continue;
            scr = out.map((p) => { const [x, y] = gameProject(gc, { lat: Math.trunc(p.lat), dep: p.dep, dz: Math.trunc(p.dz) }, near); return [x, y + cam.top, k / p.dep]; });
          }
          if (screenArea(scr) <= 0) continue;
          const col = hazed(el.colour, part.haze);
          fillPoly(scr, cam.top, cam.top + cam.rows, (x, y, d) => tmp.set(y * W + x, [col, d, kindCode]));
        } else if (el.kind === 'bitmap') {
          const g = el.g;
          if (g.dep < 8) continue;
          const sy = gameProject(gc, g, near)[1];
          const sx = el.col ?? gameProject(gc, g, near)[0];
          const spr = cars.sprite(el.id);
          const D8 = Math.floor(g.dep / k);
          const lvl = hazeLevel(D8);
          drawSprite(cars, spr, el.id, sx, sy, D8, el.mirrored, (kk) => hazed(cars.palettes[(el.palette + kk) & 0xffff], lvl), (x, y, col) => put(x, y, col, g.dep / k), cam.rows);
        }
      }
    }
    let x0 = W, x1 = -1, y0 = HGT, y1 = -1, n = 0;
    for (const [pix, [col, depth, kind]] of tmp) {
      if (kind !== 4 && tdepth[pix] < depth * carTol) continue; // the track (or a crest) is clearly nearer
      objDepth[pix] = depth; objCol[pix] = col; carSlot[pix] = c.slot + 1; carKind[pix] = kind;
      const x = pix % W, y = (pix / W) | 0;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      n++;
    }
    info.box = n ? [x0, y0, x1, y1] : null;
    info.pixels = n;
    info.kind = cp.parts.find((p) => p.what === 'car')?.kind;
    info.depth8 = cp.parts.find((p) => p.what === 'car')?.depth8;
    carInfo.push(info);
  };

  for (const it of items) {
    if (it.kind === 'object') drawObject(it.p);
    else if (carMode === 'game') drawCarGame(it.e);
  }
  if (carMode === 'mesh') drawCarsMesh({ cars, st, cam, camC, tdepth, objCol, objDepth, carSlot, carKind, carInfo, carTol, hazed });

  // ---- compose
  const noCars = base.slice();
  const ours = base.slice();
  for (let pix = 0; pix < W * HGT; pix++) {
    if (objCol[pix] < 0) continue;
    const c = rgb(objCol[pix]);
    ours.set([c[0], c[1], c[2], 255], pix * 4);
  }
  // the same without cars (for the 'before' figures): objects only
  return { ours, noCars, carSlot, carKind, cars: carInfo, cam, sel, mirrors, pal, base, objCol };
}

// the cars from frameCars (WebGL data): triangles with a depth buffer, bitmaps
// with their depth bias, placed with the game's integer projection
function drawCarsMesh({ cars, st, cam, camC, tdepth, objCol, objDepth, carSlot, carKind, carInfo, carTol, hazed }) {
  const { mesh, frame, list } = frameCars(cars, st, camC, { indexed: true, wheelBias: +(process.env.WHEEL_BIAS ?? 0.25) });
  const o = mesh.origin, D = mesh.data;
  const zb = new Float32Array(W * HGT).fill(Infinity);
  const col = new Int16Array(W * HGT).fill(-1), who = new Int16Array(W * HGT), kind = new Uint8Array(W * HGT);
  const objOf = (oi) => mesh.objects[oi];
  frame.layers.forEach((idx, layer) => {
    for (let t = 0; t < idx.length; t += 3) {
      const c3 = clipNear([0, 1, 2].map((k) => { const q = idx[t + k] * 6; return toCam(cam, [D[q] + o[0], D[q + 1] + o[1], D[q + 2]]); }));
      if (c3.length < 3) continue;
      const ob = objOf(mesh.vertexObject[idx[t]]);
      const hi = c3.every((v) => v[1] < 2000);
      const scr = c3.map((v) => { const g = projGame(cam, v, hi); return [g[0], g[1] + cam.top, 1 / v[1]]; });
      if (screenArea(scr) >= 0) continue; // the mesh's front faces run anticlockwise (y down)
      const c = hazed(D[idx[t] * 6 + 3], ob.haze);
      fillPoly(scr, cam.top, cam.top + cam.rows, (x, y, d) => {
        const p = y * W + x, dd = d * (1 - 0.0015 * layer);
        if (dd >= zb[p]) return;
        zb[p] = dd; col[p] = c; who[p] = ob.slot + 1; kind[p] = ob.what === 'car' ? 1 : 3;
      });
    }
  });
  for (const f of frame.sprites) {
    const s = mesh.sprites[f.sprite];
    const v = toCam(cam, [s.at[0] + o[0], s.at[1] + o[1], s.at[2]]);
    if (v[1] < NEAR) continue;
    const hi = v[1] < 2000;
    const [sx, sy] = projGame(cam, v, hi);
    const D8 = Math.floor(v[1]);
    const lvl = hazeLevel(D8);
    const dz = Math.max(v[1] - s.bias / 8, 1);
    const k = s.what === 'far' ? 2 : s.what === 'car' ? 1 : (objOf(s.object).what === 'car' ? 1 : 3);
    drawSprite(cars, cars.sprite(f.id), f.id, sx, sy, D8, f.mirrored, (c) => hazed(cars.palettes[(s.palette + c) & 0xffff], lvl), (x, y, c) => {
      if (y >= cam.rows) return;
      const p = (y + cam.top) * W + x;
      if (dz >= zb[p]) return;
      zb[p] = dz; col[p] = c; who[p] = s.slot + 1; kind[p] = k;
    }, cam.rows);
  }
  for (let p = 0; p < W * HGT; p++) {
    if (col[p] < 0) continue;
    if (tdepth[p] < zb[p] * carTol) continue;
    if (objDepth[p] < zb[p] * 0.995) continue;
    objCol[p] = col[p]; objDepth[p] = zb[p]; carSlot[p] = who[p]; carKind[p] = kind[p];
  }
  for (const l of list) {
    const part = l.parts.find((q) => q.what === 'car');
    carInfo.push({ slot: l.slot, key: l.key, kind: part?.kind, depth8: part?.depth8 });
  }
}

/**
 * Compare with the game's frame inside our car pixels (and, for the recall
 * side, inside each car's box). Masked: rows above 24 (banner), the PAUSED
 * sign, outside the 3D view.
 * @returns {{ near: {px, same}, far: {px, same}, effect: {px, same}, box: {px, sameWith, sameWithout}, perCar }}
 */
export function compareCars(game, fr, opt = {}) {
  const { ours, carSlot, carKind, cam } = fr;
  const masked = (x, y, k) => k !== 4 && ((y >= 50 && y < 72 && x >= 124 && x < 196) || y < 24 || y < cam.top || y >= cam.top + cam.rows);
  const eq = (img, o) => img[o] === game.data[o] && img[o + 1] === game.data[o + 1] && img[o + 2] === game.data[o + 2];
  const res = { near: { px: 0, same: 0 }, far: { px: 0, same: 0 }, effect: { px: 0, same: 0 }, mirror: { px: 0, same: 0 }, box: { px: 0, sameWith: 0, sameWithout: 0 }, perCar: [] };
  const per = new Map();
  for (let y = 0; y < HGT; y++) for (let x = 0; x < W; x++) {
    const pix = y * W + x;
    if (!carSlot[pix] || masked(x, y, carKind[pix])) continue;
    const o = pix * 4, same = eq(ours, o);
    const bucket = carKind[pix] === 1 ? res.near : carKind[pix] === 2 ? res.far : carKind[pix] === 4 ? res.mirror : res.effect;
    bucket.px++; if (same) bucket.same++;
    const s = carSlot[pix] - 1;
    if (!per.has(s)) per.set(s, { slot: s, px: 0, same: 0, kind: carKind[pix] });
    const q = per.get(s); q.px++; if (same) q.same++;
  }
  // box check: each car's box grown by 2 px: our full frame with cars vs without
  const inBox = new Uint8Array(W * HGT);
  for (const c of fr.cars) {
    if (!c.box) continue;
    const [x0, y0, x1, y1] = c.box;
    for (let y = Math.max(0, y0 - 2); y <= Math.min(HGT - 1, y1 + 2); y++) for (let x = Math.max(0, x0 - 2); x <= Math.min(W - 1, x1 + 2); x++) inBox[y * W + x] = 1;
  }
  const without = opt.without;
  for (let pix = 0; pix < W * HGT; pix++) {
    const x = pix % W, y = (pix / W) | 0;
    if (!inBox[pix] || masked(x, y, 0)) continue;
    res.box.px++;
    if (eq(ours, pix * 4)) res.box.sameWith++;
    if (without && eq(without, pix * 4)) res.box.sameWithout++;
  }
  // possibly missing car pixels: outside our cars, the game shows a colour that
  // our cars use somewhere in this frame and that nothing else of ours uses
  const key = (img, o) => (img[o] << 16) | (img[o + 1] << 8) | img[o + 2];
  const carCols = new Set(), bgCols = new Set();
  for (let pix = 0; pix < W * HGT; pix++) (carSlot[pix] ? carCols : bgCols).add(key(ours, pix * 4));
  for (const c of [...carCols]) if (bgCols.has(c)) carCols.delete(c);
  res.unexplained = 0;
  for (let pix = 0; pix < W * HGT; pix++) {
    const x = pix % W, y = (pix / W) | 0;
    if (carSlot[pix] || masked(x, y, 0)) continue;
    const o = pix * 4;
    if (!eq(ours, o) && carCols.has(key(game.data, o))) res.unexplained++;
  }
  res.perCar = [...per.values()].map((q) => ({ ...q, pct: +(100 * q.same / q.px).toFixed(1), ...(fr.cars.find((c) => c.slot === q.slot) ?? {}) }));
  return res;
}

/** game | ours | diff (red: differs inside our cars, dark red elsewhere) | car mask (white same, red different; blue = far bitmap, green = effect) */
export function sheet(game, fr, opt = {}) {
  const { ours, carSlot, carKind, cam } = fr;
  const out = new Uint8Array(1280 * 200 * 4);
  for (let y = 0; y < 200; y++) for (let x = 0; x < 320; x++) {
    const pix = y * W + x, o = pix * 4;
    const put = (k, c) => out.set(c, (y * 1280 + k * 320 + x) * 4);
    put(0, [game.data[o], game.data[o + 1], game.data[o + 2], 255]);
    put(1, [ours[o], ours[o + 1], ours[o + 2], 255]);
    const same = ours[o] === game.data[o] && ours[o + 1] === game.data[o + 1] && ours[o + 2] === game.data[o + 2];
    const in3d = y >= cam.top && y < cam.top + cam.rows;
    put(2, !in3d ? [60, 60, 60, 255] : same ? [0, 0, 0, 255] : carSlot[pix] ? [255, 0, 0, 255] : [110, 0, 0, 255]);
    if (!carSlot[pix]) put(3, [0, 0, 0, 255]);
    else if (carKind[pix] === 2) put(3, same ? [120, 160, 255, 255] : [255, 0, 255, 255]);
    else if (carKind[pix] === 3) put(3, same ? [120, 255, 120, 255] : [255, 160, 0, 255]);
    else if (carKind[pix] === 4) put(3, same ? [255, 255, 120, 255] : [255, 0, 160, 255]);
    else put(3, same ? [255, 255, 255, 255] : [255, 0, 0, 255]);
  }
  return out;
}

export { readCars, carStates, selectCars };
