//! The road's mode and blocks (gp.exe 0F47:49C0 and 4A03; docs/renderer-notes.md, sections 1 and
//! 7), between the segment walk and the edges.
//!
//! Each step below names the game's instruction it stands for.

use super::regs::*;
use super::section::{self, Entry};

/// 49C0: R:00FA, the road drawn as polygons (80h): when the camera's segment says so (+12 bit 4,
/// or bit 5 reversed), or the game's 0174 has bit 15, or R:0152 is not 0Ch, with R:0186 at
/// least 2000h.
pub fn mode(c: &mut Cpu) {
    c.set_db(0xfa, 0);
    let game = c.ss(0xf0);
    let cx = c.w(game, 0x174);
    c.r[CX] = cx;
    c.r[DI] = c.w(game, 0x96f);
    c.s[ES] = c.w(game, 0x971);
    let dx = if (c.bp(0x136) as i16) < 0 { 0x20 } else { 0x10 };
    c.r[DX] = dx;
    let set = if c.eb(c.r[DI].wrapping_add(0x12)) & dx as u8 != 0 {
        true
    } else if cx & 0x8000 == 0 && c.db(0x152) == 0xc {
        false
    } else {
        let ax = c.d(0x186);
        c.r[AX] = ax;
        ax >= 0x2000
    };
    if set {
        c.set_db(0xfa, 0x80);
    }
}

/// 4A03: the walk's lists closed (R:00F6 the objects', R:0104 the strips'), the crests between
/// R:01E8 and R:01EC made blocks (each crest's section rebuilt with the parts the next strip
/// adds, and its rows kept), and the far road's top rows (R:0136, 0138, 013A).
pub fn blocks(c: &mut Cpu) {
    let si = c.bp(0x24).min(0xa6c6);
    c.r[SI] = si;
    c.set_d(0xf6, si);
    let mut bx = c.bp(0x28);
    c.r[BX] = bx;
    c.set_d(0x1ec, bx);
    if c.db(0xfa) != 0 {
        c.set_d(0x1e8, 0x4c38);
    }
    let si = c.d(0xfc).wrapping_sub(0x10);
    c.r[SI] = si;
    c.set_d(0x104, si);
    if bx >= 0x4d10 {
        bx = 0x4cfe;
        c.r[BX] = bx;
        c.set_d(0x1ec, bx);
    }
    if bx <= c.d(0x1e8) {
        if bx != 0x4c38 {
            let ax = bx.wrapping_sub(0x12);
            c.r[AX] = ax;
            c.set_d(0x1e8, ax);
        } else if si > 0xa13e {
            // 4A5C: one block, the whole walk
            c.set_d(0x4c38, 0xa13e);
            c.set_db(0xfa, 0x80);
            c.set_d(0x1ec, 0x4c4a);
            c.set_d(0x1e8, 0x4c38);
            return close(c);
        } else {
            return none(c);
        }
    }
    // 4A95: each crest's section again, with what the next strip adds
    c.set_db(0x15c, 0xc0);
    let mut bx = c.d(0x1e8);
    c.r[BX] = bx;
    c.set_bp(0x28, bx);
    while bx < c.d(0x1ec) {
        let si = c.d(bx);
        c.r[SI] = si;
        c.set_bp(0x2c, si);
        let v = c.d(bx.wrapping_add(4));
        c.set_bp(0x30, v);
        c.r[DI] = c.d(bx.wrapping_add(8));
        c.s[ES] = c.d(bx.wrapping_add(0xa));
        let b = c.eb(c.r[DI].wrapping_add(0x26)) & 0x30;
        let ax = !(b as u16) & c.d(si.wrapping_add(0x12));
        let dx = !c.d(si);
        c.r[DX] = dx;
        let ax = ax & dx;
        c.r[AX] = ax;
        c.set_d(0x146, ax);
        let (si, ax) = if ax == 0 {
            let ax = c.d(si);
            c.r[AX] = ax;
            (si, ax)
        } else {
            section::section(c, Entry::Walls);
            let si = c.bp(0x2c);
            c.r[SI] = si;
            bx = c.bp(0x28);
            c.r[BX] = bx;
            let ax = c.d(0x146) | c.d(si);
            c.r[AX] = ax;
            c.set_d(si, ax);
            (si, ax)
        };
        let v = c.d(si.wrapping_add(4)) | ax;
        c.set_d(si.wrapping_add(4), v);
        // 4AE7: the crest's rows from its section's points
        let p = c.bp(0x30);
        let v = c.d(p.wrapping_add(8));
        c.set_d(bx.wrapping_add(0xc), v);
        let v = c.d(p.wrapping_add(0x2c));
        c.set_d(bx.wrapping_add(0xe), v);
        bx = bx.wrapping_add(0x12);
        c.r[BX] = bx;
        c.set_bp(0x28, bx);
    }
    close(c);
}

