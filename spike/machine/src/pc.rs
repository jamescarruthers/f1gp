//! The PC: memory, the devices on the emulated clock, the BIOS (a few code
//! stubs in ROM for the timer, the keyboard and the wait in INT 16h; the rest
//! served in Rust through the CPU's FE 38 nn callbacks), and the run loop.
//!
//! Time is the emulated clock, in µs: each instruction takes 1 / cycles_per_ms
//! ms (as DOSBox's "cycles"), a HLT skips to the next interrupt, and the timer
//! raises IRQ 0 at its programmed rate on that clock. So a run is the same
//! every time for the same inputs.

use crate::cpu::{self, Bus, Cpu, Event, CF, ZF};
use crate::devices::*;
use crate::dos::Dos;
use crate::ems::Ems;
use std::collections::BTreeSet;

/// 1 MB and the HMA (only 1 MB is reachable: A20 is off, as on an 8086).
pub const RAM: usize = 0x11_0000;
pub const BIOS: u16 = 0xf000;
/// where each served interrupt's stub sits in the BIOS segment (FE 38 nn, IRET)
const STUBS: u16 = 0xe000;
const INT8_AT: u16 = 0xf000;
const INT9_AT: u16 = 0xf100;
const INT16_AT: u16 = 0xf200;
const IRQ_EOI_AT: u16 = 0xf300;
const IRET_AT: u16 = 0xff53;
/// The return address `Machine::call_far` leaves on the stack: a stub that ends the call.
pub const RETURN_AT: u16 = 0xf400;

/// Callbacks (FE 38 nn) from this number up are hooks (`Machine::hook`): they stop the machine
/// so that its owner can look at the state, or do a routine's work in Rust.
pub const HOOKS: u8 = 0xc0;
/// The hook at RETURN_AT.
const RETURN_HOOK: u8 = 0xff;

/// The interrupts served in Rust.
const SERVED: [u8; 15] = [
    0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x17, 0x1a, 0x20, 0x21, 0x2f, 0x33, 0x67, 0x05, 0x19,
];

pub struct Hw {
    pub mem: Vec<u8>,
    /// the emulated clock (µs)
    pub now: f64,
    pub pic: Pic,
    pub pic2: Pic,
    pub pit: Pit,
    pub kbd: Keyboard,
    pub vga: Vga,
    pub game_port: GamePort,
    pub opl: Opl,
    pub port61: u8,
    /// counters, for development: keyboard IRQs raised, port 60h reads, IRQs taken by number
    pub stats: [u64; 4],
    pub irq_taken: [u64; 16],
    pub log: String,
    unknown_ports: BTreeSet<u16>,
}

impl Hw {
    fn note(&mut self, s: String) {
        if self.log.len() < 1 << 16 {
            self.log.push_str(&s);
            self.log.push('\n');
        }
    }
    #[inline]
    pub fn rd16(&self, a: u32) -> u16 {
        self.mem[a as usize] as u16 | (self.mem[(a + 1) as usize] as u16) << 8
    }
    #[inline]
    pub fn wr16(&mut self, a: u32, v: u16) {
        self.mem[a as usize] = v as u8;
        self.mem[(a + 1) as usize] = (v >> 8) as u8;
    }
}

impl Bus for Hw {
    #[inline(always)]
    fn irq_pending(&mut self) -> bool {
        self.pic.pending().is_some()
    }
    #[inline(always)]
    fn rd8(&mut self, a: u32) -> u8 {
        self.mem[a as usize]
    }
    #[inline(always)]
    fn wr8(&mut self, a: u32, v: u8) {
        if a < 0xf0000 {
            self.mem[a as usize] = v;
        }
    }
    fn io_in8(&mut self, port: u16) -> u8 {
        let now = self.now;
        match port {
            0x20 | 0x21 => self.pic.read(port),
            0xa0 | 0xa1 => self.pic2.read(port),
            0x40..=0x42 => self.pit.read(port, now),
            0x43 => 0xff,
            0x60 => {
                self.stats[1] += 1;
                self.kbd.full = false;
                self.kbd.data
            }
            0x61 => {
                // bit 4 toggles with the memory refresh (15 µs), bit 5 is the timer's channel 2
                let refresh = ((now / 15.0) as u64 & 1) as u8;
                (self.port61 & 0x0f) | refresh << 4 | ((now / 500.0) as u64 & 1) as u8 * 0x20
            }
            0x64 => 0x14 | self.kbd.full as u8,
            0x201 => self.game_port.read(now),
            0x388 => self.opl.status(now),
            0x389 => 0xff,
            0x3c0..=0x3df => self.vga.read(port, now),
            _ => {
                if self.unknown_ports.insert(port) {
                    self.note(format!("in {:04x}", port));
                }
                0xff
            }
        }
    }
    fn io_out8(&mut self, port: u16, v: u8) {
        let now = self.now;
        match port {
            0x20 | 0x21 => self.pic.write(port, v),
            0xa0 | 0xa1 => self.pic2.write(port, v),
            0x40..=0x43 => {
                self.pit.write(port, v, now);
            }
            0x61 => self.port61 = v,
            0x201 => self.game_port.write(now),
            0x388 | 0x389 => self.opl.write(port, v, now),
            0x3c0..=0x3df => self.vga.write(port, v),
            0x80..=0x8f | 0x00..=0x0f | 0xc0..=0xdf => {} // DMA
            _ => {
                if self.unknown_ports.insert(port) {
                    self.note(format!("out {:04x} {:02x}", port, v));
                }
            }
        }
    }
}

