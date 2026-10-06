// A game controller (the browser's Gamepad API) for the game: what its sticks,
// triggers and buttons mean, and the keys its buttons press. The steering and
// pedals go to the game's analogue joystick code (lib/joystick.mjs) while a
// session runs; the buttons press the game's keys (render.html sends them to
// the emulator like the keyboard's).
//
// Buttons by the standard mapping (an Xbox layout; on a PlayStation pad A is
// cross, B circle, X square, Y triangle).
//
// Plain ES module.

const STANDARD = { a: 0, b: 1, x: 2, y: 3, lb: 4, rb: 5, lt: 6, rt: 7, back: 8, start: 9, ls: 10, rs: 11, up: 12, down: 13, left: 14, right: 15 };

/** The steering stick's dead zone, and the curve past it (1 straight; higher is gentler near the centre). */
export const STEER_DEADZONE = 0.1, STEER_CURVE = 1.5;
/** The triggers' and the right stick's dead zone. */
export const PEDAL_DEADZONE = 0.05;

const dead = (v, d) => (Math.abs(v) <= d ? 0 : (Math.sign(v) * (Math.abs(v) - d)) / (1 - d));
const clamp01 = (v) => Math.max(0, Math.min(1, v));

/**
 * What a controller is doing now.
 * @param {Gamepad} gp  a navigator.getGamepads() entry (or anything shaped like one)
 * @returns {{ steer: number, throttle: number, brake: number, gearUp: boolean, gearDown: boolean,
 *   lx: number, ly: number, buttons: Record<string, boolean> }}
 *   steer -1 (left) to 1, throttle and brake 0 to 1, lx/ly the left stick as it is
 */
export function readPad(gp) {
  const btn = (i) => { const b = gp.buttons[i]; return b ? { pressed: !!b.pressed, value: +b.value || (b.pressed ? 1 : 0) } : { pressed: false, value: 0 }; };
  const axis = (i) => (Number.isFinite(gp.axes[i]) ? gp.axes[i] : 0);
  const buttons = {};
  for (const [name, i] of Object.entries(STANDARD)) buttons[name] = btn(i).pressed;
  const lx = axis(0), ly = axis(1);
  const s = dead(lx, STEER_DEADZONE);
  const steer = Math.sign(s) * Math.abs(s) ** STEER_CURVE;
  // the triggers, or the right stick up and down
  const ry = gp.axes.length > 3 ? dead(axis(3), PEDAL_DEADZONE) : 0;
  const throttle = clamp01(Math.max(dead(btn(STANDARD.rt).value, PEDAL_DEADZONE), -ry));
  const brake = clamp01(Math.max(dead(btn(STANDARD.lt).value, PEDAL_DEADZONE), ry));
  return { steer, throttle, brake, gearUp: buttons.rb, gearDown: buttons.lb, lx, ly, buttons };
}

/**
 * The first controller the browser reports (it reports one only after a button
 * on it has been pressed), standard mapping first.
 * @param {(Gamepad|null)[]} pads  navigator.getGamepads()
 */
export function firstPad(pads) {
  const list = Array.from(pads || []).filter((p) => p && p.connected !== false);
  return list.find((p) => p.mapping === 'standard') ?? list[0] ?? null;
}

/** The keys the buttons press in a session (KeyboardEvent.code names). Gears and pedals go to the joystick. */
export const SESSION_KEYS = {
  a: 'Space', x: 'Enter', y: 'PageDown', b: 'Home', start: 'KeyP', back: 'Escape',
  up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight',
};
/** The keys in the menus: the d-pad or the left stick moves, A chooses, B is Esc (the game's menus go back by their own buttons). */
export const MENU_KEYS = {
  a: 'Enter', start: 'Enter', b: 'Escape',
  up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight',
};
const ARROWS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);

/**
 * The key presses and releases a controller's buttons make, moment to moment.
 * In the menus the left stick works as the d-pad, and a held arrow repeats as a
 * held key does.
 * @param {{ repeatAfter?: number, repeatEvery?: number }} [o] ms
 */
export function padKeys(o = {}) {
  const repeatAfter = o.repeatAfter ?? 400, repeatEvery = o.repeatEvery ?? 110;
  const held = new Map(); // code -> { since, last }: when it went down, when its last press was sent
  const stick = { up: false, down: false, left: false, right: false };
  return {
    /**
     * @param {ReturnType<typeof readPad>|null} pad  null: no controller (everything is let go)
     * @param {boolean} inSession
     * @param {number} now  ms
     * @returns {[string, boolean][]} [code, pressed] in order
     */
    update(pad, inSession, now) {
      const want = new Set();
      if (pad) {
        const map = inSession ? SESSION_KEYS : MENU_KEYS;
        for (const [name, code] of Object.entries(map)) if (pad.buttons[name]) want.add(code);
        if (!inSession) {
          // the left stick as the d-pad, with some hysteresis
          const on = (v, was) => (was ? v > 0.4 : v > 0.6);
          stick.left = on(-pad.lx, stick.left); stick.right = on(pad.lx, stick.right);
          stick.up = on(-pad.ly, stick.up); stick.down = on(pad.ly, stick.down);
          for (const d of ['up', 'down', 'left', 'right']) if (stick[d]) want.add(MENU_KEYS[d]);
        }
      }
      const out = [];
      for (const code of [...held.keys()]) if (!want.has(code)) { held.delete(code); out.push([code, false]); }
      for (const code of want) {
        const h = held.get(code);
        if (!h) { held.set(code, { since: now, last: now }); out.push([code, true]); continue; }
        // a held arrow in the menus presses again: first after repeatAfter, then every repeatEvery
        const due = h.last === h.since ? repeatAfter : repeatEvery;
        if (!inSession && ARROWS.has(code) && now - h.last >= due) { h.last = now; out.push([code, true]); }
      }
      return out;
    },
  };
}
