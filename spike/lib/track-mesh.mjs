// Track geometry for the new renderer: road, kerb and verge polygons, built
// from the game's 16 ft segments.
//
// Segments come either from the track file (compileTrack in track-file.mjs)
// or from the game's memory (readTrack in f1gp-state.mjs). fromCompiled() and
// fromMemory() turn both into the same form, in the game's own units:
//   x, y   segment start, fine units (1/64 ft), as in the game's segment array
//   z      height, the game's Z units (segment +06)
//   sx, sy half-width vector in 1/8 ft (segment +0C/+0E upper bits);
//          right edge = (x + 8*sx, y - 8*sy), left edge = (x - 8*sx, y + 8*sy)
//
// Polygons are lists of [x, y, z] points in fine units, with a kind:
// 'road', 'kerbLeft', 'kerbRight', 'vergeLeft', 'vergeRight'. The pit lane
// is built the same way from compilePitLane() segments, with closed = false.

/** Segments from compileTrack(parseTrack(bytes)).segs. */
export function fromCompiled(segs) {
  return segs.map((s) => ({
    index: s.index, section: s.section, x: s.x, y: s.y, z: s.z, sx: s.sideX, sy: s.sideY,
  }));
}

/** Segments from readTrack(mem).lap (world units = fine * 256). */
export function fromMemory(lap) {
  return lap.map((e) => {
    const x = e.centre[0] / 256, y = e.centre[1] / 256;
    return {
      index: e.index, section: null, x, y, z: e.z,
      sx: (e.right[0] / 256 - x) / 8, sy: (y - e.right[1] / 256) / 8,
    };
  });
}

function edge(s, side, extraFine = 0) {
  // side: +1 right, -1 left. extraFine widens the edge outwards.
  const len = Math.hypot(s.sx, s.sy) * 8 || 1;
  const k = side * (1 + extraFine / len);
  return [s.x + 8 * s.sx * k, s.y - 8 * s.sy * k, s.z];
}

/**
 * Build polygons for every segment.
 * @param {object[]} segs  from fromCompiled() or fromMemory()
 * @param {object} [opt]
 * @param {object} [opt.track]  parseTrack() result, for kerbs and verges
 * @param {number} [opt.kerbWidth=48]  kerb width in fine units (guess until the game's rule is known)
 * @param {number} [opt.vergeScale=16] fine units per verge-width unit (guess)
 * @param {boolean} [opt.closed=true]  join the last segment to the first (a lap)
 */
export function buildMesh(segs, opt = {}) {
  const n = segs.length;
  const polys = [];
  const kerbs = opt.track ? kerbSegments(opt.track, segs) : null;
  const verges = opt.track ? vergeWidths(opt.track, segs) : null;
  const kw = opt.kerbWidth ?? 48;
  const vs = opt.vergeScale ?? 16;
  const count = opt.closed === false ? n - 1 : n;
  for (let i = 0; i < count; i++) {
    const a = segs[i], b = segs[(i + 1) % n];
    const quad = (sideA, sideB, ea0, ea1, eb0, eb1) => [
      edge(a, sideA, ea0), edge(b, sideA, eb0), edge(b, sideB, eb1), edge(a, sideB, ea1),
    ];
    polys.push({ kind: 'road', seg: i, pts: [edge(a, -1), edge(b, -1), edge(b, 1), edge(a, 1)] });
    if (verges) {
      const [vl, vr] = verges[i];
      if (vl > 0) polys.push({ kind: 'vergeLeft', seg: i, pts: [edge(a, -1, vl * vs), edge(b, -1, vl * vs), edge(b, -1), edge(a, -1)] });
      if (vr > 0) polys.push({ kind: 'vergeRight', seg: i, pts: [edge(a, 1), edge(b, 1), edge(b, 1, vr * vs), edge(a, 1, vr * vs)] });
    }
    if (kerbs) {
      if (kerbs.left[i]) polys.push({ kind: 'kerbLeft', seg: i, stripe: i & 1, pts: quad(-1, -1, kw, 0, kw, 0) });
      if (kerbs.right[i]) polys.push({ kind: 'kerbRight', seg: i, stripe: i & 1, pts: quad(1, 1, 0, kw, 0, kw) });
    }
  }
  return polys;
}

// Kerb commands 0x8E/0x8F: [0, distance into section (TLU), length (TLU)].
function kerbSegments(track, segs) {
  const firstSeg = new Map();
  for (const s of segs) if (s.section !== null && !firstSeg.has(s.section)) firstSeg.set(s.section, s.index);
  const left = new Uint8Array(segs.length), right = new Uint8Array(segs.length);
  for (const sec of track.sections) {
    const start = firstSeg.get(sec.index);
    if (start === undefined) continue;
    for (const c of sec.commands) {
      if (c.cmd !== 0x8e && c.cmd !== 0x8f) continue;
      const from = start + (c.args[1] | 0), len = c.args[2] | 0;
      const arr = c.cmd === 0x8e ? left : right;
      for (let k = 0; k < len; k++) arr[(from + k) % segs.length] = 1;
    }
  }
  return { left, right };
}

function vergeWidths(track, segs) {
  const bySection = new Map(track.sections.map((s) => [s.index, [s.leftVerge, s.rightVerge]]));
  return segs.map((s) => bySection.get(s.section) || [0, 0]);
}
