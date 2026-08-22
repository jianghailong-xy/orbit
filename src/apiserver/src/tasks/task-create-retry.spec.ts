import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ForbiddenException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { classifyTransactionError } from '../common/transaction-retry';
import { TasksService } from './tasks.service';

const OWNER = 'owner-1';
const SESSION = '550e8400-e29b-41d4-a716-446655440000';
const PREREQUISITE = '550e8400-e29b-41d4-a716-446655440001';
const CLIENT_VERSION = '7.9.1';

/**
 * What `create` and `createMany` do when PostgreSQL throws their transaction away.
 *
 * The claim under test is not "there is a retry" — that is `common/transaction-retry`'s, and it is
 * tested there. It is that a Task create is a *unit of work* the loop can re-run: that a victim
 * re-runs the whole of it and lands exactly one task or exactly one batch, that the parts a retry
 * must not re-derive (the idempotency key, the resolved session, the batch's own refs) are the
 * same on every attempt, and that the effects that must not happen twice — the realtime publish —
 * happen after the attempt that committed and only then.
 *
 * The other half is what must NOT be retried. A duplicate key, a foreign key violation and a
 * business refusal are answers about the request, not about the transaction, so a second attempt
 * can only reach the same answer a beat later. Each is asserted by ATTEMPT COUNT, because that is
 * the only thing that distinguishes "answered" from "answered after spending the retry budget".
 */

/**
 * The error Prisma 7 raises for a statement PostgreSQL aborted: the top-level code is the generic
 * `P2010` and the SQLSTATE survives at `meta.driverAdapterError.cause.originalCode`. The same
 * shape as `transient-db-conflict.spec.ts` uses, captured from a real conflict in
 * `transaction-retry.pg.spec.ts` — the ordered pre-locks a create takes are raw queries, so this
 * is the shape a Task create's conflict really arrives in.
 */
function abortedStatement(originalCode: string, originalMessage: string) {
  return new Prisma.PrismaClientKnownRequestError(
    `Invalid \`prisma.$queryRaw()\` invocation:\n\nRaw query failed. Code: \`${originalCode}\`. ` +
      `Message: \`${originalMessage}\`\nSELECT "id" FROM "session" WHERE "id" = $1 FOR KEY SHARE`,
    {
      code: 'P2010',
      clientVersion: CLIENT_VERSION,
      meta: {
        driverAdapterError: {
          name: 'DriverAdapterError',
          cause: { originalCode, originalMessage, kind: 'TransactionWriteConflict' },
        },
      },
    },
  );
}

const deadlock = () => abortedStatement('40P01', 'deadlock detected');
const serializationFailure = () =>
  abortedStatement('40001', 'could not serialize access due to concurrent update');
const foreignKeyViolation = () =>
  new Prisma.PrismaClientKnownRequestError('Foreign key constraint violated', {
    code: 'P2003',
    clientVersion: CLIENT_VERSION,
  });
const duplicateKey = () =>
  new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: CLIENT_VERSION,
  });

interface FixtureOptions {
  /** How many transactions the server throws away before one is allowed to commit. */
  failures?: number;
  error?: () => Error;
  /** The id `currentTurnId` resolves to; null means no live turn, so no idempotency key. */
  inFlightTurn?: string | null;
  /** What a task already committed under this key is, if anything. */
  existingByKey?: (key: string) => unknown;
}

/**
 * A prisma double that really rolls back.
 *
 * Each `$transaction` gets its own pending buffer; rows written into it only join `committed`
 * when that attempt is allowed to commit. So "the victim left nothing behind" is a fact about the
 * fixture's state rather than something the test has to take on trust, and a second attempt that
 * looked up its own first attempt's rows would find nothing — exactly as it would against a real
 * server.
 */
