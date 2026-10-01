// p1-state-browser.mjs - check lib/f1gp-mem.mjs and lib/f1gp-state.mjs in
// headless Chromium with js-dos in direct (main-thread) mode: route to the
// Quick Race grid, import both modules into the page, hold A, and call
// readState() at every requestAnimationFrame for --seconds.
//
//   timeout 240 node probes/p1-state-browser.mjs [--seconds 20] [--bundle dist/p1-state-25000.jsdos]
//
// Writes out/p1-state/browser/{summary.json, raf.jsonl, log.txt, green.png}.
// Measures: readState cost in the page, how often a rAF read finds a new game
// frame, how often it lands while the cars are ahead of the clock
// (carsAhead / !settled), and the player's derived-vs-live error.
import fs from 'node:fs';
import path from 'node:path';
import { launch } from '../lib/browser-emu.mjs';
import { route } from './browser-probe-lib.mjs';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const SECONDS = +opt('seconds', 20);
const BUNDLE = opt('bundle', 'dist/p1-state-25000.jsdos');
const OUT = path.join(import.meta.dirname, '..', 'out', 'p1-state', 'browser');
fs.mkdirSync(OUT, { recursive: true });
const lines = [];
const T0 = Date.now();
const log = (...a) => { const l = `${((Date.now() - T0) / 1000).toFixed(1)}s ${a.join(' ')}`; lines.push(l); console.log(l); };

let emu;
const summary = { bundle: BUNDLE, seconds: SECONDS };
try {
  emu = await launch({ bundle: BUNDLE, page: 'raw.html', query: { worker: 0 }, log });
  summary.route = await route.toTrack(emu.driver, { mode: 'quickrace', log });
  await emu.driver.shot(path.join(OUT, 'green.png'));
  await emu.driver.keyDown('a');
  const res = await emu.page.evaluate(async (seconds) => {
    const { attach } = await import('/lib/f1gp-mem.mjs');
    const { createReader, readTrack } = await import('/lib/f1gp-state.mjs');
    const t0 = performance.now();
    const mem = attach(window.ci, { requireGame: true });
    const attachMs = performance.now() - t0;
    const reader = createReader(mem);
    const track = readTrack(mem);
    const raf = [];
    const us = [];
    let lastFrame = -1;
    await new Promise((resolve) => {
      const end = performance.now() + seconds * 1000;
      const step = () => {
        const q = performance.now();
        const st = reader.read({ crossCheck: true });
        us.push((performance.now() - q) * 1000);
        const p = st.cars[st.playerSlot];
        raf.push({
          t: Math.round(q), frame: st.frame, tick: st.tick, newFrame: st.frame !== lastFrame, settled: st.settled, carsAhead: st.carsAhead,
          mph: p.speedMph, err: p.derived ? Math.hypot(p.derived.x - p.x, p.derived.y - p.y) / 256 : null,
          none: st.cars.filter((c) => c.pos === 'none').length, derived: st.cars.filter((c) => c.pos === 'derived').length,
        });
        lastFrame = st.frame;
        if (performance.now() < end) requestAnimationFrame(step); else resolve();
      };
      requestAnimationFrame(step);
    });
    us.sort((a, b) => a - b);
    // performance.now() is coarse in the page (0.1 ms or more): time 2000 reads back to back
    const q0 = performance.now();
    for (let i = 0; i < 2000; i++) reader.read();
    const backToBackUs = ((performance.now() - q0) * 1000) / 2000;
    const q1 = performance.now();
    for (let i = 0; i < 2000; i++) reader.read({ crossCheck: true });
    const crossUs = ((performance.now() - q1) * 1000) / 2000;
    return {
      attachMs, memBase: mem.memBase, imageSeg: mem.imageSeg, checked: mem.checked, lapSegments: track.lapSegments, pitEntries: track.pit.length,
      readUs: { median: us[us.length >> 1], p95: us[Math.floor(us.length * 0.95)], max: us[us.length - 1], backToBack: backToBackUs, backToBackCrossCheck: crossUs }, raf,
    };
  }, SECONDS);
  await emu.driver.keyUp('a');
  const raf = res.raf;
  fs.writeFileSync(path.join(OUT, 'raf.jsonl'), raf.map((r) => JSON.stringify(r)).join('\n') + '\n');
  delete res.raf;
  const frames = new Set(raf.map((r) => r.frame));
  const errs = raf.map((r) => r.err).filter((e) => e !== null).sort((a, b) => a - b);
  Object.assign(summary, res, {
    rafReads: raf.length, rafPerSecond: +(raf.length / SECONDS).toFixed(1),
    gameFrames: frames.size, gameFps: +((raf.at(-1).frame - raf[0].frame) / ((raf.at(-1).t - raf[0].t) / 1000)).toFixed(2),
    readsWithNewFrame: raf.filter((r) => r.newFrame).length,
    framesWithoutConsistentRead: [...frames].filter((f) => !raf.some((r) => r.frame === f && r.settled && !r.carsAhead)).length,
    unsettled: raf.filter((r) => !r.settled).length, carsAhead: raf.filter((r) => r.carsAhead).length,
    carsWithoutPosition: raf.reduce((a, r) => a + r.none, 0),
    derivedPerRead: raf[raf.length >> 1].derived,
    playerDerivedVsLiveFine: { median: errs[errs.length >> 1], max: errs.at(-1) },
    finalMph: raf.at(-1).mph,
  });
  summary.ok = true;
} catch (e) {
  log('FAILED', e.stack || e.message);
  summary.ok = false; summary.error = e.message;
}
log('summary', JSON.stringify(summary));
fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(summary, null, 1));
fs.writeFileSync(path.join(OUT, 'log.txt'), lines.join('\n') + '\n');
if (emu) await emu.close();
process.exit(summary.ok ? 0 : 1);
