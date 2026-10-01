// p1-camera-record.cjs - drive a Quick Race and record the game's DS and SS
// segments once per game frame (and every 100 ms when no frame comes), plus a
// fast log of the frame/timer counters at every poll, while a scripted
// sequence of view keys, pause and menu keys is played.
//
//   timeout 240 node probes/p1-camera-record.cjs dist/p1-camera-15fps.jsdos RUN SCRIPT [--drive 1]
//
// Output: out/p1-camera/RUN/{rec.bin, fast.bin, meta.json, *.png}. The file
// format is described in p1-camera-lib.cjs. SCRIPT is one of the names in
// SCRIPTS below.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const { start, KEYS } = require(path.join(root, 'lib', 'node-emu.cjs'));
const route = require(path.join(root, 'lib', 'route.cjs'));
const { locate } = require(path.join(root, 'lib', 'guest-mem.cjs'));
const L = require('./p1-camera-lib.cjs');

const [bundle, runName, scriptName] = process.argv.slice(2);
if (!bundle || !runName || !scriptName) { console.error('usage: bundle run script'); process.exit(2); }
const OUT = path.join(root, 'out', 'p1-camera', runName);
fs.mkdirSync(OUT, { recursive: true });

// Steps: [seconds after green, action, arg]. Actions: down/up (hold/release
// a key), tap (press 150 ms), shot (screenshot name), end.
const SCRIPTS = {
  // View modes and viewed car, then pause and the Esc menu.
  views: [
    [0, 'down', 'a'],
    [3, 'shot', 'cockpit0'],
    [6, 'tap', 'left'], [8, 'shot', 'tv1'], [12, 'shot', 'tv2'],
    [14, 'tap', 'right'], [16, 'shot', 'cockpit1'],
    [18, 'tap', 'pagedown'], [20, 'shot', 'chase1'], [23, 'shot', 'chase2'],
    [24, 'tap', 'delete'], [26, 'shot', 'rchase1'], [29, 'shot', 'rchase2'],
    [30, 'tap', 'right'], [32, 'shot', 'cockpit2'],
    [33, 'tap', 'up'], [35, 'shot', 'ahead1'],
    [37, 'tap', 'up'], [39, 'shot', 'ahead2'],
    [41, 'tap', 'down'], [43, 'shot', 'back1'],
    [45, 'tap', 'home'], [47, 'shot', 'own1'],
    [49, 'tap', 'left'], [51, 'shot', 'tv3'],
    [53, 'tap', 'up'], [55, 'shot', 'tvahead'],
    [57, 'tap', 'home'], [58.5, 'shot', 'tvown'],
    [60, 'tap', 'right'], [62, 'shot', 'cockpit3'],
    [63, 'tap', 'p'], [65, 'shot', 'paused'], [69, 'tap', 'p'], [71, 'shot', 'unpaused'],
    [73, 'tap', 'esc'], [75, 'shot', 'escmenu'], [78, 'tap', 'esc'], [80, 'shot', 'afteresc'],
    [83, 'end'],
  ],
  // Just drive in the cockpit for 30 s (frame-rate comparison), with one
  // pause in the middle.
  drive: [
    [0, 'down', 'a'],
    [5, 'shot', 'drive5'],
    [20, 'shot', 'drive20'],
    [22, 'tap', 'p'], [25, 'shot', 'paused'], [28, 'tap', 'p'],
    [34, 'shot', 'drive34'],
    [35, 'end'],
  ],
  // Pause, then R: replay of the last 20 s; a view key during the replay.
  replay: [
    [0, 'down', 'a'],
    [18, 'shot', 'before'],
    [20, 'tap', 'p'], [21, 'shot', 'paused'],
    [22, 'tap', 'r'], [23, 'shot', 'replay1'], [26, 'shot', 'replay2'],
    [28, 'tap', 'left'], [30, 'shot', 'replaytv'], [34, 'shot', 'replay3'],
    [38, 'shot', 'replay4'], [42, 'shot', 'replay5'], [45, 'shot', 'replay6'],
    [46, 'tap', 'p'], [48, 'shot', 'after1'], [50, 'tap', 'p'], [52, 'shot', 'after2'],
    [54, 'end'],
  ],
  // Stay on the grid: lights already green, no throttle; then TV view for
  // a camera that stays still.
  tvstill: [
    [2, 'tap', 'left'], [4, 'shot', 'tv'], [8, 'shot', 'tv2'], [10, 'end'],
  ],
};

const keyCode = (k) => (k in L.XKEYS ? L.XKEYS[k] : KEYS[k]);

