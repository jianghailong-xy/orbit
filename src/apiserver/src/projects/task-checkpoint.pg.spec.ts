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
import {
  TaskCheckpointService,
  mergeDispatchGate,
  reportedLandingAuthority,
} from './task-checkpoint.service';
import {
  CheckpointTestEvidence,
  checkpointEvidenceDigest,
  checkpointMergeReceiptKey,
} from './task-checkpoint';

// `[K6]` §7 on real PostgreSQL, against a DISPOSABLE server.
//
// The unit spec proves the DECISION. This proves the two things a pure function cannot: that a
// checkpoint is immutable, portable and exactly-once however many times it is delivered, across
// however many processes — and that those properties are held by the DATABASE, so they survive the
// next writer who forgets. §0's incident was written by a writer who forgot.
//
// The server is proved disposable before the first write (`coordinator-pg-test-safety.ts`).

const URL = process.env.COORDINATOR_PG_URL;
const SCHEMA = 'pcck6_checkpoint';
const skip = !URL;

const OWNER = '00000000-0000-7000-8000-000000006001';
const PROJECT = '00000000-0000-7000-8000-000000006002';
const TASK = '00000000-0000-7000-8000-000000006003';
const NEXT_TASK = '00000000-0000-7000-8000-000000006004';
const SESSION = '00000000-0000-7000-8000-000000006005';
const OTHER_SESSION = '00000000-0000-7000-8000-000000006006';
const PLAIN_TASK = '00000000-0000-7000-8000-000000006007';

const LEDGER = migration('0138_task_convergence_ledger');
const ATTEMPT = migration('0139_task_session_attempt');
const CHECKPOINT = migration('0152_task_checkpoint');

const SCOPE = scopeHash({ title: 'T', description: null, acceptanceCriteria: 'AC' });

/** The E0 branch: five commits, the last of which is red. */
const E0 = [1, 2, 3, 4, 5].map((n) => ({
  commit: `${n}`.repeat(40),
  tree: `${'abcde'[n - 1]}`.repeat(40),
}));
const E0_BASE = '0'.repeat(40);
const BUNDLE = 'f'.repeat(64);

type ClientCtor = new (config: { connectionString?: string; connectionTimeoutMillis?: number }) => Client;
type Tx = Prisma.TransactionClient;

function migration(name: string): string {
  return readFileSync(path.resolve(__dirname, `../../prisma/migrations/${name}/migration.sql`), 'utf8');
}

