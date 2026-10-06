//! DOS, served in Rust: drive C as files in memory, the INT 21h functions the
//! game calls (files, find first/next, directories, vectors, date and time,
//! memory blocks, exit), and loading an EXE with its PSP and environment as
//! COMMAND.COM would. Files the program writes are marked, for the page to keep.

use crate::cpu::{self, Cpu, CF};
use crate::pc::Hw;
use std::collections::{BTreeMap, BTreeSet};

/// Where the environment and the PSP go (the PSP at 0192h puts gp.exe's image at 01A2h, as in DOSBox).
const ENV_SEG: u16 = 0x0182;
const PSP_SEG: u16 = 0x0192;
const MEM_TOP: u16 = 0xa000;
/// the handle the EMS device opens as (a character device; IOCTL says it is ready)
const EMS_HANDLE: u16 = 19;

struct Handle {
    path: String,
    pos: usize,
}

struct Find {
    /// the matching paths (directories with a backslash at the end)
    names: Vec<String>,
    next: usize,
}

pub struct Dos {
    /// drive C: uppercase paths with backslashes, no leading backslash
    pub files: BTreeMap<String, Vec<u8>>,
    pub dirs: BTreeSet<String>,
    /// files the program created or wrote
    pub changed: BTreeSet<String>,
    cwd: String,
    handles: Vec<Option<Handle>>,
    dta: (u16, u16),
    finds: BTreeMap<u32, Find>,
    /// memory blocks: segment -> paragraphs (the PSP's first)
    blocks: BTreeMap<u16, u16>,
    psp: u16,
    /// the date (year, month, day) and the time of day at the clock's 0 (s)
    pub date: (u32, u32, u32),
    pub day_start: f64,
    pub console: String,
    pub log: String,
    pub trace: bool,
}

impl Default for Dos {
    fn default() -> Self {
        Dos::new()
    }
}

fn lin(seg: u16, off: u16) -> usize {
    ((seg as usize) << 4) + off as usize
}

impl Dos {
    pub fn new() -> Dos {
        Dos {
            files: BTreeMap::new(),
            dirs: BTreeSet::new(),
            changed: BTreeSet::new(),
            cwd: String::new(),
            handles: (0..32).map(|_| None).collect(),
            dta: (PSP_SEG, 0x80),
            finds: BTreeMap::new(),
            blocks: BTreeMap::new(),
            psp: PSP_SEG,
            date: (1992, 5, 1),
            day_start: 12.0 * 3600.0,
            console: String::new(),
            log: String::new(),
            trace: false,
        }
    }

    fn note(&mut self, s: String) {
        if self.log.len() < 1 << 16 {
            self.log.push_str(&s);
            self.log.push('\n');
        }
    }

    pub fn add_file(&mut self, name: &str, data: Vec<u8>) {
        let p = name.replace('/', "\\").to_uppercase();
        let p = p.trim_start_matches('\\').to_string();
        if let Some(i) = p.rfind('\\') {
            let mut d = String::new();
            for part in p[..i].split('\\') {
                if !d.is_empty() {
                    d.push('\\');
                }
                d.push_str(part);
                self.dirs.insert(d.clone());
            }
        }
        if !p.ends_with('\\') && !p.is_empty() {
            self.files.insert(p, data);
        }
    }

    /// The time of day (h, m, s, hundredths) at the emulated clock's `now` (µs).
    pub fn clock(&self, now: f64) -> (u32, u32, u32, u32) {
        let t = self.day_start + now / 1e6;
        let s = t as u64 % 86400;
        (
            (s / 3600) as u32,
            (s / 60 % 60) as u32,
            (s % 60) as u32,
            ((t.fract()) * 100.0) as u32,
        )
    }

    // ------------------------------------------------------------ paths

    fn resolve(&self, raw: &str) -> String {
        let mut s = raw.trim().replace('/', "\\").to_uppercase();
        if s.len() >= 2 && s.as_bytes()[1] == b':' {
            s = s[2..].to_string();
        }
        let mut parts: Vec<String> = if s.starts_with('\\') {
            vec![]
        } else {
            self.cwd
                .split('\\')
                .filter(|p| !p.is_empty())
                .map(|p| p.to_string())
                .collect()
        };
        for p in s.split('\\') {
            match p {
                "" | "." => {}
                ".." => {
                    parts.pop();
                }
                _ => parts.push(p.to_string()),
            }
        }
        parts.join("\\")
    }

