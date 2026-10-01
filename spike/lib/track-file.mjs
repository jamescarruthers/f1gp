// track-file.mjs - read F1GP 1.05 track files (F1CTxx.DAT) and build the
// circuit's centreline, edges, pit lane and TV cameras in the game's own
// world coordinates.
//
// Plain ES module, no Node APIs: pass the file as a Uint8Array.
//
//   import { parseTrack, compileTrack, trackOutline, lookupSegment } from './track-file.mjs';
//   const t = parseTrack(bytes);        // every part of the file, checksum checked
//   const { segs } = compileTrack(t);   // one segment per TLU, exactly as in game memory
//   const geo = trackOutline(t);        // centre/left/right (+ pit lane, cameras) in car X/Y units
//   const s = lookupSegment(geo, nr);   // nr = word +1A of the segment a car points at
//
// Sources (read-only; no code copied):
//   ArgDocs file formats (https://www.argtools.com/argdocs/file-formats/track/)
//   ArgData C# readers (codemeyer/ArgData, Source/ArgData/Internals/*Reader.cs)
//   Chequered Flag (GPL-2.0) TrackSegments.java: the in-game "track compile"
//   (heading half-steps, 1/1024 TLU position steps, width vectors, closing
//   the loop). compileTrack() reimplements those steps.
// Checked against the running game (spike/probes/p1-track-*.mjs, results in
// spike/out/p1-track/segments-vs-game.json and qr1/fit.json): on all 16
// circuits every in-memory track segment equals compileTrack() exactly
// (X, Y, Z, heading, pitch, width vector, camera flags); the pit lane is
// within 0.15 m; the player's car+28/+2C equals our fine units x 256.
//
// Units:
//   TLU (track length unit) = 16 ft = one in-memory segment.
//   "fine" unit = 1/1024 TLU = 1/64 ft. Segment X/Y are 19-bit fine values.
//   Car world X/Y (car record +28/+2C) = fine << 8 (1/16384 ft); no rotation
//   or offset between the track file's frame and the car's.
//   Angles: 0x10000 = one turn. Heading 0 = +Y, heading grows clockwise
//   when X is drawn to the right and Y up (positive curvature = right turn).
//   Car+0A (lateral offset) is in fine units, + = right of the centreline.

// ------------------------------------------------------------ small helpers

const s16 = (v) => (v << 16) >> 16;
const u16 = (v) => v & 0xffff;

function reader(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    u8: (o) => dv.getUint8(o),
    s8: (o) => dv.getInt8(o),
    u16: (o) => dv.getUint16(o, true),
    s16: (o) => dv.getInt16(o, true),
    s32: (o) => dv.getInt32(o, true),
    len: bytes.byteLength,
  };
}

/** The 16 circuits of the 1991 season, in file order (ArgDocs misc-track-data). */
export const CIRCUITS = [
  'Phoenix', 'Interlagos', 'Imola', 'Monaco', 'Montreal', 'Mexico City',
  'Magny-Cours', 'Silverstone', 'Hockenheim', 'Hungaroring', 'Spa-Francorchamps',
  'Monza', 'Estoril', 'Barcelona', 'Suzuka', 'Adelaide',
];

export const TLU_FEET = 16;
export const FINE_PER_TLU = 1024;          // segment X/Y unit = 1/64 ft
export const WORLD_PER_FINE = 256;         // car+28/+2C unit = 1/16384 ft
export const METRES_PER_FINE = 0.3048 / 64;
export const METRES_PER_WORLD = METRES_PER_FINE / WORLD_PER_FINE;

// ------------------------------------------------------------ checksum

/**
 * F1GP file checksum (ArgDocs misc/checksum, ArgData ChecksumCalculator):
 * sum of all bytes, and a 16-bit rotate-left-by-3-then-add, both over every
 * byte except the last four. Stored as two little-endian u16 at the end.
 */
export function f1gpChecksum(bytes, end = bytes.length - 4) {
  let sum = 0, rot = 0;
  for (let i = 0; i < end; i++) {
    const b = bytes[i];
    rot = (((rot << 3) | ((rot & 0xe000) >>> 13)) + b) & 0xffff;
    sum = (sum + b) & 0xffff;
  }
  return { sum, rot };
}

// ------------------------------------------------------------ commands

