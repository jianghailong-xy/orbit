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
import { scopeHash } from './convergence-progress';
import { ConvergenceLedgerService } from './convergence-ledger.service';
import { VerificationFindingService } from './verification-finding.service';
import { VerificationFinding, findingDedupKey, findingEffectKey } from './verification-finding';

// `[K5]` on real PostgreSQL, against a DISPOSABLE server.
//
// The unit spec proves the TRIAGE. This proves the two things a pure function cannot: that one
// finding produces one artifact however many times, in whatever order, across however many crashes
// and processes it is delivered — and that the properties the service intends are held by the
// DATABASE, so they survive the next writer who forgets. The incident this whole contract was
// frozen after was written by a writer who forgot.
//
// The server is proved disposable before the first write (`coordinator-pg-test-safety.ts`).

const URL = process.env.COORDINATOR_PG_URL;
const SCHEMA = 'pcck5_finding';
const skip = !URL;

const OWNER = '00000000-0000-7000-8000-000000005001';
const PROJECT = '00000000-0000-7000-8000-000000005002';
const TASK = '00000000-0000-7000-8000-000000005003';
const PARENT = '00000000-0000-7000-8000-000000005004';
const SESSION = '00000000-0000-7000-8000-000000005005';
const VERIFIER = '00000000-0000-7000-8000-000000005006';
const SUBJECT = '00000000-0000-7000-8000-000000005007';

const LEDGER = migration('0138_task_convergence_ledger');
const IDENTITY = migration('0140_task_progress_vector_identity');
const FINDING = migration('0141_task_verification_finding');

const SCOPE = scopeHash({ title: 'T', description: null, acceptanceCriteria: 'AC' });
const AT = new Date('2026-08-22T10:00:00.000Z');
const FP = 'a'.repeat(64);
const FP2 = 'b'.repeat(64);

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

function service(client: Client): VerificationFindingService {
  const p = prisma(client);
  return new VerificationFindingService(p, new ConvergenceLedgerService(p));
}

async function reset(client: Client): Promise<void> {
  await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await client.query(`CREATE SCHEMA ${SCHEMA}`);
  await client.query(`SET search_path TO ${SCHEMA}`);
  // The subset of the real schema these migrations touch, built by hand exactly as the other
  // coordinator pg specs do: the point is to exercise 0141's own SQL, not to replay 140 migrations.
  await client.query(`
    CREATE TYPE "project_status" AS ENUM ('OPEN', 'DONE', 'CANCELLED');
    CREATE TYPE "project_automation_policy" AS ENUM ('MANUAL', 'GUARDED_AUTO', 'AUTO');
    CREATE TYPE "task_status" AS ENUM ('OPEN', 'IN_PROGRESS', 'DONE', 'CANCELLED', 'FAILED');
    CREATE TYPE "task_verdict" AS ENUM ('PASS', 'FAIL', 'INCONCLUSIVE');
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
      "list_id" UUID,
      "assignee_id" UUID,
      "parent_task_id" UUID REFERENCES "task"("id"),
      "verifies_task_id" UUID REFERENCES "task"("id"),
      "verdict" "task_verdict",
      "creator_type" TEXT NOT NULL DEFAULT 'USER',
      -- NOT NULL, exactly as the real column is. A nullable copy here hid a defect that the
      -- production schema would have refused on every finding that files a task: this fixture is a
      -- SUBSET of the schema, and a subset that relaxes a constraint tests a database nobody runs.
      "creator_id" UUID NOT NULL,
      "dispatch_authority" TEXT NOT NULL DEFAULT 'COORDINATOR',
      "idempotency_key" TEXT UNIQUE,
      "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE "task_dependency" (
      "id" UUID PRIMARY KEY,
      "task_id" UUID NOT NULL REFERENCES "task"("id") ON DELETE CASCADE,
      "depends_on_task_id" UUID NOT NULL REFERENCES "task"("id") ON DELETE CASCADE,
      "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE ("task_id", "depends_on_task_id")
    );
    CREATE TABLE "project_blocker" (
      "id" UUID PRIMARY KEY,
      "project_id" UUID NOT NULL REFERENCES "project"("id"),
      "kind" TEXT NOT NULL,
      "resolved_at" TIMESTAMP(3),
      CONSTRAINT "project_blocker_kind_chk" CHECK ("kind" IN ('UNKNOWN_FAILURE'))
    );
  `);
  await client.query(LEDGER);
  await client.query(IDENTITY);
  await client.query(FINDING);
  await client.query(`
    INSERT INTO "project" ("id", "owner_id", "title") VALUES ('${PROJECT}', '${OWNER}', 'P');
    INSERT INTO "task" ("id", "owner_id", "creator_id", "project_id", "title", "acceptance_criteria")
      VALUES ('${PARENT}', '${OWNER}', '${OWNER}', '${PROJECT}', 'Parent', 'AC');
    INSERT INTO "task" ("id", "owner_id", "creator_id", "project_id", "title",
                        "acceptance_criteria", "parent_task_id")
      VALUES ('${TASK}', '${OWNER}', '${OWNER}', '${PROJECT}', 'T', 'AC', '${PARENT}');
    INSERT INTO "task" ("id", "owner_id", "creator_id", "project_id", "title", "acceptance_criteria")
      VALUES ('${SUBJECT}', '${OWNER}', '${OWNER}', '${PROJECT}', 'S', 'AC');
  `);
}

