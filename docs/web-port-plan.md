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
  analogue joystick input. A game controller now drives through the game's
  own joystick code instead, with no change to the emulator (Phase 5,
  Controls).
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
  on hills (Imola, Magny-Cours) are 4–5 px off near the camera. The cause is
  the game's, not ours: it builds cross-sections only at flagged segments,
  so on a hill its road runs as a straight chord over up to 11 segments,
  up to 1.6 ft from the track's true height. We keep the true heights.
- **What the game draws for the track is decoded** (`docs/renderer-notes.md`):
  road edges, white lines, kerbs with their stripes and end ramps, fences,
  road markings, colours, sky and horizon image. 3,657 of 3,664 points the
  game projected were reproduced exactly.
- **The WebGL view draws all of it from the game's memory**
  (`spike/lib/scene.mjs`, `spike/render.html`), with the game's live palette,
  at any resolution, in widescreen, with every part drawn at every distance.
- **Road markings in full:** the grid slots and the start line (the game's
  special marking shapes), wide markings, and the "Dotted 'Best Line'"
  driving aid, which the game writes into marking B when a session starts
  or the aid is switched; the page rebuilds its track when the markings
  change (`docs/renderer-notes.md`, "Road markings"). Checked against the
  game's frames with `spike/probes/p4-gl-ram.mjs`, which draws our view from
  a RAM capture beside the game's frame.
- **While the car moves, the screen shows the frame before the one the
  state reader calls current.** Tests that compare moving frames must use
  the previous frame's camera.
- **Trackside objects: done** (`spike/lib/objects.mjs`, `docs/renderer-notes.md`).
  The shape format, placement, per-angle display lists, bitmaps (trees,
  boards, marshals) and object palettes are decoded. Drawn with the game's
  rules at 320×200, 95.6% of pixels inside objects have the game's colour
  over 576 frames on all 16 circuits (97.5% at Monza). The WebGL view draws
  them too; there one-pixel edge rounding brings the figure to about 88%.
- **Crowd in the stands: done.** The WebGL view fills the crowd colour with
  the game's crowd strip, row by row, as the game does in races.
- **Distance haze: done, as an option** (`haze=smooth|classic|off` on
  `render.html`). It uses the game's own haze tables and rules: lines,
  markings, kerbs and fences by segments ahead; each object as a whole by its
  centre's depth or its size; bitmaps by their anchor's depth. "Classic" keeps
  the game's four steps; "smooth" blends between them. Not done: wet-weather
  haze, and the game's far and near colour rows for kerbs and white lines
  (beyond 9 segments it draws kerbs plain white); we draw the nearest row
  everywhere.

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

**One screen (done).** The page (`render.html`, the default `layout=single`)
now replaces the routine itself rather than its calls
(`spike/lib/overlay.mjs`). The replacement fills the 3D view in the game's
back buffer with one marker colour, a grass or road shade that only the 3D
view uses, and keeps the routine's 2D parts: the mirror backdrop, the start
lights, the cockpit patches and pit-stop images, and the palette steps
that send a changed palette to the VGA in parts. The game then draws its cockpit, dash and messages as usual.
The page keys the game's frame (marker colour see-through, and in the
outside views the black bars) and lays it over our view, which is drawn for
the whole 200-row screen. It paints the cars in the mirrors itself, from
the mirror rules in `cars.mjs`, because the game draws them in the car step
that the fill replaces. In menus the game's own screen shows. A Screen menu
on the page puts the game's renderer back. Checked in Monza Quick Races in
every view (`spike/probes/p3-overlay.mjs`, `spike/tests/overlay.test.mjs`).
Details: `docs/renderer-notes.md`, "Replacing the renderer".

**Frame rate and CPU (done).** With the 3D drawing gone the game's frame
work is about 1% of its frame at 25,000 cycles, so the page
(`spike/lib/pace.mjs`) runs the game at 30 fps instead of 15 (SS:1230 = 10,
set in the menus before the session loads; 30 is the most the physics
allows, `docs/memory-map.md`), and lowers the emulated CPU while the fill
runs. Measured with `spike/probes/p4-framerate.mjs`, Monza Quick Race, in
Node:

