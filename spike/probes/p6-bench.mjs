// The Rust PC (lib/pc.mjs) against DOSBox (js-dos's Node build), in Node, without a page:
// the route to a Monza Quick Race with the game at 30 fps (as the page sets it), then phases
// of the game's own 3D drawing at several cycles settings and of the fill (lib/overlay.mjs,
// the page's new view) at 25,000 and 8,000 cycles (the page's race setting). For each: the
// host CPU per second of game time, the game's speed against the host's time, the game's
// frame rate and load; for our PC the instructions per host second as well. DOSBox runs in
// real time (it cannot run faster), so its top speed shows as the cycles it reaches when the
// setting asks for more than the host can give.
//
//   node probes/p6-bench.mjs [--machine rust|dosbox] [--seconds 8] [--game 25000,100000]
//     [--fill 25000,8000] [--bundle dist/f1gp.jsdos] [--record out/p6-bench/race.ops]
//
// --record (our PC only): writes the machine calls from boot to the end (the phases after a
// `p` line) for machine/src/bin/replay.rs, which runs them again natively, instruction for
// instruction, and checks the end state: for timing and profiling the interpreter.
//
// Output: out/p6-bench/<machine>.json and a line per phase.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { unzipSync } from 'fflate';
import { createPC, pcDriver } from '../lib/pc.mjs';
import { attach } from '../lib/f1gp-mem.mjs';
import { sceneRoutine, chooseMarker } from '../lib/overlay.mjs';
import { readPalette } from '../lib/scene.mjs';

const require = createRequire(import.meta.url);
const route = require('../lib/route.cjs');
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const MACHINE = opt('machine', 'rust'), SECONDS = +opt('seconds', 8);
const GAME = opt('game', '25000,100000').split(',').filter(Boolean).map(Number);
const FILL = opt('fill', '25000,8000').split(',').filter(Boolean).map(Number);
const SPIKE = path.join(import.meta.dirname, '..');
const BUNDLE = path.resolve(SPIKE, opt('bundle', 'dist/f1gp.jsdos'));
const RECORD = opt('record', null);
const OUT = path.join(SPIKE, 'out', 'p6-bench');
fs.mkdirSync(OUT, { recursive: true });
const log = (...m) => console.log(...m);

let ci, driver, pc = null, setCycles;
const record = RECORD ? [] : undefined;
if (MACHINE === 'rust') {
  pc = await createPC({ wasm: fs.readFileSync(path.join(SPIKE, 'dist', 'machine.wasm')), files: unzipSync(fs.readFileSync(BUNDLE)), cyclesPerMs: 25000, record });
  ci = pc; driver = pcDriver(pc, route.JSDOS_KEYS); setCycles = (c) => pc.setCycles(c);
} else {
  const { start } = require('../lib/node-emu.cjs');
  const emu = await start(BUNDLE);
  ci = emu.ci; driver = route.nodeDriver(emu);
  setCycles = (c) => ci.sendBackendEvent({ type: 'wc-trigger-event', event: `cycles:${c}` });
}

