// Measure what the game's own 3D drawing costs: run a Quick Race, then
// replace the five calls to the scene renderer (lcall 0F47:81CE) with NOPs in
// emulated memory, and compare the game's frame work, frame rate and the
// host's CPU time before and after.
//
//   node build-bundle.mjs --autoexec "gp /g" --cycles N --out dist/p2-norender-N.jsdos
//   timeout 240 node probes/p2-norender.cjs dist/p2-norender-N.jsdos [8000,4000,2000,1000,500]
//
// After the patch it lowers the emulated CPU speed at run time
// (ci.sendBackendEvent wc-trigger-event "cycles:N") and measures again.
//
// Frame work = DS:2C63, the 300 Hz ticks the last frame's work took (the
// game's "Processor Occupancy" is this over the frame's ticks, SS:1230).

const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const { start, encodePng, sleep } = require('../lib/node-emu.cjs');
const route = require('../lib/route.cjs');

// image offsets of "lcall 0F47:81CE" (9A CE 81 47 0F before relocation)
const RENDER_CALLS = [0xeb7e, 0xeea4, 0xf007, 0xf0d3, 0xf291];

(async () => {
  const bundle = process.argv[2];
  const tag = path.basename(bundle, '.jsdos');
  const OUT = path.join(__dirname, '..', 'out', 'p2-norender');
  fs.mkdirSync(OUT, { recursive: true });
  const { attach } = await import(pathToFileURL(path.join(__dirname, '..', 'lib', 'f1gp-mem.mjs')).href);
  const emu = await start(bundle);
  const drv = route.nodeDriver(emu);
  await route.toTrack(drv, { mode: 'quickrace' });
  const mem = attach(emu.ci);
  mem.ds = mem.seg(mem.DS); mem.ss = mem.seg(mem.SS);
  const H = () => mem.heap();
  const lin = (off) => mem.memBase + mem.imageSeg * 16 + off;
  const relSeg = (0x0f47 + mem.imageSeg) & 0xffff;
  for (const off of RENDER_CALLS) {
    const p = lin(off), h = H();
    const ok = h[p] === 0x9a && h[p + 1] === 0xce && h[p + 2] === 0x81 && (h[p + 3] | (h[p + 4] << 8)) === relSeg;
    if (!ok) throw new Error(`no render call at image 0x${off.toString(16)}`);
  }
  await drv.keyDown('a');

  async function measure(seconds) {
    const t0 = Date.now(), cpu0 = process.cpuUsage();
    let lastTick = mem.ds.u32(0x2955), frames = 0, work = 0, tick0 = lastTick;
    while (Date.now() - t0 < seconds * 1000) {
      const tick = mem.ds.u32(0x2955);
      if (tick !== lastTick) { frames++; work += mem.ds.u16(0x2c63); lastTick = tick; }
      await sleep(3);
    }
    const wall = (Date.now() - t0) / 1000, cpu = process.cpuUsage(cpu0);
    const ticksPerFrame = mem.ss.u16(0x1230);
    return {
      gameFps: +(frames / wall).toFixed(2),
      gameSpeed: +((lastTick - tick0) / 1000 / wall).toFixed(3),
      workTicksPerFrame: +(work / Math.max(frames, 1)).toFixed(2),
      occupancyPct: +((100 * work) / Math.max(frames, 1) / ticksPerFrame).toFixed(1),
      hostCpuPct: +((100 * (cpu.user + cpu.system)) / 1e6 / wall).toFixed(1),
    };
  }

  const before = await measure(6);
  fs.writeFileSync(path.join(OUT, `${tag}-before.png`), encodePng(320, 200, (await emu.ci.screenshot()).data, 4));
  for (const off of RENDER_CALLS) H().fill(0x90, lin(off), lin(off) + 5);
  await sleep(500);
  const after = await measure(6);
  fs.writeFileSync(path.join(OUT, `${tag}-after.png`), encodePng(320, 200, (await emu.ci.screenshot()).data, 4));
  const st = { mph: route.readMph(await emu.ci.screenshot()) };
  // with the drawing skipped, lower the emulated CPU speed at run time
  const lower = {};
  for (const cycles of (process.argv[3] || '8000,4000,2000,1000,500').split(',').map(Number)) {
    emu.ci.sendBackendEvent({ type: 'wc-trigger-event', event: `cycles:${cycles}` });
    await sleep(1000);
    lower[cycles] = await measure(6);
  }
  console.log(JSON.stringify({ bundle: tag, renderOn: before, renderOff: after, dashAfter: st, renderOffLowerCycles: lower }, null, 1));
  await drv.keyUp('a');
  await emu.stop();
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
