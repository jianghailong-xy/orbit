import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { ForbiddenException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import {
  PrismaClient,
  RunStatus,
  RunnerStatus,
  SessionDispatchOrigin,
  SessionRunSource,
  type Runner,
} from '@prisma/client';
import { TaskStatus } from '@orbit/shared';
import { Client } from 'pg';

import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { QueueService } from '../queue/queue.service';
import { RealtimeService } from '../realtime/realtime.service';
import { RunnerOrchestrationAuthorizer } from '../runner-api/runner-orchestration-authorizer';
import { RunnerProjectsController } from '../runner-api/runner-projects.controller';
import { SessionsService } from '../sessions/sessions.service';
import { TasksService } from '../tasks/tasks.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from './coordinator-pg-test-safety';
import { ProjectAcceptanceService } from './project-acceptance.service';
import { establishProjectContractForPgTest } from './project-contract-test-helper';
import { ProjectsService } from './projects.service';

/**
 * The agent's `ensure` door, against a real PostgreSQL.
 *
 * Every claim this door makes is a claim about ROWS: that a conversation which can still be
 * delivered to comes back untouched, that one which cannot is ended and swapped under §7.5's fixed
 * landing, that the generation the DATABASE advances on a rotation advanced exactly once, and that
 * a refusal left nothing behind. A hand-rolled double would agree with whatever this code does,
 * which is exactly what must not be assumed here.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/projects/project-coordinator-ensure.pg.spec.ts
 *
 * Destructive: COORDINATOR_PG_URL must pass coordinator-pg-test-safety and point at a disposable
 * database with all migrations applied. Run this spec alone; do not share its PostgreSQL target.
 *
 * The suite is the shapes this door has to tell apart, and the two a second reading would get
 * wrong are the ones it is really about: a conversation that has ENDED but whose runner is still
 * there is REUSE — an ended conversation is the record of everything decided in it — while one that
 * is over in a way no message can follow is replacement.
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
  sessions: SessionsService;
  tasks: TasksService;
  projects: ProjectsService;
  orchestration: RunnerOrchestrationAuthorizer;
  /** The real controller, so the orchestration gate is exercised rather than described. */
  controller: RunnerProjectsController;
}

function connect(): Stack {
  const db = prismaClientFor(URL!);
  const prisma = db as unknown as PrismaService;
  const realtime = new Proxy({}, { get: () => () => undefined }) as unknown as RealtimeService;
  // Every port these paths do not use answers as a proxy — the shape the other coordinator
  // fixtures use. `complete` signals a queue this world has no runner on.
  const queue = new Proxy({}, { get: () => () => undefined }) as unknown as QueueService;
  const sessions = new SessionsService(prisma, queue, realtime);
  const projects = new ProjectsService(prisma, new ProjectAcceptanceService(prisma), sessions);
  const orchestration = new RunnerOrchestrationAuthorizer(
    prisma,
    new JwtService({ secret: 'project-coordinator-ensure-pg' }),
  );
  return {
    db,
    sessions,
    tasks: new TasksService(prisma, sessions, realtime),
    projects,
    orchestration,
    controller: new RunnerProjectsController(
      projects,
      new ProjectAcceptanceService(prisma),
      {} as never,
      orchestration,
    ),
  };
}

/**
 * The conversation a project points at, by the facts `receiveBlockedReasonFor` reads.
 *
 * Defaulted to the reachable shape — live, on an online runner, and it has actually run — so each
 * case below names only the one fact it turns on.
 */
interface CoordinatorShape {
  status?: RunStatus;
  startedAt?: Date | null;
  completedAt?: Date | null;
  deletedAt?: Date | null;
  numTurns?: number;
  runtimeSessionId?: string | null;
  /**
   * §13.6 SU6: this conversation's own run was handed a task, and that task has since been
   * replaced. The one shape with an ordering of its own — see `world`.
   */
  retiredTask?: boolean;
  /** The runner this conversation (and its landing workspace) belongs to is offline. */
  offlineRunner?: boolean;
  /** The landing this project records cannot run a session at all. */
  landingDisabled?: boolean;
  /** A project that has never had a coordinator: no pointer, and no landing recorded either. */
  neverOpened?: boolean;
}

