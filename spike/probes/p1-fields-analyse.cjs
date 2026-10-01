// p1-fields-analyse.cjs - analyse a recording made by p1-fields-record.cjs.
//
//   node probes/p1-fields-analyse.cjs drive1 [coast1 ...]
//
// Writes out/p1-fields/<tag>/analysis.json and prints a summary. Sections:
//   fields     per-field change statistics, player vs computer cars
//   bytes      per-byte-offset change counts (which cars, how often)
//   dash       player speed field vs dash mph read from the screen
//   world      player X/Y vs the track-relative formula; when computer cars'
//              X/Y change; formula positions for every car (speed check)
//   along      track-relative fields vs progress round the lap
//   laps       lap counter, s/f crossings, last-lap time vs session timer
//   order      race position byte vs order by distance
//   gears      RPM / speed per gear (player)
//   view       viewed-car pointers and view mode vs key taps
//   units      lap length from the segment array, speed vs d(X,Y)/dt
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const L = require('./p1-fields-lib.cjs');

const MPH = (v) => (v * 0x2ba) / 0x10000;

function stats(a) {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const mean = a.reduce((p, x) => p + x, 0) / a.length;
  const rms = Math.sqrt(a.reduce((p, x) => p + x * x, 0) / a.length);
  return { n: a.length, min: s[0], p05: s[Math.floor(s.length * 0.05)], median: s[s.length >> 1], p95: s[Math.floor(s.length * 0.95)], max: s[s.length - 1], mean: +mean.toFixed(3), rms: +rms.toFixed(3) };
}
function corr(x, y) {
  const n = x.length; if (n < 3) return null;
  const mx = x.reduce((a, b) => a + b, 0) / n, my = y.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { sxy += (x[i] - mx) * (y[i] - my); sxx += (x[i] - mx) ** 2; syy += (y[i] - my) ** 2; }
  return sxx && syy ? +(sxy / Math.sqrt(sxx * syy)).toFixed(4) : null;
}
function linfit(x, y) {
  const n = x.length; const mx = x.reduce((a, b) => a + b, 0) / n, my = y.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0; for (let i = 0; i < n; i++) { sxy += (x[i] - mx) * (y[i] - my); sxx += (x[i] - mx) ** 2; }
  const b = sxy / sxx; return { slope: +b.toPrecision(6), intercept: +(my - b * mx).toPrecision(6) };
}
const hex = (v, w = 4) => (v >>> 0).toString(16).padStart(w, '0');

