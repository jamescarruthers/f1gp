// Menu helpers for screens lib/route.cjs has no fingerprint for: move the red
// highlight to a button given by its centre (320x200 coordinates, measured
// from screenshots in out/node-probes/), then press Enter.
'use strict';
const { route } = require('./node-common.cjs');

// Coordinates of highlight centres (cx, cy), measured from screenshots.
const BTN = {
  // MAIN MENU (lib/route.cjs MAIN_MENU order, 18 px apart from cy 36)
  mainGameOptions: { cx: 160, cy: 162 }, mainLoadSave: { cx: 160, cy: 72 },
  // OPTIONS MENU (out/node-probes/x-opts/002-enter.png)
  optQuickRace: { cx: 160, cy: 59 }, optRace: { cx: 160, cy: 75 }, optGame: { cx: 160, cy: 91 },
  optControl: { cx: 160, cy: 107 }, optStartup: { cx: 160, cy: 123 }, optPrinter: { cx: 160, cy: 139 },
  optLink: { cx: 160, cy: 155 }, optSave: { cx: 104, cy: 175 }, optMainMenu: { cx: 215, cy: 175 },
  // CAR CONTROL METHOD (x-opts/003-*.png)
  ccmEdit: { cx: 160, cy: 41 }, ccmView: { cx: 160, cy: 58 }, ccmCalibrate: { cx: 160, cy: 75 },
  ccmKeyboard: { cx: 160, cy: 99 }, ccmMouse: { cx: 160, cy: 117 }, ccmJoystick: { cx: 160, cy: 134 },
  ccmCustom: { cx: 160, cy: 151 }, ccmReturn: { cx: 160, cy: 174 },
};

const near = (h, t, tol) => h && Math.abs(h.cx - t.cx) <= (tol.x ?? 25) && Math.abs(h.cy - t.cy) <= (tol.y ?? 6);

// Wait until the highlight box is found and stable on two screenshots.
async function highlight(drv, { timeout = 6000 } = {}) {
  const t0 = Date.now();
  let prev = null;
  while (Date.now() - t0 < timeout) {
    const h = route.findHighlight(await drv.screenshot());
    if (h && prev && Math.abs(h.cx - prev.cx) < 2 && Math.abs(h.cy - prev.cy) < 2) return h;
    prev = h;
    await drv.sleep(150);
  }
  return prev;
}

// Move the highlight to target {cx, cy}; vertical first, then horizontal.
async function moveTo(drv, target, { log = () => {}, tol = {}, maxSteps = 24 } = {}) {
  for (let i = 0; i < maxSteps; i++) {
    const h = await highlight(drv);
    if (!h) throw new Error('no highlight on screen');
    if (near(h, target, tol)) return h;
    let key;
    if (Math.abs(h.cy - target.cy) > (tol.y ?? 6)) key = h.cy > target.cy ? 'up' : 'down';
    else key = h.cx > target.cx ? 'left' : 'right';
    log(`  highlight (${h.cx.toFixed(0)},${h.cy.toFixed(0)}) -> (${target.cx},${target.cy}): ${key}`);
    await drv.press(key, 120);
    await drv.sleep(250);
  }
  throw new Error(`could not move highlight to ${JSON.stringify(target)}`);
}

// Move to target and press Enter; wait until the screen changes.
async function select(drv, target, opts = {}) {
  await moveTo(drv, target, opts);
  const before = await drv.screenshot();
  await drv.press('enter', 120);
  const t0 = Date.now();
  while (Date.now() - t0 < (opts.timeout || 6000)) {
    await drv.sleep(200);
    const img = await drv.screenshot();
    if (route.frameDiff(before, img) > 0.02) { await drv.sleep(opts.settle ?? 700); return img; }
  }
  return drv.screenshot();
}

module.exports = { BTN, highlight, moveTo, select };
