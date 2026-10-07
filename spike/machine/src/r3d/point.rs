//! The point projection (gp.exe 0F47:1FAD to 226A; docs/renderer-notes.md, sections 3 and 7): a
//! point in the world or near the camera, turned into the view and projected onto the screen,
//! into a record of 12 bytes in R at SI: +0 its sideways distance in the view, +2 its height
//! from the camera, +4 its depth, +6 and +8 its screen column and row, +A its outcode.
//!
//! Three entries share the code:
//! - **20D9**: a world point, x at SS:[bp+10], z at [bp+14], height in CX; the camera's position
//!   (SS:[bp+13C], [bp+13E], [bp+140]) taken off, then turned by its heading ([bp+154],
//!   [bp+156]).
//! - **20AB**: a point already relative to the camera, 32-bit at [bp+10] and [bp+14] (eight times
//!   finer unless R:02A4 bit 15 is set), turned by the cosine and sine the caller left at [bp+8]
//!   and [bp+C].
//! - **2168**: a point already in the view: sideways AX (and 32-bit, 64 times finer, at [bp+10]),
//!   height CX, depth [bp+14].
//!
//! A point nearer than depth 8 gets outcode 10h and the sides it lies to. Otherwise column =
//! sideways / depth + 160, row = [bp+130] - height x SS:[bp+17C] x 2 x 32 / depth, rounded as
//! the game does: a negative quotient to the nearest, a positive one up when the quotient (not
//! the remainder) reaches the depth (docs: "Projection quirk"). If the column's divide overflows,
//! 1FAD places the point in its direction instead, far off the screen.
//!
//! These routines keep no registers: the ports set AX, CX and DX as the game's leave them.

use super::Mem;

/// Which entry the routine was called at.
#[derive(Clone, Copy, PartialEq)]
pub enum Entry {
    World,     // 20D9
    Near,      // 20AB
    Projected, // 2168
}

/// Project a point (registers r: AX CX DX BX SP BP SI DI, changed as the game's routine does).
pub fn point(m: Mem, r: &mut [u16; 8], entry: Entry) {
    let bp = r[5];
    let mut p = Point { m, bp, r };
    p.run(entry);
}

struct Point<'a, 'b> {
    m: Mem<'a>,
    bp: u16,
    r: &'b mut [u16; 8],
}

const AX: usize = 0;
const CX: usize = 1;
const DX: usize = 2;
const SI: usize = 6;

impl Point<'_, '_> {
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
    /// A word of the point's record.
    fn set_p(&mut self, o: u16, v: u16) {
        let at = self.r[SI].wrapping_add(o);
        self.m.set_rw(at, v);
    }
    fn p(&self, o: u16) -> u16 {
        self.m.rw(self.r[SI].wrapping_add(o))
    }
    /// The outcode of the record's screen column and row, with R:02A4.
    fn outcode(&self) -> u16 {
        let (x, y) = (self.p(6), self.p(8));
        let mut c = self.m.rw(0x2a4);
        c |= if x < 0x140 {
            0
        } else if x as i16 >= 0x140 {
            4
        } else {
            8
        };
        c |= if y < 0xa4 {
            0
        } else if y as i16 >= 0xa4 {
            1
        } else {
            2
        };
        c
    }
    fn fine(&self) -> bool {
        (self.m.rw(0x2a4) as i16) < 0
    }

    fn run(&mut self, entry: Entry) {
        match entry {
            Entry::World => {
                // 20D9
                self.set_s(0x8, self.s(0x154));
                self.set_s(0xc, self.s(0x156));
                let x = self.s(0x10).wrapping_sub(self.s(0x13c));
                self.set_s(0x10, x);
                self.r[DX] = self.s(0x140);
                let z = self.s(0x14).wrapping_sub(self.r[DX]);
                self.set_s(0x14, z);
                self.view();
                self.project();
            }
            Entry::Near => {
                // 20AB
                if !self.fine() {
                    self.set_s32(0x10, self.s32(0x10) >> 3);
                    self.set_s32(0x14, self.s32(0x14) >> 3);
                }
                self.view();
                self.project();
            }
            Entry::Projected => self.project(),
        }
    }

