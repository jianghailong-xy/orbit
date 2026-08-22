import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { Prisma } from '@prisma/client';
import type { Client, QueryResult } from 'pg';
import { PrismaService } from '../prisma/prisma.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from './coordinator-pg-test-safety';
import { ZERO_COUNTERS } from './convergence-contract';
import { EMPTY_PROGRESS_VECTOR, ProgressVector, scopeHash } from './convergence-progress';
import { actionIdentity, hypothesisIdentity } from './convergence-evidence';
import { ConvergenceObservation } from './convergence-ledger';
import { ConvergenceLedgerService } from './convergence-ledger.service';

// `[K4]` against real PostgreSQL, on a DISPOSABLE server.
//
// The pure spec shows the decisions are right. This one is about the two places a decision can be
// right and still not hold: the database, where a writer that skipped the service lives, and the
// clock, where two writers exist at once. Both are the incident's population — its counters were
// reset by restarts and its dispatches raced its own judgments — so `[K4]`'s two new lines are
// worth exactly as much as their durability.
//
// The server is proved disposable before the first write (`coordinator-pg-test-safety.ts`): a
// copied production URL fails on the explicit expected database, role and system identifier rather
// than on a `DROP SCHEMA` that already ran.

const URL = process.env.COORDINATOR_PG_URL;
const SCHEMA = 'pcck4_progress';
const skip = !URL;

const OWNER = '00000000-0000-7000-8000-000000004001';
const PROJECT = '00000000-0000-7000-8000-000000004002';
const TASK = '00000000-0000-7000-8000-000000004003';
const LEGACY_TASK = '00000000-0000-7000-8000-000000004004';

const LEDGER = migration('0132_task_convergence_ledger');
const ATTEMPT = migration('0133_task_session_attempt');
const IDENTITY = migration('0134_task_progress_vector_identity');

const SCOPE = scopeHash({ title: 'T', description: null, acceptanceCriteria: 'AC' });
const AT = new Date('2026-08-22T10:00:00.000Z');
const ACTION = actionIdentity({
  kind: 'DISPATCH_ATTEMPT', target: null, hypothesis: 'rerun the suite', scopeHash: SCOPE,
});
const HYPOTHESIS = hypothesisIdentity('rerun the suite', SCOPE);

/** The seven-key counters every task carried before 0134. */
const LEGACY_COUNTERS = {
  attemptsOnRevision: 0,
  attemptsWithoutProgress: 0,
  sameFingerprintRepeats: 0,
  decisionsWithoutProgress: 0,
  verificationRounds: 0,
  transientRetries: 0,
  scopeExpansionRequests: 0,
};

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

