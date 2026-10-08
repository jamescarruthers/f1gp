//! The segment walk (gp.exe 0F47:3B32 to 49BF, with its loops 343A to 3AAA; docs/renderer-notes.md,
//! section 2): the segments to draw from the camera's out, at less detail with distance, each
//! one's cross-section built (src/r3d/section.rs) and recorded for the drawing.
//!
//! The segments are records of 2Eh bytes in ES (the circuit's array [bp+158] bytes long, from 30h
//! to [bp+15C], or the pit lane's); DI walks them, wrapping round. The walk goes one way or the
//! other by the camera's facing ([bp+136] bit 15, "reversed"), in bands at the distances R:01E2,
//! 01DE, 01DA, 01D6 (far to near: the edges only, fences, kerbs, then everything), then behind
//! the camera (R:01D2 and, for the road drawn as polygons, R:01CE, 01CA, 01C6), each band's
//! cross-sections by the builder entry it sets at R:0020. For each segment drawn:
//! - its cross-section's points, into the block at [bp+30] (D8h bytes a section);
//! - a strip record of 10h bytes at [bp+2C] (its parts, its colours by 32C3, its object list);
//! - an object list entry (8 bytes) at [bp+24] where the segment has objects;
//! - crests, into the list at [bp+28].
//!
//! The loops leave early when the strip list fills (R:00EE: on to 3D28) or the walk reaches the
//! array's end (R:0124: SP reset from R:0132 and on to 41CE), both into the forward walk's tail,
//! whichever way the walk was going (the reverse walk's own copies are never reached).
//!
//! Each step below names the game's instruction it stands for.

use super::regs::*;
use super::section::{self, Entry};
use super::track;

/// Why a loop left early.
enum Esc {
    /// the strip list is full: on to 3D28
    Full,
    /// the end of the walk: SP reset, on to 41CE
    End,
}

type Step = Result<(), Esc>;

fn segb(c: &Cpu, o: u16) -> u8 {
    c.eb(c.r[DI].wrapping_add(o))
}
fn seg(c: &Cpu, o: u16) -> u16 {
    c.e(c.r[DI].wrapping_add(o))
}
fn reversed(c: &Cpu) -> bool {
    (c.bp(0x136) as i16) < 0
}
/// ES is the circuit's segment array (not the pit lane's).
fn circuit(c: &Cpu) -> bool {
    c.s[ES] == c.bp(0x100)
}

/// 3518: on to the next segment (R:0188 bytes on), R:0066 counting down; at R:011C the walk
/// wraps to R:0120, or ends there if it is R:0124.
fn advance(c: &mut Cpu) -> Step {
    let di = c.r[DI].wrapping_add(c.d(0x188));
    c.r[DI] = di;
    let n = c.d(0x66).wrapping_sub(1);
    c.set_d(0x66, n);
    if di == c.d(0x11c) {
        if di == c.d(0x124) {
            if c.db(0x158) == 0 {
                return Err(Esc::End);
            }
        } else {
            c.r[DI] = c.d(0x120);
            if c.d(0x124) != 0 {
                let v = c.d(0x124);
                c.set_d(0x11c, v);
            }
        }
    }
    Ok(())
}

/// 344D: an object list entry for the segment: R:0066, R:0064 and ES:DI at [bp+24].
fn object(c: &mut Cpu) {
    let si = c.bp(0x24);
    c.r[SI] = si;
    let v = c.d(0x66);
    c.set_d(si, v);
    let v = c.d(0x64);
    c.set_d(si.wrapping_add(2), v);
    let di = c.r[DI];
    c.set_d(si.wrapping_add(4), di);
    let es = c.s[ES];
    c.set_d(si.wrapping_add(6), es);
    let v = c.bp(0x24).wrapping_add(8);
    c.set_bp(0x24, v);
}

/// The builder entry at R:0020 (SI set to it, as the game's CALL SI).
fn build(c: &mut Cpu) {
    let at = c.d(0x20);
    c.r[SI] = at;
    let entry = match at {
        0x2a04 => Entry::Walls,
        0x2d12 => Entry::Kerbs,
        0x2f7c => Entry::Fences,
        0x3181 => Entry::Edges,
        _ => panic!("the walk's builder at {at:04x}?"),
    };
    section::section(c, entry);
}

