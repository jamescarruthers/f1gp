// p1-camera-tick.cjs - frame-tick analysis of a p1-camera recording.
//   node probes/p1-camera-tick.cjs RUN [from_s=0] [to_s=end]
// 1. From the fast log (polled every ~2 ms): when DS:2955 changes (a new game
//    frame), the real time between frames, the 300 Hz counter SS:05D2 per
//    frame, DS:2955 / DS:294F increments per frame, SS:05C8 at the change.
// 2. Blind search over the frame records (type 1) for words that step by
//    exactly +1 (or -1) per frame, and for words that step by a constant.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const L = require('./p1-camera-lib.cjs');

const [run, fromArg = '0', toArg = '1e9'] = process.argv.slice(2);
const T0 = Number(fromArg) * 1000, T1 = Number(toArg) * 1000;
const dir = path.join(__dirname, '..', 'out', 'p1-camera', run);
const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json')));
const fast = L.openFast(path.join(dir, 'fast.bin')).filter((f) => f.t >= T0 && f.t < T1);

// ---- 1. fast log
const frames = [];
for (let i = 1; i < fast.length; i++) if (fast[i].clk !== fast[i - 1].clk) frames.push(fast[i]);
const stats = (v) => {
  if (!v.length) return null;
  const s = [...v].sort((a, b) => a - b);
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  return { n: v.length, min: s[0], p10: s[Math.floor(s.length * 0.1)], med: s[s.length >> 1], p90: s[Math.floor(s.length * 0.9)], max: s[s.length - 1], mean: +mean.toFixed(3) };
};
const dReal = [], dTick = [], dClk = [], dTim = [], c8 = [], c63 = [];
for (let i = 1; i < frames.length; i++) {
  dReal.push(frames[i].t - frames[i - 1].t);
  dTick.push((frames[i].tick - frames[i - 1].tick) & 0xffff);
  dClk.push(frames[i].clk - frames[i - 1].clk);
  dTim.push(frames[i].tim - frames[i - 1].tim);
  c8.push(frames[i].c8); c63.push(frames[i].c63);
}
const span = frames.length > 1 ? (frames[frames.length - 1].t - frames[0].t) / 1000 : 0;
const ticks = fast.length > 1 ? ((fast[fast.length - 1].tick - fast[0].tick) & 0xffff) : 0;
const realSpan = fast.length > 1 ? (fast[fast.length - 1].t - fast[0].t) / 1000 : 0;
// SS:05C8 resets: count drops in the fast log.
let flips = 0;
for (let i = 1; i < fast.length; i++) if (fast[i].c8 < fast[i - 1].c8) flips++;
const out = {
  run, window: [T0 / 1000, Math.min(T1, fast.length ? fast[fast.length - 1].t : 0) / 1000],
  framesSeen: frames.length, framesPerRealSec: +((frames.length - 1) / span).toFixed(3),
  tick300PerRealSec: +(ticks / realSpan).toFixed(2), ss05C8Resets: flips, ss05C8ResetsPerSec: +(flips / realSpan).toFixed(3),
  realMsPerFrame: stats(dReal), ticksPerFrame: stats(dTick), clk2955PerFrame: stats(dClk), tim294FPerFrame: stats(dTim),
  ss05C8AtFrameChange: stats(c8), ds2C63AtFrameChange: stats(c63),
  gameMsPerRealSec: +(((frames[frames.length - 1]?.clk ?? 0) - (frames[0]?.clk ?? 0)) / span).toFixed(1),
};
console.log(JSON.stringify(out, null, 1));

// ---- 2. blind search over frame records
const { L: lay, recs } = L.openRec(path.join(dir, 'rec.bin'), meta.imageSeg);
const fr = recs.filter((r) => r.type === 1 && r.t >= T0 && r.t < T1);
// Only consecutive frame records whose DS:2955 differs by one frame period
// (no missed frame in between).
const per = out.clk2955PerFrame ? out.clk2955PerFrame.med : 0;
const pairs = [];
for (let k = 1; k < fr.length; k++) {
  const d = fr[k].d32(0x2955) - fr[k - 1].d32(0x2955);
  if (Math.abs(d - per) <= 1) pairs.push([fr[k - 1], fr[k]]);
}
const name = (i) => (i < lay.ssOff ? `DS:${L.hex(i)}` : `SS:${L.hex(i - lay.ssOff)}`);
const res = [];
for (let i = 0; i + 1 < lay.len; i++) {
  const hist = new Map();
  for (const [a, b] of pairs) {
    const d = (b.r.readUInt16LE(i) - a.r.readUInt16LE(i)) & 0xffff;
    hist.set(d, (hist.get(d) || 0) + 1);
    if (hist.size > 3) break;
  }
  if (hist.size > 3) continue;
  const [[d, c]] = [...hist].sort((x, y) => y[1] - x[1]);
  if (d === 0 || c < pairs.length * 0.97) continue;
  res.push({ at: name(i), step: d >= 0x8000 ? d - 0x10000 : d, frac: +(c / pairs.length).toFixed(3) });
}
console.log(`frame pairs: ${pairs.length}; words that change by one constant step in >=97% of frames:`);
for (const r of res) console.log(`  ${r.at} step ${r.step} (${r.frac})`);