pub struct Machine {
    pub cpu: Cpu,
    pub hw: Hw,
    pub dos: Dos,
    pub ems: Ems,
    pub cycles_per_ms: f64,
    pub exited: Option<u8>,
    /// the screen as RGBA, 320 x 200 (render())
    pub frame: Vec<u8>,
    /// the hook the CPU reached (`run_until` stops there)
    hit: Option<u8>,
    /// the game's 3D routine replaced by ours (src/r3d/frame.rs) in `run`
    native_3d: bool,
    /// our frame's step to go on with when the palette step it handed over to returns
    native_next: Option<u8>,
    /// the frames our 3D routine has drawn
    pub native_frames: u64,
    /// with our routine, the 3D view drawn finer for the page (src/r3d/shown.rs): the scale (0
    /// off), the frame being recorded, the last frame drawn (until the game copies it to the
    /// screen), the frame on the screen, whether the game has copied since the page last took
    /// a frame, and the last frame the page took
    r3d_scale: u32,
    r3d_cars: crate::r3d::list::Cars,
    r3d_art: crate::r3d::fine::Art,
    r3d_recording: bool,
    r3d_drawn: Option<crate::r3d::shown::Drawn>,
    r3d_on_screen: Option<crate::r3d::shown::OnScreen>,
    r3d_copied: bool,
    pub r3d_shown: crate::r3d::shown::Shown,
    /// for tests: each copy to the screen done by the game's code first, and our port held to
    /// it (the copies checked, and those that differ)
    pub r3d_copy_check: Option<(u32, u32)>,
}

/// The CPU's registers and the memory: a point to come back to (`Machine::restore`), or to save.
#[derive(Clone)]
pub struct Snapshot {
    pub cpu: Cpu,
    pub mem: Vec<u8>,
}

impl Snapshot {
    /// As bytes: "F1S1", AX..DI, ES CS SS DS, IP, FLAGS (16 bits each, little-endian), then the memory.
    pub fn to_bytes(&self) -> Vec<u8> {
        let c = &self.cpu;
        let mut b = b"F1S1".to_vec();
        for v in c.r.iter().chain(c.s.iter()).chain([c.ip, c.flags].iter()) {
            b.extend_from_slice(&v.to_le_bytes());
        }
        b.extend_from_slice(&self.mem);
        b
    }
    pub fn from_bytes(b: &[u8]) -> Result<Snapshot, String> {
        if b.len() != 4 + 28 + RAM || &b[..4] != b"F1S1" {
            return Err("not a snapshot".into());
        }
        let w = |i: usize| u16::from_le_bytes([b[4 + 2 * i], b[5 + 2 * i]]);
        let mut cpu = Cpu::new();
        for i in 0..8 {
            cpu.r[i] = w(i);
        }
        for i in 0..4 {
            cpu.s[i] = w(8 + i);
        }
        cpu.ip = w(12);
        cpu.load_flags(w(13));
        Ok(Snapshot {
            cpu,
            mem: b[32..].to_vec(),
        })
    }
}

impl Default for Machine {
    fn default() -> Self {
        Machine::new()
    }
}

#[inline]
fn lin(seg: u16, off: u16) -> u32 {
    ((seg as u32) << 4) + off as u32
}

impl Machine {
    pub fn new() -> Machine {
        let mut m = Machine {
            cpu: Cpu::new(),
            hw: Hw {
                mem: vec![0; RAM],
                now: 0.0,
                pic: Pic::new(0x08),
                pic2: Pic::new(0x70),
                pit: Pit::new(),
                kbd: Keyboard::default(),
                vga: Vga::default(),
                game_port: GamePort::new(),
                opl: Opl::default(),
                port61: 0,
                stats: [0; 4],
                irq_taken: [0; 16],
                log: String::new(),
                unknown_ports: BTreeSet::new(),
            },
            dos: Dos::new(),
            ems: Ems::new(256),
            cycles_per_ms: 20000.0,
            exited: None,
            frame: vec![0; 320 * 200 * 4],
            hit: None,
            native_3d: false,
            native_next: None,
            native_frames: 0,
            r3d_scale: 0,
            r3d_cars: crate::r3d::list::Cars::Scale,
            r3d_art: crate::r3d::fine::Art::Pixels,
            r3d_recording: false,
            r3d_drawn: None,
            r3d_on_screen: None,
            r3d_copied: false,
            r3d_shown: Default::default(),
            r3d_copy_check: None,
        };
        m.bios_init();
        m
    }

