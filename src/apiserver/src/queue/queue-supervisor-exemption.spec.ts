import assert from 'node:assert/strict';
import { test } from 'node:test';
import { QueueService } from './queue.service';

const RUNNER_ID = '22222222-2222-4222-8222-222222222222';

function sql(call: unknown[] | undefined): string {
  // One Prisma.Sql, not a tagged template: the claim composes shared cap fragments.
  return ((call?.[0] as { strings?: readonly string[] } | undefined)?.strings ?? []).join('?');
}

async function claimSql(): Promise<string> {
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
  return sql(queryCalls[0]);
}

/**
 * `session_create(wait)` blocks the parent's tool call until the child leaves
 * PENDING/RUNNING while the parent stays RUNNING. Charging that parent against the same
 * batch cap its child must draw from is a thread-pool deadlock — fill the cap with
 * waiters and no child is ever claimable. The batch count therefore skips any session
 * with a child still queued or running.
 */
test('the tree cap does not count a session waiting on its own child', async () => {
  const text = await claimSql();
  const treeCount = text.slice(text.indexOf('FROM "session" tree'));
  assert.match(treeCount, /tree\."root_session_id" = s\."root_session_id"/);
  assert.match(treeCount, /NOT EXISTS/);
  assert.match(treeCount, /child\."parent_session_id" = tree\.id/);
  assert.match(treeCount, /child\."status" IN \('PENDING', 'RUNNING'\)/);
});

// The exemption is scoped to the tree cap. The runner cap is the safety net that makes
// letting a tree exceed its own cap safe, so it must keep counting every active turn.
test('the runner cap still counts every RUNNING session', async () => {
  const text = await claimSql();
  // Ends at the cap comparison, so the prose below it cannot satisfy the match either way.
  const runnerCount = text.slice(
    text.indexOf('FROM "session" active'),
    text.indexOf('-- Batch-run cap'),
  );
  assert.match(runnerCount, /active\."status" = 'RUNNING'/);
  assert.doesNotMatch(runnerCount, /NOT EXISTS/);
});

// A batch run is a closed set of sessions the user dispatched together; none of them is
// waiting on a child, so the exemption has nothing to do there and its cap stays literal.
test('the batch cap counts every RUNNING member', async () => {
  const text = await claimSql();
  const batchCount = text.slice(
    text.indexOf('FROM "session" ba'),
    text.indexOf('-- Spawn-tree cap'),
  );
  assert.match(batchCount, /ba\."batch_id" = s\."batch_id"/);
  assert.doesNotMatch(batchCount, /NOT EXISTS/);
});
