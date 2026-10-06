// bench.html in headless Chromium: the page's whole run (DOSBox, then our PC, through the same
// Quick Race), to check the page works and to get its numbers here. Headless Chromium draws with
// SwiftShader on the CPU, which takes most of the host at large sizes: open bench.html in a
// browser on real hardware for numbers worth comparing (the site has it: bench.html).
//
//   timeout 900 node probes/p6-bench-browser.mjs [--seconds 10] [--size 960x600] [--first dosbox|rust]
//
// Output: out/p6-bench/browser.json (the page's results), browser.png (the page) and its table.

import fs from 'node:fs';
import path from 'node:path';
import { launch } from '../lib/browser-emu.mjs';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const SECONDS = opt('seconds', '10'), SIZE = opt('size', '960x600'), FIRST = opt('first', 'dosbox');
const OUT = path.join(import.meta.dirname, '..', 'out', 'p6-bench');
fs.mkdirSync(OUT, { recursive: true });

const emu = await launch({ page: 'bench.html', query: { auto: 1, seconds: SECONDS, size: SIZE, first: FIRST }, viewport: { width: 1400, height: 1000 },
  chromiumArgs: ['--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--enable-gpu-compositing'] });
const page = emu.page;
let last = '';
const t0 = Date.now();
while (!(await page.evaluate(() => window.benchDone === true))) {
  const s = await page.evaluate(() => document.getElementById('status').textContent);
  if (s !== last) { console.log(`  [${((Date.now() - t0) / 1000).toFixed(0)} s] ${s}`); last = s; }
  await new Promise((r) => setTimeout(r, 1000));
}
const res = await page.evaluate(() => window.bench);
await page.screenshot({ path: path.join(OUT, 'browser.png'), fullPage: true });
const table = await page.evaluate(() => [...document.querySelectorAll('#results tbody tr')].map((tr) => [...tr.cells].map((c) => c.textContent).join(' | ')).join('\n'));
await emu.close();
fs.writeFileSync(path.join(OUT, 'browser.json'), JSON.stringify(res, null, 1));
console.log(table);
if (res.error) console.log(res.error);
console.log(res.done ? 'ok' : 'FAILED');
process.exit(res.done ? 0 : 1);
