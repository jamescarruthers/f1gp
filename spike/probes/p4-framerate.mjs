// The game's frame rate and the emulated CPU speed, with the game's 3D
// drawing replaced (lib/overlay.mjs). Sets the frame-rate setting SS:1230
// (300 Hz ticks per frame) in the menus, before the session loads (0:7CAF
// derives the physics step from it at load), runs a Monza Quick Race and
// records:
//   - the start: the player's speed against game time with the throttle held,
//     and every car's distance round the lap at 12 s of game time, to compare
//     the physics between frame rates;
//   - the game's load (DS:2C63, ticks of work per frame, against SS:1230), its
//     speed against real time and the host CPU, with the game's own drawing,
//     then with the fill at each cycles setting (changed at run time).
//
//   node build-bundle.mjs --autoexec "gp /g" --cycles 25000 --out dist/p2-render-25000.jsdos
//   timeout 300 node probes/p4-framerate.mjs --fps 30 [--cycles 12000,8000,6000,4000,3000] [--tag fps30]
//
// Output: out/p4-framerate/<tag>.json

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { attach } from '../lib/f1gp-mem.mjs';
import { createReader } from '../lib/f1gp-state.mjs';
import { sceneRoutine, chooseMarker } from '../lib/overlay.mjs';
import { readPalette } from '../lib/scene.mjs';

const require = createRequire(import.meta.url);
const { start, sleep } = require('../lib/node-emu.cjs');
const route = require('../lib/route.cjs');
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const fps = +opt('fps', 30), ticks = Math.round(300 / fps);
const cyclesList = opt('cycles', '12000,8000,6000,4000,3000').split(',').map(Number);
const tag = opt('tag', `fps${fps}`);
const OUT = path.join(import.meta.dirname, '..', 'out', 'p4-framerate');
fs.mkdirSync(OUT, { recursive: true });
const log = (...m) => console.log(...m);

const emu = await start(path.join(import.meta.dirname, '..', 'dist', 'p2-render-25000.jsdos'));
const drv = route.nodeDriver(emu);
let mem = null;
const setRate = () => {
  if (!mem) { try { mem = attach(emu.ci, { requireGame: true }); } catch { return; } }
  const p = mem.memBase + (mem.SS << 4) + 0x1230;
  const H = mem.heap();
  if ((H[p] | (H[p + 1] << 8)) !== ticks) { H[p] = ticks & 0xff; H[p + 1] = ticks >> 8; log(`SS:1230 = ${ticks} (${fps} fps)`); }
};
await route.toTrack(drv, { mode: 'quickrace', log, onScreen: async (s) => { if (s !== 'race') setRate(); } });
if (!mem) mem = attach(emu.ci, { requireGame: true });
const reader = createReader(mem);
const ds = (off) => { const H = mem.heap(), p = mem.memBase + (mem.DS << 4) + off; return H[p] | (H[p + 1] << 8); };
const ss = (off) => { const H = mem.heap(), p = mem.memBase + (mem.SS << 4) + off; return H[p] | (H[p + 1] << 8); };
const result = { fps, ticks, setting: ss(0x1230), step: ds(0x2c5d), yawScale: ds(0x0156), carsDrawn: ds(0x2225), intFps: ds(0x2c61) };
log('derived', JSON.stringify(result));

// the start: speed against game time, throttle held from the green light
await drv.keyDown('a');
const st0 = reader.read();
const t0 = st0.sessionMs;
const curve = [];
let at12 = null;
for (const tw = Date.now(); Date.now() - tw < 30000;) {
  const st = reader.read();
  if (!st.consistent) { await sleep(5); continue; }
  const t = st.sessionMs - t0;
  const me = st.cars[st.playerSlot];
  if (!curve.length || t - curve[curve.length - 1][0] >= 100) curve.push([t, me.speedMph, Math.round(me.trackDist)]);
  if (t >= 12000 && !at12) at12 = { t, cars: st.cars.filter((c) => c.pos !== 'none').map((c) => [c.slot, c.lap, Math.round(c.trackDist)]) };
  if (t >= 14000) break;
  await sleep(20);
}
result.start = { curve, at12 };
log('start', JSON.stringify(curve.filter((_, i) => i % 8 === 0)));

async function measure(seconds) {
  const tw = Date.now(), cpu0 = process.cpuUsage();
  let lastClock = ds(0x2955) | (ds(0x2957) << 16), clock0 = lastClock, frames = 0, work = 0, peak = 0;
  while (Date.now() - tw < seconds * 1000) {
    const clock = ds(0x2955) | (ds(0x2957) << 16);
    if (clock !== lastClock) { frames++; const w = ds(0x2c63); work += w; peak = Math.max(peak, w); lastClock = clock; }
    await sleep(3);
  }
  const wall = (Date.now() - tw) / 1000, cpu = process.cpuUsage(cpu0);
  return {
    gameFps: +(frames / wall).toFixed(1),
    gameSpeed: +((lastClock - clock0) / 1000 / wall).toFixed(3),
    workTicks: +(work / Math.max(frames, 1)).toFixed(2), peakTicks: peak,
    occupancyPct: +((100 * work) / Math.max(frames, 1) / ss(0x1230)).toFixed(1),
    hostCpuPct: +((100 * (cpu.user + cpu.system)) / 1e6 / wall).toFixed(1),
  };
}
result.load = { gameDrawing: await measure(5) };
log('game drawing', JSON.stringify(result.load.gameDrawing));
const routine = sceneRoutine(mem, chooseMarker(readPalette(mem)));
if (!routine.install()) throw new Error('fill not installed');
await sleep(500);
result.load['fill 25000'] = await measure(5);
log('fill 25000', JSON.stringify(result.load['fill 25000']));
for (const c of cyclesList) {
  emu.ci.sendBackendEvent({ type: 'wc-trigger-event', event: `cycles:${c}` });
  await sleep(800);
  result.load[`fill ${c}`] = await measure(5);
  log(`fill ${c}`, JSON.stringify(result.load[`fill ${c}`]));
}
await drv.keyUp('a');
fs.writeFileSync(path.join(OUT, `${tag}.json`), JSON.stringify(result, null, 1));
process.exit(0);
