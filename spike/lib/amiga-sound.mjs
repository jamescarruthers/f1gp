// The Amiga version's sound for the page (render.html, sound=amiga): its
// title tune in the menus, and in a session its sampled engine and race
// effects, played from the DOS game's events. The DOS game's own sound is
// not played.
//
//   const amiga = await makeAmigaSound({ data: 'dist/amiga-sound.bin', filter: 'a500' });
//   every frame: amiga.update(mem);   // mem from lib/f1gp-mem.mjs, or null before gp.exe runs
//
// The data are the blocks lib/amiga-disk.mjs takes from the Amiga disk
// images; the sound is made in an AudioWorklet (lib/amiga-worklet.mjs).
//
// As on the Amiga: the intro is silent; the title tune starts with the menus
// and fades out (1.3 s) when a session starts loading (the front end does
// this before it runs the race program); in the session the engine follows
// the DOS engine sound's state and revs, and the effects follow the DOS
// driver's effects (lib/dos-sound.mjs counts them). The tune plays again
// from the start the next time the menus show. The AudioContext starts on
// the first key or click, as browsers require, and stops while the page is
// hidden (the emulator stops then too).

import { unpackSound } from './amiga-disk.mjs';
import { driverHook, engineSound, passingSpeed, soundFlags } from './dos-sound.mjs';

export async function makeAmigaSound({ data = 'dist/amiga-sound.bin', filter = 'a500', volume = 1 } = {}) {
  const res = await fetch(data);
  if (!res.ok) throw new Error(`${data}: HTTP ${res.status}`);
  const blocks = unpackSound(await res.arrayBuffer());
  const ctx = new AudioContext({ latencyHint: 'interactive' });
  await ctx.audioWorklet.addModule(new URL('./amiga-worklet.mjs', import.meta.url));
  const node = new AudioWorkletNode(ctx, 'amiga-sound', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
  const gain = ctx.createGain();
  gain.gain.value = volume;
  node.connect(gain).connect(ctx.destination);
  const meter = ctx.createAnalyser();
  meter.fftSize = 2048;
  gain.connect(meter);
  node.port.postMessage({ type: 'data', tune: blocks.tune, race: blocks.race });
  node.port.postMessage({ type: 'filter', filter });
  const resume = () => { if (ctx.state === 'suspended') ctx.resume().catch(() => {}); };
  document.addEventListener('pointerdown', resume, { capture: true });
  document.addEventListener('keydown', resume, { capture: true });
  document.addEventListener('visibilitychange', () => { if (document.hidden) ctx.suspend().catch(() => {}); else resume(); });

  const state = { ctx, enabled: true, place: 'none', tune: false, worklet: null, events: { starts: Array(16).fill(0), stops: Array(16).fill(0) } };
  node.port.onmessage = (e) => { if (e.data.type === 'status') state.worklet = e.data; };
  const send = (m) => node.port.postMessage(m);
  let hook = null, hookMem = null, lastEngine = null, seen = null;

  // Where the game is: 'intro' (gp.exe not running), 'menus', 'loading' (a
  // session loads: the game has loaded its race sound driver) or 'session'
  // (the game's sounds are on, SS:018E = 0). The race driver stays loaded
  // when the game goes back to the menus, so in the menus the hook marks the
  // copy that is there; a session's loading puts a fresh copy in.
  function where(mem) {
    const present = hook.present, flags = soundFlags(mem);
    let place;
    if (flags.on) place = 'session';
    else if (!present || flags.left) place = 'menus';
    else if (state.place === 'loading') place = 'loading';
    else if (!hook.installed && (seen === 'absent' || seen === 'ours')) place = 'loading';
    else place = 'menus';
    if (present && !hook.installed) hook.install();
    seen = present ? 'ours' : 'absent';
    return place;
  }
  function leave(next) {
    if (state.place === 'menus') { send({ type: 'tune', action: 'fade' }); state.tune = false; }
    if (state.place === 'session') { send({ type: 'race-off' }); lastEngine = null; }
    if (next === 'menus') { send({ type: 'tune', action: 'start' }); state.tune = true; }
  }

  state.update = (mem) => {
    if (!state.enabled) return;
    if (!mem) { if (state.place !== 'intro') { leave('intro'); state.place = 'intro'; } return; }
    if (hookMem !== mem) { hook = driverHook(mem); hookMem = mem; seen = null; }
    const place = where(mem), was = state.place;
    if (place !== was) { leave(place); state.place = place; }
    if (place !== 'session') { if (place === 'loading') hook.take(); return; }
    if (was !== 'session' && was !== 'loading') {
      // joined a session already running: start the engine if it runs (not in the TV view)
      const e = engineSound(mem);
      if (e.state === 0 && e.view !== 0xc0) send({ type: 'effect', n: 0 });
    }
    const eng = engineSound(mem);
    // no hook (another sound driver): start the engine when the game starts its own
    if (!hook.installed && eng.state === 0 && lastEngine && lastEngine.state !== 0 && eng.view !== 0xc0) send({ type: 'effect', n: 0 });
    if (!lastEngine || eng.state !== lastEngine.state || eng.revs !== lastEngine.revs) { send({ type: 'engine', state: eng.state, revs: eng.revs }); lastEngine = eng; }
    const d = hook.take();
    if (!d) return;
    // stops before starts: the game stops everything, then starts the engine again
    const stopAll = d.stops.some((n, k) => n && k !== 1);
    if (stopAll) send({ type: 'all-off' });
    else if (d.stops[1]) send({ type: 'effect-stop', n: 1 });
    const p = hook.params();
    for (let k = 0; k < 10; k++) {
      if (!d.starts[k]) continue;
      state.events.starts[k] += d.starts[k];
      const param = k >= 6 ? { speed: passingSpeed(mem) ?? 0x2000 } : p;
      // a few at most: more in one frame means the page was away (a hidden tab)
      for (let i = 0; i < Math.min(d.starts[k], 2); i++) send({ type: 'effect', n: k, param });
    }
    d.stops.forEach((n, k) => { state.events.stops[k] += n; });
  };

  state.setEnabled = (on) => {
    if (on === state.enabled) return;
    if (!on) { leave('none'); if (hook) hook.uninstall(); state.place = 'none'; seen = null; }
    state.enabled = on;
  };
  state.setFilter = (f) => send({ type: 'filter', filter: f });
  state.setVolume = (v) => { gain.gain.value = v; };
  /** The output's RMS level over the last 2,048 samples (for checks). */
  state.level = () => { const a = new Float32Array(meter.fftSize); meter.getFloatTimeDomainData(a); let s = 0; for (const v of a) s += v * v; return Math.sqrt(s / a.length); };
  return state;
}
