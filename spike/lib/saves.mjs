// The game's own files between visits: saved games, names, track records,
// car setups and the options (F1PREFS.DAT).
//
// js-dos keeps the DOS drive in memory, so whatever the game writes is gone
// when the page closes. ci.persist(true) packs the files that differ from the
// bundle into a zip; the page keeps that zip in the browser (IndexedDB, one
// record per bundle) and passes it after the bundle on the next start, where
// js-dos lays it over the bundle's files (emulators.dosboxDirect([bundle,
// changes])). The game saves into C:\GPSAVES, which the bundle must hold
// (build-bundle.mjs).
//
// keeper() checks for changes every few seconds while the game is in its
// menus (a check takes 2-4 ms), and when the page is hidden or closed.
//
// menuChoices() keeps the page's own menu and Options choices (localStorage).
//
// Plain ES module. The zip reader is passed in (fflate's unzipSync), so the
// file comparison runs in Node too.

const DB = 'f1gp', STORE = 'changes';

/** The files in a persist() zip: { name: bytes }, without the folders. */
export function zipFiles(zip, unzip) {
  if (!zip || zip.length === 0) return {};
  const out = {};
  for (const [name, bytes] of Object.entries(unzip(zip))) if (!name.endsWith('/')) out[name] = bytes;
  return out;
}

/** True when two file sets ({ name: bytes }) hold the same names and contents. */
export function sameFiles(a, b) {
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    const x = a[k], y = b[k];
    if (!y || x.length !== y.length) return false;
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  }
  return true;
}

function openDb(idb) {
  return new Promise((resolve, reject) => {
    const r = idb.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function request(db, mode, f) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const r = f(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(r?.result);
    tx.onerror = tx.onabort = () => reject(tx.error);
  });
}

/**
 * The browser's store of changes, one record per bundle:
 * { zip: Uint8Array, files: [names], savedAt: ms since 1970 }.
 * Every call fails quietly (null, false) where the browser keeps no storage.
 */
export function changeStore(idb = globalThis.indexedDB) {
  let db = null;
  const get = async () => { if (!idb) throw new Error('no IndexedDB'); return (db ??= await openDb(idb)); };
  return {
    async load(key) { try { return (await request(await get(), 'readonly', (s) => s.get(key))) ?? null; } catch { return null; } },
    async store(key, record) { try { await request(await get(), 'readwrite', (s) => s.put(record, key)); return true; } catch { return false; } },
    async forget(key) { try { await request(await get(), 'readwrite', (s) => s.delete(key)); return true; } catch { return false; } },
  };
}

/** Put k=v in the address (v null: take k out), with no reload and no new history entry. */
export function putInAddress(k, v) {
  if (!globalThis.location || !globalThis.history) return;
  const u = new URL(location.href);
  if (v === null || v === undefined) u.searchParams.delete(k); else u.searchParams.set(k, v);
  history.replaceState(null, '', u);
}

/**
 * The page's menu choices between visits (localStorage, this browser only).
 * apply(q) fills the URLSearchParams q with the stored choices it does not
 * set itself; set(k, v) stores a choice and puts it in the address; forget(k)
 * takes it out of both; keep(k, v) stores only (v null: drops it); clear()
 * drops every stored choice.
 * @param {string[]} keys  the query options the menus set
 */
export function menuChoices(keys, storage = globalThis.localStorage, name = 'f1gp-menus') {
  const read = () => { try { return JSON.parse(storage?.getItem(name) ?? '{}') ?? {}; } catch { return {}; } };
  const keep = (k, v) => {
    const stored = read();
    if (v === null || v === undefined) delete stored[k]; else stored[k] = v;
    try { storage?.setItem(name, JSON.stringify(stored)); } catch { /* storage blocked */ }
  };
  return {
    read,
    keep,
    apply(q) {
      const stored = read();
      for (const k of keys) if (!q.has(k) && typeof stored[k] === 'string') q.set(k, stored[k]);
      return q;
    },
    set(k, v) { keep(k, v); putInAddress(k, v); },
    forget(k) { keep(k, null); putInAddress(k, null); },
    clear() { try { storage?.removeItem(name); } catch { /* storage blocked */ } },
  };
}

/**
 * Keep the game's changed files: check every `every` ms while busy() is false
 * (the game is in its menus), and when the page is hidden or closed.
 * @param {object} ci      js-dos command interface (persist)
 * @param {object} o       { key, store: changeStore(), unzip, every?, busy?, start?: the record loaded at start, onStore?(record) }
 */
export function keeper(ci, o) {
  const every = o.every ?? 5000, busy = o.busy ?? (() => false);
  let kept = o.start ? zipFiles(o.start.zip, o.unzip) : {};
  let running = false, stopped = false;
  const check = async (force = false) => {
    if (running || stopped || (!force && busy())) return null;
    running = true;
    try {
      const zip = await ci.persist(true);
      const files = zipFiles(zip, o.unzip);
      if (sameFiles(files, kept)) return null;
      const record = { zip, files: Object.keys(files).sort(), savedAt: Date.now() };
      if (!(await o.store.store(o.key, record))) return null;
      kept = files;
      o.onStore?.(record);
      return record;
    } catch { return null; } finally { running = false; }
  };
  const timer = setInterval(() => { check(); }, every);
  const hidden = () => { if (globalThis.document?.visibilityState === 'hidden') check(true); };
  const leave = () => { check(true); };
  globalThis.document?.addEventListener('visibilitychange', hidden);
  globalThis.addEventListener?.('pagehide', leave);
  return {
    check,
    get files() { return Object.keys(kept).sort(); },
    stop() {
      stopped = true; clearInterval(timer);
      globalThis.document?.removeEventListener('visibilitychange', hidden);
      globalThis.removeEventListener?.('pagehide', leave);
    },
  };
}
