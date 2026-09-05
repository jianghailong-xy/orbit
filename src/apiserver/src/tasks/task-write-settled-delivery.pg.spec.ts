import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import {
  CreatorType,
  PrismaClient,
  RunnerStatus,
  SessionDispatchOrigin,
  TaskStatus,
} from '@prisma/client';
import { Client } from 'pg';

import { TaskStatus as DeclaredTaskStatus } from '@orbit/shared';

import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { CompletionInputRouter } from '../projects/completion-input-router.service';
import { CoordinatorConvergenceService } from '../projects/coordinator-convergence.service';
import { CoordinatorJudgmentService } from '../projects/coordinator-judgment.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { CoordinatorWakeService } from '../projects/coordinator-wake.service';
import { CriterionReadyProducer } from '../projects/criterion-ready.producer';
import {
  ProjectTasksSettledProducer,
  SETTLED_WAKE_COORDINATOR_DISABLED,
  type SettledProjectDelivery,
} from '../projects/project-tasks-settled.producer';
import { TaskExceptionInputProducer } from '../projects/task-exception-input.producer';
import { QueueService } from '../queue/queue.service';
import { RealtimeService } from '../realtime/realtime.service';
import { SessionsService } from '../sessions/sessions.service';
import { completeHumanTaskForPgTest } from './task-completion-test-helper';
import { TasksService } from './tasks.service';

/**
 * The delivery a committed task write owes the coordinator, over the real write path and a real
 * ledger.
 *
 *   COORDINATOR_PG_URL=postgresql://... \
 *   COORDINATOR_PG_EXPECTED_DATABASE=pcc... \
 *   COORDINATOR_PG_EXPECTED_USER=pcc... \
 *   COORDINATOR_PG_EXPECTED_SYSTEM_IDENTIFIER=... \
 *   node --test build/tasks/task-write-settled-delivery.pg.spec.js
 *
 * Nothing below constructs the producer and calls it. That is the whole point: unit T7 has been
 * complete and tested against its own fixture since the day it was written, and the project it
 * belongs to still never woke a coordinator, because the only thing that ever called it was a
 * test. So every case here goes through `TasksService` — a task_update, the write a person or an
 * agent actually makes — and asks what the DATABASE says afterwards.
 *
 * The subject that reaches a terminal status does so through the product's own doors too: the
 * sibling that is already DONE went through 0193's verification fence (`completeHumanTaskForPgTest`),
 * and the task this write settles is CANCELLED by `TasksService.update` itself. Neither is a
 * status written around the fences into the table.
 */
const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

let safety: Promise<void> | undefined;
function verifyDisposableDatabase(): Promise<void> {
  if (safety) return safety;
  safety = (async () => {
    assertCoordinatorPgUrlIsIsolated(URL);
    const client = new Client({ connectionString: URL, connectionTimeoutMillis: 2_000 });
    await client.connect();
    try {
      await verifyCoordinatorPgIdentity(client);
    } finally {
      await client.end();
    }
  })();
  return safety;
}

interface Stack {
  db: PrismaClient;
  /** Built around whatever router the case wants, which is the only thing that varies here. */
  tasksWith: (router: CompletionInputRouter) => TasksService;
  router: CompletionInputRouter;
  /** Every `PROJECT_TASKS_SETTLED` outcome the router reported, in delivery order. */
  deliveries: SettledProjectDelivery[];
}

