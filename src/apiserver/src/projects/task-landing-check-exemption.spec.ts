import assert from 'node:assert/strict';
import { test } from 'node:test';

import { checksFor, type IntegrationCheckSource, taskLandingCheckExemption } from './project-integration-job';

/**
 * §12.15 P-C2 at `checksFor`: what an exempt task's job is handed, and what it is not. The door that
 * writes the exemption and the landing that records it are pinned by
 * `src/apiserver/src/tasks/task-landing-check-exempt.pg.spec.ts`; this is the edges of the rule.
 */
const REASON = 'Docs-only change; the landing build has nothing to say about it.';

function job(over: Partial<IntegrationCheckSource> = {}): IntegrationCheckSource {
  return {
    kind: 'LAND_TASK',
    promotionSourceKind: null,
    acceptanceCommand: 'npm test',
    acceptanceExpectedExitCode: 0,
    acceptanceTimeoutSeconds: 60,
    mergeCheckCommand: 'bash scripts/merge-check.sh',
    mergeCheckTimeoutSeconds: 3_600,
    skipMergeCheck: false,
    landingCheckExempt: true,
    landingCheckExemptReason: REASON,
    targetRef: 'refs/heads/project/p',
    upstreamRef: 'refs/heads/main',
    ...over,
  };
}

const named = (row: IntegrationCheckSource): string[] => checksFor(row).map((check) => check.name);

test('an exempt task landing on its project branch runs its acceptance and not the landing check', () => {
  assert.deepEqual(named(job()), ['TASK_ACCEPTANCE']);
  assert.equal(taskLandingCheckExemption(job()), REASON);
  // The same task not exempt gets the landing check as before.
  assert.deepEqual(named(job({ landingCheckExempt: false })), ['TASK_ACCEPTANCE', 'LANDING_CHECK']);
  assert.equal(taskLandingCheckExemption(job({ landingCheckExempt: false })), null);
});

test('the merge check before main is never skipped by a task exemption', () => {
  for (const promotionSourceKind of ['TASK_BRANCH', 'PROJECT_BRANCH']) {
    for (const kind of ['CHECK_PROMOTION', 'LAND_PROMOTION']) {
      const row = job({ kind, promotionSourceKind });
      assert.ok(named(row).includes('MERGE_CHECK'), `${kind} ${promotionSourceKind}: ${named(row)}`);
      assert.equal(taskLandingCheckExemption(row), null);
    }
  }
});

test('a landing whose target is the upstream (a MAIN line) keeps its landing check, whatever the task says', () => {
  const main = job({ targetRef: 'refs/heads/main' });
  assert.deepEqual(named(main), ['TASK_ACCEPTANCE', 'LANDING_CHECK']);
  assert.equal(taskLandingCheckExemption(main), null);
  // A row that does not say where it lands is not taken to be a project branch.
  assert.deepEqual(named(job({ targetRef: undefined })), ['TASK_ACCEPTANCE', 'LANDING_CHECK']);
});

test('no skip is recorded where no landing check was due', () => {
  assert.equal(taskLandingCheckExemption(job({ landingCheckNone: true })), null);
  assert.equal(taskLandingCheckExemption(job({ skipMergeCheck: true })), null);
  assert.equal(taskLandingCheckExemption(job({ mergeCheckCommand: null })), null);
  assert.equal(taskLandingCheckExemption(job({ landingCheckExemptReason: null })), null);
  // An explicit landing check counts even with no merge check behind it.
  assert.equal(taskLandingCheckExemption(job({ mergeCheckCommand: null, landingCheckCommand: 'npm run build' })), REASON);
});
