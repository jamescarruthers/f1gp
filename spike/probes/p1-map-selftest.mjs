// p1-map-selftest.mjs - Node checks of the pure parts of lib/map-view.mjs and probes/p1-map-lib.mjs.
//
//   cd spike && node --test probes/p1-map-selftest.mjs
//
// Synthetic tests always run. Two more need data that is not in git and skip
// without it: the Monza track file (../original/f1ct12.dat) and a RAM dump
// from the state agent's Quick Race (out/p1-state/drive/ram-green.bin).
// MapView itself needs a canvas and is checked in the browser by
// probes/p1-map-run.mjs (screenshots in out/p1-map/).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { angleDiff, interpolate, Trails, fitTransform, toScreen, snapState, tableRows, outlineFromTrackFile, outlineFromMemory, compareOutlines, WORLD_PER_FOOT } from '../lib/map-view.mjs';
import { parseTrack, trackOutline } from '../lib/track-file.mjs';
import { fromRam } from '../lib/f1gp-mem.mjs';
import { readState, readTrack } from '../lib/f1gp-state.mjs';
import { checkSample, tally } from './p1-map-lib.mjs';

const SPIKE = path.join(import.meta.dirname, '..');
const TRACK = path.join(SPIKE, '..', 'original', 'f1ct12.dat');
const RAM = path.join(SPIKE, 'out', 'p1-state', 'drive', 'ram-green.bin');
const exists = (p) => { try { fs.accessSync(p); return true; } catch { return false; } };

// a fake readState() result with n cars
function fakeState(frame, cars, extra = {}) {
  return {
    frame, frameMs: 66.6656, tick: Math.round(frame * 66.6656), playerSlot: 0, raceOrder: cars.map((_, i) => i),
    view: { viewedSlot: 0, mode: 'cockpit', cameraIsCar: true }, camera: { x: cars[0].x, y: cars[0].y, heading: cars[0].heading ?? 0 },
    cars: cars.map((c, i) => ({ slot: i, number: c.number ?? i + 1, name: `D${i}`, isPlayer: i === 0, retired: false, inPit: false, pitting: false, pitState: 0,
      pos: 'derived', visible: true, racePos: i + 1, lap: 1, speed: 0, speedMph: 0, heading: 0, ...c })),
    ...extra,
  };
}

test('angleDiff takes the short way round', () => {
  assert.equal(angleDiff(0xfff0, 0x0010), 0x20);
  assert.equal(angleDiff(0x0010, 0xfff0), -0x20);
  assert.equal(angleDiff(0x4000, 0xc000), -0x8000);
});

test('interpolate: prev at alpha 0, cur at alpha 1, halfway in between; jumps snap', () => {
  const ft = WORLD_PER_FOOT;
  const a = snapState(fakeState(100, [{ x: 0, y: 0, heading: 0xfff0 }, { x: 0, y: 0 }]));
  const b = snapState(fakeState(101, [{ x: 20 * ft, y: 10 * ft, heading: 0x0010 }, { x: 5000 * ft, y: 0 }]));
  const t = 1000, dur = b.frameMs;
  let o = interpolate(a, b, t, t);
  assert.deepEqual([o.x[0], o.y[0], o.alpha], [0, 0, 0]);
  o = interpolate(a, b, t, t + dur / 2, o);
  assert.ok(Math.abs(o.x[0] - 10) < 1e-9 && Math.abs(o.y[0] - 5) < 1e-9);
  assert.equal(o.h[0], 0); // 0xfff0 -> 0x0010 through 0
  assert.equal(o.x[1], 5000); // 5000 ft in one frame: not interpolated
  o = interpolate(a, b, t, t + dur * 3, o);
  assert.deepEqual([o.x[0], o.y[0], o.alpha], [20, 10, 1]);
  o = interpolate(null, b, t, t, o);
  assert.equal(o.x[0], 20);
});

test('Trails: ring buffer, newest first, a break after a jump', () => {
  const tr = new Trails(2, 4);
  const ft = WORLD_PER_FOOT;
  let prev = null;
  for (let f = 0; f < 6; f++) {
    const s = snapState(fakeState(f, [{ x: f * 10 * ft, y: 0 }, { x: f === 5 ? 9000 * ft : 0, y: 0 }]));
    tr.push(s, prev); prev = s;
  }
  assert.equal(tr.len[0], 4);
  assert.deepEqual(tr.at(0, 0), [50, 0]);
  assert.deepEqual(tr.at(0, 3), [20, 0]);
  assert.equal(tr.at(0, 4), null);
  assert.deepEqual(tr.at(1, 0), [9000, 0]);
  assert.ok(Number.isNaN(tr.at(1, 1)[0]), 'break before the jump');
});

