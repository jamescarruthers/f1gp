# F1GP 1.05 renderer notes: the track and its surroundings

This page describes what the game's 3D scene renderer (`lcall 0F47:81CE`,
once per frame) draws for the track and its surroundings, and how, so that a
new WebGL renderer can draw the same scene. It covers the order of drawing,
which segments are drawn, the cross-section of each segment, the polygons and
their colours, the sky, the horizon image, the ground, trackside objects,
hidden surfaces and the palette. Cars are only touched on where they share
the same machinery.

It covers the European build of `gp.exe` 1.05 only. The working files (RAM
captures, listings, scripts) are in `spike/out/research-phase2/static/`,
which git ignores.

## Conventions

Addresses and evidence codes follow `docs/memory-map.md`. In addition:

- **R:XXXX** is offset XXXX in the renderer's data segment, image segment
  30CA (SS:00F4 holds it; absolute 326Ch in our runs). The renderer sets
  `mov ds, ss:[0F4h]`, so a plain `[X]` inside 0F47 code is usually R:X. It
  reaches the game DS through SS:00F0. Low R offsets hold constant tables
  that are in the EXE image; some are patched at track load.
- **seg+NN** is byte NN of a 2Eh-byte track segment entry (the array at
  DS:879F). The camera's segment is the far pointer DS:096F.
- **Units.** Segment X/Y (+04/+08) are in 1/8 ft; Z (+06) is in 1/64 ft (the
  projection scales Z by SS:017C, which gives the right aspect for this unit).
  "Half-width vector" h = (seg+0C >> 6, seg+0E >> 6), in 1/8 ft; the right
  side of the track is (+h.x, −h.y). Angles: 10000h = one turn.
- **SC** = static code read; **DT** = dynamic test. DT runs are Monza Quick
  Races (25,000 cycles), with the game paused (P) before each capture so that
  the renderer's workspace in RAM belongs to the frame on screen; the runs are
  listed at the end.

## 1. One frame (0F47:81CE)

| Step | Routine | What it does | Evidence |
| --- | --- | --- | --- |
| 1 | 8261 | Temporarily patches two bytes (+24, +52) of the viewed car's shape record; 82CC restores them at the end. Purpose unknown. | SC |
| 2 | 18E1 | SS:01AF = colour 12h (grass), SS:01AE = colour 1Ah (road). When wet (SS:122E ≠ 0) and SS:0184 > 0 both go through a darkening table (7BCE:7BC0, level SS:0184 − 1). | SC |
| 3 | A783 | SS:01B4 = 1C0h when the viewed car is in the pit lane and well off its centre line. | SC |
| 4 | 49C0 | Sets R:00FA, the "road drawn as a polygon" mode (section 5). | SC |
| 5 | A533 | Cars near the camera, in race order: finds each car's segment (track or pit array) and puts the car into the per-segment object lists. | SC |
| 6 | 3B32 | **The segment walk**: chooses segments, computes each cross-section's points and projects them (sections 2 and 3). | SC, DT |
| 7 | 4A03 | Splits the walked segments into "blocks" at hill crests; finds the top row of the far road. | SC |
| 8 | 72BE | **Sky gradient, horizon image, far ground** (section 5). | SC, DT |
| 9 | 4C12 | Turns projected points into clipped screen edges (section 7). | SC |
| 10 | 802A | **Draws** block by block, far to near: a road-coloured row band, then 5470 (white lines, road markings, grass) and 6425 (fences, kerbs, objects, cars) for the block's segments. Then the remaining objects (541B), then the ground texture (7F64, when the T option is on), then cockpit parts. | SC, DT |
| 11 | A737, 82CC | Tidy-up. | SC |

Between steps the renderer calls `lcall 19ED:008C`, the same service the main
loop calls; it is not part of drawing.

The renderer draws into the back buffer at 50BA (the far pointer R:001C, used
by the sky and horizon routines, held 50BA:0000 in our dumps; 19ED:31FA copies
the buffer to A000). The 3D view is 320×164 and appears at screen rows 16–179
in external views and from row 0 in the cockpit (see the memory map). How the
16-row offset is applied was not traced.

## 2. Which segments are drawn

### Direction and distance

- The walk starts at the camera's segment (DS:096F). If the camera faces more
  than 90° away from that segment's heading, SS:0136 = 8000h and everything
  runs in reverse (camera code at 0:76DB). SC; DT (a TV view had SS:0136 =
  8000h).
- **Distance ahead** comes from segment byte +20, which packs two numbers by
  parity of the segment number (+1A): on even segments +20 is the forward view
  distance in segments, on odd segments it is the backward one. Forward:
  n = seg+20 if the camera segment is even, else (next segment)+20 + 1.
  Reverse: the reference is the next segment; n = its +20 if it is odd, else
  (the one after)+20 − 1. SC 0F47:3C7A, 4337; DT: the forward rule held in
  22 of 22 captures (n from 39 to 189 at Monza), the reverse rule in the one
  reverse capture.
- The walk goes **from the far end towards the camera**, one segment
  (2Eh bytes) at a time, wrapping through the sentinel entries at the ends of
  the array. A counter R:0066 starts at 400h and drops by 1 per segment;
  R:0068 is its value at the camera's segment, so (counter − R:0068) =
  segments ahead. SC; DT (records matched segments by this rule).
- It then continues **behind the camera**: always up to 9 segments; up to
  118 segments only in polygon mode (R:00FA). SC; DT (records at 1–9 segments
  behind in normal frames).

### Level of detail by distance

The bands are constants in the EXE (R:01C6–01E2, stored as segments × 2Eh):

| Segments ahead (±1) | Parts computed (bit mask) | Segment byte that marks where a cross-section is needed | Builder |
| --- | --- | --- | --- |
| more than 58 | road outer edges (300h) | +2B | 0F47:3181 |
| 26–58 | + fences (330h) | +0A | 0F47:2F7C |
| 10–25 | + kerbs and line inner edges (33Fh) | +2A | 0F47:2D12 |
| 0–9 | + two road markings (3FFh) | +27 (objects: +26) | 0F47:2A04 |
| 1–9 behind | all | | 3910 |
| 10–118 behind | bands 25 / 58 / 118 | | 37CE, polygon mode only |

The builders fall through: 2A04 computes everything, 3181 only the road
edges. SC.

Not every segment gets a cross-section. A segment can get one only if its
marker byte for the current band (masked by the band's parts) is non-zero, or
if the next-nearer segment's +0B flags one of those parts; in addition the
part must still be in the running set of active parts (R:0142, which the
walk updates as parts end). So distant straights are drawn with few, long
polygons, and parts begin and end exactly where the track data says. The
parts value of a marker byte b is ((b & 3) << 8) | b. Bit 7 of the marker
byte means "an object is in this segment". SC 0F47:343A, 354F, 3306. DT: in
21 captures every one of 280 cross-sections was at a segment flagged this
way; the running set was not modelled, so the flags alone over-predict.

Between cross-sections the road is a straight polygon, so on a hill it
follows the chord, not the segments' heights. Near the camera this shows: in
a TV view on the Imola hill (segment 757) no road-edge cross-section lies
between segment 746 (behind the camera) and 757, and the chord passes up to
101/64 ft (1.6 ft) from the true height; projected, the game's road edge sits
1–12 px lower on the screen than the true edge, most at the nearest segments.
A Magny-Cours hill frame shows the same (segments 653–661, up to 37/64 ft,
1–6 px). These are the two frames that were 4–5 px off in the alignment
check. Our renderer keeps the true heights. DT (`hillsegs.py`, `hillpx.py`
on RAM captures from `probes/p2-capture.cjs --ram`).

The colour rows also change with distance: kerbs and white lines use a "far"
row beyond 9 segments, a "near" row at 5–9 and a "nearest" row at 0–4. SC
0F47:367E; DT (all kerb records beyond 9 segments carried the plain white
code).

### What the walk stores

For each segment with a cross-section the walk writes a 16-byte record
(R:A13E onwards, end R:00FC) and a block of 18 projected points of 12 bytes
(R:4D2E + D8h per record). A point is {lateral, dz, depth, screen x, screen y,
outcode}, the output of the projection 0F47:20D9. SC; DT (decoded in every
capture).

### Rewritten

The walk, the cross-sections and the projection are rewritten in Rust and
exact (`spike/machine/src/r3d/`: `walk.rs`, `section.rs`, `track.rs`,
`point.rs`), checked call by call against the game's code in the 176 caught
frames and on made-up calls (`r3d calls`, `r3d fuzz`):

- **The walk** (3B32 to 49BF, its loops 343A to 3AAA, the pit lane's walk
  3AAB): bands from far to near (R:01E2, 01DE, 01DA, 01D6: the edges only,
  fences, kerbs, everything), each band's cross-sections by the builder entry
  it sets at R:0020 (3181, 2F7C, 2D12, 2A04), then behind the camera (R:01D2,
  and for the road drawn as polygons R:01CE, 01CA, 01C6). It writes the strip
  records at [bp+2C], object list entries at [bp+24] (R:0066 the segment's
  count, R:0064, ES:DI) and crests at [bp+28]. When the strip list fills
  (R:00EE) or the walk meets R:0124, the loops leave by resetting SP from
  R:0132 and going to the forward walk's tail (41CE), whichever way the walk
  was going; the reverse walk's copies of that code are never reached. Every
  walk in the caught frames and 3,000 made-up ones match; 96% of its code ran.
- **The cross-section** (2445 to 32C2, entered at 2A04, 2D12, 2F7C or 3181
  and run to its end) and its helpers: the raised fence top (2334), the
  crests (279E, 28D1, with the square root 0000:024E), the ground's profile
  points for the texture (78C1), the strip's colours (32C3), its edge flags
  (3306) and the ground's shade nibbles (226B). Every call matches.
- **The projection** (20D9, 20AB, 2168, with 1FAD for a column whose divide
  overflows): every call and 60,000 made-up ones match; every reachable
  instruction ran.

## 3. The cross-section

### Points

Each part is a pair of points (a, b) in the cross-section. With C = (seg+04,
seg+08, seg+06), h the half-width vector, w = (s8 seg+11, s8 seg+13), and
"C + k·v" meaning (X + k·v.x, Y − k·v.y) (positive k = right of travel):

| Part bit | Points | Position | Height |
| --- | --- | --- | --- |
| 002h | left road edge | C − h | seg Z |
| 001h | right road edge | C + h | seg Z |
| 200h | outside of the left white line | C − h − w | seg Z |
| 100h | outside of the right white line | C + h + w | seg Z |
| 008h | left kerb: inner b, outer a | inner C − h − 2w (3w if seg+26 bit 2); outer C − (h + ((h ≫ 3) + h) ≫ 2 + w), about 1.28 h + w | Z + kh |
| 004h | right kerb: inner a, outer b | mirror of the left | Z + kh |
| 020h | left fence: base a, top b | C − ((h + w)·(seg+28 + 32) ≫ 5) | base Z; top Z + R:018C[seg+0E & 7] |
| 010h | right fence | C + ((h + w)·(seg+29 + 32) ≫ 5) | top Z + R:018C[(seg+0E ≫ 3) & 7] |
| 080h | road marking A | a = C + hi16((h·(f ≪ 8)) ≪ 2), f = s8 seg+1C (about f/64 half-widths); b = a + w/2 | seg Z |
| 040h | road marking B | the same with f = s8 seg+1D | seg Z |

- w is a 1.25 ft step along the half-width direction (length 10 in 1/8 ft):
  DT, all 1,189 Monza segments.
- kh, the kerb height: 20h (0.5 ft); 14h (0.31 ft) on low kerbs (seg+26
  bit 2, set on sections with the lowKerb flag; their inner edge is also 3w
  out instead of 2w); 0 where seg+0A has bit 3 (left kerb) or bit 2 (right
  kerb). The loader sets those two bits on the first and last segment of each
  kerb, so a kerb ramps up from road level and back down. DT (Monza segment
  array: the bits fall where kerb sections begin and end, e.g. the left kerb
  of segments 190–197; seg+26 bit 2 on the lowKerb sections at 205 and 231).
- R:018C holds 8 fence heights in Z units, filled at run time (3 ft to 48 ft
  at Monza).
- seg+28 / seg+29 are the left / right verge widths: the fence stands at
  (1 + v/32) × (half-width + 1.25 ft) from the centre line.
- Markings with seg+1F bit 80h (A) / 40h (B) are wide or special shapes
  (0F47:2A0F): see "Road markings" below. SC; DT.
- Fence points with seg+1F bit 20h / 10h at the four pit-lane junction
  segments are taken from the pit-lane array (0F47:2445). SC only.
- "Bridged" fences: seg+26 bit 20h (left) / 10h (right) is set on sections
  with the bridgeLeftFence / bridgeRightFence flags (DT, Monza segments
  190–216). There seg+28 / seg+29 count segments to the two ends of the run
  (packed by parity like +20), and 0F47:25D3 places the fence on the straight
  line between the fence points at the two ends, so the fence cuts across the
  bend instead of following it. SC, medium confidence.

Evidence: SC (builders 0F47:2A04–32C2, projection 0F47:20D9, fence top
0F47:2334). DT: recomputing every point from the segment array and the camera
with these formulas and the game's projection reproduced the renderer's
stored points exactly: **3,657 of 3,664 points in 32 captures, all 16 point
types**. The 7 misses are all in the first (far-end) record, whose slots hold
stale data. Script: `xcheck.py`.

The points are computed at the segment's start position. The renderer does
not use the fine bits (seg+21) or any banking: the cross-section is flat
across, except the kerbs (raised) and the fences (vertical).

### Polygons and colours

Polygons run along the track between consecutive cross-sections and are
closed where the colour changes. A "lateral" edge across a part is made only
where the record's flag byte has that part's bit; the flag byte is seg+22
(per part), so seg+22 marks where stripes and other parts start and end. The
13 polygon kinds (0F47:5470 and 0F47:6425; SC):

| Polygon | Between | Colour (palette index) | Haze |
| --- | --- | --- | --- |
| Road | 200h and 100h | SS:01AE (1Ah). Drawn as a polygon only in polygon mode; normally the road is the background band (section 5). | no |
| Left / right white line | 200h–2h / 1h–100h | Nibbles of a pair from R:0258 (below) | yes |
| Marking A / B | its a–b | R:0230[low / high nibble of seg+25] | yes |
| Left / right grass | 200h → left screen edge / 100h → right screen edge | SS:01AF (12h) | no |
| Left / right fence | base–top | R:0220[low / high nibble of seg+24] | yes |
| Left / right kerb top | a–b | R:0248[low nibble of the stripe code] | yes |
| Left / right kerb inner face | kerb inner point – line outer point | R:0248[high nibble of the stripe code] | yes |

- **White lines.** R:0258 holds three triples of colour pairs (far, near,
  nearest); the low nibble colours the left line and the high nibble the right
  line, and the nibble is a palette index from 8 to Eh (white to grey). The
  triple depends on the camera's lateral offset SS:0150 (= camera object +0A):
  within ±200h both lines get the same greys; further left or right, the far
  line is drawn one step darker. SC 0F47:3BF9, 32C3.
- **Kerbs.** The stripe code = R:0208[seg+23 + row], with row 0 (beyond
  9 segments: plain white), 8 (5–9) or 10h (0–4). seg+23 is the stripe number:
  the track loader advances it by one per segment through the header's kerb
  colour list and sets the seg+22 kerb bits where the colour changes
  (8EAA:16D2). So stripes are one segment (16 ft) long; at Monza, whose list
  is white, red, white, a kerb shows one red segment then two white ones (DT,
  segment array). At track load
  8EAA:1663 fills R:0210–021F from the header's kerb colour list (count at
  header+18, then 16-bit words): colour 8 becomes white with near/far variants,
  any other entry takes two words, c1 | c2 << 4. Each nibble is a kerb colour
  code; R:0248 maps the 16 codes to palette indices. SC; DT (below).
