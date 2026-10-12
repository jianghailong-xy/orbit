// Check a dated delta record against the audit it was built from, entry by entry.
//
//   node src/web/scripts/audit-antd.mjs --json > /tmp/antd-current.json
//   node docs/evidence/base-ui-migration/inventory-delta/verify-record.mjs /tmp/antd-current.json 2026-10-07.json
//
// 1. every file and index.css entry states the facts the audit has for it;
// 2. with every record read, no use point is left without an owner;
// 3. read after the records that sort before it, removing the record's new and changed entries turns
//    exactly the points they need into gaps, and removing its reassignments changes who exactly the
//    points they cover belong to (an owner, or pending / unowned; since 2026-10-08b.json, which moves
//    points between two owners that are both still active, the owner itself counts) -- so each entry is
//    needed and none is missing;
// 4. the points it leaves pending are exactly its forCoordinator questions;
// 5. the P0.1 baseline passes against the P0.1 inventory alone.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadInventory, ownerGaps } from '../../../../src/web/scripts/audit-antd.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const current = JSON.parse(readFileSync(resolve(process.argv[2]), 'utf8'));
const name = process.argv[3];
const inventory = loadInventory();
const index = inventory.records.findIndex((item) => item.name === name);
assert(index >= 0, `no record ${name} in ${here}`);
const record = inventory.records[index];
const earlier = inventory.records.slice(0, index);
if (record.amends) assert(earlier.some((item) => item.name === record.amends), `${name} must sort after ${record.amends}, which it amends`);
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
// The standing of every point that is not owned: 'unowned' or 'pending'.
const standing = (records) => {
  const result = ownerGaps(current, { ...inventory, records });
  return new Map([...result.unowned.map((item) => [point(item), 'unowned']), ...result.pending.map((item) => [point(item), 'pending'])]);
};
const final = standing(inventory.records);
assert.deepEqual([...final].filter(([, state]) => state === 'unowned').map(([key]) => key), [], 'use points without an owner');

const base = standing([...earlier, record]);
const strip = (statuses) => ({ ...record, files: Object.fromEntries(Object.entries(record.files).filter(([, entry]) => !statuses.includes(entry.status))),
  css: record.css.filter((entry) => !statuses.includes(entry.status)) });
const moved = (statuses) => {
  const after = standing([...earlier, strip(statuses)]);
  return [...new Set([...base.keys(), ...after.keys()])].filter((key) => base.get(key) !== after.get(key)).sort();
};
// Points are files and index.css lines; a line with two kinds (antd-reference and ant-class) is one point.
const entries = (statuses) => [...new Set([...Object.entries(record.files).filter(([, entry]) => statuses.includes(entry.status)).map(([path]) => path),
  ...record.css.filter((entry) => statuses.includes(entry.status)).flatMap((entry) => entry.lines.map((line) => `src/web/src/index.css:${line}`))])].sort();
// A changed entry that only adds lines of kinds the file already had at P0.1 is listed for the
// reader; the check needs it only when it brings a new antd symbol or a new kind.
const grows = (entry) => entry.status !== 'changed' || (entry.added && (entry.added.antdImports.length > 0
  || Object.entries(entry.added.hitKinds).some(([kind, n]) => entry.hitKinds[kind] === n)));
const needed = entries(['new', 'changed']).filter((item) => !record.files[item] || grows(record.files[item]));
const withoutNew = moved(['new', 'changed']);
assert.deepEqual(withoutNew, needed, 'points that need the new/changed entries differ from them');
// Who each point belongs to: its owner, or 'pending' / 'unowned'. A file is judged on its own; an
// index.css hit by what it adds to the hits of its kind and text before it (ownerGaps hands them their
// owners in that order), and a line with two kinds is one point carrying both answers.
const CSS = 'src/web/src/index.css';
const assignment = (records) => {
  const judged = (report) => ownerGaps(report, { ...inventory, records });
  const result = new Map();
  for (const file of current.files) {
    if (file.path === CSS) continue;
    const gaps = judged({ files: [file] });
    const state = gaps.pending.length ? 'pending' : gaps.unowned.length ? 'unowned' : Object.keys(gaps.owners)[0];
    if (state) result.set(file.path, state);
  }
  const css = files.get(CSS);
  const byKey = new Map();
  for (const hit of css.hits.filter((item) => ['antd-reference', 'ant-class'].includes(item.kind))) {
    byKey.set(`${hit.kind}\0${hit.text}`, [...(byKey.get(`${hit.kind}\0${hit.text}`) ?? []), hit]);
  }
  const lines = new Map();
  for (const hits of byKey.values()) {
    const tally = (n) => judged({ files: [{ ...css, hits: hits.slice(0, n) }] });
    for (let n = 1; n <= hits.length; n++) {
      const [before, after] = [tally(n - 1), tally(n)];
      const owner = Object.keys(after.owners).find((key) => after.owners[key] > (before.owners[key] ?? 0));
      const state = owner ?? (after.pending.length > before.pending.length ? 'pending' : 'unowned');
      lines.set(hits[n - 1].line, [...(lines.get(hits[n - 1].line) ?? []), `${hits[n - 1].kind}:${state}`]);
    }
  }
  for (const [line, states] of lines) result.set(`${CSS}:${line}`, states.sort().join(' '));
  return result;
};
const assigned = assignment([...earlier, record]);
const reassigned = (() => {
  const after = assignment([...earlier, strip(['reassigned'])]);
  return [...new Set([...assigned.keys(), ...after.keys()])].filter((key) => assigned.get(key) !== after.get(key)).sort();
})();
const withoutReassigned = moved(['reassigned']);
assert.deepEqual(withoutReassigned.filter((key) => !reassigned.includes(key)), [], 'a standing changes without the reassignments where no owner does');
assert.deepEqual(reassigned, entries(['reassigned']), 'points that change without the reassignments differ from them');
assert.deepEqual(ownerGaps(inventory.baseline, { ...inventory, records: [] }).unowned, [], 'the P0.1 baseline has gaps against P0.1');

const pending = [...base].filter(([, state]) => state === 'pending').map(([key]) => key).sort();
const asked = [...new Set((record.forCoordinator ?? []).flatMap((item) => [...item.files, ...item.cssLines.map((line) => `src/web/src/index.css:${line}`)]))].sort();
assert.deepEqual(pending, asked, 'pending points differ from forCoordinator');
const left = [...final.values()].filter((state) => state === 'pending').length;
console.log(`Record ${name} verified: ${Object.keys(record.files).length} file entries and ${record.css.length} index.css entries match the audit; `
  + `read after ${earlier.length} earlier record(s), ${withoutNew.length} points need its new/changed entries and ${reassigned.length} change owner without its reassignments; `
  + `it leaves ${pending.length} points pending (${(record.forCoordinator ?? []).length} questions); with all ${inventory.records.length} records: 0 unowned, ${left} pending; P0.1 baseline clean.`);
