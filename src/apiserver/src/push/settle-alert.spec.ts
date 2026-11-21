import assert from 'node:assert/strict';
import { test } from 'node:test';
import { settleAlert, SettleInput } from './settle-alert';

const AT = new Date('2026-11-21T00:00:00.000Z');

/** A session released with this cause, as its writer leaves it (common/session-release.ts). */
const released = (releaseCause: string) => ({ finishedAt: AT, releaseCause });

/** A session still held: no release column, no cause. */
const held = { finishedAt: null, releaseCause: null };

// Released after a failed turn: what turn-complete writes beside FAILED.
const base: SettleInput = {
  ...released('turn_failed'),
  retryAt: null,
  completedAt: null,
  deletedAt: null,
  error: null,
  recapText: null,
};

test('a run that succeeded on its own is announced', () => {
  assert.deepEqual(settleAlert({ ...base, ...released('task_done') }), {
    kind: 'finished',
    body: 'Finished',
  });
});

test('a task_done session is announced even though the server filed it in Completed', () => {
  // endParked() sets completedAt as part of ending the session, so the most important
  // notification of all arrives on an already-filed row.
  const alert = settleAlert({
    ...base,
    ...released('task_done'),
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
  assert.equal(settleAlert({ ...base, ...released('task_done'), retryAt: new Date() }), null);
});

test('a trashed session is never announced', () => {
  assert.equal(settleAlert({ ...base, deletedAt: new Date() }), null);
  assert.equal(settleAlert({ ...base, ...released('task_done'), deletedAt: new Date() }), null);
});

test('a failure its owner already filed is one they have seen', () => {
  assert.equal(settleAlert({ ...base, completedAt: new Date() }), null);
});

test("the user's own deliberate ends are not reported back to them", () => {
  // CANCELLED is the single terminal status every deliberate end settles to.
  assert.equal(settleAlert({ ...base, ...released('ended') }), null);
});

test('non-terminal statuses are not settlements', () => {
  // PENDING, RUNNING, AWAITING_INPUT and INTERRUPTED are all held.
  assert.equal(settleAlert({ ...base, ...held }), null);
});

// ── the body: recap first, the rules line when there is none ────────────────

test('a recap is what the alert says when there is one', () => {
  assert.deepEqual(
    settleAlert({
      ...base,
      ...released('task_done'),
      recapText: 'Fixed the redirect; tests pass. Next: ship it.',
    }),
    { kind: 'finished', body: 'Fixed the redirect; tests pass. Next: ship it.' },
  );
});

test('without a recap the rules line is unchanged', () => {
  assert.deepEqual(settleAlert({ ...base, ...released('task_done') }), {
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
  assert.deepEqual(settleAlert({ ...base, ...released('task_done'), recapText: long }), {
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
  assert.deepEqual(settleAlert({ ...base, ...released('task_done'), recapText: '  \n ' }), {
    kind: 'finished',
    body: 'Finished',
  });
});

test('a recap never announces a settlement that is not worth one', () => {
  // Whether to interrupt is the rules' decision alone: a recap only changes what an alert that
  // was already going to be sent says.
  assert.equal(settleAlert({ ...base, ...released('ended'), recapText: 'Did things.' }), null);
  assert.equal(
    settleAlert({ ...base, retryAt: new Date(), recapText: 'Did things.' }),
    null,
  );
  assert.equal(
    settleAlert({ ...base, completedAt: new Date(), recapText: 'Did things.' }),
    null,
  );
});

// ── plan step 4.8 (decision D2): the alert reads the release and its cause ───────────────────────

test('every stored status and release cause: the alert before (from the status) and after (from the cause)', () => {
  // [status, release_cause, filed, alert before, alert after]. Before is the rule this function had until plan step
  // 4.8, which read the terminal status value: SUCCEEDED finished, FAILED and not filed failed, anything else nothing.
  // Every row a user can be alerted for today answers the same. The rows that differ are noted: none of them can
  // publish the final STATUS that calls this (realtime.service.ts), so no alert anybody receives changes.
  const failures = ['turn_failed', 'runner_lost', 'setup_failed', 'engine_failed', 'end_not_honored', 'import_failed'];
  const stops = ['task_cancelled', 'ended', 'completed', 'deleted', 'cancelled', 'idle', 'orphaned', 'engine_exited'];
  type Kind = 'finished' | 'failed' | null;
  const rows: Array<[string, string | null, boolean, Kind, Kind]> = [
    ...['PENDING', 'RUNNING', 'AWAITING_INPUT', 'INTERRUPTED'].flatMap((status): Array<[string, null, boolean, Kind, Kind]> => [
      [status, null, false, null, null],
      [status, null, true, null, null],
    ]),
    ['SUCCEEDED', 'task_done', false, 'finished', 'finished'],
    ['SUCCEEDED', 'task_done', true, 'finished', 'finished'],
    ['SUCCEEDED', 'landing_settled', true, 'finished', 'finished'],
    // Differs: the 318 rows 1262's backfill wrote in June (all on DONE tasks), and a runner reporting success with no
    // end requested, which no runner the server accepts sends (reportsSuccessWithNoEnd logs one). A plain
    // conversation is ended, never finished.
    ['SUCCEEDED', 'engine_exited', false, 'finished', null],
    // Differs: the 4 filed SUCCEEDED rows production holds with this cause; no writer stores it beside SUCCEEDED.
    ['SUCCEEDED', 'completed', true, 'finished', null],
    ...failures.flatMap((cause): Array<[string, string, boolean, Kind, Kind]> => [
      ['FAILED', cause, false, 'failed', 'failed'],
      ['FAILED', cause, true, null, null],
    ]),
    ...stops.map((cause): [string, string, boolean, Kind, Kind] => ['CANCELLED', cause, false, null, null]),
    // Differs: a LANDING container that settled without landing. Nothing publishes a final STATUS for a container
    // (landing-session.ts writes the row and publishes nothing, and no runner holds one), so it is never alerted.
    ['CANCELLED', 'landing_settled', true, null, 'finished'],
  ];
  const DIFFERS = new Set(['SUCCEEDED engine_exited', 'SUCCEEDED completed', 'CANCELLED landing_settled']);
  for (const [status, cause, filed, before, after] of rows) {
    const input: SettleInput = {
      ...base,
      ...(cause === null ? held : released(cause)),
      completedAt: filed ? AT : null,
    };
    const what = `${status} ${cause ?? '(held)'}${filed ? ' filed' : ''}`;
    assert.equal(settleAlert(input)?.kind ?? null, after, what);
    if (!DIFFERS.has(`${status} ${cause}`)) assert.equal(after, before, `${what} must answer as before`);
  }
});
