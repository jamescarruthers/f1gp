//! An Intel 80286 in real mode: the 8086's instructions, the 186/286 additions
//! (PUSHA, POPA, BOUND, IMUL with an immediate, PUSH immediate, INS/OUTS,
//! shifts by an immediate, ENTER, LEAVE, the 0F system instructions that work
//! in real mode) and the 286's real-mode faults: divide error (0), BOUND (5),
//! invalid opcode (6), a word at offset FFFFh (13) and
//! an instruction longer than ten bytes (13). Faults push the address of the
//! faulting instruction.
//!
//! Checked against the SingleStepTests 80286 real-mode set (tests/cpu286.rs).
//!
//! The machine serves DOS and BIOS in Rust: the reserved opcode FE 38 nn stops
//! the CPU with `Event::Callback(nn)`, and the machine does the work and
//! carries on (the BIOS's interrupt vectors point at such stubs).

pub const CF: u16 = 0x0001;
pub const PF: u16 = 0x0004;
pub const AF: u16 = 0x0010;
pub const ZF: u16 = 0x0040;
pub const SF: u16 = 0x0080;
pub const TF: u16 = 0x0100;
pub const IF: u16 = 0x0200;
pub const DF: u16 = 0x0400;
pub const OF: u16 = 0x0800;

/// The flags a 286 keeps in real mode: bits 12-15 read as 0, bit 1 as 1.
const FLAGS_MASK: u16 = 0x0fd5;

// register numbers, as the instruction encoding numbers them
pub const AX: usize = 0;
pub const CX: usize = 1;
pub const DX: usize = 2;
pub const BX: usize = 3;
pub const SP: usize = 4;
pub const BP: usize = 5;
pub const SI: usize = 6;
pub const DI: usize = 7;
// segment registers
pub const ES: u8 = 0;
pub const CS: u8 = 1;
pub const SS: u8 = 2;
pub const DS: u8 = 3;

/// Memory and ports, as the CPU sees them. Addresses are physical.
pub trait Bus {
    fn rd8(&mut self, addr: u32) -> u8;
    fn wr8(&mut self, addr: u32, v: u8);
    fn io_in8(&mut self, port: u16) -> u8;
    fn io_out8(&mut self, port: u16, v: u8);
    fn io_in16(&mut self, port: u16) -> u16 {
        self.io_in8(port) as u16 | (self.io_in8(port.wrapping_add(1)) as u16) << 8
    }
    fn io_out16(&mut self, port: u16, v: u16) {
        self.io_out8(port, v as u8);
        self.io_out8(port.wrapping_add(1), (v >> 8) as u8);
    }
    /// An interrupt request the CPU would take now if IF allowed it (Cpu::run stops for it).
    fn irq_pending(&mut self) -> bool {
        false
    }
}

/// What a step ended with.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Event {
    Ok,
    /// HLT: the CPU waits for an interrupt
    Halt,
    /// FE 38 nn: the machine's service nn (IP is past the three bytes)
    Callback(u8),
}

#[derive(Debug, Clone, Copy)]
enum Stop {
    Exc(u8),
    Callback(u8),
    Halt,
}
type R<T> = Result<T, Stop>;

#[derive(Debug, Clone, Copy)]
enum Ea {
    Reg(u8),
    Mem { seg: u8, off: u16 },
}

#[derive(Clone)]
pub struct Cpu {
    /// AX CX DX BX SP BP SI DI
    pub r: [u16; 8],
    /// ES CS SS DS
    pub s: [u16; 4],
    pub ip: u16,
    pub flags: u16,
    pub halted: bool,
    /// interrupts wait one instruction (after MOV SS, POP SS, STI)
    pub irq_inhibit: bool,
    /// instructions run (string repeats count one each)
    pub count: u64,
    /// physical address mask: FFFFFh (A20 off, as an 8086) or FFFFFFh
    pub a20: u32,
    /// the machine status word and descriptor table registers (SMSW, LMSW, LGDT, LIDT...)
    pub msw: u16,
    pub gdtr: (u32, u16),
    pub idtr: (u32, u16),
    /// something may have let an interrupt in (IF set, a port written): Cpu::run checks
    recheck: bool,
    // the instruction being run
    seg_ovr: Option<u8>,
    rep: u8,
    start_ip: u16,
}

impl Default for Cpu {
    fn default() -> Self {
        Cpu::new()
    }
}

/// The flags arithmetic sets.
const ARITH: u16 = CF | PF | AF | ZF | SF | OF;

/// PF for a result: set when its low byte has an even number of ones (0x9669: bit n set when
/// the nibble n has an even number; the byte folded to a nibble keeps its parity).
#[inline(always)]
fn pf(v: u8) -> u16 {
    ((0x9669u16 >> ((v ^ (v >> 4)) & 0x0f)) & 1) << 2
}
/// ZF, SF and PF for an 8-bit result.
#[inline(always)]
fn szp8(v: u8) -> u16 {
    ((v == 0) as u16) << 6 | (v & 0x80) as u16 | pf(v)
}
/// ZF, SF and PF for a 16-bit result.
#[inline(always)]
fn szp16(v: u16) -> u16 {
    ((v == 0) as u16) << 6 | (v >> 8) & 0x80 | pf(v as u8)
}

impl Cpu {
    pub fn new() -> Cpu {
        Cpu {
            r: [0; 8],
            s: [0; 4],
            ip: 0,
            flags: 0x0002,
            halted: false,
            irq_inhibit: false,
            count: 0,
            a20: 0x0f_ffff,
            msw: 0xfff0,
            gdtr: (0, 0xffff),
            idtr: (0, 0x03ff),
            recheck: true,
            seg_ovr: None,
            rep: 0,
            start_ip: 0,
        }
    }

    // ------------------------------------------------------------ registers and flags

    #[inline(always)]
    pub fn get8(&self, r: u8) -> u8 {
        let w = self.r[(r & 3) as usize];
        if r < 4 {
            w as u8
        } else {
            (w >> 8) as u8
        }
    }
    #[inline(always)]
    pub fn set8(&mut self, r: u8, v: u8) {
        let w = &mut self.r[(r & 3) as usize];
        if r < 4 {
            *w = (*w & 0xff00) | v as u16
        } else {
            *w = (*w & 0x00ff) | (v as u16) << 8
        }
    }
    #[inline(always)]
    fn flag(&self, f: u16) -> bool {
        self.flags & f != 0
    }
    #[inline(always)]
    fn setf(&mut self, f: u16, on: bool) {
        if on {
            self.flags |= f
        } else {
            self.flags &= !f
        }
    }
    /// Load the flags as a 286 in real mode keeps them.
    #[inline]
    pub fn load_flags(&mut self, v: u16) {
        self.flags = (v & FLAGS_MASK) | 0x0002;
        self.recheck = true;
    }
    #[inline(always)]
    fn szp8(&mut self, v: u8) {
        self.flags = (self.flags & !(ZF | SF | PF)) | szp8(v);
    }
    #[inline(always)]
    fn szp16(&mut self, v: u16) {
        self.flags = (self.flags & !(ZF | SF | PF)) | szp16(v);
    }

