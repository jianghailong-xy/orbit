import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mock, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import { Prisma, PrismaClient, RunStatus, RunnerStatus, SessionDispatchOrigin } from '@prisma/client';
import { Client } from 'pg';

import {
  RunEventType,
  RunStatus as SharedRunStatus,
  TaskStatus as DeclaredTaskStatus,
} from '@orbit/shared';
import { HttpException } from '@nestjs/common';

import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { QueueService } from '../queue/queue.service';
import { RealtimeService } from '../realtime/realtime.service';
import { RunnerApiController } from '../runner-api/runner-api.controller';
import { SessionsService } from '../sessions/sessions.service';
import { TasksService } from '../tasks/tasks.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from './coordinator-pg-test-safety';
import { IntegrationSettings, configureProjectIntegration } from './project-integration-line';
import { readProjectListAttention } from './project-list-attention';
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
 * What the clock counts is the coordinator's silence, not the item's age (the last four cases): an
 * item stays the coordinator's while the conversation it was put on is still moving. So the
 * conversation's turns are the other half of every case's data, and they are written by the doors
 * that write them in production — the runner's claim, `dequeueTurn` handing a turn to the engine,
 * `turnComplete` ending it — and aged by `quiet`, on their own timeline, apart from the item's.
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
  sessions: SessionsService;
  tasks: TasksService;
  openItems: ProjectOpenItemService;
  /** The runner's side of a conversation: handing it its next turn, and ending that turn. */
  api: RunnerApiController;
}

/**
 * The production wiring over one client: the doors that open items, the door that reads them, and
 * the runner's doors onto the coordinator's conversation — a turn handed to an engine and a turn
 * ended are what the clock asks about a coordinator, and these are what write them. A turn ending
 * also hands over whatever the project still owes the conversation (§4.4 X-D4 3), which is why the
 * controller is given the same `openItems`.
 */
async function connect(): Promise<Stack> {
  await verifyDisposableDatabase();
  const db = prismaClientFor(URL!);
  const prisma = db as unknown as PrismaService;
  const realtime = new Proxy({}, { get: () => () => undefined }) as unknown as RealtimeService;
  const queue = { notifySessionQueued: () => undefined } as unknown as QueueService;
  const sessions = new SessionsService(prisma, queue, realtime);
  const openItems = new ProjectOpenItemService(prisma, sessions);
  const tasks = new TasksService(prisma, sessions, realtime, undefined, undefined, undefined, openItems);
  const api = new RunnerApiController(
    prisma,
    queue,
    realtime,
    new Proxy({}, { get: () => async () => undefined }) as never,
    {} as never,
    { expand: async (_ownerId: string, content?: string) => content } as never,
    { appendFor: async (_tx: unknown, _sessionId: string, content?: string) => content } as never,
    undefined,
    undefined,
    tasks,
    undefined,
    undefined,
    openItems,
  );
  return { db, prisma, sessions, tasks, openItems, api };
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

interface TimedClock {
  onModuleInit(): void;
  onModuleDestroy(): void;
}

/**
 * One tick of the clock as production runs it: on the interval the service installs for itself, with
 * `push` beside it as whoever tells people about items.
 *
 * Only time is mocked, and only `setInterval`: `mock.timers.tick` fires the callback the service
 * registered, so what the case then reads is what that callback did — the sweep it ran and every
 * call it made on `push`. The callback's work is asynchronous, so this waits (on real time) until
 * `settled()` holds or a bound passes; a tree whose tick did nothing leaves the assertions that
 * follow to say so.
 */
async function tickOnItsTimer(prisma: PrismaService, push: object, settled: () => boolean): Promise<void> {
  const specifier = './open-item-escalation.service.js';
  let clock: TimedClock;
  try {
    const loaded = await import(specifier) as {
      ProjectOpenItemEscalationService: new (prisma: PrismaService, push?: object) => TimedClock;
    };
    clock = new loaded.ProjectOpenItemEscalationService(prisma, push);
  } catch {
    return;
  }
  mock.timers.enable({ apis: ['setInterval'] });
  try {
    clock.onModuleInit();
    mock.timers.tick(60_000);
  } finally {
    clock.onModuleDestroy();
    mock.timers.reset();
  }
  for (let waited = 0; waited < 15_000 && !settled(); waited += 50) await sleep(50);
}

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
 * row with only one of them moved is a row the platform never writes. That includes the delivery
 * that put it on the coordinator's conversation, written in the same breath: the clock reads when
 * that happened, and an item opened two hours ago was put on its conversation two hours ago.
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
  await db.$executeRaw(Prisma.sql`
    UPDATE "project_open_item_delivery"
       SET "created_at" = "created_at" - ${back},
           "returned_at" = "returned_at" - ${back}
     WHERE "item_id" = ${item.id}::uuid`);
}