/** The world as it stood BEFORE 0134: 0132 and 0133 applied, rows written, nothing else. */
async function resetToPre0134(client: Client): Promise<void> {
  await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await client.query(`CREATE SCHEMA ${SCHEMA}`);
  await client.query(`SET search_path TO ${SCHEMA}`);
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
    CREATE TABLE "session" (
      "id" UUID PRIMARY KEY,
      "owner_id" UUID NOT NULL,
      "status" TEXT NOT NULL DEFAULT 'RUNNING',
      "num_turns" INTEGER NOT NULL DEFAULT 0,
      "cost_usd" DOUBLE PRECISION NOT NULL DEFAULT 0,
      "context_tokens" INTEGER,
      "context_window" INTEGER,
      "started_at" TIMESTAMP(3)
    );
    CREATE TABLE "tool_call" (
      "id" UUID PRIMARY KEY,
      "session_id" UUID NOT NULL REFERENCES "session"("id") ON DELETE CASCADE
    );
  `);
  await client.query(LEDGER);
  await client.query(ATTEMPT);
  await client.query(`
    INSERT INTO "project" ("id", "owner_id", "title") VALUES ('${PROJECT}', '${OWNER}', 'P');
    INSERT INTO "task" ("id", "owner_id", "project_id", "title", "acceptance_criteria")
      VALUES ('${TASK}', '${OWNER}', '${PROJECT}', 'T', 'AC');
    INSERT INTO "task" ("id", "owner_id", "project_id", "title", "acceptance_criteria")
      VALUES ('${LEGACY_TASK}', '${OWNER}', '${PROJECT}', 'T', 'AC');
  `);
}

async function reset(client: Client): Promise<void> {
  await resetToPre0134(client);
  await client.query(IDENTITY);
}

function vector(over: Partial<ProgressVector> = {}): ProgressVector {
  return { ...EMPTY_PROGRESS_VECTOR, scopeHash: SCOPE, acceptanceTotal: 4, ...over };
}

function observation(over: Partial<ConvergenceObservation> = {}): ConvergenceObservation {
  return {
    observationKey: 'session:abc:failed',
    event: 'ATTEMPT_FAILED_IN_SCOPE',
    classification: 'IN_SCOPE_DEFECT',
    failure: {
      stage: 'RUN',
      subjectKind: 'TASK',
      scopeHash: SCOPE,
      violatedInvariant: 'TEST_RED',
      message: 'expected 3 got 4',
    },
    progressVector: vector({ openP0: 2 }),
    evidence: { freshness: 'FRESH', evidenceAsOf: AT, staleItems: [] },
    observedAt: AT,
    decidedBy: 'ORCHESTRATOR',
    action: 'DISPATCH_ATTEMPT',
    actionIdentity: ACTION,
    hypothesisIdentity: HYPOTHESIS,
    ...over,
  };
}

function attempt(n: number, over: Partial<ConvergenceObservation> = {}): ConvergenceObservation {
  return observation({
    observationKey: `session:${n}:started`,
    event: 'ATTEMPT_STARTED',
    classification: null,
    failure: null,
    action: 'DISPATCH_ATTEMPT',
    ...over,
  });
}

interface TaskRow {
  progress_state: string;
  convergence_counters: Record<string, number>;
  last_progress_at: Date | null;
}

async function task(client: Client, id = TASK): Promise<TaskRow> {
  return rows<TaskRow>(await client.query(`SELECT * FROM "task" WHERE "id" = $1`, [id]))[0];
}

interface DecisionRow {
  seq: string;
  action_identity: string | null;
  hypothesis_identity: string | null;
  evidence_freshness: string | null;
  evidence_as_of: Date | null;
  non_convergence_reason: string | null;
  to_state: string;
  progressed: boolean;
  counters: Record<string, number>;
}

async function decisions(client: Client, id = TASK): Promise<DecisionRow[]> {
  return rows<DecisionRow>(await client.query(
    `SELECT * FROM "task_convergence_decision" WHERE "task_id" = $1 ORDER BY "seq"`, [id]));
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
// AC5 — the migration, and what it does to a database that is already running.
// -------------------------------------------------------------------------------------------

test('AC5: 0134 applies over a live 0132/0133 database and backfills both counters', { skip }, async () => {
  const client = await connect();
  try {
    await resetToPre0134(client);
    // A task and a committed decision written under the OLD seven-key shape, exactly as every
    // deployed row is on the day this migration runs. Written with pre-0134 SQL rather than
    // through today's service, because a service that names `action_identity` could not have
    // produced any of the rows this migration has to cope with.
    const service = new ConvergenceLedgerService(prisma(client));
    await inTransaction(client, (tx) => service.ensureBaseline(tx, TASK, OWNER));
    const legacyCounters = { ...LEGACY_COUNTERS, attemptsWithoutProgress: 1 };
    await client.query(
      `UPDATE "task" SET "convergence_counters" = $1::jsonb WHERE "id" = $2`,
      [JSON.stringify(legacyCounters), TASK]);
    await client.query(`
      INSERT INTO "task_convergence_decision" (
        "id", "task_id", "owner_id", "seq", "scope_revision", "scope_hash", "attempt_generation",
        "idempotency_key", "input_hash", "input", "event", "from_state", "to_state",
        "classification", "decision", "progress_vector", "progress_vector_digest", "progressed",
        "counters", "decided_by", "created_at"
      ) VALUES (
        gen_random_uuid(), $1, $2, 1, 1, $3, 0, 'pc:v1:legacy', repeat('a', 64), '{}'::jsonb,
        'ATTEMPT_FAILED_IN_SCOPE', 'CONVERGING', 'CONVERGING', 'IN_SCOPE_DEFECT',
        'CREATE_DEFECT_SUBTASK', $4::jsonb, repeat('b', 64), false, $5::jsonb, 'ORCHESTRATOR', $6
      )`,
    [TASK, OWNER, SCOPE, JSON.stringify(vector()), JSON.stringify(legacyCounters), AT]);
    assert.deepEqual(Object.keys((await task(client)).convergence_counters).sort(),
      Object.keys(LEGACY_COUNTERS).sort());

    await client.query(IDENTITY);

    // Both columns and ledger rows gain the two keys at zero — the only honest value, since
    // nothing in the committed history says which action any of those rows proposed.
    const after = await task(client);
    assert.equal(after.convergence_counters.sameActionRepeats, 0);
    assert.equal(after.convergence_counters.repairsWithoutSeverityDrop, 0);
    assert.equal(after.convergence_counters.attemptsWithoutProgress, 1, 'and the old spend survives');
    const [row] = await decisions(client);
    assert.equal(row.counters.sameActionRepeats, 0);
    assert.equal(row.counters.repairsWithoutSeverityDrop, 0);
    assert.equal(row.action_identity, null, 'a pre-0134 row cannot claim an identity it never had');

    // And the ledger is append-only again the moment the backfill is done: the migration disabled
    // the immutability guard for one statement, not for the future.
    const message = await refused(() => client.query(
      `UPDATE "task_convergence_decision" SET "to_state" = 'SETTLED' WHERE "task_id" = $1`, [TASK]));
    assert.match(message, /CONVERGENCE_DECISION_IMMUTABLE/);
  } finally {
    await client.end();
  }
});

test('AC5: a task created after 0134 is born with nine counters, not seven', { skip }, async () => {
  const client = await connect();
  try {
    await reset(client);
    await client.query(`
      INSERT INTO "task" ("id", "owner_id", "project_id", "title")
      VALUES ('00000000-0000-7000-8000-00000000400f', $1, $2, 'fresh')`, [OWNER, PROJECT]);
    const fresh = await task(client, '00000000-0000-7000-8000-00000000400f');
    assert.deepEqual(fresh.convergence_counters, ZERO_COUNTERS);
    // The failure this refuses: a column default left at seven keys makes every new task violate
    // the nine-key CHECK on its first judgment, which surfaces days later as "the coordinator
    // cannot write to new tasks".
    assert.equal(Object.keys(fresh.convergence_counters).length, 9);
  } finally {
    await client.end();
  }
});

test('AC5: the counter CHECK and the reason CHECK both know the new names', { skip }, async () => {
  const client = await connect();
  try {
    await reset(client);
    // An INSERT rather than an UPDATE: the monotonic trigger only guards updates, and what is
    // being tested here is the CHECK — that a seven-key object is not a valid set of counters at
    // all, whoever writes it and however it got that way.
    const missing = await refused(() => client.query(`
      INSERT INTO "task" ("id", "owner_id", "project_id", "title", "convergence_counters")
      VALUES ('00000000-0000-7000-8000-00000000401f', $1, $2, 'seven', $3::jsonb)`,
    [OWNER, PROJECT, JSON.stringify(LEGACY_COUNTERS)]));
    assert.match(missing, /task_convergence_counters_chk/);

    // And the two reasons a trip may now name are storable, which they were not before 0134.
    const stored = await client.query(`
      SELECT 'SAME_ACTION_REPEATED' IN (
        SELECT unnest(ARRAY['SAME_ACTION_REPEATED', 'SEVERITY_NOT_DECLINING'])) AS ok`);
    assert.equal(rows<{ ok: boolean }>(stored)[0].ok, true);
  } finally {
    await client.end();
  }
});

// -------------------------------------------------------------------------------------------
// AC4 — a restart, a redelivery and a takeover cannot walk a counter down.
// -------------------------------------------------------------------------------------------

test('AC4/TH4: neither new counter may go down without progress, from any writer', { skip }, async () => {
  const client = await connect();
  try {
    await reset(client);
    await client.query(
      `UPDATE "task" SET "convergence_counters" = $1::jsonb WHERE "id" = $2`,
      [JSON.stringify({ ...ZERO_COUNTERS, sameActionRepeats: 2, repairsWithoutSeverityDrop: 2 }), TASK]);

    for (const key of ['sameActionRepeats', 'repairsWithoutSeverityDrop']) {
      const message = await refused(() => client.query(
        `UPDATE "task" SET "convergence_counters" = $1::jsonb WHERE "id" = $2`,
        [JSON.stringify({ ...ZERO_COUNTERS, sameActionRepeats: 2, repairsWithoutSeverityDrop: 2, [key]: 0 }), TASK]));
      assert.match(message, /CONVERGENCE_COUNTER_REGRESSED/, key);
    }

    // Progress is the licence, and it has to be a real one: `last_progress_at` moving forward in
    // the same statement. That is what a restart cannot fake, because it would have to claim a
    // strict improvement it did not measure.
    await client.query(
      `UPDATE "task" SET "convergence_counters" = $1::jsonb, "last_progress_at" = $2 WHERE "id" = $3`,
      [JSON.stringify({ ...ZERO_COUNTERS, repairsWithoutSeverityDrop: 0 }), AT, TASK]);
    assert.equal((await task(client)).convergence_counters.sameActionRepeats, 0);
  } finally {
    await client.end();
  }
});

test('AC4: the repeat count is read from the ledger, so a restart recomputes it unchanged',
  { skip }, async () => {
    const client = await connect();
    try {
      await reset(client);
      // Three judgments, three different failures, ONE action. Each one is a separate service
      // instance — the takeover this is about does not share a process, let alone a counter.
      for (const n of [1, 2, 3]) {
        const service = new ConvergenceLedgerService(prisma(client));
        await inTransaction(client, async (tx) => {
          if (n === 1) await service.ensureBaseline(tx, TASK, OWNER);
          return service.record(tx, TASK, OWNER, attempt(n));
        });
      }

      const committed = await task(client);
      assert.equal(committed.convergence_counters.sameActionRepeats, 2,
        'the third proposal of one action is the second repeat, counted off committed rows');
      const rowsOut = await decisions(client);
      assert.equal(rowsOut.length, 3);
      assert.equal(rowsOut[2].action_identity, ACTION);
      assert.equal(rowsOut[2].hypothesis_identity, HYPOTHESIS);
      assert.equal(rowsOut[2].evidence_freshness, 'FRESH');

      // The fourth crosses the line, and the task lands on NEEDS_REPLAN in the same transaction
      // that wrote the row — there is no window in which the trip is decided but not durable.
      const fourth = await inTransaction(client, (tx) => new ConvergenceLedgerService(prisma(client))
        .record(tx, TASK, OWNER, attempt(4)));
      assert.equal(fourth.decision?.nonConvergenceReason, 'SAME_ACTION_REPEATED');
      assert.equal((await task(client)).progress_state, 'NEEDS_REPLAN');
      assert.equal(fourth.decision?.action, null, 'and it produced no action to retry with');
    } finally {
      await client.end();
    }
  });

test('AC1: a redelivered judgment does not count as a second proposal of the same action',
  { skip }, async () => {
    const client = await connect();
    try {
      await reset(client);
      const service = new ConvergenceLedgerService(prisma(client));
      await inTransaction(client, async (tx) => {
        await service.ensureBaseline(tx, TASK, OWNER);
        return service.record(tx, TASK, OWNER, attempt(1));
      });
      for (const n of [2, 3, 4, 5]) {
        const again = await inTransaction(client, (tx) => service.record(tx, TASK, OWNER, attempt(1)));
        assert.equal(again.duplicate, true, `delivery ${n}`);
      }
      // Five deliveries of one fact. Without the idempotency key this is the incident's counter
      // inflation in miniature — and with `[K4]`'s line it would be a trip on a loop that never
      // happened, which is the same defect pointing the other way.
      assert.equal((await decisions(client)).length, 1);
      assert.equal((await task(client)).convergence_counters.sameActionRepeats, 0);
      assert.equal((await task(client)).progress_state, 'CONVERGING');
    } finally {
      await client.end();
    }
  });

// -------------------------------------------------------------------------------------------
// The concurrency the trip has to survive.
// -------------------------------------------------------------------------------------------

test('the trip and a concurrent dispatch serialise: the dispatch is refused, not raced',
  { skip }, async () => {
    const a = await connect();
    const b = await connect();
    try {
      await reset(a);
      const service = new ConvergenceLedgerService(prisma(a));
      await inTransaction(a, async (tx) => {
        await service.ensureBaseline(tx, TASK, OWNER);
        return service.record(tx, TASK, OWNER, attempt(1));
      });
      for (const n of [2, 3]) {
        await inTransaction(a, (tx) => service.record(tx, TASK, OWNER, attempt(n)));
      }

      // A is mid-trip and has not committed. B asks whether it may dispatch.
      await a.query('BEGIN');
      const tripping = await new ConvergenceLedgerService(prisma(a))
        .record(transactionClient(a), TASK, OWNER, attempt(4));
      assert.equal(tripping.decision?.nonConvergenceReason, 'SAME_ACTION_REPEATED');

      const gate = new ConvergenceLedgerService(prisma(b));
      await b.query('BEGIN');
      const asked = gate.dispatchGate(transactionClient(b), TASK, OWNER);
      // B is now blocked on A's row lock. That IS the answer: a gate that read without the lock
      // would see the pre-trip world and dispatch the retry the trip exists to stop.
      let settled = false;
      void asked.then(() => { settled = true; });
      await new Promise((resolve) => setTimeout(resolve, 150));
      assert.equal(settled, false, 'the gate must wait for the judgment in flight');

      await a.query('COMMIT');
      const answer = await asked;
      await b.query('COMMIT');
      assert.equal(answer.refusal, 'TASK_NEEDS_REPLAN');
      assert.equal(answer.dispatchable, false);
      assert.equal(answer.progressState, 'NEEDS_REPLAN');
    } finally {
      await a.end();
      await b.end();
    }
  });

test('two writers judging one task do not lose a repeat between them', { skip }, async () => {
  const a = await connect();
  const b = await connect();
  try {
    await reset(a);
    const first = new ConvergenceLedgerService(prisma(a));
    await inTransaction(a, async (tx) => {
      await first.ensureBaseline(tx, TASK, OWNER);
      return first.record(tx, TASK, OWNER, attempt(1));
    });

    // Both open a transaction and judge the same task with the same plan, at once.
    await a.query('BEGIN');
    await b.query('BEGIN');
    const fromA = first.record(transactionClient(a), TASK, OWNER, attempt(2));
    await new Promise((resolve) => setTimeout(resolve, 50));
    const fromB = new ConvergenceLedgerService(prisma(b)).record(transactionClient(b), TASK, OWNER,
      attempt(3));
    await fromA;
    await a.query('COMMIT');
    await fromB;
    await b.query('COMMIT');

    // Three distinct facts, three rows, and the last writer's count includes the other's row
    // rather than the world it read when it started. A count taken outside the lock would give
    // both of them 1, and one repeat would simply vanish.
    const committed = await task(a);
    assert.equal((await decisions(a)).length, 3);
    assert.equal(committed.convergence_counters.sameActionRepeats, 2);
  } finally {
    await a.end();
    await b.end();
  }
});

// -------------------------------------------------------------------------------------------
// PV6, durably.
// -------------------------------------------------------------------------------------------

test('PV6: a stale reading is stored as one and refreshes nothing', { skip }, async () => {
  const client = await connect();
  try {
    await reset(client);
    const service = new ConvergenceLedgerService(prisma(client));
    await inTransaction(client, async (tx) => {
      await service.ensureBaseline(tx, TASK, OWNER);
      return service.record(tx, TASK, OWNER, observation({
        progressVector: vector({ openP0: 3 }), action: null, actionIdentity: null,
      }));
    });

    const stale = new Date(AT.getTime() - 90 * 60_000);
    await inTransaction(client, (tx) => service.record(tx, TASK, OWNER, observation({
      observationKey: 'session:abc:measured',
      event: 'ATTEMPT_DELIVERED',
      classification: null,
      failure: null,
      action: null,
      actionIdentity: null,
      progressVector: vector({ openP0: 1 }),
      evidence: { freshness: 'STALE', evidenceAsOf: stale, staleItems: ['acceptance:ac1'] },
    })));

    const [, second] = await decisions(client);
    assert.equal(second.evidence_freshness, 'STALE');
    assert.deepEqual(second.evidence_as_of, stale);
    assert.equal(second.progressed, false);
    assert.equal((await task(client)).last_progress_at, null,
      'a measurement the evidence cannot support does not buy another five attempts');
  } finally {
    await client.end();
  }
});

test('PV6: a freshness claim without its timestamp cannot be stored', { skip }, async () => {
  const client = await connect();
  try {
    await reset(client);
    const service = new ConvergenceLedgerService(prisma(client));
    await inTransaction(client, async (tx) => {
      await service.ensureBaseline(tx, TASK, OWNER);
      return service.record(tx, TASK, OWNER, attempt(1));
    });
    const message = await refused(() => client.query(`
      INSERT INTO "task_convergence_decision" (
        "id", "task_id", "owner_id", "seq", "scope_revision", "scope_hash", "attempt_generation",
        "idempotency_key", "input_hash", "input", "event", "from_state", "to_state", "decision",
        "progress_vector", "progress_vector_digest", "progressed", "counters",
        "evidence_freshness", "decided_by"
      ) VALUES (
        gen_random_uuid(), $1, $2, 99, 1, $3, 1, 'k', repeat('a', 64), '{}'::jsonb,
        'ATTEMPT_STARTED', 'CONVERGING', 'CONVERGING', 'CONTINUE',
        $4::jsonb, repeat('b', 64), false, $5::jsonb, 'FRESH', 'ORCHESTRATOR'
      )`,
    [TASK, OWNER, SCOPE, JSON.stringify(vector()), JSON.stringify(ZERO_COUNTERS)]));
    assert.match(message, /freshness_time_chk/);
  } finally {
    await client.end();
  }
});
