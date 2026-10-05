import assert from 'node:assert/strict';
import { test } from 'node:test';
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