function fixture(opts: FixtureOptions = {}) {
  const failures = opts.failures ?? 0;
  const error = opts.error ?? deadlock;
  const existingByKey = opts.existingByKey ?? (() => null);

  const committed: Array<Record<string, unknown> & { id: string }> = [];
  const committedEdges: Array<Record<string, unknown>> = [];
  /** Every row a create ATTEMPTED, committed or not — what proves the key is stable. */
  const attempted: Array<Record<string, unknown>> = [];
  const published: string[] = [];
  const logged: string[] = [];
  let attempts = 0;
  let rows = 0;

  const findCommitted = (key: string | undefined) =>
    (key ? committed.find((row) => row.idempotencyKey === key) : undefined) ??
    (key ? (existingByKey(key) as Record<string, unknown> | null) : null) ??
    null;

  const transactionClient = () => {
    const pendingTasks: Array<Record<string, unknown> & { id: string }> = [];
    const pendingEdges: Array<Record<string, unknown>> = [];
    const task = {
      findUnique: async ({ where }: { where: { idempotencyKey?: string } }) =>
        pendingTasks.find((row) => row.idempotencyKey === where.idempotencyKey) ??
        findCommitted(where.idempotencyKey),
      create: async ({ data }: { data: Record<string, unknown> }) => {
        attempted.push(data);
        rows += 1;
        const row = { id: `task-${rows}`, ...data };
        pendingTasks.push(row);
        return row;
      },
      count: async () => 1,
    };
    const tx = {
      task,
      taskDependency: {
        createMany: async ({ data }: { data: Array<Record<string, unknown>> }) => {
          pendingEdges.push(...data);
          return { count: data.length };
        },
      },
      $queryRaw: async () => [],
    };
    return { tx, pendingTasks, pendingEdges };
  };

  const prisma = {
    task: {
      findUnique: async ({ where }: { where: { idempotencyKey?: string } }) =>
        findCommitted(where.idempotencyKey),
      count: async () => 1,
    },
    session: { findFirst: async () => ({ id: SESSION }) },
    conversationTurn: {
      findFirst: async () =>
        opts.inFlightTurn === undefined || opts.inFlightTurn === null
          ? null
          : { id: opts.inFlightTurn },
      count: async () => 0,
    },
    taskList: { findMany: async () => [] },
    project: { count: async () => 1 },
    $queryRaw: async () => [],
    $transaction: async <T>(work: (tx: unknown) => Promise<T>): Promise<T> => {
      attempts += 1;
      const { tx, pendingTasks, pendingEdges } = transactionClient();
      const result = await work(tx);
      // The server's verdict arrives after the closure has run and written: a deadlock victim is
      // picked while it is holding rows, not before it asks for any.
      if (attempts <= failures) throw error();
      committed.push(...pendingTasks);
      committedEdges.push(...pendingEdges);
      return result;
    },
  };

  const service = new TasksService(prisma as never, {} as never, {
    publishTaskChanged: (_sessionId: string, taskId: string) => void published.push(taskId),
  } as never);
  // The retry line is the only thing these paths say about a conflict, and what it may contain is
  // part of the contract — so it is captured rather than printed.
  (service as unknown as { logger: unknown }).logger = {
    warn: (line: string) => void logged.push(line),
    error: () => undefined,
    log: () => undefined,
  };

  return {
    service,
    committed,
    committedEdges,
    attempted,
    published,
    logged,
    attempts: () => attempts,
  };
}

// ----------------------------------------------------------------------------------------------
// A conflict the loop absorbs.
// ----------------------------------------------------------------------------------------------

test('a create thrown away twice re-runs whole and lands exactly one task', async () => {
  const f = fixture({ failures: 2, error: deadlock, inFlightTurn: 'turn-A' });

  const task = await f.service.create(
    OWNER,
    { title: 'Ship the fix', dependsOnTaskIds: [PREREQUISITE] } as never,
    undefined,
    SESSION,
  );

  assert.equal(f.attempts(), 3, 'two victims, then the attempt that committed');
  assert.equal(f.attempted.length, 3, 'the whole closure re-ran, INSERT and all');
  assert.equal(f.committed.length, 1, 'and exactly one row survived');
  assert.equal(f.committedEdges.length, 1, 'with its prerequisite edge, in the same transaction');
  assert.equal((task as { id: string }).id, f.committed[0].id);
  // The one effect that cannot be rolled back. Outside the loop, so it describes the attempt that
  // committed rather than every attempt that was thrown away.
  assert.deepEqual(f.published, [f.committed[0].id], 'the realtime publish happens once');
  // Stable identity: the key is computed once, before the loop, so a retry re-inserts the same
  // row rather than a second one. Were it derived per attempt, a redelivered turn would stop
  // collapsing onto the original task.
  const keys = new Set(f.attempted.map((data) => data.idempotencyKey));
  assert.equal(keys.size, 1, 'every attempt wrote the same idempotency key');
  assert.ok([...keys][0], 'and there was a key to keep stable');
});

