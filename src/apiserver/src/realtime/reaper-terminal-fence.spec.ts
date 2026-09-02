import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ReaperService } from './reaper.service';

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const RUNNER_ID = '22222222-2222-4222-8222-222222222222';

test('reaper terminalization retires the generation then records leased CURRENT_WORK unconfirmed before drain', async () => {
  const order: string[] = [];
  const receiptWrites: Array<Record<string, unknown>> = [];
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
      findMany: async () => [{
        id: 'current-work-1', targetTurnId: 'target-1', status: 'IN_FLIGHT',
      }],
      updateMany: async ({ data }: { data: Record<string, unknown> }) => {
        if (data.deliveryStatus) receiptWrites.push(data);
        order.push(data.deliveryStatus === 'UNCONFIRMED' ? 'current-work' : 'drain');
        return { count: 1 };
      },
      findFirst: async () => null,
    },
  };
  const prisma = {
    $transaction: async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx),
  } as never;
  const realtime = {
    requestCancel: () => undefined,
    publish: () => undefined,
    publishQueuedTurnsChanged: () => undefined,
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

  assert.deepEqual(order, ['terminal', 'retire', 'current-work', 'drain']);
  assert.equal(receiptWrites[0]?.deliveryStatus, 'UNCONFIRMED');
  assert.match(String(receiptWrites[0]?.deliveryFailureReason), /could not be confirmed/i);
  assert.doesNotMatch(String(receiptWrites[0]?.deliveryFailureReason), /was not delivered/i);
});