| Setting | Game's load | Game speed | Host CPU (one core) |
| --- | --- | --- | --- |
| 30 fps, the game's drawing, 25,000 cycles | 56% (peak 60%) | full | 48% |
| 30 fps, fill, 25,000 cycles | 0.1% | full | 48% |
| 30 fps, fill, 12,000 cycles | 13% | full | 26% |
| 30 fps, fill, 8,000 cycles | 22% (peak 30%) | full | 20% |
| 30 fps, fill, 4,000 cycles | 50% | full | 14% |

At 30 fps the start matches 15 fps within the start's own timing (100 mph
in 3.88 s against 3.82 s, 160 mph in 7.56 s against 7.77 s), and 12 s after
the start the computer cars have covered the same ground within 4%. The page runs at 8,000 cycles in the
race and steps up (12,000, 16,000, 25,000) when a frame's work reaches 60%
of its time, back down after 10 s under 30%, and runs at 25,000 elsewhere.

In headless Chromium (software WebGL, GPU compositing on, a small canvas):
the old settings gave the page 15 game frames a second; the new ones give it
30, at 60 page frames a second and full game speed. The page draws at a
render clock one game frame behind the newest frame and blends between the
two frames around it, so bursts of frames from the emulator do not show.

**The emulator's idle time (done).** js-dos's direct mode waits out the rest
of each emulated millisecond by posting messages to itself until the time
comes, so the emulator kept the main thread busy at any cycles setting. The
page now waits on a timer instead (`spike/lib/dos-sleep.mjs`, the page's
`sleep` option). Measured with `spike/probes/p5-profile.mjs`, the DevTools
profiler on the main thread, Monza Quick Race, cockpit view, 8,000 cycles,
game at 30 fps, in headless Chromium with SwiftShader:

| Main thread | Spin (js-dos), 1248×648 | Timer, 1248×648 | Spin, 608×288 | Timer, 608×288 |
| --- | --- | --- | --- | --- |
| Idle | 3% | 80% | 3% | 74% |
| Messages to itself, and the browser's own work | 79% | 6% | 76% | 8% |
| Emulator (WebAssembly) | 13% | 12% | 14% | 12% |
| Our page (state, overlay, renderer) | 1.3% | 1.4% | 3.6% | 3.5% |
| Page frames a second | 6–7 | 8–9 | 22–23 | 24–28 |

The page's own work is about 1 ms a frame. In this headless browser the page's
frame rate is limited by SwiftShader filling pixels on the CPU in the GPU
process (the profile does not see it): a fifth of the pixels gives three
times the frames. A machine with a GPU does not have that limit.

**Frame time after the shadows (done).** With the shadows and the steady
trackside objects the game stuttered. The page shares the main thread with the
emulator, so a long page frame holds up the game too. Measured with
`spike/probes/p5-stutter.mjs`, which times every animation-frame callback:
Monza Quick Race, cockpit view, the autopilot driving, 15 seconds, headless
Chromium with SwiftShader, 800×500, three runs of each.

| The page's own work a frame | Median | Slowest tenth | Slowest hundredth | Page frames in 15 s |
| --- | --- | --- | --- | --- |
| Modern style, as first merged | 4.1–4.2 ms | 6.7–8.0 ms | 8.3–10.4 ms | 129–135 |
| Modern style, now | 3.3 ms | 4.6–5.5 ms | 7.9–8.7 ms | 149–153 |

