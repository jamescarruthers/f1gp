// Paired captures for the car checks: screenshot + 1 MB guest RAM + the
// game state of the last few frames, in a Quick Race (or practice session),
// following a script of keys and waits. One emulator; wrap in `timeout`.
//
//   node build-bundle.mjs --autoexec "gp /g" --cycles 25000 --out dist/p3-cars-25000.jsdos
//   timeout 235 node probes/p3-cars-capture.mjs --script SCRIPT.json --tag NAME
//        [--mode quickrace|practice] [--circuit NAME] [--green] [--pause game|emu] [--warp 1]
//
// script: [ {key: name [, ms]} | {down: name} | {up: name} | {wait: game ms} | {cap: name} |
//           {until: 'green'|'moving', max: game ms} | {poke: ['DS'|'SS', off, [bytes]]} ]
//
// Capture: --pause emu (default) waits for a consistent read of a new frame
// and pauses the emulator (no PAUSED sign; the screen then shows the frame
// BEFORE the one in RAM while things move, so <name>.hist.json keeps the
// game's volatile memory of the last 4 frames: probes/p3-cars-check.mjs
// --hist 1 splices the previous frame back in). --pause game presses P and
// waits for the PAUSED sign (the screen and RAM then belong to the same frame).
//
// Writes out/research-phase3/cars/cap/<tag>/<name>.png, <name>.ram, <name>.hist.json, meta.json.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { attach } from '../lib/f1gp-mem.mjs';
import { createReader } from '../lib/f1gp-state.mjs';

const require = createRequire(import.meta.url);
const { start, encodePng, sleep } = require('../lib/node-emu.cjs');
const route = require('../lib/route.cjs');

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
const SCRIPT = JSON.parse(fs.readFileSync(opt('script'), 'utf8'));
const TAG = opt('tag', 'run');
const MODE = opt('mode', 'quickrace');
const PAUSE = opt('pause', 'emu');
const WARP = +opt('warp', 1);
const OUT = path.join(ROOT, 'out', 'research-phase3', 'cars', 'cap', TAG);
fs.mkdirSync(OUT, { recursive: true });
if (WARP !== 1) { const realNow = performance.now.bind(performance); const base = realNow(); performance.now = () => base + (realNow() - base) * WARP; }
const t0 = Date.now();
const log = (...m) => console.log(((Date.now() - t0) / 1000).toFixed(1), ...m);
const EXTRA = { pagedown: 267, pageup: 266, delete: 261, home: 268, insert: 260, end: 269 };
const code = (k) => EXTRA[k] ?? route.JSDOS_KEYS[k];

