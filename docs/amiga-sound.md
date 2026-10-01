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

All nine effects in the table at 9D79Ah. The player at 8084C starts one when
the race code writes its number to 808E0h. "Code" means the code that plays
it makes its purpose plain; "likely" is inferred from the code around it and
the sound's shape. Period 300 is 11.8 kHz (3,546,895 Hz / period).

| # | Sample | Bytes | Period | Vol | Channel | Sound |
| --- | --- | --- | --- | --- | --- | --- |
| 0 | 891C8h | 12,730 | 300 | 16 | 3 | Pit stop: the wheel guns (likely; the pit timers 4A764h/4A768h) |
| 1 | 82A62h | 15,248 | 300 | 48 | 3 | A car passing close and fast, pitch from its speed (code, 9D940h) |
| 2 | 916A8h | 13,300 | 300 | 64 | 3 | Collision: two cars touching, one of them the car in view (likely) |
| 3 | 866F2h | 10,710 | 300 | 48 | 2 | Passing car, second variant picked at random (code, 9D940h) |
| 4 | 94B9Ch | 14,678 | 300 | 48 | 2 | Unknown: a slow, low swell; no code found that plays it |
| 5 | 80A46h | 7,964 | 350 | 64 | 1 or 3 | Kerb or verge rumble, on the side that hit it (likely) |
| 6 | 8C482h | 7,942 | 300 | 48 | 1 | Tyres (code, above) |
| 7 | 8E488h | 12,576 | 300 | 64 | 1 | Pit stop: the car dropped off its jacks, not in TV views (likely) |
| 8 | 984F2h | 21,160 | 300 | 40 | 0 | Engine, looped (code, above) |

`spike/amiga/effects.py` lists the table, renders each effect once through
the A500 filters and measures it (attack, decay, spectral centroid).

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

## For the port

Neither sound needs the Amiga emulated. Both can be played from the player's
own Amiga disks in the browser:

- **Title tune:** port music.unit (about 1.5 KB of 68000 code) and the Paula
  rules to JavaScript, reading the song and samples from `frontend`.
- **Engine:** loop the engine sample in WebAudio, with its playback rate set
  each 1/50 s from the DOS game's revs by the rule above, and silence the AdLib
  engine.
- **Effects:** trigger the table's samples from game state the page already
  reads (slip, nearby cars and their speeds, contact, kerbs, pit stops).
