import assert from 'node:assert/strict';
import { test } from 'node:test';

import { integrationItemTitle } from './project-integration-job';
import { openItemRequiredAction } from './project-open-item';
import { taskIntegrationOf } from './project-task-integration';

/**
 * The sentences the server writes and the clients print as they are, where they say what a merge
 * goes into (project 34cjQN5ynG6eIH5A0neeu, criterion 4): each names the project's main branch, and
 * for a project on main — or one with no repository bound, whose branch is null — reads word for
 * word as it did before.
 *
 * Every "before" below is copied byte for byte from the source as it was before the branch was
 * named. The branch is handed in through casts, so this file compiles against that source too: there
 * the master cases fail and the main, null and absent ones pass.
 */

type DecisionRow = Parameters<typeof openItemRequiredAction>[0];

/** An open item's row, with the project's main branch when one is given. */
function itemRow(shape: Record<string, unknown>, mainBranch?: string | null): DecisionRow {
  return { ...shape, ...(mainBranch === undefined ? {} : { mainBranch }) } as DecisionRow;
}

/** Each open item whose next step says a merge reaches main: its row, then its sentence before. */
const NEXT_STEPS: Array<[string, Record<string, unknown>, string, string]> = [
  [
    'the owner’s failed check of the merge',
    {
      kind: 'INTEGRATION_CHECK_FAILED', assignee: 'OWNER', taskId: null, promotionId: 'promotion',
      payload: { jobKind: 'CHECK_PROMOTION', failureClass: 'CHECK_FAILED' }, state: 'OPEN',
    },
    'Nothing on the project branch reaches main until this check passes — re-run it or ask the coordinator to fix it.',
    'Nothing on the project branch reaches master until this check passes — re-run it or ask the coordinator to fix it.',
  ],
  [
    'a merge approval',
    { kind: 'PROMOTION_APPROVAL', assignee: 'OWNER', taskId: null, promotionId: 'promotion', payload: {}, state: 'OPEN' },
    'You must decide whether this promotion reaches main — review it, then approve, decline, or cancel it.',
    'You must decide whether this promotion reaches master — review it, then approve, decline, or cancel it.',
  ],
  [
    'a conflict of the merge',
    {
      kind: 'INTEGRATION_CONFLICT', assignee: 'COORDINATOR', taskId: null, promotionId: 'promotion',
      payload: { jobKind: 'CHECK_PROMOTION', failureClass: 'CONFLICT' }, state: 'OPEN',
    },
    'The project branch cannot reach main until this promotion conflict is repaired — create a sync task or ask the coordinator to fix it.',
    'The project branch cannot reach master until this promotion conflict is repaired — create a sync task or ask the coordinator to fix it.',
  ],
  [
    'a check of the merge that timed out, with the coordinator',
    {
      kind: 'INTEGRATION_CHECK_FAILED', assignee: 'COORDINATOR', taskId: null, promotionId: 'promotion',
      payload: { jobKind: 'CHECK_PROMOTION', failureClass: 'CHECK_TIMED_OUT' }, state: 'OPEN',
    },
    'The project branch cannot reach main until this check finishes — re-run it with a reason or ask the coordinator to fix it.',
    'The project branch cannot reach master until this check finishes — re-run it with a reason or ask the coordinator to fix it.',
  ],
  [
    'the merge itself failing',
    {
      kind: 'INTEGRATION_ERROR', assignee: 'OWNER', taskId: null, promotionId: 'promotion',
      payload: { jobKind: 'LAND_PROMOTION', failureClass: 'ERROR' }, state: 'OPEN',
    },
    'The project branch cannot reach main until this integration is repaired — re-run it or ask the coordinator to fix it.',
    'The project branch cannot reach master until this integration is repaired — re-run it or ask the coordinator to fix it.',
  ],
];

test('an open item’s next step names the project’s main branch', () => {
  for (const [what, shape, , onMaster] of NEXT_STEPS) {
    assert.equal(openItemRequiredAction(itemRow(shape, 'master')), onMaster, `${what}, on master`);
  }
});

test('an open item’s next step reads as before on main, and with no repository bound', () => {
  for (const [what, shape, before] of NEXT_STEPS) {
    assert.equal(openItemRequiredAction(itemRow(shape, 'main')), before, `${what}, on main`);
    assert.equal(openItemRequiredAction(itemRow(shape, null)), before, `${what}, no repository bound`);
    assert.equal(openItemRequiredAction(itemRow(shape)), before, `${what}, no branch handed in`);
  }
});

test('the next steps that say nothing about the merge are the same on every branch', () => {
  const task = {
    kind: 'INTEGRATION_CHECK_FAILED', assignee: 'COORDINATOR', taskId: 'task', promotionId: null,
    payload: { jobKind: 'LAND_TASK', failureClass: 'CHECK_FAILED' }, state: 'OPEN',
  };
  const sentence = 'This task cannot reach the project branch until its landing check passes — re-run it or ask the coordinator to fix it.';
  for (const mainBranch of ['master', 'main', null, undefined]) {
    assert.equal(openItemRequiredAction(itemRow(task, mainBranch)), sentence, String(mainBranch));
    assert.equal(openItemRequiredAction(itemRow({ ...NEXT_STEPS[0]![1], state: 'RESOLVED' }, mainBranch)),
      'This item is already settled — no action is required.', `settled, ${String(mainBranch)}`);
  }
});

