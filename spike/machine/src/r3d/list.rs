//! The display list: what our 3D routine draws, recorded as it draws it, so that the same frame
//! can be drawn again at any scale (src/r3d/fine.rs). The routine still runs at the game's
//! 320 x 200 and makes every one of its decisions there; the list keeps, beside each thing drawn,
//! what is needed to draw it finer:
//!
//! - **Polygons** (the filler 0999, called by the road 5470 and the shapes 9052): the colour, the
//!   ring of edges as it was pushed (the edges the game left out as well, since a finer scale may
//!   draw them), and each edge's ends as the projection made them: the 32-bit sideways value it
//!   divided, the scaled height, the depth and the horizon row (2168), so that a finer projection
//!   can divide them again.
//! - **Rows** (19ED:3112 and 3181): the sky bands, the road band between blocks, the far ground,
//!   whole or through the cockpit's window.
//! - **Bitmaps** (19E8): the bitmap's rows of runs, its colours, the scale the game took from its
//!   size and depth, and its anchor point as the projection made it, so that a finer scale can
//!   step its columns and rows again (those in the mirrors are kept as pixels).
//! - **Pixels** of everything else (poles, the crowd, the horizon's scenery, the dithered sky
//!   rows, the cockpit's pieces), as the game's pixels, in runs.
//! - **Texels** of the ground texture (7F64): the shade added to a game pixel of road or grass.
//!
//! The recorder is off unless `begin` was called; each hook is then a test of one flag, which
//! the per-pixel loops read once (`recording`).

use std::cell::RefCell;
use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};

use super::Mem;
use crate::pc::Machine;

/// The 3D view's width and rows at the game's scale.
pub const W: u32 = 320;
pub const H: u32 = 164;

/// What the projection (2168) divided for a point, and what it made of it.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Proj {
    /// the sideways value divided by the depth for the column (SS:[bp+10], 32-bit)
    pub x32: i32,
    /// the scaled height, shifted, divided by the depth for the row
    pub n: i32,
    pub depth: u16,
    /// the horizon row (SS:[bp+130])
    pub h: i16,
    /// the column and row it wrote
    pub col: i16,
    pub row: i16,
}

/// A point's record as an edge read it: its screen column, row and outcode (+6, +8, +A), its
/// camera-space sideways, height and depth (+0, +2, +4), and the projection that made it, if the
/// record still holds what that projection wrote (else the point came from elsewhere: a copy, a
/// placement far off the screen, the strips' dummy point).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Pt {
    pub col: i16,
    pub row: i16,
    pub out: u16,
    pub cam: [i16; 3],
    pub proj: Option<Proj>,
}

/// What an edge slot was built from.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum EdgeOf {
    /// 03E9: from the point `a` to `b`
    Line { a: Pt, b: Pt },
    /// 02E4: from the point to the screen's left side (cx 8) or right
    Border {
        p: Pt,
        cx: u8,
        bl: u8,
        /// the segment record's +6 bit 80h, R:013E's sign, and R:0136 (the far road's top row)
        seg_flag: bool,
        r13e_neg: bool,
        r136: i16,
    },
}

/// An edge as the game built it into a slot.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Edge {
    pub of: EdgeOf,
    /// R:02A4 (8000h: the shape's points are eight times finer) and the horizon row
    pub r2a4: u16,
    pub h: i16,
    /// the slot's flags as the game left them (for checks)
    pub flags: u16,
}

/// A run of a bitmap's row: from column `start` (signed, from the anchor; None: where the last
/// run ended, as the game leaves it) to `end`, in the object's colour `colour` (0 to 15).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct BitRun {
    pub start: Option<i8>,
    pub end: i8,
    pub colour: u8,
}

/// A bitmap drawn (19E8), as the drawer took it.
#[derive(Clone, Debug, PartialEq)]
pub struct Bitmap {
    /// its rows (an index in `List::bitmaps`), and the object's 16 colours, hazed (1931)
    pub bits: u32,
    pub colours: [u8; 16],
    /// its anchor: the point it hangs from (None: placed on the screen, A944), and the column
    /// and row the game drew it from
    pub anchor: Option<Pt>,
    pub col: i16,
    pub row: i16,
    /// its size (+0) and rows below the anchor (+6), its depth (SS:[bp+16C])
    pub size: u16,
    pub below: u16,
    pub depth: u16,
    /// the scale the game took (R:0234: size * 8192 / depth, 1 to 8000h), and SS:[bp+17E], the
    /// rows' share of it (None for AAh, ABh and AFh, whose rows take all of it)
    pub scale: u16,
    pub rows_by: Option<u16>,
    /// columns the other way (SS:[bp+12E] bit 15)
    pub mirrored: bool,
    /// the row the cockpit's window starts on (R:0236, SS:[bp+132])
    pub top: i16,
}

