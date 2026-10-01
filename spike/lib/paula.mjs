// Paula, the Amiga's sound chip, for the page's Amiga sound: four channels of
// 8-bit samples played by DMA from the game's data, written through the
// chip's registers as the game's code writes them (as spike/amiga/paula.py
// does offline, in real time here).
//
// A channel plays one byte per AUDxPER colour clocks (3,546,895 Hz, PAL),
// times AUDxVOL (0-64). DMA on latches AUDxLC and AUDxLEN (in words) and
// starts at once; at the end of the buffer the channel reloads them, so a
// new loop written while a sample plays takes over when it ends. A channel
// marked one-shot stops there instead (the race program's audio interrupt
// turns its effect channels off after one pass). The stepped signal is
// averaged exactly over each sample at four times the output rate; then,
// for the A500, its fixed low-pass (one pole, about 4.9 kHz) and, while the
// power LED is lit, the 3.3 kHz "LED" filter (2-pole Butterworth); then a
// low-pass FIR down to the output rate (so samples played fast do not alias)
// and a 5 Hz DC block.
// Channels 0 and 3 are the left output, 1 and 2 the right; setPan() mixes
// them for headphones.

export const CLOCK = 3546895;
export const DMACON = 0x96;

export class Paula {
  /**
   * @param sampleRate output rate
   * @param mem { base, bytes }: the memory the channels read (addresses as loaded)
   */
  constructor(sampleRate, mem = { base: 0, bytes: new Uint8Array(0) }, over = 4) {
    this.rate = sampleRate;
    this.over = over;
    const inner = sampleRate * over;
    this.step = CLOCK / inner;      // colour clocks per inner sample
    this.mem = mem;
    this.ch = [0, 1, 2, 3].map(() => ({ lc: 0, len: 0, per: 124, vol: 0, on: false, ptr: 0, left: 0, clk: 0, byte: 0, oneShot: false }));
    this.led = true;            // power LED lit at boot: the LED filter is in
    this.filter = 'a500';       // 'a500' or 'off'
    this.gain = 1;
    this.setPan(1);
    // filter states, per side
    this.lp1 = [0, 0];
    this.bq = [[0, 0, 0, 0], [0, 0, 0, 0]];
    this.dc = [{ x: 0, y: 0 }, { x: 0, y: 0 }];
    this.a1 = Math.exp((-2 * Math.PI * 4900) / inner);
    this.biquad = butterworth(3275, inner);
    this.dcR = Math.exp((-2 * Math.PI * 5) / sampleRate);
    // the decimation filter: windowed sinc, cut at 0.45 of the output rate
    this.fir = lowpassFir(over * 16, 0.45 / over);
    this.hist = [new Float32Array(this.fir.length * 2), new Float32Array(this.fir.length * 2)];
    this.hpos = 0;
    this.idle = true;
  }

  /** separation 1: as the Amiga (0 and 3 left, 1 and 2 right); 0: mono. centre: channels to put in the middle. */
  setPan(separation, centre = []) {
    const s = Math.max(0, Math.min(1, separation));
    this.pan = [0, 1, 2, 3].map((k) => {
      if (centre.includes(k)) return [0.5, 0.5];
      const left = k === 0 || k === 3;
      const near = (1 + s) / 2, far = (1 - s) / 2;
      return left ? [near, far] : [far, near];
    });
  }

  setMemory(mem) { this.mem = mem; }

  read(addr) {
    const i = addr - this.mem.base;
    const b = this.mem.bytes;
    if (i < 0 || i >= b.length) return 0;
    const v = b[i];
    return v >= 128 ? v - 256 : v;
  }

  /** A register write: AUDxLC/LEN/PER/VOL (A0h-DFh, LC as a long) or DMACON (96h). */
  write(reg, value, size = 2) {
    if (reg === DMACON) {
      for (let k = 0; k < 4; k++) {
        if (!(value & (1 << k))) continue;
        const c = this.ch[k];
        if (value & 0x8000) { if (!c.on) this.startDma(c); }
        else if (c.on) { c.on = false; c.byte = 0; }
      }
      return;
    }
    if (reg < 0xa0 || reg >= 0xe0) return;
    const c = this.ch[(reg - 0xa0) >> 4], r = (reg - 0xa0) & 15;
    if (r === 0 && size === 4) c.lc = value >>> 0;
    else if (r === 0) c.lc = ((value & 0xffff) << 16 | (c.lc & 0xffff)) >>> 0;
    else if (r === 2) c.lc = ((c.lc & 0xffff0000) | (value & 0xffff)) >>> 0;
    else if (r === 4) c.len = value & 0xffff;
    else if (r === 6) c.per = value & 0xffff;
    else if (r === 8) c.vol = Math.min(value & 0x7f, 64);
  }

