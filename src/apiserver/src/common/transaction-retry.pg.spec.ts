import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Prisma, PrismaClient } from '@prisma/client';
import { Client } from 'pg';

import { Deadline, Observer } from '../deadlock/pg-barrier';
import { prismaClientFor } from '../prisma/prisma-client';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { dbConflictMetricsSnapshot, resetDbConflictMetrics } from './db-conflict-metrics';
import {
  TransactionOutcomeEvent,
  classifyTransactionError,
  withTransactionRetry,
} from './transaction-retry';

const URL = process.env.COORDINATOR_PG_URL;
const SCHEMA = 'pcc_tx_retry';
/** How often the blocked-state barrier re-reads the server, as in the barrier harness itself. */
const POLL_INTERVAL_MS = 2;

/**
 * `withTransactionRetry` against a real PostgreSQL that really aborts the transaction.
 *
 * Unit tests can only prove the loop does what a thrown object asks of it. What they cannot
 * prove is that PostgreSQL raises `40001` where this module expects it, that Prisma still carries
 * the SQLSTATE somewhere the classifier reads after the driver adapter has been through it, or
 * that re-running the closure actually succeeds once the conflicting writer is gone. All three
 * are properties of the server and the client, not of the code, so they are asserted here.
 *
 * Every conflict below is scheduled, never raced: a second connection performs the conflicting
 * write from inside the retried closure, at the one point where its effect on the attempt is
 * determined. The blocked case additionally advances only when PostgreSQL itself reports the
 * retried backend parked in a `Lock` wait behind the competitor (`Observer`, the barrier
 * harness's own primitive). Nothing here waits out a duration hoping the state arrived: the
 * only `setTimeout` is the interval between two reads of the server's own state, and a
 * barrier that never converges fails on its deadline rather than passing quietly.
 *
 * Destructive: it creates a schema and contends rows, so it runs only against the disposable
 * server `scripts/deadlock-barrier.sh` provisions (see coordinator-pg-test-safety).
 */
