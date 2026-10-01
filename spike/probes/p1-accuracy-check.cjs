// p1-accuracy-check.cjs - the Phase 1 done test, offline: does the game state
// read from memory match the game for a whole Quick Race?
//
//   node probes/p1-accuracy-check.cjs out/p1-accuracy/race1 [more run dirs]
//
// Reads a run recorded by probes/p1-accuracy-run.cjs (frames.jsonl,
// dash.jsonl, keys.jsonl, meta.json) and also accepts the runs of
// probes/p1-state-watch.cjs (out/p1-state/drive, coast: same first 13 car
// columns; no keys.jsonl, so no view-key check). Writes report.json into
// each run directory and prints one line per check.
//
// The track outline used for the on-track check comes from the track file
// (../original/f1ctNN.dat via lib/track-file.mjs), not from memory, so it is
// an independent model of the circuit.
//
// Results per check: pass, fail, pass* (passes, with listed exceptions that
// are the game's own fields, not read errors), info (a model, not judged),
// not-tested (the run has no data for it). Each check states its criterion.
// Also usable as a module: checkRun(dir, trackFileModule) -> report.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { quantiles, hist } = require('./p1-accuracy-lib.cjs');

const NCARS = 26;
const FT = 0.3048;                      // metres per foot
const FINE_M = FT / 64;                 // metres per fine unit (1/64 ft)
const mph = (v) => Math.floor((v * 0x2ba) / 0x10000);
const readJsonl = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const wrap16 = (v) => (((v & 0xffff) + 0x8000) & 0xffff) - 0x8000;
const deg = (a) => (a * 360) / 65536;
const bearing = (dx, dy) => Math.round((Math.atan2(dx, dy) / (2 * Math.PI)) * 65536) & 0xffff; // 0 = +y, 0x4000 = +x
const maxOf = (a) => a.reduce((m, v) => (v > m ? v : m), -Infinity);
const r1 = (v, k = 1) => (v === null || v === undefined || Number.isNaN(v) ? null : +v.toFixed(k));
// column indices of a car row (CAR_FIELDS in p1-accuracy-run.cjs)
const C = { x: 0, y: 1, src: 2, speed: 3, idx: 4, along: 5, lat: 6, lap: 7, inPit: 8, racePos: 9, retired: 10, pitState: 11, visible: 12,
  heading: 13, segNr: 14, last: 15, lapStart: 16, z: 17, number: 18, f23: 19, f96: 20, gap: 21, dir: 22 };

// ------------------------------------------------------------ track geometry (from the track file)
function buildGeometry(trackFile, outline) {
  // the pit lane ends where it rejoins the track: close the polyline with that track segment
  const segs = outline.segs, pit = outline.pitSegs.slice();
  if (outline.pit.rejoinsAt !== null && outline.pit.rejoinsAt !== undefined && segs[outline.pit.rejoinsAt]) pit.push({ ...segs[outline.pit.rejoinsAt], halfWidth: pit[pit.length - 1].halfWidth });
  const mk = (list, closed) => {
    const n = list.length;
    const X = new Float64Array(n), Y = new Float64Array(n), W = new Float64Array(n);
    list.forEach((s, i) => { X[i] = s.x; Y[i] = s.y; W[i] = s.halfWidth; });
    return { n, X, Y, W, closed };
  };
  return { file: trackFile, lap: mk(segs, true), pit: mk(pit, false), pitFirstNr: outline.pit.firstNr, cameras: outline.cameras };
}
// nearest point of polyline `g` to (px, py) (fine units), searching segments
// [from, to) (indices wrap on a closed line). Returns { d, off (signed, + =
// right of travel), hw (half-width there), k, t }.
function nearest(g, px, py, from = 0, to = g.n) {
  let best = null;
  const last = g.closed ? g.n : g.n - 1;
  for (let kk = from; kk < to; kk++) {
    let k = kk;
    if (g.closed) k = ((k % g.n) + g.n) % g.n; else if (k < 0 || k >= last) continue;
    const k2 = (k + 1) % g.n;
    const ax = g.X[k], ay = g.Y[k], dx = g.X[k2] - ax, dy = g.Y[k2] - ay;
    const L2 = dx * dx + dy * dy || 1;
    let t = ((px - ax) * dx + (py - ay) * dy) / L2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const qx = ax + t * dx, qy = ay + t * dy;
    const d = Math.hypot(px - qx, py - qy);
    if (!best || d < best.d) {
      const cross = dx * (py - ay) - dy * (px - ax); // > 0: left of travel (x right, y up)
      best = { d, off: -Math.sign(cross) * d, hw: g.W[k] + t * (g.W[k2] - g.W[k]), k, t };
    }
  }
  return best;
}
function placeOnTrack(G, c) {
  const px = c[C.x] / 256, py = c[C.y] / 256;
  let lap = nearest(G.lap, px, py, c[C.idx] - 40, c[C.idx] + 41);
  if (!lap || lap.d > 4000) lap = nearest(G.lap, px, py);
  // the reader knows which array the car's segment is in: judge pit-lane cars against the pit lane
  const inPitSeg = c.length > C.segNr ? (c[C.segNr] & 0x2000) !== 0 : !!c[C.inPit];
  if (inPitSeg && G.pit.n) return { ...nearest(G.pit, px, py), line: 'pit' };
  return { ...lap, line: 'lap' };
}

// ------------------------------------------------------------ helpers over frames
function loadRun(dir) {
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
  const frames = readJsonl(path.join(dir, 'frames.jsonl'));
  const dash = readJsonl(path.join(dir, 'dash.jsonl'));
  const keys = readJsonl(path.join(dir, 'keys.jsonl'));
  const byTick = new Map();
  frames.forEach((f, i) => {
    byTick.set(f.tick, i);
    // runs of probes/p1-state-watch.cjs store the reader's flags, not a consistent field
    if (f.consistent === undefined && f.settled !== undefined) f.consistent = f.settled && !f.carsAhead;
  });
  const fps = meta.atGreen.session.fps;
  const N = meta.lapSegments || (meta.atGreen.track && meta.atGreen.track.lapSegments) || 1189;
  const player = meta.atGreen.playerSlot ?? meta.atGreen.view.playerSlot;
  return { dir, meta, frames, dash, keys, byTick, fps, N, player, totalLaps: meta.atGreen.session.totalLaps };
}
// index of the last frame with tick <= t (binary search)
function frameAt(run, t) {
  const F = run.frames;
  let lo = 0, hi = F.length - 1, ans = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (F[m].tick <= t) { ans = m; lo = m + 1; } else hi = m - 1; }
  return ans;
}
const isCockpit = (f) => (f.view & 0xb0) === 0;
const viewMode = (raw) => ({ 0x00: 'cockpit', 0x80: 'tv', 0xa0: 'chase', 0xb0: 'reverse-chase' })[raw & 0xb0] || `0x${raw.toString(16)}`;

