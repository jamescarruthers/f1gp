// route.cjs - scripted route from a cold boot of F1GP 1.05 (European) to
// driving on the track, for any emulator "driver" (Node harness or browser).
//
// USAGE
//
//   Node (lib/node-emu.cjs):
//     const { start } = require('./node-emu.cjs');
//     const route = require('./route.cjs');
//     const emu = await start('dist/route-g-25000.jsdos');   // autoexec "gp /g"
//     const drv = route.nodeDriver(emu);
//     const info = await route.toTrack(drv, { circuit: 'Great Britain', log: console.log });
//     await drv.keyDown('a'); await drv.sleep(5000); await drv.keyUp('a');
//     console.log(route.readMph(await drv.screenshot()));
//
//   Any js-dos CommandInterface (browser page or Node):
//     const drv = route.ciDriver(ci);        // uses ci.sendKeyEvent + ci.screenshot()
//
//   Custom driver: an object with
//     press(keyName, holdMs)                  required; key names are in KEY_NAMES
//     sleep(ms)                               required
//     screenshot() -> Promise<{width, height, data}>   required; RGBA bytes
//     keyDown(keyName) / keyUp(keyName)       optional (held keys while driving)
//     mouseMove(x, y) / mouseButton(b, down)  optional (not used by the route)
//   Key names are the lib/node-emu.cjs KEYS names; JSDOS_KEYS maps them to
//   the js-dos key codes accepted by ci.sendKeyEvent(code, pressed).
//
//   Browser without a bundler: load this file as a classic <script> (or via
//   Playwright page.addScriptTag({ content })); with no `module` defined it
//   sets globalThis.F1GPRoute to the same exports.
//
// WHAT THE ROUTE DOES (seen in the emulator, gp.exe 1.05 EU, bundle autoexec
// "gp /g", f1prefs.dat as shipped = 486 preset):
//   0. With f1gp.bat (intro, then "gp /c /g") the playscr intro and the
//      scrolling credits run first; the credits wait for a key, so the route
//      presses Esc every 2 s after 5 s of unrecognised screens. "gp /g" shows
//      step 1 about 2.4 s after boot and needs no key.
//   1. CHOOSE LANGUAGE ("Is your Manual in:"). English is preselected (yellow
//      text = chosen, red = cursor). Right (cursor to Francais, English stays
//      chosen), Down (O.K., reachable from Francais only), Enter. If another
//      language is chosen, the route moves back to English and selects it.
//   2. MANUAL PROTECTION: "Please enter the word on: Page 85 Paragraph 4
//      Line 1 Word 11" (English manual). The same question came up on every
//      boot we made (cycles 12000/25000/50000, any DOS date/time). Answer from
//      the UK manual page 85: "require". Typed, then Enter. The route checks
//      the question against the known one and refuses to guess otherwise
//      (pass opts.answer to override).
//   3. JOYSTICK SELECTED (prefs select joystick control; DOSBox reports a
//      joystick): Right ("Use Keys"), Enter.
//   4. STARTUP MENU: Down ("Main Menu"), Enter.            -> toMainMenu ends
//   5. MAIN MENU: move to "Practise any Circuit" (item 4), Enter.
//   6. SELECT CIRCUIT: move to opts.circuit (default: whatever is highlighted,
//      Great Britain with the shipped prefs), Enter.
//   7. Circuit view (View / Info / << / >> / O.K.): O.K. is highlighted, Enter.
//   8. Loading (black), then the pit garage, cockpit view, car on the jacks,
//      dash LCD shows "TYRE CHOICE". Space drops the car off the jacks and the
//      LCD switches to MPH / LAPTIME.                    -> toTrack ends
//   The car then sits in the pit lane with automatic gears; hold A to drive,
//   Z to brake. In the pit lane the game steers the car itself (comma/period
//   made no difference there in A/B runs); after the pit exit comma/period
//   steer left/right. toTrack({ mode: 'quickrace' }) instead ends on the
//   Quick Race grid (Monza) when the start lights turn green, with full
//   control on the circuit.
//   Hold O in the car to show "Processor Occupancy NN%", black text drawn
//   straight over the 3D view near the top (text rows y 57-62, value from
//   x 225); readOccupancy() reads it, measureOccupancy() holds O and returns
//   the median of several readings.
//
// Every step waits on screen state (fingerprints of static text, the red menu
// highlight, the LCD), not on fixed delays, so it works at any cycles value.
// Screenshots of other sizes are sampled as if scaled to 320x200.

'use strict';

// ---------------------------------------------------------------- keys

// js-dos key codes (GLFW numbering), as in lib/node-emu.cjs.
const JSDOS_KEYS = {
  space: 32, comma: 44, period: 46, slash: 47,
  0: 48, 1: 49, 2: 50, 3: 51, 4: 52, 5: 53, 6: 54, 7: 55, 8: 56, 9: 57,
  a: 65, b: 66, c: 67, d: 68, e: 69, f: 70, g: 71, h: 72, i: 73, j: 74, k: 75,
  l: 76, m: 77, n: 78, o: 79, p: 80, q: 81, r: 82, s: 83, t: 84, u: 85, v: 86,
  w: 87, x: 88, y: 89, z: 90,
  esc: 256, enter: 257, tab: 258, backspace: 259,
  right: 262, left: 263, down: 264, up: 265,
  f1: 290, f2: 291, f3: 292, f4: 293, f5: 294, f6: 295, f7: 296, f8: 297,
  f9: 298, f10: 299, lshift: 340, lctrl: 341, lalt: 342,
};

