//! Expanded memory (LIM EMS 4.0, the functions games use): the "EMMXXXX0" device,
//! a 64 KB page frame at E000h of four 16 KB windows, and INT 67h to allocate,
//! map and free pages. A window holds its page's bytes while mapped; mapping
//! another page puts them back first.

use crate::cpu::{self, Cpu};
use crate::pc::Hw;
use std::collections::BTreeMap;

pub const FRAME_SEG: u16 = 0xe000;
const PAGE: usize = 16 * 1024;

pub struct Ems {
    pub pages: usize,
    store: Vec<Vec<u8>>,
    free: Vec<bool>,
    /// handle -> its pages (indices into store)
    handles: BTreeMap<u16, Vec<usize>>,
    next_handle: u16,
    /// each window's page (index into store), if any
    mapped: [Option<usize>; 4],
    pub log: String,
}

impl Ems {
    pub fn new(pages: usize) -> Ems {
        Ems {
            pages,
            store: vec![vec![0; PAGE]; pages],
            free: vec![true; pages],
            handles: BTreeMap::new(),
            next_handle: 1,
            mapped: [None; 4],
            log: String::new(),
        }
    }

    fn window(w: usize) -> usize {
        ((FRAME_SEG as usize) << 4) + w * PAGE
    }

    fn unmap(&mut self, hw: &mut Hw, w: usize) {
        if let Some(p) = self.mapped[w].take() {
            let a = Self::window(w);
            self.store[p].copy_from_slice(&hw.mem[a..a + PAGE]);
        }
    }

    fn map(&mut self, hw: &mut Hw, w: usize, page: Option<usize>) {
        if self.mapped[w] == page {
            return;
        }
        self.unmap(hw, w);
        if let Some(p) = page {
            // a page shown in another window too: take it from there first
            for o in 0..4 {
                if o != w && self.mapped[o] == Some(p) {
                    self.unmap(hw, o);
                }
            }
            let a = Self::window(w);
            hw.mem[a..a + PAGE].copy_from_slice(&self.store[p]);
            self.mapped[w] = Some(p);
        }
    }

    /// INT 67h.
    pub fn int67(&mut self, cpu: &mut Cpu, hw: &mut Hw) {
        let ax = cpu.r[cpu::AX];
        let (ah, al) = ((ax >> 8) as u8, ax as u8);
        let set_ah =
            |cpu: &mut Cpu, v: u8| cpu.r[cpu::AX] = (cpu.r[cpu::AX] & 0x00ff) | (v as u16) << 8;
        match ah {
            0x40 => set_ah(cpu, 0),
            0x41 => {
                cpu.r[cpu::BX] = FRAME_SEG;
                set_ah(cpu, 0);
            }
            0x42 => {
                cpu.r[cpu::BX] = self.free.iter().filter(|f| **f).count() as u16;
                cpu.r[cpu::DX] = self.pages as u16;
                set_ah(cpu, 0);
            }
            0x43 => {
                let n = cpu.r[cpu::BX] as usize;
                let free: Vec<usize> = (0..self.pages).filter(|&i| self.free[i]).take(n).collect();
                if free.len() < n {
                    set_ah(cpu, 0x88);
                } else {
                    for &i in &free {
                        self.free[i] = false;
                        self.store[i].fill(0);
                    }
                    let h = self.next_handle;
                    self.next_handle += 1;
                    self.handles.insert(h, free);
                    cpu.r[cpu::DX] = h;
                    set_ah(cpu, 0);
                }
            }
            0x44 => {
                let w = al as usize;
                let (bx, dx) = (cpu.r[cpu::BX], cpu.r[cpu::DX]);
                if w > 3 {
                    set_ah(cpu, 0x8b);
                } else if bx == 0xffff {
                    self.unmap(hw, w);
                    set_ah(cpu, 0);
                } else if let Some(p) = self
                    .handles
                    .get(&dx)
                    .and_then(|v| v.get(bx as usize))
                    .copied()
                {
                    self.map(hw, w, Some(p));
                    set_ah(cpu, 0);
                } else {
                    set_ah(
                        cpu,
                        if self.handles.contains_key(&dx) {
                            0x8a
                        } else {
                            0x83
                        },
                    );
                }
            }
            0x45 => {
                let dx = cpu.r[cpu::DX];
                if let Some(v) = self.handles.remove(&dx) {
                    for w in 0..4 {
                        if let Some(p) = self.mapped[w] {
                            if v.contains(&p) {
                                self.mapped[w] = None;
                            }
                        }
                    }
                    for p in v {
                        self.free[p] = true;
                    }
                    set_ah(cpu, 0);
                } else {
                    set_ah(cpu, 0x83);
                }
            }
            0x46 => cpu.r[cpu::AX] = 0x0040,
            0x4b => {
                cpu.r[cpu::BX] = self.handles.len() as u16;
                set_ah(cpu, 0);
            }
            0x4c => {
                let dx = cpu.r[cpu::DX];
                cpu.r[cpu::BX] = self.handles.get(&dx).map(|v| v.len() as u16).unwrap_or(0);
                set_ah(cpu, 0);
            }
            _ => {
                if self.log.len() < 4096 {
                    self.log.push_str(&format!("int67 {:02x} not served\n", ah));
                }
                set_ah(cpu, 0x84);
            }
        }
    }
}
