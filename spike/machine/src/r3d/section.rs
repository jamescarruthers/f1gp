//! A cross-section's points (gp.exe 0F47:2445 to 32C2): the segment walk calls this for each
//! segment it draws, with ES:DI the segment's record and [bp+30] the section's block of 18
//! points (12 bytes each, the projection's records; the section before at -D8h). R:0146 says
//! which of the section's parts to place; each stage places one part's points from the segment's
//! position (+4 x, +6 height, +8 z), its heading (+C, +E, scaled down 64) and its half-widths
//! (+11 left, +13 right), and projects them (20D9):
//! - 2A04: the outer walls on each side (R:0146 bits 80h, 40h; points +30, +3C and +48, +54);
//! - 2D12: the kerbs (bits 8, 4; +9C, +90 and +A8, +B4);
//! - 2EFC: the edges' inner points (bits 2, 1; +0C, +18);
//! - 2F7C: the fences (bits 20h, 10h; +60 raised to +6C, +78 raised to +84), placed by the pit
//!   lane's posts (2445) or along the segment (25D3) where the segment says so;
//! - 3181: the road's edges (+00, +24), the crests (279E, 28D1) and the ground's profile (78C1).
//!
//! The routine has four entries (2A04, 2D12, 2F7C, 3181) and runs from each to its end. It keeps
//! no registers, so the port follows them as the game's code does.
//!
//! Each step below names the game's instruction it stands for.

use super::regs::*;
use super::track;

/// Where the walk entered the routine.
#[derive(Clone, Copy, PartialEq, PartialOrd)]
pub enum Entry {
    Walls,  // 2A04
    Kerbs,  // 2D12
    Fences, // 2F7C
    Edges,  // 3181
}

/// AL sign-extended (CBW).
fn cbw(b: u8) -> u16 {
    b as i8 as i16 as u16
}

/// The segment's record at ES:DI.
fn seg(c: &Cpu, o: u16) -> u16 {
    c.e(c.r[DI].wrapping_add(o))
}
fn segb(c: &Cpu, o: u16) -> u8 {
    c.eb(c.r[DI].wrapping_add(o))
}

/// IMUL then the 32-bit product shifted left n times (SHL AX / RCL DX): DX:AX set.
fn imul_shl(c: &mut Cpu, a: u16, b: u16, n: u32) {
    let (h, l) = imul(a, b);
    let v = join(h, l) << n;
    c.r[AX] = v as u16;
    c.r[DX] = (v >> 16) as u16;
}
/// IMUL then the product shifted right n times (SAR DX / RCR AX): DX:AX set.
fn imul_sar(c: &mut Cpu, a: u16, b: u16, n: u32) {
    let (h, l) = imul(a, b);
    let v = (join(h, l) as i32) >> n;
    c.r[AX] = v as u16;
    c.r[DX] = (v >> 16) as u16;
}
fn add_bp(c: &mut Cpu, o: u16, v: u16) {
    let x = c.bp(o).wrapping_add(v);
    c.set_bp(o, x);
}
fn sub_bp(c: &mut Cpu, o: u16, v: u16) {
    let x = c.bp(o).wrapping_sub(v);
    c.set_bp(o, x);
}
/// SI = [bp+30] + k, AX = n, CX = the height, then 20D9.
fn project(c: &mut Cpu, k: u16, n: u16, height: u16) {
    c.r[CX] = height;
    c.r[SI] = c.bp(0x30).wrapping_add(k);
    c.r[AX] = n;
    track::project_world(c);
}

/// The cross-section from `entry` on.
pub fn section(c: &mut Cpu, entry: Entry) {
    if entry <= Entry::Walls {
        walls(c, 0);
        walls(c, 1);
    }
    if entry <= Entry::Kerbs {
        kerbs(c, 0);
        kerbs(c, 1);
        inner(c, 0);
        inner(c, 1);
    }
    if entry <= Entry::Fences {
        fences(c, 0);
        fences(c, 1);
    }
    edges(c);
}