// Keys the route and the game controls use.
const KEY = {
  menuLeft: 'left', menuRight: 'right', menuUp: 'up', menuDown: 'down',
  select: 'enter', dropJacks: 'space',
  accelerate: 'a', brake: 'z', steerLeft: 'comma', steerRight: 'period',
  gearChange: 'space', occupancy: 'o', pause: 'p', menu: 'esc',
};
const KEY_NAMES = Object.keys(JSDOS_KEYS);

// Answers for the manual question, keyed by fingerprint name.
// Source: UK English manual (January 1992), printed page 85, 4th body
// paragraph "Hockenheimring is a good overtaking circuit but the slow
// chicanes require brutal braking ...", line 1, word 11.
const MANUAL_ANSWERS = {
  q85_4_1_11: { page: 85, paragraph: 4, line: 1, word: 11, answer: 'require' },
};

// Menu geometry (320x200 coordinates of highlight centres), measured.
const LANGUAGE_BUTTONS = { English: 80, Francais: 160, Deutsch: 240 }; // cx on row cy 124; O.K. cy 152
const MAIN_MENU = ['Quick Race', 'Driver/Team Selection', 'Load/Save Game', 'Help Options Setup',
  'Practise any Circuit', 'Non-Championship Race', 'Championship Season', 'Game Options Menu', 'Exit to DOS'];
const CIRCUITS = [ // [column, row] on SELECT CIRCUIT
  ['United States', 0, 0], ['San Marino', 0, 1], ['Canada', 0, 2], ['France', 0, 3],
  ['Germany', 0, 4], ['Belgium', 0, 5], ['Portugal', 0, 6], ['Japan', 0, 7],
  ['Brazil', 1, 0], ['Monaco', 1, 1], ['Mexico', 1, 2], ['Great Britain', 1, 3],
  ['Hungary', 1, 4], ['Italy', 1, 5], ['Spain', 1, 6], ['Australia', 1, 7],
];

// ---------------------------------------------------------------- pixels

// RGB at logical (x, y) in 320x200 space.
function px(img, x, y) {
  const sx = img.width === 320 ? x : Math.floor((x * img.width) / 320);
  const sy = img.height === 200 ? y : Math.floor((y * img.height) / 200);
  const o = (sy * img.width + sx) * 4;
  return [img.data[o], img.data[o + 1], img.data[o + 2]];
}

const PIXEL_TESTS = {
  white: (r, g, b) => r > 200 && g > 200 && b > 200,
  yellow: (r, g, b) => r > 200 && g > 200 && b > 100 && b < 170,
  lcd: (r, g, b) => r + g + b < 300, // dark text on the light green dash LCD
  black: (r, g, b) => r + g + b < 60,
  red: (r, g, b) => Math.abs(r - 195) < 20 && g < 30 && b < 30, // menu highlight (195,0,0)
};

// Bit mask of pixels passing `mode` inside rect [x, y, w, h].
function mask(img, rect, mode) {
  const [x0, y0, w, h] = rect;
  const test = PIXEL_TESTS[mode];
  const bits = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const [r, g, b] = px(img, x0 + x, y0 + y);
    bits[y * w + x] = test(r, g, b) ? 1 : 0;
  }
  return bits;
}

function packBits(bits) {
  const bytes = new Uint8Array(Math.ceil(bits.length / 8));
  for (let i = 0; i < bits.length; i++) if (bits[i]) bytes[i >> 3] |= 1 << (i & 7);
  return typeof Buffer !== 'undefined' ? Buffer.from(bytes).toString('base64') : btoa(String.fromCharCode(...bytes));
}

function unpackBits(b64, n) {
  const bytes = typeof Buffer !== 'undefined'
    ? Buffer.from(b64, 'base64')
    : Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const bits = new Uint8Array(n);
  for (let i = 0; i < n; i++) bits[i] = (bytes[i >> 3] >> (i & 7)) & 1;
  return bits;
}

// Jaccard similarity of two masks (1 = identical set pixels).
function jaccard(a, b) {
  let inter = 0, uni = 0;
  for (let i = 0; i < a.length; i++) { if (a[i] && b[i]) inter++; if (a[i] || b[i]) uni++; }
  return uni ? inter / uni : 0;
}

function meanColour(img, rect = [0, 0, 320, 200], step = 2) {
  const [x0, y0, w, h] = rect;
  let r = 0, g = 0, b = 0, n = 0;
  for (let y = y0; y < y0 + h; y += step) for (let x = x0; x < x0 + w; x += step) {
    const p = px(img, x, y); r += p[0]; g += p[1]; b += p[2]; n++;
  }
  return [r / n, g / n, b / n];
}

// Fraction of sampled pixels that differ between two screenshots.
function frameDiff(a, b, rect = [0, 0, 320, 200], step = 2) {
  const [x0, y0, w, h] = rect;
  let d = 0, n = 0;
  for (let y = y0; y < y0 + h; y += step) for (let x = x0; x < x0 + w; x += step) {
    const p = px(a, x, y), q = px(b, x, y);
    if (Math.abs(p[0] - q[0]) + Math.abs(p[1] - q[1]) + Math.abs(p[2] - q[2]) > 30) d++;
    n++;
  }
  return d / n;
}

// ---------------------------------------------------------------- fingerprints

