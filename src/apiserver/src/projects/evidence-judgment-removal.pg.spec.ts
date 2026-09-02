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
import { PrismaService } from '../prisma/prisma.service';
import { ProjectAcceptanceService } from './project-acceptance.service';
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
           "id","project_id","ordinal","text","verification_method","completion_criterion",
           "content_hash"
         ) VALUES ($1,$2,1,$3,$4,'EVIDENCE_JUDGMENT'::"task_completion_criterion",$5)`,
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

    await t.test('(g) every project keeps a stated, decidable criterion', async () => {
      const projects = (await sql.query(
        `SELECT p."id",
                count(d."id")::int AS "stated",
                count(d."id") FILTER (
                  WHERE d."completion_criterion" IN (
                    'EXECUTABLE'::"task_completion_criterion",
                    'VERIFICATION'::"task_completion_criterion",
                    'EVIDENCE_JUDGMENT'::"task_completion_criterion")
                )::int AS "decidable"
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
        assert.equal(project.decidable, project.stated,
          'every stated criterion must still name a criterion the evaluator can decide');
      }
      for (const definition of renamedDefinitions) {
        assert.equal(definition.completion_criterion, 'N26_TMP_LABEL');
      }
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

    // ── (b): the machine conclusion is now sufficient ─────────────────────────────────────────
    const acceptance = new ProjectAcceptanceService(db as unknown as PrismaService);
    const judged = await createProject('machine-verdict');
    const judgmentSessionId = randomUUID();
    await sql.query(
      `INSERT INTO "session" (
         "id","owner_id","creator_id","title","prompt","status","dispatch_origin",
         "starts_task_work","updated_at")
       VALUES ($1,$2,$2,'judgment','judge the project','RUNNING',
               'PROJECT_COORDINATOR'::"session_dispatch_origin",false,now())`,
      [judgmentSessionId, ownerId],
    );

    await t.test('(b) an agent conclusion makes the criterion PASS with no owner in the loop',
      async () => {
        const run = await acceptance.openRun(ownerId, judged.projectId, {
          decidedBy: 'COORDINATOR_AGENT',
          coordinatorSessionId: judgmentSessionId,
        }) as { id: string };
        const finalized = await acceptance.finalizeRun(
          ownerId,
          judged.projectId,
          run.id,
          [{
            ordinal: 1,
            verdict: 'PASS' as never,
            summary: 'The stated outcome is reached; see the cited evidence.',
            evidence: { kind: 'N26_MACHINE_CONCLUSION', checked: 'the assertion, against evidence' },
          }],
          judgmentSessionId,
        ) as { verdict: string };
        assert.equal(finalized.verdict, 'PASS');

        const conclusion = (await sql.query(
          `SELECT "verdict"::text AS verdict, "decided_by", "acting_session_id"
             FROM "project_acceptance_conclusion"
            WHERE "project_id" = $1::uuid ORDER BY "decided_at" DESC LIMIT 1`,
          [judged.projectId],
        )).rows[0];
        assert.equal(conclusion.verdict, 'PASS');
        assert.equal(conclusion.decided_by, 'COORDINATOR_AGENT',
          'the conclusion that settles the criterion is attributed to the machine that made it');
        assert.equal(conclusion.acting_session_id, judgmentSessionId);

        // The authority table says the same thing, and says it without a refusal to route around.
        assert.equal(COORDINATOR_AUTHORITY.CONCLUDE_VERDICT_PASS, 'COORDINATOR_BOUNDED');
        assert.ok(!AUTHORITY_REFUSAL_CODES.includes('VERDICT_PASS_HUMAN_ONLY' as never));
        const service = read('src/apiserver/src/projects/project-acceptance.service.ts');
        assert.doesNotMatch(service, /refuseHumanOnlyAction\([^)]*CONCLUDE_VERDICT_PASS/,
          'the acceptance door must not consult the removed human-only row');
        assert.doesNotMatch(service, /assertMayConcludePass/);
      });

    // ── (i)(j): evidence and append-only are untouched ────────────────────────────────────────

    await t.test('(i) a conclusion is still bound to the evidence version it names', async () => {
      // The run is the evidence version. Concluding against a run that is no longer the current
      // one, or against a criterion the snapshot does not contain, is refused rather than accepted
      // and quietly re-pointed.
      const run = await acceptance.openRun(ownerId, judged.projectId, {
        decidedBy: 'COORDINATOR_AGENT',
        coordinatorSessionId: judgmentSessionId,
      }) as { id: string };
      await assert.rejects(
        acceptance.finalizeRun(
          ownerId, judged.projectId, run.id,
          [{ ordinal: 99, verdict: 'PASS' as never }],
          judgmentSessionId,
        ),
        /no criterion 99 in this run's snapshot/,
      );
      // And every stated criterion has to be answered: a PASS over a partial checklist is refused.
      const second = await createProject('two-criteria');
      await sql.query(
        `INSERT INTO "project_acceptance_criterion_definition" (
           "id","project_id","ordinal","text","verification_method","completion_criterion",
           "content_hash"
         ) VALUES ($1,$2,2,'a second stated condition','read it',
                   'EVIDENCE_JUDGMENT'::"task_completion_criterion",$3)`,
        [randomUUID(), second.projectId, digest(`n26:second:${second.projectId}`)],
      );
      const partialRun = await acceptance.openRun(ownerId, second.projectId, {
        decidedBy: 'COORDINATOR_AGENT',
        coordinatorSessionId: judgmentSessionId,
      }) as { id: string };
      await assert.rejects(
        acceptance.finalizeRun(
          ownerId, second.projectId, partialRun.id,
          [{ ordinal: 1, verdict: 'PASS' as never }],
          judgmentSessionId,
        ),
        /have no conclusion/,
      );
    });

    await t.test('(j) evidence version and append-only survive: history is added to, never edited',
      async () => {
        const before = (await sql.query(
          `SELECT "id", "evidence_run_id", "evidence_version"::text AS version,
                  "verdict"::text AS verdict, "decided_by", "decided_at", "xmin"::text AS xmin
             FROM "project_acceptance_conclusion" WHERE "project_id" = $1::uuid ORDER BY "id"`,
          [judged.projectId],
        )).rows;
        assert.ok(before.length > 0, 'the fixture must have concluded at least once');

        const run = await acceptance.openRun(ownerId, judged.projectId, {
          decidedBy: 'COORDINATOR_AGENT',
          coordinatorSessionId: judgmentSessionId,
        }) as { id: string };
        await acceptance.finalizeRun(
          ownerId, judged.projectId, run.id,
          [{ ordinal: 1, verdict: 'FAIL' as never, summary: 'a later reading disagrees' }],
          judgmentSessionId,
        );
        const after = (await sql.query(
          `SELECT "id", "evidence_run_id", "evidence_version"::text AS version,
                  "verdict"::text AS verdict, "decided_by", "decided_at", "xmin"::text AS xmin
             FROM "project_acceptance_conclusion" WHERE "project_id" = $1::uuid ORDER BY "id"`,
          [judged.projectId],
        )).rows;
        assert.ok(after.length > before.length, 'a new conclusion is appended');
        const retained = after.filter((row) => before.some((old) => old.id === row.id));
        assert.equal(retained.length, before.length, 'no historical conclusion disappeared');
        for (const row of retained) {
          const original = before.find((old) => old.id === row.id)!;
          assert.deepEqual(row, original,
            'a historical conclusion is never rewritten, not even to change its verdict');
        }
        // Every event names the immutable evidence version it was reached against, and that
        // version is the run's own frozen attempt rather than a value the caller supplied.
        for (const row of after) {
          const attempt = (await sql.query(
            'SELECT "attempt"::text AS attempt FROM "project_acceptance_run" WHERE "id" = $1::uuid',
            [row.evidence_run_id],
          )).rows[0].attempt;
          assert.equal(row.version, attempt);
        }
        // And the standing verdict is the newest event, with the earlier one still readable.
        const standing = after.reduce((newest, row) =>
          row.decided_at > newest.decided_at ? row : newest);
        assert.equal(standing.verdict, 'FAIL');
        assert.ok(before.some((row) => row.verdict === 'PASS'),
          'the superseded PASS is still on the record');
      });

    await t.test('(k) a recorded conclusion of any verdict survives the migration unchanged',
      async () => {
        // The 152 production rows are 106 PASS / 31 INCONCLUSIVE / 15 FAIL. Produce all three
        // shapes through the real writer, snapshot every column, and then replay the one statement
        // this migration aims at the table.
        const project = await createProject('history');
        for (const ordinal of [2, 3]) {
          await sql.query(
            `INSERT INTO "project_acceptance_criterion_definition" (
               "id","project_id","ordinal","text","verification_method","completion_criterion",
               "content_hash"
             ) VALUES ($1,$2,$3,$4,'read it',
                       'EVIDENCE_JUDGMENT'::"task_completion_criterion",$5)`,
            [randomUUID(), project.projectId, ordinal, `historical criterion ${ordinal}`,
              digest(`n26:history:${project.projectId}:${ordinal}`)],
          );
        }
        const run = await acceptance.openRun(ownerId, project.projectId, {
          decidedBy: 'COORDINATOR_AGENT',
          coordinatorSessionId: judgmentSessionId,
        }) as { id: string };
        await acceptance.finalizeRun(
          ownerId, project.projectId, run.id,
          [
            { ordinal: 1, verdict: 'PASS' as never, summary: 'historical PASS' },
            { ordinal: 2, verdict: 'INCONCLUSIVE' as never, summary: 'historical INCONCLUSIVE' },
            { ordinal: 3, verdict: 'FAIL' as never, summary: 'historical FAIL' },
          ],
          judgmentSessionId,
        );
        const before = (await sql.query(
          `SELECT * FROM "project_acceptance_conclusion"
            WHERE "project_id" = $1::uuid ORDER BY "ordinal"`,
          [project.projectId],
        )).rows;
        assert.deepEqual(before.map((row) => row.verdict), ['PASS', 'INCONCLUSIVE', 'FAIL']);

        // The migration's only statement against this table is the authority CHECK swap, which is
        // a constraint definition and touches no tuple. Replay it and diff every column.
        await sql.query(`
          ALTER TABLE "project_acceptance_conclusion"
            DROP CONSTRAINT "project_acceptance_conclusion_pass_authority_chk",
            ADD CONSTRAINT "project_acceptance_conclusion_pass_authority_chk"
              CHECK ("decided_by" IN ('USER', 'SYSTEM', 'COORDINATOR_AGENT'))`);
        const after = (await sql.query(
          `SELECT * FROM "project_acceptance_conclusion"
            WHERE "project_id" = $1::uuid ORDER BY "ordinal"`,
          [project.projectId],
        )).rows;
        assert.deepEqual(after, before, 'every field of every recorded conclusion is unchanged');
        // And the migration states nothing else about this table.
        const removal = read(REMOVAL_MIGRATION).replace(/^--.*$/gm, '');
        assert.doesNotMatch(removal,
          /(INSERT INTO|UPDATE|DELETE FROM)\s+"?project_acceptance_conclusion/i);
      });

    // ── (n): the ruler cannot be moved by this removal ────────────────────────────────────────

    await t.test('(n) theRulerStillRefusesEveryMachine: editing and confirming stay HUMAN_ONLY',
      async () => {
        // The proposal channel that used to carry this claim was deleted by 0223, so what is
        // checkable here is the authority table it was built on top of, which outlived it: a
        // judgment session may now CONCLUDE a criterion, and still may not restate one.
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
