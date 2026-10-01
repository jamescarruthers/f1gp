# F1GP 1.05 memory map

This page lists what we know about the running game's memory: where the
cars, the track, the camera and the frame clock are, what each field means,
its units, how we know, and how sure we are. The code that reads it is
`spike/lib/f1gp-mem.mjs` (find the game, read bytes) and
`spike/lib/f1gp-state.mjs` (`readState`, `readTrack`). The tests are in
`spike/tests/f1gp-state.test.mjs`.

It covers the European build of `gp.exe` 1.05 only. Other builds are not
known to match.

## Conventions

**Addresses.** DOS loads the program image at a paragraph we call
`imageSeg`. It was 0x1A2 in every run so far. The program then sets:

- DS = imageSeg + 1E61h (= 2003h in our runs). The code does
  `mov ax,1E61h; mov ds,ax`.
- SS = imageSeg + 2914h (= 2AB6h), the EXE header's SS. The game reaches SS
  variables as `[bp+X]` with BP = 0.

`DS:0981` means offset 0981h in that DS. "Image 0xNNNN" is an offset in the
unpacked load image (`spike/out/gp_unpacked.bin`). For code in the first code
segment, it is also the code offset `0:NNNN`.

**Evidence codes:**

- **CD**: community documents or community source code (GpInfo GP_SI, René
  Smit's GPDEF.INC, the f1gp-utils TSRs, ArgDocs). Not tested by us unless
  another code says so.
- **SC**: static code. We read the instructions in the unpacked image.
- **DT**: dynamic test in the emulator. The run is named after the result.
- **Confidence**: high, medium or low. "Unknown" means we do not know.

**Runs.** Unless a row says otherwise, runs are Quick Races at Monza: 3
laps, Rookie, dry, 26 cars, 15 fps (SS:1230 = 20), DOSBox at 25,000 cycles,
`gp /g`. Their data is in `spike/out/` (git-ignored, because it holds game
data).

| Run | What it did |
| --- | --- |
| `p1-state/drive` | Autopilot for 195 s (lap 1, then part of lap 2), with every view key pressed once. 2,918 game frames were logged, plus the dash every 250 ms. |
| `p1-state/coast` | No throttle for 195 s. Up was pressed 16 times, to ride in 15 different computer cars. P pause for 6 s, then TV and chase views. The player's car was pushed off and retired. 4 computer cars pitted. 2,808 frames. |
| `p1-state/browser` | Headless Chromium, js-dos in direct mode. `readState` was called at every animation frame for 20 s (1,202 reads). |
| `p1-fields/{drive1,drive2,coast1}` | 100 ms snapshots of all car records, plus full-RAM dumps. |
| `p1-camera/{views2,replay,drive-n*}` | Every game frame of DS and SS, with view keys, pause, replay and 3 frame rates. |
| `p1-track/{qr1, prac-*}` | Quick Race dumps and practice-session dumps of all 16 circuits. |
| `p1-accuracy/race{1,2,3}` | Three whole Quick Races, green light to the results, with the emulator clock at 2× real time (the emulated PC is unchanged). Every game frame, the dash every 0.5 game s, view-key taps. |
| `p1-verify/ncr-gb` | Non-Championship Race at Silverstone from 26th on the grid, 18,000 cycles. View keys, a drive off the track, a stop. |
| `p1-verify/fp-hun` | Free practice at the Hungaroring, 10 fps, 40,000 cycles. |
| `p1-verify/prac-mon`, `bmap-japan` | Practice at Monaco; `spike/map.html` in headless Chromium at Suzuka. |
| `p1-verify/ncr-gb-fix` | The Silverstone race again, after the consistency fix below. |

## Finding the game in memory

- **Guest RAM in the emulator heap.** Look for the DOSBox BIOS date
  "01/01/92" at linear F000:FFF5. Accept a hit only if the INT 21h vector
  segment (linear 86h) is F000h. This only works when DOSBox runs in the same
  thread as our code: Node's `dosboxNode`, or js-dos direct mode in the
  browser. There, `ci.transport.module.HEAPU8` holds guest RAM. In worker
  mode it does not. DT, high (Node and Chromium).
- **The gp.exe image.** Find the text "Link data mismatch. Press escape to
  repair" in guest RAM. It sits at image offset 167,759, so imageSeg = (hit −
  167,759) / 16. DT, high.