// ── the reason a task's landing waits, on the task page and beside a blocked merge ────────────────

type IntegrationRow = Parameters<typeof taskIntegrationOf>[0];

/** A finished task's landing, queued behind another job on its branch. */
function waiting(blockingJobKind: string, mainBranch: string | null): IntegrationRow {
  const queuedAt = new Date('2026-10-04T11:55:00Z');
  return {
    taskId: 'task', taskStatus: 'DONE', landing: 'NOT_KNOWN', isCode: true, lineStarted: true,
    jobId: 'landing', jobState: 'QUEUED', jobPhase: null, jobGeneration: 1,
    jobTargetRef: 'refs/heads/project/example',
    jobStartedAt: null, jobClaimedAt: null, jobHeartbeatAt: null, jobCreatedAt: queuedAt, jobFinishedAt: null,
    jobErrorCode: null, jobConflictCount: 0, jobFailedCheck: null,
    queueBlockCode: 'WAITING_SERIAL_SLOT', runnerWait: null, runnerName: null,
    blockingJobId: 'busy', blockingJobKind, blockingTaskTitle: null, blockingOpenItemId: null,
    itemId: null, itemKind: null, itemAssignee: null, itemCreatedAt: null, itemHandlingJobId: null,
    landedAt: null, mainBranch,
  };
}

/** Each job a landing can wait behind that is a merge into main: its kind, then the reason before. */
const WAITING_BEHIND: Array<[string, string, string]> = [
  [
    'CHECK_PROMOTION',
    'Waiting to land: a check of the merge into main is running on this branch first',
    'Waiting to land: a check of the merge into master is running on this branch first',
  ],
  [
    'LAND_PROMOTION',
    'Waiting to land: the merge into main is running on this branch first',
    'Waiting to land: the merge into master is running on this branch first',
  ],
];

const summary = (row: IntegrationRow) =>
  taskIntegrationOf(row, new Date('2026-10-04T12:01:00Z')).landTask?.blockingReason?.summary;

test('a landing waiting behind the merge says which branch the merge goes into', () => {
  for (const [kind, , onMaster] of WAITING_BEHIND) {
    assert.equal(summary(waiting(kind, 'master')), onMaster, `${kind}, on master`);
  }
});

test('a landing waiting behind the merge reads as before on main, and with no repository bound', () => {
  for (const [kind, before] of WAITING_BEHIND) {
    assert.equal(summary(waiting(kind, 'main')), before, `${kind}, on main`);
    assert.equal(summary(waiting(kind, null)), before, `${kind}, no repository bound`);
  }
  // What else may hold the branch names no main branch at all.
  for (const mainBranch of ['master', 'main', null]) {
    assert.equal(summary(waiting('LAND_TASK', mainBranch)), 'Waiting to land: another landing is running on this branch first');
    assert.equal(summary(waiting('MAIN_SYNC', mainBranch)), 'Waiting to land: another integration job is running on this branch first');
  }
});

// ── the title of the exception item a merge's failure opens ───────────────────────────────────────

/** The title builder, with the branch handed in the way the relay hands it. */
const titleOf = integrationItemTitle as (state: string, kind: string, taskTitle: string, mainBranch?: string | null) => string;

/** Each way a merge fails: the job's state, then the title before and on master. */
const FAILED_MERGES: Array<[string, string, string]> = [
  ['CONFLICT', 'Merge conflict: merging the project branch into main', 'Merge conflict: merging the project branch into master'],
  ['CHECK_FAILED', 'Checks failed on the combined tree: merging the project branch into main',
    'Checks failed on the combined tree: merging the project branch into master'],
  ['ERROR', 'Integration error: merging the project branch into main', 'Integration error: merging the project branch into master'],
];

test('the item a failed merge opens is titled with the project’s main branch', () => {
  for (const kind of ['CHECK_PROMOTION', 'LAND_PROMOTION']) {
    for (const [state, , onMaster] of FAILED_MERGES) {
      assert.equal(titleOf(state, kind, '', 'master'), onMaster, `${kind} ${state}, on master`);
    }
  }
});

test('the item a failed merge opens is titled as before on main, and with no repository bound', () => {
  for (const kind of ['CHECK_PROMOTION', 'LAND_PROMOTION']) {
    for (const [state, before] of FAILED_MERGES) {
      assert.equal(titleOf(state, kind, '', 'main'), before, `${kind} ${state}, on main`);
      assert.equal(titleOf(state, kind, '', null), before, `${kind} ${state}, no repository bound`);
      assert.equal(titleOf(state, kind, ''), before, `${kind} ${state}, no branch handed in`);
    }
  }
  // A task's own landing is named after the task, whatever the branch.
  for (const mainBranch of ['master', 'main', null]) {
    assert.equal(titleOf('CHECK_FAILED', 'LAND_TASK', 'Fix the login', mainBranch),
      'Checks failed on the combined tree: Fix the login');
  }
});
