// The racing cars as the game draws them, read from the game's memory, and
// turned into coloured triangles and bitmap sprites for the WebGL renderer.
//
// Every rule here is from docs/renderer-notes.md, section "Cars: shapes,
// placement and colours (decoded)". In short (gp.exe 1.05, European):
//   0F47:A533  picks the cars near the camera, in race order, and files each
//              one on a track segment so that it is drawn with the objects;
//   0F47:9E2A -> A07D  takes the pose from 0:14A2, adds the yaw wobble,
//              sets the team / helmet palettes and the steering, and draws
//              shape 0 (and any attached effect shape) through 0F47:88A5;
//   0F47:88A5  as for trackside objects (LOD by depth, 32 view sectors,
//              one-sided polygons), plus the car-only parts: the team-1 nose
//              (element block DS:7793), wheels framed by view angle and
//              steering, the helmet framed by view angle and steering, the
//              near-depth cut and, in the cockpit view, the mirror images.
//
// Units as in objects.mjs: X/Y fine units (1/64 ft), Z in Z units, angles
// 10000h = one turn, heading 0 = +Y, 4000h = +X.
//
// Plain ES module, no Node APIs: runs in Node and in the browser.

import {
  makeReader, makeTrig, decodeShape, shapePoints, polygonLoop, decodeSprite, spriteLodFrame,
  hazeLevel, assignLayers, spriteQuads,
} from './objects.mjs';

const s16 = (v) => (v << 16) >> 16;
const s8 = (v) => (v << 24) >> 24;

export const CAR0 = 0x0d1b, CAR_SIZE = 0xc0, NCARS = 26, SEG_SIZE = 0x2e;
export const CAR_SHAPE = 0;

// game DS
const DS = {
  shapes: 0x358d,      // shape table, 4-byte far pointers
  altElements: 0x7793, // element block of the team-1 car (immediate in 0F47:8E35)
  attach: 0x351b,      // 5 attached shapes of 16 bytes (0F47:A406)
  yawScale: 0x0156,    // yaw wobble factor: yaw += hi16(car+4A * this << 3)
  carsDrawn: 0x2225,   // how many cars A533 takes in race order (20)
  order: 0x0c65,       // car record offsets in race order (words)
  orderBytes: 0x0496, orderEnd: 0x049a, orderWrap: 0x221f,
  camObj: 0x097d, viewed: 0x097f, view: 0x0981, camSeg: 0x096f,
  track: 0x879f, pit: 0x8797, splice: 0x016e, camYaw: 0x2261,
};
// game SS
const SS = {
  palettes: 0x2964, helmets: 0x2aa4, cos: 0x3264, atan: 0x5268, reverse: 0x0136,
  lapEnd: 0x015c, lapBytes: 0x0158, trackSegVal: 0x0100, pitWalk: 0x0170,
  pitLo: 0x0160, pitHi: 0x0164, spriteSeg: 0x00f8, vscale: 0x017c, spriteVscale: 0x017e,
};
// renderer data segment (SS:00F4)
const R = { nearDepth: 0x58, mirrorLeft: 0x5a, mirrorRight: 0x5c, camAngle: 0x186, polyMode: 0xfa };
// the pit-lane junction pointers A533 reads (game DS)
const PJ = { pitEnd: 0x182, pitMap: 0x18a, pitStart2: 0x18e, pitA: 0x1a8, pitB: 0x1b4, pitSplit: 0x1cc };
const PALETTE_BYTES = 0x900;
const HAZE_SEG_REL = 0x7bce, HAZE_OFF = 0x7bc0;

// The car's attached effect shapes (DS:351B, index = A07D's "di"):
//   0: car+97 bit 80h  shape 8   behind the car, a running mechanic (bitmaps 9Bh-9Fh)
//   1: car+9A 10h+04h  shape 0Eh behind the car, a burst of debris (bitmaps 91h-9Ah)
//   2: car+9A 80h+20h  shape 0Fh at the rear wing: the broken rear wing (team colours)
//   3: car+9A 80h+40h  shape 10h at the nose, turned round: the broken front wing (team colours)
//   4: car+9A 10h      shape 0Eh in front, debris
// The +9A bits are set for the two cars of a contact (0:B9B0, B9D9).
export const ATTACHMENT_NAMES = ['mechanic', 'debris-rear', 'part-rear', 'part-front', 'debris-front'];

function decodeElement(rd, a) {
  const t = rd.u8(a++);
  if (!(t & 0x80)) {
    const edges = [];
    let v;
    while ((v = rd.s8(a++)) !== 0 && edges.length < 64) edges.push(v);
    const el = { kind: 'poly', colour: t & 0x3f, edges };
    if (t & 0x40) el.facePoint = rd.u8(a);
    return el;
  }
  if (t & 0x20) return { kind: 'line', type: t, colourByte: rd.u8(a), vector: rd.u8(a + 1) };
  const el = { kind: 'bitmap', type: t, point: rd.u8(a), maxDepth: rd.u8(a + 1) << 7, id: rd.u8(a + 2) };
  if (t & 2) el.palette = rd.u16(a + 3);
  return el;
}

// the same shape with its elements read from another element block (the
// display lists hold offsets from the element base, 0F47:8E2E-8E38)
function withElementBase(rd, shape, base) {
  const out = { ...shape, elemBase: base, elements: new Map() };
  for (const [o] of shape.elements) out.elements.set(o, decodeElement(rd, base + o));
  return out;
}

/**
 * Everything about the cars that stays fixed in a session: the car shape
 * (and the team-1 variant), the attached effect shapes, the 16-colour
 * palettes, the bitmap store, constants. `mem` from f1gp-mem.mjs.
 * The returned object also works as `objs` for objects.mjs buildSpriteAtlas
 * and spriteQuads (it has sprite(), palettes, vscale, spriteVscale).
 */
export function readCars(mem) {
  const B = mem.memBase, ds = mem.DS << 4, ss = mem.SS << 4;
  const rd = makeReader(() => mem.heap(), B);
  const cos = new Int16Array(4097);
  for (let i = 0; i < 4097; i++) cos[i] = rd.s16(ss + SS.cos + 2 * i);
  const trig = makeTrig(cos);
  const atan = new Uint16Array(256);
  for (let k = 0; k < 256; k++) atan[k] = rd.u16(ss + SS.atan + 16 * k);
  const shapePtr = (id) => rd.far(ds + DS.shapes + 4 * id);
  const car = decodeShape(rd, shapePtr(CAR_SHAPE));
  if (!car || !car.elements) throw new Error('car shape (id 0) not found');
  const carAlt = withElementBase(rd, car, ds + DS.altElements);
  const attach = [];
  const attachShapes = new Map();
  for (let k = 0; k < 5; k++) {
    const a = ds + DS.attach + 16 * k;
    const e = { index: k, name: ATTACHMENT_NAMES[k], dx: rd.s16(a), dy: rd.s16(a + 2), dz: rd.s16(a + 4), dyaw: rd.u16(a + 6), dpitch: rd.u16(a + 8), palette: rd.u16(a + 10), shape: rd.u16(a + 12) };
    attach.push(e);
    if (!attachShapes.has(e.shape)) attachShapes.set(e.shape, decodeShape(rd, shapePtr(e.shape)));
  }
  const R0 = rd.u16(ss + 0xf4) << 4;
  const spriteSeg = rd.u16(ss + SS.spriteSeg);
  const H = mem.heap();
  const hazeLin = ((mem.imageSeg + HAZE_SEG_REL) << 4) + HAZE_OFF;
  const spriteCache = new Map();
  return {
    mem, rd, cos, trig, atan, car, carAlt, attach, attachShapes,
    palettes: H.slice(B + ss + SS.palettes, B + ss + SS.palettes + PALETTE_BYTES),
    haze: mem.imageSeg ? H.slice(B + hazeLin, B + hazeLin + 1024) : null,
    spriteSeg, vscale: rd.u16(ss + SS.vscale), spriteVscale: rd.u16(ss + SS.spriteVscale),
    consts: {
      yawScale: rd.s16(ds + DS.yawScale), carsDrawn: rd.u16(ds + DS.carsDrawn),
      nearDepth: rd.s16(R0 + R.nearDepth), mirrorLeft: rd.u16(R0 + R.mirrorLeft), mirrorRight: rd.u16(R0 + R.mirrorRight),
      helmetBase: SS.helmets - SS.palettes,
    },
    sprite: (id) => {
      if (!spriteCache.has(id)) spriteCache.set(id, decodeSprite(rd, spriteSeg, id));
      return spriteCache.get(id);
    },
  };
}