/** Track section commands: argument count (first argument is a byte, the rest s16) and name. */
export const COMMANDS = {
  0x80: [2, 'object'],               // TLU into section, object-setting offset (index*16)
  0x81: [2, 'viewDistFwd'],
  0x82: [2, 'viewDistBack'],
  0x83: [1, 'horizonOff'],
  0x84: [1, 'horizonOn'],
  0x85: [3, 'width'],                // 0, transition length (TLU), new half-width (fine units)
  0x86: [1, 'pitLaneJoinStart'],     // pit lane leaves the track in this section
  0x87: [1, 'pitLaneJoinEnd'],       // pit lane rejoins the track in this section
  0x88: [2, 'garagesLeft'],
  0x89: [2, 'garagesRight'],
  0x8a: [6, 'markingsA'],
  0x8b: [6, 'markingsB'],
  0x8c: [2, 'unknown8C'],
  0x8d: [2, 'unknown8D'],
  0x8e: [3, 'kerbLeft'],             // 0, distance into section, length
  0x8f: [3, 'kerbRight'],
  0x90: [2, 'objectReverse'],
  0x91: [2, 'unknown91'],
  0x92: [2, 'unknown92'],
  0x93: [2, 'unknown93'],
  0x94: [2, 'ccCoachLeft'],
  0x95: [2, 'ccCoachRight'],
  0x96: [1, 'pitLaneStart'],
  0x97: [1, 'pitLaneEnd'],
  0x98: [2, 'fenceHeightLeft'],
  0x99: [2, 'fenceHeightRight'],
  0x9a: [3, 'fenceHeightCustom'],
  0x9b: [1, 'pitMarker1'],
  0x9c: [1, 'pitMarker2'],
  0x9d: [1, 'pitMarker3'],
  0x9e: [1, 'pitMarker4'],
  0x9f: [1, 'pitFencesStart'],
  0xa0: [1, 'pitFencesEnd'],
  0xa1: [1, 'pitEntryJoinRight'],
  0xa2: [1, 'pitEntryJoinLeft'],
  0xa3: [1, 'pitExitJoinRight'],
  0xa4: [1, 'pitExitJoinLeft'],
  0xa5: [1, 'angleRule'],            // section starts without the opening half-step
  0xa6: [3, 'flagsA6'],
  0xa7: [3, 'flagsA7'],
  0xa8: [1, 'chequeredFlag'],
  0xa9: [2, 'pitViewDistance'],
  0xaa: [4, 'ccPitLane'],
  0xab: [3, 'unknownAB'],
  0xac: [5, 'palette'],
};

/** Section flag bits (ArgDocs track-sections, ArgData TrackSection.cs). */
export const SECTION_FLAGS = {
  pitEntrance: 0x1, pitExit: 0x2, lowKerb: 0x4, roadSigns: 0x8,
  bridgeRightFence: 0x10, bridgeLeftFence: 0x20, signArrow: 0x40, signArrow100: 0x80,
  unknown100: 0x100, unknown200: 0x200, rightKerb: 0x400, leftKerb: 0x800,
  hideRightWall: 0x1000, hideLeftWall: 0x2000, unknown4000: 0x4000, unknown8000: 0x8000,
};

function flagNames(f) {
  const out = [];
  for (const [k, bit] of Object.entries(SECTION_FLAGS)) if (f & bit) out.push(k);
  return out;
}

// Sections list: commands (b2 != 0) precede the section they belong to;
// a section is b1=length, b2=0, then s16 curvature, s16 height, s16 flags,
// u8 right verge, u8 left verge. Ends with FF FF.
function readSections(r, start) {
  const sections = [];
  let pending = [];
  let p = start;
  let tlu = 0;
  for (;;) {
    if (p + 2 > r.len) throw new Error(`sections run past end of file at ${p}`);
    const b1 = r.u8(p), b2 = r.u8(p + 1);
    if (b1 === 0xff && b2 === 0xff) { p += 2; break; }
    if (b2 !== 0) {
      const def = COMMANDS[b2];
      if (!def) throw new Error(`unknown track command 0x${b2.toString(16)} at file offset ${p}`);
      const args = [b1];
      for (let i = 1; i < def[0]; i++) args.push(r.s16(p + 2 * i));
      pending.push({ cmd: b2, name: def[1], args, offset: p });
      p += 2 * def[0];
      continue;
    }
    const sec = {
      index: sections.length,
      offset: p,
      length: b1,
      curvature: r.s16(p + 2),
      height: r.s16(p + 4),
      flags: r.u16(p + 6),
      rightVerge: r.u8(p + 8),
      leftVerge: r.u8(p + 9),
      commands: pending,
      startTlu: tlu,
    };
    sec.flagNames = flagNames(sec.flags);
    tlu += sec.length;
    sections.push(sec);
    pending = [];
    p += 10;
  }
  return { sections, trailingCommands: pending, end: p, totalTlu: tlu };
}

// ------------------------------------------------------------ the parser

/**
 * Parse a whole track file.
 * @param {Uint8Array} bytes
 */
