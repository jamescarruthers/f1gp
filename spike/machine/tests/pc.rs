//! The machine's pieces outside the CPU: DOS's wildcard matching and files, EMS
//! mapping, the timer's rate and reads, the interrupt controller, a small program
//! run end to end (it prints through DOS and exits with a code), hooks on a routine, a routine
//! run alone, snapshots.
//!
//!   cargo test --release

use f1gp_machine::devices::{Pic, Pit, PIT_HZ};
use f1gp_machine::dos::wild_match;
use f1gp_machine::pc::{Machine, HOOKS};

#[test]
fn dos_wildcards() {
    assert!(wild_match("*.SAV", "RACE1.SAV"));
    assert!(!wild_match("*.SAV", "RACE1.DAT"));
    assert!(wild_match("*.*", "F1PREFS.DAT"));
    assert!(wild_match("F1CT??.DAT", "F1CT07.DAT"));
    // as DOS: a ? also matches the blanks that pad a short name
    assert!(wild_match("F1CT??.DAT", "F1CT7.DAT"));
    assert!(!wild_match("F1CT??.DAT", "F1CT123.DAT"));
    assert!(wild_match("GP.EXE", "GP.EXE"));
    assert!(wild_match("????????.???", "README"));
}

#[test]
fn timer_rate_and_count() {
    let mut p = Pit::new();
    // channel 0, lo/hi, mode 2, 1193 (1 kHz)
    p.write(0x43, 0x34, 0.0);
    p.write(0x40, (1193u16 & 0xff) as u8, 0.0);
    p.write(0x40, (1193 >> 8) as u8, 0.0);
    assert!((p.ch[0].period_us() - 1193.0 * 1e6 / PIT_HZ).abs() < 1e-6);
    assert!((p.next_irq - 1000.0).abs() < 1.0);
    // a latched count half way through
    p.write(0x43, 0x00, 500.0);
    let lo = p.read(0x40, 500.0) as u16;
    let hi = p.read(0x40, 500.0) as u16;
    let c = hi << 8 | lo;
    assert!((590..=600).contains(&c), "count {}", c);
}

#[test]
fn interrupt_priority_and_eoi() {
    let mut p = Pic::new(8);
    p.raise(1);
    p.raise(0);
    assert_eq!(p.pending(), Some(0));
    assert_eq!(p.ack(0), 8);
    assert_eq!(p.pending(), None, "IRQ 1 waits while 0 is in service");
    p.write(0x20, 0x20);
    assert_eq!(p.pending(), Some(1));
    p.write(0x21, 0x02);
    assert_eq!(p.pending(), None, "masked");
}

#[test]
fn a_program_runs_prints_and_exits() {
    // a .COM at 0100h: print "hi" (INT 21h AH=09), create OUT.TXT and write "hi" to it, exit with code 7
    let mut prog: Vec<u8> = vec![
        0xb4, 0x09, 0xba, 0x21, 0x01, 0xcd, 0x21, // 100 mov ah,9; mov dx,0121h; int 21h
        0xb4, 0x3c, 0x31, 0xc9, 0xba, 0x24, 0x01, 0xcd,
        0x21, // 107 mov ah,3Ch; xor cx,cx; mov dx,0124h; int 21h
        0x89, 0xc3, 0xb4, 0x40, 0xb9, 0x02, 0x00, 0xba, 0x21, 0x01, 0xcd,
        0x21, // 110 mov bx,ax; mov ah,40h; mov cx,2; mov dx,0121h; int 21h
        0xb8, 0x07, 0x4c, 0xcd, 0x21, // 11C mov ax,4C07h; int 21h
    ];
    assert_eq!(prog.len(), 0x21);
    prog.extend_from_slice(b"hi$OUT.TXT\0");
    let mut m = Machine::new();
    m.add_file("T.COM", prog);
    m.start("T.COM", "").unwrap();
    m.run(10.0);
    assert_eq!(m.exited, Some(7));
    assert_eq!(m.dos.console, "hi");
    assert_eq!(
        m.dos.files.get("OUT.TXT").map(|v| v.as_slice()),
        Some(&b"hi"[..])
    );
    assert!(m.dos.changed.contains("OUT.TXT"));
}

#[test]
fn ems_pages_keep_their_bytes() {
    // allocate 2 pages, write through window 0, map the other page and back
    let code: Vec<u8> = vec![
        0xb4, 0x43, 0xbb, 0x02, 0x00, 0xcd,
        0x67, // mov ah,43h; mov bx,2; int 67h -> dx = handle
        0xb8, 0x00, 0x44, 0x31, 0xdb, 0xcd,
        0x67, // mov ax,4400h; xor bx,bx; int 67h (page 0 in window 0)
        0xb8, 0x00, 0xe0, 0x8e, 0xc0, // mov ax,E000h; mov es,ax
        0x26, 0xc6, 0x06, 0x00, 0x00, 0x5a, // mov byte es:[0],5Ah
        0xb8, 0x00, 0x44, 0xbb, 0x01, 0x00, 0xcd,
        0x67, // mov ax,4400h; mov bx,1; int 67h (page 1)
        0x26, 0xc6, 0x06, 0x00, 0x00, 0x11, // mov byte es:[0],11h
        0xb8, 0x00, 0x44, 0x31, 0xdb, 0xcd, 0x67, // page 0 again
        0x26, 0xa0, 0x00, 0x00, // mov al,es:[0]
        0xb4, 0x4c, 0xcd, 0x21, // exit with AL
    ];
    let mut m = Machine::new();
    m.add_file("E.COM", code);
    m.start("E.COM", "").unwrap();
    m.run(10.0);
    assert_eq!(m.exited, Some(0x5a));
}

