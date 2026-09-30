// Boot a bundle, run route.toTrack, drive for 10 s holding A, then check
// brake and the occupancy read-out (and, in quick race mode, steering on the
// circuit). Screenshots, log.txt and summary.json go to out/route/demo/<tag>/.
//
//   timeout 180 node probes/route-demo.cjs dist/route-g-25000.jsdos c25000
//       [--mode practice|quickrace] [--circuit "Great Britain"] [--backend dosbox|dosboxX]
//       [--answer WORD]   (type WORD at the manual check instead of the known answer)
//
// In practice mode the car starts in the pit lane, where the game steers it
// itself, so steering is only checked in quick race mode (on the grid).
const path = require('path');
const fs = require('fs');
const { start, encodePng } = require('../lib/node-emu.cjs');
const route = require('../lib/route.cjs');

const args = process.argv.slice(2);
const bundle = args[0];
const tag = args[1] || 'demo';
const opt = (name, dflt) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : dflt; };
const OUT = path.join(__dirname, '..', 'out', 'route', 'demo', tag);
fs.mkdirSync(OUT, { recursive: true });

function save(img, name) {
  const file = path.join(OUT, `${name}.png`);
  fs.writeFileSync(file, encodePng(img.width, img.height, img.data, 4));
  return file;
}

const sceneShift = route.sceneShift;

(async () => {
  const log = (...m) => { const line = m.join(' '); console.log(line); fs.appendFileSync(path.join(OUT, 'log.txt'), line + '\n'); };
  fs.writeFileSync(path.join(OUT, 'log.txt'), '');
  const t0 = Date.now();
  const emu = await start(bundle, { backend: opt('backend', 'dosbox') });
  const drv = route.nodeDriver(emu);
  const summary = { bundle, tag, started: new Date().toISOString() };
  let n = 0;
  try {
    const mode = opt('mode', 'practice');
    const res = await route.toTrack(drv, {
      mode,
      circuit: opt('circuit', undefined),
      answer: opt('answer', undefined), // e.g. --answer wrong, to test the failure path
      log,
      onScreen: async (name, img) => { save(img, `route-${String(n++).padStart(2, '0')}-${name}`); },
    });
    summary.route = res;
    log(`toTrack done in ${(res.ms / 1000).toFixed(1)} s (process ${(Date.now() - t0) / 1000} s)`);

    // Steering check (quick race only: on the circuit). A stays held; 1 s each
    // of no steering, comma (left), period (right); sum the view shift.
    const steerCheck = async () => {
      const steer = {};
      for (const [label, key] of [['none', null], ['left', 'comma'], ['right', 'period']]) {
        if (key) await drv.keyDown(key);
        let a = await drv.screenshot(); let total = 0; const shifts = [];
        for (let i = 0; i < 10; i++) {
          await drv.sleep(100);
          const b = await drv.screenshot();
          const sh = sceneShift(a, b); shifts.push(sh); total += sh; a = b;
        }
        save(a, `steer-${label}`);
        if (key) await drv.keyUp(key);
        steer[label] = { total, shifts, mph: route.readMph(a) };
      }
      log('steer view-shift sums (px; + = view moved right = car turning left):', JSON.stringify(Object.fromEntries(Object.entries(steer).map(([k, v]) => [k, v.total]))));
      summary.steer = steer;
    };

    // 1. Drive 10 s holding A (quick race: steering check after 3 s, A held).
    const drive = [];
    await drv.keyDown('a');
    const tDrive = Date.now();
    let prev = await drv.screenshot();
    for (let i = 1; i <= 10; i++) {
      await drv.sleep(Math.max(0, tDrive + i * 1000 - Date.now()));
      const img = await drv.screenshot();
      drive.push({ t: +((Date.now() - tDrive) / 1000).toFixed(1), mph: route.readMph(img), screen: route.identify(img).screen, changed: +route.frameDiff(prev, img).toFixed(3) });
      save(img, `drive-${String(i).padStart(2, '0')}s`);
      prev = img;
      if (mode === 'quickrace' && i === 3) await steerCheck();
    }
    await drv.keyUp('a');
    log('drive (A held) mph:', JSON.stringify(drive.map((d) => d.mph)), 'at s', JSON.stringify(drive.map((d) => d.t)), 'frame change', JSON.stringify(drive.map((d) => d.changed)));
    summary.drive = drive;

    // 3. Brake: hold Z for 3 s.
    const brake = [];
    const before = route.readMph(await drv.screenshot());
    await drv.keyDown('z');
    for (let i = 0; i < 6; i++) { await drv.sleep(500); const img = await drv.screenshot(); brake.push(route.readMph(img)); if (i === 5) save(img, 'brake-3s'); }
    await drv.keyUp('z');
    log('brake (Z held) from', before, 'mph:', JSON.stringify(brake));
    summary.brake = { before, after: brake };

    // 4. Occupancy: hold O.
    const occ = await route.measureOccupancy(drv, { samples: 5 });
    await drv.keyDown('o'); await drv.sleep(500); save(await drv.screenshot(), 'occupancy'); await drv.keyUp('o');
    log('occupancy (O held):', JSON.stringify(occ));
    summary.occupancy = occ;
    summary.ok = true;
  } catch (e) {
    log('FAILED:', e.message);
    if (e.lastImage) save(e.lastImage, 'failure');
    summary.ok = false; summary.error = e.message;
  }
  summary.sound = emu.soundLevel();
  summary.totalSeconds = (Date.now() - t0) / 1000;
  fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(summary, null, 1));
  log('total', summary.totalSeconds, 's; sound', JSON.stringify(summary.sound));
  await emu.stop();
  process.exit(summary.ok ? 0 : 1);
})();
