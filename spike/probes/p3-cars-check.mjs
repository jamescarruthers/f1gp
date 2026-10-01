// Check lib/cars.mjs against the game on RAM captures paired with the game's
// screenshot (taken while paused): rebuild the track, the trackside objects
// and the cars from the RAM, draw them at 320x200 from the game's camera and
// compare pixel colours with the game's frame inside the pixels our cars
// cover (see probes/p3-cars-lib.mjs).
//
//   node probes/p3-cars-check.mjs <capture dir> [name ...] [--mode game|mesh] [--out DIR] [--json FILE]
//        [--hist K]   use the car records and camera of history entry K (<name>.hist.json,
//                     written by probes/p3-cars-capture.mjs) instead of the RAM's
//
// Writes <out>/<name>-cars[-mode].png: game | ours | diff | car mask (white/red:
// polygon cars same/different, light blue/magenta: far bitmaps, green/orange: effect shapes).

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fromRam } from '../lib/f1gp-mem.mjs';
import { createReader } from '../lib/f1gp-state.mjs';
import { decodePng } from '../lib/png.mjs';
import { drawFrame, compareCars, sheet } from './p3-cars-lib.mjs';

const require = createRequire(import.meta.url);
const { encodePng } = require('../lib/node-emu.cjs');

const args = process.argv.slice(2);
const opt = { out: null, json: null, mode: 'game', hist: null, tol: 0.03, ablate: null };
const pos = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--out') opt.out = args[++i];
  else if (args[i] === '--json') opt.json = args[++i];
  else if (args[i] === '--mode') opt.mode = args[++i];
  else if (args[i] === '--hist') opt.hist = +args[++i];
  else if (args[i] === '--tol') opt.tol = +args[++i];
  else if (args[i] === '--ablate') opt.ablate = args[++i];
  else pos.push(args[i]);
}
const dir = pos[0];
const outDir = opt.out ?? dir;
fs.mkdirSync(outDir, { recursive: true });
const metaFile = path.join(dir, 'meta.json');
const meta = fs.existsSync(metaFile) ? JSON.parse(fs.readFileSync(metaFile, 'utf8')) : {};
const names = pos.slice(1).length ? pos.slice(1) : fs.readdirSync(dir).filter((f) => f.endsWith('.ram')).map((f) => f.slice(0, -4)).sort();

/** Patch a RAM copy with one history entry: car records and camera words of an earlier frame. */
export function spliceHistory(ram, mem, h) {
  const out = ram.slice();
  for (const [lin, bytes] of h.blocks) out.set(Uint8Array.from(Buffer.from(bytes, 'base64')), lin);
  void mem;
  return out;
}

const results = [];
const tot = { near: [0, 0], far: [0, 0], effect: [0, 0], mirror: [0, 0] };
for (const name of names) {
  let ram = new Uint8Array(fs.readFileSync(path.join(dir, `${name}.ram`)));
  let mem = fromRam(ram, { imageSeg: meta.imageSeg });
  const histFile = path.join(dir, `${name}.hist.json`);
  let used = 'ram';
  if (opt.hist !== null && fs.existsSync(histFile)) {
    const hist = JSON.parse(fs.readFileSync(histFile, 'utf8'));
    const h = hist.entries[hist.entries.length - 1 - opt.hist];
    if (h) { ram = spliceHistory(ram, mem, h); mem = fromRam(ram, { imageSeg: meta.imageSeg }); used = `hist-${opt.hist} (frame ${h.frame})`; }
  }
  const game = decodePng(fs.readFileSync(path.join(dir, `${name}.png`)));
  const st = createReader(mem).read();
  const fr = drawFrame({ mem, st, carMode: opt.mode, carTol: opt.tol, ablate: opt.ablate });
  const frNo = drawFrame({ mem, st, carMode: 'none' });
  const cmp = compareCars(game, fr, { without: frNo.ours });
  fs.writeFileSync(path.join(outDir, `${name}-cars${opt.mode === 'game' ? '' : '-' + opt.mode}.png`), encodePng(1280, 200, sheet(game, fr), 4));
  const pct = (b) => (b.px ? +(100 * b.same / b.px).toFixed(1) : null);
  const r = {
    name, used, view: st.view.mode, mode: opt.mode, drawn: fr.cars.length,
    near: { ...cmp.near, pct: pct(cmp.near) }, far: { ...cmp.far, pct: pct(cmp.far) }, effect: { ...cmp.effect, pct: pct(cmp.effect) }, mirror: { ...cmp.mirror, pct: pct(cmp.mirror) },
    box: { ...cmp.box, pctWith: +(100 * cmp.box.sameWith / Math.max(cmp.box.px, 1)).toFixed(1), pctWithout: +(100 * cmp.box.sameWithout / Math.max(cmp.box.px, 1)).toFixed(1) },
    perCar: cmp.perCar.map((q) => ({ slot: q.slot, kind: q.kind === 1 ? 'polygons' : q.kind === 2 ? 'bitmap' : 'effect', depthFt: q.depth8 !== undefined ? +(q.depth8 / 8).toFixed(1) : null, px: q.px, pct: q.pct })),
    unexplained: cmp.unexplained,
    mirrors: fr.mirrors.map((m) => ({ slot: m.slot, side: m.side, x: m.x, id: m.id })),
  };
  for (const k of ['near', 'far', 'effect', 'mirror']) { tot[k][0] += cmp[k].px; tot[k][1] += cmp[k].same; }
  results.push(r);
  console.log(`${name} ${r.view} drawn ${r.drawn} near ${r.near.same}/${r.near.px} (${r.near.pct}%) far ${r.far.same}/${r.far.px} (${r.far.pct}%) effect ${r.effect.same}/${r.effect.px} mirror ${r.mirror.same}/${r.mirror.px} unexpl ${r.unexplained} box ${r.box.pctWithout}% -> ${r.box.pctWith}% ${used}`);
}
console.log('TOTAL', Object.entries(tot).map(([k, [px, same]]) => `${k} ${same}/${px} (${px ? (100 * same / px).toFixed(1) : '-'}%)`).join('  '));
if (opt.json) fs.writeFileSync(opt.json, JSON.stringify({ results, total: tot }, null, 1));
