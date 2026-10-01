// The AudioWorklet for the page's Amiga sound (lib/amiga-sound.mjs): two
// Paula sound chips, one for the title tune (lib/amiga-music.mjs, the front
// end's data) and one for the race (lib/amiga-race.mjs, the race program's
// data), ticked 50 times a second as the Amiga's VBlank interrupt ticks them.
//
// Messages from the page (port.postMessage):
//   { type: 'data', tune, race }            the blocks from lib/amiga-disk.mjs
//   { type: 'filter', filter }               'a500' or 'off'
//   { type: 'tune', action: 'start' | 'fade' | 'stop' }
//   { type: 'engine', state, revs }          the DOS engine sound state and revs
//   { type: 'effect', n, param }             a DOS driver effect started
//   { type: 'effect-stop', n }               ... or stopped (the tyres)
//   { type: 'all-off' }                      the game stopped every effect (its
//                                            stop-all, the Amiga's 808E2h)
//   { type: 'race-off' }                     the session ended
// It posts { type: 'status', tune, ticks } now and then.

import { Paula } from './paula.mjs';
import { MusicPlayer } from './amiga-music.mjs';
import { RaceSound } from './amiga-race.mjs';

const FADE_STEPS = 33; // the front end's fade: level 0, -2, ... -64, two ticks each (8172Ch)

class AmigaSound extends AudioWorkletProcessor {
  constructor() {
    super();
    this.tickLen = sampleRate / 50;
    this.untilTick = 0;
    this.ticks = 0;
    this.tunePaula = new Paula(sampleRate);
    this.racePaula = new Paula(sampleRate);
    // headphones: the tune at half separation, the race with the engine in the middle
    this.tunePaula.setPan(0.5);
    this.racePaula.setPan(0.5, [0]);
    // the engine (volume 40, in the middle) about as loud as the AdLib engine
    this.racePaula.gain = 1.4;
    this.music = null; this.race = null;
    this.fade = -1;      // ticks into the fade, or -1
    this.port.onmessage = (e) => this.message(e.data);
  }

  message(m) {
    switch (m.type) {
      case 'data':
        this.music = new MusicPlayer(m.tune, (r, v, s) => this.tunePaula.write(r, v, s), (on) => { this.tunePaula.led = on; });
        this.tunePaula.setMemory(m.tune);
        this.race = new RaceSound(m.race, this.racePaula);
        break;
      case 'filter':
        this.tunePaula.filter = this.racePaula.filter = m.filter;
        break;
      case 'tune':
        if (!this.music) break;
        if (m.action === 'start') { this.fade = -1; this.music.start(1); }
        else if (m.action === 'fade') { if (this.music.playing && this.fade < 0) this.fade = 0; }
        else if (m.action === 'stop') { this.fade = -1; this.music.stop(); }
        break;
      case 'engine':
        if (this.race) this.race.setEngine(m.state, m.revs);
        break;
      case 'effect':
        if (this.race) this.race.dosEffect(m.n, m.param);
        break;
      case 'effect-stop':
        if (this.race) this.race.dosStop(m.n);
        break;
      case 'all-off':
        this.racePaula.allOff();
        break;
      case 'race-off':
        this.racePaula.allOff();
        if (this.race) this.race.setEngine(0x80, 0);
        break;
      default: break;
    }
  }

  vblank() {
    this.ticks++;
    if (this.music && this.music.playing) {
      if (this.fade >= 0) {
        if (this.fade % 2 === 0) {
          const step = this.fade / 2;
          if (step < FADE_STEPS) this.music.setLevel(-2 * step);
          else { this.music.stop(); this.fade = -1; }
        }
        if (this.fade >= 0) this.fade++;
      }
      this.music.tick();
    }
    if (this.race) this.race.tick();
    if ((this.ticks & 63) === 0) this.port.postMessage({ type: 'status', tune: !!(this.music && this.music.playing), ticks: this.ticks });
  }

  process(inputs, outputs) {
    const out = outputs[0], L = out[0], R = out[1] ?? out[0];
    const n = L.length;
    L.fill(0); if (R !== L) R.fill(0);
    let at = 0;
    while (at < n) {
      if (this.untilTick <= 0) { this.vblank(); this.untilTick += this.tickLen; }
      const run = Math.min(n - at, Math.ceil(this.untilTick));
      this.tunePaula.render(L, R, run, at);
      this.racePaula.render(L, R, run, at);
      at += run; this.untilTick -= run;
    }
    return true;
  }
}

registerProcessor('amiga-sound', AmigaSound);
