// Usage: node isolation.cjs <runs dir> <p0.2 screenshots dir> <out.json>
// The two isolation proofs of p0-drift README main drift rule 7 for the profile-validation exception:
// (i)  X = d233a6cd0 vs X+F (F = B1 fix 3ec9cf83d): every differing pixel of the six screenshots lies in the
//      notification box (card and column rects of both trees, from b1-state.diag.mjs, grown by 34px for the
//      0 8px 22px shadow, as in p2.3-b1), and no other screenshot of the 252 changes beyond Chromium noise;
// (ii) X^1+F (e6786d077 + F) vs P0.2: the six screenshots are byte-identical or within the recorded noise.
const { readFileSync, writeFileSync, readdirSync } = require('node:fs');
const { join } = require('node:path');
const W = '/var/tmp/p0d2/nm/f03a6e32/node_modules/';
const { PNG } = require(W + 'playwright-core/lib/utilsBundle');
const comparator = require(W + 'playwright-core/lib/coreBundle').utils.getComparator('image/png');
const [runs, p02, out] = process.argv.slice(2);
const six = ['chromium-dark-desktop', 'chromium-light-desktop', 'chromium-dark-phone', 'chromium-light-phone', 'webkit-dark-phone', 'webkit-light-phone'].map((p) => `${p}/profile-validation.png`);
const shot = (run, rel) => readFileSync(join(runs, run, 'snapshots', rel));
const geometry = (run) => JSON.parse(readFileSync(join(runs, '..', 'cmp', `geometry-${run}.json`)));
function diff(a, b) {
  const A = PNG.sync.read(a), B = PNG.sync.read(b);
  const mask = new Uint8Array(A.width * A.height);
  let n = 0, max = 0;
  for (let i = 0; i < mask.length; i++) {
    let d = 0;
    for (let c = 0; c < 4; c++) d = Math.max(d, Math.abs(A.data[i * 4 + c] - B.data[i * 4 + c]));
    if (d) { mask[i] = 1; n++; max = Math.max(max, d); }
  }
  return { width: A.width, height: A.height, mask, pixels: n, maxChannelDelta: max, comparator: comparator(b, a, { maxDiffPixels: 0 }) ? 'fails' : 'match' };
}
// Differing pixels within 6px of each other form one cluster (p0-drift / p2.3-b1 regions).
function clusters({ width, height, mask }) {
  const seen = new Uint8Array(mask.length), out = [];
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || seen[start]) continue;
    let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1, count = 0; const stack = [start]; seen[start] = 1;
    while (stack.length) {
      const i = stack.pop(), x = i % width, y = (i - x) / width; count++;
      x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
      for (let dy = -6; dy <= 6; dy++) for (let dx = -6; dx <= 6; dx++) {
        const nx = x + dx, ny = y + dy; if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const j = ny * width + nx; if (mask[j] && !seen[j]) { seen[j] = 1; stack.push(j); }
      }
    }
    out.push({ x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1, pixels: count });
  }
  return out;
}
function box(rel, geos, width, height) {
  let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
  for (const g of geos) for (const r of [g[rel].section, ...g[rel].cards.map((c) => c.rect)]) {
    x0 = Math.min(x0, r.x); y0 = Math.min(y0, r.y); x1 = Math.max(x1, r.x + r.width); y1 = Math.max(y1, r.y + r.height);
  }
  const m = 34;
  return [Math.max(0, Math.floor(x0 - m)), Math.max(0, Math.floor(y0 - m)), Math.min(width, Math.ceil(x1 + m)), Math.min(height, Math.ceil(y1 + m))];
}
const result = { proof1: { a: 'full-maint-d233a6cd0', b: 'full-maint-xfix-d233a6cd0', screenshots: {}, others: {} }, proof2: { a: 'P0.2', b: 'full-maint-xfix-e6786d077', screenshots: {} } };
const geos = [geometry('diag-d233a6cd0'), geometry('diag-xfix-d233a6cd0')];
for (const rel of six) {
  const d = diff(shot('full-maint-d233a6cd0', rel), shot('full-maint-xfix-d233a6cd0', rel));
  const [bx0, by0, bx1, by1] = box(rel, geos, d.width, d.height);
  let inside = 0, outside = 0;
  for (let i = 0; i < d.mask.length; i++) if (d.mask[i]) { const x = i % d.width, y = (i - x) / d.width; if (x >= bx0 && x < bx1 && y >= by0 && y < by1) inside++; else outside++; }
  result.proof1.screenshots[rel] = { pixels: d.pixels, maxChannelDelta: d.maxChannelDelta, p0Comparator: d.comparator, notificationBox: [bx0, by0, bx1 - bx0, by1 - by0], inside, outside, clusters: clusters(d),
    geometry: { X: { card: geos[0][rel].cards[0].rect, column: geos[0][rel].section, willChange: geos[0][rel].cards[0].willChange, inlineStyle: geos[0][rel].inlineStyle }, 'X+F': { card: geos[1][rel].cards[0].rect, column: geos[1][rel].section, willChange: geos[1][rel].cards[0].willChange, inlineStyle: geos[1][rel].inlineStyle } } };
  const e = readFileSync(join(p02, rel)), f = shot('full-maint-xfix-e6786d077', rel);
  const d2 = e.equals(f) ? null : diff(e, f);
  result.proof2.screenshots[rel] = d2 ? { bytesEqual: false, pixels: d2.pixels, maxChannelDelta: d2.maxChannelDelta, p0Comparator: d2.comparator, clusters: clusters(d2),
    withinNoise: d2.comparator === 'match' && !rel.startsWith('webkit') && d2.maxChannelDelta <= 4 && d2.pixels <= 200 } : { bytesEqual: true, pixels: 0 };
}
// Every other screenshot of the matrix, X vs X+F.
for (const project of readdirSync(join(runs, 'full-maint-d233a6cd0', 'snapshots'))) for (const file of readdirSync(join(runs, 'full-maint-d233a6cd0', 'snapshots', project))) {
  const rel = `${project}/${file}`; if (six.includes(rel)) continue;
  const a = shot('full-maint-d233a6cd0', rel), b = shot('full-maint-xfix-d233a6cd0', rel);
  if (a.equals(b)) { result.proof1.others[rel] = 'same'; continue; }
  const d = diff(a, b), noise = d.comparator === 'match' && !project.startsWith('webkit') && d.maxChannelDelta <= 4 && d.pixels <= 200;
  result.proof1.others[rel] = noise ? `noise ${d.pixels}px/${d.maxChannelDelta}` : { pixels: d.pixels, maxChannelDelta: d.maxChannelDelta, p0Comparator: d.comparator, clusters: clusters(d) };
}
writeFileSync(out, JSON.stringify(result, null, 1) + '\n');
for (const rel of six) {
  const p = result.proof1.screenshots[rel], q = result.proof2.screenshots[rel];
  console.log(rel.padEnd(46), `(i) ${p.pixels}px max ${p.maxChannelDelta} inside ${p.inside} outside ${p.outside} clusters ${p.clusters.map((c) => `${c.x},${c.y} ${c.width}x${c.height}:${c.pixels}`).join(' ')}`, '|', `(ii) ${q.bytesEqual ? 'byte-identical' : `${q.pixels}px/${q.maxChannelDelta} ${q.withinNoise ? 'noise' : 'NOT NOISE'}`}`);
}
const others = Object.entries(result.proof1.others).filter(([, v]) => typeof v !== 'string');
console.log('other screenshots X vs X+F:', Object.values(result.proof1.others).filter((v) => v === 'same').length, 'same,', Object.values(result.proof1.others).filter((v) => typeof v === 'string' && v.startsWith('noise')).length, 'noise, changed:', others.map(([k, v]) => `${k} ${v.pixels}px/${v.maxChannelDelta} ${v.p0Comparator} ${v.clusters.map((c) => `${c.x},${c.y} ${c.width}x${c.height}`).join(' ')}`));
