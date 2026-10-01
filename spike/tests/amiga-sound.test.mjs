// The page's Amiga sound: the disk reader (lib/amiga-disk.mjs), the music
// player port (lib/amiga-music.mjs) against the game's own 68000 code, the
// sound chip (lib/paula.mjs), the race rules (lib/amiga-race.mjs) and the
// DOS driver hook (lib/dos-sound.mjs).
//
//   cd spike && node --test tests/amiga-sound.test.mjs
//
// The music test needs the 68000 reference log, which takes the game's code
// from the disk and runs it on an emulated CPU (Python, Unicorn):
//   python3 amiga/tune-log.py out/amiga/mp/d1/frontend out/amiga/tune-writes.json 7200
//   python3 amiga/tune-log.py out/amiga/mp/d1/frontend out/amiga/tune-fade.json 400 300
// (out/amiga/mp from amiga/adf.py); it skips without them. The hook test
// reads a race RAM capture from out/ and skips without it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { readAdf, soundData, packSound, unpackSound, TUNE, RACE } from '../lib/amiga-disk.mjs';
import { MusicPlayer } from '../lib/amiga-music.mjs';
import { Paula, CLOCK, DMACON } from '../lib/paula.mjs';
import { RaceSound } from '../lib/amiga-race.mjs';

const SPIKE = path.join(import.meta.dirname, '..');
const ADF_DIR = path.join(SPIKE, '..', 'original', 'amiga');
const haveDisks = fs.existsSync(ADF_DIR) && fs.readdirSync(ADF_DIR).some((f) => f.endsWith('.adf'));
let blocks = null;
const data = () => blocks ??= soundData(fs.readdirSync(ADF_DIR).filter((f) => f.endsWith('.adf')).map((f) => new Uint8Array(fs.readFileSync(path.join(ADF_DIR, f)))));
const noDisks = !haveDisks && 'no Amiga disk images in original/amiga';

test('the disks: the tune and race blocks, packed and unpacked', { skip: noDisks }, () => {
  const { tune, race } = data();
  assert.equal(tune.base, TUNE.from); assert.equal(tune.bytes.length, TUNE.to - TUNE.from);
  assert.equal(race.base, RACE.from); assert.equal(race.bytes.length, RACE.to - RACE.from);
  const u = unpackSound(packSound({ tune, race }));
  assert.deepEqual(u.tune.bytes, tune.bytes); assert.deepEqual(u.race.bytes, race.bytes);
  const disk1 = fs.readdirSync(ADF_DIR).map((f) => fs.readFileSync(path.join(ADF_DIR, f))).map((b) => { try { return readAdf(new Uint8Array(b)); } catch { return null; } }).find((a) => a?.volume === 'f1gp_disk_#1');
  assert.ok(disk1.files.some((f) => f.name === 'frontend' && f.size === 127816));
});

function runPlayer(ref) {
  const frames = [];
  let cur = [];
  const p = new MusicPlayer(data().tune, (r, v, z) => cur.push([r, v >>> 0, z]));
  p.start();
  frames.push(cur);
  for (let i = 0; i < ref.ticks; i++) {
    cur = [];
    const f = ref.fade_at;
    if (f != null && i >= f && (i - f) % 2 === 0 && (i - f) / 2 <= 32) p.setLevel(-(i - f));
    p.tick();
    frames.push(cur);
  }
  return frames;
}
for (const [name, file] of [['the opening and a whole loop (144 s)', 'tune-writes.json'], ['a fade', 'tune-fade.json']]) {
  const ref = path.join(SPIKE, 'out', 'amiga', file);
  test(`the music player writes what the game's 68000 code writes: ${name}`, { skip: noDisks || (!fs.existsSync(ref) && `no ${file} (amiga/tune-log.py)`) }, () => {
    const want = JSON.parse(fs.readFileSync(ref));
    const got = runPlayer(want);
    assert.equal(got.length, want.frames.length);
    for (let f = 0; f < got.length; f++) assert.deepEqual(got[f], want.frames[f], `tick ${f}`);
  });
}

test('Paula plays a sample by its period and volume, and a one-shot stops after one pass', () => {
  // a square wave: 16 bytes +100, 16 bytes -100
  const bytes = new Uint8Array(32).map((_, i) => (i < 16 ? 100 : 256 - 100));
  const p = new Paula(48000, { base: 0x1000, bytes });
  p.filter = 'off'; p.setPan(1);
  p.write(0xa0, 0x1000, 4); p.write(0xa4, 16); p.write(0xa6, 200); p.write(0xa8, 64);
  p.write(DMACON, 0x8001);
  const n = 48000, L = new Float32Array(n), R = new Float32Array(n);
  p.render(L, R, n);
  // the wave's frequency: CLOCK / (period * 32 bytes)
  let crossings = 0;
  for (let i = 1000; i < n; i++) if (L[i - 1] < 0 && L[i] >= 0) crossings++;
  const want = (CLOCK / (200 * 32)) * ((n - 1000) / 48000);
  assert.ok(Math.abs(crossings - want) <= 2, `${crossings} cycles, want ${want.toFixed(1)}`);
  assert.ok(Math.max(...R.map(Math.abs)) < 1e-6, 'channel 0 is the left output');
  // one-shot: the same sample stops after its 32 bytes
  const q = new Paula(48000, { base: 0x1000, bytes });
  q.filter = 'off';
  q.setOneShot(1, true);
  q.write(0xb0, 0x1000, 4); q.write(0xb4, 16); q.write(0xb6, 200); q.write(0xb8, 64);
  q.write(DMACON, 0x8002);
  const L2 = new Float32Array(4800), R2 = new Float32Array(4800);
  q.render(L2, R2, 4800);
  assert.equal(q.ch[1].on, false);
  const end = Math.ceil((32 * 200 * 48000) / CLOCK);
  assert.ok(Math.max(...R2.slice(end + 200).map(Math.abs)) < 0.02, 'silent after the pass');
});

