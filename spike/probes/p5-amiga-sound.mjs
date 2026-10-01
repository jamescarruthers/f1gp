// Check the DOS sound events the page's Amiga sound plays from
// (lib/dos-sound.mjs): boot the game, note which driver is in the sound
// driver's buffer in the menus, start a Monza Quick Race, put the hook in,
// let the autopilot drive, and log every effect the game starts or stops
// (with its parameters) and every change of the engine sound's state.
//
//   timeout 300 node probes/p5-amiga-sound.mjs [--bundle dist/node-adlib-intro.jsdos] [--seconds 60] [--view tv]
//
// --view tv switches to the TV view (Left) at the green light, where the game
// plays its passing-car sounds.
//
// Output, out/sound/p5-amiga/: events.jsonl, summary.json, log.txt.
// The autopilot is the one in probes/record-engine.mjs.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { attach } from '../lib/f1gp-mem.mjs';
import { createReader, readTrack } from '../lib/f1gp-state.mjs';
import { driverHook, engineSound, passingSpeed } from '../lib/dos-sound.mjs';

const require = createRequire(import.meta.url);
const { start, sleep } = require('../lib/node-emu.cjs');
const route = require('../lib/route.cjs');
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const BUNDLE = opt('bundle', 'dist/node-adlib-intro.jsdos');
const SECONDS = +opt('seconds', 60);
const VIEW = opt('view', 'cockpit');
const OUT = path.join(import.meta.dirname, '..', 'out', 'sound', `p5-amiga-${VIEW}`);
fs.mkdirSync(OUT, { recursive: true });
const T0 = Date.now();
const logf = path.join(OUT, 'log.txt');
fs.writeFileSync(logf, '');
const log = (...m) => { const s = `[${((Date.now() - T0) / 1000).toFixed(1)}] ${m.join(' ')}`; console.log(s); fs.appendFileSync(logf, s + '\n'); };
const evf = fs.openSync(path.join(OUT, 'events.jsonl'), 'w');
const event = (e) => fs.writeSync(evf, JSON.stringify({ t: +((Date.now() - T0) / 1000).toFixed(2), ...e }) + '\n');
const ALAT = 55, BRAKE = 70, LAG = 0.25, DEADBAND = 300;
const wrap16 = (v) => ((v + 0x8000) & 0xffff) - 0x8000;

const emu = await start(path.resolve(BUNDLE));
let mem = null, reader = null, hook = null, screen = 'boot';
const summary = { starts: Array(16).fill(0), stops: Array(16).fill(0), presentIn: {}, engineStates: {}, firstEngineStart: null };
let lastEngine = null;
const watch = setInterval(() => {
  try {
    if (!mem) { const m = attach(emu.ci, { requireGame: true }); if (!m.checked) return; mem = m; reader = createReader(m); hook = driverHook(m); log('attached'); }
    const present = hook.present;
    summary.presentIn[screen] = (summary.presentIn[screen] ?? 0) + (present ? 1 : 0);
    if (present && !hook.installed && hook.install()) { log('hook in', screen); event({ type: 'hook', screen }); }
    const eng = engineSound(mem);
    if (!lastEngine || eng.state !== lastEngine.state) { event({ type: 'engine', screen, ...eng }); summary.engineStates[eng.state] = (summary.engineStates[eng.state] ?? 0) + 1; }
    lastEngine = eng;
    const d = hook.take();
    if (d) {
      const p = hook.params();
      d.starts.forEach((n, k) => { if (n) { summary.starts[k] += n; event({ type: 'start', n: k, times: n, screen, ...p, passing: k >= 6 ? passingSpeed(mem) : undefined, engine: eng }); if (k === 0 && summary.firstEngineStart === null) summary.firstEngineStart = screen; } });
      d.stops.forEach((n, k) => { if (n) { summary.stops[k] += n; event({ type: 'stop', n: k, times: n, screen, engine: eng }); } });
    }
  } catch { /* gp.exe not loaded yet */ }
}, 20);

const held = new Set();
const code = (k) => route.JSDOS_KEYS[k];
const down = (k) => { if (!held.has(k)) { held.add(k); emu.ci.sendKeyEvent(code(k), true); } };
const up = (k) => { if (held.has(k)) { held.delete(k); emu.ci.sendKeyEvent(code(k), false); } };
try {
  await route.toTrack(route.nodeDriver(emu), { mode: 'quickrace', log, onScreen: async (s) => { screen = s; event({ type: 'screen', screen: s }); } });
  screen = 'driving';
  if (VIEW === 'tv') { emu.ci.sendKeyEvent(code('left'), true); await sleep(80); emu.ci.sendKeyEvent(code('left'), false); log('TV view'); }
  const track = readTrack(mem);
  const n = track.lapSegments;
  const player = reader.read().playerSlot;
  let prevHead = null, prevTick = null, lastTick = -1;
  const control = (st) => {
    const c = st.cars[player];
    const vft = c.speed / 64;
    if (c.inPit || !track.lap[c.trackIndex] || c.retired) { down('a'); up('z'); up('comma'); up('period'); prevHead = null; return; }
    const si = c.trackIndex;
    const look = Math.max(3, Math.min(14, Math.round(3 + (vft * 0.45) / 16)));
    const tgt = track.lap[(si + look) % n].centre;
    const desired = Math.round((Math.atan2(tgt[0] - c.x, tgt[1] - c.y) / (2 * Math.PI)) * 65536);
    const err = wrap16(desired - c.heading);
    let rate = 0;
    if (prevHead !== null) rate = wrap16(c.heading - prevHead) / Math.max(0.02, (st.tick - prevTick) / 1000);
    prevHead = c.heading; prevTick = st.tick;
    const pred = err - rate * LAG;
    if (pred > DEADBAND) { down('period'); up('comma'); } else if (pred < -DEADBAND) { down('comma'); up('period'); } else { up('comma'); up('period'); }
    let allowed = 1e9;
    const done = Math.max(0, Math.min(1, c.fraction / 0x4000));
    for (let k = 0; k <= 45; k++) {
      const a0 = track.lap[(si + k - 1 + n) % n].heading, a1 = track.lap[(si + k + 2) % n].heading;
      const curv = Math.abs(wrap16(a1 - a0)) / 3;
      if (curv < 8) continue;
      const R = 16 / ((curv * 2 * Math.PI) / 65536);
      const va = Math.sqrt(ALAT * R + 2 * BRAKE * Math.max(0, (k - done) * 16));
      if (va < allowed) allowed = va;
    }
    // a little faster than the safe speed, for some tyre squeal and kerbs
    if (vft < allowed * 1.05) { down('a'); up('z'); } else if (vft > allowed * 1.15) { down('z'); up('a'); } else { up('a'); up('z'); }
  };
  const t1 = Date.now();
  while (Date.now() - t1 < SECONDS * 1000) {
    const tick = mem.ds.u32(0x2955);
    if (tick !== lastTick) {
      const st = reader.read();
      if (st.consistent) { lastTick = tick; if (st.inSession && !st.paused) control(st); }
    }
    await sleep(2);
  }
  for (const k of [...held]) up(k);
  log('starts', JSON.stringify(summary.starts), 'stops', JSON.stringify(summary.stops));
} catch (e) {
  log('error', e?.stack ?? e);
} finally {
  clearInterval(watch);
  fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(summary, null, 1));
  log('summary', JSON.stringify(summary));
  process.exit(0);
}
