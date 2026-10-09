//! The display list (src/r3d/list.rs) drawn at `s` times the game's resolution by the game's own
//! rules: the reference the WebGPU rasteriser (spike/lib/gpu-r3d.mjs) is held to. At s = 1 it
//! gives the frame our routine drew, byte for byte (`r3d list`).
//!
//! What is drawn, in what order, in which colours, the level of detail and the haze are the
//! routine's decisions, made at 320 x 200 and kept in the list. What is decided again here, at
//! the finer scale, is the rasteriser's part:
//! - each point projected again from the values the game divided (2168), s times finer; a point
//!   the game made otherwise (a copy, a placement far off the screen) is placed at s times its
//!   game position, and a point the game nudged by a row or column is nudged by s;
//! - each edge built again as the edge code (03E9, 02E4) builds it, with the screen s times
//!   larger: clipped to its sides, cut at depth 8 from the same camera-space values, then
//!   stepped row by row with the same error term;
//! - each polygon's ring walked again as the filler (0999) walks it, with the border lists
//!   s times longer and the cockpit's window tables read at the game row each fine row lies in;
//! - each bitmap stepped again as the drawer (19E8) steps it, from its anchor point projected
//!   again, with its scale s times larger (and its greatest, 8000h, too), through the cockpit's
//!   window row by row; as its art's square pixels, or (Art::Smooth) with the corners of its art
//!   pixels cut where it is drawn larger than its art (src/r3d/smooth.rs).
//!
//! The rest is drawn as game pixels made s x s: poles, the crowd, the scenery, the dithered sky
//! rows, the bitmaps in the mirrors and the cockpit's pieces (pixel art either way, for now);
//! the ground texture's shade goes on the fine pixels of road and grass within its game pixel.
//!
//! The output is a list of primitives in paint order, each over the ones before it: spans of
//! fine pixels, runs of game pixels, and texels. `draw` paints them; the GPU paints the same
//! list with each pixel keeping the highest of (primitive number, colour).

use super::list::{self, BitRun, Bitmap, Cmd, Edge, EdgeOf, Entry, List, Pt};
use super::smooth;

/// The end of an edge record's list of x.
const END: i32 = i32::MIN;
/// No record: an edge with nothing to draw.
const NONE: usize = usize::MAX;

/// A primitive, in fine pixels unless said otherwise.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Prim {
    /// fine row y, from x0 (drawn) to x1 (not drawn)
    Span {
        y: u32,
        x0: u32,
        x1: u32,
        colour: u8,
    },
    /// game pixels x0 to x1 less one of game row y, each s x s fine pixels
    Run {
        y: u32,
        x0: u32,
        x1: u32,
        colour: u8,
    },
    /// the ground texture's shade added to the fine pixels of road (1Ah) or grass (12h) within
    /// game pixel (x, y)
    Texel { x: u32, y: u32, delta: i8 },
}

/// How the bitmaps drawn larger than their art look: the art's square pixels, as the game's
/// drawer steps them, or smoothed by a pixel-art filter that keeps the bitmap's colours
/// (src/r3d/smooth.rs: xBR's corner cuts, hard-edged, where a bitmap is drawn 1.5 fine pixels or
/// more an art pixel both ways).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Art {
    #[default]
    Pixels,
    Smooth,
}

/// The frame's primitives at scale `s`: `w` x `h` fine pixels.
pub struct Prims {
    pub s: u32,
    pub w: u32,
    pub h: u32,
    pub prims: Vec<Prim>,
    pub stats: Stats,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct Stats {
    /// edges built, and those whose flags differ from the game's (at s = 1 there should be none)
    pub edges: u32,
    pub flags_differ: u32,
    /// near-plane cuts where the game's 16-bit arithmetic wrapped (s = 1 follows the game there)
    pub cut_wrapped: u32,
    /// polygons, and those that drew nothing
    pub polys: u32,
    pub empty: u32,
}

/// A point at the fine scale: column, row, outcode (side bits worked out again) and its
/// camera-space values as the game's record holds them.
#[derive(Clone, Copy, Debug)]
struct F {
    x: i32,
    y: i32,
    out: u16,
    cam: [i16; 3],
}

#[derive(Clone, Copy)]
struct Scale {
    s: i32,
    /// the fine screen's width and rows
    w: i32,
    h: i32,
}

fn off_x(x: i32, w: i32) -> u16 {
    if (0..w).contains(&x) {
        0
    } else if x >= w {
        4
    } else {
        8
    }
}
fn off_y(y: i32, h: i32) -> u16 {
    if (0..h).contains(&y) {
        0
    } else if y >= h {
        1
    } else {
        2
    }
}
fn narrow(v: i64) -> i32 {
    v.clamp(-(1 << 30), 1 << 30) as i32
}

/// A point placed at the fine scale.
fn place(p: &Pt, sc: Scale) -> F {
    let s = sc.s as i64;
    let at_game = (p.col as i64 * s, p.row as i64 * s);
    let (x, y) = match p.proj {
        Some(q) => {
            // 2168 again: the column truncated, the row rounded as the game rounds it
            let d = q.depth as i64;
            let col = 160 * s + q.x32 as i64 * s / d;
            let n = q.n as i64 * s;
            let (mut r, rem) = (n / d, n % d);
            if rem < 0 {
                if -2 * rem >= d {
                    r -= 1;
                }
            } else if r < 0 || r >= d {
                r += 1;
            }
            let row = q.h as i64 * s - r;
            let (dc, dr) = (p.col as i64 - q.col as i64, p.row as i64 - q.row as i64);
            if dc.abs() <= 2 && dr.abs() <= 2 {
                (col + s * dc, row + s * dr)
            } else {
                at_game
            }
        }
        None => at_game,
    };
    let (x, y) = (narrow(x), narrow(y));
    let out = if p.out & 0x10 != 0 {
        p.out
    } else {
        p.out & 0xfff0 | off_x(x, sc.w) | off_y(y, sc.h)
    };
    F {
        x,
        y,
        out,
        cam: p.cam,
    }
}

/// An edge built at the fine scale: the slot's flags and its record (an index in the arena:
/// lower row, upper row, x at each, the x of each row from the lower less one up, END).
#[derive(Clone, Copy, Debug)]
struct Built {
    flags: u8,
    rec: usize,
}

fn none(flags: u8) -> Built {
    Built { flags, rec: NONE }
}

/// The edge code's workspace: the lower end (+50, +54) and the upper (+58, +5C).
#[derive(Clone, Copy)]
struct Ws {
    x50: i32,
    y54: i32,
    x58: i32,
    y5c: i32,
}

#[derive(Clone, Copy)]
enum At {
    X50,
    Y54,
    X58,
    Y5c,
}

impl Ws {
    fn get(&self, a: At) -> i32 {
        match a {
            At::X50 => self.x50,
            At::Y54 => self.y54,
            At::X58 => self.x58,
            At::Y5c => self.y5c,
        }
    }
    fn set(&mut self, a: At, v: i32) {
        match a {
            At::X50 => self.x50 = v,
            At::Y54 => self.y54 = v,
            At::X58 => self.x58 = v,
            At::Y5c => self.y5c = v,
        }
    }
    /// One clip stage: the end whose `moved` coordinate is past the side comes back onto it, its
    /// `slid` coordinate moving along the edge (across/along times t, in 16.16, as the game does).
    fn clip(&mut self, moved: At, slid: At, side: i32, rows: bool) {
        let mut neg = false;
        let mut run = (self.x58 - self.x50) as i64;
        if run < 0 {
            neg = true;
            run = -run;
        }
        let mut rise = (self.y5c - self.y54) as i64;
        if rise < 0 {
            neg = !neg;
            rise = -rise;
        }
        let v = self.get(moved) as i64;
        let t = if side == 0 { -v } else { v - side as i64 };
        let (along, across) = if rows { (rise, run) } else { (run, rise) };
        let d = if along < across {
            if t < along {
                ((t << 16) / along * across) >> 16
            } else {
                across
            }
        } else if along == across {
            t
        } else {
            ((across << 16) / along * t) >> 16
        };
        let d = if neg == (side != 0) { d } else { -d };
        let slid_to = narrow(self.get(slid) as i64 + d);
        self.set(slid, slid_to);
        self.set(moved, side);
    }
}

struct Builder<'a> {
    sc: Scale,
    list: &'a List,
    arena: &'a mut Vec<i32>,
    stats: &'a mut Stats,
}

