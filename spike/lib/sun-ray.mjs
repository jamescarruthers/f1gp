// Whether points are in the sun or in a shape's shadow, on the CPU, for the
// cockpit's light (render.html): a ray from each point toward the sun against
// the triangles of the shapes that cast shadows (the same casters as the
// renderer's shadow map, gl-track.mjs updateShadows), found through a grid of
// 64 ft cells on the ground. Exact, and it does not wait on the GPU.
//
// Coordinates as the renderer's vertex data: x, y fine units relative to the
// renderer's origin, z in Z units (the same scale).
//
// Plain ES module.

/**
 * The casters' triangles in a grid.
 * @param {{ data: Float32Array, stride: number, first?: number, count: number }[]} arrays
 *   vertex arrays of whole triangles (three vertices each, x, y, z first)
 * @param {number} [cell] the grid's cell, fine units
 */
export function casterGrid(arrays, cell = 64 * 64) {
  let n = 0;
  for (const a of arrays) n += Math.floor(a.count / 3);
  const tris = new Float32Array(n * 9);
  const cells = new Map();
  let t = 0, maxZ = -Infinity;
  const key = (i, j) => (i + 32768) * 65536 + (j + 32768);
  for (const a of arrays) {
    const first = a.first ?? 0;
    for (let k = 0; k + 2 < a.count; k += 3) {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (let v = 0; v < 3; v++) {
        const o = (first + k + v) * a.stride;
        const x = a.data[o], y = a.data[o + 1], z = a.data[o + 2];
        tris[t * 9 + v * 3] = x; tris[t * 9 + v * 3 + 1] = y; tris[t * 9 + v * 3 + 2] = z;
        x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
        maxZ = Math.max(maxZ, z);
      }
      // half a cell more each way, so the cells a ray is sampled in always include its triangles
      const i0 = Math.floor((x0 - cell / 2) / cell), i1 = Math.floor((x1 + cell / 2) / cell);
      const j0 = Math.floor((y0 - cell / 2) / cell), j1 = Math.floor((y1 + cell / 2) / cell);
      for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
        const kk = key(i, j);
        let list = cells.get(kk);
        if (!list) cells.set(kk, (list = []));
        list.push(t);
      }
      t++;
    }
  }
  return { tris, cells, cell, maxZ, key, stamp: new Uint32Array(n), pass: 0 };
}

/**
 * True when the ray from p toward the sun (a unit vector, z up) meets none of the grid's
 * triangles before it rises above the highest of them.
 */
export function inSun(grid, p, sun) {
  if (sun[2] <= 0) return false;
  const rise = grid.maxZ - p[2];
  if (rise <= 0) return true;
  const hl = Math.hypot(sun[0], sun[1]);
  const reach = (rise / sun[2]) * hl;                 // how far it goes across the ground before it is above everything
  const hx = hl > 0 ? sun[0] / hl : 0, hy = hl > 0 ? sun[1] / hl : 0;
  const { cell, cells, tris, key } = grid;
  const pass = ++grid.pass;
  const steps = Math.ceil(reach / (cell / 2)) + 1;
  for (let s = 0; s <= steps; s++) {
    const d = Math.min(reach, (s * cell) / 2);
    const list = cells.get(key(Math.floor((p[0] + hx * d) / cell), Math.floor((p[1] + hy * d) / cell)));
    if (!list) continue;
    for (const t of list) {
      if (grid.stamp[t] === pass) continue;
      grid.stamp[t] = pass;
      if (hits(tris, t * 9, p, sun)) return false;
    }
  }
  return true;
}

/** The share of points in the sun (0-1). */
export function sunShare(grid, points, sun) {
  if (!points.length) return 1;
  let lit = 0;
  for (const p of points) if (inSun(grid, p, sun)) lit++;
  return lit / points.length;
}

// Möller-Trumbore: the ray p + t * d (t > a little) against triangle o in tris
function hits(T, o, p, d) {
  const e1x = T[o + 3] - T[o], e1y = T[o + 4] - T[o + 1], e1z = T[o + 5] - T[o + 2];
  const e2x = T[o + 6] - T[o], e2y = T[o + 7] - T[o + 1], e2z = T[o + 8] - T[o + 2];
  const px = d[1] * e2z - d[2] * e2y, py = d[2] * e2x - d[0] * e2z, pz = d[0] * e2y - d[1] * e2x;
  const det = e1x * px + e1y * py + e1z * pz;
  if (Math.abs(det) < 1e-9) return false;
  const inv = 1 / det;
  const tx = p[0] - T[o], ty = p[1] - T[o + 1], tz = p[2] - T[o + 2];
  const u = (tx * px + ty * py + tz * pz) * inv;
  if (u < 0 || u > 1) return false;
  const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
  const v = (d[0] * qx + d[1] * qy + d[2] * qz) * inv;
  if (v < 0 || u + v > 1) return false;
  return (e2x * qx + e2y * qy + e2z * qz) * inv > 1;
}
