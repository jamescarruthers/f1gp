//! The game's 3D routine (0F47:81CE, once a frame: docs/renderer-notes.md), caught in a recorded
//! race, as the reference for rewriting it: each catch is the state the routine starts from and
//! the frame it leaves in the back buffer.
//!
//!   r3d capture <files dir> <session> <out dir> [every 8] [count 60]
//!       plays the session (src/session.rs) and, after its mark, catches every `every`th call:
//!       NNNN.snap (the CPU and memory at the routine's first instruction: pc::Snapshot) and
//!       NNNN.frame (the back buffer's linear address, 4 bytes, then its 64,000 bytes)
//!   r3d footprint <out dir>
//!       the distinct instructions the routine runs from the caught states, by code segment
//!   r3d check <out dir>
//!       runs the routine again from each state, alone (interrupts masked, the clock still), and
//!       compares the frame it leaves with the one caught
//!
//! Probes/p7-r3d-record.mjs records a session for it.

use f1gp_machine::pc::{Machine, Snapshot, HOOKS, RETURN_AT};
use f1gp_machine::session::{self, Op};
use std::path::{Path, PathBuf};

/// gp.exe's load segment on our machine (the PSP at 0192h), as under DOSBox
const IMAGE: u16 = 0x1a2;
/// the routine, as an image-relative segment and offset, and its first bytes: push ds; mov ds, ss:[00F4]
const SEG: u16 = 0x0f47;
const ENTRY: u16 = 0x81ce;
const FIRST: [u8; 6] = [0x1e, 0x36, 0x8e, 0x1e, 0xf4, 0x00];
const AT_ENTRY: u8 = HOOKS;
const AT_RETURN: u8 = HOOKS + 1;
const FRAME: usize = 64000;

fn lin(seg: u16, off: u16) -> u32 {
    ((seg as u32) << 4) + off as u32
}
fn rd16(m: &Machine, a: u32) -> u16 {
    m.hw.mem[a as usize] as u16 | (m.hw.mem[a as usize + 1] as u16) << 8
}

/// The back buffer's linear address: the far pointer R:001C, R the renderer's segment (SS:00F4).
fn back_buffer(m: &Machine) -> u32 {
    let ss = m.cpu.s[2];
    let r = rd16(m, lin(ss, 0xf4));
    lin(rd16(m, lin(r, 0x1e)), rd16(m, lin(r, 0x1c)))
}

fn capture(files: &Path, ops: &str, out: &Path, every: u64, count: usize) {
    std::fs::create_dir_all(out).unwrap();
    let mut m = session::machine(files, "GP.EXE", " /g");
    let entry = lin(SEG + IMAGE, ENTRY);
    let mut entry_old: Option<[u8; 3]> = None;
    let mut ret: Option<(u32, [u8; 3])> = None;
    let mut pending: Option<Snapshot> = None;
    let (mut calls, mut saved) = (0u64, 0usize);
    for op in session::parse(ops) {
        match op {
            Op::Cycles(c) => m.cycles_per_ms = c,
            Op::Key(k) => m.key_byte(k),
            Op::Write(at, bytes) => m.hw.mem[at..at + bytes.len()].copy_from_slice(&bytes),
            Op::Mark => {
                let a = entry as usize;
                assert_eq!(m.hw.mem[a..a + 6], FIRST, "not the routine at {:05x}", a);
                entry_old = Some(m.hook(entry, AT_ENTRY));
            }
            Op::End(want) => {
                if let Some(old) = entry_old.take() {
                    m.unhook(entry, old);
                }
                if let Some((at, old)) = ret.take() {
                    m.unhook(at, old);
                }
                let got = session::sums(&mut m);
                if want != got {
                    eprintln!(
                        "note: the run differs from the recording at its end: want {:?}, got {:?}",
                        want, got
                    );
                }
            }
            Op::Run(ms) => {
                let target = m.hw.now + ms * 1000.0;
                while let Some(n) = m.run_until(target) {
                    m.cpu.ip = m.cpu.ip.wrapping_sub(3);
                    if n == AT_ENTRY {
                        m.unhook(entry, entry_old.take().unwrap());
                        calls += 1;
                        if calls % every == 0 && saved < count {
                            pending = Some(m.snapshot());
                        }
                        // the caller's return address: a hook there tells when the routine is done
                        let sp = lin(m.cpu.s[2], m.cpu.r[4]);
                        let at = lin(rd16(&m, sp + 2), rd16(&m, sp));
                        ret = Some((at, m.hook(at, AT_RETURN)));
                    } else if n == AT_RETURN {
                        let (at, old) = ret.take().unwrap();
                        m.unhook(at, old);
                        if let Some(pre) = pending.take() {
                            let bb = back_buffer(&m);
                            let mut frame = bb.to_le_bytes().to_vec();
                            frame.extend_from_slice(&m.hw.mem[bb as usize..bb as usize + FRAME]);
                            std::fs::write(out.join(format!("{saved:04}.snap")), pre.to_bytes())
                                .unwrap();
                            std::fs::write(out.join(format!("{saved:04}.frame")), frame).unwrap();
                            saved += 1;
                        }
                        entry_old = Some(m.hook(entry, AT_ENTRY));
                    } else {
                        panic!("hook {n:02x}?");
                    }
                }
            }
        }
    }
    println!(
        "{calls} calls of the routine after the mark; {saved} caught in {}",
        out.display()
    );
}

