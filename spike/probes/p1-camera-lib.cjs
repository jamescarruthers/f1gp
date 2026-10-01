// p1-camera-lib.cjs - shared code for the p1-camera probes (recorder and
// analysis): extra key codes, the recording file format, and decoders for
// the camera / view / frame-tick variables.
//
// Recording format (out/p1-camera/<run>/rec.bin): a sequence of records
//   header (32 bytes): magic 'P1CM', idx u32, type u8 (1 = DS:2955 changed,
//   i.e. a new game frame; 2 = periodic, no new frame for 100 ms), pad,
//   keys u32 (bit mask of held keys, KEYBITS), tReal f64 (ms since start of
//   recording), polls u32 (polls since the previous record), pad
//   then REGION bytes: guest linear DS<<4 .. (SS<<4)+0x10000, i.e. the whole
//   DS segment (gp.exe seg 1E61) and the whole SS segment (seg 2914), which
//   also covers seg 30CA up to offset 84A0.
// The fast log (fast.bin) has one 32-byte entry per poll in which any of the
// polled counters changed: tReal f64, SS:05D2 u16, SS:05C8 u16, DS:2955 u32,
// DS:294F u32, DS:2C63 u16, DS:0981 u8, pad, DS:097D u16, DS:097F u16, pad.
'use strict';

const fs = require('node:fs');

const DS_REL = 0x1e61, SS_REL = 0x2914;
const CAR0 = 0x0d1b, CAR_SIZE = 0xc0, NCARS = 26;
const HDR = 32;
const MAGIC = 0x4d433150; // 'P1CM'
const FAST = 32;

// Extra js-dos (GLFW) key codes not in lib/node-emu.cjs KEYS.
const XKEYS = { insert: 260, delete: 261, pageup: 266, pagedown: 267, home: 268, end: 269 };

const KEYBITS = {
  a: 1, z: 2, comma: 4, period: 8, left: 16, right: 32, up: 64, down: 128,
  home: 256, pagedown: 512, delete: 1024, space: 2048, p: 4096, esc: 8192, o: 16384,
};

function layout(imageSeg) {
  const DS = imageSeg + DS_REL, SS = imageSeg + SS_REL;
  const base = DS << 4;
  const len = ((SS << 4) + 0x10000) - base;
  return { DS, SS, base, len, dsOff: 0, ssOff: (SS << 4) - base };
}

// ---------------------------------------------------------------- recording file
function openRec(file, imageSeg) {
  const L = layout(imageSeg);
  const REC = HDR + L.len;
  const buf = fs.readFileSync(file);
  const n = Math.floor(buf.length / REC);
  const recs = [];
  for (let i = 0; i < n; i++) {
    const o = i * REC;
    if (buf.readUInt32LE(o) !== MAGIC) throw new Error(`bad magic at record ${i}`);
    const r = buf.subarray(o + HDR, o + REC);
    recs.push({
      idx: buf.readUInt32LE(o + 4), type: buf[o + 8], keys: buf.readUInt32LE(o + 12),
      t: buf.readDoubleLE(o + 16), polls: buf.readUInt32LE(o + 24),
      r, ...accessors(r, L),
    });
  }
  return { L, recs };
}

function accessors(r, L) {
  const ds = (off) => L.dsOff + off, ss = (off) => L.ssOff + off;
  return {
    d8: (o) => r[ds(o)], d16: (o) => r.readUInt16LE(ds(o)), ds16: (o) => r.readInt16LE(ds(o)),
    d32: (o) => r.readUInt32LE(ds(o)), ds32: (o) => r.readInt32LE(ds(o)),
    s8: (o) => r[ss(o)], s16: (o) => r.readUInt16LE(ss(o)), ss16: (o) => r.readInt16LE(ss(o)),
    s32: (o) => r.readUInt32LE(ss(o)), ss32: (o) => r.readInt32LE(ss(o)),
  };
}

function encodeHeader(idx, type, keys, t, polls) {
  const h = Buffer.alloc(HDR);
  h.writeUInt32LE(MAGIC, 0); h.writeUInt32LE(idx, 4); h[8] = type;
  h.writeUInt32LE(keys >>> 0, 12); h.writeDoubleLE(t, 16); h.writeUInt32LE(polls >>> 0, 24);
  return h;
}

