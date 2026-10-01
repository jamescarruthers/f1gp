// The track scene as the game builds it at track load, read from the game's
// memory, and turned into coloured triangles for the WebGL renderer.
//
// Every rule here is from docs/renderer-notes.md (gp.exe 0F47:81CE and the
// track loader 8EAA). The game draws distant parts with fewer, longer
// polygons; this module draws every part at every segment instead, because
// the point of the new renderer is more detail, not the same shortcuts.
//
// Units: X/Y in fine units (1/64 ft), Z in the game's Z units (1/64 ft).
// "C + k*v" means (X + k*v.x, Y - k*v.y): positive k is to the right of the
// direction of travel.

const SEG_SIZE = 0x2e;

// Part bits of a segment's +0B byte (and the marker bytes): which parts exist.
export const PART = {
  roadRight: 0x01, roadLeft: 0x02, kerbRight: 0x04, kerbLeft: 0x08,
  fenceRight: 0x10, fenceLeft: 0x20, markB: 0x40, markA: 0x80,
};

const s8 = (v) => (v << 24) >> 24;

/** DOSBox turns a 6-bit DAC value v into 8 bits as (v << 2) | (v >> 4). */
export function paletteRgb(pal6) {
  const out = new Uint8Array(768);
  for (let i = 0; i < 768; i++) { const v = pal6[i] & 63; out[i] = (v << 2) | (v >> 4); }
  return out;
}

function decodeSegment(H, p) {
  const r16 = (o) => H[p + o] | (H[p + o + 1] << 8);
  const s16 = (o) => (r16(o) << 16) >> 16;
  const fine = H[p + 0x21];
  return {
    nr: r16(0x1a),
    heading: r16(0x00),
    x: (s16(0x04) << 3) | (fine & 7),
    y: (s16(0x08) << 3) | (fine >> 4),
    z: s16(0x06),
    hx: s16(0x0c) >> 6, hy: s16(0x0e) >> 6,          // half-width vector, 1/8 ft
    wx: s8(H[p + 0x11]), wy: s8(H[p + 0x13]),        // 1.25 ft step along it, 1/8 ft
    marker: H[p + 0x0a],                              // bits 3 / 2: first or last segment of the left / right kerb
    parts: H[p + 0x0b],
    fenceIdx: H[p + 0x0e] & 63,                       // bits 0-2 left, 3-5 right
    markA: s8(H[p + 0x1c]), markB: s8(H[p + 0x1d]),
    stripe: H[p + 0x23],
    fenceColours: H[p + 0x24], markColours: H[p + 0x25],
    flags26: H[p + 0x26],                             // bit 5/4 bridged left/right fence, 3 no horizon, 2 low kerb
    vergeLeft: H[p + 0x28], vergeRight: H[p + 0x29],
  };
}

/**
 * Read the scene from the running game (mem from f1gp-mem.mjs attach() or fromRam()).
 * @returns {object} { lap: seg[] by segment index, pit: seg[] in order, tables, palette (RGB), horizon, grass, road }
 */
