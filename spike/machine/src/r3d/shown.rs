//! The game's frame as the page shows it with the 3D view drawn finer (render.html r3d=gpu,
//! spike/lib/gpu-r3d.mjs): the 3D view's primitives at the page's scale (src/r3d/fine.rs), and
//! around them the game's own screen, its cockpit, dash and messages, with a mask of the pixels
//! where the screen shows the 3D view.
//!
//! Our routine's frame is recorded as it draws (`Drawn`), with the 3D view's rows as it leaves
//! them in the back buffer. The game puts the back buffer on the screen once a frame, in the race
//! and in pause and the pit stop (19ED:31FA, after the dash and the messages); we take that
//! routine over (`COPY`, the port `screen::show`), so each copy marks the bytes it takes from the
//! back buffer and pairs them with the frame our routine drew last (`OnScreen`). When the page
//! takes the machine's state (the end of Machine::run), the screen and the palette as they are
//! then (the game sets some of the dash's colours after the copy) give the frame (`shown`): a
//! screen pixel shows the 3D view where the copy took it from the back buffer and it is still
//! what our routine left there.
//!
//! A limit: a pixel the game draws over the view in the back buffer (a message) in the colour
//! our routine left there is taken for the view. At scale 1 that is the same pixel; finer, the
//! view's own finer pixels show there in place of the message's square.

use super::fine;
use super::list::{self, List};
use super::regs::Cpu;
use super::screen;
use crate::pc::Machine;

/// The hook at the game's copy to the screen while the page wants the 3D view finer
/// (Machine::run runs `copy` there).
pub const COPY: u8 = 0xfc;
/// 19ED:31FA once gp.exe is loaded (19ED in the image, at 1B8F), and its first bytes.
const SEG: u16 = 0x1b8f;
const AT: u32 = ((SEG as u32) << 4) + 0x31fa;
const PROLOGUE: [u8; 8] = [0x1e, 0x06, 0x60, 0x36, 0x8e, 0x1e, 0xf0, 0x00];

/// The copy hooked (`on`) or put back, once the game's code is there.
pub fn hook(m: &mut Machine, on: bool) {
    let a = AT as usize;
    let hooked =
        m.hw.mem[a..a + 3] == [0xfe, 0x38, COPY] && m.hw.mem[a + 3..a + 8] == PROLOGUE[3..];
    if on && !hooked && m.hw.mem[a..a + 8] == PROLOGUE {
        m.hook(AT, COPY);
    } else if !on && hooked {
        m.unhook(AT, [PROLOGUE[0], PROLOGUE[1], PROLOGUE[2]]);
    }
}

/// A frame our routine drew: its display list, the 3D view's rows as it left them in the back
/// buffer, and the screen row the view starts on.
pub struct Drawn {
    list: List,
    back: Vec<u8>,
    top: usize,
}

/// The frame the game has put on the screen: what our routine drew, the bytes of A000 the copy
/// took from the back buffer (1 each), and whether it is yet to be shown.
pub struct OnScreen {
    drawn: Drawn,
    copied: Vec<u8>,
    fresh: bool,
}

/// A frame as the page takes it.
#[derive(Default)]
pub struct Shown {
    /// counts the frames shown
    pub serial: u32,
    /// the primitives' scale and how the bitmaps were drawn, and the primitives (`fine::words`,
    /// four words each)
    pub scale: u32,
    pub art: fine::Art,
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
        list,
    }
}

/// The machine stopped at `COPY`: the game's copy to the screen done by our port, and a far
/// return. The bytes it took from the back buffer, marked by their offset in A000.
pub fn copy(m: &mut Machine) -> Vec<u8> {
    let mut copied = vec![0u8; 0x10000];
    screen::show(&mut Cpu::of(m), Some(&mut copied));
    m.retf();
    copied
}

/// As `copy`, held to the game's own copy, run first on the machine as it is: whether the port
/// left the screen (A000) and SS:0138 as the game's copy does.
pub fn copy_checked(m: &mut Machine) -> (Vec<u8>, bool) {
    let flag = lin(m.cpu.s[2], 0x138);
    let before = m.snapshot();
    m.unhook(AT, [PROLOGUE[0], PROLOGUE[1], PROLOGUE[2]]);
    let ran = m.call_far(SEG, 0x31fa, 1 << 20, &mut |_, _| {});
    let want = (m.hw.mem[0xa0000..0xb0000].to_vec(), m.hw.mem[flag]);
    m.restore(&before);
    let copied = copy(m);
    let same = ran.is_ok() && m.hw.mem[0xa0000..0xb0000] == want.0[..] && m.hw.mem[flag] == want.1;
    (copied, same)
}

/// The game has copied its back buffer to the screen (`copied`): pair it with the frame our
/// routine drew last (`drawn`, taken), or keep the one already on the screen (pause, the pit
/// stop: the game copies again without drawing).
pub fn on_screen(was: Option<OnScreen>, drawn: Option<Drawn>, copied: Vec<u8>) -> Option<OnScreen> {
    match (drawn, was) {
        (Some(drawn), _) => Some(OnScreen {
            drawn,
            copied,
            fresh: true,
        }),
        (None, Some(o)) => Some(OnScreen { copied, ..o }),
        (None, None) => None,
    }
}

/// The frame on the screen as the page takes it now, with its 3D view's primitives at `scale`
/// (1 to 64) and its bitmaps drawn as `art` says (Art::Smooth with the art `smoother` keeps),
/// numbered after `last`; None if the screen, the palette, the scale and the art are as `last`
/// had them and the frame is not new. The primitives are made again only for a new frame, scale
/// or art (else taken from `last`).
pub fn shown(
    m: &Machine,
    o: &mut OnScreen,
    scale: u32,
    art: fine::Art,
    smoother: &mut fine::Smoother,
    last: &mut Shown,
) -> Option<Shown> {
    let vga = &m.hw.vga;
    let start = vga.start();
    let at = |i: usize| (start + i) & 0xffff;
    let mut screen = vec![0u8; W * 200];
    if vga.mode == 0x13 {
        for (i, p) in screen.iter_mut().enumerate() {
            *p = m.hw.mem[0xa0000 + at(i)];
        }
    }
    let dac: Vec<u8> = vga.dac.iter().flatten().copied().collect();
    let d = &o.drawn;
    let mut mask = vec![0u8; W * 200];
    for y in d.top..d.top + H {
        for x in 0..W {
            let i = y * W + x;
            if o.copied[at(i)] != 0 && screen[i] == d.back[(y - d.top) * W + x] {
                mask[i] = 1;
            }
        }
    }
    let same_frame = !o.fresh && scale == last.scale && art == last.art && d.top as u32 == last.top;
    if same_frame && screen == last.screen && mask == last.mask && dac == last.dac {
        return None;
    }
    let words = if same_frame {
        std::mem::take(&mut last.words)
    } else {
        let sm = (art == fine::Art::Smooth).then_some(smoother);
        fine::words(&fine::prims_with(&d.list, scale, sm))
    };
    o.fresh = false;
    Some(Shown {
        serial: last.serial.wrapping_add(1),
        scale,
        art,
        words,
        screen,
        mask,
        dac,
        top: d.top as u32,
    })
}
