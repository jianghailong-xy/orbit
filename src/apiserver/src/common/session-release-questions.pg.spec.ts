/**
 * THE TWO RELEASE QUESTIONS ANSWER ALIKE IN EVERY SPELLING, AND THE AUTO-RETRY SWEEP KEEPS ITS ACCESS PATH.
 *
 * docs/session-three-state-design.md §12.2 and §12.3, removal steps R3 and R4 (decision D9): common/session-release.ts
 * asks "released by a failure" and "the work finished" as a predicate, a Prisma filter and an SQL fragment. Against
 * PostgreSQL:
 *
 *   (1) every release row shape of the fixture (common/session-release-shapes.fixture.ts) is written as a session row;
 *       the predicate over the row read back, the Prisma filter, a NOT of the filter, and the SQL fragment and a NOT of
 *       it answer alike for both questions, and the SQL never answers null;
 *   (2) the three queries of AutoRetryService that read the failure question (the sweep's due rows, releaseHeldRetries,
 *       releaseExpiredClaims) are captured as Prisma sends them, their where clauses copied here before R4 (the
 *       release cause) and after (the module's filter), the copy after held to the real query's text, and both
 *       EXPLAINed on a session table of 200,000 rows: each keeps its index, the same before and after.
 *
 *     bash scripts/run-pg-spec.sh src/apiserver/src/common/session-release-questions.pg.spec.ts
 *
 * Not destructive: every id is freshly generated; the bulk rows belong to an owner of their own.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { Prisma, PrismaClient, ProjectStatus, RunStatus, RunnerStatus } from '@prisma/client';
import { Client } from 'pg';

import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import { pgAdapterFor, prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import { ACCOUNT_RESET_WAIT_MS } from '../providers/plan-usage-accounts';
import { QueueService } from '../queue/queue.service';
import type { RealtimeService } from '../realtime/realtime.service';
import { AutoRetryService } from '../sessions/auto-retry.service';
import { RETRY_CLAIM_WINDOW_MS } from '../sessions/session-request';
import { SessionsService } from '../sessions/sessions.service';
import { turnStateFilter } from '../sessions/session-turn-state';
import {
  RELEASE_FACTS_SELECT,
  releaseFinishedTheWork,
  releaseFinishedTheWorkFilter,
  releaseFinishedTheWorkSql,
  releaseWasFailure,
  releaseWasFailureFilter,
  releaseWasFailureSql,
} from './session-release';
import { RELEASE_SHAPES } from './session-release-shapes.fixture';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

interface World { ownerId: string; runnerId: string; workspaceId: string }

async function world(db: PrismaClient, label: string): Promise<World> {
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  await db.user.create({ data: { id: ownerId, email: `${label}-${ownerId}@release-questions.invalid`, name: label, passwordHash: 'x' } });
  await db.runner.create({
    data: {
      id: runnerId, ownerId, name: `${label}-runner`, tokenHash: `hash-${runnerId}`, status: RunnerStatus.ONLINE,
      capabilities: [], capabilitiesReportedAt: new Date(), lastHeartbeatAt: new Date(),
    },
  });
  await db.workspace.create({
    data: { id: workspaceId, ownerId, runnerId, name: `${label}-workspace`, enabled: true, workDir: `/srv/${label}` },
  });
  return { ownerId, runnerId, workspaceId };
}

const quiet = new Proxy({}, { get: () => () => undefined }) as unknown as RealtimeService;

test('the release questions answer alike in every spelling, and the auto-retry sweep keeps its access path', {
  skip, concurrency: 1, timeout: 900_000,
}, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const db = prismaClientFor(url);
  t.after(async () => {
    await db.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });

  await t.test('(1) every release shape: the predicate, the filter, its NOT, the SQL and its NOT agree', async () => {
    const w = await world(db, 'shapes');
    const ids = new Map<string, string>();
    for (const shape of RELEASE_SHAPES) {
      const id = randomUUID();
      ids.set(id, shape.name);
      const landing = shape.sessionKind === 'LANDING';
      await db.session.create({
        data: {
          id, ownerId: w.ownerId, creatorId: w.ownerId, workspaceId: w.workspaceId, title: shape.name, prompt: shape.what,
          status: shape.status,
          ...(landing
            ? { sessionKind: 'LANDING', provider: 'orbit', providerBuiltin: true, engine: null, startsTaskWork: false }
            : { provider: 'claude', providerBuiltin: true, engine: 'claude', assignedRunnerId: w.runnerId }),
          finishedAt: shape.released ? new Date() : null,
          endReason: shape.endReason,
          ...(shape.endReason ? { cancelRequestedAt: new Date() } : {}),
          lastTurnOutcome: shape.lastTurnOutcome,
        },
      });
    }
    const all = [...ids.keys()];
    const rows = await db.session.findMany({ where: { id: { in: all } }, select: { id: true, ...RELEASE_FACTS_SELECT } });
    const matching = async (where: Prisma.SessionWhereInput) => new Set((await db.session.findMany({
      where: { id: { in: all }, AND: [where] }, select: { id: true },
    })).map((row) => row.id));
    const failedByFilter = await matching(releaseWasFailureFilter());
    const notFailedByFilter = await matching({ NOT: releaseWasFailureFilter() });
    const finishedByFilter = await matching(releaseFinishedTheWorkFilter());
    const notFinishedByFilter = await matching({ NOT: releaseFinishedTheWorkFilter() });
    const bySql = await db.$queryRaw<Array<{ id: string; failed: boolean | null; not_failed: boolean | null;
      finished: boolean | null; not_finished: boolean | null }>>(Prisma.sql`
      SELECT s."id", ${releaseWasFailureSql('s')} AS failed, NOT ${releaseWasFailureSql('s')} AS not_failed,
             ${releaseFinishedTheWorkSql('s')} AS finished, NOT ${releaseFinishedTheWorkSql('s')} AS not_finished
        FROM "session" s WHERE s."id" = ANY(${all}::uuid[])`);
    const sqlOf = new Map(bySql.map((row) => [row.id, row]));
    assert.equal(rows.length, RELEASE_SHAPES.length);
    for (const row of rows) {
      const name = ids.get(row.id)!;
      const failed = releaseWasFailure(row);
      const finished = releaseFinishedTheWork(row);
      const fromSql = sqlOf.get(row.id)!;
      console.log(`# ${name} | failed ${failed} | finished ${finished}`);
      assert.equal(failedByFilter.has(row.id), failed, `${name}: the failure filter`);
      assert.equal(notFailedByFilter.has(row.id), !failed, `${name}: NOT of the failure filter`);
      assert.equal(fromSql.failed, failed, `${name}: the failure SQL`);
      assert.equal(fromSql.not_failed, !failed, `${name}: NOT of the failure SQL, never null`);
      assert.equal(finishedByFilter.has(row.id), finished, `${name}: the work filter`);
      assert.equal(notFinishedByFilter.has(row.id), !finished, `${name}: NOT of the work filter`);
      assert.equal(fromSql.finished, finished, `${name}: the work SQL`);
      assert.equal(fromSql.not_finished, !finished, `${name}: NOT of the work SQL, never null`);
    }
  });

  await t.test('(2) the sweep, releaseHeldRetries and releaseExpiredClaims keep their index, before and after', async () => {
    // The queries as Prisma sends them: a client that logs every statement, under the service itself.
    const logged = new PrismaClient({ adapter: pgAdapterFor(url), log: [{ emit: 'event', level: 'query' }] });
    t.after(async () => {
      await logged.$disconnect().catch(() => undefined);
    });
    const statements: Array<{ query: string; params: string }> = [];
    logged.$on('query', (event) => statements.push({ query: event.query, params: event.params }));
    const prisma = logged as unknown as PrismaService;
    const sessions = new SessionsService(prisma, new QueueService(prisma, quiet), quiet);
    const service = new AutoRetryService(prisma, sessions, quiet);
    const now = new Date();

    // The where clauses of the three queries (sessions/auto-retry.service.ts), with the failure arm given: the module's
    // filter. Their other halves are copied as they stand. The parked arm is on the turn state since task T10 (turnStateFilter([null]):
    // held with none, a row not yet backfilled by its stored word).
    const NOT_DISPATCH_HELD: Prisma.SessionWhereInput = {
      OR: [{ taskId: null }, { startsTaskWork: false }, { task: { dispatchHold: false } }],
    };
    const NOT_IN_CANCELLED_PROJECT: Prisma.SessionWhereInput = {
      OR: [{ taskId: null }, { startsTaskWork: false }, { task: { projectId: null } },
        { task: { project: { status: { not: ProjectStatus.CANCELLED } } } }],
    };
    const AFTER: Prisma.SessionWhereInput = releaseWasFailureFilter();
    const queries = {
      sweep: {
        run: () => service.sweep(now),
        marker: /"retry_at" <= \$/,
        copy: (failed: Prisma.SessionWhereInput) => logged.session.findMany({
          where: {
            retryAt: { lte: now }, deletedAt: null, completedAt: null, sessionKind: 'CONVERSATION',
            OR: [{ ...turnStateFilter([null]), cancelRequestedAt: null }, failed],
            AND: [NOT_DISPATCH_HELD, NOT_IN_CANCELLED_PROJECT],
          },
          orderBy: { retryAt: 'asc' }, take: 50, select: { id: true },
        }),
        index: 'session_retry_at_idx',
      },
      releaseHeldRetries: {
        run: () => service.releaseHeldRetries(now),
        marker: /"retry_at" > \$/,
        copy: (failed: Prisma.SessionWhereInput) => logged.session.findMany({
          where: {
            retryAt: { gt: new Date(now.getTime() + ACCOUNT_RESET_WAIT_MS) }, deletedAt: null, completedAt: null,
            sessionKind: 'CONVERSATION',
            OR: [{ ...turnStateFilter([null]), cancelRequestedAt: null }, failed],
            AND: [NOT_DISPATCH_HELD, NOT_IN_CANCELLED_PROJECT],
          },
          orderBy: { retryAt: 'desc' }, take: 50, select: { id: true },
        }),
        index: 'session_retry_at_idx',
      },
      releaseExpiredClaims: {
        run: () => service.releaseExpiredClaims(now),
        marker: /"retry_claimed_at" <= \$/,
        copy: (failed: Prisma.SessionWhereInput) => logged.session.findMany({
          where: {
            retryClaimedAt: { lte: new Date(now.getTime() - RETRY_CLAIM_WINDOW_MS) }, retryAt: null, deletedAt: null,
            completedAt: null, sessionKind: 'CONVERSATION', OR: [turnStateFilter([null]), failed],
          },
          orderBy: { retryClaimedAt: 'asc' }, take: 50, select: { id: true },
        }),
        index: 'session_retry_claimed_at_idx',
      },
    };
    /** The statement that matches, from the first WHERE on: the where clause, the order and the limit. */
    const tail = (query: string) => query.slice(query.indexOf(' WHERE '));
    const take = async (run: () => Promise<unknown>, marker: RegExp) => {
      statements.length = 0;
      await run();
      const found = statements.filter((s) => / FROM "public"\."session"/.test(s.query) && marker.test(s.query));
      assert.equal(found.length, 1, `one statement matches ${marker}: ${JSON.stringify(statements.map((s) => s.query))}`);
      return found[0];
    };
    const captured: Record<string, { real: { query: string; params: string };
      after: { query: string; params: string } }> = {};
    for (const [name, q] of Object.entries(queries)) {
      // Before the table is filled: nothing is due, so the service reads and writes nothing else.
      const real = await take(q.run, q.marker);
      const after = await take(() => q.copy(AFTER), q.marker);
      assert.equal(tail(after.query), tail(real.query), `${name}: the copy after R4 is the query the service sends`);
      captured[name] = { real, after };
    }

    // A large session table: 200,000 rows, one in a hundred released by a failure, one in a hundred parked idle,
    // each of those with a retry armed (one in seven due, the rest an hour off) or a claim (one in eleven), and the
    // rest released for an end or the work, with nothing armed.
    const bulk = await world(db, 'bulk');
    await sql.query(`
      INSERT INTO "session" ("id", "owner_id", "creator_id", "workspace_id", "title", "prompt", "status", "provider",
                             "provider_builtin", "kind", "finished_at", "end_reason", "last_turn_outcome",
                             "retry_at", "retry_claimed_at", "cancel_requested_at", "created_at", "updated_at")
      SELECT gen_random_uuid(), $1::uuid, $1::uuid, $2::uuid, 'bulk', 'bulk',
             (CASE WHEN g % 100 = 0 THEN 'FAILED' WHEN g % 100 = 1 THEN 'AWAITING_INPUT'
                   WHEN g % 3 = 0 THEN 'SUCCEEDED' ELSE 'CANCELLED' END)::run_status,
             'claude', true, 'CONVERSATION',
             CASE WHEN g % 100 = 1 THEN NULL ELSE now() - make_interval(secs => g) END,
             CASE WHEN g % 100 IN (0, 1) THEN NULL WHEN g % 3 = 0 THEN 'task_done' ELSE 'ended' END,
             CASE WHEN g % 100 = 0 THEN 'FAILED' ELSE 'ANSWERED' END,
             CASE WHEN g % 100 IN (0, 1) AND g % 11 <> 0 THEN
                    CASE WHEN g % 7 = 0 THEN now() - interval '1 minute' ELSE now() + interval '1 hour' END END,
             CASE WHEN g % 100 IN (0, 1) AND g % 11 = 0 THEN now() - interval '1 hour' END,
             CASE WHEN g % 100 = 0 THEN now() END,
             now() - make_interval(secs => g), now()
        FROM generate_series(1, 200000) AS g`, [bulk.ownerId, bulk.workspaceId]);
    await sql.query(`ANALYZE "session"`);
    const count = (await sql.query(`SELECT count(*)::int AS n FROM "session"`)).rows[0] as { n: number };
    assert.ok(count.n >= 200_000, `the table holds ${count.n} sessions`);

    for (const [name, { after }] of Object.entries(captured)) {
      const plan = async (statement: { query: string; params: string }) => (await sql.query(
        `EXPLAIN ${statement.query}`, JSON.parse(statement.params) as unknown[],
      )).rows.map((row: { 'QUERY PLAN': string }) => row['QUERY PLAN']).join('\n');
      const planAfter = await plan(after);
      console.log(`# ${name}, after R4:\n${planAfter.replace(/^/gm, '#   ')}`);
      const index = queries[name as keyof typeof queries].index;
      assert.match(planAfter, new RegExp(`using ${index}`), `${name}: after, by ${index}`);
      assert.doesNotMatch(planAfter, /Seq Scan on session/, `${name}: after, no scan of the session table`);
    }
  });
});
