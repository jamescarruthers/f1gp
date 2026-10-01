// The game's keys (lib/keys.mjs): the site's landing page lists every one.
//
//   cd spike && node --test tests/keys.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { KEY_GROUPS, keysHtml } from '../lib/keys.mjs';

const page = fs.readFileSync(path.join(import.meta.dirname, '..', 'site', 'index.html'), 'utf8');
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

test('the landing page lists every key the Keys panel shows', () => {
  for (const g of KEY_GROUPS) {
    assert.ok(page.includes(`<h3>${esc(g.name)}</h3>`), g.name);
    for (const [k, what] of g.keys) {
      const keys = k.split(/\s{2,}/).map((x) => `<kbd>${esc(x)}</kbd>`).join(' ');
      assert.ok(page.includes(`<tr><td>${keys}</td><td>${esc(what)}</td></tr>`), `${k}: ${what}`);
    }
  }
});

test('the Keys panel has a row per key', () => {
  const rows = keysHtml().match(/<tr>/g).length;
  assert.equal(rows, KEY_GROUPS.reduce((n, g) => n + g.keys.length, 0));
});
