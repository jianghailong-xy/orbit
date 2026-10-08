// Usage: node regions.cjs <a.png> <b.png> [toastBox x,y,w,h]
// Exact RGBA difference between two PNGs of equal size: total differing pixels and max channel delta,
// clusters (8-connected after a 6 px dilation) with their bounding boxes, and, when a toast box is
// given, the differing pixels inside / outside that box.
const { readFileSync } = require('node:fs');
const W = '/root/.orbit/worktrees/bf593adf-7724-576c-968c-fcd10880a595/node_modules/';
const { PNG } = require(W + 'playwright-core/lib/utilsBundle');
function regions(aPath, bPath, box) {
  const a = PNG.sync.read(readFileSync(aPath)), b = PNG.sync.read(readFileSync(bPath));
  if (a.width !== b.width || a.height !== b.height) return { sizeMismatch: [[a.width, a.height], [b.width, b.height]] };
  const w = a.width, h = a.height, mask = new Uint8Array(w * h);
  let pixels = 0, max = 0, inside = 0, insideMax = 0;
  for (let i = 0; i < w * h; i++) {
    let d = 0;
    for (let c = 0; c < 4; c++) d = Math.max(d, Math.abs(a.data[i * 4 + c] - b.data[i * 4 + c]));
    if (d) {
      mask[i] = 1; pixels++; max = Math.max(max, d);
      if (box) { const x = i % w, y = (i / w) | 0; if (x >= box[0] && x < box[0] + box[2] && y >= box[1] && y < box[1] + box[3]) { inside++; insideMax = Math.max(insideMax, d); } }
    }
  }
  const R = 6, dil = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (mask[y * w + x])
    for (let yy = Math.max(0, y - R); yy <= Math.min(h - 1, y + R); yy++) for (let xx = Math.max(0, x - R); xx <= Math.min(w - 1, x + R); xx++) dil[yy * w + xx] = 1;
  const seen = new Int32Array(w * h).fill(-1), clusters = [];
  for (let s = 0; s < w * h; s++) {
    if (!dil[s] || seen[s] >= 0) continue;
    const id = clusters.length, stack = [s]; seen[s] = id;
    let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1, n = 0;
    while (stack.length) {
      const p = stack.pop(), x = p % w, y = (p / w) | 0;
      if (mask[p]) { n++; x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy; if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const q = ny * w + nx; if (dil[q] && seen[q] < 0) { seen[q] = id; stack.push(q); }
      }
    }
    clusters.push({ x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1, pixels: n });
  }
  const out = { size: [w, h], pixels, maxChannelDelta: max, clusters: clusters.sort((p, q) => q.pixels - p.pixels) };
  if (box) Object.assign(out, { toastBox: box, insideToastBox: inside, insideToastBoxMax: insideMax, outsideToastBox: pixels - inside });
  return out;
}
module.exports = { regions };
if (require.main === module) {
  const [a, b, box] = process.argv.slice(2);
  console.log(JSON.stringify(regions(a, b, box ? box.split(',').map(Number) : null), null, 1));
}
