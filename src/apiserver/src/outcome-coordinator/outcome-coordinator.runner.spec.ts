import assert from 'node:assert/strict';
import { test } from 'node:test';

import { withCoordinatorWallDeadline } from './outcome-coordinator.runner';

test('coordinator wall deadline rejects work that ignores its abort signal', async () => {
  let timedOut = false;
  const never = new Promise<never>(() => undefined);
  await assert.rejects(
    withCoordinatorWallDeadline(never, 5, () => { timedOut = true; }),
    /COMPLETION_ACK_RESOLVER_WALL_DEADLINE_EXCEEDED/,
  );
  assert.equal(timedOut, true);
});

test('coordinator wall deadline clears its timer after ordinary completion', async () => {
  let timedOut = false;
  assert.equal(
    await withCoordinatorWallDeadline(Promise.resolve('done'), 50, () => { timedOut = true; }),
    'done',
  );
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(timedOut, false);
});
