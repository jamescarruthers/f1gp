// The emulator's sleeps in js-dos direct mode, woken by a timer.
//
// js-dos runs DOSBox on the page's main thread through Asyncify. When the
// emulated CPU has run its cycles for the current millisecond, DOSBox sleeps
// until the next one (a "non-skippable" sleep, Module.wakeUpAt). js-dos waits
// for that by posting a message to the window ("ws-sync-sleep"); its listener
// in emulators.js posts one back ("wc-sync-sleep"), and Module.receive, in
// wdosbox.js, posts again while the time has not come. So the main thread
// passes messages to itself for the rest of every millisecond: at a low cycles
// setting that is most of its time (probes/p5-profile.mjs).
//
// timerSleep() replaces Module.receive with one that waits for the rest of the
// millisecond on a timer. A message task is not a timer task, so the timer is
// not clamped to 4 ms. DOSBox counts the milliseconds that passed when it
// wakes and runs that many, so the emulated time keeps up with real time.
//
// Plain ES module, browser only (js-dos direct mode, wdosbox.js 8.x).

/**
 * @param {object} ci the js-dos command interface (emulators.dosboxDirect)
 * @returns {boolean} true when the receiver was replaced
 */
export function timerSleep(ci) {
  const m = ci?.transport?.module;
  if (!m || typeof m.receive !== 'function' || typeof m.sync_sleep !== 'function' || m.timerSleep) return false;
  window.removeEventListener('message', m.receive);
  // DOSBox runs from its wake-up to its next sleep: that time is the emulator's (busyMs)
  m.busyMs = 0;
  const wake = () => {
    const w = m.sync_wakeUp;
    delete m.sync_wakeUp; delete m.wakeUpAt;
    if (m.alive && w) { const t = performance.now(); w(); m.busyMs += performance.now() - t; }
  };
  // as wdosbox.js's Module.receive, with a timer in place of the next message
  m.receive = (ev) => {
    const d = ev.data;
    if (d?.name !== 'wc-sync-sleep' || d.props?.sessionId !== m.sessionId) return;
    const left = m.wakeUpAt === undefined ? 0 : m.wakeUpAt - Date.now();
    if (left > 0) setTimeout(wake, left); else wake();
  };
  // Module.destroyAsyncify removes Module.receive, which is now this one
  window.addEventListener('message', m.receive, { passive: true });
  m.timerSleep = true;
  return true;
}

/** js-dos's sleep counters: { sleeps, nonSkippable, sleepMs } since the emulator started, and with
 * timerSleep the time DOSBox has run (busyMs). */
export function sleepCounters(ci) {
  const m = ci?.transport?.module;
  if (!m) return null;
  return { sleeps: m.sleep_count, nonSkippable: m.nonskippable_sleep_count, sleepMs: m.sleep_time, busyMs: m.busyMs ?? null };
}
