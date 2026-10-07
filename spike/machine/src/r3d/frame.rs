//! One frame of the 3D view (gp.exe 0F47:81CE, docs/renderer-notes.md, section 1): the walk and
//! its lists, the sky, the strips' edges, then the drawing block by block (802A), and around it
//! the cars put on their segments (A533, A737), the viewed car's pit box shown red (8261, 82CC),
//! and the cockpit's parts.
//!
//! Each step below names the game's instruction it stands for.

use super::regs::*;
use super::scene::{deeper, drain, pits, rings, sort};
use super::{bitmap, blocks, ground, road, screen, shape, strips, walk};
use crate::pc::Machine;

/// The hook that stops the machine at the game's 3D routine when ours runs in its place.
pub const HOOK: u8 = 0xfe;
/// The renderer's code segment once gp.exe is loaded (0F47 in the image, at 10E9).
const CODE: u16 = 0x10e9;
/// Where the routine is.
const ENTRY: u32 = ((CODE as u32) << 4) + 0x81ce;
/// Its first bytes, to know it is there.
const PROLOGUE: [u8; 16] = [
    0x1e, 0x36, 0x8e, 0x1e, 0xf4, 0x00, 0xc7, 0x06, 0x42, 0x06, 0x44, 0x06, 0xc6, 0x06, 0x26, 0x08,
];

/// Our 3D routine in place of the game's (`on`), or the game's put back: a hook at the routine's
/// entry, once the game's code is there (Machine::run then runs `step` at it).
pub fn native(m: &mut Machine, on: bool) {
    let a = ENTRY as usize;
    if m.hw.mem.len() < a + PROLOGUE.len() {
        return;
    }
    let hooked =
        m.hw.mem[a..a + 3] == [0xfe, 0x38, HOOK] && m.hw.mem[a + 3..a + 16] == PROLOGUE[3..];
    if on {
        let r = ((crate::pc::BIOS as usize) << 4) + RESUME_AT as usize;
        m.hw.mem[r..r + 3].copy_from_slice(&[0xfe, 0x38, RESUME]);
    }
    if on && !hooked && m.hw.mem[a..a + 16] == PROLOGUE {
        m.hook(ENTRY, HOOK);
    } else if !on && hooked {
        m.unhook(ENTRY, [PROLOGUE[0], PROLOGUE[1], PROLOGUE[2]]);
    }
}

/// A routine in segment 19ED called far, as the game calls it: CS its segment while it runs.
fn far19(c: &mut Cpu, f: fn(&mut Cpu)) {
    let cs = c.s[CS];
    c.s[CS] = cs.wrapping_add(0x19ed - 0x0f47);
    f(c);
    c.s[CS] = cs;
}

/// Where the palette step returns to when our frame hands over to it: a hook in the BIOS's
/// segment, after the one call_far returns to.
pub const RESUME: u8 = 0xfd;
const RESUME_AT: u16 = crate::pc::RETURN_AT + 3;

/// How the frame's palette step runs.
#[derive(Clone, Copy, PartialEq)]
pub enum Service {
    /// handed over to the game's 19ED:008C in the running machine (Machine::run)
    Handover,
    /// run here alone (checks on caught frames, which have no palette change pending)
    Inline,
    /// left out (a frame drawn beside the game's, to compare what it draws)
    Skip,
}

/// 19ED:008C (far), which the frame calls between its steps: the palette step. While a palette
/// change is pending (SS:08DA) the driver at 8D10 (far 8D10:0000 as patched into 19ED:0098, AX
/// 7) sends the VGA its next part, in time with the display, so it runs in the machine: handed
/// over, the game's 008C called with RESUME's address to return to, true when it was. Run here
/// alone, the machine's clock stands still and the driver waits for ever (a panic).
fn service(m: &mut Machine, how: Service) -> bool {
    let ss = m.cpu.s[2];
    if how == Service::Skip || m.hw.rd16(((ss as u32) << 4) + 0x8da) == 0 {
        return false;
    }
    let seg19 = CODE.wrapping_add(0x19ed - 0x0f47);
    if how == Service::Inline {
        let at = (seg19 as u32) << 4;
        let (off, seg) = (m.hw.rd16(at + 0x99), m.hw.rd16(at + 0x9b));
        m.cpu.r[0] = 7;
        m.call_far(seg, off, 10_000_000, &mut |_, n| {
            panic!("hook {n:02x} in the driver")
        })
        .expect("the palette step returns");
        return false;
    }
    let sp = m.cpu.r[4].wrapping_sub(4);
    m.cpu.r[4] = sp;
    let a = ((ss as u32) << 4) + sp as u32;
    m.hw.wr16(a, RESUME_AT);
    m.hw.wr16(a + 2, crate::pc::BIOS);
    m.cpu.s[1] = seg19;
    m.cpu.ip = 0x008c;
    true
}