/// A ring entry: an edge (an index in `List::edges`) and whether it is turned round (40h).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Entry {
    pub edge: u32,
    pub turn: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Cmd {
    /// A polygon: its colour (after haze), the mode bits ORed in by the caller (5 for the road
    /// and grass), and its ring.
    Poly {
        colour: u8,
        mode: u16,
        ring: Vec<Entry>,
    },
    /// Rows y0 to y1 less one in one colour: whole, or through the cockpit's window.
    Rows {
        y0: i16,
        y1: i16,
        colour: u8,
        window: bool,
    },
    /// Game pixels x0 to x1 less one of row y.
    Run {
        y: u16,
        x0: u16,
        x1: u16,
        colour: u8,
    },
    /// The ground texture's shade added to the game pixel at (x, y) if it is road or grass.
    Texel { x: u16, y: u16, delta: i8 },
    /// A bitmap, drawn again by the game's stepping.
    Bitmap(Box<Bitmap>),
}

/// A frame's display list.
#[derive(Clone, Debug, Default)]
pub struct List {
    pub cmds: Vec<Cmd>,
    pub edges: Vec<Edge>,
    /// R:0264, 0274, 0284, 0294: the edge code's flag tables, 16 bytes each
    pub tables: Vec<u8>,
    /// the cockpit's window tables, SS:6364 (5 arrays of 83 words, A6h bytes apart)
    pub window: Vec<u16>,
    /// the cockpit's top row SS:[bp+132], and SS:[bp+17C] (the vertical scale)
    pub top: i16,
    pub f: i16,
    /// the bitmaps drawn, each as its rows of runs, the bottom row first
    pub bitmaps: Vec<Vec<Vec<BitRun>>>,
    /// writes the recorder saw outside the 3D view, ring entries whose slot no edge was built
    /// into, and polygons drawn as pixels (the crowd)
    pub outside: u32,
    pub missing: u32,
    pub as_pixels: u32,
}

impl List {
    /// The window table's word for game row `row` (103 to 163), array `k` (0 the row's offset, 1
    /// the left opening's end, 2 the right one's start, 3 the left limit, 4 the right limit).
    pub fn window_at(&self, k: usize, row: i32) -> i16 {
        self.window[k * 0x53 + (row - 0x67) as usize] as i16
    }
}

struct Rec {
    list: List,
    /// the 3D view's first byte, linear
    origin: usize,
    /// by a point record's offset in R: the projection that last wrote it
    shadow: HashMap<u16, Proj>,
    /// by an edge slot's offset in R: the edge last built into it
    slots: HashMap<u16, u32>,
    /// by a road ring's offset: its entries as pushed
    rings: HashMap<u16, VecDeque<Entry>>,
    shape: Vec<Entry>,
    /// the ring the next fill draws, and the caller's mode bits
    pending: Option<(Vec<Entry>, u16)>,
    /// the fill being drawn is recorded as pixels
    as_pixels: bool,
    /// by a bitmap's address: its index in `List::bitmaps`
    bits: HashMap<(u16, u16), u32>,
}

/// Whether a recording is on (on some thread: the recorder itself is the thread's own), and the
/// scale it is for.
static ON: AtomicBool = AtomicBool::new(false);
static SCALE: AtomicU32 = AtomicU32::new(1);
thread_local! {
    static REC: RefCell<Option<Box<Rec>>> = const { RefCell::new(None) };
}

#[inline]
fn on() -> bool {
    ON.load(Ordering::Relaxed)
}

/// Whether the hooks have anything to do: read once before a loop of pixels.
#[inline]
pub(super) fn recording() -> bool {
    on()
}

