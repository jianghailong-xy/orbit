/**
 * §13.1 AG7 / §13.2 V8 on real PostgreSQL: what happens to an aggregate parent nothing can finish.
 *
 * The pure and decision-level halves are covered by `project-completion-gap.spec.ts`. What only a
 * database can decide, and what those specs therefore cannot, is everything here:
 *
 *  - **The permanent key really is permanent.** Exactly-once, retry-after-a-no-op-refusal and
 *    file-again-after-the-check-went-away are three statements about a UNIQUE index and a row
 *    count, not about a function's return value.
 *  - **The commit point re-reads the world.** Every clause the plan was made on is asked again
 *    under `FOR UPDATE`, and the only way to prove a re-read happens is to change the row between
 *    the two and watch the answer change.
 *  - **The filed check actually runs, and the parent still does not.** `dispatch_authority`, the
 *    verification-subject gate and AG6's own guard are three different mechanisms in two layers,
 *    and only a database holds all three at once.
 *
 * Give it its own database — it runs `prisma migrate deploy` against the real schema rather than
 * hand-building a subset, because a subset would only ever agree with itself:
 *
 *   docker run -d --name pcc-h0r-pg -e POSTGRES_USER=pcch0r -e POSTGRES_PASSWORD=pcch0r \
 *     -e POSTGRES_DB=pcch0r -p 127.0.0.1:55841:5432 --tmpfs /var/lib/postgresql/data postgres:16-alpine
 *   DATABASE_URL=postgresql://pcch0r:pcch0r@127.0.0.1:55841/pcch0r npx prisma migrate deploy
 *   COORDINATOR_PG_URL=postgresql://pcch0r:pcch0r@127.0.0.1:55841/pcch0r \
 *     COORDINATOR_PG_EXPECTED_DATABASE=pcch0r COORDINATOR_PG_EXPECTED_USER=pcch0r \
 *     node --test --test-concurrency=1 build/projects/project-completion-gap.pg.spec.js
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { PrismaClient } from '@prisma/client';
import { uuidToBase62 } from '@orbit/shared';
import { assertCoordinatorPgUrlIsIsolated } from './coordinator-pg-test-safety';
import type { PlannedVerificationFiling } from './project-completion-gap';
import { ProjectVerificationFilingService } from './project-verification-filing.service';
import type { ProjectReconcileLease } from './project-reconcile.service';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

/** A fresh namespace per RUN, so a second run against the same database is as green as the first. */
const OWNER = randomUUID();
const OTHER_OWNER = randomUUID();
const RUNNER = randomUUID();
const CATALOG = {
  claude: [{ value: 'claude-opus-5', label: 'Claude Opus 5' }],
  codex: [{ value: 'gpt-5.6-sol', label: 'GPT-5.6 Sol' }],
};

type Db = PrismaClient;

interface Fixture {
  projectId: string;
  parentId: string;
  childId: string;
  verifierAgent: string;
  workerAgent: string;
  lease: ProjectReconcileLease;
}

async function seedOwner(db: Db): Promise<void> {
  await db.$executeRawUnsafe(
    `INSERT INTO "user" ("id","email","name","password_hash")
     VALUES ($1,$2,'h0r','x'),($3,$4,'h0r','x') ON CONFLICT ("id") DO NOTHING`,
    OWNER, `h0r-${OWNER}@example.test`, OTHER_OWNER, `h0r-${OTHER_OWNER}@example.test`,
  );
  await db.$executeRawUnsafe(
    `INSERT INTO "runner" ("id","owner_id","name","status","token_hash","model_catalog",
       "capabilities_reported_at")
     VALUES ($1,$2,'h0r','ONLINE','h0r-token',$3::jsonb,now()) ON CONFLICT ("id") DO NOTHING`,
    RUNNER, OWNER, JSON.stringify(CATALOG),
  );
}

async function agent(db: Db, over: {
  ownerId?: string; fallbacks?: unknown; model?: string | null; enabled?: boolean;
} = {}): Promise<string> {
  const id = randomUUID();
  await db.$executeRawUnsafe(
    `INSERT INTO "workspace" ("id","owner_id","name","runner_id","model","provider_fallbacks",
       "can_create_tasks","can_delegate","enabled")
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,true,true,$7)`,
    id, over.ownerId ?? OWNER, `agent-${id.slice(0, 8)}`, RUNNER,
    over.model === undefined ? 'claude-opus-5' : over.model,
    JSON.stringify(over.fallbacks ?? [{ provider: 'claude' }]),
    over.enabled ?? true,
  );
  return id;
}

