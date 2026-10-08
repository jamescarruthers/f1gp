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
//!   r3d calls <out dir> [fill|edge|border|ground|bitmap|point|pointnear|project|all] [frames]
//!       our routines (OURS) against the game's, call by call
//!   r3d fuzz <out dir> [edge|border|ground|bitmap|point|pointnear|project|all] [trials 20000]
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
    for ((seg, off), r) in v.iter() {
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
    /// image-relative segment
    seg: u16,
    off: u16,
    near: bool,
    run: Run,
}

/// A port, run on the machine at the routine's first instruction.
#[derive(Clone, Copy)]
enum Run {
    Machine(fn(&mut Machine)),
    Cpu(fn(&mut r3d::regs::Cpu)),
}

impl Ours {
    fn run(&self, m: &mut Machine) {
        match self.run {
            Run::Machine(f) => f(m),
            Run::Cpu(f) => f(&mut r3d::regs::Cpu::of(m)),
        }
    }
}

/// The ground texture (0F47:7F64), a near routine run after the scene with the T option on.
const GROUND: u16 = 0x7f64;

/// The bitmap drawer (0F47:19E8), a near routine.
const BITMAP: u16 = 0x19e8;

/// The point projection's entries (0F47:20D9 a world point, 20AB one near the camera, 2168 one
/// already in the view), near routines that leave their results in registers too.
const POINT: u16 = 0x20d9;
const POINT_NEAR: u16 = 0x20ab;
const PROJECT: u16 = 0x2168;

/// Run a port that sets registers as the game's routine does.
fn with_regs(m: &mut Machine, f: impl FnOnce(r3d::Mem, &mut [u16; 8])) {
    let mut r = m.cpu.r;
    f(r3d::Mem::of(m), &mut r);
    m.cpu.r = r;
}

/// The segment walk's helpers (src/r3d/track.rs).
const HAZE: u16 = 0x188a;
const WALK: u16 = 0x3b32;
const WALK_PITS: u16 = 0x3aab;
const SHAPE: u16 = 0x88a5;
const VERTEX: u16 = 0x831f;
const POLE: u16 = 0x878d;
const CAR: u16 = 0xa30a;
const PARKED: u16 = 0xa7b2;
const PART: u16 = 0xa406;
const PART_OWN: u16 = 0xa2cc;
const PART_SHAPE: u16 = 0xa2d3;
const OBJECT: u16 = 0x9e2a;
const SORT: u16 = 0x5149;
const SKY: u16 = 0x72be;
const DRAW: u16 = 0x802a;
const GRASS: u16 = 0x18e1;
const CARS_ON: u16 = 0xa533;
const SIGNALS: u16 = 0xa944;
const PIT_BOX: u16 = 0x8261;

/// Routines the caught races never call, made up from the calls of one they could be called
/// in place of (the same segment and stack: SEG, the routine, the one lent, near): the car's
/// parts from the car drawer's, the arctangent from the pose's.
const BORROW: [(u16, u16, u16, bool); 7] = [
    (SEG, PART, CAR, true),
    (SEG, PART_OWN, CAR, true),
    (SEG, PART_SHAPE, CAR, true),
    (SEG, 0xa19e, CAR, true),
    (SEG, 0xa1c1, CAR, true),
    (0, 0x043c, 0x14a2, false),
    (SEG, SIGNALS, DRAW, true),
];

/// The stack below SP left out of the comparisons: what the game's pushes leave there.
const STACK: usize = 0x400;

