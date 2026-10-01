// node --test tests/track-file.test.mjs
// Checks lib/track-file.mjs on the 16 original track files, and, when the
// probe outputs exist (git-ignored, from probes/p1-track-record.mjs), against
// the segment arrays dumped from the running game.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  parseTrack, compileTrack, compilePitLane, trackOutline, decodeSegments, segmentToWorld, lookupSegment,
  cosTable, cosRaw, sinRaw, f1gpChecksum, CIRCUITS, METRES_PER_FINE, WORLD_PER_FINE,
} from '../lib/track-file.mjs';
import { compiledFor, compareLive, identify } from '../probes/p1-track-lib.mjs';

const HERE = import.meta.dirname;
const GAME = path.join(HERE, '..', '..', 'original');
const OUT = path.join(HERE, '..', 'out', 'p1-track');
const load = (i) => new Uint8Array(fs.readFileSync(path.join(GAME, `f1ct${String(i).padStart(2, '0')}.dat`)));
const tracks = [];
for (let i = 1; i <= 16; i++) tracks.push(parseTrack(load(i)));

// File positions listed in ArgDocs track-data/misc-track-data.md:
// object settings, track data, CC line, CC data, pit lane, cameras, checksum.
const ARGDOCS_POSITIONS = {
  1: [12362, 14410, 16342, 16586, 16624, 16876, 16920],
  2: [11819, 13227, 14741, 14979, 15017, 15379, 15449],
  4: [15457, 17489, 19709, 20043, 20081, 20419, 20493],
  8: [11081, 12425, 13755, 14089, 14127, 14501, 14557],
  11: [13734, 15702, 17636, 18060, 18098, 18406, 18496],
  12: [10718, 12718, 14346, 14662, 14700, 14956, 15016],
};

test('all 16 tracks parse, checksums pass, every byte is accounted for', () => {
  tracks.forEach((t, k) => {
    const name = CIRCUITS[k];
    assert.ok(t.checksum.ok, `${name}: checksum ${t.checksum.stored} vs ${t.checksum.calculated}`);
    assert.ok(t.checksum.offsetMatches, `${name}: checksum offset`);
    assert.ok(t.layoutOk, `${name}: parts do not end at the checksum`);
    assert.equal(t.offsets.base, 0x1010);
    assert.ok(t.sections.length > 40 && t.totalTlu > 600, name);
    assert.ok(t.pitSections.length > 5, name);
    assert.ok(t.objectShapes.every((s) => s.ok), `${name}: object shape offsets`);
    assert.ok(t.cameras.length > 0, name);
    assert.ok(t.behaviour.laps > 40 && t.behaviour.laps < 90, `${name}: laps ${t.behaviour.laps}`);
    // the racing line covers about one lap
    assert.ok(Math.abs(t.ccLine.totalTlu - t.totalTlu) < 60, `${name}: cc line ${t.ccLine.totalTlu}`);
    // exactly one pit-lane join of each kind
    const n86 = t.sections.filter((s) => s.commands.some((c) => c.cmd === 0x86)).length;
    const n87 = t.sections.filter((s) => s.commands.some((c) => c.cmd === 0x87)).length;
    assert.equal(n86, 1, name); assert.equal(n87, 1, name);
  });
});

test('part positions match the ArgDocs table', () => {
  for (const [i, want] of Object.entries(ARGDOCS_POSITIONS)) {
    const t = tracks[i - 1];
    const got = [t.offsets.objectData, t.offsets.trackData, t.at.ccLine, t.at.ccData, t.at.pitLane, t.at.cameras, t.at.checksum];
    assert.deepEqual(got, want, CIRCUITS[i - 1]);
  }
});

test('checksum detects a changed byte', () => {
  const b = load(12);
  const c0 = f1gpChecksum(b);
  b[0x2000] ^= 1;
  assert.notDeepEqual(f1gpChecksum(b), c0);
  assert.equal(parseTrack(b).checksum.ok, false);
});

test('total turn is one lap (Suzuka, a figure of eight, is zero)', () => {
  tracks.forEach((t, k) => {
    const turns = t.sections.reduce((s, x) => s + x.length * x.curvature, 0) / 65536;
    const want = k === 14 ? 0 : [0, 1, 2].includes(k) ? -1 : 1; // Phoenix, Interlagos, Imola run anticlockwise
    assert.ok(Math.abs(turns - want) < 0.003, `${CIRCUITS[k]}: ${turns}`);
  });
});

