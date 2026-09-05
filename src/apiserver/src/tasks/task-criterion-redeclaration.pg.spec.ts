/**
 * The other half of migration 0232 on real PostgreSQL: a criterion declaration that can be made,
 * corrected and taken back AFTER the task exists.
 *
 * `CreateTaskDto.criterionKey` has been resolved into 0232's two columns since T1. `UpdateTaskDto`
 * had no such field, so a declaration was frozen at the moment the task was filed — and that is
 * what made `DECLARATION_STALE` a mark with no remedy. That clause fires when a task's declared
 * `criterion_revision` is not the one its criterion carries today, and it exists to ask somebody
 * to re-read the criterion and declare again; re-declaring was the one thing no caller could do.
 * The only way out was to delete the task and file it again, which is the detachment 0232
 * deliberately refused to make automatic.
 *
 * Why this is a `.pg.spec` and not a unit test. Every claim below is a claim about a row: that the
 * edit door writes both columns, that the revision it stamps is the criterion's CURRENT one rather
 * than the one the task was born with, that clearing writes the hand-cleared state (both NULL) and
 * not the state `ON DELETE SET NULL` leaves behind, and that the stale mark actually goes out when
 * the criterion is read back through the derivation that DEFINES the clause rather than through a
 * second copy of its arithmetic written here. A stubbed Prisma would prove that the service passes
 * some fields to a function.
 *
 * The criterion's `revision` is advanced the way the product advances it — by editing the words,
 * which `project_acceptance_definition_normalize` turns into `OLD.revision + 1`. A fixture that
 * wrote `revision` itself would be asserting against a number nothing produced.
 *
 * Destructive: it truncates. COORDINATOR_PG_URL must name the disposable guarded database with
 * current migrations applied. The full-api harness supplies it:
 *
 *   PATH=/opt/node26/bin:$PATH \
 *   OUTCOME_RELEASE_API_SPEC_REGEX='task-criterion-redeclaration\.pg\.spec\.js$' \
 *   OUTCOME_RELEASE_API_JOBS=1 bash scripts/outcome-reconciler-full-api.sh
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { ForbiddenException } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import { Client } from 'pg';
import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { criterionKeyOf } from '../projects/project-acceptance';
import { readCriterionSatisfaction } from '../projects/project-criterion-satisfaction';
import { TasksService } from './tasks.service';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

/** build/tasks -> build -> apiserver -> src -> repository root. */
const REPO_ROOT = path.resolve(__dirname, '../../../..');

/** One stated criterion, as a caller of `task_update` meets it: a key, and what it resolves to. */
interface Stated {
  id: string;
  /** The criterion's own id — what `project_get` hands out and `criterionKey` carries. */
  key: string;
  revision: number;
}

/** 0232's two columns, read straight out of the row rather than through the client. */
interface Declaration {
  criterion_definition_id: string | null;
  criterion_revision: number | null;
}

