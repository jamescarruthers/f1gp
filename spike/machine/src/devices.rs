//! The PC's devices the game uses, on the machine's emulated clock (µs):
//! the 8259 interrupt controller, the 8253 timer, the keyboard controller,
//! VGA in mode 13h (registers, the DAC, the retrace bit), the game port with
//! two centred joysticks, the AdLib's status and timers, and port 61h.

use std::collections::VecDeque;

// ------------------------------------------------------------ 8259

#[derive(Default)]
pub struct Pic {
    pub irr: u8,
    pub imr: u8,
    pub isr: u8,
    pub base: u8,
    read_isr: bool,
    /// the initialisation word expected next on the data port (2, 3, 4; 0 when done)
    init_next: u8,
    single: bool,
    icw4: bool,
}

impl Pic {
    pub fn new(base: u8) -> Pic {
        Pic {
            base,
            ..Default::default()
        }
    }
    pub fn raise(&mut self, irq: u8) {
        self.irr |= 1 << irq;
    }
    /// The interrupt to take now, if any (higher priority than any in service).
    pub fn pending(&self) -> Option<u8> {
        let want = self.irr & !self.imr;
        if want == 0 {
            return None;
        }
        let irq = want.trailing_zeros() as u8;
        if self.isr != 0 && self.isr.trailing_zeros() as u8 <= irq {
            return None;
        }
        Some(irq)
    }
    pub fn ack(&mut self, irq: u8) -> u8 {
        self.irr &= !(1 << irq);
        self.isr |= 1 << irq;
        self.base + irq
    }
    pub fn read(&mut self, port: u16) -> u8 {
        if port & 1 == 0 {
            if self.read_isr {
                self.isr
            } else {
                self.irr
            }
        } else {
            self.imr
        }
    }
    pub fn write(&mut self, port: u16, v: u8) {
        if port & 1 == 0 {
            if v & 0x10 != 0 {
                // ICW1: initialisation; ICW2 (the vector base), ICW3 and ICW4 follow on the data port
                self.init_next = 2;
                self.single = v & 2 != 0;
                self.icw4 = v & 1 != 0;
                self.imr = 0;
                self.isr = 0;
                self.irr = 0;
            } else if v & 0x18 == 0 {
                // OCW2: end of interrupt
                if v & 0x20 != 0 {
                    if v & 0x40 != 0 {
                        self.isr &= !(1 << (v & 7));
                    } else if self.isr != 0 {
                        self.isr &= self.isr - 1; // the highest priority one
                    }
                }
            } else if v & 0x18 == 0x08 && v & 2 != 0 {
                // OCW3: which register a read of the command port gives
                self.read_isr = v & 1 != 0;
            }
            return;
        }
        match self.init_next {
            2 => {
                self.base = v & 0xf8;
                self.init_next = if !self.single {
                    3
                } else if self.icw4 {
                    4
                } else {
                    0
                };
            }
            3 => self.init_next = if self.icw4 { 4 } else { 0 },
            4 => self.init_next = 0,
            _ => self.imr = v,
        }
    }
}

// ------------------------------------------------------------ 8253

pub const PIT_HZ: f64 = 1_193_182.0;

#[derive(Clone, Copy)]
pub struct PitChannel {
    pub reload: u32,
    pub mode: u8,
    access: u8,
    write_lo: Option<u8>,
    read_hi_next: bool,
    latched: Option<u16>,
    /// when the count was loaded (µs)
    start: f64,
}

impl Default for PitChannel {
    fn default() -> Self {
        PitChannel {
            reload: 65536,
            mode: 3,
            access: 3,
            write_lo: None,
            read_hi_next: false,
            latched: None,
            start: 0.0,
        }
    }
}

impl PitChannel {
    fn count(&self, now: f64) -> u16 {
        let ticks = ((now - self.start) * PIT_HZ / 1e6) as u64;
        let r = self.reload as u64;
        (r - ticks % r) as u16
    }
    pub fn period_us(&self) -> f64 {
        self.reload as f64 * 1e6 / PIT_HZ
    }
}

#[derive(Default)]
pub struct Pit {
    pub ch: [PitChannel; 3],
    /// when channel 0 next raises IRQ 0 (µs)
    pub next_irq: f64,
}

