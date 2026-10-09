import assert from 'node:assert/strict';
import { test } from 'node:test';
import { integrationJobLimitSeconds } from './project-integration-job';
import { lastLandingCheck, projectDefaultLine } from './project-integration-line';

test('landing checks require actual complete check results to pass', () => {
  for (const checks of [undefined, null, [], {}, [null], [{}], [{ exitCode: 0 }]]) {
    assert.equal(lastLandingCheck(checks), 'UNKNOWN');
  }
  assert.equal(lastLandingCheck([{ expectedExitCode: 0, exitCode: 0, timedOut: false }]), 'PASSING');
  assert.equal(lastLandingCheck([{ expectedExitCode: 2, exitCode: 2, timedOut: false }]), 'PASSING');
});

test('a failed or timed out check is failing, even if another result is missing', () => {
  assert.equal(lastLandingCheck([
    { expectedExitCode: 0, exitCode: 0, timedOut: false },
    { expectedExitCode: 0, exitCode: 1, timedOut: false },
  ]), 'FAILING');
  assert.equal(lastLandingCheck([{}, { expectedExitCode: 0, exitCode: null, timedOut: true }]), 'FAILING');
  assert.equal(lastLandingCheck([{ expectedExitCode: 0, exitCode: null, timedOut: false }]), 'UNKNOWN');
});

test('a running job may stay silent for the lease, or for its check budgets plus the lease while checking', () => {
  const landing = {
    kind: 'LAND_TASK', promotionSourceKind: null, skipMergeCheck: false,
    acceptanceCommand: 'npm test -w web', acceptanceExpectedExitCode: 0, acceptanceTimeoutSeconds: 300,
    mergeCheckCommand: 'npm run build', mergeCheckTimeoutSeconds: null,
  };
  for (const phase of [null, 'FETCH', 'MAIN_SYNC', 'REBASE', 'MERGE', 'PUSH', 'VERIFY']) {
    assert.equal(integrationJobLimitSeconds({ ...landing, state: 'RUNNING', phase }), 600, String(phase));
  }
  // The task's acceptance (300) and the merge check's default hour, then the lease.
  assert.equal(integrationJobLimitSeconds({ ...landing, state: 'RUNNING', phase: 'CHECK' }), 300 + 3600 + 600);
  // A generation whose merge check was approved away runs the acceptance alone.
  assert.equal(integrationJobLimitSeconds({ ...landing, skipMergeCheck: true, state: 'RUNNING', phase: 'CHECK' }),
    300 + 600);
  // A project-branch promotion runs the merge check and nothing else.
  assert.equal(integrationJobLimitSeconds({
    ...landing, kind: 'LAND_PROMOTION', promotionSourceKind: 'PROJECT_BRANCH', mergeCheckTimeoutSeconds: 900,
    state: 'RUNNING', phase: 'CHECK',
  }), 900 + 600);
  assert.equal(integrationJobLimitSeconds({ ...landing, state: 'QUEUED', phase: null }), null);
});

test('project default line checks dependency endpoints by project without large ID lists', async () => {
  let query: unknown;
  const db = {
    taskDependency: {
      findFirst: async (args: unknown) => {
        query = args;
        return { id: 'edge-1' };
      },
    },
  } as unknown as Parameters<typeof projectDefaultLine>[0];

  assert.equal(await projectDefaultLine(db, 'project-1'), 'PROJECT_BRANCH');
  assert.deepEqual(query, {
    where: {
      task: { projectId: 'project-1', codeless: false, status: { not: 'CANCELLED' } },
      dependsOnTask: { projectId: 'project-1', codeless: false, status: { not: 'CANCELLED' } },
    },
    select: { id: true },
  });
});

test('project default line stays on main when no in-scope dependency exists', async () => {
  const db = {
    taskDependency: { findFirst: async () => null },
  } as unknown as Parameters<typeof projectDefaultLine>[0];

  assert.equal(await projectDefaultLine(db, 'project-1'), 'MAIN');
});
