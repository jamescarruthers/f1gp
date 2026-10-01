// map-view.mjs - live top-down map of an F1GP session on a 2D canvas.
//
// Plain ES module for the browser (no Node APIs, no game data). It draws a
// circuit outline and every car from lib/f1gp-state.mjs states. map.html
// uses it; probes/p1-map-selftest.mjs checks the pure parts in Node.
//
//   import { MapView, outlineFromTrackFile, outlineFromMemory, snapState } from './map-view.mjs';
//   const view = new MapView(canvas);
//   view.setTrack(outlineFromTrackFile(trackOutline(parseTrack(bytes))));   // or outlineFromMemory(readTrack(mem))
//   // every animation frame:
//   const st = reader.read();
//   if (st.consistent && st.frame !== lastFrame) view.push(snapState(st), performance.now());
//   view.draw(performance.now());
//
// Coordinates: the map works in feet (world units / 16384), X right, Y up,
// which gives the real circuit, not a mirror image (docs/memory-map.md).
// Headings: 0x10000 = one turn, 0 = +Y, 0x4000 = +X (clockwise on the map).
//
// Smoothing: the game moves the cars once per game frame (15 fps in the
// Quick Race). With options.smooth the map shows the last two kept states
// interpolated over one game frame, so it runs one game frame (67 ms) behind
// the game; without it, cars jump once per game frame.
//
// Colours come from CSS custom properties on the canvas (see map.html):
// --map-bg, --map-track, --map-edge, --map-pit, --map-sf, --map-text,
// --car-ai, --car-live, --car-player, --car-retired, --car-ink, --map-cam.

export const WORLD_PER_FOOT = 16384;
export const FEET_PER_METRE = 1 / 0.3048;
const TAU = Math.PI * 2;
const NCARS = 26;
// Half the game's horizontal field of view: x = 160 + 256 * lateral / depth
// (image 0F47:20D9), so the screen edge is at lateral/depth = 160/256.
export const HALF_FOV = Math.atan(160 / 256);

// ------------------------------------------------------------ outlines

function boundsOf(lists) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const pts of lists) for (const p of pts) {
    if (!p) continue;
    if (p[0] < minX) minX = p[0]; if (p[0] > maxX) maxX = p[0];
    if (p[1] < minY) minY = p[1]; if (p[1] > maxY) maxY = p[1];
  }
  return { minX, minY, maxX, maxY };
}
const ft = (p) => (p ? [p[0] / WORLD_PER_FOOT, p[1] / WORLD_PER_FOOT] : null);

/**
 * Map outline from lib/track-file.mjs trackOutline() (world units).
 * Returns { source, lapSegments, centre, left, right, pit, startFinish, bounds } in feet.
 */
export function outlineFromTrackFile(geo, meta = {}) {
  if (geo.units && geo.units !== 'world') throw new Error(`outlineFromTrackFile wants world units, got ${geo.units}`);
  const o = {
    source: 'track file', ...meta,
    lapSegments: geo.centre.length,
    centre: geo.centre.map(ft), left: geo.left.map(ft), right: geo.right.map(ft),
    pit: geo.pit && geo.pit.centre.length ? { centre: geo.pit.centre.map(ft), left: geo.pit.left.map(ft), right: geo.pit.right.map(ft) } : null,
    startFinish: geo.startFinish.map(ft),
  };
  o.bounds = boundsOf([o.left, o.right, o.pit ? o.pit.left : [], o.pit ? o.pit.right : []]);
  return o;
}

/**
 * Map outline from lib/f1gp-state.mjs readTrack(mem): the segments the game
 * holds in memory (lap entries by track index, pit entries in order).
 * Missing lap entries are skipped.
 */
export function outlineFromMemory(tr, meta = {}) {
  const lap = tr.lap.filter(Boolean);
  const o = {
    source: 'game memory', ...meta,
    lapSegments: tr.lap.length,
    centre: lap.map((e) => ft(e.centre)), left: lap.map((e) => ft(e.left)), right: lap.map((e) => ft(e.right)),
    pit: tr.pit.length ? { centre: tr.pit.map((e) => ft(e.centre)), left: tr.pit.map((e) => ft(e.left)), right: tr.pit.map((e) => ft(e.right)) } : null,
    startFinish: lap.length ? [ft(lap[0].left), ft(lap[0].right)] : [],
  };
  o.bounds = boundsOf([o.left, o.right, o.pit ? o.pit.left : [], o.pit ? o.pit.right : []]);
  return o;
}

