import assert from 'node:assert/strict';
import test from 'node:test';

import { turnOutcomeOf, type TurnOutcomeInput } from './turn-outcome';

// The translation of the runner's reported turn status into the turn outcome (design §4.2), alone.
const base: TurnOutcomeInput = {
  kind: 'message',
  status: 'SUCCEEDED',
  regionStopped: false,
  swallowed: false,
  unanswered: false,
  failureError: 'the failure',
  error: undefined,
  result: 'the reply',
};

test('each runner word on a message turn', () => {
  assert.deepEqual(turnOutcomeOf(base), { outcome: 'ANSWERED', error: null });
  assert.deepEqual(turnOutcomeOf({ ...base, status: 'FAILED', error: 'boom' }), { outcome: 'FAILED', error: 'the failure' });
  assert.deepEqual(turnOutcomeOf({ ...base, status: 'INTERRUPTED', error: 'stopped' }), { outcome: 'INTERRUPTED', error: 'stopped' });
  assert.deepEqual(turnOutcomeOf({ ...base, status: 'INTERRUPTED' }), { outcome: 'INTERRUPTED', error: null });
  assert.deepEqual(turnOutcomeOf({ ...base, status: 'CANCELLED', error: 'cancelled' }), { outcome: 'CANCELLED', error: 'cancelled' });
  assert.deepEqual(turnOutcomeOf({ ...base, status: 'CANCELLED' }), { outcome: 'CANCELLED', error: null });
});

test('a shell turn is a turn of work too', () => {
  assert.deepEqual(turnOutcomeOf({ ...base, kind: 'shell', status: 'FAILED' }), { outcome: 'FAILED', error: 'the failure' });
});

test('a region stop is an interrupt, whatever the runner word, with the stopped sentence', () => {
  assert.deepEqual(
    turnOutcomeOf({ ...base, regionStopped: true, status: 'SUCCEEDED', result: 'Stopped in this region.' }),
    { outcome: 'INTERRUPTED', error: 'Stopped in this region.' },
  );
  assert.deepEqual(
    turnOutcomeOf({ ...base, regionStopped: true, status: 'FAILED', error: 'region', result: 'reply' }),
    { outcome: 'INTERRUPTED', error: 'region' },
  );
  assert.deepEqual(turnOutcomeOf({ ...base, regionStopped: true, result: undefined }), { outcome: 'INTERRUPTED', error: null });
});

test('a swallowed delivery is a failure even when the runner said SUCCEEDED', () => {
  assert.deepEqual(
    turnOutcomeOf({ ...base, swallowed: true, unanswered: true, failureError: 'Nothing answered this message' }),
    { outcome: 'FAILED', error: 'Nothing answered this message' },
  );
});

test('a success nothing answered has not ended', () => {
  assert.equal(turnOutcomeOf({ ...base, unanswered: true }), null);
});

test('a status that is not a turn end records nothing', () => {
  assert.equal(turnOutcomeOf({ ...base, status: 'RUNNING' }), null);
});

test('a turn that is not a turn of work has no outcome', () => {
  for (const kind of [undefined, 'steer', 'withdraw', 'control', 'some_future_kind']) {
    assert.equal(turnOutcomeOf({ ...base, kind, status: 'FAILED' }), null, String(kind));
    assert.equal(turnOutcomeOf({ ...base, kind, regionStopped: true }), null, String(kind));
  }
});
