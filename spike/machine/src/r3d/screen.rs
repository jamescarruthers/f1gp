//! The renderer's screen routines in segment 19ED (gp.exe 19ED:3112 to 3C68; docs/renderer-notes.md,
//! section 5): rows filled in a colour, around the cockpit below its top (SS:[bp+132]) only where
//! it is open; the horizon's scenery strip; and pieces of the cockpit copied onto the screen.
//!
//! The screen is the far pointer at DS:001C (R), 320 bytes a row. Some segments are immediates
//! in the code (the haze tables', the scenery's), so the ports read them from it.
//!
//! Each step below names the game's instruction it stands for.

use super::list;
use super::regs::*;

/// `n` bytes of `v` from seg:at (the game's STOSB and REP STOSW).
fn fill(c: &mut Cpu, seg: u16, at: u16, n: u16, v: u8) {
    for k in 0..n {
        c.set_b(seg, at.wrapping_add(k), v);
    }
}

/// `n` bytes from DS':si to ES':di, a byte at a time (the game's MOVSB and REP MOVSW).
fn copy(c: &mut Cpu, to: (u16, u16), from: (u16, u16), n: u16) {
    let rec = list::recording();
    for k in 0..n {
        let v = c.b(from.0, from.1.wrapping_add(k));
        c.set_b(to.0, to.1.wrapping_add(k), v);
        if rec {
            list::px(to.0, to.1.wrapping_add(k), v);
        }
    }
}

/// 19ED:3112 (far): rows CX to DX less one filled in colour AL (CX made 0 if below it).
pub fn rows(c: &mut Cpu) {
    if (c.r[CX] as i16) < 0 {
        c.r[CX] = 0;
    }
    let (cx, dx) = (c.r[CX], c.r[DX]);
    if cx as i16 >= dx as i16 {
        return;
    }
    let (seg, at) = (c.d(0x1e), c.d(0x1c).wrapping_add(cx.wrapping_mul(0x140)));
    let words = dx.wrapping_sub(cx).wrapping_mul(0x140) >> 1;
    list::rows(cx, dx, c.r[AX] as u8, false);
    fill(c, seg, at, words.wrapping_mul(2), c.r[AX] as u8);
}

/// 19ED:314A (far): rows CX to DX less one (both kept on the screen, above A5h) in colour AL:
/// whole above the cockpit's top (SS:[bp+132]), below it only where the cockpit is open (3181).
/// CX left as the game leaves it (at least 0, or the cockpit's top).
pub fn sky_rows(c: &mut Cpu) {
    if (c.r[CX] as i16) < 0 {
        c.r[CX] = 0;
    }
    let (cx, dx) = (c.r[CX], c.r[DX]);
    if cx as i16 >= dx as i16 || dx >= 0xa5 {
        return;
    }
    let top = c.bp(0x132);
    if dx as i16 <= top as i16 {
        return rows(c);
    }
    if (cx as i16) < top as i16 {
        c.r[DX] = top;
        rows(c);
        c.r[DX] = dx;
        c.r[CX] = top;
    }
    open_rows(c);
}

/// 19ED:3181: rows CX (from 67h) to DX less one (to A4h) in colour AL where the cockpit is open:
/// each row's start (SS:6364, 0 for none) and two spans, from SS:6556 to SS:640A and from
/// SS:64B0 to SS:65FC. The registers kept.
fn open_rows(c: &mut Cpu) {
    let cx = (c.r[CX] as i16).max(0x67) as u16;
    let dx = (c.r[DX] as i16).min(0xa4) as u16;
    if cx as i16 >= dx as i16 {
        return;
    }
    let (seg, screen) = (c.d(0x1e), c.d(0x1c));
    let al = c.r[AX] as u8;
    list::rows(cx, dx, al, true);
    for row in cx..dx {
        let t = (row - 0x67).wrapping_mul(2).wrapping_add(0x6364);
        let start = c.ss(t);
        if start == 0 {
            continue;
        }
        let at = screen.wrapping_add(start);
        for (from, to) in [(0x1f2, 0xa6), (0x14c, 0x298)] {
            let l = c.ss(t.wrapping_add(from));
            let n = c.ss(t.wrapping_add(to)).wrapping_sub(l);
            if (n as i16) > 0 {
                fill(c, seg, at.wrapping_add(l), n, al);
            }
        }
    }
}

