/**
 * An auto-run task whose engine is signed out on its runner is held by the sweep, not retried.
 *
 * On 2026-11-17 two auto-run tasks on a Mac whose Claude Code was signed out were offered to
 * dispatch every minute for hours: `sessions.create` refused each with EngineSignedOutConflict and
 * the sweep logged `reconcile auto-run of task <id> failed: Claude Code is signed out ...` per task,
 * per pass (308 warnings in 2.5 hours). Nothing could change until somebody signed in on that Mac.
 *
 * So the sweep holds such a task before dispatch, the way it holds one on a runner short of disk:
 * counted, not dispatched, no per-task warning, one aggregate line naming the runner and the engine
 * — and the hold lifts on the sweep after the runner's next heartbeat reports the engine signed in.
 *
 *   (1) signed out: two sweeps, no dispatch attempt, no session, no warning, one held line each;
 *   (2) the same task, after a heartbeat reports Claude Code signed in: the next sweep starts it.
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

const claude = (auth: 'yes' | 'no') =>
  [{ engine: 'claude', installed: true, version: '2.0.0', auth }] as unknown as Prisma.InputJsonValue;

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
  // What the sweep says, and every dispatch it attempts.
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

/** An owner, an online runner reporting Claude Code signed out, a workspace on it, and one READY auto-run task. */
async function seed(db: PrismaClient) {
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  await db.user.create({
    data: {
      id: ownerId, email: `signed-out-${RUN}-${ownerId}@hold.invalid`, name: 'so', passwordHash: 'x',
      preferences: { defaultPermissionMode: 'default' },
    },
  });
  await db.runner.create({
    data: {
      id: runnerId, ownerId, name: `mac-${RUN}`, tokenHash: `hash-${runnerId}`,
      status: RunnerStatus.ONLINE, capabilities: [], capabilitiesReportedAt: new Date(),
      lastHeartbeatAt: new Date(), maxConcurrent: 4, engines: claude('no'),
      runtimeDefaultModels: { claude: 'claude-opus-5-5' },
      modelCatalog: { claude: [{ value: 'claude-opus-5-5', label: 'Opus 5.5', permissionModes: ['auto'] }] },
    },
  });
  await db.workspace.create({ data: { id: workspaceId, ownerId, runnerId, name: `ws-${RUN}`, enabled: true } });
  const done = randomUUID();
  await db.task.create({
    data: {
      id: done, ownerId, title: `prereq-${RUN}`, creatorType: CreatorType.USER, creatorId: ownerId,
      provider: 'claude', completionCriterion: 'EVIDENCE_JUDGMENT', status: TaskStatus.DONE,
      autoRunWhenReady: false, dispatchHold: false,
    },
  });
  const taskId = randomUUID();
  await db.task.create({
    data: {
      id: taskId, ownerId, assigneeId: workspaceId, title: `held-${RUN}`, creatorType: CreatorType.USER,
      creatorId: ownerId, provider: 'claude', completionCriterion: 'EVIDENCE_JUDGMENT', status: TaskStatus.OPEN,
      autoRunWhenReady: true, dispatchHold: false,
    },
  });
  await db.taskDependency.create({ data: { taskId, dependsOnTaskId: done } });
  return { runnerId, taskId };
}

const sweep = (h: Harness) =>
  (h.tasks as unknown as { reconcileReadyTasks(): Promise<void> }).reconcileReadyTasks();

const heldLines = (h: Harness) => h.logs.filter((m) => m.includes('engine signed out on their runner'));

test('a signed-out engine holds its auto-run task, then the dependency sweep stores and claims Auto after sign-in',
  { skip, timeout: 120_000 }, async () => {
    assertCoordinatorPgUrlIsIsolated(URL!);
    const h = connect();
    try {
      const { runnerId, taskId } = await seed(h.db);

      // (1) Two passes over a runner that reports Claude Code signed out.
      await sweep(h);
      await sweep(h);
      assert.deepEqual(h.dispatches.filter((id) => id === taskId), [],
        'the sweep attempted to dispatch a task its runner cannot start');
      assert.equal(await h.db.session.count({ where: { taskId } }), 0, 'a session was created');
      assert.deepEqual(h.warns.filter((m) => m.includes(taskId)), [],
        'the sweep still warns per task about a sign-in it already knows is missing');
      const held = heldLines(h);
      assert.equal(held.length, 2, `expected one held line per sweep, got ${JSON.stringify(h.logs)}`);
      assert.match(held[0], /1 ready task\(s\) held/);
      assert.match(held[0], new RegExp(`Claude Code on runner "mac-${RUN}" \\(1\\)`));

      // (2) The runner's next heartbeat reports the sign-in: the sweep after it starts the task.
      await h.db.runner.update({ where: { id: runnerId }, data: { engines: claude('yes'), lastHeartbeatAt: new Date() } });
      h.logs.length = 0;
      await sweep(h);
      assert.deepEqual(h.dispatches.filter((id) => id === taskId), [taskId], 'the sweep did not dispatch it after the sign-in');
      assert.equal(await h.db.session.count({ where: { taskId } }), 1, 'no run was created after the sign-in');
      const run = await h.db.session.findFirstOrThrow({ where: { taskId } });
      assert.equal(run.permissionMode, 'auto', 'the dependency sweep stored Auto despite the Default account preference');
      const realtime = new Proxy({}, { get: () => () => undefined }) as RealtimeService;
      const queue = new QueueService(h.db as unknown as PrismaService, realtime);
      const claim = await queue.claimSessionForRunner({ id: runnerId });
      assert.equal(claim?.sessionId, run.id);
      assert.equal(claim.agent.permissionMode, 'auto', 'the dependency sweep run claimed Auto');
      assert.deepEqual(heldLines(h), [], 'still reported held after the sign-in');
      assert.deepEqual(h.warns.filter((m) => m.includes(taskId)), []);
    } finally {
      await h.db.$disconnect();
    }
  });
