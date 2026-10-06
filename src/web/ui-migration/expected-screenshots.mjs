import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The screenshots the P0 regression compares against: every P0.2 original, except those registered
// in the main drift reference (docs/evidence/base-ui-migration/p0-drift/README.md), whose page a
// main product change has moved since P0.2, and those registered as an accepted migration
// difference, which the coordinator confirmed in a migration batch's evidence. Every layer is
// checked against its recorded SHA-256 and copied here, so no run, --update-snapshots included,
// writes to any of them.
const evidence = fileURLToPath(new URL('../../../docs/evidence/base-ui-migration/', import.meta.url));
export const expectedScreenshots = fileURLToPath(new URL('../.ui-migration-results/expected-screenshots/', import.meta.url));

const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const commit = /^[0-9a-f]{40}$/;
const pngs = (dir) => (existsSync(dir) ? readdirSync(dir, { recursive: true }).filter((file) => file.endsWith('.png')) : []);

export default function assembleExpectedScreenshots() {
  const sources = {};
  for (const { path, sha256: recorded } of JSON.parse(readFileSync(join(evidence, 'p0.2/baseline-run/summary.json'))).images) {
    const screenshot = path.replace('docs/evidence/base-ui-migration/p0.2/screenshots/', '');
    if (sha256(join(evidence, '../../..', path)) !== recorded) throw new Error(`P0.2 original ${screenshot} no longer matches its recorded SHA-256; P0.2 screenshots are never updated.`);
    sources[screenshot] = { layer: 'p0.2', path: `p0.2/screenshots/${screenshot}`, sha256: recorded };
  }
  const registry = JSON.parse(readFileSync(join(evidence, 'p0-drift/reference/registry.json')));
  const environment = sha256(join(evidence, 'p0.2/environment.json'));
  const registered = new Set();
  for (const entry of registry.screenshots) {
    const { screenshot, sha256: recorded, p0Baseline, mainCommits, generatedFrom } = entry;
    const where = `main drift reference ${screenshot}`;
    if (sources[screenshot]?.layer !== 'p0.2') throw new Error(`${where}: only a P0.2 screenshot can be registered, once.`);
    if (p0Baseline !== sources[screenshot].sha256) throw new Error(`${where}: p0Baseline is not the P0.2 original it replaces.`);
    if (!mainCommits?.length || !mainCommits.every((sha) => commit.test(sha))) throw new Error(`${where}: name the main commits it is attributed to.`);
    if (generatedFrom?.commit !== mainCommits.at(-1) || generatedFrom.environment !== environment) {
      throw new Error(`${where}: generate it on the tree of its last main commit, in the P0.2 environment.`);
    }
    const path = `p0-drift/reference/screenshots/${screenshot}`;
    if (sha256(join(evidence, path)) !== recorded) throw new Error(`${where} no longer matches its registered SHA-256.`);
    sources[screenshot] = { layer: 'p0-drift', path, sha256: recorded, mainCommits };
    registered.add(screenshot);
  }
  const stray = pngs(join(evidence, 'p0-drift/reference/screenshots')).filter((file) => !registered.has(file));
  if (stray.length) throw new Error(`Unregistered main drift reference screenshots: ${stray.join(', ')}`);
  // Accepted migration differences come last: each names the expectation it replaces (the P0.2
  // original or its main drift reference), so a later change to that expectation leaves the entry
  // stale until it is registered again.
  const accepted = new Set();
  for (const entry of JSON.parse(readFileSync(join(evidence, 'p0-drift/accepted/registry.json'))).screenshots) {
    const { screenshot, sha256: recorded, replaces, decision, difference, sameCommit } = entry;
    const where = `accepted migration difference ${screenshot}`;
    const current = sources[screenshot];
    if (!current || accepted.has(screenshot)) throw new Error(`${where}: only a P0 screenshot can be registered, once.`);
    if (replaces?.layer !== current.layer || replaces.sha256 !== current.sha256) {
      throw new Error(`${where}: it replaces ${replaces?.layer} ${replaces?.sha256}, but the current expectation is ${current.layer} ${current.sha256}; register it again.`);
    }
    if (decision?.verdict !== 'CONFIRM' || !/^[0-9A-Za-z]{20,24}$/.test(decision.taskId ?? '') || !Number.isInteger(decision.evidenceRevision)
      || decision.evidenceRevision < 1 || !/^[0-9a-f]{64}$/.test(decision.evidenceDigest ?? '') || !decision.document || !existsSync(join(evidence, decision.document))) {
      throw new Error(`${where}: cite the coordinator's CONFIRM decision on the batch's evidence (task id, evidence revision and digest, document).`);
    }
    if (!difference?.trim()) throw new Error(`${where}: describe the accepted difference.`);
    const { before, after, environment: ranIn } = sameCommit ?? {};
    if (!commit.test(before?.commit ?? '') || !commit.test(after?.commit ?? '') || ranIn !== environment) {
      throw new Error(`${where}: name the before and after commits of its same-commit comparison, run in the P0.2 environment.`);
    }
    if (after.sha256 !== recorded || before.sha256 === recorded) throw new Error(`${where}: register the after original of a comparison whose before original differs.`);
    const path = `p0-drift/accepted/screenshots/${screenshot}`;
    if (sha256(join(evidence, path)) !== recorded || sha256(join(evidence, `p0-drift/accepted/before/${screenshot}`)) !== before.sha256) {
      throw new Error(`${where}: its same-commit originals no longer match their registered SHA-256.`);
    }
    sources[screenshot] = { layer: 'accepted', path, sha256: recorded, replaces, decision };
    accepted.add(screenshot);
  }
  const acceptedStray = ['screenshots', 'before'].flatMap((dir) => pngs(join(evidence, 'p0-drift/accepted', dir)).filter((file) => !accepted.has(file)));
  if (acceptedStray.length) throw new Error(`Unregistered accepted migration difference screenshots: ${acceptedStray.join(', ')}`);
  for (const [screenshot, { path }] of Object.entries(sources)) {
    mkdirSync(dirname(join(expectedScreenshots, screenshot)), { recursive: true });
    copyFileSync(join(evidence, path), join(expectedScreenshots, screenshot));
  }
  writeFileSync(join(expectedScreenshots, 'sources.json'), JSON.stringify(sources, null, 2) + '\n');
  const count = (layer) => Object.values(sources).filter((source) => source.layer === layer).length;
  console.log(`P0 expected screenshots: ${count('p0.2')} P0.2 originals, ${count('p0-drift')} main drift references, ${count('accepted')} accepted migration differences.`);
}