    fn put(&mut self, seg: u16, off: u16, bytes: &[u8]) {
        let a = lin(seg, off) as usize;
        self.hw.mem[a..a + bytes.len()].copy_from_slice(bytes);
    }
    fn set_vector(&mut self, n: u8, seg: u16, off: u16) {
        let a = n as u32 * 4;
        self.hw.wr16(a, off);
        self.hw.wr16(a + 2, seg);
    }

    fn bios_init(&mut self) {
        // every vector to an IRET; the hardware interrupts' to an IRET that ends the interrupt
        self.put(BIOS, IRET_AT, &[0xcf]);
        self.put(
            BIOS,
            IRQ_EOI_AT,
            &[0x50, 0xb0, 0x20, 0xe6, 0x20, 0x58, 0xcf],
        );
        for n in 0..=255u8 {
            let at = if (0x08..=0x0f).contains(&n) {
                IRQ_EOI_AT
            } else {
                IRET_AT
            };
            self.set_vector(n, BIOS, at);
        }
        for &n in SERVED.iter() {
            let at = STUBS + n as u16 * 4;
            self.put(BIOS, at, &[0xfe, 0x38, n, 0xcf]);
            self.set_vector(n, BIOS, at);
        }
        // INT 8: the tick count (served), INT 1Ch, end of interrupt
        self.put(
            BIOS,
            INT8_AT,
            &[
                0xfe, 0x38, 0x08, 0xcd, 0x1c, 0x50, 0xb0, 0x20, 0xe6, 0x20, 0x58, 0xcf,
            ],
        );
        self.set_vector(0x08, BIOS, INT8_AT);
        // INT 9: read the key from port 60h; INT 15h AH=4Fh with it, as an AT's BIOS does (the game hooks
        // that to see every key); unless that clears CF, into the BIOS's buffer (served); end of interrupt
        self.put(
            BIOS,
            INT9_AT,
            &[
                0x50, 0xe4, 0x60, 0xb4, 0x4f, 0xf9, 0xcd, 0x15, 0x73, 0x03, 0xfe, 0x38, 0x09, 0xb0,
                0x20, 0xe6, 0x20, 0x58, 0xcf,
            ],
        );
        self.set_vector(0x09, BIOS, INT9_AT);
        // INT 16h: served; a wait for a key loops on STI, HLT until one comes
        self.put(
            BIOS,
            INT16_AT,
            &[0xfb, 0xfe, 0x38, 0x16, 0x75, 0x03, 0xf4, 0xeb, 0xf7, 0xcf],
        );
        self.set_vector(0x16, BIOS, INT16_AT);
        self.put(BIOS, RETURN_AT, &[0xfe, 0x38, RETURN_HOOK]);
        // the BIOS date (lib/f1gp-mem.mjs finds guest RAM by it) and the model byte (AT)
        self.put(BIOS, 0xfff5, b"01/01/92");
        self.put(BIOS, 0xfffe, &[0xfc]);
        // the BIOS data area
        let bda = |o: u16| lin(0x40, o);
        self.hw.wr16(bda(0x10), 0x0061); // equipment: floppy, 80x25 colour
        self.hw.wr16(bda(0x13), 640);
        self.hw.wr16(bda(0x1a), 0x1e);
        self.hw.wr16(bda(0x1c), 0x1e);
        self.hw.wr16(bda(0x80), 0x1e);
        self.hw.wr16(bda(0x82), 0x3e);
        self.hw.mem[bda(0x49) as usize] = 3;
        self.hw.wr16(bda(0x4a), 80);
        self.hw.wr16(bda(0x63), 0x3d4);
        self.hw.mem[bda(0x84) as usize] = 24;
        self.hw.wr16(bda(0x8b), 0);
    }

    /// Add a file to drive C (a name such as "GP.EXE" or "GPSAVES\\A.SAV").
    pub fn add_file(&mut self, name: &str, data: Vec<u8>) {
        self.dos.add_file(name, data);
    }

    /// Load a program from drive C and point the CPU at it, as COMMAND.COM would.
    pub fn start(&mut self, program: &str, tail: &str) -> Result<(), String> {
        self.dos
            .load_exe(&mut self.cpu, &mut self.hw, program, tail)
    }

    /// A key as the keyboard sends it (scan code set 1; E0-prefixed keys as two bytes).
    pub fn key_byte(&mut self, b: u8) {
        self.hw.kbd.push(b);
    }

    /// Run for `ms` of emulated time (the 3D view drawn by our routine, if set_native_3d).
    pub fn run(&mut self, ms: f64) {
        let target = self.hw.now + ms * 1000.0;
        loop {
            if self.native_3d {
                crate::r3d::frame::native(self, true);
            }
            crate::r3d::shown::hook(self, self.native_3d && self.r3d_scale > 0);
            match self.run_until(target) {
                Some(crate::r3d::frame::HOOK) if self.native_3d => {
                    self.native_frames += 1;
                    self.r3d_begin();
                    self.native_next =
                        crate::r3d::frame::step(self, 0, crate::r3d::frame::Service::Handover);
                    self.r3d_end();
                }
                Some(crate::r3d::frame::RESUME) if self.native_next.is_some() => {
                    let from = self.native_next.take().unwrap();
                    self.native_next =
                        crate::r3d::frame::step(self, from, crate::r3d::frame::Service::Handover);
                    self.r3d_end();
                }
                Some(crate::r3d::shown::COPY) => self.r3d_copy(),
                _ => break,
            }
        }
        self.r3d_take();
    }