fn caught(out: &Path) -> Vec<PathBuf> {
    let mut v: Vec<PathBuf> = std::fs::read_dir(out)
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| p.extension().is_some_and(|x| x == "snap"))
        .collect();
    v.sort();
    v
}

/// Run the routine alone from a caught state; the frame it leaves, and the instructions it took.
pub fn rerun(
    snap: &Snapshot,
    on_hook: &mut dyn FnMut(&mut Machine, u8),
) -> Result<(u32, Vec<u8>, u64), String> {
    let mut m = Machine::new();
    m.restore(snap);
    let (cs, ip) = (m.cpu.s[1], m.cpu.ip);
    // the caller's return address stays on the stack, as in the game; call_far adds its own below it
    let n = m.call_far(cs, ip, 50_000_000, on_hook)?;
    let bb = back_buffer(&m);
    Ok((bb, m.hw.mem[bb as usize..bb as usize + FRAME].to_vec(), n))
}

fn check(out: &Path) {
    let (mut same, mut total) = (0, 0);
    for p in caught(out) {
        let snap = Snapshot::from_bytes(&std::fs::read(&p).unwrap()).unwrap();
        let want = std::fs::read(p.with_extension("frame")).unwrap();
        let want_at = u32::from_le_bytes([want[0], want[1], want[2], want[3]]);
        total += 1;
        match rerun(&snap, &mut |_, n| panic!("hook {n:02x}?")) {
            Err(e) => println!("{}: {e}", p.display()),
            Ok((at, frame, n)) => {
                let diff = frame.iter().zip(&want[4..]).filter(|(a, b)| a != b).count();
                if diff == 0 && at == want_at {
                    same += 1;
                }
                println!(
                    "{}: {} instructions, {} of 64000 bytes differ{}",
                    p.file_name().unwrap().to_string_lossy(),
                    n,
                    diff,
                    if at != want_at {
                        format!(" (buffer at {at:05x}, caught at {want_at:05x})")
                    } else {
                        String::new()
                    }
                );
            }
        }
    }
    println!("{same} of {total} frames the same");
    if same != total {
        std::process::exit(1);
    }
}

/// The instructions the routine runs from each caught state: distinct addresses by code segment
/// (image-relative), with the bytes they span. How much code a rewrite has to cover.
fn footprint(out: &Path) {
    use std::collections::{BTreeMap, BTreeSet};
    let mut seen: BTreeMap<u16, BTreeSet<u16>> = BTreeMap::new();
    let mut steps = 0u64;
    for p in caught(out) {
        let snap = Snapshot::from_bytes(&std::fs::read(&p).unwrap()).unwrap();
        let mut m = Machine::new();
        m.restore(&snap);
        // a far call returning to the machine's stub (pc::RETURN_AT), stepped one instruction at a time
        let sp = m.cpu.r[4].wrapping_sub(4);
        m.cpu.r[4] = sp;
        let a = lin(m.cpu.s[2], sp) as usize;
        m.hw.mem[a..a + 4].copy_from_slice(&[RETURN_AT as u8, (RETURN_AT >> 8) as u8, 0x00, 0xf0]);
        m.hw.pic.imr = 0xff;
        loop {
            let (cs, ip) = (m.cpu.s[1], m.cpu.ip);
            if cs == 0xf000 && ip == RETURN_AT {
                break;
            }
            seen.entry(cs.wrapping_sub(IMAGE)).or_default().insert(ip);
            steps += 1;
            if let f1gp_machine::cpu::Event::Callback(n) = m.cpu.step(&mut m.hw) {
                panic!("callback {n:02x} at {cs:04x}:{ip:04x}");
            }
        }
    }
    println!("{steps} instructions run in all");
    if let Ok(file) = std::env::var("FOOTPRINT_OUT") {
        let lines: Vec<String> = seen
            .iter()
            .flat_map(|(seg, ips)| ips.iter().map(move |ip| format!("{seg:04x}:{ip:04x}")))
            .collect();
        std::fs::write(file, lines.join("\n") + "\n").unwrap();
    }
    for (seg, ips) in &seen {
        println!(
            "segment {seg:04x}: {} distinct instructions, from {:04x} to {:04x}",
            ips.len(),
            ips.first().unwrap(),
            ips.last().unwrap()
        );
    }
}

