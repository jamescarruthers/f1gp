//! The game's 3D renderer (gp.exe 0F47:81CE, docs/renderer-notes.md), rewritten in Rust a routine
//! at a time, each checked against the game's own code on frames caught in races
//! (src/bin/r3d.rs). For now each routine works on the machine's memory as the game's does, with
//! the same layout, so that it can stand in for the game's routine; the aim is the original
//! picture drawn by us, then drawn sharper and smoother.

pub mod fill;

use crate::pc::Machine;

/// The game's segments and memory as a routine of the renderer sees them.
pub struct Mem<'a> {
    pub mem: &'a mut [u8],
    /// the renderer's data segment (DS in its routines: R)
    pub r: u16,
    /// the game's stack segment (SS), where `[bp+...]` reads
    pub ss: u16,
}

impl<'a> Mem<'a> {
    pub fn of(m: &'a mut Machine) -> Mem<'a> {
        let (r, ss) = (m.cpu.s[3], m.cpu.s[2]);
        Mem {
            mem: &mut m.hw.mem,
            r,
            ss,
        }
    }
    #[inline]
    fn at(seg: u16, off: u16) -> usize {
        ((seg as usize) << 4) + off as usize
    }
    /// A word at seg:off.
    #[inline]
    pub fn w(&self, seg: u16, off: u16) -> u16 {
        let a = Self::at(seg, off);
        self.mem[a] as u16 | (self.mem[a + 1] as u16) << 8
    }
    #[inline]
    pub fn set_w(&mut self, seg: u16, off: u16, v: u16) {
        let a = Self::at(seg, off);
        self.mem[a] = v as u8;
        self.mem[a + 1] = (v >> 8) as u8;
    }
    #[inline]
    pub fn b(&self, seg: u16, off: u16) -> u8 {
        self.mem[Self::at(seg, off)]
    }
    #[inline]
    pub fn set_b(&mut self, seg: u16, off: u16, v: u8) {
        self.mem[Self::at(seg, off)] = v;
    }
    /// A word in the renderer's segment (R).
    #[inline]
    pub fn rw(&self, off: u16) -> u16 {
        self.w(self.r, off)
    }
    #[inline]
    pub fn set_rw(&mut self, off: u16, v: u16) {
        self.set_w(self.r, off, v)
    }
    #[inline]
    pub fn rb(&self, off: u16) -> u8 {
        self.b(self.r, off)
    }
    #[inline]
    pub fn set_rb(&mut self, off: u16, v: u8) {
        self.set_b(self.r, off, v)
    }
    /// A far pointer in R: (segment, offset).
    #[inline]
    pub fn far(&self, off: u16) -> (u16, u16) {
        (self.rw(off + 2), self.rw(off))
    }
}