export function parseTrack(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('parseTrack wants a Uint8Array');
  const r = reader(bytes);
  if (r.len < 0x1010 + 32) throw new Error('file too short for a track');
  const at = {};

  // Horizon: 0x1000 bytes of palette indices (ArgDocs: 512 x 8... stored as is).
  const horizon = bytes.subarray(0, 0x1000);

  // Offsets at $1000.
  const offsets = {
    base: r.s16(0x1000),
    unknown1002: r.s16(0x1002),
    unknown1004: r.s16(0x1004),
    unknown1006: r.s16(0x1006),
    checksum: r.s16(0x1008) + 0x1010,
    objectData: r.s16(0x100a) + 0x1010,
    trackData: r.s16(0x100c) + 0x1010,
  };

  // Checksum (last four bytes).
  const calc = f1gpChecksum(bytes);
  const checksum = {
    stored: [r.u16(r.len - 4), r.u16(r.len - 2)],
    calculated: [calc.sum, calc.rot],
    offsetMatches: offsets.checksum === r.len - 4,
  };
  checksum.ok = checksum.stored[0] === calc.sum && checksum.stored[1] === calc.rot;

  // Object shapes: count at $100E, then count x s32 offsets (relative to $1010).
  const objectShapes = readObjectShapes(bytes, r, offsets);

  // Object settings: 16-byte records from objectData to trackData.
  const objectSettings = [];
  for (let p = offsets.objectData, i = 0; p + 16 <= offsets.trackData; p += 16, i++) {
    objectSettings.push({
      index: i, offset: p,
      id: r.u8(p), detail: r.u8(p + 1), unknown2: r.s16(p + 2),
      distance: r.s16(p + 4),      // from track centre, negative = left
      angleX: r.s16(p + 6), angleY: r.s16(p + 8), unknown10: r.s16(p + 10),
      height: r.s16(p + 12), id2: r.s16(p + 14),
    });
  }

  // Track data header.
  const h = offsets.trackData;
  const kerbType = r.u8(h + 18);
  const header = {
    offset: h,
    length: kerbType === 4 ? 32 : 28,
    startAngle: r.u16(h),
    startPitch: r.s16(h + 2),        // ArgDocs "starting height"; behaves as the initial pitch
    x: r.s16(h + 4),                 // start/finish centre, wPosX units (1/8 ft); << 3 = fine
    z: r.s16(h + 6),
    y: r.s16(h + 8),
    startWidth: r.s16(h + 10),       // half-width, fine units
    poleSide: r.s16(h + 12) === -768 ? 'left' : 'right',
    poleRaw: r.s16(h + 12),
    pitSide: r.u8(h + 14) === 0 ? 'right' : 'left',
    pitRaw: r.u8(h + 14),
    surrounding: r.u8(h + 15),       // 0 green, 128/192 grey
    rightVerge: r.u8(h + 16),
    leftVerge: r.u8(h + 17),
    kerbType: kerbType === 4 ? 'triple' : 'dual',
    kerbUpper: r.u8(h + 22),
    kerbLower: r.u8(h + 24),
  };
  if (kerbType === 4) { header.kerbUpper2 = r.u8(h + 28); header.kerbLower2 = r.u8(h + 30); }
  header.raw = Array.from(bytes.subarray(h, h + header.length));

  // Track sections.
  const main = readSections(r, h + header.length);
  at.sections = h + header.length;

  // Computer-car racing line: first entry u8 len, 0x80, s16 displacement, s16 correction, s16 radius;
  // then u8 len, u8 type (0x40 = wide radius: s16 corr, s16 hi, s16 lo; else s16 corr, s16 radius);
  // ends when the next s16 is 0.
  at.ccLine = main.end;
  let p = main.end;
  const ccLine = { displacement: r.s16(p + 2), segments: [] };
  ccLine.segments.push({ length: r.u8(p), type: r.u8(p + 1), correction: r.s16(p + 4), radius: r.s16(p + 6) });
  p += 8;
  for (;;) {
    const len = r.u8(p), type = r.u8(p + 1);
    if (type === 0x40) {
      ccLine.segments.push({ length: len, type, correction: r.s16(p + 2), highRadius: r.s16(p + 4), lowRadius: r.s16(p + 6) });
      p += 8;
    } else {
      ccLine.segments.push({ length: len, type, correction: r.s16(p + 2), radius: r.s16(p + 4) });
      p += 6;
    }
    if (r.s16(p) === 0) { p += 2; break; }
    if (p >= r.len) throw new Error('racing line runs past end of file');
  }
  ccLine.totalTlu = ccLine.segments.reduce((s, x) => s + x.length, 0);

  // CC setup (10 bytes) + 14 s16 values.
  at.ccData = p;
  const ccSetup = {
    frontWing: r.u8(p) - 151, rearWing: r.u8(p + 1) - 151,
    gears: [2, 3, 4, 5, 6, 7].map((i) => r.u8(p + i) - 151),
    tyre: r.u8(p + 8) - 52, brakeBalance: r.s8(p + 9),
  };
  const names1 = ['gripFactor', 'lateBrakingNonRace', 'lateBrakingRace', 'timeFactorNonRace', 'acceleration',
    'airResistance', 'tyreWearQualifying', 'tyreWearNonQualifying', 'fuelLoad', 'timeFactorRace',
    'ccPowerFactor', 'lateBrakingWetRace', 'unknownTrackDistance', 'pitLaneViewDistance'];
  const ccData = {};
  names1.forEach((n, i) => { ccData[n] = r.s16(p + 10 + 2 * i); });
  p += 10 + 28;

  // Pit lane sections (same format).
  at.pitLane = p;
  const pit = readSections(r, p);
  p = pit.end;

  // Camera definitions: two bytes each, end at b1 = FF.
  at.cameras = p;
  const cameras = [];
  for (;;) {
    const b1 = r.u8(p), b2 = r.u8(p + 1);
    p += 2;
    if (b1 === 0xff) break;
    if (b1 >= 0x80) cameras.push({ type: 'rightRange', from: b1 & 0x7f, to: b2 });
    else if (b2 === 0) cameras.push({ type: 'delete', camera: b1 });
    else cameras.push({ type: 'move', camera: b1, back: b2 & 0x7f, right: (b2 & 0x80) !== 0 });
    if (p >= r.len) throw new Error('camera list runs past end of file');
  }

  // Additional data and behaviour (28 bytes).
  at.behaviour = p;
  const behaviour = {
    unknown: Array.from(bytes.subarray(p, p + 16)),
    formationLength: r.s16(p + 16),
    lapTimeIndication: r.s32(p + 18),   // ms
    laps: r.s16(p + 22),
    firstPitStopLap: r.s16(p + 24),
    strategyChance: r.s16(p + 26),
  };
  p += 28;
  at.checksum = p;
  at.end = r.len;

  return {
    size: r.len,
    checksum,
    horizon,
    offsets,
    at,                                  // file offsets of each part
    objectShapes,
    objectSettings,
    header,
    sections: main.sections,
    trailingCommands: main.trailingCommands,
    totalTlu: main.totalTlu,
    ccLine,
    ccSetup,
    ccData,
    pitSections: pit.sections,
    pitTrailingCommands: pit.trailingCommands,
    pitTotalTlu: pit.totalTlu,
    cameras,
    behaviour,
    layoutOk: p === r.len - 4,          // every part accounted for, checksum follows
  };
}