/// The polygon filler (0F47:0999, a far routine): R:000C/R:0010 its list of 4-byte entries (a
/// flags word, a pointer to a 10-byte edge record), R:0640 its mode, R:02F4 its colour.
const FILL: u16 = 0x0999;

/// One call of a routine: the state before it, and after the game's own code ran it alone.
struct Call {
    before: Snapshot,
    after: Snapshot,
}

/// Every call of the routine at SEG:`off` (a far routine) while the 3D routine draws a caught
/// frame: the state before each, and after the game's code.
fn calls_in(snap: &Snapshot, off: u16) -> Vec<Call> {
    let at = lin(SEG + IMAGE, off);
    let mut m = Machine::new();
    m.restore(snap);
    let old = m.hook(at, HOOKS + 2);
    let mut calls = Vec::new();
    let (cs, ip) = (m.cpu.s[1], m.cpu.ip);
    m.call_far(cs, ip, 50_000_000, &mut |m, _| {
        m.cpu.ip = m.cpu.ip.wrapping_sub(3);
        m.unhook(at, old);
        let mut before = m.snapshot();
        before.mem[at as usize..at as usize + 3].copy_from_slice(&old);
        m.call_far(SEG + IMAGE, off, 5_000_000, &mut |_, n| {
            panic!("hook {n:02x}")
        })
        .unwrap();
        calls.push(Call {
            before,
            after: m.snapshot(),
        });
        m.hook(at, HOOKS + 2);
        m.retf();
    })
    .unwrap();
    calls
}

/// The filler's calls in the first `frames` caught frames: what each was given and what it wrote.
fn fill_calls(out: &Path, frames: usize) {
    for p in caught(out).into_iter().take(frames) {
        let snap = Snapshot::from_bytes(&std::fs::read(&p).unwrap()).unwrap();
        let calls = calls_in(&snap, FILL);
        println!(
            "{}: {} calls",
            p.file_name().unwrap().to_string_lossy(),
            calls.len()
        );
        for (i, c) in calls.iter().enumerate() {
            let mem = &c.before.mem;
            let w = |a: u32| mem[a as usize] as u16 | (mem[a as usize + 1] as u16) << 8;
            let r = c.before.cpu.s[3];
            let rw = |o: u16| w(lin(r, o));
            let (start, end) = (rw(0x10), rw(0x0c));
            let mut entries = String::new();
            let mut e = start;
            while e != end && entries.len() < 400 {
                let rec = rw(e + 2);
                entries += &format!(
                    " [{:02x} {},{} {},{}]",
                    rw(e),
                    rw(rec) as i16,
                    rw(rec + 2) as i16,
                    rw(rec + 4) as i16,
                    rw(rec + 6) as i16
                );
                e = e.wrapping_add(4);
            }
            let bb = {
                let ss = c.before.cpu.s[2];
                let rr = w(lin(ss, 0xf4));
                lin(w(lin(rr, 0x1e)), w(lin(rr, 0x1c))) as usize
            };
            let rows: Vec<usize> = (0..200)
                .filter(|y| {
                    c.before.mem[bb + y * 320..bb + y * 320 + 320]
                        != c.after.mem[bb + y * 320..bb + y * 320 + 320]
                })
                .collect();
            let px = (bb..bb + FRAME)
                .filter(|&a| c.before.mem[a] != c.after.mem[a])
                .count();
            println!(
                "  {i:3}: colour {:02x} mode {:04x}{} -> {} px, rows {:?}..{:?}",
                mem[lin(r, 0x2f4) as usize],
                rw(0x640),
                entries,
                px,
                rows.first(),
                rows.last()
            );
        }
    }
}

