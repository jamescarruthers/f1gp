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
- Markings with seg+1F bit 80h / 40h and f between 7Ch and 83h use special
  shapes from tables R:00B6–00EF (shifts along the track, length, height):
  lines across the road. SC only, not verified.
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
  (markings). R:0220 and R:0230 map the codes to palette indices. At Monza the
  marking A codes give dark asphalt shades (a darker strip on the road) and
  marking B gives the white dashed centre line.
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

## 4. Texture (T) and detail (D)

- **T** toggles SS:11A6 (0:E415, `xor byte [bp+11A6h], 80h`; DT: the byte
  flipped with each press). When it is set, after the whole scene the renderer
  runs 0F47:7F64, which perturbs the flat ground colours into speckles: road
  pixels become 18h–1Bh around 1Ah, grass 11h–13h around 12h (DT: pixel counts
  in the same view with T on and off). The pattern follows the camera's motion
  since the last frame. Its exact algorithm is not decoded.
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
- The special road markings (seg+1F with marking factors 7Ch–83h), the
  pit-junction fences (0F47:2445) and the bridged fences (0F47:25D3) were not
  checked against frames.
- Walks with the camera in the pit-lane array, and the order of the behind
  bands in polygon mode.
- The crest blocks (0F47:279E, 28D1, 4A03) in detail.
- The texture pattern (0F47:7988, 7C5A, 7D62).
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
not hide it; the crowd pattern is screen-space noise; edges are not rasterised
with the game's rounding.

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