- **Fences and markings.** The loader stores per-segment colour codes in
  seg+24 (fences: low nibble left, high nibble right; 8EAA:0F23) and seg+25
  (markings). R:0220 and R:0230 map the codes to palette indices. At Monza
  marking A is a darker asphalt strip (18h, 19h) on 524 of the 1,189
  segments; marking B is what the game writes for the best-line aid (see
  "Road markings").
- **Haze** (0F47:188A). Lines, markings, fences and kerbs get distance haze;
  grass and road do not. Dry: level = clamp((d − 10) ≫ 3, 0, 4), where d is
  the number of segments ahead (raised to a per-part minimum of 1 to 5); if
  level > 0 the colour becomes table[level − 1][colour], four 256-byte tables at
  7BCE:7BC0 built at run time (they are not in the EXE image). Each table maps
  a colour to a lighter, greyer shade; for example the kerb red 3Dh becomes
  A4h, A5h, A6h, A7h. So haze starts 18 segments (288 ft) ahead. Wet: the
  level comes from d and SS:0182 instead. SC; DT (the tables in RAM).

DT for the colour sources: in one run we overwrote, in memory, the kerb table
R:0248, the fence table R:0220, the line table R:0258 and the marking table
R:0230 with single colours. In the next frames the kerbs (tops and faces),
both fences, both white edge lines and the dashed centre line took exactly
those colours (`cap/s4`).

### The rest of the segment entry, as the renderer reads it

| Field | Use in drawing | Evidence |
| --- | --- | --- |
| +00 | Heading: object yaw base, heading checks | SC |
| +02 | Pitch: only for special markings | SC |
| +04/+06/+08 | Centre X, Z, Y (no fine bits) | SC, DT |
| +0A | Cross-section marker byte for 26–58 segments ahead (bits 0–1 road edges, 4–5 fences, 7 object); bits 2–3 mark the first and last segment of the right / left kerb (kerb height 0 there) | SC, DT |
| +0B | Parts present from this segment on (for example a kerb's bit stays set for the kerb's length); the next-nearer segment's +0B is OR'd into the parts needed at a segment | SC, DT |
| +0C, +0E | Half-width vector (bits 6–15). +0C bits 0–5: half-width ≫ 5. +0E bits 0–2 / 3–5: left / right fence height index | SC, DT |
| +10 | Not read by the renderer | SC |
| +11, +13 | w, the 1.25 ft lateral step | SC, DT |
| +12 | Bit 10h (bit 20h when looking backwards): use polygon mode while the camera is in this segment | SC |
| +14, +16, +18 | Not used for the track drawing | SC |
| +1A | Segment number; bit 0 = parity for +20 | SC, DT |
| +1C, +1D | Lateral position of marking A / B | SC, DT |
| +1E | Object setting index for this segment (bit 7: a car or special object) | SC |
| +1F | Bits 80h/40h special marking shapes; 20h/10h junction fences; bit 2 object order near fences | SC |
| +20 | View distance (section 2) | SC, DT |
| +22 | Lateral edge flags per part (where polygons close) | SC |
| +23 | Kerb stripe number (0–2 at Monza, 4–6 on low kerbs; a new lateral edge only where the stripe colour changes) | SC, DT |
| +24, +25 | Fence and marking colour codes | SC, DT |
| +26 | Bit 7 object (near band); bit 6 object order; bits 4–5 bridged right / left fence; bit 3 horizon image off; bit 2 low kerb; bits 0–1 pit-lane flags | SC, DT (bit 2) |
| +27, +2A, +2B | Cross-section marker bytes for 0–9, 10–25 and beyond 58 segments ahead | SC, DT |
| +28, +29 | Left / right verge width (fence distance); on bridged fences, distances to the ends of the run | SC, DT |
| +2C, +2D | Not read by the renderer | SC |

All of these are built once at track load (seg 8EAA, from the track file's
sections and commands, see 8EAA:0698 for the command dispatch and 8EAA:0ED8
for the routines that set the marker bits) and stay in memory. A port can read
them from the segment array instead of rebuilding them from the track file.

### Road markings

Markings A and B are strips: from a segment's two points (a, b) to the next
segment's, drawn when the first segment's +0B has the marking's bit (80h A,
40h B). Each segment computes its points from its own +1C (A) or +1D (B),
f, and +1F (0F47:2A0F; `markingPoints` in scene.mjs):

| seg+1F bit | f | a | b | Colour |
| --- | --- | --- | --- | --- |
| clear | any | C + h·f/64 | a + w/2 | R:0230[code in +25] |
| set | not 7Ch–83h | C + h·f/32 | a + w | the same |
| set | 7Ch–83h: shape k = f − 7Ch | C + h·lat/32, moved along the track by h⟂·shift/32 and up by slope·pitch/65536 | a + h·width/32 | a strip starting at an odd k: R:0230[R:0240[depth]] |

h⟂ is (hy, hx) in the game's X, Y; pitch is seg+02. The shape tables are
shift R:00B6 (s8), lat R:00BE (s8), width R:00C6 (s8), slope R:00DE (s16).
They are filled per circuit: in the 17 practice dumps of the 16 circuits the
shifts and widths scale with the road's width, the left and right grid shapes
swap sides at some circuits, and shapes 6 and 7 sit at lat 82–84 or −114;
the slopes are the same everywhere. At Monza:

| k | shift | lat | width | slope | Monza |
| --- | --- | --- | --- | --- | --- |
| 0, 1 | −19, 0 | −32 | 64 | −5228, 0 | start line: segment 0 (k 1) to 1 (k 0), 47 ft across, 2 ft long |
| 2, 3 | −21, 0 | −25 | 14 | −5630, 0 | grid slots, left: k 3 to the next segment's k 2, 10.2 ft across, 0.7 ft long |
| 4, 5 | −10, 10 | 11 | 14 | −2815, 2815 | grid slots, right: k 5 to k 4, 10.2 ft across, 1.4 ft long |
| 6, 7 | 57, 102 | 82 | 32 | 7238, 12868 | not seen |

Two special points on neighbouring segments, moved along the track towards
each other, make a short strip across the road. 0F47:226B makes such a line
at least one screen row tall, and gives it a colour by depth: it writes code
R:0240[min(depth ≫ 7, 7)] (4, 5, 6, 7, Bh, Dh, Eh, Fh: white to grey through
R:0230) into the segment's +25 nibble each frame, for odd k when the walk
runs forward and even k when it runs backward. DT (`spike/probes/p4-gl-ram.mjs`:
our grid slots and start line fall on the game's in grid, chase and TV
captures; `spike/tests/markings.test.mjs`).

