// Points in the sun or in a shape's shadow by rays (lib/sun-ray.mjs), with a
// flat roof as the only caster.
//
//   cd spike && node --test tests/sun-ray.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { casterGrid, inSun, sunShare } from '../lib/sun-ray.mjs';

const ft = 64;
// a roof 40 ft square at 20 ft, centred on (0, 0): two triangles, x, y, z and three colours per vertex
function roof(cx = 0, cy = 0, half = 20 * ft, z = 20 * ft) {
  const v = [[cx - half, cy - half], [cx + half, cy - half], [cx + half, cy + half], [cx - half, cy + half]];
  const data = [];
  for (const k of [0, 1, 2, 0, 2, 3]) data.push(v[k][0], v[k][1], z, 1, 1, 1);
  return { data: new Float32Array(data), stride: 6, count: 6 };
}
const norm = (v) => { const l = Math.hypot(...v); return v.map((x) => x / l); };

test('straight overhead: under the roof is in shadow, beside it in the sun', () => {
  const g = casterGrid([roof()]);
  const up = [0, 0, 1];
  assert.equal(inSun(g, [0, 0, 0], up), false);
  assert.equal(inSun(g, [15 * ft, -15 * ft, 0], up), false);
  assert.equal(inSun(g, [25 * ft, 0, 0], up), true);
  assert.equal(inSun(g, [0, 0, 25 * ft], up), true, 'above the roof');
});

test('a low sun puts the shadow beside the roof, away from the sun', () => {
  const g = casterGrid([roof()]);
  // the sun to +x at 45 degrees: the shadow of a roof 20 ft up falls 20 ft toward -x
  const sun = norm([1, 0, 1]);
  assert.equal(inSun(g, [-20 * ft, 0, 0], sun), false, 'shifted shadow');
  assert.equal(inSun(g, [15 * ft, 0, 0], sun), true, 'under the roof but lit from the side');
  assert.equal(inSun(g, [-45 * ft, 0, 0], sun), true, 'past the shadow');
  assert.equal(sunShare(g, [[-20 * ft, 0, 0], [15 * ft, 0, 0], [-45 * ft, 0, 0], [-10 * ft, 5 * ft, 0]], sun), 0.5);
});

test('the grid finds a roof far from the origin, and nothing when there is nothing', () => {
  const g = casterGrid([roof(5000 * ft, -3000 * ft)]);
  assert.equal(inSun(g, [5000 * ft, -3000 * ft, 0], [0, 0, 1]), false);
  assert.equal(inSun(g, [0, 0, 0], [0, 0, 1]), true);
  assert.equal(inSun(casterGrid([]), [0, 0, 0], [0, 0, 1]), true);
  assert.equal(inSun(g, [5000 * ft, -3000 * ft, 0], [0, 0, -1]), false, 'the sun below the horizon');
});
