//! The cars (gp.exe 0F47:A19E to A532 and A7B2, and the pose in segment 0, 0000:03C8 to 04D6
//! and 14A2 to 1660; docs/renderer-notes.md, section 8): a car placed on its segment and turned
//! with it, drawn as shape 0 with its parts (from the table at G:351B, 16 bytes each: x, z and
//! height offsets, heading and pitch added, palette, shape) before or after it.
//!
//! These routines run with DS the game's data segment G, the car's record at SI and its
//! segment's at ES:DI.
//!
//! Each step below names the game's instruction it stands for.

use super::regs::*;
use super::shape;

/// x times the sine less z times the cosine, and z times the sine plus x times the cosine, as
/// the game's IMULs and 32-bit adds leave them.
fn turn(x: u16, z: u16, s: u16, co: u16) -> (u32, u32) {
    let (x, z) = (x as i16 as i32, z as i16 as i32);
    let (s, co) = (s as i16 as i32, co as i16 as i32);
    (
        (x * s).wrapping_sub(z * co) as u32,
        (z * s).wrapping_add(x * co) as u32,
    )
}

/// The high word of a 32-bit value shifted up.
fn high(v: u32, n: u32) -> u16 {
    (v << n >> 16) as u16
}

/// 0000:03C8 (far): AX = the sine of angle AX, between the table's steps (SS:3264, a step every
/// 8) by its low 3 bits; DX and BP kept.
pub fn fine_sine(c: &mut Cpu) {
    let a = c.r[AX];
    let a = if (a as i16) < 0 { a.wrapping_neg() } else { a };
    let i = a >> 2 & 0xfffe;
    let lo = c.ss(i.wrapping_add(0x3264));
    let hi = c.ss(i.wrapping_add(0x3266));
    let p = hi.wrapping_sub(lo) as i16 as i32 * (a & 7) as i32;
    c.r[AX] = ((p >> 3) as u16).wrapping_add(lo);
}

/// 0000:043C (far): AX = the angle of the vector (AX, DX), from the arctangent table (SS:5268)
/// of the smaller over the larger times 2048; 0 for (0, 0). The other registers kept.
pub fn angle(c: &mut Cpu) {
    let (x, z) = (c.r[AX], c.r[DX]);
    let abs = |v: u16| if (v as i16) < 0 { v.wrapping_neg() } else { v };
    let (di, si) = (abs(x), abs(z));
    let up = |v: u16| ((v as i16 as i32) << 11) as u32;
    let mut a = if di as i16 >= si as i16 {
        if di == 0 {
            c.r[AX] = 0;
            return;
        }
        let n = up(si);
        let q = c.div((n >> 16) as u16, n as u16, di).0;
        0x4000u16.wrapping_sub(c.ss((q << 1).wrapping_add(0x5268)))
    } else {
        if si == 0 {
            c.r[AX] = 0;
            return;
        }
        let n = up(di);
        let q = c.div((n >> 16) as u16, n as u16, si).0;
        c.ss((q << 1).wrapping_add(0x5268))
    };
    if ((x ^ z) as i16) < 0 {
        a = a.wrapping_neg();
    }
    if (z as i16) < 0 {
        a = a.wrapping_add(0x8000);
    }
    c.r[AX] = a;
}

/// 0000:14A2 (far): the car at SI placed: SS:[bp+10] and [bp+14] (32-bit, 256 times finer), its
/// height at [bp+18] and its pitch at [bp+8]; kept from the record (+28 on) when it says so
/// (+7E bit 0), else from its segment at ES:DI (14D1).
pub fn pose(c: &mut Cpu) {
    let si = c.r[SI];
    if c.db(si.wrapping_add(0x7e)) & 1 != 0 {
        for (o, f) in [
            (0x10, 0x28),
            (0x12, 0x2a),
            (0x14, 0x2c),
            (0x16, 0x2e),
            (8, 2),
            (0x18, 8),
        ] {
            let v = c.d(si.wrapping_add(f));
            c.set_bp(o, v);
        }
        return;
    }
    // 14D1
    place(c);
    let (di, si) = (c.r[DI], c.r[SI]);
    let cx = c.e(di.wrapping_add(6));
    let ax = c.e(di.wrapping_add(0x34)).wrapping_sub(cx);
    let p = (ax as i16 as i32 * c.d(si.wrapping_add(0x1e)) as i16 as i32) as u32;
    let h = high(p, 2)
        .wrapping_add(cx)
        .wrapping_add(c.d(si.wrapping_add(0x8c)));
    c.set_bp(0x18, h);
    let ax = c.e(di.wrapping_add(2));
    let cx = shape::sine(c, c.d(si.wrapping_add(0x1a)).wrapping_sub(c.e(di)));
    let p = (ax as i16 as i32 * cx as i16 as i32) as u32;
    let v = high(p, 2);
    c.set_bp(8, v);
    c.r[AX] = v;
    c.r[CX] = cx;
    c.r[DX] = v;
}

