// The Amiga title tune's music player, ported from the game's own 68000
// code ("music.unit" in frontend, 8B790h-8BD46h; docs/amiga-sound.md). It
// reads the song from the game's data (lib/amiga-disk.mjs, the "tune" block)
// and drives a sound chip (lib/paula.mjs) through its registers, 50 times a
// second as the front end's VBlank interrupt does.
//
//   const p = new MusicPlayer(tune, (reg, value, size) => paula.write(reg, value, size));
//   p.start();            // song 1, the title tune
//   every 1/50 s: p.tick();
//   p.setLevel(-10);      // 0 to -64, taken from every volume (the front end's fade)
//   p.stop();
//
// The port keeps the original's order of register writes, so a log of them
// can be checked against the 68000 code run on an emulated CPU
// (tests/amiga-music.test.mjs). Field names follow the channel record the
// code keeps at 8BD66h (44h bytes per channel; offsets in the comments).

const SONG_TABLE = 0x8bd46;   // 16 bytes per song: four sequence lists
const START_NOTES = 0x8be7e;  // every channel starts here: "next pattern"
const START_SEQ = 0x8be76;    // an empty sequence list, so the song's own is used
const SILENT_SAMPLE_PTR = 0x9fb46; // the long at this address: the sample the stop routine plays
const REST_ENVELOPE = 0x9faca;     // the envelope of a rest (zeros)

const DMACON = 0x96;
const reg = (k, r) => 0xa0 + 16 * k + r; // AUDxLC 0, LEN 4, PER 6, VOL 8

function channel(num) {
  return {
    num,                 // +00 channel number (1-4); 0 = not playing
    count: 0,            // +02 ticks left of the note
    type: 0,             // +04 0 = one sample, 3 = attack playing, 1 = loop
    period: 0,           // +06
    slideMode: 0, slideStep: 0, slideTarget: 0, slideDelay: 0, // +08 +0A +0C +0E
    vib: 0,              // +10 vibrato phase 1-4, 0 = off
    envPtr: 0,           // +12 volume envelope, one word per tick, FFh = hold
    notePtr: 0,          // +16 the channel's notes and commands
    seqPtr: 0,           // +1A the next entry of the sequence list
    seqStart: 0,         // +1E the sequence list
    envStart: 0,         // +22
    attackLC: 0, attackLen: 0, loopLC: 0, loopLen: 0, // +26 +2A +2C +30
    vibCount: 0, vibReload: 0, vibUp: 0, vibDown: 0, vibDelay: 0, vibDelayReload: 0, // +32 .. +3C
    volOffset: 0, volAdd: 0, addFlag: 0, // +3E (unused by the code that runs) +40 +42
  };
}

export class MusicPlayer {
  /**
   * @param tune { base, bytes } the frontend's data from 8BD46h (lib/amiga-disk.mjs)
   * @param write (reg, value, size) a sound chip register write: reg A0h-DFh or 96h,
   *   size 4 for the long location registers
   * @param led (on) optional: the power LED (on = the A500's audio filter in)
   */
  constructor(tune, write, led = () => {}) {
    this.mem = tune;
    this.write = write;
    this.led = led;
    this.song = 1;
    this.level = 0;        // 8B7BEh, added to every volume
    this.ch = [];
    this.playing = false;
  }
  word(a) {
    const i = a - this.mem.base, b = this.mem.bytes;
    if (i < 0 || i + 1 >= b.length) return 0;
    return (b[i] << 8) | b[i + 1];
  }
  long(a) { return ((this.word(a) << 16) | this.word(a + 2)) >>> 0; }

  /** The stop routine (+4): all channels off and silent. */
  stop() {
    this.write(DMACON, 0x000f, 2);
    const silent = this.long(SILENT_SAMPLE_PTR);
    for (let k = 0; k < 4; k++) this.write(reg(k, 0), silent, 4);
    for (let k = 0; k < 4; k++) this.write(reg(k, 4), 0x10, 2);
    for (let k = 0; k < 4; k++) this.write(reg(k, 8), 0, 2);
    for (let k = 0; k < 4; k++) this.write(reg(k, 6), 1, 2);
    this.level = 0;
    this.playing = false;
  }

  /** The start routine (+0): stop, clear the channels and point them at the song. */
  start(song = this.song) {
    this.song = song;
    this.stop();
    this.ch = [1, 2, 3, 4].map(channel);
    if (song) {
      for (let k = 0; k < 4; k++) {
        const c = this.ch[k];
        c.seqStart = this.long(SONG_TABLE + 16 * song + 4 * k);
        c.notePtr = START_NOTES;
        c.seqPtr = START_SEQ;
      }
    }
    this.playing = true;
  }

  /** The level offset (+C): 0 for full volume down to -64 for silence. */
  setLevel(level) { this.level = level; }

  /** One VBlank (+8): each channel's next step, then its DMA bit. */
  tick() {
    if (!this.playing) return;
    for (let k = 0; k < 4; k++) {
      const dma = this.channelTick(this.ch[k], k);
      this.write(DMACON, dma, 2);
    }
  }