/**
 * Compare two outlines point by point (same segment count expected):
 * { n, maxCentreFt, maxEdgeFt } or { n: 0, mismatch } when the counts differ.
 */
export function compareOutlines(a, b) {
  if (a.centre.length !== b.centre.length) return { n: 0, mismatch: `${a.centre.length} vs ${b.centre.length} lap segments` };
  let maxC = 0, maxE = 0;
  for (let i = 0; i < a.centre.length; i++) {
    maxC = Math.max(maxC, Math.hypot(a.centre[i][0] - b.centre[i][0], a.centre[i][1] - b.centre[i][1]));
    maxE = Math.max(maxE, Math.hypot(a.left[i][0] - b.left[i][0], a.left[i][1] - b.left[i][1]),
      Math.hypot(a.right[i][0] - b.right[i][0], a.right[i][1] - b.right[i][1]));
  }
  return { n: a.centre.length, maxCentreFt: maxC, maxEdgeFt: maxE };
}

// ------------------------------------------------------------ states

/**
 * The part of a readState() result the map needs, as typed arrays (cheap to
 * keep many of). x/y in feet; flags: 1 player, 2 retired, 4 in pit lane,
 * 8 live (physics mode), 16 no position, 32 not drawn by the game.
 */
export function snapState(st) {
  const n = st.cars.length;
  const s = {
    frame: st.frame, frameMs: st.frameMs, tick: st.tick,
    x: new Float64Array(n), y: new Float64Array(n), h: new Uint16Array(n), v: new Int16Array(n),
    number: new Uint8Array(n), flags: new Uint8Array(n),
    viewed: st.view.viewedSlot, player: st.playerSlot,
    cam: { x: st.camera.x / WORLD_PER_FOOT, y: st.camera.y / WORLD_PER_FOOT, h: st.camera.heading, mode: st.view.mode, isCar: st.view.cameraIsCar },
  };
  for (let i = 0; i < n; i++) {
    const c = st.cars[i];
    s.x[i] = c.x / WORLD_PER_FOOT; s.y[i] = c.y / WORLD_PER_FOOT; s.h[i] = c.heading; s.v[i] = c.speed;
    s.number[i] = c.number;
    s.flags[i] = (c.isPlayer ? 1 : 0) | (c.retired ? 2 : 0) | (c.inPit ? 4 : 0) | (c.pos === 'live' ? 8 : 0) |
      (c.pos === 'none' ? 16 : 0) | (c.visible ? 0 : 32);
  }
  return s;
}

/** Shortest signed difference b - a of two 16-bit angles. */
export function angleDiff(a, b) { return ((((b - a) & 0xffff) + 0x8000) & 0xffff) - 0x8000; }

/**
 * Positions to draw at wall time `now`, from the last two kept snaps.
 * alpha runs 0 -> 1 over the game time between them (frames x frameMs), from
 * the moment `cur` was kept. Cars that moved more than `snapFt` per frame
 * (pit-lane array swaps, retirements put aside) are not interpolated.
 * Writes into out = { x, y, h, alpha } (Float64Arrays) and returns it.
 */
