// Tests for lib/f1gp-mem.mjs and lib/f1gp-state.mjs.
//
//   cd spike && node --test tests/f1gp-state.test.mjs
//
// 1. Synthetic memory (always runs): a made-up 1 MB guest RAM with our own
//    numbers (no game bytes) checks the arithmetic of the position formula,
//    the live/derived/none choice, flags, the frame number and readTrack.
// 2. RAM dumps (skipped when absent): out/p1-state/*/ram-*.bin and the dumps
//    other probes saved (out/p1-fields, out/p1-track).
// 3. Traces from probes/p1-state-watch.cjs (skipped when absent):
//    out/p1-state/drive (autopilot) and out/p1-state/coast (riding in
//    computer cars). Compares the state with the dash LCD, the lap timer and
//    the game's own camera.
// 4. Track model cross-check (skipped without ../original/f1ctNN.dat):
//    lib/track-file.mjs against the segments readTrack() reads.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { attach, fromRam, findGuestRam } from '../lib/f1gp-mem.mjs';
import { readState, createReader, readTrack, derivePose, gameCos, speedToMph, CAR0, CAR_SIZE, NCARS, SEG_SIZE } from '../lib/f1gp-state.mjs';
import { cosTable, parseTrack, trackOutline, lookupSegment, segmentToWorld } from '../lib/track-file.mjs';

const HERE = import.meta.dirname;
const OUT = path.join(HERE, '..', 'out');
const GAME = path.join(HERE, '..', '..', 'original');
const exists = (p) => { try { fs.accessSync(p); return true; } catch { return false; } };
const readJsonl = (p) => fs.readFileSync(p, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
const quantile = (a, q) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * q))]; };

// ------------------------------------------------------------ synthetic memory

const IMG = 0x1a2, DS = IMG + 0x1e61, SS = IMG + 0x2914;
const TSEG = 0x4263, PSEG = 0x326c, POFF = 0xd7ae;

function fakeRam() {
  const ram = new Uint8Array(0x110000);
  const dv = new DataView(ram.buffer);
  const L = (seg, off) => (seg << 4) + off;
  const w = {
    ram,
    u8: (s, o, v) => { ram[L(s, o)] = v; },
    u16: (s, o, v) => dv.setUint16(L(s, o), v & 0xffff, true),
    u32: (s, o, v) => dv.setUint32(L(s, o), v >>> 0, true),
  };
  const C = cosTable();
  for (let i = 0; i < C.length; i++) w.u16(SS, 0x3264 + 2 * i, C[i]);
  w.u16(DS, 0x87a1, TSEG); w.u16(DS, 0x879f, 0x30);
  w.u16(DS, 0x8799, PSEG); w.u16(DS, 0x8797, POFF);
  for (let i = 0; i < NCARS; i++) {
    const p = CAR0 + i * CAR_SIZE;
    w.u8(DS, p + 0xac, i === 3 ? 0x81 : i + 2);
    w.u8(DS, p + 0x7e, i === 3 ? 0x01 : 0x04);
    w.u8(DS, p + 0xaa, 2 * i);
    w.u16(DS, p + 0x14, TSEG); w.u16(DS, p + 0x12, 0x30);
    w.u8(SS, 0x1940 + i, i === 3 ? 0x81 : i + 2);
  }
  w.u16(DS, 0x28fd, CAR0 + 3 * CAR_SIZE);
  w.u16(DS, 0x097f, CAR0 + 3 * CAR_SIZE); w.u16(DS, 0x097d, CAR0 + 3 * CAR_SIZE);
  w.u8(SS, 0x124a, 0x80); w.u16(SS, 0x1230, 20);
  return w;
}
// segment k of the track array: heading a, fine-unit position (x19, y19), z, dA (+14), pitch, nr
function putSeg(w, seg, off, { a = 0, x19 = 0, y19 = 0, z = 0, dA = 0, pitch = 0, nr = 0, halfWidth = 1024 }) {
  w.u16(seg, off, a); w.u16(seg, off + 2, pitch);
  w.u16(seg, off + 4, x19 >> 3); w.u16(seg, off + 6, z); w.u16(seg, off + 8, y19 >> 3);
  w.u8(seg, off + 0x21, (x19 & 7) | ((y19 & 7) << 4));
  w.u16(seg, off + 0x14, dA); w.u16(seg, off + 0x1a, nr);
  w.u16(seg, off + 0x0c, (halfWidth >> 5) & 63);
}
const carPtr = (i) => CAR0 + i * CAR_SIZE;
function putCar(w, i, { segOff = 0x30, segSeg = TSEG, lat = 0, along = 0, frac = 0, h8c = 0, heading = 0, m7e = 0x04, x = 0, y = 0 }) {
  const p = carPtr(i);
  w.u16(DS, p + 0x12, segOff); w.u16(DS, p + 0x14, segSeg);
  w.u16(DS, p + 0x0a, lat); w.u16(DS, p + 0x1c, along); w.u16(DS, p + 0x1e, frac);
  w.u16(DS, p + 0x8c, h8c); w.u16(DS, p + 0x1a, heading); w.u8(DS, p + 0x7e, m7e);
  w.u32(DS, p + 0x28, x); w.u32(DS, p + 0x2c, y);
}

