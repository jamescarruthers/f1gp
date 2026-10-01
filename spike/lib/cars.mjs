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
  hazeLevel, assignLayers,
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
const R = {
  nearDepth: 0x58, mirrorLeft: 0x5a, mirrorRight: 0x5c, camAngle: 0x186, polyMode: 0xfa,
  pitEnd: 0x182, pitMap: 0x18a, pitStart2: 0x18e, pitA: 0x1a8, pitB: 0x1b4, pitSplit: 0x1cc,
};
const PALETTE_BYTES = 0x900;
const HAZE_SEG_REL = 0x7bce, HAZE_OFF = 0x7bc0;

// The car's attached effect shapes (DS:351B, index = A07D's "di"):
//   0: car+97 bit 80h  shape 8   behind the car, a running mechanic (bitmaps 9Bh-9Fh)
//   1: car+9A 10h+04h  shape 0Eh behind the car, a burst of debris (bitmaps 91h-9Ah)
//   2: car+9A 80h+20h  shape 0Fh behind the car, raised: a broken part
//   3: car+9A 80h+40h  shape 10h in front, turned round: a broken part
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
      let [sg, off] = mapPitSegment(cars, st, walk, R0);
      let steps = base;
      // the first segment at or after the car's own without an object (A6AF)
      for (let guard = 0; hasObject((sg << 4) + off) && guard < 64; guard++) {
        steps++;
        [sg, off] = nextSegment(cars, sg, off, walk, R0);
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
  // drawing order: the "later" object list sorted by key, far first; ties keep A533's order
  drawn.sort((a, b) => b.key - a.key);
  return { drawn, skipped, walk };
}

// the next segment entry (A6C4-A6EE): in the pit array up to R:182, then
// on at the far pointer R:18E; in the track array wrapping at the lap end
function nextSegment(cars, sg, off, walk, R0) {
  const { rd, mem } = cars;
  const ss = mem.SS << 4;
  if (sg !== walk.trackSeg) {
    off += SEG_SIZE;
    if (off >= rd.u16(R0 + R.pitEnd)) return [rd.u16(R0 + R.pitStart2 + 2), rd.u16(R0 + R.pitStart2)];
    return [sg, off];
  }
  off += SEG_SIZE;
  if (off > 0xffff || off >= rd.u16(ss + SS.lapEnd)) off -= rd.u16(ss + SS.lapBytes);
  return [sg, off & 0xffff];
}

// A5DD-A6AB: which segment a car is filed on when it is near the pit lane:
// pit-array cars at the two ends of the pit lane are moved onto the parallel
// track segments; track cars at a pit junction onto the pit array; read from
// the renderer's junction pointers.
function mapPitSegment(cars, st, walk, R0) {
  const { rd, mem } = cars;
  const ds = mem.DS << 4, ss = mem.SS << 4;
  const p = ds + st.ptr;
  const di = rd.u16(p + 0x12), seg = rd.u16(p + 0x14);
  const tSeg = walk.trackSeg, pSeg = walk.pitSeg;
  const splice = rd.u8(ds + DS.splice);
  const keep = [seg, di];
  const toTrack = () => {
    if (splice) return keep;
    if (di < rd.u16(R0 + R.pitSplit)) return [tSeg, (di - rd.u16(ds + DS.pit) + rd.u16(R0 + R.pitMap)) & 0xffff];
    return [tSeg, (di - rd.u16(R0 + R.pitSplit) + rd.u16(ds + DS.track)) & 0xffff];
  };
  if (!(rd.u16(ss + SS.pitWalk) & 0x8000)) {
    if (seg !== tSeg) {
      if (di < rd.u16(R0 + R.pitA) || di >= rd.u16(R0 + R.pitB)) return toTrack();
      return keep;
    }
    if (splice) return keep;
    const f = rd.u8((seg << 4) + di + 0x26) & 3;
    if (f === 0 || f === 3) return keep;
    let ax;
    if (f === 2) {
      ax = (rd.u16(R0 + R.pitStart2) - di) & 0xffff;
      if (ax >= 0x8fc) return keep;
      ax = (-ax) & 0xffff;
      if (!(ax & 0x8000)) return keep;
      ax = (ax + rd.u16(R0 + R.pitEnd)) & 0xffff;
      if (ax > rd.u16(R0 + R.pitB)) return keep;
      if (!(ax < rd.u16(ss + SS.pitHi)) && !(rd.u8(p + 0x19) & 0x80)) return keep;
    } else {
      ax = (di - rd.u16(R0 + R.pitMap)) & 0xffff;
      if (ax >= 0x8fc) return keep;
      ax = (ax + 0xd7ae) & 0xffff;
      if (ax < rd.u16(R0 + R.pitA)) return keep;
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
    const tz = Math.floor((pt.y * st) / 16384);
    return [pose.x + pt.x * c + pt.y * s, pose.y - pt.x * s + pt.y * c, pose.z + shape.z12 + pt.z + tz];
  });
}

