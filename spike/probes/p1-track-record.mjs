// p1-track-record.mjs - tie the track-file centreline to the running game.
//
//   node build-bundle.mjs --autoexec "gp /g" --cycles 25000 --out dist/p1-track-25000.jsdos
//   timeout 240 node probes/p1-track-record.mjs --mode quickrace --seconds 195 --tag qr1
//   timeout 120 node probes/p1-track-record.mjs --mode practice --circuit Japan --tag prac-japan
//
// quickrace: route to the Quick Race grid, dump guest RAM at the green light
//   (segment arrays), then drive with an autopilot that knows nothing of the
//   game's track-relative fields: it steers by pure pursuit along OUR
//   centreline (lib/track-file.mjs, world units) from the player's world X/Y
//   (car+28/+2C) and heading (car+1A). If the transform were wrong the car
//   would not get round. Every game frame (DS:294F changes) the player's
//   fields are logged to frames.jsonl; the dash speed is read every 500 ms.
// practice: route to the pit lane of --circuit, dump guest RAM; with
//   --drive N hold A for N s (the game steers in the pit lane) and dump again.
//
// The steering/speed logic follows the idea of probes/p1-fields-record.cjs
// (pure pursuit + curvature speed limit), rewritten here on our centreline.
//
// Output: out/p1-track/<tag>/ram-green.bin (or ram-pits.bin), frames.jsonl,
// dash.jsonl, ctl.jsonl, shots/*.png, meta.json, log.txt.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { parseTrack, compileTrack, cosRaw, sinRaw, CIRCUITS } from '../lib/track-file.mjs';

const require = createRequire(import.meta.url);
const { start, encodePng } = require('../lib/node-emu.cjs');
const route = require('../lib/route.cjs');
const { locate } = require('../lib/guest-mem.cjs');

const HERE = import.meta.dirname;
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const MODE = opt('mode', 'quickrace');
const TAG = opt('tag', MODE);
const SECONDS = +opt('seconds', 195);
const CIRCUIT = opt('circuit', null);
const DRIVE = +opt('drive', 0); // practice: seconds to drive out of the pits before a second dump
const BUNDLE = opt('bundle', path.join(HERE, '..', 'dist', 'p1-track-25000.jsdos'));
const GAME = path.join(HERE, '..', '..', 'original');
const ALAT = +opt('alat', 60), BRAKE = +opt('brake', 75), LAG = +opt('lag', 0.25), DEADBAND = +opt('deadband', 300);
const OUT = path.join(HERE, '..', 'out', 'p1-track', TAG);
fs.mkdirSync(path.join(OUT, 'shots'), { recursive: true });

const DS_REL = 0x1e61, SS_REL = 0x2914, CAR0 = 0x0d1b, CAR_SIZE = 0xc0, NCARS = 26;
const wrap16 = (v) => (((v & 0xffff) + 0x8000) & 0xffff) - 0x8000;

// Which circuit is in memory: compare the live segment array with all 16
// compiled tracks. Entries are matched by their number (+1A): track segments
// carry their index (bit 8000h marks the start/finish), pit-lane segments
// 2000h + index of the 0x86 section + pit index. (In practice mode, with the
// player in the pit lane, the game swaps the pit lane into the track array.)
function identifyCircuit(mem, trackSeg, trackBase) {
  let best = null;
  for (let i = 1; i <= 16; i++) {
    const t = parseTrack(new Uint8Array(fs.readFileSync(path.join(GAME, `f1ct${String(i).padStart(2, '0')}.dat`))));
    const { segs } = compileTrack(t);
    let n = 0, hit = 0;
    for (let k = 0; k < segs.length - 1; k += 3) {
      const o = trackBase + k * 0x2e, nr = mem.u16(trackSeg, o + 0x1a) & 0x7fff;
      if (nr >= 0x2000 || nr >= segs.length) continue;
      const f = mem.u8(trackSeg, o + 0x21);
      const x = (mem.s16(trackSeg, o + 4) << 3) | (f & 7), y = (mem.s16(trackSeg, o + 8) << 3) | ((f >> 4) & 7);
      n++; if (x === segs[nr].x && y === segs[nr].y) hit++;
    }
    const rec = { file: i, name: CIRCUITS[i - 1], lapSegs: segs.length - 1, checked: n, exact: hit };
    if (n > 50 && (!best || hit / n > best.exact / best.checked)) best = rec;
  }
  return best && best.exact / best.checked > 0.99 ? best : null;
}

const T0 = Date.now();
const logf = path.join(OUT, 'log.txt');
fs.writeFileSync(logf, '');
const log = (...m) => { const l = m.join(' '); console.log(l); fs.appendFileSync(logf, l + '\n'); };
const meta = { tag: TAG, mode: MODE, seconds: SECONDS, circuitAsked: CIRCUIT, bundle: BUNDLE, opts: { ALAT, BRAKE, LAG, DEADBAND } };

