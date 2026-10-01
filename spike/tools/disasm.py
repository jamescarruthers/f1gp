#!/usr/bin/env python3
"""Disassemble and search the unpacked gp.exe load image (16-bit real mode).

The image is spike/out/gp_unpacked.bin (see tools/unexepack.mjs): offset 0 is
the program's load segment, and segment numbers in the code are relative to
it (relocations are not applied).  This script holds no game bytes; it reads
the image at run time.

Needs capstone (pip install capstone), e.g. in a venv:
  python3 -m venv out/research-phase1/static/venv
  out/research-phase1/static/venv/bin/pip install capstone
  PY=out/research-phase1/static/venv/bin/python

Addresses: "1E61:0D1B" (relative segment:offset, hex), "s2:2127" (segment by
index in the table below), or a plain linear image offset "0x1BFF7".

Commands:
  $PY tools/disasm.py segs
  $PY tools/disasm.py dis s2:2127 [+0x40 | END]    linear disassembly of a range
  $PY tools/disasm.py fn s0:2D17 [--max 400]       follow one routine (flow order)
  $PY tools/disasm.py listing [--out DIR]          full listing of every code segment
  $PY tools/disasm.py xref --disp 0x28 [--base si] [--write] [--seg 0,1]
  $PY tools/disasm.py xref --imm 0x0D1B            immediates (also matches disp)
  $PY tools/disasm.py xref --re 'cs:\\[0x20\\]'     regex on the instruction text
  $PY tools/disasm.py calls s0:2D24                near/far calls and jumps to a target
  $PY tools/disasm.py bytes 'c4 7c 12'             raw byte search (?? = any byte)
  $PY tools/disasm.py words 1E61:097F +0x10        dump data words

Code is found by recursive descent from the entry point and every far call
target, then gaps are filled by a linear sweep (those lines are marked "?").
Search results carry a context window (-C N) of surrounding instructions.
Notes on capstone output: 0x99 prints as "cdq" but is CWD in 16-bit code;
near call/jmp targets past 0xFFFF print unwrapped (0x111b1 = 0000:11B1);
"lcall 0x19ed, 0x2127" is a far call to 19ED:2127.  [bp+X] addresses SS
(gp.exe keeps BP = 0), plain [X] addresses DS.
"""

import argparse
import os
import re
import signal
import sys
from collections import defaultdict

try:
    import capstone
    from capstone import x86
except ImportError:  # pragma: no cover
    sys.exit("capstone is missing: pip install capstone (see the header comment)")

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_IMAGE = os.path.join(HERE, "..", "out", "gp_unpacked.bin")

# Segment table for F1GP 1.05 European, relative paragraphs.  Taken from
# GpTest (sdidit/f1gp-utils GpTest/GPTEST.ASM, eu_seg_base); the last entry
# is the end of the image.  "code" marks segments that hold code (far-call
# target statistics and code-byte density over the image).
SEGS = [0x0000, 0x0F47, 0x19ED, 0x1E61, 0x2914, 0x30CA, 0x40C1, 0x50BA,
        0x605A, 0x6BE7, 0x7BCE, 0x8B6E, 0x8CE6, 0x8EAA, 0x9151]
CODE_SEGS = [0, 1, 2, 8, 9, 11, 13]
ENTRY = (0, 0x0000)  # CS:IP from the EXEPACK header

SEG_NOTES = {
    0: "code (main game: physics, AI, car loop)",
    1: "code",
    2: "code (frame / display / cockpit text helpers per GpTest)",
    3: "data: DS of the game (cars at 0D1B)",
    4: "data: initial SS (stack + variables)",
    5: "bss (64K buffer)",
    6: "bss (64K buffer)",
    7: "bss (64K buffer)",
    8: "code (start-up, DOS version check at B74A)",
    9: "code",
    10: "data",
    11: "code",
    12: "bss",
    13: "code/data",
}


def seg_index_of_linear(lin):
    for i in range(len(SEGS) - 1):
        if SEGS[i] * 16 <= lin < SEGS[i + 1] * 16:
            return i
    return None


def parse_addr(text):
    """Return (seg_index_or_None, seg_value, offset, linear)."""
    t = text.strip()
    m = re.fullmatch(r"s(\d+):([0-9a-fA-Fx]+)", t)
    if m:
        i = int(m.group(1))
        off = int(m.group(2), 16)
        return i, SEGS[i], off, SEGS[i] * 16 + off
    m = re.fullmatch(r"([0-9a-fA-F]+):([0-9a-fA-F]+)h?", t)
    if m:
        seg = int(m.group(1), 16)
        off = int(m.group(2), 16)
        idx = SEGS.index(seg) if seg in SEGS else None
        return idx, seg, off, seg * 16 + off
    lin = int(t, 0)
    i = seg_index_of_linear(lin)
    return i, SEGS[i], lin - SEGS[i] * 16, lin


