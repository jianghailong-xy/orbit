/**
 * 0292 on real PostgreSQL: the column went, and the two rules it carried answer exactly as they
 * did the moment before it went.
 *
 * WHY THIS IS A PG SPEC AND NOT A UNIT TEST
 * =========================================
 * Two of the four claims here are about the DATABASE's own state and the DATABASE's own refusal,
 * and neither is visible from TypeScript:
 *
 *   - "no catalog object still reads the column" is a claim about `pg_proc`, `pg_constraint`,
 *     `pg_indexes`, `pg_views` and `pg_trigger` at once. A migration that rewrote one function and
 *     forgot another leaves a plpgsql body naming a column that no longer exists — and plpgsql is
 *     parsed at RUN time, so nothing fails when the migration runs. It fails on the first user
 *     request that reaches the forgotten body. The only place that is visible before a user finds
 *     it is the catalog, and the only way to read the catalog is against a migrated database.
 *   - the scope-revision authority rule is enforced by a BEFORE INSERT trigger, deliberately,
 *     "because a writer that skipped this function is exactly the writer the incident had"
 *     (`convergence-ledger.ts`). A unit test that calls the service can only ever observe the
 *     service. psql, a repair script and a mixed-version binary all reach the table without it.
 *
 * Give it its own database, as the L3 fence spec does:
 *
 *   docker run -d --name afp-pg -e POSTGRES_USER=pccl3-u -e POSTGRES_PASSWORD=pccl3 \
 *     -e POSTGRES_DB=afp-db -p 127.0.0.1:55826:5432 --tmpfs /var/lib/postgresql/data postgres:16-alpine
 *   DATABASE_URL=postgresql://pccl3-u:pccl3@127.0.0.1:55826/afp-db npx prisma migrate deploy
 *   COORDINATOR_PG_URL=… COORDINATOR_PG_EXPECTED_DATABASE=afp-db COORDINATOR_PG_EXPECTED_USER=pccl3-u \
 *     node --test --concurrency=1 build/projects/automation-policy-removal.pg.spec.js
 *
 * or, from the repository root, which creates and destroys the database itself and treats a skip
 * as red:
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/projects/automation-policy-removal.pg.spec.ts
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { CreatorType, type PrismaClient } from '@prisma/client';
import { Client } from 'pg';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from './coordinator-pg-test-safety';
import { ProjectHandoffService } from './project-handoff.service';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

/**
 * The five queries the removal is judged by, spelled once.
 *
 * Each returns the offending OBJECT rather than a count, because a count of a leftover is not
 * something a reader can act on and `0` reads the same whether nothing is left or the query was
 * wrong. The raw output of these is printed below rather than folded into an assertion, so a
 * failure shows what is still there and a pass shows that the question was actually asked.
 */
const REMOVAL_QUERIES: ReadonlyArray<{ label: string; sql: string }> = [
  {
    label: 'pg_proc.prosrc',
    sql: `SELECT p.oid::regprocedure::text AS object
            FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = 'public' AND p.prosrc LIKE '%automation_policy%'
           ORDER BY 1`,
  },
  {
    label: 'pg_get_constraintdef',
    sql: `SELECT conrelid::regclass::text || '.' || conname AS object
            FROM pg_constraint
           WHERE pg_get_constraintdef(oid) LIKE '%automation_policy%'
           ORDER BY 1`,
  },
  {
    label: 'pg_indexes.indexdef',
    sql: `SELECT indexname AS object
            FROM pg_indexes
           WHERE schemaname = 'public' AND indexdef LIKE '%automation_policy%'
           ORDER BY 1`,
  },
  {
    label: 'pg_views.definition',
    sql: `SELECT schemaname || '.' || viewname AS object
            FROM pg_views WHERE definition LIKE '%automation_policy%'
           ORDER BY 1`,
  },
  {
    label: 'pg_get_triggerdef',
    sql: `SELECT c.relname || '.' || t.tgname AS object
            FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
           WHERE NOT t.tgisinternal AND pg_get_triggerdef(t.oid) LIKE '%automation_policy%'
           ORDER BY 1`,
  },
];

interface World {
  ownerId: string;
  projectA: string;
  projectB: string;
  workspaceId: string;
  sessionA: string;
  taskInA: string;
}

