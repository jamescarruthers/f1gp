// Our WebGL view drawn from RAM captures (no emulator), beside the game's
// frame of the same moment, for checking track details such as markings:
// probes/gl-ram.html in headless Chromium.
//
//   node probes/p4-gl-ram.mjs [--style classic|modern] [--texture off|classic|smooth] [--size 640] [--out tag] capture.ram ...
//
// Each capture needs its screenshot beside it (same name, .png). Output:
// out/p4-gl-ram/<tag>/<name>.png (the game's frame left, ours right).

import fs from 'node:fs';
import path from 'node:path';
import { startServer } from '../serve.mjs';
import { chromium } from 'playwright-core';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); if (i < 0) return d; const v = args[i + 1]; args.splice(i, 2); return v; };
const style = opt('style', 'classic'), texture = opt('texture', 'off'), size = +opt('size', 640), tag = opt('out', 'run');
const root = path.join(import.meta.dirname, '..');
const OUT = path.join(root, 'out', 'p4-gl-ram', tag);
fs.mkdirSync(OUT, { recursive: true });
const { server, url } = await startServer({ port: 0, root, quiet: true });
const browser = await chromium.launch({ args: ['--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: size * 2, height: Math.round(size * 0.75) } });
page.on('pageerror', (e) => console.log('page error', String(e)));
for (const ram of args) {
  const rel = (p) => path.relative(root, path.resolve(p)).split(path.sep).join('/');
  const png = ram.replace(/\.(ram|bin)$/, '.png');
  const q = new URLSearchParams({ ram: `/${rel(ram)}`, png: fs.existsSync(png) ? `/${rel(png)}` : '', style, texture, size: String(size) });
  await page.goto(`${url}probes/gl-ram.html?${q}`);
  await page.waitForFunction(() => window.glRam !== null, null, { timeout: 30000 });
  const r = await page.evaluate(() => window.glRam);
  const name = path.basename(ram).replace(/\.(ram|bin)$/, '');
  await page.screenshot({ path: path.join(OUT, `${name}.png`) });
  console.log(name, JSON.stringify(r));
}
await browser.close();
server.close();