(async () => {
  const script = SCRIPTS[scriptName];
  if (!script) throw new Error(`unknown script ${scriptName}`);
  const emu = await start(path.join(root, bundle));
  const drv = route.nodeDriver(emu);
  const T0 = Date.now();
  const routeInfo = await route.toTrack(drv, { mode: 'quickrace', log: (m) => console.error(m) });
  const mem = locate(emu.ci);
  const lay = L.layout(mem.imageSeg);
  const { DS, SS } = lay;
  console.error(`route ${((Date.now() - T0) / 1000).toFixed(1)} s, imageSeg ${mem.imageSeg.toString(16)}, region ${lay.len} bytes`);

  // One-time copy of the track and pit-lane segment arrays (64 KB each,
  // segments from DS:87A1 and DS:8799) for track-to-world conversions.
  const trkSeg = mem.u16(DS, 0x87a1), pitSeg = mem.u16(DS, 0x8799);
  fs.writeFileSync(path.join(OUT, 'track.bin'), Buffer.concat([mem.snapshot(trkSeg << 4, 0x10000), mem.snapshot(pitSeg << 4, 0x10000)]));
  const recFd = fs.openSync(path.join(OUT, 'rec.bin'), 'w');
  const fastFd = fs.openSync(path.join(OUT, 'fast.bin'), 'w');
  const events = [];
  let held = 0, nrec = 0, polls = 0, pollsSince = 0, lastClk = -1, lastRecT = -1e9;
  let prevFast = null;
  const gaps = [];
  let lastPollT = null;
  const t0 = performance.now();
  const now = () => performance.now() - t0;
  const fastBuf = Buffer.alloc(L.FAST);

  function record(type) {
    const t = now();
    fs.writeSync(recFd, L.encodeHeader(nrec++, type, held, t, pollsSince));
    fs.writeSync(recFd, mem.snapshot(lay.base, lay.len));
    pollsSince = 0; lastRecT = t;
  }

  function poll() {
    const t = now();
    if (lastPollT !== null) gaps.push(t - lastPollT);
    lastPollT = t;
    polls++; pollsSince++;
    const f = [mem.u16(SS, 0x5d2), mem.u16(SS, 0x5c8), mem.u32(DS, 0x2955), mem.u32(DS, 0x294f),
      mem.u16(DS, 0x2c63), mem.u8(DS, 0x981), mem.u16(DS, 0x97d), mem.u16(DS, 0x97f)];
    if (!prevFast || f.some((v, i) => v !== prevFast[i])) {
      fastBuf.fill(0);
      fastBuf.writeDoubleLE(t, 0); fastBuf.writeUInt16LE(f[0], 8); fastBuf.writeUInt16LE(f[1], 10);
      fastBuf.writeUInt32LE(f[2], 12); fastBuf.writeUInt32LE(f[3], 16); fastBuf.writeUInt16LE(f[4], 20);
      fastBuf[22] = f[5]; fastBuf.writeUInt16LE(f[6], 24); fastBuf.writeUInt16LE(f[7], 26);
      fs.writeSync(fastFd, fastBuf);
      prevFast = f;
    }
    if (f[2] !== lastClk) { lastClk = f[2]; record(1); }
    else if (t - lastRecT > 100) record(2);
  }
  const timer = setInterval(poll, 1);

  const sleepUntil = async (sec) => { const ms = sec * 1000 - now(); if (ms > 0) await new Promise((r) => setTimeout(r, ms)); };
  const shots = [];
  for (const [sec, action, arg] of script) {
    await sleepUntil(sec);
    const t = now();
    if (action === 'down') { emu.ci.sendKeyEvent(keyCode(arg), true); held |= L.KEYBITS[arg] || 0; }
    else if (action === 'up') { emu.ci.sendKeyEvent(keyCode(arg), false); held &= ~(L.KEYBITS[arg] || 0); }
    else if (action === 'tap') {
      emu.ci.sendKeyEvent(keyCode(arg), true); held |= L.KEYBITS[arg] || 0;
      await new Promise((r) => setTimeout(r, 150));
      emu.ci.sendKeyEvent(keyCode(arg), false); held &= ~(L.KEYBITS[arg] || 0);
    } else if (action === 'shot') {
      const file = path.join(OUT, `${String(shots.length).padStart(2, '0')}-${arg}.png`);
      await emu.shot(file); shots.push({ t, name: arg, file: path.basename(file) });
    } else if (action === 'end') break;
    events.push({ t, sec, action, arg });
    console.error(`${(t / 1000).toFixed(2)} s ${action} ${arg || ''}`);
  }
  clearInterval(timer);
  fs.closeSync(recFd); fs.closeSync(fastFd);

  gaps.sort((a, b) => a - b);
  const q = (p) => gaps[Math.floor(p * (gaps.length - 1))];
  const meta = {
    bundle, script: scriptName, imageSeg: mem.imageSeg, trackSeg: trkSeg, pitSeg, memBase: mem.memBase, layout: lay,
    route: routeInfo, records: nrec, polls, pollGapMs: { p10: q(0.1), p50: q(0.5), p90: q(0.9), p99: q(0.99), max: gaps[gaps.length - 1] },
    events, shots,
  };
  fs.writeFileSync(path.join(OUT, 'meta.json'), JSON.stringify(meta, null, 1));
  console.error(JSON.stringify({ records: nrec, polls, pollGapMs: meta.pollGapMs }));
  for (const k of ['a', 'z', 'comma', 'period']) emu.ci.sendKeyEvent(keyCode(k), false);
  await emu.stop();
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
