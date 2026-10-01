// Record the DOS game's engine sound while the autopilot drives a practice
// lap, with the player's revs, gear and speed every game frame, timed by the
// sound's own sample count (so another engine model can be played against
// the same revs).
//
//   timeout 260 node probes/record-engine.mjs [--bundle dist/node-adlib-intro.jsdos]
//     [--circuit Italy] [--seconds 75] [--tag adlib-monza] [--mode practice|quickrace]
//
// --mode quickrace records from the green light of a Monza Quick Race, among
// the other cars (passing cars, contact, kerbs).
//
// Output, out/sound/engine-<tag>/: sound.wav (mono, 44.1 kHz), frames.jsonl
// ({ sample, tick, rpm, gear, mph, inPit } per game frame), log.txt.
// The autopilot is the one in probes/p1-accuracy-run.cjs (copied).

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { attach } from '../lib/f1gp-mem.mjs';
import { createReader, readTrack } from '../lib/f1gp-state.mjs';

const require = createRequire(import.meta.url);
const { start, sleep } = require('../lib/node-emu.cjs');
const route = require('../lib/route.cjs');
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const BUNDLE = opt('bundle', 'dist/node-adlib-intro.jsdos');
const CIRCUIT = opt('circuit', 'Italy');
const SECONDS = +opt('seconds', 75);
const TAG = opt('tag', 'adlib-monza');
const MODE = opt('mode', 'practice');
const OUT = path.join(import.meta.dirname, '..', 'out', 'sound', `engine-${TAG}`);
fs.mkdirSync(OUT, { recursive: true });
const T0 = Date.now();
const logf = path.join(OUT, 'log.txt');
fs.writeFileSync(logf, '');
const log = (...m) => { const s = `[${((Date.now() - T0) / 1000).toFixed(1)}] ${m.join(' ')}`; console.log(s); fs.appendFileSync(logf, s + '\n'); };
const RATE = 44100;
const ALAT = 55, BRAKE = 70, LAG = 0.25, DEADBAND = 300;
const wrap16 = (v) => ((v + 0x8000) & 0xffff) - 0x8000;

function writeWav(file, samples) {
  const n = samples.length, buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(RATE, 24); buf.writeUInt32LE(RATE * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767))), 44 + i * 2);
  fs.writeFileSync(file, buf);
}

const emu = await start(path.resolve(BUNDLE));
const chunks = [];
let total = 0, recording = false;
emu.ci.events().onSoundPush((s) => { if (recording) { chunks.push(Float32Array.from(s)); total += s.length; } });
const held = new Set();
const code = (k) => route.JSDOS_KEYS[k];
const down = (k) => { if (!held.has(k)) { held.add(k); emu.ci.sendKeyEvent(code(k), true); } };
const up = (k) => { if (held.has(k)) { held.delete(k); emu.ci.sendKeyEvent(code(k), false); } };
try {
  await route.toTrack(route.nodeDriver(emu), MODE === 'quickrace' ? { mode: 'quickrace', log } : { circuit: CIRCUIT, log });
  const mem = attach(emu.ci, { requireGame: true });
  const reader = createReader(mem);
  const track = readTrack(mem);
  const n = track.lapSegments;
  const player = reader.read().playerSlot;
  const fd = fs.openSync(path.join(OUT, 'frames.jsonl'), 'w');
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
    if (vft < allowed * 0.97) { down('a'); up('z'); } else if (vft > allowed * 1.07) { down('z'); up('a'); } else { up('a'); up('z'); }
  };
  recording = true;
  log('recording');
  while (total < SECONDS * RATE && Date.now() - T0 < 250000) {
    const tick = mem.ds.u32(0x2955);
    if (tick !== lastTick) {
      const st = reader.read();
      if (st.consistent) {
        lastTick = tick;
        const c = st.cars[player];
        fs.writeSync(fd, JSON.stringify({ sample: total, tick: st.tick, frame: st.frame, rpm: c.rpm, gear: c.gear, mph: c.speedMph, inPit: c.inPit, idx: c.trackIndex }) + '\n');
        if (st.inSession && !st.paused) control(st);
      }
    }
    await sleep(2);
  }
  recording = false;
  for (const k of [...held]) up(k);
  const all = new Float32Array(total);
  let o = 0;
  for (const c of chunks) { all.set(c, o); o += c.length; }
  writeWav(path.join(OUT, 'sound.wav'), all);
  log('wrote', (total / RATE).toFixed(1), 's of sound');
} catch (e) {
  log('error', e?.stack ?? e);
} finally {
  process.exit(0);
}
