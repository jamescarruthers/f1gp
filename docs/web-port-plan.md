# Plan: F1GP in the browser, with new graphics

This plan covers MicroProse *Formula One Grand Prix* 1.05 (DOS, 1991–92), the
files in `original/`.

**Goal:** the same game (the same handling, AI, rules and menus) drawn at any
resolution, in widescreen and at a smooth frame rate, in a web browser.

## Approach

Keep the original program for everything except the 3D view. Replace the
3D view with a new renderer.

1. `gp.exe` runs unchanged inside js-dos (DOSBox compiled to WebAssembly).
   It still does the physics, AI, timing, sound and menus, so the handling
   stays exact.
2. Each frame, our code reads the game's state straight out of the emulated
   PC's memory: where every car is, which way it points, and where the
   camera is.
3. A new WebGL renderer draws the scene from that state. It builds the track
   from the game's own track files, so the circuits match. It can draw at any
   size and aspect ratio. It can also draw between the game's frames, easing
   each car from its last position to its next, so motion is smooth even
   though the game itself updates 15–25 times a second.
4. Menus and other 2D screens stay as the game draws them, scaled up.

Only the renderer has to be understood and rebuilt, not the whole game. The
physics, AI and low-level graphics code are the parts the community's
disassembly understands least. This plan keeps the first two as they are and
only needs to learn what the graphics code draws, not how it draws it.

Rejected:

- **A full rewrite.** It would mean rebuilding physics and AI that nobody has
  yet mapped. Many months of work before anything drives the same way.
- **Upscaling the original frames** with filters. Cheap, but the game still
  renders at 320×200 and 15 fps, so it cannot give real detail, widescreen or
  smooth motion.

## What we have

The repo holds the game's binaries and data. There is no source code.

| File | What it is |
| --- | --- |
| `gp.exe` | The game. 16-bit real-mode DOS, packed with Microsoft EXEPACK. Unpacks to 595,216 bytes (`spike/tools/unexepack.mjs`). No C runtime inside; it looks like hand-written assembly. SHA-256 `431111406de115b90166faeb49e7681f99b77130ac916863826cc9f6f28f4bb6`. |
| `playscr.exe`, `test.scr` | Intro player and its script. `f1gp.bat` runs the intro, then `gp /c /g`. |
| `f1ct01.dat`–`f1ct16.dat` | The 16 tracks: horizon image, object shapes and placings, track sections, racing line, pit lane, camera positions. Format documented by ArgDocs. |
| `*.fli`, `*.lbm` | 320×200, 256-colour animations and stills. |
| `backdrop.dat`, `trackpix.dat`, `champ.dat`, `crash*.dat`, `trophy.dat`, `helmets.dat`, `flags.dat` | Image containers (`f1pcanim` header). ArgDocs covers "media containers". |
| `f1gpdata.dat`, `f1gpdatb.dat` | Game data, starting with offset tables. Not identified yet; may hold car shapes. |
| `a*.bin`, `b*.bin`, `r*.bin` + `adlib.cat`, `beep.cat`, `roland.cat` | Sound drivers and banks for AdLib, PC speaker and Roland. The game loads the `x*.bin` copies, which today match the PC speaker set. |
| `f1prefs.dat`, `f1prefs.286/.386/.486` | Preferences. `f1prefs.dat` equals the 486 preset (15 fps). |
| `f1gp.rnc`, installer tools | Not needed at run time. |

## Constraint: do not publish the game files

This repository is public and contains the original, copyrighted game files.
The web version must not serve them. The player supplies their own copy, the
page checks it and stores it in the browser, and nothing leaves the machine.
You may want to remove `original/` from the repo and its history, or make the
repo private.

DOSBox and js-dos are GPL-2.0. Publishing their files means shipping the
licence and pointing to the matching source.

## Phase 0: groundwork (done)

The scripts are in `spike/`. See `spike/README.md` for how to run them.

Findings:

- **The game runs in js-dos 8.5.0**, both in Node (for tests) and in headless
  Chromium. Intro, menus, practice and Quick Race all work, with AdLib sound.
- **We can read the game's memory from JavaScript.** In js-dos's direct
  (same-thread) mode the emulator's heap is reachable as
  `ci.transport.module.HEAPU8`, and guest RAM is one block inside it.
  `spike/lib/guest-mem.cjs` finds it; DOS loads `gp.exe` at linear address
  0x1A20, and the code there matches the unpacked file byte for byte. Direct
  mode also works in the browser. No emulator rebuild is needed.
- **Tests can drive the game.** `spike/lib/route.cjs` goes from boot to the
  car on track by recognising each screen. It works at every speed setting
  tried (8,000 cycles to max). It also reads the speed from the dash and the
  "Processor Occupancy" figure (hold O in the car).
- **Copy protection:** a manual word lookup after the language screen (the
  same question every time). No CD check. The test route answers it.
- **Speed:** at the 486 preset (15 fps) the game reports 25% processor
  occupancy at 25,000 cycles in the pit lane, and 30% at a 26-car Quick Race
  start, measured in Node in this container. So the emulator has plenty of
  headroom, leaving CPU time for the new renderer.
- **Hosting:** no COOP/COEP headers are needed, so GitHub Pages works. With
  js-dos's files self-hosted, the page makes no requests to other hosts.
- **Controls:** keyboard and mouse reach the game. js-dos has no route for
  analogue joystick input; that needs a small change to the emulator build
  (Phase 5).
- **Known issues:** the DOSBox build produces about 5.9% more audio samples
  than its stated rate, and the DOSBox-X build gives no sound. Both need a
  fix or a workaround later.

