// The game's files and the page's menu choices between visits
// (lib/saves.mjs), with stand-ins for js-dos, the store and localStorage.
// probes/p5-saves.mjs checks the whole path in the browser.
//
//   cd spike && node --test tests/saves.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zipSync, unzipSync } from 'fflate';
import { zipFiles, sameFiles, keeper, menuChoices } from '../lib/saves.mjs';

const enc = (s) => new TextEncoder().encode(s);
const zip = (files) => zipSync({ 'GPSAVES/': new Uint8Array(0), ...files });

test('reads the files of a persist() zip, without the folders', () => {
  assert.deepEqual(Object.keys(zipFiles(zip({ 'GPSAVES/A': enc('x'), 'F1PREFS.DAT': enc('y') }), unzipSync)).sort(), ['F1PREFS.DAT', 'GPSAVES/A']);
  assert.deepEqual(zipFiles(null, unzipSync), {});
  assert.deepEqual(zipFiles(zip({}), unzipSync), {});
});

test('compares file sets by name and contents', () => {
  assert.ok(sameFiles({ a: enc('1') }, { a: enc('1') }));
  assert.ok(!sameFiles({ a: enc('1') }, { a: enc('2') }));
  assert.ok(!sameFiles({ a: enc('1') }, { b: enc('1') }));
  assert.ok(!sameFiles({ a: enc('1') }, { a: enc('1'), b: enc('2') }));
  assert.ok(sameFiles({}, {}));
});

function fakes(zips) {
  let n = 0;
  const ci = { persist: async () => zips[Math.min(n++, zips.length - 1)] };
  const stored = [];
  const store = { store: async (key, record) => { stored.push({ key, record }); return true; } };
  return { ci, store, stored, calls: () => n };
}

test('keeps a change once, and only while the game is not racing', async () => {
  const a = zip({ 'GPSAVES/A': enc('one') }), b = zip({ 'GPSAVES/A': enc('two') });
  const f = fakes([zip({}), a, a, b]);
  let racing = false;
  const k = keeper(f.ci, { key: 'k', store: f.store, unzip: unzipSync, every: 1e9, busy: () => racing });
  try {
    assert.equal(await k.check(), null);          // nothing changed yet
    assert.ok(await k.check());                   // A written
    assert.equal(await k.check(), null);          // the same again
    racing = true;
    assert.equal(await k.check(), null);          // racing: not asked
    assert.equal(f.calls(), 3);
    assert.ok(await k.check(true));               // forced (the page hidden): A changed
    assert.deepEqual(f.stored.map((s) => s.key), ['k', 'k']);
    assert.deepEqual(f.stored[1].record.files, ['GPSAVES/A']);
    assert.deepEqual(k.files, ['GPSAVES/A']);
  } finally { k.stop(); }
});

test('does not store again what was loaded at start', async () => {
  const a = zip({ 'GPSAVES/A': enc('one') });
  const f = fakes([a]);
  const k = keeper(f.ci, { key: 'k', store: f.store, unzip: unzipSync, every: 1e9, start: { zip: a, files: ['GPSAVES/A'] } });
  try {
    assert.equal(await k.check(), null);
    assert.equal(f.stored.length, 0);
  } finally { k.stop(); }
});

test('keeps menu choices; the address wins', () => {
  const mem = new Map();
  const storage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) };
  const c = menuChoices(['style', 'sound'], storage);
  c.set('style', 'classic');
  c.set('sound', 'adlib');
  c.set('other', 'x');
  const q = c.apply(new URLSearchParams('sound=amiga'));
  assert.equal(q.get('style'), 'classic');
  assert.equal(q.get('sound'), 'amiga');
  assert.equal(q.get('other'), null);
  // no storage, or broken storage: nothing kept, nothing thrown
  assert.equal(menuChoices(['style'], undefined).apply(new URLSearchParams()).get('style'), null);
  mem.set('f1gp-menus', '{not json');
  assert.equal(c.apply(new URLSearchParams()).get('style'), null);
});