/**
 * Per-frame draw state of every car record, as 0F47:A07D sets it up:
 *   x, y (fine) = the pose of 0:14A2 (car+28/+2C in physics mode, else from
 *   the segment) >> 8; z, pitch from 14A2; yaw = car+1A + hi16((car+4A *
 *   DS:0156) << 3); steer = car+48; palette = (team - 1) * 16 (offset into
 *   SS:2964); helmet = (number - 1) * 16 + 140h when the car has a driver
 *   (car+96 bit 20h clear), else null; alt = team 1 (its own nose elements).
 * @param {object} cars  readCars()
 * @param {object} st    readState(mem) of the same moment (for the poses)
 */
export function carStates(cars, st) {
  const { mem, rd } = cars;
  const ds = mem.DS << 4;
  return st.cars.map((c) => {
    const p = ds + c.ptr;
    const team = rd.u8(p + 0x25), id = rd.u8(p + 0xac);
    const f96 = rd.u8(p + 0x96), f97 = rd.u8(p + 0x97), f9a = rd.u8(p + 0x9a);
    const wobble = rd.s16(p + 0x4a);
    const yaw = (rd.u16(p + 0x1a) + (((wobble * cars.consts.yawScale) << 3) >> 16)) & 0xffff;
    const number = id & 0x3f;
    return {
      slot: c.slot, ptr: c.ptr, number, team, id,
      x: c.x >> 8, y: c.y >> 8, z: c.z, pitch: c.pitch & 0xffff, heading: rd.u16(p + 0x1a), wobble, yaw,
      steer: rd.s16(p + 0x48), palette: ((team - 1) << 4) & 0xffff,
      driver: (f96 & 0x20) === 0, helmet: (f96 & 0x20) === 0 ? ((number - 1) << 4) + cars.consts.helmetBase : null,
      alt: team === 1, f96, f97, f9a, race2: rd.s8(p + 0x66), segLin: (rd.u16(p + 0x14) << 4) + rd.u16(p + 0x12),
      pos: c.pos,
    };
  });
}

// ------------------------------------------------------------------ which cars

/**
 * The camera's segment walk (renderer-notes section 2) as far as the cars
 * need it: for a segment entry (linear address) the number of segments it
 * lies ahead of the camera's segment in the walk's direction, if the walk
 * lists objects there. Cars are marked in the band bytes +26/+2A/+0A only
 * (not +2B), so they are listed up to 58 segments ahead (and n, the view
 * distance), and up to 9 behind (58 in polygon mode).
 */
export function cameraWalk(cars) {
  const { mem, rd } = cars;
  const ds = mem.DS << 4, ss = mem.SS << 4, R0 = rd.u16(ss + 0xf4) << 4;
  const camOff = rd.u16(ds + DS.camSeg), camSegV = rd.u16(ds + DS.camSeg + 2);
  const tOff = rd.u16(ds + DS.track), tSeg = rd.u16(ds + DS.track + 2), lapEnd = rd.u16(ss + SS.lapEnd);
  const pOff = rd.u16(ds + DS.pit), pSeg = rd.u16(ds + DS.pit + 2);
  const inTrack = camSegV === tSeg && camOff >= tOff && camOff < lapEnd;
  const base = inTrack ? tOff : pOff, seg = inTrack ? tSeg : pSeg;
  const count = inTrack ? (lapEnd - tOff) / SEG_SIZE : 600;
  const idx = (camOff - base) / SEG_SIZE;
  const at = (k) => (seg << 4) + base + SEG_SIZE * (inTrack ? ((k % count) + count) % count : Math.max(0, k));
  const nr = (k) => rd.u16(at(k) + 0x1a) & 0x2fff;
  const reverse = (rd.u16(ss + SS.reverse) & 0x8000) !== 0;
  const v20 = (k) => rd.u8(at(idx + k) + 0x20);
  let nAhead;
  if (!reverse) nAhead = nr(idx) & 1 ? v20(1) + 1 : v20(0);
  else nAhead = nr(idx + 1) & 1 ? v20(1) : v20(2) - 1;
  const polygonMode = (rd.u8(R0 + R.polyMode) & 0x80) !== 0;
  const behind = polygonMode ? 58 : 9;
  const ahead = new Map();
  const dir = reverse ? -1 : 1;
  for (let k = Math.min(nAhead, 400); k >= -behind; k--) ahead.set(at(idx + dir * k), k);
  return {
    inTrack, reverse, nAhead, behind, polygonMode, camLin: at(idx), camNr: nr(idx),
    trackSeg: tSeg, pitSeg: pSeg, lapEnd, tOff, pOff,
    /** segments ahead of the camera (negative = behind), or undefined when not walked */
    aheadOf: (lin) => ahead.get(lin),
    /** would the walk list a car marked on this segment? */
    lists: (lin) => { const k = ahead.get(lin); return k !== undefined && k <= Math.min(nAhead, 58) && k >= -behind; },
  };
}

/**
 * The cars the game draws this frame and their drawing order, as 0F47:A533
 * chooses them: DS:2225 (20) cars in race order, from two places behind the
 * camera object's race position towards the leader (in a reverse view from
 * further back), wrapping round the order; not cars with car+96 bit 80h; not
 * the camera object itself unless car+9A bit 08h. Each car is filed on the
 * first segment at or after its own without an object (car+84 counts the
 * steps, from 1, or 2 when the camera looks across the track); its sort key
 * is that segment's walk counter - car+84, i.e. 1 (2) segment(s) nearer than
 * its own: drawn after the fences and kerbs of its own segment and before
 * those of the next nearer segment, among the objects (far to near).
 * @returns {{ drawn: object[], skipped: object[], walk: object }}
 *   drawn: { slot, state (carStates entry), segLin, ahead (segments, of the
 *   segment the car is filed on), steps (car+84), key (ahead - steps; larger =
 *   drawn earlier) } in the game's drawing order (far to near)
 */
export function selectCars(cars, states, opt = {}) {
  const { mem, rd } = cars;
  const ds = mem.DS << 4, ss = mem.SS << 4, R0 = rd.u16(ss + 0xf4) << 4;
  const walk = opt.walk ?? cameraWalk(cars);
  const drawn = [], skipped = [];
  const count0 = rd.u16(ds + DS.carsDrawn);
  if (!count0) return { drawn, skipped, walk };
  const base = rd.s16(R0 + R.camAngle) >= 0x2000 ? 2 : 1;
  const camObj = rd.u16(ds + DS.camObj);
  const idx2 = rd.s8(ds + camObj + 0x66);
  let bx = DS.order + idx2 + (walk.reverse ? (count0 - 2) * 2 : 6);
  if (bx < DS.order) bx += rd.u16(ds + DS.orderBytes);
  else if (bx >= rd.u16(ds + DS.orderEnd)) bx -= rd.u16(ds + DS.orderBytes);
  const taken = new Set(); // segments marked by earlier cars this frame
  const hasObject = (lin) => (rd.u8(lin + 0x26) & 0x80) !== 0 || taken.has(lin);
  let left = count0 - 1, cx = 26;
  while (true) {
    bx -= 2;
    let ax = rd.u16(ds + bx);
    if (ax & 0x8000) { bx += rd.u16(ds + DS.orderWrap); ax = rd.u16(ds + bx); }
    const slot = (ax / CAR_SIZE) | 0;
    const st = states[slot];
    if (!st || ax % CAR_SIZE) { skipped.push({ slot, reason: 'bad order entry' }); break; }
    if (st.f96 & 0x80) {
      skipped.push({ slot, reason: 'car+96 bit 80h (not drawn)' });
      if (--cx === 0) break;
      continue;
    }
    if (CAR0 + ax === camObj && !(st.f9a & 0x08)) skipped.push({ slot, reason: 'camera object' });
    else {
      let [sg, off] = mapPitSegment(cars, st, walk);
      let steps = base;
      // the first segment at or after the car's own without an object (A6AF)
      for (let guard = 0; hasObject((sg << 4) + off) && guard < 64; guard++) {
        steps++;
        [sg, off] = nextSegment(cars, sg, off, walk);
      }
      const lin = (sg << 4) + off;
      taken.add(lin);
      const ahead = walk.aheadOf(lin);
      const entry = { slot, state: st, segLin: lin, pitArray: sg !== walk.trackSeg, steps, ahead, key: ahead === undefined ? null : ahead - steps, race: (bx - DS.order) / 2 };
      if (walk.lists(lin)) drawn.push(entry);
      else skipped.push({ ...entry, reason: ahead === undefined ? 'segment not walked' : 'beyond the car bands' });
    }
    if (--cx === 0) break;
    if (--left < 0) break;
  }
  // drawing order: the walk lists objects far to near (by the segment a car is
  // filed on), then 0F47:53BF bubble-sorts the list by key, far first, keeping
  // the order of equal keys
  drawn.sort((a, b) => b.key - a.key || b.ahead - a.ahead);
  return { drawn, skipped, walk };
}

