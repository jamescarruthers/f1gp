// Build a js-dos bundle (f1gp.jsdos) from a copy of the F1GP game files.
//
//   node build-bundle.mjs [--game ../original] [--out dist/f1gp.jsdos]
//                         [--sound adlib|beep|roland] [--cycles 25000]
//                         [--autoexec "f1gp.bat"]
//
// The bundle holds the game files. dist/ is ignored by git: never commit a
// bundle. build-site.mjs builds one for the project's GitHub Pages site, which
// the owner has chosen to publish.

import { readFileSync, readdirSync, statSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { createHash } from "node:crypto";
import { zipSync } from "fflate";

const here = dirname(new URL(import.meta.url).pathname);

function parseArgs(argv) {
  const opts = {
    game: join(here, "..", "original"),
    out: join(here, "dist", "f1gp.jsdos"),
    sound: "adlib",
    cycles: "25000",
    autoexec: "f1gp.bat",
    conf: join(here, "dosbox.conf"),
  };
  for (let i = 2; i < argv.length; i += 2) {
    const key = argv[i].replace(/^--/, "");
    if (!(key in opts)) throw new Error(`unknown option --${key}`);
    opts[key] = argv[i + 1];
  }
  return opts;
}

// Files the game does not need at run time.
const SKIP = new Set([
  "f1gp.rnc", // compressed copy of every other file
  "install.exe",
  "hdinst.exe",
  "cd1.exe",
  "cdpatch.exe",
  "mpscopy.exe",
  "bootmake.bat",
  "x", // placeholder added to the repo
]);

const REQUIRED = [
  "gp.exe", "playscr.exe", "test.scr", "f1gp.bat",
  "f1gpdata.dat", "f1gpdatb.dat", "f1prefs.dat",
  ...Array.from({ length: 16 }, (_, i) => `f1ct${String(i + 1).padStart(2, "0")}.dat`),
];

// Each sound device has four files; the game loads the x* copies.
const SOUND_PREFIX = { adlib: "a", beep: "b", roland: "r" };
const SOUND_PARTS = ["intro", "ingame", "sound", "credit"];

const KNOWN_GP_EXE = {
  "431111406de115b90166faeb49e7681f99b77130ac916863826cc9f6f28f4bb6": "F1GP 1.05 (European)",
};

export function buildBundle(opts) {
  const files = {};
  for (const name of readdirSync(opts.game)) {
    const path = join(opts.game, name);
    if (!statSync(path).isFile()) continue;
    const lower = name.toLowerCase();
    if (SKIP.has(lower)) continue;
    files[lower.toUpperCase()] = new Uint8Array(readFileSync(path));
  }

  const missing = REQUIRED.filter((f) => !files[f.toUpperCase()]);
  if (missing.length) throw new Error(`missing game files: ${missing.join(", ")}`);

  const prefix = SOUND_PREFIX[opts.sound];
  if (!prefix) throw new Error(`unknown sound set ${opts.sound}`);
  for (const part of SOUND_PARTS) {
    const src = files[`${prefix}${part}.bin`.toUpperCase()];
    if (!src) throw new Error(`missing ${prefix}${part}.bin`);
    files[`X${part}.bin`.toUpperCase()] = src;
  }

  const hash = createHash("sha256").update(files["GP.EXE"]).digest("hex");
  const version = KNOWN_GP_EXE[hash] ?? `unknown gp.exe ${hash}`;

  const conf = readFileSync(opts.conf, "utf8")
    .replace("@CYCLES@", opts.cycles)
    .replace("@AUTOEXEC@", opts.autoexec.split(";").join("\r\n"));
  // the game saves into C:\GPSAVES and refuses when the folder is missing
  files["GPSAVES/"] = new Uint8Array(0);
  files[".jsdos/dosbox.conf"] = new TextEncoder().encode(conf);
  files[".jsdos/jsdos.json"] = new TextEncoder().encode(JSON.stringify({ version: "8" }));

  const zip = zipSync(files, { level: 6 });
  mkdirSync(dirname(resolve(opts.out)), { recursive: true });
  writeFileSync(opts.out, zip);
  return { out: opts.out, version, fileCount: Object.keys(files).length, bytes: zip.length };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = buildBundle(parseArgs(process.argv));
  console.log(JSON.stringify(result));
}