export function interpolate(prev, cur, tCur, now, out, snapFt = 120) {
  const n = cur.x.length;
  if (!out || out.x.length !== n) out = { x: new Float64Array(n), y: new Float64Array(n), h: new Float64Array(n), alpha: 1 };
  let alpha = 1;
  if (prev && cur.frame > prev.frame) {
    const dur = Math.min(400, Math.max(20, (cur.frame - prev.frame) * cur.frameMs));
    alpha = Math.min(1, Math.max(0, (now - tCur) / dur));
  }
  out.alpha = alpha;
  const frames = prev ? Math.max(1, cur.frame - prev.frame) : 1;
  for (let i = 0; i < n; i++) {
    if (!prev || alpha >= 1 || (cur.flags[i] & 16) || (prev.flags[i] & 16)) { out.x[i] = cur.x[i]; out.y[i] = cur.y[i]; out.h[i] = cur.h[i]; continue; }
    const dx = cur.x[i] - prev.x[i], dy = cur.y[i] - prev.y[i];
    if (dx * dx + dy * dy > (snapFt * frames) ** 2) { out.x[i] = cur.x[i]; out.y[i] = cur.y[i]; out.h[i] = cur.h[i]; continue; }
    // draw position = prev + (cur - prev) * alpha, so the car reaches cur when the next game frame is due
    out.x[i] = prev.x[i] + dx * alpha; out.y[i] = prev.y[i] + dy * alpha;
    out.h[i] = (prev.h[i] + angleDiff(prev.h[i], cur.h[i]) * alpha) & 0xffff;
  }
  return out;
}

// ------------------------------------------------------------ trails

/** Ring buffer of the last `cap` positions of every car; NaN marks a break. */
export class Trails {
  constructor(cars = NCARS, cap = 900) {
    this.cap = cap; this.cars = cars;
    this.x = new Float64Array(cars * cap); this.y = new Float64Array(cars * cap);
    this.len = new Int32Array(cars); this.head = new Int32Array(cars); // head = next write index
  }
  clear() { this.len.fill(0); this.head.fill(0); }
  add(i, x, y) {
    const k = i * this.cap + this.head[i];
    this.x[k] = x; this.y[k] = y;
    this.head[i] = (this.head[i] + 1) % this.cap;
    if (this.len[i] < this.cap) this.len[i]++;
  }
  /** Point j back from the newest (0 = newest), or null. */
  at(i, j) {
    if (j >= this.len[i]) return null;
    const k = i * this.cap + ((this.head[i] - 1 - j + this.cap * 2) % this.cap);
    return [this.x[k], this.y[k]];
  }
  /** Push one kept snap: a break (NaN) first when a car jumped further than maxStepFt * frames. */
  push(snap, prev, maxStepFt = 120) {
    const frames = prev ? Math.max(1, snap.frame - prev.frame) : 1;
    for (let i = 0; i < snap.x.length && i < this.cars; i++) {
      if (snap.flags[i] & 16) { this.add(i, NaN, NaN); continue; }
      const last = this.at(i, 0);
      if (last && !Number.isNaN(last[0]) && Math.hypot(snap.x[i] - last[0], snap.y[i] - last[1]) > maxStepFt * frames) this.add(i, NaN, NaN);
      this.add(i, snap.x[i], snap.y[i]);
    }
  }
}

// ------------------------------------------------------------ transform

/** Scale and centre that fit bounds (feet) into a w x h pixel box with `pad` pixels of margin. */
export function fitTransform(b, w, h, pad = 16) {
  const bw = Math.max(1, b.maxX - b.minX), bh = Math.max(1, b.maxY - b.minY);
  const s = Math.min((w - 2 * pad) / bw, (h - 2 * pad) / bh);
  return { s, cx: (b.minX + b.maxX) / 2, cy: (b.minY + b.maxY) / 2, w, h };
}
/** World (feet) to canvas pixels for a transform from fitTransform(). Y up on the map. */
export function toScreen(t, x, y) { return [t.w / 2 + (x - t.cx) * t.s, t.h / 2 - (y - t.cy) * t.s]; }

// ------------------------------------------------------------ the view

const DEFAULTS = {
  smooth: true,          // interpolate between game frames
  trails: false,         // draw car trails
  trailSeconds: 10,      // trail length in game seconds
  numbers: true,         // car numbers in the dots
  follow: 'none',        // 'none' (whole circuit), 'player', 'viewed'
  zoom: 6,               // follow-mode zoom relative to the whole circuit
  camera: true,          // draw the game camera and its field of view
};

export class MapView {
  constructor(canvas, options = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.options = { ...DEFAULTS, ...options };
    this.outline = null;
    this.paths = null;
    this.prev = null; this.cur = null; this.tCur = 0;
    this.trails = new Trails(NCARS, 900);
    this.interp = null;
    this.bg = null; this.bgKey = '';
    this.message = '';
    this.dpr = 1;
    this.readColours();
  }

