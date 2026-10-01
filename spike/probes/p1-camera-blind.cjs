// p1-camera-blind.cjs - blind memory diffing of a p1-camera recording: find
// the bytes (and words) of DS / SS whose changes coincide with the scripted
// key events, without assuming any address.
//
//   node probes/p1-camera-blind.cjs RUN [window_ms=700] [actions=left,right,...]
//
// For every byte of the region it lists the records at which the byte
// changed. A byte is reported when it changed within window_ms after at least
// one selected event, and never (or only rarely) outside those windows.
// Output: one line per candidate, grouped into runs of adjacent bytes, with
// the value it had in each phase between events.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const L = require('./p1-camera-lib.cjs');

const [run, winArg = '700', actArg = ''] = process.argv.slice(2);
const WIN = Number(winArg);
const dir = path.join(__dirname, '..', 'out', 'p1-camera', run);
const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json')));
const { L: lay, recs } = L.openRec(path.join(dir, 'rec.bin'), meta.imageSeg);
const acts = actArg ? actArg.split(',') : null;
const events = meta.events.filter((e) => e.action === 'tap' && (!acts || acts.includes(e.arg)));
const evIdx = (t) => { for (let i = events.length - 1; i >= 0; i--) if (t >= events[i].t && t < events[i].t + WIN) return i; return -1; };
const tEnd = acts && acts.includes('esc') ? Infinity : (meta.events.find((e) => e.arg === 'esc') || { t: Infinity }).t; // stop before the menu

const n = lay.len;
const inside = new Uint32Array(n), outside = new Uint32Array(n);
const hitEv = Array.from({ length: n }, () => null);
let used = 0;
for (let k = 1; k < recs.length; k++) {
  const a = recs[k - 1].r, b = recs[k].r, t = recs[k].t;
  if (t > tEnd) break;
  used++;
  const e = evIdx(t);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) {
      if (e >= 0) { inside[i]++; (hitEv[i] || (hitEv[i] = new Set())).add(e); } else outside[i]++;
    }
  }
}

const name = (i) => (i < lay.ssOff ? `DS:${L.hex(i)}` : `SS:${L.hex(i - lay.ssOff)}`);
const cands = [];
for (let i = 0; i < n; i++) {
  if (!hitEv[i]) continue;
  const evs = hitEv[i].size;
  if (outside[i] > 2) continue;
  cands.push({ i, evs, inside: inside[i], outside: outside[i] });
}
// Value of a byte in the middle of each phase (between events).
const phaseVals = (i) => {
  const out = [];
  const bounds = [0, ...events.map((e) => e.t), Math.min(tEnd, recs[recs.length - 1].t)];
  for (let p = 0; p + 1 < bounds.length; p++) {
    const mid = bounds[p + 1] - 200; // just before the next event
    let best = null;
    for (const r of recs) { if (r.t <= mid) best = r; else break; }
    out.push(best ? L.hex(best.r[i], 2) : '--');
  }
  return out.join(' ');
};
console.log(`records used ${used}, events: ${events.map((e) => `${(e.t / 1000).toFixed(1)}:${e.arg}`).join(' ')}`);
console.log(`candidates (changed after >=1 event, <=2 changes elsewhere): ${cands.length}`);
cands.sort((x, y) => y.evs - x.evs || x.i - y.i);
for (const c of cands.slice(0, 200)) {
  console.log(`${name(c.i).padEnd(8)} events ${String(c.evs).padStart(2)}/${events.length} changes in ${c.inside} out ${c.outside} | ${phaseVals(c.i)}`);
}
