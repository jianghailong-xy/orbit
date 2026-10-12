// Usage: node changepoints.cjs <out.json> <label0> <label1> ...   (labels ordered along a line;
// 'p02' = the committed P0.2 originals). For each P0 screenshot and each consecutive pair of runs:
// exact pixel difference, Playwright's comparator with the P0 options (what the regression decides),
// and a classification: 'change' when the comparator fails, when any WebKit pixel differs (WebKit
// is deterministic across repeated runs), or when a Chromium difference exceeds the noise envelope
// measured on repeated runs of one commit (max channel delta 4, 200 pixels); otherwise 'noise'.
const { readFileSync, readdirSync, existsSync, writeFileSync } = require('node:fs');
const W = '/root/.orbit/worktrees/e65f238b-4789-5587-b24a-cf2d708322d1/';
const { PNG } = require(W + 'node_modules/playwright-core/lib/utilsBundle');
const comparator = require(W + 'node_modules/playwright-core/lib/coreBundle').utils.getComparator('image/png');
const P02 = W + 'docs/evidence/base-ui-migration/p0.2/screenshots';
const [out, ...labels] = process.argv.slice(2);
const file = (label, rel) => label === 'p02' ? `${P02}/${rel}` : `/var/tmp/p0drift/runs/${label}/snapshots/${rel}`;
const only = process.env.ONLY ? new RegExp(process.env.ONLY) : null;
const rels = readdirSync(P02).sort().flatMap((p) => readdirSync(`${P02}/${p}`).sort().map((f) => `${p}/${f}`)).filter((rel) => !only || only.test(rel));
const NOISE = { maxChannelDelta: 4, pixels: 200 };
function diff(a, b, rel) {
  if (a.equals(b)) return null;
  const ai = PNG.sync.read(a), bi = PNG.sync.read(b);
  const row = {};
  if (ai.width !== bi.width || ai.height !== bi.height) row.size = [[ai.width, ai.height], [bi.width, bi.height]];
  else {
    let n = 0, m = 0, x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
    for (let i = 0; i < ai.data.length; i += 4) {
      let d = 0;
      for (let c = 0; c < 4; c++) d = Math.max(d, Math.abs(ai.data[i + c] - bi.data[i + c]));
      if (!d) continue;
      const x = (i / 4) % ai.width, y = Math.floor(i / 4 / ai.width);
      n++; m = Math.max(m, d); x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
    }
    if (!n) return null;
    Object.assign(row, { pixels: n, maxChannelDelta: m, box: [x0, y0, x1 - x0 + 1, y1 - y0 + 1] });
  }
  const verdict = comparator(b, a, { maxDiffPixels: 0 });
  row.p0Comparator = verdict ? verdict.errorMessage.split('\n')[0] : 'match';
  const webkit = rel.startsWith('webkit');
  row.kind = row.size || verdict || webkit || row.maxChannelDelta > NOISE.maxChannelDelta || row.pixels > NOISE.pixels ? 'change' : 'noise';
  return row;
}
const result = { labels, noiseEnvelope: NOISE, screenshots: {} };
for (const rel of rels) {
  const steps = [];
  for (let i = 1; i < labels.length; i++) {
    const pa = file(labels[i - 1], rel), pb = file(labels[i], rel);
    if (!existsSync(pa) || !existsSync(pb)) { steps.push({ from: labels[i - 1], at: labels[i], missing: true }); continue; }
    const d = diff(readFileSync(pa), readFileSync(pb), rel);
    if (d) steps.push({ from: labels[i - 1], at: labels[i], ...d });
  }
  if (steps.length) result.screenshots[rel] = steps;
}
writeFileSync(out, JSON.stringify(result, null, 1) + '\n');
const changes = Object.entries(result.screenshots).flatMap(([rel, s]) => s.filter((x) => x.kind !== 'noise').map((x) => ({ rel, ...x })));
const byAt = {};
for (const c of changes) (byAt[c.at] ||= []).push(c.rel);
console.log(JSON.stringify({ screenshotsWithAnyDifference: Object.keys(result.screenshots).length, changes: changes.length, byCommit: Object.fromEntries(Object.entries(byAt).map(([k, v]) => [k, v.length])) }));
