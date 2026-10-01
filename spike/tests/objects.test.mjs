// node --test tests/objects.test.mjs
// Checks lib/objects.mjs: the shape, sprite and placement decoders on small
// hand-made memory images (no game data), and, when the git-ignored RAM
// captures exist (out/research-phase2/static/cap/s2, out/p1-track/prac-*),
// on the game's own memory, including a pixel comparison with one game frame.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  makeReader, makeTrig, decodeShape, shapePoints, polygonLoop, decodeSprite, placeObject, spriteLodFrame,
  shownAtDetail, hazeLevel, placementParts, buildObjectMesh, buildSectorMesh, frameObjects, buildSpriteAtlas,
  spriteQuads, readObjects, readCrowd, CROWD_COLOUR, spriteIdsUsed, cameraInPitLane,
} from '../lib/objects.mjs';

const HERE = import.meta.dirname;
const OUT = path.join(HERE, '..', 'out');
const S2 = path.join(OUT, 'research-phase2', 'static', 'cap', 's2');
const PRAC = path.join(OUT, 'p1-track');

// ------------------------------------------------------------------ synthetic memory
// A writable 64 KB image; far pointers use segment 0 (offset = linear address).
function image() {
  const H = new Uint8Array(0x10000);
  const w8 = (a, v) => { H[a] = v & 0xff; };
  const w16 = (a, v) => { H[a] = v & 0xff; H[a + 1] = (v >> 8) & 0xff; };
  const far = (a, lin) => { w16(a, lin); w16(a + 2, 0); };
  const bytes = (a, list) => list.forEach((v, i) => w8(a + i, v));
  return { H, w8, w16, far, bytes };
}

// a board: two scale values (100, 50); a quad (front), the same quad reversed
// (back), a pole and a bitmap; two view sectors
function boardShape(m, at = 0x1000) {
  const scale = at + 0x40, elems = at + 0x50, pts = at + 0x80, vecs = at + 0xb0, list = at + 0xc0;
  m.w16(at, 200); m.far(at + 2, scale); m.far(at + 6, elems); m.far(at + 0x0a, pts); m.far(at + 0x0e, vecs);
  m.w16(at + 0x12, 0); m.w16(at + 0x14, 0);
  m.w16(at + 0x16, 0x7fff); m.w16(at + 0x18, 0xe000); m.w16(at + 0x1a, 0x0e); m.far(at + 0x1c, list);
  m.w16(scale, 100); m.w16(scale + 2, 50);
  // visibility list, then elements: @0 poly c=5 [1,2,3,4]; @6 poly c=6 [-4,-3,-2,-1];
  // @12 line (colour byte 8, vector 3); @15 bitmap 80h at point 4, max depth 100*128, id 69h
  m.bytes(elems, [0, 1, 0xff, 5, 1, 2, 3, 4, 0, 6, 0xfc, 0xfd, 0xfe, 0xff, 0, 0xa0, 8, 3, 0x80, 4, 100, 0x69]);
  const P = [[2, 0, 0], [34, 0, 0], [0x8001, 0, 50], [0x8000, 0, 50], [0, 4, 25]];
  P.forEach(([wx, wy, z], i) => { m.w16(pts + 8 * i, wx); m.w16(pts + 8 * i + 2, wy); m.w16(pts + 8 * i + 4, z); m.w16(pts + 8 * i + 6, 0); });
  [[0, 0], [0, 1], [1, 2], [2, 3], [3, 0]].forEach(([a, b], i) => m.bytes(vecs + 2 * i, [a, b]));
  // display list: two sectors (shift 0Eh): offsets of the sub-lists, then the sub-lists
  m.w16(list, 4); m.w16(list + 2, 12);
  [0, 12, 15, 0xffff].forEach((v, i) => m.w16(list + 4 + 2 * i, v));
  [6, 12, 0xffff].forEach((v, i) => m.w16(list + 12 + 2 * i, v));
  return at;
}

const cosTable = Int16Array.from({ length: 4097 }, (_, i) => Math.round(16384 * Math.cos((i * 8 * 2 * Math.PI) / 65536)));

