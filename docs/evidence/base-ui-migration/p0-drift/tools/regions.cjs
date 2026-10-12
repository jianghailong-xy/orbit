// Usage: node regions.cjs <a.png> <b.png>  -> JSON: differing pixel count, max channel delta, the P0 comparator, and
// clusters (8-connected after dilating by 6px) with bounding boxes and pixel counts.
const { readFileSync } = require('node:fs');
const W = require('node:path').resolve(__dirname, '../../../../..') + '/';
const { PNG } = require(W + 'node_modules/playwright-core/lib/utilsBundle');
const comparator = require(W + 'node_modules/playwright-core/lib/coreBundle').utils.getComparator('image/png');
const [a, b] = process.argv.slice(2);
const xa = readFileSync(a), xb = readFileSync(b);
const A = PNG.sync.read(xa), B = PNG.sync.read(xb);
if (A.width !== B.width || A.height !== B.height) { console.log(JSON.stringify({ sizeA: [A.width, A.height], sizeB: [B.width, B.height] })); process.exit(0); }
const w = A.width, h = A.height, diff = new Uint8Array(w * h);
let n = 0, m = 0;
for (let i = 0, p = 0; i < A.data.length; i += 4, p++) {
  let d = 0; for (let c = 0; c < 4; c++) d = Math.max(d, Math.abs(A.data[i + c] - B.data[i + c]));
  if (d) { diff[p] = 1; n++; m = Math.max(m, d); }
}
const R = 6, seen = new Uint8Array(w * h), clusters = [];
for (let p = 0; p < w * h; p++) {
  if (!diff[p] || seen[p]) continue;
  const stack = [p]; seen[p] = 1; let x0 = w, y0 = h, x1 = 0, y1 = 0, count = 0;
  while (stack.length) {
    const q = stack.pop(), x = q % w, y = (q - x) / w; count++;
    x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
    for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
      const nx = x + dx, ny = y + dy; if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const r = ny * w + nx; if (diff[r] && !seen[r]) { seen[r] = 1; stack.push(r); }
    }
  }
  clusters.push({ x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1, pixels: count });
}
const verdict = comparator(xb, xa, { maxDiffPixels: 0 });
console.log(JSON.stringify({ size: [w, h], pixels: n, maxChannelDelta: m, p0Comparator: verdict ? verdict.errorMessage : 'match', clusters }));