// the next segment entry (A6C4-A6EE): in the pit array up to R:182, then
// on at the far pointer R:18E; in the track array wrapping at the lap end
function nextSegment(cars, sg, off, walk) {
  const { rd, mem } = cars;
  const ss = mem.SS << 4, ds = mem.DS << 4;
  if (sg !== walk.trackSeg) {
    off += SEG_SIZE;
    if (off >= rd.u16(ds + PJ.pitEnd)) return [rd.u16(ds + PJ.pitStart2 + 2), rd.u16(ds + PJ.pitStart2)];
    return [sg, off];
  }
  off += SEG_SIZE;
  if ((off > 0xffff || off >= rd.u16(ss + SS.lapEnd)) && sg === rd.u16(ss + SS.trackSegVal)) off -= rd.u16(ss + SS.lapBytes);
  return [sg, off & 0xffff];
}

// A5DD-A6AB: which segment a car is filed on when it is near the pit lane:
// pit-array cars at the two ends of the pit lane are moved onto the parallel
// track segments; track cars at a pit junction onto the pit array; read from
// the junction pointers DS:0182/018A/018E/01A8/01B4/01CC and SS:0160/0164/0170.
function mapPitSegment(cars, st, walk) {
  const { rd, mem } = cars;
  const ds = mem.DS << 4, ss = mem.SS << 4;
  const p = ds + st.ptr;
  const di = rd.u16(p + 0x12), seg = rd.u16(p + 0x14);
  const tSeg = walk.trackSeg, pSeg = walk.pitSeg;
  const splice = rd.u8(ds + DS.splice);
  const keep = [seg, di];
  const toTrack = () => {
    if (splice) return keep;
    if (di < rd.u16(ds + PJ.pitSplit)) return [tSeg, (di - rd.u16(ds + DS.pit) + rd.u16(ds + PJ.pitMap)) & 0xffff];
    return [tSeg, (di - rd.u16(ds + PJ.pitSplit) + rd.u16(ds + DS.track)) & 0xffff];
  };
  if (!(rd.u16(ss + SS.pitWalk) & 0x8000)) {
    if (seg !== tSeg) {
      if (di < rd.u16(ds + PJ.pitA) || di >= rd.u16(ds + PJ.pitB)) return toTrack();
      return keep;
    }
    if (splice) return keep;
    const f = rd.u8((seg << 4) + di + 0x26) & 3;
    if (f === 0 || f === 3) return keep;
    let ax;
    if (f === 2) {
      ax = (rd.u16(ds + PJ.pitStart2) - di) & 0xffff;
      if (ax >= 0x8fc) return keep;
      ax = (-ax) & 0xffff;
      if (!(ax & 0x8000)) return keep;
      ax = (ax + rd.u16(ds + PJ.pitEnd)) & 0xffff;
      if (ax > rd.u16(ds + PJ.pitB)) return keep;
      if (!(ax < rd.u16(ss + SS.pitHi)) && !(rd.u8(p + 0x19) & 0x80)) return keep;
    } else {
      ax = (di - rd.u16(ds + PJ.pitMap)) & 0xffff;
      if (ax >= 0x8fc) return keep;
      ax = (ax + 0xd7ae) & 0xffff;
      if (ax < rd.u16(ds + PJ.pitA)) return keep;
      if (!(ax < rd.u16(ss + SS.pitLo)) && !(rd.u8(p + 0x19) & 0x80)) return keep;
    }
    return [pSeg, ax];
  }
  if (seg === tSeg) return keep;
  if (di < rd.u16(ss + SS.pitLo)) return toTrack();
  if (di < rd.u16(ss + SS.pitHi)) return keep;
  return toTrack();
}

// ------------------------------------------------------------------ one car

/** The game's steering term for wheels and helmet (0F47:8F1D): |s| < 200h ? 4|s| : (|s| - 200h)/2 + 800h, with the sign of s. */
export function steerAngle(s) {
  let a = Math.abs(s);
  a = a < 0x200 ? a << 2 : ((a - 0x200) >> 1) + 0x800;
  return s < 0 ? -a : a;
}

/** Wheel bitmap (ids < 42h; front wheels from 21h): frame and mirroring from the view angle a of its point (and the steering for front wheels). */
export function wheelFrame(id, a, steer) {
  let ax = a;
  if (id >= 0x21) ax += steerAngle(steer);
  ax &= 0x7fff;
  const mirrored = (ax & 0x4000) !== 0;
  if (ax > 0x4000) ax = 0x8000 - ax;
  return { id: ((ax + 0x100) >> 9) + id, mirrored };
}

/** Helmet bitmap (42h-4Ah): 9 frames over 180 degrees of view angle a (object yaw - camera yaw + ray), turned by the steering. */
export function helmetFrame(id, a, steer) {
  const ax = s16((steerAngle(steer) + a + 2 * steer) & 0xffff);
  return { id: ((Math.abs(ax) + 0x800) >> 12) + id, mirrored: ax < 0 };
}

/**
 * Camera space and the game's projection. cam = { x, y (fine), z, heading };
 * returns [lateral, depth, dz] with lateral/depth in 1/8 ft (the units of
 * the game's projection, 0F47:20D9).
 */
export function toCamera(cam, p) {
  const a = (cam.heading / 65536) * 2 * Math.PI, s = Math.sin(a), c = Math.cos(a);
  const dx = (p[0] - cam.x) / 8, dy = (p[1] - cam.y) / 8;
  return [dx * c - dy * s, dx * s + dy * c, p[2] - cam.z];
}

/** The game's column correction for a screen column (0F47:8BCB): -sign(col - 160) * atan[min(|col - 160|, 255)] (table SS:5268). */
export function columnCorrection(cars, col) {
  const d = col - 160, k = Math.min(Math.abs(d), 255);
  const v = cars.atan[k];
  return d < 0 ? v : (-v) & 0xffff;
}

function column(v, hi) {
  const k = hi ? 8 : 1;
  const L = Math.floor(v[0] * k), D = Math.max(1, Math.floor(v[1] * k));
  return 160 + Math.trunc((L * 256) / D);
}

/**
 * Point positions of a shape for a pose: world [x, y, z] (fine, Z units),
 * rotated by yaw, with the pitch as the shape drawer's tilt (Z += y * sin(pitch)).
 */
export function posePoints(cars, shape, lod, pose, pts = shapePoints(shape, lod)) {
  const { cos, sin } = cars.trig;
  const c = cos(pose.yaw) / 16384, s = sin(pose.yaw) / 16384, st = sin(pose.pitch);
  return pts.map((pt) => {
    // the tilt table holds hi16(v * sin << 2) for the scale value; a negative word negates it
    const tz = pt.y >= 0 ? Math.floor((pt.y * st) / 16384) : -Math.floor((-pt.y * st) / 16384);
    return [pose.x + pt.x * c + pt.y * s, pose.y - pt.x * s + pt.y * c, pose.z + shape.z12 + pt.z + tz];
  });
}

/**
 * The renderer's camera as the shape drawer uses it (for exact pixel work):
 * X/Y fine (SS:0142/014A, 32-bit), Z (SS:013E), cos/sin of the yaw (SS:0154/0156,
 * table values), horizon row (SS:0130), SS:017C.
 */
export function gameCamera(cars) {
  const { rd, mem } = cars;
  const ss = mem.SS << 4, ds = mem.DS << 4;
  const s32 = (a) => (rd.u16(a) | (rd.u16(a + 2) << 16)) | 0;
  return {
    X: s32(ss + 0x142), Y: s32(ss + 0x14a), Z: rd.s16(ss + 0x13e), cos: rd.s16(ss + 0x154), sin: rd.s16(ss + 0x156),
    heading: rd.u16(ds + DS.camYaw), horizon: rd.s16(ss + 0x130), vscale: rd.u16(ss + SS.vscale),
    mode: { 0x00: 'cockpit', 0x80: 'tv', 0xa0: 'chase', 0xb0: 'reverse-chase' }[rd.u8(ds + DS.view) & 0xb0] ?? 'tv',
  };
}

