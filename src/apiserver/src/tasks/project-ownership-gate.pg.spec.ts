/**
 * Unit L6 on real PostgreSQL: the incident, replayed.
 *
 * The incident data is one row and there is no way to write it through the product any more — L3
 * refuses it at creation and L4 makes the lawful version of it a question somebody answers. So the
 * fixture writes it the way history did: straight into the table, as a coordinator of project A
 * filing work into project B, with the scope column recording what the server derived at the time.
 * That is exactly the shape a pre-L3 binary left behind, and exactly the shape the backfill in 0156
 * reconstructs.
 *
 * What only real PostgreSQL can decide here:
 *
 *   - the immutability guard, which is a rule about writers the service never sees;
 *   - the partial unique index, which is what makes the repair idempotent under a race rather than
 *     under a convention;
 *   - `task_retirement_status_check` and the live-session guard accepting the abandon;
 *   - and the run paths refusing, through the real `execute` rather than through a fake whose
 *     writes a unit test would have swallowed.
 *
 * Give it its own database, as the L3 fence and L4 crossing specs do:
 *
 *   docker run -d --name pcc-l6-pg -e POSTGRES_USER=pccl6-u -e POSTGRES_PASSWORD=pccl6 \
 *     -e POSTGRES_DB=pccl6-db -p 127.0.0.1:55826:5432 --tmpfs /var/lib/postgresql/data postgres:16-alpine
 *   DATABASE_URL=postgresql://pccl6-u:pccl6@127.0.0.1:55826/pccl6-db npx prisma migrate deploy
 *   COORDINATOR_PG_URL=… COORDINATOR_PG_EXPECTED_DATABASE=pccl6-db COORDINATOR_PG_EXPECTED_USER=pccl6-u \
 *     COORDINATOR_PG_EXPECTED_SYSTEM_IDENTIFIER=… \
 *     node --test --test-concurrency=1 build/tasks/project-ownership-gate.pg.spec.js
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { ConflictException } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import { Client } from 'pg';

import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { ProjectOwnershipAuditService } from '../projects/project-ownership-audit.service';
import { ProjectOwnershipRefileService } from '../projects/project-ownership-refile.service';
import { TasksService } from './tasks.service';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

interface World {
  ownerId: string;
  /** The project whose coordinator did the filing — the one that actually owns the work. */
  projectA: string;
  /** The project the work landed in. */
  projectB: string;
  workspaceId: string;
  runnerId: string;
  /** A's coordinator session, and the one the mis-filed task names as its creator. */
  sessionA: string;
  /** The mis-filed row: filed under A's scope, sitting in B. */
  misfiled: string;
  /** A control row in B, filed by B's own scope. Every assertion below has to leave it alone. */
  healthy: string;
}

