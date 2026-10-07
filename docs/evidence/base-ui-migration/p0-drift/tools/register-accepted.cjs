#!/usr/bin/env node
// Registers accepted migration differences (README「已接受的迁移差异」). Run it in the worktree whose
// registry you are writing, after the batch landed and the coordinator CONFIRMed its evidence:
//
//   node docs/evidence/base-ui-migration/p0-drift/tools/register-accepted.cjs \
//     --task <batch task id> --revision <evidence revision> --digest <evidenceDigest> --document <batch README under docs/evidence/base-ui-migration/> \
//     --before-commit <sha> --before-dir <snapshots> --before-env <environment.json> \
//     --after-commit <sha> --after-dir <snapshots> --after-env <environment.json> \
//     --difference '<what differs and why it was accepted>' <project>/<name>.png ...
//
// The before/after directories hold the batch's same-commit comparison: the P0 tests run with
// --update-snapshots=all into a scratch directory at the batch's start and at its delivery. For each
// screenshot it refuses unless both runs used the P0.2 environment, the before original matches what
// the regression expects now under the P0 comparator, and the after original does not match it. It then
// copies both originals into accepted/ and writes the entry (an earlier entry for the same screenshot
// moves into `previous`). The P0 globalSetup re-checks every entry on each run.
const { createHash } = require('node:crypto');
const { copyFileSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const { dirname, join, resolve } = require('node:path');

const repo = resolve(__dirname, '../../../../..');
const evidence = join(repo, 'docs/evidence/base-ui-migration');
const comparator = require(join(repo, 'node_modules/playwright-core/lib/coreBundle')).utils.getComparator('image/png');
const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const json = (path) => JSON.parse(readFileSync(path));

const args = process.argv.slice(2), opt = {}, screenshots = [];
for (let i = 0; i < args.length; i++) args[i].startsWith('--') ? (opt[args[i].slice(2)] = args[++i]) : screenshots.push(args[i]);
const need = ['task', 'revision', 'digest', 'document', 'before-commit', 'before-dir', 'before-env', 'after-commit', 'after-dir', 'after-env', 'difference'];
const missing = need.filter((key) => !opt[key]);
if (missing.length || !screenshots.length) throw new Error(`missing ${missing.map((key) => `--${key}`).join(' ') || 'screenshots'}`);

const environment = sha256(join(evidence, 'p0.2/environment.json'));
for (const side of ['before', 'after']) if (sha256(opt[`${side}-env`]) !== environment) throw new Error(`the ${side} run was not in the P0.2 environment`);
const lower = {};
for (const { path, sha256: recorded } of json(join(evidence, 'p0.2/baseline-run/summary.json')).images) {
  const screenshot = path.replace('docs/evidence/base-ui-migration/p0.2/screenshots/', '');
  lower[screenshot] = { layer: 'p0.2', file: join(evidence, 'p0.2/screenshots', screenshot), sha256: recorded };
}
for (const { screenshot, sha256: recorded } of json(join(evidence, 'p0-drift/reference/registry.json')).screenshots) {
  lower[screenshot] = { layer: 'p0-drift', file: join(evidence, 'p0-drift/reference/screenshots', screenshot), sha256: recorded };
}
const registryPath = join(evidence, 'p0-drift/accepted/registry.json');
const registry = json(registryPath);
const decision = { taskId: opt.task, evidenceRevision: Number(opt.revision), evidenceDigest: opt.digest, verdict: 'CONFIRM', document: opt.document };

for (const screenshot of screenshots) {
  const below = lower[screenshot];
  if (!below) throw new Error(`${screenshot} is not a P0 screenshot`);
  const index = registry.screenshots.findIndex((entry) => entry.screenshot === screenshot);
  const existing = registry.screenshots[index];
  // What the regression compares against now: a still-valid accepted entry, else the layer below it.
  const current = existing?.replaces.sha256 === below.sha256 ? join(evidence, 'p0-drift/accepted/screenshots', screenshot) : below.file;
  const before = join(opt['before-dir'], screenshot), after = join(opt['after-dir'], screenshot);
  const differs = (a, b) => comparator(readFileSync(a), readFileSync(b), { maxDiffPixels: 0 });
  if (differs(before, current)) throw new Error(`${screenshot}: the before original does not reproduce the current expectation; attribute that difference first`);
  if (!differs(after, before)) throw new Error(`${screenshot}: the after original matches the before original; there is nothing to accept`);
  const entry = {
    screenshot, sha256: sha256(after), replaces: { layer: below.layer, sha256: below.sha256 }, decision, difference: opt.difference,
    sameCommit: { before: { commit: opt['before-commit'], sha256: sha256(before) }, after: { commit: opt['after-commit'], sha256: sha256(after) }, environment },
    ...(existing ? { previous: [...(existing.previous ?? []), { sha256: existing.sha256, decision: existing.decision, difference: existing.difference, sameCommit: existing.sameCommit }] } : {}),
  };
  for (const [dir, file] of [['before', before], ['screenshots', after]]) {
    mkdirSync(dirname(join(evidence, 'p0-drift/accepted', dir, screenshot)), { recursive: true });
    copyFileSync(file, join(evidence, 'p0-drift/accepted', dir, screenshot));
  }
  if (existing) registry.screenshots[index] = entry;
  else registry.screenshots.push(entry);
}
registry.screenshots.sort((a, b) => a.screenshot.localeCompare(b.screenshot));
writeFileSync(registryPath, JSON.stringify(registry, null, 2) + '\n');
console.log(`${screenshots.length} accepted migration differences registered; ${registry.screenshots.length} in the registry`);