/// 3485: the section's points kept ([bp+30] on), and its strip record at [bp+2C].
fn record(c: &mut Cpu) -> Step {
    let v = c.bp(0x30).wrapping_add(0xd8);
    c.set_bp(0x30, v);
    let si = c.bp(0x2c);
    c.r[SI] = si;
    let v = c.d(0x146);
    c.set_d(si, v);
    let back = reversed(c);
    let al = if back { segb(c, 0xffdd) } else { segb(c, 0xb) };
    let ax = ((c.db(0x14c) as u16) << 8 | al as u16) & c.d(0x144);
    c.set_d(si.wrapping_add(2), ax);
    let v = c.db(0x14e);
    c.set_db(si.wrapping_add(5), v);
    let v = c.db(0x148);
    c.set_db(si.wrapping_add(4), v);
    c.r[AX] = ax & 0xff00 | v as u16;
    let v = c.d(0x14a);
    c.set_d(si.wrapping_add(6), v);
    let (a, b) = if back { (0xfff4, 0xfff6) } else { (0x22, 0x24) };
    let v = seg(c, a);
    c.set_d(si.wrapping_add(8), v);
    let v = seg(c, b);
    c.set_d(si.wrapping_add(0xa), v);
    let v = c.d(0x66);
    c.set_d(si.wrapping_add(0xc), v);
    track::colours(c);
    let si = c.r[SI].wrapping_add(0x10);
    c.r[SI] = si;
    c.set_bp(0x2c, si);
    c.set_d(0x14a, 0);
    if si >= c.d(0xee) {
        return Err(Esc::Full);
    }
    Ok(())
}

/// The segment's parts wanted: AX's, masked as the game does, into R:0146 and R:0148 (with DX).
fn wanted(c: &mut Cpu, ax: u16) -> bool {
    let ax = ax & 0x3ff & c.d(0x142);
    c.r[AX] = ax;
    ax != 0
}

/// 343A: one segment at DI, BX the field of its parts, AX and DX the parts wanted.
fn one(c: &mut Cpu) -> Step {
    let dx = c.r[DX] & c.d(0x142);
    c.r[DX] = dx;
    if c.r[BX] == 0x27 {
        c.r[BX] = 0x26;
    }
    if (c.eb(c.r[BX].wrapping_add(c.r[DI])) as i8) < 0 {
        object(c);
    }
    let ax = (c.r[AX] | dx) & c.d(0x142);
    c.r[AX] = ax;
    c.set_d(0x146, ax);
    if ax != 0 {
        let ax = (ax & 0xff00 | (ax as u8 & segb(c, 0x22)) as u16) | dx;
        c.r[AX] = ax;
        c.set_d(0x148, ax);
        build(c);
        record(c)?;
    }
    advance(c)
}

/// 354F: the segments up to R:0118, BX the field of their parts.
fn run(c: &mut Cpu) -> Step {
    while c.r[DI] != c.d(0x118) {
        let mut al = c.eb(c.r[BX].wrapping_add(c.r[DI]));
        c.r[AX] = c.r[AX] & 0xff00 | al as u16;
        if al != 0 {
            if (al as i8) < 0 {
                object(c);
                al &= 0x7f;
                c.r[AX] = c.r[AX] & 0xff00 | al as u16;
            }
            if al != 0 && wanted(c, (al as u16) << 8 | al as u16) {
                let dx = segb(c, 0x22) as u16;
                c.r[DX] = dx;
                let bx = c.r[BX];
                let ax = c.r[AX];
                c.set_d(0x146, ax);
                c.r[AX] = ax & dx;
                c.set_d(0x148, ax & dx);
                build(c);
                record(c)?;
                c.r[BX] = bx;
            }
        }
        advance(c)?;
    }
    Ok(())
}

