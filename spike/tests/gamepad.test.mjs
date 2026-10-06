// A game controller's sticks, triggers and buttons (lib/gamepad.mjs), with
// stand-ins for the browser's Gamepad objects.
//
//   cd spike && node --test tests/gamepad.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readPad, firstPad, padKeys, STEER_DEADZONE } from '../lib/gamepad.mjs';

function pad({ axes = [0, 0, 0, 0], pressed = [], values = {}, mapping = 'standard', id = 'pad' } = {}) {
  const buttons = Array.from({ length: 17 }, (_, i) => ({ pressed: pressed.includes(i), value: values[i] ?? (pressed.includes(i) ? 1 : 0) }));
  return { id, mapping, connected: true, axes, buttons };
}
const near = (a, b) => Math.abs(a - b) < 1e-9;

test('steering: a dead zone at the centre, then a curve to full lock', () => {
  assert.equal(readPad(pad({ axes: [STEER_DEADZONE * 0.9, 0, 0, 0] })).steer, 0);
  assert.ok(near(readPad(pad({ axes: [1, 0, 0, 0] })).steer, 1));
  assert.ok(near(readPad(pad({ axes: [-1, 0, 0, 0] })).steer, -1));
  const half = readPad(pad({ axes: [0.55, 0, 0, 0] })).steer;
  assert.ok(half > 0 && half < 0.5, `gentler near the centre: ${half}`);
});

test('pedals: the triggers, or the right stick up and down', () => {
  const p = readPad(pad({ values: { 7: 1, 6: 0.5 } }));
  assert.ok(near(p.throttle, 1));
  assert.ok(p.brake > 0.45 && p.brake < 0.5);
  assert.ok(near(readPad(pad({ axes: [0, 0, 0, -1] })).throttle, 1), 'right stick up');
  assert.ok(near(readPad(pad({ axes: [0, 0, 0, 1] })).brake, 1), 'right stick down');
  assert.equal(readPad(pad({ values: { 7: 0.03 } })).throttle, 0, 'a resting trigger');
  const g = readPad(pad({ pressed: [5] }));
  assert.equal(g.gearUp, true);
  assert.equal(g.gearDown, false);
});

test('the first controller, standard mapping first', () => {
  const odd = pad({ mapping: '', id: 'odd' }), std = pad({ id: 'std' });
  assert.equal(firstPad([null, odd, std]).id, 'std');
  assert.equal(firstPad([null, odd]).id, 'odd');
  assert.equal(firstPad([]), null);
  assert.equal(firstPad(undefined), null);
});

test('in a session: each button presses its key once, and lets it go', () => {
  const k = padKeys();
  assert.deepEqual(k.update(readPad(pad({ pressed: [9] })), true, 0), [['KeyP', true]]);
  assert.deepEqual(k.update(readPad(pad({ pressed: [9] })), true, 1000), [], 'held: no repeat in a session');
  assert.deepEqual(k.update(readPad(pad()), true, 1100), [['KeyP', false]]);
  assert.deepEqual(k.update(readPad(pad({ pressed: [0, 2] })), true, 1200), [['Space', true], ['Enter', true]]);
  assert.deepEqual(k.update(readPad(pad({ pressed: [5, 4] })), true, 1300), [['Space', false], ['Enter', false]], 'gears are not keys');
  assert.deepEqual(k.update(readPad(pad({ axes: [-1, 0, 0, 0] })), true, 1400), [], 'the stick steers, it presses nothing');
});

test('in the menus: A chooses, B goes back, the stick moves and a held arrow repeats', () => {
  const k = padKeys({ repeatAfter: 400, repeatEvery: 100 });
  assert.deepEqual(k.update(readPad(pad({ pressed: [0] })), false, 0), [['Enter', true]]);
  assert.deepEqual(k.update(readPad(pad({ pressed: [1] })), false, 50), [['Enter', false], ['Escape', true]]);
  assert.deepEqual(k.update(readPad(pad({ axes: [0, 1, 0, 0] })), false, 100), [['Escape', false], ['ArrowDown', true]]);
  assert.deepEqual(k.update(readPad(pad({ axes: [0, 1, 0, 0] })), false, 450), []);
  assert.deepEqual(k.update(readPad(pad({ axes: [0, 1, 0, 0] })), false, 500), [['ArrowDown', true]], 'repeats after 400 ms');
  assert.deepEqual(k.update(readPad(pad({ axes: [0, 1, 0, 0] })), false, 600), [['ArrowDown', true]], 'then every 100 ms');
  assert.deepEqual(k.update(readPad(pad({ axes: [0, 0.5, 0, 0] })), false, 650), [], 'hysteresis: still held at 0.5');
  assert.deepEqual(k.update(readPad(pad({ axes: [0, 0.3, 0, 0] })), false, 700), [['ArrowDown', false]]);
  assert.deepEqual(k.update(readPad(pad({ axes: [0, 0.5, 0, 0] })), false, 750), [], 'not yet pressed at 0.5');
});

test('a held key is let go when the session starts or the controller goes', () => {
  const k = padKeys();
  k.update(readPad(pad({ pressed: [12] })), false, 0);
  assert.deepEqual(k.update(readPad(pad({ pressed: [12] })), true, 10), [], 'the d-pad is the arrows in both');
  assert.deepEqual(k.update(readPad(pad({ pressed: [0] })), true, 20), [['ArrowUp', false], ['Space', true]]);
  assert.deepEqual(k.update(null, true, 30), [['Space', false]]);
});
