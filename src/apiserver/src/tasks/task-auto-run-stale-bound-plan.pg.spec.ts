/**
 * A bound start plan that never created its run, and no longer matches the task's pins, is planned
 * again rather than replayed for ever — and one whose run exists, or is being created, is not.
 *
 * On 2026-11-18 an auto-run task re-pinned to Cursor kept being started as Claude: its `dep:` run
 * request had been BOUND the day before with no engine (the project's Claude default), Claude Code
 * was signed out on the runner, so every create was refused and released with the plan kept. A pin
 * change does not move the dispatch epoch, so each sweep replayed the same refused plan (attempt 908)
 * and warned. The signed-out hold judged the task's current pins (Cursor, signed in) and let it
 * through, so the hold and the dispatch disagreed.
 *
 *   (1) the repro: a plan bound on Claude, refused as signed out, then the task re-pinned to Cursor.
 *       While the pins are unchanged the sweep holds it without a warning; after the re-pin the next
 *       sweep binds a fresh plan and starts the run on Cursor, without a warning.
 *   (2) a bound plan whose run was already created is taken over, not replaced, after a re-pin:
 *       the redelivery answers with that run, and no second run exists.
 *   (3) a bound plan whose create is in flight (an older holder has the request row locked and is
 *       inserting its run) is taken over once that create commits, not replaced.
 *
 * Destructive: it seeds rows, so it runs only against a disposable server.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { CreatorType, Prisma, PrismaClient, RunnerStatus, TaskStatus } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { prismaClientFor } from '../prisma/prisma-client';
import { assertCoordinatorPgUrlIsIsolated } from '../projects/coordinator-pg-test-safety';
import { QueueService } from '../queue/queue.service';
import { RealtimeService } from '../realtime/realtime.service';
import { SessionsService } from '../sessions/sessions.service';
import { TasksService } from './tasks.service';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;
const RUN = randomUUID().slice(0, 8);

const engines = (claudeAuth: 'yes' | 'no') =>
  [
    { engine: 'claude', installed: true, version: '2.0.0', auth: claudeAuth },
    { engine: 'cursor', installed: true, version: '1.0.0', auth: 'yes' },
  ] as unknown as Prisma.InputJsonValue;

interface Harness {
  db: PrismaClient;
  tasks: TasksService;
  logs: string[];
  warns: string[];
  dispatches: string[];
}

function connect(): Harness {
  const db = prismaClientFor(URL!);
  const prisma = db as unknown as PrismaService;
  const publishes = new Proxy({}, { get: () => () => undefined }) as unknown as RealtimeService;
  const sessions = new SessionsService(
    prisma,
    { notifySessionQueued: () => undefined } as unknown as QueueService,
    publishes,
  );
  const tasks = new TasksService(prisma, sessions, publishes);
  const h: Harness = { db, tasks, logs: [], warns: [], dispatches: [] };
  const inner = tasks as unknown as {
    logger: unknown;
    dispatchReadyTask(ownerId: string, taskId: string, epoch: bigint): Promise<unknown>;
  };
  inner.logger = {
    log: (m: string) => h.logs.push(m),
    warn: (m: string) => h.warns.push(m),
    error: (m: string) => h.warns.push(m),
    debug: () => undefined,
    verbose: () => undefined,
  };
  const dispatch = inner.dispatchReadyTask.bind(tasks);
  inner.dispatchReadyTask = (ownerId, taskId, epoch) => {
    h.dispatches.push(taskId);
    return dispatch(ownerId, taskId, epoch);
  };
  return h;
}

/** An owner, an online runner with Cursor signed in, a workspace on it, and one READY auto-run task with no pins. */
async function seed(db: PrismaClient, claudeAuth: 'yes' | 'no') {
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  await db.user.create({
    data: { id: ownerId, email: `stale-plan-${RUN}-${ownerId}@plan.invalid`, name: 'sp', passwordHash: 'x' },
  });
  await db.runner.create({
    data: {
      id: runnerId, ownerId, name: `mac-${RUN}`, tokenHash: `hash-${runnerId}`,
      status: RunnerStatus.ONLINE, capabilities: ['provider:claude', 'provider:cursor'], capabilitiesReportedAt: new Date(),
      lastHeartbeatAt: new Date(), maxConcurrent: 4, engines: engines(claudeAuth),
    },
  });
  await db.workspace.create({ data: { id: workspaceId, ownerId, runnerId, name: `ws-${RUN}`, enabled: true } });
  const done = randomUUID();
  await db.task.create({
    data: {
      id: done, ownerId, title: `prereq-${RUN}`, creatorType: CreatorType.USER, creatorId: ownerId,
      completionCriterion: 'EVIDENCE_JUDGMENT', status: TaskStatus.DONE, autoRunWhenReady: false, dispatchHold: false,
    },
  });
  const taskId = randomUUID();
  // No engine and no provider pin: the run inherits the workspace's default, Claude Code — as on production.
  await db.task.create({
    data: {
      id: taskId, ownerId, assigneeId: workspaceId, title: `stale-${RUN}`, creatorType: CreatorType.USER,
      creatorId: ownerId, completionCriterion: 'EVIDENCE_JUDGMENT', status: TaskStatus.OPEN,
      autoRunWhenReady: true, dispatchHold: false,
    },
  });
  await db.taskDependency.create({ data: { taskId, dependsOnTaskId: done } });
  return { ownerId, runnerId, workspaceId, taskId };
}

