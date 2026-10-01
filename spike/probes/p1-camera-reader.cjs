// p1-camera-reader.cjs - read the game's camera, view, viewed car, frame
// tick and pause/menu state from live memory (lib/guest-mem.cjs locate()).
// Addresses were established by the p1-camera probes (recorder
// p1-camera-record.cjs; analyses p1-camera-{views,blind,state,tick,physics}.cjs;
// evidence in out/p1-camera/<run>/analysis-*). Segments are relative to the
// gp.exe load segment: DS = imageSeg + 1E61, SS = imageSeg + 2914.
//
//   const { readCamera } = require('./p1-camera-reader.cjs');
//   const st = readCamera(mem);   // mem = locate(emu.ci)
//
// Live test: timeout 150 node probes/p1-camera-reader.cjs dist/p1-camera-15fps.jsdos
'use strict';

const CAR0 = 0x0d1b, CAR_SIZE = 0xc0;
const VIEW_NAMES = { 0x00: 'cockpit', 0x80: 'tv', 0xa0: 'chase', 0xb0: 'reverse-chase' };

function readCamera(mem) {
  const DS = mem.imageSeg + 0x1e61, SS = mem.imageSeg + 0x2914;
  const s32 = (seg, off) => mem.u32(seg, off) | 0;
  const view = mem.u8(DS, 0x0981);
  const sel = mem.u16(DS, 0x097f), obj = mem.u16(DS, 0x097d);
  const cockpit = view === 0;
  return {
    // Frame tick: game clock in ms; changes once per simulated (= displayed) frame.
    frameMs: mem.u32(DS, 0x2955), frameMsFrac: mem.u16(DS, 0x2959),
    frameMsStep: mem.u32(DS, 0x2241),             // whole ms added per frame (+1 when the fraction carries)
    sessionMs: mem.u32(DS, 0x294f),               // lap/session timer (race: x1.0223 of frameMs rate)
    ticksPerFrame: mem.u16(SS, 0x1230),           // 300 Hz ticks per frame (fps = 300 / this)
    ticksSinceFlip: mem.u16(SS, 0x05c8),          // 300 Hz ticks since the last screen flip
    ticksUsedLastFrame: mem.u16(DS, 0x2c63),      // ticks the last frame's work took (occupancy)
    tick300: mem.u16(SS, 0x05d2),                 // free-running 300 Hz counter
    paused: (mem.u8(DS, 0x2227) & 0x80) !== 0,    // P pause (and the pause after a replay)
    replay: (mem.u8(DS, 0x005a) & 0x80) !== 0,    // replay playing (frameMs jumps back at its start)
    leavingSession: (mem.u8(SS, 0x124e) & 0x10) !== 0, // Esc: the session's main loop is exiting
    notInCar: mem.u8(SS, 0x1108) !== 0,           // menus / not driving
    viewRaw: view, view: VIEW_NAMES[view & 0xb0] || `0x${view.toString(16)}`,
    tvCameraPlaced: (view & 0x40) !== 0,          // TV view: clear for one frame before a camera cut
    viewedCarPtr: sel, viewedCarIndex: (sel - CAR0) / CAR_SIZE, // grid-order index 0..25
    cameraObjectPtr: obj,                         // = viewed car in cockpit, 0x099B (camera record) otherwise
    playerCarPtr: mem.u16(DS, 0x28fd),
    camera: {
      x: s32(DS, 0x2259), y: s32(DS, 0x225d),     // 1/16384 ft (same units as car +28/+2C)
      z: mem.s16(SS, 0x013e),                     // pose height + eye height (DS:233F), track Z units
      yaw: mem.u16(DS, 0x2261),                   // 0x10000 = 360 deg; 0 = +Y, 0x4000 = +X
      pitch: mem.s16(DS, 0x2257) + (cockpit ? mem.s16(DS, 0x2269) : 0), // only moves the horizon
      horizonRow: mem.s16(SS, 0x0130),            // = 0x50 + 256*sin(pitch), clamped to viewportRows
      viewportRows: mem.s16(SS, 0x0132),          // 103 in the cockpit, 164 in external views
      eyeHeight: mem.s16(DS, 0x233f),
    },
  };
}

module.exports = { readCamera, VIEW_NAMES };

// ---------------------------------------------------------------- live test
if (require.main === module) {
  const path = require('node:path');
  const root = path.join(__dirname, '..');
  const { start } = require(path.join(root, 'lib', 'node-emu.cjs'));
  const route = require(path.join(root, 'lib', 'route.cjs'));
  const { locate } = require(path.join(root, 'lib', 'guest-mem.cjs'));
  const XK = { delete: 261, pagedown: 267, home: 268 };
  (async () => {
    const emu = await start(path.join(root, process.argv[2] || 'dist/p1-camera-15fps.jsdos'));
    const drv = route.nodeDriver(emu);
    await route.toTrack(drv, { mode: 'quickrace' });
    const mem = locate(emu.ci);
    await drv.keyDown('a');
    const plan = [[2, 'left'], [5, XK.pagedown], [8, XK.delete], [11, 'right'], [13, 'up'], [15, XK.home], [17, 'p'], [19, 'p']];
    const t0 = Date.now();
    let last = null, frames = 0;
    const log = [];
    const timer = setInterval(() => {
      const st = readCamera(mem);
      if (last && st.frameMs !== last.frameMs) frames++;
      last = st;
    }, 2);
    for (let s = 0; s < 21; s += 0.5) {
      await new Promise((r) => setTimeout(r, t0 + s * 1000 - Date.now()));
      for (const [at, k] of plan) if (at === s) await emu.press(k, 150);
      const st = readCamera(mem);
      log.push(st);
      console.log([`${s.toFixed(1)}s`, `frame=${st.frameMs}`, `v=${st.view}${st.tvCameraPlaced ? '+' : ''}`, `car#${st.viewedCarIndex}`,
        `obj=${st.cameraObjectPtr.toString(16)}`, `cam=(${(st.camera.x / 16384).toFixed(1)},${(st.camera.y / 16384).toFixed(1)},${st.camera.z})`,
        `yaw=${((st.camera.yaw * 360) / 65536).toFixed(1)}`, `hz=${st.camera.horizonRow}/${st.camera.viewportRows}`,
        st.paused ? 'PAUSED' : '', st.replay ? 'REPLAY' : ''].join(' '));
    }
    clearInterval(timer);
    console.log(`frames counted by polling: ${frames} in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    await drv.keyUp('a');
    await emu.stop();
    process.exit(0);
  })().catch((e) => { console.error(e); process.exit(1); });
}