    // ------------------------------------------------------------ memory

    #[inline(always)]
    pub fn lin(&self, seg: u8, off: u16) -> u32 {
        ((self.s[(seg & 3) as usize] as u32) << 4).wrapping_add(off as u32) & self.a20
    }
    /// A word at offset FFFFh: exception 13 (on the stack segment too, as a real 286 does).
    #[inline]
    fn overrun(_seg: u8) -> Stop {
        Stop::Exc(13)
    }
    #[inline(always)]
    fn rd8m<B: Bus>(&self, b: &mut B, seg: u8, off: u16) -> u8 {
        b.rd8(self.lin(seg, off))
    }
    #[inline(always)]
    fn wr8m<B: Bus>(&self, b: &mut B, seg: u8, off: u16, v: u8) {
        b.wr8(self.lin(seg, off), v)
    }
    #[inline(always)]
    fn rd16m<B: Bus>(&self, b: &mut B, seg: u8, off: u16) -> R<u16> {
        if off == 0xffff {
            return Err(Self::overrun(seg));
        }
        let a = self.lin(seg, off);
        Ok(b.rd8(a) as u16 | (b.rd8((a + 1) & self.a20) as u16) << 8)
    }
    #[inline(always)]
    fn wr16m<B: Bus>(&self, b: &mut B, seg: u8, off: u16, v: u16) -> R<()> {
        if off == 0xffff {
            return Err(Self::overrun(seg));
        }
        let a = self.lin(seg, off);
        b.wr8(a, v as u8);
        b.wr8((a + 1) & self.a20, (v >> 8) as u8);
        Ok(())
    }

    #[inline(always)]
    fn fetch8<B: Bus>(&mut self, b: &mut B) -> R<u8> {
        if self.ip.wrapping_sub(self.start_ip) >= 10 {
            return Err(Stop::Exc(13)); // longer than ten bytes
        }
        let v = b.rd8(self.lin(CS, self.ip));
        self.ip = self.ip.wrapping_add(1);
        Ok(v)
    }
    #[inline(always)]
    fn fetch16<B: Bus>(&mut self, b: &mut B) -> R<u16> {
        let lo = self.fetch8(b)? as u16;
        Ok(lo | (self.fetch8(b)? as u16) << 8)
    }

    /// OUT: a write to the interrupt controller can let an interrupt in.
    #[inline(always)]
    fn out8<B: Bus>(&mut self, b: &mut B, port: u16, v: u8) {
        b.io_out8(port, v);
        self.recheck = true;
    }
    #[inline(always)]
    fn out16<B: Bus>(&mut self, b: &mut B, port: u16, v: u16) {
        b.io_out16(port, v);
        self.recheck = true;
    }

    #[inline(always)]
    fn push<B: Bus>(&mut self, b: &mut B, v: u16) -> R<()> {
        let sp = self.r[SP].wrapping_sub(2);
        self.wr16m(b, SS, sp, v)?;
        self.r[SP] = sp;
        Ok(())
    }
    #[inline(always)]
    fn pop<B: Bus>(&mut self, b: &mut B) -> R<u16> {
        let v = self.rd16m(b, SS, self.r[SP])?;
        self.r[SP] = self.r[SP].wrapping_add(2);
        Ok(v)
    }

    // ------------------------------------------------------------ operands

    #[inline(always)]
    fn modrm<B: Bus>(&mut self, b: &mut B) -> R<(u8, Ea)> {
        let m = self.fetch8(b)?;
        let md = m >> 6;
        let reg = (m >> 3) & 7;
        let rm = m & 7;
        if md == 3 {
            return Ok((reg, Ea::Reg(rm)));
        }
        let r = &self.r;
        let (mut off, mut seg) = match rm {
            0 => (r[BX].wrapping_add(r[SI]), DS),
            1 => (r[BX].wrapping_add(r[DI]), DS),
            2 => (r[BP].wrapping_add(r[SI]), SS),
            3 => (r[BP].wrapping_add(r[DI]), SS),
            4 => (r[SI], DS),
            5 => (r[DI], DS),
            6 => {
                if md == 0 {
                    (0, DS)
                } else {
                    (r[BP], SS)
                }
            }
            _ => (r[BX], DS),
        };
        match md {
            0 => {
                if rm == 6 {
                    off = self.fetch16(b)?;
                }
            }
            1 => off = off.wrapping_add(self.fetch8(b)? as i8 as u16),
            _ => off = off.wrapping_add(self.fetch16(b)?),
        }
        if let Some(s) = self.seg_ovr {
            seg = s;
        }
        Ok((reg, Ea::Mem { seg, off }))
    }
    #[inline(always)]
    fn rm8<B: Bus>(&mut self, b: &mut B, ea: Ea) -> u8 {
        match ea {
            Ea::Reg(r) => self.get8(r),
            Ea::Mem { seg, off } => self.rd8m(b, seg, off),
        }
    }
    #[inline(always)]
    fn set_rm8<B: Bus>(&mut self, b: &mut B, ea: Ea, v: u8) {
        match ea {
            Ea::Reg(r) => self.set8(r, v),
            Ea::Mem { seg, off } => self.wr8m(b, seg, off, v),
        }
    }
    #[inline(always)]
    fn rm16<B: Bus>(&mut self, b: &mut B, ea: Ea) -> R<u16> {
        match ea {
            Ea::Reg(r) => Ok(self.r[(r & 7) as usize]),
            Ea::Mem { seg, off } => self.rd16m(b, seg, off),
        }
    }
    #[inline(always)]
    fn set_rm16<B: Bus>(&mut self, b: &mut B, ea: Ea, v: u16) -> R<()> {
        match ea {
            Ea::Reg(r) => {
                self.r[(r & 7) as usize] = v;
                Ok(())
            }
            Ea::Mem { seg, off } => self.wr16m(b, seg, off, v),
        }
    }
    /// A memory operand (LEA, LES, far pointers, BOUND): register forms are invalid.
    #[inline]
    fn mem_only(ea: Ea) -> R<(u8, u16)> {
        match ea {
            Ea::Mem { seg, off } => Ok((seg, off)),
            Ea::Reg(_) => Err(Stop::Exc(6)),
        }
    }

    // ------------------------------------------------------------ arithmetic

