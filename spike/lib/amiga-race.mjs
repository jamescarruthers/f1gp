// The Amiga race program's sounds, played from the DOS game's events and
// state: its engine (a looped recording, its speed set every 1/50 s from the
// revs) and its eight sampled effects (docs/amiga-sound.md). The rules are
// the Amiga race program's (f1gp, disk 2); the DOS game runs the same logic
// with the same variables, so the page reads the DOS values and plays the
// Amiga samples:
//
//   DOS (gp.exe, its AdLib driver)            Amiga (f1gp)
//   DS:0948 engine sound state                3CC06h: 0 running, 20h winding
//                                             down, 40h stop, 80h off
//   DS:0054 the engine sound's revs, moved    4A704h, moved by the VBlank
//     towards the car's by the timer          routine 3CC38h
//   driver effect 0 (19ED:2D25)               effect 8, the engine (80922h)
//   driver effect 1 (19ED:2DA2), tyres        effect 6 (9D82Ah)
//   driver effect 2 (0:DB38), pit stop        effect 0, the wheel guns (4B426h)
//   driver effect 3 (0:3F88), kerb            effect 5 (38C6Ah), left or right
//   driver effect 4 (0:B972, 0:BDA5), contact effect 2 (4356Eh, 43946h)
//   driver effect 5 (0:964D), pit stop        effect 7 (46606h)
//   driver effects 6-9 (19ED:2E94), a car     effect 1 or 3 (9D9CEh)
//     passing the TV camera
//
// RaceSound runs on the AudioWorklet thread (lib/amiga-worklet.mjs) with a
// Paula (lib/paula.mjs) reading the "race" block (lib/amiga-disk.mjs).

import { DMACON } from './paula.mjs';

const TABLE = 0x9d79a; // 16 bytes per effect: sample, bytes, period, volume, channel
const TYRE_SAMPLE = 0x8c482, TYRE_END = 0x8e388;

// the DOS tyre volume (es:[12h], from the game's table at DS:2E3F by slip/32)
// back to the slip's middle value, then the Amiga's volume rule
const TYRE_SLIP = { 0: 16, 8: 64, 9: 128, 10: 208, 11: 304, 12: 416, 13: 496 };

export class RaceSound {
  constructor(race, paula, random = Math.random) {
    this.mem = race;
    this.paula = paula;
    this.random = random;
    this.engine = { state: 0x80, revs: 0 };
    this.passSide = 0;  // 8093Ch: the passing sound alternates between channels 3 and 2
    paula.setMemory(race);
  }
  word(a) { const i = a - this.mem.base, b = this.mem.bytes; return (b[i] << 8) | b[i + 1]; }
  long(a) { return ((this.word(a) << 16) | this.word(a + 2)) >>> 0; }
  rand8() { return Math.floor(this.random() * 256); }

  /** The table's entry for an effect. */
  effect(k) {
    const e = TABLE + 16 * k;
    return { sample: this.long(e), bytes: this.long(e + 4), period: this.word(e + 8), volume: this.word(e + 10), channel: this.word(e + 12) };
  }

  // 8084Ch: stop the channel, point it at the sample and start it; channels
  // 1-3 stop after one pass
  play(k, over = {}) {
    const fx = { ...this.effect(k), ...over }, p = this.paula, ch = fx.channel & 3, base = 0xa0 + 16 * ch;
    p.write(DMACON, 1 << ch);
    p.setOneShot(ch, ch !== 0);
    p.write(base, fx.sample, 4);
    p.write(base + 4, fx.bytes >>> 1);
    p.write(base + 8, fx.volume);
    p.write(base + 6, fx.period);
    p.write(DMACON, 0x8000 | (1 << ch));
  }

  /**
   * A DOS driver effect started. param: what the game wrote for it in the
   * driver's parameters (the tyre volume, the kerb's side) or the passing car's speed.
   */
  dosEffect(n, param = {}) {
    switch (n) {
      case 0: this.play(8); break;        // the engine (its period comes with the next tick)
      case 1: this.tyres(param.tyreVolume ?? 0); break;
      case 2: this.play(0); break;        // wheel guns
      case 3: this.play(5, { channel: param.side ? 3 : 1 }); break; // kerb, on the side that hit it
      case 4: this.play(2); break;        // contact
      case 5: this.play(7); break;        // pit stop
      case 6: case 7: case 8: case 9: this.passing(param.speed ?? 0x2000); break;
      default: break;
    }
  }

  /** A DOS driver effect stopped: only the tyres' stop has an Amiga counterpart (9D906h). */
  dosStop(n) {
    if (n === 1) this.paula.write(0xa0 + 16 + 8, 0);
  }

  // 9D82Ah: a random stretch of the tyre noise at a random rate, louder with more slip
  tyres(dosVolume) {
    const slip = TYRE_SLIP[dosVolume] ?? 0;
    const volume = (slip * 0x600 * 4) >> 16;
    const period = 0xc4 + (this.rand8() & 0x1f);
    const sample = TYRE_SAMPLE + this.rand8() * 8;
    let bytes = ((((this.rand8() + 0x100) << 7) * (TYRE_END - sample)) >>> 16) & ~1;
    if (bytes < 0x100) return;
    this.paula.write(0xa0 + 16 + 8, volume);
    this.paula.write(0xa0 + 16 + 6, period);
    this.play(6, { sample, bytes, period, volume });
  }

  // 9D914h: a car passing the camera, lower the faster it goes; one of two
  // recordings, on alternate sides
  passing(speed) {
    const r = this.rand8();
    const k = r & 0x80 ? 3 : 1;
    const period = (Math.max(0x4000 - speed, 0) >> 6) + 0x104 + (r & 0x3f);
    this.passSide ^= 1;
    this.play(k, { period, channel: this.passSide ? 3 : 2 });
  }

  /** The DOS engine sound state (DS:0948) and revs (DS:0054), as the page last read them. */
  setEngine(state, revs) {
    const was = this.engine.state;
    this.engine = { state, revs };
    // the engine stopped: the game silences every channel (808E2h, DOS: driver stop-all)
    const off = (s) => (s & 0x80) !== 0 || (s & 0x40) !== 0;
    if (off(state) && !off(was)) this.paula.allOff();
  }

  /** One VBlank (3CC38h): channel 0's period from the revs. */
  tick() {
    const { state, revs } = this.engine;
    if (state & 0xc0) return;
    let d6 = revs;
    if (state === 0) d6 += this.rand8() & 0x7f; // the running engine's roughness
    let q = Math.floor(7500000 / Math.max(d6, 300));
    if (q >= 2815) q = 2815 + (((this.rand8() << 24) >> 24) >> 1); // idle: a little wander
    const period = Math.max((q * 3840 * 4) >> 16, 128);
    this.paula.write(0xa0 + 6, period);
  }
}
