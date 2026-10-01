// p1-accuracy-warp.cjs - can the emulator run faster than real time?
//
// DOSBox (js-dos) paces emulated time by performance.now() (wdosbox.js:
// _emscripten_get_now = () => performance.now()). Scaling that clock by W
// makes DOSBox run W emulated ms per real ms, as long as the host keeps up
// (it executes `cycles` instructions per emulated ms either way, so the
// guest sees the same machine). This probe routes to a Quick Race with the
// warp on and measures the game clock DS:2955 against wall time.
//
//   timeout 120 node probes/p1-accuracy-warp.cjs --warp 2 --bundle dist/p1-accuracy-25000.jsdos --seconds 20
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : dflt; };
const WARP = +opt('warp', 2);
const SECONDS = +opt('seconds', 20);
const BUNDLE = opt('bundle', path.join(__dirname, '..', 'dist', 'p1-accuracy-25000.jsdos'));
const OUT = path.join(__dirname, '..', 'out', 'p1-accuracy', 'warp');
fs.mkdirSync(OUT, { recursive: true });

const realNow = performance.now.bind(performance);
const base = realNow();
performance.now = () => base + (realNow() - base) * WARP;

const { start } = require('../lib/node-emu.cjs');
const route = require('../lib/route.cjs');

(async () => {
  const { attach } = await import(pathToFileURL(path.join(__dirname, '..', 'lib', 'f1gp-mem.mjs')).href);
  const T0 = Date.now();
  const emu = await start(BUNDLE);
  const drv = route.nodeDriver(emu);
  const res = { warp: WARP, bundle: path.basename(BUNDLE) };
  try {
    await route.toTrack(drv, { mode: 'quickrace', log: (m) => console.log(m) });
    res.routeSec = (Date.now() - T0) / 1000;
    const mem = attach(emu.ci, { requireGame: true });
    const samples = [];
    const w0 = Date.now(), k0 = mem.ds.u32(0x2955);
    let frames = 0, last = k0;
    while (Date.now() - w0 < SECONDS * 1000) {
      await drv.sleep(5);
      const k = mem.ds.u32(0x2955);
      if (k !== last) { frames++; last = k; }
      if (samples.length === 0 || Date.now() - samples[samples.length - 1].w >= 1000) samples.push({ w: Date.now(), k });
    }
    const w1 = Date.now(), k1 = mem.ds.u32(0x2955);
    res.wallSec = (w1 - w0) / 1000;
    res.gameSec = (k1 - k0) / 1000;
    res.ratio = +(res.gameSec / res.wallSec).toFixed(3);
    res.framesSeen = frames;
    res.perSecond = samples.slice(1).map((s, i) => +((s.k - samples[i].k) / (s.w - samples[i].w)).toFixed(3));
    // occupancy with O held (game's own CPU-use figure, emulated)
    res.occupancy = await route.measureOccupancy(drv, { samples: 3, interval: 300 });
    await emu.shot(path.join(OUT, `w${WARP}-${path.basename(BUNDLE, '.jsdos')}.png`));
  } catch (e) { res.error = e.message; }
  console.log(JSON.stringify(res));
  fs.writeFileSync(path.join(OUT, `w${WARP}-${path.basename(BUNDLE, '.jsdos')}.json`), JSON.stringify(res, null, 1));
  await emu.stop();
  process.exit(0);
})();