/// 81CE (far): one frame, alone, without its return (for checks on caught frames: the palette
/// step run here).
pub fn frame(m: &mut Machine) {
    step(m, 0, Service::Inline);
}

/// 81CE (far): one frame in five steps, between the four calls of the palette step: `from` 0
/// at the routine's entry (SP at the caller's return address). Returns the step to go on with
/// when it has handed over to the palette step (the machine runs it, then comes back at RESUME),
/// None when the frame is done and returned to the game.
pub fn step(m: &mut Machine, from: u8, how: Service) -> Option<u8> {
    if from != 0 {
        // back from the service's RETF: in the routine's own segment again
        m.cpu.s[1] = CODE;
    }
    let mut at = from;
    loop {
        {
            let c = &mut Cpu::of(m);
            match at {
                0 => {
                    // PUSH DS
                    let sp = c.r[SP].wrapping_sub(2);
                    c.r[SP] = sp;
                    let (ss, ds) = (c.s[SS], c.s[DS]);
                    c.set_w(ss, sp, ds);
                    c.s[DS] = c.ss(0xf4);
                    c.set_d(0x642, 0x644);
                    c.set_db(0x826, 0);
                    c.set_cb(0x73b0, 0);
                    let g = c.ss(0xf0);
                    c.s[ES] = g;
                    let v = c.w(g, 0x96f);
                    c.set_c(0x73ac, v);
                    let v = c.w(g, 0x971);
                    c.set_c(0x73ae, v);
                    c.set_bpb(0x172, 0);
                    for (o, v) in [
                        (0x10c, 0xa13e),
                        (0x110, 0x832e),
                        (0x2aa, 0xb458),
                        (0xf2, 0xa4c6),
                        (0x164, 0),
                        (0x168, 0),
                    ] {
                        c.set_d(o, v);
                    }
                    // each CALL (the walk keeps SP)
                    for f in [
                        pit_box,
                        colours,
                        wet_view,
                        blocks::mode,
                        cars_on,
                        walk::walk,
                    ] {
                        deeper(c, 2, f);
                    }
                }
                1 => {
                    deeper(c, 2, blocks::blocks);
                    deeper(c, 2, sky);
                }
                2 => deeper(c, 2, strips::strips),
                3 => deeper(c, 2, draw),
                _ => {
                    deeper(c, 2, cars_off);
                    deeper(c, 2, pit_box_off);
                    // POP DS
                    let sp = c.r[SP];
                    c.s[DS] = c.w(c.s[SS], sp);
                    c.r[SP] = sp.wrapping_add(2);
                }
            }
        }
        if at >= 4 {
            // RETF (alone, the caller returns)
            if how == Service::Handover {
                m.retf();
            }
            return None;
        }
        at += 1;
        // CALL FAR 19ED:008C
        if service(m, how) {
            return Some(at);
        }
    }
}

