// Shared helpers for the probes/node-*.cjs checks.
//
// startMany(entries, opts) is a copy of lib/node-emu.cjs start() that accepts
// several js-dos init entries (e.g. [bundle, persistedChanges]) instead of one
// bundle path. lib/node-emu.cjs is not edited; requiring it only sets up
// global.emulators (the js-dos engine loaded in Node).
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const nodeEmu = require('../lib/node-emu.cjs');
const route = require('../lib/route.cjs');

const { encodePng, KEYS, sleep } = nodeEmu;
const emulators = global.emulators;

async function startMany(entries, { backend = 'dosbox' } = {}) {
  const init = entries.map((e) => (typeof e === 'string' ? new Uint8Array(fs.readFileSync(e)) : e));
  const ci = backend === 'dosboxX' ? await emulators.dosboxXNode(init) : await emulators.dosboxNode(init);
  const state = {
    ci, width: 0, height: 0, frames: 0,
    soundSamples: 0, soundSumSq: 0, soundPeak: 0, soundSum: 0, soundChanges: 0, soundPrev: 0,
    stdout: [], messages: [], exited: false,
  };
  const ev = ci.events();
  ev.onFrameSize((w, h) => { state.width = w; state.height = h; });
  ev.onFrame(() => { state.frames++; });
  ev.onSoundPush((samples) => {
    state.soundSamples += samples.length;
    for (let i = 0; i < samples.length; i++) {
      const s = samples[i];
      state.soundSumSq += s * s;
      state.soundSum += s;
      if (Math.abs(s - state.soundPrev) > 0.01) state.soundChanges++;
      state.soundPrev = s;
      const a = Math.abs(s);
      if (a > state.soundPeak) state.soundPeak = a;
    }
  });
  ev.onStdout((m) => state.stdout.push(m));
  ev.onMessage((t, ...args) => state.messages.push([t, ...args].join(' ')));
  ev.onExit(() => { state.exited = true; });
  const api = {
    ci, state, KEYS, sleep,
    async shot(file) {
      const img = await ci.screenshot();
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, encodePng(img.width, img.height, img.data, 4));
      return file;
    },
    async press(key, ms = 120) {
      const code = typeof key === 'number' ? key : KEYS[key];
      if (code === undefined) throw new Error(`unknown key ${key}`);
      ci.sendKeyEvent(code, true);
      await sleep(ms);
      ci.sendKeyEvent(code, false);
      await sleep(60);
    },
    // rms includes any DC offset; acRms is the RMS around the mean (what you
    // hear); changes = samples that differ from the previous one by > 0.01.
    soundLevel() {
      const n = state.soundSamples || 1;
      const mean = state.soundSum / n;
      const rms = Math.sqrt(state.soundSumSq / n);
      const out = { samples: state.soundSamples, rms, peak: state.soundPeak, mean,
        acRms: Math.sqrt(Math.max(0, state.soundSumSq / n - mean * mean)), changes: state.soundChanges };
      state.soundSamples = 0; state.soundSumSq = 0; state.soundPeak = 0; state.soundSum = 0; state.soundChanges = 0;
      return out;
    },
    async stop() { try { await ci.exit(); } catch { /* already gone */ } },
  };
  return api;
}

// Output folder helper: out/node-probes/<tag>/, with log(), save(img, name), json(name, obj).
function outDir(tag) {
  const dir = path.join(__dirname, '..', 'out', 'node-probes', tag);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'log.txt'), '');
  const t0 = Date.now();
  const log = (...m) => {
    const line = `[${((Date.now() - t0) / 1000).toFixed(1)}s] ` + m.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
    console.log(line);
    fs.appendFileSync(path.join(dir, 'log.txt'), line + '\n');
  };
  const save = (img, name) => {
    const file = path.join(dir, `${name}.png`);
    fs.writeFileSync(file, encodePng(img.width, img.height, img.data, 4));
    return file;
  };
  const json = (name, obj) => fs.writeFileSync(path.join(dir, name), JSON.stringify(obj, null, 1));
  return { dir, log, save, json, t0 };
}

// Press a sequence of keys, screenshot after each, e.g. ['down', 'down', 'enter'].
async function keySeq(drv, keys, { gap = 600, save, prefix = 'k' } = {}) {
  let i = 0;
  for (const k of keys) {
    if (k.startsWith('wait:')) { await drv.sleep(Number(k.slice(5))); continue; }
    await drv.press(k, 120);
    await drv.sleep(gap);
    if (save) save(await drv.screenshot(), `${prefix}${String(i++).padStart(2, '0')}-${k}`);
  }
}

// Wait until the screen stops changing (two screenshots `gap` apart differ by < thr).
async function settle(drv, { gap = 300, thr = 0.002, timeout = 8000 } = {}) {
  const t0 = Date.now();
  let a = await drv.screenshot();
  while (Date.now() - t0 < timeout) {
    await drv.sleep(gap);
    const b = await drv.screenshot();
    if (route.frameDiff(a, b) < thr) return b;
    a = b;
  }
  return a;
}

// Walk the fsTree into a flat list of { path, size }.
function flatTree(node, prefix = '') {
  const out = [];
  const name = node.name || '';
  const p = prefix ? `${prefix}/${name}` : name;
  if (node.nodes) for (const c of node.nodes) out.push(...flatTree(c, p));
  else out.push({ path: p, size: node.size });
  return out;
}

module.exports = { startMany, outDir, keySeq, settle, flatTree, route, encodePng, KEYS, sleep, emulators };
