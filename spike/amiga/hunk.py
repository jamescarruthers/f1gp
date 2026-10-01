#!/usr/bin/env python3
"""Load an AmigaOS hunk executable into a flat memory image with relocations
applied. Hunks are placed at chosen bases (default: 0x10000, aligned 0x1000)."""
import struct
def load(path, base=0x10000, mem_size=0x200000):
    d = open(path, 'rb').read()
    o = 0
    def L():
        nonlocal o; v = struct.unpack_from('>I', d, o)[0]; o += 4; return v
    assert L() == 0x3f3
    while L(): pass
    n = L(); first = L(); last = L()
    sizes = [(L() & 0x3fffffff) * 4 for _ in range(last - first + 1)]
    bases, a = [], base
    for s in sizes:
        bases.append(a); a = (a + s + 0xfff) & ~0xfff
    mem = bytearray(max(mem_size, a))
    k = -1
    while o < len(d):
        t = L() & 0x3fffffff
        if t in (0x3e9, 0x3ea):
            k += 1; n = L() * 4
            mem[bases[k]:bases[k] + n] = d[o:o + n]; o += n
        elif t == 0x3eb: k += 1; L()
        elif t == 0x3ec:
            while True:
                c = L()
                if c == 0: break
                h = L()
                for _ in range(c):
                    off = L(); p = bases[k] + off
                    v = struct.unpack_from('>I', mem, p)[0]
                    struct.pack_into('>I', mem, p, (v + bases[h]) & 0xffffffff)
        elif t == 0x3f2: pass
        elif t == 0x3f0:
            while True:
                c = L()
                if c == 0: break
                o += 4 * c + 4
        else: raise ValueError('hunk type %x' % t)
    return mem, bases, sizes