test('Paula takes a new loop at the end of the buffer playing', () => {
  const bytes = new Uint8Array(64);
  bytes.fill(50, 0, 32); bytes.fill(256 - 50, 32, 64);
  const p = new Paula(48000, { base: 0, bytes });
  p.write(0xa0, 0, 4); p.write(0xa4, 16); p.write(0xa6, 300); p.write(0xa8, 64);
  p.write(DMACON, 0x8001);
  p.write(0xa0, 32, 4); // queued: plays after the first 32 bytes
  const L = new Float32Array(2000), R = new Float32Array(2000);
  p.render(L, R, 2000);
  assert.equal(p.ch[0].lc, 32);
  assert.ok(p.ch[0].ptr >= 32 && p.ch[0].ptr <= 64, 'playing the new loop');
});

test('the Amiga engine: its period from the revs, idle wander below 2,664 rpm', { skip: noDisks }, () => {
  const p = new Paula(48000);
  const race = new RaceSound(data().race, p, () => 0.5); // random byte 128: +0 (bit 7 set, &7Fh = 0), wander -64
  race.dosEffect(0);
  assert.equal(p.ch[0].lc, 0x984f2); assert.equal(p.ch[0].len, 21160 / 2); assert.equal(p.ch[0].vol, 40);
  assert.equal(p.ch[0].oneShot, false, 'the engine loops');
  race.setEngine(0, 3000);
  race.tick();
  // q = 7,500,000 / 3,000 = 2,500; period = 2,500 * 3,840 * 4 >> 16 = 585
  assert.equal(p.ch[0].per, 585);
  race.setEngine(0, 1000);
  race.tick();
  // q = 7,500 >= 2,815: idle, 2,815 + (-128 >> 1) = 2,751; period 644
  assert.equal(p.ch[0].per, 644);
  // the engine stops: every channel off
  race.setEngine(0x81, 1000);
  assert.equal(p.ch[0].on, false);
});

test('the Amiga effects: kerb side, passing pitch and side, tyre volume', { skip: noDisks }, () => {
  const p = new Paula(48000);
  const race = new RaceSound(data().race, p, () => 0.25); // random byte 64
  race.dosEffect(3, { side: 1 });
  assert.equal(p.ch[3].lc, 0x80a46, 'kerb: effect 5 on channel 3 (left)');
  race.dosEffect(3, { side: 0 });
  assert.equal(p.ch[1].lc, 0x80a46, 'kerb: channel 1 (right)');
  assert.ok(p.ch[1].oneShot);
  race.dosEffect(6, { speed: 0x3000 });
  // effect 1 (byte 64: bit 7 clear) on channel 3, period (4000h - 3000h) >> 6 + 104h + (64 & 3Fh) = 144h
  assert.equal(p.ch[3].lc, 0x82a62); assert.equal(p.ch[3].per, 0x144);
  race.dosEffect(7, { speed: 0x3000 });
  assert.equal(p.ch[2].lc, 0x82a62, 'the next pass on the other side');
  race.dosEffect(1, { tyreVolume: 12 });
  // slip 416: volume 416 * 6144 >> 16 = 39; period C4h + (64 & 1Fh)
  assert.equal(p.ch[1].vol, 39); assert.equal(p.ch[1].per, 0xc4);
  assert.equal(p.ch[1].lc, 0x8c482 + 64 * 8);
  race.dosStop(1);
  assert.equal(p.ch[1].vol, 0);
});

test('the DOS driver hook: present in a race, puts its jumps in and takes them out', async (t) => {
  const RAM = path.join(SPIKE, 'out', 'research-phase3', 'cars', 'cap', 'grid1', 'g-rchase.ram');
  if (!fs.existsSync(RAM)) { t.skip('no RAM capture in out/'); return; }
  const { fromRam } = await import('../lib/f1gp-mem.mjs');
  const { driverHook, engineSound, soundFlags } = await import('../lib/dos-sound.mjs');
  const mem = fromRam(new Uint8Array(fs.readFileSync(RAM)), { imageSeg: 0x1a2 });
  const H = mem.heap(), base = (0x8ce6 + 0x1a2) << 4;
  const before = H.slice(base, base + 0x1c40);
  const hook = driverHook(mem);
  assert.equal(hook.present, true);
  assert.equal(hook.installed, false);
  assert.equal(hook.install(), true);
  assert.equal(hook.installed, true);
  assert.deepEqual(Array.from(H.subarray(base + 0x532, base + 0x535)), [0xe9, (0x1bd0 - 0x535) & 0xff, (0x1bd0 - 0x535) >> 8]);
  assert.equal(hook.take().starts.reduce((a, b) => a + b), 0);
  H[base + 0x1c00 + 4]++; H[base + 0x1c10 + 1] += 2; // what the stubs do: effect 4 started, effect 1 stopped twice
  const d = hook.take();
  assert.equal(d.starts[4], 1); assert.equal(d.stops[1], 2);
  hook.uninstall();
  assert.deepEqual(H.subarray(base + 0x500, base + 0x600), before.subarray(0x500, 0x600));
  const e = engineSound(mem);
  assert.ok(e.revs >= 500 && e.revs <= 15000, `revs ${e.revs}`);
  assert.equal(soundFlags(mem).on, true, 'SS:018E = 0 in a race');
});