/// 802A: the frame drawn: the objects sorted, then block by block (R:01E8 to R:01EC) from far
/// to near, the ground up to the block's far row (unless the road is polygons) and its strips'
/// road and fences (the work area at A70Ah); the objects left; the pit lane (SS:[bp+170]);
/// the ground's texture (SS:[bp+11A6]); and in the cockpit the start lights, the gauges and the
/// pit crew's signals.
pub fn draw(c: &mut Cpu) {
    let ax = c.d(0x108);
    c.r[AX] = ax;
    if ax >= c.d(0x104) {
        return;
    }
    let bx = c.d(0x1e8);
    c.r[BX] = bx;
    if bx >= c.d(0x1ec) {
        return;
    }
    deeper(c, 2, sort);
    // 8041: PUSH DS
    c.set_bp(0x28, bx);
    c.set_bp(0x24, 0xa4c6);
    c.set_bp(0xac, 0xa4c6);
    let (mut si, mut di) = (0xa13eu16, 0x832eu16);
    c.set_bp(0x34, 0xa70a);
    c.set_bp(0x18, 0);
    rings(c);
    let bx = c.d(0x1e8);
    c.r[BX] = bx;
    let ax = c.d(0x100);
    c.r[AX] = ax;
    if ax < c.d(bx) {
        // 808A: the strips before the first block, alone
        while si != ax {
            si = si.wrapping_add(0x10);
            di = di.wrapping_add(0x78);
        }
        let v = c.d(bx);
        c.set_d(0xee, v);
        c.set_bp(0x28, bx);
        (c.r[SI], c.r[DI]) = (si, di);
        deeper(c, 4, road::road);
        deeper(c, 4, road::fences);
        c.r[BX] = c.bp(0x28);
    } else {
        // 80AE
        while si != c.d(bx) {
            si = si.wrapping_add(0x10);
            di = di.wrapping_add(0x78);
        }
        (c.r[SI], c.r[DI]) = (si, di);
    }
    loop {
        // 80BE
        let bx = c.r[BX].wrapping_add(0x12);
        c.r[BX] = bx;
        c.set_bp(0x28, bx);
        let v = c.d(bx);
        c.set_d(0xee, v);
        if c.db(0xfa) == 0 {
            let v = c.d(0x180);
            c.set_d(0x182, v);
            let mut ax = c.d(bx.wrapping_add(0x10));
            if (ax as i16) < c.d(0x136) as i16 {
                ax = c.d(0x136);
            }
            c.set_d(0x180, ax);
            c.r[CX] = c.d(0x182);
            c.r[DX] = c.d(0x180);
            c.r[AX] = ax & 0xff00 | c.bpb(0x1ae) as u16;
            far19(c, screen::sky_rows);
        }
        deeper(c, 4, road::road);
        deeper(c, 4, road::fences);
        let bx = c.bp(0x28);
        c.r[BX] = bx;
        if bx == c.d(0x1ec) {
            break;
        }
    }
    deeper(c, 4, drain);
    if (c.bp(0x170) as i16) >= 0 {
        c.r[BX] = c.bp(0x170);
        c.set_bp(0x170, 0x8000);
        deeper(c, 4, pits);
    }
    if c.bpb(0x11a6) != 0 {
        let (m, r) = c.split();
        ground::ground(m, r[BP]);
    }
    let r = c.s[DS];
    let g = c.ss(0xf0);
    c.s[DS] = g;
    let view = c.db(0x981);
    if view == 0 || view == 0xa0 {
        let al = c.db(0x2923);
        c.r[AX] = c.r[AX] & 0xff00 | al as u16;
        if al != 0 {
            far19(c, screen::start_lights);
        }
    }
    if view == 0 {
        far19(c, screen::gauges);
        let si = c.d(0x97f);
        c.r[SI] = si;
        if c.db(si.wrapping_add(0x97)) & 0x40 != 0 {
            signals(c);
        } else {
            for o in [0x2919, 0x291b, 0x291d] {
                c.set_d(o, 0x8000);
            }
        }
    }
    c.s[DS] = r;
}

/// 72BE: the sky, by bands from the horizon (SS:[bp+130], 8 rows lower with no scenery) up
/// (7271), its scenery (19ED:39ED), then the ground from the horizon down to the far road's top
/// row (R:0180) in the grass colour, or to the view's bottom when the road is polygons.
pub fn sky(c: &mut Cpu) {
    let ax = c.d(0x108);
    c.r[AX] = ax;
    if ax >= c.d(0x104) {
        return;
    }
    let bx = c.d(0x1e8);
    c.r[BX] = bx;
    if bx >= c.d(0x1ec) {
        return;
    }
    let g = c.ss(0xf0);
    c.s[ES] = g;
    if c.b(g, 0x981) == 0 {
        far19(c, screen::sides);
    }
    let mut dx = c.bp(0x130);
    let bx = c.d(0x1e8);
    c.r[BX] = bx;
    let mut ax = c.d(bx.wrapping_add(0x10));
    if (ax as i16) < c.d(0x136) as i16 {
        ax = c.d(0x136);
    }
    c.set_d(0x140, ax);
    c.r[AX] = ax;
    if c.db(0x150) == 0 {
        dx = dx.wrapping_sub(8);
    }
    if dx as i16 > c.d(0x140) as i16 {
        dx = c.d(0x140);
    }
    c.r[DX] = dx;
    bands(c);
    if c.db(0x150) == 0 {
        far19(c, screen::scenery);
    }
    c.r[BX] = c.d(0x1e8);
    let v = c.d(0x140);
    c.set_d(0x180, v);
    let grass = |c: &mut Cpu| {
        let g = c.ss(0xf0);
        c.s[ES] = g;
        let al = if c.b(g, 0x175) & 0x80 != 0 {
            c.bpb(0x1ae)
        } else {
            c.bpb(0x1af)
        };
        c.r[AX] = c.r[AX] & 0xff00 | al as u16;
    };
    if c.db(0xfa) != 0 {
        let mut ax = c.d(0x180);
        if ax as i16 > c.bp(0x130) as i16 {
            ax = c.bp(0x130);
        }
        c.r[AX] = ax;
        c.r[CX] = ax;
        c.r[DX] = 0xa4;
    } else {
        c.r[CX] = c.bp(0x130);
        c.r[DX] = c.d(0x180);
    }
    grass(c);
    far19(c, screen::sky_rows);
}