impl Pit {
    pub fn new() -> Pit {
        let mut p = Pit::default();
        p.next_irq = p.ch[0].period_us();
        p
    }
    pub fn read(&mut self, port: u16, now: f64) -> u8 {
        let c = &mut self.ch[(port & 3) as usize % 3];
        let v = c.latched.unwrap_or_else(|| c.count(now));
        let out = match c.access {
            1 => v as u8,
            2 => (v >> 8) as u8,
            _ => {
                if c.read_hi_next {
                    c.read_hi_next = false;
                    c.latched = None;
                    return (v >> 8) as u8;
                }
                c.read_hi_next = true;
                return v as u8;
            }
        };
        c.latched = None;
        out
    }
    pub fn write(&mut self, port: u16, v: u8, now: f64) {
        if port & 3 == 3 {
            let n = (v >> 6) as usize;
            if n == 3 {
                return;
            }
            let c = &mut self.ch[n];
            if v & 0x30 == 0 {
                c.latched = Some(c.count(now));
                c.read_hi_next = false;
                return;
            }
            c.access = (v >> 4) & 3;
            c.mode = (v >> 1) & 7;
            c.write_lo = None;
            c.read_hi_next = false;
            return;
        }
        let n = (port & 3) as usize;
        let c = &mut self.ch[n];
        let value = match c.access {
            1 => Some(v as u32),
            2 => Some((v as u32) << 8),
            _ => match c.write_lo.take() {
                None => {
                    c.write_lo = Some(v);
                    None
                }
                Some(lo) => Some(lo as u32 | (v as u32) << 8),
            },
        };
        if let Some(r) = value {
            c.reload = if r == 0 { 65536 } else { r };
            c.start = now;
            if n == 0 {
                self.next_irq = now + c.period_us();
            }
        }
    }
}

// ------------------------------------------------------------ keyboard controller

#[derive(Default)]
pub struct Keyboard {
    pub queue: VecDeque<u8>,
    pub data: u8,
    pub full: bool,
    /// when the next byte may come (µs): the controller does not send faster
    pub next_at: f64,
}

impl Keyboard {
    pub fn push(&mut self, code: u8) {
        if self.queue.len() < 64 {
            self.queue.push_back(code);
        }
    }
}

// ------------------------------------------------------------ VGA

pub struct Vga {
    pub mode: u8,
    pub dac: [[u8; 3]; 256],
    dac_write: u16,
    dac_read: u16,
    pub seq: [u8; 8],
    seq_index: u8,
    pub gc: [u8; 16],
    gc_index: u8,
    pub crtc: [u8; 32],
    crtc_index: u8,
    attr_flip: bool,
    pub warnings: u32,
}

/// One frame at 70 Hz, and how long the vertical retrace lasts in it (µs).
pub const FRAME_US: f64 = 1e6 / 70.086;
const RETRACE_US: f64 = 45.0 * 31.78;

impl Default for Vga {
    fn default() -> Self {
        Vga {
            mode: 3,
            dac: [[0; 3]; 256],
            dac_write: 0,
            dac_read: 0,
            seq: [0; 8],
            seq_index: 0,
            gc: [0; 16],
            gc_index: 0,
            crtc: [0; 32],
            crtc_index: 0,
            attr_flip: false,
            warnings: 0,
        }
    }
}

