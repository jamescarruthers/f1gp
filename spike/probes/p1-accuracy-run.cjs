// p1-accuracy-run.cjs - record a whole Quick Race (Monza, 3 laps, 26 cars)
// for the Phase 1 done test: the game state from lib/f1gp-state.mjs every
// game frame, the dash LCD every half game second, the view keys pressed,
// and screenshots, until the race is over.
//
//   node build-bundle.mjs --autoexec "gp /g" --cycles 25000 --out dist/p1-accuracy-25000.jsdos
//   timeout 240 node probes/p1-accuracy-run.cjs --tag race1 --warp 2 --bundle dist/p1-accuracy-25000.jsdos
//   node probes/p1-accuracy-check.cjs out/p1-accuracy/race1
//
// A Quick Race takes about 6 minutes of game time, more than one 240 s run.
// --warp W scales the clock DOSBox paces itself by, so the emulated PC runs W
// times faster than real time (probes/p1-accuracy-warp.cjs measured 2.0x at
// 25000 cycles with every frame seen, at most 2.7x; 3.0x at 15000 cycles, but
// there the TV view needs more than the frame's budget, so 25000 it is). The guest sees the same
// machine: DOSBox executes `cycles` instructions per emulated ms, and all
// timing below is in game time (DS:2955), not wall time.
//
// Modes: drive (default) = autopilot on the player's car (the method of
// probes/p1-state-watch.cjs, copied and changed to run once per game frame
// and to use game time); coast = no throttle.
// --views tour|ride picks a key script (SCRIPTS: tour = every view once and a
// TV spell in lap 2; ride = longer rides in computer cars' cockpits);
// --script "t:key,..." taps keys t game seconds after the green light instead.
// --after S records S game seconds after the player finishes (default 60);
// the run also stops when the game clock stops (the results menu), and then
// opens "Race Finishing Times" (results-1.png). --wall S stops after S real
// seconds (default 228). --stall T pauses polling now and then until T game
// seconds (tests the reader's consistency flags with late reads).
// Runs used for the report: race1 = --views tour; race2 = --views ride;
// race3 = --views tour --stall 120 --after 100 --wall 233; all --warp 2 with
// dist/p1-accuracy-25000.jsdos (25000 cycles, like the other Phase 1 runs).
//
// Output, out/p1-accuracy/<tag>/:
//   frames.jsonl  one line per game frame (consistent read when one was seen):
//                 clock, view, camera, flags, every car (see CAR_FIELDS)
//   dash.jsonl    every 500 game ms: the dash LCD (p1-accuracy-lib readDash)
//                 with the clock before and after the screenshot
//   keys.jsonl    each key tap with the clock and the view before it
//   track.json    readTrack() at the green light (centreline from memory)
//   shots/*.png   every 10 game s, at each key tap + 1.5 s, every 2 s after the
//                 finish, end.png, results-*.png (encoded at the end of the run)
//   ram-green.bin, ram-finish.bin, ram-end.bin   1 MB guest RAM dumps
//   meta.json, log.txt
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const L = require('./p1-accuracy-lib.cjs');

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : dflt; };
const TAG = opt('tag', 'race1');
const MODE = opt('mode', 'drive');
const WARP = +opt('warp', 3);
const WALL_LIMIT = +opt('wall', 228);          // stop (and save) after this many real seconds
const AFTER_FINISH = +opt('after', 60);        // game seconds to keep recording after the player finishes
const MAX_GAME = +opt('game', 600);            // game seconds after green, at most
const BUNDLE = opt('bundle', path.join(__dirname, '..', 'dist', 'p1-accuracy-15000.jsdos'));
// --stall T: until T game seconds after the green light, stop polling for a
// random 30-120 real ms every 1.5 game s (the emulator keeps running), so
// some first reads of a frame come late, as a renderer's reads may
const STALL_UNTIL = +opt('stall', 0);
const ALAT = +opt('alat', 62), BRAKE = +opt('brake', 78), LAG = +opt('lag', 0.25), DEADBAND = +opt('deadband', 300);
// view tour: cockpit of the cars ahead/behind, TV camera (and the car ahead
// in TV), chase and reverse chase (and the car behind), back to the cockpit;
// a second TV spell in lap 2
const SCRIPTS = {
  tour: '20:up,26:up,32:down,38:home,44:left,54:up,62:home,70:pagedown,78:down,86:delete,94:home,102:right,'
    + '160:left,175:down,185:home,195:right,215:up,221:home',
  // more time in computer cars' cockpits and in the TV view
  ride: '15:up,30:up,45:up,60:down,75:home,82:left,95:up,105:up,115:home,122:pagedown,130:up,138:delete,146:down,154:home,160:right,'
    + '180:down,195:down,210:down,225:home,235:left,255:down,265:home,275:right,285:up,300:home',
};
const DEFAULT_SCRIPT = SCRIPTS[opt('views', 'tour')];
const SCRIPT = (opt('script', DEFAULT_SCRIPT) || '').split(',').filter(Boolean).map((s) => { const [t, k] = s.split(':'); return { t: +t, key: k, done: false }; });
const OUT = path.join(__dirname, '..', 'out', 'p1-accuracy', TAG);
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(path.join(OUT, 'shots'), { recursive: true });

