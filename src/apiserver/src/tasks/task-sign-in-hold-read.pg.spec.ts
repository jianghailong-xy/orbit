/**
 * The task read and the project's Needs you say a task is held for a sign-in exactly when the auto-run
 * sweep holds it.
 *
 * On 2026-11-18 tasks on a Mac whose Claude Code was signed out sat "Ready" all day: the sweep held them
 * (signedOutGate) and said so only in its log. So the read carries the hold — `hold` on the task read and
 * on the paged list's rows, and one `signIns` row per runner and engine on the project's open items —
 * computed by the sweep's own rule (TasksService.signInHolds).
 *
 *   (1) signed out: the sweep holds both ready tasks; the read reports the hold on each, the list rows
 *       and the project page's rows too, and the project has one sign-in wait for the pair ("2 tasks wait for a sign-in"). A task
 *       the sweep does not offer at all (auto-run off) on the same runner reports no hold;
 *   (2) a heartbeat reports Claude Code signed in: the read reports no hold and the project's wait is
 *       gone, and the sweep after it starts the tasks.
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
import { establishProjectContractForPgTest } from '../projects/project-contract-test-helper';
import { ProjectOpenItemService } from '../projects/project-open-item.service';
import { ProjectsService } from '../projects/projects.service';
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
  openItems: ProjectOpenItemService;
  projects: ProjectsService;
  logs: string[];
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
  // The running server resolves TasksService through ModuleRef; this fixture hands it in.
  const openItems = new ProjectOpenItemService(prisma, sessions, undefined, undefined, undefined, tasks);
  const projects = new ProjectsService(prisma, undefined, sessions, publishes, openItems);
  const h: Harness = { db, tasks, openItems, projects, logs: [], dispatches: [] };
  const inner = tasks as unknown as {
    logger: unknown;
    dispatchReadyTask(ownerId: string, taskId: string, epoch: bigint): Promise<unknown>;
  };
  inner.logger = {
    log: (m: string) => h.logs.push(m),
    warn: () => undefined,
    error: () => undefined,
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

/** An owner, a runner reporting Claude Code signed out, a started project, two READY auto-run tasks and one manual. */
async function seed(db: PrismaClient) {
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  await db.user.create({
    data: { id: ownerId, email: `sign-in-hold-${RUN}-${ownerId}@hold.invalid`, name: 'so', passwordHash: 'x' },
  });
  await db.runner.create({
    data: {
      id: runnerId, ownerId, name: `mac-${RUN}`, tokenHash: `hash-${runnerId}`,
      status: RunnerStatus.ONLINE, capabilities: [], capabilitiesReportedAt: new Date(),
      lastHeartbeatAt: new Date(), maxConcurrent: 4, engines: claude('no'),
    },
  });
  await db.workspace.create({ data: { id: workspaceId, ownerId, runnerId, name: `ws-${RUN}`, enabled: true } });
  await db.project.create({
    data: {
      id: projectId, ownerId, title: `hold-${RUN}`, coordinatorEnabled: false, maxConcurrentTasks: 10,
      startedAt: new Date(),
    },
  });
  await establishProjectContractForPgTest(db, ownerId, projectId, `hold-${RUN}`);
  const done = randomUUID();
  await db.task.create({
    data: {
      id: done, ownerId, projectId, assigneeId: workspaceId, title: `prereq-${RUN}`, creatorType: CreatorType.USER,
      creatorId: ownerId, provider: 'claude', completionCriterion: 'EVIDENCE_JUDGMENT', status: TaskStatus.DONE,
      autoRunWhenReady: false, dispatchHold: false,
    },
  });
  const task = async (title: string, autoRunWhenReady: boolean) => {
    const id = randomUUID();
    await db.task.create({
      data: {
        id, ownerId, projectId, assigneeId: workspaceId, title: `${title}-${RUN}`, creatorType: CreatorType.USER,
        creatorId: ownerId, provider: 'claude', completionCriterion: 'EVIDENCE_JUDGMENT', status: TaskStatus.OPEN,
        autoRunWhenReady, dispatchHold: false,
      },
    });
    await db.taskDependency.create({ data: { taskId: id, dependsOnTaskId: done } });
    return id;
  };
  const first = await task('held-a', true);
  const second = await task('held-b', true);
  const manual = await task('manual', false);
  return { ownerId, runnerId, projectId, first, second, manual };
}

const sweep = (h: Harness) =>
  (h.tasks as unknown as { reconcileReadyTasks(): Promise<void> }).reconcileReadyTasks();

