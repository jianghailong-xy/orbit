/**
 * T1 on real PostgreSQL: what a task declares it serves, as a relation rather than a name.
 *
 * `CreateTaskDto.criterionKey` has always been a word the server checked and then dropped — its
 * own comment said "nothing is written from it". Migration 0232 gives it a landing place: the
 * stable id of the criterion the key resolved to, and the `revision` that criterion carried at the
 * moment the work was declared against it.
 *
 * Why this is a `.pg.spec` and not a unit test. Every claim below is a claim about PostgreSQL
 * doing something: that the two columns exist and take these values, that dropping the criterion
 * empties one column through `ON DELETE SET NULL` and leaves the other alone, and that the pair
 * `criterion_definition_id IS NULL AND criterion_revision IS NOT NULL` is therefore a readable
 * fact about work whose criterion is gone. A stubbed Prisma proves none of them — it would prove
 * that the service passes two fields to a function.
 *
 * Destructive: it truncates. COORDINATOR_PG_URL must name the disposable guarded database with
 * current migrations applied. The full-api harness supplies it:
 *
 *   PATH=/opt/node26/bin:$PATH \
 *   OUTCOME_RELEASE_API_SPEC_REGEX='task-criterion-declaration\.pg\.spec\.js$' \
 *   OUTCOME_RELEASE_API_JOBS=1 bash scripts/outcome-reconciler-full-api.sh
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { ForbiddenException } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import { Client } from 'pg';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { criterionKeyOf } from '../projects/project-acceptance';
import { prismaClientFor } from '../prisma/prisma-client';
import { TasksService } from './tasks.service';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

/** One stated criterion, as a caller of `task_create` meets it: a key, and what it resolves to. */
interface Stated {
  id: string;
  /** The criterion's own id — what `project_get` hands out and `criterionKey` carries. */
  key: string;
  revision: number;
}

/** The two columns 0232 adds, read straight out of the row rather than through the client. */
interface Declaration {
  criterion_definition_id: string | null;
  criterion_revision: number | null;
}

