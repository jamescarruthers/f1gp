// Build the screen fingerprints in lib/route.cjs from reference screenshots
// (out/route/...), then print a match matrix over all probe screenshots.
//   node probes/route-fp.cjs          rebuild + check
//   node probes/route-fp.cjs --check  check only
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const ROUTE = path.join(__dirname, '..', 'lib', 'route.cjs');
const OUT = path.join(__dirname, '..', 'out', 'route');

function loadPng(fn) {
  const d = fs.readFileSync(fn); let i = 8, w, h, ct; const idat = [];
  while (i < d.length) {
    const l = d.readUInt32BE(i), t = d.toString('ascii', i + 4, i + 8), c = d.subarray(i + 8, i + 8 + l);
    if (t === 'IHDR') { w = c.readUInt32BE(0); h = c.readUInt32BE(4); ct = c[9]; }
    if (t === 'IDAT') idat.push(c);
    i += 12 + l;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat)); const ch = ct === 6 ? 4 : 3; const st = w * ch;
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const s = y * (st + 1) + 1 + x * ch, o = (y * w + x) * 4;
    data[o] = raw[s]; data[o + 1] = raw[s + 1]; data[o + 2] = raw[s + 2]; data[o + 3] = 255;
  }
  return { width: w, height: h, data };
}

// name: [reference png, rect [x, y, w, h], mode]
const SPEC = {
  language:    ['p1/t004.png',   [60, 43, 201, 15], 'white'],  // "CHOOSE LANGUAGE"
  protection:  ['p6/q1.png',     [60, 43, 201, 15], 'white'],  // "MANUAL PROTECTION"
  joystick:    ['p8/r1.png',     [60, 55, 201, 15], 'white'],  // "JOYSTICK SELECTED"
  startup:     ['p8/r4.png',     [88, 63, 145, 14], 'white'],  // "STARTUP MENU"
  main:        ['p9/m2.png',     [110, 11, 106, 14], 'white'], // "MAIN MENU"
  circuits:    ['p10/pr2.png',   [80, 23, 161, 15], 'white'],  // "SELECT CIRCUIT"
  circuitView: ['p11/c1_009.png', [262, 112, 49, 27], 'white'], // "View" "Info" buttons (panel on the right)
  circuitViewL: ['qr/q1.png',    [9, 112, 49, 27], 'white'],   // same, panel on the left (Monza)
  cockpit:     ['p12/g_015.png', [122, 153, 57, 7], 'white'],  // "X1000 RPM" on the rev counter
  pits:        ['p12/g_015.png', [128, 193, 73, 7], 'lcd'],    // "TYRE CHOICE" on the LCD
  car:         ['p14/a_005.png', [140, 183, 43, 8], 'lcd'],    // "LAPTIME" on the LCD
  race:        ['qr/g2.png',     [164, 193, 40, 6], 'lcd'],    // "RUNNERS" on the race LCD
  q85_4_1_11:  ['p6/q1.png',     [196, 124, 25, 41], 'yellow'], // question numbers 85 4 1 11
};

let route = require(ROUTE);
if (!process.argv.includes('--check')) {
  const fps = {};
  for (const [name, [ref, rect, mode]] of Object.entries(SPEC)) {
    const img = loadPng(path.join(OUT, ref));
    const bits = route.mask(img, rect, mode);
    const n = bits.reduce((a, b) => a + b, 0);
    fps[name] = { rect, mode, ref, bits: route.packBits(bits) };
    console.log(`${name}: ${n} set pixels of ${bits.length}`);
  }
  let src = fs.readFileSync(ROUTE, 'utf8');
  const json = JSON.stringify(fps, null, 1).replace(/\n\s*/g, ' ');
  src = src.replace(/\/\*FP-BEGIN\*\/[\s\S]*?\/\*FP-END\*\//, `/*FP-BEGIN*/${json}/*FP-END*/`);
  fs.writeFileSync(ROUTE, src);
  delete require.cache[require.resolve(ROUTE)];
  route = require(ROUTE);
}

// Match every screenshot under out/route/p*/ and demo dirs.
const files = [];
for (const d of fs.readdirSync(OUT)) {
  const dir = path.join(OUT, d);
  if (!fs.statSync(dir).isDirectory() || d === 'manual') continue;
  for (const f of fs.readdirSync(dir)) if (f.endsWith('.png')) files.push(path.join(d, f));
}
const counts = {};
for (const f of files.sort()) {
  const img = loadPng(path.join(OUT, f));
  if (img.width !== 320) continue;
  const id = route.identify(img);
  const q = route.identifyQuestion(img);
  const top = Object.entries(id.scores).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${k}=${v.toFixed(2)}`).join(' ');
  counts[id.screen] = (counts[id.screen] || 0) + 1;
  if (process.argv.includes('-v') || id.screen === 'unknown')
    console.log(f.padEnd(24), id.screen.padEnd(12), top, q ? `Q=${q.name}` : '', `mph=${route.readMph(img)} occ=${route.readOccupancy(img)}`);
}
console.log(counts);
