#!/usr/bin/env python3
"""Disassemble part of an Amiga hunk executable (68000, capstone): m68dis.py FILE START_HEX END_HEX.
Addresses are as loaded by hunk.py (first hunk at 10000h)."""
import sys; sys.path.insert(0, __import__('os').path.dirname(__file__))
from hunk import load
import capstone
md = capstone.Cs(capstone.CS_ARCH_M68K, capstone.CS_MODE_BIG_ENDIAN | capstone.CS_MODE_M68K_000)
def dis(mem, a, b):
    out = []
    while a < b:
        got = False
        for i in md.disasm(bytes(mem[a:min(b, a + 16)]), a, 1):
            out.append('%06x  %-22s %s %s' % (i.address, i.bytes.hex(), i.mnemonic, i.op_str)); a += i.size; got = True
        if not got: out.append('%06x  %s  dc.w' % (a, mem[a:a + 2].hex())); a += 2
    return out
if __name__ == '__main__':
    mem, bases, sizes = load(sys.argv[1])
    print('\n'.join(dis(mem, int(sys.argv[2], 16), int(sys.argv[3], 16))))