/// The filler's calls in the first `frames` caught frames as JSON lines, for working out its rules:
/// what each was given (mode, colour, edges: flags and record words) and every pixel it wrote,
/// found by running it on two backgrounds (a pixel the same after both was written), as runs
/// [row, first x, last x, colour] (a run is a row's pixels of one colour, side by side).
fn dump_fills(out: &Path, frames: usize, file: &Path) {
    use std::io::Write;
    let mut f = std::io::BufWriter::new(std::fs::File::create(file).unwrap());
    let mut n = 0;
    for p in caught(out).into_iter().take(frames) {
        let snap = Snapshot::from_bytes(&std::fs::read(&p).unwrap()).unwrap();
        for c in calls_in(&snap, FILL) {
            let mem = &c.before.mem;
            let w = |a: u32| mem[a as usize] as u16 | (mem[a as usize + 1] as u16) << 8;
            let r = c.before.cpu.s[3];
            let rw = |o: u16| w(lin(r, o));
            let (start, end) = (rw(0x10), rw(0x0c));
            let mut edges = Vec::new();
            let mut e = start;
            while e != end && edges.len() < 64 {
                let rec = rw(e + 2);
                // the record: rows (first, last), x at each end, then a word and the x of each row
                let (y0, y1) = (rw(rec) as i16, rw(rec + 2) as i16);
                let rows = (y0 - y1).clamp(0, 200) as u16;
                let xs: Vec<String> = (0..=rows)
                    .map(|k| (rw(rec + 8 + 2 * k) as i16).to_string())
                    .collect();
                edges.push(format!(
                    "[{},{},{},{},{},{},[{}]]",
                    rw(e),
                    rec,
                    y0,
                    y1,
                    rw(rec + 4) as i16,
                    rw(rec + 6) as i16,
                    xs.join(",")
                ));
                e = e.wrapping_add(4);
            }
            let ss = c.before.cpu.s[2];
            let rr = w(lin(ss, 0xf4));
            let bb = lin(w(lin(rr, 0x1e)), w(lin(rr, 0x1c))) as usize;
            // the filler alone on two backgrounds
            let mut outs = Vec::new();
            for bg in [0x00u8, 0xff] {
                let mut m = Machine::new();
                m.restore(&c.before);
                m.hw.mem[bb..bb + FRAME].fill(bg);
                let (cs, ip) = (m.cpu.s[1], m.cpu.ip);
                m.call_far(cs, ip, 5_000_000, &mut |_, n| panic!("hook {n:02x}"))
                    .unwrap();
                outs.push(m.hw.mem[bb..bb + FRAME].to_vec());
            }
            let mut runs = Vec::new();
            for y in 0..200 {
                let mut x = 0;
                while x < 320 {
                    let i = y * 320 + x;
                    if outs[0][i] == outs[1][i] {
                        let v = outs[0][i];
                        let x0 = x;
                        while x < 320
                            && outs[0][y * 320 + x] == outs[1][y * 320 + x]
                            && outs[0][y * 320 + x] == v
                        {
                            x += 1;
                        }
                        runs.push(format!("[{y},{x0},{},{v}]", x - 1));
                    } else {
                        x += 1;
                    }
                }
            }
            writeln!(
                f,
                "{{\"frame\":\"{}\",\"mode\":{},\"colour\":{},\"edges\":[{}],\"runs\":[{}]}}",
                p.file_stem().unwrap().to_string_lossy(),
                rw(0x640),
                mem[lin(r, 0x2f4) as usize],
                edges.join(","),
                runs.join(",")
            )
            .unwrap();
            n += 1;
        }
    }
    println!("{n} calls to {}", file.display());
}