/// 4A76: no blocks.
fn none(c: &mut Cpu) {
    c.set_d(0x1e8, 0x4c38);
    c.set_d(0x1ec, 0x4c38);
    c.set_d(0x108, 0xa13e);
    c.set_d(0x104, 0xa13e);
    c.set_d(0xfc, 0xa13e);
}

/// 4B05: the last block's end entry, the far road's rows, and the strips before the first block
/// left with their fences and walls only.
fn close(c: &mut Cpu) {
    let bx = c.d(0x1ec);
    c.r[BX] = bx;
    let si = c.d(0x104);
    c.r[SI] = si;
    c.set_d(bx, si);
    c.set_d(bx.wrapping_add(0x10), 0xa4);
    c.set_d(bx.wrapping_add(0xc), 0xa4);
    c.set_d(bx.wrapping_add(0xe), 0xa4);
    if si <= c.d(bx.wrapping_sub(0x12)) {
        return none(c);
    }
    // 4B26
    let bx = c.d(0x1e8);
    c.r[BX] = bx;
    let si = c.d(bx).min(c.d(0x100));
    c.r[SI] = si;
    c.set_d(0x108, si);
    let mut dx = c.d(0x1fa);
    let mut cx = c.d(0x204);
    if c.d(0x1f8) == 0x8000 {
        dx = c.bp(0x130);
    }
    if c.d(0x202) == 0x8000 {
        cx = c.bp(0x130);
    }
    let p = c.d(bx.wrapping_add(4));
    let ax = (c.d(p.wrapping_add(0x24 + 0xa)) | c.d(p.wrapping_add(0xa))) & 0x1f;
    c.r[SI] = p;
    c.r[AX] = ax;
    let far = ax == 0 && {
        let d = c.d(p.wrapping_add(4));
        c.r[AX] = d;
        d as i16 >= 0x1400
    };
    if far {
        // 4B7D: both edges' rows the higher
        if (dx as i16) < cx as i16 {
            dx = cx;
        }
        c.set_d(0x138, dx);
        c.set_d(0x13a, dx);
        c.set_d(0x136, dx);
    } else {
        // 4B91
        c.set_d(0x138, dx);
        c.set_d(0x13a, cx);
        if dx as i16 > cx as i16 {
            dx = cx;
        }
        c.set_d(0x136, dx);
    }
    c.r[DX] = dx;
    c.r[CX] = cx;
    if c.db(0xfa) != 0 {
        // 4BAA: a last block too short to keep is joined to the one before
        let bx = c.d(0x1ec);
        c.r[BX] = bx;
        let si = bx.wrapping_sub(0x12);
        c.r[SI] = si;
        if si > c.d(0x1e8) {
            let d = c
                .d(si.wrapping_add(0xe))
                .wrapping_sub(c.d(si.wrapping_add(0xc)));
            let d = if (d as i16) < 0 { d.wrapping_neg() } else { d };
            c.r[AX] = d;
            if d as i16 >= c.d(0x206) as i16 {
                for o in [0, 0x10, 0xc, 0xe] {
                    let v = c.d(bx.wrapping_add(o));
                    c.set_d(si.wrapping_add(o), v);
                }
                c.set_d(0x1ec, si);
            }
        }
    }
    // 4BE3: the strips before the first block keep only their fences (30h)
    let bx = c.d(0x1e8);
    c.r[BX] = bx;
    let mut si = c.d(0x108);
    c.r[AX] = 0x30;
    c.r[DX] = 0x30;
    c.r[DI] = 0x30;
    c.r[CX] = 0;
    while si < c.d(bx) {
        for (o, m) in [(0, 0x30), (2, 0x30), (4, 0x30), (6, 0)] {
            let v = c.d(si.wrapping_add(o)) & m;
            c.set_d(si.wrapping_add(o), v);
        }
        si = si.wrapping_add(0x10);
    }
    c.r[SI] = si;
    let v = c.d(si.wrapping_add(2)) & 0x30;
    c.set_d(si.wrapping_add(2), v);
}