    #[inline(always)]
    fn alu8(&mut self, op: u8, a: u8, b: u8) -> u8 {
        match op {
            0 | 2 => {
                let c = (op == 2) as u16 & self.flags & CF;
                let res = a as u16 + b as u16 + c;
                let r = res as u8;
                let of = (((a ^ r) & (b ^ r) & 0x80) as u16) << 4;
                self.flags =
                    (self.flags & !ARITH) | (res >> 8) | ((a ^ b ^ r) & 0x10) as u16 | of | szp8(r);
                r
            }
            3 | 5 | 7 => {
                let c = (op == 3) as u16 & self.flags & CF;
                let res = (a as u16).wrapping_sub(b as u16).wrapping_sub(c);
                let r = res as u8;
                let of = (((a ^ b) & (a ^ r) & 0x80) as u16) << 4;
                self.flags = (self.flags & !ARITH)
                    | (res >> 8) & 1
                    | ((a ^ b ^ r) & 0x10) as u16
                    | of
                    | szp8(r);
                r
            }
            _ => {
                let r = match op {
                    1 => a | b,
                    4 => a & b,
                    _ => a ^ b,
                };
                self.flags = (self.flags & !ARITH) | szp8(r);
                r
            }
        }
    }
    #[inline(always)]
    fn alu16(&mut self, op: u8, a: u16, b: u16) -> u16 {
        match op {
            0 | 2 => {
                let c = ((op == 2) as u16 & self.flags & CF) as u32;
                let res = a as u32 + b as u32 + c;
                let r = res as u16;
                let of = ((a ^ r) & (b ^ r) & 0x8000) >> 4;
                self.flags =
                    (self.flags & !ARITH) | (res >> 16) as u16 | (a ^ b ^ r) & 0x10 | of | szp16(r);
                r
            }
            3 | 5 | 7 => {
                let c = ((op == 3) as u16 & self.flags & CF) as u32;
                let res = (a as u32).wrapping_sub(b as u32).wrapping_sub(c);
                let r = res as u16;
                let of = ((a ^ b) & (a ^ r) & 0x8000) >> 4;
                self.flags = (self.flags & !ARITH)
                    | (res >> 16) as u16 & 1
                    | (a ^ b ^ r) & 0x10
                    | of
                    | szp16(r);
                r
            }
            _ => {
                let r = match op {
                    1 => a | b,
                    4 => a & b,
                    _ => a ^ b,
                };
                self.flags = (self.flags & !ARITH) | szp16(r);
                r
            }
        }
    }
    #[inline(always)]
    fn inc8(&mut self, a: u8) -> u8 {
        let r = a.wrapping_add(1);
        let af = ((a ^ r) & 0x10) as u16;
        self.flags = (self.flags & !(ARITH & !CF)) | af | ((r == 0x80) as u16) << 11 | szp8(r);
        r
    }
    #[inline(always)]
    fn dec8(&mut self, a: u8) -> u8 {
        let r = a.wrapping_sub(1);
        let af = ((a ^ r) & 0x10) as u16;
        self.flags = (self.flags & !(ARITH & !CF)) | af | ((r == 0x7f) as u16) << 11 | szp8(r);
        r
    }
    #[inline(always)]
    fn inc16(&mut self, a: u16) -> u16 {
        let r = a.wrapping_add(1);
        let af = (a ^ r) & 0x10;
        self.flags = (self.flags & !(ARITH & !CF)) | af | ((r == 0x8000) as u16) << 11 | szp16(r);
        r
    }
    #[inline(always)]
    fn dec16(&mut self, a: u16) -> u16 {
        let r = a.wrapping_sub(1);
        let af = (a ^ r) & 0x10;
        self.flags = (self.flags & !(ARITH & !CF)) | af | ((r == 0x7fff) as u16) << 11 | szp16(r);
        r
    }

    /// Rotates and shifts (op: ROL ROR RCL RCR SHL SHR SAL SAR), `bits` 8 or 16; the count is masked to 5 bits.
    fn shift(&mut self, op: u8, v: u16, count: u8, bits: u32) -> u16 {
        let count = (count & 0x1f) as u32;
        if count == 0 {
            return v;
        }
        let mask: u32 = if bits == 8 { 0xff } else { 0xffff };
        let msb: u32 = 1 << (bits - 1);
        let mut x = v as u32 & mask;
        match op {
            0 => {
                for _ in 0..count {
                    let c = (x & msb) != 0;
                    x = ((x << 1) | c as u32) & mask;
                }
                let cf = x & 1 != 0;
                self.setf(CF, cf);
                self.setf(OF, ((x & msb) != 0) ^ cf);
            }
            1 => {
                for _ in 0..count {
                    let c = x & 1;
                    x = (x >> 1) | (c * msb);
                }
                self.setf(CF, x & msb != 0);
                self.setf(OF, ((x & msb) != 0) ^ ((x & (msb >> 1)) != 0));
            }
            2 => {
                let mut cf = self.flag(CF);
                for _ in 0..count {
                    let c = (x & msb) != 0;
                    x = ((x << 1) | cf as u32) & mask;
                    cf = c;
                }
                self.setf(CF, cf);
                self.setf(OF, ((x & msb) != 0) ^ cf);
            }
            3 => {
                let mut cf = self.flag(CF);
                for _ in 0..count {
                    let c = x & 1 != 0;
                    x = (x >> 1) | (cf as u32 * msb);
                    cf = c;
                }
                self.setf(CF, cf);
                self.setf(OF, ((x & msb) != 0) ^ ((x & (msb >> 1)) != 0));
            }
            4 | 6 => {
                let cf = if count <= bits {
                    (x >> (bits - count)) & 1 != 0
                } else {
                    false
                };
                x = if count < 32 { (x << count) & mask } else { 0 };
                self.setf(CF, cf);
                self.setf(OF, ((x & msb) != 0) ^ cf);
                self.setf(AF, false);
                if bits == 8 {
                    self.szp8(x as u8)
                } else {
                    self.szp16(x as u16)
                }
            }
            5 => {
                let cf = if count <= bits {
                    (x >> (count - 1)) & 1 != 0
                } else {
                    false
                };
                self.setf(OF, x & msb != 0);
                x = if count < 32 { x >> count } else { 0 };
                self.setf(CF, cf);
                self.setf(AF, false);
                if bits == 8 {
                    self.szp8(x as u8)
                } else {
                    self.szp16(x as u16)
                }
            }
            _ => {
                let sx: i32 = if bits == 8 {
                    x as u8 as i8 as i32
                } else {
                    x as u16 as i16 as i32
                };
                let c = count.min(bits);
                let cf = (sx >> (c - 1)) & 1 != 0;
                x = (sx >> c) as u32 & mask;
                self.setf(CF, cf);
                self.setf(OF, false);
                self.setf(AF, false);
                if bits == 8 {
                    self.szp8(x as u8)
                } else {
                    self.szp16(x as u16)
                }
            }
        }
        x as u16
    }

    // ------------------------------------------------------------ interrupts

