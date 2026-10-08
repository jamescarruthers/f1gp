//! The strips' edges (gp.exe 0F47:4C12 to 5148; docs/renderer-notes.md, section 7): for each strip
//! the walk recorded (16 bytes from R:010C to R:00FC, the parts it has at +0, the parts the strip
//! before had at +2, the parts its next has at +4), the edges between its section's points and
//! the last section's (kept at R:A6E6 to A704), into its 30 edge slots (78h bytes from R:0110 on).
//! Each part is a pair of points; where a part starts, its points are only kept; where it goes
//! on, two edges join them to the last ones; where it ends, a cross edge closes it.
//!
//! Each step below names the game's instruction it stands for.

use super::edge;
use super::regs::*;

/// One part: its bit, its two points (offsets in the section's block), their slots for the last
/// points, the edge slots (offsets in the strip's 78h bytes) for the two edges and the cross edge.
struct Part {
    bit: u16,
    a: u16,
    b: u16,
    last_a: u16,
    last_b: u16,
    edge_a: u16,
    edge_b: u16,
    cross: u16,
}

const PAIRS: [Part; 6] = [
    Part {
        bit: 0x80,
        a: 0x30,
        b: 0x3c,
        last_a: 0xa6ee,
        last_b: 0xa6f0,
        edge_a: 4,
        edge_b: 8,
        cross: 0xc,
    },
    Part {
        bit: 0x40,
        a: 0x48,
        b: 0x54,
        last_a: 0xa6f2,
        last_b: 0xa6f4,
        edge_a: 0x10,
        edge_b: 0x14,
        cross: 0x18,
    },
    Part {
        bit: 0x20,
        a: 0x6c,
        b: 0x60,
        last_a: 0xa6f8,
        last_b: 0xa6f6,
        edge_a: 0x20,
        edge_b: 0x1c,
        cross: 0x24,
    },
    Part {
        bit: 0x10,
        a: 0x78,
        b: 0x84,
        last_a: 0xa6fa,
        last_b: 0xa6fc,
        edge_a: 0x28,
        edge_b: 0x2c,
        cross: 0x30,
    },
    Part {
        bit: 8,
        a: 0x90,
        b: 0x9c,
        last_a: 0xa6fe,
        last_b: 0xa700,
        edge_a: 0x34,
        edge_b: 0x38,
        cross: 0x3c,
    },
    Part {
        bit: 4,
        a: 0xa8,
        b: 0xb4,
        last_a: 0xa702,
        last_b: 0xa704,
        edge_a: 0x40,
        edge_b: 0x44,
        cross: 0x48,
    },
];

/// The edge builder (03E9) on slot DI+AX, from the point at CX to the one at DX (offsets from
/// [bp+30]); it keeps the registers.
fn edge_to(c: &mut Cpu, ax: u16, cx: u16, dx: u16) {
    c.r[AX] = ax;
    c.r[CX] = cx;
    c.r[DX] = dx;
    let (m, r) = c.split();
    edge::edge(m, r[BP], r[AX], r[CX], r[DX], r[DI]);
}

/// A part that may go on: where it starts its points are kept; where it goes on the two edges
/// to the last points, `first` (a's) then b's.
fn goes_on(c: &mut Cpu, bit: u16, a: (u16, u16, u16), b: Option<(u16, u16, u16)>) {
    let at = c.bp(0x60);
    if c.bp(0x18) & bit == 0 {
        // the part starts here
        let v = a.1.wrapping_add(at);
        c.r[AX] = v;
        c.set_d(a.0, v);
        if let Some(b) = b {
            let v = b.1.wrapping_add(at);
            c.r[AX] = v;
            c.set_d(b.0, v);
        }
    } else {
        let last = c.d(a.0);
        let p = a.1.wrapping_add(at);
        c.set_d(a.0, p);
        edge_to(c, a.2, last, p);
        if let Some(b) = b {
            let last = c.d(b.0);
            let p = b.1.wrapping_add(at);
            c.set_d(b.0, p);
            edge_to(c, b.2, last, p);
        }
    }
}

/// A cross edge between two points of the section.
fn cross(c: &mut Cpu, k: u16, a: u16, b: u16) {
    let at = c.bp(0x60);
    edge_to(c, k, a.wrapping_add(at), b.wrapping_add(at));
}

/// 4F63, 503C: after the road's edge goes on: where its slot (DI+k) is flagged 10h (and not
/// hidden), the strip and this strip's next parts get `mark` (400h for the road as polygons).
fn edge_mark(c: &mut Cpu, k: u16, mark: u16) {
    c.r[BX] = k;
    let al = c.db(k.wrapping_add(c.r[DI]));
    c.r[AX] = c.r[AX] & 0xff00 | al as u16;
    if (al as i8) < 0 {
        return;
    }
    let al = al & 0x10;
    c.r[AX] = c.r[AX] & 0xff00 | al as u16;
    if al != 0 {
        let mark = if c.db(0xfa) != 0 { 0x400 } else { mark };
        let si = c.r[SI];
        let v = c.d(si.wrapping_add(4)) | mark;
        c.set_d(si.wrapping_add(4), v);
        let v = c.bp(0x10) | mark;
        c.set_bp(0x10, v);
    }
}