impl Builder<'_> {
    fn t264(&self, k: u16) -> u8 {
        self.list.tables[(k & 0xf) as usize]
    }
    fn t274(&self, k: u16) -> u8 {
        self.list.tables[0x10 + (k & 0xf) as usize]
    }
    fn t284(&self, k: u16) -> u8 {
        self.list.tables[0x20 + (k & 0xf) as usize]
    }
    fn t294(&self, k: u16) -> u8 {
        self.list.tables[0x30 + (k & 0xf) as usize]
    }

    fn build(&mut self, e: &Edge) -> Built {
        let b = match e.of {
            EdgeOf::Line { a, b } => self.line(&a, &b, e),
            EdgeOf::Border {
                p,
                cx,
                bl,
                seg_flag,
                r13e_neg,
                r136,
            } => self.border(&p, cx, bl, seg_flag, r13e_neg, r136),
        };
        self.stats.edges += 1;
        if b.flags != e.flags as u8 {
            self.stats.flags_differ += 1;
        }
        b
    }

    /// 03E9.
    fn line(&mut self, a: &Pt, b: &Pt, e: &Edge) -> Built {
        let (sw, sh) = (self.sc.w, self.sc.h);
        let (sa, sb) = (place(a, self.sc), place(b, self.sc));
        let either = (sa.out | sb.out) & 0xff;
        if either == 0 {
            // both ends on the screen
            let (mut x0, mut x1, mut y0, mut y1) = (sa.x, sb.x, sa.y, sb.y);
            if y0 == y1 {
                return none(0x80);
            }
            let mut flags = 0;
            if y0 < y1 {
                std::mem::swap(&mut y0, &mut y1);
                std::mem::swap(&mut x0, &mut x1);
                flags |= 0x40;
            }
            return self.rows(flags, x0, y0, x1, y1);
        }
        if sa.out & sb.out & 0xff != 0 {
            return none(self.t264(either));
        }
        let mut flags = 0u8;
        // the first end and the second, either one cut at the near plane if behind it
        let (mut f, mut of, mut g, mut og);
        if sa.out & 0x10 != 0 {
            match self.near(&sa, &sb, e, &mut flags) {
                Err(dl) => return none(self.t264(dl as u16)),
                Ok((cut, co)) => {
                    (f, of, g, og) = (cut, co, (sb.x, sb.y), sb.out);
                }
            }
        } else if sb.out & 0x10 != 0 {
            match self.near(&sb, &sa, e, &mut flags) {
                Err(dl) => return none(self.t264(dl as u16)),
                Ok((cut, co)) => {
                    (f, of, g, og) = ((sa.x, sa.y), sa.out, cut, co);
                }
            }
        } else {
            (f, of, g, og) = ((sa.x, sa.y), sa.out, (sb.x, sb.y), sb.out);
        }
        // 04C9: the lower end first; on the same row, the one off the left or right side
        if f.1 < g.1 || (f.1 == g.1 && of & 8 == 0 && of & 4 == 0) {
            std::mem::swap(&mut f, &mut g);
            std::mem::swap(&mut of, &mut og);
            flags |= 0x40;
        }
        let mut w = Ws {
            x50: f.0,
            y54: f.1,
            x58: g.0,
            y5c: g.1,
        };
        let (mut cx, mut bx) = (of & 0xf, og & 0xf);
        flags |= self.t274(cx) | self.t284(bx);
        if cx & 1 != 0 {
            // 050F: the lower end onto the bottom row
            w.clip(At::Y54, At::X50, sh, true);
            cx = off_x(w.x50, sw);
            if (cx | bx) & 0xf == 0 {
                return self.rows(flags, w.x50, w.y54, w.x58, w.y5c);
            }
            let both = cx & bx & 0xf;
            if both != 0 {
                return none(flags | if both & 8 != 0 { 0x81 } else { 0x84 });
            }
        }
        if bx & 2 != 0 {
            // 05C6: the upper end onto the top row
            w.clip(At::Y5c, At::X58, 0, true);
            bx = off_x(w.x58, sw);
            if (cx | bx) & 0xf == 0 {
                return self.rows(flags, w.x50, w.y54, w.x58, w.y5c);
            }
            let both = cx & bx & 0xf;
            if both != 0 {
                return none(flags | if both & 8 != 0 { 0x88 } else { 0x82 });
            }
        }
        // 0672: then each end onto the left or right side
        if cx & 8 != 0 {
            w.clip(At::X50, At::Y54, 0, false);
        } else if cx & 4 != 0 {
            w.clip(At::X50, At::Y54, sw, false);
        }
        if bx & 8 != 0 {
            w.clip(At::X58, At::Y5c, 0, false);
        } else if bx & 4 != 0 {
            w.clip(At::X58, At::Y5c, sw, false);
        }
        self.rows(flags, w.x50, w.y54, w.x58, w.y5c)
    }

    /// 00CA: the edge cut at depth 8, `bh` the end behind the near plane and `ot` the other: the
    /// cut's column and row and its outcode, or the sides to flag when nothing is left.
    fn near(&mut self, bh: &F, ot: &F, e: &Edge, flags: &mut u8) -> Result<((i32, i32), u16), u8> {
        let (sw, sh) = (self.sc.w, self.sc.h);
        let dl = self.t294(bh.out | ot.out);
        *flags |= dl;
        let (mut ax, mut s54) = (bh.cam[0], bh.cam[2]);
        let (mut cx, mut dx) = (ot.cam[0], ot.cam[2]);
        let (bf, of) = ((bh.out as i16) < 0, (ot.out as i16) < 0);
        let mut both = false;
        if !bf {
            if of {
                // 0117: the other end's x and depth to the same scale
                cx >>= 3;
                dx >>= 3;
                if dx < 8 {
                    return Err(dl);
                }
            }
        } else if of {
            both = true; // 012D
        } else {
            ax >>= 3; // 0106
            s54 >>= 3;
        }
        // 0133: how far along the edge depth 8 is, t in 14 bits
        let cy = bh.cam[1];
        let mut dd = dx.wrapping_sub(s54);
        if dd < 8 {
            dd = 8;
        }
        let n = (8i16.wrapping_sub(s54) as i32) << 14;
        let q = n / dd as i32;
        let t = if (-0x8000..0x8000).contains(&q) {
            q
        } else {
            n as u16 as i16 as i32
        };
        // 016D: the cut's camera-space x and y, times 32: as the game works them out (wrapping)
        // and s times finer
        let dxo = cx.wrapping_sub(ax) as i32;
        let dyo = ot.cam[1].wrapping_sub(cy) as i32;
        let mut x1 = ((ax as i32) << 5).wrapping_add(dxo.wrapping_mul(t) >> 9);
        let mut y1 = ((cy as i32) << 5).wrapping_add(dyo.wrapping_mul(t) >> 9);
        if !both {
            y1 >>= 3;
        }
        let s = self.sc.s as i64;
        let mut xs = ((ax as i64) << 5) * s + ((dxo as i64 * t as i64 * s) >> 9);
        let mut ys = ((cy as i64) << 5) * s + ((dyo as i64 * t as i64 * s) >> 9);
        if !both {
            ys >>= 3;
        }
        if s == 1 && (xs != x1 as i64 || ys != y1 as i64) {
            self.stats.cut_wrapped += 1;
        }
        // 0219: both halved until each is under 7000h
        let big = |v: i32| {
            let a = if v < 0 { v.wrapping_neg() } else { v };
            let hi = (a >> 16) as i16;
            hi > 0 || (hi == 0 && (a as u16) >= 0x7000)
        };
        while big(x1) || big(y1) {
            x1 >>= 1;
            y1 >>= 1;
            xs >>= 1;
            ys >>= 1;
        }
        // 0271: projected at depth 8
        let f = self.list.f as i32;
        let (col, row) = if s == 1 {
            let p = (y1 as u16 as i16 as i32).wrapping_mul(f);
            let yy = (((p as u32) << 1) >> 16) as u16;
            (
                (x1 as u16).wrapping_add(0xa0) as i16 as i32,
                (e.h as u16).wrapping_sub(yy) as i16 as i32,
            )
        } else {
            (
                narrow(xs + 160 * s),
                narrow(e.h as i64 * s - ((ys * f as i64 * 2) >> 16)),
            )
        };
        let mut cut = (col, row);
        let mut co = e.r2a4 | off_x(col, sw) | off_y(row, sh);
        if co & 0xff == 0 && cut == (ot.x, ot.y) {
            // 0000: a cut on the other end goes to the bottom row
            cut.1 = sh;
            co = e.r2a4 | off_x(cut.0, sw) | off_y(cut.1, sh);
        }
        if co as u8 & ot.out as u8 == 0 {
            Ok((cut, co))
        } else {
            Err(co as u8 | ot.out as u8)
        }
    }

    /// 02E4: the border edge from the point to the screen's side.
    fn border(
        &mut self,
        p: &Pt,
        cx: u8,
        bl: u8,
        seg_flag: bool,
        r13e_neg: bool,
        r136: i16,
    ) -> Built {
        let (sw, s) = (self.sc.w, self.sc.s);
        let sp = place(p, self.sc);
        let o = sp.out as u8;
        if cx & o != 0 {
            return none(0x80);
        }
        let (mut y, x, mut out) = (sp.y, sp.x, sp.out);
        if o & 0x13 != 0 {
            if o & 0x10 != 0 || o & 2 == 0 {
                return none(0x80);
            }
            // 030D: above the screen, brought down to its top row
            out &= 0xfffc;
            y = 0;
        }
        let side = if cx == 8 { 0 } else { sw };
        let floor = if out as u8 & 0xc != 0 {
            true
        } else if !seg_flag {
            false
        } else if r13e_neg {
            cx == 4
        } else {
            cx == 8
        };
        if floor {
            y = y.max(r136 as i32 * s);
        }
        let flags = bl | self.t274(cx as u16) | self.t284(out);
        let x = if (0..sw).contains(&x) {
            x
        } else if x >= sw {
            sw
        } else {
            0
        };
        let rec = self.arena.len();
        self.arena.extend([y, y, side, x, END]);
        Built { flags, rec }
    }

    /// 0862: the record of the edge from (x0, y0), the lower end, up to (x1, y1): the x of each
    /// row, stepped with the game's error term along the longer axis.
    fn rows(&mut self, flags: u8, mut x0: i32, mut y0: i32, x1: i32, y1: i32) -> Built {
        let rec = self.arena.len();
        self.arena.extend([y0, y1, x0, x1]);
        let rise = y0.wrapping_sub(y1);
        if rise != 0 {
            let d = x0 - x1;
            let (run, step) = if d < 0 { (-d, 1) } else { (d, -1) };
            if run < rise {
                // a row at a time
                let mut e = !((rise as u16) >> 1);
                while y0 != y1 {
                    y0 -= 1;
                    self.arena.push(x0);
                    let (n, carry) = e.overflowing_add(run as u16);
                    e = n;
                    if carry {
                        e = e.wrapping_sub(rise as u16);
                        x0 += step;
                    }
                }
            } else {
                // a column at a time
                let mut e = !((run as u16) >> 1);
                while x0 != x1 {
                    x0 += step;
                    let (n, carry) = e.overflowing_add(rise as u16);
                    e = n;
                    if carry {
                        e = e.wrapping_sub(run as u16);
                        self.arena.push(x0);
                    }
                }
            }
        }
        self.arena.push(END);
        Built { flags, rec }
    }
}