What changed: the shadow map is drawn again a quarter at a time over four
frames into a second map, while the first stays in use (whole, it took 3.5 ms
of GPU time in one frame; a quarter takes 0.6 ms; this cost falls on the GPU,
not on the page's own work, in both versions); the mirrors are drawn again in
turn, one a frame; each sector's object indices are worked out once, and each
pass keeps its index buffer while the same sides of the same shapes are in
view (82 % of passes upload nothing); the shadow lookup takes four taps
instead of nine; and the cockpit is dimmed in its pixels rather than by a CSS
filter. The slowest frames hardly changed. Ruled out: garbage collection
(22 ms in 10 seconds, the longest pause 6.4 ms), long tasks (none over 20 ms),
the cockpit's sun rays (9 µs a frame) and their grid (10 ms, built once per
scene). This browser draws on the CPU, so it cannot show what a GPU does with
the shadow map; the page's status line shows the slowest frame of each second
and the page's own work, with the shadows, lod and mirrors settings, so a
machine where it still stutters can be checked by setting `shadows=off`,
`lod=game` and `mirrors=game` one at a time.

To do:

- Check that no game logic depends on the drawing: run whole races with and
  without the fill and compare lap times, positions and incidents.
- Measure the game's load at its busiest (pit stops, crashes, all 26 cars
  close together) to check the governor's steps.

## Phase 3: cars and cockpit (2–6 weeks)

1. **Car shapes.** Found while decoding objects: shape 0 is the car, drawn
   by the same shape code as the trackside objects. It is polygons up to
   52 ft away and bitmaps chosen by viewing angle beyond; wheels and helmets
   are angle-chosen bitmaps; team and driver colours are palettes at
   SS:2964 and SS:2AA4. The cockpit view of your own car takes a separate
   path.
2. **Draw every car** at its position, with wheels, and check against the
   game's frame as in Phase 2.
3. **Cockpit and dash:** start by taking them from the game's own frame,
   scaled up. Later, redraw them in high resolution. Mirrors need rear views
   rendered by us.
4. **Effects the game draws** (sparks, smoke, dust, tyre marks, if any):
   list them and match them.

Progress:

- **Cars: decoded and drawn.** `spike/lib/cars.mjs` builds the cars as the
  game does (`docs/renderer-notes.md`, "Cars"): which cars it draws, pose
  with the yaw wobble, team and helmet palettes, polygon and bitmap versions,
  wheels and helmets framed by angle and steering, effect shapes (mechanic,
  debris, broken wings), drawing order with the objects, and the mirrors.
  With the game's rules at 320×200, 98.3–99.1% of polygon-car pixels,
  99.7–100% of bitmap-car pixels and 99.8% of mirror pixels have the game's
  colour (87 frames, `spike/tests/cars.test.mjs`).
- **The WebGL view draws them** (`render.html`, `cars=1`, the default) in
  place of the boxes, eased between the game's frames with the camera and
  hazed per car. Laid over the game's own screen, the followed car sits
  exactly on the game's.
- **Cockpit and dash from the game's frame:** in the one-screen page the
  game's cockpit, dash, mirrors and start lights are laid over our view at
  the game's resolution (Phase 2, "One screen").
- **Real rear views in the mirrors (done, modern style):** the renderer draws
  the scene behind into each mirror's glass, as the game projects its mirror
  cars (`docs/renderer-notes.md`, "Cockpit and mirrors"); `mirrors=game`
  (classic) keeps the game's backdrop and bitmap cars.
- **A smoothed cockpit and dash (done, an option):** the game's overlay drawn
  through xBR, a filter made for pixel art (`spike/lib/pixel-smooth.mjs`, the
  Cockpit menu, `cockpit=smooth|pixels`).
- **Still to do:** the cockpit and dash redrawn in high resolution; pit-lane
  cars are unchecked (79% in the one pit capture, where the pit-lane scene is
  missing); wet races and other frame rates are unchecked.

## Phase 4: better graphics (3–6 weeks)

1. **Resolution and widescreen:** draw at the window's size. Widen the field
   of view for wide screens, and check that nothing the game hides (cars
   beyond its draw distance, for example) looks wrong.
