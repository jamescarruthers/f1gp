// lib/pace.mjs (the game's frame rate, the cycles governor, the frame pacer),
// and the ground texture's data: the noise (gl-track.mjs) and the road's
// texture coordinates (scene.mjs).
//
//   cd spike && node --test tests/pace.test.mjs
//
// The road check reads a Monza RAM capture from out/ and skips without it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { frameTicks, setFrameRate, readFrameTicks, readWorkTicks, cyclesGovernor, framePacer } from '../lib/pace.mjs';
import { groundNoise } from '../lib/gl-track.mjs';
import { readScene, buildSceneMesh } from '../lib/scene.mjs';

const fakeMem = () => {
  const H = new Uint8Array(1 << 20);
  return { memBase: 0, SS: 0x8000, DS: 0x7000, heap: () => H, H };
};

test('frame rate: 300 Hz ticks per frame, 10 (30 fps) to 37 (8 fps)', () => {
  assert.equal(frameTicks(15), 20);
  assert.equal(frameTicks(30), 10);
  assert.equal(frameTicks(25), 12);
  assert.equal(frameTicks(60), 10, 'no faster than 30 fps: the physics factor DS:0156 would overflow');
  assert.equal(frameTicks(5), 37);
  const mem = fakeMem();
  mem.H.set([20, 0], (mem.SS << 4) + 0x1230);
  assert.equal(readFrameTicks(mem), 20);
  assert.equal(setFrameRate(mem, 30), true);
  assert.equal(readFrameTicks(mem), 10);
  assert.equal(setFrameRate(mem, 30), false, 'unchanged');
  mem.H.set([3, 0], (mem.DS << 4) + 0x2c63);
  assert.equal(readWorkTicks(mem), 3);
});

test('cycles: high outside the race, low in it, raised on load, lowered after a quiet spell', () => {
  const sent = [];
  const g = cyclesGovernor({ send: (c) => sent.push(c), steps: [8000, 12000, 25000], high: 25000, hold: 1000 });
  g.update({ racing: false, now: 0 });
  assert.deepEqual(sent, [25000]);
  g.update({ racing: true, work: 1, ticks: 10, now: 10 });
  assert.equal(g.cycles, 8000);
  g.update({ racing: true, work: 6, ticks: 10, now: 20 });
  assert.equal(g.cycles, 12000, 'a frame at 60% of its time raises a step');
  g.update({ racing: true, work: 7, ticks: 10, now: 30 });
  assert.equal(g.cycles, 25000);
  g.update({ racing: true, work: 7, ticks: 10, now: 40 });
  assert.equal(g.cycles, 25000, 'no step above the last');
  g.update({ racing: true, work: 1, ticks: 10, now: 100 });
  g.update({ racing: true, work: 1, ticks: 10, now: 900 });
  assert.equal(g.cycles, 25000, 'not quiet for long enough');
  g.update({ racing: true, work: 1, ticks: 10, now: 1100 });
  assert.equal(g.cycles, 12000);
  g.update({ racing: true, work: 4, ticks: 10, now: 1500 });
  g.update({ racing: true, work: 1, ticks: 10, now: 2200 });
  assert.equal(g.cycles, 12000, 'a busier frame restarts the quiet spell');
  g.update({ racing: false, now: 2300 });
  assert.equal(g.cycles, 25000);
  assert.deepEqual(sent, [25000, 8000, 12000, 25000, 12000, 25000], 'sent only on changes');
});

test('pacer: one frame behind the newest, moving with real time, blending across a missed frame', () => {
  const p = framePacer();
  const f = (n) => ({ n, t: n * 33, step: 33 });
  p.add(f(0));
  assert.deepEqual(p.pick(0), { a: p.frames[0], b: p.frames[0], alpha: 1 }, 'one frame: shown as it is');
  p.add(f(1));
  let r = p.pick(100);
  assert.equal(r.a.n, 0); assert.equal(r.b.n, 1); assert.equal(r.alpha, 0, 'starts one frame behind');
  r = p.pick(116.5);
  assert.ok(Math.abs(r.alpha - 0.5) < 0.05, `half way after half a frame (${r.alpha})`);
  // frame 2 never arrives; frame 3 does: the clock blends from 1 to 3
  p.add(f(3));
  r = p.pick(140);
  assert.equal(r.a.n, 1); assert.equal(r.b.n, 3);
  assert.ok(r.alpha > 0 && r.alpha < 1);
  // a camera cut: not blended
  r = p.pick(141, false, () => true);
  assert.equal(r.alpha, 1);
  // paused: the newest frame
  r = p.pick(150, true);
  assert.equal(r.b.n, 3); assert.equal(r.alpha, 1);
  // a new session (time runs back): history restarts
  p.add(f(0));
  assert.equal(p.frames.length, 1);
  assert.equal(framePacer({ smooth: false }).pick(0), null);
});

test('ground noise: tileable, centred, the same each time', () => {
  const n = groundNoise(256);
  assert.equal(n.length, 65536);
  let sum = 0, sq = 0;
  for (const v of n) { sum += v; sq += v * v; }
  const mean = sum / n.length, sd = Math.sqrt(sq / n.length - mean * mean);
  assert.ok(Math.abs(mean - 128) < 2, `mean ${mean}`);
  assert.ok(sd > 40 && sd < 60, `sd ${sd}`);
  // across the wrap the steps are like those inside
  const step = (a, b) => Math.abs(n[a] - n[b]);
  let inside = 0, wrap = 0;
  for (let y = 0; y < 256; y++) { inside += step(y * 256 + 100, y * 256 + 101); wrap += step(y * 256 + 255, y * 256); }
  assert.ok(wrap < inside * 1.5, `wrap ${wrap} inside ${inside}`);
  assert.deepEqual(groundNoise(64), groundNoise(64));
});

const S2 = path.join(import.meta.dirname, '..', 'out', 'research-phase2', 'static', 'cap', 's2', 'grid-chase.ram');
test('Monza (RAM capture): the road carries feet along and across the track', { skip: !fs.existsSync(S2) && 'no RAM captures in out/' }, async () => {
  const { fromRam } = await import('../lib/f1gp-mem.mjs');
  const scene = readScene(fromRam(new Uint8Array(fs.readFileSync(S2)), { imageSeg: 0x1a2 }));
  const plain = buildSceneMesh(scene, { indexed: true });
  const m = buildSceneMesh(scene, { indexed: true, uv: true });
  assert.equal(plain.stride, 6);
  assert.equal(m.stride, 8);
  assert.equal(m.data.length / 8, plain.data.length / 6, 'the same vertices');
  const road = m.ranges.ground;
  let across = 0;
  for (let v = road.first; v < road.first + road.count; v += 6) {
    // a road quad: u steps 16 ft from the first corner to the second, v is equal and opposite across
    const at = (k, j) => m.data[(v + k) * 8 + j];
    assert.equal(at(0, 3), scene.road);
    assert.equal(at(1, 6) - at(0, 6), 16);
    assert.ok(at(0, 6) >= 0 && at(0, 6) < 1024);
    assert.ok(at(0, 7) < 0 && at(5, 7) > 0, 'left edge negative, right edge positive');
    across = Math.max(across, at(5, 7) - at(0, 7));
  }
  assert.ok(across > 25 && across < 80, `widest road ${across} ft`);
  // the other parts carry no coordinates
  const dec = m.ranges.decals;
  for (let v = dec.first; v < dec.first + dec.count; v++) assert.deepEqual([m.data[v * 8 + 6], m.data[v * 8 + 7]], [0, 0]);
});