test('each circuit closes: the walk returns to the start within 5 m and 0.2 deg', () => {
  tracks.forEach((t, k) => {
    const { segs, closure } = compileTrack(t, { fit: false });
    const last = segs[segs.length - 1];
    const miss = Math.hypot(segs[0].x - last.x, segs[0].y - last.y) * METRES_PER_FINE;
    assert.ok(miss < 5, `${CIRCUITS[k]}: ${miss.toFixed(2)} m`);
    assert.ok(Math.abs(closure.endAngle) < 0.2 * 65536 / 360, `${CIRCUITS[k]}: heading ${closure.endAngle}`);
    // after the game's fit the last TLU sits on the start (it is the start again)
    const fitted = compileTrack(t).segs;
    const f = fitted[fitted.length - 1];
    assert.ok(Math.hypot(f.x - fitted[0].x, f.y - fitted[0].y) <= 3, CIRCUITS[k]);
  });
});

test('lengths look like the real circuits', () => {
  // 1991 lengths in km (approximate): the TLU walk should be within 4 %
  const km = [3.798, 4.325, 5.040, 3.328, 4.430, 4.421, 4.271, 5.226, 6.802, 3.968, 6.940, 5.800, 4.350, 4.747, 5.864, 3.780];
  tracks.forEach((t, k) => {
    const len = (t.totalTlu - 1) * 16 * 0.3048 / 1000;
    assert.ok(Math.abs(len / km[k] - 1) < 0.04, `${CIRCUITS[k]}: ${len.toFixed(3)} km vs ${km[k]}`);
  });
});

test('cos table: Math.round(cos) plus one fix-up equals the table in gp.exe', (t) => {
  const exe = path.join(HERE, '..', 'out', 'gp_unpacked.bin');
  if (!fs.existsSync(exe)) return t.skip('out/gp_unpacked.bin missing (node tools/unexepack.mjs)');
  const b = fs.readFileSync(exe);
  const tab = cosTable();
  for (let k = 0; k < 4098; k++) assert.equal(tab[k], b.readInt16LE(0x2c3a4 + 2 * k), `entry ${k}`);
  assert.equal(cosRaw(0), 16384); assert.equal(cosRaw(0x8000), -16384); assert.equal(sinRaw(0x4000), 16384);
  assert.equal(cosRaw(0xc000), cosRaw(0x4000));
});

test('outline: centre between the edges, in world units; pit lane, cameras, lookup', () => {
  tracks.forEach((t, k) => {
    const o = trackOutline(t);
    const { segs } = compileTrack(t);
    const name = CIRCUITS[k];
    assert.equal(o.centre.length, segs.length - 1, name);       // the lap, without the repeated start
    assert.equal(o.left.length, o.centre.length);
    for (let i = 0; i < o.centre.length; i += 50) {
      assert.equal(o.centre[i][0], segs[i].x * WORLD_PER_FINE);
      const w = Math.hypot(o.left[i][0] - o.right[i][0], o.left[i][1] - o.right[i][1]) / WORLD_PER_FINE;
      assert.ok(Math.abs(w - 2 * segs[i].halfWidth) < 2, `${name}: width at ${i}`);
      const mid = [(o.left[i][0] + o.right[i][0]) / 2, (o.left[i][1] + o.right[i][1]) / 2];
      assert.ok(Math.hypot(mid[0] - o.centre[i][0], mid[1] - o.centre[i][1]) < 256);
    }
    // the pit lane leaves near its join segment and ends near the rejoin segment
    const p0 = o.pit.centre[0], pe = o.pit.centre[o.pit.centre.length - 1];
    const j0 = o.centre[o.pit.leavesAt], j1 = o.centre[o.pit.rejoinsAt];
    assert.ok(Math.hypot(p0[0] - j0[0], p0[1] - j0[1]) / WORLD_PER_FINE < 1400, `${name}: pit start`);
    assert.ok(Math.hypot(pe[0] - j1[0], pe[1] - j1[1]) / WORLD_PER_FINE < 2500, `${name}: pit end`);
    assert.ok(o.cameras.length > 40, name);
    // lookup by the game's segment number
    assert.equal(lookupSegment(o, 0x8000 | 10).seg, o.segs[10]);
    assert.equal(lookupSegment(o, 0x2000 | (o.pit.firstNr + 3)).seg, o.pitSegs[3]);
    assert.equal(lookupSegment(o, 0x2000 | (o.pit.firstNr - 1)), null);
  });
  // heading 0 = +Y, so at Monza's start the right edge is at larger X
  const m = trackOutline(tracks[11]);
  assert.ok(m.right[0][0] > m.centre[0][0]);
  const p = segmentToWorld(m.segs[10], 512, 100);
  assert.ok(Math.abs(p[0] - (m.segs[10].x + 100) * 256) < 256 * 2 && Math.abs(p[1] - (m.segs[10].y + 512) * 256) < 256 * 2);
});