  // 8BA00h: returns the DMACON word for the channel (8000h|bit: on; bit: off)
  channelTick(c, k) {
    const bit = 1 << k;
    let dma = 0x8000 | bit;
    if (c.num === 0) return dma;
    if (c.count === 0) { this.newNote(c, k); return dma; }
    if (c.count === 1) {
      // the note's last tick: DMA off, so the next note restarts its sample
      if (c.type !== 0) dma = bit;
      c.count--;
    } else if (c.type === 3) {
      // the attack has started: queue the loop, which Paula takes when the attack ends
      this.write(reg(k, 0), c.loopLC, 4);
      this.write(reg(k, 4), c.loopLen, 2);
      c.count--;
      c.type = 1;
    } else c.count--;
    this.slideAndVibrato(c, k);
    this.volume(c, k);
    return dma;
  }

  // 8BA2Ah-8BAF2h
  slideAndVibrato(c, k) {
    let changed = false, d2 = c.period;
    if (c.slideMode !== 0) {
      if (c.slideDelay !== 0) c.slideDelay = (c.slideDelay - 1) & 0xffff;
      else {
        changed = true;
        let reached;
        if (c.slideMode === 1) { d2 = (d2 + c.slideStep) & 0xffff; reached = !(c.slideTarget >= d2); }
        else { d2 = (d2 - c.slideStep) & 0xffff; reached = !(c.slideTarget < d2); }
        if (reached) { d2 = c.slideTarget; c.slideMode = 0; }
      }
    }
    if (c.vib !== 0) {
      if (c.vibDelay !== 0) c.vibDelay = (c.vibDelay - 1) & 0xffff;
      else if (c.vibCount !== 0) c.vibCount = (c.vibCount - 1) & 0xffff;
      else {
        c.vibCount = c.vibReload;
        changed = true;
        if (c.vib < 3) { d2 = (d2 - c.vibDown) & 0xffff; c.vib++; }
        else { d2 = (d2 + c.vibUp) & 0xffff; c.vib++; if (c.vib === 5) c.vib = 1; }
      }
    }
    if (changed) { c.period = d2; this.write(reg(k, 6), d2, 2); }
  }

  // 8BB30h: the envelope's next volume, plus the level offset, not below 0
  volume(c, k) {
    let a = c.envPtr, add = c.addFlag === 1;
    if (this.word(a) === 0xff) { a -= 2; add = false; } // hold the last value
    let v = this.word(a);
    a += 2;
    if (add) v = (v + c.volAdd) & 0xffff;
    v = (v + this.level) & 0xffff;
    if (v & 0x8000) v = 0;
    this.write(reg(k, 8), v, 2);
    c.envPtr = a;
  }

  // 8BBAEh: read commands up to the next note or rest
  newNote(c, k) {
    c.addFlag = 0;
    let a = c.notePtr;
    for (let guard = 0; guard < 1000; guard++) {
      const d0 = this.word(a);
      a += 2;
      if (d0 > 100) {
        // a note: its period and length
        c.period = d0;
        this.write(reg(k, 6), d0, 2);
        c.count = (this.word(a) - 1) & 0xffff;
        a += 2;
        c.notePtr = a;
        c.envPtr = c.envStart;
        c.vibDelay = c.vibDelayReload;
        if (c.vib !== 0) c.vib = 1;
        if (c.type !== 0) {
          c.type = 3;
          this.write(reg(k, 0), c.attackLC, 4);
          this.write(reg(k, 4), c.attackLen, 2);
        }
        this.volume(c, k);
        return;
      }
      switch (d0) {
        case 4: { // instrument
          const r = this.long(a); a += 4;
          const type = this.word(r);
          c.type = type;
          if (type === 0) {
            this.write(reg(k, 0), this.long(r + 2), 4);
            this.write(reg(k, 4), this.word(r + 6), 2);
          } else {
            c.attackLC = this.long(r + 2); c.attackLen = this.word(r + 6);
            c.loopLC = this.long(r + 8); c.loopLen = this.word(r + 12);
          }
          break;
        }
        case 8: { // the next pattern of the sequence list, from its start after the last
          if (this.long(c.seqPtr) === 0) c.seqPtr = c.seqStart;
          a = this.long(c.seqPtr);
          c.seqPtr = (c.seqPtr + 4) >>> 0;
          break;
        }
        case 12: { // envelope
          const e = this.long(a); a += 4;
          c.volOffset = this.word(e); c.volAdd = this.word(e + 2);
          c.envStart = e + 4;
          break;
        }
        case 16: // pitch slide
          c.slideMode = this.word(a); c.slideStep = this.word(a + 2);
          c.slideTarget = this.word(a + 4); c.slideDelay = this.word(a + 6);
          a += 8;
          break;
        case 20: // vibrato
          c.vib = 1;
          c.vibCount = this.word(a); c.vibReload = this.word(a + 2);
          c.vibUp = this.word(a + 4); c.vibDown = this.word(a + 6);
          c.vibDelay = this.word(a + 8); c.vibDelayReload = this.word(a + 10);
          a += 12;
          break;
        case 24: c.slideMode = 0; break;
        case 28: c.vib = 0; break;
        case 32: // a rest
          c.count = (this.word(a) - 1) & 0xffff;
          a += 2;
          c.notePtr = a;
          c.envPtr = REST_ENVELOPE;
          this.write(reg(k, 8), 0, 2);
          this.volume(c, k);
          return;
        case 44: this.led(true); break;  // power LED on: the audio filter in
        case 48: this.led(false); break; // and out
        case 52: c.addFlag = 1; break;
        case 56: a = this.long(a); break; // jump
        case 0: case 36: case 40: case 60: case 64: return; // stay here
        default: throw new Error(`music: command ${d0} at ${(a - 2).toString(16)}`);
      }
    }
    throw new Error('music: no note found');
  }
}