/// 2A04, 2B8B: the outer wall on one side (0 left, 1 right).
fn walls(c: &mut Cpu, side: u16) {
    let (bit, byte, points, n) = if side == 0 {
        (0x80, 0x1c, 0x30, 7)
    } else {
        (0x40, 0x1d, 0x48, 6)
    };
    if c.d(0x146) & bit == 0 {
        return;
    }
    let mut dl = segb(c, byte);
    c.r[DX] = c.r[DX] & 0xff00 | dl as u16;
    c.set_bp(0x10, seg(c, 4));
    c.set_bp(0x14, seg(c, 8));
    c.set_d(0x156, seg(c, 6));
    c.r[CX] = 2;
    if segb(c, 0x1f) & bit as u8 != 0 {
        // 2A33: a wall set back by the table at R:00B6 (index +1C less 7Ch)
        let al = dl.wrapping_sub(0x7c);
        c.r[AX] = c.r[AX] & 0xff00 | al as u16;
        c.set_db(0x154, al);
        if al < 8 {
            let ax = c.r[AX] & 7;
            c.r[AX] = ax;
            let si = 0xb6 + ax;
            c.r[SI] = si;
            let cl = c.db(si);
            c.r[CX] = cl as u16;
            if cl != 0 {
                let w = c.d(si.wrapping_add(ax).wrapping_add(0x28));
                let (h, l) = imul(w, seg(c, 2));
                c.r[AX] = l;
                c.r[DX] = h;
                let v = c.d(0x156).wrapping_add(h);
                c.set_d(0x156, v);
            }
            c.r[CX] <<= 8;
            let k = c.r[CX];
            imul_shl(c, sar(seg(c, 0xe), 6), k, 3);
            add_bp(c, 0x10, c.r[DX]);
            imul_shl(c, sar(seg(c, 0xc), 6), k, 3);
            add_bp(c, 0x14, c.r[DX]);
            dl = c.db(si.wrapping_add(8));
            c.r[DX] = c.r[DX] & 0xff00 | dl as u16;
        }
        c.r[CX] = 3;
    }
    // 2A95: the wall's foot, +1C (or the table's) x 256 out along the heading's normal
    let k = (dl as u16) << 8;
    c.r[DX] = k;
    let shifts = c.r[CX] as u32;
    imul_shl(c, sar(seg(c, 0xc), 6), k, shifts);
    add_bp(c, 0x10, c.r[DX]);
    imul_shl(c, sar(seg(c, 0xe), 6), k, shifts);
    sub_bp(c, 0x14, c.r[DX]);
    let (x, z) = (c.bp(0x10), c.bp(0x14));
    let h = c.d(0x156);
    project(c, points, n, h);
    c.set_bp(0x14, z);
    c.set_bp(0x10, x);
    // 2AE9: its top, the half-widths on
    c.r[CX] = cbw(segb(c, 0x13));
    c.r[AX] = cbw(segb(c, 0x11));
    if segb(c, 0x1f) & bit as u8 != 0 {
        if c.db(0x154) < 8 {
            // 2B03: the table's offset for the top
            let ax = (c.r[AX] & 0xff00 | c.db(0x154) as u16) & 7;
            c.r[AX] = ax;
            let si = 0xb6 + ax;
            c.r[SI] = si;
            let k = (c.db(si.wrapping_add(0x10)) as u16) << 8;
            c.r[DX] = k;
            imul_shl(c, sar(seg(c, 0xe), 6), k, 3);
            c.r[CX] = c.r[DX];
            c.r[DX] = k;
            imul_shl(c, sar(seg(c, 0xc), 6), k, 3);
            c.r[AX] = c.r[DX];
            add_bp(c, 0x10, c.r[AX]);
            sub_bp(c, 0x14, c.r[CX]);
            let h = c.d(0x156);
            project(c, points + 0xc, n, h);
            // 2B5A: the ground's shade under the wall
            let bx = c.r[BX];
            c.set_bp(0x14, n);
            let p = c.bp(0x30);
            c.r[SI] = p.wrapping_add(points);
            c.r[BX] = p.wrapping_add(points + 0xc);
            track::shade(c);
            c.r[BX] = bx;
            return;
        }
    } else {
        // 2B71
        c.r[AX] = sar(c.r[AX], 1);
        c.r[CX] = sar(c.r[CX], 1);
    }
    // 2B75
    add_bp(c, 0x10, c.r[AX]);
    sub_bp(c, 0x14, c.r[CX]);
    let h = c.d(0x156);
    project(c, points + 0xc, n, h);
}