- **Check.** SS:3264 is the game's cosine table: the word there is 4000h, and
  the word at SS:3264 + 2·4096 is −4000h. `attach()` sets `mem.checked` from
  this test. DT, high.
- **Cost.** `attach()` takes 28–35 ms, because it scans the heap once.

## Units and axes

| Quantity | Unit | Evidence |
| --- | --- | --- |
| World X, Y (car +28/+2C, camera DS:2259/225D) | 1/16384 ft, signed 32-bit; 1 m = 53,753 units | DT high: equal to track-file units × 256 with no rotation or offset (p1-track qr1 fit); the Monza lap is 5,798 m |
| Segment ("fine") X, Y, lateral offset, distance along a segment | 1/64 ft = world >> 8 | DT high |
| Segment (track length unit) | 16 ft = 1024 fine units; one entry of the segment array | DT high: Monza has 1,189 segments (5.80 km) |
| Height Z (segment +06, car +08, camera SS:013E) | Probably 1/64 ft | Unknown, not verified. Eye heights of 160 and 384 would be 2.5 ft and 6 ft. |
| Angles | 10000h = one turn. Heading 0 = +Y, 4000h = +X: clockwise with X drawn right and Y drawn up | DT high |
| Speed (car +10) | 1/64 ft/s. mph = floor(v·2BAh/10000h) | DT high: the dash matches |
| Times (DS:2955, DS:294F, lap times) | ms | DT high |

Drawing X right and Y up gives the real circuit, not a mirror image (DT, track
agent).

## Frame tick, timing and consistent reads

The game simulates exactly one step per displayed frame. In a single-player
session, the main loop (image 0xEE13–0xEEFC, SC) does this in order:

1. Key mapping.
2. Image 0xDA48. In races it adds 2 to DS:2977 at 0xDA68.
3. All cars, at 0x5C2F.
4. View keys, at 0xE576.
5. Camera, at 0x7757, then the render, at 0F47:81CE.
6. The game clock, at 0x0984: DS:2955 and DS:294F.
7. Dash, HUD and occupancy.
8. The frame limiter and screen flip, at 0xC2A6.

| Address | Meaning | Units | Evidence | Conf. |
| --- | --- | --- | --- | --- |
| DS:2955 dword, DS:2959 word | Game clock and its fraction. Advances once per frame by DS:2241 ms (dword) + DS:2245/65536. Reset to 0 at session start (image 0x0909). Frozen while paused. Jumps back when a replay starts. | ms | SC; DT: 2,918 frames in 195 s, +66/+67 per frame | high |
| DS:2241 dword, DS:2245 word | Clock step per frame: whole ms, and fraction. Computed as DS:2C5D × 1000, which gives 66 ms + 43,624/65,536 at 15 fps. | ms | SC 0x092D; DT | high |
| (derived) | Frame number = round((DS:2955 + DS:2959/65536) / step). `readState().frame` computes it. It is exact, and it stays right when a read lands between the clock's two adds. | frames | DT: one such torn read in 2,916 frames (tick 1 ms short); frame was still right | high |
| DS:2977 byte | +2 per frame, at the start of the frame's work, before the cars move. Races only: both increments are on the session-type-80h branch (0xDA68, 0xDAA9). | count | SC; DT | high (races) |
| DS:294F dword | Session and lap timer. Each frame it advances by frame ms × DS:0220/4000h in races, or × DS:0214/4000h in other sessions. Both are per-circuit factors from 1.003 to 1.069, so read them; do not assume a value | ms | SC 0x0951; DT: 1.0223 at Monza (416Eh), 1.0618 in a Silverstone race (43F7h), 1.0197 in Hungaroring free practice (DS:0214 = 4145h) | high |
| SS:1230 word | Frame-rate setting: 300 Hz ticks per frame; fps = 300/N. 20 in the Quick Race. Comes from F1PREFS.DAT byte 1160. | ticks | DT, SC | high |
| SS:05C8 word | 300 Hz ticks since the last flip. Reset at the flip (0xC2BF). | ticks | DT, SC | high |
| SS:05D2 word / SS:05D4 word | Free-running 300 Hz counter / 18.2 Hz counter. | ticks | DT | high |
| DS:2C63 word | Ticks the last frame's work took, stored just before the limiter waits. | ticks | DT, SC | high |
| DS:2C59 / 2C5B / 2C5D word | Physics dt for the current car / the player / computer cars: SS:1230/300 s in 0.16 fixed point. Below 12 fps the player takes 2 half steps (DS:2C5F = FFh). | 0.16 s | DT, SC | high |
| DS:2C61 word | Integer fps. | fps | DT | high |