function green(tree: string, over: Partial<CheckpointTestEvidence> = {}): CheckpointTestEvidence {
  return { suite: 'apiserver', treeSha: tree, passed: 2876, failed: 0, skipped: 461, ...over };
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

function service(client: Client): TaskCheckpointService {
  const p = prisma(client);
  return new TaskCheckpointService(p, new ConvergenceLedgerService(p));
}

async function reset(client: Client): Promise<void> {
  await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await client.query(`CREATE SCHEMA ${SCHEMA}`);
  await client.query(`SET search_path TO ${SCHEMA}`);
  // The subset of the real schema these migrations touch, built by hand exactly as the other
  // coordinator pg specs do: the point is to exercise 0152's own SQL, not to replay 151 migrations.
  // Every constraint below is the production one — a subset that relaxes a constraint tests a
  // database nobody runs, which is how `[K5]` shipped a `creator_id` defect its fixture was green on.
  await client.query(`
    CREATE TYPE "project_status" AS ENUM ('OPEN', 'DONE', 'CANCELLED');
    CREATE TYPE "project_automation_policy" AS ENUM ('MANUAL', 'GUARDED_AUTO', 'AUTO');
    CREATE TYPE "task_status" AS ENUM ('OPEN', 'IN_PROGRESS', 'DONE', 'CANCELLED', 'FAILED');
    CREATE TYPE "task_verdict" AS ENUM ('PASS', 'FAIL', 'INCONCLUSIVE');
    CREATE TABLE "user" ("id" UUID PRIMARY KEY);
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
      "creator_id" UUID NOT NULL,
      "dispatch_authority" TEXT NOT NULL DEFAULT 'COORDINATOR',
      "idempotency_key" TEXT UNIQUE,
      "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE "session" (
      "id" UUID PRIMARY KEY,
      "owner_id" UUID NOT NULL,
      "task_id" UUID REFERENCES "task"("id"),
      "branch" TEXT,
      "merge_status" TEXT,
      "merge_target" TEXT,
      "branch_merged" BOOLEAN,
      "merged_source_sha" TEXT
    );
    CREATE TABLE "session_merge_receipt" (
      "id"                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      "owner_id"          UUID NOT NULL REFERENCES "user"("id"),
      "session_id"        UUID NOT NULL REFERENCES "session"("id") ON DELETE CASCADE,
      "task_id"           UUID REFERENCES "task"("id") ON DELETE SET NULL,
      "project_id"        UUID REFERENCES "project"("id") ON DELETE CASCADE,
      "result"            TEXT NOT NULL,
      "source_branch"     TEXT NOT NULL,
      "source_sha"        CHAR(40) NOT NULL,
      "target_branch"     TEXT NOT NULL,
      "target_sha_before" CHAR(40),
      "target_sha_after"  CHAR(40),
      "rebase_base_sha"   CHAR(40),
      "conflicts"         TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
      "recorded_by"       TEXT NOT NULL,
      "detail"            JSONB NOT NULL DEFAULT '{}'::jsonb,
      "idempotency_key"   TEXT NOT NULL,
      "created_at"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "session_merge_receipt_result_check"
        CHECK ("result" IN ('MERGED', 'ALREADY_MERGED', 'CONFLICT', 'ERROR')),
      CONSTRAINT "session_merge_receipt_recorded_by_check"
        CHECK ("recorded_by" IN ('RUNNER', 'AGENT', 'USER')),
      CONSTRAINT "session_merge_receipt_merged_target_check"
        CHECK ("result" <> 'MERGED' OR "target_sha_after" IS NOT NULL),
      CONSTRAINT "session_merge_receipt_conflicts_check"
        CHECK ("result" = 'CONFLICT' OR COALESCE(array_length("conflicts", 1), 0) = 0)
    );
    CREATE UNIQUE INDEX "session_merge_receipt_session_key"
      ON "session_merge_receipt" ("session_id", "idempotency_key");
    INSERT INTO "user" ("id") VALUES ('${OWNER}');
  `);
  await client.query(LEDGER);
  await client.query(ATTEMPT);
  await client.query(CHECKPOINT);
  await client.query(`
    INSERT INTO "project" ("id", "owner_id", "title") VALUES ('${PROJECT}', '${OWNER}', 'P');
    INSERT INTO "task" ("id", "owner_id", "creator_id", "project_id", "title", "acceptance_criteria")
      VALUES ('${TASK}', '${OWNER}', '${OWNER}', '${PROJECT}', 'T', 'AC');
    INSERT INTO "task" ("id", "owner_id", "creator_id", "project_id", "title", "acceptance_criteria")
      VALUES ('${NEXT_TASK}', '${OWNER}', '${OWNER}', '${PROJECT}', 'T2', 'AC');
    INSERT INTO "task" ("id", "owner_id", "creator_id", "project_id", "title", "acceptance_criteria")
      VALUES ('${PLAIN_TASK}', '${OWNER}', '${OWNER}', '${PROJECT}', 'Plain', 'AC');
    INSERT INTO "session" ("id", "owner_id", "task_id", "branch", "merge_target")
      VALUES ('${SESSION}', '${OWNER}', '${TASK}', 'orbit/k6', 'main');
    INSERT INTO "session" ("id", "owner_id", "task_id", "branch", "merge_target")
      VALUES ('${OTHER_SESSION}', '${OWNER}', '${TASK}', 'orbit/k6', 'main');
  `);
}

/** One receipt, written the way both production writers write it. */
async function receipt(
  client: Client,
  over: {
    sessionId?: string;
    result?: string;
    sourceSha?: string;
    targetShaAfter?: string | null;
    checkpointId?: string | null;
    idempotencyKey?: string;
    conflicts?: string[];
    taskId?: string;
  } = {},
): Promise<string> {
  const result = over.result ?? 'MERGED';
  const sourceSha = over.sourceSha ?? E0[3].commit;
  const key =
    over.idempotencyKey ??
    (over.checkpointId
      ? checkpointMergeReceiptKey({ checkpointId: over.checkpointId, targetBranch: 'main', result })
      : `mr:${result}:${sourceSha}`);
  const inserted = await client.query(
    `INSERT INTO "session_merge_receipt"
       ("owner_id", "session_id", "task_id", "project_id", "result", "source_branch", "source_sha",
        "target_branch", "target_sha_before", "target_sha_after", "conflicts", "recorded_by",
        "idempotency_key", "checkpoint_id")
     VALUES ($1, $2, $3, $4, $5, 'orbit/k6', $6, 'main', $7, $8, $9, 'AGENT', $10, $11)
     RETURNING "id"`,
    [
      OWNER,
      over.sessionId ?? SESSION,
      over.taskId ?? TASK,
      PROJECT,
      result,
      sourceSha,
      E0_BASE,
      over.targetShaAfter === undefined ? sourceSha : over.targetShaAfter,
      over.conflicts ?? [],
      key,
      over.checkpointId ?? null,
    ],
  );
  return rows<{ id: string }>(inserted)[0].id;
}

async function count(client: Client, table: string, where = 'TRUE'): Promise<number> {
  const r = await client.query(`SELECT count(*)::int AS n FROM "${table}" WHERE ${where}`);
  return rows<{ n: number }>(r)[0].n;
}

test('§7 CP1: an accepted checkpoint cannot be edited, only replaced', { skip }, async () => {
  const client = await connect();
  try {
    await reset(client);
    const svc = service(client);
    const recorded = await svc.record({
      ownerId: OWNER,
      taskId: TASK,
      scopeRevision: 1,
      commit: { branch: 'orbit/k6', commitSha: E0[3].commit, treeSha: E0[3].tree, baseSha: E0_BASE },
      evidence: green(E0[3].tree),
      artifact: null,
      recordedBy: 'WORKER',
    });
    assert.equal(typeof recorded === 'string' ? recorded : recorded.kind, 'ACCEPTED');
    const id = (recorded as { checkpointId: string }).checkpointId;

    // Every field, one at a time. A row that can be edited right up until somebody relies on it is
    // not immutable — and the merge gate, the next task's baseline and an audit months later all
    // read values that must still mean what they meant when they were written.
    for (const column of ['kind', 'commit_sha', 'evidence_digest', 'artifact_ref', 'branch']) {
      await assert.rejects(
        client.query(`UPDATE "task_checkpoint" SET "${column}" = NULL WHERE "id" = $1`, [id]),
        /CHECKPOINT_IMMUTABLE/,
        column,
      );
    }
    // Changing a field is a NEW checkpoint, which is what makes immutability affordable.
    const other = await svc.record({
      ownerId: OWNER,
      taskId: TASK,
      scopeRevision: 1,
      commit: { branch: 'orbit/k6', commitSha: E0[4].commit, treeSha: E0[4].tree, baseSha: E0_BASE },
      evidence: green(E0[4].tree),
      artifact: null,
      recordedBy: 'WORKER',
    });
    assert.notEqual((other as { checkpointId: string }).checkpointId, id);
    assert.equal(await count(client, 'task_checkpoint'), 2);
  } finally {
    await client.end();
  }
});

test('§7 CP2: the database refuses red work with nowhere to be recovered from', { skip }, async () => {
  const client = await connect();
  try {
    await reset(client);
    const base = `INSERT INTO "task_checkpoint"
      ("id","task_id","owner_id","project_id","seq","scope_revision","scope_hash","kind",
       "branch","commit_sha","tree_sha","base_sha","content_digest","dedup_key","recorded_by")
      VALUES (gen_random_uuid(), '${TASK}', '${OWNER}', '${PROJECT}', $1, 1, '${SCOPE}', $2,
              'orbit/k6', '${E0[4].commit}', '${E0[4].tree}', '${E0_BASE}', '${BUNDLE}', $3, 'WORKER')`;
    // The service is bypassed on purpose: these are the properties that have to hold when the next
    // writer reaches for raw SQL, which is how the incident's shapes got written the first time.
    await client.query(`SELECT 1 FROM "task_scope_revision" LIMIT 0`);
    await service(client).record({
      ownerId: OWNER, taskId: TASK, scopeRevision: 1,
      commit: { branch: 'orbit/k6', commitSha: E0[0].commit, treeSha: E0[0].tree, baseSha: E0_BASE },
      evidence: green(E0[0].tree), artifact: null, recordedBy: 'WORKER',
    });
    await assert.rejects(
      client.query(base, [90, 'WIP_RED', 'k:red-no-artifact']),
      /task_checkpoint_red_artifact_chk/,
      'red work with no artifact is work about to be lost',
    );
    await assert.rejects(
      client.query(
        `INSERT INTO "task_checkpoint"
          ("id","task_id","owner_id","project_id","seq","scope_revision","scope_hash","kind",
           "branch","commit_sha","tree_sha","base_sha","artifact_kind","artifact_ref",
           "artifact_digest","content_digest","dedup_key","recorded_by")
          VALUES (gen_random_uuid(), '${TASK}', '${OWNER}', '${PROJECT}', 91, 1, '${SCOPE}', 'WIP_RED',
                  'orbit/k6', '${E0[4].commit}', '${E0[4].tree}', '${E0_BASE}',
                  'LOCAL_STASH', 'stash@{0}', '${BUNDLE}', '${BUNDLE}', 'k:stash', 'WORKER')`,
      ),
      /task_checkpoint_artifact_portable_chk/,
      'a stash is a place, not an artifact',
    );
    await assert.rejects(
      client.query(base, [92, 'ACCEPTED', 'k:accepted-no-evidence']),
      /task_checkpoint_accepted_evidence_chk/,
      'an accepted point with no test evidence is an adjective',
    );
  } finally {
    await client.end();
  }
});

test('§7: one checkpoint however many times it is delivered', { skip }, async () => {
  const client = await connect();
  try {
    await reset(client);
    const svc = service(client);
    const write = () =>
      svc.record({
        ownerId: OWNER, taskId: TASK, scopeRevision: 1,
        commit: { branch: 'orbit/k6', commitSha: E0[3].commit, treeSha: E0[3].tree, baseSha: E0_BASE },
        evidence: green(E0[3].tree), artifact: null, recordedBy: 'WORKER',
      });
    const first = (await write()) as { checkpointId: string; duplicate: boolean; seq: number };
    assert.equal(first.duplicate, false);
    // A redelivered event, a takeover and a retry after a lost response all re-derive the same
    // content and must all land on the row that exists.
    for (let i = 0; i < 3; i++) {
      const again = (await write()) as { checkpointId: string; duplicate: boolean; seq: number };
      assert.equal(again.duplicate, true);
      assert.equal(again.checkpointId, first.checkpointId);
      assert.equal(again.seq, first.seq);
    }
    assert.equal(await count(client, 'task_checkpoint'), 1);
  } finally {
    await client.end();
  }
});

test('§7 CP6: only an ACCEPTED point is a baseline, and "latest" is seq not the clock', { skip }, async () => {
  const client = await connect();
  try {
    await reset(client);
    const svc = service(client);
    const accepted = (await svc.record({
      ownerId: OWNER, taskId: TASK, scopeRevision: 1,
      commit: { branch: 'orbit/k6', commitSha: E0[3].commit, treeSha: E0[3].tree, baseSha: E0_BASE },
      evidence: green(E0[3].tree), artifact: null, recordedBy: 'WORKER',
    })) as { checkpointId: string };
    // The red experiment recorded AFTER it, which is the ordinary sequence: verify, then try
    // something. It must not become what the next task starts from.
    const red = (await svc.record({
      ownerId: OWNER, taskId: TASK, scopeRevision: 1,
      commit: { branch: 'orbit/k6', commitSha: E0[4].commit, treeSha: E0[4].tree, baseSha: E0_BASE },
      evidence: green(E0[4].tree, { passed: 2870, failed: 6 }),
      artifact: { kind: 'GIT_BUNDLE', ref: 'bundle:k6:red', digest: BUNDLE },
      recordedBy: 'WORKER',
    })) as { checkpointId: string; kind: string; seq: number };
    assert.equal(red.kind, 'WIP_RED');

    const baseline = await svc.latestAccepted(prisma(client), OWNER, TASK);
    assert.equal(baseline?.id, accepted.checkpointId);
    assert.equal(baseline?.commitSha, E0[3].commit);

    // And "latest" is decided by `seq`, not by the clock. Written directly, because the whole
    // point is a pair the service could not produce: the row with the HIGHER seq carries the
    // EARLIER timestamp, which is what two writers racing on a coarse clock actually leave behind.
    // If the read ordered by `created_at` this is the case it would get wrong.
    await client.query(
      `INSERT INTO "task_checkpoint"
        ("id","task_id","owner_id","project_id","seq","scope_revision","scope_hash","kind",
         "branch","commit_sha","tree_sha","base_sha","evidence_digest","test_evidence",
         "content_digest","dedup_key","recorded_by","created_at")
       VALUES (gen_random_uuid(), '${TASK}', '${OWNER}', '${PROJECT}', 99, 1, '${SCOPE}', 'ACCEPTED',
               'orbit/k6', '${E0[2].commit}', '${E0[2].tree}', '${E0_BASE}', '${BUNDLE}',
               '{}'::jsonb, '${BUNDLE}', 'k:seq-99', 'WORKER', '2020-01-01 00:00:00')`,
    );
    const bySeq = await svc.latestAccepted(prisma(client), OWNER, TASK);
    assert.equal(bySeq?.seq, 99);
    assert.equal(bySeq?.commitSha, E0[2].commit, 'the read fell back to the clock');
  } finally {
    await client.end();
  }
});

test('§7: a landed receipt may not name known-red work', { skip }, async () => {
  const client = await connect();
  try {
    await reset(client);
    const svc = service(client);
    const red = (await svc.record({
      ownerId: OWNER, taskId: TASK, scopeRevision: 1,
      commit: { branch: 'orbit/k6', commitSha: E0[4].commit, treeSha: E0[4].tree, baseSha: E0_BASE },
      evidence: null,
      artifact: { kind: 'GIT_BUNDLE', ref: 'bundle:k6:red', digest: BUNDLE },
      recordedBy: 'WORKER',
    })) as { checkpointId: string };

    for (const result of ['MERGED', 'ALREADY_MERGED']) {
      await assert.rejects(
        receipt(client, { result, sourceSha: E0[4].commit, checkpointId: red.checkpointId }),
        /CHECKPOINT_NOT_ACCEPTED/,
        result,
      );
    }
    // A CONFLICT about the same red checkpoint is still the truth about an attempt somebody made.
    // Refusing it would delete the audit of the very thing this trigger exists to prevent.
    await receipt(client, {
      result: 'CONFLICT',
      sourceSha: E0[4].commit,
      checkpointId: red.checkpointId,
      targetShaAfter: null,
      conflicts: ['src/a.ts'],
    });
    assert.equal(await count(client, 'session_merge_receipt', `"result" = 'CONFLICT'`), 1);
  } finally {
    await client.end();
  }
});

test('mixed version: an old control plane cannot record a landing it is not entitled to', { skip }, async () => {
  const client = await connect();
  try {
    await reset(client);
    const svc = service(client);

    // A task nobody has checkpointed — every task that existed before this unit. The previous
    // build's shape (a landed receipt with no `checkpoint_id`) is exactly right for it and must
    // keep working, because that is every merge Orbit has ever recorded.
    await receipt(client, {
      result: 'MERGED', sourceSha: E0[0].commit, checkpointId: null, taskId: NEXT_TASK,
    });
    assert.equal(await count(client, 'session_merge_receipt', `"checkpoint_id" IS NULL`), 1);

    // Now the task becomes checkpoint-managed. From here on §7 makes claims about it, and the
    // database holds them against a process that has never heard of §7.
    const accepted = (await svc.record({
      ownerId: OWNER, taskId: TASK, scopeRevision: 1,
      commit: { branch: 'orbit/k6', commitSha: E0[3].commit, treeSha: E0[3].tree, baseSha: E0_BASE },
      evidence: green(E0[3].tree), artifact: null, recordedBy: 'WORKER',
    })) as { checkpointId: string };

    // The old replica's receipt shape, on a managed task. It is not malicious — the column did not
    // exist when that build was compiled — and it is refused anyway, because a rule that holds only
    // while every process is new is a release note rather than a rule.
    await assert.rejects(
      receipt(client, { result: 'MERGED', sourceSha: E0[3].commit, checkpointId: null }),
      /CHECKPOINT_AUTHORITY_REQUIRED/,
      'an old replica recorded a landing with nothing verified behind it',
    );
    // Including for the RED tip, which is the version of it that actually loses work.
    await assert.rejects(
      receipt(client, { result: 'ALREADY_MERGED', sourceSha: E0[4].commit, checkpointId: null }),
      /CHECKPOINT_AUTHORITY_REQUIRED/,
    );
    // A receipt that names the checkpoint but the WRONG commit is refused by the database too —
    // the service checks this first, and the service is the half an old replica does not have.
    await assert.rejects(
      receipt(client, {
        result: 'MERGED', sourceSha: E0[4].commit, checkpointId: accepted.checkpointId,
        idempotencyKey: 'wrong-commit',
      }),
      /BRANCH_TIP_MISMATCH/,
    );

    // Nothing of it landed, and the legacy row from before management is untouched.
    assert.equal(await count(client, 'session_merge_receipt'), 1);
    assert.equal(await count(client, 'session_merge_receipt', `"task_id" = '${NEXT_TASK}'`), 1);

    // The verified commit still lands, from any writer.
    await receipt(client, {
      result: 'MERGED', sourceSha: E0[3].commit, checkpointId: accepted.checkpointId,
    });
    assert.equal(await count(client, 'session_merge_receipt'), 2);
  } finally {
    await client.end();
  }
});

test('mixed version: the old controller transaction rolls back whole', { skip }, async () => {
  const client = await connect();
  try {
    await reset(client);
    const svc = service(client);
    const accepted = (await svc.record({
      ownerId: OWNER, taskId: TASK, scopeRevision: 1,
      commit: { branch: 'orbit/k6', commitSha: E0[3].commit, treeSha: E0[3].tree, baseSha: E0_BASE },
      evidence: green(E0[3].tree), artifact: null, recordedBy: 'WORKER',
    })) as { checkpointId: string };

    // The previous build's merge-result path, statement for statement: the projection FIRST, then
    // a receipt with no checkpoint — and, when the runner named no source at all, no receipt.
    // Both halves are in one transaction, which is what makes rolling back the right answer.
    const oldController = async (sourceSha: string | null) => {
      await client.query('BEGIN');
      try {
        await client.query(
          `UPDATE "session"
              SET "merge_status" = 'merged', "branch_merged" = true, "merged_source_sha" = $2
            WHERE "id" = $1`,
          [SESSION, sourceSha],
        );
        if (sourceSha !== null) {
          await client.query(
            `INSERT INTO "session_merge_receipt"
               ("owner_id","session_id","task_id","project_id","result","source_branch","source_sha",
                "target_branch","target_sha_before","target_sha_after","recorded_by","idempotency_key")
             VALUES ($1,$2,$3,$4,'MERGED','orbit/k6',$5,'main',$6,$5,'RUNNER',$7)`,
            [OWNER, SESSION, TASK, PROJECT, sourceSha, E0_BASE, `old:${sourceSha}`],
          );
        }
        await client.query('COMMIT');
        return null;
      } catch (error) {
        await client.query('ROLLBACK');
        return String((error as Error).message);
      }
    };

    const session = async () =>
      rows<{ mergeStatus: string | null; branchMerged: boolean | null; mergedSourceSha: string | null }>(
        await client.query(
          `SELECT "merge_status" AS "mergeStatus", "branch_merged" AS "branchMerged",
                  "merged_source_sha" AS "mergedSourceSha" FROM "session" WHERE "id" = $1`,
          [SESSION],
        ),
      )[0];

    const before = await session();

    // 1. A runner that ignored `requiredSourceSha` and merged the red tip.
    assert.match(String(await oldController(E0[4].commit)), /CHECKPOINT_AUTHORITY_REQUIRED/);
    assert.deepEqual(await session(), before, 'the projection survived a refused landing');
    assert.equal(await count(client, 'session_merge_receipt'), 0);

    // 2. A runner too old to name a source at all — the case that writes NO receipt, so the
    //    receipt trigger never sees it. This is why the projection carries its own guard.
    assert.match(String(await oldController(null)), /CHECKPOINT_AUTHORITY_REQUIRED/);
    assert.deepEqual(await session(), before);

    // 3. Redelivery: the old controller retries, twice. Same answer, still nothing written.
    for (let i = 0; i < 2; i++) {
      assert.match(String(await oldController(E0[4].commit)), /CHECKPOINT_AUTHORITY_REQUIRED/);
    }
    assert.deepEqual(await session(), before);
    assert.equal(await count(client, 'session_merge_receipt'), 0);

    // 4. And the old shape is refused even when it names the RIGHT commit. That is the boundary,
    //    stated: the authority is "name the verified point", not "happen to guess a sha that
    //    matches one". An old replica cannot name it — the column did not exist when it was
    //    compiled — so it cannot record landings for managed work at all, and the merge simply
    //    stays pending until a process that can picks it up. On a rolling deploy that is the new
    //    one; the alternative is a window in which §7 is advisory.
    assert.match(String(await oldController(E0[3].commit)), /CHECKPOINT_AUTHORITY_REQUIRED/);
    assert.deepEqual(await session(), before);
    assert.equal(await count(client, 'session_merge_receipt'), 0);

    // 5. The CURRENT controller's shape — the same transaction, with the checkpoint named — lands.
    const newController = async (idempotencyKey: string) => {
      await client.query('BEGIN');
      try {
        await client.query(
          `UPDATE "session"
              SET "merge_status" = 'merged', "branch_merged" = true, "merged_source_sha" = $2
            WHERE "id" = $1`,
          [SESSION, E0[3].commit],
        );
        await client.query(
          `INSERT INTO "session_merge_receipt"
             ("owner_id","session_id","task_id","project_id","result","source_branch","source_sha",
              "target_branch","target_sha_before","target_sha_after","recorded_by",
              "idempotency_key","checkpoint_id")
           VALUES ($1,$2,$3,$4,'MERGED','orbit/k6',$5,'main',$6,$5,'RUNNER',$7,$8)`,
          [OWNER, SESSION, TASK, PROJECT, E0[3].commit, E0_BASE, idempotencyKey,
           accepted.checkpointId],
        );
        await client.query('COMMIT');
        return null;
      } catch (error) {
        await client.query('ROLLBACK');
        return String((error as Error).message);
      }
    };
    assert.equal(await newController('cp:landed'), null);
    const landed = await session();
    assert.equal(landed.mergeStatus, 'merged');
    assert.equal(landed.branchMerged, true);
    assert.equal(landed.mergedSourceSha, E0[3].commit);
    assert.equal(await count(client, 'session_merge_receipt'), 1);

    // 6. A restart replays it. The receipt's own key decides, and the projection re-asserts the
    //    same commit rather than a second claim, so the guard has nothing to object to.
    assert.match(String(await newController('cp:landed')), /duplicate key|idempotency/);
    assert.deepEqual(await session(), landed);
    assert.equal(await count(client, 'session_merge_receipt'), 1);

    // 7. ...and once a landing is on the books, an old replica still cannot add a second one on a
    //    different commit beside it.
    assert.match(String(await oldController(E0[4].commit)), /CHECKPOINT_AUTHORITY_REQUIRED/);
    assert.deepEqual(await session(), landed);
    assert.equal(await count(client, 'session_merge_receipt'), 1);
  } finally {
    await client.end();
  }
});

test('CP4: one landing is one receipt, across sessions and across redeliveries', { skip }, async () => {
  const client = await connect();
  try {
    await reset(client);
    const svc = service(client);
    const cp = (await svc.record({
      ownerId: OWNER, taskId: TASK, scopeRevision: 1,
      commit: { branch: 'orbit/k6', commitSha: E0[3].commit, treeSha: E0[3].tree, baseSha: E0_BASE },
      evidence: green(E0[3].tree), artifact: null, recordedBy: 'WORKER',
    })) as { checkpointId: string };

    await receipt(client, { sourceSha: E0[3].commit, checkpointId: cp.checkpointId });
    // The response was lost and the same session asked again.
    await assert.rejects(
      receipt(client, { sourceSha: E0[3].commit, checkpointId: cp.checkpointId }),
      /session_merge_receipt/,
    );
    // A takeover on ANOTHER runner reports the same landing. Keyed by session this is a second
    // receipt for one landing; keyed by checkpoint it is the same fact.
    await assert.rejects(
      receipt(client, {
        sessionId: OTHER_SESSION,
        sourceSha: E0[3].commit,
        checkpointId: cp.checkpointId,
      }),
      /session_merge_receipt_checkpoint_key/,
    );
    assert.equal(await count(client, 'session_merge_receipt'), 1);

    // An earlier CONFLICT and this MERGED are two events, and both survive: a conflict and a
    // successful merge of one checkpoint are two things that happened.
    await receipt(client, {
      result: 'CONFLICT', sourceSha: E0[3].commit, checkpointId: cp.checkpointId,
      targetShaAfter: null, conflicts: ['src/a.ts'],
    });
    assert.equal(await count(client, 'session_merge_receipt'), 2);
    assert.equal(await count(client, 'session_merge_receipt', `"result" = 'CONFLICT'`), 1);
  } finally {
    await client.end();
  }
});

test('the dispatch gate hands back the landed receipt instead of merging again', { skip }, async () => {
  const client = await connect();
  try {
    await reset(client);
    const svc = service(client);
    const cp = (await svc.record({
      ownerId: OWNER, taskId: TASK, scopeRevision: 1,
      commit: { branch: 'orbit/k6', commitSha: E0[3].commit, treeSha: E0[3].tree, baseSha: E0_BASE },
      evidence: green(E0[3].tree), artifact: null, recordedBy: 'WORKER',
    })) as { checkpointId: string };

    const args = { ownerId: OWNER, sessionId: SESSION, taskId: TASK, targetBranch: 'main' };
    const before = await mergeDispatchGate(prisma(client), args);
    assert.equal(before.decision, 'ALLOWED');

    const receiptId = await receipt(client, {
      sourceSha: E0[3].commit,
      checkpointId: cp.checkpointId,
    });
    // Re-asking a settled question re-reads it. Three times, because the incident's second click
    // was not the last one.
    for (let i = 0; i < 3; i++) {
      const after = await mergeDispatchGate(prisma(client), args);
      assert.equal(after.decision, 'ALREADY_LANDED', `ask ${i + 1}`);
      assert.equal((after as { receiptId: string }).receiptId, receiptId);
      assert.equal((after as { sourceSha: string }).sourceSha, E0[3].commit);
    }
    assert.equal(await count(client, 'session_merge_receipt'), 1);
  } finally {
    await client.end();
  }
});

test('the dispatch gate refuses red and stale work, and says nothing about unmanaged work', { skip }, async () => {
  const client = await connect();
  try {
    await reset(client);
    const svc = service(client);
    const args = { ownerId: OWNER, sessionId: SESSION, taskId: TASK, targetBranch: 'main' };

    // A task under management with nothing verified.
    await svc.record({
      ownerId: OWNER, taskId: TASK, scopeRevision: 1,
      commit: { branch: 'orbit/k6', commitSha: E0[4].commit, treeSha: E0[4].tree, baseSha: E0_BASE },
      evidence: null,
      artifact: { kind: 'GIT_BUNDLE', ref: 'bundle:k6:red', digest: BUNDLE },
      recordedBy: 'WORKER',
    });
    const none = await mergeDispatchGate(prisma(client), args);
    assert.equal(none.decision, 'NO_CHECKPOINT');

    const cp = (await svc.record({
      ownerId: OWNER, taskId: TASK, scopeRevision: 1,
      commit: { branch: 'orbit/k6', commitSha: E0[3].commit, treeSha: E0[3].tree, baseSha: E0_BASE },
      evidence: green(E0[3].tree), artifact: null, recordedBy: 'WORKER',
    })) as { checkpointId: string };
    assert.equal((await mergeDispatchGate(prisma(client), args)).decision, 'ALLOWED');

    // The question moved on. The checkpoint is still a true statement about revision 1, and is no
    // longer a statement about what this task is asking for.
    // The revision row first, signed by a USER: `[K2]`'s guards refuse a task pointed at a
    // revision nobody recorded, and §1 OW3 refuses a revision no user authorized under
    // `GUARDED_AUTO`. Both are the same rule from different sides, and both fire here — which is
    // itself worth having in the fixture, because it means this test cannot accidentally set up a
    // scope change no coordinator would be allowed to make.
    await client.query(
      `INSERT INTO "task_scope_revision"
         ("id","task_id","owner_id","revision","scope_hash","title","reason",
          "authorized_by_actor","authorized_by_principal","automation_policy")
       VALUES (gen_random_uuid(), '${TASK}', '${OWNER}', 2, '${'9'.repeat(64)}', 'T', 'replan',
               'USER', '${OWNER}', 'GUARDED_AUTO')`,
    );
    await client.query(`UPDATE "task" SET "scope_revision" = 2 WHERE "id" = '${TASK}'`);
    const stale = await mergeDispatchGate(prisma(client), args);
    assert.equal(stale.decision, 'SCOPE_REVISION_MISMATCH');
    assert.equal((stale as { checkpointId: string }).checkpointId, cp.checkpointId);

    // A session whose task was never put under management is untouched by all of it (AC11).
    await client.query(`UPDATE "session" SET "task_id" = '${PLAIN_TASK}' WHERE "id" = '${OTHER_SESSION}'`);
    const plain = await mergeDispatchGate(prisma(client), {
      ownerId: OWNER, sessionId: OTHER_SESSION, taskId: PLAIN_TASK, targetBranch: 'main',
    });
    assert.equal(plain.decision, 'ALLOWED');
    assert.equal((plain as { checkpointId: string | null }).checkpointId, null);
  } finally {
    await client.end();
  }
});

test('a reported landing is judged against the checkpoint the SERVER persisted', { skip }, async () => {
  const client = await connect();
  try {
    await reset(client);
    const svc = service(client);
    const accepted = (await svc.record({
      ownerId: OWNER, taskId: TASK, scopeRevision: 1,
      commit: { branch: 'orbit/k6', commitSha: E0[3].commit, treeSha: E0[3].tree, baseSha: E0_BASE },
      evidence: green(E0[3].tree), artifact: null, recordedBy: 'WORKER',
    })) as { checkpointId: string };
    const red = (await svc.record({
      ownerId: OWNER, taskId: TASK, scopeRevision: 1,
      commit: { branch: 'orbit/k6', commitSha: E0[4].commit, treeSha: E0[4].tree, baseSha: E0_BASE },
      evidence: null,
      artifact: { kind: 'GIT_BUNDLE', ref: 'bundle:k6:red', digest: BUNDLE },
      recordedBy: 'WORKER',
    })) as { checkpointId: string };

    const ask = (mergeCheckpointId: string | null, sourceSha: string | null, taskId = TASK) =>
      reportedLandingAuthority(prisma(client), {
        ownerId: OWNER, taskId, mergeCheckpointId, sourceSha,
      });

    // The operation was authorised for the verified commit, and that is what came back.
    const ok = await ask(accepted.checkpointId, E0[3].commit);
    assert.equal(ok.decision, 'ALLOWED');
    assert.equal(ok.checkpointId, accepted.checkpointId);

    // A runner that ignored `requiredSourceSha` and merged the red tip instead. Nothing about the
    // report looks wrong — it is a well-formed successful merge of a real commit.
    assert.equal((await ask(accepted.checkpointId, E0[4].commit)).decision, 'BRANCH_TIP_MISMATCH');
    // A runner too old to name a source at all.
    assert.equal((await ask(accepted.checkpointId, null)).decision, 'BRANCH_TIP_MISMATCH');
    // An authorisation that points at red work.
    assert.equal((await ask(red.checkpointId, E0[4].commit)).decision, 'CHECKPOINT_NOT_ACCEPTED');

    // An operation queued before this column existed: no persisted expectation, so the current
    // baseline is the closest honest one — still fail-closed, never waved through.
    assert.equal((await ask(null, E0[3].commit)).decision, 'ALLOWED');
    assert.equal((await ask(null, E0[4].commit)).decision, 'BRANCH_TIP_MISMATCH');

    // A managed task with nothing accepted refuses rather than waves through: the queue-time gate
    // would not have authorised a merge of it in the first place.
    assert.equal((await ask(null, E0[3].commit, NEXT_TASK)).decision, 'ALLOWED',
      'sanity: an unmanaged task is untouched');
    await svc.record({
      ownerId: OWNER, taskId: NEXT_TASK, scopeRevision: 1,
      commit: { branch: 'orbit/k6b', commitSha: E0[0].commit, treeSha: E0[0].tree, baseSha: E0_BASE },
      evidence: null,
      artifact: { kind: 'GIT_BUNDLE', ref: 'bundle:k6b:red', digest: BUNDLE },
      recordedBy: 'WORKER',
    });
    assert.equal((await ask(null, E0[0].commit, NEXT_TASK)).decision, 'NO_CHECKPOINT');

    // A session with no task is not under any of this.
    assert.equal((await ask(null, E0[4].commit, null as unknown as string)).decision, 'ALLOWED');
  } finally {
    await client.end();
  }
});

test('E0 replayed: five commits, a known-red stash, and a second Runner', { skip }, async () => {
  const client = await connect();
  try {
    await reset(client);
    const svc = service(client);

    // --- The attempt, as it actually went -----------------------------------------------------
    // Five commits. The suite was green through the fourth and red on the fifth, and the fifth's
    // work went into `git stash` on the machine that produced it.
    const accepted = (await svc.record({
      ownerId: OWNER, taskId: TASK, scopeRevision: 1,
      commit: { branch: 'orbit/k6', commitSha: E0[3].commit, treeSha: E0[3].tree, baseSha: E0_BASE },
      evidence: green(E0[3].tree), artifact: null, recordedBy: 'WORKER',
    })) as { checkpointId: string; kind: string };
    assert.equal(accepted.kind, 'ACCEPTED');

    // The stash is refused BY NAME. This is the whole of CP2: the failure is not a missing field,
    // it is a place, and the answer says so instead of naming a column.
    assert.equal(
      await svc.record({
        ownerId: OWNER, taskId: TASK, scopeRevision: 1,
        commit: { branch: 'orbit/k6', commitSha: E0[4].commit, treeSha: E0[4].tree, baseSha: E0_BASE },
        evidence: green(E0[4].tree, { passed: 2870, failed: 6 }),
        artifact: { kind: 'LOCAL_STASH', ref: 'stash@{0}', digest: BUNDLE },
        recordedBy: 'WORKER',
      }),
      'CHECKPOINT_ARTIFACT_NOT_PORTABLE',
    );
    // Recorded properly, the red work is kept — and kept somewhere a second machine can get it.
    const red = (await svc.record({
      ownerId: OWNER, taskId: TASK, scopeRevision: 1,
      commit: { branch: 'orbit/k6', commitSha: E0[4].commit, treeSha: E0[4].tree, baseSha: E0_BASE },
      evidence: green(E0[4].tree, { passed: 2870, failed: 6 }),
      artifact: { kind: 'GIT_BUNDLE', ref: 'bundle:k6:e0-5', digest: BUNDLE },
      recordedBy: 'WORKER',
    })) as { checkpointId: string; kind: string };
    assert.equal(red.kind, 'WIP_RED');

    // --- What a second Runner can do with it --------------------------------------------------
    // AC1: everything needed to rebuild the state, present and non-null. A machine that has never
    // seen this branch fetches `artifact_ref`, checks its bytes against `artifact_digest`, applies
    // it on `base_sha`, and confirms it got `tree_sha`.
    const all = await svc.list(OWNER, TASK);
    const redRow = all.find((c) => c.id === red.checkpointId)!;
    for (const [field, value] of Object.entries({
      commitSha: redRow.commitSha, treeSha: redRow.treeSha, baseSha: redRow.baseSha,
      artifactKind: redRow.artifactKind, artifactRef: redRow.artifactRef,
      artifactDigest: redRow.artifactDigest,
    })) {
      assert.ok(value, `a second Runner cannot rebuild this without ${field}`);
    }
    assert.equal(redRow.artifactKind, 'GIT_BUNDLE');

    // AC2, first half: the red work is not lost.
    assert.equal(all.length, 2);
    // AC2, second half: and it is not what anything downstream stands on.
    const baseline = await svc.latestAccepted(prisma(client), OWNER, TASK);
    assert.equal(baseline?.id, accepted.checkpointId);
    assert.equal(baseline?.commitSha, E0[3].commit, 'the next task starts from the fourth commit');

    // --- The merge gate -----------------------------------------------------------------------
    // The branch tip is the RED fifth commit, so merging the branch merges work that failed.
    const tipGate = await svc.landingGate(prisma(client), {
      ownerId: OWNER, taskId: TASK, sourceSha: E0[4].commit,
    });
    assert.equal(tipGate?.decision, 'BRANCH_TIP_MISMATCH');
    // And the database refuses to record it as landed even if a writer went around the gate.
    await assert.rejects(
      receipt(client, { result: 'MERGED', sourceSha: E0[4].commit, checkpointId: red.checkpointId }),
      /CHECKPOINT_NOT_ACCEPTED/,
    );
    // The verified commit merges, and its evidence has to be the evidence it was accepted on.
    assert.equal(
      (await svc.landingGate(prisma(client), {
        ownerId: OWNER, taskId: TASK, sourceSha: E0[3].commit,
        evidenceDigest: checkpointEvidenceDigest(green(E0[3].tree)),
      }))?.decision,
      'ALLOWED',
    );
    assert.equal(
      (await svc.landingGate(prisma(client), {
        ownerId: OWNER, taskId: TASK, sourceSha: E0[3].commit,
        evidenceDigest: checkpointEvidenceDigest(green(E0[3].tree, { passed: 1 })),
      }))?.decision,
      'TEST_EVIDENCE_MISMATCH',
    );

    // --- And the landing, once ----------------------------------------------------------------
    const receiptId = await receipt(client, {
      sourceSha: E0[3].commit,
      checkpointId: accepted.checkpointId,
    });
    const settled = await mergeDispatchGate(prisma(client), {
      ownerId: OWNER, sessionId: SESSION, taskId: TASK, targetBranch: 'main',
    });
    assert.equal(settled.decision, 'ALREADY_LANDED');
    assert.equal((settled as { receiptId: string }).receiptId, receiptId);
    assert.equal(await count(client, 'session_merge_receipt'), 1);
  } finally {
    await client.end();
  }
});
