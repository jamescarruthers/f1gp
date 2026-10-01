// f1gp-state.mjs - read F1GP 1.05's game state (all 26 cars, the camera,
// the view, the frame tick, session flags) from emulated memory.
//
// Plain ES module, no Node APIs. Works with a reader from lib/f1gp-mem.mjs
// (live: attach(ci); offline: fromRam(dump)).
//
//   import { attach } from './f1gp-mem.mjs';
//   import { readState, readTrack } from './f1gp-state.mjs';
//   const mem = attach(ci);
//   const st = readState(mem);        // plain object, see the shape below
//   const tr = readTrack(mem);        // centreline and edges of the lap and pit lane
//
// Every car gets a world position:
//   - pos 'live':    car+7E bit 01 set (the player's car, and computer cars
//                    briefly while in contact range of another car). The game
//                    integrates car+28/+2C every frame; we copy them.
//   - pos 'derived': otherwise (normal computer cars). car+28/+2C are stale;
//                    the game itself (image 0x14A2/0x1544, used by the
//                    renderer) computes the position from the segment the
//                    car points at (car+12/+14), the distance into it
//                    (car+1C) and the lateral offset (car+0A). We do the same
//                    integer arithmetic on the same in-memory segment, so the
//                    result is the position the game draws the car at.
//   - pos 'none':    the segment pointer is not in the track or pit array
//                    (no session, or memory being rebuilt); x/y are car+28/+2C
//                    as stored and should not be drawn.
// The track model in lib/track-file.mjs gives the same segments (exact on the
// lap, within 0.13 m in the pit lane; tests/f1gp-state.test.mjs checks it),
// but reading the game's own array needs no track file and follows the pit
// lane swap the game does in practice sessions.
//
// Units (see docs/memory-map.md): world x/y = 1/16384 ft (car+28/+2C units);
// segment ("fine") units = 1/64 ft = world >> 8; one segment = 16 ft = 1024
// fine. Heading: 0x10000 = one turn, 0 = +y, 0x4000 = +x (clockwise with x
// right, y up). Speed: 1/64 ft/s, mph = floor(v * 0x2BA / 0x10000).
// Z: the game's height unit (assumed 1/64 ft, not verified).
//
// State shape (readState):
//   { ok, tick, tickFrac, frame, frameMs, sessionMs, settled, carsAhead, consistent, workCounter,
//     paused, replay, leavingSession, notInCar, inSession, playerSlot,
//     session: { type, typeRaw, circuit, totalLaps, ticksPerFrame, fps, runners, leaderLapsDone, wet, skill },
//     view: { mode, raw, tvCameraPlaced, viewedSlot, cameraIsCar, playerSlot },
//     camera: { x, y, z, heading, pitch, horizonRow },
//     track: { seg, off, pitSeg, pitOff, lapSegments },
//     raceOrder: [slot, ...],
//     cars: [ { slot, ptr, id, number, team, name, isPlayer, ccDriven, racePos, lap,
//               speed, speedMph, heading, direction, x, y, z, pitch, pos, physics,
//               segSeg, segOff, segNr, trackIndex, along, fraction, lateral, trackDist,
//               inPit, pitting, pitState, gear, rpm, retired, visible, gapAheadMs,
//               lastLapRaw, lastLapMs, bestLapRaw, bestLapMs, lapStartRaw, flags } x 26 ] }

export const CAR0 = 0x0d1b;      // DS offset of car record 0 (grid order)
export const CAR_SIZE = 0xc0;
export const NCARS = 26;
export const SEG_SIZE = 0x2e;    // in-memory track segment entry

export const UNITS = {
  worldPerFoot: 16384, finePerFoot: 64, worldPerFine: 256, finePerSegment: 1024, feetPerSegment: 16,
  metresPerWorld: 0.3048 / 16384, metresPerFine: 0.3048 / 64, speedPerFtps: 64, angleFull: 0x10000,
};

export const VIEW_MODES = { 0x00: 'cockpit', 0x80: 'tv', 0xa0: 'chase', 0xb0: 'reverse-chase' };
export const SESSION_TYPES = { 0x00: 'practice', 0x01: 'free-practice', 0x02: 'pre-race-practice', 0x40: 'qualifying', 0x80: 'race' };

