// p2-capture-check.cjs - check the Phase 2 reference frames made by
// probes/p2-capture.cjs and build the index and the colour inventory.
//
//   node probes/p2-capture-check.cjs [--only 04,12]
//
// For every out/p2-ref/<NN>/<k>.png + <k>.json:
//   - projects the lap's road edges with the game's camera and projection
//     (probes/p2-capture-lib.cjs, maths from probes/p2-overlay.mjs) and
//     measures how far they are from the game's road boundary found by
//     colour (edgeCheck); saves <k>-overlay.png (lap edges magenta/cyan,
//     pit lane yellow/orange, found boundaries: verge start green, road grey
//     end orange);
//   - for frames taken while moving, repeats the check with the camera of
//     each of the last 3 frames, to see which frame the screen shows;
//   - counts pixel colours inside the projected road, near its edges,
//     outside it below the horizon and above the horizon.
// Pixels that are not the 3D view are left out: the cockpit and the own car
// in chase view (pixels with the same colour in >= 90% / 60% of that view's
// frames over all circuits, grown by 1 px), the "Viewing ..." banner when
// shown, and rows outside the viewport.
// Writes out/p2-ref/index.json and out/p2-ref/colours.json.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const L = require('./p2-capture-lib.cjs');
const { encodePng } = require('../lib/node-emu.cjs');

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const ROOT = path.join(__dirname, '..', 'out', 'p2-ref');
const ONLY = opt('only', null) ? opt('only').split(',') : null;
const TRACK_NAMES = ['Phoenix', 'Interlagos', 'Imola', 'Monaco', 'Montreal', 'Mexico City', 'Magny-Cours', 'Silverstone', 'Hockenheim',
  'Hungaroring', 'Spa-Francorchamps', 'Monza', 'Estoril', 'Barcelona', 'Suzuka', 'Adelaide'];
const W = 320, H = 200;

const dirs = fs.readdirSync(ROOT).filter((d) => /^\d\d$/.test(d)).sort();
const frames = [];
for (const d of dirs) {
  const files = fs.readdirSync(path.join(ROOT, d)).filter((f) => /^\d+\.json$/.test(f)).sort();
  for (const f of files) frames.push({ dir: d, k: f.replace('.json', ''), json: path.join(ROOT, d, f), png: path.join(ROOT, d, f.replace('.json', '.png')) });
}
console.log(`${frames.length} frames in ${dirs.length} circuits`);

// ---------------------------------------------------------------- static overlay masks per view
// (computed over every circuit, so the scene underneath varies)
const staticMask = {};
{
  const acc = {};
  for (const fr of frames) {
    const j = JSON.parse(fs.readFileSync(fr.json, 'utf8'));
    const v = j.view;
    if (v !== 'cockpit' && v !== 'chase') continue;
    if (!j.stop) continue; // moving captures
    const img = L.decodePng(fr.png);
    if (!acc[v]) acc[v] = { n: 0, counts: Array.from({ length: W * H }, () => new Map()) };
    acc[v].n++;
    for (let i = 0; i < W * H; i++) {
      const k = L.key(img.data[i * 4], img.data[i * 4 + 1], img.data[i * 4 + 2]);
      const m = acc[v].counts[i];
      m.set(k, (m.get(k) || 0) + 1);
    }
  }
  for (const v of Object.keys(acc)) {
    const thr = v === 'cockpit' ? 0.9 : 0.6;
    const bin = new Uint8Array(W * H);
    for (let i = 0; i < W * H; i++) {
      let best = 0, bestK = 0;
      for (const [k, c] of acc[v].counts[i]) if (c > best) { best = c; bestK = k; }
      const [r, g, b] = L.rgbOf(bestK);
      // the sky gradient sits at the same rows in most frames: a sky-blue "static" pixel is sky, not cockpit
      const skyLike = b > r + 30 && b >= g && Math.floor(i / W) < 103;
      if (best >= thr * acc[v].n && !skyLike) bin[i] = 1;
    }
    staticMask[v] = L.dilate(bin, W, H, 1);
    let n = 0; for (const b of staticMask[v]) n += b;
    // for a look: white = masked
    const vis = new Uint8Array(W * H * 3);
    for (let i = 0; i < W * H; i++) vis[i * 3] = vis[i * 3 + 1] = vis[i * 3 + 2] = staticMask[v][i] ? 255 : 0;
    fs.writeFileSync(path.join(ROOT, `_mask-${v}.png`), encodePng(W, H, vis, 3));
    console.log(`static mask ${v}: ${n} px from ${acc[v].n} frames`);
  }
}
const ignoreFor = (j) => {
  const ig = new Uint8Array(W * H);
  const st = staticMask[j.view];
  if (st) for (let i = 0; i < W * H; i++) ig[i] = st[i];
  if (j.banner) for (let y = 0; y < 26; y++) for (let x = 26; x < 294; x++) ig[y * W + x] = 1;
  return ig;
};