/// 2D12, 2E0B: the kerb on one side (0 left, 1 right): two points, one and a half (or two)
/// half-widths out and an eighth further, raised by R:015A.
fn kerbs(c: &mut Cpu, side: u16) {
    let (bit, flag, first, second, n, sign, set) = if side == 0 {
        (8, 8, 0x9c, 0x90, 3, true, 0x200)
    } else {
        (4, 4, 0xa8, 0xb4, 2, false, 0x100)
    };
    if c.d(0x146) & bit == 0 {
        return;
    }
    // 2D1D: the kerb's height: 0, or 20h (14h when +26 bit 4) where +0A lacks the side's bit
    c.set_d(0x15a, 0);
    if segb(c, 0xa) & flag as u8 == 0 {
        c.set_d(0x15a, 0x20);
        if segb(c, 0x26) & 4 != 0 {
            c.set_d(0x15a, 0x14);
        }
    }
    let wide = segb(c, 0x26) & 4 != 0;
    let out = |c: &mut Cpu, half: u8, heading: u16| -> u16 {
        let mut ax = cbw(half) << 1;
        c.r[AX] = ax;
        if wide {
            let cx = sar(ax, 1);
            c.r[CX] = cx;
            ax = ax.wrapping_add(cx);
        }
        let dx = sar(seg(c, heading), 6);
        c.r[DX] = dx;
        ax = ax.wrapping_add(dx);
        if sign {
            ax = ax.wrapping_neg();
        }
        c.r[AX] = ax;
        ax
    };
    c.set_bp(0x10, seg(c, 4));
    c.set_bp(0x14, seg(c, 8));
    let a = out(c, segb(c, 0x11), 0xc);
    add_bp(c, 0x10, a);
    let a = out(c, segb(c, 0x13), 0xe);
    sub_bp(c, 0x14, a);
    let h = seg(c, 6).wrapping_add(c.d(0x15a));
    project(c, first, n, h);
    // 2DA4: the second point: the half-width, the heading and an eighth plus a thirty-second of it
    c.set_bp(0x10, seg(c, 4));
    c.set_bp(0x14, seg(c, 8));
    let near = |c: &mut Cpu, heading: u16, half: u8| -> u16 {
        let dx = sar(seg(c, heading), 6);
        let cx = sar(sar(dx, 3).wrapping_add(dx), 2);
        c.r[DX] = dx;
        c.r[CX] = cx;
        let mut ax = cbw(half).wrapping_add(cx).wrapping_add(dx);
        if sign {
            ax = ax.wrapping_neg();
        }
        c.r[AX] = ax;
        ax
    };
    let a = near(c, 0xc, segb(c, 0x11));
    add_bp(c, 0x10, a);
    let a = near(c, 0xe, segb(c, 0x13));
    sub_bp(c, 0x14, a);
    let h = seg(c, 6).wrapping_add(c.d(0x15a));
    project(c, second, n, h);
    let v = c.d(0x146) | set;
    c.set_d(0x146, v);
}

/// 2EFC, 2F3C: the edge's inner point on one side (0 left, 1 right), the heading's length in.
fn inner(c: &mut Cpu, side: u16) {
    let (bit, point, n, set) = if side == 0 {
        (2, 0xc, 1, 0x200)
    } else {
        (1, 0x18, 0, 0x100)
    };
    if c.d(0x146) & bit == 0 {
        return;
    }
    let mut x = sar(seg(c, 0xc), 6);
    if side == 0 {
        x = x.wrapping_neg();
    }
    x = x.wrapping_add(seg(c, 4));
    c.set_bp(0x10, x);
    let mut z = sar(seg(c, 0xe), 6);
    if side == 1 {
        z = z.wrapping_neg();
    }
    z = z.wrapping_add(seg(c, 8));
    c.r[AX] = z;
    c.set_bp(0x14, z);
    let h = seg(c, 6);
    project(c, point, n, h);
    let v = c.d(0x146) | set;
    c.set_d(0x146, v);
}