    /// Take interrupt `n`: push FLAGS, CS, IP; clear IF and TF; jump through the vector table.
    pub fn interrupt<B: Bus>(&mut self, b: &mut B, n: u8) {
        let _ = self.int_r(b, n);
    }
    fn int_r<B: Bus>(&mut self, b: &mut B, n: u8) -> R<()> {
        let f = self.flags;
        self.push(b, f)?;
        self.push(b, self.s[CS as usize])?;
        self.push(b, self.ip)?;
        self.flags &= !(IF | TF);
        let v = (n as u32) * 4 + self.idtr.0;
        let ip = b.rd8(v & self.a20) as u16 | (b.rd8((v + 1) & self.a20) as u16) << 8;
        let cs = b.rd8((v + 2) & self.a20) as u16 | (b.rd8((v + 3) & self.a20) as u16) << 8;
        self.ip = ip;
        self.s[CS as usize] = cs;
        self.halted = false;
        Ok(())
    }

    // ------------------------------------------------------------ running

    /// Run one instruction (with its prefixes; a repeated string instruction runs to its end).
    pub fn step<B: Bus>(&mut self, b: &mut B) -> Event {
        self.step_inline(b)
    }

    /// Run instructions until `count` reaches `limit`, an instruction stops the CPU (HLT, a
    /// callback), or an interrupt may be taken (IF set, no inhibit, `Bus::irq_pending`): the
    /// caller takes interrupts. One loop here, rather than a call per instruction.
    ///
    /// The check for an interrupt is made at the start and after an instruction that can let
    /// one in (STI, POPF, IRET, OUT: `recheck`), once no interrupt shadow (MOV SS, STI) is
    /// in force: interrupt requests are raised between calls, never during one.
    pub fn run<B: Bus>(&mut self, b: &mut B, limit: u64) -> Event {
        self.recheck = true;
        while self.count < limit {
            if self.recheck && !self.irq_inhibit {
                self.recheck = false;
                if self.flags & IF != 0 && b.irq_pending() {
                    self.recheck = true;
                    break;
                }
            }
            match self.step_inline(b) {
                Event::Ok => {}
                e => return e,
            }
        }
        Event::Ok
    }

    #[inline(always)]
    fn step_inline<B: Bus>(&mut self, b: &mut B) -> Event {
        self.start_ip = self.ip;
        self.seg_ovr = None;
        self.rep = 0;
        self.irq_inhibit = false;
        self.count += 1;
        match self.exec(b) {
            Ok(()) => Event::Ok,
            Err(Stop::Halt) => {
                self.halted = true;
                Event::Halt
            }
            Err(Stop::Callback(n)) => Event::Callback(n),
            Err(Stop::Exc(n)) => {
                // a fault: back to the start of the instruction, then the handler
                self.ip = self.start_ip;
                self.interrupt(b, n);
                Event::Ok
            }
        }
    }

    #[inline(always)]
    fn jcc(&self, c: u8) -> bool {
        let f = |x| self.flag(x);
        let r = match c >> 1 {
            0 => f(OF),
            1 => f(CF),
            2 => f(ZF),
            3 => f(CF) || f(ZF),
            4 => f(SF),
            5 => f(PF),
            6 => f(SF) != f(OF),
            _ => f(ZF) || (f(SF) != f(OF)),
        };
        r != (c & 1 != 0)
    }

