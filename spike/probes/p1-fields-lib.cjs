// p1-fields-lib.cjs - shared helpers for the p1-fields probes (recorder and
// analysis): the sample file format, car-record and segment decoding, the
// game's cos table and its track-relative -> world position formula.
//
// The world formula is the one in gp.exe image 0x1544..0x1660 (called through
// 0x14A2 / 0x1525 for cars whose +7E bit 01 is clear; for cars with that bit
// set the game copies +28/+2C instead):
//   along = car+1C - ((seg+14 * car+0A * 2) >> 16)       (only if seg+14 != 0)
//   X19   = (seg+04 << 3 | seg+21 & 7) + ((car+0A*cos(a) + along*sin(a)) >> 14)
//   Y19   = (seg+08 << 3 | seg+21 >> 4) + ((along*cos(a) - car+0A*sin(a)) >> 14)
//   world X/Y (car+28/+2C units) = X19 << 8, Y19 << 8, a = seg+00
// cos(a) = gp.exe 0000:03C8, table at SS:3264, interpolated in 1/8 steps.
'use strict';

const fs = require('node:fs');

// ---------------------------------------------------------------- layout
const CAR0 = 0x0d1b, CAR_SIZE = 0xc0, NCARS = 26;
const DS_REL = 0x1e61, SS_REL = 0x2914;
const DS_WIN = [0x0000, 0x3000]; // recorded DS window (cars at 0D1B..209B)
const SS_WIN = [0x0000, 0x2400]; // recorded SS window (015C, 121C.., 1940..)
const HDR = 32;
const REC = HDR + (DS_WIN[1] - DS_WIN[0]) + (SS_WIN[1] - SS_WIN[0]);
const MAGIC = 0x53463150; // 'P1FS'

// Keys held (bit mask stored per sample).
const KEYBITS = { a: 1, z: 2, comma: 4, period: 8, left: 16, right: 32, up: 64, down: 128, home: 256, pagedown: 512, delete: 1024, space: 2048 };

const s16 = (v) => (v << 16) >> 16;
const wrap16 = (v) => s16(v & 0xffff);

// ---------------------------------------------------------------- sample file
function openSamples(file) {
  const buf = fs.readFileSync(file);
  const n = Math.floor(buf.length / REC);
  const samples = [];
  for (let i = 0; i < n; i++) {
    const o = i * REC;
    if (buf.readUInt32LE(o) !== MAGIC) throw new Error(`bad magic at record ${i}`);
    samples.push({
      idx: buf.readUInt32LE(o + 4),
      ms: buf.readDoubleLE(o + 8),
      keys: buf.readUInt32LE(o + 16),
      ds: buf.subarray(o + HDR, o + HDR + (DS_WIN[1] - DS_WIN[0])),
      ss: buf.subarray(o + HDR + (DS_WIN[1] - DS_WIN[0]), o + REC),
    });
  }
  return samples;
}

function encodeHeader(idx, ms, keys) {
  const h = Buffer.alloc(HDR);
  h.writeUInt32LE(MAGIC, 0); h.writeUInt32LE(idx, 4); h.writeDoubleLE(ms, 8); h.writeUInt32LE(keys >>> 0, 16);
  return h;
}

