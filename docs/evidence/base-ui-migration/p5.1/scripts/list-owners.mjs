// Lists every use point with its owner, using audit-antd.mjs's own rules.
// Usage: node list-owners.mjs <repo-root> [phase]
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFileSync, readdirSync, statSync } from 'node:fs';
const root = resolve(process.argv[2]);
const phase = process.argv[3];
const mod = await import(pathToFileURL(resolve(root, 'src/web/scripts/audit-antd.mjs')).href);
const { scanText, loadInventory, ownerGaps } = mod;
function sourcePaths(d) { return readdirSync(d, { withFileTypes: true }).flatMap((e) => { const p = resolve(d, e.name); return e.isDirectory() ? sourcePaths(p) : [p.slice(root.length + 1)]; }); }
const paths = [...sourcePaths(resolve(root, 'src/web/src')), 'src/web/package.json', 'package-lock.json'].sort();
const files = paths.map((p) => scanText(p, readFileSync(resolve(root, p), 'utf8')));
const inv = loadInventory(resolve(root, 'docs/evidence/base-ui-migration'));
// Re-run ownerGaps per point by monkeypatching judge via a wrapper: replicate logic by calling ownerGaps on single-file reports.
const out = [];
for (const file of files) {
  if (file.path === 'src/web/src/index.css') continue;
  const r = ownerGaps({ files: [file] }, inv);
  const owner = Object.keys(r.owners)[0] ?? (r.unowned.length ? 'UNOWNED' : r.pending.length ? 'PENDING' : null);
  if (owner) out.push({ path: file.path, owner, category: file.category, antdImports: file.imports.filter((i) => i.family === 'antd').flatMap((i) => i.bindings.map((b) => b.imported)), kinds: [...new Set(file.hits.map((h) => h.kind))] });
}
// index.css point-by-point
const css = files.find((f) => f.path === 'src/web/src/index.css');
const cssOwners = [];
{
  // replicate per-hit judging
  const r = ownerGaps({ files: [css] }, inv);
  // ownerGaps doesn't return per-hit owners; recompute with a patched copy
}
for (const o of out) if (!phase || o.owner === phase) console.log(o.owner.padEnd(8), o.category.padEnd(10), o.path, JSON.stringify(o.antdImports), o.kinds.join(','));
