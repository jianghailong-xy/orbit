import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SessionEndReason } from '@orbit/shared';
import { releaseCauseOfEndReason, SESSION_RELEASE_CAUSES } from '../common/session-release';
import { CAUSE_READING, releaseFactsOf } from '../common/session-release-shapes.fixture';
import { settleAlert, SettleInput } from './settle-alert';

const AT = new Date('2026-11-21T00:00:00.000Z');

// The release facts as the writers store them (common/session-release.ts): a release that finished the work, one by
// a failure, one somebody asked for (a person ended the session), and a session still held.
const finishedWork = releaseFactsOf('task_done', AT);
const failedRelease = releaseFactsOf('turn_failed', AT);
const endedByUser = releaseFactsOf(releaseCauseOfEndReason(SessionEndReason.ENDED), AT);
const held = releaseFactsOf(null);

const base: SettleInput = {
  ...failedRelease,
  retryAt: null,
  completedAt: null,
  deletedAt: null,
  error: null,
  recapText: null,
};

test('a run that succeeded on its own is announced', () => {
  assert.deepEqual(settleAlert({ ...base, ...finishedWork }), {
    kind: 'finished',
    body: 'Finished',
  });
});

test('a task_done session is announced even though the server filed it in Completed', () => {
  // endParked() sets completedAt as part of ending the session, so the most important
  // notification of all arrives on an already-filed row.
  const alert = settleAlert({
    ...base,
    ...finishedWork,
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
  assert.equal(settleAlert({ ...base, ...finishedWork, retryAt: new Date() }), null);
});

test('a trashed session is never announced', () => {
  assert.equal(settleAlert({ ...base, deletedAt: new Date() }), null);
  assert.equal(settleAlert({ ...base, ...finishedWork, deletedAt: new Date() }), null);
});

test('a failure its owner already filed is one they have seen', () => {
  assert.equal(settleAlert({ ...base, completedAt: new Date() }), null);
});

test("the user's own deliberate ends are not reported back to them", () => {
  // CANCELLED is the single terminal status every deliberate end settles to.
  assert.equal(settleAlert({ ...base, ...endedByUser }), null);
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
      ...finishedWork,
      recapText: 'Fixed the redirect; tests pass. Next: ship it.',
    }),
    { kind: 'finished', body: 'Fixed the redirect; tests pass. Next: ship it.' },
  );
});

test('without a recap the rules line is unchanged', () => {
  assert.deepEqual(settleAlert({ ...base, ...finishedWork }), {
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
  assert.deepEqual(settleAlert({ ...base, ...finishedWork, recapText: long }), {
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
  assert.deepEqual(settleAlert({ ...base, ...finishedWork, recapText: '  \n ' }), {
    kind: 'finished',
    body: 'Finished',
  });
});

test('a recap never announces a settlement that is not worth one', () => {
  // Whether to interrupt is the rules' decision alone: a recap only changes what an alert that
  // was already going to be sent says.
  assert.equal(settleAlert({ ...base, ...endedByUser, recapText: 'Did things.' }), null);
  assert.equal(
    settleAlert({ ...base, retryAt: new Date(), recapText: 'Did things.' }),
    null,
  );
  assert.equal(
    settleAlert({ ...base, completedAt: new Date(), recapText: 'Did things.' }),
    null,
  );
});

// ── plan step 4.8 (decision D2): the alert reads the release, never the terminal status ──────────

test('every stored status and release: the alert before (from the status) and after (from the release)', () => {
  // Before is the rule this function had until plan step 4.8, which read the terminal status value: SUCCEEDED
  // finished, FAILED and not filed failed, anything else nothing. Every release the writers store answers as before.
  // The only rows that differ are a SUCCEEDED release that did not finish the work, and a CANCELLED one that did: in
  // production the 318 SUCCEEDED rows 1262's backfill wrote in June with an engine that exited by itself (all on DONE
  // tasks), the 4 filed SUCCEEDED rows released as completed, and a landing container that settled without landing.
  // No writer stores the first two today (a runner reporting success with no end requested is logged by
  // reportsSuccessWithNoEnd, and no runner the server accepts sends it), and nothing publishes the final STATUS that
  // calls this for a landing container, so no alert anybody receives changes. A plain conversation never finishes.
  type Kind = 'finished' | 'failed' | null;
  const differs: string[] = [];
  for (const filed of [false, true]) {
    for (const status of ['PENDING', 'RUNNING', 'AWAITING_INPUT', 'INTERRUPTED']) {
      assert.equal(settleAlert({ ...base, ...held, completedAt: filed ? AT : null }), null, status);
    }
    for (const cause of SESSION_RELEASE_CAUSES) {
      // Every writer writes FAILED exactly with a failure cause (the reading before R3, CAUSE_READING).
      for (const status of CAUSE_READING.failed(cause) ? ['FAILED'] : ['SUCCEEDED', 'CANCELLED']) {
        const before: Kind = status === 'SUCCEEDED' ? 'finished' : status === 'FAILED' && !filed ? 'failed' : null;
        const after = settleAlert({ ...base, ...releaseFactsOf(cause, AT), completedAt: filed ? AT : null })?.kind ?? null;
        const what = `${status} ${cause}${filed ? ' filed' : ''}`;
        // W7 (design §12.3, removal step R4): an end that was asked for and not honoured is a stop, not a failure, so
        // it is announced as nothing. It was 'failed' (unfiled) while the release cause was read.
        const expected: Kind = cause === 'end_not_honored'
          ? null
          : CAUSE_READING.finished(cause) ? 'finished' : before === 'finished' ? null : before;
        assert.equal(after, expected, what);
        if (after !== before) differs.push(what);
      }
    }
  }
  const finishing = new Set<string>(CAUSE_READING.workFinishedCauses);
  const expectedDiffers = [
    ...[false, true].flatMap((filed) => SESSION_RELEASE_CAUSES
      .filter((cause) => !CAUSE_READING.failed(cause))
      .map((cause) => `${finishing.has(cause) ? 'CANCELLED' : 'SUCCEEDED'} ${cause}${filed ? ' filed' : ''}`)),
    // W7: before, from the status, an unfiled FAILED one was a failure.
    'FAILED end_not_honored',
  ];
  assert.deepEqual(differs.sort(), expectedDiffers.sort());
});
