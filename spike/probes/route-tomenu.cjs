// Run route.toMainMenu or route.toTrack on a bundle and report screens/time.
//   node route-tomenu.cjs BUNDLE [menu|track|quickrace] [node|ci] [--noSkipIntro] [--backend dosboxX]
const path = require('path');
const fs = require('fs');
const { start, encodePng } = require('../lib/node-emu.cjs');
const route = require('../lib/route.cjs');
const [bundle, what = 'menu', drvType = 'node'] = process.argv.slice(2);
const bi = process.argv.indexOf('--backend');
const OUT = path.join(__dirname, '..', 'out', 'route', 'tomenu', path.basename(bundle, '.jsdos') + '-' + what + '-' + drvType);
fs.mkdirSync(OUT, { recursive: true });
(async () => {
  const t0 = Date.now();
  const emu = await start(bundle, { backend: bi > 0 ? process.argv[bi + 1] : 'dosbox' });
  const d = drvType === 'ci' ? route.ciDriver(emu.ci) : route.nodeDriver(emu);
  let k = 0;
  const opts = {
    log: (m) => console.log(m),
    skipIntro: !process.argv.includes('--noSkipIntro'),
    onScreen: async (name, img) => fs.writeFileSync(path.join(OUT, `${String(k++).padStart(2, '0')}-${name}.png`), encodePng(img.width, img.height, img.data, 4)),
  };
  let ok = true;
  try {
    const r = what === 'menu' ? await route.toMainMenu(d, opts) : await route.toTrack(d, { ...opts, mode: what === 'quickrace' ? 'quickrace' : 'practice' });
    console.log('DONE', what, 'in', (r.ms / 1000).toFixed(1), 's; screens', r.screens.join(' > '));
  } catch (e) {
    ok = false; console.log('FAILED', e.message);
    if (e.lastImage) fs.writeFileSync(path.join(OUT, 'failure.png'), encodePng(e.lastImage.width, e.lastImage.height, e.lastImage.data, 4));
  }
  console.log('process', (Date.now() - t0) / 1000, 's');
  await emu.stop(); process.exit(ok ? 0 : 1);
})();
