// p1-map-lib.mjs - helpers for the map.html probes (p1-map-run.mjs, p1-map-race.mjs).
//
//   import { readDash, sample, checkSample, tally, installAutopilot } from './p1-map-lib.mjs';
//
// readDash(img)        the dash LCD of a 320x200 RGBA framebuffer: mph, lap, laps, car, pos, runners,
//                      lapTime, best (null where a cell is not readable). The digit font and the cell
//                      layout are copied from probes/p1-state-watch.cjs, whose DIGITS table is a copy of
//                      lib/route.cjs (not exported there).
// sample(page)         one evaluate in map.html: the kept state (viewed and player car, camera), the
//                      last 12 kept frames' speeds, the table rows of the player and the viewed car with
//                      the state the table was built from, and the emulator framebuffer.
// checkSample(s, d)    compare one sample with its dash reading d: { mphLag (frames the dash is behind the
//                      kept state: 0..5, -1 = the game drew one more frame before the screenshot, or null), lap, pos,
//                      car, runners, laps (true/false/undefined), row (table text = its state), camera
//                      (cockpit camera = viewed car position, exact) }
// tally(checks)        counts of the above
// installAutopilot     a page function (page.evaluate(installAutopilot, opts)): the autopilot of
//                      p1-state-watch.cjs drive mode moved into the page, on the page's own reader
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const route = require('../lib/route.cjs');

// ---------------------------------------------------------------- dash LCD
const DIGITS = {
  '.####.#....##....##....##....#.####.': 0, '..#....##.....#.....#.....#....###..': 1,
  '.####.#....#...##..##...#.....######': 2, '######....#....##......##....#.####.': 3,
  '....#....##...#.#..#..#.######....#.': 4, '#######.....#####......#.....######.': 5,
  '.####.#.....#####.#....##....#.####.': 6, '######....#....#....#....#.....#....': 7,
  '.####.#....#.####.#....##....#.####.': 8, '.####.#....#.####.....#....#....#...': 9,
};
const BLANK = '.'.repeat(36);
function glyphAt(img, x0, y0) {
  let g = '';
  for (let y = y0; y < y0 + 6; y++) for (let x = x0; x < x0 + 6; x++) {
    const [r, gg, b] = route.px(img, x, y);
    g += r + gg + b < 60 ? '#' : '.';
  }
  return g;
}
function num(img, xs, y) {
  let v = '', started = false;
  for (let i = 0; i < xs.length; i++) {
    const g = glyphAt(img, xs[i], y), d = DIGITS[g];
    if (d === undefined) {
      if (!started && g === BLANK && i < xs.length - 1) continue;
      return null;
    }
    started = true; v += d;
  }
  return started ? Number(v) : null;
}
function lapTimeAt(img, y) {
  const d = [178, 189, 196, 207, 214, 221].map((x) => DIGITS[glyphAt(img, x, y)]);
  if (d.some((v) => v === undefined)) return null;
  return d[0] * 60000 + (d[1] * 10 + d[2]) * 1000 + d[3] * 100 + d[4] * 10 + d[5];
}
export function readDash(img) {
  const d = { mph: route.readMph(img) };
  const lt = lapTimeAt(img, 184);
  if (lt !== null) d.lapTime = lt;
  else { d.lap = num(img, [181, 188], 184); d.laps = num(img, [214, 221], 184); }
  d.car = num(img, [108, 115], 193);
  d.pos = num(img, [140, 147], 193);
  const best = lapTimeAt(img, 193);
  if (best !== null) d.best = best; else d.runners = num(img, [214, 221], 193);
  return d;
}