// Built by probes/route-fp.cjs from reference screenshots in out/route/.
// rect = [x, y, w, h] in 320x200 space, mode = pixel test, bits = base64 mask.
const FINGERPRINTS = /*FP-BEGIN*/{ "language": { "rect": [ 60, 43, 201, 15 ], "mode": "white", "ref": "p1/t004.png", "bits": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAPBwcPIAH+PA/8AEwcHDwcDgwAA//AwAAAP4ZGP7BP/zn/+ADYOBg+GcwYIB//g8AAAAOMzAOx+E8jIGBA+DBwzjMYOCBwxgYAAAADGBgDIyBOTADAgPAg40xgMHAAwMwIAAAAAzAwAywAeYABgAGwAwzMwCDwQwDYAAAAAAYgP8ZYAPMH/wDDIAZxmYABoMZBsA/AAAAMACDM8AGGP74BxiAYQzP4A2GYQyefwAAAGAABmaADTDAMQAwAMMYnIEbDMMYOAMAAACAAQyMgTEwA2dAYCD/MzAGMxj/YzAGBAAAAIcZGIfjcAzGwMBhBmZgHMYwBsZhDAwAAAD8MzD8g3/4z//B/wbYwPCPfwYY//wfAAAA4OHg4AE8wIf/gf8IkIGBB3wIEHj4HwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" }, "protection": { "rect": [ 60, 43, 201, 15 ], "mode": "white", "ref": "p6/q1.png", "bits": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGDAwMDBHQ4MfAD+8Afw4P/+Bx7+7w8eHBzAwYGBgxkMGPgA/Oc/+Mf//R///N8P/zgYgMeBBw8zGHjgADCMYTicGDIwh4khDofzMADfAw82ZjDwwABgMIMxMDBgQAYAAwwGZmMA/gUzzMxgMIMBwGAGM8BgwAAGAAYYBtjMAMwNZhibwWAGA4BhDGOAwYB/DAAMMAywsQEYGYYxPINhGAYA//jHAIMB/xgAGGAYYMMDMDAMY3AGwzAMAH7wgwEGAwYwADDAMMAGB2Bg/M/ADMb/GAgMYAYGBgYMyABggMHADAzAwBiYgTGMgXEYGMAYHA4MGJjDwACHwxkYgIMbYAPjnwH2P3jAY/APfPg//sGHP/4xMAAHJ0AGBh8C5D/wgIeBB/jwP/CADz/wYGAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" }, "joystick": { "rect": [ 60, 55, 201, 15 ], "mode": "white", "ref": "p8/r1.png", "bits": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD4wYOB4cP//cHDwwA+/M8H/gce/u9//gAA8OMfAfOf//vhn8MA//m/D/wf//zf//0HAADjcAbzMDHE4TDGAA9jYA4wMIeJIQMzHAAAxsAY48BggMEAzAAOzIAMYEAGAAMGZDAAAMwAY4MDwADDANgAOIABGMAABgAGDMDAAACYAYYDf4ABhgHwAPAH/zCAfwwADPiHgQEAMAMMAvgDAwwD4AGAP/5hAP8YABjwDwMDYGAGGAQABwYYBsAGAHAMwAAGMAAwYAAGBsDAGBgIDBwMMBiAGcDAGZCBDMgAYMCADAYAw3A4EDAYGOBwGGMAgzEwhxmYw8CAgRkOAP7BP3DgP/jwxz+HAf7zf//7P/7Bh//7DwDwAB7gAB/w4QceDgbw4X/+8z/wgA//8wcAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" }, "startup": { "rect": [ 88, 63, 145, 14 ], "mode": "white", "ref": "p8/r4.png", "bits": "AAAAAAAAAAAAAAAAAAAAAAAAAD78Hxj4g/873B9gwP7n4A4HAP/5PzDwH/83mP/Awf3fwQwGAA8TQ/DAMGJoMIaBxzGwhxkMAA4MBuCBwcDAYAwG32NAGzMYADgADGAGg4GBwRgM/sUAZmYwAPAHGMAMhgEDgzEMzI1/jM1gAIA/MMAw/AMGBuMfGBn/GJ7BAABwYIBh+AEMDMYPMDAGMDiDAcDAwYD/MQMYGIwBYGAMaGAGAwCDgQEDYwwwYBgDwMAY2MAYBgD+gw8D7DHwwT8PgIP7v4HxDwDwAR8EyMPgAz4eAAf3PwODDwAAAAAAAAAAAAAAAAAAAAAAAAA=" }, "main": { "rect": [ 110, 11, 106, 14 ], "mode": "white", "ref": "p9/m2.png", "bits": "AAAAAAAAAAAAAAAAAAADBgb+Dg4G7H8O7nAAHBwY+DkYOLj/O5jBAPA48IDjYeBxDOxhBgPA98ADho2B7zGgjRkMAP+CGRhmBv7FAGZmMADMDWZgGBuYG/8Ym8EAMDIMg2F4YGT8Y3gGA8DAMAyGwYGBMYDBGQwAA+N/GAYGBsaABmYwAAyMgeEYGBgYAxsYwwBwcAPsb2Dg4P5vYPwDwMEJkJ+BgYP7n4HBBwAAAAAAAAAAAAAAAAAA" }, "circuits": { "rect": [ 80, 23, 161, 15 ], "mode": "white", "ref": "p10/pr2.png", "bits": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAH/7nA/8DD/8H8PD3B/BwuL//A4D//N8H/o9//g/45+c/+GcwP/8HgIcxMAcYmMPEEDgMh2E4zGA4YggAB2ZABjAgA4ABMAAGgzGAwTDAAAAcwAAMYAADAAMwAAwGMwCDYYABAPiDfxjAPwYABmAAGAxjAAbDAAMAwB//MIB/DAAMwAAw+McADIYBBgAAOAZgAAMYABiAAWDwgwEYDAMMAGDgDMhABmQAMAAGwGAGBjAYBhgAgMEYmMMMzGFgAByGwxgcxjAcMAAA//m///0f/+AD8M/fY/CPf/7wAQD48D//+R94wAeAh5+HgQd8/OADAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" }, "circuitView": { "rect": [ 262, 112, 49, 27 ], "mode": "white", "ref": "p11/c1_009.png", "bits": "AAAAAAAAAAAAAAAAABhmAAAAADAMAAAAAMDI8RkGAIAZM7YNAAAe5m8bAAA8zIAZAAAwPB8zAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA+AHwAAAAwAAwAwAAgPFj4AMAAGPsYQwAAMaYwRgAAIwxgzEAAH5jDz4AAAAAAAAAAAAAAAAAAA==" }, "circuitViewL": { "rect": [ 9, 112, 49, 27 ], "mode": "white", "ref": "qr/q1.png", "bits": "AAAAAAAAAAAAAAAAADDMAAAAAGAYAAAAAICR4zMMAAAzZmwbAAA8zN82AAB4mAEzAABgeD5mAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA8APgAQAAgAFgBgAAAOPHwAcAAMbYwxgAAIwxgzEAABhjBmMAAPzGHnwAAAAAAAAAAAAAAAAAAA==" }, "cockpit": { "rect": [ 122, 153, 57, 7 ], "mode": "white", "ref": "p12/g_015.png", "bits": "AAAAAAAAAEggAgAAAADggEJSSqS0AQGCpJQ4pwIACkkpUUIEACIAAAABAAAAAAAAAAA=" }, "pits": { "rect": [ 128, 193, 73, 7 ], "mode": "lcd", "ref": "p12/g_015.png", "bits": "AAAAAAAAAAAAAF86Dy4ZcQ8AAIiUAkJKEgIAABDmHISXJBwAACBICQgpSQgAAECQ9OCSEfcAAAAAAAAAAAAAAA==" }, "car": { "rect": [ 140, 183, 43, 8 ], "mode": "lcd", "ref": "p14/a_005.png", "bits": "AAAAAAAAAAAAAACCOV/RAxBSItqCj/AOUXUAhBSIogDgpUAUPQAAAAAAAA==" }, "race": { "rect": [ 164, 193, 40, 6 ], "mode": "lcd", "ref": "qr/g2.png", "bits": "AAAAAACcFEXvOKQ0TSEFnFRV5xiUlGWhICQTRS8d" }, "q85_4_1_11": { "rect": [ 196, 124, 25, 41 ], "mode": "yellow", "ref": "p6/q1.png", "bits": "AAAAAAAAgM8fgLEBAGM/AHzAAIyBARgbA+DjAwAAAAAAAAAAAAAAOAAAeAAA2AAAmAEA8AcAAAYAAB4AAAAAAAAAAAAAAGAAAOAAAIABAAADAAAGAAAMAAB+AAAAAAAAAAAAAICBAYCDAwAGBgAMDAAYGAAwMAD4+QEAAAAAAAAA" } }/*FP-END*/;

const FP_CACHE = {};
function fpBits(name) {
  if (!FP_CACHE[name]) {
    const fp = FINGERPRINTS[name];
    FP_CACHE[name] = unpackBits(fp.bits, fp.rect[2] * fp.rect[3]);
  }
  return FP_CACHE[name];
}

function fpScore(img, name) {
  const fp = FINGERPRINTS[name];
  return jaccard(mask(img, fp.rect, fp.mode), fpBits(name));
}

const MATCH = 0.8;

// Which known screen is showing. Returns { screen, score, scores }.
// screen is one of: language, protection, joystick, startup, main, circuits,
// circuitView (View/Info/<</>>/O.K. panel on either side), pits (practice,
// on the jacks, TYRE CHOICE on the LCD), car (practice, off the jacks, MPH and
// LAPTIME on the LCD), race (race or quick race, LAP/RUNNERS on the LCD),
// cockpit (cockpit view, LCD not recognised), black, unknown.
function identify(img) {
  const scores = {};
  for (const name of Object.keys(FINGERPRINTS)) if (!name.startsWith('q')) scores[name] = fpScore(img, name);
  const m = meanColour(img);
  if (m[0] + m[1] + m[2] < 6) return { screen: 'black', score: 1, scores };
  const cockpit = (scores.cockpit || 0) >= MATCH;
  const order = ['language', 'protection', 'joystick', 'startup', 'main', 'circuits', 'circuitView', 'circuitViewL'];
  let best = null;
  for (const name of order) if (scores[name] >= MATCH && (!best || scores[name] > scores[best])) best = name;
  if (best) return { screen: best === 'circuitViewL' ? 'circuitView' : best, score: scores[best], scores };
  if (cockpit && scores.pits >= MATCH) return { screen: 'pits', score: scores.pits, scores };
  if (cockpit && scores.car >= MATCH) return { screen: 'car', score: scores.car, scores };
  if (cockpit && scores.race >= MATCH) return { screen: 'race', score: scores.race, scores };
  if (cockpit) return { screen: 'cockpit', score: scores.cockpit, scores };
  return { screen: 'unknown', score: 0, scores };
}

// Which known manual question is on the protection screen, or null.
function identifyQuestion(img) {
  let best = null, bestScore = 0;
  for (const name of Object.keys(MANUAL_ANSWERS)) {
    if (!FINGERPRINTS[name]) continue;
    const s = fpScore(img, name);
    if (s > bestScore) { best = name; bestScore = s; }
  }
  return bestScore >= 0.9 ? { name: best, score: bestScore, ...MANUAL_ANSWERS[best] } : null;
}

// ---------------------------------------------------------------- highlight

// Bounding box of the red menu highlight (195,0,0), or null.
// Rows count when their longest red run is >= 16 px (this skips the dotted
// red/white frame); rows up to 10 apart (text inside the button) are merged.
function findHighlight(img) {
  const rows = [];
  for (let y = 0; y < 200; y++) {
    let run = 0, best = 0, s = 0, bx0 = 0, bx1 = 0;
    for (let x = 0; x < 320; x++) {
      const [r, g, b] = px(img, x, y);
      if (PIXEL_TESTS.red(r, g, b)) { if (!run) s = x; run++; if (run > best) { best = run; bx0 = s; bx1 = x; } } else run = 0;
    }
    if (best >= 16) rows.push({ y, n: best, x0: bx0, x1: bx1 });
  }
  if (!rows.length) return null;
  const blocks = [];
  let cur = [rows[0]];
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].y - rows[i - 1].y <= 10) cur.push(rows[i]); else { blocks.push(cur); cur = [rows[i]]; }
  }
  blocks.push(cur);
  const score = (bl) => bl.reduce((s, r) => s + r.n, 0);
  blocks.sort((a, b) => score(b) - score(a));
  const bl = blocks[0];
  const h = { x0: Math.min(...bl.map((r) => r.x0)), x1: Math.max(...bl.map((r) => r.x1)), y0: bl[0].y, y1: bl[bl.length - 1].y };
  h.cx = (h.x0 + h.x1) / 2; h.cy = (h.y0 + h.y1) / 2;
  return h;
}

