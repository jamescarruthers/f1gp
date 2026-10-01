// Check lib/objects.mjs against the game on RAM captures paired with the
// game's screenshot (taken while paused, e.g. out/research-phase2/static/cap/s2):
// rebuild the track and the trackside objects from the RAM, draw them at
// 320x200 from the game's camera, and compare pixel colours with the game's
// frame inside the areas our objects cover (see probes/p2-objects-lib.mjs).
//
//   node probes/p2-objects-check.mjs <capture dir> [name ...] [--mode game|mesh|meshr] [--out DIR] [--json FILE]
//
// Writes <out>/<name>-objects[-mode].png: the game's frame | ours | the pixels
// that differ (red: inside our objects, dark red: elsewhere, grey: left out) |
// the object mask (white: same colour as the game, red: different, blue: crowd).

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fromRam } from '../lib/f1gp-mem.mjs';
import { createReader } from '../lib/f1gp-state.mjs';
import { decodePng } from '../lib/png.mjs';
import { checkFrame } from './p2-objects-lib.mjs';

const require = createRequire(import.meta.url);
const { encodePng } = require('../lib/node-emu.cjs');

const args = process.argv.slice(2);
const opt = { out: null, json: null, mode: 'game' };
const pos = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--out') opt.out = args[++i];
  else if (args[i] === '--json') opt.json = args[++i];
  else if (args[i] === '--mode') opt.mode = args[++i];
  else pos.push(args[i]);
}
const dir = pos[0];
const outDir = opt.out ?? dir;
fs.mkdirSync(outDir, { recursive: true });
const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
const names = pos.slice(1).length ? pos.slice(1) : fs.readdirSync(dir).filter((f) => f.endsWith('.ram')).map((f) => f.slice(0, -4)).sort();
const results = [];
for (const name of names) {
  const mem = fromRam(new Uint8Array(fs.readFileSync(path.join(dir, `${name}.ram`))), { imageSeg: meta.imageSeg });
  const game = decodePng(fs.readFileSync(path.join(dir, `${name}.png`)));
  const st = createReader(mem).read();
  const { result, sheet } = checkFrame({ mem, st, game, detail: mem.ds.u8(0x0068), fromMemory: true, mode: opt.mode });
  fs.writeFileSync(path.join(outDir, `${name}-objects${opt.mode === 'game' ? '' : '-' + opt.mode}.png`), encodePng(1280, 200, sheet, 4));
  const r = { name, ...result };
  results.push(r);
  console.log(JSON.stringify(r));
}
if (opt.json) fs.writeFileSync(opt.json, JSON.stringify(results, null, 1));
