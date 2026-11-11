/**
 * SR55 on real PostgreSQL: a task forked from the session that created it
 * (docs/task-fork-from-session-design.md §2.3, §2.4; docs/project-source-contract.md row PF).
 *
 * Through the production doors, end to end on the control plane's side: the runner's task create door
 * (`RunnerTasksController.createTask`, which is what `orbit mcp` will post the snapshot to), the session
 * create every run passes (`SessionsService.create`), the claim (`QueueService.claimSessionForRunner`)
 * and the pin (`freezeSessionSourcePin`). What is asserted:
 *
 *   - a forked task is claimed as `SESSION_FORK`, SHA-valued on the snapshot, `RUNNER_LOCAL`, with the
 *     forking session's runner as its authority, and pins that snapshot; its retry pins the same one;
 *   - it gets a branch on a workspace whose worktrees are off, where an ordinary task gets none;
 *   - FORK_SOURCE_NOT_REACHABLE, at the create door and again when a run would be placed elsewhere;
 *   - FORK_IN_BOUND_PROJECT, at the create door and again when the binding came after the task;
 *   - the five fork columns cannot be rewritten (0540's guard), and a fork is only ever of the caller.
 *
 * Destructive only for the rows it makes (one owner, deleted at the end). Run it the way every pg spec
 * runs: `scripts/run-pg-spec.sh src/apiserver/src/tasks/task-session-fork.pg.spec.ts`.
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
import { freezeSessionSourcePin } from '../projects/session-source';
import { QueueService } from '../queue/queue.service';
import { RunnerTasksController } from '../runner-api/runner-tasks.controller';
import { SessionsService } from '../sessions/sessions.service';
import { TasksService } from './tasks.service';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;
const SHA = (c: string) => c.repeat(40);
const SNAPSHOT = SHA('5');
const HEAD = SHA('4');

interface World {
  ownerId: string;
  /** The machine the forking session runs on, and the one its snapshot is in. */
  runnerA: string;
  runnerB: string;
  /** On runner A, worktrees OFF — the default for a new workspace. */
  workspaceA: string;
  /** On runner B. */
  workspaceB: string;
  /** The session the tasks are forked from: running on runner A, coordinating `projectId`. */
  forkingSessionId: string;
  /** A project with no code binding, which the forking session coordinates. */
  projectId: string;
}

/** The HTTP body a Nest exception carries, or null if `fn` did not throw. */
async function refusal(fn: () => Promise<unknown>): Promise<{ status: number; body: any } | null> {
  try {
    await fn();
  } catch (e: any) {
    return { status: typeof e?.getStatus === 'function' ? e.getStatus() : -1, body: e?.getResponse?.() ?? e?.message };
  }
  return null;
}