// Index of the highlighted item for each menu screen, or null.
function menuIndex(screen, h) {
  if (!h) return null;
  switch (screen) {
    case 'main': return Math.round((h.cy - 36) / 18);          // 9 items, 18 px apart
    case 'startup': return Math.round((h.cy - 106) / 20);      // 0 Quick Race, 1 Main Menu
    case 'joystick': return h.cx < 160 ? 0 : 1;                // 0 Calibrate, 1 Use Keys
    case 'language':
      if (h.cy > 140) return 3;                                // O.K.
      return h.cx < 120 ? 0 : h.cx < 200 ? 1 : 2;              // English, Francais, Deutsch
    case 'circuits': return (h.cx < 160 ? 0 : 8) + Math.round((h.cy - 56) / 16);
    case 'circuitView': return Math.round((h.cy - 117) / 16);  // View, Info, <<, >>, O.K.
    default: return null;
  }
}

// CHOOSE LANGUAGE: which button has the yellow "chosen" text (0 English,
// 1 Francais, 2 Deutsch), or null.
function languageChosen(img) {
  const spans = [[42, 118], [122, 198], [202, 278]];
  for (let i = 0; i < 3; i++) {
    let n = 0;
    for (let y = 118; y <= 130; y++) for (let x = spans[i][0]; x <= spans[i][1]; x++) {
      const [r, g, b] = px(img, x, y);
      if (PIXEL_TESTS.yellow(r, g, b)) n++;
    }
    if (n > 100) return i;
  }
  return null;
}