// ------------------------------------------------------------ checks
function checkFrames(run) {
  const F = run.frames;
  const steps = hist(F.slice(1).map((f, i) => f.frame - F[i].frame));
  const consistent = F.filter((f) => f.consistent !== false).length;
  const span = F.length ? { firstFrame: F[0].frame, lastFrame: F[F.length - 1].frame, gameSeconds: r1((F[F.length - 1].tick - F[0].tick) / 1000, 2) } : null;
  const expected = span ? span.lastFrame - span.firstFrame + 1 : 0;
  // frames lost inside the deliberate polling stalls of a --stall run do not count
  const stalls = run.meta.stalls || [];
  const warp = run.meta.warp || 1;
  let missed = 0, missedInStalls = 0;
  for (let i = 1; i < F.length; i++) {
    const gap = F[i].frame - F[i - 1].frame - 1;
    if (gap <= 0) continue;
    missed += gap;
    if (stalls.some((st) => F[i - 1].tick >= st.tick - 70 && F[i - 1].tick <= st.tick + st.ms * warp + 70)) missedInStalls += gap;
  }
  const pass = F.length > 0 && F.length + missedInStalls >= 0.99 * expected;
  return { name: 'every game frame recorded', result: pass ? 'pass' : 'fail', frames: F.length, expectedFrames: expected, missedFrames: missed, missedInsideDeliberateStalls: missedInStalls,
    frameSteps: steps, consistentReads: consistent, ...span, criterion: '>= 99 % of the game frames between the first and the last record were recorded (frames lost in deliberate polling stalls excused)' };
}

function checkPresence(run) {
  let frames = 0, bad = 0, badNumbers = 0, badPos = 0, badOrder = 0;
  const srcCount = { live: 0, derived: 0, none: 0 };
  const examples = [];
  for (const f of run.frames) {
    if (f.inSession === false) continue;
    frames++;
    let ok = f.cars.length === NCARS;
    for (const c of f.cars) {
      const s = c[C.src];
      srcCount[s === 1 ? 'live' : s === 2 ? 'derived' : 'none']++;
      if (s === 0 || !Number.isFinite(c[C.x]) || !Number.isFinite(c[C.y])) ok = false;
    }
    if (!ok) { bad++; if (examples.length < 5) examples.push({ frame: f.frame, src: f.cars.map((c) => c[C.src]) }); }
    if (f.cars[0].length > C.number) {
      const nums = new Set(f.cars.map((c) => c[C.number]));
      if (nums.size !== NCARS) badNumbers++;
    }
    const pos = f.cars.map((c) => c[C.racePos]).sort((a, b) => a - b);
    if (pos.some((p, i) => p !== i + 1)) badPos++;
    if (f.order && f.order.some((slot, k) => f.cars[slot][C.racePos] !== k + 1)) badOrder++;
  }
  const pass = frames > 0 && bad === 0 && badNumbers === 0 && badPos === 0 && badOrder === 0;
  return { name: 'all 26 cars present every frame', result: pass ? 'pass' : 'fail', inSessionFrames: frames, framesMissingACar: bad, framesWithDuplicateNumbers: badNumbers,
    framesWhereRacePosIsNotAPermutation: badPos, framesWhereOrderTableDisagreesWithRacePos: badOrder, carFrames: srcCount, examples };
}

// dash comparisons: each dash sample against the frames shown up to 6 frames before the screenshot
// The window: the frame after the screenshot's clock (the 3D view and parts of
// the cockpit are drawn before the game adds to its clock, so the screen can
// be one frame ahead of a clock read), then the frame at the clock and the 6
// before it (the dash speed is redrawn every few frames).
function dashWindow(run, d, back = 6) {
  const i = frameAt(run, d.tick);
  if (i < 0) return null;
  const out = [];
  if (run.frames[i + 1] && run.frames[i + 1].frame - run.frames[i].frame === 1) out.push(run.frames[i + 1]);
  for (let k = i; k >= 0 && k >= i - back; k--) out.push(run.frames[k]);
  out.lag0 = out.length - Math.min(back + 1, i + 1); // index of the frame at the clock
  return out; // newest first
}
function checkDash(run) {
  const res = { name: 'dash vs memory (viewed car in cockpit view)', samples: 0, perSecond: 0 };
  const fields = ['mph', 'lap', 'laps', 'pos', 'car', 'runners', 'lapTime'];
  const tally = (who) => Object.fromEntries(fields.map((k) => [k, { n: 0, ok: 0, lag: {}, misses: [] }]));
  const T = { player: tally(), computer: tally(), playerIncomplete: tally(), computerIncomplete: tally() };
  const TS = { player: tally(), computer: tally(), playerIncomplete: tally(), computerIncomplete: tally() }; // whole game seconds only
  // lag in frames: 0 = the frame at the screenshot's clock, -1 = the one after, 1..6 = before; the closest match counts
  const lagOf = (win, fn) => { const z = win.lag0; for (const k of [z, z - 1, z + 1, z + 2, z + 3, z + 4, z + 5, z + 6]) if (k >= 0 && k < win.length && fn(win[k])) return k - z; return null; };
  let skippedView = 0, unread = 0;
  for (const d of run.dash) {
    const D = d.dash;
    if ((d.view & 0xb0) !== 0) { skippedView++; continue; }
    if (D.mph === null || D.mph === undefined) { unread++; continue; }
    const win = dashWindow(run, d);
    if (!win || win.length < 2) continue;
    const v = d.viewed;
    // only samples where the whole window is the same cockpit view of the same car
    if (win.some((h) => !isCockpit(h) || h.viewed !== v || h.camIsCar === false)) { skippedView++; continue; }
    if (win.lag0 === undefined) win.lag0 = 0;
    res.samples++;
    // a window with a lost frame, or a record that is not the frame's own state, may lack the value the dash shows
    const fi0 = frameAt(run, d.tick) + win.lag0;
    const complete = win.length === 8 && win.every((h, k) => k === 0 || win[k - 1].frame - h.frame === 1) && win.every((h, k) => h.consistent !== false && !run.motion.off.has(fi0 - k));
    if (!complete) { res.incompleteWindows = (res.incompleteWindows || 0) + 1; }
    const who = (v === run.player ? 'player' : 'computer') + (complete ? '' : 'Incomplete');
    const whole = d.gt !== undefined ? Math.abs(d.gt - Math.round(d.gt)) < 0.07 && Math.round(d.gt * 2) % 2 === 0 : true;
    if (whole) res.perSecond++;
    const cmp = (k, fn) => {
      for (const t of whole ? [T[who], TS[who]] : [T[who]]) {
        const e = t[k]; e.n++;
        const lag = lagOf(win, fn);
        if (lag !== null) { e.ok++; e.lag[lag] = (e.lag[lag] || 0) + 1; } else if (e.misses.length < 8) e.misses.push({ t: d.t, gt: d.gt, tick: d.tick, dash: D[k], mem: memVal(k, win[0], v, run) });
      }
    };
    cmp('mph', (h) => mph(h.cars[v][C.speed]) === D.mph);
    if (D.lap !== null && D.lap !== undefined) cmp('lap', (h) => h.cars[v][C.lap] === D.lap);
    if (D.laps !== null && D.laps !== undefined) cmp('laps', (h) => (h.totalLaps ?? run.totalLaps) === D.laps);
    if (D.pos !== null && D.pos !== undefined) cmp('pos', (h) => h.cars[v][C.racePos] === D.pos);
    const hasNumber = win[0].cars[v].length > C.number;
    if (D.car !== null && D.car !== undefined && (hasNumber || v === run.player)) cmp('car', (h) => (hasNumber ? h.cars[v][C.number] : 1) === D.car);
    if (D.runners !== null && D.runners !== undefined) cmp('runners', (h) => h.runners === D.runners);
    if (D.lapTime !== null && D.lapTime !== undefined && (v === run.player || win[0].cars[v].length > C.last)) cmp('lapTime', (h) => ((v === run.player ? h.p.last : h.cars[v][C.last]) & 0x0fffffff) === D.lapTime);
  }
  const summ = (t) => Object.fromEntries(Object.entries(t).filter(([, e]) => e.n).map(([k, e]) => [k, { match: `${e.ok}/${e.n}`, rate: r1(e.ok / e.n, 4), lagFrames: e.lag, misses: e.misses }]));
  res.player = summ(T.player); res.computer = summ(T.computer);
  res.samplesWithALostOrOffFrameInTheWindow = { player: summ(T.playerIncomplete), computer: summ(T.computerIncomplete) };
  res.playerWholeSeconds = Object.fromEntries(Object.entries(summ(TS.player)).map(([k, e]) => [k, e.match]));
  res.computerWholeSeconds = Object.fromEntries(Object.entries(summ(TS.computer)).map(([k, e]) => [k, e.match]));
  res.skippedOtherViewOrViewChange = skippedView; res.dashNotShownOrUnreadable = unread;
  const rates = [...Object.values(res.player), ...Object.values(res.computer)].map((e) => e.rate);
  res.result = res.player.mph && res.player.mph.rate >= 0.98 && rates.every((r) => r >= 0.98) ? 'pass' : 'fail';
  res.criterion = 'each field matches the memory value in one of the frames from 1 after to 6 before the screenshot\'s clock in >= 98 % of samples whose 8 frames were all recorded as their own state (samples with a lost or off-by-a-frame record in the window are reported separately); lagFrames counts which frame matched (-1 = one frame after the clock)';
  return res;
}
function memVal(k, f, v, run) {
  const c = f.cars[v];
  return { mph: mph(c[C.speed]), lap: c[C.lap], laps: f.totalLaps ?? run.totalLaps, pos: c[C.racePos], car: c[C.number], runners: f.runners, lapTime: (v === run.player ? f.p.last : c[C.last]) & 0x0fffffff }[k];
}

