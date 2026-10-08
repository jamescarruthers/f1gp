// The game's 3D view drawn by our Rust port of its routine (machine/src/r3d/, pc.native3d) in
// the game on our PC in Node: from boot through the route to a Quick Race at Monza, then driven
// by the autopilot in the cockpit and the chase view, at an emulated CPU speed. Reports the
// game's frame rate (the 3D frames it drew a second of its time), how long the host took, and
// saves a screenshot of each view.
//
//   node build-machine.mjs && node probes/p8-r3d-native.mjs [--r3d ours|game] [--cycles 8000] [--seconds 10]
//
// With --r3d game the game's own code draws, for comparison.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { unzipSync } from 'fflate';
import { createPC, pcDriver } from '../lib/pc.mjs';
import { attach } from '../lib/f1gp-mem.mjs';
import { createReader } from '../lib/f1gp-state.mjs';
import { startAutopilot } from '../lib/autopilot.mjs';
import { encodePng } from '../lib/browser-emu.mjs';

const require = createRequire(import.meta.url);
const route = require('../lib/route.cjs');
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const SPIKE = path.join(import.meta.dirname, '..');
const OURS = opt('r3d', 'ours') === 'ours', CYCLES = +opt('cycles', 8000), SECONDS = +opt('seconds', 10);
const OUT = path.join(SPIKE, 'out', 'r3d-native');
fs.mkdirSync(OUT, { recursive: true });

const pc = await createPC({ wasm: fs.readFileSync(path.join(SPIKE, 'dist', 'machine.wasm')), files: unzipSync(fs.readFileSync(path.join(SPIKE, 'dist', 'f1gp.jsdos'))), cyclesPerMs: 25000 });
const driver = pcDriver(pc, route.JSDOS_KEYS);
let mem = null;
// the game at 30 fps, as the page sets it (SS:1230 = 10 ticks of 300 Hz a frame)
const setRate = () => {
  if (!mem) { try { mem = attach(pc, { requireGame: true }); } catch { return; } }
  const lin = (mem.SS << 4) + 0x1230, H = mem.heap();
  if ((H[mem.memBase + lin] | (H[mem.memBase + lin + 1] << 8)) !== 10) pc.write(lin, [10, 0]);
};
await route.toTrack(driver, { mode: 'quickrace', log: (l) => console.log(`  [${(pc.now() / 1000).toFixed(1)} s] ${l}`), onScreen: async (s) => { if (s !== 'race') setRate(); } });
if (!mem) mem = attach(pc, { requireGame: true });

// the race: our 3D routine or the game's, at the speed asked
pc.native3d(OURS);
pc.setCycles(CYCLES);
const steps = [];
const win = { renderApp: { mem, reader: createReader(mem) }, emuCi: pc, setInterval: (f) => { steps.push(f); return steps.length; }, clearInterval: () => {} };
const ap = startAutopilot(win, { pollMs: 8 });
// the game's frames: it adds 2 to DS:2977 each frame (lib/f1gp-state.mjs workCounter)
let counted = 0, lastWork = null;
const count = () => {
  const w = win.renderApp.reader.read().workCounter;
  if (lastWork !== null) counted += ((w - lastWork) & 0xff) >> 1;
  lastWork = w;
};
const frames = () => counted;
const drive = (s) => { for (let t = 0; t < s * 1000; t += 1000 / 60) { pc.run(1000 / 60); for (const f of steps) f(); count(); } };
const tap = (code) => { pc.sendKeyEvent(code, true); drive(0.15); pc.sendKeyEvent(code, false); };
const shot = (name) => fs.writeFileSync(path.join(OUT, `${name}-${OURS ? 'ours' : 'game'}-${CYCLES}.png`), encodePng(320, 200, pc.screen()));

drive(2);
const f0 = frames(), n0 = pc.nativeFrames(), t0 = pc.now(), h0 = performance.now();
drive(SECONDS);
shot('cockpit');
tap(267);                    // Page Down: the chase view
drive(SECONDS);
shot('chase');
const f1 = frames(), n1 = pc.nativeFrames(), t1 = pc.now(), h1 = performance.now();
ap.stop();
const game = (t1 - t0) / 1000;
console.log(`${OURS ? 'our' : "the game's"} 3D at ${CYCLES} cycles/ms: ${((f1 - f0) / game).toFixed(1)} game frames a second over ${game.toFixed(1)} s of the game's time` +
  `${OURS ? `, ${n1 - n0} drawn by ours` : ''}; the host took ${((h1 - h0) / 1000).toFixed(1)} s`);
