/**
 * A runner with drive handles holding bytes no commit has taken is not idle, so it is neither drained nor
 * confirmed into a sleep (docs/drive-technical-design.md §8.1).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { sanitizeManagedWorkload, workloadIdle } from './managed-runner-sleep';

const IDLE = { activeTurns: 0, backgroundJobs: 0, operations: 0, unflushedEvents: 0, idleSeconds: 900 };

test('an unflushed drive write keeps a runner from sleeping', () => {
  const busy = sanitizeManagedWorkload({ ...IDLE, driveWrites: 2 });
  assert.equal(busy?.driveWrites, 2);
  assert.equal(workloadIdle(busy!), false);
  const flushed = sanitizeManagedWorkload({ ...IDLE, driveWrites: 0 });
  assert.equal(workloadIdle(flushed!), true);
});

test('a runner that reports no drive writes is idle as before, and a malformed count is no report', () => {
  assert.equal(workloadIdle(sanitizeManagedWorkload(IDLE)!), true);
  assert.equal(sanitizeManagedWorkload({ ...IDLE, driveWrites: -1 }), null);
  assert.equal(sanitizeManagedWorkload({ ...IDLE, driveWrites: 'x' }), null);
});
