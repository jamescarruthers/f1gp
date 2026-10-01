// p1-state-watch.cjs - run a Quick Race (Monza) in Node, read the game state
// with lib/f1gp-state.mjs, and log it for the tests in tests/f1gp-state.test.mjs.
//
//   node build-bundle.mjs --autoexec "gp /g" --cycles 25000 --out dist/p1-state-25000.jsdos
//   timeout 240 node probes/p1-state-watch.cjs --tag drive --seconds 195
//   timeout 240 node probes/p1-state-watch.cjs --tag coast --mode coast --seconds 195 --script ""
//
// Modes: drive (default) = autopilot from the state reader (pure pursuit on
// the in-memory centreline, speed from the curvature ahead; same idea as
// probes/p1-fields-record.cjs, rewritten on readState/readTrack); coast = no
// throttle, the player's car stays on the grid.
// --script "t:key,..." taps keys t seconds after the green light (default:
// view keys during lap 1: Up, Up, Home, Left, PgDn, Delete, Right).
//
// Output, out/p1-state/<tag>/:
//   trace.jsonl   every 500 ms: { t, state } (full readState output, crossCheck on)
//   frames.jsonl  every new game frame (DS:2955 changed): tick, frame, session
//                 timer, view, camera, the player's car, and every car compactly
//                 (x, y, pos source, speed, segment index, along, lateral, lap)
//   dash.jsonl    every 250 ms: the dash LCD read from a screenshot (mph, lap,
//                 laps, car, pos, runners, lap time, best) with the tick
//   polls.json    consistency of reads between frames, readState cost
//   ram-green.bin, ram-end.bin   guest linear 0-FFFFF at the green light and at the end
//   shots/*.png, meta.json, log.txt
//
// The dash digit font table is a copy of the one in lib/route.cjs (DIGITS),
// which does not export it.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { start, encodePng } = require('../lib/node-emu.cjs');
const route = require('../lib/route.cjs');

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : dflt; };
const TAG = opt('tag', 'drive');
const MODE = opt('mode', 'drive');
const SECONDS = +opt('seconds', 195);
const BUNDLE = opt('bundle', path.join(__dirname, '..', 'dist', 'p1-state-25000.jsdos'));
const ALAT = +opt('alat', 62), BRAKE = +opt('brake', 78), LAG = +opt('lag', 0.25), DEADBAND = +opt('deadband', 300);
const DEFAULT_SCRIPT = '40:up,46:up,52:home,56:left,62:pagedown,68:delete,74:right';
const SCRIPT = (opt('script', DEFAULT_SCRIPT) || '').split(',').filter(Boolean).map((s) => { const [t, k] = s.split(':'); return { t: +t, key: k, done: false }; });
const OUT = path.join(__dirname, '..', 'out', 'p1-state', TAG);
fs.mkdirSync(path.join(OUT, 'shots'), { recursive: true });

// GLFW key codes route.cjs does not name.
const EXTRA_KEYS = { home: 268, end: 269, pageup: 266, pagedown: 267, delete: 261, insert: 260 };
const keyCode = (k) => (k in EXTRA_KEYS ? EXTRA_KEYS[k] : route.JSDOS_KEYS[k]);
const wrap16 = (v) => (((v & 0xffff) + 0x8000) & 0xffff) - 0x8000;

// ---------------------------------------------------------------- dash LCD
// 6x6 digit font of the dash LCD (copy of lib/route.cjs DIGITS).
const DIGITS = {
  '.####.#....##....##....##....#.####.': 0, '..#....##.....#.....#.....#....###..': 1,
  '.####.#....#...##..##...#.....######': 2, '######....#....##......##....#.####.': 3,
  '....#....##...#.#..#..#.######....#.': 4, '#######.....#####......#.....######.': 5,
  '.####.#.....#####.#....##....#.####.': 6, '######....#....#....#....#.....#....': 7,
  '.####.#....#.####.#....##....#.####.': 8, '.####.#....#.####.....#....#....#...': 9,
};
const BLANK = '.'.repeat(36);
function glyphAt(img, x0, y0) {
  let g = '';
  for (let y = y0; y < y0 + 6; y++) for (let x = x0; x < x0 + 6; x++) {
    const [r, gg, b] = route.px(img, x, y);
    g += r + gg + b < 60 ? '#' : '.';
  }
  return g;
}
// Right-aligned number in glyph cells xs (leading cells may be blank), or null.
function num(img, xs, y) {
  let v = '', started = false;
  for (let i = 0; i < xs.length; i++) {
    const g = glyphAt(img, xs[i], y), d = DIGITS[g];
    if (d === undefined) {
      if (!started && g === BLANK && i < xs.length - 1) continue;
      return null;
    }
    started = true; v += d;
  }
  return started ? Number(v) : null;
}
// "m:ss.mmm" at row y: minute cell 178, seconds 189/196, ms 207/214/221.
function lapTimeAt(img, y) {
  const d = [178, 189, 196, 207, 214, 221].map((x) => DIGITS[glyphAt(img, x, y)]);
  if (d.some((v) => v === undefined)) return null;
  return d[0] * 60000 + (d[1] * 10 + d[2]) * 1000 + d[3] * 100 + d[4] * 10 + d[5];
}
// Layout seen in race screenshots (out/p1-fields/*/shots): row 1 (y 184)
// "MPH nnn  LAP n OF n" or "MPH nnn  LAPTIME m:ss.mmm"; row 2 (y 193)
// "CAR nn  POS nn  RUNNERS nn" or "... BEST m:ss.mmm".
function readDash(img) {
  const d = { mph: route.readMph(img) };
  const lt = lapTimeAt(img, 184);
  if (lt !== null) d.lapTime = lt;
  else { d.lap = num(img, [181, 188], 184); d.laps = num(img, [214, 221], 184); }
  d.car = num(img, [108, 115], 193);
  d.pos = num(img, [140, 147], 193);
  const best = lapTimeAt(img, 193);
  if (best !== null) d.best = best; else d.runners = num(img, [214, 221], 193);
  return d;
}

