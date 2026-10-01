// Trackside objects (stands, pit buildings, bridges, trees, signs) as the game
// draws them, read from the game's memory, and turned into coloured
// triangles, lines and sprites for the WebGL renderer.
//
// Every rule here is from docs/renderer-notes.md, section "Objects: shapes and
// placement (decoded)" (gp.exe 0F47:9E2A places an object, 0F47:88A5 draws a
// shape, 0F47:19E8 draws a scaled bitmap).
//
// Units as in scene.mjs: X/Y in fine units (1/64 ft), Z in the game's Z units
// (1/64 ft). Shape coordinates are fine units too. Angles: 10000h = one turn,
// heading 0 = +Y, 4000h = +X.
//
// Plain ES module, no Node APIs: runs in Node and in the browser.

const SEG_SIZE = 0x2e;

// Game DS / SS offsets
const DS_SETTINGS = 0x023a;    // far pointer to the object settings (16-byte records)
const DS_SHAPES = 0x358d;      // shape table: 4-byte far pointers, ids 0-16 built in, 17.. from the track file
const DS_TRACK = 0x879f, DS_PIT = 0x8797;
const SS_LAP_END = 0x015c;
const SS_PALETTES = 0x2964;    // 16-colour object palettes; setting +2 is an offset into this table
const PALETTE_BYTES = 0x900;
const SS_COS = 0x3264;         // cosine table, 4097 words, 1/8-unit steps, 4000h = 1.0
const SS_SPRITE_SEG = 0x00f8;  // segment of the bitmap (sprite) store; table of far pointers at +0238
const SPRITE_TABLE = 0x0238;
const SS_VSCALE = 0x017c, SS_SPRITE_VSCALE = 0x017e;
const HAZE_SEG_REL = 0x7bce, HAZE_OFF = 0x7bc0; // four 256-byte haze tables (relative segment)

// Settings handled elsewhere by the renderer, not by the shape drawer:
// 0 and 1 run a second scene pass (0F47:9C05, the pit lane); 2 is a flag
// marshal whose side comes from a run-time table (DS:0B9C) by segment number.
const SPECIAL_SETTINGS = new Set([0, 1, 2]);

const s8 = (v) => (v << 24) >> 24;
const s16 = (v) => (v << 16) >> 16;

/**
 * Reader over guest memory with an optional overlay of patched bytes (linear
 * address -> byte). H is the bytes, or a function returning them (the
 * emulator's heap can be replaced when it grows).
 */
export function makeReader(H, B = 0, overlay = null) { return reader(H, B, overlay); }
function reader(H, B, overlay) {
  const get = typeof H === 'function' ? H : () => H;
  const raw = (a) => get()[B + a];
  const u8 = overlay && overlay.size ? (a) => (overlay.has(a) ? overlay.get(a) : raw(a)) : raw;
  const u16 = (a) => u8(a) | (u8(a + 1) << 8);
  return { u8, u16, s16: (a) => s16(u16(a)), s8: (a) => s8(u8(a)), far: (a) => (u16(a + 2) << 4) + u16(a) };
}

/** The game's cosine (0F47 code: index = |a as signed| >> 3, no interpolation), 4000h = 1.0. */
export function makeTrig(cosTable) {
  const cos = (a) => { let v = s16(a & 0xffff); if (v < 0) v = -v; return cosTable[(v & 0xffff) >> 3]; };
  return { cos, sin: (a) => cos(0x4000 - a) };
}

// ------------------------------------------------------------------ shapes

/**
 * Decode one shape from memory. `ptr` is its linear address; `override` is
 * the setting's scale override (SS:0168, from setting +8) or 0.
 * Returns null for a missing or broken shape.
 */
export function decodeShape(rd, ptr, override = 0) {
  if (!ptr) return null;
  const size = rd.u16(ptr);
  const z12 = rd.s16(ptr + 0x12), z14 = rd.s16(ptr + 0x14);
  const lods = [];
  for (let q = ptr + 0x16; lods.length < 8; q += 10) {
    const max = rd.u16(q), mask = rd.u16(q + 2), shift = rd.u16(q + 4);
    lods.push({ max, mask, shift, list: rd.far(q + 6), sprite: !(mask & 0x8000) });
    if (max >= 0x7fff) break;
  }
  const shape = { ptr, size, z12, z14, lods };
  // sprite LODs: the frame entry for a folded view angle (0F47:9B74):
  // list + word[list + ((ax >> shift) & ~1)] -> { add, base, shift2 }
  for (const l of lods) {
    if (!l.sprite || l.shift & 0x8000) continue;
    l.frame = (ax) => {
      const e = l.list + rd.u16(l.list + ((ax >> (l.shift & 15)) & 0xfffe));
      return { add: rd.u16(e), base: rd.u16(e + 2), shift: rd.u16(e + 4) };
    };
  }
  if (lods.every((l) => l.sprite)) return shape; // drawn as a bitmap at the object's centre
  let scalePtr = rd.far(ptr + 2);
  const elemPtr = rd.far(ptr + 6), pointPtr = rd.far(ptr + 0x0a), vecPtr = rd.far(ptr + 0x0e);
  if (!(scalePtr && elemPtr && pointPtr && vecPtr)) return null;
  // scale override: low nibble k = 0 moves the scale pointer by v >> 3 bytes;
  // otherwise scale value k-1 = (v & FFF0h) >> 1 (0F47:8C52)
  const scaleOverride = {};
  if (override) {
    const k = override & 15;
    if (k === 0) scalePtr += override >> 3;
    else scaleOverride[k - 1] = (override & 0xfff0) >> 1;
  }
  const scaleAt = (i) => (i in scaleOverride ? scaleOverride[i] : rd.s16(scalePtr + 2 * i));
  // visibility list: point indices, ended by a byte with bit 7
  const vis = [];
  let q = elemPtr;
  while (!(rd.u8(q) & 0x80) && vis.length < 64) vis.push(rd.u8(q++));
  const elemBase = q + 1;
  shape.vis = vis;
  shape.elemBase = elemBase;
  shape.scaleAt = scaleAt;
  // points: {wx, wy, z, partner}; vectors: byte pairs; read on demand
  shape.rawPoint = (i) => ({ wx: rd.u16(pointPtr + 8 * i), wy: rd.u16(pointPtr + 8 * i + 2), z: rd.s16(pointPtr + 8 * i + 4), partner: rd.u16(pointPtr + 8 * i + 6) });
  shape.vector = (v) => [rd.u8(vecPtr + 2 * v), rd.u8(vecPtr + 2 * v + 1)];
  // display lists per LOD: one sub-list per view sector, of offsets into the elements
  for (const l of lods) {
    if (l.sprite) continue;
    const nd = ((0xffff >> l.shift) >> 1) + 1;
    l.dirs = [];
    for (let d = 0; d < nd; d++) {
      const sub = l.list + rd.u16(l.list + 2 * d), offs = [];
      for (let a = sub; offs.length < 256; a += 2) { const w = rd.u16(a); if (w & 0x8000) break; offs.push(w); }
      l.dirs.push(offs);
    }
  }
  // elements, by offset
  const elements = new Map();
  for (const l of lods) {
    if (l.sprite) continue;
    for (const o of l.dirs.flat()) if (!elements.has(o)) elements.set(o, decodeElement(rd, elemBase + o));
  }
  shape.elements = elements;
  return shape;
}