test('shape: header, LOD, scale words, reference points, display lists, elements', () => {
  const m = image();
  const ptr = boardShape(m);
  const sh = decodeShape(makeReader(m.H), ptr);
  assert.equal(sh.size, 200);
  assert.equal(sh.lods.length, 1);
  assert.deepEqual(sh.vis, [0, 1]);
  assert.equal(sh.lods[0].dirs.length, 2);
  assert.deepEqual(sh.lods[0].dirs, [[0, 12, 15], [6, 12]]);
  const pts = shapePoints(sh);
  assert.deepEqual(pts.map((p) => [p.x, p.y, p.z]), [[100, 0, 0], [-100, 0, 0], [-100, 0, 50], [100, 0, 50], [0, 50, 25]]);
  assert.equal(pts[2].ref, 1);
  const front = sh.elements.get(0), back = sh.elements.get(6);
  assert.equal(front.kind, 'poly'); assert.equal(front.colour, 5);
  assert.deepEqual(polygonLoop(sh, front), [0, 1, 2, 3]);
  assert.deepEqual(polygonLoop(sh, back), [0, 3, 2, 1]);
  assert.deepEqual(sh.elements.get(12), { kind: 'line', type: 0xa0, colourByte: 8, vector: 3 });
  assert.deepEqual(sh.elements.get(15), { kind: 'bitmap', type: 0x80, point: 4, maxDepth: 100 * 128, id: 0x69 });
});

test('shape: scale override (setting +8) sets a value or moves the scale pointer', () => {
  const m = image();
  const ptr = boardShape(m);
  const rd = makeReader(m.H);
  assert.equal(shapePoints(decodeShape(rd, ptr, 0x0141))[0].x, 0xa0); // k = 1: value 1 = (v & FFF0h) >> 1
  assert.equal(shapePoints(decodeShape(rd, ptr, 0x0010))[0].x, 50); // k = 0: pointer + 2 bytes -> first value is 50
});

test('polygon outline closes a chain with a missing edge', () => {
  const m = image();
  const ptr = boardShape(m);
  const sh = decodeShape(makeReader(m.H), ptr);
  assert.deepEqual(polygonLoop(sh, { kind: 'poly', edges: [1, 2, 3] }), [0, 1, 2, 3]);
});

test('sprite: alias, rows from the bottom, runs with and without a start column', () => {
  const m = image();
  const seg = 0x200, B = seg << 4; // the sprite store's segment; table of far pointers at +0238
  const data = 0x3000;
  m.far(B + 0x238 + 4 * 0x10, data);
  m.w16(B + 0x238 + 4 * 0x11, 0x0000); m.w16(B + 0x238 + 4 * 0x11 + 2, 0); // id 11h -> data at 0 (alias below)
  m.w16(0, 0x8010);                                                    // alias to id 10h
  m.w16(data, 1600); m.w16(data + 2, 4); m.w16(data + 4, 3); m.w16(data + 6, 1); m.w16(data + 8, 12); m.w16(data + 10, 17);
  m.bytes(data + 12, [0x8a, 0xfe, 2, 0]);           // row 0: colour 3, columns -2..2
  m.bytes(data + 17, [0x8c, 0xff, 1, 0x0e, 3, 0]);  // row 1: colour 4 from -1 to 1, then colour 5 to 3
  const rd = makeReader(m.H);
  const s = decodeSprite(rd, seg, 0x10);
  assert.equal(s.size, 1600); assert.equal(s.rows, 2); assert.equal(s.bottom, 1);
  assert.deepEqual(s.runs, [[[-2, 2, 3]], [[-1, 1, 4], [1, 3, 5]]]);
  assert.deepEqual(decodeSprite(rd, seg, 0x11).runs, s.runs);
  const atlas = buildSpriteAtlas({ sprite: (id) => decodeSprite(rd, seg, id) }, [0x10]);
  const r = atlas.rects.get(0x10);
  assert.equal(r.w, 5); assert.equal(r.h, 2);
  assert.equal(atlas.data[r.y * atlas.width + r.x], 3);               // row 0, column -2
  assert.equal(atlas.data[(r.y + 1) * atlas.width + r.x + 4], 5);     // row 1, column 2
  assert.equal(atlas.data[(r.y + 1) * atlas.width + r.x], 255);       // row 1, column -2: empty
});

test('placement: half-widths to the right, Z, yaw (integer arithmetic of 0F47:9E2A)', () => {
  const m = image();
  const lin = 0x2000;
  m.w16(lin, 0x1000); m.w16(lin + 4, 100); m.w16(lin + 6, 40); m.w16(lin + 8, 200);
  m.w16(lin + 0x0c, 40 << 6); m.w16(lin + 0x0e, 8 << 6);
  const st = { shape: 20, lateral: 256, yaw: 0x8000, extra: 0, height: 12, palette: 0x520, tilt: 0, flags: 0x10 };
  const p = placeObject(makeReader(m.H), lin, st);
  assert.equal(p.x, 800 + 320); assert.equal(p.y, 1600 - 64);
  assert.equal(p.z, 52); assert.equal(p.yaw, 0x9000); assert.equal(p.maxSegments, 25);
  // shapes 0, 2, 3 also move along the track by setting +8 / 256 half-widths
  const q = placeObject(makeReader(m.H), lin, { ...st, shape: 3, extra: 256 });
  assert.equal(q.x, 800 + 320 + 64); assert.equal(q.y, 1600 - 64 + 320);
});

