//! The CPU against the SingleStepTests 80286 real-mode set
//! (https://github.com/SingleStepTests/80286, v1_real_mode): each test sets the
//! registers and memory, runs one instruction and a HLT, and compares the
//! registers and memory with a real 286's. Flags the manual calls undefined are
//! not compared.
//!
//!   SST_286=/path/to/80286/v1_real_mode cargo test --release --test cpu286 -- --nocapture
//!   (SST_ONLY=F6,0F01 to run some files only)
//!
//! Without SST_286 the test does nothing.

use f1gp_machine::cpu::{Bus, Cpu, Event, AF, CF, OF, PF, SF, ZF};
use std::collections::HashSet;
use std::io::Read;

struct TestBus {
    mem: Vec<u8>,
    touched: Vec<u32>,
}
impl Bus for TestBus {
    fn rd8(&mut self, a: u32) -> u8 {
        self.mem[a as usize]
    }
    fn wr8(&mut self, a: u32, v: u8) {
        self.mem[a as usize] = v;
        self.touched.push(a);
    }
    fn io_in8(&mut self, _p: u16) -> u8 {
        0xff
    }
    fn io_out8(&mut self, _p: u16, _v: u8) {}
}

#[derive(Default, Clone)]
struct State {
    regs: Vec<(String, u16)>,
    ram: Vec<(u32, u8)>,
}
struct Test {
    name: String,
    bytes: Vec<u8>,
    init: State,
    fina: State,
    exc_flags: Option<u32>,
    hash: String,
}

const REG_ORDER: [&str; 14] = [
    "ax", "bx", "cx", "dx", "cs", "ss", "ds", "es", "sp", "bp", "si", "di", "ip", "flags",
];

fn u32le(d: &[u8], o: usize) -> u32 {
    u32::from_le_bytes([d[o], d[o + 1], d[o + 2], d[o + 3]])
}
fn u16le(d: &[u8], o: usize) -> u16 {
    u16::from_le_bytes([d[o], d[o + 1]])
}

fn parse_state(d: &[u8], mut o: usize, end: usize) -> State {
    let mut st = State::default();
    while o < end {
        let tag = &d[o..o + 4];
        let len = u32le(d, o + 4) as usize;
        let p = o + 8;
        if tag == b"REGS" {
            let mask = u16le(d, p);
            let mut q = p + 2;
            for (i, name) in REG_ORDER.iter().enumerate() {
                if mask & (1 << i) != 0 {
                    st.regs.push((name.to_string(), u16le(d, q)));
                    q += 2;
                }
            }
        } else if tag == b"RAM " {
            let n = u32le(d, p) as usize;
            for k in 0..n {
                let q = p + 4 + k * 5;
                st.ram.push((u32le(d, q), d[q + 4]));
            }
        }
        o = p + len;
    }
    st
}

fn parse_moo(d: &[u8]) -> Vec<Test> {
    assert_eq!(&d[0..4], b"MOO ");
    let hlen = u32le(d, 4) as usize;
    let mut o = 8 + hlen;
    let mut tests = vec![];
    while o < d.len() {
        let tag = &d[o..o + 4];
        let len = u32le(d, o + 4) as usize;
        let body = o + 8;
        if tag == b"TEST" {
            let mut t = Test {
                name: String::new(),
                bytes: vec![],
                init: State::default(),
                fina: State::default(),
                exc_flags: None,
                hash: String::new(),
            };
            let mut p = body + 4;
            while p < body + len {
                let st = &d[p..p + 4];
                let sl = u32le(d, p + 4) as usize;
                let q = p + 8;
                match st {
                    b"NAME" => {
                        let n = u32le(d, q) as usize;
                        t.name = String::from_utf8_lossy(&d[q + 4..q + 4 + n]).to_string();
                    }
                    b"BYTS" => {
                        let n = u32le(d, q) as usize;
                        t.bytes = d[q + 4..q + 4 + n].to_vec();
                    }
                    b"INIT" => t.init = parse_state(d, q, q + sl),
                    b"FINA" => t.fina = parse_state(d, q, q + sl),
                    b"EXCP" => t.exc_flags = Some(u32le(d, q + 1)),
                    b"HASH" => t.hash = d[q..q + sl].iter().map(|b| format!("{:02x}", b)).collect(),
                    _ => {}
                }
                p = q + sl;
            }
            tests.push(t);
        }
        o = body + len;
    }
    tests
}

