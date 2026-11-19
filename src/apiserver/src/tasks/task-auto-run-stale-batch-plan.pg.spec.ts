/**
 * The bulk Run's half of task-auto-run-stale-bound-plan.pg.spec.ts: an item of a bound press whose
 * create never produced its run, and no longer matches the task's pins, is planned again on a repeat
 * of the press rather than replayed for ever — and one whose run exists, or is being created, is not.
 *
 * A bulk Run binds one plan for the whole press (`TASK_BATCH_EXECUTE`, keyed by the press token),
 * each item naming its run after `batch:<press>:<task>`. An item refused as signed out leaves the
 * press unsettled with that plan BOUND, and every repeat of the press replayed the same refused
 * create whatever the task had been re-pinned to.
 *
 *   (1) the repro: an item planned on Claude, refused as signed out. A repeat with the pins unchanged
 *       keeps the plan (refused again, not re-planned); after a re-pin to Cursor the repeat plans the
 *       item afresh and starts its run on Cursor, under the same name.
 *   (2) an item whose run was already created is taken over after a re-pin, not replaced.
 *   (3) an item whose create is in flight (an older holder has the press row locked and is inserting
 *       its run) is taken over once that create commits, not replaced.
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
  const h: Harness = { db, tasks, logs: [] };
  (tasks as unknown as { logger: unknown }).logger = {
    log: (m: string) => h.logs.push(m),
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
    verbose: () => undefined,
  };
  return h;
}

/** An owner, an online runner with Cursor signed in, a workspace on it, and one runnable task with no pins. */
async function seed(db: PrismaClient, claudeAuth: 'yes' | 'no') {
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  await db.user.create({
    data: { id: ownerId, email: `stale-batch-${RUN}-${ownerId}@plan.invalid`, name: 'sb', passwordHash: 'x' },
  });
  await db.runner.create({
    data: {
      id: runnerId, ownerId, name: `mac-${RUN}`, tokenHash: `hash-${runnerId}`,
      status: RunnerStatus.ONLINE, capabilities: ['provider:claude', 'provider:cursor'], capabilitiesReportedAt: new Date(),
      lastHeartbeatAt: new Date(), maxConcurrent: 4, engines: engines(claudeAuth),
    },
  });
  await db.workspace.create({ data: { id: workspaceId, ownerId, runnerId, name: `ws-${RUN}`, enabled: true } });
  const taskId = randomUUID();
  // No engine and no provider pin: the run inherits the workspace's default, Claude Code.
  await db.task.create({
    data: {
      id: taskId, ownerId, assigneeId: workspaceId, title: `stale-batch-${RUN}`, creatorType: CreatorType.USER,
      creatorId: ownerId, completionCriterion: 'EVIDENCE_JUDGMENT', status: TaskStatus.OPEN,
      autoRunWhenReady: false, dispatchHold: false,
    },
  });
  return { ownerId, runnerId, workspaceId, taskId };
}

type BatchAnswer = {
  dispatched: number;
  results: Array<{ id: string; ok: boolean; sessionId?: string }>;
};

/** One delivery of the press: the owner's bulk Run over this one task. */
const press = (h: Harness, ownerId: string, taskId: string, token: string) =>
  h.tasks.batchExecute(ownerId, [taskId], undefined, token) as Promise<BatchAnswer>;

async function receiptOf(db: PrismaClient, ownerId: string, token: string) {
  const [row] = await db.$queryRaw<Array<{
    status: string;
    target: { items: Array<{ engine: string | null; kind: string; sessionId: string }> } | null;
    result: BatchAnswer | null;
  }>>`
    SELECT status, target, result FROM task_run_request
     WHERE owner_id = ${ownerId}::uuid AND action_kind = 'TASK_BATCH_EXECUTE' AND request_token = ${token}`;
  return row;
}

const replanned = (h: Harness) => h.logs.filter((m) => m.includes('planning it again'));

test('(1) a bulk Run item refused as signed out is kept while it matches the task, and re-planned on Cursor after a re-pin',
  { skip, timeout: 120_000 }, async () => {
    assertCoordinatorPgUrlIsIsolated(URL!);
    const h = connect();
    try {
      const { ownerId, taskId } = await seed(h.db, 'no');
      const token = randomUUID();

      // The press is planned with no engine (Claude Code by default), its create is refused, and
      // the press is left unsettled with its plan BOUND.
      await assert.rejects(press(h, ownerId, taskId, token));
      const bound = await receiptOf(h.db, ownerId, token);
      assert.equal(bound.status, 'BOUND');
      assert.equal(bound.target!.items.length, 1);
      assert.equal(bound.target!.items[0].kind, 'CREATE');
      assert.equal(bound.target!.items[0].engine, null);
      const sessionId = bound.target!.items[0].sessionId;
      assert.equal(await h.db.session.count({ where: { taskId } }), 0);

      // Pins unchanged: the repeat replays the plan as bound — refused again, nothing re-planned.
      await assert.rejects(press(h, ownerId, taskId, token));
      const kept = await receiptOf(h.db, ownerId, token);
      assert.equal(kept.status, 'BOUND');
      assert.deepEqual(kept.target, bound.target, 'a plan whose pins still match the task was rewritten');
      assert.deepEqual(replanned(h), [], 'a plan whose pins still match the task was re-planned');
      assert.equal(await h.db.session.count({ where: { taskId } }), 0);

      // Re-pinned to Cursor, signed in: the repeat plans the item afresh and starts it there.
      await h.db.task.update({ where: { id: taskId }, data: { engine: 'cursor' } });
      const answer = await press(h, ownerId, taskId, token);
      assert.equal(answer.dispatched, 1, JSON.stringify(answer));
      const runs = await h.db.session.findMany({ where: { taskId }, select: { id: true, engine: true } });
      assert.equal(runs.length, 1, 'expected exactly one run after the re-pin');
      assert.equal(runs[0].engine, 'cursor', 'the run was not started on the engine the task is pinned to');
      assert.equal(runs[0].id, sessionId, 'the re-planned item did not keep the name the press gave its run');
      assert.equal(answer.results[0].sessionId, sessionId);
      const done = await receiptOf(h.db, ownerId, token);
      assert.equal(done.status, 'COMPLETED');
      assert.equal(done.target!.items[0].engine, 'cursor');
      assert.equal(replanned(h).length, 1, JSON.stringify(h.logs));

      // A later repeat is answered from the frozen answer, with the same run.
      const repeat = await press(h, ownerId, taskId, token);
      assert.equal(repeat.results[0].sessionId, sessionId);
      assert.equal(await h.db.session.count({ where: { taskId } }), 1);
    } finally {
      await h.db.$disconnect();
    }
  });