    /// 20F5: the height from the camera, and the point turned into the view.
    fn view(&mut self) {
        self.r[CX] = self.r[CX].wrapping_sub(self.s(0x13e));
        let (x, z) = (self.s(0x10), self.s(0x14));
        self.set_s(0x0, x);
        let (c, s) = (self.s(0x8) as i16 as i32, self.s(0xc) as i16 as i32);
        let (x, z) = (x as i16 as i32, z as i16 as i32);
        let rx = (x * c).wrapping_sub(z * s);
        let rz = (z * c).wrapping_add(x * s);
        // the depth: rz << 2, its high word
        let d = (rz as u32) << 2;
        self.set_s(0x14, (d >> 16) as u16);
        self.set_s(0x16, (rz >> 16) as u16);
        // sideways: rx >> 6, kept 32-bit, and its bits 8 to 23 in AX
        let v = rx >> 6;
        self.set_s32(0x10, v);
        self.r[DX] = (v >> 16) as u16;
        self.r[AX] = (v >> 8) as u16;
    }

    /// 2168: the record, and the point on the screen.
    fn project(&mut self) {
        let (ax, cx) = (self.r[AX], self.r[CX]);
        self.set_p(0, ax);
        self.set_p(2, cx);
        let depth = self.s(0x14);
        self.set_p(4, depth);
        if (depth as i16) < 8 {
            // 217A: nearer than the near plane
            let mut c = if (ax as i16) < 0 { 0x18 } else { 0x14 };
            c |= if (cx as i16) < 0 { 0x11 } else { 0x12 };
            c |= self.m.rw(0x2a4);
            self.set_p(0xa, c);
            self.r[AX] = c;
            return;
        }
        // 219F: the height scaled, then the column
        let h = ((self.r[CX] as i16 as i32 * self.s(0x17c) as i16 as i32) as u32) << 1;
        self.r[CX] = (h >> 16) as u16;
        let ss = self.m.ss;
        self.m.set_b(ss, 0xc0, 0);
        let (q, rem) = self.m.idiv(self.s(0x12), self.s(0x10), depth);
        self.r[AX] = q;
        self.r[DX] = rem;
        if self.m.b(ss, 0xc0) != 0 {
            return self.far();
        }
        let (x, over) = (q as i16).overflowing_add(0xa0);
        if over {
            return self.far();
        }
        self.r[AX] = x as u16;
        self.set_p(6, x as u16);
        // 21D5: the row
        let mut n = (self.r[CX] as i16 as i32) << 5;
        if self.fine() {
            n <<= 3;
        }
        self.m.set_b(ss, 0xc0, 0);
        let (q, rem) = self.m.idiv((n >> 16) as u16, n as u16, depth);
        let mut ax = q;
        let mut dx = rem;
        if self.m.b(ss, 0xc0) != 0 {
            ax = if (dx as i16) < 0 { 0x8000 } else { 0x7fff };
        } else {
            let carry = dx & 0x8000 != 0;
            dx <<= 1;
            if carry {
                dx = dx.wrapping_neg();
                if dx >= depth {
                    ax = ax.wrapping_sub(1);
                }
            } else if ax >= depth {
                ax = ax.wrapping_add(1);
            }
        }
        self.r[DX] = dx;
        let y = ax.wrapping_neg().wrapping_add(self.s(0x130));
        self.set_p(8, y);
        let c = self.outcode();
        self.set_p(0xa, c);
        self.r[AX] = c;
    }

    /// 1FAD: a point whose column overflows, placed in its direction: sideways and height
    /// doubled together until the sideways is at least 3800h in its high word, then their high
    /// words taken as the column and row.
    fn far(&mut self) {
        let mut h = (self.r[CX] as i16 as i32) << 5;
        if self.fine() {
            h <<= 3;
        }
        self.set_s32(0x18, h);
        let mut cx = 0x10u16;
        let v = self.s32(0x10);
        let (mut ax, mut dx) = (v as u16, (v >> 16) as u16);
        if v != 0 {
            let a = if v < 0 { v.wrapping_neg() } else { v };
            ax = a as u16;
            dx = (a >> 16) as u16;
            while (dx as i16) < 0x3800 {
                self.set_s32(0x10, self.s32(0x10) << 1);
                self.set_s32(0x18, self.s32(0x18) << 1);
                let a = ((dx as u32) << 16 | ax as u32) << 1;
                ax = a as u16;
                dx = (a >> 16) as u16;
                cx = cx.wrapping_sub(1);
            }
            // 202A
            let x = self.s(0x12).wrapping_add(0xa0);
            self.set_p(6, x);
            let y = self.s(0x1a).wrapping_neg().wrapping_add(self.s(0x130));
            self.set_p(8, y);
        }
        // 203F
        let c = self.outcode();
        self.set_p(0xa, c);
        let cx = cx & 0xff00 | cx & 0x1f;
        let at = self.r[SI].wrapping_add(0xb);
        let b = self.m.rb(at);
        self.m.set_rb(at, b | cx as u8);
        self.r[AX] = c;
        self.r[CX] = cx;
        self.r[DX] = dx;
        let _ = ax;
    }
}