test('unit L6: a task filed by another project\'s coordinator, from the incident to the repair',
  { skip, concurrency: 1, timeout: 180_000 }, async (t) => {
    const url = URL!;
    assertCoordinatorPgUrlIsIsolated(url);
    const { prismaClientFor } = await import('../prisma/prisma-client.js');

    const admin = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
    await admin.connect();
    await verifyCoordinatorPgIdentity(admin);
    const prisma: PrismaClient = prismaClientFor(url);
    t.after(async () => {
      await prisma.$disconnect().catch(() => undefined);
      await admin.end().catch(() => undefined);
    });

    // A Session insert, and nothing else. `SessionsService` drags the queue, the realtime stream and
    // a runner nudge behind it, none of which this spec is about — but the assertions that MATTER
    // here are "no Session was written" and "a Session was written", so the stub has to leave a real
    // row rather than a promise. Everything the gate decides happens well before this is reached.
    const sessions = {
      create: async (
        ownerId: string,
        dto: { taskId: string; workspaceId: string; title: string },
        opts: { id: string },
      ) => {
        await admin.query(
          `INSERT INTO "session" ("id","owner_id","workspace_id","task_id","title","prompt",
             "creator_id","provider","status","dispatch_origin","starts_task_work","updated_at")
           VALUES ($1,$2,$3,$4,$5,'fixture',$2,'claude','PENDING'::"run_status",
             'USER'::"session_dispatch_origin",true,now())`,
          [opts.id, ownerId, dto.workspaceId, dto.taskId, dto.title],
        );
        return { id: opts.id };
      },
    };
    const tasks = new TasksService(
      prisma as never,
      sessions as never,
      { publishTaskChanged: () => undefined } as never,
    );
    const refiler = new ProjectOwnershipRefileService(prisma as never);
    const audit = new ProjectOwnershipAuditService(prisma as never);

    async function seed(label: string): Promise<World> {
      const w: World = {
        ownerId: randomUUID(),
        projectA: randomUUID(),
        projectB: randomUUID(),
        workspaceId: randomUUID(),
        runnerId: randomUUID(),
        sessionA: randomUUID(),
        misfiled: randomUUID(),
        healthy: randomUUID(),
      };
      await admin.query(
        `INSERT INTO "user" ("id","email","name","password_hash") VALUES ($1,$2,$3,'x')`,
        [w.ownerId, `${label}-${w.ownerId}@l6.invalid`, label],
      );
      await admin.query(
        `INSERT INTO "runner" ("id","owner_id","name","status","token_hash","capabilities_reported_at")
         VALUES ($1,$2,$3,'ONLINE',$4,now())`,
        [w.runnerId, w.ownerId, `${label}-runner`, `${label}-${w.runnerId}`],
      );
      await admin.query(
        `INSERT INTO "workspace" ("id","owner_id","name","runner_id","can_create_tasks","can_delegate")
         VALUES ($1,$2,$3,$4,true,true)`,
        [w.workspaceId, w.ownerId, `${label}-agent`, w.runnerId],
      );
      for (const id of [w.projectA, w.projectB]) {
        await admin.query(
          `INSERT INTO "project" ("id","owner_id","title","coordinator_enabled","automation_policy","updated_at")
           VALUES ($1,$2,$3,true,'GUARDED_AUTO'::"project_automation_policy",now())`,
          [id, w.ownerId, `${label}-${id.slice(0, 4)}`],
        );
        await admin.query(
          `INSERT INTO "project_runtime" ("project_id","updated_at") VALUES ($1,now())
             ON CONFLICT ("project_id") DO NOTHING`,
          [id],
        );
      }
      await admin.query(
        `INSERT INTO "session" ("id","owner_id","workspace_id","title","prompt","creator_id",
           "provider","status","dispatch_origin","updated_at")
         VALUES ($1,$2,$3,$4,'fixture',$2,'claude','RUNNING'::"run_status",
           'USER'::"session_dispatch_origin",now())`,
        [w.sessionA, w.ownerId, w.workspaceId, `${label}-coordinator-a`],
      );
      await admin.query(
        'UPDATE "project" SET "coordinator_session_id" = $2::uuid WHERE "id" = $1::uuid',
        [w.projectA, w.sessionA],
      );
      // THE INCIDENT. `project_id` is B and `creator_coordinator_project_id` is A: the row is
      // counting towards B's goal and was written by the coordinator of A. Nothing about it looks
      // unusual to anything that asks only "is this task in my project".
      await admin.query(
        `INSERT INTO "task" ("id","owner_id","title","status","project_id","assignee_id",
           "creator_type","creator_id","creator_session_id",
           "creator_coordinator_project_id","creator_coordinator_generation","updated_at")
         VALUES ($1,$2,$3,'OPEN'::"task_status",$4,$5,'AGENT'::"creator_type",$5,$6,$7,0,now())`,
        [w.misfiled, w.ownerId, `${label}-misfiled`, w.projectB, w.workspaceId, w.sessionA, w.projectA],
      );
      // The control: same project, same shape, filed by B's own scope.
      await admin.query(
        `INSERT INTO "task" ("id","owner_id","title","status","project_id","assignee_id",
           "creator_type","creator_id","creator_coordinator_project_id","creator_coordinator_generation","updated_at")
         VALUES ($1,$2,$3,'OPEN'::"task_status",$4,$5,'AGENT'::"creator_type",$5,$4,0,now())`,
        [w.healthy, w.ownerId, `${label}-healthy`, w.projectB, w.workspaceId],
      );
      // Neither task is under coordinator dispatch authority, so `execute` reaches the ownership
      // gate rather than standing down before it. The mis-filing is what is under test, not the
      // routing.
      await admin.query(
        `UPDATE "task" SET "dispatch_authority" = 'LEGACY'::"task_dispatch_authority" WHERE "id" = ANY($1::uuid[])`,
        [[w.misfiled, w.healthy]],
      );
      return w;
    }

    const taskRow = async (id: string) => (await admin.query<{
      status: string; terminal_reason: string | null; project_id: string;
      source_task_id: string | null; trigger_event: string | null;
      creator_coordinator_project_id: string | null;
    }>(
      `SELECT "status"::text, "terminal_reason", "project_id"::text AS project_id,
              "source_task_id"::text AS source_task_id, "trigger_event",
              "creator_coordinator_project_id"::text AS creator_coordinator_project_id
         FROM "task" WHERE "id" = $1::uuid`,
      [id],
    )).rows[0];

    const sessionsOf = async (taskId: string) => (await admin.query<{ id: string; status: string }>(
      `SELECT "id"::text, "status"::text FROM "session" WHERE "task_id" = $1::uuid ORDER BY "id"`,
      [taskId],
    )).rows;

    // FIRST, and it has to be: it takes the database back to its 0155 shape, seeds history into it
    // and re-applies 0156's own bytes. Everything after it runs against a schema this test put back.
    await t.test('AC1: the backfill reconstructs the history a rotation had already erased',
      async () => {
        const w = {
          ownerId: randomUUID(), projectA: randomUUID(), projectB: randomUUID(),
          workspaceId: randomUUID(), runnerId: randomUUID(),
        };
        // 0156's own bytes, not a paraphrase of them. Read before anything is dropped, so a missing
        // file fails the test rather than leaving the schema apart.
        const migration = readFileSync(
          path.resolve(__dirname, '../../prisma/migrations/0156_task_creator_scope_ownership_gate/migration.sql'),
          'utf8',
        );
        // Undo 0156, so the seeding below writes exactly the rows a pre-L6 deployment holds. In a
        // `finally`, because one red assertion here would otherwise take every later subtest in this
        // file with it — they would all be failing on a schema this one left half-applied.
        await admin.query('DROP TRIGGER IF EXISTS "task_creator_scope_immutable_guard" ON "task"');
        await admin.query(`ALTER TABLE "task"
          DROP COLUMN IF EXISTS "creator_coordinator_project_id",
          DROP COLUMN IF EXISTS "creator_coordinator_generation"`);
        try {

        await admin.query(
          `INSERT INTO "user" ("id","email","name","password_hash") VALUES ($1,$2,'backfill','x')`,
          [w.ownerId, `backfill-${w.ownerId}@l6.invalid`],
        );
        await admin.query(
          `INSERT INTO "runner" ("id","owner_id","name","status","token_hash","capabilities_reported_at")
           VALUES ($1,$2,'bf-runner','ONLINE',$3,now())`,
          [w.runnerId, w.ownerId, `bf-${w.runnerId}`],
        );
        await admin.query(
          `INSERT INTO "workspace" ("id","owner_id","name","runner_id") VALUES ($1,$2,'bf-agent',$3)`,
          [w.workspaceId, w.ownerId, w.runnerId],
        );
        for (const id of [w.projectA, w.projectB]) {
          await admin.query(
            `INSERT INTO "project" ("id","owner_id","title","coordinator_enabled","updated_at")
             VALUES ($1,$2,$3,true,now())`,
            [id, w.ownerId, `bf-${id.slice(0, 4)}`],
          );
          await admin.query(
            `INSERT INTO "project_runtime" ("project_id","updated_at") VALUES ($1,now())
               ON CONFLICT ("project_id") DO NOTHING`, [id],
          );
        }
        const session = async () => {
          const id = randomUUID();
          await admin.query(
            `INSERT INTO "session" ("id","owner_id","workspace_id","title","prompt","creator_id",
               "provider","status","dispatch_origin","updated_at")
             VALUES ($1,$2,$3,'bf','fixture',$2,'claude','SUCCEEDED'::"run_status",
               'USER'::"session_dispatch_origin",now())`,
            [id, w.ownerId, w.workspaceId],
          );
          return id;
        };
        const decisionBy = async (sessionId: string, projectId: string) => {
          await admin.query(
            `INSERT INTO "project_decision" ("id","project_id","input_version","decision_input_hash",
               "decision_input","outcome","decided_by","coordinator_session_id","fencing_token","reason")
             VALUES ($1,$2,1,$3,'{}'::jsonb,'{}'::jsonb,'COORDINATOR_AGENT',$4,1,'fixture')`,
            [randomUUID(), projectId, 'd'.repeat(64), sessionId],
          );
        };
        const taskBy = async (sessionId: string | null, projectId: string) => {
          const id = randomUUID();
          await admin.query(
            `INSERT INTO "task" ("id","owner_id","title","status","project_id","creator_type",
               "creator_id","creator_session_id","updated_at")
             VALUES ($1,$2,'bf-task','OPEN'::"task_status",$3,'AGENT'::"creator_type",$4,$5,now())`,
            [id, w.ownerId, projectId, w.workspaceId, sessionId],
          );
          return id;
        };

        // (a) The case the column exists for: the coordinator that filed the work has since been
        // rotated away, so `project.coordinator_session_id` no longer names it and the live
        // derivation is blind. `project_decision` is append-only and still says who it was.
        const rotatedAway = await session();
        const successor = await session();
        await decisionBy(rotatedAway, w.projectA);
        await admin.query(
          'UPDATE "project" SET "coordinator_session_id" = $2::uuid WHERE "id" = $1::uuid',
          [w.projectA, successor],
        );
        const filedByRotated = await taskBy(rotatedAway, w.projectB);

        // (b) The live binding, which needs no history at all.
        const liveCoordinator = await session();
        await admin.query(
          'UPDATE "project" SET "coordinator_session_id" = $2::uuid WHERE "id" = $1::uuid',
          [w.projectB, liveCoordinator],
        );
        const filedByLive = await taskBy(liveCoordinator, w.projectB);

        // (c) Ambiguous: one session, decisions for two projects. The row cannot say which scope
        // the write was under, so it says nothing rather than guessing.
        const ambiguous = await session();
        await decisionBy(ambiguous, w.projectA);
        await decisionBy(ambiguous, w.projectB);
        const filedByAmbiguous = await taskBy(ambiguous, w.projectB);

        // (d) A worker session executing a task in A. Deliberately NOT backfilled: a task's project
        // can move, so reading it back today would attribute the write to wherever the executing
        // task ended up rather than to where it was.
        const workerTask = await taskBy(null, w.projectA);
        const worker = await session();
        await admin.query('UPDATE "session" SET "task_id" = $2::uuid WHERE "id" = $1::uuid',
          [worker, workerTask]);
        const filedByWorker = await taskBy(worker, w.projectB);

        // (e) No creating session at all — a user filed it.
        const filedByUser = await taskBy(null, w.projectB);


        // 0156, applied to a database that has the history in it — which is the only way this
        // statement is ever exercised for real.
        await admin.query(migration);

        const scopeOf = async (taskId: string) => (await admin.query<{ p: string | null; g: string | null }>(
          `SELECT "creator_coordinator_project_id"::text AS p,
                  "creator_coordinator_generation"::text AS g
             FROM "task" WHERE "id" = $1::uuid`, [taskId],
        )).rows[0];

        assert.equal((await scopeOf(filedByRotated)).p, w.projectA,
          'the append-only decision ledger is what survives a rotation');
        assert.equal((await scopeOf(filedByLive)).p, w.projectB);
        assert.equal((await scopeOf(filedByAmbiguous)).p, null,
          'two projects for one session is not an attribution');
        assert.equal((await scopeOf(filedByWorker)).p, null,
          'a worker origin is left unrecorded: the task it was executing can have moved since');
        assert.equal((await scopeOf(filedByUser)).p, null);
        // NULL, not 0. A project that has never rotated genuinely IS at generation 0, and reading
        // an absent record as that would let a replay claim a fact it does not have.
        assert.equal((await scopeOf(filedByRotated)).g, null);

        // And the one row the backfill DID attribute is now refused by the gate, without anybody
        // having had to notice it.
        await assert.rejects(
          () => tasks.execute(w.ownerId, filedByRotated),
          /filed by the coordinator of project/,
        );
        } finally {
          // Idempotent, and only load-bearing when an assertion above threw before the apply: every
          // statement in 0156 is IF NOT EXISTS or a DROP/ADD pair, and its backfill writes only
          // rows whose column is still empty.
          await admin.query(migration);
        }
      });

    await t.test('AC1: every start path refuses the mis-filed task and runs the healthy one',
      async () => {
        const w = await seed('ac1');

        // The single-task door: `task_start`, Run Now, `orbit task start`, the dependency-unlock
        // trigger and all three sweeps arrive here.
        await assert.rejects(
          () => tasks.execute(w.ownerId, w.misfiled),
          (error: unknown) => {
            assert.ok(error instanceof ConflictException, `expected a 409, got ${error}`);
            const message = String((error as ConflictException).message);
            assert.match(message, /filed by the coordinator of project/);
            assert.match(message, /no approved handoff/);
            return true;
          },
        );
        assert.equal((await sessionsOf(w.misfiled)).length, 0, 'the refusal wrote no Session');

        // An AUTOMATIC delivery stands down instead of throwing, and leaves nothing behind.
        const auto = await tasks.execute(w.ownerId, w.misfiled, {
          observedEpoch: BigInt((await admin.query<{ e: string }>(
            `SELECT "epoch"::text AS e FROM "task_dispatch_epoch" WHERE "task_id" = $1::uuid`,
            [w.misfiled],
          )).rows[0].e),
        });
        assert.equal(auto.ok, false);
        assert.equal(auto.skipped, 'ownership-mismatch');
        assert.equal((await sessionsOf(w.misfiled)).length, 0);

        // The bulk door classifies rather than dispatches, and names both projects.
        const batch = await tasks.batchExecute(w.ownerId, [w.misfiled]);
        assert.equal(batch.dispatched, 0);
        assert.equal(batch.skipped.length, 1);
        assert.match(batch.skipped[0].reason, /refile it before running/);
        assert.equal((await sessionsOf(w.misfiled)).length, 0);

        // The control still runs. This is the assertion that decides whether the gate is a gate or
        // an outage: every task an agent ever filed carries the column the gate reads.
        const healthy = await tasks.execute(w.ownerId, w.healthy);
        assert.equal(healthy.ok, true, 'a task filed by its own project must still run');
        assert.equal((await sessionsOf(w.healthy)).length, 1);
      });

    await t.test('AC1: an APPLIED handoff is what makes the crossing lawful at run time', async () => {
      const w = await seed('handoff');
      await admin.query(
        `INSERT INTO "project_handoff_approval"
           ("id","owner_id","from_project_id","to_project_id","kind","subject_task_id",
            "payload_digest","crossing_key","state","title","requested_by_session_id","requested_at",
            "decided_by","decided_by_user_id","decided_at","expires_at",
            "applied_task_id","applied_at","updated_at")
         VALUES ($1,$2,$3,$4,'FILE_TASK',NULL,$5,$6,'APPLIED','the crossing',$7,now(),
           'USER',$2,now(),now() + interval '7 days',$8,now(),now())`,
        [
          randomUUID(), w.ownerId, w.projectA, w.projectB,
          'a'.repeat(64), `k${'0'.repeat(63)}`, w.sessionA, w.misfiled,
        ],
      );
      const answer = await tasks.execute(w.ownerId, w.misfiled);
      assert.equal(answer.ok, true, 'a crossing a person answered is not a mis-filing');
      assert.equal((await sessionsOf(w.misfiled)).length, 1);
    });

    await t.test('AC3: the repair files a replacement in A, abandons the original, touches no Session',
      async () => {
        const w = await seed('repair');
        const outcome = await refiler.refile(w.ownerId, w.misfiled);
        assert.equal(outcome.created, true);

        const original = await taskRow(w.misfiled);
        assert.equal(original.status, 'CANCELLED');
        assert.equal(original.terminal_reason, 'ABANDONED');
        assert.equal(original.project_id, w.projectB, 'the original is not moved, it is abandoned');

        const replacementId = (await admin.query<{ id: string }>(
          `SELECT "id"::text FROM "task" WHERE "source_task_id" = $1::uuid`, [w.misfiled],
        )).rows[0].id;
        const replacement = await taskRow(replacementId);
        assert.equal(replacement.project_id, w.projectA, 'the replacement lands in the filing scope');
        assert.equal(replacement.trigger_event, 'project.ownership_refiled');
        assert.equal(replacement.source_task_id, w.misfiled, 'the mapping is on the new row');
        assert.equal(
          replacement.creator_coordinator_project_id, null,
          'a user-authored replacement records no scope — the gate must not refuse it',
        );

        // The repaired task now runs from its new home, and the abandoned one still does not.
        const ran = await tasks.execute(w.ownerId, replacementId);
        assert.equal(ran.ok, true);
        await assert.rejects(() => tasks.execute(w.ownerId, w.misfiled));
        assert.equal((await sessionsOf(w.misfiled)).length, 0, 'the repair wrote no Session at all');
      });

    await t.test('AC4: refiling twice produces one replacement, not two', async () => {
      const w = await seed('idempotent');
      const first = await refiler.refile(w.ownerId, w.misfiled);
      const second = await refiler.refile(w.ownerId, w.misfiled);
      assert.equal(first.created, true);
      assert.equal(second.created, false);
      assert.equal(second.replacementTaskId, first.replacementTaskId);
      const count = (await admin.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM "task" WHERE "source_task_id" = $1::uuid`, [w.misfiled],
      )).rows[0].n;
      assert.equal(count, '1');

      // And the database says so on its own, for a writer the service never sees.
      await assert.rejects(
        () => admin.query(
          `INSERT INTO "task" ("id","owner_id","title","status","project_id","creator_type",
             "creator_id","source_task_id","trigger_event","updated_at")
           VALUES ($1,$2,'a second replacement','OPEN'::"task_status",$3,'USER'::"creator_type",
             $2,$4,'project.ownership_refiled',now())`,
          [randomUUID(), w.ownerId, w.projectA, w.misfiled],
        ),
        /task_ownership_refile_source_uq|duplicate key/,
      );
    });

    await t.test('AC3: a live run freezes the repair rather than cancelling somebody\'s session',
      async () => {
        const w = await seed('frozen');
        const sessionId = randomUUID();
        await admin.query(
          `INSERT INTO "session" ("id","owner_id","workspace_id","task_id","title","prompt",
             "creator_id","provider","status","dispatch_origin","starts_task_work","updated_at")
           VALUES ($1,$2,$3,$4,'live','fixture',$2,'claude','RUNNING'::"run_status",
             'USER'::"session_dispatch_origin",true,now())`,
          [sessionId, w.ownerId, w.workspaceId, w.misfiled],
        );
        await assert.rejects(
          () => refiler.refile(w.ownerId, w.misfiled),
          (error: unknown) => {
            assert.ok(error instanceof ConflictException);
            assert.match(String((error as ConflictException).message), /Wait for the run to reach a terminal status/);
            return true;
          },
        );
        const [session] = await sessionsOf(w.misfiled);
        assert.equal(session.status, 'RUNNING', 'the live run was not cancelled or completed');
        assert.equal((await taskRow(w.misfiled)).status, 'OPEN', 'nothing was abandoned');
        assert.equal(
          (await admin.query(`SELECT 1 FROM "task" WHERE "source_task_id" = $1::uuid`, [w.misfiled]))
            .rowCount, 0, 'and no replacement was filed');
      });

    await t.test('AC3: a task that already ran keeps its real result', async () => {
      const w = await seed('ran');
      await admin.query(
        `INSERT INTO "session" ("id","owner_id","workspace_id","task_id","title","prompt",
           "creator_id","provider","status","dispatch_origin","starts_task_work","updated_at")
         VALUES ($1,$2,$3,$4,'done','fixture',$2,'claude','SUCCEEDED'::"run_status",
           'USER'::"session_dispatch_origin",true,now())`,
        [randomUUID(), w.ownerId, w.workspaceId, w.misfiled],
      );
      await assert.rejects(
        () => refiler.refile(w.ownerId, w.misfiled),
        /does not rewrite real run results/,
      );
      const [session] = await sessionsOf(w.misfiled);
      assert.equal(session.status, 'SUCCEEDED');
      assert.equal((await taskRow(w.misfiled)).status, 'OPEN');
    });

    await t.test('the scope column is written once and frozen against every later writer', async () => {
      const w = await seed('frozen-column');
      const rewrites: Array<{ sql: string; params: string[] }> = [
        {
          sql: `UPDATE "task" SET "creator_coordinator_project_id" = $2::uuid WHERE "id" = $1::uuid`,
          params: [w.misfiled, w.projectB],
        },
        {
          sql: `UPDATE "task" SET "creator_coordinator_project_id" = NULL WHERE "id" = $1::uuid`,
          params: [w.misfiled],
        },
        {
          sql: `UPDATE "task" SET "creator_coordinator_generation" = 9 WHERE "id" = $1::uuid`,
          params: [w.misfiled],
        },
        // The retrofit, from the other direction: a row that recorded nothing cannot be given a
        // claim after the fact either.
        {
          sql: `UPDATE "task" SET "creator_coordinator_project_id" = $2::uuid WHERE "id" = $1::uuid`,
          params: [w.healthy, w.projectA],
        },
      ];
      for (const { sql, params } of rewrites) {
        await assert.rejects(
          () => admin.query(sql, params),
          /TASK_CREATOR_SCOPE_IMMUTABLE/,
          `this write must be refused: ${sql}`,
        );
      }
      assert.equal((await taskRow(w.misfiled)).creator_coordinator_project_id, w.projectA);
    });

    await t.test('a move retires the claim, so the manual fix the blocker recommends actually works',
      async () => {
        const w = await seed('moved');
        // The required action on the blocker says, in as many words: refile it, OR move it there
        // yourself if that is where it belongs. Before the retirement trigger the second half was a
        // lie -- the row kept claiming A, the gate kept comparing against it, and a task the owner
        // had deliberately placed could never run again.
        await admin.query(
          `UPDATE "task" SET "project_id" = $2::uuid WHERE "id" = $1::uuid`,
          [w.misfiled, w.projectA],
        );
        assert.equal((await taskRow(w.misfiled)).creator_coordinator_project_id, null,
          'the claim is retired by the move, not carried along and not re-pointed');
        const ran = await tasks.execute(w.ownerId, w.misfiled);
        assert.equal(ran.ok, true);

        // And it retires whichever project the task is moved to -- the trigger is about the
        // placement changing, not about it changing to somewhere in particular.
        const second = await seed('moved-elsewhere');
        const projectC = randomUUID();
        await admin.query(
          `INSERT INTO "project" ("id","owner_id","title","coordinator_enabled","updated_at")
           VALUES ($1,$2,'moved-c',true,now())`, [projectC, second.ownerId],
        );
        await admin.query(`UPDATE "task" SET "project_id" = $2::uuid WHERE "id" = $1::uuid`,
          [second.misfiled, projectC]);
        assert.equal((await taskRow(second.misfiled)).creator_coordinator_project_id, null);
        assert.equal((await tasks.execute(second.ownerId, second.misfiled)).ok, true);
      });

    await t.test('a move cannot be used to re-point the claim at where the task landed', async () => {
      const w = await seed('launder');
      const projectC = randomUUID();
      await admin.query(
        `INSERT INTO "project" ("id","owner_id","title","coordinator_enabled","updated_at")
         VALUES ($1,$2,'launder-c',true,now())`, [projectC, w.ownerId],
      );
      // The distinction the whole design turns on. "This placement is no longer the one I
      // described" is a retirement and the trigger writes it; "this placement was always fine,
      // look" is a rewrite of evidence and the guard refuses it -- even in the same statement as a
      // real move, and even for a writer the service never sees.
      await assert.rejects(
        () => admin.query(
          `UPDATE "task" SET "project_id" = $2::uuid, "creator_coordinator_project_id" = $2::uuid
             WHERE "id" = $1::uuid`,
          [w.misfiled, projectC],
        ),
        /TASK_CREATOR_SCOPE_IMMUTABLE/,
      );
      const after = await taskRow(w.misfiled);
      assert.equal(after.creator_coordinator_project_id, w.projectA);
      assert.equal(after.project_id, w.projectB, 'and the move did not happen either');
      await assert.rejects(() => tasks.execute(w.ownerId, w.misfiled));
    });

    await t.test('AC4: the recovery scan finds the offender, arms one wake, and repeats as a no-op',
      async () => {
        const w = await seed('scan');
        await admin.query(
          `UPDATE "project_runtime" SET "next_wake_at" = NULL WHERE "project_id" = ANY($1::uuid[])`,
          [[w.projectA, w.projectB]],
        );
        const wakeOf = async () => (await admin.query<{ next: string | null; updated: string }>(
          `SELECT "next_wake_at"::text AS next, "updated_at"::text AS updated
             FROM "project_runtime" WHERE "project_id" = $1::uuid`, [w.projectB],
        )).rows[0];

        const first = await audit.scan(new Date());
        assert.ok(first.misfiled.length >= 1, 'the scan saw the offender');
        assert.ok(first.rearmed.length >= 1, 'and armed the project holding it');
        const armed = await wakeOf();
        assert.notEqual(armed.next, null);

        // The second run performs NO WRITE — not a write that computes the same value. `updated_at`
        // is a real column real readers order by, so "wrote the same thing again" is still an effect.
        const second = await audit.scan(new Date());
        assert.equal(second.rearmed.length, 0);
        assert.deepEqual(await wakeOf(), armed);

        // And it never files anything: the replacement is a person's decision, so no number of
        // scans can produce one.
        assert.equal(
          (await admin.query(`SELECT 1 FROM "task" WHERE "source_task_id" = $1::uuid`, [w.misfiled]))
            .rowCount, 0);
      });
  });