These findings come from the Phase 0 agents' runs. The planned independent
re-checks were stopped when the goal changed, so treat the speed figures as
first measurements.

## Phase 1: read the game's state (1–3 weeks)

Goal: a live top-down map, beside the running game, showing every car where
the game says it is.

1. **Find the car records.** Start from Trevor Kellaway's GpInfo
   (f1gp-utils), which reads car data from the running game, and ArgDocs'
   GP.EXE notes. Confirm each field by changing it in the game: hold A and
   watch for a value that tracks the dash speed; steer and watch for a
   heading; and so on. Record snapshots with `guest-mem.cjs` and diff them.
2. **Fields needed for every car:** position along the track (section and
   distance), sideways offset or world x/y/z, heading, pitch and roll if
   stored, speed, steering angle, wheel spin, pit state, and whether it is
   crashed or retired.
3. **Find the camera:** which car, which view (cockpit, TV camera, chase),
   and the camera's position and direction.
4. **Find the frame tick:** the counter or flag that marks a new game frame,
   so the renderer knows when state is fresh.
5. **Write the map** in `web/`: a canvas that draws the track outline and
   the cars, updated every frame, next to the original screen.

Done when: the map matches the game for a full Quick Race, checked by eye and
by a test that compares the player's speed and position with the dash and
lap timer.

## Phase 2: build the track in 3D (3–8 weeks)

Goal: our renderer draws the track as the game does, seen from the game's
own camera.

1. **Read the track files** in TypeScript: sections, widths, curvature,
   height changes, kerbs, verges, pit lane, objects, horizon, cameras.
   ArgDocs, ArgData and the GP2 track format notes describe most of it.
2. **Turn sections into a 3D mesh.** The exact method the game uses is not
   documented. Work it out by rendering at 320×200 from the game's camera and
   comparing, pixel by pixel, with the game's own frame. Adjust until the
   edges line up. The comparison runs as an automated test.
3. **Trackside objects and scenery:** place the object shapes from the track
   file. Use the horizon image for the backdrop.
4. **Colours:** use the game's palette for now.

Done when: for every one of the 16 circuits, our track lines up with the
game's frame to within a pixel or two at 320×200, at several points round
the lap.

Main risk: if the edges will not line up by comparison alone, we must read
the game's track-drawing code. That is the least understood part of the
disassembly, and it could double this phase.

## Phase 3: cars and cockpit (2–6 weeks)

1. **Find the car shapes** (candidates: `f1gpdata.dat`, `f1gpdatb.dat`,
   `gp.exe`) and the team colours (ArgData documents where the colours are).
2. **Draw every car** at its position, with wheels, and check against the
   game's frame as in Phase 2.
3. **Cockpit and dash:** start by taking them from the game's own frame,
   scaled up. Later, redraw them in high resolution. Mirrors need rear views
   rendered by us.
4. **Effects the game draws** (sparks, smoke, dust, tyre marks, if any):
   list them and match them.

## Phase 4: better graphics (3–6 weeks)

1. **Resolution and widescreen:** draw at the window's size. Widen the field
   of view for wide screens, and check that nothing the game hides (cars
   beyond its draw distance, for example) looks wrong.
2. **Smooth motion:** draw at the screen's refresh rate and ease each car
   between the game's last two frames. This adds up to one game frame of
   delay (67 ms at 15 fps). Test whether the game can run faster, at 20 or
   25 fps, to cut that delay.
3. **Better looks, optional:** textures, lighting, shadows, anti-aliasing and
   draw distance. Each is a separate choice; keep the original look available.

## Phase 5: make it a product (2–3 weeks)

1. **Import:** the player picks their game folder or zip. The page checks
   the files and `gp.exe`'s hash, builds the bundle and stores it in the
   browser (OPFS).
2. **Saves:** copy `GPSAVES\` and `F1PREFS.DAT` out of the emulator after each
   save, store them, and restore them on start. Offer export and import.
3. **Controls:** keyboard, mouse, gamepad (needs the emulator change for
   analogue input), touch.
4. **Offline:** a service worker caches the page and emulator.
5. **Deploy** to a static host with a GitHub Actions job.

## Risks and open questions

| Risk | Effect | What to do |
| --- | --- | --- |
| Track mesh can't be matched by comparison alone | Phase 2 takes much longer | Read the track-drawing code; ask the F1GP community for their IDA database |
| Car shapes not found or hard to decode | Cars look wrong | Search data files early (start in Phase 1) |
| Direct mode runs the emulator on the page's main thread | Rendering and emulation compete, frames may stutter | Measure in Phase 1; if needed, rebuild the emulator to post state from its worker |
| The game draws things not in any data file | Missing effects | List them in Phase 3 |
| Memory layout differs between game versions | Only 1.05 European works | Support one version first; detect others by hash |
| Game files in a public repo | Anyone can download the game | Never serve them; consider removing `original/` |

## References

- ArgDocs file formats (tracks, media containers, GP.EXE, saves, setups,
  preferences): <https://www.argtools.com/argdocs/file-formats/>
- ArgData, .NET library for F1GP data: <https://github.com/codemeyer/ArgData>
- f1gp-utils, including GpInfo: <https://github.com/tkellaway/f1gp-utils>
- F1GP development resources: <https://sites.google.com/view/f1gpwc/development>
- Disassembly discussion: <https://groups.google.com/g/f1gpwc/c/nyi3loxTjMs>
- GP2 track file format: <https://www.waa63.ch/racesim/TEIC/primer/GP2TrackFileFormat.htm>
- js-dos: <https://js-dos.com/overview.html>