/// 2F7C, 307D: the fence on one side (0 left, 1 right): its foot (+60 or +78), then its top
/// raised by the post height from R:018C.
fn fences(c: &mut Cpu, side: u16) {
    let (bit, foot, n, width, flag, low) = if side == 0 {
        (0x20u16, 0x60, 5, 0x28, 0x6e, 0x6a)
    } else {
        (0x10, 0x78, 4, 0x29, 0x70, 0x6c)
    };
    if c.d(0x146) & bit == 0 {
        return;
    }
    if segb(c, 0x1f) & bit as u8 != 0 {
        // 2F8E: in the pit lane, by its posts
        c.r[CX] = bit;
        c.set_db(0x1be, if side == 0 { 0xff } else { 0 });
        c.set_bp(0x18, width);
        if pit_post(c) {
            return;
        }
    }
    if segb(c, 0x26) & bit as u8 != 0 {
        // 2FAA: along the segment
        c.r[CX] = bit;
        c.set_bp(0x18, width);
        along(c);
    } else {
        // 2FB8: out from the edge by the half-width plus the heading, times (+28 + 20h) / 32
        let k = (segb(c, width) as u16).wrapping_add(0x20);
        let ax = cbw(segb(c, 0x11)).wrapping_add(sar(seg(c, 0xc), 6));
        imul_sar(c, ax, k, 5);
        let mut x = c.r[AX];
        if side == 0 {
            x = x.wrapping_neg();
        }
        x = x.wrapping_add(seg(c, 4));
        c.r[AX] = x;
        c.set_bp(0x10, x);
        let ax = cbw(segb(c, 0x13)).wrapping_add(sar(seg(c, 0xe), 6));
        imul_sar(c, ax, k, 5);
        let mut z = c.r[AX];
        if side == 1 {
            z = z.wrapping_neg();
        }
        z = z.wrapping_add(seg(c, 8));
        c.r[AX] = z;
        c.set_bp(0x14, z);
    }
    // 301D
    let h = seg(c, 6);
    project(c, foot, n, h);
    let si = c.r[SI];
    if c.bpb(0x172) == 0 && c.d(si.wrapping_add(0xa)) & 0x10 == 0 {
        // 303B: the fence's foot nearest the screen's side, kept at R:006E (R:0070)
        let ax = c.d(si.wrapping_add(6));
        c.r[AX] = ax;
        let reversed = (c.bp(0x136) as i16) < 0;
        let further = if reversed == (side == 0) {
            (ax as i16) < c.d(flag) as i16
        } else {
            ax as i16 > c.d(flag) as i16
        };
        if further {
            c.set_d(flag, ax);
            let v = c.d(0x66);
            c.set_d(low, v);
        }
    }
    // 305F: the post height by the heading's bits
    let e = seg(c, 0xe);
    let cx = if side == 0 {
        let k = (e & 7) << 1;
        c.r[AX] = k;
        c.d(0x18c + k)
    } else {
        let k = (e & 0x38) >> 2;
        c.r[AX] = k;
        c.d(0x18c + k + 0x10)
    };
    c.r[CX] = cx;
    let p = c.bp(0x30);
    c.r[SI] = p.wrapping_add(foot);
    c.r[BX] = p.wrapping_add(foot + 0xc);
    track::raise(c);
}

