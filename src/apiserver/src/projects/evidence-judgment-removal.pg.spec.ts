/**
 * N26 against real PostgreSQL: the human step is gone from both levels, and nothing else moved.
 *
 * Its sibling `evidence-judgment-removal.spec.ts` carries the halves that are decided by reading
 * the tree. These are the ones that need rows.
 *
 * Two gates existed and both are removed here: a task's `HUMAN_SIGNOFF` criterion, whose satisfying
 * fact only the account owner could write, and a project criterion's PASS conclusion, which
 * `CONCLUDE_VERDICT_PASS: HUMAN_ONLY` refused to a judgment session. What is deliberately NOT
 * removed is everything that made either one evidence: the request's foreign key to one immutable
 * completion-evidence version, the acceptance run's frozen criteria snapshot, the append-only
 * conclusion event, and the write protection on the acceptance criteria themselves.
 *
 * Destructive: it truncates. COORDINATOR_PG_URL must name the disposable database accepted by the
 * coordinator PG safety guard, with migration 0224 applied.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { Client } from 'pg';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from './coordinator-pg-test-safety';
import { prismaClientFor } from '../prisma/prisma-client';
import {
  COORDINATOR_AUTHORITY,
  AUTHORITY_REFUSAL_CODES,
  refuseHumanOnlyAction,
} from './coordinator-authority';

const URL = process.env.COORDINATOR_PG_URL;
const suite = URL ? test : test.skip;

/** build/projects -> build -> apiserver -> src -> repository root. */
function repoRoot(): string {
  return path.resolve(__dirname, '../../../..');
}

function read(relative: string): string {
  return readFileSync(path.join(repoRoot(), relative), 'utf8');
}

const REMOVAL_MIGRATION =
  'src/apiserver/prisma/migrations/0224_evidence_judgment_removal_of_human_signoff/migration.sql';

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

suite('(a) the database refuses a HUMAN_SIGNOFF declaration outright', { timeout: 120_000 },
  async () => {
    assertCoordinatorPgUrlIsIsolated(URL);
    const sql = new Client({ connectionString: URL });
    await sql.connect();
    try {
      await verifyCoordinatorPgIdentity(sql);
      const labels = (await sql.query(
        `SELECT e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
          WHERE t.typname = 'task_completion_criterion' ORDER BY e.enumsortorder`,
      )).rows.map((row) => row.enumlabel);
      assert.deepEqual(labels, ['EXECUTABLE', 'VERIFICATION', 'EVIDENCE_JUDGMENT']);
      await assert.rejects(
        sql.query(`SELECT 'HUMAN_SIGNOFF'::"task_completion_criterion"`),
        (error: unknown) => {
          assert.match(String((error as Error).message), /invalid input value for enum/);
          return true;
        },
      );
    } finally {
      await sql.end();
    }
  });

suite('(c) the table, its trigger and every reader of it are gone from the database',
  { timeout: 120_000 }, async () => {
    assertCoordinatorPgUrlIsIsolated(URL);
    const sql = new Client({ connectionString: URL });
    await sql.connect();
    try {
      await verifyCoordinatorPgIdentity(sql);
      assert.equal((await sql.query(
        `SELECT count(*)::int AS n FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name = 'task_human_signoff'`,
      )).rows[0].n, 0);
      assert.deepEqual((await sql.query(
        `SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'public' AND p.prosrc LIKE '%task_human_signoff%' ORDER BY 1`,
      )).rows.map((row) => row.proname), [],
      'no installed function may still read the dropped table');
      assert.deepEqual((await sql.query(
        `SELECT table_name FROM information_schema.views
          WHERE table_schema = 'public' AND view_definition LIKE '%human_signoff%'`,
      )).rows, []);
      assert.deepEqual((await sql.query(
        `SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'public' AND p.prosrc LIKE '%HUMAN_SIGNOFF%' ORDER BY 1`,
      )).rows.map((row) => row.proname), [],
      'no installed function may still hold the removed enum label as text');
    } finally {
      await sql.end();
    }
  });

// ── the database-backed body: everything that needed rows ──────────────────────────────────────

