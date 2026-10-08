//! The track's points: the helpers the segment walk's cross-section builders call (gp.exe
//! 0F47:206E to 2A03, 32C3 to 3439, 78C1 to 7987, and the square root 0000:024E), each changing
//! the registers as the game's routine does. A point is the projection's 12-byte record
//! (src/r3d/point.rs).
//!
//! Each step below names the game's instruction it stands for.

use super::list;
use super::point::{self, Entry};
use super::regs::*;

/// 0000:024E (far): AX = the square root of DX:AX, by three Newton steps from DX/2 + 8000h on
/// the value shifted up two bits at a time to at least 2^30, the root then shifted back. DX = 0
/// after it (unless the value was 0); the other registers kept.
pub fn sqrt(c: &mut Cpu) {
    let mut v = join(c.r[DX], c.r[AX]);
    let mut shifts = 0u32;
    while v >> 16 < 0x4000 {
        shifts += 1;
        v <<= 2;
        if v == 0 {
            c.r[AX] = 0;
            return;
        }
    }
    let n = v >> 1;
    let mut x = ((v >> 17) as u16).wrapping_add(0x8000);
    for _ in 0..3 {
        let q = c.div((n >> 16) as u16, n as u16, x).0;
        x = (x >> 1).wrapping_add(q);
    }
    let k = shifts as u8 & 31;
    c.r[AX] = if k >= 16 { 0 } else { x >> k };
    c.r[DX] = 0;
}

/// 206E: CX (a scaled height) times 32 (times 256 with the finer coordinates), shifted down by
/// DL's low 5 bits: CX the low word, DX the high; AX kept.
pub fn shifted(c: &mut Cpu) {
    let mut v = (c.r[CX] as i16 as i32) << 5;
    if (c.d(0x2a4) as i16) < 0 {
        v <<= 3;
    }
    v >>= (c.r[DX] & 0x1f) as u32;
    c.r[CX] = v as u16;
    c.r[DX] = (v >> 16) as u16;
}

/// The screen's sides up and down, as outcode bits: 1 below, 2 above.
fn off_y(y: u16) -> u16 {
    if y < 0xa4 {
        0
    } else if y as i16 >= 0xa4 {
        1
    } else {
        2
    }
}

/// 2334: the point at SI raised by CX into the record at BX: the same column, a new height and
/// row (a row the same as SI's moved up one).
pub fn raise(c: &mut Cpu) {
    let (si, bx) = (c.r[SI], c.r[BX]);
    let h = c.r[CX].wrapping_add(c.d(si.wrapping_add(2)));
    for k in 0..6u16 {
        let v = c.d(si.wrapping_add(2 * k));
        c.set_d(bx.wrapping_add(2 * k), v);
    }
    c.set_d(bx.wrapping_add(2), h);
    let p = (h as i16 as i32 * c.bp(0x17c) as i16 as i32) as u32;
    let mut cx = ((p << 1) >> 16) as u16;
    let mut dx = cx;
    let mut ax = c.d(bx.wrapping_add(0xa)) & 0xfffc;
    // what the finer scale can project again: the source's division with this height
    let mut fine = None;
    if ax & 0x10 != 0 {
        // 2373: behind the near plane: above or below only
        list::unprojected(bx);
        ax |= if (cx as i16) < 0 { 1 } else { 2 };
        c.set_d(bx.wrapping_add(0xa), ax);
        c.r[AX] = ax;
        c.r[CX] = cx;
        c.r[DX] = dx;
        return;
    }
    let shift = (ax >> 8) as u8 & 0x1f;
    if shift != 0 {
        // 238C: a point placed by 1FAD: the height shifted as its sideways was
        c.r[CX] = cx;
        c.r[DX] = dx & 0xff00 | shift as u16;
        shifted(c);
        cx = c.r[CX];
        dx = c.r[DX];
    } else {
        // 2391: the row as 2168 works it, at the record's depth
        let mut n = (cx as i16 as i32) << 5;
        if (c.d(0x2a4) as i16) < 0 {
            n <<= 3;
        }
        let depth = c.d(bx.wrapping_add(4));
        c.set_bp(0x14, depth);
        c.set_ssb(0xc0, 0);
        let (mut q, mut rem) = c.idiv((n >> 16) as u16, n as u16, depth);
        if c.ssb(0xc0) != 0 {
            q = if (rem as i16) < 0 { 0x8000 } else { 0x7fff };
        } else {
            fine = Some(n);
            let carry = rem & 0x8000 != 0;
            rem <<= 1;
            if carry {
                rem = rem.wrapping_neg();
                if rem >= depth {
                    q = q.wrapping_sub(1);
                }
            } else if q >= depth {
                q = q.wrapping_add(1);
            }
        }
        cx = q;
        dx = rem;
    }
    // 23FB: the row, from the horizon; one that overflows kept to +-7800h
    let horizon = c.bp(0x130);
    let (y, over) = (cx.wrapping_neg() as i16).overflowing_add(horizon as i16);
    cx = if over {
        let v = cx.wrapping_neg();
        if (v as i16) < 0 {
            let a = v.wrapping_neg();
            let a = if (a as i16) < 0x7800 { a } else { 0x7800 };
            a.wrapping_neg()
        } else if (v as i16) < 0x7800 {
            v
        } else {
            0x7800
        }
    } else {
        y as u16
    };
    match fine {
        Some(n) if !over => list::raised(si, bx, n, horizon as i16, cx as i16),
        _ => list::unprojected(bx),
    }
    if cx == c.d(si.wrapping_add(8)) {
        cx = cx.wrapping_sub(1);
    }
    c.set_d(bx.wrapping_add(8), cx);
    ax |= off_y(cx);
    c.set_d(bx.wrapping_add(0xa), ax);
    c.r[AX] = ax;
    c.r[CX] = cx;
    c.r[DX] = dx;
}

