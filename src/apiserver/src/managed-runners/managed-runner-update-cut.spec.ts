import assert from 'node:assert/strict';
import { test } from 'node:test';

import { RunEventType, type NormalizedRunEvent } from '@orbit/shared';

import { cutByUpdateNow, markUpdateNowCuts, type UpdateNowWindow } from './managed-runner-update-cut';

const ASKED = new Date('2026-11-22T10:00:00.000Z');
const at = (seconds: number) => new Date(ASKED.getTime() + seconds * 1000);
const window = (change: Partial<UpdateNowWindow> = {}): UpdateNowWindow => ({
  updateRequestedAt: ASKED, updateCompletedAt: null, updateInterruptTurns: true, ...change,
});

test('a cut is the owner\'s Update Now\'s from the request on, while it is in progress, and up to its end', () => {
  assert.equal(cutByUpdateNow(window(), at(100)), true, 'the runner\'s drain ran out after the stop was asked');
  assert.equal(cutByUpdateNow(window(), at(0)), true);
  assert.equal(cutByUpdateNow(window(), at(-1)), false, 'a cut from before the request is some other stop\'s');
  // Ended by the next generation's READY: a cut stamped before the end (re-sent from the old process's spool) still is.
  const ended = window({ updateCompletedAt: at(300) });
  assert.equal(cutByUpdateNow(ended, at(120)), true);
  assert.equal(cutByUpdateNow(ended, at(301)), false, 'a cut after the update ended is a later stop\'s');
  // An older end than the request is the previous request's: this one is still in progress.
  assert.equal(cutByUpdateNow(window({ updateCompletedAt: at(-600) }), at(900)), true);
});

test('no cut is the update\'s without a request that may interrupt turns', () => {
  assert.equal(cutByUpdateNow(window({ updateInterruptTurns: false }), at(100)), false, 'an idle runner\'s request interrupts nothing');
  assert.equal(cutByUpdateNow(window({ updateRequestedAt: null }), at(100)), false);
  assert.equal(cutByUpdateNow(null, at(100)), false, 'not an Orbit Cloud runner');
});

test('markUpdateNowCuts marks the update\'s cuts, keeps the runner\'s reason, and reads the mapping only for a cut', async () => {
  const reads: unknown[] = [];
  const tx = { managedRunner: { findUnique: async (args: unknown) => { reads.push(args); return window(); } } } as never;
  const event = (seq: number, type: RunEventType, payload: Record<string, unknown>, seconds: number): NormalizedRunEvent =>
    ({ seq, type, ts: at(seconds).toISOString(), turnId: 'turn-1', payload });

  const quiet = [event(1, RunEventType.ASSISTANT, { text: 'working' }, 10), event(2, RunEventType.INTERRUPT, { requestId: 'stop-1' }, 20)];
  await markUpdateNowCuts(tx, 'runner-1', quiet, at(30));
  assert.equal(reads.length, 0, 'no cut a runner stop marked: nothing read');
  assert.deepEqual(quiet[1].payload, { requestId: 'stop-1' }, 'the owner\'s own Stop is left as it is');

  const batch = [
    event(3, RunEventType.INTERRUPT, { reason: 'runner_restart' }, 110),
    event(4, RunEventType.INTERRUPT, { reason: 'runner_restart' }, -5),
    event(5, RunEventType.INTERRUPT, { reason: 'runner_update', targetVersion: '0.1.254' }, 120),
  ];
  await markUpdateNowCuts(tx, 'runner-1', batch, at(130));
  assert.equal(reads.length, 1, 'one read for the batch');
  assert.deepEqual(batch.map((e) => e.payload), [
    { reason: 'runner_update', reportedReason: 'runner_restart' },
    { reason: 'runner_restart' },
    { reason: 'runner_update', targetVersion: '0.1.254' },
  ]);
  // A retried attempt of the same batch finds it marked, and marks nothing twice.
  await markUpdateNowCuts(tx, 'runner-1', batch, at(130));
  assert.deepEqual(batch[0].payload, { reason: 'runner_update', reportedReason: 'runner_restart' });
});