const sweep = (h: Harness) =>
  (h.tasks as unknown as { reconcileReadyTasks(): Promise<void> }).reconcileReadyTasks();

/** The dependency door the completion edge takes, which no hold stands in front of. */
const deliver = (h: Harness, ownerId: string, taskId: string, epoch: bigint) =>
  (h.tasks as unknown as {
    dispatchReadyTask(o: string, t: string, e: bigint): Promise<{ ok: boolean; sessionId?: string }>;
  }).dispatchReadyTask(ownerId, taskId, epoch);

async function epochOf(db: PrismaClient, taskId: string): Promise<bigint> {
  const [row] = await db.$queryRaw<Array<{ epoch: bigint }>>`
    SELECT epoch FROM task_dispatch_epoch WHERE task_id = ${taskId}::uuid`;
  return row.epoch;
}

async function receiptOf(db: PrismaClient, ownerId: string, taskId: string, epoch: bigint) {
  const [row] = await db.$queryRaw<Array<{
    status: string; target: { engine: string | null; plan: { kind: string; sessionId: string } } | null;
    result: { ok?: boolean; sessionId?: string } | null; attempt: number;
  }>>`
    SELECT status, target, result, attempt FROM task_run_request
     WHERE owner_id = ${ownerId}::uuid AND action_kind = 'TASK_EXECUTE'
       AND request_token = ${`dep:${taskId}:${epoch}`}`;
  return row;
}

const replanned = (h: Harness) => h.logs.filter((m) => m.includes('planning it again'));

test('(1) a bound plan refused as signed out is held while it matches the task, and re-planned on Cursor after a re-pin',
  { skip, timeout: 120_000 }, async () => {
    assertCoordinatorPgUrlIsIsolated(URL!);
    const h = connect();
    try {
      const { ownerId, taskId } = await seed(h.db, 'no');
      const epoch = await epochOf(h.db, taskId);

      // The completion edge delivers the moment while Claude Code is signed out: the plan is bound
      // with no engine, its create is refused, and the request is released BOUND.
      await assert.rejects(deliver(h, ownerId, taskId, epoch), /signed out/i);
      const bound = await receiptOf(h.db, ownerId, taskId, epoch);
      assert.equal(bound.status, 'BOUND');
      assert.equal(bound.target?.engine, null);
      assert.equal(await h.db.session.count({ where: { taskId } }), 0);

      // Pins unchanged: the plan is kept, and the hold judges it — held, no dispatch, no warning.
      h.dispatches.length = 0;
      await sweep(h);
      assert.deepEqual(h.dispatches, [], 'the sweep dispatched a kept plan that is signed out');
      assert.ok(h.logs.some((m) => m.includes('engine signed out on their runner')), JSON.stringify(h.logs));

      // Re-pinned to Cursor, signed in. A pin change does not move the moment.
      await h.db.task.update({ where: { id: taskId }, data: { engine: 'cursor' } });
      assert.equal(await epochOf(h.db, taskId), epoch, 'the re-pin moved the dispatch epoch');
      h.logs.length = 0;
      h.warns.length = 0;
      await sweep(h);
      await sweep(h);
      assert.deepEqual(h.warns.filter((m) => m.includes(taskId)), [],
        `the sweep replayed the refused plan: ${JSON.stringify(h.warns)}`);
      const runs = await h.db.session.findMany({ where: { taskId }, select: { id: true, engine: true } });
      assert.equal(runs.length, 1, 'expected exactly one run after the re-pin');
      assert.equal(runs[0].engine, 'cursor', 'the run was not started on the engine the task is pinned to');
      const done = await receiptOf(h.db, ownerId, taskId, epoch);
      assert.equal(done.status, 'COMPLETED');
      assert.equal(done.result?.sessionId, runs[0].id);
      assert.equal(replanned(h).length, 1, JSON.stringify(h.logs));
    } finally {
      await h.db.$disconnect();
    }
  });

