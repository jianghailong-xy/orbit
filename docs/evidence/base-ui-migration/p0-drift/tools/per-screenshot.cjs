// Usage: node per-screenshot.cjs <tip snapshots dir> <out.json> <out.md>
// One row per P0 screenshot: the tip rendering (P0.2 tests, fixed data, P0.2 environment) against its
// P0.2 original — bytes, differing pixels, largest channel delta and the P0 comparator — with the
// attribution of every difference (attribution.json), the noise rule for unattributed Chromium bytes,
// and the layer the regression now compares it with (reference/registry.json). Fails on any
// difference that is neither attributed nor inside the measured noise envelope.
const { readFileSync, writeFileSync } = require('node:fs');
const { join, resolve } = require('node:path');
const repo = resolve(__dirname, '../../../../..');
const ev = join(repo, 'docs/evidence/base-ui-migration');
const { PNG } = require(join(repo, 'node_modules/playwright-core/lib/utilsBundle'));
const comparator = require(join(repo, 'node_modules/playwright-core/lib/coreBundle')).utils.getComparator('image/png');
const { createHash } = require('node:crypto');
const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');
const [tipDir, outJson, outMd] = process.argv.slice(2);

const groups = JSON.parse(readFileSync(join(ev, 'p0-drift/attribution/attribution.json')));
const registry = Object.fromEntries(JSON.parse(readFileSync(join(ev, 'p0-drift/reference/registry.json'))).screenshots.map((e) => [e.screenshot, e]));
const short = (sha) => sha.slice(0, 9);
const attributed = (g) => (g.class === 'a-main' ? g.commits.filter((c) => /^(main|product commit)/.test(c.role) && !/merge of origin\/main/.test(c.role)) : g.commits);
const rows = [];
for (const { path, sha256: p02 } of JSON.parse(readFileSync(join(ev, 'p0.2/baseline-run/summary.json'))).images) {
  const screenshot = path.replace('docs/evidence/base-ui-migration/p0.2/screenshots/', '');
  const [project, name] = screenshot.split('/');
  const original = readFileSync(join(repo, path)), tip = readFileSync(join(tipDir, screenshot));
  const row = { screenshot, project, name, p02, tip: sha256(tip), bytesEqual: original.equals(tip) };
  if (!row.bytesEqual) {
    const a = PNG.sync.read(original), b = PNG.sync.read(tip);
    let pixels = 0, delta = 0;
    for (let i = 0; i < a.data.length; i += 4) {
      let d = 0; for (let c = 0; c < 4; c++) d = Math.max(d, Math.abs(a.data[i + c] - b.data[i + c]));
      if (d) { pixels++; delta = Math.max(delta, d); }
    }
    const verdict = comparator(tip, original, { maxDiffPixels: 0 });
    Object.assign(row, { pixels, maxChannelDelta: delta, p0Comparator: verdict ? 'fails' : 'below threshold' });
  }
  const changes = groups.filter((g) => g.screenshots.includes(screenshot));
  row.attribution = changes.map((g) => ({ change: g.id, class: g.class, projectLine: short(g.projectLine.commit), commits: attributed(g).map((c) => short(c.commit)) }));
  if (!row.bytesEqual && !changes.length) {
    const noise = project.startsWith('chromium') && row.p0Comparator === 'below threshold' && row.maxChannelDelta <= 4 && row.pixels <= 200;
    if (!noise) throw new Error(`${screenshot}: unattributed difference outside the noise envelope`);
    row.attribution = [{ change: 'noise', class: 'chromium-noise' }];
  }
  const entry = registry[screenshot];
  row.expectation = entry ? { layer: 'p0-drift', sha256: entry.sha256, mainCommits: entry.mainCommits.map(short), generatedFrom: short(entry.generatedFrom.commit) } : { layer: 'p0.2', sha256: p02 };
  rows.push(row);
}
const differing = rows.filter((r) => !r.bytesEqual);
const tally = (pick) => differing.reduce((n, r) => ((n[pick(r)] = (n[pick(r)] ?? 0) + 1), n), {});
const summary = {
  total: rows.length, bytesEqual: rows.length - differing.length, bytesDiffer: differing.length,
  byAttribution: tally((r) => r.attribution.map((a) => a.change).join('+')),
  byComparator: tally((r) => r.p0Comparator),
  registeredAsMainDrift: rows.filter((r) => r.expectation.layer === 'p0-drift').length,
  registeredWithMigrationChange: rows.filter((r) => r.expectation.layer === 'p0-drift' && r.attribution.some((a) => a.class !== 'a-main')).map((r) => r.screenshot),
};
writeFileSync(outJson, JSON.stringify({ tipSnapshots: tipDir, summary, screenshots: rows }, null, 1) + '\n');
const cell = (r) => r.attribution.map((a) => (a.change === 'noise' ? 'Chromium 噪声' : `${a.change}（${a.class === 'a-main' ? 'a 类 main' : 'b 类迁移'}）${a.commits.join('、')}，项目线 ${a.projectLine}`)).join('；');
const md = ['| # | 截图 | tip 对 P0.2：像素 / 单通道差 / P0 比较器 | 归因（提交） | 回归现在对照 |', '| ---: | --- | --- | --- | --- |',
  ...differing.map((r, i) => `| ${i + 1} | ${r.screenshot} | ${r.pixels} / ${r.maxChannelDelta} / ${r.p0Comparator === 'fails' ? '不通过' : '低于阈值'} | ${cell(r)} | ${r.expectation.layer === 'p0-drift' ? `main 漂移参考（生成于 ${r.expectation.generatedFrom}）` : 'P0.2 原图'} |`)];
writeFileSync(outMd, md.join('\n') + '\n');
console.log(JSON.stringify(summary, null, 1));