/**
 * A `VERIFICATION_PASSED` roll-up whose one subtask is DONE, a coordinator that did not run it,
 * and a worker that did — the world V8 exists for, built through the real schema.
 */
async function fixture(
  db: Db,
  over: { automationPolicy?: string; coordinatorEnabled?: boolean } = {},
): Promise<Fixture> {
  const projectId = randomUUID();
  const verifierAgent = await agent(db);
  const workerAgent = await agent(db);
  await db.$executeRawUnsafe(
    `INSERT INTO "project" ("id","owner_id","title","coordinator_enabled","automation_policy",
       "updated_at")
     VALUES ($1,$2,'h0r',$4,$3::"project_automation_policy",now())`,
    projectId, OWNER, over.automationPolicy ?? 'AUTO', over.coordinatorEnabled ?? true,
  );
  // The runtime row is created by the project's own trigger; this is the belt-and-braces half.
  await db.$executeRawUnsafe(
    `INSERT INTO "project_runtime" ("project_id","updated_at") VALUES ($1,now())
       ON CONFLICT ("project_id") DO NOTHING`, projectId,
  );
  await db.$executeRawUnsafe(
    `INSERT INTO "project_member" ("id","project_id","agent_id","role")
     VALUES ($1,$2,$3,'COORDINATOR'),($4,$2,$5,'MEMBER')`,
    randomUUID(), projectId, verifierAgent, randomUUID(), workerAgent,
  );
  const parentId = await task(db, {
    projectId, policy: 'VERIFICATION_PASSED', assignee: workerAgent,
  });
  const childId = await task(db, {
    projectId, parent: parentId, status: 'DONE', assignee: workerAgent,
  });
  return {
    projectId,
    parentId,
    childId,
    verifierAgent,
    workerAgent,
    lease: {
      projectId, holder: randomUUID(), fencingToken: 1n,
      expiresAt: new Date(Date.now() + 60_000),
    },
  };
}

async function task(db: Db, over: {
  projectId: string; parent?: string; status?: string; policy?: string; assignee?: string | null;
  verifies?: string;
}): Promise<string> {
  const id = randomUUID();
  await db.$executeRawUnsafe(
    `INSERT INTO "task" ("id","title","status","owner_id","creator_type","creator_id","project_id",
       "parent_task_id","assignee_id","verifies_task_id","completion_policy","provider","model",
       "updated_at")
     VALUES ($1,$2,$3::"task_status",$4,'USER',$4,$5,$6,$7,$8,$9::"task_completion_policy",
       'claude','claude-sonnet-5',now())`,
    id, `t-${id.slice(0, 8)}`, over.status ?? 'OPEN', OWNER, over.projectId,
    over.parent ?? null, over.assignee ?? null, over.verifies ?? null, over.policy ?? 'MANUAL',
  );
  return id;
}

function plan(f: Fixture, over: Partial<PlannedVerificationFiling> = {}): PlannedVerificationFiling {
  return {
    subjectTaskId: uuidToBase62(f.parentId),
    verifierAgentId: uuidToBase62(f.verifierAgent),
    workspaceId: uuidToBase62(f.verifierAgent),
    runnerId: uuidToBase62(RUNNER),
    provider: 'claude',
    providerId: null,
    runtime: 'claude',
    providerScope: 'BUILTIN',
    model: 'claude-opus-5',
    parentTaskId: null,
    configRevision: '0',
    generation: '1',
    authorization: {
      v: 1,
      requestHash: 'unused-by-the-effect',
      request: {
        v: 1,
        sourceDecisionInputHash: 'h'.repeat(64),
        idempotencyKey: `pc:v1:${f.projectId}:file-verification:${f.parentId}:1`,
        evaluatedAt: '2026-08-22T00:00:00.000Z',
        action: 'FILE_VERIFICATION_TASK',
        requiredPermission: 'CREATE_TASK',
        project: {
          id: uuidToBase62(f.projectId), status: 'OPEN', coordinatorEnabled: true,
          automationPolicy: 'AUTO', configRevision: '0', inFlightTasks: 0, maxConcurrentTasks: 3,
          coordinatorSessionsStartedLast24h: 0, sessionBudgetPerDay: null,
        },
        principal: {
          agentId: uuidToBase62(f.verifierAgent),
          coordinatorAgentId: uuidToBase62(f.verifierAgent),
          memberRole: 'COORDINATOR', agentEnabled: true, agentDeleted: false,
          canCoordinate: true, canCreateTasks: true, canDelegate: true,
        },
        approval: { state: 'NONE', targetIdempotencyKey: null },
      },
      result: {
        v: 1, decision: 'ALLOW', reasonCode: 'POLICY_ALLOWED',
        policyRow: 'COORDINATOR_ROUTINE', risk: 'LOW',
      },
    },
    ...over,
  };
}

