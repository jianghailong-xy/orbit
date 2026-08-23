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
import { DEFAULT_ATTEMPT_BUDGET } from './convergence-contract';
import { EMPTY_PROGRESS_VECTOR, ProgressVector, scopeHash } from './convergence-progress';
import { ConvergenceLedgerService } from './convergence-ledger.service';
import { SessionAttemptService } from './session-attempt.service';
import { hypothesisDigest } from './attempt-budget';

// `[K3]`'s attempt on real PostgreSQL, against a DISPOSABLE server.
//
// Everything here is a property of the DATABASE rather than of the planner, because the writer that
// breaks one is by definition the one that skipped the service. `attempt-budget.spec.ts` shows the
// decisions are right; this shows they still hold against a raw statement, a redelivered dispatch,
// a takeover and a crash — which is the population the incident was written by.
//
// The server is disposable and proved so before the first write (`coordinator-pg-test-safety.ts`):
// a copied production URL fails on the explicit expected database, role and system identifier
// rather than on a `DROP SCHEMA` that already ran.

const URL = process.env.COORDINATOR_PG_URL;
const SCHEMA = 'pcck3_attempt';
const skip = !URL;

const OWNER = '00000000-0000-7000-8000-000000003001';
const PROJECT = '00000000-0000-7000-8000-000000003002';
const TASK = '00000000-0000-7000-8000-000000003003';
const OTHER_TASK = '00000000-0000-7000-8000-000000003004';
const SESSION_A = '00000000-0000-7000-8000-00000000300a';
const SESSION_B = '00000000-0000-7000-8000-00000000300b';
const SESSION_C = '00000000-0000-7000-8000-00000000300c';
const COORDINATOR_SESSION = '00000000-0000-7000-8000-00000000300d';

const LEDGER = migration('0138_task_convergence_ledger');
const ATTEMPT = migration('0139_task_session_attempt');
const IDENTITY = migration('0140_task_progress_vector_identity');

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

function services(client: Client): { attempts: SessionAttemptService; ledger: ConvergenceLedgerService } {
  const db = prisma(client);
  const ledger = new ConvergenceLedgerService(db);
  return { attempts: new SessionAttemptService(db, ledger), ledger };
}

async function reset(client: Client): Promise<void> {
  await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await client.query(`CREATE SCHEMA ${SCHEMA}`);
  await client.query(`SET search_path TO ${SCHEMA}`);
  // The subset of the real schema these two migrations touch, built by hand exactly as the other
  // coordinator pg specs do — the point is to exercise 0139's own SQL, not to replay 138 migrations.
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
  // `[K4]`'s 0140 too: the service this spec drives writes the action identity and the evidence
  // reading, which are 0140's columns. A fixture that stopped at the migration this file is named
  // after would be testing a service that no longer exists.
  await client.query(IDENTITY);
  await client.query(`
    INSERT INTO "project" ("id", "owner_id", "title") VALUES ('${PROJECT}', '${OWNER}', 'P');
    INSERT INTO "task" ("id", "owner_id", "project_id", "title", "acceptance_criteria")
      VALUES ('${TASK}', '${OWNER}', '${PROJECT}', 'T', 'AC');
    INSERT INTO "task" ("id", "owner_id", "project_id", "title", "acceptance_criteria")
      VALUES ('${OTHER_TASK}', '${OWNER}', '${PROJECT}', 'T', 'AC');
  `);
  // `started_at` goes in as a bound Date rather than an ISO literal: the column is
  // `TIMESTAMP(3)` without a zone (as it is in the real schema), so a string carrying `Z` has its
  // offset dropped and the read back would come out shifted by the host's zone. A bound parameter
  // is written and read through the same convention and round-trips exactly.
  for (const id of [SESSION_A, SESSION_B, SESSION_C, COORDINATOR_SESSION]) {
    await client.query(
      `INSERT INTO "session" ("id", "owner_id", "started_at") VALUES ($1, $2, $3)`,
      [id, OWNER, AT]);
  }
}

function vector(over: Partial<ProgressVector> = {}): ProgressVector {
  return { ...EMPTY_PROGRESS_VECTOR, scopeHash: SCOPE, acceptanceTotal: 4, ...over };
}

async function openAttempt(
  client: Client,
  over: {
    taskId?: string;
    attemptKey?: string;
    sessionId?: string;
    hypothesis?: string;
    progressVector?: ProgressVector;
    observedAt?: Date;
  } = {},
) {
  const { attempts } = services(client);
  return attempts.open(OWNER, over.taskId ?? TASK, {
    attemptKey: over.attemptKey ?? 'pc:v1:task:dispatch:1',
    sessionId: over.sessionId ?? SESSION_A,
    hypothesis: over.hypothesis ?? 'try the reducer rewrite',
    progressVector: over.progressVector ?? vector(),
    observedAt: over.observedAt ?? AT,
  });
}

