// Pace: the game's frame rate, the emulated CPU speed, and which two game
// frames the page draws between.
//
// Frame rate: SS:1230 is the game's frame length in 300 Hz ticks (20 = 15 fps,
// from F1PREFS.DAT). The game derives its physics step and other per-frame
// values from it when a session loads (0:7CAF), so it is set in the menus,
// never during a session. The fastest safe setting is 10 ticks (30 fps):
// DS:0156 = 4000000h / step is used in signed multiplies by the physics, and
// a step under 10 ticks takes it past 7FFFh (docs/memory-map.md).
//
// CPU: with the game's 3D drawing replaced (overlay.mjs) a frame's work is
// small, so the emulator can run at fewer cycles, which leaves the browser's
// main thread (where js-dos direct mode runs the emulator) free for drawing.
// The governor raises the cycles again when the game's load (DS:2C63, ticks of
// work in the last frame, against SS:1230) climbs, and outside the race.
//
// Pacer: game frames arrive in bursts. The page draws at a render clock one
// game frame behind the newest frame, moving with real time and pulled gently
// towards that target, and blends between the two frames around it.
//
// Plain ES module, no Node APIs.

const SS_FRAME_TICKS = 0x1230, DS_WORK_TICKS = 0x2c63;

/** Ticks per frame for a frame rate: 300 / fps, 10 (30 fps) to 37 (8 fps). */
export function frameTicks(fps) {
  return Math.min(37, Math.max(10, Math.round(300 / fps)));
}

const u16 = (mem, lin) => { const H = mem.heap(), p = mem.memBase + lin; return H[p] | (H[p + 1] << 8); };

/** The game's frame-rate setting in ticks (SS:1230). */
export function readFrameTicks(mem) { return u16(mem, (mem.SS << 4) + SS_FRAME_TICKS); }

/** Ticks of work the game's last frame took (DS:2C63). */
export function readWorkTicks(mem) { return u16(mem, (mem.DS << 4) + DS_WORK_TICKS); }

/**
 * Set the game's frame rate. Only outside a session: the physics step is
 * derived from it when a session loads.
 * @returns {boolean} true if it changed
 */
export function setFrameRate(mem, fps) {
  const t = frameTicks(fps), p = mem.memBase + (mem.SS << 4) + SS_FRAME_TICKS, H = mem.heap();
  if ((H[p] | (H[p + 1] << 8)) === t) return false;
  H[p] = t & 0xff; H[p + 1] = t >> 8;
  return true;
}

/**
 * The emulated CPU speed. update() once per game frame; send(cycles) is called
 * when the speed should change.
 * @param {{ send: (cycles: number) => void, steps?: number[], high?: number, up?: number, down?: number, hold?: number }} o
 *   steps: speeds while the fill runs, lowest first; high: the speed otherwise;
 *   up: raise a step when a frame's work reaches this share of the frame;
 *   down: lower a step after `hold` ms with every frame under this share.
 */
export function cyclesGovernor(o) {
  const steps = o.steps ?? [8000, 12000, 16000, 25000];
  const high = o.high ?? 25000, up = o.up ?? 0.6, down = o.down ?? 0.3, hold = o.hold ?? 10000;
  let level = 0, current = null, quietSince = null;
  const set = (c) => { if (c !== current) { current = c; o.send(c); } };
  return {
    get cycles() { return current; },
    /**
     * @param {{ racing: boolean, work?: number, ticks?: number, now: number }} s
     *   racing: the fill runs in a race; work, ticks: DS:2C63 and SS:1230
     */
    update(s) {
      if (!s.racing) { level = 0; quietSince = null; set(high); return current; }
      const share = s.ticks ? s.work / s.ticks : 0;
      if (share >= up && level < steps.length - 1) { level++; quietSince = null; }
      else if (share < down) {
        if (quietSince === null) quietSince = s.now;
        else if (s.now - quietSince >= hold && level > 0) { level--; quietSince = s.now; }
      } else quietSince = null;
      set(steps[level]);
      return current;
    },
  };
}

/**
 * The page's render clock over the game's frames.
 *   const p = framePacer(); p.add(frame, now) for each new game frame
 *   ({ t: game time in ms, ... }); p.pick(now) -> { a, b, alpha }
 * @param {{ smooth?: boolean, keep?: number }} [o]
 */
export function framePacer(o = {}) {
  const frames = [], keep = o.keep ?? 8;
  let t = null, at = 0;
  return {
    frames,
    get latest() { return frames.length ? frames[frames.length - 1] : null; },
    /** A new game frame: f.t its game time (ms), f.step its length (ms). */
    add(f) {
      const last = frames[frames.length - 1];
      if (last && f.t <= last.t) { frames.length = 0; t = null; } // a new session or a replay
      frames.push(f);
      if (frames.length > keep) frames.shift();
    },
    clear() { frames.length = 0; t = null; },
    /**
     * The two frames to draw between, and how far: at the render clock, one
     * frame behind the newest. `still` (paused) shows the newest frame.
     * Frames further apart than `apart(a, b)` says are not blended.
     */
    pick(now, still = false, apart = null) {
      const last = frames[frames.length - 1];
      if (!last) return null;
      if (o.smooth === false || still || frames.length < 2) { t = null; return { a: last, b: last, alpha: 1 }; }
      const step = last.step, target = last.t - step;
      if (t === null || Math.abs(t - target) > 4 * step) t = target;
      else { t += now - at; t += (target - t) * 0.05; }
      at = now;
      if (t > last.t) t = last.t;
      for (let i = frames.length - 1; i > 0; i--) {
        const a = frames[i - 1], b = frames[i];
        if (a.t > t) continue;
        if (b.t - a.t > 4 * step || (apart && apart(a, b))) return { a: b, b, alpha: 1 };
        return { a, b, alpha: Math.min(1, Math.max(0, (t - a.t) / (b.t - a.t))) };
      }
      return { a: frames[0], b: frames[0], alpha: 1 };
    },
  };
}
