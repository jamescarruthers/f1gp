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
| `render.html` | The new view: one screen, our WebGL view with the game's cockpit, dash and messages over it (`layout=side` puts the game beside it), `style=modern|classic`, wide or 4:3 (`framing=`, the Shape menu), the Amiga version's sound by default. |
| `lib/overlay.mjs` | Replaces the game's 3D drawing with a fill, so the page can lay the game's screen over its own view. |
| `probes/p4-gl-ram.mjs`, `probes/gl-ram.html` | Our WebGL view drawn from a RAM capture beside the game's frame of that moment, without the emulator. |
| `lib/pace.mjs` | The game's frame rate (30 fps), the emulated CPU speed while the fill runs, and which game frames the page draws between. |
| `lib/cars.mjs` | The cars as the game draws them (classic), or as 3D models with 3D wheels and helmets (modern). |
| `lib/audio.mjs` | Sound for the direct-mode pages (an AudioWorklet fed by the emulator). |
| `lib/amiga-sound.mjs` | The Amiga version's sound for `render.html?sound=amiga`: its title tune in the menus, its engine and effects in a session. With `lib/amiga-disk.mjs` (the data from the Amiga disk images; `node lib/amiga-disk.mjs` writes `dist/amiga-sound.bin`), `lib/amiga-music.mjs` (the music player), `lib/paula.mjs` (the sound chip), `lib/amiga-race.mjs` (the race rules), `lib/amiga-worklet.mjs` and `lib/dos-sound.mjs` (the DOS game's sound events). |
| `lib/keys.mjs` | The game's keys in a session (driving aids on F1–F6 and the rest), for the page's Keys panel and the landing page; `probes/p5-keys.mjs` presses each key in a race and logs what it toggles. |
| `lib/gamepad.mjs`, `lib/joystick.mjs` | A game controller: its stick and triggers steer, accelerate and brake through the game's own analogue joystick code, which the page takes over during a session; its buttons press the game's keys. `probes/p5-pad.mjs` drives a Quick Race with a stand-in controller. |
| `machine/`, `lib/pc.mjs`, `build-machine.mjs` | Our own PC in Rust: a 286 with the devices and DOS services gp.exe uses, built to `dist/machine.wasm` (221 KB), run by the page with `render.html?machine=rust` in place of DOSBox. `probes/p6-pc-route.mjs` boots the game on it in Node and drives the route to a race; `probes/p6-bench.mjs` and `probes/p6-bench-page.mjs` measure it against DOSBox. See `machine/README.md`. |
| `probes/p7-r3d-record.mjs`, `machine/src/bin/r3d.rs` | The game's own 3D routine caught in a race on our PC, as the reference for drawing the original picture ourselves: each caught state, run again alone, gives the same frame byte for byte. See `machine/README.md`. |
| `bench.html`, `lib/autopilot.mjs` | The two machines measured in your own browser: the same Quick Race on DOSBox and on our PC in turn, driven by the autopilot, with the game's speed, the page's frames, the main thread's time and each machine's top speed side by side, and a button to copy them. On the site; `probes/p6-bench-browser.mjs` runs it headless. |
| `lib/dos-sleep.mjs` | Wakes the emulator from its sleeps on a timer: js-dos's direct mode waits by posting messages to itself, which kept the main thread busy. `probes/p5-profile.mjs` profiles the page's main thread in a race. |
| `lib/saves.mjs` | Keeps the files the game writes (saved games, names, track records, car setups, F1PREFS.DAT) in the browser between visits, and the page's menu choices; `probes/p5-saves.mjs` saves from the game's menu, opens the page again and finds the file. |
| `lib/pixel-smooth.mjs` | The game's cockpit, dash and messages drawn larger through xBR, a filter made for pixel art (`render.html?cockpit=smooth`). |
| `lib/sun-ray.mjs` | Whether points are in the sun or in a shape's shadow: rays toward the sun against the shapes that cast shadows, through a grid; the page dims the cockpit with it. |
| `probes/p5-stutter.mjs` | Frame times in a race: each page frame's interval and the page's own work, with the frames that draw part of the shadow map marked. |
| `amiga/` | Python tools for the Amiga version: disk and hunk readers, a 68000 disassembler, the offline Paula renderer, the title tune and engine renders, `tune-log.py` (the music player's register writes from the 68000 code, for the tests). |
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