    #[inline(always)]
    fn exec<B: Bus>(&mut self, b: &mut B) -> R<()> {
        let mut op;
        loop {
            op = self.fetch8(b)?;
            match op {
                0x26 => self.seg_ovr = Some(ES),
                0x2e => self.seg_ovr = Some(CS),
                0x36 => self.seg_ovr = Some(SS),
                0x3e => self.seg_ovr = Some(DS),
                0xf0 | 0xf1 => {}
                0xf2 | 0xf3 => self.rep = op,
                _ => break,
            }
        }
        match op {
            // ALU r/m, reg / reg, r/m / acc, imm
            0x00..=0x3f if op & 7 < 6 => {
                let alu = op >> 3;
                match op & 7 {
                    0 => {
                        let (reg, ea) = self.modrm(b)?;
                        let a = self.rm8(b, ea);
                        let v = self.alu8(alu, a, self.get8(reg));
                        if alu != 7 {
                            self.set_rm8(b, ea, v)
                        }
                    }
                    1 => {
                        let (reg, ea) = self.modrm(b)?;
                        let a = self.rm16(b, ea)?;
                        let v = self.alu16(alu, a, self.r[(reg & 7) as usize]);
                        if alu != 7 {
                            self.set_rm16(b, ea, v)?
                        }
                    }
                    2 => {
                        let (reg, ea) = self.modrm(b)?;
                        let x = self.rm8(b, ea);
                        let v = self.alu8(alu, self.get8(reg), x);
                        if alu != 7 {
                            self.set8(reg, v)
                        }
                    }
                    3 => {
                        let (reg, ea) = self.modrm(b)?;
                        let x = self.rm16(b, ea)?;
                        let v = self.alu16(alu, self.r[(reg & 7) as usize], x);
                        if alu != 7 {
                            self.r[(reg & 7) as usize] = v
                        }
                    }
                    4 => {
                        let x = self.fetch8(b)?;
                        let v = self.alu8(alu, self.r[AX] as u8, x);
                        if alu != 7 {
                            self.set8(0, v)
                        }
                    }
                    _ => {
                        let x = self.fetch16(b)?;
                        let v = self.alu16(alu, self.r[AX], x);
                        if alu != 7 {
                            self.r[AX] = v
                        }
                    }
                }
            }
            0x06 | 0x0e | 0x16 | 0x1e => {
                let s = self.s[(op >> 3) as usize];
                self.push(b, s)?;
            }
            0x07 | 0x17 | 0x1f => {
                let v = self.pop(b)?;
                self.s[(op >> 3) as usize] = v;
                if op == 0x17 {
                    self.irq_inhibit = true
                }
            }
            0x0f => self.op_0f(b)?,
            0x27 => {
                // DAA
                let al = self.r[AX] as u8;
                let old_cf = self.flag(CF);
                let mut v = al;
                if al & 0x0f > 9 || self.flag(AF) {
                    v = v.wrapping_add(6);
                    self.setf(AF, true);
                } else {
                    self.setf(AF, false);
                }
                if al > 0x99 || old_cf {
                    v = v.wrapping_add(0x60);
                }
                self.setf(CF, al > 0x99 || old_cf);
                self.set8(0, v);
                self.szp8(v);
            }
            0x2f => {
                // DAS
                let al = self.r[AX] as u8;
                let old_cf = self.flag(CF);
                let mut v = al;
                self.setf(CF, false);
                if al & 0x0f > 9 || self.flag(AF) {
                    let (n, c) = v.overflowing_sub(6);
                    v = n;
                    self.setf(CF, old_cf || c);
                    self.setf(AF, true);
                } else {
                    self.setf(AF, false);
                }
                if al > 0x99 || old_cf {
                    v = v.wrapping_sub(0x60);
                    self.setf(CF, true);
                }
                self.set8(0, v);
                self.szp8(v);
            }
            0x37 | 0x3f => {
                // AAA, AAS
                if self.r[AX] & 0x0f > 9 || self.flag(AF) {
                    if op == 0x37 {
                        self.r[AX] = self.r[AX].wrapping_add(0x106);
                    } else {
                        self.r[AX] = self.r[AX].wrapping_sub(6).wrapping_sub(0x100);
                    }
                    self.flags |= AF | CF;
                } else {
                    self.flags &= !(AF | CF);
                }
                self.r[AX] &= 0xff0f;
                let al = self.r[AX] as u8;
                self.szp8(al);
            }
            0x40..=0x47 => {
                let r = (op & 7) as usize;
                self.r[r] = self.inc16(self.r[r]);
            }
            0x48..=0x4f => {
                let r = (op & 7) as usize;
                self.r[r] = self.dec16(self.r[r]);
            }
            0x50..=0x57 => {
                // PUSH reg (PUSH SP pushes SP as it was)
                let v = self.r[(op & 7) as usize];
                self.push(b, v)?;
            }
            0x58..=0x5f => {
                let v = self.pop(b)?;
                self.r[(op & 7) as usize] = v;
            }
            0x60 => {
                let sp = self.r[SP];
                for i in [AX, CX, DX, BX] {
                    let v = self.r[i];
                    self.push(b, v)?;
                }
                self.push(b, sp)?;
                for i in [BP, SI, DI] {
                    let v = self.r[i];
                    self.push(b, v)?;
                }
            }
            0x61 => {
                for i in [DI, SI, BP] {
                    self.r[i] = self.pop(b)?;
                }
                self.r[SP] = self.r[SP].wrapping_add(2);
                for i in [BX, DX, CX, AX] {
                    self.r[i] = self.pop(b)?;
                }
            }
            0x62 => {
                // BOUND
                let (reg, ea) = self.modrm(b)?;
                let (seg, off) = Self::mem_only(ea)?;
                let lo = self.rd16m(b, seg, off)? as i16;
                let hi = self.rd16m(b, seg, off.wrapping_add(2))? as i16;
                let v = self.r[(reg & 7) as usize] as i16;
                if v < lo || v > hi {
                    return Err(Stop::Exc(5));
                }
            }
            0x68 => {
                let v = self.fetch16(b)?;
                self.push(b, v)?;
            }
            0x6a => {
                let v = self.fetch8(b)? as i8 as u16;
                self.push(b, v)?;
            }
            0x69 | 0x6b => {
                let (reg, ea) = self.modrm(b)?;
                let a = self.rm16(b, ea)? as i16 as i32;
                let imm = if op == 0x69 {
                    self.fetch16(b)? as i16 as i32
                } else {
                    self.fetch8(b)? as i8 as i32
                };
                let p = a * imm;
                self.r[(reg & 7) as usize] = p as u16;
                let over = p != p as i16 as i32;
                self.setf(CF, over);
                self.setf(OF, over);
            }
            0x6c..=0x6f => self.string_op(b, op)?,
            0x70..=0x7f => {
                let d = self.fetch8(b)? as i8 as u16;
                if self.jcc(op & 0x0f) {
                    self.ip = self.ip.wrapping_add(d);
                }
            }
            0x80..=0x83 => {
                let (alu, ea) = self.modrm(b)?;
                if op & 1 == 0 {
                    let a = self.rm8(b, ea);
                    let x = self.fetch8(b)?;
                    let v = self.alu8(alu, a, x);
                    if alu != 7 {
                        self.set_rm8(b, ea, v)
                    }
                } else {
                    let a = self.rm16(b, ea)?;
                    let x = if op == 0x81 {
                        self.fetch16(b)?
                    } else {
                        self.fetch8(b)? as i8 as u16
                    };
                    let v = self.alu16(alu, a, x);
                    if alu != 7 {
                        self.set_rm16(b, ea, v)?
                    }
                }
            }
            0x84 => {
                let (reg, ea) = self.modrm(b)?;
                let a = self.rm8(b, ea);
                self.alu8(4, a, self.get8(reg));
            }
            0x85 => {
                let (reg, ea) = self.modrm(b)?;
                let a = self.rm16(b, ea)?;
                self.alu16(4, a, self.r[(reg & 7) as usize]);
            }
            0x86 => {
                let (reg, ea) = self.modrm(b)?;
                let a = self.rm8(b, ea);
                let r = self.get8(reg);
                self.set_rm8(b, ea, r);
                self.set8(reg, a);
            }
            0x87 => {
                let (reg, ea) = self.modrm(b)?;
                let a = self.rm16(b, ea)?;
                let r = self.r[(reg & 7) as usize];
                self.set_rm16(b, ea, r)?;
                self.r[(reg & 7) as usize] = a;
            }
            0x88 => {
                let (reg, ea) = self.modrm(b)?;
                let v = self.get8(reg);
                self.set_rm8(b, ea, v);
            }
            0x89 => {
                let (reg, ea) = self.modrm(b)?;
                let v = self.r[(reg & 7) as usize];
                self.set_rm16(b, ea, v)?;
            }
            0x8a => {
                let (reg, ea) = self.modrm(b)?;
                let v = self.rm8(b, ea);
                self.set8(reg, v);
            }
            0x8b => {
                let (reg, ea) = self.modrm(b)?;
                let v = self.rm16(b, ea)?;
                self.r[(reg & 7) as usize] = v;
            }
            0x8c => {
                let (reg, ea) = self.modrm(b)?;
                if reg > 3 {
                    return Err(Stop::Exc(6));
                }
                let v = self.s[(reg & 3) as usize];
                self.set_rm16(b, ea, v)?;
            }
            0x8d => {
                let (reg, ea) = self.modrm(b)?;
                let (_, off) = Self::mem_only(ea)?;
                self.r[(reg & 7) as usize] = off;
            }
            0x8e => {
                let (reg, ea) = self.modrm(b)?;
                if reg > 3 || reg == CS {
                    return Err(Stop::Exc(6));
                }
                let v = self.rm16(b, ea)?;
                self.s[(reg & 3) as usize] = v;
                if reg == SS {
                    self.irq_inhibit = true
                }
            }
            0x8f => {
                let (reg, ea) = self.modrm(b)?;
                if reg != 0 {
                    return Err(Stop::Exc(6));
                }
                let v = self.pop(b)?;
                self.set_rm16(b, ea, v)?;
            }
            0x90..=0x97 => {
                let r = (op & 7) as usize;
                self.r.swap(AX, r);
            }
            0x98 => self.r[AX] = self.r[AX] as u8 as i8 as i16 as u16,
            0x99 => self.r[DX] = if self.r[AX] & 0x8000 != 0 { 0xffff } else { 0 },
            0x9a => {
                let ip = self.fetch16(b)?;
                let cs = self.fetch16(b)?;
                let ocs = self.s[CS as usize];
                self.push(b, ocs)?;
                let oip = self.ip;
                self.push(b, oip)?;
                self.s[CS as usize] = cs;
                self.ip = ip;
            }
            0x9b => {}
            0x9c => {
                let f = self.flags & FLAGS_MASK | 0x0002;
                self.push(b, f)?;
            }
            0x9d => {
                let v = self.pop(b)?;
                self.load_flags(v);
            }
            0x9e => {
                let ah = (self.r[AX] >> 8) as u16;
                self.flags = (self.flags & 0xff00) | (ah & 0xd5) | 0x0002;
            }
            0x9f => {
                let f = (self.flags & 0xd5) | 0x02;
                self.set8(4, f as u8);
            }
            0xa0..=0xa3 => {
                let off = self.fetch16(b)?;
                let seg = self.seg_ovr.unwrap_or(DS);
                match op {
                    0xa0 => {
                        let v = self.rd8m(b, seg, off);
                        self.set8(0, v);
                    }
                    0xa1 => self.r[AX] = self.rd16m(b, seg, off)?,
                    0xa2 => self.wr8m(b, seg, off, self.r[AX] as u8),
                    _ => self.wr16m(b, seg, off, self.r[AX])?,
                }
            }
            0xa4..=0xa7 | 0xaa..=0xaf => self.string_op(b, op)?,
            0xa8 => {
                let x = self.fetch8(b)?;
                self.alu8(4, self.r[AX] as u8, x);
            }
            0xa9 => {
                let x = self.fetch16(b)?;
                self.alu16(4, self.r[AX], x);
            }
            0xb0..=0xb7 => {
                let v = self.fetch8(b)?;
                self.set8(op & 7, v);
            }
            0xb8..=0xbf => {
                let v = self.fetch16(b)?;
                self.r[(op & 7) as usize] = v;
            }
            0xc0 | 0xc1 | 0xd0..=0xd3 => {
                let (sop, ea) = self.modrm(b)?;
                let count = match op {
                    0xc0 | 0xc1 => self.fetch8(b)?,
                    0xd0 | 0xd1 => 1,
                    _ => self.r[CX] as u8,
                };
                if op & 1 == 0 {
                    let v = self.rm8(b, ea);
                    let r = self.shift(sop, v as u16, count, 8) as u8;
                    self.set_rm8(b, ea, r);
                } else {
                    let v = self.rm16(b, ea)?;
                    let r = self.shift(sop, v, count, 16);
                    self.set_rm16(b, ea, r)?;
                }
            }
            0xc2 | 0xc3 => {
                let n = if op == 0xc2 { self.fetch16(b)? } else { 0 };
                self.ip = self.pop(b)?;
                self.r[SP] = self.r[SP].wrapping_add(n);
            }
            0xc4 | 0xc5 => {
                let (reg, ea) = self.modrm(b)?;
                let (seg, off) = Self::mem_only(ea)?;
                let v = self.rd16m(b, seg, off)?;
                let s = self.rd16m(b, seg, off.wrapping_add(2))?;
                self.r[(reg & 7) as usize] = v;
                self.s[if op == 0xc4 { ES } else { DS } as usize] = s;
            }
            0xc6 => {
                let (reg, ea) = self.modrm(b)?;
                if reg != 0 {
                    return Err(Stop::Exc(6));
                }
                let v = self.fetch8(b)?;
                self.set_rm8(b, ea, v);
            }
            0xc7 => {
                let (reg, ea) = self.modrm(b)?;
                if reg != 0 {
                    return Err(Stop::Exc(6));
                }
                let v = self.fetch16(b)?;
                self.set_rm16(b, ea, v)?;
            }
            0xc8 => {
                // ENTER size, level
                let size = self.fetch16(b)?;
                let level = self.fetch8(b)? & 0x1f;
                let bp = self.r[BP];
                self.push(b, bp)?;
                let frame = self.r[SP];
                if level > 0 {
                    let mut p = bp;
                    for _ in 1..level {
                        p = p.wrapping_sub(2);
                        let v = self.rd16m(b, SS, p)?;
                        self.push(b, v)?;
                    }
                    self.push(b, frame)?;
                }
                self.r[BP] = frame;
                self.r[SP] = self.r[SP].wrapping_sub(size);
            }
            0xc9 => {
                // LEAVE: the old BP is read before SP changes (a fault leaves SP as it was)
                let v = self.rd16m(b, SS, self.r[BP])?;
                self.r[SP] = self.r[BP].wrapping_add(2);
                self.r[BP] = v;
            }
            0xca | 0xcb => {
                let n = if op == 0xca { self.fetch16(b)? } else { 0 };
                let ip = self.pop(b)?;
                let cs = self.pop(b)?;
                self.ip = ip;
                self.s[CS as usize] = cs;
                self.r[SP] = self.r[SP].wrapping_add(n);
            }
            0xcc => self.int_r(b, 3)?,
            0xcd => {
                let n = self.fetch8(b)?;
                self.int_r(b, n)?;
            }
            0xce => {
                if self.flag(OF) {
                    self.int_r(b, 4)?;
                }
            }
            0xcf => {
                let ip = self.pop(b)?;
                let cs = self.pop(b)?;
                let f = self.pop(b)?;
                self.ip = ip;
                self.s[CS as usize] = cs;
                self.load_flags(f);
            }
            0xd4 => {
                // AAM
                let d = self.fetch8(b)?;
                if d == 0 {
                    return Err(Stop::Exc(0));
                }
                let al = self.r[AX] as u8;
                let (q, r) = (al / d, al % d);
                self.r[AX] = (q as u16) << 8 | r as u16;
                self.szp8(r);
                self.flags &= !(CF | OF | AF);
            }
            0xd5 => {
                // AAD
                let d = self.fetch8(b)?;
                let al = self.r[AX] as u8;
                let ah = (self.r[AX] >> 8) as u8;
                let t = ah.wrapping_mul(d);
                let v = self.alu8(0, al, t);
                self.r[AX] = v as u16;
            }
            0xd6 => {
                let v = if self.flag(CF) { 0xff } else { 0 };
                self.set8(0, v);
            }
            0xd7 => {
                let seg = self.seg_ovr.unwrap_or(DS);
                let off = self.r[BX].wrapping_add(self.r[AX] & 0xff);
                let v = self.rd8m(b, seg, off);
                self.set8(0, v);
            }
            0xd8..=0xdf => {
                // ESC (no coprocessor): decode the operand and go on (a word at FFFFh faults)
                let (_, ea) = self.modrm(b)?;
                if let Ea::Mem { seg, off } = ea {
                    self.rd16m(b, seg, off)?;
                }
            }
            0xe0..=0xe3 => {
                let d = self.fetch8(b)? as i8 as u16;
                let go = if op == 0xe3 {
                    self.r[CX] == 0
                } else {
                    self.r[CX] = self.r[CX].wrapping_sub(1);
                    let nz = self.r[CX] != 0;
                    match op {
                        0xe0 => nz && !self.flag(ZF),
                        0xe1 => nz && self.flag(ZF),
                        _ => nz,
                    }
                };
                if go {
                    self.ip = self.ip.wrapping_add(d);
                }
            }
            0xe4 => {
                let p = self.fetch8(b)? as u16;
                let v = b.io_in8(p);
                self.set8(0, v);
            }
            0xe5 => {
                let p = self.fetch8(b)? as u16;
                self.r[AX] = b.io_in16(p);
            }
            0xe6 => {
                let p = self.fetch8(b)? as u16;
                self.out8(b, p, self.r[AX] as u8);
            }
            0xe7 => {
                let p = self.fetch8(b)? as u16;
                self.out16(b, p, self.r[AX]);
            }
            0xe8 => {
                let d = self.fetch16(b)?;
                let ip = self.ip;
                self.push(b, ip)?;
                self.ip = self.ip.wrapping_add(d);
            }
            0xe9 => {
                let d = self.fetch16(b)?;
                self.ip = self.ip.wrapping_add(d);
            }
            0xea => {
                let ip = self.fetch16(b)?;
                let cs = self.fetch16(b)?;
                self.ip = ip;
                self.s[CS as usize] = cs;
            }
            0xeb => {
                let d = self.fetch8(b)? as i8 as u16;
                self.ip = self.ip.wrapping_add(d);
            }
            0xec => {
                let v = b.io_in8(self.r[DX]);
                self.set8(0, v);
            }
            0xed => self.r[AX] = b.io_in16(self.r[DX]),
            0xee => self.out8(b, self.r[DX], self.r[AX] as u8),
            0xef => self.out16(b, self.r[DX], self.r[AX]),
            0xf4 => return Err(Stop::Halt),
            0xf5 => self.flags ^= CF,
            0xf6 | 0xf7 => self.group3(b, op)?,
            0xf8 => self.flags &= !CF,
            0xf9 => self.flags |= CF,
            0xfa => self.flags &= !IF,
            0xfb => {
                if !self.flag(IF) {
                    self.irq_inhibit = true
                }
                self.flags |= IF;
                self.recheck = true;
            }
            0xfc => self.flags &= !DF,
            0xfd => self.flags |= DF,
            0xfe => {
                let m = b.rd8(self.lin(CS, self.ip));
                if m == 0x38 {
                    // FE 38 nn: the machine's service nn
                    self.ip = self.ip.wrapping_add(1);
                    let n = self.fetch8(b)?;
                    return Err(Stop::Callback(n));
                }
                let (reg, ea) = self.modrm(b)?;
                let v = self.rm8(b, ea);
                let r = match reg {
                    0 => self.inc8(v),
                    1 => self.dec8(v),
                    _ => return Err(Stop::Exc(6)),
                };
                self.set_rm8(b, ea, r);
            }
            0xff => self.group5(b)?,
            _ => return Err(Stop::Exc(6)),
        }
        Ok(())
    }