    /// Our routine is called: record its frame, if the page wants it finer.
    fn r3d_begin(&mut self) {
        self.r3d_recording = self.r3d_scale > 0;
        if self.r3d_recording {
            crate::r3d::list::begin(self, self.r3d_scale, self.r3d_cars);
        }
    }

    /// Our routine's frame is drawn (it has handed over for the last time): keep its record
    /// until the game copies it to the screen.
    fn r3d_end(&mut self) {
        if self.r3d_recording && self.native_next.is_none() {
            self.r3d_recording = false;
            if let Some(l) = crate::r3d::list::end() {
                self.r3d_drawn = Some(crate::r3d::shown::drawn(self, l));
            }
        }
    }

    /// The 3D view drawn finer for the page at `scale` (1 to 8; 0 stops it), with our routine
    /// (set_native_3d): each frame the game shows is then in `r3d_shown` when `run` returns.
    pub fn set_r3d_scale(&mut self, scale: u32) {
        let scale = scale.min(8);
        if scale == self.r3d_scale {
            return;
        }
        self.r3d_scale = scale;
        if scale == 0 {
            // (in the middle of a frame too: the recording dropped)
            if self.r3d_recording {
                self.r3d_recording = false;
                crate::r3d::list::end();
            }
            self.r3d_drawn = None;
            self.r3d_on_screen = None;
        } else {
            // the frame on the screen again at the new scale
            self.r3d_copied = self.r3d_on_screen.is_some();
        }
        crate::r3d::shown::hook(self, self.native_3d && scale > 0);
    }

    /// How far the cars keep their polygon model while the 3D view is drawn finer (from the
    /// next frame our routine draws).
    pub fn set_r3d_cars(&mut self, cars: crate::r3d::list::Cars) {
        self.r3d_cars = cars;
    }

    /// The bitmaps drawn larger than their art smoothed, or as their pixels (fine::Art).
    pub fn set_r3d_smooth(&mut self, on: bool) {
        let art = if on {
            crate::r3d::fine::Art::Smooth
        } else {
            crate::r3d::fine::Art::Pixels
        };
        if art != self.r3d_art {
            self.r3d_art = art;
            // the frame on the screen again, drawn the new way
            self.r3d_copied = self.r3d_on_screen.is_some();
        }
    }

    /// The machine stopped at the game's copy to the screen (r3d::shown::COPY): the copy done,
    /// paired with the frame our routine drew last.
    fn r3d_copy(&mut self) {
        let copied = match self.r3d_copy_check {
            Some((n, differ)) => {
                let (copied, same) = crate::r3d::shown::copy_checked(self);
                self.r3d_copy_check = Some((n + 1, differ + !same as u32));
                copied
            }
            None => crate::r3d::shown::copy(self),
        };
        if self.r3d_scale > 0 {
            self.r3d_on_screen = crate::r3d::shown::on_screen(
                self.r3d_on_screen.take(),
                self.r3d_drawn.take(),
                copied,
            );
            self.r3d_copied = true;
        }
    }

    /// The page takes the machine's state: if the game has copied a frame to the screen since,
    /// the frame as it shows now, in `r3d_shown`.
    fn r3d_take(&mut self) {
        if !self.r3d_copied || self.r3d_scale == 0 {
            return;
        }
        self.r3d_copied = false;
        if let Some(mut o) = self.r3d_on_screen.take() {
            let mut last = std::mem::take(&mut self.r3d_shown);
            let s = crate::r3d::shown::shown(self, &mut o, self.r3d_scale, self.r3d_art, &mut last);
            self.r3d_shown = s.unwrap_or(last);
            self.r3d_on_screen = Some(o);
        }
    }

    /// Draw the game's 3D view with our routine (src/r3d/), or with the game's own code.
    pub fn set_native_3d(&mut self, on: bool) {
        if on != self.native_3d {
            // the screen no longer (or not yet) holds our routine's frames
            self.r3d_drawn = None;
            self.r3d_on_screen = None;
        }
        self.native_3d = on;
        crate::r3d::frame::native(self, on);
        crate::r3d::shown::hook(self, on && self.r3d_scale > 0);
    }

