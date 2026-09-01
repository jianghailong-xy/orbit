import assert from 'node:assert/strict';
import { renderRawQuery } from '../test-support/prisma-transaction-double';
import { test } from 'node:test';
import { RunStatus } from '@prisma/client';
import { RunEventType } from '@orbit/shared';
import { RunnerApiController } from './runner-api.controller';

/**
 * The mid-turn message a runner process died holding.
 *
 * A steer is delivered exactly once and deliberately never re-leased: re-writing a message the
 * engine may already have acted on is the one thing mid-turn delivery must not do. That makes a
 * process dying between the lease and the report a genuine dead end for the row — the inbox only
 * hands out a PENDING steer, the lease expiry beside it covers message/shell only, and the turn
 * it was aimed at only re-files a steer that never left PENDING. Nothing would ever come back for
 * it: no event, no queue entry, no failure. The message would simply be gone.
 *
 * So activation — the moment a new process takes the session over — hands them across. Two
 * properties carry the whole design:
 *
 *  - it REPORTS rather than settles. Activation is retried on transport errors, so a response
 *    nobody received has to leave the rows exactly as they were for the next attempt.
 *  - it is answered on the retry path too, which is where a retry of a committed activation
 *    lands. A handover only offered by the attempt that installs the generation is one that is
 *    silently skipped precisely when it was needed.
 */

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const RUNNER_ID = '22222222-2222-4222-8222-222222222222';
const GENERATION = '33333333-3333-4333-8333-333333333333';
const LEASE_OWNER = '55555555-5555-4555-8555-555555555555';
const STRANDED_A = '66666666-6666-4666-8666-666666666666';
const STRANDED_B = '77777777-7777-4777-8777-777777777777';

function harness({
  installed = false,
  stranded = [] as Array<{ id: string; content: string | null }>,
  announced = [] as string[],
}) {
  const strandedQueries: { where: Record<string, unknown>; orderBy?: unknown }[] = [];
  const eventQueries: { where: Record<string, unknown> }[] = [];
  const turnWrites: unknown[] = [];
  const tx = {
    $queryRaw: async (...args: unknown[]) => {
      const text = renderRawQuery(args).text;
      if (/FROM "session"/.test(text)) {
        return [{
          id: SESSION_ID,
          inboxLeaseGeneration: null,
          inboxLeaseOwner: LEASE_OWNER,
          status: RunStatus.RUNNING,
        }];
      }
      if (/SELECT "session_id" AS "sessionId"/.test(text)) {
        return [{ sessionId: SESSION_ID, leaseOwner: LEASE_OWNER, retiredAt: null }];
      }
      return [];
    },
    $executeRaw: async () => 1,
  };
  const prisma = {
    session: {
      findUnique: async () => ({
        inboxLeaseOwner: LEASE_OWNER,
        inboxLeaseGeneration: installed ? GENERATION : null,
        status: RunStatus.RUNNING,
      }),
    },
    conversationTurn: {
      findMany: async (args: { where: Record<string, unknown>; orderBy?: unknown }) => {
        strandedQueries.push(args);
        return stranded;
      },
      updateMany: async (args: unknown) => {
        turnWrites.push(args);
        return { count: 1 };
      },
    },
    runEvent: {
      findMany: async (args: { where: Record<string, unknown> }) => {
        eventQueries.push(args);
        return announced.map((turnId) => ({ turnId }));
      },
    },
    $transaction: async (fn: (t: typeof tx) => unknown) => fn(tx),
  } as never;
  const controller = new RunnerApiController(
    prisma,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    { appendFor: async (_tx: unknown, _sessionId: unknown, content?: string) => content } as never,
  );
  return { controller, strandedQueries, eventQueries, turnWrites };
}

const activate = (h: ReturnType<typeof harness>) =>
  h.controller.activateLeases({ id: RUNNER_ID }, SESSION_ID, {
    leaseGeneration: GENERATION,
    leaseOwner: LEASE_OWNER,
  });

test('activation hands the incoming process every steer the last one left leased', async () => {
  const h = harness({
    stranded: [
      { id: STRANDED_A, content: 'actually, call it gadget' },
      { id: STRANDED_B, content: 'and revert the rename' },
    ],
    announced: [STRANDED_B],
  });

  const out = await activate(h);

  assert.deepEqual(out, {
    ok: true,
    abandonedSteers: [
      // Never announced: the dead process did not get as far as the transcript, so the report
      // has to open the bubble as well as settle it — hence the text travels with it.
      { turnId: STRANDED_A, content: 'actually, call it gadget', announced: false },
      // Already announced: a second bubble would show the same message twice.
      { turnId: STRANDED_B, content: 'and revert the rename', announced: true },
    ],
  });
  // Only a leased steer, and only one from a generation that is not the incoming one.
  assert.deepEqual(h.strandedQueries[0].where, {
    sessionId: SESSION_ID,
    kind: 'steer',
    status: 'IN_FLIGHT',
    NOT: { leaseGeneration: GENERATION },
  });
  // In the order they were sent, so the report reads the way the person wrote them.
  assert.deepEqual(h.strandedQueries[0].orderBy, { seq: 'asc' });
  assert.deepEqual(h.eventQueries[0].where, {
    sessionId: SESSION_ID,
    turnId: { in: [STRANDED_A, STRANDED_B] },
    type: RunEventType.USER,
  });
});

test('the handover is read-only, so a lost response leaves the rows for the next attempt', async () => {
  // Activation retries on transport errors. Settling here would mean a handover that was
  // reported into a dropped response is gone: the rows are no longer IN_FLIGHT, so the retry
  // finds nothing and the message is never answered for.
  const h = harness({ stranded: [{ id: STRANDED_A, content: 'actually, call it gadget' }] });

  await activate(h);

  assert.deepEqual(h.turnWrites, [], 'activation must not settle a stranded steer itself');
});

test('a retry that finds the generation already installed still hands them over', async () => {
  // The fast path exists so a reclaim storm cannot starve the claim queue on row locks — and it
  // is also where a retry of a committed activation lands. A handover skipped here is skipped
  // exactly when the process it belongs to has already died once.
  const h = harness({
    installed: true,
    stranded: [{ id: STRANDED_A, content: 'actually, call it gadget' }],
  });

  const out = await activate(h);

  assert.deepEqual(out.abandonedSteers, [
    { turnId: STRANDED_A, content: 'actually, call it gadget', announced: false },
  ]);
});

test('nothing stranded means nothing is looked up and nothing is handed over', async () => {
  const h = harness({});

  const out = await activate(h);

  assert.deepEqual(out.abandonedSteers, []);
  assert.deepEqual(h.eventQueries, [], 'the transcript is only consulted when there is something to ask about');
});