const emu = await start(BUNDLE);
const drv = route.nodeDriver(emu);
const held = new Set();
const down = (k) => { if (!held.has(k)) { held.add(k); emu.ci.sendKeyEvent(route.JSDOS_KEYS[k], true); } };
const up = (k) => { if (held.has(k)) { held.delete(k); emu.ci.sendKeyEvent(route.JSDOS_KEYS[k], false); } };
const fds = [];
const open = (n) => { const fd = fs.openSync(path.join(OUT, n), 'w'); fds.push(fd); return fd; };

try {
  const res = await route.toTrack(drv, MODE === 'quickrace' ? { mode: 'quickrace', log } : { circuit: CIRCUIT, log });
  meta.route = res;
  const mem = locate(emu.ci);
  const DS = mem.imageSeg + DS_REL, SS = mem.imageSeg + SS_REL;
  const trackSeg = mem.u16(DS, 0x87a1), trackBase = mem.u16(DS, 0x879f);
  const pitSeg = mem.u16(DS, 0x8799), pitBase = mem.u16(DS, 0x8797);
  const endOfLap = mem.u16(SS, 0x15c);
  const nSegs = (endOfLap - trackBase) / 0x2e;
  let player = -1;
  for (let i = 0; i < NCARS; i++) if (mem.u8(DS, CAR0 + i * CAR_SIZE + 0xac) & 0x80) player = i;
  const circuit = identifyCircuit(mem, trackSeg, trackBase);
  Object.assign(meta, { memBase: mem.memBase, imageSeg: mem.imageSeg, DS, SS, trackSeg, trackBase, pitSeg, pitBase, endOfLap, nSegs, player, circuit, circuitIndexSS1236: mem.u16(SS, 0x1236) });
  log('meta', JSON.stringify(meta));
  fs.writeFileSync(path.join(OUT, MODE === 'quickrace' ? 'ram-green.bin' : 'ram-pits.bin'), mem.snapshot(0, 0x100000));
  await emu.shot(path.join(OUT, 'shots', 'start.png'));

  // ---- autopilot on OUR centreline (needs the circuit)
  let control = null, resetAuto = () => {}, ctlFd = null;
  if (circuit) {
    const track = parseTrack(new Uint8Array(fs.readFileSync(path.join(GAME, `f1ct${String(circuit.file).padStart(2, '0')}.dat`))));
    const { segs: all } = compileTrack(track);
    const segs = all.slice(0, all.length - 1); // the last TLU is the start again
    const N = segs.length;
    const S = (i) => segs[((i % N) + N) % N];
    const p = CAR0 + player * CAR_SIZE;
    let near = -1;
    const nearest = (x, y) => {
      let best = Infinity, bi = 0;
      const range = near < 0 ? [0, N] : [near - 8, near + 40];
      for (let i = range[0]; i < range[1]; i++) {
        const s = S(i), d = (s.x - x) ** 2 + (s.y - y) ** 2;
        if (d < best) { best = d; bi = ((i % N) + N) % N; }
      }
      near = bi; return bi;
    };
    ctlFd = open('ctl.jsonl');
    let prevHead = null, prevT = null;
    control = (now) => {
      const X = mem.u32(DS, p + 0x28) | 0, Y = mem.u32(DS, p + 0x2c) | 0;
      const x = X / 256, y = Y / 256;                     // our fine units
      const head = mem.u16(DS, p + 0x1a), v = mem.s16(DS, p + 0x10) / 64; // ft/s
      const i = nearest(x, y);
      const look = Math.max(3, Math.min(14, Math.round(3 + (v * 0.45) / 16)));
      const tg = S(i + look);
      const desired = Math.round((Math.atan2(tg.x - x, tg.y - y) / (2 * Math.PI)) * 65536);
      const err = wrap16(desired - head);
      let rate = 0;
      if (prevHead !== null) rate = wrap16(head - prevHead) / Math.max(0.02, (now - prevT) / 1000);
      prevHead = head; prevT = now;
      const pred = err - rate * LAG;
      let s = '-';
      if (pred > DEADBAND) { down('period'); up('comma'); s = 'R'; }
      else if (pred < -DEADBAND) { down('comma'); up('period'); s = 'L'; }
      else { up('comma'); up('period'); }
      // speed: corner radius from our segment headings ahead
      let allowed = 1e9;
      for (let k = 0; k <= 45; k++) {
        const c = Math.abs(wrap16(S(i + k + 2).angle - S(i + k - 1).angle)) / 3;
        if (c < 8) continue;
        const R = 16 / ((c * 2 * Math.PI) / 65536);       // ft
        const va = Math.sqrt(ALAT * R + 2 * BRAKE * Math.max(0, k - 0.5) * 16);
        allowed = Math.min(allowed, va);
      }
      let pd = '-';
      if (v < allowed * 0.97) { down('a'); up('z'); pd = 'A'; }
      else if (v > allowed * 1.07) { down('z'); up('a'); pd = 'Z'; }
      else { up('a'); up('z'); }
      fs.writeSync(ctlFd, JSON.stringify({ t: now - T0, i, look, err, rate: Math.round(rate), s, pd, v: Math.round(v), allowed: Math.round(allowed) }) + '\n');
    };
    resetAuto = () => { near = -1; prevHead = null; };
  }

  if (MODE === 'practice' && DRIVE > 0) {
    // drive out of the pits: hold A while the player's segment is a pit-lane
    // one (the game steers there), then the autopilot; log which array the
    // player's segment pointer is in; dump again after DRIVE s on the track
    const p = CAR0 + player * CAR_SIZE;
    const trail = [];
    const t0 = Date.now();
    let onTrackSince = null, nextLog = t0;
    while (Date.now() - t0 < 100000) {
      const now = Date.now();
      const so = mem.u16(DS, p + 0x12), ss = mem.u16(DS, p + 0x14), nr = mem.u16(ss, so + 0x1a);
      const inPit = (nr & 0x2000) !== 0;
      if (inPit || !control) { // about 50 mph at most in the pit lane
        const v = mem.s16(DS, p + 0x10);
        if (v < 4200) { down('a'); up('z'); } else if (v > 5000) { up('a'); down('z'); } else { up('a'); up('z'); }
        up('comma'); up('period'); resetAuto();
      }
      else { if (onTrackSince === null) onTrackSince = now; control(now); }
      if (now >= nextLog) {
        trail.push({ t: now - t0, so, ss, nr, v: mem.s16(DS, p + 0x10), lat: mem.s16(DS, p + 0x0a), track0nr: mem.u16(trackSeg, trackBase + 0x1a), pit0nr: mem.u16(pitSeg, pitBase + 0x1a), end: mem.u16(SS, 0x15c) });
        nextLog += 1000;
      }
      if (onTrackSince !== null && now - onTrackSince > DRIVE * 1000) break;
      await drv.sleep(50);
    }
    for (const k of [...held]) up(k);
    meta.trail = trail; meta.onTrackAfterMs = onTrackSince && onTrackSince - t0;
    fs.writeFileSync(path.join(OUT, 'ram-after.bin'), mem.snapshot(0, 0x100000));
    await emu.shot(path.join(OUT, 'shots', 'after.png'));
  }

  if (MODE === 'quickrace') {
    if (!circuit) throw new Error('circuit not identified');
    const p = CAR0 + player * CAR_SIZE;
    const frameFd = open('frames.jsonl'), dashFd = open('dash.jsonl');
    let lastTimer = -1, lastTimerHost = Date.now();
    const frameLog = (now) => {
      const tm = mem.u32(DS, 0x294f);
      if (tm === lastTimer) return;
      lastTimer = tm; lastTimerHost = now;
      fs.writeSync(frameFd, JSON.stringify({
        t: now - T0, timer: tm,
        X: mem.u32(DS, p + 0x28) | 0, Y: mem.u32(DS, p + 0x2c) | 0, Z: mem.s16(DS, p + 0x08),
        head: mem.u16(DS, p + 0x1a), dir: mem.u16(DS, p + 0x00), v: mem.s16(DS, p + 0x10),
        so: mem.u16(DS, p + 0x12), ss: mem.u16(DS, p + 0x14), lat: mem.s16(DS, p + 0x0a), f0c: mem.s16(DS, p + 0x0c),
        len: mem.s16(DS, p + 0x16), dist: mem.s16(DS, p + 0x1c), done: mem.s16(DS, p + 0x1e),
        lap: mem.u8(DS, p + 0x22), last: mem.u32(DS, p + 0x40), lapStart: mem.u32(DS, p + 0x54), f7e: mem.u8(DS, p + 0x7e),
      }) + '\n');
    };
    const t0 = Date.now();
    let nextCtl = t0, nextDash = t0, nextShot = t0;
    while (Date.now() - t0 < SECONDS * 1000) {
      const now = Date.now();
      frameLog(now);
      if (now >= nextCtl) {
        if (now - lastTimerHost > 300) { for (const k of ["a", "z", "comma", "period"]) up(k); resetAuto(); }
        else control(now);
        nextCtl += 50; if (nextCtl < now) nextCtl = now + 50;
      }
      if (now >= nextDash) {
        const img = await emu.ci.screenshot();
        fs.writeSync(dashFd, JSON.stringify({ t: now - T0, timer: mem.u32(DS, 0x294f), mph: route.readMph(img), v: mem.s16(DS, p + 0x10) }) + '\n');
        if (now >= nextShot) {
          fs.writeFileSync(path.join(OUT, 'shots', `t${String(Math.round((now - t0) / 1000)).padStart(3, '0')}.png`), encodePng(img.width, img.height, img.data, 4));
          nextShot += 15000;
        }
        nextDash += 500; if (nextDash < now) nextDash = now + 500;
      }
      await drv.sleep(5);
    }
    for (const k of [...held]) up(k);
    fs.writeFileSync(path.join(OUT, 'ram-end.bin'), mem.snapshot(0, 0x100000));
  }
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