**Reading between frames.** The cars move (step 3) before the clock changes
(step 6). So a read during a frame's work can see cars one frame ahead of
`tick`, or part-way through the car loop. `readState` reports two flags:

- `settled` = SS:05C8 ≥ DS:2C63. It means the game is in its frame-rate wait.
  It is worked out from a single read. It is not enough on its own: a read
  late in the next frame's work can also pass it, with the cars already one
  frame ahead.
- `carsAhead`. (DS:2977 − 2·frame) & FFh is constant between frames in a
  race. The reader keeps the most common value seen on settled reads as the
  session's reference (reset when the session changes or the clock goes
  back), and flags reads where the value differs. Races only.

`consistent` = settled and not carsAhead. Measured:

- **Before the fix**, the reader re-learned the reference from every settled
  read, so `carsAhead` was never true on a settled read. In the Silverstone
  race at 18,000 cycles, 1,427 reads flagged consistent held the cars one
  frame ahead (in 1,309 of 2,506 frames), and races at 2× speed showed the
  same.
- **After the fix**, in the same race (`ncr-gb-fix`, 59,011 polls, 2,247
  frames): 0 reads flagged consistent were a frame ahead; good reads were
  accepted at the same rate as before (31,133 consistent, 1,290 not).
- **Outside races** DS:2977 does not count, so only `settled` is available.
  In Monaco practice at the shipped settings, 2.3% of reads were a frame
  ahead (1,103 reads). DS:2901, written before the car loop in every session
  (image 0xC3B4), is an untested lead for a marker.
- **Browser, one read per requestAnimationFrame.** 300 of 1,202 reads (25%)
  were not consistent. All 301 game frames had at least one consistent read.

For a renderer: read every animation frame. Keep a state only when
`consistent` is true and `frame` has changed. Interpolate between the last two
kept states.

## Session and global state

| Address | Meaning | Values / units | Evidence | Conf. |
| --- | --- | --- | --- | --- |
| SS:124A byte | Session type | 00 practice, 01 free practice, 02 pre-race practice, 40h qualifying, 80h race | CD (SAVINF.H); DT: 80h in the Quick Race, 00 in the practice dumps | high (80h, 00), medium (others) |
| SS:1236 byte | Circuit index, 0–15 (track file number − 1) | Monza = 11 | DT: 17 runs on 16 circuits (track agent) | high |
| SS:123C word | Race laps | 3 | DT: the dash "OF 3" matched 597/597 | high |
| SS:1222 byte | Opposition standard 0–4 | 0 = Rookie | CD; DT one value | medium |
| SS:122E word | Wet race: 0 dry, 60h wet | 0 | CD; DT dry only | medium |
| DS:2967 word | Runners (cars still in the race). **Races only**: 0 in other sessions | count | DT: dash RUNNERS 597/597. Equals 26 − (cars with +96 bit 20h) in every race frame; dropped 26→22 when 4 cars retired at once (drive), 26→25 when the player retired (coast), 26→23 in race2 | high (races) |
| DS:298B byte | Laps the leader has completed: 0 on the grid, then the leader's car +22 − 1. **Races only** | count | DT: 780/780 trace samples and 16,358/16,358 frames of three races; 1,531/1,647 in free practice | high (races) |
| SS:1940, 26 bytes | Car IDs (+AC) in race order | IDs | DT: equals sorting by +AA in every trace sample | high |
| DS:0C65, 26 words | Car record offsets (from DS:0D1B) in race order; the car loop walks it. DS:049A = end pointer | offsets | SC; DT (static agent) | high |
| DS:28FD word | The player's car record (DS offset). Becomes 0 when the session is left, **and about 15 s after the player's car retires** | near pointer | DT: 0F5Bh while racing; 0 from 83.5 s in coast (retired at 68.8 s) | high |
| DS:2227 byte | 80h while paused (P), also during the pause after a replay | flag | DT: 12/390 samples during a 6 s pause, and no frames during it; camera agent: the only such byte in DS/SS | high |
| DS:005A byte | Bit 80h = replay playing | flag | DT (camera agent) | high |
| SS:124E byte | Bit 10h = leaving the session (Esc) | flag | DT (camera agent), SC 0xEED0 | high |
| SS:1108 byte | Non-zero = not in the car (menus) | flag | DT: 0 throughout both races; FFh in the main menu (camera agent) | medium |
| SS:1A4A, 40 × 24 bytes | Driver names, indexed by (ID & 3Fh) − 1, zero-padded ASCII | text | DT: the camera agent matched four names to the on-screen banner | high |
| SS:3264, 4,098 words | Cosine table, 0–180° in 1/8-unit steps, 4000h = 1.0. The same values as `cosTable()` in lib/track-file.mjs | 2.14 fixed point | DT, SC | high |

