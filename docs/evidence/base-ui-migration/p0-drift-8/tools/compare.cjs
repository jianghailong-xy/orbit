// Usage: node compare.cjs <dirA> <dirB> [out.json] [filter-regex]
// For every PNG under <dirA>/{project}/{name}.png that <dirB> also has: byte equality, exact pixel
// difference (count, max channel delta, bounding box) and the verdict of Playwright's own comparator with
// the P0 toHaveScreenshot options (maxDiffPixels 0, default threshold; <dirA> is the expectation), plus the
// noise-aware classification of p0-drift (README「Chromium 渲染噪声」): changed when the comparator fails,
// any WebKit pixel differs, or a Chromium pixel differs by more than 4 or in more than 200 pixels.
const { readFileSync, readdirSync, existsSync, writeFileSync, statSync } = require('node:fs');
const { join } = require('node:path');
const { createHash } = require('node:crypto');
const W = '/mnt/data/tmp/34dI9lY63LC7ZEZHbJ4bG/wt/base/node_modules/';
const { PNG } = require(W + 'playwright-core/lib/utilsBundle');
const comparator = require(W + 'playwright-core/lib/coreBundle').utils.getComparator('image/png');
const [dirA, dirB, out, filter] = process.argv.slice(2);
const re = filter ? new RegExp(filter) : null;
const sha = (b) => createHash('sha256').update(b).digest('hex');
const rows = [];
for (const project of readdirSync(dirA).sort().filter((p) => statSync(join(dirA, p)).isDirectory())) {
  for (const file of readdirSync(join(dirA, project)).filter((f) => f.endsWith('.png')).sort()) {
    const rel = `${project}/${file}`;
    if (re && !re.test(rel)) continue;
    const pathB = join(dirB, project, file);
    if (!existsSync(pathB)) { rows.push({ file: rel, missing: true }); continue; }
    const a = readFileSync(join(dirA, project, file)), b = readFileSync(pathB);
    const row = { file: rel, sha256A: sha(a), sha256B: sha(b), bytesEqual: a.equals(b) };
    if (!row.bytesEqual) {
      const ai = PNG.sync.read(a), bi = PNG.sync.read(b);
      if (ai.width === bi.width && ai.height === bi.height) {
        let n = 0, x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1, maxChannel = 0;
        for (let y = 0; y < ai.height; y++) for (let x = 0; x < ai.width; x++) {
          const i = (y * ai.width + x) * 4;
          let d = 0;
          for (let c = 0; c < 4; c++) d = Math.max(d, Math.abs(ai.data[i + c] - bi.data[i + c]));
          if (d) { n++; maxChannel = Math.max(maxChannel, d); x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
        }
        Object.assign(row, { differentPixels: n, maxChannelDelta: maxChannel, box: n ? { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 } : null });
      } else Object.assign(row, { sizeA: [ai.width, ai.height], sizeB: [bi.width, bi.height], differentPixels: Infinity, maxChannelDelta: 255 });
      const verdict = comparator(b, a, { maxDiffPixels: 0 });
      row.p0Comparator = verdict ? verdict.errorMessage.split('\n')[0] : 'match';
    } else Object.assign(row, { differentPixels: 0, maxChannelDelta: 0, p0Comparator: 'match' });
    row.changed = row.p0Comparator !== 'match' || (project.startsWith('webkit') && row.differentPixels > 0) || row.maxChannelDelta > 4 || row.differentPixels > 200;
    row.class = row.changed ? 'changed' : row.bytesEqual ? 'same' : 'noise';
    rows.push(row);
  }
}
const summary = { dirA, dirB, total: rows.length, missing: rows.filter((r) => r.missing).length, same: rows.filter((r) => r.class === 'same').length,
  noise: rows.filter((r) => r.class === 'noise').length, changed: rows.filter((r) => r.class === 'changed').map((r) => r.file),
  p0ComparatorFails: rows.filter((r) => !r.missing && r.p0Comparator !== 'match').map((r) => r.file) };
if (out) writeFileSync(out, JSON.stringify({ summary, rows }, null, 1) + '\n');
console.log(JSON.stringify({ ...summary, changed: summary.changed.length, p0ComparatorFails: summary.p0ComparatorFails.length }));