/// 367E (and 3910, `behind`): the near band, all of each segment, CX counting the segments: the
/// fourth's parts (the seventh's behind) all wanted, the fifth's colours changed (the eighth's).
/// Behind, the walk stops where 3306 leaves R:0144 empty; returns whether R:0142 is not.
fn near(c: &mut Cpu, behind: bool) -> Result<bool, Esc> {
    let (all, colour) = if behind { (6, 7) } else { (3, 4) };
    if c.r[DI] == c.d(0x118) {
        return Ok(c.d(0x142) != 0);
    }
    c.r[CX] = 0;
    loop {
        if (segb(c, 0x26) as i8) < 0 {
            object(c);
        }
        let al = segb(c, 0x27);
        let dl = segb(c, 0x22);
        let mut ax = c.r[AX] & 0xff00 | al as u16;
        let mut dx = c.r[DX] & 0xff00 | dl as u16;
        if c.r[CX] == all {
            dx |= 0xf;
            ax |= 3;
        } else if c.r[CX] == colour {
            if !behind {
                c.set_db(0x15c, 0x80);
                let v = c.d(0x15e);
                c.set_d(0x16c, v);
                c.set_d(0x16e, 0x10);
            } else {
                let v = c.d(0x160);
                c.set_d(0x16c, v);
                c.set_d(0x16e, 8);
            }
        }
        c.r[DX] = dx;
        let al = ax as u8;
        if wanted(c, (al as u16) << 8 | al as u16) {
            let cx = c.r[CX];
            let ax = c.r[AX];
            c.set_d(0x146, ax);
            c.r[AX] = ax & dx;
            c.set_d(0x148, ax & dx);
            section::section(c, Entry::Walls);
            record(c)?;
            if behind {
                // 3A16: on, then CX back and counted, then 3306
                advance(c)?;
                c.r[CX] = cx.wrapping_add(1);
                track::markers(c);
                if c.d(0x144) == 0 || c.r[DI] == c.d(0x118) {
                    return Ok(c.d(0x142) != 0);
                }
                continue;
            }
            // 3789: CX back, then on
            c.r[CX] = cx;
            advance(c)?;
        } else {
            advance(c)?;
        }
        c.r[CX] = c.r[CX].wrapping_add(1);
        if c.r[DI] == c.d(0x118) {
            return Ok(c.d(0x142) != 0);
        }
    }
}

/// 37CE: the segments up to R:0118 behind the camera, BX the field of their parts, until 3306
/// leaves R:0144 with parts; returns whether R:0142 has any.
fn behind(c: &mut Cpu) -> Result<bool, Esc> {
    while c.r[DI] != c.d(0x118) {
        let mut al = c.eb(c.r[BX].wrapping_add(c.r[DI]));
        c.r[AX] = c.r[AX] & 0xff00 | al as u16;
        if al != 0 {
            if (al as i8) < 0 {
                object(c);
                al &= 0x7f;
                c.r[AX] = c.r[AX] & 0xff00 | al as u16;
            }
            if al != 0 && wanted(c, (al as u16) << 8 | al as u16) {
                let dx = segb(c, 0x22) as u16;
                c.r[DX] = dx;
                let bx = c.r[BX];
                let ax = c.r[AX];
                c.set_d(0x146, ax);
                c.r[AX] = ax & dx;
                c.set_d(0x148, ax & dx);
                build(c);
                record(c)?;
                track::markers(c);
                c.r[BX] = bx;
                if c.d(0x144) != 0 {
                    return Ok(c.d(0x142) != 0);
                }
            }
        }
        advance(c)?;
    }
    Ok(c.d(0x142) != 0)
}

/// SI = R:0128 (the walk's first segment) plus or less `dist` segments' bytes (R:01xx), wrapped
/// round the circuit's array (not in the mirror, [bp+172] bit 7).
fn reach(c: &mut Cpu, dist: u16, on: bool) -> u16 {
    let base = c.d(0x128);
    let d = c.d(dist);
    let si = if on {
        let (si, carry) = base.overflowing_add(d);
        if (carry || si >= c.bp(0x15c)) && circuit(c) && (c.bpb(0x172) as i8) >= 0 {
            si.wrapping_sub(c.bp(0x158))
        } else {
            si
        }
    } else {
        let (si, borrow) = base.overflowing_sub(d);
        if (borrow || si < 0x30) && circuit(c) && (c.bpb(0x172) as i8) >= 0 {
            si.wrapping_add(c.bp(0x158))
        } else {
            si
        }
    };
    c.r[SI] = si;
    c.set_d(0x118, si);
    si
}