/// 1544: the car's place across (+1C, less its slide by the segment's lean +14) and along (+A)
/// its segment, turned by the segment's heading and added to the segment's position (with the
/// low bits of +21), 256 times finer, x and z then swapped.
fn place(c: &mut Cpu) {
    let (di, si) = (c.r[DI], c.r[SI]);
    let mut ax = c.e(di.wrapping_add(0x14));
    if ax != 0 {
        let p = (ax as i16 as i32 * c.d(si.wrapping_add(0xa)) as i16 as i32) as u32;
        ax = high(p, 1).wrapping_neg();
    }
    let x = ax.wrapping_add(c.d(si.wrapping_add(0x1c)));
    c.set_bp(0x10, x);
    let z = c.d(si.wrapping_add(0xa));
    c.set_bp(0x14, z);
    let h = c.e(di);
    c.r[AX] = h;
    fine_sine(c);
    let s = c.r[AX];
    c.r[AX] = 0x4000u16.wrapping_sub(h);
    fine_sine(c);
    let co = c.r[AX];
    c.set_bp(8, s);
    c.set_bp(0xc, co);
    c.set_bp(0, x);
    let (rx, rz) = turn(x, z, s, co);
    let (x, z) = (high(rx, 2), high(rz, 2));
    let mut z32 = (z as i16 as i32 as u32).wrapping_add(
        ((c.e(di.wrapping_add(4)) as i16 as i32) << 3) as u32
            | (c.eb(di.wrapping_add(0x21)) & 7) as u32,
    );
    let mut x32 = (x as i16 as i32 as u32).wrapping_add(
        ((c.e(di.wrapping_add(8)) as i16 as i32) << 3) as u32
            | (c.eb(di.wrapping_add(0x21)) >> 4) as u32,
    );
    x32 <<= 8;
    z32 <<= 8;
    c.set_bp32(0x10, z32);
    c.set_bp32(0x14, x32);
    c.r[AX] = z32 as u16;
    c.r[DX] = (z32 >> 16) as u16;
}

/// A30A: the car at SI as shape AX (CX height, DX heading), with its parts when it has them
/// (+9A bit 7): bit 6, a part (3) drawn before the car when seen from the side, after it when
/// seen from behind (by the angle to the camera, at most 16C2h off the camera's heading); bit 5,
/// a part (2) after it. The registers and G:350D to 351A kept.
pub fn car(c: &mut Cpu) {
    let si = c.r[SI];
    if c.db(si.wrapping_add(0x9a)) & 0x80 == 0 {
        return shape::shape(c);
    }
    let (r, s) = (*c.r, *c.s);
    let kept: Vec<u16> = (0x350d..0x351b).step_by(2).map(|o| c.d(o)).collect();
    let after = |c: &mut Cpu| {
        // A3C5
        shape::shape(c);
        if c.db(c.r[SI].wrapping_add(0x9a)) & 0x20 != 0 {
            c.r[DI] = 2;
            part(c);
            part_shape(c);
        }
    };
    if c.db(si.wrapping_add(0x9a)) & 0x40 == 0 {
        after(c);
    } else {
        let x = sar(c.bp(0x10).wrapping_sub(c.bp(0x142)), 3);
        let z = sar(c.bp(0x14).wrapping_sub(c.bp(0x14a)), 3);
        c.r[AX] = x;
        c.r[DX] = z;
        angle(c);
        let cam = c.d(0x2261);
        let mut a = c.r[AX].wrapping_sub(cam);
        if (a as i16) < 0 {
            a = a.wrapping_neg();
            if a as i16 >= 0x16c2 {
                a = 0x16c2;
            }
            a = a.wrapping_neg();
        } else if a as i16 >= 0x16c2 {
            a = 0x16c2;
        }
        let mut a = a.wrapping_add(cam).wrapping_sub(r[DX]);
        if (a as i16) < 0 {
            a = a.wrapping_neg();
        }
        c.r[AX] = r[AX];
        c.r[DX] = r[DX];
        c.r[DI] = a;
        if a as i16 >= 0x4000 {
            // A3F8
            shape::shape(c);
            c.r[DI] = 3;
            part(c);
            part_shape(c);
        } else {
            if a as i16 >= 0x1000 {
                let regs = (c.r[AX], c.r[CX], c.r[DX]);
                let slots: Vec<u16> = [8, 0x10, 0x12, 0x14, 0x16]
                    .iter()
                    .map(|&o| c.bp(o))
                    .collect();
                c.r[DI] = 3;
                part(c);
                part_shape(c);
                for (&o, &v) in [8, 0x10, 0x12, 0x14, 0x16].iter().zip(&slots) {
                    c.set_bp(o, v);
                }
                (c.r[AX], c.r[CX], c.r[DX]) = regs;
            }
            after(c);
        }
    }
    // A3D8
    for (k, &v) in kept.iter().enumerate() {
        c.set_d(0x350d + 2 * k as u16, v);
    }
    *c.r = r;
    *c.s = s;
}