test('a create with no session and no links is retried too', async () => {
  // The path that used to be a bare `task.create` with no transaction at all — and therefore no
  // unit of work to re-run. It is the commonest create there is.
  const f = fixture({ failures: 1, error: serializationFailure });

  await f.service.create(OWNER, { title: 'just a task' } as never);

  assert.equal(f.attempts(), 2, 'the plain create is a transaction, and it is retried');
  assert.equal(f.committed.length, 1);
  assert.deepEqual(f.published, [], 'no creator session, so nothing to publish through');
});

test('a batch thrown away twice re-runs whole and lands exactly one batch', async () => {
  const f = fixture({ failures: 2, error: serializationFailure, inFlightTurn: 'turn-A' });

  const created = await f.service.createMany(
    OWNER,
    { tasks: [{ title: 'A', ref: 'a' }, { title: 'B', dependsOnRefs: ['a'] }] } as never,
    undefined,
    SESSION,
  );

  assert.equal(f.attempts(), 3);
  assert.equal(f.attempted.length, 6, 'both items re-written on every attempt');
  assert.equal(f.committed.length, 2, 'and exactly one batch survived');
  assert.equal(f.committedEdges.length, 1, 'the within-batch edge landed with it');
  assert.equal(created.length, 2);
  // A ref resolves to an id this same transaction wrote, so it has to be re-resolved per attempt —
  // an edge still pointing at the aborted attempt's row would be a foreign key violation.
  assert.equal(f.committedEdges[0].dependsOnTaskId, f.committed[0].id);
  assert.equal(f.committedEdges[0].taskId, f.committed[1].id);
  assert.deepEqual(
    f.published,
    f.committed.map((row) => row.id),
    'one publish per task, after the attempt that committed',
  );
  const keys = f.attempted.map((data) => data.idempotencyKey);
  assert.equal(new Set(keys).size, 2, 'two items, two keys, the same two on every attempt');
});

// ----------------------------------------------------------------------------------------------
// A conflict the loop gives up on.
// ----------------------------------------------------------------------------------------------

for (const [name, call] of [
  [
    'create',
    (f: ReturnType<typeof fixture>) =>
      f.service.create(OWNER, { title: 'Ship the fix' } as never, undefined, SESSION),
  ],
  [
    'createMany',
    (f: ReturnType<typeof fixture>) =>
      f.service.createMany(OWNER, { tasks: [{ title: 'A' }] } as never, undefined, SESSION),
  ],
] as const) {
  test(`${name} rethrows an unrelenting conflict unchanged, for the boundary to answer`, async () => {
    const f = fixture({ failures: Number.POSITIVE_INFINITY, error: deadlock, inFlightTurn: 'turn-A' });

    const raised = await call(f).then(
      () => null,
      (e: unknown) => e,
    );

    // Unchanged is the whole point: the global boundary decides what a caller is told, and it can
    // only recognise a conflict it is handed as one. A service that wrapped this in its own
    // exception would turn a 503 into a 500 (see common/transient-db-conflict.filter).
    assert.ok(raised instanceof Prisma.PrismaClientKnownRequestError);
    assert.equal(classifyTransactionError(raised).retryable, true);
    assert.equal(classifyTransactionError(raised).evidence, '40P01');
    assert.equal(f.attempts(), 4, 'the bounded budget, spent — not an unbounded loop');
    assert.equal(f.committed.length, 0, 'nothing was left behind by the attempts that failed');
    assert.deepEqual(f.published, [], 'and nothing was announced');
  });
}