// Whole-field motion between consecutive records: the median over moving cars
// of step / (speed x frames x frame time). About 1 normally; about 2 then 0
// when the record at i holds the cars one frame ahead of its clock (a read
// during the next frame's car loop), 0 then 2 when it holds them a frame late.
function fieldMotion(run) {
  const F = run.frames, ratio = new Array(F.length).fill(null);
  for (let i = 1; i < F.length; i++) {
    const A = F[i - 1], B = F[i], df = B.frame - A.frame;
    if (df < 1 || df > 3 || A.paused || B.paused) continue;
    const rs = [];
    for (let c = 0; c < NCARS; c++) {
      const a = A.cars[c], b = B.cars[c], exp = (Math.abs(a[C.speed]) * df) / run.fps;
      if (exp >= 50) rs.push(Math.hypot(b[C.x] - a[C.x], b[C.y] - a[C.y]) / 256 / exp);
    }
    if (rs.length >= 5) { rs.sort((x, y) => x - y); ratio[i] = rs[rs.length >> 1]; }
  }
  const off = new Map(); // frame index -> 'ahead' | 'behind'
  for (let i = 1; i + 1 < F.length; i++) {
    const r0 = ratio[i], r1v = ratio[i + 1];
    if (r0 === null || r1v === null) continue;
    if (off.get(i - 1) === 'ahead') continue; // its small step only mirrors the record before
    const d0 = F[i].frame - F[i - 1].frame, d1 = F[i + 1].frame - F[i].frame;
    // ahead: this record moved (d0 + 1) frames' worth and the next one (d1 - 1)
    if (Math.abs(r0 * d0 - (d0 + 1)) < 0.3 && Math.abs(r1v * d1 - (d1 - 1)) < 0.3) off.set(i, 'ahead');
    else if (Math.abs(r0 * d0 - (d0 - 1)) < 0.3 && Math.abs(r1v * d1 - (d1 + 1)) < 0.3) off.set(i, 'behind');
  }
  return { ratio, off };
}

function checkReads(run, motion) {
  const F = run.frames;
  const offRows = [...motion.off.entries()].map(([i, kind]) => ({ frame: F[i].frame, kind, gt: r1((F[i].tick - F[0].tick) / 1000, 2), flaggedConsistent: F[i].consistent !== false, settled: F[i].settled, carsAhead: F[i].carsAhead,
    wc: F[i].wc, s5c8: F[i].s5c8, c63: F[i].c63, pollsInTick: F[i].pollsInTick, readsInTick: F[i].readsInTick, pollGapMs: F[i].pollGapMs, view: F[i].view !== undefined ? viewMode(F[i].view) : null }));
  const flaggedOk = F.filter((f) => f.consistent !== false).length;
  const res = { name: 'read consistency flags', records: F.length, flaggedConsistent: flaggedOk, flaggedNotConsistent: F.length - flaggedOk,
    recordsOffByAFrame: offRows.length, offByAFrameButFlaggedConsistent: offRows.filter((r) => r.flaggedConsistent).length, offRows: offRows.slice(0, 30) };
  // DS:2977 rises by 2 per frame before the cars move: (DS:2977 - 2 frame) & FFh is constant while the clock and the cars agree
  if (F.length && F[0].wc !== undefined) {
    const offs = F.map((f) => (f.wc - 2 * f.frame) & 0xff);
    const h = hist(offs);
    const mode = +Object.entries(h).sort((a, b) => b[1] - a[1])[0][0];
    const aheadByWc = F.map((f, i) => offs[i] !== mode);
    const caught = offRows.filter((r) => r.kind === 'ahead').filter((r) => aheadByWc[F.findIndex((f) => f.frame === r.frame)]).length;
    const ahead = offRows.filter((r) => r.kind === 'ahead').length;
    const falseAlarms = F.filter((f, i) => aheadByWc[i] && !motion.off.has(i) && motion.ratio[i] !== null && motion.ratio[i + 1] !== null).length;
    res.workCounterOffset = { histogram: h, mode, recordsOffMode: aheadByWc.filter(Boolean).length,
      fixedOffsetRuleCatchesAheadRecords: `${caught}/${ahead}`, fixedOffsetRuleFlagsNormalRecords: falseAlarms,
      note: 'rule tested: carsAhead = ((DS:2977 - 2 frame) & FFh) != the run\'s most common value (instead of re-learning the value from every settled read)' };
  }
  res.result = res.offByAFrameButFlaggedConsistent === 0 ? 'pass' : 'fail';
  res.criterion = 'no record flagged consistent holds the cars a frame ahead of (or behind) its clock, judged by the whole field\'s motion';
  return res;
}

