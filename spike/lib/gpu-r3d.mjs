// The game's 3D view painted by WebGPU compute, from the primitives our Rust port of the game's
// renderer makes of its display list (machine/src/r3d/fine.rs, `words`): spans of fine pixels,
// runs of game pixels drawn s x s, and the ground texture's texels. The port decides what is
// drawn and in what order, as the game does at 320 x 200; this paints it at any scale.
//
// Painter's order on a parallel GPU: each pixel keeps the highest (primitive number << 8 |
// colour) written to it (atomicMax), so the last primitive over a pixel wins, as when the
// primitives are painted one after another. The texels read the colour already there (road
// 1Ah, grass 12h), so a run of texels is applied in a pass of its own between the primitives
// before it and after it.
//
// gpuRaster().paint gives the 3D view's palette indices, w x h bytes, as fine.rs's `draw` gives
// them (probes/p9-gpu-r3d.mjs). gpuView(canvas).show puts a frame the game showed on a canvas
// (render.html r3d=gpu): the 3D view painted at its scale, laid into the game's screen where
// the frame's mask says the screen shows it (machine/src/r3d/shown.rs), the rest the game's
// screen, its pixels made s x s; then the game's palette.

const WGSL = /* wgsl */ `
struct P { w: u32, h: u32, s: u32, first: u32, count: u32, init: u32 }
@group(0) @binding(0) var<uniform> p: P;
@group(0) @binding(1) var<storage, read> prims: array<vec4u>;
@group(0) @binding(2) var<storage, read_write> px: array<atomic<u32>>;
@group(0) @binding(3) var<storage, read> init: array<u32>;
@group(0) @binding(4) var<storage, read_write> out: array<u32>;

fn index(g: vec3u, n: vec3u) -> u32 { return g.x + g.y * n.x * 64u; }

// every pixel to the frame it starts from (number 0, so that any primitive is over it)
@compute @workgroup_size(64)
fn clear(@builtin(global_invocation_id) g: vec3u, @builtin(num_workgroups) n: vec3u) {
  let i = index(g, n);
  if (i >= p.w * p.h) { return; }
  var c = 0u;
  if (p.init != 0u) { c = (init[i >> 2u] >> ((i & 3u) * 8u)) & 0xffu; }
  atomicStore(&px[i], c);
}

// spans and runs: primitive k paints with the number k + 1
@compute @workgroup_size(64)
fn paint(@builtin(global_invocation_id) g: vec3u, @builtin(num_workgroups) n: vec3u) {
  let i = index(g, n);
  if (i >= p.count) { return; }
  let k = p.first + i;
  let q = prims[k];
  let kind = q.x >> 8u;
  let v = ((k + 1u) << 8u) | (q.x & 0xffu);
  if (kind == 0u) {
    let row = q.y * p.w;
    for (var x = q.z; x < q.w; x++) { atomicMax(&px[row + x], v); }
  } else if (kind == 1u) {
    for (var y = q.y * p.s; y < (q.y + 1u) * p.s; y++) {
      let row = y * p.w;
      for (var x = q.z * p.s; x < q.w * p.s; x++) { atomicMax(&px[row + x], v); }
    }
  }
}

// texels: the shade added to the road and grass within a game pixel
@compute @workgroup_size(64)
fn texture(@builtin(global_invocation_id) g: vec3u, @builtin(num_workgroups) n: vec3u) {
  let i = index(g, n);
  if (i >= p.count) { return; }
  let q = prims[p.first + i];
  let d = q.x & 0xffu;
  for (var y = q.y * p.s; y < (q.y + 1u) * p.s; y++) {
    for (var x = q.z * p.s; x < (q.z + 1u) * p.s; x++) {
      let a = y * p.w + x;
      let v = atomicLoad(&px[a]);
      let c = v & 0xffu;
      if (c == 0x12u || c == 0x1au) { atomicStore(&px[a], (v & 0xffffff00u) | ((c + d) & 0xffu)); }
    }
  }
}

// the colours, four pixels a word
@compute @workgroup_size(64)
fn resolve(@builtin(global_invocation_id) g: vec3u, @builtin(num_workgroups) n: vec3u) {
  let i = index(g, n);
  if (i >= p.w * p.h / 4u) { return; }
  var w = 0u;
  for (var j = 0u; j < 4u; j++) { w |= (atomicLoad(&px[4u * i + j]) & 0xffu) << (8u * j); }
  out[i] = w;
}
`;

const KIND_TEXEL = 2;