// ---------------------------------------------------------------- sampling
export async function sample(page) {
  const r = await page.evaluate(async () => {
    const app = window.mapApp, st = app.kept, ts = app.tableState;
    const img = await window.ci.screenshot();
    // a fresh read right after the screenshot: the game may have finished another frame since the last animation frame
    const fresh = app.reader.read();
    const bytes = new Uint8Array(img.data.buffer, img.data.byteOffset, img.data.byteLength);
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    const rowOf = (sel) => { const row = document.querySelector(sel); return row ? [...row.cells].map((c) => c.textContent) : null; };
    const car = (c) => c && { slot: c.slot, number: c.number, mph: c.speedMph, lap: c.lap, pos: c.racePos, src: c.pos, x: c.x, y: c.y,
      inPit: c.inPit, retired: c.retired, lastLapMs: c.lastLapMs, status: c.retired ? 'retired' : c.pitState === 2 ? 'on the jacks' : c.inPit ? 'pit lane' : c.pitting ? 'pitting' : '' };
    return {
      t: Math.round(performance.now()),
      img: { width: img.width, height: img.height, b64: btoa(s) },
      st: st && { frame: st.frame, view: st.view.mode, viewedSlot: st.view.viewedSlot, playerSlot: st.playerSlot, cameraIsCar: st.view.cameraIsCar,
        camera: { x: st.camera.x, y: st.camera.y }, runners: st.session.runners, totalLaps: st.session.totalLaps, paused: st.paused,
        player: car(st.cars[st.playerSlot]), viewed: car(st.cars[st.view.viewedSlot]),
        sources: st.cars.reduce((a, c) => { a[c.pos] = (a[c.pos] || 0) + 1; return a; }, {}) },
      history: app.history.map((h) => ({ frame: h.frame, mph: h.mph })),
      latestFrame: app.state ? app.state.frame : null,
      fresh: { frame: fresh.frame, consistent: fresh.consistent, viewedSlot: fresh.view.viewedSlot, mph: fresh.cars.map((c) => c.speedMph),
        lap: fresh.cars.map((c) => c.lap), pos: fresh.cars.map((c) => c.racePos) },
      table: ts && { frame: ts.frame, player: car(ts.cars[ts.playerSlot]), viewed: car(ts.cars[ts.view.viewedSlot]), viewedSlot: ts.view.viewedSlot },
      row: rowOf('#cars tr.player'), viewedRow: rowOf('#cars tr.viewed'),
    };
  });
  const img = { width: r.img.width, height: r.img.height, data: new Uint8Array(Buffer.from(r.img.b64, 'base64')) };
  delete r.img;
  return { ...r, img };
}

const rowMatches = (row, c) => row && c && +row[0] === c.pos && +row[1] === c.number && +row[3] === c.lap && +row[4] === c.mph && row[5] === c.src && row[6] === c.status;

export function checkSample(s, d) {
  const out = { frame: s.st ? s.st.frame : null, view: s.st ? s.st.view : null };
  if (!s.st) return out;
  const v = s.st.viewed;
  if (d.mph !== null && d.mph !== undefined && v) {
    out.mphLag = null;
    const slot = s.st.viewedSlot;
    for (let k = 0; k <= 5; k++) {
      const h = s.history.find((x) => x.frame === s.st.frame - k);
      if (h && h.mph[slot] === d.mph) { out.mphLag = k; break; }
    }
    // the dash drawn one frame after the kept state: compare with the read taken just after the screenshot
    if (out.mphLag === null && s.fresh && s.fresh.frame === s.st.frame + 1 && s.fresh.mph[slot] === d.mph) out.mphLag = -1;
    out.mphDiff = d.mph - v.mph;
  }
  if (v) {
    // lap and position: the kept state, or the read just after the screenshot when the game drew one more frame
    const next = s.fresh && s.fresh.frame === s.st.frame + 1 && s.fresh.lap ? s.fresh : null, slot = s.st.viewedSlot;
    const same = (dv, kept, key) => {
      if (dv === kept) return true;
      if (next && next[key][slot] === dv) { out.dashOneFrameAhead = true; return true; }
      return false;
    };
    if (d.lap !== null && d.lap !== undefined) out.lap = same(d.lap, v.lap, 'lap');
    if (d.pos !== null && d.pos !== undefined) out.pos = same(d.pos, v.pos, 'pos');
    if (d.car !== null && d.car !== undefined) out.car = d.car === v.number;
  }
  if (d.runners !== null && d.runners !== undefined) out.runners = d.runners === s.st.runners;
  if (d.laps !== null && d.laps !== undefined) out.laps = d.laps === s.st.totalLaps;
  if (d.lapTime !== null && d.lapTime !== undefined && v) out.lapTime = v.lastLapMs === null ? null : d.lapTime === v.lastLapMs;
  if (s.table) {
    out.row = rowMatches(s.row, s.table.player);
    if (s.table.viewedSlot !== s.table.player?.slot) out.viewedRow = rowMatches(s.viewedRow, s.table.viewed);
  }
  if (s.st.view === 'cockpit' && s.st.cameraIsCar && v) out.camera = s.st.camera.x === v.x && s.st.camera.y === v.y;
  return out;
}

