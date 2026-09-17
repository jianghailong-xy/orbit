import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { Prisma, PrismaClient, RunStatus, RunnerStatus, SessionDispatchOrigin } from '@prisma/client';
import { Client } from 'pg';

import { TaskStatus as DeclaredTaskStatus } from '@orbit/shared';

import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { QueueService } from '../queue/queue.service';
import { RealtimeService } from '../realtime/realtime.service';
import { SessionsService } from '../sessions/sessions.service';
import { TasksService } from '../tasks/tasks.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from './coordinator-pg-test-safety';
import { IntegrationSettings, configureProjectIntegration } from './project-integration-line';
import { ProjectOpenItemService } from './project-open-item.service';

/**
 * The one clock this contract adds (docs/project-integration-line-contract.md §4.6): an exception
 * item nobody handled inside its project's window becomes the account owner's.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/projects/exception-escalation.pg.spec.ts
 *
 * The clock acts ONLY on people. What it may write is the item's assignee; what it may not write is
 * anything that would start an agent working — a turn on a conversation, a session, a wake row — and
 * the third case below counts all three across the whole database rather than trusting the two
 * statements to have stayed as narrow as they read (X-E1).
 *
 * Items are opened by a product door (`TasksService.update` writing FAILED, §4.3 source E), never by
 * inserting an item row: an item this file built itself would prove the clock moves rows, not that it
 * moves the rows the platform actually opens, with the window the project actually carries.
 *
 * Elapsed time is expressed as data, not waited for: `age` moves an item's own timestamps back by a
 * duration, which is what "this was opened two hours ago" IS. Nothing else in these cases is
 * rewritten — the window each item carries stays the one its project froze into it at creation.
 *
 * The clock is loaded by a specifier the compiler does not resolve, so this file compiles and runs
 * against a tree that has no escalation service at all. There, `tick` escalates nothing and each case
 * fails on its own assertion — "the item is still the coordinator's" — rather than on a missing
 * import.
 *
 * Not destructive: every case owns freshly generated ids and asserts over its own project.
 */
const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

/** The default nobody configured: two hours (§4.1, migration 0278). */
const DEFAULT_WINDOW_SECONDS = 7_200;
/** A project that wants its exceptions back sooner — the shortest window the column accepts. */
const SHORT_WINDOW_SECONDS = 300;
const MINUTE = 60_000;

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
  prisma: PrismaService;
  tasks: TasksService;
  openItems: ProjectOpenItemService;
}

/** The production wiring over one client: the doors that open items, and the door that reads them. */
async function connect(): Promise<Stack> {
  await verifyDisposableDatabase();
  const db = prismaClientFor(URL!);
  const prisma = db as unknown as PrismaService;
  const realtime = new Proxy({}, { get: () => () => undefined }) as unknown as RealtimeService;
  const queue = { notifySessionQueued: () => undefined } as unknown as QueueService;
  const sessions = new SessionsService(prisma, queue, realtime);
  const openItems = new ProjectOpenItemService(prisma, sessions);
  const tasks = new TasksService(prisma, sessions, realtime, undefined, undefined, undefined, openItems);
  return { db, prisma, tasks, openItems };
}

/** What one tick of the clock reports having escalated. */
interface Escalated {
  itemId: string;
  projectId: string;
}

interface Clock {
  sweep(): Promise<Escalated[]>;
}

/**
 * One tick of the escalation clock, run here rather than waited for.
 *
 * The service is resolved through a variable specifier on purpose (see the header): a tree without
 * `open-item-escalation.service.ts` returns no clock, this returns no escalations, and the assertions
 * below say what that tree did not do.
 */
async function tick(prisma: PrismaService): Promise<Escalated[]> {
  const specifier = './open-item-escalation.service.js';
  let clock: Clock;
  try {
    const loaded = await import(specifier) as {
      ProjectOpenItemEscalationService: new (prisma: PrismaService) => Clock;
    };
    clock = new loaded.ProjectOpenItemEscalationService(prisma);
  } catch {
    return [];
  }
  return clock.sweep();
}

/** Said in every failure message, so a red names the tree it ran against rather than a bare `false`. */
const NO_CLOCK = 'no escalation clock in this tree (projects/open-item-escalation.service.ts)';

