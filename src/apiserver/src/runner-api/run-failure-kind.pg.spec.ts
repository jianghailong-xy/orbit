/**
 * A FAILED RUN'S FAILURE KIND IS ON THE SESSION, WRITTEN WITH ITS ERROR AND CLEARED WITH IT.
 *
 * docs/routing-account-health-design.md §5.1, §5.4, §10 (migration 1493: session.failure_kind, failure_scope,
 * failure_said, admission_failure). Each case posts a real turn-complete or finalize through the controller, or the
 * owner's revive through SessionsService, on a database the real migrations built, and reads the row back over a
 * second connection:
 *
 *   (0) migration 1493 is applied: the four columns exist, nullable, with no default
 *   (1) a new runner's FAILED turn-complete      → the kind, scope, words and admission beside the error
 *   (2) an old runner's FAILED turn-complete     → the error, and all four columns NULL
 *   (3) a new runner's FAILED finalize           → written; the owner's revive clears all four with the error
 *   (4) an old runner's FAILED finalize          → all four NULL; a kind this server does not know is stored as none
 *   (5) the budget filters on PostgreSQL        → the runner's kind first, the markers only when it is NULL, and a run
 *                                                  with no kind and no error kept by the negated filter
 *
 *     bash scripts/run-pg-spec.sh src/apiserver/src/runner-api/run-failure-kind.pg.spec.ts
 *
 * Not destructive: every id is freshly generated and every assertion reads only the rows it made.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { Prisma, PrismaClient, RunnerStatus, SessionDispatchOrigin, SessionRunSource } from '@prisma/client';
import { RunStatus } from '@orbit/shared';
import { RunFailureKind, RunStatus as SharedRunStatus } from '@orbit/shared';
import { Client } from 'pg';

import { failureKindIs, failureKindIsNot, failureKindIsSql } from '../common/run-failure-kind-filter';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import { QueueService } from '../queue/queue.service';
import type { RealtimeService } from '../realtime/realtime.service';
import { SessionsService } from '../sessions/sessions.service';
import { RunnerApiController } from './runner-api.controller';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

const PAYMENT = 'Cursor said: "Add a payment method to continue." The Cursor account needs this before the session can go on.';
const QUOTA = "You've hit your session limit · resets 6:20pm (Europe/Berlin)";

interface Stack {
  db: PrismaClient;
  api: RunnerApiController;
  sessions: SessionsService;
}

function stackFor(url: string): Stack {
  const db = prismaClientFor(url);
  const prisma = db as unknown as PrismaService;
  const realtime = new Proxy({}, { get: () => () => undefined }) as unknown as RealtimeService;
  const queue = new QueueService(prisma, realtime);
  const sessions = new SessionsService(prisma, queue, realtime);
  return {
    db,
    sessions,
    api: new RunnerApiController(
      prisma,
      queue,
      realtime,
      new Proxy({}, { get: () => async () => undefined }) as never,
      { assert: async (_runner: unknown, callingSessionId?: string) => callingSessionId ?? randomUUID() } as never,
      { expand: async (_ownerId: string, content?: string) => content } as never,
      { appendFor: async (_tx: unknown, _sessionId: string, content?: string) => content } as never,
      undefined,
      undefined,
      undefined,
      undefined,
      sessions,
    ),
  };
}

interface World {
  ownerId: string;
  runnerId: string;
  workspaceId: string;
}

async function world(db: PrismaClient, label: string): Promise<World> {
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  await db.user.create({
    data: { id: ownerId, email: `${label}-${ownerId}@failure-kind.invalid`, name: label, passwordHash: 'x' },
  });
  await db.runner.create({
    data: {
      id: runnerId,
      ownerId,
      name: `${label}-runner`,
      tokenHash: `hash-${runnerId}`,
      status: RunnerStatus.ONLINE,
      capabilities: [],
      capabilitiesReportedAt: new Date(),
      lastHeartbeatAt: new Date(),
    },
  });
  await db.workspace.create({
    data: { id: workspaceId, ownerId, runnerId, name: `${label}-workspace`, enabled: true, workDir: `/srv/${label}` },
  });
  return { ownerId, runnerId, workspaceId };
}

/** A conversation running on the world's runner, with one message turn out on delivery. */
async function runningSession(db: PrismaClient, w: World, data: Record<string, unknown> = {}): Promise<{ id: string; turnId: string }> {
  const id = randomUUID();
  await db.session.create({
    data: {
      id,
      ownerId: w.ownerId,
      creatorId: w.ownerId,
      workspaceId: w.workspaceId,
      assignedRunnerId: w.runnerId,
      title: 'a conversation',
      prompt: 'Explain the error in the log',
      turnState: 'IN_FLIGHT',
      engineTurnActive: true,
      provider: 'cursor',
      providerBuiltin: true,
      engine: 'cursor',
      dispatchOrigin: SessionDispatchOrigin.USER,
      runSource: SessionRunSource.MANUAL,
      startedAt: new Date(),
      runtimeSessionId: randomUUID(),
      ...data,
    },
  });
  const turn = await db.conversationTurn.create({
    data: {
      sessionId: id,
      seq: 1,
      clientTurnId: `turn-1-${randomUUID()}`,
      kind: 'message',
      content: 'Explain the error in the log',
      status: 'IN_FLIGHT',
      deliveredAt: new Date(),
      leaseDeadlineAt: new Date(Date.now() + 300_000),
      leaseGeneration: randomUUID(),
    },
    select: { id: true },
  });
  return { id, turnId: turn.id };
}

