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

## Phase 1: read the game's state (done)

Goal: a live top-down map, beside the running game, showing every car where
the game says it is. The details are in `docs/memory-map.md`; the code is
`spike/lib/f1gp-mem.mjs`, `spike/lib/f1gp-state.mjs`,
`spike/lib/track-file.mjs` and `spike/map.html`.

What we now know:

- **Every car's position, exactly.** The 26 car records sit at a fixed
  place in the game's data. The player's world X/Y is live. Computer cars
  keep only a track position (segment, distance along it, sideways offset);
  the game works out their X/Y when it draws them. `f1gp-state.mjs` does the
  same integer arithmetic. In cockpit view, the game's own camera position
  equalled our position for the viewed car in every one of 11,797 frames,
  over 15 different computer cars, with zero error.
- **The track, exactly.** `track-file.mjs` builds each circuit from its
  track file the way the game does at load time. On all 16 circuits, every
  16 ft segment equals the game's own segment array in memory: position,
  height, heading, pitch and width. The game also keeps that array in
  memory, so the renderer can read it directly.
- **The camera.** View mode, viewed car, and the camera's position, height,
  yaw and pitch for every view. The game has no camera roll or pitch
  rotation: pitch only moves the horizon. The projection formula is known
  (a fixed 256-pixel focal length on a 320×164 view).
- **Timing.** The game moves every car exactly once per drawn frame, with a
  time step of one frame (1/15 s at the shipped setting). There is no
  separate physics tick. The game clock changes once per frame, and a pause
  flag says when it stops. So the renderer must ease cars between the last
  two frames; it cannot sample a smoother physics clock.
- **Reading is cheap.** Reading the whole state takes 4–15 µs.
- **The map works.** `spike/map.html` runs the game in the browser (js-dos
  direct mode) next to a live map of every car, with the camera's view
  wedge, trails and a car table. The page held 60 frames per second, and
  the game stayed at full speed.

How it was checked:

- Three whole 3-lap Quick Races at Monza, run at 2× speed (the emulated
  PC unchanged), checked frame by frame. Dash speed matched memory in
  1,154/1,154 samples; lap and position in 1,060/1,060; lap times exactly in
  94/94. All 26 cars had a position in every frame, with no jumps. Every
  computer car stayed within 1 m of the track edges built from the track
  file. The finishing order matched the results screen.
- A separate agent repeated the core checks at Silverstone, the Hungaroring,
  Monaco and Suzuka, at 10 and 15 fps and at 18,000 and 40,000 cycles.
- One whole Quick Race at real speed, run after the reader fix
  (`spike/out/p1-accuracy/race-realtime`, 371 game seconds): every one of
  5,567 frames recorded and read consistently; dash speed 465/465, lap and
  position 408/408; computer cars within 0.76 m of the track edges; the
  camera exactly at the viewed car in 4,171/4,171 cockpit frames; finishing
  order 26/26.

Fixed after the checks: the reader's "consistent read" flag could pass a read
taken while the game was half-way through its next frame. It now keeps a
fixed reference for the session; in the Silverstone race the bad reads fell
from 1,427 to 0. Outside races there is no reliable marker yet, and about
2% of reads in practice can be a frame ahead.

Still unknown, needed later: height (Z) units, the front-wheel steering
angle, wheel spin, crash and damage state, which cars the game chooses not
to draw, how mirrors are drawn, and qualifying, wet races and replays in
depth.

## Phase 2: build the track in 3D (2–5 weeks)

Goal: our renderer draws the track as the game does, seen from the game's
own camera.

Phase 1 removed this phase's main risk: the track's shape and the camera
are now exact. What remains is everything beside and on the road.

1. **Road mesh** from the segment array (or `track-file.mjs`): road surface,
   kerbs, verges, pit lane and banking, in WebGL.
2. **Match the game's frame.** Render at 320×164 from the game's camera with
   the game's projection, and compare pixel by pixel with the game's own
   frame. This runs as an automated test on all 16 circuits.
3. **Trackside objects and scenery:** place the object shapes from the track
   file (`track-file.mjs` already parses them). Use the horizon image for
   the backdrop.
4. **Colours:** use the game's palette for now.

