// Phase 2 prototype: park the car on the grid, switch to chase view, pause
// the emulator, and project the road edges from the game's segment array
// with the game's projection onto the game's own frame.
//
//   timeout 200 node probes/p2-proto.cjs dist/route-g-25000.jsdos
//
// Output: out/p2-proto/{view}.png (game frame), {view}-overlay.png, {view}.json

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { start, encodePng, sleep } = require('../lib/node-emu.cjs');
const route = require('../lib/route.cjs');

const OUT = path.join(__dirname, '..', 'out', 'p2-proto');
const EXTRA = { pagedown: 267, delete: 261, home: 268 };

(async () => {
  const { attach } = await import(pathToFileURL(path.join(__dirname, '..', 'lib', 'f1gp-mem.mjs')).href);
  const { createReader, readTrack } = await import(pathToFileURL(path.join(__dirname, '..', 'lib', 'f1gp-state.mjs')).href);
  const emu = await start(process.argv[2] || path.join(__dirname, '..', 'dist', 'route-g-25000.jsdos'));
  const drv = route.nodeDriver(emu);
  await route.toTrack(drv, { mode: 'quickrace' });
  const mem = attach(emu.ci);
  const reader = createReader(mem);
  const tap = async (code) => { emu.ci.sendKeyEvent(code, true); await sleep(120); emu.ci.sendKeyEvent(code, false); };

  const views = [
    { name: 'chase', key: EXTRA.pagedown },
    { name: 'tv', key: route.JSDOS_KEYS.left },
    { name: 'cockpit', key: route.JSDOS_KEYS.right },
  ];
  for (const v of views) {
    await tap(v.key);
    await sleep(2500);
    // stop the emulator between frames: wait for a consistent read
    let st;
    for (let k = 0; k < 400; k++) { st = reader.read(); if (st.consistent) break; await sleep(2); }
    emu.ci.pause();
    await sleep(200);
    st = reader.read();
    const track = readTrack(mem);
    const img = await emu.ci.screenshot();
    fs.writeFileSync(path.join(OUT, `${v.name}.png`), encodePng(img.width, img.height, img.data, 4));
    fs.writeFileSync(path.join(OUT, `${v.name}.json`), JSON.stringify({ state: st, track }, null, 0));
    console.log(v.name, JSON.stringify({ tick: st.tick, consistent: st.consistent, view: st.view, camera: st.camera }));
    emu.ci.resume();
  }
  await emu.stop();
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