/**
 * The game's projection of a camera-space point (0F47:9110): x = 160 +
 * trunc(lat * 256 / dep); y = horizon - q, q = (hi16(dz * SS:017C * 2) * 32
 * [* 8 near]) / dep, rounded away from zero only when negative (the quirk of
 * renderer-notes "Projection quirk"). lat/dep in 1/8 ft, or 1/64 ft when near.
 * @returns {[number, number]} column, viewport row
 */
export function gameProject(gc, p, near) {
  const D = Math.max(1, p.dep | 0);
  const x = 160 + Math.trunc(((p.lat32 ?? p.lat * 256)) / D);
  const dzs = Math.floor((p.dz * gc.vscale * 2) / 65536);
  const n = dzs * 32 * (near ? 8 : 1);
  let q = Math.trunc(n / D);
  const r = n - q * D;
  if (r >= 0) { if ((q & 0xffff) >= D) q += 1; } else if (-2 * r >= D) q -= 1;
  return [x, gc.horizon - q];
}

// camera space, float (any camera): lat/dep in 1/8 ft (x8 when near), dz in Z units
function floatSpace(cars, cam, shape, pose) {
  const near = Math.abs(pose.x - cam.x) + shape.size < 0x3e80 && Math.abs(pose.y - cam.y) + shape.size < 0x3e80;
  const k = near ? 8 : 1;
  const conv = (w) => { const v = toCamera(cam, w); return { lat: v[0] * k, dep: v[1] * k, dz: v[2] }; };
  const ref = conv([pose.x, pose.y, pose.z + shape.z14]);
  return {
    near, k, ref,
    points: (sh, lod, P, W) => W.map(conv),
    col: (p) => (p.dep < 8 ? (p.lat < 0 ? 0 : 320) : 160 + Math.trunc((Math.floor(p.lat) * 256) / Math.max(1, Math.floor(p.dep)))),
  };
}

// camera space, the game's integer arithmetic (0F47:88A5, 20AB, 8C75, 90C3)
function gameSpace(cars, gc, shape, pose) {
  const { cos, sin } = cars.trig;
  let dX = pose.x - gc.X, dY = pose.y - gc.Y;
  const near = Math.abs(dX) + shape.size < 0x3e80 && Math.abs(dY) + shape.size < 0x3e80;
  if (!near) { dX >>= 3; dY >>= 3; }
  dX = s16(dX & 0xffff); dY = s16(dY & 0xffff);
  const c = gc.cos, s = gc.sin;
  const lat32 = ((dX * c - dY * s) | 0) >> 6;
  const ref = { lat: s16((lat32 >> 8) & 0xffff), lat32, dep: s16((((dY * c + dX * s) | 0) >> 14) & 0xffff), dz: s16((pose.z + shape.z14 - gc.Z) & 0xffff) };
  const arel = (pose.yaw - gc.heading) & 0xffff;
  const ca = cos(arel), sa = sin(arel), st = sin(pose.pitch);
  return {
    near, k: near ? 8 : 1, ref,
    points: (sh, lod) => {
      // the rotated scale values: table entries for the packed values; a negative
      // point word takes the negated entry
      const packed = [];
      for (let bit = 14, i = 0; bit >= 0; bit--, i++) if (lod.mask & (1 << bit)) packed.push(sh.scaleAt(i));
      const rot = (v, f) => (near ? Math.floor((v * f) / 16384) : Math.floor((v * f) / 131072));
      const T = (w, f, tilt) => {
        if (w === 0) return 0;
        const neg = w >= 34, j = ((neg ? w - 34 : w - 2) >> 1);
        const v = packed[j] ?? 0;
        const e = tilt ? (f ? Math.floor((v * f) / 16384) : 0) : rot(v, f);
        return neg ? -e : e;
      };
      const dz0 = ref.dz + sh.z12 - sh.z14;
      const raw = [];
      const count = shapePoints(sh, lod).length;
      for (let i = 0; i < count; i++) raw.push(sh.rawPoint(i));
      const out = new Array(count);
      const calc = (i) => {
        if (out[i]) return out[i];
        const r = raw[i];
        if (r.wx & 0x8000) {
          const j = r.wx & 0x7fff, q = calc(j);
          out[i] = { lat: q.lat, dep: q.dep, dz: s16((r.z + T(raw[j].wy, st, true) + dz0) & 0xffff), ref: j };
        } else {
          const X = T(r.wx, ca) + T(r.wy, sa), Y = T(r.wy, ca) - T(r.wx, sa);
          out[i] = { lat: s16((ref.lat + X) & 0xffff), dep: s16((ref.dep + Y) & 0xffff), dz: s16((r.z + T(r.wy, st, true) + dz0) & 0xffff) };
        }
        return out[i];
      };
      for (let i = 0; i < count; i++) calc(i);
      return out;
    },
    col: (p) => (p.dep < 8 ? (p.lat < 0 ? 0 : 320) : 160 + Math.trunc((p.lat32 ?? p.lat * 256) / p.dep)),
  };
}

/**
 * What 0F47:88A5 draws for one shape (the car or an attached effect) in one
 * pose, in the game's order, for camera cam = { x, y, z, heading, mode }.
 * pose = { x, y, z, yaw, pitch, steer, palette, helmet, driver, alt, shapeId }.
 * opt.wide: use the true ray angle instead of the game's capped table.
 * opt.game: gameCamera(cars): decide everything with the game's integer
 *   arithmetic (exact columns, partner nudges and face tests) and return each
 *   element's camera-space points (g) for a pixel-exact software renderer.
 * @returns {{ kind: 'polygons'|'bitmap'|'mirror'|'none', reason?, depth8, lod, sector, a, ref, near,
 *   haze, elements: ({kind:'poly', pts, g, cols, colour, code}|{kind:'bitmap', at, g, col, id, mirrored, palette, what, depth8})[] }}
 */
