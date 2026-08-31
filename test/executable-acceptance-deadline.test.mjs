// The inner guard around the executable-acceptance matrix. It was a fixed `timeout -k 5 240`, well
// below the 900s the release DAG admits suite-acceptance-runtime with, so the negotiated budget was
// never this suite's deadline. Once full-api-serial was repaired and the 338-case full-api node ran
// alongside it, the matrix went past 240s, was SIGTERMed, and a slow run became a permanent rc=124
// with tests=0 that took seven downstream nodes with it.
//
// Both directions are load-bearing and neither was covered: a slow run inside the derived deadline
// has to finish and report a complete TAP, and a run that really does overrun has to still fail
// non-zero, saying what the deadline was, where it came from, and how far the matrix got.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

const repo = path.resolve(import.meta.dirname, '..');
const lib = path.join(repo, 'scripts/lib/outcome-reconciler-release-dag.sh');
const acceptance = path.join(repo, 'scripts/executable-acceptance-runtime.sh');
const workspace = mkdtempSync(path.join(tmpdir(), 'orbit-acceptance-deadline-'));
after(() => rmSync(workspace, { recursive: true, force: true }));

// The production functions, driven exactly the way scripts/executable-acceptance-runtime.sh drives
// them: derive the deadline from the admitted budget, then run the real command under it.
const driver = `
set -euo pipefail
source "$1"
outcome_release_dag_node_deadline "$2" "$3"
tap="$4"
shift 4
[ "$#" -gt 0 ] || exit 0
set +e
outcome_release_dag_guarded_run "$tap" "$@"
rc=$?
set -e
exit "$rc"
`;

function run({ budget, spent = 0, reserved = 0, tap = '', command = [] }) {
  const env = { ...process.env };
  delete env.OUTCOME_RELEASE_DAG_NODE_TIMEOUT_SECONDS;
  // This file is itself run by node --test, and the runner marks its children so they refuse to run
  // files of their own. The matrix under the guard has to be a real `node --test`, so drop the mark.
  delete env.NODE_TEST_CONTEXT;
  if (budget !== undefined) env.OUTCOME_RELEASE_DAG_NODE_TIMEOUT_SECONDS = budget;
  const startedAt = Date.now();
  const result = spawnSync('bash', ['-c', driver, 'acceptance-deadline',
    lib, String(spent), String(reserved), tap, ...command],
  { encoding: 'utf8', cwd: repo, env });
  return { ...result, elapsedMs: Date.now() - startedAt };
}

function fixture(name, body) {
  const file = path.join(workspace, name);
  writeFileSync(file, body);
  return file;
}

const matrix = (file) => ['node', '--test', '--test-concurrency=1', '--test-reporter=tap', file];

test('the matrix deadline is derived from the admitted node budget, not a fixed inner ceiling', () => {
  // suite-acceptance-runtime's own admission, and the prologue this script pays before the matrix.
  const admitted = run({ budget: '900', spent: 0, reserved: 60 });
  assert.equal(admitted.status, 0, admitted.stderr);
  assert.match(admitted.stdout, /release-dag deadline: 840s effective = 900s budget \(source: env OUTCOME_RELEASE_DAG_NODE_TIMEOUT_SECONDS\) - 0s spent - 60s reserved/u);

  const afterPrologue = run({ budget: '900', spent: 300, reserved: 60 });
  assert.match(afterPrologue.stdout, /deadline: 540s effective = 900s budget/u);

  // Genuinely derived: a different admission moves it, and neither lands on the retired constant.
  const larger = run({ budget: '1800', spent: 0, reserved: 60 });
  assert.match(larger.stdout, /deadline: 1740s effective = 1800s budget/u);
  for (const observed of [840, 540, 1740]) assert.ok(observed > 240, `${observed}s is not past 240s`);

  // An exhausted budget is answered at once rather than becoming "no deadline at all".
  const exhausted = run({ budget: '30', spent: 300, reserved: 60 });
  assert.match(exhausted.stdout, /deadline: 1s effective = 30s budget/u);
});