function openFast(file) {
  const buf = fs.readFileSync(file);
  const out = [];
  for (let o = 0; o + FAST <= buf.length; o += FAST) {
    out.push({
      t: buf.readDoubleLE(o), tick: buf.readUInt16LE(o + 8), c8: buf.readUInt16LE(o + 10),
      clk: buf.readUInt32LE(o + 12), tim: buf.readUInt32LE(o + 16), c63: buf.readUInt16LE(o + 20),
      view: buf[o + 22], cam: buf.readUInt16LE(o + 24), sel: buf.readUInt16LE(o + 26),
    });
  }
  return out;
}

// ---------------------------------------------------------------- decoders
const s16 = (v) => (v << 16) >> 16;

// Camera / view state from a record (accessors d*/s* as above).
function camState(a) {
  return {
    view: a.d8(0x981), req: a.d8(0x983), d985: a.d16(0x985),
    camObj: a.d16(0x97d), selCar: a.d16(0x97f), player: a.d16(0x28fd),
    camX: a.ds32(0x2259), camY: a.ds32(0x225d), camYaw: a.d16(0x2261), camPitch: a.ds16(0x2257),
    cam2255: a.d16(0x2255), eye: a.ds16(0x233f), eyeCockpit: a.ds16(0x2253), eyeExt: a.ds16(0x2345),
    chaseDist: a.ds16(0x2347), d4d0: a.ds16(0x4d0), d0060: a.d16(0x60), d0062: a.d8(0x62), d2269: a.ds16(0x2269),
    sX8: a.ss32(0x142), sY8: a.ss32(0x14a), sX11: a.ss16(0x13c), sY11: a.ss16(0x140), sZ: a.ss16(0x13e),
    sZ0: a.ss16(0x152), lat: a.ss16(0x150), cos: a.ss16(0x154), sin: a.ss16(0x156), horizon: a.ss16(0x130),
    horizonMax: a.ss16(0x132), segYaw: a.d16 ? a.ss16(0x14e) : 0,
  };
}

function clockState(a) {
  return {
    clk: a.d32(0x2955), clkFrac: a.d16(0x2959), tim: a.d32(0x294f), timFrac: a.d16(0x2953),
    ticksFrame: a.s16(0x1230), tick300: a.s16(0x5d2), tick18: a.s16(0x5d4), sinceFlip: a.s16(0x5c8),
    used: a.d16(0x2c63), dtP: a.d16(0x2c59), dtP2: a.d16(0x2c5b), dtAI: a.d16(0x2c5d), half: a.d8(0x2c5f),
    fps: a.d16(0x2c61), frameMs: a.d32(0x2241), session: a.s8(0x124a), s124e: a.s8(0x124e),
    pauseA27: a.s8(0xa27), d2227: a.d8(0x2227), s1108: a.s8(0x1108), replay: a.d8(0x5a),
  };
}

function car(a, i) {
  const o = CAR0 + i * CAR_SIZE;
  return carAt(a, o);
}

function carAt(a, o) {
  return {
    off: o, id: a.d8(o + 0xac), speed: a.ds16(o + 0x10), heading: a.d16(o + 0x1a), m7e: a.d8(o + 0x7e),
    X: a.ds32(o + 0x28), Y: a.ds32(o + 0x2c), z: a.ds16(o + 0x08), pitch: a.ds16(o + 0x02),
    segOff: a.d16(o + 0x12), segSeg: a.d16(o + 0x14), lat: a.ds16(o + 0x0a), along: a.ds16(o + 0x1c),
    frac: a.ds16(o + 0x1e), order: a.d8(o + 0x66), f23: a.d8(o + 0x23), f96: a.d8(o + 0x96),
    hdPitch: a.ds16(o + 0xb6), f84: a.d8(o + 0x84), lap: a.d8(o + 0x22),
  };
}

const hex = (v, n = 4) => (v >>> 0).toString(16).toUpperCase().padStart(n, '0');

module.exports = {
  DS_REL, SS_REL, CAR0, CAR_SIZE, NCARS, HDR, MAGIC, FAST, XKEYS, KEYBITS,
  layout, openRec, openFast, accessors, encodeHeader, camState, clockState, car, carAt, hex, s16,
};
