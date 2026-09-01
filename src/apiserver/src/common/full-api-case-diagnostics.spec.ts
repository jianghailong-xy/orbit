import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

/**
 * What the Full API case runner says when a case does not merely fail.
 *
 * The acceptance this covers ran for seventeen minutes, reported nineteen red cases, and printed
 * nothing whatsoever about any of them: the failure branch pasted the log from its first `not ok`
 * line onward, and a case killed before it produced any TAP has no such line, so `sed` emitted an
 * empty string. Timed out, killed by a signal, and broken before the runner started all looked
 * identical -- `FAILED 0 0 true` -- and none of the three could be told apart afterwards, because
 * the case log directory is deleted when the run ends.
 *
 * So these are the failure shapes themselves, driven through the real script. `docker` is a shim
 * on PATH -- the script reaches PostgreSQL only through `docker exec psql`, and none of what is
 * asserted here depends on a database existing -- which is why these cases need no container and
 * cannot be skipped for the lack of one.
 */

const ROOT = path.resolve(__dirname, '../../../..');
const CASE_RUNNER = path.join(ROOT, 'scripts/outcome-reconciler-full-api-standalone-case.sh');
const SYSTEM_IDENTIFIER = '7401998321044550001';

/** Answers the two questions the case script asks PostgreSQL, and nothing else. */
const DOCKER_SHIM = `#!/usr/bin/env bash
set -uo pipefail
database=''
user=''
args=("$@")
for ((i = 0; i < \${#args[@]}; i++)); do
  case "\${args[i]}" in
    -d) database="\${args[i + 1]:-}" ;;
    -U) user="\${args[i + 1]:-}" ;;
  esac
done
for arg in "\${args[@]}"; do
  case "$arg" in
    *pg_control_system*) printf '%s\\t%s\\t%s\\n' "$database" "$user" "${SYSTEM_IDENTIFIER}"; exit 0 ;;
    *'count(*)'*) printf '0\\n'; exit 0 ;;
  esac
done
exit 0
`;

interface CaseRun {
  status: number;
  output: string;
  receipt: {
    outcome: string;
    exitCode: number;
    failureKind: string;
    elapsedSeconds: number;
    timeoutSeconds: number;
    cleanup: { resourcesRemaining: number };
    identity: { verifiedBeforeMutation: boolean };
    summary: { tests: number };
  } | null;
}

/**
 * One case, run by the real case script against a spec written for this test.
 *
 * `source === null` writes no spec file at all: that is the runner failing before it can report
 * anything, which is a different fact from a spec that ran and failed.
 */