function checkContinuity(run, motion) {
  const ratios = [], bad = [];
  let pairs = 0, stopped = 0, maxStepM = 0, maxStepAt = null, skippedTiming = 0;
  const perCar = Array.from({ length: NCARS }, () => []);
  for (let i = 1; i < run.frames.length; i++) {
    const A = run.frames[i - 1], B = run.frames[i];
    const df = B.frame - A.frame;
    if (df < 1 || df > 3 || A.consistent === false || B.consistent === false || B.paused || A.paused) continue;
    // a record a whole frame off its clock is a read-timing error (checkReads), not a position error
    if (motion.off.has(i) || motion.off.has(i - 1)) { skippedTiming++; continue; }
    for (let c = 0; c < NCARS; c++) {
      const a = A.cars[c], b = B.cars[c];
      const step = Math.hypot(b[C.x] - a[C.x], b[C.y] - a[C.y]) / 256; // fine units
      const vmax = Math.max(Math.abs(a[C.speed]), Math.abs(b[C.speed]));
      const exp = (Math.abs(a[C.speed]) * df) / run.fps;
      const lim = (1.25 * vmax * df) / run.fps + 32; // 25 % over the faster speed, plus 0.5 ft
      pairs++;
      const m = step * FINE_M;
      if (m > maxStepM) { maxStepM = m; maxStepAt = { frame: B.frame, car: c, stepM: r1(m, 2), speedMph: mph(vmax) }; }
      if (exp >= 50) { const r = step / exp; ratios.push(r); perCar[c].push(r); } else stopped++;
      if (step > lim) bad.push({ frame: B.frame, gt: r1((B.tick - run.frames[0].tick) / 1000, 2), car: c, stepM: r1(m, 2), allowedM: r1(lim * FINE_M, 2), mphA: mph(a[C.speed]), mphB: mph(b[C.speed]),
        src: `${a[C.src]}>${b[C.src]}`, pit: `${a[C.inPit]}>${b[C.inPit]}`, retired: b[C.retired], idx: `${a[C.idx]}>${b[C.idx]}` });
    }
  }
  // a read error would show as a spike (the car jumps away and comes back);
  // a move that persists (the next step is normal again) is the game's own
  // fields changing, e.g. a lateral reset at the pit entry or a shove in a contact
  const idxOf = new Map(run.frames.map((f, i) => [f.frame, i]));
  for (const j of bad) {
    const i = idxOf.get(j.frame), F = run.frames;
    const A = F[i - 1], B = F[i], N2 = F[i + 1];
    const a = A.cars[j.car], b = B.cars[j.car];
    j.latChangeM = r1((b[C.lat] - a[C.lat]) * FINE_M, 2);
    if (a.length > C.segNr) j.segChange = `${a[C.segNr].toString(16)}>${b[C.segNr].toString(16)}`;
    if (N2 && N2.frame - B.frame === 1) {
      const n = N2.cars[j.car];
      const back = Math.hypot(n[C.x] - a[C.x], n[C.y] - a[C.y]) / 256, fwd = Math.hypot(n[C.x] - b[C.x], n[C.y] - b[C.y]) / 256;
      const exp1 = Math.abs(b[C.speed]) / run.fps;
      j.next = fwd <= 1.25 * exp1 + 32 ? 'normal' : 'jump';
      j.kind = j.next === 'normal' ? 'persistent' : back < fwd ? 'spike' : 'jump-jump';
    } else j.kind = 'unknown';
  }
  const spikes = bad.filter((j) => j.kind !== 'persistent');
  const within = ratios.filter((r) => r >= 0.8 && r <= 1.25).length;
  const carMedians = perCar.map((r) => (r.length ? r1(quantiles(r).p50, 4) : null));
  // a jump: more than 25 % beyond what the car's own speed allows (plus 0.5 ft)
  const res = { name: 'no implausible jumps between frames', carFramePairs: pairs, framePairsSkippedAsReadTiming: skippedTiming, movingPairs: ratios.length, slowPairs: stopped,
    stepOverExpected: quantiles(ratios, [0, 0.001, 0.01, 0.5, 0.99, 0.999, 1]), within0p8to1p25: `${within}/${ratios.length}`,
    carMedianRatio: carMedians, maxStep: maxStepAt, stepsOverBound: bad.length, spikes: spikes.length, persistentMoves: bad.length - spikes.length, jumpExamples: bad.slice(0, 25) };
  res.result = spikes.length === 0 ? (bad.length ? 'pass*' : 'pass') : 'fail';
  res.criterion = 'step between consecutive frames <= 1.25 x max(speed before, after) x frame time + 0.5 ft for every car; a step over the bound fails as a spike (the car comes back next frame), and is listed as a persistent move of the game\'s own fields (pass*) when the next step is normal';
  return res;
}