// ---------------------------------------------------------------- digits

// 6x6 digit font used by the dash LCD and the occupancy strip.
const DIGITS = {
  '.####.#....##....##....##....#.####.': 0, '..#....##.....#.....#.....#....###..': 1,
  '.####.#....#...##..##...#.....######': 2, '######....#....##......##....#.####.': 3,
  '....#....##...#.#..#..#.######....#.': 4, '#######.....#####......#.....######.': 5,
  '.####.#.....#####.#....##....#.####.': 6, '######....#....#....#....#.....#....': 7,
  '.####.#....#.####.#....##....#.####.': 8, '.####.#....#.####.....#....#....#...': 9,
};

function glyphAt(img, x0, y0) {
  let g = '';
  for (let y = y0; y < y0 + 6; y++) for (let x = x0; x < x0 + 6; x++) {
    const [r, gg, b] = px(img, x, y);
    g += r + gg + b < 60 ? '#' : '.';
  }
  return g;
}

// Speed on the dash LCD ("MPH 097"), or null when not shown.
function readMph(img) {
  let v = '';
  for (const x of [111, 118, 125]) {
    const d = DIGITS[glyphAt(img, x, 184)];
    if (d === undefined) return null;
    v += d;
  }
  return Number(v);
}

// "Processor Occupancy NN%" strip (shown while O is held), or null.
// Digits start at x=225, y=57, 7 px apart, followed by '%'.
function readOccupancy(img) {
  let v = '';
  for (let i = 0; i < 4; i++) {
    const d = DIGITS[glyphAt(img, 225 + 7 * i, 57)];
    if (d === undefined) break;
    v += d;
  }
  if (!v) return null;
  // the label must be there too: the "P" of "Processor" at (78, 57)
  if (glyphAt(img, 78, 57) !== '#####.#....######.#.....#.....#.....') return null;
  return Number(v);
}

// Race start lights (top right of the cockpit view on the grid):
// 'green', 'red' or 'off' (also 'off' once the gantry is out of view).
function readLights(img) {
  let red = 0, green = 0;
  for (let y = 25; y < 60; y++) for (let x = 215; x < 315; x++) {
    const [r, g, b] = px(img, x, y);
    if (r > 180 && g < 80 && b < 80) red++;
    if (g > 150 && r < 100 && b < 120) green++;
  }
  return green > 100 ? 'green' : red > 15 ? 'red' : 'off';
}

