//! The ground texture (gp.exe 0F47:7F64, a near routine; docs/renderer-notes.md, section 4): with
//! the T option on, after the scene is drawn, each road (1Ah) and grass (12h) pixel of the ground
//! rows gets a shade from -2 to +1 added, read from a 2-bit pattern of 4,096 bytes at segment 7D70
//! (four 2-bit texels a byte, the shift picking one).
//!
//! 7988 first makes two tables in the code segment, a word a screen row from the bottom row (163)
//! up to the texture's top row (CS:738E): the ground's distance at the row (CS:73B1) and its
//! sideways offset (CS:74F9), from the list of ground points at R:0644 to R:0642 (8 bytes each:
//! height, distance, sideways, the screen row it reaches up to).
//!
//! Then one of two passes, each from the middle of a row out to both sides:
//! - **TV views** (7C5A): the pattern is a 64 x 64 tile laid on the ground in world space, each row
//!   walked from the camera's position along its heading.
//! - **Cockpit and chase views** (7D62): the pattern is 128 rows of 32 laid along the view: a
//!   screen row's pattern row comes from its distance plus how far the car has moved (CS:7396), its
//!   column from its offset plus how far it has turned (CS:7394), each scaled down by the car's
//!   speed (CS:73A1). A row whose distance changes by more than a threshold from the row below
//!   reads the pattern's coarser bits (2, 4 or 6 down), or is left plain.
//!
//! Each step below names the game's instruction it stands for.

use super::list;
use super::Mem;

/// The texture's code-segment variables (offsets in CS).
const TOP: u16 = 0x738e; // the texture's top row
const ROW: u16 = 0x7392; // the row being drawn (TV pass)
const SPOT: u16 = 0x7390; // the pattern row's (or tile row's) offset
const TURNED: u16 = 0x7394; // how far the view has turned, summed
const MOVED: u16 = 0x7396; // how far it has moved, summed
const LAST_X: u16 = 0x7398; // the camera's x and z at the last frame
const LAST_Z: u16 = 0x739a;
const YAW: u16 = 0x739c; // the yaw rate's offset per unit of distance, when CS:73A0 is set
const YAW_SCALE: u16 = 0x739e;
const YAWING: u16 = 0x73a0; // byte
const SHIFT: u16 = 0x73a1; // byte: the speed's scale, CS:73A2 to CS:73A3
const DEPTHS: u16 = 0x73b1; // a word a row: the ground's distance
const SIDES: u16 = 0x74f9; // a word a row: its sideways offset
const STEP: u16 = 0x7645; // the sideways offset: its slope, base distance and base
const STEP_AT: u16 = 0x7647;
const STEP_BASE: u16 = 0x7649;
const SHADE: u16 = 0x764b; // byte: added to each texel (FEh: -2)
const TV: u16 = 0x764c; // byte: 80h for the TV pass
const LEVELS: u16 = 0x7655; // the distance steps at which a row reads coarser bits: 4 words
const BITS: u16 = 0x7661; // byte: the texel's shift
/// The pattern's segment is the immediate of 7C71 (mov dx, 7D70h).
const PATTERN_AT: u16 = 0x7c72;

/// The texture pass (0F47:7F64), BP as its caller has it. It leaves the registers as they were.
pub fn ground(mut m: Mem, bp: u16) {
    m.r = m.w(m.ss, 0xf4);
    let mut g = Ground { m, bp };
    g.run();
}

struct Ground<'a> {
    m: Mem<'a>,
    bp: u16,
}

/// IMUL: the 32-bit product.
fn imul(a: u16, b: u16) -> i32 {
    (a as i16 as i32) * (b as i16 as i32)
}
/// The high word of a 32-bit value shifted left by 2 (shl ax,1; rcl dx,1, twice).
fn hi4(v: i32) -> u16 {
    ((v as u32) << 2 >> 16) as u16
}
/// SAR of a word by CL (the 286 takes the count's low 5 bits).
fn sar(v: u16, n: u8) -> u16 {
    ((v as i16) >> (n & 31).min(15)) as u16
}