export function shapeParts(cars, shape, pose, cam, opt = {}) {
  const out = { kind: 'none', elements: [] };
  if (!shape) return out;
  const ref = [pose.x, pose.y, pose.z + shape.z14];
  out.ref = ref;
  const sp = opt.game ? gameSpace(cars, opt.game, shape, pose) : floatSpace(cars, cam, shape, pose);
  const near = sp.near;
  out.near = near;
  const depth8 = Math.floor(sp.ref.dep / sp.k);
  out.depth8 = depth8;
  const heading = opt.game ? opt.game.heading : cam.heading;
  const r42 = (pose.yaw - heading) & 0xffff;
  const corrOfCol = (col) => columnCorrection(cars, col);
  const rayCorr = (p) => {
    const ang = Math.round((Math.atan2(p.lat, p.dep) / (2 * Math.PI)) * 65536);
    return (-Math.max(-0x2000, Math.min(0x2000, ang))) & 0xffff;
  };
  if (pose.shapeId === CAR_SHAPE && depth8 < cars.consts.nearDepth) {
    // 0F47:89F5: nearer than R:58 (26 = 3.25 ft) or behind: in the cockpit view
    // the car goes to a mirror (8A1D), in other views it is not drawn
    out.kind = (opt.game ? opt.game.mode : cam.mode) === 'cockpit' ? 'mirror' : 'none';
    out.reason = 'nearer than R:58';
    return out;
  }
  let lod = shape.lods.find((l) => Math.max(depth8, 0) <= l.max) ?? shape.lods[shape.lods.length - 1];
  // modern style: the car's polygon model at every distance (the game switches to a bitmap beyond 52 ft)
  if (opt.modern && lod.sprite && pose.shapeId === CAR_SHAPE) lod = shape.lods.find((l) => !l.sprite) ?? lod;
  out.lod = lod;
  const r44 = opt.wide ? rayCorr(sp.ref) : corrOfCol(sp.col(sp.ref));
  const a = (r42 + r44) & 0xffff;
  out.a = a;
  if (lod.sprite) {
    // bitmap LOD (9A75): one frame at the reference point, by view angle
    if (sp.ref.dep < 8) { out.reason = 'behind'; return out; }
    const f = spriteLodFrame(lod, a);
    if (!f) { out.reason = 'no frame'; return out; }
    if (!f.polygons) {
      out.kind = 'bitmap';
      out.haze = hazeLevel(depth8);
      out.elements.push({ kind: 'bitmap', at: ref, g: sp.ref, id: f.id, mirrored: f.mirrored, palette: pose.palette, what: 'far', depth8 });
      return out;
    }
    lod = shape.lods.find((l) => !l.sprite);
  }
  const sh = pose.alt ? cars.carAlt : shape;
  const P = cachedPoints(sh, lod);
  const W = posePoints(cars, sh, lod, pose, P);
  const C = sp.points(sh, lod, P, W);
  // visibility list: all behind, all left or all right of the screen -> nothing
  if (sh.vis && sh.vis.length) {
    let allBehind = true, allLeft = true, allRight = true;
    for (const i of sh.vis) {
      const c = C[i];
      if (c.dep >= 8) {
        allBehind = false;
        const x = sp.col(c);
        if (x >= 0) allLeft = false;
        if (x < 320) allRight = false;
      } else { allLeft = allLeft && c.lat < 0; allRight = allRight && c.lat >= 0; }
    }
    if (allBehind || allLeft || allRight) { out.reason = 'outside the view'; return out; }
  }
  out.kind = 'polygons';
  out.haze = hazeLevel(Math.max(depth8, shape.size >> 3));
  const nd = lod.dirs.length;
  const sector = (a >> ((lod.shift & 15) + 1)) % nd;
  out.sector = sector;
  // the game projects a point when an element first uses it (vector by vector,
  // first point then second); a point whose partner (point word +6) is already
  // on the same column moves one column right (0F47:9224)
  const proj = new Map();
  const projectPoint = (i) => {
    let r = proj.get(i);
    if (r) return r;
    const c = C[i];
    r = c.dep < 8 ? { behind: true, x: c.lat < 0 ? 0 : 320 } : { behind: false, x: sp.col(c) };
    const q = P[i].partner;
    const rq = q ? proj.get(q) : null;
    if (!r.behind && C[i].ref === undefined && rq && !rq.behind && rq.x === r.x) r.x += 1;
    proj.set(i, r);
    return r;
  };
  for (const o of lod.dirs[sector]) {
    const el = sh.elements.get(o);
    if (!el) continue;
    if (el.kind === 'poly') {
      for (const e of el.edges) { const [va, vb] = sh.vector(Math.abs(e)); projectPoint(va); projectPoint(vb); }
      if (el.facePoint !== undefined) {
        // drawn only when the point is not right of its partner on the screen (0F47:99F8:
        // the slot word +6 compared is the projected column)
        const p = el.facePoint, q = P[p]?.partner ?? 0;
        const rp = projectPoint(p), rq = projectPoint(q);
        if (!rp.behind && !rq.behind && rp.x > rq.x) continue;
      }
      const loop = polygonLoop(sh, el);
      if (loop.length < 3) continue;
      out.elements.push({ kind: 'poly', pts: loop.map((i) => W[i]), g: loop.map((i) => C[i]), cols: loop.map((i) => proj.get(i)?.x ?? null), code: el.colour, colour: cars.palettes[(pose.palette + el.colour) & 0xffff] ?? 0, order: o, face: el.facePoint });
    } else if (el.kind === 'bitmap') {
      if (opt.modern && el.id < 0x4b) continue; // modern style: 3D wheels and helmet below
      if (el.type & 0x10 && !pose.driver) continue; // the driver's parts (helmet)
      const pc = C[el.point];
      if (!pc || pc.dep < 8) continue;
      const pcol = projectPoint(el.point).x;
      const d8 = Math.floor(pc.dep / sp.k);
      if ((el.maxDepth) < d8) continue;
      let id = el.id, mirrored, palette = el.type & 2 ? el.palette : pose.palette, what = 'bitmap';
      if (id >= 0x4b) {
        let m = el.type & 4 ? 1 : (r42 + 0x4000) & 0xffff;
        if (el.type & 8) m = (-m) & 0xffff;
        mirrored = (m & 0x8000) !== 0;
      } else if (id >= 0x42) {
        const f = helmetFrame(id, (r42 + r44) & 0xffff, pose.steer);
        id = f.id; mirrored = f.mirrored; palette = pose.helmet ?? pose.palette; what = 'helmet';
      } else {
        const f = wheelFrame(id, (r42 + (opt.wide ? rayCorr(pc) : corrOfCol(pcol))) & 0xffff, pose.steer);
        what = id >= 0x21 ? 'front wheel' : 'rear wheel';
        id = f.id; mirrored = f.mirrored;
      }
      out.elements.push({ kind: 'bitmap', at: W[el.point], g: pc, col: pcol, id, mirrored, palette, what, depth8: d8, order: o });
    } else if (el.kind === 'line') {
      const [ia, ib] = sh.vector(el.vector);
      out.elements.push({ kind: 'line', a: W[ia], b: W[ib], colour: cars.palettes[pose.palette & 0xffff] ?? 0, order: o });
    }
  }
  if (opt.modern) {
    // modern style: every wheel and the helmet as geometry at its bitmap's anchor (the
    // wheel's hub, the helmet's centre), turned as the game turns their bitmaps
    for (const el of sh.elements.values()) {
      if (el.kind !== 'bitmap' || el.id >= 0x4b || !W[el.point]) continue;
      if (el.type & 0x10 && !pose.driver) continue;
      if (el.id >= 0x42) {
        out.elements.push({ kind: 'helmet3d', at: W[el.point], yaw: (pose.yaw + steerAngle(pose.steer) + 2 * pose.steer) & 0xffff, palette: pose.helmet ?? pose.palette, what: 'helmet' });
      } else {
        const front = el.id >= 0x21;
        out.elements.push({ kind: 'wheel3d', at: W[el.point], front, yaw: (pose.yaw + (front ? steerAngle(pose.steer) : 0)) & 0xffff,
          palette: el.type & 2 ? el.palette : pose.palette, what: front ? 'front wheel' : 'rear wheel' });
      }
    }
  }
  return out;
}

/** Pose of attached effect shape k (0F47:A406): offsets rotated by the car's yaw, Z raised by the car's pitch; yaw/pitch added. */
export function attachmentPose(cars, c, k) {
  const e = cars.attach[k];
  // A2CC loads the entry's palette (+0A); A30A draws the broken parts 2 and 3
  // through A2D3, which skips that load: they keep the team palette
  const palette = k === 2 || k === 3 ? c.palette : e.palette;
  const { cos, sin } = cars.trig;
  const co = cos(c.yaw), si = sin(c.yaw);
  const dx = ((e.dx * co + e.dy * si) << 2) >> 16;
  const dy = ((e.dy * co - e.dx * si) << 2) >> 16;
  const dz = e.dz + ((((sin(c.pitch) * e.dy) << 2)) >> 16);
  return {
    x: c.x + dx, y: c.y + dy, z: c.z + dz, yaw: (c.yaw + e.dyaw) & 0xffff, pitch: (c.pitch + e.dpitch) & 0xffff,
    steer: c.steer, palette, helmet: c.helmet, driver: c.driver, alt: false, shapeId: e.shape, attachment: k,
  };
}

/**
 * Everything drawn for one car (0F47:A07D, A1C1, A30A), in the game's order:
 * the car and its attached effect shapes (car+97 bit 80h, car+9A bits).
 * @returns {{ slot, parts: ({ what: 'car'|attachment name, pose, shape, ...shapeParts })[] }}
 */
export function carParts(cars, c, cam, opt = {}) {
  const parts = [];
  const pose = { ...c, shapeId: CAR_SHAPE };
  const car = () => parts.push({ what: 'car', pose, shape: cars.car, ...shapeParts(cars, cars.car, pose, cam, opt) });
  const att = (k) => {
    const p = attachmentPose(cars, c, k);
    const sh = cars.attachShapes.get(p.shapeId);
    parts.push({ what: ATTACHMENT_NAMES[k], pose: p, shape: sh, ...shapeParts(cars, sh, p, cam, opt) });
  };
  // A30A: the car with the broken parts of a contact
  const carWithParts = () => {
    if (!(c.f9a & 0x80)) { car(); return; }
    let di = 0;
    if (c.f9a & 0x40) {
      // the ray from the camera to the car, within 16C2h of the camera's yaw, against the car's yaw
      const ray = Math.round((Math.atan2(c.x - cam.x, c.y - cam.y) / (2 * Math.PI)) * 65536);
      let rel = s16((ray - cam.heading) & 0xffff);
      rel = Math.max(-0x16c2, Math.min(0x16c2, rel));
      di = Math.abs(s16((rel + cam.heading - c.yaw) & 0xffff));
    }
    if (c.f9a & 0x40 && di >= 0x4000) { car(); att(3); }
    else if (c.f9a & 0x40 && di >= 0x1000) { att(3); car(); }
    else car();
    if (c.f9a & 0x20) att(2);
  };
  // A1C1: an attachment drawn before or after the car, whichever is farther from the camera first
  const withAttachment = (k) => {
    const p = attachmentPose(cars, c, k);
    const da = (p.x - cam.x) ** 2 + (p.y - cam.y) ** 2, dc = (c.x - cam.x) ** 2 + (c.y - cam.y) ** 2;
    if (da < dc) { carWithParts(); att(k); } else { att(k); carWithParts(); }
  };
  if (c.f97 & 0x80) withAttachment(0);
  else if (c.f9a & 0x10) {
    if (!(c.f9a & 0x04)) { if (opt.cameraObject) att(4); else withAttachment(4); }
    else withAttachment(1);
  } else carWithParts();
  return { slot: c.slot, parts };
}