/// How many times larger than the game's the screen is that the levels of detail are chosen
/// for: the scale being recorded for, else 1. A shape's finer version (8BAF) and a bitmap at a
/// vertex (8E94) are kept that many times as far, as the game would keep them on that screen;
/// the frame at the game's scale shows them too.
#[inline]
pub(super) fn detail() -> i32 {
    if on() {
        SCALE.load(Ordering::Relaxed) as i32
    } else {
        1
    }
}

/// The recorder, for a hook that has something to do (kept out of line: the routines it is
/// called from are hot, and recording is rare).
#[cold]
#[inline(never)]
fn with<T>(f: impl FnOnce(&mut Rec) -> T) -> Option<T> {
    REC.with(|r| r.borrow_mut().as_mut().map(|r| f(r)))
}

fn lin(seg: u16, off: u16) -> usize {
    ((seg as usize) << 4) + off as usize
}
fn word(mem: &[u8], a: usize) -> u16 {
    mem[a] as u16 | (mem[a + 1] as u16) << 8
}

/// Start recording for `scale` (`detail`): the machine is at the 3D routine's entry (SS the
/// game's, R at SS:00F4).
pub fn begin(m: &Machine, scale: u32) {
    let mem = &m.hw.mem;
    let ss = m.cpu.s[2];
    let r = word(mem, lin(ss, 0xf4));
    let origin = lin(word(mem, lin(r, 0x1e)), word(mem, lin(r, 0x1c)));
    let tables = mem[lin(r, 0x264)..lin(r, 0x2a4)].to_vec();
    let window = (0..5 * 0x53)
        .map(|k| word(mem, lin(ss, 0x6364 + 2 * k as u16)))
        .collect();
    let list = List {
        tables,
        window,
        top: word(mem, lin(ss, 0x132)) as i16,
        f: word(mem, lin(ss, 0x17c)) as i16,
        ..Default::default()
    };
    REC.with(|c| {
        *c.borrow_mut() = Some(Box::new(Rec {
            list,
            origin,
            shadow: HashMap::new(),
            slots: HashMap::new(),
            rings: HashMap::new(),
            shape: Vec::new(),
            pending: None,
            as_pixels: false,
            bits: HashMap::new(),
        }))
    });
    SCALE.store(scale.max(1), Ordering::Relaxed);
    ON.store(true, Ordering::Relaxed);
}

/// Stop recording; the list, if recording was on.
pub fn end() -> Option<List> {
    ON.store(false, Ordering::Relaxed);
    REC.with(|c| c.borrow_mut().take()).map(|r| r.list)
}

/// 2168 wrote the record at R:base from this projection.
pub(super) fn projected(base: u16, p: Proj) {
    if on() {
        with(|r| r.shadow.insert(base, p));
    }
}

/// The record at R:base was written by something other than the projection (1FAD, or a point
/// behind the near plane, whose column and row are left as they were).
pub(super) fn unprojected(base: u16) {
    if on() {
        with(|r| r.shadow.remove(&base));
    }
}

/// The record at R:dst was made from the one at R:src (2334, 84D6): the same column, sideways
/// value and depth, and a new height, divided as 2168 divides it (`n`) for the row `row`, before
/// any nudge (a row the same as the source's moved up one).
pub(super) fn raised(src: u16, dst: u16, n: i32, h: i16, row: i16) {
    if on() {
        with(|r| match r.shadow.get(&src).copied() {
            Some(p) => {
                r.shadow.insert(dst, Proj { n, h, row, ..p });
            }
            None => {
                r.shadow.remove(&dst);
            }
        });
    }
}

/// The point whose +6 field is at R:at, as an edge reads it now.
fn point(r: &Rec, m: &Mem, at: u16) -> Pt {
    let base = at.wrapping_sub(6);
    let w = |o: u16| m.rw(base.wrapping_add(o)) as i16;
    let (col, row) = (w(6), w(8));
    let proj = r.shadow.get(&base).copied();
    Pt {
        col,
        row,
        out: m.rw(base.wrapping_add(0xa)),
        cam: [w(0), w(2), w(4)],
        proj,
    }
}

fn built(r: &mut Rec, slot: u16, of: EdgeOf, m: &Mem) -> u32 {
    let k = r.list.edges.len() as u32;
    r.list.edges.push(Edge {
        of,
        r2a4: m.rw(0x2a4),
        h: m.w(m.ss, 0x130) as i16,
        flags: 0,
    });
    r.slots.insert(slot, k);
    k
}

