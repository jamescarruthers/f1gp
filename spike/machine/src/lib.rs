//! A small PC for F1GP (gp.exe 1.05): an 80286 in real mode and, around it,
//! the devices and the DOS and BIOS services the game uses, so the page can
//! run the game without DOSBox. See README.md.

pub mod cpu;
pub mod devices;
pub mod dos;
pub mod ems;
pub mod pc;
pub mod png;

#[cfg(target_arch = "wasm32")]
pub mod wasm;