function checkOnTrack(run, G, every = 1) {
  const groups = {};
  const g = (k) => (groups[k] = groups[k] || { n: 0, inside: 0, inside1m: 0, inside3m: 0, excessM: [], latErrM: [], worst: [] });
  for (let i = 0; i < run.frames.length; i += every) {
    const f = run.frames[i];
    if (f.inSession === false) continue;
    for (let c = 0; c < NCARS; c++) {
      const car = f.cars[c];
      if (car[C.src] === 0) continue;
      const pl = placeOnTrack(G, car);
      const kind = (c === run.player ? 'player' : 'computer') + (car[C.src] === 1 ? '/live' : '/derived') + (pl.line === 'pit' ? '/pit' : '');
      const e = g(kind);
      e.n++;
      const excess = (Math.abs(pl.off) - pl.hw) * FINE_M; // metres beyond the edge (negative = inside)
      if (excess <= 0) e.inside++;
      if (excess <= 1) e.inside1m++;
      if (excess <= 3) e.inside3m++;
      e.excessM.push(excess);
      if (pl.line === 'lap' && !car[C.inPit]) e.latErrM.push(Math.abs(pl.off - car[C.lat]) * FINE_M);
      if (pl.line === 'pit' && excess > 0) {
        (e.beyondEdgeMph = e.beyondEdgeMph || []).push(mph(car[C.speed]));
        if (mph(car[C.speed]) >= 60) {
          // fast and outside the lane: expected only in the first frame on a pit segment, where car+0A still holds the track's lateral offset
          const prev = i > 0 ? run.frames[i - 1].cars[c] : null;
          const firstPitFrame = prev && !(prev[C.segNr] & 0x2000);
          (e.fastOutside = e.fastOutside || []).push({ frame: f.frame, car: c, mph: mph(car[C.speed]), offM: r1(pl.off * FINE_M, 2), latM: r1(car[C.lat] * FINE_M, 2), firstPitFrame });
        }
      }
      if (excess > 1 && e.worst.length < 400) e.worst.push({ frame: f.frame, car: c, excessM: r1(excess, 2), offM: r1(pl.off * FINE_M, 2), hwM: r1(pl.hw * FINE_M, 2), mph: mph(car[C.speed]), seg: pl.k, line: pl.line, retired: car[C.retired] });
    }
  }
  const out = {};
  for (const [k, e] of Object.entries(groups)) {
    e.worst.sort((a, b) => b.excessM - a.excessM);
    out[k] = { carFrames: e.n, insideEdges: `${e.inside}/${e.n}`, within1mOfEdge: `${e.inside1m}/${e.n}`, within3m: `${e.inside3m}/${e.n}`,
      maxBeyondEdgeM: r1(maxOf(e.excessM), 2), distFromEdgeM: quantiles(e.excessM.map((v) => +v.toFixed(3)), [0, 0.5, 0.99, 1]),
      lateralFieldVsGeometryM: e.latErrM.length ? quantiles(e.latErrM, [0.5, 0.99, 1]) : null, worst: e.worst.slice(0, 8),
      ...(e.beyondEdgeMph ? { mphWhenBeyondPitLaneEdge: quantiles(e.beyondEdgeMph, [0, 0.5, 0.9, 1]), maxFromPitCentrelineM: r1(maxOf(e.excessM) + 640 * FINE_M, 2), fastOutsideLane: e.fastOutside || [] } : {}) };
  }
  // computer cars in track mode are what the reader derives: they must stay on the outline
  // (on the lap; in the pit lane the pit boxes lie beside the lane, judged separately)
  const der = Object.entries(out).filter(([k]) => k === 'computer/derived');
  const pitD = out['computer/derived/pit'];
  const n = der.reduce((s, [, v]) => s + v.carFrames, 0);
  const in1 = der.reduce((s, [, v]) => s + Number(v.within1mOfEdge.split('/')[0]), 0);
  const maxEx = maxOf(der.map(([, v]) => v.maxBeyondEdgeM));
  return { name: 'positions stay on the track outline (track file)', trackFile: G.file, sampledEveryNthFrame: every, groups: out,
    derivedWithin1mOfEdge: `${in1}/${n}`, derivedMaxBeyondEdgeM: maxEx,
    pitLane: pitD ? { carFrames: pitD.carFrames, insideLane: pitD.insideEdges, maxFromPitCentrelineM: pitD.maxFromPitCentrelineM, mphWhenBeyondLaneEdge: pitD.mphWhenBeyondPitLaneEdge, fastOutsideLane: pitD.fastOutsideLane } : null,
    result: n > 0 && in1 >= 0.999 * n && maxEx < 10 && (!pitD || !pitD.fastOutsideLane || (pitD.maxFromPitCentrelineM < 12 && pitD.fastOutsideLane.every((x) => x.firstPitFrame))) ? 'pass' : 'fail',
    criterion: 'derived computer-car positions on the lap: >= 99.9 % within 1 m of the track edges, none more than 10 m off; in the pit lane: within 12 m of the lane centreline (pit boxes lie beside the 3 m lane), and outside the lane at 60 mph or more only in the first frame on a pit segment; live cars (the autopilot, cars in a spin or contact) are reported, not judged' };
}

function checkLaps(run) {
  const N = run.N;
  let increments = 0, atLine = 0, inPit = 0, timed = 0, timedOk = 0;
  const pitLapTimes = [];
  const bad = [], timeBad = [];
  const crossings = Array.from({ length: NCARS }, () => []); // ticks at which each car completed a lap
  let leaderBad = 0, leaderN = 0;
  for (let i = 1; i < run.frames.length; i++) {
    const A = run.frames[i - 1], B = run.frames[i];
    if (B.frame - A.frame < 1) continue;
    for (let c = 0; c < NCARS; c++) {
      const a = A.cars[c], b = B.cars[c];
      if (b[C.lap] === a[C.lap]) continue;
      increments++;
      if (b[C.lap] !== a[C.lap] + 1) { bad.push({ frame: B.frame, car: c, lap: `${a[C.lap]}>${b[C.lap]}`, why: 'not +1' }); continue; }
      crossings[c].push({ tick: B.tick, frame: B.frame, lap: b[C.lap], last: b[C.last] >>> 0 });
      if (a[C.inPit] || b[C.inPit]) inPit++;
      else if (a[C.idx] >= N - 40 && b[C.idx] <= 40) atLine++;
      else bad.push({ frame: B.frame, car: c, lap: `${a[C.lap]}>${b[C.lap]}`, idx: `${a[C.idx]}>${b[C.idx]}`, why: 'not at the line' });
      // lap time = difference of the lap start times (car+54), last lap = car+40
      if (b.length > C.lapStart && (b[C.lapStart] & 0xf0000000)) { pitLapTimes.push({ frame: B.frame, car: c, lapStart: `0x${(b[C.lapStart] >>> 0).toString(16)}`, last: b[C.last] >>> 0, inPit: !!(a[C.inPit] || b[C.inPit]) }); continue; }
      if (b.length > C.lapStart && !(a[C.lapStart] & 0xf0000000) && !(b[C.last] & 0xf0000000)) {
        timed++;
        const diff = (b[C.lapStart] - a[C.lapStart]) >>> 0;
        // and the lap ended inside this frame by the session timer (DS:294F)
        const inFrame = b[C.lapStart] > A.sessionMs - 70 && b[C.lapStart] <= B.sessionMs;
        if (diff === (b[C.last] >>> 0) && inFrame) timedOk++; else if (timeBad.length < 8) timeBad.push({ frame: B.frame, car: c, last: b[C.last], startDiff: diff, inFrame });
      }
    }
    // DS:298B = laps the leader has completed
    if (B.leaderLapsDone !== undefined) {
      const lead = B.cars.find((c) => c[C.racePos] === 1);
      leaderN++;
      if (B.leaderLapsDone !== Math.max(0, lead[C.lap] - 1)) leaderBad++;
    }
    // lap never goes backwards for any car
  }
  const decreasing = run.frames.slice(1).some((f, i) => f.cars.some((c, k) => c[C.lap] < run.frames[i].cars[k][C.lap]));
  const res = { name: 'lap counters', lapIncrements: increments, atStartFinishLine: atLine, inPitLane: inPit, violations: bad.length, violationExamples: bad.slice(0, 10),
    lapsEverDecrease: decreasing, lapTimesChecked: `${timedOk}/${timed}`, lapTimeExamples: timeBad,
    lapsWithFlaggedStart: pitLapTimes.length, flaggedStartLaps: pitLapTimes.slice(0, 12),
    leaderLapsDoneVsLeader: leaderN ? `${leaderN - leaderBad}/${leaderN}` : null,
    completedLapsPerCar: crossings.map((x) => x.length) };
  res.result = !bad.length && !decreasing && timedOk === timed && leaderBad === 0 && increments > 0 ? 'pass' : 'fail';
  res.criterion = 'every lap change is +1 and happens where the segment index wraps from the end of the lap to 0 (or in the pit lane); last lap (car+40) = difference of lap starts (car+54), and the new lap start falls inside that frame by the session timer DS:294F (laps whose new start is a flag value, C0000000h, after a pit-lane crossing, are listed, not judged); DS:298B = leader lap - 1';
  res.crossings = crossings;
  return res;
}