interface World {
  ownerId: string;
  runnerId: string;
  offlineRunnerId: string;
  actingSessionId: string;
  actingWorkspaceId: string;
  landingWorkspaceId: string;
  /** Null for a project that has never had one — see `neverOpened`. */
  coordinatorSessionId: string | null;
  projectId: string;
}

/**
 * One account, two runners, two workspaces, the acting session and the project under test.
 *
 * The acting session is the shape `orchestration.assert` demands of a caller — live, on this
 * runner, for an owner with orchestration on — and deliberately NOT the project's coordinator:
 * this door exists for an agent that has found the coordinator unreachable, and that agent is
 * normally a different conversation.
 *
 * The order is forced by the database twice over. The project's pointer at a conversation is
 * guarded (COORDINATOR_POINTER_INVALID), so the conversation exists before the write that names it;
 * and a task cannot be recorded as replaced while a live session is working on it
 * (TASK_RETIRED_WHILE_RUNNING, 0130), so `retiredTask` runs the session first, ends it the way a
 * runner does, and only then retires the task.
 */
async function world(
  stack: Stack,
  label: string,
  shape: CoordinatorShape = {},
): Promise<World> {
  const db = stack.db;
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const offlineRunnerId = randomUUID();
  const actingWorkspaceId = randomUUID();
  const landingWorkspaceId = randomUUID();
  const actingSessionId = randomUUID();
  const coordinatorSessionId = randomUUID();
  const projectId = randomUUID();

  await db.user.create({
    data: { id: ownerId, email: `${label}-${ownerId}@ensure.invalid`, name: label, passwordHash: 'x' },
  });
  await db.runner.create({
    data: {
      id: runnerId, ownerId, name: `${label}-runner`, tokenHash: `hash-${runnerId}`,
      status: RunnerStatus.ONLINE, lastHeartbeatAt: new Date(),
      capabilities: [], capabilitiesReportedAt: new Date(),
    },
  });
  await db.runner.create({
    data: {
      id: offlineRunnerId, ownerId, name: `${label}-dark-runner`, tokenHash: `hash-${offlineRunnerId}`,
      status: RunnerStatus.OFFLINE, lastHeartbeatAt: new Date(Date.now() - 3_600_000),
      capabilities: [], capabilitiesReportedAt: new Date(),
    },
  });
  await db.workspace.create({
    data: {
      id: actingWorkspaceId, ownerId, runnerId, name: `${label}-acting`, enabled: true,
    },
  });
  await db.workspace.create({
    data: {
      id: landingWorkspaceId, ownerId,
      runnerId: shape.offlineRunner ? offlineRunnerId : runnerId,
      name: `${label}-landing`, enabled: shape.landingDisabled !== true,
    },
  });
  await db.session.create({
    data: {
      id: actingSessionId, ownerId, creatorId: ownerId, workspaceId: actingWorkspaceId,
      assignedRunnerId: runnerId, title: `${label} acting`, prompt: `${label} acting`,
      provider: 'claude', status: RunStatus.AWAITING_INPUT, numTurns: 1,
      startedAt: new Date(), runtimeSessionId: `runtime-${actingSessionId}`,
      dispatchOrigin: SessionDispatchOrigin.USER, runSource: SessionRunSource.MANUAL,
    },
  });
  await db.project.create({
    data: {
      id: projectId, ownerId, title: `${label} 项目`, coordinatorEnabled: true,
      ...(shape.neverOpened ? {} : { coordinatorWorkspaceId: landingWorkspaceId }),
    },
  });
  await establishProjectContractForPgTest(db, ownerId, projectId, label);

  // A project nobody has opened one for borrows the workspace its own work runs in, so it needs
  // work: the door reads that off the tasks, not off a preference.
  if (shape.neverOpened) {
    await stack.tasks.create(ownerId, {
      title: `${label} 的一个任务`, projectId, assigneeId: landingWorkspaceId,
      autoRunWhenReady: false,
    });
  }

  // The replaced attempt, when this world has one: a task this project's coordinator ran, and the
  // task that took over from it. Both halves of the retirement are the door's own, because each is
  // refused on its own in the wrong order.
  let taskId: string | null = null;
  let successorId: string | null = null;
  if (shape.retiredTask) {
    const replaced = await stack.tasks.create(ownerId, {
      title: `${label} 被替换的尝试`, projectId, autoRunWhenReady: false,
    });
    const successor = await stack.tasks.create(ownerId, {
      title: `${label} 接手的尝试`, projectId, autoRunWhenReady: false,
    });
    taskId = replaced.id;
    successorId = successor.id;
  }

  if (!shape.neverOpened) {
    await db.session.create({
      data: {
        id: coordinatorSessionId, ownerId, creatorId: ownerId, workspaceId: landingWorkspaceId,
        assignedRunnerId: shape.offlineRunner ? offlineRunnerId : runnerId,
        title: `coordinator: ${label}`, prompt: `coordinator: ${label}`, provider: 'claude',
        status: shape.status ?? RunStatus.AWAITING_INPUT,
        startedAt: shape.startedAt === undefined ? new Date() : shape.startedAt,
        completedAt: shape.completedAt ?? null,
        deletedAt: shape.deletedAt ?? null,
        numTurns: shape.numTurns ?? 1,
        runtimeSessionId:
          shape.runtimeSessionId === undefined
            ? `runtime-${coordinatorSessionId}`
            : shape.runtimeSessionId,
        taskId,
        startsTaskWork: taskId != null,
        titleManagedByProject: true,
        dispatchOrigin: SessionDispatchOrigin.USER, runSource: SessionRunSource.MANUAL,
      },
    });
    await db.project.update({ where: { id: projectId }, data: { coordinatorSessionId } });
  }

  if (taskId && successorId) {
    // The run this conversation belonged to ends — written directly, because FAILED is not a
    // status a DTO can set and the runner is what writes it in production. It has to end BEFORE
    // the retirement, which 0130 refuses while a live session is working on the task.
    await db.session.update({
      where: { id: coordinatorSessionId },
      data: { status: RunStatus.FAILED },
    });
    await stack.tasks.update(ownerId, taskId, { status: TaskStatus.CANCELLED });
    await stack.tasks.update(ownerId, taskId, { supersededByTaskId: successorId });
  }

  return {
    ownerId, runnerId, offlineRunnerId, actingSessionId, actingWorkspaceId,
    landingWorkspaceId,
    // The id is generated either way, so it is reported as the pointer only where a row behind it
    // exists. A uuid no row answers to is exactly the kind of fixture lie the assertions then build
    // on unnoticed.
    coordinatorSessionId: shape.neverOpened ? null : coordinatorSessionId,
    projectId,
  };
}