test('a real 40001 is retried, and a real 40001 storm is given up on', { skip: !URL, timeout: 180_000 }, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);

  /** One `pg` connection, identity-checked before it is allowed to write anything. */
  const connect = async (): Promise<Client> => {
    const client = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
    await client.connect();
    await verifyCoordinatorPgIdentity(client);
    return client;
  };

  const admin = await connect();
  // The competitor: the second connection, and the only writer besides the retried transaction.
  const competitor = await connect();
  // Read-only, so it can watch a blocked backend without joining anything it observes.
  const observerClient = await connect();
  const observer = new Observer(observerClient);
  const competitorPid = (await competitor.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid;

  // The production client, built exactly as the API server builds it: same driver adapter, same
  // interactive-transaction machinery, so the error shape reaching the classifier is production's.
  const prisma: PrismaClient = prismaClientFor(url);

  t.after(async () => {
    await prisma.$disconnect().catch(() => undefined);
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => undefined);
    for (const client of [admin, competitor, observerClient]) await client.end().catch(() => undefined);
  });

  await admin.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);
  await admin.query(`CREATE TABLE IF NOT EXISTS ${SCHEMA}.counter (k text PRIMARY KEY, n integer NOT NULL)`);

  /** Give this subtest its own rows, so no subtest can read another's contention. */
  const seed = async (...keys: string[]): Promise<void> => {
    await admin.query(
      `INSERT INTO ${SCHEMA}.counter (k, n) SELECT unnest($1::text[]), 0
         ON CONFLICT (k) DO UPDATE SET n = 0`,
      [keys],
    );
  };
  const read = async (key: string): Promise<number> => {
    const { rows } = await admin.query<{ n: number }>(`SELECT n FROM ${SCHEMA}.counter WHERE k = $1`, [key]);
    return rows[0].n;
  };
  /** The competitor's whole conflicting transaction, start to commit, on its own connection. */
  const competingBump = async (key: string): Promise<void> => {
    await competitor.query('BEGIN');
    await competitor.query(`UPDATE ${SCHEMA}.counter SET n = n + 1 WHERE k = $1`, [key]);
    await competitor.query('COMMIT');
  };

  await t.test('a repeatable-read snapshot invalidated mid-closure is retried and commits', async () => {
    await seed('rr-ok');
    const attempts: number[] = [];
    const outcomes: TransactionOutcomeEvent[] = [];
    const pids: number[] = [];

    const committedOn = await withTransactionRetry(
      prisma,
      async (tx) => {
        const attempt = attempts.length + 1;
        attempts.push(attempt);
        // The first statement is what fixes this transaction's REPEATABLE READ snapshot, so
        // everything the competitor commits after it is invisible — and unwritable.
        const [{ pid }] = await tx.$queryRawUnsafe<{ pid: number }[]>('SELECT pg_backend_pid() AS pid');
        pids.push(pid);
        await tx.$queryRawUnsafe(`SELECT n FROM ${SCHEMA}.counter WHERE k = $1`, 'rr-ok');
        // Only the first attempt is contended. The second finds the competitor's row already
        // committed before its own snapshot, which is the whole point of starting a new one.
        if (attempt === 1) await competingBump('rr-ok');
        await tx.$executeRawUnsafe(`UPDATE ${SCHEMA}.counter SET n = n + 1 WHERE k = $1`, 'rr-ok');
        return attempt;
      },
      {
        label: 'pg/repeatable-read',
        transaction: {
          isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
          maxWait: 10_000,
          timeout: 30_000,
        },
        baseDelayMs: 1,
        jitterRatio: 0,
        onOutcome: (event) => void outcomes.push(event),
      },
    );

    assert.equal(committedOn, 2, 'the second attempt should be the one that commits');
    assert.deepEqual(attempts, [1, 2], 'the whole closure must run again, not resume');
    assert.notEqual(pids[0], competitorPid, 'the conflict must come from a second connection');
    assert.deepEqual(outcomes.map((o) => o.outcome), ['RETRYING', 'COMMITTED']);
    // PostgreSQL's own verdict, and structurally: `evidence` is the SQLSTATE the driver adapter
    // carried, not a phrase matched out of Prisma's message. That is the assertion that fails if
    // a Prisma upgrade ever moves the code somewhere the classifier does not look.
    assert.deepEqual(classifyTransactionError(outcomes[0].error), {
      retryable: true,
      reason: 'SERIALIZATION',
      evidence: '40001',
      depth: 2,
    });
    // One increment from the competitor and one from the attempt that committed: the aborted
    // attempt left nothing behind, and the retry read the competitor's value rather than its own.
    assert.equal(await read('rr-ok'), 2);
  });

  await t.test('an attempt already blocked on the competitor is aborted, retried and commits', async () => {
    await seed('rr-block');
    const attempts: number[] = [];
    const outcomes: TransactionOutcomeEvent[] = [];
    let observedBlockedBy: number[] = [];

    const committedOn = await withTransactionRetry(
      prisma,
      async (tx) => {
        const attempt = attempts.length + 1;
        attempts.push(attempt);
        const [{ pid }] = await tx.$queryRawUnsafe<{ pid: number }[]>('SELECT pg_backend_pid() AS pid');
        await tx.$queryRawUnsafe(`SELECT n FROM ${SCHEMA}.counter WHERE k = $1`, 'rr-block');
        if (attempt > 1) {
          await tx.$executeRawUnsafe(`UPDATE ${SCHEMA}.counter SET n = n + 1 WHERE k = $1`, 'rr-block');
          return attempt;
        }

        // The competitor takes the row lock and holds it uncommitted, so this attempt's UPDATE
        // parks behind it rather than failing outright. Left outstanding rather than awaited:
        // the backend is only "waiting" while its statement is in flight. `.then` here is what
        // starts it — a PrismaPromise is lazy and sends nothing until it is subscribed to, so
        // merely holding the return value would leave this backend idle forever — and it is
        // also what keeps the failure a value rather than a rejection: the abort can land
        // before the competitor's COMMIT is acknowledged here, and a rejection nobody is
        // waiting on yet is an unhandled rejection that fails the run for the wrong reason.
        await competitor.query('BEGIN');
        await competitor.query(`UPDATE ${SCHEMA}.counter SET n = n + 1 WHERE k = $1`, ['rr-block']);
        const blocked = Promise.resolve(
          tx.$executeRawUnsafe(`UPDATE ${SCHEMA}.counter SET n = n + 1 WHERE k = $1`, 'rr-block'),
        ).then(() => null, (cause: unknown) => ({ cause }));
        try {
          const deadline = new Deadline(30_000);
          for (;;) {
            deadline.assertLive(`waiting for backend ${pid} to block on the competitor`);
            const state = await observer.blockedState(pid);
            if (state.waitEventType === 'Lock' && state.blockingPids.includes(competitorPid)) {
              observedBlockedBy = state.blockingPids;
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
          }
          // Releasing the row is what turns the wait into a 40001: the waiter wakes to find the
          // row's newest version committed after its own snapshot.
          await competitor.query('COMMIT');
        } catch (cause) {
          await competitor.query('ROLLBACK').catch(() => undefined);
          await blocked;
          throw cause;
        }
        const failure = await blocked;
        // Waking up is not succeeding. If PostgreSQL ever let this UPDATE through, the case
        // would be silently testing nothing, so say so instead of retrying zero times.
        assert.ok(failure, 'the blocked UPDATE committed instead of losing its snapshot');
        throw failure.cause;
      },
      {
        label: 'pg/repeatable-read-blocked',
        transaction: { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 60_000 },
        baseDelayMs: 1,
        jitterRatio: 0,
        onOutcome: (event) => void outcomes.push(event),
      },
    );

    assert.equal(committedOn, 2);
    assert.deepEqual(attempts, [1, 2]);
    // The barrier advanced on the server's own report, which is also the evidence that the two
    // transactions really were on two backends contending one row.
    assert.deepEqual(observedBlockedBy, [competitorPid]);
    assert.deepEqual(outcomes.map((o) => o.outcome), ['RETRYING', 'COMMITTED']);
    assert.equal(outcomes[0].reason, 'SERIALIZATION');
    assert.equal(await read('rr-block'), 2);
  });

  await t.test('a serializable read/write cycle is retried and commits', async () => {
    await seed('ser-a', 'ser-b');
    const attempts: number[] = [];
    const outcomes: TransactionOutcomeEvent[] = [];

    const committedOn = await withTransactionRetry(
      prisma,
      async (tx) => {
        const attempt = attempts.length + 1;
        attempts.push(attempt);
        // Classic write skew: this transaction reads b and writes a, the competitor reads a and
        // writes b. Neither blocks the other, and neither would be wrong on its own — SSI aborts
        // the second one to reach commit because together they have no serial order.
        await tx.$queryRawUnsafe(`SELECT n FROM ${SCHEMA}.counter WHERE k = $1`, 'ser-b');
        if (attempt === 1) {
          await competitor.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
          await competitor.query(`SELECT n FROM ${SCHEMA}.counter WHERE k = $1`, ['ser-a']);
          await competitor.query(`UPDATE ${SCHEMA}.counter SET n = n + 1 WHERE k = $1`, ['ser-b']);
          // The competitor commits first, so it is this transaction that PostgreSQL must abort.
          await competitor.query('COMMIT');
        }
        await tx.$executeRawUnsafe(`UPDATE ${SCHEMA}.counter SET n = n + 1 WHERE k = $1`, 'ser-a');
        return attempt;
      },
      {
        label: 'pg/serializable',
        transaction: { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 30_000 },
        baseDelayMs: 1,
        jitterRatio: 0,
        onOutcome: (event) => void outcomes.push(event),
      },
    );

    assert.equal(committedOn, 2);
    assert.deepEqual(attempts, [1, 2]);
    assert.deepEqual(outcomes.map((o) => o.outcome), ['RETRYING', 'COMMITTED']);
    assert.equal(outcomes[0].reason, 'SERIALIZATION');
    // Under SSI the abort can be raised by the conflicting statement or held until COMMIT, and
    // Prisma reports those two differently. Whichever it was, the classifier has to reach the
    // SQLSTATE, which is the point of reading the whole wrapper chain rather than one field.
    const verdict = classifyTransactionError(outcomes[0].error);
    assert.equal(verdict.retryable, true);
    assert.equal(verdict.evidence, '40001');
    assert.equal(await read('ser-a'), 1);
    assert.equal(await read('ser-b'), 1);
  });

  await t.test('a conflict on every attempt exhausts the budget and commits nothing', async () => {
    await seed('rr-exhaust');
    const attempts: number[] = [];
    const outcomes: TransactionOutcomeEvent[] = [];

    await assert.rejects(
      withTransactionRetry(
        prisma,
        async (tx) => {
          attempts.push(attempts.length + 1);
          await tx.$queryRawUnsafe(`SELECT n FROM ${SCHEMA}.counter WHERE k = $1`, 'rr-exhaust');
          // Contended on every attempt, so no attempt can ever commit.
          await competingBump('rr-exhaust');
          await tx.$executeRawUnsafe(`UPDATE ${SCHEMA}.counter SET n = n + 1 WHERE k = $1`, 'rr-exhaust');
          return 'unreachable';
        },
        {
          label: 'pg/exhaustion',
          transaction: { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 30_000 },
          maxAttempts: 3,
          baseDelayMs: 1,
          jitterRatio: 0,
          onOutcome: (event) => void outcomes.push(event),
        },
      ),
      (thrown: unknown) => {
        // The last failure reaches the caller unchanged — still recognisably PostgreSQL's, so a
        // boundary above can classify it exactly as this loop did.
        assert.equal(classifyTransactionError(thrown).retryable, true);
        assert.equal(classifyTransactionError(thrown).reason, 'SERIALIZATION');
        return true;
      },
    );

    assert.deepEqual(attempts, [1, 2, 3], 'the bound is on attempts, not on retries');
    assert.deepEqual(outcomes.map((o) => o.outcome), ['RETRYING', 'RETRYING', 'EXHAUSTED']);
    // Three competitor increments and nothing else: every aborted attempt rolled back whole.
    assert.equal(await read('rr-exhaust'), 3);
  });

  await t.test('what an operator sees, on conflicts PostgreSQL itself raised', async () => {
    // `db-conflict-metrics.spec.ts` proves the counting given a classified error. This proves the
    // classification the counting is given is the one a REAL server and a REAL driver adapter
    // produce: the SQLSTATE that ends up in a label is the one PostgreSQL raised, not a phrase
    // recovered from a message, and the two situations an operator has to tell apart — a conflict
    // absorbed, a conflict that outlived the attempts — end up as two different rows.
    await seed('metrics-absorbed', 'metrics-exhausted');
    resetDbConflictMetrics();

    let attempt = 0;
    await withTransactionRetry(
      prisma,
      async (tx) => {
        attempt += 1;
        await tx.$queryRawUnsafe(`SELECT n FROM ${SCHEMA}.counter WHERE k = $1`, 'metrics-absorbed');
        if (attempt === 1) await competingBump('metrics-absorbed');
        await tx.$executeRawUnsafe(`UPDATE ${SCHEMA}.counter SET n = n + 1 WHERE k = $1`, 'metrics-absorbed');
        return attempt;
      },
      {
        label: 'pg.metricsAbsorbed',
        transaction: { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 30_000 },
        baseDelayMs: 1,
        jitterRatio: 0,
      },
    );

    await assert.rejects(
      withTransactionRetry(
        prisma,
        async (tx) => {
          await tx.$queryRawUnsafe(`SELECT n FROM ${SCHEMA}.counter WHERE k = $1`, 'metrics-exhausted');
          await competingBump('metrics-exhausted');
          await tx.$executeRawUnsafe(`UPDATE ${SCHEMA}.counter SET n = n + 1 WHERE k = $1`, 'metrics-exhausted');
          return 'unreachable';
        },
        {
          label: 'pg.metricsExhausted',
          transaction: { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 30_000 },
          maxAttempts: 2,
          baseDelayMs: 1,
          jitterRatio: 0,
        },
      ),
    );

    const counted = dbConflictMetricsSnapshot().units.map((series) => series.labels);
    assert.deepEqual(counted, [
      {
        operation: 'pg.metricsAbsorbed',
        outcome: 'committed',
        handling: 'absorbed',
        origin: 'fault_injection',
        classifier: 'serialization',
        sqlstate: '40001',
        attempt: '2',
      },
      {
        operation: 'pg.metricsExhausted',
        outcome: 'conflict',
        handling: 'exhausted',
        origin: 'fault_injection',
        classifier: 'serialization',
        sqlstate: '40001',
        attempt: '2',
      },
    ]);
    // `origin` above is not decoration. This whole file runs under
    // `scripts/deadlock-barrier.sh`, which makes conflicts on purpose and says so in the
    // environment; a graph that could not subtract these would page on a test suite passing.
    assert.equal(process.env.ORBIT_DB_CONFLICT_ORIGIN, 'fault_injection');

    // And the duration is the caller's, not one attempt's: it spans both attempts and the backoff
    // between them, which is the number that answers "what did the retry cost".
    const [absorbed] = dbConflictMetricsSnapshot().durations;
    assert.ok(absorbed.count >= 1 && absorbed.sum > 0, 'no wall time was recorded for a retried unit');
  });
});