test('synthetic: f1gp-mem finds guest RAM in a heap and reads by linear address and segment:offset', () => {
  const w = fakeRam();
  const heap = new Uint8Array(0x20000 + w.ram.length);
  heap.set(w.ram, 0x20000);
  const date = [0x30, 0x31, 0x2f, 0x30, 0x31, 0x2f, 0x39, 0x32];
  date.forEach((b, i) => { heap[0x20000 + 0xffff5 + i] = b; });
  heap[0x20000 + 0x86] = 0x00; heap[0x20000 + 0x87] = 0xf0; // INT 21h vector segment F000
  assert.equal(findGuestRam(heap), 0x20000);
  const mem = attach({ transport: { module: { HEAPU8: heap } } }, { imageSeg: IMG });
  assert.equal(mem.memBase, 0x20000);
  assert.equal(mem.DS, 0x2003); assert.equal(mem.SS, 0x2ab6);
  assert.equal(mem.checked, true);
  assert.equal(mem.ss.u16(0x1230), 20);
  assert.equal(mem.u16(mem.lin(SS, 0x1230)), 20);
  assert.equal(mem.ds.u16(0x28fd), carPtr(3));
  assert.throws(() => attach({}), /direct access/);
});

test('synthetic: derived position on a straight segment, heading 0 and heading 90 deg', () => {
  const w = fakeRam();
  putSeg(w, TSEG, 0x30, { a: 0, x19: 8000, y19: 16000 });
  putSeg(w, TSEG, 0x30 + SEG_SIZE, { a: 0x4000, x19: -5003, y19: 7005 });
  putCar(w, 0, { lat: 100, along: 300 });
  putCar(w, 1, { segOff: 0x30 + SEG_SIZE, lat: 100, along: 300 });
  const st = readState(fromRam(w.ram, { imageSeg: IMG }));
  const c0 = st.cars[0], c1 = st.cars[1];
  assert.equal(c0.pos, 'derived');
  // heading 0 = +y; lateral + = right = +x
  assert.deepEqual([c0.x / 256, c0.y / 256], [8100, 16300]);
  // heading 4000h = +x; right of travel = -y
  assert.deepEqual([c1.x / 256, c1.y / 256], [-5003 + 300, 7005 - 100]);
});

test('synthetic: corner correction (seg+14), fine bits, height and pitch follow the game formula', () => {
  const w = fakeRam();
  putSeg(w, TSEG, 0x30, { a: 0, x19: 8003, y19: 16005, z: 100, dA: 0x4000, pitch: 1000 });
  putSeg(w, TSEG, 0x30 + SEG_SIZE, { a: 0, x19: 8003, y19: 17029, z: 200 });
  putCar(w, 0, { lat: 512, along: 600, frac: 0x2000, h8c: 7, heading: 0x2000 });
  const st = readState(fromRam(w.ram, { imageSeg: IMG }));
  const c = st.cars[0];
  // along' = 600 - hiword(4000h * 512 * 2) = 600 - 256
  assert.deepEqual([c.x / 256, c.y / 256], [8003 + 512, 16005 + 600 - 256]);
  assert.equal(c.z, 100 + 50 + 7);                     // z0 + (z1 - z0) * 0.5 + car+8C
  assert.equal(c.pitch, (1000 * 11585) >> 14);         // pitch * cos 45 deg
  assert.equal(c.trackDist, 600);
});