/// 7271: the sky's bands (R:0076 on: each a height and a colour) from row DX up; a colour of
/// 10h or less marks a row dithered between the colours either side (725C).
fn bands(c: &mut Cpu) {
    let mut bx = 0x76u16;
    c.r[BX] = bx;
    let mut dx = c.r[DX];
    while dx as i16 > 0 {
        let cx = dx.wrapping_sub(c.db(bx) as u16);
        let cx = (cx as i16).clamp(0, 0x66) as u16;
        c.r[CX] = cx;
        let al = c.db(bx.wrapping_add(1));
        if al <= 0x10 {
            let ah = c.db(bx.wrapping_sub(1));
            let al = c.db(bx.wrapping_add(3));
            c.r[AX] = (ah as u16) << 8 | al as u16;
            bx = bx.wrapping_add(2);
            c.r[BX] = bx;
            row(c);
        } else {
            c.r[AX] = c.r[AX] & 0xff00 | al as u16;
            bx = bx.wrapping_add(2);
            c.r[BX] = bx;
            far19(c, screen::sky_rows);
        }
        c.r[CX] = cx;
        dx = cx;
        c.r[DX] = dx;
    }
}

/// 725C: row CX filled with the word AX (two colours, alternating).
fn row(c: &mut Cpu) {
    let (es, di) = (c.d(0x1e), c.d(0x1c));
    let mut di = di.wrapping_add(c.r[CX].wrapping_mul(0x140));
    let ax = c.r[AX];
    for _ in 0..0xa0 {
        c.set_w(es, di, ax);
        di = di.wrapping_add(2);
    }
    c.s[ES] = es;
    c.r[DI] = di;
    c.r[CX] = 0;
}

/// 18E1: the grass (12h) and road (1Ah) colours hazed for the wet (SS:[bp+1AF], [bp+1AE]);
/// CS:764B set to FEh for the texture.
pub fn colours(c: &mut Cpu) {
    c.set_cb(0x764b, 0xfe);
    for (k, at) in [(0x12u8, 0x1af), (0x1a, 0x1ae)] {
        c.r[AX] = c.r[AX] & 0xff00 | k as u16;
        hazed(c);
        let al = c.r[AX] as u8;
        c.set_bpb(at, al);
    }
}

/// 18FA: colour AL hazed by the level SS:[bp+184] when wet (unless the texture is on and the
/// level is 0).
fn hazed(c: &mut Cpu) {
    if c.bp(0x122e) == 0 {
        return;
    }
    let level = c.bpb(0x184);
    if c.bpb(0x11a6) != 0 && level == 0 {
        return;
    }
    let mut bh = level.wrapping_sub(1);
    if (bh as i8) < 0 {
        return;
    }
    if bh as i8 > 3 {
        bh = 3;
    }
    // MOV AX, 7D70h for ES leaves its high byte in AH
    let seg = c.c(0x1925);
    let al = c.b(
        seg,
        ((bh as u16) << 8 | c.r[AX] & 0xff).wrapping_add(0x7bc0),
    );
    c.r[AX] = seg & 0xff00 | al as u16;
}

/// A783: SS:[bp+1B4] 1C0h when the viewed car is in the pits (+23 bit 5) and moving (|+A| at
/// least 400h), else 0.
pub fn wet_view(c: &mut Cpu) {
    let g = c.ss(0xf0);
    let si = c.w(g, 0x97f);
    c.r[SI] = si;
    if c.b(g, si.wrapping_add(0x23)) & 0x20 != 0 {
        let a = c.w(g, si.wrapping_add(0xa));
        let a = if (a as i16) < 0 { a.wrapping_neg() } else { a };
        c.r[AX] = a;
        if a as i16 >= 0x400 {
            c.set_bp(0x1b4, 0x1c0);
            return;
        }
    }
    c.set_bp(0x1b4, 0);
}

/// 0000:0845: the segment at ES:DI moved between the track's and the pit lane's arrays (their
/// overlap, as the camera is in the pits or not, G:016E).
fn other_array(c: &mut Cpu) {
    let g = c.s[DS];
    let w = |c: &Cpu, o: u16| c.w(g, o);
    let di = c.r[DI];
    let pits = c.b(g, 0x16e) & 0x80 != 0;
    let lane = c.s[ES] == w(c, 0x87a1);
    let (di, es) = match (pits, lane) {
        (true, true) => {
            if di < w(c, 0x18e) {
                (
                    di.wrapping_sub(w(c, 0x879f)).wrapping_add(w(c, 0x1d0)),
                    Some(w(c, 0x8799)),
                )
            } else if di >= w(c, 0x18a) {
                (
                    di.wrapping_sub(w(c, 0x18a)).wrapping_add(w(c, 0x8797)),
                    Some(w(c, 0x8799)),
                )
            } else {
                (di, None)
            }
        }
        (true, false) => {
            if di < w(c, 0x1cc) {
                (
                    di.wrapping_sub(w(c, 0x8797)).wrapping_add(w(c, 0x18a)),
                    Some(w(c, 0x87a1)),
                )
            } else {
                (
                    di.wrapping_sub(w(c, 0x1cc)).wrapping_add(w(c, 0x879f)),
                    Some(w(c, 0x87a1)),
                )
            }
        }
        (false, true) => {
            if di < w(c, 0x18e) {
                (
                    di.wrapping_sub(w(c, 0x879f)).wrapping_add(w(c, 0x1cc)),
                    Some(w(c, 0x8799)),
                )
            } else if di >= w(c, 0x18a) {
                (
                    di.wrapping_sub(w(c, 0x18a)).wrapping_add(w(c, 0x8797)),
                    Some(w(c, 0x8799)),
                )
            } else {
                (di, None)
            }
        }
        (false, false) => {
            if di < w(c, 0x1d0) {
                (
                    di.wrapping_sub(w(c, 0x8797)).wrapping_add(w(c, 0x18a)),
                    Some(w(c, 0x87a1)),
                )
            } else {
                (
                    di.wrapping_sub(w(c, 0x1d0)).wrapping_add(w(c, 0x879f)),
                    Some(w(c, 0x87a1)),
                )
            }
        }
    };
    c.r[DI] = di;
    if let Some(es) = es {
        c.s[ES] = es;
    }
}