// ---------------------------------------------------------------- waiting

async function waitFor(driver, test, { timeout = 30000, interval = 150, stable = 2, what = 'condition' } = {}) {
  const t0 = Date.now();
  let hits = 0, last = null, lastImg = null;
  while (Date.now() - t0 < timeout) {
    const img = await driver.screenshot();
    lastImg = img;
    const r = test(img);
    if (r) { hits++; last = r; if (hits >= stable) return { value: last, img, ms: Date.now() - t0 }; } else hits = 0;
    await driver.sleep(interval);
  }
  const err = new Error(`timeout after ${timeout} ms waiting for ${what}`);
  err.lastImage = lastImg;
  throw err;
}

// Wait until identify() gives one of `names` on `stable` screenshots in a row.
async function waitScreen(driver, names, opts = {}) {
  const want = Array.isArray(names) ? names : [names];
  const r = await waitFor(driver, (img) => { const s = identify(img).screen; return want.includes(s) ? s : null; },
    { what: `screen ${want.join('|')}`, ...opts });
  return r.value;
}

// Press `key` until `test(img)` holds (checked after each press).
async function pressUntil(driver, key, test, { tries = 6, settle = 2500, hold = 120, what = key } = {}) {
  for (let i = 0; i < tries; i++) {
    await driver.press(key, hold);
    try { return await waitFor(driver, test, { timeout: settle, what }); } catch { /* press again */ }
  }
  throw new Error(`pressing ${key} did not reach ${what}`);
}

// Move the highlight on `screen` to item `target` with the given keys.
async function moveHighlight(driver, screen, target, { dec = 'up', inc = 'down', map = null, log } = {}) {
  for (let step = 0; step < 24; step++) {
    const img = await driver.screenshot();
    const idx = menuIndex(screen, findHighlight(img));
    if (idx === target) return;
    if (idx === null) { await driver.sleep(150); continue; }
    const key = map ? map(idx, target) : idx < target ? inc : dec;
    if (log) log(`  ${screen}: highlight ${idx} -> ${target}, press ${key}`);
    await pressUntil(driver, key, (im) => { const j = menuIndex(screen, findHighlight(im)); return j !== null && j !== idx; },
      { tries: 3, settle: 2000, what: `${screen} highlight to move from ${idx}` });
  }
  throw new Error(`could not move ${screen} highlight to ${target}`);
}

// Press `key` until the screen is no longer `screen` (or becomes one of next).
async function leaveScreen(driver, screen, key, { next = null, tries = 4, settle = 4000 } = {}) {
  return pressUntil(driver, key, (img) => {
    const s = identify(img).screen;
    if (next) return next.includes(s) ? s : null;
    return s !== screen ? s : null;
  }, { tries, settle, what: next ? next.join('|') : `leave ${screen}` });
}

async function typeText(driver, text) {
  for (const ch of text.toLowerCase()) { await driver.press(ch === ' ' ? 'space' : ch, 80); await driver.sleep(80); }
}

// ---------------------------------------------------------------- route

const noop = () => {};

// From power-on (bundle autoexec "gp /g" or f1gp.bat) to the MAIN MENU.
// opts: { answer, timeout (ms, default 180000), skipIntro (default true),
//         log, onScreen(name, img) }
async function toMainMenu(driver, opts = {}) {
  const log = opts.log || noop;
  const deadline = Date.now() + (opts.timeout || 180000);
  const seen = [];
  let protectionTries = 0;
  let lastSkip = 0;
  let unknownSince = null;
  const t0 = Date.now();
  const stamp = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
  while (Date.now() < deadline) {
    const img = await driver.screenshot();
    const { screen } = identify(img);
    if (screen === 'unknown' || screen === 'black') {
      // DOS boot, intro (playscr), credits (gp /c) or loading. f1gp.bat runs
      // "gp /c /g", whose scrolling credits wait for a key (still running
      // after 105 s), so after 5 s of unknown screens, before the first
      // known screen, press Esc every 2 s. With "gp /g" the first menu shows
      // after about 2.4 s and no Esc is sent. opts.skipIntro = false disables.
      if (unknownSince === null) unknownSince = Date.now();
      if (opts.skipIntro !== false && seen.length === 0 && Date.now() - unknownSince > 5000 && Date.now() - lastSkip > 2000) {
        lastSkip = Date.now();
        log(`${stamp()} unknown screen (intro/credits?): pressing Esc`);
        await driver.press('esc', 100);
      }
      await driver.sleep(200);
      continue;
    }
    unknownSince = null;
    // confirm on a second screenshot (frames can be half drawn)
    await driver.sleep(120);
    if (identify(await driver.screenshot()).screen !== screen) continue;
    if (seen[seen.length - 1] !== screen) { seen.push(screen); log(`${stamp()} screen: ${screen}`); if (opts.onScreen) await opts.onScreen(screen, img); }

    if (screen === 'main') return { screens: seen, ms: Date.now() - t0 };
    if (screen === 'language') {
      // English is the chosen language by default (yellow text). The cursor
      // can reach O.K. only from Francais, so: Right, Down, Enter.
      const idx = menuIndex('language', findHighlight(img));
      if (languageChosen(img) !== 0) {
        log(`${stamp()} English not chosen; selecting it`);
        await moveHighlight(driver, 'language', 0, { map: (i) => (i === 3 ? 'up' : 'left'), log });
        await pressUntil(driver, 'enter', (im) => languageChosen(im) === 0, { tries: 3, what: 'English chosen' });
        continue;
      }
      if (idx === 0) { await pressUntil(driver, 'right', (im) => menuIndex('language', findHighlight(im)) === 1, { what: 'Francais highlighted' }); continue; }
      if (idx === 1 || idx === 2) { await pressUntil(driver, 'down', (im) => menuIndex('language', findHighlight(im)) === 3, { what: 'O.K. highlighted' }); continue; }
      if (idx === 3) { await leaveScreen(driver, 'language', 'enter'); continue; }
      await driver.sleep(150);
    } else if (screen === 'protection') {
      if (++protectionTries > 2) throw new Error('manual protection screen did not go away after two answers');
      const q = identifyQuestion(img);
      const answer = opts.answer || (q && q.answer);
      if (!answer) {
        const err = new Error('unknown manual protection question; pass opts.answer (see err.lastImage)');
        err.lastImage = img;
        throw err;
      }
      log(`${stamp()} manual question ${q ? `page ${q.page} paragraph ${q.paragraph} line ${q.line} word ${q.word}` : '(unrecognised)'}; typing "${answer}"`);
      await typeText(driver, answer);
      await driver.sleep(200);
      await leaveScreen(driver, 'protection', 'enter', { tries: 2 });
    } else if (screen === 'joystick') {
      await moveHighlight(driver, 'joystick', 1, { dec: 'left', inc: 'right', log });
      await leaveScreen(driver, 'joystick', 'enter');
    } else if (screen === 'startup') {
      await moveHighlight(driver, 'startup', 1, { log });
      await leaveScreen(driver, 'startup', 'enter', { next: ['main'], settle: 6000 });
    } else {
      // a later screen (circuits, pits...) - not expected before the main menu
      throw new Error(`unexpected screen ${screen} before the main menu`);
    }
  }
  throw new Error(`toMainMenu timed out; screens seen: ${seen.join(' > ')}`);
}

