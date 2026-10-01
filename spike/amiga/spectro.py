#!/usr/bin/env python3
"""Spectrogram PNG of a WAV (log frequency 50 Hz - 11 kHz): spectro.py in.wav out.png [start_s] [len_s]"""
import sys, wave, zlib, struct
import numpy as np
w = wave.open(sys.argv[1]); sr = w.getframerate(); nch = w.getnchannels()
x = np.frombuffer(w.readframes(w.getnframes()), '<i2').astype(float).reshape(-1, nch).mean(axis=1) / 32768
s0 = float(sys.argv[3]) if len(sys.argv) > 3 else 0; ln = float(sys.argv[4]) if len(sys.argv) > 4 else 30
x = x[int(s0 * sr):int((s0 + ln) * sr)]
N, hop = 4096, int(sr / 50)
win = np.hanning(N)
frames = [np.abs(np.fft.rfft(x[i:i + N] * win)) for i in range(0, len(x) - N, hop)]
S = 20 * np.log10(np.array(frames).T + 1e-9)
H = 300
fq = np.geomspace(50, 11000, H)
bins = np.clip((fq / sr * N).astype(int), 0, S.shape[0] - 1)
img = S[bins][::-1]
img = np.clip((img - (img.max() - 70)) / 70, 0, 1)
W = img.shape[1]
rgb = np.stack([img ** 0.7, img ** 1.5, img ** 3 * 0.6 + 0.1 * (1 - img)], axis=2)
px = (rgb * 255).astype(np.uint8)
raw = b''.join(b'\x00' + px[y].tobytes() for y in range(H))
def chunk(t, d): return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
png = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', W, H, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b'')
open(sys.argv[2], 'wb').write(png)
print('rms %.3f, peak %.3f, %d x %d' % (np.sqrt(np.mean(x ** 2)), np.max(np.abs(x)), W, H))