function decodeElement(rd, a) {
  const t = rd.u8(a++);
  if (!(t & 0x80)) {
    // filled polygon: colour (bit 6 = back-face test byte follows), signed vector indices, 0
    const edges = [];
    let v;
    while ((v = rd.s8(a++)) !== 0 && edges.length < 64) edges.push(v);
    const el = { kind: 'poly', colour: t & 0x3f, edges };
    if (t & 0x40) el.facePoint = rd.u8(a);
    return el;
  }
  if (t & 0x20) return { kind: 'line', type: t, colourByte: rd.u8(a), vector: rd.u8(a + 1) };
  const el = { kind: 'bitmap', type: t, point: rd.u8(a), maxDepth: rd.u8(a + 1) << 7, id: rd.u8(a + 2) };
  if (t & 2) el.palette = rd.u16(a + 3);
  return el;
}

/**
 * Point coordinates (shape units = fine units) for one LOD: the game packs the
 * scale values whose mask bit is set (bits 14..0, in order) into a table; a
 * point word w selects entry (w-2)/2 (positive) or (w-34)/2 (negative), 0 = 0.
 * Bit 15 of the first word: the point takes X/Y of point (w & 7FFFh) and its own Z.
 * @returns {{x:number,y:number,z:number,partner:number,ref:number}[]}
 */
export function shapePoints(shape, lod = shape.lods.find((l) => !l.sprite)) {
  const packed = [];
  for (let bit = 14, i = 0; bit >= 0; bit--, i++) if (lod.mask & (1 << bit)) packed.push(shape.scaleAt(i));
  const val = (w) => {
    if (w === 0) return 0;
    if (w >= 2 && w <= 32) return packed[(w - 2) >> 1] ?? 0;
    if (w >= 34 && w <= 64) return -(packed[(w - 34) >> 1] ?? 0);
    return 0;
  };
  // how many points: the highest index any element of any LOD uses
  let n = 0;
  const use = (i) => { if (i + 1 > n) n = i + 1; };
  for (const el of shape.elements.values()) {
    if (el.kind === 'poly') for (const e of el.edges) { const [a, b] = shape.vector(Math.abs(e)); use(a); use(b); }
    if (el.kind === 'line') { const [a, b] = shape.vector(el.vector); use(a); use(b); }
    if (el.kind === 'bitmap') use(el.point);
    if (el.facePoint !== undefined) use(el.facePoint);
  }
  for (const v of shape.vis) use(v);
  const raw = [];
  for (let i = 0; i < n; i++) raw.push(shape.rawPoint(i));
  return raw.map((r) => {
    const ref = r.wx & 0x8000 ? raw[r.wx & 0x7fff] : null;
    const src = ref || r;
    // Y word decides the tilt term (setting +0E), so keep the words
    return { x: val(src.wx), y: val(src.wy), z: r.z, partner: r.partner, ref: ref ? r.wx & 0x7fff : -1 };
  });
}

/**
 * Polygon outline as point indices, from its signed vector list (a negative
 * index runs the vector backwards). A few polygons leave out an edge (the
 * game fills between the edges it has); the outline closes the gap.
 */
export function polygonLoop(shape, el) {
  const ends = el.edges.map((e) => { const [a, b] = shape.vector(Math.abs(e)); return e > 0 ? [a, b] : [b, a]; });
  const pts = [];
  ends.forEach(([from, to], i) => {
    if (pts[pts.length - 1] !== from) pts.push(from);
    const next = ends[(i + 1) % ends.length][0];
    if (to !== next && to !== pts[0]) pts.push(to);
  });
  if (pts.length > 1 && pts[pts.length - 1] === pts[0]) pts.pop();
  return pts;
}

// ------------------------------------------------------------------ sprites

/**
 * Decode a bitmap (scaled sprite) from the sprite store (0F47:19E8).
 * Header: +0 size (bit 15: alias, low byte = other id; bit 14 too: not drawn),
 * +2 row-table bytes (rows*2), +4 column bound, +6 rows below the anchor,
 * +8 row offsets. Row 0 is the bottom row. A row is runs: a byte c (0 ends the
 * row; bit 7: a start column follows, else the run starts where the last one
 * ended), [start column], end column (signed bytes, relative to the anchor
 * column); colour = (c & 7Eh) / 2 - 2, an index 0-15 into the object palette.
 * @returns {{id:number, size:number, rows:number, bottom:number, runs:number[][][]}|null}
 */
export function decodeSprite(rd, spriteSeg, id) {
  const B = spriteSeg << 4;
  let p, w0;
  for (let hop = 0; ; hop++) {
    if (hop > 4 || id > 0xff) return null;
    p = rd.far(B + SPRITE_TABLE + 4 * id);
    w0 = rd.u16(p);
    if (!(w0 & 0x8000)) break;
    if (w0 & 0x4000) return null;
    id = w0 & 0xff;
  }
  const tableBytes = rd.u16(p + 2), rows = tableBytes >> 1, bottom = rd.s16(p + 6);
  if (!w0 || rows === 0 || rows > 256) return null;
  const runs = [];
  let minC = 0, maxC = 0;
  for (let r = 0; r < rows; r++) {
    let q = p + rd.u16(p + 8 + 2 * r), c = rd.u8(q++), last = null;
    const row = [];
    while (c && row.length < 128) {
      const c0 = c & 0x80 || last === null ? rd.s8(q++) : last;
      const c1 = rd.s8(q++);
      const k = ((c & 0x7e) >> 1) - 2;
      if (c1 > c0) row.push([c0, c1, k]);
      if (c0 < minC) minC = c0;
      if (c1 > maxC) maxC = c1;
      last = c1;
      c = rd.u8(q++);
    }
    runs.push(row);
  }
  return { id, size: w0, rows, bottom, runs, minC, maxC };
}

// ------------------------------------------------------------------ reading

function readSegments(H, B, ds, ss) {
  const r16 = (p) => H[p] | (H[p + 1] << 8);
  const tOff = r16(B + ds + DS_TRACK), tSeg = r16(B + ds + DS_TRACK + 2);
  const pOff = r16(B + ds + DS_PIT), pSeg = r16(B + ds + DS_PIT + 2);
  const lapEnd = r16(B + ss + SS_LAP_END);
  const n = lapEnd > tOff ? (lapEnd - tOff) / SEG_SIZE : 0;
  const segs = [];
  const seen = new Set();
  const add = (lin) => {
    const nr = r16(B + lin + 0x1a);
    const key = nr & 0x2fff;
    if (seen.has(key)) return;
    seen.add(key);
    segs.push({ lin, nr, pit: (nr & 0x2000) !== 0 });
  };
  for (let i = 0; i < n; i++) add((tSeg << 4) + tOff + i * SEG_SIZE);
  // the pit array, while the numbers run on (as scene.mjs readScene)
  let prev = -1;
  for (let i = 0; i < 600; i++) {
    const lin = (pSeg << 4) + pOff + i * SEG_SIZE, cur = r16(B + lin + 0x1a) & 0x2fff;
    if (i > 0 && cur !== prev + 1 && !(cur === 0 && prev > 0 && !(prev & 0x2000))) break;
    prev = cur;
    add(lin);
  }
  return segs;
}

/**
 * Read every trackside object from the running game (mem from f1gp-mem.mjs).
 * @returns {object} { placements, settings, shapes (id -> decoded, unpatched),
 *   palettes (SS:2964, 0x900 bytes), cos (Int16Array), spriteSeg, vscale,
 *   spriteVscale, haze (4 x 256 bytes or null), mem reader, sprite(id) }
 */
