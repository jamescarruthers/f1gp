// node --test tests/cars.test.mjs
// Checks lib/cars.mjs: the angle rules for wheels and helmets (no game data),
// and, when the git-ignored RAM captures exist (out/research-phase2/static/cap/s2,
// out/research-phase3/cars/cap/*), the car shape, the car selection, the WebGL
// data and a pixel comparison with the game's own frames (game rules, as
// probes/p3-cars-lib.mjs draws them).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { steerAngle, wheelFrame, helmetFrame, lerpCarStates } from '../lib/cars.mjs';

const HERE = import.meta.dirname;
const OUT = path.join(HERE, '..', 'out');
const S2 = path.join(OUT, 'research-phase2', 'static', 'cap', 's2');
const CAP = path.join(OUT, 'research-phase3', 'cars', 'cap');
const haveS2 = fs.existsSync(path.join(S2, 'grid-chase.ram')) && fs.existsSync(path.join(S2, 'grid-chase.png'));
const capSets = ['grid1', 'race1', 'flags2'].filter((d) => fs.existsSync(path.join(CAP, d, 'meta.json')));

// ------------------------------------------------------------------ pure rules
test('steering term (0F47:8F1D): 4x up to 200h, then half rate from 800h', () => {
  assert.equal(steerAngle(0), 0);
  assert.equal(steerAngle(0x100), 0x400);
  assert.equal(steerAngle(-0x100), -0x400);
  assert.equal(steerAngle(0x200), 0x800);
  assert.equal(steerAngle(0x400), 0x900);
  assert.equal(steerAngle(-5620), -(((5620 - 0x200) >> 1) + 0x800));
});

test('wheel frames: 33 per wheel over 90 degrees, mirrored by angle bit 14, front wheels steered', () => {
  assert.deepEqual(wheelFrame(0, 0, 0), { id: 0, mirrored: false });
  assert.deepEqual(wheelFrame(0, 0x4000, 0), { id: 0x20, mirrored: true });
  assert.deepEqual(wheelFrame(0, 0x2000, 0), { id: 0x10, mirrored: false });
  assert.deepEqual(wheelFrame(0, 0x6000, 0), { id: 0x10, mirrored: true });   // 180 - x looks the same, mirrored
  assert.deepEqual(wheelFrame(0, 0x8000, 0), { id: 0, mirrored: false });     // from the other side: the same frame
  assert.deepEqual(wheelFrame(0x21, 0, 0), { id: 0x21, mirrored: false });
  assert.deepEqual(wheelFrame(0x21, 0, 0x200), { id: 0x21 + 4, mirrored: false }); // steered 800h: four frames on
  assert.deepEqual(wheelFrame(0, 0, 0x200), { id: 0, mirrored: false });      // rear wheels do not steer
});

test('helmet frames: 9 over 180 degrees, sign = mirror, turned by twice the steering plus the steering term', () => {
  assert.deepEqual(helmetFrame(0x42, 0, 0), { id: 0x42, mirrored: false });
  assert.deepEqual(helmetFrame(0x42, 0x8000, 0), { id: 0x4a, mirrored: true });
  assert.deepEqual(helmetFrame(0x42, 0x4000, 0), { id: 0x46, mirrored: false });
  assert.deepEqual(helmetFrame(0x42, 0xc000, 0), { id: 0x46, mirrored: true });
  assert.deepEqual(helmetFrame(0x42, 0, 0x100), { id: 0x42 + ((0x400 + 0x200 + 0x800) >> 12), mirrored: false });
});

test('lerpCarStates eases position and yaw the short way', () => {
  const a = [{ x: 0, y: 0, z: 0, yaw: 0xff00, pitch: 0, steer: 0 }];
  const b = [{ x: 100, y: 0, z: 10, yaw: 0x0100, pitch: 0, steer: 8 }];
  const m = lerpCarStates(a, b, 0.5)[0];
  assert.equal(m.x, 50); assert.equal(m.z, 5); assert.equal(m.yaw, 0); assert.equal(m.steer, 4);
  assert.equal(lerpCarStates(a, b, 1)[0].yaw, 0x0100);
});

