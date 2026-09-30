// Boot a bundle in headless Chromium and record what happens.
//
//   node probes/browser-boot.mjs [--tag NAME] [--page index.html|raw.html]
//        [--bundle dist/browser-default.jsdos] [--isolate] [--block]
//        [--worker 1|0] [--backend dosbox|dosboxX] [--duration 45] [--interval 5]
//        [--input ci|real] [--q key=value ...] [--keys "t:key,t:key"]
//        [--ready-timeout ms]
//
// Writes into out/browser/<tag>/:
//   tNNN.png        emulator framebuffer (ci.screenshot) every --interval seconds
//   page-tNNN.png   what the page actually shows (first, middle and last sample)
//   summary.json    requests (non-local flagged), server log, console errors,
//                   crossOriginIsolated, typeof SharedArrayBuffer, audio state and
//                   levels, frame counts and engine stats per sample
// and prints the summary (without the long lists) to stdout.
// --keys presses keys at given seconds, e.g. --keys "20:enter,25:down".
//
// Wrap runs in `timeout`, e.g. timeout 150 node probes/browser-boot.mjs --tag base

import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { launch, sleep } from "../lib/browser-emu.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const spike = join(here, "..");

const args = process.argv.slice(2);
const opt = { tag: "boot", page: "index.html", bundle: "dist/browser-default.jsdos", isolate: false,
  block: false, duration: 45, interval: 5, input: "ci", query: {}, keys: "" };
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  const next = () => args[++i];
  if (a === "--tag") opt.tag = next();
  else if (a === "--page") opt.page = next();
  else if (a === "--bundle") opt.bundle = next();
  else if (a === "--isolate") opt.isolate = true;
  else if (a === "--block") opt.block = true;
  else if (a === "--worker") opt.query.worker = next();
  else if (a === "--backend") opt.query.backend = next();
  else if (a === "--duration") opt.duration = Number(next());
  else if (a === "--interval") opt.interval = Number(next());
  else if (a === "--input") opt.input = next();
  else if (a === "--keys") opt.keys = next();
  else if (a === "--ready-timeout") opt.readyTimeout = Number(next());
  else if (a === "--q") { const [k, v] = next().split("="); opt.query[k] = v; }
  else { console.error(`unknown option ${a}`); process.exit(2); }
}

const outDir = join(spike, "out", "browser", opt.tag);
mkdirSync(outDir, { recursive: true });
const pad = (n) => String(n).padStart(3, "0");
const t0 = Date.now();
const secs = () => ((Date.now() - t0) / 1000).toFixed(1);

const keyPlan = opt.keys ? opt.keys.split(",").map((s) => {
  const [t, k] = s.split(":");
  return { t: Number(t), key: k, done: false };
}) : [];