const realNow = L.installWarp(WARP); // before the emulator loads
const { start, encodePng } = require('../lib/node-emu.cjs');
const route = require('../lib/route.cjs');

const keyCode = (k) => (k in L.EXTRA_KEYS ? L.EXTRA_KEYS[k] : route.JSDOS_KEYS[k]);
const wrap16 = (v) => (((v & 0xffff) + 0x8000) & 0xffff) - 0x8000;

// per-car columns in frames.jsonl (the first 13 are the same as in
// probes/p1-state-watch.cjs frames.jsonl, so the checker reads both)
const CAR_FIELDS = ['x', 'y', 'src', 'speed', 'idx', 'along', 'lat', 'lap', 'inPit', 'racePos', 'retired', 'pitState', 'visible',
  'heading', 'segNr', 'last', 'lapStart', 'z', 'number', 'f23', 'f96', 'gap', 'dir'];
const carRow = (c) => [c.x, c.y, c.pos === 'live' ? 1 : c.pos === 'derived' ? 2 : 0, c.speed, c.trackIndex, c.along, c.lateral, c.lap,
  c.inPit ? 1 : 0, c.racePos, c.retired ? 1 : 0, c.pitState, c.visible ? 1 : 0,
  c.heading, c.segNr, c.lastLapRaw, c.lapStartRaw, c.z, c.number, c.flags.f23, c.flags.f96, c.gapAheadMs, c.direction];

