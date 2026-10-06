// The game's saved files between visits (lib/saves.mjs, render.html saves=on):
// in headless Chromium, go to the game's Load/Save menu, save the drivers'
// names as MYTEST, wait for the page to keep it, choose the classic style,
// then open the page again (same browser profile) and check that the game
// finds GPSAVES\MYTEST and the style stays classic; then forget the files
// (the Saves panel) and check that they are gone.
//
//   timeout 400 node probes/p5-saves.mjs [--query '{"machine":"rust"}']
//
// Output: out/p5-saves/result.json and screenshots of each step.

import fs from 'node:fs';
import path from 'node:path';
import { launch } from '../lib/browser-emu.mjs';
import { route, sleep } from './browser-probe-lib.mjs';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const OUT = path.join(import.meta.dirname, '..', 'out', 'p5-saves');
fs.mkdirSync(OUT, { recursive: true });
const log = (...m) => console.log(m.join(' '));
const result = { checks: {} };
const check = (name, ok, detail) => { result.checks[name] = { ok: !!ok, detail }; log(ok ? 'ok  ' : 'FAIL', name, detail === undefined ? '' : JSON.stringify(detail)); };

const emu = await launch({ bundle: 'dist/f1gp.jsdos', page: 'render.html', query: JSON.parse(opt('query', '{}')), viewport: { width: 1100, height: 760 } });
const d = emu.driver, page = emu.page;
const shot = (name) => d.shot(path.join(OUT, `${name}.png`));
const ready = () => page.waitForFunction(() => window.emuReady === true, null, { timeout: 60000, polling: 100 });
const events = () => page.evaluate(() => window.emuEvents);
const until = async (f, ms = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await f(); if (v) return v; await sleep(250); } return null; };

try {
  // 1. save the names from the game's Load/Save menu
  await route.toMainMenu(d, { log: () => {} });
  await sleep(1000);
  const step = async (k, wait) => { await d.press(k); await sleep(wait); };
  await step('down', 400); await step('down', 400); await step('enter', 2500);   // Load/Save Game
  for (let i = 0; i < 4; i++) await step('down', 400);                          // Save Names
  await step('enter', 2500);
  await step('up', 500); await step('enter', 800);                               // the file name field
  await d.type('mytest'); await sleep(500);
  await step('enter', 1500); await step('down', 500); await step('enter', 3000); // O.K.
  await shot('1-saved');
  const kept = await until(() => page.evaluate(() => window.renderApp.saves?.files));
  const keptFiles = await until(() => page.evaluate(() => (window.renderApp.saves?.files ?? []).includes('GPSAVES/MYTEST') && window.renderApp.saves.files));
  check('kept after saving', keptFiles, keptFiles ?? kept);
  const size = await page.evaluate(async () => (await window.emuCi.fsReadFile('GPSAVES/MYTEST')).length);

  // 2. a menu choice
  await page.selectOption('#style', 'classic');
  await sleep(300);

  // 3. the page again, from its first address (no style in it)
  await page.goto(emu.url, { waitUntil: 'load' });
  await ready();
  const loaded = await until(async () => (await events()).find((e) => e.type === 'saves-loaded'), 10000);
  check('loaded on the next visit', loaded?.files?.includes('GPSAVES/MYTEST'), loaded?.files);
  const size2 = await page.evaluate(async () => { try { return (await window.emuCi.fsReadFile('GPSAVES/MYTEST')).length; } catch (e) { return String(e); } });
  check('the game finds the file', size2 === size && size > 0, { saved: size, found: size2 });
  const style = await page.evaluate(() => window.renderApp.opts.style);
  check('the style choice stays', style === 'classic', style);
  // the game lists it in its Load Names dialog
  await route.toMainMenu(d, { log: () => {} });
  await sleep(1000);
  await step('down', 400); await step('down', 400); await step('enter', 2500);
  for (let i = 0; i < 3; i++) await step('down', 400);                          // Load Names
  await step('enter', 2500);
  await shot('2-load-names');

  // 4. forget them
  await page.click('#savesbtn');
  await page.click('#forget');
  await page.click('#forgetyes');
  await page.waitForLoadState('load');
  await ready();
  await sleep(2000);
  const after = await events();
  check('forgotten', !after.find((e) => e.type === 'saves-loaded'), after.filter((e) => /saves/.test(e.type)));
  const gone = await page.evaluate(async () => { try { await window.emuCi.fsReadFile('GPSAVES/MYTEST'); return false; } catch { return true; } });
  check('the game no longer finds the file', gone);
} catch (e) {
  check('ran', false, String(e?.stack ?? e));
  await shot('error').catch(() => {});
}
fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(result, null, 1));
await emu.close();
process.exit(Object.values(result.checks).every((c) => c.ok) ? 0 : 1);
