// Render the track from a captured frame's camera with lib/soft-render.mjs and
// compare with the game's frame.
//
//   node probes/p2-compare.mjs out/p2-proto/chase [--track ../original/f1ct12.dat]
//
// Writes <base>-ours.png (our classes), <base>-blend.png (ours over the game's
// frame) and prints the game colours found inside each of our classes.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { parseTrack, compileTrack } from '../lib/track-file.mjs';
import { fromCompiled, fromMemory, buildMesh } from '../lib/track-mesh.mjs';
import { cameraFromState, render, CLASS } from '../lib/soft-render.mjs';
import { decodePng } from '../lib/png.mjs';

const require = createRequire(import.meta.url);
const { encodePng } = require('../lib/node-emu.cjs');


const PALETTE = { 1: [120, 170, 255], 2: [40, 140, 40], 3: [90, 90, 100], 4: [200, 200, 60], 5: [230, 30, 30], 6: [255, 255, 255] };

const args = process.argv.slice(2);
const base = args[0];
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const { state, track: mtrack } = JSON.parse(fs.readFileSync(`${base}.json`, 'utf8'));
const game = decodePng(fs.readFileSync(`${base}.png`));

let segs, parsed = null;
const trackPath = opt('track', path.join(import.meta.dirname, '..', '..', 'original', `f1ct${String(state.session.circuit + 1).padStart(2, '0')}.dat`));
if (fs.existsSync(trackPath)) {
  parsed = parseTrack(new Uint8Array(fs.readFileSync(trackPath)));
  segs = fromCompiled(compileTrack(parsed).segs);
} else {
  segs = fromMemory(mtrack.lap);
}
const polys = buildMesh(segs, { track: parsed });
const cam = cameraFromState(state);
const cls = render(polys, cam);

const ours = new Uint8Array(320 * 200 * 4), blend = new Uint8Array(game.data);
const hist = {};
for (let i = 0; i < 320 * 200; i++) {
  const c = cls[i];
  const col = PALETTE[c] || [0, 0, 0];
  ours.set([...col, 255], i * 4);
  if (c) {
    for (let k = 0; k < 3; k++) blend[i * 4 + k] = (game.data[i * 4 + k] + col[k]) >> 1;
    const key = `${game.data[i * 4]},${game.data[i * 4 + 1]},${game.data[i * 4 + 2]}`;
    (hist[c] ||= {})[key] = (hist[c][key] || 0) + 1;
  }
}
fs.writeFileSync(`${base}-ours.png`, encodePng(320, 200, ours, 4));
fs.writeFileSync(`${base}-blend.png`, encodePng(320, 200, blend, 4));
const name = Object.fromEntries(Object.entries(CLASS).map(([k, v]) => [v, k]));
for (const [c, h] of Object.entries(hist)) {
  const tot = Object.values(h).reduce((a, b) => a + b, 0);
  const top = Object.entries(h).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, n]) => `${k}:${(100 * n / tot).toFixed(1)}%`);
  console.log(`${name[c]} (${tot} px): ${top.join('  ')}`);
}
