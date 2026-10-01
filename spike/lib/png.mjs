// Decode the PNGs our own tools write (8-bit RGBA, filter 0 on every row).
import zlib from 'node:zlib';

export function decodePng(buf) {
  const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
  if (buf[25] !== 6) throw new Error('only RGBA PNGs written by lib/node-emu.cjs are supported');
  const idat = [];
  for (let p = 8; p < buf.length;) {
    const len = buf.readUInt32BE(p), type = buf.toString('ascii', p + 4, p + 8);
    if (type === 'IDAT') idat.push(buf.subarray(p + 8, p + 8 + len));
    p += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    if (raw[y * (w * 4 + 1)] !== 0) throw new Error('PNG row filter other than 0');
    raw.copy(data, y * w * 4, y * (w * 4 + 1) + 1, (y + 1) * (w * 4 + 1));
  }
  return { width: w, height: h, data };
}
