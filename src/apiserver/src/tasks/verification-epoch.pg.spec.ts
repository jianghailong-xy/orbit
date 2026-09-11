/**
 * §13.3 DEP on real PostgreSQL: the three spellings of one rule, over the same rows.
 *
 * `verification-dependency.spec.ts` covers the pure predicate and `project-dispatch-pass.spec.ts`
 * covers the planner reading it off a snapshot. Neither can decide what is here:
 *
 *  - **The SQL and the TypeScript agree.** `verificationEpochOpenSql` runs in the three legacy
 *    sweeps and at §9.2's commit point; `verificationEpochGate` runs in the planner, the task page
 *    and the Run button. A rule with two implementations has two opinions until something makes
 *    them answer the same world at the same instant, and only a database can be that world.
 *  - **The window between the verdict landing and it taking effect is real.** The only way to prove
 *    nothing downstream escapes through it is to hold a transaction open across it and ask.
 *
 * Give it its own database — it runs `prisma migrate deploy` against the real schema, because a
 * hand-built subset would only ever agree with itself:
 *
 *   docker run -d --name pcc-h0g-pg -e POSTGRES_USER=pcch0g -e POSTGRES_PASSWORD=pcch0g \
 *     -e POSTGRES_DB=pcch0g -p 127.0.0.1:55913:5432 --tmpfs /var/lib/postgresql/data postgres:16-alpine
 *   DATABASE_URL=postgresql://pcch0g:pcch0g@127.0.0.1:55913/pcch0g npx prisma migrate deploy
 *   COORDINATOR_PG_URL=postgresql://pcch0g:pcch0g@127.0.0.1:55913/pcch0g \
 *     COORDINATOR_PG_EXPECTED_DATABASE=pcch0g COORDINATOR_PG_EXPECTED_USER=pcch0g \
 *     COORDINATOR_PG_EXPECTED_SYSTEM_IDENTIFIER=$(docker exec pcc-h0g-pg psql -U pcch0g -tAc \
 *       'SELECT system_identifier FROM pg_control_system()') \
 *     node --test --test-concurrency=1 build/tasks/verification-epoch.pg.spec.js
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Client } from 'pg';
import type { PrismaClient } from '@prisma/client';
import { TaskStatus } from '@orbit/shared';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import {
  DependencyState,
  computeDependencyState,
  dependenciesSatisfiedSql,
  dependencyEpochGate,
  dependencyEpochStalled,
  dependencySatisfied,
} from './task-dependencies';
import {
  VerificationEpochGate,
  verificationEpochOpenSql,
} from './verification-dependency';
import { loadVerificationEpochGates } from './verification-epoch-read';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

/** A fresh namespace per RUN, so a second run against the same database is as green as the first. */
const OWNER = randomUUID();
const RUNNER = randomUUID();

type Db = PrismaClient;

interface World {
  projectId: string;
  agentId: string;
  subjectId: string;
  checkId: string;
  /** Depends on the CHECK — the legacy spelling, resolved to the same epoch. */
  downstreamId: string;
  /** Depends on the SUBJECT — the spelling the API tells callers to write. */
  subjectDownstreamId: string;
}

interface CheckShape {
  /** The check's own row. */
  status?: string;
  verdict?: string | null;
  verdictRevision?: number;
  supersededBy?: string | null;
  terminalReason?: string | null;
  /** Its run, or none at all. */
  run?: {
    status?: string;
    endReason?: string | null;
    completedAt?: boolean;
    archivedAt?: boolean;
    deleted?: boolean;
  } | null;
  subjectStatus?: string;
}

async function seedOwner(db: Db): Promise<void> {
  await db.$executeRawUnsafe(
    `INSERT INTO "user" ("id","email","name","password_hash")
     VALUES ($1,$2,'h0g','x') ON CONFLICT ("id") DO NOTHING`,
    OWNER, `h0g-${OWNER}@example.test`,
  );
  await db.$executeRawUnsafe(
    `INSERT INTO "runner" ("id","owner_id","name","status","token_hash","capabilities_reported_at")
     VALUES ($1,$2,'h0g','ONLINE','h0g-token',now()) ON CONFLICT ("id") DO NOTHING`,
    RUNNER, OWNER,
  );
}

async function task(db: Db, over: {
  projectId: string; status?: string; verifies?: string; assignee?: string | null;
  verdict?: string | null; verdictRevision?: number;
  supersededBy?: string | null; terminalReason?: string | null;
  /** Force a specific id, so "newer" and "older" are decidable rather than accidental. */
  id?: string;
}): Promise<string> {
  const id = over.id ?? randomUUID();
  await db.$executeRawUnsafe(
    `INSERT INTO "task" ("id","title","status","owner_id","creator_type","creator_id","project_id",
       "assignee_id","verifies_task_id","verdict","verdict_revision","updated_at","completion_criterion")
     VALUES ($1,$2,$3::"task_status",$4,'USER',$4,$5,$6,$7,$8::"task_verdict",$9,now(),'EVIDENCE_JUDGMENT')`,
    id, `t-${id.slice(0, 8)}`, over.status ?? 'OPEN', OWNER, over.projectId,
    over.assignee ?? null, over.verifies ?? null, over.verdict ?? null,
    over.verdictRevision ?? 0,
  );
  // Written second: 0128's guard requires the subject to be terminal before it may name a
  // successor, and the INSERT above is what makes it so.
  if (over.supersededBy !== undefined || over.terminalReason !== undefined) {
    await db.$executeRawUnsafe(
      `UPDATE "task" SET "superseded_by_task_id" = $2::uuid, "terminal_reason" = $3::text,
              "superseded_at" = CASE WHEN $2::uuid IS NULL AND $3::text IS NULL
                                     THEN NULL ELSE now() END
        WHERE "id" = $1::uuid`,
      id, over.supersededBy ?? null, over.terminalReason ?? null,
    );
  }
  return id;
}

