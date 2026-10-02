// lib/overlay.mjs: the routine that replaces the game's 3D drawing, and the
// page's keying of the game's frame.
//
//   cd spike && node --test tests/overlay.test.mjs
//
// The routine is checked on a fake guest memory holding the first bytes of
// the code it replaces and calls (no game bytes beyond those).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sceneRoutine, viewportFill, chooseMarker, keyFrame, shownMarker, paintMirrors, dimPixels } from '../lib/overlay.mjs';

const IMAGE_SEG = 0x1a2;
const lin = (seg, off) => ((seg + IMAGE_SEG) << 4) + off;
function fakeMem() {
  const H = new Uint8Array(1 << 20);
  H.set([0x1e, 0x36, 0x8e, 0x1e, 0xf4, 0x00], lin(0x0f47, 0x81ce));
  H.set([0x36, 0xf7, 0x06, 0xda, 0x08], lin(0x19ed, 0x008c));
  H.set([0x1e, 0x06, 0x60, 0x36, 0x8e, 0x1e, 0xf0], lin(0x19ed, 0x3afa));
  H.set([0x36, 0x8e, 0x1e, 0xf0, 0x00, 0xf6, 0x06, 0x81, 0x09], lin(0x0f47, 0x812b));
  H.set([0x1f, 0xc3], lin(0x0f47, 0x8178));
  return { memBase: 0, imageSeg: IMAGE_SEG, heap: () => H, H };
}

test('viewport fills: the cockpit to row 179, the outside views rows 16-179', () => {
  assert.deepEqual(viewportFill('cockpit'), { top: 0, rows: 103, offset: 0, words: 180 * 160 });
  for (const m of ['chase', 'tv', 'reverse']) assert.deepEqual(viewportFill(m), { top: 16, rows: 164, offset: 0, words: 164 * 160 });
});

test('the routine installs over the renderer, patches in place and uninstalls', () => {
  const mem = fakeMem(), H = mem.H, entry = lin(0x0f47, 0x81ce);
  const before = H.slice(entry, entry + 82);
  const r = sceneRoutine(mem, 0x17);
  assert.equal(r.bytes.length, 82);
  assert.ok(r.install());
  assert.deepEqual(H.slice(entry, entry + 82), r.bytes);
  const at = (o) => H[entry + o] | (H[entry + o + 1] << 8);
  // the far calls go to the relocated service segment
  for (const o of [0x1f, 0x24, 0x29, 0x2e]) assert.deepEqual([H[entry + o], at(o + 1), at(o + 3)], [0x9a, 0x008c, 0x19ed + IMAGE_SEG]);
  assert.deepEqual([H[entry + 0x40], at(0x41), at(0x43)], [0x9a, 0x3afa, 0x19ed + IMAGE_SEG]);
  // call 4C (push ds; jmp 812B), and the jump lands on the draw step's end
  assert.equal(H[entry + 0x45], 0xe8);
  assert.equal((0x81ce + 0x48 + at(0x46)) & 0xffff, 0x81ce + 0x4c);
  assert.equal((0x81ce + 0x50 + at(0x4e)) & 0xffff, 0x812b);
  // inc word cs:[counter], counter right after the code
  assert.deepEqual([...H.slice(entry + 3, entry + 6)], [0x2e, 0xff, 0x06]);
  assert.equal(at(6), 0x81ce + 0x50);
  // the game counts; setView and setK leave the count alone
  H[entry + 0x50] = 7;
  assert.equal(r.calls, 7);
  r.setView(viewportFill('cockpit'));
  assert.equal(at(0x17), 180 * 160);
  r.setK(0x12);
  assert.deepEqual([H[entry + 0x1a], H[entry + 0x1b]], [0x12, 0x12]);
  assert.equal(r.calls, 7);
  r.uninstall();
  assert.deepEqual(H.slice(entry, entry + 82), before);
  assert.equal(r.calls, 0);
});

test('the routine refuses a different gp.exe', () => {
  const mem = fakeMem();
  mem.H[lin(0x19ed, 0x3afa)] = 0x90;
  const r = sceneRoutine(mem, 0x17);
  assert.equal(r.install(), false);
  assert.equal(r.installed, false);
});