/// 3181: the road's edges, then the crests and the ground's profile point.
fn edges(c: &mut Cpu) {
    if c.db(0x147) == 0 {
        return;
    }
    // 318B: the segment's height change summed at R:013C (32-bit); a big one flags R:014A
    let mut ax = seg(c, 0).wrapping_sub(c.bp(0x14e));
    let dx = if (ax as i16) < 0 { 0xffff } else { 0 };
    let s = join(c.d(0x13e), c.d(0x13c)).wrapping_add(join(dx, ax));
    c.set_d(0x13c, s as u16);
    c.set_d(0x13e, (s >> 16) as u16);
    c.r[DX] = dx;
    if (s as i32) < 0 {
        ax = ax.wrapping_neg();
    }
    c.r[AX] = ax;
    if ax as i16 >= 0x4000 {
        let f = c.db(0x14a) | 0x80;
        c.set_db(0x14a, f);
    }
    if c.d(0x146) & 0x200 != 0 {
        // 31B1: the left edge
        let x = sar(seg(c, 0xc), 6)
            .wrapping_neg()
            .wrapping_add(seg(c, 4))
            .wrapping_sub(cbw(segb(c, 0x11)));
        c.set_bp(0x10, x);
        let z = sar(seg(c, 0xe), 6)
            .wrapping_add(seg(c, 8))
            .wrapping_add(cbw(segb(c, 0x13)));
        c.r[AX] = cbw(segb(c, 0x13));
        c.set_bp(0x14, z);
        let h = seg(c, 6);
        project(c, 0, 1, h);
    }
    if c.d(0x146) & 0x100 != 0 {
        // 31FB: the right edge
        let x = sar(seg(c, 0xc), 6)
            .wrapping_add(seg(c, 4))
            .wrapping_add(cbw(segb(c, 0x11)));
        c.set_bp(0x10, x);
        let z = sar(seg(c, 0xe), 6)
            .wrapping_neg()
            .wrapping_add(seg(c, 8))
            .wrapping_sub(cbw(segb(c, 0x13)));
        c.r[AX] = cbw(segb(c, 0x13));
        c.set_bp(0x14, z);
        let h = seg(c, 6);
        project(c, 0x24, 0, h);
    }
    if c.d(0x146) & 0x200 == 0 || c.d(0x146) & 0x100 == 0 || c.bpb(0x172) != 0 {
        return;
    }
    // 3254: the crests along both edges
    let bx = c.bp(0x28);
    c.r[BX] = bx;
    c.set_db(0x1e6, 0);
    c.r[SI] = c.bp(0x30);
    track::crest(c, &track::LEFT);
    c.r[SI] = c.bp(0x30).wrapping_add(0x24);
    track::crest(c, &track::RIGHT);
    let bx = c.r[BX];
    if c.db(0x1e6) & 0x80 != 0 {
        // 3275: a crest: the walk's place and the edges' rows into the crest list at BX
        let v = c.bp(0x2c);
        c.set_d(bx, v);
        let v = c.bp(0x30);
        c.set_d(bx.wrapping_add(4), v);
        let di = c.r[DI];
        c.set_d(bx.wrapping_add(8), di);
        let es = c.s[ES];
        c.set_d(bx.wrapping_add(0xa), es);
        let mut ax = c.d(0x1f2);
        c.set_d(bx.wrapping_add(0xc), ax);
        let v = c.d(0x1fc);
        c.set_d(bx.wrapping_add(0xe), v);
        if ax as i16 > c.d(0x1fc) as i16 {
            ax = c.d(0x1fc);
        }
        c.r[AX] = ax;
        c.set_d(bx.wrapping_add(0x10), ax);
        let v = c.d(0x66);
        c.set_d(0x64, v);
    }
    if c.db(0x1e6) & 0x40 != 0 {
        // 32AE: the next crest's entry
        let bx = bx.wrapping_add(0x12);
        c.r[BX] = bx;
        c.set_bp(0x28, bx);
        c.set_db(0x1f6, 0);
        c.set_db(0x200, 0);
    }
    track::ground_point(c);
}

/// A fence's offset at the segment ES:DI: the half-widths plus the heading, times the segment's
/// width byte at [bp+18] plus R:01C0, over 32 (AX across, BX along); CX kept.
fn fence_offset(c: &mut Cpu) {
    let cx0 = c.r[CX];
    let w = (c.eb(c.r[BX].wrapping_add(c.r[DI])) as u16).wrapping_add(c.d(0x1c0));
    let a = cbw(segb(c, 0x13)).wrapping_add(sar(seg(c, 0xe), 6));
    imul_sar(c, a, w, 5);
    let bx = c.r[AX];
    let a = cbw(segb(c, 0x11)).wrapping_add(sar(seg(c, 0xc), 6));
    imul_sar(c, a, w, 5);
    c.r[BX] = bx;
    c.set_bp(0x10, seg(c, 4));
    c.set_bp(0x14, seg(c, 8));
    c.r[CX] = cx0;
}

/// 2445: a pit-lane fence post: if the segment (DI) is one of the four at R:01AC, its fence's
/// foot placed out from the pit lane's segment (the far pointer [bp+160] for the first two, [bp+164]
/// for the others) and its top raised (+60 and +6C, or +78 and +84 by R:01BE), and true (the
/// game's zero flag: the caller skips its own); else false.
fn pit_post(c: &mut Cpu) -> bool {
    let mut si = 0x1acu16;
    let mut ax = 3u16;
    loop {
        if c.r[DI] == c.d(si) {
            break;
        }
        si = si.wrapping_add(4);
        ax = ax.wrapping_sub(1);
        if (ax as i16) < 0 {
            c.r[SI] = si;
            c.r[AX] = ax | 0x80;
            return false;
        }
    }
    // 245A
    c.r[SI] = si;
    let (es0, di0) = (c.s[ES], c.r[DI]);
    let k = ax ^ 3;
    let p = if (k as i16) < 2 { 0x160 } else { 0x164 };
    c.s[ES] = c.bp(p + 2);
    c.r[DI] = c.bp(p);
    c.set_db(0x1bc, k as u8);
    c.r[AX] = k;
    c.r[BX] = c.bp(0x18);
    fence_offset(c);
    let (mut ax, mut bx) = (c.r[AX], c.r[BX]);
    let mut dx = seg(c, 0xe);
    let height = if c.db(0x1bc) & 1 != 0 {
        ax = ax.wrapping_neg();
        bx = bx.wrapping_neg();
        dx = (dx & 7) << 1;
        c.d(0x18c + dx)
    } else {
        dx = (dx & 0x38) >> 2;
        c.d(0x18c + dx + 0x10)
    };
    c.r[DX] = dx;
    c.r[AX] = ax;
    c.r[BX] = bx;
    add_bp(c, 0x10, ax);
    sub_bp(c, 0x14, bx);
    let h = seg(c, 6);
    let (foot, n) = if c.db(0x1be) != 0 {
        (0x60, 5)
    } else {
        (0x78, 4)
    };
    project(c, foot, n, h);
    c.r[CX] = height;
    let p = c.bp(0x30);
    c.r[SI] = p.wrapping_add(foot);
    c.r[BX] = p.wrapping_add(foot + 0xc);
    track::raise(c);
    c.s[ES] = es0;
    c.r[DI] = di0;
    c.r[AX] &= 0xff00;
    true
}

