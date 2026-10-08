//! The objects in the scene (gp.exe 0F47:5149 to 546F, 817A to 81CD, and 9BE0 to A1C0;
//! docs/renderer-notes.md, section 8): the walk's objects (8 bytes each from R:00F2 to R:00F6:
//! a distance, a key, a far pointer to the object) sorted into the near list (R:0072) and the
//! far list (R:0074), each from far to near; each drawn (9E2A) as its setting says (the table at
//! G:[G:023A], 16 bytes a kind) or, for a car, from its pose; and the pit lane drawn as a scene
//! of its own (9C05) when the walk reaches it.
//!
//! Each step below names the game's instruction it stands for.

use super::regs::*;
use super::{cars, road, shape, strips, walk};

/// A routine run as the game calls it, `depth` bytes further down the stack (what the caller
/// pushes, and the return address): the pit lane's walk keeps SP (R:0132).
pub(super) fn deeper(c: &mut Cpu, depth: u16, f: fn(&mut Cpu)) {
    let sp = c.r[SP];
    c.r[SP] = sp.wrapping_sub(depth);
    f(c);
    c.r[SP] = sp;
}

/// The objects of a list (R:0072 or R:0074) drawn in turn while their distance (R:0060) is at
/// least `due` (all of them, to the end mark 8000h, when None); the list moved on.
pub(super) fn objects(c: &mut Cpu, list: u16, due: Option<u16>) {
    let go = |ax: u16| match due {
        None => ax != 0x8000,
        Some(d) => ax as i16 >= d as i16,
    };
    let mut bx = c.d(list);
    c.r[BX] = bx;
    let ax = c.d(bx);
    c.r[AX] = ax;
    c.set_d(0x60, ax);
    if !go(ax) {
        return;
    }
    let (es, di) = (c.s[ES], c.r[DI]);
    loop {
        c.r[DI] = c.d(bx.wrapping_add(4));
        c.s[ES] = c.d(bx.wrapping_add(6));
        bx = bx.wrapping_add(8);
        c.r[BX] = bx;
        // PUSH ES, PUSH DI, CALL
        deeper(c, 6, object);
        let ax = c.d(bx);
        c.r[AX] = ax;
        c.set_d(0x60, ax);
        if !go(ax) {
            break;
        }
    }
    c.s[ES] = es;
    c.r[DI] = di;
    c.set_d(list, bx);
}

/// 541B: the objects left in both lists drawn, the far list's first.
pub fn drain(c: &mut Cpu) {
    objects(c, 0x74, None);
    objects(c, 0x72, None);
}

/// 9E2A: the object at ES:DI drawn (DS the game's data segment G for its kind's setting): its
/// kind (+1E) a car (80h to B3h), a parked car (B4h on, its setting 4 or 5), or a setting:
/// left out at this level of detail (G:0068), the pit lane (settings 0 and 1, 9C05), or a shape
/// at the object's place (x4 and x8 eight times finer) moved by the setting's offsets along the
/// object's direction, turned by its heading. The registers kept.
pub fn object(c: &mut Cpu) {
    let (r, s) = (*c.r, *c.s);
    c.s[DS] = c.ss(0xf0);
    setting(c);
    *c.r = r;
    *c.s = s;
}

