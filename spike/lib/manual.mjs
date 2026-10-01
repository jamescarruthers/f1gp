// The game's manual check (copy protection) on the page itself, as a player
// with the English manual would answer it: on CHOOSE LANGUAGE ("Is your
// Manual in:"), with English chosen (the game's default), move to O.K. and
// press Enter; on the question, type the word and press Enter. On JOYSTICK
// SELECTED, which follows when the saved settings choose a joystick, pick Use
// Keys: our pages take the keyboard. Screens are
// recognised as lib/route.cjs does (same fingerprints, highlight finder and
// answer; tests/manual.test.mjs checks they stay the same). The question has
// been the same on every boot we made.
//
//   const helper = manualHelper({ image: () => imageData, sendKey: (code, down) => ci.sendKeyEvent(code, down), onAnswer });
//   setInterval(helper.check, 250);

// Source: UK English manual (January 1992), printed page 85, 4th body
// paragraph, line 1, word 11.
export const MANUAL_ANSWERS = {
  q85_4_1_11: { page: 85, paragraph: 4, line: 1, word: 11, answer: 'require' },
};

// rect = [x, y, w, h] in 320x200 space, mode = pixel test, bits = base64 mask
export const FINGERPRINTS = {
 "language": {
  "rect": [
   60,
   43,
   201,
   15
  ],
  "mode": "white",
  "ref": "p1/t004.png",
  "bits": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAPBwcPIAH+PA/8AEwcHDwcDgwAA//AwAAAP4ZGP7BP/zn/+ADYOBg+GcwYIB//g8AAAAOMzAOx+E8jIGBA+DBwzjMYOCBwxgYAAAADGBgDIyBOTADAgPAg40xgMHAAwMwIAAAAAzAwAywAeYABgAGwAwzMwCDwQwDYAAAAAAYgP8ZYAPMH/wDDIAZxmYABoMZBsA/AAAAMACDM8AGGP74BxiAYQzP4A2GYQyefwAAAGAABmaADTDAMQAwAMMYnIEbDMMYOAMAAACAAQyMgTEwA2dAYCD/MzAGMxj/YzAGBAAAAIcZGIfjcAzGwMBhBmZgHMYwBsZhDAwAAAD8MzD8g3/4z//B/wbYwPCPfwYY//wfAAAA4OHg4AE8wIf/gf8IkIGBB3wIEHj4HwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
 },
 "protection": {
  "rect": [
   60,
   43,
   201,
   15
  ],
  "mode": "white",
  "ref": "p6/q1.png",
  "bits": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGDAwMDBHQ4MfAD+8Afw4P/+Bx7+7w8eHBzAwYGBgxkMGPgA/Oc/+Mf//R///N8P/zgYgMeBBw8zGHjgADCMYTicGDIwh4khDofzMADfAw82ZjDwwABgMIMxMDBgQAYAAwwGZmMA/gUzzMxgMIMBwGAGM8BgwAAGAAYYBtjMAMwNZhibwWAGA4BhDGOAwYB/DAAMMAywsQEYGYYxPINhGAYA//jHAIMB/xgAGGAYYMMDMDAMY3AGwzAMAH7wgwEGAwYwADDAMMAGB2Bg/M/ADMb/GAgMYAYGBgYMyABggMHADAzAwBiYgTGMgXEYGMAYHA4MGJjDwACHwxkYgIMbYAPjnwH2P3jAY/APfPg//sGHP/4xMAAHJ0AGBh8C5D/wgIeBB/jwP/CADz/wYGAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
 },
 "q85_4_1_11": {
  "rect": [
   196,
   124,
   25,
   41
  ],
  "mode": "yellow",
  "ref": "p6/q1.png",
  "bits": "AAAAAAAAgM8fgLEBAGM/AHzAAIyBARgbA+DjAwAAAAAAAAAAAAAAOAAAeAAA2AAAmAEA8AcAAAYAAB4AAAAAAAAAAAAAAGAAAOAAAIABAAADAAAGAAAMAAB+AAAAAAAAAAAAAICBAYCDAwAGBgAMDAAYGAAwMAD4+QEAAAAAAAAA"
 },
 "joystick": {
  "rect": [
   60,
   55,
   201,
   15
  ],
  "mode": "white",
  "ref": "p8/r1.png",
  "bits": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD4wYOB4cP//cHDwwA+/M8H/gce/u9//gAA8OMfAfOf//vhn8MA//m/D/wf//zf//0HAADjcAbzMDHE4TDGAA9jYA4wMIeJIQMzHAAAxsAY48BggMEAzAAOzIAMYEAGAAMGZDAAAMwAY4MDwADDANgAOIABGMAABgAGDMDAAACYAYYDf4ABhgHwAPAH/zCAfwwADPiHgQEAMAMMAvgDAwwD4AGAP/5hAP8YABjwDwMDYGAGGAQABwYYBsAGAHAMwAAGMAAwYAAGBsDAGBgIDBwMMBiAGcDAGZCBDMgAYMCADAYAw3A4EDAYGOBwGGMAgzEwhxmYw8CAgRkOAP7BP3DgP/jwxz+HAf7zf//7P/7Bh//7DwDwAB7gAB/w4QceDgbw4X/+8z/wgA//8wcAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
 }
};

