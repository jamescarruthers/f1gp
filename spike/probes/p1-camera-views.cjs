// p1-camera-views.cjs - analyse a p1-camera "views" recording: for each
// phase between scripted keys, the view mode, camera object, viewed car,
// and the camera pose compared with the viewed car's pose.
//
//   node probes/p1-camera-views.cjs RUN [TRACKRUN]
//
// The viewed car's pose is computed as gp.exe 0000:14A2 does: a car with
// +7E bit 0 set (physics) uses +28/+2C (X/Y), +08 (height), +02 (pitch);
// any other car is placed from its track segment (0000:1544, 0000:14D4).
// That needs the track segment array: out/p1-camera/RUN/track.bin, or the
// one of TRACKRUN (same circuit; the array is rebuilt identically at load).
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const L = require('./p1-camera-lib.cjs');

const [run, trackRun] = process.argv.slice(2);
const base = path.join(__dirname, '..', 'out', 'p1-camera');
const dir = path.join(base, run);
const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json')));
const { recs } = L.openRec(path.join(dir, 'rec.bin'), meta.imageSeg);
const trkFile = [path.join(dir, 'track.bin'), trackRun && path.join(base, trackRun, 'track.bin')].find((f) => f && fs.existsSync(f));
const trk = trkFile ? fs.readFileSync(trkFile) : null;
const trkMeta = trkFile ? JSON.parse(fs.readFileSync(path.join(path.dirname(trkFile), 'meta.json'))) : null;
const h = L.hex, s16 = L.s16;

// cos/sin as gp.exe 0000:03C8 (table at SS:3264, 1.14 fixed point, interpolated in 1/8 steps).
function cosT(a, ang) {
  let x = s16(ang & 0xffff); if (x < 0) x = -x;
  const i = (x >> 2) & 0xfffe;
  const t0 = a.ss16(0x3264 + i), t1 = a.ss16(0x3266 + i);
  return t0 + (((t1 - t0) * (x & 7)) >> 3);
}
function seg(segSeg, off) {
  // track.bin = [track segment 64K][pit segment 64K]; pick by segment value.
  if (!trk) return null;
  let b;
  if (segSeg === meta.trackSeg || (trkMeta && segSeg === trkMeta.trackSeg)) b = 0;
  else if (segSeg === meta.pitSeg || (trkMeta && segSeg === trkMeta.pitSeg)) b = 0x10000;
  else return null;
  const g = (o) => trk.readInt16LE(b + off + o), gu = (o) => trk.readUInt16LE(b + off + o);
  return { yaw: gu(0), pitch: g(2), x: g(4), z: g(6), y: g(8), k: g(0x14), fine: trk[b + off + 0x21], znext: g(0x2e + 6) };
}
// Pose of the object at DS offset o: {x, y (1/16384 ft), z (1/64 ft), pitch, yaw}.
function pose(a, o) {
  const c = L.carAt(a, o);
  if (c.m7e & 1) return { x: c.X, y: c.Y, z: c.z, pitch: c.pitch, yaw: c.heading, phys: true };
  const S = seg(c.segSeg, c.segOff);
  if (!S) return null;
  let along = c.along;
  if (S.k) along = s16(along - Math.floor((S.k * c.lat * 2) / 65536));
  const co = cosT(a, S.yaw), si = cosT(a, (0x4000 - S.yaw) & 0xffff);
  const dx = s16(Math.floor((c.lat * co + along * si) / 16384));
  const dy = s16(Math.floor((along * co - c.lat * si) / 16384));
  const x = ((S.x * 8) | (S.fine & 7)) + dx, y = ((S.y * 8) | (S.fine >> 4)) + dy;
  const z = S.z + ((((S.znext - S.z) * c.frac) * 4) >> 16) + a.ds16(o + 0x8c);
  const pitch = ((S.pitch * cosT(a, (c.heading - S.yaw) & 0xffff)) * 4) >> 16;
  return { x: x * 256, y: y * 256, z, pitch, yaw: c.heading, phys: false };
}
const name = (a, id) => {
  const n = (id & 0x3f) - 1;
  let s = '';
  for (let i = 0; i < 24; i++) { const ch = a.s8(0x1a4a + n * 24 + i); if (!ch) break; s += String.fromCharCode(ch); }
  return s;
};
const ft = (u) => u / 16384;
const angDeg = (v) => (s16(v & 0xffff) * 360) / 65536;
const bearing = (dx, dy) => (Math.round((Math.atan2(dx, dy) * 32768) / Math.PI) & 0xffff); // 0 = +Y, 0x4000 = +X

