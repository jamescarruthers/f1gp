// The game draws its cockpit, dash and messages; we draw the 3D. This probe
// replaces the game's scene renderer (0F47:81CE) with lib/overlay.mjs's
// routine, which fills the 3D viewport of the game's back buffer with one
// colour index K and keeps the renderer's 2D parts (mirror backdrop, start
// lights, cockpit patches), and checks what the game then shows in each
// view: K where our 3D shows, the game's drawing elsewhere. It also lays the
// game's keyed frame, with the mirror cars painted (paintMirrors), over
// magenta: what the page shows, with magenta for our 3D.
//
//   node build-bundle.mjs --autoexec "gp /g" --cycles 25000 --out dist/p2-render-25000.jsdos
//   timeout 200 node probes/p3-overlay.mjs [--k 23] [--early]
//
// --early installs the routine on the grid before the start lights, and logs
// the lights the game then shows (red and green pixels top right) every
// 300 ms until green.
//
// Output: out/p3-overlay/<view>.png (the game's screen), <view>-buffer.png
// (the back buffer through the palette, K in magenta), <view>-page.png (the
// overlay over magenta), grid-original.png (the game's own renderer on the
// grid, for the start lights and mirrors), summary.json.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { attach } from '../lib/f1gp-mem.mjs';
import { createReader } from '../lib/f1gp-state.mjs';
import { sceneRoutine, viewportFill, backBuffer, chooseMarker, keyFrame, paintMirrors } from '../lib/overlay.mjs';
import { readCars, frameCars } from '../lib/cars.mjs';
import { cameraFromState } from '../lib/gl-track.mjs';

const require = createRequire(import.meta.url);
const { start, encodePng, sleep } = require('../lib/node-emu.cjs');
const route = require('../lib/route.cjs');
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const kArg = opt('k', null);
const OUT = path.join(import.meta.dirname, '..', 'out', 'p3-overlay');
fs.mkdirSync(OUT, { recursive: true });
const log = (...m) => console.log(...m);

const emu = await start(path.join(import.meta.dirname, '..', 'dist', 'p2-render-25000.jsdos'));
const drv = route.nodeDriver(emu);
const early = args.includes('--early');
await route.toTrack(drv, { mode: 'quickrace', log, waitForGreen: !early });
const mem = attach(emu.ci, { requireGame: true });
const reader = createReader(mem);
const palette = () => { const H = mem.heap(), p = mem.memBase + (mem.SS << 4) + 0x05da; return Array.from(H.subarray(p, p + 768), (v) => (v << 2) | (v >> 4)); };
const K = kArg === null ? chooseMarker(palette()) : +kArg;
const summary = { k: K, views: {} };
const cars = readCars(mem);
// the game's own drawing on the grid first (start lights, mirrors)
if (!early) await sleep(1500);
{ const img = await emu.ci.screenshot(); fs.writeFileSync(path.join(OUT, 'grid-original.png'), encodePng(img.width, img.height, img.data, 4)); }
const routine = sceneRoutine(mem, K);
if (!routine.install()) throw new Error('the renderer is not where expected');
summary.routine = { entry: routine.entry.toString(16), bytes: routine.bytes.length, original: Array.from(routine.original.slice(0, 8), (b) => b.toString(16)) };
log('installed at', routine.entry.toString(16));

