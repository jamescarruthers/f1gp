// p1-map-race.mjs - a whole Quick Race (Monza, 3 laps) in map.html, within
// the 240 s cap, by running the emulator faster than real time.
//
// The clock trick is from probes/p1-accuracy-warp.cjs (another agent's
// probe, read only): DOSBox in js-dos paces emulated time by
// performance.now() (wdosbox.js: _emscripten_get_now = () => performance.now()),
// so scaling performance.now() in the page by W makes the emulator run W
// emulated ms per real ms while the host keeps up. The guest still executes
// `cycles` instructions per emulated ms, so the game sees the same machine.
// Only this probe warps the clock; map.html itself does not know about it.
//
//   timeout 240 node probes/p1-map-race.mjs [--tag race1] [--warp 2.2] [--deadline 225]
//
// While the race runs:
//   - an in-page checker (mapApp.onKept) looks at every kept game frame:
//     cars without a position, game frames the map never got a consistent
//     read for, every car's displacement against its speed, lap counter
//     changes and lap times;
//   - every --dashEvery real seconds the probe reads the dash LCD and
//     compares it with the page's state and table (as p1-map-run.mjs);
//   - page screenshots every --shotEvery real seconds.
// The autopilot drives the player's car (probes/p1-map-lib.mjs).
// Frame-time numbers are not meaningful here (the page runs W times more
// game frames per second than normal), so this probe does not report them.
//
// Output: out/p1-map/<tag>/{summary.json, dash.jsonl, laps.json, log.txt, page-*.png, fb-*.png}
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launch, encodePng } from '../lib/browser-emu.mjs';
import { createRequire } from 'node:module';
import { readDash, sample, checkSample, tally, installAutopilot } from './p1-map-lib.mjs';