const TESTS = {
  white: (r, g, b) => r > 200 && g > 200 && b > 200,
  yellow: (r, g, b) => r > 200 && g > 200 && b > 100 && b < 170,
  red: (r, g, b) => Math.abs(r - 195) < 20 && g < 30 && b < 30, // menu highlight (195,0,0)
};

function px(img, x, y) {
  const sx = img.width === 320 ? x : Math.floor((x * img.width) / 320);
  const sy = img.height === 200 ? y : Math.floor((y * img.height) / 200);
  const o = (sy * img.width + sx) * 4;
  return [img.data[o], img.data[o + 1], img.data[o + 2]];
}

const cache = {};
function score(img, name) {
  const fp = FINGERPRINTS[name];
  const [x0, y0, w, h] = fp.rect, test = TESTS[fp.mode];
  if (!cache[name]) {
    const bytes = Uint8Array.from(atob(fp.bits), (c) => c.charCodeAt(0));
    cache[name] = Uint8Array.from({ length: w * h }, (_, i) => (bytes[i >> 3] >> (i & 7)) & 1);
  }
  const ref = cache[name];
  let inter = 0, uni = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const [r, g, b] = px(img, x0 + x, y0 + y);
    const a = test(r, g, b), k = ref[y * w + x];
    if (a && k) inter++;
    if (a || k) uni++;
  }
  return uni ? inter / uni : 0;
}