export function readObjects(mem) {
  const H = mem.heap(), B = mem.memBase;
  const ds = mem.DS << 4, ss = mem.SS << 4;
  const rd = reader(() => mem.heap(), B);
  const cos = new Int16Array(4097);
  for (let i = 0; i < 4097; i++) cos[i] = rd.s16(ss + SS_COS + 2 * i);
  const trig = makeTrig(cos);
  const settingsPtr = rd.far(ds + DS_SETTINGS);
  const segs = readSegments(H, B, ds, ss);
  // settings referenced by the segments
  let maxSetting = -1;
  const placementsRaw = [];
  for (const s of segs) {
    const o = H[B + s.lin + 0x1e], f26 = H[B + s.lin + 0x26];
    if (!(f26 & 0x80) || o & 0x80) continue; // no object, or a car / pit crew (run time)
    placementsRaw.push({ seg: s, setting: o });
    if (o > maxSetting) maxSetting = o;
  }
  const settings = [];
  for (let i = 0; i <= maxSetting; i++) {
    const a = settingsPtr + 16 * i;
    settings.push({
      index: i, shape: rd.u8(a), flags: rd.u8(a + 1), palette: rd.u16(a + 2),
      lateral: rd.s16(a + 4), yaw: rd.u16(a + 6), extra: rd.u16(a + 8), range: rd.u16(a + 0x0a),
      height: rd.s16(a + 0x0c), tilt: rd.s16(a + 0x0e),
    });
  }
  const shapePtr = (id) => rd.far(ds + DS_SHAPES + 4 * id);
  const shapes = new Map();
  const placements = [];
  for (const { seg, setting } of placementsRaw) {
    if (SPECIAL_SETTINGS.has(setting)) continue;
    const st = settings[setting];
    const p = placeObject(rd, seg.lin, st, trig);
    p.segment = seg.nr & 0x0fff;
    p.pit = seg.pit;
    p.setting = setting;
    // patches the game writes into the shape before drawing it (0F47:9FC3):
    // shape 1, 0Dh and 5 take a byte (a bitmap id) at a fixed place
    p.patch = null;
    if (st.extra) {
      if (st.shape === 1) p.patch = [ds + 0x8042, st.extra & 0xff];
      else if (st.shape === 0x0d) p.patch = [ds + 0x83e5, st.extra & 0xff];
      else if (st.shape === 5) p.patch = [ds + 0x8288, st.extra & 0xff];
    }
    p.override = st.extra && st.shape >= 4 && ![1, 5, 0x0d].includes(st.shape) ? st.extra : 0;
    placements.push(p);
    if (!shapes.has(st.shape)) shapes.set(st.shape, decodeShape(rd, shapePtr(st.shape)));
  }
  const spriteSeg = rd.u16(ss + SS_SPRITE_SEG);
  const hazeLin = ((mem.imageSeg + HAZE_SEG_REL) << 4) + HAZE_OFF;
  const haze = mem.imageSeg ? H.slice(B + hazeLin, B + hazeLin + 1024) : null;
  const spriteCache = new Map(), shapeCache = new Map();
  return {
    placements, settings, shapes,
    palettes: H.slice(B + ss + SS_PALETTES, B + ss + SS_PALETTES + PALETTE_BYTES),
    cos, trig, spriteSeg,
    vscale: rd.u16(ss + SS_VSCALE), spriteVscale: rd.u16(ss + SS_SPRITE_VSCALE),
    haze,
    shapeAt: (p) => {
      // the shape as drawn for this placement (patches and scale override applied)
      const st = settings[p.setting];
      if (!p.patch && !p.override) return shapes.get(st.shape);
      if (!shapeCache.has(p)) {
        const ov = p.patch ? new Map([[p.patch[0], p.patch[1]]]) : null;
        shapeCache.set(p, decodeShape(reader(() => mem.heap(), B, ov), shapePtr(st.shape), p.override));
      }
      return shapeCache.get(p);
    },
    sprite: (id) => {
      if (!spriteCache.has(id)) spriteCache.set(id, decodeSprite(rd, spriteSeg, id));
      return spriteCache.get(id);
    },
  };
}

/** Palette index the game fills as a crowd (0F47:10D8, 1378). */
export const CROWD_COLOUR = 0x1b;

/**
 * The crowd fill (0F47:142A): a polygon whose final colour is 1Bh is filled,
 * in races and qualifying (SS:124A != 0), span by span from the bottom row
 * up, with pixels copied from a strip: span k (k = 1, 2, ... wrapping at 64)
 * starts at strip[(rows[k] + end of the previous span) & 1FFh]; in practice
 * sessions with colour 0Ah (empty stands). Hazed strips for haze levels 1-4
 * (the haze tables leave 1Bh unchanged, so the level comes from the object).
 * @returns {{ active: boolean, practiceColour: number, strips: Uint8Array[] (level 0-4, 1024 bytes),
 *             rows: Uint8Array (64) }}
 */
export function readCrowd(mem) {
  const H = mem.heap(), B = mem.memBase, ss = mem.SS << 4;
  const r16 = (a) => H[B + a] | (H[B + a + 1] << 8);
  const R = r16(ss + 0x00f4) << 4;
  const far = (a) => (r16(a + 2) << 4) + r16(a);
  const p0 = far(R), p4 = far(R + 4);
  const strips = [H.slice(B + p0, B + p0 + 1024)];
  for (let l = 1; l <= 4; l++) strips.push(H.slice(B + p4 + (l - 1) * 1024, B + p4 + l * 1024));
  return { active: H[B + ss + 0x124a] !== 0, practiceColour: 0x0a, strips, rows: H.slice(B + R + 0x2b4, B + R + 0x2b4 + 64) };
}

/**
 * Where the game puts a setting's object at a segment (0F47:9E2A), integer
 * arithmetic as the game: X, Y fine = (seg +04, +08) << 3 (no fine bits),
 * plus setting +4 / 256 half-widths to the right; shapes 0, 2, 3 also move
 * setting +8 / 256 half-widths along the track. Z = seg +06 + setting +0C;
 * yaw = seg +00 + setting +06.
 */
export function placeObject(rd, lin, st) {
  const hx = rd.s16(lin + 0x0c) >> 6, hy = rd.s16(lin + 0x0e) >> 6;
  let x = rd.s16(lin + 0x04) * 8, y = rd.s16(lin + 0x08) * 8;
  x += Math.floor((hx * st.lateral) / 32);
  y -= Math.floor((hy * st.lateral) / 32);
  if (st.extra && st.shape < 4 && st.shape !== 1) {
    const e = s16(st.extra);
    x += Math.floor((hy * e) / 32);
    y += Math.floor((hx * e) / 32);
  }
  return {
    x, y, z: s16((rd.u16(lin + 0x06) + st.height) & 0xffff),
    yaw: (rd.u16(lin) + st.yaw) & 0xffff,
    palette: st.palette, tilt: st.tilt, flags: st.flags, shape: st.shape,
    // farthest band the walk lists the object in (track loader 8EAA:0857):
    // flags bit 3 -> 9 segments, bit 4 -> 25, bit 5 -> 58, else any
    maxSegments: st.flags & 0x08 ? 9 : st.flags & 0x10 ? 25 : st.flags & 0x20 ? 58 : Infinity,
  };
}

/** Would the game draw this placement at detail level d (DS:0068, 3 = all)? (0F47:9EA6) */
export function shownAtDetail(p, d) {
  if (d > 2) return true;
  if (d === 2) return !(p.flags & 0x02);
  if (d === 1) return !(p.flags & 0x42);
  return (p.flags & 0x04) !== 0;
}

