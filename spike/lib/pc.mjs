// The Rust PC (spike/machine, built to dist/machine.wasm) for the page and the
// probes: a small 286 PC with the devices and DOS services gp.exe uses, in
// place of js-dos and DOSBox. This wraps its exported functions in the parts
// of js-dos's CommandInterface that the page and the probes use: key events
// (GLFW codes, as js-dos takes them), screenshots, the emulator's memory (for
// lib/f1gp-mem.mjs attach(): transport.module.HEAPU8), and the files the game
// wrote (for lib/saves.mjs).
//
// The machine runs on an emulated clock: run(ms) runs that much of the game's
// time, so the page calls it from its frame loop, and a probe's "sleep" is a
// run, as fast as the host allows.
//
//   import { createPC } from './pc.mjs';
//   const pc = await createPC({ wasm: bytesOrUrl, files: { 'GP.EXE': bytes, ... } });
//   pc.run(16.7); pc.sendKeyEvent(257, true); const img = pc.screen();
//
// Plain ES module (browser and Node).

// js-dos key codes (GLFW) -> PC scan codes (set 1); 0xE0xx for the extended keys
const SCAN = (() => {
  const m = {
    32: 0x39, 39: 0x28, 44: 0x33, 45: 0x0c, 46: 0x34, 47: 0x35, 59: 0x27, 61: 0x0d,
    91: 0x1a, 92: 0x2b, 93: 0x1b, 96: 0x29,
    256: 0x01, 257: 0x1c, 258: 0x0f, 259: 0x0e, 260: 0xe052, 261: 0xe053,
    262: 0xe04d, 263: 0xe04b, 264: 0xe050, 265: 0xe048, 266: 0xe049, 267: 0xe051, 268: 0xe047, 269: 0xe04f,
    300: 0x57, 301: 0x58, 340: 0x2a, 341: 0x1d, 342: 0x38, 344: 0x36, 345: 0xe01d, 346: 0xe038,
  };
  const letters = 'QWERTYUIOP\0\0\0\0ASDFGHJKL\0\0\0\0\0ZXCVBNM';
  for (let i = 0; i < letters.length; i++) if (letters[i] !== '\0') m[letters.charCodeAt(i)] = 0x10 + i;
  for (let d = 1; d <= 9; d++) m[48 + d] = 0x01 + d;
  m[48] = 0x0b;
  for (let f = 1; f <= 10; f++) m[289 + f] = 0x3a + f;
  return m;
})();

/**
 * @param {{ wasm: ArrayBuffer|Uint8Array|string|URL, files: Record<string, Uint8Array>,
 *   program?: string, tail?: string, cyclesPerMs?: number, record?: string[] }} o
 *   record: an array the machine calls are added to (cycles, runs, keys; pc.write() adds its
 *   writes, and a probe its own lines), for machine/src/bin/replay.rs to run them again natively
 */
