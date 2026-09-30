// Steering seen on the front tyres while stationary on the Quick Race grid
// (before the lights go green), for keys or mouse.
//
//   timeout 175 node probes/node-steer-grid.cjs dist/node-g-25000.jsdos TAG keys|mouse
//
// For each step it records the tyre signature: in the left and right tyre
// areas of the cockpit view, the count and mean x of light grey tyre pixels,
// and the fraction of pixels changed from the reference (wheels straight).
'use strict';
const { startMany, outDir, route } = require('./node-common.cjs');
const menu = require('./node-menu.cjs');

const [bundle, tag = 'steer-grid', mode = 'keys'] = process.argv.slice(2);
const { log, save, json } = outDir(tag);
const L = [0, 100, 75, 50], R = [245, 100, 75, 50];

function tyre(img, rect) {
  const [x0, y0, w, h] = rect;
  let n = 0, sx = 0;
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) {
    const [r, g, b] = route.px(img, x, y);
    if (r > 150 && g > 150 && b > 150 && Math.abs(r - b) < 40) { n++; sx += x; }
  }
  return { n, mx: n ? +(sx / n).toFixed(1) : null };
}

(async () => {
  const emu = await startMany([bundle]);
  const drv = route.nodeDriver(emu);
  const ci = emu.ci;
  const steps = [];
  let ref = null;
  const rec = async (label) => {
    await drv.sleep(250);
    const img = await drv.screenshot();
    const r = { label, left: tyre(img, L), right: tyre(img, R), dL: +route.frameDiff(ref || img, img, L, 1).toFixed(3), dR: +route.frameDiff(ref || img, img, R, 1).toFixed(3), lights: route.readLights(img) };
    steps.push(r);
    save(img, `s${String(steps.length).padStart(2, '0')}-${label}`);
    log(r);
    return r;
  };
  try {
    await route.toMainMenu(drv, { log });
    if (mode === 'mouse') {
      await menu.select(drv, menu.BTN.mainGameOptions);
      await menu.select(drv, menu.BTN.optControl);
      await menu.select(drv, menu.BTN.ccmMouse, { timeout: 1500 });
      await menu.select(drv, menu.BTN.ccmReturn);
      await menu.select(drv, menu.BTN.optMainMenu);
    }
    await route.toTrack(drv, { log, mode: 'quickrace', waitForGreen: false });
    await drv.sleep(1500);
    ref = await drv.screenshot();
    await rec('ref');
    if (mode === 'keys') {
      for (const [key, ms] of [['comma', 100], ['comma', 400], ['comma', 1500], ['period', 100], ['period', 400], ['period', 1500]]) {
        await drv.keyDown(key); await drv.sleep(ms);
        await rec(`${key}-held-${ms}ms`);
        await drv.keyUp(key);
        await drv.sleep(800);
        await rec(`${key}-released`);
      }
    } else {
      const rel = async (dx) => { const n = Math.ceil(Math.abs(dx) / 10); for (let i = 0; i < n; i++) { ci.sendMouseRelativeMotion(Math.sign(dx) * 10, 0); await drv.sleep(5); } };
      let pos = 0;
      for (const d of [-20, -20, -40, -80, -160, -320]) { await rel(d); pos += d; await rec(`rel-${pos}`); }
      await drv.sleep(1500); await rec(`rel-${pos}-after-1.5s`);
      await rel(-pos); pos = 0; await rec('rel-back-0');
      for (const d of [20, 20, 40, 80, 160, 320]) { await rel(d); pos += d; await rec(`rel+${pos}`); }
      await rel(-pos); pos = 0; await rec('rel-back-0b');
      for (const x of [0.5, 0.4, 0.3, 0.1, 0.0, 0.5, 0.6, 0.7, 0.9, 1.0, 0.5]) { ci.sendMouseMotion(x, 0.5); await rec(`abs-${x}`); }
    }
  } catch (e) {
    log('FAILED', e.message);
    if (e.lastImage) save(e.lastImage, 'failure');
  }
  json('summary.json', { bundle, mode, steps });
  await emu.stop();
  process.exit(0);
})();
