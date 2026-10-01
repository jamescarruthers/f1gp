// p2-capture.cjs - Phase 2 reference frames: paused game frames, each paired
// with the exact game state, at points spread round the lap of one circuit.
//
//   node build-bundle.mjs --autoexec "gp /g" --cycles 25000 --out dist/p2-capture-25000.jsdos
//   timeout 300 node probes/p2-capture.cjs --circuit Italy [--warp 2] [--wall 280]
//   node probes/p2-capture-check.cjs            # overlays, index.json, colours.json
//
// Method (from probes/p2-proto.cjs): route.toTrack to "Practise any
// Circuit", Space off the jacks, hold A through the pit lane (the game
// steers there; view keys do nothing in the pit lane), then an autopilot
// (pure pursuit on the in-memory centreline and a curvature speed limit,
// copied from probes/p1-accuracy-run.cjs) drives one lap and brakes to a
// standstill at ~12 targets (corners seen from before the apex, hills,
// straights, and the pit straight just before the line). At each stop it
// shows the chase, TV and cockpit views in turn; for each it waits for the
// "Viewing ..." banner to go, waits for a consistent read of a new frame
// (lib/f1gp-state.mjs), pauses the emulator (ci.pause()), reads the state,
// takes the screenshot and saves both, then resumes. At two stops it also
// captures with the road texture toggled (T) and toggles it back. Between
// stops it captures a few frames while moving, with the camera states of
// the last 3 frames, to see which frame the screen shows.
//
// The emulator only runs while this script awaits, so nothing moves between
// the read that triggers the pause and ci.pause().
//
// Output, out/p2-ref/<NN>/ (NN = track file number 01-16 = SS:1236 + 1):
//   <k>.png   the 320x200 screenshot
//   <k>.json  { circuit, view, texture, detail, state (full readState), history
//              (camera of the last 3 frames, current flagged), extra, stop }
//   track.json (readTrack at the first stop), meta.json, log.txt
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const CIRCUIT = opt('circuit', 'Italy');
const WARP = +opt('warp', 2);
const WALL = +opt('wall', 280);             // stop and save after this many real seconds
const NSTOPS = +opt('stops', 12);
const TEX_STOPS = (opt('tex-stops', '2,7') || '').split(',').filter(Boolean).map(Number);
// moving frames: one per stretch between stops (index = stops done so far), taken in a turn
// above 70 mph (heading change >= 150 units = 0.8 deg per frame) so the frame-to-frame camera change is visible
const MOVING_AFTER = (opt('moving', '0,1,2,3,4,5,6,7,8,9,10,11') || '').split(',').filter(Boolean).map(Number);
const BUNDLE = opt('bundle', path.join(__dirname, '..', 'dist', 'p2-capture-25000.jsdos'));
const FIND_TEX = args.includes('--find-tex');
const ALAT = +opt('alat', 55), BRAKE = +opt('brake', 70), LAG = +opt('lag', 0.25), DEADBAND = +opt('deadband', 300);
const BSTOP = +opt('bstop', 45);            // ft/s^2 used to plan a stop at a target

// Scale the clock DOSBox paces itself by (copy of installWarp in
// probes/p1-accuracy-lib.cjs): must run before the emulator loads.
const realNow = performance.now.bind(performance);
if (WARP !== 1) { const base = realNow(); performance.now = () => base + (realNow() - base) * WARP; }
const { start, encodePng } = require('../lib/node-emu.cjs');
const route = require('../lib/route.cjs');

const CIRCUIT_ROUTE = route.CIRCUITS.map((c) => c[0]);
// route names -> track file number (lib/track-file.mjs CIRCUITS order)
const FILE_OF = { 'United States': 1, Brazil: 2, 'San Marino': 3, Monaco: 4, Canada: 5, Mexico: 6, France: 7, 'Great Britain': 8,
  Germany: 9, Hungary: 10, Belgium: 11, Italy: 12, Portugal: 13, Spain: 14, Japan: 15, Australia: 16 };