/// 19ED:31FA (far): the back buffer (G:[04BC]) copied to the screen (A000:0000), once a frame.
/// In the outside views (G:0981 not 0) rows 0-179, and rows 180-199 cleared if SS:0138 is set
/// (which clears it). In the cockpit rows 0-102; then on rows 103-163 the window's openings
/// (SS:6364, as `open_rows`), the back buffer read at the screen's offsets (323C); then on
/// rows 116-137 the mirrors, all of the row but the gap between the openings (3288). Each byte
/// copied from the back buffer is marked in `copied` (by its offset in A000), if given. The
/// registers kept.
pub fn show(c: &mut Cpu, mut copied: Option<&mut [u8]>) {
    let g = c.ss(0xf0);
    let (src, from) = (c.w(g, 0x4be), c.w(g, 0x4bc));
    let mut put = |c: &mut Cpu, di: u16, si: u16, n: u16| {
        for k in 0..n {
            let v = c.b(src, si.wrapping_add(k));
            c.set_b(0xa000, di.wrapping_add(k), v);
            if let Some(m) = copied.as_deref_mut() {
                m[di.wrapping_add(k) as usize] = 1;
            }
        }
    };
    if c.b(g, 0x981) != 0 {
        put(c, 0, from, 0xe100);
        if c.ssb(0x138) != 0 {
            c.set_ssb(0x138, 0);
            fill(c, 0xa000, 0xe100, 0x1900, 0);
        }
        return;
    }
    put(c, 0, from, 0x80c0);
    // [l, r) of the row at DI (SUB, JLE: nothing unless r > l)
    let mut span = |c: &mut Cpu, di: u16, l: u16, r: u16| {
        if r as i16 > l as i16 {
            let at = di.wrapping_add(l);
            put(c, at, at, r.wrapping_sub(l));
        }
    };
    for row in 0x67..0xa4u16 {
        let t = 0x6364 + 2 * (row - 0x67);
        let di = c.ss(t);
        if di != 0 {
            let (l, r) = (c.ss(t + 0x1f2), c.ss(t + 0xa6));
            span(c, di, l, r);
            let (l, r) = (c.ss(t + 0x14c), c.ss(t + 0x298));
            span(c, di, l, r);
        }
    }
    for row in 0x74..0x8au16 {
        let t = 0x6364 + 2 * (row - 0x67);
        let di = c.ss(t);
        if di != 0 {
            let r = c.ss(t + 0xa6);
            span(c, di, 0, r);
            let l = c.ss(t + 0x14c);
            span(c, di, l, 0x140);
        }
    }
}

/// 19ED:39ED (far): the horizon's scenery, up to 8 rows (512 bytes a row, the segment in the
/// code at 3A4F, from 66A2h) above the horizon row SS:[bp+130] and down to the sky's lowest
/// R:0140, scrolled by the camera's heading and wrapped round; hazed (3AA7) when wet. The
/// registers kept.
pub fn scenery(c: &mut Cpu) {
    let dx0 = c.bp(0x130);
    if dx0 >= 0xa4 {
        return;
    }
    let mut si = 0x66a2u16;
    let mut dx = dx0;
    let mut cx = dx.wrapping_sub(8);
    if (cx as i16) < 0 {
        // 3A08: the rows above the screen skipped (by their count, not their bytes), and the
        // MUL leaves DX 0
        cx = cx.wrapping_neg();
        dx = mul(0x200, cx).0;
        si = si.wrapping_add(cx);
        cx = 0;
    }
    if dx as i16 > c.d(0x140) as i16 {
        dx = c.d(0x140);
    }
    let bx = dx.wrapping_sub(cx);
    if (bx as i16) < 0 {
        return;
    }
    let bx = bx.wrapping_sub(1);
    if (bx as i16) < 0 || bx >= 8 {
        return;
    }
    let g = c.ss(0xf0);
    let scroll = sar(c.w(g, 0x2261), 5) & 0x1ff;
    let (es, di0) = (c.d(0x1e), c.d(0x1c).wrapping_add(cx.wrapping_mul(0x140)));
    let src = c.c(0x3a4f);
    let mut si = si.wrapping_add(scroll);
    let first = (0x200u16.wrapping_sub(scroll) as i16).min(0x140) as u16;
    let rest = 0x140u16.wrapping_sub(first);
    let mut di = di0;
    for _ in 0..=bx {
        copy(c, (es, di), (src, si), first);
        di = di.wrapping_add(first);
        if rest != 0 {
            let from = si.wrapping_add(first).wrapping_sub(0x200);
            copy(c, (es, di), (src, from), rest);
            di = di.wrapping_add(rest);
        }
        si = si.wrapping_add(0x200);
    }
    if c.ss(0x122e) != 0 {
        // 3AA7
        let mut level = (c.bpb(0x184) as i8).wrapping_add(1);
        level = level.clamp(0, 3);
        let tables = c.c(0x3abf);
        let base = 0x7bc0u16.wrapping_add((level as u16) << 8);
        let n = (bx + 1).wrapping_mul(0x140);
        let rec = list::recording();
        for k in 0..n {
            let at = di0.wrapping_add(k);
            let v = c.b(es, at);
            let h = c.b(tables, base.wrapping_add(v as u16));
            c.set_b(es, at, h);
            if rec {
                list::px(es, at, h);
            }
        }
    }
}

