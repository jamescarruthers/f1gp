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
//!   r3d profile <out dir>
//!       where the routine's instructions go, routine by routine
//!   r3d calls <out dir> [fill|edge|border|ground|bitmap|all] [frames]
//!       our routines (OURS) against the game's, call by call
//!   r3d fuzz <out dir> [edge|border|ground|bitmap|all] [trials 20000]
//!       our near routines against the game's on made-up calls
//!   r3d ours <out dir>
//!       each caught frame drawn with our routines in place of the game's, against the one caught
//!
//! Probes/p7-r3d-record.mjs records a session for it.

use f1gp_machine::pc::{Machine, Snapshot, HOOKS, RETURN_AT};
use f1gp_machine::r3d;
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

/// Where the routine's instructions go, from each caught state: a call stack kept beside the
/// CPU's (a call pushes its target, a return past the SP it was called at pops it) gives each
/// routine its calls, its instructions with what it calls (inclusive) and without (its own).
fn profile(out: &Path) {
    use std::collections::HashMap;
    #[derive(Default)]
    struct Row {
        calls: u64,
        all: u64,
        own: u64,
        callers: HashMap<(u16, u16), u64>,
    }
    let mut rows: HashMap<(u16, u16), Row> = HashMap::new();
    let mut total = 0u64;
    for p in caught(out) {
        let snap = Snapshot::from_bytes(&std::fs::read(&p).unwrap()).unwrap();
        let mut m = Machine::new();
        m.restore(&snap);
        let sp = m.cpu.r[4].wrapping_sub(4);
        m.cpu.r[4] = sp;
        let a = lin(m.cpu.s[2], sp) as usize;
        m.hw.mem[a..a + 4].copy_from_slice(&[RETURN_AT as u8, (RETURN_AT >> 8) as u8, 0x00, 0xf0]);
        m.hw.pic.imr = 0xff;
        let top = (m.cpu.s[1].wrapping_sub(IMAGE), m.cpu.ip);
        // (routine, SP before the call, instructions run when it was called)
        let mut stack: Vec<((u16, u16), u16, u64)> = vec![(top, m.cpu.r[4].wrapping_add(4), 0)];
        rows.entry(top).or_default().calls += 1;
        let start = m.cpu.count;
        loop {
            let (cs, ip) = (m.cpu.s[1], m.cpu.ip);
            if cs == 0xf000 && ip == RETURN_AT {
                break;
            }
            let at = lin(cs, ip) as usize;
            let mut k = at;
            while matches!(m.hw.mem[k], 0x26 | 0x2e | 0x36 | 0x3e) {
                k += 1;
            }
            let call = match m.hw.mem[k] {
                0xe8 | 0x9a => true,
                0xff => matches!((m.hw.mem[k + 1] >> 3) & 7, 2 | 3),
                _ => false,
            };
            let sp_before = m.cpu.r[4];
            rows.get_mut(&stack.last().unwrap().0).unwrap().own += 1;
            if let f1gp_machine::cpu::Event::Callback(n) = m.cpu.step(&mut m.hw) {
                panic!("callback {n:02x} at {cs:04x}:{ip:04x}");
            }
            if call {
                let to = (m.cpu.s[1].wrapping_sub(IMAGE), m.cpu.ip);
                let from = stack.last().unwrap().0;
                let r = rows.entry(to).or_default();
                r.calls += 1;
                *r.callers.entry(from).or_default() += 1;
                stack.push((to, sp_before, m.cpu.count));
            } else {
                while stack.len() > 1 && m.cpu.r[4] >= stack.last().unwrap().1 {
                    let (f, _, n) = stack.pop().unwrap();
                    rows.get_mut(&f).unwrap().all += m.cpu.count - n;
                }
            }
        }
        let n = m.cpu.count - start;
        rows.get_mut(&top).unwrap().all += n;
        total += n;
    }
    let mut v: Vec<_> = rows.into_iter().collect();
    v.sort_by_key(|r| std::cmp::Reverse(r.1.all));
    println!(
        "{total} instructions; routine (image-relative), calls, with callees, own, top callers"
    );
    for ((seg, off), r) in v.iter().take(70) {
        let mut c: Vec<_> = r.callers.iter().collect();
        c.sort_by(|a, b| b.1.cmp(a.1));
        let callers: Vec<String> = c
            .iter()
            .take(3)
            .map(|((s, o), n)| format!("{s:04x}:{o:04x} x{n}"))
            .collect();
        println!(
            "{seg:04x}:{off:04x} {:7} {:5.1}% {:5.1}%  {}",
            r.calls,
            100.0 * r.all as f64 / total as f64,
            100.0 * r.own as f64 / total as f64,
            callers.join(", ")
        );
    }
}