// ---------------------------------------------------------------- car fields
// [offset, size(1/2/4), signed, name]. Names follow GPDEF.INC / GP_SI.
const CAR_FIELDS = [
  [0x00, 2, 0, 'speedAngle'], [0x02, 2, 1, 'pitch'], [0x04, 4, 1, 'gapAhead'], [0x08, 2, 1, 'posZ'],
  [0x0a, 2, 1, 'segPosX'], [0x0c, 2, 1, 'segPosY'], [0x0e, 2, 1, 'segPosCCLine'], [0x10, 2, 1, 'speed'],
  [0x12, 2, 0, 'segOff'], [0x14, 2, 0, 'segSeg'], [0x16, 2, 1, 'segLength'], [0x18, 1, 0, 'flags18'],
  [0x19, 1, 0, 'flags19'], [0x1a, 2, 0, 'heading'], [0x1c, 2, 1, 'segDist'], [0x1e, 2, 1, 'segDistDone'],
  [0x20, 2, 1, 'f20'], [0x22, 1, 0, 'lap'], [0x23, 1, 0, 'flags23'], [0x24, 1, 1, 'gear'], [0x25, 1, 0, 'team'],
  [0x26, 2, 1, 'f26'], [0x28, 4, 1, 'X'], [0x2c, 4, 1, 'Y'], [0x30, 4, 1, 'vX'], [0x34, 4, 1, 'vY'],
  [0x38, 4, 1, 'vZ'], [0x3c, 1, 0, 'flags3C'], [0x3d, 1, 0, 'flags3D'], [0x3e, 2, 1, 'f3E'],
  [0x40, 4, 0, 'lastLap'], [0x44, 2, 0, 'weight'], [0x46, 2, 0, 'grip'], [0x48, 2, 1, 'steerAngle'],
  [0x4a, 2, 1, 'f4A'], [0x4c, 2, 0, 'f4C'], [0x4e, 2, 0, 'f4E'], [0x50, 4, 0, 'f50'], [0x54, 4, 0, 'lapStart'],
  [0x58, 2, 0, 'f58'], [0x5a, 2, 1, 'f5A'], [0x5c, 2, 1, 'f5C'], [0x5e, 1, 0, 'flags5E'], [0x5f, 1, 0, 'brakeRaw'],
  [0x60, 2, 0, 'f60'], [0x62, 2, 0, 'rpm'], [0x64, 1, 0, 'f64'], [0x65, 1, 0, 'flags65'], [0x66, 1, 0, 'trackOrder'],
  [0x67, 1, 0, 'pitSeq'], [0x68, 4, 0, 'speedSq'], [0x6c, 2, 1, 'f6C'], [0x6e, 2, 0, 'f6E'], [0x70, 2, 1, 'ccSpeed'],
  [0x72, 2, 1, 'acc'], [0x74, 2, 1, 'f74'], [0x76, 2, 1, 'f76'], [0x78, 2, 0, 'proxAhead'], [0x7a, 2, 0, 'pCarAhead'],
  [0x7c, 2, 1, 'steerRaw'], [0x7e, 1, 0, 'autoFlags'], [0x7f, 1, 0, 'digital'], [0x80, 2, 1, 'f80'],
  [0x82, 2, 0, 'pCar82'], [0x84, 1, 0, 'f84'], [0x85, 1, 0, 'aids'], [0x86, 2, 0, 'f86'], [0x88, 1, 0, 'f88'],
  [0x89, 1, 0, 'analog'], [0x8a, 2, 1, 'f8A'], [0x8c, 2, 1, 'heightAbove'], [0x8e, 2, 1, 'f8E'], [0x90, 2, 0, 'prevHeading'],
  [0x92, 4, 0, 'timerPit'], [0x96, 1, 0, 'flags96'], [0x97, 1, 0, 'flags97'], [0x98, 2, 0, 'throttle'],
  [0x9a, 1, 0, 'damage'], [0x9b, 1, 0, 'throttleRaw'], [0x9c, 2, 0, 'f9C'], [0x9e, 1, 0, 'frontWing'], [0x9f, 1, 0, 'rearWing'],
  [0xa0, 4, 0, 'tyreWear'], [0xa4, 4, 1, 'distSegs'], [0xa8, 2, 0, 'power'], [0xaa, 1, 0, 'racePos2'], [0xab, 1, 0, 'fAB'],
  [0xac, 1, 0, 'id'], [0xad, 1, 0, 'pitPos'], [0xae, 4, 0, 'bestLap'], [0xb2, 1, 0, 'tyre'], [0xb3, 1, 0, 'flagsB3'],
  [0xb4, 2, 0, 'speedNextCorner'], [0xb6, 2, 1, 'headPitch'], [0xb8, 2, 0, 'fB8'], [0xba, 2, 0, 'fBA'],
  [0xbc, 1, 0, 'flagsBC'], [0xbd, 1, 0, 'hotseat'], [0xbe, 2, 0, 'cornerFactor'],
];