async function connect(): Promise<Stack> {
  await verifyDisposableDatabase();
  const db = prismaClientFor(URL!);
  const prisma = db as unknown as PrismaService;
  const realtime = new Proxy({}, { get: () => () => undefined }) as unknown as RealtimeService;
  const queue = { notifySessionQueued: () => undefined } as unknown as QueueService;
  const sessions = new SessionsService(prisma, queue, realtime);
  const real = new CompletionInputRouter(
    new CoordinatorWakeService(prisma),
    new ProjectTasksSettledProducer(
      prisma,
      new CoordinatorJudgmentService(prisma, new CoordinatorWakeService(prisma), sessions),
      new CoordinatorConvergenceService(prisma),
    ),
    new TaskExceptionInputProducer(prisma, new CoordinatorConvergenceService(prisma)),
    new CriterionReadyProducer(prisma, new CoordinatorConvergenceService(prisma)),
  );

  // The real router, observed rather than replaced: a Proxy that records what each delivery
  // ANSWERED and then hands the answer back. `NOT_SETTLED` and a refusal are outcomes the ledger
  // alone cannot always show — one of them writes no row at all — so the cases below assert both
  // what came back and what landed.
  const deliveries: SettledProjectDelivery[] = [];
  const router = new Proxy(real, {
    get(target, property, receiver) {
      if (property === 'routeSettledProjects') {
        return async (projectIds: ReadonlyArray<string | null | undefined>) => {
          const answered = await target.routeSettledProjects(projectIds);
          deliveries.push(...answered);
          return answered;
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });

  return {
    db,
    router,
    deliveries,
    tasksWith: (wired) => new TasksService(prisma, sessions, realtime, undefined, wired),
  };
}

interface Fixture {
  ownerId: string;
  workspaceId: string;
  projectId: string;
  taskIds: string[];
}

async function fixture(
  db: PrismaClient,
  label: string,
  taskCount: number,
  coordinatorEnabled = true,
): Promise<Fixture> {
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  await db.user.create({
    data: {
      id: ownerId,
      email: `${label}-${ownerId}@settled-delivery.invalid`,
      name: label,
      passwordHash: 'x',
    },
  });
  await db.runner.create({
    data: {
      id: runnerId,
      ownerId,
      name: `${label}-runner`,
      tokenHash: `hash-${runnerId}`,
      status: RunnerStatus.ONLINE,
      capabilities: [],
      capabilitiesReportedAt: new Date(),
    },
  });
  await db.workspace.create({
    data: { id: workspaceId, ownerId, runnerId, name: `${label}-workspace`, enabled: true },
  });
  await db.project.create({
    data: {
      id: projectId,
      ownerId,
      title: `${label} 唤醒项目`,
      coordinatorEnabled,
      coordinatorWorkspaceId: workspaceId,
    },
  });
  const taskIds = Array.from({ length: taskCount }, () => randomUUID());
  await db.task.createMany({
    data: taskIds.map((id, index) => ({
      id,
      ownerId,
      projectId,
      assigneeId: workspaceId,
      title: `${label} task ${index + 1}`,
      creatorType: CreatorType.USER,
      creatorId: ownerId,
      completionCriterion: 'EVIDENCE_JUDGMENT',
      status: TaskStatus.IN_PROGRESS,
    })),
  });
  return { ownerId, workspaceId, projectId, taskIds };
}

function settledWakes(db: PrismaClient, projectId: string) {
  return db.projectCoordinatorWake.findMany({
    where: { projectId, event: 'PROJECT_TASKS_SETTLED' },
    select: { id: true, projectId: true, status: true, refusalCode: true, sessionId: true },
    orderBy: { id: 'asc' },
  });
}

function judgmentSessions(db: PrismaClient, ownerId: string) {
  return db.session.findMany({
    where: { ownerId, dispatchOrigin: SessionDispatchOrigin.PROJECT_COORDINATOR, deletedAt: null },
    select: { id: true },
  });
}

test('the delivery is handed rows the transaction has already committed',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    // A second client, therefore a second connection pool. What it can see is what anybody outside
    // the writing transaction can see: if the delivery were made from inside `update`'s
    // transaction, this read would return the status the task had BEFORE the write, or block on
    // its row lock until the test timed out. Either way it could not observe CANCELLED.
    const outside = prismaClientFor(URL!);
    try {
      const target = await fixture(stack.db, 'settled-after-commit', 2);
      await completeHumanTaskForPgTest(
        stack.db, target.ownerId, target.taskIds[0]!, 'settled-after-commit:sibling',
      );

      const observed: Array<{ projectIds: readonly string[]; statuses: string[] }> = [];
      // A stub in the router's place: it does not deliver anything, it reports what the world
      // looked like at the moment the write path called it. Nothing is asserted inside it — a
      // throw here would be swallowed by the caller's own logging and the case would pass.
      const probe = {
        routeSettledProjects: async (projectIds: ReadonlyArray<string | null | undefined>) => {
          const named = projectIds.filter((id): id is string => !!id);
          const rows = await outside.task.findMany({
            where: { projectId: { in: named } },
            select: { status: true },
            orderBy: { id: 'asc' },
          });
          observed.push({ projectIds: named, statuses: rows.map((row) => row.status) });
          return [];
        },
        // The write path delivers its exception and criterion-readiness facts through the same
        // router. This case is about the settled door only, so the other two answer with nothing
        // rather than being absent — a double missing a method the subject calls fails for a
        // reason that is not the subject's.
        routeTaskExceptions: async () => [],
        routeReadyCriteria: async () => [],
      } as unknown as CompletionInputRouter;

      // `dependsOnTaskIds` puts this write on `update`'s interactive-transaction branch, which is
      // the branch where "inside or outside the transaction" is a real difference rather than an
      // autocommit statement that has already ended.
      await stack.tasksWith(probe).update(
        target.ownerId,
        target.taskIds[1]!,
        { status: DeclaredTaskStatus.CANCELLED, dependsOnTaskIds: [] },
      );

      assert.ok(observed.length > 0, 'the committed write delivered nothing to the router');
      assert.ok(
        observed.some((call) => call.projectIds.includes(target.projectId)),
        'the delivery did not name the project the write touched',
      );
      for (const call of observed) {
        assert.deepEqual(
          [...call.statuses].sort(),
          ['CANCELLED', 'DONE'],
          'the delivery ran before its own write was visible outside the transaction',
        );
      }
    } finally {
      await outside.$disconnect();
      await stack.db.$disconnect();
    }
  });

test('the last task reaching a terminal status writes exactly one settled wake',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      const target = await fixture(stack.db, 'settled-one-row', 2);
      await completeHumanTaskForPgTest(
        stack.db, target.ownerId, target.taskIds[0]!, 'settled-one-row:sibling',
      );
      assert.deepEqual(
        await settledWakes(stack.db, target.projectId), [],
        'one unfinished sibling is not a settled task set',
      );

      await stack.tasksWith(stack.router).update(
        target.ownerId, target.taskIds[1]!, { status: DeclaredTaskStatus.CANCELLED },
      );

      const wakes = await settledWakes(stack.db, target.projectId);
      assert.equal(wakes.length, 1, 'the settling write did not put one row in the ledger');
      assert.equal(wakes[0]!.projectId, target.projectId);
      assert.equal(wakes[0]!.status, 'SESSION_OPENED');
      assert.deepEqual(
        stack.deliveries, [{ projectId: target.projectId, outcome: 'OPENED' }],
      );
      // The consequence the ledger row is FOR, and the reason this is not a log: the fact opened
      // the one judgment session it gets, and the row names it.
      const sessions = await judgmentSessions(stack.db, target.ownerId);
      assert.equal(sessions.length, 1);
      assert.equal(wakes[0]!.sessionId, sessions[0]!.id);
    } finally {
      await stack.db.$disconnect();
    }
  });

