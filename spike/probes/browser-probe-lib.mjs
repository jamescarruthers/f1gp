// Shared helpers for the Phase 0 browser probes (probes/browser-*.mjs).
//
//   import { route, outDir, saveJson, cropPng, opfsList, fsFiles, sha1, sleep } from "./browser-probe-lib.mjs";
//
// route       lib/route.cjs loaded through createRequire (works with the driver
//             from lib/browser-emu.mjs)
// outDir(n)   out/browser-probes/<n>/, created
// cropPng     save a zoomed crop of an RGBA screenshot
// opfsList    list the page's OPFS tree (names and sizes)
// fsFiles     flatten ci.fsTree() into [{path, size}]

import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { encodePng } from "../lib/browser-emu.mjs";

const here = dirname(fileURLToPath(import.meta.url));
export const SPIKE = join(here, "..");
const require = createRequire(import.meta.url);
export const route = require("../lib/route.cjs");

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function outDir(name) {
  const d = join(SPIKE, "out", "browser-probes", name);
  mkdirSync(d, { recursive: true });
  return d;
}

export function saveJson(file, obj) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(obj, null, 1));
}

export const sha1 = (bytes) => createHash("sha1").update(Buffer.from(bytes)).digest("hex");

// Save the rectangle [x, y, w, h] of an RGBA screenshot, scaled up by `zoom`.
export function cropPng(img, rect, zoom, file) {
  const [x0, y0, w, h] = rect;
  const W = w * zoom, H = h * zoom;
  const out = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const sx = x0 + Math.floor(x / zoom), sy = y0 + Math.floor(y / zoom);
    const si = (sy * img.width + sx) * 4, di = (y * W + x) * 4;
    out[di] = img.data[si]; out[di + 1] = img.data[si + 1]; out[di + 2] = img.data[si + 2]; out[di + 3] = 255;
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, encodePng(W, H, out, 4));
  return file;
}

// Hash of a rectangle of an RGBA screenshot (to tell whether it changed).
export function rectHash(img, [x0, y0, w, h]) {
  const hsh = createHash("sha1");
  for (let y = y0; y < y0 + h; y++) hsh.update(Buffer.from(img.data.buffer, img.data.byteOffset + (y * img.width + x0) * 4, w * 4));
  return hsh.digest("hex").slice(0, 12);
}

// Number of pixels that differ between two RGBA screenshots of the same size.
export function diffPixels(a, b) {
  let n = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    if (a.data[i] !== b.data[i] || a.data[i + 1] !== b.data[i + 1] || a.data[i + 2] !== b.data[i + 2]) n++;
  }
  return n;
}

// Every file and folder in the page's OPFS, with sizes.
export function opfsList(page) {
  return page.evaluate(async () => {
    const out = [];
    async function walk(dir, path) {
      for await (const [name, h] of dir.entries()) {
        const p = `${path}/${name}`;
        if (h.kind === "directory") { out.push({ path: p + "/" }); await walk(h, p); }
        else { const f = await h.getFile(); out.push({ path: p, size: f.size }); }
      }
    }
    try { await walk(await navigator.storage.getDirectory(), ""); } catch (e) { out.push({ error: String(e) }); }
    return out;
  });
}

// IndexedDB databases the page can see.
export function idbList(page) {
  return page.evaluate(async () => (indexedDB.databases ? (await indexedDB.databases()) : "no indexedDB.databases()"));
}

// ci.fsTree() flattened to [{path, size}] (paths relative to DOS C:).
export function fsFiles(page, ciExpr = "window.emuCi") {
  return page.evaluate(async (expr) => {
    const ci = eval(expr);
    const tree = await ci.fsTree();
    const out = [];
    const walk = (n, p) => {
      for (const c of n.nodes || []) {
        const path = p ? `${p}/${c.name}` : c.name;
        if (c.nodes) { out.push({ path: path + "/" }); walk(c, path); } else out.push({ path, size: c.size });
      }
    };
    walk(tree, "");
    return out;
  }, ciExpr);
}

