import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SPAWN_TREE_RUNNER_RESERVE } from '../common/session-scheduling';
import { QueueService } from './queue.service';

const RUNNER_ID = '22222222-2222-4222-8222-222222222222';

async function claimCall(): Promise<{ sql: string; params: unknown[] }> {
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
  const call = queryCalls[0];
  return {
    // One Prisma.Sql, not a tagged template: the claim composes shared cap fragments.
    sql: ((call?.[0] as { strings?: readonly string[] } | undefined)?.strings ?? []).join('?'),
    params: (call?.[0] as { values?: unknown[] } | undefined)?.values ?? [],
  };
}

// A fixed count cannot be right for a machine whose capacity it does not know: the same
// number is meaningless on a 2-slot runner and absurdly tight on a 64-slot one.
test('the tree ceiling is a share of the runner, not a constant', async () => {
  const { sql, params } = await claimCall();
  const treeCap = sql.slice(sql.indexOf('FROM "session" tree'));
  assert.match(treeCap, /GREATEST\(\s*1,/, 'a tree always gets at least one slot');
  assert.match(treeCap, /r\."max_concurrent"/);
  assert.equal(
    params.includes(SPAWN_TREE_RUNNER_RESERVE),
    true,
    'the reserve is bound from the scheduling policy, not written into the SQL twice',
  );
});

/**
 * Fairness has to come from ordering rather than a hard sub-cap. A sub-cap idles slots
 * whether or not anything is waiting for them — which is the state this whole change came
 * from: a runner at 3/16 with sessions queued behind a tree cap of 3.
 */
test('claims go to the tree holding the fewest active turns first', async () => {
  const { sql } = await claimCall();
  const order = sql.slice(sql.indexOf('ORDER BY'));
  assert.match(order, /busy\."root_session_id" = s\."root_session_id"/);
  assert.match(order, /busy\."status" = 'RUNNING'/);
  assert.match(order, /\)\s*ASC,\s*s\."created_at" ASC/, 'least-loaded tree first, then oldest');
});