export function readScene(mem) {
  const H = mem.heap(), B = mem.memBase;
  const ds = B + (mem.DS << 4), ss = B + (mem.SS << 4);
  const r16 = (p) => H[p] | (H[p + 1] << 8);
  const tOff = r16(ds + 0x879f), tSeg = r16(ds + 0x87a1);
  const pOff = r16(ds + 0x8797), pSeg = r16(ds + 0x8799);
  const lapEnd = r16(ss + 0x015c);
  const n = lapEnd > tOff ? (lapEnd - tOff) / SEG_SIZE : 0;
  const lap = [], pit = [];
  for (let i = 0; i < n; i++) {
    const s = decodeSegment(H, B + (tSeg << 4) + tOff + i * SEG_SIZE);
    if (s.nr & 0x2000) pit.push(s); else if (!lap[s.nr & 0x0fff]) lap[s.nr & 0x0fff] = s;
  }
  // the pit array: entries while the numbers run on
  let prev = -1;
  for (let i = 0; i < 600; i++) {
    const s = decodeSegment(H, B + (pSeg << 4) + pOff + i * SEG_SIZE), cur = s.nr & 0x2fff;
    if (i > 0 && cur !== prev + 1 && !(cur === 0 && prev > 0 && !(prev & 0x2000))) break;
    prev = cur;
    if (s.nr & 0x2000) { if (!pit.some((q) => q.nr === s.nr)) pit.push(s); } else if (!lap[s.nr & 0x0fff]) lap[s.nr & 0x0fff] = s;
  }
  pit.sort((a, b) => (a.nr & 0x0fff) - (b.nr & 0x0fff));

  const R = B + (r16(ss + 0x00f4) << 4);
  const bytes = (p, len) => H.slice(p, p + len);
  const fenceHeights = [];
  for (let i = 0; i < 8; i++) fenceHeights.push(r16(R + 0x18c + 2 * i));
  const sky = [];
  for (let i = 0; i < 16; i++) {
    const e = R + 0x76 + 4 * i;
    sky.push({ rows: H[e], colour: H[e + 1] });
    if (H[e] > 100) break;
  }
  return {
    lap, pit,
    tables: {
      fenceHeights,
      kerbStripe: bytes(R + 0x208, 24),   // row 0 far, 8 near, 10h nearest; index + stripe number
      fence: bytes(R + 0x220, 16),
      marking: bytes(R + 0x230, 16),
      kerbColour: bytes(R + 0x248, 16),
      lines: bytes(R + 0x258, 12),        // three groups of (far, near, nearest, 0); low nibble left line
      sky,
    },
    palette: paletteRgb(bytes(ss + 0x05da, 768)),
    horizon: bytes(ss + 0x66a2, 4096),     // 8 rows of 512 palette indices
    grass: H[ss + 0x01af], road: H[ss + 0x01ae],
  };
}

/** The camera's segment +26 bit 3: no horizon image here. */
export function horizonOff(mem) {
  const H = mem.heap(), B = mem.memBase, ds = B + (mem.DS << 4);
  const off = H[ds + 0x096f] | (H[ds + 0x0970] << 8), seg = H[ds + 0x0971] | (H[ds + 0x0972] << 8);
  return (H[B + (seg << 4) + off + 0x26] & 0x08) !== 0;
}

/**
 * Coloured triangles for the whole lap (and pit lane).
 * @param {object} scene  from readScene()
 * @param {object} [opt]  { kerbRow: 0x10 nearest | 8 near | 0 far, origin: [x, y],
 *                          indexed: true to store (palette index, -1, haze) instead of RGB, so a
 *                          renderer can look colours up in the live palette; haze is 1 for the
 *                          parts the game hazes with distance (lines, markings, kerbs, fences),
 *                          0 for the road;
 *                          uv: true to add u, v per vertex on the road (u: feet along the
 *                          track, modulo 1024; v: feet across from the centre line), for a
 *                          surface texture; 0, 0 on the other parts }
 * @returns {{ data: Float32Array, origin: number[], counts: object, ranges: object, stride: number }}
 *   data = x, y, z, r, g, b (and u, v with opt.uv) per vertex, grouped: ground
 *   (road), decals (white lines, markings: flat on the road), raised (kerbs,
 *   fences); ranges give each group's first vertex and vertex count; stride is
 *   floats per vertex (6, or 8 with uv).
 */
