// p1-track-draw.mjs - draw every circuit from its track file (centreline,
// edges, pit lane, TV cameras, start/finish) as SVG, plus a 4x4 contact
// sheet, and write the closure error per track to out/p1-track/closure.json.
//   node probes/p1-track-draw.mjs [--game ../original] [--out out/p1-track]
// PNG copies through headless Chromium (playwright-core).
import fs from 'node:fs';
import path from 'node:path';
import { parseTrack, compileTrack, trackOutline, CIRCUITS, METRES_PER_FINE } from '../lib/track-file.mjs';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const GAME = opt('--game', path.resolve(import.meta.dirname, '../../original'));
const OUT = opt('--out', path.resolve(import.meta.dirname, '../out/p1-track'));
fs.mkdirSync(OUT, { recursive: true });

function svgFor(name, outline, segs, track, size = 600, label = true) {
  // Y up: flip y. Fit the left/right edges into the box.
  const pts = outline.left.concat(outline.right);
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const [x, y] of pts) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
  const pad = 20, span = Math.max(maxX - minX, maxY - minY);
  const s = (size - 2 * pad) / span;
  const ox = pad + ((size - 2 * pad) - (maxX - minX) * s) / 2, oy = pad + ((size - 2 * pad) - (maxY - minY) * s) / 2;
  const P = ([x, y]) => `${(ox + (x - minX) * s).toFixed(1)},${(size - oy - (y - minY) * s).toFixed(1)}`;
  const poly = (arr, attrs) => `<polygon points="${arr.map(P).join(' ')}" ${attrs}/>`;
  const line = (arr, attrs) => `<polyline points="${arr.map(P).join(' ')}" ${attrs}/>`;
  const parts = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">`);
  parts.push(`<rect width="100%" height="100%" fill="#fbfbf8"/>`);
  // track surface as a band between the edges
  parts.push(poly(outline.left, 'fill="none" stroke="#999" stroke-width="1"'));
  parts.push(poly(outline.right, 'fill="none" stroke="#999" stroke-width="1"'));
  parts.push(poly(outline.centre, 'fill="none" stroke="#c22" stroke-width="1.2"'));
  // pit lane (edges and centre) and TV cameras (blue = left of the track, orange = right)
  parts.push(line(outline.pit.left, 'fill="none" stroke="#69c" stroke-width="0.8"'));
  parts.push(line(outline.pit.right, 'fill="none" stroke="#69c" stroke-width="0.8"'));
  parts.push(line(outline.pit.centre, 'fill="none" stroke="#06c" stroke-width="1" stroke-dasharray="3 2"'));
  for (const c of outline.cameras) {
    const [cx, cy] = P([c.x, c.y]).split(',');
    parts.push(`<circle cx="${cx}" cy="${cy}" r="${size > 400 ? 2.2 : 1.4}" fill="${c.side === 'right' ? '#e80' : '#36c'}"/>`);
  }
  // start/finish: perpendicular tick at segment 0, arrow showing direction
  const sf = [outline.left[0], outline.right[0]];
  parts.push(line(sf, 'stroke="#000" stroke-width="3"'));
  const a = outline.centre[0], b = outline.centre[Math.min(12, outline.centre.length - 1)];
  parts.push(line([a, b], 'stroke="#000" stroke-width="1.5" marker-end="url(#m)"'));
  parts.unshift(); // keep order
  parts.splice(1, 0, `<defs><marker id="m" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="5" markerHeight="5" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#000"/></marker></defs>`);
  if (label) {
    const km = (outline.centre.length * 16 * 0.3048 / 1000).toFixed(2);
    parts.push(`<text x="8" y="16" font-family="sans-serif" font-size="14">${name} - ${outline.centre.length} segments = ${km} km</text>`);
    parts.push(`<text x="8" y="${size - 8}" font-family="sans-serif" font-size="11" fill="#555">X right, Y up (game axes). 1 bar = 200 m</text>`);
    const bar = 200 / METRES_PER_FINE * (outline.units === 'world' ? 256 : 1) * s;
    parts.push(`<line x1="${size - 20 - bar}" y1="${size - 12}" x2="${size - 20}" y2="${size - 12}" stroke="#000" stroke-width="3"/>`);
  }
  parts.push('</svg>');
  return parts.join('\n');
}