// ------------------------------------------------------------------ geometry

/**
 * World position of shape point `pt` for placement p: fine units, Z units.
 *   x = X + px*cos(yaw) + py*sin(yaw);  y = Y - px*sin(yaw) + py*cos(yaw)
 *   z = Z + shape +12 + pz + hi16((py * sin(tilt)) << 2)
 */
export function worldPoint(objs, p, shape, pt) {
  const { cos, sin } = objs.trig;
  const c = cos(p.yaw) / 16384, s = sin(p.yaw) / 16384;
  const tz = p.tilt ? Math.floor((pt.y * sin(p.tilt)) / 16384) : 0;
  return [p.x + pt.x * c + pt.y * s, p.y - pt.x * s + pt.y * c, p.z + shape.z12 + pt.z + tz];
}

function polyNormal(P) {
  // Newell's method
  let nx = 0, ny = 0, nz = 0;
  for (let i = 0; i < P.length; i++) {
    const a = P[i], b = P[(i + 1) % P.length];
    nx += (a[1] - b[1]) * (a[2] + b[2]);
    ny += (a[2] - b[2]) * (a[0] + b[0]);
    nz += (a[0] - b[0]) * (a[1] + b[1]);
  }
  return [nx, ny, nz];
}

// Ear clipping in the polygon's plane; falls back to a fan.
function triangulate(P, n) {
  const m = P.length;
  if (m < 3) return [];
  if (m === 3) return [[0, 1, 2]];
  const ax = Math.abs(n[0]), ay = Math.abs(n[1]), az = Math.abs(n[2]);
  const [i0, i1, flip] = az >= ax && az >= ay ? [0, 1, n[2] < 0] : ax >= ay ? [1, 2, n[0] < 0] : [2, 0, n[1] < 0];
  const Q = P.map((p) => [p[i0], p[i1]]);
  const cross = (o, a, b) => (Q[a][0] - Q[o][0]) * (Q[b][1] - Q[o][1]) - (Q[a][1] - Q[o][1]) * (Q[b][0] - Q[o][0]);
  const sign = flip ? -1 : 1;
  const idx = [...Array(m).keys()], tris = [];
  let guard = 0;
  while (idx.length > 3 && guard++ < 500) {
    let cut = false;
    for (let k = 0; k < idx.length; k++) {
      const a = idx[(k + idx.length - 1) % idx.length], b = idx[k], c = idx[(k + 1) % idx.length];
      if (sign * cross(a, b, c) <= 0) continue;
      let inside = false;
      for (const o of idx) {
        if (o === a || o === b || o === c) continue;
        if (sign * cross(a, b, o) > 0 && sign * cross(b, c, o) > 0 && sign * cross(c, a, o) > 0) { inside = true; break; }
      }
      if (inside) continue;
      tris.push([a, b, c]);
      idx.splice(k, 1);
      cut = true;
      break;
    }
    if (!cut) break;
  }
  if (idx.length === 3) tris.push([idx[0], idx[1], idx[2]]);
  else for (let k = 1; k + 1 < idx.length; k++) tris.push([idx[0], idx[k], idx[k + 1]]);
  return tris;
}

/**
 * The polygons, lines and bitmaps of one placement, in world coordinates,
 * in the game's drawing order for the most detailed LOD.
 * Each polygon: { pts (world, in the game's outline order: clockwise on the screen when
 * seen from the visible side), colour (palette index), facing (normal [x,y,z] of the
 * visible side), layer (0, or 1+ for a decal drawn over a coplanar polygon) }.
 */
export function placementParts(objs, p, opt = {}) {
  const shape = objs.shapeAt(p);
  const out = { polys: [], lines: [], bitmaps: [], sprites: [] };
  if (!shape) return out;
  const pal = (k) => objs.palettes[(p.palette + k) & 0xffff] ?? 0;
  const lodIndex = opt.lod ?? shape.lods.findIndex((l) => !l.sprite);
  if (lodIndex < 0) {
    // a pure bitmap object: the sprite at the object's centre (Z + shape +14)
    const l = shape.lods[0];
    const sp = spriteForLod(shape, l);
    if (sp) out.sprites.push({ at: [p.x, p.y, p.z + shape.z14], id: sp.id, mirror: sp.mirror, palette: p.palette, yaw: p.yaw, frames: !!sp.frames, lod: l });
    return out;
  }
  const lod = shape.lods[lodIndex];
  out.lod = lod;
  const pts = shapePoints(shape, lod);
  const W = pts.map((pt) => worldPoint(objs, p, shape, pt));
  // the drawing order: elements in the order of the sector lists (all sectors merged)
  const order = [];
  const seen = new Set();
  const maxLen = Math.max(...lod.dirs.map((d) => d.length));
  for (let k = 0; k < maxLen; k++) for (const d of lod.dirs) if (k < d.length && !seen.has(d[k])) { seen.add(d[k]); order.push(d[k]); }
  const inSectors = new Map();
  lod.dirs.forEach((list, d) => list.forEach((o) => { if (!inSectors.has(o)) inSectors.set(o, new Set()); inSectors.get(o).add(d); }));
  for (const o of order) {
    const el = shape.elements.get(o);
    if (el.kind === 'poly') {
      const loop = polygonLoop(shape, el);
      if (loop.length < 3) continue;
      const P = loop.map((i) => W[i]);
      const n = polyNormal(P);
      const len = Math.hypot(n[0], n[1], n[2]);
      if (len < 1e-6) continue;
      // one-sided: the game's span filler draws an outline only when it runs
      // clockwise on the screen; in world coordinates (right-handed, Z up) the
      // visible side is the one the Newell normal of the loop points away from
      const facing = n.map((v) => -v);
      const secs = inSectors.get(o);
      if (el.facePoint !== undefined) out.facePoint = true; // cars: an extra depth test (point vs its partner)
      out.polys.push({ pts: P, colour: pal(el.colour), colourCode: el.colour, facing, order: o, sectors: secs });
    } else if (el.kind === 'line') {
      // a vertical pole, one pixel wide, in palette colour 0 (0F47:878D)
      const [a, b] = shape.vector(el.vector);
      out.lines.push({ a: W[a], b: W[b], colour: pal(0), order: o });
    } else if (el.kind === 'bitmap') {
      if (el.type & 0x10) continue; // only on cars (SS:0178 bit 4)
      let mirror = 'angle';
      if (el.type & 4) mirror = el.type & 8 ? 'always' : 'never';
      else if (el.type & 8) mirror = 'angleInverted';
      out.bitmaps.push({ at: W[el.point], id: el.id, palette: el.palette ?? p.palette, maxDepth: el.maxDepth * 8, mirror, yaw: p.yaw, type: el.type, order: o });
    }
  }
  // bitmaps drawn over the shape's own polygons (not rows of trees made of bitmaps only)
  for (const b of out.bitmaps) b.onPolygons = out.polys.length > 0;
  // decals inside the object: a polygon drawn after a coplanar polygon it overlaps
  assignLayers(out.polys);
  return out;
}

/**
 * Decal layers: polygons in drawing order; a polygon that overlaps an earlier,
 * coplanar polygon seen from the same side gets that polygon's layer + 1.
 */
