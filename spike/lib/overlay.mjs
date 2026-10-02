// One screen: the game draws its cockpit, dash and messages, we draw the 3D.
//
// The game's scene renderer (gp.exe 0F47:81CE, called five times from the
// main loop) is replaced by an 82-byte routine that fills the 3D viewport of
// the game's back buffer with one colour index K, where the renderer's own
// drawing would cover it each frame, and keeps the renderer's 2D parts:
//   - the palette step (19ED:008C), four times as the renderer makes it
//     between its steps: while a palette change is pending it sends the
//     next part of the palette to the VGA;
//   - in the cockpit, the mirror backdrop (19ED:3AFA, which the renderer's
//     sky step calls), so the mirror housings and glass stay;
//   - the end of the renderer's draw step (0F47:812B-8179): the start
//     lights (19ED:3B46), the cockpit patches (19ED:3C1A) and the cockpit's
//     pit-stop images (0F47:A944).
// The cars in the mirrors come from the renderer's car step, which is gone;
// paintMirrors() draws them on the page as the game would.
// Everything the game draws afterwards (cockpit, dash, the "Viewing" banner,
// PAUSED, menus over the race) lands on top as before, so in the finished
// frame K marks where our 3D view shows through. The page keys the game's
// frame (keyFrame) and lays it over its own view with K transparent.
//
// The routine keeps every register and returns with retf, as the renderer
// does; uninstall() puts the renderer back. install() checks the bytes at
// every address it uses first and refuses on a different gp.exe.
//
//   const r = sceneRoutine(mem, 0x17); r.install(); r.setView(viewportFill('cockpit'));
//   const bb = backBuffer(mem); // { pointer, pixels: Uint8Array(64000) }

import { drawSprite, hazeLevel } from './objects.mjs';
import { mirrorClip } from './cars.mjs';

const RENDERER = { seg: 0x0f47, off: 0x81ce };
const SERVICE_SEG = 0x19ed;
// code the routine replaces or calls: [segment, offset, first bytes]
const EXPECT = [
  [0x0f47, 0x81ce, [0x1e, 0x36, 0x8e, 0x1e, 0xf4, 0x00]],       // the renderer: push ds; mov ds, ss:[00F4]
  [0x19ed, 0x008c, [0x36, 0xf7, 0x06, 0xda, 0x08]],             // palette step: test word ss:[08DA], ...
  [0x19ed, 0x3afa, [0x1e, 0x06, 0x60, 0x36, 0x8e, 0x1e, 0xf0]], // mirror backdrop: push ds; push es; pusha; ...
  [0x0f47, 0x812b, [0x36, 0x8e, 0x1e, 0xf0, 0x00, 0xf6, 0x06, 0x81, 0x09]], // draw step's end: mov ds, ss:[00F0]; test [0981]
  [0x0f47, 0x8178, [0x1f, 0xc3]],                               // ... pop ds; ret
];
const TAIL = 0x812b;

// offsets of the patched fields in the routine, and of its call counter
const OFFSET_AT = 0x14, WORDS_AT = 0x17, K_AT = 0x1a, COUNT_AT = 0x50;
function routineBytes(k, offset, words, svc) {
  const lo = svc & 0xff, hi = svc >> 8;
  const count = RENDERER.off + COUNT_AT;
  const b = [
    0x1e, 0x06, 0x60,                         // 00 push ds; push es; pusha
    0x2e, 0xff, 0x06, count & 0xff, count >> 8, // 03 inc word cs:[COUNT] (the page sees the game draw)
    0x36, 0xa1, 0xf4, 0x00,                   // 08 mov ax, ss:[00F4]  (R)
    0x8e, 0xd8,                               // 0C mov ds, ax
    0xc4, 0x3e, 0x1c, 0x00,                   // 0E les di, [001C]     (the 3D view's first pixel)
    0x81, 0xc7, offset & 0xff, offset >> 8,   // 12 add di, OFFSET
    0xb9, words & 0xff, words >> 8,           // 16 mov cx, WORDS
    0xb8, k, k,                               // 19 mov ax, KK
    0xfc, 0xf3, 0xab,                         // 1C cld; rep stosw
    0x9a, 0x8c, 0x00, lo, hi,                 // 1F lcall 19ED:008C (x4)
    0x9a, 0x8c, 0x00, lo, hi,
    0x9a, 0x8c, 0x00, lo, hi,
    0x9a, 0x8c, 0x00, lo, hi,
    0x36, 0x8e, 0x06, 0xf0, 0x00,             // 33 mov es, ss:[00F0]  (game DS)
    0x26, 0xf6, 0x06, 0x81, 0x09, 0xff,       // 38 test byte es:[0981], FF (view: 0 = cockpit)
    0x75, 0x05,                               // 3E jne 45
    0x9a, 0xfa, 0x3a, lo, hi,                 // 40 lcall 19ED:3AFA (mirror backdrop)
    0xe8, 0x04, 0x00,                         // 45 call 4C
    0x61, 0x07, 0x1f, 0xcb,                   // 48 popa; pop es; pop ds; retf
    0x1e,                                     // 4C push ds (as the draw step pushed it)
    0xe9, 0, 0,                               // 4D jmp 0F47:812B (ends with pop ds; ret)
    0x00, 0x00,                               // 50 the call counter
  ];
  const rel = (TAIL - (RENDERER.off + 0x50)) & 0xffff;
  b[0x4e] = rel & 0xff; b[0x4f] = rel >> 8;
  return Uint8Array.from(b);
}

