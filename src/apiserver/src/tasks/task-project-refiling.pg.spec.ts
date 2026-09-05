/**
 * Re-filing a task on real PostgreSQL: the edit that says which project a task belongs to, and
 * what a move is not allowed to leave behind.
 *
 * `UpdateTaskDto.projectId` has been three-state since it existed — omit to leave the filing
 * alone, null to take the task out of every project, an id to (re)file it — but no client sent it,
 * so a task the SERVER filed by inference (`coordinator.session_filed` reads the acting session's
 * project when the caller named none) was frozen wherever it landed. The remedy, once the clients
 * can send it, is one PATCH; what this spec pins is that the remedy is CLEAN, and that opening it
 * did not open a way around the checks a move already had to pass.
 *
 * Why this is a `.pg.spec` and not a unit test. Every claim below is a claim about a row and about
 * WHEN it is read: that detaching empties `project_id` and leaves `discovered_from_project_id`
 * standing (belonging and provenance are two columns and only one of them is being edited); that a
 * move whose subtasks, verifications or criterion declaration would be stranded is refused under
 * the owner lock, against the row as re-read inside the transaction. A stubbed Prisma would prove
 * the service passes some fields to a function.
 *
 * Destructive: it truncates. COORDINATOR_PG_URL must name the disposable guarded database with
 * current migrations applied. The full-api harness supplies it:
 *
 *   PATH=/opt/node26/bin:$PATH \
 *   OUTCOME_RELEASE_API_SPEC_REGEX='task-project-refiling\.pg\.spec\.js$' \
 *   OUTCOME_RELEASE_API_JOBS=1 bash scripts/outcome-reconciler-full-api.sh
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { CreatorType, type PrismaClient } from '@prisma/client';
import { Client } from 'pg';
import { prismaClientFor } from '../prisma/prisma-client';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { criterionKeyOf } from '../projects/project-acceptance';
import { TasksService } from './tasks.service';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

/** build/tasks -> build -> apiserver -> src -> repository root. */
const REPO_ROOT = path.resolve(__dirname, '../../../..');

/** Where a task belongs, and where it was noticed. Two columns, read straight out of the row. */
interface Filing {
  project_id: string | null;
  discovered_from_project_id: string | null;
  criterion_definition_id: string | null;
  criterion_revision: number | null;
}

