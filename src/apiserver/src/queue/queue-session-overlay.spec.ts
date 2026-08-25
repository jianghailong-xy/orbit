import assert from 'node:assert/strict';
import { test } from 'node:test';
import { QueueService } from './queue.service';

const RUNNER_ID = '22222222-2222-4222-8222-222222222222';
const SESSION_ID = '11111111-1111-4111-8111-111111111111';

function fixture(buildError?: Error) {
  const order: string[] = [];
  const tx = {
    $executeRaw: async () => 0,
    $queryRaw: async () => [{ id: SESSION_ID }],
  };
  const prisma = {
    $transaction: async (fn: (client: typeof tx) => Promise<unknown>) => {
      order.push('transaction:start');
      const result = await fn(tx);
      order.push('transaction:commit');
      return result;
    },
  } as never;
  const queue = new QueueService(prisma, {
    publishSessionUpdated: (sessionId: string) => order.push(`publish:${sessionId}`),
  } as never);
  (queue as unknown as { buildSession(id: string): Promise<unknown> }).buildSession = async (id) => {
    order.push(`build:${id}`);
    if (buildError) throw buildError;
    return { id };
  };
  return { queue, order };
}

test('a claimed session publishes its committed RUNNING overlay before hydration', async () => {
  const f = fixture();

  const claimed = await f.queue.claimSessionForRunner({ id: RUNNER_ID });

  assert.deepEqual(claimed, { id: SESSION_ID });
  assert.deepEqual(f.order, [
    'transaction:start',
    'transaction:commit',
    `publish:${SESSION_ID}`,
    `build:${SESSION_ID}`,
  ]);
});

test('a hydration failure cannot hide the already-committed claim', async () => {
  const f = fixture(new Error('hydrate failed'));

  await assert.rejects(
    () => f.queue.claimSessionForRunner({ id: RUNNER_ID }),
    /hydrate failed/,
  );

  assert.deepEqual(f.order, [
    'transaction:start',
    'transaction:commit',
    `publish:${SESSION_ID}`,
    `build:${SESSION_ID}`,
  ]);
});