test('synthetic: live copy for physics cars, none for a bad segment pointer, race order, flags', () => {
  const w = fakeRam();
  putSeg(w, TSEG, 0x30, { a: 0, x19: 0, y19: 0, nr: 0x8000 });
  putCar(w, 3, { m7e: 0x01, x: 123456789, y: -987654321 });
  putCar(w, 5, { segSeg: 0x1234, x: 42, y: 43 });
  w.u8(DS, carPtr(7) + 0x23, 0x20);
  w.u16(DS, carPtr(8) + 0x10, 13141);
  w.u32(DS, carPtr(8) + 0x40, 0x40005093); w.u32(DS, carPtr(9) + 0x40, 112022);
  w.u8(DS, 0x2227, 0x80); w.u8(DS, 0x0981, 0xc0); w.u16(DS, 0x097d, 0x099b);
  const st = readState(fromRam(w.ram, { imageSeg: IMG }));
  assert.equal(st.cars[3].pos, 'live');
  assert.deepEqual([st.cars[3].x, st.cars[3].y], [123456789, -987654321]);
  assert.equal(st.cars[3].isPlayer, true);
  assert.equal(st.cars.filter((c) => c.isPlayer).length, 1);
  assert.equal(st.cars[5].pos, 'none');
  assert.deepEqual([st.cars[5].x, st.cars[5].y], [42, 43]);
  assert.equal(st.cars[0].trackIndex, 0); assert.equal(st.cars[0].segNr, 0x8000);
  assert.equal(st.cars[7].inPit, true);
  assert.equal(st.cars[8].speedMph, 139); assert.equal(speedToMph(13141), 139);
  assert.equal(st.cars[8].lastLapMs, null); assert.equal(st.cars[9].lastLapMs, 112022);
  assert.deepEqual(st.raceOrder, [...Array(NCARS).keys()]);
  assert.equal(st.cars[4].racePos, 5);
  assert.equal(st.paused, true);
  assert.equal(st.view.mode, 'tv'); assert.equal(st.view.cameraIsCar, false); assert.equal(st.view.viewedSlot, 3);
  assert.equal(st.session.type, 'race'); assert.equal(st.session.fps, 15);
});

test('synthetic: frame number from the clock, settled and carsAhead flags', () => {
  const w = fakeRam();
  // 15 fps: step = 66 ms + 43624/65536 (DS:2241 / DS:2245), clock = 300 steps
  w.u32(DS, 0x2241, 66); w.u16(DS, 0x2245, 43624);
  const total = 300 * (66 + 43624 / 65536);
  w.u32(DS, 0x2955, Math.floor(total)); w.u16(DS, 0x2959, Math.round((total % 1) * 65536));
  w.u16(SS, 0x05c8, 12); w.u16(DS, 0x2c63, 7); w.u8(DS, 0x2977, (2 * 300 + 5) & 0xff);
  const mem = fromRam(w.ram, { imageSeg: IMG });
  const r = createReader(mem);
  let st = r.read();
  assert.equal(st.frame, 300);
  assert.equal(st.settled, true); assert.equal(st.carsAhead, false); assert.equal(st.consistent, true);
  // next frame's work has started: DS:2977 bumped, ticks since flip reset
  w.u8(DS, 0x2977, (2 * 301 + 5) & 0xff); w.u16(SS, 0x05c8, 1);
  st = r.read();
  assert.equal(st.settled, false); assert.equal(st.carsAhead, true); assert.equal(st.consistent, false);
});

test('synthetic: gameCos interpolates the table like image 0000:03C8', () => {
  const C = cosTable();
  for (let a = 0; a < 0x10000; a += 97) {
    const v = gameCos(C, a);
    assert.ok(Math.abs(v - 16384 * Math.cos((a / 65536) * 2 * Math.PI)) <= 2, `cos ${a}`);
  }
  assert.equal(gameCos(C, 0x8000), -16384);
  assert.equal(gameCos(C, 0xc000), gameCos(C, 0x4000));
});

