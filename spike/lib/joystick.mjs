// A virtual joystick for the game: a game controller (lib/gamepad.mjs) steers,
// accelerates and brakes through the game's own analogue joystick code, while a
// session runs (docs/memory-map.md, "Controls").
//
// The game reads a PC game-port joystick (port 201h) in two routines:
// 8B6E:06EE times the four axes into SS:08F6/08F8 (joystick A x, y) and
// SS:090E/0910 (joystick B x, y), and 8B6E:06E5 reads the buttons into SS:08F4
// (bits 4-7, a pressed button clears its bit). Its control settings, SS:1114-111D
// (copied from one of the presets at SS:111E), name a device for each function:
// steering 4 = joystick A (x axis), accelerator and brake 7 = joystick B (with
// SS:111D bits 2 and 4: the accelerator on x, the brake on y), gear up and down
// = a joystick button's bit. In a race each frame (19ED:2AF6-2CFC) the game turns
// an axis into the player's steering (car+7C, -4095 to 4095, right positive),
// accelerator (car+9B, 0-127) and brake (car+5F, 0-127) with the calibration
// (SS:0902 on: a centre and the two ends of each axis) as scales (SS:08FA on).
//
// Engaged, this module sets those controls, a calibration of its own and the
// scales the game would work out from it, and the flags the game derives from
// the controls at the session's start (SS:0194, 0195: 19ED:271B), so it works
// from any moment of a session. The game then reads the axes and buttons the
// page writes: the button read is turned into a plain return (one byte), and the
// axes are not read at all because the game only times the port when SS:08EA,
// worked out in the menus, says a joystick is in use. With both gear controls
// off the keyboard the game makes Space its pause key (0:DCA6, at a session's
// start), so the module keeps it on P. Disengaged, every byte goes back as it
// was, so the game's menus and saved settings never see it.
//
// Plain ES module.

/** The game's code this needs, as in gp.exe 1.05: the button read (8B6E:06E5). */
const BUTTON_READ = { seg: 0x8b6e, off: 0x06e5, bytes: [0xba, 0x01, 0x02, 0xec, 0x36, 0xa2, 0xf4, 0x08, 0xcb] };
const RETF = 0xcb;

// SS offsets
const CONTROLS = 0x1114;        // 10 bytes: steer, accelerate, brake, gear up, gear down, 1119-111B, 111C, 111D
const FLAGS = 0x0194;           // 2 bytes: the player's car+89 and car+3D (high nibble), from the controls
const BUTTONS = 0x08f4;         // the game port's byte: buttons in bits 4-7, low when pressed
const AXES = 0x08f6;            // joystick A x, y; joystick B x, y at +18h
const SCALES = 0x08fa;          // per joystick: x minus side, x plus side, y minus side, y plus side
const CALIBRATION = 0x0902;     // per joystick: x centre, x minus end, x plus end, y centre, y plus end, y minus end
const B = 0x18;                 // joystick B's offset from A
const PAUSE_KEY = 0x0066;       // DS: the pause key, in the keyboard table's coding (scancode >> 3, & 7)
const P_KEY = 0x31;             // P (scancode 19h); Space is 71h

/** The raw axis value at rest and its swing to either end. */
export const CENTRE = 0x800, SWING = 0x400;
/** The joystick button bits: gear up on joystick A's first button, gear down on its second. */
export const GEAR_UP = 0x10, GEAR_DOWN = 0x20;

/**
 * The controls: steering on joystick A's x axis, accelerator on joystick B's x
 * axis and brake on its y axis (as a pair of pedals), gears on two buttons; the
 * rest as the game's joystick presets (01 01 01), and SS:111C and SS:111D's top
 * bit as they were.
 * @param {ArrayLike<number>} was  the 10 control bytes in force
 */
export function joystickControls(was) {
  return Uint8Array.from([4, 7, 7, GEAR_UP, GEAR_DOWN, 1, 1, 1, was[8], (was[9] & 0x80) | 0x06]);
}

/**
 * The flags the game derives from its controls at a session's start
 * (19ED:271B-27BC): the player's car+89, and car+3D's high nibble.
 * @param {ArrayLike<number>} c  the 10 control bytes (SS:1114-111D)
 * @returns {[number, number]}
 */