test('(2) a bound plan whose run was already created is taken over after a re-pin, not replaced',
  { skip, timeout: 120_000 }, async () => {
    assertCoordinatorPgUrlIsIsolated(URL!);
    const h = connect();
    try {
      const { ownerId, taskId } = await seed(h.db, 'yes');
      const epoch = await epochOf(h.db, taskId);
      const first = await deliver(h, ownerId, taskId, epoch);
      assert.equal(first.ok, true);
      // The holder that created the run died before freezing the answer: the request is BOUND again.
      await h.db.$executeRaw`
        UPDATE task_run_request SET status = 'BOUND', result = NULL, lease_holder = NULL, lease_expires_at = NULL
         WHERE owner_id = ${ownerId}::uuid AND action_kind = 'TASK_EXECUTE'
           AND request_token = ${`dep:${taskId}:${epoch}`}`;
      await h.db.task.update({ where: { id: taskId }, data: { engine: 'cursor' } });

      const again = await deliver(h, ownerId, taskId, epoch);
      assert.equal(again.ok, true);
      assert.equal(again.sessionId, first.sessionId, 'the takeover answered with a different run');
      const runs = await h.db.session.findMany({ where: { taskId }, select: { id: true, engine: true } });
      assert.deepEqual(runs.map((r) => r.id), [first.sessionId], 'a second run was created');
      assert.equal(runs[0].engine, 'claude');
      assert.equal((await receiptOf(h.db, ownerId, taskId, epoch)).status, 'COMPLETED');
      assert.deepEqual(replanned(h), [], 'a plan whose run exists was re-planned');
    } finally {
      await h.db.$disconnect();
    }
  });

test('(3) a bound plan whose create is in flight is taken over once it commits, not replaced',
  { skip, timeout: 120_000 }, async () => {
    assertCoordinatorPgUrlIsIsolated(URL!);
    const h = connect();
    try {
      const { ownerId, workspaceId, taskId } = await seed(h.db, 'no');
      const epoch = await epochOf(h.db, taskId);
      const token = `dep:${taskId}:${epoch}`;
      await assert.rejects(deliver(h, ownerId, taskId, epoch), /signed out/i);
      const bound = await receiptOf(h.db, ownerId, taskId, epoch);
      const sessionId = bound.target!.plan.sessionId;
      await h.db.task.update({ where: { id: taskId }, data: { engine: 'cursor' } });

      // An older holder whose lease has just expired is mid-create: it has proved its fence
      // (`FOR UPDATE` on the request row, as SessionsService.assertFenceHeld does) and is inserting
      // the plan's run when the next delivery arrives.
      const [{ attempt }] = await h.db.$queryRaw<Array<{ attempt: number }>>`
        UPDATE task_run_request
           SET lease_holder = 'older-holder', lease_expires_at = statement_timestamp() - interval '1 second',
               attempt = attempt + 1
         WHERE owner_id = ${ownerId}::uuid AND action_kind = 'TASK_EXECUTE' AND request_token = ${token}
        RETURNING attempt`;
      let release!: () => void;
      const released = new Promise<void>((resolve) => { release = resolve; });
      let locked!: () => void;
      const lockTaken = new Promise<void>((resolve) => { locked = resolve; });
      const older = h.db.$transaction(async (tx) => {
        const held = await tx.$queryRaw<unknown[]>`
          SELECT attempt FROM task_run_request
           WHERE owner_id = ${ownerId}::uuid AND action_kind = 'TASK_EXECUTE' AND request_token = ${token}
             AND status = 'BOUND' AND lease_holder = 'older-holder' AND attempt = ${attempt}
           FOR UPDATE`;
        assert.equal(held.length, 1);
        await tx.session.create({
          data: {
            id: sessionId, ownerId, creatorId: ownerId, taskId, workspaceId, title: 'older holder',
            prompt: 'x', engine: 'claude', provider: 'claude',
          },
        });
        locked();
        await released;
      }, { timeout: 30_000 });
      await lockTaken;
      const delivery = deliver(h, ownerId, taskId, epoch);
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      release();
      await older;
      const answer = await delivery;

      assert.equal(answer.ok, true);
      assert.equal(answer.sessionId, sessionId, 'the takeover answered with a different run');
      const runs = await h.db.session.findMany({ where: { taskId }, select: { id: true } });
      assert.deepEqual(runs.map((r) => r.id), [sessionId], 'the in-flight create was replaced by a second run');
      assert.equal((await receiptOf(h.db, ownerId, taskId, epoch)).status, 'COMPLETED');
      assert.deepEqual(replanned(h), [], 'a plan whose create was in flight was re-planned');
    } finally {
      await h.db.$disconnect();
    }
  });
