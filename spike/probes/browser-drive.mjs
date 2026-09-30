// Phase 0 browser probe: route to the track in headless Chromium with
// lib/route.cjs and the lib/browser-emu.mjs driver, then drive (A), brake (Z),
// steer (comma / period, quick race only), read occupancy, and sample the
// page's audio output the whole time.
//
//   cd spike && timeout 175 node probes/browser-drive.mjs --tag NAME
//       [--page index.html|raw.html] [--input ci|real] [--mode practice|quickrace]
//       [--bundle dist/bprobe-g-25000.jsdos] [--q key=value,key=value]
//
// --input real sends every key (the whole route and the driving) as real DOM
// KeyboardEvents through Playwright's page.keyboard; ci uses ci.sendKeyEvent.
// Writes out/browser-probes/<tag>/{*.png, summary.json, log.txt}.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { launch } from "../lib/browser-emu.mjs";
import { route, outDir, saveJson, args, withDeadline, sleep } from "./browser-probe-lib.mjs";

const o = args({ tag: "drive", page: "index.html", input: "ci", mode: "practice",
  bundle: "dist/bprobe-g-25000.jsdos", q: "" });
const dir = outDir(o.tag);
const query = Object.fromEntries(o.q.split(",").filter(Boolean).map((kv) => kv.split("=")));
const lines = [];
const T0 = Date.now();
const log = (...a) => { const l = `${((Date.now() - T0) / 1000).toFixed(1)}s ${a.join(" ")}`; lines.push(l); console.log(l); };

