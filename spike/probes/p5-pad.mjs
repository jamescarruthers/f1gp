// A game controller in a Quick Race: render.html in headless Chromium with a
// stand-in for the browser's controllers (navigator.getGamepads, from a script
// run before the page's own), driven like a pad. Checks that in a session the
// page takes over the game's controls (lib/joystick.mjs) and the stick, triggers
// and shoulder buttons steer, accelerate, brake and change gear through them,
// that the buttons press the game's keys (lib/gamepad.mjs) in the menus and in
// the race (the probe gets from the main menu to the race with the pad), and
// that the controls go back when the controller goes and when the session ends.
//
//   timeout 500 node probes/p5-pad.mjs [--query '{"machine":"rust"}']
//
// Output: out/p5-pad/result.json and a line per check; exit 1 if one fails.

import fs from 'node:fs';
import path from 'node:path';
import { launch } from '../lib/browser-emu.mjs';
import { route, sleep } from './browser-probe-lib.mjs';

const OUT = path.join(import.meta.dirname, '..', 'out', 'p5-pad');
fs.mkdirSync(OUT, { recursive: true });

// a standard-mapping pad whose state the probe sets
function fakePad() {
  const pad = { id: 'Probe pad (standard)', index: 0, connected: true, mapping: 'standard', timestamp: 0, axes: [0, 0, 0, 0],
    buttons: Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 })) };
  window.__pad = pad;
  window.__padOn = true;
  Object.defineProperty(navigator, 'getGamepads', { configurable: true, value: () => [window.__padOn ? pad : null] });
}

const args = process.argv.slice(2);
const QUERY = JSON.parse((() => { const i = args.indexOf('--query'); return i >= 0 ? args[i + 1] : '{}'; })());
const emu = await launch({ bundle: 'dist/f1gp.jsdos', page: 'render.html', query: QUERY, viewport: { width: 800, height: 500 }, initScript: fakePad,
  chromiumArgs: ['--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--enable-gpu-compositing'] });