// ------------------------------------------------------------------ mirrors

/**
 * Cars in the cockpit mirrors (0F47:8A1D-8B9E): a listed car whose reference
 * point is nearer than R:58 (or behind the camera) is drawn, in the cockpit
 * view only, as its far bitmap in a mirror: left mirror (lateral < 0) or
 * right, view turned by R:5A (9000h) / R:5C (7000h), lateral mirrored, depth
 * x4, column + -140 (it must stay on its side of the screen), at row
 * 123 + (anchor row - horizon), clipped to rows 116-137 and the mirror
 * outline (table SS:63DE). Only cars, no scenery.
 * @returns {{ x, row, id, mirrored, depth8, side }|null} x = anchor column, row = anchor screen row in the cockpit frame
 */
export function mirrorImage(cars, c, cam, gc = null) {
  const shape = cars.car;
  let lat, dep;
  if (gc) {
    const g = gameSpace(cars, gc, shape, { ...c });
    lat = g.ref.lat; dep = g.ref.dep;
    if (g.near) { lat >>= 3; dep >>= 3; }
  } else {
    const v = toCamera(cam, [c.x, c.y, c.z + shape.z14]);
    lat = Math.trunc(v[0]); dep = Math.trunc(v[1]);
  }
  const left = lat < 0;
  const off = left ? -140 : 140, ang = left ? cars.consts.mirrorLeft : cars.consts.mirrorRight;
  const { cos, sin } = cars.trig;
  const co = cos(ang), si = sin(ang);
  const A = (lat * co - dep * si) | 0, B = (dep * co + lat * si) | 0;
  const dep2 = s16((B >> 12) & 0xffff);                 // hi16(B << 4): 4x the depth
  const lat32 = (-A | 0) >> 6;                           // the mirrored lateral, x 256
  if (dep2 < 8) return null;
  const x = 160 + Math.trunc(lat32 / dep2) + off;
  if (((x - 160) ^ off) < 0) return null;
  const lod = shape.lods[shape.lods.length - 1];
  if (!lod.sprite) return null;
  const heading = gc ? gc.heading : cam.heading;
  const r42 = (-(((c.yaw - heading) & 0xffff) - ang)) & 0xffff;
  const r44 = columnCorrection(cars, x - off);
  const f = spriteLodFrame(lod, (r42 + r44) & 0xffff);
  if (!f || f.polygons) return null;
  return { x, row: 123, id: f.id, mirrored: f.mirrored, depth8: dep2, side: left ? 'left' : 'right', palette: c.palette };
}

/**
 * The mirror outlines (0F47:1C01, 1D6A): screen rows 116-137, each with a span
 * [left, right) and a gap [gapLeft, gapRight) between the two mirrors, read from
 * the tables at SS:63DE (+1F2h left, +298h right, +A6h / +14Ch the gap).
 * @returns {{ row, active, left, right, gapLeft, gapRight }[]}
 */
export function mirrorClip(cars) {
  const { rd, mem } = cars;
  const ss = mem.SS << 4, out = [];
  for (let r = 116; r < 138; r++) {
    const b = ss + 0x63de + 2 * (r - 116);
    out.push({ row: r, active: rd.u16(b) !== 0, left: rd.s16(b + 0x1f2), right: rd.s16(b + 0x298), gapLeft: rd.s16(b + 0xa6), gapRight: rd.s16(b + 0x14c) });
  }
  return out;
}

// ------------------------------------------------------------------ frame

/**
 * What the game draws for the cars this frame, for the WebGL renderer, in
 * the formats of objects.mjs: buildSectorMesh's mesh (x, y, z, r, g, b per
 * vertex relative to `origin`; with opt.indexed colours are (palette index,
 * -1, 0)) holding only this frame's chosen faces, and frameObjects' result
 * (vertex indices by decal layer, sprites with their frame and mirroring).
 * Draw the triangles like the objects (one-sided: gl.CULL_FACE, front faces
 * counter-clockwise; layer k > 0 with polygonOffset), and the bitmaps with
 * carSpriteQuads() and the objects' sprite shader.
 *
 * @param {object} cars   readCars(mem)
 * @param {object} st     readState(mem) (the poses; use the state of the frame shown)
 * @param {object} cam    { x, y (fine), z, heading, mode ('cockpit'|'chase'|'tv'|...) }
 * @param {object} [opt]  { origin: [x, y], indexed (default true), palette (RGB, if not indexed),
 *   states: carStates() entries to draw instead of reading them (for example
 *   lerpCarStates() between two frames), drawn: selectCars().drawn taken at the same
 *   consistent read as the states (the selection and order to use), wide: true to take the true ray angle for
 *   sectors and wheel frames (views wider than the game's), all: draw every car record
 *   (not only the game's selection), wheelBias: depth bias of wheel bitmaps as a fraction
 *   of their width (default 0.25), modern: true for the modern style (the polygon model at
 *   every distance; 3D wheels and helmets, shaded in RGB from paletteRgb, the live palette,
 *   768 bytes 0-255) }
 * @returns {{ mesh, frame, list, mirrors, solid }}
 *   solid: modern style's wheels and helmets (Float32Array, x, y, z, r, g, b per vertex, triangles);
 *   list: per drawn car { slot, key, parts } (shapeParts results); mirrors: mirrorImage() results
 *   (cars the cockpit mirrors show; the game draws them as bitmaps into its own cockpit image)
 */
