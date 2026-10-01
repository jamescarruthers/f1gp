// Road markings (lib/scene.mjs): the grid slots and start line (special
// shapes), the dotted best line the game writes into marking B, and the key
// that tells the page to rebuild when the game rewrites them.
//
//   cd spike && node --test tests/markings.test.mjs
//
// Reads a Monza Quick Race RAM capture from out/ (all driving aids on) and
// skips without it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { readScene, markingPoints, markingsKey } from '../lib/scene.mjs';

const RAM = path.join(import.meta.dirname, '..', 'out', 'research-phase3', 'cars', 'cap', 'grid1', 'g-rchase.ram');
const have = fs.existsSync(RAM);
const load = async () => {
  const { fromRam } = await import('../lib/f1gp-mem.mjs');
  return fromRam(new Uint8Array(fs.readFileSync(RAM)), { imageSeg: 0x1a2 });
};
const ft = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]) / 64;
const halfWidth = (s) => (8 * Math.hypot(s.hx, s.hy)) / 64;

test('Monza: a grid slot is a short bar across the left half of the road', { skip: !have && 'no RAM capture in out/' }, async () => {
  const scene = readScene(await load());
  const T = scene.tables;
  // marking A: special shape 3 on segment 1151 starts the strip, shape 2 on 1152 ends it
  const a = markingPoints(scene.lap[1151], 'A', T), b = markingPoints(scene.lap[1152], 'A', T);
  assert.equal(a.special, 3); assert.equal(b.special, 2);
  const along = ft(a.a, b.a), across = ft(a.a, a.b), hw = halfWidth(scene.lap[1151]);
  assert.ok(along > 0.1 && along < 3, `${along.toFixed(2)} ft along the track`);
  assert.ok(Math.abs(across - (14 / 32) * hw) < 0.2, `${across.toFixed(2)} ft across, half-width ${hw.toFixed(1)} ft`);
  // on the left of the centre line: the same side as the left edge (k = -1)
  const C = [scene.lap[1151].x, scene.lap[1151].y], L = [C[0] - 8 * scene.lap[1151].hx, C[1] + 8 * scene.lap[1151].hy];
  assert.ok(ft(a.a, L) < ft(a.a, [2 * C[0] - L[0], 2 * C[1] - L[1]]), 'nearer the left edge');
});

test('Monza: the start line crosses the whole road', { skip: !have && 'no RAM capture in out/' }, async () => {
  const scene = readScene(await load());
  const a = markingPoints(scene.lap[0], 'B', scene.tables), b = markingPoints(scene.lap[1], 'B', scene.tables);
  assert.equal(a.special, 1); assert.equal(b.special, 0);
  const hw = halfWidth(scene.lap[0]);
  assert.ok(Math.abs(ft(a.a, a.b) - 2 * hw) < 0.3, 'from edge to edge');
  assert.ok(ft(a.a, b.a) < 4, `${ft(a.a, b.a).toFixed(2)} ft long`);
});

test('Monza: with the best-line aid on, marking B sits on the racing line in colour code 8', { skip: !have && 'no RAM capture in out/' }, async () => {
  const mem = await load();
  const H = mem.heap(), B = mem.memBase, ds = B + (mem.DS << 4), ss = B + (mem.SS << 4);
  const r16 = (p) => H[p] | (H[p + 1] << 8), s16 = (p) => (r16(p) << 16) >> 16, s8 = (v) => (v << 24) >> 24;
  assert.equal(H[ds + 0x297d] & 0x10, 0x10, 'the aid is on in this capture');
  const tOff = r16(ds + 0x879f), tSeg = r16(ds + 0x87a1), n = (r16(ss + 0x015c) - tOff) / 0x2e;
  let checked = 0;
  for (let i = 0; i < n; i++) {
    const p = B + (tSeg << 4) + tOff + i * 0x2e;
    if (!(H[p + 0x0b] & 0x40) || ((H[p + 0x1d] - 0x7c) & 0xff) < 8) continue;
    const hw = (r16(p + 0x0c) & 0x3f) << 5;
    assert.equal(s8(H[p + 0x1d]), s8(Math.trunc((s16(p + 0x16) * 64) / hw) & 0xff), `segment ${i}`);
    assert.equal(H[p + 0x25] >> 4, 8);
    checked++;
  }
  assert.ok(checked > 500, `${checked} segments`);
});

test('the markings key changes when marking B moves, not when a special line changes colour', { skip: !have && 'no RAM capture in out/' }, async () => {
  const mem = await load();
  const H = mem.heap(), B = mem.memBase, ds = B + (mem.DS << 4);
  const r16 = (p) => H[p] | (H[p + 1] << 8);
  const seg = (i) => B + (r16(ds + 0x87a1) << 4) + r16(ds + 0x879f) + i * 0x2e;
  const k0 = markingsKey(mem);
  const special = seg(1151), plain = seg(500);
  const keep = [H[special + 0x25], H[plain + 0x1d]];
  H[special + 0x25] ^= 0x0f;
  assert.equal(markingsKey(mem), k0, 'the depth colour of a special line');
  H[plain + 0x1d] ^= 0x05;
  assert.notEqual(markingsKey(mem), k0, 'marking B moved');
  [H[special + 0x25], H[plain + 0x1d]] = keep;
  assert.equal(markingsKey(mem), k0);
});
