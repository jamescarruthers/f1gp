// Check lib/objects.mjs on all 16 circuits without new emulator runs: the
// reference frames of out/p2-ref (practice sessions, paused, with the exact
// camera state; probes/p2-capture.cjs) and, for the objects and the track,
// the practice RAM dump of the same circuit (out/p1-track/prac-*/ram-pits.bin,
// taken in the pit garage of a practice session: same track file, shapes,
// settings, palettes and bitmaps). Only frames with the car stopped (the
// screen then shows the frame the stored camera describes).
//
//   node probes/p2-objects-ref.mjs [NN ...] [--mode game|mesh|meshr] [--out DIR] [--json FILE] [--max N]
//
// Writes <out>/<NN>-<k>-objects.png (layout as probes/p2-objects-check.mjs) and
// prints one JSON line per frame and a summary per circuit.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fromRam } from '../lib/f1gp-mem.mjs';
import { decodePng } from '../lib/png.mjs';
import { checkFrame } from './p2-objects-lib.mjs';

const require = createRequire(import.meta.url);
const { encodePng } = require('../lib/node-emu.cjs');

const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
const args = process.argv.slice(2);
const opt = { out: path.join(ROOT, 'out', 'research-phase2', 'objects', 'ref'), json: null, mode: 'game', max: 99 };
const want = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--out') opt.out = args[++i];
  else if (args[i] === '--json') opt.json = args[++i];
  else if (args[i] === '--mode') opt.mode = args[++i];
  else if (args[i] === '--max') opt.max = +args[++i];
  else want.push(args[i].padStart(2, '0'));
}
const PRAC = { '01': 'united-states', '02': 'brazil', '03': 'san-marino', '04': 'monaco', '05': 'canada', '06': 'mexico', '07': 'france', '08': 'great-britain',
  '09': 'germany', 10: 'hungary', 11: 'belgium', 12: 'italy', 13: 'portugal', 14: 'spain', 15: 'japan', 16: 'australia' };
fs.mkdirSync(opt.out, { recursive: true });
const all = [];
for (const NN of Object.keys(PRAC).map((k) => String(k).padStart(2, '0'))) {
  if (want.length && !want.includes(NN)) continue;
  const ramFile = path.join(ROOT, 'out', 'p1-track', `prac-${PRAC[+NN] ?? PRAC[NN]}`, 'ram-pits.bin');
  const refDir = path.join(ROOT, 'out', 'p2-ref', NN);
  if (!fs.existsSync(ramFile) || !fs.existsSync(refDir)) { console.log(NN, 'missing data'); continue; }
  const metaFile = path.join(path.dirname(ramFile), 'meta.json');
  const imageSeg = JSON.parse(fs.readFileSync(metaFile, 'utf8')).imageSeg ?? 0x1a2;
  const mem = fromRam(new Uint8Array(fs.readFileSync(ramFile)), { imageSeg });
  const frames = fs.readdirSync(refDir).filter((f) => /^\d+\.json$/.test(f)).sort();
  const rows = [];
  for (const f of frames) {
    if (rows.length >= opt.max) break;
    const rec = JSON.parse(fs.readFileSync(path.join(refDir, f), 'utf8'));
    if (rec.moving || !rec.stateUnchangedWhilePaused || rec.texture?.toggledFromDefault) continue;
    const k = f.slice(0, -5);
    const game = decodePng(fs.readFileSync(path.join(refDir, `${k}.png`)));
    const { result, sheet } = checkFrame({ mem, st: rec.state, game, detail: rec.detail?.level ?? 3, fromMemory: false, mode: opt.mode });
    fs.writeFileSync(path.join(opt.out, `${NN}-${k}-objects${opt.mode === 'game' ? '' : '-' + opt.mode}.png`), encodePng(1280, 200, sheet, 4));
    const r = { circuit: NN, name: rec.circuitName, k, label: rec.label, ...result };
    rows.push(r);
    all.push(r);
    console.log(JSON.stringify(r));
  }
  const px = rows.reduce((s, r) => s + r.objectPixels, 0), same = rows.reduce((s, r) => s + r.objectSame, 0);
  const pcts = rows.filter((r) => r.objectPixels >= 200).map((r) => r.objectSamePct).sort((a, b) => a - b);
  console.log(`# ${NN} ${rows[0]?.name ?? ''}: ${rows.length} frames, object pixels ${px}, same ${(100 * same / Math.max(px, 1)).toFixed(1)}%, ` +
    `per-frame median ${pcts.length ? pcts[Math.floor(pcts.length / 2)] : '-'}% (frames with >= 200 object pixels: ${pcts.length})`);
}
if (opt.json) fs.writeFileSync(opt.json, JSON.stringify(all, null, 1));
