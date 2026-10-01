// p1-camera-physics.cjs - how far cars move per game frame, against their
// speed, in a p1-camera recording. Tells whether physics steps once per
// displayed frame with dt = frame period (distance per frame grows at lower
// frame rates) or on a fixed tick.
//   node probes/p1-camera-physics.cjs RUN [from_s] [to_s]
// Player: world X/Y (+28/+2C, 1/16384 ft) deltas between consecutive frames.
// AI cars (track mode): distance along the track from segment index (+12,
// 0x2E bytes per 16 ft segment) and +1C (1/64 ft within the segment).
// Speed +10 is 1/64 ft/s (mph = v * 0x2BA / 0x10000).
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const L = require('./p1-camera-lib.cjs');

const [run, fromArg = '0', toArg = '1e9'] = process.argv.slice(2);
const dir = path.join(__dirname, '..', 'out', 'p1-camera', run);
const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json')));
const { recs } = L.openRec(path.join(dir, 'rec.bin'), meta.imageSeg);
const fr = recs.filter((r) => r.type === 1 && r.t >= fromArg * 1000 && r.t < toArg * 1000);
const k0 = L.clockState(fr[0]);
const per = Math.round((k0.ticksFrame * 1000) / 300);
const med = (v) => { const s = [...v].sort((a, b) => a - b); return s.length ? s[s.length >> 1] : null; };
const mean = (v) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : null);

const pl = [], ai = [], plSpeed = [], aiSpeed = [];
let lapLen = null;
for (let k = 1; k < fr.length; k++) {
  const a = fr[k - 1], b = fr[k];
  const dClk = b.d32(0x2955) - a.d32(0x2955);
  if (Math.abs(dClk - per) > 1) continue; // a missed or torn frame
  for (let i = 0; i < L.NCARS; i++) {
    const ca = L.car(a, i), cb = L.car(b, i);
    const v = (ca.speed + cb.speed) / 2 / 64; // ft/s, mean over the step
    if (v < 30) continue; // ignore slow / stopped cars
    if ((ca.m7e & 1) && (cb.m7e & 1)) {
      const d = Math.hypot(cb.X - ca.X, cb.Y - ca.Y) / 16384;
      pl.push(d / v); plSpeed.push(v);
    } else if (!(ca.m7e & 1) && !(cb.m7e & 1) && ca.segSeg === cb.segSeg) {
      const ds = (cb.segOff - ca.segOff) / 0x2e;
      if (ds < 0 || ds > 3) continue; // lap wrap or pit switch
      const d = (ds * 1024 + (cb.along - ca.along)) / 64;
      ai.push(d / v); aiSpeed.push(v);
    }
  }
}
const out = {
  run, frames: fr.length, ticksPerFrame: k0.ticksFrame, fps: +(300 / k0.ticksFrame).toFixed(2),
  framePeriodS: +(k0.ticksFrame / 300).toFixed(4),
  dt: { 'DS:2C59 player': L.hex(k0.dtP), 'DS:2C5B': L.hex(k0.dtP2), 'DS:2C5D AI': L.hex(k0.dtAI), 'DS:2C5F half': L.hex(k0.half, 2), 'DS:2C61 fps': k0.fps,
    'DS:2C5D as s': +(k0.dtAI / 65536).toFixed(4), 'DS:2C59 as s': +(k0.dtP / 65536).toFixed(4), 'DS:2241 frame ms (16.16?)': L.hex(k0.frameMs, 8) },
  player: { steps: pl.length, medianFtPerFramePerFtPerS: med(pl) && +med(pl).toFixed(4), meanRatio: mean(pl) && +mean(pl).toFixed(4), medianSpeedMph: med(plSpeed) && +(med(plSpeed) / 1.4667).toFixed(1) },
  ai: { steps: ai.length, medianFtPerFramePerFtPerS: med(ai) && +med(ai).toFixed(4), meanRatio: mean(ai) && +mean(ai).toFixed(4), medianSpeedMph: med(aiSpeed) && +(med(aiSpeed) / 1.4667).toFixed(1) },
};
console.log(JSON.stringify(out, null, 1));