/** Everything the door promises to leave alone, in one read: the pointer and the generation. */
async function coordination(db: PrismaClient, projectId: string) {
  const project = await db.project.findUniqueOrThrow({
    where: { id: projectId },
    select: {
      coordinatorSessionId: true,
      coordinatorWorkspaceId: true,
      runtime: { select: { coordinatorGeneration: true } },
    },
  });
  return {
    sessionId: project.coordinatorSessionId,
    workspaceId: project.coordinatorWorkspaceId,
    generation: project.runtime?.coordinatorGeneration ?? 0n,
  };
}

/** The conversation a project points at, for the worlds that have one — all but the never-opened. */
function standingSession(w: World): string {
  assert.ok(w.coordinatorSessionId, 'this world has no coordinator to point at');
  return w.coordinatorSessionId;
}

/** Every session this owner has, oldest first — the count a stray conversation shows up in. */
function sessionsOf(db: PrismaClient, ownerId: string) {
  return db.session.findMany({
    where: { ownerId },
    select: { id: true },
    orderBy: { createdAt: 'asc' },
  });
}

/** The door as the runner calls it, with a real credential for the acting session. */
async function ensure(stack: Stack, w: World) {
  return stack.controller.ensureCoordinator(
    { id: w.runnerId, ownerId: w.ownerId } as Runner,
    w.projectId,
    w.actingSessionId,
    await stack.orchestration.issue(w.runnerId, w.actingSessionId),
  );
}

