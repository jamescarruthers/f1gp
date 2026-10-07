//! A recorded session: the machine calls a run in Node made from boot (lib/pc.mjs `record`;
//! probes/p6-bench.mjs --record, probes/p7-r3d-record.mjs), to play again natively,
//! instruction for instruction (src/bin/replay.rs, src/bin/r3d.rs).
//!
//! One call a line: `c <cycles per ms>`, `r <ms>` (run), `k <scan code, hex>`, `w <linear address,
//! hex> <bytes, hex>` (a write to guest memory), `p` (a mark: the part of interest starts),
//! `e <instructions> <screen sum> <sum of the first 1088 KB>` (the end, as the recording saw it).

use crate::pc::Machine;

pub enum Op {
    Cycles(f64),
    Run(f64),
    Key(u8),
    Write(usize, Vec<u8>),
    Mark,
    End([u64; 3]),
}

pub fn parse(text: &str) -> Vec<Op> {
    let mut ops = Vec::new();
    for line in text.lines() {
        let mut f = line.split(' ');
        let op = match f.next() {
            Some("c") => Op::Cycles(f.next().unwrap().parse().unwrap()),
            Some("r") => Op::Run(f.next().unwrap().parse().unwrap()),
            Some("k") => Op::Key(u8::from_str_radix(f.next().unwrap(), 16).unwrap()),
            Some("w") => {
                let at = usize::from_str_radix(f.next().unwrap(), 16).unwrap();
                let hex = f.next().unwrap();
                Op::Write(
                    at,
                    (0..hex.len() / 2)
                        .map(|i| u8::from_str_radix(&hex[2 * i..2 * i + 2], 16).unwrap())
                        .collect(),
                )
            }
            Some("p") => Op::Mark,
            Some("e") => {
                let v: Vec<u64> = f.map(|s| s.parse().unwrap()).collect();
                Op::End([v[0], v[1], v[2]])
            }
            _ => continue,
        };
        ops.push(op);
    }
    ops
}

/// The sums an `e` line records: instructions run, the screen (RGBA), the first 1088 KB of memory;
/// each sum is x * 31 + byte over the bytes, in 32 bits.
pub fn sums(m: &mut Machine) -> [u64; 3] {
    let sum = |b: &[u8]| {
        b.iter()
            .fold(0u32, |x, &y| x.wrapping_mul(31).wrapping_add(y as u32)) as u64
    };
    [m.cpu.count, sum(m.render()), sum(&m.hw.mem[..0x11_0000])]
}

/// A machine as a session starts: the files of a folder (the game's bundle unpacked) on drive C,
/// the program started.
#[cfg(not(target_arch = "wasm32"))]
pub fn machine(files: &std::path::Path, program: &str, tail: &str) -> Machine {
    fn add_dir(m: &mut Machine, root: &std::path::Path, dir: &std::path::Path) {
        for e in std::fs::read_dir(dir).unwrap() {
            let p = e.unwrap().path();
            if p.is_dir() {
                add_dir(m, root, &p);
            } else {
                let rel = p
                    .strip_prefix(root)
                    .unwrap()
                    .to_string_lossy()
                    .replace('/', "\\");
                if !rel.starts_with(".jsdos") {
                    m.add_file(&rel, std::fs::read(&p).unwrap());
                }
            }
        }
    }
    let mut m = Machine::new();
    add_dir(&mut m, files, files);
    m.start(program, tail).unwrap();
    m
}