2. **Smooth motion:** draw at the screen's refresh rate and ease each car
   between the game's last two frames. Physics runs once per drawn frame, so
   this adds one game frame of delay (67 ms at 15 fps). Done: the game runs at
   30 fps (33 ms), the most its physics allows (Phase 2, "Frame rate and CPU").
3. **Better looks, optional:** textures, lighting, shadows, anti-aliasing and
   draw distance. Each is a separate choice; keep the original look available.
   Done so far: the ground texture (the game's T option), in the game's whole
   shades for the classic style and blended for the modern one
   (`texture=classic|smooth|off`); in the modern style, wheels that roll with
   each car's speed (a pattern on the hubs that blurs at speed) and a soft
   shadow under each car (`spike/lib/cars.mjs` `spinWheels`, `shadowQuads`), and
   the faces of the scene's shapes lit very slightly by a fixed sun
   (`shade=on|off`: a face looking up keeps the game's colour, sides lose up to
   11 % and undersides 13 %; the face's direction comes from the change of its
   position across the screen, so the shapes need no normals); and the shapes'
   shadows from the same sun (`shadows=on|off`): a shadow map of the trackside
   shapes and the track's raised parts, 2,000 ft across ahead of the camera,
   drawn again every 200 ft, on the road, the ground and the shapes, with the
   cockpit and dash dimmed to 70 % while the car is in a shadow (rays toward the
   sun on the CPU, `spike/lib/sun-ray.mjs`). Trackside objects are steady in the
   modern style: their near version at every distance, their bitmaps at any
   distance and the ray's own view angle, where the game's rules made trees pop
   or flick (one Monza lap at 2 ft steps: 48 back-and-forth flicks from the
   angle rounded to a screen column, 13 switches between versions, 64 frame
   changes of rows of trees, 198 bitmaps appearing at their maximum depth).

## Sound from the Amiga version (done)

The Amiga version's title tune (Dave Lowe's original, four-channel samples)
and its sampled engine sound better than the DOS AdLib sound. The page plays
them without emulating the Amiga (`render.html?sound=amiga`, the Sound menu;
`docs/amiga-sound.md`, "In the browser"):

1. **Data:** the site's build takes the tune and the race sounds (195 KB)
   from the Amiga disk images in `original/amiga` (`spike/lib/amiga-disk.mjs`).
   Phase 5's import would read them from the player's own disks instead.
2. **Title tune:** the game's music player (music.unit) and the sound chip
   in JavaScript, in an AudioWorklet; checked write for write against the
   68000 code. It plays in the menus and fades as a session loads, as the
   Amiga front end does.
3. **Engine:** the Amiga engine sample, its rate set 50 times a second from
   the DOS engine sound's revs (DS:0054) by the Amiga game's rule.
4. **Effects:** a hook in the DOS race sound driver counts the effects the
   game starts; each one has an Amiga counterpart started by the same code
   (start lights, starter motor, tyres, kerbs, contact, cars passing the TV
   camera), played by the Amiga rules. The DOS game's AdLib sound is not
   played meanwhile.

## Phase 5: make it a product (2–3 weeks)

1. **Import:** the player picks their game folder or zip. The page checks
   the files and `gp.exe`'s hash, builds the bundle and stores it in the
   browser (OPFS).
