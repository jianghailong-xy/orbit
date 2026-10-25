// List use points by owner (wraps audit-antd.mjs ownerGaps logic, reporting paths per owner).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const root = process.argv[2];
const mod = await import(resolve(root, 'src/web/scripts/audit-antd.mjs'));
const report = JSON.parse(readFileSync(process.argv[3], 'utf8'));
const inv = mod.loadInventory(resolve(root, 'docs/evidence/base-ui-migration'));
// monkeypatch: re-run ownerGaps but capture judge points per owner by diffing counts per file
const want = process.argv[4] ?? 'P5.2';
const out = [];
for (const file of report.files) {
  const single = { ...report, files: [file] };
  const res = mod.ownerGaps(single, inv);
  if (res.owners[want]) out.push(`${file.path}  x${res.owners[want]}`);
}
console.log(out.join('\n'));
