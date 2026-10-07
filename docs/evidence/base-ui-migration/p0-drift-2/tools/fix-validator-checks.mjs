// Negative controls for the migrationFix check in src/web/ui-migration/expected-screenshots.mjs (the
// bounded exception of p0-drift README main drift rule 7): copies the module and the p0-drift layers
// into a scratch tree (P0.2 and the other evidence directories are linked read-only), gives one
// registered main drift reference a valid migrationFix, and then breaks one rule per case. Every broken
// case must stop the P0 globalSetup with the migrationFix rule; the valid cases must assemble. Same
// harness as ../../p0-drift/tools/validator-checks.mjs.
// Usage: node fix-validator-checks.mjs <worktree> <scratch dir>   (prints JSON, exits 1 on any miss)
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [worktree, scratch] = process.argv.slice(2);
const ev = (root) => join(root, 'docs/evidence/base-ui-migration');
rmSync(scratch, { recursive: true, force: true });
mkdirSync(join(scratch, 'src/web/ui-migration'), { recursive: true });
cpSync(join(worktree, 'src/web/ui-migration/expected-screenshots.mjs'), join(scratch, 'src/web/ui-migration/expected-screenshots.mjs'));
mkdirSync(ev(scratch), { recursive: true });
// Registry entries cite documents beside p0-drift (a batch README, a fix's decision and isolation proofs).
for (const entry of readdirSync(ev(worktree))) if (entry !== 'p0-drift') symlinkSync(join(ev(worktree), entry), join(ev(scratch), entry));
const drift = join(ev(scratch), 'p0-drift');
const pristine = join(scratch, 'pristine-p0-drift');
cpSync(join(ev(worktree), 'p0-drift/reference'), join(pristine, 'reference'), { recursive: true });
cpSync(join(ev(worktree), 'p0-drift/accepted'), join(pristine, 'accepted'), { recursive: true });
writeFileSync(join(pristine, 'decision.md'), 'Scratch stand-in for the evidence document of a fix the coordinator confirmed.\n');
writeFileSync(join(pristine, 'isolation.json'), '{"scratch": "stand-in for the two isolation proofs"}\n');
const { default: assemble } = await import(pathToFileURL(join(scratch, 'src/web/ui-migration/expected-screenshots.mjs')));

const registry = JSON.parse(readFileSync(join(pristine, 'reference/registry.json')));
const target = registry.screenshots.findIndex((e) => e.screenshot === 'chromium-light-desktop/settings.png');
const fix = () => ({
  regression: 'scratch stand-in regression', commit: 'c'.repeat(40), generationTree: 'd'.repeat(40),
  decision: { taskId: 'SCRATCHnotAdecision00', evidenceRevision: 1, evidenceDigest: 'f'.repeat(64), verdict: 'CONFIRM', document: 'p0-drift/decision.md' },
  isolation: 'p0-drift/isolation.json',
});
function attempt(change) {
  rmSync(drift, { recursive: true, force: true });
  cpSync(pristine, drift, { recursive: true });
  const entries = structuredClone(registry.screenshots);
  if (change) entries[target] = change(entries[target]);
  writeFileSync(join(drift, 'reference/registry.json'), JSON.stringify({ ...registry, screenshots: entries }, null, 2));
  const log = console.log, said = [];
  console.log = (line) => said.push(line);
  try {
    assemble();
    const sources = JSON.parse(readFileSync(join(scratch, 'src/web/.ui-migration-results/expected-screenshots/sources.json')));
    return { assembled: true, said, layer: sources[entries[target].screenshot].layer };
  } catch (error) {
    return { assembled: false, error: error.message };
  } finally {
    console.log = log;
  }
}
const withFix = (edit) => (e) => { const f = fix(); edit(f); return { ...e, migrationFix: f }; };
const cases = [
  ['valid: the registry as committed (with its own migrationFix entries)', null, true],
  ['valid: one more migrationFix naming the fix, its tree, a CONFIRM decision and the isolation proofs', withFix(() => {}), true],
  ['migrationFix without a decision', withFix((f) => delete f.decision), false],
  ['decision is not CONFIRM', withFix((f) => (f.decision.verdict = 'SEND_BACK')), false],
  ['no evidence revision', withFix((f) => delete f.decision.evidenceRevision), false],
  ['evidence revision 0', withFix((f) => (f.decision.evidenceRevision = 0)), false],
  ['no evidence digest', withFix((f) => delete f.decision.evidenceDigest), false],
  ['no task id', withFix((f) => (f.decision.taskId = '')), false],
  ['decision document missing', withFix((f) => (f.decision.document = 'p0-drift/no-such-fix/README.md')), false],
  ['fix commit abbreviated', withFix((f) => (f.commit = 'c'.repeat(9))), false],
  ['no generation tree', withFix((f) => delete f.generationTree), false],
  ['isolation proofs missing', withFix((f) => (f.isolation = 'p0-drift/no-such-isolation.json')), false],
  ['migrationFix is null', (e) => ({ ...e, migrationFix: null }), false],
  ['migrationFix is empty', (e) => ({ ...e, migrationFix: {} }), false],
];
const results = cases.map(([name, change, valid]) => {
  const outcome = attempt(change);
  const ok = valid ? outcome.assembled && outcome.layer === 'p0-drift' : !outcome.assembled && /generated with a migration fix applied/.test(outcome.error);
  return { name, expected: valid ? 'assembled' : 'refused', outcome: outcome.assembled ? 'assembled' : 'refused', ok, ...(outcome.error ? { error: outcome.error } : { said: outcome.said }) };
});
const ok = results.every((r) => r.ok);
console.log(JSON.stringify({ ok, target: registry.screenshots[target].screenshot, cases: results }, null, 2));
process.exit(ok ? 0 : 1);