test('a task’s criterion declaration can be made, corrected and taken back after it exists', {
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
  // exactly as `task-criterion-declaration.pg.spec` builds it.
  const service = new TasksService(prisma as never, {} as never, {
    publishTaskChanged() {},
    publishForUser() {},
  } as never);

  const ownerId = randomUUID();
  await sql.query(
    `INSERT INTO "user" ("id","email","name","password_hash") VALUES ($1,$2,'redeclare','x')`,
    [ownerId, `redeclare-${ownerId}@criterion-redeclaration.invalid`],
  );

  async function project(title: string): Promise<string> {
    const id = randomUUID();
    await sql.query(
      `INSERT INTO "project" ("id","owner_id","title","updated_at") VALUES ($1,$2,$3,now())`,
      [id, ownerId, title],
    );
    return id;
  }

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

  /** Advance a criterion the way the product does: change the words, and let the normalize
   *  trigger count the revision. */
  async function reword(criterion: Stated, text: string): Promise<Stated> {
    await sql.query(
      `UPDATE "project_acceptance_criterion_definition" SET "text" = $2 WHERE "id" = $1::uuid`,
      [criterion.id, text],
    );
    const moved = await read(criterion.id);
    assert.equal(moved.revision, criterion.revision + 1,
      'rewording a criterion is what advances its revision; the fixture depends on that');
    return moved;
  }

  async function read(id: string): Promise<Stated> {
    const { rows } = await sql.query<{ revision: number }>(
      `SELECT "revision" FROM "project_acceptance_criterion_definition" WHERE "id" = $1::uuid`,
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

  /** Which clauses hold one criterion up, in the order the derivation reports them. */
  async function clausesHolding(projectId: string, definitionId: string): Promise<string[]> {
    const all = await readCriterionSatisfaction(
      prisma as unknown as PrismaService, ownerId, projectId,
    );
    const one = all.find((row) => row.definitionId === definitionId);
    assert.ok(one, 'the criterion must be in the project’s derived answer');
    return one.unmet.map((reason) => reason.clause);
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

  async function fileTask(
    title: string,
    extra: Record<string, unknown> = {},
  ): Promise<{ id: string }> {
    return service.create(ownerId, {
      title, completionCriterion: 'EVIDENCE_JUDGMENT', ...extra,
    } as never) as Promise<{ id: string }>;
  }

  const goal = await project('the project this work is filed under');
  const elsewhere = await project('a project this work is not in');
  let served = await state(goal, 1, 'the declaration can be made after the fact');
  const moving = await state(goal, 2, 'the wording that is going to move');
  const foreign = await state(elsewhere, 1, 'a criterion of a project this work is not in');

  // ═══ 1. declaring on a task that had no declaration ═══════════════════════════════════════
  let declaredId = '';
  await t.test('an existing task with no declaration can be given one, at today’s revision',
    async () => {
      const task = await fileTask('work filed before it knew what it served', { projectId: goal });
      declaredId = task.id;
      assert.deepEqual(await declarationOf(task.id),
        { criterion_definition_id: null, criterion_revision: null },
        'it has to start with nothing declared for the write below to be the thing observed');

      // Moved BEFORE the declaration is made, so "the criterion's current revision" and "the
      // revision a fresh criterion is born with" are different numbers. Asserting against 1 here
      // would pass for a write that stamped the trigger's insert default and read nothing.
      served = await reword(served, 'the declaration can be made after the fact, and corrected');
      assert.equal(served.revision, 2);

      await service.update(ownerId, task.id, { criterionKey: served.key } as never);

      assert.deepEqual(await declarationOf(task.id), {
        criterion_definition_id: served.id,
        criterion_revision: served.revision,
      }, 'the live relation, and the revision the criterion carries NOW');
    });

  // ═══ 2. the reason this door exists: re-declaring puts out DECLARATION_STALE ══════════════
  await t.test('re-declaring the same key catches the revision up and puts the stale mark out',
    async () => {
      const task = await fileTask('work declared against a wording that then changed', {
        projectId: goal, criterionKey: moving.key,
      });
      assert.equal((await declarationOf(task.id)).criterion_revision, moving.revision);

      const moved = await reword(moving, 'the wording that has now moved');
      assert.deepEqual(await clausesHolding(goal, moved.id),
        ['SERVING_WORK_UNSETTLED', 'DECLARATION_STALE'],
        'the work was declared against wording that has since moved, and the mark says so');

      await service.update(ownerId, task.id, { criterionKey: moved.key } as never);

      assert.deepEqual(await declarationOf(task.id), {
        criterion_definition_id: moved.id,
        criterion_revision: moved.revision,
      }, 'the declaration is being made NOW, so it is measured against what the criterion says now');
      assert.deepEqual(await clausesHolding(goal, moved.id), ['SERVING_WORK_UNSETTLED'],
        'exactly one clause went out: the mark this door exists to clear, and nothing else');
    });

  // ═══ 3. taking the declaration back ═══════════════════════════════════════════════════════
  await t.test('null releases the relation and leaves the work standing', async () => {
    // Clearing something that was never declared is the common shape and must not be an error: a
    // caller does not have to know whether a declaration is there in order to say it should not be.
    const undeclared = await fileTask('work that never declared anything', { projectId: goal });
    await service.update(ownerId, undeclared.id, { criterionKey: null } as never);
    assert.deepEqual(await declarationOf(undeclared.id),
      { criterion_definition_id: null, criterion_revision: null });

    // Stated, not assumed: this case is only a test of the clear path over a declaration that is
    // actually there. Without it the case passes on a task nothing ever wrote to, which is exactly
    // what it would be asked to catch.
    assert.deepEqual(await declarationOf(declaredId), {
      criterion_definition_id: served.id,
      criterion_revision: served.revision,
    }, 'the task must be carrying a declaration for taking one back to mean anything');

    await service.update(ownerId, declaredId, { criterionKey: null } as never);

    assert.deepEqual(await declarationOf(declaredId),
      { criterion_definition_id: null, criterion_revision: null },
      '0232’s hand-cleared state is BOTH columns null; a revision left behind without an id is '
      + 'what a DELETED criterion leaves, and writing it here would forge that');
    const { rows } = await sql.query<{ id: string }>(
      'SELECT "id"::text AS id FROM "task" WHERE "id" = $1::uuid', [declaredId],
    );
    assert.equal(rows.length, 1, 'the relation goes; the work stays');
    const survivors = await sql.query<{ id: string }>(
      'SELECT "id"::text AS id FROM "project_acceptance_criterion_definition" WHERE "id" = $1::uuid',
      [served.id],
    );
    assert.equal(survivors.rows.length, 1, 'and so does the criterion it stopped naming');
  });

  // ═══ 4–5. the two refusals, each with the action it names ═════════════════════════════════
  await t.test('a key another project states is refused, and writes nothing', async () => {
    const task = await fileTask('work naming another project’s criterion', {
      projectId: goal, criterionKey: served.key,
    });

    const body = await refusalOf(() => service.update(
      ownerId, task.id, { criterionKey: foreign.key } as never,
    ));

    assert.equal(body.code, 'TASK_CRITERION_UNKNOWN');
    assert.equal(body.requiredAction, 'NAME_THE_CRITERION_THIS_SERVES');
    assert.deepEqual(await declarationOf(task.id), {
      criterion_definition_id: served.id,
      criterion_revision: served.revision,
    }, 'a refused declaration leaves the one the task already had exactly as it was');
  });

  await t.test('work in no project cannot declare a criterion', async () => {
    // EXECUTABLE rather than this file's usual EVIDENCE_JUDGMENT: that criterion is itself
    // declared against a project's stated standard and can no longer be filed under nothing, and
    // what is being observed here is the criterion DECLARATION door, not the completion one.
    const task = await fileTask('work in no project', {
      completionCriterion: 'EXECUTABLE',
      acceptanceCommand: 'true',
      acceptanceExpectedExitCode: 0,
    });

    const body = await refusalOf(() => service.update(
      ownerId, task.id, { criterionKey: served.key } as never,
    ));

    assert.equal(body.code, 'TASK_CRITERION_UNKNOWN');
    assert.equal(body.requiredAction, 'NAME_THE_CRITERION_THIS_SERVES');
    assert.deepEqual(await declarationOf(task.id),
      { criterion_definition_id: null, criterion_revision: null });
  });

  // The negative control for case 3: clearing has exactly one spelling, and a blank key is not a
  // second one. Without this, an unset shell variable silently retracts a declaration.
  await t.test('a blank key is refused rather than read as a retraction', async () => {
    const task = await fileTask('work whose key came from an unset variable', {
      projectId: goal, criterionKey: served.key,
    });

    const body = await refusalOf(() => service.update(
      ownerId, task.id, { criterionKey: '   ' } as never,
    ));

    assert.equal(body.code, 'TASK_CRITERION_UNKNOWN');
    assert.equal(body.requiredAction, 'NAME_THE_CRITERION_THIS_SERVES');
    assert.equal((await declarationOf(task.id)).criterion_definition_id, served.id,
      'the declaration it already had is still there');
  });

  // ═══ the tools ════════════════════════════════════════════════════════════════════════════
  // A server that can be told and a tool that cannot say it is not a field anybody has. The two
  // agent-facing doors are MCP and the CLI capability document, and both are hand-written.
  await t.test('the MCP and CLI edit doors can send it', () => {
    const mcp = readFileSync(path.join(REPO_ROOT, 'src/runner-go/mcp.go'), 'utf8');
    const schema = mcp.slice(mcp.indexOf('"name":        "task_update"'));
    const updateSchema = schema.slice(0, schema.indexOf('"name":        "task_delete"'));
    assert.ok(updateSchema.length > 0, 'the task_update descriptor has to be findable to be read');
    assert.match(updateSchema, /"criterionKey":\s+updateCriterionKeyProp/,
      'task_update’s input schema must name the field');
    const prop = mcp.slice(mcp.indexOf('updateCriterionKeyProp := map[string]interface{}{'));
    assert.match(prop.slice(0, 200), /"type":\s+\[\]string\{"string", "null"\}/,
      'and it must be nullable there, because taking the declaration back is half of what it does');

    const dispatch = mcp.slice(mcp.indexOf('case "task_update":'));
    const handler = dispatch.slice(0, dispatch.indexOf('case "task_delete":'));
    assert.match(handler, /copyIfPresent\(body, args,[^\n]*"criterionKey"/,
      'a schema the dispatcher does not forward is a field the tool still cannot send');

    const cli = readFileSync(path.join(REPO_ROOT, 'src/runner-go/task_cli.go'), 'utf8');
    assert.match(cli, /body\["criterionKey"\] = /);
    assert.match(cli, /--criterion-key <key> \| --clear-criterion-key/,
      '`orbit capabilities` is the only contract an agent reads the CLI through');
  });
});