    /// Run to the emulated time `target` (µs), or until the CPU reaches a hook: then the hook's
    /// number, with IP just past its three bytes (put the bytes back, move IP back three and run
    /// on; or do the routine's work and `retf`).
    pub fn run_until(&mut self, target: f64) -> Option<u8> {
        let per_us = self.cycles_per_ms / 1000.0;
        while self.hw.now < target && self.exited.is_none() && self.hit.is_none() {
            self.update_devices();
            let mut next = target.min(self.hw.pit.next_irq);
            if !self.hw.kbd.queue.is_empty() && !self.hw.kbd.full {
                next = next.min(self.hw.kbd.next_at.max(self.hw.now + 1.0));
            }
            let budget = (((next - self.hw.now) * per_us).ceil() as u64).max(1);
            let start = self.cpu.count;
            let mut idle = false;
            while self.cpu.count - start < budget {
                if self.cpu.flags & cpu::IF != 0 && !self.cpu.irq_inhibit {
                    if let Some(irq) = self.hw.pic.pending() {
                        let v = self.hw.pic.ack(irq);
                        self.hw.irq_taken[irq as usize] += 1;
                        self.cpu.interrupt(&mut self.hw, v);
                    }
                }
                if self.cpu.halted {
                    idle = true;
                    break;
                }
                match self.cpu.run(&mut self.hw, start + budget) {
                    Event::Ok => {}
                    Event::Halt => {
                        idle = true;
                        break;
                    }
                    Event::Callback(n) if n >= HOOKS => {
                        // the hook's own bytes are not the game's: not counted, so that a run with
                        // hooks keeps the same clock as one without
                        self.cpu.count -= 1;
                        self.hit = Some(n);
                        break;
                    }
                    Event::Callback(n) => {
                        self.service(n);
                        if self.exited.is_some() {
                            break;
                        }
                    }
                }
            }
            let ran = (self.cpu.count - start) as f64 / per_us;
            self.hw.now = if idle {
                next.max(self.hw.now + ran)
            } else {
                self.hw.now + ran
            };
        }
        self.update_devices();
        self.hit.take()
    }

    /// Put hook `n` (HOOKS up to FEh) at a linear address: the bytes FE 38 n, which stop the
    /// machine when the CPU reaches them. Returns the three bytes they replace.
    pub fn hook(&mut self, at: u32, n: u8) -> [u8; 3] {
        let a = at as usize;
        let old = [self.hw.mem[a], self.hw.mem[a + 1], self.hw.mem[a + 2]];
        self.hw.mem[a..a + 3].copy_from_slice(&[0xfe, 0x38, n]);
        old
    }
    /// Put back the bytes a hook replaced.
    pub fn unhook(&mut self, at: u32, old: [u8; 3]) {
        let a = at as usize;
        self.hw.mem[a..a + 3].copy_from_slice(&old);
    }

    /// Return from a far call, as RETF does: after doing a hooked routine's work in Rust.
    pub fn retf(&mut self) {
        let a = lin(self.cpu.s[cpu::SS as usize], self.cpu.r[cpu::SP]);
        self.cpu.ip = self.hw.rd16(a);
        self.cpu.s[cpu::CS as usize] = self.hw.rd16(a + 2);
        self.cpu.r[cpu::SP] = self.cpu.r[cpu::SP].wrapping_add(4);
    }

    /// Return from a near call, as RET does.
    pub fn ret(&mut self) {
        let a = lin(self.cpu.s[cpu::SS as usize], self.cpu.r[cpu::SP]);
        self.cpu.ip = self.hw.rd16(a);
        self.cpu.r[cpu::SP] = self.cpu.r[cpu::SP].wrapping_add(2);
    }

    /// Run the routine at cs:ip as a far call, alone: interrupts masked at the controllers and
    /// the clock still, until it returns (the instructions it took), runs `limit` instructions
    /// (an error), or halts. BIOS and DOS services work as usual; a hook calls `on_hook` with
    /// the machine stopped just past it.
    pub fn call_far(
        &mut self,
        cs: u16,
        ip: u16,
        limit: u64,
        on_hook: &mut dyn FnMut(&mut Machine, u8),
    ) -> Result<u64, String> {
        let sp = self.cpu.r[cpu::SP].wrapping_sub(4);
        self.cpu.r[cpu::SP] = sp;
        let a = lin(self.cpu.s[cpu::SS as usize], sp);
        self.hw.wr16(a, RETURN_AT);
        self.hw.wr16(a + 2, BIOS);
        self.cpu.s[cpu::CS as usize] = cs;
        self.cpu.ip = ip;
        self.cpu.halted = false;
        let masks = (self.hw.pic.imr, self.hw.pic2.imr);
        self.hw.pic.imr = 0xff;
        self.hw.pic2.imr = 0xff;
        let start = self.cpu.count;
        let r = loop {
            if self.cpu.count - start >= limit {
                break Err(format!(
                    "no return after {} instructions (at {:04x}:{:04x})",
                    limit,
                    self.cpu.s[cpu::CS as usize],
                    self.cpu.ip
                ));
            }
            match self.cpu.run(&mut self.hw, start + limit) {
                Event::Ok => {}
                Event::Halt => {
                    break Err(format!(
                        "HLT at {:04x}:{:04x}",
                        self.cpu.s[cpu::CS as usize],
                        self.cpu.ip
                    ))
                }
                // the stub's and the hooks' own bytes are not counted (as in run_until)
                Event::Callback(RETURN_HOOK) => {
                    self.cpu.count -= 1;
                    break Ok(self.cpu.count - start);
                }
                Event::Callback(n) if n >= HOOKS => {
                    self.cpu.count -= 1;
                    on_hook(self, n)
                }
                Event::Callback(n) => self.service(n),
            }
        };
        (self.hw.pic.imr, self.hw.pic2.imr) = masks;
        r
    }

