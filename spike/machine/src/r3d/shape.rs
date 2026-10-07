//! The shapes (gp.exe 0F47:831F to 9BDF; docs/renderer-notes.md, section 8): an object of the
//! track (a tree, a board, a building, a car) drawn from its shape in the game's data segment G.
//!
//! A shape's header (G:[358D + 4 x id]) holds its radius (+0), its coordinates (+2), the list of
//! vertices that must not all lie off one side (+6), its vertices (+A, 8 bytes each: offsets of
//! x and z into the turned coordinates, a height, a neighbour), its edges (+E, two vertices
//! each), its heights (+12, +14) and its levels of detail from +16 (10 bytes each: the depth up
//! to which it holds, its kind, then a bitmap's or the command lists' angles). Near enough, a
//! shape is drawn from commands: polygons (edges into R:0FE6, then the filler), bitmaps at a
//! vertex (19E8) and single-pixel poles (878D); far off, as one bitmap turned to the view.
//!
//! Each vertex is projected once (831F) into a record of 16 bytes at R:0830 + 16 x vertex, the
//! projection's record (src/r3d/point.rs), from tables of the shape's coordinates turned by its
//! heading (R:0D90, R:0E10, R:0E50, each with its negation 20h on).
//!
//! Each step below names the game's instruction it stands for.

use super::point::{self, Entry};
use super::regs::*;
use super::{bitmap, edge, fill, track};

/// SHR of a word by CL (the 286 takes the count's low 5 bits).
fn shr(v: u16, n: u16) -> u16 {
    let n = n & 31;
    if n >= 16 {
        0
    } else {
        v >> n
    }
}

/// The sine table (SS:3264) at an angle's size.
pub(super) fn sine(c: &Cpu, a: u16) -> u16 {
    let a = if (a as i16) < 0 { a.wrapping_neg() } else { a };
    c.ss((a >> 2 & 0xfffe).wrapping_add(0x3264))
}

/// The angle by which a bitmap at screen column `col` turns (SS:5268, by its distance from the
/// middle), negated.
fn parallax(c: &Cpu, col: u16) -> u16 {
    let a = col.wrapping_sub(0xa0);
    let mut v = if (a as i16) < 0 { a.wrapping_neg() } else { a };
    if v as i16 >= 0x100 {
        v = 0xff;
    }
    let mut t = c.ss((v << 4).wrapping_add(0x5268));
    if (a as i16) < 0 {
        t = t.wrapping_neg();
    }
    t.wrapping_neg()
}

/// The steering angle (SS:[bp+16A]) as the front wheels turn: four times it up to 200h, then
/// half as fast.
fn steer(s: u16) -> u16 {
    let mut a = if (s as i16) < 0 { s.wrapping_neg() } else { s };
    if a as i16 >= 0x200 {
        a = (a.wrapping_sub(0x200) >> 1).wrapping_add(0x800);
    } else {
        a <<= 2;
    }
    if (s as i16) < 0 {
        a = a.wrapping_neg();
    }
    a
}

