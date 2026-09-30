// Sound levels for one sound set: intro (f1gp.bat), main menu, on track idle,
// on track holding A for 5 s. Also dumps the DOSBox log lines.
//
//   timeout 180 node probes/node-sound.cjs dist/node-adlib-intro.jsdos adlib [introSeconds]
//
// Output: out/node-probes/sound-<tag>/ (log.txt, summary.json, messages.txt, *.png)
'use strict';
const { startMany, outDir, route } = require('./node-common.cjs');

const [bundle, tag = 'x', introArg = '30'] = process.argv.slice(2);
const INTRO_S = Number(introArg);
const { log, save, json, dir } = outDir(`sound-${tag}`);
const fs = require('node:fs');
const path = require('node:path');

(async () => {
  const emu = await startMany([bundle]);
  const drv = route.nodeDriver(emu);
  const summary = { bundle, tag, windows: {} };
  const win = (name, lvl, extra = {}) => {
    const r = { seconds: +(lvl.samples / 44100).toFixed(2), samples: lvl.samples, rms: +lvl.rms.toFixed(4), peak: +lvl.peak.toFixed(4),
      mean: lvl.mean === undefined ? undefined : +lvl.mean.toFixed(4), acRms: lvl.acRms === undefined ? undefined : +lvl.acRms.toFixed(4), changes: lvl.changes, ...extra };
    summary.windows[name] = r;
    log(`window ${name}:`, r);
    return r;
  };
  try {
    // (a) intro: 1 s windows, no keys pressed
    emu.soundLevel();
    const perSecond = [], perSecondAc = [];
    let sumSq = 0, n = 0, peak = 0, sum = 0, changes = 0;
    for (let s = 1; s <= INTRO_S; s++) {
      await drv.sleep(1000);
      const l = emu.soundLevel();
      perSecond.push(+l.rms.toFixed(3)); perSecondAc.push(+l.acRms.toFixed(3));
      sumSq += l.rms * l.rms * l.samples; n += l.samples; peak = Math.max(peak, l.peak); sum += l.mean * l.samples; changes += l.changes;
      if (s % 5 === 0) save(await drv.screenshot(), `intro-${String(s).padStart(2, '0')}s`);
    }
    const mean = sum / (n || 1);
    win('intro', { samples: n, rms: Math.sqrt(sumSq / (n || 1)), peak, mean, acRms: Math.sqrt(Math.max(0, sumSq / (n || 1) - mean * mean)), changes },
      { perSecondRms: perSecond, perSecondAcRms: perSecondAc, secondsWithSound: perSecondAc.filter((v) => v > 0.001).length });

    // (b) main menu (route presses Esc to skip the rest of the intro/credits)
    await route.toMainMenu(drv, { log });
    await drv.sleep(1000);
    emu.soundLevel();
    await drv.sleep(4000);
    win('mainMenu', emu.soundLevel());
    save(await drv.screenshot(), 'main-menu');

    // (c) on track idle (practice, off the jacks, engine running, no keys)
    await route.toTrack(drv, { log });
    await drv.sleep(500);
    emu.soundLevel();
    await drv.sleep(4000);
    win('trackIdle', emu.soundLevel(), { mph: route.readMph(await drv.screenshot()) });
    save(await drv.screenshot(), 'track-idle');

    // (d) on track holding A for 5 s
    emu.soundLevel();
    await drv.keyDown('a');
    await drv.sleep(5000);
    const img = await drv.screenshot();
    win('trackAccel5s', emu.soundLevel(), { mph: route.readMph(img) });
    save(img, 'track-accel-5s');
    await drv.keyUp('a');
    summary.ok = true;
  } catch (e) {
    log('FAILED', e.message);
    if (e.lastImage) save(e.lastImage, 'failure');
    summary.ok = false; summary.error = e.message;
  }
  fs.writeFileSync(path.join(dir, 'messages.txt'), emu.state.messages.join('\n') + '\n---stdout---\n' + emu.state.stdout.join(''));
  const interesting = emu.state.messages.filter((m) => /opl|adlib|mpu|midi|mt-?32|sound ?blaster|speaker|gus|tandy|fluid|mixer/i.test(m));
  summary.logMatches = interesting;
  summary.messageCount = emu.state.messages.length;
  json('summary.json', summary);
  log('log lines matching opl/adlib/mpu/midi/...:', interesting);
  await emu.stop();
  process.exit(summary.ok ? 0 : 1);
})();