/// A406: part DI placed: the car's place, height, heading and pitch (SS:[bp+10] to [bp+16],
/// CX, DX, [bp+8]) kept at G:350D to 351A, then the part's offsets (G:351B + 16 x DI) turned
/// by the heading (its height by the pitch) and added, with its heading and pitch.
pub fn part(c: &mut Cpu) {
    let di = c.r[DI] << 4;
    c.r[DI] = di;
    let bx = di.wrapping_add(0x351b);
    c.r[BX] = bx;
    for (o, f) in [
        (0x350d, 0x10),
        (0x350f, 0x12),
        (0x3511, 0x14),
        (0x3513, 0x16),
    ] {
        let v = c.bp(f);
        c.set_d(o, v);
    }
    let (cx, dx) = (c.r[CX], c.r[DX]);
    c.set_d(0x3515, cx);
    c.set_d(0x3517, dx);
    let v = c.bp(8);
    c.set_d(0x3519, v);
    let s = shape::sine(c, dx);
    let co = shape::sine(c, 0x4000u16.wrapping_sub(dx));
    c.set_bp(8, s);
    c.set_bp(0xc, co);
    let x = c.d(bx);
    c.set_bp(0x10, x);
    let z = c.d(bx.wrapping_add(2));
    c.set_bp(0x14, z);
    let p = shape::sine(c, 0x4000u16.wrapping_sub(c.d(0x3519)));
    let h = high((p as i16 as i32 * z as i16 as i32) as u32, 2);
    let cx = c.d(bx.wrapping_add(4)).wrapping_add(h);
    let co = co.wrapping_neg();
    c.set_bp(0xc, co);
    c.set_bp(0, x);
    let (rx, rz) = turn(x, z, s, co);
    c.set_bp(0x12, (rx >> 16) as u16);
    c.set_bp(0x16, (rz >> 16) as u16);
    let (nx, nz) = (high(rx, 2), high(rz, 2));
    c.set_bp(0x14, nz);
    c.set_bp(0x10, nx);
    let add32 = |c: &mut Cpu, o: u16, v: u16| {
        let s = join(c.d(o + 2), c.d(o)).wrapping_add(v as i16 as i32 as u32);
        c.set_d(o, s as u16);
        c.set_d(o + 2, (s >> 16) as u16);
    };
    add32(c, 0x350d, nx);
    add32(c, 0x3511, nz);
    let v = c.d(0x3515).wrapping_add(cx);
    c.set_d(0x3515, v);
    let v = c.d(0x3517).wrapping_add(c.d(bx.wrapping_add(6)));
    c.set_d(0x3517, v);
    let ax = c.d(bx.wrapping_add(8));
    let v = c.d(0x3519).wrapping_add(ax);
    c.set_d(0x3519, v);
    c.r[AX] = ax;
    c.r[CX] = cx;
    c.r[DX] = if (nz as i16) < 0 { 0xffff } else { 0 };
}

/// A2CC: the part placed (BX its table entry) drawn in its own palette (+A).
pub fn part_own(c: &mut Cpu) {
    let v = c.d(c.r[BX].wrapping_add(0xa));
    c.set_bp(0x174, v);
    part_shape(c);
}