// ---------------------------------------------------------------- per frame
const index = [];
const colourAcc = new Map(); // key -> { road, edge, outside, above, byCircuit: {NN: n}, byView: {}, texOff: n }
const surf = {}; // NN -> 'on'|'off' -> region -> Map(colour -> n)
const addColour = (k, region, d, view, texOff) => {
  const t = texOff ? 'off' : 'on';
  const a = ((surf[d] = surf[d] || {})[t] = surf[d][t] || {});
  const m = (a[region] = a[region] || new Map());
  m.set(k, (m.get(k) || 0) + 1);
  let e = colourAcc.get(k);
  if (!e) { e = { road: 0, edge: 0, outside: 0, above: 0, circuits: {}, views: {}, texOff: 0 }; colourAcc.set(k, e); }
  e[region]++; e.circuits[d] = (e.circuits[d] || 0) + 1; e.views[view] = (e.views[view] || 0) + 1; if (texOff) e.texOff++;
};
const tracks = {};
const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0);
for (const fr of frames) {
  if (ONLY && !ONLY.includes(fr.dir)) continue;
  if (!tracks[fr.dir]) tracks[fr.dir] = JSON.parse(fs.readFileSync(path.join(ROOT, fr.dir, 'track.json'), 'utf8'));
  const track = tracks[fr.dir];
  const j = JSON.parse(fs.readFileSync(fr.json, 'utf8'));
  const img = L.decodePng(fr.png);
  const ignore = ignoreFor(j);
  const k017c = j.extra.ss017C;
  const centre = j.state.cars[j.state.view.viewedSlot ?? j.state.playerSlot].trackIndex;
  const c = L.edgeCheck(img, j.state, track, { k017c, ignore, centre });
  const ov = L.overlay(img, j.state, track, { k017c, check: c, centre });
  fs.writeFileSync(path.join(ROOT, fr.dir, `${fr.k}-overlay.png`), encodePng(ov.width, ov.height, ov.data, 4));
  const pick = (r) => ({ medianErrPx: r.medianErr, meanErrPx: r.meanErr, p90ErrPx: r.p90Err, samples: r.samples, found: r.found, within1: r.within1, within2: r.within2, byEvidence: r.byEvidence,
    medianInnerSignedPx: r.medianInner, medianOuterSignedPx: r.medianOuter, medianAbsInnerPx: r.medianAbsInner, medianAbsOuterPx: r.medianAbsOuter,
    vergeLikeRoad: r.vergeLikeRoad, reliable: r.vergeLikeRoad !== null && r.vergeLikeRoad < 0.3 && r.found >= 10 });
  // which of the last frames' cameras fits the picture best
  let historyCheck = null;
  // frames taken at a stop count as standing: the car creeps by < 0.3 ft/s (speed field 8-20), 0.004 ft per frame
  const moving = !j.stop;
  if (moving && j.history && j.history.length) {
    historyCheck = j.history.map((h) => {
      const r = L.edgeCheck(img, { camera: h.camera, view: { mode: h.view } }, track, { k017c, ignore, centre });
      // a stricter score for comparing candidates: mean of the inner-boundary error over samples found
      const inner = r.measurements.filter((m) => m.errInner !== null).map((m) => Math.abs(m.errInner));
      return { tick: h.tick, current: h.current, ...pick(r), meanAbsInnerPx: inner.length ? +(inner.reduce((a, b) => a + b, 0) / inner.length).toFixed(3) : null };
    });
  }
  // colours: regions from the predicted road mask
  const texOff = j.texture && j.texture.on === false;
  const m = c.mask.mask;
  const near = L.dilate(m, W, H, 2);
  const inner = L.erode(Uint8Array.from(m, (v) => (v ? 1 : 0)), W, H, 2);
  const [vy0, vy1] = c.viewport;
  const hy = Math.ceil(c.horizonY);
  const counts = { road: 0, edge: 0, outside: 0, above: 0 };
  for (let y = vy0; y < vy1; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x;
    if (ignore[i]) continue;
    let region;
    if (inner[i]) region = 'road';
    else if (near[i]) region = 'edge';
    else if (y < hy) region = 'above';
    else region = 'outside';
    const o = i * 4;
    addColour(L.key(img.data[o], img.data[o + 1], img.data[o + 2]), region, fr.dir, j.view, texOff);
    counts[region]++;
  }
  const st = j.state, cam = st.camera;
  const viewed = st.cars[st.view.viewedSlot ?? st.playerSlot];
  // the road where the viewed car stands and just ahead: heading change (deg) and height change over the next 10 segments (160 ft)
  const n = track.lap.length, ti = viewed.trackIndex;
  const wrap16 = (v) => (((v & 0xffff) + 0x8000) & 0xffff) - 0x8000;
  const lapAt = (i) => track.lap[((i % n) + n) % n];
  const turnAhead = +((wrap16(lapAt(ti + 10).heading - lapAt(ti).heading) * 360) / 65536).toFixed(1);
  const climbAhead = lapAt(ti + 10).z - lapAt(ti).z;
  const fromLine = Math.min(ti, n - ti);
  const where = fromLine <= 30 ? 'start/finish straight' : Math.abs(turnAhead) >= 10 ? (turnAhead > 0 ? 'corner ahead (right)' : 'corner ahead (left)') : Math.abs(climbAhead) >= 60 ? (climbAhead > 0 ? 'uphill' : 'downhill') : 'straight';
  const entry = {
    id: `${fr.dir}/${fr.k}`, file: +fr.dir, circuitIndex: j.circuitIndex, circuit: j.circuitName, track: TRACK_NAMES[+fr.dir - 1], k: +fr.k,
    png: `${fr.dir}/${fr.k}.png`, json: `${fr.dir}/${fr.k}.json`, overlay: `${fr.dir}/${fr.k}-overlay.png`,
    view: j.view, label: j.label, stop: j.stop ? { n: j.stop.n, role: j.stop.target.role, targetIndex: j.stop.target.index } : null,
    moving, speedMph: viewed.speedMph, speedRaw: viewed.speed, banner: j.banner, texture: j.texture.on, textureToggledFromDefault: j.texture.toggledFromDefault, detail: j.detail.level,
    tick: st.tick, trackIndex: viewed.trackIndex, lateral: viewed.lateral, place: { where, turnAheadDeg: turnAhead, climbAheadZ: climbAhead },
    camera: { x: cam.x, y: cam.y, z: cam.z, heading: cam.heading, pitch: cam.pitch, horizonRow: cam.horizonRow },
    cameraStaticOverLast3Frames: j.historyCameraStatic,
    overlayCheck: pick(c),
    historyCheck,
    pixels: counts,
  };
  if (historyCheck) {
    const ok = historyCheck.filter((h) => h.meanAbsInnerPx !== null && h.found >= 10);
    if (ok.length) {
      const best = ok.reduce((a, b) => (b.meanAbsInnerPx < a.meanAbsInnerPx ? b : a));
      const cur = historyCheck.findIndex((h) => h.current);
      entry.bestHistory = { tick: best.tick, framesBeforeCurrent: cur >= 0 ? cur - historyCheck.indexOf(best) : null, meanAbsInnerPx: best.meanAbsInnerPx };
    }
  }
  index.push(entry);
  process.stdout.write(`${entry.id} ${entry.view.padEnd(7)} med ${entry.overlayCheck.medianErrPx} found ${c.found}/${c.samples}${entry.bestHistory ? ` best frame ${entry.bestHistory.framesBeforeCurrent} before current` : ''}\n`);
}

