// Which keys do what in a race: start a Monza Quick Race, then for each key
// press it, wait, and press it again, and log the game's variables (DS and
// SS) that the presses toggle: a byte that held still for 2 s, changed with
// the first press and went back with the second. The cars' records are left
// out. The driving aids (SS:1220) are logged for every key.
//
//   timeout 600 node probes/p5-keys.mjs [--bundle dist/node-adlib-intro.jsdos] [--keys f1,f2,...]
//
// Output, out/p5-keys/: keys.json ({ key: { toggles: [{ at, before, pressed }], aids: [before, pressed, again] } }),
// <key>-1.png and <key>-2.png (the screen after each press).

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { attach } from '../lib/f1gp-mem.mjs';
import { createReader } from '../lib/f1gp-state.mjs';

const require = createRequire(import.meta.url);
const { start, sleep, encodePng } = require('../lib/node-emu.cjs');
const route = require('../lib/route.cjs');
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const BUNDLE = opt('bundle', 'dist/node-adlib-intro.jsdos');
// GLFW key codes (js-dos) beyond route.JSDOS_KEYS
const MORE = { insert: 260, delete: 261, pageup: 266, pagedown: 267, home: 268, end: 269, minus: 45, equal: 61,
  bracketleft: 91, backslash: 92, bracketright: 93, semicolon: 59, apostrophe: 39, grave: 96, f11: 300, f12: 301 };
const code = (k) => route.JSDOS_KEYS[k] ?? MORE[k];
// the driving keys, the views, pause and the menu are known; Esc, P and Q go last or not at all
const DEFAULT = ['f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8', 'f9', 'f10', 'f11', 'f12',
  'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm', 'n', 'o', 'r', 's', 't', 'u', 'v', 'w', 'x', 'y',
  '1', '2', '3', '4', '5', '6', '7', '8', '9', '0', 'tab', 'backspace', 'insert', 'end', 'pageup',
  'minus', 'equal', 'bracketleft', 'bracketright', 'semicolon', 'apostrophe', 'slash', 'backslash', 'grave', 'enter'];
const KEYS = (opt('keys', '') || DEFAULT.join(',')).split(',');
const OUT = path.join(import.meta.dirname, '..', 'out', 'p5-keys');
fs.mkdirSync(OUT, { recursive: true });
const log = (...m) => console.log(m.join(' '));

const emu = await start(path.resolve(BUNDLE));
const drv = route.nodeDriver(emu);
await route.toTrack(drv, { mode: 'quickrace', log: () => {} });
const mem = attach(emu.ci, { requireGame: true });
const reader = createReader(mem);
const H = () => mem.heap();
const ds = mem.memBase + (mem.DS << 4), ss = mem.memBase + (mem.SS << 4);
const snap = () => ({ ds: H().slice(ds, ds + 0x10000), ss: H().slice(ss, ss + 0x10000) });
const CARS = [0x0d1b, 0x0d1b + 26 * 0xc0];
const shot = async (name) => { const img = await drv.screenshot(); fs.writeFileSync(path.join(OUT, `${name}.png`), encodePng(img.width, img.height, img.data, 4)); };
const tap = async (k) => { emu.ci.sendKeyEvent(code(k), true); await sleep(150); emu.ci.sendKeyEvent(code(k), false); await sleep(700); };
const result = {};
for (const k of KEYS) {
  if (code(k) === undefined) { log(k, 'no code'); continue; }
  // stable: the same at three reads over 2 s; a toggle: changed by the first press, back after the second
  const s0 = snap(); await sleep(1000); const s0b = snap(); await sleep(1000); const s1 = snap();
  await tap(k); const s2 = snap(); await shot(`${k}-1`);
  await tap(k); const s3 = snap(); await shot(`${k}-2`);
  const found = [];
  for (const [seg, name] of [['ds', 'DS'], ['ss', 'SS']]) {
    for (let i = 0; i < 0x10000; i++) {
      if (seg === 'ds' && i >= CARS[0] && i < CARS[1]) continue;
      const v = s1[seg][i];
      if (s0[seg][i] !== v || s0b[seg][i] !== v) continue;
      if (s2[seg][i] === v || s3[seg][i] !== v) continue;
      found.push({ at: `${name}:${i.toString(16).toUpperCase().padStart(4, '0')}`, before: v, pressed: s2[seg][i] });
    }
  }
  const st = reader.read();
  result[k] = { toggles: found.slice(0, 40), count: found.length, aids: [s1.ss[0x1220], s2.ss[0x1220], s3.ss[0x1220]], inSession: st.inSession, paused: st.paused, view: st.view.mode };
  log(k, 'aids', result[k].aids.map((v) => v.toString(16)).join('>'), found.length, JSON.stringify(found.slice(0, 10)));
  fs.writeFileSync(path.join(OUT, 'keys.json'), JSON.stringify(result, null, 1));
  if (!st.inSession) { log('left the session at', k); break; }
}
process.exit(0);
