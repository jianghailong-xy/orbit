import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RunStatus } from '@prisma/client';
import { RunnerApiController } from './runner-api.controller';

/**
 * The other half of a config change, at the boundary where the two are told apart: the inbox.
 *
 * `reload` and `setconfig` carry the same pair, and the whole difference is when they may be
 * handed over. So a shape assertion about one is only worth anything paired with the opposite
 * assertion about the other — a predicate that let both through mid-turn, or held both, would
 * satisfy either half alone.
 *
 * These run everywhere; what the predicate actually SELECTS is proved against real rows in
 * steer-dequeue.pg.spec.ts, because a stubbed $queryRaw can only report the SQL it was handed.
 */

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const RUNNER_ID = '22222222-2222-4222-8222-222222222222';

type Dequeue = (sessionId: string, runnerId: string, leaseGeneration: string | null) => Promise<unknown>;

function leaseSQL() {
  const rawCalls: unknown[][] = [];
  const tx = {
    $queryRaw: async (...args: unknown[]) => {
      rawCalls.push(args);
      const sql = (args[0] as readonly string[]).join('?');
      if (/SELECT id, "inbox_lease_generation"/.test(sql)) {
        return [
          { id: SESSION_ID, inboxLeaseGeneration: null, inboxLeaseOwner: null, status: RunStatus.RUNNING },
        ];
      }
      return [];
    },
  };
  const prisma = { $transaction: async (fn: (t: typeof tx) => unknown) => fn(tx) } as never;
  const controller = new RunnerApiController(
    prisma,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    { appendFor: async (_tx: unknown, _sessionId: unknown, content?: string) => content } as never,
  );
  return (controller as unknown as { dequeueTurn: Dequeue }).dequeueTurn
    .bind(controller)(SESSION_ID, RUNNER_ID, null)
    .then(() => (rawCalls.at(-1)?.[0] as readonly string[]).join('?'));
}

test('setconfig lands mid-turn like an interrupt, and reload is still held until the turn ends', async () => {
  const sql = await leaseSQL();

  // Same arm as interrupt/end/diff: nothing about the running turn is consulted, and an
  // IN_FLIGHT row whose lease died is re-delivered to whoever took over.
  assert.match(
    sql,
    /turn\."kind" IN \('interrupt', 'end', 'diff', 'setconfig'\)\s*\n\s*AND \(turn\."status" = 'PENDING' OR \(turn\."status" = 'IN_FLIGHT' AND turn\."lease_deadline_at" < now\(\)\)\)/,
  );
  // The opposite claim, which is what makes the one above mean something: a reload still waits
  // for an empty slot, because a provider switch cannot be applied without a new process.
  assert.match(
    sql,
    /turn\."kind" = 'reload' AND turn\."status" = 'PENDING' AND NOT EXISTS \(\s*SELECT 1 FROM "conversation_turn" inflight[\s\S]*?inflight\."kind" IN \('message', 'shell'\)[\s\S]*?inflight\."status" = 'IN_FLIGHT'/,
  );
});

test('setconfig occupies no in-flight slot, so nothing waits behind one', async () => {
  const sql = await leaseSQL();

  // Every occupancy test counts message/shell only. If setconfig appeared in one, delivering a
  // config change would postpone the very message it was meant to take effect for.
  for (const occupancy of sql.split('NOT EXISTS (').slice(1)) {
    assert.doesNotMatch(occupancy.slice(0, 400), /'setconfig'/);
  }
});

test('setconfig is ranked after the interrupt group and ahead of the reload it may share a patch with', async () => {
  const sql = await leaseSQL();

  // One PATCH that moves both halves queues setconfig at the lower seq, but seq is the tiebreak,
  // not the rank — the rank is what keeps the pair in that order even against a reload queued
  // earlier by a patch of its own.
  assert.match(
    sql,
    /ORDER BY \(CASE WHEN turn\."kind" IN \('interrupt', 'end', 'diff'\) THEN 0 WHEN turn\."kind" = 'setconfig' THEN 1 WHEN turn\."kind" IN \('reload', 'steer'\) THEN 2 ELSE 3 END\), turn\."seq" ASC/,
  );
});