/// Where a side's next x comes from: an edge's record, or a border list (x for `left` more
/// rows, then the end).
#[derive(Clone, Copy, Debug)]
enum Src {
    Rec(usize),
    Border { x: i32, left: i32 },
}

#[derive(Clone, Copy, PartialEq)]
enum Walk {
    Bordered,
    Plain,
}

/// The filler (0999) on a ring of built edges.
struct Fill<'a> {
    sc: Scale,
    list: &'a List,
    arena: &'a [i32],
    /// the ring's entries: flags (turned) and record
    ring: &'a [(u8, usize)],
    mode: u8,
    colour: u8,
    /// R:000C and R:0010 (the left and right sides' entries), R:0014 and R:0018 (their flags)
    l: usize,
    r: usize,
    lf: u8,
    rf: u8,
    /// R:063C: the ring's bytes left to walk; R:063E: the sides on border lists
    left: i32,
    on: u8,
    si: Src,
    bx: Src,
    /// the row below the one being drawn
    dx: i32,
    out: &'a mut Vec<Prim>,
}

impl Fill<'_> {
    fn rec(&self, k: usize) -> usize {
        self.ring[k].1
    }
    fn a(&self, rec: usize, i: usize) -> i32 {
        self.arena[rec + i]
    }
    fn forward(&self, p: usize) -> usize {
        if p + 1 >= self.ring.len() {
            0
        } else {
            p + 1
        }
    }
    fn backward(&self, p: usize) -> usize {
        if p == 0 {
            self.ring.len() - 1
        } else {
            p - 1
        }
    }
    fn left_on(&mut self) {
        self.l = self.forward(self.l);
        self.lf = self.ring[self.l].0;
    }
    fn right_on(&mut self) {
        self.r = self.backward(self.r);
        self.rf = self.ring[self.r].0;
    }
    fn dec_left(&mut self) -> bool {
        self.left -= 4;
        self.left >= 0
    }
    fn read(&self, s: &mut Src) -> i32 {
        match s {
            Src::Rec(i) => {
                let v = self.arena[*i];
                *i += 1;
                v
            }
            Src::Border { x, left } => {
                if *left > 0 {
                    *left -= 1;
                    *x
                } else {
                    END
                }
            }
        }
    }
    /// A border list that ends at row y (none if y is below the row being drawn).
    fn border(&self, y: i32, x: i32) -> Option<Src> {
        let k = y - self.dx;
        if k > 0 {
            return None;
        }
        Some(Src::Border { x, left: -k })
    }
    fn span(&mut self, y: i32, x0: i32, x1: i32) {
        self.out.push(Prim::Span {
            y: y as u32,
            x0: x0 as u32,
            x1: x1 as u32,
            colour: self.colour,
        });
    }

    fn run(&mut self) {
        let (sw, sh, s) = (self.sc.w, self.sc.h, self.sc.s);
        let size = self.ring.len();
        self.left = 4 * size as i32;
        // the lowest vertex
        let mut bx = 0;
        self.dx = self.a(self.rec(0), 0);
        for k in 1..size {
            let rec = self.rec(k);
            let y0 = self.a(rec, 0);
            let take = if self.mode != 0 {
                self.dx < y0 || (self.dx == y0 && self.dx == self.a(rec, 1))
            } else {
                self.dx < y0
            };
            if take {
                self.dx = y0;
                bx = k;
            }
        }
        self.on = 0;
        let ok = if self.mode == 0 {
            self.start_plain(bx)
        } else if self.ring[bx].0 & 0x40 != 0 {
            self.start_backward(bx)
        } else {
            self.start_forward(bx)
        };
        if !ok {
            return;
        }
        let row = self.dx - 1;
        if !(0..sh).contains(&row) {
            return;
        }
        let top = self.list.top as i32 * s;
        if self.dx > top {
            // the rows through the cockpit's window
            loop {
                let Some(ax) = self.left_x(Walk::Bordered) else {
                    return;
                };
                let Some(cx) = self.right_x(Walk::Bordered) else {
                    return;
                };
                self.cockpit_span(self.dx - 1, ax, cx);
                self.dx -= 1;
                if self.dx == 0x67 * s {
                    break;
                }
            }
            self.open_rows(Walk::Bordered);
        } else if self.mode != 0 {
            self.open_rows(Walk::Bordered);
        } else {
            self.open_rows(Walk::Plain);
        }
        let _ = sw;
    }

    fn start_forward(&mut self, bx: usize) -> bool {
        let sw = self.sc.w;
        self.l = bx;
        self.lf = self.ring[bx].0;
        self.dec_left();
        self.si = Src::Rec(self.rec(bx) + 4);
        self.r = bx;
        self.right_on();
        self.bx = Src::Rec(self.rec(self.r) + 4);
        let (si, br) = (self.rec(self.l), self.rec(self.r));
        if self.lf & 0x10 == 0 {
            return self.same_row_right();
        }
        if self.a(si, 0) == self.sc.h {
            if self.rf & 0x40 != 0 && self.a(br, 0) == self.sc.h {
                return self.same_row_right();
            }
            if self.a(si, 2) != sw && self.mode & 4 == 0 {
                return false;
            }
            return self.right_border();
        }
        if self.a(si, 2) == sw {
            return self.right_border();
        }
        if self.a(si, 2) != 0 {
            return false;
        }
        // 0AAC: the left edge on the left border
        let level = if self.rf & 0x40 != 0 {
            if self.a(br, 2) == 0 {
                Some(self.a(br, 0) == self.a(si, 0))
            } else {
                None
            }
        } else if self.a(br, 3) == 0 {
            Some(self.a(si, 0) == self.a(br, 1))
        } else {
            None
        };
        match level {
            Some(true) => return self.same_row_right(),
            Some(false) => return false,
            None => {}
        }
        // 0ADE: from the bottom row, along the left border
        if self.mode & 1 == 0 {
            return false;
        }
        self.dx = self.sc.h;
        let Some(src) = self.border(self.a(si, 0), 0) else {
            return false;
        };
        self.si = src;
        self.on |= 0x80;
        self.left += 4;
        self.right_border()
    }

    fn right_border(&mut self) -> bool {
        let sw = self.sc.w;
        let rec = self.rec(self.r);
        let (xf, yf) = if self.ring[self.r].0 & 0x40 != 0 {
            (2, 0)
        } else {
            (3, 1)
        };
        let y = if self.a(rec, xf) == sw {
            self.a(rec, yf)
        } else if self.mode & 2 != 0 {
            0
        } else {
            return false;
        };
        let Some(src) = self.border(y, sw) else {
            return false;
        };
        self.bx = src;
        self.on |= 0x40;
        true
    }

    fn same_row_right(&mut self) -> bool {
        if self.dx != self.a(self.rec(self.r), 0) {
            return false;
        }
        self.dec_left();
        true
    }

    fn start_backward(&mut self, bx: usize) -> bool {
        let sw = self.sc.w;
        self.r = bx;
        self.rf = self.ring[bx].0;
        self.dec_left();
        self.bx = Src::Rec(self.rec(bx) + 4);
        self.l = bx;
        self.left_on();
        self.si = Src::Rec(self.rec(self.l) + 4);
        let (si, br) = (self.rec(self.l), self.rec(self.r));
        if self.rf & 0x10 == 0 {
            return self.same_row_left();
        }
        if self.a(br, 0) == self.sc.h {
            if self.lf & 0x40 == 0 && self.a(si, 0) == self.sc.h {
                return self.same_row_left();
            }
            if self.a(br, 2) != 0 && self.mode & 1 == 0 {
                return false;
            }
            return self.left_border();
        }
        if self.a(br, 2) == 0 {
            return self.left_border();
        }
        if self.a(br, 2) != sw {
            return false;
        }
        // 0C21: the right edge on the right border
        let level = if self.lf & 0x40 != 0 {
            if self.a(si, 3) == sw {
                Some(self.a(br, 0) == self.a(si, 1))
            } else {
                None
            }
        } else if self.a(si, 2) == sw {
            Some(self.a(br, 0) == self.a(si, 0))
        } else {
            None
        };
        match level {
            Some(true) => return self.same_row_left(),
            Some(false) => return false,
            None => {}
        }
        // 0C53: from the bottom row, along the right border
        if self.mode & 4 == 0 {
            return false;
        }
        self.dx = self.sc.h;
        let Some(src) = self.border(self.a(br, 0), sw) else {
            return false;
        };
        self.bx = src;
        self.on |= 0x40;
        self.left += 4;
        self.left_border()
    }

    fn left_border(&mut self) -> bool {
        let rec = self.rec(self.l);
        let (xf, yf) = if self.ring[self.l].0 & 0x40 != 0 {
            (3, 1)
        } else {
            (2, 0)
        };
        let y = if self.a(rec, xf) == 0 {
            self.a(rec, yf)
        } else if self.mode & 8 != 0 {
            0
        } else {
            return false;
        };
        let Some(src) = self.border(y, 0) else {
            return false;
        };
        self.si = src;
        self.on |= 0x80;
        true
    }

    fn same_row_left(&mut self) -> bool {
        if self.dx != self.a(self.rec(self.l), 0) {
            return false;
        }
        self.dec_left();
        true
    }

    fn start_plain(&mut self, bx: usize) -> bool {
        if self.ring[bx].0 & 0x40 == 0 {
            self.l = bx;
            self.lf = self.ring[bx].0;
            self.si = Src::Rec(self.rec(bx) + 4);
            self.r = bx;
            self.right_on();
            self.bx = Src::Rec(self.rec(self.r) + 4);
        } else {
            self.r = bx;
            self.rf = self.ring[bx].0;
            self.bx = Src::Rec(self.rec(bx) + 4);
            self.l = bx;
            self.left_on();
            self.si = Src::Rec(self.rec(self.l) + 4);
        }
        true
    }

    fn next_left(&mut self) -> i32 {
        let mut s = self.si;
        let v = self.read(&mut s);
        self.si = s;
        v
    }
    fn next_right(&mut self) -> i32 {
        let mut s = self.bx;
        let v = self.read(&mut s);
        self.bx = s;
        v
    }

    fn left_x(&mut self, walk: Walk) -> Option<i32> {
        let sw = self.sc.w;
        let mut ax = self.next_left();
        if ax >= 0 {
            return Some(ax);
        }
        if walk == Walk::Plain {
            loop {
                let p = self.forward(self.l);
                if p == self.r {
                    return None;
                }
                self.l = p;
                let rec = self.rec(p);
                if self.dx != self.a(rec, 0) {
                    return None;
                }
                self.si = Src::Rec(rec + 5);
                ax = self.a(rec, 4);
                if ax >= 0 {
                    return Some(ax);
                }
            }
        }
        loop {
            let fl = self.on;
            self.on = fl & 0x7f;
            if fl & 0x80 == 0 {
                let e = self.lf;
                let on_border = if e & 0x40 != 0 {
                    e & 0x10 != 0
                } else {
                    e & 0x20 != 0
                };
                if on_border {
                    // an edge ending on the right border ends the polygon
                    let rec = self.rec(self.l);
                    let xf = if e & 0x40 != 0 { 2 } else { 3 };
                    if self.a(rec, xf) == sw {
                        return None;
                    }
                    // the next edge, or the left border up to it
                    self.left_on();
                    let rec = self.rec(self.l);
                    let (xf, yf) = if self.ring[self.l].0 & 0x40 != 0 {
                        (3, 1)
                    } else {
                        (2, 0)
                    };
                    let y = if self.a(rec, xf) == 0 {
                        self.a(rec, yf)
                    } else if self.mode & 8 != 0 {
                        0
                    } else {
                        return None;
                    };
                    self.si = self.border(y, 0)?;
                    self.on |= 0x80;
                    ax = self.next_left();
                    if ax >= 0 {
                        return Some(ax);
                    }
                    continue;
                }
                self.left_on();
            }
            if !self.dec_left() {
                return None;
            }
            let rec = self.rec(self.l);
            self.si = Src::Rec(rec + 4);
            if self.dx != self.a(rec, 0) {
                return None;
            }
            ax = self.next_left();
            if ax >= 0 {
                return Some(ax);
            }
        }
    }

    fn right_x(&mut self, walk: Walk) -> Option<i32> {
        let sw = self.sc.w;
        let mut cx = self.next_right();
        if cx >= 0 {
            return Some(cx);
        }
        if walk == Walk::Plain {
            loop {
                let p = self.backward(self.r);
                if p == self.l {
                    return None;
                }
                self.r = p;
                let rec = self.rec(p);
                if self.dx != self.a(rec, 0) {
                    return None;
                }
                self.bx = Src::Rec(rec + 5);
                cx = self.a(rec, 4);
                if cx >= 0 {
                    return Some(cx);
                }
            }
        }
        loop {
            let fl = self.on;
            self.on = fl & 0xbf;
            if fl & 0x40 == 0 {
                let e = self.rf;
                let on_border = if e & 0x40 != 0 {
                    e & 0x20 != 0
                } else {
                    e & 0x10 != 0
                };
                if on_border {
                    // an edge ending on the left border ends the polygon
                    let rec = self.rec(self.r);
                    let xf = if e & 0x40 != 0 { 3 } else { 2 };
                    if self.a(rec, xf) == 0 {
                        return None;
                    }
                    // the edge before, or the right border up to it
                    self.right_on();
                    let rec = self.rec(self.r);
                    let (xf, yf) = if self.ring[self.r].0 & 0x40 != 0 {
                        (2, 0)
                    } else {
                        (3, 1)
                    };
                    let y = if self.a(rec, xf) == sw {
                        self.a(rec, yf)
                    } else if self.mode & 2 != 0 {
                        0
                    } else {
                        return None;
                    };
                    self.bx = self.border(y, sw)?;
                    self.on |= 0x40;
                    cx = self.next_right();
                    if cx >= 0 {
                        return Some(cx);
                    }
                    continue;
                }
                self.right_on();
            }
            if !self.dec_left() {
                return None;
            }
            let rec = self.rec(self.r);
            self.bx = Src::Rec(rec + 4);
            if self.dx != self.a(rec, 0) {
                return None;
            }
            cx = self.next_right();
            if cx >= 0 {
                return Some(cx);
            }
        }
    }

    /// A row through the cockpit's window: the game row's limits and gap, s times wider.
    fn cockpit_span(&mut self, y: i32, mut ax: i32, mut cx: i32) {
        let s = self.sc.s;
        let g = y / s;
        let t = |k: usize| self.list.window_at(k, g) as i32;
        if t(0) == 0 {
            return;
        }
        let (gap0, gap1, lo, hi) = (t(1) * s, t(2) * s, t(3) * s, t(4) * s);
        if ax < lo {
            ax = lo;
        }
        if cx > hi {
            cx = hi;
        }
        if cx > gap0 && ax < gap1 {
            if ax < gap0 && gap0 - ax > 0 {
                self.span(y, ax, gap0);
            }
            if cx <= gap1 {
                return;
            }
            ax = gap1;
        }
        if cx - ax > 0 {
            self.span(y, ax, cx);
        }
    }

    fn open_rows(&mut self, walk: Walk) {
        loop {
            let Some(ax) = self.left_x(walk) else { return };
            let Some(cx) = self.right_x(walk) else { return };
            if cx - ax > 0 {
                self.span(self.dx - 1, ax, cx);
            }
            self.dx -= 1;
            if self.dx == 0 {
                return;
            }
        }
    }
}