const emu = await start(path.join(ROOT, 'dist', opt('bundle', 'p3-cars-25000.jsdos')));
const meta = { tag: TAG, mode: MODE, pause: PAUSE, caps: [] };
try {
  await route.toTrack(route.nodeDriver(emu), { mode: MODE, circuit: opt('circuit', undefined), waitForGreen: args.includes('--green'), log });
  const mem = attach(emu.ci, { requireGame: true });
  const reader = createReader(mem);
  meta.imageSeg = mem.imageSeg;
  const R = mem.ss.u16(0xf4) << 4;
  // the game's volatile memory that the renderer reads (cars, camera, order, flags)
  const BLOCKS = [[mem.dsLinear, 0x2d00], [mem.ssLinear, 0x200], [mem.ssLinear + 0x1100, 0x200], [mem.ssLinear + 0x1900, 0x100], [R, 0x200]];
  const hist = [];
  let lastTick = -1;
  const poll = () => {
    const s = reader.read();
    if (s.tick !== lastTick && s.consistent) {
      lastTick = s.tick;
      hist.push({ tick: s.tick, frame: s.frame, blocks: BLOCKS.map(([lin, n]) => [lin, Buffer.from(mem.snapshot(lin, n)).toString('base64')]) });
      if (hist.length > 4) hist.shift();
      return s;
    }
    return null;
  };
  const run = async (gameMs, test = null) => {
    const tick0 = reader.read().tick, w0 = Date.now();
    while (true) {
      const s = poll();
      if (s && ((test && test(s)) || s.tick - tick0 >= gameMs)) return s;
      if (Date.now() - w0 > gameMs / WARP * 3 + 4000) return null;
      await sleep(2);
    }
  };
  for (const step of SCRIPT) {
    if (Date.now() - t0 > 225000) { log('out of time'); break; }
    if (step.key) { emu.ci.sendKeyEvent(code(step.key), true); await run(step.ms ?? 130); emu.ci.sendKeyEvent(code(step.key), false); await run(70); }
    else if (step.down) emu.ci.sendKeyEvent(code(step.down), true);
    else if (step.up) emu.ci.sendKeyEvent(code(step.up), false);
    else if (step.wait) await run(step.wait);
    else if (step.until) {
      const test = step.until === 'moving' ? (s) => s.cars.some((c) => c.speedMph > 20) : (s) => s.cars.some((c) => c.speedMph > 2);
      const s = await run(step.max ?? 30000, test);
      log('until', step.until, s ? `tick ${s.tick}` : 'timeout');
    } else if (step.pokeCar) {
      // [slot, offset, value, 'or' | 'set' | 'and']
      const [slot, off, v, how = 'or'] = step.pokeCar;
      const lin = mem.dsLinear + 0x0d1b + slot * 0xc0 + off, h = mem.heap(), o = mem.memBase + lin;
      h[o] = how === 'set' ? v : how === 'and' ? h[o] & v : h[o] | v;
      log('pokeCar', slot, off.toString(16), '->', h[o].toString(16));
    } else if (step.viewCar !== undefined) {
      const ptr = 0x0d1b + step.viewCar * 0xc0, h = mem.heap(), o = mem.memBase + mem.dsLinear + 0x097f;
      h[o] = ptr & 0xff; h[o + 1] = ptr >> 8;
      log('viewCar', step.viewCar);
    } else if (step.untilCar) {
      // [slot, offset, value]: wait until the byte equals value
      const [slot, off, v] = step.untilCar;
      const lin = mem.dsLinear + 0x0d1b + slot * 0xc0 + off;
      const s = await run(step.max ?? 60000, () => mem.u8(lin) === v);
      log('untilCar', slot, off.toString(16), v, s ? `tick ${s.tick}` : 'timeout', 'now', mem.u8(lin));
    } else if (step.poke) {
      const [sg, off, bytes] = step.poke;
      const lin = (sg === 'DS' ? mem.dsLinear : mem.ssLinear) + off;
      const h = mem.heap();
      bytes.forEach((b, i) => { h[mem.memBase + lin + i] = b; });
    } else if (step.cap) {
      let st;
      if (PAUSE === 'game') {
        emu.ci.sendKeyEvent(code('p'), true); await sleep(130); emu.ci.sendKeyEvent(code('p'), false);
        await sleep(800);
        emu.ci.pause();
        await sleep(100);
        st = reader.read();
      } else {
        let s = null;
        const w0 = Date.now();
        while (!s && Date.now() - w0 < 3000) { s = poll(); if (!s) await sleep(1); }
        emu.ci.pause();
        st = reader.read();
      }
      const img = await emu.ci.screenshot();
      fs.writeFileSync(path.join(OUT, `${step.cap}.png`), encodePng(img.width, img.height, img.data, 4));
      fs.writeFileSync(path.join(OUT, `${step.cap}.ram`), mem.snapshot(0, 0x100000));
      fs.writeFileSync(path.join(OUT, `${step.cap}.hist.json`), JSON.stringify({ tick: st.tick, frame: st.frame, entries: hist }));
      const viewed = st.cars[st.view.viewedSlot ?? st.playerSlot];
      const rec = { name: step.cap, tick: st.tick, frame: st.frame, view: st.view.mode, viewedSlot: st.view.viewedSlot, speedMph: viewed?.speedMph, paused: st.paused, histFrames: hist.map((h) => h.frame) };
      meta.caps.push(rec);
      log('cap', JSON.stringify(rec));
      emu.ci.resume();
      if (PAUSE === 'game') { await sleep(100); emu.ci.sendKeyEvent(code('p'), true); await sleep(130); emu.ci.sendKeyEvent(code('p'), false); await run(70); }
    }
  }
} catch (e) { console.error(e); meta.error = String(e); }
fs.writeFileSync(path.join(OUT, 'meta.json'), JSON.stringify(meta, null, 1));
await emu.stop();
process.exit(0);