/// 8261: in the pits (G:016E), the viewed car's pit box (the pit lane's segment G:[0196] + 8Ah
/// x its box +AD, 0000:5194) shown red: its fence colour codes (+24, +52) kept at G:04CC and set
/// to 1 on the side G:0256 says, G:04CE marked.
pub fn pit_box(c: &mut Cpu) {
    let ds = c.s[DS];
    let g = c.ss(0xf0);
    c.s[DS] = g;
    c.set_db(0x4ce, 0);
    if c.db(0x16e) & 0x80 != 0 {
        let si = c.d(0x97f);
        c.r[SI] = si;
        let (dx, ax) = mul(c.db(si.wrapping_add(0xad)) as u16, 0x8a);
        c.r[DX] = dx;
        c.r[AX] = ax;
        // 0000:5194
        c.r[DI] = c.d(0x196).wrapping_add(ax);
        c.s[ES] = c.d(0x198);
        if c.db(0x16e) & 0x80 != 0 {
            other_array(c);
        }
        let di = c.r[DI];
        c.set_d(0x4c8, di);
        let es = c.s[ES];
        c.set_d(0x4ca, es);
        let (mut al, mut ah) = (c.eb(di.wrapping_add(0x24)), c.eb(di.wrapping_add(0x52)));
        c.set_db(0x4cc, al);
        c.set_db(0x4cd, ah);
        if c.db(0x256) & 0x80 != 0 {
            al = al & 0xf0 | 1;
            ah = ah & 0xf0 | 1;
        } else {
            al = al & 0xf | 0x10;
            ah = ah & 0xf | 0x10;
        }
        c.set_eb(di.wrapping_add(0x24), al);
        c.set_eb(di.wrapping_add(0x52), ah);
        c.r[AX] = (ah as u16) << 8 | al as u16;
        c.set_db(0x4ce, 0x80);
    }
    c.s[DS] = ds;
}

/// 82CC: the pit box's colour codes put back.
pub fn pit_box_off(c: &mut Cpu) {
    let g = c.ss(0xf0);
    let f = c.b(g, 0x4ce);
    c.set_b(g, 0x4ce, f << 1);
    if f & 0x80 != 0 {
        let di = c.w(g, 0x4c8);
        let es = c.w(g, 0x4ca);
        c.r[DI] = di;
        c.s[ES] = es;
        for (from, to) in [(0x4cc, 0x24), (0x4cd, 0x52)] {
            let al = c.b(g, from);
            c.r[AX] = c.r[AX] & 0xff00 | al as u16;
            c.set_b(es, di.wrapping_add(to), al);
        }
    }
}