/**
 * The conversation has not moved for `ms`: every instant its turns carry — queued, handed, leased,
 * answered — goes back together, which is what "its last turn was that long ago" IS.
 *
 * Its own timeline, apart from the item's: an item waits on a conversation, and the clock reads both,
 * so a case says how long ago each of them last did anything.
 */
async function quiet(db: PrismaClient, sessionId: string, ms: number): Promise<void> {
  const back = Prisma.sql`${`${ms} milliseconds`}::interval`;
  await db.$executeRaw(Prisma.sql`
    UPDATE "conversation_turn"
       SET "created_at" = "created_at" - ${back},
           "delivered_at" = "delivered_at" - ${back},
           "lease_deadline_at" = "lease_deadline_at" - ${back},
           "answered_at" = "answered_at" - ${back}
     WHERE "session_id" = ${sessionId}::uuid`);
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

/**
 * The runner hands the coordinator's conversation its next turn, and the turn is left running.
 *
 * The claim first — an executable turn is handed only to a conversation its runner has put RUNNING —
 * and then the inbox's `dequeueTurn`, which is what writes `delivered_at`: the moment an engine had it.
 */
async function handTurn(stack: Stack, w: World): Promise<{ turnId: string; content: string }> {
  await stack.db.session.update({
    where: { id: w.coordinatorSessionId },
    data: { status: RunStatus.RUNNING },
  });
  const handed = await (stack.api as unknown as {
    dequeueTurn(
      sessionId: string,
      runnerId: string,
      leaseGeneration: string | null,
    ): Promise<{ turnId: string; content?: string } | null>;
  }).dequeueTurn(w.coordinatorSessionId, w.runnerId, null);
  assert.ok(handed, 'the coordinator had a turn waiting to be handed to it');
  return { turnId: handed.turnId, content: handed.content ?? '' };
}

/**
 * The coordinator takes its next turn and finishes it: handed to the engine, the engine answers, and
 * the runner reports the turn complete — which writes `answered_at`.
 */
async function takeTurn(stack: Stack, w: World): Promise<{ turnId: string; content: string }> {
  const handed = await handTurn(stack, w);
  const last = await stack.db.runEvent.aggregate({
    where: { sessionId: w.coordinatorSessionId },
    _max: { seq: true },
  });
  await stack.api.events({ id: w.runnerId }, w.coordinatorSessionId, {
    events: [{
      seq: (last._max.seq ?? 0) + 1,
      type: RunEventType.ASSISTANT,
      ts: new Date().toISOString(),
      turnId: handed.turnId,
      payload: { text: 'on it' },
    }],
  });
  await stack.api.turnComplete({ id: w.runnerId }, w.coordinatorSessionId, {
    turnId: handed.turnId,
    status: SharedRunStatus.SUCCEEDED,
  });
  const ended = await stack.db.conversationTurn.findUniqueOrThrow({
    where: { id: handed.turnId },
    select: { status: true },
  });
  assert.equal(ended.status, 'ANSWERED', 'the runner ended the turn it was handed');
  return handed;
}

/** The code a door refused with; undefined when it answered instead. */
async function refusalOf(run: () => Promise<unknown>): Promise<string | undefined> {
  const thrown = await run().then(() => undefined, (error: unknown) => error);
  if (thrown === undefined) return undefined;
  assert.ok(thrown instanceof HttpException, `the door failed rather than refusing: ${String(thrown)}`);
  const body = thrown.getResponse();
  return typeof body === 'object' && body !== null ? (body as { code?: string }).code : undefined;
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

/**
 * What the clock counts is the coordinator's silence, not the item's age (§4.6 X-E1).
 *
 * The case this was filed from (2026-09-23): five items delivered to a coordinator that was alive and
 * taking turns — its last one four minutes before the first of them came due — and every one of them
 * handed to the owner at exactly two hours, after which the conversation that had read them was
 * refused when it tried to close them (§4.7). The items' age said nobody had acted; the
 * conversation's turns said otherwise. An item the coordinator has in hand, and is still working
 * after, stays the coordinator's — and every reader says when it would stop being theirs.
 */
test('a coordinator that took the item and is still taking turns keeps it past its window',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'still-carrying');
      const item = await failedTask(stack, w, 'still-carrying');

      // The conversation is handed the turn that carries the item and ends it; then the owner asks it
      // something else, and it answers that too. It has the item, and it has not stopped.
      const took = await takeTurn(stack, w);
      assert.match(took.content, /Task failed: still-carrying/, 'the first turn it took is the item');
      await stack.sessions.createTurn(w.ownerId, w.coordinatorSessionId, {
        clientTurnId: randomUUID(),
        content: 'and the rest of the project?',
        intent: 'NEXT_TURN',
      });
      const latest = await takeTurn(stack, w);

      // Opened, and put on the conversation, two hours and one minute ago: the age at which the clock
      // that read only the item handed it to the owner.
      await age(stack.db, item, 2 * 60 * MINUTE + MINUTE);
      const escalated = await tick(stack.prisma);

      const after = await reread(stack.db, item);
      assert.deepEqual(
        [after.assignee, after.assigneeReason, after.escalatedAt],
        ['COORDINATOR', 'DEFAULT', null],
        'the conversation took this item and has taken turns since, so it is carrying it: the window '
        + `ran out on the item's age, not on the coordinator's silence — item is ${after.assignee}`,
      );
      assert.deepEqual(escalated.filter((row) => row.projectId === w.projectId), [],
        'nothing of this project\'s is reported, so its owner is told nothing');

      // Every reader says what the clock acts on: the coordinator's, and going to the owner one full
      // window after the conversation last moved — not "due" on a deadline that did not bite.
      const { answeredAt } = await stack.db.conversationTurn.findUniqueOrThrow({
        where: { id: latest.turnId },
        select: { answeredAt: true },
      });
      const goesAt = answeredAt!.getTime() + DEFAULT_WINDOW_SECONDS * 1_000;
      const reader = await stack.openItems.list(w.ownerId, w.projectId);
      assert.deepEqual(
        [reader.needsYou.length, reader.withCoordinator.map((row) => row.itemId)],
        [0, [item.id]],
        'the owner is shown nothing they are owed',
      );
      assert.equal(reader.withCoordinator[0]!.escalateAt?.getTime(), goesAt,
        'the card counts down from the conversation\'s last turn');
      const listed = (await readProjectListAttention(stack.prisma, w.ownerId)).get(w.projectId);
      assert.equal(listed?.coordinatorItems?.nextEscalationAt.getTime(), goesAt,
        'and so does the projects list');
    } finally {
      await stack.db.$disconnect();
    }
  });