const page = emu.page;
const checks = [];
const check = (name, ok, got) => { checks.push({ name, ok: !!ok, got }); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}`); };

/** Set the pad: axes [lx, ly, rx, ry], pressed button indices, analogue values by index. */
const setPad = (s = {}) => page.evaluate((s) => {
  const p = window.__pad;
  p.axes = s.axes ?? [0, 0, 0, 0];
  p.buttons.forEach((b, i) => { b.value = s.values?.[i] ?? (s.pressed?.includes(i) ? 1 : 0); b.pressed = b.value > 0.5; });
  p.timestamp++;
}, s);
const tap = async (i, ms = 150) => { await setPad({ pressed: [i] }); await sleep(ms); await setPad(); await sleep(400); };
const read = () => page.evaluate(() => {
  const m = window.renderApp.mem, ds = m.ds, st = window.renderApp.state, c = ds.u16(0x28fd), me = st.cars[st.view.viewedSlot];
  return { inSession: st.inSession, paused: !!st.paused, view: ds.u8(0x981), steer: ds.s16(c + 0x7c), accel: ds.s8(c + 0x9b), brake: ds.s8(c + 0x5f),
    mph: me ? me.speedMph : null, gear: me ? me.gear : null, rpm: me ? me.rpm : null, controls: Array.from({ length: 10 }, (_, i) => m.ss.u8(0x1114 + i)), pad: window.renderApp.pad };
});
const KEYBOARD = [0, 0, 0, 0, 0, 0, 0, 0, 0x8c, 0x80];

// the menus: the d-pad and the left stick move the highlight, A chooses
await route.toMainMenu(emu.driver, { log: () => {} });
const menuAt = async () => route.menuIndex('main', route.findHighlight(await emu.driver.screenshot()));
const m0 = await menuAt();
await tap(13);
const m1 = await menuAt();
await setPad({ axes: [0, -1, 0, 0] }); await sleep(200); await setPad(); await sleep(500);
const m2 = await menuAt();
check('menus: the d-pad down and the stick up move the highlight', m1 === m0 + 1 && m2 === m0, { m0, m1, m2 });
// A chooses Quick Race; on the circuit view the d-pad moves to O.K. and A starts the race
await tap(0, 200);
await route.waitScreen(emu.driver, 'circuitView', { timeout: 60000 });
check('menus: A chooses (Quick Race: the circuit view)', true, 'circuitView');
for (let i = 0; i < 6 && route.menuIndex('circuitView', route.findHighlight(await emu.driver.screenshot())) !== 4; i++) await tap(15);
await tap(0, 200);
await route.waitScreen(emu.driver, 'race', { timeout: 90000 });
await route.waitFor(emu.driver, (img) => route.readLights(img) === 'green', { timeout: 60000, interval: 100, stable: 1, what: 'green start lights' });
let r = await read();
check('in the race the page takes over the controls', r.pad.engaged && r.controls.join() === [4, 7, 7, 0x10, 0x20, 1, 1, 1, 0x8c, 0x86].join(), { engaged: r.pad.engaged, controls: r.controls });

await setPad({ values: { 7: 1 } });
await sleep(5000);
r = await read();
check('RT accelerates', r.accel === 127 && r.mph > 60, { accel: r.accel, mph: r.mph });

await setPad({ values: { 7: 0.6 }, axes: [1, 0, 0, 0] });
await sleep(400);
r = await read();
check('the stick steers: full right', r.steer === 4095, r.steer);
await setPad({ values: { 7: 0.6 }, axes: [-0.55, 0, 0, 0] });
await sleep(400);
r = await read();
check('the stick steers: part left, gently near the centre', r.steer < -500 && r.steer > -2000, r.steer);

await setPad({ values: { 6: 1 } });
const before = (await read()).mph;
await sleep(1500);
r = await read();
check('LT brakes', r.brake === 127 && r.mph < before - 30, { brake: r.brake, from: before, to: r.mph });
await setPad();

await tap(9);
r = await read();
check('Start pauses', r.paused, r.paused);
await tap(9);
r = await read();
check('Start again goes on', !r.paused, r.paused);

await tap(3);
r = await read();
check('Y: chase view', r.view === 0xa0, r.view.toString(16));
await tap(14);
r = await read();
check('d-pad left: TV view', (r.view & 0xb0) === 0x80, r.view.toString(16));
await tap(15);
r = await read();
check('d-pad right: back to the cockpit', r.view === 0, r.view.toString(16));

// gears: Auto Gears off (F2), then RB up (with the revs up: the game will not change up at low revs)
// and LB down
await page.evaluate(() => { window.emuCi.sendKeyEvent(291, true); setTimeout(() => window.emuCi.sendKeyEvent(291, false), 150); });
await sleep(800);
await setPad({ values: { 7: 0.8 } });
for (let i = 0; i < 20 && ((await read()).rpm ?? 0) < 11000; i++) await sleep(250);
const r0 = await read(), g0 = r0.gear;
await setPad({ values: { 7: 0.8 }, pressed: [5] }); await sleep(300); await setPad({ values: { 7: 0.8 } }); await sleep(800);
const g1 = (await read()).gear;
await setPad({ values: { 7: 0.3 }, pressed: [4] }); await sleep(300); await setPad({ values: { 7: 0.3 } }); await sleep(800);
const g2 = (await read()).gear;
check('RB changes up, LB down (Auto Gears off)', g1 === g0 + 1 && g2 === g1 - 1, { g0, g1, g2, rpm: r0.rpm, mph: r0.mph });
await setPad();
await page.evaluate(() => { window.emuCi.sendKeyEvent(291, true); setTimeout(() => window.emuCi.sendKeyEvent(291, false), 150); });
await sleep(800);

// the controller goes: the keyboard's controls come back, and the keyboard drives
await page.evaluate(() => { window.__padOn = false; });
await sleep(500);
r = await read();
check('the controller goes: the controls go back', !r.pad.engaged && r.controls.join() === KEYBOARD.join(), { engaged: r.pad.engaged, controls: r.controls });
await page.evaluate(() => window.emuCi.sendKeyEvent(65, true));
await sleep(2500);
r = await read();
await page.evaluate(() => window.emuCi.sendKeyEvent(65, false));
check('and the keyboard drives again', r.mph > 30, r.mph);

// back again, then Back leaves the session: the controls go back for the menus
await page.evaluate(() => { window.__padOn = true; });
await sleep(500);
r = await read();
check('the controller back: taken over again mid-race', r.pad.engaged, r.pad.engaged);
// the keyboard's driving keys take the controls back, and the stick takes them again
await page.keyboard.down('KeyA');
await sleep(2000);
r = await read();
await page.keyboard.up('KeyA');
check('the keyboard A gives the controls back to the keyboard, and drives', !r.pad.engaged && r.controls.join() === KEYBOARD.join() && r.accel === 0, { engaged: r.pad.engaged, mph: r.mph });
await setPad({ axes: [0.5, 0, 0, 0] }); await sleep(500);
r = await read();
check('the stick takes them again', r.pad.engaged && r.steer > 0, { engaged: r.pad.engaged, steer: r.steer });
await setPad();
await tap(8, 200);
await sleep(3000);
r = await read();
check('Back leaves the session; the controls go back', !r.inSession && !r.pad.engaged && r.controls.join() === KEYBOARD.join(), { inSession: r.inSession, engaged: r.pad.engaged, controls: r.controls });

const events = await page.evaluate(() => window.emuEvents.filter((e) => e.type.startsWith('pad-')));
await emu.close();
fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify({ checks, events }, null, 1));
const failed = checks.filter((c) => !c.ok).length;
console.log(`${checks.length - failed}/${checks.length} checks passed; events ${events.map((e) => e.type).join(', ')}`);
process.exit(failed ? 1 : 0);
