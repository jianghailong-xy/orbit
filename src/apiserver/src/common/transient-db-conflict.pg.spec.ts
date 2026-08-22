import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Controller, LoggerService, Module, Param, Post } from '@nestjs/common';
import { HttpAdapterHost, NestFactory } from '@nestjs/core';
import { Prisma, PrismaClient } from '@prisma/client';
import { Client } from 'pg';

import { TRANSIENT_DB_CONFLICT_CODE, transientDbConflictBody } from '@orbit/shared';
import { Deadline } from '../deadlock/pg-barrier';
import { prismaClientFor } from '../prisma/prisma-client';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { PublicIdExceptionFilter } from './public-id.filter';
import { PublicIdInterceptor } from './public-id.interceptor';
import { TransientDbConflictFilter } from './transient-db-conflict.filter';

const URL = process.env.COORDINATOR_PG_URL;
const SCHEMA = 'pcc_boundary';
/** How often the blocked-state barrier re-reads the server, as in the barrier harness itself. */
const POLL_INTERVAL_MS = 2;

/**
 * The 503 contract, end to end: a real PostgreSQL really aborting a real request's transaction,
 * answered over a real socket by the filter chain `main.ts` registers.
 *
 * The unit contract test next door proves the boundary translates the error shapes Prisma is
 * known to produce. It cannot prove that those are the shapes PostgreSQL and Prisma produce
 * TODAY — that the SQLSTATE is still where the classifier reads it after a driver-adapter
 * upgrade, that an aborted `$transaction` rejects rather than resolving, or that a conflict on a
 * lone statement outside any transaction reaches an HTTP handler at all. Every one of those is a
 * property of the server and the client, so they are asserted here against both events that
 * matter: a serialization failure (40001) and a deadlock (40P01).
 *
 * It is also the only place the redaction claim is worth much. The error that arrives carries
 * PostgreSQL's own words — the statement, this schema's name, the table — so asserting the served
 * body contains none of them is a measurement rather than a restatement of the fixture.
 *
 * Every conflict is scheduled, never raced: the competitor takes its lock first, and the request
 * is released only once PostgreSQL itself reports the request's backend parked behind it.
 *
 * Destructive: it creates a schema and contends rows, so it runs only against the disposable
 * server `scripts/deadlock-barrier.sh` provisions (see coordinator-pg-test-safety).
 */

/** What the routes below write through. Set before the app is built; one client, as in production. */
const harness: { prisma: PrismaClient } = { prisma: null as unknown as PrismaClient };

@Controller('pg')
class WritingController {
  /** The interactive form: a closure that had already read when the server rolled it back. */
  @Post('callback/:key')
  async callback(@Param('key') key: string): Promise<unknown> {
    return harness.prisma.$transaction(
      async (tx) => {
        // Fixes this transaction's snapshot, so the competitor's commit lands after it.
        await tx.$queryRawUnsafe(`SELECT n FROM ${SCHEMA}.counter WHERE k = $1`, key);
        await tx.$executeRawUnsafe(`UPDATE ${SCHEMA}.counter SET n = n + 1 WHERE k = $1`, key);
        return { written: true };
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
        maxWait: 20_000,
        timeout: 60_000,
      },
    );
  }

  /** The array form: the batch IS the transaction, so the whole array is what was thrown away. */
  @Post('array/:key')
  async array(@Param('key') key: string): Promise<unknown> {
    const prisma = harness.prisma;
    return prisma.$transaction(
      [
        prisma.$queryRawUnsafe(`SELECT n FROM ${SCHEMA}.counter WHERE k = $1`, key),
        prisma.$executeRawUnsafe(`UPDATE ${SCHEMA}.counter SET n = n + 1 WHERE k = $1`, key),
      ],
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 60_000 },
    );
  }

  /**
   * One statement, no transaction of its own — and still abortable, because two rows in one
   * UPDATE is a lock cycle waiting for a second writer holding them the other way round.
   *
   * `ORDER BY … FOR UPDATE` in the sub-select is what makes the cycle deterministic instead of
   * dependent on the scan order: the rows are locked in the order the sort produced, so this side
   * always takes `dl-a` first and always waits on `dl-b`.
   */
  @Post('direct')
  async direct(): Promise<unknown> {
    await harness.prisma.$executeRawUnsafe(
      `UPDATE ${SCHEMA}.counter SET n = n + 1
         WHERE k IN (SELECT k FROM ${SCHEMA}.counter
                      WHERE k = ANY($1::text[]) ORDER BY k FOR UPDATE)`,
      ['dl-a', 'dl-b'],
    );
    return { written: true };
  }
}