/// 19E8 at the fine scale: the bitmap's columns and rows stepped from its anchor as the drawer
/// steps them (1AC2, 1B45), with the scale s times larger, at most 8000h s; its rows from the
/// cockpit's top through the window's game row, limits and gap s times wider (1DBF). At s = 1,
/// the game's scale and so the game's pixels. With `sm` (Art::Smooth), smoothed where it is drawn
/// larger than its art.
fn bitmap(out: &mut Vec<Prim>, list: &List, b: &Bitmap, sc: Scale, sm: Option<&mut Smoother>) {
    let s = sc.s as i64;
    let rows = &list.bitmaps[b.bits as usize];
    let (ax, ay) = match &b.anchor {
        Some(p) => {
            let f = place(p, sc);
            (f.x as i64, f.y as i64)
        }
        None => (b.col as i64 * s, b.row as i64 * s),
    };
    let scale = if s == 1 {
        b.scale as i64
    } else {
        ((b.size as i64) << 13) * s / (b.depth as i64).max(1)
    }
    .clamp(1, 0x8000 * s);
    // 1AC2: column k's x, the anchor plus k times the scale (16.16), mirrored or not, on screen
    let step = scale << 3;
    let w = sc.w as i64;
    let col = |k: i8| -> i64 {
        let k = k as i64;
        let o = (k.abs() * step) >> 16;
        (if (k < 0) != b.mirrored {
            ax - o
        } else {
            ax + o
        })
        .clamp(0, w)
    };
    // 1B45: the rows' scale, the bottom row, and the bitmap rows per screen row (16.16)
    let rs = match b.rows_by {
        Some(v) => (scale * v as i64) >> 16,
        None => scale,
    };
    let below = (b.below as i64 * rs * 8) >> 16;
    let mut y = ay + below;
    // (a quotient over 16 bits, or none, made FFFFh as the game's divide-error handler leaves it)
    let q = if rs == 0 {
        0xffff
    } else {
        ((1i64 << 24) / rs).min(0xffff)
    };
    if q == 0 || y < 0 {
        return;
    }
    let row_step = (q << 5) as u32;
    let mut at = (((b.below as u32) << 16) as u64)
        .wrapping_sub(((q as u64 * below as u64) << 5) & 0xffff_ffff) as u32;
    for _ in 0..0x10000 {
        if (at as i32) >= 0 {
            break;
        }
        at = at.wrapping_add(row_step);
    }
    // Art::Smooth, for a bitmap drawn MAGNIFIED or more both ways (across, the columns' step;
    // down, the rows' own scale rs, rs << 3 fine rows an art row): its art classified
    let grid = match sm {
        Some(sm) if step >= MAGNIFIED && rs << 3 >= MAGNIFIED => sm.grid(list, b),
        _ => None,
    };
    let mut smoothed = grid.map(|(g, pal)| SmoothRow {
        g,
        pal,
        colours: b.colours,
        mirrored: b.mirrored,
        ax,
        step,
        at0: at as i64,
        row_step: row_step as i64,
        w,
        ext: Vec::new(),
        ext_of: None,
        lost: None,
        cur: None,
    });
    let mut next = || {
        let r = (at >> 16) as usize;
        at = at.wrapping_add(row_step);
        r
    };
    let h = sc.h as i64;
    // (i counts the fine rows from the bitmap's bottom row, those below the screen too)
    let mut i = 0i64;
    while y >= h {
        if rows.get(next()).is_none() {
            return;
        }
        i += 1;
        y -= 1;
    }
    let top = b.top as i64;
    while y >= 0 {
        let r = next();
        let Some(runs) = rows.get(r) else { return };
        let g = y / s;
        let win = if g >= top {
            let t = |k: usize| {
                list.window
                    .get(k * 0x53 + (g - top) as usize)
                    .map_or(0, |&v| v as i16 as i64)
            };
            if t(0) == 0 {
                i += 1;
                y -= 1;
                continue;
            }
            Some([t(3) * s, t(4) * s, t(1) * s, t(2) * s])
        } else {
            None
        };
        match &mut smoothed {
            Some(sr) => sr.row(out, runs, r, i, y, &col, win),
            None => bit_runs(out, runs, y, b, &col, win),
        }
        i += 1;
        y -= 1;
    }
}