// ---------------------------------------------------------------- summaries
const stats = (vals) => {
  const v = vals.filter((x) => x !== null && x !== undefined);
  return v.length ? { n: v.length, median: L.median(v), p90: L.quantile(v, 0.9), max: Math.max(...v) } : { n: 0 };
};
const groupBy = (fn) => { const g = {}; for (const e of index) { const k = fn(e); (g[k] = g[k] || []).push(e); } return g; };
const summarise = (list) => ({
  frames: list.length,
  framesWithCheck: list.filter((e) => e.overlayCheck.medianErrPx !== null && e.overlayCheck.found >= 10).length,
  medianOfFrameMedians: stats(list.filter((e) => e.overlayCheck.found >= 10).map((e) => e.overlayCheck.medianErrPx)),
  frameMeans: stats(list.filter((e) => e.overlayCheck.found >= 10).map((e) => e.overlayCheck.meanErrPx)),
  framesMedianOver1px: list.filter((e) => e.overlayCheck.found >= 10 && e.overlayCheck.medianErrPx > 1).map((e) => e.id),
  reliableFrames: list.filter((e) => e.overlayCheck.reliable).length,
  innerSigned: stats(list.filter((e) => e.overlayCheck.found >= 10).map((e) => e.overlayCheck.medianInnerSignedPx)),
  outerSigned: stats(list.filter((e) => e.overlayCheck.found >= 10).map((e) => e.overlayCheck.medianOuterSignedPx)),
  samplesFound: list.reduce((a, e) => a + e.overlayCheck.found, 0),
  samplesWithin1px: list.reduce((a, e) => a + e.overlayCheck.within1, 0),
  samplesWithin2px: list.reduce((a, e) => a + e.overlayCheck.within2, 0),
});
const still = index.filter((e) => !e.moving);
const perCircuit = {};
for (const [k, list] of Object.entries(groupBy((e) => String(e.file).padStart(2, '0')))) perCircuit[k] = { circuit: list[0].circuit, track: list[0].track, ...summarise(list.filter((e) => !e.moving)), movingFrames: list.filter((e) => e.moving).length };
const perCircuitView = {};
for (const [k, list] of Object.entries(groupBy((e) => `${String(e.file).padStart(2, '0')}/${e.view}`))) {
  const l = list.filter((e) => !e.moving && e.overlayCheck.found >= 10);
  perCircuitView[k] = { frames: l.length, medianOfFrameMedians: stats(l.map((e) => e.overlayCheck.medianErrPx)).median ?? null, medianOfFrameMeans: stats(l.map((e) => e.overlayCheck.meanErrPx)).median ?? null,
    maxFrameMedian: l.length ? Math.max(...l.map((e) => e.overlayCheck.medianErrPx)) : null,
    within2px: +(l.reduce((a, e) => a + e.overlayCheck.within2, 0) / Math.max(1, l.reduce((a, e) => a + e.overlayCheck.found, 0))).toFixed(3) };
}
const perView = {};
for (const [k, list] of Object.entries(groupBy((e) => e.view))) perView[k] = summarise(list.filter((e) => !e.moving));
const perTexture = {};
for (const [k, list] of Object.entries(groupBy((e) => (e.texture ? 'on' : 'off')))) perTexture[k] = summarise(list.filter((e) => !e.moving));
const suspect = still.filter((e) => e.overlayCheck.found < 10 || e.overlayCheck.medianErrPx > 1.5 || e.overlayCheck.p90ErrPx > 4)
  .map((e) => ({ id: e.id, view: e.view, label: e.label, medianErrPx: e.overlayCheck.medianErrPx, p90ErrPx: e.overlayCheck.p90ErrPx, found: e.overlayCheck.found, samples: e.overlayCheck.samples, overlay: e.overlay }));