test('0292: the last readers of automation_policy are gone and both rules answer unchanged',
  { skip, concurrency: 1, timeout: 300_000 }, async (t) => {
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

    const handoffs = new ProjectHandoffService(prisma as never);

    async function seed(label: string): Promise<World> {
      const w: World = {
        ownerId: randomUUID(),
        projectA: randomUUID(),
        projectB: randomUUID(),
        workspaceId: randomUUID(),
        sessionA: randomUUID(),
        taskInA: randomUUID(),
      };
      const runnerId = randomUUID();
      await admin.query(
        `INSERT INTO "user" ("id","email","name","password_hash") VALUES ($1,$2,$3,'x')`,
        [w.ownerId, `${label}-${w.ownerId}@afp.invalid`, label],
      );
      await admin.query(
        `INSERT INTO "runner" ("id","owner_id","name","status","token_hash","capabilities_reported_at")
         VALUES ($1,$2,$3,'ONLINE',$4,now())`,
        [runnerId, w.ownerId, `${label}-runner`, `${label}-${runnerId}`],
      );
      await admin.query(
        `INSERT INTO "workspace" ("id","owner_id","name","runner_id","can_create_tasks","can_delegate")
         VALUES ($1,$2,$3,$4,true,true)`,
        [w.workspaceId, w.ownerId, `${label}-agent`, runnerId],
      );
      // Both ends OPEN, which is the pair ③ is about. `automation_policy` is not in this INSERT
      // because the column is not in this database — that a project can be created at all without
      // naming it is the first thing this spec depends on.
      for (const [id, suffix] of [[w.projectA, 'a'], [w.projectB, 'b']] as const) {
        await admin.query(
          `INSERT INTO "project" ("id","owner_id","title","coordinator_enabled","updated_at")
           VALUES ($1,$2,$3,true,now())`,
          [id, w.ownerId, `${label}-${suffix}`],
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
        [w.sessionA, w.ownerId, w.workspaceId, `${label}-session`],
      );
      await admin.query(
        `INSERT INTO "task" ("id","owner_id","title","status","project_id","creator_type",
           "creator_id","updated_at","completion_criterion")
         VALUES ($1,$2,$3,'OPEN'::"task_status",$4,'USER'::"creator_type",$2,now(),'EVIDENCE_JUDGMENT')`,
        [w.taskInA, w.ownerId, `${label}-task`, w.projectA],
      );
      await admin.query(
        'UPDATE "project" SET "coordinator_session_id" = $2::uuid WHERE "id" = $1::uuid',
        [w.projectA, w.sessionA],
      );
      return w;
    }

    /**
     * One revision row, written as the DATABASE sees it rather than through the service.
     *
     * `revision` is the argument that makes this a scope REVISION rather than the baseline: 1 is
     * the unpivoted original and the guard returns before it reads any actor, so the case under
     * test has to start at 2.
     */
    const insertRevision = (taskId: string, ownerId: string, actor: string) =>
      admin.query(
        `INSERT INTO "task_scope_revision" ("id","task_id","owner_id","revision","scope_hash",
           "title","reason","authorized_by_actor","authorized_by_principal","supersedes_revision")
         VALUES (gen_random_uuid(),$1::uuid,$2::uuid,2,repeat('b',64),'v2','a second statement',
           $3,'somebody@afp.invalid',1)`,
        [taskId, ownerId, actor],
      );

    /** The SQLSTATE a statement ended with, or null when it was not refused at all. */
    async function sqlStateOf(run: () => Promise<unknown>): Promise<string | null> {
      try {
        await run();
        return null;
      } catch (error) {
        return (error as { code?: string }).code ?? 'NO_SQLSTATE';
      }
    }

    /** A task with its revision-1 baseline, so the next revision is a revision and not the task's
     * original statement of scope — the guard returns immediately at revision 1 and never reads an
     * actor, so anything asserted about authority has to start above it. */
    async function seedWithBaseline(label: string): Promise<World> {
      const w = await seed(label);
      await admin.query(
        `INSERT INTO "task_scope_revision" ("id","task_id","owner_id","revision","scope_hash",
           "title","reason")
         VALUES (gen_random_uuid(),$1::uuid,$2::uuid,1,repeat('a',64),'v1','baseline')`,
        [w.taskInA, w.ownerId],
      );
      return w;
    }

    // ── ① ──────────────────────────────────────────────────────────────────────────────────────
    await t.test('a USER revision is written', async () => {
      // A person revising their own task's scope is what the table is for, and it is the one actor
      // the guard still lets past — so if 0292 had taken the whole trigger out with the column,
      // this is the case that would notice.
      const w = await seedWithBaseline('scope-authority-user');
      await insertRevision(w.taskInA, w.ownerId, 'USER');

      const written = await admin.query<{ actor: string; revision: number }>(
        `SELECT "authorized_by_actor" AS actor, "revision" FROM "task_scope_revision"
          WHERE "task_id" = $1::uuid AND "revision" = 2`,
        [w.taskInA],
      );
      assert.equal(written.rows.length, 1, 'a USER revision did not land');
      assert.equal(written.rows[0].actor, 'USER');
    });

    // ── ② ──────────────────────────────────────────────────────────────────────────────────────
    await t.test('a COORDINATOR revision is refused by the database with 23514', async () => {
      // This is the arm 0292 deleted: a coordinator revising scope on its own, which used to be
      // allowed exactly when the project's `automation_policy` was AUTO. The column it read is
      // gone. The refusal has to come from the DATABASE — psql, a repair script and a
      // mixed-version binary all reach this table without the service — so this is a bare INSERT
      // and the SQLSTATE is read off the error rather than off a service's return value.
      const w = await seedWithBaseline('scope-authority-coordinator');
      const state = await sqlStateOf(() => insertRevision(w.taskInA, w.ownerId, 'COORDINATOR'));
      assert.equal(state, '23514',
        `a COORDINATOR scope revision was not refused with 23514 (got ${state})`);

      // The other two actors were never allowed to revise scope and still are not. The deleted arm
      // named exactly one actor, so a rewrite that let one row too many through shows up here.
      const refused = [w.taskInA];
      for (const actor of ['WORKER', 'VERIFIER']) {
        const other = await seedWithBaseline(`scope-authority-${actor}`);
        assert.equal(await sqlStateOf(() => insertRevision(other.taskInA, other.ownerId, actor)),
          '23514', `a ${actor} scope revision was not refused with 23514`);
        refused.push(other.taskInA);
      }

      // And a refusal left nothing behind: a trigger that raised AFTER inserting would be a
      // different bug wearing the same SQLSTATE. Counted per task, because the USER case above
      // leaves a revision 2 of its own in this same database.
      const leftovers = await admin.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM "task_scope_revision"
          WHERE "task_id" = ANY($1::uuid[]) AND "revision" = 2`,
        [[w.taskInA, ...refused]]);
      assert.equal(leftovers.rows[0].n, '0', 'a refused revision left a row behind');
    });

    // ── ③ ──────────────────────────────────────────────────────────────────────────────────────
    await t.test('a crossing between two OPEN projects still waits for a person', async () => {
      const w = await seed('crossing');
      const { rows: generation } = await admin.query<{ g: string }>(
        `SELECT "coordinator_generation"::text AS g FROM "project_runtime" WHERE "project_id" = $1::uuid`,
        [w.projectA],
      );

      // What used to be the automatic yes — both ends on AUTO — is not reachable, because there is
      // no such column to set. What is left is the pair that always did wait, and the property is
      // that the wait is a PERSON's: the declaration lands PENDING with nobody's answer on it.
      const declared = await handoffs.declare(w.ownerId, {
        fromProjectId: w.projectA,
        toProjectId: w.projectB,
        kind: 'FILE_TASK',
        subjectTaskId: null,
        identity: {
          plan: {
            title: 'the crossing', description: null, acceptanceCriteria: null, labels: [],
            assigneeId: null, listId: null, provider: null, model: null, autoRunWhenReady: null,
            runAt: null, dueDate: null, completionPolicy: null, parentTaskId: null,
            parentRefDigest: null, verifiesTaskId: null, verifiesRefDigest: null,
            supersedesTaskId: null, dependsOnTaskIds: [], dependsOnRefDigests: [],
          },
          source: {
            projectId: w.projectA, taskId: null, sessionId: w.sessionA,
            triggerEvent: 'coordinator.session_filed',
          },
        },
        title: 'the crossing',
        reason: 'a crossing that needs a person',
        requestedBySessionId: w.sessionA,
      }, { projectId: w.projectA, generation: generation[0].g }, new Date());

      assert.equal(declared.row.state, 'PENDING', 'the crossing accepted itself');
      assert.equal(declared.row.decidedBy, null, 'something answered without a person');

      // And the answer it waits for is a person's, recorded as such on the row.
      const { rows: questions } = await admin.query<{ id: string }>(
        `SELECT "id" FROM "project_handoff_approval" WHERE "owner_id" = $1::uuid`,
        [w.ownerId],
      );
      await handoffs.decide(w.ownerId, w.ownerId, questions[0].id, 'APPROVE', new Date());
      const { rows: settled } = await admin.query<{ state: string; decided_by: string }>(
        `SELECT "state","decided_by" FROM "project_handoff_approval" WHERE "owner_id" = $1::uuid`,
        [w.ownerId],
      );
      assert.equal(settled[0].state, 'APPROVED');
      assert.equal(settled[0].decided_by, 'USER', 'the only decider a new yes can have');
    });

    // ── ④ ──────────────────────────────────────────────────────────────────────────────────────
    await t.test('no catalog object still reads the column', async () => {
      // The raw output of all five, printed rather than counted: a reader of a failing run needs to
      // see WHICH object is left, and a reader of a passing one needs to see that the question was
      // asked of the catalog and not of a list somebody wrote down.
      const findings: string[] = [];
      for (const query of REMOVAL_QUERIES) {
        const { rows } = await admin.query<{ object: string }>(query.sql);
        console.log(`=== ${query.label} LIKE '%automation_policy%' ===`);
        console.log(rows.length === 0
          ? '(0 rows)'
          : rows.map((row) => `  ${row.object}`).join('\n'));
        for (const row of rows) findings.push(`${query.label}: ${row.object}`);
      }
      assert.deepEqual(findings, [],
        `catalog objects still name the column:\n  ${findings.join('\n  ')}`);

      // The five queries above cannot see a column nobody reads — a column with no reader is
      // exactly what they are silent about. So the column and the type are asked for directly.
      const { rows: columns } = await admin.query<{ object: string }>(
        `SELECT table_name || '.' || column_name AS object
           FROM information_schema.columns
          WHERE table_schema = 'public' AND column_name LIKE '%automation_policy%'
          ORDER BY 1`);
      console.log('=== information_schema.columns LIKE \'%automation_policy%\' ===');
      console.log(columns.length === 0 ? '(0 rows)' : columns.map((c) => `  ${c.object}`).join('\n'));
      assert.deepEqual(columns, [], 'a column named automation_policy survives');

      const { rows: types } = await admin.query<{ object: string }>(
        `SELECT t.typname AS object
           FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
          WHERE n.nspname = 'public' AND t.typname LIKE '%automation_policy%'
          ORDER BY 1`);
      console.log('=== pg_type.typname LIKE \'%automation_policy%\' ===');
      console.log(types.length === 0 ? '(0 rows)' : types.map((x) => `  ${x.object}`).join('\n'));
      assert.deepEqual(types, [], 'the enum type survives');

      // The trigger is the one object the removal REBUILDS rather than drops, so its absence from
      // the five queries is not enough — it has to still be there, still catching the fields it
      // caught before, or a project edit would silently stop refreshing its contract.
      const { rows: triggers } = await admin.query<{ def: string }>(
        `SELECT pg_get_triggerdef(t.oid) AS def
           FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
          WHERE c.relname = 'project' AND t.tgname = 'zz_project_completion_contract_project'`);
      assert.equal(triggers.length, 1, 'the completion-contract trigger was not rebuilt');
      for (const column of ['coordinator_enabled', 'max_concurrent_tasks', 'config_revision',
        'unbounded_authorized_by', 'goal', 'instructions']) {
        assert.match(triggers[0].def, new RegExp(`\\b${column}\\b`),
          `the rebuilt trigger no longer watches ${column}`);
      }
    });
  });