**The best line.** One of the game's driving aids is "Dotted 'Best Line'".
The aids are the bits of SS:1220 (memory map); DS:297D = SS:1220 & DS:2251
holds the ones in force. 0:053C rewrites marking B on every segment that has
it and is not a special shape: with the best-line bit (10h) set, f = racing
line offset (seg+16) × 64 / half-width ((seg+0C & 3Fh) ≪ 5), in colour code 8
(R:0230[8] = B7h, near white at Monza), so B's dashes (B is on every other
segment) follow the racing line; with it clear, f is random within ±62 and
the code is Ah or Ch (dark asphalt): blemishes. It runs when a session
starts (0:EB63, EC82) and when the aid's key toggles it (0:E3A0), so a
renderer must read marking B after that (`markingsKey` in scene.mjs). DT: in
a Monza capture with the aid on, all 668 such segments follow the rule.

## 4. Texture (T) and detail (D)

- **T** toggles SS:11A6 (0:E415, `xor byte [bp+11A6h], 80h`; DT: the byte
  flipped with each press). When it is set, after the whole scene the renderer
  runs 0F47:7F64, which perturbs the flat ground colours into speckles: road
  pixels become 18h–1Bh around 1Ah, grass 11h–13h around 12h (DT: pixel counts
  in the same view with T on and off). The pattern follows the camera's motion
  since the last frame: in the cockpit and chase views 7F64 moves it by the
  viewed car's speed (car+10h >> 11, clamped) and yaw rate (car+4Ah); TV views
  take another path (7C5A instead of 7D62).
  On screen it is faint streaks along the direction of travel. The pattern is
  decoded below (7F64 in Rust). `gl-track.mjs` lays a noise
  texture on the ground instead: along the track on the road (from the scene
  mesh's u, v), in world space on the grass (the ground pass meets each pixel's
  ray with the ground plane under the camera), in the same shades, with a
  finer grain on top; on the road about two pixels in three take a
  neighbouring shade (69 %, by the noise's distribution).
- **The texture pass (0F47:7F64)**, rewritten in `spike/machine/src/r3d/ground.rs`:
  - **Which pass:** TV views (DS:0981 80h or C0h), and views from another car
    facing more than 45° from the camera car's heading, take 7C5A; the rest
    take 7D62. SC, DT.
  - **Row tables (7988):** for each row from 163 up to the texture's top row
    (R:0140, no lower than the horizon row [bp+130], clamped to 8–103), the
    ground's distance (CS:73B1) and its sideways offset (CS:74F9), worked
    from the list of ground points at R:0644 to R:0642 (8 bytes each: height
    from the camera, distance, sideways, the row it reaches up to). A
    distance whose divide overflows is 7FFFh (the game's divide-error handler
    sets SS:00C0, below). SC, DT.
  - **The pattern** is 4,096 bytes at segment 7D70, four 2-bit texels a byte.
    A road (1Ah) or grass (12h) pixel gets the texel plus FEh (CS:764B) added:
    −2 to +1. SC, DT.
  - **TV views (7C5A):** a 64 × 64 tile laid on the ground, each texel 4 × 4
    units of the camera's position (SS:013C, SS:0140); each row is walked from
    the middle out along the camera's heading (SS:0154, SS:0156). SC, DT.
  - **Cockpit and chase views (7D62):** 128 rows of 32 laid along the view.
    A screen row's pattern row is its distance plus how far the camera has
    moved (CS:7396), its column its offset plus how far the camera has turned
    (CS:7394) plus the pixel's distance from the middle times the distance;
    both scaled down by the speed (|car+10h| >> 11, clamped to 3–8). The
    distance's step from the row below picks the texel's bits (up to 1, 7,
    15, 31: bits 0, 2, 4, 6); a row stepping further is left plain. Movement
    is the camera's change since the last frame turned into the view, a step
    of ±1 dropped. SC, DT.
  - **Checked:** the 176 caught frames' calls leave the same memory and
    registers as the game's, and the frames drawn with it are the same; 3,000
    made-up calls (views, headings, speeds, horizons and point lists at
    random), 1,836 of them through the divide-error handler, are the same
    too. Together they ran all 588 of its instructions.
- **Divide errors:** the game's handler (19ED:2602, the INT 0 vector) sets
  SS:00C0, steps over the DIV or IDIV and returns, so AX and DX stay as they
  were. The texture code relies on it; the ports do the same (`Mem::div`,
  `Mem::idiv`). SC, DT.
- **D** cycles DS:0068 through 3, 2, 1, 0 (0:DC94; DT). The renderer uses it
  only to drop trackside objects (0F47:9E2A), from bits of the object
  setting's byte +1: level 3 draws all; 2 skips bit 1; 1 skips bit 1 or bit 6;
  0 draws only objects with bit 2. The cockpit shows the level with two lamps
  (19ED:30D9). The track, kerbs, fences and LOD bands do not change. SC.

## 5. Ground, sky and horizon

Rows are viewport rows; SS:0130 is the horizon row.

- **Sky** (0F47:7271): from the sky base row upward, a band table at R:0076
  (constant in the EXE): 15 steps of 3 solid rows plus 1 row that alternates
  the two neighbouring colours pixel by pixel, from the light blue next to the
  horizon (EFh down to E8h, then 87h down to 81h), then 80h for the rest. The
  sky base is the horizon row minus 8 when the horizon image is drawn,
  otherwise the horizon row, and never below the top of the far road.
  SC; DT (table values, back buffer colours).
- **Horizon image** (19ED:39ED): the track file's first 4,096 bytes, kept at
  SS:66A2 as 8 rows of 512 palette indices. Drawn unscaled in the 8 rows just
  above the horizon row (clipped below by the far road's top row, R:0140).
  Screen column x shows image column ((camera yaw ≫ 5) + x) mod 512, so the
  image covers 90° and repeats four times around. Turning right scrolls it
  left. Not drawn when the camera's segment has +26 bit 3 (track command
  83h/84h). In the wet its rows are hazed. SC; DT (SS:66A2 equals the track
  file in every capture; the best-matching column offset equals the formula
  in 4 of 4 tested frames; parts of the image are covered by later polygons
  and objects).
- **Far ground** (0F47:72BE): from the horizon row down to the far road,
  filled with the grass colour SS:01AF, or with the road colour SS:01AE when
  the track header's "surrounding" byte has bit 7 (Phoenix, Montreal).
- **Road under and near the camera** (0F47:802A): for each block, the rows
  between the previous block's lowest row and this block's top row are filled
  with the road colour; the last block ends at row 164. Then the grass
  polygons are drawn from the road's outer line edges out to the screen
  sides, so the road shows through between them. SC.
- **Polygon mode** (R:00FA = 80h): used when the camera looks more than 45°
  away from the track direction, when the camera's segment has +12 bit 10h,
  with grey surroundings, or when the pit lane is spliced into the track
  array. Then the ground from the horizon to the bottom is one colour (grass,
  or road colour for grey surroundings), the road is drawn as a polygon, and no
  grass polygons are drawn. SC; DT (a TV view at 64° had the flag set).

## 6. Trackside objects

- **Which objects.** Segment byte +1E is an index into the object settings
  (16-byte records from the track file, far pointer DS:023A). Bit 7 in the
  band's marker byte (+26 in the nearest band) means "draw this segment's
  object at this distance". The walk pushes {counter, segment pointer} onto
  object lists; 0F47:53BF sorts two lists by distance. SC.
- **Placement** (0F47:9E2A), with s = the setting record:
  - X, Y (1/64 ft) = (seg+04, seg+08) ≪ 3 + right(h)·s16(s+04) ≫ 5, that is
    s+04 / 256 half-widths to the right (negative = left);
  - for shape ids 0, 2 and 3, also s16(s+08) / 256 half-widths along the track;
  - Z = seg+06 + s16(s+0C); yaw = seg+00 + s+06;
  - s+00 = shape id (index into the shape table at DS:358D, 4-byte far
    pointers: ids 0–16 are built into the game, 17 onwards come from the track
    file, relocated into DS);
  - s+08 for shape ids 1, 5 and 0Dh is a colour byte written into that shape
    before drawing (per-object colour); for ids from 4 up it overrides one
    scale value of the shape (low nibble = which, the rest / 2 = value);
  - s+02 and s+0E are passed to the shape drawer (s+0E is used as an angle);
    s+0A is not read here.
  SC.
- **Shapes** (0F47:88A5). The header is the track file's object-shape header
  with offsets turned into far pointers: +00 size (used for culling and a
  higher-precision mode near the camera), +02 scale values, +06 visibility
  point list then element list, +0A points (8 bytes; bit 15 of the first word
  marks a point defined relative to another point; otherwise the words index
  the scale values, rotated by the object's yaw), +0E vectors (point pairs),
  +12/+14 height adjustment, then from +16 a list of 10-byte LOD entries
  {maximum depth, mask of scale values used, angle shift, far pointer to the
  display list}. The display list has one sub-list per view direction
  ((object yaw − camera yaw) ≫ shift), i.e. a precomputed drawing order. An
  element whose first byte has bit 7 clear is a filled polygon in that palette
  colour, made of vectors (a negative index reverses one); bit 7 with 20h is a
  line; other bit-7 elements are bitmaps drawn at a projected point and scaled
  with distance (0F47:19E8), some with frames chosen by view angle. SC only,
  medium confidence; the scale-table layout and element encoding need more
  work.
- **Order.** Objects are drawn during the fence/kerb pass, between segments,
  far to near, and the rest after the scene. R:006A–0070 track the nearest
  fence base on each side so that objects behind a fence keep their order
  (0F47:518A). Cars go through the same lists (0F47:A07D). SC.

## 7. Drawing order, hidden surfaces and clipping

- **Painter's algorithm, no depth buffer.** Far to near by segment. Within a
  block, all ground-level polygons (white lines, markings, grass) are drawn
  first, then fences, kerbs, objects and cars. A block is a run of segments
  between hill crests (0F47:279E/28D1 start a new one when the road reappears
  below a crest), so a crest hides what lies beyond it. SC.
- **Near plane:** depth < 8 (1 ft). The projection sets outcode 10h plus the
  side bits instead of projecting such a point. An edge with both ends behind
  is dropped; with one end behind, 0F47:00CA cuts it at depth 8 and projects
  the cut point. SC.
- **Screen clipping:** outcodes 8/4 (x < 0 / x ≥ 320) and 2/1 (y < 0 /
  y ≥ 164) from 20D9; edges are rasterised into per-row x lists
  (R:B458–D58C) clipped to the viewport rows, and spans are clipped to x
  0–319 by the span filler 0F47:0999. Polygons are flat-coloured. SC.
- **Projection:** as in `docs/memory-map.md`; the renderer's points use the
  segment start position. For an object within 3E80h fine units (250 ft) of
  the camera in X and Y (counting its size), the shape drawer sets R:02A4
  bit 15 and works with 8× finer coordinates; 20D9 then shifts dz 3 bits
  more. SC.

### The polygon filler (0F47:0999)

A far routine (callers `push cs; call 0999`, 27 places), studied on our PC: each call caught with
the state before it and the pixels it writes, found by running it alone on two backgrounds
(`spike/machine/src/bin/r3d.rs`, modes `fills` and `dumpfills`; 4,212 calls in 58 Monza frames).

- **Its input** is a list of 4-byte entries from R:0010 up to R:000C: a flags word and a pointer to
  an edge record. R:0640 is the mode, R:02F4 the colour. DT.
- **An edge record** (at R:B458 and on) is the edge's first and last rows (the first is the lower
  row, the larger y; the last row is drawn, the first is not), its x at each end, then the x of
  each row it covers, from the first row less one up to the last, ending with 8000h. So the edge
  rasteriser rounds each row's x before the filler runs; the filler does no arithmetic on edges. DT.
- **The fill:** from the polygon's lowest vertex up, each row from the left side's x (drawn) to
  the right side's x (not drawn), in the colour (R:0048, the colour twice). The left side walks the
  ring forward (R:000C, its entry's flags in R:0014), the right side backward (R:0010, R:0018);
  an entry flagged 40h runs its edge the other way. R:063C counts the ring's bytes still to walk;
  a side's next edge must start on the row where the last ended, or the polygon is done. DT.
- **The screen's edges.** Where the polygon runs along the screen's edge a side has no edge for
  some rows; the filler then reads a border list in place of an edge's x list: R:04A8 ends a list
  of 0s (the left border), R:063A a list of 320s (the right), entered at the row the border part
  starts. Entry flags 10h and 20h mark an edge ending on a border; the mode R:0640 allows the
  rest (1: start from the bottom row, 164; 2 and 8: a border list from the top, row 0, for the
  right and the left side; 4: the right border from the bottom row). R:063E notes which side is on
  a border list (80h left, 40h right). SC, DT.
- **The cockpit's window.** Rows below SS:0132 (row 103 in the cockpit view) are drawn through the
  window's row tables at SS:6364, indexed by row − 103: the row's offset in the back buffer (0:
  hidden), its left and right limits (+1F2h, +298h) and the gap between its two openings (+0A6h,
  +14Ch). SC, DT.
- **The crowd.** Colour 1Bh is the crowd: in a race (SS:124A ≠ 0) each row copies pixels from the
  crowd strip (the far pointer R:0004, or R:0000 when SS:0185 is negative), starting at the last
  row's end plus a step from the 64-byte table R:02B4, wrapped at 200h; otherwise colour 0Ah. SC, DT.
- **Mode 0** walks the ring without border lists or the checks above. SC.
- **Rewritten:** `spike/machine/src/r3d/fill.rs` does the same, checked call by call against the
  game's: 11,925 calls in 176 frames at Monza (race), Monaco and Germany (practice) leave the same
  memory and registers, and the 176 frames drawn with it in place of the game's are byte for
  byte the same. 84% of the routine's instructions ran in those frames; the rest are its error
  exits and mirror cases, and one crowd case (the strip at R:0000) no frame reached.

### The edge code (0F47:0000–0998)

Near routines that write the edge records the filler reads: 03E9, the edge builder (28 calls in
the shape and road code), and 02E4, the border edge (2 calls). Each takes a 4-byte slot of the
polygon's ring (at DI + AX), writes its record at R:02AA and moves R:02AA past it, and leaves the
registers as they were (PUSHA, POPA).

- **A point** is a record in R at [bp+30] plus an offset: its screen x and y at +0 and +2, its
  outcode at +4, and just before it its camera-space x, y and depth (−6, −4, −2). Outcode bits: 1
  y ≥ 164, 2 y < 0, 4 x ≥ 320, 8 x < 0, 10h behind the near plane, 8000h the finer coordinates
  (R:02A4 bit 15, above). SC, DT.
- **Both ends on the screen:** the record runs from the lower end up; an edge given upper end
  first is flagged 40h. A flat edge (both ends on one row) is flagged 80h and gets no record, as
  does any edge once R:02AA reaches D58Ch. SC, DT.
- **Off the screen:** ends off the same side get their slot's flags from the table R:0264 (by the
  sides) and no record. Otherwise the slot takes bits from R:0274 (by the lower end's sides) and
  R:0284 (the upper's), and the edge is clipped: the lower end onto row 164 if it is below, the
  upper onto row 0 if it is above (after each, if both ends now lie off the same side, flags 81h
  or 84h, 82h or 88h, and no record), then each end onto x 0 or 320. A clip moves the other
  coordinate by the slope times the distance, worked in 16.16 with one DIV and one MUL and kept
  to the whole part; it always divides the longer of run and rise into the shorter, so the
  quotient fits. SC, DT.
- **One end behind the near plane:** 00CA cuts the edge at depth 8. t = (8 − depth) × 2¹⁴ /
  (the other end's depth − depth, at least 8), by IDIV; the cut's camera-space x and y are the
  end's plus t times the difference, times 32 (y a further 3 bits down unless both ends have the
  finer coordinates), halved together until both are under 7000h, then projected as the game's
  projection does: x + 160, and y = [bp+130] − (y × SS:017C × 2) / 65536. Where only one end has
  the finer coordinates, its x and depth are shifted down 3 bits to match the other's; if it is
  the end in front and then lies no further than depth 8, nothing is drawn and SS:[bp+BC] gets
  bit 80h. SC, DT.
- **The rows** (0856): a line from the lower end up, stepped with an error term that starts at
  NOT(longer ÷ 2). Steep: each row stores x, and the term gains the run, x stepping when it
  carries. Shallow: x steps each time, and a row's x is stored when the term (gaining the rise)
  carries. SC, DT.
- **The border edge** (02E4) writes a one-row record from x 0 (CX 8) or 320 to the point's x
  (clamped to the screen) on the point's row. The row is kept at R:0136 or below when the point
  is off the left or right, or when the segment record says so for that side (bit 80h of
  [si+6]; R:013E's sign picks the side). A point above the screen is first moved to row 0 (its
  outcode's bits 1 and 2 cleared, in the point itself). SC, DT.
- **0000**, called by 00CA when the cut lands on the screen, leaves the cut where it is: its loop
  subtracts the cut from its step vector instead of stepping the cut, five times. No race frame
  reached it. SC.
- **Rewritten:** `spike/machine/src/r3d/edge.rs`. In the same 176 frames, 43,146 edge-builder
  calls and 820 border-edge calls leave the same memory and registers as the game's
  (`r3d calls`), and the frames drawn with it and our filler in place of the game's are byte for
  byte the same (`r3d ours`). The races ran 84% of the edge code's instructions, so it was also
  run against the game's code on 20,000 made-up calls of each routine (random points, some flat
  or at 45°, some with outcodes that disagree with their coordinates; `r3d fuzz`): all the same,
  215 of them through the game's divide-error handler (section 4). Races and made-up calls together ran 824 of its 850
  instructions. Of the rest, 16 need 0000 with the cut exactly on the other end, 2 a 32-bit
  negation whose low word is 0, and 8 cannot run.

## 8. The palette

- The live 256-colour palette is the 768-byte buffer **SS:05DA** (6-bit RGB).
  It reaches the VGA through INT 10h AX=1012h with BX = 0 and ES:DX = SS:05DA:
  605A:A8F7 → A905 sends SS:1110 entries at a time, each after waiting for
  vertical retrace (8B6E:0842). 605A:A8E2 reads the DAC back into the buffer
  (AX=1017h). 605A:A96E fades it.
  SC; DT (read from RAM in all captures).
- Entries 00h–1Fh start from a constant block in the EXE (605A:32E9, copied by
  605A:A950). Track command 0ACh sets one colour per call (8EAA:0EA3 writes it
  to DS:31B3 + 3 × index): every circuit sets 1Ah (road), all but Phoenix and
  Montreal also set 12h (grass). Entries 10h–17h and 18h–1Fh are shade ramps
  around those two (the haze and texture shades); they differ per circuit
  (DT: 16 practice dumps; at Monza 12h and 1Ah equal the 0ACh values). The
  routine that builds the ramps was not found.
- For exact colours a port should read SS:05DA at run time and scale by
  255/63, and read the haze tables at 7BCE:7BC0 (4 × 256 bytes) rather than
  rebuild them.

## 9. What a WebGL renderer can take from this

Per frame, read the segment array, the camera (memory map), SS:05DA, and the
colour tables R:0208–0263 (they change per track). For each segment: build
the cross-section points above from its own fields; draw the road strip
between the two line outer edges in colour 1Ah, white lines, markings, kerbs
(top and inner face, per-stripe colours), fences (vertical quads from the base
line up by the height table) and a wide grass strip outward; use seg+22 to
know where stripes and parts start and end, and the marker bytes to know
where parts exist. Put the horizon image on a cylinder (512 columns per 90°)
just above the horizon, the sky gradient above it, and the objects from the
settings and shapes. The game's view distance (seg+20), its LOD bands and its
haze can be kept for a "classic" mode and dropped otherwise.

## Runs

All in `spike/out/research-phase2/static/cap/`, made by `cap.cjs` (Quick Race
at Monza, bundle `dist/p2-static-25000.jsdos`):

| Run | What |
| --- | --- |
| `s1` | Grid views, then rides in AI cars (no game pause; not used for exact checks) |
| `s2` | 19 captures, game paused before each: cockpit, chase and TV views at many points of the lap |
| `s3` | D pressed four times, T three times |
| `s4` | Colour tables overwritten in memory one after another |

## Open questions

- Wet weather: the levels SS:0182/SS:0184 and the rain darkening of 12h/1Ah.
- The pit-junction fences (0F47:2445) and the bridged fences (0F47:25D3) were
  not checked against frames.
- Why the start line is missing from some TV views (the near band's
  cross-section rule for the strip's second segment, probably).
- Walks with the camera in the pit-lane array, and the order of the behind
  bands in polygon mode.
- The crest blocks (0F47:279E, 28D1, 4A03) in detail.
- The shape format beyond the header: scale table layout, element encoding,
  bitmap ids; and the purpose of setting fields +02, +0A, +0E.
- What 0F47:8261 changes on the viewed car, and 0F47:A737.
- Where the per-circuit shade ramps 10h–1Fh are computed.

## Objects: shapes and placement (decoded)

This section completes section 6. It describes the trackside objects
(stands, pit buildings, bridges, gantries, boards, trees) as 0F47:9E2A
places them, 0F47:88A5 draws their shapes and 0F47:19E8 draws their bitmaps.
The code that reads them from memory and builds a WebGL mesh is
`spike/lib/objects.mjs`; the checks are `spike/probes/p2-objects-*.mjs` and
`spike/tests/objects.test.mjs`. Working files (listing extracts, captures,
comparison sheets) are in `spike/out/research-phase2/objects/`. It answers the
open question on the shape format and the setting fields +02, +0A and +0E.

Units: shape coordinates are fine units (1/64 ft), X to the object's right,
Y forward; Z is in Z units. "Depth" is camera depth in 1/8 ft unless stated.

### Which segments carry an object

- The track command 80h (8EAA:0857) writes the setting index to seg+1E and sets
  seg+26 bit 7. It also sets the "object" bit 7 of the band marker bytes +2A,
  +0A and +2B unless setting byte +1 has bit 3, 4 or 5: the object is then drawn
  only up to 9, 25 or 58 segments ahead. Setting +1 bit 7 sets seg+26 bit 6
  (drawing order, below); bit 0 sets seg+1F bit 2 (ordering against fences,
  0F47:518A). SC.
- One object per segment. Setting 0 and 1 are not shapes: where the walk meets
  them, 0F47:9C05 runs a second scene pass over the pit lane (junction tables at
  DS:01A8). Setting 2 is a flag marshal whose side comes from a run-time table
  (DS:0B9C, by segment number / 32). SC.
- seg+1E values of 80h and up are put there for one frame by 0F47:A533 and
  cleared by A737: each car near the camera takes the first segment at or after
  its own that has no object, so cars are sorted with the objects. Values from
  B4h are pit crews (settings 4 and 5, coloured by team, DS:356B). A RAM dump
  taken between frames shows no car marks. SC.
- Objects on pit-lane segments form a second set. The game draws them when its
  walk runs along the pit lane (camera in the pit lane; in practice the lane is
  spliced into the track array). The pit pass of 9C05 sets SS:0172, and 9E2A
  draws nothing while it is set, so from the track the pit-lane set is not
  drawn. SC; DT (pit-lane captures at Monza: the pit-side copy of the pit
  building, with its slightly different yaw, is the one on screen).
- Detail level DS:0068 drops objects by setting +1 bits 1, 6 and 2 (section 4).

### The object setting (16 bytes, far pointer DS:023A)

| Offset | Meaning | Evidence |
| --- | --- | --- |
| +00 | Shape id (DS:358D table index) | SC, DT |
| +01 | Flags: bits 3/4/5 distance limit, 1/6/2 detail levels, 7 draw later, 0 fence order | SC |
| +02 | Palette offset: the object's 16 colours are SS:2964 + this (+0 .. +15) | SC, DT |
| +04 | Lateral position, 1/256 half-width to the right | SC, DT |
| +06 | Yaw relative to the segment heading | SC, DT |
| +08 | Shapes 1, 0Dh, 5: a bitmap id written into the shape (DS:8042, 83E5, 8288). Shapes 4 and up: scale override. Shapes 0, 2, 3: offset along the track, 1/256 half-width | SC, DT |
| +0A | Drawing order: low byte (at least 2) − 2 plus (high byte & 3Fh) segments; high byte bit 7 also clamps against the camera (not decoded) | SC; DT (decal objects) |
| +0C | Height added to the segment's Z | SC, DT |
| +0E | Tilt angle: Z of each point += Y × sin(tilt) | SC |

**Placement**, integer arithmetic as in 0F47:9E2A (DT: object outlines match
the game's frames to within a pixel): X = s16(seg+04) × 8 + floor(hx × s+04 / 32),
Y = s16(seg+08) × 8 − floor(hy × s+04 / 32), with (hx, hy) = (seg+0C, seg+0E) ≫ 6
and no fine bits (seg+21); Z = seg+06 + s+0C; yaw = seg+00 + s+06.

**Scale override** (0F47:8C52), v = s+08: low nibble k = 0 moves the scale-value
pointer by v ≫ 3 bytes (another set of sizes); k > 0 stores (v & FFF0h) ≫ 1 as
scale value k − 1, in the shape itself. That store persists, so an object of the
same shape without an override takes whatever size was drawn last; five
circuits have such pairs. A port should apply each placement's override to its
own copy. SC.

### The shape

The table DS:358D holds far pointers into the game DS: ids 0–16 are built into
the game (0 is the car), 17 onwards are the track file's shapes. Header:

| Offset | Meaning |
| --- | --- |
| +00 | Size (fine units): culling, near-precision test, haze |
| +02, +06, +0A, +0E | Far pointers: scale values, element block, points, vectors |
| +12 | Z offset of the points |
| +14 | Z offset of the reference point used for culling, LOD and bitmap-only objects |
| +16 | LOD entries of 10 bytes until a maximum of 7FFFh: {maximum depth, mask, shift, far pointer to the display list} |

- **LOD.** The first entry whose maximum depth ≥ the object's depth is used.
  Mask bit 15 set: a polygon LOD; bits 14 … 0 select scale values, which are
  packed in order into a table (track shapes always use a prefix). Mask bit 15
  clear: a bitmap LOD (below). Track shapes have one polygon LOD; rows of trees
  (shapes with four tree bitmaps) switch to a bitmap LOD beyond 1500h (672 ft).
  SC, DT.
- **Points**, 8 bytes {X word, Y word, Z, partner}. A word 0 is 0; 2 + 2j is
  +v[j]; 34 + 2j is −v[j], where v is the packed table. If bit 15 of the X word
  is set, the point takes X and Y of point (word & 7FFFh) and keeps its own Z.
  World position: X_world = X + x·cos(yaw) + y·sin(yaw),
  Y_world = Y − x·sin(yaw) + y·cos(yaw), Z_world = Z + shape+12 + z +
  hi16(y·sin(tilt) ≪ 2); sines from the cosine table at SS:3264 without
  interpolation. The partner index nudges a point one pixel right when both
  project to the same column (thin poles), and serves the car's back-face test.
  SC; DT.
- **Vectors**: byte pairs (from, to); index 0 is unused so that a negative index
  can mean "reversed".
- **Element block**: first a visibility list (point indices, ended by a byte with
  bit 7); if all of them are behind, or all left, or all right of the screen,
  nothing is drawn. Then the elements:
  - *Polygon*: colour byte (bit 7 clear; bit 6 means one more byte follows the
    list: a point whose depth must not exceed its partner's, used on cars), then
    signed vector indices, then 0. The outline is the chain of vectors; a few
    polygons leave out an edge, which closes the outline. SC, DT.
  - *Pole* (first byte with bits 7 and 5): a colour byte the game ignores and a
    vector. Drawn as a one-pixel vertical line at the first point's column, from
    its row up to the second point, in palette colour 0 of the object. SC, DT.
  - *Bitmap* (bit 7, not 5): {type, point, maximum depth / 128, bitmap id}, plus a
    palette offset word when type bit 1 is set. Type bit 4: drawn only on cars
    with a driver. Type bit 2: never mirrored (with bit 3: always); otherwise
    mirrored when (object yaw − camera yaw + 4000h) has bit 15 (bit 3 inverts
    this). SC, DT.
- **Display list**: one sub-list per view sector, selected by
  word index a ≫ (shift + 1), where a = object yaw − camera yaw −
  atan((column − 160)/256) of the object's reference point (table SS:5268; the
  column offset is capped at 255; a point behind the camera counts as column 0
  or 320). A sub-list is a list of element offsets from the end of the
  visibility list, in drawing order, ended by a word with bit 15. Shapes use 1
  to 32 sectors (track shapes mostly 4). The lists leave out faces that cannot be seen from that
  direction, and some faces give way to a bitmap: a distance board shows only
  its painted bitmap from the front and its box from the sides. SC; DT.

### Drawing a shape (0F47:88A5)

```
a_rel = yaw - camera yaw;  project the reference point (Z + shape+14)
near = |dX| + size < 3E80h and |dY| + size < 3E80h  ->  work in 1/64 ft
LOD by the reference point's depth; bitmap LOD -> draw one bitmap, done
haze level from max(depth, size / 8); SS:2EE4[0..15] = haze(SS:2964[s+02 + k])
apply the scale override; rotate the packed scale values by a_rel (and tilt)
visibility list; sector from a_rel and the reference point's column
for each element of the sector's list, in order: polygon / pole / bitmap
```

- **Polygons are one-sided.** The span filler (0F47:0999) pairs left and right
  edges by their direction, so an outline that runs anticlockwise on the screen
  fills nothing. Every polygon is visible only from the side where its vector
  chain runs clockwise (screen y down). DT: with this rule the
  agreement at Phoenix rose from 79.6 % to 89.6 % (a building seen at its
  corner showed its far wall otherwise), and the end wall of the Monza pit
  building disappeared as in the game.
- **Colour**: element colour c (bit 6 cleared) → SS:2EE4[c], i.e. palette index
  SS:2964[s+02 + c], hazed for the object. Track shapes use c = 0–15. DT.
- **Crowd**: if the final colour is 1Bh (the haze tables leave it unchanged),
  the span filler fills the polygon, span by span from the bottom row, with
  pixels copied from a strip (far pointer R:0000, hazed copies at R:0004 +
  (level − 1) × 400h): span k starts at strip[(R:02B4[k & 63] + end of previous
  span) & 1FFh]. In practice sessions (SS:124A = 0) the stands are empty: colour
  0Ah. SC; DT (the pattern is visible in race frames; it depends on exact span
  lengths, so it is compared separately).
- **Projection quirk**: points project as for the track, but the row quotient
  q = (hi16(dz × SS:017C × 2) ≪ 5) / depth is rounded to nearest only when
  negative; when positive it is truncated (the game compares the quotient, not
  the remainder, with the depth). The column is truncated. DT: emulating this
  moved bitmap rows by one pixel in about half the cases and raised agreement
  in object areas on the Monza captures from about 93 % to 98 %. The track's points (0F47:20D9, same code
  at 2168) should follow the same rule.
- **Haze** (0F47:8801), dry: level = clamp(((clamp(d + 80h, 0, 3C00h) ≫ 8) −
  5) ≫ 3, 0, 4) with d = max(depth, size ≫ 3); colour c → table[level − 1][c]
  (7BCE:7BC0). So objects haze from 400 ft (25 segments), later than the
  track. Bitmaps use their own anchor depth (0F47:1931). SC; DT.

### Bitmaps (0F47:19E8)

- Store: segment SS:00F8, far pointers at +0238 (ids 0–E5h used). Header: +0
  size (bit 15: an alias to id low byte; bit 15 and 14: not drawn), +2 row
  table bytes (rows × 2), +4 column bound, +6 rows below the anchor, +8 row
  offsets. Row 0 is the bottom row. A row is a run list: a byte c (0 ends the
  row; bit 7: a start column follows, otherwise the run starts where the last
  ended), the start and end columns as signed bytes relative to the anchor
  column; colour (c & 7Eh)/2 − 2 indexes the object's 16 colours (palette
  offset s+02, or the element's word). SC; DT (all bitmaps decode: wheels,
  helmets, boards, flags and marshals, trees and rows of trees, palms, boats).
- Scale: s = min(size × 8192 / depth, 8000h) (so at most 4 pixels per bitmap
  pixel); column k starts at x0 + k·s/8192 (16.16 steps), mirrored bitmaps step
  the other way; rows are s × SS:017E / 65536 / 8192 pixels tall (ids AAh, ABh,
  AFh without the SS:017E factor), with row 0 ending `bottom` rows below the
  anchor's row. With the game's SS:017E = 2 × SS:017C, a bitmap pixel is size/32
  fine units wide and size/32 Z units tall. Drawn flat at the anchor's depth.
  SC; DT.
- **Drawing** (19E8 to 1FAC, with 1931 for the colours): the drawer works in
  the bitmaps' segment: 16 colour words at +0000, each bitmap column's
  screen x (clamped to 0–320) from +0020 for columns 0 to 127 and down from
  +0220 for −1 to −128, its variables at +0220–0237. Runs fill from the start
  column's x up to, not including, the end column's. Rows from SS:[bp+132]
  down are clipped to the cockpit's window (SS:6364, as the filler does), but
  a run that spans the window's gap keeps only its part left of the gap. In
  the mirror (SS:[bp+134] set) the rows go to screen rows 116–137 through the
  mirror's tables at SS:63DE; there, the loop that skips rows below row 137
  tests the low word of the bitmap row instead of its row number (a game
  bug, kept). SC, DT.
- **Haze** (1931): the level comes from the anchor's depth (SS:016C) plus
  80h, clamped to 0–3C00h: dry, its high byte less 5, shifted down 3,
  clamped to 0–4; wet (SS:122E), that depth times SS:0182, bits 15–22,
  clamped to 1–4. Level 0 uses the palette, levels 1–3 the haze tables at
  7D70:7BC0 (256 bytes a level); SS:0185 keeps the level less one. SC, DT.
- **Rewritten:** `spike/machine/src/r3d/bitmap.rs`. All 2,753 calls in the
  176 caught frames leave the same memory and registers as the game's, the
  frames are the same, and so are 20,000 made-up calls (`r3d fuzz`: random
  ids, depths, anchors, mirroring, window and mirror modes, scales and
  weather; 6,222 of them through the divide-error handler). They ran 619 of
  its 630 instructions; the arithmetic never reaches the other 11 (a fog
  level above 3, a zero row step, a negative start row).
- Bitmap LOD (mask bit 15 clear): the shift word with bit 15 is a fixed bitmap
  id (shape 5's id comes from s+08), mirrored by (a + 4000h) bit 15, with a
  including the column correction. Otherwise the mask holds flags (mode byte;
  1000h mirror negative angles; 400h, 800h, 200h fold or clamp angles beyond 90
  degrees) and the display-list pointer leads to frame entries {angle add, base
  id, shift}: id = ((a + add) ≫ shift) + base, or "use the polygon LOD" when the
  base has bit 15. Rows of trees seen from afar use frames DDh–E5h. SC; DT
  (the frames chosen match the game's frames).

### Drawing order between objects

Objects are drawn far to near with the walk's object lists (sorted by
0F47:53BF), interleaved with the fences and kerbs of each segment (section 7).
The sort key is the segment counter moved by the setting's +0A
(0F47:5233): farther by (high & 3Fh) + max(low, 2) − 2 segments, or nearer by
the same amount when seg+26 bit 6 is set. Long buildings carry a large value,
so that what stands near their far end is painted after them; window bands and
stripes are often separate objects painted over a building face in this way.
SC; DT (letting a later object win where two objects are at about the same
depth raised the 16-circuit agreement from 94.6 % to 95.4 %, most at Phoenix,
whose buildings carry their window bands this way).

### Cars (for Phase 3)

Shape 0 is the car: one polygon LOD up to depth 1A0h (52 ft), then a bitmap
LOD whose frames (ids B0h–DCh, the car seen from many angles) follow the view
angle, so distant cars are bitmaps. Its polygons use colour bit 6 (the
partner-depth test above).
Bitmaps: ids below 42h are the wheels, framed by the view angle and the
steering angle (car +48 via SS:016A); ids 42h–4Ah are the helmet, framed by the
view angle, in the driver's palette SS:2AA4 + (car number − 1) × 16; elements
with type bit 4 (the driver) are drawn only when the car is occupied. The car's
colours are the team palette SS:2964 + (team − 1) × 16 (car +25). 0F47:A07D
sets these up, takes the car's pose from 0:14A2 and draws it through the same
88A5 (call at A306). The camera's own car in the cockpit view takes a separate
path in 88A5 (8A09–8B9E). SC only.

### What a WebGL renderer can take from this

`spike/lib/objects.mjs` reads all of the above from the game's memory:
`readObjects` (placements, settings, shapes with their overrides and patches,
the 16-colour palettes, bitmaps, haze tables), `buildSectorMesh` (one-sided
triangles in the format of `scene.mjs`, wound counter-clockwise from the
visible side) with `frameObjects` (the per-frame choice of sector, bitmap frame
and LOD, and decal layers), `buildObjectMesh` (a static alternative without
sectors), `buildSpriteAtlas` and `spriteQuads` (camera-facing quads that a
fragment shader colours through the object palette), `readCrowd`,
`hazeLevel`, `spriteIdsUsed` and `cameraInPitLane`.

Approximations a depth-buffered renderer makes: polygons are depth-tested
instead of painted in the game's order (the game's order is used only to put
coplanar details, "decals", on top); a bitmap that belongs to a polygon shape
is pulled toward the camera by half its width so that the shape's own faces do
not hide it; edges are not rasterised with the game's rounding. The game's
crowd is screen-space (it stays put on the screen while the stands move
under it); `gl-track.mjs` lays the same strip and row offsets on the stand's
face instead (columns along it, rows up it, 1.75 by 2.2 ft, about one
spectator), coarsening each axis to about a pixel far away, with
`crowd=screen` for the game's way. The game's poles are one pixel wide at any
distance, which at a high resolution is a hairline; `gl-track.mjs` draws each
as a strip facing the camera, one game pixel wide in the classic style and 6
inches wide, but never less than one game pixel, in the modern one
(`poles=pixel|solid`).

### Evidence (DT)

Comparison of our drawing with the game's own frames, inside the pixels our
objects cover, with the PAUSED sign, the banners and boxes around every car
left out (`probes/p2-objects-check.mjs`, `p2-objects-ref.mjs`):

| Frames | Game rules | Mesh data, game rounding | WebGL-style mesh |
| --- | --- | --- | --- |
| Monza race, 19 paused captures (cockpit, chase, TV) | 97.5 % | 97.0 % | 91.0 % |
| 16 circuits, 576 stopped practice frames (p2-ref cameras, practice RAM of the same circuit) | 95.6 % (per-frame median 97.1 %) | 94.0 % | 88.0 % |
| Monza practice, 9 frames down the pit lane | 76 % | 76 % | 74 % |

"Game rules" draws as the game does (walk range, LOD, sector lists, painting
order inside an object, per-object haze, crowd, integer projection, bitmap
scaling). "Mesh data" draws `buildSectorMesh`/`frameObjects` with a depth
buffer but the game's integer projection; "WebGL-style" also uses float
projection, as a GPU would. Per circuit (game rules) 92.0–97.5 %. The remaining
differences: polygon edges one pixel off, objects drawn between the fences of
a segment, the cockpit's start lights, the pit pass's pit-lane walls (the pit
lane frames lose most there, on the track side, not on the objects), and the
estimated camera segment of the reference frames.

### Open questions (objects)

- The game's edge rasteriser (0F47:0000–0999) in detail.
- How objects interleave with the fences of their segment (0F47:518A, R:006A–0070)
  and the +0A high-byte clamp (bit 7).
- The pit-lane pass 0F47:9C05 (which part of the pit lane, its fences).
- The polygon LODs of the car and the cockpit path of the own car; 0F47:8261.
- Wet-weather haze for objects (SS:0182).

## Cars: shapes, placement and colours (decoded)

This section covers how the scene renderer chooses, places, colours and draws
the 26 cars, the effect shapes attached to them, the cockpit mirrors and the
routine 0F47:8261. It corrects two statements made earlier in this file (see
"Corrections"). The code is `spike/lib/cars.mjs`; the checks are
`spike/probes/p3-cars-*.mjs` and `spike/tests/cars.test.mjs`; the working
files (captures, listing extracts, comparison sheets, results) are in
`spike/out/research-phase3/cars/`.

Units as above: X/Y fine units (1/64 ft), Z in Z units, depths in 1/8 ft unless
stated, angles 10000h = one turn. "car+NN" is byte NN of a car record (DS:0D1B
+ slot × C0h).

### Which cars are drawn (0F47:A533, 88A5)

Once per frame A533 takes a window of cars in race order and files each one
on a track segment, so that the segment walk lists it with the objects (A737
removes the marks at the end of the frame):

```
count = DS:2225                      ; = clamp(30 - SS:1230/2, 12, 23): 20 at 15 fps, 23 at 25, 15 at 10 (0:7CAF)
start = (camera object)+66 + 6       ; +66 = race position x 2; reverse walk: + (count - 2) * 2 instead of 6
for each entry of DS:0C65 from start - 2 downwards (towards the leader), wrapping round the order:
    car+96 bit 80h                   -> skip (does not count)
    car is the camera object (DS:097D) and not car+9A bit 08h -> skip (counts)
    car+84 = 1 (2 when the camera looks more than 45 deg across the track, R:0186 >= 2000h)
    seg = the car's segment, moved between the pit and track arrays near the pit junctions
          (A5DD-A6AB, from the junction pointers DS:0182/018A/018E/01A8/01B4/01CC and SS:0160/0164/0170)
    while seg+26 bit 7 (an object, or a car filed earlier): seg = next segment, car+84 += 1
    seg+26 |= C0h; seg+2A |= 80h; seg+0A |= 80h; seg+1E = car+66 | 80h
stop after `count` cars, or 26 entries
```

- So the cars drawn are, in forward views, at most two places behind the
  viewed car in race order and up to 17 places ahead (with lapped cars where
  the order wraps); in reverse views up to 17 behind and 2 ahead. The camera
  object is the viewed car in the cockpit view and the camera record DS:099B
  otherwise; its +66 is the viewed car's in chase views but was seen to differ
  in a TV view, so read it. SC; DT (below).
- The bytes marked are the band markers of the bands 0–9 (+26), 10–25 (+2A)
  and 26–58 (+0A) segments ahead, not +2B: **no car is drawn more than 58
  segments (928 ft) ahead**, nor beyond the view distance from seg+20. Behind
  the camera the walk lists 9 segments (58 in polygon mode). SC.
- The shape drawer then drops a car whose reference point (centre, 168 Z units
  up) is nearer than R:0058 = 1Ah (3.25 ft) in depth, or behind: in external
  views it is not drawn at all; in the cockpit view it goes to a mirror (see
  "Cockpit and mirrors"). It also drops a car when its list key minus R:0062
  is negative ([bp+190], set in A07D; R:0062 is set during the walk to a
  counter − 2, meaning not traced) and one whose visibility points (the four
  wheel points, the front-wing tips and four ground corners) are all behind,
  all left or all right of the screen. SC.
- Hidden, retired and parked cars: car+96 bit 80h means not drawn (practice
  garages, some retired cars); car+96 bit 20h (no driver) draws the car without
  the helmet. Cars in the pit lane are drawn where the walk passes them: near
  the junctions they are filed on the parallel track segments, in the middle
  of the pit lane on pit segments, which the pit pass (0F47:9C05) walks; that
  pass draws cars although it draws no objects (9E2A tests SS:0172 only after
  the car branch). A car on the jacks is the same car raised by car+8C (0, then
  40, then 64 Z units during one stop). SC; DT for 80h, 20h and +8C.
- The viewed car: not drawn in the cockpit view (camera object), unless
  car+9A bit 08h, which the contact code sets with a front impact so that the
  debris in front of you is drawn (A19E draws only that effect for the camera
  object). In chase, reverse chase and TV views it is drawn like any car. SC.

### Order

The walk pushes each listed car on the "later" object list (R:0074, with the
objects whose setting +1 has bit 7) with the key: segment counter − car+84,
that is one (or two) segments nearer than the segment the car stands on
(0F47:5201). 53BF sorts the list by key, far first, keeping the walk's far-to-
near order for equal keys. 6425 then draws, for each segment record from far
to near, the R:0074 entries whose key is at least the record's counter, then
the record's fences and kerbs (then the R:0072 objects). So a car is painted
after all ground-level polygons of its block, after the fences and kerbs of
its own segment and of farther segments, and before those of nearer segments
and nearer objects; a hill crest (block boundary) hides it like the track.
Inside a car the painter's order is the view sector's display list. SC; DT
(ordering equal keys by the walk raised the far-car agreement in a TV frame of
the pack from 92.9 % to 100 %).

### Pose (0:14A2, 0F47:A07D)

```
x, y  = 14A2: car+28/+2C in physics mode, else from the segment (memory-map.md), >> 8 (fine)
z     = 14A2: car+08, or the interpolated segment Z + car+8C
pitch = 14A2: car+02, or seg+02 * cos(car heading - segment heading)
yaw   = car+1A + hi16((car+4A * DS:0156) << 3)
```

- The pitch is used as the shape drawer's tilt: each point's Z rises by
  hi16(y · sin(pitch) << 2) of its Y scale value (negated for a negative
  word). There is no roll. SC; DT.
- The yaw "wobble": car+4A is written by 0:67A7 as the line heading minus the
  direction of travel (car+00); car+1A there is the line heading + car+48.
  DS:0156 = 4000000h / DS:2C5D (the computer cars' time step), 3C00h at 15 fps,
  so the drawn offset is car+4A × 1.875 at 15 fps and scales with the frame
  rate. SC; DT: without the wobble the near-car agreement in the Monza race
  frames fell from 99.1 % to 90.5 % and the far-car one from 99.7 % to 92.5 %.
- The game works in integers from its own camera (SS:0142/014A fine X/Y,
  SS:013E, SS:0154/0156 cos/sin): the reference point through 20AB (in 1/64 ft
  within 3E80h fine units, else in 1/8 ft), every point as the reference point
  plus scale values rotated by yaw − camera yaw with table cos/sin, each
  rotated value floored once and negated for negative point words. Doing the
  same rather than rotating world coordinates in floating point raised the
  near-car agreement by 1–1.5 points. SC; DT.

### Colours

- Body: the team palette, 16 colours at SS:2964 + (car+25 − 1) × 16; element
  colour c → that entry, hazed for the car as for objects (max(depth, 64)).
- Helmet: the driver's palette SS:2AA4 + (number − 1) × 16 (number = car+AC &
  3Fh), passed as an offset from SS:2964 (+140h). Wheels use the team palette.
- Bitmaps are hazed by their own depth. Haze starts at 400 ft. SC; DT
  (palette ablation: drawing helmets in the team palette lowered the near-car
  agreement from 98.6 % to 95.8 %; without haze 0.2–0.4 % of far-car pixels
  change).

### The car shape (shape 0)

- Header: size 512 (8 ft), reference point 168 Z units up, two LODs. LOD 0:
  polygons up to depth 1A0h (52 ft, the reference point's depth, not its
  distance), 14 scale values, 32 view sectors of 11.25°, 23–41 elements per
  sector, 61 elements and 84 points in all. LOD 1: a bitmap LOD (mode 2, mirror
  for negative angles): frames B0h–CFh one per 100h (1.4°) for view angles
  0–1F00h, D0h–DCh one per 800h up to 7FFFh, mirrored for 8000h–FFFFh; angle 0
  is the car seen from behind. SC; DT.
- View angle a = yaw − camera yaw − atan((column − 160)/256) of the reference
  point (table SS:5268, column offset capped at 255; 0 or 320 when behind);
  sector = a >> 11. As for objects. SC; DT.
- Polygons are one-sided. A polygon whose colour byte has bit 6 has one more
  byte, a point p: it is drawn only when the projected **column** of p is not
  right of its partner's (point word +6) (0F47:99F8 compares slot word +6,
  the column; the earlier text in this file called it a depth test). The
  front-wing and rear-wing endplates use it to show their outer or inner face.
  When a point is projected and its partner is already on the same column,
  it moves one column right (9224). Points are projected when an element
  first uses them, vector by vector. SC; DT (the endplates were missing in
  front views before the column rule).
- Team 1 (car+25 = 1) draws the same display lists from a second element
  block at DS:7793 (8E2E sets the element base when [bp+17A] bit 7, which A07D
  sets for team 1): only the first nine elements, the nose, differ. SC; DT
  (without it the near-car agreement fell from 98.6 % to 97.5 %).
- Wheels: four bitmap elements, front id 21h at (±204, 276, 80), rear id 00h at
  (±204, −374, 80) (fine X, Y, Z). Each has 33 frames over 90° of view:
  ```
  a = yaw - camera yaw + correction of the wheel point's own column
  front wheels: a += s(car+48)        s(v) = 4v up to |v| < 200h, else (|v| - 200h)/2 + 800h, signed
  a &= 7FFFh; mirrored = a bit 14; if a > 4000h: a = 8000h - a
  id = base + ((a + 100h) >> 9)       ; 00h-20h rear, 21h-41h front
  ```
  So the front wheels turn with the steering (car+48, ± about 25° at full lock
  for the player); nothing makes the wheels spin. Computer cars steer too, less:
  in a minute of a Monza Quick Race (sampled 20 times a second) their car+48 was
  zero 70–90 % of the time and otherwise rose and fell smoothly in short spells
  to about ±1,100–1,600 (12–14° of wheel); two cars in contact reached 6,372
  (27°). SC; DT (without the steering term the near-car agreement
  fell by 0.6–1.1 points; a reverse-chase frame at full lock matches).
- Helmet: one bitmap element, id 42h at (0, 42, 166), type bit 4 (drawn only
  with a driver), 9 frames over 180°:
  ```
  a = s(car+48) + yaw - camera yaw + correction of the car's column + 2 * car+48   (16-bit, signed)
  mirrored = a < 0; id = 42h + ((|a| + 800h) >> 12)
  ```
  so the driver's head turns with the steering. SC; DT.
- The rear wing, its endplates, the front wing, the cockpit and the body are
  polygons; there are no line elements.

### Effect shapes (DS:351B, 0F47:A1C1, A30A, A406)

Five entries of 16 bytes {dx, dy, dz, yaw add, pitch add, palette offset,
shape id}, placed from the car's pose (offsets rotated by the yaw, dz raised
by sin(pitch) × dy):

| Entry | Drawn when | Shape | Where | What (DT) |
| --- | --- | --- | --- | --- |
| 0 | car+97 bit 80h | 8: bitmap LOD, frames 9Bh–9Fh by angle, palette 500h | 9.3 ft behind, 2.9 ft up | a mechanic in red overalls standing behind the car (set at 0:8D62) |
| 1 | car+9A bits 10h and 04h | 0Eh: 8 bitmaps 91h–9Ah, size 8000, palette 520h | 9.3 ft behind | a burst of debris on the ground |
| 4 | car+9A bit 10h without 04h | 0Eh, pitch + 6000h | 9.3 ft ahead | debris thrown up in front |
| 2 | car+9A bits 80h and 20h | 0Fh: 4 polygons, 4 sectors | the rear wing (8 ft behind, 3.4 ft up) | the broken rear wing, in team colours |
| 3 | car+9A bits 80h and 40h | 10h: 7 polygons, 8 sectors, turned round | the nose (8 ft ahead) | the broken front wing hanging down, in team colours |

- The contact code (0:B9B0, B9D9) sets 80h|40h|10h|08h on one car of a hard
  contact and 80h|20h|10h|04h on the other; bit 10h (the debris) lasts only a
  few frames; 0:3E53 clears 80h, 40h and 20h. DT: the flags persist in race
  frames on cars that touched earlier.
- Parts 2 and 3 are drawn through A2D3, which skips the palette load at A2CC:
  they keep the team palette (entries 0, 1 and 4 use the entry's 500h/520h).
- Order: entries 0, 1 and 4 are drawn before or after the car, whichever is
  farther from the camera first. Part 3 is drawn after the car when the
  camera sees the car's front (|clamped ray angle − yaw| ≥ 4000h), before it
  between 1000h and 4000h, not at all within 1000h of the rear; part 2 always
  after the car. SC; DT: 2,193 of 2,277 effect pixels (96.3 %) match in 13
  frames with these flags poked on the viewed car.

### Routine 0F47:8261

It does not touch a car shape. While the camera is in the pit area (DS:016E
bit 7) it sets the fence colour code of one side (DS:0256 bit 7: left, else
right) to 1 on the first two segments of the viewed car's pit box
(DS:0196 + car+AD × 8Ah) and 82CC restores them after the frame. Code 1 is
R:0220[1] = 3Ch, red: the viewed car's own box is shown in red. SC; DT (riding
in a car on the jacks, the panel beside it has palette colour 3Ch while the
stored code of those segments is 3, grey).

### Cockpit and mirrors

- The player's own car is not drawn in the cockpit view; the cockpit, dash
  and mirror housings are a 2D image in the screen rows below the 3D view.
- The mirrors are drawn by the scene renderer itself (0F47:8A09–8B9E, then
  19E8 in mirror mode). They show **cars only**, no track and no objects, over
  a fixed backdrop (sky and grey ground) that is part of the cockpit image.
  The sky step copies the backdrop into the back buffer each frame in the
  cockpit view (0F47:72E4 calls 19ED:3AFA; see "Replacing the renderer").
  A listed car whose reference point is nearer than R:0058 (3.25 ft) or behind
  the camera goes to a mirror:
  ```
  lat, dep = the car's camera-space position (1/8 ft)
  left mirror if lat < 0: angle R:005A = 9000h, column offset -140; else R:005C = 7000h, +140
  A = lat*cos(angle) - dep*sin(angle);  B = dep*cos(angle) + lat*sin(angle)
  dep' = B >> 12 (4 x the depth: the image is small); lat' = -A (mirrored)
  column = 160 + (lat' << 8) / dep' + offset; dropped if it crosses to the other half
  the far bitmap (LOD 1), frame from -(yaw - camera yaw - angle) + the column's correction,
  scaled by dep', anchor row 123 + (row - horizon) = 123, clipped to rows 116-137 and,
  per row, to [SS:63DE+1F2h+2r, SS:63DE+298h+2r) minus the gap [SS:63DE+A6h+2r, +14Ch+2r)
  (left glass x 0-39, right glass x 280-319)
  ```
  Because of the race-order window only the two cars directly behind in race
  order (and lapped cars) can appear, within the 9 segments the walk lists
  behind the camera. SC; DT: 1,712 of 1,716 mirror pixels (99.8 %) match in 19
  cockpit frames; 86 % of the mirror-glass pixels are identical in 6 cockpit
  frames taken at different places (the rest are cars); drawing every car
  instead of the window put about 85 pixels into the mirrors that the game
  leaves empty.
- For the original look a renderer needs this list (`mirrorImage` in
  cars.mjs) and the backdrop from the game's frame (`mirrors=game`).
- Real rear views (`mirrors=real`, the modern style; gl-track.mjs
  `drawMirrors`): the same projection with the whole scene. Each mirror is the
  camera turned by R:005A or R:005C, mirrored left to right, at a quarter of the
  main view's scale (22 rows are 88 of the main view's, 40 columns 160), with
  the horizon on row 123 and the centre on column 160 ∓ 140. The page makes the
  glass see-through in the game's overlay (`keyFrame` with the outline,
  `mirrorClip`) and the renderer draws only there, through the stencil. The
  cars are built for each mirror's turned camera, not mirrored (the faces seen
  are the same; the mirrored pass winds the other way), for the cars in its
  view nearer than 600 ft (`mirrorCars`); the trackside objects are those near
  its view cone. In headless Chromium the two passes added about 2 ms a frame
  to the page's own work, so the page draws one mirror again each frame, in
  turn (each 30 times a second at 60 page frames, as often as the game moves
  the cars), and the other lays its last picture on the glass. Each view is drawn into a picture of its own at twice
  the glass's size and laid on the glass bowed as a convex mirror bows it (the
  middle a tenth larger, the corners as they are) with a faint ripple; over it
  the renderer lays a glass effect, through the same stencil: a sheen from the
  top left, a fainter streak, a light blue-grey tint and edges a little darker.