/**
 * The 3D viewport for a view: rows 0-102 in the cockpit, rows 16-179
 * otherwise (the game's screen layout, docs/memory-map.md). The routine fills
 * `words` from R:001C, which the game points at the viewport's first pixel
 * (offset 0 in the cockpit, 16 x 320 in the other views), so `offset` is 0.
 * In the cockpit the renderer draws below row 103 too (the road shows through
 * the cockpit's gaps, under the mirrors), so the fill there runs to row 179,
 * the buffer's last row in the other views.
 * @returns {{ top, rows, offset, words }}
 */
export function viewportFill(mode) {
  const cockpit = mode === 'cockpit';
  const top = cockpit ? 0 : 16, rows = cockpit ? 103 : 164;
  return { top, rows, offset: 0, words: (cockpit ? 180 : rows) * 160 };
}

/**
 * The replacement for the scene renderer.
 * @param {object} mem  attach()ed game memory (lib/f1gp-mem.mjs)
 * @param {number} k    colour index that marks "our 3D shows here"
 */
export function sceneRoutine(mem, k) {
  const lin = (seg, off) => mem.memBase + ((seg + mem.imageSeg) << 4) + off;
  const entry = lin(RENDERER.seg, RENDERER.off);
  const heap = () => mem.heap();
  const fill = viewportFill('chase');
  const bytes = routineBytes(k, fill.offset, fill.words, SERVICE_SEG + mem.imageSeg);
  let original = null, installed = false;
  const at = () => heap().subarray(entry, entry + bytes.length);
  const expected = () => EXPECT.every(([seg, off, want]) => { const H = heap(), a = lin(seg, off); return want.every((v, i) => H[a + i] === v); });
  return {
    entry, bytes,
    get original() { return original; },
    get installed() { return installed; },
    install() {
      if (installed) return true;
      if (!expected()) return false; // not the gp.exe we know: leave it alone
      original = Uint8Array.from(at());
      at().set(bytes);
      installed = true;
      return true;
    },
    uninstall() {
      if (!installed) return;
      at().set(original);
      installed = false;
    },
    /** Change the marker colour (each circuit has its own palette). */
    setK(newK) {
      if (newK === k) return;
      k = newK;
      bytes.set([k, k], K_AT);
      if (installed) at().set(bytes.subarray(K_AT, K_AT + 2), K_AT);
    },
    get k() { return k; },
    /** Calls since install (16 bits): it stops when the game stops drawing a race view (menus). */
    get calls() { if (!installed) return 0; const H = heap(); return H[entry + COUNT_AT] | (H[entry + COUNT_AT + 1] << 8); },
    setView(f) {
      if (f.offset === fill.offset && f.words === fill.words) return;
      fill.offset = f.offset; fill.words = f.words;
      bytes.set([f.offset & 0xff, f.offset >> 8], OFFSET_AT);
      bytes.set([f.words & 0xff, f.words >> 8], WORDS_AT);
      if (installed) { at().set(bytes.subarray(OFFSET_AT, OFFSET_AT + 2), OFFSET_AT); at().set(bytes.subarray(WORDS_AT, WORDS_AT + 2), WORDS_AT); }
    },
  };
}

/**
 * The game's back buffer, the whole 320x200 screen in palette indices. Its
 * segment is that of R:001C (R = SS:00F4); the screen starts at offset 0
 * (R:001C's offset is the 3D view's first pixel within it).
 * @returns {{ pointer: { seg, off }, pixels: Uint8Array }} pixels is a view into guest RAM
 */
