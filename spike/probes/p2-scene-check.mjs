// Check lib/scene.mjs against the game: for RAM captures paired with the
// game's screenshot (taken while paused), rebuild the scene and the camera
// from the RAM, draw it at 320x200 with the game's projection and colours,
// and compare pixel colours.
//
//   node probes/p2-scene-check.mjs out/research-phase2/static/cap/s1 [name ...]
//
// Writes <dir>/<name>-scene.png: the game's frame, ours, and the pixels that differ.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fromRam } from '../lib/f1gp-mem.mjs';
import { createReader } from '../lib/f1gp-state.mjs';
import { readScene, buildSceneMesh, horizonOff } from '../lib/scene.mjs';
import { cameraFromState, renderMesh } from '../lib/soft-render.mjs';
import { decodePng } from '../lib/png.mjs';

const require = createRequire(import.meta.url);
const { encodePng } = require('../lib/node-emu.cjs');

const dir = process.argv[2];
const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
const names = process.argv.slice(3).length ? process.argv.slice(3) : fs.readdirSync(dir).filter((f) => f.endsWith('.ram')).map((f) => f.slice(0, -4));
const results = [];
for (const name of names) {
  const ram = new Uint8Array(fs.readFileSync(path.join(dir, `${name}.ram`)));
  const game = decodePng(fs.readFileSync(path.join(dir, `${name}.png`)));
  const mem = fromRam(ram, { imageSeg: meta.imageSeg });
  const st = createReader(mem).read();
  const cam = cameraFromState(st);
  const scene = readScene(mem);
  const mesh = buildSceneMesh(scene);
  const pal = scene.palette;
  const rgb = (i) => [pal[i * 3], pal[i * 3 + 1], pal[i * 3 + 2]];
  // background: sky table upward from the horizon (or 8 rows above it when
  // the horizon image is drawn), the horizon image, the grass below
  const noImage = horizonOff(mem);
  const skySteps = [];
  for (const e of scene.tables.sky) { for (let r = 0; r < Math.min(e.rows, 200); r++) skySteps.push(e.colour); skySteps.push(e.colour); }
  const yawCol = st.camera.heading >> 5;
  const background = (x, y) => {
    const above = cam.top + cam.horizon - y; // rows above the horizon row (1 = the row just above)
    if (above <= 0) return rgb(scene.grass);
    if (!noImage && above <= 8) return rgb(scene.horizon[(8 - above) * 512 + ((yawCol + x) & 511)]);
    const r = above - (noImage ? 1 : 9);
    return rgb(skySteps[Math.min(r, skySteps.length - 1)]);
  };
  const ours = renderMesh(mesh.data, mesh.origin, cam, { background });
  // compare inside the 3D viewport, only where we drew track geometry
  let drawn = 0, same = 0, bg = 0, bgSame = 0;
  const diff = new Uint8Array(320 * 200 * 4);
  for (let y = cam.top; y < cam.top + cam.rows; y++) for (let x = 0; x < 320; x++) {
    const o = (y * 320 + x) * 4;
    const eq = ours[o] === game.data[o] && ours[o + 1] === game.data[o + 1] && ours[o + 2] === game.data[o + 2];
    if (ours[o + 3] === 255) { drawn++; if (eq) same++; } else { bg++; if (eq) bgSame++; }
    const v = eq ? 0 : 255;
    diff.set([v, ours[o + 3] === 255 ? v : v >> 1, 0, 255], o);
  }
  const sheet = new Uint8Array(960 * 200 * 4);
  for (let y = 0; y < 200; y++) {
    sheet.set(game.data.subarray(y * 1280, (y + 1) * 1280), y * 3840);
    const row = ours.slice(y * 1280, (y + 1) * 1280);
    for (let x = 0; x < 320; x++) row[x * 4 + 3] = 255;
    sheet.set(row, y * 3840 + 1280);
    sheet.set(diff.subarray(y * 1280, (y + 1) * 1280), y * 3840 + 2560);
  }
  fs.writeFileSync(path.join(dir, `${name}-scene.png`), encodePng(960, 200, sheet, 4));
  const r = { name, view: st.view.mode, counts: mesh.counts, trackPixels: drawn, trackSamePct: +(100 * same / Math.max(drawn, 1)).toFixed(1), backgroundSamePct: +(100 * bgSame / Math.max(bg, 1)).toFixed(1) };
  results.push(r);
  console.log(JSON.stringify(r));
}
