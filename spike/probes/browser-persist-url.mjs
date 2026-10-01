// Phase 0 browser probe: do in-game saves survive a page reload when the
// js-dos Dos() player loads the bundle by URL (index.html)?
//
//   cd spike && timeout 175 node probes/browser-persist-url.mjs --tag NAME [--save 1|0]
//
// 1. index.html?fresh=1 (OPFS cleared), route to MAIN MENU (Use Keys on the
//    JOYSTICK SELECTED dialog sets keyboard control in memory).
// 2. In game: Game Options Menu > Save Options > Replace (writes F1PREFS.DAT),
//    then Load/Save Game > Save Track Records > create GPSAVES > "PROBE1".
// 3. --save 1: window.dos.save() (the player's own save: ci.persist(true) ->
//    OPFS). --save 0: no save call, to see what a plain reload keeps.
// 4. Reload the page with fresh=0 (same origin and port), check fsTree,
//    F1PREFS.DAT hash, the OPFS contents, and the game's own Load Track
//    Records file list.
// Writes out/browser-probes/<tag>/{*.png, summary.json, log.txt}.

import { writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { launch } from "../lib/browser-emu.mjs";
import { route, outDir, saveJson, args, withDeadline, sleep, fsFiles, readDosFile, opfsList, idbList, sha1, menuKeys, SPIKE } from "./browser-probe-lib.mjs";

const o = args({ tag: "persist-url", save: "1", bundle: "dist/bprobe-g-25000.jsdos", name: "probe1" });
const dir = outDir(o.tag);
const lines = [];
const T0 = Date.now();
const log = (...a) => { const l = `${((Date.now() - T0) / 1000).toFixed(1)}s ${a.join(" ")}`; lines.push(l); console.log(l); };
const ORIG_PREFS = sha1(readFileSync(join(SPIKE, "..", "original", "f1prefs.dat")));

await withDeadline(170000, async () => {
  const emu = await launch({ bundle: o.bundle, page: "index.html", query: { fresh: 1 }, log });
  const d = emu.driver, page = emu.page;
  const summary = { options: o, url: emu.url, originalPrefsSha1: ORIG_PREFS };
  let n = 0;
  const shot = async (name) => d.shot(join(dir, `${String(n++).padStart(2, "0")}-${name}.png`));
  const dosState = async (label) => {
    const files = await fsFiles(page);
    const prefs = await readDosFile(page, "F1PREFS.DAT");
    const saves = files.filter((f) => /^GPSAVES\//i.test(f.path));
    const st = { files: files.length, gpsaves: saves, prefsSha1: prefs ? sha1(prefs) : null,
      prefsChanged: prefs ? sha1(prefs) !== ORIG_PREFS : null };
    log(`${label}: GPSAVES ${JSON.stringify(saves)} F1PREFS.DAT ${st.prefsSha1?.slice(0, 12)} (changed from shipped: ${st.prefsChanged})`);
    return st;
  };
  try {
    // ---- first session
    const first = await route.toMainMenu(d, { log, onScreen: async (s) => { await shot(`s1-${s}`); } });
    summary.session1Screens = first.screens;
    summary.before = await dosState("session 1 before saving");

    // Save Options (F1PREFS.DAT)
    await route.moveHighlight(d, "main", route.MAIN_MENU.indexOf("Game Options Menu"));
    await route.leaveScreen(d, "main", "enter");
    await sleep(1200); await shot("options-menu");
    await menuKeys(d, ["left", "enter", 1200]); await shot("file-exists");
    await menuKeys(d, ["enter", 2000]); await shot("options-saved");
    await menuKeys(d, ["right", "enter", 1500]);
    await route.waitScreen(d, "main", { timeout: 10000 });

    // Save Track Records -> GPSAVES\PROBE1
    await route.moveHighlight(d, "main", route.MAIN_MENU.indexOf("Load/Save Game"));
    await route.leaveScreen(d, "main", "enter");
    await sleep(1200); await shot("load-save-menu");
    await menuKeys(d, ["down", "down", "enter", 1500]); await shot("no-save-dir");
    await menuKeys(d, ["enter", 1500]); await shot("save-dialog");
    await menuKeys(d, ["up", "enter", `type:${o.name}`, "enter", 800, "down"]); await shot("save-dialog-filled");
    await menuKeys(d, ["enter", 2500]); await shot("records-saved");
    await menuKeys(d, ["enter", 1500]);
    summary.after = await dosState("session 1 after saving");

    if (o.save === "1") {
      const t = Date.now();
      summary.saveResult = await page.evaluate(() => window.dos.save());
      summary.saveMs = Date.now() - t;
      log(`window.dos.save() -> ${summary.saveResult} in ${summary.saveMs} ms`);
      await sleep(500);
    }
    summary.opfsBeforeReload = await opfsList(page);
    summary.idbBeforeReload = await idbList(page);
    summary.localStorageBeforeReload = await page.evaluate(() => Object.fromEntries(Object.entries(localStorage)));
    log("OPFS before reload:", JSON.stringify(summary.opfsBeforeReload));
    log("IndexedDB databases:", JSON.stringify(summary.idbBeforeReload));

    // ---- reload (fresh=0 so index.html keeps OPFS)
    const bundleFetchesBefore = emu.serverLog.filter((l) => l.includes(o.bundle)).length;
    const reloadUrl = emu.url.replace("fresh=1", "fresh=0");
    await page.evaluate(() => window.emuCi?.exit()).catch(() => {});
    const tr = Date.now();
    await page.goto(reloadUrl, { waitUntil: "load" });
    await page.waitForFunction(() => window.emuReady === true, null, { timeout: 60000, polling: 100 });
    summary.reloadReadyMs = Date.now() - tr;
    summary.bundleFetchedAgain = emu.serverLog.filter((l) => l.includes(o.bundle)).length - bundleFetchesBefore;
    log(`reloaded ${reloadUrl}; ready in ${summary.reloadReadyMs} ms; bundle fetched from server again: ${summary.bundleFetchedAgain}`);
    summary.reloadEvents = (await d.events()).filter((e) => e.type !== "message" && e.type !== "stdout").slice(0, 30);
    summary.consoleAfterReload = emu.consoleMessages.filter((m) => m.t > tr - T0).map((m) => `${m.type}: ${m.text}`).slice(0, 30);
    await sleep(1500);
    summary.reloaded = await dosState("session 2 after reload");
    summary.opfsAfterReload = await opfsList(page);

    // ---- second session: route to the menu and look in the game's file list
    const second = await route.toMainMenu(d, { log, onScreen: async (s) => { await shot(`s2-${s}`); } });
    summary.session2Screens = second.screens;
    await route.moveHighlight(d, "main", route.MAIN_MENU.indexOf("Load/Save Game"));
    await route.leaveScreen(d, "main", "enter");
    await sleep(1200);
    await menuKeys(d, ["down", "enter", 2000]); await shot("s2-load-track-records");
    await d.pageShot(join(dir, "page-s2-load-track-records.png"));
  } catch (e) {
    log("ERROR", e.stack);
    summary.error = String(e.stack);
    try { await shot("error"); } catch { /* ignore */ }
  } finally {
    summary.consoleErrors = emu.consoleMessages.filter((m) => m.type === "error");
    summary.pageErrors = emu.pageErrors;
    summary.nonLocalRequests = emu.requests.filter((r) => !r.local);
    summary.serverLog = emu.serverLog.filter((l) => !/node_modules/.test(l));
    summary.totalMs = Date.now() - T0;
    saveJson(join(dir, "summary.json"), summary);
    writeFileSync(join(dir, "log.txt"), lines.join("\n") + "\n");
    await emu.close();
  }
});
process.exit(0);