/**
 * subject (DONE) ← check (the verification), with a downstream task on EACH spelling of the edge.
 *
 * Both are asserted in lockstep throughout: `dependsOn: subject` is what the API tells callers to
 * write and what the incident actually had (H1 and L1 named H0, not H0V), and `dependsOn: check` is
 * the older spelling that has to resolve to the same epoch rather than to "that one run ended".
 */
async function world(db: Db, shape: CheckShape = {}): Promise<World> {
  const projectId = randomUUID();
  const agentId = randomUUID();
  await db.$executeRawUnsafe(
    `INSERT INTO "workspace" ("id","owner_id","name","runner_id","can_create_tasks","can_delegate")
     VALUES ($1,$2,$3,$4,true,true)`,
    agentId, OWNER, `agent-${agentId.slice(0, 8)}`, RUNNER,
  );
  await db.$executeRawUnsafe(
    `INSERT INTO "project" ("id","owner_id","title","coordinator_enabled","automation_policy",
       "updated_at")
     VALUES ($1,$2,'h0g',true,'AUTO'::"project_automation_policy",now())`,
    projectId, OWNER,
  );
  await db.$executeRawUnsafe(
    `INSERT INTO "project_runtime" ("project_id","updated_at") VALUES ($1,now())
       ON CONFLICT ("project_id") DO NOTHING`, projectId,
  );
  await db.$executeRawUnsafe(
    `INSERT INTO "project_member" ("id","project_id","agent_id","role")
     VALUES ($1,$2,$3,'COORDINATOR')`,
    randomUUID(), projectId, agentId,
  );
  const subjectId = await task(db, {
    projectId, status: shape.subjectStatus ?? 'DONE', assignee: agentId,
  });
  const checkId = await addCheck(db, projectId, subjectId, agentId, shape);
  const downstreamId = await task(db, { projectId, assignee: agentId });
  const subjectDownstreamId = await task(db, { projectId, assignee: agentId });
  await db.$executeRawUnsafe(
    `INSERT INTO "task_dependency" ("id","task_id","depends_on_task_id")
     VALUES ($1,$2,$3),($4,$5,$6)`,
    randomUUID(), downstreamId, checkId,
    randomUUID(), subjectDownstreamId, subjectId,
  );
  return { projectId, agentId, subjectId, checkId, downstreamId, subjectDownstreamId };
}

/** One check of `subjectId`, with its run exactly as `shape` asks for it. */
async function addCheck(
  db: Db,
  projectId: string,
  subjectId: string,
  agentId: string,
  shape: CheckShape,
  id?: string,
): Promise<string> {
  const revision = shape.verdictRevision ?? 1;
  const status = shape.status ?? 'DONE';
  const verdict = shape.verdict === undefined ? 'FAIL' : shape.verdict;
  // `[K5]`: migration 0141 refuses a check REACHING `DONE` with no verdict, which is the shape
  // several cases below exist to test the gate ON. Those rows are legacy data — written by a binary
  // that predates the trigger, and still on disk — so the fixture creates them the way legacy data
  // came to exist: with the trigger off. Turning it off around the INSERT and back on immediately
  // is deliberate; leaving it off would stop this file testing the product's real table.
  const legacyShape = status === 'DONE' && verdict === null;
  if (legacyShape) {
    await db.$executeRawUnsafe(
      `ALTER TABLE "task" DISABLE TRIGGER "task_verification_verdict_atomic_insert"`);
  }
  const checkId = await task(db, {
    id,
    projectId,
    status,
    verifies: subjectId,
    assignee: agentId,
    verdict,
    verdictRevision: revision,
    ...(shape.supersededBy !== undefined ? { supersededBy: shape.supersededBy } : {}),
    ...(shape.terminalReason !== undefined ? { terminalReason: shape.terminalReason } : {}),
  }).finally(async () => {
    if (legacyShape) {
      await db.$executeRawUnsafe(
        `ALTER TABLE "task" ENABLE TRIGGER "task_verification_verdict_atomic_insert"`);
    }
  });
  const run = shape.run === undefined ? {} : shape.run;
  if (run) {
    // `dispatch_origin = 'USER'`: migration 0122's boundary refuses a Session inserted straight
    // onto a COORDINATOR-authority task, and `dispatch_authority` is a DERIVED column the database
    // maintains (§7.7 D12) — a task in a coordinator-enabled Project is COORDINATOR whatever this
    // fixture writes. A person's run is the one shape that may be written directly, and what §13.3
    // DEP3 reads off it — status, end reason, lifecycle — is identical either way.
    await db.$executeRawUnsafe(
      `INSERT INTO "session" ("id","owner_id","workspace_id","task_id","title","prompt","creator_id","provider","status",
         "end_reason","completed_at","archived_at","deleted_at","starts_task_work",
         "dispatch_origin","updated_at")
       VALUES ($1,$2,$3,$4,'check run','run the check',$2,'claude',$5::"run_status",$6,
         CASE WHEN $7 THEN now() END, CASE WHEN $8 THEN now() END,
         CASE WHEN $9 THEN now() END, true, 'USER'::"session_dispatch_origin", now())`,
      randomUUID(), OWNER, agentId, checkId, run.status ?? 'SUCCEEDED',
      run.endReason === undefined ? 'task_done' : run.endReason,
      run.completedAt ?? true, run.archivedAt ?? false, run.deleted ?? false,
    );
  }
  return checkId;
}