function rd(buf, off, size, signed) {
  if (size === 1) return signed ? buf.readInt8(off) : buf.readUInt8(off);
  if (size === 2) return signed ? buf.readInt16LE(off) : buf.readUInt16LE(off);
  return signed ? buf.readInt32LE(off) : buf.readUInt32LE(off);
}

// Decode car i from a DS window buffer (DS offset 0 at buf[0]).
function decodeCar(ds, i) {
  const base = CAR0 + i * CAR_SIZE - DS_WIN[0];
  const c = { i, off: CAR0 + i * CAR_SIZE };
  for (const [o, size, sg, name] of CAR_FIELDS) c[name] = rd(ds, base + o, size, sg);
  return c;
}
const carBytes = (ds, i) => ds.subarray(CAR0 + i * CAR_SIZE - DS_WIN[0], CAR0 + (i + 1) * CAR_SIZE - DS_WIN[0]);

// ---------------------------------------------------------------- segments
// A memory reader over a full RAM dump (linear 0 = buf[0]) or live guest mem.
function ramReader(buf) {
  return {
    u8: (seg, off) => buf[((seg << 4) + off)],
    u16: (seg, off) => buf.readUInt16LE((seg << 4) + off),
    s16: (seg, off) => buf.readInt16LE((seg << 4) + off),
  };
}

function decodeSeg(m, seg, off) {
  return {
    off, angleZ: m.u16(seg, off), angleX: m.s16(seg, off + 2), posX: m.s16(seg, off + 4), posZ: m.s16(seg, off + 6),
    posY: m.s16(seg, off + 8), tex: m.u16(seg, off + 0x0a), sideX: m.s16(seg, off + 0x0c), sideY: m.s16(seg, off + 0x0e),
    f10: m.u8(seg, off + 0x10), extraX: m.u8(seg, off + 0x11), f12: m.u8(seg, off + 0x12), extraY: m.u8(seg, off + 0x13),
    dAngle: m.s16(seg, off + 0x14), ccLine: m.s16(seg, off + 0x16), ccAngle: m.s16(seg, off + 0x18), nr: m.u16(seg, off + 0x1a),
    segDist: m.u16(seg, off + 0x1c), obj: m.u8(seg, off + 0x1e), pitJoin: m.u8(seg, off + 0x1f), view: m.u8(seg, off + 0x20),
    fine: m.u8(seg, off + 0x21),
    x19: (m.s16(seg, off + 4) * 8) | (m.u8(seg, off + 0x21) & 7),
    y19: (m.s16(seg, off + 8) * 8) | ((m.u8(seg, off + 0x21) >> 4) & 7),
  };
}

// cos as gp.exe 0000:03C8 does it; tab(i) reads word i of the table at SS:3264.
function makeCos(tab) {
  return (a) => {
    a = s16(a & 0xffff); if (a < 0) a = -a; a &= 0xffff;
    const i = (a >> 3) & 0x1fff; // (a >> 2) & ~1 bytes = word index a >> 3
    const t0 = tab(i), t1 = tab(i + 1);
    return t0 + (((t1 - t0) * (a & 7)) >> 3);
  };
}

// World position (car+28/+2C units) of a car from its track-relative fields.
// seg = decodeSeg() of the segment car+12 points to; car = decodeCar().
function trackToWorld(seg, car, cos) {
  const lat = car.segPosX;
  let along = car.segDist;
  if (seg.dAngle) along = s16(along - s16(Math.floor((seg.dAngle * lat * 2) / 65536) & 0xffff));
  const a = seg.angleZ;
  const c = cos(a), s = cos((0x4000 - a) & 0xffff);
  const dx = Math.floor((lat * c + along * s) / 16384); // >> 14 of the 32-bit product
  const dy = Math.floor((along * c - lat * s) / 16384);
  const x19 = seg.x19 + s16(dx), y19 = seg.y19 + s16(dy);
  return { x19, y19, X: x19 * 256, Y: y19 * 256 };
}

module.exports = {
  CAR0, CAR_SIZE, NCARS, DS_REL, SS_REL, DS_WIN, SS_WIN, HDR, REC, MAGIC, KEYBITS, CAR_FIELDS,
  s16, wrap16, openSamples, encodeHeader, decodeCar, carBytes, ramReader, decodeSeg, makeCos, trackToWorld,
};
