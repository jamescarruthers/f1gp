//! The road and its fences (gp.exe 0F47:5470 to 725B, with 188A, the haze; docs/renderer-notes.md, sections 3 and
//! 7): the polygons along a block's strips, from the edges 4C12 made (30 slots of 4 bytes a strip,
//! from DI, 78h bytes on each strip): the road itself when it is drawn as polygons (R:00FA), its
//! lines, its edges, the outer walls, then the grass beside it; then (6425) the fences and kerbs,
//! strip by strip with the objects due before and after each.
//!
//! Each part's polygon is a ring of edge slots kept in the work area at [bp+34] (13 rings of
//! 106h bytes: the left list's start at +0, growing down; the right list's end at +2, growing up;
//! the slots' flags ORed at +4; the lists' middle at +86h). A strip whose part goes on adds the
//! part's two edges to the ring; where the part ends the ring is closed by its cross edge and
//! filled (0999) in the part's colour, hazed by its distance (188A), and a new ring started with
//! that cross edge. Going one way or the other (reversed) swaps the lists and which edges are
//! turned round (flag 40h).
//!
//! Each step below names the game's instruction it stands for.

use super::fill;
use super::list;
use super::regs::*;
use super::scene::objects;

/// One push onto a ring: the edge slot, the list (left or right), and whether it is turned.
#[derive(Clone, Copy)]
struct Push {
    slot: u16,
    left: bool,
    turn: bool,
}
const fn l(slot: u16, turn: bool) -> Push {
    Push {
        slot,
        left: true,
        turn,
    }
}
const fn r(slot: u16, turn: bool) -> Push {
    Push {
        slot,
        left: false,
        turn,
    }
}

/// The work area.
fn base(c: &Cpu) -> u16 {
    c.bp(0x34)
}

/// An edge slot's word at DI+k.
fn slot(c: &Cpu, k: u16) -> u16 {
    c.d(c.r[DI].wrapping_add(k))
}

/// The edge at DI+p.slot onto the ring (if it is drawn: bit 7 clear), its flags ORed in.
fn push(c: &mut Cpu, ring: u16, p: Push) {
    let at = base(c).wrapping_add(ring);
    list::ring_push(at, c.r[DI].wrapping_add(p.slot), p.left, p.turn);
    let mut ax = slot(c, p.slot);
    if (ax as i8) >= 0 {
        if p.turn {
            ax ^= 0x40;
        }
        let rec = slot(c, p.slot + 2);
        if p.left {
            let bx = c.d(at).wrapping_sub(4);
            c.set_d(bx, ax);
            c.set_d(bx.wrapping_add(2), rec);
            c.set_d(at, bx);
            c.r[BX] = bx;
        } else {
            let bx = c.d(at.wrapping_add(2));
            c.set_d(bx, ax);
            c.set_d(bx.wrapping_add(2), rec);
            let bx = bx.wrapping_add(4);
            c.set_d(at.wrapping_add(2), bx);
            c.r[BX] = bx;
        }
    }
    let f = c.d(at.wrapping_add(4)) | ax;
    c.set_d(at.wrapping_add(4), f);
    c.r[AX] = ax;
}

/// A new ring, started with the edge at DI+k (turned or not).
fn restart(c: &mut Cpu, ring: u16, k: u16, turn: bool) {
    let at = base(c).wrapping_add(ring);
    list::ring_restart(at, c.r[DI].wrapping_add(k), turn);
    let mut bx = at.wrapping_add(0x86);
    c.set_d(at, bx);
    let mut ax = slot(c, k);
    if (ax as i8) >= 0 {
        if turn {
            ax ^= 0x40;
        }
        c.set_d(bx, ax);
        let v = slot(c, k + 2);
        c.set_d(bx.wrapping_add(2), v);
        bx = bx.wrapping_add(4);
    }
    c.set_d(at.wrapping_add(4), ax);
    c.set_d(at.wrapping_add(2), bx);
    c.r[AX] = ax;
    c.r[BX] = bx;
}

