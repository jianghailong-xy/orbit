// Usage: node outside-noise.cjs <runs dir> <isolation.json> <out.json>
// For the isolation proof (i): the differing pixels OUTSIDE the notification box between X and X+F (count, max
// channel delta, positions), next to the differences between independent runs of the SAME tree (X three times,
// X+F once more via the diagnostic run), which is Chromium's run-to-run noise (p0-drift README).
const { readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { PNG } = require('/var/tmp/p0d2/nm/f03a6e32/node_modules/playwright-core/lib/utilsBundle');
const [runs, isoPath, out] = process.argv.slice(2);
const iso = JSON.parse(readFileSync(isoPath));
const read = (run, rel) => PNG.sync.read(readFileSync(join(runs, run, 'snapshots', rel)));
function outside(a, b, box) {
  const [bx, by, bw, bh] = box; const pts = []; let max = 0, n = 0;
  for (let y = 0; y < a.height; y++) for (let x = 0; x < a.width; x++) {
    if (x >= bx && x < bx + bw && y >= by && y < by + bh) continue;
    const i = (y * a.width + x) * 4; let d = 0;
    for (let c = 0; c < 4; c++) d = Math.max(d, Math.abs(a.data[i + c] - b.data[i + c]));
    if (d) { n++; max = Math.max(max, d); if (pts.length < 40) pts.push([x, y, d]); }
  }
  return { pixels: n, maxChannelDelta: max, first: pts };
}
const result = {};
for (const [rel, p] of Object.entries(iso.proof1.screenshots)) {
  const box = p.notificationBox;
  result[rel] = {
    'X vs X+F (outside box)': outside(read('full-maint-d233a6cd0', rel), read('full-maint-xfix-d233a6cd0', rel), box),
    'X run 1 vs X run 2 (outside box)': outside(read('full-orig-d233a6cd0', rel), read('full-maint-d233a6cd0', rel), box),
    'X run 2 vs X run 3 (outside box)': outside(read('full-maint-d233a6cd0', rel), read('quick-profile-d233a6cd0', rel), box),
    'X+F run 1 vs X+F run 2 (outside box)': outside(read('full-maint-xfix-d233a6cd0', rel), read('diag-xfix-d233a6cd0', rel), box),
  };
}
writeFileSync(out, JSON.stringify(result, null, 1) + '\n');
for (const [rel, r] of Object.entries(result)) console.log(rel.padEnd(46), Object.entries(r).map(([k, v]) => `${k.replace(' (outside box)', '')}: ${v.pixels}px/${v.maxChannelDelta}`).join(' | '));