export function buildSceneMesh(scene, opt = {}) {
  const pal = scene.palette, T = scene.tables;
  const row = opt.kerbRow ?? 0x10;
  const first = scene.lap.find(Boolean);
  const origin = opt.origin ?? [first.x, first.y];
  const groups = { ground: [], decals: [], raised: [] };
  const groupOf = { road: 'ground', line: 'decals', marking: 'decals', kerb: 'raised', kerbFace: 'raised', fence: 'raised' };
  const counts = {};
  const rgb = opt.indexed ? (i, haze = 1) => [i, -1, haze] : (i) => [pal[i * 3] / 255, pal[i * 3 + 1] / 255, pal[i * 3 + 2] / 255];
  const lineNearest = T.lines[2];
  const colours = {
    road: rgb(scene.road, 0),
    lineLeft: rgb(lineNearest & 15), lineRight: rgb(lineNearest >> 4),
  };
  // point C + k*h + m*w at height z
  const P = (s, k, m, z) => [s.x + 8 * (k * s.hx + m * s.wx) - origin[0], s.y - 8 * (k * s.hy + m * s.wy) - origin[1], z];
  // feet across from the centre line to C + k*h + m*w (w lies along h)
  const across = (s, k, m) => { const hl = Math.hypot(s.hx, s.hy) || 1; return (8 * (k * hl + (m * (s.wx * s.hx + s.wy * s.hy)) / hl)) / 64; };
  const stride = opt.uv ? 8 : 6;
  // uv: [u, v] for a0, a1, b1, b0, or none
  const quad = (a0, a1, b1, b0, c, kind, uv = null) => {
    const out = groups[groupOf[kind]];
    const corners = [a0, a1, b1, b0];
    for (const k of [0, 1, 2, 0, 2, 3]) {
      const p = corners[k];
      out.push(p[0], p[1], p[2], c[0], c[1], c[2]);
      if (opt.uv) out.push(uv ? uv[k][0] : 0, uv ? uv[k][1] : 0);
    }
    counts[kind] = (counts[kind] || 0) + 1;
  };

  const strip = (segs, closed) => {
    const n = segs.length;
    // bridged fences: the fence runs straight between the run's two end points
    const bridged = { left: bridgeRuns(segs, 0x20, closed), right: bridgeRuns(segs, 0x10, closed) };
    const fenceBase = (s, i, side) => {
      const run = bridged[side === -1 ? 'left' : 'right'].get(i);
      if (run) return [run[0] - origin[0], run[1] - origin[1], run[2]];
      const v = side === -1 ? s.vergeLeft : s.vergeRight;
      const k = side * (v + 32) / 32;
      return P(s, k, k, s.z);
    };
    const kerbH = (s, side) => {
      if (s.marker & (side === -1 ? 0x08 : 0x04)) return 0;
      return s.flags26 & 0x04 ? 0x14 : 0x20;
    };
    for (let i = 0; i < (closed ? n : n - 1); i++) {
      const a = segs[i], b = segs[(i + 1) % n];
      if (!a || !b) continue;
      const lift = 1;
      // road between the outer edges of the white lines, then the lines; u runs on 16 ft
      // a segment, modulo 1024 ft (the texture repeats within that), across the quad
      const u = (i * 16) % 1024;
      const uv = opt.uv ? [[u, across(a, -1, -1)], [u + 16, across(b, -1, -1)], [u + 16, across(b, 1, 1)], [u, across(a, 1, 1)]] : null;
      quad(P(a, -1, -1, a.z), P(b, -1, -1, b.z), P(b, 1, 1, b.z), P(a, 1, 1, a.z), colours.road, 'road', uv);
      if (a.parts & PART.roadLeft) quad(P(a, -1, -1, a.z + lift), P(b, -1, -1, b.z + lift), P(b, -1, 0, b.z + lift), P(a, -1, 0, a.z + lift), colours.lineLeft, 'line');
      if (a.parts & PART.roadRight) quad(P(a, 1, 0, a.z + lift), P(b, 1, 0, b.z + lift), P(b, 1, 1, b.z + lift), P(a, 1, 1, a.z + lift), colours.lineRight, 'line');
      // road markings: a = C + f/64 half-widths, b = a + w/2
      // colour index 0 in the marking and fence tables means "not drawn"
      if (a.parts & PART.markA && T.marking[a.markColours & 15]) {
        const c = rgb(T.marking[a.markColours & 15]);
        quad(P(a, a.markA / 64, 0, a.z + lift), P(b, b.markA / 64, 0, b.z + lift), P(b, b.markA / 64, 0.5, b.z + lift), P(a, a.markA / 64, 0.5, a.z + lift), c, 'marking');
      }
      if (a.parts & PART.markB && T.marking[a.markColours >> 4]) {
        const c = rgb(T.marking[a.markColours >> 4]);
        quad(P(a, a.markB / 64, 0, a.z + lift), P(b, b.markB / 64, 0, b.z + lift), P(b, b.markB / 64, 0.5, b.z + lift), P(a, a.markB / 64, 0.5, a.z + lift), c, 'marking');
      }
      // kerbs: top from the inner edge (2w, or 3w on low kerbs, outside the
      // road edge) to the outer edge (h*1.28125 + w), raised; inner face from
      // the white line's outer edge up to the kerb
      for (const side of [-1, 1]) {
        if (!(a.parts & (side === -1 ? PART.kerbLeft : PART.kerbRight))) continue;
        const code = T.kerbStripe[(a.stripe + row) % 24];
        const top = rgb(T.kerbColour[code & 15]), face = rgb(T.kerbColour[code >> 4]);
        const ka = kerbH(a, side), kb = kerbH(b, side);
        const ia = a.flags26 & 0x04 ? 3 : 2, ib = b.flags26 & 0x04 ? 3 : 2;
        const oa = 1 + 9 / 32, ob = oa;
        const inA = P(a, side, side * ia, a.z + ka), inB = P(b, side, side * ib, b.z + kb);
        const outA = P(a, side * oa, side, a.z + ka), outB = P(b, side * ob, side, b.z + kb);
        quad(inA, inB, outB, outA, top, 'kerb');
        quad(P(a, side, side, a.z + lift), P(b, side, side, b.z + lift), inB, inA, face, 'kerbFace');
      }
      // fences: vertical, at (h + w)(1 + verge/32), height from the fence table
      for (const side of [-1, 1]) {
        if (!(a.parts & (side === -1 ? PART.fenceLeft : PART.fenceRight))) continue;
        const idxA = side === -1 ? a.fenceIdx & 7 : (a.fenceIdx >> 3) & 7;
        const idxB = side === -1 ? b.fenceIdx & 7 : (b.fenceIdx >> 3) & 7;
        const ba = fenceBase(a, i, side), bb = fenceBase(b, (i + 1) % n, side);
        const ci = T.fence[side === -1 ? a.fenceColours & 15 : a.fenceColours >> 4];
        if (!ci) continue;
        const c = rgb(ci);
        quad(ba, bb, [bb[0], bb[1], bb[2] + T.fenceHeights[idxB]], [ba[0], ba[1], ba[2] + T.fenceHeights[idxA]], c, 'fence');
      }
    }
  };
  strip(scene.lap, true);
  if (scene.pit.length > 1) strip(scene.pit, false);
  const ranges = {};
  let total = 0;
  for (const g of ['ground', 'decals', 'raised']) { ranges[g] = { first: total, count: groups[g].length / stride }; total += groups[g].length / stride; }
  const data = new Float32Array(total * stride);
  let o = 0;
  for (const g of ['ground', 'decals', 'raised']) { data.set(groups[g], o); o += groups[g].length; }
  return { data, origin, counts, ranges, stride };
}