type Port = (&'static str, u16, u16, bool, fn(&mut r3d::regs::Cpu));

const TRACK: [Port; 57] = [
    ("haze", SEG, HAZE, true, r3d::road::haze),
    ("road", SEG, 0x5470, true, r3d::road::road),
    ("mode", SEG, 0x49c0, true, r3d::blocks::mode),
    ("blocks", SEG, 0x4a03, true, r3d::blocks::blocks),
    ("strips", SEG, 0x4c12, true, r3d::strips::strips),
    ("walk", SEG, WALK, true, r3d::walk::walk),
    ("walkpits", SEG, WALK_PITS, true, r3d::walk::walk_pits),
    ("walls", SEG, 0x2a04, true, |c| {
        r3d::section::section(c, r3d::section::Entry::Walls)
    }),
    ("kerbs", SEG, 0x2d12, true, |c| {
        r3d::section::section(c, r3d::section::Entry::Kerbs)
    }),
    ("fences", SEG, 0x2f7c, true, |c| {
        r3d::section::section(c, r3d::section::Entry::Fences)
    }),
    ("edges", SEG, 0x3181, true, |c| {
        r3d::section::section(c, r3d::section::Entry::Edges)
    }),
    ("along", SEG, 0x25d3, false, r3d::section::along),
    ("sqrt", 0, 0x024e, false, r3d::track::sqrt),
    ("shifted", SEG, 0x206e, true, r3d::track::shifted),
    ("raise", SEG, 0x2334, true, r3d::track::raise),
    ("crestl", SEG, 0x279e, true, |c| {
        r3d::track::crest(c, &r3d::track::LEFT)
    }),
    ("crestr", SEG, 0x28d1, true, |c| {
        r3d::track::crest(c, &r3d::track::RIGHT)
    }),
    ("groundpt", SEG, 0x78c1, true, r3d::track::ground_point),
    ("colours", SEG, 0x32c3, true, r3d::track::colours),
    ("markers", SEG, 0x3306, true, r3d::track::markers),
    ("shade", SEG, 0x226b, true, r3d::track::shade),
    ("vertex", SEG, VERTEX, true, r3d::shape::vertex),
    ("pole", SEG, POLE, true, r3d::shape::pole),
    ("shapehaze", SEG, 0x8801, true, r3d::shape::haze),
    ("shape", SEG, SHAPE, true, r3d::shape::shape),
    ("finesine", 0, 0x03c8, false, r3d::cars::fine_sine),
    ("angle", 0, 0x043c, false, r3d::cars::angle),
    ("pose", 0, 0x14a2, false, r3d::cars::pose),
    ("car", SEG, CAR, true, r3d::cars::car),
    ("part", SEG, PART, true, r3d::cars::part),
    ("partown", SEG, PART_OWN, true, r3d::cars::part_own),
    ("partshape", SEG, PART_SHAPE, true, r3d::cars::part_shape),
    ("ownpart", SEG, 0xa19e, true, r3d::cars::own_part),
    ("partcar", SEG, 0xa1c1, true, r3d::cars::part_and_car),
    ("parked", SEG, PARKED, true, r3d::cars::parked),
    ("object", SEG, OBJECT, true, r3d::scene::object),
    ("pits", SEG, 0x9c05, true, r3d::scene::pits),
    ("reset", SEG, 0x9be0, true, r3d::scene::reset),
    ("scene", SEG, 0x817a, true, r3d::scene::scene),
    ("drain", SEG, 0x541b, true, r3d::scene::drain),
    ("sort", SEG, SORT, true, r3d::scene::sort),
    ("sides", SEG, 0x6425, true, r3d::road::fences),
    ("rows", 0x19ed, 0x3112, false, r3d::screen::rows),
    ("skyrows", 0x19ed, 0x314a, false, r3d::screen::sky_rows),
    ("scenery", 0x19ed, 0x39ed, false, r3d::screen::scenery),
    ("cockpitsides", 0x19ed, 0x3afa, false, r3d::screen::sides),
    ("lights", 0x19ed, 0x3b46, false, r3d::screen::start_lights),
    ("gauges", 0x19ed, 0x3c1a, false, r3d::screen::gauges),
    ("sky", SEG, SKY, true, r3d::frame::sky),
    ("draw", SEG, DRAW, true, r3d::frame::draw),
    ("pitbox", SEG, PIT_BOX, true, r3d::frame::pit_box),
    ("pitboxoff", SEG, 0x82cc, true, r3d::frame::pit_box_off),
    ("grass", SEG, GRASS, true, r3d::frame::colours),
    ("wetview", SEG, 0xa783, true, r3d::frame::wet_view),
    ("carson", SEG, CARS_ON, true, r3d::frame::cars_on),
    ("carsoff", SEG, 0xa737, true, r3d::frame::cars_off),
    ("signals", SEG, SIGNALS, true, r3d::frame::signals),
];

/// Every port: OURS, then TRACK.
fn ours() -> Vec<Ours> {
    let mut v: Vec<Ours> = OURS.into_iter().collect();
    v.push(Ours {
        name: "frame",
        seg: SEG,
        off: 0x81ce,
        near: false,
        run: Run::Machine(r3d::frame::frame),
    });
    for (name, seg, off, near, f) in TRACK {
        v.push(Ours {
            name,
            seg,
            off,
            near,
            run: Run::Cpu(f),
        });
    }
    v
}

const OURS: [Ours; 8] = [
    Ours {
        name: "fill",
        seg: SEG,
        off: FILL,
        near: false,
        run: Run::Machine(|m| {
            let bp = m.cpu.r[5];
            m.cpu.r[0] = r3d::fill::fill(r3d::Mem::of(m), bp);
        }),
    },
    Ours {
        name: "edge",
        seg: SEG,
        off: EDGE,
        near: true,
        run: Run::Machine(|m| {
            let r = m.cpu.r;
            r3d::edge::edge(r3d::Mem::of(m), r[5], r[0], r[1], r[2], r[7]);
        }),
    },
    Ours {
        name: "border",
        seg: SEG,
        off: BORDER,
        near: true,
        run: Run::Machine(|m| {
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
        }),
    },
    Ours {
        name: "ground",
        seg: SEG,
        off: GROUND,
        near: true,
        run: Run::Machine(|m| {
            let bp = m.cpu.r[5];
            r3d::ground::ground(r3d::Mem::of(m), bp);
        }),
    },
    Ours {
        name: "bitmap",
        seg: SEG,
        off: BITMAP,
        near: true,
        run: Run::Machine(|m| {
            let r = m.cpu.r;
            r3d::bitmap::bitmap(r3d::Mem::of(m), r[5], r[0], r[1], r[2]);
        }),
    },
    Ours {
        name: "point",
        seg: SEG,
        off: POINT,
        near: true,
        run: Run::Machine(|m| {
            with_regs(m, |m, r| r3d::point::point(m, r, r3d::point::Entry::World))
        }),
    },
    Ours {
        name: "pointnear",
        seg: SEG,
        off: POINT_NEAR,
        near: true,
        run: Run::Machine(|m| {
            with_regs(m, |m, r| r3d::point::point(m, r, r3d::point::Entry::Near))
        }),
    },
    Ours {
        name: "project",
        seg: SEG,
        off: PROJECT,
        near: true,
        run: Run::Machine(|m| {
            with_regs(m, |m, r| {
                r3d::point::point(m, r, r3d::point::Entry::Projected)
            })
        }),
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
fn calls_in(snap: &Snapshot, seg: u16, off: u16, near: bool) -> Vec<Call> {
    let at = lin(seg + IMAGE, off);
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
        let calls = calls_in(&snap, SEG, FILL, false);
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
        for c in calls_in(&snap, SEG, FILL, false) {
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
    for o in ours().iter().filter(|o| which == "all" || which == o.name) {
        let (mut same, mut total) = (0, 0);
        let mut shown = 0;
        for p in caught(out).into_iter().take(frames) {
            let snap = Snapshot::from_bytes(&std::fs::read(&p).unwrap()).unwrap();
            for (i, c) in calls_in(&snap, o.seg, o.off, o.near).iter().enumerate() {
                total += 1;
                let mut m = Machine::new();
                m.restore(&c.before);
                o.run(&mut m);
                if o.near {
                    m.ret();
                } else {
                    m.retf();
                }
                let sp = lin(c.before.cpu.s[2], c.before.cpu.r[4]) as usize;
                let differ: Vec<usize> = (0..m.hw.mem.len())
                    .filter(|&a| !(sp - STACK..sp).contains(&a) && m.hw.mem[a] != c.after.mem[a])
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

/// The game's routine (near, or far) run from `start` (at its first instruction), a step at a
/// time, until it returns (its divide errors through the game's handler, as in a race): the state then, or
/// None if it ran on. The instructions it ran (image-relative segment, offset) go into `seen`.
fn game_near(
    start: &Snapshot,
    near: bool,
    seen: &mut std::collections::BTreeSet<(u16, u16)>,
) -> Option<Snapshot> {
    let mut m = Machine::new();
    m.restore(start);
    let (cs, sp) = (m.cpu.s[1], m.cpu.r[4]);
    let ret = rd16(&m, lin(m.cpu.s[2], sp));
    let (ret_cs, ret_sp) = if near {
        (cs, sp.wrapping_add(2))
    } else {
        (
            rd16(&m, lin(m.cpu.s[2], sp.wrapping_add(2))),
            sp.wrapping_add(4),
        )
    };
    for _ in 0..2_000_000 {
        if m.cpu.s[1] == ret_cs && m.cpu.ip == ret && m.cpu.r[4] == ret_sp {
            return Some(m.snapshot());
        }
        seen.insert((m.cpu.s[1].wrapping_sub(IMAGE), m.cpu.ip));
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

/// A made-up call of the point projection: the point (32-bit at SS:[bp+10] and [bp+14]), its
/// height, the camera's position and heading, and the finer coordinates (R:02A4) at random;
/// some points at the camera, some just off its axis, some far to the side.
fn made_up_point(m: &mut Machine, rng: &mut impl FnMut(i32) -> i32) {
    let (ss, ds, bp) = (m.cpu.s[2], m.cpu.s[3], m.cpu.r[5]);
    let put = |m: &mut Machine, o: u16, v: i32| m.hw.wr16(lin(ss, bp.wrapping_add(o)), v as u16);
    let wide = |rng: &mut dyn FnMut(i32) -> i32| match rng(4) {
        0 => rng(16) - 8,
        1 => rng(0x800) - 0x400,
        _ => rng(65536),
    };
    for o in [0x10, 0x12, 0x14, 0x16] {
        if rng(3) != 0 {
            let v = wide(rng);
            put(m, o, v);
        }
    }
    if rng(4) == 0 {
        // the point exactly where the camera is
        for o in [0x10, 0x12] {
            put(m, o, 0);
        }
        let (x, z) = (
            rd16(m, lin(ss, bp.wrapping_add(0x13c))),
            rd16(m, lin(ss, bp.wrapping_add(0x140))),
        );
        if rng(2) == 0 {
            put(m, 0x10, x as i32);
            put(m, 0x14, z as i32);
        }
    }
    if rng(2) == 0 {
        m.cpu.r[0] = wide(rng) as u16;
    }
    if rng(2) == 0 {
        m.cpu.r[1] = wide(rng) as u16;
    }
    if rng(4) == 0 {
        let a = rng(65536);
        put(m, 0x154, a);
        put(m, 0x156, rng(65536));
        put(m, 0x8, rng(65536));
        put(m, 0xc, rng(65536));
    }
    if rng(4) == 0 {
        put(m, 0x17c, rng(65536));
    }
    let depth = 8 + rng(200);
    match rng(8) {
        0 => {
            // a column within 160 of the largest (2168's add overflows)
            let q = 0x7f60 + rng(0xa0);
            let v = (q * depth) as u32;
            put(m, 0x10, v as i32 & 0xffff);
            put(m, 0x12, (v >> 16) as i32);
            put(m, 0x14, depth);
        }
        1 => {
            // a point far to the side whose doubling ends on 3800h exactly (1FAD)
            let v = (0x3800_0000u32 >> rng(12)) as i32 * if rng(2) == 0 { 1 } else { -1 };
            put(m, 0x10, v & 0xffff);
            put(m, 0x12, v >> 16);
            put(m, 0x14, depth);
        }
        _ => {}
    }
    m.hw.wr16(lin(ds, 0x2a4), (rng(2) * 0x8000) as u16);
}

/// A made-up call of the segment walk: its bands' lengths, its direction, the road drawn as
/// polygons or not, the mirror's flag and the camera's segment at random; some walks long enough
/// A call of the frame's own routines: wet or dry (SS:122E, [bp+122E], the level [bp+184]), the
/// view (G:0981: cockpit 0, A0h, or as caught), the texture on or off ([bp+11A6]), the start
/// lights (G:290D, G:2923), the cars to place (G:2225, R:0186, the view's direction, the pit
/// lane drawn or not, the camera in the pits), and the viewed car's pit stop: its crew's signals
/// (+97 bits 3 to 6), its state (+67) and their swings (G:2919 to G:291F).
fn made_up_view(m: &mut Machine, off: u16, rng: &mut impl FnMut(i32) -> i32) {
    let (ss, ds, bp) = (m.cpu.s[2], m.cpu.s[3], m.cpu.r[5]);
    let g = rd16(m, lin(ss, 0xf0));
    let at = |o: u16| lin(ss, bp.wrapping_add(o));
    let b = |m: &mut Machine, a: u32, v: i32| m.hw.mem[a as usize] = v as u8;
    if rng(2) == 0 {
        let wet = rng(2) as u16;
        m.hw.wr16(lin(ss, 0x122e), wet);
        m.hw.wr16(at(0x122e), wet);
        m.hw.wr16(lin(ss, 0x182), rng(0x200) as u16);
        b(m, at(0x184), rng(6) - 1);
    }
    if rng(3) == 0 {
        b(m, lin(g, 0x981), [0, 0xa0, 0xc0][rng(3) as usize]);
    }
    if rng(3) == 0 {
        b(m, at(0x11a6), rng(2) * 0x80);
    }
    if rng(3) == 0 {
        m.hw.wr16(lin(g, 0x290d), rng(9) as u16);
        b(m, lin(g, 0x2923), rng(4));
    }
    if off == CARS_ON || off == PIT_BOX {
        if rng(2) == 0 {
            m.hw.wr16(lin(g, 0x2225), rng(27) as u16);
        }
        if rng(3) == 0 {
            m.hw.wr16(lin(ds, 0x186), rng(0x4000) as u16);
        }
        if rng(3) == 0 {
            let v = rd16(m, at(0x136)) ^ 0x8000;
            m.hw.wr16(at(0x136), v);
        }
        if rng(3) == 0 {
            m.hw.wr16(
                at(0x170),
                if rng(2) == 0 {
                    0x8000
                } else {
                    rng(2) as u16 * 0x10
                },
            );
        }
        if rng(4) == 0 {
            m.hw.mem[lin(g, 0x16e) as usize] ^= 0x80;
        }
        if rng(4) == 0 {
            m.hw.mem[lin(g, 0x256) as usize] ^= 0x80;
        }
        if rng(2) == 0 {
            // some cars moved: into the pit lane's array (G:8799), onto the track's segments
            // where the pit lane joins (+26 bits 0 and 1), or anywhere on the track (G:87A1)
            let w = |m: &Machine, o: u16| rd16(m, lin(g, o));
            let (track, lane) = (w(m, 0x87a1), w(m, 0x8799));
            let (t0, t1) = (w(m, 0x879f), w(m, 0x18a));
            let (l0, l1) = (w(m, 0x8797), w(m, 0x182));
            let joins: Vec<u16> = (0..t1.wrapping_add(0x900).wrapping_sub(t0) / 0x2e)
                .map(|k| t0 + 0x2e * k)
                .filter(|&d| m.hw.mem[lin(track, d + 0x26) as usize] & 3 != 0)
                .collect();
            for _ in 0..1 + rng(4) {
                let car = 0xd1b + 0xc0 * rng(26) as u16;
                let (di, es) = match rng(3) {
                    0 if l1 > l0 => (
                        l0 + 0x2e * rng(((l1 - l0) / 0x2e).max(1) as i32) as u16,
                        lane,
                    ),
                    1 if !joins.is_empty() => (joins[rng(joins.len() as i32) as usize], track),
                    _ => (
                        t0 + 0x2e * rng(((t1.wrapping_sub(t0)) / 0x2e).max(1) as i32) as u16,
                        track,
                    ),
                };
                m.hw.wr16(lin(g, car + 0x12), di);
                m.hw.wr16(lin(g, car + 0x14), es);
            }
        }
        for k in 0..26u16 {
            if rng(8) == 0 {
                let car = 0xd1b + k * 0xc0;
                m.hw.mem[lin(g, car + 0x96) as usize] ^= 0x80;
                m.hw.mem[lin(g, car + 0x9a) as usize] ^= 8;
            }
        }
    }
    if off == SIGNALS || off == DRAW {
        let car = rd16(m, lin(g, 0x97f));
        if off == SIGNALS {
            m.cpu.s[3] = g;
            m.cpu.r[6] = car;
        }
        let f = lin(g, car + 0x97) as usize;
        m.hw.mem[f] = m.hw.mem[f] & 0x87 | (rng(16) << 3) as u8;
        b(m, lin(g, car + 0x67), rng(9));
        for o in [0x2919u16, 0x291b, 0x291d] {
            let v = match rng(3) {
                0 => 0x8000,
                1 => rng(0x20),
                _ => rng(0x900),
            };
            m.hw.wr16(lin(g, o), v as u16);
        }
        m.hw.wr16(lin(g, 0x291f), rng(0x100) as u16);
        b(m, at(0x124a), rng(2) * 0x80);
        m.hw.wr16(at(0x88), rng(0x140) as u16);
    }
}

/// A call into segment 19ED: rows and colours at random (some off the screen), the cockpit's
/// top, the horizon, the sky's lowest row, wet or dry and the heading for the scenery, the
/// lights lit and which lamp.
fn made_up_screen(m: &mut Machine, off: u16, rng: &mut impl FnMut(i32) -> i32) {
    let (ss, ds, bp) = (m.cpu.s[2], m.cpu.s[3], m.cpu.r[5]);
    let g = rd16(m, lin(ss, 0xf0));
    let at = |o: u16| lin(ss, bp.wrapping_add(o));
    match off {
        0x3112 | 0x314a => {
            m.cpu.r[1] = (rng(0xc0) - 0x10) as u16;
            m.cpu.r[2] = (rng(0xc0) - 0x10) as u16;
            m.cpu.r[0] = rng(65536) as u16;
            if rng(2) == 0 {
                m.hw.wr16(at(0x132), (0x60 + rng(0x50)) as u16);
            }
        }
        0x39ed => {
            m.hw.wr16(at(0x130), rng(0xb0) as u16);
            m.hw.wr16(lin(ds, 0x140), (rng(0xc0) - 0x10) as u16);
            m.hw.wr16(lin(g, 0x2261), rng(65536) as u16);
            m.hw.wr16(lin(ss, 0x122e), rng(2) as u16);
            m.hw.mem[at(0x184) as usize] = (rng(6) - 1) as u8;
        }
        0x3b46 => {
            m.hw.wr16(lin(g, 0x290d), rng(9) as u16);
            m.cpu.r[0] = rng(65536) as u16;
        }
        _ => {}
    }
}

/// An object's call (9E2A): the level of detail (G:0068) at random some of the time; the object
/// made the starting lights or another setting's; a parked car's records pointed at cars (or
/// none); a setting given an offset its shape number multiplies (A001).
fn made_up_object(m: &mut Machine, rng: &mut impl FnMut(i32) -> i32) {
    let (es, ss, di) = (m.cpu.s[0], m.cpu.s[2], m.cpu.r[7]);
    let g = rd16(m, lin(ss, 0xf0));
    if rng(3) == 0 {
        m.hw.mem[lin(g, 0x68) as usize] = rng(5) as u8;
    }
    let at = lin(es, di.wrapping_add(0x1e)) as usize;
    match rng(10) {
        0 => m.hw.mem[at] = 2,
        1 => m.hw.mem[at] = (2 + rng(38)) as u8,
        2 => m.hw.mem[at] = rng(2) as u8,
        3 => m.hw.mem[at] = (0xb4 + rng(4)) as u8,
        _ => {}
    }
    if rng(5) == 0 {
        m.hw.mem[at] = (0x80 + 2 * rng(13)) as u8;
    }
    let kind = m.hw.mem[at];
    if (0x80..0xb4).contains(&kind) && rng(2) == 0 {
        // a car with parts: in front (+97 bit 7), or by +9A bits 4 and 2; the camera's own
        let si = rd16(m, lin(g, 0xc65 + (kind & 0x7f) as u16)).wrapping_add(0xd1b);
        let f97 = lin(g, si.wrapping_add(0x97)) as usize;
        m.hw.mem[f97] = m.hw.mem[f97] & 0x7f | (rng(2) * 0x80) as u8;
        let f9a = lin(g, si.wrapping_add(0x9a)) as usize;
        m.hw.mem[f9a] = m.hw.mem[f9a] & 0x0b
            | ((rng(2) * 0x10) | (rng(2) * 4)) as u8
            | [0, 0x80, 0xc0, 0xe0][rng(4) as usize];
        if rng(3) == 0 {
            m.hw.wr16(lin(g, 0x97d), si);
        }
        if rng(3) == 0 {
            m.hw.wr16(lin(g, 0x2943), 0);
            m.hw.wr16(lin(g, 0x2945), 0);
        }
    }
    if kind >= 0xb4 && rng(2) == 0 {
        let b = (kind as u16 - 0xb4) * 4;
        for o in [0xb01u16, 0xb03] {
            let car = if rng(4) == 0 {
                0xffff
            } else {
                rd16(m, lin(g, 0xc65 + 2 * rng(13) as u16))
            };
            m.hw.wr16(lin(g, o + b), car);
        }
    }
    if kind < 0x80 && rng(8) == 0 {
        let t = rd16(m, lin(g, 0x23a)).wrapping_add(16 * kind as u16);
        m.hw.mem[lin(g, t) as usize] = [0, 2, 3][rng(3) as usize];
        m.hw.wr16(lin(g, t.wrapping_add(8)), (1 + rng(0x1ff)) as u16);
    }
}

/// A sort's call (5149): no objects, or the pit lane's sort, some of the time; the limits
/// (R:0064, R:006A, R:006C, R:0068) and the objects' kinds and flags (+1F bit 2, +26 bit 6) at
/// random some of the time.
fn made_up_sort(m: &mut Machine, rng: &mut impl FnMut(i32) -> i32) {
    let (ss, ds, bp) = (m.cpu.s[2], m.cpu.s[3], m.cpu.r[5]);
    let g = rd16(m, lin(ss, 0xf0));
    if rng(6) == 0 {
        let v = rd16(m, lin(ds, 0xf2));
        m.hw.wr16(lin(ds, 0xf6), v);
    }
    if rng(4) == 0 {
        m.hw.mem[lin(ss, bp.wrapping_add(0x172)) as usize] = 0x80;
    }
    for o in [0x64u16, 0x6a, 0x6c] {
        if rng(3) == 0 {
            let v = if rng(3) == 0 { 0 } else { rng(400) - 100 };
            m.hw.wr16(lin(ds, o), v as u16);
        }
    }
    if rng(4) == 0 {
        m.hw.wr16(lin(ds, 0x68), rng(40) as u16);
    }
    if rng(6) == 0 {
        m.hw.mem[lin(g, 0x981) as usize] = 0xc0;
    }
    let (from, to) = (rd16(m, lin(ds, 0xf2)), rd16(m, lin(ds, 0xf6)));
    let mut si = from;
    while si < to {
        let (di, es) = (rd16(m, lin(ds, si + 4)), rd16(m, lin(ds, si + 6)));
        if rng(4) == 0 {
            let k = match rng(3) {
                0 => 0x80 + 2 * rng(13),
                1 => 0xb4 + rng(4),
                _ => 2 + rng(38),
            };
            m.hw.mem[lin(es, di.wrapping_add(0x1e)) as usize] = k as u8;
        }
        if rng(4) == 0 {
            m.hw.mem[lin(es, di.wrapping_add(0x1f)) as usize] ^= 4;
        }
        if rng(4) == 0 {
            m.hw.mem[lin(es, di.wrapping_add(0x26)) as usize] ^= 0x40;
        }
        if rng(3) == 0 {
            m.hw.wr16(lin(ds, si), (rng(200) - 20) as u16);
        }
        si = si.wrapping_add(8);
    }
}

/// A car's call (A30A, or one of its parts' in its place): its parts' flags (+9A bits 5 to 7)
/// and heading at random, its place about the camera often; for a part, which (DI, and BX its
/// table entry), and the place kept at G:350D near the car's.
fn made_up_car(m: &mut Machine, off: u16, rng: &mut impl FnMut(i32) -> i32) {
    let (ss, ds, bp, si) = (m.cpu.s[2], m.cpu.s[3], m.cpu.r[5], m.cpu.r[6]);
    let at = |o: u16| lin(ss, bp.wrapping_add(o));
    let put = |m: &mut Machine, a: u32, v: i32| m.hw.wr16(a, v as u16);
    let flags = lin(ds, si.wrapping_add(0x9a)) as usize;
    let f = [0, 0x80, 0xc0, 0xa0, 0xe0][rng(5) as usize];
    m.hw.mem[flags] = m.hw.mem[flags] & 0x1f | f;
    if rng(2) == 0 {
        m.cpu.r[2] = rng(65536) as u16;
    }
    if rng(2) == 0 {
        for (o, cam) in [(0x10u16, 0x142u16), (0x14, 0x14a)] {
            let d = match rng(3) {
                0 => rng(0x800) - 0x400,
                1 => rng(0x10000) - 0x8000,
                _ => rng(0x100000) - 0x80000,
            };
            let c = rd16(m, at(cam)) as u32 | (rd16(m, at(cam + 2)) as u32) << 16;
            let v = c.wrapping_add(d as u32);
            put(m, at(o), v as i32);
            put(m, at(o + 2), (v >> 16) as i32);
        }
    }
    if off != CAR {
        let k = rng(5);
        m.cpu.r[7] = k as u16;
        m.cpu.r[3] = 0x351b + 16 * k as u16;
        for (o, f) in [
            (0x350d, 0x10),
            (0x350f, 0x12),
            (0x3511, 0x14),
            (0x3513, 0x16),
        ] {
            let v = rd16(m, at(f)) as i32;
            put(m, lin(ds, o), v);
        }
        let (x, z) = (rng(0x400) - 0x200, rng(0x400) - 0x200);
        let x0 = rd16(m, lin(ds, 0x350d));
        put(m, lin(ds, 0x350d), x0 as i32 + x);
        let z0 = rd16(m, lin(ds, 0x3511));
        put(m, lin(ds, 0x3511), z0 as i32 + z);
        put(m, lin(ds, 0x3515), m.cpu.r[1] as i32);
        put(m, lin(ds, 0x3517), m.cpu.r[2] as i32);
        let p = rd16(m, at(8)) as i32;
        put(m, lin(ds, 0x3519), p);
    }
}

/// A call into segment 0 (the pose, its sine, the arctangent): the angle or vector at random;
/// for the pose, the car's place on its segment and the segment's heading, lean and height at
/// random some of the time, and which way it is placed.
fn made_up_pose(m: &mut Machine, off: u16, rng: &mut impl FnMut(i32) -> i32) {
    let wide = |rng: &mut dyn FnMut(i32) -> i32| match rng(5) {
        0 => rng(16) - 8,
        1 => [0, 0x8000, 0x7fff, 0xffff][rng(4) as usize],
        2 => rng(0x800) - 0x400,
        _ => rng(65536),
    };
    match off {
        0x03c8 => m.cpu.r[0] = wide(rng) as u16,
        0x043c => {
            m.cpu.r[0] = wide(rng) as u16;
            m.cpu.r[2] = wide(rng) as u16;
        }
        _ => {
            let (es, ds, si, di) = (m.cpu.s[0], m.cpu.s[3], m.cpu.r[6], m.cpu.r[7]);
            let put = |m: &mut Machine, a: u32, v: i32| m.hw.wr16(a, v as u16);
            for o in [0xau16, 0x1a, 0x1c, 0x1e, 0x8c] {
                if rng(3) == 0 {
                    put(m, lin(ds, si.wrapping_add(o)), wide(rng));
                }
            }
            for o in [0u16, 2, 4, 6, 8, 0x14, 0x34] {
                if rng(3) == 0 {
                    put(m, lin(es, di.wrapping_add(o)), wide(rng));
                }
            }
            if rng(3) == 0 {
                m.hw.mem[lin(es, di.wrapping_add(0x21)) as usize] = rng(256) as u8;
            }
            if rng(4) == 0 {
                m.hw.mem[lin(ds, si.wrapping_add(0x7e)) as usize] ^= 1;
            }
        }
    }
}

/// A vertex's call (831F): the vertex it mirrors (if it mirrors one) made already projected half
/// the time, with its record at random (its depth, its flags with 1FAD's shift and the near
/// bit); the horizon, the scale, the shape's height and the finer coordinates at random some of
/// the time, to reach the row's overflows.
fn made_up_vertex(m: &mut Machine, rng: &mut impl FnMut(i32) -> i32) {
    let (es, ss, ds, bp) = (m.cpu.s[0], m.cpu.s[2], m.cpu.s[3], m.cpu.r[5]);
    let at = |o: u16| lin(ss, bp.wrapping_add(o));
    let put = |m: &mut Machine, a: u32, v: i32| m.hw.wr16(a, v as u16);
    let vt = rd16(m, at(0xa0));
    let x = rd16(m, lin(es, vt.wrapping_add(m.cpu.r[3] << 3)));
    if x & 0x8000 != 0 && rng(2) == 0 {
        let v = x & 0x7fff;
        m.hw.mem[lin(ds, v.wrapping_add(0xf10)) as usize] = 0x80;
        let rec = (v << 4).wrapping_add(0x830);
        let depth = match rng(3) {
            0 => rng(40) - 8,
            1 => rng(0x800),
            _ => rng(65536),
        };
        put(m, lin(ds, rec + 4), depth);
        let mut fl = rng(16);
        if rng(2) == 0 {
            fl |= rng(32) << 8;
        }
        if rng(3) == 0 {
            fl |= 0x10;
        }
        if rng(4) == 0 {
            fl |= 0x8000;
        }
        put(m, lin(ds, rec + 0xa), fl);
        put(m, lin(ds, rec + 6), rng(65536));
        put(m, lin(ds, rec + 8), rng(65536));
    }
    if rng(3) == 0 {
        put(m, at(0x130), rng(65536));
    }
    if rng(3) == 0 {
        put(m, at(0x17c), rng(65536));
    }
    if rng(4) == 0 {
        put(m, lin(ds, 0x2e), rng(65536));
    }
    if rng(4) == 0 {
        put(m, lin(ds, 0x2a4), rng(2) * 0x8000);
    }
}

/// A pole's call (878D): both vertices' columns, rows and outcodes at random, and the top row.
fn made_up_pole(m: &mut Machine, rng: &mut impl FnMut(i32) -> i32) {
    let (ss, ds, bp) = (m.cpu.s[2], m.cpu.s[3], m.cpu.r[5]);
    for rec in [m.cpu.r[3], m.cpu.r[7]] {
        let a = |o: u16| lin(ds, rec.wrapping_add(0x830 + o));
        m.hw.wr16(a(6), (rng(0x180) - 0x20) as u16);
        let row = if rng(2) == 0 {
            rng(0xe0) - 0x20
        } else {
            rng(65536)
        };
        m.hw.wr16(a(8), row as u16);
        m.hw.wr16(a(0xa), if rng(3) == 0 { rng(32) } else { 0 } as u16);
    }
    if rng(2) == 0 {
        m.hw.wr16(lin(ss, bp.wrapping_add(0x132)), (rng(0xd0) - 0x10) as u16);
    }
}

/// A shape's call (88A5) with its position at random about the camera (near often, to reach the
/// projection's overflows), and its heading, height, pitch, the steering, the haze (wet or dry),
/// the horizon, the scale and the poles' top at random some of the time.
fn made_up_shape(m: &mut Machine, rng: &mut impl FnMut(i32) -> i32) {
    let (ss, bp) = (m.cpu.s[2], m.cpu.r[5]);
    let at = |o: u16| lin(ss, bp.wrapping_add(o));
    let put = |m: &mut Machine, o: u16, v: i32| m.hw.wr16(at(o), v as u16);
    for (o, cam) in [(0x10u16, 0x142u16), (0x14, 0x14a)] {
        if rng(3) != 0 {
            let d = match rng(4) {
                0 => rng(0x400) - 0x200,
                1 => rng(0x8000) - 0x4000,
                2 => rng(0x80000) - 0x40000,
                _ => rng(65536) << 8 ^ rng(256),
            };
            let c = rd16(m, at(cam)) as u32 | (rd16(m, at(cam + 2)) as u32) << 16;
            let v = c.wrapping_add(d as u32);
            put(m, o, v as i32);
            put(m, o + 2, (v >> 16) as i32);
        }
    }
    if rng(2) == 0 {
        m.cpu.r[2] = rng(65536) as u16;
    }
    if rng(3) == 0 {
        m.cpu.r[1] = (rng(0x1000) - 0x800) as u16;
    }
    if rng(3) == 0 {
        put(m, 8, if rng(2) == 0 { 0 } else { rng(65536) });
    }
    if rng(4) == 0 {
        put(m, 0x16a, rng(0x1000) - 0x800);
    }
    if rng(4) == 0 {
        m.hw.mem[at(0x178) as usize] = rng(256) as u8;
    }
    if rng(8) == 0 {
        put(m, 0x168, rng(65536));
    }
    if rng(4) == 0 {
        put(m, 0x190, rng(65536));
    }
    if rng(3) == 0 {
        m.hw.wr16(lin(ss, 0x122e), rng(2) as u16);
        m.hw.wr16(lin(ss, 0x182), rng(65536) as u16);
    }
    if rng(4) == 0 {
        put(m, 0x130, if rng(2) == 0 { rng(65536) } else { rng(200) });
    }
    if rng(4) == 0 {
        put(m, 0x17c, rng(65536));
    }
    if rng(4) == 0 {
        put(m, 0x132, rng(0xc0));
    }
    if rng(6) == 0 {
        let game = rd16(m, lin(ss, 0xf0));
        m.hw.mem[lin(game, 0x981) as usize] = rng(2) as u8;
    }
}

/// to fill the strip list.
fn made_up_walk(m: &mut Machine, rng: &mut impl FnMut(i32) -> i32) {
    let (ss, ds, bp) = (m.cpu.s[2], m.cpu.s[3], m.cpu.r[5]);
    let put = |m: &mut Machine, seg: u16, o: u16, v: i32| m.hw.wr16(lin(seg, o), v as u16);
    let bpo = |o: u16| bp.wrapping_add(o);
    let long = rng(4) == 0;
    let mut d = 0;
    for o in [0x1c2u16, 0x1c6, 0x1ca, 0x1ce, 0x1d2] {
        if rng(2) == 0 {
            d += rng(6);
            put(m, ds, o, d * 0x2e);
        }
    }
    let mut d = 0;
    for o in [0x1d6u16, 0x1da, 0x1de, 0x1e2] {
        if rng(2) == 0 || long {
            d += if long { 20 + rng(30) } else { rng(12) };
            put(m, ds, o, d * 0x2e);
        }
    }
    if rng(3) == 0 {
        let v = rd16(m, lin(ss, bpo(0x136))) ^ 0x8000;
        put(m, ss, bpo(0x136), v as i32);
    }
    if rng(3) == 0 {
        m.hw.mem[lin(ds, 0xfa) as usize] = (rng(2) * 0x80) as u8;
    }
    if rng(6) == 0 {
        m.hw.mem[lin(ss, bpo(0x172)) as usize] = [0, 0x80, 1][rng(3) as usize];
    }
    if rng(3) == 0 {
        // the camera on another segment of the circuit
        let game = rd16(m, lin(ss, 0xf0));
        let end = rd16(m, lin(ss, bpo(0x15c)));
        let n = (end.saturating_sub(0x30) / 0x2e).max(1) as i32;
        put(m, game, 0x96f, 0x30 + 0x2e * rng(n));
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
/// with their input changed at random (made_up_edge, made_up_ground, made_up_bitmap,
/// made_up_point), so that the paths races
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
    for o in ours().iter().filter(|o| which == "all" || which == o.name) {
        let borrow = BORROW.iter().find(|b| (b.0, b.1) == (o.seg, o.off));
        // the edge routines from the first frame's calls, the texture (once a frame) from each frame's
        let calls: Vec<Call> = if let Some(b) = borrow {
            snaps
                .iter()
                .flat_map(|s| calls_in(s, b.0, b.2, b.3))
                .collect()
        } else if [
            GROUND, BITMAP, POINT, POINT_NEAR, PROJECT, WALK, WALK_PITS, HAZE, SHAPE, VERTEX, POLE,
            CAR, PARKED, OBJECT, SORT, SKY, DRAW, GRASS, CARS_ON, PIT_BOX,
        ]
        .contains(&o.off)
            || o.seg == 0
            || o.seg == 0x19ed
        {
            snaps
                .iter()
                .flat_map(|s| calls_in(s, o.seg, o.off, o.near))
                .collect()
        } else {
            calls_in(&snaps[0], o.seg, o.off, o.near)
        };
        if calls.is_empty() {
            println!("{}: no calls to start from", o.name);
            continue;
        }
        let (mut same, mut faults) = (0, 0);
        for t in 0..trials {
            let mut m = Machine::new();
            m.restore(&calls[t % calls.len()].before);
            if borrow.is_some() {
                m.cpu.ip = o.off;
            }
            if o.seg == 0 {
                made_up_pose(&mut m, o.off, &mut rng);
            } else if o.seg == 0x19ed {
                made_up_screen(&mut m, o.off, &mut rng);
            } else if [SKY, DRAW, GRASS, CARS_ON, PIT_BOX, SIGNALS].contains(&o.off) {
                made_up_view(&mut m, o.off, &mut rng);
            } else if o.off == OBJECT {
                made_up_object(&mut m, &mut rng);
            } else if o.off == SORT {
                made_up_sort(&mut m, &mut rng);
            } else if o.off == PARKED {
                // which car, sometimes the camera's
                let ds = m.cpu.s[3];
                let own = rd16(&m, lin(ds, 0x97f)).wrapping_add(0x25);
                let car = if rng(2) == 0 {
                    m.hw.mem[lin(ds, own) as usize] as i32
                } else {
                    1 + rng(26)
                };
                m.hw.wr16(lin(ds, 0x356b), car as u16);
            } else if o.off == CAR || borrow.is_some() {
                made_up_car(&mut m, o.off, &mut rng);
            } else if o.off == GROUND {
                made_up_ground(&mut m, &mut rng);
            } else if o.off == BITMAP {
                made_up_bitmap(&mut m, &mut rng);
            } else if [POINT, POINT_NEAR, PROJECT].contains(&o.off) {
                made_up_point(&mut m, &mut rng);
            } else if [WALK, WALK_PITS].contains(&o.off) {
                made_up_walk(&mut m, &mut rng);
            } else if o.off == VERTEX {
                made_up_vertex(&mut m, &mut rng);
            } else if o.off == POLE {
                made_up_pole(&mut m, &mut rng);
            } else if o.off == SHAPE {
                made_up_shape(&mut m, &mut rng);
            } else if o.off == HAZE {
                // the colour and distance at random, wet half the time
                m.cpu.r[0] = rng(65536) as u16;
                m.cpu.r[3] = (rng(400) - 100) as u16;
                let (ss, bp) = (m.cpu.s[2], m.cpu.r[5]);
                m.hw.wr16(lin(ss, bp.wrapping_add(0x122e)), rng(2) as u16);
                m.hw.wr16(lin(ss, bp.wrapping_add(0x182)), rng(65536) as u16);
            } else {
                made_up_edge(&mut m, o, &mut rng);
            }
            // SS:00C0 clear, to count the calls in which the game's divide-error handler ran
            let flag = lin(m.cpu.s[2], 0xc0) as usize;
            m.hw.mem[flag] = 0;
            let start = m.snapshot();
            let game = game_near(&start, o.near, &mut seen);
            let ours = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                let mut m = Machine::new();
                m.restore(&start);
                o.run(&mut m);
                if o.near {
                    m.ret();
                } else {
                    m.retf();
                }
                m
            }))
            .ok();
            let ok = match (&game, &ours) {
                (Some(g), Some(m)) => {
                    faults += g.mem[flag] as usize;
                    let sp = lin(start.cpu.s[2], start.cpu.r[4]) as usize;
                    (0..m.hw.mem.len())
                        .all(|a| (sp - STACK..sp).contains(&a) || m.hw.mem[a] == g.mem[a])
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
            .map(|(seg, ip)| format!("{seg:04x}:{ip:04x}"))
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
fn ours_check(out: &Path, names: &str) {
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
        let all: Vec<Ours> = ours()
            .into_iter()
            .filter(|o| names == "all" || names.split(',').any(|n| n == o.name))
            .collect();
        // one hook number each, below the one call_far returns at
        assert!(
            AT_CALL as usize + all.len() <= 0xfd,
            "{} routines: too many to hook at once",
            all.len()
        );
        for (k, o) in all.iter().enumerate() {
            m.hook(lin(o.seg + IMAGE, o.off), AT_CALL + k as u8);
        }
        let (cs, ip) = (m.cpu.s[1], m.cpu.ip);
        let n = m
            .call_far(cs, ip, 50_000_000, &mut |m, n| {
                let o = &all[(n - AT_CALL) as usize];
                o.run(m);
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

/// The recorded race played twice, with the game's 3D routine and with ours in its place
/// (Machine::set_native_3d, as the page runs it): the screens after each run compared, and the
/// time each took. Our routine takes none of the game's time, so the game's frames fall at other
/// moments and the race goes its own way after a while (`shadow` compares the frames themselves);
/// NATIVE_SHOTS=<folder> saves every 500th screen of each.
fn native_check(files: &Path, ops: &str) {
    let play = |native: bool| {
        let mut m = session::machine(files, "GP.EXE", " /g");
        m.set_native_3d(native);
        let sum = |b: &[u8]| {
            b.iter()
                .fold(0u32, |x, &y| x.wrapping_mul(31).wrapping_add(y as u32))
        };
        let mut screens = vec![];
        let mut raced = false;
        let t = std::time::Instant::now();
        for op in session::parse(ops) {
            match op {
                Op::Cycles(c) => {
                    if !(native && raced) {
                        m.cycles_per_ms = c;
                    }
                }
                Op::Key(k) => m.key_byte(k),
                Op::Write(at, bytes) => m.hw.mem[at..at + bytes.len()].copy_from_slice(&bytes),
                Op::Mark => {
                    // the race starts: NATIVE_CYCLES=<per ms> runs it on fewer, with ours
                    raced = true;
                    if let (true, Ok(v)) = (native, std::env::var("NATIVE_CYCLES")) {
                        m.cycles_per_ms = v.parse().unwrap();
                    }
                }
                Op::End(_) => {}
                Op::Run(ms) => {
                    m.run(ms);
                    screens.push(sum(m.render()));
                    if let Ok(dir) = std::env::var("NATIVE_SHOTS") {
                        if screens.len() % 500 == 0 {
                            let png = f1gp_machine::png::encode(m.render(), 320, 200);
                            let name = format!(
                                "{}-{:04}.png",
                                if native { "ours" } else { "game" },
                                screens.len()
                            );
                            std::fs::write(Path::new(&dir).join(name), png).unwrap();
                        }
                    }
                }
            }
        }
        (screens, m.native_frames, t.elapsed().as_secs_f64())
    };
    let (game, n_game, t_game) = play(false);
    let (ours, n_ours, t_ours) = play(true);
    let first = game
        .iter()
        .zip(&ours)
        .position(|(a, b)| a != b)
        .unwrap_or(game.len());
    let _ = n_game;
    println!(
        "the screens the same for the first {first} of {} runs; the game's 3D: {t_game:.1} s; ours: {t_ours:.1} s, {n_ours} frames drawn",
        game.len()
    );
}

/// The recorded race played with the game's 3D routine; at each of its calls our routine also
/// draws, from the same state (its palette step left out), and the two frames are compared:
/// the back buffer each leaves.
fn shadow_check(files: &Path, ops: &str) {
    let mut m = session::machine(files, "GP.EXE", " /g");
    let entry = lin(SEG + IMAGE, ENTRY);
    let mut entry_old: Option<[u8; 3]> = None;
    let mut ret: Option<(u32, [u8; 3])> = None;
    let mut ours: Option<Vec<u8>> = None;
    let (mut same, mut total, mut shown, mut unlisted) = (0, 0, 0, 0);
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
            Op::End(_) => {}
            Op::Run(ms) => {
                let target = m.hw.now + ms * 1000.0;
                while let Some(n) = m.run_until(target) {
                    m.cpu.ip = m.cpu.ip.wrapping_sub(3);
                    if n == AT_ENTRY {
                        let old = entry_old.take().unwrap();
                        m.unhook(entry, old);
                        // ours, from this state, with its display list drawn again at scale 1
                        let mut o = Machine::new();
                        o.restore(&m.snapshot());
                        let bb = back_buffer(&o) as usize;
                        let view = (r3d::list::W * r3d::list::H) as usize;
                        let before = o.hw.mem[bb..bb + view].to_vec();
                        r3d::list::begin(&o);
                        r3d::frame::step(&mut o, 0, r3d::frame::Service::Skip);
                        let l = r3d::list::end().unwrap();
                        let again = r3d::fine::draw(&r3d::fine::prims(&l, 1), Some(&before));
                        if again[..] != o.hw.mem[bb..bb + view] {
                            unlisted += 1;
                        }
                        ours = Some(o.hw.mem[bb..bb + FRAME].to_vec());
                        let sp = lin(m.cpu.s[2], m.cpu.r[4]);
                        let at = lin(rd16(&m, sp + 2), rd16(&m, sp));
                        ret = Some((at, m.hook(at, AT_RETURN)));
                    } else if n == AT_RETURN {
                        let (at, old) = ret.take().unwrap();
                        m.unhook(at, old);
                        let bb = back_buffer(&m) as usize;
                        let theirs = &m.hw.mem[bb..bb + FRAME];
                        let o = ours.take().unwrap();
                        total += 1;
                        let diff = theirs.iter().zip(&o).filter(|(a, b)| a != b).count();
                        if diff == 0 {
                            same += 1;
                        } else if shown < 8 {
                            shown += 1;
                            println!("frame {total}: {diff} of 64000 bytes differ");
                        }
                        entry_old = Some(m.hook(entry, AT_ENTRY));
                    } else {
                        panic!("hook {n:02x}?");
                    }
                }
            }
        }
    }
    println!("{same} of {total} frames the same, ours drawn beside the game's in the whole race; {unlisted} drawn otherwise from the display list");
    if same != total || unlisted != 0 {
        std::process::exit(1);
    }
}

/// Our routine drawn from each caught state with its display list recorded (src/r3d/list.rs);
/// the list drawn again by src/r3d/fine.rs at scale 1 must give the frame our routine drew,
/// byte for byte. At the other scales asked for (`scales`, as 1,2,4) the list is drawn too, and
/// for the first `keep` frames its primitives are saved for the GPU's check
/// (probes/p9-gpu-r3d.mjs) in <out>/gpu: NNNN-sS.prims (four words a primitive), .init (the
/// fine pixels it starts from: at scale 1 the frame before, else none), .want (fine.rs's
/// picture) and, for the first four, a PNG of it.
fn list_check(out: &Path, scales: &str, keep: usize) {
    let scales: Vec<u32> = scales.split(',').map(|s| s.parse().unwrap()).collect();
    let gpu = out.join("gpu");
    if keep > 0 {
        std::fs::create_dir_all(&gpu).unwrap();
    }
    let view = (r3d::list::W * r3d::list::H) as usize;
    let (mut same, mut total) = (0, 0);
    let mut sum = r3d::fine::Stats::default();
    let (mut missing, mut outside, mut pixels, mut cmds) = (0, 0, 0, 0);
    let (mut flat, mut unflat) = (0, 0);
    for (k, p) in caught(out).into_iter().enumerate() {
        let snap = Snapshot::from_bytes(&std::fs::read(&p).unwrap()).unwrap();
        let mut m = Machine::new();
        m.restore(&snap);
        let at = back_buffer(&m) as usize;
        let before = m.hw.mem[at..at + view].to_vec();
        r3d::list::begin(&m);
        r3d::frame::step(&mut m, 0, r3d::frame::Service::Skip);
        let l = r3d::list::end().unwrap();
        let drawn = &m.hw.mem[at..at + view];
        let name = p.file_stem().unwrap().to_string_lossy().to_string();
        total += 1;
        missing += l.missing;
        outside += l.outside;
        pixels += l.as_pixels;
        cmds += l.cmds.len();
        // edges flat on the game's screen (nothing to draw, 80h) that draw at the largest scale
        let top = *scales.iter().max().unwrap();
        for (k, e) in l.edges.iter().enumerate() {
            if matches!(e.of, r3d::list::EdgeOf::Line { .. }) && e.flags as u8 == 0x80 {
                flat += 1;
                if top > 1 && r3d::fine::edge_at(&l, k, top).0 & 0x80 == 0 {
                    unflat += 1;
                }
            }
        }
        let p1 = r3d::fine::prims(&l, 1);
        let got = r3d::fine::draw(&p1, Some(&before));
        let diff = got.iter().zip(drawn).filter(|(a, b)| a != b).count();
        let st = p1.stats;
        sum.edges += st.edges;
        sum.flags_differ += st.flags_differ;
        sum.cut_wrapped += st.cut_wrapped;
        sum.polys += st.polys;
        sum.empty += st.empty;
        if diff == 0 {
            same += 1;
        } else {
            let first = got.iter().zip(drawn).position(|(a, b)| a != b).unwrap();
            println!(
                "{name}: {diff} of {view} bytes differ (first at row {}, column {}); {} of {} edges' flags differ",
                first / 320,
                first % 320,
                st.flags_differ,
                st.edges
            );
        }
        if k < keep {
            // the game's copy of the palette (SS:05DA, 6-bit), as the page reads it
            let pal = lin(m.cpu.s[2], 0x5da) as usize;
            let pal = &m.hw.mem[pal..pal + 768];
            for &s in &scales {
                let ps = r3d::fine::prims(&l, s);
                let init = if s == 1 { Some(&before[..]) } else { None };
                let img = r3d::fine::draw(&ps, init);
                let words: Vec<u8> = r3d::fine::words(&ps)
                    .iter()
                    .flat_map(|w| w.to_le_bytes())
                    .collect();
                let base = gpu.join(format!("{name}-s{s}"));
                std::fs::write(base.with_extension("prims"), words).unwrap();
                std::fs::write(base.with_extension("want"), &img).unwrap();
                if let Some(init) = init {
                    std::fs::write(base.with_extension("init"), init).unwrap();
                }
                if k >= 4 {
                    continue;
                }
                let rgba: Vec<u8> = img
                    .iter()
                    .flat_map(|&c| {
                        let v = |k: usize| {
                            let v = pal[3 * c as usize + k] & 63;
                            v << 2 | v >> 4
                        };
                        [v(0), v(1), v(2), 255]
                    })
                    .collect();
                let png = f1gp_machine::png::encode(&rgba, ps.w as usize, ps.h as usize);
                std::fs::write(base.with_extension("png"), png).unwrap();
            }
        }
    }
    println!(
        "{same} of {total} frames the same drawn from the display list at scale 1; {cmds} commands, {} polygons ({} drew nothing), {} as pixels; {} edges, {} with other flags; {} cuts wrapped; {missing} ring entries without an edge, {outside} writes outside the view",
        sum.polys, sum.empty, pixels, sum.edges, sum.flags_differ, sum.cut_wrapped
    );
    println!(
        "{flat} edges with nothing to draw on the game's screen (flags 80h), {unflat} of them drawn at scale {}",
        scales.iter().max().unwrap()
    );
    if same != total {
        std::process::exit(1);
    }
}

/// Made-up calls of the edge builders (03E9, 02E4, as `fuzz` makes them) built again by
/// src/r3d/fine.rs at scale 1 from what the display list keeps of them: the slot's flags and the
/// record must be those our port of the game's code leaves. Calls whose made-up outcodes
/// disagree with their points (the game's never do), or with no room left for a record (never
/// reached in a race), are left out.
fn fine_edges(out: &Path, trials: usize) {
    let snap = Snapshot::from_bytes(&std::fs::read(&caught(out)[0]).unwrap()).unwrap();
    let mut x = 0x9e37_79b9_7f4a_7c15u64;
    let mut rng = move |n: i32| -> i32 {
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        ((x.wrapping_mul(0x2545_f491_4f6c_dd1d) >> 33) % n as u64) as i32
    };
    let mut failed = false;
    for o in ours().iter().filter(|o| o.off == EDGE || o.off == BORDER) {
        let calls = calls_in(&snap, o.seg, o.off, o.near);
        let (mut same, mut checked, mut drawn, mut wrapped) = (0, 0, 0, 0);
        for t in 0..trials {
            let mut m = Machine::new();
            m.restore(&calls[t % calls.len()].before);
            made_up_edge(&mut m, o, &mut rng);
            let (ss, ds, r) = (m.cpu.s[2], m.cpu.s[3], m.cpu.r);
            let points = rd16(&m, lin(ss, r[5].wrapping_add(0x30)));
            let ends: Vec<u16> = if o.off == EDGE {
                vec![points.wrapping_add(r[1]), points.wrapping_add(r[2])]
            } else {
                vec![points.wrapping_add(r[2])]
            };
            let agrees = ends.iter().all(|&p| {
                let w = |o: u16| rd16(&m, lin(ds, p.wrapping_add(o)));
                let (col, row, code) = (w(0) as i16, w(2) as i16, w(4));
                let sides = match col {
                    ..0 => 8,
                    320.. => 4,
                    _ => 0,
                } | match row {
                    ..0 => 2,
                    164.. => 1,
                    _ => 0,
                };
                code & 0x10 != 0 || code & 0xff == sides
            });
            if !agrees || rd16(&m, lin(ds, 0x2aa)) >= 0xd58c {
                continue;
            }
            checked += 1;
            r3d::list::begin(&m);
            o.run(&mut m);
            let l = r3d::list::end().unwrap();
            let (flags, rec, st) = r3d::fine::edge_at(&l, 0, 1);
            wrapped += st.cut_wrapped;
            let slot = r[7].wrapping_add(r[0]);
            let want = m.hw.mem[lin(ds, slot) as usize];
            let ok = flags == want
                && (want & 0x80 != 0 || {
                    let at = rd16(&m, lin(ds, slot.wrapping_add(2)));
                    let rec = rec.unwrap_or_default();
                    rec.iter().enumerate().all(|(k, &v)| {
                        let w = rd16(&m, lin(ds, at.wrapping_add(2 * k as u16)));
                        if v == i32::MIN {
                            w == 0x8000
                        } else {
                            w as i16 as i32 == v
                        }
                    }) && !rec.is_empty()
                });
            if want & 0x80 == 0 {
                drawn += 1;
            }
            if ok {
                same += 1;
            } else if !failed {
                failed = true;
                println!(
                    "{} trial {t}: flags {flags:02x}, the game's {want:02x}",
                    o.name
                );
            }
        }
        println!("{}: {same} of {checked} made-up edges the same built at scale 1 ({drawn} with something to draw; {wrapped} near-plane cuts where the game's 16-bit arithmetic wraps)", o.name);
    }
    if failed {
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
        Some("ours") => ours_check(
            Path::new(&a[2]),
            a.get(3).map(|s| s.as_str()).unwrap_or("frame"),
        ),
        Some("shadow") => shadow_check(Path::new(&a[2]), &std::fs::read_to_string(&a[3]).unwrap()),
        Some("native") => native_check(Path::new(&a[2]), &std::fs::read_to_string(&a[3]).unwrap()),
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
        Some("list") => list_check(
            Path::new(&a[2]),
            a.get(3).map(|s| s.as_str()).unwrap_or("1"),
            a.get(4).map(|s| s.parse().unwrap()).unwrap_or(0),
        ),
        Some("fine-edges") => fine_edges(
            Path::new(&a[2]),
            a.get(3).map(|s| s.parse().unwrap()).unwrap_or(20_000),
        ),
        Some("dumpfills") => dump_fills(Path::new(&a[2]), a[3].parse().unwrap(), Path::new(&a[4])),
        Some("fills") => fill_calls(
            Path::new(&a[2]),
            a.get(3).map(|s| s.parse().unwrap()).unwrap_or(1),
        ),
        _ => eprintln!("r3d capture <files> <session> <out> [every] [count] | r3d check <out>"),
    }
}