class Image:
    def __init__(self, path):
        with open(path, "rb") as f:
            self.data = f.read()
        self.md = capstone.Cs(capstone.CS_ARCH_X86, capstone.CS_MODE_16)
        self.md.detail = True
        self._code = None

    def seg_bytes(self, i):
        a, b = SEGS[i] * 16, min(SEGS[i + 1] * 16, len(self.data))
        return self.data[a:b]

    def decode_one(self, i, off):
        buf = self.seg_bytes(i)
        if off >= len(buf):
            return None
        for ins in self.md.disasm(buf[off:off + 16], off, 1):
            return ins
        return None

    def linear(self, i, start, end):
        buf = self.seg_bytes(i)
        end = min(end, len(buf))
        off = start
        out = []
        while off < end:
            ins = None
            for ins in self.md.disasm(buf[off:min(off + 16, len(buf))], off, 1):
                pass
            if ins is None:
                out.append(("db", off, buf[off:off + 1]))
                off += 1
                continue
            out.append(("ins", off, ins))
            off += ins.size
        return out

    # ---- recursive descent -------------------------------------------------
    def code_map(self):
        """{seg_index: {offset: insn}} from recursive descent + gap sweep."""
        if self._code is not None:
            return self._code
        found = {i: {} for i in CODE_SEGS}
        owner = {i: {} for i in CODE_SEGS}  # byte -> insn start
        roots = defaultdict(set)
        roots[ENTRY[0]].add(ENTRY[1])
        # Pre-seed with far call targets found by a first linear sweep.
        for i in CODE_SEGS:
            for kind, off, ins in self.linear(i, 0, 1 << 20):
                if kind != "ins":
                    continue
                tgt = far_target(ins)
                if tgt and tgt[0] in SEGS and SEGS.index(tgt[0]) in CODE_SEGS:
                    roots[SEGS.index(tgt[0])].add(tgt[1])
        work = [(i, o) for i, s in roots.items() for o in s]
        while work:
            i, off = work.pop()
            buf_len = len(self.seg_bytes(i))
            while 0 <= off < buf_len:
                if off in found[i]:
                    break
                if off in owner[i]:
                    break  # lands inside another instruction: stop
                ins = self.decode_one(i, off)
                if ins is None:
                    break
                found[i][off] = ins
                for b in range(off, off + ins.size):
                    owner[i][b] = off
                m = ins.mnemonic
                near = near_target(ins)
                if near is not None:
                    work.append((i, near))
                ft = far_target(ins)
                if ft and ft[0] in SEGS and SEGS.index(ft[0]) in CODE_SEGS:
                    work.append((SEGS.index(ft[0]), ft[1]))
                tbl = jump_table(self, i, ins)
                for t in tbl:
                    work.append((i, t))
                if m in ("ret", "retf", "iret", "jmp", "ljmp", "hlt") or m.startswith("ret"):
                    break
                off += ins.size
        # Fill gaps by linear sweep (marked as unconfirmed).
        result = {}
        for i in CODE_SEGS:
            seg = dict((o, (ins, True)) for o, ins in found[i].items())
            buf_len = len(self.seg_bytes(i))
            off = 0
            while off < buf_len:
                if off in seg:
                    off += seg[off][0].size
                    continue
                if off in owner[i]:
                    off += 1
                    continue
                ins = self.decode_one(i, off)
                if ins is None or any(b in owner[i] for b in range(off, off + ins.size)):
                    off += 1
                    continue
                seg[off] = (ins, False)
                off += ins.size
            result[i] = seg
        self._code = result
        return result


def near_target(ins):
    if ins.mnemonic in ("call", "jmp") or ins.mnemonic.startswith("j") or ins.mnemonic.startswith("loop") or ins.mnemonic == "jcxz":
        if len(ins.operands) == 1 and ins.operands[0].type == x86.X86_OP_IMM and ins.mnemonic not in ("ljmp", "lcall"):
            if ":" in ins.op_str:
                return None
            return ins.operands[0].imm & 0xFFFF
    return None


def far_target(ins):
    if ins.mnemonic in ("lcall", "ljmp") and len(ins.operands) == 2:
        m = re.fullmatch(r"(0x[0-9a-f]+|\d+)(?::|, )(0x[0-9a-f]+|\d+)", ins.op_str.strip())
        if m:
            return int(m.group(1), 0), int(m.group(2), 0)
    return None


