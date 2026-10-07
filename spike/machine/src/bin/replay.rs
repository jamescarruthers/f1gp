//! Replay a recorded session natively: the machine calls a probe made (probes/p6-bench.mjs
//! --record writes them), from boot, so the run is the same instruction for instruction. For
//! timing the interpreter without WebAssembly, and for profiling it:
//!
//!   cargo run --release --bin replay -- <files dir> <ops file> [program] [tail]
//!   CARGO_PROFILE_RELEASE_DEBUG=true cargo build --release --bin replay
//!   CALLGRIND=1 valgrind --tool=callgrind --instr-atstart=no target/release/replay <files> <ops>
//!
//! The session's format is in src/session.rs. Its mark (`p`) starts the part timed (under
//! callgrind with CALLGRIND=1, instrumentation starts there); its end (`e`) is checked.

use f1gp_machine::session::{self, Op};
use std::path::Path;

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

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let files = Path::new(&args[1]);
    let ops = std::fs::read_to_string(&args[2]).unwrap();
    let program = args.get(3).cloned().unwrap_or("GP.EXE".into());
    let tail = args.get(4).cloned().unwrap_or(" /g".into());
    let mut m = session::machine(files, &program, &tail);
    let t0 = std::time::Instant::now();
    let mut mark: Option<(std::time::Instant, u64, f64)> = None;
    for op in session::parse(&ops) {
        match op {
            Op::Cycles(c) => m.cycles_per_ms = c,
            Op::Run(ms) => m.run(ms),
            Op::Key(k) => m.key_byte(k),
            Op::Write(at, bytes) => m.hw.mem[at..at + bytes.len()].copy_from_slice(&bytes),
            Op::Mark => {
                if std::env::var("CALLGRIND").is_ok() {
                    callgrind_start();
                }
                mark = Some((std::time::Instant::now(), m.cpu.count, m.hw.now));
            }
            Op::End(want) => {
                let got = session::sums(&mut m);
                if want != got {
                    eprintln!(
                        "the replay differs from the recording: want {:?}, got {:?}",
                        want, got
                    );
                    std::process::exit(1);
                }
            }
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
