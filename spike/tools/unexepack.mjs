// Unpack a Microsoft EXEPACK-compressed DOS program (gp.exe is one) so its
// code and data can be searched and disassembled.
//
//   node tools/unexepack.mjs [../original/gp.exe] [out/gp_unpacked.bin]
//
// The output is the load image: offset 0 is the first byte loaded at the
// program's start segment. It holds copyrighted code, so it goes in out/.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

const here = dirname(new URL(import.meta.url).pathname);

export function unexepack(exe) {
  const u16 = (o) => exe[o] | (exe[o + 1] << 8);
  if (u16(0) !== 0x5a4d) throw new Error("not an MZ executable");
  const lastPage = u16(2), pages = u16(4), headerParas = u16(8);
  const ip = u16(0x14), cs = u16(0x16);
  const size = (pages - 1) * 512 + (lastPage || 512);
  const image = exe.subarray(headerParas * 16, size);

  const h = cs * 16; // EXEPACK header sits at CS:0
  const hdr = {
    realIp: image[h] | (image[h + 1] << 8),
    realCs: image[h + 2] | (image[h + 3] << 8),
    realSp: image[h + 8] | (image[h + 9] << 8),
    realSs: image[h + 10] | (image[h + 11] << 8),
    destParas: image[h + 12] | (image[h + 13] << 8),
  };
  const sig = String.fromCharCode(image[h + 14], image[h + 15]);
  if (ip !== 0x10 || sig !== "RB") throw new Error("no EXEPACK header found");

  const src = image.subarray(0, h);
  const out = new Uint8Array(hdr.destParas * 16);
  out.set(src);
  let s = src.length - 1;
  while (src[s] === 0xff) s--; // padding
  let d = out.length;
  for (;;) {
    const cmd = src[s--];
    const len = (src[s] << 8) | src[s - 1];
    s -= 2;
    if ((cmd & 0xfe) === 0xb0) {
      const fill = src[s--];
      for (let k = 0; k < len; k++) out[--d] = fill;
    } else if ((cmd & 0xfe) === 0xb2) {
      for (let k = 0; k < len; k++) out[--d] = src[s--];
    } else {
      throw new Error(`bad EXEPACK command 0x${cmd.toString(16)}`);
    }
    if (cmd & 1) break;
  }
  return { image: out, header: hdr };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const input = process.argv[2] ?? join(here, "..", "..", "original", "gp.exe");
  const output = process.argv[3] ?? join(here, "..", "out", "gp_unpacked.bin");
  const { image, header } = unexepack(new Uint8Array(readFileSync(input)));
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, image);
  console.log(JSON.stringify({ output, bytes: image.length, ...header }));
}
