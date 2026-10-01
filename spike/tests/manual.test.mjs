// lib/manual.mjs: the page's answer to the manual question.
//
//   cd spike && node --test tests/manual.test.mjs
//
// The screenshot checks use the route's reference screenshots in out/route/
// (game graphics, not in the repository) and skip when they are absent.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { FINGERPRINTS, MANUAL_ANSWERS, manualScreen, manualHelper } from '../lib/manual.mjs';
import { decodePng } from '../lib/png.mjs';

const require = createRequire(import.meta.url);
const route = require('../lib/route.cjs');
const REF = path.join(import.meta.dirname, '..', 'out', 'route');
const shot = (p) => decodePng(fs.readFileSync(path.join(REF, p)));
const haveShots = ['p6/q1.png', 'p8/r1.png', 'p8/r4.png', 'p1/t004.png'].every((p) => fs.existsSync(path.join(REF, p)));

test('fingerprints and answers are the route\'s', () => {
  assert.deepEqual(MANUAL_ANSWERS, route.MANUAL_ANSWERS);
  for (const name of Object.keys(FINGERPRINTS)) assert.deepEqual(FINGERPRINTS[name], route.FINGERPRINTS[name], name);
  assert.ok(FINGERPRINTS.protection);
});

test('the language and question screens are recognised; other screens are not', { skip: !haveShots && 'no reference screenshots in out/route/' }, () => {
  const lang = manualScreen(shot('p1/t004.png'));
  assert.equal(lang.step, 'language');
  assert.equal(lang.chosen, 0, 'English chosen');
  assert.equal(lang.cursor, 0, 'cursor on English');
  const q = manualScreen(shot('p6/q1.png'));
  assert.equal(q.step, 'question');
  assert.equal(q.known.answer, 'require');
  const joy = manualScreen(shot('p8/r1.png'));
  assert.equal(joy.step, 'joystick');
  assert.equal(joy.cursor, 0, 'Calibrate highlighted');
  assert.equal(manualScreen(shot('p8/r4.png')), null, 'start-up menu');
});

test('the helper moves from English towards O.K. on the language screen', { skip: !haveShots && 'no reference screenshots in out/route/' }, async () => {
  const keys = [];
  const img = shot('p1/t004.png');
  await manualHelper({ image: () => img, sendKey: (code, down) => keys.push([code, down]) }).check();
  assert.deepEqual(keys.filter(([, d]) => d).map(([c]) => c), [262], 'Right');
});

test('the helper types the word and Enter once', { skip: !haveShots && 'no reference screenshots in out/route/' }, async () => {
  const keys = [];
  let answered = null;
  const img = shot('p6/q1.png');
  const h = manualHelper({ image: () => img, sendKey: (code, down) => keys.push([code, down]), onAnswer: (q) => { answered = q; } });
  await h.check();
  const typed = keys.filter(([, down]) => down).map(([c]) => (c === 257 ? '\n' : String.fromCharCode(c))).join('');
  assert.equal(typed, 'REQUIRE\n');
  assert.equal(answered.answer, 'require');
});
