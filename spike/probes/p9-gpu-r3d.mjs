// The WebGPU rasteriser (lib/gpu-r3d.mjs) held to its reference: the primitives `r3d list`
// saved from caught frames, painted in headless Chromium (probes/gpu-r3d.html), must give what
// machine/src/r3d/fine.rs drew, byte for byte, at every scale. At scale 1 that is the frame our
// port of the game's 3D routine drew, which is the game's own.
//
//   (cd machine && cargo build --release) && machine/target/release/r3d list out/r3d/monza 1,2,4 20
//   node probes/p9-gpu-r3d.mjs [--dir out/r3d/monza/gpu] [--frames all|0000,0010] [--scales 1,2,4]
//
// WebGPU compute needs only --enable-unsafe-webgpu headless (SwiftShader's adapter here).

import fs from 'node:fs';
import path from 'node:path';
import { startServer } from '../serve.mjs';
import { chromium } from 'playwright-core';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const root = path.join(import.meta.dirname, '..');
const dir = opt('dir', 'out/r3d/monza/gpu'), scales = opt('scales', '1,2,4');
let frames = opt('frames', 'all');
if (frames === 'all') {
  frames = [...new Set(fs.readdirSync(path.join(root, dir)).filter((f) => f.endsWith('.prims')).map((f) => f.split('-')[0]))].sort().join(',');
}
const { server, url } = await startServer({ port: 0, root, quiet: true });
const browser = await chromium.launch({ args: ['--enable-unsafe-webgpu'] });
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('page error', String(e)));
page.on('console', (m) => { if (m.type() === 'error') console.log('console', m.text()); });
const q = new URLSearchParams({ dir, frames, scales });
await page.goto(`${url}probes/gpu-r3d.html?${q}`);
await page.waitForFunction(() => window.gpuR3d !== null, null, { timeout: 0 });
const r = await page.evaluate(() => window.gpuR3d);
await browser.close();
server.close();
if (r.error) {
  console.log(r.error);
  process.exit(1);
}
const bad = r.results.filter((x) => x.differ);
for (const x of bad.slice(0, 10)) console.log(`${x.frame} at scale ${x.s}: ${x.differ} bytes differ, the first at ${x.first}`);
const by = (s) => r.results.filter((x) => x.s === s);
for (const s of scales.split(',').map(Number)) {
  const v = by(s), ms = v.map((x) => x.ms).sort((a, b) => a - b);
  console.log(`scale ${s}: ${v.filter((x) => !x.differ).length} of ${v.length} frames the same as fine.rs; ${Math.round(v.reduce((a, x) => a + x.prims, 0) / v.length)} primitives a frame; median ${ms[ms.length >> 1]} ms a frame`);
}
process.exit(r.ok ? 0 : 1);