test('synthetic: readTrack places entries by segment number (pit lane spliced into the track array)', () => {
  const w = fakeRam();
  // lap of 6 segments 0..5 whose 2..3 are bypassed by pit entries 2002h, 2003h (as in practice sessions)
  const trackArr = [0x8000, 1, 0x2002, 0x2003, 4, 5];
  trackArr.forEach((nr, k) => putSeg(w, TSEG, 0x30 + k * SEG_SIZE, { nr, x19: k * 1024, y19: nr & 0x2000 ? 5000 : 0 }));
  w.u16(SS, 0x015c, 0x30 + 6 * SEG_SIZE);
  [2, 3].forEach((nr, k) => putSeg(w, PSEG, POFF + k * SEG_SIZE, { nr, x19: nr * 1024, y19: 0 }));
  putSeg(w, PSEG, POFF + 2 * SEG_SIZE, { nr: 0x1234 });
  const tr = readTrack(fromRam(w.ram, { imageSeg: IMG }));
  assert.equal(tr.lapSegments, 6);
  assert.deepEqual(tr.lap.map((e) => e.index), [0, 1, 2, 3, 4, 5]);
  assert.deepEqual(tr.lap.map((e) => e.centre[0] / 256), [0, 1024, 2048, 3072, 4096, 5120]);
  assert.deepEqual(tr.pit.map((e) => e.nr), [0x2002, 0x2003]);
  assert.equal(tr.lap[0].halfWidth, 1024);
});

// ------------------------------------------------------------ RAM dumps

const DUMPS = [];
for (const dir of ['p1-state', 'p1-fields', 'p1-track']) {
  const base = path.join(OUT, dir);
  if (!exists(base)) continue;
  for (const run of fs.readdirSync(base)) {
    const d = path.join(base, run);
    if (!fs.statSync(d).isDirectory()) continue;
    for (const f of fs.readdirSync(d)) if (/^ram-.*\.bin$/.test(f)) DUMPS.push(path.join(d, f));
  }
}

test('RAM dumps: every car gets a position; the derived formula reproduces live X/Y', { skip: DUMPS.length ? false : 'no RAM dumps in out/' }, () => {
  let liveCars = 0, maxErr = 0;
  for (const f of DUMPS) {
    const mem = fromRam(new Uint8Array(fs.readFileSync(f)));
    assert.equal(mem.version, 'F1GP 1.05 (European)', f);
    assert.equal(mem.checked, true, f);
    const st = readState(mem, { crossCheck: true });
    if (!st.inSession) continue;
    assert.equal(st.cars.length, NCARS);
    assert.equal(st.cars.filter((c) => c.isPlayer).length, 1, f);
    assert.equal(new Set(st.cars.map((c) => c.id)).size, NCARS, f);
    assert.deepEqual([...st.cars.map((c) => c.racePos)].sort((a, b) => a - b), [...Array(NCARS).keys()].map((k) => k + 1), f);
    for (const c of st.cars) {
      assert.notEqual(c.pos, 'none', `${f} car ${c.slot}`);
      assert.ok(Number.isFinite(c.x) && Number.isFinite(c.y));
      if (c.pos === 'live') {
        liveCars++;
        const e = Math.hypot(c.derived.x - c.x, c.derived.y - c.y) / 256; // fine units (1/64 ft)
        maxErr = Math.max(maxErr, e);
        assert.ok(e <= 24, `${f} car ${c.slot}: derived vs live ${e.toFixed(1)} fine units`);
        assert.equal(c.derived.z, c.z, `${f} car ${c.slot}: z`);
      }
    }
  }
  assert.ok(liveCars > 0);
});

test('RAM dumps: readTrack gives a closed lap of 16 ft segments and a pit lane', { skip: DUMPS.length ? false : 'no RAM dumps in out/' }, () => {
  for (const f of DUMPS) {
    const mem = fromRam(new Uint8Array(fs.readFileSync(f)));
    const tr = readTrack(mem);
    assert.ok(tr.lapSegments > 500, f);
    for (let i = 0; i < tr.lapSegments; i++) assert.ok(tr.lap[i] && tr.lap[i].index === i, `${f} lap entry ${i}`);
    const steps = [];
    for (let i = 0; i < tr.lapSegments; i++) {
      const a = tr.lap[i].centre, b = tr.lap[(i + 1) % tr.lapSegments].centre;
      steps.push(Math.hypot(b[0] - a[0], b[1] - a[1]) / 256);
    }
    assert.ok(Math.abs(median(steps) - 1024) <= 2, `${f}: median step ${median(steps)}`);
    assert.ok(Math.max(...steps) < 1100, `${f}: closing step ${Math.max(...steps)}`);
    assert.ok(tr.pit.length > 50, `${f}: pit entries ${tr.pit.length}`);
  }
});

