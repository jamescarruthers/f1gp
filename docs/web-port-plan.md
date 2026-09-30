# Plan: run F1GP in a web browser

This plan covers MicroProse *Formula One Grand Prix* 1.05 (DOS, 1991–92), the
files in `original/`.

## What we have

The repo holds the game's binaries and data. There is no source code.

| File | What it is |
| --- | --- |
| `gp.exe` | The game. 16-bit real-mode DOS, packed with Microsoft EXEPACK. Unpacks to 595,216 bytes. No C runtime inside; it looks like hand-written assembly. SHA-256 `431111406de115b90166faeb49e7681f99b77130ac916863826cc9f6f28f4bb6`. |
| `playscr.exe`, `test.scr` | Intro player and its script. `f1gp.bat` runs the intro, then `gp /c /g`. |
| `f1ct01.dat`–`f1ct16.dat` | The 16 tracks. Format documented by ArgDocs. |
| `*.fli`, `*.lbm` | 320×200, 256-colour animations and stills. |
| `backdrop.dat`, `trackpix.dat`, `champ.dat`, `crash*.dat`, `trophy.dat`, `helmets.dat`, `flags.dat` | Image containers (`f1pcanim` header). ArgDocs covers "media containers". |
| `f1gpdata.dat`, `f1gpdatb.dat` | Game data (starts with offset tables; not yet identified). |
| `a*.bin`, `b*.bin`, `r*.bin` + `adlib.cat`, `beep.cat`, `roland.cat` | Sound drivers and sound banks for AdLib, PC speaker and Roland. |
| `x*.bin` | The active sound set. Today these are byte-for-byte copies of the PC speaker (`b*`) files. |
| `f1prefs.dat`, `f1prefs.286/.386/.486` | Preferences. `f1prefs.dat` equals the 486 preset. |
| `f1gp.rnc` | 3.7 MB archive holding compressed copies of all the files above. Not needed at run time. |
| `install.exe`, `hdinst.exe`, `cd1.exe`, `cdpatch.exe`, `mpscopy.exe`, `bootmake.bat` | Installer and boot-disk tools. Not needed at run time. |

`gp.exe` talks to the hardware directly: VGA 320×200, keyboard, mouse
(INT 33h), analogue joystick (port 201h), and serial port (INT 14h) for
two-PC link play. Its switches are `/a` no animations, `/c` scrolling
credits, `/g` don't preserve screen mode, `/m` no RTS/CTS for modem link,
`/p` don't load preferences.

## Approach

