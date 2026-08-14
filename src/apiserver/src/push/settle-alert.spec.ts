import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RunStatus } from '@prisma/client';
import { settleAlert, SettleInput } from './settle-alert';

const base: SettleInput = {
  status: RunStatus.FAILED,
  retryAt: null,
  completedAt: null,
  deletedAt: null,
  error: null,
};

test('a run that succeeded on its own is announced', () => {
  assert.deepEqual(settleAlert({ ...base, status: RunStatus.SUCCEEDED }), {
    kind: 'finished',
    body: 'Finished',
  });
});

test('a task_done session is announced even though the server filed it in Completed', () => {
  // endParked() sets completedAt as part of ending the session, so the most important
  // notification of all arrives on an already-filed row.
  const alert = settleAlert({
    ...base,
    status: RunStatus.SUCCEEDED,
    completedAt: new Date(),
  });
  assert.equal(alert?.kind, 'finished');
});

test('a failure carries the first line of its error', () => {
  assert.deepEqual(settleAlert({ ...base, error: '\n  API Error: 500\nstack frame\n' }), {
    kind: 'failed',
    body: 'Failed · API Error: 500',
  });
});

test('a failure with no error text still says what happened', () => {
  assert.deepEqual(settleAlert({ ...base, error: '   \n\n' }), { kind: 'failed', body: 'Failed' });
});

test('a long error line is truncated to a lock-screen excerpt', () => {
  const alert = settleAlert({ ...base, error: 'x'.repeat(400) });
  assert.equal(alert?.body.length, 'Failed · '.length + 120);
  assert.ok(alert?.body.endsWith('…'));
});

test('an armed retry is not an outcome', () => {
  assert.equal(settleAlert({ ...base, retryAt: new Date() }), null);
  assert.equal(settleAlert({ ...base, status: RunStatus.SUCCEEDED, retryAt: new Date() }), null);
});

test('a trashed session is never announced', () => {
  assert.equal(settleAlert({ ...base, deletedAt: new Date() }), null);
  assert.equal(settleAlert({ ...base, status: RunStatus.SUCCEEDED, deletedAt: new Date() }), null);
});

test('a failure its owner already filed is one they have seen', () => {
  assert.equal(settleAlert({ ...base, completedAt: new Date() }), null);
});

test("the user's own deliberate ends are not reported back to them", () => {
  // CANCELLED is the single terminal status every deliberate end settles to.
  assert.equal(settleAlert({ ...base, status: RunStatus.CANCELLED }), null);
});

test('non-terminal statuses are not settlements', () => {
  for (const status of [
    RunStatus.PENDING,
    RunStatus.RUNNING,
    RunStatus.AWAITING_INPUT,
    RunStatus.INTERRUPTED,
  ]) {
    assert.equal(settleAlert({ ...base, status }), null, status);
  }
});
