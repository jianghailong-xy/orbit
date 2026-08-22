import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { Prisma } from '@prisma/client';
import { base62ToUuid } from '@orbit/shared';
import type { Client, QueryResult } from 'pg';
import { PrismaService } from '../prisma/prisma.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from './coordinator-pg-test-safety';
import { ZERO_COUNTERS } from './convergence-contract';
import { EMPTY_PROGRESS_VECTOR, ProgressVector, scopeHash } from './convergence-progress';
import { ConvergenceObservation } from './convergence-ledger';
import { ConvergenceLedgerService } from './convergence-ledger.service';

// `[K2]`'s ledger on real PostgreSQL, against a DISPOSABLE server.
//
// Everything asserted here is a property of the DATABASE and not of the planner: the unique key
// that makes a redelivered event one row, the composite foreign key that stops a superseded attempt
// from naming a scope it is not on, the trigger that refuses a counter walking downward, the freeze
// that refuses an unsigned scope edit. A unit test can only show that the service INTENDS those.
// The index and the triggers are what still hold when the next writer forgets — and the incident
// this contract was frozen after was written by a writer that forgot.
//
// The server is disposable and proved so before the first write (`coordinator-pg-test-safety.ts`):
// a copied production URL fails on the explicit expected database, role and system identifier
// rather than on a `DROP SCHEMA` that already ran.

const URL = process.env.COORDINATOR_PG_URL;
const SCHEMA = 'pcck2_ledger';
const skip = !URL;

const OWNER = '00000000-0000-7000-8000-000000002001';
const OTHER_OWNER = '00000000-0000-7000-8000-000000002002';
const PROJECT = '00000000-0000-7000-8000-000000002003';
const AUTO_PROJECT = '00000000-0000-7000-8000-000000002004';
const TASK = '00000000-0000-7000-8000-000000002005';
const AUTO_TASK = '00000000-0000-7000-8000-000000002006';
const LEGACY_TASK = '00000000-0000-7000-8000-000000002007';
const SESSION = '00000000-0000-7000-8000-000000002008';

const LEDGER = migration('0132_task_convergence_ledger');

const SCOPE = scopeHash({ title: 'T', description: null, acceptanceCriteria: 'AC' });
const AT = new Date('2026-08-22T10:00:00.000Z');

type ClientCtor = new (config: { connectionString?: string; connectionTimeoutMillis?: number }) => Client;
type Tx = Prisma.TransactionClient;

function migration(name: string): string {
  return readFileSync(path.resolve(__dirname, `../../prisma/migrations/${name}/migration.sql`), 'utf8');
}

async function connect(): Promise<Client> {
  assertCoordinatorPgUrlIsIsolated(URL);
  const { Client: Ctor } = (await import('pg')) as unknown as { Client: ClientCtor };
  const client = new Ctor({ connectionString: URL, connectionTimeoutMillis: 2_000 });
  await client.connect();
  await verifyCoordinatorPgIdentity(client);
  await client.query(`SET search_path TO ${SCHEMA}`);
  return client;
}

function rows<T>(result: QueryResult): T[] {
  return result.rows as T[];
}

function transactionClient(client: Client): Tx {
  return {
    $queryRaw: async (query: Prisma.Sql) => rows(await client.query(query.text, query.values)),
    $executeRaw: async (query: Prisma.Sql) =>
      (await client.query(query.text, query.values)).rowCount ?? 0,
  } as unknown as Tx;
}

