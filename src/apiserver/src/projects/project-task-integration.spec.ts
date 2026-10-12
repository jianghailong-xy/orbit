import assert from 'node:assert/strict';
import { test } from 'node:test';
import { taskIntegrationOf } from './project-task-integration';

const now = new Date('2026-10-04T12:01:00Z');
const startedAt = new Date('2026-10-04T12:00:00Z');
type Row = Parameters<typeof taskIntegrationOf>[0];

function row(changes: Partial<Row> = {}): Row {
  return {
    taskId: 'task', taskStatus: 'DONE', landing: 'NOT_KNOWN', isCode: true, lineStarted: true,
    jobId: 'retry', jobState: 'RUNNING', jobPhase: 'CHECK', jobGeneration: 2,
    jobTargetRef: 'refs/heads/project/example',
    jobStartedAt: startedAt, jobClaimedAt: startedAt, jobHeartbeatAt: startedAt,
    jobCreatedAt: startedAt, jobFinishedAt: null,
    jobErrorCode: null, jobConflictCount: 0, jobFailedCheck: null,
    queueBlockCode: null, runnerWait: null, runnerName: null,
    blockingJobId: null, blockingJobKind: null, blockingTaskTitle: null, blockingOpenItemId: null,
    itemId: 'failure', itemKind: 'INTEGRATION_CHECK_FAILED', itemAssignee: 'COORDINATOR',
    itemCreatedAt: new Date('2026-10-04T11:59:00Z'), itemHandlingJobId: 'retry',
    landedAt: null, mainBranch: 'main', ...changes,
  };
}

test('every answer names the project’s main branch the row read, and null with no repository', () => {
  for (const changes of [
    { landing: 'ON_UPSTREAM', landedAt: startedAt },
    { landing: 'ON_INTEGRATION_LINE', landedAt: startedAt },
    { isCode: false },
    {},
    { itemHandlingJobId: null },
    { jobId: null, jobState: null, jobGeneration: null, jobCreatedAt: null, itemId: null, itemKind: null },
  ] satisfies Partial<Row>[]) {
    assert.equal(taskIntegrationOf(row({ ...changes, mainBranch: 'master' }), now).mainBranch, 'master');
    assert.equal(taskIntegrationOf(row({ ...changes, mainBranch: null }), now).mainBranch, null);
  }
});

test('an open failure being retried reads the linked queued or running job', () => {
  for (const state of ['QUEUED', 'RUNNING']) {
    const view = taskIntegrationOf(row({ jobState: state }), now);
    assert.equal(view.state, state);
    assert.equal(view.jobId, 'retry');
    assert.equal(view.handler, null);
    assert.equal(view.openItemId, null);
    assert.equal(view.checksRunningForMs, state === 'RUNNING' ? 60_000 : null);
  }
});

test('an unrelated running job cannot hide an outstanding failure', () => {
  for (const itemHandlingJobId of [null, 'other-job']) {
    const view = taskIntegrationOf(row({ itemHandlingJobId }), now);
    assert.equal(view.state, 'CHECK_FAILED');
    assert.equal(view.openItemId, 'failure');
    assert.equal(view.handler, 'COORDINATOR');
    assert.equal(view.checksRunningForMs, null);
  }
});

test('a terminal retry does not hide a still-open failure', () => {
  for (const jobState of ['CHECK_FAILED', 'ERROR', 'CANCELLED']) {
    assert.equal(taskIntegrationOf(row({ jobState }), now).state, 'CHECK_FAILED');
  }
});

test('a running git step does not claim that checks are running', () => {
  for (const jobPhase of [null, 'FETCH', 'MAIN_SYNC', 'REBASE', 'MERGE', 'PUSH', 'VERIFY']) {
    const view = taskIntegrationOf(row({ jobPhase }), now);
    assert.equal(view.state, 'RUNNING');
    assert.equal(view.checksRunningForMs, null);
  }
});

