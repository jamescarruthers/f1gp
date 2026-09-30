// Phase 0 browser probe: do in-game saves survive a reload when the bundle is
// not loaded from a stable URL (the Phase 1 case: the page builds the bundle
// from the player's own files)?
//
//   cd spike && timeout 175 node probes/browser-persist-blob.mjs --variant blob|blob-key|raw-idb [--tag NAME]
//
//   blob     Dos() player, url = blob: URL of the bundle bytes, player saves (dos.save())
//   blob-key same, plus fsChanges.urlToKey() returning a fixed key
//   raw-idb  engine API, emulators.dosboxWorker([bundle, changes]); saves are
//            ci.persist(true) stored in IndexedDB by the page (window.saveChanges())
// Pages: out/browser-probes/pages/blob.html and raw-idb.html.
// Same in-game saves as browser-persist-url.mjs (Save Options + Save Track
// Records "PROBE1"), reload, then check fsTree, F1PREFS.DAT, OPFS / IndexedDB
// and the game's Load Track Records list.

import { writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { launch } from "../lib/browser-emu.mjs";
import { route, outDir, saveJson, args, withDeadline, sleep, fsFiles, readDosFile, opfsList, idbList, sha1,
  doGameSaves, openLoadTrackRecords, SPIKE } from "./browser-probe-lib.mjs";

const o = args({ variant: "blob", tag: "", bundle: "dist/bprobe-g-25000.jsdos", name: "probe1", reloads: "1" });
const dir = outDir(o.tag || `persist-${o.variant}`);
const lines = [];
const T0 = Date.now();
const log = (...a) => { const l = `${((Date.now() - T0) / 1000).toFixed(1)}s ${a.join(" ")}`; lines.push(l); console.log(l); };
const ORIG_PREFS = sha1(readFileSync(join(SPIKE, "..", "original", "f1prefs.dat")));
const pageName = o.variant === "raw-idb" ? "out/browser-probes/pages/raw-idb.html" : "out/browser-probes/pages/blob.html";
const query = { fresh: 1, ...(o.variant === "blob-key" ? { key: 1 } : {}) };

await withDeadline(170000, async () => {
  const emu = await launch({ bundle: o.bundle, page: pageName, query, log });
  const d = emu.driver, page = emu.page;
  const summary = { options: o, url: emu.url, originalPrefsSha1: ORIG_PREFS };
  let n = 0;
  const shot = async (name) => d.shot(join(dir, `${String(n++).padStart(2, "0")}-${name}.png`));
  const dosState = async (label) => {
    const files = await fsFiles(page);
    const prefs = await readDosFile(page, "F1PREFS.DAT");
    const saves = files.filter((f) => /^GPSAVES\//i.test(f.path));
    const st = { gpsaves: saves, prefsSha1: prefs ? sha1(prefs) : null, prefsChanged: prefs ? sha1(prefs) !== ORIG_PREFS : null };
    log(`${label}: GPSAVES ${JSON.stringify(saves)} F1PREFS.DAT ${st.prefsSha1?.slice(0, 12)} (changed from shipped: ${st.prefsChanged})`);
    return st;
  };
  const storage = async (label) => {
    const s = { opfs: await opfsList(page), idb: await idbList(page),
      saved: await page.evaluate(() => window.savedInfo?.() ?? null), blobUrl: await page.evaluate(() => window.blobUrl ?? null) };
    log(`${label}: OPFS ${JSON.stringify(s.opfs)} IndexedDB ${JSON.stringify(s.idb)} page-saved ${JSON.stringify(s.saved)} blobUrl ${s.blobUrl}`);
    return s;
  };
  try {
    summary.pageStart = (await d.events()).find((e) => e.type === "page-start");
    const first = await route.toMainMenu(d, { log, onScreen: async (s) => { await shot(`s1-${s}`); } });
    summary.session1Screens = first.screens;
    summary.before = await dosState("session 1 before saving");
    await doGameSaves(d, shot, o.name);
    summary.after = await dosState("session 1 after saving");

    const t = Date.now();
    summary.saveResult = o.variant === "raw-idb"
      ? await page.evaluate(() => window.saveChanges())
      : await page.evaluate(() => window.dos.save());
    summary.saveMs = Date.now() - t;
    log(`save -> ${JSON.stringify(summary.saveResult)} in ${summary.saveMs} ms`);
    await sleep(500);
    summary.storageBeforeReload = await storage("before reload");

    summary.reloads = [];
    for (let r = 1; r <= +o.reloads; r++) {
      const reloadUrl = emu.url.replace("fresh=1", "fresh=0");
      await page.evaluate(() => window.emuCi?.exit()).catch(() => {});
      const tr = Date.now();
      await page.goto(reloadUrl, { waitUntil: "load" });
      await page.waitForFunction(() => window.emuReady === true, null, { timeout: 60000, polling: 100 });
      const rec = { readyMs: Date.now() - tr };
      rec.pageStart = (await d.events()).find((e) => e.type === "page-start");
      rec.console = emu.consoleMessages.filter((m) => m.t > tr - T0).map((m) => `${m.type}: ${m.text}`).slice(0, 20);
      log(`reload ${r}: ready in ${rec.readyMs} ms; page-start ${JSON.stringify(rec.pageStart)}; console ${JSON.stringify(rec.console)}`);
      await sleep(1500);
      rec.dos = await dosState(`after reload ${r}`);
      rec.storage = await storage(`after reload ${r}`);
      summary.reloads.push(rec);
    }

    const second = await route.toMainMenu(d, { log, onScreen: async (s) => { await shot(`s2-${s}`); } });
    summary.session2Screens = second.screens;
    await openLoadTrackRecords(d);
    await shot("s2-load-track-records");
  } catch (e) {
    log("ERROR", e.stack);
    summary.error = String(e.stack);
    try { await shot("error"); } catch { /* ignore */ }
  } finally {
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