/// 831F: vertex BX (of the table at ES:[bp+A0]) projected into its record and marked done
/// (R:0F10 + vertex); BX = 16 x the vertex after. A vertex whose x offset has bit 15 mirrors
/// another: that one is projected first, and its record copied with this vertex's height.
pub fn vertex(c: &mut Cpu) {
    let v = c.r[BX];
    c.set_db(v.wrapping_add(0xf10), 0x80);
    let bx = v << 3;
    c.r[BX] = bx;
    let di = c.bp(0xa0);
    c.r[DI] = di;
    let si = c.e(bx.wrapping_add(di));
    c.r[SI] = si;
    if (si as i16) >= 0 {
        // 8608
        project(c);
        c.r[BX] <<= 1;
        return;
    }
    let si = si & 0x7fff;
    c.r[SI] = si;
    if c.db(si.wrapping_add(0xf10)) & 0x80 == 0 {
        // 8345: the vertex it mirrors
        c.set_db(si.wrapping_add(0xf10), 0x80);
        let b = si << 3;
        c.r[BX] = b;
        c.r[SI] = c.e(b.wrapping_add(di));
        project(c);
        c.r[SI] = si;
        c.r[BX] = bx;
    }
    // 84D6
    let s = si << 3;
    let dx = c.e(s.wrapping_add(di).wrapping_add(2));
    c.r[DX] = dx;
    let src = (s << 1).wrapping_add(0x830);
    let mut cx = c.e(bx.wrapping_add(di).wrapping_add(4));
    cx = cx.wrapping_add(c.d(dx.wrapping_add(0xd90)));
    let dst = (bx << 1).wrapping_add(0x830);
    cx = cx.wrapping_add(c.d(0x2e));
    for o in (0..12).step_by(2) {
        let w = c.d(src.wrapping_add(o));
        c.set_d(dst.wrapping_add(o), w);
    }
    c.set_d(dst.wrapping_add(2), cx);
    let p = (cx as i16 as i32 * c.bp(0x17c) as i16 as i32) << 1;
    let mut cx = (p >> 16) as u16;
    let mut dx = cx;
    let mut ax = c.d(dst.wrapping_add(0xa)) & 0xfffc;
    if ax & 0x10 != 0 {
        ax |= if (cx as i16) < 0 { 1 } else { 2 };
    } else {
        let dl = (ax >> 8) & 0x1f;
        if dl != 0 {
            // 206E: the row from the height alone, as 1FAD left it
            c.r[AX] = ax;
            c.r[CX] = cx;
            c.r[DX] = dx & 0xff00 | dl;
            track::shifted(c);
            cx = c.r[CX];
            dx = c.r[DX];
        } else {
            // 8558
            let mut n = (cx as i16 as i32) << 5;
            if (c.d(0x2a4) as i16) < 0 {
                n <<= 3;
            }
            let depth = c.d(dst.wrapping_add(4));
            c.set_bp(0x14, depth);
            let (q, r) = round(c, n, depth);
            cx = q;
            dx = r;
        }
        // 85C2
        let (y, over) = (cx.wrapping_neg() as i16).overflowing_add(c.bp(0x130) as i16);
        cx = y as u16;
        if over {
            cx = cx.wrapping_sub(c.bp(0x130));
            if (cx as i16) < 0 {
                cx = cx.wrapping_neg();
                if cx as i16 >= 0x7800 {
                    cx = 0x7800;
                }
                cx = cx.wrapping_neg();
            } else if cx as i16 >= 0x7800 {
                cx = 0x7800;
            }
        }
        c.set_d(dst.wrapping_add(8), cx);
        if cx >= 0xa4 {
            ax |= if cx as i16 >= 0xa4 { 1 } else { 2 };
        }
    }
    // 85FF
    c.set_d(dst.wrapping_add(0xa), ax);
    c.r[AX] = ax;
    c.r[CX] = cx;
    c.r[DX] = dx;
    c.r[SI] = src;
    c.r[DI] = di;
    c.r[BX] = bx << 1;
}