/// 25D3 (far): the fence's foot along a run of segments whose fence leans (+1A bit 0): placed
/// between the feet at the run's two ends (R:0172 segments on, R:0174 back), in proportion.
pub fn along(c: &mut Cpu) {
    let (es0, di0, keep) = (c.s[ES], c.r[DI], c.bp(0x1c));
    let bx = c.bp(0x18);
    let di = c.r[DI];
    let cl = c.r[CX] as u8;
    let leans = segb(c, 0x1a) & 1 != 0;
    let next = segb(c, 0x54) & cl != 0;
    let at = |c: &Cpu, d: u16| c.eb(bx.wrapping_add(di).wrapping_add(d)) as u16;
    // the run's lengths on and back
    let on = if leans {
        if next {
            at(c, 0x2e).wrapping_add(1)
        } else {
            at(c, 0xffd2).wrapping_sub(1)
        }
    } else {
        at(c, 0)
    };
    let back = if !leans {
        if next {
            at(c, 0x2e).wrapping_sub(1)
        } else {
            at(c, 0xffd2).wrapping_add(1)
        }
    } else {
        at(c, 0)
    };
    c.set_d(0x172, on);
    c.set_d(0x174, back);
    let mut total = on.wrapping_add(back);
    let n = (back as u32) << 14;
    if (total as i16) < 1 {
        total = 1;
    }
    let f = c.div((n >> 16) as u16, n as u16, total).0;
    c.set_bp(0x1c, f);
    // 264B: the foot a run back
    c.r[DI] = di.wrapping_sub(back.wrapping_mul(0x2e));
    c.r[BX] = bx;
    fence_offset(c);
    let (mut ax, mut bxv) = (c.r[AX], c.r[BX]);
    if cl == 0x20 {
        ax = ax.wrapping_neg();
        bxv = bxv.wrapping_neg();
    }
    add_bp(c, 0x10, ax);
    sub_bp(c, 0x14, bxv);
    let (x0, z0) = (c.bp(0x10), c.bp(0x14));
    c.set_d(0x176, x0);
    c.set_d(0x178, z0);
    // 26DD: and a run on
    c.r[DI] = di.wrapping_add(c.d(0x172).wrapping_mul(0x2e));
    c.r[BX] = bx;
    fence_offset(c);
    let (mut ax, mut bxv) = (c.r[AX], c.r[BX]);
    if cl == 0x20 {
        ax = ax.wrapping_neg();
        bxv = bxv.wrapping_neg();
    }
    let x1 = ax.wrapping_add(c.bp(0x10));
    let z1 = bxv.wrapping_neg().wrapping_add(c.bp(0x14));
    c.set_d(0x17a, x1);
    c.set_d(0x17c, z1);
    // 2766: in between, by [bp+1C]
    let (dx, ax) = imul(x1.wrapping_sub(x0), c.bp(0x1c));
    let x = (((join(dx, ax) << 2) >> 16) as u16).wrapping_add(x0);
    c.set_bp(0x10, x);
    let (dx, ax) = imul(z1.wrapping_sub(z0), c.bp(0x1c));
    let v = join(dx, ax) << 2;
    let z = ((v >> 16) as u16).wrapping_add(z0);
    c.set_bp(0x14, z);
    c.r[AX] = z;
    c.r[BX] = z1.wrapping_sub(z0);
    c.r[DX] = (v >> 16) as u16;
    c.set_bp(0x1c, keep);
    c.r[DI] = di0;
    c.s[ES] = es0;
}