/// One edge's crest tracker (279E the left edge, 28D1 the right): its variables in R.
pub struct Crest {
    /// the point's row, the last row, a flag byte, the nearest depth and the row there
    pub row: u16,
    pub last: u16,
    pub flag: u16,
    pub depth: u16,
    pub top: u16,
}
pub const LEFT: Crest = Crest {
    row: 0x1f2,
    last: 0x1f4,
    flag: 0x1f6,
    depth: 0x1f8,
    top: 0x1fa,
};
pub const RIGHT: Crest = Crest {
    row: 0x1fc,
    last: 0x1fe,
    flag: 0x200,
    depth: 0x202,
    top: 0x204,
};

/// 279E, 28D1: the edge's point at SI against the rows before it: R:01F0 keeps the highest row
/// (and BX, its section, at R:01E8), R:01E6 gets 80h where the edge turns down again (a crest)
/// and 40h where it then rises past the last row.
pub fn crest(c: &mut Cpu, k: &Crest) {
    let si = c.r[SI];
    if c.d(si.wrapping_add(0xa)) & 0x10 != 0 {
        return;
    }
    let mut ax;
    let mut crested = false;
    if (c.db(0x15c) as i8) < 0 {
        // 27AF
        if c.db(0x15c) & 0x40 != 0 {
            return;
        }
        ax = c.d(si.wrapping_add(8));
        c.set_d(k.row, ax);
        if (ax as i16) < c.d(k.last) as i16 {
            if (c.db(k.flag) as i8) >= 0 {
                c.r[AX] = ax;
                return;
            }
            crested = true;
        }
    } else {
        // 27D5: the row the point's height reaches over its distance, for a point off the
        // screen's sides
        if c.d(si.wrapping_add(6)) >= 0x140 {
            let (h0, l0) = imul(c.d(si), c.d(si));
            c.set_bp(0x0, l0);
            c.set_bp(0x2, h0);
            let (h1, l1) = imul(c.d(si.wrapping_add(4)), c.d(si.wrapping_add(4)));
            let s = join(h1, l1).wrapping_add(join(h0, l0));
            c.r[AX] = s as u16;
            c.r[DX] = (s >> 16) as u16;
            sqrt(c);
            let mut cx = c.r[AX];
            if cx == 0 {
                cx = 1;
            }
            c.r[CX] = cx;
            let n = (c.d(si.wrapping_add(2)) as i16 as i32) << 6;
            c.set_ssb(0xc0, 0);
            let (mut q, mut rem) = c.idiv((n >> 16) as u16, n as u16, cx);
            if c.ssb(0xc0) != 0 {
                q = if (rem as i16) < 0 { 0x8000 } else { 0x7fff };
            } else {
                let carry = rem & 0x8000 != 0;
                rem <<= 1;
                if carry {
                    rem = rem.wrapping_neg();
                    if rem >= cx {
                        q = q.wrapping_sub(1);
                    }
                } else if q >= cx {
                    q = q.wrapping_add(1);
                }
            }
            ax = sar(q, 1).wrapping_neg().wrapping_add(c.bp(0x130));
        } else {
            ax = c.d(si.wrapping_add(8));
        }
        // 2864: the highest row at the nearest depth
        let dx = c.d(si.wrapping_add(4));
        c.r[DX] = dx;
        if (dx as i16) < c.d(k.depth) as i16 {
            c.set_d(k.depth, 0x7fff);
            if ax as i16 <= c.d(k.top) as i16 {
                c.set_d(k.top, ax);
            }
        } else {
            c.set_d(k.top, ax);
            c.set_d(k.depth, dx);
        }
        // 2888
        ax = c.d(si.wrapping_add(8));
        c.set_d(k.row, ax);
        if ax as i16 <= c.d(0x1f0) as i16 {
            c.set_d(0x1f0, ax);
            let bx = c.r[BX];
            c.set_d(0x1e8, bx);
            crested = true;
        } else if (ax as i16) < c.d(k.last) as i16 {
            crested = true;
        }
    }
    if crested {
        // 28A3
        let f = c.db(0x1e6) | 0x80;
        c.set_db(0x1e6, f);
        if c.db(0xfa) != 0 && c.r[BX] == 0x4c38 {
            let f = c.db(0x1e6) | 0x40;
            c.set_db(0x1e6, f);
        }
        c.set_db(k.flag, 0x80);
    } else if (c.db(k.flag) as i8) < 0 {
        // 28C1
        let f = c.db(0x1e6) | 0x40;
        c.set_db(0x1e6, f);
    }
    c.set_d(k.last, ax);
    c.r[AX] = ax;
}