test('landing evidence takes precedence over a retry or outstanding failure', () => {
  for (const landing of ['ON_INTEGRATION_LINE', 'ON_UPSTREAM']) {
    const view = taskIntegrationOf(row({ landing, landedAt: startedAt }), now);
    assert.equal(view.state, landing);
    assert.equal(view.since, startedAt);
    assert.equal(view.checksRunningForMs, null);
  }
});

test('unfinished work without an integration job is not queued for landing', () => {
  for (const taskStatus of ['OPEN', 'IN_PROGRESS', 'FAILED', 'CANCELLED']) {
    const view = taskIntegrationOf(row({ taskStatus, jobId: null, jobState: null,
      itemId: null, itemKind: null, itemHandlingJobId: null }), now);
    assert.equal(view.state, 'NOT_APPLICABLE');
    assert.equal(view.landTask, null);
  }
  assert.equal(taskIntegrationOf(row({ jobId: null, jobState: null,
    itemId: null, itemKind: null, itemHandlingJobId: null }), now).state, 'QUEUED');
});

// ── the newest LAND_TASK beside the task's state (§2.7a) ───────────────────────────────────────

const queuedAt = new Date('2026-10-04T11:55:00Z');

/** A done task whose newest landing nobody filed an item about. */
function landing(changes: Partial<Row> = {}): Row {
  return row({
    jobId: 'landing', jobState: 'QUEUED', jobPhase: null, jobCreatedAt: queuedAt,
    jobStartedAt: null, jobClaimedAt: null, jobHeartbeatAt: null,
    itemId: null, itemKind: null, itemAssignee: null, itemCreatedAt: null, itemHandlingJobId: null,
    ...changes,
  });
}

test('a queued attempt carries its generation, target, instants, live wait and reason', () => {
  const view = taskIntegrationOf(landing({
    queueBlockCode: 'WAITING_MAIN_SYNC', blockingJobId: 'sync', blockingOpenItemId: 'item',
    blockingTaskTitle: 'Earlier task',
  }), now);
  assert.equal(view.state, 'QUEUED');
  assert.deepEqual(view.landTask, {
    jobId: 'landing', state: 'QUEUED', phase: null, generation: '2',
    queuedAt, startedAt: null, heartbeatAt: null, finishedAt: null,
    targetRef: 'refs/heads/project/example', waitMs: 360_000,
    blockingReason: {
      code: 'WAITING_MAIN_SYNC',
      summary: 'Waiting for the project line to sync: the landing of “Earlier task” could not merge upstream into this branch, and its conflict is still open',
      jobId: 'sync', openItemId: 'item',
    },
  });
  const wire = JSON.parse(JSON.stringify(view.landTask));
  assert.equal(wire.queuedAt, queuedAt.toISOString());
  assert.equal(wire.generation, '2');
});