/// A2D3: the part placed drawn: its shape (+C) at G:350D on.
pub fn part_shape(c: &mut Cpu) {
    let bx = c.r[BX];
    c.r[CX] = c.d(0x3515);
    for (o, f) in [
        (0x14, 0x3511),
        (0x16, 0x3513),
        (0x10, 0x350d),
        (0x12, 0x350f),
    ] {
        let v = c.d(f);
        c.set_bp(o, v);
    }
    c.r[DX] = c.d(0x3517);
    let v = c.d(0x3519);
    c.set_bp(8, v);
    c.r[AX] = c.d(bx.wrapping_add(0xc));
    c.set_bpb(0x17a, 0);
    shape::shape(c);
}

/// A19E: the camera's own car's part (DI): kept at G:3505 too, drawn in its own palette.
pub fn own_part(c: &mut Cpu) {
    for (o, f) in [
        (0x3505, 0x10),
        (0x3507, 0x12),
        (0x3509, 0x14),
        (0x350b, 0x16),
    ] {
        let v = c.bp(f);
        c.set_d(o, v);
    }
    part(c);
    part_own(c);
}

/// A1C1: part DI and the car, the one further from the camera first: by the sign of the
/// vector from the car to the part (halved) dotted with their middle (from the camera, 16
/// times coarser).
pub fn part_and_car(c: &mut Cpu) {
    let slots: Vec<u16> = [0x174, 0x17a, 8, 0x16, 0x14, 0x12, 0x10]
        .iter()
        .map(|&o| c.bp(o))
        .collect();
    let regs = (c.r[AX], c.r[CX], c.r[DX]);
    for (o, f) in [
        (0x3505, 0x10),
        (0x3507, 0x12),
        (0x3509, 0x14),
        (0x350b, 0x16),
    ] {
        let v = c.bp(f);
        c.set_d(o, v);
    }
    part(c);
    let (si, bx) = (c.r[SI], c.r[BX]);
    let cam = |c: &Cpu, o: u16| join(c.d(o + 2), c.d(o));
    let px = cam(c, 0x350d).wrapping_sub(c.bp32(0x142));
    c.set_bp32(0x10, px);
    let pz = cam(c, 0x3511).wrapping_sub(c.bp32(0x14a));
    c.set_bp32(0x14, pz);
    let ox = cam(c, 0x3505).wrapping_sub(c.bp32(0x142));
    let oz = cam(c, 0x3509).wrapping_sub(c.bp32(0x14a));
    let dx = (px as u16).wrapping_sub(ox as u16);
    let dz = (pz as u16).wrapping_sub(oz as u16);
    c.r[DI] = dx;
    let mx = (ox.wrapping_add(px) as i32 >> 4) as u16;
    let mz = (oz.wrapping_add(pz) as i32 >> 4) as u16;
    let dot =
        (mx as i16 as i32 * dx as i16 as i32).wrapping_add(mz as i16 as i32 * dz as i16 as i32);
    c.r[SI] = si;
    c.r[BX] = bx;
    let restore = |c: &mut Cpu| {
        for (&o, &v) in [0x10, 0x12, 0x14, 0x16, 8]
            .iter()
            .zip(slots[2..].iter().rev())
        {
            c.set_bp(o, v);
        }
        (c.r[AX], c.r[CX], c.r[DX]) = regs;
        c.set_bp(0x17a, slots[1]);
        c.set_bp(0x174, slots[0]);
    };
    if dot >= 0 {
        part_own(c);
        restore(c);
        car(c);
    } else {
        restore(c);
        car(c);
        part_own(c);
    }
}

/// A7B2: a parked car (setting 4 or 5): G:[G:0200] the camera's car's value (G:291F) if it is
/// that car (G:356B), else SS:[bp+1B4]; its palette from G:356B; no steering.
pub fn parked(c: &mut Cpu) {
    let bx = c.d(0x200);
    let cx = c.d(0x356b);
    let si = c.d(0x97f);
    let v = if cx as u8 == c.db(si.wrapping_add(0x25)) {
        c.d(0x291f)
    } else {
        c.bp(0x1b4)
    };
    c.set_d(bx, v);
    let p = (cx.wrapping_sub(1) << 4)
        .wrapping_add(0x2d24)
        .wrapping_sub(0x2964);
    c.set_bp(0x174, p);
    c.set_bp(0x16a, 0);
}