// From power-on to driving.
//   mode 'practice' (default): MAIN MENU > Practise any Circuit > circuit >
//     O.K. > pit garage > Space. Ends with the car off the jacks in the pit
//     lane, session running (screen 'car'). Throttle, brake and gears are the
//     player's at once; in our runs the game steered the car itself until the
//     end of the pit lane (steering keys only acted after the pit exit).
//   mode 'quickrace': MAIN MENU > Quick Race > O.K. (circuit from the Quick
//     Race options: Monza, 3 laps, 26 runners with the shipped prefs). Ends on
//     the grid when the start lights turn green (screen 'race'); the player
//     has full control on the circuit. opts.waitForGreen = false returns as
//     soon as the grid shows.
// opts: { mode, circuit (practice only), answer, timeout, log, onScreen }.
// Returns { screens, ms, circuit, mode }.
async function toTrack(driver, opts = {}) {
  const log = opts.log || noop;
  const t0 = Date.now();
  const stamp = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
  const first = await toMainMenu(driver, opts);
  const seen = first.screens.slice();
  const note = async (s) => { if (seen[seen.length - 1] !== s) { seen.push(s); log(`${stamp()} screen: ${s}`); if (opts.onScreen) await opts.onScreen(s, await driver.screenshot()); } };
  if ((opts.mode || 'practice') === 'quickrace') return quickRace(driver, opts, { t0, seen, note, log, stamp });

  // MAIN MENU -> Practise any Circuit
  await moveHighlight(driver, 'main', MAIN_MENU.indexOf('Practise any Circuit'), { log });
  await leaveScreen(driver, 'main', 'enter', { next: ['circuits'], settle: 8000 });
  await note('circuits');

  // SELECT CIRCUIT
  let circuitName = null;
  if (opts.circuit) {
    const c = CIRCUITS.find(([n]) => n.toLowerCase() === String(opts.circuit).toLowerCase());
    if (!c) throw new Error(`unknown circuit ${opts.circuit}; one of ${CIRCUITS.map((x) => x[0]).join(', ')}`);
    const target = c[1] * 8 + c[2];
    await moveHighlight(driver, 'circuits', target, {
      log,
      map: (idx, tgt) => {
        const [col, row] = [Math.floor(idx / 8), idx % 8], [tc, tr] = [Math.floor(tgt / 8), tgt % 8];
        if (col !== tc) return tc > col ? 'right' : 'left';
        return tr > row ? 'down' : 'up';
      },
    });
    circuitName = c[0];
  } else {
    const idx = menuIndex('circuits', findHighlight(await driver.screenshot()));
    const c = CIRCUITS.find(([, col, row]) => col * 8 + row === idx);
    circuitName = c ? c[0] : null;
  }
  log(`${stamp()} circuit: ${circuitName}`);
  await leaveScreen(driver, 'circuits', 'enter', { next: ['black', 'circuitView'], settle: 5000 });
  await waitScreen(driver, 'circuitView', { timeout: 60000 });
  await note('circuitView');

  // Circuit view: O.K. (item 4) is highlighted by default.
  await moveHighlight(driver, 'circuitView', 4, { log });
  await leaveScreen(driver, 'circuitView', 'enter', { next: ['black', 'cockpit', 'pits', 'car', 'race'], settle: 5000 });

  // Loading, then the pit garage. Wait for TYRE CHOICE on the LCD.
  await waitScreen(driver, 'pits', { timeout: 90000 });
  await note('pits');

  // Drop off the jacks: Space until the LCD shows MPH.
  await pressUntil(driver, 'space', (img) => identify(img).screen === 'car' && readMph(img) !== null,
    { tries: 5, settle: 4000, hold: 200, what: 'car off the jacks (MPH on LCD)' });
  await note('car');
  return { screens: seen, ms: Date.now() - t0, circuit: circuitName, mode: 'practice' };
}

