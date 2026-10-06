// The emulator's sleeps woken by a timer (lib/dos-sleep.mjs), against a
// stand-in for the window and for js-dos's Emscripten module.
//
//   cd spike && node --test tests/dos-sleep.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { timerSleep, sleepCounters } from '../lib/dos-sleep.mjs';

function fakeWindow() {
  const listeners = new Set();
  globalThis.window = {
    addEventListener: (type, f) => { if (type === 'message') listeners.add(f); },
    removeEventListener: (type, f) => { if (type === 'message') listeners.delete(f); },
  };
  return { listeners, send: (data) => { for (const f of [...listeners]) f({ data }); } };
}

function fakeModule(win) {
  const m = { sessionId: 's1', alive: true, sleep_count: 5, nonskippable_sleep_count: 3, sleep_time: 12, woken: 0 };
  m.sync_sleep = (wakeUp) => { m.sync_wakeUp = wakeUp; };
  m.receive = () => { throw new Error('the old receiver ran'); };
  window.addEventListener('message', m.receive);
  m.sleep = (ms) => { if (ms !== undefined) m.wakeUpAt = Date.now() + ms; m.sync_sleep(() => { m.woken++; }); };
  return m;
}

test('replaces the receiver once, and only on a js-dos module', () => {
  const win = fakeWindow(), m = fakeModule(win);
  assert.equal(timerSleep({ transport: { module: m } }), true);
  assert.equal(win.listeners.size, 1);
  assert.ok(win.listeners.has(m.receive));
  assert.equal(timerSleep({ transport: { module: m } }), false);
  assert.equal(timerSleep({ transport: {} }), false);
  assert.equal(timerSleep(null), false);
});

test('wakes at once when the time has come, on a timer when it has not', async () => {
  const win = fakeWindow(), m = fakeModule(win);
  timerSleep({ transport: { module: m } });
  // a skippable sleep: no wake-up time
  m.sleep();
  win.send({ name: 'wc-sync-sleep', props: { sessionId: 's1' } });
  assert.equal(m.woken, 1);
  assert.equal(m.sync_wakeUp, undefined);
  // a sleep to the next millisecond, or more
  m.sleep(15);
  win.send({ name: 'wc-sync-sleep', props: { sessionId: 's1' } });
  assert.equal(m.woken, 1);
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(m.woken, 2);
  assert.equal(m.wakeUpAt, undefined);
});

test('leaves other messages and sessions alone, and a stopped emulator asleep', () => {
  const win = fakeWindow(), m = fakeModule(win);
  timerSleep({ transport: { module: m } });
  m.sleep();
  win.send({ name: 'ws-sync-sleep', props: { sessionId: 's1' } });
  win.send({ name: 'wc-sync-sleep', props: { sessionId: 'other' } });
  win.send('a string');
  assert.equal(m.woken, 0);
  m.alive = false;
  win.send({ name: 'wc-sync-sleep', props: { sessionId: 's1' } });
  assert.equal(m.woken, 0);
});

test('reads js-dos sleep counters', () => {
  const win = fakeWindow(), m = fakeModule(win);
  assert.deepEqual(sleepCounters({ transport: { module: m } }), { sleeps: 5, nonSkippable: 3, sleepMs: 12, busyMs: null });
  assert.equal(sleepCounters({}), null);
});

test('counts the time DOSBox runs between a wake-up and its next sleep', () => {
  const win = fakeWindow(), m = fakeModule(win);
  timerSleep({ transport: { module: m } });
  assert.equal(sleepCounters({ transport: { module: m } }).busyMs, 0);
  // the emulator runs about 5 ms after this wake-up
  m.sync_sleep(() => { const t = performance.now(); while (performance.now() - t < 5); m.woken++; });
  win.send({ name: 'wc-sync-sleep', props: { sessionId: 's1' } });
  assert.equal(m.woken, 1);
  const { busyMs } = sleepCounters({ transport: { module: m } });
  assert.ok(busyMs >= 5 && busyMs < 50, `busyMs ${busyMs}`);
});
