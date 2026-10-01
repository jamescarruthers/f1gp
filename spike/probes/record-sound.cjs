// Record the emulator's sound output to a WAV file while nothing is pressed
// (for the DOS intro music), with a screenshot every 10 s.
//
//   timeout 200 node probes/record-sound.cjs dist/node-adlib-intro.jsdos out/sound/dos-adlib-intro.wav 150
//
// js-dos pushes mono float samples at the mixer rate (44100 in our bundles).
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { start, sleep } = require('../lib/node-emu.cjs');

const [bundle, outWav, secArg = '150'] = process.argv.slice(2);
const SECONDS = Number(secArg), RATE = 44100;

function writeWav(file, samples, rate) {
  const n = samples.length, buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767))), 44 + i * 2);
  fs.writeFileSync(file, buf);
}

(async () => {
  const emu = await start(bundle);
  const chunks = [];
  let total = 0;
  emu.ci.events().onSoundPush((s) => { chunks.push(Float32Array.from(s)); total += s.length; });
  const t0 = Date.now();
  fs.mkdirSync(path.dirname(outWav), { recursive: true });
  for (let k = 1; total < SECONDS * RATE && Date.now() - t0 < (SECONDS + 40) * 1000; k++) {
    await sleep(1000);
    if (k % 10 === 0) {
      await emu.shot(outWav.replace(/\.wav$/, `-${String(k).padStart(3, '0')}s.png`));
      console.log(`${k} s wall, ${(total / RATE).toFixed(1)} s of sound`);
    }
  }
  const all = new Float32Array(total);
  let o = 0;
  for (const c of chunks) { all.set(c, o); o += c.length; }
  writeWav(outWav, all.subarray(0, Math.min(total, SECONDS * RATE)), RATE);
  console.log('wrote', outWav, (Math.min(total, SECONDS * RATE) / RATE).toFixed(1), 's');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