/// A533: up to 26 cars from the camera's (in the order of G:0C65, round from its place, ahead
/// or behind as the view faces; G:2225 of them) put on their segments as objects: the segment's
/// object kind 80h + the car (+66), flagged (+26, +2A, +A), listed at G:[04EA]; a segment that
/// has one already passes the car on to the next, its +84 counting how far. The camera's own
/// car only when it is seen (+9A bit 3); none out of the race (+96 bit 7).
pub fn cars_on(c: &mut Cpu) {
    let ds = c.s[DS];
    let g = c.ss(0xf0);
    let r = c.ss(0xf4);
    c.s[DS] = g;
    c.s[ES] = r;
    let al = if (c.w(r, 0x186) as i16) < 0x2000 {
        1
    } else {
        2
    };
    c.r[AX] = c.r[AX] & 0xff00 | al;
    c.set_cb(0xa736, al as u8);
    c.set_d(0x4ea, 0x7a);
    let v = c.d(0x2225);
    c.set_bp(0x1c, v);
    if v == 0 {
        c.s[DS] = ds;
        return;
    }
    let mut cx = 0x1au16;
    let si = c.d(0x97d);
    let k = c.db(si.wrapping_add(0x66)) as i8 as i16 as u16;
    let mut bx = 0xc65u16.wrapping_add(k);
    let mut ax = if (c.bp(0x136) as i16) < 0 {
        c.bp(0x1c).wrapping_sub(2) << 1
    } else {
        6
    };
    bx = bx.wrapping_add(ax);
    if bx < 0xc65 {
        bx = bx.wrapping_add(c.d(0x496));
    } else if bx >= c.d(0x49a) {
        bx = bx.wrapping_sub(c.d(0x496));
    }
    let v = c.bp(0x1c).wrapping_sub(1);
    c.set_bp(0x1c, v);
    let mut si;
    loop {
        // A5A6
        bx = bx.wrapping_sub(2);
        ax = c.d(bx);
        if (ax as i16) < 0 {
            bx = bx.wrapping_add(c.d(0x221f));
            ax = c.d(bx);
        }
        si = ax.wrapping_add(0xd1b);
        if c.db(si.wrapping_add(0x96)) & 0x80 != 0 {
            // A72B
            cx = cx.wrapping_sub(1);
            if cx == 0 {
                break;
            }
            continue;
        }
        if !(si == c.d(0x97d) && c.db(si.wrapping_add(0x9a)) & 8 == 0) {
            let al = c.b(c.s[CS], 0xa736);
            ax = ax & 0xff00 | al as u16;
            c.set_db(si.wrapping_add(0x84), al);
            (c.r[AX], c.r[BX], c.r[CX], c.r[SI]) = (ax, bx, cx, si);
            place(c);
            ax = c.r[AX];
        }
        // A71A
        cx = cx.wrapping_sub(1);
        if cx == 0 {
            break;
        }
        let v = c.bp(0x1c).wrapping_sub(1);
        c.set_bp(0x1c, v);
        if (v as i16) < 0 {
            break;
        }
    }
    (c.r[AX], c.r[BX], c.r[CX], c.r[SI]) = (ax, bx, cx, si);
    c.s[DS] = ds;
}

/// A5DD: car SI put on its segment (+12), in the track's array (G:87A1) or the pit lane's
/// (G:8799) as the view needs, then on the first segment from there without a car.
fn place(c: &mut Cpu) {
    let si = c.r[SI];
    let w = |c: &Cpu, o: u16| c.d(o);
    let mut di = c.d(si.wrapping_add(0x12));
    let mut es = c.d(si.wrapping_add(0x14));
    let track = |c: &Cpu, es: u16| es == c.d(0x87a1);
    // A688: from the pit lane's array (G:8799) into the track's (G:87A1), unless in the pits
    let other = |c: &Cpu, di: u16| -> (u16, u16) {
        if di < c.d(0x1cc) {
            (
                di.wrapping_sub(c.d(0x8797)).wrapping_add(c.d(0x18a)),
                c.d(0x87a1),
            )
        } else {
            (
                di.wrapping_sub(c.d(0x1cc)).wrapping_add(c.d(0x879f)),
                c.d(0x87a1),
            )
        }
    };
    if (c.bp(0x170) as i16) >= 0 {
        if !track(c, es) {
            if (di < w(c, 0x1a8) || di >= w(c, 0x1b4)) && c.db(0x16e) == 0 {
                (di, es) = other(c, di);
            }
        } else if c.db(0x16e) == 0 {
            // A612: a track segment where the pit lane joins it
            let kind = c.b(es, di.wrapping_add(0x26)) & 3;
            let ax = c.r[AX];
            c.r[AX] = ax & 0xff00 | kind as u16;
            let to = match kind {
                1 => {
                    let a = di.wrapping_sub(w(c, 0x18a));
                    if a >= 0x8fc {
                        None
                    } else {
                        let a = a.wrapping_add(0xd7ae);
                        if a < w(c, 0x1a8) {
                            None
                        } else if a < c.bp(0x160) || c.db(si.wrapping_add(0x19)) & 0x80 != 0 {
                            Some(a)
                        } else {
                            None
                        }
                    }
                }
                2 => {
                    let a = w(c, 0x18e).wrapping_sub(di);
                    c.r[AX] = a;
                    if a >= 0x8fc {
                        None
                    } else {
                        let a = a.wrapping_neg();
                        if (a as i16) >= 0 {
                            None
                        } else {
                            let a = a.wrapping_add(w(c, 0x182));
                            if a > w(c, 0x1b4) {
                                None
                            } else if a >= c.bp(0x164) || c.db(si.wrapping_add(0x19)) & 0x80 != 0 {
                                Some(a)
                            } else {
                                None
                            }
                        }
                    }
                }
                _ => None,
            };
            if let Some(a) = to {
                es = c.d(0x8799);
                di = a;
            }
            c.r[AX] = ax;
        }
    } else if !track(c, es) && (di < c.bp(0x160) || di >= c.bp(0x164)) && c.db(0x16e) == 0 {
        (di, es) = other(c, di);
    }
    // A6AF: on past the segments that have a car
    while c.b(es, di.wrapping_add(0x26)) & 0x80 != 0 {
        let v = c.db(si.wrapping_add(0x84)).wrapping_add(1);
        c.set_db(si.wrapping_add(0x84), v);
        if !track(c, es) {
            di = di.wrapping_add(0x2e);
            if di >= w(c, 0x182) {
                di = w(c, 0x18e);
                es = w(c, 0x190);
            }
        } else {
            let (d, carry) = di.overflowing_add(0x2e);
            di = d;
            if (carry || di >= c.bp(0x15c)) && es == c.bp(0x100) {
                di = di.wrapping_sub(c.bp(0x158));
            }
        }
    }
    // A6F0
    for (o, f) in [(0x26u16, 0xc0u8), (0x2a, 0x80), (0xa, 0x80)] {
        let v = c.b(es, di.wrapping_add(o)) | f;
        c.set_b(es, di.wrapping_add(o), v);
    }
    let al = c.db(si.wrapping_add(0x66)) | 0x80;
    c.set_b(es, di.wrapping_add(0x1e), al);
    c.r[AX] = c.r[AX] & 0xff00 | al as u16;
    let bx = c.d(0x4ea);
    c.set_d(bx, di);
    c.set_d(bx.wrapping_add(2), es);
    c.set_d(0x4ea, bx.wrapping_add(4));
    c.r[DI] = di;
    c.s[ES] = es;
}