test('T1: a task’s criterion declaration is a relation, and outlives the criterion', {
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

  // Nothing is stubbed. The service is the one the API wires, over the real client; the two
  // constructor arguments it does not use here are the session service and the realtime publisher,
  // exactly as `project-scope-fence.pg.spec` builds it.
  const service = new TasksService(prisma as never, {} as never, {
    publishTaskChanged() {},
    publishForUser() {},
  } as never);

  const ownerId = randomUUID();
  await sql.query(
    `INSERT INTO "user" ("id","email","name","password_hash") VALUES ($1,$2,'T1','x')`,
    [ownerId, `t1-${ownerId}@criterion-declaration.invalid`],
  );

  async function project(title: string): Promise<string> {
    const id = randomUUID();
    await sql.query(
      `INSERT INTO "project" ("id","owner_id","title","updated_at") VALUES ($1,$2,$3,now())`,
      [id, ownerId, title],
    );
    return id;
  }

  /**
   * State one criterion and read back what a caller would be told to name it by.
   *
   * The `revision` is read back rather than assumed: `project_acceptance_definition_normalize` is
   * a BEFORE INSERT trigger that rewrites `content_hash` and pins `revision` to 1, so a snapshot
   * this test predicted would be a snapshot the row never had.
   */
  async function state(projectId: string, ordinal: number, text: string): Promise<Stated> {
    const id = randomUUID();
    await sql.query(
      `INSERT INTO "project_acceptance_criterion_definition"
         ("id","project_id","ordinal","text","verification_method",
          "content_hash","semantic_hash","updated_at")
       VALUES ($1,$2,$3,$4,'read it and say whether it holds',
               repeat('0',64), repeat('0',64), now())`,
      [id, projectId, ordinal, text],
    );
    return read(id);
  }

  async function read(id: string): Promise<Stated> {
    const { rows } = await sql.query<{ revision: number }>(
      `SELECT "revision" FROM "project_acceptance_criterion_definition"
        WHERE "id" = $1::uuid`,
      [id],
    );
    assert.equal(rows.length, 1, 'the criterion this test states must exist');
    return { id, key: criterionKeyOf(id), revision: rows[0].revision };
  }

  async function declarationOf(taskId: string): Promise<Declaration> {
    const { rows } = await sql.query<Declaration>(
      `SELECT "criterion_definition_id"::text AS criterion_definition_id, "criterion_revision"
         FROM "task" WHERE "id" = $1::uuid`,
      [taskId],
    );
    assert.equal(rows.length, 1, 'the task must still be there to have a declaration');
    return rows[0];
  }

  /** The refused call's body, with a real assertion that it WAS refused. */
  async function refusalOf(run: () => Promise<unknown>): Promise<Record<string, unknown>> {
    try {
      await run();
    } catch (error) {
      assert.ok(error instanceof ForbiddenException, `expected a refusal, got ${error}`);
      return error.getResponse() as Record<string, unknown>;
    }
    throw new assert.AssertionError({ message: 'the declaration was not refused' });
  }

  const goal = await project('T1 subject project');
  const elsewhere = await project('T1 unrelated project');
  // Edited once, so `revision` is 2 rather than the insert trigger's 1. A snapshot asserted
  // against a constant the trigger always writes would pass whatever the write path stored.
  const servedId = (await state(goal, 1, 'the declaration lands in the database')).id;
  await sql.query(
    `UPDATE "project_acceptance_criterion_definition"
        SET "text" = 'the declaration lands in the database, and can be read back'
      WHERE "id" = $1::uuid`,
    [servedId],
  );
  const served = await read(servedId);
  assert.equal(served.revision, 2, 'the fixture must exercise a revision the default cannot fake');
  const foreign = await state(elsewhere, 1, 'a criterion of a project this work is not in');

  // ═══ 1. the positive ══════════════════════════════════════════════════════════════════════
  let subjectId = '';
  await t.test('a declared criterion is written as its id and the revision it then had', async () => {
    const created = await service.create(ownerId, {
      title: 'work that says what it is for',
      projectId: goal,
      criterionKey: served.key,
    } as never);
    subjectId = created.id;

    const row = await declarationOf(created.id);
    assert.equal(row.criterion_definition_id, served.id,
      'the uuid the column keys by, resolved from the key the caller sent');
    assert.equal(row.criterion_revision, served.revision,
      'the revision as it stood when the work was declared against it');
  });

  // ═══ 2–4. the three refusals ══════════════════════════════════════════════════════════════
  // Each asserts the code AND the required action, because "it threw" is satisfied by a typo in a
  // findFirst as readily as by the rule under test.
  await t.test('a criterion key no project states is refused', async () => {
    const body = await refusalOf(() => service.create(ownerId, {
      title: 'work naming a criterion that does not exist',
      projectId: goal,
      criterionKey: 'f'.repeat(32),
    } as never));

    assert.equal(body.code, 'TASK_CRITERION_UNKNOWN');
    assert.equal(body.requiredAction, 'NAME_THE_CRITERION_THIS_SERVES');
    assert.equal(await tasksTitled('work naming a criterion that does not exist'), 0,
      'a refusal must leave nothing behind');
  });

  await t.test('a criterion key another project states is refused', async () => {
    // The key is real and resolves — in a project this task is not in. Nothing about the string
    // says so, which is why the resolution has to be scoped to the task's own project.
    const body = await refusalOf(() => service.create(ownerId, {
      title: 'work naming another project’s criterion',
      projectId: goal,
      criterionKey: foreign.key,
    } as never));

    assert.equal(body.code, 'TASK_CRITERION_UNKNOWN');
    assert.equal(body.requiredAction, 'NAME_THE_CRITERION_THIS_SERVES');
    assert.equal(await tasksTitled('work naming another project’s criterion'), 0);
  });

  await t.test('work in no project cannot declare a criterion', async () => {
    const body = await refusalOf(() => service.create(ownerId, {
      title: 'work in no project naming a criterion',
      criterionKey: served.key,
    } as never));

    assert.equal(body.code, 'TASK_CRITERION_UNKNOWN');
    assert.equal(body.requiredAction, 'NAME_THE_CRITERION_THIS_SERVES');
    assert.equal(await tasksTitled('work in no project naming a criterion'), 0);
  });

  // The negative control for all three: the same create, with no declaration at all, is the
  // ordinary task every caller has always been able to file.
  await t.test('a task that declares nothing is untouched by any of this', async () => {
    const created = await service.create(ownerId, {
      title: 'work that declares nothing', projectId: goal,
    } as never);

    assert.deepEqual(await declarationOf(created.id),
      { criterion_definition_id: null, criterion_revision: null });
  });

  // ═══ 5. the criterion is deleted ══════════════════════════════════════════════════════════
  await t.test('deleting the criterion empties the id, keeps the revision, and is visible', async () => {
    const before = await declarationOf(subjectId);
    assert.equal(before.criterion_definition_id, served.id, 'the subject must still be declared');

    await sql.query(
      'DELETE FROM "project_acceptance_criterion_definition" WHERE "id" = $1::uuid', [servedId],
    );

    const after = await declarationOf(subjectId);
    assert.equal(after.criterion_definition_id, null, 'ON DELETE SET NULL, not ON DELETE CASCADE');
    assert.equal(after.criterion_revision, served.revision,
      'the snapshot survives: it is what makes the orphan legible at all');
    const survivors = await sql.query<{ id: string }>(
      'SELECT "id"::text AS id FROM "task" WHERE "id" = $1::uuid', [subjectId],
    );
    assert.equal(survivors.rows.length, 1, 'the work outlives the criterion it was filed under');

    // The whole of "declared a criterion that no longer exists", with no flag column to keep in
    // step with the deletion.
    const orphaned = await service.orphanedCriterionDeclarations(ownerId);
    assert.deepEqual(orphaned.map((row) => row.id), [subjectId]);
    assert.equal(orphaned[0].criterionRevision, served.revision);
    assert.equal(orphaned[0].projectId, goal);
  });

  async function tasksTitled(title: string): Promise<number> {
    const { rows } = await sql.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM "task" WHERE "title" = $1', [title],
    );
    return Number(rows[0].count);
  }
});
