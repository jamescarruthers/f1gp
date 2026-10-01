// Sound for pages that run the emulator in direct mode (render.html, map.html):
// js-dos pushes mono float samples (ci.events().onSoundPush) at
// ci.soundFrequency(); an AudioWorklet queues them and resamples to the
// output rate. It keeps 2,048 to 8,192 samples queued (drops the oldest above
// that) and resumes the AudioContext on the first key or click, as browsers
// require. From raw.html (audio=own).
//
//   const audio = await makeOwnAudio();
//   ci.events().onSoundPush((s) => audio.push(s, ci.soundFrequency()));

const OWN_WORKLET = `
class RawPlayer extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(65536); this.r = 0; this.w = 0; this.n = 0;
    this.step = 1; this.pos = 0; this.started = false; this.underruns = 0; this.dropped = 0;
    this.port.onmessage = (e) => {
      const d = e.data;
      if (d.type === "rate") { this.step = d.source / sampleRate; return; }
      const s = d;
      for (let i = 0; i < s.length; i++) {
        if (this.n === this.buf.length) { this.r = (this.r + 1) & 65535; this.n--; }
        this.buf[this.w] = s[i]; this.w = (this.w + 1) & 65535; this.n++;
      }
      if (this.n > 8192) { const drop = this.n - 2048; this.r = (this.r + drop) & 65535; this.n -= drop; this.dropped += drop; }
    };
  }
  process(inputs, outputs) {
    const out = outputs[0][0];
    if (!this.started && this.n < 2048) { out.fill(0); return true; }
    this.started = true;
    for (let i = 0; i < out.length; i++) {
      if (this.n < 2) { out[i] = 0; this.underruns++; this.started = this.n > 0; continue; }
      const a = this.buf[this.r], b = this.buf[(this.r + 1) & 65535];
      out[i] = a + (b - a) * this.pos;
      this.pos += this.step;
      while (this.pos >= 1) { this.pos -= 1; this.r = (this.r + 1) & 65535; this.n--; }
    }
    if ((currentFrame & 16383) < out.length) this.port.postMessage({ queued: this.n, underruns: this.underruns, dropped: this.dropped });
    return true;
  }
}
registerProcessor("raw-player", RawPlayer);
`;
export async function makeOwnAudio() {
  const ctx = new AudioContext({ latencyHint: "interactive" });
  const url = URL.createObjectURL(new Blob([OWN_WORKLET], { type: "text/javascript" }));
  await ctx.audioWorklet.addModule(url);
  URL.revokeObjectURL(url);
  const node = new AudioWorkletNode(ctx, "raw-player", { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1] });
  node.connect(ctx.destination);
  const state = { ctx, rate: 0, pushed: 0, queued: 0, underruns: 0, dropped: 0 };
  node.port.onmessage = (e) => Object.assign(state, e.data);
  const resume = () => { if (ctx.state === "suspended") ctx.resume().catch(() => {}); };
  document.addEventListener("pointerdown", resume, { capture: true });
  document.addEventListener("keydown", resume, { capture: true });
  state.push = (samples, rate) => {
    if (rate !== state.rate) { state.rate = rate; node.port.postMessage({ type: "rate", source: rate }); }
    state.pushed += samples.length;
    node.port.postMessage(samples);
  };
  return state;
}