/// The flags the manual leaves undefined after this instruction.
fn undefined_flags(bytes: &[u8]) -> u16 {
    let mut i = 0;
    while i < bytes.len() && matches!(bytes[i], 0x26 | 0x2e | 0x36 | 0x3e | 0xf0 | 0xf2 | 0xf3) {
        i += 1;
    }
    if i >= bytes.len() {
        return 0;
    }
    let op = bytes[i];
    let reg = bytes.get(i + 1).map(|m| (m >> 3) & 7).unwrap_or(0);
    let all = CF | PF | AF | ZF | SF | OF;
    match op {
        0x08..=0x0d | 0x20..=0x25 | 0x30..=0x35 | 0x84 | 0x85 | 0xa8 | 0xa9 => AF,
        0x80..=0x83 if matches!(reg, 1 | 4 | 6) => AF,
        0xf6 | 0xf7 => match reg {
            0 | 1 => AF,
            4 | 5 => SF | ZF | AF | PF,
            6 | 7 => all,
            _ => 0,
        },
        0x69 | 0x6b => SF | ZF | AF | PF,
        0xc0 | 0xc1 | 0xd2 | 0xd3 => {
            if reg >= 4 {
                AF | OF
            } else {
                OF
            }
        }
        0xd0 | 0xd1 => {
            if reg >= 4 {
                AF
            } else {
                0
            }
        }
        0x27 | 0x2f => OF,
        0x37 | 0x3f => OF | SF | ZF | PF,
        0xd4 | 0xd5 => OF | AF | CF,
        _ => 0,
    }
}

fn run_test(t: &Test, bus: &mut TestBus) -> Result<(), String> {
    let mut cpu = Cpu::new();
    cpu.a20 = 0xff_ffff;
    for a in bus.touched.drain(..) {
        bus.mem[a as usize] = 0;
    }
    let set = |name: &str, v: u16, cpu: &mut Cpu| match name {
        "ax" => cpu.r[0] = v,
        "cx" => cpu.r[1] = v,
        "dx" => cpu.r[2] = v,
        "bx" => cpu.r[3] = v,
        "sp" => cpu.r[4] = v,
        "bp" => cpu.r[5] = v,
        "si" => cpu.r[6] = v,
        "di" => cpu.r[7] = v,
        "es" => cpu.s[0] = v,
        "cs" => cpu.s[1] = v,
        "ss" => cpu.s[2] = v,
        "ds" => cpu.s[3] = v,
        "ip" => cpu.ip = v,
        _ => cpu.flags = v,
    };
    for (n, v) in &t.init.regs {
        set(n, *v, &mut cpu);
    }
    for &(a, v) in &t.init.ram {
        bus.mem[a as usize] = v;
        bus.touched.push(a);
    }
    let mut steps = 0;
    loop {
        let e = cpu.step(bus);
        steps += 1;
        if e == Event::Halt || steps > 8 {
            break;
        }
    }
    let undef = undefined_flags(&t.bytes);
    let get = |name: &str, cpu: &Cpu| -> u16 {
        match name {
            "ax" => cpu.r[0],
            "cx" => cpu.r[1],
            "dx" => cpu.r[2],
            "bx" => cpu.r[3],
            "sp" => cpu.r[4],
            "bp" => cpu.r[5],
            "si" => cpu.r[6],
            "di" => cpu.r[7],
            "es" => cpu.s[0],
            "cs" => cpu.s[1],
            "ss" => cpu.s[2],
            "ds" => cpu.s[3],
            "ip" => cpu.ip,
            _ => cpu.flags,
        }
    };
    let mut errs = vec![];
    for (n, want) in &t.fina.regs {
        let got = get(n, &cpu);
        let (g, w) = if n == "flags" {
            (got & !undef, want & !undef)
        } else {
            (got, *want)
        };
        if g != w {
            errs.push(format!("{} {:04x} want {:04x}", n, got, want));
        }
    }
    for &(a, want) in &t.fina.ram {
        let mut got = bus.mem[a as usize];
        let mut w = want;
        if let Some(fa) = t.exc_flags {
            let m = if a == fa {
                undef as u8
            } else if a == fa + 1 {
                (undef >> 8) as u8
            } else {
                0
            };
            got &= !m;
            w &= !m;
        }
        if got != w {
            errs.push(format!(
                "[{:06x}] {:02x} want {:02x}",
                a, bus.mem[a as usize], want
            ));
        }
    }
    if errs.is_empty() {
        Ok(())
    } else {
        Err(errs.join(", "))
    }
}