export function tally(checks) {
  const t = { samples: checks.length };
  for (const c of checks) for (const [k, val] of Object.entries(c)) {
    if (k === 'frame' || k === 'mphDiff') continue;
    if (k === 'dashOneFrameAhead') { t.dashOneFrameAhead = (t.dashOneFrameAhead || 0) + 1; continue; }
    if (k === 'view') { t[`view_${val}`] = (t[`view_${val}`] || 0) + 1; continue; }
    if (k === 'mphLag') { t.mphLag = t.mphLag || {}; const key = val === null ? 'none' : String(val); t.mphLag[key] = (t.mphLag[key] || 0) + 1; continue; }
    if (val === undefined) continue;
    t[k] = t[k] || { ok: 0, bad: 0, na: 0 };
    t[k][val === true ? 'ok' : val === false ? 'bad' : 'na']++;
  }
  return t;
}

// ---------------------------------------------------------------- in-page autopilot
// Pure pursuit on the in-memory centreline, speed from the curvature ahead:
// the method and constants of p1-state-watch.cjs drive mode. It acts once per
// new game frame, polling every `pollMs`.
export async function installAutopilot({ pollMs = 25 } = {}) {
  const { readTrack } = await import('/lib/f1gp-state.mjs');
  const app = window.mapApp, ci = window.ci;
  const reader = app.reader, track = readTrack(app.mem), n = track.lapSegments;
  const ALAT = 62, BRAKE = 78, LAG = 0.25, DEADBAND = 300;
  const K = { a: 65, z: 90, comma: 44, period: 46 };
  const held = new Set();
  const down = (k) => { if (!held.has(k)) { held.add(k); ci.sendKeyEvent(K[k], true); } };
  const up = (k) => { if (held.has(k)) { held.delete(k); ci.sendKeyEvent(K[k], false); } };
  const wrap16 = (v) => (((v & 0xffff) + 0x8000) & 0xffff) - 0x8000;
  let prevHead = null, prevFrame = null, lastFrame = -1;
  const ap = window.autopilot = { log: [], ticks: 0, on: true };
  const step = () => {
    if (!ap.on) return;
    const st = reader.read();
    if (!st.inSession || st.frame === lastFrame) return;
    lastFrame = st.frame;
    ap.ticks++;
    const c = st.cars[st.playerSlot];
    if (!c || c.retired) { for (const k of [...held]) up(k); return; }
    const vft = c.speed / 64;
    if (c.inPit || !track.lap[c.trackIndex]) { down('a'); up('z'); up('comma'); up('period'); return; }
    const si = c.trackIndex;
    const look = Math.max(3, Math.min(14, Math.round(3 + (vft * 0.45) / 16)));
    const tgt = track.lap[(si + look) % n].centre;
    const desired = Math.round((Math.atan2(tgt[0] - c.x, tgt[1] - c.y) / (2 * Math.PI)) * 65536);
    const err = wrap16(desired - c.heading);
    // heading rate per game second (game time, so it also works with a warped clock)
    let rate = 0;
    if (prevHead !== null && st.frame > prevFrame) rate = wrap16(c.heading - prevHead) / (((st.frame - prevFrame) * st.frameMs) / 1000);
    prevHead = c.heading; prevFrame = st.frame;
    const pred = err - rate * LAG;
    if (pred > DEADBAND) { down('period'); up('comma'); } else if (pred < -DEADBAND) { down('comma'); up('period'); } else { up('comma'); up('period'); }
    let allowed = 1e9;
    const done = Math.max(0, Math.min(1, c.fraction / 0x4000));
    for (let k = 0; k <= 45; k++) {
      const a0 = track.lap[(si + k - 1 + n) % n].heading, a1 = track.lap[(si + k + 2) % n].heading;
      const curv = Math.abs(wrap16(a1 - a0)) / 3;
      if (curv < 8) continue;
      const R = 16 / ((curv * 2 * Math.PI) / 65536);
      const va = Math.sqrt(ALAT * R + 2 * BRAKE * Math.max(0, (k - done) * 16));
      if (va < allowed) allowed = va;
    }
    let p = '-';
    if (vft < allowed * 0.97) { down('a'); up('z'); p = 'A'; } else if (vft > allowed * 1.07) { down('z'); up('a'); p = 'Z'; } else { up('a'); up('z'); }
    if (ap.ticks % 15 === 0) ap.log.push({ frame: st.frame, idx: si, mph: c.speedMph, lap: c.lap, allowed: Math.round(allowed), p });
  };
  ap.timer = setInterval(step, pollMs);
  ap.stop = () => { ap.on = false; clearInterval(ap.timer); for (const k of [...held]) up(k); };
  return { lapSegments: n };
}
