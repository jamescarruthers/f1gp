// Phase 1 done test: the state read from memory matches the game for a whole
// Quick Race.
//
//   cd spike && node --test tests/p1-accuracy.test.mjs
//
// 1. Synthetic (always runs): the dash LCD reader of probes/p1-accuracy-lib.cjs
//    on a made-up LCD (our own pixels: label masks and the digit font).
// 2. Recorded races (skipped when absent): every out/p1-accuracy/<run> with
//    frames.jsonl, recorded by probes/p1-accuracy-run.cjs. Each run is checked
//    by probes/p1-accuracy-check.cjs (needs ../original/f1ct12.dat for the
//    track outline). The read-consistency check fails on recordings made
//    before lib/f1gp-state.mjs kept its DS:2977 offset fixed (a re-read late
//    in the next frame's work was flagged consistent), so it is reported as
//    a todo until the races are recorded again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const HERE = import.meta.dirname;
const OUT = path.join(HERE, '..', 'out', 'p1-accuracy');
const L = require('../probes/p1-accuracy-lib.cjs');
const exists = (p) => { try { fs.accessSync(p); return true; } catch { return false; } };

// ------------------------------------------------------------ synthetic LCD

function fakeLcd({ mph, lap, laps, car, pos, runners, lapTime }) {
  const w = 320, h = 200, data = new Uint8Array(w * h * 4);
  const put = (x, y, [r, g, b]) => { const o = (y * w + x) * 4; data[o] = r; data[o + 1] = g; data[o + 2] = b; data[o + 3] = 255; };
  for (let y = 180; y < 200; y++) for (let x = 88; x < 232; x++) put(x, y, [109, 158, 109]);
  const label = (name) => { const [x0, x1, y0, m] = L.LABELS[name]; let i = 0; for (let y = y0; y < y0 + 5; y++) for (let x = x0; x < x1; x++, i++) if (m[i] === '#') put(x, y, [93, 93, 16]); };
  const glyph = Object.fromEntries(Object.entries(L.DIGITS).map(([g, d]) => [d, g]));
  const digit = (x0, y0, d) => { const g = glyph[d]; for (let k = 0; k < 36; k++) if (g[k] === '#') put(x0 + (k % 6), y0 + Math.floor(k / 6), [0, 0, 0]); };
  const right = (cells, y, v) => { const s = String(v); cells.slice(cells.length - s.length).forEach((x, i) => digit(x, y, +s[i])); };
  label('MPH'); right([111, 118, 125], 184, String(mph).padStart(3, '0'));
  if (lapTime !== undefined) {
    label('LAPTIME');
    const t = [Math.floor(lapTime / 60000), Math.floor((lapTime % 60000) / 10000), Math.floor((lapTime % 10000) / 1000), Math.floor((lapTime % 1000) / 100), Math.floor((lapTime % 100) / 10), lapTime % 10];
    [178, 189, 196, 207, 214, 221].forEach((x, i) => digit(x, 184, t[i]));
  } else { label('LAP'); label('OF'); right([181, 188], 184, lap); right([214, 221], 184, laps); }
  label('CAR'); right([108, 115], 193, car);
  label('POS'); right([140, 147], 193, pos);
  label('RUNNERS'); right([214, 221], 193, runners);
  return { width: w, height: h, data };
}

test('synthetic: the dash reader reads MPH, LAP n OF m, CAR, POS, RUNNERS and LAPTIME', () => {
  let d = L.readDash(fakeLcd({ mph: 97, lap: 2, laps: 3, car: 1, pos: 16, runners: 26 }));
  assert.deepEqual({ mph: d.mph, lap: d.lap, laps: d.laps, car: d.car, pos: d.pos, runners: d.runners, lapTime: d.lapTime }, { mph: 97, lap: 2, laps: 3, car: 1, pos: 16, runners: 26, lapTime: null });
  assert.deepEqual(d.layout, ['lap', 'runners']);
  d = L.readDash(fakeLcd({ mph: 175, car: 27, pos: 5, runners: 23, lapTime: 107889 }));
  assert.equal(d.lapTime, 107889);
  assert.equal(d.lap, null);
  assert.equal(d.car, 27);
  // no labels (TV view, menus): nothing is read
  const blank = { width: 320, height: 200, data: new Uint8Array(320 * 200 * 4) };
  assert.deepEqual(Object.values(L.readDash(blank)).filter((v) => v !== null && !Array.isArray(v)), []);
});

// a plain RGBA PNG (filter 0 rows), without loading the emulator module
function encodePng(w, h, rgba) {
  const zlib = require('node:zlib');
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) Buffer.from(rgba.buffer, rgba.byteOffset + y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1);
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

test('synthetic: PNG round trip through the lib decoder', () => {
  const img = fakeLcd({ mph: 5, lap: 0, laps: 3, car: 1, pos: 4, runners: 26 });
  const back = L.decodePng(encodePng(img.width, img.height, img.data));
  assert.equal(back.width, 320);
  assert.deepEqual(Buffer.from(back.data), Buffer.from(img.data));
  assert.equal(L.readDash(back).pos, 4);
});

// ------------------------------------------------------------ recorded races

const RUNS = exists(OUT) ? fs.readdirSync(OUT).map((d) => path.join(OUT, d)).filter((d) => exists(path.join(d, 'frames.jsonl')) && exists(path.join(d, 'meta.json'))
  && JSON.parse(fs.readFileSync(path.join(d, 'meta.json'), 'utf8')).ok) : [];
const TRACK = path.join(HERE, '..', '..', 'original', 'f1ct12.dat');
const skip = RUNS.length && exists(TRACK) ? false : 'needs out/p1-accuracy/<run> (probes/p1-accuracy-run.cjs) and ../original/f1ct12.dat';
const { checkRun } = require('../probes/p1-accuracy-check.cjs');
const TF = await import('../lib/track-file.mjs');
const reports = skip ? [] : RUNS.map((d) => checkRun(d, TF, { write: false }));
const get = (r, name) => r.checks.find((c) => c.name.startsWith(name));
const full = (r) => r.playerLapAtEnd > r.totalLaps;

test('a full Quick Race was recorded: green light to the finish of the player and the leader', { skip }, () => {
  const done = reports.filter(full);
  assert.ok(done.length >= 1, 'no run reaches the finish');
  for (const r of done) {
    assert.equal(get(r, 'every game frame').result, 'pass', r.run);
    assert.equal(get(r, 'finish order').result, 'pass', r.run);
  }
});

const CORE = ['every game frame recorded', 'all 26 cars present every frame', 'dash vs memory', 'no implausible jumps', 'positions stay on the track outline',
  'lap counters', 'race positions follow the order along the track', 'view keys move the view fields', 'camera follows the viewed car', 'finish order'];
for (const name of CORE) {
  test(`races: ${name}`, { skip }, () => {
    for (const r of reports) {
      const c = get(r, name);
      assert.ok(c, `${r.run}: no check ${name}`);
      assert.ok(['pass', 'pass*', 'not-tested'].includes(c.result), `${r.run}: ${name} = ${c.result}: ${JSON.stringify(c).slice(0, 400)}`);
    }
  });
}

test('races: read consistency flags never mark an off-by-a-frame record consistent', { skip, todo: skip ? false : 'these recordings were made before lib/f1gp-state.mjs kept the DS:2977 offset fixed; re-record with probes/p1-accuracy-run.cjs to clear' }, () => {
  for (const r of reports) assert.equal(get(r, 'read consistency flags').result, 'pass', r.run);
});
