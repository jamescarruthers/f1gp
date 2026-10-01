# Phase 0 spike

Scripts for running F1GP 1.05 in js-dos, driving it from tests, and reading
its memory. See `../docs/web-port-plan.md` for the plan and the findings.

Bundles (`dist/`), screenshots and logs (`out/`) contain copyrighted game
data. Git ignores both folders: never commit them. The project's owner
publishes one bundle on the GitHub Pages site (below); nothing else in them is
published.

## The site

`node build-site.mjs --out ../_site` builds the GitHub Pages site: the landing
page (`site/index.html`), `render.html` and `map.html`, the modules they import,
the emulator files, and a bundle built from `../original` (AdLib, 25,000 cycles,
with the intro). `.github/workflows/pages.yml` runs it on every push to `main`
and deploys it; pull requests build it as a check.

## Setup

```sh
cd spike
npm ci
node tools/unexepack.mjs                                   # out/gp_unpacked.bin
node build-bundle.mjs --autoexec "gp /g" --out dist/route-g-25000.jsdos
```

`build-bundle.mjs` options: `--game DIR` (default `../original`),
`--out FILE`, `--sound adlib|beep|roland`, `--cycles N`, and
`--autoexec "line1;line2"` (default `f1gp.bat`, which plays the intro;
`gp /g` skips it).

## Main pieces

| File | What it does |
| --- | --- |
| `lib/node-emu.cjs` | Runs a bundle in Node in real time: keys, mouse, screenshots, sound levels, the full js-dos CommandInterface. |
| `lib/guest-mem.cjs` | Finds the emulated PC's RAM and `gp.exe` inside the emulator heap (Node, or direct mode in the browser) and reads it. |
| `lib/route.cjs` | Drives the game from boot to the car on track by recognising each screen. Reads the dash speed and the processor occupancy figure. Works with Node or browser drivers. |
| `lib/browser-emu.mjs` | Starts `serve.mjs` and headless Chromium, opens a test page, and returns a driver for `route.cjs`. |
| `serve.mjs` | Local static server on 127.0.0.1; `--isolate` adds COOP/COEP headers. |
| `index.html` | Test page using the js-dos `Dos()` player (the site's landing page is `site/index.html`). |
| `render.html` | The new view: one screen, our WebGL view with the game's cockpit, dash and messages over it (`layout=side` puts the game beside it), `style=modern|classic`. |
| `lib/overlay.mjs` | Replaces the game's 3D drawing with a fill, so the page can lay the game's screen over its own view. |
| `lib/pace.mjs` | The game's frame rate (30 fps), the emulated CPU speed while the fill runs, and which game frames the page draws between. |
| `lib/cars.mjs` | The cars as the game draws them (classic), or as 3D models with 3D wheels and helmets (modern). |
| `lib/audio.mjs` | Sound for the direct-mode pages (an AudioWorklet fed by the emulator). |
| `build-site.mjs` | Builds the GitHub Pages site. |
| `raw.html` | Test page using the lower-level engine API with our own canvas, input and audio. |
| `lib/f1gp-mem.mjs` | Browser-safe version of `guest-mem.cjs`: finds the game in the emulator heap and reads it. |
| `lib/f1gp-state.mjs` | `readState()`: every car's position, speed, lap and flags, the camera, view, clock and pause state. `readTrack()`: the game's segment array. See `../docs/memory-map.md`. |
| `lib/track-file.mjs` | Parses a track file (`F1CTnn.DAT`) and builds the track exactly as the game does. |
| `map.html`, `lib/map-view.mjs` | The game in the browser (direct mode) beside a live map of every car. |
| `tools/unexepack.mjs` | Removes the EXEPACK compression from `gp.exe`. |
| `tools/disasm.py` | Disassembly helper for the unpacked image (needs capstone or objdump). |
| `tests/` | `node --test tests/*.test.mjs`. Tests that need recorded runs or the game files skip when those are missing. |
| `probes/` | Experiments. `route-demo.cjs`, `mem-locate.cjs`, `p1-state-watch.cjs` and `p1-accuracy-run.cjs` are the ones to start with. |

## Examples

```sh
# Drive a Quick Race: route to the grid, accelerate, brake, steer.
timeout 180 node probes/route-demo.cjs dist/route-g-25000.jsdos demo --mode quickrace

# Watch the game state during a Quick Race.
node build-bundle.mjs --autoexec "gp /g" --cycles 25000 --out dist/p1-state-25000.jsdos
timeout 240 node probes/p1-state-watch.cjs --tag drive --seconds 195

# The live map in a browser: open the URL it prints.
node build-bundle.mjs --autoexec "gp /g" --cycles 25000 --out dist/p1-map-25000.jsdos
node serve.mjs --port 8080   # then http://127.0.0.1:8080/map.html?bundle=dist/p1-map-25000.jsdos

# Find gp.exe in emulated memory.
node build-bundle.mjs --autoexec "gp /g" --out dist/mem-probe.jsdos
timeout 60 node probes/mem-locate.cjs
```

Only Chromium is used for browser tests. Wrap runs in `timeout`: the
emulator runs until stopped.
