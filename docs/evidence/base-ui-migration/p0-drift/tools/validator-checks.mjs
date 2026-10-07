// Negative controls for the registration checks in src/web/ui-migration/expected-screenshots.mjs:
// copies the module and the p0-drift layers into a scratch tree (P0.2 is linked read-only), registers
// two valid accepted migration differences (one on a P0.2 original, one stacked on a main drift
// reference), and then breaks one rule per case. Every broken case must stop the P0 globalSetup with
// the named rule; the valid case must assemble with the two entries on the accepted layer.
// Usage: node validator-checks.mjs <worktree> <scratch dir>   (prints JSON, exits 1 on any miss)
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [worktree, scratch] = process.argv.slice(2);
const ev = (root) => join(root, 'docs/evidence/base-ui-migration');
const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
rmSync(scratch, { recursive: true, force: true });
mkdirSync(join(scratch, 'src/web/ui-migration'), { recursive: true });
cpSync(join(worktree, 'src/web/ui-migration/expected-screenshots.mjs'), join(scratch, 'src/web/ui-migration/expected-screenshots.mjs'));
mkdirSync(ev(scratch), { recursive: true });
symlinkSync(join(ev(worktree), 'p0.2'), join(ev(scratch), 'p0.2'));
const drift = join(ev(scratch), 'p0-drift');
const pristine = join(scratch, 'pristine-p0-drift');
cpSync(join(ev(worktree), 'p0-drift/reference'), join(pristine, 'reference'), { recursive: true });
cpSync(join(ev(worktree), 'p0-drift/accepted'), join(pristine, 'accepted'), { recursive: true });
writeFileSync(join(pristine, 'decision.md'), 'Scratch stand-in for a batch README that a coordinator confirmed.\n');
const { default: assemble } = await import(pathToFileURL(join(scratch, 'src/web/ui-migration/expected-screenshots.mjs')));

const environment = sha256(join(ev(worktree), 'p0.2/environment.json'));
const p02 = Object.fromEntries(JSON.parse(readFileSync(join(ev(worktree), 'p0.2/baseline-run/summary.json'))).images
  .map(({ path, sha256: hash }) => [path.replace('docs/evidence/base-ui-migration/p0.2/screenshots/', ''), hash]));
const mainDrift = Object.fromEntries(JSON.parse(readFileSync(join(ev(worktree), 'p0-drift/reference/registry.json'))).screenshots
  .map(({ screenshot, sha256: hash }) => [screenshot, hash]));
// Stand-in originals: any two different PNGs (the checks hash files, they do not decode them).
const onP02 = 'chromium-light-phone/project-graph-fullscreen.png', onDrift = 'chromium-light-desktop/project-graph-fullscreen.png';
const files = {
  [onP02]: { before: join(ev(worktree), 'p0.2/screenshots', onP02), after: join(ev(worktree), 'p0.2/screenshots/chromium-light-phone/project-graph.png') },
  [onDrift]: { before: join(ev(worktree), 'p0-drift/reference/screenshots', onDrift), after: join(ev(worktree), 'p0-drift/reference/screenshots/chromium-light-desktop/project-graph.png') },
};
const entry = (screenshot, replaces) => ({
  screenshot, sha256: sha256(files[screenshot].after), replaces,
  decision: { taskId: 'SCRATCHnotAdecision00', evidenceRevision: 1, evidenceDigest: 'f'.repeat(64), verdict: 'CONFIRM', document: 'p0-drift/decision.md' },
  difference: 'scratch stand-in difference',
  sameCommit: { before: { commit: 'a'.repeat(40), sha256: sha256(files[screenshot].before) }, after: { commit: 'b'.repeat(40), sha256: sha256(files[screenshot].after) }, environment },
});
const valid = () => [entry(onP02, { layer: 'p0.2', sha256: p02[onP02] }), entry(onDrift, { layer: 'p0-drift', sha256: mainDrift[onDrift] })];

