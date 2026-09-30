// Step probe: node route-steps.cjs BUNDLE OUTDIR "step;step;..."
// steps: w:MS (sleep), s:NAME (screenshot), k:KEY[:HOLDMS] (press key),
//        d:KEY (key down), u:KEY (key up), m:X,Y (mouse abs), b:BTN:0|1,
//        t:TEXT (type), shots:N:MS:PREFIX (N screenshots every MS)
const { start, sleep, KEYS } = require('/home/user/f1gp/spike/lib/node-emu.cjs');
(async () => {
  const [bundle, outDir, stepStr] = process.argv.slice(2);
  const emu = await start(bundle, { backend: process.env.BACKEND || 'dosbox' });
  const t0 = Date.now();
  const ts = () => ((Date.now() - t0) / 1000).toFixed(1);
  for (const step of stepStr.split(';').map((s) => s.trim()).filter(Boolean)) {
    const [op, ...rest] = step.split(':');
    if (op === 'w') await sleep(+rest[0]);
    else if (op === 's') { await emu.shot(`${outDir}/${rest[0]}.png`); console.log(ts(), 'shot', rest[0], 'frames', emu.state.frames); }
    else if (op === 'k') { await emu.press(rest[0], +(rest[1] || 120)); console.log(ts(), 'key', rest[0]); }
    else if (op === 'd') emu.ci.sendKeyEvent(KEYS[rest[0]], true);
    else if (op === 'u') emu.ci.sendKeyEvent(KEYS[rest[0]], false);
    else if (op === 'm') { const [x, y] = rest[0].split(',').map(Number); emu.ci.sendMouseMotion(x, y); }
    else if (op === 'r') { const [x, y] = rest[0].split(',').map(Number); emu.ci.sendMouseRelativeMotion(x, y); }
    else if (op === 'b') emu.ci.sendMouseButton(+rest[0], rest[1] === '1');
    else if (op === 't') await emu.type(rest.join(':'));
    else if (op === 'shots') {
      const [n, ms, prefix] = rest;
      for (let i = 0; i < +n; i++) { await sleep(+ms); await emu.shot(`${outDir}/${prefix}${String(i).padStart(3, '0')}.png`); }
      console.log(ts(), 'shots done', prefix, 'frames', emu.state.frames);
    } else throw new Error('bad step ' + step);
  }
  console.log('snd', JSON.stringify(emu.soundLevel()), 'exited', emu.state.exited);
  await emu.stop();
  process.exit(0);
})();