/// G:[04B8] + `to` (the screen the cockpit is on) and G:[8783] + `from` (the cockpit's image).
fn cockpit(c: &Cpu, to: u16, from: u16) -> ((u16, u16), (u16, u16)) {
    let g = c.ss(0xf0);
    (
        (c.w(g, 0x4ba), c.w(g, 0x4b8).wrapping_add(to)),
        (c.w(g, 0x8785), c.w(g, 0x8783).wrapping_add(from)),
    )
}

/// `rows` rows of `n` bytes, 320 bytes apart in both.
fn block(c: &mut Cpu, to: (u16, u16), from: (u16, u16), n: u16, rows: u16) {
    for r in 0..rows {
        let o = r.wrapping_mul(0x140);
        copy(
            c,
            (to.0, to.1.wrapping_add(o)),
            (from.0, from.1.wrapping_add(o)),
            n,
        );
    }
}

/// 19ED:3AFA (far): two pieces of the cockpit at the screen's sides (22 rows of 48 bytes from row
/// 116, 40h apart in its image, 110h on the screen) put back over the view. The registers kept.
pub fn sides(c: &mut Cpu) {
    let (to, from) = cockpit(c, 0x9100, 0x1400);
    block(c, to, from, 0x30, 0x16);
    let to = (to.0, to.1.wrapping_add(0x110));
    let from = (from.0, from.1.wrapping_add(0x40));
    block(c, to, from, 0x30, 0x16);
}

/// 19ED:3819: BX + 1 rows of AX words; DX the gap to the next row, SI and DI moved on, BX -1.
fn rows_of(c: &mut Cpu, to: (u16, u16), from: (u16, u16)) {
    let ax = c.r[AX];
    let dx = 0x140u16.wrapping_sub(ax).wrapping_sub(ax);
    let (mut di, mut si) = (to.1, from.1);
    let mut bx = c.r[BX];
    loop {
        copy(c, (to.0, di), (from.0, si), ax.wrapping_mul(2));
        si = si.wrapping_add(ax.wrapping_mul(2)).wrapping_add(dx);
        di = di.wrapping_add(ax.wrapping_mul(2)).wrapping_add(dx);
        bx = bx.wrapping_sub(1);
        if (bx as i16) < 0 {
            break;
        }
    }
    c.r[DX] = dx;
    c.r[BX] = bx;
    c.r[SI] = si;
    c.r[DI] = di;
    c.s[ES] = to.0;
    c.s[DS] = from.0;
}

/// 19ED:3B46 (far): the start lights in the cockpit (G:290D, 1 to 6 lit): their frame, the
/// last one's, and by AX bit 0 or 1 one of two lamps. AX and DS kept.
pub fn start_lights(c: &mut Cpu) {
    let (ax, ds) = (c.r[AX], c.s[DS]);
    let g = c.ss(0xf0);
    c.s[DS] = g;
    let n = c.w(g, 0x290d);
    c.r[CX] = if n != 0 { n - 1 } else { 0 };
    if n != 0 && n - 1 < 6 {
        let cx = n - 1;
        let (_, a) = mul(5 - cx, 0x10);
        c.set_bp(0x18, a);
        let (dx, a) = mul((cx as i16).min(4) as u16 + 1, 0x10);
        c.r[DX] = dx;
        let a = a >> 1;
        c.set_bp(0x14, a);
        let lit = |c: &mut Cpu, to: u16, from: u16, ax: u16, bx: u16, shift: bool| {
            let (mut to, from) = cockpit(c, to, from);
            if shift {
                to.1 = to.1.wrapping_add(c.bp(0x18));
            }
            c.r[AX] = ax;
            c.r[BX] = bx;
            rows_of(c, to, from);
            c.s[DS] = c.ss(0xf0);
        };
        lit(c, 0xae0, 0x14e0, a, 0x2e, true);
        if cx == 5 {
            lit(c, 0x2430, 0x2e30, 8, 5, false);
        }
        if ax & 1 != 0 {
            lit(c, 0x1260, 0x1c10, c.bp(0x14), 0xd, true);
        } else if ax & 2 != 0 {
            lit(c, 0x2de0, 0x3790, c.bp(0x14), 0xd, true);
        }
    }
    c.r[AX] = ax;
    c.s[DS] = ds;
}

/// 19ED:3C1A (far): two small pieces of the cockpit (4 rows of 5 bytes) put back. DS kept.
pub fn gauges(c: &mut Cpu) {
    let (to, from) = cockpit(c, 0xaf10, 0x3c00);
    let a = (
        (to.0, to.1.wrapping_add(9)),
        (from.0, from.1.wrapping_add(9)),
    );
    block(c, a.0, a.1, 5, 4);
    let b = (
        (to.0, to.1.wrapping_add(0x112)),
        (from.0, from.1.wrapping_add(0x502)),
    );
    block(c, b.0, b.1, 5, 4);
    c.r[AX] = 0xffff;
    c.r[CX] = 0;
    c.r[DX] = 0x13b;
    c.r[SI] = b.1 .1.wrapping_add(4 * 0x140);
    c.r[DI] = b.0 .1.wrapping_add(4 * 0x140);
    c.s[ES] = to.0;
}
