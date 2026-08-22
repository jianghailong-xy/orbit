import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Prisma } from '@prisma/client';
import { RunEventType } from '@orbit/shared';

import { classifyTransactionError } from './transaction-retry';
import { RunnerApiController } from '../runner-api/runner-api.controller';
import { SessionTagsService } from '../session-tags/session-tags.service';
import { WorkspacesService } from '../workspaces/workspaces.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { RealtimeService } from '../realtime/realtime.service';

/**
 * The half of the retry contract that is about the SERVICES, not about the loop.
 *
 * A retry re-runs a whole closure. That is the correct answer to a transaction the server threw
 * away, and it is also the one change that can break something nothing else in the system would
 * notice: anything OUTSIDE the closure that the closure's success implies — a realtime publish, a
 * notification, a nudge to a runner — happens once per CALL, and anything inside would happen once
 * per ATTEMPT. `db-write-inventory.spec.ts` proves statically that nothing external is inside a
 * closure anywhere. This proves the consequence at run time, on the units where a doubled effect
 * would be a user-visible bug: two conflicts, then a commit, and exactly one of everything.
 *
 * It also proves the other direction, which matters just as much: the rows a victim wrote are not
 * there on the next attempt. The prisma double below really rolls back — writes go into a pending
 * buffer that only joins the committed state when its own attempt commits — so "the retry wrote
 * one set of rows and not two" is a fact about the fixture rather than a promise.
 */

const CLIENT_VERSION = '7.9.1';

/** A 40P01 in the shape Prisma 7 delivers one from a raw query. */
function deadlock(): Error {
  return new Prisma.PrismaClientKnownRequestError('Raw query failed. Code: `40P01`.', {
    code: 'P2010',
    clientVersion: CLIENT_VERSION,
    meta: { driverAdapterError: { cause: { originalCode: '40P01', kind: 'TransactionWriteConflict' } } },
  });
}

/** Reads answer from `reads`; everything else is a write and goes into the pending buffer. */
const READS = new Set([
  'findMany', 'findFirst', 'findUnique', 'findFirstOrThrow', 'findUniqueOrThrow', 'count',
  'aggregate', 'groupBy',
]);

interface Written {
  model: string;
  op: string;
  where?: unknown;
  data?: unknown;
}

/**
 * A prisma double whose first `failures` transactions abort AFTER running the closure.
 *
 * Aborting after rather than before is the point: the attempt does its writes, and then they are
 * discarded. A fixture that failed before the closure ran would prove nothing about a rollback.
 */
function rollingBack(
  failures: number,
  reads: Record<string, unknown> = {},
  /** What `$queryRaw` answers — the ordered pre-locks and the lease fence are raw statements. */
  raw: unknown[] = [],
) {
  const committed: Written[] = [];
  let pending: Written[] = [];
  let transactions = 0;

  const model = (name: string) =>
    new Proxy(
      {},
      {
        get: (_target, op: string) => async (args: { where?: unknown; data?: unknown } = {}) => {
          if (READS.has(op)) {
            const answer = reads[`${name}.${op}`];
            if (answer !== undefined) return answer;
            return op === 'findMany' || op === 'groupBy' ? [] : op === 'count' ? 0 : null;
          }
          pending.push({ model: name, op, where: args?.where, data: args?.data });
          return { id: (args?.where as { id?: string })?.id ?? 'row', count: 1 };
        },
      },
    );

  const client: Record<string, unknown> = new Proxy(
    {},
    {
      get: (_target, prop: string) => {
        if (prop === '$transaction') {
          return async <T>(work: (tx: unknown) => Promise<T>): Promise<T> => {
            transactions += 1;
            const mine = transactions;
            pending = [];
            const result = await work(client);
            if (mine <= failures) {
              pending = [];
              throw deadlock();
            }
            committed.push(...pending);
            pending = [];
            return result;
          };
        }
        if (prop === '$queryRaw' || prop === '$queryRawUnsafe') return async () => raw;
        if (prop === '$executeRaw' || prop === '$executeRawUnsafe') return async () => 1;
        if (prop === 'then') return undefined;
        return model(prop);
      },
    },
  );

  return {
    prisma: client as unknown as PrismaService,
    committed,
    transactions: () => transactions,
  };
}

/** A realtime double that counts, so "published once" is a number and not an impression. */
function countingRealtime() {
  const published: string[] = [];
  const realtime = new Proxy(
    {},
    { get: (_t, name: string) => (...args: unknown[]) => published.push(`${name}(${args.join(',')})`) },
  ) as unknown as RealtimeService;
  return { realtime, published };
}

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';

