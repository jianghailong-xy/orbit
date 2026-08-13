import assert from 'node:assert/strict';
import { test } from 'node:test';
import { QueueService } from './queue.service';

const RUNNER_ID = '22222222-2222-4222-8222-222222222222';

// The claim composes shared cap fragments, so it passes $queryRaw one Prisma.Sql rather than a
// tagged template. `strings` are its literal segments and `values` its bound parameters.
function sql(call: unknown[] | undefined): string {
  return ((call?.[0] as { strings?: readonly string[] } | undefined)?.strings ?? []).join('?');
}

function params(call: unknown[] | undefined): unknown[] {
  return (call?.[0] as { values?: unknown[] } | undefined)?.values ?? [];
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
  assert.equal(params(queryCalls[0]).includes(false), true);
  assert.equal(params(queryCalls[1]).includes(true), true);
});