function runCase(index: number, name: string, source: string | null, timeoutSeconds: number): CaseRun {
  const root = mkdtempSync(path.join(tmpdir(), 'full-api-case-diagnostics-'));
  try {
    const api = path.join(root, 'api');
    const cases = path.join(root, 'cases');
    const bin = path.join(root, 'bin');
    mkdirSync(path.join(api, 'fake'), { recursive: true });
    mkdirSync(cases, { recursive: true });
    mkdirSync(bin, { recursive: true });
    writeFileSync(path.join(api, 'package.json'), '{"name":"full-api-case-diagnostics","type":"commonjs"}\n');
    writeFileSync(path.join(bin, 'docker'), DOCKER_SHIM);
    chmodSync(path.join(bin, 'docker'), 0o755);
    const spec = path.join(api, 'fake', name);
    if (source !== null) writeFileSync(spec, source);

    const env: NodeJS.ProcessEnv = { ...process.env };
    // This spec is itself run by `node --test`, and its context leaks into any nested runner as an
    // instruction to report back over a channel that is not there.
    for (const key of Object.keys(env)) if (key.startsWith('NODE_TEST_')) delete env[key];
    const run = spawnSync('bash', [CASE_RUNNER, String(index), spec], {
      encoding: 'utf8',
      env: {
        ...env,
        PATH: `${bin}:${env.PATH ?? ''}`,
        OUTCOME_API_CASE_CONTAINER: 'full-api-case-diagnostics',
        OUTCOME_API_CASE_ADMIN: 'pccdiag_admin',
        OUTCOME_API_CASE_PASSWORD: 'pccdiag_password',
        OUTCOME_API_CASE_HOST: '127.0.0.1',
        OUTCOME_API_CASE_PORT: '5432',
        OUTCOME_API_CASE_SYSTEM_ID: SYSTEM_IDENTIFIER,
        OUTCOME_API_CASE_REPO: ROOT,
        OUTCOME_API_CASE_API: api,
        OUTCOME_API_CASE_DIR: cases,
        OUTCOME_API_CASE_TOTAL: '1',
        OUTCOME_API_CASE_TEMPLATE: 'pccdiag_template',
        OUTCOME_API_CASE_PREFIX: 'pccdiag',
        OUTCOME_API_CASE_TIMEOUT: String(timeoutSeconds),
      },
    });
    const receipt = path.join(cases, `${String(index).padStart(4, '0')}.json`);
    return {
      status: run.status ?? -1,
      output: `${run.stdout ?? ''}${run.stderr ?? ''}`,
      receipt: existsSync(receipt) ? JSON.parse(readFileSync(receipt, 'utf8')) : null,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// The marker is what the case leaves in its log before the wall clock takes it: Node's own
// "Interrupted while running" note is version-dependent, and what is being asserted is that the
// harness prints the log it used to discard, not which Node wrote it.
const HANGS = `const { test } = require('node:test');
process.stderr.write('marker: this case will outlive its wall clock\\n');
test('outlives the case wall clock', async () => { await new Promise((resolve) => setTimeout(resolve, 30_000)); });
`;
// Kills the runner from inside its own bootstrap, before a single test is registered: what an
// out-of-memory kill of a case looks like from the case script's side.
const KILLS_ITS_RUNNER = `process.stderr.write('bootstrap: killing the test runner before any TAP\\n');
process.kill(process.ppid, 'SIGKILL');
process.exit(1);
`;
const FAILS = `const { test } = require('node:test');
const assert = require('node:assert/strict');
test('reports a failing test the ordinary way', () => { assert.equal('observed', 'expected'); });
`;
const PASSES = `const { test } = require('node:test');
test('reports a passing test', () => {});
`;

test('(i) a case killed by its own wall clock is reported as a timeout, with the log it did leave', () => {
  const run = runCase(1, 'hangs.spec.js', HANGS, 2);

  assert.equal(run.status, 124, 'timeout reports the wall clock it enforced as 124');
  assert.match(run.output, /full-api FAILED \[1\/1\]: fake\/hangs\.spec\.js TIMED_OUT exit=124 elapsed=\d+s timeout=2/u);
  // The evidence the old failure branch threw away: this case never printed `not ok`, so `sed`
  // printed nothing, and the run recorded a red with no stated reason.
  assert.doesNotMatch(run.output, /^not ok/mu);
  assert.match(run.output, /full-api NO TAP \[1\/1\]/u);
  assert.match(run.output, /# marker: this case will outlive its wall clock/u, 'the tail of the log is printed');
  assert.match(run.output, /^exit=124 elapsed=\d+s timeout=2 kind=TIMED_OUT$/mu);

  assert.ok(run.receipt, 'a case that reported no TAP still leaves a receipt');
  assert.equal(run.receipt.failureKind, 'TIMED_OUT');
  assert.equal(run.receipt.exitCode, 124);
  assert.equal(run.receipt.timeoutSeconds, 2);
  assert.ok(run.receipt.elapsedSeconds >= 1, `wall clock was recorded: ${run.receipt.elapsedSeconds}`);
  assert.equal(run.receipt.outcome, 'FAILED');
  assert.equal(run.receipt.summary.tests, 0);
  assert.equal(run.receipt.cleanup.resourcesRemaining, 0);
  assert.equal(run.receipt.identity.verifiedBeforeMutation, true);
});

test('(ii) a case that dies in bootstrap without producing TAP is reported as killed, not as a timeout', () => {
  const run = runCase(2, 'kills-its-runner.spec.js', KILLS_ITS_RUNNER, 120);

  assert.equal(run.status, 137, 'a runner killed by SIGKILL arrives as 128+9');
  assert.match(run.output, /full-api FAILED \[2\/1\]: fake\/kills-its-runner\.spec\.js SIGNALED exit=137 elapsed=\d+s timeout=120/u);
  assert.match(run.output, /full-api NO TAP \[2\/1\]/u);
  assert.match(run.output, /^exit=137 elapsed=\d+s timeout=120 kind=SIGNALED$/mu);
  assert.doesNotMatch(run.output, /^not ok/mu);

  assert.ok(run.receipt, 'a case killed before it wrote a TAP line still leaves a receipt');
  assert.equal(run.receipt.failureKind, 'SIGNALED');
  assert.equal(run.receipt.exitCode, 137);
  assert.equal(run.receipt.summary.tests, 0);
  // The distinction the whole change exists to make: this case and the one above both report zero
  // tests and no `not ok`, and used to be indistinguishable.
  assert.notEqual(run.receipt.failureKind, 'TIMED_OUT');
});

test('(iii) a case that runs and fails still prints its own not ok section', () => {
  const run = runCase(3, 'fails.spec.js', FAILS, 120);

  assert.equal(run.status, 1);
  assert.match(run.output, /^not ok 1 - reports a failing test the ordinary way$/mu);
  assert.match(run.output, /expected/u, 'the TAP failure body is printed, as before');
  assert.doesNotMatch(run.output, /NO TAP/u, 'a case with TAP is not sent down the fallback path');
  assert.match(run.output, /full-api FAILED \[3\/1\]: fake\/fails\.spec\.js SPEC_FAILED exit=1 elapsed=\d+s timeout=120/u);

  assert.ok(run.receipt);
  assert.equal(run.receipt.failureKind, 'SPEC_FAILED');
  assert.equal(run.receipt.exitCode, 1);
  assert.equal(run.receipt.summary.tests, 1);
});

test('(iv) a case whose runner never starts is reported as broken before TAP, and says why', () => {
  const run = runCase(4, 'never-written.spec.js', null, 120);

  assert.equal(run.status, 1);
  assert.match(run.output, /full-api FAILED \[4\/1\]: fake\/never-written\.spec\.js CRASHED_BEFORE_TAP exit=1 elapsed=\d+s timeout=120/u);
  assert.match(run.output, /Could not find/u, 'the tail of the log carries the runner error');
  assert.match(run.output, /^exit=1 elapsed=\d+s timeout=120 kind=CRASHED_BEFORE_TAP$/mu);

  assert.ok(run.receipt);
  assert.equal(run.receipt.failureKind, 'CRASHED_BEFORE_TAP');
  assert.equal(run.receipt.exitCode, 1);
  assert.notEqual(run.receipt.failureKind, 'TIMED_OUT');
  assert.notEqual(run.receipt.failureKind, 'SIGNALED');
});

test('(v) a case that passes is unchanged, and records the wall clock it took', () => {
  const run = runCase(5, 'passes.spec.js', PASSES, 120);

  assert.equal(run.status, 0);
  assert.match(run.output, /full-api PASS \[5\/1\]: fake\/passes\.spec\.js/u);
  assert.doesNotMatch(run.output, /FAILED|NO TAP/u);

  assert.ok(run.receipt);
  assert.equal(run.receipt.outcome, 'PASS');
  assert.equal(run.receipt.failureKind, 'COMPLETED');
  assert.equal(run.receipt.exitCode, 0);
  assert.equal(run.receipt.timeoutSeconds, 120);
  assert.equal(run.receipt.summary.tests, 1);
});
