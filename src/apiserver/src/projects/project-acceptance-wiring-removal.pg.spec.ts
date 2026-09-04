/**
 * T4 on real PostgreSQL: the criterion stops pointing at the work, and the enum survives it.
 *
 * `project_acceptance_criterion_definition` carried four columns that wired a stated condition to
 * the work that would satisfy it — `completion_criterion`, `acceptance_command`,
 * `acceptance_expected_exit_code` and `evidence_task_id`. Migration 0232 landed the same edge from
 * the other side (`task.criterion_definition_id`) and T3 showed "is this criterion satisfied?" can
 * be answered entirely from there, so migration 0233 removes these four. What is left on a
 * criterion is what the account owner approved: `text`, `verification_method`, `revision` and the
 * identity/hash columns.
 *
 * Why this is a `.pg.spec` and not a unit test. Three of the five claims are claims about the
 * database catalog — which columns exist, which type they declare, which enum labels remain — and
 * the fifth is a claim about plpgsql that only executing it can settle: `DROP COLUMN` does not
 * touch a function body, so a hash function still naming a dropped column compiles, deploys, and
 * fails on the next INSERT. A stubbed Prisma proves none of that.
 *
 * The fourth claim is the one this removal was most likely to get wrong in the other direction.
 * The four names are simply absent from the DTO now, and the global pipe runs `whitelist: true`
 * with `forbidNonWhitelisted: false` — which STRIPS an undeclared property. Left there, a caller
 * still sending `evidenceTaskId` would get 200 and no hint that the wiring is gone. So each field
 * is refused by name, at the pipe and at the service, and this file asserts the status code and
 * the message rather than only that nothing was written.
 *
 * Destructive: it truncates. COORDINATOR_PG_URL must name the disposable guarded database with
 * current migrations applied. The full-api harness supplies it:
 *
 *   PATH=/opt/node26/bin:$PATH \
 *   OUTCOME_RELEASE_API_SPEC_REGEX='project-acceptance-wiring-removal\.pg\.spec\.js$' \
 *   OUTCOME_RELEASE_API_JOBS=1 bash scripts/outcome-reconciler-full-api.sh
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { BadRequestException, ValidationPipe } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import { Client } from 'pg';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from './coordinator-pg-test-safety';
import { prismaClientFor } from '../prisma/prisma-client';
import { CreateProjectDto, UpdateProjectDto } from './dto';
import { ProjectsService } from './projects.service';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

/** The four columns migration 0233 removed, spelled as the database spelled them. */
const REMOVED_COLUMNS = [
  'acceptance_command',
  'acceptance_expected_exit_code',
  'completion_criterion',
  'evidence_task_id',
] as const;

/** The same four as a caller spells them, each with a value that field once accepted. */
const REMOVED_FIELDS: ReadonlyArray<readonly [string, unknown]> = [
  ['completionCriterion', 'EXECUTABLE'],
  ['acceptanceCommand', 'npm test'],
  ['acceptanceExpectedExitCode', 0],
  ['evidenceTaskId', '00000000-0000-4000-8000-000000000001'],
];

/** The hash lanes the removal keeps, and whose inputs it rewrites. */
interface Lanes {
  content_hash: string | null;
  semantic_hash: string | null;
  evaluation_plan_hash: string | null;
  revision: number;
  semantic_revision: number;
  evaluation_plan_revision: number;
}