// ---------------------------------------------------------------- main
(async () => {
  const { attach } = await import(pathToFileURL(path.join(__dirname, '..', 'lib', 'f1gp-mem.mjs')).href);
  const { createReader, readTrack, speedToMph } = await import(pathToFileURL(path.join(__dirname, '..', 'lib', 'f1gp-state.mjs')).href);
  const logf = path.join(OUT, 'log.txt');
  fs.writeFileSync(logf, '');
  const log = (...m) => { const line = m.join(' '); console.log(line); fs.appendFileSync(logf, line + '\n'); };
  const T0 = Date.now();
  const emu = await start(BUNDLE);
  const drv = route.nodeDriver(emu);
  const meta = { tag: TAG, mode: MODE, seconds: SECONDS, bundle: path.relative(path.join(__dirname, '..'), BUNDLE), script: SCRIPT, autopilot: { ALAT, BRAKE, LAG, DEADBAND } };
  const held = new Set();
  const down = (k) => { if (!held.has(k)) { held.add(k); emu.ci.sendKeyEvent(keyCode(k), true); } };
  const up = (k) => { if (held.has(k)) { held.delete(k); emu.ci.sendKeyEvent(keyCode(k), false); } };
  const fds = [];
  const open = (name) => { const fd = fs.openSync(path.join(OUT, name), 'w'); fds.push(fd); return fd; };
  try {
    meta.route = await route.toTrack(drv, { mode: 'quickrace', log });
    log(`green at ${((Date.now() - T0) / 1000).toFixed(1)} s`);
    const tA = performance.now();
    const mem = attach(emu.ci, { requireGame: true });
    meta.attachMs = +(performance.now() - tA).toFixed(2);
    const reader = createReader(mem);
    const track = readTrack(mem);
    const n = track.lapSegments;
    Object.assign(meta, { memBase: mem.memBase, imageSeg: mem.imageSeg, DS: mem.DS, SS: mem.SS, checked: mem.checked, lapSegments: n, pitEntries: track.pit.length });
    fs.writeFileSync(path.join(OUT, 'ram-green.bin'), mem.snapshot(0, 0x100000));
    const st0 = reader.read();
    meta.atGreen = { tick: st0.tick, frame: st0.frame, frameMs: st0.frameMs, session: st0.session, view: st0.view, track: st0.track, playerSlot: st0.view.playerSlot };
    log('meta', JSON.stringify(meta));
    const player = st0.view.playerSlot;

    const traceFd = open('trace.jsonl'), frameFd = open('frames.jsonl'), dashFd = open('dash.jsonl'), ctlFd = open('ctl.jsonl');

    // ------------------------------------------------ autopilot (drive mode)
    let prevHead = null, prevT = null;
    const control = (st, now) => {
      const c = st.cars[player];
      const vft = c.speed / 64;
      const rec = { t: +((now - t0) / 1000).toFixed(2), v: Math.round(vft), idx: c.trackIndex, lat: c.lateral, h: c.heading };
      if (c.inPit || !track.lap[c.trackIndex]) { down('a'); up('z'); up('comma'); up('period'); rec.pit = 1; fs.writeSync(ctlFd, JSON.stringify(rec) + '\n'); return; }
      const si = c.trackIndex;
      const look = Math.max(3, Math.min(14, Math.round(3 + (vft * 0.45) / 16)));
      const tgt = track.lap[(si + look) % n].centre;
      const desired = Math.round((Math.atan2(tgt[0] - c.x, tgt[1] - c.y) / (2 * Math.PI)) * 65536);
      const err = wrap16(desired - c.heading);
      let rate = 0;
      if (prevHead !== null) rate = wrap16(c.heading - prevHead) / Math.max(0.02, (now - prevT) / 1000);
      prevHead = c.heading; prevT = now;
      const pred = err - rate * LAG;
      if (pred > DEADBAND) { down('period'); up('comma'); rec.s = 'R'; }
      else if (pred < -DEADBAND) { down('comma'); up('period'); rec.s = 'L'; }
      else { up('comma'); up('period'); rec.s = '-'; }
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
      if (vft < allowed * 0.97) { down('a'); up('z'); rec.p = 'A'; }
      else if (vft > allowed * 1.07) { down('z'); up('a'); rec.p = 'Z'; }
      else { up('a'); up('z'); rec.p = '-'; }
      rec.allowed = Math.round(allowed); rec.err = err;
      fs.writeSync(ctlFd, JSON.stringify(rec) + '\n');
    };

    // ------------------------------------------------ polling loop
    const t0 = Date.now();
    const poll = { polls: 0, frames: 0, unsettledAtFrame: 0, movedWithoutTick: 0, framesSeenEarly: 0, readUs: [], maxPollGapMs: 0,
      // classification of polls: did the cars move since the last poll without a clock change, and what the
      // two in-read hints said (settled = SS:05C8 >= DS:2C63; c2977 = the DS:2977 counter changed since the clock last changed)
      movedNoTick: { settled: 0, unsettled: 0, c2977: 0, noC2977: 0 },
      quiet: { settled: 0, unsettled: 0, c2977: 0, noC2977: 0 },
      firstOfTick: { settled: 0, unsettled: 0, c2977: 0, noC2977: 0 } };
    let c2977AtTick = mem.ds.u8(0x2977);
    const sig = () => { let h = 0; for (let i = 0; i < 26; i++) { const p = mem.dsLinear + 0x0d1b + i * 0xc0; h = (Math.imul(h, 31) + mem.u16(p + 0x1c) + (mem.u16(p + 0x12) << 3)) | 0; } return h; };
    let lastTick = -1, lastSig = sig(), sigChangedSinceTick = false, lastTickHost = Date.now(), lastPoll = Date.now();
    let nextTrace = t0, nextDash = t0, nextShot = t0, nextCtl = t0;
    let st = st0;
    while (Date.now() - t0 < SECONDS * 1000) {
      const now = Date.now();
      poll.polls++;
      poll.maxPollGapMs = Math.max(poll.maxPollGapMs, now - lastPoll); lastPoll = now;
      const tick = mem.ds.u32(0x2955);
      const sNow = sig();
      const settledNow = mem.ss.u16(0x05c8) >= mem.ds.u16(0x2c63);
      const c2977 = mem.ds.u8(0x2977);
      const cls = tick !== lastTick ? poll.firstOfTick : sNow !== lastSig ? poll.movedNoTick : poll.quiet;
      cls[settledNow ? 'settled' : 'unsettled']++;
      if (tick !== lastTick) c2977AtTick = c2977;
      cls[c2977 !== c2977AtTick ? 'c2977' : 'noC2977']++;
      const quick = reader.read(); // the reader's own flags (carsAhead learned from earlier settled reads)
      cls[quick.carsAhead ? 'carsAhead' : 'notAhead'] = (cls[quick.carsAhead ? 'carsAhead' : 'notAhead'] || 0) + 1;
      if (quick.paused) poll.pausedPolls = (poll.pausedPolls || 0) + 1;
      if (tick !== lastTick) {
        const q0 = performance.now();
        st = reader.read({ crossCheck: true });
        poll.readUs.push((performance.now() - q0) * 1000);
        poll.frames++;
        if (!st.settled) poll.unsettledAtFrame++;
        if (sigChangedSinceTick) poll.framesSeenEarly++;
        sigChangedSinceTick = false;
        lastTick = tick; lastTickHost = now;
        const p = st.cars[player];
        fs.writeSync(frameFd, JSON.stringify({
          t: now - t0, tick: st.tick, frame: st.frame, sessionMs: st.sessionMs, settled: st.settled, carsAhead: st.carsAhead, paused: st.paused,
          view: st.view.raw, viewed: st.view.viewedSlot, camIsCar: st.view.cameraIsCar,
          cam: [st.camera.x, st.camera.y, st.camera.z, st.camera.heading],
          p: { x: p.x, y: p.y, z: p.z, dx: p.derived ? p.derived.x : null, dy: p.derived ? p.derived.y : null, dz: p.derived ? p.derived.z : null,
            v: p.speed, mph: p.speedMph, lap: p.lap, idx: p.trackIndex, along: p.along, lat: p.lateral, h: p.heading,
            last: p.lastLapRaw, start: p.lapStartRaw, pos: p.racePos, gear: p.gear, rpm: p.rpm },
          runners: st.session.runners, inSession: st.inSession, playerSlot: st.playerSlot,
          cars: st.cars.map((c) => [c.x, c.y, c.pos === 'live' ? 1 : c.pos === 'derived' ? 2 : 0, c.speed, c.trackIndex, c.along, c.lateral, c.lap, c.inPit ? 1 : 0, c.racePos, c.retired ? 1 : 0, c.pitState, c.visible ? 1 : 0]),
        }) + '\n');
      } else if (sNow !== lastSig) {
        poll.movedWithoutTick++; sigChangedSinceTick = true;
      }
      lastSig = sNow;
      if (now >= nextTrace) {
        fs.writeSync(traceFd, JSON.stringify({ t: now - t0, state: reader.read({ crossCheck: true }) }) + '\n');
        nextTrace += 500; if (nextTrace < now) nextTrace = now + 500;
      }
      if (MODE === 'drive' && now >= nextCtl) {
        if (now - lastTickHost > 300) { for (const k of ['a', 'z', 'comma', 'period']) up(k); prevHead = null; }
        else control(reader.read(), now);
        nextCtl += 50; if (nextCtl < now) nextCtl = now + 50;
      }
      for (const s of SCRIPT) {
        if (!s.done && now - t0 >= s.t * 1000) {
          s.done = true; down(s.key); await drv.sleep(150); up(s.key);
          log(`t=${((Date.now() - t0) / 1000).toFixed(1)} tap ${s.key}`);
        }
      }
      if (now >= nextDash) {
        const before = mem.ds.u32(0x2955);
        const img = await emu.ci.screenshot();
        const s2 = reader.read();
        const d = { t: Date.now() - t0, tickBefore: before, tick: s2.tick, view: s2.view.raw, viewed: s2.view.viewedSlot, dash: readDash(img), screen: route.identify(img).screen };
        fs.writeSync(dashFd, JSON.stringify(d) + '\n');
        if (now >= nextShot) {
          fs.writeFileSync(path.join(OUT, 'shots', `t${String(Math.round((now - t0) / 1000)).padStart(3, '0')}.png`), encodePng(img.width, img.height, img.data, 4));
          nextShot += 10000;
        }
        nextDash += 250; if (nextDash < now) nextDash = now + 250;
      }
      await drv.sleep(3);
    }
    for (const k of [...held]) up(k);
    fs.writeFileSync(path.join(OUT, 'ram-end.bin'), mem.snapshot(0, 0x100000));
    const us = poll.readUs.sort((a, b) => a - b);
    // cost of readState on the live heap, back to back
    const N = 2000, q0 = performance.now();
    for (let i = 0; i < N; i++) reader.read();
    const backToBackUs = ((performance.now() - q0) * 1000) / N;
    const q1 = performance.now();
    for (let i = 0; i < N; i++) reader.read({ crossCheck: true });
    const crossUs = ((performance.now() - q1) * 1000) / N;
    const q2 = performance.now();
    for (let i = 0; i < 50; i++) readTrack(mem);
    const trackMs = (performance.now() - q2) / 50;
    const summary = {
      polls: poll.polls, frames: poll.frames, seconds: (Date.now() - t0) / 1000,
      pollsPerFrame: +(poll.polls / Math.max(1, poll.frames)).toFixed(2), maxPollGapMs: poll.maxPollGapMs,
      unsettledAtFrame: poll.unsettledAtFrame, movedWithoutTick: poll.movedWithoutTick, framesSeenEarly: poll.framesSeenEarly,
      movedNoTick: poll.movedNoTick, quiet: poll.quiet, firstOfTick: poll.firstOfTick, pausedPolls: poll.pausedPolls || 0,
      readStateUs: { median: us[us.length >> 1], p95: us[Math.floor(us.length * 0.95)], max: us[us.length - 1], backToBack: +backToBackUs.toFixed(2), backToBackCrossCheck: +crossUs.toFixed(2) },
      readTrackMs: +trackMs.toFixed(3),
      speedToMphCheck: speedToMph(13141),
    };
    fs.writeFileSync(path.join(OUT, 'polls.json'), JSON.stringify(summary, null, 1));
    log('summary', JSON.stringify(summary));
    meta.ok = true;
  } catch (e) {
    log('FAILED:', e.stack || e.message);
    if (e.lastImage) fs.writeFileSync(path.join(OUT, 'failure.png'), encodePng(e.lastImage.width, e.lastImage.height, e.lastImage.data, 4));
    meta.ok = false; meta.error = e.message;
  }
  for (const fd of fds) fs.closeSync(fd);
  meta.totalSeconds = (Date.now() - T0) / 1000;
  fs.writeFileSync(path.join(OUT, 'meta.json'), JSON.stringify(meta, null, 1));
  await emu.stop();
  process.exit(meta.ok ? 0 : 1);
})();