- Shadows (`shadows=on`, the modern style; gl-track.mjs `updateShadows`): the
  depth, seen from a fixed sun, of the trackside shapes (every side of each,
  since the game keeps one display list per view sector) and the track's raised
  parts, on a map 2,000 ft across centred 600 ft ahead of the camera, snapped to
  its texels and drawn again when that point has moved 200 ft: into a second
  map, a quarter of the shapes a frame, while the first stays in use (drawn
  whole, the map took 3.5 ms of the GPU's time in one frame in headless
  Chromium with SwiftShader; a quarter takes 0.6 ms). Faces turned to the sun
  look themselves up in it (four taps half a texel apart, each comparing four
  texels) and keep 62 % of their light in a shadow; the ground beyond the track does the same from its plane. The cars keep
  their soft shadows and the bitmaps cast none. In the cockpit the page dims the
  game's overlay to 70 %, in its pixels (`dimPixels` in overlay.mjs; a CSS filter
  that changes each frame is slow to redraw in some browsers), when the driver's head and four points round it are in
  a shadow, by rays toward the sun against the same shapes (sun-ray.mjs), eased.

### What a WebGL renderer can take from this

`spike/lib/cars.mjs`: `readCars(mem)` (shape 0 and its team-1 variant, the
effect shapes and table, the 16-colour palettes, constants; it can be passed
as `objs` to objects.mjs `buildSpriteAtlas`/`spriteQuads`), `carStates` (the
per-car pose, palettes and flags of A07D), `selectCars` (A533: which cars, on
which segment, in which order), `carParts`/`shapeParts` (what 88A5 draws for a
car: the chosen sector's polygons in order, wheels and helmet with frames,
effects, the near cut), `frameCars` (this frame's triangles in the format of
`buildSectorMesh` with layers as `frameObjects`, plus sprites),
`carSpriteQuads` (sprite quads with a per-bitmap depth bias), `carSpriteIds`,
`lerpCarStates` (easing between two frames), `mirrorImage` and `mirrorClip`,
`gameCamera`/`gameProject` (the integer arithmetic, for pixel checks).