fn setting(c: &mut Cpu) {
    let di = c.r[DI];
    let kind = c.eb(di.wrapping_add(0x1e));
    let mut bx = kind as u16;
    if kind & 0x80 != 0 {
        if bx < 0xb4 {
            return car(c, bx);
        }
        // 9E47: a parked car, which may be the camera's (+23 bit 5)
        let b = (bx - 0xb4) << 2;
        if (c.d(b.wrapping_add(0xb01)) as i16) < 0 {
            return;
        }
        let ax = c.d(b.wrapping_add(0xb03));
        let mut found = None;
        if (ax as i16) >= 0 {
            let si = ax.wrapping_add(0xd1b);
            if c.db(si.wrapping_add(0x23)) & 0x20 != 0 {
                found = Some(si);
            }
        }
        let (si, k) = match found {
            Some(si) => (si, 4),
            None => {
                let ax = c.d(b.wrapping_add(0xb01));
                let si = ax.wrapping_add(0xd1b);
                if c.db(si.wrapping_add(0x23)) & 0x20 != 0 {
                    (si, 4)
                } else {
                    (si, 5)
                }
            }
        };
        bx = k;
        let v = c.db(si.wrapping_add(0x25)) as u16;
        c.set_d(0x356b, v);
    }
    // 9E95
    if c.bpb(0x172) != 0 {
        return;
    }
    let bx = bx << 4;
    let si = c.d(0x23a);
    let f = c.db(bx.wrapping_add(si).wrapping_add(1));
    let lod = c.db(0x68) as i8;
    let shown = if lod > 2 {
        true
    } else if lod == 2 {
        f & 2 == 0
    } else if lod == 1 {
        f & 2 == 0 && f & 0x40 == 0
    } else {
        f & 4 != 0
    };
    if !shown {
        return;
    }
    if (bx as i16) < 0x20 {
        c.r[BX] = bx;
        c.r[SI] = si;
        // PUSH DS, PUSH ES, PUSHA, CALL
        return deeper(c, 22, pits);
    }
    let finer = |v: u16| ((v as i16 as i32) << 3) as u32;
    let x = finer(c.e(di.wrapping_add(4)));
    c.set_bp32(0x10, x);
    let z = finer(c.e(di.wrapping_add(8)));
    c.set_bp32(0x14, z);
    let by = |a: u16, k: u16| (imul(a, k).0 as u32) << 16 | imul(a, k).1 as u32;
    let fifth = |p: u32| (p as i32 >> 5) as u32;
    let (bx, dx) = if bx == 0x20 {
        // 9EE7: the starting lights, by the object's +1A
        let b = ((c.e(di.wrapping_add(0x1a)) & 0x7ff) >> 5) << 2;
        let dl = c.db(b.wrapping_add(0xb9c));
        c.set_bpb(0x2e77, dl);
        let dx = c.d(b.wrapping_add(0xb9d));
        (if (dx as i16) < 0 { 0x20 } else { 0x30 }, Some(dx))
    } else {
        let dx = c.d(bx.wrapping_add(si).wrapping_add(4));
        (bx, if dx != 0 { Some(dx) } else { None })
    };
    if let Some(dx) = dx {
        // 9F76: moved along the object's direction (+C, +E)
        let p = fifth(by(sar(c.e(di.wrapping_add(0xc)), 6), dx));
        let v = c.bp32(0x10).wrapping_add(p);
        c.set_bp32(0x10, v);
        let p = fifth(by(sar(c.e(di.wrapping_add(0xe)), 6), dx));
        let v = c.bp32(0x14).wrapping_sub(p);
        c.set_bp32(0x14, v);
    }
    // 9FBE
    let id = c.db(bx.wrapping_add(si)) as u16;
    let cx = c.d(bx.wrapping_add(si).wrapping_add(8));
    if cx != 0 {
        match id {
            1 => c.set_db(0x8042, cx as u8),
            0xd => c.set_db(0x83e5, cx as u8),
            5 => c.set_db(0x8288, cx as u8),
            _ if id as i16 >= 4 => c.set_bp(0x168, cx),
            _ => {
                // A001: the second offset, though the multiplier is the shape's number (AX)
                // and then what that left, not the direction the game loads into DX
                let p = fifth(by(id, cx));
                let v = c.bp32(0x10).wrapping_add(p);
                c.set_bp32(0x10, v);
                let p = fifth(by(p as u16, cx));
                let v = c.bp32(0x14).wrapping_add(p);
                c.set_bp32(0x14, v);
            }
        }
    }
    // A049
    let dx = c
        .e(di)
        .wrapping_add(c.d(bx.wrapping_add(si).wrapping_add(6)));
    let v = c.d(bx.wrapping_add(si).wrapping_add(2));
    c.set_bp(0x174, v);
    let cx = c
        .e(di.wrapping_add(6))
        .wrapping_add(c.d(bx.wrapping_add(si).wrapping_add(0xc)));
    c.r[AX] = id;
    c.r[BX] = bx;
    c.r[CX] = cx;
    c.r[DX] = dx;
    c.r[SI] = si;
    if (0x40..0x60).contains(&(bx as i16)) {
        cars::parked(c);
    }
    let v = c.d(bx.wrapping_add(si).wrapping_add(0xe));
    c.set_bp(8, v);
    shape::shape(c);
    c.set_bp(0x168, 0);
}