    fn read_str(hw: &Hw, seg: u16, off: u16) -> String {
        let mut s = String::new();
        let mut a = lin(seg, off);
        while hw.mem[a] != 0 && s.len() < 128 {
            s.push(hw.mem[a] as char);
            a += 1;
        }
        s
    }

    fn dir_of(path: &str) -> &str {
        path.rfind('\\').map(|i| &path[..i]).unwrap_or("")
    }

    // ------------------------------------------------------------ loading a program

    pub fn load_exe(
        &mut self,
        cpu: &mut Cpu,
        hw: &mut Hw,
        program: &str,
        tail: &str,
    ) -> Result<(), String> {
        let path = self.resolve(program);
        let data = self
            .files
            .get(&path)
            .ok_or(format!("{} not found", path))?
            .clone();
        // the environment: COMSPEC, PATH, then the program's full name
        let mut env = b"COMSPEC=C:\\COMMAND.COM\0PATH=C:\\\0\0\x01\0".to_vec();
        env.extend_from_slice(format!("C:\\{}\0", path).as_bytes());
        let e = lin(ENV_SEG, 0);
        hw.mem[e..e + env.len()].copy_from_slice(&env);
        // the PSP
        let p = lin(PSP_SEG, 0);
        hw.mem[p..p + 256].fill(0);
        hw.mem[p] = 0xcd;
        hw.mem[p + 1] = 0x20;
        hw.wr16((p + 2) as u32, MEM_TOP);
        hw.wr16((p + 0x2c) as u32, ENV_SEG);
        hw.mem[p + 0x50..p + 0x53].copy_from_slice(&[0xcd, 0x21, 0xcb]);
        let t = tail.as_bytes();
        hw.mem[p + 0x80] = t.len() as u8;
        hw.mem[p + 0x81..p + 0x81 + t.len()].copy_from_slice(t);
        hw.mem[p + 0x81 + t.len()] = 0x0d;
        for k in 0..20 {
            hw.mem[p + 0x18 + k] = if k < 5 { k as u8 } else { 0xff };
        }
        hw.wr16((p + 0x32) as u32, 20);
        hw.wr16((p + 0x34) as u32, 0x18);
        hw.wr16((p + 0x36) as u32, PSP_SEG);
        self.psp = PSP_SEG;
        self.dta = (PSP_SEG, 0x80);
        self.blocks.clear();
        self.blocks.insert(PSP_SEG, MEM_TOP - PSP_SEG);
        let load = PSP_SEG + 0x10;
        if data.len() > 2 && &data[0..2] == b"MZ" {
            let w = |o: usize| u16::from_le_bytes([data[o], data[o + 1]]);
            let (last, pages, nrel, hdr) = (
                w(2) as usize,
                w(4) as usize,
                w(6) as usize,
                w(8) as usize * 16,
            );
            let size = if last == 0 {
                pages * 512
            } else {
                (pages - 1) * 512 + last
            } - hdr;
            let a = lin(load, 0);
            hw.mem[a..a + size].copy_from_slice(&data[hdr..hdr + size]);
            let rel = w(0x18) as usize;
            for k in 0..nrel {
                let (off, seg) = (w(rel + k * 4), w(rel + k * 4 + 2));
                let at = lin(load + seg, off) as u32;
                let v = hw.rd16(at).wrapping_add(load);
                hw.wr16(at, v);
            }
            cpu.s[cpu::SS as usize] = w(0x0e).wrapping_add(load);
            cpu.r[cpu::SP] = w(0x10);
            cpu.s[cpu::CS as usize] = w(0x16).wrapping_add(load);
            cpu.ip = w(0x14);
        } else {
            let a = lin(PSP_SEG, 0x100);
            hw.mem[a..a + data.len()].copy_from_slice(&data);
            cpu.s[cpu::SS as usize] = PSP_SEG;
            cpu.s[cpu::CS as usize] = PSP_SEG;
            cpu.r[cpu::SP] = 0xfffe;
            cpu.ip = 0x100;
        }
        cpu.s[cpu::DS as usize] = PSP_SEG;
        cpu.s[cpu::ES as usize] = PSP_SEG;
        cpu.r[cpu::AX] = 0;
        cpu.r[cpu::BX] = 0;
        cpu.r[cpu::CX] = 0x00ff;
        cpu.r[cpu::DX] = PSP_SEG;
        cpu.r[cpu::SI] = cpu.ip;
        cpu.r[cpu::DI] = cpu.r[cpu::SP];
        cpu.r[cpu::BP] = 0x091c;
        cpu.load_flags(0x0202);
        self.note(format!(
            "load {} at {:04x}, entry {:04x}:{:04x}",
            path,
            load,
            cpu.s[cpu::CS as usize],
            cpu.ip
        ));
        Ok(())
    }