/**
 * What 0F47:88A5 draws for one shape (the car or an attached effect) in one
 * pose, in the game's order, for camera cam = { x, y, z, heading, mode }.
 * pose = { x, y, z, yaw, pitch, steer, palette, helmet, driver, alt, shapeId }.
 * opt.wide: use the true ray angle instead of the game's capped table.
 * @returns {{ kind: 'polygons'|'bitmap'|'mirror'|'none', reason?, depth8, lod, sector, a, ref,
 *   haze, elements: ({kind:'poly', pts, colour, code, facing}|{kind:'bitmap', at, id, mirrored, palette, what, depth8})[] }}
 */
export function shapeParts(cars, shape, pose, cam, opt = {}) {
  const out = { kind: 'none', elements: [] };
  if (!shape) return out;
  const ref = [pose.x, pose.y, pose.z + shape.z14];
  out.ref = ref;
  const v = toCamera(cam, ref);
  const near = Math.abs(pose.x - cam.x) + shape.size < 0x3e80 && Math.abs(pose.y - cam.y) + shape.size < 0x3e80;
  out.near = near;
  const depth8 = Math.floor(v[1]);
  out.depth8 = depth8;
  const r42 = (pose.yaw - cam.heading) & 0xffff;
  const corrOf = (vv, hi) => {
    if (opt.wide) {
      const ang = Math.round((Math.atan2(vv[0], vv[1]) / (2 * Math.PI)) * 65536);
      return (-Math.max(-0x2000, Math.min(0x2000, ang))) & 0xffff;
    }
    const col = vv[1] < 8 ? (vv[0] < 0 ? 0 : 320) : column(vv, hi);
    return columnCorrection(cars, col);
  };
  if (pose.shapeId === CAR_SHAPE && depth8 < cars.consts.nearDepth) {
    // 0F47:89F5: nearer than R:58 (26 = 3.25 ft) or behind: in the cockpit view
    // the car goes to a mirror (8A1D), in other views it is not drawn
    out.kind = cam.mode === 'cockpit' ? 'mirror' : 'none';
    out.reason = 'nearer than R:58';
    return out;
  }
  let lod = shape.lods.find((l) => Math.max(depth8, 0) <= l.max) ?? shape.lods[shape.lods.length - 1];
  out.lod = lod;
  const r44 = corrOf(v, near);
  const a = (r42 + r44) & 0xffff;
  out.a = a;
  if (lod.sprite) {
    // bitmap LOD (9A75): one frame at the reference point, by view angle
    if (v[1] < 8) { out.reason = 'behind'; return out; }
    const f = spriteLodFrame(lod, a);
    if (!f) { out.reason = 'no frame'; return out; }
    if (!f.polygons) {
      out.kind = 'bitmap';
      out.haze = hazeLevel(depth8);
      out.elements.push({ kind: 'bitmap', at: ref, id: f.id, mirrored: f.mirrored, palette: pose.palette, what: 'far', depth8 });
      return out;
    }
    lod = shape.lods.find((l) => !l.sprite);
  }
  const sh = pose.alt ? cars.carAlt : shape;
  const P = shapePoints(sh, lod);
  const W = posePoints(cars, sh, lod, pose, P);
  const C = W.map((p) => toCamera(cam, p));
  // visibility list: all behind, all left or all right of the screen -> nothing
  if (sh.vis && sh.vis.length) {
    let allBehind = true, allLeft = true, allRight = true;
    for (const i of sh.vis) {
      const c = C[i];
      if (c[1] >= 8) {
        allBehind = false;
        const x = column(c, near);
        if (x >= 0) allLeft = false;
        if (x < 320) allRight = false;
      } else { allLeft = allLeft && c[0] < 0; allRight = allRight && c[0] >= 0; }
    }
    if (allBehind || allLeft || allRight) { out.reason = 'outside the view'; return out; }
  }
  out.kind = 'polygons';
  out.haze = hazeLevel(Math.max(depth8, shape.size >> 3));
  const nd = lod.dirs.length;
  const sector = (a >> ((lod.shift & 15) + 1)) % nd;
  out.sector = sector;
  for (const o of lod.dirs[sector]) {
    const el = sh.elements.get(o);
    if (!el) continue;
    if (el.kind === 'poly') {
      if (el.facePoint !== undefined) {
        // drawn only when the point is not farther than its partner (0F47:99F8)
        const p = el.facePoint, q = P[p]?.partner ?? 0;
        const cp = C[p], cq = C[q];
        if (cp && cq && cp[1] >= 8 && cq[1] >= 8 && Math.floor(cp[1] * (near ? 8 : 1)) > Math.floor(cq[1] * (near ? 8 : 1))) continue;
      }
      const loop = polygonLoop(sh, el);
      if (loop.length < 3) continue;
      out.elements.push({ kind: 'poly', pts: loop.map((i) => W[i]), cam: loop.map((i) => C[i]), code: el.colour, colour: cars.palettes[(pose.palette + el.colour) & 0xffff] ?? 0, order: o });
    } else if (el.kind === 'bitmap') {
      if (el.type & 0x10 && !pose.driver) continue; // the driver's parts (helmet)
      const pc = C[el.point];
      if (!pc || pc[1] < 8) continue;
      const d8 = Math.floor(pc[1]);
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
        const f = wheelFrame(id, (r42 + corrOf(pc, near)) & 0xffff, pose.steer);
        what = id >= 0x21 ? 'front wheel' : 'rear wheel';
        id = f.id; mirrored = f.mirrored;
      }
      out.elements.push({ kind: 'bitmap', at: W[el.point], id, mirrored, palette, what, depth8: d8, order: o });
    } else if (el.kind === 'line') {
      const [ia, ib] = sh.vector(el.vector);
      out.elements.push({ kind: 'line', a: W[ia], b: W[ib], colour: cars.palettes[pose.palette & 0xffff] ?? 0, order: o });
    }
  }
  return out;
}

