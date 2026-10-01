#!/usr/bin/env python3
"""The Amiga race program's sound effects: list, measure and render them.

The race program (f1gp) keeps nine effects in a table at 9D79Ah, 16 bytes
each: sample address (long), length in bytes (long), period (word), volume
(word), channel (word). The player at 8084C writes them to Paula and starts
DMA; the audio interrupt stops channels 1-3 after one pass (the engine,
effect 8, loops on channel 0).

  python3 effects.py mp/d2/f1gp OUTDIR

Writes OUTDIR/amiga-fx<k>.wav (one pass through the A500 output filters,
centred) and prints a JSON list with each effect's fields and measurements:
duration, attack (time to the loudest 20 ms), decay (time from there to
-20 dB), spectral centroid and zero-crossing rate of the loudest 200 ms.
"""
import sys, os, json, math
sys.path.insert(0, os.path.dirname(__file__))
import numpy as np
from hunk import load
from paula import render, write_wav, CLOCK

TABLE, COUNT = 0x9D79A, 9

def effects(mem):
    u16 = lambda a: int.from_bytes(mem[a:a + 2], 'big')
    u32 = lambda a: int.from_bytes(mem[a:a + 4], 'big')
    out = []
    for k in range(COUNT):
        e = TABLE + 16 * k
        out.append(dict(k=k, sample=u32(e), bytes=u32(e + 4), period=u16(e + 8), volume=u16(e + 10), channel=u16(e + 12)))
    return out

def render_once(mem, fx, rate=44100):
    ch, per = fx['channel'], fx['period']
    dur = fx['bytes'] * per / CLOCK
    nf = math.ceil(dur * 50) + 1
    base = 0xA0 + 16 * ch
    frames = [[(base, fx['sample'], 4), (base + 4, fx['bytes'] // 2, 2), (base + 6, per, 2), (base + 8, fx['volume'], 2), (0x96, 0x8000 | (1 << ch), 2)]]
    frames += [[] for _ in range(nf)]
    st, _ = render(frames, mem, 'a500', rate=rate)
    mono = st.sum(axis=1)                     # one channel is silent: centre it
    n = int((dur + 0.03) * rate)
    mono = mono[:n]
    tail = min(len(mono), int(0.02 * rate))
    mono[-tail:] *= np.linspace(1, 0, tail)   # the pass ends: no repeat
    return mono, dur

def measure(x, rate=44100):
    win = int(0.02 * rate)
    nwin = max(1, len(x) // win)
    rms = np.array([np.sqrt(np.mean(x[i * win:(i + 1) * win] ** 2) + 1e-12) for i in range(nwin)])
    peak = int(np.argmax(rms))
    db = 20 * np.log10(rms / rms[peak])
    after = np.where(db[peak:] < -20)[0]
    decay = (after[0] * win / rate) if len(after) else (len(x) / rate - peak * win / rate)
    a, b = peak * win, min(len(x), peak * win + int(0.2 * rate))
    seg = x[a:b] * np.hanning(b - a)
    spec = np.abs(np.fft.rfft(seg)); freqs = np.fft.rfftfreq(len(seg), 1 / rate)
    centroid = float((spec * freqs).sum() / (spec.sum() + 1e-12))
    zcr = float(np.mean(np.abs(np.diff(np.sign(x[a:b])))) / 2 * rate)
    return dict(attack=round(peak * win / rate, 3), decay=round(float(decay), 3), centroid=round(centroid), zcr=round(zcr))

if __name__ == '__main__':
    mem, bases, sizes = load(sys.argv[1])
    os.makedirs(sys.argv[2], exist_ok=True)
    rows = []
    for fx in effects(mem):
        x, dur = render_once(mem, fx)
        write_wav(os.path.join(sys.argv[2], 'amiga-fx%d.wav' % fx['k']), np.stack([x, x], axis=1))
        rows.append(dict(fx, sample=hex(fx['sample']), rate=round(CLOCK / fx['period']), duration=round(dur, 3), **measure(x)))
    print(json.dumps(rows, indent=1))
