import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ReaperService } from './reaper.service';

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const RUNNER_ID = '22222222-2222-4222-8222-222222222222';

test('reaper terminalization retires the inbox generation before draining turns', async () => {
  const order: string[] = [];
  const tx = {
    session: {
      updateMany: async () => {
        order.push('terminal');
        return { count: 1 };
      },
    },
    $executeRaw: async () => {
      order.push('retire');
      return 1;
    },
    conversationTurn: {
      updateMany: async () => {
        order.push('drain');
        return { count: 1 };
      },
    },
  };
  const prisma = {
    $transaction: async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx),
  } as never;
  const realtime = {
    requestCancel: () => undefined,
    publish: () => undefined,
  } as never;
  const service = new ReaperService(prisma, realtime);

  await (
    service as unknown as {
      forceFinalize(
        sessionId: string,
        runnerId: string | null,
        taskId: string | null,
        reason: string,
      ): Promise<void>;
    }
  ).forceFinalize(SESSION_ID, RUNNER_ID, null, 'runner offline');

  assert.deepEqual(order, ['terminal', 'retire', 'drain']);
});
