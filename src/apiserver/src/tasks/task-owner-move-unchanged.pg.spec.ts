/**
 * §4 R1 on real PostgreSQL: the account owner's own move — `PATCH /tasks/:id` with another
 * `projectId`, no session — is what it was before a confirmed MOVE_TASK could move a task.
 *
 * The owner asks nobody: the move happens, no question is filed, and nothing new is recorded about
 * it. It is still refused for what it was refused for: a criterion declaration it would leave
 * behind, a subtask it would leave behind, and a run that is live. Written against the door, and
 * only against APIs that predate the confirmation, so the same file runs unchanged on a tree without
 * it — which is how "unchanged" is shown rather than asserted.
 *
 *   scripts/run-pg-spec.sh src/apiserver/src/tasks/task-owner-move-unchanged.pg.spec.ts
 */

import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { HttpException } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import { Client } from 'pg';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { criterionKeyOf } from '../projects/project-acceptance';
import { ProjectHandoffService } from '../projects/project-handoff.service';
import { TasksController } from './tasks.controller';
import { TasksService } from './tasks.service';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

type Refusal = { status: number; body: Record<string, unknown> };

test('§4 R1: the owner\'s own move, with no session, is unchanged', { skip, concurrency: 1, timeout: 120_000 }, async (t) => {
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
  const tasks = new TasksService(
    prisma as never,
    {} as never,
    { publishTaskChanged: () => undefined, publishForUser: () => undefined } as never,
    handoffs,
  );
  // `PATCH /tasks/:id`, the owner's door. It reaches nothing but the task service.
  const door = new TasksController(tasks, {} as never);

  const ownerId = randomUUID();
  const workspaceId = randomUUID();
  const runnerId = randomUUID();
  await admin.query(
    `INSERT INTO "user" ("id","email","name","password_hash") VALUES ($1,$2,'owner','x')`,
    [ownerId, `owner-${ownerId}@move.invalid`]);
  await admin.query(
    `INSERT INTO "runner" ("id","owner_id","name","status","token_hash","capabilities_reported_at")
     VALUES ($1,$2,'owner-runner','ONLINE',$3,now())`, [runnerId, ownerId, `owner-${runnerId}`]);
  await admin.query(
    `INSERT INTO "workspace" ("id","owner_id","name","runner_id","can_create_tasks","can_delegate")
     VALUES ($1,$2,'owner-agent',$3,true,true)`, [workspaceId, ownerId, runnerId]);
  const [projectA, projectB] = [randomUUID(), randomUUID()];
  for (const [id, name] of [[projectA, 'A'], [projectB, 'B']]) {
    await admin.query(
      `INSERT INTO "project" ("id","owner_id","title","coordinator_enabled","updated_at")
       VALUES ($1,$2,$3,true,now())`, [id, ownerId, `owner project ${name}`]);
  }
  const criterionA = randomUUID();
  await admin.query(
    `INSERT INTO "project_acceptance_criterion_definition"
       ("id","project_id","ordinal","text","verification_method","content_hash","created_at","updated_at")
     VALUES ($1,$2,1,'what A wants','a pg spec',$3,now(),now())`,
    [criterionA, projectA, createHash('sha256').update('what A wants').digest('hex')]);

  async function insertTask(title: string, extra: Record<string, unknown> = {}): Promise<string> {
    const id = randomUUID();
    const row: Record<string, unknown> = {
      id, owner_id: ownerId, title, status: 'OPEN', project_id: projectA, creator_type: 'USER',
      creator_id: ownerId, updated_at: new Date(), completion_criterion: 'EVIDENCE_JUDGMENT', ...extra,
    };
    const columns = Object.keys(row);
    await admin.query(
      `INSERT INTO "task" (${columns.map((c) => `"${c}"`).join(',')})
       VALUES (${columns.map((_, i) => `$${i + 1}`).join(',')})`, Object.values(row));
    return id;
  }

  const user = { userId: ownerId, email: `owner-${ownerId}@move.invalid`, credential: { kind: 'LOGIN' as const } };
  const patch = (id: string, dto: Record<string, unknown>) =>
    door.update(user, id, dto as never) as Promise<{ id: string; projectId: string | null }>;

  async function refusalOf(run: () => Promise<unknown>): Promise<Refusal> {
    try {
      await run();
    } catch (error) {
      assert.ok(error instanceof HttpException, `expected a typed refusal, got ${error}`);
      return { status: error.getStatus(), body: error.getResponse() as Record<string, unknown> };
    }
    throw new assert.AssertionError({ message: 'the request was not refused' });
  }

  async function taskRow(id: string) {
    const { rows: [row] } = await admin.query<{
      project_id: string | null; criterion_definition_id: string | null; criterion_revision: number | null;
    }>('SELECT "project_id", "criterion_definition_id", "criterion_revision" FROM "task" WHERE "id" = $1::uuid', [id]);
    return row;
  }

  /** Nothing the owner's own move should leave behind: no question, no answer, no recorded move. */
  async function assertNothingAsked(): Promise<void> {
    const { rows: asked } = await admin.query(
      'SELECT 1 FROM "project_handoff_approval" WHERE "owner_id" = $1::uuid', [ownerId]);
    assert.deepEqual(asked, [], 'the owner asks nobody');
    const { rows: recorded } = await admin.query(
      `SELECT "type" FROM "activity" WHERE "actor_id" = $1::uuid`, [ownerId]);
    assert.deepEqual(recorded, [], 'and an edit through this door records no activity');
  }

  await t.test('a task is moved, and nobody is asked', async () => {
    const plain = await insertTask('plain work');
    const moved = await patch(plain, { projectId: projectB });
    assert.equal(moved.projectId, projectB);
    assert.equal((await taskRow(plain)).project_id, projectB);
    // `handoff` in the body changes nothing for the owner: there is nobody to ask.
    const back = await patch(plain, { projectId: projectA, handoff: { reason: 'the owner says so' } });
    assert.equal(back.projectId, projectA);
    await assertNothingAsked();
  });

  await t.test('a declaration it would leave behind is refused, and taken back or replaced in the same write', async () => {
    const declared = await insertTask('declared work', {
      criterion_definition_id: criterionA, criterion_revision: 1,
    });
    const refused = await refusalOf(() => patch(declared, { projectId: projectB }));
    assert.equal(refused.status, 400);
    assert.match(String(refused.body.message), /criterionKey: null/);
    assert.deepEqual(await taskRow(declared), {
      project_id: projectA, criterion_definition_id: criterionA, criterion_revision: 1,
    });
    const moved = await patch(declared, { projectId: projectB, criterionKey: null });
    assert.equal(moved.projectId, projectB);
    assert.deepEqual(await taskRow(declared), {
      project_id: projectB, criterion_definition_id: null, criterion_revision: null,
    });
    const home = await patch(declared, { projectId: projectA, criterionKey: criterionKeyOf(criterionA) });
    assert.equal(home.projectId, projectA);
    assert.deepEqual(await taskRow(declared), {
      project_id: projectA, criterion_definition_id: criterionA, criterion_revision: 1,
    });
    await assertNothingAsked();
  });

  await t.test('a subtask it would leave behind is refused', async () => {
    const parent = await insertTask('parent work');
    await insertTask('a part of it', { parent_task_id: parent });
    const refused = await refusalOf(() => patch(parent, { projectId: projectB }));
    assert.equal(refused.status, 400);
    assert.match(String(refused.body.message), /subtask/);
    assert.equal((await taskRow(parent)).project_id, projectA);
    await assertNothingAsked();
  });

  await t.test('a task whose run is live is refused', async () => {
    const running = await insertTask('running work');
    const session = randomUUID();
    await admin.query(
      `INSERT INTO "session" ("id","owner_id","workspace_id","title","prompt","creator_id",
         "provider","status","dispatch_origin","updated_at")
       VALUES ($1,$2,$3,'a run of it','fixture',$2,'claude','RUNNING'::"run_status",
         'USER'::"session_dispatch_origin",now())`, [session, ownerId, workspaceId]);
    await admin.query('UPDATE "session" SET "task_id" = $2::uuid WHERE "id" = $1::uuid', [session, running]);
    const refused = await refusalOf(() => patch(running, { projectId: projectB }));
    assert.equal(refused.status, 409);
    assert.match(String(refused.body.message), /live run/);
    assert.equal((await taskRow(running)).project_id, projectA);
    await assertNothingAsked();
  });
});
