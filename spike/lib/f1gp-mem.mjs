// f1gp-mem.mjs - find the emulated PC's RAM and gp.exe (F1GP 1.05) inside
// js-dos, and read it fast, by linear address or by segment:offset.
//
// Plain ES module: Uint8Array code only, no Buffer or other Node APIs, so it
// runs in Node and in the browser. Same method as lib/guest-mem.cjs (which it
// does not import): works only when DOSBox runs in the same thread as this
// code (Node's dosboxNode, or js-dos "direct" mode in the browser), where the
// Emscripten module is ci.transport.module and guest RAM is one block inside
// module.HEAPU8. In worker mode the heap lives in the worker and attach()
// throws.
//
//   import { attach } from './f1gp-mem.mjs';
//   const mem = attach(ci);                 // after gp.exe has loaded
//   mem.ds.u16(0x097f)                      // DS:097F (viewed car)
//   mem.u32(mem.lin(mem.DS, 0x2955))        // the same by linear address
//
//   import { fromRam } from './f1gp-mem.mjs';
//   const mem = fromRam(ramDump);           // a 1 MB dump, index 0 = linear 0
//
// Addresses: DS = imageSeg + 1E61h and SS = imageSeg + 2914h, where imageSeg
// is the paragraph DOS loaded gp.exe's image at (0x1A2 in all our runs). The
// relation comes from the program's own "mov ax,1E61h; mov ds,ax" and its
// EXE header SS (static code, see docs/memory-map.md); attach() checks it by
// reading the cosine table the game keeps at SS:3264.

// DOSBox writes its BIOS date string at F000:FFF5.
const BIOS_DATE = [0x30, 0x31, 0x2f, 0x30, 0x31, 0x2f, 0x39, 0x32]; // "01/01/92"
const BIOS_DATE_LINEAR = 0xffff5;
const GUEST_RAM_BYTES = 0x110000; // 1 MB + HMA; gp.exe lives in conventional memory

/** Known gp.exe builds: a text inside the image, its offset in the unpacked load image, and the DS/SS paragraphs relative to the load segment. */
export const GP_VERSIONS = [
  { version: 'F1GP 1.05 (European)', text: 'Link data mismatch. Press escape to repair', offset: 167759, dsRel: 0x1e61, ssRel: 0x2914 },
];

const ascii = (s) => Array.from(s, (c) => c.charCodeAt(0));

// All positions of `needle` (array of bytes) in heap[from, to).
function findAll(heap, needle, from = 0, to = heap.length, max = Infinity) {
  const hits = [];
  // anchor on the needle's rarest-looking byte (not '0'): the last one
  const k = needle.length - 1, last = needle[k];
  let i = heap.indexOf(last, from + k);
  while (i !== -1 && i < to) {
    const s = i - k;
    let ok = true;
    for (let j = 0; j < k; j++) if (heap[s + j] !== needle[j]) { ok = false; break; }
    if (ok) { hits.push(s); if (hits.length >= max) break; }
    i = heap.indexOf(last, i + 1);
  }
  return hits;
}

/** Offset of guest linear address 0 inside `heap`, or -1. */
export function findGuestRam(heap) {
  for (const hit of findAll(heap, BIOS_DATE)) {
    const base = hit - BIOS_DATE_LINEAR;
    if (base < 0) continue;
    // a real interrupt table: INT 21h points into DOSBox's BIOS segment F000
    const int21Seg = heap[base + 0x86] | (heap[base + 0x87] << 8);
    if (int21Seg === 0xf000) return base;
  }
  return -1;
}

/** Where DOS loaded gp.exe: { linear, version entry } or null. */
export function findImage(heap, memBase) {
  const end = Math.min(heap.length, memBase + GUEST_RAM_BYTES);
  for (const v of GP_VERSIONS) {
    const hits = findAll(heap, ascii(v.text), memBase, end, 4);
    for (const h of hits) {
      const linear = h - memBase - v.offset;
      if (linear > 0 && linear % 16 === 0) return { linear, v };
    }
  }
  return null;
}

