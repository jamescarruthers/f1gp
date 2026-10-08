// render.html with r3d=gpu in headless Chromium: our PC (machine=rust) races a Monza Quick Race
// with the autopilot, our port of the game's 3D routine draws, and the page shows each frame the
// game shows with its 3D view painted by WebGPU at the scale asked (lib/gpu-r3d.mjs), the
// game's cockpit, dash and messages over it. At scale 1, with gpucheck=1, every 15th frame is
// read back and must be the game's screen, byte for byte. Saves a screenshot of the cockpit and
// of the chase view.
//
//   node build-machine.mjs && node probes/p10-r3d-gpu.mjs [--scale 1] [--seconds 10] [--size 1280x800]
//
// Headless Chromium paints WebGPU with SwiftShader, on the CPU: its times say nothing of a real
// GPU. A WebGPU canvas needs SwiftShader's Vulkan here (the flags below).
// Output: out/p10-r3d-gpu/<scale>-{cockpit,chase}.png and a summary line.

import fs from 'node:fs';
import path from 'node:path';
import { launch } from '../lib/browser-emu.mjs';
import { route, sleep } from './browser-probe-lib.mjs';
import { installAutopilot } from './p1-map-lib.mjs';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const SCALE = opt('scale', '1'), SECONDS = +opt('seconds', 10);
const [W, H] = opt('size', '1280x800').split('x').map(Number);
const OUT = path.join(import.meta.dirname, '..', 'out', 'p10-r3d-gpu');
fs.mkdirSync(OUT, { recursive: true });

const emu = await launch({
  bundle: 'dist/f1gp.jsdos', page: 'render.html', viewport: { width: W, height: H },
  query: { machine: 'rust', screen: 'original', r3d: 'gpu', scale: SCALE, gpucheck: 1 },
  chromiumArgs: ['--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--enable-gpu-compositing',
    '--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-vulkan=swiftshader'],
});
const page = emu.page;
let failed = false;
try {
  const events = () => page.evaluate(() => (window.emuEvents ?? []).map((e) => e.kind ?? e.type ?? e).slice(-40));
  await route.toTrack(emu.driver, { mode: 'quickrace', log: () => {} });
  await page.evaluate(installAutopilot, { pollMs: 8 });
  const gpu = () => page.evaluate(() => ({ gpu: window.renderApp.gpu ?? null, perf: window.renderApp.perf, opts: { r3d: window.renderApp.opts.r3d }, hidden: document.getElementById('gpu').hidden }));
  // the game's own pace: its frame counter and session clock against real time
  const clock = () => page.evaluate(() => { const st = window.renderApp.reader.read(); return { frame: st.frame, ms: st.sessionMs, at: performance.now() }; });
  const c0 = await clock();
  await sleep(SECONDS * 1000);
  const c1 = await clock();
  const a = await gpu();
  await emu.driver.pageShot(path.join(OUT, `${SCALE}-cockpit.png`));
  await emu.driver.press(267, 150); // Page Down: the chase view
  await sleep(SECONDS * 1000);
  const b = await gpu();
  const pace = (x, y) => ({ framesPerS: +((y.frame - x.frame) / ((y.at - x.at) / 1000)).toFixed(1), speed: +((y.ms - x.ms) / (y.at - x.at)).toFixed(2) });
  await emu.driver.pageShot(path.join(OUT, `${SCALE}-chase.png`));
  const r = { scale: SCALE, r3d: b.opts.r3d, shown: b.gpu?.shown ?? 0, scaleUsed: b.gpu?.scale, checked: b.gpu?.checked ?? 0, differ: b.gpu?.differ ?? null,
    lastDiffer: b.gpu?.lastDiffer, errors: b.gpu?.errors, fps3d: [a.gpu?.fps, b.gpu?.fps], framesKept: [a.perf?.kept, b.perf?.kept], sendMs: [a.gpu?.sendMs, b.gpu?.sendMs], gameFps: [a.perf?.gameFps, b.perf?.gameFps], pageFps: [a.perf?.pageFps, b.perf?.pageFps], game: pace(c0, c1), canvasShown: !b.hidden };
  console.log(JSON.stringify(r));
  if (r.r3d !== 'gpu' || !r.shown || !r.canvasShown) { failed = true; console.log('the WebGPU view did not show', JSON.stringify(await events())); }
  if (SCALE === '1' && (!r.checked || r.differ !== 0)) { failed = true; console.log(`at scale 1, ${r.differ} of ${r.checked} frames checked differ from the game's screen`); }
} finally {
  await emu.close();
}
process.exit(failed ? 1 : 0);
