// Paired captures (screenshot + 1 MB guest RAM, game paused) while the car
// drives down the pit lane in a practice session: the game steers there, so
// holding the throttle is enough. For checking the pit-lane object set
// (probes/p2-objects-check.mjs). One emulator, wrap in `timeout`.
//
//   node build-bundle.mjs --autoexec "gp /g" --cycles 25000 --out dist/p2-obj-25000.jsdos
//   timeout 230 node probes/p2-objects-capture.mjs --circuit Italy [--caps 8] [--every 1200] [--tag NAME]
//
// Writes out/research-phase2/objects/cap/<tag>/<k>.png, <k>.ram, meta.json (imageSeg, per capture
// the view, the camera's segment number, whether the car is in the pit lane).

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
const CIRCUIT = opt('circuit', 'Italy');
const CAPS = +opt('caps', 8), EVERY = +opt('every', 1200);
const TAG = opt('tag', `pit-${CIRCUIT.toLowerCase().replace(/ /g, '-')}`);
const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
const OUT = path.join(ROOT, 'out', 'research-phase2', 'objects', 'cap', TAG);
fs.mkdirSync(OUT, { recursive: true });
const t0 = Date.now();
const log = (...m) => console.log(((Date.now() - t0) / 1000).toFixed(1), ...m);

const emu = await start(path.join(ROOT, 'dist', 'p2-obj-25000.jsdos'));
const key = (k) => route.JSDOS_KEYS[k];
const tap = async (k, ms = 120) => { emu.ci.sendKeyEvent(key(k), true); await sleep(ms); emu.ci.sendKeyEvent(key(k), false); await sleep(100); };
try {
  await route.toTrack(route.nodeDriver(emu), { circuit: CIRCUIT, log });
  const mem = attach(emu.ci, { requireGame: true });
  const reader = createReader(mem);
  const meta = { circuit: CIRCUIT, imageSeg: mem.imageSeg, caps: [] };
  emu.ci.sendKeyEvent(key('a'), true);
  for (let k = 0; k < CAPS; k++) {
    await sleep(EVERY);
    await tap('p');
    await sleep(700);
    emu.ci.pause();
    await sleep(150);
    const st = reader.read();
    const img = await emu.ci.screenshot();
    const name = String(k).padStart(2, '0');
    fs.writeFileSync(path.join(OUT, `${name}.png`), encodePng(img.width, img.height, img.data, 4));
    fs.writeFileSync(path.join(OUT, `${name}.ram`), mem.snapshot(0, 0x100000));
    const car = st.cars[st.playerSlot];
    const camSeg = mem.u16(((mem.ds.u16(0x0971)) << 4) + mem.ds.u16(0x096f) + 0x1a);
    meta.caps.push({ name, view: st.view.mode, camSeg, inPit: car.inPit, speedMph: car.speedMph, paused: st.paused });
    log('cap', name, st.view.mode, 'camSeg', camSeg.toString(16), 'inPit', car.inPit, 'mph', car.speedMph);
    emu.ci.resume();
    await tap('p');
  }
  emu.ci.sendKeyEvent(key('a'), false);
  fs.writeFileSync(path.join(OUT, 'meta.json'), JSON.stringify(meta, null, 1));
} catch (e) { console.error(e); }
await emu.stop();
process.exit(0);