Approximations a depth-buffered renderer makes: polygons depth-tested instead
of painted in display-list order (coplanar details and the broken wings on
decal layers); wheel bitmaps pulled a quarter of their width towards the
camera, the helmet half its width; cars against the track by depth instead of
the per-segment painter's order; float projection.

### Evidence (DT)

Captures: `out/research-phase3/cars/cap/` (Monza Quick Race at 25,000 cycles,
`probes/p3-cars-capture.mjs`): `grid1` (grid and start: cockpit, chase,
reverse chase, TV, riding in other cars; 26 frames), `race1` (the start, the
pack in TV views, chase and reverse chase at full steering lock, a stopped
car; 29), `flags2` (effect and driver flags poked on the viewed car; 13),
`pit1` (computer cars sent into the pits by setting car+23 bit 80h, car+B3 bit
4 and car+9A bit 80h; on the jacks; 13). These pause the emulator on a
consistent read: the screen then shows the frame before the one in RAM while
anything moves, so the check splices the previous frame's game memory back in
(`<name>.hist.json`). The Phase 2 captures `static/cap/s2` (19 frames, game
paused with P) need no splice.

Pixel agreement inside the pixels our cars cover (`probes/p3-cars-check.mjs`,
banner rows and the PAUSED sign left out):

| Set | Game rules: polygon cars | bitmap cars | mirrors | WebGL data (mesh): polygon | bitmap |
| --- | --- | --- | --- | --- | --- |
| s2, 19 frames | 99.1 % of 41,789 px | 99.7 % of 10,995 | 99.0 % of 103 | 96.6 % | 98.6 % |
| grid1, 26 | 98.3 % of 43,043 | 100.0 % of 12,251 | 98.9 % of 263 | 97.3 % | 98.6 % |
| race1, 29 | 98.6 % of 42,703 | 100.0 % of 13,438 | – | 97.4 % | 99.0 % |
| flags2, 13 | 98.5 % of 21,993 | 100.0 % of 12,397 | – | 97.0 % | 98.1 % |

