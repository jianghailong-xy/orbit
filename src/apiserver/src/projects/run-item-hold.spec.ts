import assert from 'node:assert/strict';
import test from 'node:test';

import { runItemFallbackCopy, runItemHold, type RunItemFacts } from './run-item-hold';

const dueAt = new Date('2026-11-10T02:00:00Z');
const readAt = new Date(dueAt.getTime() - 1);
const facts: RunItemFacts = {
  kind: 'CONFIRMATION', project: { automatic: true, coordinatorEnabled: true },
  coordinatorSessionId: 'coordinator', coordinatorSession: {
    status: 'AWAITING_INPUT', endReason: null, completedAt: null, archivedAt: null,
    deletedAt: null, cancelRequestedAt: null, retryAt: null,
  },
  answered: false, delivery: 'PENDING', deliveryRefusal: null, deliveredTurn: null,
  stoppedWithoutAnswer: false, dueAt,
};

test('F2 precedence: answered items never fall back; switched-off routing precedes missing coordinator', () => {
  const off = { ...facts, project: { automatic: true, coordinatorEnabled: false }, coordinatorSessionId: null };
  assert.deepEqual(runItemHold({ ...off, answered: true }, dueAt), { place: 'ANSWERED' });
  assert.deepEqual(runItemHold(off, readAt), { place: 'FALLBACK', reason: 'AUTOMATIC_OFF' });
  assert.deepEqual(runItemHold({ ...off, kind: 'NOTIFY', coordinatorSessionId: 'coordinator' }, readAt), {
    place: 'HELD', coordinatorSessionId: 'coordinator', dueAt,
  });
});

test('F2 delivery refusal mapping, deleted session, stopped and unread delivery', () => {
  for (const code of ['NO_COORDINATOR', 'REVIEWER_ENDED', 'AUTOMATIC_OFF', 'COORDINATOR_PAUSED', 'SESSION_UNAVAILABLE', null]) {
    assert.deepEqual(runItemHold({ ...facts, delivery: 'REFUSED', deliveryRefusal: code }, readAt), {
      place: 'FALLBACK', reason: code && code !== 'SESSION_UNAVAILABLE' ? code : 'UNREACHABLE',
    });
  }
  assert.deepEqual(runItemHold({ ...facts, coordinatorSession: null }, readAt), { place: 'FALLBACK', reason: 'REVIEWER_ENDED' });
  for (const change of [
    { stoppedWithoutAnswer: true },
    { delivery: 'DELIVERED' as const },
    { delivery: 'DELIVERED' as const, deliveredTurn: { status: 'ANSWERED', deliveredAt: null } },
  ]) {
    assert.deepEqual(runItemHold({ ...facts, ...change }, readAt), { place: 'FALLBACK', reason: 'REVIEWER_STOPPED' });
  }
});

test('F3 paused confirmation holds even when drained unread, but only until F4 deadline', () => {
  for (const pause of [{ status: 'FAILED' }, { retryAt: new Date() }]) {
    const paused = { ...facts, coordinatorSession: { ...facts.coordinatorSession!, ...pause }, delivery: 'DELIVERED' as const };
    assert.deepEqual(runItemHold(paused, readAt), { place: 'HELD', coordinatorSessionId: 'coordinator', dueAt });
    assert.deepEqual(runItemHold(paused, dueAt), { place: 'FALLBACK', reason: 'TIMED_OUT' });
    for (const kind of ['QUESTION', 'NOTIFY'] as const) {
      assert.deepEqual(runItemHold({ ...paused, kind }, readAt), { place: 'FALLBACK', reason: 'REVIEWER_ENDED' });
    }
  }
});

test('F5 fallback copy is Orbit-authored and includes the frozen window', () => {
  assert.deepEqual(runItemFallbackCopy('TIMED_OUT', '2 hours'), {
    label: 'Not reviewed by the coordinator', detail: 'No answer within 2 hours.',
  });
  for (const reason of ['REVIEWER_ENDED', 'REVIEWER_STOPPED', 'COORDINATOR_PAUSED', 'AUTOMATIC_OFF', 'NO_COORDINATOR', 'UNREACHABLE'] as const) {
    assert.ok(runItemFallbackCopy(reason, '2 hours').detail.endsWith('.'));
  }
});