/// A07D: car `kind` (80h on): its record (G:0D1B + G:[0C65 + kind]) posed on its segment, its
/// steering, palette and helmet (+96 bit 5 clear: [bp+178] bit 4, the helmet's palette from
/// +AC), then drawn with its parts as its record says (+97, +9A).
fn car(c: &mut Cpu, kind: u16) {
    let bx = kind & 0x7f;
    let si = c.d(bx.wrapping_add(0xc65)).wrapping_add(0xd1b);
    c.r[BX] = bx;
    c.r[SI] = si;
    let r = c.ss(0xf4);
    let v = c.w(r, 0x60).wrapping_sub(c.w(r, 0x62));
    c.set_bp(0x190, v);
    c.r[DI] = c.d(si.wrapping_add(0x12));
    c.s[ES] = c.d(si.wrapping_add(0x14));
    cars::pose(c);
    // A0A2: 256 times coarser
    for o in [0x10, 0x14] {
        let v = (c.bp32(o) as i32 >> 8) as u32;
        c.set_bp32(o, v);
    }
    let cx = c.bp(0x18);
    let p = (c.d(si.wrapping_add(0x4a)) as i16 as i32 * c.d(0x156) as i16 as i32) as u32;
    let dx = ((p << 3) >> 16) as u16;
    let dx = dx.wrapping_add(c.d(si.wrapping_add(0x1a)));
    let v = c.d(si.wrapping_add(0x48));
    c.set_bp(0x16a, v);
    let al = c.db(si.wrapping_add(0x25));
    if al == 1 {
        c.set_bpb(0x17a, 0x80);
    }
    let v = ((al.wrapping_sub(1) as i8 as i16) << 4) as u16;
    c.set_bp(0x174, v);
    if c.db(si.wrapping_add(0x96)) & 0x20 == 0 {
        let v = c.bpb(0x178) | 0x10;
        c.set_bpb(0x178, v);
        let k = (c.db(si.wrapping_add(0xac)) & 0x3f).wrapping_sub(1) as u16;
        c.set_bp(0x176, (k << 4).wrapping_add(0x2aa4).wrapping_sub(0x2964));
    }
    c.r[AX] = 0;
    c.r[CX] = cx;
    c.r[DX] = dx;
    if c.db(si.wrapping_add(0x97)) & 0x80 != 0 {
        c.r[DI] = 0;
        cars::part_and_car(c);
    } else if c.db(si.wrapping_add(0x9a)) & 0x10 != 0 {
        if c.d(0x2945) == 0 && c.d(0x2943) == 0 {
            c.set_d(0x2943, 0xffff);
            c.set_d(0x2945, 0xffff);
        }
        if c.db(si.wrapping_add(0x9a)) & 4 != 0 {
            c.r[DI] = 1;
            cars::part_and_car(c);
        } else {
            c.r[DI] = 4;
            if si == c.d(0x97d) {
                cars::own_part(c);
            } else {
                cars::part_and_car(c);
            }
        }
    } else {
        cars::car(c);
    }
    // A189
    let v = c.bpb(0x178) & 0xef;
    c.set_bpb(0x178, v);
    c.set_bpb(0x17a, 0);
    let ss = c.s[SS];
    c.set_w(ss, 0x190, 0);
}

/// What the pit lane's scene keeps and puts back: SS:[bp+o] or R:o, in the order pushed.
#[derive(Clone, Copy)]
enum Kept {
    Bp(u16),
    R(u16),
}
const KEPT: [Kept; 29] = {
    use Kept::*;
    [
        Bp(0xae),
        Bp(0xac),
        Bp(0x36),
        Bp(0x34),
        Bp(0x32),
        Bp(0x30),
        Bp(0x2e),
        Bp(0x2c),
        Bp(0x2a),
        Bp(0x28),
        Bp(0x26),
        Bp(0x24),
        R(0xee),
        R(0xf2),
        R(0xf6),
        R(0x28),
        R(0x10c),
        R(0x110),
        R(0x2aa),
        R(0xf2),
        Bp(0x136),
        R(0xfa),
        R(0x170),
        R(0x1e6),
        R(0x66),
        R(0x68),
        R(0x74),
        R(0x72),
        R(0x62),
    ]
};