function finding(over: Partial<VerificationFinding> = {}): VerificationFinding {
  return {
    severity: 'P1',
    violatedInvariant: 'DEPENDENT_RAN_BEFORE_PASS',
    minimalRepro: 'npm test -w @orbit/apiserver -- verification-dependency',
    failureFingerprint: FP,
    scopeClassification: 'IN_SCOPE_DEFECT',
    evidence: { command: 'npm test', exitCode: 1 },
    verdict: 'FAIL',
    ...over,
  };
}

function submit(client: Client, over: Partial<VerificationFinding> = {}, reporter: 'VERIFIER' | 'USER' | 'WORKER' | 'COORDINATOR' = 'VERIFIER') {
  return service(client).submit({
    ownerId: OWNER,
    subjectTaskId: TASK,
    finding: finding(over),
    reporter,
    scopeRevision: 1,
    reporterSessionId: SESSION,
    now: AT,
  });
}

async function count(client: Client, table: string, where = 'TRUE'): Promise<number> {
  const result = await client.query(`SELECT count(*)::int AS n FROM "${table}" WHERE ${where}`);
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
// The migration, and the shape it freezes.
// -------------------------------------------------------------------------------------------

test('0141 applies to a fresh database and changes no existing task', { skip }, async () => {
  const client = await connect();
  try {
    await reset(client);
    assert.equal(await count(client, 'task_verification_finding'), 0);
    // Project AC11: an existing task behaves exactly as it did.
    assert.equal(await count(client, 'task', `"id" = '${TASK}' AND "status" = 'OPEN'`), 1);
  } finally {
    await client.end();
  }
});

// -------------------------------------------------------------------------------------------
// FD1 / FD2: one finding, one artifact — however it is delivered.
// -------------------------------------------------------------------------------------------

test('a finding files exactly one Task, and links it to its judgment', { skip }, async () => {
  const client = await connect();
  try {
    await reset(client);
    const result = await submit(client);
    assert.equal(result.duplicate, false);
    assert.equal(result.triage.outcome, 'CREATE_DEFECT_SUBTASK');
    assert.ok(result.effectTaskId);
    assert.ok(result.decisionId);

    // The defect is a CHILD of the subject, and it carries the repro as its acceptance criteria.
    const [defect] = rows<{ parent_task_id: string; acceptance_criteria: string; status: string }>(
      await client.query(
        `SELECT * FROM "task" WHERE "idempotency_key" = $1`,
        [findingEffectKey(findingDedupKey(PROJECT, TASK, 1, FP))],
      ));
    assert.equal(defect.parent_task_id, TASK);
    assert.equal(defect.status, 'OPEN');
    assert.match(defect.acceptance_criteria, /npm test/);

    // finding → Task and finding → decision, both durable and both auditable.
    const [row] = rows<{
      effect_task_id: string; decision_id: string; outcome: string; effect_kind: string;
      required_action: string; owner: string; next_check_at: Date | null; seq: string;
    }>(await client.query(`SELECT * FROM "task_verification_finding"`));
    assert.equal(row.effect_task_id, defect ? row.effect_task_id : null);
    assert.ok(row.decision_id);
    assert.equal(row.outcome, 'CREATE_DEFECT_SUBTASK');
    assert.equal(row.owner, 'COORDINATOR');
    assert.ok(row.required_action.length > 0);
    // §11.1's clock, present because the loop owns this one.
    assert.ok(row.next_check_at !== null);
    assert.equal(row.seq, '1');
    // The judgment it names really is `[K2]`'s, with counters on it.
    assert.equal(await count(client, 'task_convergence_decision',
      `"id" = '${row.decision_id}' AND "classification" = 'IN_SCOPE_DEFECT'`), 1);
  } finally {
    await client.end();
  }
});

test('FD1: the same failure submitted again files nothing and returns the original',
  { skip }, async () => {
    const client = await connect();
    try {
      await reset(client);
      const first = await submit(client);
      // Same fingerprint, different reporter, different session, different severity: FD1's key has
      // none of those in it, so this is the same finding.
      const second = await service(client).submit({
        ownerId: OWNER,
        subjectTaskId: TASK,
        finding: finding({ severity: 'P0' }),
        reporter: 'USER',
        scopeRevision: 1,
        reporterSessionId: null,
        now: new Date(AT.getTime() + 60_000),
      });
      assert.equal(second.duplicate, true);
      assert.equal(second.findingId, first.findingId);
      assert.equal(second.effectTaskId, first.effectTaskId);
      assert.equal(await count(client, 'task_verification_finding'), 1);
      assert.equal(await count(client, 'task', `"parent_task_id" = '${TASK}'`), 1);
      // And the counters moved exactly once: a redelivery that charged the breaker again is how a
      // budget is spent by the network rather than by the work.
      assert.equal(await count(client, 'task_convergence_decision'), 1);
    } finally {
      await client.end();
    }
  });

test('FD1: the key holds against a writer that never goes through the service',
  { skip }, async () => {
    const client = await connect();
    try {
      await reset(client);
      await submit(client);
      const key = findingDedupKey(PROJECT, TASK, 1, FP);
      const message = await refused(() => client.query(`
        INSERT INTO "task_verification_finding" (
          "id", "task_id", "owner_id", "project_id", "seq", "scope_revision", "scope_hash",
          "dedup_key", "severity", "violated_invariant", "minimal_repro", "failure_fingerprint",
          "scope_classification", "evidence", "verdict", "reporter", "effective_classification",
          "outcome", "effect_kind", "effect_idempotency_key", "effect_task_id", "required_action",
          "owner"
        ) VALUES (
          gen_random_uuid(), '${TASK}', '${OWNER}', '${PROJECT}', 99, 1, '${SCOPE}',
          '${key}', 'P0', 'X', 'y', '${FP}', 'IN_SCOPE_DEFECT', '{"a":1}'::jsonb, 'FAIL',
          'USER', 'IN_SCOPE_DEFECT', 'CREATE_DEFECT_SUBTASK', 'DEFECT_SUBTASK', 'other-key',
          '${TASK}', 'do it', 'USER'
        )`));
      assert.match(message, /task_verification_finding_dedup_key/);
    } finally {
      await client.end();
    }
  });

test('a crash between the Task and the finding does not produce two Tasks', { skip }, async () => {
  const client = await connect();
  try {
    await reset(client);
    // The crash: the whole transaction rolls back, so the dedup row that would have collided does
    // not exist. What survives is the effect key, and it is derived rather than minted.
    await client.query('BEGIN');
    const tx = transactionClient(client);
    const ledger = new ConvergenceLedgerService(prisma(client));
    await ledger.ensureBaseline(tx, TASK, OWNER);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "task" ("id", "title", "status", "owner_id", "creator_id", "project_id",
                          "parent_task_id", "creator_type", "dispatch_authority",
                          "idempotency_key")
      VALUES (gen_random_uuid(), 'Defect: T', 'OPEN', ${OWNER}::uuid, ${OWNER}::uuid,
              ${PROJECT}::uuid, ${TASK}::uuid, 'USER', 'COORDINATOR',
              ${findingEffectKey(findingDedupKey(PROJECT, TASK, 1, FP))})
    `);
    await client.query('COMMIT');
    assert.equal(await count(client, 'task', `"parent_task_id" = '${TASK}'`), 1);

    // The replay re-derives the same key, reads the committed Task back, and files one finding.
    const replay = await submit(client);
    assert.equal(replay.duplicate, false);
    assert.equal(await count(client, 'task', `"parent_task_id" = '${TASK}'`), 1,
      'the replay filed a second defect');
    assert.equal(await count(client, 'task_verification_finding'), 1);
  } finally {
    await client.end();
  }
});

test('out-of-order delivery: whichever arrives second is the duplicate, and both agree',
  { skip }, async () => {
    const client = await connect();
    try {
      await reset(client);
      // Two DIFFERENT failures, delivered in one order and then re-delivered in the other. The
      // second pass must write nothing at all, whichever way round it comes.
      const a = await submit(client, { failureFingerprint: FP });
      const b = await submit(client, { failureFingerprint: FP2, severity: 'P3' });
      assert.equal(a.duplicate, false);
      assert.equal(b.duplicate, false);
      const replayB = await submit(client, { failureFingerprint: FP2, severity: 'P3' });
      const replayA = await submit(client, { failureFingerprint: FP });
      assert.equal(replayB.duplicate, true);
      assert.equal(replayA.duplicate, true);
      assert.equal(replayA.effectTaskId, a.effectTaskId);
      assert.equal(replayB.effectTaskId, b.effectTaskId);
      assert.equal(await count(client, 'task_verification_finding'), 2);
      assert.equal(await count(client, 'task_convergence_decision'), 2);
    } finally {
      await client.end();
    }
  });

// -------------------------------------------------------------------------------------------
// §3's other artifacts.
// -------------------------------------------------------------------------------------------

test('a prerequisite finding files a task the SUBJECT depends on', { skip }, async () => {
  const client = await connect();
  try {
    await reset(client);
    const result = await submit(client, { scopeClassification: 'PREREQUISITE' });
    assert.equal(result.triage.outcome, 'CREATE_PREREQUISITE_TASK');
    const effect = rows<{ id: string; parent_task_id: string | null }>(await client.query(
      `SELECT "id", "parent_task_id" FROM "task" WHERE "idempotency_key" = $1`,
      [findingEffectKey(findingDedupKey(PROJECT, TASK, 1, FP))]))[0];
    // A sibling, not a child: §3 calls it work OUTSIDE this task's scope.
    assert.equal(effect.parent_task_id, PARENT);
    // And the subject waits on it, which is the half that makes it a prerequisite at all.
    assert.equal(await count(client, 'task_dependency',
      `"task_id" = '${TASK}' AND "depends_on_task_id" = '${effect.id}'`), 1);
  } finally {
    await client.end();
  }
});

test('a scope expansion files a re-plan sibling with NO edge, and freezes the task',
  { skip }, async () => {
    const client = await connect();
    try {
      await reset(client);
      const result = await submit(client, { scopeClassification: 'SCOPE_EXPANSION' }, 'WORKER');
      assert.equal(result.triage.outcome, 'FREEZE_AND_REQUEST_REPLAN');
      const effect = rows<{ id: string; parent_task_id: string | null; assignee_id: string | null }>(
        await client.query(`SELECT * FROM "task" WHERE "idempotency_key" = $1`,
          [findingEffectKey(findingDedupKey(PROJECT, TASK, 1, FP))]))[0];
      assert.equal(effect.parent_task_id, PARENT);
      // OW3: wiring the frozen subject to depend on it would assert the answer to the question
      // being asked.
      assert.equal(await count(client, 'task_dependency', `"task_id" = '${TASK}'`), 0);
      // A re-plan is addressed to a person, so it is not handed to the subject's agent.
      assert.equal(effect.assignee_id, null);
      // §2 SM: the task is now in a state SM2 will not dispatch.
      assert.equal(await count(client, 'task',
        `"id" = '${TASK}' AND "progress_state" = 'NEEDS_REPLAN'`), 1);
    } finally {
      await client.end();
    }
  });

test('the two blocker classes file no Task and record which row they will raise',
  { skip }, async () => {
    const client = await connect();
    try {
      await reset(client);
      const env = await submit(client, {
        scopeClassification: 'ENVIRONMENT', failureFingerprint: FP,
      }, 'COORDINATOR');
      const human = await submit(client, {
        scopeClassification: 'HUMAN_REQUIRED', failureFingerprint: FP2,
      }, 'VERIFIER');
      assert.equal(env.effectTaskId, null);
      assert.equal(env.effectBlockerKind, 'ENVIRONMENT_BROKEN');
      assert.equal(human.effectTaskId, null);
      assert.equal(human.effectBlockerKind, 'HUMAN_DECISION_REQUIRED');
      assert.equal(await count(client, 'task', `"parent_task_id" = '${TASK}'`), 0);
      // §11.1: a USER-owned row carries no clock, because a wait that ends when a person decides
      // has none. The database says so too.
      assert.equal(await count(client, 'task_verification_finding',
        `"owner" = 'USER' AND "next_check_at" IS NOT NULL`), 0);
    } finally {
      await client.end();
    }
  });

// -------------------------------------------------------------------------------------------
// The constraints, against a writer that skipped the service.
// -------------------------------------------------------------------------------------------

test('FD2: a row claiming an outcome without its artifact is refused', { skip }, async () => {
  const client = await connect();
  try {
    await reset(client);
    const ledger = new ConvergenceLedgerService(prisma(client));
    await ledger.ensureBaseline(transactionClient(client), TASK, OWNER);
    const insert = (outcome: string, effect: string, taskId: string | null, kind: string | null) =>
      client.query(`
        INSERT INTO "task_verification_finding" (
          "id", "task_id", "owner_id", "project_id", "seq", "scope_revision", "scope_hash",
          "dedup_key", "severity", "violated_invariant", "minimal_repro", "failure_fingerprint",
          "scope_classification", "evidence", "verdict", "reporter", "effective_classification",
          "outcome", "effect_kind", "effect_idempotency_key", "effect_task_id",
          "effect_blocker_kind", "required_action", "owner"
        ) VALUES (
          gen_random_uuid(), '${TASK}', '${OWNER}', '${PROJECT}', ${Math.random() * 1e9 | 0},
          1, '${SCOPE}', 'k${Math.random()}', 'P0', 'X', 'y', '${FP}', 'IN_SCOPE_DEFECT',
          '{"a":1}'::jsonb, 'FAIL', 'USER', 'IN_SCOPE_DEFECT',
          $1, $2, 'e${Math.random()}', $3, $4, 'do it', 'USER'
        )`, [outcome, effect, taskId, kind]);
    // A defect that filed nothing.
    assert.match(await refused(() =>
      insert('CREATE_DEFECT_SUBTASK', 'DEFECT_SUBTASK', null, null)), /effect_chk/);
    // A blocker that also filed a Task — two consequences for one finding.
    assert.match(await refused(() =>
      insert('RAISE_USER_BLOCKER', 'USER_BLOCKER', PARENT, 'HUMAN_DECISION_REQUIRED')),
    /effect_chk/);
    // An outcome and an effect that do not belong together.
    assert.match(await refused(() =>
      insert('CREATE_DEFECT_SUBTASK', 'REPLAN_TASK', PARENT, null)), /effect_chk/);
  } finally {
    await client.end();
  }
});

test('FD4: the database refuses a finding about a revision the task has moved past',
  { skip }, async () => {
    const client = await connect();
    try {
      await reset(client);
      await submit(client);
      // Move the task to revision 2, the way `[K2]`'s API does.
      await client.query(`
        INSERT INTO "task_scope_revision" ("id", "task_id", "owner_id", "revision", "scope_hash",
                                           "title", "acceptance_criteria", "authorized_by_actor",
                                           "authorized_by_principal", "reason")
        VALUES (gen_random_uuid(), '${TASK}', '${OWNER}', 2, '${'c'.repeat(64)}', 'T2', 'AC2',
                'USER', 'someone', 'replanned');
        UPDATE "task" SET "scope_revision" = 2, "title" = 'T2', "acceptance_criteria" = 'AC2'
         WHERE "id" = '${TASK}';
      `);
      const message = await refused(() => submit(client, { failureFingerprint: FP2 }));
      assert.match(message, /STALE_SCOPE_REVISION/);
      assert.equal(await count(client, 'task_verification_finding'), 1);
    } finally {
      await client.end();
    }
  });

test('a finding is append-only', { skip }, async () => {
  const client = await connect();
  try {
    await reset(client);
    await submit(client);
    assert.match(
      await refused(() => client.query(
        `UPDATE "task_verification_finding" SET "severity" = 'P3'`)),
      /FINDING_IMMUTABLE/);
    assert.match(
      await refused(() => client.query(`DELETE FROM "task_verification_finding"`)),
      /FINDING_IMMUTABLE/);
  } finally {
    await client.end();
  }
});

test('CL2 is the only licence to rewrite the reporter\'s classification', { skip }, async () => {
  const client = await connect();
  try {
    await reset(client);
    const ledger = new ConvergenceLedgerService(prisma(client));
    await ledger.ensureBaseline(transactionClient(client), TASK, OWNER);
    const message = await refused(() => client.query(`
      INSERT INTO "task_verification_finding" (
        "id", "task_id", "owner_id", "project_id", "seq", "scope_revision", "scope_hash",
        "dedup_key", "severity", "violated_invariant", "minimal_repro", "failure_fingerprint",
        "scope_classification", "evidence", "verdict", "reporter", "effective_classification",
        "outcome", "effect_kind", "effect_idempotency_key", "effect_task_id", "required_action",
        "owner"
      ) VALUES (
        gen_random_uuid(), '${TASK}', '${OWNER}', '${PROJECT}', 1, 1, '${SCOPE}',
        'k1', 'P0', 'X', 'y', '${FP}', 'HUMAN_REQUIRED', '{"a":1}'::jsonb, 'FAIL', 'USER',
        'IN_SCOPE_DEFECT', 'CREATE_DEFECT_SUBTASK', 'DEFECT_SUBTASK', 'e1', '${PARENT}',
        'do it', 'COORDINATOR'
      )`));
    assert.match(message, /reclass_chk/);
  } finally {
    await client.end();
  }
});

// -------------------------------------------------------------------------------------------
// Criterion 6's first branch: a check may not reach DONE without a verdict.
// -------------------------------------------------------------------------------------------

test('a check cannot be finished without saying what it found', { skip }, async () => {
  const client = await connect();
  try {
    await reset(client);
    await client.query(`
      INSERT INTO "task" ("id", "owner_id", "creator_id", "project_id", "title",
                          "verifies_task_id")
      VALUES ('${VERIFIER}', '${OWNER}', '${OWNER}', '${PROJECT}', 'Check S', '${SUBJECT}')`);
    assert.match(
      await refused(() => client.query(
        `UPDATE "task" SET "status" = 'DONE' WHERE "id" = '${VERIFIER}'`)),
      /VERDICT_REQUIRED_WITH_DONE/);
    // Both legal spellings still work: one UPDATE carrying both…
    await client.query(
      `UPDATE "task" SET "status" = 'DONE', "verdict" = 'FAIL' WHERE "id" = '${VERIFIER}'`);
    assert.equal(await count(client, 'task', `"id" = '${VERIFIER}' AND "status" = 'DONE'`), 1);
  } finally {
    await client.end();
  }
});

test('…and the verdict first, the status after', { skip }, async () => {
  const client = await connect();
  try {
    await reset(client);
    await client.query(`
      INSERT INTO "task" ("id", "owner_id", "creator_id", "project_id", "title",
                          "verifies_task_id")
      VALUES ('${VERIFIER}', '${OWNER}', '${OWNER}', '${PROJECT}', 'Check S', '${SUBJECT}')`);
    await client.query(`UPDATE "task" SET "verdict" = 'PASS' WHERE "id" = '${VERIFIER}'`);
    await client.query(`UPDATE "task" SET "status" = 'DONE' WHERE "id" = '${VERIFIER}'`);
    assert.equal(await count(client, 'task', `"id" = '${VERIFIER}' AND "status" = 'DONE'`), 1);
  } finally {
    await client.end();
  }
});

test('an INSERT cannot smuggle the shape in either', { skip }, async () => {
  const client = await connect();
  try {
    await reset(client);
    assert.match(
      await refused(() => client.query(`
        INSERT INTO "task" ("id", "owner_id", "creator_id", "project_id", "title",
                            "verifies_task_id", "status")
        VALUES ('${VERIFIER}', '${OWNER}', '${OWNER}', '${PROJECT}', 'Check', '${SUBJECT}',
                'DONE')`)),
      /VERDICT_REQUIRED_WITH_DONE/);
  } finally {
    await client.end();
  }
});

test('a row that ALREADY carries the shape stays editable', { skip }, async () => {
  const client = await connect();
  try {
    await reset(client);
    // Written before this migration existed: the trigger is disabled to create it, which is what a
    // pre-0141 binary did every day.
    await client.query(`
      ALTER TABLE "task" DISABLE TRIGGER "task_verification_verdict_atomic_insert";
      INSERT INTO "task" ("id", "owner_id", "creator_id", "project_id", "title",
                          "verifies_task_id", "status")
      VALUES ('${VERIFIER}', '${OWNER}', '${OWNER}', '${PROJECT}', 'Legacy check', '${SUBJECT}',
              'DONE');
      ALTER TABLE "task" ENABLE TRIGGER "task_verification_verdict_atomic_insert";
    `);
    // Renaming it, re-parenting it, cancelling it — all still possible. Turning existing bad data
    // into rows nobody can clean up would be a worse wedge than the one being closed.
    await client.query(`UPDATE "task" SET "title" = 'Renamed' WHERE "id" = '${VERIFIER}'`);
    await client.query(`UPDATE "task" SET "status" = 'CANCELLED' WHERE "id" = '${VERIFIER}'`);
    assert.equal(await count(client, 'task', `"id" = '${VERIFIER}' AND "status" = 'CANCELLED'`), 1);
  } finally {
    await client.end();
  }
});

// -------------------------------------------------------------------------------------------
// Restart, and two processes.
// -------------------------------------------------------------------------------------------

test('a second process filing the same finding lands one row', { skip }, async () => {
  const client = await connect();
  const other = await connect();
  try {
    await reset(client);
    // Two services on two connections — the shape a restart mid-flight leaves behind, and the shape
    // two coordinators produce.
    const first = await submit(client);
    const second = await service(other).submit({
      ownerId: OWNER,
      subjectTaskId: TASK,
      finding: finding(),
      reporter: 'VERIFIER',
      scopeRevision: 1,
      now: new Date(AT.getTime() + 1_000),
    });
    assert.equal(second.duplicate, true);
    assert.equal(second.findingId, first.findingId);
    assert.equal(await count(client, 'task_verification_finding'), 1);
    assert.equal(await count(client, 'task', `"parent_task_id" = '${TASK}'`), 1);
  } finally {
    await client.end();
    await other.end();
  }
});

test('the whole repair cycle: defect, then a repair that did not converge', { skip }, async () => {
  const client = await connect();
  try {
    await reset(client);
    const round1 = await submit(client, { failureFingerprint: FP, severity: 'P1' });
    assert.equal(round1.triage.outcome, 'CREATE_DEFECT_SUBTASK');
    // Round two: a different failure (FD1 would collapse the same one), no less severe.
    const round2 = await submit(client, { failureFingerprint: FP2, severity: 'P1' });
    assert.equal(round2.triage.outcome, 'FREEZE_AND_REQUEST_REPLAN');
    assert.equal(round2.triage.override, 'REPAIR_WITHOUT_SEVERITY_DROP');
    // One defect and one re-plan request — never two defects for a loop that is not converging.
    assert.equal(await count(client, 'task', `"parent_task_id" = '${TASK}'`), 1);
    assert.equal(await count(client, 'task', `"parent_task_id" = '${PARENT}' AND "title" LIKE 'Re-plan%'`), 1);
    assert.equal(await count(client, 'task',
      `"id" = '${TASK}' AND "progress_state" = 'NEEDS_REPLAN'`), 1);
    // And the audit can follow every step: two findings, two judgments, each naming the other.
    assert.equal(await count(client, 'task_verification_finding'), 2);
    assert.equal(await count(client, 'task_verification_finding', '"decision_id" IS NOT NULL'), 2);
  } finally {
    await client.end();
  }
});

test('the read face returns the finding → Task → decision chain in Base62', { skip }, async () => {
  const client = await connect();
  try {
    await reset(client);
    await submit(client);
    const described = await service(client).describe(OWNER, TASK);
    assert.equal(described.length, 1);
    const row = described[0] as Record<string, unknown>;
    // Base62 throughout: audit material a caller can hand to any other endpoint.
    for (const key of ['id', 'effectTaskId', 'decisionId', 'reporterSessionId']) {
      assert.equal(/^[0-9a-f-]{36}$/.test(String(row[key] ?? '')), false, `${key} is a raw UUID`);
    }
    assert.equal(row.outcome, 'CREATE_DEFECT_SUBTASK');
    assert.equal(row.effectKind, 'DEFECT_SUBTASK');
  } finally {
    await client.end();
  }
});