/// The walk's direction: the field of the segment's parts beside it, and which way its bands go.
#[derive(Clone, Copy)]
struct Dir {
    reversed: bool,
}
impl Dir {
    /// the field before the segment's (-23h going forward, +0Bh in reverse)
    fn before(self) -> u16 {
        if self.reversed {
            0xb
        } else {
            0xffdd
        }
    }
    fn after(self) -> u16 {
        if self.reversed {
            0xffdd
        } else {
            0xb
        }
    }
}

/// A band's first segment (3D75, 3DF5, 3E7C, 3EFC and their reverse copies): DX the parts the
/// segment before has, AX this one's (from `field`), less those already drawn (R:012C, then
/// added to R:0142), drawn by `entry`.
fn band_first(c: &mut Cpu, dir: Dir, field: u16, entry: u16) -> Step {
    let dx = (0x0300 | segb(c, dir.before()) as u16) & c.d(0x12c);
    c.r[DX] = dx;
    let al = segb(c, field);
    let ax = ((al as u16) << 8 | al as u16) & 0x3ff;
    let cx = c.d(0x12c);
    let v = c.d(0x142) | cx;
    c.set_d(0x142, v);
    c.r[CX] = !cx;
    c.r[AX] = ax & !cx;
    c.set_d(0x20, entry);
    c.set_d(0x22, 0x10e9);
    c.r[BX] = field;
    one(c)?;
    let cx = c.d(0x12c);
    c.r[CX] = cx;
    let v = c.d(0x144) | cx;
    c.set_d(0x144, v);
    c.set_db(0x14c, 3);
    c.set_d(0x20, entry);
    c.set_d(0x22, 0x10e9);
    Ok(())
}

/// A behind band's first segment (3FDC, 4075, 4100, 4186, 41CE and their reverse copies): DX the
/// segment after's parts (masked by `dx_mask`), AX this one's from `field` (masked by `ax_mask`),
/// drawn by `entry`.
fn behind_first(c: &mut Cpu, dir: Dir, field: u16, entry: u16, dx_mask: u16, ax_mask: u16) {
    let dx = (0x0300 | segb(c, dir.after()) as u16) & dx_mask;
    c.r[DX] = dx;
    let al = segb(c, field);
    let ax = ((al as u16) << 8 | al as u16) & 0x3ff & ax_mask;
    c.r[AX] = ax;
    c.set_d(0x20, entry);
    c.set_d(0x22, 0x10e9);
    c.r[BX] = field;
}

/// After a behind band's first segment: R:0142 and R:0144 masked, 3306 if the segment had parts.
fn behind_done(c: &mut Cpu, ax_mask: u16) {
    let v = c.d(0x142) & ax_mask;
    c.set_d(0x142, v);
    let v = c.d(0x144) & ax_mask;
    c.set_d(0x144, v);
    if c.d(0x146) != 0 {
        track::markers(c);
    }
}