// ----------------------------------------------------------------------------------------------
// What must never be retried: answers about the request, not about the transaction.
// ----------------------------------------------------------------------------------------------

test('a duplicate key is answered on the first attempt, not retried', async () => {
  // The concurrent re-run of one turn: the winner committed between this call's pre-check and its
  // INSERT. Retrying could only reach the same unique index a beat later.
  const winner = { id: 'task-winner' };
  // The race in order: the pre-check misses, the winner commits, this INSERT collides, and the
  // post-collision lookup finds what the pre-check could not have seen.
  let lookups = 0;
  const f = fixture({
    failures: 1,
    error: duplicateKey,
    inFlightTurn: 'turn-A',
    existingByKey: () => (lookups++ === 0 ? null : winner),
  });

  const task = await f.service.create(OWNER, { title: 'Ship the fix' } as never, undefined, SESSION);

  assert.equal(f.attempts(), 1, 'answered where it was raised');
  assert.equal((task as { id: string }).id, winner.id, 'and the caller gets the winner');
});

test('a foreign key violation is answered on the first attempt, not retried', async () => {
  const f = fixture({ failures: Number.POSITIVE_INFINITY, error: foreignKeyViolation });

  await assert.rejects(f.service.create(OWNER, { title: 'orphan' } as never));

  assert.equal(f.attempts(), 1);
});

test('a raw-wrapped 23503 is not mistaken for a conflict just because it says P2010', async () => {
  // The permanent failure in the transient one's clothing: same wrapper, same `P2010`, and only
  // the SQLSTATE two objects down tells them apart.
  const f = fixture({
    failures: Number.POSITIVE_INFINITY,
    error: () => abortedStatement('23503', 'insert on table "task" violates foreign key constraint'),
  });

  await assert.rejects(f.service.createMany(OWNER, { tasks: [{ title: 'orphan' }] } as never));

  assert.equal(f.attempts(), 1);
});

test('a business refusal raised inside the transaction is not retried', async () => {
  const f = fixture({
    failures: Number.POSITIVE_INFINITY,
    error: () => new ForbiddenException('project not found'),
  });

  await assert.rejects(
    f.service.create(OWNER, { title: 'Ship the fix' } as never, undefined, SESSION),
    ForbiddenException,
  );

  assert.equal(f.attempts(), 1, 'a decision about the request survives a second attempt unchanged');
});

// ----------------------------------------------------------------------------------------------
// What the retry is allowed to say about itself.
// ----------------------------------------------------------------------------------------------

test('the retry line carries the operation, outcome, attempt and SQLSTATE — and nothing else', async () => {
  const f = fixture({ failures: 1, error: deadlock, inFlightTurn: 'turn-A' });

  await f.service.create(
    OWNER,
    { title: 'summarise my private notes', description: 'sk-ant-oat01-not-a-real-token' } as never,
    undefined,
    SESSION,
  );

  assert.deepEqual(f.logged, [
    'operation=tasks.create outcome=RETRYING attempt=1/4 sqlstate=40P01',
    'operation=tasks.create outcome=COMMITTED attempt=2/4 sqlstate=none',
  ]);
  // Every field above is from a closed set — the operation names in this file, the loop's own
  // outcomes, a counter, and the SQLSTATEs the classifier recognises — so these lines aggregate.
  // What they must never carry is the error, which is where the statement, the bound parameters
  // and (on this table) the user's own prompt are.
  for (const secret of [
    'summarise my private notes',
    'sk-ant-oat01-not-a-real-token',
    'FOR KEY SHARE',
    'deadlock detected',
    SESSION,
  ]) {
    assert.equal(
      f.logged.some((line) => line.includes(secret)),
      false,
      `the retry line leaked ${secret}`,
    );
  }
});

test('an ordinary create says nothing at all', async () => {
  const f = fixture({ inFlightTurn: 'turn-A' });

  await f.service.create(OWNER, { title: 'Ship the fix' } as never, undefined, SESSION);

  assert.deepEqual(f.logged, [], 'a first-attempt commit is every create there is');
});