/// Fine pixels per art pixel (16.16) from which Art::Smooth smooths a bitmap: 1.5.
const MAGNIFIED: i64 = 0x18000;

/// Art::Smooth's art, kept from frame to frame (Machine keeps one for the page): each bitmap's art
/// classified, found by its rows and its 16 colours, with the frame it was last drawn in; and
/// the palette it was classified by. What it keeps makes a frame quicker to draw, never
/// different.
#[derive(Default)]
pub struct Smoother {
    pal_key: Vec<u8>,
    pal: Option<smooth::Pal>,
    frame: u32,
    kept: Vec<Kept>,
    bytes: usize,
}

struct Kept {
    hash: u64,
    rows: Vec<Vec<BitRun>>,
    colours: [u8; 16],
    used: u32,
    bytes: usize,
    grid: Option<smooth::ArtGrid>,
}

/// At most this many bitmaps' art kept, in about this many bytes (by the vectors' capacities;
/// the allocator's own overhead adds about a quarter), each for at most this many frames unused.
const KEEP: usize = 128;
const KEEP_BYTES: usize = 4 << 20;
const KEEP_FRAMES: u32 = 30;

fn art_hash(rows: &[Vec<BitRun>], colours: &[u8; 16]) -> u64 {
    let mut h = 0xcbf2_9ce4_8422_2325u64;
    let mut mix = |v: u64| h = (h ^ v).wrapping_mul(0x100_0000_01b3);
    for &c in colours {
        mix(c as u64);
    }
    for r in rows {
        mix(0x1_0000 | r.len() as u64);
        for q in r {
            mix(q.start.map_or(0x200, |k| k as u8 as u64)
                | (q.end as u8 as u64) << 10
                | (q.colour as u64) << 18);
        }
    }
    h
}

impl Smoother {
    /// A new frame's list: its palette (the art classified again if it is another), and the art
    /// not drawn lately dropped.
    fn begin(&mut self, list: &List) {
        if self.pal.is_none() || list.pal != self.pal_key {
            *self = Smoother {
                pal_key: list.pal.clone(),
                pal: Some(smooth::Pal::of(&list.pal)),
                frame: self.frame,
                ..Default::default()
            };
        }
        self.frame = self.frame.wrapping_add(1);
        let f = self.frame;
        self.kept.retain(|k| f.wrapping_sub(k.used) <= KEEP_FRAMES);
        self.bytes = self.kept.iter().map(|k| k.bytes).sum();
    }

    /// The bitmap's art classified (None if it has no corner to cut), and the palette.
    fn grid(&mut self, list: &List, b: &Bitmap) -> Option<(&smooth::ArtGrid, &smooth::Pal)> {
        let pal = self.pal.as_ref()?;
        let rows = &list.bitmaps[b.bits as usize];
        let hash = art_hash(rows, &b.colours);
        let found = self
            .kept
            .iter()
            .position(|k| k.hash == hash && k.colours == b.colours && k.rows == *rows);
        let k = match found {
            Some(k) => k,
            None => {
                let grid = smooth::ArtGrid::new(rows, &b.colours, pal);
                let bytes = std::mem::size_of::<Kept>()
                    + rows
                        .iter()
                        .map(|r| std::mem::size_of_val(&r[..]) + std::mem::size_of::<Vec<BitRun>>())
                        .sum::<usize>()
                    + grid.as_ref().map_or(0, |g| g.bytes());
                // room for it: the art drawn longest ago dropped first
                while !self.kept.is_empty()
                    && (self.kept.len() >= KEEP || self.bytes + bytes > KEEP_BYTES)
                {
                    let f = self.frame;
                    let old = (0..self.kept.len())
                        .max_by_key(|&k| f.wrapping_sub(self.kept[k].used))
                        .unwrap();
                    self.bytes -= self.kept.swap_remove(old).bytes;
                }
                self.kept.push(Kept {
                    hash,
                    rows: rows.clone(),
                    colours: b.colours,
                    used: 0,
                    bytes,
                    grid,
                });
                self.bytes += bytes;
                self.kept.len() - 1
            }
        };
        let kept = &mut self.kept[k];
        kept.used = self.frame;
        kept.grid.as_ref().map(|g| (g, pal))
    }
}

