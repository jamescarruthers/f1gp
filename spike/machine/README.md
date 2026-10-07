# Our PC

A small PC in Rust that runs F1GP's `gp.exe` without DOSBox: an 80286 in real
mode, the devices the game uses, and DOS and BIOS served in Rust. It is step 1
of rewriting the game in Rust: everything later (replacing the game's routines
one at a time with Rust, checked against the original) builds on it.

The page runs it with `render.html?machine=rust` (`lib/pc.mjs`); js-dos stays
the default until it has been tried on real machines.

## What is here

| File | What it does |
| --- | --- |
| `src/cpu.rs` | The 286 in real mode: the 8086's instructions, the 186/286 additions (PUSHA, POPA, BOUND, IMUL with an immediate, PUSH immediate, INS/OUTS, shifts by an immediate, ENTER, LEAVE, the 0F instructions that work in real mode) and the 286's faults (divide error, BOUND, invalid opcode, a word at offset FFFFh, an instruction over ten bytes). The reserved opcode FE 38 nn hands interrupt nn to the machine. |
| `src/pc.rs` | Memory (1 MB, A20 off), the emulated clock, the run loop, the BIOS: code stubs in ROM for the timer (INT 8), the keyboard (INT 9, which calls INT 15h AH=4Fh as an AT's BIOS does: the game hooks it to see every key) and the wait in INT 16h; INT 10h, 11h, 12h, 15h, 16h, 1Ah and the rest served in Rust. The screen as RGBA. |
| `src/devices.rs` | The 8259 interrupt controller, the 8253 timer, the keyboard controller, VGA in mode 13h (the DAC, the CRTC start, the retrace bit), the game port with two centred joysticks (as the bundle's DOSBox), the AdLib's status and timers (so the game finds the card and loads its sound drivers), port 61h. |
| `src/dos.rs` | DOS: drive C as files in memory, the INT 21h functions the game calls (files, find first and next, directories, vectors, date and time, memory blocks, exit), loading an EXE with its PSP and environment. Files the program writes are marked, for the page's saves. |
| `src/ems.rs` | Expanded memory (LIM EMS 4.0): the EMMXXXX0 device, a page frame at E000h, 4 MB of pages. The game will not start without EMS. |
| `src/wasm.rs` | The functions the page calls (wasm32 only). |
| `src/bin/boot.rs` | Boots a program from a folder of files natively and saves the screen each second: for development. |
| `src/session.rs` | A recorded session (the machine calls a run in Node made, from boot) and how to play it again. |
| `src/bin/replay.rs` | Runs a recorded session natively (`probes/p6-bench.mjs --record`), instruction for instruction, and checks it ends as the recording did: for timing and profiling the interpreter. |
| `src/r3d/` | The game's 3D renderer in Rust, a routine at a time: so far the polygon filler (`fill.rs`). |
| `src/bin/r3d.rs` | The game's 3D routine caught in a recorded race, as the reference for rewriting it (below). |
| `tests/cpu286.rs` | The CPU against the SingleStepTests 80286 real-mode set. |
| `tests/pc.rs` | DOS wildcards, the timer, the interrupt controller, EMS, a small program run end to end. |

## Time

The machine keeps its own clock. Each instruction takes 1/`cycles_per_ms` ms
(as DOSBox's "cycles"; 20,000 by default, and the page's governor sets it as it
does for DOSBox), a HLT skips to the next interrupt, and the timer raises IRQ 0
at the rate the game programs on that clock. `run(ms)` runs that much of the
game's time, so a run is the same every time for the same inputs, and a probe
runs the game as fast as the host allows.

In the page (`lib/pc.mjs`, `pcCommandInterface`) the machine keeps that clock
up with real time on its own, as js-dos runs DOSBox: short tasks on the main
thread, each running the game in 2 ms slices until it has caught up or has
used 6 ms, then yielding to the page. Drawing is apart from it: the page takes
the screen as it is at each of its frames, so a slow frame does not slow the
game, and the emulation is spread over the frame, not done in one block. If
the host falls more than 200 ms behind, that time is dropped and the game
slows, as under DOSBox.

## Speed

On a 2.1 GHz Xeon (4 cores, a VM), the race of `probes/p6-bench.mjs` (Monza,
30 fps):

| | DOSBox (js-dos, Node) | Ours (WebAssembly, Node) | Ours (native) |
| --- | --- | --- | --- |
| Top speed, instructions a second | 55 million | 91 million | 114 million |
| Host CPU a second of the game: its own 3D, 25,000 cycles | 0.51 s | 0.29 s | |
| Host CPU a second of the game: the page's fill, 8,000 cycles | 0.21 s | 0.09 s | |

DOSBox's figures include its AdLib synthesis and mixing, which ours does not
do. In the page (`probes/p6-bench-page.mjs`, headless Chromium, the autopilot
in a race), the main thread is busy 60% of the time on DOSBox and 47% on ours
with the game's own picture at 25,000 cycles, and 36% and 25% with the new view
at 480x300 (8,000 cycles); both keep the game at full speed, and at 1280x720,
where the software GPU holds the page to 4 frames a second, both still do.

What made it fast (from 53 to 114 million natively, measured on the replay and
profiled with callgrind): the instruction loop in `Cpu::run` rather than a call
per instruction from the machine; the small helpers inlined; the check for an
interrupt only after an instruction that can let one in (STI, POPF, IRET, OUT);
the arithmetic flags set in one write, without branches.

## Rewriting the game's routines

The machine can stop at any routine of the game and let Rust look at the state or do the
routine's work (step 2 of the rewrite):

- `Machine::hook(address, n)` puts the bytes FE 38 n (n from `HOOKS`, C0h) at a routine;
  `run_until` stops there with the hook's number. The owner can put the bytes back and run on,
  or do the routine's work and `retf`. The hook's own bytes are not counted, so a run with hooks
  keeps the same clock as the recording it plays.
- `Machine::call_far(cs, ip, limit, on_hook)` runs a routine alone, as a far call: interrupts
  masked, the clock still, until it returns.
- `Machine::snapshot`, `restore`: the CPU and memory, also as bytes (`Snapshot::to_bytes`).

The first routine is the game's 3D view (0F47:81CE, `docs/renderer-notes.md`), so that the
original picture can be drawn by us, then sharper and smoother:

```
node probes/p7-r3d-record.mjs                   # a Monza race: cockpit, chase and TV views, the autopilot driving
cd machine
cargo run --release --bin r3d -- capture ../out/files ../out/r3d/monza.ops ../out/r3d/monza 18 60
cargo run --release --bin r3d -- check ../out/r3d/monza       # each caught state, the routine run again alone
cargo run --release --bin r3d -- footprint ../out/r3d/monza   # the instructions it runs
```

`r3d calls <out> [fill|edge|border]` runs our routines (`src/r3d/`: the polygon filler, the edge
builder, the border edge) against the game's on every call in the caught frames: the same memory
and registers after each. `r3d fuzz <out> [trials]` runs our edge code against the game's on
made-up calls, to reach the paths races don't. `r3d ours <out>` draws each frame with our
routines in place of the game's and compares the frames. `fills` and `dumpfills` list the
filler's calls, the second with the pixels each wrote.

`capture` hooks the routine and its return in the replayed race and saves, for every 18th frame,
the state the routine starts from and the 64,000 bytes it leaves in the back buffer. `check`
runs the game's routine again from each state, alone: all 58 frames come out byte for byte the
same, so a rewrite can be held to exactly that. The routine takes 460,000 to 940,000
instructions a frame; over the 58 frames it runs 12,217 distinct instructions: 11,637 in the
renderer's segment (0F47), 345 in 19ED (the palette step, the mirror backdrop), 235 in segment 0.

## Building and testing

```
rustup target add wasm32-unknown-unknown
node build-machine.mjs                    # dist/machine.wasm (221 KB)
(cd machine && cargo test --release)      # the unit tests
node probes/p6-pc-route.mjs               # boots gp.exe in Node and drives lib/route.cjs to a race
```

To time or profile the interpreter natively on a race, record one in Node and
replay it (the replay checks that it ends as the recording did, so the native
and WebAssembly builds agree instruction for instruction):

```
node probes/p6-bench.mjs --record out/p6-bench/race.ops
mkdir -p out/files && (cd out/files && unzip -o ../../dist/f1gp.jsdos)
cd machine
cargo run --release --bin replay -- ../out/files ../out/p6-bench/race.ops
CARGO_PROFILE_RELEASE_DEBUG=true cargo build --release --bin replay
CALLGRIND=1 valgrind --tool=callgrind --instr-atstart=no target/release/replay ../out/files ../out/p6-bench/race.ops
```

The CPU test set is not in the repository (325 MB). With a copy of
[SingleStepTests/80286](https://github.com/SingleStepTests/80286):

```
SST_286=/path/to/80286/v1_real_mode cargo test --release --test cpu286 -- --nocapture
```

Of its 1,477,997 tests, 160 differ from a real 286, all in cases the game does
not meet: a repeated string instruction that reaches offset FFFFh part-way,
ENTER at deep nesting levels, `AAM 0`'s flags, PUSHA/POPA with the stack
wrapping at SP 1, and four IDIV results. The test allows exactly those.

To watch a boot natively (the bundle unpacked into a folder):

```
cargo run --release --bin boot -- <files> <out> [seconds] [GP.EXE] [" /g"]
```

## Checks

- `probes/p6-pc-route.mjs` (Node, no browser; CI runs it on every push): from
  boot through the language and manual questions, the joystick question and the
  menus to a Monza Quick Race at the green lights (36 s of game time in 16 s on
  the host), then reads the game's state with `lib/f1gp-mem.mjs` and
  `lib/f1gp-state.mjs` as the page does (gp.exe at 01A2h, as under DOSBox; 26
  cars) and holds A for 5 s (0 to 114 mph); the AdLib race driver the Amiga
  sound hooks is loaded.
- `probes/p5-pad.mjs --query '{"machine":"rust"}'`: the page on our PC, the
  game controller's 19 checks (menus, steering, pedals, gears, pause, views,
  hand-over to the keyboard and back), all pass.
- `probes/p5-stutter.mjs --query '{"machine":"rust"}'`: the page through a race
  with the autopilot.
- `probes/p6-bench.mjs [--machine dosbox]` and `probes/p6-bench-page.mjs
  [--machine rust]`: the speeds above.
- `bench.html` (on the site): both machines through the same race in your own
  browser, on your own GPU, with the results side by side;
  `probes/p6-bench-browser.mjs` runs it in headless Chromium.

## Not done yet

- AdLib sound: the machine answers the card's detection and keeps its register
  writes but does not synthesise them, so `sound=adlib` falls back to the
  Amiga sound.
- The intro (PLAYSCR.EXE and the FLI films): the page starts `gp /g`.
- A mouse, the serial link, VGA's planar modes (the game uses mode 13h only).
- Saving from the game's menus: `probes/p5-saves.mjs --query
  '{"machine":"rust"}'` ends in Load Car Setups instead of Save Names (the
  same probe passes on DOSBox); not yet looked into.
