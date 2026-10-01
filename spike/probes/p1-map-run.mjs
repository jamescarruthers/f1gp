// p1-map-run.mjs - run map.html in headless Chromium (js-dos direct mode),
// drive it to a Quick Race with lib/route.cjs through real DOM key events
// (so the page's own keyboard handling is what reaches the game), let an
// autopilot drive the player's car, and record:
//   - page screenshots (game + map + table) and framebuffer shots,
//   - the dash LCD against the page's state and its table,
//   - the page's frame time and the emulator's speed, phase by phase:
//     map on, map off, map on with trails/zoom, and extra main-thread load.
//
//   node build-bundle.mjs --autoexec "gp /g" --cycles 25000 --out dist/p1-map-25000.jsdos
//   timeout 240 node probes/p1-map-run.mjs [--tag run1] [--quick] [--phases name,name] [--input real|ci]
//
// --quick: boot only, screenshot the first screens and the menus, no race.
// Output: out/p1-map/<tag>/{summary.json, phases.json, dash.jsonl, autopilot.jsonl, log.txt, page-*.png, fb-*.png}
//
// The dash reader and the autopilot are in probes/p1-map-lib.mjs.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { launch, encodePng } from '../lib/browser-emu.mjs';
import { readDash, sample, checkSample, tally, installAutopilot } from './p1-map-lib.mjs';