test('(2) a bulk Run item whose run was already created is taken over after a re-pin, not replaced',
  { skip, timeout: 120_000 }, async () => {
    assertCoordinatorPgUrlIsIsolated(URL!);
    const h = connect();
    try {
      const { ownerId, taskId } = await seed(h.db, 'yes');
      const token = randomUUID();
      const first = await press(h, ownerId, taskId, token);
      assert.equal(first.dispatched, 1, JSON.stringify(first));
      const firstSession = first.results[0].sessionId!;
      // The holder that created the run died before freezing the answer: the press is BOUND again.
      await h.db.$executeRaw`
        UPDATE task_run_request SET status = 'BOUND', result = NULL, lease_holder = NULL, lease_expires_at = NULL
         WHERE owner_id = ${ownerId}::uuid AND action_kind = 'TASK_BATCH_EXECUTE' AND request_token = ${token}`;
      await h.db.task.update({ where: { id: taskId }, data: { engine: 'cursor' } });

      const again = await press(h, ownerId, taskId, token);
      assert.equal(again.dispatched, 1, JSON.stringify(again));
      assert.equal(again.results[0].sessionId, firstSession, 'the takeover answered with a different run');
      const runs = await h.db.session.findMany({ where: { taskId }, select: { id: true, engine: true } });
      assert.deepEqual(runs.map((r) => r.id), [firstSession], 'a second run was created');
      assert.equal(runs[0].engine, 'claude');
      const done = await receiptOf(h.db, ownerId, token);
      assert.equal(done.status, 'COMPLETED');
      assert.equal(done.target!.items[0].engine, null, 'a plan whose run exists was rewritten');
      assert.deepEqual(replanned(h), [], 'a plan whose run exists was re-planned');
    } finally {
      await h.db.$disconnect();
    }
  });

test('(3) a bulk Run item whose create is in flight is taken over once it commits, not replaced',
  { skip, timeout: 120_000 }, async () => {
    assertCoordinatorPgUrlIsIsolated(URL!);
    const h = connect();
    try {
      const { ownerId, workspaceId, taskId } = await seed(h.db, 'no');
      const token = randomUUID();
      await assert.rejects(press(h, ownerId, taskId, token));
      const bound = await receiptOf(h.db, ownerId, token);
      assert.equal(bound.status, 'BOUND');
      const sessionId = bound.target!.items[0].sessionId;
      await h.db.task.update({ where: { id: taskId }, data: { engine: 'cursor' } });

      // An older holder whose lease has just expired is mid-create: it has proved its fence
      // (`FOR UPDATE` on the press's row, as SessionsService.assertFenceHeld does) and is inserting
      // the item's run when the next delivery of the press arrives.
      const [{ attempt }] = await h.db.$queryRaw<Array<{ attempt: number }>>`
        UPDATE task_run_request
           SET lease_holder = 'older-holder', lease_expires_at = statement_timestamp() - interval '1 second',
               attempt = attempt + 1
         WHERE owner_id = ${ownerId}::uuid AND action_kind = 'TASK_BATCH_EXECUTE' AND request_token = ${token}
        RETURNING attempt`;
      let release!: () => void;
      const released = new Promise<void>((resolve) => { release = resolve; });
      let locked!: () => void;
      const lockTaken = new Promise<void>((resolve) => { locked = resolve; });
      const older = h.db.$transaction(async (tx) => {
        const held = await tx.$queryRaw<unknown[]>`
          SELECT attempt FROM task_run_request
           WHERE owner_id = ${ownerId}::uuid AND action_kind = 'TASK_BATCH_EXECUTE' AND request_token = ${token}
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
      const delivery = press(h, ownerId, taskId, token);
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      release();
      await older;
      const answer = await delivery;

      assert.equal(answer.dispatched, 1, JSON.stringify(answer));
      assert.equal(answer.results[0].sessionId, sessionId, 'the takeover answered with a different run');
      const runs = await h.db.session.findMany({ where: { taskId }, select: { id: true } });
      assert.deepEqual(runs.map((r) => r.id), [sessionId], 'the in-flight create was replaced by a second run');
      assert.equal((await receiptOf(h.db, ownerId, token)).status, 'COMPLETED');
      assert.deepEqual(replanned(h), [], 'a plan whose create was in flight was re-planned');
    } finally {
      await h.db.$disconnect();
    }
  });