export function assignLayers(polys) {
  const planes = polys.map((A) => {
    const l = Math.hypot(...A.facing);
    const u = A.facing.map((v) => v / l);
    return { u, d: dot3(u, A.pts[0]) };
  });
  for (let i = 0; i < polys.length; i++) {
    const A = polys[i], pa = planes[i];
    A.layer = 0;
    for (let j = 0; j < i; j++) {
      const pb = planes[j];
      if (dot3(pa.u, pb.u) < 0.9995 || Math.abs(pa.d - pb.d) > 2) continue;
      if (coplanarOverlap(A.pts, polys[j].pts)) A.layer = Math.max(A.layer, polys[j].layer + 1);
    }
  }
}

/**
 * The game's drawing order key of a placement for a camera driving forward
 * (0F47:5233): its segment, moved by (setting +0A high byte & 3Fh) + (low byte,
 * at least 2) - 2 segments: farther, or nearer when setting +1 has bit 7 (segment
 * +26 bit 6). Objects are drawn far to near, so a larger key is drawn first.
 */
export function orderKey(objs, p) {
  const st = objs.settings[p.setting];
  const shift = ((st.range >> 8) & 0x3f) + Math.max(st.range & 0xff, 2) - 2;
  return p.segment + (st.flags & 0x80 ? -shift : shift);
}

// placementParts for every placement, with decal layers across objects: window
// bands, stripes and signs are often separate objects painted over a building
// (the game orders them with setting +0A)
function partsWithLayers(objs, placements) {
  const list = placements.map((p, i) => ({ p, i, key: orderKey(objs, p), parts: placementParts(objs, p) }));
  const byOrder = [...list].sort((a, b) => b.key - a.key || a.i - b.i);
  assignLayers(byOrder.flatMap((e) => e.parts.polys));
  return list;
}

/**
 * The bitmap a sprite LOD shows (0F47:9AAF-9BBA). `a` = object yaw - heading
 * of the ray from the camera to the object (R:0042 + R:0044).
 * The LOD's mask word holds flags (low byte: mode 0-2; 1000h: mirror when a
 * is negative; 400h: negative a shows the a = 0 or 8000h frame; 800h: fold
 * angles beyond 90 degrees with a mirror; 200h: clamp them to 90 degrees);
 * its shift word, with bit 15, is a fixed bitmap id.
 * @returns {{id:number, mirrored:boolean}|{polygons:true}|null} null = not drawn
 */
export function spriteLodFrame(l, a) {
  a &= 0xffff;
  let bx = 0;
  if (l.shift & 0x8000) return { id: l.shift & 0x7fff, mirrored: ((a + 0x4000) & 0x8000) !== 0 };
  const flags = l.mask, mode = flags & 0xff;
  let ax = (a + ((flags & 0x6000) << 1)) & 0xffff;
  if (mode <= 2 && ax & 0x8000) {
    if (flags & 0x1000) { bx ^= 0x8000; ax = -ax & 0xffff; }
    else if (flags & 0x400) { ax = -ax & 0xffff; ax = ax < 0x4000 ? 0 : 0x8000; }
    else return null;
  }
  if (mode < 2 && ax > 0x4000) {
    if (flags & 0x800) { bx ^= 0x8000; ax = (0x8000 - ax) & 0xffff; }
    else if (flags & 0x200) ax = 0x4000;
    else return null;
  }
  const f = l.frame(ax);
  ax = (ax + f.add) & 0xffff;
  if (f.shift & 0x8000) {
    if (f.base & 0x8000) return { polygons: true };
    return { id: f.base, mirrored: ((a + 0x4000) & 0x8000) !== 0 };
  }
  return { id: ((ax >> (f.shift & 15)) + f.base) & 0xffff, mirrored: (bx & 0x8000) !== 0 };
}

function spriteForLod(shape, l) {
  // +1A bit 15: a fixed bitmap (id = low bits), mirrored by view angle;
  // otherwise frames by view angle: take the one seen from straight ahead
  if (l.shift & 0x8000) return { id: l.shift & 0x7fff, mirror: 'angle' };
  for (const a of [0, 0x4000, 0xc000, 0x8000]) {
    const f = spriteLodFrame(l, a);
    if (f && !f.polygons) return { id: f.id, mirror: 'never', frames: true };
  }
  return null;
}

const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

function coplanarOverlap(P, Q) {
  const n = polyNormal(P), ln = Math.hypot(...n);
  const m = polyNormal(Q), lm = Math.hypot(...m);
  if (ln < 1e-6 || lm < 1e-6) return false;
  const cosA = Math.abs(n[0] * m[0] + n[1] * m[1] + n[2] * m[2]) / (ln * lm);
  if (cosA < 0.9995) return false;
  const u = n.map((v) => v / ln);
  const dP = u[0] * P[0][0] + u[1] * P[0][1] + u[2] * P[0][2];
  for (const q of Q) if (Math.abs(u[0] * q[0] + u[1] * q[1] + u[2] * q[2] - dP) > 2) return false;
  // 2D overlap in the plane (separating axis on the projected outlines)
  const ax = Math.abs(u[0]), ay = Math.abs(u[1]), az = Math.abs(u[2]);
  const [i0, i1] = az >= ax && az >= ay ? [0, 1] : ax >= ay ? [1, 2] : [2, 0];
  const A = P.map((p) => [p[i0], p[i1]]), Bq = Q.map((p) => [p[i0], p[i1]]);
  const axes = (R) => R.map((a, k) => { const b = R[(k + 1) % R.length]; return [a[1] - b[1], b[0] - a[0]]; });
  for (const ax2 of [...axes(A), ...axes(Bq)]) {
    let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
    for (const p of A) { const v = p[0] * ax2[0] + p[1] * ax2[1]; a0 = Math.min(a0, v); a1 = Math.max(a1, v); }
    for (const p of Bq) { const v = p[0] * ax2[0] + p[1] * ax2[1]; b0 = Math.min(b0, v); b1 = Math.max(b1, v); }
    const tol = 1e-6 * Math.max(Math.abs(a1), Math.abs(b1), 1);
    if (a1 <= b0 + tol || b1 <= a0 + tol) return false;
  }
  return true;
}

// ------------------------------------------------------------------ mesh

/**
 * Coloured triangles for every placed object, for the WebGL renderer, in the
 * format of scene.mjs buildSceneMesh: x, y, z, r, g, b per vertex, x/y fine
 * units relative to `origin`, z in Z units. Uses each shape's most detailed
 * LOD and every element of every view sector.
 *
 * Every polygon is one-sided, as in the game (whose span filler draws an
 * outline only when it runs clockwise on the screen): triangles are wound
 * counter-clockwise as seen from the visible side (x right, y up on screen),
 * so draw with gl.CULL_FACE (back faces). This static mesh draws every
 * element of every view sector; buildSectorMesh + frameObjects follow the
 * game's per-sector display lists exactly.
 *
 * @param {object} objs  from readObjects()
 * @param {object} [opt] { origin: [x, y], indexed: true for (palette index, -1, 0) colours,
 *   palette: RGB 768 bytes (needed unless indexed), detail: 0-3 (default 3),
 *   set: 'track' (default: objects on the lap's segments) | 'pit' (on pit-lane
 *   segments: the game shows these instead when the camera is in the pit lane) | 'all',
 *   crowd: true (default) to colour crowd polygons with CROWD_COLOUR, false for the
 *   practice-session colour 0Ah }
 * @returns {{ data: Float32Array, origin: number[], ranges: { solid, decals: {first,count,layer}[], crowd },
 *             lines: Float32Array, sprites: object[], counts: object, objects: {x,y,z,size}[],
 *             vertexObject: Uint32Array, lineObject: Uint32Array }}
 *   ranges.solid:  everything that is not drawn over a coplanar polygon
 *   ranges.decals: polygons painted over a coplanar one (signs, windows, stripes), by
 *                  layer (1, 2, ...): draw after solid, layer by layer, with depthFunc
 *                  LEQUAL and polygonOffset(-1, -4 * layer) or similar
 *   ranges.crowd:  polygons the game fills with its crowd pattern in races (part of solid
 *                  and decals too, listed here so a renderer can texture them)
 *   lines: x, y, z, r, g, b per vertex, pairs for gl.LINES (poles, one pixel wide in the game)
 *   sprites: { at: [x, y, z] relative to origin, id, palette (offset into objs.palettes),
 *              mirror: 'angle' | 'angleInverted' | 'never' | 'always', yaw, ray (true: the
 *              mirror angle uses the ray to the sprite, else the camera yaw), maxDepth (fine units) }
 *   objects, vertexObject, lineObject: the placement each vertex belongs to, with its
 *              centre and size, for the game's per-object haze (hazeLevel)
 */
