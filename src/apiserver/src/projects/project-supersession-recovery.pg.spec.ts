import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { RunStatus, SessionDispatchOrigin, TaskStatus } from '@prisma/client';
import {
  E2eServices,
  World,
  connectIsolatedPg,
  dispatch,
  emptyWorld,
  failTask,
  servicesOn,
  session,
  task,
  world,
} from './project-e2e-harness';
import { ProjectFailureRecoveryService } from './project-failure-recovery.service';

/**
 * §13.6 SU6–SU8 on a real PostgreSQL: the half of this unit a pure test cannot state.
 *
 * The pure gates are `project-supersession-guards.spec.ts`. What only a database can answer:
 *
 *   * the boot recovery scan's own SQL — the query that started the incident;
 *   * the two triggers 0130 installs, which exist precisely because a service check lives only in
 *     the binary that has it, and a rolling deploy always has an older one still dispatching;
 *   * the widened execution claim, and the migration's refusal to widen it over data it would have
 *     to choose between;
 *   * atomicity: the successor and its link commit together, a refusal writes neither, and two
 *     concurrent replacements produce one winner and one typed conflict.
 *
 * Every scenario ends by asserting what did NOT change. This unit exists because a production
 * incident started a Session for finished work; a test that only checked the refusal code would
 * pass on an implementation that refused and dispatched anyway.
 */

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

const MIGRATION_0130 = readFileSync(path.resolve(
  __dirname, '../../prisma/migrations/0130_task_supersession_dispatch_guard/migration.sql',
), 'utf8');

/** The four ways a row says "this attempt is not the live one" (see the pure spec's table). */
const RETIREMENTS: Array<{ name: string; successor: boolean; reason: string | null }> = [
  { name: 'linked to its successor', successor: true, reason: 'SUPERSEDED' },
  { name: 'successor deleted, reason kept', successor: false, reason: 'SUPERSEDED' },
  { name: 'abandoned', successor: false, reason: 'ABANDONED' },
];

/** §4.2 guard 5's four live statuses, each of which must hold a task on its own. */
const LIVE: RunStatus[] = [
  RunStatus.PENDING, RunStatus.RUNNING, RunStatus.AWAITING_INPUT, RunStatus.INTERRUPTED,
];

async function retire(
  services: E2eServices,
  taskId: string,
  shape: { successor: boolean; reason: string | null },
  successorId: string | null,
): Promise<void> {
  // One statement for all four columns, which is also the only way to write them: 0128's link CHECK
  // and 0130's `task_retirement_status_check` are each about several of them at once, and
  // PostgreSQL evaluates a CHECK per statement — so a fixture that moved the status separately
  // would be refused on whichever half it wrote first. `TasksService` orders its two writes for
  // exactly that reason; a test that wants the END STATE writes it in one go.
  //
  // CANCELLED unless the caller already made it FAILED: a retirement may only sit on a terminal
  // row, and which of the two it is is not what these scenarios are about.
  await services.db.$executeRawUnsafe(
    `UPDATE "task"
        SET "superseded_by_task_id" = $1::uuid, "superseded_at" = $2, "terminal_reason" = $3,
            "status" = CASE WHEN "status" IN ('FAILED', 'CANCELLED') THEN "status"
                            ELSE 'CANCELLED'::"task_status" END
      WHERE "id" = $4::uuid`,
    shape.successor ? successorId : null,
    shape.reason ? new Date() : null,
    shape.reason,
    taskId,
  );
}

/** Every column of every Session on this task, so "nothing was rewritten" is a comparison. */
async function sessionRows(services: E2eServices, taskId: string): Promise<unknown[]> {
  return services.db.$queryRawUnsafe(
    `SELECT "id", "status"::text AS status, "end_reason", "finished_at", "completed_at",
            "deleted_at", "error", "dispatch_origin"::text AS origin
       FROM "session" WHERE "task_id" = $1::uuid ORDER BY "id"`,
    taskId,
  );
}

async function taskRow(services: E2eServices, taskId: string): Promise<Record<string, unknown>> {
  const [row] = await services.db.$queryRawUnsafe<Array<Record<string, unknown>>>(
    `SELECT "status"::text AS status, "dispatch_attempt"::text AS attempt,
            "superseded_by_task_id" AS successor, "terminal_reason" AS reason
       FROM "task" WHERE "id" = $1::uuid`,
    taskId,
  );
  return row;
}

// ---------------------------------------------------------------------------------------------
// 1. The boot recovery scan — the query the incident came through
// ---------------------------------------------------------------------------------------------

test('unit E: the boot recovery scan leaves every retired attempt alone', { skip }, async (t) => {
  const services = servicesOn(URL!);
  const client = await connectIsolatedPg(URL);
  try {
    for (const shape of RETIREMENTS) {
      await t.test(`does not re-arm a project for a ${shape.name} failure`, async () => {
        await emptyWorld(client);
        const target = await world(services.db, 'su6-scan');
        const successorId = await task(services.db, target, 'the fresh attempt');
        const oldId = await task(services.db, target, 'the replaced attempt');
        await failTask(services.db, target, oldId, 1);
        await services.db.task.update({
          where: { id: oldId }, data: { status: TaskStatus.FAILED },
        });
        await retire(services, oldId, shape, successorId);
        // The precondition the incident had: a project whose clock has stopped and whose only
        // FAILED task is one nobody is asking about any more.
        await services.db.$executeRawUnsafe(
          `UPDATE "project_runtime" SET "next_wake_at" = NULL WHERE "project_id" = $1::uuid`,
          target.projectId,
        );

        const outcome = await new ProjectFailureRecoveryService(services.db as never).scan();

        assert.deepEqual(outcome.rearmed, [], 'a replaced failure is not an unanswered one');
        assert.deepEqual(outcome.deferred, []);
        const [runtime] = await services.db.$queryRawUnsafe<Array<{ wake: Date | null }>>(
          `SELECT "next_wake_at" AS wake FROM "project_runtime" WHERE "project_id" = $1::uuid`,
          target.projectId,
        );
        assert.equal(runtime.wake, null, 'the scan wrote nothing at all');
      });
    }

    await t.test('the negative case: an unreplaced failure is still re-armed', async () => {
      await emptyWorld(client);
      const target = await world(services.db, 'su6-scan-neg');
      const failed = await task(services.db, target, 'genuinely unanswered');
      await failTask(services.db, target, failed, 1);
      await services.db.task.update({
        where: { id: failed }, data: { status: TaskStatus.FAILED },
      });
      await services.db.$executeRawUnsafe(
        `UPDATE "project_runtime" SET "next_wake_at" = NULL WHERE "project_id" = $1::uuid`,
        target.projectId,
      );

      const outcome = await new ProjectFailureRecoveryService(services.db as never).scan();
      assert.equal(outcome.rearmed.length, 1, 'PC-CX-66 is not narrowed by SU6');
    });
  } finally {
    await client.end();
    await services.dispose();
  }
});

// ---------------------------------------------------------------------------------------------
// 2. The dispatch commit fence — a successor linked AFTER the pass chose the task
// ---------------------------------------------------------------------------------------------

test('unit E: a supersession recorded after planning refuses the dispatch and writes no Session',
  { skip }, async (t) => {
    const services = servicesOn(URL!);
    const client = await connectIsolatedPg(URL);
    try {
      for (const shape of RETIREMENTS) {
        await t.test(`refuses TASK_SUPERSEDED for a ${shape.name} attempt`, async () => {
          await emptyWorld(client);
          const target = await world(services.db, 'su6-fence');
          const successorId = await task(services.db, target, 'fresh');
          const oldId = await task(services.db, target, 'replaced');
          await failTask(services.db, target, oldId, 1);
          await services.db.task.update({
            where: { id: oldId }, data: { status: TaskStatus.FAILED },
          });
          const before = await taskRow(services, oldId);
          const sessionsBefore = await sessionRows(services, oldId);

          // The race, in the order that makes it a race: the link lands between the snapshot the
          // pass read and the transaction that would dispatch.
          await retire(services, oldId, shape, successorId);
          const outcome = await dispatch(services, target, oldId);

          assert.equal(outcome.refusalCode, 'TASK_SUPERSEDED');
          assert.equal(outcome.reasonCode, 'TASK_SUPERSEDED');
          assert.equal(outcome.status, 'REFUSED');
          assert.equal(outcome.sessionId, null, 'no Session for work that was already re-done');
          // The refusal is auditable — an action row exists — and nothing else moved.
          assert.ok(outcome.actionId);
          const after = await taskRow(services, oldId);
          assert.equal(after.status, before.status, 'the task keeps the status its run left it');
          assert.deepEqual(await sessionRows(services, oldId), sessionsBefore,
            'every existing Session is byte-identical');
        });
      }
    } finally {
      await client.end();
      await services.dispose();
    }
  });

// ---------------------------------------------------------------------------------------------
// 3. 0130's two triggers — the half that survives a rolling deploy
// ---------------------------------------------------------------------------------------------