  setOptions(o) { Object.assign(this.options, o); this.bgKey = ''; }

  /** Re-read the colour tokens (call after a theme change). */
  readColours() {
    const cs = getComputedStyle(this.canvas);
    const v = (name, d) => (cs.getPropertyValue(name) || '').trim() || d;
    this.col = {
      bg: v('--map-bg', '#1a1a19'), track: v('--map-track', '#4a4a48'), edge: v('--map-edge', '#8a8985'),
      pit: v('--map-pit', '#3a3a38'), sf: v('--map-sf', '#ffffff'), text: v('--map-text', '#c3c2b7'),
      ai: v('--car-ai', '#3987e5'), live: v('--car-live', '#199e70'), player: v('--car-player', '#d95926'),
      retired: v('--car-retired', '#77766f'), ink: v('--car-ink', '#ffffff'), cam: v('--map-cam', '#ffffff'),
    };
    this.bgKey = '';
  }

  setTrack(outline) {
    this.outline = outline;
    this.paths = outline ? buildPaths(outline) : null;
    this.bgKey = '';
  }

  /** Forget cars and trails (new session, or the clock went back). */
  clear() { this.prev = null; this.cur = null; this.trails.clear(); }

  /** Keep a new game frame (a snapState() result, ideally from a consistent read). */
  push(snap, now) {
    if (this.cur && snap.frame <= this.cur.frame) {
      if (snap.frame === this.cur.frame) return;
      this.clear(); // the clock went back: a new session or a replay
    }
    this.trails.push(snap, this.cur);
    this.prev = this.cur; this.cur = snap; this.tCur = now;
  }

