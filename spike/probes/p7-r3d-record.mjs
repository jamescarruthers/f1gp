// A session for machine/src/bin/r3d.rs: the game on our PC in Node, from boot through the route to
// a Quick Race (lib/route.cjs), then driven by the autopilot (lib/autopilot.mjs) through the
// cockpit, the chase view and the TV view, the game drawing its own 3D view at 30 fps. Every
// machine call is recorded (lib/pc.mjs `record`), with a mark where the race starts, so that the
// native machine can play it again instruction for instruction and catch the 3D routine's frames.
//
//   node build-machine.mjs && node probes/p7-r3d-record.mjs [--circuit Monza] [--seconds 12] [--out out/r3d/monza.ops]
//
// --circuit: a Quick Race is at Monza; another circuit is a practice session there (route.cjs).

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { unzipSync } from 'fflate';
import { createPC, pcDriver } from '../lib/pc.mjs';
import { attach } from '../lib/f1gp-mem.mjs';
import { createReader } from '../lib/f1gp-state.mjs';
import { startAutopilot } from '../lib/autopilot.mjs';

const require = createRequire(import.meta.url);
const route = require('../lib/route.cjs');
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const SPIKE = path.join(import.meta.dirname, '..');
const CIRCUIT = opt('circuit', 'Monza'), SECONDS = +opt('seconds', 12);
const OUT = path.resolve(SPIKE, opt('out', `out/r3d/${CIRCUIT.toLowerCase().replace(/\W+/g, '-')}.ops`));
fs.mkdirSync(path.dirname(OUT), { recursive: true });

const record = [];
const pc = await createPC({ wasm: fs.readFileSync(path.join(SPIKE, 'dist', 'machine.wasm')), files: unzipSync(fs.readFileSync(path.join(SPIKE, 'dist', 'f1gp.jsdos'))), cyclesPerMs: 25000, record });
const driver = pcDriver(pc, route.JSDOS_KEYS);
let mem = null;
// the game at 30 fps, as the page sets it (SS:1230 = 10 ticks of 300 Hz a frame)
const setRate = () => {
  if (!mem) { try { mem = attach(pc, { requireGame: true }); } catch { return; } }
  const lin = (mem.SS << 4) + 0x1230, H = mem.heap();
  if ((H[mem.memBase + lin] | (H[mem.memBase + lin + 1] << 8)) !== 10) pc.write(lin, [10, 0]);
};
const quick = CIRCUIT.toLowerCase() === 'monza';
await route.toTrack(driver, { mode: quick ? 'quickrace' : 'practice', circuit: quick ? undefined : CIRCUIT, log: (l) => console.log(`  [${(pc.now() / 1000).toFixed(1)} s] ${l}`), onScreen: async (s) => { if (s !== 'race') setRate(); } });
if (!mem) mem = attach(pc, { requireGame: true });
record.push('p');

// the autopilot, on a stand-in for the page's window: its step runs after each machine step
const steps = [];
const win = { renderApp: { mem, reader: createReader(mem) }, emuCi: pc, setInterval: (f) => { steps.push(f); return steps.length; }, clearInterval: () => {} };
const ap = startAutopilot(win, { pollMs: 8 });
const drive = (s) => { for (let t = 0; t < s * 1000; t += 1000 / 60) { pc.run(1000 / 60); for (const f of steps) f(); } };
const tap = (code) => { pc.sendKeyEvent(code, true); drive(0.15); pc.sendKeyEvent(code, false); };
drive(SECONDS);              // cockpit
tap(267);                    // Page Down: the chase view
drive(SECONDS);
tap(263);                    // left arrow: the TV view
drive(SECONDS);
ap.stop();
const st = win.renderApp.reader.read();
const me = st.cars[st.playerSlot];
const sum = (a) => a.reduce((x, y) => (Math.imul(x, 31) + y) >>> 0, 0);
record.push(`e ${pc.instructions()} ${sum(pc.screen())} ${sum(pc.ram().subarray(0, 0x110000))}`);
fs.writeFileSync(OUT, record.join('\n') + '\n');
console.log(`${record.length} calls to ${path.relative(SPIKE, OUT)}; the car at ${me.speedMph} mph, lap ${me.lap}, segment ${me.trackIndex}; view ${st.view.mode}`);