test('SR55: a task forked from its creating session', { skip, concurrency: 1, timeout: 180_000 }, async (t) => {
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

  const realtime = {
    publishTaskChanged: () => undefined,
    publishForUser: () => undefined,
    publishSessionCreated: () => undefined,
    publishSessionUpdated: () => undefined,
    publishWorkspaceChanged: () => undefined,
    notifyInbox: () => undefined,
  };
  const tasks = new TasksService(prisma as never, {} as never, realtime as never);
  const runnerDoor = new RunnerTasksController(tasks, {} as never, {} as never);
  const sessions = new SessionsService(prisma as never, { notifySessionQueued: () => undefined } as never, realtime as never);
  const queue = new QueueService(prisma as never, realtime as never);

  async function seed(label: string): Promise<World> {
    const w: World = {
      ownerId: randomUUID(),
      runnerA: randomUUID(),
      runnerB: randomUUID(),
      workspaceA: randomUUID(),
      workspaceB: randomUUID(),
      forkingSessionId: randomUUID(),
      projectId: randomUUID(),
    };
    owners.push(w.ownerId);
    await admin.query(
      `INSERT INTO "user" ("id","email","name","password_hash") VALUES ($1,$2,$3,'x')`,
      [w.ownerId, `${label}-${w.ownerId}@fork.invalid`, label],
    );
    for (const [id, name] of [[w.runnerA, 'a'], [w.runnerB, 'b']]) {
      await admin.query(
        // Room for more than one run: the forking session already holds a slot on runner A.
        `INSERT INTO "runner" ("id","owner_id","name","status","token_hash","last_heartbeat_at","max_concurrent")
         VALUES ($1,$2,$3,'ONLINE',$4,clock_timestamp(),4)`,
        [id, w.ownerId, `${label}-${name}`, `${label}-${id}`],
      );
    }
    for (const [id, runner, name] of [[w.workspaceA, w.runnerA, 'a'], [w.workspaceB, w.runnerB, 'b']]) {
      await admin.query(
        `INSERT INTO "workspace" ("id","owner_id","name","runner_id","work_dir","enable_worktree",
           "can_create_tasks","can_delegate")
         VALUES ($1,$2,$3,$4,$5,false,true,true)`,
        [id, w.ownerId, `${label}-ws-${name}`, runner, `/tmp/${label}-${name}`],
      );
    }
    await admin.query(
      `INSERT INTO "project" ("id","owner_id","title","coordinator_enabled","updated_at")
       VALUES ($1,$2,$3,true,now())`,
      [w.projectId, w.ownerId, `${label}-project`],
    );
    await admin.query(
      `INSERT INTO "project_runtime" ("project_id","updated_at") VALUES ($1,now()) ON CONFLICT ("project_id") DO NOTHING`,
      [w.projectId],
    );
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

  /** The runner door, as `orbit mcp` on runner `runnerId` in the forking session calls it. */
  function createForked(w: World, overrides: Record<string, unknown> = {}, runnerId = w.runnerA) {
    return runnerDoor.createTask(
      { id: runnerId, ownerId: w.ownerId } as never,
      w.workspaceA,
      undefined,
      w.forkingSessionId,
      {
        title: 'Finish the claim refactor',
        completionCriterion: 'EVIDENCE_JUDGMENT',
        assigneeId: w.workspaceA,
        fork: { sessionId: w.forkingSessionId, sha: SNAPSHOT, baseHead: HEAD, includesUncommitted: true },
        ...overrides,
      } as never,
    );
  }

  function startRun(w: World, taskId: string, workspaceId = w.workspaceA) {
    return sessions.create(w.ownerId, { prompt: 'do the task', workspaceId, taskId, title: 'Finish the claim refactor' } as never);
  }

  async function sessionRow(id: string) {
    return prisma.session.findUniqueOrThrow({
      where: { id },
      select: {
        branch: true, assignedRunnerId: true, sourceState: true, sourceKind: true, sourceRevisionSha: true,
        sourceRef: true, sourceRefAuthority: true, sourceCodebaseId: true, sourceBaseSha: true,
        sourceResolvedByRunnerId: true,
      },
    });
  }

  await t.test('a forked task is claimed as SESSION_FORK on the snapshot, and its retry pins the same commit', async () => {
    const w = await seed('claim');
    const task = await createForked(w) as { id: string };
    const stored = await prisma.task.findUniqueOrThrow({
      where: { id: task.id },
      select: {
        forkSessionId: true, forkRunnerId: true, forkSha: true, forkBaseHead: true, forkIncludesUncommitted: true,
        projectId: true,
      },
    });
    assert.deepEqual(stored, {
      forkSessionId: w.forkingSessionId, forkRunnerId: w.runnerA, forkSha: SNAPSHOT, forkBaseHead: HEAD,
      forkIncludesUncommitted: true, projectId: w.projectId,
    });

    // First run: frozen at create, claimed, pinned.
    const first = await startRun(w, task.id);
    const created = await sessionRow(first.id);
    assert.equal(created.sourceState, 'SELECTED');
    assert.equal(created.sourceKind, 'SESSION_FORK');
    assert.equal(created.sourceRevisionSha, SNAPSHOT);
    assert.equal(created.sourceRef, null);
    assert.equal(created.sourceRefAuthority, 'RUNNER_LOCAL');
    assert.equal(created.sourceCodebaseId, null);
    assert.equal(created.assignedRunnerId, w.runnerA, 'the run is placed on the forking session’s machine');

    const claimed = await queue.claimSessionForRunner({ id: w.runnerA } as never);
    assert.equal(claimed?.sessionId, first.id);
    assert.equal(claimed?.source?.state, 'SELECTED');
    assert.equal(claimed?.source?.kind, 'SESSION_FORK');
    assert.equal(claimed?.source?.revisionSha, SNAPSHOT);
    assert.equal(claimed?.source?.refAuthority, 'RUNNER_LOCAL');
    assert.equal(claimed?.source?.authorityRunnerId, w.runnerA, 'the authority is the forking session’s runner');
    assert.equal(claimed?.source?.repoUrl, undefined);
    assert.ok(claimed?.branch, 'the claim hands the runner a branch to make the worktree on');

    // The runner's half: a SHA-valued selector is its own answer (source.go resolveSourceSha).
    const pinned = await freezeSessionSourcePin(
      prisma as never,
      { sessionId: first.id, runnerId: w.runnerA, ownerId: w.ownerId },
      { baseSha: claimed!.source!.revisionSha! },
    );
    assert.equal(pinned.state, 'PINNED');
    assert.equal(pinned.baseSha, SNAPSHOT);
    const afterPin = await sessionRow(first.id);
    assert.equal(afterPin.sourceBaseSha, SNAPSHOT);
    assert.equal(afterPin.sourceResolvedByRunnerId, w.runnerA);

    // The attempt fails and the task is retried, carrying a known-good commit of its own. SR12: the
    // retry starts from the same snapshot — PF reads the task's create-time columns, not the attempt.
    await admin.query(
      `UPDATE "session" SET "status" = 'FAILED'::"run_status", "finished_at" = now() WHERE "id" = $1`,
      [first.id],
    );
    await admin.query(
      'UPDATE "task" SET "attempt_generation" = "attempt_generation" + 1, "known_good_sha" = $2 WHERE "id" = $1',
      [task.id, SHA('e')],
    );
    const retry = await startRun(w, task.id);
    assert.notEqual(retry.id, first.id);
    const retried = await sessionRow(retry.id);
    assert.equal(retried.sourceKind, 'SESSION_FORK');
    assert.equal(retried.sourceRevisionSha, SNAPSHOT, 'the retry froze the same snapshot');
    const reclaimed = await queue.claimSessionForRunner({ id: w.runnerA } as never);
    assert.equal(reclaimed?.sessionId, retry.id);
    assert.equal(reclaimed?.source?.revisionSha, SNAPSHOT);
    assert.equal(reclaimed?.source?.authorityRunnerId, w.runnerA);
    const retryPin = await freezeSessionSourcePin(
      prisma as never,
      { sessionId: retry.id, runnerId: w.runnerA, ownerId: w.ownerId },
      { baseSha: reclaimed!.source!.revisionSha! },
    );
    assert.equal(retryPin.state, 'PINNED');
    assert.equal(retryPin.baseSha, SNAPSHOT, 'the retry pinned the same commit');
  });

  await t.test('a forked task gets a branch on a workspace with worktrees off; an ordinary one does not', async () => {
    const w = await seed('branch');
    const forked = await createForked(w) as { id: string };
    const plain = await createForked(w, { title: 'Ordinary work', fork: undefined }) as { id: string };
    const forkRun = await sessionRow((await startRun(w, forked.id)).id);
    assert.ok(forkRun.branch, 'the forked run has its own branch although enableWorktree is off');
    assert.match(forkRun.branch!, /^orbit\//);
    const plainRun = await sessionRow((await startRun(w, plain.id)).id);
    assert.equal(plainRun.branch, null, 'the control: the same workspace gives an ordinary task no branch');
    assert.equal(plainRun.sourceState, 'UNBOUND');
  });

  await t.test('FORK_SOURCE_NOT_REACHABLE: an assignee on another machine, at create and at dispatch', async () => {
    const w = await seed('reach');
    const atCreate = await refusal(() => createForked(w, { assigneeId: w.workspaceB }));
    assert.equal(atCreate?.status, 409);
    assert.equal(atCreate?.body?.code, 'FORK_SOURCE_NOT_REACHABLE');
    assert.equal(atCreate?.body?.kind, 'REFUSAL');
    assert.equal(atCreate?.body?.requiredAction, 'ASSIGN_ON_FORK_RUNNER');
    assert.equal(atCreate?.body?.detail?.forkRunnerId, w.runnerA);
    assert.equal(atCreate?.body?.detail?.runnerId, w.runnerB);
    assert.equal(await prisma.task.count({ where: { ownerId: w.ownerId } }), 0, 'a refused create writes no task');

    // The task moved after it was filed: the run that would be placed on runner B is refused.
    const task = await createForked(w) as { id: string };
    await admin.query('UPDATE "task" SET "assignee_id" = $2 WHERE "id" = $1', [task.id, w.workspaceB]);
    const atDispatch = await refusal(() => startRun(w, task.id, w.workspaceB));
    assert.equal(atDispatch?.status, 409);
    assert.equal(atDispatch?.body?.code, 'FORK_SOURCE_NOT_REACHABLE');
    assert.equal(atDispatch?.body?.detail?.runnerId, w.runnerB);
    assert.equal(await prisma.session.count({ where: { taskId: task.id } }), 0, 'no run was created');

    // The batch door names the item.
    const batch = await refusal(() => runnerDoor.createTasks(
      { id: w.runnerA, ownerId: w.ownerId } as never, w.workspaceA, undefined, w.forkingSessionId,
      { tasks: [
        { title: 'fine', completionCriterion: 'EVIDENCE_JUDGMENT', assigneeId: w.workspaceA },
        {
          title: 'elsewhere', completionCriterion: 'EVIDENCE_JUDGMENT', assigneeId: w.workspaceB,
          fork: { sessionId: w.forkingSessionId, sha: SNAPSHOT, baseHead: HEAD, includesUncommitted: true },
        },
      ] } as never,
    ));
    assert.equal(batch?.status, 409);
    assert.equal(batch?.body?.code, 'FORK_SOURCE_NOT_REACHABLE');
    assert.equal(batch?.body?.itemIndex, 1);
  });

  await t.test('FORK_IN_BOUND_PROJECT: a project with a code binding, at create and after the binding came', async () => {
    const w = await seed('bound');
    // A task filed before the project had a binding is fine to file ...
    const early = await createForked(w) as { id: string };
    await prisma.projectCodebase.create({
      data: {
        projectId: w.projectId, ownerId: w.ownerId, canonicalRepoUrl: 'https://github.com/acme/widgets',
        upstreamRef: 'refs/heads/main', integrationRef: 'refs/heads/main', refAuthority: 'REMOTE',
      },
    });
    // ... and once the project is bound, a new fork into it is refused at the create door,
    const atCreate = await refusal(() => createForked(w, { title: 'Forked into a bound project' }));
    assert.equal(atCreate?.status, 409);
    assert.equal(atCreate?.body?.code, 'FORK_IN_BOUND_PROJECT');
    assert.equal(atCreate?.body?.requiredAction, 'FORK_OUTSIDE_PROJECT');
    assert.equal(atCreate?.body?.detail?.projectId, w.projectId);
    assert.equal(
      await prisma.task.count({ where: { ownerId: w.ownerId, title: 'Forked into a bound project' } }), 0,
    );
    // ... and the early one is refused when its run is created, rather than resolved by P5 (SR19).
    const atResolve = await refusal(() => startRun(w, early.id));
    assert.equal(atResolve?.status, 409);
    assert.equal(atResolve?.body?.code, 'FORK_IN_BOUND_PROJECT');
    assert.equal(await prisma.session.count({ where: { taskId: early.id } }), 0);
    // Both codes would hold: the project's is the one reported (SR55, project before machine).
    const both = await refusal(() => createForked(w, { assigneeId: w.workspaceB }));
    assert.equal(both?.body?.code, 'FORK_IN_BOUND_PROJECT');
  });

  await t.test('only the calling session, on its own runner, can be forked; and a fork is never rewritten', async () => {
    const w = await seed('caller');
    const other = randomUUID();
    await admin.query(
      `INSERT INTO "session" ("id","owner_id","workspace_id","assigned_runner_id","title","prompt","creator_id",
         "provider","status","dispatch_origin","updated_at")
       VALUES ($1,$2,$3,$4,'someone else','fixture',$2,'claude','RUNNING'::"run_status",
         'USER'::"session_dispatch_origin",now())`,
      [other, w.ownerId, w.workspaceA, w.runnerA],
    );
    const notMine = await refusal(() => createForked(w, {
      fork: { sessionId: other, sha: SNAPSHOT, baseHead: HEAD, includesUncommitted: true },
    }));
    assert.equal(notMine?.status, 403, 'D6: a session cannot fork another session');
    const wrongRunner = await refusal(() => createForked(w, {}, w.runnerB));
    assert.equal(wrongRunner?.status, 403, 'the calling session is one this runner credential is running');
    const lying = await refusal(() => createForked(w, {
      fork: { sessionId: w.forkingSessionId, sha: SNAPSHOT, baseHead: HEAD, includesUncommitted: false },
    }));
    assert.equal(lying?.status, 400, 'includesUncommitted is exactly sha != baseHead');
    // The browser door has no calling session at all.
    const owner = await refusal(() => tasks.create(w.ownerId, {
      title: 'owner fork', completionCriterion: 'EVIDENCE_JUDGMENT',
      fork: { sessionId: w.forkingSessionId, sha: SNAPSHOT, baseHead: HEAD, includesUncommitted: true },
    } as never));
    assert.equal(owner?.status, 403);

    const clean = await createForked(w, {
      fork: { sessionId: w.forkingSessionId, sha: HEAD, baseHead: HEAD, includesUncommitted: false },
    }) as { id: string };
    await assert.rejects(
      admin.query('UPDATE "task" SET "fork_sha" = $2 WHERE "id" = $1', [clean.id, SHA('6')]),
      /TASK_FORK_IMMUTABLE/,
    );
    await assert.rejects(
      admin.query('UPDATE "task" SET "fork_session_id" = NULL WHERE "id" = $1', [clean.id]),
      /TASK_FORK_IMMUTABLE/,
    );
    await assert.rejects(
      admin.query(
        `INSERT INTO "task" ("id","owner_id","title","creator_type","creator_id","completion_criterion",
           "fork_session_id","fork_runner_id","fork_sha","fork_base_head","fork_includes_uncommitted","updated_at")
         VALUES ($1,$2,'half','USER',$2,'EVIDENCE_JUDGMENT',$3,$4,$5,$5,true,now())`,
        [randomUUID(), w.ownerId, w.forkingSessionId, w.runnerA, HEAD],
      ),
      /task_fork_shape_chk/,
    );
  });
});
