import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RunStatus } from '@prisma/client';
import { isSessionGenerating } from './session-generating';

test('a dispatched turn is generating', () => {
  assert.equal(isSessionGenerating({ status: RunStatus.RUNNING }), true);
});

/** The whole point: a self-driven turn runs while the session is still parked. */
test('a parked session generating on its own counts', () => {
  assert.equal(
    isSessionGenerating({ status: RunStatus.AWAITING_INPUT, engineTurnActive: true }),
    true,
  );
  assert.equal(
    isSessionGenerating({ status: RunStatus.AWAITING_INPUT, engineTurnActive: false }),
    false,
  );
  // Older control planes never set the flag; a parked session simply reads as parked.
  assert.equal(isSessionGenerating({ status: RunStatus.AWAITING_INPUT }), false);
});

/** The flag is display state, so a terminal session can carry a stale one and must ignore it. */
test('a terminal session is never generating', () => {
  for (const status of [RunStatus.SUCCEEDED, RunStatus.FAILED, RunStatus.CANCELLED] as const) {
    assert.equal(isSessionGenerating({ status, engineTurnActive: true }), false);
  }
});
