// p1-track-fit.mjs - compare our compiled track with the game.
//   node probes/p1-track-fit.mjs [--tag qr1]
// Reads out/p1-track/<tag>/{ram-green.bin|ram-pits.bin, meta.json, frames.jsonl}
// and writes out/p1-track/<tag>/fit.json and map.png (map.svg).
//  1. every segment of the in-memory track array (and the pit-lane array)
//     against compileTrack() / compilePitLane();
//  2. the player's world X/Y (car+28/+2C) against our centreline:
//     a similarity fit (scale, rotation, offset) between the car's X/Y and
//     the centreline point at the car's segment (car+12), distance along
//     (car+1C) and lateral offset (car+0A); and the plain distance from the
//     car to our centreline polyline.
import fs from 'node:fs';
import path from 'node:path';
import { parseTrack, compileTrack, compilePitLane, decodeSegments, trackOutline, cosRaw, sinRaw, CIRCUITS, METRES_PER_FINE } from '../lib/track-file.mjs';

const HERE = import.meta.dirname;
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const TAG = opt('tag', 'qr1');
const DIR = path.join(HERE, '..', 'out', 'p1-track', TAG);
const GAME = path.join(HERE, '..', '..', 'original');
const meta = JSON.parse(fs.readFileSync(path.join(DIR, 'meta.json'), 'utf8'));
const ramFile = fs.existsSync(path.join(DIR, 'ram-green.bin')) ? 'ram-green.bin' : 'ram-pits.bin';
const ram = new Uint8Array(fs.readFileSync(path.join(DIR, ramFile)));
const fileNo = meta.circuit.file;
const track = parseTrack(new Uint8Array(fs.readFileSync(path.join(GAME, `f1ct${String(fileNo).padStart(2, '0')}.dat`))));
const out = { tag: TAG, circuit: CIRCUITS[fileNo - 1], ram: ramFile };

const stats = (a) => {
  if (!a.length) return null;
  const s = a.slice().sort((x, y) => x - y), q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return { n: a.length, min: s[0], p50: q(0.5), p95: q(0.95), max: s[s.length - 1], mean: +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(3) };
};
const wrap16 = (v) => (((v & 0xffff) + 0x8000) & 0xffff) - 0x8000;

// ---------------------------------------------------------------- 1. segments
const tLin = meta.trackSeg * 16 + meta.trackBase;
const live = decodeSegments(ram, tLin, meta.nSegs + 1);
const { segs, closure } = compileTrack(track);
const cmp = (A, B, n) => {
  const dxy = [], da = [], dz = [], dp = [], side = [];
  for (let i = 0; i < n; i++) {
    dxy.push(Math.hypot(A[i].x - B[i].x, A[i].y - B[i].y));
    da.push(Math.abs(wrap16(A[i].angle - B[i].angle)));
    dz.push(Math.abs(A[i].z - B[i].z)); dp.push(Math.abs(A[i].pitch - B[i].pitch));
    side.push((A[i].sideX !== B[i].sideX || A[i].sideY !== B[i].sideY || A[i].widthLow !== ((B[i].halfWidth >> 5) & 63)) ? 1 : 0);
  }
  return { xy: stats(dxy), angle: stats(da), z: stats(dz), pitch: stats(dp), sideVectorMismatches: side.reduce((x, y) => x + y, 0) };
};
out.trackSegments = {
  lapSegments: meta.nSegs, compiledTlu: segs.length,
  compare: cmp(live, segs, meta.nSegs),
  lastEntryIsCopyOfFirst: live[meta.nSegs].x === live[0].x && live[meta.nSegs].y === live[0].y && live[meta.nSegs].nr === 0,
  compiledLastVsFirst: Math.hypot(segs[segs.length - 1].x - segs[0].x, segs[segs.length - 1].y - segs[0].y),
  closureBeforeFit: closure,
};
// without the fit, for reference
out.trackSegments.compareNoFit = cmp(live, compileTrack(track, { fit: false }).segs, meta.nSegs);

// pit lane
const pLin = meta.pitSeg * 16 + meta.pitBase;
const pit = compilePitLane(track, segs);
const livePit = decodeSegments(ram, pLin - 0x2e, pit.segs.length + 1); // entry -1 = copy of the track segment before
out.pitSegments = {
  compiledTlu: pit.segs.length, start: pit.start, end: pit.end,
  entryMinus1: { nr: livePit[0].nr, isTrackCopy: livePit[0].x === live[livePit[0].nr]?.x },
  lastEntry: { nr: livePit[pit.segs.length].nr },
  compare: cmp(livePit.slice(1), pit.segs, pit.segs.length - 1),
};

