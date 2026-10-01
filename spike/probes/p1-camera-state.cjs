// p1-camera-state.cjs - find bytes that tell two game states apart in a
// p1-camera recording: every record in time range A has values that never
// occur in range B (and A is constant). Used for "paused" and "in a menu".
//
//   node probes/p1-camera-state.cjs RUN A0-A1 B0-B1[,B2-B3...] [maxPrint]
// Times in seconds after the green light.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const L = require('./p1-camera-lib.cjs');

const [run, aArg, bArg, maxArg = '80'] = process.argv.slice(2);
const dir = path.join(__dirname, '..', 'out', 'p1-camera', run);
const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json')));
const { L: lay, recs } = L.openRec(path.join(dir, 'rec.bin'), meta.imageSeg);
const rng = (s) => s.split(',').map((x) => x.split('-').map((v) => Number(v) * 1000));
const inR = (t, rs) => rs.some(([a, b]) => t >= a && t < b);
const A = recs.filter((r) => inR(r.t, rng(aArg))), B = recs.filter((r) => inR(r.t, rng(bArg)));
console.log(`A: ${A.length} records, B: ${B.length} records`);
const name = (i) => (i < lay.ssOff ? `DS:${L.hex(i)}` : `SS:${L.hex(i - lay.ssOff)}`);
const out = [];
for (let i = 0; i < lay.len; i++) {
  const va = A[0].r[i];
  if (!A.every((r) => r.r[i] === va)) continue;
  const vb = new Set(B.map((r) => r.r[i]));
  if (vb.has(va)) continue;
  out.push({ i, va, vb: [...vb].sort((x, y) => x - y) });
}
console.log(`bytes constant in A with a value never seen in B: ${out.length}`);
// Prefer bytes that are also constant (or nearly) in B: a clean flag.
out.sort((x, y) => x.vb.length - y.vb.length || x.i - y.i);
for (const o of out.slice(0, Number(maxArg))) {
  console.log(`${name(o.i).padEnd(8)} A=${L.hex(o.va, 2)}  B=${o.vb.slice(0, 8).map((v) => L.hex(v, 2)).join(',')}${o.vb.length > 8 ? ` (+${o.vb.length - 8})` : ''}`);
}
