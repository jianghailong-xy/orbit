// Usage: node compare.cjs <expectedDir> <actualDir> [out.json]
// For every PNG under <expectedDir>/{project}/{name}.png: byte equality, exact pixel difference
// (count and bounding box) and the verdict of Playwright's own comparator with the P0
// toHaveScreenshot options (maxDiffPixels 0, default threshold) - i.e. what the P0 regression
// would decide for this pair.
const { readFileSync, readdirSync, existsSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { createHash } = require('node:crypto');
const W = '/root/.orbit/worktrees/3a1c46ee-9958-51c0-b844-89a44ffe9d25/node_modules/';
const { PNG } = require(W + 'playwright-core/lib/utilsBundle');
const comparator = require(W + 'playwright-core/lib/coreBundle').utils.getComparator('image/png');
const [expectedDir, actualDir, out] = process.argv.slice(2);
const sha = (b) => createHash('sha256').update(b).digest('hex');
const rows = [];
for (const project of readdirSync(expectedDir).sort().filter((p) => !p.includes('.'))) {
  for (const file of readdirSync(join(expectedDir, project)).filter((f) => f.endsWith('.png')).sort()) {
    const e = readFileSync(join(expectedDir, project, file));
    const path = join(actualDir, project, file);
    if (!existsSync(path)) { rows.push({ file: `${project}/${file}`, missing: true }); continue; }
    const a = readFileSync(path);
    const row = { file: `${project}/${file}`, expectedSha256: sha(e), actualSha256: sha(a), bytesEqual: e.equals(a) };
    if (!row.bytesEqual) {
      const ei = PNG.sync.read(e), ai = PNG.sync.read(a);
      row.expectedSize = [ei.width, ei.height];
      row.actualSize = [ai.width, ai.height];
      if (ei.width === ai.width && ei.height === ai.height) {
        let n = 0, x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1, maxChannel = 0;
        for (let y = 0; y < ei.height; y++) for (let x = 0; x < ei.width; x++) {
          const i = (y * ei.width + x) * 4;
          let d = 0;
          for (let c = 0; c < 4; c++) d = Math.max(d, Math.abs(ei.data[i + c] - ai.data[i + c]));
          if (d) { n++; maxChannel = Math.max(maxChannel, d); x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
        }
        row.differentPixels = n;
        row.maxChannelDelta = maxChannel;
        row.box = n ? { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 } : null;
      }
      const verdict = comparator(a, e, { maxDiffPixels: 0 });
      row.p0Comparator = verdict ? verdict.errorMessage.split('\n')[0] : 'match';
    } else row.p0Comparator = 'match';
    rows.push(row);
  }
}
const summary = { expectedDir, actualDir, total: rows.length, missing: rows.filter((r) => r.missing).length,
  bytesEqual: rows.filter((r) => r.bytesEqual).length, differ: rows.filter((r) => !r.missing && !r.bytesEqual).length,
  pixelEqualButBytesDiffer: rows.filter((r) => !r.bytesEqual && r.differentPixels === 0).length,
  p0ComparatorFails: rows.filter((r) => !r.missing && r.p0Comparator !== 'match').length };
if (out) writeFileSync(out, JSON.stringify({ summary, rows }, null, 1) + '\n');
console.log(JSON.stringify(summary));