// Object shapes: header of 16 s16 values (ArgDocs object-shapes; ArgData
// ObjectShapesReader). The internal offsets are file offsets. Only the parts
// a map or a later 3D build need are decoded: scale values, points (8 bytes
// each: s16 x, s16 y, u16 z, u16 extra), vectors (u8 from, u8 to). The
// graphical-elements block is kept raw.
function readObjectShapes(bytes, r, offsets) {
  const count = r.s16(0x100e);
  const list = [];
  const offs = [];
  for (let i = 0; i < count; i++) offs.push(r.s32(0x1010 + 4 * i));
  for (let i = 0; i < count; i++) {
    const rel = offs[i];
    const bigger = offs.filter((o) => o > rel);
    const nextRel = bigger.length ? Math.min(...bigger) : offsets.objectData - 0x1010;
    const start = 0x1010 + rel, end = 0x1010 + nextRel;
    const hv = [];
    for (let k = 0; k < 16; k++) hv.push(r.s16(start + 2 * k));
    const shape = {
      index: i, start, length: end - start,
      scaleOffset: hv[1], graphicsOffset: hv[3], pointsOffset: hv[5], vectorsOffset: hv[7], offset5: hv[14],
      headerValues: hv,
    };
    // Sanity: offsets must be increasing and inside the shape.
    const okOffsets = start + 32 <= shape.scaleOffset && shape.scaleOffset <= shape.graphicsOffset &&
      shape.graphicsOffset <= shape.pointsOffset && shape.pointsOffset <= shape.vectorsOffset &&
      shape.vectorsOffset <= shape.offset5 && shape.offset5 <= end;
    shape.ok = okOffsets;
    if (okOffsets) {
      shape.scaleValues = [];
      for (let q = shape.scaleOffset; q + 2 <= shape.graphicsOffset; q += 2) shape.scaleValues.push(r.s16(q));
      shape.graphics = bytes.subarray(shape.graphicsOffset, shape.pointsOffset);
      shape.points = [];
      for (let q = shape.pointsOffset; q + 8 <= shape.vectorsOffset; q += 8) {
        shape.points.push({ x: r.s16(q), y: r.s16(q + 2), z: r.u16(q + 4), extra: r.u16(q + 6) });
      }
      shape.vectors = [];
      for (let q = shape.vectorsOffset; q + 2 <= shape.offset5; q += 2) shape.vectors.push([r.u8(q), r.u8(q + 1)]);
      shape.tail = bytes.subarray(shape.offset5, end);
    }
    list.push(shape);
  }
  return list;
}