function attempt(entries, mutateFiles = () => {}) {
  rmSync(drift, { recursive: true, force: true });
  cpSync(pristine, drift, { recursive: true });
  for (const e of entries) for (const [dir, side] of [['before', 'before'], ['screenshots', 'after']]) {
    const file = files[e.screenshot]?.[side];
    if (!file) continue;
    mkdirSync(dirname(join(drift, 'accepted', dir, e.screenshot)), { recursive: true });
    cpSync(file, join(drift, 'accepted', dir, e.screenshot));
  }
  const registry = JSON.parse(readFileSync(join(drift, 'accepted/registry.json')));
  writeFileSync(join(drift, 'accepted/registry.json'), JSON.stringify({ ...registry, screenshots: entries }, null, 2));
  mutateFiles();
  const log = console.log, said = [];
  console.log = (line) => said.push(line);
  try {
    assemble();
    return { assembled: true, said, sources: JSON.parse(readFileSync(join(scratch, 'src/web/.ui-migration-results/expected-screenshots/sources.json'))) };
  } catch (error) {
    return { assembled: false, error: error.message };
  } finally {
    console.log = log;
  }
}
const edit = (index, change) => valid().map((e, i) => (i === index ? change(structuredClone(e)) : e));
const touch = (path) => () => writeFileSync(path, Buffer.concat([readFileSync(path), Buffer.from([0])]));
const cases = [
  ['valid: one entry on a P0.2 original, one stacked on a main drift reference', valid()],
  ['no decision', edit(0, (e) => (delete e.decision, e))],
  ['decision is not CONFIRM', edit(0, (e) => ((e.decision.verdict = 'SEND_BACK'), e))],
  ['no evidence revision', edit(0, (e) => (delete e.decision.evidenceRevision, e))],
  ['evidence revision 0', edit(0, (e) => ((e.decision.evidenceRevision = 0), e))],
  ['no evidence digest', edit(0, (e) => (delete e.decision.evidenceDigest, e))],
  ['no task id', edit(0, (e) => ((e.decision.taskId = ''), e))],
  ['decision document missing', edit(0, (e) => ((e.decision.document = 'p0-drift/no-such-batch/README.md'), e))],
  ['no difference description', edit(0, (e) => ((e.difference = ' '), e))],
  ['replaces the P0.2 original of a main drift screenshot', edit(1, (e) => ((e.replaces = { layer: 'p0.2', sha256: p02[onDrift] }), e))],
  ['replaces a stale expectation', edit(0, (e) => ((e.replaces.sha256 = '0'.repeat(64)), e))],
  ['before commit not a full SHA', edit(0, (e) => ((e.sameCommit.before.commit = 'aaaaaaa'), e))],
  ['same-commit run outside the P0.2 environment', edit(0, (e) => ((e.sameCommit.environment = '0'.repeat(64)), e))],
  ['registered image is not the after original', edit(0, (e) => ((e.sameCommit.after.sha256 = e.sameCommit.before.sha256), e))],
  ['before and after originals identical', edit(0, (e) => ((e.sameCommit.before.sha256 = e.sha256), e))],
  ['accepted screenshot changed after registration', valid(), touch(join(drift, 'accepted/screenshots', onP02))],
  ['before original changed after registration', valid(), touch(join(drift, 'accepted/before', onP02))],
  ['same screenshot registered twice', [...valid(), valid()[0]]],
  ['not a P0 screenshot', edit(0, (e) => ((e.screenshot = 'chromium-light-phone/not-a-p0-screenshot.png'), e))],
  ['unregistered file in accepted/screenshots', valid(), () => cpSync(files[onP02].after, join(drift, 'accepted/screenshots/chromium-light-phone/extra.png'))],
  ['unregistered file in accepted/before', valid(), () => cpSync(files[onP02].before, join(drift, 'accepted/before/chromium-light-phone/extra.png'))],
  ['main drift reference changed after registration', valid(), touch(join(drift, 'reference/screenshots', onDrift))],
  ['unregistered file in the main drift reference', valid(), () => cpSync(files[onDrift].after, join(drift, 'reference/screenshots/chromium-light-desktop/extra.png'))],
];
const results = cases.map(([name, entries, mutate], i) => ({ name, ...attempt(entries, mutate), expected: i === 0 ? 'assembled' : 'refused' }));
const ok = results.every((r) => (r.expected === 'assembled') === r.assembled);
const valid0 = results[0].sources;
console.log(JSON.stringify({ ok, layersInValidCase: valid0 && Object.values(valid0).reduce((n, s) => ({ ...n, [s.layer]: (n[s.layer] ?? 0) + 1 }), {}),
  acceptedInValidCase: valid0 && Object.entries(valid0).filter(([, s]) => s.layer === 'accepted').map(([k, s]) => ({ screenshot: k, replaces: s.replaces.layer })),
  cases: results.map(({ name, expected, assembled, said, error }) => ({ name, expected, outcome: assembled ? 'assembled' : 'refused', ...(said ? { said } : { error }) })) }, null, 1));
process.exit(ok ? 0 : 1);
