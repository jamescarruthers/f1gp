// A small software renderer that draws track polygons from the game's camera
// with the game's projection, at the game's resolution, so the result can be
// compared pixel by pixel with the game's own frame.
//
// Projection (gp.exe 0F47:20D9, docs/memory-map.md), camera-relative, X/Y in
// 1/8 ft, Z in the game's Z units:
//   lateral = dx*cos(yaw) - dy*sin(yaw),  depth = dx*sin(yaw) + dy*cos(yaw)
//   clip where depth < 8
//   x = 160 + 256*lateral/depth
//   y = top + horizon - ((dz*SS:017C*2) >> 16) * 32 / depth
// 'top' is the viewport's first screen row: 16 in external views, 0 in the
// cockpit view.

export const VSCALE = 0x6e80; // SS:017C

/**
 * Camera from readState().camera and .view.
 * @returns {{x8:number, y8:number, z:number, sin:number, cos:number, horizon:number, top:number, rows:number}}
 */
export function cameraFromState(state) {
  const c = state.camera;
  const yaw = (c.heading / 65536) * 2 * Math.PI;
  const cockpit = state.view.mode === 'cockpit';
  return {
    x8: c.x / 2048, y8: c.y / 2048, z: c.z,
    sin: Math.sin(yaw), cos: Math.cos(yaw),
    horizon: c.horizonRow,
    top: cockpit ? 0 : 16,
    rows: cockpit ? 103 : 164,
  };
}

const NEAR = 8;

function toCamera(cam, p) {
  // p = [x, y, z], x/y in fine units (1/64 ft)
  const dx = p[0] / 8 - cam.x8, dy = p[1] / 8 - cam.y8;
  return [dx * cam.cos - dy * cam.sin, dx * cam.sin + dy * cam.cos, p[2] - cam.z];
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

const K = (VSCALE * 2) / 65536 * 32;

function project(cam, v) {
  return [160 + (256 * v[0]) / v[1], cam.top + cam.horizon - (v[2] * K) / v[1]];
}

/**
 * Fill a polygon (screen coords) into buf with value, pixel centres, even-odd,
 * clipped to rows [y0, y1) and columns [0, width).
 */
function fill(buf, width, y0, y1, pts, value) {
  let minY = Infinity, maxY = -Infinity;
  for (const p of pts) { if (p[1] < minY) minY = p[1]; if (p[1] > maxY) maxY = p[1]; }
  const ys = Math.max(y0, Math.ceil(minY - 0.5)), ye = Math.min(y1 - 1, Math.floor(maxY - 0.5));
  const xs = [];
  for (let y = ys; y <= ye; y++) {
    const yc = y + 0.5;
    xs.length = 0;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      if ((a[1] <= yc) !== (b[1] <= yc)) xs.push(a[0] + ((yc - a[1]) * (b[0] - a[0])) / (b[1] - a[1]));
    }
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const xa = Math.max(0, Math.ceil(xs[k] - 0.5)), xb = Math.min(width - 1, Math.floor(xs[k + 1] - 0.5));
      for (let x = xa; x <= xb; x++) buf[y * width + x] = value;
    }
  }
}

/**
 * Render polygons into a class buffer.
 * @param {object[]} polys  from buildMesh()
 * @param {object} cam      from cameraFromState()
 * @param {object} [opt]
 * @param {Record<string, number>} [opt.classOf]  kind -> class value (default CLASS)
 * @param {number} [opt.maxDepth=6000]  ignore polygons farther than this (1/8 ft)
 * @returns {Uint8Array} width*height classes (0 = not drawn)
 */
export function render(polys, cam, opt = {}) {
  const width = opt.width ?? 320, height = opt.height ?? 200;
  const classOf = opt.classOf ?? CLASS;
  const maxDepth = opt.maxDepth ?? 6000;
  const buf = new Uint8Array(width * height);
  const y0 = cam.top, y1 = cam.top + cam.rows;
  // sky above the horizon, ground below, then the track far to near
  for (let y = y0; y < y1; y++) {
    const v = y + 0.5 < cam.top + cam.horizon ? classOf.sky : classOf.ground;
    buf.fill(v, y * width, (y + 1) * width);
  }
  const items = [];
  for (const p of polys) {
    const cs = p.pts.map((q) => toCamera(cam, q));
    let far = -Infinity, near = Infinity;
    for (const v of cs) { if (v[1] > far) far = v[1]; if (v[1] < near) near = v[1]; }
    if (far < NEAR || near > maxDepth) continue;
    items.push({ p, cs, far });
  }
  const order = { vergeLeft: 0, vergeRight: 0, road: 1, kerbLeft: 2, kerbRight: 2 };
  items.sort((a, b) => b.far - a.far || (order[a.p.kind] ?? 1) - (order[b.p.kind] ?? 1));
  for (const it of items) {
    const clipped = clipNear(it.cs);
    if (clipped.length < 3) continue;
    const scr = clipped.map((v) => project(cam, v));
    let cls = classOf[it.p.kind];
    if (it.p.kind.startsWith('kerb') && classOf.kerbStripe !== undefined && it.p.stripe) cls = classOf.kerbStripe;
    fill(buf, width, y0, y1, scr, cls);
  }
  return buf;
}

export const CLASS = {
  sky: 1, ground: 2, road: 3, vergeLeft: 4, vergeRight: 4, kerbLeft: 5, kerbRight: 5, kerbStripe: 6,
};

/** Project one point (fine units) to the screen, or null if behind the near plane. */
export function projectPoint(cam, p) {
  const v = toCamera(cam, p);
  return v[1] < NEAR ? null : project(cam, v);
}
