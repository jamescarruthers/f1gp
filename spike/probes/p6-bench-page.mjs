// render.html on DOSBox (js-dos) against the Rust PC (machine=rust), in headless Chromium,
// the autopilot driving a Monza Quick Race with the page's default options: the main
// thread's busy time (where the emulator and the page both run), the CPU of the renderer
// and GPU processes, the game's speed against real time, the page's frame rate and frame
// intervals, the cycles the page's governor chose, and (our PC) the real time it could not
// keep up with. Headless Chromium draws with SwiftShader, on the CPU: at large sizes its GPU
// process takes most of the host and the page's frame rate falls; the emulator runs on its
// own clock (DOSBox and lib/pc.mjs alike), so the game's speed should not.
//
//   timeout 400 node probes/p6-bench-page.mjs [--machine dosbox|rust] [--seconds 20] [--size 1280x720] [--query '{"screen":"original"}']
//
// Output: out/p6-bench/page-<machine>-<size>[-<query tag>].json and a summary line.

import fs from 'node:fs';
import path from 'node:path';
import { launch } from '../lib/browser-emu.mjs';
import { route, sleep } from './browser-probe-lib.mjs';
import { installAutopilot } from './p1-map-lib.mjs';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const MACHINE = opt('machine', 'dosbox'), SECONDS = +opt('seconds', 20);
const [W, H] = opt('size', '1280x720').split('x').map(Number);
const extra = JSON.parse(opt('query', '{}'));

const emu = await launch({ bundle: 'dist/f1gp.jsdos', page: 'render.html', query: { machine: MACHINE, ...extra }, viewport: { width: W, height: H },
  chromiumArgs: ['--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--enable-gpu-compositing'] });
const page = emu.page;
const t0 = Date.now();
await route.toTrack(emu.driver, { mode: 'quickrace', log: () => {} });
const routeS = (Date.now() - t0) / 1000;
await page.evaluate(installAutopilot, { pollMs: 8 });
await sleep(5000);

const cdp = await page.context().newCDPSession(page);
await cdp.send('Performance.enable');
const bcdp = await emu.browser.newBrowserCDPSession();
const procs = async () => {
  const { processInfo } = await bcdp.send('SystemInfo.getProcessInfo');
  const by = {};
  for (const p of processInfo) by[p.type] = (by[p.type] ?? 0) + p.cpuTime;
  return by;
};
const metrics = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));

// frame intervals, as the display sees them
await page.evaluate(() => {
  const rec = window.__dt = []; let last = null;
  const tick = (t) => { if (last !== null) rec.push(t - last); last = t; if (window.__rec) requestAnimationFrame(tick); };
  window.__rec = true; requestAnimationFrame(tick);
});
const game = () => page.evaluate(() => window.renderApp.reader.read().sessionMs);
const lost = () => page.evaluate(() => window.emuCi.dropped ?? null);
const m0 = await metrics(), p0 = await procs(), g0 = await game(), d0 = await lost(), w0 = Date.now();
const perfs = [];
for (let s = 0; s < SECONDS; s++) { await sleep(1000); perfs.push(await page.evaluate(() => window.renderApp.perf)); }
const m1 = await metrics(), p1 = await procs(), g1 = await game(), d1 = await lost(), wall = (Date.now() - w0) / 1000;
const dts = await page.evaluate(() => { window.__rec = false; return window.__dt; });
await emu.close();

const sorted = [...dts].sort((a, b) => a - b), at = (p) => +sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))].toFixed(1);
const med = (k) => { const v = perfs.map((p) => p?.[k]).filter((x) => x != null).sort((a, b) => a - b); return v.length ? v[Math.floor(v.length / 2)] : null; };
const r = {
  machine: MACHINE, size: [W, H], routeS: +routeS.toFixed(1), wallS: +wall.toFixed(1),
  gameSpeed: +((g1 - g0) / 1000 / wall).toFixed(3),
  droppedMs: d0 === null ? null : Math.round(d1 - d0), // our PC: real time it could not keep up with
  mainThreadBusyPct: +((100 * (m1.TaskDuration - m0.TaskDuration)) / wall).toFixed(1),
  scriptPct: +((100 * (m1.ScriptDuration - m0.ScriptDuration)) / wall).toFixed(1),
  cpuPct: Object.fromEntries(Object.keys(p1).map((k) => [k, +((100 * (p1[k] - (p0[k] ?? 0))) / wall).toFixed(1)])),
  frames: dts.length, pageFps: +(dts.length / wall).toFixed(1),
  interval: { median: at(0.5), p90: at(0.9), p99: at(0.99), max: at(1) },
  over50ms: dts.filter((d) => d > 50).length,
  gameFps: med('gameFps'), cycles: [...new Set(perfs.map((p) => p?.cycles))],
  pageWork: { median: med('jsMs'), p90: med('jsP90'), max: med('jsMax') },
};
console.log(JSON.stringify(r));
const OUT = path.join(import.meta.dirname, '..', 'out', 'p6-bench');
fs.mkdirSync(OUT, { recursive: true });
const tag = Object.entries(extra).map(([k, v]) => `-${k}-${v}`).join('');
fs.writeFileSync(path.join(OUT, `page-${MACHINE}-${W}x${H}${tag}.json`), JSON.stringify({ ...r, perfs, dts }, null, 1));
process.exit(0);
