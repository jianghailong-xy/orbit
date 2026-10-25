import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import {
  Prisma,
  PrismaClient,
  RunStatus,
  RunnerStatus,
  SessionDispatchOrigin,
  TaskStatus as PrismaTaskStatus,
} from '@prisma/client';
import { Client } from 'pg';

import { TaskStatus as DeclaredTaskStatus } from '@orbit/shared';

import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { QueueService } from '../queue/queue.service';
import { RealtimeService } from '../realtime/realtime.service';
import { SessionsService } from '../sessions/sessions.service';
import { TasksService } from '../tasks/tasks.service';
import { ProjectOpenItemEscalationService } from './open-item-escalation.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from './coordinator-pg-test-safety';
import { ProjectOpenItemService } from './project-open-item.service';

/**
 * The task → exception link and the progress clock (§4.6/§4.7 H4).
 *
 * This is deliberately a PostgreSQL spec: the validation is a write-path contract, the FK's
 * `SET NULL` is a database contract, and the escalation reader and sweep must share the same SQL.
 * A generic coordinator chat turn is not progress on an exception; an attached live fix is, and an
 * answered delivery takes the item up for a coordinator that is still up (revision 13).
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
  tasks: TasksService;
  sessions: SessionsService;
  openItems: ProjectOpenItemService;
  escalation: ProjectOpenItemEscalationService;
}

async function connect(): Promise<Stack> {
  await verifyDisposableDatabase();
  const db = prismaClientFor(URL!);
  const prisma = db as unknown as PrismaService;
  const realtime = new Proxy({}, { get: () => () => undefined }) as unknown as RealtimeService;
  const queue = { notifySessionQueued: () => undefined } as unknown as QueueService;
  const sessions = new SessionsService(prisma, queue, realtime);
  const openItems = new ProjectOpenItemService(prisma, sessions);
  const tasks = new TasksService(prisma, sessions, realtime, undefined, undefined, undefined, openItems);
  return { db, tasks, sessions, openItems, escalation: new ProjectOpenItemEscalationService(prisma) };
}

interface World {
  ownerId: string;
  workspaceId: string;
  projectId: string;
  coordinatorSessionId: string;
}

async function world(stack: Stack, label: string): Promise<World> {
  const { db } = stack;
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const coordinatorSessionId = randomUUID();
  await db.user.create({
    data: { id: ownerId, email: `${label}-${ownerId}@fix-link.invalid`, name: label, passwordHash: 'x' },
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
      lastHeartbeatAt: new Date(),
    },
  });
  await db.workspace.create({
    data: { id: workspaceId, ownerId, runnerId, name: `${label}-workspace`, enabled: true },
  });
  await db.session.create({
    data: {
      id: coordinatorSessionId,
      ownerId,
      creatorId: ownerId,
      workspaceId,
      assignedRunnerId: runnerId,
      title: `coordinator: ${label}`,
      prompt: `coordinator: ${label}`,
      provider: 'claude',
      status: RunStatus.AWAITING_INPUT,
      dispatchOrigin: SessionDispatchOrigin.USER,
      titleManagedByProject: true,
      numTurns: 1,
      startedAt: new Date(),
      runtimeSessionId: `runtime-${coordinatorSessionId}`,
    },
  });
  await db.conversationTurn.create({
    data: {
      sessionId: coordinatorSessionId,
      seq: 1,
      clientTurnId: SessionsService.initialTurnClientId(coordinatorSessionId),
      kind: 'message',
      content: `coordinator: ${label}`,
      status: 'ANSWERED',
    },
  });
  await db.project.create({
    data: {
      id: projectId,
      ownerId,
      title: `${label} project`,
      goal: 'fixes are explicit work',
      coordinatorEnabled: true,
      coordinatorWorkspaceId: workspaceId,
      coordinatorSessionId,
    },
  });
  await db.projectRuntime.upsert({ where: { projectId }, create: { projectId }, update: {} });
  return { ownerId, workspaceId, projectId, coordinatorSessionId };
}

async function failedItem(stack: Stack, w: World, label: string) {
  const task = await stack.tasks.create(w.ownerId, {
    title: `${label} source`,
    assigneeId: w.workspaceId,
    projectId: w.projectId,
  });
  await stack.tasks.update(w.ownerId, task.id, { status: DeclaredTaskStatus.FAILED });
  await stack.openItems.deliverForTasks([task.id]);
  return stack.db.projectOpenItem.findFirstOrThrow({
    where: { projectId: w.projectId, taskId: task.id, kind: 'TASK_FAILED', state: 'OPEN' },
  });
}

async function refusal(run: () => Promise<unknown>): Promise<{ code?: string; status: number }> {
  const error = await run().then(() => null, (value: unknown) => value);
  assert.ok(error && typeof error === 'object' && 'getResponse' in error, `expected a typed refusal: ${String(error)}`);
  const body = (error as { getResponse(): unknown; getStatus(): number }).getResponse();
  return {
    code: typeof body === 'object' && body !== null ? (body as { code?: string }).code : undefined,
    status: (error as unknown as { getStatus(): number }).getStatus(),
  };
}

async function makeDue(stack: Stack, itemId: string): Promise<void> {
  await stack.db.$executeRaw(Prisma.sql`
    UPDATE "project_open_item"
       SET "escalate_at" = now() - interval '1 minute'
     WHERE "id" = ${itemId}::uuid`);
  const rows = await stack.escalation.sweep();
  assert.ok(rows.some((row) => row.itemId === itemId), 'the due item was escalated');
}

async function ageItem(stack: Stack, itemId: string, ms: number): Promise<void> {
  const interval = Prisma.sql`${`${ms} milliseconds`}::interval`;
  await stack.db.$executeRaw(Prisma.sql`
    UPDATE "project_open_item"
       SET "waiting_since" = "waiting_since" - ${interval},
           "assigned_at" = "assigned_at" - ${interval},
           "escalate_at" = "escalate_at" - ${interval},
           "created_at" = "created_at" - ${interval}
     WHERE "id" = ${itemId}::uuid`);
  await stack.db.$executeRaw(Prisma.sql`
    UPDATE "project_open_item_delivery"
       SET "created_at" = "created_at" - ${interval},
           "returned_at" = "returned_at" - ${interval}
     WHERE "item_id" = ${itemId}::uuid`);
}

test('fix links validate every authority and are visible as handledBy', { skip, timeout: 180_000 }, async () => {
  const stack = await connect();
  try {
    const w = await world(stack, 'validation');
    const item = await failedItem(stack, w, 'validation');

    const missing = await refusal(() => stack.tasks.create(w.ownerId, {
      title: 'missing item', assigneeId: w.workspaceId, projectId: w.projectId,
      fixesOpenItemId: randomUUID(),
    }));
    assert.equal(missing.code, 'FIXES_OPEN_ITEM_NOT_FOUND');

    const wrongWriter = await refusal(() => stack.tasks.create(w.ownerId, {
      title: 'wrong writer', assigneeId: w.workspaceId, projectId: w.projectId,
      fixesOpenItemId: item.id,
    }));
    assert.equal(wrongWriter.code, 'FIXES_OPEN_ITEM_WRITER_REFUSED');

    const otherProjectId = randomUUID();
    await stack.db.project.create({
      data: { id: otherProjectId, ownerId: w.ownerId, title: 'other project', goal: 'separate goal' },
    });
    const mismatch = await refusal(() => stack.tasks.create(w.ownerId, {
      title: 'wrong project', assigneeId: w.workspaceId, projectId: otherProjectId,
      fixesOpenItemId: item.id,
    }));
    assert.equal(mismatch.code, 'FIXES_OPEN_ITEM_PROJECT_MISMATCH');

    const question = await stack.openItems.askOwner(w.ownerId, w.projectId, w.coordinatorSessionId, {
      question: 'which fix?', options: [{ label: 'one' }, { label: 'two' }], recommendedOption: 0,
      clientQuestionId: randomUUID(),
    });
    const wrongKind = await refusal(() => stack.tasks.create(w.ownerId, {
      title: 'question is not a fix target', assigneeId: w.workspaceId, projectId: w.projectId,
      fixesOpenItemId: question.itemId,
    }));
    assert.equal(wrongKind.code, 'FIXES_OPEN_ITEM_KIND_REFUSED');

    await makeDue(stack, item.id);
    const closed = await stack.openItems.resolveOpenItem(
      w.ownerId, w.projectId, item.id, { note: 'closed before fixing' }, { kind: 'OWNER' },
    );
    assert.equal(closed.state, 'RESOLVED');
    const closedRefusal = await refusal(() => stack.tasks.create(w.ownerId, {
      title: 'closed item', assigneeId: w.workspaceId, projectId: w.projectId,
      fixesOpenItemId: item.id,
    }));
    assert.equal(closedRefusal.code, 'FIXES_OPEN_ITEM_NOT_OPEN');

    // A fresh coordinator-owned item exercises the successful create, update and batch paths.
    const live = await failedItem(stack, w, 'live');
    const first = await stack.tasks.create(w.ownerId, {
      title: 'first concrete fix', assigneeId: w.workspaceId, projectId: w.projectId,
      fixesOpenItemId: live.id,
    }, undefined, w.coordinatorSessionId);
    const second = await stack.tasks.create(w.ownerId, {
      title: 'second concrete fix', assigneeId: w.workspaceId, projectId: w.projectId,
    });
    await stack.tasks.update(w.ownerId, second.id, { fixesOpenItemId: live.id }, w.coordinatorSessionId);
    const batch = await stack.tasks.createMany(w.ownerId, {
      tasks: [{
        title: 'batch concrete fix', assigneeId: w.workspaceId, projectId: w.projectId,
        fixesOpenItemId: live.id,
      }],
    }, undefined, w.coordinatorSessionId);
    assert.equal(batch.length, 1);

    const read = await stack.openItems.list(w.ownerId, w.projectId);
    const handled = read.withCoordinator.find((row) => row.itemId === live.id);
    assert.deepEqual(
      handled?.handledBy.map((task) => [task.taskId, task.title, task.state]),
      [
        [first.id, 'first concrete fix', 'OPEN'],
        [second.id, 'second concrete fix', 'OPEN'],
        [batch[0]!.id, 'batch concrete fix', 'OPEN'],
      ],
      'one exception can expose every concrete fixing task',
    );

    // The FK is intentionally nullable on deletion: deleting the item leaves all fixing work.
    await stack.db.projectOpenItem.delete({ where: { id: live.id } });
    const detached = await stack.db.task.findMany({
      where: { id: { in: [first.id, second.id, batch[0]!.id] } },
      select: { fixesOpenItemId: true },
      orderBy: { id: 'asc' },
    });
    assert.deepEqual(detached.map((task) => task.fixesOpenItemId), [null, null, null]);
  } finally {
    await stack.db.$disconnect();
  }
});

test('a live fix has no escalation deadline, then one quiet window after it ends does',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'progress');
      const item = await failedItem(stack, w, 'progress');
      const fix = await stack.tasks.create(w.ownerId, {
        title: 'running fix', assigneeId: w.workspaceId, projectId: w.projectId,
        fixesOpenItemId: item.id,
      }, undefined, w.coordinatorSessionId);
      await stack.db.task.update({ where: { id: fix.id }, data: { status: PrismaTaskStatus.IN_PROGRESS } });
      await ageItem(stack, item.id, 3 * 60 * 60 * 1_000);
      assert.deepEqual(await stack.escalation.sweep(), [], 'an in-progress fix suppresses the clock');
      const liveRead = await stack.openItems.list(w.ownerId, w.projectId);
      assert.equal(liveRead.withCoordinator.find((row) => row.itemId === item.id)?.escalateAt, null,
        'the reader agrees that an in-flight fix has no deadline');

      // End the fix and move its durable update instant back beyond one frozen window.
      await stack.db.task.update({ where: { id: fix.id }, data: { status: PrismaTaskStatus.CANCELLED } });
      await stack.db.$executeRaw(Prisma.sql`
        UPDATE "task" SET "updated_at" = now() - interval '3 hours' WHERE "id" = ${fix.id}::uuid`);
      const escalated = await stack.escalation.sweep();
      assert.ok(escalated.some((row) => row.itemId === item.id),
        'after the fix ends, one quiet window hands the item to the owner');
      assert.equal((await stack.db.projectOpenItem.findUniqueOrThrow({ where: { id: item.id } })).assignee, 'OWNER');
    } finally {
      await stack.db.$disconnect();
    }
  });

test('an answered delivery holds the item for its coordinator; unanswered, a generic chat turn does not',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'chat-clock');

      // Answered three hours ago by the conversation the project is coordinated from, which is still
      // up: taken up, so it has no deadline however long ago that was (§4.6, revision 13).
      const taken = await failedItem(stack, w, 'chat-clock-taken');
      const delivery = await stack.db.projectOpenItemDelivery.findFirstOrThrow({
        where: { itemId: taken.id, purpose: 'ITEM' },
        orderBy: { createdAt: 'desc' },
      });
      const delivered = await stack.db.conversationTurn.findFirstOrThrow({
        where: { sessionId: delivery.sessionId, clientTurnId: delivery.clientTurnId },
      });
      const old = new Date(Date.now() - 3 * 60 * 60 * 1_000);
      await stack.db.conversationTurn.update({
        where: { id: delivered.id },
        data: { deliveredAt: old, answeredAt: old, status: 'ANSWERED' },
      });
      await ageItem(stack, taken.id, 3 * 60 * 60 * 1_000);

      // Never answered, beside it — and the conversation's latest turn is a generic chat a moment ago.
      const unanswered = await failedItem(stack, w, 'chat-clock-unanswered');
      await ageItem(stack, unanswered.id, 3 * 60 * 60 * 1_000);
      const chat = await stack.sessions.createTurn(w.ownerId, w.coordinatorSessionId, {
        clientTurnId: randomUUID(), content: 'unrelated project chat', intent: 'NEXT_TURN',
      });
      await stack.db.conversationTurn.update({
        where: { id: chat.turnId },
        data: { deliveredAt: new Date(), answeredAt: new Date(), status: 'ANSWERED' },
      });

      const escalated = (await stack.escalation.sweep()).map((row) => row.itemId);
      assert.ok(!escalated.includes(taken.id), 'the coordinator that answered the delivery keeps the item');
      assert.ok(escalated.includes(unanswered.id),
        'generic chat neither takes an item up nor renews its delivery clock');
      const read = await stack.openItems.list(w.ownerId, w.projectId);
      assert.equal(read.withCoordinator.find((row) => row.itemId === taken.id)?.escalateAt, null,
        'the reader agrees that a taken-up item has no deadline');
    } finally {
      await stack.db.$disconnect();
    }
  });

test('the fix-link PostgreSQL target is explicitly disposable', { skip }, verifyDisposableDatabase);
