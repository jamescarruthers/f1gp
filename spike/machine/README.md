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
| `tests/cpu286.rs` | The CPU against the SingleStepTests 80286 real-mode set. |
| `tests/pc.rs` | DOS wildcards, the timer, the interrupt controller, EMS, a small program run end to end. |

## Time

The machine keeps its own clock. Each instruction takes 1/`cycles_per_ms` ms
(as DOSBox's "cycles"; 20,000 by default, and the page's governor sets it as it
does for DOSBox), a HLT skips to the next interrupt, and the timer raises IRQ 0
at the rate the game programs on that clock. `run(ms)` runs that much of the
game's time, so a run is the same every time for the same inputs, and a probe
runs the game as fast as the host allows.

## Building and testing

```
rustup target add wasm32-unknown-unknown
node build-machine.mjs                    # dist/machine.wasm (194 KB)
(cd machine && cargo test --release)      # the unit tests
node probes/p6-pc-route.mjs               # boots gp.exe in Node and drives lib/route.cjs to a race
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

## Not done yet

- AdLib sound: the machine answers the card's detection and keeps its register
  writes but does not synthesise them, so `sound=adlib` falls back to the
  Amiga sound.
- The intro (PLAYSCR.EXE and the FLI films): the page starts `gp /g`.
- A mouse, the serial link, VGA's planar modes (the game uses mode 13h only).
- The machine runs in the page's frame loop, at most 100 ms a frame: a host
  slower than the game's time slows the game rather than skipping.