test('detail levels and haze levels', () => {
  assert.ok(shownAtDetail({ flags: 0x02 }, 3));
  assert.ok(!shownAtDetail({ flags: 0x02 }, 2));
  assert.ok(!shownAtDetail({ flags: 0x40 }, 1));
  assert.ok(shownAtDetail({ flags: 0x04 }, 0) && !shownAtDetail({ flags: 0x00 }, 0));
  assert.equal(hazeLevel(3199), 0); assert.equal(hazeLevel(3200), 1); assert.equal(hazeLevel(5248), 2); assert.equal(hazeLevel(100000), 4);
});

test('bitmap LOD frames by view angle (0F47:9AAF)', () => {
  assert.deepEqual(spriteLodFrame({ shift: 0x806d, mask: 0 }, 0x1000), { id: 0x6d, mirrored: false });
  assert.deepEqual(spriteLodFrame({ shift: 0x806d, mask: 0 }, 0x5000), { id: 0x6d, mirrored: true });
  // folded angles: 400h | 800h flags, frame table base DDh, step 100h
  const l = { shift: 10, mask: 0x0c01, frame: (ax) => (ax < 0x400 ? { add: 0x80, base: 0xdd, shift: 8 } : { add: 0, base: 0x8000, shift: 0x8000 }) };
  assert.deepEqual(spriteLodFrame(l, 0x0200), { id: 0xdf, mirrored: false });
  assert.deepEqual(spriteLodFrame(l, 0x7f00), { id: 0xde, mirrored: true });
  assert.deepEqual(spriteLodFrame(l, 0x2000), { polygons: true });
  assert.equal(spriteLodFrame({ shift: 10, mask: 0x0001 }, 0x9000), null);
});

test('mesh: one-sided triangles wound counter-clockwise from the visible side, sectors, sprites', () => {
  const m = image();
  const ptr = boardShape(m);
  const rd = makeReader(m.H);
  const shape = decodeShape(rd, ptr);
  const palettes = new Uint8Array(0x900); for (let i = 0; i < 16; i++) palettes[0x520 + i] = 0x40 + i;
  const p = { x: 1000, y: 2000, z: 0, yaw: 0, palette: 0x520, tilt: 0, flags: 0, shape: 20, segment: 5, setting: 2, override: 0, patch: null, maxSegments: Infinity };
  const objs = {
    placements: [p], settings: { 2: { range: 0 } }, palettes, trig: makeTrig(cosTable), spriteVscale: 0xdd00, vscale: 0x6e80,
    shapeAt: () => shape, sprite: () => null,
  };
  const parts = placementParts(objs, p);
  assert.equal(parts.polys.length, 2);
  assert.equal(parts.polys[0].colour, 0x45);
  assert.equal(parts.lines.length, 1); assert.equal(parts.lines[0].colour, 0x40);
  assert.equal(parts.bitmaps[0].id, 0x69);
  // the front quad (outline 0,1,2,3: clockwise on screen seen from -Y) faces -Y
  assert.ok(parts.polys[0].facing[1] < 0 && parts.polys[1].facing[1] > 0);
  const mesh = buildObjectMesh(objs, { indexed: true, origin: [0, 0] });
  assert.equal(mesh.ranges.solid.count, 12);
  // seen from -Y (a camera looking along +Y: screen x = X, screen y = Z), the first
  // triangle (the front quad) must run counter-clockwise
  const v = (k) => [mesh.data[k * 6], mesh.data[k * 6 + 2]];
  const [a, b, c] = [v(0), v(1), v(2)];
  assert.ok((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]) > 0);
  assert.deepEqual([...mesh.data.slice(3, 6)], [0x45, -1, 0]);
  // sectors: looking along +Y (a = 0 - 0 = 0: sector 0) shows the front quad, pole and bitmap
  const sm = buildSectorMesh(objs, { indexed: true, origin: [0, 0] });
  const front = frameObjects(sm, { x: 1000, y: 0, heading: 0 });
  assert.equal(front.layers[0].length, 6); assert.equal(front.lines.length, 2); assert.equal(front.sprites.length, 1);
  assert.equal(sm.data[front.layers[0][0] * 6 + 3], 0x45);
  const behind = frameObjects(sm, { x: 1000, y: 4000, heading: 0x8000 });
  assert.equal(behind.layers[0].length, 6); assert.equal(behind.sprites.length, 0);
  assert.equal(sm.data[behind.layers[0][0] * 6 + 3], 0x46);
});