    /// The CPU and memory as they are now.
    pub fn snapshot(&self) -> Snapshot {
        Snapshot {
            cpu: self.cpu.clone(),
            mem: self.hw.mem.clone(),
        }
    }
    /// Back to a snapshot's CPU and memory (the devices stay as they are).
    pub fn restore(&mut self, s: &Snapshot) {
        self.cpu = s.cpu.clone();
        self.hw.mem.copy_from_slice(&s.mem);
    }

    fn update_devices(&mut self) {
        let now = self.hw.now;
        // the timer: one IRQ 0 per period (if far behind, as many as the game would have seen, up to a few)
        let mut n = 0;
        while self.hw.pit.next_irq <= now {
            if n < 4 {
                self.hw.pic.raise(0);
            }
            n += 1;
            self.hw.pit.next_irq += self.hw.pit.ch[0].period_us();
        }
        // the keyboard: the next byte once the last has been read and its interrupt ended
        let k = &mut self.hw.kbd;
        if !k.full && now >= k.next_at && self.hw.pic.isr & 2 == 0 {
            if let Some(b) = k.queue.pop_front() {
                k.data = b;
                k.full = true;
                k.next_at = now + 1000.0;
                self.hw.stats[0] += 1;
                self.hw.pic.raise(1);
            }
        }
    }

    // ------------------------------------------------------------ served interrupts

    /// Set or clear a flag in the FLAGS the interrupt pushed (so the caller's IRET returns it).
    pub fn set_caller_flag(&mut self, f: u16, on: bool) {
        let a = self.cpu.lin(cpu::SS, self.cpu.r[cpu::SP].wrapping_add(4));
        let v = self.hw.rd16(a);
        self.hw.wr16(a, if on { v | f } else { v & !f });
    }

    fn service(&mut self, n: u8) {
        match n {
            0x08 => {
                let a = lin(0x40, 0x6c);
                let t =
                    (self.hw.rd16(a) as u32 | (self.hw.rd16(a + 2) as u32) << 16).wrapping_add(1);
                let t = if t >= 0x1800b0 {
                    self.hw.mem[lin(0x40, 0x70) as usize] = 1;
                    0
                } else {
                    t
                };
                self.hw.wr16(a, t as u16);
                self.hw.wr16(a + 2, (t >> 16) as u16);
            }
            0x09 => self.bios_key(self.cpu.r[cpu::AX] as u8),
            0x10 => self.int10(),
            0x11 => self.cpu.r[cpu::AX] = self.hw.rd16(lin(0x40, 0x10)),
            0x12 => self.cpu.r[cpu::AX] = 640,
            0x13 => {
                self.cpu.r[cpu::AX] = 0x0100;
                self.set_caller_flag(CF, true);
            }
            0x14 => self.cpu.r[cpu::AX] = 0x8000, // serial: time out
            0x15 => {
                let ah = (self.cpu.r[cpu::AX] >> 8) as u8;
                match ah {
                    0x88 => {
                        self.cpu.r[cpu::AX] = 0;
                        self.set_caller_flag(CF, false);
                    }
                    0x4f => self.set_caller_flag(CF, true),
                    _ => {
                        self.cpu.r[cpu::AX] = (self.cpu.r[cpu::AX] & 0x00ff) | 0x8600;
                        self.set_caller_flag(CF, true);
                    }
                }
            }
            0x16 => self.int16(),
            0x17 => self.cpu.r[cpu::AX] = (self.cpu.r[cpu::AX] & 0x00ff) | 0x3000,
            0x1a => self.int1a(),
            0x20 => self.exited = Some(0),
            0x21 => {
                if let Some(code) = self.dos.int21(&mut self.cpu, &mut self.hw) {
                    self.exited = Some(code);
                }
            }
            0x2f => {
                if self.cpu.r[cpu::AX] == 0x4300 {
                    self.cpu.r[cpu::AX] &= 0xff00; // no XMS
                }
            }
            0x33 => {
                if self.cpu.r[cpu::AX] == 0 {
                    self.cpu.r[cpu::AX] = 0; // no mouse
                    self.cpu.r[cpu::BX] = 0;
                }
            }
            0x67 => self.ems.int67(&mut self.cpu, &mut self.hw),
            _ => {}
        }
    }