// Runs of segments whose +26 has `bit` (bridged fence on that side). For each
// segment in a run, the fence base on the straight line between the normal
// fence points just before and just after the run.
function bridgeRuns(segs, bit, closed) {
  const n = segs.length, map = new Map();
  const side = bit === 0x20 ? -1 : 1;
  const normalBase = (s) => {
    const v = side === -1 ? s.vergeLeft : s.vergeRight;
    const k = side * (v + 32) / 32;
    return [s.x + 8 * (k * s.hx + k * s.wx), s.y - 8 * (k * s.hy + k * s.wy), s.z];
  };
  let i = 0;
  while (i < n) {
    if (!segs[i] || !(segs[i].flags26 & bit)) { i++; continue; }
    let j = i;
    while (j + 1 < n && segs[j + 1] && segs[j + 1].flags26 & bit) j++;
    const before = segs[(i - 1 + n) % n], after = segs[(j + 1) % n];
    if (before && after && (closed || (i > 0 && j + 1 < n))) {
      const p0 = normalBase(before), p1 = normalBase(after);
      for (let k = i; k <= j; k++) {
        const t = (k - i + 1) / (j - i + 2);
        map.set(k, [p0[0] + (p1[0] - p0[0]) * t, p0[1] + (p1[1] - p0[1]) * t, segs[k].z]);
      }
    }
    i = j + 1;
  }
  return map;
}

/** The live palette (RGB, 0-255) from the game's memory: SS:05DA, 6-bit DAC values. */
export function readPalette(mem) {
  const H = mem.heap(), p = mem.memBase + (mem.SS << 4) + 0x05da;
  return paletteRgb(H.subarray(p, p + 768));
}
