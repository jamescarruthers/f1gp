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
// The result is the frame's palette indices, w x h bytes, as fine.rs's `draw` gives them.

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
    const passes = [];
    const pass = (name, first, count) => {
      const u = buffer(24, U.UNIFORM | U.COPY_DST);
      device.queue.writeBuffer(u, 0, new Uint32Array([w, h, s, first, count, init ? 1 : 0]));
      const bind = device.createBindGroup({
        layout,
        entries: [u, primBuf, px, initBuf, outBuf].map((buffer, binding) => ({ binding, resource: { buffer } })),
      });
      passes.push({ pipe: pipes[name], bind, n: name === 'clear' ? w * h : name === 'resolve' ? w * h / 4 : count, u });
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
    pass('resolve', 0, 0);
    const enc = device.createCommandEncoder();
    for (const p of passes) {
      const c = enc.beginComputePass();
      c.setPipeline(p.pipe);
      c.setBindGroup(0, p.bind);
      c.dispatchWorkgroups(...groups(p.n));
      c.end();
    }
    enc.copyBufferToBuffer(outBuf, 0, read, 0, w * h);
    device.queue.submit([enc.finish()]);
    await read.mapAsync(GPUMapMode.READ);
    const frame = new Uint8Array(read.getMappedRange()).slice(0, w * h);
    read.unmap();
    for (const b of [primBuf, px, initBuf, outBuf, read, ...passes.map((p) => p.u)]) b.destroy();
    return frame;
  }

  return { device, paint };
}
