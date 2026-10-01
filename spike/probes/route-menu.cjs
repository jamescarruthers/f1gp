// Menu explorer: route.toMainMenu, then a step list as in route-steps.cjs.
//   node route-menu.cjs BUNDLE OUTDIR "k:down;w:500;s:name;..."
const path = require('path');
const fs = require('fs');
const { start, encodePng } = require('../lib/node-emu.cjs');
const route = require('../lib/route.cjs');
(async () => {
  const [bundle, outDir, steps] = process.argv.slice(2);
  fs.mkdirSync(outDir, { recursive: true });
  const emu = await start(bundle);
  const d = route.nodeDriver(emu);
  const save = async (name) => { const img = await d.screenshot(); fs.writeFileSync(path.join(outDir, name + '.png'), encodePng(img.width, img.height, img.data, 4)); const id = route.identify(img); console.log('shot', name, id.screen, JSON.stringify(route.findHighlight(img))); };
  await route.toMainMenu(d, {});
  for (const step of steps.split(';').map((s) => s.trim()).filter(Boolean)) {
    const [op, ...rest] = step.split(':');
    if (op === 'w') await d.sleep(+rest[0]);
    else if (op === 's') await save(rest[0]);
    else if (op === 'k') await d.press(rest[0], +(rest[1] || 120)), await d.sleep(250);
    else if (op === 'd') await d.keyDown(rest[0]);
    else if (op === 'u') await d.keyUp(rest[0]);
    else if (op === 'main') await route.moveHighlight(d, 'main', +rest[0]);
    else if (op === 'm') await d.mouseMove(+rest[0].split(',')[0], +rest[0].split(',')[1]);
    else if (op === 'b') await d.mouseButton(+rest[0], rest[1] === '1');
    else throw new Error('bad step ' + step);
  }
  await emu.stop(); process.exit(0);
})();