function analyse(tag) {
  const dir = path.join(__dirname, '..', 'out', 'p1-fields', tag);
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json')));
  const ram = fs.readFileSync(path.join(dir, 'ram-start.bin'));
  const m = L.ramReader(ram);
  const cos = L.makeCos((i) => m.s16(meta.SS, 0x3264 + i * 2));
  const S = L.openSamples(path.join(dir, 'samples.bin'));
  const dash = fs.existsSync(path.join(dir, 'dash.jsonl')) ? fs.readFileSync(path.join(dir, 'dash.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  const N = S.length, P = meta.player, NS = meta.nSegs;
  const cars = S.map((s) => Array.from({ length: L.NCARS }, (_, i) => L.decodeCar(s.ds, i)));
  const timer = S.map((s) => s.ds.readUInt32LE(0x294f));
  const segIndex = (c) => (c.segSeg === meta.trackSeg ? (c.segOff - meta.trackBase) / 0x2e : null);
  const out = { tag, meta: { samples: N, player: P, nSegs: NS, DS: hex(meta.DS), SS: hex(meta.SS), trackSeg: hex(meta.trackSeg), pitSeg: hex(meta.pitSeg), pitBase: hex(meta.pitBase), mode: meta.mode } };
  const isPlayer = (i) => (cars[0][i].id & 0x80) !== 0;

  // ------------------------------------------------------------ fields
  const fields = {};
  for (const [o, size, sg, name] of L.CAR_FIELDS) {
    const f = { off: '+' + hex(o, 2), size, player: null, ai: null };
    for (const who of ['player', 'ai']) {
      const ids = [...Array(L.NCARS).keys()].filter((i) => (who === 'player') === isPlayer(i));
      let changes = 0, pairs = 0, carsChanged = 0; const vals = [];
      for (const i of ids) {
        let ch = 0;
        for (let k = 0; k < N; k++) { const v = cars[k][i][name]; vals.push(v); if (k && v !== cars[k - 1][i][name]) ch++; }
        pairs += N - 1; changes += ch; if (ch) carsChanged++;
      }
      let mn = Infinity, mx = -Infinity; for (const v of vals) { if (v < mn) mn = v; if (v > mx) mx = v; }
      f[who] = { carsChanged: `${carsChanged}/${ids.length}`, changeRate: +(changes / Math.max(1, pairs)).toFixed(3), min: mn, max: mx, distinct: new Set(vals).size };
    }
    fields[name] = f;
  }
  out.fields = fields;

  // ------------------------------------------------------------ bytes
  const bytes = [];
  for (let o = 0; o < L.CAR_SIZE; o++) {
    let carsChanged = 0, changes = 0, pch = 0;
    for (let i = 0; i < L.NCARS; i++) {
      let ch = 0; for (let k = 1; k < N; k++) if (L.carBytes(S[k].ds, i)[o] !== L.carBytes(S[k - 1].ds, i)[o]) ch++;
      if (ch) carsChanged++; changes += ch; if (isPlayer(i)) pch = ch;
    }
    bytes.push({ off: hex(o, 2), carsChanged, aiRate: +((changes - pch) / ((N - 1) * (L.NCARS - 1))).toFixed(3), playerRate: +(pch / (N - 1)).toFixed(3) });
  }
  out.bytes = bytes;

  // ------------------------------------------------------------ dash
  if (dash.length) {
    const diffs = [], pairs = [];
    for (const d of dash) {
      if (d.mph === null || d.sample < 0 || d.sample >= N) continue;
      if (S[d.sample].ds.readUInt16LE(0x97f) !== cars[0][P].off || S[d.sample].ds[0x981] !== 0) continue; // dash shows another car
      const k = d.sample; const mem = MPH(cars[k][P].speed);
      // the dash may lag/lead by a frame: also compare with the next sample
      const mem2 = k + 1 < N ? MPH(cars[k + 1][P].speed) : mem;
      const best = Math.abs(d.mph - mem) <= Math.abs(d.mph - mem2) ? mem : mem2;
      diffs.push(d.mph - Math.floor(best)); pairs.push([d.t, d.mph, Math.floor(mem)]);
    }
    // lag: compare dash with the speed `lag` samples earlier (0..4)
    const lagRms = {};
    for (let lag = 0; lag <= 4; lag++) {
      const e = [];
      for (const d of dash) { const k = d.sample - lag; if (d.mph === null || k < 0 || k >= N) continue; if (S[d.sample].ds.readUInt16LE(0x97f) !== cars[0][P].off || S[d.sample].ds[0x981] !== 0) continue; e.push(d.mph - Math.floor(MPH(cars[k][P].speed))); }
      const st = stats(e); lagRms[lag] = st && { rms: st.rms, exact: +(e.filter((x) => x === 0).length / e.length).toFixed(3), within1: +(e.filter((x) => Math.abs(x) <= 1).length / e.length).toFixed(3) };
    }
    out.dashLag = lagRms;
    out.dash = { readings: dash.length, compared: diffs.length, diffStats: stats(diffs), exactMatch: +(diffs.filter((x) => x === 0).length / Math.max(1, diffs.length)).toFixed(3), within1: +(diffs.filter((x) => Math.abs(x) <= 1).length / Math.max(1, diffs.length)).toFixed(3), sample: pairs.filter((_, j) => j % 40 === 0) };
  }

  // ------------------------------------------------------------ world
  const world = { player: null, ai: {}, perCar: [] };
  const segOf = (c) => L.decodeSeg(m, c.segSeg, c.segOff);
  {
    const dx = [], dy = [], dd = [];
    for (let k = 0; k < N; k++) {
      const c = cars[k][P]; const w = L.trackToWorld(segOf(c), c, cos);
      const ex = (c.X >> 8) - w.x19, ey = (c.Y >> 8) - w.y19; dx.push(ex); dy.push(ey); dd.push(Math.hypot(ex, ey));
    }
    world.player = { note: 'difference between car+28/+2C >> 8 and the track-relative formula, in 1/64 ft (X19 units)', dx: stats(dx), dy: stats(dy), dist: stats(dd), lowByteOfXalwaysZero: cars.every((cs) => (cs[P].X & 0xff) === 0) };
  }
  for (let i = 0; i < L.NCARS; i++) {
    if (i === P) continue;
    const changes = [];
    for (let k = 1; k < N; k++) {
      const a = cars[k - 1][i], b = cars[k][i];
      if (a.X !== b.X || a.Y !== b.Y) {
        const w = L.trackToWorld(segOf(b), b, cos);
        changes.push({ k, t: +(S[k].ms / 1000).toFixed(1), X: b.X, Y: b.Y, dFormula: Math.round(Math.hypot((b.X >> 8) - w.x19, (b.Y >> 8) - w.y19)), f7e: hex(b.autoFlags, 2), f84: b.f84, f96: hex(b.flags96, 2), viewed: S[k].ds.readUInt16LE(0x97f) === b.off, speed: b.speed });
      }
    }
    // X/Y change vs +7E bit 01 (set now or in the previous sample)
    let withBit = 0, bitSamples = 0, bitNoChange = 0;
    for (let k = 1; k < N; k++) {
      const a = cars[k - 1][i], b = cars[k][i]; const ch = a.X !== b.X || a.Y !== b.Y;
      const bit = (a.autoFlags & 1) || (b.autoFlags & 1);
      if (b.autoFlags & 1) bitSamples++;
      if (ch && bit) withBit++;
      if (bit && (a.autoFlags & 1) && (b.autoFlags & 1) && !ch && b.speed > 100) bitNoChange++;
    }
    world.ai[i] = { id: cars[0][i].id & 0x3f, xyChanges: changes.length, changesWith7Ebit01: withBit, samplesWith7Ebit01: bitSamples, bit01SetButNoMove: bitNoChange, first: changes.slice(0, 5), last: changes.slice(-3) };
  }
  // formula positions for every car: implied speed vs speed field
  for (let i = 0; i < L.NCARS; i++) {
    const ratio = [], jumps = [];
    for (let k = 1; k < N; k++) {
      const a = cars[k - 1][i], b = cars[k][i]; const dt = (timer[k] - timer[k - 1]) / 1000;
      if (dt <= 0 || a.segSeg !== meta.trackSeg || b.segSeg !== meta.trackSeg) continue;
      const wa = L.trackToWorld(segOf(a), a, cos), wb = L.trackToWorld(segOf(b), b, cos);
      const dist = Math.hypot(wb.x19 - wa.x19, wb.y19 - wa.y19) / 64; // ft
      const v = ((a.speed + b.speed) / 2) / 64; // ft/s
      if (v > 20) ratio.push(dist / dt / v);
      if (dist > v * dt * 1.5 + 20) jumps.push({ k, dist: +dist.toFixed(1), expect: +(v * dt).toFixed(1) });
    }
    world.perCar.push({ i, id: cars[0][i].id & 0x3f, player: i === P, impliedOverField: stats(ratio.map((r) => +r.toFixed(3))), jumps: jumps.length, jumpSamples: jumps.slice(0, 3) });
  }
  out.world = world;

  // ------------------------------------------------------------ along
  // progress = lap * nSegs + segIndex + segDistDone/0x4000, per car
  const along = {};
  const names = ['segPosX', 'segPosY', 'segPosCCLine', 'segLength', 'segDist', 'segDistDone', 'f20', 'f26', 'f80', 'f88', 'distSegs', 'f3E', 'f74', 'f8A', 'speedAngle', 'heading', 'prevHeading', 'f4A', 'f5A'];
  for (const name of names) {
    const r = { player: {}, ai: {} };
    for (const who of ['player', 'ai']) {
      const xs = [], ys = [], inc = [0, 0, 0];
      for (let i = 0; i < L.NCARS; i++) {
        if ((who === 'player') !== (i === P)) continue;
        for (let k = 0; k < N; k++) {
          const c = cars[k][i]; const si = segIndex(c); if (si === null) continue;
          xs.push(si); ys.push(c[name]);
          if (k) { const d = c[name] - cars[k - 1][i][name]; inc[d > 0 ? 0 : d < 0 ? 1 : 2]++; }
        }
      }
      r[who] = { corrWithSegIndex: corr(xs, ys), up: inc[0], down: inc[1], same: inc[2] };
    }
    along[name] = r;
  }
  // specific checks
  const chk = { f80_vs_seg: [], f26_vs_seg: [], f88_vs_seg: [], distSegs_vs_lapSeg: [], segDistDone_vs_ratio: [], segLength_model: [], ccLine: [] };
  for (let i = 0; i < L.NCARS; i++) {
    for (let k = 0; k < N; k += 5) {
      const c = cars[k][i]; const si = segIndex(c); if (si === null) continue;
      const seg = segOf(c);
      chk.f80_vs_seg.push([si, c.f80]); chk.f26_vs_seg.push([si, c.f26]); chk.f88_vs_seg.push([si, c.f88]);
      chk.distSegs_vs_lapSeg.push(c.distSegs - (c.lap * NS + si));
      if (c.segLength) chk.segDistDone_vs_ratio.push(c.segDistDone - Math.trunc((c.segDist * 0x4000) / c.segLength));
      // arc length at lateral offset: 0x400 - (dAngle*lat*4 >> 16)?
      chk.segLength_model.push(c.segLength - (0x400 - Math.floor((seg.dAngle * c.segPosX * 4) / 65536)));
      chk.ccLine.push([seg.ccLine, c.segPosCCLine, c.segPosX, i === P]);
    }
  }
  const f80fit = linfit(chk.f80_vs_seg.map((p) => p[0]), chk.f80_vs_seg.map((p) => p[1]));
  along._checks = {
    f80_linear_fit_vs_segIndex: f80fit, f80_corr: corr(chk.f80_vs_seg.map((p) => p[0]), chk.f80_vs_seg.map((p) => p[1])),
    f26_corr: corr(chk.f26_vs_seg.map((p) => p[0]), chk.f26_vs_seg.map((p) => p[1])),
    f88_corr: corr(chk.f88_vs_seg.map((p) => p[0]), chk.f88_vs_seg.map((p) => p[1])),
    f88_by_seg: (() => { const b = {}; for (const [si, v] of chk.f88_vs_seg) { const key = Math.floor(si / 50) * 50; (b[key] ||= new Set()).add(v); } return Object.fromEntries(Object.entries(b).map(([k, v]) => [k, [...v].sort((a, c) => a - c).join(',')])); })(),
    f26_by_seg: (() => { const b = {}; for (const [si, v] of chk.f26_vs_seg) { const key = Math.floor(si / 100) * 100; (b[key] ||= []).push(v); } return Object.fromEntries(Object.entries(b).map(([k, v]) => [k, [Math.min(...v), Math.max(...v)]])); })(),
    distSegs_minus_lapTimesN_plus_seg: stats(chk.distSegs_vs_lapSeg),
    segDistDone_minus_segDist_over_segLength: stats(chk.segDistDone_vs_ratio),
    segLength_minus_model: stats(chk.segLength_model),
    ccLine_corr_seg_vs_car0E: corr(chk.ccLine.map((p) => p[0]), chk.ccLine.map((p) => p[1])),
    lateral_vs_ccLine_ai: corr(chk.ccLine.filter((p) => !p[3]).map((p) => p[1]), chk.ccLine.filter((p) => !p[3]).map((p) => p[2])),
    lateral_minus_car0E_ai: stats(chk.ccLine.filter((p) => !p[3]).map((p) => p[2] - p[1])),
  };
  out.along = along;

  // ------------------------------------------------------------ laps
  const laps = [];
  for (let i = 0; i < L.NCARS; i++) {
    const ev = [];
    for (let k = 1; k < N; k++) {
      const a = cars[k - 1][i], b = cars[k][i];
      const sa = segIndex(a), sb = segIndex(b);
      const wrapped = sa !== null && sb !== null && sb < sa - NS / 2;
      if (b.lap !== a.lap || wrapped || b.lastLap !== a.lastLap) ev.push({ k, timer: timer[k], lapFrom: a.lap, lapTo: b.lap, segFrom: sa, segTo: sb, wrapped, lastLap: b.lastLap, bestLap: b.bestLap, lapStart: b.lapStart });
    }
    // lap time check: last lap = difference of lapStart values
    const lapEv = ev.filter((e) => e.lapTo !== e.lapFrom);
    const lapTimes = [];
    for (let j = 1; j < lapEv.length; j++) lapTimes.push({ fromStarts: lapEv[j].lapStart - lapEv[j - 1].lapStart, lastLapField: lapEv[j].lastLap, timerDiff: lapEv[j].timer - lapEv[j - 1].timer });
    laps.push({ i, id: cars[0][i].id & 0x3f, events: ev.length, lapIncrements: lapEv.length, finalLap: cars[N - 1][i].lap, wrapsWithoutLapChange: ev.filter((e) => e.wrapped && e.lapTo === e.lapFrom).length, lapChangesWithoutWrap: lapEv.filter((e) => !e.wrapped).length, firstEvents: ev.slice(0, 4), lapTimes });
  }
  out.laps = laps;

  // ------------------------------------------------------------ order
  {
    let agree = 0, total = 0, adjSwaps = 0; const bad = [];
    for (let k = 0; k < N; k += 2) {
      const cs = cars[k].filter((c) => !(c.flags3C & 0x10));
      const prog = (c) => c.distSegs + c.segDistDone / 0x4000;
      const byDist = [...cs].sort((a, b) => prog(b) - prog(a));
      const byPos = [...cs].sort((a, b) => a.racePos2 - b.racePos2);
      total++;
      const same = byDist.every((c, j) => c.i === byPos[j].i);
      if (same) agree++; else { let sw = 0; byDist.forEach((c, j) => { if (c.i !== byPos[j].i) sw++; }); adjSwaps += sw; if (bad.length < 3) bad.push({ k, byDist: byDist.slice(0, 6).map((c) => c.id & 0x3f), byPos: byPos.slice(0, 6).map((c) => c.id & 0x3f) }); }
    }
    const ss1940 = S[N - 1].ss.subarray(0x1940, 0x1940 + 26);
    out.order = { samplesCompared: total, identicalOrder: agree, meanMismatchedSlots: +(adjSwaps / Math.max(1, total - agree)).toFixed(2), examples: bad,
      ss1940_lastSample: [...ss1940].map((b) => hex(b, 2)).join(' '), byRacePos_lastSample: [...cars[N - 1]].sort((a, b) => a.racePos2 - b.racePos2).map((c) => hex(c.id, 2)).join(' ') };
  }

  // ------------------------------------------------------------ gears
  {
    const g = {};
    for (let k = 0; k < N; k++) { const c = cars[k][P]; if (c.speed < 200) continue; (g[c.gear] ||= []).push([c.speed, c.rpm]); }
    out.gears = Object.fromEntries(Object.entries(g).map(([gear, v]) => [gear, { n: v.length, mphRange: [Math.round(MPH(Math.min(...v.map((x) => x[0])))), Math.round(MPH(Math.max(...v.map((x) => x[0]))))], rpmRange: [Math.min(...v.map((x) => x[1])), Math.max(...v.map((x) => x[1]))], rpmPerMph: +stats(v.map((x) => x[1] / MPH(x[0]))).median.toFixed(1), corrRpmSpeed: corr(v.map((x) => x[0]), v.map((x) => x[1])) }]));
    const ai = {}; for (let i = 0; i < L.NCARS; i++) if (i !== P) for (let k = 0; k < N; k += 10) { const c = cars[k][i]; ai[c.gear] = (ai[c.gear] || 0) + 1; }
    out.gearsAI = ai;
  }

  // ------------------------------------------------------------ view
  {
    const v = []; let last = '';
    for (let k = 0; k < N; k++) {
      const ds = S[k].ds;
      const cur = `${hex(ds.readUInt16LE(0x97d))} ${hex(ds.readUInt16LE(0x97f))} ${hex(ds[0x981], 2)}`;
      if (cur !== last) {
        const vc = ds.readUInt16LE(0x97f); const ci = (vc - L.CAR0) / L.CAR_SIZE;
        v.push({ k, t: +(S[k].ms / 1000).toFixed(1), keys: S[k].keys, '097D': hex(ds.readUInt16LE(0x97d)), '097F': hex(vc), viewedCarIndex: Number.isInteger(ci) ? ci : null, '0981': hex(ds[0x981], 2) });
        last = cur;
      }
    }
    out.view = v;
  }

  // ------------------------------------------------------------ units
  {
    let len = 0;
    const seg = (j) => L.decodeSeg(m, meta.trackSeg, meta.trackBase + j * 0x2e);
    const steps = [];
    for (let j = 0; j < NS; j++) { const a = seg(j), b = seg(j + 1); const d = Math.hypot(b.x19 - a.x19, b.y19 - a.y19); steps.push(d); len += d; }
    const xs = [], ys = [];
    for (let j = 0; j < NS; j++) { const a = seg(j); xs.push(a.x19); ys.push(a.y19); }
    // player: d(X,Y)/dt vs speed (timer-based dt), units of car+28 per (1/64 ft/s)
    // over 1 s spans (10 samples) so that frame-phase jitter between the
    // timer and the position averages out; mean speed over the span
    const r = [];
    for (let k = 10; k < N; k++) {
      const a = cars[k - 10][P], b = cars[k][P]; const dt = (timer[k] - timer[k - 10]) / 1000; if (dt <= 0) continue;
      let path = 0, v = 0;
      for (let j = k - 9; j <= k; j++) { const p0 = cars[j - 1][P], p1 = cars[j][P]; path += Math.hypot(p1.X - p0.X, p1.Y - p0.Y); v += p1.speed; }
      v /= 10; if (v < 2000) continue;
      r.push(path / dt / v);
    }
    out.units = {
      segmentsPerLap: NS, lapLengthX19: Math.round(len), lapLengthFt: +(len / 64).toFixed(1), lapLengthM: +((len / 64) * 0.3048).toFixed(1),
      nominal: `${NS} segments x 16 ft = ${NS * 16} ft = ${((NS * 16 * 0.3048) / 1000).toFixed(4)} km`,
      segmentStepX19: stats(steps.map((s) => Math.round(s))),
      extentX19: { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) },
      extentM: { w: +(((Math.max(...xs) - Math.min(...xs)) / 64) * 0.3048).toFixed(0), h: +(((Math.max(...ys) - Math.min(...ys)) / 64) * 0.3048).toFixed(0) },
      playerXYrate_per_speedUnit: stats(r.map((x) => +x.toFixed(2))),
      expectedIf_XY_is_1_16384ft_and_speed_1_64fts: 256,
      timerMsPerHostS: +((timer[N - 1] - timer[0]) / ((S[N - 1].ms - S[0].ms) / 1000)).toFixed(1),
      timerStep: (() => { const d = {}; for (let k = 1; k < N; k++) { const x = timer[k] - timer[k - 1]; d[x] = (d[x] || 0) + 1; } return d; })(),
    };
  }
  // ------------------------------------------------------------ frames
  const framesFile = path.join(dir, 'frames.jsonl');
  if (fs.existsSync(framesFile)) {
    const F = fs.readFileSync(framesFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const steps = {}; const per = []; let paused = 0;
    for (let j = 1; j < F.length; j++) {
      const dt = F[j].timer - F[j - 1].timer; steps[dt] = (steps[dt] || 0) + 1;
      const hostGap = F[j].t - F[j - 1].t; if (hostGap > 300) paused++;
      const d = Math.hypot(F[j].X - F[j - 1].X, F[j].Y - F[j - 1].Y) / 256; // X19 units (1/64 ft)
      const v = F[j].v; // the step uses the new or the old speed?
      if (dt > 0 && dt < 80 && F[j - 1].v > 1500) per.push({ d, vNew: v / 15, vOld: F[j - 1].v / 15 });
    }
    const span = (F[F.length - 1].t - F[0].t) / 1000;
    const errNew = per.map((p) => p.d - p.vNew), errOld = per.map((p) => p.d - p.vOld), ratio = per.map((p) => p.d / p.vOld);
    // dash vs the per-frame history: which frame's speed does the dash show?
    const lagHits = {};
    for (const d of dash) {
      if (d.mph === null || d.memV === undefined || !String(d.view || '').endsWith('/0')) continue;
      // frames up to the dash read, newest first
      let j = F.findIndex((f) => f.t > d.t * 1000); if (j < 0) j = F.length; j--;
      for (let lag = 0; lag <= 4 && j - lag >= 0; lag++) if (Math.floor(MPH(F[j - lag].v)) === d.mph) { lagHits[lag] = (lagHits[lag] || 0) + 1; break; }
      if (!Object.keys(lagHits).length) continue;
    }
    const liveDiff = dash.filter((d) => d.mph !== null && d.memV !== undefined && String(d.view || '').endsWith('/0')).map((d) => d.mph - Math.floor(MPH(d.memV)));
    out.frames = {
      frames: F.length, hostSeconds: +span.toFixed(2), framesPerHostSecond: +(F.length / span).toFixed(3),
      timerStepPerFrame: steps, timerMsPerFrame: +((F[F.length - 1].timer - F[0].timer) / (F.length - 1)).toFixed(3), pausesOver300ms: paused,
      distPerFrame_minus_vOld_over_15: stats(errOld.map((x) => +x.toFixed(2))), distPerFrame_minus_vNew_over_15: stats(errNew.map((x) => +x.toFixed(2))),
      distPerFrame_over_vOld15: stats(ratio.map((x) => +x.toFixed(4))),
      dashVsLiveSpeed: stats(liveDiff), dashExactLive: +(liveDiff.filter((x) => x === 0).length / Math.max(1, liveDiff.length)).toFixed(3),
      dashMatchesFrameLag: lagHits, dashReadingsCompared: liveDiff.length,
    };
  }
  fs.writeFileSync(path.join(dir, 'analysis.json'), JSON.stringify(out, null, 1));
  return out;
}

if (require.main === module) {
  for (const tag of process.argv.slice(2)) {
    const r = analyse(tag);
    console.log(`== ${tag}: ${r.meta.samples} samples, player index ${r.meta.player}`);
    console.log('dash:', JSON.stringify(r.dash && { compared: r.dash.compared, exact: r.dash.exactMatch, within1: r.dash.within1, diff: r.dash.diffStats }));
    console.log('world player:', JSON.stringify(r.world.player));
    console.log('AI X/Y changes:', Object.entries(r.world.ai).map(([i, v]) => `${i}:${v.xyChanges}`).join(' '));
    console.log('units:', JSON.stringify(r.units));
  }
}
module.exports = { analyse };
