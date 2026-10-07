//! The edge code (gp.exe 0F47:0000 to 0998; docs/renderer-notes.md, section 7): the edge records
//! the polygon filler reads (src/r3d/fill.rs), made from the projected points.
//!
//! A point is a record in DS (R) at [bp+30] plus an offset: its screen x and y at +0 and +2, its
//! outcode at +4, and before it, at -6, -4 and -2, its camera-space x, y and depth. Outcode bits:
//! 1 below the screen (y 164 or more), 2 above it (y below 0), 4 right of it (x 320 or more), 8
//! left of it (x below 0), 10h behind the near plane; 8000h marks a point whose camera-space x and
//! depth are kept eight times finer.
//!
//! The edge builder (03E9) takes two points and an edge slot of 4 bytes (a flags word and a
//! pointer to the edge's record, which it writes at R:02AA and moves past). It clips the edge to
//! the screen (cutting it at depth 8 first if one end is behind the near plane) and writes the
//! record: its lower (larger) row, its upper row, its x at each, then the x of each row from the
//! lower row less one up, ending with 8000h; a line stepped with an error term (0856). The slot's
//! flags: 40h the edge runs the other way; 80h and up, nothing to draw (off the screen, flat, or
//! no room for its record), with the side it is off in the low bits; the low byte also carries
//! bits from the tables R:0274 and R:0284 for the sides its ends were off.
//!
//! The border edge (02E4) writes a record of one row for a point at the screen's side: from x 0
//! or 320 to the point's x.
//!
//! Each step below names the game's instruction it stands for.

use super::Mem;

/// R:02AA past this: no room for another edge record
const FULL: u16 = 0xd58c;

/// The edge code's registers and memory.
struct Edge<'a> {
    m: Mem<'a>,
    bp: u16,
}

/// Build the edge from the point at [bp+30]+cx to the one at [bp+30]+dx in the slot at R:di+ax
/// (0F47:03E9, a near routine: it leaves the registers as they were).
pub fn edge(m: Mem, bp: u16, ax: u16, cx: u16, dx: u16, di: u16) {
    Edge { m, bp }.build(di.wrapping_add(ax), cx, dx);
}

/// The border edge (0F47:02E4, a near routine that leaves the registers): the point at
/// [bp+30]+dx joined to the screen's left side (cx 8) or right (else) in the slot at R:di+ax,
/// with bl ORed into the slot's flags and si the caller's segment record.
#[allow(clippy::too_many_arguments)]
pub fn border(m: Mem, bp: u16, ax: u16, bl: u8, cx: u16, dx: u16, si: u16, di: u16) {
    Edge { m, bp }.border(di.wrapping_add(ax), bl, cx, dx, si);
}

/// The screen's side a point is off, across: 8 left (x below 0), 4 right (x 320 or more).
fn off_x(x: u16) -> u16 {
    if x < 0x140 {
        0
    } else if x as i16 >= 0x140 {
        4
    } else {
        8
    }
}
/// Up and down: 1 below (y 164 or more), 2 above (y below 0).
fn off_y(y: u16) -> u16 {
    if y < 0xa4 {
        0
    } else if y as i16 >= 0xa4 {
        1
    } else {
        2
    }
}

/// MUL, its high word.
fn mul_hi(a: u16, b: u16) -> u16 {
    ((a as u32 * b as u32) >> 16) as u16
}