/** A WebGPU rasteriser for the port's primitives. Rejects if WebGPU is not there. */
export async function gpuRaster({ device } = {}) {
  if (!device) {
    if (!navigator.gpu) throw new Error('no WebGPU here');
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error('no WebGPU adapter');
    device = await adapter.requestDevice();
  }
  const module = device.createShaderModule({ code: WGSL });
  const storage = (type) => ({ buffer: { type } });
  const layout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, ...storage('read-only-storage') },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, ...storage('storage') },
      { binding: 3, visibility: GPUShaderStage.COMPUTE, ...storage('read-only-storage') },
      { binding: 4, visibility: GPUShaderStage.COMPUTE, ...storage('storage') },
    ],
  });
  const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout] });
  const pipe = (entryPoint) => device.createComputePipeline({ layout: pipelineLayout, compute: { module, entryPoint } });
  const pipes = { clear: pipe('clear'), paint: pipe('paint'), texture: pipe('texture'), resolve: pipe('resolve') };
  const U = GPUBufferUsage;
  const buffer = (size, usage) => device.createBuffer({ size: Math.max(16, Math.ceil(size / 16) * 16), usage });

  /** Workgroups for n invocations, in two dimensions past 65,535. */
  const groups = (n) => {
    const g = Math.max(1, Math.ceil(n / 64));
    return g <= 65535 ? [g, 1] : [65535, Math.ceil(g / 65535)];
  };

  /** The passes that paint `prims` (n of them, in primBuf) into px at scale s, w x h. */
  function paintPasses({ prims, n, s, w, h, primBuf, px, initBuf, outBuf, hasInit, uniforms }) {
    const passes = [];
    let u = 0;
    const pass = (name, first, count) => {
      if (!uniforms[u]) uniforms[u] = buffer(24, U.UNIFORM | U.COPY_DST);
      const ub = uniforms[u++];
      device.queue.writeBuffer(ub, 0, new Uint32Array([w, h, s, first, count, hasInit ? 1 : 0]));
      const bind = device.createBindGroup({
        layout,
        entries: [ub, primBuf, px, initBuf, outBuf].map((buffer, binding) => ({ binding, resource: { buffer } })),
      });
      passes.push({ pipe: pipes[name], bind, n: name === 'clear' ? w * h : name === 'resolve' ? w * h / 4 : count });
    };
    pass('clear', 0, 0);
    // runs of primitives: texels on their own, in order
    for (let k = 0; k < n;) {
      const texel = prims[4 * k] >> 8 === KIND_TEXEL;
      let j = k + 1;
      while (j < n && (prims[4 * j] >> 8 === KIND_TEXEL) === texel) j++;
      pass(texel ? 'texture' : 'paint', k, j - k);
      k = j;
    }
    return { passes, resolve: () => pass('resolve', 0, 0) };
  }
  function encode(enc, passes) {
    for (const p of passes) {
      const c = enc.beginComputePass();
      c.setPipeline(p.pipe);
      c.setBindGroup(0, p.bind);
      c.dispatchWorkgroups(...groups(p.n));
      c.end();
    }
  }

  /**
   * Paint the primitives (four words each) at scale s over `init` (w x h bytes, or none): the
   * frame's palette indices, w = 320 s by h = 164 s.
   */
  async function paint({ prims, s, init = null }) {
    const w = 320 * s, h = 164 * s, n = prims.length / 4;
    if (n >= 1 << 24) throw new Error(`${n} primitives: too many to number`);
    const primBuf = buffer(prims.byteLength, U.STORAGE | U.COPY_DST);
    device.queue.writeBuffer(primBuf, 0, prims);
    const px = buffer(w * h * 4, U.STORAGE);
    const initBuf = buffer(init ? init.byteLength : 4, U.STORAGE | U.COPY_DST);
    if (init) device.queue.writeBuffer(initBuf, 0, init);
    const outBuf = buffer(w * h, U.STORAGE | U.COPY_SRC);
    const read = buffer(w * h, U.MAP_READ | U.COPY_DST);
    const uniforms = [];
    const { passes, resolve } = paintPasses({ prims, n, s, w, h, primBuf, px, initBuf, outBuf, hasInit: !!init, uniforms });
    resolve();
    const enc = device.createCommandEncoder();
    encode(enc, passes);
    enc.copyBufferToBuffer(outBuf, 0, read, 0, w * h);
    device.queue.submit([enc.finish()]);
    await read.mapAsync(GPUMapMode.READ);
    const frame = new Uint8Array(read.getMappedRange()).slice(0, w * h);
    read.unmap();
    for (const b of [primBuf, px, initBuf, outBuf, read, ...uniforms]) b.destroy();
    return frame;
  }

  return { device, paint, buffer, paintPasses, encode, groups };
}