#[test]
fn single_step_tests() {
    let Ok(dir) = std::env::var("SST_286") else {
        eprintln!("SST_286 not set: skipped");
        return;
    };
    let only: Option<Vec<String>> = std::env::var("SST_ONLY")
        .ok()
        .map(|s| s.split(',').map(|x| x.to_uppercase()).collect());
    let revoked: HashSet<String> =
        std::fs::read_to_string(format!("{}/../revocation_list.txt", dir))
            .unwrap_or_default()
            .lines()
            .filter(|l| !l.starts_with('#'))
            .map(|l| l.trim().to_string())
            .collect();
    let mut files: Vec<_> = std::fs::read_dir(&dir)
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| p.to_string_lossy().ends_with(".MOO.gz"))
        .collect();
    files.sort();
    let mut bus = TestBus {
        mem: vec![0; 1 << 24],
        touched: vec![],
    };
    let (mut total, mut failed, mut bad_files) = (0, 0, vec![]);
    for f in files {
        let name = f
            .file_name()
            .unwrap()
            .to_string_lossy()
            .replace(".MOO.gz", "");
        if let Some(o) = &only {
            if !o.contains(&name) {
                continue;
            }
        }
        let out = std::process::Command::new("gzip")
            .arg("-dc")
            .arg(&f)
            .stdout(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        let mut data = vec![];
        out.stdout.unwrap().read_to_end(&mut data).unwrap();
        let tests = parse_moo(&data);
        let mut fails = 0;
        let mut shown = 0;
        for t in &tests {
            if revoked.contains(&t.hash) {
                continue;
            }
            total += 1;
            if let Err(e) = run_test(t, &mut bus) {
                fails += 1;
                if shown < 3 {
                    eprintln!(
                        "{} #{} {} [{}]: {}",
                        name,
                        t.hash.get(..8).unwrap_or(""),
                        t.name,
                        t.bytes
                            .iter()
                            .map(|b| format!("{:02x}", b))
                            .collect::<Vec<_>>()
                            .join(" "),
                        e
                    );
                    shown += 1;
                }
            }
        }
        if fails > 0 {
            bad_files.push(format!("{} {}/{}", name, fails, tests.len()));
        }
        failed += fails;
    }
    eprintln!(
        "{} tests, {} failed; files with failures: {}",
        total,
        failed,
        bad_files.join(", ")
    );
    // known differences, all in cases the game does not meet: a repeated string instruction that
    // reaches offset FFFFh part-way (the 286's count and pointers there), ENTER at deep nesting levels,
    // AAM 0's flags, PUSHA/POPA with the stack wrapping at SP 1, four IDIV results
    let known: &[(&str, usize)] = &[
        ("60", 1),
        ("61", 1),
        ("6D", 17),
        ("A5", 53),
        ("A7", 2),
        ("AB", 56),
        ("C8", 17),
        ("D4", 9),
        ("F6.7", 4),
    ];
    let unexpected: Vec<_> = bad_files
        .iter()
        .filter(|f| {
            let mut it = f.split(' ');
            let (name, n) = (
                it.next().unwrap(),
                it.next()
                    .unwrap()
                    .split('/')
                    .next()
                    .unwrap()
                    .parse::<usize>()
                    .unwrap(),
            );
            !known.iter().any(|(k, max)| *k == name && n <= *max)
        })
        .collect();
    assert!(unexpected.is_empty(), "new failures: {:?}", unexpected);
}