const summary = [];
const sheet = [];
for (let i = 1; i <= 16; i++) {
  const id = String(i).padStart(2, '0');
  const bytes = new Uint8Array(fs.readFileSync(path.join(GAME, `f1ct${id}.dat`)));
  const t = parseTrack(bytes);
  const raw = compileTrack(t, { fit: false });
  const outline = trackOutline(t);
  const segs = outline.segs;
  const last = raw.segs[raw.segs.length - 1], first = raw.segs[0];
  // closure: the lap's last TLU should land on segment 0 (the walk has one TLU more than the lap)
  const dx = first.x - last.x, dy = first.y - last.y;
  const endAngleErr = raw.closure.endAngle; // end heading minus start heading (1/65536 turn)
  const turns = t.sections.reduce((s, x) => s + x.length * x.curvature, 0) / 65536;
  const rec = {
    file: `f1ct${id}.dat`, circuit: CIRCUITS[i - 1], checksumOk: t.checksum.ok,
    sections: t.sections.length, tlu: t.totalTlu, km: +(t.totalTlu * 16 * 0.3048 / 1000).toFixed(3),
    turns: +turns.toFixed(4),
    closureLastToFirst: { dx, dy, fine: +Math.hypot(dx, dy).toFixed(1), metres: +(Math.hypot(dx, dy) * METRES_PER_FINE).toFixed(2) },
    closureEndToFirst: { dx: raw.closure.endDx, dy: raw.closure.endDy, dz: raw.closure.endDz, fine: +raw.closure.endDist.toFixed(1) },
    headingErr: { units: endAngleErr, degrees: +(endAngleErr * 360 / 65536).toFixed(3) },
    zClosure: first.z - last.z,
    startAngle: t.header.startAngle, start: [t.header.x << 3, t.header.y << 3, t.header.z],
  };
  summary.push(rec);
  const svg = svgFor(`${id} ${CIRCUITS[i - 1]}`, outline, segs, t);
  fs.writeFileSync(path.join(OUT, `track-${id}.svg`), svg);
  sheet.push(svgFor(`${id} ${CIRCUITS[i - 1]}`, outline, segs, t, 300, true));
  console.log(`${id} ${CIRCUITS[i - 1].padEnd(18)} tlu ${String(t.totalTlu).padStart(4)} turns ${turns.toFixed(4)} ` +
    `closure(last->first) ${rec.closureLastToFirst.fine.toFixed(0).padStart(5)} fine = ${rec.closureLastToFirst.metres} m ` +
    `heading err ${rec.headingErr.degrees} deg  z ${rec.zClosure}`);
}
fs.writeFileSync(path.join(OUT, 'closure.json'), JSON.stringify(summary, null, 1));

// contact sheet: 4x4 of 300px tiles
const tiles = sheet.map((s, k) => {
  const inner = s.replace(/^<svg[^>]*>/, '').replace(/<\/svg>$/, '');
  return `<g transform="translate(${(k % 4) * 300},${Math.floor(k / 4) * 300})">${inner.replace(/id="m"/g, `id="m${k}"`).replace(/url\(#m\)/g, `url(#m${k})`)}<rect width="300" height="300" fill="none" stroke="#ccc"/></g>`;
});
fs.writeFileSync(path.join(OUT, 'tracks-sheet.svg'), `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="1200">${tiles.join('\n')}</svg>`);

// PNG copies through headless Chromium (playwright-core), for viewing.
async function toPng(files) {
  let chromium;
  try { ({ chromium } = await import('playwright-core')); } catch { console.log('no playwright-core: SVG only'); return; }
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    for (const f of files) {
      const svg = fs.readFileSync(f, 'utf8');
      const m = svg.match(/width="(\d+)" height="(\d+)"/);
      await page.setViewportSize({ width: +m[1], height: +m[2] });
      await page.setContent(`<html><body style="margin:0">${svg}</body></html>`);
      await page.screenshot({ path: f.replace(/\.svg$/, '.png'), clip: { x: 0, y: 0, width: +m[1], height: +m[2] } });
    }
  } finally { await browser.close(); }
  console.log('PNG written for', files.length, 'files');
}
const svgs = [path.join(OUT, 'tracks-sheet.svg')];
for (let i = 1; i <= 16; i++) svgs.push(path.join(OUT, `track-${String(i).padStart(2, '0')}.svg`));
await toPng(svgs);