// ------------------------------------------------------------ trig

// The game's cosine table: 4,098 words, 0x4000 = 1.0, entry k = cos(k * pi/4096),
// i.e. one entry per 8 angle units from 0 to 180 degrees (image 0x2C3A4 in the
// unpacked gp.exe). Math.round reproduces it except entry 1992.
let COS = null;
export function cosTable() {
  if (COS) return COS;
  COS = new Int16Array(4098);
  for (let k = 0; k < 4098; k++) COS[k] = Math.round(16384 * Math.cos((k * Math.PI) / 4096));
  COS[1992] = 703; // the game's table differs from Math.round here (704)
  return COS;
}

/** cos of a 16-bit angle without interpolation, 2.14 fixed point (the track compile uses this). */
export function cosRaw(a) {
  let x = a & 0xffff;
  if (x > 0x8000) x = 0x10000 - x;
  return cosTable()[x >> 3];
}
/** sin(a) = cos(0x4000 - a). */
export function sinRaw(a) { return cosRaw(0x4000 - a); }

/** Interpolated cos, in 1/8 steps (the game's run-time routine, used for cars). */
export function cosInterp(a) {
  let x = a & 0xffff;
  if (x > 0x8000) x = 0x10000 - x;
  const t = cosTable();
  const i = x >> 3, f = x & 7;
  return t[i] + (((t[i + 1] - t[i]) * f) >> 3);
}
export function sinInterp(a) { return cosInterp(0x4000 - a); }

// ------------------------------------------------------------ track compile

/**
 * Build the in-memory segments the way the game does: one per TLU, X/Y in
 * 19-bit fine units (1/1024 TLU), Z in fine units, headings in 1/65536 turn.
 *
 * Steps (Chequered Flag's port of the game's first compile pass, checked
 * against live memory): the heading used for a section's TLUs is offset by
 * half a curvature step so each TLU steps along its middle heading; each TLU
 * moves (sin a, cos a) * 1024 >> 14; the track half-width follows command
 * 0x85; at the end the start/finish mismatch is spread over the lap.
 *
 * @param {object} track  result of parseTrack
 * @param {object} [opt]
 * @param {boolean} [opt.fit=true]       spread the closure error like the game
 * @param {'pass1'|'game'} [opt.mode]    kept for experiments
 * @returns {{segs: object[], closure: object}}
 */
export function compileTrack(track, opt = {}) {
  const fit = opt.fit !== false;
  const hdr = track.header;
  const startPitch = opt.startPitch ?? hdr.startPitch;
  const startZ = opt.startZ ?? hdr.z;
  const st = {
    angZ2: s16(hdr.startAngle), angZ: s16(hdr.startAngle), angX: s16(startPitch),
    x: hdr.x << 3, y: hdr.y << 3, z: startZ,
    width: hdr.startWidth, widthLeft: 0, widthStep: 0,
  };
  const segs = [];
  const sectionStarts = [];
  for (const sec of track.sections) {
    sectionStarts.push({ angle: u16(st.angZ2), pitch: st.angX, x: st.x, y: st.y, z: st.z, width: st.width, firstSeg: segs.length });
    let a5 = false;
    for (const c of sec.commands) {
      if (c.cmd === 0x85) {
        const n = c.args[1], w = c.args[2];
        st.widthLeft = n;
        if (n === 0) { st.width = w; st.widthStep = 0; } else st.widthStep = Math.trunc((w - st.width) / n);
      } else if (c.cmd === 0xa5) a5 = true;
    }
    walkSection(st, sec, a5, segs, sec.index);
  }
  const last = segs.length - 1;
  // Closure before fitting: where the walk ends compared with segment 0.
  const end = { x: st.x, y: st.y, z: st.z, angle: u16(st.angZ2) };
  const closure = {
    endDx: end.x - segs[0].x, endDy: end.y - segs[0].y, endDz: end.z - segs[0].z,
    endAngle: s16(end.angle - segs[0].angle),
    lastDx: segs[0].x - segs[last].x, lastDy: segs[0].y - segs[last].y,
  };
  closure.endDist = Math.hypot(closure.endDx, closure.endDy);
  if (fit) spreadClosure(segs, segs[0].x - segs[last].x, segs[0].y - segs[last].y, segs[0].z - segs[last].z);
  return { segs, closure, totalTlu: segs.length, sectionStarts };
}

