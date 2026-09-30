// Run a js-dos bundle in headless Chromium (playwright-core) and drive it.
//
//   import { launch, KEYS } from "./lib/browser-emu.mjs";
//   const emu = await launch({ bundle: "dist/browser-default.jsdos" });
//   await emu.driver.press("enter", 120);
//   const img = await emu.driver.screenshot();      // {width, height, data: RGBA}
//   await emu.driver.shot("out/browser/x.png");      // same, saved as PNG
//   await emu.close();
//
// launch() options:
//   bundle      bundle URL relative to the spike folder (default dist/browser-default.jsdos)
//   page        "index.html" (js-dos Dos() player) or "raw.html" (engine API, own canvas)
//   isolate     serve with COOP/COEP headers (default false)
//   port        server port (default 0 = pick a free one)
//   headless    default true
//   query       extra query options for the page, e.g. { worker: 0, backend: "dosboxX" }
//   input       "ci" (default): keys and mouse go through the CommandInterface
//               (window.emuCi, same object as window.ci): sendKeyEvent etc.
//               "real": keys go through page.keyboard (real DOM KeyboardEvents with
//               KeyboardEvent.code, e.g. "KeyA"), mouse through page.mouse over the canvas
//   blockNetwork  abort every request that is not to our 127.0.0.1 server (default false)
//   viewport    default { width: 1024, height: 790 }
//   readyTimeout  ms to wait for window.emuReady (default 60000)
//   chromiumArgs  extra Chromium flags
//   log         function(line) for progress lines (default: none)
//
// Returns { browser, context, page, server, serverLog, requests, consoleMessages,
//           pageErrors, websockets, driver, close() }.
// requests: [{ t, url, method, type, local, blocked }]; local is true for
// 127.0.0.1/localhost, blob: and data: URLs.
//
// driver (same shape as the Node driver, so a route module can use either):
//   press(keyName, holdMs = 120)   keyName as in lib/node-emu.cjs KEYS, or a code number
//   type(text, gap = 150)
//   sleep(ms)
//   mouseMove(x, y)                absolute position, 0..1 across the game screen
//   mouseMoveRelative(dx, dy)      relative motion in pixels (pointer-lock style)
//   mouseButton(button, pressed)   0 = left, 1 = right
//   screenshot()                   -> { width, height, data } (RGBA, emulator framebuffer)
//   shot(pngPath)                  saves screenshot() as PNG
//   pageShot(pngPath)              Playwright screenshot of the visible page (what the
//                                  renderer actually drew)
//   status()                       window.emuStatus() from the page
//   stats()                        ci.asyncifyStats() (frame/sound/sleep counters, cpuMetrics)
//   frames()                       window.emuFrames
//   input                          "ci" | "real"

import { chromium } from "playwright-core";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { deflateSync } from "node:zlib";
import { startServer } from "../serve.mjs";

