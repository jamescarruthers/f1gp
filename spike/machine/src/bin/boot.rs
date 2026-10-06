//! Boot a program from a folder of files (the game bundle unpacked) on the
//! machine, natively, and save the screen as it goes: for development.
//!
//!   cargo run --release --bin boot -- <files dir> <out dir> [seconds] [program] [tail]
//!   (keys: BOOT_KEYS="2.5:1c,3.0:9c" presses scan codes at emulated seconds; TRACE=1 logs DOS calls)

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
            if rel.starts_with(".jsdos") {
                continue;
            }
            m.add_file(&rel, std::fs::read(&p).unwrap());
        }
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let files = Path::new(&args[1]);
    let out = Path::new(&args[2]);
    let seconds: f64 = args.get(3).map(|s| s.parse().unwrap()).unwrap_or(10.0);
    let program = args.get(4).cloned().unwrap_or("GP.EXE".into());
    let tail = args.get(5).cloned().unwrap_or(" /g".into());
    std::fs::create_dir_all(out).unwrap();
    let mut m = Machine::new();
    m.dos.trace = std::env::var("TRACE").is_ok();
    add_dir(&mut m, files, files);
    m.start(&program, &tail).unwrap();
    let mut keys: Vec<(f64, u8)> = std::env::var("BOOT_KEYS")
        .unwrap_or_default()
        .split(',')
        .filter(|s| !s.is_empty())
        .map(|s| {
            let (t, k) = s.split_once(':').unwrap();
            (t.parse().unwrap(), u8::from_str_radix(k, 16).unwrap())
        })
        .collect();
    keys.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap());
    let t0 = std::time::Instant::now();
    let steps = (seconds * 10.0) as usize;
    for i in 1..=steps {
        m.run(100.0);
        let t = i as f64 / 10.0;
        while let Some(&(at, k)) = keys.first() {
            if at > t {
                break;
            }
            m.key_byte(k);
            keys.remove(0);
        }
        if i % 10 == 0 {
            let png = f1gp_machine::png::encode(m.render(), 320, 200);
            std::fs::write(out.join(format!("t{:03}.png", i / 10)), png).unwrap();
            eprintln!(
                "{:5.1} s: {:04x}:{:04x} mode {:02x} instr {} ({:.1} s real)",
                t,
                m.cpu.s[1],
                m.cpu.ip,
                m.hw.vga.mode,
                m.cpu.count,
                t0.elapsed().as_secs_f64()
            );
        }
        if let Some(c) = m.exited {
            eprintln!("exited with {}", c);
            break;
        }
    }
    eprintln!("kbd irqs raised {}, port 60h reads {}, irqs taken {:?}, imr {:02x} isr {:02x}, int9 vector {:04x}:{:04x}, int15 vector {:04x}:{:04x}",
        m.hw.stats[0], m.hw.stats[1], &m.hw.irq_taken[..8], m.hw.pic.imr, m.hw.pic.isr, m.hw.rd16(0x26), m.hw.rd16(0x24), m.hw.rd16(0x56), m.hw.rd16(0x54));
    eprintln!("console: {}", m.dos.console);
    eprintln!("log:\n{}", m.log());
}