function walkSection(st, sec, a5, segs, secIndex) {
  const C = sec.curvature, H = sec.height;
  let increment = true;
  let oldAngZ = 0;
  if (a5) {
    st.angZ2 = s16(st.angZ2 - (C >> 1));
    st.angX = s16(st.angX - (H >> 1));
  } else {
    oldAngZ = st.angZ;
    st.angZ = st.angZ2;
    st.angZ2 = s16(st.angZ2 + (C >> 1));
    st.angX = s16(st.angX + (H >> 1));
    increment = false;
  }
  for (let i = 0; i < sec.length; i++) {
    if (increment) {
      st.angZ2 = s16(st.angZ2 + C);
      oldAngZ = st.angZ;
      st.angZ = s16(st.angZ + C);
      st.angX = s16(st.angX + H);
    } else increment = true;
    const w = st.width;
    const seg = {
      index: segs.length, section: secIndex,
      angle: u16(st.angZ2), pitch: s16(st.angX), edgeAngle: u16(st.angZ),
      x: st.x, y: st.y, z: st.z, halfWidth: w,
      // the game's stored half-width vector (wPosX units, upper 10 bits of +0C/+0E)
      sideX: (cosRaw(st.angZ) * w) >> 17, sideY: (sinRaw(st.angZ) * w) >> 17,
    };
    segs.push(seg);
    st.x += (sinRaw(st.angZ2) * 1024) >> 14;
    st.y += (cosRaw(st.angZ2) * 1024) >> 14;
    st.z += (sinRaw(st.angX) * 1024) >> 14;
    if (st.widthLeft > 0) { st.widthLeft--; st.width += st.widthStep; }
  }
  st.angZ2 = s16(st.angZ2 + (C >> 1));
  st.angX = s16(st.angX + (H >> 1));
}

// Spread (dx, dy, dz) over segments 1..last, carrying the remainder (integer
// steps as in the game; JS division truncates like the 8086 IDIV).
function spreadClosure(segs, dx, dy, dz) {
  const n = segs.length;
  let rx = 0, ry = 0, rz = 0, ox = 0, oy = 0, oz = 0;
  for (let i = 1; i < n; i++) {
    rx += dx; ox += Math.trunc(rx / n); rx %= n;
    ry += dy; oy += Math.trunc(ry / n); ry %= n;
    rz += dz; oz += Math.trunc(rz / n); rz %= n;
    segs[i].x += ox; segs[i].y += oy; segs[i].z += oz;
  }
}

// ------------------------------------------------------------ outline for maps

/**
 * Everything a top-down map needs, in car world units (car+28/+2C) unless
 * opt.units = 'fine' (1/1024 TLU) or 'metres'.
 *   centre/left/right: one point per lap segment (index = segment number,
 *     the start of each TLU); draw as closed polygons. Right = the driver's
 *     right (+ lateral in car+0A). Edges are centre -/+ the half-width.
 *   pit: the same for the pit lane (index = pit segment), plus firstNr (the
 *     segment number of pit entry 0 without the 2000h flag) and the track
 *     segments where it leaves and rejoins.
 *   cameras: TV camera positions [{seg, side, x, y}], beside the track edge.
 *   startFinish: [left, right] end points of the line at segment 0.
 * @returns {{units:string, centre:number[][], left:number[][], right:number[][], heading:number[],
 *            pit:object, cameras:object[], startFinish:number[][], segs:object[], pitSegs:object[]}}
 */