suite('the removal keeps every stated criterion decidable and every recorded fact intact',
  { timeout: 300_000 }, async (t) => {
    assertCoordinatorPgUrlIsIsolated(URL);
    const sql = new Client({ connectionString: URL });
    await sql.connect();
    const db = prismaClientFor(URL!);
    t.after(async () => {
      await db.$disconnect();
      await sql.end();
    });
    await verifyCoordinatorPgIdentity(sql);
    await sql.query(
      'TRUNCATE "task", "project_runtime", "project", "user" RESTART IDENTITY CASCADE',
    );

    const ownerId = randomUUID();
    await sql.query(
      `INSERT INTO "user" ("id","email","name","password_hash")
       VALUES ($1,$2,'N26 owner','x')`,
      [ownerId, `${ownerId}@n26.invalid`],
    );

    /** One project with one stated criterion, in the shape the 278 production rows have. */
    const createProject = async (label: string) => {
      const projectId = randomUUID();
      const definitionId = randomUUID();
      const criterionText = `${label}: the stated outcome is demonstrably reached`;
      const verificationMethod = `read the ${label} evidence against the assertion`;
      await sql.query(
        `INSERT INTO "project" (
           "id","owner_id","title","goal","coordinator_enabled","automation_policy",
           "max_concurrent_tasks","session_budget_per_day","updated_at"
         ) VALUES ($1,$2,$3,$4,true,'GUARDED_AUTO'::"project_automation_policy",3,10,now())`,
        [projectId, ownerId, `${label} project`, `${label} goal`],
      );
      await sql.query(
        `INSERT INTO "project_acceptance_criterion_definition" (
           "id","project_id","ordinal","text","verification_method","content_hash"
         ) VALUES ($1,$2,1,$3,$4,$5)`,
        [definitionId, projectId, criterionText, verificationMethod,
          digest(`n26:${definitionId}`)],
      );
      await sql.query('SELECT project_refresh_completion_contract($1::uuid,$2)',
        [projectId, 'N26_FIXTURE']);
      return { projectId, definitionId, criterionText, verificationMethod };
    };

    // ── (e)(f)(g)(h)(p): what a value rename does to rows ─────────────────────────────────────
    //
    // The migration keeps 1,123 tasks and 306 criterion definitions by renaming the enum LABEL
    // rather than remapping the rows, so what has to be proved is exactly that: a rename changes
    // no tuple. `xmin` is the system column that answers it — an UPDATE would advance it — and a
    // rename that advanced it would have rewritten history rather than relabelled it.
    const statuses = ['OPEN', 'DONE', 'CANCELLED', 'FAILED', 'IN_PROGRESS'] as const;
    const seeded = await createProject('rename');
    const seededTasks: Array<{ id: string; status: string }> = [];
    for (const status of statuses) {
      for (let index = 0; index < 3; index += 1) {
        const id = randomUUID();
        await sql.query(
          `INSERT INTO "task" (
             "id","owner_id","project_id","title","creator_type","creator_id","status",
             "completion_criterion","updated_at"
           ) VALUES ($1,$2,$3,$4,'USER',$2,$5::"task_status",
                     'EVIDENCE_JUDGMENT'::"task_completion_criterion",now())`,
          [id, ownerId, seeded.projectId, `${status} ${index}`, status],
        );
        seededTasks.push({ id, status });
      }
    }
    const otherProjects = [
      await createProject('sibling-a'),
      await createProject('sibling-b'),
      await createProject('sibling-c'),
    ];

    const taskSnapshot = async () => (await sql.query(
      `SELECT "id", "status"::text AS status, "completion_criterion"::text AS criterion,
              "updated_at", "xmin"::text AS xmin
         FROM "task" WHERE "owner_id" = $1::uuid ORDER BY "id"`,
      [ownerId],
    )).rows;
    const definitionSnapshot = async () => (await sql.query(
      `SELECT d.*, d."xmin"::text AS xmin FROM "project_acceptance_criterion_definition" d
         JOIN "project" p ON p."id" = d."project_id"
        WHERE p."owner_id" = $1::uuid ORDER BY d."id"`,
      [ownerId],
    )).rows;

    const tasksBefore = await taskSnapshot();
    const definitionsBefore = await definitionSnapshot();
    assert.equal(tasksBefore.length, statuses.length * 3);
    assert.equal(definitionsBefore.length, 4);

    // The rename, applied and reversed in one transaction. This is the migration's one row-facing
    // operation, run against seeded rows in every status the production table carries.
    await sql.query('BEGIN');
    await sql.query(
      `ALTER TYPE "task_completion_criterion" RENAME VALUE 'EVIDENCE_JUDGMENT' TO 'N26_TMP_LABEL'`,
    );
    const renamedTasks = (await sql.query(
      `SELECT "id", "status"::text AS status, "completion_criterion"::text AS criterion,
              "updated_at", "xmin"::text AS xmin
         FROM "task" WHERE "owner_id" = $1::uuid ORDER BY "id"`,
      [ownerId],
    )).rows;
    const renamedDefinitions = (await sql.query(
      `SELECT d.*, d."xmin"::text AS xmin FROM "project_acceptance_criterion_definition" d
         JOIN "project" p ON p."id" = d."project_id"
        WHERE p."owner_id" = $1::uuid ORDER BY d."id"`,
      [ownerId],
    )).rows;
    await sql.query(
      `ALTER TYPE "task_completion_criterion" RENAME VALUE 'N26_TMP_LABEL' TO 'EVIDENCE_JUDGMENT'`,
    );
    await sql.query('COMMIT');

    await t.test('(e) a value rename leaves no row pointing at a label that is not in the enum',
      async () => {
        assert.equal(renamedTasks.length, tasksBefore.length);
        for (const row of renamedTasks) assert.equal(row.criterion, 'N26_TMP_LABEL');
        const orphans = (await sql.query(
          `SELECT count(*)::int AS n FROM "task"
            WHERE "completion_criterion"::text NOT IN (
              SELECT e.enumlabel FROM pg_enum e JOIN pg_type ty ON ty.oid = e.enumtypid
               WHERE ty.typname = 'task_completion_criterion')`,
        )).rows[0].n;
        assert.equal(orphans, 0);
        // And structurally: the migration contains no statement that could have moved a task or a
        // criterion definition onto a different criterion in the first place.
        const removal = read(REMOVAL_MIGRATION);
        const body = removal.replace(/^--.*$/gm, '');
        assert.doesNotMatch(body, /UPDATE\s+"?task"?\s+SET[\s\S]{0,200}completion_criterion/i);
        assert.doesNotMatch(body, /UPDATE\s+"?project_acceptance_criterion_definition"?/i);
        assert.doesNotMatch(body, /DELETE\s+FROM\s+"?(task|project_acceptance_[a-z_]+)"?/i);
      });

    await t.test('(f) every unfinished task keeps the same criterion and a reachable decision',
      async () => {
        const unfinishedBefore = tasksBefore.filter(
          (row) => !['DONE', 'CANCELLED'].includes(row.status));
        const unfinishedAfter = renamedTasks.filter(
          (row) => !['DONE', 'CANCELLED'].includes(row.status));
        assert.equal(unfinishedAfter.length, unfinishedBefore.length);
        assert.deepEqual(unfinishedAfter.map((row) => row.id), unfinishedBefore.map((row) => row.id));
        for (const [index, row] of unfinishedAfter.entries()) {
          assert.equal(row.xmin, unfinishedBefore[index].xmin,
            'a renamed criterion must not rewrite the task row');
          assert.equal(row.status, unfinishedBefore[index].status);
        }
        // Reachability, not just survival: the criterion has a decision path that terminates.
        const reachable = (await sql.query(
          `SELECT count(*)::int AS n FROM "task"
            WHERE "owner_id" = $1::uuid AND "status" NOT IN ('DONE','CANCELLED')
              AND "completion_criterion" = 'EVIDENCE_JUDGMENT'::"task_completion_criterion"`,
          [ownerId],
        )).rows[0].n;
        assert.equal(reachable, unfinishedBefore.length);
      });

    await t.test('(g) every project keeps a stated criterion, out of the rename’s reach', async () => {
      const projects = (await sql.query(
        `SELECT p."id", count(d."id")::int AS "stated"
           FROM "project" p
           LEFT JOIN "project_acceptance_criterion_definition" d ON d."project_id" = p."id"
          WHERE p."owner_id" = $1::uuid GROUP BY p."id"`,
        [ownerId],
      )).rows;
      // The three sibling projects plus the seeded one: 43 production projects state these
      // criteria, and losing ANY project's completion basis is the failure being excluded.
      assert.equal(projects.length, 1 + otherProjects.length);
      for (const project of projects) {
        assert.ok(project.stated > 0, 'a project that states nothing cannot be completed');
      }
      // Until migration 0233 a criterion carried the enum too, and this case asserted the renamed
      // label appeared on it. It no longer declares that type at all — the work declares the
      // criterion instead — so what a rename does to a criterion row is now NOTHING, and that is
      // the stronger statement: byte-identical rows, unmoved `xmin`.
      assert.equal(renamedDefinitions.length, definitionsBefore.length);
      assert.deepEqual(renamedDefinitions, definitionsBefore);
      const enumUsers = (await sql.query<{ user: string }>(
        `SELECT table_name || '.' || column_name AS "user" FROM information_schema.columns
          WHERE table_schema = 'public' AND udt_name = 'task_completion_criterion'
          ORDER BY 1`,
      )).rows.map((row) => row.user);
      assert.deepEqual(enumUsers, ['task.completion_criterion']);
    });

    await t.test('(h) an already-DONE task is neither reopened nor rejudged', async () => {
      const doneBefore = tasksBefore.filter((row) => row.status === 'DONE');
      const doneAfter = renamedTasks.filter((row) => row.status === 'DONE');
      assert.equal(doneAfter.length, doneBefore.length);
      for (const [index, row] of doneAfter.entries()) {
        assert.equal(row.status, 'DONE');
        assert.equal(row.updated_at.toISOString(), doneBefore[index].updated_at.toISOString());
        assert.equal(row.xmin, doneBefore[index].xmin);
      }
      const stillDone = (await sql.query(
        `SELECT count(*)::int AS n FROM "task"
          WHERE "owner_id" = $1::uuid AND "status" = 'DONE'`,
        [ownerId],
      )).rows[0].n;
      assert.equal(stillDone, doneBefore.length);
    });

    await t.test('(p) the ruler itself is byte-for-byte what it was', async () => {
      const after = await definitionSnapshot();
      assert.equal(after.length, definitionsBefore.length);
      for (const [index, row] of after.entries()) {
        assert.deepEqual(row, definitionsBefore[index]);
      }
      // Explicitly, the two columns this task is forbidden to touch — including through the rename.
      for (const [index, row] of renamedDefinitions.entries()) {
        assert.equal(row.text, definitionsBefore[index].text);
        assert.equal(row.verification_method, definitionsBefore[index].verification_method);
        assert.equal(row.xmin, definitionsBefore[index].xmin);
      }
    });

    // ── (n): the ruler cannot be moved by this removal ────────────────────────────────────────

    await t.test('(n) theRulerStillRefusesEveryMachine: editing and confirming stay HUMAN_ONLY',
      async () => {
        // The proposal channel that used to carry this claim was deleted by 0223 and the judging
        // it fed by 0229, so what is checkable here is the authority table both were built on top
        // of, which outlived them: a machine still may not restate a criterion.
        for (const action of ['EDIT_ACCEPTANCE_CRITERIA', 'CONFIRM_ACCEPTANCE_CRITERIA'] as const) {
          assert.equal(COORDINATOR_AUTHORITY[action], 'HUMAN_ONLY');
          const refusal = refuseHumanOnlyAction('JUDGMENT', action);
          assert.ok(refusal instanceof Object);
          assert.equal(refusal.requiredAction, 'ASK_A_PERSON');
        }
        // And this migration names no criteria relation in any statement, so no criterion's text
        // or verification_method can move by one byte.
        const removal = read(REMOVAL_MIGRATION).replace(/^--.*$/gm, '');
        for (const relation of ['project_acceptance_criterion_definition',
          'project_acceptance_criterion', 'project_acceptance_run']) {
          assert.doesNotMatch(removal,
            new RegExp(`(INSERT INTO|UPDATE|DELETE FROM|ALTER TABLE|DROP TABLE)\\s+"?${relation}`, 'i'),
            `the removal writes ${relation}`);
        }
      });
  });
