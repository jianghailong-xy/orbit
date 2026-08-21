import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RunStatus } from '@prisma/client';
import { RunnerApiController } from './runner-api.controller';

/**
 * Mid-turn steering, at the boundary where it is decided: the inbox.
 *
 * A steer is deliverable BECAUSE an engine turn is running, and an ordinary message is
 * deliverable only because none is. The two are mirror images of the same condition, so
 * asserting one without the other proves nothing — a predicate that let everything through
 * would satisfy either half alone.
 *
 * The shape assertions below run everywhere. The behaviour they describe is proved against
 * a real Postgres in steer-dequeue.pg.spec.ts, because a stubbed $queryRaw can only report
 * the SQL it was handed, never what that SQL selects.
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

test('a steer is gated ON a live engine turn, and an executable turn is still gated OFF one', async () => {
  const sql = await leaseSQL();

  // The steer arm: EXISTS an in-flight message with a live lease. Messages only — a `!cmd`
  // shell turn holds the same slot with the engine idle beside it, so there is nothing to
  // fold a steer into.
  assert.match(
    sql,
    /turn\."kind" = 'steer'[\s\S]*?AND EXISTS \(\s*SELECT 1 FROM "conversation_turn" inflight[\s\S]*?inflight\."kind" = 'message'[\s\S]*?inflight\."status" = 'IN_FLIGHT'[\s\S]*?inflight\."lease_deadline_at" > now\(\)/,
  );
  // …and it is never re-leased: no expired-lease arm, unlike message/shell above it.
  const steerArm = sql.slice(sql.indexOf(`turn."kind" = 'steer'`), sql.indexOf(`-- User executable turns`));
  assert.doesNotMatch(steerArm, /lease_deadline_at" < now\(\)/);

  // The executable arm is untouched: a PENDING message still needs NOT EXISTS(in flight).
  assert.match(
    sql,
    /turn\."kind" IN \('message', 'shell'\)[\s\S]*?turn\."status" = 'PENDING' AND NOT EXISTS \(\s*SELECT 1 FROM "conversation_turn" inflight[\s\S]*?inflight\."kind" IN \('message', 'shell'\)[\s\S]*?inflight\."status" = 'IN_FLIGHT'/,
  );
  // A steer occupies nothing: neither NOT EXISTS subquery counts it, so it can never be
  // the reason an ordinary message keeps waiting.
  for (const occupancy of sql.split('NOT EXISTS (').slice(1)) {
    assert.doesNotMatch(occupancy.slice(0, 400), /'steer'/);
  }
});

test('a steer outranks the queued messages it was sent past', async () => {
  const sql = await leaseSQL();
  assert.match(sql, /ORDER BY \(CASE WHEN[\s\S]*?WHEN turn\."kind" IN \('reload', 'steer'\) THEN 1 ELSE 2 END\), turn\."seq" ASC/);
});