impl Vga {
    pub fn read(&mut self, port: u16, now: f64) -> u8 {
        match port {
            0x3c5 => self.seq[(self.seq_index & 7) as usize],
            0x3c7 => 3,
            0x3c8 => (self.dac_write / 3) as u8,
            0x3c9 => {
                let i = (self.dac_read / 3) as usize & 0xff;
                let v = self.dac[i][(self.dac_read % 3) as usize];
                self.dac_read = (self.dac_read + 1) % 768;
                v
            }
            0x3cf => self.gc[(self.gc_index & 15) as usize],
            0x3d5 => self.crtc[(self.crtc_index & 31) as usize],
            0x3da => {
                self.attr_flip = false;
                let t = now % FRAME_US;
                let line_us = 31.78;
                let mut v = 0;
                if t < RETRACE_US {
                    v |= 0x08 | 0x01;
                } else if (t % line_us) > line_us * 0.8 {
                    v |= 0x01;
                }
                v
            }
            0x3cc => 0x63,
            _ => 0xff,
        }
    }
    pub fn write(&mut self, port: u16, v: u8) {
        match port {
            0x3c4 => self.seq_index = v,
            0x3c5 => {
                let i = (self.seq_index & 7) as usize;
                self.seq[i] = v;
                if i == 4 && v & 0x08 == 0 && self.mode == 0x13 {
                    self.warnings += 1; // chain-4 off: planar memory, which this machine does not have
                }
            }
            0x3c7 => self.dac_read = v as u16 * 3,
            0x3c8 => self.dac_write = v as u16 * 3,
            0x3c9 => {
                let i = (self.dac_write / 3) as usize & 0xff;
                self.dac[i][(self.dac_write % 3) as usize] = v & 0x3f;
                self.dac_write = (self.dac_write + 1) % 768;
            }
            0x3ce => self.gc_index = v,
            0x3cf => self.gc[(self.gc_index & 15) as usize] = v,
            0x3d4 => self.crtc_index = v,
            0x3d5 => self.crtc[(self.crtc_index & 31) as usize] = v,
            0x3c0 => self.attr_flip = !self.attr_flip,
            _ => {}
        }
    }
    /// The display start (CRTC 0Ch, 0Dh), in bytes of mode 13h.
    pub fn start(&self) -> usize {
        ((self.crtc[0x0c] as usize) << 8 | self.crtc[0x0d] as usize) * 4 % 0x10000
    }
}

// ------------------------------------------------------------ game port

/// Two centred two-axis joysticks (as DOSBox's "2axis" with none attached), no buttons pressed.
#[derive(Default)]
pub struct GamePort {
    fired: f64,
    /// each axis' time to discharge (µs)
    pub axis_us: [f64; 4],
    /// buttons down (bits 4-7 clear when pressed)
    pub buttons: u8,
}

impl GamePort {
    pub fn new() -> GamePort {
        GamePort {
            fired: -1e9,
            axis_us: [560.0; 4],
            buttons: 0,
        }
    }
    pub fn read(&self, now: f64) -> u8 {
        let mut v = 0xf0 & !self.buttons;
        for (i, t) in self.axis_us.iter().enumerate() {
            if now - self.fired < *t {
                v |= 1 << i;
            }
        }
        v
    }
    pub fn write(&mut self, now: f64) {
        self.fired = now;
    }
}

// ------------------------------------------------------------ AdLib

/// The OPL2's registers, status and two timers: enough for a game to find the card.
pub struct Opl {
    pub regs: [u8; 256],
    index: u8,
    t1_start: f64,
    t2_start: f64,
    t1_on: bool,
    t2_on: bool,
    flags: u8,
    /// register writes, for a synthesiser (register, value)
    pub writes: Vec<(u8, u8)>,
    pub keep_writes: bool,
}

impl Default for Opl {
    fn default() -> Self {
        Opl {
            regs: [0; 256],
            index: 0,
            t1_start: 0.0,
            t2_start: 0.0,
            t1_on: false,
            t2_on: false,
            flags: 0,
            writes: vec![],
            keep_writes: false,
        }
    }
}

impl Opl {
    pub fn status(&mut self, now: f64) -> u8 {
        if self.t1_on
            && now - self.t1_start >= (256 - self.regs[2] as u32) as f64 * 80.0
            && self.regs[4] & 0x40 == 0
        {
            self.flags |= 0x40;
        }
        if self.t2_on
            && now - self.t2_start >= (256 - self.regs[3] as u32) as f64 * 320.0
            && self.regs[4] & 0x20 == 0
        {
            self.flags |= 0x20;
        }
        let irq = if self.flags & 0x60 != 0 { 0x80 } else { 0 };
        self.flags | irq | 0x06
    }
    pub fn write(&mut self, port: u16, v: u8, now: f64) {
        if port & 1 == 0 {
            self.index = v;
            return;
        }
        let r = self.index;
        if r == 4 {
            if v & 0x80 != 0 {
                self.flags = 0;
                return;
            }
            if v & 1 != 0 && !self.t1_on {
                self.t1_start = now;
            }
            if v & 2 != 0 && !self.t2_on {
                self.t2_start = now;
            }
            self.t1_on = v & 1 != 0;
            self.t2_on = v & 2 != 0;
        }
        self.regs[r as usize] = v;
        if self.keep_writes {
            self.writes.push((r, v));
        }
    }
}
