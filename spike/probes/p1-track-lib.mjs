// p1-track-lib.mjs - compare guest-RAM dumps of the game's segment arrays with
// lib/track-file.mjs. Used by probes/p1-track-compare.mjs and the test.
//
// Array layout seen in the game (gp.exe 1.05 EU):
//   track array: DS:87A1 (segment) : DS:879F (offset, 0030h), 0x2E bytes per entry
//   pit array:   DS:8799 : DS:8797; entry -1 is a copy of the track segment
//                before the 0x86 section, the last entry a copy of the 0x87 one
//   SS:015C     offset of the entry after the lap (a copy of segment 0)
//   entry +1A   number: bits 0-12 track index, or (first TLU of the 0x86
//               section) + pit index with bit 2000h set for pit-lane entries;
//               bit 8000h = a TV camera stands at this segment, 4000h = on
//               the right (see the camera check in p1-track-compare.mjs)
// With the player in the pit lane (practice start) the game swaps the pit
// lane into the track array and the bypassed track into the pit array, so
// entries are matched by number, not by position.
import { parseTrack, compileTrack, compilePitLane, decodeSegments, cameraSegments, CIRCUITS } from '../lib/track-file.mjs';

export const PIT_NR_BASE = 0x2000;
const wrap16 = (v) => (((v & 0xffff) + 0x8000) & 0xffff) - 0x8000;

export function compiledFor(trackBytes) {
  const track = parseTrack(trackBytes);
  const { segs } = compileTrack(track);
  const pit = compilePitLane(track, segs);
  const camFlags = new Map();
  for (const c of cameraSegments(track)) camFlags.set(c.seg, 0x8000 | (c.side === 'right' ? 0x4000 : 0));
  return { track, segs, pit, camFlags };
}

/** Entries of both arrays, decoded and tagged with the array and position. */
export function liveEntries(ram, meta, extra = 8) {
  const out = [];
  // read up to the largest lap (1420 segments) + a few; stop at the first all-zero entry
  const take = (lin, from, max, array) => {
    const list = decodeSegments(ram, lin + from * 0x2e, max);
    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      if (s.x === 0 && s.y === 0 && s.angle === 0 && s.sideX === 0) break; // end of the used array
      out.push({ ...s, array, pos: from + i });
    }
  };
  take(meta.trackSeg * 16 + meta.trackBase, 0, 1430, 'track');
  take(meta.pitSeg * 16 + meta.pitBase, -1, 260 + extra, 'pit');
  return out;
}

/** Compare every entry by its number with the compile. */
export function compareLive(ram, meta, comp) {
  const k86 = comp.pit.joins ? comp.pit.joins[0] : -1;
  const res = { cameras: { n: 0, flagMismatch: 0, cameraSegs: 0 }, track: { n: 0, exact: 0, maxXY: 0, maxAngle: 0, maxZ: 0, maxPitch: 0, sideMismatch: 0 }, pit: { n: 0, maxXY: 0, maxAngle: 0, maxZ: 0, sideMismatch: 0, p95XY: 0 }, unknown: 0, swapped: false };
  const pitXY = [];
  for (const e of liveEntries(ram, meta)) {
    const nr = e.nr & 0x3fff;
    if (nr < PIT_NR_BASE) {
      const c = comp.segs[nr];
      if (!c) { res.unknown++; continue; }
      const r = res.track; r.n++;
      // camera flags: only on original entries (the join copies and the
      // end-of-lap copy have their flags cleared) and inside the lap
      const joinCopy = comp.pit.joins && (nr === comp.pit.joins[1] || nr === comp.pit.joins[0] - 1);
      const original = !joinCopy && ((e.array === 'track' && e.pos === nr) || (e.array === 'pit' && e.pos >= 0 && e.pos < comp.pit.segs.length - 1));
      if (original && nr < comp.segs.length - 1) {
        res.cameras.n++;
        const want = comp.camFlags.get(nr) || 0;
        if ((e.nr & 0xc000) !== want) res.cameras.flagMismatch++;
        if (want) res.cameras.cameraSegs++;
      }
      const dxy = Math.hypot(e.x - c.x, e.y - c.y);
      const da = Math.abs(wrap16(e.angle - c.angle)), dz = Math.abs(e.z - c.z), dp = Math.abs(e.pitch - c.pitch);
      if (dxy === 0 && da === 0 && dz === 0 && dp === 0) r.exact++;
      r.maxXY = Math.max(r.maxXY, dxy); r.maxAngle = Math.max(r.maxAngle, da); r.maxZ = Math.max(r.maxZ, dz); r.maxPitch = Math.max(r.maxPitch, dp);
      if (e.sideX !== c.sideX || e.sideY !== c.sideY || e.widthLow !== ((c.halfWidth >> 5) & 63)) r.sideMismatch++;
      if (e.array === 'pit' && e.pos >= 0 && e.pos < comp.pit.segs.length - 1) res.swapped = true;
    } else {
      const i = nr - PIT_NR_BASE - k86;
      const c = comp.pit.segs[i];
      if (!c || i >= comp.pit.segs.length - 1) { res.unknown++; continue; }
      const r = res.pit; r.n++;
      const dxy = Math.hypot(e.x - c.x, e.y - c.y);
      pitXY.push(dxy);
      r.maxXY = Math.max(r.maxXY, dxy); r.maxAngle = Math.max(r.maxAngle, Math.abs(wrap16(e.angle - c.angle))); r.maxZ = Math.max(r.maxZ, Math.abs(e.z - c.z));
      if (e.sideX !== c.sideX || e.sideY !== c.sideY || e.widthLow !== ((c.halfWidth >> 5) & 63)) r.sideMismatch++;
      if (e.array === 'track') res.swapped = true;
    }
  }
  pitXY.sort((a, b) => a - b);
  res.pit.p95XY = pitXY.length ? pitXY[Math.floor(pitXY.length * 0.95)] : 0;
  res.pit.maxXY = +res.pit.maxXY.toFixed(2); res.pit.p95XY = +res.pit.p95XY.toFixed(2); res.track.maxXY = +res.track.maxXY.toFixed(2);
  return res;
}

/** Which circuit a dump holds: the compile whose track entries match exactly. */
export function identify(ram, meta, compiled /* array of 16 compiledFor results */) {
  let best = null;
  compiled.forEach((comp, k) => {
    let n = 0, hit = 0;
    for (const e of liveEntries(ram, meta)) {
      const nr = e.nr & 0x3fff;
      if (nr >= PIT_NR_BASE) continue;
      const c = comp.segs[nr];
      n++; if (c && c.x === e.x && c.y === e.y) hit++;
    }
    if (n && (!best || hit / n > best.score)) best = { file: k + 1, name: CIRCUITS[k], score: hit / n, n };
  });
  return best;
}
