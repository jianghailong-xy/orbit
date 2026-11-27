/**
 * Which refused runs are replaced, and the bound on it (docs/routing-account-health-design.md §7.3): a run its account
 * refused at admission is replaced for every task, at most REPLACEMENTS_PER_HOUR an hour, a refused trial excepted.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { REPLACEMENTS_PER_HOUR, replacementComment, replacementOf, replacementRoom, type RefusedRun } from './refused-run-replacement';
import { TASK_RUN_TRIGGER, isAutomaticTaskRunToken } from './task-run-identity';

const refused = (over: Partial<RefusedRun> = {}): RefusedRun => ({
  status: 'FAILED', taskId: 't1', startsTaskWork: true, runSource: 'MANUAL', failureKind: 'ACCOUNT_ACTION_REQUIRED',
  error: 'Cursor said: "Add a payment method to continue."', accountHealthEffect: 'BLOCKED', admissionFailure: true,
  retryAt: null, ...over,
});

test('replacementOf: a run its account refused at admission is replaced, a refused trial outside the bound', () => {
  assert.equal(replacementOf(refused()), 'REPLACE');
  assert.equal(replacementOf(refused({ accountHealthEffect: 'TRIAL' })), 'TRIAL');
  // The breaker's first strike: unclassified, health acted on it.
  assert.equal(replacementOf(refused({ failureKind: null, error: 'Error: something', accountHealthEffect: 'SUSPECT' })), 'REPLACE');
  // A capacity or usage-limit refusal the runner measured at admission.
  assert.equal(replacementOf(refused({ failureKind: 'CAPACITY', accountHealthEffect: null })), 'REPLACE');
  assert.equal(replacementOf(refused({ failureKind: 'USAGE_LIMIT', accountHealthEffect: null })), 'REPLACE');
  // Every task, auto-run or not: nothing about the task's auto-run is read, and an automatic run's source is replaced too.
  assert.equal(replacementOf(refused({ runSource: 'TASK_LIST_AUTO' })), 'REPLACE');
  assert.equal(replacementOf(refused({ runSource: 'PROJECT_COORDINATOR' })), 'REPLACE');
});

test('replacementOf: everything else keeps today\'s behaviour', () => {
  assert.equal(replacementOf(refused({ status: 'SUCCEEDED' })), null);
  assert.equal(replacementOf(refused({ status: 'CANCELLED' })), null);
  assert.equal(replacementOf(refused({ taskId: null })), null);
  assert.equal(replacementOf(refused({ startsTaskWork: false })), null);
  assert.equal(replacementOf(refused({ runSource: 'SCHEDULE' })), null, "a schedule's run is its pipeline's");
  assert.equal(replacementOf(refused({ retryAt: new Date() })), null, 'AutoRetryService resumes that very Session');
  // An ordinary failure counts against the task and is not replaced.
  assert.equal(replacementOf(refused({ failureKind: null, error: 'tests failed', accountHealthEffect: null, admissionFailure: false })), null);
  assert.equal(replacementOf(refused({ failureKind: 'REQUEST_REFUSED', accountHealthEffect: null })), null);
  // A lost connection is re-sent in place.
  assert.equal(replacementOf(refused({ failureKind: 'TRANSPORT', accountHealthEffect: null })), null);
  // A usage limit an hour into the work: not a refusal at admission.
  assert.equal(replacementOf(refused({ failureKind: 'USAGE_LIMIT', accountHealthEffect: null, admissionFailure: false })), null);
  assert.equal(replacementOf(refused({ failureKind: 'USAGE_LIMIT', accountHealthEffect: null, admissionFailure: null })), null);
});

test('replacementRoom: at most three an hour, and the window frees when the oldest ages out', () => {
  const now = new Date(Date.UTC(2026, 10, 23, 12, 0));
  const ago = (minutes: number) => new Date(now.getTime() - minutes * 60_000);
  assert.equal(REPLACEMENTS_PER_HOUR, 3);
  assert.deepEqual(replacementRoom([], now), { room: true });
  assert.deepEqual(replacementRoom([ago(10), ago(5)], now), { room: true });
  assert.deepEqual(replacementRoom([ago(50), ago(10), ago(5)], now), { room: false, until: new Date(now.getTime() + 10 * 60_000) });
  // Older than an hour does not count.
  assert.deepEqual(replacementRoom([ago(70), ago(10), ago(5)], now), { room: true });
  // More than three: the place frees when the third newest ages out.
  assert.deepEqual(replacementRoom([ago(55), ago(40), ago(10), ago(5)], now), { room: false, until: new Date(now.getTime() + 20 * 60_000) });
});

test('the replacement request is named after the refused run; a trial\'s is its own kind', () => {
  assert.equal(TASK_RUN_TRIGGER.replacement('t1', 's1', false), 'replace:t1:s1');
  assert.equal(TASK_RUN_TRIGGER.replacement('t1', 's1', true), 'replace-trial:t1:s1');
  assert.equal(isAutomaticTaskRunToken('replace:t1:s1'), true);
  assert.equal(isAutomaticTaskRunToken('replace-trial:t1:s1'), true);
  assert.match(replacementComment(2), /^\*\*Replaced run 2, which its account refused \(recorded by Orbit\)\*\*/);
});