test('unit E: the database refuses an automated Session on a retired task, whatever binary asks',
  { skip }, async (t) => {
    const services = servicesOn(URL!);
    const client = await connectIsolatedPg(URL);
    try {
      for (const shape of RETIREMENTS) {
        await t.test(`${shape.name}: an automated insert is refused`, async () => {
          // Deliberately OUTSIDE a project, so `dispatch_authority` is LEGACY and a LEGACY_SWEEP
          // insert gets PAST 0122's authority guard and 0122's execution-context guard — both of
          // which fire before this one (triggers run in name order) and would otherwise be what
          // refused, making this test pass without SU6 being implemented at all. SU3 allows a
          // successor in "no project" for a predecessor in no project, so every shape still fits.
          await emptyWorld(client);
          const target = await world(services.db, 'su6-trigger');
          const successorId = randomUUID();
          const oldId = randomUUID();
          for (const [id, title] of [[successorId, 'fresh'], [oldId, 'replaced']] as const) {
            await services.db.task.create({
              data: {
                id,
                ownerId: target.ownerId,
                title,
                status: TaskStatus.CANCELLED,
                creatorType: 'USER',
                creatorId: target.ownerId,
              },
            });
          }
          await retire(services, oldId, shape, successorId);

          await assert.rejects(
            () => services.db.$executeRawUnsafe(
              `INSERT INTO "session" ("id","title","prompt","status","provider","owner_id",
                 "creator_id","task_id","dispatch_origin","updated_at")
               VALUES ($1::uuid,'t','p','PENDING','claude',$2::uuid,$2::uuid,$3::uuid,
                       'LEGACY_SWEEP'::"session_dispatch_origin", now())`,
              randomUUID(), target.ownerId, oldId,
            ),
            /TASK_SUPERSEDED/,
            'an old binary with no SU6 in it must still be stopped by the database',
          );
        });
      }

      await t.test('a person may still open their own Session on a retired attempt', async () => {
        // Deliberate: SU6 is about what the control loop starts by ITSELF. Reading a replaced
        // attempt, or salvaging something from it, is a decision — and refusing it here would be
        // unappealable from any UI.
        await emptyWorld(client);
        const target = await world(services.db, 'su6-trigger-user');
        const oldId = await task(services.db, target, 'replaced');
        await services.db.task.update({
          where: { id: oldId }, data: { status: TaskStatus.CANCELLED },
        });
        await retire(services, oldId, { successor: false, reason: 'SUPERSEDED' }, null);
        const salvage = await session(services.db, target, {
          taskId: oldId, status: RunStatus.RUNNING, finishedAt: null,
          // The exemption under test: a session opened to LOOK at a replaced attempt, which is the
          // one shape 0130 lets through on a retired task.
          startsTaskWork: false,
        });
        assert.ok(salvage);
      });

      await t.test('the negative case: this guard is not what stops an ordinary task', async () => {
        // The same INSERT against a task nothing retired. It is still refused — 0122's authority
        // guard owns a COORDINATOR-authority task and a LEGACY_SWEEP origin is not allowed to
        // start one — but by a DIFFERENT rule, which is the point: SU6 narrowed nothing that was
        // already dispatchable, and a retired task's refusal above is genuinely about supersession
        // rather than about the fixture's authority column.
        await emptyWorld(client);
        const target = await world(services.db, 'su6-trigger-neg');
        const ordinary = await task(services.db, target, 'ordinary');
        await assert.rejects(
          () => services.db.$executeRawUnsafe(
            `INSERT INTO "session" ("id","title","prompt","status","provider","owner_id",
               "creator_id","task_id","dispatch_origin","updated_at")
             VALUES ($1::uuid,'t','p','PENDING','claude',$2::uuid,$2::uuid,$3::uuid,
                     'LEGACY_SWEEP'::"session_dispatch_origin", now())`,
            randomUUID(), target.ownerId, ordinary,
          ),
          (error: Error) => {
            assert.match(error.message, /DISPATCH_AUTHORITY_VIOLATION/);
            assert.doesNotMatch(error.message, /TASK_SUPERSEDED/);
            return true;
          },
        );
      });
    } finally {
      await client.end();
      await services.dispose();
    }
  });

test('unit E: a task with a live run cannot be retired, and both commit orders have an answer',
  { skip }, async (t) => {
    const services = servicesOn(URL!);
    const client = await connectIsolatedPg(URL);
    try {
      for (const status of LIVE) {
        await t.test(`${status} holds the task: the link is refused`, async () => {
          await emptyWorld(client);
          const target = await world(services.db, `su6-live-${status}`);
          const oldId = await task(services.db, target, 'running');
          await session(services.db, target, { taskId: oldId, status, finishedAt: null });

          await assert.rejects(
            () => services.db.$executeRawUnsafe(
              `UPDATE "task" SET "superseded_at" = now(), "terminal_reason" = 'ABANDONED',
                      "status" = 'CANCELLED'::"task_status" WHERE "id" = $1::uuid`,
              oldId,
            ),
            /TASK_RETIRED_WHILE_RUNNING/,
            `${status} is a live run — retiring its task would leave a run executing retired work`,
          );
        });
      }

      await t.test('a terminal run does not hold it: the link commits', async () => {
        await emptyWorld(client);
        const target = await world(services.db, 'su6-live-terminal');
        const oldId = await task(services.db, target, 'finished');
        for (const status of [RunStatus.SUCCEEDED, RunStatus.FAILED, RunStatus.CANCELLED]) {
          await session(services.db, target, { taskId: oldId, status });
        }
        await services.db.$executeRawUnsafe(
          `UPDATE "task" SET "superseded_at" = now(), "terminal_reason" = 'ABANDONED',
                  "status" = 'CANCELLED'::"task_status" WHERE "id" = $1::uuid`,
          oldId,
        );
        assert.equal((await taskRow(services, oldId)).reason, 'ABANDONED');
      });

      await t.test('an ALREADY retired task is not re-checked: SET NULL and re-pointing work',
        async () => {
          // The boundary is the FIRST retirement transition. A successor deleted by the FK, a link
          // re-pointed at a later attempt, or the same link restated are not a task being taken
          // away from anybody — and a person's salvage Session on the retired attempt must not
          // permanently block what a DELETE told the FK to do.
          await emptyWorld(client);
          const target = await world(services.db, 'su6-live-retired');
          const first = await task(services.db, target, 'first successor');
          const second = await task(services.db, target, 'second successor');
          const oldId = await task(services.db, target, 'replaced');
          await services.db.task.update({
            where: { id: oldId }, data: { status: TaskStatus.CANCELLED },
          });
          await retire(services, oldId, { successor: true, reason: 'SUPERSEDED' }, first);
          // A person opens a salvage run on the retired attempt (allowed; see the USER case above).
          await session(services.db, target, {
            taskId: oldId, status: RunStatus.AWAITING_INPUT, finishedAt: null,
            startsTaskWork: false,
          });

          // Re-pointing at a later attempt: allowed, because the task was already retired.
          await services.db.$executeRawUnsafe(
            `UPDATE "task" SET "superseded_by_task_id" = $1::uuid WHERE "id" = $2::uuid`,
            second, oldId,
          );
          // And deleting the successor must not be blocked by that salvage run either — the FK's
          // ON DELETE SET NULL is a write to these very columns.
          await services.db.task.delete({ where: { id: second } });
          const after = await taskRow(services, oldId);
          assert.equal(after.successor, null, 'the pointer was cleared by the FK');
          assert.equal(after.reason, 'SUPERSEDED', 'and the reason survives it');
        });
    } finally {
      await client.end();
      await services.dispose();
    }
  });

// ---------------------------------------------------------------------------------------------
// 4. The widened execution claim
// ---------------------------------------------------------------------------------------------

test('unit E: one live Session per task, for all four live statuses', { skip }, async (t) => {
  const services = servicesOn(URL!);
  const client = await connectIsolatedPg(URL);
  try {
    for (const status of LIVE) {
      await t.test(`a second Session is refused while one is ${status}`, async () => {
        await emptyWorld(client);
        const target = await world(services.db, `su6-claim-${status}`);
        const held = await task(services.db, target, 'held');
        await session(services.db, target, { taskId: held, status, finishedAt: null });

        // The production INSERT's own shape: the arbiter has to name the same four statuses the
        // index does, or PostgreSQL infers nothing and this raises instead of returning no rows.
        const second = await client.query(
          `INSERT INTO "session" ("id","title","prompt","status","provider","owner_id",
             "creator_id","task_id","dispatch_origin","updated_at")
           VALUES ($1::uuid,'t','p','PENDING','claude',$2::uuid,$2::uuid,$3::uuid,'USER', now())
           ON CONFLICT ("task_id") WHERE "task_id" IS NOT NULL AND "deleted_at" IS NULL
             AND "status" IN ('PENDING','RUNNING','AWAITING_INPUT','INTERRUPTED')
           DO NOTHING RETURNING "id"`,
          [randomUUID(), target.ownerId, held],
        );
        assert.equal(second.rowCount, 0, `${status} must hold the claim`);
      });
    }

    await t.test('a terminal Session releases it', async () => {
      await emptyWorld(client);
      const target = await world(services.db, 'su6-claim-free');
      const done = await task(services.db, target, 'finished');
      await session(services.db, target, { taskId: done, status: RunStatus.SUCCEEDED });
      const second = await client.query(
        `INSERT INTO "session" ("id","title","prompt","status","provider","owner_id",
           "creator_id","task_id","dispatch_origin","updated_at")
         VALUES ($1::uuid,'t','p','PENDING','claude',$2::uuid,$2::uuid,$3::uuid,'USER', now())
         ON CONFLICT ("task_id") WHERE "task_id" IS NOT NULL AND "deleted_at" IS NULL
           AND "status" IN ('PENDING','RUNNING','AWAITING_INPUT','INTERRUPTED')
         DO NOTHING RETURNING "id"`,
        [randomUUID(), target.ownerId, done],
      );
      assert.equal(second.rowCount, 1, 'a finished run holds nothing');
    });
  } finally {
    await client.end();
    await services.dispose();
  }
});

// ---------------------------------------------------------------------------------------------
// 5. The migration itself
// ---------------------------------------------------------------------------------------------