// The game's own rule, found from race1: car+AA orders the cars by laps and
// segment index (16 ft resolution) as they were one frame earlier; cars in the
// same segment keep their order. Checked on every pair of consecutive
// records (both consistent, one frame apart, neither off by a frame).
function checkOrderRule(run, motion) {
  const N = run.N, F = run.frames;
  let pairs = 0, frames = 0, bad = 0;
  const ex = [];
  for (let i = 1; i < F.length; i++) {
    const A = F[i - 1], B = F[i];
    if (B.frame - A.frame !== 1 || A.consistent === false || B.consistent === false || motion.off.has(i) || motion.off.has(i - 1) || B.inSession === false) continue;
    frames++;
    const ok = [];
    for (let c = 0; c < NCARS; c++) {
      const a = A.cars[c], b = B.cars[c];
      if (b[C.retired] || a[C.inPit] || b[C.inPit] || a[C.lap] > run.totalLaps || b[C.lap] > run.totalLaps) continue;
      ok.push({ c, pos: b[C.racePos], key: a[C.lap] * N + a[C.idx] });
    }
    for (const x of ok) for (const y of ok) {
      if (x.pos >= y.pos) continue;
      pairs++;
      if (x.key < y.key) { bad++; if (ex.length < 10) ex.push({ frame: B.frame, ahead: x.c, behind: y.c, keys: [x.key, y.key] }); }
    }
  }
  return { name: 'race positions follow the game\'s rule (laps + segment, one frame late)', framesChecked: frames, orderedPairs: pairs, violations: bad, examples: ex,
    result: 'info', criterion: 'model only (not a pass/fail check): the car placed ahead had covered at least as many laps + segments in the previous frame; exceptions so far involve a car going backwards or two cars in one segment' };
}

// race order: the game's positions (car+AA) vs the order of the cars' race
// distance (laps and distance along the lap, from memory)
function checkOrder(run, every = 1) {
  const N = run.N, L = N * 1024;
  let frames = 0, agree = 0, inversions = 0, pairs = 0, retiredOk = 0, retiredN = 0;
  const invGaps = [], examples = [], persist = new Map(), runs = [];
  let finished = 0;
  for (let i = 0; i < run.frames.length; i += every) {
    const f = run.frames[i];
    if (f.inSession === false) continue;
    const live = [], ret = [];
    for (let c = 0; c < NCARS; c++) {
      const car = f.cars[c];
      if (car[C.retired]) ret.push(c); // retired cars stay in the comparison: they keep their place until passed
      // finished cars (lap > total) are frozen in their finishing order; compare only running cars
      if (car[C.lap] > run.totalLaps) { finished++; continue; }
      live.push({ c, pos: car[C.racePos], dist: (car[C.lap] - 1) * L + car[C.idx] * 1024 + car[C.along], pit: !!car[C.inPit], retired: !!car[C.retired] });
    }
    frames++;
    let inv = 0;
    const now = new Set();
    for (let a = 0; a < live.length; a++) for (let b = 0; b < live.length; b++) {
      const A = live[a], B = live[b];
      if (A.pos >= B.pos) continue; // A ahead of B in the game's order
      if (A.pit || B.pit) continue;  // pit-lane segment numbers are only roughly comparable
      pairs++;
      if (A.retired || B.retired) retiredN++;
      if (A.dist < B.dist) {
        inv++;
        if (A.retired || B.retired) retiredOk++;
        const gapM = ((B.dist - A.dist) * FINE_M);
        invGaps.push(gapM);
        const key = `${A.c}/${B.c}`;
        now.add(key);
        if (!persist.has(key)) persist.set(key, { start: f.frame, a: A.c, b: B.c, maxGapM: gapM });
        else persist.get(key).maxGapM = Math.max(persist.get(key).maxGapM, gapM);
        if (examples.length < 10) examples.push({ frame: f.frame, ahead: A.c, aheadPos: A.pos, behind: B.c, behindPos: B.pos, gapM: r1(gapM, 2) });
      }
    }
    for (const [key, v] of persist) if (!now.has(key)) { runs.push({ ...v, frames: f.frame - v.start, maxGapM: r1(v.maxGapM, 2) }); persist.delete(key); }
    inversions += inv;
    if (!inv) agree++;
  }
  for (const [, v] of persist) runs.push({ ...v, frames: null, maxGapM: r1(v.maxGapM, 2) });
  runs.sort((a, b) => (b.frames ?? 1e9) - (a.frames ?? 1e9));
  const lasting = runs.filter((r) => r.frames === null || r.frames > 2);
  const res = { name: 'race positions follow the order along the track', framesChecked: frames, framesFullyAgreeing: `${agree}/${frames}`,
    orderedPairs: pairs, invertedPairs: inversions, inversionGapM: quantiles(invGaps, [0, 0.5, 0.9, 1]),
    inversionSpells: runs.length, spellsLongerThan2Frames: lasting.length, longestSpells: runs.slice(0, 10), examples,
    pairsWithARetiredCar: retiredN, invertedPairsWithARetiredCar: retiredOk, finishedCarFramesSkipped: finished };
  const maxGap = invGaps.length ? maxOf(invGaps) : 0;
  res.maxInversionGapM = r1(maxGap, 2);
  res.result = frames > 0 && maxGap < 16 * FT + 0.5 ? 'pass' : 'fail';
  res.criterion = 'race positions agree with the exact race distance (laps, segment, distance along it) except between cars less than one segment + 0.5 m (5.4 m) apart; retired cars included (they keep their place until passed); pit-lane cars and cars that have finished excluded';
  return res;
}