export async function createPC(o) {
  let bytes = o.wasm;
  if (typeof bytes === 'string' || bytes instanceof URL) bytes = await (await fetch(bytes)).arrayBuffer();
  const { instance } = await WebAssembly.instantiate(bytes, {});
  const x = instance.exports;
  const memory = x.memory;
  let heap = new Uint8Array(memory.buffer);
  const view = () => (heap.buffer === memory.buffer ? heap : (heap = new Uint8Array(memory.buffer)));
  const enc = new TextEncoder(), dec = new TextDecoder();
  const withStr = (s, f) => {
    const b = enc.encode(s);
    const p = x.mc_alloc(b.length || 1);
    view().set(b, p);
    const r = f(p, b.length);
    x.mc_free(p, b.length || 1);
    return r;
  };
  const out = () => view().slice(x.mc_out(h), x.mc_out(h) + x.mc_out_len(h));

  const h = x.mc_new();
  for (const [name, data] of Object.entries(o.files)) {
    if (name.startsWith('.jsdos/') || name.endsWith('/')) continue;
    const p = x.mc_alloc(data.length || 1);
    view().set(data, p);
    withStr(name, (np, nl) => x.mc_add_file(h, np, nl, p, data.length));
  }
  const rec = o.record ?? null;
  if (o.cyclesPerMs) { x.mc_set_cycles(h, o.cyclesPerMs); rec?.push(`c ${o.cyclesPerMs}`); }
  const program = o.program ?? 'GP.EXE', tail = o.tail ?? ' /g';
  const started = withStr(program, (pp, pl) => withStr(tail, (tp, tl) => x.mc_start(h, pp, pl, tp, tl)));
  if (started !== 0) { x.mc_text(h, 0); throw new Error(`the PC could not start ${program}: ${dec.decode(out())}`); }

  let exited = null;
  const frameListeners = [];
  const pc = {
    /** Run `ms` of the game's time; the exit code once the program has ended, else null. */
    run(ms) {
      if (exited !== null) return exited;
      rec?.push(`r ${ms}`);
      const c = x.mc_run(h, ms);
      if (c >= 0) exited = c;
      for (const f of frameListeners) f();
      return exited;
    },
    get exited() { return exited; },
    /** The emulated clock (ms). */
    now: () => x.mc_now(h) / 1000,
    /** Instructions run so far. */
    instructions: () => x.mc_count(h),
    setCycles: (perMs) => { rec?.push(`c ${perMs}`); x.mc_set_cycles(h, perMs); },
    /**
     * The game's 3D view drawn by our Rust port of its routine (machine/src/r3d/), the same
     * picture, or by the game's own code. Ours goes in only where the game's routine is.
     */
    native3d: (on) => x.mc_native_3d(h, on ? 1 : 0),
    /** The frames our 3D routine has drawn. */
    nativeFrames: () => x.mc_native_frames(h),
    /**
     * With our 3D routine, each frame the game shows with its 3D view drawn finer for the page
     * at this scale (1 to 8; 0 stops it): machine/src/r3d/shown.rs.
     */
    r3dScale: (s) => x.mc_r3d_scale(h, s),
    /**
     * The last frame shown that way, or null: { serial, scale, top (the screen row the 3D view
     * starts on), words (its primitives, four words each), screen (320 x 200 palette indices),
     * mask (1 where the screen shows the 3D view), dac (768 bytes, 6-bit) }, views to use
     * before the next run.
     */
    r3dShown() {
      const g = (k) => x.mc_r3d_shown(h, k) >>> 0;
      const serial = g(0);
      if (!serial) return null;
      const v = view();
      return {
        serial, scale: g(1), top: g(2),
        words: new Uint32Array(v.buffer, g(4), g(3)),
        screen: v.subarray(g(5), g(5) + 64000), mask: v.subarray(g(6), g(6) + 64000), dac: v.subarray(g(7), g(7) + 768),
      };
    },
    /** A key (js-dos/GLFW code) down or up. */
    sendKeyEvent(code, down) {
      const s = SCAN[code];
      if (s === undefined) return;
      const key = (b) => { rec?.push(`k ${b.toString(16)}`); x.mc_key(h, b); };
      if (s > 0xff) key(0xe0);
      key((s & 0x7f) | (down ? 0 : 0x80));
    },
    /** The screen: RGBA, 320 x 200 (a view: copy it to keep it). */
    screen() {
      const p = x.mc_render(h);
      return view().subarray(p, p + 320 * 200 * 4);
    },
    width: () => 320,
    height: () => 200,
    /** As js-dos's: { width, height, data } (a copy). */
    async screenshot() {
      return { width: 320, height: 200, data: new Uint8ClampedArray(pc.screen()) };
    },
    /** Guest memory, linear 0 at index 0 (a view). */
    ram() {
      const p = x.mc_ram(h);
      return view().subarray(p, p + x.mc_ram_len(h));
    },
    /** Write bytes to guest memory at a linear address (recorded, when recording). */
    write(lin, bytes) {
      pc.ram().set(bytes, lin);
      rec?.push(`w ${lin.toString(16)} ${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`);
    },
    /** For lib/f1gp-mem.mjs attach(): the module's memory, with guest RAM inside it. */
    transport: { module: { get HEAPU8() { return view(); } } },
    /** The names of the files the program created or wrote since the last clearChanged(). */
    changedFiles() {
      x.mc_text(h, 1);
      const t = dec.decode(out());
      return t ? t.split('\n') : [];
    },
    clearChanged: () => x.mc_changed_clear(h),
    /** A file on drive C, or null. */
    file(name) {
      const n = withStr(name, (p, l) => x.mc_file(h, p, l));
      return n === 0xffffffff ? null : out();
    },
    log() { x.mc_text(h, 0); return dec.decode(out()); },
    console() { x.mc_text(h, 2); return dec.decode(out()); },
    /** Called after each run (as js-dos's frame events). */
    onFrame(f) { frameListeners.push(f); },
  };
  return pc;
}

/**
 * A driver for lib/route.cjs: keys go to the PC, and the route's waits run the
 * game for as long (so a route takes the game's time, not the host's).
 * @param {Awaited<ReturnType<typeof createPC>>} pc
 * @param {Record<string, number>} keys  route.JSDOS_KEYS
 */