export function buildObjectMesh(objs, opt = {}) {
  const origin = opt.origin ?? (objs.placements[0] ? [objs.placements[0].x, objs.placements[0].y] : [0, 0]);
  const pal = opt.palette;
  const rgb = opt.indexed ? (i) => [i, -1, 0] : (i) => [pal[i * 3] / 255, pal[i * 3 + 1] / 255, pal[i * 3 + 2] / 255];
  const detail = opt.detail ?? 3;
  const set = opt.set ?? 'track';
  const crowdOn = opt.crowd ?? true;
  const layers = [[]], layerObj = [[]];
  const crowdTris = [];
  const lines = [], lineObj = [], sprites = [], objects = [];
  const counts = { placements: 0, polys: 0, decals: 0, crowd: 0, lines: 0, sprites: 0, triangles: 0 };
  const vtx = (out, p, c) => out.push(p[0] - origin[0], p[1] - origin[1], p[2], c[0], c[1], c[2]);
  const chosen = objs.placements.filter((p) => !(set === 'track' && p.pit) && !(set === 'pit' && !p.pit) && shownAtDetail(p, detail));
  for (const { p, parts } of partsWithLayers(objs, chosen)) {
    counts.placements++;
    const shape = objs.shapeAt(p);
    const oi = objects.length;
    // for haze: the game hazes a whole object by max(depth of its centre, size / 8) (1/8 ft)
    objects.push({ x: p.x - origin[0], y: p.y - origin[1], z: p.z + (shape ? shape.z14 : 0), size: shape ? shape.size : 0, segment: p.segment, setting: p.setting, shape: p.shape });
    for (const poly of parts.polys) {
      // the game shows a polygon when its outline runs clockwise on the screen;
      // reversed, it is counter-clockwise (the GL front face)
      const windings = [[...poly.pts].reverse()];
      const isCrowd = poly.colour === CROWD_COLOUR;
      const c = rgb(isCrowd && !crowdOn ? 0x0a : poly.colour);
      while (layers.length <= poly.layer) { layers.push([]); layerObj.push([]); }
      const out = layers[poly.layer], outObj = layerObj[poly.layer];
      for (const P of windings) {
        const tris = triangulate(P, polyNormal(P));
        for (const t of tris) {
          for (const k of t) { vtx(out, P[k], c); outObj.push(oi); }
          if (isCrowd) crowdTris.push([poly.layer, out.length / 6 - 3]);
          counts.triangles++;
        }
      }
      counts.polys++;
      if (poly.layer) counts.decals++;
      if (isCrowd) counts.crowd++;
    }
    for (const l of parts.lines) { const c = rgb(l.colour); vtx(lines, l.a, c); vtx(lines, l.b, c); lineObj.push(oi, oi); counts.lines++; }
    for (const b of parts.bitmaps) { sprites.push({ ...b, at: [b.at[0] - origin[0], b.at[1] - origin[1], b.at[2]], ray: false }); counts.sprites++; }
    for (const b of parts.sprites) { sprites.push({ ...b, at: [b.at[0] - origin[0], b.at[1] - origin[1], b.at[2]], ray: true }); counts.sprites++; }
  }
  const starts = [];
  let total = 0;
  for (const l of layers) { starts.push(total); total += l.length / 6; }
  const data = new Float32Array(total * 6);
  layers.forEach((l, k) => data.set(l, starts[k] * 6));
  const vertexObject = new Uint32Array(total);
  layerObj.forEach((l, k) => vertexObject.set(l, starts[k]));
  const ranges = {
    solid: { first: 0, count: layers[0].length / 6 },
    decals: layers.slice(1).map((l, k) => ({ first: starts[k + 1], count: l.length / 6, layer: k + 1 })),
    crowd: crowdTris.map(([layer, v]) => starts[layer] + v), // first vertex of each crowd triangle
  };
  return { data, origin, ranges, lines: new Float32Array(lines), sprites, counts, objects, vertexObject, lineObject: Uint32Array.from(lineObj) };
}

/**
 * The game's haze level (0-4) for an object (0F47:8801) or a bitmap
 * (0F47:1931) at depth d (1/8 ft; for an object max(centre depth, size / 8)):
 * clamp(((clamp(d + 80h, 0, 3C00h) >> 8) - 5) >> 3, 0, 4), dry weather. Level k > 0
 * maps colour c to objs.haze[(k - 1) * 256 + c].
 */
export function hazeLevel(d) {
  let v = Math.min(Math.max(Math.floor(d) + 0x80, 0), 0x3c00) >> 8;
  v -= 5;
  if (v < 0) v = 0;
  return Math.min(v >> 3, 4);
}

/**
 * The objects as the game selects their parts: for every placement, its most
 * detailed LOD's elements once each, plus the game's display list for every
 * view sector (which elements, in which order). Each frame, frameObjects()
 * picks every object's sector from the camera and returns what to draw, so
 * one-sided faces, faces that give way to a bitmap (distance boards) and the
 * painting order of coplanar details all follow the game.
 * Same options and vertex format as buildObjectMesh (one-sided triangles: draw with gl.CULL_FACE).
 * @returns {{ data, origin, lines, sprites, objects, vertexObject, lineObject,
 *   placements: { centre: [x,y,z], yaw, shift, sectors: {tris: [first, count, layer][], lines: number[], sprites: number[]}[] }[] }}
 */