    fn bios_key(&mut self, scan: u8) {
        // the shift state, and the key into the buffer (set 1, with E0 prefixes)
        let st = lin(0x40, 0x17);
        let e0 = self.hw.mem[lin(0x40, 0x96) as usize] & 2 != 0;
        if scan == 0xe0 {
            self.hw.mem[lin(0x40, 0x96) as usize] |= 2;
            return;
        }
        self.hw.mem[lin(0x40, 0x96) as usize] &= !2;
        let code = scan & 0x7f;
        let up = scan & 0x80 != 0;
        let bit = match code {
            0x2a => 0x02,
            0x36 => 0x01,
            0x1d => 0x04,
            0x38 => 0x08,
            _ => 0,
        };
        if bit != 0 {
            if up {
                self.hw.mem[st as usize] &= !bit
            } else {
                self.hw.mem[st as usize] |= bit
            }
            return;
        }
        if up {
            return;
        }
        let shift = self.hw.mem[st as usize] & 3 != 0;
        let ascii = if e0 { 0xe0 } else { scan_ascii(code, shift) };
        let word = (code as u16) << 8 | ascii as u16;
        let (head, tail) = (self.hw.rd16(lin(0x40, 0x1a)), self.hw.rd16(lin(0x40, 0x1c)));
        let next = if tail + 2 >= 0x3e { 0x1e } else { tail + 2 };
        if next != head {
            self.hw.wr16(lin(0x40, tail), word);
            self.hw.wr16(lin(0x40, 0x1c), next);
        }
    }

    fn int16(&mut self) {
        let ah = (self.cpu.r[cpu::AX] >> 8) as u8;
        let (head, tail) = (self.hw.rd16(lin(0x40, 0x1a)), self.hw.rd16(lin(0x40, 0x1c)));
        let empty = head == tail;
        // ZF here: 1 = wait (the stub halts and asks again); 0 = return to the caller
        match ah {
            0x00 | 0x10 => {
                if empty {
                    self.cpu.flags |= ZF;
                    return;
                }
                self.cpu.r[cpu::AX] = Self::key_word(self.hw.rd16(lin(0x40, head)), ah);
                let next = if head + 2 >= 0x3e { 0x1e } else { head + 2 };
                self.hw.wr16(lin(0x40, 0x1a), next);
            }
            0x01 | 0x11 => {
                if !empty {
                    self.cpu.r[cpu::AX] = Self::key_word(self.hw.rd16(lin(0x40, head)), ah);
                }
                self.set_caller_flag(ZF, empty);
            }
            0x02 | 0x12 => {
                let v = self.hw.mem[lin(0x40, 0x17) as usize];
                self.cpu.r[cpu::AX] = (self.cpu.r[cpu::AX] & 0xff00) | v as u16;
            }
            _ => {}
        }
        self.cpu.flags &= !ZF;
    }

    /// A key as INT 16h gives it: the original functions (00h, 01h) give the grey keys' E0h as 0.
    fn key_word(w: u16, ah: u8) -> u16 {
        if ah < 0x10 && w & 0xff == 0xe0 {
            w & 0xff00
        } else {
            w
        }
    }

    fn int1a(&mut self) {
        let ah = (self.cpu.r[cpu::AX] >> 8) as u8;
        match ah {
            0x00 => {
                let a = lin(0x40, 0x6c);
                self.cpu.r[cpu::DX] = self.hw.rd16(a);
                self.cpu.r[cpu::CX] = self.hw.rd16(a + 2);
                self.cpu.r[cpu::AX] =
                    (self.cpu.r[cpu::AX] & 0xff00) | self.hw.mem[lin(0x40, 0x70) as usize] as u16;
                self.hw.mem[lin(0x40, 0x70) as usize] = 0;
            }
            0x02 => {
                let (h, m, s, _) = self.dos.clock(self.hw.now);
                let bcd = |v: u32| ((v / 10) << 4 | (v % 10)) as u16;
                self.cpu.r[cpu::CX] = bcd(h) << 8 | bcd(m);
                self.cpu.r[cpu::DX] = bcd(s) << 8;
                self.set_caller_flag(CF, false);
            }
            0x04 => {
                let (y, mo, d) = self.dos.date;
                let bcd = |v: u32| ((v / 10 % 10) << 4 | (v % 10)) as u16;
                self.cpu.r[cpu::CX] = bcd(y / 100) << 8 | bcd(y % 100);
                self.cpu.r[cpu::DX] = bcd(mo) << 8 | bcd(d);
                self.set_caller_flag(CF, false);
            }
            _ => {}
        }
    }