// view keys: after each tap, the view mode and the viewed car change as the key says
function checkViews(run) {
  if (!run.keys.length) return { name: 'view keys move the view fields', result: 'not-tested', why: 'no keys.jsonl in this run' };
  const rows = [];
  let pass = 0;
  for (const k of run.keys) {
    const i0 = frameAt(run, k.tick);
    if (i0 < 0) continue;
    const f0 = run.frames[i0];
    const before = { mode: viewMode(f0.view), viewed: f0.viewed };
    const posOf = (f, slot) => f.cars[slot][C.racePos];
    const slotAt = (f, pos) => f.cars.findIndex((c) => c[C.racePos] === pos);
    let exp;
    switch (k.key) {
      case 'left': exp = { mode: 'tv', viewed: before.viewed }; break;
      case 'right': exp = { mode: 'cockpit', viewed: before.viewed }; break;
      case 'pagedown': exp = { mode: 'chase', viewed: before.viewed }; break;
      case 'delete': exp = { mode: 'reverse-chase', viewed: before.viewed }; break;
      case 'home': exp = { mode: before.mode, viewed: run.player }; break;
      case 'up': exp = { mode: before.mode, viewed: slotAt(f0, posOf(f0, before.viewed) - 1) }; break;
      case 'down': exp = { mode: before.mode, viewed: slotAt(f0, posOf(f0, before.viewed) + 1) }; break;
      default: exp = null;
    }
    // first frame within 2 s where the view or the viewed car changed, then where it settles (1 s later)
    let changedAt = null;
    for (let i = i0 + 1; i < run.frames.length && run.frames[i].tick - k.tick < 2000; i++) {
      const f = run.frames[i];
      if (viewMode(f.view) !== before.mode || f.viewed !== before.viewed) { changedAt = i; break; }
    }
    const iSettle = frameAt(run, k.tick + 1500);
    const fs1 = run.frames[iSettle];
    const after = { mode: viewMode(fs1.view), viewed: fs1.viewed, tvPlaced: (fs1.view & 0x40) !== 0, camIsCar: fs1.camIsCar };
    // "up"/"down" choose the neighbour at the moment of the key; accept the neighbour as it was in any frame up to the change
    let ok = exp && after.mode === exp.mode && after.viewed === exp.viewed;
    if (exp && !ok && (k.key === 'up' || k.key === 'down') && changedAt !== null) {
      const fc = run.frames[changedAt - 1];
      const alt = slotAt(fc, posOf(fc, before.viewed) + (k.key === 'up' ? -1 : 1));
      if (after.mode === exp.mode && after.viewed === alt) ok = true;
    }
    if (ok) pass++;
    rows.push({ t: k.t, key: k.key, before, expected: exp, after, latencyFrames: changedAt !== null ? run.frames[changedAt].frame - f0.frame : null, ok,
      viewedPos: { before: before.viewed !== null ? posOf(f0, before.viewed) : null, after: after.viewed !== null ? posOf(fs1, after.viewed) : null } });
  }
  return { name: 'view keys move the view fields', taps: rows.length, ok: `${pass}/${rows.length}`, rows, result: rows.length && pass === rows.length ? 'pass' : 'fail',
    criterion: 'Left = TV, Right = cockpit, PgDn = chase, Delete = reverse chase (same car); Up/Down = the car one place ahead/behind (same view); Home = the player' };
}

// the camera the game draws from, against the viewed car (all frames)
function checkCameras(run, G, motion) {
  const keyTicks = run.keys.map((k) => k.tick);
  const nearKey = (t) => keyTicks.some((k) => t >= k && t - k < 2500);
  const trans = { chase: [], 'reverse-chase': [] };
  const out = { cockpit: { n: 0, exact: 0, maxErrFine: 0, derived: 0, cars: new Set() }, chase: { dist: [], bearingErrDeg: [], headingErrDeg: [] }, 'reverse-chase': { dist: [], bearingErrDeg: [], headingErrDeg: [] },
    tv: { n: 0, standDistM: [], aimErrDeg: [], carDistM: [], unplaced: 0, stands: new Set() } };
  const stands = G.cameras.map((c) => [c.x, c.y]);
  run.frames.forEach((f, fi) => {
    if (f.viewed === null || f.viewed === undefined || f.inSession === false) return;
    if (f.consistent === false || motion.off.has(fi)) return;
    const c = f.cars[f.viewed];
    const mode = viewMode(f.view);
    const dx = c[C.x] - f.cam[0], dy = c[C.y] - f.cam[1];
    if (mode === 'cockpit' && f.camIsCar !== false) {
      const o = out.cockpit; o.n++;
      const e = Math.hypot(dx, dy) / 256;
      if (e === 0) o.exact++;
      o.maxErrFine = Math.max(o.maxErrFine, e);
      if (c[C.src] === 2) { o.derived++; o.cars.add(f.viewed); }
    } else if (mode === 'chase' || mode === 'reverse-chase') {
      const o = out[mode];
      o.dist.push(Math.hypot(dx, dy) / 16384);
      if (c.length > C.heading) {
        // chase: the camera is behind the car, reverse: ahead of it, along the car's direction of
        // travel (seen in a spin: the camera follows the motion, not the heading); the direction
        // is taken from the step since the previous record, or the heading when the car is still
        const pf = run.frames[fi - 1];
        let dir = c[C.heading];
        if (pf && f.frame - pf.frame === 1) {
          const q = pf.cars[f.viewed], mx = c[C.x] - q[C.x], my = c[C.y] - q[C.y];
          if (Math.hypot(mx, my) / 256 > 64) dir = bearing(mx, my);
        }
        const b = mode === 'chase' ? bearing(dx, dy) : bearing(-dx, -dy);
        const be = Math.abs(deg(wrap16(b - dir)));
        const camLook = mode === 'chase' ? dir : (dir + 0x8000) & 0xffff;
        const he = Math.abs(deg(wrap16(f.cam[3] - camLook)));
        if (nearKey(f.tick)) trans[mode].push(be); // the camera swings round after a view key
        else { o.bearingErrDeg.push(be); o.headingErrDeg.push(he); }
      }
    } else if (mode === 'tv') {
      const o = out.tv; o.n++;
      if (!(f.view & 0x40)) { o.unplaced++; return; }
      let best = Infinity, bi = -1;
      for (let s = 0; s < stands.length; s++) { const d = Math.hypot(stands[s][0] - f.cam[0], stands[s][1] - f.cam[1]); if (d < best) { best = d; bi = s; } }
      o.standDistM.push(best / 16384 * FT); o.stands.add(bi);
      o.carDistM.push(Math.hypot(dx, dy) / 16384 * FT);
      o.aimErrDeg.push(Math.abs(deg(wrap16(bearing(dx, dy) - f.cam[3]))));
    }
  });
  const q = (a) => quantiles(a.map((v) => +v.toFixed(3)), [0, 0.5, 0.99, 1]);
  const res = { name: 'camera follows the viewed car',
    cockpit: { frames: out.cockpit.n, exactAtCar: `${out.cockpit.exact}/${out.cockpit.n}`, maxErrFine: out.cockpit.maxErrFine, derivedFrames: out.cockpit.derived, computerCarsRidden: out.cockpit.cars.size },
    chase: { frames: out.chase.dist.length, distFt: q(out.chase.dist), bearingErrDeg: q(out.chase.bearingErrDeg), cameraHeadingErrDeg: q(out.chase.headingErrDeg), framesWithin2p5sOfAViewKey: trans.chase.length, maxBearingErrInThoseDeg: trans.chase.length ? r1(maxOf(trans.chase), 1) : null },
    reverseChase: { frames: out['reverse-chase'].dist.length, distFt: q(out['reverse-chase'].dist), bearingErrDeg: q(out['reverse-chase'].bearingErrDeg), cameraHeadingErrDeg: q(out['reverse-chase'].headingErrDeg), framesWithin2p5sOfAViewKey: trans['reverse-chase'].length, maxBearingErrInThoseDeg: trans['reverse-chase'].length ? r1(maxOf(trans['reverse-chase']), 1) : null },
    tv: { frames: out.tv.n, notYetPlaced: out.tv.unplaced, distToNearestTrackFileCameraStandM: q(out.tv.standDistM), standsUsed: out.tv.stands.size, carDistM: q(out.tv.carDistM), aimErrDeg: q(out.tv.aimErrDeg) } };
  const ok = [];
  ok.push(out.cockpit.n === 0 || out.cockpit.exact === out.cockpit.n);
  for (const m of ['chase', 'reverse-chase']) if (out[m].dist.length) ok.push(Math.abs(quantiles(out[m].dist).p50 - 30) < 0.1);
  if (out.tv.aimErrDeg.length) ok.push(quantiles(out.tv.aimErrDeg).p99 < 15);
  res.result = ok.every(Boolean) ? 'pass' : 'fail';
  if (out.chase.bearingErrDeg.length) ok.push(quantiles(out.chase.bearingErrDeg).max < 15);
  if (out['reverse-chase'].bearingErrDeg.length) ok.push(quantiles(out['reverse-chase'].bearingErrDeg).max < 15);
  res.result = ok.every(Boolean) ? 'pass' : 'fail';
  res.criterion = 'cockpit: camera x/y = viewed car x/y exactly (consistent records); chase/reverse: camera 30 ft from the car, behind/ahead of it along its direction of travel within 15 deg (the camera is damped) once 2.5 s have passed since a view key; TV: camera aimed within 15 deg of the car (p99)';
  return res;
}

