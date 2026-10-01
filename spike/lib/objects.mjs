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

/** Reader over guest memory with an optional overlay of patched bytes (linear address -> byte). */
function reader(H, B, overlay) {
  const u8 = overlay && overlay.size ? (a) => (overlay.has(a) ? overlay.get(a) : H[B + a]) : (a) => H[B + a];
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
  for (const r of raw) if (r.wx & 0x8000 && (r.wx & 0x7fff) + 1 > raw.length) { /* bad ref: leave */ }
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
  const rd = reader(H, B);
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
  const spriteCache = new Map();
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
      const ov = p.patch ? new Map([[p.patch[0], p.patch[1]]]) : null;
      return decodeShape(reader(H, B, ov), shapePtr(st.shape), p.override);
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

// Sector centres for a LOD's display list: sector d covers a = yaw - ray heading
// in [d, d+1) * 2^(shift+1); the view direction in shape space is (-sin a, cos a).
function sectorViews(lod) {
  const n = lod.dirs.length, w = 65536 / n;
  const out = [];
  for (let d = 0; d < n; d++) {
    const a = ((d + 0.5) * w) / 65536 * 2 * Math.PI;
    out.push([-Math.sin(a), Math.cos(a)]);
  }
  return out;
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
 * Each polygon: { pts (world), colour (palette index), facing: 'both' | normal [x,y,z] of
 * the visible side, layer (0, or 1+ for a decal drawn over a coplanar polygon) }.
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
    if (sp) out.sprites.push({ at: [p.x, p.y, p.z + shape.z14], id: sp.id, mirror: sp.mirror, palette: p.palette, yaw: p.yaw });
    return out;
  }
  const lod = shape.lods[lodIndex];
  const pts = shapePoints(shape, lod);
  const W = pts.map((pt) => worldPoint(objs, p, shape, pt));
  const views = sectorViews(lod);
  const c = objs.trig.cos(p.yaw) / 16384, s = objs.trig.sin(p.yaw) / 16384;
  const toWorldDir = (v) => [v[0] * c + v[1] * s, -v[0] * s + v[1] * c];
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
      let facing = 'both';
      const secs = inSectors.get(o);
      if (el.facePoint !== undefined) {
        // drawn only where depth(point) <= depth(its partner): the visible
        // side faces from the partner towards the point
        const a = W[el.facePoint], b = W[pts[el.facePoint].partner] || a;
        const d = [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
        facing = d[0] * n[0] + d[1] * n[1] + d[2] * n[2] >= 0 ? n : n.map((v) => -v);
      } else if (secs.size < lod.dirs.length) {
        // one-sided: listed only for view sectors that look at its front
        let score = 0;
        views.forEach((v, d) => {
          const w = toWorldDir(v);
          const dot = (w[0] * n[0] + w[1] * n[1]) / len;
          score += (secs.has(d) ? -1 : 1) * dot;
        });
        if (Math.abs(n[2]) / len < 0.999) facing = score >= 0 ? n : n.map((v) => -v);
      }
      out.polys.push({ pts: P, colour: pal(el.colour), colourCode: el.colour, facing, order: o, sectors: secs });
    } else if (el.kind === 'line') {
      // a vertical pole, one pixel wide, in palette colour 0 (0F47:878D)
      const [a, b] = shape.vector(el.vector);
      out.lines.push({ a: W[a], b: W[b], colour: pal(0) });
    } else if (el.kind === 'bitmap') {
      if (el.type & 0x10) continue; // only on cars (SS:0178 bit 4)
      let mirror = 'angle';
      if (el.type & 4) mirror = el.type & 8 ? 'always' : 'never';
      else if (el.type & 8) mirror = 'angleInverted';
      out.bitmaps.push({ at: W[el.point], id: el.id, palette: el.palette ?? p.palette, maxDepth: el.maxDepth * 8, mirror, yaw: p.yaw, type: el.type });
    }
  }
  // decals: a polygon drawn after a coplanar polygon it overlaps
  for (let i = 0; i < out.polys.length; i++) {
    const A = out.polys[i];
    A.layer = 0;
    for (let j = 0; j < i; j++) {
      const Bp = out.polys[j];
      // a polygon only covers another seen from the same side
      if (A.facing !== 'both' && Bp.facing !== 'both' && dot3(A.facing, Bp.facing) <= 0) continue;
      if (coplanarOverlap(A.pts, Bp.pts)) A.layer = Math.max(A.layer, Bp.layer + 1);
    }
  }
  return out;
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
  // otherwise frames by view angle (not decoded for the mesh: use the first)
  if (l.shift & 0x8000) return { id: l.shift & 0x7fff, mirror: 'angle' };
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
 * units relative to `origin`.
 * @param {object} objs  from readObjects()
 * @param {object} [opt] { origin: [x, y], indexed: true for (palette index, -1, 0) colours,
 *                         palette: RGB 768 bytes (needed unless indexed), detail: 0-3 (default 3) }
 * @returns {{ data: Float32Array, origin: number[], ranges: { both, front, decal }, lines: Float32Array,
 *             sprites: object[], counts: object }}
 *   ranges.both:  polygons the game draws from every side (draw without face culling)
 *   ranges.front: one-sided polygons, wound counter-clockwise seen from their visible
 *                 side (x right, y up on screen): draw with gl.CULL_FACE (back)
 *   ranges.decal: polygons painted over a coplanar one (signs, windows): draw after the
 *                 others with depthFunc LEQUAL and a polygon offset (one-sided, like front)
 *   lines: x, y, z, r, g, b per vertex, pairs for gl.LINES (one-pixel poles)
 *   sprites: { at: [x, y, z] (relative to origin), id, palette, mirror, yaw, maxDepth? }
 */
