// Controlled steering check: same preamble, then coast holding nothing /
// comma / period; screenshots every 400 ms.  node route-steer2.cjs BUNDLE none|comma|period
const path = require('path');
const fs = require('fs');
const { start, encodePng } = require('../lib/node-emu.cjs');
const route = require('../lib/route.cjs');
const key = process.argv[3];
const OUT = path.join(__dirname, '..', 'out', 'route', 'steer', 'ab-' + key);
fs.mkdirSync(OUT, { recursive: true });
const save = (img, name) => fs.writeFileSync(path.join(OUT, name + '.png'), encodePng(img.width, img.height, img.data, 4));
(async () => {
  const emu = await start(process.argv[2]);
  const d = route.nodeDriver(emu);
  await route.toTrack(d, {});
  await d.keyDown('a'); await d.sleep(+(process.env.PRE || 4000));
  if (key !== 'none') await d.keyDown(key);
  const mph = [];
  for (let i = 0; i <= 8; i++) { const img = await d.screenshot(); save(img, `t${i * 250}`); mph.push(route.readMph(img)); await d.sleep(250); }
  if (key !== 'none') await d.keyUp(key);
  await d.keyUp('a');
  console.log(key, 'mph', JSON.stringify(mph));
  await emu.stop(); process.exit(0);
})();