// ---------------------------------------------------------------- 2. the player's X/Y
const framesFile = path.join(DIR, 'frames.jsonl');
let traj = [];
if (fs.existsSync(framesFile)) {
  const frames = fs.readFileSync(framesFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const N = meta.nSegs;
  const pts = []; // {P:[X,Y], Q:[x,y] fine (centre+along+lat), C:[x,y] fine (centre+along)}
  for (const f of frames) {
    if (f.v <= 0 || f.ss !== meta.trackSeg) continue;
    const si = (f.so - meta.trackBase) / 0x2e;
    if (!Number.isInteger(si) || si < 0 || si >= N) continue;
    const s = segs[si];
    const a = s.angle, c = cosRaw(a) / 16384, sn = sinRaw(a) / 16384;
    const along = f.dist;                       // car+1C, fine units into the segment
    const cx = s.x + sn * along, cy = s.y + c * along;
    pts.push({ P: [f.X, f.Y], C: [cx, cy], Q: [cx + c * f.lat, cy - sn * f.lat], lat: f.lat, si, f });
  }
  // least-squares similarity P = k R Q + t (complex-number form)
  const fitSim = (key) => {
    const n = pts.length;
    let mx = 0, my = 0, ux = 0, uy = 0;
    for (const p of pts) { mx += p[key][0]; my += p[key][1]; ux += p.P[0]; uy += p.P[1]; }
    mx /= n; my /= n; ux /= n; uy /= n;
    let sxx = 0, sab = 0, sba = 0;
    for (const p of pts) {
      const qx = p[key][0] - mx, qy = p[key][1] - my, px = p.P[0] - ux, py = p.P[1] - uy;
      sxx += qx * qx + qy * qy; sab += qx * px + qy * py; sba += qx * py - qy * px;
    }
    const re = sab / sxx, im = sba / sxx;
    const k = Math.hypot(re, im), rot = Math.atan2(im, re);
    const tx = ux - (re * mx - im * my), ty = uy - (im * mx + re * my);
    const res = pts.map((p) => Math.hypot(re * p[key][0] - im * p[key][1] + tx - p.P[0], im * p[key][0] + re * p[key][1] + ty - p.P[1]) / 256);
    return { n, scale: +k.toFixed(5), rotationDeg: +(rot * 180 / Math.PI).toFixed(5), offsetWorld: [+tx.toFixed(0), +ty.toFixed(0)], offsetFine: [+(tx / 256).toFixed(1), +(ty / 256).toFixed(1)], residualFine: stats(res) };
  };
  const fixed = (key) => stats(pts.map((p) => Math.hypot(p[key][0] * 256 - p.P[0], p[key][1] * 256 - p.P[1]) / 256));
  out.player = {
    frames: frames.length, used: pts.length,
    laps: [...new Set(frames.map((f) => f.lap))], lapTimesMs: [...new Set(frames.map((f) => f.last))].filter((x) => x < 1e7),
    fitWithLateral: fitSim('Q'),
    fitCentreOnly: fitSim('C'),
    fixedScale256WithLateral_fine: fixed('Q'),
    fixedScale256CentreOnly_fine: fixed('C'),
  };
  // distance from the car to our centreline polyline (no game fields used), signed: + = right
  const nearestSigned = (x, y, guess) => {
    let best = { d: Infinity };
    for (let k = guess - 3; k <= guess + 3; k++) {
      const a = segs[((k % N) + N) % N], b = segs[(((k + 1) % N) + N) % N];
      const ex = b.x - a.x, ey = b.y - a.y, L2 = ex * ex + ey * ey;
      let t = ((x - a.x) * ex + (y - a.y) * ey) / L2; t = Math.max(0, Math.min(1, t));
      const px = a.x + t * ex, py = a.y + t * ey, d = Math.hypot(x - px, y - py);
      if (d < best.d) best = { d, sign: Math.sign(ex * (y - a.y) - ey * (x - a.x)) * -1 || 1, k: ((k % N) + N) % N };
    }
    return best;
  };
  const latErr = [], dist = [], wid = [];
  for (const p of pts) {
    const r = nearestSigned(p.P[0] / 256, p.P[1] / 256, p.si);
    const signed = r.d * r.sign;
    dist.push(r.d); latErr.push(signed - p.lat); wid.push(Math.abs(signed) / segs[r.k].halfWidth);
  }
  out.player.distanceToCentrelineFine = stats(dist);
  out.player.signedDistanceMinusCar0A_fine = stats(latErr);
  out.player.fractionOfHalfWidth = stats(wid);
  traj = pts.map((p) => [p.P[0], p.P[1]]);
}

fs.writeFileSync(path.join(DIR, 'fit.json'), JSON.stringify(out, null, 1));
console.log(JSON.stringify(out, null, 1));

// ---------------------------------------------------------------- 3. map
const o = trackOutline(track);
const po = pit.segs.map((s) => [s.x * 256, s.y * 256]);
const all = o.left.concat(o.right);
let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
for (const [x, y] of all) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
const size = 900, pad = 30, sc = (size - 2 * pad) / Math.max(maxX - minX, maxY - minY);
const P = ([x, y]) => `${(pad + (x - minX) * sc).toFixed(1)},${(size - pad - (y - minY) * sc).toFixed(1)}`;
const svg = [`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><rect width="100%" height="100%" fill="#fff"/>`,
  `<polygon points="${o.left.map(P).join(' ')}" fill="none" stroke="#888"/>`,
  `<polygon points="${o.right.map(P).join(' ')}" fill="none" stroke="#888"/>`,
  `<polyline points="${po.map(P).join(' ')}" fill="none" stroke="#06c" stroke-dasharray="4 3"/>`,
  `<polyline points="${traj.filter((_, i) => i % 2 === 0).map(P).join(' ')}" fill="none" stroke="#d40" stroke-width="1.2"/>`,
  `<text x="10" y="20" font-family="sans-serif" font-size="15">${out.circuit}: track file outline (grey), pit lane (blue), player's car+28/+2C (orange), run ${TAG}</text>`,
  '</svg>'].join('\n');
fs.writeFileSync(path.join(DIR, 'map.svg'), svg);
try {
  const { chromium } = await import('playwright-core');
  const b = await chromium.launch({ headless: true });
  const pg = await b.newPage({ viewport: { width: size, height: size } });
  await pg.setContent(`<body style="margin:0">${svg}</body>`);
  await pg.screenshot({ path: path.join(DIR, 'map.png') });
  await b.close();
} catch (e) { console.log('no PNG:', e.message); }