export function trackOutline(track, opt = {}) {
  const units = opt.units || 'world';
  const k = units === 'world' ? WORLD_PER_FINE : units === 'metres' ? METRES_PER_FINE : 1;
  const { segs: all } = compileTrack(track, opt);
  const segs = all.slice(0, all.length - 1);          // the last TLU is segment 0 again
  const edges = (list) => {
    const centre = [], left = [], right = [], heading = [];
    for (const s of list) {
      // perpendicular to the right of travel: (cos a, -sin a); a = heading at the TLU start
      const c = cosRaw(s.edgeAngle) / 16384, sn = sinRaw(s.edgeAngle) / 16384;
      centre.push([s.x * k, s.y * k, s.z * k]);
      right.push([(s.x + c * s.halfWidth) * k, (s.y - sn * s.halfWidth) * k]);
      left.push([(s.x - c * s.halfWidth) * k, (s.y + sn * s.halfWidth) * k]);
      heading.push(s.angle);
    }
    return { centre, left, right, heading };
  };
  const lap = edges(segs);
  const pl = compilePitLane(track, all);
  const pitSegs = pl.segs.slice(0, Math.max(0, pl.segs.length - 1)); // the last one is the rejoin
  const pit = { ...edges(pitSegs), firstNr: pl.joins ? pl.joins[0] : null, leavesAt: pl.joins ? pl.joins[0] : null, rejoinsAt: pl.joins ? pl.joins[1] : null };
  const cameras = cameraSegments(track, segs.length).map((c) => {
    const s = segs[c.seg % segs.length];
    const side = c.side === 'right' ? 1 : -1, d = s.halfWidth + 256; // 4 ft outside the edge
    const cc = cosRaw(s.edgeAngle) / 16384, sn = sinRaw(s.edgeAngle) / 16384;
    return { ...c, x: (s.x + side * cc * d) * k, y: (s.y - side * sn * d) * k };
  });
  return { units, ...lap, pit, cameras, startFinish: [lap.left[0], lap.right[0]], segs, pitSegs };
}

/**
 * The compiled segment for a segment number read from the game (word +1A of
 * the segment a car's +12 pointer points at): bits 0-11 index, bit 1000h a
 * run-time flag (seen on segments where a car was crawling), bit 2000h pit
 * lane (index = firstNr + pit index), bits 4000h/8000h camera flags. Works
 * whichever array the game currently keeps the pit lane in.
 * @returns {{pit:boolean, index:number, seg:object}|null}
 */
export function lookupSegment(geo, nr) {
  const n = nr & 0x0fff;
  if (nr & 0x2000) {
    const i = n - geo.pit.firstNr;
    return i >= 0 && i < geo.pitSegs.length ? { pit: true, index: i, seg: geo.pitSegs[i] } : null;
  }
  return n < geo.segs.length ? { pit: false, index: n, seg: geo.segs[n] } : null;
}

/**
 * Map a track-relative position to world X/Y: compiled segment, distance
 * along it in fine units (car+1C) and lateral offset in fine units (car+0A,
 * + = right). Straight-line step along the segment heading; within about
 * 0.5 m of the car's X/Y in corners (the game also bends the along distance
 * by the heading change, seg+14; see probes/p1-fields-lib.cjs).
 */
export function segmentToWorld(seg, along = 0, lateral = 0, units = 'world') {
  const k = units === 'world' ? WORLD_PER_FINE : units === 'metres' ? METRES_PER_FINE : 1;
  const c = cosRaw(seg.angle) / 16384, sn = sinRaw(seg.angle) / 16384;
  return [(seg.x + sn * along + c * lateral) * k, (seg.y + c * along - sn * lateral) * k];
}

// ------------------------------------------------------------ TV cameras

/**
 * Where the TV cameras stand. The game puts one on the left every 16 TLU
 * (camera k at segment 16k). The camera definitions are applied in order to
 * per-segment flags: delete k clears segment 16k; move k (back b, right r)
 * clears 16k and sets 16k+b (on the right if r); a right range k1..k2 puts
 * the cameras at 16k1..16k2 on the right. Two moves of one camera therefore
 * leave two cameras (Hungaroring camera 42). Checked against the game:
 * segment number (+1A) bit 8000h = camera here, 4000h = on the right, on all
 * 16 circuits (out/p1-track/segments-vs-game.json).
 * @param {number} [lapSegs] segments in a lap (default totalTlu - 1)
 * @returns {{seg:number, side:'left'|'right', camera:number}[]} sorted by segment
 */
export function cameraSegments(track, lapSegs = track.totalTlu - 1) {
  const flags = new Map(); // seg -> {right, camera}
  for (let k = 0; 16 * k < lapSegs; k++) flags.set(16 * k, { right: false, camera: k });
  for (const c of track.cameras) {
    if (c.type === 'delete') flags.delete(16 * c.camera);
    else if (c.type === 'move') { flags.delete(16 * c.camera); flags.set(16 * c.camera + c.back, { right: c.right, camera: c.camera }); }
    else if (c.type === 'rightRange') for (let k = c.from; k <= c.to; k++) { const f = flags.get(16 * k); if (f) f.right = true; }
  }
  return [...flags.entries()].sort((a, b) => a[0] - b[0]).map(([seg, f]) => ({ seg, side: f.right ? 'right' : 'left', camera: f.camera }));
}

// ------------------------------------------------------------ pit lane