/// 78C1: a point of the ground's profile for the texture (R:0644 up to R:0642, 8 bytes each),
/// half way across the section between its points at [bp+30] and [bp+30]+24h, moved along the
/// segment's heading (ES:DI the segment) by a quarter of its length.
pub fn ground_point(c: &mut Cpu) {
    let di0 = c.r[DI];
    if c.db(0x826) != 0 {
        return;
    }
    let mut bx = c.bp(0x30);
    let si = bx.wrapping_add(0x24);
    c.r[BX] = bx;
    c.r[SI] = si;
    if c.d(bx.wrapping_add(0xa)) & 0x10 != 0 || c.d(si.wrapping_add(0xa)) & 0x10 != 0 {
        return;
    }
    let cx = (c.e(di0.wrapping_add(0xc)) & 0x3f) << 5;
    let n = (c.e(di0.wrapping_add(0x16)) as i16 as i32) << 14;
    let k = sar(c.idiv((n >> 16) as u16, n as u16, cx).0, 1);
    let d = sar(c.d(si).wrapping_sub(c.d(bx)), 1);
    let mid = c.d(bx).wrapping_add(d);
    let (h, l) = imul(k, d);
    let x = ((join(h, l) << 2) >> 16) as u16;
    let x = x.wrapping_add(mid);
    let d = sar(
        c.d(si.wrapping_add(4))
            .wrapping_sub(c.d(bx.wrapping_add(4))),
        1,
    );
    let mid = c.d(bx.wrapping_add(4)).wrapping_add(d);
    let (h, l) = imul(k, d);
    let z = (((join(h, l) << 2) >> 16) as u16).wrapping_add(mid);
    c.r[AX] = x;
    c.r[DX] = z;
    let di = c.d(0x642);
    if di >= 0x824 {
        c.set_db(0x826, 0x80); // 7981: the list is full
        return;
    }
    c.set_d(di.wrapping_add(4), x);
    c.set_d(di.wrapping_add(2), z);
    let mut ax = c.d(bx.wrapping_add(8));
    if ax as i16 > c.d(si.wrapping_add(8)) as i16 {
        bx = si;
        c.r[BX] = bx;
        ax = c.d(bx.wrapping_add(8));
    }
    c.r[AX] = ax;
    if ax >= 0xa4 {
        return;
    }
    c.set_d(di.wrapping_add(6), ax);
    let h = c.d(bx.wrapping_add(2));
    c.r[AX] = h;
    c.set_d(di, h);
    c.set_d(0x642, di.wrapping_add(8));
    if di0 == c.c(0x73ac) {
        c.set_cb(0x73b0, 0x80);
    }
}

/// 32C3: a section's colours, at SI: +8 the road's (33h when R:0170 says so, else R:016C), +9
/// through the table R:0208 offset by R:016E, +E and +F the two nibbles of +A through R:0220.
pub fn colours(c: &mut Cpu) {
    let si = c.r[SI];
    let road = if c.db(0x170) != 0 { 0x33 } else { c.db(0x16c) };
    c.set_db(si.wrapping_add(8), road);
    let ax = (c.db(si.wrapping_add(9)) as u16).wrapping_add(c.d(0x16e));
    let v = c.db(ax.wrapping_add(0x208));
    c.set_db(si.wrapping_add(9), v);
    let lo = (c.db(si.wrapping_add(0xa)) & 0xf) as u16;
    let v = c.db(lo.wrapping_add(0x220));
    c.set_db(si.wrapping_add(0xe), v);
    let hi = (c.db(si.wrapping_add(0xa)) >> 4) as u16;
    let v = c.db(hi.wrapping_add(0x220));
    c.set_db(si.wrapping_add(0xf), v);
    c.r[AX] = ax & 0xff00 | v as u16;
    c.r[BX] = hi;
}