// ---------------------------------------------------------------- against the running game

function liveDumps() {
  if (!fs.existsSync(OUT)) return [];
  const list = [];
  for (const d of fs.readdirSync(OUT).sort()) {
    const mf = path.join(OUT, d, 'meta.json');
    if (!fs.existsSync(mf)) continue;
    const meta = JSON.parse(fs.readFileSync(mf, 'utf8'));
    if (!meta.trackSeg) continue;
    for (const f of ['ram-green.bin', 'ram-pits.bin', 'ram-after.bin']) {
      if (fs.existsSync(path.join(OUT, d, f))) list.push({ name: `${d}/${f}`, meta, file: path.join(OUT, d, f) });
    }
  }
  return list;
}

test('compiled segments equal the game\'s segment arrays (every dumped circuit)', (t) => {
  const dumps = liveDumps();
  if (!dumps.length) return t.skip('no dumps in out/p1-track (run probes/p1-track-record.mjs)');
  const compiled = [];
  for (let i = 1; i <= 16; i++) compiled.push(compiledFor(load(i)));
  const circuits = new Set();
  for (const d of dumps) {
    const ram = new Uint8Array(fs.readFileSync(d.file));
    const id = identify(ram, d.meta, compiled);
    assert.equal(id.score, 1, `${d.name}: not every track entry matches a compiled circuit`);
    circuits.add(id.file);
    const r = compareLive(ram, d.meta, compiled[id.file - 1]);
    const ctx = `${d.name} (${id.name})`;
    assert.ok(r.track.n > 600, ctx);
    assert.equal(r.track.exact, r.track.n, `${ctx}: track entries not exact`);
    assert.equal(r.track.sideMismatch, 0, `${ctx}: track width vectors`);
    assert.equal(r.cameras.flagMismatch, 0, `${ctx}: TV camera flags`);
    assert.ok(r.pit.n > 90, ctx);
    assert.ok(r.pit.maxXY * METRES_PER_FINE < 0.15, `${ctx}: pit lane off by ${r.pit.maxXY} fine units`);
    assert.ok(r.pit.maxAngle <= 2, ctx);
    assert.equal(r.pit.sideMismatch, 0, `${ctx}: pit width vectors`);
    assert.equal(r.unknown, 0, ctx);
  }
  t.diagnostic(`circuits checked against the game: ${[...circuits].sort((a, b) => a - b).map((k) => CIRCUITS[k - 1]).join(', ')}`);
});

test('player world X/Y = our centreline (fine units) x 256, from a driven Quick Race lap', (t) => {
  const f = path.join(OUT, 'qr1', 'fit.json');
  if (!fs.existsSync(f)) return t.skip('run probes/p1-track-record.mjs --tag qr1 and probes/p1-track-fit.mjs');
  const fit = JSON.parse(fs.readFileSync(f, 'utf8')).player;
  assert.ok(fit.used > 1000);
  assert.ok(Math.abs(fit.fitWithLateral.scale - 256) < 0.05, `scale ${fit.fitWithLateral.scale}`);
  assert.ok(Math.abs(fit.fitWithLateral.rotationDeg) < 0.01);
  assert.ok(Math.hypot(...fit.fitWithLateral.offsetFine) < 10);
  assert.ok(fit.signedDistanceMinusCar0A_fine.max < 20 && fit.signedDistanceMinusCar0A_fine.min > -20);
});
