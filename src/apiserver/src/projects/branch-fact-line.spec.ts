import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { IntegrationCheckResult } from '@orbit/shared';

import { failurePayload } from '../runner-api/integration-job-relay';
import { TASK_BRANCH_UNCHANGED_LINE, openItemFacts } from './project-open-item';

/**
 * The Branch row of a failed check's card, by the job the check failed in.
 *
 * Every failed check's payload says `branchUnchanged: true`, whatever the job. Until this line the
 * three clients turned that into one fixed sentence about a task that passed on its own branch,
 * which a promotion's card (the project branch merged with main, no task, no run of the branch
 * alone) said falsely. The server now writes the sentence beside the flag, from the payload the
 * relay writes, so the three clients draw what the server says.
 */

const RED: IntegrationCheckResult = {
  name: 'MERGE_CHECK', command: 'npm test', expectedExitCode: 0, exitCode: 1, timedOut: false,
  durationMs: 9_000, outputTail: 'not ok 1\n',
} as IntegrationCheckResult;

/** A CHECK_FAILED payload exactly as the relay writes it for a job of `kind`. */
function checkFailed(kind: string, candidateSourceKind: string | null = null): Record<string, unknown> {
  return failurePayload('CHECK_FAILED', {
    kind, phase: null, targetRef: 'refs/heads/main', targetSha: null, conflicts: [], checks: [RED],
    checkBudgets: null, errorCode: null, errorDetail: null, upstreamMovedCommits: null,
    outdatedRunner: null, candidateSourceKind, landingSessionId: null, round: null, generation: 1,
    retry: null, skippedCheck: null,
  });
}

const TASK = { id: '01a0f5c8-0000-7000-8000-000000000003', title: 'Backfill order stats' };
const lineOf = (payload: unknown, task: typeof TASK | null, main: string | null = 'main') =>
  openItemFacts('INTEGRATION_CHECK_FAILED', payload, task, main)?.branchLine;

test('a failed LAND_TASK check keeps the task-branch sentence', () => {
  const payload = checkFailed('LAND_TASK');
  assert.equal(payload.branchUnchanged, true);
  assert.equal(lineOf(payload, TASK),
    'unchanged — the task passed on its own branch; it fails only on the combined tree');
  assert.equal(lineOf(payload, TASK), TASK_BRANCH_UNCHANGED_LINE);
});

test('a failed promotion of the project branch says it did not move and nothing reached main — not that it passed alone', () => {
  for (const kind of ['CHECK_PROMOTION', 'LAND_PROMOTION']) {
    const payload = checkFailed(kind);
    assert.equal(payload.branchUnchanged, true, kind);
    assert.equal(payload.sourceKind, undefined, kind);
    const line = lineOf(payload, null);
    assert.equal(line, 'unchanged — the project branch did not move, and nothing reached main', kind);
    assert.doesNotMatch(line!, /passed|task/, kind);
    assert.equal(lineOf(payload, null, 'develop'),
      'unchanged — the project branch did not move, and nothing reached develop', kind);
    // A project whose codebase is not read names main, as the next-step sentences do.
    assert.equal(lineOf(payload, null, null), line, kind);
  }
});

test('a failed TASK_BRANCH promotion candidate words it about that task’s branch and main', () => {
  for (const kind of ['CHECK_PROMOTION', 'LAND_PROMOTION']) {
    const payload = checkFailed(kind, 'TASK_BRANCH');
    assert.equal(payload.sourceKind, 'TASK_BRANCH', kind);
    const line = lineOf(payload, null);
    assert.equal(line, 'unchanged — this task’s branch did not move, and nothing on it reached main', kind);
    assert.doesNotMatch(line!, /passed|project branch/, kind);
    assert.equal(lineOf(payload, null, 'develop'),
      'unchanged — this task’s branch did not move, and nothing on it reached develop', kind);
  }
});

test('no Branch sentence where the payload does not say the branch is unchanged', () => {
  const conflict = failurePayload('CONFLICT', {
    kind: 'CHECK_PROMOTION', phase: 'REBASE', targetRef: 'refs/heads/main', targetSha: null,
    conflicts: ['src/a.ts'], checks: [], checkBudgets: null, errorCode: null, errorDetail: null,
    upstreamMovedCommits: null, outdatedRunner: null, candidateSourceKind: null, landingSessionId: null,
    round: null, generation: 1, retry: null, skippedCheck: null,
  });
  assert.equal(lineOf(conflict, null), null);
  assert.equal(openItemFacts('INTEGRATION_CHECK_FAILED', { branchUnchanged: false }, TASK)?.branchLine, null);
});

test('a payload an older build wrote, with no job kind, keeps the sentence it always had', () => {
  assert.equal(lineOf({ branchUnchanged: true }, TASK), TASK_BRANCH_UNCHANGED_LINE);
});