// ------------------------------------------------------------------ game memory
async function load(file, histK = null) {
  const { fromRam } = await import('../lib/f1gp-mem.mjs');
  const { createReader } = await import('../lib/f1gp-state.mjs');
  let ram = new Uint8Array(fs.readFileSync(file));
  if (histK !== null) {
    const hist = JSON.parse(fs.readFileSync(file.replace(/\.ram$/, '.hist.json'), 'utf8'));
    const h = hist.entries[hist.entries.length - 1 - histK];
    for (const [lin, b] of h.blocks) ram.set(Uint8Array.from(Buffer.from(b, 'base64')), lin);
  }
  const mem = fromRam(ram);
  return { mem, st: createReader(mem).read() };
}

test('Monza (RAM capture): the car shape, its LODs, the team-1 nose, the effect shapes', { skip: !haveS2 && 'no RAM captures in out/' }, async () => {
  const { readCars, carSpriteIds } = await import('../lib/cars.mjs');
  const { mem } = await load(path.join(S2, 'grid-chase.ram'));
  const cars = readCars(mem);
  const [poly, far] = cars.car.lods;
  assert.equal(poly.max, 0x1a0);              // polygons up to 52 ft (depth in 1/8 ft)
  assert.ok(!poly.sprite && far.sprite && far.max >= 0x7fff);
  assert.equal(poly.dirs.length, 32);         // 32 view sectors of 11.25 degrees
  assert.equal(cars.car.size, 512);
  // wheels (00h rear, 21h front), the helmet (42h, driver only) are bitmap elements
  const bm = [...cars.car.elements.values()].filter((e) => e.kind === 'bitmap');
  assert.deepEqual([...new Set(bm.map((e) => e.id))].sort((a, b) => a - b), [0, 0x21, 0x42]);
  assert.ok(bm.find((e) => e.id === 0x42).type & 0x10);
  // team 1 draws the same lists from the element block at DS:7793: only the nose differs
  const diff = [...cars.car.elements.keys()].filter((o) => JSON.stringify(cars.car.elements.get(o)) !== JSON.stringify(cars.carAlt.elements.get(o)));
  assert.ok(diff.length > 0 && diff.every((o) => o < 0x31), `differing elements ${diff}`);
  // effect shapes 8, 0Eh, 0Fh, 10h
  assert.deepEqual(cars.attach.map((e) => e.shape), [8, 0x0e, 0x0f, 0x10, 0x0e]);
  assert.equal(cars.consts.nearDepth, 0x1a);
  assert.equal(cars.consts.mirrorLeft, 0x9000);
  assert.equal(cars.consts.mirrorRight, 0x7000);
  const ids = carSpriteIds(cars);
  for (const id of [0, 0x41, 0x42, 0x4a, 0xb0, 0xdc]) assert.ok(ids.includes(id), `sprite ${id.toString(16)}`);
});

test('Monza (RAM capture): the cars A533 picks and their order', { skip: !haveS2 && 'no RAM captures in out/' }, async () => {
  const { readCars, carStates, selectCars } = await import('../lib/cars.mjs');
  for (const name of ['grid-chase', 'grid-cockpit', 'ai1-chase', 'ai3-tv']) {
    const { mem, st } = await load(path.join(S2, `${name}.ram`));
    const cars = readCars(mem);
    const sel = selectCars(cars, carStates(cars, st));
    const all = [...sel.drawn, ...sel.skipped];
    assert.ok(all.length <= 26 && all.length >= cars.consts.carsDrawn, name);
    for (let i = 1; i < sel.drawn.length; i++) assert.ok(sel.drawn[i - 1].key >= sel.drawn[i].key, `${name}: far to near`);
    if (st.view.mode === 'cockpit') assert.ok(sel.skipped.some((e) => e.slot === st.view.viewedSlot && e.reason === 'camera object'), name);
    else assert.ok(!sel.skipped.some((e) => e.reason === 'camera object'), name);
    assert.ok(sel.drawn.every((e) => !(e.state.f96 & 0x80)), name);
  }
});

