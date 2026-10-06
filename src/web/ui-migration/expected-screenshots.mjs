import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The screenshots the P0 regression compares against: every P0.2 original, except those registered
// in the main drift reference (docs/evidence/base-ui-migration/p0-drift/README.md), whose page a
// main product change has moved since P0.2. Both layers are checked against their recorded SHA-256
// and copied here, so no run, --update-snapshots included, writes to either of them.
const evidence = fileURLToPath(new URL('../../../docs/evidence/base-ui-migration/', import.meta.url));
export const expectedScreenshots = fileURLToPath(new URL('../.ui-migration-results/expected-screenshots/', import.meta.url));

const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const commit = /^[0-9a-f]{40}$/;

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
  const layer = join(evidence, 'p0-drift/reference/screenshots');
  const stray = existsSync(layer) ? readdirSync(layer, { recursive: true }).filter((file) => file.endsWith('.png') && !registered.has(file)) : [];
  if (stray.length) throw new Error(`Unregistered main drift reference screenshots: ${stray.join(', ')}`);
  for (const [screenshot, { path }] of Object.entries(sources)) {
    mkdirSync(dirname(join(expectedScreenshots, screenshot)), { recursive: true });
    copyFileSync(join(evidence, path), join(expectedScreenshots, screenshot));
  }
  writeFileSync(join(expectedScreenshots, 'sources.json'), JSON.stringify(sources, null, 2) + '\n');
  console.log(`P0 expected screenshots: ${Object.keys(sources).length - registered.size} P0.2 originals, ${registered.size} main drift references.`);
}
