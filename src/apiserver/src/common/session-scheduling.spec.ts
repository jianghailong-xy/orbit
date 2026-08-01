import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RunStatus } from '@prisma/client';
import {
  ACTIVE_TURN_STATUSES,
  OPEN_SESSION_STATUSES,
  runnerOfflineIsFatal,
  statusAfterTurnCompleted,
  statusAfterTurnEnqueued,
} from './session-scheduling';

test('only RUNNING consumes an active-turn slot', () => {
  assert.deepEqual(ACTIVE_TURN_STATUSES, [RunStatus.RUNNING]);
});

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
  assert.equal(runnerOfflineIsFatal(RunStatus.RUNNING), true);
  assert.equal(runnerOfflineIsFatal(RunStatus.AWAITING_INPUT), false);
  assert.equal(runnerOfflineIsFatal(RunStatus.INTERRUPTED), false);
});