/// A737: the cars taken off their segments again.
pub fn cars_off(c: &mut Cpu) {
    let g = c.ss(0xf0);
    let dx = c.w(g, 0x4ea);
    c.r[DX] = dx;
    let mut bx = 0x7au16;
    while bx != dx {
        let (di, es) = (c.w(g, bx), c.w(g, bx.wrapping_add(2)));
        bx = bx.wrapping_add(4);
        for (o, m) in [(0x26u16, 0x3fu8), (0x2a, 0x7f), (0xa, 0x7f), (0x2b, 0x7f)] {
            let v = c.b(es, di.wrapping_add(o)) & m;
            c.set_b(es, di.wrapping_add(o), v);
        }
        c.set_b(es, di.wrapping_add(0x1e), 0);
        c.r[DI] = di;
        c.s[ES] = es;
    }
    c.r[BX] = bx;
}

/// 0000:0509 (far): AL a pseudo-random byte from the 40-bit register G:08C3, shifted on by it.
fn random(c: &mut Cpu) {
    let a = c.d(0x8c4) >> 4;
    let b = c.d(0x8c6) >> 1;
    let al = (a as u8) ^ (b as u8);
    let (x, y) = (c.d(0x8c4), c.d(0x8c6));
    let lo = c.db(0x8c3);
    c.set_d(0x8c4, (x << 8) | lo as u16);
    c.set_d(0x8c6, (y << 8) | (x >> 8));
    c.set_db(0x8c3, al);
    c.r[AX] = a & 0xff00 | al as u16;
}

/// A sine (SS:3264) of 4000h less `a`, times `k`, its high word four times over.
fn swing(c: &Cpu, a: u16, k: u16) -> u16 {
    let s = shape::sine(c, 0x4000u16.wrapping_sub(a));
    (((s as i16 as i32 * k as i16 as i32) as u32) << 2 >> 16) as u16
}