// DS / SS offsets read here (all documented in docs/memory-map.md).
export const ADDR = {
  ds: {
    replay: 0x005a, cameraObj: 0x097d, viewedCar: 0x097f, viewMode: 0x0981,
    carOrder: 0x0c65, cars: CAR0, paused: 0x2227, camPitch: 0x2257, camX: 0x2259, camY: 0x225d,
    camYaw: 0x2261, headNod: 0x2269, frameStep: 0x2241, frameStepFrac: 0x2245, playerCar: 0x28fd,
    sessionMs: 0x294f, clock: 0x2955, clockFrac: 0x2959, runners: 0x2967, leaderLapsDone: 0x298b,
    ticksUsed: 0x2c63, fps: 0x2c61, workCounter: 0x2977, pitArrayOff: 0x8797, pitArraySeg: 0x8799,
    trackArrayOff: 0x879f, trackArraySeg: 0x87a1,
  },
  ss: {
    horizon: 0x0130, camZ: 0x013e, lapEnd: 0x015c, ticksSinceFlip: 0x05c8, notInCar: 0x1108,
    skill: 0x1222, wet: 0x122e, ticksPerFrame: 0x1230, circuit: 0x1236, totalLaps: 0x123c,
    sessionType: 0x124a, sessionEnd: 0x124e, raceOrder: 0x1940, driverNames: 0x1a4a, cosTable: 0x3264,
  },
};

const sx16 = (v) => (v << 16) >> 16;
const r16 = (H, p) => H[p] | (H[p + 1] << 8);
const s16 = (H, p) => ((H[p] | (H[p + 1] << 8)) << 16) >> 16;
const s32 = (H, p) => H[p] | (H[p + 1] << 8) | (H[p + 2] << 16) | (H[p + 3] << 24);
const u32 = (H, p) => s32(H, p) >>> 0;

/** mph as the dash shows it: floor(v * 0x2BA / 0x10000), v in 1/64 ft/s. */
export const speedToMph = (v) => Math.floor((v * 0x2ba) / 0x10000);

// The game's run-time cosine (image 0000:03C8): table at SS:3264, 0x4000 = 1.0,
// one entry per 8 angle units over 0..180 deg, linear interpolation in 1/8 steps.
export function gameCos(C, a) {
  a &= 0xffff;
  if (a & 0x8000) a = (0x10000 - a) & 0xffff; // neg (8000h stays 8000h)
  const i = a >> 3, t0 = C[i];
  return t0 + (((C[i + 1] - t0) * (a & 7)) >> 3);
}

/**
 * World pose of a car from its track-relative fields, as gp.exe image
 * 0x1544 (x/y), 0x14D4 (z) and 0x14F5 (pitch) compute it. H = byte array,
 * c = index of the car record, s = index of the segment entry in H,
 * C = cos table. Returns [x, y, z, pitch]; x/y in world units.
 */
export function derivePose(H, c, s, C, out = [0, 0, 0, 0]) {
  const lat = s16(H, c + 0x0a);
  let along = s16(H, c + 0x1c);
  const dA = s16(H, s + 0x14);
  // corner correction: along -= hiword(seg+14 * lat * 2)
  if (dA !== 0) along = sx16(along - (((dA * lat * 2) | 0) >> 16));
  const a = r16(H, s);
  const co = gameCos(C, a), si = gameCos(C, (0x4000 - a) & 0xffff);
  const dy = (((along * co - lat * si) | 0) << 2) >> 16; // hiword(T << 2) = T >> 14, 16-bit
  const dx = (((lat * co + along * si) | 0) << 2) >> 16;
  const fine = H[s + 0x21];
  const x19 = ((s16(H, s + 4) * 8) | (fine & 7)) + dx;
  const y19 = ((s16(H, s + 8) * 8) | (fine >> 4)) + dy;
  out[0] = x19 << 8; out[1] = y19 << 8;
  // height: segment Z interpolated by car+1E towards the next entry, plus car+8C
  const z0 = s16(H, s + 6), z1 = s16(H, s + SEG_SIZE + 6);
  out[2] = sx16(((((sx16(z1 - z0) * s16(H, c + 0x1e)) << 2) >> 16)) + z0 + s16(H, c + 0x8c));
  // pitch: segment pitch * cos(car heading - segment heading), table without interpolation
  let d = (r16(H, c + 0x1a) - a) & 0xffff;
  if (d & 0x8000) d = (0x10000 - d) & 0xffff;
  out[3] = ((s16(H, s + 2) * C[d >> 3]) << 2) >> 16;
  return out;
}

function readCos(mem) {
  const C = new Int16Array(4098);
  const base = mem.ssLinear + ADDR.ss.cosTable;
  for (let i = 0; i < C.length; i++) C[i] = mem.s16(base + 2 * i);
  if (C[0] !== 0x4000 || C[4096] !== -0x4000) throw new Error('cos table not found at SS:3264 (wrong DS/SS?)');
  return C;
}