test('an unadmitted run falls back to a named default that is never below the ceiling it replaced', () => {
  const standalone = run({ spent: 0, reserved: 60 });
  assert.equal(standalone.status, 0, standalone.stderr);
  assert.match(standalone.stdout,
    /deadline: 840s effective = 900s budget \(source: default OUTCOME_RELEASE_DAG_DEFAULT_NODE_BUDGET_SECONDS\)/u);

  const declared = spawnSync('bash', ['-c',
    `set -euo pipefail; source "$1"; echo "$OUTCOME_RELEASE_DAG_DEFAULT_NODE_BUDGET_SECONDS"`,
    'default-budget', lib], { encoding: 'utf8' });
  assert.equal(declared.status, 0, declared.stderr);
  assert.ok(Number(declared.stdout.trim()) >= 240,
    `the fallback default ${declared.stdout.trim()}s is below the 240s constant it replaced`);
});

test('a malformed admitted budget is refused instead of guessed', () => {
  for (const budget of ['0', '-5', 'nine hundred', '900s']) {
    const refused = run({ budget, spent: 0, reserved: 60 });
    assert.equal(refused.status, 2, `budget '${budget}' was not refused`);
    assert.match(refused.stderr,
      /OUTCOME_RELEASE_DAG_NODE_TIMEOUT_SECONDS must be a positive whole number of seconds/u);
  }
});

test('a matrix slower than the retired 240-second ceiling finishes and reports a complete TAP', () => {
  const tap = path.join(workspace, 'slow.tap');
  const slow = fixture('slow.test.mjs', `
import test from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
test('a subtest before the slow one', () => {});
// Past the ceiling this guard used to have, and well inside the deadline the 900s admission derives.
test('a subtest that runs past the retired inner ceiling', async () => { await sleep(250_000); });
test('a subtest after the slow one', () => {});
`);
  const result = run({ budget: '900', spent: 0, reserved: 60, tap, command: matrix(slow) });

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.ok(result.elapsedMs > 240_000,
    `the run was not actually slower than the retired ceiling: ${result.elapsedMs}ms`);
  const observed = readFileSync(tap, 'utf8');
  assert.match(observed, /^1\.\.3$/mu);
  assert.match(observed, /^# pass 3$/mu);
  assert.match(observed, /^# fail 0$/mu);
  assert.match(observed, /^# cancelled 0$/mu);
  assert.match(observed, /^# skipped 0$/mu);
});

test('a matrix that really overruns its deadline fails closed and says why', () => {
  const tap = path.join(workspace, 'wedged.tap');
  const wedged = fixture('wedged.test.mjs', `
import test from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
test('the first subtest completes', () => {});
test('the second subtest completes', () => {});
test('the third subtest never returns', async () => { await sleep(600_000); });
`);
  const result = run({ budget: '68', spent: 0, reserved: 60, tap, command: matrix(wedged) });

  assert.equal(result.status, 124, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /the guarded step exceeded its effective deadline/u);
  assert.match(result.stderr, /waited \d+s of a 8s effective deadline/u);
  assert.match(result.stderr,
    /effective deadline = 68s budget \(source: env OUTCOME_RELEASE_DAG_NODE_TIMEOUT_SECONDS\) - 0s spent before it - 60s reserved after it/u);
  // How far it got, so the next reader can tell a slow matrix from a wedged one.
  assert.match(result.stderr, /last completed TAP subtest: ok 2 - the second subtest completes/u);

  // And nothing here can be read as a pass: non-zero, and a TAP with no plan and no summary.
  const observed = readFileSync(tap, 'utf8');
  assert.match(observed, /^ok 1 - the first subtest completes$/mu);
  assert.doesNotMatch(observed, /^1\.\.\d+$/mu);
  assert.doesNotMatch(observed, /^# fail \d+$/mu);
});

test('the acceptance script guards its matrix with the derived deadline and no fixed ceiling', () => {
  const source = readFileSync(acceptance, 'utf8');
  assert.match(source, /outcome_release_dag_node_deadline "\$SECONDS" "\$MANIFEST_RESERVE_SECONDS"/u);
  assert.match(source, /outcome_release_dag_guarded_run "\$TAP"/u);
  assert.doesNotMatch(source, /timeout\s+(-\S+\s+)*\d+/u,
    'the acceptance script reintroduced a literal inner timeout');
});
