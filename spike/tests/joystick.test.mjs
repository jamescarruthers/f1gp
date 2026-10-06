// The virtual joystick (lib/joystick.mjs) on a fake guest memory holding the
// first bytes of the game's button read, and the game's arithmetic (19ED:288B,
// 28FA) applied to what it writes, against values read in a Quick Race.
// probes/p5-pad.mjs drives a race with it in the browser.
//
//   cd spike && node --test tests/joystick.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { virtualJoystick, controlFlags, axisScale, joystickControls, CENTRE, SWING } from '../lib/joystick.mjs';

const IMAGE_SEG = 0x1a2, SS = IMAGE_SEG + 0x2914, DS = IMAGE_SEG + 0x1e61;
function fakeMem() {
  const H = new Uint8Array(1 << 20);
  H.set([0xba, 0x01, 0x02, 0xec, 0x36, 0xa2, 0xf4, 0x08, 0xcb], ((0x8b6e + IMAGE_SEG) << 4) + 0x06e5);
  const mem = { memBase: 0, imageSeg: IMAGE_SEG, ssLinear: SS << 4, dsLinear: DS << 4, heap: () => H };
  const ss = (o) => (SS << 4) + o;
  // the keyboard preset in force, the game's calibration as shipped, some scales
  H.set([0, 0, 0, 0, 0, 0, 0, 0, 0x8c, 0x80], ss(0x1114));
  H.set([105, 0, 0, 0, 0, 0, 94, 0], ss(0x902));
  H[ss(0x8f4)] = 0xff;
  H[(DS << 4) + 0x66] = 0x31; // the pause key: P
  return { H, mem, ss };
}
const s16 = (H, a) => ((H[a] | (H[a + 1] << 8)) << 16) >> 16;

// the game's turn of an axis into a control: 19ED:288B (steering: >> 7, to +-4095) and 28FA (pedals: >> 12, to 0-127)
function gameAxis(H, ss, axisOff, centreOff, minusScaleOff, plusScaleOff, shift, limit) {
  const v = s16(H, ss(axisOff)) - s16(H, ss(centreOff)), plus = s16(H, ss(plusScaleOff));
  const r = Math.sign(v) !== Math.sign(plus) && v !== 0 ? -((v * s16(H, ss(minusScaleOff))) >> shift) : (v * plus) >> shift;
  return Math.max(-limit, Math.min(limit, r));
}

test('the flags match the game: the keyboard preset none, our joystick controls FC/10 (as read in a race)', () => {
  assert.deepEqual(controlFlags([0, 0, 0, 0, 0, 0, 0, 0, 0x8c, 0x80]), [0, 0]);
  assert.deepEqual(controlFlags([4, 7, 7, 0x10, 0x20, 1, 1, 1, 0x8c, 0x86]), [0xfc, 0x10]);
  assert.deepEqual(controlFlags([1, 0x0a, 9, 0, 0, 1, 0, 0, 0x0c, 0x00]), [0x80 | 0x10 | 0x02 | 0x01, 0]);
  assert.deepEqual(Array.from(joystickControls([0, 0, 0, 0, 0, 0, 0, 0, 0x8c, 0x80])), [4, 7, 7, 0x10, 0x20, 1, 1, 1, 0x8c, 0x86]);
});

test('the scale for a side of an axis is the game\'s: 82080h / swing, the swing at least 20', () => {
  assert.equal(axisScale(1024), 520);
  assert.equal(axisScale(-1024), -520);
  assert.equal(axisScale(-105), -5072); // the shipped calibration (centre 105, ends 0), as read in a race
  assert.equal(axisScale(3), axisScale(20));
});

test('engaged: the controls, flags, calibration and scales; the button read returns at once', () => {
  const { H, mem, ss } = fakeMem();
  const before = H.slice();
  const vj = virtualJoystick(mem);
  assert.equal(vj.engage(), true);
  assert.deepEqual(Array.from(H.subarray(ss(0x1114), ss(0x1114) + 10)), [4, 7, 7, 0x10, 0x20, 1, 1, 1, 0x8c, 0x86]);
  assert.deepEqual([H[ss(0x194)], H[ss(0x195)]], [0xfc, 0x10]);
  assert.equal(H[((0x8b6e + IMAGE_SEG) << 4) + 0x06e5], 0xcb);
  assert.deepEqual([0x8fa, 0x8fc, 0x8fe, 0x900, 0x912, 0x914, 0x916, 0x918].map((o) => s16(H, ss(o))), [-520, 520, -520, 520, -520, 520, -520, 520]);
  assert.equal(s16(H, ss(0x902)), CENTRE);
  // at rest: no steering, no pedals
  assert.equal(gameAxis(H, ss, 0x8f6, 0x902, 0x8fa, 0x8fc, 7, 4095), 0);
  // the values read in a race: steer 0.5 -> 2080, -1 -> -4095, 0.3 -> 1247; throttle 1 -> 127, 0.5 -> 65; brake 1 -> 127
  for (const [steer, want] of [[0.5, 2080], [-1, -4095], [0.3, 1247], [1, 4095]]) {
    vj.set({ steer });
    assert.equal(gameAxis(H, ss, 0x8f6, 0x902, 0x8fa, 0x8fc, 7, 4095), want, `steer ${steer}`);
  }
  for (const [throttle, want] of [[1, 127], [0.5, 65]]) {
    vj.set({ throttle });
    assert.equal(gameAxis(H, ss, 0x90e, 0x91a, 0x912, 0x914, 12, 127), want, `throttle ${throttle}`);
  }
  vj.set({ brake: 1, gearUp: true });
  assert.equal(gameAxis(H, ss, 0x910, 0x920, 0x916, 0x918, 12, 127), 127);
  assert.equal(H[ss(0x8f4)], 0xe0, 'gear up: button 1 low');
  vj.set({ gearDown: true });
  assert.equal(H[ss(0x8f4)], 0xd0, 'gear down: button 2 low');
  // a session starting with these controls makes Space (71h) the pause key; the next set() puts P back
  H[(DS << 4) + 0x66] = 0x71;
  vj.set({});
  assert.equal(H[(DS << 4) + 0x66], 0x31);
  vj.disengage();
  assert.ok(H.every((v, i) => v === before[i]), 'every byte back as it was');
  assert.equal(vj.engaged, false);
});

test('leaves a game it does not know alone', () => {
  const { H, mem } = fakeMem();
  H[((0x8b6e + IMAGE_SEG) << 4) + 0x06e5 + 3] = 0x90;
  const before = H.slice();
  const vj = virtualJoystick(mem);
  assert.equal(vj.engage(), false);
  vj.set({ steer: 1 });
  assert.ok(H.every((v, i) => v === before[i]));
});

test('axis values span the swing', () => {
  const { H, mem, ss } = fakeMem();
  const vj = virtualJoystick(mem);
  vj.engage();
  vj.set({ steer: -2, throttle: 0.25 });
  assert.equal(s16(H, ss(0x8f6)), CENTRE - SWING);
  assert.equal(s16(H, ss(0x90e)), CENTRE + SWING / 4);
});