test('RAM dumps: readState cost', { skip: DUMPS.length ? false : 'no RAM dumps in out/' }, () => {
  const mem = fromRam(new Uint8Array(fs.readFileSync(DUMPS[0])));
  const r = createReader(mem);
  for (let i = 0; i < 200; i++) r.read();
  const N = 2000, t = performance.now();
  for (let i = 0; i < N; i++) r.read();
  const us = ((performance.now() - t) * 1000) / N;
  console.log(`readState: ${us.toFixed(1)} us per call (${path.relative(OUT, DUMPS[0])})`);
  assert.ok(us < 500, `${us} us`);
});

// ------------------------------------------------------------ traces

const DRIVE = path.join(OUT, 'p1-state', 'drive');
const COAST = path.join(OUT, 'p1-state', 'coast');
const haveRun = (d) => exists(path.join(d, 'frames.jsonl')) && exists(path.join(d, 'dash.jsonl'));
const RUNS = [DRIVE, COAST].filter(haveRun);
const loadRun = (d) => {
  const frames = readJsonl(path.join(d, 'frames.jsonl'));
  const dash = readJsonl(path.join(d, 'dash.jsonl'));
  const meta = JSON.parse(fs.readFileSync(path.join(d, 'meta.json'), 'utf8'));
  return { frames, dash, meta, byTick: new Map(frames.map((f, i) => [f.tick, i])), player: meta.atGreen.playerSlot };
};
// Dash readings in cockpit view whose frame and the 5 frames before it show the same viewed car in cockpit.
function dashSamples(run, which) {
  const out = [];
  for (const d of run.dash) {
    if ((d.view & 0xb0) !== 0 || d.dash.mph === null) continue;
    const i = run.byTick.get(d.tick);
    if (i === undefined || i < 6) continue;
    const hist = run.frames.slice(i - 5, i + 1).reverse(); // newest first: lag 0..5 frames
    if (hist.some((h) => (h.view & 0xb0) !== 0 || h.viewed !== d.viewed || !h.camIsCar)) continue;
    if (which === 'player' ? d.viewed !== run.player : d.viewed === run.player) continue;
    out.push({ d, hist, f: run.frames[i] });
  }
  return out;
}

test('trace: game frames are counted and timed consistently', { skip: RUNS.length ? false : 'no p1-state traces' }, () => {
  for (const d of RUNS) {
    const { frames } = loadRun(d);
    assert.ok(frames.length > 1000);
    let skipped = 0, torn = 0;
    for (let i = 1; i < frames.length; i++) {
      const a = frames[i - 1], b = frames[i];
      const df = b.frame - a.frame;
      // a read between the two adds of the clock update (whole ms, then the
      // fraction carry) shows the clock 1 ms short; frame (rounded) stays right
      if (df === 0 && b.tick - a.tick === 1) { torn++; continue; }
      assert.ok(df >= 1, `frame went from ${a.frame} to ${b.frame}`);
      assert.ok(Math.abs(b.tick - a.tick - df * 66.6656) <= 1.01, `tick step ${b.tick - a.tick} for ${df} frames`);
      if (df > 1) skipped++;
    }
    assert.ok(skipped / frames.length < 0.02, `${skipped} skipped frames`);
    assert.ok(torn / frames.length < 0.005, `${torn} torn clock reads`);
  }
});

test('trace: player position - derived from track fields equals the live X/Y, z exact', { skip: RUNS.length ? false : 'no p1-state traces' }, () => {
  for (const d of RUNS) {
    const { frames } = loadRun(d);
    const errs = [];
    for (const f of frames) {
      errs.push(Math.hypot(f.p.dx - f.p.x, f.p.dy - f.p.y) / 256);
      assert.equal(f.p.dz, f.p.z);
    }
    assert.ok(median(errs) <= 8, `median ${median(errs)}`);
    assert.ok(Math.max(...errs) <= 32, `max ${Math.max(...errs)} fine units`); // 0.5 ft
  }
});

