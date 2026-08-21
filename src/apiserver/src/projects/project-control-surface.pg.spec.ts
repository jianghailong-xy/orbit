import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Prisma } from '@prisma/client';
import type { Client, QueryResult } from 'pg';
import { ConflictException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from './coordinator-pg-test-safety';
import { ProjectAcceptanceService } from './project-acceptance.service';
import { ProjectsService } from './projects.service';
import {
  COORDINATOR_DISABLED_CODE,
  PROJECT_SETTLED_CODE,
  STALE_CONFIG_REVISION_CODE,
} from './project-coordinator-status';
import { prismaClientFor } from '../prisma/prisma-client';

/**
 * The unit-20 control/observability surface on real PostgreSQL, against a DISPOSABLE server.
 *
 * What only a database can decide, and what the unit specs therefore cannot:
 *
 *  - **The column names.** Every query behind `coordinatorStatus` is `$queryRaw`, where the row
 *    interface is the ONLY check — a column renamed in the schema and not in the SQL compiles,
 *    runs, and serves `undefined` under the old name. This runs them against the real tables.
 *  - **The event producer.** `project_event_manual_trigger` is a stored function with a fixed
 *    signature (migration 0117). A call that got its arguments wrong is a runtime error, not a
 *    type one, and the whole point of going through it is that nothing reimplements it.
 *  - **The compare-and-swap.** "Refused AND nothing written" is a property of the transaction the
 *    row lock is taken in. A fake `$transaction` that resolves whatever the callback returns proves
 *    the refusal and says nothing at all about the rollback.
 *
 * UNLIKE its siblings in this directory, this spec does NOT hand-build a schema subset: it expects
 * `prisma migrate deploy` to have been run against the target, because what it is checking is
 * agreement with the real schema and a hand-built subset would agree with itself. Give it its own
 * database.
 *
 *   docker run -d --name pcc20-status-pg16 -e POSTGRES_PASSWORD=pcc20_status \
 *     -e POSTGRES_USER=pcc20_status -e POSTGRES_DB=pcc20_status \
 *     -p 127.0.0.1:55620:5432 postgres:16
 *   DATABASE_URL=postgresql://pcc20_status:pcc20_status@127.0.0.1:55620/pcc20_status \
 *     npx prisma migrate deploy
 *   COORDINATOR_PG_URL=postgresql://pcc20_status:pcc20_status@127.0.0.1:55620/pcc20_status \
 *     COORDINATOR_PG_EXPECTED_DATABASE=pcc20_status COORDINATOR_PG_EXPECTED_USER=pcc20_status \
 *     COORDINATOR_PG_EXPECTED_SYSTEM_IDENTIFIER=$(psql -tAc \
 *       'SELECT system_identifier FROM pg_control_system()') \
 *     node --test --test-concurrency=1 build/projects/project-control-surface.pg.spec.js
 *
 * The server is proved disposable before the first write (`coordinator-pg-test-safety.ts`): a
 * copied production URL fails on the expected database, role and system identifier rather than on
 * a write that already happened.
 */

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

type ClientCtor = new (config: { connectionString?: string; connectionTimeoutMillis?: number }) => Client;
type Tx = Prisma.TransactionClient;

async function connect(): Promise<Client> {
  assertCoordinatorPgUrlIsIsolated(URL);
  const { Client: Ctor } = (await import('pg')) as unknown as { Client: ClientCtor };
  const client = new Ctor({ connectionString: URL, connectionTimeoutMillis: 2_000 });
  await client.connect();
  await verifyCoordinatorPgIdentity(client);
  return client;
}

function rows<T>(result: QueryResult): T[] {
  return result.rows as T[];
}

/**
 * Both spellings of a raw query, because the service uses both.
 *
 * `Prisma.sql\`…\`` arrives as one `Sql` object; the tagged form — `tx.$queryRaw\`…\`` — arrives as
 * a template strings array plus loose values. A harness that only understood the first reported
 * the second as "Client was passed a null or undefined query", which reads like a product fault
 * and is not one.
 */
function statement(query: unknown, values: unknown[]): { text: string; values: unknown[] } {
  const sql = query as Prisma.Sql;
  if (sql && typeof sql === 'object' && 'text' in sql) return { text: sql.text, values: sql.values };
  const strings = query as readonly string[];
  return {
    text: strings.map((part, i) => (i === 0 ? part : `$${i}${part}`)).join(''),
    values,
  };
}

const snake = (field: string) => field.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

/**
 * `tx.project.update({ where, data })` as SQL, because the write under test goes through the query
 * builder and the point of this spec is that it lands in the real table.
 *
 * Only the two shapes `ProjectsService.update` produces: a plain value, and the `{ increment: 1 }`
 * that bumps `config_revision` — which has to stay an increment rather than a read-then-write, so
 * that two writers cannot land on the same revision.
 */
function projectUpdate(client: Client) {
  return async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
    const assignments: string[] = [];
    const values: unknown[] = [where.id];
    for (const [field, value] of Object.entries(data)) {
      const column = `"${snake(field)}"`;
      if (value && typeof value === 'object' && 'increment' in (value as object)) {
        assignments.push(`${column} = ${column} + ${Number((value as { increment: number }).increment)}`);
        continue;
      }
      values.push(value);
      assignments.push(`${column} = $${values.length}`);
    }
    assignments.push('"updated_at" = now()');
    await client.query(
      `UPDATE "project" SET ${assignments.join(', ')} WHERE id = $1::uuid`, values);
    return { id: where.id, members: [], runtime: null };
  };
}