    fn group3<B: Bus>(&mut self, b: &mut B, op: u8) -> R<()> {
        let (reg, ea) = self.modrm(b)?;
        if op == 0xf6 {
            let v = self.rm8(b, ea);
            match reg {
                0 | 1 => {
                    let x = self.fetch8(b)?;
                    self.alu8(4, v, x);
                }
                2 => self.set_rm8(b, ea, !v),
                3 => {
                    let r = self.alu8(5, 0, v);
                    self.set_rm8(b, ea, r);
                }
                4 => {
                    let p = (self.r[AX] as u8) as u16 * v as u16;
                    self.r[AX] = p;
                    let over = p & 0xff00 != 0;
                    self.setf(CF, over);
                    self.setf(OF, over);
                    self.szp8(p as u8);
                }
                5 => {
                    let p = (self.r[AX] as u8 as i8 as i16) * (v as i8 as i16);
                    self.r[AX] = p as u16;
                    let over = p != p as i8 as i16;
                    self.setf(CF, over);
                    self.setf(OF, over);
                    self.szp8(p as u8);
                }
                6 => {
                    if v == 0 {
                        return Err(Stop::Exc(0));
                    }
                    let n = self.r[AX];
                    let q = n / v as u16;
                    if q > 0xff {
                        return Err(Stop::Exc(0));
                    }
                    self.r[AX] = (n % v as u16) << 8 | q;
                }
                _ => {
                    if v == 0 {
                        return Err(Stop::Exc(0));
                    }
                    let n = self.r[AX] as i16 as i32;
                    let d = v as i8 as i32;
                    let q = n / d;
                    if !(-128..=127).contains(&q) {
                        return Err(Stop::Exc(0));
                    }
                    let r = n % d;
                    self.r[AX] = (r as u8 as u16) << 8 | q as u8 as u16;
                }
            }
        } else {
            let v = self.rm16(b, ea)?;
            match reg {
                0 | 1 => {
                    let x = self.fetch16(b)?;
                    self.alu16(4, v, x);
                }
                2 => self.set_rm16(b, ea, !v)?,
                3 => {
                    let r = self.alu16(5, 0, v);
                    self.set_rm16(b, ea, r)?;
                }
                4 => {
                    let p = self.r[AX] as u32 * v as u32;
                    self.r[AX] = p as u16;
                    self.r[DX] = (p >> 16) as u16;
                    let over = p & 0xffff_0000 != 0;
                    self.setf(CF, over);
                    self.setf(OF, over);
                    self.szp16(p as u16);
                }
                5 => {
                    let p = (self.r[AX] as i16 as i32) * (v as i16 as i32);
                    self.r[AX] = p as u16;
                    self.r[DX] = (p >> 16) as u16;
                    let over = p != p as i16 as i32;
                    self.setf(CF, over);
                    self.setf(OF, over);
                    self.szp16(p as u16);
                }
                6 => {
                    if v == 0 {
                        return Err(Stop::Exc(0));
                    }
                    let n = (self.r[DX] as u32) << 16 | self.r[AX] as u32;
                    let q = n / v as u32;
                    if q > 0xffff {
                        return Err(Stop::Exc(0));
                    }
                    self.r[AX] = q as u16;
                    self.r[DX] = (n % v as u32) as u16;
                }
                _ => {
                    if v == 0 {
                        return Err(Stop::Exc(0));
                    }
                    let n = ((self.r[DX] as u32) << 16 | self.r[AX] as u32) as i32 as i64;
                    let d = v as i16 as i64;
                    let q = n / d;
                    if !(-32768..=32767).contains(&q) {
                        return Err(Stop::Exc(0));
                    }
                    self.r[AX] = q as u16;
                    self.r[DX] = (n % d) as u16;
                }
            }
        }
        Ok(())
    }