// Build the reader object over a heap getter.
function makeMem(getHeap, memBase, image) {
  const u8 = (l) => getHeap()[memBase + l];
  const s8 = (l) => (getHeap()[memBase + l] << 24) >> 24;
  const u16 = (l) => { const h = getHeap(), p = memBase + l; return h[p] | (h[p + 1] << 8); };
  const s16 = (l) => { const h = getHeap(), p = memBase + l; return ((h[p] | (h[p + 1] << 8)) << 16) >> 16; };
  const s32 = (l) => { const h = getHeap(), p = memBase + l; return h[p] | (h[p + 1] << 8) | (h[p + 2] << 16) | (h[p + 3] << 24); };
  const u32 = (l) => s32(l) >>> 0;
  const lin = (seg, off) => (seg << 4) + off;
  const seg = (sg) => {
    const b = sg << 4;
    return {
      segment: sg, linear: (off) => b + off,
      u8: (off) => u8(b + off), s8: (off) => s8(b + off), u16: (off) => u16(b + off),
      s16: (off) => s16(b + off), u32: (off) => u32(b + off), s32: (off) => s32(b + off),
    };
  };
  const mem = {
    memBase,
    version: image ? image.v.version : null,
    imageLinear: image ? image.linear : null,
    imageSeg: image ? image.linear >> 4 : null,
    DS: image ? (image.linear >> 4) + image.v.dsRel : null,
    SS: image ? (image.linear >> 4) + image.v.ssRel : null,
    /** The current backing array (re-read each time: Emscripten may replace it when memory grows). */
    heap: getHeap,
    lin, u8, s8, u16, s16, u32, s32, seg,
    /** View of guest bytes [linear, linear+length) without copying (invalid once the heap is replaced). */
    bytes: (l, length) => getHeap().subarray(memBase + l, memBase + l + length),
    /** Copy of guest bytes [linear, linear+length). */
    snapshot: (l, length) => getHeap().slice(memBase + l, memBase + l + length),
  };
  if (image) {
    mem.ds = seg(mem.DS);
    mem.ss = seg(mem.SS);
    mem.dsLinear = mem.DS << 4;
    mem.ssLinear = mem.SS << 4;
    // check DS/SS: SS:3264 is the game's cosine table (cos 0 = 4000h, cos 180 deg = -4000h)
    mem.checked = mem.ss.s16(0x3264) === 0x4000 && mem.ss.s16(0x3264 + 2 * 4096) === -0x4000;
  }
  return mem;
}

function moduleOf(src) {
  if (src && src.transport && src.transport.module && src.transport.module.HEAPU8) return src.transport.module;
  if (src && src.HEAPU8) return src; // an Emscripten module
  return null;
}

/**
 * Attach to a running emulator. `src` is a js-dos CommandInterface (Node
 * dosboxNode or browser direct mode) or an Emscripten module with HEAPU8.
 * Throws when the heap is not reachable or guest RAM is not found; when
 * gp.exe is not (yet) in memory, imageSeg/DS/SS are null unless
 * opts.requireGame is true, in which case it throws.
 */
export function attach(src, opts = {}) {
  const module = moduleOf(src);
  if (!module) throw new Error('no direct access to the emulator heap: start js-dos in Node or in direct (main-thread) mode');
  const getHeap = () => module.HEAPU8;
  const memBase = opts.memBase !== undefined ? opts.memBase : findGuestRam(getHeap());
  if (memBase < 0) throw new Error('guest RAM not found in the emulator heap');
  const image = opts.imageSeg ? { linear: opts.imageSeg << 4, v: GP_VERSIONS[0] } : findImage(getHeap(), memBase);
  if (!image && opts.requireGame) throw new Error('gp.exe not found in guest memory');
  return makeMem(getHeap, memBase, image);
}

/**
 * Reader over a RAM dump (Uint8Array, index 0 = guest linear 0), e.g. the
 * 1 MB dumps the probes save. imageSeg is found from the gp.exe text, or
 * taken from opts.imageSeg.
 */
export function fromRam(ram, opts = {}) {
  const getHeap = () => ram;
  const image = opts.imageSeg ? { linear: opts.imageSeg << 4, v: GP_VERSIONS[0] } : findImage(ram, 0);
  if (!image && opts.requireGame) throw new Error('gp.exe not found in the RAM dump');
  return makeMem(getHeap, 0, image);
}
