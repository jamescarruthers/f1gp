// The autopilot of probes/p1-state-watch.cjs drive mode, in the page: it drives the player's car
// round the circuit with the keys (accelerate, brake, steer), from the game's own state (the
// page's reader) and the track's centre line, aiming a few segments ahead and braking for
// the corners it sees coming. Used by the probes (probes/p1-map-lib.mjs) and bench.html.
//
//   import { startAutopilot } from './lib/autopilot.mjs';
//   const ap = startAutopilot(window, { pollMs: 25 }); ... ap.stop();
//
// `win` is the page's window (render.html or map.html: its renderApp or mapApp, and its ci),
// which may be another frame's. Plain ES module, browser only.

import { readTrack } from './f1gp-state.mjs';

/**
 * @param {Window} win  the game page's window
 * @param {{ pollMs?: number }} [o]
 * @returns {{ log: object[], ticks: number, on: boolean, lapSegments: number, stop(): void }}
 */
export function startAutopilot(win, { pollMs = 25 } = {}) {
  const app = win.renderApp ?? win.mapApp, ci = win.ci ?? win.emuCi;
  const reader = app.reader, track = readTrack(app.mem), n = track.lapSegments;
  const ALAT = 62, BRAKE = 78, LAG = 0.25, DEADBAND = 300;
  const K = { a: 65, z: 90, comma: 44, period: 46 };
  const held = new Set();
  const down = (k) => { if (!held.has(k)) { held.add(k); ci.sendKeyEvent(K[k], true); } };
  const up = (k) => { if (held.has(k)) { held.delete(k); ci.sendKeyEvent(K[k], false); } };
  const wrap16 = (v) => (((v & 0xffff) + 0x8000) & 0xffff) - 0x8000;
  let prevHead = null, prevFrame = null, lastFrame = -1;
  const ap = { log: [], ticks: 0, on: true, lapSegments: n };
  win.autopilot = ap;
  const step = () => {
    if (!ap.on) return;
    const st = reader.read();
    if (!st.inSession || st.frame === lastFrame) return;
    lastFrame = st.frame;
    ap.ticks++;
    const c = st.cars[st.playerSlot];
    if (!c || c.retired) { for (const k of [...held]) up(k); return; }
    const vft = c.speed / 64;
    if (c.inPit || !track.lap[c.trackIndex]) { down('a'); up('z'); up('comma'); up('period'); return; }
    const si = c.trackIndex;
    const look = Math.max(3, Math.min(14, Math.round(3 + (vft * 0.45) / 16)));
    const tgt = track.lap[(si + look) % n].centre;
    const desired = Math.round((Math.atan2(tgt[0] - c.x, tgt[1] - c.y) / (2 * Math.PI)) * 65536);
    const err = wrap16(desired - c.heading);
    // heading rate per game second (game time, so it also works with a warped clock)
    let rate = 0;
    if (prevHead !== null && st.frame > prevFrame) rate = wrap16(c.heading - prevHead) / (((st.frame - prevFrame) * st.frameMs) / 1000);
    prevHead = c.heading; prevFrame = st.frame;
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
    let p = '-';
    if (vft < allowed * 0.97) { down('a'); up('z'); p = 'A'; } else if (vft > allowed * 1.07) { down('z'); up('a'); p = 'Z'; } else { up('a'); up('z'); }
    if (ap.ticks % 15 === 0) ap.log.push({ frame: st.frame, idx: si, mph: c.speedMph, lap: c.lap, allowed: Math.round(allowed), p });
  };
  const timer = win.setInterval(step, pollMs);
  ap.stop = () => { ap.on = false; win.clearInterval(timer); for (const k of [...held]) up(k); };
  return ap;
}