// The frame laid together: each output pixel (320 s x 200 s) from the painted 3D view where the
// game's screen shows it, else the screen's own pixel; four indices a word.
const COMPOSE = /* wgsl */ `
struct C { s: u32, top: u32, w: u32, h: u32 }
@group(0) @binding(0) var<uniform> c: C;
@group(0) @binding(1) var<storage, read> px: array<u32>;
@group(0) @binding(2) var<storage, read> screen: array<u32>;
@group(0) @binding(3) var<storage, read> mask: array<u32>;
@group(0) @binding(4) var<storage, read_write> out: array<u32>;

fn screenAt(i: u32) -> u32 { return (screen[i >> 2u] >> ((i & 3u) * 8u)) & 0xffu; }
fn maskAt(i: u32) -> u32 { return (mask[i >> 2u] >> ((i & 3u) * 8u)) & 0xffu; }

@compute @workgroup_size(64)
fn compose(@builtin(global_invocation_id) g: vec3u, @builtin(num_workgroups) n: vec3u) {
  let k = g.x + g.y * n.x * 64u;
  if (k >= c.w * c.h / 4u) { return; }
  var word = 0u;
  for (var j = 0u; j < 4u; j++) {
    let i = 4u * k + j;
    let x = i % c.w;
    let y = i / c.w;
    let gi = (y / c.s) * 320u + x / c.s;
    var v = screenAt(gi);
    if (maskAt(gi) != 0u) { v = px[(y - c.top * c.s) * c.w + x] & 0xffu; }
    word |= v << (8u * j);
  }
  out[k] = word;
}
`;

// The laid-together frame on the canvas, in the game's palette (6-bit DAC values).
const PRESENT = /* wgsl */ `
struct C { s: u32, top: u32, w: u32, h: u32 }
@group(0) @binding(0) var<uniform> c: C;
@group(0) @binding(1) var<storage, read> frame: array<u32>;
@group(0) @binding(2) var<storage, read> dac: array<u32>;

@vertex
fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  return vec4f(p * 2.0 - 1.0, 0.0, 1.0);
}

@fragment
fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let p = vec2u(pos.xy);
  let i = p.y * c.w + p.x;
  let v = (frame[i >> 2u] >> ((i & 3u) * 8u)) & 0xffu;
  let rgb = dac[v];
  let f = vec3f(f32(rgb & 63u), f32((rgb >> 8u) & 63u), f32((rgb >> 16u) & 63u)) / 63.0;
  return vec4f(f, 1.0);
}
`;

/**
 * A frame the game showed, on `canvas` (WebGPU): its 3D view painted at the frame's scale and
 * laid into its screen, in its palette. Rejects if WebGPU is not there.
 */