/// 03E9 is about to build the edge from the point at R:a to the one at R:b (their +6 fields)
/// into the slot at R:slot; the edge's index, for `edge_flags`.
pub(super) fn edge(m: &Mem, slot: u16, a: u16, b: u16) -> Option<u32> {
    if !on() {
        return None;
    }
    with(|r| {
        let of = EdgeOf::Line {
            a: point(r, m, a),
            b: point(r, m, b),
        };
        built(r, slot, of, m)
    })
}

/// 02E4 is about to build the border edge for the point at R:p into the slot at R:slot; si the
/// caller's segment record.
pub(super) fn border(m: &Mem, slot: u16, p: u16, cx: u16, bl: u8, si: u16) -> Option<u32> {
    if !on() {
        return None;
    }
    with(|r| {
        let of = EdgeOf::Border {
            p: point(r, m, p),
            cx: cx as u8,
            bl,
            seg_flag: m.rb(si.wrapping_add(6)) & 0x80 != 0,
            r13e_neg: (m.rw(0x13e) as i16) < 0,
            r136: m.rw(0x136) as i16,
        };
        built(r, slot, of, m)
    })
}

/// The flags the game left in the edge's slot.
pub(super) fn edge_flags(k: Option<u32>, flags: u16) {
    if let Some(k) = k {
        with(|r| r.list.edges[k as usize].flags = flags);
    }
}

fn entry(r: &mut Rec, slot: u16, turn: bool) -> Option<Entry> {
    match r.slots.get(&slot) {
        Some(&edge) => Some(Entry { edge, turn }),
        None => {
            r.list.missing += 1;
            None
        }
    }
}

/// A road ring (at R:ring) started again with the edge in the slot at R:slot.
pub(super) fn ring_restart(ring: u16, slot: u16, turn: bool) {
    if on() {
        with(|r| {
            let e = entry(r, slot, turn);
            let q = r.rings.entry(ring).or_default();
            q.clear();
            q.extend(e);
        });
    }
}

/// The edge in the slot at R:slot pushed onto a road ring's left list (in front) or right.
pub(super) fn ring_push(ring: u16, slot: u16, left: bool, turn: bool) {
    if on() {
        with(|r| {
            if let Some(e) = entry(r, slot, turn) {
                let q = r.rings.entry(ring).or_default();
                if left {
                    q.push_front(e);
                } else {
                    q.push_back(e);
                }
            }
        });
    }
}

/// The road ring at R:ring is about to be filled, with these mode bits ORed in.
pub(super) fn ring_fill(ring: u16, mode: u16) {
    if on() {
        with(|r| {
            let q = r.rings.get(&ring).map(|q| q.iter().copied().collect());
            r.pending = Some((q.unwrap_or_default(), mode));
        });
    }
}

/// A shape's polygon (9052) starts.
pub(super) fn shape_clear() {
    if on() {
        with(|r| r.shape.clear());
    }
}

/// The edge in the slot at R:slot added to the shape's polygon.
pub(super) fn shape_push(slot: u16, turn: bool) {
    if on() {
        with(|r| {
            if let Some(e) = entry(r, slot, turn) {
                r.shape.push(e);
            }
        });
    }
}

/// The shape's polygon is about to be filled.
pub(super) fn shape_fill() {
    if on() {
        with(|r| r.pending = Some((r.shape.clone(), 0)));
    }
}

/// The filler (0999) starts on the ring its caller set up: a polygon, or pixels for the crowd
/// (colour 1Bh).
pub(super) fn fill_begin(m: &Mem) {
    if on() {
        with(|r| {
            let (ring, mode) = r.pending.take().unwrap_or_default();
            let colour = m.rb(0x2f4);
            r.as_pixels = colour == 0x1b;
            if r.as_pixels {
                r.list.as_pixels += 1;
            } else {
                r.list.cmds.push(Cmd::Poly { colour, mode, ring });
            }
        });
    }
}

pub(super) fn fill_end() {
    if on() {
        with(|r| r.as_pixels = false);
    }
}

