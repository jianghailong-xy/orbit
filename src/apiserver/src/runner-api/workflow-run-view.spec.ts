import assert from 'node:assert/strict';
import { test } from 'node:test';
import { workflowRunView } from './workflow-run';

const row = {
  id: 'wf-1',
  toolUseId: 'toolu_workflow',
  name: 'review-changes',
  description: 'Review the diff by dimension',
  phases: ['Review', 'Verify'],
  status: 'RUNNING',
  callsDone: 0,
  callsFailed: 0,
  costUsd: 0,
  maxCostUsd: null,
  error: null,
  createdAt: new Date('2026-11-19T10:00:00.000Z'),
  endedAt: null,
};

test("a running workflow's counts and spend are its calls' so far: done, ended otherwise, and what the ended ones cost", () => {
  const view = workflowRunView({ ...row, maxCostUsd: 5 }, [
    { status: 'DONE', costUsd: 0.25 },
    { status: 'FAILED', costUsd: 0.5 },
    { status: 'STOPPED', costUsd: 0 },
    { status: 'RUNNING', costUsd: 0 },
  ]);
  assert.deepEqual(view, {
    id: 'wf-1', toolUseId: 'toolu_workflow', name: 'review-changes', description: 'Review the diff by dimension',
    phases: ['Review', 'Verify'], status: 'RUNNING', callsDone: 1, callsFailed: 2, costUsd: 0.75, maxCostUsd: 5,
    error: null, createdAt: '2026-11-19T10:00:00.000Z', endedAt: null,
  });
});

test('a workflow opened with an empty description has none', () => {
  assert.equal(workflowRunView({ ...row, description: '' }, []).description, null);
});

test("an ended workflow reads what the runner reported for the whole script, and a finished one's empty error is none", () => {
  const ended = { ...row, status: 'DONE', callsDone: 3, callsFailed: 1, costUsd: 1.5, error: '', endedAt: new Date('2026-11-19T10:04:00.000Z') };
  const view = workflowRunView(ended, [{ status: 'DONE', costUsd: 9 }]);
  assert.deepEqual(
    [view.status, view.callsDone, view.callsFailed, view.costUsd, view.error, view.endedAt],
    ['DONE', 3, 1, 1.5, null, '2026-11-19T10:04:00.000Z'],
  );
  const failed = workflowRunView({ ...ended, status: 'FAILED', error: 'TypeError: r.findings is undefined' }, []);
  assert.equal(failed.error, 'TypeError: r.findings is undefined');
});
