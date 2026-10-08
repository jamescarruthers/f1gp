//! The machine for JavaScript (wasm32): plain exported functions on a machine
//! pointer, and buffers the page fills or reads through the module's memory.
//! lib/pc.mjs wraps them.

use crate::pc::Machine;

pub struct Handle {
    m: Machine,
    out: Vec<u8>,
}

fn h(p: *mut Handle) -> &'static mut Handle {
    unsafe { &mut *p }
}
fn s(ptr: *const u8, len: usize) -> String {
    String::from_utf8_lossy(unsafe { std::slice::from_raw_parts(ptr, len) }).to_string()
}

#[no_mangle]
pub extern "C" fn mc_new() -> *mut Handle {
    Box::into_raw(Box::new(Handle {
        m: Machine::new(),
        out: vec![],
    }))
}
#[no_mangle]
pub extern "C" fn mc_alloc(len: usize) -> *mut u8 {
    let mut v = vec![0u8; len];
    let p = v.as_mut_ptr();
    std::mem::forget(v);
    p
}
#[no_mangle]
pub extern "C" fn mc_free(ptr: *mut u8, len: usize) {
    unsafe { drop(Vec::from_raw_parts(ptr, len, len)) }
}
/// Add a file to drive C (takes the data buffer from mc_alloc).
#[no_mangle]
pub extern "C" fn mc_add_file(
    p: *mut Handle,
    name: *const u8,
    name_len: usize,
    data: *mut u8,
    len: usize,
) {
    let v = unsafe { Vec::from_raw_parts(data, len, len) };
    h(p).m.add_file(&s(name, name_len), v);
}
/// Load a program; 0 when it is ready to run.
#[no_mangle]
pub extern "C" fn mc_start(
    p: *mut Handle,
    prog: *const u8,
    prog_len: usize,
    tail: *const u8,
    tail_len: usize,
) -> i32 {
    match h(p).m.start(&s(prog, prog_len), &s(tail, tail_len)) {
        Ok(()) => 0,
        Err(e) => {
            h(p).m.dos.log.push_str(&e);
            -1
        }
    }
}
/// Run for `ms` of emulated time; the exit code once the program has ended, else -1.
#[no_mangle]
pub extern "C" fn mc_run(p: *mut Handle, ms: f64) -> i32 {
    let m = &mut h(p).m;
    m.run(ms);
    m.exited.map(|c| c as i32).unwrap_or(-1)
}
#[no_mangle]
pub extern "C" fn mc_key(p: *mut Handle, byte: u32) {
    h(p).m.key_byte(byte as u8);
}
#[no_mangle]
pub extern "C" fn mc_set_cycles(p: *mut Handle, per_ms: f64) {
    h(p).m.cycles_per_ms = per_ms;
}
/// Draw the 3D view with our routine (1) or the game's own code (0).
#[no_mangle]
pub extern "C" fn mc_native_3d(p: *mut Handle, on: u32) {
    h(p).m.set_native_3d(on != 0);
}
/// The 3D view drawn finer for the page at this scale (1 to 8; 0 stops it), by our routine.
#[no_mangle]
pub extern "C" fn mc_r3d_scale(p: *mut Handle, scale: u32) {
    h(p).m.set_r3d_scale(scale);
}
/// How far the cars keep their 3D model while the 3D view is drawn finer: 0 as the game does,
/// 1 as on a screen the scale times larger, 2 at every distance.
#[no_mangle]
pub extern "C" fn mc_r3d_cars(p: *mut Handle, mode: u32) {
    use crate::r3d::list::Cars;
    h(p).m.set_r3d_cars(match mode {
        0 => Cars::Game,
        2 => Cars::All,
        _ => Cars::Scale,
    });
}
/// The bitmaps drawn larger than their art smoothed (1) or as their pixels (0).
#[no_mangle]
pub extern "C" fn mc_r3d_smooth(p: *mut Handle, on: u32) {
    h(p).m.set_r3d_smooth(on != 0);
}
/// The last frame the game showed with its 3D view drawn finer (src/r3d/shown.rs): what = 0 its
/// serial number, 1 its scale, 2 the screen row the 3D view starts on, 3 its primitives' count
/// of words, 4 their pointer, 5 the screen's pointer (320 x 200), 6 the mask's (1 where the
/// screen shows the 3D view), 7 the palette's (768 bytes, 6-bit).
#[no_mangle]
pub extern "C" fn mc_r3d_shown(p: *mut Handle, what: u32) -> u32 {
    let s = &h(p).m.r3d_shown;
    match what {
        0 => s.serial,
        1 => s.scale,
        2 => s.top,
        3 => s.words.len() as u32,
        4 => s.words.as_ptr() as u32,
        5 => s.screen.as_ptr() as u32,
        6 => s.mask.as_ptr() as u32,
        7 => s.dac.as_ptr() as u32,
        _ => 0,
    }
}
/// The frames our 3D routine has drawn.
#[no_mangle]
pub extern "C" fn mc_native_frames(p: *mut Handle) -> f64 {
    h(p).m.native_frames as f64
}
#[no_mangle]
pub extern "C" fn mc_now(p: *mut Handle) -> f64 {
    h(p).m.hw.now
}
#[no_mangle]
pub extern "C" fn mc_count(p: *mut Handle) -> f64 {
    h(p).m.cpu.count as f64
}
/// The screen as RGBA, 320 x 200.
#[no_mangle]
pub extern "C" fn mc_render(p: *mut Handle) -> *const u8 {
    h(p).m.render().as_ptr()
}
#[no_mangle]
pub extern "C" fn mc_mode(p: *mut Handle) -> u32 {
    h(p).m.hw.vga.mode as u32
}
/// Guest memory (linear 0 at the pointer).
#[no_mangle]
pub extern "C" fn mc_ram(p: *mut Handle) -> *mut u8 {
    h(p).m.hw.mem.as_mut_ptr()
}
#[no_mangle]
pub extern "C" fn mc_ram_len(p: *mut Handle) -> usize {
    h(p).m.hw.mem.len()
}
/// Text for the page (read with mc_out, mc_out_len): 0 the log, 1 the names of the files the program wrote, 2 the console.
#[no_mangle]
pub extern "C" fn mc_text(p: *mut Handle, what: u32) {
    let hd = h(p);
    let t = match what {
        0 => hd.m.log(),
        1 => {
            hd.m.dos
                .changed
                .iter()
                .cloned()
                .collect::<Vec<_>>()
                .join("\n")
        }
        _ => hd.m.dos.console.clone(),
    };
    hd.out = t.into_bytes();
}
/// A file's bytes (read with mc_out, mc_out_len); length u32::MAX when it does not exist.
#[no_mangle]
pub extern "C" fn mc_file(p: *mut Handle, name: *const u8, name_len: usize) -> u32 {
    let hd = h(p);
    match hd.m.dos.files.get(&s(name, name_len).to_uppercase()) {
        Some(d) => {
            hd.out = d.clone();
            d.len() as u32
        }
        None => u32::MAX,
    }
}
#[no_mangle]
pub extern "C" fn mc_out(p: *mut Handle) -> *const u8 {
    h(p).out.as_ptr()
}
#[no_mangle]
pub extern "C" fn mc_out_len(p: *mut Handle) -> usize {
    h(p).out.len()
}
/// Forget which files changed (after the page kept them).
#[no_mangle]
pub extern "C" fn mc_changed_clear(p: *mut Handle) {
    h(p).m.dos.changed.clear();
}