    fn int10(&mut self) {
        let ax = self.cpu.r[cpu::AX];
        let (ah, al) = ((ax >> 8) as u8, ax as u8);
        match ah {
            0x00 => {
                let mode = al & 0x7f;
                self.hw.vga.mode = mode;
                self.hw.mem[lin(0x40, 0x49) as usize] = mode;
                if al & 0x80 == 0 {
                    if mode == 0x13 {
                        self.hw.mem[0xa0000..0xb0000].fill(0);
                    } else {
                        for i in (0xb8000..0xb8fa0).step_by(2) {
                            self.hw.mem[i] = 0x20;
                            self.hw.mem[i + 1] = 0x07;
                        }
                    }
                }
                self.hw.vga.seq[4] = if mode == 0x13 { 0x0e } else { 0x02 };
                self.hw.vga.crtc[0x0c] = 0;
                self.hw.vga.crtc[0x0d] = 0;
                self.hw
                    .wr16(lin(0x40, 0x4a), if mode == 0x13 { 40 } else { 80 });
            }
            0x0f => {
                let cols = self.hw.rd16(lin(0x40, 0x4a)) as u8;
                self.cpu.r[cpu::AX] = (cols as u16) << 8 | self.hw.vga.mode as u16;
                self.cpu.r[cpu::BX] &= 0x00ff;
            }
            0x10 => match al {
                0x10 => {
                    let i = self.cpu.r[cpu::BX] as u8 as usize;
                    let (dh, ch, cl) = (
                        (self.cpu.r[cpu::DX] >> 8) as u8,
                        (self.cpu.r[cpu::CX] >> 8) as u8,
                        self.cpu.r[cpu::CX] as u8,
                    );
                    self.hw.vga.dac[i] = [dh & 0x3f, ch & 0x3f, cl & 0x3f];
                }
                0x12 => {
                    let first = self.cpu.r[cpu::BX] as usize;
                    let n = self.cpu.r[cpu::CX] as usize;
                    let src = self.cpu.lin(cpu::ES, self.cpu.r[cpu::DX]) as usize;
                    for k in 0..n.min(256) {
                        let i = (first + k) & 0xff;
                        for c in 0..3 {
                            self.hw.vga.dac[i][c] = self.hw.mem[src + k * 3 + c] & 0x3f;
                        }
                    }
                }
                0x15 => {
                    let i = self.cpu.r[cpu::BX] as u8 as usize;
                    let [r, g, b] = self.hw.vga.dac[i];
                    self.cpu.r[cpu::DX] = (r as u16) << 8 | (self.cpu.r[cpu::DX] & 0xff);
                    self.cpu.r[cpu::CX] = (g as u16) << 8 | b as u16;
                }
                0x17 => {
                    let first = self.cpu.r[cpu::BX] as usize;
                    let n = self.cpu.r[cpu::CX] as usize;
                    let dst = self.cpu.lin(cpu::ES, self.cpu.r[cpu::DX]) as usize;
                    for k in 0..n.min(256) {
                        let i = (first + k) & 0xff;
                        for c in 0..3 {
                            self.hw.mem[dst + k * 3 + c] = self.hw.vga.dac[i][c];
                        }
                    }
                }
                _ => {}
            },
            0x1a => {
                if al == 0 {
                    self.cpu.r[cpu::AX] = 0x001a;
                    self.cpu.r[cpu::BX] = 0x0008; // VGA, colour
                }
            }
            0x12 => {
                if self.cpu.r[cpu::BX] as u8 == 0x10 {
                    self.cpu.r[cpu::BX] = 0x0003; // colour, 256 KB
                    self.cpu.r[cpu::CX] = 0x0009;
                }
            }
            0x0e => {
                let c = al as char;
                self.dos.console.push(c);
            }
            0x03 => {
                self.cpu.r[cpu::CX] = 0x0607;
                self.cpu.r[cpu::DX] = 0;
            }
            _ => {}
        }
    }

    // ------------------------------------------------------------ the screen

    /// The screen as RGBA, 320 x 200 (mode 13h; black in other modes).
    pub fn render(&mut self) -> &[u8] {
        if self.hw.vga.mode == 0x13 {
            let start = self.hw.vga.start();
            let mut pal = [[0u8; 4]; 256];
            for (i, c) in self.hw.vga.dac.iter().enumerate() {
                let s = |v: u8| (v << 2) | (v >> 4);
                pal[i] = [s(c[0]), s(c[1]), s(c[2]), 255];
            }
            for i in 0..320 * 200 {
                let p = self.hw.mem[0xa0000 + ((start + i) & 0xffff)] as usize;
                self.frame[i * 4..i * 4 + 4].copy_from_slice(&pal[p]);
            }
        } else {
            for px in self.frame.chunks_mut(4) {
                px.copy_from_slice(&[0, 0, 0, 255]);
            }
        }
        &self.frame
    }

    pub fn log(&self) -> String {
        let mut s = self.hw.log.clone();
        s.push_str(&self.dos.log);
        s.push_str(&self.ems.log);
        s
    }
}

/// The character a key gives (US layout), for the BIOS's buffer.
fn scan_ascii(code: u8, shift: bool) -> u8 {
    const LOW: &[u8; 58] =
        b"\x00\x1b1234567890-=\x08\tqwertyuiop[]\r\x00asdfghjkl;'`\x00\\zxcvbnm,./\x00*\x00 ";
    const HIGH: &[u8; 58] =
        b"\x00\x1b!@#$%^&*()_+\x08\tQWERTYUIOP{}\r\x00ASDFGHJKL:\"~\x00|ZXCVBNM<>?\x00*\x00 ";
    let t = if shift { HIGH } else { LOW };
    if (code as usize) < t.len() {
        t[code as usize]
    } else {
        0
    }
}