export function buildSectorMesh(objs, opt = {}) {
  const origin = opt.origin ?? (objs.placements[0] ? [objs.placements[0].x, objs.placements[0].y] : [0, 0]);
  const pal = opt.palette;
  const rgb = opt.indexed ? (i) => [i, -1, 0] : (i) => [pal[i * 3] / 255, pal[i * 3 + 1] / 255, pal[i * 3 + 2] / 255];
  const detail = opt.detail ?? 3, set = opt.set ?? 'track', crowdOn = opt.crowd ?? true;
  const data = [], vobj = [], lines = [], lineObj = [], sprites = [], objects = [], placements = [];
  const counts = { placements: 0, polys: 0, triangles: 0, lines: 0, sprites: 0, crowd: 0 };
  const vtx = (out, p, c) => out.push(p[0] - origin[0], p[1] - origin[1], p[2], c[0], c[1], c[2]);
  const chosen = objs.placements.filter((p) => !(set === 'track' && p.pit) && !(set === 'pit' && !p.pit) && shownAtDetail(p, detail) && objs.shapeAt(p));
  for (const { p, parts } of partsWithLayers(objs, chosen)) {
    const shape = objs.shapeAt(p);
    counts.placements++;
    const oi = objects.length;
    const centre = [p.x - origin[0], p.y - origin[1], p.z + shape.z14];
    objects.push({ x: centre[0], y: centre[1], z: centre[2], size: shape.size, segment: p.segment, setting: p.setting, shape: p.shape });
    const ref = new Map();
    for (const poly of parts.polys) {
      const isCrowd = poly.colour === CROWD_COLOUR;
      const c = rgb(isCrowd && !crowdOn ? 0x0a : poly.colour);
      const first = data.length / 6;
      const P = [...poly.pts].reverse(); // counter-clockwise on screen from the visible side
      for (const t of triangulate(P, polyNormal(P))) for (const k of t) { vtx(data, P[k], c); vobj.push(oi); }
      const count = data.length / 6 - first;
      counts.triangles += count / 3; counts.polys++;
      if (isCrowd) counts.crowd++;
      ref.set(poly.order, { tris: [first, count, poly.layer, isCrowd ? 1 : 0] });
    }
    for (const l of parts.lines) {
      const c = rgb(l.colour);
      ref.set(l.order, { line: lines.length / 12 });
      vtx(lines, l.a, c); vtx(lines, l.b, c); lineObj.push(oi, oi); counts.lines++;
    }
    for (const b of parts.bitmaps) {
      ref.set(b.order, { sprite: sprites.length });
      sprites.push({ ...b, at: [b.at[0] - origin[0], b.at[1] - origin[1], b.at[2]], ray: false, object: oi });
      counts.sprites++;
    }
    const entry = { centre, yaw: p.yaw, object: oi, shift: 15, sectors: [{ tris: [], lines: [], sprites: [] }], palette: p.palette };
    // LODs beyond the first (the game switches by the centre's depth, 1/8 ft):
    // for track shapes these are bitmap LODs (rows of trees seen from afar)
    const first = shape.lods.findIndex((l) => !l.sprite);
    if (first >= 0) entry.lods = shape.lods.slice(first).map((l, k) => ({ max: l.max, sprite: l.sprite ? l : null, same: k === 0 || !l.sprite }));
    if (parts.lod) {
      entry.shift = parts.lod.shift & 15;
      entry.sectors = parts.lod.dirs.map((list) => {
        const sec = { tris: [], lines: [], sprites: [] };
        for (const o of list) {
          const r = ref.get(o);
          if (!r) continue;
          if (r.tris) sec.tris.push(r.tris); else if (r.line !== undefined) sec.lines.push(r.line); else sec.sprites.push(r.sprite);
        }
        return sec;
      });
    }
    for (const b of parts.sprites) {
      entry.sectors[0].sprites.push(sprites.length);
      entry.spriteLod = b.lod;
      sprites.push({ ...b, at: [b.at[0] - origin[0], b.at[1] - origin[1], b.at[2]], ray: true, object: oi });
      counts.sprites++;
    }
    placements.push(entry);
  }
  return {
    data: new Float32Array(data), origin, lines: new Float32Array(lines), sprites, objects, placements, counts,
    vertexObject: Uint32Array.from(vobj), lineObject: Uint32Array.from(lineObj),
  };
}

/**
 * What to draw this frame (exact element selection of 0F47:88A5): for each
 * object, a = object yaw - heading of the ray from the camera to the object's
 * centre (the game uses its screen column: R:0042 + R:0044); sector =
 * a >> (shift + 1); that sector's display list, in its order. Bitmap-only
 * objects pick their frame and mirroring from a as the game does.
 * @param {object} mesh  from buildSectorMesh
 * @param {object} cam   { x, y (fine, absolute), heading }
 * @param {object} [opt] { lod: true to switch to far LODs by depth as the game (rows of trees
 *                         become one bitmap beyond 672 ft), filter(placementIndex) -> bool }
 * @returns {{ layers: Uint32Array[] (vertex indices of triangles, by decal layer 0, 1, ...),
 *             crowd: Uint32Array (indices of crowd triangles, also in layers),
 *             lines: Uint32Array (vertex indices into mesh.lines),
 *             sprites: {sprite (index into mesh.sprites) | centre (placement index, far LOD), id, mirrored}[] }}
 */
export function frameObjects(mesh, cam, opt = {}) {
  const layers = [[]], crowd = [], lines = [], sprites = [];
  const ox = mesh.origin[0], oy = mesh.origin[1];
  const toAngle = 65536 / (2 * Math.PI);
  const h = (cam.heading / 65536) * 2 * Math.PI, sh = Math.sin(h), ch = Math.cos(h);
  mesh.placements.forEach((pl, i) => {
    if (opt.filter && !opt.filter(i)) return;
    const dx = pl.centre[0] + ox - cam.x, dy = pl.centre[1] + oy - cam.y;
    // the game's view angle: object yaw - camera yaw - atan((column - 160) / 256) of the
    // centre's screen column, |column - 160| capped at 255; column 0 or 320 when the
    // centre is behind the near plane (R:0042 + R:0044)
    const lat = (dx * ch - dy * sh) / 8, dep = (dx * sh + dy * ch) / 8;
    const col = dep < 8 ? (lat < 0 ? 0 : 320) : 160 + Math.trunc((256 * lat) / dep);
    const k = Math.min(Math.abs(col - 160), 255);
    const corr = Math.round(Math.atan(k / 256) * toAngle) * Math.sign(col - 160);
    const a = (pl.yaw - cam.heading - corr) & 0xffff;
    if (opt.lod && pl.lods) {
      // the game's LOD by depth: a bitmap LOD shows one frame at the centre
      const d8 = Math.floor((dx * sh + dy * ch) / 8);
      const l = pl.lods.find((q) => Math.max(d8, 0) <= q.max) ?? pl.lods[pl.lods.length - 1];
      if (l.sprite) {
        const f = spriteLodFrame(l.sprite, a);
        if (!f) return;
        if (!f.polygons) { sprites.push({ centre: i, id: f.id, mirrored: f.mirrored }); return; }
      }
    }
    const n = pl.sectors.length;
    const sec = pl.sectors[n > 1 ? (a >> (pl.shift + 1)) % n : 0];
    for (const [first, count, layer, isCrowd] of sec.tris) {
      while (layers.length <= layer) layers.push([]);
      for (let v = first; v < first + count; v++) { layers[layer].push(v); if (isCrowd) crowd.push(v); }
    }
    for (const l of sec.lines) lines.push(2 * l, 2 * l + 1);
    for (const k of sec.sprites) {
      const s = mesh.sprites[k];
      if (s.maxDepth) {
        // bitmaps inside shapes have a maximum depth (element byte 2 x 128, 1/8 ft)
        const h = (cam.heading / 65536) * 2 * Math.PI;
        const d = (s.at[0] + ox - cam.x) * Math.sin(h) + (s.at[1] + oy - cam.y) * Math.cos(h);
        if (d > s.maxDepth) continue;
      }
      let id = s.id, mirrored;
      if (s.ray) {
        const f = s.lod ? spriteLodFrame(s.lod, a) : null;
        if (s.lod && !f) continue;
        if (f && !f.polygons) { id = f.id; mirrored = f.mirrored; } else mirrored = ((a + 0x4000) & 0x8000) !== 0;
      } else {
        let m = s.mirror === 'never' || s.mirror === 'always' ? 1 : (s.yaw - cam.heading + 0x4000) & 0xffff;
        if (s.mirror === 'always' || s.mirror === 'angleInverted') m = -m & 0xffff;
        mirrored = (m & 0x8000) !== 0;
      }
      sprites.push({ sprite: k, id, mirrored });
    }
  });
  return { layers: layers.map((l) => Uint32Array.from(l)), crowd: Uint32Array.from(crowd), lines: Uint32Array.from(lines), sprites };
}

