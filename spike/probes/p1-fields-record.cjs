// p1-fields-record.cjs - record all 26 car records and DS/SS globals every
// 100 ms during a Quick Race (Monza), with the dash speed and screenshots.
//
//   node build-bundle.mjs --autoexec "gp /g" --cycles 25000 --out dist/p1-fields-25000.jsdos
//   timeout 240 node probes/p1-fields-record.cjs --tag drive1 --mode drive --seconds 190
//
// Modes:
//   drive  - autopilot: holds A/Z and steers with comma/period, from the
//            game's own state (segment under the player's car, lateral offset,
//            heading). Pure pursuit on the centre line, speed from the
//            curvature of the segments ahead.
//   coast  - no throttle; the player's car stays on the grid and the field
//            passes it.
// --script "t:key,t:key,..." taps keys at t seconds after the green light
// (keys: left right up down home pagedown delete, or any route key name).
//
// Output in out/p1-fields/<tag>/:
//   samples.bin   one record per 100 ms: 32-byte header (magic 'P1FS', index,
//                 host ms since green as f64, held-key mask) + DS:0000-2FFF +
//                 SS:0000-23FF (see p1-fields-lib.cjs)
//   ram-start.bin, ram-end.bin  guest linear 0-FFFFF at green and at the end
//   dash.jsonl    every 250 ms: dash mph (route.readMph), screen name
//   ctl.jsonl     autopilot decisions every 50 ms
//   shots/*.png   screenshot every 5 s (and at script key presses)
//   meta.json     addresses and run info
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { start, encodePng } = require('../lib/node-emu.cjs');
const route = require('../lib/route.cjs');
const { locate } = require('../lib/guest-mem.cjs');
const L = require('./p1-fields-lib.cjs');

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : dflt; };
const TAG = opt('tag', 'run');
const MODE = opt('mode', 'drive');
const SECONDS = +opt('seconds', 190);
const BUNDLE = opt('bundle', path.join(__dirname, '..', 'dist', 'p1-fields-25000.jsdos'));
const STEER_SIGN = +opt('steer-sign', 1); // +1: period (steer right) increases car+1A
const ALAT = +opt('alat', 64); // ft/s^2 allowed lateral acceleration
const BRAKE = +opt('brake', 80); // ft/s^2 assumed braking
const LAG = +opt('lag', 0.25); // s, heading-rate prediction
const DEADBAND = +opt('deadband', 300); // 1/65536 turn
const TARGET_LAT = +opt('target-lat', 0);
const SCRIPT = (opt('script', '') || '').split(',').filter(Boolean).map((s) => { const [t, k] = s.split(':'); return { t: +t, key: k, done: false }; });
const OUT = path.join(__dirname, '..', 'out', 'p1-fields', TAG);
fs.mkdirSync(path.join(OUT, 'shots'), { recursive: true });

// GLFW codes for keys route.cjs does not name.
const EXTRA_KEYS = { home: 268, end: 269, pageup: 266, pagedown: 267, delete: 261, insert: 260 };
const keyCode = (k) => (k in EXTRA_KEYS ? EXTRA_KEYS[k] : route.JSDOS_KEYS[k]);