interface World {
  ownerId: string;
  runnerId: string;
  workspaceId: string;
  projectId: string;
  coordinatorSessionId: string;
}

/**
 * One project, coordinated from a live conversation between turns — the state an item is normally
 * opened into, and the only state from which an item is the coordinator's to escalate away from.
 */
async function world(stack: Stack, label: string): Promise<World> {
  const db = stack.db;
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const coordinatorSessionId = randomUUID();
  await db.user.create({
    data: { id: ownerId, email: `${label}-${ownerId}@escalation.invalid`, name: label, passwordHash: 'x' },
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
      goal: 'nothing waits on somebody who stopped reading',
      coordinatorEnabled: true,
      coordinatorWorkspaceId: workspaceId,
      coordinatorSessionId,
    },
  });
  await db.projectRuntime.upsert({ where: { projectId }, create: { projectId }, update: {} });
  return { ownerId, runnerId, workspaceId, projectId, coordinatorSessionId };
}

/**
 * The project's escalation window, written at the owner's own door (L5).
 *
 * A tree whose door does not take one leaves the project at its default, and the assertion after the
 * call reads the project rather than this call's outcome: the refusal is the evidence, not an error
 * this helper is entitled to hide from the case.
 */
async function setWindow(stack: Stack, w: World, seconds: number): Promise<string | null> {
  try {
    await stack.db.$transaction((tx) => configureProjectIntegration(tx, {
      ownerId: w.ownerId,
      projectId: w.projectId,
      settings: { exceptionEscalationSeconds: seconds } as unknown as IntegrationSettings,
    }));
    return null;
  } catch (error) {
    return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  }
}

function windowOf(stack: Stack, projectId: string): Promise<number> {
  return stack.db.project
    .findUniqueOrThrow({ where: { id: projectId }, select: { exceptionEscalationSeconds: true } })
    .then((row) => row.exceptionEscalationSeconds);
}

/** A task of this project, failed through `task_update` (§4.3 source E), and the item that opened. */
async function failedTask(stack: Stack, w: World, label: string): Promise<ItemRow> {
  const declared = await stack.tasks.create(w.ownerId, {
    title: `${label} ${randomUUID().slice(0, 8)}`,
    assigneeId: w.workspaceId,
    projectId: w.projectId,
  });
  await stack.tasks.update(w.ownerId, declared.id, { status: DeclaredTaskStatus.FAILED });
  const opened = (await items(stack.db, w.projectId)).filter((row) => row.taskId === declared.id);
  assert.equal(opened.length, 1, `${label}: one failure opens one item`);
  assert.equal(opened[0]!.assignee, 'COORDINATOR', `${label}: a new item is the coordinator's`);
  return opened[0]!;
}

interface ItemRow {
  id: string;
  kind: string;
  state: string;
  assignee: string;
  assigneeReason: string;
  taskId: string | null;
  waitingSince: Date;
  assignedAt: Date;
  escalateAt: Date | null;
  escalatedAt: Date | null;
}

async function items(db: PrismaClient, projectId: string): Promise<ItemRow[]> {
  return db.$queryRaw<ItemRow[]>(Prisma.sql`
    SELECT "id", "kind", "state", "assignee", "assignee_reason" AS "assigneeReason",
           "task_id" AS "taskId", "waiting_since" AS "waitingSince", "assigned_at" AS "assignedAt",
           "escalate_at" AS "escalateAt", "escalated_at" AS "escalatedAt"
      FROM "project_open_item"
     WHERE "project_id" = ${projectId}::uuid
     ORDER BY "created_at", "id"`);
}

async function reread(db: PrismaClient, item: ItemRow): Promise<ItemRow> {
  const [row] = await db.$queryRaw<ItemRow[]>(Prisma.sql`
    SELECT "id", "kind", "state", "assignee", "assignee_reason" AS "assigneeReason",
           "task_id" AS "taskId", "waiting_since" AS "waitingSince", "assigned_at" AS "assignedAt",
           "escalate_at" AS "escalateAt", "escalated_at" AS "escalatedAt"
      FROM "project_open_item" WHERE "id" = ${item.id}::uuid`);
  return row!;
}