    // ------------------------------------------------------------ INT 21h

    fn set_cf(cpu: &Cpu, hw: &mut Hw, on: bool) {
        let a = cpu.lin(cpu::SS, cpu.r[cpu::SP].wrapping_add(4));
        let v = hw.rd16(a);
        hw.wr16(a, if on { v | CF } else { v & !CF });
    }
    fn fail(cpu: &mut Cpu, hw: &mut Hw, code: u16) {
        cpu.r[cpu::AX] = code;
        Self::set_cf(cpu, hw, true);
    }
    fn ok(cpu: &Cpu, hw: &mut Hw) {
        Self::set_cf(cpu, hw, false);
    }

    /// INT 21h. Returns Some(code) when the program exits.
    pub fn int21(&mut self, cpu: &mut Cpu, hw: &mut Hw) -> Option<u8> {
        let ax = cpu.r[cpu::AX];
        let (ah, al) = ((ax >> 8) as u8, ax as u8);
        let ds = cpu.s[cpu::DS as usize];
        let dx = cpu.r[cpu::DX];
        if self.trace {
            self.note(format!(
                "int21 {:02x} al {:02x} bx {:04x} cx {:04x} dx {:04x} from {:04x}:{:04x}",
                ah,
                al,
                cpu.r[cpu::BX],
                cpu.r[cpu::CX],
                dx,
                hw.rd16(cpu.lin(cpu::SS, cpu.r[cpu::SP].wrapping_add(2))),
                hw.rd16(cpu.lin(cpu::SS, cpu.r[cpu::SP]))
            ));
        }
        match ah {
            0x02 => self.console.push(dx as u8 as char),
            0x09 => {
                let mut a = lin(ds, dx);
                while hw.mem[a] != b'$' && self.console.len() < 1 << 16 {
                    self.console.push(hw.mem[a] as char);
                    a += 1;
                }
            }
            0x06 | 0x07 | 0x08 | 0x01 => cpu.r[cpu::AX] = ax & 0xff00,
            0x0b => cpu.r[cpu::AX] = ax & 0xff00,
            0x0e => cpu.r[cpu::AX] = (ax & 0xff00) | 3,
            0x19 => cpu.r[cpu::AX] = (ax & 0xff00) | 2,
            0x1a => self.dta = (ds, dx),
            0x2f => {
                cpu.s[cpu::ES as usize] = self.dta.0;
                cpu.r[cpu::BX] = self.dta.1;
            }
            0x25 => {
                let a = al as u32 * 4;
                hw.wr16(a, dx);
                hw.wr16(a + 2, ds);
            }
            0x35 => {
                let a = al as u32 * 4;
                cpu.r[cpu::BX] = hw.rd16(a);
                cpu.s[cpu::ES as usize] = hw.rd16(a + 2);
            }
            0x2a => {
                let (y, m, d) = self.date;
                cpu.r[cpu::CX] = y as u16;
                cpu.r[cpu::DX] = (m as u16) << 8 | d as u16;
                cpu.r[cpu::AX] = (ax & 0xff00) | 5;
            }
            0x2c => {
                let (h, m, s, c) = self.clock(hw.now);
                cpu.r[cpu::CX] = (h as u16) << 8 | m as u16;
                cpu.r[cpu::DX] = (s as u16) << 8 | c as u16;
            }
            0x30 => {
                cpu.r[cpu::AX] = 0x0005;
                cpu.r[cpu::BX] = 0;
                cpu.r[cpu::CX] = 0;
            }
            0x33 => cpu.r[cpu::DX] &= 0xff00,
            0x36 => {
                cpu.r[cpu::AX] = 64;
                cpu.r[cpu::BX] = 2000;
                cpu.r[cpu::CX] = 512;
                cpu.r[cpu::DX] = 4000;
            }
            0x39 | 0x3a | 0x3b => {
                let p = self.resolve(&Self::read_str(hw, ds, dx));
                match ah {
                    0x39 => {
                        self.dirs.insert(p);
                        Self::ok(cpu, hw);
                    }
                    0x3a => {
                        self.dirs.remove(&p);
                        Self::ok(cpu, hw);
                    }
                    _ => {
                        if p.is_empty() || self.dirs.contains(&p) {
                            self.cwd = p;
                            Self::ok(cpu, hw);
                        } else {
                            Self::fail(cpu, hw, 3);
                        }
                    }
                }
            }
            0x47 => {
                let a = cpu.lin(cpu::DS, cpu.r[cpu::SI]) as usize;
                let b = self.cwd.as_bytes();
                hw.mem[a..a + b.len()].copy_from_slice(b);
                hw.mem[a + b.len()] = 0;
                Self::ok(cpu, hw);
            }
            0x3c | 0x3d => {
                let name = Self::read_str(hw, ds, dx);
                let p = self.resolve(&name);
                if ah == 0x3d && p.ends_with("EMMXXXX0") {
                    // the EMS driver's device (lib's ems.rs): handle 3's slot, a character device
                    cpu.r[cpu::AX] = EMS_HANDLE;
                    Self::ok(cpu, hw);
                } else if ah == 0x3d && !self.files.contains_key(&p) {
                    let code =
                        if self.dirs.contains(Self::dir_of(&p)) || Self::dir_of(&p).is_empty() {
                            2
                        } else {
                            3
                        };
                    if self.trace || !name.to_uppercase().contains("EMMXXXX0") {
                        self.note(format!("open {} failed", p));
                    }
                    Self::fail(cpu, hw, code);
                } else {
                    if ah == 0x3c {
                        self.files.insert(p.clone(), vec![]);
                        self.changed.insert(p.clone());
                    }
                    match self.handles.iter().skip(5).position(|h| h.is_none()) {
                        Some(i) => {
                            self.handles[i + 5] = Some(Handle { path: p, pos: 0 });
                            cpu.r[cpu::AX] = (i + 5) as u16;
                            Self::ok(cpu, hw);
                        }
                        None => Self::fail(cpu, hw, 4),
                    }
                }
            }
            0x3e if cpu.r[cpu::BX] == EMS_HANDLE => Self::ok(cpu, hw),
            0x3e => {
                let h = cpu.r[cpu::BX] as usize;
                if h < self.handles.len() && h >= 5 {
                    self.handles[h] = None;
                }
                Self::ok(cpu, hw);
            }
            0x3f | 0x40 => {
                let h = cpu.r[cpu::BX] as usize;
                let n = cpu.r[cpu::CX] as usize;
                let buf = lin(ds, dx);
                if h < 5 {
                    if ah == 0x40 && (h == 1 || h == 2) {
                        for k in 0..n {
                            self.console.push(hw.mem[buf + k] as char);
                        }
                    }
                    cpu.r[cpu::AX] = if ah == 0x40 { n as u16 } else { 0 };
                    Self::ok(cpu, hw);
                } else if let Some(Some(f)) = self.handles.get_mut(h) {
                    let data = self.files.get_mut(&f.path).unwrap();
                    if ah == 0x3f {
                        let k = n.min(data.len().saturating_sub(f.pos));
                        hw.mem[buf..buf + k].copy_from_slice(&data[f.pos..f.pos + k]);
                        f.pos += k;
                        cpu.r[cpu::AX] = k as u16;
                    } else {
                        if n == 0 {
                            data.truncate(f.pos);
                        } else {
                            if data.len() < f.pos + n {
                                data.resize(f.pos + n, 0);
                            }
                            data[f.pos..f.pos + n].copy_from_slice(&hw.mem[buf..buf + n]);
                            f.pos += n;
                        }
                        self.changed.insert(f.path.clone());
                        cpu.r[cpu::AX] = n as u16;
                    }
                    Self::ok(cpu, hw);
                } else {
                    Self::fail(cpu, hw, 6);
                }
            }
            0x41 => {
                let p = self.resolve(&Self::read_str(hw, ds, dx));
                if self.files.remove(&p).is_some() {
                    self.changed.insert(p);
                    Self::ok(cpu, hw);
                } else {
                    Self::fail(cpu, hw, 2);
                }
            }
            0x42 => {
                let h = cpu.r[cpu::BX] as usize;
                let off = ((cpu.r[cpu::CX] as u32) << 16 | dx as u32) as i32 as i64;
                if let Some(Some(f)) = self.handles.get_mut(h) {
                    let len = self.files[&f.path].len() as i64;
                    let base = match al {
                        0 => 0,
                        1 => f.pos as i64,
                        _ => len,
                    };
                    let pos = (base + off).max(0) as usize;
                    f.pos = pos;
                    cpu.r[cpu::AX] = pos as u16;
                    cpu.r[cpu::DX] = (pos >> 16) as u16;
                    Self::ok(cpu, hw);
                } else {
                    Self::fail(cpu, hw, 6);
                }
            }
            0x43 => {
                let p = self.resolve(&Self::read_str(hw, ds, dx));
                if self.files.contains_key(&p) {
                    cpu.r[cpu::CX] = 0x20;
                    Self::ok(cpu, hw);
                } else if self.dirs.contains(&p) {
                    cpu.r[cpu::CX] = 0x10;
                    Self::ok(cpu, hw);
                } else {
                    Self::fail(cpu, hw, 2);
                }
            }
            0x44 => {
                let h = cpu.r[cpu::BX] as usize;
                match al {
                    0x00 => {
                        cpu.r[cpu::DX] = match h {
                            0..=2 => 0x80d3,
                            19 => 0x80c0,
                            3 => 0x80c0,
                            4 => 0xa8c0,
                            _ => 0x0002,
                        };
                        Self::ok(cpu, hw);
                    }
                    0x06 | 0x07 => {
                        cpu.r[cpu::AX] = (ax & 0xff00) | 0xff;
                        Self::ok(cpu, hw);
                    }
                    _ => Self::fail(cpu, hw, 1),
                }
            }
            0x48 => {
                let want = cpu.r[cpu::BX];
                match self.alloc(want) {
                    Ok(seg) => {
                        cpu.r[cpu::AX] = seg;
                        Self::ok(cpu, hw);
                    }
                    Err(max) => {
                        cpu.r[cpu::BX] = max;
                        Self::fail(cpu, hw, 8);
                    }
                }
            }
            0x49 => {
                let seg = cpu.s[cpu::ES as usize];
                self.blocks.remove(&seg);
                Self::ok(cpu, hw);
            }
            0x4a => {
                let seg = cpu.s[cpu::ES as usize];
                let want = cpu.r[cpu::BX];
                let limit = self
                    .blocks
                    .range(seg + 1..)
                    .next()
                    .map(|(s, _)| *s)
                    .unwrap_or(MEM_TOP);
                if seg as u32 + want as u32 <= limit as u32 {
                    self.blocks.insert(seg, want);
                    Self::ok(cpu, hw);
                } else {
                    cpu.r[cpu::BX] = limit - seg;
                    Self::fail(cpu, hw, 8);
                }
            }
            0x4c => return Some(al),
            0x4e | 0x4f => self.find(cpu, hw, ah == 0x4e),
            0x50 => self.psp = cpu.r[cpu::BX],
            0x51 | 0x62 => cpu.r[cpu::BX] = self.psp,
            0x57 => {
                if al == 0 {
                    cpu.r[cpu::CX] = 0x6000;
                    cpu.r[cpu::DX] = 0x18a1;
                }
                Self::ok(cpu, hw);
            }
            _ => {
                self.note(format!("int21 {:02x} (al {:02x}) not served", ah, al));
                Self::fail(cpu, hw, 1);
            }
        }
        None
    }

