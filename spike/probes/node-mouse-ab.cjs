// A/B mouse steering: identical runs (Mouse preset, Quick Race Monza, right
// button held from green) that differ only in one steering input applied 4 s
// after green. Compares the view shift over the next 2 s and the screenshots.
//
//   timeout 150 node probes/node-mouse-ab.cjs BUNDLE TAG none|rel:-200|abs:0.3|key:comma [keys]
//
// With the last argument "keys" the Keyboard preset is kept and A is held
// instead of the right mouse button (key:comma / key:period as the input).
'use strict';
const { startMany, outDir, route } = require('./node-common.cjs');
const menu = require('./node-menu.cjs');

const [bundle, tag = 'mouse-ab', input = 'none', preset = 'mouse'] = process.argv.slice(2);
const { log, save, json } = outDir(tag);

(async () => {
  const emu = await startMany([bundle]);
  const drv = route.nodeDriver(emu);
  const ci = emu.ci;
  const summary = { bundle, input, preset, samples: [] };
  try {
    await route.toMainMenu(drv, { log });
    if (preset === 'mouse') {
      await menu.select(drv, menu.BTN.mainGameOptions);
      await menu.select(drv, menu.BTN.optControl);
      await menu.select(drv, menu.BTN.ccmMouse, { timeout: 1500 });
      await menu.select(drv, menu.BTN.ccmReturn);
      await menu.select(drv, menu.BTN.optMainMenu);
    }
    await route.toTrack(drv, { log, mode: 'quickrace' });
    const tg = Date.now();
    if (preset === 'mouse') { ci.sendMouseMotion(0.5, 0.5); ci.sendMouseButton(1, true); } else await drv.keyDown('a');
    await drv.sleep(Math.max(0, tg + 4000 - Date.now()));
    let a = await drv.screenshot();
    summary.mphAtInput = route.readMph(a);
    save(a, 'at-input');
    const [kind, val] = input.split(':');
    if (kind === 'rel') { const v = Number(val); const n = Math.ceil(Math.abs(v) / 10); for (let i = 0; i < n; i++) ci.sendMouseRelativeMotion(Math.sign(v) * 10, 0); }
    if (kind === 'abs') ci.sendMouseMotion(Number(val), 0.5);
    if (kind === 'key') await drv.keyDown(val);
    let total = 0;
    for (let i = 1; i <= 20; i++) {
      await drv.sleep(Math.max(0, tg + 4000 + i * 100 - Date.now()));
      const b = await drv.screenshot();
      const sh = route.sceneShift(a, b); total += sh; a = b;
      summary.samples.push({ t: i * 100, shift: sh, total, mph: route.readMph(b) });
      if (i % 5 === 0) save(b, `after-${i * 100}ms`);
    }
    if (kind === 'key') await drv.keyUp(val);
    summary.total1s = summary.samples[9].total;
    summary.total2s = total;
    log('input', input, 'mph at input', summary.mphAtInput, 'shift sum 1 s', summary.total1s, '2 s', summary.total2s, 'mph', summary.samples.map((s) => s.mph).join(','));
    summary.ok = true;
  } catch (e) {
    log('FAILED', e.message);
    if (e.lastImage) save(e.lastImage, 'failure');
    summary.ok = false; summary.error = e.message;
  }
  json('summary.json', summary);
  await emu.stop();
  process.exit(0);
})();