// Phases between key events.
const keys = meta.events.filter((e) => e.action === 'tap');
const bounds = [{ t: 0, arg: 'start' }, ...keys, { t: Infinity, arg: 'end' }];
const rows = [];
for (let p = 0; p + 1 < bounds.length; p++) {
  const t0 = bounds[p].t + 500, t1 = bounds[p + 1].t;
  const rs = recs.filter((r) => r.type === 1 && r.t >= t0 && r.t < t1);
  if (!rs.length) { rows.push({ phase: `${(bounds[p].t / 1000).toFixed(0)}s ${bounds[p].arg}`, frames: 0 }); continue; }
  const tuples = new Map();
  let camMoves = 0, prevCam = null, dist = [], dyaw = [], dz = [], aimErr = [], eyeH = [], pitchs = [], noPose = 0;
  for (const r of rs) {
    const c = L.camState(r);
    const key = `v=${h(c.view, 2)} obj=${h(c.camObj)} sel=${h(c.selCar)}`;
    tuples.set(key, (tuples.get(key) || 0) + 1);
    if (prevCam && (prevCam.x !== c.camX || prevCam.y !== c.camY)) camMoves++;
    prevCam = { x: c.camX, y: c.camY };
    const P = pose(r, c.selCar);
    if (!P) { noPose++; continue; }
    const dx = c.camX - P.x, dy = c.camY - P.y;
    dist.push(Math.hypot(ft(dx), ft(dy)));
    dyaw.push(angDeg(c.camYaw - P.yaw));
    dz.push(c.sZ - P.z);
    eyeH.push(c.eye);
    pitchs.push(c.camPitch);
    aimErr.push(angDeg(bearing(-dx, -dy) - c.camYaw)); // camera yaw vs direction from camera to car
  }
  const r0 = rs[Math.floor(rs.length / 2)], c0 = L.camState(r0);
  const sel = L.carAt(r0, c0.selCar);
  const st = (v) => (v.length ? `${Math.min(...v).toFixed(1)}..${Math.max(...v).toFixed(1)}` : '-');
  rows.push({
    phase: `${(bounds[p].t / 1000).toFixed(0)}s ${bounds[p].arg}`, frames: rs.length,
    tuples: [...tuples].map(([k, v]) => `${k} x${v}`).join('; '),
    viewed: `${h(sel.id, 2)} ${name(r0, sel.id)} 7E=${h(sel.m7e, 2)}`,
    camMoves, distFt: st(dist), yawMinusCarDeg: st(dyaw), aimErrDeg: st(aimErr), camZminusCarZ: st(dz), eye: st(eyeH), pitch: st(pitchs), noPose,
    d099B: `+00=${h(r0.d16(0x99b))} +1A=${h(r0.d16(0x99b + 0x1a))} +7E=${h(r0.d8(0x99b + 0x7e), 2)} +08=${r0.ds16(0x99b + 8)} +02=${r0.ds16(0x99b + 2)}`,
    misc: `233F=${c0.eye} 04D0=${c0.d4d0} 75F7=${h(r0.d16(0x75f7))} SS:0132=${c0.horizonMax} SS:0130=${c0.horizon} 2347=${c0.chaseDist} 0060=${h(c0.d0060)}`,
  });
}
for (const r of rows) console.log(JSON.stringify(r));