test('trace: player speed, lap, laps, position, runners and lap time match the dash', { skip: RUNS.length ? false : 'no p1-state traces' }, () => {
  for (const d of RUNS) {
    const run = loadRun(d);
    const S = dashSamples(run, 'player');
    // the coast run rides in computer cars most of the time
    assert.ok(S.length > (d === COAST ? 20 : 300), `${S.length} player dash samples`);
    const n = { mph: 0, lap: 0, pos: 0, runners: 0, car: 0, laps: 0 }, ok = { ...n };
    let lapTimes = 0;
    for (const { d: x, hist, f } of S) {
      n.mph++; if (hist.some((h) => speedToMph(h.p.v) === x.dash.mph)) ok.mph++;
      if (x.dash.lap != null) { n.lap++; if (hist.some((h) => h.p.lap === x.dash.lap)) ok.lap++; }
      if (x.dash.laps != null) { n.laps++; if (x.dash.laps === run.meta.atGreen.session.totalLaps) ok.laps++; }
      if (x.dash.pos != null) { n.pos++; if (hist.some((h) => h.p.pos === x.dash.pos)) ok.pos++; }
      if (x.dash.runners != null) { n.runners++; if (hist.some((h) => h.runners === x.dash.runners)) ok.runners++; }
      if (x.dash.car != null) { n.car++; if (x.dash.car === 1) ok.car++; }
      if (x.dash.lapTime != null) { lapTimes++; assert.equal(x.dash.lapTime, f.p.last & 0x0fffffff, `LAPTIME at t=${x.t}`); }
    }
    // allow 2 % misses (at least one): the dash is redrawn a few frames late around view changes and at the start
    for (const k of Object.keys(n)) assert.ok(ok[k] >= n[k] - Math.max(1, Math.floor(0.02 * n[k])), `${path.basename(d)} ${k}: ${ok[k]}/${n[k]}`);
    if (d === DRIVE) assert.ok(lapTimes > 5, `${lapTimes} LAPTIME readings`);
  }
});

test('trace: viewed computer car speed and position match the dash (coast run)', { skip: haveRun(COAST) ? false : 'no coast trace' }, () => {
  const run = loadRun(COAST);
  const S = dashSamples(run, 'computer');
  assert.ok(S.length > 100, `${S.length} samples`);
  assert.ok(new Set(S.map((s) => s.d.viewed)).size >= 8);
  let mph = 0, pos = 0, np = 0;
  for (const { d: x, hist } of S) {
    if (hist.some((h) => speedToMph(h.cars[x.viewed][3]) === x.dash.mph)) mph++;
    if (x.dash.pos != null) { np++; if (hist.some((h) => h.cars[x.viewed][9] === x.dash.pos)) pos++; }
  }
  assert.ok(mph >= 0.98 * S.length, `mph ${mph}/${S.length}`);
  assert.ok(pos >= 0.98 * np, `pos ${pos}/${np}`);
});

test('trace: lap timer - laps change at the start/finish line, lap time = difference of lap starts', { skip: RUNS.length ? false : 'no p1-state traces' }, () => {
  for (const d of RUNS) {
    const { frames } = loadRun(d);
    let crossings = 0, playerCrossings = 0, pitLaps = 0;
    for (let i = 1; i < frames.length; i++) {
      const A = frames[i - 1], B = frames[i];
      if (B.frame - A.frame !== 1) continue;
      for (let c = 0; c < NCARS; c++) {
        const a = A.cars[c], b = B.cars[c];
        if (b[7] === a[7]) continue;
        assert.equal(b[7], a[7] + 1, `car ${c} lap ${a[7]} -> ${b[7]}`);
        if (b[8]) { pitLaps++; continue; } // counted in the pit lane (segment numbers there are not lap indices)
        assert.ok(a[4] > 1100 && b[4] < 20, `car ${c} lap change at index ${a[4]} -> ${b[4]}`);
        crossings++;
      }
      if (B.p.lap !== A.p.lap) {
        playerCrossings++;
        const start = B.p.start & 0x0fffffff;
        assert.ok(start > A.sessionMs - 70 && start <= B.sessionMs, `lap start ${start} vs session ${A.sessionMs}..${B.sessionMs}`);
        if (!(A.p.start & 0xf0000000)) assert.equal(B.p.last, start - A.p.start, 'last lap = lap start difference');
      }
    }
    assert.ok(crossings >= 26, `${crossings} crossings`);
    assert.ok(playerCrossings >= 1);
    void pitLaps;
  }
});