test('T4: a criterion no longer names the work, and task_completion_criterion outlives it', {
  skip, concurrency: 1, timeout: 180_000,
}, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const prisma: PrismaClient = prismaClientFor(url);
  t.after(async () => {
    await prisma.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });
  await sql.query(
    'TRUNCATE "task", "session", "project", "workspace", "runner", "user" RESTART IDENTITY CASCADE',
  );

  // Nothing is stubbed: the service the API wires, over the real client.
  const projects = new ProjectsService(prisma as never);

  const ownerId = randomUUID();
  await sql.query(
    `INSERT INTO "user" ("id","email","name","password_hash") VALUES ($1,$2,'T4','x')`,
    [ownerId, `t4-${ownerId}@wiring-removal.invalid`],
  );

  async function project(title: string): Promise<string> {
    const id = randomUUID();
    await sql.query(
      `INSERT INTO "project" ("id","owner_id","title","updated_at") VALUES ($1,$2,$3,now())`,
      [id, ownerId, title],
    );
    return id;
  }

  /** Every lane of every criterion of one project, read straight out of the row. */
  async function lanes(projectId: string): Promise<Lanes[]> {
    const { rows } = await sql.query<Lanes>(
      `SELECT "content_hash", "semantic_hash", "evaluation_plan_hash", "revision",
              "semantic_revision", "evaluation_plan_revision"
         FROM "project_acceptance_criterion_definition"
        WHERE "project_id" = $1::uuid ORDER BY "ordinal"`,
      [projectId],
    );
    return rows;
  }

  // ═══ 1. the four columns are gone from the criterion ══════════════════════════════════════════
  await t.test('the four wiring columns are absent from the criterion definition', async () => {
    const { rows } = await sql.query<{ column_name: string }>(
      `SELECT "column_name" FROM "information_schema"."columns"
        WHERE "table_schema" = 'public'
          AND "table_name" = 'project_acceptance_criterion_definition'
          AND "column_name" = ANY($1::text[]) ORDER BY "column_name"`,
      [[...REMOVED_COLUMNS]],
    );
    assert.deepEqual(rows.map((row) => row.column_name), []);

    // And what stands in their place is the whole remaining shape, in ordinal order: the assertion,
    // the method that decides it, the advisory override audit, and the identity/hash columns. An
    // exact list rather than a subset, so a column cannot be added back without saying so here.
    const { rows: shape } = await sql.query<{ column_name: string }>(
      `SELECT "column_name" FROM "information_schema"."columns"
        WHERE "table_schema" = 'public'
          AND "table_name" = 'project_acceptance_criterion_definition'
        ORDER BY "ordinal_position"`,
    );
    assert.deepEqual(shape.map((row) => row.column_name), [
      'id', 'project_id', 'ordinal', 'text', 'revision', 'content_hash',
      'created_at', 'updated_at', 'verification_method',
      'completion_criterion_override_reason', 'semantic_revision', 'semantic_hash',
      'evaluation_plan_revision', 'evaluation_plan_hash',
    ]);
  });

  // ═══ 2. sending one of the four is REFUSED, not ignored ═══════════════════════════════════════
  //
  // Four cases, one per field, on both doors a caller can arrive through, and each asserts the
  // status code and the wording. "It was not written" would pass against an implementation that
  // silently dropped the field, which is exactly the soft landing this removal had to avoid.
  const pipe = new ValidationPipe({
    whitelist: true, transform: true, forbidNonWhitelisted: false,
  });

  for (const [field, value] of REMOVED_FIELDS) {
    await t.test(`project criteria refuse ${field} at the HTTP boundary`, async () => {
      const body = {
        title: 'T4 refusal',
        acceptanceCriteriaItems: [{
          text: `A criterion that still sends ${field}`,
          verificationMethod: 'A person reads it and says whether it holds',
          [field]: value,
        }],
      };
      const rejection = await pipe
        .transform(body, { type: 'body', metatype: CreateProjectDto })
        .then(() => null, (error: unknown) => error);
      assert.ok(rejection instanceof BadRequestException,
        `${field} passed the validation pipe instead of being refused`);
      assert.equal(rejection.getStatus(), 400);
      const message = JSON.stringify(rejection.getResponse());
      assert.match(message, new RegExp(`${field} was removed by migration 0233`));
      assert.match(message, /task\.criterionDefinitionId/);

      // The same field on the update door, which validates a different DTO class.
      const updateRejection = await pipe
        .transform({ acceptanceCriteriaItems: body.acceptanceCriteriaItems },
          { type: 'body', metatype: UpdateProjectDto })
        .then(() => null, (error: unknown) => error);
      assert.ok(updateRejection instanceof BadRequestException,
        `${field} passed the update pipe instead of being refused`);
      assert.equal(updateRejection.getStatus(), 400);
    });

    await t.test(`project criteria refuse ${field} at the service`, async () => {
      const projectId = await project(`refusal via service: ${field}`);
      const item = {
        text: `A criterion that still sends ${field}`,
        verificationMethod: 'A person reads it and says whether it holds',
        [field]: value,
      };
      await assert.rejects(
        projects.update(ownerId, projectId, { acceptanceCriteriaItems: [item] } as never),
        (error: unknown) => {
          assert.ok(error instanceof BadRequestException,
            `${field} was accepted by the service instead of being refused`);
          assert.equal(error.getStatus(), 400);
          assert.match(error.message, new RegExp(`${field} was removed by migration 0233`));
          assert.match(error.message, /task\.criterionDefinitionId/);
          return true;
        },
      );
      // Refused rather than partially applied.
      assert.deepEqual(await lanes(projectId), []);

      // Explicit `null` is refused too. A caller sending `acceptanceCommand: null` is still making
      // a claim about a column that is gone, and accepting it would put the removal back where it
      // started: the client keeps the old shape and nothing ever tells it.
      await assert.rejects(
        projects.update(ownerId, projectId, {
          acceptanceCriteriaItems: [{ ...item, [field]: null }],
        } as never),
        (error: unknown) => {
          assert.ok(error instanceof BadRequestException);
          assert.match(error.message, new RegExp(`${field} was removed by migration 0233`));
          return true;
        },
      );
      assert.deepEqual(await lanes(projectId), []);
    });
  }

  // ═══ 3. the enum survives, whole ══════════════════════════════════════════════════════════════
  await t.test('task_completion_criterion still exists with all three labels', async () => {
    const { rows } = await sql.query<{ typname: string; enumlabel: string }>(
      `SELECT ty."typname", e."enumlabel"
         FROM "pg_type" ty JOIN "pg_enum" e ON e."enumtypid" = ty."oid"
         JOIN "pg_namespace" n ON n."oid" = ty."typnamespace"
        WHERE n."nspname" = 'public' AND ty."typname" = 'task_completion_criterion'
        ORDER BY e."enumsortorder"`,
    );
    assert.deepEqual(rows.map((row) => row.enumlabel),
      ['EXECUTABLE', 'VERIFICATION', 'EVIDENCE_JUDGMENT'],
      'removing the criterion’s use of the enum must not remove the enum');
  });

  // ═══ 4. one user left, and it is the task ═════════════════════════════════════════════════════
  await t.test('the criterion is no longer a user of the enum, and the task still is', async () => {
    const { rows } = await sql.query<{ user: string }>(
      `SELECT "table_name" || '.' || "column_name" AS "user"
         FROM "information_schema"."columns"
        WHERE "table_schema" = 'public' AND "udt_name" = 'task_completion_criterion'
        ORDER BY 1`,
    );
    assert.deepEqual(rows.map((row) => row.user), ['task.completion_criterion'],
      'the enum has exactly one declaring column, and it is the work’s own criterion');

    // Stated from both ends so neither half can drift: the task's column is NOT NULL and typed by
    // this enum, and the criterion definition declares nothing of that type at all.
    const { rows: task } = await sql.query<{ udt_name: string; is_nullable: string }>(
      `SELECT "udt_name", "is_nullable" FROM "information_schema"."columns"
        WHERE "table_schema" = 'public' AND "table_name" = 'task'
          AND "column_name" = 'completion_criterion'`,
    );
    assert.deepEqual(task, [{ udt_name: 'task_completion_criterion', is_nullable: 'NO' }]);
  });

  // ═══ 5. the hash lanes are still computed, by functions that no longer read the dropped columns ═
  await t.test('semantic_hash and evaluation_plan_hash survive and are still computed', async () => {
    const { rows: kept } = await sql.query<{ column_name: string; is_nullable: string }>(
      `SELECT "column_name", "is_nullable" FROM "information_schema"."columns"
        WHERE "table_schema" = 'public'
          AND "table_name" = 'project_acceptance_criterion_definition'
          AND "column_name" IN ('semantic_hash', 'evaluation_plan_hash')
        ORDER BY "column_name"`,
    );
    assert.deepEqual(kept, [
      { column_name: 'evaluation_plan_hash', is_nullable: 'NO' },
      { column_name: 'semantic_hash', is_nullable: 'NO' },
    ]);

    // The executable half of the claim. `DROP COLUMN` leaves a plpgsql body alone, so a normalize
    // trigger still naming `NEW."completion_criterion"` would deploy cleanly and fail here, on the
    // first row anybody writes.
    const projectId = await project('hash lanes after the removal');
    await projects.update(ownerId, projectId, {
      acceptanceCriteriaItems: [{
        text: 'The suite is green',
        verificationMethod: 'Run the suite and require a clean exit',
      }],
    } as never);
    const [created] = await lanes(projectId);
    assert.ok(created, 'the criterion was written');
    for (const lane of ['content_hash', 'semantic_hash', 'evaluation_plan_hash'] as const) {
      assert.match(created[lane] ?? '', /^[0-9a-f]{64}$/, `${lane} was not computed on insert`);
    }
    assert.deepEqual(
      [created.revision, created.semantic_revision, created.evaluation_plan_revision], [1, 1, 1]);

    // And on a rewrite, which is the other branch of the same function: both halves of the
    // declaration move, so both lanes move and both counters advance.
    const [stored] = await sql.query<{ id: string }>(
      `SELECT "id" FROM "project_acceptance_criterion_definition" WHERE "project_id" = $1::uuid`,
      [projectId],
    ).then((result) => result.rows);
    await projects.update(ownerId, projectId, {
      acceptanceCriteriaItems: [{
        id: stored.id,
        text: 'The suite is green on Linux',
        verificationMethod: 'Run the suite on Linux and require a clean exit',
      }],
    } as never);
    const [rewritten] = await lanes(projectId);
    for (const lane of ['content_hash', 'semantic_hash', 'evaluation_plan_hash'] as const) {
      assert.match(rewritten[lane] ?? '', /^[0-9a-f]{64}$/, `${lane} was not computed on update`);
      assert.notEqual(rewritten[lane], created[lane], `${lane} did not move when its input did`);
    }
    assert.deepEqual(
      [rewritten.revision, rewritten.semantic_revision, rewritten.evaluation_plan_revision],
      [2, 2, 2]);

    // The stored lanes are reproducible from the live functions, which is the difference between
    // "a hash was written" and "the hash of what this row now says".
    const { rows: recomputed } = await sql.query<{ same: boolean }>(
      `SELECT d."semantic_hash" = project_acceptance_definition_semantic_hash(d."text")
              AND d."evaluation_plan_hash"
                  = project_acceptance_definition_evaluation_plan_hash(d."verification_method")
              AND d."content_hash"
                  = project_acceptance_definition_content_hash(d."text", d."verification_method")
                AS "same"
         FROM "project_acceptance_criterion_definition" d WHERE d."project_id" = $1::uuid`,
      [projectId],
    );
    assert.deepEqual(recomputed.map((row) => row.same), [true]);
  });

  // ═══ the untracked half: no function body still names a dropped column ════════════════════════
  await t.test('no installed function body still reads one of the four columns', async () => {
    // PostgreSQL does not parse column references inside a plpgsql or sql body, so this class of
    // breakage is invisible to `DROP COLUMN`, invisible to CASCADE, and invisible to every test
    // that does not execute the function. Read from the live catalog rather than the migration
    // files: a later CREATE OR REPLACE is what makes a file stale.
    //
    // The pattern requires a word end after the name so that
    // `completion_criterion_override_reason` — a column this removal deliberately KEEPS — is not
    // read as a use of `completion_criterion`.
    const { rows } = await sql.query<{ proname: string }>(
      `SELECT p."oid"::regprocedure::text AS "proname"
         FROM "pg_proc" p JOIN "pg_namespace" n ON n."oid" = p."pronamespace"
        WHERE n."nspname" = 'public'
          AND p."prosrc" ~ '(completion_criterion|acceptance_command|acceptance_expected_exit_code|evidence_task_id)([^_a-z]|$)'
        ORDER BY 1`,
    );
    // An exact list, not "no project_acceptance_* function": the two that remain read `task`,
    // whose identically named columns 0233 does not touch, and any third name appearing here is a
    // body left pointing at a column that no longer exists.
    assert.deepEqual(rows.map((row) => row.proname), [
      'task_done_canonical_writer_fence()',
      'task_verification_carrier_status_derive()',
    ], 'a function still reads the criterion columns 0233 dropped; it will fail when next executed');
  });

  await t.test('the PostgreSQL target is a disposable database', async () => {
    await verifyCoordinatorPgIdentity(sql);
  });
});
