// The Rust PC (lib/pc.mjs, dist/machine.wasm) in Node, without a browser:
// boots gp.exe from the site's bundle and drives lib/route.cjs to a Quick Race
// at the green lights, then reads the game's state with lib/f1gp-mem.mjs and
// lib/f1gp-state.mjs as the page does, and drives a few seconds with the
// accelerator held.
//
//   node build-machine.mjs && node probes/p6-pc-route.mjs [--cycles 20000] [--bundle dist/f1gp.jsdos]
//
// Output: out/p6-pc-route/ (screens at each step, result.json) and a summary.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { unzipSync } from 'fflate';
import { createPC, pcDriver } from '../lib/pc.mjs';
import { attach } from '../lib/f1gp-mem.mjs';
import { createReader } from '../lib/f1gp-state.mjs';
import { deflateSync } from 'node:zlib';

// a PNG of the screen (no browser needed: this probe runs in CI)
function encodePng(w, h, rgba) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const t = Buffer.from(type), len = Buffer.alloc(4), c = Buffer.alloc(4);
    len.writeUInt32BE(data.length); c.writeUInt32BE(crc(Buffer.concat([t, data])));
    return Buffer.concat([len, t, data, c]);
  };
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) Buffer.from(rgba.buffer, rgba.byteOffset + y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const require = createRequire(import.meta.url);
const route = require('../lib/route.cjs');
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const SPIKE = path.join(import.meta.dirname, '..');
const OUT = path.join(SPIKE, 'out', 'p6-pc-route');
fs.mkdirSync(OUT, { recursive: true });

const files = unzipSync(fs.readFileSync(path.resolve(SPIKE, opt('bundle', 'dist/f1gp.jsdos'))));
const pc = await createPC({ wasm: fs.readFileSync(path.join(SPIKE, 'dist', 'machine.wasm')), files, cyclesPerMs: +opt('cycles', 20000) });
const driver = pcDriver(pc, route.JSDOS_KEYS);
const t0 = Date.now();
const shots = [];
const shot = async (name) => {
  const s = await pc.screenshot();
  fs.writeFileSync(path.join(OUT, `${shots.length}-${name}.png`), encodePng(s.width, s.height, s.data));
  shots.push(name);
};
const result = {};
try {
  const info = await route.toTrack(driver, { mode: 'quickrace', log: (l) => console.log(`  [${(pc.now() / 1000).toFixed(1)} s game] ${l}`), onScreen: (s) => shot(s) });
  result.route = { ...info, gameSeconds: +(pc.now() / 1000).toFixed(1), hostSeconds: (Date.now() - t0) / 1000 };
  await shot('green');
  const mem = attach(pc, { requireGame: true });
  const reader = createReader(mem);
  const st0 = reader.read();
  const me0 = st0.cars[st0.view.viewedSlot];
  await driver.keyDown('a');
  await driver.sleep(5000);
  await driver.keyUp('a');
  const st1 = reader.read();
  const me1 = st1.cars[st1.view.viewedSlot];
  await shot('driving');
  // the AdLib race driver loaded (the page's Amiga sound hooks it: lib/dos-sound.mjs)
  const drv = mem.memBase + ((0x8ce6 + mem.imageSeg) << 4) + 0x0532;
  result.raceSoundDriver = Array.from(mem.heap().subarray(drv, drv + 6)).every((b, i) => b === [0x2e, 0xc6, 0x06, 0x79, 0x00, 0xff][i]);
  result.state = { memChecked: mem.checked, imageSeg: mem.imageSeg, inSession: st1.inSession, circuit: st1.session.circuit, cars: st1.cars.filter(Boolean).length,
    before: { mph: me0.speedMph, trackIndex: me0.trackIndex }, after: { mph: me1.speedMph, trackIndex: me1.trackIndex } };
} catch (e) {
  result.error = String(e.stack || e);
  await shot('error');
}
result.instructions = pc.instructions();
result.log = pc.log();
fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(result, null, 1));
console.log(JSON.stringify({ route: result.route, state: result.state, raceSoundDriver: result.raceSoundDriver, error: result.error?.split('\n')[0] }, null, 1));
// a check: the race reached, the game's state read, the car moved, the sound driver there
const ok = !result.error && result.state?.inSession && result.state.cars === 26 && result.state.after.mph > 50 && result.raceSoundDriver;
console.log(ok ? 'ok' : 'FAILED');
process.exit(ok ? 0 : 1);