test('unit E: 0130 is one transaction — it widens the claim or leaves everything as it was',
  { skip }, async (t) => {
    const services = servicesOn(URL!);
    const client = await connectIsolatedPg(URL);

    /** Put the database back to its pre-0130 shape, so the real migration can be replayed on it. */
    async function rewindTo0129(): Promise<void> {
      // EVERY object 0130 creates, including the column — `ALTER TABLE ADD COLUMN` is not
      // idempotent, so a rewind that left `starts_task_work` behind would make the re-apply fail on
      // its second statement and the restore assertions below would be measuring the rewind.
      await client.query('DROP TRIGGER IF EXISTS "session_superseded_task_guard" ON "session"');
      await client.query('DROP TRIGGER IF EXISTS "session_superseded_task_revive_guard" ON "session"');
      await client.query('DROP TRIGGER IF EXISTS "task_supersession_live_session_guard" ON "task"');
      await client.query('DROP TRIGGER IF EXISTS "task_supersession_successor_move_guard" ON "task"');
      await client.query('DROP TRIGGER IF EXISTS "task_verification_subject_guard" ON "task"');
      await client.query('DROP TRIGGER IF EXISTS "task_supersession_project_lock_order" ON "task"');
      await client.query(
        'DROP TRIGGER IF EXISTS "session_admission_lock_order_insert_delete" ON "session"');
      await client.query('DROP TRIGGER IF EXISTS "session_admission_lock_order_update" ON "session"');
      // The functions too: an orphan left behind would make "did 0130 install this" answerable
      // before 0130 ran.
      await client.query('DROP FUNCTION IF EXISTS "session_admission_lock_order"()');
      await client.query('DROP FUNCTION IF EXISTS "task_supersession_project_lock_order"()');
      await client.query('DROP FUNCTION IF EXISTS "session_superseded_task_guard"()');
      await client.query('DROP FUNCTION IF EXISTS "task_supersession_live_session_guard"()');
      await client.query('DROP FUNCTION IF EXISTS "task_supersession_successor_move_guard"()');
      await client.query('DROP FUNCTION IF EXISTS "task_verification_subject_guard"()');
      await client.query('ALTER TABLE "task" DROP CONSTRAINT IF EXISTS "task_retirement_status_check"');
      await client.query('ALTER TABLE "session" DROP COLUMN IF EXISTS "starts_task_work"');
      await client.query(
        'ALTER TABLE "project_acceptance_run" DROP COLUMN IF EXISTS "digest_version"');
      await client.query('DROP INDEX IF EXISTS "task_terminal_reason_idx"');
      await client.query('DROP INDEX IF EXISTS "session_task_execution_claim_idx"');
      await client.query(`
        CREATE UNIQUE INDEX "session_task_execution_claim_idx" ON "session"("task_id")
         WHERE "task_id" IS NOT NULL AND "deleted_at" IS NULL
           AND "status" IN ('PENDING', 'RUNNING')`);
      await rewindReplacedFunctions();
      await rewindAcceptanceObjects();
    }

    /**
     * Restore the two functions 0130 REPLACES to their 0122 (two-status) text.
     *
     * A rewind that left them at their NEW definitions would make the rollback assertion below
     * vacuous: the suite would "prove" a failed migration did not change them by starting from a
     * state where they were already changed. The whole database is migrated to 0130 before any spec
     * runs, so this is not hypothetical — it is the default.
     */
    async function rewindReplacedFunctions(): Promise<void> {
      await client.query(`
        CREATE OR REPLACE FUNCTION "session_project_capacity_serialize"() RETURNS trigger AS $fn$
        DECLARE old_live boolean; new_live boolean;
        BEGIN
          old_live := TG_OP <> 'INSERT' AND OLD."task_id" IS NOT NULL
            AND OLD."deleted_at" IS NULL AND OLD."status" IN ('PENDING', 'RUNNING');
          new_live := TG_OP <> 'DELETE' AND NEW."task_id" IS NOT NULL
            AND NEW."deleted_at" IS NULL AND NEW."status" IN ('PENDING', 'RUNNING');
          IF TG_OP = 'UPDATE' AND old_live = new_live
             AND OLD."task_id" IS NOT DISTINCT FROM NEW."task_id" THEN
            RETURN NEW;
          END IF;
          UPDATE "project" SET "updated_at" = CURRENT_TIMESTAMP
           WHERE "id" IN (
             SELECT "project_id" FROM "task"
              WHERE "id" IN (
                CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD."task_id" END,
                CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE NEW."task_id" END
              ) AND "project_id" IS NOT NULL
           );
          IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
          RETURN NEW;
        END;
        $fn$ LANGUAGE plpgsql`);
      await client.query(`
        CREATE OR REPLACE FUNCTION "task_claimed_project_move_guard"() RETURNS trigger AS $fn$
        BEGIN
          IF NEW."project_id" IS DISTINCT FROM OLD."project_id" AND EXISTS (
            SELECT 1 FROM "session" s WHERE s."task_id" = NEW."id" AND s."deleted_at" IS NULL
              AND s."status" IN ('PENDING', 'RUNNING')
          ) THEN
            RAISE EXCEPTION 'TASK_CLAIMED_PROJECT_MOVE: task % has a live execution claim', NEW."id";
          END IF;
          RETURN NEW;
        END;
        $fn$ LANGUAGE plpgsql`);
    }

    /**
     * Restore 0127's acceptance gate and fact trigger, including the trigger's own column list.
     *
     * 0130 replaces both, and the column list is what decides whether the function is called at
     * all — so a rewind that skipped them would leave the suite asserting that a failed migration
     * "did not change" objects it had never put back.
     */
    async function rewindAcceptanceObjects(): Promise<void> {
      await client.query(`CREATE OR REPLACE FUNCTION project_acceptance_done_gate() RETURNS TRIGGER AS $fn$
DECLARE
  run          "project_acceptance_run"%ROWTYPE;
  open_blocker INTEGER;
  open_defect  INTEGER;
BEGIN
  IF NEW."status" <> 'DONE' OR OLD."status" = 'DONE' THEN
    RETURN NEW;
  END IF;

  -- A legacy DONE that is being re-asserted without a run: only allowed while the stamp is still
  -- there, which is precisely the row the backfill above made and nothing else can create.
  IF NEW."accepted_run_id" IS NULL THEN
    IF NEW."legacy_accepted_at" IS NOT NULL THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'ACCEPTANCE_MISSING: project % has no acceptance run to be DONE against', NEW."id"
      USING ERRCODE = 'raise_exception';
  END IF;

  SELECT * INTO run FROM "project_acceptance_run" WHERE "id" = NEW."accepted_run_id";
  IF NOT FOUND OR run."project_id" <> NEW."id" THEN
    RAISE EXCEPTION 'ACCEPTANCE_MISSING: acceptance run % does not belong to project %',
      NEW."accepted_run_id", NEW."id" USING ERRCODE = 'raise_exception';
  END IF;
  IF run."verdict" IS DISTINCT FROM 'PASS'::"project_acceptance_verdict" THEN
    RAISE EXCEPTION 'ACCEPTANCE_MISSING: acceptance run % concluded %, not PASS',
      run."id", COALESCE(run."verdict"::text, 'nothing yet') USING ERRCODE = 'raise_exception';
  END IF;
  IF run."superseded_at" IS NOT NULL THEN
    RAISE EXCEPTION 'ACCEPTANCE_EVIDENCE_STALE: acceptance run % was superseded at %',
      run."id", run."superseded_at" USING ERRCODE = 'raise_exception';
  END IF;

  -- §13.4 clause 4 read the other way round: a project cannot be finished while something it
  -- already knows about is unfinished. Both counts are the same reads the service gate makes.
  SELECT count(*) INTO open_blocker FROM "project_blocker" b
   WHERE b."project_id" = NEW."id" AND b."resolved_at" IS NULL;
  IF open_blocker > 0 THEN
    RAISE EXCEPTION 'ACCEPTANCE_BLOCKED: project % has % open blocker(s)', NEW."id", open_blocker
      USING ERRCODE = 'raise_exception';
  END IF;

  SELECT count(*) INTO open_defect FROM "task_verification_failure" f
   WHERE f."project_id" = NEW."id" AND f."resolved_at" IS NULL;
  IF open_defect > 0 THEN
    RAISE EXCEPTION 'ACCEPTANCE_BLOCKED: project % has % unresolved verification failure(s)',
      NEW."id", open_defect USING ERRCODE = 'raise_exception';
  END IF;

  RETURN NEW;
END;
$fn$ LANGUAGE plpgsql;`);
      await client.query(`CREATE OR REPLACE FUNCTION project_acceptance_task_fact() RETURNS TRIGGER AS $fn$
DECLARE
  fact TEXT;
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM project_acceptance_reopen(NEW."project_id", 'task.created',
      jsonb_build_object('taskId', NEW."id"));
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    PERFORM project_acceptance_reopen(OLD."project_id", 'task.deleted',
      jsonb_build_object('taskId', OLD."id"));
    RETURN OLD;
  END IF;

  IF OLD."project_id" IS DISTINCT FROM NEW."project_id" THEN
    -- AE10: two projections change, so two projects are asked, in id order (§8.6 LO2) so that
    -- A→B and B→A cannot make a cycle out of each other.
    IF OLD."project_id" IS NOT NULL AND NEW."project_id" IS NOT NULL
       AND OLD."project_id" > NEW."project_id" THEN
      PERFORM project_acceptance_reopen(NEW."project_id", 'task.project_moved_in',
        jsonb_build_object('taskId', NEW."id", 'from', OLD."project_id"));
      PERFORM project_acceptance_reopen(OLD."project_id", 'task.project_moved_out',
        jsonb_build_object('taskId', NEW."id", 'to', NEW."project_id"));
    ELSE
      PERFORM project_acceptance_reopen(OLD."project_id", 'task.project_moved_out',
        jsonb_build_object('taskId', NEW."id", 'to', NEW."project_id"));
      PERFORM project_acceptance_reopen(NEW."project_id", 'task.project_moved_in',
        jsonb_build_object('taskId', NEW."id", 'from', OLD."project_id"));
    END IF;
    RETURN NEW;
  END IF;

  fact := CASE
    WHEN OLD."status" IS DISTINCT FROM NEW."status" THEN 'task.status_changed'
    WHEN OLD."completion_policy" IS DISTINCT FROM NEW."completion_policy" THEN 'task.completion_policy'
    WHEN OLD."verdict" IS DISTINCT FROM NEW."verdict" THEN 'task.verdict'
    WHEN OLD."verifies_task_id" IS DISTINCT FROM NEW."verifies_task_id" THEN 'task.verifies_task_id'
    ELSE NULL
  END;
  IF fact IS NOT NULL THEN
    PERFORM project_acceptance_reopen(NEW."project_id", fact,
      jsonb_build_object('taskId', NEW."id"));
  END IF;
  RETURN NEW;
END;
$fn$ LANGUAGE plpgsql;`);
      await client.query('DROP TRIGGER IF EXISTS "project_acceptance_task_fact_update" ON "task"');
      await client.query(`
        CREATE TRIGGER "project_acceptance_task_fact_update"
          AFTER UPDATE OF "status", "completion_policy", "project_id", "verdict", "verifies_task_id"
          ON "task"
          FOR EACH ROW EXECUTE FUNCTION project_acceptance_task_fact()`);
    }

    /** The columns `project_acceptance_task_fact_update` currently listens on, sorted. */
    async function acceptanceFactColumns(): Promise<string[]> {
      const result = await client.query<{ attname: string }>(`
        SELECT a.attname FROM pg_trigger t
          JOIN pg_attribute a ON a.attrelid = t.tgrelid AND a.attnum = ANY (t.tgattr)
         WHERE t.tgname = 'project_acceptance_task_fact_update'
         ORDER BY a.attname`);
      return result.rows.map((row) => row.attname);
    }

    /** Which of the two REPLACED functions still measure "live" with only two statuses. */
    async function twoStatusFunctions(): Promise<string[]> {
      const result = await client.query<{ proname: string }>(`
        SELECT proname FROM pg_proc
         WHERE proname IN ('session_project_capacity_serialize', 'task_claimed_project_move_guard')
           AND prosrc NOT LIKE '%AWAITING_INPUT%'
         ORDER BY proname`);
      return result.rows.map((row) => row.proname);
    }

    async function claimPredicate(): Promise<string> {
      const result = await client.query<{ def: string }>(
        `SELECT indexdef AS def FROM pg_indexes WHERE indexname = 'session_task_execution_claim_idx'`,
      );
      return result.rows[0]?.def ?? '';
    }

    /**
     * Put 0130 back, and PROVE it went back.
     *
     * Never swallowed. A restore that fails silently leaves every later spec in this file running
     * against a database rewound to 0129 — they would exercise the old two-status index and the
     * absent guards and report green, which is the one failure mode a suite must not have. The
     * fixture is emptied FIRST because the scenarios above deliberately create rows 0130 refuses to
     * migrate over; leaving them would make the restore fail every time, by design.
     */
    async function restore0130(): Promise<void> {
      // A subtest that ended on a failed migration leaves this connection inside an aborted
      // transaction, where every statement — including the identity probe `emptyWorld` runs — is
      // refused with 25P02. Ending it first is what makes this callable from a `finally` whatever
      // happened, which is the only way a restore is worth having.
      await client.query('ROLLBACK').catch(() => undefined);
      await emptyWorld(client);
      // Rewound first so this is idempotent from ANY state a subtest can leave: the one that
      // already applied 0130 successfully would otherwise re-create objects that exist, and a
      // restore that only works after a failure is a restore nobody can call in a `finally`.
      await rewindTo0129();
      await client.query(MIGRATION_0130);
      assert.match(await claimPredicate(), /AWAITING_INPUT/, 'claim index restored');
      assert.match(await claimPredicate(), /INTERRUPTED/);
      const objects = await client.query<{ name: string }>(`
        SELECT tgname AS name FROM pg_trigger
         WHERE tgname IN ('session_admission_lock_order_insert_delete',
                          'session_admission_lock_order_update',
                          'session_superseded_task_guard', 'session_superseded_task_revive_guard',
                          'task_supersession_live_session_guard',
                          'task_supersession_project_lock_order',
                          'task_supersession_successor_move_guard',
                          'task_verification_subject_guard',
                          'project_acceptance_task_fact_update')
        UNION ALL
        SELECT conname AS name FROM pg_constraint WHERE conname = 'task_retirement_status_check'
        ORDER BY name`);
      assert.deepEqual(objects.rows.map((row) => row.name), [
        'project_acceptance_task_fact_update',
        'session_admission_lock_order_insert_delete',
        'session_admission_lock_order_update',
        'session_superseded_task_guard',
        'session_superseded_task_revive_guard',
        'task_retirement_status_check',
        'task_supersession_live_session_guard',
        'task_supersession_project_lock_order',
        'task_supersession_successor_move_guard',
        'task_verification_subject_guard',
      ], 'every object 0130 installs is back');
      // Not merely present — carrying the NOWAIT that is the whole mechanism for the statements
      // whose row lock cannot be reordered.
      const nowait = await client.query<{ proname: string }>(`
        SELECT proname FROM pg_proc
         WHERE proname IN ('session_admission_lock_order', 'task_supersession_project_lock_order',
                           'task_verification_subject_guard')
           AND prosrc LIKE '%NOWAIT%'
         ORDER BY proname`);
      assert.deepEqual(nowait.rows.map((row) => row.proname), [
        'session_admission_lock_order',
        'task_supersession_project_lock_order',
        'task_verification_subject_guard',
      ], 'every fence that cannot reorder its acquisitions fails fast instead');
      // The column, with the default that decides what an older binary's write means. `true` is
      // load-bearing (see the migration): asserted rather than assumed, because a rewind that
      // recreated it with the other default would silently hand every legacy insert the exemption.
      const column = await client.query<{ default: string | null; nullable: string }>(`
        SELECT column_default AS default, is_nullable AS nullable
          FROM information_schema.columns
         WHERE table_name = 'session' AND column_name = 'starts_task_work'`);
      assert.equal(column.rowCount, 1, 'starts_task_work exists');
      assert.equal(column.rows[0].default, 'true', 'and defaults to fail-safe');
      assert.equal(column.rows[0].nullable, 'NO');
      // ...and the acceptance trigger listens on the two columns SU6 added, not just 0127's five.
      const columns = await client.query<{ attname: string }>(`
        SELECT a.attname FROM pg_trigger t
          JOIN pg_attribute a ON a.attrelid = t.tgrelid AND a.attnum = ANY (t.tgattr)
         WHERE t.tgname = 'project_acceptance_task_fact_update'
         ORDER BY a.attname`);
      const listened = columns.rows.map((row) => row.attname);
      assert.ok(listened.includes('terminal_reason'), 'reopen listens on terminal_reason');
      assert.ok(listened.includes('superseded_by_task_id'), 'and on the successor pointer');
      assert.ok(!listened.includes('superseded_at'), 'but not on the audit-only instant');
      // The DONE gate's own read moved with it: a finding whose verifier or subject was replaced is
      // no longer counted, which is what keeps it from disagreeing with the service gate.
      const gate = await client.query<{ src: string }>(
        `SELECT prosrc AS src FROM pg_proc WHERE proname = 'project_acceptance_done_gate'`,
      );
      assert.match(gate.rows[0].src, /verifier\."terminal_reason" IS NULL/);
    }

    try {
      await t.test('a clean upgrade widens the claim and installs both guards', async () => {
        try {
          await emptyWorld(client);
          await rewindTo0129();
          assert.doesNotMatch(await claimPredicate(), /AWAITING_INPUT/);

          await client.query(MIGRATION_0130);

          assert.match(await claimPredicate(), /AWAITING_INPUT/);
          assert.match(await claimPredicate(), /INTERRUPTED/);
          const triggers = await client.query<{ tgname: string }>(
            `SELECT tgname FROM pg_trigger
              WHERE tgname IN ('session_superseded_task_guard','task_supersession_live_session_guard')
              ORDER BY tgname`,
          );
          assert.deepEqual(triggers.rows.map((row) => row.tgname),
            ['session_superseded_task_guard', 'task_supersession_live_session_guard']);
        } finally {
          await restore0130();
        }
      });

      await t.test('duplicate live rows: it refuses, names them, and rolls back completely',
        async () => {
          try {
          await emptyWorld(client);
          await rewindTo0129();
          const target = await world(services.db, 'su6-migrate-dup');
          const held = await task(services.db, target, 'two live runs');
          // Reachable only through the very defect this index closes: one PENDING (which the old
          // two-status index does constrain) and one AWAITING_INPUT (which it does not).
          //
          // Raw, not the Prisma helper: the schema is rewound to 0129 here, so `starts_task_work`
          // does not exist and a client generated against 0130 would name it. This is what an
          // old binary's INSERT actually looks like, which is the shape the preflight has to cope
          // with anyway.
          for (const status of ['PENDING', 'AWAITING_INPUT']) {
            await client.query(
              `INSERT INTO "session" ("id","title","prompt","status","provider","owner_id",
                 "creator_id","task_id","dispatch_origin","updated_at")
               VALUES ($1::uuid,'t','p',$2::"run_status",'claude',$3::uuid,$3::uuid,$4::uuid,
                       'USER', now())`,
              [randomUUID(), status, target.ownerId, held],
            );
          }
          const sessionsBefore = await sessionRows(services, held);

          await assert.rejects(
            () => client.query(MIGRATION_0130),
            (error: Error) => {
              assert.match(error.message, /SESSION_TASK_CLAIM_AMBIGUOUS/);
              // The remedy must not be "end or delete them": one of these is a conversation
              // somebody is waiting on, and a terminal status written to make a deploy proceed
              // overwrites the only record of what that run did.
              assert.match(error.message, /terminal status OF ITS OWN/);
              assert.doesNotMatch(error.message, /end or delete/);
              return true;
            },
          );

          // The connection is left in an ABORTED transaction, which is itself the property under
          // test: the migration opened one with its own BEGIN, so the failure did not commit any of
          // the statements before it. Rolling back is how this connection becomes usable again —
          // and it discards every one of them.
          await client.query('ROLLBACK');

          // A failed migration inside its own transaction leaves NOTHING behind — in particular it
          // does not leave a database with no execution claim at all, which is what a loose
          // DROP-then-CREATE would do.
          assert.doesNotMatch(await claimPredicate(), /AWAITING_INPUT/);
          assert.match(await claimPredicate(), /PENDING/);
          const triggers = await client.query(
            `SELECT tgname FROM pg_trigger WHERE tgname = 'session_superseded_task_guard'`,
          );
          assert.equal(triggers.rowCount, 0, 'no half-installed guard');
          const fences = await client.query(`
            SELECT tgname FROM pg_trigger
             WHERE tgname IN ('session_admission_lock_order_insert_delete',
                              'session_admission_lock_order_update',
                              'task_supersession_project_lock_order')`);
          assert.equal(fences.rowCount, 0, 'no half-installed lock-order fence either');
          // 0127's acceptance objects too: a CREATE OR REPLACE and a DROP/CREATE TRIGGER are as
          // transactional as anything else, and this is the assertion that says so.
          assert.deepEqual(
            await acceptanceFactColumns(),
            ['completion_policy', 'project_id', 'status', 'verdict', 'verifies_task_id'],
            'the acceptance fact trigger is back on 0127 column list',
          );
          const rolledBackGate = await client.query<{ src: string }>(
            `SELECT prosrc AS src FROM pg_proc WHERE proname = 'project_acceptance_done_gate'`,
          );
          assert.doesNotMatch(rolledBackGate.rows[0].src, /verifier\."terminal_reason"/,
            'and the DONE gate is back at its 0127 read');
          // ...and the two functions 0130 REPLACES are back at their 0122 text. A CREATE OR REPLACE
          // inside a failed transaction has to roll back like any other statement; this is the
          // assertion that says so, and it is only meaningful because the rewind above put them
          // back to two statuses first.
          assert.deepEqual(
            await twoStatusFunctions(),
            ['session_project_capacity_serialize', 'task_claimed_project_move_guard'],
            'the function replacements rolled back with everything else',
          );
          assert.deepEqual(await sessionRows(services, held), sessionsBefore,
            'the migration changed no Session');
          } finally {
            await restore0130();
          }
        });

      for (const status of LIVE) {
        await t.test(`a retired task holding a ${status} run is named, not migrated over`,
          async () => {
            try {
              await emptyWorld(client);
              await rewindTo0129();
              const target = await world(services.db, `su6-migrate-live-${status}`);
              // Outside a project, so `dispatch_authority` is LEGACY and 0122's authority guard
              // does not refuse the raw insert below before this scenario can happen at all.
              const oldId = randomUUID();
              await services.db.task.create({
                data: {
                  id: oldId,
                  ownerId: target.ownerId,
                  title: 'retired but running',
                  creatorType: 'USER',
                  creatorId: target.ownerId,
                },
              });
              await client.query(
                `UPDATE "task" SET "status" = 'CANCELLED'::"task_status",
                        "terminal_reason" = 'ABANDONED', "superseded_at" = now()
                  WHERE "id" = $1::uuid`, [oldId],
              );
              const sessionId = randomUUID();
              await client.query(
                `INSERT INTO "session" ("id","title","prompt","status","provider","owner_id",
                   "creator_id","task_id","dispatch_origin","updated_at")
                 VALUES ($1::uuid,'t','p',$2::"run_status",'claude',$3::uuid,$3::uuid,$4::uuid,
                         'LEGACY_SWEEP', now())`,
                [sessionId, status, target.ownerId, oldId],
              );
              const sessionsBefore = await sessionRows(services, oldId);
              const taskBefore = await taskRow(services, oldId);

              await assert.rejects(
                () => client.query(MIGRATION_0130),
                /TASK_RETIRED_WITH_LIVE_SESSION/,
              );
              await client.query('ROLLBACK');

              // The guards it would install only see FUTURE writes, so migrating over this would
              // report success and leave the incident running. Nothing was chosen for anybody.
              assert.deepEqual(await sessionRows(services, oldId), sessionsBefore,
                'the migration rewrote no Session');
              assert.deepEqual(await taskRow(services, oldId), taskBefore,
                'and no Task');
              assert.doesNotMatch(await claimPredicate(), /AWAITING_INPUT/, '0129 objects intact');
            } finally {
              await restore0130();
            }
          });
      }

      await t.test('a live check pointed at a retired subject is named too', async () => {
        // The second shape, and the one a `session.task_id = retired.id` preflight walks past:
        // 0128 let a check be filed and started against a live subject and let that subject be
        // retired afterwards, leaving a run verifying replaced work.
        try {
          await emptyWorld(client);
          await rewindTo0129();
          const target = await world(services.db, 'su6-migrate-live-verifier');
          // Outside a project, for the same reason as above.
          const subject = randomUUID();
          const verifier = randomUUID();
          await services.db.task.create({
            data: {
              id: subject, ownerId: target.ownerId, title: 'the work',
              creatorType: 'USER', creatorId: target.ownerId,
            },
          });
          await services.db.task.create({
            data: {
              id: verifier, ownerId: target.ownerId, title: 'the check',
              verifiesTaskId: subject, creatorType: 'USER', creatorId: target.ownerId,
            },
          });
          await client.query(
            `UPDATE "task" SET "status" = 'CANCELLED'::"task_status",
                    "terminal_reason" = 'SUPERSEDED', "superseded_at" = now()
              WHERE "id" = $1::uuid`, [subject],
          );
          await client.query(
            `INSERT INTO "session" ("id","title","prompt","status","provider","owner_id",
               "creator_id","task_id","dispatch_origin","updated_at")
             VALUES ($1::uuid,'t','p','RUNNING','claude',$2::uuid,$2::uuid,$3::uuid,
                     'LEGACY_SWEEP', now())`,
            [randomUUID(), target.ownerId, verifier],
          );
          const before = await sessionRows(services, verifier);

          await assert.rejects(
            () => client.query(MIGRATION_0130),
            /TASK_RETIRED_WITH_LIVE_SESSION/,
          );
          await client.query('ROLLBACK');
          assert.deepEqual(await sessionRows(services, verifier), before);
        } finally {
          await restore0130();
        }
      });

      await t.test('a retired row holding a non-terminal status is named, not silently kept',
        async () => {
          try {
          await emptyWorld(client);
          await rewindTo0129();
          const target = await world(services.db, 'su6-migrate-status');
          const wedged = await task(services.db, target, 'open but abandoned');
          // Only reachable through the hole this release closes: a status-only reopen on a
          // retirement with no pointer, which 0128's guard returns early on.
          await client.query(
            `UPDATE "task" SET "terminal_reason" = 'ABANDONED', "superseded_at" = now()
              WHERE "id" = $1::uuid`, [wedged],
          );

          await assert.rejects(
            () => client.query(MIGRATION_0130),
            /TASK_RETIREMENT_STATUS_INCONSISTENT/,
          );
          await client.query('ROLLBACK');
          const after = await taskRow(services, wedged);
          assert.equal(after.status, 'OPEN', 'the migration chose nothing for it');
          assert.equal(after.reason, 'ABANDONED');
          } finally {
            // The wedged row is exactly what 0130 refuses to migrate over, so the restore clears
            // the fixture before re-applying — and does NOT swallow a failure.
            await restore0130();
          }
        });
    } finally {
      await client.end();
      await services.dispose();
    }
  });