  resize() {
    const r = this.canvas.getBoundingClientRect();
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(r.height * dpr));
    if (w !== this.canvas.width || h !== this.canvas.height || dpr !== this.dpr) {
      this.canvas.width = w; this.canvas.height = h; this.dpr = dpr; this.bgKey = '';
    }
  }

  /** The transform for this frame: the whole circuit, or zoomed on a car. */
  transform(pos) {
    const W = this.canvas.width, H = this.canvas.height, dpr = this.dpr;
    const b = this.outline ? this.outline.bounds : { minX: -1000, minY: -1000, maxX: 1000, maxY: 1000 };
    const t = fitTransform(b, W, H, 14 * dpr);
    const o = this.options;
    if (o.follow !== 'none' && this.cur && pos) {
      const slot = o.follow === 'viewed' && this.cur.viewed !== null ? this.cur.viewed : this.cur.player;
      if (slot !== null && slot >= 0) { t.s *= o.zoom; t.cx = pos.x[slot]; t.cy = pos.y[slot]; t.follow = slot; }
    }
    return t;
  }

  /** Draw the map for wall time `now`. Returns the time it took in ms. */
  draw(now) {
    const t0 = performance.now();
    this.resize();
    const ctx = this.ctx, W = this.canvas.width, H = this.canvas.height, dpr = this.dpr, o = this.options, C = this.col;
    const pos = this.cur ? (this.interp = interpolate(o.smooth ? this.prev : null, this.cur, this.tCur, now, this.interp)) : null;
    const t = this.transform(pos);

    // background and track: cached while the transform does not change
    const key = `${W}x${H}/${t.s}/${t.cx}/${t.cy}`;
    if (t.follow === undefined) {
      if (key !== this.bgKey) { this.bg = this.renderBackground(t); this.bgKey = key; }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(this.bg, 0, 0);
    } else {
      this.drawBackground(ctx, t);
    }

    if (this.cur) {
      const cur = this.cur;
      if (o.trails) this.drawTrails(ctx, t, pos);
      if (o.camera) this.drawCamera(ctx, t, pos);
      // cars: computer cars first, then the viewed car, then the player on top
      const order = [];
      for (let i = 0; i < cur.x.length; i++) if (i !== cur.player && i !== cur.viewed) order.push(i);
      if (cur.viewed !== null && cur.viewed !== cur.player) order.push(cur.viewed);
      if (cur.player !== null && cur.player >= 0) order.push(cur.player);
      const r = 7 * dpr;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.font = `600 ${Math.round(9 * dpr)}px system-ui, sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      for (const i of order) {
        const f = cur.flags[i];
        if (f & 16) continue;
        const [sx, sy] = toScreen(t, pos.x[i], pos.y[i]);
        if (sx < -20 || sy < -20 || sx > W + 20 || sy > H + 20) continue;
        const player = (f & 1) !== 0, retired = (f & 2) !== 0, pit = (f & 4) !== 0, live = (f & 8) !== 0;
        const rr = player ? r * 1.2 : r;
        const fill = retired ? null : player ? C.player : live ? C.live : C.ai;
        ctx.beginPath();
        if (pit) ctx.rect(sx - rr * 0.9, sy - rr * 0.9, rr * 1.8, rr * 1.8);
        else ctx.arc(sx, sy, rr, 0, TAU);
        // 2 px ring in the surface colour keeps overlapping dots apart
        ctx.lineWidth = 2 * dpr; ctx.strokeStyle = C.bg; ctx.stroke();
        if (fill) { ctx.fillStyle = fill; ctx.fill(); }
        else { ctx.lineWidth = 1.5 * dpr; ctx.strokeStyle = C.retired; ctx.stroke(); }
        // heading tick
        const a = (pos.h[i] / 65536) * TAU;
        ctx.beginPath();
        ctx.moveTo(sx + Math.sin(a) * rr, sy - Math.cos(a) * rr);
        ctx.lineTo(sx + Math.sin(a) * (rr + 4 * dpr), sy - Math.cos(a) * (rr + 4 * dpr));
        ctx.lineWidth = 2 * dpr; ctx.strokeStyle = fill || C.retired; ctx.stroke();
        if (i === cur.viewed) {
          ctx.beginPath(); ctx.arc(sx, sy, rr + 3.5 * dpr, 0, TAU);
          ctx.lineWidth = 1.5 * dpr; ctx.strokeStyle = C.cam; ctx.stroke();
        }
        if (o.numbers) { ctx.fillStyle = retired ? C.retired : C.ink; ctx.fillText(String(cur.number[i]), sx, sy + 0.5 * dpr); }
      }
      if (o.camera) this.drawCameraPoint(ctx);
    }

    if (this.message) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.font = `${Math.round(13 * dpr)}px system-ui, sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillStyle = C.text;
      ctx.fillText(this.message, W / 2, H / 2);
    }
    // scale bar: 500 m (or 100 m when zoomed in)
    this.drawScale(ctx, t);
    return performance.now() - t0;
  }

  renderBackground(t) {
    const c = (typeof OffscreenCanvas !== 'undefined') ? new OffscreenCanvas(t.w, t.h) : Object.assign(document.createElement('canvas'), { width: t.w, height: t.h });
    this.drawBackground(c.getContext('2d'), t);
    return c;
  }

  drawBackground(ctx, t) {
    const C = this.col, dpr = this.dpr;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = C.bg; ctx.fillRect(0, 0, t.w, t.h);
    if (!this.paths) return;
    // world (feet) -> pixels
    ctx.setTransform(t.s, 0, 0, -t.s, t.w / 2 - t.cx * t.s, t.h / 2 + t.cy * t.s);
    const px = 1 / t.s; // one canvas pixel in feet
    const p = this.paths;
    if (p.pit) { ctx.fillStyle = C.pit; ctx.fill(p.pit); ctx.lineWidth = 1 * dpr * px; ctx.strokeStyle = C.edge; ctx.globalAlpha = 0.6; ctx.stroke(p.pit); ctx.globalAlpha = 1; }
    ctx.fillStyle = C.track; ctx.fill(p.ring, 'evenodd');
    ctx.lineWidth = 1 * dpr * px; ctx.strokeStyle = C.edge; ctx.stroke(p.ring);
    // the track can be under a pixel wide when zoomed out: keep a visible centre line
    if (t.s * 30 < 2 * dpr) { ctx.lineWidth = 2 * dpr * px; ctx.strokeStyle = C.track; ctx.stroke(p.centre); }
    if (p.sf) { ctx.lineWidth = 2.5 * dpr * px; ctx.strokeStyle = C.sf; ctx.stroke(p.sf); }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  drawTrails(ctx, t, pos) {
    const o = this.options, C = this.col, dpr = this.dpr, cur = this.cur, tr = this.trails;
    const fps = cur.frameMs > 0 ? 1000 / cur.frameMs : 15;
    const n = Math.min(tr.cap, Math.max(2, Math.round(o.trailSeconds * fps)));
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    const CHUNKS = 6;
    // while a car is drawn between two frames, the newest trail point is still ahead of it: start one back
    const first = o.smooth && pos.alpha < 1 ? 1 : 0;
    const hw = t.w / 2, hh = t.h / 2, s = t.s, cx = t.cx, cy = t.cy, cap = tr.cap;
    for (let i = 0; i < cur.x.length; i++) {
      const f = cur.flags[i];
      if (f & 16) continue;
      const len = Math.min(n, tr.len[i]) - first;
      if (len < 2) continue;
      ctx.strokeStyle = (f & 1) ? C.player : (f & 2) ? C.retired : (f & 8) ? C.live : C.ai;
      ctx.lineWidth = ((f & 1) ? 2.5 : 1.5) * dpr;
      const base = i * cap, head = tr.head[i];
      // newest chunk first (most opaque); chunk k covers trail points first + [k*len/CHUNKS, (k+1)*len/CHUNKS]
      for (let k = 0; k < CHUNKS; k++) {
        const j0 = first + Math.floor((k * len) / CHUNKS), j1 = first + Math.min(len - 1, Math.ceil(((k + 1) * len) / CHUNKS));
        if (j1 <= j0) continue;
        ctx.globalAlpha = 0.85 * (1 - k / CHUNKS);
        ctx.beginPath();
        let pen = false;
        if (k === 0) { ctx.moveTo(hw + (pos.x[i] - cx) * s, hh - (pos.y[i] - cy) * s); pen = true; }
        for (let j = j0; j <= j1; j++) {
          const q = base + ((head - 1 - j + cap * 2) % cap);
          const x = tr.x[q], y = tr.y[q];
          if (Number.isNaN(x)) { pen = false; continue; }
          const sx = hw + (x - cx) * s, sy = hh - (y - cy) * s;
          if (pen) ctx.lineTo(sx, sy); else { ctx.moveTo(sx, sy); pen = true; }
        }
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
  }

  // The game's camera: its position (DS:2259/225D) and horizontal field of view (DS:2261 yaw).
  drawCamera(ctx, t, pos) {
    const cur = this.cur, C = this.col, dpr = this.dpr;
    let x = cur.cam.x, y = cur.cam.y;
    // in cockpit view the camera is the viewed car: follow its interpolated position
    if (cur.cam.isCar && cur.viewed !== null && pos) { x = pos.x[cur.viewed]; y = pos.y[cur.viewed]; }
    const [sx, sy] = toScreen(t, x, y);
    const a = (cur.cam.h / 65536) * TAU;
    const L = Math.max(40 * dpr, Math.min(600 * t.s, 160 * dpr)); // about 600 ft, at least 40 px
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.lineTo(sx + Math.sin(a - HALF_FOV) * L, sy - Math.cos(a - HALF_FOV) * L);
    ctx.arc(sx, sy, L, a - HALF_FOV - Math.PI / 2, a + HALF_FOV - Math.PI / 2);
    ctx.closePath();
    ctx.globalAlpha = 0.14; ctx.fillStyle = C.cam; ctx.fill();
    ctx.globalAlpha = 0.6; ctx.lineWidth = 1 * dpr; ctx.strokeStyle = C.cam; ctx.stroke();
    ctx.globalAlpha = 1;
    this.camAt = cur.cam.isCar ? null : [sx, sy];
  }

  // The camera's own position in external views, drawn over the cars (a chase camera is only 30 ft behind its car).
  drawCameraPoint(ctx) {
    if (!this.camAt) return;
    const C = this.col, dpr = this.dpr, [sx, sy] = this.camAt;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.beginPath(); ctx.arc(sx, sy, 3 * dpr, 0, TAU);
    ctx.fillStyle = C.cam; ctx.fill();
    ctx.lineWidth = 1.5 * dpr; ctx.strokeStyle = C.bg; ctx.stroke();
  }

  drawScale(ctx, t) {
    const C = this.col, dpr = this.dpr;
    const metres = t.s * FEET_PER_METRE * 500 > 260 * dpr ? 100 : 500;
    const len = metres * FEET_PER_METRE * t.s;
    const x0 = 12 * dpr, y0 = t.h - 12 * dpr;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.strokeStyle = C.text; ctx.lineWidth = 1.5 * dpr;
    ctx.beginPath(); ctx.moveTo(x0, y0 - 4 * dpr); ctx.lineTo(x0, y0); ctx.lineTo(x0 + len, y0); ctx.lineTo(x0 + len, y0 - 4 * dpr); ctx.stroke();
    ctx.fillStyle = C.text; ctx.font = `${Math.round(11 * dpr)}px system-ui, sans-serif`;
    ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
    ctx.fillText(`${metres} m`, x0 + 4 * dpr, y0 - 3 * dpr);
  }
}

function buildPaths(o) {
  const loop = (pts) => { const p = new Path2D(); pts.forEach((q, i) => (i ? p.lineTo(q[0], q[1]) : p.moveTo(q[0], q[1]))); p.closePath(); return p; };
  const ring = new Path2D();
  ring.addPath(loop(o.left)); ring.addPath(loop(o.right));
  const centre = loop(o.centre);
  let pit = null;
  if (o.pit && o.pit.left.length > 1) {
    pit = new Path2D();
    o.pit.left.forEach((q, i) => (i ? pit.lineTo(q[0], q[1]) : pit.moveTo(q[0], q[1])));
    for (let i = o.pit.right.length - 1; i >= 0; i--) pit.lineTo(o.pit.right[i][0], o.pit.right[i][1]);
    pit.closePath();
  }
  let sf = null;
  if (o.startFinish && o.startFinish.length === 2) { sf = new Path2D(); sf.moveTo(...o.startFinish[0]); sf.lineTo(...o.startFinish[1]); }
  return { ring, centre, pit, sf };
}

// ------------------------------------------------------------ car table

const STATUS = (c) => (c.retired ? 'retired' : c.pitState === 2 ? 'on the jacks' : c.inPit ? 'pit lane' : c.pitting ? 'pitting' : '');

/**
 * Rows for the car table, in race order: { slot, pos, number, name, lap, mph, source, status, player, viewed }.
 */
export function tableRows(st) {
  const order = st.raceOrder.length === st.cars.length ? st.raceOrder : st.cars.map((c) => c.slot).sort((a, b) => st.cars[a].racePos - st.cars[b].racePos);
  return order.map((slot) => {
    const c = st.cars[slot];
    return { slot, pos: c.racePos, number: c.number, name: c.name, lap: c.lap, mph: c.speedMph, source: c.pos, status: STATUS(c),
      player: c.isPlayer, viewed: slot === st.view.viewedSlot };
  });
}

/** A table body kept in step with tableRows(): reuses its row elements and only touches changed text. */
export class CarTable {
  constructor(tbody) { this.tbody = tbody; this.rows = []; }
  update(rows) {
    const doc = this.tbody.ownerDocument;
    while (this.rows.length < rows.length) {
      const tr = doc.createElement('tr');
      const cells = [];
      for (let k = 0; k < 7; k++) { const td = doc.createElement('td'); tr.appendChild(td); cells.push(td); }
      this.tbody.appendChild(tr);
      this.rows.push({ tr, cells, text: [], cls: '' });
    }
    while (this.rows.length > rows.length) { this.rows.pop().tr.remove(); }
    rows.forEach((r, i) => {
      const row = this.rows[i];
      const text = [r.pos, r.number, r.name, r.lap, r.mph, r.source, r.status];
      for (let k = 0; k < 7; k++) {
        const s = String(text[k]);
        if (row.text[k] !== s) { row.cells[k].textContent = s; row.text[k] = s; }
      }
      const cls = (r.player ? 'player ' : '') + (r.viewed ? 'viewed ' : '') + (r.status === 'retired' ? 'retired ' : '') + (r.source !== 'derived' ? `src-${r.source}` : '');
      if (cls !== row.cls) { row.tr.className = cls; row.cls = cls; }
    });
  }
}