async function quickRace(driver, opts, { t0, seen, note, log, stamp }) {
  await moveHighlight(driver, 'main', MAIN_MENU.indexOf('Quick Race'), { log });
  await leaveScreen(driver, 'main', 'enter', { next: ['black', 'circuitView'], settle: 6000 });
  await waitScreen(driver, 'circuitView', { timeout: 60000 });
  await note('circuitView');
  await moveHighlight(driver, 'circuitView', 4, { log });
  await leaveScreen(driver, 'circuitView', 'enter', { next: ['black', 'cockpit', 'race'], settle: 5000 });
  await waitScreen(driver, 'race', { timeout: 90000 });
  await note('race');
  if (opts.waitForGreen !== false) {
    const r = await waitFor(driver, (img) => readLights(img) === 'green', { timeout: 60000, interval: 100, stable: 1, what: 'green start lights' });
    log(`${stamp()} lights green`);
    if (opts.onScreen) await opts.onScreen('green', r.img);
  }
  return { screens: seen, ms: Date.now() - t0, circuit: null, mode: 'quickrace' };
}

// ---------------------------------------------------------------- driving helpers

// Horizontal shift (px) of the 3D view between two screenshots: best offset
// (-40..40) of the per-column brightness profile of rows 20-95. Positive =
// the view moved right (car yawing left). Noisy frame to frame; sum it over
// ~1 s of 100 ms samples to compare steering phases.
function sceneShift(a, b) {
  const prof = (img) => {
    const p = new Float64Array(320);
    for (let x = 0; x < 320; x++) { let s = 0; for (let y = 20; y < 96; y += 2) { const q = px(img, x, y); s += q[0] + q[1] + q[2]; } p[x] = s; }
    return p;
  };
  const pa = prof(a), pb = prof(b);
  let best = 0, bestErr = Infinity;
  for (let s = -40; s <= 40; s++) {
    let e = 0;
    for (let x = 60; x < 260; x++) e += Math.abs(pa[x] - pb[x + s]);
    if (e < bestErr) { bestErr = e; best = s; }
  }
  return best;
}

async function keyDown(driver, k) { if (driver.keyDown) return driver.keyDown(k); throw new Error('driver has no keyDown'); }
async function keyUp(driver, k) { if (driver.keyUp) return driver.keyUp(k); throw new Error('driver has no keyUp'); }

// Hold O and read the occupancy figure (median of `samples` readings).
async function measureOccupancy(driver, { samples = 5, interval = 300 } = {}) {
  const vals = [];
  await keyDown(driver, 'o');
  try {
    await driver.sleep(400);
    for (let i = 0; i < samples * 3 && vals.length < samples; i++) {
      const v = readOccupancy(await driver.screenshot());
      if (v !== null) vals.push(v);
      await driver.sleep(interval);
    }
  } finally { await keyUp(driver, 'o'); }
  vals.sort((a, b) => a - b);
  return { values: vals, median: vals.length ? vals[vals.length >> 1] : null };
}

// ---------------------------------------------------------------- drivers

// Adapter for lib/node-emu.cjs (the object returned by start()).
function nodeDriver(emu) {
  const code = (k) => { const c = typeof k === 'number' ? k : JSDOS_KEYS[k]; if (c === undefined) throw new Error(`unknown key ${k}`); return c; };
  return {
    press: (k, ms = 120) => emu.press(k, ms),
    keyDown: async (k) => emu.ci.sendKeyEvent(code(k), true),
    keyUp: async (k) => emu.ci.sendKeyEvent(code(k), false),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    mouseMove: async (x, y) => emu.ci.sendMouseMotion(x, y),
    mouseButton: async (b, down) => emu.ci.sendMouseButton(b, down),
    screenshot: () => emu.ci.screenshot(),
  };
}

// Adapter for any js-dos CommandInterface (browser or Node).
function ciDriver(ci) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const code = (k) => { const c = typeof k === 'number' ? k : JSDOS_KEYS[k]; if (c === undefined) throw new Error(`unknown key ${k}`); return c; };
  return {
    async press(k, ms = 120) { ci.sendKeyEvent(code(k), true); await sleep(ms); ci.sendKeyEvent(code(k), false); await sleep(60); },
    keyDown: async (k) => ci.sendKeyEvent(code(k), true),
    keyUp: async (k) => ci.sendKeyEvent(code(k), false),
    sleep,
    mouseMove: async (x, y) => ci.sendMouseMotion(x, y),
    mouseButton: async (b, down) => ci.sendMouseButton(b, down),
    screenshot: () => ci.screenshot(),
  };
}

const api = {
  JSDOS_KEYS, KEY, KEY_NAMES, MANUAL_ANSWERS, MAIN_MENU, CIRCUITS, LANGUAGE_BUTTONS,
  FINGERPRINTS, PIXEL_TESTS,
  px, mask, packBits, unpackBits, jaccard, meanColour, frameDiff, sceneShift,
  identify, identifyQuestion, fpScore, findHighlight, menuIndex, languageChosen,
  readMph, readOccupancy, readLights,
  waitFor, waitScreen, pressUntil, moveHighlight, leaveScreen, typeText,
  toMainMenu, toTrack, measureOccupancy,
  nodeDriver, ciDriver,
};
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else globalThis.F1GPRoute = api;
