#!/usr/bin/env python3
"""Paula (Amiga sound chip) renderer for a log of custom-chip register writes.

Input: frames of writes [(reg, value, size)], one frame per 1/50 s (PAL VBlank),
applied in order at the start of each frame. Output: 44.1 kHz stereo.

Each channel: DMA on latches AUDxLC/AUDxLEN and plays bytes (signed 8-bit) at
one byte per AUDxPER colour clocks (3,546,895 Hz PAL); at the end of the
buffer it reloads from the registers (which may hold a new loop by then).
Output = byte * AUDxVOL (0-64). Channels 0 and 3 left, 1 and 2 right.
The stepped signal is integrated exactly (box filter) at 4x 44.1 kHz, then
the A500 output filters are applied: a fixed one-pole RC low-pass (about
4.9 kHz) and, while the power LED is lit, the 2-pole Butterworth "LED
filter" (about 3.3 kHz); then a 5 Hz DC block and decimation to 44.1 kHz.
"""
import numpy as np
CLOCK = 3546895.0
FRAME = CLOCK / 50.0

class Channel:
    def __init__(self):
        self.lc = 0; self.len = 0; self.per = 0; self.vol = 0
        self.on = False; self.ptr = 0; self.left = 0; self.t = 0.0  # time of next byte
        self.byte = 0
        self.times = [0.0]; self.vals = [0.0]

def render(frames, chipmem, filters='a500', led_states=None, rate=44100, over=4):
    ch = [Channel() for _ in range(4)]
    led = True  # LED lit (filter on) at boot
    led_log = []  # (time, on)
    def emit(c, t, v):
        if c.vals[-1] != v or c.times[-1] == t:
            c.times.append(t); c.vals.append(v)
    def start(c, t):
        c.on = True; c.ptr = c.lc & 0x1ffffe; c.left = (c.len or 0x10000) * 2; c.t = t
    def run(c, t_end):
        # play bytes up to t_end
        per = max(c.per, 124)
        while c.on and c.t < t_end:
            if c.left == 0:
                c.ptr = c.lc & 0x1ffffe; c.left = (c.len or 0x10000) * 2
            b = chipmem[c.ptr] if c.ptr < len(chipmem) else 0
            c.byte = b - 256 if b >= 128 else b
            emit(c, c.t, c.byte * c.vol)
            c.ptr += 1; c.left -= 1; c.t += per
    for f, writes in enumerate(frames):
        t0 = f * FRAME
        for c in ch: run(c, t0)
        for reg, val, size in writes:
            if reg == 'led': led = val; led_log.append((t0, val)); continue
            if 0xa0 <= reg < 0xe0:
                k = (reg - 0xa0) >> 4; r = (reg - 0xa0) & 15; c = ch[k]
                if r == 0 and size == 4: c.lc = val
                elif r == 0: c.lc = (c.lc & 0xffff) | (val << 16)
                elif r == 2: c.lc = (c.lc & 0xffff0000) | val
                elif r == 4: c.len = val
                elif r == 6: c.per = val
                elif r == 8:
                    c.vol = min(val & 0x7f, 64)
                    if c.on: emit(c, t0, c.byte * c.vol)
            elif reg == 0x96:
                bits = val & 0xf
                for k in range(4):
                    if not bits & (1 << k): continue
                    c = ch[k]
                    if val & 0x8000:
                        if not c.on: start(c, t0)
                    elif c.on:
                        c.on = False; c.byte = 0; emit(c, t0, 0.0)
    t_end = len(frames) * FRAME
    for c in ch: run(c, t_end)
    # exact box integration at rate*over
    R = rate * over
    n = int(t_end / CLOCK * R)
    tq = np.arange(n + 1) * (CLOCK / R)
    out = []
    for c in ch:
        t = np.array(c.times + [t_end + 1]); v = np.array(c.vals + [c.vals[-1]])
        I = np.concatenate([[0.0], np.cumsum(v[:-1] * np.diff(t))])
        Iq = np.interp(tq, t, I)
        out.append(np.diff(Iq) / (CLOCK / R) / (128 * 64))
    L = out[0] + out[3]; Rr = out[1] + out[2]
    st = np.stack([L, Rr], axis=1) * 0.5
    led_mask = np.ones(n, bool)
    if led_log:
        tt = np.arange(n) / R * CLOCK
        state = np.ones(n, bool); cur = True; last = 0
        for t, on in led_log + [(t_end, None)]:
            i = int(t / CLOCK * R); state[last:i] = cur; last = i
            if on is not None: cur = on
        led_mask = state
    if filters == 'a500':
        st = onepole(st, 4900.0, R)
        st = led_filter(st, 3275.0, R, led_mask)
    elif filters == 'a1200':
        st = onepole(st, 28000.0, R)
        st = led_filter(st, 3275.0, R, led_mask)
    st = dc_block(st, 5.0, R)
    st = decimate(st, over)
    return st, led_log

def onepole(x, fc, R):
    a = np.exp(-2 * np.pi * fc / R)
    y = np.empty_like(x); s = np.zeros(x.shape[1])
    from scipy.signal import lfilter
    return lfilter([1 - a], [1, -a], x, axis=0)

def led_filter(x, fc, R, mask):
    from scipy.signal import butter, lfilter
    b, a = butter(2, fc / (R / 2))
    y = lfilter(b, a, x, axis=0)
    return np.where(mask[:, None], y, x)

def dc_block(x, fc, R):
    from scipy.signal import butter, lfilter
    b, a = butter(1, fc / (R / 2), 'high')
    return lfilter(b, a, x, axis=0)

def decimate(x, over):
    from scipy.signal import firwin, lfilter
    h = firwin(127, 0.45 / over * 2)
    y = lfilter(h, 1, x, axis=0)
    return y[63::over]

def write_wav(path, st, rate=44100):
    import wave
    peak = np.max(np.abs(st)) or 1
    pcm = np.clip(st * 32767, -32768, 32767).astype('<i2')
    with wave.open(path, 'wb') as w:
        w.setnchannels(2); w.setsampwidth(2); w.setframerate(rate); w.writeframes(pcm.tobytes())
    return peak