/// The polygon filler (0F47:0999, a far routine): R:000C/R:0010 its list of 4-byte entries (a
/// flags word, a pointer to a 10-byte edge record), R:0640 its mode, R:02F4 its colour.
const FILL: u16 = 0x0999;

/// The edge builder (0F47:03E9) and the border edge (02E4): near routines that write the edge
/// records the filler reads.
const EDGE: u16 = 0x03e9;
const BORDER: u16 = 0x02e4;
const AT_CALL: u8 = HOOKS + 2;
const AT_BACK: u8 = HOOKS + 3;

/// A routine we have rewritten: the game's (its offset in SEG, whether it is called near), and
/// ours, which does its work on the machine as the game's would from its first instruction.
struct Ours {
    name: &'static str,
    off: u16,
    near: bool,
    run: fn(&mut Machine),
}

/// The ground texture (0F47:7F64), a near routine run after the scene with the T option on.
const GROUND: u16 = 0x7f64;

/// The bitmap drawer (0F47:19E8), a near routine.
const BITMAP: u16 = 0x19e8;

const OURS: [Ours; 5] = [
    Ours {
        name: "fill",
        off: FILL,
        near: false,
        run: |m| {
            let bp = m.cpu.r[5];
            m.cpu.r[0] = r3d::fill::fill(r3d::Mem::of(m), bp);
        },
    },
    Ours {
        name: "edge",
        off: EDGE,
        near: true,
        run: |m| {
            let r = m.cpu.r;
            r3d::edge::edge(r3d::Mem::of(m), r[5], r[0], r[1], r[2], r[7]);
        },
    },
    Ours {
        name: "border",
        off: BORDER,
        near: true,
        run: |m| {
            let r = m.cpu.r;
            r3d::edge::border(
                r3d::Mem::of(m),
                r[5],
                r[0],
                r[3] as u8,
                r[1],
                r[2],
                r[6],
                r[7],
            );
        },
    },
    Ours {
        name: "ground",
        off: GROUND,
        near: true,
        run: |m| {
            let bp = m.cpu.r[5];
            r3d::ground::ground(r3d::Mem::of(m), bp);
        },
    },
    Ours {
        name: "bitmap",
        off: BITMAP,
        near: true,
        run: |m| {
            let r = m.cpu.r;
            r3d::bitmap::bitmap(r3d::Mem::of(m), r[5], r[0], r[1], r[2]);
        },
    },
];

/// One call of a routine: the state at its first instruction, and back at its caller after the
/// game's own code ran it.
struct Call {
    before: Snapshot,
    after: Snapshot,
}

/// Every call of the routine at SEG:`off` (`near` or far) while the 3D routine draws a caught
/// frame: a hook at its entry, and for each call another at the return address it was given.
fn calls_in(snap: &Snapshot, off: u16, near: bool) -> Vec<Call> {
    let at = lin(SEG + IMAGE, off);
    let mut m = Machine::new();
    m.restore(snap);
    let old = m.hook(at, AT_CALL);
    let mut calls = Vec::new();
    let mut back: Option<(u32, [u8; 3], Snapshot)> = None;
    let (cs, ip) = (m.cpu.s[1], m.cpu.ip);
    m.call_far(cs, ip, 50_000_000, &mut |m, n| {
        m.cpu.ip = m.cpu.ip.wrapping_sub(3);
        if n == AT_CALL {
            m.unhook(at, old);
            let before = m.snapshot();
            let sp = lin(m.cpu.s[2], m.cpu.r[4]);
            let cs = if near { m.cpu.s[1] } else { rd16(m, sp + 2) };
            let ret = lin(cs, rd16(m, sp));
            back = Some((ret, m.hook(ret, AT_BACK), before));
        } else {
            let (ret, bytes, before) = back.take().expect("a return with no call");
            m.unhook(ret, bytes);
            calls.push(Call {
                before,
                after: m.snapshot(),
            });
            m.hook(at, AT_CALL);
        }
    })
    .unwrap();
    calls
}