test('a reorder that loses two deadlocks writes each position once, in id order', async () => {
  const { prisma, committed, transactions } = rollingBack(2, {
    'workspace.findMany': [{ id: C }, { id: A }, { id: B }],
  });
  const workspaces = new WorkspacesService(prisma);
  await workspaces.reorder('owner', [C, A, B]);

  assert.equal(transactions(), 3, 'two victims and one commit');
  const updates = committed.filter((w) => w.model === 'workspace' && w.op === 'update');
  assert.equal(updates.length, 3, 'exactly one write per workspace survived — the victims left nothing');
  // The order the rows are LOCKED in, which is the property that stops two opposite drags
  // deadlocking. It is not the order the caller sent, and it is not the order of the positions.
  assert.deepEqual(
    updates.map((w) => (w.where as { id: string }).id),
    [A, B, C],
    'the statements are taken in id order',
  );
  // The positions are still the ones the CALLER asked for: sorting changed when a row is locked,
  // not what it ends up saying.
  assert.deepEqual(
    updates.map((w) => (w.data as { position: number }).position),
    [1, 2, 0],
    'C first, then A, then B — the order the request sent',
  );
});

test('a reorder whose conflict outlives the budget rethrows something the boundary answers 503', async () => {
  const { prisma, committed } = rollingBack(Number.MAX_SAFE_INTEGER, {
    'workspace.findMany': [{ id: A }, { id: B }],
  });
  const workspaces = new WorkspacesService(prisma);
  const thrown = await workspaces.reorder('owner', [A, B]).then(
    () => null,
    (error: unknown) => error,
  );
  assert.ok(thrown, 'exhaustion throws');
  assert.equal(classifyTransactionError(thrown).retryable, true, 'and it is still transient');
  assert.deepEqual(committed, [], 'nothing was left behind by the attempts that lost');
});

test('re-tagging a session that loses two deadlocks writes one link set and publishes once', async () => {
  const { prisma, committed, transactions } = rollingBack(2, {
    'session.findFirst': { id: A },
    'sessionTag.count': 2,
  });
  const { realtime, published } = countingRealtime();
  const tags = new SessionTagsService(prisma, realtime);
  await tags.setForSession('owner', A, [C, B]);

  assert.equal(transactions(), 3);
  const deletes = committed.filter((w) => w.op === 'deleteMany');
  const inserts = committed.filter((w) => w.op === 'createMany');
  assert.equal(deletes.length, 1, 'one clear, not one per attempt');
  assert.equal(inserts.length, 1, 'one insert of the link set, not one per attempt');
  // Sorted: the INSERT takes FOR KEY SHARE on each tag row through the link's foreign key, and
  // taking them in the picker's arbitrary order was two writers able to take them backwards.
  assert.deepEqual(
    (inserts[0].data as Array<{ tagId: string }>).map((row) => row.tagId),
    [B, C],
  );
  assert.deepEqual(
    published.filter((line) => line.startsWith('publishSessionUpdated')),
    [`publishSessionUpdated(${A})`],
    'the other clients are told once, after the attempt that committed',
  );
});

test('a runner event batch that loses two deadlocks persists once and broadcasts once', async () => {
  const events = [
    { seq: 1, type: RunEventType.ASSISTANT, payload: { text: 'hello' }, ts: Date.now() },
    { seq: 2, type: RunEventType.TEXT_DELTA, payload: { text: 'ignored' }, ts: Date.now() },
  ];
  const { prisma, committed, transactions } = rollingBack(
    2,
    {
      'session.findUniqueOrThrow': {
        status: 'RUNNING',
        runtimeSessionId: 'rt-1',
        cancelRequestedAt: null,
        runningBgShells: [],
        runningSubagents: [],
      },
    },
    // The rank-30 lease fence: this runner owns the session and holds the current generation.
    [{ id: A, leaseOwnerMatches: true }],
  );
  const { realtime, published } = countingRealtime();
  const controller = new RunnerApiController(
    prisma,
    {} as never,
    realtime,
    {} as never,
    {} as never,
    {} as never,
  );
  await controller.events({ id: 'runner-1' }, A, { events } as never);

  assert.equal(transactions(), 3, 'two victims and one commit');
  const inserted = committed.filter((w) => w.model === 'runEvent' && w.op === 'createMany');
  assert.equal(inserted.length, 1, 'the durable rows are written once — the victims left nothing');
  assert.equal(
    (inserted[0].data as unknown[]).length,
    1,
    'and the streaming delta is still filtered out of the durable set',
  );
  // The one thing a retry could double that the database would never notice.
  assert.equal(
    published.filter((line) => line.startsWith('publish(')).length,
    2,
    'both events reach live subscribers exactly once, after the attempt that committed',
  );
});