export function buildObjectMesh(objs, opt = {}) {
  const origin = opt.origin ?? (objs.placements[0] ? [objs.placements[0].x, objs.placements[0].y] : [0, 0]);
  const pal = opt.palette;
  const rgb = opt.indexed ? (i) => [i, -1, 0] : (i) => [pal[i * 3] / 255, pal[i * 3 + 1] / 255, pal[i * 3 + 2] / 255];
  const detail = opt.detail ?? 3;
  const groups = { both: [], front: [], decal: [] };
  const lines = [], sprites = [];
  const counts = { placements: 0, polys: 0, decals: 0, lines: 0, sprites: 0 };
  const vtx = (out, p, c) => out.push(p[0] - origin[0], p[1] - origin[1], p[2], c[0], c[1], c[2]);
  for (const p of objs.placements) {
    if (!shownAtDetail(p, detail)) continue;
    counts.placements++;
    const parts = placementParts(objs, p);
    for (const poly of parts.polys) {
      const n = polyNormal(poly.pts);
      let P = poly.pts;
      const group = poly.layer > 0 ? 'decal' : poly.facing === 'both' ? 'both' : 'front';
      if (poly.facing !== 'both') {
        // wind so the visible side is counter-clockwise on screen: normal along `facing`
        const f = poly.facing;
        if (n[0] * f[0] + n[1] * f[1] + n[2] * f[2] < 0) P = [...P].reverse();
      }
      // (X east, Y north, Z up is right-handed, and the projection keeps screen
      // x = right, y = up: a loop whose normal points at the viewer is
      // counter-clockwise on screen); triangles keep the loop's orientation
      const tris = triangulate(P, polyNormal(P));
      const c = rgb(poly.colour);
      for (const t of tris) for (const k of t) vtx(groups[group], P[k], c);
      counts.polys++;
      if (group === 'decal') counts.decals++;
    }
    for (const l of parts.lines) { const c = rgb(l.colour); vtx(lines, l.a, c); vtx(lines, l.b, c); counts.lines++; }
    for (const b of [...parts.bitmaps, ...parts.sprites]) {
      sprites.push({ ...b, at: [b.at[0] - origin[0], b.at[1] - origin[1], b.at[2]] });
      counts.sprites++;
    }
  }
  const ranges = {};
  let total = 0;
  for (const g of ['both', 'front', 'decal']) { ranges[g] = { first: total, count: groups[g].length / 6 }; total += groups[g].length / 6; }
  const data = new Float32Array(total * 6);
  let o = 0;
  for (const g of ['both', 'front', 'decal']) { data.set(groups[g], o); o += groups[g].length; }
  return { data, origin, ranges, lines: new Float32Array(lines), sprites, counts };
}
