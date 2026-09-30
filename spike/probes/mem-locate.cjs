// Boot the game, find guest RAM and gp.exe inside the emulator heap, and
// check the found image against the unpacked gp.exe.
//
//   node build-bundle.mjs --autoexec "gp /g" --out dist/mem-probe.jsdos
//   node tools/unexepack.mjs
//   node probes/mem-locate.cjs

const fs = require("node:fs");
const path = require("node:path");
const { start, sleep } = require("../lib/node-emu.cjs");
const { locate } = require("../lib/guest-mem.cjs");

const root = path.join(__dirname, "..");
(async () => {
  const emu = await start(path.join(root, "dist", "mem-probe.jsdos"));
  await sleep(6000); // gp.exe is loaded and showing its first screen by now
  const mem = locate(emu.ci);
  const image = fs.readFileSync(path.join(root, "out", "gp_unpacked.bin"));
  const live = mem.snapshot(mem.imageLinear, image.length);
  let same = 0;
  for (let i = 0; i < image.length; i++) if (live[i] === image[i]) same++;
  console.log(JSON.stringify({
    version: mem.version,
    memBase: mem.memBase,
    imageLinear: "0x" + mem.imageLinear.toString(16),
    imageSeg: "0x" + mem.imageSeg.toString(16),
    imageBytesUnchanged: `${same}/${image.length}`,
  }));
  await emu.stop();
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