test('a conversation that is alive is handed back and nothing at all is written',
  { skip, timeout: 120_000 }, async () => {
    await verifyDisposableDatabase();
    const stack = connect();
    try {
      const w = await world(stack, 'live');
      const before = await coordination(stack.db, w.projectId);
      assert.equal(before.generation, 0n, 'a project that has never rotated stands at generation 0');

      const answer = await ensure(stack, w);

      assert.equal(answer.created, false);
      assert.equal(answer.sessionId, standingSession(w));
      assert.equal(answer.workspaceId, w.landingWorkspaceId);
      assert.equal(answer.replacedSessionId, undefined, 'nothing was replaced, so nothing is named');
      assert.deepEqual(await coordination(stack.db, w.projectId), before);
      // Two conversations: the one that asked and the one it is talking about. No third.
      assert.equal((await sessionsOf(stack.db, w.ownerId)).length, 2);
      const standing = await stack.db.session.findUniqueOrThrow({
        where: { id: standingSession(w) },
        select: { completedAt: true },
      });
      assert.equal(standing.completedAt, null, 'a live conversation must not be completed by a read');
    } finally {
      await stack.db.$disconnect();
    }
  });

test('an ENDED conversation its runner can still revive is reused, not replaced',
  { skip, timeout: 120_000 }, async () => {
    await verifyDisposableDatabase();
    const stack = connect();
    try {
      // Finished, not gone. This is the case a door reading "no engine turn is running" as
      // "unreachable" gets backwards, and backwards here means abandoning the record of everything
      // the project has decided.
      const completedAt = new Date(Date.now() - 60_000);
      const w = await world(stack, 'ended', { status: RunStatus.SUCCEEDED, completedAt });
      const before = await coordination(stack.db, w.projectId);

      const answer = await ensure(stack, w);

      assert.equal(answer.created, false);
      assert.equal(answer.sessionId, standingSession(w));
      assert.deepEqual(await coordination(stack.db, w.projectId), before);
      const standing = await stack.db.session.findUniqueOrThrow({
        where: { id: standingSession(w) },
        select: { completedAt: true },
      });
      assert.deepEqual(standing.completedAt, completedAt, 'the ended conversation was rewritten');
      assert.equal((await sessionsOf(stack.db, w.ownerId)).length, 2);
    } finally {
      await stack.db.$disconnect();
    }
  });

test('a conversation whose runner is offline is replaced, and the generation moves exactly once',
  { skip, timeout: 120_000 }, async () => {
    await verifyDisposableDatabase();
    const stack = connect();
    try {
      const w = await world(stack, 'offline', {
        status: RunStatus.SUCCEEDED,
        completedAt: new Date(Date.now() - 60_000),
        offlineRunner: true,
      });
      const before = await coordination(stack.db, w.projectId);

      const answer = await ensure(stack, w);

      assert.equal(answer.created, true);
      assert.equal(answer.replacedSessionId, standingSession(w));
      assert.equal(answer.replaceReason, 'RUNNER_OFFLINE');
      assert.notEqual(answer.sessionId, standingSession(w));
      const after = await coordination(stack.db, w.projectId);
      assert.equal(after.sessionId, answer.sessionId);
      // §7.5: the SESSION is replaced; the agent and the workspace are not. The landing cannot be
      // chosen here even though its runner is down — moving it is the owner's call, and this door
      // is not a way around that.
      assert.equal(after.workspaceId, w.landingWorkspaceId);
      assert.equal(after.generation, before.generation + 1n);
      const replacement = await stack.db.session.findUniqueOrThrow({
        where: { id: answer.sessionId },
        select: { workspaceId: true, completedAt: true, deletedAt: true },
      });
      assert.equal(replacement.workspaceId, w.landingWorkspaceId);
      assert.equal(replacement.completedAt, null);
      assert.equal(replacement.deletedAt, null);
    } finally {
      await stack.db.$disconnect();
    }
  });