    fn group5<B: Bus>(&mut self, b: &mut B) -> R<()> {
        let (reg, ea) = self.modrm(b)?;
        match reg {
            0 | 1 => {
                let v = self.rm16(b, ea)?;
                let r = if reg == 0 {
                    self.inc16(v)
                } else {
                    self.dec16(v)
                };
                self.set_rm16(b, ea, r)?;
            }
            2 => {
                let t = self.rm16(b, ea)?;
                let ip = self.ip;
                self.push(b, ip)?;
                self.ip = t;
            }
            3 => {
                let (seg, off) = Self::mem_only(ea)?;
                let ip = self.rd16m(b, seg, off)?;
                let cs = self.rd16m(b, seg, off.wrapping_add(2))?;
                let ocs = self.s[CS as usize];
                self.push(b, ocs)?;
                let oip = self.ip;
                self.push(b, oip)?;
                self.ip = ip;
                self.s[CS as usize] = cs;
            }
            4 => self.ip = self.rm16(b, ea)?,
            5 => {
                let (seg, off) = Self::mem_only(ea)?;
                let ip = self.rd16m(b, seg, off)?;
                let cs = self.rd16m(b, seg, off.wrapping_add(2))?;
                self.ip = ip;
                self.s[CS as usize] = cs;
            }
            6 => {
                // PUSH r/m (PUSH SP pushes SP as it was)
                let v = self.rm16(b, ea)?;
                self.push(b, v)?;
            }
            _ => return Err(Stop::Exc(6)),
        }
        Ok(())
    }

