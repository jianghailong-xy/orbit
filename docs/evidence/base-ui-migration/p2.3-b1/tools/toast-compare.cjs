// Usage: node toast-compare.cjs <labelA> <labelB> [out.json] [regex]
// For every target notification screenshot both runs have: the exact difference inside the
// notification box of run B's recorded state (every .toast card rect and the section rect, grown by
// 34 px for the 0 8px 22px shadow), and outside it.
const { readFileSync, existsSync, writeFileSync } = require('node:fs');
const { regions } = require('./regions.cjs');
const [A, B, out, only] = process.argv.slice(2);
const run = (l) => (l.startsWith('/') ? l : `/var/tmp/p23b1/runs/${l}`);
const statesB = JSON.parse(readFileSync(`${run(B)}/states.json`));
const statesA = existsSync(`${run(A)}/states.json`) ? JSON.parse(readFileSync(`${run(A)}/states.json`)) : {};
const rows = [];
for (const key of Object.keys(statesB).sort()) {
  if (only && !new RegExp(only).test(key)) continue;
  const a = `${run(A)}/snapshots/${key}`, b = `${run(B)}/snapshots/${key}`;
  if (!existsSync(a) || !existsSync(b)) continue;
  const rects = [statesB[key].dom.section?.rect, ...statesB[key].dom.cards.map((c) => c.rect), ...(statesA[key]?.dom.cards ?? []).map((c) => c.rect), statesA[key]?.dom.section?.rect].filter(Boolean);
  const x0 = Math.floor(Math.min(...rects.map((r) => r.x))) - 34, y0 = Math.floor(Math.min(...rects.map((r) => r.y))) - 34;
  const x1 = Math.ceil(Math.max(...rects.map((r) => r.right))) + 34, y1 = Math.ceil(Math.max(...rects.map((r) => r.bottom))) + 34;
  const r = regions(a, b, [Math.max(0, x0), Math.max(0, y0), x1 - Math.max(0, x0), y1 - Math.max(0, y0)]);
  rows.push({ screenshot: key, ...r, clusters: r.clusters.slice(0, 8) });
}
if (out) writeFileSync(out, JSON.stringify({ a: A, b: B, rows }, null, 1) + '\n');
for (const r of rows) console.log(`${r.screenshot.padEnd(46)} total ${String(r.pixels).padStart(6)} (max ${r.maxChannelDelta})  in toast box ${String(r.insideToastBox).padStart(5)} (max ${r.insideToastBoxMax})  outside ${r.outsideToastBox}`);