impl Ground<'_> {
    fn c(&self, o: u16) -> u16 {
        self.m.w(self.m.cs, o)
    }
    fn set_c(&mut self, o: u16, v: u16) {
        let cs = self.m.cs;
        self.m.set_w(cs, o, v);
    }
    fn cb(&self, o: u16) -> u8 {
        self.m.b(self.m.cs, o)
    }
    fn set_cb(&mut self, o: u16, v: u8) {
        let cs = self.m.cs;
        self.m.set_b(cs, o, v);
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
    /// IDIV, AX after it (Mem::idiv: a divide error leaves AX as it was).
    fn idiv(&mut self, dx: u16, ax: u16, d: u16) -> u16 {
        self.m.idiv(dx, ax, d).0
    }

    fn run(&mut self) {
        // 7F67: DS the game's data (SS:00F0) for the camera's car
        let ds = self.ss(0xf0);
        self.set_cb(YAWING, 0);
        // 7E7E: R:082A, the height of the camera over the ground
        let car = self.m.w(ds, 0x97f);
        let view = self.m.b(ds, 0x981);
        let mut h = if view == 0 {
            self.m.w(ds, car.wrapping_add(0x8c))
        } else {
            0
        };
        h = h.wrapping_add(self.m.w(ds, 0x233f));
        self.m.set_rw(0x82a, h);
        self.set_cb(BITS, 2);
        let mut tv = view == 0xc0 || view == 0x80;
        if !tv && view != 0 {
            // 7FA8: a view from another car counts as a TV view when it faces more than 45
            // degrees away from the camera's car
            self.set_cb(BITS, 0);
            let mut a = self.m.w(ds, car).wrapping_sub(self.m.w(ds, 0x60));
            if (a as i16) < 0 {
                a = a.wrapping_neg();
            }
            if a >= 0x4000 {
                a = 0x8000u16.wrapping_sub(a);
            }
            tv = a > 0x2000;
        }
        if tv {
            // 7F89
            self.set_cb(TV, 0x80);
            self.tables();
            self.tv();
            return;
        }
        // 7FC7: the yaw rate's offset, when SS:[bp+16E] says so
        if self.m.b(self.m.ss, self.bp.wrapping_add(0x16e)) != 0 {
            let mut y = imul(self.m.w(ds, car.wrapping_add(0x4a)), self.c(YAW_SCALE)) as u16;
            if (self.ss(0x136) as i16) >= 0 {
                y = y.wrapping_neg();
            }
            self.set_c(YAW, y);
            self.set_cb(YAWING, 0x80);
        }
        // 7FEB: the speed's scale
        let mut v = self.m.w(ds, car.wrapping_add(0x10));
        if (v as i16) < 0 {
            v = v.wrapping_neg();
        }
        let mut al = (v >> 11) as u8;
        if (al as i8) < self.cb(SHIFT + 1) as i8 {
            al = self.cb(SHIFT + 1);
        }
        if (al as i8) > self.cb(SHIFT + 2) as i8 {
            al = self.cb(SHIFT + 2);
        }
        self.set_cb(SHIFT, al);
        self.moved();
        self.set_cb(TV, 0);
        self.tables();
        self.view();
    }

    /// 7E9D: how far the camera moved and turned since the last frame, in its own axes.
    fn moved(&mut self) {
        let dx = self.s(0x13c).wrapping_sub(self.c(LAST_X));
        self.set_c(LAST_X, self.s(0x13c));
        self.set_s(0x10, dx);
        let dz = self.s(0x140).wrapping_sub(self.c(LAST_Z));
        self.set_c(LAST_Z, self.s(0x140));
        self.set_s(0x14, dz);
        let (sx, sz) = self.rotate();
        for (v, at) in [(sx, TURNED), (sz, MOVED)] {
            let v = if (v as i16).unsigned_abs() == 1 { 0 } else { v };
            self.set_c(at, self.c(at).wrapping_add(v));
        }
    }

    /// The vector at SS:[bp+10], [bp+14] turned by the camera's heading (cos [bp+154], sin
    /// [bp+156]), as 7E9D and 7A66 do it: the results also left at [bp+10] and [bp+14].
    fn rotate(&mut self) -> (u16, u16) {
        self.set_s(0x8, self.s(0x154));
        self.set_s(0xc, self.s(0x156));
        let (x, z) = (self.s(0x10), self.s(0x14));
        self.set_s(0x0, x);
        let (c, s) = (self.s(0x8), self.s(0xc));
        let rx = imul(x, c).wrapping_sub(imul(z, s));
        let rz = imul(z, c).wrapping_add(imul(x, s));
        self.set_s(0x12, (rx >> 16) as u16);
        self.set_s(0x16, (rz >> 16) as u16);
        let (rx, rz) = (hi4(rx), hi4(rz));
        self.set_s(0x14, rz);
        self.set_s(0x10, rx);
        (rx, rz)
    }

    /// 7988: the distance and sideways offset of the ground at each row.
    fn tables(&mut self) {
        self.m.set_rw(0x828, 0xa3);
        let horizon = self.s(0x130);
        self.m.set_rw(0x82e, horizon.wrapping_sub(0xa3));
        let top = (self.m.rw(0x140) as i16).min(horizon as i16).clamp(8, 0x67) as u16;
        self.set_c(TOP, top);
        let end = self.m.rw(0x642);
        let mut si = end.wrapping_sub(8);
        if si < 0x644 {
            return;
        }
        if self.cb(TV) != 0 {
            // 79D8: a last point under the camera
            si = end;
            self.m.set_rw(si.wrapping_add(4), 0);
            self.m.set_rw(si.wrapping_add(2), 0);
            self.m.set_rw(si.wrapping_add(6), 0xa4);
            let h = self.m.rw(0x82a).wrapping_neg();
            self.m.set_rw(si, h);
        } else if self.cb(0x73b0) == 0 {
            // 79FF: a last point from the record at the far pointer CS:73AC
            si = end;
            self.tail(si);
        }
        // 7AE4
        let mut di = si.wrapping_sub(8);
        if di < 0x644 {
            return;
        }
        'pair: loop {
            // 7AF2: the stretch from the point at si (nearer) to the one at di (further)
            if self.m.rw(di.wrapping_add(2)) as i16 >= self.c(0x73a6) as i16 {
                let mut cx = self
                    .m
                    .rw(di.wrapping_add(2))
                    .wrapping_sub(self.m.rw(si.wrapping_add(2)));
                if (cx as i16) < 0x40 {
                    cx = 0x40;
                }
                let d = self
                    .m
                    .rw(di.wrapping_add(4))
                    .wrapping_sub(self.m.rw(si.wrapping_add(4)));
                let n = (d as i16 as i32) << 12;
                let q = self.idiv((n >> 16) as u16, n as u16, cx);
                self.set_c(STEP, q);
                self.set_c(STEP_BASE, self.m.rw(si.wrapping_add(4)) << 8);
                self.set_c(STEP_AT, self.m.rw(si.wrapping_add(2)));
            }
            // 7B38
            let rise = self.m.rw(di).wrapping_sub(self.m.rw(si));
            let mut run = self
                .m
                .rw(di.wrapping_add(2))
                .wrapping_sub(self.m.rw(si.wrapping_add(2)));
            if (run as i16) < 0x40 {
                run = 0x40;
            }
            let f = self.ss(0x17c);
            let n = imul(rise, f) >> 4;
            let slope = self.idiv((n >> 16) as u16, n as u16, run);
            let n = imul(self.m.rw(si), f) >> 4;
            let base = n.wrapping_add(imul(self.m.rw(si.wrapping_add(2)).wrapping_neg(), slope));
            self.set_c(0x73a8, base as u16);
            self.set_c(0x73aa, (base >> 16) as u16);
            'rows: loop {
                // 7B93: each row up to the further point's
                let cx = (self.m.rw(0x82e) << 6).wrapping_sub(slope);
                let ss = self.m.ss;
                self.m.set_b(ss, 0xc0, 0);
                let mut depth = self.idiv(self.c(0x73aa), self.c(0x73a8), cx);
                if self.m.b(ss, 0xc0) != 0 {
                    depth = 0x7fff;
                }
                let row = self.m.rw(0x828);
                let bx = row.wrapping_add(row);
                self.set_c(DEPTHS.wrapping_add(bx), depth);
                let side = if self.cb(YAWING) != 0 {
                    let y = hi4(imul(depth, self.c(YAW)) << 2);
                    (imul(y, depth) >> 4) as u16
                } else {
                    let v = imul(depth.wrapping_sub(self.c(STEP_AT)), self.c(STEP)) >> 4;
                    (v as u16).wrapping_add(self.c(STEP_BASE)).wrapping_neg()
                };
                self.set_c(SIDES.wrapping_add(bx), side);
                self.m.set_rw(0x82e, self.m.rw(0x82e).wrapping_add(1));
                let row = (bx >> 1).wrapping_sub(1);
                self.m.set_rw(0x828, row);
                if row < self.c(TOP) {
                    return; // 7C52
                }
                if row as i16 >= self.m.rw(di.wrapping_add(6)) as i16 {
                    continue;
                }
                // 7C3A: on to the next point further, while there is one
                loop {
                    if di <= 0x64c {
                        continue 'rows;
                    }
                    si = di;
                    di = di.wrapping_sub(8);
                    if row as i16 >= self.m.rw(di.wrapping_add(6)) as i16 {
                        continue 'pair;
                    }
                }
            }
        }
    }

    /// 79FF: the ground point under the record at the far pointer CS:73AC (x +4, z +8, height +6,
    /// a heading +0C, +0E and a length +16 that place the point ahead of it), seen from the camera.
    fn tail(&mut self, si: u16) {
        let (seg, off) = (self.c(0x73ae), self.c(0x73ac));
        let e = |g: &Self, d: u16| g.m.w(seg, off.wrapping_add(d));
        let cx = (e(self, 0xc) & 0x3f) << 5;
        let n = (e(self, 0x16) as i16 as i32) << 14;
        let q = self.idiv((n >> 16) as u16, n as u16, cx);
        let k = sar(q, 1);
        let x = hi4(imul(sar(e(self, 0xc), 6), k))
            .wrapping_add(e(self, 4))
            .wrapping_sub(self.s(0x13c));
        self.set_s(0x10, x);
        let z = hi4(imul(sar(e(self, 0xe), 6).wrapping_neg(), k))
            .wrapping_add(e(self, 8))
            .wrapping_sub(self.s(0x140));
        self.set_s(0x14, z);
        let (x, z) = self.rotate();
        self.m.set_rw(si.wrapping_add(4), x);
        self.m.set_rw(si.wrapping_add(2), z);
        let h = e(self, 6).wrapping_sub(self.s(0x13e));
        self.m.set_rw(si, h);
    }

    /// The back buffer's offset of the middle of the texture's top row, and the pattern's segment.
    fn start(&self) -> (u16, u16, u16) {
        let (es, di) = (self.m.rw(0x1e), self.m.rw(0x1c));
        let di = di
            .wrapping_add(0x140u16.wrapping_mul(self.c(TOP)))
            .wrapping_add(0xa0);
        (es, di, self.c(PATTERN_AT))
    }

    /// One texel added to the pixel at es:di if it is road or grass.
    fn texel(&mut self, es: u16, di: u16, pattern: u16, at: u16, bits: u8) {
        let p = self.m.b(es, di);
        if p == 0x12 || p == 0x1a {
            let n = bits & 31; // SHR BL, CL: the count's low 5 bits
            let b = if n >= 8 {
                0
            } else {
                self.m.b(pattern, at) >> n
            };
            let t = (b & 3).wrapping_add(self.cb(SHADE));
            self.m.set_b(es, di, p.wrapping_add(t));
            list::texel(es, di, t as i8);
        }
    }

    /// 7C5A: the TV pass, the pattern a tile on the ground.
    fn tv(&mut self) {
        let (es, mut di, pattern) = self.start();
        self.set_c(ROW, self.c(TOP));
        loop {
            let depth = self.c(DEPTHS.wrapping_add(self.c(ROW) << 1));
            let si = hi4(imul(depth, self.ss(0x154)));
            let dx = hi4(imul(depth, self.ss(0x156)));
            let bp0 = self.ss(0x140).wrapping_add(si) << 8;
            let ax0 = self.ss(0x13c).wrapping_add(dx) << 8;
            let bits = self.cb(BITS);
            let (mut ax, mut bp) = (ax0, bp0);
            let at = |g: &mut Self, ax: u16, bp: u16| {
                let row = (bp >> 4) & 0xffc0;
                g.set_c(SPOT, row);
                ((ax >> 10) & 0x3f).wrapping_add(row)
            };
            for k in 0..0xa0u16 {
                let d = di.wrapping_add(k);
                let p = self.m.b(es, d);
                if p == 0x12 || p == 0x1a {
                    let a = at(self, ax, bp);
                    self.texel(es, d, pattern, a, bits);
                }
                ax = ax.wrapping_add(si);
                bp = bp.wrapping_sub(dx);
            }
            let (mut ax, mut bp) = (ax0, bp0);
            for k in 1..=0xa0u16 {
                ax = ax.wrapping_sub(si);
                bp = bp.wrapping_add(dx);
                let d = di.wrapping_sub(k);
                let p = self.m.b(es, d);
                if p == 0x12 || p == 0x1a {
                    let a = at(self, ax, bp);
                    self.texel(es, d, pattern, a, bits);
                }
            }
            di = di.wrapping_add(0x140);
            let row = self.c(ROW).wrapping_add(1);
            self.set_c(ROW, row);
            if row >= 0xa4 {
                return;
            }
        }
    }

    /// 7D62: the cockpit and chase pass, the pattern laid along the view.
    fn view(&mut self) {
        let (es, mut di, pattern) = self.start();
        self.set_c(0x7643, 0x4000);
        let mut row = self.c(TOP);
        loop {
            let bx = row << 1;
            self.set_c(0x7641, self.c(SIDES.wrapping_add(bx)));
            let depth = self.c(DEPTHS.wrapping_add(bx));
            let step = self.c(0x7643).wrapping_sub(depth);
            self.set_c(0x7643, depth);
            let shift = self.cb(SHIFT);
            let along = sar(depth.wrapping_add(self.c(MOVED)), shift);
            let step = sar(step, shift);
            // 7DB7: coarser bits as the distance steps further between rows
            let bits = (0..4u16)
                .find(|&k| step as i16 <= self.c(LEVELS + 2 * k) as i16)
                .map(|k| 2 * k as u8);
            if let Some(bits) = bits {
                self.set_cb(BITS, bits);
                let spot = (along & 0x7f) << 5;
                self.set_c(SPOT, spot);
                let ax0 = (self.c(TURNED) << 8).wrapping_add(self.c(0x7641));
                let mut ax = ax0;
                for k in 0..0xa0u16 {
                    let d = di.wrapping_add(k);
                    self.texel(es, d, pattern, ((ax >> 8) & 0x1f).wrapping_add(spot), bits);
                    ax = ax.wrapping_add(depth);
                }
                let mut ax = ax0;
                for k in 1..=0xa0u16 {
                    ax = ax.wrapping_sub(depth);
                    let d = di.wrapping_sub(k);
                    self.texel(es, d, pattern, ((ax >> 8) & 0x1f).wrapping_add(spot), bits);
                }
            }
            di = di.wrapping_add(0x140);
            row = row.wrapping_add(1);
            if row >= 0xa4 {
                return;
            }
        }
    }
}