/**
 * The guard on the other side, and the reason the clock exists at all: a conversation that has not
 * moved since the item was put on it is not carrying it, whatever it did before. This one was handed
 * a turn just before the failure and never came back from it, so the item's own turn is still queued
 * behind that one — never handed over. The item escalates exactly as it always did, and once it is
 * the owner's the conversation's press is the wrong one (§4.7): what changed is WHEN the clock hands
 * an item over, never what handing it over means.
 */
test('an item never handed to a coordinator stuck in an earlier turn escalates as before, and is then the owner\'s to close',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'stuck');
      await stack.sessions.createTurn(w.ownerId, w.coordinatorSessionId, {
        clientTurnId: randomUUID(),
        content: 'rebase the project branch onto main',
        intent: 'NEXT_TURN',
      });
      const stuck = await handTurn(stack, w);
      assert.match(stuck.content, /rebase the project branch/, 'the turn it is stuck in is the owner\'s');
      const item = await failedTask(stack, w, 'stuck');

      // That turn was handed a minute before the failure, and the failure was two hours and one
      // minute ago; nothing about the conversation has moved since.
      await quiet(stack.db, w.coordinatorSessionId, 2 * 60 * MINUTE + 2 * MINUTE);
      await age(stack.db, item, 2 * 60 * MINUTE + MINUTE);
      const waiting = await stack.openItems.list(w.ownerId, w.projectId);
      assert.deepEqual(
        waiting.withCoordinator.map((row) => [row.itemId, row.delivery.state]),
        [[item.id, 'QUEUED']],
        'the item is queued on the conversation, behind the turn it is stuck in',
      );

      const escalated = await tick(stack.prisma);

      const after = await reread(stack.db, item);
      assert.deepEqual([after.assignee, after.assigneeReason], ['OWNER', 'ESCALATED'],
        `a conversation that has not moved since the item was put on it is not carrying it — ${NO_CLOCK}`);
      assert.ok(escalated.some((row) => row.itemId === item.id),
        'and the tick reports it, which is what its owner is told about');

      assert.equal(
        await refusalOf(() => stack.openItems.resolveOpenItem(
          w.ownerId,
          w.projectId,
          item.id,
          { note: 'I am on it' },
          { kind: 'SESSION', sessionId: w.coordinatorSessionId },
        )),
        'OPEN_ITEM_NOT_COORDINATOR_ITEM',
        'an escalated item is the owner\'s, so the conversation it was taken from is refused',
      );
      assert.equal((await reread(stack.db, item)).state, 'OPEN', 'and the refusal closes nothing');
      const closed = await stack.openItems.resolveOpenItem(
        w.ownerId,
        w.projectId,
        item.id,
        { note: 'the coordinator is wedged; restarting it and re-running the task by hand' },
        { kind: 'OWNER' },
      );
      assert.deepEqual([closed.state, closed.resolution], ['RESOLVED', 'HANDLED'],
        'while the owner\'s own press closes it exactly as before');
    } finally {
      await stack.db.$disconnect();
    }
  });