test('a task can be re-filed and taken out of a project, and a move cannot strand what points at it', {
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

  // Nothing is stubbed: the service the API wires, over the real client, as the sibling criterion
  // specs build it. The two constructor arguments unused here are the session service and the
  // realtime publisher.
  const service = new TasksService(prisma as never, {} as never, {
    publishTaskChanged() {},
    publishForUser() {},
  } as never);

  const ownerId = randomUUID();
  await sql.query(
    `INSERT INTO "user" ("id","email","name","password_hash") VALUES ($1,$2,'refile','x')`,
    [ownerId, `refile-${ownerId}@task-project-refiling.invalid`],
  );

  async function project(title: string): Promise<string> {
    const id = randomUUID();
    await sql.query(
      `INSERT INTO "project" ("id","owner_id","title","updated_at") VALUES ($1,$2,$3,now())`,
      [id, ownerId, title],
    );
    return id;
  }

  async function state(projectId: string, ordinal: number, text: string): Promise<{
    id: string; key: string; revision: number;
  }> {
    const id = randomUUID();
    await sql.query(
      `INSERT INTO "project_acceptance_criterion_definition"
         ("id","project_id","ordinal","text","verification_method",
          "content_hash","semantic_hash","updated_at")
       VALUES ($1,$2,$3,$4,'read it and say whether it holds',
               repeat('0',64), repeat('0',64), now())`,
      [id, projectId, ordinal, text],
    );
    const { rows } = await sql.query<{ revision: number }>(
      `SELECT "revision" FROM "project_acceptance_criterion_definition" WHERE "id" = $1::uuid`,
      [id],
    );
    assert.equal(rows.length, 1, 'the criterion this test states must exist');
    return { id, key: criterionKeyOf(id), revision: rows[0].revision };
  }

  async function filingOf(taskId: string): Promise<Filing> {
    const { rows } = await sql.query<Filing>(
      `SELECT "project_id"::text AS project_id,
              "discovered_from_project_id"::text AS discovered_from_project_id,
              "criterion_definition_id"::text AS criterion_definition_id,
              "criterion_revision"
         FROM "task" WHERE "id" = $1::uuid`,
      [taskId],
    );
    assert.equal(rows.length, 1, 'the task must still be there to have a filing');
    return rows[0];
  }

  async function fileTask(
    title: string,
    extra: Record<string, unknown> = {},
  ): Promise<{ id: string }> {
    return service.create(ownerId, {
      title, completionCriterion: 'EVIDENCE_JUDGMENT', ...extra,
    } as never) as Promise<{ id: string }>;
  }

  /** The refused call's message, with a real assertion that it WAS refused. */
  async function refusalOf(run: () => Promise<unknown>): Promise<string> {
    try {
      await run();
    } catch (error) {
      assert.ok(error instanceof BadRequestException, `expected a refusal, got ${error}`);
      const body = error.getResponse() as string | { message?: string };
      return typeof body === 'string' ? body : (body.message ?? '');
    }
    throw new assert.AssertionError({ message: 'the move was not refused' });
  }

  /** The scope contract's refusal body, with a real assertion that it WAS refused. */
  async function scopeRefusalOf(run: () => Promise<unknown>): Promise<Record<string, unknown>> {
    try {
      await run();
    } catch (error) {
      assert.ok(error instanceof ForbiddenException, `expected a scope refusal, got ${error}`);
      return error.getResponse() as Record<string, unknown>;
    }
    throw new assert.AssertionError({ message: 'the write was not refused' });
  }

  const goal = await project('the project this work was filed under');
  const elsewhere = await project('the project it is being moved to');

  // The session the incident actually happened through. Provenance is written by the SERVER at
  // insert time and frozen afterwards by `task_provenance_immutable_guard`, so there is no way to
  // retro-fit it onto a task: a fixture that wanted a task with `discovered_from_project_id` set
  // has to file one the way the server does, from a session that coordinates the project.
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  const coordinatorSessionId = randomUUID();
  await sql.query(
    `INSERT INTO "runner" ("id","owner_id","name","status","token_hash","capabilities_reported_at")
     VALUES ($1,$2,'refile-runner','ONLINE',$3,now())`,
    [runnerId, ownerId, `refile-${runnerId}`],
  );
  await sql.query(
    `INSERT INTO "workspace" ("id","owner_id","name","runner_id","can_create_tasks","can_delegate")
     VALUES ($1,$2,'refile-agent',$3,true,true)`,
    [workspaceId, ownerId, runnerId],
  );
  await sql.query(
    `INSERT INTO "session" ("id","owner_id","workspace_id","title","prompt","creator_id",
       "provider","status","dispatch_origin","updated_at")
     VALUES ($1,$2,$3,'refile-coordinator','fixture',$2,'claude','RUNNING'::"run_status",
       'USER'::"session_dispatch_origin",now())`,
    [coordinatorSessionId, ownerId, workspaceId],
  );
  await sql.query(
    `INSERT INTO "project_runtime" ("project_id","updated_at") VALUES ($1,now())
       ON CONFLICT ("project_id") DO NOTHING`,
    [goal],
  );
  await sql.query(
    'UPDATE "project" SET "coordinator_session_id" = $2::uuid WHERE "id" = $1::uuid',
    [goal, coordinatorSessionId],
  );

  // ═══ 1. taking work OUT of a project ══════════════════════════════════════════════════════
  await t.test('detaching empties the filing and leaves where the work was noticed', async () => {
    // The incident, reproduced: a coordinator session files a task and names no project, and the
    // server files it under the project that session coordinates — recording, beside it, that this
    // is where the work was noticed rather than something the caller asked for.
    const task = await service.create(
      ownerId,
      { title: 'work filed under a project it does not serve',
        completionCriterion: 'EVIDENCE_JUDGMENT' } as never,
      { type: CreatorType.AGENT, id: workspaceId },
      coordinatorSessionId,
    ) as { id: string };
    const { rows: filed } = await sql.query<{ trigger_event: string | null }>(
      'SELECT "trigger_event" FROM "task" WHERE "id" = $1::uuid', [task.id],
    );
    assert.equal(filed[0].trigger_event, 'coordinator.session_filed',
      'the fixture has to be the filing this edit exists to correct, not one it was told to make');
    assert.deepEqual(await filingOf(task.id), {
      project_id: goal,
      discovered_from_project_id: goal,
      criterion_definition_id: null,
      criterion_revision: null,
    }, 'the mis-filing this edit exists to correct, as the server leaves it');

    // No acting session: this is the account owner correcting it, which is the only principal
    // that may leave work under no goal at all (the case below is the other side of that).
    await service.update(ownerId, task.id, { projectId: null } as never);

    assert.deepEqual(await filingOf(task.id), {
      project_id: null,
      // The half a detach must NOT touch. Belonging is a claim about what the work is part of and
      // provenance is a fact about where it was noticed; clearing both would erase the evidence
      // that the mis-filing ever happened, which is the only trace of why this task exists.
      discovered_from_project_id: goal,
      criterion_definition_id: null,
      criterion_revision: null,
    }, 'the membership goes; the provenance stays');
    const { rows } = await sql.query<{ id: string }>(
      'SELECT "id"::text AS id FROM "task" WHERE "id" = $1::uuid', [task.id],
    );
    assert.equal(rows.length, 1, 'the filing goes; the work stays');
  });

  // Re-filing under another project is the same field's other value, and it is the direction the
  // account owner guards. Nothing in this test is a coordinator, so no crossing is declared and
  // the write is the owner's own: the scope contract only asks the question of a session that
  // holds a coordination scope.
  await t.test('an owner can re-file work under another project', async () => {
    const task = await fileTask('work that belongs to the other goal', { projectId: goal });

    await service.update(ownerId, task.id, { projectId: elsewhere } as never);

    assert.equal((await filingOf(task.id)).project_id, elsewhere);
  });

  // Both halves of the field are the OWNER's, and this is the half that reads as a surprise: the
  // detach a person may make is refused to the session that would most want it, because §4 R4 is
  // about work that names no goal — nothing counts it, so nobody may leave it there. The clients
  // say so in as many words, and this is what makes that copy true rather than reassuring.
  await t.test('a session acting under a project scope may not unfile work, and the owner may',
    async () => {
      const task = await service.create(
        ownerId,
        { title: 'work a coordinator would like to be rid of',
          completionCriterion: 'EVIDENCE_JUDGMENT', projectId: goal } as never,
        { type: CreatorType.AGENT, id: workspaceId },
        coordinatorSessionId,
      ) as { id: string };

      const refusal = await scopeRefusalOf(() => service.update(
        ownerId, task.id, { projectId: null } as never, coordinatorSessionId,
      ));

      assert.equal(refusal.code, 'UNMAPPED_PROJECT_WORK');
      assert.equal(refusal.requiredAction, 'NAME_OWNING_PROJECT');
      assert.equal((await filingOf(task.id)).project_id, goal, 'a refused detach writes nothing');

      // The same write, from the principal the contract exempts. Without this the case above would
      // pass for a server that refused everybody, which is a different product.
      await service.update(ownerId, task.id, { projectId: null } as never);
      assert.equal((await filingOf(task.id)).project_id, null);
    });

  // ═══ 2. what a move may not leave behind ══════════════════════════════════════════════════
  // The declaration 0232 added is the third thing a project move can strand, and until this it was
  // the one nothing checked: `criterionDefinitionId` was left untouched by a write that did not
  // mention `criterionKey`, so the task walked out of the project still claiming to serve one of
  // its criteria. That claim is counted by the old project's satisfaction read and is visible to
  // nobody as wrong.
  await t.test('a move that would strand a criterion declaration is refused, and writes nothing',
    async () => {
      const served = await state(goal, 1, 'the criterion this work declares it serves');
      const task = await fileTask('work that declared what it serves', {
        projectId: goal, criterionKey: served.key,
      });
      assert.deepEqual(await filingOf(task.id), {
        project_id: goal,
        discovered_from_project_id: null,
        criterion_definition_id: served.id,
        criterion_revision: served.revision,
      }, 'it has to be carrying a declaration for the refusal below to be about anything');

      for (const move of [{ projectId: null }, { projectId: elsewhere }]) {
        const message = await refusalOf(() => service.update(ownerId, task.id, move as never));
        assert.match(message, /criterionKey: null/,
          'the refusal has to name the remedy: take the declaration back');
        assert.match(message, /declar/i);
        assert.deepEqual(await filingOf(task.id), {
          project_id: goal,
          discovered_from_project_id: null,
          criterion_definition_id: served.id,
          criterion_revision: served.revision,
        }, 'a refused move leaves the task exactly where it was, declaration included');
      }

      // ...and the remedy the refusal names works in ONE write, which is what makes it a remedy
      // rather than a wall: the declaration is taken back and the task leaves in the same PATCH.
      await service.update(ownerId, task.id, { projectId: null, criterionKey: null } as never);

      assert.deepEqual(await filingOf(task.id), {
        project_id: null,
        discovered_from_project_id: null,
        criterion_definition_id: null,
        criterion_revision: null,
      }, '0232’s hand-cleared state is BOTH columns null; a revision left without an id is what a '
      + 'DELETED criterion leaves, and writing it here would forge that');
      const survivors = await sql.query<{ id: string }>(
        'SELECT "id"::text AS id FROM "project_acceptance_criterion_definition" '
        + 'WHERE "id" = $1::uuid', [served.id],
      );
      assert.equal(survivors.rows.length, 1, 'the criterion it stopped naming is still stated');
    });

  // The other direction of the same write, and the reason the refusal is not just "clear it
  // first": a move that names a criterion the DESTINATION states is a re-declaration, resolved
  // against the project this write lands in.
  await t.test('a move that re-declares against the destination’s own criterion is allowed',
    async () => {
      const there = await state(elsewhere, 1, 'a criterion the destination project states');
      const here = await state(goal, 2, 'a criterion the origin project states');
      const task = await fileTask('work moving to the goal it actually serves', {
        projectId: goal, criterionKey: here.key,
      });

      await service.update(
        ownerId, task.id, { projectId: elsewhere, criterionKey: there.key } as never,
      );

      assert.deepEqual(await filingOf(task.id), {
        project_id: elsewhere,
        discovered_from_project_id: null,
        criterion_definition_id: there.id,
        criterion_revision: there.revision,
      }, 'the declaration follows the work to the project that states the criterion');
    });

  // ═══ 3. the guardrails a move already had, unchanged ══════════════════════════════════════
  // Both halves of `assertHierarchyConsistent`'s shared-project rule, restated through the door
  // this change opened: a client that can finally send `projectId` must not be a client that can
  // walk a task out from under its subtasks or its checks.
  await t.test('a move that would leave subtasks in another project is refused', async () => {
    const parent = await fileTask('the piece of work being decomposed', { projectId: goal });
    await fileTask('a step of it', { projectId: goal, parentTaskId: parent.id });

    const message = await refusalOf(() => service.update(
      ownerId, parent.id, { projectId: elsewhere } as never,
    ));

    assert.match(message, /has 1 subtask\(s\) that would be left in a different project/);
    assert.match(message, /detach them \(parentTaskId: null\), move them, and link them again/);
    assert.equal((await filingOf(parent.id)).project_id, goal);
  });

  await t.test('a move that would leave its verifications in another project is refused',
    async () => {
      const subject = await fileTask('the work somebody is checking', { projectId: goal });
      await fileTask('the check', {
        projectId: goal, verifiesTaskId: subject.id, completionCriterion: 'VERIFICATION',
      });

      const message = await refusalOf(() => service.update(
        ownerId, subject.id, { projectId: null } as never,
      ));

      assert.match(message, /has 1 verification\(s\) that would be left in a different project/);
      assert.match(message, /move or detach them before moving it/);
      assert.equal((await filingOf(subject.id)).project_id, goal);
    });

  // ═══ the tools ════════════════════════════════════════════════════════════════════════════
  // A server that can be told and a client that cannot say it is not a field anybody has — which
  // is the whole of the gap this work closes. Both agent-facing doors are hand-written, and the Go
  // suite next to them proves what they SEND; this proves the two files were touched at all, from
  // the side that knows the server accepts it.
  await t.test('the MCP and CLI edit doors can send it', () => {
    const mcp = readFileSync(path.join(REPO_ROOT, 'src/runner-go/mcp.go'), 'utf8');
    const schema = mcp.slice(mcp.indexOf('"name":        "task_update"'));
    const updateSchema = schema.slice(0, schema.indexOf('"name":        "task_delete"'));
    assert.ok(updateSchema.length > 0, 'the task_update descriptor has to be findable to be read');
    assert.match(updateSchema, /"projectId":\s+updateProjectIDProp/,
      'task_update’s input schema must name the field');
    const prop = mcp.slice(mcp.indexOf('updateProjectIDProp := map[string]interface{}{'));
    assert.match(prop.slice(0, 200), /"type": \[\]string\{"string", "null"\}/,
      'and it must be nullable there, because taking work out of a project is half of what it does');

    const dispatch = mcp.slice(mcp.indexOf('case "task_update":'));
    const handler = dispatch.slice(0, dispatch.indexOf('case "task_delete":'));
    assert.match(handler, /copyIfPresent\(body, args,[^\n]*"projectId"/,
      'a schema the dispatcher does not forward is a field the tool still cannot send');

    const cli = readFileSync(path.join(REPO_ROOT, 'src/runner-go/task_cli.go'), 'utf8');
    assert.match(cli, /body\["projectId"\] = nil/, '--no-project has to send an explicit null');
    assert.match(cli, /--project <id> \| --no-project/,
      '`orbit capabilities` is the only contract an agent reads the CLI through');
  });
});
