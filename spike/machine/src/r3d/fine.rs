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
//!   s times longer and the cockpit's window tables read at the game row each fine row lies in.
//!
//! The rest is drawn as game pixels made s x s: bitmaps, poles, the crowd, the scenery, the
//! dithered sky rows and the cockpit's pieces (pixel art either way, for now); the ground
//! texture's shade goes on the fine pixels of road and grass within its game pixel.
//!
//! The output is a list of primitives in paint order, each over the ones before it: spans of
//! fine pixels, runs of game pixels, and texels. `draw` paints them; the GPU paints the same
//! list with each pixel keeping the highest of (primitive number, colour).

use super::list::{self, Cmd, Edge, EdgeOf, Entry, List, Pt};

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

/// The list's primitives at scale `s` (1 to 64).
pub fn prims(list: &List, s: u32) -> Prims {
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