Lowest frame (game rules, polygon cars with ≥ 200 px): 96.9 %. The remaining
differences are one-pixel polygon edges (the game's edge rasteriser,
0F47:0000, is not modelled) and thin parts near the near plane. "Mesh" draws
`frameCars` with a depth buffer and the game's integer projection. In the pit
lane frames (`pit1`) the polygon agreement is 79 %: the renderer there walks
the pit lane, which the Phase 2 scene code does not draw (garages, pit crews
and walls missing), so the occlusion cannot be checked; mirrors in those
frames match 100 %.

Ablations (game rules, all sets): without the yaw wobble 90.5–97.7 % (polygon)
and 92.5–99.7 % (bitmap); without the steering term −0.6 to −1.1 points;
without the team-1 nose −0.9 to −1.1 (where team-1 cars are near); helmets in
the team palette −0.3 to −2.8;
floating-point instead of the game's integer arithmetic −1 to −1.5 (polygon),
−0.7 to −1.6 (bitmap).

### Corrections to this file

- Section 1, step 1 and "Cars (for Phase 3)": 0F47:8261 patches fence colour
  codes of the viewed car's pit box (above), not the car's shape record.
- "Cars (for Phase 3)": 88A5's 8A09–8B9E is the mirror path, not the cockpit
  view of the own car; the colour bit 6 test compares columns, not depths.