export function frameCars(cars, st, cam, opt = {}) {
  const origin = opt.origin ?? [cam.x, cam.y];
  const indexed = opt.indexed ?? true;
  const pal = opt.palette;
  const rgb = indexed ? (i) => [i, -1, 0] : (i) => [pal[i * 3] / 255, pal[i * 3 + 1] / 255, pal[i * 3 + 2] / 255];
  const states = opt.states ?? carStates(cars, st);
  let chosen;
  if (opt.drawn) chosen = opt.drawn.map((e) => ({ ...e, state: states[e.slot] ?? e.state }));
  else if (opt.all) chosen = states.filter((c) => c.pos !== 'none' && !(c.f96 & 0x80)).map((c) => ({ slot: c.slot, state: c, key: 0 }));
  else chosen = selectCars(cars, states).drawn;
  const camObjSlot = st.view && st.view.mode === 'cockpit' ? st.view.viewedSlot : null;
  const data = [], vobj = [], lines = [], lineObj = [], sprites = [], objects = [], placements = [];
  const layers = [[]], frSprites = [], frLines = [];
  const list = [], mirrors = [];
  const vtx = (p, c, oi) => { data.push(p[0] - origin[0], p[1] - origin[1], p[2], c[0], c[1], c[2]); vobj.push(oi); };
  const wheelBias = opt.wheelBias ?? 0.25;
  const solids = [];
  for (const e of chosen) {
    const c = e.state;
    if (opt.all && c.slot === camObjSlot && !(c.f9a & 0x08)) continue;
    const cp = carParts(cars, c, cam, { wide: opt.wide, cameraObject: c.slot === camObjSlot, modern: opt.modern });
    list.push({ slot: c.slot, key: e.key, parts: cp.parts });
    // parts painted after the car (broken wings over its own wings) go on higher decal layers
    let layerBase = 0, carTop = 0, carSeen = false;
    for (const part of cp.parts) {
      if (part.kind === 'mirror') { const m = mirrorImage(cars, c, cam); if (m) mirrors.push({ slot: c.slot, ...m }); continue; }
      if (part.what === 'car') carSeen = true;
      if (part.kind === 'none') continue;
      layerBase = part.what !== 'car' && carSeen ? carTop + 1 : 0;
      const oi = objects.length;
      const ref = part.ref;
      objects.push({ x: ref[0] - origin[0], y: ref[1] - origin[1], z: ref[2], size: part.shape ? part.shape.size : 0, slot: c.slot, what: part.what, haze: part.haze ?? 0 });
      const polys = [];
      for (const el of part.elements) {
        if (el.kind === 'poly') {
          // the outline runs clockwise on the screen from the visible side; reversed it is the GL front face
          polys.push({ pts: el.pts, colour: el.colour, facing: normalOf(el.pts).map((x) => -x), el });
        } else if (el.kind === 'bitmap') {
          const spr = cars.sprite(el.id);
          const w = spr ? (spr.maxC - spr.minC) * ((spr.size & 0x3fff) / 32) : 0;
          const bias = el.what === 'far' ? 0 : el.what.endsWith('wheel') ? w * wheelBias : w / 2;
          frSprites.push({ sprite: sprites.length, id: el.id, mirrored: el.mirrored });
          sprites.push({ at: [el.at[0] - origin[0], el.at[1] - origin[1], el.at[2]], id: el.id, palette: el.palette, mirrorSet: el.mirrored, onPolygons: false, bias, what: el.what, object: oi, slot: c.slot, maxDepth: 0, ray: false, yaw: part.pose.yaw });
        } else if (el.kind === 'wheel3d' || el.kind === 'helmet3d') {
          solids.push(el);
        } else if (el.kind === 'line') {
          frLines.push(lines.length / 6, lines.length / 6 + 1);
          for (const p of [el.a, el.b]) lines.push(p[0] - origin[0], p[1] - origin[1], p[2], ...rgb(el.colour));
          lineObj.push(oi, oi);
        }
      }
      assignLayers(polys);
      for (const poly of polys) {
        const P = [...poly.pts].reverse();
        const col = rgb(poly.colour);
        const layer = layerBase + poly.layer;
        if (part.what === 'car') carTop = Math.max(carTop, layer);
        while (layers.length <= layer) layers.push([]);
        for (const t of cachedTriangles(part, poly, P)) for (const k of t) { layers[layer].push(data.length / 6); vtx(P[k], col, oi); }
      }
      placements.push({ centre: [ref[0] - origin[0], ref[1] - origin[1], ref[2]], yaw: part.pose.yaw, object: oi, palette: part.pose.palette, slot: c.slot, what: part.what });
    }
  }
  const mesh = {
    data: new Float32Array(data), origin, lines: new Float32Array(lines), sprites, objects, placements,
    vertexObject: Uint32Array.from(vobj), lineObject: Uint32Array.from(lineObj),
    counts: { cars: list.length, triangles: data.length / 18, sprites: sprites.length },
  };
  const frame = { layers: layers.map((l) => Uint32Array.from(l)), crowd: new Uint32Array(0), lines: Uint32Array.from(frLines), sprites: frSprites };
  // modern style: wheels and helmets as shaded RGB triangles (x, y, z relative to origin, r, g, b),
  // one-sided (counter-clockwise from outside), drawn without the game's haze
  let n = 0;
  for (const el of solids) n += solidTriangles(cars, el).length * 18;
  const solid = new Float32Array(n);
  let o = 0;
  for (const el of solids) o = emitSolid(cars, opt.paletteRgb, el, solid, o, origin);
  mesh.counts.triangles += n / 18;
  return { mesh, frame, list, mirrors, solid };
}

// ------------------------------------------------------------------ modern style: 3D wheels and helmets

// Sizes from the game's bitmaps (fine units = Z units = 1/64 ft): a wheel seen
// side-on is 154 across with its anchor at the hub; seen end-on a rear tyre is
// about 124 wide and a front one 86. The helmet bitmap is 87 wide and 72 tall,
// anchored at its centre.
const WHEEL_R = 77, WHEEL_W = { front: 86, rear: 124 }, HUB_R = 0.5, WHEEL_SIDES = 10;
const HELMET = { lat: 40, fwd: 44, up: 34, rows: 6, cols: 10 };
const LIGHT = (() => { const v = [0.35, 0.25, 0.9], n = Math.hypot(...v); return v.map((x) => x / n); })();

// Triangles in an object's own frame: points [forward, right, up], the
// outward normal, and the colour code. Built once.
function solidTemplates(cars) {
  if (cars.solidTemplates) return cars.solidTemplates;
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  // one triangle facing away from `centre` (vertices ordered counter-clockwise seen from outside)
  const tri = (out, a, b, c, centre, code) => {
    let n = cross(sub(b, a), sub(c, a));
    const m = [(a[0] + b[0] + c[0]) / 3 - centre[0], (a[1] + b[1] + c[1]) / 3 - centre[1], (a[2] + b[2] + c[2]) / 3 - centre[2]];
    if (n[0] * m[0] + n[1] * m[1] + n[2] * m[2] < 0) { [b, c] = [c, b]; n = n.map((x) => -x); }
    const l = Math.hypot(...n) || 1;
    out.push({ p: [a, b, c], n: n.map((x) => x / l), code });
  };
  const quad = (out, a, b, c, d, centre, code) => { tri(out, a, b, c, centre, code); tri(out, a, c, d, centre, code); };
  const wheel = (width) => {
    const out = [], hw = width / 2, N = WHEEL_SIDES;
    const ring = (r, side) => Array.from({ length: N }, (_, i) => { const t = (2 * Math.PI * i) / N; return [r * Math.cos(t), side * hw, r * Math.sin(t)]; });
    const oL = ring(WHEEL_R, -1), oR = ring(WHEEL_R, 1), iL = ring(WHEEL_R * HUB_R, -1), iR = ring(WHEEL_R * HUB_R, 1);
    const cL = [0, -hw, 0], cR = [0, hw, 0];
    for (let i = 0; i < N; i++) {
      const j = (i + 1) % N;
      quad(out, oL[i], oL[j], oR[j], oR[i], [0, 0, 0], 0);   // tread: tyre, code 0
      quad(out, oL[i], oL[j], iL[j], iL[i], cR, 0);          // sidewalls face along the axle
      quad(out, oR[i], oR[j], iR[j], iR[i], cL, 0);
      tri(out, iL[i], iL[j], cL, cR, 10);                    // hubs: code 10
      tri(out, iR[i], iR[j], cR, cL, 10);
    }
    return out;
  };
  // the helmet's shell takes, band by band from the top, the codes of the
  // rear-view helmet bitmap (42h) down its middle; the visor code 0
  const spr = cars.sprite(0x42);
  const bands = spr ? spr.runs.map((row) => { const r = row.find(([c0, c1]) => c0 <= 0 && c1 > 0) ?? row[0]; return r ? r[2] : 0; }) : [0];
  const helmet = [];
  const { rows, cols } = HELMET;
  const P = (k, i) => {
    const phi = Math.PI / 2 - (Math.PI * k) / rows, lam = (2 * Math.PI * i) / cols;
    return [HELMET.fwd * Math.cos(phi) * Math.cos(lam), HELMET.lat * Math.cos(phi) * Math.sin(lam), HELMET.up * Math.sin(phi)];
  };
  for (let k = 0; k < rows; k++) {
    const band = bands[Math.min(bands.length - 1, Math.floor(((k + 0.5) / rows) * bands.length))];
    for (let i = 0; i < cols; i++) {
      const j = (i + 1) % cols, lam = (2 * Math.PI * (i + 0.5)) / cols;
      const code = Math.cos(lam) > 0.6 && (k === 2 || k === 3) ? 0 : band; // the visor: front, just above the middle
      const a = P(k, i), b = P(k, j), c = P(k + 1, j), d = P(k + 1, i);
      if (k === 0) tri(helmet, a, c, d, [0, 0, 0], code);
      else if (k === rows - 1) tri(helmet, a, b, c, [0, 0, 0], code);
      else quad(helmet, a, b, c, d, [0, 0, 0], code);
    }
  }
  cars.solidTemplates = { front: wheel(WHEEL_W.front), rear: wheel(WHEEL_W.rear), helmet };
  return cars.solidTemplates;
}

/**
 * Writes a wheel3d or helmet3d element as flat-shaded triangles into `out`
 * from float `o` on (x, y, z relative to origin, r, g, b per vertex; RGB 0-1,
 * shaded by a fixed light from
 * the live palette `rgb`, 768 bytes 0-255; mid grey without it). Colours come
 * from the game's bitmaps: tyre code 0 and hub code 10 of the team palette,
 * helmet codes of the driver's helmet palette.
 */
