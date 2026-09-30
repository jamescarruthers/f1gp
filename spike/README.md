# Phase 0 spike

Scripts for running F1GP 1.05 in js-dos, driving it from tests, and reading
its memory. See `../docs/web-port-plan.md` for the plan and the findings.

Bundles (`dist/`), screenshots and logs (`out/`) contain copyrighted game
data. Git ignores both folders. Never commit or publish them.

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
| `index.html` | Test page using the js-dos `Dos()` player. |
| `raw.html` | Test page using the lower-level engine API with our own canvas, input and audio. |
| `tools/unexepack.mjs` | Removes the EXEPACK compression from `gp.exe`. |
| `probes/` | One-off experiments from Phase 0. `route-demo.cjs` and `mem-locate.cjs` are the ones to start with. |

## Examples

```sh
# Drive a Quick Race: route to the grid, accelerate, brake, steer.
timeout 180 node probes/route-demo.cjs dist/route-g-25000.jsdos demo --mode quickrace

# Find gp.exe in emulated memory.
node build-bundle.mjs --autoexec "gp /g" --out dist/mem-probe.jsdos
timeout 60 node probes/mem-locate.cjs
```

Only Chromium is used for browser tests. Wrap runs in `timeout`: the
emulator runs until stopped.