/**
 * Write a verdict the way the check's own turn does. §13.2 V7's `task_verdict_revision_advance`
 * trigger advances the revision on the way in, so a PASS written here is a revisioned one.
 */
async function recordVerdict(db: Db, checkId: string, verdict: string): Promise<void> {
  await db.$executeRawUnsafe(
    `UPDATE "task" SET "verdict" = $2::"task_verdict", "updated_at" = now() WHERE "id" = $1::uuid`,
    checkId, verdict,
  );
}

// ---------------------------------------------------------------------------
// The three spellings, asked of one world
// ---------------------------------------------------------------------------

/** DEP0's SQL half, as the sweeps ask it: is this task's whole prerequisite set satisfied? */
async function runnableBySql(db: Db, taskId: string): Promise<boolean> {
  const rows = await db.$queryRawUnsafe<Array<{ ok: boolean }>>(
    `SELECT ${dependenciesSatisfiedSql('t')} AS ok FROM "task" t WHERE t."id" = $1::uuid`,
    taskId,
  );
  return rows[0].ok;
}

/** The same question, asked of the epoch fragment directly about one check. */
async function epochOpenBySql(db: Db, checkId: string): Promise<boolean> {
  const rows = await db.$queryRawUnsafe<Array<{ ok: boolean }>>(
    `SELECT ${verificationEpochOpenSql('t')} AS ok FROM "task" t WHERE t."id" = $1::uuid`,
    checkId,
  );
  return rows[0].ok;
}

/** DEP0's TypeScript half, about one row's epoch. */
async function gateByTs(db: Db, taskId: string): Promise<VerificationEpochGate | null | undefined> {
  const epochs = await loadVerificationEpochGates(db, OWNER, [taskId]);
  return epochs.has(taskId) ? epochs.get(taskId)!.gate : undefined;
}

/**
 * DEP0's TypeScript half, end to end: the gate map fed to the same `dependencySatisfied` the
 * Coordinator's pass calls, over the rows this Project actually holds.
 *
 * The gate alone is not the answer — a CANCELLED check has no gate at all and is still an unmet
 * prerequisite, because its STATUS says so. Comparing gates to SQL would report that as a
 * disagreement; comparing the two satisfaction answers is the property that actually matters.
 */
async function runnableByTs(db: Db, w: World, edge = w.checkId): Promise<boolean> {
  const rows = await db.$queryRawUnsafe<Array<{
    id: string; status: string; supersededByTaskId: string | null;
  }>>(
    `SELECT "id", "status"::text, "superseded_by_task_id" AS "supersededByTaskId"
       FROM "task" WHERE "project_id" = $1::uuid`,
    w.projectId,
  );
  const statusOf = new Map(rows.map((row) => [row.id, row.status]));
  const successorOf = new Map(rows.map((row) => [row.id, row.supersededByTaskId]));
  const epochs = await loadVerificationEpochGates(db, OWNER, [edge]);
  return dependencySatisfied(edge, statusOf, successorOf, epochs);
}

/**
 * All three spellings, plus the assertion that they said the same thing. Every case below goes
 * through here rather than asking one of them, which is what makes "one rule" a property and not a
 * claim.
 */
async function agreedGate(
  db: Db,
  w: World,
): Promise<VerificationEpochGate | null | undefined> {
  const gate = await gateByTs(db, w.subjectId);
  for (const [edge, dependent, name] of [
    [w.checkId, w.downstreamId, 'check'],
    [w.subjectId, w.subjectDownstreamId, 'subject'],
  ] as const) {
    const sql = await runnableBySql(db, dependent);
    const ts = await runnableByTs(db, w, edge);
    assert.equal(sql, ts, `on the ${name} edge SQL says runnable=${sql}, TypeScript says ${ts}`);
    const epochSql = await epochOpenBySql(db, edge);
    // The sharper of the two: the sweep predicate also folds in the row's own status, so it would
    // agree by accident on a prerequisite that is not DONE.
    assert.equal(
      epochSql, (await gateByTs(db, edge) ?? null) == null,
      `the epoch fragment says open=${epochSql} on the ${name} edge while the gate says ${gate}`,
    );
    assert.equal(
      await gateByTs(db, edge), gate,
      'both spellings of the edge must resolve to ONE epoch',
    );
  }
  return gate;
}

/** `project_action` rows naming this check — what DEP used to wait for, and what nothing writes. */
async function ledgerRows(db: Db, checkId: string): Promise<number> {
  const rows = await db.$queryRawUnsafe<Array<{ n: bigint }>>(
    `SELECT count(*) AS n FROM "project_action" WHERE "subject_id" = $1::uuid`, checkId,
  );
  return Number(rows[0].n);
}

/**
 * The dependency state each downstream task reports — `computeDependencyState` over the gate and
 * the stall `TasksService.dependencyFactsFor` derives for its one prerequisite — held against the
 * SQL sweep's runnable answer for the same task, so READY and "runnable" cannot mean two worlds.
 */
