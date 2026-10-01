// Stack chosen comparison sheets of probes/p3-cars-check.mjs (game | ours |
// diff | car mask) into one PNG, 2x enlarged.
//   node probes/p3-cars-showcase.mjs OUT.png sheet.png [sheet.png ...]
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { decodePng } from '../lib/png.mjs';
const require = createRequire(import.meta.url);
const { encodePng } = require('../lib/node-emu.cjs');
const [outFile, ...files] = process.argv.slice(2);
const sheets = files.map((f) => decodePng(fs.readFileSync(f)));
const F = 2, W = 1280 * F, H = sheets.length * 200 * F;
const out = new Uint8Array(W * H * 4);
sheets.forEach((s, k) => {
  for (let y = 0; y < 200 * F; y++) for (let x = 0; x < W; x++) {
    const o = ((Math.floor(y / F)) * s.width + Math.floor(x / F)) * 4;
    out.set(s.data.subarray(o, o + 4), ((k * 200 * F + y) * W + x) * 4);
  }
});
fs.writeFileSync(outFile, encodePng(W, H, out, 4));
console.log(outFile, W, H);