    fn op_0f<B: Bus>(&mut self, b: &mut B) -> R<()> {
        let op = self.fetch8(b)?;
        match op {
            0x01 => {
                let (reg, ea) = self.modrm(b)?;
                match reg {
                    0 | 1 => {
                        // SGDT, SIDT: limit, 24-bit base, then FFh
                        let (seg, off) = Self::mem_only(ea)?;
                        let (base, limit) = if reg == 0 { self.gdtr } else { self.idtr };
                        self.wr16m(b, seg, off, limit)?;
                        self.wr16m(b, seg, off.wrapping_add(2), base as u16)?;
                        self.wr16m(
                            b,
                            seg,
                            off.wrapping_add(4),
                            0xff00 | (base >> 16) as u16 & 0xff,
                        )?;
                    }
                    2 | 3 => {
                        let (seg, off) = Self::mem_only(ea)?;
                        let limit = self.rd16m(b, seg, off)?;
                        let lo = self.rd16m(b, seg, off.wrapping_add(2))? as u32;
                        let hi = self.rd16m(b, seg, off.wrapping_add(4))? as u32 & 0xff;
                        let v = ((hi << 16) | lo, limit);
                        if reg == 2 {
                            self.gdtr = v
                        } else {
                            self.idtr = v
                        }
                    }
                    4 => {
                        let v = self.msw;
                        self.set_rm16(b, ea, v)?;
                    }
                    6 => {
                        // LMSW: the PE bit cannot be cleared; real mode stays real here
                        let v = self.rm16(b, ea)?;
                        self.msw = (self.msw & 1) | (v & 0x000f) | 0xfff0;
                    }
                    _ => return Err(Stop::Exc(6)),
                }
            }
            0x06 => self.msw &= !0x0008,
            _ => return Err(Stop::Exc(6)),
        }
        Ok(())
    }

    /// MOVS CMPS STOS LODS SCAS INS OUTS, with REP/REPE/REPNE. A word at offset FFFFh
    /// faults (13) after the step's SI, DI and CX updates and without the access, as a 286 does.
    fn string_op<B: Bus>(&mut self, b: &mut B, op: u8) -> R<()> {
        let word = op & 1 == 1;
        let step: u16 = if word { 2 } else { 1 };
        let d = if self.flag(DF) {
            step.wrapping_neg()
        } else {
            step
        };
        let src = self.seg_ovr.unwrap_or(DS);
        let rep = self.rep != 0;
        let cmp = matches!(op, 0xa6 | 0xa7 | 0xae | 0xaf);
        let (uses_si, uses_di) = match op {
            0x6c | 0x6d | 0xaa | 0xab | 0xae | 0xaf => (false, true),
            0x6e | 0x6f | 0xac | 0xad => (true, false),
            _ => (true, true),
        };
        loop {
            if rep && self.r[CX] == 0 {
                break;
            }
            let (si, di) = (self.r[SI], self.r[DI]);
            if uses_si {
                self.r[SI] = si.wrapping_add(d)
            }
            if uses_di {
                self.r[DI] = di.wrapping_add(d)
            }
            if rep {
                self.r[CX] = self.r[CX].wrapping_sub(1);
            }
            if word && ((uses_si && si == 0xffff) || (uses_di && di == 0xffff)) {
                return Err(Stop::Exc(13));
            }
            match op {
                0x6c => {
                    let v = b.io_in8(self.r[DX]);
                    self.wr8m(b, ES, di, v);
                }
                0x6d => {
                    let v = b.io_in16(self.r[DX]);
                    self.wr16m(b, ES, di, v)?;
                }
                0x6e => {
                    let v = self.rd8m(b, src, si);
                    self.out8(b, self.r[DX], v);
                }
                0x6f => {
                    let v = self.rd16m(b, src, si)?;
                    self.out16(b, self.r[DX], v);
                }
                0xa4 => {
                    let v = self.rd8m(b, src, si);
                    self.wr8m(b, ES, di, v);
                }
                0xa5 => {
                    let v = self.rd16m(b, src, si)?;
                    self.wr16m(b, ES, di, v)?;
                }
                0xa6 => {
                    let x = self.rd8m(b, src, si);
                    let y = self.rd8m(b, ES, di);
                    self.alu8(7, x, y);
                }
                0xa7 => {
                    let x = self.rd16m(b, src, si)?;
                    let y = self.rd16m(b, ES, di)?;
                    self.alu16(7, x, y);
                }
                0xaa => self.wr8m(b, ES, di, self.r[AX] as u8),
                0xab => self.wr16m(b, ES, di, self.r[AX])?,
                0xac => {
                    let v = self.rd8m(b, src, si);
                    self.set8(0, v);
                }
                0xad => self.r[AX] = self.rd16m(b, src, si)?,
                0xae => {
                    let y = self.rd8m(b, ES, di);
                    self.alu8(7, self.r[AX] as u8, y);
                }
                _ => {
                    let y = self.rd16m(b, ES, di)?;
                    self.alu16(7, self.r[AX], y);
                }
            }
            if !rep {
                break;
            }
            self.count += 1;
            if cmp {
                let z = self.flag(ZF);
                if (self.rep == 0xf3 && !z) || (self.rep == 0xf2 && z) {
                    break;
                }
            }
        }
        Ok(())
    }
}