async function downstreamStates(
  db: Db,
  w: World,
): Promise<{ check: DependencyState; subject: DependencyState }> {
  const states: Record<'check' | 'subject', DependencyState> = { check: 'NONE', subject: 'NONE' };
  for (const [edge, dependent, name] of [
    [w.checkId, w.downstreamId, 'check'],
    [w.subjectId, w.subjectDownstreamId, 'subject'],
  ] as const) {
    const rows = await db.$queryRawUnsafe<Array<{ status: string }>>(
      `SELECT "status"::text FROM "task" WHERE "id" = $1::uuid`, edge,
    );
    const epochs = await loadVerificationEpochGates(db, OWNER, [edge]);
    const state = computeDependencyState([{
      status: rows[0].status as TaskStatus,
      verificationGate: dependencyEpochGate(edge, epochs),
      verificationGateStalled: dependencyEpochStalled(edge, epochs),
    }]);
    const runnable = await runnableBySql(db, dependent);
    assert.equal(
      state === 'READY', runnable,
      `on the ${name} edge TypeScript reports ${state} while SQL says runnable=${runnable}`,
    );
    states[name] = state;
  }
  return states;
}

test('§13.3 DEP on real PostgreSQL', { skip, concurrency: 1 }, async (t) => {
  const { prismaClientFor } = await import('../prisma/prisma-client.js');
  assertCoordinatorPgUrlIsIsolated(URL!);
  const probe = new Client({ connectionString: URL });
  await probe.connect();
  await verifyCoordinatorPgIdentity(probe);
  await probe.end();
  const db = prismaClientFor(URL!);
  await seedOwner(db);
  t.after(async () => { await db.$disconnect(); });

  // -------------------------------------------------------------------------
  // The incident
  // -------------------------------------------------------------------------

  await t.test('a check that concluded FAIL is DONE and holds its downstream', async () => {
    const w = await world(db, { verdict: 'FAIL' });
    const check = await db.$queryRawUnsafe<Array<{ status: string }>>(
      `SELECT "status"::text FROM "task" WHERE "id" = $1::uuid`, w.checkId,
    );
    assert.equal(check[0].status, 'DONE', 'the row that used to release it is unchanged');
    assert.equal(await agreedGate(db, w), 'VERIFICATION_FAILED');
    assert.deepEqual(await downstreamStates(db, w), {
      check: 'BLOCKED_FAILED', subject: 'BLOCKED_FAILED',
    });
    assert.equal(
      computeDependencyState([{ status: TaskStatus.DONE, verificationGate: 'VERIFICATION_FAILED' }]),
      'BLOCKED_FAILED',
      'and a person is told to go and fix something, not to wait',
    );
  });

  await t.test('a settled PASS releases its downstream with no ledger row behind it', async () => {
    // A natural `task_done` run, nothing live on the check, the subject still DONE — and not one
    // `project_action` row, which is every PASS since the control loop that wrote them was removed
    // (6418a1e5). DEP used to answer this world `VERDICT_NOT_APPLIED`, for good.
    const w = await world(db, { verdict: 'PASS' });
    assert.equal(await ledgerRows(db, w.checkId), 0, 'no ledger row stands behind this PASS');
    assert.equal(await agreedGate(db, w), null);
    assert.deepEqual(await downstreamStates(db, w), { check: 'READY', subject: 'READY' });
  });

  await t.test('INCONCLUSIVE and a DONE check with no verdict both hold it', async () => {
    const inconclusive = await world(db, { verdict: 'INCONCLUSIVE' });
    assert.equal(await agreedGate(db, inconclusive), 'VERIFICATION_INCONCLUSIVE');
    assert.deepEqual(await downstreamStates(db, inconclusive), {
      check: 'BLOCKED_FAILED', subject: 'BLOCKED_FAILED',
    });
    assert.equal(await agreedGate(db, await world(db, { verdict: null })), 'VERDICT_ABSENT');
  });

  // -------------------------------------------------------------------------
  // DEP3 — each fact, removed one at a time
  // -------------------------------------------------------------------------

  await t.test('a PASS still holding a live run has not concluded', async () => {
    for (const status of ['PENDING', 'RUNNING', 'AWAITING_INPUT', 'INTERRUPTED']) {
      const w = await world(db, { verdict: 'PASS', run: { status, endReason: null } });
      assert.equal(await agreedGate(db, w), 'RUN_NOT_SETTLED', `run status ${status}`);
      assert.deepEqual(await downstreamStates(db, w), {
        check: 'BLOCKED', subject: 'BLOCKED',
      }, `run status ${status}: a live run is a wait`);
    }
  });

  await t.test('a run a person ended is not a worker finishing the task', async () => {
    for (const endReason of ['completed', 'cancelled', 'ended', 'deleted', 'task_cancelled', null]) {
      const w = await world(db, { verdict: 'PASS', run: { endReason } });
      assert.equal(await agreedGate(db, w), 'RUN_NOT_SETTLED', `end_reason ${endReason}`);
      assert.deepEqual(await downstreamStates(db, w), {
        check: 'BLOCKED_FAILED', subject: 'BLOCKED_FAILED',
      }, `end_reason ${endReason}: nothing is running that could settle it`);
    }
  });

  await t.test('a run outside the COMPLETED lifecycle, or trashed, is not evidence', async () => {
    assert.equal(
      await agreedGate(db, await world(db, { verdict: 'PASS', run: { completedAt: false } })),
      'RUN_NOT_SETTLED',
    );
    assert.equal(
      await agreedGate(db, await world(db, { verdict: 'PASS', run: { deleted: true } })),
      'RUN_NOT_SETTLED',
    );
    // `archived_at` is the other half of §4.2's derivation, and counts.
    assert.equal(
      await agreedGate(db, await world(db, {
        verdict: 'PASS', run: { completedAt: false, archivedAt: true },
      })),
      null,
    );
  });

  await t.test('a check that never ran has nothing to have concluded from', async () => {
    assert.equal(
      await agreedGate(db, await world(db, { verdict: 'PASS', run: null })),
      'RUN_NOT_SETTLED',
    );
  });

  await t.test('the database will not MAKE an unrevisioned verdict any more', async () => {
    // `VERDICT_UNREVISIONED` is a gate about legacy rows: §13.2 V7's
    // `task_verdict_revision_advance` turns a 0 into a 1 on the way in, so the shape cannot be
    // written today. Asserting the trigger is the honest version of the case — the gate's own
    // behaviour is covered by `verification-dependency.spec.ts`, where the fact can be stated.
    const w = await world(db, { verdict: 'PASS', verdictRevision: 0 });
    const rows = await db.$queryRawUnsafe<Array<{ revision: bigint }>>(
      `SELECT "verdict_revision" AS "revision" FROM "task" WHERE "id" = $1::uuid`, w.checkId,
    );
    assert.equal(rows[0].revision, 1n);
  });

  // -------------------------------------------------------------------------
  // DEP1 — the epoch belongs to the subject
  // -------------------------------------------------------------------------

  await t.test('reopening the subject after a PASS puts the downstream back', async () => {
    const w = await world(db, { verdict: 'PASS' });
    assert.equal(await agreedGate(db, w), null);
    assert.deepEqual(await downstreamStates(db, w), { check: 'READY', subject: 'READY' });
    for (const status of ['OPEN', 'IN_PROGRESS', 'FAILED', 'CANCELLED']) {
      await db.$executeRawUnsafe(
        `UPDATE "task" SET "status" = $2::"task_status", "updated_at" = now()
          WHERE "id" = $1::uuid`, w.subjectId, status,
      );
      assert.equal(await agreedGate(db, w), 'SUBJECT_NOT_DONE', `subject ${status}`);
      // The subject's own edge reads the subject's status first, so a FAILED or CANCELLED one is
      // terminal there; through the check it is the epoch's wait.
      assert.deepEqual(await downstreamStates(db, w), {
        check: 'BLOCKED',
        subject: status === 'FAILED' || status === 'CANCELLED' ? 'BLOCKED_FAILED' : 'BLOCKED',
      }, `subject ${status}`);
    }
  });

  await t.test('an older PASS stops releasing the moment a newer check is filed', async () => {
    const w = await world(db, { verdict: 'PASS', verdictRevision: 1 });
    assert.equal(await agreedGate(db, w), null);
    // Newer by id, and not concluded. The re-check reopens the question for the whole subject.
    await addCheck(db, w.projectId, w.subjectId, w.agentId, {
      status: 'OPEN', verdict: null, verdictRevision: 0, run: null,
    }, newerThan(w.checkId));
    assert.equal(await agreedGate(db, w), 'VERIFICATION_IN_FLIGHT');
  });

  await t.test('a newer FAIL overrides an older PASS, even on the older PASS\'s own edge', async () => {
    const w = await world(db, { verdict: 'PASS' });
    await addCheck(db, w.projectId, w.subjectId, w.agentId, {
      verdict: 'FAIL', verdictRevision: 1,
    }, newerThan(w.checkId));
    assert.equal(await agreedGate(db, w), 'VERIFICATION_FAILED');
  });

  await t.test('a newer PASS releases work an older FAIL held', async () => {
    const w = await world(db, { verdict: 'FAIL' });
    assert.equal(await agreedGate(db, w), 'VERIFICATION_FAILED');
    await addCheck(db, w.projectId, w.subjectId, w.agentId, {
      verdict: 'PASS', verdictRevision: 1,
    }, newerThan(w.checkId));
    assert.equal(await agreedGate(db, w), null, 'fix, re-check, proceed');
  });

  await t.test('cancelling every check of a subject is not a pass', async () => {
    const w = await world(db, { verdict: null, status: 'CANCELLED', run: null });
    assert.equal(await agreedGate(db, w), 'NO_LIVE_VERIFICATION');
  });

  await t.test('a cancelled NEWER check leaves the older PASS speaking again', async () => {
    const w = await world(db, { verdict: 'PASS' });
    const rerun = await addCheck(db, w.projectId, w.subjectId, w.agentId, {
      status: 'OPEN', verdict: null, verdictRevision: 0, run: null,
    }, newerThan(w.checkId));
    assert.equal(await agreedGate(db, w), 'VERIFICATION_IN_FLIGHT');
    await db.$executeRawUnsafe(
      `UPDATE "task" SET "status" = 'CANCELLED', "updated_at" = now() WHERE "id" = $1::uuid`,
      rerun,
    );
    assert.equal(await agreedGate(db, w), null, 'nothing replaced the PASS');
  });

  await t.test('a superseded newer check does not count either (§13.6 SU1)', async () => {
    const w = await world(db, { verdict: 'PASS' });
    const successor = await addCheck(db, w.projectId, w.subjectId, w.agentId, {
      status: 'OPEN', verdict: null, verdictRevision: 0, run: null,
    }, newerThan(w.checkId, 2));
    const retired = await addCheck(db, w.projectId, w.subjectId, w.agentId, {
      status: 'CANCELLED', verdict: null, verdictRevision: 0, run: null,
      supersededBy: successor, terminalReason: 'SUPERSEDED',
    }, newerThan(w.checkId, 1));
    assert.ok(retired);
    // The SUCCESSOR is live and unconcluded, so the epoch is shut by it — not by the retired row.
    assert.equal(await agreedGate(db, w), 'VERIFICATION_IN_FLIGHT');
  });

  await t.test('a check whose SUBJECT was replaced is history and stops holding anything', async () => {
    const w = await world(db, { verdict: 'FAIL' });
    assert.equal(await agreedGate(db, w), 'VERIFICATION_FAILED');
    const successor = await task(db, { projectId: w.projectId, status: 'DONE' });
    await db.$executeRawUnsafe(
      `UPDATE "task" SET "status" = 'CANCELLED', "updated_at" = now() WHERE "id" = $1::uuid`,
      w.subjectId,
    );
    await db.$executeRawUnsafe(
      `UPDATE "task" SET "superseded_by_task_id" = $2::uuid, "terminal_reason" = 'SUPERSEDED',
              "superseded_at" = now() WHERE "id" = $1::uuid`,
      w.subjectId, successor,
    );
    // No gate at all: SU9's chain walk owns the question now, and a finding about replaced work is
    // history the same way `verificationFailureIsHistorySql` already reads it.
    assert.equal(await gateByTs(db, w.checkId), undefined);
    assert.equal(await epochOpenBySql(db, w.checkId), true);
  });

  // -------------------------------------------------------------------------
  // DEP0 — an ordinary prerequisite is untouched, and the preferred edge works
  // -------------------------------------------------------------------------

  await t.test('an ordinary DONE prerequisite is satisfied exactly as before', async () => {
    const w = await world(db, { verdict: 'FAIL' });
    const plain = await task(db, { projectId: w.projectId, status: 'DONE' });
    const dependent = await task(db, { projectId: w.projectId });
    await db.$executeRawUnsafe(
      `INSERT INTO "task_dependency" ("id","task_id","depends_on_task_id") VALUES ($1,$2,$3)`,
      randomUUID(), dependent, plain,
    );
    assert.equal(await runnableBySql(db, dependent), true);
    assert.deepEqual([...await loadVerificationEpochGates(db, OWNER, [plain])], []);
  });

  await t.test('the SUBJECT edge is held while the subject sits at DONE with a FAIL', async () => {
    // The distinguishing case, and the one the API's own guidance promises: nothing here is
    // reverted, so the subject's STATUS says done. Only the epoch says otherwise.
    const w = await world(db, { verdict: 'FAIL' });
    const status = await db.$queryRawUnsafe<Array<{ status: string }>>(
      `SELECT "status"::text FROM "task" WHERE "id" = $1::uuid`, w.subjectId,
    );
    assert.equal(status[0].status, 'DONE', 'the subject is DONE; the epoch is what refuses');
    assert.equal(await runnableBySql(db, w.subjectDownstreamId), false);
    assert.equal(await agreedGate(db, w), 'VERIFICATION_FAILED');
    await recordVerdict(db, w.checkId, 'PASS');
    assert.equal(await runnableBySql(db, w.subjectDownstreamId), true);
  });

  await t.test('a check depending on the subject it checks is not made to wait for itself', async () => {
    // Without DEP's self-exemption this is a deadlock in the database as well as in the planner:
    // the epoch is shut BECAUSE this check has not concluded, and it cannot conclude until it runs.
    const w = await world(db, { status: 'OPEN', verdict: null, run: null });
    await db.$executeRawUnsafe(
      `INSERT INTO "task_dependency" ("id","task_id","depends_on_task_id") VALUES ($1,$2,$3)`,
      randomUUID(), w.checkId, w.subjectId,
    );
    assert.equal(await runnableBySql(db, w.checkId), true, 'the check may run');
    assert.equal(
      await runnableBySql(db, w.subjectDownstreamId), false,
      'and everybody else still waits for what it will conclude',
    );
    // The TypeScript half agrees, through the same argument.
    assert.equal(await runnableByTs(db, w, w.subjectId), false);
  });

  // -------------------------------------------------------------------------
  // DEP5 — ordering and restart
  // -------------------------------------------------------------------------

  await t.test('the answer does not depend on the order the facts arrived in', async () => {
    // Out of order on purpose: the run settles, THEN the verdict column is written — the reverse
    // of how a real turn produces them. The predicate reads current rows, so the sequence cannot
    // leave it ahead of itself.
    const w = await world(db, { verdict: null });
    assert.equal(await agreedGate(db, w), 'VERDICT_ABSENT');
    await recordVerdict(db, w.checkId, 'PASS');
    assert.equal(await agreedGate(db, w), null);
    // A "restart": ask again from nothing. Same rows, same answer — there is no memory to lose.
    assert.equal(await agreedGate(db, w), null);
  });

  // -------------------------------------------------------------------------
  // AC4 — the window between the verdict landing and it taking effect
  // -------------------------------------------------------------------------

  await t.test('nothing downstream escapes while the verdict is still uncommitted', async () => {
    const w = await world(db, { verdict: null, run: { status: 'RUNNING', endReason: null } });
    const writer = new Client({ connectionString: URL });
    await writer.connect();
    try {
      // The whole turn's landing, in ONE transaction: the run settles and the verdict is written.
      await writer.query('BEGIN');
      await writer.query(
        `UPDATE "session" SET "status" = 'SUCCEEDED', "end_reason" = 'task_done',
                "completed_at" = now(), "updated_at" = now() WHERE "task_id" = $1::uuid`,
        [w.checkId],
      );
      await writer.query(
        `UPDATE "task" SET "verdict" = 'PASS', "updated_at" = now() WHERE "id" = $1::uuid`,
        [w.checkId],
      );

      // Mid-window, from another connection: every reader still says no, and no dispatch could
      // have been authorized. This is the assertion AC4 is about — downstream sessions = 0.
      assert.equal(await agreedGate(db, w), 'VERDICT_ABSENT');
      assert.equal(await runnableBySql(db, w.downstreamId), false);
      const sessions = await db.$queryRawUnsafe<Array<{ n: bigint }>>(
        `SELECT count(*) AS n FROM "session" WHERE "task_id" = $1::uuid`, w.downstreamId,
      );
      assert.equal(Number(sessions[0].n), 0);

      await writer.query('COMMIT');
    } finally {
      await writer.end();
    }
    // ...and the instant it commits, the release happens — once, and for the right task.
    assert.equal(await agreedGate(db, w), null);
    assert.equal(await runnableBySql(db, w.downstreamId), true);
  });

  // -------------------------------------------------------------------------
  // Unit L3 / scope contract §3 SC6 — a check answers only for a subject it shares an owner
  // and a project with. Fault injection: the rows below are written by RAW SQL, which is what a
  // repair script, a rolled-back binary or an attacker with a database handle has.
  //
  // `assertVerificationEligible` refuses to create any of them through the service. That is a
  // service rule, and this is the file that says whether the rule is also a boundary: a row that
  // got past it — or never went through it — must not be able to move anybody else's answer.
  // -------------------------------------------------------------------------

  /** A second tenant, with its own runner, workspace and project. Nothing of OWNER's is reused. */
  async function foreignTenant(): Promise<{ ownerId: string; projectId: string; agentId: string }> {
    const ownerId = randomUUID();
    const runnerId = randomUUID();
    const agentId = randomUUID();
    const projectId = randomUUID();
    await db.$executeRawUnsafe(
      `INSERT INTO "user" ("id","email","name","password_hash") VALUES ($1,$2,'h0g2','x')`,
      ownerId, `h0g2-${ownerId}@example.test`,
    );
    await db.$executeRawUnsafe(
      `INSERT INTO "runner" ("id","owner_id","name","status","token_hash","capabilities_reported_at")
       VALUES ($1,$2,'h0g2','ONLINE',$3,now())`,
      runnerId, ownerId, `h0g2-${runnerId}`,
    );
    await db.$executeRawUnsafe(
      `INSERT INTO "workspace" ("id","owner_id","name","runner_id","can_create_tasks","can_delegate")
       VALUES ($1,$2,$3,$4,true,true)`,
      agentId, ownerId, `agent-${agentId.slice(0, 8)}`, runnerId,
    );
    await db.$executeRawUnsafe(
      `INSERT INTO "project" ("id","owner_id","title","coordinator_enabled","automation_policy",
         "updated_at")
       VALUES ($1,$2,'h0g2',true,'AUTO'::"project_automation_policy",now())`,
      projectId, ownerId,
    );
    await db.$executeRawUnsafe(
      `INSERT INTO "project_runtime" ("project_id","updated_at") VALUES ($1,now())
         ON CONFLICT ("project_id") DO NOTHING`, projectId,
    );
    return { ownerId, projectId, agentId };
  }

  /** A second project of the SAME owner — the cross-PROJECT half of the same invariant. */
  async function siblingProject(): Promise<{ projectId: string; agentId: string }> {
    const projectId = randomUUID();
    const agentId = randomUUID();
    await db.$executeRawUnsafe(
      `INSERT INTO "workspace" ("id","owner_id","name","runner_id","can_create_tasks","can_delegate")
       VALUES ($1,$2,$3,$4,true,true)`,
      agentId, OWNER, `agent-${agentId.slice(0, 8)}`, RUNNER,
    );
    await db.$executeRawUnsafe(
      `INSERT INTO "project" ("id","owner_id","title","coordinator_enabled","automation_policy",
         "updated_at")
       VALUES ($1,$2,'h0g-sib',true,'AUTO'::"project_automation_policy",now())`,
      projectId, OWNER,
    );
    await db.$executeRawUnsafe(
      `INSERT INTO "project_runtime" ("project_id","updated_at") VALUES ($1,now())
         ON CONFLICT ("project_id") DO NOTHING`, projectId,
    );
    return { projectId, agentId };
  }

  /**
   * A check of `subjectId` that lives somewhere else, written straight to the table.
   *
   * Given everything the epoch rule asks for: DONE, PASS, a revision above zero and a naturally
   * settled verification run. The only thing wrong with it is WHOSE subject it names — which is
   * exactly the thing under test.
   */
  async function forgeCheck(
    scope: { ownerId: string; projectId: string; agentId: string },
    subjectId: string,
    id: string,
    over: { status?: string; verdict?: string | null } = {},
  ): Promise<string> {
    const status = over.status ?? 'DONE';
    const verdict = over.verdict === undefined ? 'PASS' : over.verdict;
    await db.$executeRawUnsafe(
      `INSERT INTO "task" ("id","title","status","owner_id","creator_type","creator_id","project_id",
         "assignee_id","verifies_task_id","verdict","verdict_revision","updated_at","completion_criterion")
       VALUES ($1,'forged',$2::"task_status",$3,'USER',$3,$4,$5,$6,$7::"task_verdict",1,now(),'EVIDENCE_JUDGMENT')`,
      id, status, scope.ownerId, scope.projectId, scope.agentId, subjectId, verdict,
    );
    if (status === 'DONE' && verdict === 'PASS') {
      await db.$executeRawUnsafe(
        `INSERT INTO "session" ("id","owner_id","workspace_id","task_id","title","prompt",
           "creator_id","provider","status","end_reason","completed_at","starts_task_work",
           "dispatch_origin","updated_at")
         VALUES ($1,$2,$3,$4,'forged run','x',$2,'claude','SUCCEEDED'::"run_status",'task_done',
           now(),true,'USER'::"session_dispatch_origin",now())`,
        randomUUID(), scope.ownerId, scope.agentId, id,
      );
    }
    return id;
  }

  /** Nothing downstream started — the assertion AC6 finally rests on. */
  async function downstreamSessions(taskId: string): Promise<number> {
    const rows = await db.$queryRawUnsafe<Array<{ n: bigint }>>(
      `SELECT count(*) AS n FROM "session" WHERE "task_id" = $1::uuid`, taskId,
    );
    return Number(rows[0].n);
  }

  await t.test('a PASSing check forged in ANOTHER OWNER\'s project opens no epoch here', async () => {
    const w = await world(db, { verdict: 'FAIL' });
    assert.equal(await agreedGate(db, w), 'VERIFICATION_FAILED');

    // Newer than the real check, so `ORDER BY id DESC` would pick it — the whole attack.
    await forgeCheck(await foreignTenant(), w.subjectId, newerThan(w.checkId, 1));

    assert.equal(await agreedGate(db, w), 'VERIFICATION_FAILED',
      'a foreign PASS is not this subject\'s newest check');
    assert.equal(await runnableBySql(db, w.downstreamId), false);
    assert.equal(await runnableBySql(db, w.subjectDownstreamId), false);
    assert.equal(await downstreamSessions(w.downstreamId), 0);
    assert.equal(await downstreamSessions(w.subjectDownstreamId), 0);
  });

  await t.test('a PASSing check forged in another PROJECT of the same owner opens none either', async () => {
    const w = await world(db, { verdict: 'FAIL' });
    const sibling = await siblingProject();

    await forgeCheck(
      { ownerId: OWNER, projectId: sibling.projectId, agentId: sibling.agentId },
      w.subjectId,
      newerThan(w.checkId, 2),
    );

    assert.equal(await agreedGate(db, w), 'VERIFICATION_FAILED');
    assert.equal(await runnableBySql(db, w.downstreamId), false);
    assert.equal(await downstreamSessions(w.downstreamId), 0);
  });

  // The same hole, run the other way. A forged row that is NOT a pass would otherwise make a
  // subject with no checks look verified-by-something and hold its dependents for ever: one raw
  // INSERT in a project you own is enough to freeze somebody else's work.
  await t.test('a foreign check cannot invent an epoch for a subject that has none', async () => {
    const projectId = randomUUID();
    await db.$executeRawUnsafe(
      `INSERT INTO "project" ("id","owner_id","title","coordinator_enabled","automation_policy",
         "updated_at")
       VALUES ($1,$2,'h0g-plain',true,'AUTO'::"project_automation_policy",now())`,
      projectId, OWNER,
    );
    await db.$executeRawUnsafe(
      `INSERT INTO "project_runtime" ("project_id","updated_at") VALUES ($1,now())
         ON CONFLICT ("project_id") DO NOTHING`, projectId,
    );
    const subjectId = await task(db, { projectId, status: 'DONE' });
    const downstreamId = await task(db, { projectId });
    await db.$executeRawUnsafe(
      `INSERT INTO "task_dependency" ("id","task_id","depends_on_task_id") VALUES ($1,$2,$3)`,
      randomUUID(), downstreamId, subjectId,
    );
    assert.equal(await runnableBySql(db, downstreamId), true, 'a DONE prerequisite with no checks');

    await forgeCheck(await foreignTenant(), subjectId, randomUUID(), { status: 'OPEN', verdict: null });

    assert.equal(await runnableBySql(db, downstreamId), true,
      'a foreign row must not be able to freeze work it has nothing to do with');
    assert.equal((await loadVerificationEpochGates(db, OWNER, [subjectId])).size, 0,
      'and the TypeScript reader must not see an epoch either');
  });

  // The forgery is still THERE. The rule is about which rows may answer for a subject, not about
  // deleting rows — and a fix that quietly removed the evidence would be the wrong fix.
  await t.test('the legitimate epoch still opens beside the forgery, and the forgery is untouched', async () => {
    const w = await world(db, { verdict: 'FAIL' });
    const forged = await forgeCheck(await foreignTenant(), w.subjectId, newerThan(w.checkId, 3));

    await recordVerdict(db, w.checkId, 'PASS');

    assert.equal(await agreedGate(db, w), null, 'the subject\'s OWN check released it');
    assert.equal(await runnableBySql(db, w.downstreamId), true);
    const rows = await db.$queryRawUnsafe<Array<{ n: bigint }>>(
      `SELECT count(*) AS n FROM "task" WHERE "id" = $1::uuid`, forged,
    );
    assert.equal(Number(rows[0].n), 1, 'the forged row is refused, not erased');
  });

  await t.test('a rolled-back verdict releases nothing at all', async () => {
    const w = await world(db, { verdict: null });
    const writer = new Client({ connectionString: URL });
    await writer.connect();
    try {
      await writer.query('BEGIN');
      await writer.query(
        `UPDATE "task" SET "verdict" = 'PASS' WHERE "id" = $1::uuid`, [w.checkId],
      );
      await writer.query('ROLLBACK');
    } finally {
      await writer.end();
    }
    assert.equal(await agreedGate(db, w), 'VERDICT_ABSENT');
  });
});

/**
 * An id strictly greater than `id` in the byte order both spellings rank by.
 *
 * Fixtures cannot leave "which check is newer" to `randomUUID()`: this whole rule turns on that
 * order, and a test that passed because two random ids happened to sort the right way would be
 * proving nothing. `nth` distinguishes several successors of one base.
 */
function newerThan(id: string, nth = 1): string {
  const hex = id.replace(/-/g, '');
  const bumped = (BigInt(`0x${hex}`) + BigInt(nth)).toString(16).padStart(32, '0');
  return [
    bumped.slice(0, 8), bumped.slice(8, 12), bumped.slice(12, 16),
    bumped.slice(16, 20), bumped.slice(20, 32),
  ].join('-');
}
