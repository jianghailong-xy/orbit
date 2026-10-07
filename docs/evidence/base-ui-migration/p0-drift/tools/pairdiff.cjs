// Usage: node pairdiff.cjs <labelA> <labelB> [regex]  -> JSON list of screenshots that changed
// (same noise-aware classification as changepoints.cjs) between two runs, over files both have.
const { readFileSync, existsSync, readdirSync } = require('node:fs');
const W = '/root/.orbit/worktrees/e65f238b-4789-5587-b24a-cf2d708322d1/';
const { PNG } = require(W + 'node_modules/playwright-core/lib/utilsBundle');
const comparator = require(W + 'node_modules/playwright-core/lib/coreBundle').utils.getComparator('image/png');
const [a, b, only] = process.argv.slice(2);
const dir = (l) => `/var/tmp/p0drift/runs/${l}/snapshots`;
const re = only ? new RegExp(only) : null;
const out = [];
for (const p of readdirSync(dir(a))) for (const f of readdirSync(`${dir(a)}/${p}`)) {
  const rel = `${p}/${f}`;
  if (re && !re.test(rel)) continue;
  if (!existsSync(`${dir(b)}/${rel}`)) continue;
  const x = readFileSync(`${dir(a)}/${rel}`), y = readFileSync(`${dir(b)}/${rel}`);
  if (x.equals(y)) continue;
  const xi = PNG.sync.read(x), yi = PNG.sync.read(y);
  let n = 0, m = 0;
  if (xi.width === yi.width && xi.height === yi.height) for (let i = 0; i < xi.data.length; i += 4) {
    let d = 0; for (let c = 0; c < 4; c++) d = Math.max(d, Math.abs(xi.data[i + c] - yi.data[i + c]));
    if (d) { n++; m = Math.max(m, d); }
  } else n = Infinity;
  const verdict = comparator(y, x, { maxDiffPixels: 0 });
  if (verdict || p.startsWith('webkit') || m > 4 || n > 200) out.push(rel);
}
console.log(JSON.stringify(out));