// ---------------------------------------------------------------------------------------------
// 6. The atomic replace, and the incident's own repair
// ---------------------------------------------------------------------------------------------

test('unit E: create-with-supersedes is one act, and two racing replacements produce one winner',
  { skip }, async (t) => {
    const services = servicesOn(URL!);
    const client = await connectIsolatedPg(URL);
    try {
      await t.test('the successor and the link commit together', async () => {
        await emptyWorld(client);
        const target = await world(services.db, 'su7-atomic');
        const oldId = await task(services.db, target, 'the failed attempt');
        await services.db.task.update({
          where: { id: oldId }, data: { status: TaskStatus.FAILED },
        });

        const successor = await services.tasks.create(target.ownerId, {
          title: 'fresh review',
          projectId: target.projectId,
          supersedesTaskId: oldId,
        } as never);

        const after = await taskRow(services, oldId);
        assert.equal(after.successor, (successor as { id: string }).id);
        assert.equal(after.reason, 'SUPERSEDED');
        // SU4: the link writes no status. The attempt keeps how it ended.
        assert.equal(after.status, 'FAILED');
      });

      await t.test('a refused link writes no successor either — the whole call rolls back',
        async () => {
          await emptyWorld(client);
          const target = await world(services.db, 'su7-rollback');
          // Still OPEN: SU4 refuses a predecessor that has not stopped.
          const openTask = await task(services.db, target, 'still running');
          const before = await services.db.task.count({ where: { ownerId: target.ownerId } });

          await assert.rejects(() => services.tasks.create(target.ownerId, {
            title: 'premature replacement',
            projectId: target.projectId,
            supersedesTaskId: openTask,
          } as never));

          assert.equal(
            await services.db.task.count({ where: { ownerId: target.ownerId } }), before,
            'no orphan successor was left behind',
          );
        });

      await t.test('two concurrent replacements: one link, one typed conflict', async () => {
        await emptyWorld(client);
        const target = await world(services.db, 'su7-race');
        const oldId = await task(services.db, target, 'the failed attempt');
        await services.db.task.update({
          where: { id: oldId }, data: { status: TaskStatus.CANCELLED },
        });

        const attempt = (title: string) => services.tasks.create(target.ownerId, {
          title, projectId: target.projectId, supersedesTaskId: oldId,
        } as never).then(
          (created: { id: string }) => ({ ok: true as const, created }),
          (error: Error) => ({ ok: false as const, error }),
        );
        const [a, b] = await Promise.all([attempt('successor A'), attempt('successor B')]);

        const winners = [a, b].filter((result) => result.ok);
        const losers = [a, b].filter((result) => !result.ok);
        assert.equal(winners.length, 1, 'exactly one attempt may take over from another');
        assert.equal(losers.length, 1);
        // The loser is told WHICH task took over, rather than silently overwriting the pointer.
        assert.match((losers[0] as { error: Error }).error.message, /superseded/i);
        const after = await taskRow(services, oldId);
        assert.equal(
          after.successor,
          ((winners[0] as { created: { id: string } }).created).id,
          'the pointer names the winner, not whoever committed last',
        );
      });

      await t.test("the incident's own repair: one write restores FAILED and names the successor",
        async () => {
          // A rehearsal of the production repair on an isolated database, in the shape the incident
          // actually left behind: the old attempt CANCELLED at dispatch_attempt 3, two Sessions
          // that were cancelled when the mis-dispatch was stopped, and a successor that was created
          // WITHOUT a link because the two-call entrance made that possible.
          await emptyWorld(client);
          const target = await world(services.db, 'su6-incident');
          const successorId = await task(services.db, target, '[6R] fresh review');
          const oldId = await task(services.db, target, 'the superseded attempt');
          await services.db.task.update({
            where: { id: oldId },
            data: { status: TaskStatus.CANCELLED, dispatchAttempt: 3n },
          });
          const misdispatched = [
            await session(services.db, target, {
              taskId: oldId, status: RunStatus.CANCELLED,
            }),
            await session(services.db, target, {
              taskId: oldId, status: RunStatus.CANCELLED,
            }),
          ];
          await services.db.session.updateMany({
            where: { id: { in: misdispatched } }, data: { endReason: 'ended' },
          });
          const sessionsBefore = await sessionRows(services, oldId);

          await services.tasks.update(target.ownerId, oldId, {
            status: 'FAILED',
            supersededByTaskId: successorId,
          } as never);

          const after = await taskRow(services, oldId);
          assert.equal(after.status, 'FAILED', 'restored to the outcome its run left');
          assert.equal(after.successor, successorId, 'and the successor is a relation now');
          assert.equal(after.reason, 'SUPERSEDED');
          assert.equal(after.attempt, '3', 'the dispatch epoch is untouched');
          assert.deepEqual(await sessionRows(services, oldId), sessionsBefore,
            'not one field of any existing Session was rewritten');

          // ...and the whole point: nothing will pick it up again.
          const outcome = await new ProjectFailureRecoveryService(services.db as never).scan();
          assert.deepEqual(outcome.rearmed, []);
          const dispatched = await dispatch(services, target, oldId);
          assert.equal(dispatched.refusalCode, 'TASK_SUPERSEDED');
          assert.equal(dispatched.sessionId, null);
        });
    } finally {
      await client.end();
      await services.dispose();
    }
  });