/// Fine pixels [x0, x1) of a row, or none.
type Pixels = Option<(i64, i64)>;

/// A smoothed bitmap's fine rows: its art and colours, its columns as 1AC2 steps them from the
/// anchor, the rows' count at the bitmap's bottom row and its step (1B45); and on the row being
/// drawn, each run's fine pixels as the game draws them and as its own art pixels lie (for which
/// art row and window), where the window's gap leaves nothing of the row to its right, and the
/// piece being put together.
struct SmoothRow<'a> {
    g: &'a smooth::ArtGrid,
    pal: &'a smooth::Pal,
    colours: [u8; 16],
    mirrored: bool,
    ax: i64,
    step: i64,
    at0: i64,
    row_step: i64,
    w: i64,
    ext: Vec<(Pixels, Pixels)>,
    ext_of: Option<(usize, Option<[i64; 4]>)>,
    lost: Option<i64>,
    cur: Option<(i64, i64, u16, u16)>,
}

impl SmoothRow<'_> {
    /// 1AC2: art column k's left on the screen, art-wise (not mirrored, not clamped).
    fn x(&self, k: i32) -> i64 {
        let o = (k.unsigned_abs() as i64 * self.step) >> 16;
        if k < 0 {
            self.ax - o
        } else {
            self.ax + o
        }
    }

    /// Art columns k0 to k1 less one: their fine pixels [x0, x1) on the screen.
    fn bounds(&self, k0: i32, k1: i32) -> (i64, i64) {
        let (a, b) = (self.x(k0), self.x(k1));
        if self.mirrored {
            (2 * self.ax - b, 2 * self.ax - a)
        } else {
            (a, b)
        }
    }

    /// The first fine row (counted from the bitmap's bottom row) in art row r.
    fn first(&self, r: i64) -> i64 {
        ((r << 16) - self.at0 + self.row_step - 1).div_euclid(self.row_step)
    }

    /// The piece put together so far drawn: through its run's fine pixels if a run painted its
    /// art pixel, else through the window on its own (1DBF), and not right of the gap where the
    /// row's runs leave nothing there.
    fn flush(&mut self, out: &mut Vec<Prim>, y: i64, win: Option<[i64; 4]>) {
        let Some((x0, x1, colour, run)) = self.cur.take() else {
            return;
        };
        let span = if run == smooth::NO_RUN {
            let (mut a, mut b) = (x0.max(0), x1.min(self.w).min(self.lost.unwrap_or(i64::MAX)));
            window_clip(&mut a, &mut b, win).then_some((a, b))
        } else {
            self.ext
                .get(run as usize)
                .and_then(|e| e.0)
                .map(|(a, b)| (x0.max(a), x1.min(b)))
        };
        if let Some((a, b)) = span.filter(|(a, b)| b > a) {
            out.push(Prim::Span {
                y: y as u32,
                x0: a as u32,
                x1: b as u32,
                colour: colour as u8,
            });
        }
    }

    /// Fine pixels x0 to x1 less one in `colour`, of an art pixel painted by `run`, the next
    /// along the row: joined to the piece before if they go on from it in its colour and run.
    #[allow(clippy::too_many_arguments)]
    fn put(
        &mut self,
        out: &mut Vec<Prim>,
        y: i64,
        win: Option<[i64; 4]>,
        x0: i64,
        x1: i64,
        colour: u16,
        run: u16,
    ) {
        if x1 <= x0 {
            return;
        }
        if let Some(c) = &mut self.cur {
            if c.1 == x0 && c.2 == colour && c.3 == run {
                c.1 = x1;
                return;
            }
        }
        self.flush(out, y, win);
        if colour != smooth::CLEAR {
            self.cur = Some((x0, x1, colour, run));
        }
    }

    /// Fine row y, the i-th from the bitmap's bottom row, in art row r (whose runs are `runs`).
    #[allow(clippy::too_many_arguments)]
    fn row(
        &mut self,
        out: &mut Vec<Prim>,
        runs: &[BitRun],
        r: usize,
        i: i64,
        y: i64,
        col: &dyn Fn(i8) -> i64,
        win: Option<[i64; 4]>,
    ) {
        // each run's fine pixels as the game's drawer gives them (bit_runs), and its art pixels';
        // and if a run went on past the gap and 1DBF left nothing of the row right of it, the
        // gap's right
        if self.ext_of != Some((r, win)) {
            self.ext.clear();
            let (mut last, mut crossed, mut right) = (0i32, false, false);
            for (q, (span, over)) in runs.iter().zip(run_spans(runs, self.mirrored, col, win)) {
                let k0 = q.start.map_or(last, |k| k as i32);
                last = q.end as i32;
                let own = (last > k0).then(|| self.bounds(k0, last));
                self.ext.push((span, own));
                crossed |= over;
                right |= matches!((span, win), (Some((_, x1)), Some(w)) if x1 > w[3]);
            }
            self.lost = win.filter(|_| crossed && !right).map(|w| w[3]);
            self.ext_of = Some((r, win));
        }
        // where this fine row is in its art row: j of n, from the top (n is 1 or more: under
        // MAGNIFIED the row step is under 1)
        let f = self.first(r as i64);
        let n = (self.first(r as i64 + 1) - f) as i32;
        let j = (n - 1 - (i - f) as i32).clamp(0, n - 1);
        let segs = &self.g.rows[r];
        let mut pieces = [(0i32, 0i32, 0u16); 5];
        // along the screen's row: the art's columns the other way if mirrored
        for t in 0..segs.len() {
            let seg = segs[if self.mirrored { segs.len() - 1 - t } else { t }];
            let (a, b) = self.bounds(seg.k0, seg.k1);
            let Some(cut) = seg.cut else {
                self.put(out, y, win, a, b, seg.colour, seg.run);
                continue;
            };
            let m = smooth::pieces(
                seg.colour,
                &cut,
                (b - a) as i32,
                j,
                n,
                self.pal,
                &mut pieces,
            );
            for p in 0..m {
                let (x0, x1, c) = pieces[if self.mirrored { m - 1 - p } else { p }];
                let (x0, x1) = if self.mirrored {
                    (b - x1 as i64, b - x0 as i64)
                } else {
                    (a + x0 as i64, a + x1 as i64)
                };
                self.put(out, y, win, x0, x1, c, seg.run);
            }
        }
        self.flush(out, y, win);
        // what the game draws of a run beyond its own art pixels (from where the run before was
        // cut, 1DBF), as the game draws it
        for (q, &(span, own)) in runs.iter().zip(&self.ext) {
            let Some((a, b)) = span else { continue };
            let beyond = match own {
                Some((o0, o1)) => [(a, b.min(o0)), (a.max(o1), b)],
                None => [(a, b), (0, 0)],
            };
            for (x0, x1) in beyond.into_iter().filter(|(x0, x1)| x1 > x0) {
                out.push(Prim::Span {
                    y: y as u32,
                    x0: x0 as u32,
                    x1: x1 as u32,
                    colour: self.colours[q.colour as usize],
                });
            }
        }
    }
}

/// 1DBF: fine pixels [dx, cx) through the window's left and right limits and out of its gap (a
/// run across the gap keeps its part left of it), if there is a window; whether any are left.
fn window_clip(dx: &mut i64, cx: &mut i64, win: Option<[i64; 4]>) -> bool {
    if let Some([lo, hi, gap0, gap1]) = win {
        if *dx < lo {
            *dx = lo;
        }
        if *cx > hi {
            *cx = hi;
        }
        if *cx > gap0 && *dx < gap1 {
            if *dx < gap0 {
                *cx = gap0;
            } else if *cx <= gap1 {
                return false;
            } else {
                *dx = gap1;
            }
        }
    }
    *cx > *dx
}

/// A bitmap row's runs on a fine row (the runs of 1D3A): each one's fine pixels through the
/// window if given (1DBF), or none, and whether it went on past the window's gap (its part right
/// of the gap not drawn); a run from where the last ended starts where it was cut.
fn run_spans<'a>(
    runs: &'a [BitRun],
    mirrored: bool,
    col: &'a dyn Fn(i8) -> i64,
    win: Option<[i64; 4]>,
) -> impl Iterator<Item = (Pixels, bool)> + 'a {
    let (mut dx, mut cx) = (0i64, 0i64);
    runs.iter().map(move |r| {
        match r.start {
            Some(k) if mirrored => cx = col(k),
            Some(k) => dx = col(k),
            None if mirrored => cx = dx,
            None => dx = cx,
        }
        if mirrored {
            dx = col(r.end);
        } else {
            cx = col(r.end);
        }
        let over =
            matches!(win, Some([lo, hi, gap0, gap1]) if dx.max(lo) < gap0 && cx.min(hi) > gap1);
        (window_clip(&mut dx, &mut cx, win).then_some((dx, cx)), over)
    })
}

