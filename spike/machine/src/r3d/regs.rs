//! The machine's registers and memory as a ported routine sees them, for the routines that pass
//! values in registers and keep few (unlike the PUSHA ones): a port changes the registers just
//! as the game's routine leaves them, and ports call each other as the game's routines do.

use super::Mem;
use crate::pc::Machine;

pub const AX: usize = 0;
pub const CX: usize = 1;
pub const DX: usize = 2;
pub const BX: usize = 3;
pub const SP: usize = 4;
pub const BP: usize = 5;
pub const SI: usize = 6;
pub const DI: usize = 7;
pub const ES: usize = 0;
pub const CS: usize = 1;
pub const SS: usize = 2;
pub const DS: usize = 3;

pub struct Cpu<'a> {
    pub mem: &'a mut [u8],
    /// AX CX DX BX SP BP SI DI
    pub r: &'a mut [u16; 8],
    /// ES CS SS DS
    pub s: &'a mut [u16; 4],
}

#[inline]
fn at(seg: u16, off: u16) -> usize {
    ((seg as usize) << 4) + off as usize
}

impl<'a> Cpu<'a> {
    pub fn of(m: &'a mut Machine) -> Cpu<'a> {
        Cpu {
            mem: &mut m.hw.mem,
            r: &mut m.cpu.r,
            s: &mut m.cpu.s,
        }
    }
    /// The older ports' view (Mem, DS as R) and the registers, together.
    pub fn split(&mut self) -> (Mem<'_>, &mut [u16; 8]) {
        (
            Mem {
                mem: self.mem,
                r: self.s[DS],
                ss: self.s[SS],
                cs: self.s[CS],
            },
            self.r,
        )
    }

    #[inline]
    pub fn w(&self, seg: u16, off: u16) -> u16 {
        let a = at(seg, off);
        self.mem[a] as u16 | (self.mem[a + 1] as u16) << 8
    }
    #[inline]
    pub fn set_w(&mut self, seg: u16, off: u16, v: u16) {
        let a = at(seg, off);
        self.mem[a] = v as u8;
        self.mem[a + 1] = (v >> 8) as u8;
    }
    #[inline]
    pub fn b(&self, seg: u16, off: u16) -> u8 {
        self.mem[at(seg, off)]
    }
    #[inline]
    pub fn set_b(&mut self, seg: u16, off: u16, v: u8) {
        self.mem[at(seg, off)] = v;
    }
    /// DS:o
    #[inline]
    pub fn d(&self, o: u16) -> u16 {
        self.w(self.s[DS], o)
    }
    #[inline]
    pub fn set_d(&mut self, o: u16, v: u16) {
        self.set_w(self.s[DS], o, v)
    }
    #[inline]
    pub fn db(&self, o: u16) -> u8 {
        self.b(self.s[DS], o)
    }
    #[inline]
    pub fn set_db(&mut self, o: u16, v: u8) {
        self.set_b(self.s[DS], o, v)
    }
    /// ES:o
    #[inline]
    pub fn e(&self, o: u16) -> u16 {
        self.w(self.s[ES], o)
    }
    #[inline]
    pub fn eb(&self, o: u16) -> u8 {
        self.b(self.s[ES], o)
    }
    #[inline]
    pub fn set_eb(&mut self, o: u16, v: u8) {
        self.set_b(self.s[ES], o, v)
    }
    /// SS:[bp+o]
    #[inline]
    pub fn bp(&self, o: u16) -> u16 {
        self.w(self.s[SS], self.r[BP].wrapping_add(o))
    }
    #[inline]
    pub fn set_bp(&mut self, o: u16, v: u16) {
        self.set_w(self.s[SS], self.r[BP].wrapping_add(o), v)
    }
    #[inline]
    pub fn bpb(&self, o: u16) -> u8 {
        self.b(self.s[SS], self.r[BP].wrapping_add(o))
    }
    #[inline]
    pub fn set_bpb(&mut self, o: u16, v: u8) {
        self.set_b(self.s[SS], self.r[BP].wrapping_add(o), v)
    }
    /// SS:[bp+o], 32-bit
    #[inline]
    pub fn bp32(&self, o: u16) -> u32 {
        join(self.bp(o.wrapping_add(2)), self.bp(o))
    }
    #[inline]
    pub fn set_bp32(&mut self, o: u16, v: u32) {
        self.set_bp(o, v as u16);
        self.set_bp(o.wrapping_add(2), (v >> 16) as u16);
    }
    /// SS:o
    #[inline]
    pub fn ss(&self, o: u16) -> u16 {
        self.w(self.s[SS], o)
    }
    #[inline]
    pub fn set_ssb(&mut self, o: u16, v: u8) {
        self.set_b(self.s[SS], o, v)
    }
    #[inline]
    pub fn ssb(&self, o: u16) -> u8 {
        self.b(self.s[SS], o)
    }
    /// CS:o
    #[inline]
    pub fn c(&self, o: u16) -> u16 {
        self.w(self.s[CS], o)
    }
    #[inline]
    pub fn set_cb(&mut self, o: u16, v: u8) {
        self.set_b(self.s[CS], o, v)
    }

    /// DIV of dx:ax by d: (AX, DX) after it; a divide error goes through the game's handler,
    /// which sets SS:00C0 and leaves AX and DX as they were (Mem::div).
    pub fn div(&mut self, dx: u16, ax: u16, d: u16) -> (u16, u16) {
        let n = (dx as u32) << 16 | ax as u32;
        match n.checked_div(d as u32) {
            Some(q) if q <= 0xffff => (q as u16, (n % d as u32) as u16),
            _ => {
                self.set_ssb(0xc0, 1);
                (ax, dx)
            }
        }
    }
    /// IDIV, likewise.
    pub fn idiv(&mut self, dx: u16, ax: u16, d: u16) -> (u16, u16) {
        let n = ((dx as u32) << 16 | ax as u32) as i32 as i64;
        let d = d as i16 as i64;
        match n.checked_div(d) {
            Some(q) if (-0x8000..0x8000).contains(&q) => (q as u16, (n % d) as u16),
            _ => {
                self.set_ssb(0xc0, 1);
                (ax, dx)
            }
        }
    }
}

/// IMUL: dx:ax.
#[inline]
pub fn imul(a: u16, b: u16) -> (u16, u16) {
    let p = (a as i16 as i32 * b as i16 as i32) as u32;
    ((p >> 16) as u16, p as u16)
}
/// MUL: dx:ax.
#[inline]
pub fn mul(a: u16, b: u16) -> (u16, u16) {
    let p = a as u32 * b as u32;
    ((p >> 16) as u16, p as u16)
}
/// A 32-bit dx:ax.
#[inline]
pub fn join(dx: u16, ax: u16) -> u32 {
    (dx as u32) << 16 | ax as u32
}
/// SAR of a word by n (the 286 takes the count's low 5 bits).
#[inline]
pub fn sar(v: u16, n: u8) -> u16 {
    ((v as i16) >> (n & 31).min(15)) as u16
}
