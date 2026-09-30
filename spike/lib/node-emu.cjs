// Run a js-dos bundle in Node (no browser) and record what it does.
// Used by the Phase 0 probes to drive the game with scripted keys and
// capture frames and sound.

const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

// js-dos ships as an ES module package, but its emulators.js is a CommonJS
// bundle that calls require(). Copy it to a CommonJS folder before loading.
const SRC_DIR = path.join(__dirname, "..", "node_modules", "js-dos", "dist", "emulators");
const EMU_DIR = path.join(__dirname, "..", "out", "emulators-cjs");
fs.mkdirSync(EMU_DIR, { recursive: true });
fs.writeFileSync(path.join(EMU_DIR, "package.json"), '{"type":"commonjs"}');
for (const f of fs.readdirSync(SRC_DIR)) {
  if (/\.(js|wasm)$/.test(f)) fs.copyFileSync(path.join(SRC_DIR, f), path.join(EMU_DIR, f));
}
require(path.join(EMU_DIR, "emulators.js"));

// ci.screenshot() builds an ImageData, which Node lacks.
if (typeof global.ImageData === "undefined") {
  global.ImageData = class ImageData {
    constructor(data, width, height) { this.data = data; this.width = width; this.height = height; }
  };
}
const emulators = global.emulators;
emulators.pathPrefix = EMU_DIR + "/";

// DOSBox key codes used by js-dos (GLFW numbering).
const KEYS = {
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

// Encode an RGB or RGBA buffer as PNG.
function encodePng(width, height, pixels, channels) {
  const stride = width * channels;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(pixels.buffer, pixels.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = channels === 4 ? 6 : 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function start(bundlePath, { backend = "dosbox" } = {}) {
  const bundle = new Uint8Array(fs.readFileSync(bundlePath));
  const ci = backend === "dosboxX"
    ? await emulators.dosboxXNode(bundle)
    : await emulators.dosboxNode(bundle);

  const state = {
    ci,
    width: 0, height: 0,
    lastFrame: null, lastFrameChannels: 3,
    frames: 0,
    soundSamples: 0, soundSumSq: 0, soundPeak: 0,
    stdout: [], messages: [], exited: false,
  };
  const ev = ci.events();
  ev.onFrameSize((w, h) => { state.width = w; state.height = h; });
  ev.onFrame((rgb, rgba) => {
    state.frames++;
    if (rgba) { state.lastFrame = rgba; state.lastFrameChannels = 4; }
    else if (rgb) { state.lastFrame = rgb; state.lastFrameChannels = 3; }
  });
  ev.onSoundPush((samples) => {
    state.soundSamples += samples.length;
    for (let i = 0; i < samples.length; i++) {
      const s = samples[i];
      state.soundSumSq += s * s;
      const a = Math.abs(s);
      if (a > state.soundPeak) state.soundPeak = a;
    }
  });
  ev.onStdout((m) => state.stdout.push(m));
  ev.onMessage((t, ...args) => state.messages.push([t, ...args].join(" ")));
  ev.onExit(() => { state.exited = true; });

  const api = {
    ci, state, KEYS, sleep,
    // Take the emulator's own screenshot and save it as PNG.
    async shot(file) {
      const img = await ci.screenshot();
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, encodePng(img.width, img.height, img.data, 4));
      return file;
    },
    // Hold a key for `ms` milliseconds.
    async press(key, ms = 120) {
      const code = typeof key === "number" ? key : KEYS[key];
      if (code === undefined) throw new Error(`unknown key ${key}`);
      ci.sendKeyEvent(code, true);
      await sleep(ms);
      ci.sendKeyEvent(code, false);
      await sleep(60);
    },
    async type(text, gap = 150) {
      for (const ch of text.toLowerCase()) await api.press(ch === " " ? "space" : ch, 80), await sleep(gap);
    },
    // Reset and read the sound level since the last call.
    soundLevel() {
      const n = state.soundSamples || 1;
      const out = { samples: state.soundSamples, rms: Math.sqrt(state.soundSumSq / n), peak: state.soundPeak };
      state.soundSamples = 0; state.soundSumSq = 0; state.soundPeak = 0;
      return out;
    },
    async stop() { try { await ci.exit(); } catch { /* already gone */ } },
  };
  return api;
}

module.exports = { start, encodePng, KEYS, sleep };