// ------------------------------------------------------------------ game memory (optional)
const haveS2 = fs.existsSync(path.join(S2, 'grid-chase.ram'));
const loadMem = async (file) => {
  const { fromRam } = await import('../lib/f1gp-mem.mjs');
  return fromRam(new Uint8Array(fs.readFileSync(file)), { imageSeg: 0x1a2 });
};

test('Monza (RAM capture): every placement decodes; mesh and sprites are complete', { skip: !haveS2 && 'no RAM captures in out/' }, async () => {
  const mem = await loadMem(path.join(S2, 'grid-chase.ram'));
  const objs = readObjects(mem);
  assert.ok(objs.placements.length > 150, `${objs.placements.length} placements`);
  for (const p of objs.placements) {
    const sh = objs.shapeAt(p);
    assert.ok(sh, `shape ${p.shape} of setting ${p.setting}`);
    if (!sh.elements) continue;
    for (const el of sh.elements.values()) if (el.kind === 'poly') assert.ok(polygonLoop(sh, el).length >= 3);
  }
  const mesh = buildObjectMesh(objs, { indexed: true, set: 'all' });
  assert.ok(mesh.counts.polys > 400 && mesh.counts.sprites > 100, JSON.stringify(mesh.counts));
  assert.ok(mesh.data.every(Number.isFinite));
  const ids = mesh.sprites.map((s) => s.id);
  for (const id of new Set(ids)) assert.ok(objs.sprite(id), `bitmap ${id.toString(16)}`);
  const atlas = buildSpriteAtlas(objs, ids);
  assert.equal(atlas.rects.size, new Set(ids).size);
  const quads = spriteQuads(mesh.sprites, atlas, { x: 0, y: 0, heading: 0 }, objs, mesh.origin);
  assert.equal(quads.length, mesh.sprites.length * 6 * 7);
  const all = spriteIdsUsed(objs);
  assert.ok(all.includes(0xdd) && all.includes(0x69), 'far tree-row frames and trees');
  assert.ok(!cameraInPitLane(mem));
  const crowd = readCrowd(mem);
  assert.equal(crowd.strips.length, 5);
  assert.ok(crowd.active); // a race: the stands are full
  assert.ok(mesh.ranges.crowd.length > 0, 'crowd polygons');
  for (const v of mesh.ranges.crowd) assert.equal(mesh.data[v * 6 + 3], CROWD_COLOUR);
});

test('Monza (RAM capture + game frame): objects match the game frame in object areas', { skip: !haveS2 && 'no RAM captures in out/' }, async () => {
  const { createReader } = await import('../lib/f1gp-state.mjs');
  const { decodePng } = await import('../lib/png.mjs');
  const { checkFrame } = await import('../probes/p2-objects-lib.mjs');
  for (const name of ['ai3-tv', 'ai9-tv']) {
    const mem = await loadMem(path.join(S2, `${name}.ram`));
    const game = decodePng(fs.readFileSync(path.join(S2, `${name}.png`)));
    const st = createReader(mem).read();
    for (const mode of ['game', 'meshr']) {
      const { result } = checkFrame({ mem, st, game, detail: mem.ds.u8(0x0068), fromMemory: true, mode });
      assert.ok(result.objectPixels > 3000, `${name} ${mode}: ${result.objectPixels} object pixels`);
      assert.ok(result.objectSamePct >= 95, `${name} ${mode}: ${result.objectSamePct}% of object pixels match`);
    }
  }
});

const pracDirs = fs.existsSync(PRAC) ? fs.readdirSync(PRAC).filter((d) => d.startsWith('prac-') && fs.existsSync(path.join(PRAC, d, 'ram-pits.bin'))) : [];
test('all circuits (practice RAM dumps): shapes, sprites and meshes decode', { skip: !pracDirs.length && 'no practice RAM dumps in out/' }, async () => {
  for (const d of pracDirs) {
    const mem = await loadMem(path.join(PRAC, d, 'ram-pits.bin'));
    const objs = readObjects(mem);
    assert.ok(objs.placements.length > 50, d);
    const mesh = buildSectorMesh(objs, { indexed: true, set: 'all' });
    assert.ok(mesh.counts.polys > 200, `${d}: ${JSON.stringify(mesh.counts)}`);
    assert.ok(mesh.data.every(Number.isFinite), d);
    for (const s of mesh.sprites) assert.ok(objs.sprite(s.id), `${d}: bitmap ${s.id.toString(16)}`);
    assert.ok(!readCrowd(mem).active, `${d}: practice: empty stands`);
  }
});