impl Edge<'_> {
    /// A word in R at p+d.
    fn rw(&self, p: u16, d: u16) -> u16 {
        self.m.rw(p.wrapping_add(d))
    }
    fn rb(&self, p: u16, d: u16) -> u8 {
        self.m.rb(p.wrapping_add(d))
    }
    fn or_rb(&mut self, p: u16, v: u8) {
        let b = self.m.rb(p);
        self.m.set_rb(p, b | v);
    }
    /// A word at SS:[bp+o], the edge code's workspace.
    fn s(&self, o: u16) -> u16 {
        self.m.w(self.m.ss, self.bp.wrapping_add(o))
    }
    fn set_s(&mut self, o: u16, v: u16) {
        let ss = self.m.ss;
        self.m.set_w(ss, self.bp.wrapping_add(o), v);
    }
    fn s32(&self, o: u16) -> i32 {
        (self.s(o) as u32 | (self.s(o + 2) as u32) << 16) as i32
    }
    fn set_s32(&mut self, o: u16, v: i32) {
        self.set_s(o, v as u16);
        self.set_s(o + 2, (v >> 16) as u16);
    }
    /// The workspace's ends: x at +50 and +58, y at +54 and +5C (the first end the lower).
    /// Its outcode against the screen, from R:02A4 (0 or 8000h).
    fn outcode(&self, x: u16, y: u16) -> u16 {
        self.m.rw(0x2a4) | off_x(x) | off_y(y)
    }

    fn build(&mut self, di: u16, cx: u16, dx: u16) {
        let points = self.s(0x30);
        let (si, bx) = (points.wrapping_add(cx), points.wrapping_add(dx));
        let either = self.rb(si, 4) | self.rb(bx, 4);
        if either == 0 {
            // both ends on the screen
            let rec = self.m.rw(0x2aa);
            if rec >= FULL {
                self.m.set_rb(di, 0x80); // 0407
                return;
            }
            self.m.set_rw(di, 0);
            self.m.set_rw(di.wrapping_add(2), rec);
            let (mut x0, mut x1) = (self.rw(si, 0), self.rw(bx, 0));
            self.set_s(0x54, self.rw(si, 2));
            let mut y1 = self.rw(bx, 2);
            let y0 = self.s(0x54);
            if y0 as i16 == y1 as i16 {
                self.m.set_rb(di, 0x80); // 0437: flat
                return;
            }
            if (y0 as i16) < y1 as i16 {
                // 042C: the second end is the lower
                self.set_s(0x54, y1);
                y1 = y0;
                std::mem::swap(&mut x0, &mut x1);
                self.or_rb(di, 0x40);
            }
            return self.rows(di, x0, x1, y1); // 0862
        }
        self.m.set_rb(0x2a8, either);
        if self.rb(si, 4) & self.rb(bx, 4) != 0 {
            // 0448: both ends off the same side
            return self.off(di, self.m.rb(0x2a8));
        }
        let rec = self.m.rw(0x2aa);
        if rec >= FULL {
            self.m.set_rw(di, 0x50); // 0465
            self.m.set_rw(di.wrapping_add(2), 0);
            return;
        }
        self.m.set_rw(di, 0);
        self.m.set_rw(di.wrapping_add(2), rec);
        let (mut ax, mut dx, mut cx, mut bx) = if self.rw(si, 4) & 0x10 != 0 {
            // 047E: the first end behind the near plane
            match self.near(di, si, bx) {
                Err(dl) => return self.off(di, dl),
                Ok((c, b)) => (self.s(0x50), self.s(0x5c), c, b),
            }
        } else if self.rw(bx, 4) & 0x10 != 0 {
            // 0496: the second
            match self.near(di, bx, si) {
                Err(dl) => return self.off(di, dl),
                Ok((c, b)) => {
                    let (x, y) = (self.s(0x50), self.s(0x5c));
                    let x1 = self.s(0x58);
                    self.set_s(0x58, x);
                    let y1 = self.s(0x54);
                    self.set_s(0x54, y);
                    (x1, y1, b, c)
                }
            }
        } else {
            // 04B1
            self.set_s(0x58, self.rw(bx, 0));
            self.set_s(0x54, self.rw(si, 2));
            (
                self.rw(si, 0),
                self.rw(bx, 2),
                self.rw(si, 4),
                self.rw(bx, 4),
            )
        };
        // 04C9: the lower end first; on the same row, the one off the left or right side
        let (y0, y1) = (self.s(0x54) as i16, dx as i16);
        if y0 < y1 || (y0 == y1 && cx & 8 == 0 && cx & 4 == 0) {
            let y = self.s(0x54);
            self.set_s(0x54, dx);
            dx = y;
            let x = self.s(0x58);
            self.set_s(0x58, ax);
            ax = x;
            std::mem::swap(&mut cx, &mut bx);
            self.or_rb(di, 0x40);
        }
        self.set_s(0x50, ax);
        self.set_s(0x5c, dx);
        cx &= 0xf;
        bx &= 0xf;
        let dl = self.m.rb(0x274 + cx) | self.m.rb(0x284 + bx);
        self.or_rb(di, dl);
        if cx & 1 != 0 {
            // 050F: the lower end onto the bottom row
            self.clip(&mut cx, 0x54, 0x50, 0xa4, true);
            cx = cx & 0xfff0 | off_x(self.s(0x50));
            if (cx | bx) & 0xf == 0 {
                return self.rows_at(di);
            }
            let both = cx & bx & 0xf;
            if both != 0 {
                self.or_rb(di, if both & 8 != 0 { 0x81 } else { 0x84 }); // 05AE
                return;
            }
        }
        if bx & 2 != 0 {
            // 05C6: the upper end onto the top row
            self.clip(&mut cx, 0x5c, 0x58, 0, true);
            bx = bx & 0xfff0 | off_x(self.s(0x58));
            if (cx | bx) & 0xf == 0 {
                return self.rows_at(di);
            }
            let both = cx & bx & 0xf;
            if both != 0 {
                self.or_rb(di, if both & 8 != 0 { 0x88 } else { 0x82 }); // 0663
                return;
            }
        }
        // 0672: then each end onto the left or right side
        if cx & 8 != 0 {
            self.clip(&mut cx, 0x50, 0x54, 0, false);
        } else if cx & 4 != 0 {
            self.clip(&mut cx, 0x50, 0x54, 0x140, false);
        }
        if bx & 8 != 0 {
            self.clip(&mut cx, 0x58, 0x5c, 0, false);
        } else if bx & 4 != 0 {
            self.clip(&mut cx, 0x58, 0x5c, 0x140, false);
        }
        self.rows_at(di)
    }

    /// 044C: nothing to draw; the slot's flags from the table R:0264 by the sides in dl.
    fn off(&mut self, di: u16, dl: u8) {
        let f = self.m.rb(0x264 + (dl & 0xf) as u16);
        self.m.set_rb(di, f);
    }

    /// One clip stage (0506, 05BD, 0672, 06EB, 0764, 07DD): the end whose `moved` coordinate is
    /// past the screen's side `side` comes back onto it, its other coordinate (`slid`) moving
    /// along the edge. cl's bit 80h records whether the edge's run and rise differ in sign.
    fn clip(&mut self, cx: &mut u16, moved: u16, slid: u16, side: u16, rows: bool) {
        *cx &= 0xff7f;
        let mut run = self.s(0x58).wrapping_sub(self.s(0x50));
        if (run as i16) < 0 {
            *cx |= 0x80;
            run = run.wrapping_neg();
        }
        let mut rise = self.s(0x5c).wrapping_sub(self.s(0x54));
        if (rise as i16) < 0 {
            *cx ^= 0x80;
            rise = rise.wrapping_neg();
        }
        let v = self.s(moved);
        let t = if side == 0 {
            v.wrapping_neg()
        } else {
            v.wrapping_sub(side)
        };
        let (along, across) = if rows { (rise, run) } else { (run, rise) };
        // how far the other coordinate moves for t along: across/along times t, in 16.16
        let d = if (along as i16) < across as i16 {
            self.set_s(0x40, along);
            if (t as i16) < along as i16 {
                mul_hi(self.m.div(t, 0, along).0, across)
            } else {
                across
            }
        } else if along == across {
            t
        } else {
            self.set_s(0x40, along);
            mul_hi(self.m.div(across, 0, along).0, t)
        };
        let d = if (*cx & 0x80 != 0) == (side != 0) {
            d
        } else {
            d.wrapping_neg()
        };
        let s = self.s(slid).wrapping_add(d);
        self.set_s(slid, s);
        self.set_s(moved, side);
    }

    /// 0856: the record from the workspace's ends.
    fn rows_at(&mut self, di: u16) {
        let (x0, x1, y1) = (self.s(0x50), self.s(0x58), self.s(0x5c));
        self.rows(di, x0, x1, y1)
    }

    /// 0862: the record of the edge from (x0, [bp+54]) up to (x1, y1), at the slot's pointer:
    /// the x of each row, stepped with an error term along the longer axis (left or right as
    /// the edge goes); R:02AA moves past it.
    fn rows(&mut self, di: u16, mut x0: u16, x1: u16, y1: u16) {
        let mut y0 = self.s(0x54);
        let mut si = self.rw(di, 2);
        let rise = y0.wrapping_sub(y1);
        self.set_s(0x48, rise);
        let mut put = |e: &mut Self, v: u16| {
            e.m.set_rw(si, v);
            si = si.wrapping_add(2);
        };
        for v in [y0, y1, x0, x1] {
            put(self, v);
        }
        if rise != 0 {
            let d = x0.wrapping_sub(x1);
            let (run, step) = if (d as i16) < 0 {
                (d.wrapping_neg(), 1u16)
            } else {
                (d, 0xffff)
            };
            self.set_s(0x44, run);
            if (run as i16) < rise as i16 {
                // 08CA, 0956: a row at a time
                let mut e = !(rise >> 1);
                while y0 != y1 {
                    y0 = y0.wrapping_sub(1);
                    put(self, x0);
                    let (n, carry) = e.overflowing_add(run);
                    e = n;
                    if carry {
                        e = e.wrapping_sub(rise);
                        x0 = x0.wrapping_add(step);
                    }
                }
            } else {
                // 0887, 0913: a column at a time
                let mut e = !(run >> 1);
                while x0 != x1 {
                    x0 = x0.wrapping_add(step);
                    let (n, carry) = e.overflowing_add(rise);
                    e = n;
                    if carry {
                        e = e.wrapping_sub(run);
                        put(self, x0);
                    }
                }
            }
        } // else 03D0: flat, the ends alone
        put(self, 0x8000);
        self.m.set_rw(0x2aa, si);
    }

    /// 00CA: the edge cut at depth 8, si the end behind the near plane and bx the other, and
    /// the cut projected: the workspace then holds the cut (x +50, y +54) and the other end
    /// (+58, +5C). Ok with the two ends' outcodes (the cut's, the other's), or Err with the
    /// sides to flag when nothing is left to draw.
    fn near(&mut self, di: u16, si: u16, bx: u16) -> Result<(u16, u16), u8> {
        let dl = self
            .m
            .rb(0x294 + ((self.rb(si, 4) | self.rb(bx, 4)) & 0xf) as u16);
        self.or_rb(di, dl);
        self.m.set_rb(0x2a8, dl);
        let mut ax = self.rw(si, 0xfffa);
        self.set_s(0x54, self.rw(si, 0xfffe));
        let mut cx = self.rw(bx, 0xfffa);
        let mut dx = self.rw(bx, 0xfffe);
        self.m.set_rw(0x2a6, 0);
        let sar3 = |v: u16| ((v as i16) >> 3) as u16;
        if (self.rw(si, 4) as i16) >= 0 {
            if (self.rw(bx, 4) as i16) < 0 {
                // 0117: the other end's x and depth to the same scale
                cx = sar3(cx);
                dx = sar3(dx);
                if (dx as i16) < 8 {
                    // 0123: it is no further than the cut
                    let dl = self.m.rb(0x2a8);
                    let o = self.bp.wrapping_add(0xbc);
                    let ss = self.m.ss;
                    let b = self.m.b(ss, o);
                    self.m.set_b(ss, o, b | 0x80);
                    return Err(dl);
                }
            }
        } else if (self.rw(bx, 4) as i16) < 0 {
            self.m.set_rw(0x2a6, 0x8000); // 012D
        } else {
            // 0106
            ax = sar3(ax);
            self.set_s(0x54, sar3(self.s(0x54)));
        }
        // 0133: how far along the edge depth 8 is, t in 14 bits
        let x_other = cx;
        let cx = self.rw(si, 0xfffc);
        dx = dx.wrapping_sub(self.s(0x54));
        if (dx as i16) < 8 {
            dx = 8;
        }
        self.set_s(0x54, 8u16.wrapping_sub(self.s(0x54)));
        self.set_s(0x5c, dx);
        self.set_s(0x50, ax);
        let n = ((self.s(0x54) as i16 as i32) << 16) >> 2;
        let t = self.m.idiv((n >> 16) as u16, n as u16, dx).0 as i16 as i32;
        self.set_s(0x54, t as u16);
        // 016D: the cut's camera-space x and y, times 32
        let p = (x_other.wrapping_sub(self.s(0x50)) as i16 as i32).wrapping_mul(t) >> 9;
        self.set_s32(0x40, p);
        let x = ((self.s(0x50) as i16 as i32) << 5).wrapping_add(p);
        self.set_s32(0x50, x);
        let p = (self.rw(bx, 0xfffc).wrapping_sub(cx) as i16 as i32).wrapping_mul(t) >> 9;
        self.set_s32(0x40, p);
        let mut y = ((cx as i16 as i32) << 5).wrapping_add(p);
        if (self.m.rw(0x2a6) as i16) >= 0 {
            y >>= 3;
        }
        self.set_s32(0x58, y);
        // 0219: both halved until each is under 7000h
        let big = |v: i32| {
            let a = if v < 0 { v.wrapping_neg() } else { v };
            let hi = (a >> 16) as i16;
            hi > 0 || (hi == 0 && (a as u16) >= 0x7000)
        };
        while big(self.s32(0x50)) || big(self.s32(0x58)) {
            self.set_s32(0x50, self.s32(0x50) >> 1);
            self.set_s32(0x58, self.s32(0x58) >> 1);
        }
        // 0271: projected as the game's projection does
        self.set_s(0x50, self.s(0x50).wrapping_add(0xa0));
        let ss = self.m.ss;
        let p = (self.s(0x58) as i16 as i32).wrapping_mul(self.m.w(ss, 0x17c) as i16 as i32);
        let y = (((p as u32) << 1) >> 16) as u16;
        self.set_s(0x58, y.wrapping_neg().wrapping_add(self.s(0x130)));
        let mut cx = self.outcode(self.s(0x50), self.s(0x58));
        if cx & 0xff == 0 {
            cx = self.inside(bx); // 02BE
        }
        // 02C1
        self.set_s(0x54, self.s(0x58));
        self.set_s(0x58, self.rw(bx, 0));
        self.set_s(0x5c, self.rw(bx, 2));
        let bx = self.rw(bx, 4);
        if cx as u8 & bx as u8 == 0 {
            Ok((cx, bx))
        } else {
            Err(cx as u8 | bx as u8)
        }
    }

    /// 0000: the cut on the screen, bx the other end. The game steps a vector toward the
    /// other end five times but never moves the cut by it (the loop subtracts the cut from the
    /// vector), so the cut stays where it is; no caught frame reaches this.
    fn inside(&mut self, bx: u16) -> u16 {
        let mut ax = self.rw(bx, 0).wrapping_sub(self.s(0x50));
        self.set_s(0x54, ax);
        if (ax as i16) < 0 {
            ax = ax.wrapping_neg();
        }
        let mut cx = self.rw(bx, 2).wrapping_sub(self.s(0x58));
        self.set_s(0x5c, cx);
        if (cx as i16) < 0 {
            cx = cx.wrapping_neg();
        }
        if ax < cx {
            ax = cx;
        }
        if ax == 0 {
            // 0028
            self.set_s(0x58, 0xa4);
            return self.outcode(self.s(0x50), self.s(0x58));
        }
        let sar = |v: u16| ((v as i16) >> 1) as u16;
        if ax >= 0x80 {
            loop {
                // 006E
                ax >>= 1;
                self.set_s(0x54, sar(self.s(0x54)));
                self.set_s(0x5c, sar(self.s(0x5c)));
                if ax as i16 <= 0x80 {
                    break;
                }
            }
        } else {
            while ax < 0x40 {
                ax <<= 1;
                self.set_s(0x54, self.s(0x54) << 1);
                self.set_s(0x5c, self.s(0x5c) << 1);
            }
        }
        // 007D
        self.set_s(0x48, 5);
        loop {
            self.set_s(0x54, self.s(0x54).wrapping_sub(self.s(0x50)));
            self.set_s(0x5c, self.s(0x5c).wrapping_sub(self.s(0x58)));
            let cx = self.outcode(self.s(0x50), self.s(0x58));
            if cx & 0xff != 0 {
                return cx;
            }
            let n = self.s(0x48).wrapping_sub(1);
            self.set_s(0x48, n);
            if (n as i16) < 0 {
                return cx;
            }
        }
    }

    /// 02E4: the border edge for the point at [bp+30]+dx.
    fn border(&mut self, di: u16, bl: u8, cx: u16, dx: u16, si: u16) {
        self.m.set_rb(0x2a8, bl);
        let bx = self.s(0x30).wrapping_add(dx);
        let o = self.rb(bx, 4);
        if cx as u8 & o != 0 {
            self.m.set_rb(di, 0x80); // 0302
            return;
        }
        if o & 0x13 != 0 {
            if o & 0x10 != 0 || o & 2 == 0 {
                self.m.set_rb(di, 0x80);
                return;
            }
            // 030D: above the screen, brought down to its top row
            let a = bx.wrapping_add(4);
            self.m.set_rw(a, self.m.rw(a) & 0xfffc);
            self.m.set_rw(bx.wrapping_add(2), 0);
        }
        let rec = self.m.rw(0x2aa);
        if rec >= FULL {
            self.m.set_rw(di, 0x80); // 0321
            self.m.set_rw(di.wrapping_add(2), 0);
            return;
        }
        self.m.set_rw(di, 0);
        self.m.set_rw(di.wrapping_add(2), rec);
        let side = if cx == 8 { 0 } else { 0x140 };
        self.set_s(0x58, self.rw(bx, 0));
        self.set_s(0x5c, self.rw(bx, 2));
        // 034C: no higher than R:0136 when off the left or right, or when the segment record
        // says so on the side R:013E's sign picks
        let floor = if self.rb(bx, 4) & 0xc != 0 {
            true
        } else if self.rb(si, 6) & 0x80 == 0 {
            false
        } else if (self.m.rw(0x13e) as i16) < 0 {
            cx as u8 == 4
        } else {
            cx as u8 == 8
        };
        if floor {
            let y = self.m.rw(0x136);
            if (self.s(0x5c) as i16) < y as i16 {
                self.set_s(0x5c, y);
            }
        }
        // 037C
        let out = self.rw(bx, 4);
        let f = self.m.rb(0x2a8);
        self.or_rb(di, f);
        let f = self.m.rb(0x274 + (cx & 0xf)) | self.m.rb(0x284 + (out & 0xf));
        self.or_rb(di, f);
        let si = self.rw(di, 2);
        let y = self.s(0x5c);
        let x = self.s(0x58);
        let x = if x < 0x140 {
            x
        } else if x as i16 >= 0x140 {
            0x140
        } else {
            0
        };
        for (k, v) in [y, y, side, x, 0x8000].into_iter().enumerate() {
            self.m.set_rw(si.wrapping_add(2 * k as u16), v);
        }
        self.m.set_rw(0x2aa, si.wrapping_add(10));
    }
}