/**
 * The same guard for a conversation that is gone. One that took the item and then ended carries
 * nothing, however recently it moved: its turns stop being evidence the moment it can take no more.
 */
test('a coordinator conversation that has ended carries nothing, however recently it moved',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'ended');
      const item = await failedTask(stack, w, 'ended');
      await takeTurn(stack, w);
      // Its owner files the conversation as Completed. The item had already been handed to it, so the
      // drain that gives queued items to the owner (§4.4 X-D5) has nothing to take back: the item is
      // still the coordinator's, on a conversation that is over.
      await stack.sessions.complete(w.ownerId, w.coordinatorSessionId);
      assert.equal((await reread(stack.db, item)).assignee, 'COORDINATOR',
        'ending the conversation left the item it had already read where it was');

      await age(stack.db, item, 2 * 60 * MINUTE + MINUTE);
      const escalated = await tick(stack.prisma);

      const after = await reread(stack.db, item);
      assert.deepEqual([after.assignee, after.assigneeReason], ['OWNER', 'ESCALATED'],
        `an ended conversation's last turn, a moment ago, is nobody carrying the item — ${NO_CLOCK}`);
      assert.ok(escalated.some((row) => row.itemId === item.id));
    } finally {
      await stack.db.$disconnect();
    }
  });

/**
 * Criterion 9's property, on the path this change added: the clock that now reads a conversation's
 * turns still writes nothing a conversation would run (§4.6 X-E1). The coordinator took the item and
 * then went quiet for a full window, so the item goes to the owner — on the service's own interval,
 * with a push beside it that records every call — and the whole database is counted either side.
 */
test('an item whose coordinator went quiet for a full window after taking it escalates, and only its owner is told',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'went-quiet');
      const item = await failedTask(stack, w, 'went-quiet');
      await takeTurn(stack, w);
      // Opened three hours ago and taken at once; the conversation's last turn ended two hours and one
      // minute ago, and nothing has moved since.
      await age(stack.db, item, 3 * 60 * MINUTE);
      await quiet(stack.db, w.coordinatorSessionId, 2 * 60 * MINUTE + MINUTE);

      const told: Array<{ method: string; args: unknown[] }> = [];
      const push = new Proxy({}, {
        get: (_target, method) => async (...args: unknown[]) => {
          told.push({ method: String(method), args });
        },
      });
      const before = await agentWork(stack.db);
      await tickOnItsTimer(stack.prisma, push, () => told.some((call) => call.args[0] === item.id));
      const after = await agentWork(stack.db);

      const now = await reread(stack.db, item);
      assert.deepEqual([now.assignee, now.assigneeReason], ['OWNER', 'ESCALATED'],
        'a full window without a turn after taking the item is a coordinator that stopped — '
        + `${NO_CLOCK}, item still ${now.assignee}`);
      assert.deepEqual(
        told.filter((call) => call.args[0] === item.id),
        [{ method: 'notifyOwnerItem', args: [item.id] }],
        'its owner is told, once',
      );
      assert.deepEqual([...new Set(told.map((call) => call.method))], ['notifyOwnerItem'],
        'and telling an owner about an item is all the tick says to anybody');
      assert.deepEqual(after, before,
        'nothing an agent would run — '
        + `turns ${before.turns}→${after.turns}, sessions ${before.sessions}→${after.sessions}, `
        + `wakes ${before.wakes}→${after.wakes}, deliveries ${before.deliveries}→${after.deliveries}`);
    } finally {
      await stack.db.$disconnect();
    }
  });