// Centre of the red menu highlight, or null (route.cjs findHighlight): rows
// whose longest red run is at least 16 px, merged when up to 10 rows apart;
// the block with the most red wins.
function highlight(img) {
  const rows = [];
  for (let y = 0; y < 200; y++) {
    let run = 0, best = 0, s = 0, bx0 = 0, bx1 = 0;
    for (let x = 0; x < 320; x++) {
      const [r, g, b] = px(img, x, y);
      if (TESTS.red(r, g, b)) { if (!run) s = x; run++; if (run > best) { best = run; bx0 = s; bx1 = x; } } else run = 0;
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
  const total = (bl) => bl.reduce((s, r) => s + r.n, 0);
  blocks.sort((a, b) => total(b) - total(a));
  const bl = blocks[0];
  return { cx: (Math.min(...bl.map((r) => r.x0)) + Math.max(...bl.map((r) => r.x1))) / 2, cy: (bl[0].y + bl[bl.length - 1].y) / 2 };
}

// CHOOSE LANGUAGE: the highlighted button (0 English, 1 Francais, 2 Deutsch,
// 3 O.K.) and the chosen language (yellow text), or null.
function languageScreen(img) {
  if (score(img, 'language') < 0.8) return null;
  const h = highlight(img);
  const cursor = !h ? null : h.cy > 140 ? 3 : h.cx < 120 ? 0 : h.cx < 200 ? 1 : 2;
  let chosen = null;
  [[42, 118], [122, 198], [202, 278]].forEach(([a, b], i) => {
    let n = 0;
    for (let y = 118; y <= 130; y++) for (let x = a; x <= b; x++) { const [r, g, bl] = px(img, x, y); if (TESTS.yellow(r, g, bl)) n++; }
    if (n > 100 && chosen === null) chosen = i;
  });
  return { cursor, chosen };
}

/**
 * Which step of the check is on screen: { step: 'language', cursor, chosen },
 * { step: 'question', known: { page, paragraph, line, word, answer } or null if
 * unrecognised }, { step: 'joystick', cursor }, or null.
 * @param {{ width, height, data }} img  RGBA screen (320x200 or a multiple)
 */
export function manualScreen(img) {
  if (!img) return null;
  const lang = languageScreen(img);
  if (lang) return { step: 'language', ...lang };
  if (score(img, 'joystick') >= 0.8) {
    const h = highlight(img);
    return { step: 'joystick', cursor: !h ? null : h.cx < 160 ? 0 : 1 }; // 0 Calibrate, 1 Use Keys
  }
  if (score(img, 'protection') < 0.8) return null;
  for (const q of Object.keys(MANUAL_ANSWERS)) if (score(img, q) >= 0.9) return { step: 'question', known: MANUAL_ANSWERS[q] };
  return { step: 'question', known: null };
}

// js-dos key codes (GLFW numbering): letters A-Z 65-90, Enter 257, arrows 262 right, 264 down
const KEY = { right: 262, down: 264, enter: 257 };
const keyOf = (ch) => ch.toUpperCase().charCodeAt(0);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Takes the player through the manual check: one key per call on CHOOSE
 * LANGUAGE (only while English is the chosen language) and on JOYSTICK
 * SELECTED, and the word plus Enter on the question (at most twice in a row
 * if the screen stays).
 * @param {{ image: () => ImageData|null, sendKey: (code, down) => void, onAnswer?: (q) => void,
 *   onLanguage?: (key: 'right'|'down'|'enter') => void, onJoystick?: (key: 'right'|'enter') => void }} o
 */
export function manualHelper(o) {
  let busy = false, tries = 0, lastSeen = 0;
  const tap = async (code) => { o.sendKey(code, true); await sleep(80); o.sendKey(code, false); };
  return {
    async check() {
      if (busy) return;
      const s = manualScreen(o.image());
      if (!s) { if (performance.now() - lastSeen > 3000) tries = 0; return; }
      busy = true;
      try {
        if (s.step === 'language') {
          // English chosen: the cursor reaches O.K. only from Francais (Right, Down, Enter)
          if (s.chosen !== 0 || s.cursor === null) return;
          const key = s.cursor === 0 ? 'right' : s.cursor === 3 ? 'enter' : 'down';
          await tap(KEY[key]);
          if (o.onLanguage) o.onLanguage(key);
          await sleep(s.cursor === 3 ? 1500 : 250);
          return;
        }
        if (s.step === 'joystick') {
          if (s.cursor === null) return;
          const key = s.cursor === 0 ? 'right' : 'enter';
          await tap(KEY[key]);
          if (o.onJoystick) o.onJoystick(key);
          await sleep(s.cursor === 1 ? 1500 : 250);
          return;
        }
        lastSeen = performance.now();
        if (!s.known || tries >= 2) return;
        tries++;
        for (const ch of s.known.answer) { await tap(keyOf(ch)); await sleep(80); }
        await sleep(150);
        await tap(KEY.enter);
        if (o.onAnswer) o.onAnswer(s.known);
        await sleep(1500); // let the screen change before looking again
      } finally { busy = false; }
    },
  };
}
