import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RunStatus } from '@orbit/shared';
import {
  OPEN_SESSION_STATUSES,
  runnerOfflineIsFatal,
  statusAfterTurnCompleted,
  statusAfterTurnEnqueued,
  turnStateAfterTurnCompleted,
  turnStateAfterTurnEnqueued,
} from './session-scheduling';
import { turnStateOfWord } from '../sessions/session-turn-state';

test('reclaim retains every open session while only RUNNING is active', () => {
  assert.deepEqual(OPEN_SESSION_STATUSES, [
    RunStatus.PENDING,
    RunStatus.RUNNING,
    RunStatus.AWAITING_INPUT,
    RunStatus.INTERRUPTED,
  ]);
});

test('enqueueing onto an idle session queues it for a fresh slot', () => {
  assert.equal(statusAfterTurnEnqueued(RunStatus.AWAITING_INPUT), RunStatus.PENDING);
  assert.equal(statusAfterTurnEnqueued(RunStatus.INTERRUPTED), RunStatus.PENDING);
  assert.equal(statusAfterTurnEnqueued(RunStatus.RUNNING), RunStatus.RUNNING);
  assert.equal(statusAfterTurnEnqueued(RunStatus.PENDING), RunStatus.PENDING);
});

test('turn completion retains a slot only for an already queued executable turn', () => {
  assert.equal(statusAfterTurnCompleted(true), RunStatus.RUNNING);
  assert.equal(statusAfterTurnCompleted(false), RunStatus.AWAITING_INPUT);
});

test('an offline runner does not invalidate an idle warm-or-cold session', () => {
  assert.equal(runnerOfflineIsFatal('IN_FLIGHT'), true);
  assert.equal(runnerOfflineIsFatal(null), false);
  assert.equal(runnerOfflineIsFatal('ABANDONED'), false);
  assert.equal(runnerOfflineIsFatal('QUEUED'), false);
});

test('the turn-state helpers give the turn state of the word the word helpers give, one for one', () => {
  for (const word of [RunStatus.PENDING, RunStatus.RUNNING, RunStatus.AWAITING_INPUT, RunStatus.INTERRUPTED]) {
    assert.equal(turnStateAfterTurnEnqueued(turnStateOfWord(word)), turnStateOfWord(statusAfterTurnEnqueued(word)), word);
  }
  for (const queued of [true, false]) {
    assert.equal(turnStateAfterTurnCompleted(queued), turnStateOfWord(statusAfterTurnCompleted(queued)));
  }
});
