// Verify the P0.1 inventory's coverage and reproduce its source snapshot.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const evidence = resolve(root, 'docs/evidence/base-ui-migration');
const read = (name) => JSON.parse(readFileSync(resolve(evidence, name), 'utf8'));
const baseline = read('audit-baseline.json');
const ownership = read('ownership.json');
const css = read('css-ownership.json');
const tests = readFileSync(resolve(evidence, 'routes-and-tests.md'), 'utf8');
const contracts = readFileSync(resolve(evidence, 'component-contracts.md'), 'utf8');
assert.equal(ownership.baselineCommit, baseline.baseline.commit);
assert.equal(css.baselineCommit, baseline.baseline.commit);

const source = baseline.files.filter((file) => file.category === 'production');
const dependencyKinds = ['antd-reference', 'ant-class', 'internal-ref', 'use-app', 'use-token'];
const required = source.filter((file) => /\/src\/(?:pages|components)\//.test(file.path)
  || file.imports.length || file.hits.some((hit) => dependencyKinds.includes(hit.kind)));
for (const file of required) {
  const owner = ownership.files[file.path];
  assert(owner?.phase && owner.replacement && owner.preserve, `Missing ownership: ${file.path}`);
  if (owner.phase === 'KEEP') assert(owner.reviewPhase, `Missing review phase: ${file.path}`);
}
for (const path of Object.keys(ownership.files)) assert(source.some((file) => file.path === path), `Stale owner: ${path}`);
const symbols = new Set(source.flatMap((file) => file.imports.filter((item) => item.family === 'antd').flatMap((item) => item.bindings.map((binding) => binding.imported))));
for (const symbol of symbols) assert(contracts.includes(`| ${symbol} |`), `Missing replacement contract: ${symbol}`);

const expectedTests = baseline.files.filter((file) => file.category === 'test').map((file) => file.path.slice('src/web/src/'.length)).sort();
const listedTests = [...tests.matchAll(/^\| `([^`]+\.(?:test|spec)\.[^`]+)` \|/gm)].map((match) => match[1]).sort();
assert.deepEqual(listedTests, expectedTests, 'Test inventory differs from baseline');
const cssHits = baseline.files.find((file) => file.path === css.path).hits.filter((hit) => ['antd-reference', 'ant-class'].includes(hit.kind));
for (const hit of cssHits) {
  const groups = css.groups.filter((group) => group.from <= hit.line && hit.line <= group.to);
  assert.equal(groups.length, 1, `CSS line ${hit.line} needs exactly one owner`);
  assert(groups[0].phase && groups[0].replacement && groups[0].preserve);
}

// The delivering commit changes HEAD, but must not change the audited source snapshot.
// Pass a fresh audit JSON to establish reproducibility; omit it for inventory coverage only.
if (process.argv[2]) {
  const current = JSON.parse(readFileSync(resolve(process.argv[2]), 'utf8'));
  const normalized = { ...current, baseline: { ...current.baseline, commit: baseline.baseline.commit } };
  assert.deepEqual(normalized, baseline, 'Source or scanner output changed; inspect the diff, do not overwrite the baseline');
}
console.log(`Inventory coverage passed: ${Object.keys(ownership.files).length} source owners, ${symbols.size} import contracts, ${expectedTests.length} tests, ${cssHits.length} CSS hits on ${new Set(cssHits.map((hit) => hit.line)).size} lines; source reproduction ${process.argv[2] ? 'passed' : 'not requested'}.`);