if (!FILE_OF[CIRCUIT]) throw new Error(`unknown circuit ${CIRCUIT}; one of ${CIRCUIT_ROUTE.join(', ')}`);
const NN = String(FILE_OF[CIRCUIT]).padStart(2, '0');
const OUT = path.join(__dirname, '..', 'out', 'p2-ref', NN);
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const EXTRA = { home: 268, end: 269, pageup: 266, pagedown: 267, delete: 261, insert: 260 };
const code = (k) => (k in EXTRA ? EXTRA[k] : route.JSDOS_KEYS[k]);
const VIEW_KEY = { chase: 'pagedown', tv: 'left', cockpit: 'right', 'reverse-chase': 'delete' };
const wrap16 = (v) => (((v & 0xffff) + 0x8000) & 0xffff) - 0x8000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Known settings bytes (found with --find-tex and by pressing D, see meta.json):
const DETAIL_DS = 0x0068;   // D cycles 3 -> 2 -> 1 -> 0 -> 3; 3 at start
// T toggles the road/ground texture; two bytes follow it (--find-tex at Monza):
// SS:11A6 = 80h on / 00 off, and SS:00C0 = 1 on / 0 off. Texture is on at start.
let TEXTURE_ADDR = opt('tex-addr', 'SS:11a6');

// The "Viewing <name>" / "Riding with <name>" banner: a red/white chequered
// frame (4 px blocks) on rows 4-6 and 20-22, x 32-287.
function bannerOn(img) {
  let hits = 0;
  for (const y of [5, 21]) {
    let red = 0, white = 0;
    for (let x = 32; x < 288; x++) {
      const o = (y * img.width + x) * 4, r = img.data[o], g = img.data[o + 1], b = img.data[o + 2];
      if (r > 180 && g < 60 && b < 60) red++; else if (r > 200 && g > 200 && b > 200) white++;
    }
    if (red >= 80 && white >= 80) hits++;
  }
  return hits === 2;
}

