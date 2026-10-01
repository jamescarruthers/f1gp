// The page's Amiga sound (render.html?sound=amiga) in headless Chromium:
// boot the game, check the title tune plays in the menus, start a Monza
// Quick Race, check the tune fades, the race driver's hook goes in and the
// engine and effects play, switch to the TV view for the passing sounds,
// leave the race (Esc) for the menus and the tune again, then switch the
// page back to the AdLib sound.
//
//   node lib/amiga-disk.mjs                      (dist/amiga-sound.bin)
//   timeout 400 node probes/p5-amiga-browser.mjs [--bundle dist/f1gp.jsdos] [--drive 20] [--tv 15]
//
// Output, out/sound/p5-amiga-browser/: samples.jsonl (every 500 ms: where the
// sound is, the output level, the effect counts), summary.json, *.png.

import fs from 'node:fs';
import path from 'node:path';
import { launch } from '../lib/browser-emu.mjs';
import { route, sleep } from './browser-probe-lib.mjs';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const BUNDLE = opt('bundle', 'dist/f1gp.jsdos');
const DRIVE = +opt('drive', 20), TV = +opt('tv', 15);
const OUT = path.join(import.meta.dirname, '..', 'out', 'sound', 'p5-amiga-browser');
fs.mkdirSync(OUT, { recursive: true });
const T0 = Date.now();
const log = (...m) => console.log(`[${((Date.now() - T0) / 1000).toFixed(1)}] ${m.join(' ')}`);
const samplesFile = fs.openSync(path.join(OUT, 'samples.jsonl'), 'w');

const emu = await launch({
  bundle: BUNDLE, page: 'render.html', query: { sound: 'amiga' }, log,
  chromiumArgs: ['--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--enable-gpu-compositing'],
});
const d = emu.driver, page = emu.page;
let phase = 'boot';
const summary = { phases: {}, errors: [] };
const sample = async () => page.evaluate(() => {
  const a = window.renderApp?.amiga;
  if (!a) return { loaded: false };
  return { loaded: true, place: a.place, tune: a.tune, level: +a.level().toFixed(4), ctx: a.ctx.state, worklet: a.worklet, starts: a.events.starts.slice(0, 10), stops: a.events.stops.slice(0, 10), sound: window.renderApp.opts.sound };
});
let sampling = true;
const sampler = (async () => {
  while (sampling) {
    try {
      const s = await sample();
      fs.writeSync(samplesFile, JSON.stringify({ t: +((Date.now() - T0) / 1000).toFixed(1), phase, ...s }) + '\n');
      const p = (summary.phases[phase] ??= { n: 0, places: {}, maxLevel: 0, sumLevel: 0 });
      p.n++; p.places[s.place] = (p.places[s.place] ?? 0) + 1;
      if (s.loaded) { p.maxLevel = Math.max(p.maxLevel, s.level); p.sumLevel += s.level; p.last = s; }
    } catch (e) { summary.errors.push(String(e)); }
    await sleep(500);
  }
})();
try {
  await route.toMainMenu(d, { log: () => {} });
  phase = 'menus';
  log('main menu');
  await sleep(8000);
  await d.shot(path.join(OUT, 'menus.png'));
  phase = 'loading';
  await route.toTrack(d, { mode: 'quickrace', log: () => {}, onScreen: async (s) => { phase = s === 'green' ? 'grid' : s === 'race' ? 'grid' : 'loading'; } });
  phase = 'driving';
  log('green');
  const code = (k) => route.JSDOS_KEYS[k];
  await page.evaluate((c) => window.emuCi.sendKeyEvent(c, true), code('a'));
  await sleep(DRIVE * 1000);
  await page.evaluate((c) => window.emuCi.sendKeyEvent(c, false), code('a'));
  await d.shot(path.join(OUT, 'driving.png'));
  phase = 'tv';
  await d.press('left', 100);
  await sleep(TV * 1000);
  // back to the menus (Esc), where the tune plays again
  phase = 'left';
  await d.press('esc', 120);
  await sleep(10000);
  phase = 'adlib';
  await page.evaluate(() => { const s = document.getElementById('sound'); s.value = 'adlib'; s.dispatchEvent(new Event('change')); });
  await sleep(4000);
} catch (e) {
  summary.errors.push(String(e?.stack ?? e));
  log('error', e?.stack ?? e);
} finally {
  sampling = false;
  await sampler;
  for (const p of Object.values(summary.phases)) { p.meanLevel = +(p.sumLevel / Math.max(1, p.n)).toFixed(4); delete p.sumLevel; }
  summary.pageErrors = emu.pageErrors;
  summary.events = await page.evaluate(() => window.emuEvents.filter((e) => /amiga|error/.test(e.type))).catch(() => []);
  fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(summary, null, 1));
  log('summary', JSON.stringify({ phases: Object.fromEntries(Object.entries(summary.phases).map(([k, v]) => [k, { places: v.places, max: v.maxLevel, mean: v.meanLevel, starts: v.last?.starts }])), errors: summary.errors.length, pageErrors: emu.pageErrors.length }));
  await emu.close();
  process.exit(0);
}