/// 9C05: the pit lane (setting BX/16: 0 the way in, 1 the way out), unless it is the one being
/// drawn (SS:[bp+170]): its own walk from where it leaves the track (G:01A8 on, 8 bytes a
/// setting) into a strip list after the track's, its strips and its scene (817A), all of the
/// walk's state kept and put back. The registers kept.
pub fn pits(c: &mut Cpu) {
    let bx = c.r[BX];
    if bx == c.bp(0x170) {
        return;
    }
    let bx = bx >> 4;
    c.r[BX] = bx;
    let (r, s) = (*c.r, *c.s);
    c.s[DS] = c.ss(0xf4);
    let kept: Vec<u16> = KEPT
        .iter()
        .map(|k| match *k {
            Kept::Bp(o) => c.bp(o),
            Kept::R(o) => c.d(o),
        })
        .collect();
    let mut si = c.d(0xfc);
    for o in (0..16).step_by(2) {
        c.set_d(si.wrapping_add(o), 0);
    }
    si = si.wrapping_add(0x10);
    c.set_d(0x10c, si);
    if si < 0xa47e {
        let v = c.d(0x114);
        c.set_d(0x110, v);
        let v = c.d(0x28);
        c.set_d(0x2aa, v);
        let ax = c.d(0xf6).wrapping_add(0x10);
        c.set_d(0xf2, ax);
        c.set_bp(0x24, ax);
        let g = c.ss(0xf0);
        let b = bx << 3;
        for (to, from) in [
            (0x1c0, 0x1a8),
            (0x1c2, 0x1aa),
            (0x1bc, 0x1ac),
            (0x1be, 0x1ae),
        ] {
            let v = c.w(g, b.wrapping_add(from));
            c.set_w(g, to, v);
        }
        // 9D01: where along the pit lane the camera's segment is, kept within its segments
        let mut di = c.w(g, 0x96f);
        let mut dx = 0u16;
        let add = |v: &mut u16, d: &mut u16, k: u16| {
            let (s, carry) = v.overflowing_add(k);
            *v = s;
            *d = d.wrapping_add(carry as u16);
        };
        let sub = |v: &mut u16, d: &mut u16, k: u16| {
            let (s, borrow) = v.overflowing_sub(k);
            *v = s;
            *d = d.wrapping_sub(borrow as u16);
        };
        if b == 0 {
            if di < 0x2e30 {
                add(&mut di, &mut dx, c.bp(0x158));
            }
            sub(&mut di, &mut dx, c.w(g, 0x18a));
            add(&mut di, &mut dx, 0xd7ae);
        } else {
            if di >= c.bp(0x15c).wrapping_sub(0x2e00) {
                sub(&mut di, &mut dx, c.bp(0x158));
            }
            sub(&mut di, &mut dx, c.w(g, 0x18e));
            add(&mut di, &mut dx, c.w(g, 0x182));
        }
        let (mut si, mut ax) = (di, dx);
        if (ax as i16) <= 0 && ((ax as i16) < 0 || si < 0xd7ae) {
            si = 0xd7ae;
            ax = 0;
        }
        if si >= c.w(g, 0x182) {
            si = c.w(g, 0x182);
        }
        let es = c.w(g, 0x8799);
        let cx = c
            .w(es, si)
            .wrapping_sub(c.w(g, 0x2261))
            .wrapping_add(0x4000);
        c.set_bp(0x136, cx);
        let di = if (cx as i16) >= 0 {
            ax = di;
            c.w(g, 0x1bc).wrapping_sub(di)
        } else {
            di.wrapping_sub(c.w(g, 0x1c0))
        };
        c.set_w(g, 0x1b8, di);
        (c.r[AX], c.r[BX], c.r[CX], c.r[DX]) = (ax, b, cx, dx);
        (c.r[SI], c.r[DI]) = (si, di);
        c.s[ES] = es;
        c.set_bpb(0x172, 0x80);
        c.set_db(0xfa, 0x80);
        c.set_db(0x170, 0x80);
        // PUSH DS, PUSH ES, PUSHA, 29 words kept, CALL
        for f in [walk::walk_pits, reset, strips::strips, scene] {
            deeper(c, 80, f);
        }
    }
    // 9DB7
    c.set_bpb(0x172, 0);
    for (k, &v) in KEPT.iter().zip(&kept).rev() {
        match *k {
            Kept::Bp(o) => c.set_bp(o, v),
            Kept::R(o) => c.set_d(o, v),
        }
    }
    *c.r = r;
    *c.s = s;
}

/// 9BE0: the pit lane's lists closed: its objects end at [bp+24] (at most A6C6h), its strips
/// from R:010C to R:00FC.
pub fn reset(c: &mut Cpu) {
    let si = c.bp(0x24).min(0xa6c6);
    c.set_d(0xf6, si);
    let si = c.d(0x10c);
    c.set_d(0x108, si);
    let si = c.d(0xfc).wrapping_sub(0x10);
    c.set_d(0x104, si);
    c.r[SI] = si;
}