/// Our filler (r3d::fill) against the game's, call by call in the first `frames` caught frames:
/// from the state before each call, both must leave the same memory (all of it but the stack
/// below SP, where the game's pushes land) and the same registers.
fn fill_check(out: &Path, frames: usize) {
    let (mut same, mut total) = (0, 0);
    let mut shown = 0;
    for p in caught(out).into_iter().take(frames) {
        let snap = Snapshot::from_bytes(&std::fs::read(&p).unwrap()).unwrap();
        for (i, c) in calls_in(&snap, FILL).iter().enumerate() {
            total += 1;
            let mut m = Machine::new();
            m.restore(&c.before);
            let bp = m.cpu.r[5];
            let ax = f1gp_machine::r3d::fill::fill(f1gp_machine::r3d::Mem::of(&mut m), bp);
            m.cpu.r[0] = ax;
            let sp = lin(c.before.cpu.s[2], c.before.cpu.r[4]) as usize;
            let differ: Vec<usize> = (0..m.hw.mem.len())
                .filter(|&a| !(sp - 64..sp).contains(&a) && m.hw.mem[a] != c.after.mem[a])
                .collect();
            // CS is not compared: the game's routine returns to the machine's stub
            let regs = m.cpu.r == c.after.cpu.r
                && [0, 2, 3].iter().all(|&k| m.cpu.s[k] == c.after.cpu.s[k]);
            if differ.is_empty() && regs {
                same += 1;
            } else if shown < 12 {
                shown += 1;
                let r = (c.before.cpu.s[3] as usize) << 4;
                let first: Vec<String> = differ
                    .iter()
                    .take(8)
                    .map(|&a| {
                        let what = if a >= r && a < r + 0x10000 {
                            format!("R:{:04x}", a - r)
                        } else {
                            format!("{a:05x}")
                        };
                        format!(
                            "{what} ours {:02x} game {:02x}",
                            m.hw.mem[a], c.after.mem[a]
                        )
                    })
                    .collect();
                println!(
                    "{} call {i}: {} bytes differ{} {:?}",
                    p.file_name().unwrap().to_string_lossy(),
                    differ.len(),
                    if regs {
                        String::new()
                    } else {
                        format!(
                            "; registers ours {:04x?} game {:04x?}",
                            m.cpu.r, c.after.cpu.r
                        )
                    },
                    first
                );
            }
        }
    }
    println!("{same} of {total} calls the same");
    if same != total {
        std::process::exit(1);
    }
}

/// Each caught frame drawn with our routines in place of the game's (through hooks: the Rust
/// does the work and returns), against the frame caught: the same 64,000 bytes, and the
/// instructions the game's code still ran.
fn ours_check(out: &Path) {
    let (mut same, mut total) = (0, 0);
    let (mut theirs, mut left) = (0u64, 0u64);
    for p in caught(out) {
        let snap = Snapshot::from_bytes(&std::fs::read(&p).unwrap()).unwrap();
        let want = std::fs::read(p.with_extension("frame")).unwrap();
        total += 1;
        let (_, _, n_game) = rerun(&snap, &mut |_, n| panic!("hook {n:02x}?")).unwrap();
        theirs += n_game;
        let mut m = Machine::new();
        m.restore(&snap);
        let fill_at = lin(SEG + IMAGE, FILL);
        m.hook(fill_at, HOOKS + 2);
        let (cs, ip) = (m.cpu.s[1], m.cpu.ip);
        let n = m
            .call_far(cs, ip, 50_000_000, &mut |m, _| {
                let bp = m.cpu.r[5];
                let ax = f1gp_machine::r3d::fill::fill(f1gp_machine::r3d::Mem::of(m), bp);
                m.cpu.r[0] = ax;
                m.retf();
            })
            .unwrap();
        left += n;
        let bb = back_buffer(&m) as usize;
        let diff = m.hw.mem[bb..bb + FRAME]
            .iter()
            .zip(&want[4..])
            .filter(|(a, b)| a != b)
            .count();
        if diff == 0 {
            same += 1;
        } else {
            println!(
                "{}: {diff} of 64000 bytes differ",
                p.file_name().unwrap().to_string_lossy()
            );
        }
    }
    println!("{same} of {total} frames the same with our routines; the game's code ran {left} of {theirs} instructions ({:.1}%)", 100.0 * left as f64 / theirs as f64);
    if same != total {
        std::process::exit(1);
    }
}

fn main() {
    let a: Vec<String> = std::env::args().collect();
    match a.get(1).map(|s| s.as_str()) {
        Some("capture") => capture(
            Path::new(&a[2]),
            &std::fs::read_to_string(&a[3]).unwrap(),
            Path::new(&a[4]),
            a.get(5).map(|s| s.parse().unwrap()).unwrap_or(8),
            a.get(6).map(|s| s.parse().unwrap()).unwrap_or(60),
        ),
        Some("check") => check(Path::new(&a[2])),
        Some("footprint") => footprint(Path::new(&a[2])),
        Some("ours") => ours_check(Path::new(&a[2])),
        Some("fillcheck") => fill_check(
            Path::new(&a[2]),
            a.get(3).map(|s| s.parse().unwrap()).unwrap_or(usize::MAX),
        ),
        Some("dumpfills") => dump_fills(Path::new(&a[2]), a[3].parse().unwrap(), Path::new(&a[4])),
        Some("fills") => fill_calls(
            Path::new(&a[2]),
            a.get(3).map(|s| s.parse().unwrap()).unwrap_or(1),
        ),
        _ => eprintln!("r3d capture <files> <session> <out> [every] [count] | r3d check <out>"),
    }
}
