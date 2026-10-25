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
  recapText: null,
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

// ── the body: recap first, the rules line when there is none ────────────────

test('a recap is what the alert says when there is one', () => {
  assert.deepEqual(
    settleAlert({
      ...base,
      status: RunStatus.SUCCEEDED,
      recapText: 'Fixed the redirect; tests pass. Next: ship it.',
    }),
    { kind: 'finished', body: 'Fixed the redirect; tests pass. Next: ship it.' },
  );
});

test('without a recap the rules line is unchanged', () => {
  assert.deepEqual(settleAlert({ ...base, status: RunStatus.SUCCEEDED }), {
    kind: 'finished',
    body: 'Finished',
  });
  assert.deepEqual(settleAlert({ ...base, error: 'API Error: 500' }), {
    kind: 'failed',
    body: 'Failed · API Error: 500',
  });
});

test('a recap longer than a notification carries is cut, not refused', () => {
  const long = 'x'.repeat(400);
  assert.deepEqual(settleAlert({ ...base, status: RunStatus.SUCCEEDED, recapText: long }), {
    kind: 'finished',
    body: `${'x'.repeat(199)}…`,
  });
});

test('a failure with a recap still says what happened through the recap', () => {
  // The recap knows the ending it was written for; the error line is what "Finished" cannot say
  // when a run dies, so the recap takes that slot too.
  const alert = settleAlert({
    ...base,
    error: 'API Error: 529 overloaded_error',
    recapText: 'Ran out of provider capacity mid-migration; nothing was written.',
  });
  assert.equal(alert?.kind, 'failed');
  assert.equal(alert?.body, 'Ran out of provider capacity mid-migration; nothing was written.');
});

test('an empty recap is not a recap, so the rules line still speaks', () => {
  assert.deepEqual(settleAlert({ ...base, status: RunStatus.SUCCEEDED, recapText: '  \n ' }), {
    kind: 'finished',
    body: 'Finished',
  });
});

test('a recap never announces a settlement that is not worth one', () => {
  // Whether to interrupt is the rules' decision alone: a recap only changes what an alert that
  // was already going to be sent says.
  assert.equal(settleAlert({ ...base, status: RunStatus.CANCELLED, recapText: 'Did things.' }), null);
  assert.equal(
    settleAlert({ ...base, retryAt: new Date(), recapText: 'Did things.' }),
    null,
  );
  assert.equal(
    settleAlert({ ...base, completedAt: new Date(), recapText: 'Did things.' }),
    null,
  );
});
