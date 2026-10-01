#!/usr/bin/env python3
"""Log the title tune's sound chip writes, tick by tick, from the game's own
music player run on an emulated 68000 (as title-tune.py does), for checking
the JavaScript port (lib/amiga-music.mjs, tests/amiga-music.test.mjs).

  python3 tune-log.py mp/d1/frontend out.json [ticks] [fade_at]

With fade_at, the level offset (+C) steps from 0 to -64 by 2 every second
tick from that tick on, as the front end fades the tune. Writes
{"ticks": N, "fade_at": F, "frames": [[[reg, value, size], ...], ...]}:
frame 0 is the start routine, frames 1.. one tick each. reg is the offset
from DFF000h.
"""
import sys, struct, json
sys.path.insert(0, __import__('os').path.dirname(__file__))
from hunk import load
from unicorn import Uc, UC_ARCH_M68K, UC_MODE_BIG_ENDIAN, UC_HOOK_MEM_WRITE
from unicorn.m68k_const import UC_M68K_REG_A7, UC_M68K_REG_D0, UC_CPU_M68K_M68000

path, out = sys.argv[1], sys.argv[2]
ticks = int(sys.argv[3]) if len(sys.argv) > 3 else 7200
fade_at = int(sys.argv[4]) if len(sys.argv) > 4 else None
mem, bases, sizes = load(path)
MOD, RET = 0x8b790, 0x800
mu = Uc(UC_ARCH_M68K, UC_MODE_BIG_ENDIAN)
mu.ctl_set_cpu_model(UC_CPU_M68K_M68000)
mu.mem_map(0, 0x200000)
mu.mem_write(0, bytes(mem[:0x200000]))
mu.mem_write(RET, b'\x4e\x71\x4e\x71')
mu.mem_map(0xbfd000, 0x3000)
mu.mem_write(0xbfe001, b'\xfc')
mu.mem_map(0xdff000, 0x1000)
writes = []
def on_write(uc, access, addr, size, value, data):
    reg = addr - 0xdff000
    if 0xa0 <= reg < 0xe0 and size == 4: writes.append([reg, value & 0xffffffff, 4])
    elif size == 4: writes.append([reg, (value >> 16) & 0xffff, 2]); writes.append([reg + 2, value & 0xffff, 2])
    else: writes.append([reg, value & 0xffff, 2])
mu.hook_add(UC_HOOK_MEM_WRITE, on_write, begin=0xdff000, end=0xdff1ff)
def call(addr, d0=0):
    sp = 0x1f0000
    mu.reg_write(UC_M68K_REG_D0, d0 & 0xffffffff)
    mu.mem_write(sp, struct.pack('>I', RET))
    mu.reg_write(UC_M68K_REG_A7, sp)
    mu.emu_start(addr, RET, count=200000)
frames = []
call(MOD + 0); frames.append(writes[:]); writes.clear()
for f in range(ticks):
    if fade_at is not None and f >= fade_at and (f - fade_at) % 2 == 0 and (f - fade_at) // 2 <= 32:
        call(MOD + 0xc, -(f - fade_at))
    call(MOD + 8); frames.append(writes[:]); writes.clear()
json.dump({'ticks': ticks, 'fade_at': fade_at, 'frames': frames}, open(out, 'w'))
print('wrote', out, len(frames), 'frames', sum(len(f) for f in frames), 'writes')