/// A944: the pit crew's signals seen from the cockpit (the viewed car's +97 bits 3, 4 and 5:
/// boards and the lollipop, swung in and out, G:2919 to G:291D), and the jack (+67).
pub fn signals(c: &mut Cpu) {
    let si = c.r[SI];
    let f = c.db(si.wrapping_add(0x97));
    let draw = |c: &mut Cpu, id: u16, row: u16, colours: u16| {
        c.set_bp(0x12e, 0);
        (c.r[AX], c.r[CX], c.r[DX]) = (id, row, colours);
        let (m, r) = c.split();
        bitmap::bitmap(m, r[BP], id, row, colours);
    };
    if f & 8 != 0 {
        if c.d(0x291b) == 0x8000 {
            let v = c.d(0x92e);
            c.set_d(0x291b, v);
        }
        board(c);
        let ax = c.bp(0x88).wrapping_sub(0xa0);
        let p = ((ax as i16 as i32 * c.d(0x926) as i16 as i32) as u32) << 2;
        let dx = (p >> 16) as u16;
        c.set_bp(0x8c, 0x50u16.wrapping_sub(dx));
        if c.d(0x291b) == 0x40 {
            c.set_bp(0x8c, 0x50);
        }
        let cx = 0x32u16
            .wrapping_sub(dx)
            .wrapping_add(sar(c.d(si.wrapping_add(0x8c)), 2))
            .wrapping_add(sar(c.d(0x2269), 6));
        draw(c, 0xab, cx, 0x520);
    }
    if c.db(si.wrapping_add(0x97)) & 0x10 != 0 && c.d(0x2919) != 0x8000 {
        lollipop(c);
        c.set_bp(0x8c, 0x3c);
        draw(c, 0xaa, 0x32, 0x570);
    }
    if c.db(si.wrapping_add(0x97)) & 0x20 != 0 {
        let go = if c.d(0x291d) == 0x8000 {
            if c.db(si.wrapping_add(0x67)) == 4 {
                false
            } else {
                let v = c.d(0x944);
                c.set_d(0x291d, v);
                true
            }
        } else {
            true
        };
        if go {
            jack(c);
            let ax = c.bp(0x88).wrapping_sub(0xa0);
            let ax = (ax as i16 as i32 * c.d(0x93c) as i16 as i32) as u16;
            c.set_bp(0x8c, 0x200u16.wrapping_add(ax));
            if c.d(0x291d) == 0x400 {
                c.set_bp(0x8c, 0x200);
            }
            draw(c, 0xaf, 0x1b, 0x570);
        }
    }
    // AA2E
    let state = c.db(si.wrapping_add(0x67)) as i8;
    if state == 6 {
        let mut dx = c.d(0x291f).wrapping_add(c.d(0x14e));
        if dx as i16 > c.d(0x946) as i16 {
            dx = c.d(0x946);
        }
        c.r[DX] = dx;
        c.set_d(0x291f, dx);
    } else if (2..=5).contains(&state) {
        c.set_d(0x291f, 0);
    }
}

/// A7F1: the board swung by G:291B (on by G:014A; held at C0h and done at state 7, else held
/// at 40h; at state 3 in a race the car shakes, G:2269), its column SS:[bp+88].
fn board(c: &mut Cpu) {
    let si = c.r[SI];
    let mut ax = c.d(0x291b);
    let v = ax.wrapping_add(c.d(0x14a));
    c.set_d(0x291b, v);
    let state = c.db(si.wrapping_add(0x67));
    if state == 7 {
        if ax as i16 >= 0xc0 {
            ax = 0xc0;
            c.set_d(0x291b, 0x8000);
        }
    } else {
        if state == 3 && c.bpb(0x124a) & 0x80 != 0 {
            let a = ax;
            random(c);
            let v = c.d(0x2269).wrapping_add(c.r[AX] as u8 as i8 as i16 as u16);
            c.set_d(0x2269, v);
            ax = a;
        }
        if ax as i16 >= 0x40 {
            ax = 0x40;
            c.set_d(0x291b, ax);
        }
    }
    let x = swing(c, ax << 8, c.d(0x928)).wrapping_add(c.d(0x92a));
    c.set_bp(0x88, 0x140u16.wrapping_sub(x));
}

/// A870: the lollipop swung by G:2919 (on by G:0148, in from G:0932 over G:0936, out over
/// G:0938, then done), its column SS:[bp+88].
fn lollipop(c: &mut Cpu) {
    let mut ax = c.d(0x2919).wrapping_add(c.d(0x148));
    c.set_d(0x2919, ax);
    if ax as i16 >= c.d(0x932) as i16 {
        ax = ax.wrapping_sub(c.d(0x932));
        if (ax as i16) < c.d(0x936) as i16 {
            ax = swing(c, ax << 8, c.d(0x930)).wrapping_add(c.d(0x932));
        } else {
            ax = ax.wrapping_sub(c.d(0x936));
            if ax as i16 >= c.d(0x938) as i16 {
                c.set_d(0x2919, 0x8000);
            }
            ax = ax.wrapping_neg().wrapping_add(c.d(0x932));
        }
    }
    c.set_bp(0x88, 0x140u16.wrapping_sub(ax));
}

/// A8DC: the jack swung by G:291D (on by G:014C; held at 800h and done at state 4, else held at
/// 400h), its column SS:[bp+88].
fn jack(c: &mut Cpu) {
    let si = c.r[SI];
    let v = c.d(0x291d).wrapping_add(c.d(0x14c));
    c.set_d(0x291d, v);
    let mut ax = v;
    if c.db(si.wrapping_add(0x67)) == 4 {
        if ax as i16 >= 0x800 {
            ax = 0x800;
            c.set_d(0x291d, 0x8000);
        }
    } else if ax as i16 >= 0x400 {
        ax = 0x400;
        c.set_d(0x291d, ax);
    }
    let x = swing(c, ax << 4, c.d(0x93e)).wrapping_add(c.d(0x940));
    c.set_bp(0x88, 0x140u16.wrapping_sub(x));
}