/** Pose of attached effect shape k (0F47:A406): offsets rotated by the car's yaw, Z raised by the car's pitch; yaw/pitch added. */
export function attachmentPose(cars, c, k) {
  const e = cars.attach[k];
  const { cos, sin } = cars.trig;
  const co = cos(c.yaw), si = sin(c.yaw);
  const dx = ((e.dx * co + e.dy * si) << 2) >> 16;
  const dy = ((e.dy * co - e.dx * si) << 2) >> 16;
  const dz = e.dz + ((((sin(c.pitch) * e.dy) << 2)) >> 16);
  return {
    x: c.x + dx, y: c.y + dy, z: c.z + dz, yaw: (c.yaw + e.dyaw) & 0xffff, pitch: (c.pitch + e.dpitch) & 0xffff,
    steer: c.steer, palette: e.palette, helmet: c.helmet, driver: c.driver, alt: false, shapeId: e.shape, attachment: k,
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
export function mirrorImage(cars, c, cam) {
  const shape = cars.car;
  const v = toCamera(cam, [c.x, c.y, c.z + shape.z14]);
  const lat = Math.trunc(v[0]), dep = Math.trunc(v[1]);
  const left = lat < 0;
  const off = left ? -140 : 140, ang = left ? cars.consts.mirrorLeft : cars.consts.mirrorRight;
  const { cos, sin } = cars.trig;
  const co = cos(ang), si = sin(ang);
  const dep2 = ((dep * co + lat * si) * 16) / 65536;      // hi16(<< 4): 4x depth
  const lat2 = -(lat * co - dep * si) / 16384;
  if (dep2 < 8) return null;
  const x = 160 + Math.trunc((lat2 * 256) / dep2) + off;
  if (((x - 160) ^ off) < 0) return null;
  const lod = shape.lods[shape.lods.length - 1];
  if (!lod.sprite) return null;
  let r42 = (-(((c.yaw - cam.heading) & 0xffff) - ang)) & 0xffff;
  const r44 = columnCorrection(cars, x - off);
  const f = spriteLodFrame(lod, (r42 + r44) & 0xffff);
  if (!f || f.polygons) return null;
  return { x, row: 123, id: f.id, mirrored: f.mirrored, depth8: Math.floor(dep2), side: left ? 'left' : 'right', palette: c.palette };
}

// ------------------------------------------------------------------ frame

/**
 * What the game draws for the cars this frame, for the WebGL renderer, in
 * the formats of objects.mjs: buildSectorMesh's mesh (x, y, z, r, g, b per
 * vertex relative to `origin`; with opt.indexed colours are (palette index,
 * -1, 0)) holding only this frame's chosen faces, and frameObjects' result
 * (vertex indices by decal layer, sprites with their frame and mirroring)
 * for spriteQuads(mesh.sprites, atlas, cam, cars, mesh.origin, frame.sprites, mesh.placements).
 *
 * @param {object} cars   readCars(mem)
 * @param {object} st     readState(mem) (the poses; use the state of the frame on screen)
 * @param {object} cam    { x, y (fine), z, heading, mode ('cockpit'|'chase'|'tv'|...) }
 * @param {object} [opt]  { origin: [x, y], indexed (default true), palette (RGB, if not indexed),
 *                          wide: true for the true ray angle (wide views), all: draw every
 *                          car record, not only the game's selection, wheelBias: depth bias of
 *                          wheel bitmaps as a fraction of their width (default 0.25) }
 * @returns {{ mesh, frame, list, mirrors }}
 *   list: per drawn car { slot, key, parts } (shapeParts results); mirrors: mirrorImage() results
 */
export function frameCars(cars, st, cam, opt = {}) {
  const origin = opt.origin ?? [cam.x, cam.y];
  const indexed = opt.indexed ?? true;
  const pal = opt.palette;
  const rgb = indexed ? (i) => [i, -1, 0] : (i) => [pal[i * 3] / 255, pal[i * 3 + 1] / 255, pal[i * 3 + 2] / 255];
  const states = carStates(cars, st);
  let chosen;
  if (opt.all) chosen = states.filter((c) => c.pos !== 'none' && !(c.f96 & 0x80)).map((c) => ({ slot: c.slot, state: c, key: 0 }));
  else chosen = selectCars(cars, states).drawn;
  const camObjSlot = st.view && st.view.mode === 'cockpit' ? st.view.viewedSlot : null;
  const data = [], vobj = [], lines = [], lineObj = [], sprites = [], objects = [], placements = [];
  const layers = [[]], frSprites = [], frLines = [];
  const list = [], mirrors = [];
  const vtx = (p, c, oi) => { data.push(p[0] - origin[0], p[1] - origin[1], p[2], c[0], c[1], c[2]); vobj.push(oi); };
  const wheelBias = opt.wheelBias ?? 0.25;
  for (const e of chosen) {
    const c = e.state;
    if (opt.all && c.slot === camObjSlot && !(c.f9a & 0x08)) continue;
    const cp = carParts(cars, c, cam, { wide: opt.wide, cameraObject: c.slot === camObjSlot });
    list.push({ slot: c.slot, key: e.key, parts: cp.parts });
    for (const part of cp.parts) {
      if (part.kind === 'mirror') { const m = mirrorImage(cars, c, cam); if (m) mirrors.push({ slot: c.slot, ...m }); continue; }
      if (part.kind === 'none') continue;
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
        while (layers.length <= poly.layer) layers.push([]);
        for (const t of fan(P)) for (const k of t) { layers[poly.layer].push(data.length / 6); vtx(P[k], col, oi); }
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
  return { mesh, frame, list, mirrors };
}

function normalOf(P) {
  let nx = 0, ny = 0, nz = 0;
  for (let i = 0; i < P.length; i++) {
    const a = P[i], b = P[(i + 1) % P.length];
    nx += (a[1] - b[1]) * (a[2] + b[2]); ny += (a[2] - b[2]) * (a[0] + b[0]); nz += (a[0] - b[0]) * (a[1] + b[1]);
  }
  return [nx, ny, nz];
}

// the car's polygons are convex (triangles and quads); a fan keeps the winding
function fan(P) {
  const t = [];
  for (let k = 1; k + 1 < P.length; k++) t.push([0, k, k + 1]);
  return t;
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