/**
 * Move an item back in time by `ms`: it was opened that long ago, and its window started then.
 *
 * Every instant the item carries moves together, because they were all written from one `now` and a
 * row with only one of them moved is a row the platform never writes.
 */
async function age(db: PrismaClient, item: ItemRow, ms: number): Promise<void> {
  const back = Prisma.sql`${`${ms} milliseconds`}::interval`;
  await db.$executeRaw(Prisma.sql`
    UPDATE "project_open_item"
       SET "waiting_since" = "waiting_since" - ${back},
           "assigned_at" = "assigned_at" - ${back},
           "escalate_at" = "escalate_at" - ${back},
           "created_at" = "created_at" - ${back}
     WHERE "id" = ${item.id}::uuid`);
}

/** How long after it started waiting this item goes to the owner, as the row itself says. */
function frozenWindowMs(item: ItemRow): number {
  assert.ok(item.escalateAt, 'an item with the coordinator carries the moment it goes to the owner');
  return item.escalateAt!.getTime() - item.waitingSince.getTime();
}

/** What an agent would have been made to do. All of it, database-wide, not just this project's. */
interface AgentWork {
  turns: number;
  sessions: number;
  wakes: number;
  deliveries: number;
}

async function agentWork(db: PrismaClient): Promise<AgentWork> {
  const [row] = await db.$queryRaw<Array<{
    turns: bigint; sessions: bigint; wakes: bigint; deliveries: bigint;
  }>>(Prisma.sql`
    SELECT (SELECT count(*) FROM "conversation_turn") AS "turns",
           (SELECT count(*) FROM "session") AS "sessions",
           (SELECT count(*) FROM "project_coordinator_wake") AS "wakes",
           (SELECT count(*) FROM "project_open_item_delivery") AS "deliveries"`);
  return {
    turns: Number(row!.turns),
    sessions: Number(row!.sessions),
    wakes: Number(row!.wakes),
    deliveries: Number(row!.deliveries),
  };
}

test('an item unhandled for the default two hours escalates to the owner', { skip, timeout: 180_000 }, async () => {
  const stack = await connect();
  try {
    const w = await world(stack, 'default-window');
    assert.equal(await windowOf(stack, w.projectId), DEFAULT_WINDOW_SECONDS,
      'a project nobody configured waits two hours before an exception becomes the owner\'s');
    const item = await failedTask(stack, w, 'default-window');
    assert.equal(frozenWindowMs(item), DEFAULT_WINDOW_SECONDS * 1_000,
      'the window is frozen into the item when it is opened');

    const before = await stack.openItems.list(w.ownerId, w.projectId);
    assert.deepEqual(
      [before.needsYou.length, before.withCoordinator.map((row) => row.itemId)],
      [0, [item.id]],
      'until it is due, the item is the coordinator\'s and the owner is shown nothing',
    );

    await age(stack.db, item, 2 * 60 * MINUTE + MINUTE);
    const escalated = await tick(stack.prisma);

    const after = await reread(stack.db, item);
    assert.equal(after.assignee, 'OWNER',
      `two hours and one minute unhandled is the owner's — ${NO_CLOCK}, item still ${after.assignee}`);
    assert.equal(after.assigneeReason, 'ESCALATED', 'and the row says why it is theirs');
    assert.ok(after.escalatedAt, 'the moment it escalated is recorded');
    assert.ok(after.assignedAt.getTime() > item.assignedAt.getTime(),
      'the assignment moved, so a later delivery cannot replay the coordinator\'s turn key');
    assert.equal(after.state, 'OPEN', 'escalating an item does not settle it');
    assert.deepEqual(escalated.map((row) => row.itemId), [item.id],
      'the tick reports what it escalated, which is what the owner is notified about');

    const owner = await stack.openItems.list(w.ownerId, w.projectId);
    assert.deepEqual(
      [owner.needsYou.map((row) => row.itemId), owner.withCoordinator.length],
      [[item.id], 0],
      'the owner reads it in what needs them, and the coordinator group is empty',
    );
    assert.equal(owner.needsYou[0]!.assigneeReason, 'ESCALATED');
  } finally {
    await stack.db.$disconnect();
  }
});

