//! The bitmap drawer (gp.exe 0F47:19E8 to 1FAC, a near routine, with 1931 its colours;
//! docs/renderer-notes.md, "Bitmaps"): wheels, helmets, boards, flags, marshals, trees and the
//! distant cars, scaled by their depth and drawn flat.
//!
//! The bitmaps are in the segment SS:00F8, far pointers at +0238 by id. A bitmap's header: +0 its
//! size (bit 15: an alias, the low byte the id to draw; bits 15 and 14: not drawn), +2 its row
//! table's bytes, +4 its columns either side of the anchor, +6 its rows below the anchor, +8 the
//! rows' offsets. Row 0 is the bottom row. A row is a list of runs: a byte c (0 ends the row; bit
//! 7: a start column follows, else the run starts where the last ended), then the columns as
//! bytes, signed from the anchor column; the run's colour is the object's colour (c & 7Eh) / 2 - 2.
//!
//! The drawer works in the bitmaps' segment: the 16 colour words at +0000 (1931: the object's
//! palette, hazed by its depth), each bitmap column's screen x from +0020 (columns 0 to 127 up,
//! -128 to -1 from +0220 down), and its variables at +0220 to +0237. Rows go up the screen from
//! the bottom row; rows from SS:[bp+132] down go through the cockpit's window (SS:6364), and in
//! the mirror (SS:[bp+134] set) every row goes through the mirror's (SS:63DE).
//!
//! Each step below names the game's instruction it stands for.

use super::list;
use super::Mem;

/// The bitmap's id (AX), its anchor row (CX) and the offset of its object's colours (DX), with
/// SS:[bp+88] its anchor column, [bp+8C] its depth and [bp+12E] bit 15 to mirror it.
pub fn bitmap(m: Mem, bp: u16, id: u16, row: u16, colours: u16) {
    let ds = m.w(m.ss, 0xf8);
    let es = 0;
    let mut b = Bitmap {
        m,
        bp,
        ds,
        es,
        bx: 0,
    };
    b.run(id, row, colours);
}

struct Bitmap<'a> {
    m: Mem<'a>,
    bp: u16,
    /// the bitmaps' segment (DS), and the back buffer's (ES)
    ds: u16,
    es: u16,
    /// the bitmap's header
    bx: u16,
}

/// A loop over the bitmap's rows (19E8 has four, and switches between them).
#[derive(Clone, Copy)]
enum Rows {
    Plain,
    Window,
}

/// A column clamped to the screen: 0 to 320.
fn on_screen(x: u16) -> u16 {
    if x < 0x140 {
        x
    } else if x as i16 >= 0x140 {
        0x140
    } else {
        0
    }
}

