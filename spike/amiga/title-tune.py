#!/usr/bin/env python3
"""Play the Amiga F1GP title tune: run the game's own music player
(frontend, module "music.unit") on an emulated 68000, call its tick 50 times
a second as the VBlank interrupt does, log its writes to the sound chip, and
render them with paula.py.

  python3 title-tune.py mp/d1/frontend out.wav [seconds] [song]
"""
import sys, struct
sys.path.insert(0, __import__('os').path.dirname(__file__))
from hunk import load
from paula import render, write_wav
from unicorn import Uc, UC_ARCH_M68K, UC_MODE_BIG_ENDIAN, UC_HOOK_MEM_WRITE, UC_HOOK_MEM_READ, UC_HOOK_CODE
from unicorn.m68k_const import UC_M68K_REG_A7, UC_M68K_REG_D0, UC_CPU_M68K_M68000

path, out = sys.argv[1], sys.argv[2]
seconds = float(sys.argv[3]) if len(sys.argv) > 3 else 240
song = int(sys.argv[4]) if len(sys.argv) > 4 else None
mem, bases, sizes = load(path)
MOD = 0x8b790            # music.unit jump table (relocated): +0 start, +4 stop, +8 tick, +C set level
SONG = 0x8b7ae           # song number (long), 1 by default
LOOP_PC = 0x8bd3e        # a channel's sequence list ended: back to its start (the song loops)
RET = 0x800
mu = Uc(UC_ARCH_M68K, UC_MODE_BIG_ENDIAN)
mu.ctl_set_cpu_model(UC_CPU_M68K_M68000)
mu.mem_map(0, 0x200000)
mu.mem_write(0, bytes(mem[:0x200000]))
mu.mem_write(RET, b'\x4e\x71\x4e\x71')
mu.mem_map(0xbfd000, 0x3000)
mu.mem_write(0xbfe001, b'\xfc')   # CIA-A PRA: bit 1 = 0, power LED lit, filter on
mu.mem_map(0xdff000, 0x1000)
if song is not None: mu.mem_write(SONG, struct.pack('>I', song))
writes = []
def on_write(uc, access, addr, size, value, data):
    if 0xdff000 <= addr < 0xdff200:
        reg = addr - 0xdff000
        if size == 4 and 0xa0 <= reg < 0xe0: writes.append((reg, value & 0xffffffff, 4))
        elif size == 4: writes.append((reg, (value >> 16) & 0xffff, 2)); writes.append((reg + 2, value & 0xffff, 2))
        else: writes.append((reg, value & 0xffff, 2))
    elif addr == 0xbfe001:
        writes.append(('led', not (value & 2), 1))
mu.hook_add(UC_HOOK_MEM_WRITE, on_write, begin=0xbfd000, end=0xdfffff)
loops = []
mu.hook_add(UC_HOOK_CODE, lambda uc, a, s, d: loops.append(frame), begin=LOOP_PC, end=LOOP_PC)
def call(addr, d0=0):
    sp = 0x1f0000
    mu.mem_write(sp, struct.pack('>I', RET))
    mu.reg_write(UC_M68K_REG_A7, sp)
    mu.reg_write(UC_M68K_REG_D0, d0)
    mu.emu_start(addr, RET, count=200000)
frame = 0
call(MOD + 0)
frames = [writes[:]]; writes.clear()
nframes = int(seconds * 50)
for frame in range(1, nframes):
    call(MOD + 8)
    frames.append(writes[:]); writes.clear()
first_loop = loops[0] if loops else None
print('frames', len(frames), 'register writes', sum(len(f) for f in frames), 'first loop at frame', first_loop,
      '(%.1f s)' % (first_loop / 50) if first_loop else '')
from collections import Counter
print('registers', Counter(r for f in frames for r, v, s in f if r != 'led').most_common(12))
print('LED filter changes', [(i, w[1]) for i, f in enumerate(frames) for w in f if w[0] == 'led'][:10])
st, led = render(frames, mu.mem_read(0, 0x200000))
peak = write_wav(out, st)
print('wrote', out, '%.1f s' % (len(st) / 44100), 'peak %.2f' % peak)