  /** Mark a channel to stop at the end of its buffer instead of reloading. */
  setOneShot(k, on) { this.ch[k].oneShot = on; }

  /** All four channels off (DMACON 000Fh). */
  allOff() { this.write(DMACON, 0x000f); }

  startDma(c) {
    c.on = true;
    c.ptr = c.lc & 0x1ffffe;
    c.left = (c.len || 0x10000) * 2;
    c.clk = 0;
    this.nextByte(c);
  }

  // the next byte of the buffer, reloading (or stopping) at its end
  nextByte(c) {
    if (c.left === 0) {
      if (c.oneShot) { c.on = false; c.byte = 0; return; }
      c.ptr = c.lc & 0x1ffffe;
      c.left = (c.len || 0x10000) * 2;
    }
    c.byte = this.read(c.ptr);
    c.ptr++; c.left--;
    c.clk += Math.max(c.per, 124);
  }

  /** Mix n samples into left and right (Float32Arrays), adding to what is there. */
  render(left, right, n, offset = 0) {
    // silent and settled: nothing to add
    if (!this.ch.some((c) => c.on)) { if (this.idle) return; } else this.idle = false;
    let peak = 0;
    const step = this.step, ch = this.ch, pan = this.pan, over = this.over;
    const norm = 0.5 * this.gain / (128 * 64);
    const filt = this.filter === 'a500', led = this.led;
    const fir = this.fir, N = fir.length, hl = this.hist[0], hr = this.hist[1];
    for (let i = 0; i < n; i++) {
      for (let o = 0; o < over; o++) {
        let l = 0, r = 0;
        for (let k = 0; k < 4; k++) {
          const c = ch[k];
          if (!c.on) continue;
          // the exact area under the stepped signal over this inner sample
          let rest = step, acc = 0;
          while (rest > 0 && c.on) {
            const take = Math.min(rest, c.clk);
            acc += c.byte * take;
            rest -= take; c.clk -= take;
            if (c.clk <= 0) this.nextByte(c);
          }
          const v = (acc / step) * c.vol;
          l += v * pan[k][0]; r += v * pan[k][1];
        }
        l *= norm; r *= norm;
        if (filt) { l = this.filterSide(0, l, led); r = this.filterSide(1, r, led); }
        // a history twice the filter's length, so the newest N are always in one run
        const p = this.hpos;
        hl[p] = hl[p + N] = l; hr[p] = hr[p + N] = r;
        this.hpos = (p + 1) % N;
      }
      let l = 0, r = 0;
      const start = this.hpos; // the oldest of the newest N
      for (let j = 0; j < N; j++) { l += fir[j] * hl[start + j]; r += fir[j] * hr[start + j]; }
      l = this.dcBlock(0, l); r = this.dcBlock(1, r);
      left[offset + i] += l; right[offset + i] += r;
      peak = Math.max(peak, Math.abs(l), Math.abs(r));
    }
    if (!this.ch.some((c) => c.on) && peak < 1e-6) this.idle = true;
  }

  filterSide(s, x, led) {
    const a = this.a1;
    let y = this.lp1[s] = x + a * (this.lp1[s] - x);
    if (led) {
      const q = this.bq[s], f = this.biquad;
      const out = f.b0 * y + f.b1 * q[0] + f.b2 * q[1] - f.a1 * q[2] - f.a2 * q[3];
      q[1] = q[0]; q[0] = y; q[3] = q[2]; q[2] = out;
      y = out;
    }
    return y;
  }

  dcBlock(s, x) {
    const d = this.dc[s];
    const y = x - d.x + this.dcR * d.y;
    d.x = x; d.y = y;
    return y;
  }
}

// a windowed-sinc (Blackman) low-pass FIR of n taps, cut at fc (of the sample rate), unity gain
function lowpassFir(n, fc) {
  const h = new Float32Array(n), m = (n - 1) / 2;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const x = i - m, sinc = x === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * x) / (Math.PI * x);
    const w = 0.42 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)) + 0.08 * Math.cos((4 * Math.PI * i) / (n - 1));
    h[i] = sinc * w; sum += h[i];
  }
  for (let i = 0; i < n; i++) h[i] /= sum;
  return h;
}

// 2-pole Butterworth low-pass (bilinear transform), as scipy's butter(2, fc)
function butterworth(fc, fs) {
  const w = Math.tan((Math.PI * fc) / fs), w2 = w * w, r2 = Math.SQRT2 * w;
  const a0 = 1 + r2 + w2;
  return { b0: w2 / a0, b1: (2 * w2) / a0, b2: w2 / a0, a1: (2 * (w2 - 1)) / a0, a2: (1 - r2 + w2) / a0 };
}