(async () => {
  const { attach } = await import(pathToFileURL(path.join(__dirname, '..', 'lib', 'f1gp-mem.mjs')).href);
  const { createReader, readTrack } = await import(pathToFileURL(path.join(__dirname, '..', 'lib', 'f1gp-state.mjs')).href);
  const T0 = Date.now();
  const wall = () => (Date.now() - T0) / 1000;
  const logf = path.join(OUT, 'log.txt');
  fs.writeFileSync(logf, '');
  const log = (...m) => { const line = `[${wall().toFixed(1)}] ` + m.join(' '); console.log(line); fs.appendFileSync(logf, line + '\n'); };
  const meta = { circuit: CIRCUIT, file: +NN, warp: WARP, bundle: path.relative(path.join(__dirname, '..'), BUNDLE), autopilot: { ALAT, BRAKE, LAG, DEADBAND, BSTOP },
    captures: [], stops: [] };
  const saveMeta = () => fs.writeFileSync(path.join(OUT, 'meta.json'), JSON.stringify(meta, null, 1));
  const emu = await start(BUNDLE);
  const drv = route.nodeDriver(emu);
  const held = new Set();
  const down = (k) => { if (!held.has(k)) { held.add(k); emu.ci.sendKeyEvent(code(k), true); } };
  const up = (k) => { if (held.has(k)) { held.delete(k); emu.ci.sendKeyEvent(code(k), false); } };
  const allUp = () => { for (const k of [...held]) up(k); };
  try {
    meta.route = await route.toTrack(drv, { circuit: CIRCUIT, log });
    const mem = attach(emu.ci, { requireGame: true });
    const reader = createReader(mem);
    const readTex = () => {
      if (!TEXTURE_ADDR) return null;
      const [sg, off] = TEXTURE_ADDR.split(':');
      return (sg === 'DS' ? mem.ds : mem.ss).u8(parseInt(off, 16));
    };
    const settings = () => ({ detail: mem.ds.u8(DETAIL_DS), textureRaw: readTex(), texture2: mem.ss.u8(0x00c0) });
    let st = reader.read();
    const player = st.playerSlot;
    meta.start = { session: st.session, view: st.view, player, settings: settings(), ss017C: mem.ss.u16(0x017c) };
    log('start', JSON.stringify(meta.start));

    // ---------------------------------------------------------- frame tracking
    // history: one entry per game frame (first consistent read of each tick)
    const hist = [];
    let lastTick = -1, lastFrameWall = Date.now();
    const histEntry = (s) => {
      const c = s.cars[s.view.viewedSlot ?? player] || s.cars[player];
      return { tick: s.tick, frame: s.frame, consistent: s.consistent, settled: s.settled, view: s.view.mode, viewRaw: s.view.raw,
        camera: s.camera, viewed: { slot: c.slot, x: c.x, y: c.y, z: c.z, heading: c.heading, pitch: c.pitch, speed: c.speed, trackIndex: c.trackIndex, along: c.along, lateral: c.lateral } };
    };
    // one poll: returns the state when it is a new consistent frame, else null
    const poll = () => {
      const s = reader.read();
      if (s.tick !== lastTick && s.consistent) {
        lastTick = s.tick; lastFrameWall = Date.now();
        hist.push(histEntry(s)); if (hist.length > 6) hist.shift();
        return s;
      }
      return null;
    };
    // run the game for `gameMs` of game time (or until test(state) holds), polling
    const run = async (gameMs, test = null, onFrame = null) => {
      const t0 = reader.read().tick;
      const w0 = Date.now();
      while (true) {
        const s = poll();
        if (s) {
          if (onFrame) onFrame(s);
          if (test && test(s)) return s;
          if (s.tick - t0 >= gameMs) return s;
        }
        if (Date.now() - w0 > Math.max(4000, (gameMs / WARP) * 3 + 3000)) return null; // game stalled
        await sleep(2);
      }
    };
    const tap = async (k) => { emu.ci.sendKeyEvent(code(k), true); await run(130); emu.ci.sendKeyEvent(code(k), false); await run(70); };

    // ---------------------------------------------------------- texture byte search (exploration)
    if (FIND_TEX) {
      const snap = () => Buffer.concat([mem.snapshot(mem.dsLinear, 0x10000), mem.snapshot(mem.ssLinear, 0x10000)]);
      const seq = [];
      seq.push(snap()); await run(400); seq.push(snap());
      await tap('t'); await run(600); seq.push(snap()); await run(400); seq.push(snap());
      await tap('t'); await run(600); seq.push(snap()); await run(400); seq.push(snap());
      const c = [];
      for (let i = 0; i < 0x20000; i++) {
        const v = seq.map((b) => b[i]);
        if (v[0] === v[1] && v[2] === v[3] && v[4] === v[5] && v[0] !== v[2] && v[4] === v[0]) c.push({ at: i < 0x10000 ? `DS:${i.toString(16)}` : `SS:${(i - 0x10000).toString(16)}`, values: [v[0], v[2], v[4]] });
      }
      meta.textureCandidates = c;
      log('texture candidates', JSON.stringify(c.slice(0, 40)));
    }

    // ---------------------------------------------------------- driving
    let track = null, n = 0;
    let prevHead = null, prevTick = null;
    let targets = null, ti = 0;
    const steer = (c) => {
      const vft = c.speed / 64;
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
    };
    const curveAllowed = (c) => {
      const si = c.trackIndex;
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
      return allowed;
    };
    // distance (ft) along the lap from the car to the start of segment idx (negative once passed)
    const distTo = (c, idx) => {
      let d = (idx - c.trackIndex + n) % n;
      if (d > n / 2) d -= n;
      return d * 16 - c.along / 64;
    };

    const planTargets = (R) => {
      const L = track.lap;
      const curv = (i) => Math.abs(wrap16(L[(i + 2) % n].heading - L[(i - 2 + n) % n].heading)) / 4;
      const hill = (i) => Math.abs(L[(i + 10) % n].z - L[i].z);
      const pos = (i) => (i - R + n) % n;              // distance from the pit exit, in segments
      const pitStraight = (n - 6) % n;
      const endP = pos(pitStraight), startP = 25;
      const bins = NSTOPS - 1;
      const roles = ['corner', 'hill', 'corner', 'straight', 'corner', 'hill', 'corner', 'corner', 'hill', 'corner', 'straight'];
      const out = [];
      const hillMax = Math.max(...L.map((_, i) => hill(i)));
      for (let b = 0; b < bins; b++) {
        const p0 = startP + Math.floor(((endP - startP) * b) / bins), p1 = startP + Math.floor(((endP - startP) * (b + 1)) / bins) - 1;
        let role = roles[b % roles.length];
        if (role === 'hill' && hillMax < 40) role = 'corner';
        let best = null, bestV = -1;
        for (let p = p0; p <= p1; p++) {
          const i = (R + p) % n;
          const v = role === 'corner' ? curv(i) : role === 'hill' ? hill(i) : -Math.abs(p - (p0 + p1) / 2);
          if (v > bestV) { bestV = v; best = p; }
        }
        let p = best;
        if (role === 'corner') p = Math.max(p0, best - 4);  // stop before the apex: the corner is in view
        if (role === 'hill') p = Math.max(p0, best - 2);
        // keep stops apart: at least max(25, n/40) segments after the previous one
        const gap = Math.max(25, Math.round(n / 40));
        const prevP = out.length ? pos(out[out.length - 1].index) : -1e9;
        if (p - prevP < gap) { p = Math.min(p1, prevP + gap); role = `${role} (moved)`; }
        const i = (R + p) % n;
        out.push({ index: i, role, curvature: +curv(i).toFixed(1), hill: hill(i), z: L[i].z });
      }
      out.push({ index: pitStraight, role: 'pit straight', curvature: +curv(pitStraight).toFixed(1), hill: hill(pitStraight), z: L[pitStraight].z });
      return out;
    };

    // ---------------------------------------------------------- capture
    let k = 0, trackKey = null;
    const capture = async (label, extra = {}) => {
      // wait for a consistent read of a new frame, then pause at once
      let s = null;
      const w0 = Date.now();
      while (!s && Date.now() - w0 < 3000) { s = poll(); if (!s) await sleep(1); }
      if (!s) throw new Error('no consistent frame to capture');
      emu.ci.pause();
      const pausedAt = Date.now();
      const state = reader.read();       // the full state, same frame (the emulator is paused)
      const img = await emu.ci.screenshot();
      const state2 = reader.read();
      const tr = readTrack(mem);
      const tKey = JSON.stringify(tr.lap.map((e) => [e.centre, e.z]));
      if (!track || !trackKey) { trackKey = tKey; fs.writeFileSync(path.join(OUT, 'track.json'), JSON.stringify(tr)); }
      const name = String(k).padStart(2, '0');
      const h = hist.slice(-3).map((e) => ({ ...e, current: e.tick === state.tick }));
      const sameCam = h.every((e) => JSON.stringify(e.camera) === JSON.stringify(state.camera));
      const set = settings();
      const rec = {
        file: +NN, circuitIndex: state.session.circuit, circuitName: CIRCUIT, k, label,
        view: state.view.mode, viewRaw: state.view.raw,
        texture: { on: set.textureRaw === null ? null : (set.textureRaw & 0x80) !== 0, raw: set.textureRaw, address: TEXTURE_ADDR, ss00C0: set.texture2, toggledFromDefault: !!extra.texToggled },
        detail: { level: set.detail, address: `DS:${DETAIL_DS.toString(16).padStart(4, '0')}` },
        banner: bannerOn(img),
        // at a stop the speed field jitters at 8-20 (< 0.3 ft/s) with no keys held
        moving: Math.abs(state.cars[state.view.viewedSlot ?? player].speed) >= 40,
        stateUnchangedWhilePaused: state2.tick === state.tick && JSON.stringify(state2.camera) === JSON.stringify(state.camera),
        historyCameraStatic: sameCam,
        history: h,
        extra: { ss017C: mem.ss.u16(0x017c), viewportRows: mem.ss.s16(0x0132), horizonRow: mem.ss.s16(0x0130), trackSameAsTrackJson: tKey === trackKey,
          // frame phase at the pause: 300 Hz ticks since the last flip (SS:05C8), ticks the last frame's work took (DS:2C63)
          ticksSinceFlip: mem.ss.u16(0x05c8), ticksUsed: mem.ds.u16(0x2c63), ticksPerFrame: mem.ss.u16(0x1230),
          wallSeconds: +wall().toFixed(1) },
        ...extra,
        state,
      };
      fs.writeFileSync(path.join(OUT, `${name}.png`), encodePng(img.width, img.height, img.data, 4));
      fs.writeFileSync(path.join(OUT, `${name}.json`), JSON.stringify(rec));
      meta.captures.push({ k, label, view: rec.view, tick: state.tick, banner: rec.banner, moving: rec.moving, texture: rec.texture.raw, detail: set.detail,
        trackIndex: state.cars[player].trackIndex, speed: state.cars[player].speed, camStatic: sameCam });
      log(`capture ${name} ${label} view=${rec.view} tick=${state.tick} idx=${state.cars[player].trackIndex} v=${state.cars[player].speedMph} banner=${rec.banner} static=${sameCam} paused ${Date.now() - pausedAt} ms`);
      k++;
      emu.ci.resume();
      saveMeta();
      return rec;
    };

    // switch view and wait for the banner to go (at most maxMs game ms)
    const toView = async (view, maxMs = 4000) => {
      const want = view;
      for (let tries = 0; tries < 3; tries++) {
        if (reader.read().view.mode === want) break;
        await tap(VIEW_KEY[view]);
        await run(300);
      }
      const t0 = reader.read().tick;
      let gone = null;
      while (reader.read().tick - t0 < maxMs) {
        await run(200);
        const img = await emu.ci.screenshot();
        if (!bannerOn(img)) { gone = reader.read().tick - t0; break; }
      }
      await run(250); // let the camera settle a little more
      return { view: reader.read().view.mode, bannerGoneMs: gone };
    };

    // ---------------------------------------------------------- main loop
    let phase = 'pit', stopCount = 0, stoppedFrames = 0, movingDone = new Set();
    let lastProgress = { idx: -1, tick: 0 }, lastTrace = 0, lastViewSwitch = 0;
    log('driving out of the pit lane');
    while (wall() < WALL) {
      const s = poll();
      if (!s) {
        if (Date.now() - lastFrameWall > 3000) { allUp(); }
        await sleep(2);
        continue;
      }
      st = s;
      const c = s.cars[player];
      if (s.tick - lastTrace >= 1000) {
        lastTrace = s.tick;
        const tg = targets ? targets[ti] : null;
        const tr = { t: s.tick, phase, idx: c.trackIndex, nr: c.segNr.toString(16), inPit: c.inPit, lat: c.lateral, mph: c.speedMph, v: c.speed, h: c.heading, view: s.view.mode,
          keys: [...held].join('+'), d: tg && track ? Math.round(distTo(c, tg.index)) : null };
        fs.appendFileSync(path.join(OUT, 'trace.jsonl'), JSON.stringify(tr) + '\n');
      }
      if (c.trackIndex !== lastProgress.idx) lastProgress = { idx: c.trackIndex, tick: s.tick };
      else if (s.tick - lastProgress.tick > 25000 && phase !== 'capture') { log('no progress for 25 game s; giving up'); meta.stuck = { idx: c.trackIndex, tick: s.tick };
        const img = await emu.ci.screenshot(); fs.writeFileSync(path.join(OUT, 'stuck.png'), encodePng(img.width, img.height, img.data, 4)); break; }
      if (phase === 'pit') {
        if (c.inPit || !track) {
          if (!track) { track = readTrack(mem); n = track.lapSegments; }
          down('a'); up('z'); up('comma'); up('period');
          if (c.inPit) continue;
        }
        // first frame on the track proper
        targets = planTargets(c.trackIndex);
        meta.rejoinIndex = c.trackIndex; meta.lapSegments = n; meta.targets = targets;
        log(`on track at segment ${c.trackIndex} of ${n}; targets ${JSON.stringify(targets.map((t) => `${t.index}:${t.role}`))}`);
        phase = 'drive';
        // view for driving: keep the cockpit
      }
      if (phase === 'drive') {
        const vft = c.speed / 64;
        if (c.inPit) { down('a'); up('z'); up('comma'); up('period'); prevHead = null; continue; }
        const tg = targets[ti];
        const d = tg ? distTo(c, tg.index) : 1e9;
        const finalStop = tg && d < 40 && vft < 8;
        if (finalStop) { up('comma'); up('period'); prevHead = null; } else steer(c);
        let allowed = curveAllowed(c);
        if (tg) allowed = Math.min(allowed, Math.sqrt(2 * BSTOP * Math.max(0, d - 4)));
        if (tg && d < 24 && vft < 6) allowed = 0;
        if (finalStop && vft < 3) { up('z'); up('a'); }
        else if (allowed <= 0.5 || (tg && d <= 2)) { down('z'); up('a'); }
        else if (vft < allowed * 0.97) { down('a'); up('z'); } else if (vft > allowed * 1.07) { down('z'); up('a'); } else { up('a'); up('z'); }
        // the speed field does not reach 0 with no keys held (it jitters at 8-20, < 0.3 ft/s,
        // with the position fixed); holding Z keeps it near 100. So: no keys, |speed| < 40.
        if (tg && Math.abs(c.speed) < 40 && d < 60) stoppedFrames++; else stoppedFrames = 0;
        if (stoppedFrames >= 5) { phase = 'capture'; }
        // moving captures, once per listed stop, at speed
        const turn = hist.length >= 2 ? Math.abs(wrap16(hist[hist.length - 1].camera.heading - hist[hist.length - 2].camera.heading)) : 0;
        if (MOVING_AFTER.includes(stopCount) && !movingDone.has(stopCount) && c.speedMph > 70 && turn >= 150 && s.tick - lastViewSwitch > 3600 && hist.length >= 3 && hist[hist.length - 1].tick - hist[hist.length - 3].tick < 200) {
          movingDone.add(stopCount);
          await capture(`moving after stop ${stopCount}`, { stop: null });
        }
      }
      if (phase === 'capture') {
        allUp();
        const tg = targets[ti];
        const stopRec = { n: stopCount, target: tg, trackIndex: c.trackIndex, along: c.along, lateral: c.lateral, tick: s.tick, frames: [] };
        log(`stopped for target ${ti} (${tg.role} at ${tg.index}) at segment ${c.trackIndex}`);
        const cur = s.view.mode;
        const order = ['chase', 'tv', 'cockpit'];
        const views = order.includes(cur) ? [cur, ...order.filter((v) => v !== cur)] : order;
        for (const v of views) {
          const r = await toView(v);
          const rec = await capture(`stop ${stopCount} ${tg.role}`, { stop: { n: stopCount, target: tg }, viewSwitch: r });
          stopRec.frames.push(rec.k);
        }
        if (TEX_STOPS.includes(stopCount)) {
          await tap('t'); await run(600);
          const r1 = await capture(`stop ${stopCount} ${tg.role} texture toggled`, { stop: { n: stopCount, target: tg }, texToggled: true });
          const r = await toView('chase');
          const r2 = await capture(`stop ${stopCount} ${tg.role} texture toggled`, { stop: { n: stopCount, target: tg }, texToggled: true, viewSwitch: r });
          stopRec.frames.push(r1.k, r2.k);
          await tap('t'); await run(600);
          stopRec.textureBack = settings();
        }
        // drive on in a rotating view (for the moving captures)
        const driveView = ['cockpit', 'chase', 'tv'][stopCount % 3];
        if (reader.read().view.mode !== driveView) { await tap(VIEW_KEY[driveView]); lastViewSwitch = reader.read().tick; }
        meta.stops.push(stopRec);
        stopCount++; ti++;
        lastProgress = { idx: -1, tick: 0 };
        up('z');
        prevHead = null;
        phase = ti < targets.length ? 'drive' : 'done';
        if (phase === 'done') { log('all targets done'); break; }
      }
    }
    if (wall() >= WALL) log('wall-time limit reached');
    allUp();
    meta.ok = true;
  } catch (e) {
    log('FAILED:', e.stack || e.message);
    if (e.lastImage) fs.writeFileSync(path.join(OUT, 'failure.png'), encodePng(e.lastImage.width, e.lastImage.height, e.lastImage.data, 4));
    meta.ok = false; meta.error = e.message;
  }
  meta.wallSeconds = wall();
  saveMeta();
  await emu.stop();
  process.exit(meta.ok ? 0 : 1);
})();
