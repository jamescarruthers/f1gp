// p1-fields-checks.cjs - extra field checks on p1-fields recordings (the
// numbers quoted in the Phase 1 field notes that analyse.cjs does not print).
//
//   node probes/p1-fields-checks.cjs drive1 [drive2 coast1]
//
// Writes out/p1-fields/<tag>/checks.json and prints it:
//   xyByBit01      |car+28/+2C - track formula| for computer cars, +7E bit 01 set vs clear
//   bit01Proximity distance to the nearest other car when +7E bit 01 is set / clear
//   xyWithoutBit01 X/Y writes seen while bit 01 was clear in both samples
//   zFormula       player car+08 vs Z0 + ((Z1-Z0)*car+1E >> 14) + car+8C
//   headingVsMotion direction of motion (from formula positions) - car+00 / car+1A
//   segDistDone    car+1E vs 16*car+1C and vs 16*(along at the centre line)
//   segPosY        player car+0C - car+1C
//   f76            computer cars' +76 vs speed/15
//   distSegs       car+A4 - ((lap-1)*nSegs + segment)
//   flagBits       per bit of +18/+23/+5E/+B3/+BC: share of samples braking / in the pit lane (computer cars)
//   f84            +84 value vs distance to the viewed car
//   viewedAIdash   dash mph vs the viewed computer car's speed (cockpit view of another car)
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const L = require('./p1-fields-lib.cjs');

const q = (a) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y), n = s.length, r = (f) => +(+s[Math.min(n - 1, Math.floor(n * f))]).toFixed(3);
  return { n, min: r(0), p05: r(0.05), p50: r(0.5), p95: r(0.95), max: r(0.9999), within1: +(s.filter((x) => Math.abs(x) <= 1).length / n).toFixed(3) };
};

