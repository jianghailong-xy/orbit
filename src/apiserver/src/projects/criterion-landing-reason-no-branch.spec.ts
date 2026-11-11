import assert from 'node:assert/strict';
import test from 'node:test';

import {
  criterionLandingReason,
  type LandingReasonServingTask,
} from './criterion-landing-reason';
import { criterionLanding, type LandingBranches } from './project-criterion-landing';
import { doneReadiness, type DoneState, type DoneStateCriterion } from './project-done-request';

/**
 * CODELESS used to mean two things: work with really nothing to land (declared codeless, or done in
 * another repository), and work that ran without a worktree branch, about which Orbit has no
 * evidence either way. The second now reads NO_BRANCH, stays delivery in the landing fold, and an
 * unmet criterion is reported once — unsatisfied — never also unlanded.
 */

const BRANCHES: LandingBranches = { upstream: ['main'], integration: ['project/p'] };

function servingTask(
  id: string,
  over: Partial<LandingReasonServingTask> = {},
): LandingReasonServingTask {
  return {
    id,
    codeless: false,
    mergeReceipts: [],
    integrationJobs: [],
    // A shared-isolation run: no worktree, no branch.
    sessions: [{ isolationStatus: 'shared', branch: null, workspace: null }],
    project: null,
    ...over,
  };
}

/** The fold's answer and the reason the projection gives it. */
function read(servingTasks: LandingReasonServingTask[]) {
  const [{ landing }] = criterionLanding([{ id: 'c', servingTasks }], BRANCHES);
  return { landing, reason: criterionLandingReason({ landing, servingTasks }, BRANCHES, []) };
}

test('declared codeless work is LANDED and reads CODELESS', () => {
  assert.deepEqual(read([servingTask('t1', { codeless: true })]), { landing: 'LANDED', reason: 'CODELESS' });
});

test('work that ran without a branch stays delivery and reads NO_BRANCH, not CODELESS', () => {
  assert.deepEqual(read([servingTask('t1')]), { landing: 'UNKNOWN', reason: 'NO_BRANCH' });
  assert.deepEqual(read([servingTask('t1', { sessions: [] })]), { landing: 'UNKNOWN', reason: 'NO_BRANCH' },
    'no work session at all is no branch too');
  assert.deepEqual(
    read([servingTask('t1', { sessions: [{ isolationStatus: 'worktree', branch: null, workspace: null }] })]),
    { landing: 'UNKNOWN', reason: 'NO_BRANCH' },
    'a worktree that names no branch is no branch');
  // A worktree branch with no receipt is still NO_RECEIPT.
  assert.deepEqual(
    read([servingTask('t1', {
      sessions: [{ isolationStatus: 'worktree', branch: 'orbit/x', workspace: null }],
    })]),
    { landing: 'UNKNOWN', reason: 'NO_RECEIPT' });
  // Beside declared-codeless work, the branchless work still holds the criterion.
  assert.deepEqual(read([servingTask('t1', { codeless: true }), servingTask('t2')]),
    { landing: 'UNKNOWN', reason: 'NO_BRANCH' });
});

test('NO_BRANCH ranks next to NO_RECEIPT: after real work on a branch, before CODELESS', () => {
  const withBranch = servingTask('t1', {
    sessions: [{ isolationStatus: 'worktree', branch: 'orbit/x', workspace: null }],
  });
  assert.equal(read([servingTask('t2'), withBranch]).reason, 'NO_RECEIPT');
});

test('the CBAI shape: one finding for the unmet criterion, NO_BRANCH warnings for the met ones', () => {
  const definitions = [1, 2, 3, 4].map((ordinal) => ({
    id: `def-${ordinal}`,
    servingTasks: [servingTask(`task-${ordinal}`)],
  }));
  const landing = new Map(criterionLanding(definitions, BRANCHES).map((row) => [row.definitionId, row.landing]));
  const criteria = definitions.map((definition, index): DoneStateCriterion => {
    const ordinal = index + 1;
    const landed = landing.get(definition.id)!;
    return {
      stated: {
        ordinal,
        key: `key-${ordinal}`,
        text: `criterion ${ordinal}`,
        definitionId: definition.id,
        definitionRevision: 1,
        verificationMethod: null,
        completionCriterionOverrideReason: null,
        contentHash: 'h',
      },
      satisfied: ordinal !== 4,
      heldUpBy: ordinal === 4 ? [{ taskId: 'task-4', title: 'the open task' }] : [],
      landing: landed,
      reason: landed === 'LANDED'
        ? null
        : criterionLandingReason({ landing: landed, servingTasks: definition.servingTasks }, BRANCHES, []),
      heldOffLanded: [{ taskId: definition.servingTasks[0].id, title: `work ${ordinal}` }],
    };
  });
  const state: DoneState = {
    criteria,
    tasks: [1, 2, 3, 4].map((ordinal) => ({
      id: `task-${ordinal}`,
      title: `work ${ordinal}`,
      status: ordinal === 4 ? 'OPEN' : 'DONE',
      criterionDefinitionId: `def-${ordinal}`,
      run: null,
    })),
    ownerItems: [],
    jobs: [],
    criteriaDigest: 'd',
    stateDigest: 's',
    nonCode: false,
  };

  const findings = doneReadiness(state, []);
  const about4 = findings.filter((finding) => finding.criterion?.ordinal === 4);
  assert.deepEqual(about4.map((finding) => `${finding.severity} ${finding.code}`),
    ['REFUSE DONE_CRITERION_UNSATISFIED'], 'criterion 4 is reported once: not met, never also unlanded');
  assert.deepEqual(about4[0].tasks, [{ taskId: 'task-4', title: 'the open task' }]);

  assert.deepEqual(
    findings.map((finding) => `${finding.criterion?.ordinal} ${finding.code} ${finding.reason}`),
    [
      '4 DONE_CRITERION_UNSATISFIED null',
      '1 DONE_CRITERION_UNLANDED NO_BRANCH',
      '2 DONE_CRITERION_UNLANDED NO_BRANCH',
      '3 DONE_CRITERION_UNLANDED NO_BRANCH',
    ]);
  const warning = findings.find((finding) => finding.criterion?.ordinal === 1)!;
  assert.match(warning.message, /criterion 1's work ran without a branch, so Orbit can't see whether its changes reached main/);
  assert.match(warning.requiredAction, /Check main/);
  assert.match(warning.requiredAction, /gap/);
});