// the end of the race: finishing order = order of crossing the line after the final lap
function checkFinish(run, laps) {
  const T = run.totalLaps;
  const fin = [];
  for (let c = 0; c < NCARS; c++) { const x = laps.crossings[c].find((e) => e.lap === T + 1); if (x) fin.push({ c, tick: x.tick, frame: x.frame }); }
  if (!fin.length) return { name: 'finish order', result: 'not-tested', why: 'no car completed the race distance in this run' };
  fin.sort((a, b) => a.tick - b.tick);
  const last = run.frames[run.frames.length - 1];
  const rows = fin.map((e, k) => ({ order: k + 1, slot: e.c, number: last.cars[e.c][C.number], gameSecond: r1((e.tick - run.frames[0].tick) / 1000, 2), racePosAtEnd: last.cars[e.c][C.racePos] }));
  // cars crossing in the same frame have no order between them
  let ok = 0;
  for (const r of rows) {
    const same = rows.filter((x) => x.gameSecond === r.gameSecond).map((x) => x.order);
    if (same.includes(r.racePosAtEnd) || r.racePosAtEnd === r.order) ok++;
  }
  const playerRow = rows.find((r) => r.slot === run.player);
  return { name: 'finish order', finishers: rows.length, positionsMatchCrossingOrder: `${ok}/${rows.length}`, playerFinished: !!playerRow, player: playerRow || null, rows,
    endState: { inSession: last.inSession, notInCar: last.notInCar, leaving: last.leaving, leaderLapsDone: last.leaderLapsDone, runners: last.runners },
    result: ok === rows.length ? 'pass' : 'fail', criterion: 'racePos at the end = order in which the cars completed the final lap' };
}

// ------------------------------------------------------------ main
// Run every check on one recorded run; writes <dir>/report.json and returns the report.
// TF = the lib/track-file.mjs module (ES module, so the caller imports it).
function checkRun(dir, TF, { write = true } = {}) {
  const run = loadRun(dir);
  const circuit = run.meta.atGreen.session.circuit;
  const trackFile = path.join(__dirname, '..', '..', 'original', `f1ct${String(circuit + 1).padStart(2, '0')}.dat`);
  const outline = TF.trackOutline(TF.parseTrack(new Uint8Array(fs.readFileSync(trackFile))));
  const G = buildGeometry(path.relative(path.join(__dirname, '..'), trackFile), outline);
  const laps = checkLaps(run);
  const motion = fieldMotion(run);
  run.motion = motion;
  const checks = [checkFrames(run), checkReads(run, motion), checkPresence(run), checkDash(run), checkContinuity(run, motion), checkOnTrack(run, G), laps,
    checkOrderRule(run, motion), checkOrder(run), checkViews(run), checkCameras(run, G, motion), checkFinish(run, laps)];
  const crossings = laps.crossings; delete laps.crossings;
  const F = run.frames;
  const valid = (v) => (v & 0xf0000000 ? null : v);
  const report = {
    run: path.relative(path.join(__dirname, '..'), dir), mode: run.meta.mode, warp: run.meta.warp || 1, bundle: run.meta.bundle,
    gameSeconds: F.length ? r1((F[F.length - 1].tick - F[0].tick) / 1000, 1) : 0, frames: F.length,
    playerSlot: run.player, playerLapAtEnd: F.length ? F[F.length - 1].cars[run.player][C.lap] : null, totalLaps: run.totalLaps,
    playerLapTimesMs: crossings[run.player].filter((e) => e.lap >= 2).map((e) => valid(e.last)),
    lapTimesMsByCar: crossings.map((x) => x.filter((e) => e.lap >= 2).map((e) => valid(e.last))),
    summary: Object.fromEntries(checks.map((c) => [c.name, c.result])),
    checks,
  };
  if (write) fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify(report, null, 1));
  return report;
}

function printReport(report) {
  console.log(`\n${report.run}: ${report.gameSeconds} game s, ${report.frames} frames, player lap ${report.playerLapAtEnd}/${report.totalLaps}, player lap times ${JSON.stringify(report.playerLapTimesMs)}`);
  for (const c of report.checks) {
    const brief = { ...c }; delete brief.name; delete brief.result; delete brief.criterion;
    for (const k of ['rows', 'examples', 'jumpExamples', 'violationExamples', 'groups', 'longestSpells', 'carMedianRatio', 'lapTimeExamples', 'offRows', 'flaggedStartLaps']) delete brief[k];
    console.log(`  ${c.result.padEnd(10)} ${c.name}: ${JSON.stringify(brief).slice(0, 600)}`);
  }
}

module.exports = { checkRun, printReport, loadRun, C };

if (require.main === module) {
  (async () => {
    const dirs = process.argv.slice(2);
    if (!dirs.length) { console.error('usage: node probes/p1-accuracy-check.cjs RUN_DIR...'); process.exit(2); }
    const TF = await import(pathToFileURL(path.join(__dirname, '..', 'lib', 'track-file.mjs')).href);
    let failed = 0;
    for (const dir of dirs) {
      const report = checkRun(dir, TF);
      printReport(report);
      failed += report.checks.filter((c) => c.result === 'fail').length;
    }
    process.exit(failed ? 1 : 0);
  })();
}