/// 3B32: the walk.
pub fn walk(c: &mut Cpu) {
    c.set_bp(0x24, 0xa4c6);
    c.set_bp(0x30, 0x4d2e);
    let si = 0xa13e;
    c.r[SI] = si;
    c.set_d(0xfc, si);
    c.set_d(0x108, si);
    c.set_d(0x100, si);
    c.set_bp(0x2c, si);
    c.set_d(0xee, 0xa47e);
    c.set_db(0x15c, 0);
    c.set_d(0x1f4, 0x7fff);
    c.set_d(0x1fe, 0x7fff);
    c.set_d(0x1f0, 0x7fff);
    c.set_d(0x1f8, 0x8000);
    c.set_d(0x202, 0x8000);
    c.set_db(0x1e6, 0);
    let back = reversed(c);
    c.set_d(0x70, if back { 0x8000 } else { 0x7fff });
    c.set_d(0x6e, if back { 0x7fff } else { 0x8000 });
    for (o, v) in [
        (0x6c, 0),
        (0x6a, 0),
        (0x66, 0x400),
        (0x64, 0x400),
        (0x62, 0xfc00),
    ] {
        c.set_d(o, v);
    }
    // 3BBC: the crest list's first entry
    let di = 0x4c38;
    c.r[DI] = di;
    c.set_bp(0x28, di);
    c.set_d(0x1e8, di);
    c.set_d(di, si);
    let v = c.bp(0x30);
    c.set_d(di.wrapping_add(4), v);
    let h = c.bp(0x130);
    c.r[AX] = h;
    for o in [0xc, 0xe, 0x10] {
        c.set_d(di.wrapping_add(o), h);
    }
    for o in [0x13c, 0x13e, 0x142, 0x144, 0x14a] {
        c.set_d(o, 0);
    }
    // 3BF9: the road's colours by the camera's height (R:0258 table)
    let mut si = 0x258u16;
    let y = c.bp(0x150) as i16;
    if y < -0x200 {
        si += 4;
    } else if y >= 0x200 {
        si += 8;
    }
    c.r[SI] = si;
    let v = c.db(si);
    c.set_db(0x162, v);
    let v = c.db(si + 1);
    c.set_db(0x160, v);
    let v = c.db(si + 2);
    c.set_db(0x15e, v);
    c.r[AX] = c.r[AX] & 0xff00 | v as u16;
    let v = c.d(0x162);
    c.set_d(0x16c, v);
    c.set_d(0x16e, 0);
    c.set_db(0x170, 0);
    let game = c.ss(0xf0);
    if c.b(game, 0x16e) != 0 {
        c.set_db(0x170, 0x80);
    }
    c.set_d(0x124, 0);
    // 3C61, 4303: the walk's first segment, from the camera's (SS:00F0 data, 096F)
    let dir = Dir { reversed: back };
    let es = c.w(game, 0x971);
    let mut di = c.w(game, 0x96f);
    c.s[ES] = es;
    let (ax, cx);
    if !back {
        c.r[AX] = 2;
        c.set_d(0x11c, 2);
        let v = 2u16.wrapping_add(c.bp(0x158));
        c.set_d(0x120, v);
        c.r[DI] = di;
        cx = di;
        let a = if segb(c, 0x1a) & 1 != 0 {
            (segb(c, 0x4e) as u16).wrapping_add(1)
        } else {
            segb(c, 0x20) as u16
        };
        let (h, l) = mul(a, 0x2e);
        ax = l;
        c.r[DX] = h;
        let (d, carry) = di.overflowing_add(l);
        di = d;
        if (carry || di >= c.bp(0x15c)) && circuit(c) {
            di = di.wrapping_sub(c.bp(0x158));
        }
    } else {
        let v = c.bp(0x15c);
        c.set_d(0x11c, v);
        c.set_d(0x120, 0x30);
        let (d, carry) = di.overflowing_add(0x2e);
        di = d;
        if (carry || di >= c.bp(0x15c)) && circuit(c) {
            di = di.wrapping_sub(c.bp(0x158));
        }
        c.r[DI] = di;
        cx = di;
        let a = if segb(c, 0x1a) & 1 == 0 {
            (segb(c, 0x4e) as u16).wrapping_sub(1)
        } else {
            segb(c, 0x20) as u16
        };
        let (h, l) = mul(a, 0x2e);
        ax = l;
        c.r[DX] = h;
        let (d, borrow) = di.overflowing_sub(l);
        di = d;
        if (borrow || di < 0x30) && circuit(c) {
            di = di.wrapping_add(c.bp(0x158));
        }
    }
    c.r[DI] = di;
    c.r[CX] = cx;
    c.r[AX] = ax;
    let bx = c.bp(0x28);
    c.r[BX] = bx;
    c.set_d(bx.wrapping_add(8), di);
    c.set_d(bx.wrapping_add(0xa), es);
    bands(c, dir, ax, cx);
}

/// 3AAB: the walk of the pit lane, from the record at SS:00F0 data 01BC.
pub fn walk_pits(c: &mut Cpu) {
    c.set_db(0x1e6, 0);
    c.set_d(0x66, 0x400);
    c.set_d(0x64, 0x400);
    c.set_d(0x62, 0xfc00);
    let v = c.d(0x10c);
    c.set_bp(0x2c, v);
    c.set_bp(0x30, 0x4d2e);
    c.set_d(0xee, 0xa47e);
    for o in [0x142, 0x144, 0x14a, 0x16e, 0x120] {
        c.set_d(o, 0);
    }
    let game = c.ss(0xf0);
    let mut ax = c.w(game, 0x1b8);
    let dx = c.w(game, 0x1c0);
    let di = c.w(game, 0x1bc);
    c.s[ES] = c.w(game, 0x1be);
    c.r[DX] = dx;
    let back = reversed(c);
    let cx;
    if !back {
        c.set_d(0x124, dx);
        c.set_d(0x11c, dx);
        c.r[DI] = di;
        cx = di.wrapping_sub(ax);
    } else {
        c.set_d(0x124, di);
        c.set_d(0x11c, di);
        c.r[DI] = dx;
        ax = ax.wrapping_add(0x2e);
        cx = dx.wrapping_add(ax);
    }
    c.r[AX] = ax;
    c.r[CX] = cx;
    bands(c, Dir { reversed: back }, ax, cx);
}