// ------------------------------------------------------------------ sprites for WebGL

/**
 * Pack the bitmaps the sprites use into one 8-bit image: each texel is a
 * colour code 0-15 (an index into the sprite's 16-colour object palette,
 * objs.palettes[palette + code] = palette index), 255 = transparent.
 * Row 0 of each rectangle is the bitmap's bottom row (texture v grows upward).
 * @returns {{ width, height, data: Uint8Array, rects: Map<number, {x, y, w, h, minC, rows, bottom, size, vsize}> }}
 */
export function buildSpriteAtlas(objs, ids, opt = {}) {
  const width = opt.width ?? 1024;
  const rects = new Map();
  let x = 0, y = 0, rowH = 0;
  const list = [];
  for (const id of [...new Set(ids)].sort((a, b) => a - b)) {
    const spr = objs.sprite(id);
    if (!spr) continue;
    const w = spr.maxC - spr.minC, h = spr.rows;
    if (w <= 0 || w > width) continue;
    if (x + w > width) { x = 0; y += rowH + 1; rowH = 0; }
    list.push([id, spr, x, y]);
    rects.set(id, { x, y, w, h, minC: spr.minC, rows: spr.rows, bottom: spr.bottom, size: spr.size & 0x3fff, special: [0xaf, 0xaa, 0xab].includes(spr.id) });
    x += w + 1;
    if (h > rowH) rowH = h;
  }
  const height = y + rowH;
  const data = new Uint8Array(width * Math.max(height, 1)).fill(255);
  for (const [, spr, rx, ry] of list) {
    spr.runs.forEach((row, r) => {
      for (const [c0, c1, k] of row) for (let c = c0; c < c1; c++) data[(ry + r) * width + rx + c - spr.minC] = k & 15;
    });
  }
  return { width, height, data, rects };
}

/**
 * Camera-facing quads for the sprites (the game draws a bitmap flat on the
 * screen at its anchor point's depth). One bitmap pixel is size/32 fine units
 * wide and size * SS:017E / (SS:017C * 64) Z units tall (= size/32 with the
 * game's values); column 0 starts at the anchor, row 0 (the bottom row) lies
 * `bottom` rows below it. Mirrored bitmaps flip about the anchor column.
 * @param {object[]} sprites  from buildObjectMesh or buildSectorMesh
 *   (with `chosen` = frameObjects().sprites: only those, with their frame and mirroring;
 *   entries with `centre` are far-LOD bitmaps at that placement: pass mesh.placements)
 * @param {object} atlas      from buildSpriteAtlas
 * @param {object} cam        { x, y (fine, absolute), heading }
 * @param {object} objs       from readObjects (for the scale constants)
 * @param {number[]} origin   the mesh origin
 * @returns {Float32Array} x, y, z (relative to origin), u, v (atlas texels), palette offset,
 *   depth bias (fine units: draw the quad's depth this much nearer); 7 floats per vertex, 6 vertices per sprite
 */
export function spriteQuads(sprites, atlas, cam, objs, origin, chosen = null, placements = null) {
  const out = [];
  const a = (cam.heading / 65536) * 2 * Math.PI;
  const rx = Math.cos(a), ry = -Math.sin(a); // screen right in world X/Y
  const vratio = objs.spriteVscale / (objs.vscale * 64);
  const list = chosen ? chosen.map((c) => (c.centre !== undefined
    ? { at: placements[c.centre].centre, palette: placements[c.centre].palette, id: c.id, mirrorSet: c.mirrored }
    : { ...sprites[c.sprite], id: c.id, mirrorSet: c.mirrored })) : sprites;
  for (const s of list) {
    const r = atlas.rects.get(s.id);
    if (!r) continue;
    const wx = r.size / 32, hz = r.special ? (r.size * 65536) / (objs.vscale * 64) : r.size * vratio;
    // mirror rule: (yaw - camera yaw [or ray heading]) + 4000h, negative = mirrored
    let ang = s.yaw - cam.heading;
    if (s.ray) ang = s.yaw - ((Math.atan2(s.at[0] + origin[0] - cam.x, s.at[1] + origin[1] - cam.y) / (2 * Math.PI)) * 65536);
    const neg = ((Math.round(ang) + 0x4000) & 0x8000) !== 0;
    const mirrored = s.mirrorSet ?? (s.mirror === 'always' || (s.mirror === 'angle' && neg) || (s.mirror === 'angleInverted' && !neg));
    const c0 = r.minC, c1 = r.minC + r.w;
    const l0 = mirrored ? -c1 * wx : c0 * wx, l1 = mirrored ? -c0 * wx : c1 * wx;
    const z0 = s.at[2] - r.bottom * hz, z1 = z0 + r.rows * hz;
    const u0 = mirrored ? r.x + r.w : r.x, u1 = mirrored ? r.x : r.x + r.w;
    // a bitmap that belongs to a polygon shape is painted after the shape's
    // polygons (display-list order) though it is flat at its anchor's depth:
    // pull it forward by its half-width so the shape's own faces beside the
    // anchor do not hide it
    const bias = s.onPolygons ? (r.w * wx) / 2 : 0;
    const P = (l, z, u, v) => out.push(s.at[0] + rx * l, s.at[1] + ry * l, z, u, v, s.palette, bias);
    const A = [l0, z0, u0, r.y], B = [l1, z0, u1, r.y], C = [l1, z1, u1, r.y + r.rows], D = [l0, z1, u0, r.y + r.rows];
    for (const q of [A, B, C, A, C, D]) P(...q);
  }
  return new Float32Array(out);
}

/**
 * Every bitmap id the placements can show: their bitmap elements and sprite
 * objects, and every frame of the angle-dependent bitmap LODs (rows of trees
 * seen from afar). Use it for buildSpriteAtlas.
 */
export function spriteIdsUsed(objs) {
  const ids = new Set();
  const lods = new Set();
  for (const p of objs.placements) {
    const shape = objs.shapeAt(p);
    if (!shape) continue;
    const parts = placementParts(objs, p);
    for (const b of [...parts.bitmaps, ...parts.sprites]) ids.add(b.id);
    for (const l of shape.lods) if (l.sprite) lods.add(l);
  }
  for (const l of lods) for (let a = 0; a < 0x10000; a += 0x80) { const f = spriteLodFrame(l, a); if (f && !f.polygons) ids.add(f.id); }
  return [...ids].filter((id) => objs.sprite(id)).sort((a, b) => a - b);
}

/**
 * True when the camera's segment (DS:096F) is a pit-lane entry (+1A bit 2000h):
 * the game then walks the pit lane and shows the 'pit' object set
 * (buildSectorMesh(objs, { set: 'pit' })) instead of the lap's.
 */
export function cameraInPitLane(mem) {
  const H = mem.heap(), B = mem.memBase, ds = mem.DS << 4;
  const r16 = (a) => H[B + a] | (H[B + a + 1] << 8);
  const lin = (r16(ds + 0x0971) << 4) + r16(ds + 0x096f);
  return (r16(lin + 0x1a) & 0x2000) !== 0;
}