impl Bitmap<'_> {
    fn d(&self, o: u16) -> u16 {
        self.m.w(self.ds, o)
    }
    fn set_d(&mut self, o: u16, v: u16) {
        let ds = self.ds;
        self.m.set_w(ds, o, v);
    }
    fn db(&self, o: u16) -> u8 {
        self.m.b(self.ds, o)
    }
    /// SS:[bp+o]
    fn s(&self, o: u16) -> u16 {
        self.m.w(self.m.ss, self.bp.wrapping_add(o))
    }
    fn set_s(&mut self, o: u16, v: u16) {
        let ss = self.m.ss;
        self.m.set_w(ss, self.bp.wrapping_add(o), v);
    }
    /// SS:o
    fn ss(&self, o: u16) -> u16 {
        self.m.w(self.m.ss, o)
    }
    /// The 32-bit value at +o (low word) and +o+2.
    fn d32(&self, o: u16) -> u32 {
        self.d(o) as u32 | (self.d(o + 2) as u32) << 16
    }
    fn set_d32(&mut self, o: u16, v: u32) {
        self.set_d(o, v as u16);
        self.set_d(o + 2, (v >> 16) as u16);
    }

    fn run(&mut self, mut id: u16, row: u16, colours: u16) {
        // 19F0: the bitmap, following an alias
        loop {
            self.set_s(0x180, id);
            let p = (id << 2).wrapping_add(0x238);
            let (seg, off) = (self.d(p.wrapping_add(2)), self.d(p));
            self.ds = seg;
            self.bx = off;
            self.set_d(0x22c, row);
            self.set_d(0x22a, colours);
            let size = self.d(self.bx);
            if (size as i16) >= 0 {
                break;
            }
            if size & 0x4000 != 0 {
                return; // not drawn
            }
            id = size & 0xff;
        }
        let bx = self.bx;
        // 1A19: the scale, size * 8192 / depth, 1 to 8000h
        let n = ((self.d(bx) as i16 as i32) << 16) >> 3;
        let depth = self.s(0x8c);
        if depth as i16 <= 0 {
            return;
        }
        self.set_s(0x16c, depth);
        let mut scale = self.m.div((n >> 16) as u16, n as u16, depth).0;
        if scale == 0 {
            scale = 1;
        }
        scale = scale.min(0x8000);
        self.set_d(0x234, scale);
        let step = (scale as u32) << 3;
        self.set_s(0x8c, step as u16);
        self.set_s(0x8e, (step >> 16) as u16);
        let x = self.s(0x88);
        if x >= 0x140 {
            // 1A72: an anchor off the screen, and the bitmap too
            let w = (((self.d(bx.wrapping_add(4)) as u32 * scale as u32) << 3) >> 16) as u16;
            let right = w.wrapping_add(x);
            if (right as i16) < 0 {
                return;
            }
            let left = x.wrapping_sub(right.wrapping_sub(x));
            if left as i16 >= 0x140 {
                return;
            }
        }
        // 1AA1
        self.set_d(0x230, self.s(0x12e));
        let window_mode = self.m.b(self.m.ss, self.bp.wrapping_add(0x134));
        let ds = self.ds;
        self.m.set_b(ds, 0x232, window_mode);
        self.set_d(0x236, self.s(0x132));
        let columns = self.d(bx.wrapping_add(4));
        if columns == 0 {
            return;
        }
        self.columns(x, columns);
        self.colours();
        self.rows(bx);
    }

    /// 1AC2: each bitmap column's screen x, from the anchor out both ways.
    fn columns(&mut self, x: u16, columns: u16) {
        self.set_s(0x84, columns);
        let (mut cx, mut dx) = (x, x);
        let mut ax = self.s(0x8e);
        let mut acc = 0u16;
        let mut dir = 1u16;
        if (self.d(0x230) as i16) < 0 {
            ax = ax.wrapping_neg();
            dir = 0xffff;
        }
        self.set_s(0x94, dir);
        let (mut si, mut di) = (0x20u16, 0x220u16);
        loop {
            self.set_d(si, on_screen(cx));
            si = si.wrapping_add(2);
            let k = self.s(0x84).wrapping_sub(1);
            self.set_s(0x84, k);
            if (k as i16) < 0 {
                break;
            }
            // 1AF6
            let (a, carry) = acc.overflowing_add(self.s(0x8c));
            acc = a;
            if carry {
                cx = cx.wrapping_add(dir);
                dx = dx.wrapping_sub(dir);
            }
            cx = cx.wrapping_add(ax);
            dx = dx.wrapping_sub(ax);
            di = di.wrapping_sub(2);
            self.set_d(di, on_screen(dx));
        }
    }

    /// 1931: the object's 16 colours, hazed by the bitmap's depth (SS:016C), as words at +0000.
    fn colours(&mut self) {
        let si = self.d(0x22a);
        let ss = self.m.ss;
        let dx = (self.ss(0x16c).wrapping_add(0x80) as i16).clamp(0, 0x3c00) as u16;
        let level = if self.ss(0x122e) != 0 {
            // 1962: wet: the level from SS:0182
            let p = (self.ss(0x182) as i16 as i32 * dx as i16 as i32) as u32;
            let mut l = ((p >> 16) as u8) << 1 | (p >> 15) as u8 & 1;
            if l > 4 {
                l = 4;
            }
            if (l as i8) < 1 {
                l = 1;
            }
            l
        } else {
            // 197E
            let mut h = ((dx >> 8) as u8).wrapping_sub(5);
            if (h as i8) < 0 {
                h = 0;
            }
            h = ((h as i8) >> 3) as u8;
            if h as i8 > 4 {
                h = 4;
            }
            h
        }
        .wrapping_sub(1);
        self.m.set_b(ss, 0x185, level);
        let haze = self.m.w(self.m.cs, 0x19a4);
        for k in 0..16u16 {
            let c = self.m.b(ss, k.wrapping_add(si).wrapping_add(0x2964));
            let c = if (level as i8) < 0 {
                c
            } else if level as i8 >= 4 {
                self.m.b(ss, 0x1b2)
            } else {
                let at = ((level as u16) << 8 | c as u16).wrapping_add(0x7bc0);
                self.m.b(haze, at)
            };
            self.set_d(2 * k, (c as u16) << 8 | c as u16);
        }
    }

    /// 1B45: the rows, from the bottom row up.
    fn rows(&mut self, bx: u16) {
        let id = self.s(0x180);
        if id != 0xaf && id != 0xaa && id != 0xab {
            let s = ((self.d(0x234) as u32 * self.s(0x17e) as u32) >> 16) as u16;
            self.set_d(0x234, s);
        }
        let scale = self.d(0x234);
        let below = (((self.d(bx.wrapping_add(6)) as u32 * scale as u32) << 3) >> 16) as u16;
        let mut cx = self.d(0x22c).wrapping_add(below);
        self.set_d(0x22c, cx);
        // 1B81: a bitmap row's height in screen rows' steps, 16.16
        let ss = self.m.ss;
        self.m.set_b(ss, 0xc0, 0);
        let mut q = self.m.div(0x100, 0, scale).0;
        if self.m.b(ss, 0xc0) != 0 {
            q = 0xffff;
        }
        if q == 0 {
            return;
        }
        let step = (q as u32) << 5;
        self.set_d32(0x224, step);
        // 1BC7: the bitmap row at the anchor's screen row less `below`
        let mut at = ((q as u32 * below as u32) << 5).wrapping_neg();
        at = at.wrapping_add((self.d(bx.wrapping_add(6)) as u32) << 16);
        while (at as i32) < 0 {
            at = at.wrapping_add(step);
        }
        self.set_d32(0x220, at);
        let mirrored = (self.d(0x230) as i16) < 0;
        let (mut rows, mut di, mut bp);
        if self.db(0x232) != 0 {
            // 1C01: the mirror: rows 116 to 137 of the screen
            cx = cx.wrapping_sub(self.s(0x130)).wrapping_add(0x7b);
            if (cx as i16) < 0x74 {
                return;
            }
            while cx as i16 >= 0x8a {
                // 1C18 (the game tests the low word here)
                let v = self.d32(0x220).wrapping_add(self.d32(0x224));
                self.set_d32(0x220, v);
                if v as u16 as i16 >= self.d(bx.wrapping_add(2)) as i16 {
                    return;
                }
                cx = cx.wrapping_sub(1);
            }
            self.set_d(0x22c, cx);
            di = self.back_buffer(cx);
            bp = 0x63deu16.wrapping_add(cx.wrapping_sub(0x74) << 1);
            self.set_d(0x22e, 0x74);
            rows = Rows::Window;
        } else {
            // 1C7A
            if cx >= 0xa4 {
                if (cx as i16) < 0 {
                    return;
                }
                while cx as i16 >= 0xa4 {
                    // 1C85: rows below the screen
                    if self.next_row(bx).is_none() {
                        return;
                    }
                    cx = cx.wrapping_sub(1);
                }
                self.set_d(0x22c, cx);
            }
            di = self.back_buffer(cx);
            self.set_d(0x22e, self.d(0x236));
            bp = 0x6364u16.wrapping_add(cx.wrapping_sub(self.d(0x236)) << 1);
            rows = if cx as i16 >= self.d(0x236) as i16 {
                Rows::Window
            } else {
                Rows::Plain
            };
        }
        loop {
            let Some(si) = self.next_row(bx) else {
                return;
            };
            match rows {
                Rows::Plain => {
                    self.runs(si, di, mirrored, None);
                    di = di.wrapping_sub(0x140);
                    let r = self.d(0x22c).wrapping_sub(1);
                    self.set_d(0x22c, r);
                    if (r as i16) < 0 {
                        return;
                    }
                }
                Rows::Window => {
                    if self.m.w(self.m.ss, bp) != 0 {
                        self.runs(si, di, mirrored, Some(bp));
                    }
                    bp = bp.wrapping_sub(2);
                    di = di.wrapping_sub(0x140);
                    let r = self.d(0x22c).wrapping_sub(1);
                    self.set_d(0x22c, r);
                    if (r as i16) < self.d(0x22e) as i16 {
                        if self.db(0x232) != 0 {
                            return;
                        }
                        rows = Rows::Plain;
                    }
                }
            }
        }
    }

    /// The back buffer (the far pointer R:001C, R = SS:00F4) at screen row `row`.
    fn back_buffer(&mut self, row: u16) -> u16 {
        let r = self.ss(0xf4);
        self.es = self.m.w(r, 0x1e);
        self.m.w(r, 0x1c).wrapping_add(0x140u16.wrapping_mul(row))
    }

    /// The next bitmap row for a screen row (its runs' offset), moving the bitmap row on by one
    /// screen row; None past the bitmap's top row.
    fn next_row(&mut self, bx: u16) -> Option<u16> {
        let at = self.d32(0x220);
        self.set_d32(0x220, at.wrapping_add(self.d32(0x224)));
        let si = ((at >> 16) as u16) << 1;
        if si as i16 >= self.d(bx.wrapping_add(2)) as i16 {
            return None;
        }
        Some(self.d(bx.wrapping_add(si).wrapping_add(8)).wrapping_add(bx))
    }

    /// A bitmap row's runs at es:di (the row's start), `mirrored` with the columns the other
    /// way, through the window's row tables at SS:bp if given.
    fn runs(&mut self, mut si: u16, di: u16, mirrored: bool, window: Option<u16>) {
        let col = |b: &Self, si: u16| b.d(0x20 + 2 * b.db(si) as u16);
        let mut c = self.db(si);
        si = si.wrapping_add(1);
        if c == 0 {
            return;
        }
        // start (DX, or CX mirrored) and end (CX, or DX mirrored) of the run
        let (mut dx, mut cx) = (0u16, 0u16);
        let mut new_start = true;
        loop {
            if new_start {
                let v = col(self, si);
                si = si.wrapping_add(1);
                if mirrored {
                    cx = v;
                } else {
                    dx = v;
                }
            }
            let v = col(self, si);
            si = si.wrapping_add(1);
            if mirrored {
                dx = v;
            } else {
                cx = v;
            }
            let colour = self.d(((c & 0x7e) as u16).wrapping_sub(4));
            let mut draw = true;
            if let Some(bp) = window {
                // 1DBF: clipped to the window's limits and out of its gap
                let t = |b: &Self, o: u16| b.m.w(b.m.ss, bp.wrapping_add(o)) as i16;
                if (dx as i16) < t(self, 0x1f2) {
                    dx = t(self, 0x1f2) as u16;
                }
                if cx as i16 > t(self, 0x298) {
                    cx = t(self, 0x298) as u16;
                }
                if cx as i16 > t(self, 0xa6) && (dx as i16) < t(self, 0x14c) {
                    if (dx as i16) < t(self, 0xa6) {
                        cx = t(self, 0xa6) as u16;
                    } else if cx as i16 <= t(self, 0x14c) {
                        draw = false;
                    } else {
                        dx = t(self, 0x14c) as u16;
                    }
                }
            }
            if draw && cx as i16 > dx as i16 {
                self.fill(di.wrapping_add(dx), cx.wrapping_sub(dx), colour);
            }
            c = self.db(si);
            si = si.wrapping_add(1);
            if c == 0 {
                return;
            }
            new_start = c & 0x80 != 0;
            if !new_start {
                if mirrored {
                    cx = dx;
                } else {
                    dx = cx;
                }
            }
        }
    }

    /// STOSB if n is odd, then REP STOSW: n bytes of the colour word's two bytes.
    fn fill(&mut self, mut di: u16, n: u16, colour: u16) {
        let es = self.es;
        let mut words = n >> 1;
        if n & 1 != 0 {
            self.m.set_b(es, di, colour as u8);
            list::px(es, di, colour as u8);
            di = di.wrapping_add(1);
        }
        while words > 0 {
            self.m.set_w(es, di, colour);
            list::px(es, di, colour as u8);
            list::px(es, di.wrapping_add(1), (colour >> 8) as u8);
            di = di.wrapping_add(2);
            words -= 1;
        }
    }
}
