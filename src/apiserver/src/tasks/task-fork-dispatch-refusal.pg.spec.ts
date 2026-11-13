/**
 * SR55 after the fact, on real PostgreSQL: a forked task that something ELSE moved into a state only
 * the session create door refuses, met by the auto-run sweep.
 *
 *   scripts/run-pg-spec.sh src/apiserver/src/tasks/task-fork-dispatch-refusal.pg.spec.ts
 *
 * The task's own writes refuse both placements (task-session-fork.pg.spec.ts). Two changes made
 * elsewhere still reach an existing forked task: (1) a code binding added to its project, and (2) its
 * workspace moved to another machine. Its next automatic start is then refused with a 409
 * (FORK_IN_BOUND_PROJECT / FORK_SOURCE_NOT_REACHABLE), and the sweep used to log that and try again on
 * every pass with nothing on the task saying so. For each case this asserts, through the production
 * sweep (`reconcileReadyTasks`) and the real `SessionsService.create`:
 *
 *   - the first sweep records the code on the task's dispatchRefusal, with its requiredAction (the
 *     fixAction) and message, leaves one timeline comment, and creates no session;
 *   - the second sweep does not call the session create door for the task at all, and changes nothing;
 *   - the control: undoing the change makes the task dispatchable again, the next sweep starts its run
 *     on the forking session's machine, and the refusal is cleared.
 *
 * Destructive only for the rows it makes (one owner per case, deleted at the end).
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { PrismaClient } from '@prisma/client';
import { Client } from 'pg';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { establishProjectContractForPgTest } from '../projects/project-contract-test-helper';
import { RunnerTasksController } from '../runner-api/runner-tasks.controller';
import { SessionsService } from '../sessions/sessions.service';
import { DISPATCH_REFUSED_SIGNAL_CODE } from './task-dispatch-refusal';
import { TasksService } from './tasks.service';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;
const SHA = (c: string) => c.repeat(40);

interface World {
  ownerId: string;
  runnerA: string;
  runnerB: string;
  workspaceA: string;
  forkingSessionId: string;
  projectId: string;
}

test('a forked task refused at dispatch is recorded and not re-dispatched', { skip, concurrency: 1, timeout: 180_000 }, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const { prismaClientFor } = await import('../prisma/prisma-client.js');
  const admin = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await admin.connect();
  await verifyCoordinatorPgIdentity(admin);
  const prisma: PrismaClient = prismaClientFor(url);
  const owners: string[] = [];
  t.after(async () => {
    for (const ownerId of owners) {
      await admin.query('DELETE FROM "session" WHERE "owner_id" = $1', [ownerId]).catch(() => undefined);
      await admin.query('DELETE FROM "task" WHERE "owner_id" = $1', [ownerId]).catch(() => undefined);
    }
    await prisma.$disconnect().catch(() => undefined);
    await admin.end().catch(() => undefined);
  });

  const realtime = new Proxy({}, { get: () => () => undefined });
  const sessions = new SessionsService(prisma as never, { notifySessionQueued: () => undefined } as never, realtime as never);
  // Every call the sweep makes to the session create door, by task: "attempted" is this count.
  const attempts = new Map<string, number>();
  const create = sessions.create.bind(sessions);
  (sessions as { create: typeof sessions.create }).create = ((ownerId: string, dto: { taskId?: string }, ...rest: unknown[]) => {
    if (dto?.taskId) attempts.set(dto.taskId, (attempts.get(dto.taskId) ?? 0) + 1);
    return (create as (...a: unknown[]) => unknown)(ownerId, dto, ...rest);
  }) as typeof sessions.create;
  const tasks = new TasksService(prisma as never, sessions as never, realtime as never);
  const runnerDoor = new RunnerTasksController(tasks, {} as never, {} as never);
  const sweep = () => (tasks as unknown as { reconcileReadyTasks(): Promise<void> }).reconcileReadyTasks();

  async function seed(label: string): Promise<World> {
    const w: World = {
      ownerId: randomUUID(), runnerA: randomUUID(), runnerB: randomUUID(), workspaceA: randomUUID(),
      forkingSessionId: randomUUID(), projectId: randomUUID(),
    };
    owners.push(w.ownerId);
    await admin.query(
      `INSERT INTO "user" ("id","email","name","password_hash") VALUES ($1,$2,$3,'x')`,
      [w.ownerId, `${label}-${w.ownerId}@fork-refusal.invalid`, label],
    );
    for (const [id, name] of [[w.runnerA, 'a'], [w.runnerB, 'b']]) {
      await admin.query(
        `INSERT INTO "runner" ("id","owner_id","name","status","token_hash","last_heartbeat_at","max_concurrent")
         VALUES ($1,$2,$3,'ONLINE',$4,clock_timestamp(),4)`,
        [id, w.ownerId, `${label}-${name}`, `${label}-${id}`],
      );
    }
    await admin.query(
      `INSERT INTO "workspace" ("id","owner_id","name","runner_id","work_dir","enable_worktree",
         "can_create_tasks","can_delegate")
       VALUES ($1,$2,$3,$4,$5,false,true,true)`,
      [w.workspaceA, w.ownerId, `${label}-ws-a`, w.runnerA, `/tmp/${label}-a`],
    );
    // A started project with room, so the sweep's independent scan offers its tasks.
    await admin.query(
      `INSERT INTO "project" ("id","owner_id","title","coordinator_enabled","started_at","max_concurrent_tasks","updated_at")
       VALUES ($1,$2,$3,true,now(),4,now())`,
      [w.projectId, w.ownerId, `${label}-project`],
    );
    await admin.query(
      `INSERT INTO "project_runtime" ("project_id","updated_at") VALUES ($1,now()) ON CONFLICT ("project_id") DO NOTHING`,
      [w.projectId],
    );
    await establishProjectContractForPgTest(prisma, w.ownerId, w.projectId, label);
    await admin.query(
      `INSERT INTO "session" ("id","owner_id","workspace_id","assigned_runner_id","title","prompt","creator_id",
         "provider","status","dispatch_origin","updated_at")
       VALUES ($1,$2,$3,$4,'Refactor the claim path','fixture',$2,'claude','RUNNING'::"run_status",
         'USER'::"session_dispatch_origin",now())`,
      [w.forkingSessionId, w.ownerId, w.workspaceA, w.runnerA],
    );
    await admin.query('UPDATE "project" SET "coordinator_session_id" = $2 WHERE "id" = $1', [w.projectId, w.forkingSessionId]);
    return w;
  }

  /** A forked task filed by the forking session, assigned to its machine, opted into auto-run. */
  async function forkedTask(w: World): Promise<string> {
    const task = await runnerDoor.createTask(
      { id: w.runnerA, ownerId: w.ownerId } as never,
      w.workspaceA,
      undefined,
      w.forkingSessionId,
      {
        title: 'Finish the claim refactor',
        completionCriterion: 'EVIDENCE_JUDGMENT',
        assigneeId: w.workspaceA,
        autoRunWhenReady: true,
        fork: { sessionId: w.forkingSessionId, sha: SHA('5'), baseHead: SHA('4'), includesUncommitted: true },
      } as never,
    ) as { id: string };
    const row = await prisma.task.findUniqueOrThrow({
      where: { id: task.id }, select: { projectId: true, autoRunWhenReady: true, forkRunnerId: true },
    });
    assert.deepEqual(row, { projectId: w.projectId, autoRunWhenReady: true, forkRunnerId: w.runnerA });
    return task.id;
  }

  async function state(taskId: string) {
    const task = await prisma.task.findUniqueOrThrow({
      where: { id: taskId }, select: { dispatchRefusal: true, status: true, updatedAt: true },
    });
    const comments = await prisma.taskComment.count({
      where: { taskId, body: { contains: `orbit:${DISPATCH_REFUSED_SIGNAL_CODE}` } },
    });
    const runs = await prisma.session.findMany({ where: { taskId }, select: { id: true, assignedRunnerId: true } });
    return { refusal: task.dispatchRefusal as any, status: task.status, updatedAt: task.updatedAt, comments, runs };
  }

  /**
   * Two sweeps over the refused task: the first records the refusal, the second does not try again.
   * Returns the recorded refusal.
   */
  async function assertRefusedTwice(taskId: string, code: string, requiredAction: string) {
    attempts.delete(taskId);
    await sweep();
    const first = await state(taskId);
    assert.equal(attempts.get(taskId), 1, 'the first sweep tried to start the task once');
    assert.equal(first.runs.length, 0, 'no session was created');
    assert.equal(first.status, 'OPEN');
    assert.equal(first.refusal?.code, code);
    assert.equal(first.refusal?.fixAction, requiredAction, 'the refusal carries its requiredAction');
    assert.equal(first.refusal?.sessionId, null, 'no run existed to name');
    assert.ok(typeof first.refusal?.reason === 'string' && first.refusal.reason.length > 0, 'and its message');
    assert.equal(first.comments, 1, 'one timeline comment says so');

    await sweep();
    const second = await state(taskId);
    assert.equal(attempts.get(taskId), 1, 'the second sweep did not try to start it again');
    assert.equal(second.runs.length, 0);
    assert.deepEqual(second.refusal, first.refusal, 'the refusal is unchanged');
    assert.equal(second.comments, 1, 'and nothing more was written on the timeline');
    return first.refusal;
  }

  /** The control's half: the sweep starts the task's run on the forking machine and clears the refusal. */
  async function assertDispatchable(w: World, taskId: string) {
    attempts.delete(taskId);
    await sweep();
    const after = await state(taskId);
    assert.equal(attempts.get(taskId), 1, 'the sweep offered the task again');
    assert.equal(after.runs.length, 1, 'and its run was created');
    assert.equal(after.runs[0]!.assignedRunnerId, w.runnerA, 'on the forking session’s machine');
    assert.equal(after.refusal, null, 'the run cleared the refusal');
  }

  await t.test('case 1: a code binding added to the project holding the forked task', async () => {
    const w = await seed('bound');
    const taskId = await forkedTask(w);
    const binding = await prisma.projectCodebase.create({
      data: {
        projectId: w.projectId, ownerId: w.ownerId, canonicalRepoUrl: 'https://github.com/acme/widgets',
        upstreamRef: 'refs/heads/main', integrationRef: 'refs/heads/main', refAuthority: 'REMOTE',
      },
      select: { id: true },
    });

    const refusal = await assertRefusedTwice(taskId, 'FORK_IN_BOUND_PROJECT', 'FORK_OUTSIDE_PROJECT');
    assert.deepEqual(refusal.placement, {
      assigneeId: w.workspaceA, runnerId: w.runnerA, projectId: w.projectId, codebaseId: binding.id,
    });

    // Control: the binding is removed, and the task is dispatchable again.
    await prisma.projectCodebase.delete({ where: { id: binding.id } });
    await assertDispatchable(w, taskId);
  });

  await t.test('case 2: the forked task’s workspace moved to another runner', async () => {
    const w = await seed('moved');
    const taskId = await forkedTask(w);
    await admin.query('UPDATE "workspace" SET "runner_id" = $2 WHERE "id" = $1', [w.workspaceA, w.runnerB]);

    const refusal = await assertRefusedTwice(taskId, 'FORK_SOURCE_NOT_REACHABLE', 'ASSIGN_ON_FORK_RUNNER');
    assert.deepEqual(refusal.placement, {
      assigneeId: w.workspaceA, runnerId: w.runnerB, projectId: w.projectId, codebaseId: null,
    });

    // Control: the workspace is moved back to the forking session's machine.
    await admin.query('UPDATE "workspace" SET "runner_id" = $2 WHERE "id" = $1', [w.workspaceA, w.runnerA]);
    await assertDispatchable(w, taskId);
  });
});