def jump_table(img, i, ins):
    """Targets of 'jmp word ptr cs:[reg + table]' (bounded heuristic)."""
    if ins.mnemonic != "jmp" or len(ins.operands) != 1:
        return []
    op = ins.operands[0]
    if op.type != x86.X86_OP_MEM or op.mem.segment != x86.X86_REG_CS or op.mem.disp == 0:
        return []
    buf = img.seg_bytes(i)
    tbl = op.mem.disp & 0xFFFF
    out = []
    for k in range(128):
        p = tbl + 2 * k
        if p + 2 > len(buf):
            break
        t = buf[p] | (buf[p + 1] << 8)
        if t >= len(buf) or t < 0x10:
            break
        if out and abs(t - out[0]) > 0x4000:
            break
        out.append(t)
        if tbl <= t <= p + 2:  # table runs into code
            break
    return out


def fmt(i, off, ins, confirmed=True, data=None):
    seg = SEGS[i]
    lin = seg * 16 + off
    if ins is None:
        return f"{lin:06X} {seg:04X}:{off:04X}  {data.hex():<14} db"
    mark = " " if confirmed else "?"
    return f"{lin:06X} {seg:04X}:{off:04X}{mark} {ins.bytes.hex():<14} {ins.mnemonic} {ins.op_str}"


def sorted_code(img, i):
    cm = img.code_map()[i]
    return sorted(cm.items())


def cmd_segs(img, a):
    for i in range(len(SEGS) - 1):
        print(f"s{i:<2} {SEGS[i]:04X}  lin {SEGS[i]*16:06X}-{SEGS[i+1]*16:06X}  {SEG_NOTES.get(i, '')}")


def cmd_dis(img, a):
    i, seg, off, lin = parse_addr(a.addr)
    end = off + 0x60
    if a.end:
        end = off + int(a.end[1:], 16) if a.end.startswith("+") else parse_addr(a.end)[2]
    if a.flow and i in CODE_SEGS:
        for o, (ins, conf) in sorted_code(img, i):
            if off <= o < end:
                print(fmt(i, o, ins, conf))
        return
    for kind, o, x in img.linear(i, off, end):
        print(fmt(i, o, x if kind == "ins" else None, True, x if kind != "ins" else None))


def cmd_fn(img, a):
    """Follow a routine in flow order: straight-line blocks, jumps queued."""
    i, seg, off, lin = parse_addr(a.addr)
    seen = set()
    queue = [off]
    count = 0
    while queue and count < a.max:
        o = queue.pop(0)
        if o in seen:
            continue
        print(f"--- {SEGS[i]:04X}:{o:04X}")
        while count < a.max:
            if o in seen:
                print(f"    (joins {SEGS[i]:04X}:{o:04X})")
                break
            ins = img.decode_one(i, o)
            if ins is None:
                break
            seen.add(o)
            print(fmt(i, o, ins))
            count += 1
            m = ins.mnemonic
            t = near_target(ins)
            if t is not None and m != "call":
                queue.append(t)
            if m in ("ret", "retf", "iret", "jmp", "ljmp") or m.startswith("ret"):
                break
            o += ins.size


def iter_all(img, segs):
    for i in segs:
        for off, (ins, conf) in sorted_code(img, i):
            yield i, off, ins, conf


REG = {"si": x86.X86_REG_SI, "di": x86.X86_REG_DI, "bx": x86.X86_REG_BX, "bp": x86.X86_REG_BP}


def mem_ops(ins):
    for k, op in enumerate(ins.operands):
        if op.type == x86.X86_OP_MEM:
            yield k, op


def is_write(ins, k):
    m = ins.mnemonic
    if k != 0:
        return m in ("xchg",)
    if m in ("cmp", "test", "push", "call", "jmp", "lcall", "ljmp", "les", "lds", "lea") or m.startswith("j"):
        return False
    if m in ("mov", "add", "sub", "adc", "sbb", "and", "or", "xor", "inc", "dec", "neg", "not",
             "shl", "shr", "sar", "sal", "rol", "ror", "rcl", "rcr", "pop", "xchg", "movsb", "movsw",
             "stosb", "stosw", "setne", "sete") or m.startswith("set"):
        return True
    return False


def context(img, i, off, n):
    rows = sorted_code(img, i)
    offs = [o for o, _ in rows]
    import bisect
    k = bisect.bisect_left(offs, off)
    lo, hi = max(0, k - n), min(len(rows), k + n + 1)
    return rows[lo:hi]