## View and camera

| Address | Meaning | Values / units | Evidence | Conf. |
| --- | --- | --- | --- | --- |
| DS:0981 byte | View mode. Type = value & B0h. Bit 40h = TV camera placed; it is clear for one frame before a cut | 00 cockpit, 80h/C0h TV, A0h chase, B0h reverse chase | DT: drive run phases (cockpit 00, Left C0h, PgDn A0h, Delete B0h); camera agent; SC 0xE7A0–0xE875 | high |
| DS:097F word | Viewed car: DS offset of its record; slot = (v − 0D1Bh)/C0h. Up/Down step through race order; Home goes back to the player | near pointer | DT: the dash shows this car's speed (663/664) and POS (664/664) when riding in 15 computer cars | high |
| DS:097D word | Object the camera is computed from: = DS:097F in cockpit, = 099Bh (camera record) in external views | near pointer | DT | high |
| DS:0983 byte | One-frame view-key request bits | bits | DT (camera agent) | high |
| DS:099B, C0h bytes | Camera pseudo-car record for external views (+28/+2C position, +1A yaw, +7E bit 01 set) | car-record layout | DT (camera agent) | high |
| DS:2259 / DS:225D dword | Camera world X / Y for this frame, in every view | world units | DT: in cockpit view it equals our position of the viewed car **exactly**: 0 units of error in all 5,311 cockpit frames, including 2,683 frames riding in computer cars whose positions are derived | high |
| SS:013E word | Camera Z = pose height + eye height DS:233F (160 in cockpit, 384 outside) | Z units | DT (camera agent) | high |
| DS:2261 word | Camera yaw | angle | DT | high |
| DS:2257 word (+ DS:2269 in cockpit) | Camera pitch; DS:2269 is the cockpit head nod. Pitch only shifts the horizon: no pitch rotation, no roll | angle | DT (camera agent) | high |
| SS:0130 / SS:0132 word | Horizon row / viewport rows (103 cockpit, 164 outside) | screen rows | DT (camera agent) | high |
| DS:0060 / DS:2347 word | Chase camera: smoothed direction / distance (−1920 = 30 ft) | angle / fine units | DT: chase cameras 29.99–30.01 ft from the viewed car (326 frames) | high |
| Projection | Image 0F47:20D9. x = 160 + 256·lateral/depth; y = horizon − ((dz·SS:017C·2)>>16)·32/depth; viewport 320×164 | pixels | SC; partly DT (camera agent) | medium |

## Car records

There are 26 records of C0h bytes at DS:0D1B, DS:0DDB … DS:1FDB, in grid
order (slot 0 = pole). The table lists the fields `readState` uses, plus
others with evidence. "Physics mode" means +7E bit 01 set (see the next
section).

