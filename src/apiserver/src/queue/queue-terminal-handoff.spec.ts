import assert from 'node:assert/strict';
import { test } from 'node:test';
import { QueueService } from './queue.service';

const RUNNER_ID = '22222222-2222-4222-8222-222222222222';

function sql(call: unknown[] | undefined): string {
  return ((call?.[0] as readonly string[] | undefined) ?? []).join('?');
}

test('queue claims v5-tagged terminal handoffs only for a capable runner', async () => {
  const queryCalls: unknown[][] = [];
  const tx = {
    $executeRaw: async () => 0,
    $queryRaw: async (...args: unknown[]) => {
      queryCalls.push(args);
      return [];
    },
  };
  const prisma = {
    $transaction: async (fn: (transaction: typeof tx) => Promise<unknown>) => fn(tx),
  };
  const queue = new QueueService(prisma as never);

  assert.equal(await queue.claimSessionForRunner({ id: RUNNER_ID }, 0, false), null);
  assert.equal(await queue.claimSessionForRunner({ id: RUNNER_ID }, 0, true), null);

  assert.equal(queryCalls.length, 2);
  for (const call of queryCalls) {
    assert.match(
      sql(call),
      /substring\(s\."inbox_lease_owner"::text, 15, 1\) IS DISTINCT FROM '5'/,
    );
  }
  assert.equal(queryCalls[0].slice(1).includes(false), true);
  assert.equal(queryCalls[1].slice(1).includes(true), true);
});
