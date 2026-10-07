// Check a dated delta record against the audit it was built from, entry by entry.
//
//   node src/web/scripts/audit-antd.mjs --json > /tmp/antd-current.json
//   node docs/evidence/base-ui-migration/inventory-delta/verify-record.mjs /tmp/antd-current.json 2026-10-07.json
//
// 1. every file and index.css entry states the facts the audit has for it;
// 2. with the record, no use point is left without an owner;
// 3. without the record, the gaps are exactly the record's new and changed entries, and without its
//    reassignments exactly the reassigned ones -- so each entry is needed and none is missing;
// 4. the P0.1 baseline passes against the P0.1 inventory alone.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadInventory, ownerGaps } from '../../../../src/web/scripts/audit-antd.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const current = JSON.parse(readFileSync(resolve(process.argv[2]), 'utf8'));
const name = process.argv[3];
const inventory = loadInventory();
const record = inventory.records.find((item) => item.name === name);
assert(record, `no record ${name} in ${here}`);
assert.equal(record.scan.scopeHash, current.baseline.scopeHash, 'the audit scanned other sources than the record');
assert.deepEqual(record.scan.counts, current.counts);

const files = new Map(current.files.map((file) => [file.path, file]));
const symbols = (file) => [...new Set(file.imports.filter((item) => ['antd', 'react19-patch'].includes(item.family))
  .flatMap((item) => (item.bindings.length ? item.bindings.map((binding) => binding.imported) : [`${item.kind}:${item.module}`])))].sort();
const kinds = (file, wanted) => Object.fromEntries(Object.entries(file.hits.reduce((all, hit) => (wanted.includes(hit.kind)
  ? { ...all, [hit.kind]: (all[hit.kind] ?? 0) + 1 } : all), {})).sort());
const reported = ['antd-reference', 'ant-class', 'ant-selector', 'internal-ref', 'use-app', 'use-token', 'react19-patch',
  'provider', 'theme', 'imperative-confirm', 'imperative-feedback', 'ref-focus'];
for (const [path, entry] of Object.entries(record.files)) {
  const file = files.get(path);
  assert(file, `${path} is not in the audit`);
  assert.deepEqual(entry.antdImports, symbols(file), `${path}: antd imports`);
  assert.deepEqual(entry.hitKinds, kinds(file, reported), `${path}: hit kinds`);
  assert.equal(entry.category, file.category, `${path}: category`);
  assert(entry.owner || entry.pending, `${path}: neither owner nor pending`);
  assert(entry.owner ? entry.reason : entry.pending.question, `${path}: no reason`);
}
const css = files.get('src/web/src/index.css').hits;
for (const entry of record.css) {
  const at = css.filter((hit) => hit.kind === entry.kind && hit.text === entry.text).map((hit) => hit.line);
  assert(entry.lines.every((line) => at.includes(line)) && entry.lines.length === entry.count, `index.css: ${entry.text}`);
  assert(entry.owner ? entry.reason : entry.pending.question, `index.css: ${entry.text} has no reason`);
}

const point = (item) => (item.line ? `${item.path}:${item.line}` : item.path);
const gaps = (records) => ownerGaps(current, { ...inventory, records }).unowned.map(point).sort();
assert.deepEqual(gaps(inventory.records), [], 'use points without an owner');

const others = inventory.records.filter((item) => item !== record);
const strip = (statuses) => ({ ...record, files: Object.fromEntries(Object.entries(record.files).filter(([, entry]) => !statuses.includes(entry.status))),
  css: record.css.filter((entry) => !statuses.includes(entry.status)) });
const entries = (statuses) => [...Object.entries(record.files).filter(([, entry]) => statuses.includes(entry.status)).map(([path]) => path),
  ...record.css.filter((entry) => statuses.includes(entry.status)).flatMap((entry) => entry.lines.map((line) => `src/web/src/index.css:${line}`))].sort();
// A changed entry that only adds lines of kinds the file already had at P0.1 is listed for the
// reader; the check needs it only when it brings a new antd symbol or a new kind.
const grows = (entry) => entry.status !== 'changed' || (entry.added && (entry.added.antdImports.length > 0
  || Object.entries(entry.added.hitKinds).some(([kind, n]) => entry.hitKinds[kind] === n)));
const needed = entries(['new', 'changed']).filter((item) => !record.files[item] || grows(record.files[item]));
const withoutNew = gaps([...others, { ...strip(['new', 'changed', 'reassigned']), inactiveOwners: {} }]);
assert.deepEqual(withoutNew, needed, 'gaps without the record differ from its new/changed entries');
const withoutReassigned = gaps([...others, strip(['reassigned'])]);
assert.deepEqual(withoutReassigned, entries(['reassigned']), 'gaps without the reassignments differ from the reassigned entries');
assert.deepEqual(ownerGaps(inventory.baseline, { ...inventory, records: [] }).unowned, [], 'the P0.1 baseline has gaps against P0.1');

const pending = ownerGaps(current, inventory).pending.map(point).sort();
const asked = record.forCoordinator.flatMap((item) => [...item.files, ...item.cssLines.map((line) => `src/web/src/index.css:${line}`)]).sort();
assert.deepEqual(pending, asked, 'pending points differ from forCoordinator');
console.log(`Record ${name} verified: ${Object.keys(record.files).length} file entries and ${record.css.length} index.css entries match the audit; `
  + `0 unowned with it; ${withoutNew.length} gaps without it (= its new/changed), ${withoutReassigned.length} without its reassignments (= reassigned); `
  + `P0.1 baseline clean; ${pending.length} points awaiting the coordinator (${record.forCoordinator.length} questions).`);
