// p2-capture-explore.cjs - one-off exploration for the Phase 2 reference
// frames: what T and D do (screenshots + which bytes of guest RAM change),
// SS:017C, and whether a paused screenshot shows the frame the reader
// calls current or the one before (while the car moves in the pit lane).
//
//   timeout 280 node probes/p2-capture-explore.cjs [--circuit "Great Britain"]
//
// Output: out/p2-ref/_explore/*.png, explore.json
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { start, encodePng, sleep } = require('../lib/node-emu.cjs');
const route = require('../lib/route.cjs');

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const CIRCUIT = opt('circuit', 'Great Britain');
const BUNDLE = opt('bundle', path.join(__dirname, '..', 'dist', 'p2-capture-25000.jsdos'));
const OUT = path.join(__dirname, '..', 'out', 'p2-ref', '_explore');
fs.mkdirSync(OUT, { recursive: true });
const EXTRA = { home: 268, end: 269, pageup: 266, pagedown: 267, delete: 261, insert: 260 };
const code = (k) => (k in EXTRA ? EXTRA[k] : route.JSDOS_KEYS[k]);

(async () => {
  const { attach } = await import(pathToFileURL(path.join(__dirname, '..', 'lib', 'f1gp-mem.mjs')).href);
  const { createReader, readTrack } = await import(pathToFileURL(path.join(__dirname, '..', 'lib', 'f1gp-state.mjs')).href);
  const emu = await start(BUNDLE);
  const drv = route.nodeDriver(emu);
  const result = { circuit: CIRCUIT };
  const log = (...m) => console.log(...m);
  try {
    result.route = await route.toTrack(drv, { circuit: CIRCUIT, log });
    const mem = attach(emu.ci, { requireGame: true });
    const reader = createReader(mem);
    const tap = async (k, ms = 120) => { emu.ci.sendKeyEvent(code(k), true); await sleep(ms); emu.ci.sendKeyEvent(code(k), false); };
    const shot = async (name) => { const img = await emu.ci.screenshot(); fs.writeFileSync(path.join(OUT, `${name}.png`), encodePng(img.width, img.height, img.data, 4)); return img; };
    const snap = () => mem.snapshot(0, 0x100000);
    result.ss017C = mem.ss.u16(0x017c);
    result.ss0130 = mem.ss.s16(0x0130); result.ss0132 = mem.ss.s16(0x0132);
    await sleep(1500);
    await shot('00-start');

    // ---- T and D: bytes that change with the key and stay put otherwise
    const stableDiff = async (key, presses) => {
      const a1 = snap(); await sleep(400); const a2 = snap();
      const noisy = new Uint8Array(0x100000);
      for (let i = 0; i < a1.length; i++) if (a1[i] !== a2[i]) noisy[i] = 1;
      const seq = [a2];
      for (let p = 0; p < presses; p++) {
        await tap(key); await sleep(900);
        const b1 = snap(); await sleep(300); const b2 = snap();
        for (let i = 0; i < b1.length; i++) if (b1[i] !== b2[i]) noisy[i] = 1;
        seq.push(b2);
        await shot(`${key}-${p + 1}`);
      }
      const cands = [];
      for (let i = 0; i < 0x100000; i++) {
        if (noisy[i]) continue;
        let changed = false;
        for (let k = 1; k < seq.length; k++) if (seq[k][i] !== seq[0][i]) changed = true;
        if (changed) cands.push(i);
      }
      const ds = mem.dsLinear, ss = mem.ssLinear;
      return cands.slice(0, 200).map((i) => ({
        lin: i, ds: i >= ds && i < ds + 0x10000 ? `DS:${(i - ds).toString(16)}` : null,
        ss: i >= ss && i < ss + 0x10000 ? `SS:${(i - ss).toString(16)}` : null,
        values: seq.map((s) => s[i]),
      })).concat(cands.length > 200 ? [{ more: cands.length - 200 }] : []);
    };
    result.tDiff = await stableDiff('t', 2);
    log('T candidates', result.tDiff.length, JSON.stringify(result.tDiff.slice(0, 30)));
    result.dDiff = await stableDiff('d', 5);
    log('D candidates', result.dDiff.length, JSON.stringify(result.dDiff.slice(0, 30)));

    // ---- views while standing
    for (const [name, k] of [['chase', 'pagedown'], ['tv', 'left'], ['cockpit', 'right']]) {
      await tap(k); await sleep(1200);
      await shot(`view-${name}`);
    }

    // ---- moving: pause right after a consistent read, keep the last 3 camera states
    const hist = [];
    let lastTick = -1;
    const pollFor = async (ms) => {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        const st = reader.read();
        if (st.tick !== lastTick && st.consistent) {
          lastTick = st.tick;
          hist.push({ tick: st.tick, frame: st.frame, camera: st.camera, view: st.view.raw, mph: st.cars[st.playerSlot].speedMph });
          if (hist.length > 4) hist.shift();
        }
        await sleep(2);
      }
    };
    result.moving = [];
    emu.ci.sendKeyEvent(code('a'), true);
    for (let i = 0; i < 6; i++) {
      if (i === 2) { await tap('pagedown'); }
      if (i === 4) { await tap('left'); }
      await pollFor(1500);
      // wait for the next new consistent frame, then pause at once
      let st;
      for (let k = 0; k < 400; k++) { st = reader.read(); if (st.consistent && st.tick !== lastTick) break; await sleep(1); }
      emu.ci.pause();
      const st2 = reader.read();
      hist.push({ tick: st2.tick, frame: st2.frame, camera: st2.camera, view: st2.view.raw, mph: st2.cars[st2.playerSlot].speedMph });
      await sleep(150);
      const img = await shot(`moving-${i}`);
      const st3 = reader.read();
      result.moving.push({ i, hist: hist.slice(-3), afterShotTick: st3.tick, state: st2 });
      log('moving', i, st2.tick, st2.consistent, st2.view.mode, st2.cars[st2.playerSlot].speedMph, 'mph');
      emu.ci.resume();
      lastTick = st2.tick;
    }
    emu.ci.sendKeyEvent(code('a'), false);
    result.track = readTrack(mem);
    result.ok = true;
  } catch (e) {
    console.error(e);
    result.ok = false; result.error = e.message;
    if (e.lastImage) fs.writeFileSync(path.join(OUT, 'failure.png'), encodePng(e.lastImage.width, e.lastImage.height, e.lastImage.data, 4));
  }
  fs.writeFileSync(path.join(OUT, 'explore.json'), JSON.stringify(result));
  await emu.stop();
  process.exit(result.ok ? 0 : 1);
})();