/// 188A: the colour AL hazed by the distance BX (wet, by SS:[bp+182]): AL from the haze tables
/// at 7D70:7BC0, 256 bytes a level, or kept at level 0.
pub fn haze(c: &mut Cpu) {
    let (mut ax, mut bx) = (c.r[AX], c.r[BX]);
    let level;
    if c.bp(0x122e) != 0 {
        // 1892
        bx = (bx as i16).clamp(0, 0x78) as u16;
        std::mem::swap(&mut ax, &mut bx);
        let (_, lo) = imul(ax, c.bp(0x182));
        ax = lo;
        let mut h = (lo >> 8) as u8;
        if h > 4 {
            h = 4;
        }
        level = h;
        ax = ax & 0xff00 | bx & 0xff;
    } else {
        // 18B8
        bx = bx.wrapping_sub(0xa);
        if (bx as i16) < 0 {
            bx = 0;
        }
        bx >>= 3;
        if bx as i16 > 4 {
            bx = 4;
        }
        level = bx as u8;
    }
    let level = level.wrapping_sub(1);
    bx = (level as u16) << 8 | bx & 0xff;
    if (level as i8) >= 0 {
        // 18D2: MOV AX, 7D70h for ES leaves its high byte in AH
        let seg = c.c(0x18d6);
        bx = (level as u16) << 8 | ax & 0xff;
        let v = c.b(seg, bx.wrapping_add(0x7bc0));
        ax = seg & 0xff00 | v as u16;
    }
    c.r[AX] = ax;
    c.r[BX] = bx;
}

/// The ring filled: the colour hazed, R:0010 and R:000C the lists, R:02F4 the colour, R:0640 the
/// flags (ORed with 5 for the road and grass), then the filler.
fn fill_ring(c: &mut Cpu, ring: u16, colour: u8, depth: u16, mode: u16) {
    c.r[AX] = c.r[AX] & 0xff00 | colour as u16;
    c.r[BX] = depth;
    haze(c);
    let at = base(c).wrapping_add(ring);
    c.r[BX] = base(c);
    let v = c.d(at);
    c.set_d(0x10, v);
    let v = c.d(at.wrapping_add(2));
    c.set_d(0xc, v);
    let al = c.r[AX] as u8;
    c.set_db(0x2f4, al);
    let v = c.d(at.wrapping_add(4)) | mode;
    c.set_d(0x640, v);
    list::ring_fill(at, mode);
    let (m, r) = c.split();
    let bp = r[BP];
    r[AX] = fill::fill(m, bp);
}

/// The distance term of a strip's colour: its R:0066 count less R:0068, at least `min`.
fn depth(c: &Cpu, min: u16) -> u16 {
    let d = c.d(c.r[SI].wrapping_add(0xc)).wrapping_sub(c.d(0x68));
    if (d as i16) < min as i16 {
        min
    } else {
        d
    }
}

/// The parts' pushes, going forward or reversed.
struct Way {
    /// the two edges in, the cross edge out (before filling), the restart's turn
    first: fn(u16) -> Push,
    second: fn(u16) -> Push,
    close: fn(u16) -> Push,
    restart_turn: bool,
}
const FORWARD: Way = Way {
    first: |k| l(k, true),
    second: |k| r(k, false),
    close: |k| l(k, true),
    restart_turn: false,
};
const REVERSED: Way = Way {
    first: |k| r(k, false),
    second: |k| l(k, true),
    close: |k| l(k, false),
    restart_turn: true,
};

/// An inner part (the road as a polygon, its left and right lines): bits x (this side) and y
/// (the other), `next` the bit of the strip's next parts that ends it.
#[allow(clippy::too_many_arguments)]
fn inner(
    c: &mut Cpu,
    w: &Way,
    ring: u16,
    x: u16,
    y: u16,
    next: u16,
    slots: [u16; 3],
    colour: fn(&Cpu) -> (u8, u16, u16),
) {
    let (cx, dx) = (c.r[CX], c.r[DX]);
    let mut n = 0;
    c.set_bp(0xc, 0);
    if cx & x != 0 && dx & x != 0 && dx & y != 0 {
        push(c, ring, (w.first)(slots[0]));
        n += 1;
        c.set_bp(0xc, n);
    }
    if cx & y == 0 {
        return;
    }
    if dx & y != 0 && dx & x != 0 {
        push(c, ring, (w.second)(slots[1]));
        n += 1;
        c.set_bp(0xc, n);
    }
    if cx & x == 0 || c.d(c.r[SI].wrapping_add(4)) & next == 0 {
        return;
    }
    if n >= 2 {
        push(c, ring, (w.close)(slots[2]));
        let (col, d, mode) = colour(c);
        fill_ring(c, ring, col, d, mode);
    }
    restart(c, ring, slots[2], w.restart_turn);
}