/// 3CB7, 4374: the bands, from the first segment (DI) and the walk's length (AX).
fn bands(c: &mut Cpu, dir: Dir, ax: u16, cx: u16) {
    c.set_d(0x12e, ax);
    c.set_d(0x128, cx);
    c.set_d(0x188, if dir.reversed { 0x2e } else { 0xffd2 });
    // the stack for the early ends (MOV SP, [0132])
    let sp = c.r[SP];
    c.set_d(0x132, sp);
    c.set_db(0x158, 0);
    c.set_db(0x14e, 0);
    c.set_db(0x14c, 0);
    let ax = c.d(0x12e);
    c.r[AX] = ax;
    if (ax as i16) < 0 {
        return;
    }
    let r = (|| -> Result<Option<bool>, Esc> {
        c.set_d(0x12c, 0x300);
        // the far bands, and the near band: which to start at by the walk's length
        let start = if ax as i16 > c.d(0x1e2) as i16 {
            0
        } else {
            let v = c.bp(0x2c);
            c.set_d(0x100, v);
            let v = c.d(0x12c) | 0x30;
            c.set_d(0x12c, v);
            if ax as i16 > c.d(0x1de) as i16 {
                1
            } else {
                let v = c.d(0x12c) | 0xf;
                c.set_d(0x12c, v);
                if ax as i16 > c.d(0x1da) as i16 {
                    2
                } else {
                    let v = c.d(0x12c) | 0xc3;
                    c.set_d(0x12c, v);
                    if ax as i16 > c.d(0x1d6) as i16 {
                        3
                    } else {
                        return Ok(None);
                    }
                }
            }
        };
        let far = [
            (0x2b, 0x3181, 0x1e2, 0x30),
            (0xa, 0x2f7c, 0x1de, 0xf),
            (0x2a, 0x2d12, 0x1da, 0xc3),
        ];
        for (k, &(field, entry, dist, next)) in far.iter().enumerate() {
            if k < start {
                continue;
            }
            if k == 1 {
                let v = c.bp(0x2c);
                c.set_d(0x100, v);
            }
            band_first(c, dir, field, entry)?;
            reach(c, dist, !dir.reversed);
            c.r[BX] = field;
            run(c)?;
            c.set_d(0x12c, next);
        }
        // 3EFC: the near band
        band_first(c, dir, 0x27, 0x2a04)?;
        let v = c.d(0x160);
        c.set_d(0x16c, v);
        c.set_d(0x16e, 8);
        c.set_d(0x17e, 0x27);
        c.set_d(0x20, 0x2a04);
        c.set_d(0x22, 0x10e9);
        reach(c, 0x1d6, !dir.reversed);
        near(c, false)?;
        let v = c.d(0x66);
        c.set_d(0x68, v);
        c.set_d(0x17e, 0x27);
        c.set_d(0x20, 0x2a04);
        c.set_d(0x22, 0x10e9);
        // 3FA1: behind the camera
        reach(c, 0x1d2, dir.reversed);
        if !near(c, true)? {
            return Ok(Some(false));
        }
        if c.db(0xfa) == 0 {
            return Ok(Some(true));
        }
        // 3FDC: the road drawn as polygons: the bands behind at less detail
        behind_first(c, dir, 0x27, 0x2a04, 0xc3, 0xff3f);
        one(c)?;
        behind_done(c, 0xff3f);
        if c.d(0x142) == 0 {
            return Ok(Some(false));
        }
        let v = c.d(0x162);
        c.set_d(0x16c, v);
        c.set_d(0x16e, 0);
        // (BX, the builder, the band's end, then its first segment's field and masks)
        let rest = [
            (0x2a, 0x2d12, 0x1ce, 0xa, 0xf, 0xfff0),
            (0xa, 0x2f7c, 0x1ca, 0xa, 0x30, 0xffcf),
            (0x2b, 0x3181, 0x1c6, 0x2b, 0x300, 0xfcff),
        ];
        for (k, &(bx, entry, dist, field, dx_mask, ax_mask)) in rest.iter().enumerate() {
            c.r[BX] = bx;
            c.set_d(0x20, entry);
            c.set_d(0x22, 0x10e9);
            reach(c, dist, dir.reversed);
            if !behind(c)? {
                return Ok(Some(false));
            }
            behind_first(c, dir, field, entry, dx_mask, ax_mask);
            one(c)?;
            behind_done(c, ax_mask);
            if k == 0 && c.d(0x142) == 0 {
                return Ok(Some(false));
            }
        }
        Ok(Some(false))
    })();
    match r {
        Ok(None) => (),
        Ok(Some(false)) => tail(c, dir),
        Ok(Some(true)) => last(c, dir),
        Err(Esc::Full) => {
            full(c);
            last(c, Dir { reversed: false });
        }
        Err(Esc::End) => last(c, Dir { reversed: false }),
    }
}