const require = createRequire(import.meta.url);
const route = require('../lib/route.cjs');
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const TAG = opt('tag', 'race');
const WARP = +opt('warp', 2.2);
const DEADLINE = +opt('deadline', 225) * 1000; // stop by then (s since start), to finish inside a 240 s timeout
const DASH_EVERY = +opt('dashEvery', 1) * 1000;
const SHOT_EVERY = +opt('shotEvery', 15) * 1000;
const BUNDLE = opt('bundle', 'dist/p1-map-25000.jsdos');
const FILTER = opt('filter', 'strict');
const OUT = path.join(import.meta.dirname, '..', 'out', 'p1-map', TAG);
fs.mkdirSync(OUT, { recursive: true });
const T0 = Date.now();
const lines = [];
const log = (...a) => { const l = `${((Date.now() - T0) / 1000).toFixed(1)}s ${a.join(' ')}`; lines.push(l); console.log(l); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// In-page checker (runs in map.html).
//  - onKept: every frame the map keeps: cars without a position, missed game frames, every car's
//    displacement against its speed (ratio = distance / (mean speed x game time)), lap changes, retirements.
//  - onRead: two side streams, the reads readState calls consistent ("reader") and the reads the
//    page's stricter filter keeps ("strict"), each judged per frame by the median ratio over the moving
//    cars: a frame whose cars are one frame ahead of its clock shows up as a median of (g+1)/g, and the
//    frame after it as (g-1)/g, where g is the frame-number step.
function installChecker() {
  const app = window.mapApp;
  const C = window.raceCheck = {
    frames: 0, firstFrame: null, lastFrame: null, missed: 0, gaps: {}, noPos: 0, carFrames: 0,
    steps: 0, stepsChecked: 0, ratioHist: {}, outliers: 0, teleports: 0, outlierSamples: [],
    laps: [], views: {}, sessionEnds: [], leaderLapsDone: 0, runners: null, retired: [], streams: {},
  };
  const median = (a) => { const s = a.slice().sort((x, y) => x - y); return s[s.length >> 1]; };
  const ratio = (c, p, frames, frameMs) => {
    const d = Math.hypot(c.x - p.x, c.y - p.y) / 16384;
    const exp = ((Math.abs(c.speed) + Math.abs(p.speed)) / 2 / 64) * ((frames * frameMs) / 1000);
    return { d, exp, r: exp >= 3 ? d / exp : null };
  };
  const stream = (name) => {
    const S = C.streams[name] = { frames: 0, judged: 0, ok: 0, ahead: 0, behind: 0, other: 0, samples: [] };
    let prev = null;
    return (st) => {
      if (prev && st.frame <= prev.frame) { if (st.frame < prev.frame) prev = null; else return; }
      S.frames++;
      if (prev) {
        const g = st.frame - prev.frame, rs = [];
        for (const c of st.cars) { const p = prev.cars[c.slot]; if (c.pos === 'none' || p.pos === 'none' || c.inPit) continue; const q = ratio(c, p, g, st.frameMs); if (q.r !== null) rs.push(q.r); }
        if (rs.length >= 5) {
          S.judged++;
          const m = median(rs);
          const kind = Math.abs(m - 1) < 0.12 ? 'ok' : Math.abs(m - (g + 1) / g) < 0.12 ? 'ahead' : Math.abs(m - (g - 1) / g) < 0.12 ? 'behind' : 'other';
          S[kind]++;
          if (kind !== 'ok' && S.samples.length < 30) S.samples.push({ frame: st.frame, g, median: +m.toFixed(3), kind, settled: st.settled, consistent: st.consistent, wc: st.workCounter });
        }
      }
      prev = st;
    };
  };
  const readerStream = stream('reader'), strictStream = stream('strict');
  app.onRead = (st, f) => { if (f.reader) readerStream(st); if (f.strict) strictStream(st); };
  let prev = null;
  app.onKept = (st) => {
    C.frames++;
    if (C.firstFrame === null) C.firstFrame = st.frame;
    if (C.lastFrame !== null && st.frame > C.lastFrame + 1) { const g = st.frame - C.lastFrame - 1; C.missed += g; C.gaps[g] = (C.gaps[g] || 0) + 1; }
    C.views[st.view.mode] = (C.views[st.view.mode] || 0) + 1;
    C.leaderLapsDone = st.session.leaderLapsDone;
    C.runners = st.session.runners;
    C.lastFrame = st.frame;
    for (const c of st.cars) {
      C.carFrames++;
      if (c.pos === 'none') C.noPos++;
      if (!prev) continue;
      const p = prev.cars[c.slot];
      if (c.lap !== p.lap) C.laps.push({ frame: st.frame, slot: c.slot, number: c.number, player: c.isPlayer, lap: c.lap, from: p.lap, idx: c.trackIndex, inPit: c.inPit, lastLapMs: c.lastLapMs, racePos: c.racePos });
      if (c.retired && !p.retired) C.retired.push({ frame: st.frame, slot: c.slot, number: c.number, player: c.isPlayer, runners: st.session.runners });
      if (c.pos === 'none' || p.pos === 'none') continue;
      const frames = st.frame - prev.frame;
      const q = ratio(c, p, frames, st.frameMs);
      C.steps++;
      if (q.d > 150 * frames) C.teleports++;
      if (q.r === null) continue; // nearly stopped: the ratio means little
      C.stepsChecked++;
      const b = Math.min(40, Math.max(0, Math.round(q.r * 20))) / 20; // 0.05 buckets, 0..2
      C.ratioHist[b] = (C.ratioHist[b] || 0) + 1;
      if (q.r < 0.8 || q.r > 1.25) { C.outliers++; if (C.outlierSamples.length < 40) C.outlierSamples.push({ frame: st.frame, g: frames, slot: c.slot, number: c.number, ratio: +q.r.toFixed(3), d: +q.d.toFixed(1), exp: +q.exp.toFixed(1), src: c.pos, psrc: p.pos, inPit: c.inPit, pitState: c.pitState, retired: c.retired }); }
    }
    prev = st;
  };
  return true;
}

const summary = { tag: TAG, bundle: BUNDLE, warp: WARP, filter: FILTER, cpus: os.cpus().length, loadavgStart: os.loadavg().map((v) => +v.toFixed(2)) };
let emu;
try {
  emu = await launch({ bundle: BUNDLE, page: 'map.html', input: 'real', viewport: { width: 1440, height: 960 }, query: { audio: 'off', filter: FILTER }, log });
  const { page, driver } = emu;
  await page.evaluate((W) => {
    const real = performance.now.bind(performance), base = real();
    window.realNow = real; window.warp = W;
    performance.now = () => base + (real() - base) * W;
  }, WARP);
  log(`warp ${WARP} on`);
  summary.route = await route.toTrack(driver, { mode: 'quickrace', log });
  log('green');
  await driver.pageShot(path.join(OUT, 'page-green.png'));
  summary.trackInfo = await page.evaluate(() => window.mapApp.trackInfo);
  await page.evaluate(installChecker);
  summary.autopilot = await page.evaluate(installAutopilot, { pollMs: 8 });
  await page.evaluate(() => { window.mapApp.set({ trails: true, trailSeconds: 10 }); window.mapApp.holdStats = true; window.mapApp.resetStats(); });
  const dashFd = fs.openSync(path.join(OUT, 'dash.jsonl'), 'w');
  const checks = [];
  let nextDash = Date.now(), nextShot = Date.now() + SHOT_EVERY, shots = 0, finishedAt = null, lastProgress = 0;
  const tRace = Date.now();
  while (Date.now() - T0 < DEADLINE) {
    const now = Date.now();
    if (now >= nextDash) {
      nextDash += DASH_EVERY;
      const s = await sample(page);
      const d = readDash(s.img);
      const chk = checkSample(s, d);
      checks.push(chk);
      fs.writeSync(dashFd, JSON.stringify({ t: +((now - tRace) / 1000).toFixed(2), dash: d, check: chk, st: s.st, table: s.table, row: s.row }) + '\n');
      if (now >= nextShot) {
        nextShot += SHOT_EVERY;
        const tag = String(Math.round((now - tRace) / 1000)).padStart(3, '0');
        await driver.pageShot(path.join(OUT, `page-t${tag}.png`));
        fs.writeFileSync(path.join(OUT, `fb-t${tag}.png`), encodePng(s.img.width, s.img.height, s.img.data, 4));
        shots++;
      }
    }
    const pr = await page.evaluate(() => {
      const st = window.mapApp.state, c = window.raceCheck;
      const p = st && st.cars[st.playerSlot];
      return { frame: st && st.frame, inSession: st && st.inSession, notInCar: st && st.notInCar, leaving: st && st.leavingSession,
        playerLap: p && p.lap, totalLaps: st && st.session.totalLaps, leaderLapsDone: c.leaderLapsDone, kept: c.frames, missed: c.missed };
    });
    if (now - lastProgress > 10000) { lastProgress = now; log(`frame ${pr.frame} player lap ${pr.playerLap}/${pr.totalLaps} leader done ${pr.leaderLapsDone} kept ${pr.kept} missed ${pr.missed} inSession ${pr.inSession}`); }
    // done: the player has taken the flag (lap counter past the race laps) or the session ended
    if (finishedAt === null && pr.frame && ((pr.playerLap > pr.totalLaps) || !pr.inSession)) {
      finishedAt = Date.now();
      log(`finished: player lap ${pr.playerLap}, inSession ${pr.inSession}, notInCar ${pr.notInCar}`);
      await driver.pageShot(path.join(OUT, 'page-finish.png'));
      await driver.shot(path.join(OUT, 'fb-finish.png'));
    }
    if (finishedAt !== null && Date.now() - finishedAt > 8000) break;
    await sleep(150);
  }
  fs.closeSync(dashFd);
  summary.finished = finishedAt !== null;
  summary.raceRealSeconds = +((Date.now() - tRace) / 1000).toFixed(1);
  await driver.pageShot(path.join(OUT, 'page-end.png'));
  await driver.shot(path.join(OUT, 'fb-end.png'));
  await page.evaluate(() => window.autopilot.stop());
  const rc = await page.evaluate(() => window.raceCheck);
  const stats = await page.evaluate(() => window.mapApp.stats());
  summary.emulator = { emuSpeed: stats.clock && stats.clock.emuSpeed, gameClockRate: stats.clock && stats.clock.rate, gameFpsReal: stats.clock && stats.clock.gameFps, rafFps: stats.raf.fps };
  const final = await page.evaluate(() => {
    const st = window.mapApp.kept;
    return st && { frame: st.frame, sessionMs: st.sessionMs, leaderLapsDone: st.session.leaderLapsDone, runners: st.session.runners,
      order: st.raceOrder.map((s) => { const c = st.cars[s]; return { pos: c.racePos, number: c.number, name: c.name, lap: c.lap, best: c.bestLapMs, last: c.lastLapMs, retired: c.retired, player: c.isPlayer }; }) };
  });
  fs.writeFileSync(path.join(OUT, 'laps.json'), JSON.stringify({ laps: rc.laps, retired: rc.retired, final }, null, 1));
  delete rc.laps;
  summary.check = rc;
  summary.dashChecks = tally(checks);
  summary.shots = shots;
  summary.final = final && { frame: final.frame, leaderLapsDone: final.leaderLapsDone, runners: final.runners, player: final.order.find((o) => o.player), top3: final.order.slice(0, 3) };
  log('dash checks', JSON.stringify(summary.dashChecks));
  log('frame checks', JSON.stringify({ frames: rc.frames, missed: rc.missed, gaps: rc.gaps, noPos: rc.noPos, stepsChecked: rc.stepsChecked, outliers: rc.outliers, teleports: rc.teleports }));
  for (const [k, v] of Object.entries(rc.streams)) log(`stream ${k}: frames ${v.frames} judged ${v.judged} ok ${v.ok} ahead ${v.ahead} behind ${v.behind} other ${v.other}`);
  summary.pageStats = { strictRejected: stats.strictRejected, reads: stats.reads, consistentReads: stats.consistentReads, framesKept: stats.framesKept, missedFrames: stats.missedFrames };
  summary.ok = true;
} catch (e) {
  log('FAILED', e.stack || e.message);
  summary.ok = false; summary.error = String(e.message || e);
  if (emu) await emu.driver.pageShot(path.join(OUT, 'page-failed.png')).catch(() => {});
}
if (emu) {
  summary.pageErrors = emu.pageErrors;
  summary.consoleErrors = emu.consoleMessages.filter((m) => m.type === 'error').slice(0, 20);
  summary.events = await emu.page.evaluate(() => window.emuEvents.filter((e) => e.type !== 'message')).catch(() => null);
}
summary.loadavgEnd = os.loadavg().map((v) => +v.toFixed(2));
summary.totalSeconds = +((Date.now() - T0) / 1000).toFixed(1);
fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(summary, null, 1));
fs.writeFileSync(path.join(OUT, 'log.txt'), lines.join('\n') + '\n');
log('done', summary.ok ? 'ok' : 'FAILED');
if (emu) await emu.close();
process.exit(summary.ok ? 0 : 1);
