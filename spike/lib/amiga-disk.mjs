// The Amiga version's sound data, read from its disk images (ADF), for the
// page's Amiga sound (lib/amiga-sound.mjs).
//
// readAdf() lists and reads files on an AmigaDOS (OFS) disk image;
// loadHunks() loads a hunk executable into a flat memory image with its
// relocations applied, its first hunk at 10000h (as spike/amiga/hunk.py
// does, so addresses match docs/amiga-sound.md); soundData() picks out the
// two blocks the page plays from:
//   - "tune": frontend (disk 1) from the song table at 8BD46h to the end of
//     its chip hunk: the title tune's songs, notes, instruments, envelopes
//     and samples, read by the music player (lib/amiga-music.mjs);
//   - "race": f1gp (disk 2) from 80A46h to the end of the effects table at
//     9D79Ah: the nine race sound effects and their table.
// packSound() and unpackSound() store them in one small file
// (dist/amiga-sound.bin on the site, built by build-site.mjs; for local pages:
//   node lib/amiga-disk.mjs [../original/amiga] [dist/amiga-sound.bin]).

const BLOCK = 512;

/** Files on an OFS disk image: { volume, files: [{ name, size, header }], read(name) }. */
export function readAdf(bytes) {
  const d = bytes;
  const u32 = (o) => ((d[o] << 24) | (d[o + 1] << 16) | (d[o + 2] << 8) | d[o + 3]) >>> 0;
  const s32 = (o) => u32(o) | 0;
  const blk = (n) => n * BLOCK;
  const name = (b) => String.fromCharCode(...d.subarray(b + 0x1b1, b + 0x1b1 + d[b + 0x1b0]));
  if (String.fromCharCode(d[0], d[1], d[2]) !== 'DOS') throw new Error('not an AmigaDOS disk');
  if (d[3] & 1) throw new Error('FFS disks are not supported');
  const files = [];
  const walk = (dir, path) => {
    const b = blk(dir);
    for (let i = 0; i < 72; i++) {
      let h = u32(b + 24 + 4 * i), seen = 0;
      while (h && seen++ < 100) {
        const hb = blk(h), type = s32(hb + 0x1fc), nm = path + name(hb);
        if (type === 2) walk(h, `${nm}/`);
        else files.push({ name: nm, size: u32(hb + 0x144), header: h });
        h = u32(hb + 0x1f0);
      }
    }
  };
  walk(880, '');
  const read = (nm) => {
    const f = files.find((x) => x.name.toLowerCase() === nm.toLowerCase());
    if (!f) throw new Error(`no file ${nm} on the disk`);
    const out = new Uint8Array(f.size);
    // OFS: data blocks chained from the file header, 488 bytes of data each
    let n = u32(blk(f.header) + 0x10), at = 0;
    while (n && at < f.size) {
      const db = blk(n), len = Math.min(u32(db + 12), f.size - at);
      out.set(d.subarray(db + 24, db + 24 + len), at);
      at += len;
      n = u32(db + 16);
    }
    if (at !== f.size) throw new Error(`${nm}: read ${at} of ${f.size} bytes`);
    return out;
  };
  return { volume: name(blk(880)), files, read };
}

/** Load a hunk executable: { mem, bases, sizes }, hunks from `base` at 1000h steps. */
export function loadHunks(bytes, base = 0x10000) {
  const d = bytes;
  let o = 0;
  const L = () => { const v = ((d[o] << 24) | (d[o + 1] << 16) | (d[o + 2] << 8) | d[o + 3]) >>> 0; o += 4; return v; };
  if (L() !== 0x3f3) throw new Error('not a hunk executable');
  while (L()) { /* resident library names: none */ }
  L(); const first = L(), last = L();
  const sizes = [];
  for (let i = first; i <= last; i++) sizes.push((L() & 0x3fffffff) * 4);
  const bases = [];
  let a = base;
  for (const s of sizes) { bases.push(a); a = (a + s + 0xfff) & ~0xfff; }
  const mem = new Uint8Array(a);
  const dv = new DataView(mem.buffer);
  let k = -1;
  while (o < d.length) {
    const t = L() & 0x3fffffff;
    if (t === 0x3e9 || t === 0x3ea) { k++; const n = L() * 4; mem.set(d.subarray(o, o + n), bases[k]); o += n; }
    else if (t === 0x3eb) { k++; L(); }
    else if (t === 0x3ec) {
      for (;;) {
        const c = L();
        if (c === 0) break;
        const h = L();
        for (let i = 0; i < c; i++) { const p = bases[k] + L(); dv.setUint32(p, (dv.getUint32(p) + bases[h]) >>> 0); }
      }
    } else if (t === 0x3f2) { /* hunk end */ }
    else if (t === 0x3f0) { for (;;) { const c = L(); if (c === 0) break; o += 4 * c + 4; } }
    else throw new Error(`hunk type ${t.toString(16)}`);
  }
  return { mem, bases, sizes };
}