Run the original `gp.exe` inside a DOS emulator compiled to WebAssembly,
wrapped in a small web app. Use [js-dos](https://js-dos.com/) v8, which
packages DOSBox for the browser.

Why this and not a rewrite:

- **It is the only route that gets a faithful game soon.** Emulation needs no
  knowledge of the game's code.
- **A rewrite rests on reverse engineering that is not done.** The F1GP
  community's disassembly is about one-third mapped. Physics, AI and low-level
  graphics, the parts a rewrite most needs, are the least understood.
- **Recompiling the binary is hard for this program.** It is hand-written
  16-bit assembly with segment arithmetic and interrupt handlers, so tools
  that lift compiler output to C gain little.

Phase 4 below keeps a path open to native code later, one piece at a time.

## Constraint: do not publish the game files

This repository is public and contains the original, copyrighted game files.
A web page that serves them lets anyone download the game. So the port must
not bundle them. Instead:

- The player supplies their own copy (a folder or a zip) on first run.
- The page checks it, builds the emulator bundle in the browser, and stores
  it in the browser (OPFS or IndexedDB). Nothing leaves the machine.
- Later visits start straight from the stored copy.

You may also want to remove `original/` from the public repo and its
history, or make the repo private. That is your call; the port does not
depend on it.

DOSBox is GPL-2.0 and js-dos builds on it. Check js-dos's licence and license
the wrapper to match.

## Phase 0: spike (1–2 days)

Goal: prove the game runs well in js-dos before building anything.

1. Build a `.jsdos` bundle by hand: a zip with the run-time files (drop
   `f1gp.rnc` and the installer tools) and `.jsdos/dosbox.conf`.
2. Copy `aintro.bin`, `aingame.bin`, `asound.bin`, `acredit.bin` over the
   matching `x*.bin` files to switch from PC speaker to AdLib.
3. Starting config:

   ```ini
   [cpu]
   cycles=fixed 25000

   [sblaster]
   oplmode=opl2

   [joystick]
   joysticktype=2axis

   [autoexec]
   mount c .
   c:
   f1gp.bat
   ```

4. Load it in a local page and check, writing down each result:
   - intro plays, menus work, a race starts;
   - whether the game asks for the CD or a manual lookup;
   - AdLib music and engine sound work;
   - keyboard (A accelerate, Z brake, `,` `.` steer), mouse steering with
     pointer lock, and whether a browser gamepad reaches the DOS joystick;
   - saving a game writes to `GPSAVES\` and the save survives a reload;
   - speed: set the in-game frame rate to 15 fps (the 486 preset) and read
     the game's own "Processor Occupancy" figure. Raise `cycles` until
     occupancy stays under 100 % on a mid-range laptop, and try a phone;
   - whether the js-dos build needs cross-origin isolation (COOP/COEP)
     headers. GitHub Pages cannot set them; Cloudflare Pages or Netlify can.

Done when: a full race at 15 fps plays with sound on a laptop, and the
findings are recorded in this file.

## Phase 1: playable in a browser (about 1 week)

Goal: a static site anyone with the game can use.

Proposed layout:

```
web/
  index.html
  src/main.ts        start-up, screens, "click to start" (browsers need a click before audio)
  src/import.ts      read the player's files, check them, build the bundle
  src/storage.ts     keep the bundle and saves in OPFS / IndexedDB
  src/emulator.ts    start js-dos, pause and resume, file access
  src/dosbox.conf    template filled in from settings
  vite.config.ts
```

Tools: Vite and TypeScript, js-dos v8 from npm (self-hosted, not from a CDN),
fflate to read and write zips.

Tasks:

1. **Import.** Accept a folder (`<input webkitdirectory>`), a zip, or drag
   and drop. Match file names without regard to case. Check that the needed
   files exist. Hash `gp.exe`: accept the 1.05 hash above; accept other
   versions (such as the US *World Circuit*) with a warning. Report missing
   files by name.
2. **Bundle.** Copy the needed files, apply the chosen sound set to the
   `x*.bin` files, add `dosbox.conf`, and store the result.
3. **Run.** Start js-dos in a canvas scaled to 4:3 (the game's pixels are
   not square). Offer sharp or smooth scaling. Pause when the tab is hidden
   and resume when it returns.
4. **Saves.** Copy `GPSAVES\` and `F1PREFS.DAT` out of the emulator after
   each save and on exit (js-dos's `fsReadFile` or its `fsChanges` hook) and
   restore them on start. Add "export saves" and "import saves" as a zip.
5. **Deploy.** A GitHub Actions job builds `web/` and publishes it to a
   static host picked in Phase 0.
6. **Tests.** Unit tests for import and bundle logic, using a small fake
   file set rather than game files. One Playwright smoke test that loads
   the page, feeds a local copy of the game (kept outside the repo, passed
   in by path), and checks that the emulator starts.

Done when: a new visitor can import their copy, race, save, reload the page
and load that save, on current Chrome, Firefox and Safari.

## Phase 2: make it pleasant (1–2 weeks)

1. **Gamepad.** If Phase 0 shows the browser gamepad does not reach the DOS
   joystick, poll `navigator.getGamepads()` and feed the axes in. Analogue
   steering and pedals matter in this game. This may need a small patch to
   the DOSBox build to expose joystick input.
2. **Touch.** On-screen pedals and gear buttons. Tilt steering from
   `DeviceOrientationEvent` sent as mouse movement (iOS asks for permission,
   which needs a tap).
3. **Settings screen.** Sound device (AdLib, PC speaker, none), speed preset
   (write the matching `f1prefs.286/.386/.486` values and `cycles`), key
   remapping done in the page before keys reach the emulator, and scaling.
4. **Offline.** A service worker caches the page and emulator. The game is
   already stored locally, so the site then works with no network.
5. **Skip the intro** as an option (run `gp /c /g` directly, as `med.bat`
   does).

Roland MT-32 is out of scope: it needs Roland's ROM images, which we cannot
ship, and a DOSBox build with MT-32 emulation.

## Phase 3: link play over the internet (optional, 2–4 weeks, uncertain)

F1GP's two-player link runs over a serial cable or modem. js-dos networking
supports only IPX, so this needs new work:

1. Add a serial-port backend to the WebAssembly DOSBox build that sends bytes
   over a WebRTC data channel (reliable, ordered), with a small signalling
   server to pair two browsers.
2. Test on one machine first, then with added delay, to find how much
   latency the game tolerates before it reports "Link data mismatch" or drops
   the link. Internet round trips of 20–100 ms may be too slow for a protocol
   built for a cable.

Decide whether to start this after the latency test. Hot-seat multiplayer
(taking turns on one machine) already works without it.

## Phase 4: native tools, and groundwork for a rewrite (optional, open-ended)

This phase does not replace the emulator. It builds browser-native pieces
that are useful alone and would form the start of a rewrite.

1. **Format readers in TypeScript**, tested against all 16 original tracks:
   track files (including the checksum in the last four bytes), `f1pcanim`
   containers, FLI, ILBM and the palette. Use ArgDocs and ArgData as the
   references.
2. **Viewers:** an asset browser and a 3D track viewer in WebGL.
3. **A rewrite, if wanted,** by differential testing: run `gp.exe` in an
   instrumented emulator build, dump car state every frame (Trevor
   Kellaway's GpInfo documents the car data structures), and compare it
   with the new TypeScript physics. Start from the community's IDA
   database. Expect this to take many months, and decide only after
   Phase 2.

## Risks and open questions

| Risk | Effect | What to do |
| --- | --- | --- |
| Game files in a public repo | Anyone can download the game | Port never serves them; consider removing `original/` |
| Slow emulation on phones | Low frame rate or stutter | Measure in Phase 0; ship presets; lower the game's frame rate |
| Gamepad not passed through | No analogue steering | Phase 2 task 1 |
| CD or manual check at start | Game won't reach the menu | Check in Phase 0; the CD edition's `cdpatch.exe` may be relevant |
| Hosting needs COOP/COEP headers | GitHub Pages won't work | Pick the host in Phase 0 |
| Serial link too sensitive to latency | No online two-player | Phase 3 test before building |
| Browser storage cleared | Lost saves | Ask for persistent storage; offer save export |

## References

- ArgDocs file formats (tracks, media containers, GP.EXE, saves, setups,
  preferences): <https://www.argtools.com/argdocs/file-formats/>
- ArgData, .NET library for F1GP data: <https://github.com/codemeyer/ArgData>
- f1gp-utils, including GpInfo: <https://github.com/tkellaway/f1gp-utils>
- F1GP development resources: <https://sites.google.com/view/f1gpwc/development>
- Disassembly discussion: <https://groups.google.com/g/f1gpwc/c/nyi3loxTjMs>
- js-dos: <https://js-dos.com/overview.html>, networking (IPX only):
  <https://js-dos.com/networking.html>