/// The 13 rings in the work area at [bp+34] emptied (their lists at their middles).
pub(super) fn rings(c: &mut Cpu) {
    let mut bx = c.bp(0x34).wrapping_add(0x86);
    for _ in 0..13 {
        c.set_d(bx.wrapping_sub(0x86), bx);
        c.set_d(bx.wrapping_sub(0x84), bx);
        c.set_d(bx.wrapping_sub(0x82), 0);
        bx = bx.wrapping_add(0x106);
    }
    c.r[AX] = 0x106;
    c.r[BX] = bx;
    c.r[CX] = 0;
}

/// 817A: the pit lane's scene: its objects sorted, its strips' road and fences (the work area
/// at 4D2Eh), then its objects left.
pub fn scene(c: &mut Cpu) {
    let ax = c.d(0x108);
    c.r[AX] = ax;
    if ax >= c.d(0x104) {
        return;
    }
    deeper(c, 2, sort);
    let ax = c.d(0xf2);
    c.r[AX] = ax;
    c.set_bp(0x24, ax);
    c.set_bp(0xac, ax);
    c.r[SI] = c.d(0x10c);
    c.set_bp(0x34, 0x4d2e);
    c.r[DI] = c.d(0x110);
    rings(c);
    let v = c.d(0x104);
    c.set_d(0xee, v);
    for f in [road::road, road::fences, drain] {
        deeper(c, 2, f);
    }
}

/// 5149: the objects (R:00F2 to R:00F6) sorted: none, an end mark; in the pit lane's scene
/// (SS:[bp+172]), cars brought nearer by their +84 and all of them in the near list; else split
/// (51D7) and each list sorted far to near (53B0). The registers kept.
pub fn sort(c: &mut Cpu) {
    let (r, s) = (*c.r, *c.s);
    let si = c.d(0xf6);
    if si <= c.d(0xf2) {
        c.set_d(si, 0x8000);
        c.set_d(0x72, si);
        c.set_d(0x74, si);
    } else if c.bpb(0x172) != 0 {
        c.set_d(si, 0x8000);
        c.set_d(0x74, si);
        let v = c.d(0xf2);
        c.set_d(0x72, v);
        // 535A
        let g = c.ss(0xf0);
        let mut si = c.d(0xf2);
        while si < c.d(0xf6) {
            let (di, es) = (c.d(si.wrapping_add(4)), c.d(si.wrapping_add(6)));
            let cl = c.b(es, di.wrapping_add(0x1e));
            if cl & 0x80 != 0 && (cl as u16) < 0xb4 {
                let car = c.w(g, 0xc65 + (cl & 0x7f) as u16).wrapping_add(0xd1b);
                let al = c.b(g, car.wrapping_add(0x84)) as u16;
                let v = c.d(si).wrapping_sub(al);
                c.set_d(si, v);
            }
            si = si.wrapping_add(8);
        }
    } else {
        split(c);
        bubble(c, c.d(0x74));
        bubble(c, c.d(0x72));
    }
    *c.r = r;
    *c.s = s;
}

/// 8 bytes from `from` to `to`, a word at a time.
fn copy(c: &mut Cpu, to: u16, from: u16) {
    for o in (0..8).step_by(2) {
        let v = c.d(from.wrapping_add(o));
        c.set_d(to.wrapping_add(o), v);
    }
}