fn pixel(r: &mut Rec, seg: u16, off: u16, v: u8) {
    let d = lin(seg, off).wrapping_sub(r.origin);
    if d >= (W * H) as usize {
        r.list.outside += 1;
        return;
    }
    let (y, x) = ((d / W as usize) as u16, (d % W as usize) as u16);
    if let Some(Cmd::Run {
        y: ry, x1, colour, ..
    }) = r.list.cmds.last_mut()
    {
        if *ry == y && *x1 == x && *colour == v {
            *x1 += 1;
            return;
        }
    }
    r.list.cmds.push(Cmd::Run {
        y,
        x0: x,
        x1: x + 1,
        colour: v,
    });
}

/// A pixel written by a part of the routine the list keeps as pixels.
#[inline]
pub(super) fn px(seg: u16, off: u16, v: u8) {
    if on() {
        with(|r| pixel(r, seg, off, v));
    }
}

/// A pixel written by the filler: kept only for a polygon drawn as pixels.
#[inline]
pub(super) fn fill_px(seg: u16, off: u16, v: u8) {
    if on() {
        with(|r| {
            if r.as_pixels {
                pixel(r, seg, off, v)
            }
        });
    }
}

/// A bitmap's rows of runs, read from its header at seg:at (+2 the row table's bytes, +8 the
/// rows' offsets, each row a list of runs; 19E8); None if a run's colour is not one of the
/// object's 16.
fn bit_rows(m: &Mem, seg: u16, at: u16) -> Option<Vec<Vec<BitRun>>> {
    let bytes = m.w(seg, at.wrapping_add(2)) as i16;
    let n = if bytes > 0 {
        (bytes as usize).div_ceil(2)
    } else {
        0
    };
    let mut rows = Vec::with_capacity(n);
    for r in 0..n as u16 {
        let mut si = m
            .w(seg, at.wrapping_add(8).wrapping_add(2 * r))
            .wrapping_add(at);
        let mut next = || {
            let v = m.b(seg, si);
            si = si.wrapping_add(1);
            v
        };
        let mut runs = Vec::new();
        let mut c = next();
        let mut new_start = true;
        while c != 0 && runs.len() < 256 {
            let start = new_start.then(|| next() as i8);
            let end = next() as i8;
            let k = ((c & 0x7e) as i32 - 4) / 2;
            if !(0..16).contains(&k) {
                return None;
            }
            runs.push(BitRun {
                start,
                end,
                colour: k as u8,
            });
            c = next();
            new_start = c & 0x80 != 0;
        }
        rows.push(runs);
    }
    Some(rows)
}

/// The bitmap drawer (19E8) is about to draw the bitmap at seg:at, with its colours at seg:0000
/// (`b` without `bits` and `colours`): recorded as a bitmap, true, or false if its pixels are to
/// be kept instead.
pub(super) fn bitmap(m: &Mem, seg: u16, at: u16, anchor: Option<u16>, mut b: Bitmap) -> bool {
    if !on() {
        return false;
    }
    with(|r| {
        let bits = match r.bits.get(&(seg, at)) {
            Some(&k) => k,
            None => {
                let Some(rows) = bit_rows(m, seg, at) else {
                    return false;
                };
                let k = r.list.bitmaps.len() as u32;
                r.list.bitmaps.push(rows);
                r.bits.insert((seg, at), k);
                k
            }
        };
        b.bits = bits;
        for (k, c) in b.colours.iter_mut().enumerate() {
            *c = m.b(seg, 2 * k as u16);
        }
        b.anchor = anchor.map(|base| point(r, m, base.wrapping_add(6)));
        r.list.cmds.push(Cmd::Bitmap(Box::new(b)));
        true
    })
    .unwrap_or(false)
}

/// The ground texture added `delta` to the pixel at seg:off.
#[inline]
pub(super) fn texel(seg: u16, off: u16, delta: i8) {
    if on() {
        with(|r| {
            let d = lin(seg, off).wrapping_sub(r.origin);
            if d >= (W * H) as usize {
                r.list.outside += 1;
            } else if delta != 0 {
                r.list.cmds.push(Cmd::Texel {
                    x: (d % W as usize) as u16,
                    y: (d / W as usize) as u16,
                    delta,
                });
            }
        });
    }
}

/// Rows y0 to y1 less one filled in a colour, whole or through the window.
pub(super) fn rows(y0: u16, y1: u16, colour: u8, window: bool) {
    if on() {
        with(|r| {
            r.list.cmds.push(Cmd::Rows {
                y0: y0 as i16,
                y1: y1 as i16,
                colour,
                window,
            })
        });
    }
}