function readName(H, p) {
  let s = '';
  for (let i = 0; i < 24; i++) { const b = H[p + i]; if (!b) break; s += String.fromCharCode(b); }
  return s.trim();
}

/**
 * A reader bound to one attached memory. Keeps the cos table and the
 * driver names cached. read(opts) returns the state; opts.crossCheck adds
 * car.derived = { x, y, z } for live cars too (to compare with x/y).
 */
export function createReader(mem, rOpts = {}) {
  if (mem.imageSeg === null) throw new Error('gp.exe not found in memory');
  const C = readCos(mem);
  const dsL = mem.dsLinear, ssL = mem.ssLinear;
  const D = ADDR.ds, S = ADDR.ss;
  const pose = [0, 0, 0, 0];
  let names = null, namesKey = '', lastTick = -1;
  let workOffset = null; // (DS:2977 - 2*frame) & FFh, learned from settled reads

  function read(opts = {}) {
    const H = mem.heap(), B = mem.memBase;
    const ds = B + dsL, ss = B + ssL;
    const tick = u32(H, ds + D.clock), tickFrac = r16(H, ds + D.clockFrac);
    const step = u32(H, ds + D.frameStep) + r16(H, ds + D.frameStepFrac) / 65536;
    const ticksPerFrame = r16(H, ss + S.ticksPerFrame);
    const typeRaw = H[ss + S.sessionType], circuit = H[ss + S.circuit];
    const playerPtr = r16(H, ds + D.playerCar);
    const trackSeg = r16(H, ds + D.trackArraySeg), trackOff = r16(H, ds + D.trackArrayOff);
    const pitSeg = r16(H, ds + D.pitArraySeg), pitOff = r16(H, ds + D.pitArrayOff);
    const lapEnd = r16(H, ss + S.lapEnd);
    const viewRaw = H[ds + D.viewMode];
    const viewedPtr = r16(H, ds + D.viewedCar), camObj = r16(H, ds + D.cameraObj);
    const notInCar = H[ss + S.notInCar] !== 0;
    const leaving = (H[ss + S.sessionEnd] & 0x10) !== 0;

    // driver names: re-read when the session changes or the clock goes back
    const key = `${typeRaw}/${circuit}/${playerPtr}`;
    if (!names || key !== namesKey || tick < lastTick || opts.names) {
      names = [];
      for (let n = 0; n < 40; n++) names.push(readName(H, ss + S.driverNames + n * 24));
      namesKey = key;
    }
    lastTick = tick;

    const cars = new Array(NCARS);
    for (let i = 0; i < NCARS; i++) {
      const ptr = CAR0 + i * CAR_SIZE, c = ds + ptr;
      const id = H[c + 0xac], m7e = H[c + 0x7e];
      const segOff = r16(H, c + 0x12), segSeg = r16(H, c + 0x14);
      const physics = (m7e & 1) !== 0;
      const sLin = (segSeg << 4) + segOff;
      const segOk = (segSeg === trackSeg || segSeg === pitSeg) && segOff >= 2 && segOff <= 0xffff - 2 * SEG_SIZE;
      const s = B + sLin;
      const segNr = segOk ? r16(H, s + 0x1a) : 0;
      let x, y, z, pitch, pos;
      if (physics) {
        x = s32(H, c + 0x28); y = s32(H, c + 0x2c); z = s16(H, c + 0x08); pitch = s16(H, c + 0x02); pos = 'live';
      } else if (segOk) {
        derivePose(H, c, s, C, pose);
        x = pose[0]; y = pose[1]; z = pose[2]; pitch = pose[3]; pos = 'derived';
      } else {
        x = s32(H, c + 0x28); y = s32(H, c + 0x2c); z = s16(H, c + 0x08); pitch = s16(H, c + 0x02); pos = 'none';
      }
      const speed = s16(H, c + 0x10);
      const along = s16(H, c + 0x1c);
      const trackIndex = segNr & 0x0fff; // bit 1000h is a run-time flag (seen under a crawling car), 2000h = pit lane
      const f23 = H[c + 0x23], f3c = H[c + 0x3c], f96 = H[c + 0x96];
      const last = u32(H, c + 0x40), best = u32(H, c + 0xae), gap = u32(H, c + 0x04);
      const car = {
        slot: i, ptr, id, number: id & 0x3f, team: H[c + 0x25], name: names[(id & 0x3f) - 1] || '',
        isPlayer: (id & 0x80) !== 0, ccDriven: (m7e & 0x04) !== 0,
        racePos: (H[c + 0xaa] >> 1) + 1, lap: H[c + 0x22],
        speed, speedMph: Math.floor((speed * 0x2ba) / 0x10000),
        heading: r16(H, c + 0x1a), direction: r16(H, c + 0x00),
        x, y, z, pitch, pos, physics,
        segSeg, segOff, segNr, trackIndex,
        along, fraction: s16(H, c + 0x1e), lateral: s16(H, c + 0x0a),
        trackDist: trackIndex * 1024 + along,
        inPit: (f23 & 0x20) !== 0 || (segNr & 0x2000) !== 0, pitting: (f23 & 0x80) !== 0, pitState: H[c + 0x67],
        // gear and RPM are kept up to date only for physics-mode cars (null otherwise)
        gear: physics ? (H[c + 0x24] << 24) >> 24 : null, rpm: physics ? r16(H, c + 0x62) : null,
        // +96 bit 20h: no driver in the car (retired in a race; parked in the garage in practice);
        // bit 80h: not drawn (practice garages). +3C bit 10h ("retired" in GPDEF.INC) was never seen set.
        retired: (f96 & 0x20) !== 0, visible: (f96 & 0x80) === 0,
        gapAheadMs: gap & 0x80000000 ? null : gap,
        lastLapRaw: last, lastLapMs: last & 0xf0000000 ? null : last,
        bestLapRaw: best, bestLapMs: best & 0xf0000000 ? null : best,
        lapStartRaw: u32(H, c + 0x54),
        flags: { m7e, f18: H[c + 0x18], f23, f3c, f5e: H[c + 0x5e], f96 },
      };
      if (opts.crossCheck && segOk) {
        derivePose(H, c, s, C, pose);
        car.derived = { x: pose[0], y: pose[1], z: pose[2], pitch: pose[3] };
      }
      cars[i] = car;
    }

    const raceOrder = [];
    for (let k = 0; k < NCARS; k++) {
      const id = H[ss + S.raceOrder + k];
      for (let i = 0; i < NCARS; i++) if (cars[i].id === id) { raceOrder.push(i); break; }
    }

    const cockpit = (viewRaw & 0xb0) === 0;
    const frame = step > 0 ? Math.round((tick + tickFrac / 65536) / step) : 0;
    // Frame phase. Each frame the game bumps DS:2977 by 2 (image 0xDA68) before
    // it moves the cars, and adds to the clock DS:2955 after the render. A read
    // between the two sees cars one frame ahead of tick.
    const settled = r16(H, ss + S.ticksSinceFlip) >= r16(H, ds + D.ticksUsed);
    // DS:2977 only counts in races (both increments, image 0xDA68 and 0xDAA9,
    // are on the session-type-80h branch); elsewhere carsAhead stays false
    const workCounter = H[ds + D.workCounter];
    const race = (typeRaw & 0x80) !== 0;
    const off = (workCounter - 2 * frame) & 0xff;
    if (settled && race) workOffset = off;
    const carsAhead = race && workOffset !== null && off !== workOffset;
    return {
      ok: mem.checked !== false,
      tick, tickFrac, frame,
      frameMs: step,
      sessionMs: u32(H, ds + D.sessionMs),
      // settled: SS:05C8 >= DS:2C63, i.e. the frame's work is done and the game
      // waits for the next frame (heuristic, single read); carsAhead: DS:2977
      // has moved on from the clock (needs one earlier settled read)
      settled, carsAhead, consistent: settled && !carsAhead, workCounter,
      paused: (H[ds + D.paused] & 0x80) !== 0,
      replay: (H[ds + D.replay] & 0x80) !== 0,
      leavingSession: leaving,
      notInCar,
      // DS:28FD (player car) also goes to 0 some seconds after the player's car retires, so it is not used here
      inSession: !notInCar && !leaving,
      playerSlot: slotOf(playerPtr) ?? cars.findIndex((c) => c.isPlayer),
      session: {
        type: SESSION_TYPES[typeRaw] || `0x${typeRaw.toString(16)}`, typeRaw, circuit,
        totalLaps: r16(H, ss + S.totalLaps), ticksPerFrame,
        fps: ticksPerFrame ? 300 / ticksPerFrame : 0,
        runners: r16(H, ds + D.runners), leaderLapsDone: H[ds + D.leaderLapsDone], // = leader car+22 - 1
        wet: r16(H, ss + S.wet) !== 0, skill: H[ss + S.skill],
      },
      view: {
        mode: VIEW_MODES[viewRaw & 0xb0] || `0x${viewRaw.toString(16)}`, raw: viewRaw,
        tvCameraPlaced: (viewRaw & 0x40) !== 0,
        viewedSlot: slotOf(viewedPtr), cameraIsCar: camObj === viewedPtr,
        playerSlot: slotOf(playerPtr),
      },
      camera: {
        x: s32(H, ds + D.camX), y: s32(H, ds + D.camY), z: s16(H, ss + S.camZ),
        heading: r16(H, ds + D.camYaw),
        pitch: s16(H, ds + D.camPitch) + (cockpit ? s16(H, ds + D.headNod) : 0),
        horizonRow: s16(H, ss + S.horizon),
      },
      track: {
        seg: trackSeg, off: trackOff, pitSeg, pitOff,
        lapSegments: lapEnd > trackOff ? (lapEnd - trackOff) / SEG_SIZE : 0,
      },
      raceOrder,
      cars,
    };
  }
  return { read, cos: C, mem, opts: rOpts };
}