/// 3D28: the strip list is full: two more entries allowed for the last segment, which the walk
/// moves on to.
fn full(c: &mut Cpu) {
    c.set_d(0xee, 0xa49e);
    c.set_db(0x158, 0x80);
    let _ = advance(c);
    c.set_db(0x158, 0);
}

/// 41CE, 488B: the last segment, everything it has, then the tail. A loop that leaves early
/// starts this again (the forward walk's copy).
fn last(c: &mut Cpu, mut dir: Dir) {
    loop {
        c.set_db(0x158, 0x80);
        behind_first(c, dir, 0x27, 0x2a04, 0x3ff, 0xfc00);
        match one(c) {
            Ok(()) => break,
            Err(e) => {
                if let Esc::Full = e {
                    full(c);
                }
                dir = Dir { reversed: false };
            }
        }
    }
    behind_done(c, 0xfc00);
    c.set_db(0x158, 0);
    tail(c, dir);
}

/// 421E, 48DB: the strip list closed, then the objects of the segments behind the camera, to
/// R:01C2 segments back.
fn tail(c: &mut Cpu, dir: Dir) {
    let si = c.bp(0x2c);
    c.r[SI] = si;
    c.set_d(0xfc, si);
    for k in 0..8u16 {
        c.set_d(si.wrapping_add(2 * k), 0);
    }
    if c.bpb(0x172) != 0 {
        return;
    }
    let ax = c.d(0x66).wrapping_sub(2);
    c.r[AX] = ax;
    c.set_d(0x62, ax);
    let end = reach(c, 0x1c2, dir.reversed);
    // 4288: the way to the end: the near way, unless that is 23F0h bytes or more
    let di = c.r[DI];
    let d = (di as i32 - end as i32).unsigned_abs() as u16;
    c.r[DX] = 0;
    c.r[AX] = d;
    let go = if d >= 0x23f0 {
        if dir.reversed {
            di > end
        } else {
            di < end
        }
    } else if dir.reversed {
        di < end
    } else {
        di > end
    };
    if !go {
        return;
    }
    // 42F6
    loop {
        let n = c.d(0x66).wrapping_sub(1);
        c.set_d(0x66, n);
        if c.r[DI] == c.d(0x118) {
            return;
        }
        // 42BA
        if (segb(c, 0x26) as i8) < 0 {
            object(c);
        }
        let mut di = c.r[DI];
        if dir.reversed {
            let (d, carry) = di.overflowing_add(0x2e);
            di = d;
            if (carry || di >= c.bp(0x15c)) && circuit(c) {
                di = di.wrapping_sub(c.bp(0x158));
            }
        } else {
            let (d, borrow) = di.overflowing_sub(0x2e);
            di = d;
            if (borrow || di < 0x30) && circuit(c) {
                di = di.wrapping_add(c.bp(0x158));
            }
        }
        c.r[DI] = di;
    }
}
