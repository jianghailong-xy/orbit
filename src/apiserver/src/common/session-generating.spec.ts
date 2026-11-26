import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RunStatus } from '@orbit/shared';
import { turnStateOfWord } from '../sessions/session-turn-state';
import { isSessionGenerating } from './session-generating';

/**
 * Rows as the server stores them: a released word with its `finished_at`, a held one with its turn state.
 */
const shapes = (status: RunStatus) => {
  const finishedAt = [RunStatus.SUCCEEDED, RunStatus.FAILED, RunStatus.CANCELLED].includes(status) ? new Date() : null;
  return [{ label: status, row: { finishedAt, turnState: turnStateOfWord(status) } }];
};

test('a dispatched turn is generating', () => {
  for (const { label, row } of shapes(RunStatus.RUNNING)) assert.equal(isSessionGenerating(row), true, label);
});

/** The whole point: a self-driven turn runs while the session is still parked. */
test('a parked session generating on its own counts', () => {
  for (const { label, row } of shapes(RunStatus.AWAITING_INPUT)) {
    assert.equal(isSessionGenerating({ ...row, engineTurnActive: true }), true, label);
    assert.equal(isSessionGenerating({ ...row, engineTurnActive: false }), false, label);
    // Older control planes never set the flag; a parked session simply reads as parked.
    assert.equal(isSessionGenerating(row), false, label);
  }
});

/** A queued or abandoned turn is no turn the engine runs: its flag is read only on a parked session. */
test('a queued or abandoned session is generating only through a dispatched turn', () => {
  for (const status of [RunStatus.PENDING, RunStatus.INTERRUPTED]) {
    for (const { label, row } of shapes(status)) assert.equal(isSessionGenerating({ ...row, engineTurnActive: true }), false, label);
  }
});

/** The flag is display state, so a terminal session can carry a stale one and must ignore it. */
test('a terminal session is never generating', () => {
  for (const status of [RunStatus.SUCCEEDED, RunStatus.FAILED, RunStatus.CANCELLED]) {
    for (const { label, row } of shapes(status)) assert.equal(isSessionGenerating({ ...row, engineTurnActive: true }), false, label);
  }
});