(async () => {
  const { attach } = await import(pathToFileURL(path.join(__dirname, '..', 'lib', 'f1gp-mem.mjs')).href);
  const { createReader, readTrack } = await import(pathToFileURL(path.join(__dirname, '..', 'lib', 'f1gp-state.mjs')).href);
  const logf = path.join(OUT, 'log.txt');
  fs.writeFileSync(logf, '');
  const T0 = Date.now();
  const wall = () => (Date.now() - T0) / 1000;
  const log = (...m) => { const line = `[${wall().toFixed(1)}] ` + m.join(' '); console.log(line); fs.appendFileSync(logf, line + '\n'); };
  const emu = await start(BUNDLE);
  const drv = route.nodeDriver(emu);
  const meta = { tag: TAG, mode: MODE, warp: WARP, bundle: path.relative(path.join(__dirname, '..'), BUNDLE), script: SCRIPT.map((s) => `${s.t}:${s.key}`), carFields: CAR_FIELDS, autopilot: { ALAT, BRAKE, LAG, DEADBAND } };
  const held = new Set();
  const down = (k) => { if (!held.has(k)) { held.add(k); emu.ci.sendKeyEvent(keyCode(k), true); } };
  const up = (k) => { if (held.has(k)) { held.delete(k); emu.ci.sendKeyEvent(keyCode(k), false); } };
  const fds = [];
  const open = (name) => { const fd = fs.openSync(path.join(OUT, name), 'w'); fds.push(fd); return fd; };
  // screenshots are kept in memory and encoded at the end (PNG encoding takes ~10 ms, a third of a frame at warp 2)
  const shots = [];
  const shot = (img, name) => shots.push({ img: { width: img.width, height: img.height, data: img.data }, name, tick: memRef.mem ? memRef.mem.ds.u32(0x2955) : null });
  const flushShots = () => { for (const s of shots.splice(0)) fs.writeFileSync(path.join(OUT, 'shots', s.name), encodePng(s.img.width, s.img.height, s.img.data, 4)); };
  const memRef = { mem: null };
  try {
    meta.route = await route.toTrack(drv, { mode: 'quickrace', log });
    log('green');
    const mem = attach(emu.ci, { requireGame: true });
    memRef.mem = mem;
    const reader = createReader(mem);
    const track = readTrack(mem);
    fs.writeFileSync(path.join(OUT, 'track.json'), JSON.stringify(track));
    fs.writeFileSync(path.join(OUT, 'ram-green.bin'), mem.snapshot(0, 0x100000));
    const st0 = reader.read();
    const player = st0.playerSlot;
    const n = track.lapSegments;
    Object.assign(meta, { memBase: mem.memBase, imageSeg: mem.imageSeg, DS: mem.DS, SS: mem.SS, checked: mem.checked, lapSegments: n, pitEntries: track.pit.length,
      atGreen: { tick: st0.tick, frame: st0.frame, frameMs: st0.frameMs, session: st0.session, view: st0.view, playerSlot: player } });
    log('meta', JSON.stringify(meta.atGreen));
    shot(await emu.ci.screenshot(), 'green.png');

    const frameFd = open('frames.jsonl'), dashFd = open('dash.jsonl'), keyFd = open('keys.jsonl');

    // ------------------------------------------------ autopilot (drive mode), once per game frame
    let prevHead = null, prevTick = null;
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

    // ------------------------------------------------ polling loop
    const greenTick = st0.tick;
    const gameT = (tick) => (tick - greenTick) / 1000;
    let lastTick = -1, pending = null, frames = 0, inconsistentFrames = 0, polls = 0;
    let nextDash = greenTick, nextShot = greenTick, finishTick = null, finishedShotNext = null, raceOverTick = null;
    let lastFrameWall = Date.now();
    const pendingShots = [], releases = [], stalls = [];
    let nextStall = greenTick + 1000;
    let pollsThisTick = 0, lastPollWall = Date.now(), pollGapMs = 0, readsThisTick = 0;
    const raw = () => ({ wc: mem.ds.u8(0x2977), s5c8: mem.ss.u16(0x05c8), c63: mem.ds.u16(0x2c63) });
    const writeFrame = (st, consistent, rw) => {
      frames++;
      if (!consistent) inconsistentFrames++;
      const p = st.cars[player];
      fs.writeSync(frameFd, JSON.stringify({
        t: Date.now() - T0, tick: st.tick, frame: st.frame, sessionMs: st.sessionMs, settled: st.settled, carsAhead: st.carsAhead, consistent,
        wc: st.workCounter, s5c8: rw ? rw.s5c8 : null, c63: rw ? rw.c63 : null, pollsInTick: pollsThisTick, readsInTick: readsThisTick, pollGapMs,
        paused: st.paused, view: st.view.raw, viewed: st.view.viewedSlot, camIsCar: st.view.cameraIsCar,
        cam: [st.camera.x, st.camera.y, st.camera.z, st.camera.heading, st.camera.pitch],
        runners: st.session.runners, leaderLapsDone: st.session.leaderLapsDone, totalLaps: st.session.totalLaps,
        inSession: st.inSession, notInCar: st.notInCar, leaving: st.leavingSession, replay: st.replay, playerSlot: st.playerSlot,
        p: { x: p.x, y: p.y, z: p.z, dx: p.derived ? p.derived.x : null, dy: p.derived ? p.derived.y : null, dz: p.derived ? p.derived.z : null,
          v: p.speed, mph: p.speedMph, lap: p.lap, idx: p.trackIndex, along: p.along, lat: p.lateral, h: p.heading,
          last: p.lastLapRaw, start: p.lapStartRaw, pos: p.racePos, gear: p.gear, rpm: p.rpm },
        order: st.raceOrder,
        cars: st.cars.map(carRow),
      }) + '\n');
    };
    while (true) {
      const now = Date.now();
      polls++;
      if (wall() > WALL_LIMIT) { log('wall-time limit reached'); meta.stoppedBy = 'wall'; break; }
      pollGapMs = now - lastPollWall; lastPollWall = now;
      const tick = mem.ds.u32(0x2955);
      if (tick !== lastTick) {
        if (pending) writeFrame(pending.st, false, pending.rw); // never saw a consistent read of the last frame
        pending = null;
        lastTick = tick;
        lastFrameWall = now;
        pollsThisTick = 1; readsThisTick = 1;
        const rw = raw();
        const st = reader.read({ crossCheck: true });
        if (st.consistent) { writeFrame(st, true, rw); if (MODE === 'drive' && st.inSession && !st.paused) control(st); } else pending = { st, rw };
      } else {
        pollsThisTick++;
        if (pending) {
          readsThisTick++;
          const rw = raw();
          const st = reader.read({ crossCheck: true });
          if (st.tick === pending.st.tick && st.consistent) { writeFrame(st, true, rw); pending = null; if (MODE === 'drive' && st.inSession && !st.paused) control(st); }
        }
      }
      for (let i = releases.length - 1; i >= 0; i--) if (now >= releases[i].at) { up(releases[i].key); releases.splice(i, 1); }
      if (now - lastFrameWall > 300) { for (const k of ['a', 'z', 'comma', 'period']) up(k); prevHead = null; }
      const gt = gameT(tick);
      // key script (game time)
      for (const s of SCRIPT) {
        if (!s.done && gt >= s.t) {
          s.done = true;
          const before = reader.read();
          down(s.key); releases.push({ key: s.key, at: Date.now() + Math.max(40, Math.round(150 / WARP)) }); // released by the loop, so polling goes on
          fs.writeSync(keyFd, JSON.stringify({ t: s.t, key: s.key, tick: before.tick, frame: before.frame, view: before.view.raw, viewed: before.view.viewedSlot,
            viewedPos: before.view.viewedSlot !== null ? before.cars[before.view.viewedSlot].racePos : null, tickAfter: mem.ds.u32(0x2955) }) + '\n');
          log(`game t=${gt.toFixed(1)} tap ${s.key}`);
          pendingShots.push({ tick: tick + 1500, name: `key-${String(s.t).padStart(3, '0')}-${s.key}.png` });
        }
      }
      // dash every 500 game ms; screenshots every 10 game s and after key taps
      if (tick >= nextDash) {
        const before = mem.ds.u32(0x2955);
        const img = await emu.ci.screenshot();
        const after = mem.ds.u32(0x2955);
        const s2 = reader.read();
        fs.writeSync(dashFd, JSON.stringify({ t: Date.now() - T0, gt: +gt.toFixed(3), tickBefore: before, tick: after, view: s2.view.raw, viewed: s2.view.viewedSlot,
          screen: route.identify(img).screen, dash: L.readDash(img) }) + '\n');
        if (tick >= nextShot) { shot(img, `t${String(Math.round(gt)).padStart(3, '0')}.png`); nextShot += 10000; }
        for (let i = pendingShots.length - 1; i >= 0; i--) if (tick >= pendingShots[i].tick) { shot(img, pendingShots[i].name); pendingShots.splice(i, 1); }
        if (finishedShotNext !== null && tick >= finishedShotNext) { shot(img, `finish-${String(Math.round(gameT(tick))).padStart(3, '0')}.png`); finishedShotNext += 2000; }
        nextDash += 500; if (nextDash < tick) nextDash = tick + 500;
      }
      // the finish: the player's lap counter passes the race distance
      if (finishTick === null) {
        const p = reader.read();
        if (p.cars[player].lap > p.session.totalLaps || !p.inSession) {
          finishTick = tick; finishedShotNext = tick;
          log(`player finished / session over at game t=${gt.toFixed(1)} (lap ${p.cars[player].lap}, inSession ${p.inSession})`);
          fs.writeFileSync(path.join(OUT, 'ram-finish.bin'), mem.snapshot(0, 0x100000));
          meta.finish = { tick, gt, lap: p.cars[player].lap, inSession: p.inSession, racePos: p.cars[player].racePos };
        }
      } else if (tick - finishTick > AFTER_FINISH * 1000) { log('recorded enough after the finish'); meta.stoppedBy = 'after-finish'; break; }
      if (raceOverTick === null && now - lastFrameWall > 5000) { raceOverTick = tick; log(`no new game frame for 5 s at game t=${gt.toFixed(1)}`); }
      if (raceOverTick !== null && finishTick !== null && now - lastFrameWall > 8000) { meta.stoppedBy = 'clock stopped'; break; }
      if (gt > MAX_GAME) { meta.stoppedBy = 'game-time limit'; break; }
      if (STALL_UNTIL && gt < STALL_UNTIL && tick >= nextStall) {
        const ms = 30 + Math.floor(Math.random() * 91);
        stalls.push({ tick, ms });
        nextStall = tick + 1500;
        await drv.sleep(ms);
        continue;
      }
      await drv.sleep(1);
    }
    if (pending) writeFrame(pending.st, false, pending.rw);
    for (const k of [...held]) up(k);
    let img = await emu.ci.screenshot();
    shot(img, 'end.png');
    // the results menu: open "Race Finishing Times" (highlighted first) for a check by eye
    if (meta.stoppedBy === 'clock stopped' && wall() < 232) {
      meta.resultsScreen = route.identify(img).screen;
      await drv.press('enter', 150);
      await drv.sleep(2500);
      img = await emu.ci.screenshot(); shot(img, 'results-1.png');
      await drv.sleep(1500);
      img = await emu.ci.screenshot(); shot(img, 'results-2.png');
    }
    fs.writeFileSync(path.join(OUT, 'ram-end.bin'), mem.snapshot(0, 0x100000));
    const stE = reader.read();
    meta.stalls = stalls;
    Object.assign(meta, { frames, inconsistentFrames, polls, endTick: stE.tick, endGameSec: gameT(stE.tick), endScreen: route.identify(img).screen,
      end: { inSession: stE.inSession, notInCar: stE.notInCar, leaving: stE.leavingSession, session: stE.session } });
    meta.ok = true;
  } catch (e) {
    log('FAILED:', e.stack || e.message);
    if (e.lastImage) shot(e.lastImage, 'failure.png');
    meta.ok = false; meta.error = e.message;
  }
  for (const fd of fds) fs.closeSync(fd);
  try { flushShots(); } catch (e) { log('shots:', e.message); }
  meta.wallSeconds = wall();
  meta.realNowCheck = +(realNow() / 1000).toFixed(1);
  fs.writeFileSync(path.join(OUT, 'meta.json'), JSON.stringify(meta, null, 1));
  log('done', JSON.stringify({ frames: meta.frames, inconsistent: meta.inconsistentFrames, stoppedBy: meta.stoppedBy, endGameSec: meta.endGameSec }));
  await emu.stop();
  process.exit(meta.ok ? 0 : 1);
})();