let emu;
const summary = { options: opt, startedAt: new Date().toISOString() };
try {
  emu = await launch({
    bundle: opt.bundle, page: opt.page, isolate: opt.isolate, blockNetwork: opt.block,
    query: opt.query, input: opt.input, readyTimeout: opt.readyTimeout ?? 60000, log: (l) => console.error(`[${secs()}s] ${l}`),
  });
  const { page, driver } = emu;
  summary.url = emu.url;
  summary.readyAfterMs = Date.now() - t0;
  summary.env = await page.evaluate(() => ({
    crossOriginIsolated: window.crossOriginIsolated,
    sharedArrayBuffer: typeof SharedArrayBuffer,
    secureContext: window.isSecureContext,
    userAgent: navigator.userAgent,
    audioWorklet: typeof AudioWorkletNode,
    opfs: typeof navigator.storage?.getDirectory,
  }));

  const samples = [];
  let prevStats = null;
  let prevFrames = 0;
  const readyAt = Date.now();
  const nSamples = Math.floor(opt.duration / opt.interval);
  for (let i = 1; i <= nSamples; i++) {
    const target = readyAt + i * opt.interval * 1000;
    while (Date.now() < target) {
      const el = (Date.now() - readyAt) / 1000;
      for (const k of keyPlan) {
        if (!k.done && el >= k.t) { k.done = true; await driver.press(k.key, 150); console.error(`[${secs()}s] key ${k.key}`); }
      }
      await sleep(Math.min(200, Math.max(0, target - Date.now())));
    }
    const tRel = Math.round((Date.now() - readyAt) / 1000);
    const name = `t${pad(tRel)}.png`;
    let shotOk = true;
    try { await driver.shot(join(outDir, name)); } catch (e) { shotOk = String(e.message); }
    if (i === 1 || i === Math.ceil(nSamples / 2) || i === nSamples) {
      await driver.pageShot(join(outDir, `page-${name}`));
    }
    const st = await driver.status();
    const stats = await driver.stats().catch((e) => ({ error: String(e) }));
    const d = prevStats && !stats.error ? {
      messageFrame: stats.messageFrame - prevStats.messageFrame,
      messageSound: stats.messageSound - prevStats.messageSound,
      sleepCount: stats.sleepCount - prevStats.sleepCount,
      sleepTime: stats.sleepTime - prevStats.sleepTime,
    } : null;
    const cm = typeof stats.cpuMetrics === "object" && stats.cpuMetrics ? stats.cpuMetrics : null;
    const sample = {
      t: tRel, shot: shotOk === true ? name : shotOk,
      frames: st.frames, framesDelta: st.frames - prevFrames,
      size: `${st.width}x${st.height}`, soundFrequency: st.soundFrequency,
      audio: st.audio, ownAudio: st.ownAudio ?? undefined,
      engine: stats.error ? stats : { messageFrame: stats.messageFrame, messageSound: stats.messageSound,
        sleepCount: stats.sleepCount, delta: d,
        cpu: cm ? { cpuMax: cm.cpuMax, cpuAuto: cm.cpuAuto, emulatorSpeed: cm.emulatorSpeed,
          ticksDone: cm.ticksDone?.slice(-3), ticksScheduled: cm.ticksScheduled?.slice(-3) } : stats.cpuMetrics },
    };
    prevStats = stats.error ? prevStats : stats;
    prevFrames = st.frames;
    samples.push(sample);
    const a = st.audio?.[0];
    console.error(`[${secs()}s] t=${tRel}s frames=${st.frames} (+${sample.framesDelta}) ${sample.size} ` +
      `sound msgs +${d?.messageSound ?? "?"} audio=${a ? `${a.state} rms=${a.rms.toFixed(4)} peak=${a.peak.toFixed(3)}` : "none"}`);
  }
  summary.samples = samples;
  summary.events = (await driver.events()).slice(0, 400);
  // Page clock (ms after navigation start) of the main start-up steps.
  summary.pageTimings = Object.fromEntries(summary.events
    .filter((e) => e.type === "dos-event" || e.type === "ci-ready" || e.type === "bundle-loaded" || e.type === "frame-size")
    .map((e) => [e.event ?? e.type, Math.round(e.t)]));
  summary.audioContexts = await page.evaluate(() => window.audioProbe.contexts.map((c) => ({ state: c.state, sampleRate: c.sampleRate, currentTime: c.currentTime })));
} catch (e) {
  summary.error = String(e?.stack ?? e);
  if (e?.requests) {
    summary.requests = e.requests;
    summary.nonLocalRequests = e.requests.filter((r) => !r.local);
    summary.serverLog = e.serverLog;
    summary.consoleErrors = e.consoleMessages.filter((m) => m.type === "error" || m.type === "warning");
    summary.pageErrors = e.pageErrors;
  }
  console.error(summary.error);
} finally {
  if (emu) {
    summary.requests = emu.requests;
    summary.nonLocalRequests = emu.requests.filter((r) => !r.local);
    summary.websockets = emu.websockets;
    summary.serverLog = emu.serverLog;
    summary.consoleErrors = emu.consoleMessages.filter((m) => m.type === "error" || m.type === "warning");
    summary.consoleMessages = emu.consoleMessages.slice(0, 300);
    summary.pageErrors = emu.pageErrors;
    await emu.close();
  }
  summary.totalMs = Date.now() - t0;
  writeFileSync(join(outDir, "summary.json"), JSON.stringify(summary, null, 1));
  const short = {
    tag: opt.tag, url: summary.url, error: summary.error, readyAfterMs: summary.readyAfterMs, pageTimings: summary.pageTimings, env: summary.env,
    requests: summary.requests?.length, nonLocalRequests: summary.nonLocalRequests,
    websockets: summary.websockets, consoleErrors: summary.consoleErrors?.slice(0, 15),
    pageErrors: summary.pageErrors,
    lastSample: summary.samples?.at(-1), audioContexts: summary.audioContexts,
  };
  console.log(JSON.stringify(short, null, 1));
  process.exit(summary.error ? 1 : 0);
}