/// 3306: the section's edge flags (R:0146, the parts it has) checked against the section before
/// (at [bp+30] - D8h) and set at [[bp+2C]-0Ch]; R:0142 and R:0144 lose them.
pub fn markers(c: &mut Cpu) {
    let dx = c.d(0x146);
    let si = c.bp(0x2c);
    let di = c.bp(0x30).wrapping_sub(0xd8);
    c.r[SI] = si;
    let z = |c: &Cpu, o: u16| c.db(di.wrapping_add(o)) == 0;
    let mut ax = 0u16;
    if dx & 1 != 0 && z(c, 0x22) {
        ax |= 1;
    }
    if dx & 0x100 != 0
        && (z(c, 0x2e) || dx & 4 != 0 || (c.d(0x142) & 1 != 0 && (dx & 1 == 0 || ax & 1 != 0)))
    {
        ax |= 0x100;
    }
    if dx & 2 != 0 && z(c, 0x16) {
        ax |= 2;
    }
    if dx & 0x200 != 0
        && (z(c, 0xa) || dx & 8 != 0 || (c.d(0x142) & 2 != 0 && (dx & 2 == 0 || ax & 2 != 0)))
    {
        ax |= 0x200;
    }
    for (bit, a, b) in [
        (4, 0xb2, 0xbe),
        (8, 0x9a, 0xa6),
        (0x10, 0x82, 0x8e),
        (0x20, 0x6a, 0x76),
        (0x40, 0x52, 0x5e),
        (0x80, 0x3a, 0x46),
    ] {
        if dx & bit != 0 && (z(c, a) || z(c, b)) {
            ax |= bit;
        }
    }
    ax ^= dx;
    c.r[DX] = dx;
    let at = si.wrapping_sub(0xc);
    if c.db(0xfa) != 0 {
        let both = ax & 0x300;
        c.r[DX] = both;
        if both != 0 {
            if both == 0x300 {
                let v = c.d(at) | 0x400;
                c.set_d(at, v);
            } else {
                ax &= 0xff;
            }
        }
    }
    let v = c.d(at) | ax;
    c.set_d(at, v);
    let ax = !ax;
    let v = c.d(0x142) & ax;
    c.set_d(0x142, v);
    let v = c.d(0x144) & ax;
    c.set_d(0x144, v);
    c.r[AX] = ax;
}

/// 226B: the points at SI and BX moved down a row where they sit on the row of the point a
/// section back (D0h before), then the nibble of the ground's shade for the depth at SI written
/// into the segment's byte ES:[DI+25h] (the low nibble, or the high when [bp+14] is 6).
pub fn shade(c: &mut Cpu) {
    let odd = c.db(0x154) & 1 != 0;
    if ((c.bp(0x136) as i16) < 0) == odd {
        return;
    }
    for p in [c.r[SI], c.r[BX]] {
        let ax = c.d(p.wrapping_add(8));
        c.r[AX] = ax;
        if ax == c.d(p.wrapping_sub(0xd0)) {
            let o = c.d(p.wrapping_add(0xa)) & 0xfffc;
            let ax = ax.wrapping_add(1);
            c.set_d(p.wrapping_add(8), ax);
            c.set_d(p.wrapping_add(0xa), o | off_y(ax));
            c.r[AX] = ax;
        }
    }
    let si = c.r[SI];
    let d = c.d(si.wrapping_add(4));
    c.r[AX] = d;
    if (d as i16) < 0 {
        return;
    }
    let mut k = d >> 7;
    if k as i16 >= 8 {
        k = 7;
    }
    let shade = c.db(0x240u16.wrapping_add(k));
    let mut si = c.r[DI].wrapping_add(0x25);
    if (c.bp(0x136) as i16) < 0 {
        let (s, borrow) = si.overflowing_sub(0x2e);
        si = s;
        if (borrow || si < 0x30) && c.s[ES] == c.bp(0x100) && (c.bpb(0x172) as i8) >= 0 {
            si = si.wrapping_add(c.bp(0x158));
        }
    }
    c.r[SI] = si;
    let v = c.eb(si);
    if c.bpb(0x14) == 6 {
        c.set_eb(si, v & 0xf | shade << 4);
        c.r[AX] = (shade as u16) << 4;
    } else {
        c.set_eb(si, v & 0xf0 | shade);
        c.r[AX] = shade as u16;
    }
}

/// 20D9 for the ports that call it.
pub fn project_world(c: &mut Cpu) {
    let (m, r) = c.split();
    point::point(m, r, Entry::World);
}