/// A bitmap row's runs on fine row y (the runs of 1D3A), through the window's left and right
/// limits and its gap if given.
fn bit_runs(
    out: &mut Vec<Prim>,
    runs: &[BitRun],
    y: i64,
    b: &Bitmap,
    col: &dyn Fn(i8) -> i64,
    win: Option<[i64; 4]>,
) {
    for (r, (span, _)) in runs.iter().zip(run_spans(runs, b.mirrored, col, win)) {
        if let Some((x0, x1)) = span {
            out.push(Prim::Span {
                y: y as u32,
                x0: x0 as u32,
                x1: x1 as u32,
                colour: b.colours[r.colour as usize],
            });
        }
    }
}

/// The list's primitives at scale `s` (1 to 64), the bitmaps as their pixels.
pub fn prims(list: &List, s: u32) -> Prims {
    prims_with(list, s, None)
}

/// The list's primitives at scale `s` (1 to 64), the bitmaps drawn larger than their art as
/// `art` says.
pub fn prims_in(list: &List, s: u32, art: Art) -> Prims {
    match art {
        Art::Pixels => prims_with(list, s, None),
        Art::Smooth => prims_with(list, s, Some(&mut Smoother::default())),
    }
}

/// As prims_in: Art::Smooth with the art `smoother` has kept from the frames before (the same
/// primitives as with a new one), or Art::Pixels without one.
pub fn prims_with(list: &List, s: u32, mut smoother: Option<&mut Smoother>) -> Prims {
    if let Some(sm) = smoother.as_deref_mut() {
        sm.begin(list);
    }
    assert!((1..=64).contains(&s), "scale {s}");
    let sc = Scale {
        s: s as i32,
        w: (list::W * s) as i32,
        h: (list::H * s) as i32,
    };
    let mut arena = Vec::new();
    let mut stats = Stats::default();
    let mut built: Vec<Option<Built>> = vec![None; list.edges.len()];
    let mut out = Vec::new();
    let si = s as i32;
    for cmd in &list.cmds {
        match cmd {
            Cmd::Poly { colour, mode, ring } => {
                let mut fine: Vec<(u8, usize)> = Vec::with_capacity(ring.len());
                let mut or = 0u8;
                for &Entry { edge, turn } in ring {
                    let b = match built[edge as usize] {
                        Some(b) => b,
                        None => {
                            let mut bd = Builder {
                                sc,
                                list,
                                arena: &mut arena,
                                stats: &mut stats,
                            };
                            let b = bd.build(&list.edges[edge as usize]);
                            built[edge as usize] = Some(b);
                            b
                        }
                    };
                    or |= b.flags;
                    if b.flags & 0x80 == 0 {
                        fine.push((if turn { b.flags ^ 0x40 } else { b.flags }, b.rec));
                    }
                }
                stats.polys += 1;
                let before = out.len();
                if !fine.is_empty() {
                    let mut f = Fill {
                        sc,
                        list,
                        arena: &arena,
                        ring: &fine,
                        mode: (or as u16 | mode) as u8 & 0x3f,
                        colour: *colour,
                        l: 0,
                        r: 0,
                        lf: 0,
                        rf: 0,
                        left: 0,
                        on: 0,
                        si: Src::Rec(0),
                        bx: Src::Rec(0),
                        dx: 0,
                        out: &mut out,
                    };
                    f.run();
                }
                if out.len() == before {
                    stats.empty += 1;
                }
            }
            &Cmd::Rows {
                y0,
                y1,
                colour,
                window,
            } => {
                for g in y0 as i32..y1 as i32 {
                    if window && list.window_at(0, g) == 0 {
                        continue;
                    }
                    for y in g * si..(g + 1) * si {
                        if !window {
                            out.push(Prim::Span {
                                y: y as u32,
                                x0: 0,
                                x1: sc.w as u32,
                                colour,
                            });
                            continue;
                        }
                        for (a, b) in [(3, 1), (2, 4)] {
                            let (l, r) = (list.window_at(a, g) as i32, list.window_at(b, g) as i32);
                            if r - l > 0 {
                                out.push(Prim::Span {
                                    y: y as u32,
                                    x0: (l * si) as u32,
                                    x1: (r * si) as u32,
                                    colour,
                                });
                            }
                        }
                    }
                }
            }
            &Cmd::Run { y, x0, x1, colour } => out.push(Prim::Run {
                y: y as u32,
                x0: x0 as u32,
                x1: x1 as u32,
                colour,
            }),
            &Cmd::Texel { x, y, delta } => out.push(Prim::Texel {
                x: x as u32,
                y: y as u32,
                delta,
            }),
            Cmd::Bitmap(b) => bitmap(&mut out, list, b, sc, smoother.as_deref_mut()),
        }
    }
    Prims {
        s,
        w: sc.w as u32,
        h: sc.h as u32,
        prims: out,
        stats,
    }
}

/// The list's edge `k` built at scale `s` on its own: the slot's flags, its record (lower row,
/// upper row, x at each, the x of each row, the end) if it has something to draw, and the
/// counts kept while building it.
pub fn edge_at(list: &List, k: usize, s: u32) -> (u8, Option<Vec<i32>>, Stats) {
    let sc = Scale {
        s: s as i32,
        w: (list::W * s) as i32,
        h: (list::H * s) as i32,
    };
    let (mut arena, mut stats) = (Vec::new(), Stats::default());
    let b = Builder {
        sc,
        list,
        arena: &mut arena,
        stats: &mut stats,
    }
    .build(&list.edges[k]);
    let rec = (b.rec != NONE).then(|| {
        let end = arena[b.rec + 4..].iter().position(|&v| v == END).unwrap();
        arena[b.rec..b.rec + 5 + end].to_vec()
    });
    (b.flags, rec, stats)
}

/// The primitives painted in order over `init` (w x h fine pixels, or zeros).
pub fn draw(p: &Prims, init: Option<&[u8]>) -> Vec<u8> {
    let (w, s) = (p.w as usize, p.s as usize);
    let mut buf = match init {
        Some(b) => b.to_vec(),
        None => vec![0; w * p.h as usize],
    };
    for prim in &p.prims {
        match *prim {
            Prim::Span { y, x0, x1, colour } => {
                let at = y as usize * w;
                buf[at + x0 as usize..at + x1 as usize].fill(colour);
            }
            Prim::Run { y, x0, x1, colour } => {
                for yy in y as usize * s..(y as usize + 1) * s {
                    let at = yy * w;
                    buf[at + x0 as usize * s..at + x1 as usize * s].fill(colour);
                }
            }
            Prim::Texel { x, y, delta } => {
                for yy in y as usize * s..(y as usize + 1) * s {
                    for xx in x as usize * s..(x as usize + 1) * s {
                        let c = &mut buf[yy * w + xx];
                        if *c == 0x12 || *c == 0x1a {
                            *c = c.wrapping_add(delta as u8);
                        }
                    }
                }
            }
        }
    }
    buf
}

