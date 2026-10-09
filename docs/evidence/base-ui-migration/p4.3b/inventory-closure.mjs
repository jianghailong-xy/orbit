// Close this batch's use points, from two runs of src/web/scripts/audit-antd.mjs --json.
//
// usage: node docs/evidence/base-ui-migration/p4.3b/inventory-closure.mjs BEFORE.json AFTER.json > inventory-closure.json
//
// BEFORE is the audit of the same-commit reference tree (the delivery with the business switch reverted),
// AFTER the audit of the delivery. Each use point is judged by the audit's own --check-owners rules
// (ownerGaps over the P0.1 inventory and the inventory-delta records), read from the tree this script runs
// in; this lists the points P4.3b owned before and after, the owner counts and unowned points on both sides,
// and for every file whose antd imports or hit kinds moved, what they were and are. Nothing under the P0.1
// baseline or inventory-delta is rewritten. (p4.2/inventory-closure.mjs, for owner P4.3b.)
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const { loadInventory, ownerGaps } = await import(`${root}src/web/scripts/audit-antd.mjs`);
const [before, after] = process.argv.slice(2, 4).map((path) => JSON.parse(readFileSync(path, 'utf8')));
const inventory = loadInventory();
const CSS = 'src/web/src/index.css';
const KINDS = ['antd-reference', 'ant-class'];
const OWNER = 'P4.3b';

/** The use points one owner holds, judged one at a time by ownerGaps. */
function pointsOf(report, owner) {
  const points = [];
  for (const file of report.files) {
    if (file.path === CSS) {
      const hits = file.hits.filter((hit) => KINDS.includes(hit.kind));
      for (let i = 0; i < hits.length; i++) {
        const counted = (n) => ownerGaps({ files: [{ ...file, hits: hits.slice(0, n) }] }, inventory).owners[owner] ?? 0;
        if (counted(i + 1) > counted(i)) points.push({ path: CSS, line: hits[i].line, kind: hits[i].kind, text: hits[i].text });
      }
    } else if (ownerGaps({ files: [file] }, inventory).owners[owner]) {
      points.push({ path: file.path, category: file.category });
    }
  }
  return points;
}

const summary = (file) => file && {
  antdImports: [...new Set(file.imports.filter((item) => item.family === 'antd').flatMap((item) => item.bindings.map((b) => b.imported)))].sort(),
  hitKinds: Object.fromEntries(Object.entries(file.hits.reduce((all, hit) => ({ ...all, [hit.kind]: (all[hit.kind] ?? 0) + 1 }), {})).sort()),
};
const side = (report) => {
  const gaps = ownerGaps(report, inventory);
  return { baseline: report.baseline, owners: gaps.owners, unowned: gaps.unowned, pending: gaps.pending, p43b: pointsOf(report, OWNER) };
};
const b = new Map(before.files.map((file) => [file.path, file]));
const a = new Map(after.files.map((file) => [file.path, file]));
const files = {};
for (const path of [...new Set([...b.keys(), ...a.keys()])].sort()) {
  const [sb, sa] = [summary(b.get(path)), summary(a.get(path))];
  if (JSON.stringify(sb) !== JSON.stringify(sa)) files[path] = { before: sb ?? null, after: sa ?? null };
}
const counts = Object.fromEntries(Object.keys(before.counts).filter((key) => key !== 'hitLines').map((key) => [key, [before.counts[key], after.counts[key]]]));
const hitLines = Object.fromEntries([...new Set([...Object.keys(before.counts.hitLines), ...Object.keys(after.counts.hitLines)])].sort()
  .map((key) => [key, [before.counts.hitLines[key] ?? 0, after.counts.hitLines[key] ?? 0]]));
console.log(JSON.stringify({ records: inventory.records.map((record) => record.name), before: side(before), after: side(after), counts, hitLines, files }, null, 1));
