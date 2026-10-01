// Boot a bundle without pressing keys; screenshot at given seconds and record
// identify(), the running program, sound level and DOSBox log lines.
//
//   timeout 120 node probes/node-bootshots.cjs BUNDLE TAG 2,5,10,20,40
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { startMany, outDir, route } = require('./node-common.cjs');

const [bundle, tag = 'boot', times = '2,5,10,20'] = process.argv.slice(2);
const { log, save, json, dir } = outDir(tag);

(async () => {
  const t0 = Date.now();
  const emu = await startMany([bundle]);
  const res = [];
  emu.soundLevel();
  for (const s of times.split(',').map(Number)) {
    await new Promise((r) => setTimeout(r, Math.max(0, t0 + s * 1000 - Date.now())));
    const img = await emu.ci.screenshot();
    let prog = null;
    try { prog = await Promise.race([emu.ci.getRunningProgram(), new Promise((r) => setTimeout(() => r('(no answer)'), 1000))]); } catch (e) { prog = 'err ' + e.message; }
    const snd = emu.soundLevel();
    const r = { s, screen: route.identify(img).screen, program: prog, frames: emu.state.frames, soundAcRms: +snd.acRms.toFixed(4), file: path.basename(save(img, `t${String(s).padStart(3, '0')}`)) };
    res.push(r);
    log(r);
  }
  fs.writeFileSync(path.join(dir, 'messages.txt'), emu.state.messages.join('\n'));
  json('summary.json', { bundle, res, messages: emu.state.messages.filter((m) => !/Special file|Parsing command/.test(m)) });
  await emu.stop();
  process.exit(0);
})();
