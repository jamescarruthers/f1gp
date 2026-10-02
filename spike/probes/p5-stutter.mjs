// Frame times in a race: render.html in headless Chromium, the autopilot driving a Monza Quick Race,
// for --seconds: each page frame's interval and the time the page's animation-frame work took in it
// (every requestAnimationFrame callback timed, from a script run before the page's own; the page
// shares the main thread with the emulator, so this is time the emulator waits), with the frames
// that drew part of the shadow map marked, and how many object passes uploaded their index lists.
//
//   timeout 400 node probes/p5-stutter.mjs [--seconds 20] [--size 800x500] [--view cockpit|chase] [--query '{"shadows":"off"}'] [--tag name]
//
// Output: out/p5-stutter/<tag>.json (frames, stats) and a summary line. Headless Chromium draws with
// SwiftShader on the CPU, so the intervals are long and vary; the work times are the steadier measure.

import fs from 'node:fs';
import path from 'node:path';
import { launch } from '../lib/browser-emu.mjs';
import { route, sleep } from './browser-probe-lib.mjs';
import { installAutopilot } from './p1-map-lib.mjs';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const SECONDS = +opt('seconds', 20), [W, H] = opt('size', '800x500').split('x').map(Number), VIEW = opt('view', 'cockpit');
const QUERY = JSON.parse(opt('query', '{}')), TAG = opt('tag', 'run');
const OUT = path.join(import.meta.dirname, '..', 'out', 'p5-stutter');
fs.mkdirSync(OUT, { recursive: true });

// every animation-frame callback timed, by the frame's time stamp
function timeFrames() {
  const raf = window.requestAnimationFrame.bind(window);
  window.__work = new Map();
  window.requestAnimationFrame = (cb) => raf((t) => {
    const s = performance.now();
    try { cb(t); } finally { if (window.__recording) window.__work.set(t, (window.__work.get(t) ?? 0) + performance.now() - s); }
  });
}

const emu = await launch({ bundle: 'dist/f1gp.jsdos', page: 'render.html', query: QUERY, viewport: { width: W, height: H }, initScript: timeFrames,
  chromiumArgs: ['--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--enable-gpu-compositing'] });
const page = emu.page;
await route.toTrack(emu.driver, { mode: 'quickrace', log: () => {} });
if (VIEW === 'chase') await page.evaluate(() => { window.emuCi.sendKeyEvent(267, true); setTimeout(() => window.emuCi.sendKeyEvent(267, false), 120); });
await page.evaluate(installAutopilot, { pollMs: 8 });
await sleep(4000);
// in the page: each animation frame's time and the renderer's counters (after the page's own frame)
await page.evaluate(() => {
  const R = window.renderApp.renderer, rec = window.__frames = [];
  let last = null;
  const tick = (t) => {
    rec.push({ t, dt: last === null ? 0 : t - last, redraws: R.shadowDraws ?? 0, parts: R.shadowParts ?? 0 });
    last = t;
    if (window.__recording) requestAnimationFrame(tick);
  };
  window.__recording = true;
  requestAnimationFrame(tick);
});
await sleep(SECONDS * 1000);
const { frames, counts } = await page.evaluate(() => {
  window.__recording = false;
  const R = window.renderApp.renderer;
  return { frames: window.__frames.map((f) => ({ ...f, work: +(window.__work.get(f.t) ?? 0).toFixed(3) })),
    counts: { passes: R.objectPassCount ?? 0, uploads: R.objectUploads ?? 0 } };
});
await emu.close();

const sorted = (a) => [...a].sort((x, y) => x - y);
const at = (s, p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
const sum = (a) => { const s = sorted(a); return { median: +at(s, 0.5).toFixed(1), p90: +at(s, 0.9).toFixed(1), p99: +at(s, 0.99).toFixed(1), max: +s[s.length - 1].toFixed(1) }; };
const fs1 = frames.slice(1);
// a frame that drew any of the next shadow map (a part, or the whole map before it was spread)
const drew = fs1.filter((f, i) => f.parts !== frames[i].parts || f.redraws !== frames[i].redraws);
const rest = fs1.filter((f, i) => !(f.parts !== frames[i].parts || f.redraws !== frames[i].redraws));
const mean = (a) => (a.length ? +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(1) : null);
const stats = { frames: fs1.length, interval: sum(fs1.map((f) => f.dt)), work: sum(fs1.map((f) => f.work)),
  shadowFrames: drew.length, workShadow: mean(drew.map((f) => f.work)), workRest: mean(rest.map((f) => f.work)),
  objectPasses: counts.passes, objectUploads: counts.uploads };
fs.writeFileSync(path.join(OUT, `${TAG}.json`), JSON.stringify({ query: QUERY, view: VIEW, size: [W, H], stats, frames }, null, 1));
console.log(TAG, JSON.stringify(stats));
process.exit(0);