await withDeadline(170000, async () => {
  const emu = await launch({ bundle: o.bundle, page: o.page, input: o.input, query, log });
  const d = emu.driver;
  const summary = { options: o, query, url: emu.url };
  // Count the DOM key events the page receives (capture phase, on window), to
  // show that --input real really goes through KeyboardEvents.
  await emu.page.evaluate(() => {
    window.domKeys = { down: 0, up: 0, codes: {}, keyCodes: {} };
    const f = (e) => { window.domKeys[e.type === "keydown" ? "down" : "up"]++;
      if (e.type === "keydown") { window.domKeys.codes[e.code] = (window.domKeys.codes[e.code] || 0) + 1;
        window.domKeys.keyCodes[e.keyCode] = (window.domKeys.keyCodes[e.keyCode] || 0) + 1; } };
    window.addEventListener("keydown", f, true); window.addEventListener("keyup", f, true);
  });
  let n = 0;
  const save = async (name) => d.shot(join(dir, `${String(n++).padStart(2, "0")}-${name}.png`));

  // Audio + engine counters, sampled every 500 ms in the background.
  const audio = [];
  let sampling = true;
  const sampler = (async () => {
    while (sampling) {
      try {
        const s = await emu.page.evaluate(async () => {
          const st = await window.emuCi.asyncifyStats();
          return { level: window.audioProbe.level(), messageSound: st.messageSound, messageFrame: st.messageFrame,
            frames: window.emuFrames, raw: window.rawAudio ? { pushed: window.rawAudio.pushed, queued: window.rawAudio.queued } : null };
        });
        audio.push({ t: Date.now() - T0, ...s });
      } catch { /* page busy or closed */ }
      await sleep(500);
    }
  })();
  const phase = (name) => audio.push({ t: Date.now() - T0, phase: name });

  try {
    summary.pageStart = (await d.events()).find((e) => e.type === "page-start");
    phase("route");
    const res = await route.toTrack(d, {
      mode: o.mode, log,
      onScreen: async (name) => { await save(`route-${name}`); },
    });
    summary.route = res;
    log(`toTrack done in ${(res.ms / 1000).toFixed(1)} s`);
    await d.pageShot(join(dir, "page-on-track.png"));

    const steerCheck = async () => {
      const steer = {};
      for (const [label, key] of [["none", null], ["left", "comma"], ["right", "period"]]) {
        if (key) await d.keyDown(key);
        let a = await d.screenshot(); let total = 0; const shifts = [];
        for (let i = 0; i < 10; i++) {
          await sleep(100);
          const b = await d.screenshot();
          const sh = route.sceneShift(a, b); shifts.push(sh); total += sh; a = b;
        }
        await save(`steer-${label}`);
        if (key) await d.keyUp(key);
        steer[label] = { total, shifts, mph: route.readMph(a) };
      }
      log("steer view-shift sums (px; + = car turning left):",
        JSON.stringify(Object.fromEntries(Object.entries(steer).map(([k, v]) => [k, v.total]))));
      summary.steer = steer;
    };

    // Drive 10 s holding A (quick race: steering check after 3 s, A still held).
    phase("accelerate");
    const drive = [];
    await d.keyDown("a");
    const tDrive = Date.now();
    for (let i = 1; i <= 10; i++) {
      await sleep(Math.max(0, tDrive + i * 1000 - Date.now()));
      const img = await d.screenshot();
      drive.push({ t: +((Date.now() - tDrive) / 1000).toFixed(1), mph: route.readMph(img), screen: route.identify(img).screen });
      if (i % 2 === 0) await save(`drive-${String(i).padStart(2, "0")}s`);
      if (o.mode === "quickrace" && i === 3) { phase("steer"); await steerCheck(); phase("accelerate"); }
    }
    await d.keyUp("a");
    log("drive (A held) mph:", JSON.stringify(drive.map((x) => x.mph)));
    summary.drive = drive;

    phase("brake");
    const before = route.readMph(await d.screenshot());
    const brake = [];
    await d.keyDown("z");
    for (let i = 0; i < 6; i++) { await sleep(500); brake.push(route.readMph(await d.screenshot())); }
    await save("brake-3s");
    await d.keyUp("z");
    log("brake (Z held) from", before, "mph:", JSON.stringify(brake));
    summary.brake = { before, after: brake };

    phase("occupancy");
    const occ = await route.measureOccupancy(d, { samples: 5 });
    await d.keyDown("o"); await sleep(500); await save("occupancy"); await d.keyUp("o");
    log("occupancy (O held):", JSON.stringify(occ));
    summary.occupancy = occ;
    phase("idle");
    await sleep(1500);
  } catch (e) {
    log("ERROR", e.stack);
    summary.error = String(e.stack);
    try { await save("error"); await d.pageShot(join(dir, "page-error.png")); } catch { /* ignore */ }
  } finally {
    sampling = false;
    await sampler;
    const events = await d.events().catch(() => []);
    summary.domKeys = await emu.page.evaluate(() => window.domKeys).catch(() => null);
    log("DOM key events seen by the page:", JSON.stringify(summary.domKeys));
    summary.audioEvents = (events || []).filter((e) => /^audio/.test(e.type));
    summary.status = await d.status().catch(() => null);
    summary.audio = audio;
    // Per-phase audio summary: mean/max RMS at the tapped destination, sound
    // messages per second.
    const phases = {};
    let cur = "start";
    for (let i = 0; i < audio.length; i++) {
      const a = audio[i];
      if (a.phase) { cur = a.phase; continue; }
      const p = (phases[cur] ??= { n: 0, rmsSum: 0, rmsMax: 0, state: null, soundMsgs: 0, secs: 0 });
      const lv = a.level?.[0];
      if (lv) { p.n++; p.rmsSum += lv.rms; p.rmsMax = Math.max(p.rmsMax, lv.rms); p.state = lv.state; p.sampleRate = lv.sampleRate; }
      const prev = audio.slice(0, i).reverse().find((x) => !x.phase);
      if (prev) { p.soundMsgs += a.messageSound - prev.messageSound; p.secs += (a.t - prev.t) / 1000; }
    }
    summary.audioByPhase = Object.fromEntries(Object.entries(phases).map(([k, p]) => [k, {
      samples: p.n, meanRms: +(p.rmsSum / (p.n || 1)).toFixed(4), maxRms: +p.rmsMax.toFixed(4), state: p.state,
      sampleRate: p.sampleRate, soundMsgsPerSec: +(p.soundMsgs / (p.secs || 1)).toFixed(1) }]));
    log("audio by phase:", JSON.stringify(summary.audioByPhase));
    summary.consoleErrors = emu.consoleMessages.filter((m) => m.type === "error");
    summary.pageErrors = emu.pageErrors;
    summary.nonLocalRequests = emu.requests.filter((r) => !r.local);
    summary.totalMs = Date.now() - T0;
    saveJson(join(dir, "summary.json"), summary);
    writeFileSync(join(dir, "log.txt"), lines.join("\n") + "\n");
    await emu.close();
  }
});
process.exit(0);