let mem = null;
const write = (lin, bytes) => { if (pc) pc.write(lin, bytes); else mem.heap().set(bytes, mem.memBase + lin); };
// the game at 30 fps: SS:1230 = 10 ticks of 300 Hz a frame, set in the menus (as render.html)
const setRate = () => {
  if (!mem) { try { mem = attach(ci, { requireGame: true }); } catch { return; } }
  const lin = (mem.SS << 4) + 0x1230, H = mem.heap();
  if ((H[mem.memBase + lin] | (H[mem.memBase + lin + 1] << 8)) !== 10) write(lin, [10, 0]);
};
const w0 = performance.now();
await route.toTrack(driver, { mode: 'quickrace', log: () => {}, onScreen: async (s) => { if (s !== 'race') setRate(); } });
if (!mem) mem = attach(ci, { requireGame: true });
const routeS = (performance.now() - w0) / 1000;
const ds = (off) => { const H = mem.heap(), p = mem.memBase + (mem.DS << 4) + off; return H[p] | (H[p + 1] << 8); };
const ss = (off) => { const H = mem.heap(), p = mem.memBase + (mem.SS << 4) + off; return H[p] | (H[p + 1] << 8); };
const clock = () => (ds(0x2955) | (ds(0x2957) << 16)) >>> 0; // the game's clock, ms
log(`${MACHINE}: the route in ${routeS.toFixed(1)} s${pc ? ` (${(pc.now() / 1000).toFixed(1)} s of game time)` : ''}`);
record?.push('p');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function measure(name, cycles) {
  setCycles(cycles);
  if (pc) { for (let t = 0; t < 300; t += 1000 / 60) pc.run(1000 / 60); } else await sleep(800); // settle
  let last = clock(), c0 = last, frames = 0, work = 0;
  const poll = () => { const c = clock(); if (c !== last) { frames++; work += ds(0x2c63); last = c; } };
  const cpu0 = process.cpuUsage(), t0 = performance.now(), n0 = pc ? pc.instructions() : 0, g0 = pc ? pc.now() : 0;
  if (pc) {
    // as the page: the game in steps of a 60 Hz display frame, and the screen
    while (pc.now() - g0 < SECONDS * 1000) { pc.run(1000 / 60); pc.screen(); poll(); }
  } else {
    while (performance.now() - t0 < SECONDS * 1000) { poll(); await sleep(3); }
  }
  const wall = (performance.now() - t0) / 1000, cpu = process.cpuUsage(cpu0);
  const cpuS = (cpu.user + cpu.system) / 1e6, game = (last - c0) / 1000;
  const r = {
    name, cycles, hostS: +wall.toFixed(2), gameS: +game.toFixed(2),
    speed: +(game / wall).toFixed(3), // game seconds per host second
    cpuPerGameS: +(cpuS / game).toFixed(3), // host CPU seconds per second of game time
    gameFps: +(frames / game).toFixed(1),
    loadPct: +((100 * work) / Math.max(frames, 1) / ss(0x1230)).toFixed(0), // the game's work (DS:2C63) against its frame (SS:1230)
  };
  if (pc) r.mips = +((pc.instructions() - n0) / wall / 1e6).toFixed(1);
  else r.reachedPerMs = Math.round(cycles * Math.min(1, game / wall));
  log(`  ${name} ${cycles}: ${JSON.stringify(r)}`);
  return r;
}

const result = { machine: MACHINE, bundle: path.relative(SPIKE, BUNDLE), routeS: +routeS.toFixed(1), phases: [] };
for (const c of GAME) result.phases.push(await measure('game', c));
if (FILL.length) {
  const routine = sceneRoutine(mem, chooseMarker(readPalette(mem)));
  const bytes = Uint8Array.from(routine.bytes);
  if (!routine.install()) throw new Error('the fill could not be installed');
  record?.push(`w ${(routine.entry - mem.memBase).toString(16)} ${Buffer.from(bytes).toString('hex')}`);
  for (const c of FILL) result.phases.push(await measure('fill', c));
}
if (record) {
  // the end state, which the replay checks: instructions, and sums of the screen and of guest RAM
  const sum = (a) => a.reduce((x, y) => (Math.imul(x, 31) + y) >>> 0, 0);
  record.push(`e ${pc.instructions()} ${sum(pc.screen())} ${sum(pc.ram().subarray(0, 0x110000))}`);
  fs.mkdirSync(path.dirname(path.resolve(SPIKE, RECORD)), { recursive: true });
  fs.writeFileSync(path.resolve(SPIKE, RECORD), record.join('\n') + '\n');
  log(`recorded ${record.length} calls to ${RECORD}`);
}
fs.writeFileSync(path.join(OUT, `${MACHINE}.json`), JSON.stringify(result, null, 1));
process.exit(0);