test('a conversation that never ran is replaced', { skip, timeout: 120_000 }, async () => {
  await verifyDisposableDatabase();
  const stack = connect();
  try {
    const w = await world(stack, 'never-ran', {
      status: RunStatus.CANCELLED,
      startedAt: null,
      completedAt: new Date(Date.now() - 60_000),
      numTurns: 0,
      runtimeSessionId: null,
    });
    const before = await coordination(stack.db, w.projectId);

    const answer = await ensure(stack, w);

    assert.equal(answer.created, true);
    assert.equal(answer.replaceReason, 'NOT_STARTED');
    assert.equal(answer.replacedSessionId, standingSession(w));
    const after = await coordination(stack.db, w.projectId);
    assert.equal(after.sessionId, answer.sessionId);
    assert.equal(after.generation, before.generation + 1n);
  } finally {
    await stack.db.$disconnect();
  }
});

test('a conversation in Trash is replaced, and stays in Trash',
  { skip, timeout: 120_000 }, async () => {
    await verifyDisposableDatabase();
    const stack = connect();
    try {
      const w = await world(stack, 'trashed', { deletedAt: new Date() });
      const before = await coordination(stack.db, w.projectId);

      const answer = await ensure(stack, w);

      assert.equal(answer.created, true);
      assert.equal(answer.replaceReason, 'TRASHED');
      assert.equal(answer.replacedSessionId, standingSession(w));
      const after = await coordination(stack.db, w.projectId);
      assert.equal(after.sessionId, answer.sessionId);
      assert.equal(after.generation, before.generation + 1n);
      // Rotation away from a trashed conversation is rotation — not restoration, and not tidying:
      // the person who deleted it still deleted it, and the door must not edit that on the way past.
      const trashed = await stack.db.session.findUniqueOrThrow({
        where: { id: standingSession(w) },
        select: { deletedAt: true, completedAt: true },
      });
      assert.ok(trashed.deletedAt instanceof Date);
      assert.equal(trashed.completedAt, null);
    } finally {
      await stack.db.$disconnect();
    }
  });

test('a conversation whose run was replaced is replaced too, and the old one is completed',
  { skip, timeout: 120_000 }, async () => {
    await verifyDisposableDatabase();
    const stack = connect();
    try {
      // §13.6 SU6. Nothing on this row looks broken: it ended on its own and its runner is up, so
      // the capability fold calls it resumable. What it cannot do is be revived, because the run
      // belongs to an attempt that was taken over — the half `canSend` cannot see, and the only
      // shape here where the outgoing conversation has not been FILED as completed yet, so the
      // rotation's ending of it is observable rather than a no-op.
      const w = await world(stack, 'retired', { retiredTask: true });
      const before = await coordination(stack.db, w.projectId);
      const standingBefore = await stack.db.session.findUniqueOrThrow({
        where: { id: standingSession(w) },
        select: { completedAt: true, status: true },
      });
      assert.equal(standingBefore.completedAt, null, 'the fixture must not pre-complete the row');

      const answer = await ensure(stack, w);

      assert.equal(answer.created, true);
      assert.equal(answer.replaceReason, 'RUN_RETIRED');
      assert.equal(answer.replacedSessionId, standingSession(w));
      const after = await coordination(stack.db, w.projectId);
      assert.equal(after.sessionId, answer.sessionId);
      assert.equal(after.generation, before.generation + 1n);
      const outgoing = await stack.db.session.findUniqueOrThrow({
        where: { id: standingSession(w) },
        select: { completedAt: true },
      });
      assert.ok(
        outgoing.completedAt instanceof Date,
        'a conversation left behind by a rotation is completed, not merely unpointed at',
      );
    } finally {
      await stack.db.$disconnect();
    }
  });