test('the marker: 17h when its colour is unique, else another of 10h-1Fh', () => {
  const pal = new Uint8Array(768);
  for (let i = 0; i < 256; i++) pal.set([i, (i * 7) & 255, (i * 13) & 255], i * 3);
  assert.equal(chooseMarker(pal), 0x17);
  pal.set(pal.slice(0x17 * 3, 0x17 * 3 + 3), 0x40 * 3); // 40h takes 17h's colour
  assert.equal(chooseMarker(pal), 0x10);
});

const frame = (fill) => { const f = new Uint8Array(320 * 200 * 4); for (let i = 0; i < 64000; i++) f.set([...fill(i % 320, (i / 320) | 0), 255], i * 4); return f; };

test('keying: the marker is see-through; in the outside views so is bar black reaching the screen edge', () => {
  const K = [10, 200, 30];
  // rows 16-179 the marker with a black box at x 100-109; row 5 black with a box x 80-280 (white border, black inside)
  const src = frame((x, y) => {
    if (y >= 16 && y < 180) return x >= 100 && x < 110 ? [0, 0, 0] : K;
    if (y === 5 && (x === 80 || x === 280)) return [255, 255, 255];
    return [0, 0, 0];
  });
  const dst = new Uint8ClampedArray(64000 * 4);
  const a = (x, y) => dst[(y * 320 + x) * 4 + 3];
  keyFrame(src, dst, K, { top: 16, rows: 164, cockpit: false });
  assert.equal(a(50, 50), 0, 'marker');
  assert.equal(a(105, 50), 255, 'black inside the 3D view stays');
  assert.equal(a(5, 0), 0, 'bar');
  assert.equal(a(319, 190), 0, 'bottom bar');
  assert.equal(a(40, 5), 0, 'left of the box');
  assert.equal(a(80, 5), 255, 'box border');
  assert.equal(a(150, 5), 255, 'inside the box');
  assert.equal(a(300, 5), 0, 'right of the box');
  keyFrame(src, dst, K, { top: 0, rows: 103, cockpit: true });
  assert.equal(a(5, 190), 255, 'the cockpit keeps its black');
});

test('the cockpit: black beside a mirror is our view, black inside its housing stays', () => {
  const K = [10, 200, 30], grey = [160, 160, 160];
  // rows 116-137: the left mirror's housing x 0-39 (grey, a black mark at x 20, y 125),
  // black x 40-47 (the backdrop's corner), the marker from x 48 (the 3D view)
  const src = frame((x, y) => {
    if (y >= 116 && y < 138 && x < 48) return x >= 40 ? [0, 0, 0] : x === 20 && y === 125 ? [0, 0, 0] : grey;
    if (y > 150) return [0, 0, 0]; // the cockpit's own black, below
    return K;
  });
  const dst = new Uint8ClampedArray(64000 * 4);
  const a = (x, y) => dst[(y * 320 + x) * 4 + 3];
  keyFrame(src, dst, K, { top: 0, rows: 103, cockpit: true });
  assert.equal(a(44, 120), 0, 'the corner beside the mirror');
  assert.equal(a(40, 137), 0, 'all of it');
  assert.equal(a(20, 125), 255, 'a mark inside the housing');
  assert.equal(a(10, 120), 255, 'the housing');
  assert.equal(a(5, 190), 255, 'the cockpit below');
});