// ci.fsReadFile(path) -> Buffer, only if fsTree lists the file (a missing file
// makes the engine throw and the promise never resolves).
export async function readDosFile(page, path, ciExpr = "window.emuCi") {
  const files = await fsFiles(page, ciExpr);
  if (!files.some((f) => f.path === path)) return null;
  const b64 = await page.evaluate(async ([expr, p]) => {
    const ci = eval(expr);
    const bytes = await ci.fsReadFile(p);
    let s = "";
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }, [ciExpr, path]);
  return Buffer.from(b64, "base64");
}

// Run fn with a hard deadline so a probe never hangs.
export function withDeadline(ms, fn) {
  const t = setTimeout(() => { console.error(`deadline ${ms} ms reached`); process.exit(3); }, ms);
  return fn().finally(() => clearTimeout(t));
}

// Parse --key value flags.
export function args(defaults) {
  const o = { ...defaults };
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i++) {
    if (!a[i].startsWith("--")) continue;
    const k = a[i].slice(2);
    const v = a[i + 1] && !a[i + 1].startsWith("--") ? a[++i] : "1";
    o[k] = v;
  }
  return o;
}

// Screens of the in-game save/options flows (from exploration in Node):
//   MAIN MENU item 2 "Load/Save Game" -> LOAD-SAVE MENU (Load Game, Load Track
//   Records, Save Track Records, Load Names, Save Names, Load Car Setups, Save
//   Current Car Setups, Return to Main Menu). "Save Track Records" -> (first
//   time) "NO GAME SAVE DIRECTORY ... Create this subdirectory? Yes/No" ->
//   file dialog (Path C:\GPSAVES\*.*, Cancel highlighted; Up = Filename field,
//   Enter to edit, type, Enter, Down = O.K., Enter) -> "TRACK RECORDS SAVED" O.K.
//   MAIN MENU item 7 "Game Options Menu" -> OPTIONS MENU (Main Menu highlighted);
//   Left = "Save Options", Enter -> "FILE EXISTS Replace this file?" Replace.
export async function menuKeys(driver, keys, gap = 700) {
  for (const k of keys) {
    if (typeof k === "number") { await driver.sleep(k); continue; }
    if (k.startsWith("type:")) { await route.typeText(driver, k.slice(5)); continue; }
    await driver.press(k, 120);
    await driver.sleep(gap);
  }
}

// From MAIN MENU: Save Options (F1PREFS.DAT), then Save Track Records to
// GPSAVES\<name> (creating GPSAVES if the game asks). Back on MAIN MENU after.
export async function doGameSaves(d, shot, name = "probe1") {
  await route.moveHighlight(d, "main", route.MAIN_MENU.indexOf("Game Options Menu"));
  await route.leaveScreen(d, "main", "enter");
  await sleep(1200); await shot("options-menu");
  await menuKeys(d, ["left", "enter", 1200]); await shot("file-exists");
  await menuKeys(d, ["enter", 2000]); await shot("options-saved");
  await menuKeys(d, ["right", "enter", 1500]);
  await route.waitScreen(d, "main", { timeout: 10000 });
  await route.moveHighlight(d, "main", route.MAIN_MENU.indexOf("Load/Save Game"));
  await route.leaveScreen(d, "main", "enter");
  await sleep(1200); await shot("load-save-menu");
  await menuKeys(d, ["down", "down", "enter", 1500]); await shot("no-save-dir");
  await menuKeys(d, ["enter", 1500]); await shot("save-dialog");
  await menuKeys(d, ["up", "enter", `type:${name}`, "enter", 800, "down"]); await shot("save-dialog-filled");
  await menuKeys(d, ["enter", 2500]); await shot("records-saved");
  await menuKeys(d, ["enter", 1500]);
}

// From MAIN MENU: open Load/Save Game > Load Track Records (file list of GPSAVES).
export async function openLoadTrackRecords(d) {
  await route.moveHighlight(d, "main", route.MAIN_MENU.indexOf("Load/Save Game"));
  await route.leaveScreen(d, "main", "enter");
  await sleep(1200);
  await menuKeys(d, ["down", "enter", 2000]);
}
