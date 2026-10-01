# Amiga sound: title tune, engine and effects

How the Amiga version of *Formula One Grand Prix* (MicroProse, four disks,
`original/amiga/`) makes its title tune, engine and race effects, and how they
compare with the DOS version's AdLib sound. The tools are in `spike/amiga/`;
recordings are not kept in the repository.

## The disks

Standard AmigaDOS (OFS) disks; `spike/amiga/adf.py` lists and extracts them.
`s/startup-sequence` runs `gpintro` (the intro credits) and then the loader
`formula one grand prix`, which runs `frontend` (disk 1: title screen and
menus) and then `f1gp` (disk 2: the race). The programs are ordinary hunk
executables, not packed (`spike/amiga/hunk.py` loads them with relocations;
addresses below are as loaded, first hunk at 10000h).

## Title tune (frontend)

- **Player.** A self-contained module, "music.unit", in frontend's third hunk
  (chip memory). Its jump table at 8B790h: +0 start, +4 stop, +8 tick, +C set
  a level offset (the front end fades the tune with it, 0 down to −64). The
  song number is the long at 8B7AEh (1, the only full song). The front end's
  VBlank interrupt calls the tick, so it runs 50 times a second (PAL).
- **Notes.** Each channel reads its own command list (song table 8BD46h, 16
  bytes per song). A note gives a period and a length. Each instrument has an
  attack part, a looped part that Paula plays after it, and a volume envelope.
  A channel's DMA is switched off one tick before its next note, so every note
  restarts cleanly. Two commands switch the A500's audio filter (CIA-A PRA bit
  1); the title tune does not use them, so the filter stays at its power-on
  state (on).
- **Data.** Nine instruments, 76 KB of 8-bit samples inside the program,
  played on all four channels at 5.3–27.9 kHz (15.7 kHz typical).
- **Length.** A 12.8 s opening, then 128.0 s (6,400 ticks) that repeat.
- **Playing it.** `spike/amiga/title-tune.py` runs the game's own player on an
  emulated 68000 (Unicorn), logs its writes to the sound chip, and
  `spike/amiga/paula.py` turns the log into 44.1 kHz stereo: DMA start, loop
  reload and volume as Paula does them, channels 0 and 3 left and 1 and 2
  right, then the A500 output filters (one-pole 4.9 kHz, plus the 3.3 kHz
  "LED" filter while it is on).

## Engine (f1gp)

The race program takes over the machine and installs its own interrupts.
Sound effects come from a table at 9D79Ah, 16 bytes each (sample, length,
period, volume, channel); channels 1–3 play one-shots that the audio
interrupt stops after one pass.

- **Engine.** Effect 8: a 21,160-byte sample at 984F2h, looped on channel 0
  (the left speaker) at volume 40.
- **Pitch.** Set every VBlank (routine 3CC38h) from the revs at 4A704h
  (clamped to 500–15,000):
  r = revs + random(0–127); q = 7,500,000 / max(r, 300);
  if q ≥ 2,815 (idle) then q = 2,815 + random(−64–63);
  period = max(q × 3,840 × 4 / 65,536, 128).
  So 3,000 rpm plays the sample at about 6 kHz and 12,000 rpm at about 24 kHz.
- **Tyres.** Effect 6 on channel 1: a noise sample at a random start, a random
  period (C4h–E3h) and a volume from the amount of slip.