export async function gpuView(canvas, { device } = {}) {
  const r = await gpuRaster({ device });
  device = r.device;
  const U = GPUBufferUsage, S = GPUShaderStage;
  const ctx = canvas.getContext('webgpu');
  if (!ctx) throw new Error('no WebGPU canvas');
  const format = navigator.gpu.getPreferredCanvasFormat();
  ctx.configure({ device, format, alphaMode: 'opaque' });
  const layout = (entries) => device.createBindGroupLayout({ entries });
  const ro = { type: 'read-only-storage' };
  const cLayout = layout([
    { binding: 0, visibility: S.COMPUTE, buffer: { type: 'uniform' } },
    { binding: 1, visibility: S.COMPUTE, buffer: ro },
    { binding: 2, visibility: S.COMPUTE, buffer: ro },
    { binding: 3, visibility: S.COMPUTE, buffer: ro },
    { binding: 4, visibility: S.COMPUTE, buffer: { type: 'storage' } },
  ]);
  const pLayout = layout([
    { binding: 0, visibility: S.FRAGMENT, buffer: { type: 'uniform' } },
    { binding: 1, visibility: S.FRAGMENT, buffer: ro },
    { binding: 2, visibility: S.FRAGMENT, buffer: ro },
  ]);
  const composePipe = device.createComputePipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [cLayout] }),
    compute: { module: device.createShaderModule({ code: COMPOSE }), entryPoint: 'compose' },
  });
  const presentModule = device.createShaderModule({ code: PRESENT });
  const presentPipe = device.createRenderPipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [pLayout] }),
    vertex: { module: presentModule, entryPoint: 'vs' },
    fragment: { module: presentModule, entryPoint: 'fs', targets: [{ format }] },
    primitive: { topology: 'triangle-list' },
  });
  // buffers kept from frame to frame, made again when the scale changes or the primitives outgrow theirs
  const b = { s: 0, primBytes: 0, uniforms: [] };
  const fixed = {
    screen: r.buffer(320 * 200, U.STORAGE | U.COPY_DST),
    mask: r.buffer(320 * 200, U.STORAGE | U.COPY_DST),
    dac: r.buffer(256 * 4, U.STORAGE | U.COPY_DST),
    c: r.buffer(16, U.UNIFORM | U.COPY_DST),
    // the painter's start frame and its output, unused here (two: one buffer may not be both)
    noInit: r.buffer(16, U.STORAGE),
    noOut: r.buffer(16, U.STORAGE),
  };
  const dac32 = new Uint32Array(256);
  let checking = false;
  const errors = [];
  device.addEventListener('uncapturederror', (e) => { if (errors.length < 5) errors.push(String(e.error?.message ?? e.error)); });

  function sized(s, primBytes) {
    if (b.s !== s) {
      for (const k of ['px', 'out', 'read']) b[k]?.destroy();
      const w = 320 * s;
      b.px = r.buffer(w * 164 * s * 4, U.STORAGE);
      b.out = r.buffer(w * 200 * s, U.STORAGE | U.COPY_SRC);
      b.read = r.buffer(w * 200 * s, U.MAP_READ | U.COPY_DST);
      b.s = s;
      canvas.width = w;
      canvas.height = 200 * s;
    }
    if (b.primBytes < primBytes) {
      b.prims?.destroy();
      b.primBytes = Math.max(primBytes, 2 * b.primBytes, 1 << 16);
      b.prims = r.buffer(b.primBytes, U.STORAGE | U.COPY_DST);
    }
  }

  /**
   * Show a frame (lib/pc.mjs r3dShown(): { scale, top, words, screen, mask, dac }); with
   * `check`, a promise of the laid-together frame's indices (320 s x 200 s) as well.
   */
  function show(f, { check = false } = {}) {
    const s = f.scale, w = 320 * s, n = f.words.length / 4;
    if (n >= 1 << 24) throw new Error(`${n} primitives: too many to number`);
    sized(s, Math.max(16, f.words.byteLength));
    device.queue.writeBuffer(b.prims, 0, f.words);
    device.queue.writeBuffer(fixed.screen, 0, f.screen);
    device.queue.writeBuffer(fixed.mask, 0, f.mask);
    for (let i = 0; i < 256; i++) dac32[i] = f.dac[3 * i] | (f.dac[3 * i + 1] << 8) | (f.dac[3 * i + 2] << 16);
    device.queue.writeBuffer(fixed.dac, 0, dac32);
    device.queue.writeBuffer(fixed.c, 0, new Uint32Array([s, f.top, w, 200 * s]));
    const { passes } = r.paintPasses({ prims: f.words, n, s, w, h: 164 * s, primBuf: b.prims, px: b.px, initBuf: fixed.noInit, outBuf: fixed.noOut, hasInit: false, uniforms: b.uniforms });
    const enc = device.createCommandEncoder();
    r.encode(enc, passes);
    const cp = enc.beginComputePass();
    cp.setPipeline(composePipe);
    cp.setBindGroup(0, device.createBindGroup({ layout: cLayout, entries: [fixed.c, b.px, fixed.screen, fixed.mask, b.out].map((buffer, binding) => ({ binding, resource: { buffer } })) }));
    cp.dispatchWorkgroups(...r.groups(w * 200 * s / 4));
    cp.end();
    const rp = enc.beginRenderPass({ colorAttachments: [{ view: ctx.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }] });
    rp.setPipeline(presentPipe);
    rp.setBindGroup(0, device.createBindGroup({ layout: pLayout, entries: [fixed.c, b.out, fixed.dac].map((buffer, binding) => ({ binding, resource: { buffer } })) }));
    rp.draw(3);
    rp.end();
    const read = check && !checking;
    if (read) enc.copyBufferToBuffer(b.out, 0, b.read, 0, w * 200 * s);
    device.queue.submit([enc.finish()]);
    if (!read) return null;
    checking = true;
    const buf = b.read;
    return buf.mapAsync(GPUMapMode.READ).then(() => {
      const frame = new Uint8Array(buf.getMappedRange()).slice(0, w * 200 * s);
      buf.unmap();
      return frame;
    }).finally(() => { checking = false; });
  }

  return { device, show, errors };
}