const moving = index.filter((e) => e.bestHistory);
const lag = { frames: moving.length, byFramesBeforeCurrent: {} };
for (const e of moving) { const k = String(e.bestHistory.framesBeforeCurrent); lag.byFramesBeforeCurrent[k] = (lag.byFramesBeforeCurrent[k] || 0) + 1; }
lag.detail = moving.map((e) => ({ id: e.id, view: e.view, speedMph: e.speedMph, candidates: e.historyCheck.map((h) => ({ tick: h.tick, current: h.current, meanAbsInnerPx: h.meanAbsInnerPx, medianErrPx: h.medianErrPx, found: h.found })) }));

fs.writeFileSync(path.join(ROOT, 'index.json'), JSON.stringify({
  about: 'Phase 2 reference frames: paused F1GP 1.05 frames with the exact game state (probes/p2-capture.cjs), checked with probes/p2-capture-check.cjs.',
  layout: '<NN>/<k>.png (320x200 screenshot), <k>.json (state, history, view, texture, detail, circuit), <k>-overlay.png, <NN>/track.json (readTrack). NN = track file number f1ctNN.dat = circuitIndex (SS:1236) + 1.',
  overlayMethod: 'Road edges of the lap from track.json projected with the frame camera (x = 160 + 256*lat/depth, y = Y0 + horizonRow - dz*SS:017C*2/65536*32/depth; Y0 = 16 outside, 0 in the cockpit; depth < 500 ft). The game road boundary is found by colour along the search line through each edge sample (rows for steep edges, every 3rd row; columns for flat edges, every 4th column): inner = where the road-surface colours end, outer = where the verge colours start (colours learned per frame from inside/just outside the projected road). Error per sample = 0 if the projected edge lies between inner and outer (painted line or kerb band), else the distance to the nearer, perpendicular to the edge. medianErrPx is the median over samples where a boundary was found within 10 px. Signed inner/outer medians: + = right (row search) or down (column search). Cockpit, own car, banner and non-3D rows are masked.',
  settings: {
    texture: 'T toggles the ground/road texture (2-4 shades per surface instead of one flat colour). On at the start of every session: SS:11A6 = 80h (00 off). SS:00C0 also changed with T at Monza but is 0 at the start on other circuits, so it is not the setting.',
    detail: 'D cycles the detail level DS:0068: 3 at the start (all frames here), then 2, 1, 0, 3. In the Silverstone pit lane 3 -> 2 removed a distant grandstand; 2 -> 1 -> 0 changed only a few pixels there.',
    views: 'PgDn chase, Left TV, Right cockpit (Delete reverse chase, not captured). View keys do nothing in the pit lane. A "Viewing/Riding with" banner shows for about 3.2 game s after a view change; captures wait for it to go.',
  },
  frameLagNote: 'Moving captures: the edge check repeated with the camera of each of the last 3 frames. When one camera fits clearly best (mean inner-boundary error at most 0.6x the next), it is almost always the frame before the one the reader called current: the screenshot taken while paused on a consistent read shows the previous frame. Standing frames are unaffected (the camera moves < 0.01 ft per frame).',
  summary: { perCircuit, perView, perCircuitView, perTexture, suspect, frameLag: { ...lag, detail: undefined, clearCut: (() => {
    const out = {}; let n = 0;
    for (const d of lag.detail) {
      const c = d.candidates.filter((x) => x.meanAbsInnerPx !== null && x.found >= 10);
      if (c.length < 3) continue;
      const srt = [...c].sort((a, b) => a.meanAbsInnerPx - b.meanAbsInnerPx);
      if (srt[0].meanAbsInnerPx > 0.6 * srt[1].meanAbsInnerPx) continue;
      const cur = d.candidates.findIndex((x) => x.current), k = String(cur - d.candidates.indexOf(srt[0]));
      out[k] = (out[k] || 0) + 1; n++;
    }
    return { frames: n, byFramesBeforeCurrent: out };
  })() } },
  frameLagDetail: lag.detail,
  frames: index,
}, null, 1));