function solidTriangles(cars, el) {
  const T = solidTemplates(cars);
  return el.kind === 'helmet3d' ? T.helmet : el.front ? T.front : T.rear;
}
function emitSolid(cars, rgb, el, out, o, origin) {
  const tris = solidTriangles(cars, el);
  const h = (el.yaw / 65536) * 2 * Math.PI, s = Math.sin(h), c = Math.cos(h);
  const x0 = el.at[0] - origin[0], y0 = el.at[1] - origin[1], z0 = el.at[2];
  for (const t of tris) {
    const nx = s * t.n[0] + c * t.n[1], ny = c * t.n[0] - s * t.n[1], nz = t.n[2];
    const shade = 0.55 + 0.45 * Math.max(0, nx * LIGHT[0] + ny * LIGHT[1] + nz * LIGHT[2]);
    const idx = cars.palettes[(el.palette + t.code) & 0xffff] ?? 0;
    const r = rgb ? Math.min(1, (rgb[idx * 3] / 255) * shade) : 0.38 * shade;
    const g = rgb ? Math.min(1, (rgb[idx * 3 + 1] / 255) * shade) : 0.38 * shade;
    const b = rgb ? Math.min(1, (rgb[idx * 3 + 2] / 255) * shade) : 0.38 * shade;
    // (forward, right, up) is a mirror image of world (x, y, z): reverse the order to keep
    // the triangle counter-clockwise from outside
    for (let k = 2; k >= 0; k--) {
      const p = t.p[k];
      out[o++] = x0 + s * p[0] + c * p[1]; out[o++] = y0 + c * p[0] - s * p[1]; out[o++] = z0 + p[2];
      out[o++] = r; out[o++] = g; out[o++] = b;
    }
  }
  return o;
}

/**
 * Camera-facing quads for frameCars' bitmaps (wheels, helmets, far cars,
 * effects), in the vertex format of objects.mjs spriteQuads (x, y, z relative
 * to the mesh origin, atlas u, v, palette offset, depth bias; 7 floats per
 * vertex, 6 vertices per bitmap), with each bitmap's own depth bias: a wheel
 * is pulled a quarter of its width towards the camera, a helmet half its
 * width, a far car none.
 * @param {object} fc     frameCars() result
 * @param {object} atlas  objects.mjs buildSpriteAtlas(objs or cars, ids including carSpriteIds(cars))
 * @param {object} cam    { x, y (fine), heading }
 * @param {object} cars   readCars() (scale constants)
 */
export function carSpriteQuads(fc, atlas, cam, cars) {
  const parts = [];
  let n = 0;
  for (const f of fc.frame.sprites) {
    const s = fc.mesh.sprites[f.sprite];
    const q = spriteQuads([s], atlas, cam, cars, fc.mesh.origin, [{ sprite: 0, id: f.id, mirrored: f.mirrored }]);
    for (let k = 6; k < q.length; k += 7) q[k] = s.bias;
    parts.push(q);
    n += q.length;
  }
  const out = new Float32Array(n);
  let o = 0;
  for (const q of parts) { out.set(q, o); o += q.length; }
  return out;
}

/**
 * Car states between two frames (t = 0 .. 1), for drawing between the game's
 * frames: position, height, yaw (the short way round), pitch and steering
 * eased; everything else from b. Cars that jump more than 64 ft are not eased.
 */
export function lerpCarStates(a, b, t) {
  const ang = (u, v) => (u + Math.round(s16((v - u) & 0xffff) * t)) & 0xffff;
  return b.map((cb, i) => {
    const ca = a[i];
    if (!ca || Math.abs(cb.x - ca.x) + Math.abs(cb.y - ca.y) > 64 * 64) return cb;
    return {
      ...cb, x: ca.x + (cb.x - ca.x) * t, y: ca.y + (cb.y - ca.y) * t, z: ca.z + (cb.z - ca.z) * t,
      yaw: ang(ca.yaw, cb.yaw), pitch: ang(ca.pitch, cb.pitch), steer: Math.round(ca.steer + (cb.steer - ca.steer) * t),
    };
  });
}

// A shape's points per level of detail, and each polygon's triangulation, depend on
// the shape alone: work them out once (posing is a rotation, a move and a small tilt).
const pointsCache = new WeakMap();
function cachedPoints(sh, lod) {
  let m = pointsCache.get(sh);
  if (!m) { m = new Map(); pointsCache.set(sh, m); }
  if (!m.has(lod)) m.set(lod, shapePoints(sh, lod));
  return m.get(lod);
}
const trianglesCache = new WeakMap();
function cachedTriangles(part, poly, P) {
  if (!part.lod) return triangulate(P);
  let m = trianglesCache.get(part.lod);
  if (!m) { m = new Map(); trianglesCache.set(part.lod, m); }
  const key = `${part.pose.alt ? 1 : 0}:${poly.el.order}:${P.length}`;
  let t = m.get(key);
  if (!t) { t = triangulate(P); m.set(key, t); }
  return t;
}

function normalOf(P) {
  let nx = 0, ny = 0, nz = 0;
  for (let i = 0; i < P.length; i++) {
    const a = P[i], b = P[(i + 1) % P.length];
    nx += (a[1] - b[1]) * (a[2] + b[2]); ny += (a[2] - b[2]) * (a[0] + b[0]); nz += (a[0] - b[0]) * (a[1] + b[1]);
  }
  return [nx, ny, nz];
}

// ear clipping in the polygon's plane (keeps the winding); a fan when that fails
function triangulate(P) {
  const m = P.length;
  if (m < 3) return [];
  if (m === 3) return [[0, 1, 2]];
  const n = normalOf(P);
  const ax = Math.abs(n[0]), ay = Math.abs(n[1]), az = Math.abs(n[2]);
  const [i0, i1, flip] = az >= ax && az >= ay ? [0, 1, n[2] < 0] : ax >= ay ? [1, 2, n[0] < 0] : [2, 0, n[1] < 0];
  const Q = P.map((p) => [p[i0], p[i1]]);
  const cross = (o, a, b) => (Q[a][0] - Q[o][0]) * (Q[b][1] - Q[o][1]) - (Q[a][1] - Q[o][1]) * (Q[b][0] - Q[o][0]);
  const sign = flip ? -1 : 1;
  const idx = [...Array(m).keys()], tris = [];
  for (let guard = 0; idx.length > 3 && guard < 200; guard++) {
    let cut = false;
    for (let k = 0; k < idx.length; k++) {
      const a = idx[(k + idx.length - 1) % idx.length], b = idx[k], c = idx[(k + 1) % idx.length];
      if (sign * cross(a, b, c) <= 0) continue;
      let inside = false;
      for (const o of idx) {
        if (o === a || o === b || o === c) continue;
        if (sign * cross(a, b, o) > 0 && sign * cross(b, c, o) > 0 && sign * cross(c, a, o) > 0) { inside = true; break; }
      }
      if (inside) continue;
      tris.push([a, b, c]); idx.splice(k, 1); cut = true;
      break;
    }
    if (!cut) break;
  }
  if (idx.length === 3) tris.push([idx[0], idx[1], idx[2]]);
  else for (let k = 1; k + 1 < idx.length; k++) tris.push([idx[0], idx[k], idx[k + 1]]);
  return tris;
}

/**
 * Every bitmap id a car can show: wheel frames (00h-41h), helmets (42h-4Ah),
 * the far bitmaps of the car (B0h-DCh) and those of the effect shapes. For
 * objects.mjs buildSpriteAtlas(cars, carSpriteIds(cars)) (or merge with
 * spriteIdsUsed(objs) into one atlas: the store is shared).
 */
export function carSpriteIds(cars) {
  const ids = new Set();
  for (let id = 0; id < 0x4b; id++) ids.add(id);
  const shapes = [cars.car, ...cars.attachShapes.values()];
  for (const sh of shapes) {
    if (!sh) continue;
    for (const l of sh.lods) {
      if (!l.sprite) continue;
      if (l.shift & 0x8000) { ids.add(l.shift & 0x7fff); continue; }
      for (let a = 0; a < 0x10000; a += 0x40) { const f = spriteLodFrame(l, a); if (f && !f.polygons) ids.add(f.id); }
    }
    if (sh.elements) for (const el of sh.elements.values()) if (el.kind === 'bitmap' && el.id >= 0x4b) ids.add(el.id);
  }
  return [...ids].filter((id) => cars.sprite(id)).sort((a, b) => a - b);
}