function slotOf(ptr) {
  const k = (ptr - CAR0) / CAR_SIZE;
  return Number.isInteger(k) && k >= 0 && k < NCARS ? k : null;
}

const READERS = new WeakMap();
/** Read the whole state (see the shape at the top). Caches a reader per mem. */
export function readState(mem, opts = {}) {
  let r = READERS.get(mem);
  if (!r) { r = createReader(mem); READERS.set(mem, r); }
  return r.read(opts);
}

/**
 * The circuit as the game holds it, read from memory: one entry per 16 ft
 * segment of the lap and of the pit lane. Entries are placed by their number
 * (segment +1A: low 12 bits = index, 2000h = pit lane), not by their address,
 * because in practice sessions the game splices the pit lane into the track
 * array and parks the bypassed track in the pit array. Both arrays are
 * scanned: the track array up to SS:015C, the pit array while the numbers
 * run on consecutively (at most maxPit entries).
 * Points are in world units (1/16384 ft): centre [x, y], z, heading, and the
 * edges from the segment's half-width vector (+0C/+0E upper 10 bits, 1/8 ft;
 * right edge = centre + 8*(sx, -sy) fine units).
 * Returns { lap: [entry by track index], pit: [entries in pit order], ... }.
 */
export function readTrack(mem, { maxPit = 600 } = {}) {
  const H = mem.heap(), B = mem.memBase, ds = B + mem.dsLinear, ss = B + mem.ssLinear;
  const D = ADDR.ds;
  const tSeg = r16(H, ds + D.trackArraySeg), tOff = r16(H, ds + D.trackArrayOff);
  const pSeg = r16(H, ds + D.pitArraySeg), pOff = r16(H, ds + D.pitArrayOff);
  const lapEnd = r16(H, ss + ADDR.ss.lapEnd);
  const n = lapEnd > tOff ? (lapEnd - tOff) / SEG_SIZE : 0;
  const decode = (seg, off) => {
    const p = B + (seg << 4) + off, fine = H[p + 0x21];
    const x = (s16(H, p + 4) * 8) | (fine & 7), y = (s16(H, p + 8) * 8) | (fine >> 4);
    const sx = s16(H, p + 0x0c) >> 6, sy = s16(H, p + 0x0e) >> 6;
    const nr = r16(H, p + 0x1a);
    return {
      nr, index: nr & 0x0fff, pit: (nr & 0x2000) !== 0, heading: r16(H, p), z: s16(H, p + 6),
      centre: [x * 256, y * 256], right: [(x + 8 * sx) * 256, (y - 8 * sy) * 256], left: [(x - 8 * sx) * 256, (y + 8 * sy) * 256],
      halfWidth: (s16(H, p + 0x0c) & 63) << 5,
    };
  };
  const entries = [];
  for (let i = 0; i < n; i++) entries.push(decode(tSeg, tOff + i * SEG_SIZE));
  // pit array: entries while the numbers run on (a track run may wrap from the last index to 0)
  let prev = -1;
  for (let i = 0; i < maxPit; i++) {
    const e = decode(pSeg, pOff + i * SEG_SIZE), cur = e.nr & 0x2fff;
    if (i > 0 && cur !== prev + 1 && !(cur === 0 && prev > 0 && !(prev & 0x2000))) break;
    entries.push(e);
    prev = cur;
  }
  const lap = [], pit = [];
  for (const e of entries) {
    if (e.pit) pit.push(e);
    else if (!lap[e.index]) lap[e.index] = e;
  }
  pit.sort((a, b) => a.index - b.index);
  return { units: 'world', lapSegments: lap.length, arrayLapEntries: n, lap, pit, trackArray: [tSeg, tOff], pitArray: [pSeg, pOff] };
}
