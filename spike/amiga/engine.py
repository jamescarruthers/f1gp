#!/usr/bin/env python3
"""Play the Amiga F1GP engine against a revs trace recorded from the DOS game.

The Amiga race program (f1gp, routine at 3CC38, run every VBlank) sets
channel 0's period each 1/50 s from the revs (clamped 500-15000):
  r = revs + random(0..127);  q = 7500000 / max(r, 300)
  if q >= 2815 (idle): q = 2815 + random(-64..63)
  period = max((q * 3840 * 4) >> 16, 128)
on a 21,160-byte looped sample (sound effect 8: 984F2h, volume 40).

  python3 engine.py mp/d2/f1gp frames.jsonl out.wav
"""
import sys, json, random, struct
sys.path.insert(0, __import__('os').path.dirname(__file__))
import numpy as np
from hunk import load
from paula import render

mem, bases, sizes = load(sys.argv[1])
rows = [json.loads(l) for l in open(sys.argv[2])]
RATE = 44100
total = rows[-1]['sample']
nframes = int(total / RATE * 50)
times = np.array([r['sample'] / RATE for r in rows])
revs = np.array([r['rpm'] if r['rpm'] is not None else 0 for r in rows])
LC, LEN, VOL = 0x984f2, 21160 // 2, 40
rnd = random.Random(1)
frames = []
for f in range(nframes):
    t = f / 50
    i = max(0, np.searchsorted(times, t, 'right') - 1)
    r = int(min(max(revs[i], 500), 15000)) + rnd.randrange(128)
    q = 7500000 // max(r, 300)
    if q >= 2815: q = 2815 + (rnd.randrange(256) - 128) // 2
    per = max((q * 3840 * 4) >> 16, 128)
    w = [(0xa6, per, 2)]
    if f == 0: w = [(0xa0, LC, 4), (0xa4, LEN, 2), (0xa8, VOL, 2), (0xa6, per, 2), (0x96, 0x8001, 2)]
    frames.append(w)
st, _ = render(frames, mem)
mono = st[:, 0]  # channel 0 is the left output; one speaker, as on a TV
import wave
pcm = np.clip(mono * 32767 * 2, -32768, 32767).astype('<i2')
with wave.open(sys.argv[3], 'wb') as w:
    w.setnchannels(1); w.setsampwidth(2); w.setframerate(RATE); w.writeframes(pcm.tobytes())
print('wrote', sys.argv[3], '%.1f s' % (len(mono) / RATE), 'revs %d-%d' % (revs[revs > 0].min(), revs.max()))
