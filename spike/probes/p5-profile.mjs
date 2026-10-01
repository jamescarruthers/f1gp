// Where the page's time goes: render.html (default options) in headless
// Chromium during a Monza Quick Race, with the DevTools CPU profiler on the
// main thread, where js-dos direct mode runs the emulator and the page draws.
// The samples are grouped: the emulator (DOSBox, WebAssembly), js-dos's
// JavaScript, our page and modules (by function), the garbage collector,
// and idle. The page's own counters (renderApp.perf) are logged alongside.
//
//   timeout 400 node probes/p5-profile.mjs [--seconds 15] [--size 1280x720] [--view cockpit|chase|tv] [--sleep timer|spin]
//
// --sleep: the page's sleep option (render.html): the emulator waits out each
// millisecond on a timer (default) or as js-dos does, passing messages to
// itself (lib/dos-sleep.mjs). js-dos's sleep counters are logged.
//
// Output: out/p5-profile/<view>-<size>-<sleep>.json (groups, top functions, page counters)
// and .cpuprofile (load it in Chrome DevTools, Performance > Load profile).
// GL runs in the GPU process (SwiftShader, on the CPU, in this headless
// browser), which this profile does not see; the page's draw time includes
// waiting for it.

import fs from 'node:fs';
import path from 'node:path';
import { launch } from '../lib/browser-emu.mjs';
import { route, sleep } from './browser-probe-lib.mjs';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const SECONDS = +opt('seconds', 15);
const [W, H] = opt('size', '1280x720').split('x').map(Number);
const VIEW = opt('view', 'cockpit');
const SLEEP = opt('sleep', 'timer');
const NAME = `${VIEW}-${opt('size', '1280x720')}-${SLEEP}`;
const OUT = path.join(import.meta.dirname, '..', 'out', 'p5-profile');
fs.mkdirSync(OUT, { recursive: true });
const log = (...m) => console.log(m.join(' '));

const emu = await launch({
  bundle: 'dist/f1gp.jsdos', page: 'render.html', query: { sleep: SLEEP }, viewport: { width: W, height: H },
  chromiumArgs: ['--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--enable-gpu-compositing'],
});
const d = emu.driver, page = emu.page;
await route.toTrack(d, { mode: 'quickrace', log: () => {} });
const code = (k) => route.JSDOS_KEYS[k] ?? { pagedown: 267 }[k];
const press = (k) => page.evaluate((c) => { window.emuCi.sendKeyEvent(c, true); setTimeout(() => window.emuCi.sendKeyEvent(c, false), 120); }, code(k));
if (VIEW === 'chase') await press('pagedown');
if (VIEW === 'tv') await press('left');
await page.evaluate((c) => window.emuCi.sendKeyEvent(c, true), code('a'));
await sleep(3000);

const cdp = await page.context().newCDPSession(page);
await cdp.send('Profiler.enable');
await cdp.send('Profiler.setSamplingInterval', { interval: 500 });
const perf = [];
const sleeps = () => page.evaluate(() => { const m = window.emuCi.transport.module; return { sleeps: m.sleep_count, nonSkippable: m.nonskippable_sleep_count, sleepMs: m.sleep_time, timer: !!m.timerSleep, at: Date.now() }; });
const s0 = await sleeps();
await cdp.send('Profiler.start');
const t0 = Date.now();
while (Date.now() - t0 < SECONDS * 1000) {
  await sleep(1000);
  perf.push(await page.evaluate(() => ({ ...window.renderApp.perf, view: window.renderApp.state?.view?.mode })));
}
const { profile } = await cdp.send('Profiler.stop');
const s1 = await sleeps(), wall = (s1.at - s0.at) / 1000;
const sleepStats = { timer: s1.timer, perSecond: +((s1.sleeps - s0.sleeps) / wall).toFixed(0), nonSkippablePerSecond: +((s1.nonSkippable - s0.nonSkippable) / wall).toFixed(0), sleepingShare: +((s1.sleepMs - s0.sleepMs) / (wall * 1000)).toFixed(3) };
await page.evaluate((c) => window.emuCi.sendKeyEvent(c, false), code('a'));
fs.writeFileSync(path.join(OUT, `${NAME}.cpuprofile`), JSON.stringify(profile));

// self time per node, from the samples and their time deltas
const byId = new Map(profile.nodes.map((n) => [n.id, n]));
const self = new Map();
profile.samples.forEach((id, i) => self.set(id, (self.get(id) ?? 0) + (profile.timeDeltas[i] ?? 0)));
const total = [...self.values()].reduce((a, b) => a + b, 0);
const group = (n) => {
  const f = n.callFrame, url = f.url || '', name = f.functionName || '';
  if (name === '(idle)') return 'idle';
  if (name === '(garbage collector)') return 'garbage collector';
  if (name === '(program)') return 'browser (program)';
  if (/wdosbox\.wasm|wasm:\/\//.test(url) || /^\$?wasm-function|^\$/.test(name) && !url) return 'emulator (WebAssembly)';
  if (/wdosbox\.js|emulators\.js|wlibzip/.test(url)) return 'js-dos JavaScript';
  if (/render\.html|\/lib\//.test(url)) return 'our page';
  return url ? `other: ${url.split('/').pop()}` : `other: ${name || '(anonymous)'}`;
};
const groups = new Map(), ours = new Map(), top = new Map();
for (const [id, us] of self) {
  const n = byId.get(id), g = group(n);
  groups.set(g, (groups.get(g) ?? 0) + us);
  const key = `${n.callFrame.functionName || '(anonymous)'} ${(n.callFrame.url || '').split('/').pop()}:${n.callFrame.lineNumber + 1}`;
  top.set(key, (top.get(key) ?? 0) + us);
  if (g === 'our page') ours.set(key, (ours.get(key) ?? 0) + us);
}
const pct = (us) => +((100 * us) / total).toFixed(1);
const sorted = (m, k = 20) => [...m].sort((a, b) => b[1] - a[1]).slice(0, k).map(([name, us]) => ({ name, ms: Math.round(us / 1000), pct: pct(us) }));
const result = {
  view: VIEW, size: [W, H], seconds: total / 1e6, sleep: sleepStats,
  groups: sorted(groups, 30), ourFunctions: sorted(ours, 25), topFunctions: sorted(top, 25),
  page: perf,
};
fs.writeFileSync(path.join(OUT, `${NAME}.json`), JSON.stringify(result, null, 1));
log(JSON.stringify({ sleep: sleepStats }));
log(result.groups.slice(0, 12).map((g) => `${String(g.pct).padStart(5)}%  ${g.name}`).join('\n'));
log(result.ourFunctions.slice(0, 10).map((g) => `${String(g.pct).padStart(5)}%  ${g.name}`).join('\n'));
log(JSON.stringify({ page: perf.slice(-3) }));
await emu.close();
process.exit(0);
