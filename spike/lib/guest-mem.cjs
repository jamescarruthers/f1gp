// Read the emulated PC's memory from JavaScript while the game runs.
//
// Works when js-dos runs DOSBox in the same thread (Node's dosboxNode, or
// dosboxDirect in the browser): the Emscripten module is reachable as
// ci.transport.module, and guest RAM is one block inside its HEAPU8.
// Worker mode keeps the heap in the worker, so this does not work there.
//
//   const { locate } = require("./guest-mem.cjs");
//   const mem = locate(emu.ci);          // after gp.exe has loaded
//   mem.u16(mem.imageSeg + 0x10, 0x20)   // read segment:offset
//
// Tested with F1GP 1.05 (European): gp.exe loads at linear 0x1A20.

// DOSBox writes its BIOS date at F000:FFF5.
const BIOS_DATE = Buffer.from("01/01/92");
const BIOS_DATE_LINEAR = 0xffff5;

// A message inside gp.exe and its offset in the unpacked load image
// (see tools/unexepack.mjs). Used to find where DOS loaded the program.
const GP_SIGNATURES = [
  { version: "F1GP 1.05 (European)", text: "Link data mismatch. Press escape to repair", offset: 167759 },
];

function heapOf(ci) {
  const module = ci && ci.transport && ci.transport.module;
  if (!module || !module.HEAPU8) {
    throw new Error("no direct access to the emulator heap; start js-dos in Node or direct (main-thread) mode");
  }
  return module;
}

function findAll(heap, needle) {
  const buf = Buffer.from(heap.buffer, heap.byteOffset, heap.length);
  const hits = [];
  for (let i = buf.indexOf(needle); i !== -1; i = buf.indexOf(needle, i + 1)) hits.push(i);
  return hits;
}

function locate(ci) {
  const module = heapOf(ci);
  const heap = () => module.HEAPU8; // re-read: the heap buffer can be replaced if memory grows

  // Guest RAM base: a BIOS date hit whose interrupt table looks real
  // (INT 21h pointing into the BIOS segment F000, where DOSBox puts its handlers).
  let memBase = -1;
  for (const hit of findAll(heap(), BIOS_DATE)) {
    const base = hit - BIOS_DATE_LINEAR;
    if (base < 0) continue;
    const h = heap();
    const int21Seg = h[base + 0x86] | (h[base + 0x87] << 8);
    if (int21Seg === 0xf000) { memBase = base; break; }
  }
  if (memBase < 0) throw new Error("guest RAM not found");

  let image = null;
  for (const sig of GP_SIGNATURES) {
    const hits = findAll(heap(), Buffer.from(sig.text)).filter((i) => i > memBase);
    if (hits.length) {
      const linear = hits[0] - memBase - sig.offset;
      if (linear % 16 === 0) image = { version: sig.version, linear };
      break;
    }
  }

  const lin = (seg, off) => memBase + ((seg << 4) + off);
  return {
    memBase,
    imageLinear: image ? image.linear : null,
    imageSeg: image ? image.linear >> 4 : null,
    version: image ? image.version : null,
    heap,
    u8: (seg, off) => heap()[lin(seg, off)],
    u16: (seg, off) => { const h = heap(), p = lin(seg, off); return h[p] | (h[p + 1] << 8); },
    s16: (seg, off) => { const h = heap(), p = lin(seg, off); return ((h[p] | (h[p + 1] << 8)) << 16) >> 16; },
    u32: (seg, off) => { const h = heap(), p = lin(seg, off); return (h[p] | (h[p + 1] << 8) | (h[p + 2] << 16) | (h[p + 3] << 24)) >>> 0; },
    // Copy of a linear range, e.g. for diffing memory between frames.
    snapshot: (linear, length) => heap().slice(memBase + linear, memBase + linear + length),
  };
}

module.exports = { locate };