const shoot = async (name) => {
  // keep the fill area in step with the view, then wait for a finished frame
  for (let i = 0; i < 20; i++) { const st = reader.read(); routine.setView(viewportFill(st.view.mode)); await sleep(50); }
  let st = null;
  for (let i = 0; i < 200 && !(st && st.consistent); i++) { st = reader.read(); if (!st.consistent) await sleep(5); }
  const bb = backBuffer(mem);
  const pal = palette();
  const img = await emu.ci.screenshot();
  fs.writeFileSync(path.join(OUT, `${name}.png`), encodePng(img.width, img.height, img.data, 4));
  // what the page shows: the keyed frame with the mirror cars, over magenta
  const v = viewportFill(st.view.mode), cockpit = st.view.mode === 'cockpit';
  const page = new Uint8ClampedArray(320 * 200 * 4);
  keyFrame(img.data, page, [pal[K * 3], pal[K * 3 + 1], pal[K * 3 + 2]], { top: v.top, rows: v.rows, cockpit });
  let mirrors = [];
  if (cockpit) {
    const cam = cameraFromState(st);
    mirrors = frameCars(cars, st, { x: cam.x, y: cam.y, z: cam.z, heading: cam.heading, mode: st.view.mode }).mirrors;
    paintMirrors(page, mirrors, cars, pal);
  }
  for (let i = 0; i < 64000; i++) if (!page[i * 4 + 3]) page.set([255, 0, 255, 255], i * 4);
  fs.writeFileSync(path.join(OUT, `${name}-page.png`), encodePng(320, 200, page, 4));
  // on the screen: K's colour where our 3D would show, the rest is what the game draws over it
  const rgbOf = (i) => (pal[i * 3] << 16) | (pal[i * 3 + 1] << 8) | pal[i * 3 + 2];
  const kRgb = rgbOf(K), shown = new Map();
  let kShown = 0;
  for (let i = 0; i < img.width * img.height; i++) {
    const v = (img.data[i * 4] << 16) | (img.data[i * 4 + 1] << 8) | img.data[i * 4 + 2];
    if (v === kRgb) kShown++; else shown.set(v, (shown.get(v) || 0) + 1);
  }
  const uses = new Map();
  for (let i = 0; i < 256; i++) uses.set(rgbOf(i), (uses.get(rgbOf(i)) || 0) + 1);
  summary.palette = pal;
  summary.views[name + 'Screen'] = { kShown, otherColours: shown.size, overlayRgbs: [...shown.keys()] };
  // candidates for K: indices 10h-1Fh with an RGB no other index has and the overlay never shows
  summary.views[name + 'Candidates'] = Array.from({ length: 16 }, (_, j) => 0x10 + j).filter((i) => uses.get(rgbOf(i)) === 1 && !shown.has(rgbOf(i)));
  const px = new Uint8Array(320 * 200 * 4);
  const hist = new Map();
  for (let i = 0; i < 64000; i++) {
    const c = bb.pixels[i];
    hist.set(c, (hist.get(c) || 0) + 1);
    if (c === K) px.set([255, 0, 255, 255], i * 4); else px.set([pal[c * 3], pal[c * 3 + 1], pal[c * 3 + 2], 255], i * 4);
  }
  fs.writeFileSync(path.join(OUT, `${name}-buffer.png`), encodePng(320, 200, px, 4));
  // rows where K is present, and the colours outside the K area
  const rowsWithK = [];
  for (let y = 0; y < 200; y++) { let n = 0; for (let x = 0; x < 320; x++) if (bb.pixels[y * 320 + x] === K) n++; if (n) rowsWithK.push(y); }
  summary.views[name] = {
    view: st.view.mode, pointer: bb.pointer, kRows: rowsWithK.length ? [rowsWithK[0], rowsWithK[rowsWithK.length - 1], rowsWithK.length] : null,
    kPixels: hist.get(K) || 0, fill: viewportFill(st.view.mode), mirrors: mirrors.map((m) => ({ slot: m.slot, x: m.x, side: m.side, depth8: m.depth8 })),
    topColours: [...hist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12),
  };
  log(name, JSON.stringify(summary.views[name]));
};

const tap = async (code) => { emu.ci.sendKeyEvent(code, true); await sleep(120); emu.ci.sendKeyEvent(code, false); };
if (early) {
  // the start lights with the routine in place (19ED:3B46 is called from its tail)
  const lights = (img) => {
    let red = 0, green = 0;
    for (let y = 0; y < 70; y++) for (let x = 200; x < 320; x++) {
      const i = (y * img.width + x) * 4, r = img.data[i], g = img.data[i + 1], b = img.data[i + 2];
      if (r > 180 && g < 80 && b < 80) red++;
      if (g > 150 && r < 100 && b < 120) green++;
    }
    return { red, green };
  };
  summary.lights = [];
  let best = { red: -1 };
  for (let t = 0; t < 80; t++) {
    const img = await emu.ci.screenshot(), l = lights(img);
    summary.lights.push([t * 300, l.red, l.green]);
    if (l.red > best.red) { best = l; fs.writeFileSync(path.join(OUT, 'grid-lights.png'), encodePng(img.width, img.height, img.data, 4)); }
    if (l.green > 100) { fs.writeFileSync(path.join(OUT, 'grid-green.png'), encodePng(img.width, img.height, img.data, 4)); break; }
    await sleep(300);
  }
  log('lights', JSON.stringify(summary.lights.filter((_, i) => i % 4 === 0)));
}
await shoot('grid');
await drv.keyDown('a');
await sleep(2500);
await shoot('cockpit');
await tap(267); await sleep(2500);
await shoot('chase');
await tap(263); await sleep(2500);
await shoot('tv');
await tap(262); await sleep(2500);
await shoot('cockpit2');
await drv.keyUp('a');
// the routine's call counter: running while the game draws a race view, and in pause and the Esc menu?
const callsOver = async (ms) => { const a = routine.calls; await sleep(ms); return (routine.calls - a) & 0xffff; };
const stateNow = () => { const st = reader.read(); return { inSession: st.inSession, paused: st.paused, view: st.view.mode, frame: st.frame }; };
const save = async (name) => { const img = await emu.ci.screenshot(); fs.writeFileSync(path.join(OUT, `${name}.png`), encodePng(img.width, img.height, img.data, 4)); };
summary.calls = { driving: await callsOver(1000) };
await tap(80); await sleep(600);
summary.calls.paused = await callsOver(1000); summary.calls.pausedState = stateNow(); await save('paused');
await tap(80); await sleep(600);
await tap(256); await sleep(2000);
summary.calls.menu = await callsOver(1000); summary.calls.menuState = stateNow(); await save('menu');
await tap(256); await sleep(2000);
summary.calls.back = await callsOver(1000); summary.calls.backState = stateNow(); await save('back');
log('calls', JSON.stringify(summary.calls));
// put the renderer back and check the game draws again
routine.uninstall();
await sleep(1500);
const img = await emu.ci.screenshot();
fs.writeFileSync(path.join(OUT, 'restored.png'), encodePng(img.width, img.height, img.data, 4));
fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(summary, null, 1));
process.exit(0);