// ---------------------------------------------------------------------------------------------
// 7. Acceptance and the current-blocker projection
// ---------------------------------------------------------------------------------------------

test('unit E: a finding from a replaced check is audit, not a current block', { skip },
  async (t) => {
    const services = servicesOn(URL!);
    const client = await connectIsolatedPg(URL);

    async function fixture(label: string): Promise<{
      target: World; verifier: string; subject: string; defect: string;
    }> {
      await emptyWorld(client);
      const target = await world(services.db, label);
      const subject = await task(services.db, target, 'the work');
      const verifier = await task(services.db, target, 'the check',
        { verifiesTaskId: subject });
      const defect = await task(services.db, target, 'fix what the check found',
        { parentTaskId: subject });
      await services.db.taskVerificationFailure.create({
        data: {
          projectId: target.projectId,
          verifierTaskId: verifier,
          subjectTaskId: subject,
          verdict: 'FAIL',
          verdictRevision: 1n,
          blocksDownstream: true,
          defectTaskId: defect,
        },
      });
      return { target, verifier, subject, defect };
    }

    async function blockedCount(target: World): Promise<number> {
      const result = await services.projects.verifications(target.ownerId, target.projectId);
      return (result as { blockedTasks: unknown[] }).blockedTasks.length;
    }

    try {
      await t.test('nothing retired: the finding is a current block', async () => {
        const { target } = await fixture('su6-verify-neg');
        assert.ok(await blockedCount(target) > 0, 'a live finding still stops work');
      });

      await t.test('the verifier was replaced: the finding stops blocking', async () => {
        const { target, verifier } = await fixture('su6-verify-verifier');
        await services.db.task.update({
          where: { id: verifier }, data: { status: TaskStatus.CANCELLED },
        });
        await retire(services, verifier, { successor: false, reason: 'SUPERSEDED' }, null);
        assert.equal(await blockedCount(target), 0);
        // ...and the audit is intact: the row is still there with everything it recorded.
        assert.equal(
          await services.db.taskVerificationFailure.count({ where: { projectId: target.projectId } }),
          1, 'the finding is preserved, only its status as a CURRENT block changed',
        );
      });

      await t.test('the subject was replaced: the finding stops blocking', async () => {
        const { target, subject } = await fixture('su6-verify-subject');
        await services.db.task.update({
          where: { id: subject }, data: { status: TaskStatus.CANCELLED },
        });
        await retire(services, subject, { successor: false, reason: 'ABANDONED' }, null);
        assert.equal(await blockedCount(target), 0);
      });
    } finally {
      await client.end();
      await services.dispose();
    }
  });