export function controlFlags(c) {
  let f89 = 0, f3d = 0;
  if (c[3] !== c[4]) f3d |= 0x10;
  if (c[5]) { f89 |= 0x10; if (c[5] !== 1) f3d |= 0x80; }
  if (c[0]) f89 |= 0x80;
  if (c[6]) { f89 |= 0x08; if (c[6] !== 1) f3d |= 0x40; }
  if (c[1] === 5 || c[1] === 7) f89 |= 0x40;
  if (c[7]) { f89 |= 0x04; if (c[7] !== 1) f3d |= 0x20; }
  if (c[2] === 5 || c[2] === 7) f89 |= 0x20;
  if (!(c[8] & 0x80)) f89 |= 0x02;
  if (!(c[9] & 0x80)) f89 |= 0x01;
  return [f89, f3d];
}

/** The game's scale for one side of an axis (19ED:267D): 82080h / the side's swing, at least 20. */
export function axisScale(swing) {
  const s = swing < 0 ? Math.min(swing, -20) : Math.max(swing, 20);
  return Math.trunc(0x82080 / s);
}

/** The raw axis value for a position from -1 to 1 (or 0 to 1 for a pedal). */
export const axisValue = (v) => CENTRE + Math.round(Math.max(-1, Math.min(1, v)) * SWING);

/**
 * The virtual joystick on attach()ed game memory (lib/f1gp-mem.mjs).
 * @param {object} mem
 */
export function virtualJoystick(mem) {
  const ssAt = (o) => mem.memBase + mem.ssLinear + o, dsAt = (o) => mem.memBase + mem.dsLinear + o;
  const code = mem.memBase + ((BUTTON_READ.seg + mem.imageSeg) << 4) + BUTTON_READ.off;
  // every byte it changes: the controls, the flags, the button byte and axes, the scales and calibration
  const saved = [[CONTROLS, 10], [FLAGS, 2], [BUTTONS, 1], [AXES, 4], [AXES + B, 4], [SCALES, 8], [SCALES + B, 8], [CALIBRATION, 12], [CALIBRATION + B, 12]];
  let kept = null, engaged = false;
  const H = () => mem.heap();
  const w16 = (o, v) => { const h = H(), a = ssAt(o); h[a] = v & 0xff; h[a + 1] = (v >> 8) & 0xff; };
  const known = () => { const h = H(); return BUTTON_READ.bytes.every((b, i) => h[code + i] === b); };
  return {
    get engaged() { return engaged; },
    /** Take over the game's controls (in a session); false if the game's code is not as expected. */
    engage() {
      if (engaged) return true;
      if (!known()) return false;
      const h = H();
      kept = { code: h[code], pause: h[dsAt(PAUSE_KEY)], bytes: saved.map(([o, n]) => [o, h.slice(ssAt(o), ssAt(o) + n)]) };
      const controls = joystickControls(h.subarray(ssAt(CONTROLS), ssAt(CONTROLS) + 10));
      h.set(controls, ssAt(CONTROLS));
      h.set(controlFlags(controls), ssAt(FLAGS));
      for (const j of [0, B]) {
        // centre, minus end, plus end of x; centre, plus end, minus end of y (the game's order)
        [CENTRE, CENTRE - SWING, CENTRE + SWING, CENTRE, CENTRE + SWING, CENTRE - SWING].forEach((v, i) => w16(CALIBRATION + j + 2 * i, v));
        [-SWING, SWING, -SWING, SWING].forEach((s, i) => w16(SCALES + j + 2 * i, axisScale(s)));
      }
      h[code] = RETF;
      engaged = true;
      this.set({});
      return true;
    },
    /** Give the controls back: every byte as it was. */
    disengage() {
      if (!engaged) return;
      const h = H();
      for (const [o, b] of kept.bytes) h.set(b, ssAt(o));
      h[code] = kept.code;
      h[dsAt(PAUSE_KEY)] = kept.pause;
      kept = null;
      engaged = false;
    },
    /**
     * This moment's controls.
     * @param {{ steer?: number, throttle?: number, brake?: number, gearUp?: boolean, gearDown?: boolean }} s
     *   steer -1 (left) to 1 (right), throttle and brake 0 to 1
     */
    set(s) {
      if (!engaged) return;
      w16(AXES, axisValue(s.steer ?? 0));
      w16(AXES + 2, CENTRE);
      w16(AXES + B, axisValue(s.throttle ?? 0));
      w16(AXES + B + 2, axisValue(s.brake ?? 0));
      const h = H();
      h[ssAt(BUTTONS)] = 0xf0 & ~((s.gearUp ? GEAR_UP : 0) | (s.gearDown ? GEAR_DOWN : 0));
      // the pause key stays P (the game sets Space again when a session starts)
      h[dsAt(PAUSE_KEY)] = P_KEY;
    },
  };
}
