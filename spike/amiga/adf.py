#!/usr/bin/env python3
"""Tolerant AmigaDOS (OFS/FFS) reader: list and extract files from an ADF."""
import sys, struct, os
B = 512
def u32(b, o): return struct.unpack_from('>I', b, o)[0]
def s32(b, o): return struct.unpack_from('>i', b, o)[0]
class ADF:
    def __init__(self, path):
        self.d = open(path, 'rb').read()
        self.ffs = self.d[3] & 1
    def blk(self, n): return self.d[n * B:(n + 1) * B]
    def name(self, b): return b[0x1B1:0x1B1 + b[0x1B0]].decode('latin-1')
    def entries(self, n):
        b = self.blk(n)
        for i in range(72):
            h = u32(b, 24 + 4 * i)
            seen = 0
            while h and seen < 100:
                hb = self.blk(h)
                yield h, hb
                h = u32(hb, 0x1F0); seen += 1
    def walk(self, n=880, path=''):
        for h, hb in self.entries(n):
            st = s32(hb, 0x1FC)
            nm = path + self.name(hb)
            if st == 2: yield from self.walk(h, nm + '/')
            else: yield nm, h, u32(hb, 0x144)
    def read(self, h):
        hb = self.blk(h); size = u32(hb, 0x144)
        out = bytearray()
        if not self.ffs:
            n = u32(hb, 0x10)  # first data block
            while n and len(out) < size:
                db = self.blk(n)
                ln = u32(db, 12)
                out += db[24:24 + ln]
                n = u32(db, 16)
            return bytes(out[:size])
        blocks = []
        while hb is not None:
            for i in range(72):
                v = u32(hb, 0x134 - 4 * i)
                if v: blocks.append(v)
            ext = u32(hb, 0x1F8)
            hb = self.blk(ext) if ext else None
        for n in blocks: out += self.blk(n)
        return bytes(out[:size])
if __name__ == '__main__':
    a = ADF(sys.argv[1])
    print('ffs' if a.ffs else 'ofs', 'volume', a.name(a.blk(880)))
    out = sys.argv[2] if len(sys.argv) > 2 else None
    for nm, h, size in a.walk():
        print('%8d  %s' % (size, nm))
        if out:
            p = os.path.join(out, nm); os.makedirs(os.path.dirname(p), exist_ok=True)
            data = a.read(h)
            if len(data) != size: print('   short read', len(data))
            open(p, 'wb').write(data)