test('trace: the game camera in cockpit view sits exactly at our position for the viewed car', { skip: RUNS.length ? false : 'no p1-state traces' }, () => {
  let derived = 0, live = 0;
  const viewed = new Set();
  for (const d of RUNS) {
    for (const f of loadRun(d).frames) {
      if ((f.view & 0xb0) !== 0 || !f.camIsCar) continue;
      const c = f.cars[f.viewed];
      assert.equal(f.cam[0], c[0], `camera x, frame ${f.frame}, car ${f.viewed}`);
      assert.equal(f.cam[1], c[1], `camera y, frame ${f.frame}, car ${f.viewed}`);
      if (c[2] === 2) { derived++; viewed.add(f.viewed); } else live++;
    }
  }
  assert.ok(live > 100 && derived > 100, `live ${live} derived ${derived}`);
  console.log(`cockpit camera = car position: ${live} live frames, ${derived} derived frames, ${viewed.size} computer cars`);
});

test('trace: chase cameras are 30 ft from the viewed car', { skip: RUNS.length ? false : 'no p1-state traces' }, () => {
  const ds = [];
  for (const d of RUNS) for (const f of loadRun(d).frames) {
    const v = f.view & 0xb0;
    if (v !== 0xa0 && v !== 0xb0) continue;
    const c = f.cars[f.viewed];
    ds.push(Math.hypot(f.cam[0] - c[0], f.cam[1] - c[1]) / 16384);
  }
  if (!ds.length) return;
  assert.ok(Math.abs(median(ds) - 30) < 0.05, `median ${median(ds)}`);
});

test('trace: every car moves continuously at its speed', { skip: RUNS.length ? false : 'no p1-state traces' }, () => {
  for (const d of RUNS) {
    const { frames, meta } = loadRun(d);
    const fps = meta.atGreen.session.fps;
    const per = Array.from({ length: NCARS }, () => []);
    let none = 0;
    for (let i = 1; i < frames.length; i++) {
      const A = frames[i - 1], B = frames[i];
      for (const c of B.cars) if (c[2] === 0) none++;
      if (B.frame - A.frame !== 1) continue;
      for (let c = 0; c < NCARS; c++) {
        const a = A.cars[c], b = B.cars[c];
        const exp = a[3] / fps; // fine units per frame (speed 1/64 ft/s, one physics step = 1/fps s)
        if (exp < 50) continue;
        per[c].push(Math.hypot(b[0] - a[0], b[1] - a[1]) / 256 / exp);
      }
    }
    assert.equal(none, 0, 'cars without a position');
    const all = per.flat();
    for (let c = 0; c < NCARS; c++) if (per[c].length > 100) assert.ok(Math.abs(median(per[c]) - 1) < 0.03, `car ${c}: median ${median(per[c])}`);
    const within = all.filter((r) => r > 0.8 && r < 1.25).length;
    assert.ok(within >= 0.99 * all.length, `${path.basename(d)}: ${within}/${all.length} steps within 0.8..1.25 of speed`);
    console.log(`${path.basename(d)}: ${all.length} car-frame steps, p01 ${quantile(all, 0.01).toFixed(3)}, median ${median(all).toFixed(4)}, p99 ${quantile(all, 0.99).toFixed(3)}`);
  }
});

test('trace: full states every 500 ms are well formed', { skip: RUNS.some((d) => exists(path.join(d, 'trace.jsonl'))) ? false : 'no trace.jsonl' }, () => {
  for (const d of RUNS) {
    const p = path.join(d, 'trace.jsonl');
    if (!exists(p)) continue;
    const lines = readJsonl(p);
    assert.ok(lines.length > 100);
    for (const { state: st } of lines) {
      assert.equal(st.ok, true);
      assert.equal(st.cars.length, NCARS);
      assert.equal(st.session.type, 'race');
      assert.equal(st.track.lapSegments, 1189);
      const pos = st.cars.map((c) => c.racePos).sort((a, b) => a - b);
      assert.deepEqual(pos, [...Array(NCARS).keys()].map((k) => k + 1));
      assert.deepEqual(st.raceOrder.map((s) => st.cars[s].racePos), pos);
      for (const c of st.cars) {
        assert.ok(c.pos === 'live' || c.pos === 'derived');
        assert.equal(c.pos === 'live', c.physics);
        assert.ok(c.trackIndex >= 0 && c.trackIndex < 1189 + 200, `trackIndex ${c.trackIndex}`);
      }
    }
  }
});

