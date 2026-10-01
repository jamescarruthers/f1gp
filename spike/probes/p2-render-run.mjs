// Run render.html in headless Chromium: reach a Quick Race with the route,
// let the autopilot drive, and take page screenshots in several views.
//
//   node build-bundle.mjs --autoexec "gp /g" --cycles 25000 --out dist/p2-render-25000.jsdos
//   timeout 240 node probes/p2-render-run.mjs [--tag run1] [--framing wide|original]
//
// Output: out/p2-render/<tag>/{page-*.png, fb-*.png, summary.json}

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { launch } from '../lib/browser-emu.mjs';
import { installAutopilot } from './p1-map-lib.mjs';

const require = createRequire(import.meta.url);
const route = require('../lib/route.cjs');
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const TAG = opt('tag', 'run');
const OUT = path.join(import.meta.dirname, '..', 'out', 'p2-render', TAG);
fs.mkdirSync(OUT, { recursive: true });
const T0 = Date.now();
const log = (...a) => console.log(`${((Date.now() - T0) / 1000).toFixed(1)}s`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const KEYS = { left: 263, right: 262, pagedown: 267, delete: 261, up: 265, home: 268 };
let emu;
const summary = { tag: TAG, shots: [] };
try {
  emu = await launch({
    bundle: opt('bundle', 'dist/p2-render-25000.jsdos'), page: 'render.html', input: 'real',
    viewport: { width: 1600, height: 900 }, query: { framing: opt('framing', 'wide'), smooth: opt('smooth', '1'), layout: opt('layout', 'side') }, log,
  });
  const { page, driver } = emu;
  await route.toTrack(driver, { mode: 'quickrace', log });
  summary.autopilot = await page.evaluate(installAutopilot);
  const tap = (code) => page.evaluate(async (c) => { window.ci.sendKeyEvent(c, true); await new Promise((r) => setTimeout(r, 120)); window.ci.sendKeyEvent(c, false); }, code);
  const plan = [
    { at: 6, view: 'cockpit' }, { at: 14, key: KEYS.pagedown, view: 'chase' }, { at: 22, view: 'chase' },
    { at: 30, key: KEYS.left, view: 'tv' }, { at: 38, view: 'tv' }, { at: 46, key: KEYS.delete, view: 'reverse' },
    { at: 54, key: KEYS.right, view: 'cockpit' }, { at: 62, view: 'cockpit' },
  ];
  const t0 = Date.now();
  for (const step of plan) {
    while ((Date.now() - t0) / 1000 < step.at) await sleep(200);
    if (step.key) { await tap(step.key); await sleep(1500); }
    const name = `${String(step.at).padStart(2, '0')}-${step.view}`;
    await driver.pageShot(path.join(OUT, `page-${name}.png`));
    await driver.shot(path.join(OUT, `fb-${name}.png`));
    const info = await page.evaluate(() => ({ perf: window.renderApp.perf, track: window.renderApp.track, view: window.renderApp.state?.view, frame: window.renderApp.state?.frame }));
    summary.shots.push({ name, ...info });
    log(name, JSON.stringify(info));
  }
  summary.events = await page.evaluate(() => window.emuEvents);
} catch (e) {
  summary.error = String(e?.stack ?? e);
  log('error', summary.error);
  if (emu) await emu.driver.pageShot(path.join(OUT, 'page-failed.png')).catch(() => {});
} finally {
  fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(summary, null, 1));
  if (emu) await emu.close();
}