export function backBuffer(mem) {
  const H = mem.heap(), B = mem.memBase;
  const u16 = (lin) => H[B + lin] | (H[B + lin + 1] << 8);
  const r = u16((mem.SS << 4) + 0xf4);
  const off = u16((r << 4) + 0x1c), seg = u16((r << 4) + 0x1e);
  const lin = seg << 4;
  return { pointer: { seg, off }, pixels: H.subarray(B + lin, B + lin + 64000) };
}

/**
 * A marker colour for the current palette: from the circuit's grass and road
 * shades (10h-1Fh, used only by the 3D view), the first whose RGB no other
 * palette entry has, preferring 17h. Measured at Monza: none of 10h-1Fh
 * appears in the cockpit, dash or bars (probes/p3-overlay.mjs).
 * @param {Uint8Array|number[]} rgb  palette, 768 bytes 0-255
 */
export function chooseMarker(rgb) {
  const key = (i) => (rgb[i * 3] << 16) | (rgb[i * 3 + 1] << 8) | rgb[i * 3 + 2];
  const count = new Map();
  for (let i = 0; i < 256; i++) count.set(key(i), (count.get(key(i)) || 0) + 1);
  const order = [0x17, ...Array.from({ length: 16 }, (_, j) => 0x10 + j).filter((i) => i !== 0x17)];
  return order.find((i) => count.get(key(i)) === 1) ?? 0x17;
}

/**
 * The marker's colour as the game's frame shows it, and the screen's
 * brightness. The game fades its palette in and out (race start, leaving the
 * circuit) in the VGA DAC, so the marker's displayed colour then differs from
 * the palette in memory. Most of the 3D view is the marker, so in a sample of
 * the view's rows the colour that covers at least half is the marker as
 * shown; its brightness against the palette's is the fade.
 * @param {Uint8Array|Uint8ClampedArray} src  the emulator's frame, RGB or RGBA, 320x200
 * @param {number[]} markerRgb  the marker in the palette, [r, g, b]
 * @param {{ top, rows }} view
 * @returns {{ rgb: number[], brightness: number }}
 */
export function shownMarker(src, markerRgb, view) {
  const step = src.length >= 64000 * 4 ? 4 : 3;
  const counts = new Map();
  let n = 0;
  for (let y = view.top + 2; y < view.top + view.rows - 2; y += 6) {
    for (let x = 3; x < 320; x += 8) {
      const j = (y * 320 + x) * step, v = (src[j] << 16) | (src[j + 1] << 8) | src[j + 2];
      counts.set(v, (counts.get(v) || 0) + 1);
      n++;
    }
  }
  const mk = (markerRgb[0] << 16) | (markerRgb[1] << 8) | markerRgb[2];
  if ((counts.get(mk) || 0) * 5 >= n) return { rgb: markerRgb, brightness: 1 };
  let best = 0, bv = 0;
  for (const [v, c] of counts) if (c > best) { best = c; bv = v; }
  if (best * 2 < n) return { rgb: markerRgb, brightness: 1 };
  const rgb = [bv >> 16, (bv >> 8) & 0xff, bv & 0xff];
  return { rgb, brightness: Math.min(1, Math.max(...rgb) / Math.max(1, ...markerRgb)) };
}

/**
 * The game's screen as an overlay: RGBA with alpha 0 where the marker's RGB
 * shows (our 3D view), and, in the outside views, in the game's black bars
 * outside the 3D view's rows: black from either screen edge up to the first
 * other colour, so a message box over a bar (the "Viewing" banner) keeps its
 * black inside. In the cockpit, also the black corners of the mirror
 * backdrop (19ED:3AFA copies 48 by 22 pixels, black beside each mirror's
 * rounded end): the game draws it before the 3D view, which covers them,
 * and the fill after; black there that touches the marker is our 3D view.
 * With view.glass (cars.mjs mirrorClip) the mirrors' glass is see-through
 * too, for real rear views drawn under it (gl-track.mjs drawMirrors).
 * @param {Uint8Array|Uint8ClampedArray} src  the emulator's frame, RGB or RGBA, 320x200
 * @param {Uint8ClampedArray} dst             RGBA, 320x200
 * @param {number[]} markerRgb                [r, g, b]
 * @param {{ top, rows, cockpit, glass? }} view
 */