Done when: for every one of the 16 circuits, our track lines up with the
game's frame to within a pixel or two at 320×200, at several points round
the lap.

Progress:

- **The track's shape: done.** 778 paused reference frames on all 16
  circuits (cockpit, chase and TV views; standing and moving; texture on and
  off), each with the exact game state (`spike/probes/p2-capture.cjs`).
  Projected from the game's camera, the track edges land on the game's road
  edges with a median error of 0–0.3 px on every circuit, and 97% of edge
  samples within 2 px (`spike/tests/p2-alignment.test.mjs`). Two TV frames
  on hills (Imola, Magny-Cours) are 4–5 px off near the camera; the cause is
  not known yet.
- **What the game draws for the track is decoded** (`docs/renderer-notes.md`):
  road edges, white lines, kerbs with their stripes and end ramps, fences,
  road markings, colours, sky and horizon image. 3,657 of 3,664 points the
  game projected were reproduced exactly.
- **The WebGL view draws all of it from the game's memory**
  (`spike/lib/scene.mjs`, `spike/render.html`), with the game's live palette,
  at any resolution, in widescreen, with every part drawn at every distance.
- **While the car moves, the screen shows the frame before the one the
  state reader calls current.** Tests that compare moving frames must use
  the previous frame's camera.
- **In progress:** trackside objects (stands, buildings, trees, signs). Their
  shape format is only partly decoded; cars use the same machinery.

Main risk: the scenery. How the game builds walls, fences, verges and
buildings from the track file's commands and objects is only partly
documented. If comparison alone does not settle it, we must read the game's
drawing code.

### Turning off the game's own 3D drawing

The game draws its 3D view through one routine, called from five places
(image offsets 0xEB7E, 0xEEA4, 0xF007, 0xF0D3, 0xF291: `lcall 0F47:81CE`).
Replacing those calls with no-ops in emulated memory, while the game runs,
stops the 3D drawing and nothing else: the camera is still set up, and the
cockpit and dash are still drawn (`spike/probes/p2-norender.cjs`).

Measured at Monza in a Quick Race, in Node, holding the throttle:

| Emulated CPU (cycles) | 3D drawing | Game speed | Game's own load | Host CPU (one core) |
| --- | --- | --- | --- | --- |
| 25,000 | on | full | 30% | 46% |
| 25,000 | off | full | under 5% | 46% |
| 8,000 | off | full | 5% | 19% |
| 4,000 | off | full | 17% | 13% |
| 2,000 | off | full | 36% | 10% |
| 1,000 | off | full | 80% | 8% |
| 500 | off | 61% | — | 7% |

Skipping the drawing alone saves no host CPU: the game waits for its next
frame in a busy loop, which DOSBox runs at whatever speed it is set to. The
saving comes from lowering the cycles setting as well, which js-dos can do
while the game runs. At 3,000–4,000 cycles the host CPU falls to about a
quarter, with a wide margin before the game slows.

To do before relying on it:

- Patch only while in the car, and raise the cycles again for menus and 2D
  screens, which still need the original drawing and speed.
- Check that no game logic depends on the drawing: run whole races with and
  without the patch and compare lap times, positions and incidents.
- Measure the game's load at its busiest (pit stops, crashes, all 26 cars
  close together, 25 fps) to choose the cycles setting.
- Keep a way to switch the original drawing back on, for the overlay check.

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
   between the game's last two frames. Physics runs once per drawn frame, so
   this adds one game frame of delay (67 ms at 15 fps). The game's 25 fps
   setting cuts that to 40 ms, at the cost of more emulator CPU; measure it.
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
| Scenery (walls, fences, buildings) can't be matched by comparison alone | Phase 2 takes longer | Read the game's drawing code; ask the F1GP community for their IDA database |
| Car shapes not found or hard to decode | Cars look wrong | Search the data files at the start of Phase 3; nobody has looked yet |
| Direct mode runs the emulator on the page's main thread | In this container the emulator slowed once the page spent more than 5–7 ms per frame of its own work | Skip the game's own 3D drawing and lower the emulated CPU speed (see "Turning off the game's own 3D drawing"); if that is not enough, run the emulator and the state reader in our own worker |
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