// the blocks the page plays from, as loaded addresses
export const TUNE = { file: 'frontend', volume: 'f1gp_disk_#1', from: 0x8bd46, to: 0x9fc00 };
export const RACE = { file: 'f1gp', volume: 'f1gp_disk_#2', from: 0x80a46, to: 0x9d82a };
// a few bytes of each, to check the disks are the version the addresses are for
const CHECK = [
  [TUNE, 0x8bd56, [0x00, 0x08, 0xbe, 0x80, 0x00, 0x08, 0xbf, 0x2c]], // song 1's four sequence lists
  [RACE, 0x9d79a, [0x00, 0x08, 0x91, 0xc8, 0x00, 0x00, 0x31, 0xba]], // effect 0: sample 891C8h, 12,730 bytes
];

/** The tune and race blocks from the four disk images (Uint8Arrays): { tune, race } as { base, bytes }. */
export function soundData(disks) {
  const find = (want) => {
    for (const bytes of disks) {
      let adf;
      try { adf = readAdf(bytes); } catch { continue; }
      if (adf.volume === want.volume) return loadHunks(adf.read(want.file)).mem;
    }
    throw new Error(`no disk ${want.volume} with ${want.file}`);
  };
  const out = {};
  for (const [key, want] of [['tune', TUNE], ['race', RACE]]) {
    const mem = find(want);
    for (const [w, at, bytes] of CHECK) {
      if (w !== want) continue;
      if (bytes.some((b, i) => mem[at + i] !== b)) throw new Error(`${want.file}: not the version this page knows`);
    }
    out[key] = { base: want.from, bytes: mem.slice(want.from, want.to) };
  }
  return out;
}

// file: "F1AS", u16 version, u16 count, then per block a u32 base and u32
// length, then the blocks' bytes in order (big-endian, as the Amiga stores them)
export function packSound({ tune, race }) {
  const blocks = [tune, race];
  const head = 8 + 8 * blocks.length;
  const out = new Uint8Array(head + blocks.reduce((n, b) => n + b.bytes.length, 0));
  const dv = new DataView(out.buffer);
  out.set([0x46, 0x31, 0x41, 0x53]);
  dv.setUint16(4, 1); dv.setUint16(6, blocks.length);
  let at = head;
  blocks.forEach((b, i) => { dv.setUint32(8 + 8 * i, b.base); dv.setUint32(12 + 8 * i, b.bytes.length); out.set(b.bytes, at); at += b.bytes.length; });
  return out;
}

export function unpackSound(file) {
  const d = new Uint8Array(file);
  const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
  if (String.fromCharCode(d[0], d[1], d[2], d[3]) !== 'F1AS' || dv.getUint16(4) !== 1) throw new Error('not an F1GP Amiga sound file');
  const n = dv.getUint16(6), blocks = [];
  let at = 8 + 8 * n;
  for (let i = 0; i < n; i++) {
    const base = dv.getUint32(8 + 8 * i), len = dv.getUint32(12 + 8 * i);
    blocks.push({ base, bytes: d.slice(at, at + len) });
    at += len;
  }
  return { tune: blocks[0], race: blocks[1] };
}

// node lib/amiga-disk.mjs [../original/amiga] [dist/amiga-sound.bin]: the file for local pages
if (typeof process !== 'undefined' && import.meta.url === `file://${process.argv[1]}`) {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const dir = process.argv[2] ?? path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..', 'original', 'amiga');
  const out = process.argv[3] ?? path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'dist', 'amiga-sound.bin');
  const disks = fs.readdirSync(dir).filter((f) => /\.adf$/i.test(f)).map((f) => new Uint8Array(fs.readFileSync(path.join(dir, f))));
  const packed = packSound(soundData(disks));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, packed);
  console.log(JSON.stringify({ out, bytes: packed.length }));
}
