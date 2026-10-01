// Build the GitHub Pages site: the landing page, the game pages, the modules
// and emulator files they load, and one game bundle built from ../original.
//
//   node build-site.mjs [--out ../_site] [--game ../original]
//
// The bundle (dist/f1gp.jsdos) holds the game files the game needs to run
// (build-bundle.mjs leaves out the installer and other unused files) with
// AdLib sound, 25,000 cycles and the intro. The project's owner publishes it
// on the site; it is never committed. .github/workflows/pages.yml runs this.

import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { buildBundle } from "./build-bundle.mjs";

const here = dirname(new URL(import.meta.url).pathname);
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const OUT = opt("out", join(here, "..", "_site"));
const GAME = opt("game", join(here, "..", "original"));

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const copy = (from, to = from) => {
  mkdirSync(dirname(join(OUT, to)), { recursive: true });
  cpSync(join(here, from), join(OUT, to), { recursive: true });
};

copy("site/index.html", "index.html");
copy("render.html");
copy("map.html");
// the modules the pages import, followed from page to module
const needed = new Set();
const scan = (file) => {
  const src = readFileSync(join(here, file), "utf8");
  for (const m of src.matchAll(/from\s+["']\.\/((?:lib\/)?[\w-]+\.mjs)["']/g)) {
    const dep = file.startsWith("lib/") ? join("lib", m[1].replace(/^lib\//, "")) : m[1];
    if (!needed.has(dep)) { needed.add(dep); scan(dep); }
  }
};
for (const page of ["render.html", "map.html"]) scan(page);
for (const f of needed) copy(f);
// the emulator: the loader, DOSBox (direct mode) and the zip reader it uses for bundles
for (const f of ["emulators.js", "wdosbox.js", "wdosbox.wasm", "wlibzip.js", "wlibzip.wasm"]) copy(`node_modules/js-dos/dist/emulators/${f}`);
copy("node_modules/fflate/esm/browser.js");

const bundle = buildBundle({
  game: GAME, out: join(OUT, "dist", "f1gp.jsdos"), sound: "adlib", cycles: "25000",
  autoexec: "f1gp.bat", conf: join(here, "dosbox.conf"),
});
// GitHub Pages runs Jekyll unless told not to; it would drop node_modules
writeFileSync(join(OUT, ".nojekyll"), "");

let files = 0, bytes = 0;
const walk = (d) => { for (const f of readdirSync(d)) { const p = join(d, f); const s = statSync(p); if (s.isDirectory()) walk(p); else { files++; bytes += s.size; } } };
walk(OUT);
console.log(JSON.stringify({ out: OUT, files, megabytes: +(bytes / 1048576).toFixed(1), bundle }));