def cmd_xref(img, a):
    segs = [int(s) for s in a.seg.split(",")] if a.seg else CODE_SEGS
    base = REG.get(a.base) if a.base else None
    rx = re.compile(a.re) if a.re else None
    hits = 0
    for i, off, ins, conf in iter_all(img, segs):
        ok = False
        if rx is not None:
            ok = bool(rx.search(f"{ins.mnemonic} {ins.op_str}"))
        if a.disp is not None:
            for k, op in mem_ops(ins):
                if (op.mem.disp & 0xFFFF) == (a.disp & 0xFFFF):
                    if base is not None and op.mem.base != base and op.mem.index != base:
                        continue
                    if a.nobase and (op.mem.base or op.mem.index):
                        continue
                    if a.write and not is_write(ins, k):
                        continue
                    if a.read and is_write(ins, k) and ins.mnemonic == "mov":
                        continue
                    ok = True
        if a.imm is not None:
            for op in ins.operands:
                if op.type == x86.X86_OP_IMM and (op.imm & 0xFFFF) == (a.imm & 0xFFFF):
                    ok = True
        if not ok:
            continue
        if a.confirmed and not conf:
            continue
        hits += 1
        if a.C:
            print("")
            for o, (ins2, c2) in context(img, i, off, a.C):
                print(("=> " if o == off else "   ") + fmt(i, o, ins2, c2))
        else:
            print(fmt(i, off, ins, conf))
    print(f"; {hits} hits", file=sys.stderr)


def cmd_calls(img, a):
    i, seg, off, lin = parse_addr(a.addr)
    for j, o, ins, conf in iter_all(img, CODE_SEGS):
        t = near_target(ins)
        if t is not None and j == i and t == off:
            print(fmt(j, o, ins, conf))
        ft = far_target(ins)
        if ft and ft[0] == seg and ft[1] == off:
            print(fmt(j, o, ins, conf))


def cmd_bytes(img, a):
    toks = a.pattern.split()
    rx = b"".join(b"." if t == "??" else re.escape(bytes([int(t, 16)])) for t in toks)
    for m in re.finditer(rx, img.data, re.S):
        lin = m.start()
        i = seg_index_of_linear(lin)
        print(f"{lin:06X} {SEGS[i]:04X}:{lin - SEGS[i]*16:04X}")


def cmd_words(img, a):
    i, seg, off, lin = parse_addr(a.addr)
    n = int(a.len[1:], 16) if a.len else 0x20
    d = img.data[lin:lin + n]
    for k in range(0, len(d), 16):
        row = d[k:k + 16]
        ws = " ".join(f"{row[j] | (row[j+1] << 8):04X}" for j in range(0, len(row) - 1, 2))
        print(f"{seg:04X}:{off + k:04X}  {ws}")


def cmd_listing(img, a):
    os.makedirs(a.out, exist_ok=True)
    for i in CODE_SEGS:
        path = os.path.join(a.out, f"seg{i:02d}_{SEGS[i]:04X}.lst")
        with open(path, "w") as f:
            for off, (ins, conf) in sorted_code(img, i):
                f.write(fmt(i, off, ins, conf) + "\n")
        print(path)


def main():
    if hasattr(signal, "SIGPIPE"):
        signal.signal(signal.SIGPIPE, signal.SIG_DFL)  # quiet when piped into head
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--image", default=DEFAULT_IMAGE)
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("segs")
    s = sub.add_parser("dis"); s.add_argument("addr"); s.add_argument("end", nargs="?")
    s.add_argument("--flow", action="store_true", help="use descent-confirmed instruction starts")
    s = sub.add_parser("fn"); s.add_argument("addr"); s.add_argument("--max", type=int, default=300)
    s = sub.add_parser("listing"); s.add_argument("--out", default=os.path.join(HERE, "..", "out", "research-phase1", "static", "listing"))
    s = sub.add_parser("xref")
    s.add_argument("--disp", type=lambda v: int(v, 0)); s.add_argument("--imm", type=lambda v: int(v, 0))
    s.add_argument("--re"); s.add_argument("--base"); s.add_argument("--nobase", action="store_true")
    s.add_argument("--write", action="store_true"); s.add_argument("--read", action="store_true")
    s.add_argument("--seg"); s.add_argument("-C", type=int, default=0)
    s.add_argument("--confirmed", action="store_true", help="only descent-confirmed code")
    s = sub.add_parser("calls"); s.add_argument("addr")
    s = sub.add_parser("bytes"); s.add_argument("pattern")
    s = sub.add_parser("words"); s.add_argument("addr"); s.add_argument("len", nargs="?")
    a = p.parse_args()
    img = Image(a.image)
    {"segs": cmd_segs, "dis": cmd_dis, "fn": cmd_fn, "listing": cmd_listing, "xref": cmd_xref,
     "calls": cmd_calls, "bytes": cmd_bytes, "words": cmd_words}[a.cmd](img, a)


if __name__ == "__main__":
    main()