/// 4C12.
pub fn strips(c: &mut Cpu) {
    // a point at the screen's bottom middle, depth 2000h
    c.r[SI] = 0x4d22;
    for (o, v) in [(0, 0), (2, 0), (4, 0x2000), (6, 0xa0), (8, 0xa0), (0xa, 0)] {
        c.set_d(0x4d22 + o, v);
    }
    // 4C32: the last points all FFF4h
    c.s[ES] = c.ss(0xf4);
    for k in 0..0x12u16 {
        c.set_w(c.s[ES], 0xa6e6 + 2 * k, 0xfff4);
    }
    c.r[AX] = 0xfff4;
    c.r[CX] = 0;
    c.r[DI] = 0xa6e6 + 0x24;
    let ax = c.d(0x108);
    c.r[AX] = ax;
    if ax < c.d(0x104) {
        let mut si = c.d(0x10c);
        c.set_bp(0x30, 0x4d34);
        let mut di = c.d(0x110);
        c.set_bp(0x60, 0);
        while si != ax {
            di = di.wrapping_add(0x78);
            let v = c.bp(0x60).wrapping_add(0xd8);
            c.set_bp(0x60, v);
            si = si.wrapping_add(0x10);
        }
        c.r[SI] = si;
        c.r[DI] = di;
        loop {
            strip(c);
            // 5125
            c.r[DI] = c.r[DI].wrapping_add(0x78);
            let v = c.bp(0x60).wrapping_add(0xd8);
            c.set_bp(0x60, v);
            c.r[SI] = c.r[SI].wrapping_add(0x10);
            if c.r[SI] >= c.d(0xfc) {
                break;
            }
        }
        let di = c.r[DI];
        c.set_d(0x114, di);
    }
    // 5140
    let v = c.d(0x2aa);
    c.set_d(0x28, v);
}

/// 4C77: one strip.
fn strip(c: &mut Cpu) {
    let si = c.r[SI];
    let v = c.d(si);
    c.set_bp(0x14, v);
    let v = c.d(si.wrapping_add(4));
    c.set_bp(0x10, v);
    let v = c.d(si.wrapping_add(2));
    c.set_bp(0x18, v);
    let has = |c: &Cpu, o: u16, bit: u16| c.bp(o) & bit != 0;
    for p in &PAIRS {
        if !has(c, 0x14, p.bit) {
            continue;
        }
        goes_on(
            c,
            p.bit,
            (p.last_a, p.a, p.edge_a),
            Some((p.last_b, p.b, p.edge_b)),
        );
        if has(c, 0x10, p.bit) {
            cross(c, p.cross, p.a, p.b);
            // 4E95, 4F19: the kerb's end closed to the road's edge
            if p.bit == 8 && has(c, 0x14, 0x200) {
                cross(c, 0x64, 0x9c, 0);
            }
            if p.bit == 4 && has(c, 0x14, 0x100) {
                cross(c, 0x68, 0x24, 0xa8);
            }
        }
    }
    // 4F34: the road's left edge (point +00)
    if has(c, 0x14, 0x200) {
        let on = has(c, 0x18, 0x200);
        goes_on(c, 0x200, (0xa6e6, 0, 0x4c), None);
        if on {
            edge_mark(c, 0x4c, 0x200);
        }
    }
    // 4F8D: the left edge's inner point (+0C)
    if has(c, 0x14, 2) {
        goes_on(c, 2, (0xa6e8, 0xc, 0x50), None);
        if has(c, 0x14, 0x200) && has(c, 0x10, 2) {
            cross(c, 0x54, 0, 0xc);
        }
    }
    // 4FDE: the right edge's inner point (+18)
    if has(c, 0x14, 1) {
        goes_on(c, 1, (0xa6ea, 0x18, 0x58), None);
    }
    // 500D: the road's right edge (+24)
    if has(c, 0x14, 0x100) {
        let on = has(c, 0x18, 0x100);
        goes_on(c, 0x100, (0xa6ec, 0x24, 0x5c), None);
        if on {
            edge_mark(c, 0x5c, 0x100);
        }
        if has(c, 0x14, 1) && has(c, 0x10, 1) {
            cross(c, 0x60, 0x18, 0x24);
        }
    }
    // 5088: the road across
    if c.db(0xfa) != 0 {
        if has(c, 0x14, 0x200) && has(c, 0x14, 0x100) {
            let si = c.r[SI];
            let v = c.d(si.wrapping_add(4)) | 0x400;
            c.set_d(si.wrapping_add(4), v);
            let v = c.bp(0x10) | 0x400;
            c.set_bp(0x10, v);
            cross(c, 0, 0, 0x24);
        }
    } else {
        // 50BD: where the road ends, an edge along the screen's side to each edge's point
        let reversed = (c.bp(0x136) as i16) < 0;
        for (bit, side, point, k, keep, bl) in [
            (0x200u16, 8u16, 0u16, 0x6cu16, 0x164u16, 0u8),
            (0x100, 4, 0x24, 0x70, 0x168, 0x40),
        ] {
            if has(c, 0x14, bit) && has(c, 0x10, bit) {
                let cx = if reversed { side ^ 0xc } else { side };
                c.r[CX] = cx;
                let dx = point.wrapping_add(c.bp(0x60));
                c.r[DX] = dx;
                c.r[AX] = k;
                let v = c.r[DI].wrapping_add(k);
                c.set_d(keep, v);
                c.r[BX] = bl as u16;
                let (m, r) = c.split();
                edge::border(m, r[BP], r[AX], bl, r[CX], r[DX], r[SI], r[DI]);
            }
        }
    }
}