| Off | Size | Meaning | Units | Evidence | Conf. |
| --- | --- | --- | --- | --- | --- |
| +00 | w | Direction of travel | angle | CD; DT (fields agent) | high |
| +02 | w | Pitch. Kept only in physics mode; otherwise the game derives it (image 0x14F5) | angle | DT: our derived pitch equals +02 in 2,200/2,200 physics-mode samples | high |
| +04 | dd | Time gap to the car in front; 8000:0000 = invalid | ms | CD. Valid in only 535 of 10,140 samples; not checked against the screen | low |
| +08 | w | Height Z. Kept only in physics mode | Z units | DT: derived Z equals +08 in all 5,726 player frames | high |
| +0A | w | Lateral offset from the segment centre line, + = right of travel | fine, signed | DT: enters the position formula, which matches the game exactly | high |
| +0E | w | Racing-line offset at the car | fine | DT (fields agent: corr 0.995 with segment +16) | high |
| +10 | w | Speed. Live for every car | 1/64 ft/s | DT: dash mph within 0–4 frames of display lag, 635/636 (player) and 663/664 (computer cars) | high |
| +12 / +14 | w / w | Far pointer (offset, segment) to the current segment entry, in the track array or the pit array | pointer | DT | high |
| +16 | w | Length of the segment at the car's lateral offset: 400h − (seg+14 · lat · 4 >> 16) | fine | DT (fields agent) | high |
| +18 | b | Flags: 40h braking (computer car), 80h and 10h in the pit lane | bits | DT (fields agent) | medium |
| +1A | w | Heading (the way the car points). Live for every car | angle | DT | high |
| +1C | w | Distance into the segment, along the car's line, about 0–400h | fine | DT | high |
| +1E | w | Fraction of the segment done, 0–4000h. Used to interpolate Z | 1/16384 | DT: exact in the Z formula | high (use), medium (exact definition in corners) |
| +22 | b | Lap counter. 0 on the grid; +1 at every start/finish crossing, including the first one after the start (Monza's grid is before the line). The dash "LAP n" shows it | count | DT: dash 597/597; every crossing in both runs coincides with the segment index wrapping 1188→0, except cars in the pit lane, where it increments in the pit lane | high |
| +23 | b | Flags: 20h in the pit lane, 80h pitting (set before pit entry) | bits | CD; DT (fields agent; coast run) | high (20h), medium (80h) |
| +24 | b | Gear (0 = N, 1–6, FFh = reverse). Kept only in physics mode | enum | DT | high |
| +25 | b | Team | index | CD | medium |
| +28 / +2C | dd / dd | World X / Y. **Valid only in physics mode**; otherwise stale, often thousands of feet away | world units | DT: player and physics-mode cars match the derived position within 0.17 ft; computer cars in track mode are stale by a median of 2,500–2,850 ft (fields agent) | high |
| +3C | b | 80h on the grid, cleared after the start. Bit 10h ("retired" in GPDEF.INC) was never set, even on retired cars | bits | DT: all dumps; 5 retirements | medium |
| +40 | dd | Last lap time. Flags: 10000000h = none yet, 40000000h = the partial lap from the grid to the first crossing | ms of DS:294F | DT: dash LAPTIME equals it in 39/39 readings; it equals the difference of successive +54 values | high |
| +54 | dd | Session time (DS:294F) at which the current lap started, interpolated within the frame. C0000000h on the grid | ms | DT: it lies within one frame before the crossing frame; in 3 crossings it equalled timer(previous frame) − along/(2·speed) to within 1–2 ms, but the reason for the factor 2 is unknown | high (meaning) |
| +5E | b | Flags: 20h on the player's car at the start; 72h/F2h/FAh on retired cars (bit 10h set) | bits | DT: 5 retirements | low |
| +62 | w | Engine RPM. Kept only in physics mode | rpm | DT | high |
| +66 | b | Index in race order (used by Up/Down) | index | CD; DT (camera agent) | medium |
| +67 | b | Pit-stop state: 0 on track, 1 in the pit lane, 2 on the jacks (speed set to 0), … 9 | enum | DT: values 0–9 seen on the 4 cars that pitted in the coast run; meanings from CD (GPDEF.INC) | medium |
| +7E | b | Bit 01 = physics mode (world X/Y integrated). Bit 04 = computer driver. The player has 01 (with E0h trouble bits sometimes); computer cars have 04, and 05 or similar briefly within about 10–30 ft of another car, and after a crash or retirement | bits | SC image 0x5CBC, 0x1142/0x119A; DT | high |
| +8C | w | Height above the track (added to the interpolated segment Z) | Z units | DT: exact in the Z formula | high |
| +96 | b | Bit 20h = no driver in the car: retired in a race, parked in the garage in practice. So "retired" holds only in races. Bit 80h = car not drawn (practice garages, and 2 of 4 retired cars). Bit 40h was set when DS:28FD was cleared | bits | DT: set at the very frame the runner count dropped, for all 5 retirements; A0h on garage cars in 16 practice dumps; CD (GP_SI) | high (20h), medium (80h) |
| +AA | b | Race position × 2 (leader = 0). **Races only**: in free practice the values are not a permutation | count | DT: dash POS 636/636 (player), 664/664 (computer cars), 1,060/1,060 over three races | high (races) |
| +AC | b | Car ID: & 3Fh = car number; 80h = the player's car; 40h = player car driven by the computer | bits | DT: dash CAR 636/636; CD | high |
| +AE | dd | Best lap; 20000000h = none yet | ms | DT | medium |
| +B2 | b | Tyre compound (4 = Q, 5 = W according to the game code; the community docs disagree) | enum | CD | medium |

Unknown or unverified (see `spike/out/research-phase1/docs/car-record.md`
for the community names): +0C, +20, +26, +80, +84, +88 and the meaning of
most flag bits.

**Outside races** the game reuses the 26 records: in free practice one
driver appeared in two records (#18 in slots 11 and 16), and parked cars
carry +96 bit 20h. Skip records with +96 bit 80h, and treat race position,
runners and "retired" as race-only (DT, verifier).

## Track segment arrays

| Address | Meaning | Evidence | Conf. |
| --- | --- | --- | --- |
| DS:879F word / DS:87A1 word | Track segment array: offset of the first entry (0030h) / segment value (4263h in our runs) | SC; DT | high |
| DS:8797 word / DS:8799 word | Pit-lane array: offset (D7AEh) / segment value (326Ch) | SC; DT | high |
| SS:015C word | Offset of the entry after the lap. Segments per lap = (SS:015C − DS:879F)/2Eh; 1,189 at Monza. The entry at SS:015C is a copy of segment 0 | DT | high |

Each entry is 2Eh bytes, one per 16 ft segment:

| Off | Meaning | Units | Evidence | Conf. |
| --- | --- | --- | --- | --- |
| +00 | Heading at the middle of the segment | angle | DT: equal to the track-file walk on all 16 circuits | high |
| +02 | Pitch | angle | DT | high |
| +04 / +08 | X / Y, upper bits. X = (s16(+04) << 3) \| (+21 & 7); Y = (s16(+08) << 3) \| (+21 >> 4) | 1/8 ft (fine after combining) | DT | high |
| +06 | Z | Z units | DT | high |
| +0C / +0E | Half-width vector X / Y in bits 6–15 (1/8 ft). Right edge = centre + 8·(sx, −sy) fine. Bits 0–5 of +0C = half-width >> 5 | mixed | DT (track agent) | high |
| +14 | Heading change term, used for the along correction in corners | — | SC 0x1544; DT (exact formula) | high |
| +16 / +18 | Racing line offset / angle | fine / angle | CD; DT (fields agent) | medium |
| +1A | Segment number. Bits 0–11 = index: the track index, or for the pit lane the track index of the pit entry plus the pit index. 2000h = pit-lane entry. 8000h = TV camera here, 4000h = camera on the right. **1000h is a run-time flag**. It was set and later cleared on segments 93–95 under the player's car rolling at 6 mph (coast run, 54–59 s), and on segments 173–223 (24–32 s) and 541–543 (67–68 s) of the drive run, where at least one car was nearly stopped. Meaning unknown; it may mark an obstacle | bits | DT | high (index, 2000h); medium (cameras, track agent); low (1000h) |
| +21 | Fine bits of X (0–2) and Y (4–6) | — | DT | high |

**Pit lane.** Computer cars that pit switch their +14 to the pit array (326Ch)
and move along entries numbered 2000h + 1107 … 2000h + 1267 at Monza. They
leave track segment 1106 and rejoin at track segment 79. Their positions
stay continuous. The only outliers are the frames where the car stops on the
jacks (DT, coast run: 4 cars).

**TV cameras.** Which segments carry a camera (+1A bit 8000h, about every
16th segment, including segment 0) is confirmed. Where each camera stands is
not: positions predicted from the track file's camera definitions (4 ft
outside the edge) were 0.1–41 m from the game's actual camera (DT, accuracy
agent). Read the camera from DS:2259/225D at run time.

