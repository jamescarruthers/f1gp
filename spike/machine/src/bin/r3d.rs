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
    for (seg, ips) in &seen {
        println!(
            "segment {seg:04x}: {} distinct instructions, from {:04x} to {:04x}",
            ips.len(),
            ips.first().unwrap(),
            ips.last().unwrap()
        );
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
        _ => eprintln!("r3d capture <files> <session> <out> [every] [count] | r3d check <out>"),
    }
}
