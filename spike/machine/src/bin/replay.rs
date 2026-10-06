//! Replay a recorded session natively: the machine calls a probe made (probes/p6-bench.mjs
//! --record writes them), from boot, so the run is the same instruction for instruction. For
//! timing the interpreter without WebAssembly, and for profiling it:
//!
//!   cargo run --release --bin replay -- <files dir> <ops file> [program] [tail]
//!   CARGO_PROFILE_RELEASE_DEBUG=true cargo build --release --bin replay
//!   CALLGRIND=1 valgrind --tool=callgrind --instr-atstart=no target/release/replay <files> <ops>
//!
//! Ops, one a line: `c <cycles per ms>`, `r <ms>` (run), `k <scan code, hex>`, `w <linear address,
//! hex> <bytes, hex>` (a write to guest memory), `p` (the part to time starts; under callgrind with
//! CALLGRIND=1, instrumentation starts there), `e <instructions> <screen sum> <sum of the first 1088 KB>` (the end:
//! the counts the recording saw, checked here).

use f1gp_machine::pc::Machine;
use std::path::Path;

fn add_dir(m: &mut Machine, root: &Path, dir: &Path) {
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

/// CALLGRIND_START_INSTRUMENTATION (valgrind/callgrind.h): a no-op outside valgrind.
#[cfg(target_arch = "x86_64")]
fn callgrind_start() {
    let args: [u64; 6] = [0x4354_0004, 0, 0, 0, 0, 0];
    let mut result: u64 = 0;
    unsafe {
        std::arch::asm!(
            "rol rdi, 3", "rol rdi, 13", "rol rdi, 61", "rol rdi, 51",
            "xchg rbx, rbx",
            inout("rdx") result, in("rax") args.as_ptr(), inout("rdi") 0u64 => _,
        );
    }
    let _ = result;
}
#[cfg(not(target_arch = "x86_64"))]
fn callgrind_start() {}

/// The same sum as the recording's: x * 31 + y over the bytes, in 32 bits.
fn sum(b: &[u8]) -> u32 {
    b.iter()
        .fold(0u32, |x, &y| x.wrapping_mul(31).wrapping_add(y as u32))
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let files = Path::new(&args[1]);
    let ops = std::fs::read_to_string(&args[2]).unwrap();
    let program = args.get(3).cloned().unwrap_or("GP.EXE".into());
    let tail = args.get(4).cloned().unwrap_or(" /g".into());
    let mut m = Machine::new();
    add_dir(&mut m, files, files);
    m.start(&program, &tail).unwrap();
    let t0 = std::time::Instant::now();
    let mut mark: Option<(std::time::Instant, u64, f64)> = None;
    for line in ops.lines() {
        let mut f = line.split(' ');
        match f.next() {
            Some("c") => m.cycles_per_ms = f.next().unwrap().parse().unwrap(),
            Some("r") => m.run(f.next().unwrap().parse().unwrap()),
            Some("k") => m.key_byte(u8::from_str_radix(f.next().unwrap(), 16).unwrap()),
            Some("w") => {
                let at = usize::from_str_radix(f.next().unwrap(), 16).unwrap();
                let hex = f.next().unwrap();
                for i in 0..hex.len() / 2 {
                    m.hw.mem[at + i] = u8::from_str_radix(&hex[2 * i..2 * i + 2], 16).unwrap();
                }
            }
            Some("p") => {
                if std::env::var("CALLGRIND").is_ok() {
                    callgrind_start();
                }
                mark = Some((std::time::Instant::now(), m.cpu.count, m.hw.now));
            }
            Some("e") => {
                let want: Vec<u64> = f.map(|s| s.parse().unwrap()).collect();
                let got = [
                    m.cpu.count,
                    sum(m.render()) as u64,
                    sum(&m.hw.mem[..0x11_0000]) as u64,
                ];
                if want[..] != got[..] {
                    eprintln!(
                        "the replay differs from the recording: want {:?}, got {:?}",
                        want, got
                    );
                    std::process::exit(1);
                }
            }
            _ => {}
        }
    }
    let all = t0.elapsed().as_secs_f64();
    println!(
        "all: {} instructions in {:.2} s ({:.1} M/s)",
        m.cpu.count,
        all,
        m.cpu.count as f64 / all / 1e6
    );
    if let Some((t, n, g)) = mark {
        let s = t.elapsed().as_secs_f64();
        let n = m.cpu.count - n;
        println!(
            "from the mark: {} instructions, {:.1} s of game time, in {:.2} s ({:.1} M/s)",
            n,
            (m.hw.now - g) / 1e6,
            s,
            n as f64 / s / 1e6
        );
    }
}
