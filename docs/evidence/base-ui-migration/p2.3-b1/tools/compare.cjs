// Usage: node compare.cjs <expectedDir> <actualDir> [regex] [out.json]
// For every PNG under <actualDir>/{project}/{name}.png that <expectedDir> also has (optionally only
// names matching regex): byte equality, exact pixel difference (count, max channel delta, bounding
// box) and the verdict of Playwright's own comparator with the P0 toHaveScreenshot options
// (maxDiffPixels 0, default threshold) - what the P0 regression decides for this pair.
const { readFileSync, readdirSync, existsSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { createHash } = require('node:crypto');
const W = '/root/.orbit/worktrees/bf593adf-7724-576c-968c-fcd10880a595/node_modules/';
const { PNG } = require(W + 'playwright-core/lib/utilsBundle');
const comparator = require(W + 'playwright-core/lib/coreBundle').utils.getComparator('image/png');
const [expectedDir, actualDir, only, out] = process.argv.slice(2);
const re = only ? new RegExp(only) : null;
const sha = (b) => createHash('sha256').update(b).digest('hex');
const rows = [];
for (const project of readdirSync(actualDir).sort().filter((p) => !p.includes('.'))) {
  for (const file of readdirSync(join(actualDir, project)).filter((f) => f.endsWith('.png')).sort()) {
    const rel = `${project}/${file}`;
    if (re && !re.test(rel)) continue;
    const path = join(expectedDir, project, file);
    if (!existsSync(path)) { rows.push({ file: rel, missingExpected: true }); continue; }
    const e = readFileSync(path), a = readFileSync(join(actualDir, project, file));
    const row = { file: rel, expectedSha256: sha(e), actualSha256: sha(a), bytesEqual: e.equals(a) };
    if (!row.bytesEqual) {
      const ei = PNG.sync.read(e), ai = PNG.sync.read(a);
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
      } else row.sizes = { expected: [ei.width, ei.height], actual: [ai.width, ai.height] };
      const verdict = comparator(a, e, { maxDiffPixels: 0 });
      row.p0Comparator = verdict ? verdict.errorMessage.split('\n')[0] : 'match';
    } else row.p0Comparator = 'match';
    rows.push(row);
  }
}
const summary = { expectedDir, actualDir, only: only ?? null, total: rows.length, bytesEqual: rows.filter((r) => r.bytesEqual).length,
  pixelEqual: rows.filter((r) => r.bytesEqual || r.differentPixels === 0).length,
  p0ComparatorFails: rows.filter((r) => r.p0Comparator && r.p0Comparator !== 'match').length, missingExpected: rows.filter((r) => r.missingExpected).length };
if (out) writeFileSync(out, JSON.stringify({ summary, rows }, null, 1) + '\n');
console.log(JSON.stringify(summary));
for (const r of rows) if (!r.bytesEqual) console.log(`  ${r.file}: ${r.differentPixels ?? '?'} px, max ${r.maxChannelDelta ?? '?'}, ${r.p0Comparator}`);