export function keyFrame(src, dst, markerRgb, view) {
  const n = 320 * 200, step = src.length >= n * 4 ? 4 : 3;
  const [kr, kg, kb] = markerRgb;
  for (let i = 0, j = 0, d = 0; i < n; i++, j += step, d += 4) {
    const r = src[j], g = src[j + 1], b = src[j + 2];
    dst[d] = r; dst[d + 1] = g; dst[d + 2] = b;
    dst[d + 3] = r === kr && g === kg && b === kb ? 0 : 255;
  }
  const black = (d) => (dst[d] | dst[d + 1] | dst[d + 2]) === 0;
  if (view.cockpit) {
    // the mirror backdrop's rectangles: rows 116-137, columns 0-47 and 272-319
    const inBackdrop = (x, y) => y >= 116 && y < 138 && (x < 48 || x >= 272);
    const queue = [];
    for (let y = 116; y < 138; y++) {
      for (const x0 of [0, 272]) {
        for (let x = x0; x < x0 + 48; x++) {
          const d = (y * 320 + x) * 4;
          if (dst[d + 3] === 0 || !black(d)) continue;
          const nb = [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]];
          if (nb.some(([u, v]) => u >= 0 && u < 320 && v >= 0 && v < 200 && dst[(v * 320 + u) * 4 + 3] === 0)) queue.push(x, y);
        }
      }
    }
    while (queue.length) {
      const y = queue.pop(), x = queue.pop(), d = (y * 320 + x) * 4;
      if (dst[d + 3] === 0) continue;
      dst[d + 3] = 0;
      for (const [u, v] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]) {
        const e = (v * 320 + u) * 4;
        if (inBackdrop(u, v) && dst[e + 3] !== 0 && black(e)) queue.push(u, v);
      }
    }
    // real rear views: the mirrors' glass is ours too (after the fill, so the black
    // round the glass stays the housing's)
    if (view.glass) {
      for (const r of view.glass) {
        if (!r.active) continue;
        const row = r.row * 320;
        for (const [a, b] of [[r.left, r.gapLeft], [r.gapRight, r.right]]) {
          for (let x = Math.max(0, a); x < Math.min(320, b); x++) dst[(row + x) * 4 + 3] = 0;
        }
      }
    }
    return;
  }
  for (let y = 0; y < 200; y++) {
    if (y >= view.top && y < view.top + view.rows) continue;
    const row = y * 320 * 4;
    let x = 0;
    for (; x < 320 && black(row + x * 4); x++) dst[row + x * 4 + 3] = 0;
    for (let e = 319; e > x && black(row + e * 4); e--) dst[row + e * 4 + 3] = 0;
  }
}

/**
 * The cars in the cockpit mirrors, as the game's car step draws them
 * (renderer-notes, "Cockpit and mirrors"): each car's far bitmap at 4x its
 * depth, anchored at row 123, hazed by that depth, clipped to the mirror
 * glass (mirrorClip), far cars first. The backdrop under them is the game's
 * (the routine restores it).
 * @param {Uint8ClampedArray} dst  RGBA, 320x200 (keyFrame's output)
 * @param {object[]} mirrors       frameCars().mirrors
 * @param {object} cars            readCars(mem)
 * @param {Uint8Array|number[]} rgb  palette, 768 bytes 0-255
 * @param {object[]} [clip]        mirrorClip(cars)
 */
export function paintMirrors(dst, mirrors, cars, rgb, clip = mirrorClip(cars)) {
  const order = [...mirrors].sort((a, b) => b.depth8 - a.depth8);
  for (const m of order) {
    const spr = cars.sprite(m.id);
    if (!spr) continue;
    const lvl = hazeLevel(m.depth8);
    const colourOf = (k) => {
      const c = cars.palettes[(m.palette + k) & 0xffff];
      return lvl > 0 && cars.haze ? cars.haze[(lvl - 1) * 256 + c] : c;
    };
    drawSprite(cars, spr, m.id, m.x, m.row, m.depth8, m.mirrored, colourOf, (x, y, c) => {
      const cl = clip[y - 116];
      if (!cl || !cl.active || x < cl.left || x >= cl.right || (x >= cl.gapLeft && x < cl.gapRight)) return;
      const d = (y * 320 + x) * 4;
      dst[d] = rgb[c * 3]; dst[d + 1] = rgb[c * 3 + 1]; dst[d + 2] = rgb[c * 3 + 2]; dst[d + 3] = 255;
    }, 138);
  }
}