(async () => {
  const logf = path.join(OUT, 'log.txt');
  fs.writeFileSync(logf, '');
  const log = (...m) => { const line = m.join(' '); console.log(line); fs.appendFileSync(logf, line + '\n'); };
  const T0 = Date.now();
  const emu = await start(BUNDLE);
  const drv = route.nodeDriver(emu);
  const meta = { tag: TAG, mode: MODE, seconds: SECONDS, bundle: BUNDLE, opts: { STEER_SIGN, ALAT, BRAKE, LAG, DEADBAND, TARGET_LAT, SCRIPT }, layout: { DS_WIN: L.DS_WIN, SS_WIN: L.SS_WIN, HDR: L.HDR, REC: L.REC } };
  const held = new Set();
  const keyMask = () => { let m = 0; for (const k of held) m |= L.KEYBITS[k] || 0; return m; };
  const down = (k) => { if (!held.has(k)) { held.add(k); emu.ci.sendKeyEvent(keyCode(k), true); } };
  const up = (k) => { if (held.has(k)) { held.delete(k); emu.ci.sendKeyEvent(keyCode(k), false); } };
  let fd = null, ctlFd = null, dashFd = null;
  try {
    const res = await route.toTrack(drv, { mode: 'quickrace', log });
    meta.route = res;
    const tGreen = Date.now();
    log(`green at ${((tGreen - T0) / 1000).toFixed(1)} s`);
    const mem = locate(emu.ci);
    const DS = mem.imageSeg + L.DS_REL, SS = mem.imageSeg + L.SS_REL;
    const trackSeg = mem.u16(DS, 0x87a1), trackBase = mem.u16(DS, 0x879f);
    const pitSeg = mem.u16(DS, 0x8799), pitBase = mem.u16(DS, 0x8797);
    // number of track segments in a lap: SS:015C is the offset of the entry
    // after the last one (a copy of segment 0 with wNr 0); seen at Monza:
    // 0xD5D6 -> 1189 segments, wNr 0x8000 (s/f flag), 1, 2, ... 1188.
    const nSegs = (mem.u16(SS, 0x15c) - trackBase) / 0x2e;
    let player = -1;
    for (let i = 0; i < L.NCARS; i++) if (mem.u8(DS, L.CAR0 + i * L.CAR_SIZE + 0xac) & 0x80) player = i;
    Object.assign(meta, {
      memBase: mem.memBase, imageSeg: mem.imageSeg, DS, SS, trackSeg, trackBase, pitSeg, pitBase, nSegs,
      endOfLap: mem.u16(SS, 0x15c), player, greenHostMs: tGreen - T0,
    });
    log('meta', JSON.stringify(meta));
    fs.writeFileSync(path.join(OUT, 'ram-start.bin'), mem.snapshot(0, 0x100000));
    const cos = L.makeCos((i) => mem.s16(SS, 0x3264 + i * 2));
    const live = { u8: mem.u8, u16: mem.u16, s16: mem.s16 };
    const segAt = (idx) => L.decodeSeg(live, trackSeg, trackBase + (((idx % nSegs) + nSegs) % nSegs) * 0x2e);

    fd = fs.openSync(path.join(OUT, 'samples.bin'), 'w');
    ctlFd = fs.openSync(path.join(OUT, 'ctl.jsonl'), 'w');
    dashFd = fs.openSync(path.join(OUT, 'dash.jsonl'), 'w');
    const t0 = Date.now();
    let idx = 0, nextSample = t0, nextCtl = t0, nextDash = t0, nextShot = t0;
    let prevHead = null, prevT = null;
    const dsLin = (DS << 4) + L.DS_WIN[0], ssLin = (SS << 4) + L.SS_WIN[0];

    const control = (now) => {
      const p = L.CAR0 + player * L.CAR_SIZE;
      const car = { segPosX: mem.s16(DS, p + 0x0a), segDist: mem.s16(DS, p + 0x1c), heading: mem.u16(DS, p + 0x1a), speed: mem.s16(DS, p + 0x10) };
      const so = mem.u16(DS, p + 0x12), ss = mem.u16(DS, p + 0x14);
      const vft = car.speed / 64;
      const rec = { t: +((now - t0) / 1000).toFixed(2), v: Math.round(vft), lat: car.segPosX, h: car.heading };
      if (ss !== trackSeg) { // pit lane: just drive
        down('a'); up('z'); up('comma'); up('period');
        rec.pit = 1; fs.writeSync(ctlFd, JSON.stringify(rec) + '\n'); return;
      }
      const si = (so - trackBase) / 0x2e;
      const seg = L.decodeSeg(live, ss, so);
      const pos = L.trackToWorld(seg, car, cos);
      const look = Math.max(3, Math.min(14, Math.round(3 + (vft * 0.45) / 16)));
      const ts = segAt(si + look);
      const tc = cos(ts.angleZ), tsn = cos((0x4000 - ts.angleZ) & 0xffff);
      const tx = ts.x19 + (TARGET_LAT * tc) / 16384, ty = ts.y19 - (TARGET_LAT * tsn) / 16384;
      const desired = Math.round((Math.atan2(tx - pos.x19, ty - pos.y19) / (2 * Math.PI)) * 65536);
      const err = L.wrap16(desired - car.heading);
      let rate = 0;
      if (prevHead !== null) rate = L.wrap16(car.heading - prevHead) / Math.max(0.02, (now - prevT) / 1000);
      prevHead = car.heading; prevT = now;
      const pred = err - rate * LAG;
      if (pred * STEER_SIGN > DEADBAND) { down('period'); up('comma'); rec.s = 'R'; }
      else if (pred * STEER_SIGN < -DEADBAND) { down('comma'); up('period'); rec.s = 'L'; }
      else { up('comma'); up('period'); rec.s = '-'; }
      // speed limit from curvature ahead
      let allowed = 1e9, at = -1;
      const done = Math.max(0, Math.min(1, mem.s16(DS, p + 0x1e) / 0x4000));
      for (let k = 0; k <= 45; k++) {
        const a0 = segAt(si + k - 1).angleZ, a1 = segAt(si + k + 2).angleZ;
        const c = Math.abs(L.wrap16(a1 - a0)) / 3; // per segment
        if (c < 8) continue;
        const R = 16 / ((c * 2 * Math.PI) / 65536);
        const vt = Math.sqrt(ALAT * R);
        const d = Math.max(0, (k - done) * 16);
        const va = Math.sqrt(vt * vt + 2 * BRAKE * d);
        if (va < allowed) { allowed = va; at = k; }
      }
      if (vft < allowed * 0.97) { down('a'); up('z'); rec.p = 'A'; }
      else if (vft > allowed * 1.07) { down('z'); up('a'); rec.p = 'Z'; }
      else { up('a'); up('z'); rec.p = '-'; }
      Object.assign(rec, { si, look, err, rate: Math.round(rate), allowed: Math.round(allowed), at, x19: pos.x19, y19: pos.y19 });
      fs.writeSync(ctlFd, JSON.stringify(rec) + '\n');
    };

    // per-frame log of the player's car: one line each time the session
    // timer DS:294F changes (polled every loop turn, ~5 ms)
    const frameFd = fs.openSync(path.join(OUT, 'frames.jsonl'), 'w');
    let lastTimer = -1, lastTimerHost = Date.now();
    const pOff = L.CAR0 + player * L.CAR_SIZE;
    const frameLog = (now) => {
      const tm = mem.u32(DS, 0x294f);
      if (tm === lastTimer) return;
      lastTimer = tm; lastTimerHost = now;
      fs.writeSync(frameFd, JSON.stringify({ t: now - t0, timer: tm, v: mem.s16(DS, pOff + 0x10), so: mem.u16(DS, pOff + 0x12), sd: mem.s16(DS, pOff + 0x1c), X: mem.u32(DS, pOff + 0x28) | 0, Y: mem.u32(DS, pOff + 0x2c) | 0, lap: mem.u8(DS, pOff + 0x22), last: mem.u32(DS, pOff + 0x40), start: mem.u32(DS, pOff + 0x54), gear: mem.s16(DS, pOff + 0x24) << 24 >> 24, rpm: mem.u16(DS, pOff + 0x62) }) + '\n');
    };
    while (Date.now() - t0 < SECONDS * 1000) {
      const now = Date.now();
      frameLog(now);
      if (now >= nextSample) {
        const h = L.encodeHeader(idx, now - t0, keyMask());
        fs.writeSync(fd, Buffer.concat([h, mem.snapshot(dsLin, L.DS_WIN[1] - L.DS_WIN[0]), mem.snapshot(ssLin, L.SS_WIN[1] - L.SS_WIN[0])]));
        idx++; nextSample += 100; if (nextSample < now) nextSample = now + 100;
      }
      if (MODE === 'drive' && now >= nextCtl) {
        // game paused (timer frozen > 300 ms): let go of the driving keys
        if (now - lastTimerHost > 300) { for (const k of ['a', 'z', 'comma', 'period']) up(k); prevHead = null; }
        else control(now);
        nextCtl += 50; if (nextCtl < now) nextCtl = now + 50;
      }
      for (const s of SCRIPT) {
        if (!s.done && now - t0 >= s.t * 1000) {
          s.done = true; down(s.key); await drv.sleep(150); up(s.key);
          log(`t=${((Date.now() - t0) / 1000).toFixed(1)} tap ${s.key}`);
          setTimeout(() => emu.shot(path.join(OUT, 'shots', `key-${String(s.t).padStart(4, '0')}-${s.key}.png`)).catch(() => {}), 1200);
        }
      }
      if (now >= nextDash) {
        const img = await emu.ci.screenshot();
        const d = { t: +((now - t0) / 1000).toFixed(2), sample: idx - 1, mph: route.readMph(img), screen: route.identify(img).screen, timer: mem.u32(DS, 0x294f), memV: mem.s16(DS, L.CAR0 + player * L.CAR_SIZE + 0x10), view: mem.u16(DS, 0x97f).toString(16) + '/' + mem.u8(DS, 0x981).toString(16) };
        fs.writeSync(dashFd, JSON.stringify(d) + '\n');
        if (now >= nextShot) {
          fs.writeFileSync(path.join(OUT, 'shots', `t${String(Math.round((now - t0) / 1000)).padStart(3, '0')}.png`), encodePng(img.width, img.height, img.data, 4));
          nextShot += 5000;
        }
        nextDash += 250; if (nextDash < now) nextDash = now + 250;
      }
      await drv.sleep(5);
    }
    fs.closeSync(frameFd);
    for (const k of [...held]) up(k);
    fs.writeFileSync(path.join(OUT, 'ram-end.bin'), mem.snapshot(0, 0x100000));
    meta.samples = idx; meta.recordSeconds = (Date.now() - t0) / 1000; meta.ok = true;
    log(`recorded ${idx} samples in ${meta.recordSeconds} s`);
  } catch (e) {
    log('FAILED:', e.stack || e.message);
    if (e.lastImage) fs.writeFileSync(path.join(OUT, 'failure.png'), encodePng(e.lastImage.width, e.lastImage.height, e.lastImage.data, 4));
    meta.ok = false; meta.error = e.message;
  }
  for (const f of [fd, ctlFd, dashFd]) if (f !== null) fs.closeSync(f);
  meta.totalSeconds = (Date.now() - T0) / 1000;
  fs.writeFileSync(path.join(OUT, 'meta.json'), JSON.stringify(meta, null, 1));
  await emu.stop();
  process.exit(meta.ok ? 0 : 1);
})();
