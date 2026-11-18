import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { RunnerApiController } from './runner-api.controller';
import { endStreams, isStopping } from '../common/graceful-stop';

// The approval long poll over HTTPS (`orbit mcp`, the approval hook) holds its read up to 25 s while the card is
// PENDING. An apiserver that is stopping answers it at once with PENDING, as when the window runs out, so that the
// reader asks again, of another apiserver, rather than have the read cut when the drain ends
// (common/graceful-stop.ts, step 2). The stop is process-wide, so this file holds nothing else.

const RUNNER_ID = '11111111-1111-4111-8111-111111111111';
const OWNER = '22222222-2222-4222-8222-222222222222';
const SESSION = '019fc086-c7c7-7c92-8215-778ad8a6280a';

test('an approval long poll in progress answers PENDING as soon as the apiserver begins to stop', async () => {
  let reads = 0;
  const prisma = {
    session: { findUnique: async () => ({ id: SESSION, assignedRunnerId: RUNNER_ID, ownerId: OWNER, providerBuiltin: true }) },
    approval: {
      findFirst: async () => {
        reads += 1;
        return { id: 'approval-1', status: 'PENDING' };
      },
    },
  } as never;
  const controller = new RunnerApiController(prisma, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never);

  let answer: unknown = null;
  const poll = controller.pollApproval({ id: RUNNER_ID }, SESSION, 'approval-1').then((a) => (answer = a));
  await sleep(300);
  assert.equal(answer, null, 'without a stop the poll holds its read');
  assert.equal(isStopping(), false);

  const began = Date.now();
  endStreams();
  await poll;
  const took = Date.now() - began;
  assert.deepEqual(answer, { id: 'approval-1', status: 'PENDING' });
  assert.ok(took < 200, `the poll answered ${took} ms after the stop began, not at once`);
  assert.ok(reads >= 2, 'the card was read again before answering, so a decision made meanwhile is not lost');
});