/** Run the effect the way the ledger does: inside one transaction, with an action row id. */
async function file(
  db: Db,
  service: ProjectVerificationFilingService,
  f: Fixture,
  planned: PlannedVerificationFiling,
): Promise<{ refusal: unknown; taskId: string | null }> {
  return db.$transaction(async (tx) => {
    const actionId = randomUUID();
    await tx.$executeRawUnsafe(
      `INSERT INTO "project_action" ("id","project_id","idempotency_key","type","status",
         "subject_type","subject_id","fencing_token","detail","updated_at")
       VALUES ($1,$2,$3,'FILE_VERIFICATION_TASK','CLAIMED','TASK',$4,1,'{}'::jsonb,now())
       ON CONFLICT ("idempotency_key") DO NOTHING`,
      actionId, f.projectId,
      `pc:v1:${f.projectId}:file-verification:${f.parentId}:${planned.generation}`, f.parentId,
    );
    const refusal = await service.fileInTransaction(
      tx, f.lease, { decisionId: randomUUID(), planned }, actionId, new Date(),
    );
    const rows = await tx.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT "id" FROM "task" WHERE "verifies_task_id" = $1::uuid`, f.parentId,
    );
    return { refusal: refusal ?? null, taskId: rows[0]?.id ?? null };
  });
}

async function verificationsOf(db: Db, parentId: string): Promise<Array<{
  id: string; assigneeId: string | null; provider: string | null; model: string | null;
  dispatchAuthority: string; parentTaskId: string | null; idempotencyKey: string | null;
}>> {
  return db.$queryRawUnsafe(
    `SELECT "id", "assignee_id" AS "assigneeId", "provider", "model",
            "dispatch_authority"::text AS "dispatchAuthority",
            "parent_task_id" AS "parentTaskId", "idempotency_key" AS "idempotencyKey"
       FROM "task" WHERE "verifies_task_id" = $1::uuid ORDER BY "created_at"`,
    parentId,
  );
}

test('§13.1 AG7 / §13.2 V8 on real PostgreSQL', { skip, concurrency: 1 }, async (t) => {
  const { prismaClientFor } = await import('../prisma/prisma-client.js');
  assertCoordinatorPgUrlIsIsolated(URL!);
  const db = prismaClientFor(URL!);
  const service = new ProjectVerificationFilingService(db as never, {} as never);
  await seedOwner(db);
  t.after(async () => { await db.$disconnect(); });

  await t.test('the check is filed with the plan\'s engine, and it is dispatchable', async () => {
    const f = await fixture(db);
    const { refusal, taskId } = await file(db, service, f, plan(f));
    assert.equal(refusal, null);
    assert.ok(taskId);
    const filed = await verificationsOf(db, f.parentId);
    assert.equal(filed.length, 1);
    // WHO: the independent agent, not the one that ran the subtask.
    assert.equal(filed[0].assigneeId, f.verifierAgent);
    // WITH WHAT: the verification plan's engine. The subject runs `claude-sonnet-5`; this does not.
    assert.equal(filed[0].provider, 'claude');
    assert.equal(filed[0].model, 'claude-opus-5');
    // …and the column without which nothing would ever run it: §7.8's pass only takes COORDINATOR.
    assert.equal(filed[0].dispatchAuthority, 'COORDINATOR');
    // WHERE it is filed: a SIBLING of the subject, so it does not enter the subject's own children.
    assert.equal(filed[0].parentTaskId, null);
  });

  await t.test('a second reconcile of the same episode files nothing more', async () => {
    const f = await fixture(db);
    await file(db, service, f, plan(f));
    const second = await file(db, service, f, plan(f));
    assert.deepEqual((second.refusal as { refusalCode: string }).refusalCode,
      'VERIFICATION_ALREADY_FILED');
    assert.equal((await verificationsOf(db, f.parentId)).length, 1);
  });

  await t.test('the task key is the second lock: a new generation still files only one', async () => {
    // The ledger is bypassed here on purpose — this is the backstop, not the main path.
    const f = await fixture(db);
    await file(db, service, f, plan(f));
    await db.$executeRawUnsafe(
      `UPDATE "task" SET "status" = 'CANCELLED' WHERE "verifies_task_id" = $1::uuid`, f.parentId,
    );
    const again = await file(db, service, f, plan(f, { generation: '2' }));
    assert.equal(again.refusal, null, 'a cancelled check is not a live one, so the gap is back');
    const filed = await verificationsOf(db, f.parentId);
    assert.equal(filed.length, 2, 'a genuinely new episode files a genuinely new check');
    assert.notEqual(filed[0].idempotencyKey, filed[1].idempotencyKey);
    // And the SAME generation twice does not.
    const replay = await file(db, service, f, plan(f, { generation: '2' }));
    assert.equal((replay.refusal as { refusalCode: string }).refusalCode,
      'VERIFICATION_ALREADY_FILED');
    assert.equal((await verificationsOf(db, f.parentId)).length, 2);
  });

  await t.test('the permanent key is UNIQUE, so two concurrent episodes land once', async () => {
    const f = await fixture(db);
    const key = `pc:v1:${f.projectId}:file-verification:${f.parentId}:1`;
    const results = await Promise.allSettled([1, 2].map(async () => db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `INSERT INTO "project_action" ("id","project_id","idempotency_key","type","status",
           "subject_type","subject_id","fencing_token","detail","updated_at")
         VALUES ($1,$2,$3,'FILE_VERIFICATION_TASK','CLAIMED','TASK',$4,1,'{}'::jsonb,now())`,
        randomUUID(), f.projectId, key, f.parentId,
      );
      await new Promise((resolve) => { setTimeout(resolve, 50); });
    })));
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1,
      'the ledger admits one claim per generation, whatever the caller does');
  });

  await t.test('the commit point re-reads the policy: MANUAL between plan and commit refuses', async () => {
    const f = await fixture(db);
    await db.$executeRawUnsafe(
      `UPDATE "project" SET "automation_policy" = 'MANUAL' WHERE "id" = $1::uuid`, f.projectId,
    );
    const { refusal, taskId } = await file(db, service, f, plan(f));
    assert.equal((refusal as { refusalCode: string }).refusalCode, 'FILING_NOT_AUTHORIZED');
    assert.equal(taskId, null);
  });

  await t.test('a project that closed after the plan files nothing', async () => {
    // CANCELLED only: 0127's acceptance trigger refuses to let a project reach DONE without an
    // acceptance run at all, so "the project went DONE between plan and commit" is a state this
    // schema will not produce. The clause covers both; this is the half that is reachable.
    const f = await fixture(db);
    await db.$executeRawUnsafe(
      `UPDATE "project" SET "status" = 'CANCELLED' WHERE "id" = $1::uuid`, f.projectId,
    );
    const { refusal, taskId } = await file(db, service, f, plan(f));
    assert.equal((refusal as { refusalCode: string }).refusalCode, 'PROJECT_NOT_OPEN');
    assert.equal(taskId, null);
    // The ledger row this refusal belongs to is never published: the effect returned a refusal, so
    // §8.3 records it and does not APPLY.
    const actions = await db.$queryRawUnsafe<Array<{ status: string }>>(
      `SELECT "status"::text FROM "project_action" WHERE "project_id" = $1::uuid`, f.projectId,
    );
    assert.deepEqual(actions.map((a) => a.status), ['CLAIMED']);
  });

  await t.test('a project whose coordinator was switched off files nothing', async () => {
    const f = await fixture(db);
    await db.$executeRawUnsafe(
      `UPDATE "project" SET "coordinator_enabled" = false WHERE "id" = $1::uuid`, f.projectId,
    );
    const { refusal, taskId } = await file(db, service, f, plan(f));
    // Through §9.2's matrix, not through a hand-written clause: a disabled coordinator is
    // `COORDINATOR_DISABLED`, and the effect refuses on the DECISION rather than on the column.
    assert.equal((refusal as { refusalCode: string }).refusalCode, 'FILING_NOT_AUTHORIZED');
    assert.equal((refusal as { detail: { reasonCode: string } }).detail.reasonCode,
      'COORDINATOR_DISABLED');
    assert.equal(taskId, null);
  });

  await t.test('config_revision moving is enough on its own', async () => {
    const f = await fixture(db);
    await db.$executeRawUnsafe(
      `UPDATE "project" SET "config_revision" = "config_revision" + 1 WHERE "id" = $1::uuid`,
      f.projectId,
    );
    const { refusal } = await file(db, service, f, plan(f));
    assert.equal((refusal as { refusalCode: string }).refusalCode, 'PROJECT_CONFIG_CHANGED');
  });

  await t.test('an agent that acquired the work between plan and commit is refused', async () => {
    const f = await fixture(db);
    await db.$executeRawUnsafe(
      `UPDATE "task" SET "assignee_id" = $2::uuid WHERE "id" = $1::uuid`,
      f.childId, f.verifierAgent,
    );
    const { refusal, taskId } = await file(db, service, f, plan(f));
    assert.equal((refusal as { refusalCode: string }).refusalCode,
      'VERIFICATION_AGENT_NOT_ELIGIBLE');
    assert.equal(taskId, null);
  });

  await t.test('a Session on the subtree is enough, even when the assignee never moved', async () => {
    // The Session is inserted while the project's coordinator is still off, then the coordinator is
    // switched on — which is how a project that ran under the legacy sweep and later joined the
    // control loop actually looks, and the only way this schema lets a test write a task-bound
    // Session it did not dispatch itself (0130 requires a frozen execution context otherwise).
    const f = await fixture(db, { coordinatorEnabled: false });
    await db.$executeRawUnsafe(
      `INSERT INTO "session" ("id","title","prompt","owner_id","creator_id","workspace_id",
         "task_id","status","provider","starts_task_work","updated_at")
       VALUES ($1,'s','p',$2,$2,$3,$4,'SUCCEEDED','claude',false,now())`,
      randomUUID(), OWNER, f.verifierAgent, f.childId,
    );
    await db.$executeRawUnsafe(
      `UPDATE "project" SET "coordinator_enabled" = true WHERE "id" = $1::uuid`, f.projectId,
    );
    // The plan is made AFTER the flip, so `config_revision` is whatever the flip left behind.
    const revision = String((await db.$queryRawUnsafe<Array<{ r: bigint }>>(
      `SELECT "config_revision" AS "r" FROM "project" WHERE "id" = $1::uuid`, f.projectId,
    ))[0].r);
    const { refusal, taskId } = await file(db, service, f, plan(f, { configRevision: revision }));
    assert.equal((refusal as { refusalCode: string }).refusalCode,
      'VERIFICATION_AGENT_NOT_ELIGIBLE',
      'a salvage conversation on a subtask is still somebody who has seen the work');
    assert.equal(taskId, null);
  });

  await t.test('a subject taken back to MANUAL has withdrawn the request', async () => {
    const f = await fixture(db);
    await db.$executeRawUnsafe(
      `UPDATE "task" SET "completion_policy" = 'MANUAL' WHERE "id" = $1::uuid`, f.parentId,
    );
    const { refusal, taskId } = await file(db, service, f, plan(f));
    assert.equal((refusal as { refusalCode: string }).refusalCode,
      'VERIFICATION_SUBJECT_POLICY_CHANGED');
    assert.equal(taskId, null);
  });

  await t.test('a retired subject files nothing', async () => {
    const f = await fixture(db);
    await db.$executeRawUnsafe(
      `UPDATE "task" SET "terminal_reason" = 'ABANDONED', "status" = 'CANCELLED'
        WHERE "id" = $1::uuid`, f.parentId,
    );
    const { refusal } = await file(db, service, f, plan(f));
    assert.ok(['VERIFICATION_SUBJECT_RETIRED', 'VERIFICATION_SUBJECT_SETTLED']
      .includes((refusal as { refusalCode: string }).refusalCode));
  });

  // ── the engine, five ways ─────────────────────────────────────────────────────────────────────

  await t.test('a built-in slug needs no row, and a shadowing row is refused', async () => {
    const f = await fixture(db);
    const { refusal } = await file(db, service, f, plan(f, { providerId: uuidToBase62(randomUUID()) }));
    assert.equal((refusal as { detail: { reason: string } }).detail.reason, 'SLUG_IS_NOT_BUILTIN');
  });

  await t.test('a slug that is not a built-in runtime is not one by default', async () => {
    const f = await fixture(db);
    const { refusal, taskId } = await file(db, service, f, plan(f, {
      provider: 'not-a-runtime', runtime: 'not-a-runtime', providerScope: 'BUILTIN',
    }));
    assert.equal((refusal as { detail: { reason: string } }).detail.reason,
      'UNKNOWN_BUILTIN_PROVIDER');
    assert.equal(taskId, null);
  });

  await t.test('a configured provider this owner can see is filed on its runtime', async () => {
    const f = await fixture(db);
    const providerId = randomUUID();
    await db.$executeRawUnsafe(
      `INSERT INTO "model_provider" ("id","slug","label","base_url","api_key_enc","runtime",
         "owner_id","enabled","updated_at")
       VALUES ($1,$2,'DeepSeek','https://x.test','enc','claude',$3,true,now())`,
      providerId, `ds-${providerId.slice(0, 8)}`, OWNER,
    );
    const slug = (await db.$queryRawUnsafe<Array<{ slug: string }>>(
      `SELECT "slug" FROM "model_provider" WHERE "id" = $1::uuid`, providerId,
    ))[0].slug;
    const { refusal, taskId } = await file(db, service, f, plan(f, {
      provider: slug, providerId: uuidToBase62(providerId), runtime: 'claude',
      providerScope: 'PROJECT_OWNER',
    }));
    assert.equal(refusal, null);
    assert.ok(taskId);
    assert.equal((await verificationsOf(db, f.parentId))[0].provider, slug);
  });

  await t.test('a SHARED provider is visible, and a foreign owner\'s is not', async () => {
    for (const [ownerId, scope, expected] of [
      [null, 'SHARED', null],
      [OTHER_OWNER, 'PROJECT_OWNER', 'PROVIDER_BELONGS_TO_ANOTHER_OWNER'],
    ] as const) {
      const f = await fixture(db);
      const providerId = randomUUID();
      await db.$executeRawUnsafe(
        `INSERT INTO "model_provider" ("id","slug","label","base_url","api_key_enc","runtime",
           "owner_id","enabled","updated_at")
         VALUES ($1,$2,'P','https://x.test','enc','claude',$3,true,now())`,
        providerId, `p-${providerId.slice(0, 8)}`, ownerId,
      );
      const slug = (await db.$queryRawUnsafe<Array<{ slug: string }>>(
        `SELECT "slug" FROM "model_provider" WHERE "id" = $1::uuid`, providerId,
      ))[0].slug;
      const { refusal, taskId } = await file(db, service, f, plan(f, {
        provider: slug, providerId: uuidToBase62(providerId), runtime: 'claude',
        providerScope: scope,
      }));
      if (expected === null) {
        assert.equal(refusal, null, scope);
        assert.ok(taskId, scope);
      } else {
        assert.equal((refusal as { detail: { reason: string } }).detail.reason, expected, scope);
        assert.equal(taskId, null, scope);
      }
    }
  });

  await t.test('a model the runner does not serve is refused at the commit point too', async () => {
    const f = await fixture(db);
    const { refusal, taskId } = await file(db, service, f, plan(f, { model: 'claude-gone-6' }));
    assert.equal((refusal as { detail: { reason: string } }).detail.reason,
      'MODEL_NOT_IN_RUNNER_CATALOG');
    assert.equal(taskId, null);
  });

  await t.test('a corrupt cross-project verifies_task_id does not answer for this subject', async () => {
    const f = await fixture(db);
    const other = await fixture(db);
    // A row pointing at this subject from ANOTHER project — the kind of thing a raw write or an
    // older service rule can leave behind. It must neither satisfy the gap nor refuse the filing.
    await db.$executeRawUnsafe(
      `INSERT INTO "task" ("id","title","status","owner_id","creator_type","creator_id",
         "project_id","verifies_task_id","updated_at")
       VALUES ($1,'stray','OPEN',$2,'USER',$2,$3,$4,now())`,
      randomUUID(), OWNER, other.projectId, f.parentId,
    );
    const { refusal, taskId } = await file(db, service, f, plan(f));
    assert.equal(refusal, null, 'a check in another project is not this project\'s check');
    assert.ok(taskId);
  });

  // ── the two ends of the loop, on one database ────────────────────────────────────────────────

  await t.test('the roll-up gets no Session of its own, before or after the check exists', async () => {
    const f = await fixture(db);
    for (const phase of ['before', 'after']) {
      if (phase === 'after') await file(db, service, f, plan(f));
      await assert.rejects(
        db.$executeRawUnsafe(
          `INSERT INTO "session" ("id","title","prompt","owner_id","creator_id","workspace_id",
             "task_id","status","provider","starts_task_work","dispatch_origin","updated_at")
           VALUES ($1,'s','p',$2,$2,$3,$4,'PENDING','claude',true,'PROJECT_COORDINATOR',now())`,
          randomUUID(), OWNER, f.workerAgent, f.parentId,
        ),
        /TASK_AGGREGATE_PARENT/,
        `a work Session on the roll-up must be refused ${phase} the check is filed`,
      );
    }
  });

  await t.test('a PASS on the filed check is what completes the roll-up', async () => {
    const f = await fixture(db);
    const { taskId } = await file(db, service, f, plan(f));
    assert.ok(taskId);
    const { planTaskAggregation } = await import('./task-aggregation.js');
    const facts = async () => (await db.$queryRawUnsafe<Array<{
      id: string; status: string; parentTaskId: string | null; completionPolicy: string;
      verifiesTaskId: string | null; verdict: string | null;
    }>>(
      `SELECT "id","status"::text,"parent_task_id" AS "parentTaskId",
              "completion_policy"::text AS "completionPolicy",
              "verifies_task_id" AS "verifiesTaskId","verdict"::text AS "verdict"
         FROM "task" WHERE "project_id" = $1::uuid`, f.projectId,
    )).map((row) => ({
      id: row.id,
      status: row.status as 'OPEN',
      parentTaskId: row.parentTaskId,
      completionPolicy: row.completionPolicy as 'MANUAL',
      verifiesTaskId: row.verifiesTaskId,
      verdict: row.verdict as null,
      supersededByTaskId: null,
    }));
    // Filed but not concluded: the subject is waiting on it, and no gap is reported.
    const waiting = planTaskAggregation(await facts());
    assert.deepEqual(waiting.completionGaps, []);
    assert.deepEqual(waiting.aggregations, []);
    await db.$executeRawUnsafe(
      `UPDATE "task" SET "status" = 'DONE', "verdict" = 'PASS' WHERE "id" = $1::uuid`, taskId,
    );
    const settled = planTaskAggregation(await facts());
    assert.deepEqual(
      settled.aggregations.map((a) => [a.taskId, a.to, a.reason]),
      [[f.parentId, 'DONE', 'VERIFICATION_PASSED']],
    );
  });

  await t.test('the filed check is what the pass then selects, over real rows', async () => {
    // The end-to-end half, read off the DATABASE rather than off a fixture: capture the world the
    // way a reconcile does, and ask §7.8's planner what it would dispatch. This is where AG6 and
    // AG8 meet — the roll-up is skipped as an aggregate parent while the check filed against it is
    // a candidate, which is the pair of answers that makes the loop able to finish the roll-up.
    const { ProjectDecisionService } = await import('./project-decision.service.js');
    const { selectDispatchableTasks } = await import('./project-dispatch-pass.js');
    const f = await fixture(db);
    const { taskId } = await file(db, service, f, plan(f));
    assert.ok(taskId);
    const decisions = new ProjectDecisionService(db as never);
    // §6.1 S5: a snapshot has to be taken under one MVCC view, which the service checks for.
    const captured = await db.$transaction(
      async (tx) => decisions.capture(tx, f.projectId, new Date()),
      { isolationLevel: 'RepeatableRead' },
    );
    // The marker the capture stamps, without which the AG8 exception below is versioned off.
    assert.deepEqual(captured.input.world.protocol, { completionGaps: true });
    const selection = selectDispatchableTasks(captured.input);
    assert.deepEqual(selection.candidates.map((c) => c.taskId), [uuidToBase62(taskId)]);
    assert.equal(
      selection.skipped.find((s) => s.taskId === uuidToBase62(f.parentId))?.reason,
      'TASK_AGGREGATE_PARENT',
    );
  });

  await t.test('a provider only a verifier fallback names is still in the snapshot', async () => {
    // The projection widening, over real rows: this slug is used by no task and no session in the
    // project, so the reference-only projection left it out — and a correctly configured team was
    // told for ever that it had no runnable verifier.
    const { ProjectDecisionService } = await import('./project-decision.service.js');
    const { planCompletionGaps } = await import('./project-completion-gap.js');
    const { completionGapPlan } = await import('./project-decision.service.js');
    const f = await fixture(db);
    const providerId = randomUUID();
    const slug = `only-fallback-${providerId.slice(0, 8)}`;
    await db.$executeRawUnsafe(
      `INSERT INTO "model_provider" ("id","slug","label","base_url","api_key_enc","runtime",
         "owner_id","enabled","updated_at")
       VALUES ($1,$2,'Only','https://x.test','enc','claude',$3,true,now())`,
      providerId, slug, OWNER,
    );
    await db.$executeRawUnsafe(
      `UPDATE "workspace" SET "provider_fallbacks" = $2::jsonb WHERE "id" = $1::uuid`,
      f.verifierAgent, JSON.stringify([{ provider: slug, model: 'claude-opus-5' }]),
    );
    const decisions = new ProjectDecisionService(db as never);
    // §6.1 S5: a snapshot has to be taken under one MVCC view, which the service checks for.
    const captured = await db.$transaction(
      async (tx) => decisions.capture(tx, f.projectId, new Date()),
      { isolationLevel: 'RepeatableRead' },
    );
    assert.ok(
      captured.input.world.providers.some((p) => p.slug === slug),
      'a slug only a team member configures still has to be answerable',
    );
    const filings = planCompletionGaps(captured.input, completionGapPlan(captured.input)).filings;
    assert.equal(filings.length, 1);
    assert.equal(filings[0].provider, slug);
    assert.equal(filings[0].runtime, 'claude', 'the borrowed runtime is what the runner reports');
    assert.equal(filings[0].providerScope, 'PROJECT_OWNER');
    assert.equal(filings[0].verifierAgentId, uuidToBase62(f.verifierAgent));
    // …and the plan it produced is one this database accepts.
    const filed = await file(db, service, f, plan(f, {
      provider: slug, providerId: filings[0].providerId, runtime: 'claude',
      providerScope: 'PROJECT_OWNER',
    }));
    assert.equal(filed.refusal, null);
  });

  await t.test('the two blocker kinds are values this database accepts', async () => {
    const f = await fixture(db);
    for (const kind of [
      'AGGREGATE_PARENT_UNSATISFIABLE', 'SUCCESSOR_OUTSIDE_SUBTREE', 'VERIFICATION_REQUIRED',
    ]) {
      await db.$executeRawUnsafe(
        `INSERT INTO "project_blocker" ("id","project_id","kind","owner","recovery","severity",
           "required_action","next_check_at","subject_type","subject_id","dedupe_key",
           "lifecycle_generation","condition_version","first_seen_at","last_seen_at","detail",
           "updated_at")
         VALUES ($1,$2,$3,'USER','HUMAN','CRITICAL','do it',now(),'TASK',$4,$5,1,'v',now(),now(),
           '{}'::jsonb,now())`,
        randomUUID(), f.projectId, kind, f.parentId, `${kind}:TASK:${f.parentId}`,
      );
    }
    const rows = await db.$queryRawUnsafe<Array<{ kind: string }>>(
      `SELECT "kind" FROM "project_blocker" WHERE "project_id" = $1::uuid ORDER BY "kind"`,
      f.projectId,
    );
    assert.deepEqual(rows.map((r) => r.kind),
      ['AGGREGATE_PARENT_UNSATISFIABLE', 'SUCCESSOR_OUTSIDE_SUBTREE', 'VERIFICATION_REQUIRED']);
    await assert.rejects(db.$executeRawUnsafe(
      `INSERT INTO "project_blocker" ("id","project_id","kind","owner","recovery","severity",
         "required_action","next_check_at","subject_type","subject_id","dedupe_key",
         "lifecycle_generation","condition_version","first_seen_at","last_seen_at","detail",
         "updated_at")
       VALUES ($1,$2,'NOT_A_KIND','USER','HUMAN','CRITICAL','x',now(),'TASK',$3,$4,1,'v',now(),
         now(),'{}'::jsonb,now())`,
      randomUUID(), f.projectId, f.parentId, `NOT_A_KIND:TASK:${f.parentId}`,
    ), /project_blocker_kind_chk/);
  });
});