@Module({ controllers: [WritingController] })
class WritingModule {}

/** Nest's logger, captured: a real driver message is exactly what must not reach a log line. */
const logged: string[] = [];
const capturingLogger: LoggerService = {
  log: () => undefined,
  error: (message: unknown) => logged.push(String(message)),
  warn: (message: unknown) => logged.push(String(message)),
  debug: () => undefined,
  verbose: () => undefined,
};

test('a real database conflict is answered 503 over HTTP', { skip: !URL, timeout: 180_000 }, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);

  const connect = async (): Promise<Client> => {
    const client = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
    await client.connect();
    await verifyCoordinatorPgIdentity(client);
    return client;
  };

  const admin = await connect();
  // The competitor: the second connection, and the only writer besides the request under test.
  const competitor = await connect();
  const observer = await connect();
  const competitorPid = (await competitor.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid;

  harness.prisma = prismaClientFor(url);
  const app = await NestFactory.create(WritingModule, { logger: capturingLogger });
  app.setGlobalPrefix('api');
  app.useGlobalInterceptors(new PublicIdInterceptor());
  // Verbatim from main.ts. The chain, not the filter: what is being proved is the answer a client
  // gets from the server as it is actually assembled.
  const httpAdapter = app.get(HttpAdapterHost).httpAdapter;
  app.useGlobalFilters(new TransientDbConflictFilter(new PublicIdExceptionFilter(httpAdapter), httpAdapter));
  await app.listen(0, '127.0.0.1');
  const base = await app.getUrl();

  t.after(async () => {
    await app.close().catch(() => undefined);
    await harness.prisma.$disconnect().catch(() => undefined);
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => undefined);
    for (const client of [admin, competitor, observer]) await client.end().catch(() => undefined);
  });

  await admin.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);
  await admin.query(`CREATE TABLE IF NOT EXISTS ${SCHEMA}.counter (k text PRIMARY KEY, n integer NOT NULL)`);

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

  /**
   * Advance only when PostgreSQL itself reports a backend — the one serving the request, whichever
   * pooled connection that is — parked behind the competitor. A condition barrier, not a sleep: a
   * state that never arrives fails on the deadline instead of passing quietly.
   */
  const awaitRequestBlocked = async (what: string): Promise<number> => {
    const deadline = new Deadline(60_000);
    for (;;) {
      deadline.assertLive(`waiting for ${what} to block on the competitor (pid ${competitorPid})`);
      const { rows } = await observer.query<{ pid: number }>(
        `SELECT pid FROM pg_stat_activity
           WHERE pid <> $1 AND $1 = ANY(pg_blocking_pids(pid))`,
        [competitorPid],
      );
      if (rows.length === 1) return rows[0].pid;
      assert.ok(rows.length <= 1, `${rows.length} backends are blocked on the competitor at once`);
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
  };

  /** The request, left in flight: it is answered only after the conflict has been arranged. */
  const post = (route: string) =>
    fetch(`${base}/api/pg/${route}`, { method: 'POST' }).then(async (response) => ({
      status: response.status,
      retryAfter: response.headers.get('retry-after'),
      text: await response.text(),
    }));

  /**
   * The whole answer — and, on a real error, the whole redaction claim: PostgreSQL's message for
   * every one of these names the schema, the table and the statement.
   */
  const assertConflictAnswer = (answer: { status: number; retryAfter: string | null; text: string }, shape: string) => {
    assert.equal(answer.status, 503, `${shape}: answered ${answer.status} — ${answer.text}`);
    assert.deepEqual(JSON.parse(answer.text), transientDbConflictBody(), `${shape}: the body is the contract`);
    assert.equal(answer.retryAfter, '1', `${shape}: Retry-After`);
    for (const secret of [SCHEMA, 'counter', 'UPDATE', 'SELECT', '40001', '40P01', 'deadlock', 'serialize', 'prisma']) {
      assert.ok(!answer.text.includes(secret), `${shape}: the response repeats ${secret} — ${answer.text}`);
    }
  };

  await t.test('an interactive transaction PostgreSQL aborted with 40001', async () => {
    await seed('cb');
    // The competitor takes the row and holds it, so the request's UPDATE parks behind it rather
    // than failing outright — and wakes into a 40001 the moment that write is committed.
    await competitor.query('BEGIN');
    await competitor.query(`UPDATE ${SCHEMA}.counter SET n = n + 1 WHERE k = $1`, ['cb']);
    const inFlight = post('callback/cb');
    await awaitRequestBlocked('the callback transaction');
    await competitor.query('COMMIT');

    assertConflictAnswer(await inFlight, 'callback');
    // Only the competitor's increment survived: the aborted transaction left nothing behind, and
    // the boundary did not quietly re-run it.
    assert.equal(await read('cb'), 1, 'the boundary retried the write instead of answering');
  });

  await t.test('the array form, aborted the same way', async () => {
    await seed('arr');
    await competitor.query('BEGIN');
    await competitor.query(`UPDATE ${SCHEMA}.counter SET n = n + 1 WHERE k = $1`, ['arr']);
    const inFlight = post('array/arr');
    await awaitRequestBlocked('the array transaction');
    await competitor.query('COMMIT');

    assertConflictAnswer(await inFlight, 'array');
    assert.equal(await read('arr'), 1);
  });

  await t.test('a single write outside any transaction, aborted with 40P01', async () => {
    await seed('dl-a', 'dl-b');
    await competitor.query('BEGIN');
    // The competitor waits twenty seconds before running the deadlock detector, so the backend
    // serving the request — on PostgreSQL's default one second — is the one that finds the cycle
    // and therefore the one aborted. That is what makes the victim this test's request every time
    // rather than a coin flip.
    await competitor.query(`SET LOCAL deadlock_timeout = '20s'`);
    await competitor.query(`UPDATE ${SCHEMA}.counter SET n = n + 1 WHERE k = $1`, ['dl-b']);

    const inFlight = post('direct');
    await awaitRequestBlocked('the single write');
    // Closing the cycle: the competitor now wants the row the request already holds.
    const closesTheCycle = competitor.query(`UPDATE ${SCHEMA}.counter SET n = n + 1 WHERE k = $1`, ['dl-a']);

    assertConflictAnswer(await inFlight, 'direct');
    await closesTheCycle;
    await competitor.query('COMMIT');
    // The request's half of the cycle was rolled back whole: `dl-a` carries the competitor's
    // increment and not the request's, even though the request had already locked it.
    assert.equal(await read('dl-a'), 1);
    assert.equal(await read('dl-b'), 1);
  });

  await t.test('what was logged names the reason and nothing PostgreSQL said', () => {
    const lines = logged.filter((line) => line.includes(TRANSIENT_DB_CONFLICT_CODE));
    assert.equal(lines.length, 3, 'one line per conflict answered');
    for (const line of lines) {
      for (const secret of [SCHEMA, 'counter', 'UPDATE ', 'SELECT ', 'Invalid `prisma']) {
        assert.ok(!line.includes(secret), `the log repeats ${secret}: ${line}`);
      }
    }
    // The SQLSTATEs the server really raised, read structurally by the shared classifier — the
    // assertion that fails if a Prisma upgrade moves the code somewhere it does not look.
    assert.ok(lines.some((l) => l.includes('SERIALIZATION') && l.includes('evidence=40001')), lines.join('\n'));
    assert.ok(lines.some((l) => l.includes('DEADLOCK') && l.includes('evidence=40P01')), lines.join('\n'));
  });
});