    fn alloc(&mut self, want: u16) -> Result<u16, u16> {
        // the first gap that fits, between the blocks and up to the top of memory
        let mut at = PSP_SEG;
        let mut best = 0u16;
        let list: Vec<(u16, u16)> = self.blocks.iter().map(|(s, n)| (*s, *n)).collect();
        let mut i = 0;
        loop {
            let end = if i < list.len() { list[i].0 } else { MEM_TOP };
            if end > at {
                let room = end - at;
                if room >= want {
                    self.blocks.insert(at, want);
                    return Ok(at);
                }
                best = best.max(room);
            }
            if i >= list.len() {
                return Err(best);
            }
            at = at.max(list[i].0.saturating_add(list[i].1));
            i += 1;
        }
    }

    fn find(&mut self, cpu: &mut Cpu, hw: &mut Hw, first: bool) {
        let dta = lin(self.dta.0, self.dta.1);
        let key = dta as u32;
        if first {
            let pat = self.resolve(&Self::read_str(hw, cpu.s[cpu::DS as usize], cpu.r[cpu::DX]));
            let attrs = cpu.r[cpu::CX];
            let dir = Self::dir_of(&pat).to_string();
            let name_of = |p: &str| p[if dir.is_empty() { 0 } else { dir.len() + 1 }..].to_string();
            let mask = name_of(&pat);
            // the full paths that match, in the directory searched (directories end with a backslash)
            let mut paths: Vec<String> = self
                .files
                .keys()
                .filter(|p| Self::dir_of(p) == dir && wild_match(&mask, &name_of(p)))
                .cloned()
                .collect();
            if attrs & 0x10 != 0 {
                for d in &self.dirs {
                    if Self::dir_of(d) == dir && wild_match(&mask, &name_of(d)) {
                        paths.push(format!("{}\\", d));
                    }
                }
            }
            paths.sort();
            if self.trace {
                self.note(format!("find {} -> {:?}", pat, paths));
            }
            self.finds.insert(
                key,
                Find {
                    names: paths,
                    next: 0,
                },
            );
        }
        let Some(f) = self.finds.get_mut(&key) else {
            Self::fail(cpu, hw, 18);
            return;
        };
        if f.next >= f.names.len() {
            Self::fail(cpu, hw, 18);
            return;
        }
        let path = f.names[f.next].clone();
        f.next += 1;
        let is_dir = path.ends_with('\\');
        let full = path.trim_end_matches('\\');
        let n = full.rsplit('\\').next().unwrap_or(full);
        let size = if is_dir {
            0
        } else {
            self.files.get(full).map(|d| d.len()).unwrap_or(0)
        };
        hw.mem[dta + 0x15] = if is_dir { 0x10 } else { 0x20 };
        hw.wr16((dta + 0x16) as u32, 0x6000);
        hw.wr16((dta + 0x18) as u32, 0x18a1);
        hw.wr16((dta + 0x1a) as u32, size as u16);
        hw.wr16((dta + 0x1c) as u32, (size >> 16) as u16);
        hw.mem[dta + 0x1e..dta + 0x1e + 13].fill(0);
        let b = n.as_bytes();
        hw.mem[dta + 0x1e..dta + 0x1e + b.len().min(12)].copy_from_slice(&b[..b.len().min(12)]);
        Self::ok(cpu, hw);
    }
}

/// A DOS wildcard match of an 8.3 name ("*.SAV", "????????.???", "*.*").
pub fn wild_match(mask: &str, name: &str) -> bool {
    let split = |s: &str| -> (String, String) {
        match s.rfind('.') {
            Some(i) => (s[..i].to_string(), s[i + 1..].to_string()),
            None => (s.to_string(), String::new()),
        }
    };
    let (mb, me) = split(mask);
    let (nb, ne) = split(name);
    let part = |m: &str, n: &str, len: usize| -> bool {
        let mut mm: Vec<char> = vec![];
        for c in m.chars() {
            if c == '*' {
                while mm.len() < len {
                    mm.push('?');
                }
                break;
            }
            mm.push(c);
        }
        while mm.len() < len {
            mm.push(' ');
        }
        let mut nn: Vec<char> = n.chars().collect();
        while nn.len() < len {
            nn.push(' ');
        }
        mm.iter().zip(nn.iter()).all(|(a, b)| *a == '?' || a == b)
    };
    part(&mb, &nb, 8) && part(&me, &ne, 3)
}