test('a task set that is not finished delivers NOT_SETTLED and writes nothing',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      const target = await fixture(stack.db, 'settled-partial', 3);
      await completeHumanTaskForPgTest(
        stack.db, target.ownerId, target.taskIds[0]!, 'settled-partial:sibling',
      );

      // Two of three settled: the third is untouched and still IN_PROGRESS.
      await stack.tasksWith(stack.router).update(
        target.ownerId, target.taskIds[1]!, { status: DeclaredTaskStatus.CANCELLED },
      );

      assert.deepEqual(
        stack.deliveries, [{ projectId: target.projectId, outcome: 'NOT_SETTLED' }],
      );
      assert.deepEqual(await settledWakes(stack.db, target.projectId), []);
      assert.deepEqual(await judgmentSessions(stack.db, target.ownerId), []);
      assert.equal(
        (await stack.db.task.findUniqueOrThrow({ where: { id: target.taskIds[2]! } })).status,
        TaskStatus.IN_PROGRESS,
      );
    } finally {
      await stack.db.$disconnect();
    }
  });

test('delivering the same settled task set again adds no second row',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      const target = await fixture(stack.db, 'settled-redelivery', 2);
      await completeHumanTaskForPgTest(
        stack.db, target.ownerId, target.taskIds[0]!, 'settled-redelivery:sibling',
      );
      const tasks = stack.tasksWith(stack.router);
      await tasks.update(target.ownerId, target.taskIds[1]!, { status: DeclaredTaskStatus.CANCELLED });
      const afterFirst = await settledWakes(stack.db, target.projectId);
      assert.equal(afterFirst.length, 1);

      // A second write against the settled project. It changes no task's status, so it derives the
      // same closed fact, and the ledger's partial unique index — not a process-local guard — is
      // what stops the second wake.
      await tasks.update(target.ownerId, target.taskIds[1]!, { title: '同一个任务集，改个标题' });

      assert.deepEqual(await settledWakes(stack.db, target.projectId), afterFirst);
      assert.equal((await judgmentSessions(stack.db, target.ownerId)).length, 1);
      assert.deepEqual(stack.deliveries, [
        { projectId: target.projectId, outcome: 'OPENED' },
        { projectId: target.projectId, outcome: 'ALREADY_AWAKE' },
      ]);
    } finally {
      await stack.db.$disconnect();
    }
  });

test('a project whose coordinator is switched off wakes nobody',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      const target = await fixture(stack.db, 'settled-disabled', 2, false);
      await completeHumanTaskForPgTest(
        stack.db, target.ownerId, target.taskIds[0]!, 'settled-disabled:sibling',
      );

      await stack.tasksWith(stack.router).update(
        target.ownerId, target.taskIds[1]!, { status: DeclaredTaskStatus.CANCELLED },
      );

      // No judgment session, and no wake holding the fact's key. What IS written is the refusal
      // itself: T2 claims before it authorizes, so the row exists and says why it was released —
      // "it silently did nothing" is not a state this ledger can be in. The switch is read from
      // the project, so this is the same delivery as the case above with one column changed.
      assert.deepEqual(await judgmentSessions(stack.db, target.ownerId), []);
      const wakes = await settledWakes(stack.db, target.projectId);
      assert.equal(wakes.length, 1);
      assert.equal(wakes[0]!.status, 'REFUSED');
      assert.equal(wakes[0]!.refusalCode, SETTLED_WAKE_COORDINATOR_DISABLED);
      assert.equal(wakes[0]!.sessionId, null);
      assert.deepEqual(
        stack.deliveries, [{ projectId: target.projectId, outcome: 'REFUSED' }],
      );
    } finally {
      await stack.db.$disconnect();
    }
  });

test('the settled-delivery PostgreSQL target is explicitly disposable', { skip }, () => {
  assertCoordinatorPgUrlIsIsolated(URL);
});