test('every queue reason says why in its own words and links only its own blocker', () => {
  const cases: Array<[Partial<Row>, string, RegExp]> = [
    [{}, 'WAITING_DISPATCH', /^Waiting to land: next for the runner, which claims it on its next heartbeat$/],
    [{ runnerName: 'hpc' }, 'WAITING_DISPATCH', /next for runner hpc/],
    [{ queueBlockCode: 'WAITING_TASK_WORK', blockingJobId: 'sync' }, 'WAITING_TASK_WORK', /work session is still running/],
    [{ queueBlockCode: 'WAITING_SERIAL_SLOT', blockingJobId: 'busy', blockingTaskTitle: 'Other' },
      'WAITING_SERIAL_SLOT', /^Waiting to land: the landing of “Other” is running on this branch first$/],
    [{ queueBlockCode: 'WAITING_SERIAL_SLOT', blockingJobKind: 'LAND_PROMOTION' },
      'WAITING_SERIAL_SLOT', /the merge into main is running on this branch first/],
    [{ queueBlockCode: 'WAITING_SERIAL_SLOT' }, 'WAITING_SERIAL_SLOT', /another integration job is running/],
    [{ queueBlockCode: 'WAITING_RUNNER', runnerWait: 'OFFLINE', runnerName: 'hpc' }, 'WAITING_RUNNER', /^Waiting for runner hpc: it is offline$/],
    [{ queueBlockCode: 'WAITING_RUNNER', runnerWait: 'DRAINING', runnerName: 'hpc' }, 'WAITING_RUNNER', /draining/],
    [{ queueBlockCode: 'WAITING_RUNNER', runnerWait: 'OUTDATED', runnerName: 'hpc' }, 'WAITING_RUNNER', /does not take integration jobs/],
    [{ queueBlockCode: 'WAITING_RUNNER', runnerWait: 'NO_RUNNER' }, 'WAITING_RUNNER', /workspace has no runner/],
    [{ queueBlockCode: 'CANCELLING' }, 'CANCELLING', /cancel was asked for/],
  ];
  for (const [changes, code, summary] of cases) {
    const reason = taskIntegrationOf(landing(changes), now).landTask?.blockingReason;
    assert.equal(reason?.code, code);
    assert.match(reason?.summary ?? '', summary);
    assert.equal(reason?.openItemId, undefined);
    assert.equal(reason?.jobId, code === 'WAITING_SERIAL_SLOT' ? changes.blockingJobId ?? undefined : undefined);
  }
});

test('a claimed attempt stops its queue wait at the claim and drops the reason', () => {
  const claimedAt = new Date('2026-10-04T11:58:00Z');
  const view = taskIntegrationOf(landing({
    jobState: 'RUNNING', jobPhase: 'CHECK', jobStartedAt: claimedAt, jobClaimedAt: claimedAt,
    jobHeartbeatAt: now, queueBlockCode: 'WAITING_DISPATCH',
  }), now);
  assert.equal(view.state, 'RUNNING');
  assert.equal(view.checksRunningForMs, 180_000);
  assert.equal(view.landTask?.state, 'RUNNING');
  assert.equal(view.landTask?.phase, 'CHECK');
  assert.equal(view.landTask?.waitMs, 180_000);
  assert.equal(view.landTask?.startedAt, claimedAt);
  assert.equal(view.landTask?.heartbeatAt, now);
  assert.equal(view.landTask?.blockingReason, null);
});

test('an attempt sent back to the queue counts from its enqueue, not its first start', () => {
  const view = taskIntegrationOf(landing({
    jobStartedAt: new Date('2026-10-04T11:56:00Z'), queueBlockCode: 'WAITING_TASK_WORK',
  }), now);
  assert.equal(view.landTask?.state, 'QUEUED');
  assert.equal(view.landTask?.waitMs, 360_000);
  assert.equal(view.landTask?.blockingReason?.code, 'WAITING_TASK_WORK');
});

test('a landed attempt keeps its facts while the receipt decides the task state', () => {
  const claimedAt = new Date('2026-10-04T11:57:00Z');
  const view = taskIntegrationOf(landing({
    landing: 'ON_INTEGRATION_LINE', landedAt: now, jobState: 'LANDED', jobPhase: 'VERIFY',
    jobStartedAt: claimedAt, jobClaimedAt: claimedAt, jobFinishedAt: now, jobHeartbeatAt: now,
  }), now);
  assert.equal(view.state, 'ON_INTEGRATION_LINE');
  assert.equal(view.landTask?.state, 'LANDED');
  assert.equal(view.landTask?.finishedAt, now);
  assert.equal(view.landTask?.waitMs, 120_000);
  assert.equal(view.landTask?.blockingReason, null);

  const newer = taskIntegrationOf(landing({ landing: 'ON_UPSTREAM', landedAt: startedAt, jobGeneration: 3 }), now);
  assert.equal(newer.state, 'ON_UPSTREAM', 'a newer generation never un-lands a receipt');
  assert.equal(newer.landTask?.state, 'QUEUED');
  assert.equal(newer.landTask?.generation, '3');
});