test('Monza (RAM capture): frameCars gives one-sided triangles, layers and sprite quads', { skip: !haveS2 && 'no RAM captures in out/' }, async () => {
  const { readCars, frameCars, carSpriteIds, carSpriteQuads } = await import('../lib/cars.mjs');
  const { buildSpriteAtlas } = await import('../lib/objects.mjs');
  const { mem, st } = await load(path.join(S2, 'grid-chase.ram'));
  const cars = readCars(mem);
  const cam = { x: st.camera.x >> 8, y: st.camera.y >> 8, z: st.camera.z, heading: st.camera.heading, mode: st.view.mode };
  const fc = frameCars(cars, st, cam, { indexed: true });
  assert.equal(fc.mesh.data.length % 18, 0);
  assert.ok(fc.mesh.data.length > 0 && fc.list.length > 0);
  const nv = fc.mesh.data.length / 6;
  for (const l of fc.frame.layers) { assert.equal(l.length % 3, 0); for (const v of l) assert.ok(v < nv); }
  for (let v = 0; v < nv; v++) assert.equal(fc.mesh.data[v * 6 + 4], -1); // indexed colours
  const atlas = buildSpriteAtlas(cars, carSpriteIds(cars));
  const q = carSpriteQuads(fc, atlas, cam, cars);
  assert.equal(q.length, fc.frame.sprites.length * 42);
});

// pixel agreement with the game's frames inside the pixels our cars cover
async function agreement(dir, names, histK) {
  const { drawFrame, compareCars } = await import('../probes/p3-cars-lib.mjs');
  const { decodePng } = await import('../lib/png.mjs');
  const tot = { near: [0, 0], far: [0, 0], mirror: [0, 0] };
  for (const name of names) {
    const { mem, st } = await load(path.join(dir, `${name}.ram`), histK);
    const game = decodePng(fs.readFileSync(path.join(dir, `${name}.png`)));
    const fr = drawFrame({ mem, st, carMode: 'game' });
    const r = compareCars(game, fr);
    for (const k of Object.keys(tot)) { tot[k][0] += r[k].px; tot[k][1] += r[k].same; }
  }
  return Object.fromEntries(Object.entries(tot).map(([k, [px, same]]) => [k, { px, pct: px ? (100 * same) / px : null }]));
}

test('Monza (RAM capture + game frame, paused with P): cars match the game in car pixels', { skip: !haveS2 && 'no RAM captures in out/' }, async () => {
  const r = await agreement(S2, ['grid-chase', 'grid-tv', 'ai1-chase', 'ai6-cockpit', 'ai9-cockpit', 'ai10-chase'], null);
  assert.ok(r.near.px > 5000 && r.near.pct >= 97, `near ${JSON.stringify(r.near)}`);
  assert.ok(r.far.px > 1000 && r.far.pct >= 97, `far ${JSON.stringify(r.far)}`);
});

test('Monza (p3 captures, emulator paused: the screen shows the previous frame)', { skip: !capSets.length && 'no p3 captures in out/' }, async () => {
  for (const d of capSets) {
    const dir = path.join(CAP, d);
    const names = fs.readdirSync(dir).filter((f) => f.endsWith('.ram')).map((f) => f.slice(0, -4)).sort().slice(0, 8);
    const r = await agreement(dir, names, 1);
    if (r.near.px) assert.ok(r.near.pct >= 96, `${d} near ${JSON.stringify(r.near)}`);
    if (r.far.px) assert.ok(r.far.pct >= 97, `${d} far ${JSON.stringify(r.far)}`);
    if (r.mirror.px) assert.ok(r.mirror.pct >= 90, `${d} mirror ${JSON.stringify(r.mirror)}`);
  }
});