**Practice sessions.** With the player in the pit garage, the game splices
the pit lane into the track array and moves the bypassed track into the pit
array (DT, track agent: 16 dumps). So look segments up by number, not by
address. `readTrack()` does.

## How world positions are obtained

The game keeps two kinds of car (SC, image 0x5CBC):

- **Physics mode** (+7E bit 01 set). This is the player's car always, and
  computer cars briefly in close quarters, in crashes and after retiring.
  The game integrates world X/Y (+28/+2C) every frame from the velocity
  (image 0xA519/0xA538), and finds the segment the point is in.
- **Track mode** (+7E bit 01 clear). This is normal for computer cars. The
  game only advances +12/+14 (segment), +1C (along) and +0A (lateral).
  +28/+2C are written only on special events: contact, pit junctions,
  switching to physics mode.

The renderer gets every car's pose from image 0x14A2:

- If +7E bit 01 is set, it copies +28/+2C, +08 and +02.
- Otherwise it computes them from the segment the car points at. We do the
  same integer arithmetic, in `derivePose()` in lib/f1gp-state.mjs.

The formula, with seg = the entry at +14:+12 and a = seg+00:

```text
along = car+1C − hiword(seg+14 · car+0A · 2)       (only if seg+14 ≠ 0)
c = cos(a), s = cos(4000h − a)                      (game cos, interpolated)
X19 = (s16(seg+04) << 3 | seg+21 & 7) + hiword((car+0A·c + along·s) << 2)
Y19 = (s16(seg+08) << 3 | seg+21 >> 4) + hiword((along·c − car+0A·s) << 2)
world X, Y = X19 << 8, Y19 << 8                     (32-bit)
Z = seg+06 + hiword((next.seg+06 − seg+06) · car+1E << 2) + car+8C
pitch = hiword(seg+02 · costable[|car+1A − a| >> 3] << 2)
```

