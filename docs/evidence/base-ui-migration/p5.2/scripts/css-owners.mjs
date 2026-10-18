// List index.css use points with their owner (mirrors ownerGaps CSS slot matching).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const root = process.argv[2];
const mod = await import(resolve(root, 'src/web/scripts/audit-antd.mjs'));
const report = JSON.parse(readFileSync(process.argv[3], 'utf8'));
const inv = mod.loadInventory(resolve(root, 'docs/evidence/base-ui-migration'));
const want = process.argv[4];
const css = report.files.find((f) => f.path === 'src/web/src/index.css');
const KINDS = ['antd-reference', 'ant-class'];
for (const hit of css.hits.filter((h) => KINDS.includes(h.kind))) {
  // Evaluate each CSS hit alone: count with all earlier identical hits kept, to respect slot order
  const prior = css.hits.filter((h) => KINDS.includes(h.kind) && h.kind === hit.kind && h.text === hit.text && h.line <= hit.line);
  const res = mod.ownerGaps({ ...report, files: [{ ...css, hits: prior }] }, inv);
  const before = mod.ownerGaps({ ...report, files: [{ ...css, hits: prior.slice(0, -1) }] }, inv);
  const owner = Object.keys(res.owners).find((k) => (res.owners[k] ?? 0) !== (before.owners[k] ?? 0)) ?? (res.unowned.length > before.unowned.length ? 'UNOWNED' : '?');
  if (!want || owner === want) console.log(`${owner}\t${hit.line}\t${hit.kind}\t${hit.text.slice(0, 150)}`);
}
