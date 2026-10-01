// Phase 2 done test for the track's shape: on every circuit, the track edges
// projected from the game's camera land on the game's own road edges.
//
//   cd spike && node --test tests/p2-alignment.test.mjs
//
// Reads out/p2-ref/index.json, written by probes/p2-capture-check.cjs from
// the reference frames that probes/p2-capture.cjs records (paused frames
// with the exact game state, on all 16 circuits). Skips when it is absent:
// the frames hold game graphics and are not in the repository.
//
// Thresholds are a little looser than the measured values (Monaco and
// Phoenix have pavements the same grey as the road, which makes the colour
// check unreliable there; see the capture report in docs/web-port-plan.md).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const INDEX = path.join(import.meta.dirname, '..', 'out', 'p2-ref', 'index.json');
const index = fs.existsSync(INDEX) ? JSON.parse(fs.readFileSync(INDEX, 'utf8')) : null;
const skip = index ? false : 'no reference frames (run probes/p2-capture.cjs and p2-capture-check.cjs)';
const within = (s, px) => s[`samplesWithin${px}px`] / s.samplesFound;

test('all 16 circuits have reference frames in every view', { skip }, () => {
  const per = index.summary.perCircuitView;
  const circuits = new Set(index.frames.map((f) => f.file));
  assert.equal(circuits.size, 16);
  for (const v of ['cockpit', 'chase', 'tv']) assert.ok(index.summary.perView[v].framesWithCheck >= 200, `${v} frames`);
  assert.ok(per);
});

test('each view: road edges within 2 px for at least 95% of edge samples', { skip }, () => {
  for (const [view, s] of Object.entries(index.summary.perView)) {
    assert.ok(within(s, 2) >= 0.95, `${view}: ${(100 * within(s, 2)).toFixed(1)}% within 2 px`);
    assert.ok(s.medianOfFrameMedians.median <= 0.5, `${view}: median error ${s.medianOfFrameMedians.median} px`);
  }
});

test('each circuit: road edges within 2 px for at least 85% of edge samples, median under 0.5 px', { skip }, () => {
  for (const [file, s] of Object.entries(index.summary.perCircuit)) {
    assert.ok(within(s, 2) >= 0.85, `${file} ${s.track}: ${(100 * within(s, 2)).toFixed(1)}% within 2 px`);
    assert.ok(s.medianOfFrameMedians.median <= 0.5, `${file} ${s.track}: median ${s.medianOfFrameMedians.median} px`);
  }
});