test('a project-specific escalation time is honoured', { skip, timeout: 180_000 }, async () => {
  const stack = await connect();
  try {
    const w = await world(stack, 'short-window');
    const refusal = await setWindow(stack, w, SHORT_WINDOW_SECONDS);
    assert.equal(await windowOf(stack, w.projectId), SHORT_WINDOW_SECONDS,
      `the owner's door writes this project's escalation window${refusal ? ` — it refused: ${refusal}` : ''}`);

    const patient = await world(stack, 'default-beside-short');
    const short = await failedTask(stack, w, 'short-window');
    const long = await failedTask(stack, patient, 'default-beside-short');
    assert.equal(frozenWindowMs(short), SHORT_WINDOW_SECONDS * 1_000,
      'the item froze this project\'s window, not the default');
    assert.equal(frozenWindowMs(long), DEFAULT_WINDOW_SECONDS * 1_000);

    // Ten minutes: past the five-minute window one project set, nowhere near the default the other
    // kept. One tick, two projects, and the difference between them is the setting.
    await age(stack.db, short, 10 * MINUTE);
    await age(stack.db, long, 10 * MINUTE);
    const escalated = await tick(stack.prisma);

    const shortAfter = await reread(stack.db, short);
    const longAfter = await reread(stack.db, long);
    assert.equal(shortAfter.assignee, 'OWNER',
      `five minutes is this project's window and ten minutes passed — ${NO_CLOCK}`);
    assert.equal(shortAfter.assigneeReason, 'ESCALATED');
    assert.equal(longAfter.assignee, 'COORDINATOR',
      'the project beside it kept the two-hour default, and ten minutes is not two hours');
    assert.equal(longAfter.escalatedAt, null);
    assert.deepEqual(escalated.map((row) => row.itemId), [short.id],
      'one tick escalates every due item there is, and only the due ones');
  } finally {
    await stack.db.$disconnect();
  }
});

test('escalation writes no conversation_turn, session or wake row', { skip, timeout: 180_000 }, async () => {
  const stack = await connect();
  try {
    const w = await world(stack, 'people-only');
    const item = await failedTask(stack, w, 'people-only');
    await age(stack.db, item, 3 * 60 * MINUTE);

    const before = await agentWork(stack.db);
    const escalated = await tick(stack.prisma);
    const after = await agentWork(stack.db);

    assert.equal((await reread(stack.db, item)).assignee, 'OWNER',
      `the item did escalate, so what follows is measuring a tick that did something — ${NO_CLOCK}`);
    assert.deepEqual(escalated.map((row) => row.projectId), [w.projectId]);
    assert.deepEqual(after, before,
      'the clock acts on people: it writes the item\'s assignee and nothing an agent would run — '
      + `turns ${before.turns}→${after.turns}, sessions ${before.sessions}→${after.sessions}, `
      + `wakes ${before.wakes}→${after.wakes}, deliveries ${before.deliveries}→${after.deliveries}`);

    // A second tick has nothing left to escalate, so a clock that ran every minute for an hour would
    // notify the owner once.
    assert.deepEqual(await tick(stack.prisma), [], 'an escalated item escalates once');
    assert.deepEqual(await agentWork(stack.db), before);
  } finally {
    await stack.db.$disconnect();
  }
});

test('an item inside its window does not escalate', { skip, timeout: 180_000 }, async () => {
  const stack = await connect();
  try {
    const w = await world(stack, 'inside-window');
    const item = await failedTask(stack, w, 'inside-window');
    await age(stack.db, item, 2 * 60 * MINUTE - MINUTE);

    const escalated = await tick(stack.prisma);

    const after = await reread(stack.db, item);
    assert.deepEqual(
      [after.assignee, after.assigneeReason, after.escalatedAt, escalated.length],
      ['COORDINATOR', 'DEFAULT', null, 0],
      'one minute short of two hours is still the coordinator\'s: the clock waits for the window it '
      + 'was given rather than for a tick to come round',
    );
    assert.equal(after.assignedAt.getTime(), item.assignedAt.getTime() - (2 * 60 * MINUTE - MINUTE),
      'and nothing about the assignment was touched');
    const reader = await stack.openItems.list(w.ownerId, w.projectId);
    assert.deepEqual([reader.needsYou.length, reader.withCoordinator.length], [0, 1],
      'the owner is shown nothing they are not yet owed');
  } finally {
    await stack.db.$disconnect();
  }
});