interface AttemptRowDb {
  id: string;
  status: string;
  outcome: string | null;
  attempt_generation: string;
  exhausted_dimension: string | null;
  wind_down_requested_at: Date | null;
  coordinator_steers: number;
  budget: Record<string, number | null>;
  checkpoint_sha: string | null;
  no_checkpoint_reason: string | null;
  inherited_known_good_sha: string | null;
}

async function attemptRow(client: Client, sessionId = SESSION_A): Promise<AttemptRowDb> {
  const result = await client.query(`SELECT * FROM "task_attempt" WHERE "session_id" = $1`, [sessionId]);
  return rows<AttemptRowDb>(result)[0];
}

async function attemptCount(client: Client, taskId = TASK): Promise<number> {
  const result = await client.query(
    `SELECT count(*)::int AS n FROM "task_attempt" WHERE "task_id" = $1`, [taskId]);
  return rows<{ n: number }>(result)[0].n;
}

async function taskRow(client: Client, id = TASK) {
  const result = await client.query(`SELECT * FROM "task" WHERE "id" = $1`, [id]);
  return rows<{ attempt_generation: string; known_good_sha: string | null; scope_revision: number }>(
    result)[0];
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
// AC1: a hard cap per attempt, and a readable remaining.
// -------------------------------------------------------------------------------------------

test('AC1: opening freezes the budget on the row and every dimension reads a remaining', { skip }, async () => {
  const client = await connect();
  try {
    await reset(client);
    const { attempt } = await openAttempt(client);
    assert.deepEqual(attempt.budget, DEFAULT_ATTEMPT_BUDGET);
    assert.equal(attempt.generation, 1);
    assert.equal(attempt.status, 'OPEN');

    const described = await services(client).attempts.describe(OWNER, TASK, AT);
    assert.ok(described.current);
    const readings = described.current.budgetReport.readings;
    assert.equal(readings.length, 6);
    for (const reading of readings) {
      if (reading.dimension === 'CONTEXT') {
        // The runner has not reported a window yet: BD3's unmeasured, not a zero and not infinity.
        assert.equal(reading.state, 'UNMEASURED');
        continue;
      }
      assert.equal(reading.state, 'WITHIN', reading.dimension);
      assert.equal(reading.remaining, reading.limit, reading.dimension);
    }
    // And the ids a caller outside the tenant boundary sees are Base62, not raw UUIDs.
    assert.ok(!/[0-9a-f]{8}-[0-9a-f]{4}-/.test(JSON.stringify(described)));
  } finally {
    await client.end();
  }
});

test('AC1: the spend is measured from the session the attempt actually runs in', { skip }, async () => {
  const client = await connect();
  try {
    await reset(client);
    await openAttempt(client);
    await client.query(`
      UPDATE "session" SET "num_turns" = 12, "cost_usd" = 1.5,
                           "context_tokens" = 90000, "context_window" = 200000
       WHERE "id" = $1`, [SESSION_A]);
    await client.query(
      `INSERT INTO "tool_call" ("id", "session_id")
       SELECT gen_random_uuid(), $1 FROM generate_series(1, 7)`, [SESSION_A]);

    const evaluated = await services(client).attempts.evaluate(
      OWNER, SESSION_A, new Date(AT.getTime() + 600_000));
    assert.ok(evaluated);
    assert.deepEqual(evaluated.spend, {
      turns: 12,
      wallClockMs: 600_000,
      toolCalls: 7,
      costMicros: 1_500_000,
      contextTokens: 90_000,
      contextWindow: 200_000,
      coordinatorSteers: 0,
    });
    const context = evaluated.report.readings.find((r) => r.dimension === 'CONTEXT');
    assert.equal(context?.state, 'WITHIN');
    assert.equal(context?.spent, 45);
    assert.equal(context?.remaining, 35);
    assert.equal(evaluated.report.exhausted, null);
  } finally {
    await client.end();
  }
});

// -------------------------------------------------------------------------------------------
// AC2: the ending is real, and it is not overwritable.
// -------------------------------------------------------------------------------------------

test('AC2: CANCELLED is not an outcome this table can store', { skip }, async () => {
  const client = await connect();
  try {
    await reset(client);
    const { attempt } = await openAttempt(client);
    const message = await refused(() => client.query(
      `UPDATE "task_attempt" SET "status" = 'CLOSED', "outcome" = 'CANCELLED',
                                 "closed_at" = now() WHERE "id" = $1`, [attempt.id]));
    assert.match(message, /task_attempt_outcome_chk/);
    // Nor by inventing a fifth value.
    assert.match(
      await refused(() => client.query(
        `UPDATE "task_attempt" SET "status" = 'CLOSED', "outcome" = 'ABANDONED',
                                   "closed_at" = now() WHERE "id" = $1`, [attempt.id])),
      /task_attempt_outcome_chk/,
    );
    assert.equal((await attemptRow(client)).status, 'OPEN');
  } finally {
    await client.end();
  }
});

test('AC2: a budget stop must leave a checkpoint or say why there is none', { skip }, async () => {
  const client = await connect();
  try {
    await reset(client);
    await openAttempt(client);
    const { attempts } = services(client);
    // The wall clock ran out: the attempt is ASKED to wind down, and nothing is ended.
    const evaluated = await attempts.evaluate(OWNER, SESSION_A, new Date(AT.getTime() + 7_200_000));
    assert.equal(evaluated?.report.exhausted, 'WALL_CLOCK');
    assert.equal(evaluated?.attempt.status, 'WINDING_DOWN');
    assert.equal(evaluated?.attempt.outcome, null, 'a spent budget is not a failure (TH2)');

    // Closing it silently is refused — by the service...
    await assert.rejects(
      () => attempts.close(OWNER, SESSION_A, {
        outcome: 'FAILED', checkpoint: null, noCheckpointReason: null, classification: null,
      }, AT),
      (error: Error) => error.message.includes('ATTEMPT_CHECKPOINT_REQUIRED'),
    );
    // ...and by the database, for a writer that never came through it.
    assert.match(
      await refused(() => client.query(
        `UPDATE "task_attempt" SET "status" = 'CLOSED', "outcome" = 'FAILED', "closed_at" = now()
          WHERE "session_id" = $1`, [SESSION_A])),
      /ATTEMPT_CHECKPOINT_REQUIRED/,
    );

    const closed = await attempts.close(OWNER, SESSION_A, {
      outcome: 'FAILED',
      checkpoint: { sha: 'cafe1234', kind: 'WIP_RED', evidenceDigest: 'suite:red' },
      noCheckpointReason: null,
      classification: 'IN_SCOPE_DEFECT',
    }, AT);
    assert.equal(closed.status, 'CLOSED');
    assert.equal(closed.outcome, 'FAILED');
    assert.equal(closed.checkpointSha, 'cafe1234');
    // A known-RED checkpoint is not a known-good point, so the task's pointer does not move.
    assert.equal((await taskRow(client)).known_good_sha, null);
  } finally {
    await client.end();
  }
});

test('AC2: SUCCEEDED owes an ACCEPTED checkpoint, and it moves the task\'s known-good pointer', { skip }, async () => {
  const client = await connect();
  try {
    await reset(client);
    await openAttempt(client);
    const { attempts } = services(client);
    await assert.rejects(
      () => attempts.close(OWNER, SESSION_A, {
        outcome: 'SUCCEEDED', checkpoint: null, noCheckpointReason: 'trust me', classification: null,
      }, AT),
      (error: Error) => error.message.includes('ATTEMPT_CHECKPOINT_REQUIRED'),
    );
    assert.match(
      await refused(() => client.query(
        `UPDATE "task_attempt" SET "status" = 'CLOSED', "outcome" = 'SUCCEEDED', "closed_at" = now()
          WHERE "session_id" = $1`, [SESSION_A])),
      /ATTEMPT_CHECKPOINT_REQUIRED/,
    );

    await attempts.close(OWNER, SESSION_A, {
      outcome: 'SUCCEEDED',
      checkpoint: { sha: 'good1234', kind: 'ACCEPTED', evidenceDigest: 'suite:green' },
      noCheckpointReason: null,
      classification: null,
    }, AT);
    assert.equal((await taskRow(client)).known_good_sha, 'good1234');
  } finally {
    await client.end();
  }
});

test('AC2: a closed attempt\'s result cannot be rewritten by anybody', { skip }, async () => {
  const client = await connect();
  try {
    await reset(client);
    await openAttempt(client);
    const { attempts } = services(client);
    await attempts.close(OWNER, SESSION_A, {
      outcome: 'FAILED', checkpoint: null, noCheckpointReason: null, classification: 'IN_SCOPE_DEFECT',
    }, AT);

    await assert.rejects(
      () => attempts.close(OWNER, SESSION_A, {
        outcome: 'SUCCEEDED',
        checkpoint: { sha: 'x', kind: 'ACCEPTED', evidenceDigest: null },
        noCheckpointReason: null,
        classification: null,
      }, AT),
      (error: Error) => error.message.includes('ATTEMPT_OUTCOME_IMMUTABLE'),
    );
    assert.match(
      await refused(() => client.query(
        `UPDATE "task_attempt" SET "outcome" = 'SUCCEEDED' WHERE "session_id" = $1`, [SESSION_A])),
      /ATTEMPT_OUTCOME_IMMUTABLE/,
    );
    // Nor by reopening it first and settling it differently on the way back.
    assert.match(
      await refused(() => client.query(
        `UPDATE "task_attempt" SET "status" = 'OPEN', "outcome" = NULL, "closed_at" = NULL
          WHERE "session_id" = $1`, [SESSION_A])),
      /ATTEMPT_OUTCOME_IMMUTABLE/,
    );
    assert.equal((await attemptRow(client)).outcome, 'FAILED');
  } finally {
    await client.end();
  }
});

test('AC2/AU2: another agent session cannot end a live attempt; the worker and the user can', { skip }, async () => {
  const client = await connect();
  try {
    await reset(client);
    await openAttempt(client);
    const { attempts } = services(client);
    await assert.rejects(
      () => attempts.assertMayEndSession(OWNER, SESSION_A, {
        kind: 'AGENT_SESSION', sessionId: COORDINATOR_SESSION,
      }),
      (error: Error) => error.message.includes('ATTEMPT_OUTCOME_IS_THE_WORKERS'),
    );
    await attempts.assertMayEndSession(OWNER, SESSION_A, {
      kind: 'AGENT_SESSION', sessionId: SESSION_A,
    });
    await attempts.assertMayEndSession(OWNER, SESSION_A, { kind: 'USER' });
    // A session that is not an attempt at all is not affected — which is every session today.
    await attempts.assertMayEndSession(OWNER, SESSION_B, {
      kind: 'AGENT_SESSION', sessionId: COORDINATOR_SESSION,
    });
  } finally {
    await client.end();
  }
});

test('AU3: steering a live attempt is bounded, and refused outright once it is winding down', { skip }, async () => {
  const client = await connect();
  try {
    await reset(client);
    await openAttempt(client);
    const { attempts } = services(client);
    const coordinator = { kind: 'AGENT_SESSION' as const, sessionId: COORDINATOR_SESSION };

    for (let i = 0; i < 3; i++) await attempts.chargeSteer(OWNER, SESSION_A, coordinator);
    assert.equal((await attemptRow(client)).coordinator_steers, 3);
    await assert.rejects(
      () => attempts.chargeSteer(OWNER, SESSION_A, coordinator),
      (error: Error) => error.message.includes('ATTEMPT_STEER_BUDGET_EXHAUSTED'),
    );
    assert.equal((await attemptRow(client)).coordinator_steers, 3, 'a refused steer still charged');

    // The worker steering itself, and a person, are never charged (AU1).
    await attempts.chargeSteer(OWNER, SESSION_A, { kind: 'AGENT_SESSION', sessionId: SESSION_A });
    await attempts.chargeSteer(OWNER, SESSION_A, { kind: 'USER' });
    assert.equal((await attemptRow(client)).coordinator_steers, 3);

    // Once the worker is winding down, the refusal changes: the outcome is being written.
    await client.query(
      `UPDATE "task_attempt" SET "coordinator_steers" = 0 WHERE "session_id" = $1`, [SESSION_A])
      .catch(() => undefined);
    await attempts.evaluate(OWNER, SESSION_A, new Date(AT.getTime() + 7_200_000));
    await assert.rejects(
      () => attempts.chargeSteer(OWNER, SESSION_A, coordinator),
      (error: Error) => error.message.includes('ATTEMPT_WINDING_DOWN'),
    );
  } finally {
    await client.end();
  }
});

test('RL3: the steer counter never walks backwards', { skip }, async () => {
  const client = await connect();
  try {
    await reset(client);
    await openAttempt(client);
    const { attempts } = services(client);
    await attempts.chargeSteer(OWNER, SESSION_A, {
      kind: 'AGENT_SESSION', sessionId: COORDINATOR_SESSION,
    });
    assert.match(
      await refused(() => client.query(
        `UPDATE "task_attempt" SET "coordinator_steers" = 0 WHERE "session_id" = $1`, [SESSION_A])),
      /ATTEMPT_STEERS_MONOTONIC/,
    );
  } finally {
    await client.end();
  }
});

// -------------------------------------------------------------------------------------------
// AC3: a fresh generation inherits the evidence, not the context.
// -------------------------------------------------------------------------------------------

test('AC3: the next generation carries task, scope and known-good — and cannot reuse the session', { skip }, async () => {
  const client = await connect();
  try {
    await reset(client);
    await openAttempt(client);
    const { attempts } = services(client);
    await attempts.close(OWNER, SESSION_A, {
      outcome: 'FAILED',
      checkpoint: { sha: 'known1234', kind: 'ACCEPTED', evidenceDigest: 'suite:green' },
      noCheckpointReason: null,
      classification: 'IN_SCOPE_DEFECT',
    }, AT);

    const next = await attempts.open(OWNER, TASK, {
      attemptKey: 'pc:v1:task:dispatch:2',
      sessionId: SESSION_B,
      hypothesis: 'bisect the regression instead',
      progressVector: vector({ knownGoodSha: 'known1234' }),
      observedAt: AT,
    });
    assert.equal(next.attempt.generation, 2);
    assert.equal(next.seed.inheritedKnownGoodSha, 'known1234');
    assert.equal(next.seed.scopeRevision, 1);
    assert.equal(next.seed.scopeHash, SCOPE);
    assert.deepEqual(next.seed.previousOutcome, {
      attemptGeneration: 1,
      outcome: 'FAILED',
      exhaustedDimension: null,
      classification: 'IN_SCOPE_DEFECT',
    });
    // Nothing unbounded rode along: the seed is six scalars and a four-field summary.
    assert.ok(JSON.stringify(next.seed).length < 4_096);

    // "Fresh generation" spelled as a resume of the previous session is refused outright.
    assert.match(
      await refused(() => attempts.open(OWNER, TASK, {
        attemptKey: 'pc:v1:task:dispatch:3',
        sessionId: SESSION_A,
        hypothesis: 'a third idea',
        progressVector: vector(),
        observedAt: AT,
      })),
      /ATTEMPT_ALREADY_OPEN|task_attempt_session_key|task_attempt_one_open_key/,
    );
  } finally {
    await client.end();
  }
});

// -------------------------------------------------------------------------------------------
// AC4: one generation is started once.
// -------------------------------------------------------------------------------------------

test('AC4: a redelivered dispatch reads back its own attempt and advances nothing', { skip }, async () => {
  const client = await connect();
  try {
    await reset(client);
    const first = await openAttempt(client);
    const replay = await openAttempt(client);
    assert.equal(replay.reused, true);
    assert.equal(replay.attempt.id, first.attempt.id);
    assert.equal(replay.attempt.generation, 1);
    assert.equal(await attemptCount(client), 1);
    assert.equal((await taskRow(client)).attempt_generation, '1');

    // The ledger agrees: one ATTEMPT_STARTED, not two.
    const started = rows<{ n: number }>(await client.query(
      `SELECT count(*)::int AS n FROM "task_convergence_decision"
        WHERE "task_id" = $1 AND "event" = 'ATTEMPT_STARTED'`, [TASK]))[0].n;
    assert.equal(started, 1);
    const recovered = await services(client).ledger.recover(OWNER, TASK);
    assert.equal(recovered.consistent, true);
  } finally {
    await client.end();
  }
});

test('AC4: a raw writer cannot start the same generation twice, nor two at once', { skip }, async () => {
  const client = await connect();
  try {
    await reset(client);
    const { attempt } = await openAttempt(client);
    const insert = (id: string, session: string, generation: number, hypothesis: string) => client.query(
      `INSERT INTO "task_attempt" (
         "id","task_id","owner_id","session_id","scope_revision","scope_hash","attempt_generation",
         "attempt_key","hypothesis","hypothesis_digest","budget","updated_at")
       VALUES ($1,$2,$3,$4,1,$5,$6,$7,$8,$9,$10::jsonb,now())`,
      [id, TASK, OWNER, session, SCOPE, generation, `raw:${id}`, hypothesis,
        hypothesisDigest(hypothesis), JSON.stringify(DEFAULT_ATTEMPT_BUDGET)]);

    // The same generation again: the unique key, before anything else gets a chance to be wrong.
    assert.match(
      await refused(() => insert('00000000-0000-7000-8000-0000000030f1', SESSION_B, 1, 'another idea')),
      /task_attempt_generation_key|task_attempt_one_open_key/,
    );
    // A generation the task never allocated: the fence, which is what forces the ledger route.
    assert.match(
      await refused(() => insert('00000000-0000-7000-8000-0000000030f2', SESSION_B, 2, 'another idea')),
      /STALE_ATTEMPT_GENERATION|task_attempt_one_open_key/,
    );
    assert.equal(await attemptCount(client), 1);
    assert.equal(attempt.generation, 1);
  } finally {
    await client.end();
  }
});

test('AC4/AT3: the same hypothesis is not attempted twice, unless the last one was TRANSIENT', { skip }, async () => {
  const client = await connect();
  try {
    await reset(client);
    const { attempts } = services(client);
    await openAttempt(client);
    await attempts.close(OWNER, SESSION_A, {
      outcome: 'FAILED', checkpoint: null, noCheckpointReason: null, classification: 'IN_SCOPE_DEFECT',
    }, AT);

    await assert.rejects(
      () => attempts.open(OWNER, TASK, {
        attemptKey: 'pc:v1:task:dispatch:2',
        sessionId: SESSION_B,
        // Reformatted, not rethought.
        hypothesis: '  Try   the REDUCER rewrite ',
        progressVector: vector(),
        observedAt: AT,
      }),
      (error: Error) => error.message.includes('ATTEMPT_HYPOTHESIS_UNCHANGED'),
    );
    // And the database refuses it for a writer that skipped the service. The task's generation is
    // advanced first so the insert is otherwise LEGAL — generation 2, its own session, its own key.
    // Without that the unique index would refuse it for an unrelated reason and this would assert
    // nothing about the hypothesis gate at all.
    await client.query(`UPDATE "task" SET "attempt_generation" = 2 WHERE "id" = $1`, [TASK]);
    assert.match(
      await refused(() => client.query(
        `INSERT INTO "task_attempt" (
           "id","task_id","owner_id","session_id","scope_revision","scope_hash","attempt_generation",
           "attempt_key","hypothesis","hypothesis_digest","budget","updated_at")
         VALUES ($1,$2,$3,$4,1,$5,2,'raw:same',$6,$7,$8::jsonb,now())`,
        ['00000000-0000-7000-8000-0000000030f3', TASK, OWNER, SESSION_B, SCOPE,
          'try the reducer rewrite', hypothesisDigest('try the reducer rewrite'),
          JSON.stringify(DEFAULT_ATTEMPT_BUDGET)])),
      /ATTEMPT_HYPOTHESIS_UNCHANGED/,
    );
    // The same insert with a DIFFERENT hypothesis is accepted, so the refusal above is the gate
    // rather than anything else about the row.
    await client.query(
      `INSERT INTO "task_attempt" (
         "id","task_id","owner_id","session_id","scope_revision","scope_hash","attempt_generation",
         "attempt_key","hypothesis","hypothesis_digest","budget","updated_at")
       VALUES ($1,$2,$3,$4,1,$5,2,'raw:different',$6,$7,$8::jsonb,now())`,
      ['00000000-0000-7000-8000-0000000030f4', TASK, OWNER, SESSION_B, SCOPE,
        'bisect the regression', hypothesisDigest('bisect the regression'),
        JSON.stringify(DEFAULT_ATTEMPT_BUDGET)]);

    // A transient interruption may retry the same idea — §3 CL2 bounds how often that works.
    // A fresh fixture, because the attempt above is CLOSED and its classification is part of the
    // result: editing it after the fact is exactly what `ATTEMPT_OUTCOME_IMMUTABLE` refuses.
    await reset(client);
    const fresh = services(client).attempts;
    await openAttempt(client);
    await fresh.close(OWNER, SESSION_A, {
      outcome: 'INTERRUPTED', checkpoint: null, noCheckpointReason: null, classification: 'TRANSIENT',
    }, AT);
    const retry = await fresh.open(OWNER, TASK, {
      attemptKey: 'pc:v1:task:dispatch:2',
      sessionId: SESSION_B,
      hypothesis: 'try the reducer rewrite',
      progressVector: vector(),
      observedAt: AT,
    });
    assert.equal(retry.attempt.generation, 2);
  } finally {
    await client.end();
  }
});

// -------------------------------------------------------------------------------------------
// AC5: crashes, timeouts, and a person raising the budget.
// -------------------------------------------------------------------------------------------

test('AC5: a runner crash closes as INTERRUPTED and records that there is no checkpoint', { skip }, async () => {
  const client = await connect();
  try {
    await reset(client);
    await openAttempt(client);
    const { attempts } = services(client);

    // A LIVE session is left alone: the reconciler does not conclude anything about work that has
    // not stopped.
    assert.equal(await attempts.reconcileAbandoned(OWNER, SESSION_A, 'runner offline', AT), null);
    assert.equal((await attemptRow(client)).status, 'OPEN');

    await client.query(`UPDATE "session" SET "status" = 'FAILED' WHERE "id" = $1`, [SESSION_A]);
    const closed = await attempts.reconcileAbandoned(
      OWNER, SESSION_A, 'the runner went offline mid-turn; nothing was committed', AT);
    assert.equal(closed?.outcome, 'INTERRUPTED');
    assert.equal(closed?.checkpointSha, null);
    assert.match(closed?.noCheckpointReason ?? '', /runner went offline/);
    // Not FAILED: "the work failed" is a conclusion this reconciler was not there for.
    assert.notEqual(closed?.outcome, 'FAILED');
    assert.equal((await taskRow(client)).known_good_sha, null);
  } finally {
    await client.end();
  }
});

test('AC5: a coordinator crash before commit leaves nothing, and the replay opens generation 1', { skip }, async () => {
  const client = await connect();
  try {
    await reset(client);
    // The crash: the whole open rolls back, ledger row and attempt row together.
    await client.query('BEGIN');
    const tx = transactionClient(client);
    const ledger = new ConvergenceLedgerService(prisma(client));
    await ledger.record(tx, TASK, OWNER, {
      observationKey: 'attempt:pc:v1:task:dispatch:1',
      event: 'ATTEMPT_STARTED',
      classification: null,
      failure: null,
      progressVector: vector(),
      observedAt: AT,
      decidedBy: 'ORCHESTRATOR',
      action: null,
      sessionId: SESSION_A,
    });
    await client.query('ROLLBACK');

    assert.equal(await attemptCount(client), 0);
    assert.equal((await taskRow(client)).attempt_generation, '0');

    const replay = await openAttempt(client);
    assert.equal(replay.reused, false);
    assert.equal(replay.attempt.generation, 1, 'the crash burned a generation');
    assert.equal(await attemptCount(client), 1);
  } finally {
    await client.end();
  }
});

test('AC5: a coordinator crash AFTER commit replays onto the row it already wrote', { skip }, async () => {
  const client = await connect();
  try {
    await reset(client);
    const first = await openAttempt(client);
    // A different process, a different object, the same durable dispatch identity.
    const takeover = services(client).attempts;
    const replay = await takeover.open(OWNER, TASK, {
      attemptKey: 'pc:v1:task:dispatch:1',
      sessionId: SESSION_B,
      hypothesis: 'a completely different idea',
      progressVector: vector(),
      observedAt: new Date(AT.getTime() + 60_000),
    });
    assert.equal(replay.reused, true);
    assert.equal(replay.attempt.id, first.attempt.id);
    assert.equal(replay.attempt.sessionId, first.attempt.sessionId, 'the replay re-pointed the attempt');
    assert.equal((await taskRow(client)).attempt_generation, '1');
    assert.equal(await attemptCount(client), 1);
  } finally {
    await client.end();
  }
});

test('AC5: a timeout asks for a wind-down once, and the first line crossed is the one recorded', { skip }, async () => {
  const client = await connect();
  try {
    await reset(client);
    await openAttempt(client);
    const { attempts } = services(client);
    const late = new Date(AT.getTime() + 7_200_000);
    const first = await attempts.evaluate(OWNER, SESSION_A, late);
    assert.equal(first?.attempt.status, 'WINDING_DOWN');
    assert.equal(first?.attempt.exhaustedDimension, 'WALL_CLOCK');
    assert.deepEqual(first?.attempt.windDownRequestedAt, late);

    // Later the turns run out too. The recorded dimension does not move: which line was crossed
    // FIRST is a fact about what happened, and a second pass reads a world the wind-down changed.
    await client.query(`UPDATE "session" SET "num_turns" = 999 WHERE "id" = $1`, [SESSION_A]);
    const again = await attempts.evaluate(OWNER, SESSION_A, new Date(late.getTime() + 60_000));
    assert.equal(again?.attempt.exhaustedDimension, 'WALL_CLOCK');
    assert.deepEqual(again?.attempt.windDownRequestedAt, late);

    // And a wind-down cannot be un-asked, which is how "we extended the budget" would otherwise
    // be spelled.
    assert.match(
      await refused(() => client.query(
        `UPDATE "task_attempt" SET "wind_down_requested_at" = NULL, "status" = 'OPEN'
          WHERE "session_id" = $1`, [SESSION_A])),
      /ATTEMPT_WIND_DOWN_IRREVOCABLE|ATTEMPT_STATUS_MONOTONIC/,
    );
  } finally {
    await client.end();
  }
});

test('AC5/GN3: raising the budget does not revive the stopped attempt — it funds the next one', { skip }, async () => {
  const client = await connect();
  try {
    await reset(client);
    await openAttempt(client);
    const { attempts } = services(client);
    const late = new Date(AT.getTime() + 7_200_000);
    await attempts.evaluate(OWNER, SESSION_A, late);
    assert.equal((await attemptRow(client)).status, 'WINDING_DOWN');

    // A person raises the wall-clock budget, with their name on it (OW4).
    await client.query(`
      UPDATE "project"
         SET "attempt_budget" = '{"maxWallClockMs": 86400000}'::jsonb,
             "unbounded_authorized_by" = '{"actor":"USER","principal":"wikova"}'::jsonb
       WHERE "id" = $1`, [PROJECT]);

    // The attempt in flight is judged by the budget it was OPENED against and stays stopped.
    const after = await attempts.evaluate(OWNER, SESSION_A, new Date(late.getTime() + 1_000));
    assert.equal(after?.attempt.status, 'WINDING_DOWN');
    assert.equal(after?.attempt.budget.maxWallClockMs, DEFAULT_ATTEMPT_BUDGET.maxWallClockMs);
    assert.equal(after?.report.exhausted, 'WALL_CLOCK');
    // Nor can the frozen copy be edited into agreement afterwards.
    assert.match(
      await refused(() => client.query(
        `UPDATE "task_attempt" SET "budget" = '{"maxTurns":9999,"maxWallClockMs":null,
          "maxToolCalls":9999,"maxCostMicros":9999,"maxContextPercent":99,
          "maxCoordinatorSteers":99}'::jsonb WHERE "session_id" = $1`, [SESSION_A])),
      /ATTEMPT_BUDGET_FROZEN/,
    );

    // The extension's legal effect: the NEXT generation is funded by it (SM4's BUDGET_EXTENDED).
    await attempts.close(OWNER, SESSION_A, {
      outcome: 'INTERRUPTED',
      checkpoint: null,
      noCheckpointReason: 'wall clock spent; work in progress was not committed',
      classification: null,
    }, late);
    const next = await attempts.open(OWNER, TASK, {
      attemptKey: 'pc:v1:task:dispatch:2',
      sessionId: SESSION_B,
      hypothesis: 'split the migration into two passes',
      progressVector: vector(),
      observedAt: late,
    });
    assert.equal(next.attempt.budget.maxWallClockMs, 86_400_000);
    assert.equal(next.attempt.generation, 2);
  } finally {
    await client.end();
  }
});

test('the budget column must carry all six dimensions, each finite or explicitly unbounded', { skip }, async () => {
  const client = await connect();
  try {
    await reset(client);
    // The fence and the composite foreign key are checked before the CHECK gets a chance to be the
    // interesting failure, so the task is put where a generation-1 attempt is legal first.
    await client.query(`INSERT INTO "task_scope_revision"
      ("id","task_id","owner_id","revision","scope_hash","title","description","acceptance_criteria","reason")
      VALUES (gen_random_uuid(), $1, $2, 1, $3, 'T', NULL, 'AC', 'fixture')`, [TASK, OWNER, SCOPE]);
    await client.query(`UPDATE "task" SET "attempt_generation" = 1 WHERE "id" = $1`, [TASK]);
    const insert = (budget: string) => client.query(
      `INSERT INTO "task_attempt" (
         "id","task_id","owner_id","session_id","scope_revision","scope_hash","attempt_generation",
         "attempt_key","hypothesis","hypothesis_digest","budget","updated_at")
       VALUES (gen_random_uuid(),$1,$2,$3,1,$4,1,'raw:budget','h',
               repeat('d', 64),$5::jsonb,now())`,
      [TASK, OWNER, SESSION_C, SCOPE, budget]);
    // A missing key would read as NULL through `->>` and as unbounded through a careless coalesce.
    assert.match(await refused(() => insert('{"maxTurns": 10}')), /task_attempt_budget_chk/);
    assert.match(
      await refused(() => insert(JSON.stringify({ ...DEFAULT_ATTEMPT_BUDGET, maxTurns: 0 }))),
      /task_attempt_budget_chk/,
    );
    assert.match(
      await refused(() => insert(JSON.stringify({ ...DEFAULT_ATTEMPT_BUDGET, maxTurns: -1 }))),
      /task_attempt_budget_chk/,
    );
    // An explicit null IS storable — that is OW4's authorized unbounded, and the project-level
    // CHECK from 0138 is what stops one being written without a USER's signature.
    await insert(JSON.stringify({ ...DEFAULT_ATTEMPT_BUDGET, maxTurns: null }));
    assert.equal(await attemptCount(client), 1);
  } finally {
    await client.end();
  }
});

test('the tenancy fence holds: an attempt cannot name another owner\'s task', { skip }, async () => {
  const client = await connect();
  try {
    await reset(client);
    // Before any attempt exists, so the FK is the refusal rather than the generation unique key.
    await client.query(`INSERT INTO "task_scope_revision"
      ("id","task_id","owner_id","revision","scope_hash","title","description","acceptance_criteria","reason")
      VALUES (gen_random_uuid(), $1, $2, 1, $3, 'T', NULL, 'AC', 'fixture')`, [TASK, OWNER, SCOPE]);
    await client.query(`UPDATE "task" SET "attempt_generation" = 1 WHERE "id" = $1`, [TASK]);
    assert.match(
      await refused(() => client.query(
        `INSERT INTO "task_attempt" (
           "id","task_id","owner_id","session_id","scope_revision","scope_hash","attempt_generation",
           "attempt_key","hypothesis","hypothesis_digest","budget","updated_at")
         VALUES (gen_random_uuid(),$1,$2,$3,1,$4,1,'raw:tenant','h',
                 repeat('d', 64),$5::jsonb,now())`,
        [TASK, '00000000-0000-7000-8000-0000000039ff', SESSION_B, SCOPE,
          JSON.stringify(DEFAULT_ATTEMPT_BUDGET)])),
      /task_attempt_task_id_owner_id_fkey/,
    );

    // And another owner cannot read or steer a real one.
    await reset(client);
    await openAttempt(client);
    const { attempts } = services(client);
    assert.equal(
      await attempts.evaluate('00000000-0000-7000-8000-0000000039ff', SESSION_A, AT),
      null,
    );
  } finally {
    await client.end();
  }
});