/** Pit lane half-width in fine units, as seen in memory (Monza: +0C low bits 20 -> 640..671; cos*W>>17 -> 640..646). */
export const PIT_HALF_WIDTH = 640;

/**
 * Build the pit-lane segments. The game keeps them in a second array whose
 * entry -1 is a copy of the track segment before the 0x86 section and whose
 * last entry is a copy of the track segment of the 0x87 section (the joins).
 * Method (fitted to the live arrays; within 0.15 m of the game on all 16 circuits):
 * start beside the first segment of the 0x86 section, (track half-width -
 * pit half-width) to the pit side, heading = the track heading at the start
 * of that section; walk the pit sections like the track; spread the miss at
 * the far end (target: beside the 0x87 section's first segment) over the lane.
 * Returns segs (one per pit TLU; the last one is replaced by the join) and the
 * track segment indices of both joins.
 */
export function compilePitLane(track, trackSegs, opt = {}) {
  const ts = trackSegs || compileTrack(track).segs;
  const comp = compileTrack(track);
  const find = (cmd) => track.sections.findIndex((s) => s.commands.some((c) => c.cmd === cmd));
  const s86 = find(0x86), s87 = find(0x87);
  if (s86 < 0 || s87 < 0 || !track.pitSections.length) return { segs: [], start: null, end: null };
  const k86 = track.sections[s86].startTlu, k87 = track.sections[s87].startTlu;
  const wp = opt.pitHalfWidth ?? PIT_HALF_WIDTH;
  const side = track.header.pitSide === 'left' ? -1 : 1;
  const beside = (k) => {
    const s = ts[k];
    const L = side * (s.halfWidth - wp);
    return [s.x + ((cosRaw(s.angle) * L) >> 14), s.y - ((sinRaw(s.angle) * L) >> 14)];
  };
  const [x0, y0] = beside(k86);
  const start = comp.sectionStarts[s86];
  const st = { angZ2: s16(start.angle), angZ: s16(start.angle), angX: s16(ts[k86].pitch), x: x0, y: y0, z: ts[k86].z, width: wp, widthLeft: 0, widthStep: 0 };
  const segs = [];
  for (const sec of track.pitSections) {
    let a5 = false;
    for (const c of sec.commands) {
      if (c.cmd === 0x85) {
        const n = c.args[1], w = c.args[2];
        st.widthLeft = n;
        if (n === 0) { st.width = w; st.widthStep = 0; } else st.widthStep = Math.trunc((w - st.width) / n);
      } else if (c.cmd === 0xa5) a5 = true;
    }
    walkSection(st, sec, a5, segs, sec.index);
  }
  const last = segs.length - 1;
  const [x1, y1] = beside(k87);
  const end = { k: k87, x: x1, y: y1, z: ts[k87].z, missX: x1 - segs[last].x, missY: y1 - segs[last].y };
  if (opt.fit !== false) spreadClosure(segs, end.missX, end.missY, end.z - segs[last].z);
  return { segs, start: { k: k86, x: x0, y: y0, angle: start.angle }, end, joins: [k86, k87] };
}

// ------------------------------------------------------------ live memory

/**
 * Decode `count` in-memory segments (0x2E bytes each) starting at byte
 * `offset` of `bytes` (e.g. guest RAM, offset = (DS:87A1 << 4) + DS:879F).
 * Field names follow René Smit's GPDEF.INC where known.
 */
export function decodeSegments(bytes, offset, count) {
  const r = reader(bytes);
  const out = [];
  for (let i = 0; i < count; i++) {
    const o = offset + i * 0x2e;
    const fine = r.u8(o + 0x21), sx = r.s16(o + 0x0c), sy = r.s16(o + 0x0e);
    out.push({
      index: i, angle: r.u16(o), pitch: r.s16(o + 2),
      x: (r.s16(o + 4) << 3) | (fine & 7), z: r.s16(o + 6), y: (r.s16(o + 8) << 3) | ((fine >> 4) & 7),
      texture: r.u16(o + 0x0a), sideX: sx >> 6, widthLow: sx & 63, sideY: sy >> 6, sideYLow: sy & 63,
      flags10: r.u8(o + 0x10), extraX: r.s8(o + 0x11), flags12: r.u8(o + 0x12), extraY: r.s8(o + 0x13),
      dAngle: r.s16(o + 0x14), ccLine: r.s16(o + 0x16), ccAngle: r.s16(o + 0x18), nr: r.u16(o + 0x1a),
      segDist: r.s16(o + 0x1c), objectId: r.u8(o + 0x1e), pitJoin: r.u8(o + 0x1f), viewDist: r.u8(o + 0x20),
    });
  }
  return out;
}