interface FailureRow {
  status: string;
  error: string | null;
  failure_kind: string | null;
  failure_scope: string | null;
  failure_said: string | null;
  admission_failure: boolean | null;
}

async function failureRow(sql: Client, id: string): Promise<FailureRow> {
  const row = (await sql.query(
    `SELECT status::text AS status, error, failure_kind, failure_scope, failure_said, admission_failure
       FROM "session" WHERE id = $1::uuid`,
    [id],
  )).rows[0] as FailureRow;
  console.log(`# ${JSON.stringify(row)}`);
  return row;
}

test('a failed run stores its failure kind with its error, and a revive clears both', {
  skip, concurrency: 1, timeout: 300_000,
}, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const s = stackFor(url);
  t.after(async () => {
    await s.db.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });

  await t.test('(0) migration 1493 is applied: four nullable columns with no default', async () => {
    const applied = (await sql.query(
      `SELECT count(*)::int AS n FROM _prisma_migrations
        WHERE migration_name = '1493_session_failure_kind' AND finished_at IS NOT NULL AND rolled_back_at IS NULL`,
    )).rows[0] as { n: number };
    assert.equal(applied.n, 1, 'prisma recorded 1493 applied');
    const columns = (await sql.query(
      `SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns
        WHERE table_name = 'session'
          AND column_name IN ('failure_kind', 'failure_scope', 'failure_said', 'admission_failure')
        ORDER BY column_name`,
    )).rows as Array<{ column_name: string; data_type: string; is_nullable: string; column_default: string | null }>;
    console.log(`# ${JSON.stringify(columns)}`);
    assert.deepEqual(columns.map((c) => [c.column_name, c.data_type, c.is_nullable, c.column_default]), [
      ['admission_failure', 'boolean', 'YES', null],
      ['failure_kind', 'text', 'YES', null],
      ['failure_said', 'text', 'YES', null],
      ['failure_scope', 'text', 'YES', null],
    ]);
  });

  await t.test("(1) a new runner's failed turn: the kind, scope, words and admission beside the error", async () => {
    const w = await world(s.db, 'turn-new');
    const run = await runningSession(s.db, w);
    await s.api.turnComplete({ id: w.runnerId }, run.id, {
      turnId: run.turnId,
      status: SharedRunStatus.FAILED,
      subtype: 'error',
      error: PAYMENT,
      failure: { kind: RunFailureKind.ACCOUNT_ACTION_REQUIRED, said: 'Add a payment method to continue' },
      admission: true,
      numTurns: 1,
      costUsd: 0,
    });
    const row = await failureRow(sql, run.id);
    assert.equal(row.status, 'FAILED');
    assert.equal(row.error, PAYMENT);
    assert.equal(row.failure_kind, 'ACCOUNT_ACTION_REQUIRED');
    assert.equal(row.failure_scope, null, 'no scope is the whole account');
    assert.equal(row.failure_said, 'Add a payment method to continue');
    assert.equal(row.admission_failure, true);
  });

  await t.test("(2) an old runner's failed turn: the error, and nothing classified", async () => {
    const w = await world(s.db, 'turn-old');
    const run = await runningSession(s.db, w);
    await s.api.turnComplete({ id: w.runnerId }, run.id, {
      turnId: run.turnId, status: SharedRunStatus.FAILED, subtype: 'error', error: PAYMENT, numTurns: 1, costUsd: 0,
    });
    const row = await failureRow(sql, run.id);
    assert.equal(row.status, 'FAILED');
    assert.equal(row.error, PAYMENT);
    assert.deepEqual([row.failure_kind, row.failure_scope, row.failure_said, row.admission_failure], [null, null, null, null]);
  });

  await t.test("(3) a new runner's failed finalize is written, and the owner's revive clears it with the error", async () => {
    const w = await world(s.db, 'finalize-new');
    const run = await runningSession(s.db, w, { provider: 'codex', engine: 'codex' });
    await s.api.finalize({ id: w.runnerId }, run.id, {
      status: SharedRunStatus.FAILED,
      error: 'Selected model is at capacity. Please try a different model.',
      failure: { kind: RunFailureKind.CAPACITY, scope: 'model', said: 'Selected model is at capacity' },
      admission: false,
    } as never);
    const failed = await failureRow(sql, run.id);
    assert.equal(failed.status, 'FAILED');
    assert.deepEqual([failed.failure_kind, failed.failure_scope, failed.failure_said, failed.admission_failure],
      ['CAPACITY', 'model', 'Selected model is at capacity', false]);

    await s.sessions.resume(w.ownerId, run.id, { clientTurnId: `revive-${randomUUID()}`, content: 'Try again' });
    const revived = await failureRow(sql, run.id);
    assert.equal(revived.status, 'PENDING', 'revived');
    assert.equal(revived.error, null, 'the error goes');
    assert.deepEqual([revived.failure_kind, revived.failure_scope, revived.failure_said, revived.admission_failure],
      [null, null, null, null], 'and its classification with it');
  });

  await t.test("(4) an old runner's failed finalize: nothing classified; an unknown kind is stored as none", async () => {
    const w = await world(s.db, 'finalize-old');
    const old = await runningSession(s.db, w);
    await s.api.finalize({ id: w.runnerId }, old.id, { status: SharedRunStatus.FAILED, error: QUOTA } as never);
    const oldRow = await failureRow(sql, old.id);
    assert.equal(oldRow.error, QUOTA);
    assert.deepEqual([oldRow.failure_kind, oldRow.admission_failure], [null, null]);

    const newer = await runningSession(s.db, w);
    await s.api.finalize({ id: w.runnerId }, newer.id, {
      status: SharedRunStatus.FAILED, error: QUOTA, failure: { kind: 'A_NEWER_KIND' }, admission: true,
    } as never);
    const newerRow = await failureRow(sql, newer.id);
    assert.deepEqual([newerRow.failure_kind, newerRow.admission_failure], [null, true]);
  });

  await t.test('(5) the budget filters read the kind first and the markers only when it is NULL', async () => {
    const w = await world(s.db, 'filters');
    const rows = [
      { name: 'kind USAGE_LIMIT, no marker', failureKind: 'USAGE_LIMIT', error: 'Kimi Code failed this turn' },
      { name: 'no kind, a marker', failureKind: null, error: QUOTA },
      { name: 'no kind, a marker past the opening', failureKind: null, error: `Nothing answered this message.\n\n${QUOTA}` },
      { name: 'no kind, no error', failureKind: null, error: null },
      { name: 'kind REQUEST_REFUSED, a marker', failureKind: 'REQUEST_REFUSED', error: QUOTA },
      { name: 'no kind, at capacity', failureKind: null, error: 'Selected model is at capacity.' },
    ];
    const ids = new Map<string, string>();
    for (const row of rows) {
      const id = randomUUID();
      ids.set(id, row.name);
      await s.db.session.create({
        data: {
          id, ownerId: w.ownerId, creatorId: w.ownerId, workspaceId: w.workspaceId, title: row.name, prompt: 'x',
          turnState: null, finishedAt: new Date(), error: row.error, failureKind: row.failureKind,
          dispatchOrigin: SessionDispatchOrigin.USER,
        },
      });
    }
    const named = async (where: Prisma.SessionWhereInput) =>
      (await s.db.session.findMany({ where: { AND: [{ id: { in: [...ids.keys()] } }, where] }, select: { id: true } }))
        .map((r) => ids.get(r.id)!).sort();

    assert.deepEqual(await named(failureKindIs([RunFailureKind.USAGE_LIMIT])), [
      'kind USAGE_LIMIT, no marker', 'no kind, a marker', 'no kind, a marker past the opening',
    ]);
    assert.deepEqual(await named(failureKindIsNot([RunFailureKind.USAGE_LIMIT])), [
      'kind REQUEST_REFUSED, a marker', 'no kind, at capacity', 'no kind, no error',
    ], 'the negated filter keeps the run with no kind and no error');

    const raw = (await s.db.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT s.id::text AS id FROM "session" s
       WHERE s.id IN (${Prisma.join([...ids.keys()].map((id) => Prisma.sql`${id}::uuid`))})
         AND ${failureKindIsSql('s', [RunFailureKind.USAGE_LIMIT, RunFailureKind.CAPACITY])}`))
      .map((r) => ids.get(r.id)!).sort();
    assert.deepEqual(raw, [
      'kind USAGE_LIMIT, no marker', 'no kind, a marker', 'no kind, a marker past the opening', 'no kind, at capacity',
    ]);
  });
});