test('real rear views: the glass is see-through, the housing round it stays', () => {
  const K = [10, 200, 30], sky = [100, 180, 255], housing = [200, 200, 200];
  // the left mirror: glass x 0-35 on rows 116-137 (narrower on the first row), a black
  // outline at x 36 inside the housing (rows 117-136), the housing x 36-47; the marker from x 48
  const glass = Array.from({ length: 22 }, (_, i) => ({ row: 116 + i, active: true, left: 0, right: 320, gapLeft: i === 0 ? 30 : 36, gapRight: 284 }));
  const src = frame((x, y) => {
    if (y >= 116 && y < 138 && x < 48) return x < 36 ? sky : x === 36 && y > 116 && y < 137 ? [0, 0, 0] : housing;
    return K;
  });
  const dst = new Uint8ClampedArray(64000 * 4);
  const a = (x, y) => dst[(y * 320 + x) * 4 + 3];
  keyFrame(src, dst, K, { top: 0, rows: 103, cockpit: true, glass });
  assert.equal(a(10, 125), 0, 'the glass');
  assert.equal(a(35, 125), 0, 'to its edge');
  assert.equal(a(32, 116), 255, 'not past its outline on a narrow row');
  assert.equal(a(36, 125), 255, 'the black outline round the glass stays');
  assert.equal(a(40, 125), 255, 'the housing');
  assert.equal(a(10, 115), 0, 'the marker above');
  assert.equal(a(10, 140), 0, 'and below');
  // without the glass, the game's backdrop stays
  keyFrame(src, dst, K, { top: 0, rows: 103, cockpit: true });
  assert.equal(a(10, 125), 255);
});

test('the marker as shown: exact, or faded with the screen', () => {
  const K = [100, 200, 40];
  const view = { top: 16, rows: 164 };
  assert.deepEqual(shownMarker(frame(() => K), K, view), { rgb: K, brightness: 1 });
  const faded = [50, 100, 20];
  const r = shownMarker(frame((x) => (x < 100 ? [0, 0, 255] : faded)), K, view);
  assert.deepEqual(r.rgb, faded);
  assert.equal(r.brightness, 0.5);
  // no colour covering half the view: keep the palette's
  assert.deepEqual(shownMarker(frame((x) => [x & 255, 0, 0]), K, view), { rgb: K, brightness: 1 });
});

test('mirror cars: painted inside the glass only, far cars first', () => {
  // a 4-row bitmap, anchor columns -8..8 (half-pixels), colour 1 of its palette
  const spr = { size: 1024, rows: 4, bottom: 0, runs: Array.from({ length: 4 }, () => [[-8, 8, 1]]) };
  const palettes = new Uint8Array(64); palettes[1] = 5; palettes[17] = 6;
  const cars = { spriteVscale: 65536, palettes, haze: null, sprite: () => spr };
  const clip = Array.from({ length: 22 }, (_, i) => ({ row: 116 + i, active: true, left: 0, right: 40, gapLeft: 40, gapRight: 280 }));
  const rgb = new Uint8Array(768); rgb.set([255, 0, 0], 5 * 3); rgb.set([0, 255, 0], 6 * 3);
  const dst = new Uint8ClampedArray(64000 * 4);
  // two cars at the left mirror's edge: the near one (palette 16) wins where they overlap
  paintMirrors(dst, [{ x: 20, row: 123, id: 1, mirrored: false, depth8: 512, palette: 16 }, { x: 38, row: 123, id: 1, mirrored: false, depth8: 1024, palette: 0 }], cars, rgb, clip);
  const px = (x, y) => [...dst.slice((y * 320 + x) * 4, (y * 320 + x) * 4 + 4)];
  assert.deepEqual(px(20, 123), [0, 255, 0, 255], 'near car');
  assert.deepEqual(px(39, 123), [255, 0, 0, 255], 'far car, inside the glass');
  assert.deepEqual(px(40, 123), [0, 0, 0, 0], 'clipped at the glass edge');
  assert.deepEqual(px(20, 115), [0, 0, 0, 0], 'above the mirror rows');
});

test('the overlay dims in its pixels: opaque ones darker, see-through ones as they were', () => {
  const px = new Uint8ClampedArray([200, 100, 50, 255, 9, 9, 9, 0, 255, 255, 255, 255]);
  dimPixels(px, 0.7);
  assert.deepEqual([...px], [140, 70, 35, 255, 9, 9, 9, 0, 179, 179, 179, 255]);
  dimPixels(px, 1);
  assert.deepEqual([...px.subarray(0, 4)], [140, 70, 35, 255], 'full light leaves it');
});
