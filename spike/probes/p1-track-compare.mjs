// p1-track-compare.mjs - compare every RAM dump in out/p1-track/*/ with the
// compiled track and pit lane of the circuit it holds.
//   node probes/p1-track-compare.mjs
// Writes out/p1-track/segments-vs-game.json.
import fs from 'node:fs';
import path from 'node:path';
import { compiledFor, compareLive, identify } from './p1-track-lib.mjs';

const HERE = import.meta.dirname;
const OUT = path.join(HERE, '..', 'out', 'p1-track');
const GAME = path.join(HERE, '..', '..', 'original');
const compiled = [];
for (let i = 1; i <= 16; i++) compiled.push(compiledFor(new Uint8Array(fs.readFileSync(path.join(GAME, `f1ct${String(i).padStart(2, '0')}.dat`)))));
const rows = [];
for (const d of fs.readdirSync(OUT).sort()) {
  const dir = path.join(OUT, d);
  if (!fs.existsSync(path.join(dir, 'meta.json'))) continue;
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
  if (!meta.trackSeg) continue;
  for (const f of ['ram-green.bin', 'ram-pits.bin', 'ram-after.bin', 'ram-end.bin']) {
    if (!fs.existsSync(path.join(dir, f))) continue;
    const ram = new Uint8Array(fs.readFileSync(path.join(dir, f)));
    const id = identify(ram, meta, compiled);
    const res = compareLive(ram, meta, compiled[id.file - 1]);
    const row = { run: d, dump: f, mode: meta.mode, circuit: id.name, file: id.file, idScore: +id.score.toFixed(4), lapSegsSS015C: meta.nSegs, compiledTlu: compiled[id.file - 1].segs.length, pitSide: compiled[id.file - 1].track.header.pitSide, ...res };
    rows.push(row);
    console.log(`${d.padEnd(22)} ${f.padEnd(13)} ${id.name.padEnd(17)} track ${res.track.exact}/${res.track.n} exact (max xy ${res.track.maxXY}, side mism ${res.track.sideMismatch})  pit n ${res.pit.n} max ${res.pit.maxXY} p95 ${res.pit.p95XY} fine, angle ${res.pit.maxAngle}, side mism ${res.pit.sideMismatch}  swapped ${res.swapped} unknown ${res.unknown}`);
  }
}
fs.writeFileSync(path.join(OUT, 'segments-vs-game.json'), JSON.stringify(rows, null, 1));