// ---------------------------------------------------------------- colour inventory
const label = (rgb, e) => {
  const [r, g, b] = rgb;
  const tot = e.road + e.edge + e.outside + e.above;
  const fr = e.road / tot, fe = e.edge / tot, fo = e.outside / tot, fa = e.above / tot;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  const grey = mx - mn < 24;
  const green = g > r + 10 && g > b + 10;
  const blueSky = b > r + 30 && b >= g && g > 80;
  const saturated = mx - mn > 120;              // painted red, blue, yellow
  const light = mn > 190;                       // white / near white
  if (fr >= 0.5 && grey && !light) return 'road surface';
  if (fr >= 0.5) return 'on the road (markings, start line, cars)';
  if (fe >= 0.25 && (light || (r > 150 && g < 90 && b < 90))) return 'kerb / edge line';
  if (fa >= 0.6) return blueSky ? 'sky' : green ? 'trees / horizon greenery' : 'scenery above the horizon (stands, buildings, boards, horizon image)';
  if (fo + fe >= 0.5) {
    if (green) return 'grass / verge';
    if (saturated) return 'kerbs, barriers, boards (saturated paint)';
    if (light) return 'white walls, lines, buildings';
    if (grey) return 'walls, barriers, run-off, pavement (grey)';
    if (r > g + 15 && g > b + 15) return 'sand / gravel / brown';
    return 'other scenery below the horizon';
  }
  return 'mixed (occurs inside, at the edges and outside the road)';
};
const palette = [...colourAcc.entries()].map(([k, e]) => {
  const rgb = L.rgbOf(k);
  return { hex: L.hex(k), rgb, label: label(rgb, e), pixels: { insideRoad: e.road, nearRoadEdge: e.edge, outsideBelowHorizon: e.outside, aboveHorizon: e.above },
    total: e.road + e.edge + e.outside + e.above, circuits: Object.keys(e.circuits).length, views: e.views, texOffPixels: e.texOff };
}).sort((a, b) => b.total - a.total);
const grand = palette.reduce((a, p) => a + p.total, 0);
const byLabel = {};
for (const p of palette) {
  const b = (byLabel[p.label] = byLabel[p.label] || { pixels: 0, colours: [] });
  b.pixels += p.total;
  if (p.total / grand >= 0.0005) {
    const t = p.total, px = p.pixels;
    b.colours.push({ hex: p.hex, rgb: p.rgb, share: +(t / grand).toFixed(4), circuits: p.circuits,
      where: { insideRoad: +(px.insideRoad / t).toFixed(3), nearEdge: +(px.nearRoadEdge / t).toFixed(3), outsideBelow: +(px.outsideBelowHorizon / t).toFixed(3), above: +(px.aboveHorizon / t).toFixed(3) } });
  }
}
for (const b of Object.values(byLabel)) b.share = +(b.pixels / grand).toFixed(4);
// per circuit: main colours of road / outside / above
const perCircuitColours = {};
for (const [k, e] of colourAcc) {
  for (const [d, n] of Object.entries(e.circuits)) {
    const pc = (perCircuitColours[d] = perCircuitColours[d] || {});
    pc[L.hex(k)] = (pc[L.hex(k)] || 0) + n;
  }
}
const perCircuitTop = {};
for (const [d, m] of Object.entries(perCircuitColours)) {
  const tot = sum(m);
  perCircuitTop[d] = Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, 16).map(([hex, n]) => ({ hex, share: +(n / tot).toFixed(4), label: palette.find((p) => p.hex === hex).label }));
}
// per circuit, texture on / off: the main colours inside the road and outside it below the horizon
const top = (m, cover = 0.95, max = 8) => {
  if (!m) return [];
  const tot = sum(Object.fromEntries(m)), out = [];
  let acc = 0;
  for (const [k, n] of [...m.entries()].sort((a, b) => b[1] - a[1])) { if (acc >= cover * tot || out.length >= max) break; out.push({ hex: L.hex(k), share: +(n / tot).toFixed(3) }); acc += n; }
  return out;
};
const perCircuitSurfaces = {};
for (const [d, t] of Object.entries(surf)) {
  perCircuitSurfaces[d] = { track: TRACK_NAMES[+d - 1] };
  for (const tex of ['on', 'off']) if (t[tex]) perCircuitSurfaces[d][`texture${tex === 'on' ? 'On' : 'Off'}`] = { insideRoad: top(t[tex].road), outsideBelowHorizon: top(t[tex].outside, 0.8), aboveHorizon: top(t[tex].above, 0.8) };
}
fs.writeFileSync(path.join(ROOT, 'colours.json'), JSON.stringify({
  about: 'Colours in the 3D view of the reference frames (cockpit, own car in chase view, banner and non-3D rows masked). Regions from the projected road polygon (depth < 500 ft): insideRoad = road mask eroded 2 px; nearRoadEdge = within 2 px of it; outsideBelowHorizon; aboveHorizon. Labels are heuristics from where a colour occurs and its hue.',
  frames: index.length, pixels: grand,
  byLabel, perCircuitSurfaces, perCircuitTop, palette: palette.filter((p) => p.total / grand >= 0.00005),
}, null, 1));
console.log('summary', JSON.stringify({ perView, perTexture, suspect: suspect.length, lag: lag.byFramesBeforeCurrent }, null, 1));
