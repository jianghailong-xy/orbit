import assert from 'node:assert/strict';
import test from 'node:test';

import type { SessionPhaseFields } from '@orbit/shared';

import { releasedByFailure, runSessionReading, type RunSessionReading } from './schedule-run-session-reading';

const held = (phase: SessionPhaseFields['phase'], waitingOn: SessionPhaseFields['waitingOn'] = null): SessionPhaseFields => ({
  phase, released: false, lastTurnOutcome: 'ANSWERED', waitingOn, endReason: null, workFinished: false,
});
const released = (lastTurnOutcome: SessionPhaseFields['lastTurnOutcome'], endReason: string | null): SessionPhaseFields => ({
  phase: 'IDLE', released: true, lastTurnOutcome, waitingOn: null, endReason, workFinished: endReason === 'task_done',
});

test('a run reads its session from the phase fields and the wake alone', () => {
  const cases: Array<[string, SessionPhaseFields, boolean, RunSessionReading]> = [
    ['a turn running', held('RUNNING'), false, 'WORKING'],
    ['a turn queued', held('PENDING'), false, 'WORKING'],
    ['a queued turn on hold still counts as working', held('PENDING', 'HOLD'), false, 'WORKING'],
    ['running and waiting on an approval', held('RUNNING', 'PERSON'), false, 'WORKING'],
    ['idle, nothing to wake it', held('IDLE'), false, 'IDLE'],
    ['idle with a watch or wake-up', held('IDLE', 'WAKE'), true, 'WILL_WAKE'],
    ['idle, an owner request open, and a watch: PERSON does not hide the wake', held('IDLE', 'PERSON'), true, 'WILL_WAKE'],
    ['idle, an owner request open, nothing to wake it', held('IDLE', 'PERSON'), false, 'IDLE'],
    ['released by a failure, a retry armed', released('FAILED', null), true, 'WILL_WAKE'],
    ['released by a failure, nothing revives it', released('FAILED', null), false, 'FAILED'],
    ['an end asked for, and its turn failed', released('FAILED', 'ended'), false, 'ENDED'],
    ['an end asked for', released('ANSWERED', 'completed'), false, 'ENDED'],
    ['the engine exited by itself', released('ANSWERED', null), false, 'ENDED'],
  ];
  for (const [name, fields, wakes, want] of cases) assert.equal(runSessionReading({ fields, wakes }), want, name);
  assert.equal(releasedByFailure(released('FAILED', null)), true);
  assert.equal(releasedByFailure(held('IDLE')), false);
});
