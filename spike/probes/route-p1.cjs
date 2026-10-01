// Probe 1: boot a bundle and take screenshots every 2 s.
const { start, sleep } = require('/home/user/f1gp/spike/lib/node-emu.cjs');
(async () => {
  const bundle = process.argv[2];
  const outDir = process.argv[3];
  const secs = +(process.argv[4] || 40);
  const emu = await start(bundle, { backend: 'dosbox' });
  const t0 = Date.now();
  for (let t = 2; t <= secs; t += 2) {
    await sleep(t0 + t * 1000 - Date.now());
    await emu.shot(`${outDir}/t${String(t).padStart(3, '0')}.png`);
    console.log(t, 'frames', emu.state.frames, emu.state.width, emu.state.height, JSON.stringify(emu.soundLevel()));
  }
  console.log(emu.state.stdout.join('').slice(-2000));
  console.log(emu.state.messages.slice(-30).join('\n'));
  await emu.stop();
  process.exit(0);
})();
