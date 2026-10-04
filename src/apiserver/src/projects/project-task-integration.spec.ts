import assert from 'node:assert/strict';
import { test } from 'node:test';
import { taskIntegrationOf } from './project-task-integration';

const now = new Date('2026-10-04T12:01:00Z');
const startedAt = new Date('2026-10-04T12:00:00Z');
type Row = Parameters<typeof taskIntegrationOf>[0];

function row(changes: Partial<Row> = {}): Row {
  return {
    taskId: 'task', taskStatus: 'DONE', landing: 'NOT_KNOWN', isCode: true, lineStarted: true,
    jobId: 'retry', jobState: 'RUNNING', jobPhase: 'CHECK',
    jobStartedAt: startedAt, jobCreatedAt: startedAt, jobFinishedAt: null,
    itemId: 'failure', itemKind: 'INTEGRATION_CHECK_FAILED', itemAssignee: 'COORDINATOR',
    itemCreatedAt: new Date('2026-10-04T11:59:00Z'), itemHandlingJobId: 'retry',
    landedAt: null, ...changes,
  };
}

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
  }
  assert.equal(taskIntegrationOf(row({ jobId: null, jobState: null,
    itemId: null, itemKind: null, itemHandlingJobId: null }), now).state, 'QUEUED');
});