### Open questions (cars)

- Wet races (spray or darkening of cars) were not captured.
- The game's polygon edge rasteriser (the last 1–2 % of car pixels).
- The pit pass 0F47:9C05 with cars in the middle of the pit lane, and the
  junction mapping A5DD–A6AB, are implemented from the code but not checked
  against frames (the pit-lane scene is missing).
- What makes car+97 bit 80h (the mechanic behind the car) in play (0:8D62);
  the meaning of car+9A bits 01h and 02h (02h is set on the player's car).
- Other circuits and frame rates: all car frames are from Monza at 15 fps;
  DS:2225 and DS:0156 depend on the frame-rate setting and must be read.

## Replacing the renderer (one screen)

This section covers what the one-screen page (`spike/lib/overlay.mjs`)
relies on: how the game's frame reaches the screen, and which parts of the
scene renderer are 2D drawing that must stay when its 3D drawing goes.

### The copy to the screen (19ED:31FA)

The main loop calls 19ED:31FA after the renderer. It copies the back buffer
(far pointer DS:04BC; the 2D routines below write through DS:04B8, which
pointed at the same buffer in our runs)
to A000:0000, by view (DS:0981):

- Outside views (DS:0981 ≠ 0): rows 0–179 (7080h words), all of them.
- Cockpit (0): rows 0–102 and 64 pixels of row 103 (4060h words); then, for
  rows 103–163 (table SS:6364, a row's screen offset, 0 = none), the two spans
  [SS:6364+1F2h, +A6h) and [+14Ch, +298h) of the row, the gaps between the
  cockpit's sides where the road shows; then, for rows 116–137, the spans
  [0, +A6h) and [+14Ch, 320), the mirrors with their housings.

Everything else on screen in the cockpit (the cockpit image, the dash) is
drawn once and updated in place on the screen; it never passes through the
back buffer. SC.

### 2D parts of the renderer

| Routine | Called from | Draws | Evidence |
| --- | --- | --- | --- |
| 19ED:008C | between the renderer's steps (4 times) | nothing: while a palette change is pending (SS:08DA ≠ 0), 8B6E:0000 with AX = 7 sends the next SS:1110 entries of the palette (SS:05DA) to the VGA (INT 10h AX=1012h); section 8 | SC |
| 19ED:3AFA | the sky step, 0F47:72E4, cockpit only | the mirror backdrop: 22 rows (116–137) of 48 bytes at columns 0 and 272, from the cockpit image (far pointer DS:8783, +1400h) | SC; DT (without it the mirrors and their housings are gone) |
| 19ED:3B46 | the draw step's end, 0F47:8145, when DS:0981 is 0 or A0h and DS:2923 ≠ 0 | the start lights, from the cockpit image (+14E0h) to the back buffer (+0AE0h, row 8, column 224); DS:290D (1–6) is the light state | SC; DT (red then green with the fill in place) |
| 19ED:3C1A | the draw step's end, 0F47:8151, cockpit only | two 5×4 cockpit patches at row 140, columns 25 and 290 | SC |
| 0F47:A944 | the draw step's end, 0F47:8161, cockpit, when the viewed car's +97 has bit 40h | pit-stop images (bitmaps 19E8 with ids AAh, ABh, ...), by car+97 bits 08h, 10h, 20h; otherwise DS:2919–291D = 8000h | SC |

The draw step's end (0F47:812B–8179) runs all of the last three and ends
with `pop ds; ret`; 0F47:802A pushes DS for it at 8041.

### The replacement

`sceneRoutine()` writes 82 bytes over 0F47:81CE (the routine is only entered
there) and keeps the original bytes to put back. The replacement:

1. saves DS, ES and the general registers and counts its calls (a word after
   its code; the page uses it to see the game drawing a race view);
2. fills from R:001C (R = SS:00F4; the 3D view's first pixel) with the marker
   colour: 180 rows in the cockpit (the renderer draws below row 103 too,
   seen through the cockpit's gaps), 164 rows in the outside views;
3. makes the four palette-step calls;
4. in the cockpit, calls 19ED:3AFA (mirror backdrop);
5. pushes DS and jumps to 0F47:812B (start lights, cockpit patches, pit-stop
   images), which returns to it.

Of the renderer's steps (section 1) only the end of step 10 runs; the others,
the pit-box colours of step 1 among them, are skipped. `install()` checks the first bytes at every address
it writes or calls and refuses on a different gp.exe.

The marker is one of 10h–1Fh (grass and road shades) whose RGB no other
palette entry has, 17h first. In Monza races none of 10h–1Fh appears in the
cockpit, the dash or the messages. The game fades its palette in and out
through the DAC (race start, leaving the circuit), so the page takes the
marker's colour from the frame (the colour covering at least half of the 3D
view) and dims its own view by the same factor.

The cars in the mirrors come from the car step, which the fill replaces; the
page draws them on the game's frame with `mirrorImage` and the game's bitmap
scaler (`drawSprite` in objects.mjs, 0F47:19E8), clipped to the glass
(`mirrorClip`). DT (`spike/probes/p3-overlay.mjs`, Monza Quick Race): with the
fill in place the cockpit shows its mirrors, housings and start lights; the
pause screen stops the routine (0 calls) while the session continues; the
Esc menu ends the session.