test('a landing that cannot open refuses, and the conversation it would have ended survives',
  { skip, timeout: 120_000 }, async () => {
    await verifyDisposableDatabase();
    const stack = connect();
    try {
      // The landing refuses AND the source is unreachable, which is the one combination where the
      // order inside the rotation is visible: the landing is resolved before anything is ended, so
      // a project that cannot be given a new coordinator does not lose the one it has. A disabled
      // workspace is how an owner reaches this state without deleting anything.
      const w = await world(stack, 'unavailable', { retiredTask: true, landingDisabled: true });
      const before = await coordination(stack.db, w.projectId);
      const sessionsBefore = await sessionsOf(stack.db, w.ownerId);

      await assert.rejects(() => ensure(stack, w), (error: unknown) => {
        assert.ok(error instanceof Error, `expected a refusal, got ${String(error)}`);
        const response = (error as { getResponse?: () => Record<string, unknown> }).getResponse?.();
        assert.ok(response, `expected a structured refusal, got ${String(error)}`);
        assert.equal(response.code, 'COORDINATOR_UNAVAILABLE');
        // The field that says who can fix it — and it is not this session.
        assert.equal(response.owner, 'USER');
        return true;
      });

      assert.deepEqual(await coordination(stack.db, w.projectId), before);
      assert.equal(
        (await sessionsOf(stack.db, w.ownerId)).length,
        sessionsBefore.length,
        'a refusal opened a conversation',
      );
      const standing = await stack.db.session.findUniqueOrThrow({
        where: { id: standingSession(w) },
        select: { completedAt: true },
      });
      assert.equal(standing.completedAt, null, 'the outgoing conversation was ended by a refusal');
    } finally {
      await stack.db.$disconnect();
    }
  });

test('a project that has never had a coordinator gets its first one, where its work runs',
  { skip, timeout: 120_000 }, async () => {
    await verifyDisposableDatabase();
    const stack = connect();
    try {
      const w = await world(stack, 'never-opened', { neverOpened: true });
      assert.equal(w.coordinatorSessionId, null);

      const answer = await ensure(stack, w);

      assert.equal(answer.created, true);
      assert.equal(answer.replacedSessionId, undefined, 'a first coordinator replaces nothing');
      assert.equal(answer.workspaceId, w.landingWorkspaceId);
      const after = await coordination(stack.db, w.projectId);
      assert.equal(after.sessionId, answer.sessionId);
      assert.equal(after.workspaceId, w.landingWorkspaceId);
      // A FIRST coordinator is generation 0 — "the one this project has always had". Only swapping
      // one conversation for a different one spends a generation, and there was nothing to swap.
      assert.equal(after.generation, 0n);
    } finally {
      await stack.db.$disconnect();
    }
  });

test('without an orchestration credential the door refuses and opens nothing',
  { skip, timeout: 120_000 }, async () => {
    await verifyDisposableDatabase();
    const stack = connect();
    try {
      // A world where a permitted call WOULD write. Were the gate missing, this is the fixture that
      // would show it: a reachable source answers `created: false` and would prove nothing.
      const w = await world(stack, 'ungated', {
        status: RunStatus.SUCCEEDED,
        completedAt: new Date(Date.now() - 60_000),
        offlineRunner: true,
      });
      const before = await coordination(stack.db, w.projectId);
      const sessionsBefore = await sessionsOf(stack.db, w.ownerId);
      const runner = { id: w.runnerId, ownerId: w.ownerId } as Runner;
      const forAnotherRunner = await stack.orchestration.issue(w.offlineRunnerId, w.actingSessionId);
      const forAnUnknownSession = await stack.orchestration.issue(w.runnerId, randomUUID());

      const refusals: Array<[string, () => Promise<unknown>]> = [
        // No credential at all: the header the runner always sends, absent.
        ['no credential', () => stack.controller.ensureCoordinator(
          runner, w.projectId, w.actingSessionId, undefined,
        )],
        // A credential that is real but belongs to another machine. Binding the proof to a runner
        // is the whole reason a leaked one is not a skeleton key.
        ['another runner’s credential', () => stack.controller.ensureCoordinator(
          runner, w.projectId, w.actingSessionId, forAnotherRunner,
        )],
        // A credential for a session this runner is not running: the live-session predicate is the
        // half of the proof that revocation actually reaches.
        ['a session that is not the caller’s', () => stack.controller.ensureCoordinator(
          runner, w.projectId, randomUUID(), forAnUnknownSession,
        )],
      ];

      for (const [label, call] of refusals) {
        await assert.rejects(call, (error: unknown) => {
          assert.ok(
            error instanceof ForbiddenException,
            `${label}: expected a 403, got ${String(error)}`,
          );
          return true;
        });
      }

      assert.deepEqual(await coordination(stack.db, w.projectId), before);
      assert.equal(
        (await sessionsOf(stack.db, w.ownerId)).length,
        sessionsBefore.length,
        'a refused call opened a conversation',
      );
    } finally {
      await stack.db.$disconnect();
    }
  });
