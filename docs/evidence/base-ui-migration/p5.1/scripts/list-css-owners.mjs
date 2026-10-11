// Lists index.css use points with owners, replicating ownerGaps' css slot logic.
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';
const root = resolve(process.argv[2]);
const phase = process.argv[3];
const { scanText, loadInventory } = await import(pathToFileURL(resolve(root, 'src/web/scripts/audit-antd.mjs')).href);
const CSS_PATH = 'src/web/src/index.css';
const CSS_KINDS = ['antd-reference', 'ant-class'];
const { baseline, css, records } = loadInventory(resolve(root, 'docs/evidence/base-ui-migration'));
const baseFiles = new Map(baseline.files.map((f) => [f.path, f]));
const key = (hit) => `${hit.kind}\0${hit.text}`;
const slots = new Map();
const add = (hit, slot, count = 1) => slots.set(key(hit), [...(slots.get(key(hit)) ?? []), ...Array.from({ length: count }, () => ({ ...slot }))]);
for (const hit of baseFiles.get(CSS_PATH)?.hits.filter((i) => CSS_KINDS.includes(i.kind)) ?? []) add(hit, { owner: css.groups.find((g) => g.from <= hit.line && hit.line <= g.to)?.phase, from: 'P0.1' });
for (const record of records) for (const entry of record.css ?? []) {
  const slot = { owner: entry.owner, pending: entry.pending, from: record.name };
  if (entry.status === 'reassigned') for (const ex of slots.get(key(entry)) ?? []) Object.assign(ex, slot);
  else add(entry, slot, entry.count);
}
const file = scanText(CSS_PATH, readFileSync(resolve(root, CSS_PATH), 'utf8'));
const seen = new Map();
for (const hit of file.hits.filter((i) => CSS_KINDS.includes(i.kind))) {
  seen.set(key(hit), (seen.get(key(hit)) ?? -1) + 1);
  const e = slots.get(key(hit))?.[seen.get(key(hit))];
  const owner = e?.owner?.split('→').at(-1).trim() ?? 'UNOWNED';
  if (!phase || owner === phase) console.log(owner.padEnd(6), String(hit.line).padStart(6), hit.kind.padEnd(15), hit.text.slice(0, 150), '|', e?.from);
}
