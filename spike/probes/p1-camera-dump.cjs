// p1-camera-dump.cjs - print a time series of the camera, view and clock
// variables of a p1-camera recording, one line per record (or every Nth).
//   node probes/p1-camera-dump.cjs RUN [every=1] [from_s] [to_s]
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const L = require('./p1-camera-lib.cjs');

const [run, every = '1', from = '0', to = '1e9'] = process.argv.slice(2);
const dir = path.join(__dirname, '..', 'out', 'p1-camera', run);
const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json')));
const { recs } = L.openRec(path.join(dir, 'rec.bin'), meta.imageSeg);
const h = L.hex;
let n = 0;
for (const r of recs) {
  if (r.t < from * 1000 || r.t > to * 1000) continue;
  if (n++ % Number(every)) continue;
  const c = L.camState(r), k = L.clockState(r);
  const sel = L.carAt(r, c.selCar), obj = L.carAt(r, c.camObj);
  console.log([
    (r.t / 1000).toFixed(3).padStart(7), r.type, `clk=${k.clk}`, `tim=${k.tim}`, `t300=${k.tick300}`, `flip=${k.sinceFlip}`,
    `v=${h(c.view, 2)}`, `obj=${h(c.camObj)}`, `sel=${h(c.selCar)}`,
    `cam=(${(c.camX / 16384).toFixed(1)},${(c.camY / 16384).toFixed(1)},z${c.sZ}) yaw=${h(c.camYaw)} p=${c.camPitch} hz=${c.horizon}`,
    `sel=(${(sel.X / 16384).toFixed(1)},${(sel.Y / 16384).toFixed(1)}) hd=${h(sel.heading)} id=${h(sel.id, 2)} 7e=${h(sel.m7e, 2)}`,
    `obj=(${(obj.X / 16384).toFixed(1)},${(obj.Y / 16384).toFixed(1)}) hd=${h(obj.heading)} o00=${h(r.d16(c.camObj))} 7e=${h(obj.m7e, 2)}`,
    `eye=${c.eye} 4d0=${c.d4d0}`,
  ].join(' '));
}