function checks(tag) {
  const dir = path.join(__dirname, '..', 'out', 'p1-fields', tag);
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json')));
  const ram = fs.readFileSync(path.join(dir, 'ram-start.bin'));
  const m = L.ramReader(ram);
  const cos = L.makeCos((i) => m.s16(meta.SS, 0x3264 + i * 2));
  const S = L.openSamples(path.join(dir, 'samples.bin'));
  const P = meta.player, NS = meta.nSegs, N = S.length;
  const cars = S.map((s) => Array.from({ length: L.NCARS }, (_, i) => L.decodeCar(s.ds, i)));
  const seg = (c) => L.decodeSeg(m, c.segSeg, c.segOff);
  const formula = (c) => L.trackToWorld(seg(c), c, cos);
  const pos = (c) => ((c.autoFlags & 1) ? { x19: c.X >> 8, y19: c.Y >> 8 } : formula(c));
  const out = { tag };

  const set = [], clear = [], proxSet = [], proxClear = [], noBit = { n: 0, nearFormula: 0, lowBytesZero: 0 };
  const zd = [], hA = [], hA1A = [], hP = [], sdd16 = [], sddAlong = [], sdd16corner = [], segY = [], f76 = [], a4P = [], a4A = [];
  for (let k = 0; k < N; k++) {
    const cs = cars[k]; const ps = cs.map(pos);
    for (let i = 0; i < L.NCARS; i++) {
      const c = cs[i], s = seg(c);
      if (i !== P) {
        const w = formula(c); const e = Math.hypot((c.X >> 8) - w.x19, (c.Y >> 8) - w.y19) / 64;
        (c.autoFlags & 1 ? set : clear).push(e);
        let dn = Infinity; for (let j = 0; j < L.NCARS; j++) if (j !== i) dn = Math.min(dn, Math.hypot(ps[i].x19 - ps[j].x19, ps[i].y19 - ps[j].y19) / 64);
        (c.autoFlags & 1 ? proxSet : proxClear).push(dn);
        if (k) {
          const a = cars[k - 1][i];
          if ((a.X !== c.X || a.Y !== c.Y) && !((a.autoFlags | c.autoFlags) & 1)) { noBit.n++; if (e < 30) noBit.nearFormula++; if (!(c.X & 0xff) && !(c.Y & 0xff)) noBit.lowBytesZero++; }
        }
        if (c.speed > 500) f76.push(c.f76 / (c.speed / 15));
      } else {
        const nx = L.decodeSeg(m, c.segSeg, c.segOff + 0x2e);
        zd.push(c.posZ - (s.posZ + Math.floor(((nx.posZ - s.posZ) * c.segDistDone) / 16384) + c.heightAbove));
        segY.push(c.segPosY - c.segDist);
      }
      sdd16.push(c.segDistDone - c.segDist * 16);
      if (s.dAngle && c.segLength !== 0x400) {
        sdd16corner.push(c.segDistDone - c.segDist * 16);
        sddAlong.push(c.segDistDone - (c.segDist - Math.floor((s.dAngle * c.segPosX * 2) / 65536)) * 16);
      }
      if (c.segSeg === meta.trackSeg) (i === P ? a4P : a4A).push(c.distSegs - ((c.lap - 1) * NS + (c.segOff - meta.trackBase) / 0x2e));
      if (k) {
        const a = cars[k - 1][i]; const w0 = formula(a), w1 = formula(c);
        const dx = w1.x19 - w0.x19, dy = w1.y19 - w0.y19;
        if (Math.hypot(dx, dy) >= 300) {
          const mot = Math.round((Math.atan2(dx, dy) / (2 * Math.PI)) * 65536);
          if (i === P) hP.push(L.wrap16(mot - c.speedAngle)); else { hA.push(L.wrap16(mot - c.speedAngle)); hA1A.push(L.wrap16(mot - c.heading)); }
        }
      }
    }
  }
  out.xyByBit01 = { unit: 'ft', bit01Set: q(set), bit01Clear: q(clear) };
  out.bit01Proximity = { unit: 'ft to nearest other car', bit01Set: q(proxSet), bit01Clear: q(proxClear) };
  out.xyWithoutBit01 = noBit;
  out.zFormula = q(zd);
  out.headingVsMotion = { unit: '1/65536 turn', ai_minus_00: q(hA), ai_minus_1A: q(hA1A), player_minus_00: q(hP) };
  out.segDistDone = { all_minus_16x1C: q(sdd16), corners_minus_16x1C: q(sdd16corner), corners_minus_16xAlongCentre: q(sddAlong) };
  out.segPosY_player_minus_1C = q(segY);
  out.f76_over_speed15 = q(f76);
  out.distSegs = { player: q(a4P), ai: q(a4A) };

  // flag bits (computer cars): braking = acc (+72) < -20
  const flags = {};
  for (let k = 0; k < N; k++) for (let i = 0; i < L.NCARS; i++) {
    if (i === P) continue; const c = cars[k][i]; const pit = c.segSeg !== meta.trackSeg;
    for (const [f, v] of [['18', c.flags18], ['23', c.flags23], ['5E', c.flags5E], ['B3', c.flagsB3], ['BC', c.flagsBC]]) for (let b = 0; b < 8; b++) {
      if (!((v >> b) & 1)) continue; const key = `+${f} bit ${(1 << b).toString(16)}h`; const a = (flags[key] ||= { n: 0, braking: 0, inPit: 0 });
      a.n++; if (c.acc < -20) a.braking++; if (pit) a.inPit++;
    }
  }
  out.flagBits = Object.fromEntries(Object.entries(flags).map(([k, a]) => [k, { n: a.n, braking: +(a.braking / a.n).toFixed(2), inPit: +(a.inPit / a.n).toFixed(2) }]));

  // +84 vs distance to the viewed car
  const f84 = {};
  for (let k = 0; k < N; k += 2) {
    const vi = (S[k].ds.readUInt16LE(0x97f) - L.CAR0) / L.CAR_SIZE; if (!Number.isInteger(vi)) continue;
    const pv = pos(cars[k][vi]);
    for (let i = 0; i < L.NCARS; i++) { if (i === vi) continue; const p = pos(cars[k][i]); (f84[cars[k][i].f84] ||= []).push(Math.hypot(p.x19 - pv.x19, p.y19 - pv.y19) / 64); }
  }
  out.f84_distanceToViewedCar_ft = Object.fromEntries(Object.entries(f84).map(([v, a]) => [v, q(a)]));

  // dash vs a viewed computer car
  const dashFile = path.join(dir, 'dash.jsonl');
  if (fs.existsSync(dashFile)) {
    const dash = fs.readFileSync(dashFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    let n = 0, hit = 0;
    for (const d of dash) {
      if (d.mph === null || d.sample < 4) continue; const ds = S[d.sample].ds; if (ds[0x981] !== 0) continue;
      const vi = (ds.readUInt16LE(0x97f) - L.CAR0) / L.CAR_SIZE; if (vi === P || !Number.isInteger(vi)) continue;
      n++; for (let lag = 0; lag <= 3; lag++) if (Math.floor((cars[d.sample - lag][vi].speed * 0x2ba) / 65536) === d.mph) { hit++; break; }
    }
    out.viewedAIdash = { readings: n, matchSpeedInLast4Samples: hit };
  }
  fs.writeFileSync(path.join(dir, 'checks.json'), JSON.stringify(out, null, 1));
  return out;
}

if (require.main === module) for (const tag of process.argv.slice(2)) console.log(JSON.stringify(checks(tag), null, 1));
module.exports = { checks };