// ---------------------------------------------------------------------------------------------
// 8. §13.8: @-mention delivery is a ledger, not a loop
// ---------------------------------------------------------------------------------------------

test('unit E: every @-mention gets exactly one delivery, and says what happened to it', { skip },
  async (t) => {
    const services = servicesOn(URL!);
    const client = await connectIsolatedPg(URL);

    interface DeliveryRow {
      id: string; workspaceId: string; status: string;
      attempts: number; claims: number; waits: number;
      desiredSessionId: string | null; targetSessionId: string | null;
      turnId: string | null; lastError: string | null;
      errorCode: string | null; requiredAction: string | null;
    }

    async function deliveries(taskTarget: string): Promise<DeliveryRow[]> {
      return services.db.$queryRawUnsafe(
        `SELECT "id", "workspace_id" AS "workspaceId", "status"::text AS status, "attempts",
                "claims", "waits", "desired_session_id" AS "desiredSessionId",
                "target_session_id" AS "targetSessionId", "turn_id" AS "turnId",
                "last_error" AS "lastError", "error_code" AS "errorCode",
                "required_action" AS "requiredAction"
           FROM "task_comment_mention_delivery"
          WHERE "task_id" = $1::uuid ORDER BY "workspace_id"`,
        taskTarget,
      );
    }

    /** Every session that executes this task or is a conversation about it. */
    async function sessionsFor(taskTarget: string): Promise<Array<{
      id: string; workspaceId: string | null; status: string; branch: string | null;
      bound: string | null; about: string | null; startsTaskWork: boolean;
    }>> {
      return services.db.$queryRawUnsafe(
        `SELECT "id", "workspace_id" AS "workspaceId", "status"::text AS status, "branch",
                "task_id" AS bound, "context_task_id" AS about,
                "starts_task_work" AS "startsTaskWork"
           FROM "session"
          WHERE "task_id" = $1::uuid OR "context_task_id" = $1::uuid
          ORDER BY "created_at"`,
        taskTarget,
      );
    }

    async function turnsIn(sessionId: string): Promise<string[]> {
      const rows = await services.db.$queryRawUnsafe<Array<{ clientTurnId: string }>>(
        `SELECT "client_turn_id" AS "clientTurnId" FROM "conversation_turn"
          WHERE "session_id" = $1::uuid ORDER BY "seq"`, sessionId,
      );
      return rows.map((row) => row.clientTurnId);
    }

    /**
     * File a comment WITHOUT the service's post-commit kick.
     *
     * `addComment` fires the sweep in the background, which races anything a test does next and
     * would make every assertion below depend on scheduling. The ledger rows are written by 0131's
     * trigger inside the comment's own statement, so writing the comment directly is the same
     * durable state a crashed process leaves — and the test drives the sweep itself.
     */
    async function comment(target: World, taskTarget: string, mentions: string[]): Promise<string> {
      const row = await services.db.taskComment.create({
        data: {
          taskId: taskTarget, authorType: 'USER', authorId: target.ownerId,
          body: '@please look', mentions, mentionDeliveryVersion: 1,
        },
      });
      return row.id;
    }

    async function secondAgent(target: World, label: string): Promise<string> {
      const id = randomUUID();
      await services.db.workspace.create({
        data: {
          id, ownerId: target.ownerId, runnerId: target.runnerId, name: label, enabled: true,
        },
      });
      return id;
    }

    try {
      await t.test('two mentioned agents each get their own conversation', async () => {
        // The bug this replaces: a mention opened a session BOUND to the task, so the first agent
        // took the execution claim and the second could not be created at all — its comment was
        // persisted, its delivery failed, and one `logger.warn` was the only trace.
        await emptyWorld(client);
        const target = await world(services.db, 'su8-two-agents');
        const other = await secondAgent(target, 'su8-second');
        const subject = await task(services.db, target, 'the work');
        await comment(target, subject, [target.agentId, other]);

        await services.tasks.deliverMentions();

        const rows = await deliveries(subject);
        assert.equal(rows.length, 2, 'one ledger row per mentioned agent');
        for (const row of rows) {
          assert.ok(['DELIVERED', 'QUEUED', 'SESSION_CREATED'].includes(row.status), row.status);
          assert.ok(row.targetSessionId, 'each landed somewhere');
        }
        assert.equal(new Set(rows.map((row) => row.targetSessionId)).size, 2,
          'and in two different places');

        const opened = await sessionsFor(subject);
        assert.equal(opened.length, 2);
        assert.deepEqual(opened.map((row) => row.bound), [null, null],
          'neither takes the task execution claim');
        assert.deepEqual(opened.map((row) => row.about), [subject, subject],
          'both are recorded as ABOUT it');
        assert.deepEqual(opened.map((row) => row.startsTaskWork), [false, false]);
        assert.deepEqual(opened.map((row) => row.branch), [null, null],
          'a conversation leaves no branch behind');
        assert.deepEqual(
          new Set(opened.map((row) => row.workspaceId)),
          new Set([target.agentId, other]),
          'and each belongs to the agent it was addressed to',
        );
      });

      await t.test('a mention delivers into the agent\'s live work run when it has one', async () => {
        await emptyWorld(client);
        const target = await world(services.db, 'su8-live-run');
        const subject = await task(services.db, target, 'the work');
        const run = await session(services.db, target, {
          taskId: subject, status: RunStatus.AWAITING_INPUT, finishedAt: null,
        });
        const commentId = await comment(target, subject, [target.agentId]);

        await services.tasks.deliverMentions();

        const [row] = await deliveries(subject);
        // QUEUED, not DELIVERED: the turn exists and the engine has not read it yet. The two are
        // different facts, and collapsing them retires the ledger on a message nobody has seen.
        assert.equal(row.status, 'QUEUED');
        assert.equal(row.targetSessionId, run, 'the turn went to the run already in this context');
        // Exactly one turn under the DELIVERY key. The session's own opening prompt is beside it
        // and is not this delivery's business — asserting the whole list would be asserting that a
        // work run has no work in it.
        const keys = await turnsIn(run);
        assert.equal(keys.filter((key) => key === `task-comment-mention:${row.id}`).length, 1,
          'the mention landed exactly once');
        assert.equal(row.turnId != null, true, 'and the ledger names the turn that carried it');
        void commentId;
      });

      await t.test('no runner is a WAIT, not a failure: the budget is untouched', async () => {
        await emptyWorld(client);
        const target = await world(services.db, 'su8-blocked');
        const orphan = await secondAgent(target, 'su8-no-runner');
        await services.db.workspace.update({ where: { id: orphan }, data: { runnerId: null } });
        const subject = await task(services.db, target, 'the work');
        await comment(target, subject, [orphan]);

        await services.tasks.deliverMentions();
        const [first] = await deliveries(subject);
        assert.equal(first.status, 'BLOCKED', 'a state, not a failure');
        assert.equal(first.attempts, 0, 'the delivery budget is NOT spent on a machine being down');
        assert.equal(first.waits, 1, 'the backoff generation is what moved');
        assert.equal(first.errorCode, 'NO_RUNNER');
        assert.match(first.requiredAction ?? '', /bind this agent to a runner/);

        // ...and it stays that way however long the runner is away: this must never reach DEAD.
        for (let round = 0; round < 3; round += 1) {
          await services.db.$executeRawUnsafe(
            `UPDATE "task_comment_mention_delivery" SET "next_attempt_at" = now()
              WHERE "task_id" = $1::uuid`, subject,
          );
          await services.tasks.deliverMentions();
        }
        const [after] = await deliveries(subject);
        assert.equal(after.status, 'BLOCKED');
        assert.equal(after.attempts, 0);
        assert.equal(after.waits, 4, 'each wait advances the backoff and nothing else');

        // Bind a runner and it delivers itself, with no intervention.
        await services.db.workspace.update({
          where: { id: orphan }, data: { runnerId: target.runnerId },
        });
        await services.db.$executeRawUnsafe(
          `UPDATE "task_comment_mention_delivery" SET "next_attempt_at" = now()
            WHERE "task_id" = $1::uuid`, subject,
        );
        await services.tasks.deliverMentions();
        const [recovered] = await deliveries(subject);
        assert.ok(['DELIVERED', 'QUEUED', 'SESSION_CREATED'].includes(recovered.status), recovered.status);
      });

      await t.test('a crash after the comment commits loses nothing', async () => {
        // The comment and its ledger rows are one statement (0131's trigger), so "the comment
        // exists" and "somebody owes this agent a message" cannot disagree.
        await emptyWorld(client);
        const target = await world(services.db, 'su8-crash');
        const subject = await task(services.db, target, 'the work');
        await comment(target, subject, [target.agentId]);

        assert.deepEqual((await deliveries(subject)).map((row) => row.status), ['PENDING']);
        await services.tasks.deliverMentions();
        const [row] = await deliveries(subject);
        assert.ok(['DELIVERED', 'QUEUED', 'SESSION_CREATED'].includes(row.status), row.status);
      });

      await t.test('a crash between binding and creating reuses the same id', async () => {
        // The window the two id columns exist for. `desired_session_id` is written before the
        // session, so this is exactly the state a worker that died in between leaves behind.
        await emptyWorld(client);
        const target = await world(services.db, 'su8-crash-bind');
        const subject = await task(services.db, target, 'the work');
        await comment(target, subject, [target.agentId]);
        const intended = randomUUID();
        await services.db.$executeRawUnsafe(
          `UPDATE "task_comment_mention_delivery"
              SET "desired_session_id" = $2::uuid, "status" = 'BLOCKED', "next_attempt_at" = now()
            WHERE "task_id" = $1::uuid`, subject, intended,
        );

        await services.tasks.deliverMentions();

        const opened = await sessionsFor(subject);
        assert.equal(opened.length, 1, 'one conversation, not a second one');
        assert.equal(opened[0].id, intended, 'and it is the id the crashed attempt intended');
        const [row] = await deliveries(subject);
        assert.equal(row.targetSessionId, intended);
      });

      await t.test('a crash between delivering and settling writes no second turn', async () => {
        await emptyWorld(client);
        const target = await world(services.db, 'su8-crash-settle');
        const subject = await task(services.db, target, 'the work');
        const run = await session(services.db, target, {
          taskId: subject, status: RunStatus.AWAITING_INPUT, finishedAt: null,
        });
        await comment(target, subject, [target.agentId]);
        await services.tasks.deliverMentions();
        const before = await turnsIn(run);
        const mentionKeys = (keys: string[]) => keys.filter((key) => key.startsWith('task-comment-mention:'));
        assert.equal(mentionKeys(before).length, 1, 'delivered once to start with');

        // The shape a worker that wrote the turn and died before marking the ledger leaves.
        await services.db.$executeRawUnsafe(
          `UPDATE "task_comment_mention_delivery"
              SET "status" = 'PENDING', "next_attempt_at" = now(),
                  "lease_holder" = NULL, "lease_expires_at" = NULL, "turn_id" = NULL
            WHERE "task_id" = $1::uuid`, subject,
        );
        await services.tasks.deliverMentions();

        assert.deepEqual(await turnsIn(run), before,
          'the fixed delivery key means a re-run writes no second turn');
        assert.equal(mentionKeys(await turnsIn(run)).length, 1);
        const [row] = await deliveries(subject);
        assert.ok(['QUEUED', 'DELIVERED'].includes(row.status), row.status);
        assert.equal(row.targetSessionId, run, 'and it did not move to a new session');
        assert.equal((await sessionsFor(subject)).length, 1);
      });

      await t.test('a remembered conversation that ENDED is never revived', async () => {
        await emptyWorld(client);
        const target = await world(services.db, 'su8-terminal');
        const subject = await task(services.db, target, 'the work');
        await comment(target, subject, [target.agentId]);
        await services.tasks.deliverMentions();
        const [first] = await sessionsFor(subject);

        // It ended without ever seeding a turn, and the ledger is asked to try again.
        await services.db.session.update({
          where: { id: first.id },
          data: { status: RunStatus.FAILED, finishedAt: new Date(), error: 'runner died' },
        });
        const frozen = await services.db.session.findUniqueOrThrow({ where: { id: first.id } });
        await services.db.$executeRawUnsafe(
          `UPDATE "task_comment_mention_delivery"
              SET "status" = 'BLOCKED', "next_attempt_at" = now()
            WHERE "task_id" = $1::uuid`, subject,
        );

        await services.tasks.deliverMentions();

        const after = await services.db.session.findUniqueOrThrow({ where: { id: first.id } });
        assert.equal(after.status, RunStatus.FAILED, 'the ended run is what it was');
        assert.deepEqual(after.finishedAt, frozen.finishedAt);
        assert.equal(after.error, frozen.error);
        const opened = await sessionsFor(subject);
        assert.equal(opened.length, 2, 'a NEW conversation was opened instead');
        const [row] = await deliveries(subject);
        assert.notEqual(row.targetSessionId, first.id, 'and the binding moved to it');
      });

      await t.test('a disabled agent BLOCKS without spending the budget', async () => {
        await emptyWorld(client);
        const target = await world(services.db, 'su8-disabled');
        const subject = await task(services.db, target, 'the work');
        await services.db.workspace.update({
          where: { id: target.agentId }, data: { enabled: false },
        });
        await comment(target, subject, [target.agentId]);

        await services.tasks.deliverMentions();

        const [row] = await deliveries(subject);
        assert.equal(row.status, 'BLOCKED');
        assert.equal(row.errorCode, 'WORKSPACE_DISABLED');
        assert.equal(row.attempts, 0, 'a switch somebody flips back is not a failed delivery');
        assert.match(row.requiredAction ?? '', /re-enable/);

        await services.db.workspace.update({
          where: { id: target.agentId }, data: { enabled: true },
        });
        await services.db.$executeRawUnsafe(
          `UPDATE "task_comment_mention_delivery" SET "next_attempt_at" = now()
            WHERE "task_id" = $1::uuid`, subject,
        );
        await services.tasks.deliverMentions();
        const [after] = await deliveries(subject);
        assert.ok(['DELIVERED', 'QUEUED', 'SESSION_CREATED'].includes(after.status), after.status);
        assert.equal((await sessionsFor(subject)).length, 1, 'and exactly one conversation');
      });

      await t.test('a worker whose lease expired cannot overwrite what its successor wrote',
        async () => {
          // The CAS on every ledger write, exercised through the SERVICE rather than by a hand
          // written statement — a test that issues its own SQL would pass even if the fence were
          // deleted from the code it claims to be about.
          //
          // Worker A claims. Its lease expires. Worker B takes over and finishes. A then comes back
          // and tries to park and to re-bind, exactly as it would after a long GC pause.
          await emptyWorld(client);
          const target = await world(services.db, 'su8-lease-steal');
          const subject = await task(services.db, target, 'the work');
          await comment(target, subject, [target.agentId]);
          const [filed] = await deliveries(subject);

          // A's claim, then A's death: DELIVERING with an expired lease.
          await services.db.$executeRawUnsafe(
            `UPDATE "task_comment_mention_delivery"
                SET "status" = 'DELIVERING', "lease_holder" = 'worker-A',
                    "lease_expires_at" = now() - interval '1 minute'
              WHERE "id" = $1::uuid`, filed.id,
          );
          // B takes over and finishes, through the real sweep.
          await services.tasks.deliverMentions();
          const [byB] = await deliveries(subject);
          assert.notEqual(byB.status, 'DELIVERING', 'B reached a decision');

          const worker = services.tasks as unknown as {
            parkMentionDelivery(
              row: { id: string; attempts: number; ownerId: string; taskId: string },
              holder: string, error: unknown,
            ): Promise<void>;
            bindMentionTarget(id: string, holder: string, sessionId: string): Promise<void>;
          };
          // A comes back. Both of its writes go through the production CAS.
          await worker.parkMentionDelivery(
            { id: filed.id, attempts: 0, ownerId: target.ownerId, taskId: subject },
            'worker-A',
            new Error('late failure from a worker that no longer owns this'),
          );
          await assert.rejects(
            () => worker.bindMentionTarget(filed.id, 'worker-A', randomUUID()),
            /another worker owns this delivery/,
          );

          const [after] = await deliveries(subject);
          assert.deepEqual(
            {
              status: after.status, errorCode: after.errorCode,
              target: after.targetSessionId, attempts: after.attempts,
            },
            {
              status: byB.status, errorCode: byB.errorCode,
              target: byB.targetSessionId, attempts: byB.attempts,
            },
            'the row is exactly as its owner left it',
          );
        });

      await t.test('deleting the runner keeps the record of the mention it could not deliver',
        async () => {
          // The cascade that made this ledger necessary: runner → workspace → (before this) the
          // delivery row, so a comment mentioning an agent whose machine was later removed lost
          // every trace of why nobody replied.
          await emptyWorld(client);
          const target = await world(services.db, 'su8-runner-gone');
          const subject = await task(services.db, target, 'the work');
          await comment(target, subject, [target.agentId]);
          // The workspace is this project's coordinator, so its membership has to go first — the
          // cascade under test is runner → workspace → (previously) the ledger row.
          await services.db.session.deleteMany({ where: { ownerId: target.ownerId } });
          await services.db.projectMember.deleteMany({ where: { agentId: target.agentId } });
          await services.db.project.updateMany({
            where: { id: target.projectId },
            data: { coordinatorWorkspaceId: null, coordinatorSessionId: null },
          });
          await services.db.runner.delete({ where: { id: target.runnerId } });
          assert.equal(
            await services.db.workspace.count({ where: { id: target.agentId } }), 0,
            'the workspace went with its runner, which is the cascade this is about',
          );

          await services.tasks.deliverMentions();

          const rows = await deliveries(subject);
          assert.equal(rows.length, 1, 'the ledger survived the cascade');
          assert.equal(rows[0].status, 'DEAD');
          assert.equal(rows[0].errorCode, 'WORKSPACE_GONE');
          assert.equal(rows[0].workspaceId, target.agentId, 'and still names who was asked');
        });

      await t.test('a conversation claimed but not yet seeded is waited on, not re-delivered',
        async () => {
          // The window between the runner claiming a session (PENDING → RUNNING) and
          // `ensurePromptSeeded` writing the opening turn. A sweep landing there must recognise
          // the session as ITS OWN and wait — resuming would put the same text in twice.
          await emptyWorld(client);
          const target = await world(services.db, 'su8-claim-window');
          const subject = await task(services.db, target, 'the work');
          await comment(target, subject, [target.agentId]);
          await services.tasks.deliverMentions();
          const [opened] = await sessionsFor(subject);
          await services.db.$executeRawUnsafe(
            `DELETE FROM "conversation_turn" WHERE "session_id" = $1::uuid`, opened.id,
          );
          await services.db.session.update({
            where: { id: opened.id }, data: { status: RunStatus.RUNNING },
          });
          await services.db.$executeRawUnsafe(
            `UPDATE "task_comment_mention_delivery" SET "next_attempt_at" = now()
              WHERE "task_id" = $1::uuid`, subject,
          );

          await services.tasks.deliverMentions();

          assert.equal((await sessionsFor(subject)).length, 1, 'no second conversation');
          assert.deepEqual(await turnsIn(opened.id), [], 'and no turn was forced into it');
          const [row] = await deliveries(subject);
          assert.equal(row.status, 'SESSION_CREATED', 'it is still waiting, and says so');
          assert.equal(row.targetSessionId, opened.id);
        });

      await t.test('a rotation that crashes before creating still opens exactly one conversation',
        async () => {
          // Terminal target → rotate to a new desired id → crash. The retry must finish THAT
          // rotation rather than mint a third id.
          await emptyWorld(client);
          const target = await world(services.db, 'su8-rotate-crash');
          const subject = await task(services.db, target, 'the work');
          await comment(target, subject, [target.agentId]);
          await services.tasks.deliverMentions();
          const [first] = await sessionsFor(subject);
          await services.db.session.update({
            where: { id: first.id },
            data: { status: RunStatus.FAILED, finishedAt: new Date() },
          });
          await services.db.$executeRawUnsafe(
            `DELETE FROM "conversation_turn" WHERE "session_id" = $1::uuid`, first.id,
          );

          // The EXACT mid-rotation state, written rather than hoped for: the old target cleared,
          // a new desired id published, and no session behind it. That is what a worker that died
          // between the rotation UPDATE and the create leaves, and the retry must ADOPT that id
          // rather than mint a third.
          const intended = randomUUID();
          await services.db.$executeRawUnsafe(
            `UPDATE "task_comment_mention_delivery"
                SET "status" = 'BLOCKED', "next_attempt_at" = now(),
                    "target_session_id" = NULL, "turn_id" = NULL,
                    "desired_session_id" = $2::uuid
              WHERE "task_id" = $1::uuid`, subject, intended,
          );
          assert.equal(
            await services.db.session.count({ where: { id: intended } }), 0,
            'the id names nothing yet — this is the window',
          );

          await services.tasks.deliverMentions();

          const [rotated] = await deliveries(subject);
          const opened = await sessionsFor(subject);
          assert.equal(opened.length, 2, 'the ended one, and exactly one replacement');
          assert.equal(rotated.targetSessionId, intended,
            'the retry finished the rotation it found rather than starting another');
          assert.ok(opened.some((row) => row.id === intended));

          // ...and a further retry adds nothing.
          await services.db.$executeRawUnsafe(
            `UPDATE "task_comment_mention_delivery"
                SET "status" = 'BLOCKED', "next_attempt_at" = now()
              WHERE "task_id" = $1::uuid`, subject,
          );
          await services.tasks.deliverMentions();
          assert.equal((await sessionsFor(subject)).length, 2, 'still two');
        });

      await t.test('a conversation waiting to be claimed backs off instead of hot-polling',
        async () => {
          await emptyWorld(client);
          const target = await world(services.db, 'su8-backoff');
          const subject = await task(services.db, target, 'the work');
          await comment(target, subject, [target.agentId]);
          await services.tasks.deliverMentions();

          const [first] = await deliveries(subject);
          if (first.status !== 'SESSION_CREATED') return; // the runner seeded it already
          const gaps: number[] = [];
          for (let round = 0; round < 3; round += 1) {
            const [before] = await services.db.$queryRawUnsafe<Array<{ next: Date }>>(
              `SELECT "next_attempt_at" AS next FROM "task_comment_mention_delivery"
                WHERE "task_id" = $1::uuid`, subject,
            );
            gaps.push(before.next.getTime() - Date.now());
            await services.db.$executeRawUnsafe(
              `UPDATE "task_comment_mention_delivery" SET "next_attempt_at" = now()
                WHERE "task_id" = $1::uuid`, subject,
            );
            await services.tasks.deliverMentions();
          }
          assert.ok(gaps[1] > gaps[0] && gaps[2] > gaps[1],
            `each wait is longer than the last: ${gaps.join(', ')}`);
          const [after] = await deliveries(subject);
          assert.equal(after.attempts, 0, 'and waiting spends no delivery budget');
          assert.equal(after.claims, 0, 'nor the crash budget');
        });

      await t.test('a signed-out engine BLOCKS as availability, and delivers on sign-in',
        async () => {
          // `SessionsService.create` refuses this with a 409 — but it is availability, not a
          // failure: signing in clears it. Recognised by TYPE, so the mapping survives the message
          // being reworded.
          await emptyWorld(client);
          const target = await world(services.db, 'su8-signed-out');
          const subject = await task(services.db, target, 'the work');
          await services.db.runner.update({
            where: { id: target.runnerId },
            data: {
              status: 'ONLINE',
              lastHeartbeatAt: new Date(),
              engines: [{ engine: 'claude', installed: true, auth: 'no' }],
            },
          });
          await comment(target, subject, [target.agentId]);

          await services.tasks.deliverMentions();

          const [row] = await deliveries(subject);
          assert.equal(row.status, 'BLOCKED');
          assert.equal(row.errorCode, 'PROVIDER_UNAVAILABLE');
          assert.equal(row.attempts, 0, 'a sign-out is not a failed delivery');
          assert.match(row.requiredAction ?? '', /sign in to claude/);
          assert.deepEqual(await sessionsFor(subject), [], 'and nothing was created');

          await services.db.runner.update({
            where: { id: target.runnerId },
            data: { engines: [{ engine: 'claude', installed: true, auth: 'yes' }] },
          });
          await services.db.$executeRawUnsafe(
            `UPDATE "task_comment_mention_delivery" SET "next_attempt_at" = now()
              WHERE "task_id" = $1::uuid`, subject,
          );
          await services.tasks.deliverMentions();

          const [after] = await deliveries(subject);
          assert.ok(['DELIVERED', 'QUEUED', 'SESSION_CREATED'].includes(after.status), after.status);
          assert.equal((await sessionsFor(subject)).length, 1, 'delivered once, on recovery');
        });

      await t.test('a turn queued into a run that then FAILS is not called delivered', async () => {
        // The distinction QUEUED exists for. A work session carries the task prompt at seq 1 and
        // this mention at seq 2; seq 1 fails and takes the session with it. The mention's row is
        // right there in the table and the agent never read a word of it — so the ledger must not
        // retire, and the message must land somewhere else.
        await emptyWorld(client);
        const target = await world(services.db, 'su8-stranded');
        const subject = await task(services.db, target, 'the work');
        const run = await session(services.db, target, {
          taskId: subject, status: RunStatus.AWAITING_INPUT, finishedAt: null,
        });
        await comment(target, subject, [target.agentId]);
        await services.tasks.deliverMentions();

        const [queued] = await deliveries(subject);
        assert.equal(queued.status, 'QUEUED', 'durably queued, not yet read');

        // The run dies with the mention still PENDING behind it.
        await services.db.session.update({
          where: { id: run },
          data: { status: RunStatus.FAILED, finishedAt: new Date(), error: 'seq 1 died' },
        });
        await services.db.$executeRawUnsafe(
          `UPDATE "task_comment_mention_delivery" SET "next_attempt_at" = now()
            WHERE "task_id" = $1::uuid`, subject,
        );
        await services.tasks.deliverMentions();

        const [stranded] = await deliveries(subject);
        assert.notEqual(stranded.status, 'DELIVERED', 'nobody read it, so nobody may say they did');
        assert.equal(stranded.attempts, 0, 'and it is availability, not a failed delivery');

        // The next sweep puts it somewhere it can be read.
        await services.db.$executeRawUnsafe(
          `UPDATE "task_comment_mention_delivery" SET "next_attempt_at" = now()
            WHERE "task_id" = $1::uuid`, subject,
        );
        await services.tasks.deliverMentions();
        const [rehomed] = await deliveries(subject);
        assert.notEqual(rehomed.targetSessionId, run, 'it moved off the dead run');
        const conversations = await sessionsFor(subject);
        assert.equal(conversations.filter((row) => row.about === subject).length, 1,
          'into exactly one fresh conversation');
        // ...and the failed run is exactly what it was.
        const after = await services.db.session.findUniqueOrThrow({ where: { id: run } });
        assert.equal(after.status, RunStatus.FAILED);
        assert.equal(after.error, 'seq 1 died');
      });

      await t.test('a 0.1.130 comment gets no ledger row and is left to the old path', async () => {
        // The rolling-deploy rule: an old binary omits `mention_delivery_version`, it defaults to
        // 0, and this sweep must not deliver a comment that binary already delivered inline.
        await emptyWorld(client);
        const target = await world(services.db, 'su8-legacy');
        const subject = await task(services.db, target, 'the work');
        await client.query(
          `INSERT INTO "task_comment" ("id","task_id","author_type","author_id","body","mentions")
           VALUES ($1::uuid,$2::uuid,'USER',$3::uuid,'@agent',ARRAY[$4::uuid])`,
          [randomUUID(), subject, target.ownerId, target.agentId],
        );

        assert.deepEqual(await deliveries(subject), [], 'no ledger row for a version-0 comment');
        await services.tasks.deliverMentions();
        assert.deepEqual(await sessionsFor(subject), [], 'and the new sweep delivers nothing');
      });

      await t.test('a worker that keeps dying reaches DEAD instead of looping for ever', async () => {
        await emptyWorld(client);
        const target = await world(services.db, 'su8-claim-loop');
        const subject = await task(services.db, target, 'the work');
        await comment(target, subject, [target.agentId]);
        // The shape a worker that died mid-flight leaves: DELIVERING with an expired lease. Held
        // just under the cap, so one more sweep must end it rather than lease it again.
        await services.db.$executeRawUnsafe(
          `UPDATE "task_comment_mention_delivery"
              SET "status" = 'DELIVERING', "claims" = 64,
                  "lease_holder" = 'dead-worker', "lease_expires_at" = now() - interval '1 minute',
                  "next_attempt_at" = now()
            WHERE "task_id" = $1::uuid`, subject,
        );

        await services.tasks.deliverMentions();

        const [row] = await deliveries(subject);
        assert.equal(row.status, 'DEAD', 'a crash loop is terminal and visible');
        assert.equal(row.errorCode, 'CLAIM_LOOP');
        assert.deepEqual(await sessionsFor(subject), [], 'and it started nothing');
      });
    } finally {
      await client.end();
      await services.dispose();
    }
  });