const heldLines = (h: Harness) => h.logs.filter((m) => m.includes('engine signed out on their runner'));

const holdOf = async (h: Harness, ownerId: string, taskId: string) =>
  ((await h.tasks.get(ownerId, taskId)) as { hold: unknown }).hold;

const rowHolds = async (h: Harness, ownerId: string, projectId: string) => {
  const page = (await h.tasks.listPage(ownerId, { projectId, counts: 'none' })) as {
    items: Array<{ id: string; hold: unknown }>;
  };
  return new Map(page.items.map((row) => [row.id, row.hold]));
};

/** The project page's own task rows (`GET /projects/:id/tasks/page`), where "Ready · automatic dispatch" was drawn. */
const projectRowHolds = async (h: Harness, ownerId: string, projectId: string) => {
  const page = (await h.projects.taskPage(ownerId, projectId)) as { items: Array<{ id: string; hold: unknown }> };
  return new Map(page.items.map((row) => [row.id, row.hold]));
};

test('the task read and the project report the sign-in hold exactly while the sweep holds the task',
  { skip, timeout: 120_000 }, async () => {
    assertCoordinatorPgUrlIsIsolated(URL!);
    const h = connect();
    try {
      const { ownerId, runnerId, projectId, first, second, manual } = await seed(h.db);
      const held = {
        kind: 'ENGINE_SIGNED_OUT', engine: 'claude', engineLabel: 'Claude Code', runnerId, runnerName: `mac-${RUN}`,
      };

      // (1) Signed out: the sweep holds both, and the read says so on each.
      await sweep(h);
      assert.deepEqual(h.dispatches.filter((id) => id === first || id === second), [], 'the sweep dispatched a held task');
      assert.equal(heldLines(h).length, 1, `expected one held line, got ${JSON.stringify(h.logs)}`);
      assert.match(heldLines(h)[0], new RegExp(`Claude Code on runner "mac-${RUN}" \\(2\\)`));
      assert.deepEqual(await holdOf(h, ownerId, first), held);
      assert.deepEqual(await holdOf(h, ownerId, second), held);
      // Not a sweep candidate (auto-run off), so the sweep holds nothing and neither does the read.
      assert.equal(await holdOf(h, ownerId, manual), null);
      const rows = await rowHolds(h, ownerId, projectId);
      assert.deepEqual(rows.get(first), held, 'the list row does not carry the hold');
      assert.deepEqual(rows.get(second), held);
      assert.equal(rows.get(manual), null);
      const projectRows = await projectRowHolds(h, ownerId, projectId);
      assert.deepEqual(projectRows.get(first), held, 'the project page row does not carry the hold');
      assert.deepEqual(projectRows.get(second), held);
      assert.equal(projectRows.get(manual), null);
      const items = await h.openItems.list(ownerId, projectId);
      assert.equal(items.signIns.length, 1, `expected one sign-in wait, got ${JSON.stringify(items.signIns)}`);
      const [wait] = items.signIns;
      assert.equal(wait.runnerId, runnerId);
      assert.equal(wait.engine, 'claude');
      assert.equal(wait.title, '2 tasks wait for a sign-in');
      assert.equal(wait.detailLine, `Claude Code is signed out on mac-${RUN}`);
      assert.deepEqual([...wait.taskIds].sort(), [first, second].sort());

      // (2) The runner's next heartbeat reports the sign-in: no hold on the read, no wait on the project,
      // and the sweep after it starts both.
      await h.db.runner.update({ where: { id: runnerId }, data: { engines: claude('yes'), lastHeartbeatAt: new Date() } });
      assert.equal(await holdOf(h, ownerId, first), null, 'still held after the sign-in');
      assert.equal(await holdOf(h, ownerId, second), null);
      const after = await rowHolds(h, ownerId, projectId);
      assert.equal(after.get(first), null);
      assert.equal(after.get(second), null);
      const projectAfter = await projectRowHolds(h, ownerId, projectId);
      assert.equal(projectAfter.get(first), null);
      assert.equal(projectAfter.get(second), null);
      assert.equal((await h.openItems.list(ownerId, projectId)).signIns.length, 0, 'the sign-in wait outlived the sign-in');
      h.logs.length = 0;
      await sweep(h);
      assert.deepEqual(heldLines(h), [], 'the sweep still holds after the sign-in');
      assert.deepEqual(
        h.dispatches.filter((id) => id === first || id === second).sort(), [first, second].sort(),
        'the sweep did not start the tasks after the sign-in',
      );
    } finally {
      await h.db.$disconnect();
    }
  });