/// The filler's calls in the first `frames` caught frames: what each was given and what it wrote.
fn fill_calls(out: &Path, frames: usize) {
    for p in caught(out).into_iter().take(frames) {
        let snap = Snapshot::from_bytes(&std::fs::read(&p).unwrap()).unwrap();
        let calls = calls_in(&snap, FILL, false);
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
        for c in calls_in(&snap, FILL, false) {
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

/// Our routines (OURS, or the one named) against the game's, call by call in the first `frames`
/// caught frames: from the state before each call, both must leave the same memory (all of it but
/// the stack below SP, where the game's pushes land) and the same registers.
fn calls_check(out: &Path, which: &str, frames: usize) {
    let mut failed = false;
    for o in OURS.iter().filter(|o| which == "all" || which == o.name) {
        let (mut same, mut total) = (0, 0);
        let mut shown = 0;
        for p in caught(out).into_iter().take(frames) {
            let snap = Snapshot::from_bytes(&std::fs::read(&p).unwrap()).unwrap();
            for (i, c) in calls_in(&snap, o.off, o.near).iter().enumerate() {
                total += 1;
                let mut m = Machine::new();
                m.restore(&c.before);
                (o.run)(&mut m);
                if o.near {
                    m.ret();
                } else {
                    m.retf();
                }
                let sp = lin(c.before.cpu.s[2], c.before.cpu.r[4]) as usize;
                let differ: Vec<usize> = (0..m.hw.mem.len())
                    .filter(|&a| !(sp - 128..sp).contains(&a) && m.hw.mem[a] != c.after.mem[a])
                    .collect();
                let regs = m.cpu.r == c.after.cpu.r
                    && m.cpu.s == c.after.cpu.s
                    && m.cpu.ip == c.after.cpu.ip;
                if differ.is_empty() && regs {
                    same += 1;
                } else if shown < 12 {
                    shown += 1;
                    let r = (c.before.cpu.s[3] as usize) << 4;
                    let s = (c.before.cpu.s[2] as usize) << 4;
                    let first: Vec<String> = differ
                        .iter()
                        .take(8)
                        .map(|&a| {
                            let what = if a >= r && a < r + 0x10000 {
                                format!("R:{:04x}", a - r)
                            } else if a >= s && a < s + 0x10000 {
                                format!("SS:{:04x}", a - s)
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
                        "{} {} call {i}: {} bytes differ{} {:?}",
                        o.name,
                        p.file_name().unwrap().to_string_lossy(),
                        differ.len(),
                        if regs {
                            String::new()
                        } else {
                            format!(
                                "; registers ours {:04x?} {:04x?} {:04x} game {:04x?} {:04x?} {:04x}",
                                m.cpu.r,
                                m.cpu.s,
                                m.cpu.ip,
                                c.after.cpu.r,
                                c.after.cpu.s,
                                c.after.cpu.ip
                            )
                        },
                        first
                    );
                }
            }
        }
        println!("{}: {same} of {total} calls the same", o.name);
        failed |= same != total;
    }
    if failed {
        std::process::exit(1);
    }
}

/// The game's near routine run from `start` (at its first instruction), a step at a time, until
/// it returns (its divide errors through the game's handler, as in a race): the state then, or
/// None if it ran on. The offsets of the instructions it ran in its own segment go into `seen`.
fn game_near(start: &Snapshot, seen: &mut std::collections::BTreeSet<u16>) -> Option<Snapshot> {
    let mut m = Machine::new();
    m.restore(start);
    let (cs, sp) = (m.cpu.s[1], m.cpu.r[4]);
    let ret = rd16(&m, lin(m.cpu.s[2], sp));
    for _ in 0..2_000_000 {
        if m.cpu.s[1] == cs {
            if m.cpu.ip == ret && m.cpu.r[4] == sp.wrapping_add(2) {
                return Some(m.snapshot());
            }
            seen.insert(m.cpu.ip);
        }
        if let f1gp_machine::cpu::Event::Callback(_) = m.cpu.step(&mut m.hw) {
            return None;
        }
    }
    None
}

/// A made-up call of the edge builder or the border edge: its points replaced by random ones.
fn made_up_edge(m: &mut Machine, o: &Ours, rng: &mut impl FnMut(i32) -> i32) {
    let r = m.cpu.r;
    let (ss, ds, bp) = (m.cpu.s[2], m.cpu.s[3], r[5]);
    let points = rd16(m, lin(ss, bp.wrapping_add(0x30)));
    let set = |m: &mut Machine, off: u16, v: i32| {
        m.hw.wr16(lin(ds, off), v as u16);
    };
    let mut ends = vec![points.wrapping_add(r[2])];
    if o.off == EDGE {
        ends.push(points.wrapping_add(r[1]));
    }
    // some edges flat, some at 45 degrees, some with outcodes that disagree with
    // their points (which the game's own points never do)
    let (flat, diagonal, odd) = (rng(10) == 0, rng(8) == 0, rng(8) == 0);
    let mut first = (0, 0);
    for (k, &p) in ends.iter().enumerate() {
        let behind = rng(4) == 0;
        let mut px = if rng(2) == 0 {
            rng(320)
        } else {
            rng(2400) - 1000
        };
        let mut py = if rng(2) == 0 {
            rng(164)
        } else {
            rng(1000) - 400
        };
        if k == 0 {
            first = (px, py);
        } else if flat {
            py = first.1;
        } else if diagonal {
            let d = rng(600) - 300;
            (px, py) = (first.0 + d, first.1 + if rng(2) == 0 { d } else { -d });
        }
        let near_axis = rng(3) == 0;
        let span = if near_axis { 40 } else { 4000 };
        let mut code = match px {
            ..0 => 8,
            320.. => 4,
            _ => 0,
        } | match py {
            ..0 => 2,
            164.. => 1,
            _ => 0,
        };
        if behind {
            code = 0x10 | if rng(4) == 0 { code } else { 0 };
        }
        if odd {
            code ^= rng(16);
        }
        if rng(3) == 0 {
            code |= 0x8000;
        }
        set(m, p.wrapping_sub(6), rng(span) - span / 2);
        set(m, p.wrapping_sub(4), rng(span / 4) - span / 8);
        let depth = if behind {
            rng(110) - 100
        } else {
            8 + rng(3000)
        };
        set(m, p.wrapping_sub(2), depth);
        set(m, p, px);
        set(m, p.wrapping_add(2), py);
        set(m, p.wrapping_add(4), code);
    }
    set(m, 0x2a4, if rng(4) == 0 { 0x8000 } else { 0 });
    if rng(30) == 0 {
        set(m, 0x2aa, 0xd58c + rng(100));
    }
    if o.off == BORDER {
        m.cpu.r[1] = [4, 8, rng(16) as u16][rng(3) as usize];
        m.cpu.r[3] = [0, 0x40, rng(256) as u16][rng(3) as usize];
        let rec = lin(ds, r[6].wrapping_add(6)) as usize;
        m.hw.mem[rec] ^= (rng(2) as u8) << 7;
        set(m, 0x13e, rng(2) * 0x8000);
        set(m, 0x136, rng(164));
    }
}

/// A made-up call of the bitmap drawer: the bitmap, its depth, anchor and mirroring, the
/// window and mirror modes, the vertical scale and the weather changed at random.
fn made_up_bitmap(m: &mut Machine, rng: &mut impl FnMut(i32) -> i32) {
    let (ss, bp) = (m.cpu.s[2], m.cpu.r[5]);
    let put = |m: &mut Machine, o: u16, v: i32| m.hw.wr16(lin(ss, o), v as u16);
    let s = |o: u16| bp.wrapping_add(o);
    if rng(2) == 0 {
        m.cpu.r[0] = rng(0xe8) as u16;
    }
    let depth = [rng(40) - 8, rng(0x400), rng(0x4000), 0x7f00 + rng(0x100)][rng(4) as usize];
    put(m, s(0x8c), depth);
    if rng(50) == 0 {
        // a bitmap marked not to be drawn (its size word's bits 15 and 14)
        let store = rd16(m, lin(ss, 0xf8));
        let at = lin(store, (m.cpu.r[0] << 2).wrapping_add(0x238));
        let (seg, off) = (rd16(m, at + 2), rd16(m, at));
        m.hw.wr16(lin(seg, off), 0xc000);
    }
    if rng(2) == 0 {
        put(m, s(0x88), rng(800) - 240);
    }
    if rng(2) == 0 {
        m.cpu.r[1] = (rng(400) - 100) as u16;
    }
    put(m, s(0x12e), rng(65536));
    if rng(3) == 0 {
        m.hw.mem[lin(ss, s(0x134)) as usize] = rng(2) as u8;
        put(m, s(0x132), rng(164));
        put(m, s(0x130), rng(200) - 20);
    }
    if rng(3) == 0 {
        put(m, s(0x17e), rng(0x40000) >> 2);
    }
    if rng(4) == 0 {
        put(m, 0x122e, 1);
        put(m, 0x182, rng(65536));
    }
}

/// A made-up call of the ground texture: the view, the camera car's heading, speed and yaw
/// rate, the horizon, the texture's top row and the ground points' list end changed at random.
fn made_up_ground(m: &mut Machine, rng: &mut impl FnMut(i32) -> i32) {
    let (cs, ss, bp) = (m.cpu.s[1], m.cpu.s[2], m.cpu.r[5]);
    let ds = rd16(m, lin(ss, 0xf0));
    let r = rd16(m, lin(ss, 0xf4));
    let put = |m: &mut Machine, s: u16, o: u16, v: i32| m.hw.wr16(lin(s, o), v as u16);
    let putb = |m: &mut Machine, s: u16, o: u16, v: i32| m.hw.mem[lin(s, o) as usize] = v as u8;
    let view = [0, 0, 0x40, 0x80, 0xc0, rng(256)][rng(6) as usize];
    putb(m, ds, 0x981, view);
    let car = rd16(m, lin(ds, 0x97f));
    put(m, ds, car, rng(65536));
    put(m, ds, 0x60, rng(65536));
    put(m, ds, car.wrapping_add(0x10), rng(80000) - 40000);
    put(m, ds, car.wrapping_add(0x4a), rng(4000) - 2000);
    putb(m, ss, bp.wrapping_add(0x16e), rng(2) * 0x80);
    put(m, ss, 0x136, rng(2) * 0x8000);
    if rng(3) == 0 {
        put(m, ss, bp.wrapping_add(0x130), rng(240) - 40);
    }
    if rng(3) == 0 {
        put(m, r, 0x140, rng(240) - 40);
    }
    if rng(6) == 0 {
        put(m, r, 0x642, 0x644 + 8 * rng(3));
    }
    if rng(4) == 0 {
        putb(m, cs, 0x73b0, rng(2));
    }
    if rng(3) == 0 {
        put(m, cs, 0x7398, rng(65536));
        put(m, cs, 0x739a, rng(65536));
    }
}

/// Our near routines against the game's on made-up calls: `trials` of each, from caught calls
/// with their input changed at random (made_up_edge, made_up_ground, made_up_bitmap), so that the paths races
/// rarely take are run too. Both must leave the same memory and registers. The offsets of the game's instructions
/// run go to FOOTPRINT_OUT if set.
fn fuzz(out: &Path, which: &str, trials: usize) {
    let snaps: Vec<Snapshot> = caught(out)
        .iter()
        .take(12)
        .map(|p| Snapshot::from_bytes(&std::fs::read(p).unwrap()).unwrap())
        .collect();
    let mut x = 0x2545_f491_4f6c_dd1du64;
    let mut rng = move |n: i32| -> i32 {
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        ((x.wrapping_mul(0x2545_f491_4f6c_dd1d) >> 33) % n as u64) as i32
    };
    let mut seen = std::collections::BTreeSet::new();
    let mut failed = false;
    std::panic::set_hook(Box::new(|_| {}));
    for o in OURS
        .iter()
        .filter(|o| o.near && (which == "all" || which == o.name))
    {
        // the edge routines from the first frame's calls, the texture (once a frame) from each frame's
        let calls: Vec<Call> = if o.off == GROUND || o.off == BITMAP {
            snaps
                .iter()
                .flat_map(|s| calls_in(s, o.off, true))
                .collect()
        } else {
            calls_in(&snaps[0], o.off, true)
        };
        let (mut same, mut faults) = (0, 0);
        for t in 0..trials {
            let mut m = Machine::new();
            m.restore(&calls[t % calls.len()].before);
            if o.off == GROUND {
                made_up_ground(&mut m, &mut rng);
            } else if o.off == BITMAP {
                made_up_bitmap(&mut m, &mut rng);
            } else {
                made_up_edge(&mut m, o, &mut rng);
            }
            // SS:00C0 clear, to count the calls in which the game's divide-error handler ran
            let flag = lin(m.cpu.s[2], 0xc0) as usize;
            m.hw.mem[flag] = 0;
            let start = m.snapshot();
            let game = game_near(&start, &mut seen);
            let ours = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                let mut m = Machine::new();
                m.restore(&start);
                (o.run)(&mut m);
                m.ret();
                m
            }))
            .ok();
            let ok = match (&game, &ours) {
                (Some(g), Some(m)) => {
                    faults += g.mem[flag] as usize;
                    let sp = lin(start.cpu.s[2], start.cpu.r[4]) as usize;
                    (0..m.hw.mem.len())
                        .all(|a| (sp - 128..sp).contains(&a) || m.hw.mem[a] == g.mem[a])
                        && m.cpu.r == g.cpu.r
                        && m.cpu.s == g.cpu.s
                        && m.cpu.ip == g.cpu.ip
                }
                _ => false,
            };
            if ok {
                same += 1;
            } else if !failed {
                failed = true;
                std::fs::write("fuzz-fail.snap", start.to_bytes()).unwrap();
                println!(
                    "{} trial {t}: the game's {} and ours {} (state in fuzz-fail.snap)",
                    o.name,
                    if game.is_some() { "returned" } else { "ran on" },
                    if ours.is_some() { "returned" } else { "failed" }
                );
            }
        }
        println!(
            "{}: {same} of {trials} made-up calls the same ({faults} through the divide-error handler)",
            o.name
        );
    }
    let _ = std::panic::take_hook();
    if let Ok(file) = std::env::var("FOOTPRINT_OUT") {
        let lines: Vec<String> = seen
            .iter()
            .map(|ip| format!("{SEG:04x}:{ip:04x}"))
            .collect();
        std::fs::write(file, lines.join("\n") + "\n").unwrap();
    }
    if failed {
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
        for (k, o) in OURS.iter().enumerate() {
            m.hook(lin(SEG + IMAGE, o.off), AT_CALL + k as u8);
        }
        let (cs, ip) = (m.cpu.s[1], m.cpu.ip);
        let n = m
            .call_far(cs, ip, 50_000_000, &mut |m, n| {
                let o = &OURS[(n - AT_CALL) as usize];
                (o.run)(m);
                if o.near {
                    m.ret();
                } else {
                    m.retf();
                }
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
        Some("profile") => profile(Path::new(&a[2])),
        Some("ours") => ours_check(Path::new(&a[2])),
        Some("calls") => calls_check(
            Path::new(&a[2]),
            a.get(3).map(|s| s.as_str()).unwrap_or("all"),
            a.get(4).map(|s| s.parse().unwrap()).unwrap_or(usize::MAX),
        ),
        Some("fuzz") => fuzz(
            Path::new(&a[2]),
            a.get(3).map(|s| s.as_str()).unwrap_or("all"),
            a.get(4).map(|s| s.parse().unwrap()).unwrap_or(20_000),
        ),
        Some("dumpfills") => dump_fills(Path::new(&a[2]), a[3].parse().unwrap(), Path::new(&a[4])),
        Some("fills") => fill_calls(
            Path::new(&a[2]),
            a.get(3).map(|s| s.parse().unwrap()).unwrap_or(1),
        ),
        _ => eprintln!("r3d capture <files> <session> <out> [every] [count] | r3d check <out>"),
    }
}