test('a stopped attempt names where it stopped beside the item that owns it', () => {
  const claimedAt = new Date('2026-10-04T11:57:00Z');
  const stopped = (changes: Partial<Row>) => taskIntegrationOf(landing({
    jobStartedAt: claimedAt, jobClaimedAt: claimedAt, jobFinishedAt: now,
    itemId: 'item', itemAssignee: 'OWNER', itemCreatedAt: now, ...changes,
  }), now);

  const conflict = stopped({ jobState: 'CONFLICT', jobPhase: 'REBASE', jobConflictCount: 4, itemKind: 'INTEGRATION_CONFLICT' });
  assert.equal(conflict.state, 'CONFLICT');
  assert.equal(conflict.handler, 'OWNER');
  assert.equal(conflict.openItemId, 'item');
  assert.equal(conflict.landTask?.phase, 'REBASE');
  assert.equal(conflict.landTask?.waitMs, 120_000);
  assert.deepEqual(conflict.landTask?.blockingReason, {
    code: 'CONFLICT',
    summary: 'Stopped at a conflict: the task’s branch could not be combined with the target branch (4 conflicting files)',
  });
  assert.match(stopped({ jobState: 'CONFLICT', jobPhase: 'MAIN_SYNC', jobConflictCount: 1, itemKind: 'INTEGRATION_CONFLICT' })
    .landTask?.blockingReason?.summary ?? '', /^Stopped at a conflict: upstream could not be merged into the target branch \(1 conflicting file\)$/);

  const failed = stopped({
    jobState: 'CHECK_FAILED', jobPhase: 'CHECK', itemKind: 'INTEGRATION_CHECK_FAILED',
    jobFailedCheck: { name: 'MERGE_CHECK', exitCode: 1, expectedExitCode: 0, timedOut: false },
  });
  assert.equal(failed.state, 'CHECK_FAILED');
  assert.equal(failed.landTask?.blockingReason?.summary,
    'Checks failed on the combined tree: the merge check exited 1 (expected 0)');
  assert.match(stopped({ jobState: 'CHECK_FAILED', jobFailedCheck: { name: 'TASK_ACCEPTANCE', timedOut: true } })
    .landTask?.blockingReason?.summary ?? '', /the task’s acceptance command timed out$/);

  assert.equal(stopped({ jobState: 'ERROR', jobPhase: 'FETCH', jobErrorCode: 'FETCH_FAILED', itemKind: 'INTEGRATION_ERROR' })
    .landTask?.blockingReason?.summary, 'Landing failed at FETCH: FETCH_FAILED');
});

test('an attempt that never ran stops its clock at the terminal write; no attempt is null', () => {
  const cancelled = taskIntegrationOf(landing({ jobState: 'CANCELLED', jobFinishedAt: startedAt }), now);
  assert.equal(cancelled.landTask?.waitMs, 300_000);
  assert.equal(cancelled.landTask?.blockingReason, null);
  assert.equal(taskIntegrationOf(landing({ jobId: null, jobState: null, jobGeneration: null, jobCreatedAt: null }), now).landTask, null);
  const codeless = taskIntegrationOf(landing({ isCode: false, jobId: null }), now);
  assert.equal(codeless.state, 'NOT_APPLICABLE');
  assert.equal(codeless.landTask, null);
});

test('a reopened task keeps its last attempt readable without being queued again', () => {
  const view = taskIntegrationOf(landing({
    taskStatus: 'OPEN', jobState: 'CONFLICT', jobPhase: 'REBASE', jobFinishedAt: startedAt,
  }), now);
  assert.equal(view.state, 'NOT_APPLICABLE');
  assert.equal(view.landTask?.state, 'CONFLICT');
  assert.equal(view.landTask?.blockingReason?.code, 'CONFLICT');
});