#[test]
fn find_first_and_next_in_a_folder() {
    // find GPSAVES\*.SAV: two files there, not the one at the root with the same name
    let mut prog: Vec<u8> = vec![
        0xb4, 0x4e, 0x31, 0xc9, 0xba, 0x40, 0x01, 0xcd,
        0x21, // 100 mov ah,4Eh; xor cx,cx; mov dx,0140h; int 21h
        0x72, 0x0b, // 109 jc 116
        0xfe, 0x06, 0x60, 0x01, // 10B inc byte [0160h]
        0xb4, 0x4f, 0xcd, 0x21, // 10F mov ah,4Fh; int 21h
        0x73, 0xf6, // 113 jnc 10B
        0x90, // 115 nop
        0xa0, 0x60, 0x01, // 116 mov al,[0160h]
        0xb4, 0x4c, 0xcd, 0x21, // 119 exit with AL
    ];
    prog.resize(0x40, 0x90);
    prog.extend_from_slice(b"GPSAVES\\*.SAV\0");
    prog.resize(0x61, 0);
    let mut m = Machine::new();
    m.add_file("F.COM", prog);
    m.add_file("GPSAVES\\A.SAV", vec![1; 10]);
    m.add_file("GPSAVES\\B.SAV", vec![2; 20]);
    m.add_file("A.SAV", vec![3; 30]);
    m.start("F.COM", "").unwrap();
    m.run(10.0);
    assert_eq!(m.exited, Some(2));
    // the DTA (PSP:0080h) holds the last one found, B.SAV, with its size
    let dta = (0x0192usize << 4) + 0x80;
    assert_eq!(&m.hw.mem[dta + 0x1e..dta + 0x1e + 5], b"B.SAV");
    assert_eq!(m.hw.rd16((dta + 0x1a) as u32), 20);
}

/// A .COM that calls a far routine twice (add ax,5; retf) and exits with AL: 1 + 5 + 5 = 11.
fn far_calls() -> Vec<u8> {
    vec![
        0xb8, 0x01, 0x00, // 100 mov ax,1
        0x0e, 0xe8, 0x09, 0x00, // 103 push cs; call 0110
        0x0e, 0xe8, 0x05, 0x00, // 107 push cs; call 0110
        0xb4, 0x4c, 0xcd, 0x21, // 10B mov ah,4Ch; int 21h
        0x90, // 10F
        0x05, 0x05, 0x00, 0xcb, // 110 add ax,5; retf
    ]
}

#[test]
fn a_hook_stops_the_machine_and_rust_does_the_routine() {
    let mut m = Machine::new();
    m.add_file("F.COM", far_calls());
    m.start("F.COM", "").unwrap();
    m.run(0.0);
    assert_eq!(m.exited, None);
    let at = ((m.cpu.s[1] as u32) << 4) + 0x110;
    let old = m.hook(at, HOOKS);
    let mut hits = 0;
    let target = m.hw.now + 10_000.0;
    while let Some(n) = m.run_until(target) {
        assert_eq!(n, HOOKS);
        assert_eq!(m.cpu.ip, 0x113);
        hits += 1;
        m.cpu.r[0] += 100; // the routine's work, in Rust
        m.retf();
    }
    m.unhook(at, old);
    assert_eq!(hits, 2);
    assert_eq!(m.exited, Some(201));
}

#[test]
fn a_routine_runs_alone_and_a_snapshot_comes_back() {
    let mut m = Machine::new();
    m.add_file("F.COM", far_calls());
    m.start("F.COM", "").unwrap();
    let before = m.snapshot();
    m.cpu.r[0] = 7;
    let cs = m.cpu.s[1];
    let n = m
        .call_far(cs, 0x110, 100, &mut |_, n| panic!("hook {n:02x}"))
        .unwrap();
    assert_eq!((n, m.cpu.r[0]), (2, 12));
    // a routine that does not return in time is an error
    m.hook(((cs as u32) << 4) + 0x113, HOOKS);
    let mut seen = 0;
    assert!(m
        .call_far(cs, 0x110, 100, &mut |m, _| {
            seen += 1;
            m.cpu.ip = 0x110;
        })
        .is_err());
    assert!(seen > 0);
    m.restore(&before);
    assert_eq!(m.cpu.r[0], before.cpu.r[0]);
    let bytes = before.to_bytes();
    let back = f1gp_machine::pc::Snapshot::from_bytes(&bytes).unwrap();
    assert_eq!(
        (back.cpu.r, back.cpu.s, back.cpu.ip, back.cpu.flags),
        (before.cpu.r, before.cpu.s, before.cpu.ip, before.cpu.flags)
    );
    assert_eq!(back.mem, before.mem);
}