test('trace: read consistency flags (polls.json)', { skip: RUNS.some((d) => exists(path.join(d, 'polls.json'))) ? false : 'no polls.json' }, () => {
  for (const d of RUNS) {
    const p = path.join(d, 'polls.json');
    if (!exists(p)) continue;
    const s = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!s.movedNoTick) continue;
    // every poll that saw cars move without a clock change was flagged as unsettled
    assert.equal(s.movedNoTick.settled, 0, path.basename(d));
    if (s.movedNoTick.carsAhead !== undefined) assert.equal(s.movedNoTick.carsAhead, s.movedWithoutTick);
  }
});

test('trace: a retired car - runners count drops when the car loses its driver (car+96 bit 20h)', { skip: RUNS.length ? false : 'no p1-state traces' }, () => {
  let events = 0;
  for (const d of RUNS) {
    const { frames } = loadRun(d);
    for (let i = 1; i < frames.length; i++) {
      const A = frames[i - 1], B = frames[i];
      const retA = A.cars.filter((c) => c[10]).length, retB = B.cars.filter((c) => c[10]).length;
      assert.equal(B.runners, 26 - retB, `runners ${B.runners} with ${retB} retired cars at t=${B.t}`);
      if (retB !== retA) events++;
    }
  }
  if (!events) console.log('no retirement in the traces');
});

// ------------------------------------------------------------ track model

const qrDump = [path.join(DRIVE, 'ram-green.bin'), path.join(OUT, 'p1-track', 'qr1', 'ram-green.bin'), path.join(OUT, 'p1-fields', 'drive1', 'ram-end.bin')].find(exists);
const trackFile = (circuit) => path.join(GAME, `f1ct${String(circuit + 1).padStart(2, '0')}.dat`);

test('track model: lib/track-file.mjs centreline equals the segments in memory; cars agree within 0.6 m', { skip: qrDump && exists(trackFile(11)) ? false : 'needs a Quick Race dump and ../original/f1ct12.dat' }, () => {
  const mem = fromRam(new Uint8Array(fs.readFileSync(qrDump)));
  const st = readState(mem);
  const geo = trackOutline(parseTrack(new Uint8Array(fs.readFileSync(trackFile(st.session.circuit)))));
  const tr = readTrack(mem);
  assert.equal(geo.segs.length, tr.lapSegments);
  for (let i = 0; i < tr.lapSegments; i++) {
    assert.equal(tr.lap[i].centre[0], geo.centre[i][0], `x ${i}`);
    assert.equal(tr.lap[i].centre[1], geo.centre[i][1], `y ${i}`);
    assert.equal(tr.lap[i].halfWidth >> 5, geo.segs[i].halfWidth >> 5, `width ${i}`);
  }
  for (const c of st.cars) {
    const s = lookupSegment(geo, c.segNr & ~0x1000); // bit 1000h is a run-time flag
    assert.ok(s, `car ${c.slot} segment ${c.segNr.toString(16)}`);
    const [x, y] = segmentToWorld(s.seg, c.along, c.lateral);
    const m = (Math.hypot(x - c.x, y - c.y) / 16384) * 0.3048;
    assert.ok(m < 0.6, `car ${c.slot}: ${m.toFixed(2)} m from the track-model position`);
  }
});

test('track model: every circuit dumped in practice matches its track file', { skip: exists(path.join(OUT, 'p1-track')) && exists(trackFile(0)) ? false : 'needs out/p1-track/prac-* and ../original' }, () => {
  let n = 0;
  for (const run of fs.readdirSync(path.join(OUT, 'p1-track'))) {
    const f = path.join(OUT, 'p1-track', run, 'ram-pits.bin');
    if (!run.startsWith('prac-') || !exists(f)) continue;
    const mem = fromRam(new Uint8Array(fs.readFileSync(f)));
    const circuit = mem.ss.u8(0x1236);
    const geo = trackOutline(parseTrack(new Uint8Array(fs.readFileSync(trackFile(circuit)))));
    const tr = readTrack(mem);
    assert.equal(tr.lapSegments, geo.segs.length, run);
    for (let i = 0; i < tr.lapSegments; i++) {
      assert.deepEqual(tr.lap[i].centre, [geo.centre[i][0], geo.centre[i][1]], `${run} segment ${i}`);
    }
    n++;
  }
  assert.ok(n > 0);
});
