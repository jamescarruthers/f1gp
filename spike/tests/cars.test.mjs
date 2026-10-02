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
import { steerAngle, wheelFrame, helmetFrame, lerpCarStates, mirrorCars } from '../lib/cars.mjs';

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

test('Monza (RAM capture): modern style draws every car as polygons with 3D wheels and helmets', { skip: !haveS2 && 'no RAM captures in out/' }, async () => {
  const { readCars, frameCars, carStates: carStatesOf } = await import('../lib/cars.mjs');
  const { mem, st } = await load(path.join(S2, 'grid-chase.ram'));
  const cars = readCars(mem);
  const H = mem.heap(), p = mem.memBase + (mem.SS << 4) + 0x05da;
  const rgb = Uint8Array.from(H.subarray(p, p + 768), (v) => (v << 2) | (v >> 4));
  const cam = { x: st.camera.x >> 8, y: st.camera.y >> 8, z: st.camera.z, heading: st.camera.heading, mode: st.view.mode };
  const classic = frameCars(cars, st, cam, { indexed: true });
  const modern = frameCars(cars, st, cam, { indexed: true, modern: true, all: true, paletteRgb: rgb, wide: true });
  // no bitmaps at all: far cars are polygons, wheels and helmets are geometry
  assert.equal(modern.frame.sprites.length, 0);
  assert.ok(modern.list.length >= classic.list.length);
  const drawn = modern.list.filter((l) => l.parts.some((q) => q.kind === 'polygons'));
  assert.ok(drawn.length > 0);
  for (const l of drawn) {
    const car = l.parts.find((q) => q.what === 'car');
    assert.equal(car.elements.filter((e) => e.kind === 'wheel3d').length, 4, `slot ${l.slot}: four wheels`);
    assert.ok(car.elements.filter((e) => e.kind === 'helmet3d').length <= 1);
  }
  // the solid triangles: whole triangles of x, y, z, r, g, b with colours in 0..1
  assert.ok(modern.solid.length > 0 && modern.solid.length % 18 === 0);
  for (let i = 3; i < modern.solid.length; i += 6) for (let k = 0; k < 3; k++) assert.ok(modern.solid[i + k] >= 0 && modern.solid[i + k] <= 1);
  // every solid triangle faces away from its own wheel or helmet centre (outward, counter-clockwise)
  const centres = drawn.flatMap((l) => l.parts.flatMap((q) => q.elements.filter((e) => e.kind === 'wheel3d' || e.kind === 'helmet3d').map((e) => e.at)));
  const o = modern.mesh.origin;
  let outward = 0, n = 0;
  for (let t = 0; t < modern.solid.length; t += 18) {
    const v = (k) => [modern.solid[t + 6 * k], modern.solid[t + 6 * k + 1], modern.solid[t + 6 * k + 2]];
    const [a, b, c] = [v(0), v(1), v(2)];
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], w = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const nn = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
    const m = [(a[0] + b[0] + c[0]) / 3 + o[0], (a[1] + b[1] + c[1]) / 3 + o[1], (a[2] + b[2] + c[2]) / 3];
    const ctr = centres.reduce((best, q) => (Math.hypot(q[0] - m[0], q[1] - m[1], q[2] - m[2]) < Math.hypot(best[0] - m[0], best[1] - m[1], best[2] - m[2]) ? q : best));
    if (nn[0] * (m[0] - ctr[0]) + nn[1] * (m[1] - ctr[1]) + nn[2] * (m[2] - ctr[2]) >= 0) outward++;
    n++;
  }
  // hub and sidewall triangles face along the axle, so a few test against the centre at 0
  assert.ok(outward / n > 0.95, `${outward} of ${n} outward`);
  // turned wheels: the same triangles, the wheels' points moved round their hubs, the helmets not;
  // one shadow a car drawn
  const { spinWheels } = await import('../lib/cars.mjs');
  const spun = spinWheels(new Map(), carStatesOf(cars, st).map((c) => ({ ...c, speed: 64 * 77 })), 0.4);
  const turned = frameCars(cars, st, cam, { indexed: true, modern: true, all: true, paletteRgb: rgb, wide: true, states: spun });
  assert.equal(turned.solid.length, modern.solid.length);
  let moved = 0;
  for (let k = 0; k < modern.solid.length; k += 6) if (Math.abs(turned.solid[k] - modern.solid[k]) + Math.abs(turned.solid[k + 2] - modern.solid[k + 2]) > 1) moved++;
  assert.ok(moved > 0 && moved < modern.solid.length / 6, `${moved} vertices moved`);
  assert.equal(modern.shadows.length / 30, drawn.length);
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

test('the cars a rear view can show: behind, within its view, not too far, not our own', () => {
  // the camera at the origin heading 0 (looking along +y); the left mirror turned by 9000h
  const ft = 64;
  const car = (slot, x, y, extra = {}) => ({ slot, x, y, pos: 'live', f96: 0, ...extra });
  // the mirror's axis: 202.5 degrees from +y, i.e. behind and to the left (-x)
  const a = (0x9000 / 65536) * 2 * Math.PI;
  const along = (d, off = 0) => [d * Math.sin(a) + off * Math.cos(a), d * Math.cos(a) - off * Math.sin(a)];
  const states = [
    car(0, 0, 0),                                   // ours
    car(1, ...along(100 * ft)),                     // on the axis, 100 ft
    car(2, 0, 100 * ft),                            // ahead
    car(3, ...along(700 * ft)),                     // too far
    car(4, ...along(100 * ft, 80 * ft)),            // 39 degrees off the axis
    car(5, ...along(100 * ft, 35 * ft)),            // 19 degrees: inside with the margin
    car(6, ...along(100 * ft), { pos: 'none' }),    // not on the circuit
    car(7, ...along(100 * ft), { f96: 0x80 }),      // not drawn
  ];
  const got = mirrorCars(states, { x: 0, y: 0, heading: 0, viewedSlot: 0 }, 0x9000).map((e) => e.slot);
  assert.deepEqual(got, [1, 5]);
  // the right mirror (7000h) sees neither
  assert.deepEqual(mirrorCars(states, { x: 0, y: 0, heading: 0, viewedSlot: 0 }, 0x7000).map((e) => e.slot), []);
});

test('the wheels roll by the distance covered, and blur when they turn too far between frames', async () => {
  const { spinWheels } = await import('../lib/cars.mjs');
  const spins = new Map();
  // 77 fine units (the wheel's radius) a second: one radian a second
  let [a, b, c] = spinWheels(spins, [{ slot: 0, speed: 77 }, { slot: 1, speed: 0 }, { slot: 2, speed: -77 * 40 }], 0.5);
  assert.ok(Math.abs(a.spin - 0.5) < 1e-9);
  assert.ok(Math.abs(a.wheelContrast - (1 - 0.5 / (Math.PI / 5))) < 1e-9);
  assert.equal(b.spin, 0);
  assert.equal(b.wheelContrast, 1);
  assert.ok(c.spin < 0, 'backwards');
  assert.equal(c.wheelContrast, 0, 'blurred');
  [a] = spinWheels(spins, [{ slot: 0, speed: 77 }], 0.25);
  assert.ok(Math.abs(a.spin - 0.75) < 1e-9, 'kept from frame to frame');
});

test('a shadow is a box round the car, turned with it', async () => {
  const { shadowQuads } = await import('../lib/cars.mjs');
  const q = shadowQuads([{ x: 1000, y: 2000, z: 5, yaw: 0 }, { x: 0, y: 0, z: 0, yaw: 0x4000 }], [100, 200]);
  assert.equal(q.length, 60);
  const v = (i) => Array.from(q.subarray(i * 5, i * 5 + 5));
  // heading 0 looks along +y: back right is (x + 340... ) at y - 560
  assert.deepEqual(v(0), [1000 - 100 - 340, 2000 - 200 - 560, 5, -1, -1]);
  assert.deepEqual(v(2), [1000 - 100 + 340, 2000 - 200 + 610, 5, 1, 1]);
  // a quarter turn: forward is +x
  const [x, y] = v(8);
  assert.ok(Math.abs(x - (-100 + 610)) < 1e-3 && Math.abs(y - (-200 - 340)) < 1e-3, `${x}, ${y}`);
});
