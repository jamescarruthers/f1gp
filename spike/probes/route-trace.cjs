// After toTrack, hold A for N s: MPH every 250 ms, screenshot every 1 s.
//   node route-trace.cjs BUNDLE TAG SECONDS
const path = require('path');
const fs = require('fs');
const { start, encodePng } = require('../lib/node-emu.cjs');
const route = require('../lib/route.cjs');
const [bundle, tag, secs] = process.argv.slice(2);
const OUT = path.join(__dirname, '..', 'out', 'route', 'trace', tag);
fs.mkdirSync(OUT, { recursive: true });
(async () => {
  const emu = await start(bundle);
  const d = route.nodeDriver(emu);
  const r = await route.toTrack(d, {});
  console.log('toTrack', r.ms, 'ms');
  await d.keyDown('a');
  const t0 = Date.now(); const trace = [];
  for (let i = 0; i < (+secs || 20) * 4; i++) {
    const img = await d.screenshot();
    trace.push(route.readMph(img));
    if (i % 4 === 0) fs.writeFileSync(path.join(OUT, `t${String(i / 4).padStart(2, '0')}.png`), encodePng(img.width, img.height, img.data, 4));
    await d.sleep(Math.max(0, t0 + (i + 1) * 250 - Date.now()));
  }
  await d.keyUp('a');
  console.log('mph/250ms', JSON.stringify(trace));
  fs.writeFileSync(path.join(OUT, 'trace.json'), JSON.stringify(trace));
  await emu.stop(); process.exit(0);
})();
