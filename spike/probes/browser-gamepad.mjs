// Phase 0 browser probe: does a browser gamepad reach the DOS joystick?
//
//   cd spike && timeout 175 node probes/browser-gamepad.mjs --tag NAME [--backend dosbox|dosboxX] [--worker 1|0]
//
// A fake gamepad is installed before js-dos loads (context.addInitScript):
// navigator.getGamepads() returns one "standard" pad whose axes and buttons we
// set from the test, with a fresh timestamp on each change; a
// "gamepadconnected" event with a .gamepad property is dispatched on window.
// Calls to getGamepads() and gamepad event listeners are counted.
// The game is taken to JOYSTICK SELECTED > Calibrate, whose CALIBRATE
// JOYSTICK A screen shows the raw "Joystick Values" (X, Y) live. We move the
// axes and press button 0 (Fire) and record that box each time.
// Writes out/browser-probes/<tag>/{*.png, values-*.png crops, summary.json, log.txt}.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { launch } from "../lib/browser-emu.mjs";
import { route, outDir, saveJson, args, withDeadline, sleep, cropPng, rectHash } from "./browser-probe-lib.mjs";

const o = args({ tag: "gamepad", backend: "dosbox", worker: "1", bundle: "dist/bprobe-g-25000.jsdos" });
const dir = outDir(o.tag);
const lines = [];
const T0 = Date.now();
const log = (...a) => { const l = `${((Date.now() - T0) / 1000).toFixed(1)}s ${a.join(" ")}`; lines.push(l); console.log(l); };

const FAKE_PAD = () => {
  const mkButtons = () => Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 }));
  const pad = { id: "Fake Pad (STANDARD GAMEPAD Vendor: 045e Product: 028e)", index: 0, connected: true,
    mapping: "standard", timestamp: performance.now(), axes: [0, 0, 0, 0], buttons: mkButtons(),
    vibrationActuator: null, hapticActuators: [] };
  window.__pad = pad;
  window.__padCalls = 0;
  const fake = function getGamepads() { window.__padCalls++; return [pad, null, null, null]; };
  try { Object.defineProperty(Navigator.prototype, "getGamepads", { value: fake, configurable: true, writable: true }); } catch (e) { /* ignore */ }
  try { Object.defineProperty(navigator, "getGamepads", { value: fake, configurable: true, writable: true }); } catch (e) { /* ignore */ }
  window.__setPad = (axes, pressed0) => {
    pad.axes = axes.slice();
    pad.buttons = mkButtons();
    if (pressed0) pad.buttons[0] = { pressed: true, touched: true, value: 1 };
    pad.timestamp = performance.now();
  };
  window.__connectPad = () => {
    const e = new Event("gamepadconnected");
    Object.defineProperty(e, "gamepad", { value: pad });
    window.dispatchEvent(e);
  };
  window.__gpListeners = [];
  const origAdd = EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener = function (type, ...rest) {
    if (/gamepad/i.test(String(type))) window.__gpListeners.push(String(type));
    return origAdd.call(this, type, ...rest);
  };
  // Emscripten can also poll through a timer; nothing else to hook.
};

await withDeadline(170000, async () => {
  const query = { backend: o.backend, worker: o.worker };
  const emu = await launch({ bundle: o.bundle, page: "index.html", query, log, readyTimeout: 90000 });
  const d = emu.driver, page = emu.page;
  const summary = { options: o, url: emu.url };
  try {
    // Reload with the fake pad installed before any page script runs.
    await emu.context.addInitScript(FAKE_PAD);
    await page.goto(emu.url, { waitUntil: "load" });
    await page.waitForFunction(() => window.emuReady === true, null, { timeout: 90000, polling: 100 });
    await page.evaluate(() => window.__connectPad());
    summary.afterStart = await page.evaluate(() => ({ calls: window.__padCalls, listeners: window.__gpListeners,
      hasPad: navigator.getGamepads()[0]?.id }));
    log("after start:", JSON.stringify(summary.afterStart));

    let n = 0;
    const shot = async (name) => d.shot(join(dir, `${String(n++).padStart(2, "0")}-${name}.png`));
    try {
      await route.toMainMenu(d, { log, onScreen: async (s) => { await shot(`route-${s}`); if (s === "joystick") throw new Error("STOP-AT-JOYSTICK"); } });
      throw new Error("joystick dialog did not appear");
    } catch (e) { if (!/STOP-AT-JOYSTICK/.test(e.message)) throw e; }
    await page.evaluate(() => window.__connectPad());
    await d.press("enter", 150); // Calibrate
    await sleep(2500);
    await shot("calibrate");

    const img0 = await d.screenshot();
    const k = img0.width / 320;
    const box = [168, 138, 146, 46].map((v) => Math.round(v * k));
    summary.frameSize = [img0.width, img0.height];
    const states = [
      ["centre", [0, 0, 0, 0], false],
      ["centre-again", [0, 0, 0, 0], false],
      ["left", [-1, 0, 0, 0], false],
      ["right", [1, 0, 0, 0], false],
      ["up", [0, -1, 0, 0], false],
      ["down", [0, 1, 0, 0], false],
      ["left-fire", [-1, 0, 0, 0], true],
      ["left-released", [-1, 0, 0, 0], false],
      ["centre-end", [0, 0, 0, 0], false],
    ];
    summary.states = [];
    for (const [name, axes, fire] of states) {
      await page.evaluate(([a, f]) => window.__setPad(a, f), [axes, fire]);
      // keep the timestamp moving, as a real pad would
      for (let i = 0; i < 6; i++) { await sleep(250); await page.evaluate(() => { window.__pad.timestamp = performance.now(); }); }
      const img = await d.screenshot();
      const crop = cropPng(img, box, Math.round(3 / k), join(dir, `values-${String(summary.states.length).padStart(2, "0")}-${name}.png`));
      const full = await shot(`state-${name}`);
      const calls = await page.evaluate(() => window.__padCalls);
      const rec = { name, axes, fire, boxHash: rectHash(img, box), screenHash: rectHash(img, [0, 0, img.width, Math.round(60 * k)]), padCalls: calls, crop, full };
      summary.states.push(rec);
      log(`${name}: values box ${rec.boxHash}, prompt area ${rec.screenHash}, getGamepads() calls so far ${calls}`);
    }
    summary.distinctBoxHashes = [...new Set(summary.states.map((s) => s.boxHash))].length;
    summary.distinctPromptHashes = [...new Set(summary.states.map((s) => s.screenHash))].length;
    summary.end = await page.evaluate(() => ({ calls: window.__padCalls, listeners: window.__gpListeners }));
    log("end:", JSON.stringify(summary.end), "distinct values boxes", summary.distinctBoxHashes, "distinct prompt areas", summary.distinctPromptHashes);
    await d.pageShot(join(dir, "page-end.png"));
  } catch (e) {
    log("ERROR", e.stack);
    summary.error = String(e.stack);
  } finally {
    summary.messages = ((await d.events().catch(() => [])) || []).filter((e) => e.type === "message" && /joy|stick|gamepad|sdl/i.test(e.m)).slice(0, 40);
    summary.consoleErrors = emu.consoleMessages.filter((m) => m.type === "error");
    summary.consoleGamepad = emu.consoleMessages.filter((m) => /joy|stick|gamepad|sdl/i.test(m.text)).slice(0, 40);
    summary.pageErrors = emu.pageErrors;
    summary.totalMs = Date.now() - T0;
    saveJson(join(dir, "summary.json"), summary);
    writeFileSync(join(dir, "log.txt"), lines.join("\n") + "\n");
    await emu.close();
  }
});
process.exit(0);
