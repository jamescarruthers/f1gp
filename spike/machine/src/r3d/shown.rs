//! The game's frame as the page shows it with the 3D view drawn finer (render.html r3d=gpu,
//! spike/lib/gpu-r3d.mjs): the 3D view's primitives at the page's scale (src/r3d/fine.rs), and
//! around them the game's own screen, its cockpit, dash and messages, with a mask of the pixels
//! where the screen shows the 3D view.
//!
//! The game copies its back buffer to the screen once a frame (19ED:31FA, after the dash and the
//! messages): rows 0-179 in the outside views; in the cockpit rows 0-102, then on rows 103-163
//! the window's two openings (SS:6364: from the left limit to the left opening's end, from the
//! right one's start to the right limit) and on rows 116-137 the mirrors too (all of the row but
//! the gap between the openings). A screen pixel shows the 3D view where it lies in that copy,
//! in the rows our routine drew, and still holds what our routine left there (the messages are
//! drawn into the back buffer after it, the dash and the cockpit straight onto the screen).
//!
//! Our routine's frame is recorded as it draws (`Drawn`); the game shows it at the end of its
//! frame, so the pair is taken when the routine is called again (`shown`): the screen and the
//! palette as they are then belong to the frame recorded.

use super::fine;
use super::list::{self, List};
use crate::pc::Machine;

/// A frame our routine drew: its display list, the 3D view's rows as it left them in the back
/// buffer, and the screen row the view starts on.
pub struct Drawn {
    list: List,
    back: Vec<u8>,
    top: usize,
    cockpit: bool,
}

/// A frame as the page takes it.
#[derive(Default)]
pub struct Shown {
    /// counts the frames shown
    pub serial: u32,
    /// the primitives' scale, and the primitives (`fine::words`, four words each)
    pub scale: u32,
    pub words: Vec<u32>,
    /// the screen (palette indices, 320 x 200), and 1 where it shows the 3D view
    pub screen: Vec<u8>,
    pub mask: Vec<u8>,
    /// the palette (the DAC's 256 entries, 6 bits each of red, green and blue)
    pub dac: Vec<u8>,
    /// the screen row the 3D view starts on (16 in the outside views, 0 in the cockpit)
    pub top: u32,
}

const W: usize = list::W as usize;
const H: usize = list::H as usize;

fn lin(seg: u16, off: u16) -> usize {
    ((seg as usize) << 4) + off as usize
}
fn word(m: &Machine, a: usize) -> u16 {
    m.hw.mem[a] as u16 | (m.hw.mem[a + 1] as u16) << 8
}

/// Our routine has drawn its frame (the machine at its end), recorded as `list`.
pub fn drawn(m: &Machine, list: List) -> Drawn {
    let ss = m.cpu.s[2];
    let (r, g) = (word(m, lin(ss, 0xf4)), word(m, lin(ss, 0xf0)));
    let view = lin(word(m, lin(r, 0x1e)), word(m, lin(r, 0x1c)));
    // the copy's source, DS:04BC: the screen's row 0
    let source = lin(word(m, lin(g, 0x4be)), word(m, lin(g, 0x4bc)));
    let top = view.wrapping_sub(source) / W;
    Drawn {
        back: m.hw.mem[view..view + W * H].to_vec(),
        top: if top <= 200 - H { top } else { 0 },
        cockpit: m.hw.mem[lin(g, 0x981)] == 0,
        list,
    }
}

/// Whether the game's copy to the screen takes the pixel at (x, y) from the back buffer.
fn copied(d: &Drawn, x: usize, y: usize) -> bool {
    if !d.cockpit {
        return y < 180;
    }
    if y < 0x67 {
        return true;
    }
    if y >= 0xa4 {
        return false;
    }
    let t = |k: usize| d.list.window_at(k, y as i32) as i32;
    if t(0) == 0 {
        return false;
    }
    let x = x as i32;
    let opening = (t(3) <= x && x < t(1)) || (t(2) <= x && x < t(4));
    let mirror = (0x74..0x8a).contains(&y) && (x < t(1) || x >= t(2));
    opening || mirror
}

/// The frame our routine drew, as the game now shows it (the machine at the routine's next
/// call), with its 3D view's primitives at `scale`.
pub fn shown(m: &Machine, d: &Drawn, scale: u32, serial: u32) -> Shown {
    let vga = &m.hw.vga;
    let mut screen = vec![0u8; W * 200];
    if vga.mode == 0x13 {
        let start = vga.start();
        for (i, p) in screen.iter_mut().enumerate() {
            *p = m.hw.mem[0xa0000 + ((start + i) & 0xffff)];
        }
    }
    let mut mask = vec![0u8; W * 200];
    for y in d.top..d.top + H {
        for x in 0..W {
            let i = y * W + x;
            if copied(d, x, y) && screen[i] == d.back[(y - d.top) * W + x] {
                mask[i] = 1;
            }
        }
    }
    let p = fine::prims(&d.list, scale);
    Shown {
        serial,
        scale,
        words: fine::words(&p),
        screen,
        mask,
        dac: vga.dac.iter().flatten().copied().collect(),
        top: d.top as u32,
    }
}