/// An outer part (the walls, bits 80h and 40h; the fences and kerbs): two edges in, the third the
/// cross edge; its colour, distance and fill mode from `colour`.
fn outer(
    c: &mut Cpu,
    w: &Way,
    ring: u16,
    bit: u16,
    slots: [u16; 3],
    colour: fn(&Cpu) -> (u8, u16, u16),
) {
    let (cx, dx) = (c.r[CX], c.r[DX]);
    if cx & bit == 0 {
        return;
    }
    let ends = |c: &Cpu| c.d(c.r[SI].wrapping_add(4)) & bit != 0;
    if dx & bit == 0 {
        if ends(c) {
            restart(c, ring, slots[2], w.restart_turn);
        }
        return;
    }
    push(c, ring, (w.first)(slots[0]));
    push(c, ring, (w.second)(slots[1]));
    if !ends(c) {
        return;
    }
    push(c, ring, (w.close)(slots[2]));
    let (col, d, mode) = colour(c);
    fill_ring(c, ring, col, d, mode);
    restart(c, ring, slots[2], w.restart_turn);
}

/// 58B7: a wall's colour from R:0230 by the strip's +0B nibble.
fn wall(c: &Cpu, high: bool) -> (u8, u16, u16) {
    let b = c.db(c.r[SI].wrapping_add(0xb));
    let k = if high { b >> 4 } else { b & 0xf };
    (c.db(0x230 + k as u16), depth(c, 4), 0)
}

/// A fence's colour from the strip's +0E or +0F.
fn fence(c: &Cpu, k: u16) -> (u8, u16, u16) {
    (c.db(c.r[SI].wrapping_add(k)), depth(c, 5), 5)
}

/// A kerb's colour from R:0248 by the strip's +09 nibble.
fn kerb(c: &Cpu, high: bool) -> (u8, u16, u16) {
    let b = c.db(c.r[SI].wrapping_add(9));
    let k = if high { b >> 4 } else { b & 0xf };
    (c.db(0x248 + k as u16), depth(c, 1), 5)
}

/// A grass part: `skip` the R:0152 bit that leaves it out, `side` the road edge's bit, the edge in
/// and the screen's-side edge (unless it is the one at `border`), the colour [bp+1AF].
#[allow(clippy::too_many_arguments)]
fn grass(
    c: &mut Cpu,
    ring: u16,
    skip: u8,
    side: u16,
    first: Push,
    second: Push,
    border: u16,
    restart_turn: bool,
) {
    let cx = c.r[CX];
    if c.db(0x152) & skip != 0 || cx & side == 0 {
        return;
    }
    let ends = |c: &Cpu| c.d(c.r[SI].wrapping_add(4)) & side != 0;
    if c.r[DX] & side == 0 {
        if ends(c) {
            restart(c, ring, second.slot, restart_turn);
        }
        return;
    }
    push(c, ring, first);
    if !ends(c) {
        return;
    }
    let edge = c.r[DI].wrapping_add(second.slot);
    c.r[BX] = edge;
    if edge != c.d(border) {
        push(c, ring, second);
    }
    let col = c.bpb(0x1af);
    fill_ring(c, ring, col, 0, 5);
    restart(c, ring, second.slot, restart_turn);
}

/// Over the strips from SI to R:00EE, DI their edges; SI and DI kept.
fn strips(c: &mut Cpu, mut each: impl FnMut(&mut Cpu)) {
    let (si0, di0) = (c.r[SI], c.r[DI]);
    loop {
        let si = c.r[SI];
        c.r[DX] = c.d(si.wrapping_add(2));
        c.r[CX] = c.d(si);
        each(c);
        c.r[DI] = c.r[DI].wrapping_add(0x78);
        c.r[SI] = c.r[SI].wrapping_add(0x10);
        if c.r[SI] > c.d(0xee) {
            break;
        }
    }
    c.r[SI] = si0;
    c.r[DI] = di0;
}