/** One pg connection dressed as the Prisma faces this service uses. */
function transactionClient(client: Client): Tx {
  return {
    $queryRaw: async (query: unknown, ...values: unknown[]) => {
      const { text, values: bound } = statement(query, values);
      return rows(await client.query(text, bound));
    },
    $executeRaw: async (query: unknown, ...values: unknown[]) => {
      const { text, values: bound } = statement(query, values);
      return (await client.query(text, bound)).rowCount ?? 0;
    },
    project: { update: projectUpdate(client) },
  } as unknown as Tx;
}

function prisma(client: Client): PrismaService {
  const direct = transactionClient(client);
  return {
    $queryRaw: direct.$queryRaw.bind(direct),
    $executeRaw: direct.$executeRaw.bind(direct),
    // Groupings and the blocker read go through the query builder in production; here they are the
    // same SQL against the same tables, which is what this spec is checking agreement with.
    task: {
      groupBy: async ({ where }: { where: { projectId: string } }) => rows<{
        status: string; count: number;
      }>(await client.query(
        `SELECT "status"::text AS status, count(*)::int AS count FROM "task"
          WHERE "project_id" = $1::uuid GROUP BY 1`, [where.projectId],
      )).map((row) => ({ status: row.status, _count: { _all: row.count } })),
    },
    // §13.7's merge receipts, the same way: the production read is a query-builder call, and here
    // it is the same SQL against the same table — which is exactly the agreement this spec checks.
    sessionMergeReceipt: {
      findMany: async ({ where, take }: { where: { projectId: string; ownerId: string }; take: number }) =>
        rows(await client.query(
          `SELECT "id", "session_id" AS "sessionId", "task_id" AS "taskId",
                  "project_id" AS "projectId", "result",
                  "source_branch" AS "sourceBranch", "source_sha" AS "sourceSha",
                  "target_branch" AS "targetBranch",
                  "target_sha_before" AS "targetShaBefore", "target_sha_after" AS "targetShaAfter",
                  "rebase_base_sha" AS "rebaseBaseSha", "conflicts",
                  "recorded_by" AS "recordedBy", "detail",
                  "idempotency_key" AS "idempotencyKey", "created_at" AS "createdAt"
             FROM "session_merge_receipt"
            WHERE "project_id" = $1::uuid AND "owner_id" = $2::uuid
            ORDER BY "created_at" DESC, "id" DESC
            LIMIT $3`,
          [where.projectId, where.ownerId, take],
        )),
    },
    project: {
      findFirst: async ({ where }: { where: { id: string; ownerId: string } }) => {
        const found = rows(await client.query(
          `SELECT id FROM "project" WHERE id = $1::uuid AND owner_id = $2::uuid`,
          [where.id, where.ownerId],
        ));
        return found[0] ?? null;
      },
    },
    $transaction: async <T>(fn: (tx: Tx) => Promise<T>) => {
      await client.query('BEGIN');
      try {
        const result = await fn(transactionClient(client));
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    },
  } as unknown as PrismaService;
}

interface Fixture {
  client: Client;
  service: ProjectsService;
  /**
   * A REAL Prisma client, for the one collaborator that cannot be dressed up.
   *
   * The hand-rolled object above exists because this spec is about raw SQL agreeing with the real
   * schema — every query behind `coordinatorStatus` is `$queryRaw`, and a fake that answered them
   * from itself would prove nothing. `ProjectAcceptanceService` is the opposite case: unit 25A
   * put it inside `coordinatorStatus`, and it reads `project_acceptance_run` through the QUERY
   * BUILDER, with an `include`. Faking that face would be reimplementing Prisma, and a fake that
   * merely returns null would make this spec assert an acceptance summary nobody computed.
   */
  acceptancePrisma: { $disconnect(): Promise<void> };
  acceptance: ProjectAcceptanceService;
  owner: string;
  other: string;
  project: string;
}

/**
 * Every real client a fixture has opened, so the `finally` that closes the pg connection closes
 * these too. A test that ends with one of them still connected is a process that never exits —
 * which is a hang, reported as a timeout, ten minutes after the assertions all passed.
 */
const openPrismaClients: Array<{ $disconnect(): Promise<void> }> = [];

async function releaseFixtures(): Promise<void> {
  while (openPrismaClients.length) {
    await openPrismaClients.pop()!.$disconnect().catch(() => {});
  }
}

/** A fresh owner and project per test, so nothing here depends on what ran before it. */
async function fixture(client: Client): Promise<Fixture> {
  const owner = randomUUID();
  const other = randomUUID();
  const project = randomUUID();
  await client.query(
    `INSERT INTO "user" (id, email, password_hash, name)
     VALUES ($1::uuid, $2, 'x', 'owner'), ($3::uuid, $4, 'x', 'other')`,
    [owner, `${owner}@pcc20.test`, other, `${other}@pcc20.test`],
  );
  await client.query(
    `INSERT INTO "project" (id, owner_id, title, acceptance_criteria, coordinator_enabled,
       automation_policy, config_revision, updated_at)
     VALUES ($1::uuid, $2::uuid, 'control surface', 'all merged', true, 'GUARDED_AUTO', 0, now())`,
    [project, owner],
  );
  const acceptancePrisma = prismaClientFor(URL!) as {
    $disconnect(): Promise<void>;
  };
  openPrismaClients.push(acceptancePrisma);
  const acceptance = new ProjectAcceptanceService(acceptancePrisma as never);
  return {
    client,
    service: new ProjectsService(prisma(client) as never, {} as never, acceptance),
    acceptancePrisma,
    acceptance,
    owner,
    other,
    project,
  };
}

/**
 * Earn this project a DONE the way §13.4 says one is earned, so a test that needs a SETTLED
 * project has a real acceptance behind it.
 *
 * Not a shortcut around `project_acceptance_done_gate` — the opposite. The gate is what this walks
 * through: a run of this project, every stated criterion answered, a verdict DERIVED as PASS, and
 * `status` and `accepted_run_id` written in ONE statement, which is BD1. Before 25A this test only
 * had to write the column; the gate is now the reason it cannot, and satisfying it is cheaper than
 * a fixture that quietly turns it off.
 */
async function settleWithRealAcceptance(f: Fixture): Promise<string> {
  const run = await f.acceptance.openRun(f.owner, f.project, { decidedBy: 'COORDINATOR_AGENT' });
  const concluded = await f.acceptance.finalizeRun(
    f.owner,
    f.project,
    run.id,
    run.criteria.map((criterion: { ordinal: number }) => ({
      ordinal: criterion.ordinal,
      verdict: 'PASS' as never,
      summary: 'checked by the control-surface fixture',
    })),
  );
  assert.equal(concluded.verdict, 'PASS', 'the run has to actually conclude PASS to open the gate');
  await f.client.query(
    `UPDATE "project" SET "status" = 'DONE', "accepted_run_id" = $2::uuid WHERE id = $1::uuid`,
    [f.project, concluded.id],
  );
  return concluded.id;
}

function code(error: unknown): unknown {
  assert.ok(error instanceof ConflictException, `expected a 409, got ${error}`);
  return (error.getResponse() as { code?: unknown }).code;
}

async function manualTriggerCount(f: Fixture): Promise<number> {
  const [row] = rows<{ count: number }>(await f.client.query(
    `SELECT count(*)::int AS count FROM "project_event"
      WHERE project_id = $1::uuid AND kind = 'user.manual_trigger'`, [f.project],
  ));
  return row.count;
}

test('the status read agrees with the real schema, column for column', { skip }, async () => {
  const client = await connect();
  try {
    const f = await fixture(client);
    const status = await f.service.coordinatorStatus(f.owner, f.project) as Record<string, any>;
    assert.equal(status.project.status, 'OPEN');
    // `project_runtime` is created by the AFTER INSERT trigger on `project` (migrations 0112/0113),
    // so a project nobody has touched still joins one — and reads as "nothing has happened yet"
    // rather than as an error.
    assert.equal(status.runtime.runState, 'PLANNING');
    assert.equal(status.runtime.fencingToken, '0');
    assert.equal(status.runtime.leaseAbsentReason, 'NOT_LEASED');
    assert.equal(status.policy.configRevision, '0');
    assert.equal(status.policy.automationPolicy, 'GUARDED_AUTO');
    assert.equal(status.coordination.agentIdAbsentReason, 'NO_COORDINATOR_AGENT');
    assert.equal(status.coordination.sessionIdAbsentReason, 'COORDINATOR_NEVER_OPENED');
    assert.equal(status.decisionsEmptyReason, 'NO_DECISION_YET');
    assert.equal(status.pendingActionsEmptyReason, 'NO_PENDING_ACTION');
    assert.equal(status.blockers.openEmptyReason, 'NO_OPEN_BLOCKER');
    assert.equal(status.acceptance.criteria, 'all merged');
    assert.equal(status.acceptance.lastRunAbsentReason, 'ACCEPTANCE_NOT_ATTEMPTED');
    assert.equal(status.acceptance.evidence.mergesEmptyReason, 'NO_MERGE_EVIDENCE');
    // Not `undefined`: a column this query names wrongly comes back missing, not as an error, so
    // the aggregates are asserted as numbers rather than merely read.
    assert.equal(typeof status.consumption.tasksInFlight, 'number');
    assert.equal(typeof status.acceptance.evidence.verifications.unresolvedFailures, 'number');
  } finally {
    await releaseFixtures();
    await client.end();
  }
});

test('another account’s project is a 404 from the query, not from a check after it', { skip }, async () => {
  const client = await connect();
  try {
    const f = await fixture(client);
    await assert.rejects(f.service.coordinatorStatus(f.other, f.project), /project not found/);
  } finally {
    await releaseFixtures();
    await client.end();
  }
});

test('the manual trigger goes through the stored producer, and the same id twice is one row', { skip }, async () => {
  const client = await connect();
  try {
    const f = await fixture(client);
    const triggerId = randomUUID();
    const first = await f.service.triggerCoordinator(f.owner, f.project, { triggerId });
    assert.equal(first.accepted, true);
    assert.equal(first.deduplicated, false);
    const again = await f.service.triggerCoordinator(f.owner, f.project, { triggerId });
    // The outbox's partial unique index over unconsumed rows is what makes a double-click one run,
    // and `occurrences` is how the endpoint can say "already queued" instead of queueing a second.
    assert.equal(again.deduplicated, true);
    assert.equal(again.occurrences, 2);
    assert.equal(await manualTriggerCount(f), 1);

    const status = await f.service.coordinatorStatus(f.owner, f.project) as Record<string, any>;
    const manual = status.events.pending.find((e: { kind: string }) => e.kind === 'user.manual_trigger');
    assert.ok(manual, 'the committed signal must be visible in the read');
    // The id inside the key string, publicized by the service — the response interceptor rewrites
    // id FIELDS and cannot see into a string, so this is the only place that leak closes.
    assert.doesNotMatch(manual.dedupeKey, /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-/);
  } finally {
    await releaseFixtures();
    await client.end();
  }
});

test('a stale write is refused and nothing is written — the rollback, not just the throw', { skip }, async () => {
  const client = await connect();
  try {
    const f = await fixture(client);
    assert.equal(
      code(await f.service
        .update(f.owner, f.project, { maxConcurrentTasks: 9, expectedConfigRevision: '99' })
        .then(() => null, (e) => e)),
      STALE_CONFIG_REVISION_CODE,
    );
    let [row] = rows<{ max_concurrent_tasks: number; config_revision: string }>(await client.query(
      `SELECT max_concurrent_tasks, config_revision FROM "project" WHERE id = $1::uuid`, [f.project],
    ));
    assert.equal(row.max_concurrent_tasks, 3, 'a refused write must have written nothing');
    assert.equal(String(row.config_revision), '0');

    // The matching fence commits and bumps the revision, which is what makes the value somebody
    // read a moment ago stale from now on.
    await f.service.update(f.owner, f.project, { maxConcurrentTasks: 9, expectedConfigRevision: '0' });
    [row] = rows<{ max_concurrent_tasks: number; config_revision: string }>(await client.query(
      `SELECT max_concurrent_tasks, config_revision FROM "project" WHERE id = $1::uuid`, [f.project],
    ));
    assert.equal(row.max_concurrent_tasks, 9);
    assert.equal(String(row.config_revision), '1');
    assert.equal(
      code(await f.service
        .update(f.owner, f.project, { maxConcurrentTasks: 4, expectedConfigRevision: '0' })
        .then(() => null, (e) => e)),
      STALE_CONFIG_REVISION_CODE,
    );

    // And the same fence on the trigger, which must refuse BEFORE the signal is enqueued.
    assert.equal(
      code(await f.service
        .triggerCoordinator(f.owner, f.project, { expectedConfigRevision: '0' })
        .then(() => null, (e) => e)),
      STALE_CONFIG_REVISION_CODE,
    );
    assert.equal(await manualTriggerCount(f), 0);
  } finally {
    await releaseFixtures();
    await client.end();
  }
});

test('a switched-off or settled project enqueues nothing at all', { skip }, async () => {
  const client = await connect();
  try {
    const f = await fixture(client);
    await client.query(
      `UPDATE "project" SET coordinator_enabled = false WHERE id = $1::uuid`, [f.project]);
    assert.equal(
      code(await f.service.triggerCoordinator(f.owner, f.project).then(() => null, (e) => e)),
      COORDINATOR_DISABLED_CODE,
    );
    await client.query(
      `UPDATE "project" SET coordinator_enabled = true WHERE id = $1::uuid`, [f.project]);
    await settleWithRealAcceptance(f);
    assert.equal(
      code(await f.service.triggerCoordinator(f.owner, f.project).then(() => null, (e) => e)),
      PROJECT_SETTLED_CODE,
    );
    // §5.5: a project out of the loop discards its events, so accepting one would be a request
    // that silently never happens.
    assert.equal(await manualTriggerCount(f), 0);
  } finally {
    await releaseFixtures();
    await client.end();
  }
});