test('fitTransform: bounds fit inside the box with Y up', () => {
  const t = fitTransform({ minX: -100, minY: 0, maxX: 100, maxY: 400 }, 300, 500, 10);
  const [x0, y0] = toScreen(t, -100, 0), [x1, y1] = toScreen(t, 100, 400);
  for (const v of [x0, x1]) assert.ok(v >= 10 - 1e-9 && v <= 290 + 1e-9);
  for (const v of [y0, y1]) assert.ok(v >= 10 - 1e-9 && v <= 490 + 1e-9);
  assert.ok(y1 < y0, 'larger Y is higher on the screen');
  assert.ok(Math.abs(y0 - y1 - 480) < 1e-9, 'the tall side fills the box');
});

test('snapState flags and tableRows order', () => {
  const st = fakeState(5, [{ x: 0, y: 0, pos: 'live' }, { x: 1, y: 1, retired: true, racePos: 3 }, { x: 2, y: 2, inPit: true, racePos: 2 }]);
  st.raceOrder = [0, 2, 1];
  const s = snapState(st);
  assert.deepEqual([...s.flags], [1 | 8, 2, 4]);
  const rows = tableRows(st);
  assert.deepEqual(rows.map((r) => r.slot), [0, 2, 1]);
  assert.deepEqual(rows.map((r) => r.status), ['', 'pit lane', 'retired']);
  assert.equal(rows[0].player, true);
});

test('checkSample: dash lag, the -1 case, table rows and the cockpit camera', () => {
  const car = { slot: 0, number: 1, mph: 100, lap: 2, pos: 4, src: 'live', x: 7, y: 8, status: '' };
  const s = {
    st: { frame: 10, view: 'cockpit', viewedSlot: 0, playerSlot: 0, cameraIsCar: true, camera: { x: 7, y: 8 }, runners: 26, totalLaps: 3, player: car, viewed: car },
    history: [8, 9, 10].map((f) => ({ frame: f, mph: [f * 10] })), fresh: { frame: 11, mph: [111] },
    table: { frame: 9, player: car, viewed: car, viewedSlot: 0 }, row: ['4', '1', 'X', '2', '100', 'live', ''],
  };
  assert.equal(checkSample(s, { mph: 100 }).mphLag, 0);
  assert.equal(checkSample(s, { mph: 80 }).mphLag, 2);
  assert.equal(checkSample(s, { mph: 111 }).mphLag, -1);
  assert.equal(checkSample(s, { mph: 55 }).mphLag, null);
  const c = checkSample(s, { mph: 100, lap: 2, laps: 3, car: 1, pos: 5, runners: 26 });
  assert.deepEqual([c.lap, c.laps, c.car, c.pos, c.runners, c.row, c.camera], [true, true, true, false, true, true, true]);
  const t = tally([c, checkSample(s, { mph: 55 })]);
  assert.deepEqual(t.mphLag, { 0: 1, none: 1 });
  assert.deepEqual(t.pos, { ok: 0, bad: 1, na: 0 });
});

test('Monza outline from the track file', { skip: !exists(TRACK) && 'no ../original/f1ct12.dat' }, () => {
  const o = outlineFromTrackFile(trackOutline(parseTrack(new Uint8Array(fs.readFileSync(TRACK)))));
  assert.equal(o.lapSegments, 1189);
  assert.equal(o.pit.centre.length, 161);
  const w = o.bounds.maxX - o.bounds.minX, h = o.bounds.maxY - o.bounds.minY;
  assert.ok(w > 3700 && w < 4000 && h > 7100 && h < 7400, `bounds ${w} x ${h} ft`);
  // a lap is 1189 x 16 ft along the centre line
  let len = 0;
  for (let i = 0; i < o.centre.length; i++) { const a = o.centre[i], b = o.centre[(i + 1) % o.centre.length]; len += Math.hypot(b[0] - a[0], b[1] - a[1]); }
  assert.ok(Math.abs(len / 1189 - 16) < 0.05, `mean segment ${len / 1189} ft`);
});

test('track-file outline equals the game memory outline (RAM dump)', { skip: (!exists(TRACK) || !exists(RAM)) && 'needs the track file and out/p1-state/drive/ram-green.bin' }, () => {
  const mem = fromRam(new Uint8Array(fs.readFileSync(RAM)));
  const st = readState(mem);
  assert.equal(st.session.circuit, 11);
  const file = outlineFromTrackFile(trackOutline(parseTrack(new Uint8Array(fs.readFileSync(TRACK)))));
  const memo = outlineFromMemory(readTrack(mem));
  const cmp = compareOutlines(file, memo);
  assert.equal(cmp.n, 1189);
  assert.equal(cmp.maxCentreFt, 0);
  assert.ok(cmp.maxEdgeFt < 0.5, `edges within ${cmp.maxEdgeFt} ft`);
  // every car of the dump lies on the circuit: within half a track width (+ margin) of the centre line
  for (const c of st.cars) {
    const x = c.x / WORLD_PER_FOOT, y = c.y / WORLD_PER_FOOT;
    let best = Infinity;
    for (const p of file.centre) best = Math.min(best, Math.hypot(p[0] - x, p[1] - y));
    assert.ok(best < 60, `car ${c.number} is ${best.toFixed(1)} ft from the centre line`);
  }
});