const require = createRequire(import.meta.url);
const route = require('../lib/route.cjs');
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const flag = (k) => args.includes(`--${k}`);
const TAG = opt('tag', 'run');
const QUICK = flag('quick');
const BUNDLE = opt('bundle', 'dist/p1-map-25000.jsdos');
const INPUT = opt('input', 'real');
const OUT = path.join(import.meta.dirname, '..', 'out', 'p1-map', TAG);
fs.mkdirSync(OUT, { recursive: true });
const T0 = Date.now();
const lines = [];
const log = (...a) => { const l = `${((Date.now() - T0) / 1000).toFixed(1)}s ${a.join(' ')}`; lines.push(l); console.log(l); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- phases
// keys: [seconds into the phase, DOM key] pressed through page.keyboard (so the page's handler forwards them)
const PHASES = [
  { name: 'start', seconds: 20, set: { map: true, trails: false, follow: 'none', smooth: true, busy: 0 }, shotEvery: 5, dashEvery: 0.5 },
  { name: 'trails', seconds: 15, set: { trails: true, trailSeconds: 10 }, shotEvery: 5, dashEvery: 0.5 },
  { name: 'follow', seconds: 20, set: { follow: 'player', zoom: 6 }, shotEvery: 4, dashEvery: 0.5, keys: [[6, 'ArrowLeft'], [12, 'PageDown'], [16, 'ArrowRight']] },
  { name: 'measure-on', seconds: 20, set: { follow: 'none', trails: true } },
  { name: 'measure-off', seconds: 20, set: { map: false } },
  { name: 'busy-3', seconds: 10, set: { map: true, busy: 3 } },
  { name: 'busy-5', seconds: 10, set: { busy: 5 } },
  { name: 'busy-7', seconds: 10, set: { busy: 7 } },
  { name: 'busy-10', seconds: 10, set: { busy: 10 } },
  { name: 'final', seconds: 8, set: { busy: 0, follow: 'viewed', zoom: 12 }, shotEvery: 4, dashEvery: 0.5, keys: [[1, 'ArrowUp']] },
  // looks: pause (P), dark colour scheme, phone width; screenshots only
  { name: 'looks', seconds: 9, set: { follow: 'none' }, keys: [[0.5, 'Home'], [1, 'KeyP'], [7.5, 'KeyP']],
    actions: [[2.5, 'shot:paused'], [3, 'dark'], [4.5, 'shot:dark'], [5, 'phone'], [6.5, 'shot:phone'], [7, 'restore']] },
];
const only = opt('phases', null);
const phases = only ? PHASES.filter((p) => only.split(',').includes(p.name)) : PHASES;

const summary = { tag: TAG, bundle: BUNDLE, input: INPUT, cpus: os.cpus().length, loadavgStart: os.loadavg().map((v) => +v.toFixed(2)) };
let emu;
try {
  emu = await launch({ bundle: BUNDLE, page: 'map.html', input: INPUT, viewport: { width: 1440, height: 960 }, query: { audio: opt('audio', 'own') }, log });
  const { page, driver } = emu;
  await sleep(1500);
  await driver.pageShot(path.join(OUT, 'page-boot.png'));
  const onScreen = async (name) => {
    if (['language', 'main', 'circuitView', 'race'].includes(name)) {
      await sleep(400);
      await driver.pageShot(path.join(OUT, `page-${name}.png`));
    }
  };
  if (QUICK) {
    await route.toMainMenu(driver, { log });
    await sleep(1500);
    await driver.pageShot(path.join(OUT, 'page-main.png'));
    summary.events = await page.evaluate(() => window.emuEvents);
    summary.ok = true;
  } else {
    summary.route = await route.toTrack(driver, { mode: 'quickrace', log, onScreen });
    log('green');
    await driver.pageShot(path.join(OUT, 'page-green.png'));
    await driver.shot(path.join(OUT, 'fb-green.png'));
    summary.trackInfo = await page.evaluate(() => window.mapApp.trackInfo);
    summary.autopilot = await page.evaluate(installAutopilot);
    await page.evaluate(() => { window.mapApp.holdStats = true; });
    const dashFd = fs.openSync(path.join(OUT, 'dash.jsonl'), 'w');
    const phaseResults = [];
    const checks = [];
    const tRace = Date.now();
    for (const ph of phases) {
      const { busy, ...set } = ph.set;
      await page.evaluate(([s, b]) => { window.mapApp.set({ ...s, ...(b !== undefined ? { busy: b } : {}) }); }, [set, busy]);
      await sleep(300);
      const a0 = await page.evaluate(() => window.ci.asyncifyStats()).catch(() => null);
      await page.evaluate(() => window.mapApp.resetStats());
      const p0 = Date.now();
      let nextShot = ph.shotEvery ? 0 : Infinity, nextDash = ph.dashEvery ? 0 : Infinity;
      const keys = (ph.keys || []).map(([t, k]) => ({ t, k, done: false }));
      const actions = (ph.actions || []).map(([t, what]) => ({ t, what, done: false }));
      let shots = 0, dashes = 0;
      while (Date.now() - p0 < ph.seconds * 1000) {
        const el = (Date.now() - p0) / 1000;
        for (const k of keys) if (!k.done && el >= k.t) { k.done = true; await page.keyboard.press(k.k, { delay: 120 }); log(`${ph.name}: key ${k.k}`); }
        for (const a of actions) if (!a.done && el >= a.t) {
          a.done = true;
          if (a.what.startsWith('shot:')) await page.screenshot({ path: path.join(OUT, `page-${ph.name}-${a.what.slice(5)}.png`), fullPage: a.what === 'shot:phone' });
          else if (a.what === 'dark') await page.emulateMedia({ colorScheme: 'dark' });
          else if (a.what === 'phone') await page.setViewportSize({ width: 390, height: 844 });
          else if (a.what === 'restore') { await page.emulateMedia({ colorScheme: 'light' }); await page.setViewportSize({ width: 1440, height: 960 }); }
          log(`${ph.name}: ${a.what}`);
        }
        if (el >= nextDash) {
          nextDash += ph.dashEvery;
          const s = await sample(page);
          const d = readDash(s.img);
          const chk = checkSample(s, d);
          checks.push(chk);
          fs.writeSync(dashFd, JSON.stringify({ phase: ph.name, t: +((Date.now() - tRace) / 1000).toFixed(2), dash: d, check: chk, st: s.st, latestFrame: s.latestFrame, table: s.table, row: s.row, viewedRow: s.viewedRow }) + '\n');
          dashes++;
          if (el >= nextShot) {
            nextShot += ph.shotEvery;
            const tag = `${ph.name}-${String(Math.round(el)).padStart(2, '0')}`;
            await driver.pageShot(path.join(OUT, `page-${tag}.png`));
            fs.writeFileSync(path.join(OUT, `fb-${tag}.png`), encodePng(s.img.width, s.img.height, s.img.data, 4));
            shots++;
          }
        } else if (el >= nextShot) {
          nextShot += ph.shotEvery;
          await driver.pageShot(path.join(OUT, `page-${ph.name}-${String(Math.round(el)).padStart(2, '0')}.png`));
          shots++;
        }
        await sleep(100);
      }
      const stats = await page.evaluate(() => window.mapApp.stats());
      const a1 = await page.evaluate(() => window.ci.asyncifyStats()).catch(() => null);
      const res = { name: ph.name, set: ph.set, seconds: ph.seconds, shots, dashes, stats, loadavg: os.loadavg().map((v) => +v.toFixed(2)) };
      if (a0 && a1) {
        res.asyncify = { frames: a1.messageFrame - a0.messageFrame, sound: a1.messageSound - a0.messageSound, sleeps: a1.sleepCount - a0.sleepCount,
          sleepMs: a1.sleepTime - a0.sleepTime, nonSkippableSleeps: a1.nonSkippableSleepCount - a0.nonSkippableSleepCount, cpuMetrics: a1.cpuMetrics ?? null };
      }
      phaseResults.push(res);
      const c = stats.clock || {};
      log(`phase ${ph.name}: raf ${stats.raf.fps} fps (median ${stats.raf.median} ms, p99 ${stats.raf.p99}, >50ms ${stats.raf.over50}), work median ${stats.workMs.median} p95 ${stats.workMs.p95} ms, ` +
        `map ${stats.mapMs.median} ms, game ${c.gameFps} fps, clock x${c.rate}, emu x${c.emuSpeed}, kept ${stats.framesKept}/${stats.framesSeen}, missed ${stats.missedFrames}, long tasks ${stats.longTasks.n}`);
    }
    fs.closeSync(dashFd);
    summary.phases = phaseResults;
    summary.dashChecks = tally(checks);
    log('dash checks', JSON.stringify(summary.dashChecks));
    fs.writeFileSync(path.join(OUT, 'phases.json'), JSON.stringify(phaseResults, null, 1));
    const ap = await page.evaluate(() => { window.autopilot.stop(); return window.autopilot.log; });
    fs.writeFileSync(path.join(OUT, 'autopilot.jsonl'), ap.map((r) => JSON.stringify(r)).join('\n') + '\n');
    // the track file through the emulator's file system (fallback path in map.html)
    summary.fsReadFile = await Promise.race([
      page.evaluate(async () => { try { const b = await window.ci.fsReadFile('F1CT12.DAT'); return { ok: true, bytes: b.length }; } catch (e) { return { ok: false, error: String(e) }; } }),
      sleep(5000).then(() => ({ ok: false, error: 'timeout 5 s' })),
    ]);
    summary.events = await page.evaluate(() => window.emuEvents.filter((e) => e.type !== 'message'));
    summary.ok = true;
  }
} catch (e) {
  log('FAILED', e.stack || e.message);
  summary.ok = false; summary.error = String(e.message || e);
  if (emu) await emu.driver.pageShot(path.join(OUT, 'page-failed.png')).catch(() => {});
}
if (emu) {
  summary.pageErrors = emu.pageErrors;
  summary.consoleErrors = emu.consoleMessages.filter((m) => m.type === 'error' || m.type === 'warning').slice(0, 40);
  summary.nonLocalRequests = emu.requests.filter((r) => !r.local).map((r) => r.url);
}
summary.loadavgEnd = os.loadavg().map((v) => +v.toFixed(2));
summary.totalSeconds = +((Date.now() - T0) / 1000).toFixed(1);
fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(summary, null, 1));
fs.writeFileSync(path.join(OUT, 'log.txt'), lines.join('\n') + '\n');
log('done', summary.ok ? 'ok' : 'FAILED');
if (emu) await emu.close();
process.exit(summary.ok ? 0 : 1);