/// The row's quotient of `n` by the depth, rounded as the projection does (a negative one to
/// the nearest, a positive one up when it reaches the depth), or 8000h or 7FFFh when the divide
/// overflows: (AX, DX) after it.
fn round(c: &mut Cpu, n: i32, depth: u16) -> (u16, u16) {
    c.set_ssb(0xc0, 0);
    let (q, r) = c.idiv((n >> 16) as u16, n as u16, depth);
    let (mut ax, mut dx) = (q, r);
    if c.ssb(0xc0) != 0 {
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
    (ax, dx)
}

/// 8608: the vertex at BX (8 x vertex) with x offset SI projected: x and z from the turned
/// coordinates, the height from the table and the shape's height, all from the shape's centre
/// (R:002C), then onto the screen as 2168 does; a neighbour already projected at the same column
/// moves this one a column right.
fn project(c: &mut Cpu) {
    let (bx, di, si) = (c.r[BX], c.r[DI], c.r[SI]);
    let dz = c.e(bx.wrapping_add(di).wrapping_add(2));
    let mut cx = c.e(bx.wrapping_add(di).wrapping_add(4));
    cx = cx.wrapping_add(c.d(dz.wrapping_add(0xd90)));
    let x = c
        .d(si.wrapping_add(0xe10))
        .wrapping_add(c.d(dz.wrapping_add(0xe50)));
    let z = c
        .d(dz.wrapping_add(0xe10))
        .wrapping_sub(c.d(si.wrapping_add(0xe50)));
    let rec = (bx << 1).wrapping_add(0x830);
    let x = x.wrapping_add(c.d(0x2c));
    cx = cx.wrapping_add(c.d(0x2e));
    let z = z.wrapping_add(c.d(0x30));
    c.set_bp(0x14, z);
    let v = (x as i16 as i32) << 8;
    c.set_bp(0x10, v as u16);
    c.set_bp(0x12, (v >> 16) as u16);
    c.r[AX] = x;
    c.r[CX] = cx;
    c.r[DX] = (v >> 16) as u16;
    c.r[SI] = rec;
    let (m, r) = c.split();
    point::point(m, r, Entry::Projected);
    // 875A
    c.r[DX] = rec;
    let n = c.e(bx.wrapping_add(di).wrapping_add(6));
    c.r[SI] = n;
    if n != 0 && c.db(n.wrapping_add(0xf10)) & 0x80 != 0 {
        let n = n << 4;
        c.r[SI] = n;
        if c.d(n.wrapping_add(0x83a)) & 0x10 == 0 {
            let ax = c.d(n.wrapping_add(0x836));
            c.r[AX] = ax;
            c.r[SI] = rec;
            if ax == c.d(rec.wrapping_add(6)) {
                c.set_d(rec.wrapping_add(6), ax.wrapping_add(1));
            }
        }
    }
}

/// 878D: a pole, one pixel wide in colour SS:2EE4, at the column of the vertex whose record is
/// at BX (16 x vertex), from the row of the vertex at DI less one up to BX's, both kept on the
/// screen (above SS:[bp+132]); none if both lie off one side.
pub fn pole(c: &mut Cpu) {
    let (b, d) = (c.r[BX], c.r[DI]);
    let al = c.db(b.wrapping_add(0x83a)) & c.db(d.wrapping_add(0x83a));
    c.r[AX] = c.r[AX] & 0xff00 | al as u16;
    if al != 0 {
        return;
    }
    let cx = c.d(b.wrapping_add(0x836));
    let mut bx = c.d(b.wrapping_add(0x838));
    let mut di = c.d(d.wrapping_add(0x838));
    c.r[CX] = cx;
    c.r[BX] = bx;
    c.r[DI] = di;
    if cx >= 0x140 {
        return;
    }
    if bx >= 0xa4 {
        bx = if (bx as i16) < 0xa4 { 0 } else { 0xa3 };
    }
    di = di.wrapping_sub(1);
    let top = c.bp(0x132);
    if di >= top {
        di = if (di as i16) < top as i16 {
            0
        } else {
            top.wrapping_sub(1)
        };
    }
    c.r[BX] = bx;
    c.r[DI] = di;
    if bx as i16 > di as i16 {
        return;
    }
    // 87DB
    let seg = c.d(0x1e);
    let mut p = c.d(0x1c).wrapping_add(cx);
    let (dx, ax) = mul(0x140, di);
    p = p.wrapping_add(ax);
    c.r[DX] = dx;
    let n = di.wrapping_sub(bx);
    c.r[CX] = n;
    c.r[AX] = ax;
    c.r[DI] = p;
    if (n as i16) < 0 {
        return;
    }
    let al = c.ssb(0x2ee4);
    for _ in 0..n.wrapping_add(1) {
        c.set_b(seg, p, al);
        p = p.wrapping_sub(0x140);
    }
    c.r[CX] = 0;
    c.r[AX] = ax & 0xff00 | al as u16;
    c.r[DI] = p;
}

/// 8801: the shape's 16 colours (palette SS:[2964 + SI]) hazed for its depth DX into SS:2EE4;
/// the haze's level at SS:0185.
pub fn haze(c: &mut Cpu) {
    let mut dx = (c.r[DX].wrapping_add(0x80) as i16).clamp(0, 0x3c00) as u16;
    let mut ax = c.r[AX];
    let level;
    if c.ss(0x122e) != 0 {
        let (h, l) = imul(c.ss(0x182), dx);
        let ah = (l >> 8) as u8;
        let dl = (h as u8) << 1 | ah >> 7;
        ax = ((ah << 1) as u16) << 8 | l & 0xff;
        dx = h & 0xff00 | dl as u16;
        let mut bh = dl;
        if bh > 4 {
            bh = 4;
        }
        if (bh as i8) < 1 {
            bh = 1;
        }
        level = bh;
    } else {
        // 8842
        let mut dh = ((dx >> 8) as u8).wrapping_sub(5);
        if (dh as i8) < 0 {
            dh = 0;
        }
        dh = ((dh as i8) >> 3) as u8;
        if dh as i8 > 4 {
            dh = 4;
        }
        dx = (dh as u16) << 8 | dx & 0xff;
        level = dh;
    }
    let bh = level.wrapping_sub(1);
    c.set_ssb(0x185, bh);
    let si = c.r[SI];
    let from = |k: u16| si.wrapping_add(0x2964).wrapping_add(k);
    let mut al = 0;
    if (bh as i8) < 0 {
        // 8883
        for k in (0..16).rev() {
            al = c.ssb(from(k));
            c.set_ssb(0x2ee4 + k, al);
        }
    } else if bh >= 4 {
        // 8894
        al = c.ssb(0x1b2);
        for k in (0..16).rev() {
            c.set_ssb(0x2ee4 + k, al);
        }
    } else {
        // 8866: MOV AX, 7D70h for ES leaves its high byte in AH
        let seg = c.c(0x8868);
        ax = seg;
        for k in (0..16).rev() {
            let bl = c.ssb(from(k));
            al = c.b(seg, ((bh as u16) << 8 | bl as u16).wrapping_add(0x7bc0));
            c.set_ssb(0x2ee4 + k, al);
        }
    }
    c.r[AX] = ax & 0xff00 | al as u16;
    c.r[DX] = dx;
}

/// A vertex's record (16 x vertex), projected now if it is not yet.
fn vertex_at(c: &mut Cpu, v: u16) -> u16 {
    if c.db(v.wrapping_add(0xf10)) & 0x80 == 0 {
        c.r[BX] = v;
        vertex(c);
        c.r[BX]
    } else {
        v << 4
    }
}

/// 88A5: shape AX at SS:[bp+10] and [bp+14] (32-bit, in the world), height CX, heading DX,
/// pitch SS:[bp+8], palette SS:[bp+174]. It keeps the registers, and SS:[bp+8] to [bp+16] and
/// [bp+30].
pub fn shape(c: &mut Cpu) {
    let (r, s) = (*c.r, *c.s);
    let kept: Vec<u16> = [0x30, 8, 0xa, 0x10, 0x12, 0x14, 0x16]
        .iter()
        .map(|&o| c.bp(o))
        .collect();
    c.s[DS] = c.ss(0xf4);
    c.s[ES] = c.ss(0xf0);
    draw(c);
    // 9A56
    c.set_d(0x2a4, 0);
    for (&o, &v) in [0x30, 8, 0xa, 0x10, 0x12, 0x14, 0x16].iter().zip(&kept) {
        c.set_bp(o, v);
    }
    *c.r = r;
    *c.s = s;
}

fn draw(c: &mut Cpu) {
    c.set_d(0x2f4, 0);
    let id = c.r[AX];
    c.set_d(0x4e, id);
    let hdr = c.e((id << 2).wrapping_add(0x358d));
    c.set_d(0x50, hdr);
    let yaw = c.r[DX].wrapping_sub(c.e(0x2261));
    c.set_d(0x42, yaw);
    let v = sine(c, yaw);
    c.set_d(0x3c, v);
    let v = sine(c, 0x4000u16.wrapping_sub(yaw));
    c.set_d(0x3e, v);
    let v = sine(c, 0x4000u16.wrapping_sub(c.bp(8)));
    c.set_d(0x40, v);
    c.set_d(0x44, 0);
    let cx = c.r[CX].wrapping_add(c.e(hdr.wrapping_add(0x14)));
    // 8953: from the camera, finer when near
    let x = c.bp32(0x10).wrapping_sub(c.bp32(0x142));
    c.set_bp32(0x10, x);
    let z = c.bp32(0x14).wrapping_sub(c.bp32(0x14a));
    c.set_bp32(0x14, z);
    c.set_d(0x2a4, 0);
    let radius = c.e(hdr);
    if near(x, radius) && near(z, radius) {
        c.set_d(0x2a4, 0x8000);
    }
    let v = c.bp(0x154);
    c.set_bp(8, v);
    let v = c.bp(0x156);
    c.set_bp(0xc, v);
    c.r[CX] = cx;
    c.r[SI] = 0x2c;
    let (m, r) = c.split();
    point::point(m, r, Entry::Near);
    // 89E4
    let mut depth = c.d(0x30);
    if c.d(0x36) & 0x8000 != 0 {
        depth = sar(depth, 3);
    }
    if depth as i16 >= c.d(0x58) as i16 {
        // 8BA4
        if (c.bp(0x190) as i16) < 0 {
            return;
        }
        return lod(c, hdr, depth);
    }
    if c.d(0x4e) != 0 {
        return lod(c, hdr, depth);
    }
    if c.b(c.ss(0xf0), 0x981) != 0 {
        return;
    }
    zero(c, hdr);
}

/// |dx:ax| plus the radius under 3E80h.
fn near(v: u32, radius: u16) -> bool {
    let (mut ax, mut dx) = (v as u16, (v >> 16) as u16);
    if (dx as i16) < 0 {
        dx = !dx;
        ax = ax.wrapping_neg();
        if ax == 0 {
            dx = dx.wrapping_add(1);
        }
    }
    let (s, carry) = ax.overflowing_add(radius);
    let dx = dx.wrapping_add(carry as u16);
    (dx as i16) < 0 || dx == 0 && s < 0x3e80
}

/// 8A1D: shape 0, beside the view: its position turned by its own angle, then drawn as a
/// bitmap 8Ch columns to the side it lies on.
fn zero(c: &mut Cpu, hdr: u16) {
    let mut ax = c.d(0x2c);
    let mut dx = c.d(0x30);
    if (c.d(0x2a4) as i16) < 0 {
        ax = sar(ax, 3);
        dx = sar(dx, 3);
        c.set_d(0x2a4, 0);
    }
    c.set_bp(0x10, ax);
    c.set_bp(0x14, dx);
    let a = if (ax as i16) < 0 {
        c.set_bp(0x9c, 0xff74);
        c.d(0x5a)
    } else {
        c.set_bp(0x9c, 0x8c);
        c.d(0x5c)
    };
    let v = c.bp(0x9c);
    c.set_d(0x5e, v);
    let v = c.d(0x42).wrapping_sub(a);
    c.set_d(0x42, v);
    let (s, co) = (sine(c, a), sine(c, 0x4000u16.wrapping_sub(a)));
    c.set_bp(8, s);
    c.set_bp(0xc, co);
    let x = c.bp(0x10);
    c.set_bp(0, x);
    let (x, z) = (x as i16 as i32, c.bp(0x14) as i16 as i32);
    let (s, co) = (s as i16 as i32, co as i16 as i32);
    let rx = (x * s).wrapping_sub(z * co);
    let rz = (z * s).wrapping_add(x * co);
    c.set_bp(0x14, ((rz as u32) << 4 >> 16) as u16);
    c.set_bp(0x16, (rz >> 16) as u16);
    let v = rx.wrapping_neg() >> 6;
    c.set_bp32(0x10, v as u32);
    c.r[AX] = (v >> 8) as u16;
    c.r[DX] = (v >> 16) as u16;
    c.r[CX] = 0;
    c.r[SI] = 0x2c;
    let (m, r) = c.split();
    point::point(m, r, Entry::Projected);
    // 8B23
    let dx = c.bp(0x9c);
    let col = c.d(0x32).wrapping_add(dx);
    c.set_d(0x32, col);
    if ((col.wrapping_sub(0xa0) ^ dx) as i16) < 0 {
        return;
    }
    let mut di = hdr;
    while 0x7fff > c.e(di.wrapping_add(0x16)) as i16 {
        di = di.wrapping_add(0xa);
    }
    let cx = c.e(di.wrapping_add(0x18));
    if (cx as i16) < 0 || c.d(0x36) & 0x10 != 0 {
        return;
    }
    let v = c.d(0x42).wrapping_neg();
    c.set_d(0x42, v);
    let v = c.d(0x30);
    c.set_bp(0x14, v);
    let v = parallax(c, c.d(0x32).wrapping_sub(c.d(0x5e)));
    c.set_d(0x44, v);
    c.set_bpb(0x134, 0x80);
    sprite(c, di, cx);
}

/// 8BAF: the level of detail for the depth, then a bitmap or the model.
fn lod(c: &mut Cpu, hdr: u16, depth: u16) {
    let mut di = hdr;
    while depth as i16 > c.e(di.wrapping_add(0x16)) as i16 {
        di = di.wrapping_add(0xa);
    }
    c.set_bp(0x14, depth);
    let cx = c.e(di.wrapping_add(0x18));
    if cx as i16 >= 0 {
        // 9A75
        if c.d(0x36) & 0x10 != 0 {
            return;
        }
        let v = parallax(c, c.d(0x32));
        c.set_d(0x44, v);
        return sprite(c, di, cx);
    }
    // 8BCB
    let col = if c.d(0x36) & 0x10 != 0 {
        if (c.d(0x2c) as i16) < 0 {
            0
        } else {
            0x140
        }
    } else {
        c.d(0x32)
    };
    let v = parallax(c, col);
    c.set_d(0x44, v);
    model(c, hdr, di, cx);
}

/// 9AAF: the level of detail at DI as one bitmap, chosen by the angle it is seen from (R:0042
/// plus R:0044) and its kind (SS:[bp+8C], CX: which angles it has, which mirror).
fn sprite(c: &mut Cpu, di: u16, cx: u16) {
    c.set_bp(0x8c, cx);
    let mut bx = 0u16;
    let n = c.e(di.wrapping_add(0x1a));
    let ang = c.d(0x42).wrapping_add(c.d(0x44));
    let id;
    if (n as i16) < 0 {
        bx = ang.wrapping_add(0x4000);
        id = n & 0x7fff;
    } else {
        let f = c.bp(0x8c);
        let kind = f as u8 as i8;
        let mut a = ang;
        if kind <= 2 {
            a = a.wrapping_add((f & 0x6000) << 1);
            if (a as i16) < 0 {
                if f & 0x1000 != 0 {
                    bx ^= 0x8000;
                    a = a.wrapping_neg();
                } else if f & 0x400 != 0 {
                    a = if a.wrapping_neg() >= 0x4000 {
                        0x8000
                    } else {
                        0
                    };
                } else {
                    return c.set_bpb(0x134, 0);
                }
            }
            // 9B1F
            if kind < 2 && a > 0x4000 {
                if f & 0x800 != 0 {
                    bx ^= 0x8000;
                    a = a.wrapping_neg().wrapping_add(0x8000);
                } else if f & 0x200 != 0 {
                    a = 0x4000;
                } else {
                    return c.set_bpb(0x134, 0);
                }
            }
        }
        // 9B74
        let mut si = c.e(di.wrapping_add(0x1c));
        let k = shr(a, n) & 0xfffe;
        si = si.wrapping_add(c.e(k.wrapping_add(si)));
        a = a.wrapping_add(c.e(si));
        let s = c.e(si.wrapping_add(4));
        if (s as i16) < 0 {
            bx = c.d(0x42).wrapping_add(c.d(0x44)).wrapping_add(0x4000);
            a = c.e(si.wrapping_add(2));
            if (a as i16) < 0 {
                // 9BA7: the model after all
                let h = c.d(0x50);
                let cx = c.e(h.wrapping_add(0x18));
                return model(c, h, h, cx);
            }
        } else {
            a = shr(a, s).wrapping_add(c.e(si.wrapping_add(2)));
        }
        id = a;
    }
    // 9BBA
    let colours = c.bp(0x174);
    c.set_bp(0x12e, bx);
    let v = c.bp(0x14);
    c.set_bp(0x8c, v);
    let v = c.d(0x32);
    c.set_bp(0x88, v);
    let row = c.d(0x34);
    let (m, r) = c.split();
    bitmap::bitmap(m, r[BP], id, row, colours);
    // 9BD8
    c.set_bpb(0x134, 0);
}

/// 8C17: the model: its colours hazed, its coordinates turned (R:0E12 on), its vertices that
/// must not lie all off one side checked, then its commands in the order for the angle it is
/// seen from.
fn model(c: &mut Cpu, hdr: u16, di: u16, cx: u16) {
    let mut dx = c.d(0x30);
    if (c.d(0x2a4) as i16) < 0 {
        dx = sar(dx, 3);
    }
    let ax = c.e(hdr) >> 3;
    if (dx as i16) < ax as i16 {
        dx = ax;
    }
    c.r[AX] = ax;
    c.r[DX] = dx;
    c.r[SI] = c.bp(0x174);
    haze(c);
    c.set_bp(0xa8, di);
    let v = c
        .e(hdr.wrapping_add(0x12))
        .wrapping_sub(c.e(hdr.wrapping_add(0x14)));
    let v = c.d(0x2e).wrapping_add(v);
    c.set_d(0x2e, v);
    let mut si = c.e(hdr.wrapping_add(2));
    // 8C4F: a coordinate the game moves (SS:[bp+168])
    let a = c.bp(0x168);
    if a != 0 {
        let b = a & 0xf;
        if b == 0 {
            si = si.wrapping_add(a >> 3);
        } else {
            let at = (b << 1).wrapping_add(si).wrapping_sub(2);
            let g = c.s[ES];
            c.set_w(g, at, (a & 0xfff0) >> 1);
        }
    }
    let mut mask = cx << 1;
    if mask != 0 {
        let (s, co, p) = (c.d(0x3c), c.d(0x3e), c.d(0x40));
        c.set_bp(0x10, s);
        c.set_bp(0x14, co);
        c.set_bp(0x98, p);
        let fine = c.d(0x2a4) != 0;
        let mut t = 0xe12u16;
        loop {
            let v = c.e(si);
            si = si.wrapping_add(2);
            let bit = mask & 0x8000 != 0;
            mask <<= 1;
            if bit {
                turned(c, t, v, p, co, s, fine);
                t = t.wrapping_add(2);
            } else if mask == 0 {
                break;
            }
        }
    }
    // 8DC4
    c.set_bp(0x30, 0x836);
    let v = c.d(0x28);
    c.set_d(0x2aa, v);
    for k in 0..0x6b {
        c.set_d(0xf10 + 2 * k, 0);
    }
    let v = c.e(hdr.wrapping_add(0xe));
    c.set_bp(0xa4, v);
    let vt = c.e(hdr.wrapping_add(0xa));
    c.set_d(0x4a, vt);
    c.set_bp(0xa0, vt);
    let mut p = c.e(hdr.wrapping_add(6));
    let mut v = c.eb(p);
    p = p.wrapping_add(1);
    if v & 0x80 == 0 {
        // 8E07: all of them off one side (behind, left or right), nothing drawn
        let mut cl = 0x1cu8;
        loop {
            let b = vertex_at_always(c, v as u16);
            cl &= c.db(b.wrapping_add(0x83a));
            if cl == 0 {
                loop {
                    p = p.wrapping_add(1);
                    if c.eb(p.wrapping_sub(1)) & 0x80 != 0 {
                        break;
                    }
                }
                break;
            }
            v = c.eb(p);
            p = p.wrapping_add(1);
            if v & 0x80 != 0 {
                return;
            }
        }
    }
    // 8E2E
    if c.bpb(0x17a) & 0x80 != 0 {
        p = 0x7793;
    }
    c.set_d(0x54, p);
    let lod = c.bp(0xa8);
    let mut si = c.e(lod.wrapping_add(0x1c));
    let n = c.e(lod.wrapping_add(0x1a));
    let k = shr(c.d(0x42).wrapping_add(c.d(0x44)), n) & 0xfffe;
    si = si.wrapping_add(c.e(k.wrapping_add(si)));
    // 9A47
    loop {
        let cmd = c.e(si);
        si = si.wrapping_add(2);
        if (cmd as i16) < 0 {
            return;
        }
        command(c, cmd);
    }
}

/// 8E0D: the checked vertices are projected whether or not they were (none are yet).
fn vertex_at_always(c: &mut Cpu, v: u16) -> u16 {
    c.r[BX] = v;
    vertex(c);
    c.r[BX]
}

/// 8CAA, 8CF9, 8D4A, 8D8C: coordinate `v` turned: times the pitch's cosine at T-80h (negated at
/// T-60h; 0 without pitch), times the cosine at T+40h (T+60h), times the sine at T (T+20h);
/// four times finer when near.
fn turned(c: &mut Cpu, t: u16, v: u16, p: u16, co: u16, s: u16, fine: bool) {
    let times = |k: u16| v as i16 as i32 * k as i16 as i32;
    let up = |k: u16| ((times(k) as u32) << 2 >> 16) as u16;
    let down = |k: u16| (times(k) >> 1 >> 16) as u16;
    let put = |c: &mut Cpu, o: u16, w: u16| {
        c.set_d(t.wrapping_add(o), w);
        c.set_d(t.wrapping_add(o).wrapping_add(0x20), w.wrapping_neg());
    };
    put(c, 0xff80, if p != 0 { up(p) } else { 0 });
    let f = |k: u16| if fine { up(k) } else { down(k) };
    put(c, 0x40, f(co));
    put(c, 0, f(s));
}

/// 8E5E: one command (at R:0054 + cmd): a polygon (bit 7 clear), a pole (bit 5) or a bitmap.
fn command(c: &mut Cpu, cmd: u16) {
    let mut si = c.d(0x54).wrapping_add(cmd);
    let k = c.eb(si);
    c.set_db(0x2f4, k);
    si = si.wrapping_add(1);
    if k & 0x80 == 0 {
        return polygon(c, si);
    }
    if c.d(0x2f4) & 0x20 != 0 {
        return pole_of(c, si);
    }
    if c.d(0x2f4) & 0x10 != 0 && c.bpb(0x178) & 0x10 == 0 {
        return;
    }
    // 8E94: a bitmap at a vertex, up to a depth
    let v = c.eb(si) as u16;
    si = si.wrapping_add(1);
    let b = vertex_at(c, v);
    let rec = b.wrapping_add(0x830);
    let fl = c.d(rec.wrapping_add(0xa));
    if fl & 0x10 != 0 {
        return;
    }
    let mut dx = c.d(rec.wrapping_add(4));
    if fl & 0x8000 != 0 {
        dx = sar(dx, 3);
    }
    let far = (c.eb(si) as u16) << 7;
    si = si.wrapping_add(1);
    if (far as i16) < dx as i16 {
        return;
    }
    c.set_bp(0x8c, dx);
    let v = c.d(rec.wrapping_add(6));
    c.set_bp(0x88, v);
    let row = c.d(rec.wrapping_add(8));
    let bx = c.eb(si) as u16;
    si = si.wrapping_add(1);
    let w = c.d(0x2f4);
    let (id, colours);
    if bx >= 0x4b {
        let mut a = 1u16;
        if w & 4 == 0 {
            a = c.d(0x42).wrapping_add(0x4000);
        }
        if w & 8 != 0 {
            a = a.wrapping_neg();
        }
        c.set_bp(0x12e, a);
        id = bx;
        colours = given(c, si);
    } else if bx >= 0x42 {
        // 8F1D: a front wheel, turned with the steering
        let s = c.bp(0x16a);
        let a = steer(s)
            .wrapping_add(c.d(0x42))
            .wrapping_add(c.d(0x44))
            .wrapping_add(s)
            .wrapping_add(s);
        c.set_bp(0x12e, a);
        let m = if (a as i16) < 0 { a.wrapping_neg() } else { a };
        id = (m.wrapping_add(0x800) >> 12).wrapping_add(bx);
        colours = c.bp(0x176);
    } else {
        // 8F71
        let mut a = c.d(0x42).wrapping_add(parallax(c, c.bp(0x88)));
        if bx >= 0x21 {
            a = a.wrapping_add(steer(c.bp(0x16a)));
        }
        let a = (a & 0x7fff) << 1;
        c.set_bp(0x12e, a);
        let mut a = a >> 1;
        if a as i16 > 0x4000 {
            a = a.wrapping_neg().wrapping_add(0x8000);
        }
        id = (a.wrapping_add(0x100) >> 9).wrapping_add(bx);
        colours = given(c, si);
    }
    let (m, r) = c.split();
    bitmap::bitmap(m, r[BP], id, row, colours);
}

/// 8FF1: the palette, or the command's own (R:02F4 bit 1).
fn given(c: &Cpu, si: u16) -> u16 {
    if c.d(0x2f4) & 2 != 0 {
        c.e(si)
    } else {
        c.bp(0x174)
    }
}

/// 9006: a pole along an edge.
fn pole_of(c: &mut Cpu, si: u16) {
    let k = c.eb(si);
    c.set_db(0x2f4, k);
    let e = (c.eb(si.wrapping_add(1)) as u16) << 1;
    let et = c.bp(0xa4);
    let a = vertex_at(c, c.eb(e.wrapping_add(et)) as u16);
    let b = vertex_at(c, c.eb(e.wrapping_add(et).wrapping_add(1)) as u16);
    c.r[BX] = b;
    c.r[DI] = a;
    pole(c);
}

/// 9052: a polygon: its edges (signed: negative ones reversed) built once each into R:0FE6 and
/// listed from R:0E9E; a back face (R:02F4 bit 6, by the columns of a vertex and its
/// neighbour) left out; then filled in its colour hazed.
fn polygon(c: &mut Cpu, mut si: u16) {
    c.set_d(0xe98, 0xe9e);
    c.set_d(0xe9a, 0xe9e);
    c.set_d(0xe9c, 0);
    let mut e = c.eb(si);
    si = si.wrapping_add(1);
    loop {
        // 9068
        c.set_db(0x46, e);
        let k = (if e & 0x80 != 0 { e.wrapping_neg() } else { e }) as u16;
        if c.db(k.wrapping_add(0xf66)) & 0x80 == 0 {
            c.set_db(k.wrapping_add(0xf66), 0x80);
            let et = c.bp(0xa4);
            let a = vertex_at(c, c.eb((k << 1).wrapping_add(et)) as u16);
            let b = vertex_at(c, c.eb((k << 1).wrapping_add(et).wrapping_add(1)) as u16);
            let (m, r) = c.split();
            edge::edge(m, r[BP], k << 2, a, b, 0xfe6);
        }
        // 99A5
        let at = (k << 2).wrapping_add(0xfe6);
        let mut ax = c.d(at);
        if ax & 0x80 == 0 {
            if c.db(0x46) & 0x80 != 0 {
                ax ^= 0x40;
            }
            let p = c.d(0xe9a);
            c.set_d(p, ax);
            let v = c.d(at.wrapping_add(2));
            c.set_d(p.wrapping_add(2), v);
            c.set_d(0xe9a, p.wrapping_add(4));
        }
        let v = c.d(0xe9c) | ax;
        c.set_d(0xe9c, v);
        e = c.eb(si);
        si = si.wrapping_add(1);
        if e == 0 {
            break;
        }
    }
    // 99E0
    let v = c.d(0xe98);
    c.set_d(0x10, v);
    let v = c.d(0xe9a);
    c.set_d(0xc, v);
    let v = c.d(0xe9c);
    c.set_d(0x640, v);
    let w = c.d(0x2f4);
    c.set_d(0x2f4, w & 0xffbf);
    if w & 0x40 != 0 {
        let v = c.eb(si) as u16;
        let vt = c.d(0x4a);
        let n = c.e((v << 3).wrapping_add(vt).wrapping_add(6));
        let (a, b) = (v << 4, n << 4);
        if c.d(a.wrapping_add(0x83a)) & 0x10 == 0 {
            let x = c.d(a.wrapping_add(0x836));
            if c.d(b.wrapping_add(0x83a)) & 0x10 == 0
                && x as i16 > c.d(b.wrapping_add(0x836)) as i16
            {
                return;
            }
        }
    }
    // 9A34
    let col = c.ssb(0x2ee4u16.wrapping_add(c.d(0x2f4)));
    c.set_db(0x2f4, col);
    let (m, r) = c.split();
    fill::fill(m, r[BP]);
}