2. **Saves:** copy `GPSAVES\` and `F1PREFS.DAT` out of the emulator after each
   save, store them, and restore them on start. Offer export and import.
   Done, but for export and import (`spike/lib/saves.mjs`): the bundle now
   holds the `GPSAVES` folder (without it the game refused to save), the page
   keeps the files the game changed (js-dos `persist`) in IndexedDB and lays
   them over the bundle on the next start, and a Saves panel lists and forgets
   them. `spike/probes/p5-saves.mjs` checks the whole path.
3. **Controls:** keyboard, mouse, gamepad, touch. Done for a gamepad
   (`spike/lib/gamepad.mjs`, `spike/lib/joystick.mjs`, `render.html?pad=`),
   without the emulator change: in a session the page sets the game's controls
   to its analogue joystick (steering on joystick A's x axis, accelerator and
   brake on joystick B's two axes as pedals, gears on two buttons), with a
   calibration and scales of its own and the flags the game works out at a
   session's start, turns the game's button read into a return and writes the
   axes and buttons each frame. The left stick steers (a dead zone of 0.1, then
   a curve of power 1.5), the triggers or the right stick accelerate and brake
   gradually, the shoulder buttons change gear, and the other buttons press the
   game's keys; in the menus the d-pad and A move and choose. After the session,
   or when the controller goes, every byte goes back, so the menus and saved
   settings keep the keyboard. A keyboard driving key gives the controls back to
   the keyboard until the controller is used again. `spike/probes/p5-pad.mjs`
   drives a Quick Race from the main menu with a stand-in controller (19
   checks). Not done: touch, and steering wheels that the browser does not map
   as a standard pad.
4. **Offline:** a service worker caches the page and emulator.
5. **Deploy** to a static host with a GitHub Actions job. Done for GitHub
   Pages (`.github/workflows/pages.yml`, `spike/build-site.mjs`): every push to
   `main` builds the site and deploys it. The project's owner chose to publish
   a game bundle built from `original/` with it, so the import step above is
   not needed for this site.

## Our own PC: step 1 of a Rust rewrite (done, behind an option)

The aim is to run the game without an emulator, by rewriting it in Rust a
piece at a time, each piece checked against the original. Step 1 is a small
PC in Rust that runs `gp.exe` as it is, in place of DOSBox
(`spike/machine/README.md`; the page's `render.html?machine=rust`, through
`spike/lib/pc.mjs`). It gives the later steps a machine whose every part is
ours, so a routine of the game can be swapped for a Rust function rather than
patched in bytes.

- **The CPU:** an 80286 in real mode (the game tests for a 386 but uses only
  286 instructions). Checked against the SingleStepTests 80286 real-mode set
  (1,477,997 single instructions recorded on a real chip): 160 differ, all in
  cases the game does not meet.
- **Around it:** the interrupt controller, the timer, the keyboard, VGA mode
  13h, the game port, the AdLib's detection, EMS (the game will not start
  without it), and DOS and BIOS served in Rust on an in-memory drive C.
- **Time:** the machine's own clock (instructions at `cycles_per_ms`, a HLT
  skips to the next interrupt), so the same inputs give the same run. In the
  page it keeps that clock up with real time in short tasks of its own, as
  js-dos runs DOSBox, apart from the drawing: a slow page frame does not slow
  the game.
- **Size:** 221 KB of WebAssembly, against DOSBox's 1.46 MB (with its loader,
  1.6 MB).
- **Speed:** 91 million instructions a second in Node's WebAssembly (114
  million natively), against DOSBox's 55 million; a second of the race at the
  page's 8,000 cycles takes 0.09 s of the host's CPU, against DOSBox's 0.21 s.
  In the page the main thread is busy 25-47% of the time on it, 36-60% on
  DOSBox (`spike/probes/p6-bench.mjs`, `p6-bench-page.mjs`). The site's
  `bench.html` runs both through the same race in the visitor's own browser
  and shows the results side by side.
- **Checks:** `spike/probes/p6-pc-route.mjs` boots the game in Node and drives
  `lib/route.cjs` to a Monza Quick Race, reads the state as the page does
  (gp.exe at 01A2h, as under DOSBox) and drives off (CI runs it on every
  push); the page's controller probe passes all 19 checks on it.
- **Not done:** AdLib synthesis (`sound=adlib` falls back to the Amiga sound),
  the intro, a mouse, the serial link; saving from the game's menus fails the
  saves probe on it (not yet looked into).

## Step 2: the original 3D view, ours, then sharper and smoother (started)

The aim: the game's own picture, drawn by us, exactly; then the same rules at
the screen's resolution, and at its frame rate with the camera eased between
the game's frames. A GPU's triangle rules cannot match the game's (it fills
flat polygons span by span, from its own edge lists, far to near), which is
why our WebGL view matches about 88% of object pixels where the game's rules
in software reach 95.6%. Compute shaders (WebGPU) can rasterise the game's way
at any resolution.

1. **A reference (done).** The machine can hook any of the game's routines,
   run one alone, and save and restore its state. `machine/src/bin/r3d.rs`
   catches the 3D routine (0F47:81CE) in a recorded race: 58 frames over the
   cockpit, chase and TV views at Monza, each the state the routine starts
   from and the frame it leaves. Run again alone from each state, the game's
   routine gives the same 64,000 bytes every time, so a rewrite can be held to
   exactly that. Over those frames the routine runs 12,217 distinct
   instructions, 11,637 of them in the renderer's segment.
2. **The rasteriser.** The polygon filler (0F47:0999, a far routine to
   1835h, called from 27 places) is rewritten (`spike/machine/src/r3d/fill.rs`):
   11,925 calls in 176 frames at Monza, Monaco and Germany leave the same
   memory and registers as the game's, and the frames drawn with it are byte
   for byte the same. So is the edge code it fills from (0F47:0000 to 0998,
   `edge.rs`): 43,966 calls in the same frames, and 40,000 made-up ones that
   reach the paths races don't.
3. **The ground texture (done).** A profile of the routine (`r3d profile`)
   put 72% of its instructions in the ground texture (0F47:7F64, the T
   option), so it came next (`ground.rs`): exact on every caught frame and on
   3,000 made-up calls. With the filler, the edge code and the texture in
   place, the game's own code runs 19–26% of the 3D routine's instructions;
   most of the rest is objects (0F47:9E2A: shapes, effects, bitmaps).
   The bitmap drawer (0F47:19E8, `bitmap.rs`) is next and exact: with it the
   game's code runs 14–16%. Then the segment walk with its cross-sections
   and the projection (`walk.rs`, `section.rs`, `track.rs`, `point.rs`):
   11%, and about half of the routine's code is now ours. Then the road's
   blocks, strips and polygons (`blocks.rs`, `strips.rs`, `road.rs`), the
   shapes (`shape.rs`), the cars (`cars.rs`) and the objects with their sort,
   the fences and the pit lane (`scene.rs`): 4.1–5.3%.
4. **The whole routine (done).** With the top (`frame.rs`: 81CE, 802A, the
   sky, the cars on their segments, the cockpit's parts) and segment 19ED's
   part (`screen.rs`), the whole 3D routine is ours: all 176 caught frames
   come out with the same memory and registers as the game's, and the game's
   own code runs none of it. Over three whole races (3,193 frames, every
   call), our routine drawn beside the game's from the same state gives the
   same frame every time (`r3d shadow`).
5. **In the page (done).** With `machine=rust`, `r3d=ours` draws the game's
   3D view with our routine where the game draws its own (`screen=original`):
   a hook at the routine's entry in the WebAssembly machine. The game then
   keeps 30 frames a second at 8,000 emulated cycles a millisecond, where its
   own code needs 25,000 (12 frames a second at 8,000), and the host takes a
   third of the time (`probes/p8-r3d-native.mjs`: 20 s of racing in 1.7 s
   against 5.4 s). `cycles=auto` keeps the slow CPU while it does.
6. **Sharper and smoother (started):** the same rules at a higher resolution
   and with the camera eased between frames, rasterised in WebGPU compute
   shaders; the WebGL view stays for browsers without WebGPU. The split: our
   port, unchanged, decides everything at 320 x 200 as the game does, and
   records what it draws as a display list (`machine/src/r3d/list.rs`); the
   list is drawn again at s times the resolution by the game's own rasteriser
   rules (`fine.rs`, the reference); WebGPU paints the result
   (`lib/gpu-r3d.mjs`). Frames between the game's are the port run again on a
   copy of the machine's memory with the camera and cars eased, then drawn the
   same way (`docs/renderer-notes.md`, "Drawing the frame finer").

   - **The list and the GPU's painting (done).** At scale 1 the list drawn
     again gives the frame our routine drew: all 176 caught frames, all 3,193
     frames of the three races, and 34,263 made-up edges and 35,209 made-up
     border edges built the game's way (`r3d list`, `r3d shadow`, `r3d
     fine-edges`). WebGPU paints the same bytes as `fine.rs` at scales 1, 2 and
     4 on all 176 frames (`probes/p9-gpu-r3d.mjs`): each pixel keeps the
     highest (primitive number << 8 | colour) written to it, which is painter's
     order without sorting. In headless Chromium here (SwiftShader, a GPU run
     on the CPU, so no measure of a real one) a frame takes 9 ms at scale 1,
     25–28 ms at 2 and 99–118 ms at 4. For now the bitmaps, poles, crowd,
     scenery, dithered sky rows and cockpit pieces are game pixels made s x s.
     Natively our routine takes 0.14 ms a frame with recording off, as with
     the recorder compiled out, and 0.47 ms with it on (`r3d time`, the 58
     Monza frames); 20 s of racing in the WebAssembly machine takes the host
     1.8–1.9 s, as before (`probes/p8-r3d-native.mjs`).
   - **In the page (next).** `r3d=gpu` with `scale=1|2|3|4|screen`: the list
     taken at the routine's end in the WebAssembly machine and painted on a
     WebGPU canvas in the game's palette; the cockpit and dash from the game's
     screen laid over it outside the region the game copies from the back
     buffer (rows 0–102, the window's openings, the mirrors), with the window
     tables made s times finer; the outside views' 16-row offset; messages.
     Without WebGPU, `r3d=ours`. Check: at scale 1 the result is the game's
     screen, byte for byte.
   - **Smoother.** Frames between the game's: the port run on a copy of the
     memory taken at the routine's entry, with the camera eased between two
     frames' states as 0:7757 makes it (the position G:2259/225D, the eye
     height, the heading G:2261, the pitch with the head nod, the sideways
     offset; the camera's segment switched part-way) and the cars' poses
     eased. Never on the live memory: the ground texture's sums
     (CS:7394–739B) add up the camera's motion, and the pit signals' timers
     (G:2919–291F), the random generator (G:08C3) and the head nod (G:2269)
     are the game's own state. A first trial (scratch code, not committed) gave
     frame N+1 exactly at t = 1 in 698 of 698 pairs of frames, and frame N at
     t = 0 in 666 of 698 (the rest differ by inputs taken from N+1: the start
     lights, the race order, a view change or a TV cut). One frame of the port
     takes 0.2–0.3 ms in WebAssembly (0.9 ms at worst), the copy 0.07 ms.
   - **The pixel art at the finer scale.** Bitmaps placed and sized from the
     finer projection (their texels still the game's), poles s pixels wide from
     their fine ends, the scenery scrolled finer, the crowd's game-sized texels
     on fine spans, the ground texture worked out for each fine row, and the
     sky and ground bands from the fine rows of the points they came from.
   - **Edges on the GPU, if needed.** The CPU builds the edges and walks the
     rings at scale s, and the GPU fills the spans. If that costs too much at
     high scales, the edge stepping and the ring walk move to compute shaders;
     they work in integers, so they can be held to `fine.rs` the same way.

## Risks and open questions

| Risk | Effect | What to do |
| --- | --- | --- |
| Scenery (walls, fences, buildings) can't be matched by comparison alone | Phase 2 takes longer | Read the game's drawing code; ask the F1GP community for their IDA database |
| Car shapes not found or hard to decode | Cars look wrong | Search the data files at the start of Phase 3; nobody has looked yet |
| Direct mode runs the emulator on the page's main thread | In this container the emulator slowed once the page spent more than 5–7 ms per frame of its own work | Skip the game's own 3D drawing, lower the emulated CPU speed and wait out its idle time on a timer (see "Frame rate and CPU" and "The emulator's idle time"); if that is not enough, run the emulator and the state reader in our own worker |
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
