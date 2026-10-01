// Interactive exploration: boot, go to a start point, then run commands that
// are appended (one per line) to out/node-probes/<tag>/cmd.txt. After each
// command a numbered screenshot is saved; results go to log.txt.
//
//   timeout 175 node probes/node-repl.cjs BUNDLE TAG [menu|track|quickrace|none] [extra.zip ...]
//
// Commands:
//   k KEY [KEY...]      press keys (120 ms hold, 450 ms apart)
//   t TEXT              type text (letters, digits, space, . , /)
//   down KEY | up KEY   hold / release a key
//   w MS                wait
//   s [NAME]            screenshot
//   ma X Y              absolute mouse motion (0..1 of the frame)
//   mr DX DY [N] [MS]   relative mouse motion, N times, MS apart
//   mb BUTTON 0|1       mouse button (0 left, 1 right?, 2 middle?)
//   fs                  write the flat fsTree to fs-NNN.json
//   read PATH           fsReadFile -> file in the out folder
//   persist             persist(true) -> changes-NNN.zip
//   id | mph | occ      identify / readMph / measureOccupancy
//   quit
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { startMany, outDir, flatTree, route } = require('./node-common.cjs');

const [bundle, tag = 'repl', startAt = 'menu', ...extra] = process.argv.slice(2);
const { log, save, dir } = outDir(tag);
const CMD = path.join(dir, 'cmd.txt');
if (!fs.existsSync(CMD)) fs.writeFileSync(CMD, '');
let done = fs.readFileSync(CMD, 'utf8').split('\n').filter(Boolean).length; // skip old lines
const stamp = { n: 0 };

(async () => {
  const emu = await startMany([bundle, ...extra]);
  const drv = route.nodeDriver(emu);
  const shot = async (name) => { const img = await drv.screenshot(); const f = save(img, `${String(stamp.n++).padStart(3, '0')}${name ? '-' + name : ''}`); fs.copyFileSync(f, path.join(dir, 'last.png')); return img; };
  try {
    if (startAt === 'menu') await route.toMainMenu(drv, { log });
    else if (startAt === 'track') await route.toTrack(drv, { log });
    else if (startAt === 'quickrace') await route.toTrack(drv, { log, mode: 'quickrace' });
    else await drv.sleep(3000);
  } catch (e) { log('start failed', e.message); }
  await shot('start');
  log('READY');
  fs.writeFileSync(path.join(dir, 'ready'), String(Date.now()));
  for (;;) {
    const lines = fs.readFileSync(CMD, 'utf8').split('\n').filter(Boolean);
    if (lines.length <= done) { await drv.sleep(150); continue; }
    const line = lines[done++].trim();
    const [c, ...a] = line.split(/\s+/);
    log('>', line);
    try {
      if (c === 'quit') break;
      else if (c === 'k') { for (const key of a) { await drv.press(key, 120); await drv.sleep(450); } await shot(a.join('_').slice(0, 30)); }
      else if (c === 't') { await route.typeText(drv, line.slice(2)); await shot('typed'); }
      else if (c === 'down') { await drv.keyDown(a[0]); log('holding', a[0]); }
      else if (c === 'up') { await drv.keyUp(a[0]); await shot('up-' + a[0]); }
      else if (c === 'w') { await drv.sleep(Number(a[0])); await shot('w'); }
      else if (c === 's') { const img = await shot(a[0] || 's'); log(route.identify(img).screen, 'mph', route.readMph(img)); }
      else if (c === 'ma') { emu.ci.sendMouseMotion(Number(a[0]), Number(a[1])); await drv.sleep(300); await shot('ma'); }
      else if (c === 'mr') {
        const n = Number(a[2] || 1), gap = Number(a[3] || 50);
        for (let i = 0; i < n; i++) { emu.ci.sendMouseRelativeMotion(Number(a[0]), Number(a[1])); await drv.sleep(gap); }
        await shot('mr');
      }
      else if (c === 'mb') { emu.ci.sendMouseButton(Number(a[0]), a[1] === '1'); await drv.sleep(300); await shot('mb'); }
      else if (c === 'fs') { const t = flatTree(await emu.ci.fsTree()); fs.writeFileSync(path.join(dir, `fs-${stamp.n}.json`), JSON.stringify(t, null, 1)); log('fs entries', t.length, t.filter((x) => /gpsave|prefs|\.sav|temp/i.test(x.path))); }
      else if (c === 'read') { const b = await emu.ci.fsReadFile(a[0]); const f = path.join(dir, path.basename(a[0])); fs.writeFileSync(f, b); log('read', a[0], b.length, 'bytes ->', f); }
      else if (c === 'persist') { const z = await emu.ci.persist(true); const f = path.join(dir, `changes-${stamp.n}.zip`); if (z) fs.writeFileSync(f, z); log('persist', z ? z.length : null, 'bytes ->', f); }
      else if (c === 'id') { const img = await shot('id'); const r = route.identify(img); log(r.screen, r.score, 'highlight', route.findHighlight(img)); }
      else if (c === 'mph') { log('mph', route.readMph(await drv.screenshot())); }
      else if (c === 'occ') { log('occupancy', await route.measureOccupancy(drv)); }
      else log('unknown command', c);
    } catch (e) { log('command failed', e.message); }
  }
  await emu.stop();
  process.exit(0);
})();
