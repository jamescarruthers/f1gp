// The Options panel's table (lib/options.mjs) against render.html: every
// option the page reads is in the table and in the page's comment block, with
// the same values, and the table holds together.
//
//   cd spike && node --test tests/options.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { OPTIONS, GROUPS, KEPT, defaultOf, askedOf, valueLabel, withDefaults } from '../lib/options.mjs';

const page = fs.readFileSync(new URL('../render.html', import.meta.url), 'utf8');
const byName = Object.fromEntries(OPTIONS.map((o) => [o.name, o]));

test('the table holds every option the page reads, and no other', () => {
  const read = new Set([...page.matchAll(/q\.get\('(\w+)'\)/g)].map((m) => m[1]));
  read.delete('bundle'); // not in the panel: the site has one bundle
  assert.deepEqual([...read].sort(), OPTIONS.map((o) => o.name).sort());
});

test('the comment block lists every option, with the same values', () => {
  const block = page.slice(page.indexOf('Query options:'), page.indexOf('-->'));
  for (const o of OPTIONS) {
    const m = block.match(new RegExp(`^\\s+${o.name}=(\\S+)`, 'm'));
    assert.ok(m, `${o.name} in the comment block`);
    // (lists such as 30|25|15|...|game or auto|1..6 are not whole)
    if (m[1].includes('|') && !m[1].includes('.')) assert.deepEqual(m[1].split('|').sort(), o.values.map(([v]) => v).sort(), o.name);
  }
  assert.match(block, /Options button/);
});

test('each option is whole', () => {
  const groups = new Set(GROUPS.map(([g]) => g));
  for (const o of OPTIONS) {
    assert.ok(groups.has(o.group), `${o.name}: group`);
    assert.ok(o.label && o.text.endsWith('.'), `${o.name}: label and text`);
    const vs = o.values.map(([v]) => v);
    assert.equal(new Set(vs).size, vs.length, `${o.name}: values once each`);
    for (const style of ['modern', 'classic']) for (const layout of ['single', 'side']) {
      assert.ok(vs.includes(defaultOf(o, { style, layout })), `${o.name}: the default is a value`);
    }
    assert.equal(typeof o.read, 'function');
    if (o.group === 'tests') assert.equal(o.kept, false, `${o.name}: tests are not kept`);
  }
  assert.ok(KEPT.includes('style') && !KEPT.includes('gpucheck') && !KEPT.includes('saves'));
  // the menus' options are kept, as before
  for (const k of ['screen', 'sound', 'framing', 'style', 'cockpit']) assert.ok(KEPT.includes(k), k);
});

test('reads the value in use as the page acts on it', () => {
  assert.equal(byName.layout.read({ layout: 'foo' }), 'side');
  assert.equal(byName.haze.read({ haze: 'foo' }), 'off');
  assert.equal(byName.crowd.read({ crowd: 'foo' }), 'stands');
  assert.equal(byName.framing.read({ framing: 'screen' }), 'original');
  assert.equal(byName.fps.read({ fps: null }), 'game');
  assert.equal(byName.fps.read({ fps: 27 }), '27');
  assert.equal(valueLabel(byName.fps, '27'), '27 a second');
  assert.equal(byName.scale.read({ scale: 3 }), '3');
  assert.equal(byName.smooth.read({ smooth: false }), '0');
  // a styled option: '' while it follows the style, else the value asked
  assert.equal(askedOf(byName.haze, { haze: 'smooth', hazeParam: null }), '');
  assert.equal(askedOf(byName.haze, { haze: 'classic', hazeParam: 'classic' }), 'classic');
  assert.equal(valueLabel(byName.haze, ''), 'From the style');
});

test('fills every kept option at its default, and leaves the rest', () => {
  const q = withDefaults(new URLSearchParams('style=classic&layout=side&haze=off'));
  assert.equal(q.get('haze'), 'off');
  assert.equal(q.get('texture'), 'classic');
  assert.equal(q.get('framing'), 'original');
  assert.equal(q.get('screen'), 'original');
  assert.equal(q.get('fps'), '30');
  assert.equal(q.has('gpucheck'), false);
  assert.equal(q.has('saves'), false);
  assert.equal(withDefaults(new URLSearchParams()).get('screen'), 'new');
  for (const k of KEPT) assert.ok(q.has(k), k);
});