export function pcDriver(pc, keys) {
  const code = (k) => {
    const c = keys[k];
    if (c === undefined) throw new Error(`unknown key ${k}`);
    return c;
  };
  const step = (ms) => { for (let t = 0; t < ms; t += 20) pc.run(Math.min(20, ms - t)); };
  return {
    async press(k, holdMs = 120) {
      pc.sendKeyEvent(code(k), true);
      step(holdMs);
      pc.sendKeyEvent(code(k), false);
      step(30);
    },
    async keyDown(k) { pc.sendKeyEvent(code(k), true); },
    async keyUp(k) { pc.sendKeyEvent(code(k), false); },
    async sleep(ms) { step(ms); },
    screenshot: () => pc.screenshot(),
  };
}

/**
 * The PC as the page uses js-dos's CommandInterface (render.html, machine=rust): the
 * machine on its own clock, frame events, persist() for lib/saves.mjs (every file that
 * differs from the bundle: the ones kept from earlier visits and the ones the game writes
 * now), the cycles event of the page's governor, pause and resume.
 *
 * The machine runs as js-dos runs DOSBox on the main thread: in short tasks that keep the
 * game's time up with real time, apart from the page's drawing, so a slow page frame does
 * not slow the game, and the emulation is spread over the frame instead of done in one
 * block. Each task runs the game in slices of `slice` ms until it has caught up or has
 * used `budget` ms, then yields (a message, at once, while behind; a timer for the rest
 * of the time while ahead; a timer set from a message task is not clamped to 4 ms). If
 * the host falls more than `behind` ms short, that time is dropped and the game slows,
 * as DOSBox does. The page calls frame() from its frame loop for the screen.
 * @param {Awaited<ReturnType<typeof createPC>>} pc
 * @param {{ zipSync: Function, kept?: string[], slice?: number, budget?: number, behind?: number }} o
 *   fflate's zipSync; the names loaded from earlier visits
 */
export function pcCommandInterface(pc, o) {
  const frames = [];
  const kept = new Set((o.kept ?? []).map((n) => n.toUpperCase().replace(/\//g, '\\')));
  const slice = o.slice ?? 2, budget = o.budget ?? 6, behind = o.behind ?? 200;
  let paused = false, origin = null, queued = false, dropped = 0, busy = 0;
  const channel = new MessageChannel();
  const queue = (ms) => {
    if (queued) return;
    queued = true;
    if (ms > 0) setTimeout(() => channel.port2.postMessage(0), ms);
    else channel.port2.postMessage(0);
  };
  channel.port1.onmessage = () => {
    queued = false;
    if (paused || pc.exited !== null) return;
    const start = performance.now();
    if (origin === null) origin = start - pc.now();
    if (start - origin - pc.now() > behind) { dropped += start - origin - pc.now() - behind; origin = start - pc.now() - behind; }
    const target = start - origin;
    while (pc.now() < target && performance.now() - start < budget) pc.run(Math.min(slice, target - pc.now()));
    busy += performance.now() - start;
    if (pc.exited !== null) return;
    queue(pc.now() < target ? 0 : Math.max(1, pc.now() - (performance.now() - origin)));
  };
  const ci = {
    width: pc.width,
    height: pc.height,
    sendKeyEvent: pc.sendKeyEvent,
    transport: pc.transport,
    screenshot: pc.screenshot,
    pc,
    /** Send the screen as it is now to the frame listeners (from the page's frame loop). */
    frame() {
      const rgba = pc.screen();
      for (const f of frames) f(null, rgba);
    },
    /** Real time (ms) the machine could not keep up with, so the game ran slower. */
    get dropped() { return dropped; },
    /** Time (ms) the machine's tasks have taken on the main thread. */
    get busyMs() { return busy; },
    events: () => ({
      onFrame: (f) => frames.push(f),
      onSoundPush: () => {},
    }),
    soundFrequency: () => 44100,
    async persist() {
      for (const n of pc.changedFiles()) kept.add(n);
      const files = {};
      for (const n of kept) {
        const d = pc.file(n);
        if (d) files[n.replace(/\\/g, '/')] = d;
      }
      return o.zipSync(files);
    },
    sendBackendEvent(e) {
      const m = /^cycles:(\d+)$/.exec(e?.event ?? '');
      if (m) pc.setCycles(+m[1]);
    },
    pause() { paused = true; },
    // the game's time carries on from where it stopped
    resume() { if (!paused) return; paused = false; origin = null; queue(0); },
    exit() { paused = true; channel.port1.close(); },
  };
  queue(0);
  return ci;
}