Here `hiword(v << 2)` is the signed high 16 bits of the 32-bit value v << 2,
that is v >> 14. The cos routine (image 0x03C8) interpolates the table at
SS:3264 in 1/8 steps.

The evidence that this is exactly where the game draws every car:

- **The camera agrees.** In cockpit view the game's own camera position
  (DS:2259/225D, computed by the game from the same routine) equalled our
  position for the viewed car in all 5,311 cockpit frames, with 0 units of
  error. 2,683 of those frames rode in 15 different computer cars in track
  mode. (DT, drive and coast runs; test "the game camera in cockpit view…".)
- **The formula reproduces the player's live position.** Applied to the
  player's track fields, it is within median 4.3 and at most 11.1 fine units
  (0.17 ft) of the live X/Y over 2,918 frames. Z equals the live value in
  every frame, and pitch equals +02 in all physics-mode samples.
- **Every car moves continuously at its speed.** Over 132,228 car-frame
  steps, the displacement per frame over speed × dt has median 1.000. 99.66%
  of steps are within 0.8–1.25; the rest are contacts and pit stops.
- **The track model agrees.** The segments `readTrack()` reads equal
  lib/track-file.mjs `trackOutline()` exactly, on all 16 circuits. Placing
  cars on the track-file segments with a straight step lands within 0.6 m.

The track file is not needed at run time: the segment array in memory is the
game's own data. It also follows the pit-lane splice.

## Reading cost

| Where | readState (26 cars) | readTrack | attach |
| --- | --- | --- | --- |
| Node, live heap | 4–9 µs back to back; first read after a new frame median 7 µs, p95 15 µs | 0.3 ms | 32–35 ms |
| Chromium, direct mode | 8 µs back to back (5.8 µs with crossCheck) | — | 28 ms |
| Node, from a RAM dump | 12–15 µs (cold) | 1.3 ms (cold) | 0.5–1.2 ms |

## Open questions

- Z units (assumed 1/64 ft) are not verified.
- The meaning of segment +1A bit 1000h.
- Car +20, +26, +80, +84 and +88, most flag bits, and the gap +04.
- Why +54 (lap start) equals timer − along/(2·speed), and where the
  per-circuit timer factors DS:0214/DS:0220 come from.
- Whole races were checked at 2× speed (`p1-accuracy/race{1,2,3}`) and
  once at real speed after the consistency fix
  (`p1-accuracy/race-realtime`: 5,567/5,567 frames read consistently, dash
  speed 465/465, lap and position 408/408, finishing order 26/26).
- Live runs cover races at Monza and Silverstone and practice at Monaco,
  the Hungaroring and Suzuka. Qualifying, wet races, replays in depth and
  builds other than European 1.05 are not covered.
- No reliable consistency marker outside races (see above).
- `settled` could be wrong when the previous frame's work took 0–1 ticks
  (a much faster guest). It was never wrong at 25,000 cycles.