/// 51D7: each object's distance and key set from its kind's setting (G:[023A] + 16 x kind: +A
/// low byte the distance it is drawn ahead by, at least 2; high byte, its bit 7 a limit at
/// R:0064, its low 6 bits added) or a car's +84; objects too far behind left out; those whose
/// object says so (+26 bit 6) and cars kept in place as the near list, the rest gathered at
/// R:4D2E and put after them as the far list.
fn split(c: &mut Cpu) {
    let g = c.ss(0xf0);
    c.set_bp(0xb8, 0x4d2e);
    let mut si = c.d(0xf2);
    c.set_bp(0xb4, si);
    c.set_d(0x72, si);
    while si < c.d(0xf6) {
        let (di, es) = (c.d(si.wrapping_add(4)), c.d(si.wrapping_add(6)));
        let cl = c.b(es, di.wrapping_add(0x1e));
        let mut cx = cl as u16;
        let mut ax;
        if cl & 0x80 != 0 && cx < 0xb4 {
            let car = c.w(g, 0xc65 + (cx & 0x7f)).wrapping_add(0xd1b);
            ax = c.b(g, car.wrapping_add(0x84)) as u16;
        } else {
            if cl & 0x80 != 0 {
                cx = 4;
            }
            // 5225
            cx <<= 4;
            let bx = c.w(g, 0x23a).wrapping_add(cx);
            let a = c.w(g, bx.wrapping_add(0xa));
            let dx = (a & 0xff).max(2);
            c.set_c(0x53ae, dx);
            let a = sar(a, 8);
            c.set_c(0x53ac, a);
            ax = (a & 0x3f).wrapping_add(dx).wrapping_sub(2);
            let mut d = dx.wrapping_add(c.d(si)).wrapping_sub(c.d(0x68));
            if (d as i16) < 0 {
                let kept = c.b(g, 0x981) == 0xc0 && {
                    d = d.wrapping_add(0xa);
                    d as i16 >= 0
                };
                if !kept {
                    si = si.wrapping_add(8);
                    continue;
                }
            }
            if c.b(es, di.wrapping_add(0x26)) & 0x40 == 0 {
                // 52B7
                if c.b(es, di.wrapping_add(0x1f)) & 4 != 0 {
                    ax = ahead(c, ax, cx, si);
                }
                ax = ax.wrapping_add(c.d(si));
                let cxk = ax;
                if c.c(0x53ac) & 0x80 != 0 && ax as i16 >= c.d(0x64) as i16 {
                    let dx = sar(c.c(0x53ae), 1).wrapping_neg().wrapping_add(c.d(si));
                    if (dx as i16) < c.d(0x64) as i16 {
                        ax = c.d(0x64).wrapping_sub(1);
                    }
                }
                c.set_d(si, ax);
                c.set_d(si.wrapping_add(2), cxk);
                let bx = c.bp(0xb8);
                copy(c, bx, si);
                c.set_bp(0xb8, bx.wrapping_add(8));
                si = si.wrapping_add(8);
                continue;
            }
        }
        // 5289
        let v = c.d(si).wrapping_sub(ax);
        c.set_d(si, v);
        c.set_d(si.wrapping_add(2), v);
        let bx = c.bp(0xb4);
        copy(c, bx, si);
        c.set_bp(0xb4, bx.wrapping_add(8));
        si = si.wrapping_add(8);
    }
    // 531A
    let mut bx = c.bp(0xb4);
    c.set_d(bx, 0x8000);
    bx = bx.wrapping_add(8);
    c.set_d(0x74, bx);
    let end = c.bp(0xb8);
    let mut di = 0x4d2e;
    while di != end {
        copy(c, bx, di);
        bx = bx.wrapping_add(8);
        di = di.wrapping_add(8);
    }
    c.set_d(bx, 0x8000);
}

/// 518A: an object that keeps to the leading car (+1F bit 2): its distance ahead (AX) replaced
/// by the leading car's distance (R:006A, or R:006C by the setting's +4 sign) from the object's,
/// when that is set and within |AX| + 15.
fn ahead(c: &Cpu, ax: u16, setting: u16, si: u16) -> u16 {
    let dx = if (ax as i16) < 0 {
        ax.wrapping_neg()
    } else {
        ax
    }
    .wrapping_add(0xf);
    let g = c.ss(0xf0);
    let bx = c.w(g, 0x23a).wrapping_add(setting);
    let v = if (c.w(g, bx.wrapping_add(4)) as i16) < 0 {
        c.d(0x6a)
    } else {
        c.d(0x6c)
    };
    if v == 0 {
        return ax;
    }
    let d = v.wrapping_sub(c.d(si));
    let a = if (d as i16) < 0 { d.wrapping_neg() } else { d };
    if a as i16 > dx as i16 {
        ax
    } else {
        d
    }
}

/// 53BF: a list sorted by its keys (+2), greatest first, by passes of swaps until one swaps
/// nothing.
fn bubble(c: &mut Cpu, start: u16) {
    if c.d(start) == 0x8000 || c.d(start.wrapping_add(8)) == 0x8000 {
        return;
    }
    loop {
        let mut si = start;
        let mut swapped = false;
        loop {
            if (c.d(si.wrapping_add(2)) as i16) < c.d(si.wrapping_add(0xa)) as i16 {
                let a: Vec<u16> = (0..8).step_by(2).map(|o| c.d(si + o)).collect();
                copy(c, si, si.wrapping_add(8));
                for (k, &v) in a.iter().enumerate() {
                    c.set_d(si.wrapping_add(8 + 2 * k as u16), v);
                }
                swapped = true;
            }
            si = si.wrapping_add(8);
            if c.d(si.wrapping_add(8)) == 0x8000 {
                break;
            }
        }
        if !swapped {
            break;
        }
    }
}