// js-dos key codes (GLFW numbering). Same table as lib/node-emu.cjs.
export const KEYS = {
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

// The same keys as Playwright key names (these set KeyboardEvent.code and keyCode).
export const DOM_KEYS = {
  space: "Space", comma: "Comma", period: "Period", slash: "Slash",
  esc: "Escape", enter: "Enter", tab: "Tab", backspace: "Backspace",
  right: "ArrowRight", left: "ArrowLeft", down: "ArrowDown", up: "ArrowUp",
  lshift: "ShiftLeft", lctrl: "ControlLeft", lalt: "AltLeft",
};
for (let i = 0; i < 10; i++) DOM_KEYS[i] = `Digit${i}`;
for (let i = 0; i < 26; i++) { const c = String.fromCharCode(97 + i); DOM_KEYS[c] = `Key${c.toUpperCase()}`; }
for (let i = 1; i <= 10; i++) DOM_KEYS[`f${i}`] = `F${i}`;

const CODE_TO_NAME = Object.fromEntries(Object.entries(KEYS).map(([k, v]) => [v, k]));

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// PNG encoder (copy of the one in lib/node-emu.cjs, so importing this module
// does not load the Node emulator).
function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
export function encodePng(width, height, pixels, channels = 4) {
  const stride = width * channels;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(pixels.buffer, pixels.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = channels === 4 ? 6 : 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr), pngChunk("IDAT", deflateSync(raw)), pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function isLocalUrl(u) {
  if (u.startsWith("blob:") || u.startsWith("data:") || u.startsWith("about:")) return true;
  try {
    const { hostname } = new URL(u);
    return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]";
  } catch { return false; }
}

export async function launch({
  bundle = "dist/browser-default.jsdos",
  page: pageName = "index.html",
  isolate = false,
  port = 0,
  headless = true,
  query = {},
  input,
  keyMode,
  blockNetwork = false,
  viewport = { width: 1024, height: 790 },
  readyTimeout = 60000,
  chromiumArgs = [],
  log = () => {},
} = {}) {
  input = input ?? (keyMode === "keyboard" ? "real" : keyMode) ?? "ci";
  const serverLog = [];
  const srv = await startServer({ port, isolate, quiet: true, log: (l) => serverLog.push(l) });
  const t0 = Date.now();
  const requests = [];
  const consoleMessages = [];
  const pageErrors = [];
  const websockets = [];

  let browser;
  try {
    browser = await chromium.launch({
      headless,
      args: ["--autoplay-policy=no-user-gesture-required", ...chromiumArgs],
    });
  } catch (e) {
    await new Promise((r) => srv.server.close(r));
    throw e;
  }
  const context = await browser.newContext({ viewport });
  context.on("request", (req) => {
    const url = req.url();
    requests.push({ t: Date.now() - t0, url, method: req.method(), type: req.resourceType(),
      local: isLocalUrl(url), blocked: false });
  });
  if (blockNetwork) {
    await context.route("**/*", (route) => {
      const url = route.request().url();
      if (isLocalUrl(url)) return route.continue();
      const r = requests.findLast?.((x) => x.url === url);
      if (r) r.blocked = true;
      log(`blocked ${url}`);
      return route.abort("blockedbyclient");
    });
  }
  const page = await context.newPage();
  page.on("console", (m) => consoleMessages.push({ t: Date.now() - t0, type: m.type(), text: m.text(),
    location: m.location()?.url }));
  page.on("pageerror", (e) => pageErrors.push({ t: Date.now() - t0, message: String(e?.stack ?? e) }));
  page.on("websocket", (ws) => websockets.push({ t: Date.now() - t0, url: ws.url() }));
  page.on("worker", (w) => consoleMessages.push({ t: Date.now() - t0, type: "worker-started", text: w.url() }));

  const params = new URLSearchParams({ bundle, ...Object.fromEntries(
    Object.entries(query).map(([k, v]) => [k, String(v)])) });
  const url = `${srv.url}${pageName}?${params}`;
  log(`open ${url}`);

  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    // ci.exit() can take a long time or never resolve (seen with DOSBox-X in a
    // Worker), so give it 3 s and then close the browser anyway.
    await Promise.race([page.evaluate(() => window.emuCi?.exit()).catch(() => {}), sleep(3000)]);
    try { await browser.close(); } catch { /* ignore */ }
    await new Promise((r) => srv.server.close(r));
    srv.server.closeAllConnections?.();
  };

  try {
    await page.goto(url, { waitUntil: "load" });
    // Not window.ci: js-dos.js defines a global function named ci() of its own.
    await page.waitForFunction(() => window.emuReady === true, null, { timeout: readyTimeout, polling: 100 });
  } catch (e) {
    const events = await page.evaluate(() => window.emuEvents).catch(() => null);
    const err = new Error(`page did not become ready: ${e.message}\nevents: ${JSON.stringify(events)?.slice(0, 2000)}\n` +
      `console: ${JSON.stringify(consoleMessages.slice(-20))}\npage errors: ${JSON.stringify(pageErrors)}`);
    Object.assign(err, { requests, consoleMessages, pageErrors, websockets, serverLog });
    await close();
    throw err;
  }
  log(`ci ready after ${Date.now() - t0} ms`);

  // Where the game screen is on the page (for real mouse input).
  async function screenRect() {
    return page.evaluate(() => {
      const c = document.querySelector("#screen") || document.querySelector("#dos canvas") ||
        document.querySelector("canvas");
      const r = c.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    });
  }
  let lastMouse = { x: 0.5, y: 0.5 };

  const driver = {
    input,
    sleep,
    async press(key, holdMs = 120) {
      const code = typeof key === "number" ? key : KEYS[key];
      if (code === undefined) throw new Error(`unknown key ${key}`);
      if (input === "real") {
        const name = typeof key === "number" ? CODE_TO_NAME[key] : key;
        const domKey = DOM_KEYS[name];
        if (!domKey) throw new Error(`no DOM key for ${key}`);
        await page.keyboard.down(domKey);
        await sleep(holdMs);
        await page.keyboard.up(domKey);
      } else {
        await page.evaluate((c) => window.emuCi.sendKeyEvent(c, true), code);
        await sleep(holdMs);
        await page.evaluate((c) => window.emuCi.sendKeyEvent(c, false), code);
      }
      await sleep(60);
    },
    async keyDown(key) {
      if (input === "real") return page.keyboard.down(DOM_KEYS[key]);
      return page.evaluate((c) => window.emuCi.sendKeyEvent(c, true), KEYS[key]);
    },
    async keyUp(key) {
      if (input === "real") return page.keyboard.up(DOM_KEYS[key]);
      return page.evaluate((c) => window.emuCi.sendKeyEvent(c, false), KEYS[key]);
    },
    async type(text, gap = 150) {
      const named = { " ": "space", ".": "period", ",": "comma", "/": "slash" };
      for (const ch of text.toLowerCase()) {
        await driver.press(named[ch] ?? ch, 80);
        await sleep(gap);
      }
    },
    async mouseMove(x, y) {
      lastMouse = { x, y };
      if (input === "real") {
        const r = await screenRect();
        return page.mouse.move(r.x + x * r.width, r.y + y * r.height);
      }
      return page.evaluate(([a, b]) => window.emuCi.sendMouseMotion(a, b), [x, y]);
    },
    async mouseMoveRelative(dx, dy) {
      return page.evaluate(([a, b]) => window.emuCi.sendMouseRelativeMotion(a, b), [dx, dy]);
    },
    async mouseButton(button, pressed) {
      if (input === "real") {
        const r = await screenRect();
        await page.mouse.move(r.x + lastMouse.x * r.width, r.y + lastMouse.y * r.height);
        const b = button === 0 ? "left" : "right";
        return pressed ? page.mouse.down({ button: b }) : page.mouse.up({ button: b });
      }
      return page.evaluate(([b, p]) => window.emuCi.sendMouseButton(b, p), [button, pressed]);
    },
    async screenshot() {
      const r = await page.evaluate(async () => {
        const img = await window.emuCi.screenshot();
        const bytes = new Uint8Array(img.data.buffer, img.data.byteOffset, img.data.byteLength);
        let s = "";
        for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
        return { width: img.width, height: img.height, b64: btoa(s) };
      });
      return { width: r.width, height: r.height, data: new Uint8Array(Buffer.from(r.b64, "base64")) };
    },
    async shot(file) {
      const img = await driver.screenshot();
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, encodePng(img.width, img.height, img.data, 4));
      return file;
    },
    async pageShot(file) {
      mkdirSync(dirname(file), { recursive: true });
      await page.screenshot({ path: file });
      return file;
    },
    status: () => page.evaluate(() => window.emuStatus?.()),
    stats: () => page.evaluate(() => window.emuCi.asyncifyStats()),
    frames: () => page.evaluate(() => window.emuFrames),
    events: () => page.evaluate(() => window.emuEvents),
  };

  return { browser, context, page, server: srv, serverLog, requests, consoleMessages, pageErrors,
    websockets, driver, url, close };
}