function prisma(client: Client): PrismaService {
  const direct = transactionClient(client);
  return {
    $queryRaw: direct.$queryRaw.bind(direct),
    $executeRaw: direct.$executeRaw.bind(direct),
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

/** Run `fn` inside a transaction the caller can abort, which is how a crash is simulated. */
async function inTransaction<T>(client: Client, fn: (tx: Tx) => Promise<T>): Promise<T> {
  await client.query('BEGIN');
  try {
    const result = await fn(transactionClient(client));
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

async function reset(client: Client): Promise<void> {
  await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await client.query(`CREATE SCHEMA ${SCHEMA}`);
  await client.query(`SET search_path TO ${SCHEMA}`);
  // The subset of the real schema this migration touches, built by hand exactly as the other
  // coordinator pg specs do — the point is to exercise 0132's own SQL, not to replay 131 migrations.
  await client.query(`
    CREATE TYPE "project_status" AS ENUM ('OPEN', 'DONE', 'CANCELLED');
    CREATE TYPE "project_automation_policy" AS ENUM ('MANUAL', 'GUARDED_AUTO', 'AUTO');
    CREATE TYPE "task_status" AS ENUM ('OPEN', 'IN_PROGRESS', 'DONE', 'CANCELLED', 'FAILED');
    CREATE TABLE "project" (
      "id" UUID PRIMARY KEY,
      "owner_id" UUID NOT NULL,
      "title" TEXT NOT NULL,
      "status" "project_status" NOT NULL DEFAULT 'OPEN',
      "automation_policy" "project_automation_policy" NOT NULL DEFAULT 'GUARDED_AUTO',
      "config_revision" BIGINT NOT NULL DEFAULT 0
    );
    CREATE TABLE "task" (
      "id" UUID PRIMARY KEY,
      "owner_id" UUID NOT NULL,
      "project_id" UUID REFERENCES "project"("id"),
      "title" TEXT NOT NULL,
      "description" TEXT,
      "acceptance_criteria" TEXT,
      "status" "task_status" NOT NULL DEFAULT 'OPEN',
      "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  await client.query(LEDGER);
  await client.query(`
    INSERT INTO "project" ("id", "owner_id", "title") VALUES ('${PROJECT}', '${OWNER}', 'P');
    INSERT INTO "project" ("id", "owner_id", "title", "automation_policy")
      VALUES ('${AUTO_PROJECT}', '${OWNER}', 'P-auto', 'AUTO');
    INSERT INTO "task" ("id", "owner_id", "project_id", "title", "acceptance_criteria")
      VALUES ('${TASK}', '${OWNER}', '${PROJECT}', 'T', 'AC');
    INSERT INTO "task" ("id", "owner_id", "project_id", "title", "acceptance_criteria")
      VALUES ('${AUTO_TASK}', '${OWNER}', '${AUTO_PROJECT}', 'T', 'AC');
    INSERT INTO "task" ("id", "owner_id", "project_id", "title", "acceptance_criteria", "status")
      VALUES ('${LEGACY_TASK}', '${OWNER}', '${PROJECT}', 'Legacy', 'AC', 'IN_PROGRESS');
  `);
}

function vector(over: Partial<ProgressVector> = {}): ProgressVector {
  return { ...EMPTY_PROGRESS_VECTOR, scopeHash: SCOPE, acceptanceTotal: 4, ...over };
}

function observation(over: Partial<ConvergenceObservation> = {}): ConvergenceObservation {
  return {
    observationKey: 'session:one:failed',
    event: 'ATTEMPT_FAILED_IN_SCOPE',
    classification: 'IN_SCOPE_DEFECT',
    failure: {
      stage: 'RUN',
      subjectKind: 'TASK',
      scopeHash: SCOPE,
      violatedInvariant: 'TEST_RED',
      message: 'expected 3 got 4',
    },
    progressVector: vector(),
    observedAt: AT,
    decidedBy: 'ORCHESTRATOR',
    action: null,
    sessionId: SESSION,
    ...over,
  };
}

interface TaskRow {
  scope_revision: number;
  attempt_generation: string;
  progress_state: string;
  convergence_counters: Record<string, number>;
  last_progress_at: Date | null;
  known_good_sha: string | null;
  title: string;
  acceptance_criteria: string | null;
}

async function task(client: Client, id = TASK): Promise<TaskRow> {
  const result = await client.query(`SELECT * FROM "task" WHERE "id" = $1`, [id]);
  return rows<TaskRow>(result)[0];
}

async function ledgerCount(client: Client, id = TASK): Promise<number> {
  const result = await client.query(
    `SELECT count(*)::int AS n FROM "task_convergence_decision" WHERE "task_id" = $1`, [id]);
  return rows<{ n: number }>(result)[0].n;
}

async function refused(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (error) {
    return (error as Error).message;
  }
  assert.fail('expected the write to be refused');
}

// -------------------------------------------------------------------------------------------
// AC5 — the migration itself.
// -------------------------------------------------------------------------------------------

test('AC5: the migration applies to a fresh database and changes no existing task', { skip }, async () => {
  const client = await connect();
  try {
    await reset(client);
    // Every column arrives with the value the row already behaved as, and no existing task is
    // managed — which is the whole of project AC11's compatibility promise.
    const legacy = await task(client, LEGACY_TASK);
    assert.equal(legacy.scope_revision, 1);
    assert.equal(legacy.attempt_generation, '0');
    assert.equal(legacy.progress_state, 'CONVERGING');
    assert.deepEqual(legacy.convergence_counters, ZERO_COUNTERS);

    const managed = await client.query(`SELECT count(*)::int AS n FROM "task_scope_revision"`);
    assert.equal(rows<{ n: number }>(managed)[0].n, 0, 'nothing is under management yet');

    // And an unmanaged running task's scope is still editable, exactly as it was yesterday.
    await client.query(`UPDATE "task" SET "acceptance_criteria" = 'AC edited' WHERE "id" = $1`,
      [LEGACY_TASK]);
    assert.equal((await task(client, LEGACY_TASK)).acceptance_criteria, 'AC edited');
  } finally {
    await client.end();
  }
});

// -------------------------------------------------------------------------------------------
// AC1 — one logical decision and one logical action per fact.
// -------------------------------------------------------------------------------------------

test('AC1: a redelivered event writes one row and moves no counter', { skip }, async () => {
  const client = await connect();
  try {
    await reset(client);
    const service = new ConvergenceLedgerService(prisma(client));

    const first = await inTransaction(client, async (tx) => {
      await service.ensureBaseline(tx, TASK, OWNER);
      return service.record(tx, TASK, OWNER, observation());
    });
    assert.equal(first.duplicate, false);
    const afterFirst = await task(client);
    assert.equal(afterFirst.convergence_counters.attemptsWithoutProgress, 1);

    // The same fact, delivered twice more. The reader's world has moved between them, which is
    // exactly why the key cannot be derived from it.
    for (const attempt of [2, 3]) {
      const again = await inTransaction(client, (tx) => service.record(tx, TASK, OWNER, observation()));
      assert.equal(again.duplicate, true, `delivery ${attempt}`);
      assert.equal(again.id, first.id);
    }

    assert.equal(await ledgerCount(client), 1);
    assert.deepEqual((await task(client)).convergence_counters, afterFirst.convergence_counters);
  } finally {
    await client.end();
  }
});

test('AC1: the unique key refuses a second row even from a writer that skipped the service',
  { skip }, async () => {
    const client = await connect();
    try {
      await reset(client);
      const service = new ConvergenceLedgerService(prisma(client));
      await inTransaction(client, async (tx) => {
        await service.ensureBaseline(tx, TASK, OWNER);
        return service.record(tx, TASK, OWNER, observation());
      });

      const key = await client.query(
        `SELECT "idempotency_key" FROM "task_convergence_decision" WHERE "task_id" = $1`, [TASK]);
      const message = await refused(() => client.query(`
        INSERT INTO "task_convergence_decision" (
          "id", "task_id", "owner_id", "seq", "scope_revision", "scope_hash", "attempt_generation",
          "idempotency_key", "input_hash", "input", "event", "from_state", "to_state", "decision",
          "progress_vector", "progress_vector_digest", "progressed", "counters", "decided_by"
        ) VALUES (
          gen_random_uuid(), $1, $2, 99, 1, $3, 0, $4, repeat('a', 64), '{}'::jsonb,
          'ATTEMPT_STARTED', 'CONVERGING', 'CONVERGING', 'CONTINUE',
          $5::jsonb, repeat('b', 64), false, $6::jsonb, 'ORCHESTRATOR'
        )`, [TASK, OWNER, SCOPE, rows<{ idempotency_key: string }>(key)[0].idempotency_key,
          JSON.stringify(vector()), JSON.stringify(ZERO_COUNTERS)]));
      assert.match(message, /idempotency_key/);
      assert.equal(await ledgerCount(client), 1);
    } finally {
      await client.end();
    }
  });

test('AC1: two decisions cannot produce the same logical action', { skip }, async () => {
  const client = await connect();
  try {
    await reset(client);
    const service = new ConvergenceLedgerService(prisma(client));
    await inTransaction(client, async (tx) => {
      await service.ensureBaseline(tx, TASK, OWNER);
      return service.record(tx, TASK, OWNER, observation({
        observationKey: 'session:one:started',
        event: 'ATTEMPT_STARTED',
        classification: null,
        failure: null,
        action: 'DISPATCH_ATTEMPT',
      }));
    });

    // A takeover recomputing the same plan under a different observation key: the DECISION is new,
    // the ACTION is the one already applied, and the partial unique index is what refuses it.
    const message = await refused(() => client.query(`
      INSERT INTO "task_convergence_decision" (
        "id", "task_id", "owner_id", "seq", "scope_revision", "scope_hash", "attempt_generation",
        "idempotency_key", "input_hash", "input", "event", "from_state", "to_state", "decision",
        "action", "action_idempotency_key",
        "progress_vector", "progress_vector_digest", "progressed", "counters", "decided_by"
      ) SELECT gen_random_uuid(), $1, $2, 2, 1, $3, 1, 'other-key', repeat('a', 64), '{}'::jsonb,
               'ATTEMPT_STARTED', 'CONVERGING', 'CONVERGING', 'CONTINUE',
               'DISPATCH_ATTEMPT', "action_idempotency_key",
               $4::jsonb, repeat('b', 64), false, $5::jsonb, 'ORCHESTRATOR'
          FROM "task_convergence_decision" WHERE "task_id" = $1`,
      [TASK, OWNER, SCOPE, JSON.stringify(vector()), JSON.stringify(ZERO_COUNTERS)]));
    assert.match(message, /action_key_idx/);
  } finally {
    await client.end();
  }
});

test('AC1: out-of-order facts each land once, and a superseded attempt cannot write at all',
  { skip }, async () => {
    const client = await connect();
    try {
      await reset(client);
      const service = new ConvergenceLedgerService(prisma(client));
      await inTransaction(client, async (tx) => {
        await service.ensureBaseline(tx, TASK, OWNER);
        await service.record(tx, TASK, OWNER, observation({
          observationKey: 'session:one:started',
          event: 'ATTEMPT_STARTED',
          classification: null,
          failure: null,
        }));
      });
      assert.equal((await task(client)).attempt_generation, '1');

      // Attempt 2 starts. Attempt 1's late failure now names a generation that is no longer
      // current: it would charge a budget for work already replaced, so the fence refuses it.
      await inTransaction(client, (tx) => service.record(tx, TASK, OWNER, observation({
        observationKey: 'session:two:started',
        event: 'ATTEMPT_STARTED',
        classification: null,
        failure: null,
      })));
      assert.equal((await task(client)).attempt_generation, '2');

      const message = await refused(() => client.query(`
        INSERT INTO "task_convergence_decision" (
          "id", "task_id", "owner_id", "seq", "scope_revision", "scope_hash", "attempt_generation",
          "idempotency_key", "input_hash", "input", "event", "from_state", "to_state", "decision",
          "progress_vector", "progress_vector_digest", "progressed", "counters", "decided_by"
        ) VALUES (
          gen_random_uuid(), $1, $2, 3, 1, $3, 1, 'late:session:one:failed', repeat('a', 64),
          '{}'::jsonb, 'ATTEMPT_FAILED_IN_SCOPE', 'CONVERGING', 'CONVERGING', 'CONTINUE',
          $4::jsonb, repeat('b', 64), false, $5::jsonb, 'ORCHESTRATOR'
        )`, [TASK, OWNER, SCOPE, JSON.stringify(vector()), JSON.stringify(ZERO_COUNTERS)]));
      assert.match(message, /STALE_ATTEMPT_GENERATION/);
      assert.equal(await ledgerCount(client), 2);
    } finally {
      await client.end();
    }
  });

// -------------------------------------------------------------------------------------------
// AC2 — a scope change is authorized, and a stale attempt cannot follow it.
// -------------------------------------------------------------------------------------------

test('AC2: a running task\'s scope is frozen, and the freeze is the database\'s', { skip }, async () => {
  const client = await connect();
  try {
    await reset(client);
    const service = new ConvergenceLedgerService(prisma(client));
    await inTransaction(client, async (tx) => {
      await service.ensureBaseline(tx, TASK, OWNER);
      await service.record(tx, TASK, OWNER, observation({
        observationKey: 'session:one:started',
        event: 'ATTEMPT_STARTED',
        classification: null,
        failure: null,
      }));
    });

    const message = await refused(() => client.query(
      `UPDATE "task" SET "acceptance_criteria" = 'AC and also deploy' WHERE "id" = $1`, [TASK]));
    assert.match(message, /SCOPE_FROZEN/);
    assert.equal((await task(client)).acceptance_criteria, 'AC');
  } finally {
    await client.end();
  }
});

test('AC2: only a USER revises scope under GUARDED_AUTO; AUTO opens exactly one cell',
  { skip }, async () => {
    const client = await connect();
    try {
      await reset(client);
      const service = new ConvergenceLedgerService(prisma(client));
      await inTransaction(client, (tx) => service.ensureBaseline(tx, TASK, OWNER));
      await inTransaction(client, (tx) => service.ensureBaseline(tx, AUTO_TASK, OWNER));

      const proposal = {
        title: 'T',
        description: null,
        acceptanceCriteria: 'AC and also deploy',
        reason: 'the defect is bigger than the task',
      };

      for (const actor of ['WORKER', 'VERIFIER', 'COORDINATOR'] as const) {
        const message = await refused(() =>
          service.reviseScope(OWNER, TASK, { ...proposal, actor, principal: 'agent' }));
        assert.match(message, /REQUIRES_USER|REQUIRES_AUTHORIZATION/, actor);
      }

      // AUTO is the user having signed for the re-planning in advance — and for nothing else.
      const auto = await service.reviseScope(OWNER, AUTO_TASK, {
        ...proposal, actor: 'COORDINATOR', principal: 'agent',
      });
      assert.equal(auto.revision, 2);

      const user = await service.reviseScope(OWNER, TASK, {
        ...proposal, actor: 'USER', principal: 'u-1',
      });
      assert.equal(user.revision, 2);
      assert.equal((await task(client)).acceptance_criteria, 'AC and also deploy');
    } finally {
      await client.end();
    }
  });

test('AC2: the superseded revision survives, immutably, with its spend attached', { skip }, async () => {
  const client = await connect();
  try {
    await reset(client);
    const service = new ConvergenceLedgerService(prisma(client));
    await inTransaction(client, async (tx) => {
      await service.ensureBaseline(tx, TASK, OWNER);
      await service.record(tx, TASK, OWNER, observation());
    });
    await service.reviseScope(OWNER, TASK, {
      title: 'T',
      description: null,
      acceptanceCriteria: 'AC and also deploy',
      actor: 'USER',
      principal: 'u-1',
      reason: 'bigger than the task',
    });

    const revisions = rows<{ revision: number; acceptance_criteria: string; authorized_by_actor: string | null }>(
      await client.query(`SELECT * FROM "task_scope_revision" WHERE "task_id" = $1 ORDER BY "revision"`, [TASK]));
    assert.equal(revisions.length, 2);
    assert.equal(revisions[0].acceptance_criteria, 'AC', 'what it USED to ask for is still readable');
    assert.equal(revisions[0].authorized_by_actor, null, 'revision 1 is "as found", not signed');
    assert.equal(revisions[1].authorized_by_actor, 'USER');

    // And revision 1's decision is still attached to revision 1, so the attempts charged to it stay
    // accounted for rather than being re-read as spend against the new question.
    const spent = rows<{ scope_revision: number }>(await client.query(
      `SELECT "scope_revision" FROM "task_convergence_decision" WHERE "task_id" = $1`, [TASK]));
    assert.deepEqual(spent.map((row) => row.scope_revision), [1]);

    const message = await refused(() => client.query(
      `UPDATE "task_scope_revision" SET "acceptance_criteria" = 'rewritten' WHERE "task_id" = $1 AND "revision" = 1`,
      [TASK]));
    assert.match(message, /SCOPE_REVISION_IMMUTABLE/);
  } finally {
    await client.end();
  }
});

test('AC2: a new revision restarts the budget and the old attempt cannot write against it',
  { skip }, async () => {
    const client = await connect();
    try {
      await reset(client);
      const service = new ConvergenceLedgerService(prisma(client));
      await inTransaction(client, async (tx) => {
        await service.ensureBaseline(tx, TASK, OWNER);
        await service.record(tx, TASK, OWNER, observation({
          observationKey: 'session:one:started',
          event: 'ATTEMPT_STARTED',
          classification: null,
          failure: null,
        }));
        await service.record(tx, TASK, OWNER, observation());
      });
      assert.equal((await task(client)).convergence_counters.attemptsOnRevision, 1);

      await service.reviseScope(OWNER, TASK, {
        title: 'T',
        description: null,
        acceptanceCriteria: 'AC and also deploy',
        actor: 'USER',
        principal: 'u-1',
        reason: 'bigger',
      });
      const after = await task(client);
      assert.deepEqual(after.convergence_counters, ZERO_COUNTERS, 'a new question gets a new budget');
      assert.equal(after.attempt_generation, '0');

      // The worker still running against revision 1 reports its result. It is a conclusion about a
      // question that has changed, and §6 FD4 refuses to build on it.
      const message = await refused(() => client.query(`
        INSERT INTO "task_convergence_decision" (
          "id", "task_id", "owner_id", "seq", "scope_revision", "scope_hash", "attempt_generation",
          "idempotency_key", "input_hash", "input", "event", "from_state", "to_state", "decision",
          "progress_vector", "progress_vector_digest", "progressed", "counters", "decided_by"
        ) VALUES (
          gen_random_uuid(), $1, $2, 9, 1, $3, 0, 'stale:one:done', repeat('a', 64), '{}'::jsonb,
          'ATTEMPT_DELIVERED', 'CONVERGING', 'VERIFYING', 'CONTINUE',
          $4::jsonb, repeat('b', 64), true, $5::jsonb, 'ORCHESTRATOR'
        )`, [TASK, OWNER, SCOPE, JSON.stringify(vector()), JSON.stringify(ZERO_COUNTERS)]));
      assert.match(message, /STALE_SCOPE_REVISION/);
    } finally {
      await client.end();
    }
  });

test('AC2: a scope revision cannot be invented by moving the pointer', { skip }, async () => {
  const client = await connect();
  try {
    await reset(client);
    const service = new ConvergenceLedgerService(prisma(client));
    await inTransaction(client, (tx) => service.ensureBaseline(tx, TASK, OWNER));

    const skipped = await refused(() => client.query(
      `UPDATE "task" SET "scope_revision" = 2 WHERE "id" = $1`, [TASK]));
    assert.match(skipped, /SCOPE_REVISION_NOT_RECORDED/);

    const backwards = await refused(() => client.query(
      `UPDATE "task" SET "scope_revision" = 0 WHERE "id" = $1`, [TASK]));
    assert.match(backwards, /SCOPE_REVISION_MONOTONIC|scope_revision_chk/);
  } finally {
    await client.end();
  }
});

test('AC2: a revision whose content does not match what the task becomes is refused',
  { skip }, async () => {
    const client = await connect();
    try {
      await reset(client);
      const service = new ConvergenceLedgerService(prisma(client));
      await inTransaction(client, async (tx) => {
        await service.ensureBaseline(tx, TASK, OWNER);
        await service.record(tx, TASK, OWNER, observation({
          observationKey: 'session:one:started',
          event: 'ATTEMPT_STARTED',
          classification: null,
          failure: null,
        }));
      });
      await client.query(`
        INSERT INTO "task_scope_revision" (
          "id", "task_id", "owner_id", "revision", "scope_hash", "title", "acceptance_criteria",
          "authorized_by_actor", "authorized_by_principal", "automation_policy", "reason",
          "supersedes_revision"
        ) VALUES (gen_random_uuid(), $1, $2, 2, repeat('c', 64), 'T', 'AC signed for',
                  'USER', 'u-1', 'GUARDED_AUTO', 'signed', 1)`, [TASK, OWNER]);

      // The signed revision says one thing; the update says another. Letting it through would make
      // the audit claim a user approved a scope they never saw.
      const message = await refused(() => client.query(
        `UPDATE "task" SET "acceptance_criteria" = 'something else entirely', "scope_revision" = 2
          WHERE "id" = $1`, [TASK]));
      assert.match(message, /SCOPE_REVISION_CONTENT_MISMATCH/);
    } finally {
      await client.end();
    }
  });

// -------------------------------------------------------------------------------------------
// AC3 — Base62 out, tenancy not weakened.
// -------------------------------------------------------------------------------------------

test('AC3: the read face serves Base62 only, including inside the machine keys', { skip }, async () => {
  const client = await connect();
  try {
    await reset(client);
    const service = new ConvergenceLedgerService(prisma(client));
    await inTransaction(client, async (tx) => {
      await service.ensureBaseline(tx, TASK, OWNER);
      await service.record(tx, TASK, OWNER, observation({
        observationKey: 'session:one:started',
        event: 'ATTEMPT_STARTED',
        classification: null,
        failure: null,
        action: 'DISPATCH_ATTEMPT',
      }));
    });

    const described = await service.describe(OWNER, TASK);
    const serialized = JSON.stringify(described);
    assert.doesNotMatch(
      serialized,
      /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/,
      'no raw UUID may leave, not even buried in an idempotency key',
    );
    assert.equal(base62ToUuid(described.taskId), TASK);
    assert.equal(base62ToUuid(described.ledger[0].sessionId!), SESSION);
    assert.equal(described.thresholds.maxAttemptsWithoutProgress, 5, 'the RESOLVED limit, not a null');
    assert.equal(described.managed, true);
  } finally {
    await client.end();
  }
});

test('AC3: another owner cannot read, write or attach to this task\'s ledger', { skip }, async () => {
  const client = await connect();
  try {
    await reset(client);
    const service = new ConvergenceLedgerService(prisma(client));
    await inTransaction(client, (tx) => service.ensureBaseline(tx, TASK, OWNER));

    await assert.rejects(() => service.describe(OTHER_OWNER, TASK), /not found/);
    await assert.rejects(
      () => inTransaction(client, (tx) => service.record(tx, TASK, OTHER_OWNER, observation())),
      /not found/,
    );

    // And the composite key is the database's own answer: a row may not name a task while claiming
    // a different owner. Written against a task with no baseline yet, so the FK is what refuses it
    // and not one of the guards that would have spoken first.
    const message = await refused(() => client.query(`
      INSERT INTO "task_scope_revision" ("id", "task_id", "owner_id", "revision", "scope_hash", "title", "reason")
      VALUES (gen_random_uuid(), $1, $2, 1, repeat('d', 64), 'T', 'smuggled')`,
      [AUTO_TASK, OTHER_OWNER]));
    assert.match(message, /task_scope_revision_task_fkey/);
  } finally {
    await client.end();
  }
});

// -------------------------------------------------------------------------------------------
// AC4 — crash, takeover, and no repeated action.
// -------------------------------------------------------------------------------------------

test('AC4: the state rebuilt from the ledger equals the state in the columns', { skip }, async () => {
  const client = await connect();
  try {
    await reset(client);
    const service = new ConvergenceLedgerService(prisma(client));
    await inTransaction(client, async (tx) => {
      await service.ensureBaseline(tx, TASK, OWNER);
      await service.record(tx, TASK, OWNER, observation({
        observationKey: 'session:one:started', event: 'ATTEMPT_STARTED', classification: null, failure: null,
      }));
      await service.record(tx, TASK, OWNER, observation());
      await service.record(tx, TASK, OWNER, observation({
        observationKey: 'session:one:delivered',
        event: 'ATTEMPT_DELIVERED',
        classification: null,
        failure: null,
        progressVector: vector({ acceptanceClosed: 2, knownGoodSha: 'f'.repeat(40) }),
      }));
    });

    const recovered = await service.recover(OWNER, TASK);
    assert.equal(recovered.consistent, true);
    assert.equal(recovered.fromLedger.progressState, 'VERIFYING');
    assert.equal(recovered.fromLedger.attemptGeneration, 1);
    assert.equal(recovered.fromLedger.knownGoodSha, 'f'.repeat(40));
    assert.deepEqual(recovered.fromLedger.counters, recovered.fromColumns.counters);
  } finally {
    await client.end();
  }
});

test('AC4/AC5: a crashed pass leaves neither a row nor a moved counter', { skip }, async () => {
  const client = await connect();
  try {
    await reset(client);
    const service = new ConvergenceLedgerService(prisma(client));
    await inTransaction(client, (tx) => service.ensureBaseline(tx, TASK, OWNER));
    const before = await task(client);

    // The row and the counters are one unit. A writer that moved the columns and then died would
    // leave a budget spent on a judgment nobody can read — so the CHECK that refuses the row has to
    // take the update with it.
    await assert.rejects(() => inTransaction(client, (tx) => service.record(tx, TASK, OWNER,
      observation({ progressVector: { ...vector(), scopeHash: 'e'.repeat(64) } }))));

    assert.equal(await ledgerCount(client), 0);
    assert.deepEqual((await task(client)).convergence_counters, before.convergence_counters);
    assert.equal((await task(client)).attempt_generation, before.attempt_generation);
  } finally {
    await client.end();
  }
});

test('AC4: a takeover replaying the same facts repeats no action and spends no budget',
  { skip }, async () => {
    const client = await connect();
    try {
      await reset(client);
      const service = new ConvergenceLedgerService(prisma(client));
      const facts = [
        observation({ observationKey: 'session:one:started', event: 'ATTEMPT_STARTED', classification: null, failure: null, action: 'DISPATCH_ATTEMPT' }),
        observation(),
        observation({ observationKey: 'session:one:env', event: 'ENVIRONMENT_FAILURE', classification: 'ENVIRONMENT' }),
      ];
      await inTransaction(client, async (tx) => {
        await service.ensureBaseline(tx, TASK, OWNER);
        for (const fact of facts) await service.record(tx, TASK, OWNER, fact);
      });
      const settled = await task(client);
      const count = await ledgerCount(client);

      // A second coordinator takes over and replays everything it can see. Not one of them lands.
      await inTransaction(client, async (tx) => {
        await service.ensureBaseline(tx, TASK, OWNER);
        for (const fact of facts) {
          const result = await service.record(tx, TASK, OWNER, fact);
          assert.equal(result.duplicate, true);
        }
      });

      assert.equal(await ledgerCount(client), count);
      assert.deepEqual((await task(client)).convergence_counters, settled.convergence_counters);
      assert.equal((await task(client)).attempt_generation, settled.attempt_generation);
    } finally {
      await client.end();
    }
  });

test('TH4: no writer may walk a counter downward without progress or a new revision', { skip }, async () => {
  const client = await connect();
  try {
    await reset(client);
    const service = new ConvergenceLedgerService(prisma(client));
    await inTransaction(client, async (tx) => {
      await service.ensureBaseline(tx, TASK, OWNER);
      await service.record(tx, TASK, OWNER, observation({
        observationKey: 'session:one:started',
        event: 'ATTEMPT_STARTED',
        classification: null,
        failure: null,
      }));
      await service.record(tx, TASK, OWNER, observation());
    });
    assert.equal((await task(client)).attempt_generation, '1');

    // The shape every escape from this breaker has had: a restart re-initialising from zero.
    const message = await refused(() => client.query(
      `UPDATE "task" SET "convergence_counters" = $2::jsonb WHERE "id" = $1`,
      [TASK, JSON.stringify(ZERO_COUNTERS)]));
    assert.match(message, /CONVERGENCE_COUNTER_REGRESSED/);

    // Nor by claiming an attempt generation it already passed.
    const generation = await refused(() => client.query(
      `UPDATE "task" SET "attempt_generation" = 0, "convergence_counters" = "convergence_counters"
        WHERE "id" = $1`, [TASK]));
    assert.match(generation, /ATTEMPT_GENERATION_MONOTONIC|attempt_generation_chk/);
  } finally {
    await client.end();
  }
});

test('OW4: an unbounded threshold with nobody\'s name on it cannot be stored', { skip }, async () => {
  const client = await connect();
  try {
    await reset(client);
    const message = await refused(() => client.query(
      `UPDATE "project" SET "unbounded_authorized_by" = '{"actor":"COORDINATOR","principal":"agent"}'::jsonb
        WHERE "id" = $1`, [PROJECT]));
    assert.match(message, /unbounded_authorized_by_chk/);

    await client.query(
      `UPDATE "project" SET "unbounded_authorized_by" = '{"actor":"USER","principal":"u-1"}'::jsonb
        WHERE "id" = $1`, [PROJECT]);

    // With the signature stored, an unbounded override is honoured — and without it, it is not.
    const service = new ConvergenceLedgerService(prisma(client));
    await inTransaction(client, (tx) => service.ensureBaseline(tx, TASK, OWNER));
    await client.query(
      `UPDATE "project" SET "convergence_thresholds" = '{"maxAttemptsWithoutProgress":null}'::jsonb
        WHERE "id" = $1`, [PROJECT]);
    assert.equal((await service.describe(OWNER, TASK)).thresholds.maxAttemptsWithoutProgress, null);

    await client.query(`UPDATE "project" SET "unbounded_authorized_by" = NULL WHERE "id" = $1`, [PROJECT]);
    assert.equal((await service.describe(OWNER, TASK)).thresholds.maxAttemptsWithoutProgress, 5,
      'the signature is what made it unbounded; without it the default applies');
  } finally {
    await client.end();
  }
});

test('the ledger is append-only', { skip }, async () => {
  const client = await connect();
  try {
    await reset(client);
    const service = new ConvergenceLedgerService(prisma(client));
    await inTransaction(client, async (tx) => {
      await service.ensureBaseline(tx, TASK, OWNER);
      await service.record(tx, TASK, OWNER, observation());
    });
    const message = await refused(() => client.query(
      `UPDATE "task_convergence_decision" SET "progressed" = true WHERE "task_id" = $1`, [TASK]));
    assert.match(message, /CONVERGENCE_DECISION_IMMUTABLE/);
  } finally {
    await client.end();
  }
});