/// 5470.
pub fn road(c: &mut Cpu) {
    let bx0 = c.r[BX];
    let reversed = (c.bp(0x136) as i16) < 0;
    let w = if reversed { &REVERSED } else { &FORWARD };
    // 547D: the road as a polygon
    if c.db(0xfa) != 0 && c.r[SI] <= c.d(0xee) {
        strips(c, |c| {
            inner(c, w, 0x830, 0x200, 0x100, 0x400, [0x4c, 0x5c, 0], |c| {
                (c.bpb(0x1ae), 0, 5)
            });
        });
    }
    // 55CC: the lines, edges and walls
    if c.r[SI] <= c.d(0xee) {
        strips(c, |c| {
            inner(c, w, 0x106, 0x200, 2, 2, [0x4c, 0x50, 0x54], |c| {
                (c.db(c.r[SI].wrapping_add(8)) & 0xf, depth(c, 2), 0)
            });
            inner(c, w, 0, 1, 0x100, 1, [0x58, 0x5c, 0x60], |c| {
                (c.db(c.r[SI].wrapping_add(8)) >> 4, depth(c, 2), 0)
            });
            outer(c, w, 0x72a, 0x80, [4, 8, 0xc], |c| wall(c, false));
            outer(c, w, 0x624, 0x40, [0x10, 0x14, 0x18], |c| wall(c, true));
        });
    }
    // 5A42: the grass
    if c.db(0xfa) == 0 && c.r[SI] <= c.d(0xee) && c.d(0x152) != 0xc {
        strips(c, |c| {
            if !reversed {
                grass(
                    c,
                    0xc48,
                    8,
                    0x200,
                    r(0x4c, false),
                    l(0x6c, true),
                    0x164,
                    false,
                );
                grass(
                    c,
                    0xb42,
                    4,
                    0x100,
                    l(0x5c, true),
                    l(0x70, true),
                    0x168,
                    false,
                );
            } else {
                grass(
                    c,
                    0xc48,
                    8,
                    0x200,
                    l(0x4c, true),
                    l(0x6c, false),
                    0x164,
                    true,
                );
                grass(
                    c,
                    0xb42,
                    4,
                    0x100,
                    r(0x5c, false),
                    l(0x70, false),
                    0x168,
                    true,
                );
            }
        });
    }
    c.r[BX] = bx0;
}

/// 6425: the fences (bits 20h and 10h, coloured by the strip's +0E and +0F) and the kerbs (8 and
/// 4, with the parts between them and the road's edges, A3Ch and 936h), strip by strip from SI
/// to R:00EE; before each strip the objects of the R:0074 list due by then (by their distance
/// against the strip's +0C), after it, where both fences go on, those of the R:0072 list. SI
/// and DI are left past the last strip.
pub fn fences(c: &mut Cpu) {
    let reversed = (c.bp(0x136) as i16) < 0;
    let w = if reversed { &REVERSED } else { &FORWARD };
    if c.r[SI] > c.d(0xee) {
        return;
    }
    loop {
        let due = c.d(c.r[SI].wrapping_add(0xc));
        objects(c, 0x74, Some(due));
        let si = c.r[SI];
        c.r[DX] = c.d(si.wrapping_add(2));
        c.r[CX] = c.d(si);
        outer(c, w, 0x51e, 0x20, [0x20, 0x1c, 0x24], |c| fence(c, 0xe));
        outer(c, w, 0x418, 0x10, [0x28, 0x2c, 0x30], |c| fence(c, 0xf));
        outer(c, w, 0x312, 8, [0x34, 0x38, 0x3c], |c| kerb(c, false));
        inner(c, w, 0xa3c, 8, 0x200, 8, [0x38, 0x4c, 0x64], |c| {
            kerb(c, true)
        });
        outer(c, w, 0x20c, 4, [0x40, 0x44, 0x48], |c| kerb(c, false));
        inner(c, w, 0x936, 0x100, 4, 4, [0x5c, 0x40, 0x68], |c| {
            kerb(c, true)
        });
        // 6B02
        c.r[CX] &= 0xff30;
        if c.r[CX] & 0x30 == 0x30 {
            let due = c.d(c.r[SI].wrapping_add(0xc));
            objects(c, 0x72, Some(due));
        }
        c.r[DI] = c.r[DI].wrapping_add(0x78);
        c.r[SI] = c.r[SI].wrapping_add(0x10);
        if c.r[SI] > c.d(0xee) {
            break;
        }
    }
}
