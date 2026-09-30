// Mouse control: select the Mouse preset in Game Options > Control Method,
// start a Quick Race (Monza), then drive with the mouse buttons and steer with
// relative (sendMouseRelativeMotion) and absolute (sendMouseMotion) motion.
//
//   timeout 175 node probes/node-mouse.cjs dist/node-g-25000.jsdos mouse [relStep] [burst]
//
// Steering is measured like probes/route-demo.cjs: the sum of route.sceneShift
// over 10 x 100 ms (+ = view moved right = car turning left).
'use strict';
const { startMany, outDir, route } = require('./node-common.cjs');
const menu = require('./node-menu.cjs');

const [bundle, tag = 'mouse', stepArg = '10', burstArg = '6'] = process.argv.slice(2);
const STEP = Number(stepArg), BURST = Number(burstArg);
const { log, save, json } = outDir(tag);

(async () => {
  const emu = await startMany([bundle]);
  const drv = route.nodeDriver(emu);
  const ci = emu.ci;
  const summary = { bundle, step: STEP, burst: BURST, phases: [] };
  try {
    await route.toMainMenu(drv, { log });
    // MAIN MENU > Game Options Menu > Control Method > Mouse > Return > Main Menu
    save(await menu.select(drv, menu.BTN.mainGameOptions, { log }), 'm1-options');
    save(await menu.select(drv, menu.BTN.optControl, { log }), 'm2-control');
    save(await menu.select(drv, menu.BTN.ccmMouse, { log, timeout: 1500 }), 'm3-mouse-chosen');
    save(await menu.select(drv, menu.BTN.ccmReturn, { log }), 'm4-options');
    save(await menu.select(drv, menu.BTN.optMainMenu, { log }), 'm5-main');

    await route.toTrack(drv, { log, mode: 'quickrace', onScreen: async (n, img) => save(img, `r-${n}`) });

    const sample = async (label, during) => {
      let a = await drv.screenshot(); let total = 0; const shifts = [];
      for (let i = 0; i < 10; i++) {
        if (during) await during(i);
        await drv.sleep(100);
        const b = await drv.screenshot();
        const sh = route.sceneShift(a, b); shifts.push(sh); total += sh; a = b;
      }
      const r = { label, total, shifts, mph: route.readMph(a) };
      save(a, `p-${String(summary.phases.length).padStart(2, '0')}-${label}`);
      summary.phases.push(r);
      log('phase', r);
      return r;
    };
    const rel = async (dx, n = BURST) => { for (let i = 0; i < n; i++) { ci.sendMouseRelativeMotion(dx, 0); await drv.sleep(10); } };

    // accelerate with the right mouse button (1)
    const mph0 = route.readMph(await drv.screenshot());
    ci.sendMouseButton(1, true);
    await drv.sleep(3000);
    summary.accelRightButton = { before: mph0, after3s: route.readMph(await drv.screenshot()) };
    log('right button 3 s:', summary.accelRightButton);
    save(await drv.screenshot(), 'accel-right-button-3s');

    await sample('none');
    await rel(-STEP); await sample(`rel-left-${STEP * BURST}px`); await rel(STEP);
    await sample('none-2');
    await rel(STEP); await sample(`rel-right-${STEP * BURST}px`); await rel(-STEP);
    await sample('none-3');
    ci.sendMouseMotion(0.5, 0.5); await drv.sleep(50);
    ci.sendMouseMotion(0.25, 0.5); await sample('abs-0.25'); ci.sendMouseMotion(0.5, 0.5);
    await sample('none-4');
    ci.sendMouseMotion(0.75, 0.5); await sample('abs-0.75'); ci.sendMouseMotion(0.5, 0.5);
    await sample('none-5');
    // continuous relative motion to the left during the window (does the lock keep growing?)
    await sample('rel-left-continuous', async () => rel(-2, 2));
    await rel(40, 5);
    await sample('none-6');

    // brake with the left mouse button (0) while the right is released
    ci.sendMouseButton(1, false);
    const b0 = route.readMph(await drv.screenshot());
    ci.sendMouseButton(0, true);
    const brake = [];
    for (let i = 0; i < 4; i++) { await drv.sleep(500); brake.push(route.readMph(await drv.screenshot())); }
    ci.sendMouseButton(0, false);
    summary.brakeLeftButton = { before: b0, every500ms: brake };
    log('left button 2 s:', summary.brakeLeftButton);
    save(await drv.screenshot(), 'brake-left-button');

    // does the A key still accelerate with the mouse preset?
    const a0 = route.readMph(await drv.screenshot());
    await drv.keyDown('a'); await drv.sleep(2500);
    const a1 = route.readMph(await drv.screenshot());
    await drv.keyUp('a');
    summary.keyAWithMousePreset = { before: a0, after2_5s: a1 };
    log('A key 2.5 s with mouse preset:', summary.keyAWithMousePreset);
    summary.ok = true;
  } catch (e) {
    log('FAILED', e.message);
    if (e.lastImage) save(e.lastImage, 'failure');
    save(await drv.screenshot(), 'failure-now');
    summary.ok = false; summary.error = e.message;
  }
  json('summary.json', summary);
  await emu.stop();
  process.exit(summary.ok ? 0 : 1);
})();