/// The primitives as the GPU takes them: four words each (the kind and colour or shade, then
/// row, x0, x1), in paint order.
pub fn words(p: &Prims) -> Vec<u32> {
    let mut v = Vec::with_capacity(4 * p.prims.len());
    for prim in &p.prims {
        let w = match *prim {
            Prim::Span { y, x0, x1, colour } => [colour as u32, y, x0, x1],
            Prim::Run { y, x0, x1, colour } => [1 << 8 | colour as u32, y, x0, x1],
            Prim::Texel { x, y, delta } => [2 << 8 | delta as u8 as u32, y, x, x + 1],
        };
        v.extend(w);
    }
    v
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A smoothed bitmap's runs through the cockpit's window as 1DBF cuts them: a run across the
    /// gap keeps its part left of it, and the next, from where it ended, starts at the gap's
    /// right (over the first run's art pixels there), as the game draws them.
    #[test]
    fn smoothed_through_the_window() {
        let s = 4;
        // six rows: a staircase on clear (cut), then runs in colours 1 and 2, the second from
        // where the first ended
        let rows: Vec<Vec<BitRun>> = (0..6)
            .map(|r| {
                vec![
                    BitRun {
                        start: Some(r - 10),
                        end: 0,
                        colour: 3,
                    },
                    BitRun {
                        start: None,
                        end: 20,
                        colour: 1,
                    },
                    BitRun {
                        start: None,
                        end: 30,
                        colour: 2,
                    },
                ]
            })
            .collect();
        let list = through_the_gap(rows);
        let (px, sm) = (prims(&list, s), prims_in(&list, s, Art::Smooth));
        let (a, b) = (draw(&px, None), draw(&sm, None));
        assert_ne!(a, b, "not smoothed");
        let w = px.w as usize;
        for y in 377..=400 {
            // the first run's art pixels right of the gap's left, art columns 3 to 19
            let (p, q) = (&a[y * w + 412..y * w + 480], &b[y * w + 412..y * w + 480]);
            assert_eq!(p, q, "row {y}");
            assert_eq!(p[20..], [32; 48], "row {y}");
        }
    }

    /// The window from game row 90, open from 0 to 103 and from 108 to 320, for a bitmap at game
    /// column 100 and row 100 drawn one game pixel to an art pixel, its rows bottom row first.
    fn through_the_gap(rows: Vec<Vec<BitRun>>) -> List {
        let mut window = vec![0u16; 5 * 0x53];
        for g in 0..0x53 {
            for (k, v) in [(0, 1), (1, 103), (2, 108), (3, 0), (4, 320)] {
                window[k * 0x53 + g] = v;
            }
        }
        let b = Bitmap {
            bits: 0,
            colours: std::array::from_fn(|c| 16 * c as u8),
            anchor: None,
            col: 100,
            row: 100,
            size: 1,
            below: 0,
            depth: 1,
            scale: 0,
            rows_by: None,
            mirrored: false,
            top: 90,
        };
        List {
            cmds: vec![Cmd::Bitmap(Box::new(b))],
            window,
            bitmaps: vec![rows],
            ..Default::default()
        }
    }

    /// A staircase on clear (both ends) whose rows each go on past the window's gap: 1DBF draws
    /// them only left of it, and the pieces grown into the clear cells at their right ends are
    /// not drawn right of it either.
    #[test]
    fn grown_not_past_the_gap() {
        let s = 4;
        let rows: Vec<Vec<BitRun>> = (0..6)
            .map(|r| {
                vec![BitRun {
                    start: Some(-r),
                    end: 10 + r,
                    colour: 1,
                }]
            })
            .collect();
        let list = through_the_gap(rows);
        let (px, sm) = (prims(&list, s), prims_in(&list, s, Art::Smooth));
        let (a, b) = (draw(&px, None), draw(&sm, None));
        assert_ne!(a, b, "not smoothed");
        let w = px.w as usize;
        for y in 0..px.h as usize {
            assert!(
                a[y * w + 412..y * w + 640].iter().all(|&c| c == 0),
                "row {y}"
            );
            assert!(
                b[y * w + 412..y * w + 640].iter().all(|&c| c == 0),
                "row {y}"
            );
        }
    }

    /// The pixels the primitives paint, later over earlier, row by row from x 0 (u16::MAX where
    /// none paints).
    fn raster(p: &Prims) -> std::collections::BTreeMap<u32, Vec<u16>> {
        let mut rows = std::collections::BTreeMap::new();
        for prim in &p.prims {
            let Prim::Span { y, x0, x1, colour } = *prim else {
                panic!("{prim:?}");
            };
            let row: &mut Vec<u16> = rows.entry(y).or_default();
            if row.len() < x1 as usize {
                row.resize(x1 as usize, u16::MAX);
            }
            row[x0 as usize..x1 as usize].fill(colour as u16);
        }
        rows
    }

    /// A made-up bitmap drawn magnified or not: rows of runs that start where the last ended or
    /// further on (now and then over the last), in some of 16 colours, mirrored or not, at
    /// scale s, through a window with a gap from some row or none; and a palette.
    fn made_up(rnd: &mut dyn FnMut(u32) -> u32, window: bool) -> (List, u32) {
        let big = rnd(16) == 0;
        let s = 1 + rnd(if big { 64 } else { 8 });
        let n = 1 + rnd(30) as usize;
        let rows: Vec<Vec<BitRun>> = (0..n)
            .map(|_| {
                let mut runs = Vec::new();
                let mut last = rnd(30) as i32 - 20;
                for i in 0..rnd(6) {
                    let start = if i == 0 || rnd(3) == 0 {
                        last += rnd(4) as i32;
                        if rnd(25) == 0 {
                            last -= 1 + rnd(3) as i32;
                        }
                        Some(last as i8)
                    } else {
                        None
                    };
                    last += rnd(8) as i32;
                    runs.push(BitRun {
                        start,
                        end: last as i8,
                        colour: rnd(16) as u8,
                    });
                }
                runs
            })
            .collect();
        let mut win = vec![0u16; 5 * 0x53];
        for g in 0..0x53 {
            let gap0 = 100 + rnd(100) as u16;
            for (k, v) in [
                (0, (rnd(8) != 0) as u16),
                (1, gap0),
                (2, gap0 + rnd(30) as u16),
                (3, rnd(100) as u16),
                (4, 200 + rnd(121) as u16),
            ] {
                win[k * 0x53 + g] = v;
            }
        }
        let b = Bitmap {
            bits: 0,
            colours: std::array::from_fn(|_| [0, 16, 31, 40, 64, 200, 201, 250][rnd(8) as usize]),
            anchor: None,
            col: if window { rnd(360) as i16 - 20 } else { 160 },
            row: rnd(164) as i16,
            size: 2 + rnd(80) as u16,
            below: rnd(n as u32) as u16,
            depth: 16,
            scale: 0x1000 + rnd(0xb000) as u16,
            rows_by: (rnd(3) != 0).then(|| 0x4000 + rnd(0xc000) as u16),
            mirrored: rnd(2) == 0,
            top: if window { 60 + rnd(110) as i16 } else { 1000 },
        };
        let list = List {
            cmds: vec![Cmd::Bitmap(Box::new(b))],
            window: win,
            bitmaps: vec![rows],
            pal: (0..768).map(|_| rnd(64) as u8).collect(),
            ..Default::default()
        };
        (list, s)
    }

    fn rng(mut seed: u32) -> impl FnMut(u32) -> u32 {
        move |n: u32| {
            seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
            (seed >> 8) % n
        }
    }

    /// With every cut left out, the smoothed path draws the drawer's pixels: art pixels as
    /// pieces and as stretches, mirrored, through the window and its gap, by runs from where the
    /// last ended, at scales 1 to 64.
    #[test]
    fn nothing_cut_is_pixels() {
        smooth::NO_CUTS.set(true);
        let mut rnd = rng(7);
        let mut smoothed = 0;
        for trial in 0..4000 {
            let (list, s) = made_up(&mut rnd, true);
            let sm = prims_in(&list, s, Art::Smooth);
            let px = prims(&list, s);
            smoothed += (sm.prims != px.prims) as u32;
            assert_eq!(raster(&sm), raster(&px), "trial {trial}: {list:?} at {s}");
        }
        smooth::NO_CUTS.set(false);
        assert!(smoothed > 1000, "{smoothed} drawn otherwise");
    }

    /// A bitmap turned the other way (no window, the screen's sides not reached) is the mirror
    /// image of itself the right way round about its anchor, smoothed as drawn as pixels.
    #[test]
    fn mirrored_is_mirror_image() {
        let mut rnd = rng(11);
        let mut differ = 0;
        for trial in 0..2000 {
            let (mut list, s) = made_up(&mut rnd, false);
            let Cmd::Bitmap(b) = &mut list.cmds[0] else {
                unreachable!()
            };
            b.size = 2 + (b.size % 30);
            let ax = b.col as i64 * s as i64;
            let mut pics = Vec::new();
            for mirrored in [false, true] {
                let Cmd::Bitmap(b) = &mut list.cmds[0] else {
                    unreachable!()
                };
                b.mirrored = mirrored;
                let (px, sm) = (prims(&list, s), prims_in(&list, s, Art::Smooth));
                differ += (mirrored && px.prims != sm.prims) as u32;
                pics.push([raster(&px), raster(&sm)]);
            }
            let flip = |rows: &std::collections::BTreeMap<u32, Vec<u16>>| {
                let mut out = std::collections::BTreeMap::new();
                for (&y, row) in rows {
                    for (x, &c) in row.iter().enumerate().filter(|(_, &c)| c != u16::MAX) {
                        let fx = (2 * ax - 1 - x as i64) as usize;
                        let r: &mut Vec<u16> = out.entry(y).or_default();
                        if r.len() <= fx {
                            r.resize(fx + 1, u16::MAX);
                        }
                        r[fx] = c;
                    }
                }
                out
            };
            for (k, (right, other)) in pics[0].iter().zip(&pics[1]).enumerate() {
                assert_eq!(flip(right), *other, "trial {trial} ({k}): {list:?}");
            }
        }
        assert!(differ > 500, "{differ} smoothed");
    }
}