- **Playing it.** `spike/amiga/engine.py` applies this rule to a revs trace
  recorded from the DOS game (`spike/probes/record-engine.mjs`: the autopilot
  drives a practice lap with AdLib sound and logs revs, gear and speed every
  game frame against the sound's sample count). This assumes the Amiga's revs
  value has the same scale as the DOS one (car+62); both are rpm by their
  ranges, and the two engines' harmonics line up at equal revs.

## Race effects (f1gp)

All nine effects in the table at 9D79Ah. The player at 8084Ch starts one
when the race code writes its number to 808E0h: it stops the effect's
channel, writes the sample, length, volume and period, and starts it; the
audio interrupt turns channels 1–3 off at the end of the first pass. Some
callers change the table entry first (the channel, the period, the tyre
sample's start and length). Period 300 is 11.8 kHz (3,546,895 Hz / period).
Each sound is named from the code that plays it and from the DOS code that
does the same (next section).

| # | Sample | Bytes | Period | Vol | Channel | Sound | Played by |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 0 | 891C8h | 12,730 | 300 | 16 | 3 | The start lights come on | 4B422h, in the start-lights sequence (state 4A750h) |
| 1 | 82A62h | 15,248 | 260–505 | 48 | 3 or 2 | A car passing the TV camera, lower the faster it goes | 9D9CEh, TV view only; one of 1 and 3 at random, the two sides in turn |
| 2 | 916A8h | 13,300 | 300 | 64 | 3 | Contact between two cars, one of them the car in view | 4356Ah, 43942h |
| 3 | 866F2h | 10,710 | 260–505 | 48 | 2 or 3 | Passing car, the other recording | 9D9CEh |
| 4 | 94B9Ch | 14,678 | 300 | 48 | 2 | Unknown: a slow, low swell; no code found that plays it | – |
| 5 | 80A46h | 7,964 | 350 | 64 | 1 or 3 | Kerb, on the side that hit it | 38C6Ah |
| 6 | 8C482h | 7,942 | C4h–E3h | slip | 1 | Tyres: a random stretch of the noise, louder with more slip | 9D8F2h, in 9D82Ah (above) |
| 7 | 8E488h | 12,576 | 300 | 64 | 1 | The starter motor: started again every frame for 0.8 s before the engine runs; not in the TV view | 46602h (state 4A79Eh) |
| 8 | 984F2h | 21,160 | from revs | 40 | 0 | The engine, looped | 80928h, in 80922h (above) |

`spike/amiga/effects.py` lists the table, renders each effect once through
the A500 filters and measures it (attack, decay, spectral centroid).

## The DOS game's sound events

The DOS game runs the same race code with the same variables, and calls its
sound driver where the Amiga version starts an effect. The race driver
(`xsound.bin`, the AdLib `asound.bin` in the site's bundle) is loaded at
segment 8CE6h of the image when a session loads; the menus have a stub with
no sound there, and the race driver stays after the session. The game reaches
it through a table of far pointers at SS:0102, filled from the driver's words
at 24h (19ED:2D50): function 0 is the timer's call, 3 (0532h) starts the
effect in AX, 4 (0556h) stops one, 5 is the service. 19ED:2D73 starts the
effect in SS:018C unless SS:018E is set (80h in the menus and from the end
of a session; 0 while a session runs with sound on). Before some effects the
game writes their details into the driver's first bytes.

| DOS driver effect | Started by | Amiga effect | Details the game leaves |
| --- | --- | --- | --- |
| 0 | 19ED:2D25 (sets DS:0948 = 0) | 8, the engine (80922h, which clears 3CC06h) | – |
| 1 | 19ED:2DA2, one call in four | 6, tyres (9D82Ah, every call) | es:[12h]: a volume from DS:2E3F by slip / 32 |
| 2 | 0:DB38 (start lights, DS:2937, DS:2923) | 0, start lights (4B422h) | – |
| 3 | 0:3F88 | 5, kerb (38C6Ah) | es:[0Eh]: 1 = the left side (channel 3) |
| 4 | 0:B972, 0:BDA5 (the viewed car DS:097F) | 2, contact (4356Ah, 43942h) | – |
| 5 | 0:964D (state DS:2971) | 7, starter motor (46602h) | – |
| 6–9 | 19ED:2E94, in turn (TV view) | 1 or 3, passing (9D9CEh) | DS:0956: the passing car (+10h its speed) |

19ED:2D8C stops every effect where the Amiga version calls 808E2h (all
channels off): when the engine stops, at a change of view, at the end of a
session; 19ED:2E32 stops the tyres (9D906h). The engine sound's state and
revs are DS:0948 (3CC06h: 0 running, 20h winding down, 40h stop now, 80h
off) and DS:0054 (4A704h). The game sets the rate DS:0056 (4A706h) each
frame (0:933C; 46246h), and its timer routine 8B6E:03D0 moves the revs every
sixth tick (3CC38h every VBlank), winding down by DS:0950 to DS:0952.

## DOS (AdLib) for comparison

- **Sound devices.** AdLib (`a*.bin`), Roland MT-32 (`r*.bin`) and PC speaker
  (`b*.bin`). There is no sampled sound. The emulator plays AdLib (OPL2 FM).
  The MT-32 needs Roland's ROMs, which js-dos does not have.
- **Music.** The DOS credits read "Music: John Broomhall, based on the Original
  Theme Music by Dave Lowe". The intro (`f1gp.bat`: `playscr test.scr
  xintro.bin`) is mostly sound effects with short FM phrases: logo 0–23 s, 3D
  scenes 32–48 s, then the title screen from about 63 s with sparse FM notes.
  The main menu is silent.
- **Engine.** FM tones whose pitch follows the revs: a few clean, evenly
  spaced harmonics. The Amiga engine is a recording of a real engine, with
  denser harmonics and noise between them.

`spike/probes/record-sound.cjs` records the DOS intro.

## In the browser

`render.html?sound=amiga` (or the Sound menu) plays the Amiga version's
sound with the DOS game, which runs everything else; its AdLib output is not
played. `sound=amiga-clean` leaves out the A500's filters.

- **Data.** The site's build reads the four disk images in
  `original/amiga` (`spike/lib/amiga-disk.mjs`: OFS files, hunk loading
  with relocations) and writes `dist/amiga-sound.bin`, 195 KB: frontend from
  8BD46h to the end of its chip hunk (songs, notes, instruments, envelopes and
  samples; the player reads nothing else) and f1gp from 80A46h to the end of
  the effects table (the nine samples and the table). For a local page:
  `node lib/amiga-disk.mjs`.
- **Title tune.** `spike/lib/amiga-music.mjs` is music.unit in JavaScript,
  ticked 50 times a second. It writes the same sound chip registers in the
  same order as the game's 68000 code run on an emulated CPU, for 7,201
  ticks (the opening and a whole loop, 68,294 writes) and through the front
  end's fade (`spike/amiga/tune-log.py`, `spike/tests/amiga-sound.test.mjs`).
- **Sound chip.** `spike/lib/paula.mjs` is the offline renderer's Paula
  model in real time: four DMA channels, loop reload, one-shot channels,
  the stepped signal averaged exactly at four times the output rate, the
  A500's filters there, then a low-pass FIR down to the output rate. Its
  output of the title tune matches the offline renderer's (correlation
  0.9998, the same loudness). Both chips (tune and race) run in one
  AudioWorklet (`spike/lib/amiga-worklet.mjs`).
- **Race.** `spike/lib/dos-sound.mjs` puts two 21-byte stubs after the race
  driver (1BD0h; the buffer is 1C40h bytes, the largest driver 1BC9h) and a
  near jump to them at 0532h and 0556h; the stubs count each effect started
  and stopped (bytes at 1C00h and 1C10h) and then does what the replaced
  instruction did. The page reads the counters, the details above and the
  engine state every frame and plays the Amiga effects by the Amiga rules
  (`spike/lib/amiga-race.mjs`); the engine's period comes from DS:0054 by
  the rule above, 50 times a second.
- **When.** As on the Amiga: the intro is silent; the tune starts with the
  menus and fades out over 1.3 s (33 steps, 0 to −64, two ticks each) when a
  session starts loading, as the front end does before it runs the race
  program; it starts again from the beginning in the menus after the
  session. The page tells these apart by the race driver (absent in the
  menus until the first session; a fresh copy, without the hook, when a
  session loads) and SS:018E (0 in a session).
- **Mix.** The Amiga plays channels 0 and 3 left and 1 and 2 right. For
  headphones the page mixes them at half separation (three quarters to
  their own side), and puts the engine (channel 0) in the middle. The race
  is 1.4 times louder than the tune, so the engine is about as loud as the
  AdLib engine (RMS 0.10 against 0.105).
- **Checked** in headless Chromium (`spike/probes/p5-amiga-browser.mjs`): the
  intro silent, the tune in the menus, its fade as the race loads, on the
  grid the lights, the starter (24 starts) and the engine, tyres while
  driving, passing cars in the TV view, the tune again after Esc, and
  silence when the page goes back to AdLib. `spike/probes/p5-amiga-sound.mjs`
  logs the DOS events in Node.
