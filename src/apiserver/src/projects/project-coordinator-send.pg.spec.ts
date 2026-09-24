import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { ConflictException, ForbiddenException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import {
  PrismaClient,
  RunStatus,
  RunnerStatus,
  SessionDispatchOrigin,
  SessionRunSource,
  type Runner,
} from '@prisma/client';
import { Client } from 'pg';

import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { QueueService } from '../queue/queue.service';
import { RealtimeService } from '../realtime/realtime.service';
import { RunnerOrchestrationAuthorizer } from '../runner-api/runner-orchestration-authorizer';
import { RunnerProjectsController } from '../runner-api/runner-projects.controller';
import { SessionsService } from '../sessions/sessions.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from './coordinator-pg-test-safety';
import { ProjectAcceptanceService } from './project-acceptance.service';
import { establishProjectContractForPgTest } from './project-contract-test-helper';
import { COORDINATOR_MESSAGE_UNDELIVERED_CODE, ProjectsService } from './projects.service';

/**
 * The agent's `send` door, against a real PostgreSQL: a MESSAGE addressed to a PROJECT, resolved to
 * whichever conversation is coordinating it at the moment of delivery.
 *
 * Every claim this door makes is a claim about ROWS, and the two it would be easiest to get quietly
 * wrong are the ones this suite is really about:
 *
 *   * a rotation and the delivery are ONE call — the message that could not be delivered to the
 *     conversation the project named ends up on the conversation that replaced it, and the
 *     generation the DATABASE advances on a rotation advanced exactly once;
 *   * a conversation that can take the message is handed it WITHOUT being replaced — including one
 *     whose run has ended, where the delivery is a REVIVE (`resume`, i.e. `--resume-if-ended`) and
 *     not a rotation. A hand-rolled double would agree with whatever this code does, which is
 *     exactly what must not be assumed here.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/projects/project-coordinator-send.pg.spec.ts
 *
 * Destructive: COORDINATOR_PG_URL must pass coordinator-pg-test-safety and point at a disposable
 * database with all migrations applied. Run this spec alone; do not share its PostgreSQL target.
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
  projects: ProjectsService;
  orchestration: RunnerOrchestrationAuthorizer;
  /** The real controller, so the orchestration gate is exercised rather than described. */
  controller: RunnerProjectsController;
}

function connect(): Stack {
  const db = prismaClientFor(URL!);
  const prisma = db as unknown as PrismaService;
  const realtime = new Proxy({}, { get: () => () => undefined }) as unknown as RealtimeService;
  // Every port these paths do not use answers as a proxy — the shape the other coordinator fixtures
  // use. `complete` (a rotation ends the conversation it leaves behind) signals a queue no runner in
  // this world is listening on.
  const queue = new Proxy({}, { get: () => () => undefined }) as unknown as QueueService;
  const sessions = new SessionsService(prisma, queue, realtime);
  const projects = new ProjectsService(prisma, new ProjectAcceptanceService(prisma), sessions);
  const orchestration = new RunnerOrchestrationAuthorizer(
    prisma,
    new JwtService({ secret: 'project-coordinator-send-pg' }),
  );
  return {
    db,
    sessions,
    projects,
    orchestration,
    // No attempt service: the charge is not what these cases are about, and the hand-built
    // controller says so by leaving it absent — the same shape every other spec that builds this
    // controller by hand has.
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
 * case below names only the one fact it turns on. The status is what decides whether the delivery
 * REVIVES the conversation or writes to it directly, which is why the ended shapes set it explicitly.
 */
interface CoordinatorShape {
  status?: RunStatus;
  startedAt?: Date | null;
  completedAt?: Date | null;
  numTurns?: number;
  runtimeSessionId?: string | null;
  /** The runner this conversation (and its landing workspace) belongs to is offline. */
  offlineRunner?: boolean;
  /** The landing this project records cannot run a session at all. */
  landingDisabled?: boolean;
}

interface World {
  ownerId: string;
  runnerId: string;
  offlineRunnerId: string;
  actingSessionId: string;
  landingWorkspaceId: string;
  coordinatorSessionId: string;
  projectId: string;
}

/**
 * One account, two runners, two workspaces, the acting session and the project under test.
 *
 * The acting session is the shape `orchestration.assert` demands of a caller — live, on this
 * runner, in a workspace with orchestration on — and deliberately NOT the project's coordinator:
 * this door exists for an agent handing something to a coordinator, which is normally a different
 * conversation. A project is bound to its conversation only after that conversation exists
 * (COORDINATOR_POINTER_INVALID guards the pointer), which is the order below.
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
    data: { id: ownerId, email: `${label}-${ownerId}@send.invalid`, name: label, passwordHash: 'x' },
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
      enableOrchestration: true,
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
      coordinatorWorkspaceId: landingWorkspaceId,
    },
  });
  await establishProjectContractForPgTest(db, ownerId, projectId, label);
  await db.session.create({
    data: {
      id: coordinatorSessionId, ownerId, creatorId: ownerId, workspaceId: landingWorkspaceId,
      assignedRunnerId: shape.offlineRunner ? offlineRunnerId : runnerId,
      title: `coordinator: ${label}`, prompt: `coordinator: ${label}`, provider: 'claude',
      status: shape.status ?? RunStatus.AWAITING_INPUT,
      startedAt: shape.startedAt === undefined ? new Date() : shape.startedAt,
      completedAt: shape.completedAt ?? null,
      numTurns: shape.numTurns ?? 1,
      runtimeSessionId:
        shape.runtimeSessionId === undefined
          ? `runtime-${coordinatorSessionId}`
          : shape.runtimeSessionId,
      titleManagedByProject: true,
      dispatchOrigin: SessionDispatchOrigin.USER, runSource: SessionRunSource.MANUAL,
    },
  });
  await db.project.update({ where: { id: projectId }, data: { coordinatorSessionId } });

  return {
    ownerId, runnerId, offlineRunnerId, actingSessionId, landingWorkspaceId,
    coordinatorSessionId, projectId,
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

/** Every session this owner has, oldest first — the count a stray conversation shows up in. */
function sessionsOf(db: PrismaClient, ownerId: string) {
  return db.session.findMany({
    where: { ownerId },
    select: { id: true },
    orderBy: { createdAt: 'asc' },
  });
}

/** Every turn of one conversation, in delivery order. */
function turnsOf(db: PrismaClient, sessionId: string) {
  return db.conversationTurn.findMany({
    where: { sessionId },
    select: { seq: true, kind: true, content: true, clientTurnId: true, status: true },
    orderBy: { seq: 'asc' },
  });
}

/** Every turn this owner has anywhere — the count a delivery that should not have happened shows up
 *  in, including on a conversation this call opened. */
function turnsOwnedBy(db: PrismaClient, ownerId: string) {
  return db.conversationTurn.count({ where: { session: { ownerId } } });
}

/** The message under test, and the key it is written under. */
const MESSAGE = 'the landing on this criterion needs a merge decision — see the evidence comment';
const CLIENT_TURN_ID = randomUUID();

/** The door as the runner calls it, with a real credential for the acting session. */
async function send(
  stack: Stack,
  w: World,
  clientTurnId: string = CLIENT_TURN_ID,
) {
  return stack.controller.sendToCoordinator(
    { id: w.runnerId, ownerId: w.ownerId } as Runner,
    w.projectId,
    w.actingSessionId,
    await stack.orchestration.issue(w.runnerId, w.actingSessionId),
    { message: MESSAGE, clientTurnId },
  );
}

test('a conversation that can take a message is delivered to, and the coordination does not move',
  { skip, timeout: 120_000 }, async () => {
    await verifyDisposableDatabase();
    const stack = connect();
    try {
      const w = await world(stack, 'live');
      const before = await coordination(stack.db, w.projectId);
      assert.equal(before.generation, 0n, 'a project that has never rotated stands at generation 0');

      const answer = await send(stack, w);

      assert.equal(answer.created, false);
      assert.equal(answer.sessionId, w.coordinatorSessionId);
      assert.equal(answer.workspaceId, w.landingWorkspaceId);
      assert.equal(answer.replacedSessionId, undefined, 'nothing was replaced, so nothing is named');
      assert.equal(answer.replaceReason, undefined);
      assert.equal(answer.turn.clientTurnId, CLIENT_TURN_ID, 'the key is echoed: a retry can repeat it');
      assert.deepEqual(await coordination(stack.db, w.projectId), before);
      // Two conversations: the one that asked and the one it is talking to. No third.
      assert.equal((await sessionsOf(stack.db, w.ownerId)).length, 2);

      const turns = await turnsOf(stack.db, w.coordinatorSessionId);
      assert.equal(turns.length, 1);
      assert.equal(turns[0].content, MESSAGE);
      assert.equal(turns[0].clientTurnId, CLIENT_TURN_ID);
      assert.equal(turns[0].kind, 'message');
    } finally {
      await stack.db.$disconnect();
    }
  });

test('an ENDED conversation its runner can still revive is REVIVED by the message, not replaced',
  { skip, timeout: 120_000 }, async () => {
    await verifyDisposableDatabase();
    const stack = connect();
    try {
      // Finished, not gone: the record of everything the project decided, which a delivery must not
      // abandon. The delivery reaches it through `resume`, and the proof that it was the revive path
      // rather than a plain write is the row itself — `createTurn` refuses an ended conversation
      // outright, so a turn existing at all could only have been written by a revive, and the session
      // is moved back to PENDING by the transaction that wrote it.
      const completedAt = new Date(Date.now() - 60_000);
      const w = await world(stack, 'ended', { status: RunStatus.SUCCEEDED, completedAt });
      const before = await coordination(stack.db, w.projectId);

      const answer = await send(stack, w);

      assert.equal(answer.created, false, 'an ended conversation is reachable, so nothing is opened');
      assert.equal(answer.sessionId, w.coordinatorSessionId);
      assert.equal(answer.replacedSessionId, undefined);
      assert.deepEqual(await coordination(stack.db, w.projectId), before);
      assert.equal((await sessionsOf(stack.db, w.ownerId)).length, 2, 'a replacement was opened');

      const turns = await turnsOf(stack.db, w.coordinatorSessionId);
      assert.equal(turns.length, 1);
      assert.equal(turns[0].content, MESSAGE);
      assert.equal(turns[0].clientTurnId, CLIENT_TURN_ID);
      const standing = await stack.db.session.findUniqueOrThrow({
        where: { id: w.coordinatorSessionId },
        select: { status: true, completedAt: true },
      });
      assert.equal(standing.status, RunStatus.PENDING, 'the revive must put the row back in the queue');
    } finally {
      await stack.db.$disconnect();
    }
  });

test('a conversation whose runner is offline is replaced AND delivered to, in one call',
  { skip, timeout: 120_000 }, async () => {
    await verifyDisposableDatabase();
    const stack = connect();
    try {
      // The whole reason this door exists: the message would never reach the conversation the project
      // names, and a caller that had resolved it separately would be holding a dead id by now. The
      // status is CANCELLED with no completion, so the rotation's ending of the outgoing conversation
      // is observable rather than a no-op — and the runner is down, which is what makes it
      // unreachable in the first place.
      const w = await world(stack, 'offline', { status: RunStatus.CANCELLED, offlineRunner: true });
      const before = await coordination(stack.db, w.projectId);

      const answer = await send(stack, w);

      assert.equal(answer.created, true);
      assert.equal(answer.replacedSessionId, w.coordinatorSessionId);
      assert.equal(answer.replaceReason, 'RUNNER_OFFLINE');
      assert.notEqual(answer.sessionId, w.coordinatorSessionId);
      assert.equal(answer.turn.clientTurnId, CLIENT_TURN_ID);

      const after = await coordination(stack.db, w.projectId);
      assert.equal(after.sessionId, answer.sessionId, 'the pointer follows the replacement');
      // §7.5: the SESSION is replaced; the agent and the workspace are not. The landing cannot be
      // chosen here even though its runner is down — moving it is the owner's call.
      assert.equal(after.workspaceId, w.landingWorkspaceId);
      // The count is the DATABASE's (`project_coordinator_rotation_count`), and one rotation spends
      // exactly one generation: two swaps reported as one, or one swap counted twice, would each make
      // the same generation describe two different conversations.
      assert.equal(after.generation, before.generation + 1n);

      const outgoing = await stack.db.session.findUniqueOrThrow({
        where: { id: w.coordinatorSessionId },
        select: { completedAt: true, status: true },
      });
      assert.ok(
        outgoing.completedAt instanceof Date,
        'a conversation left behind by a rotation is completed, not merely unpointed at',
      );
      assert.equal(outgoing.status, RunStatus.CANCELLED, 'a terminal row is not re-run by an ending');

      // And the message went to the REPLACEMENT — behind its own opening turn, which is the placement
      // every send gets on a conversation that has not run yet.
      assert.equal((await turnsOf(stack.db, w.coordinatorSessionId)).length, 0);
      const turns = await turnsOf(stack.db, answer.sessionId);
      assert.equal(turns.length, 2);
      assert.equal(turns[0].clientTurnId, SessionsService.initialTurnClientId(answer.sessionId));
      assert.equal(turns[0].kind, 'message');
      assert.equal(turns[1].content, MESSAGE, 'the message is the new coordinator’s next turn');
      assert.equal(turns[1].clientTurnId, CLIENT_TURN_ID);
      assert.ok(turns[1].seq > turns[0].seq, 'the opening turn runs first');
    } finally {
      await stack.db.$disconnect();
    }
  });

test('the same clientTurnId sent twice is one turn, and the second call does not rotate',
  { skip, timeout: 120_000 }, async () => {
    await verifyDisposableDatabase();
    const stack = connect();
    try {
      // A caller that never saw the first response repeats its request. The replacement it was
      // rotated to is reachable by construction, so the retry resolves to it and the durable key
      // replays the turn already written — a second rotation here is the failure this pins.
      const w = await world(stack, 'retry', { status: RunStatus.CANCELLED, offlineRunner: true });
      const before = await coordination(stack.db, w.projectId);

      const first = await send(stack, w);
      const rotated = await coordination(stack.db, w.projectId);
      const second = await send(stack, w);

      assert.equal(first.created, true);
      assert.equal(second.created, false, 'a retry is not a second rotation');
      assert.equal(second.sessionId, first.sessionId);
      assert.equal(second.replacedSessionId, undefined);
      assert.deepEqual(await coordination(stack.db, w.projectId), rotated);
      assert.equal(rotated.generation, before.generation + 1n, 'the retry spent another generation');
      assert.equal((await sessionsOf(stack.db, w.ownerId)).length, 3, 'the retry opened a conversation');

      const carried = await stack.db.conversationTurn.findMany({
        where: { clientTurnId: CLIENT_TURN_ID, session: { ownerId: w.ownerId } },
        select: { sessionId: true, content: true },
      });
      assert.equal(carried.length, 1, 'the same key wrote the message twice');
      assert.equal(carried[0].sessionId, first.sessionId);
      assert.equal(carried[0].content, MESSAGE);
      assert.equal((await turnsOf(stack.db, first.sessionId)).length, 2, 'the opening turn and one message');
    } finally {
      await stack.db.$disconnect();
    }
  });

test('a landing that cannot open refuses with COORDINATOR_UNAVAILABLE, and not one row is written',
  { skip, timeout: 120_000 }, async () => {
    await verifyDisposableDatabase();
    const stack = connect();
    try {
      // The source is unreachable (its runner is down) and the landing will not open, which is the
      // one combination where the order inside the rotation is visible — and where the refusal must
      // stay the FAILURE TO LAND rather than anything about the message. A disabled workspace is how
      // an owner reaches this state without deleting anything.
      const w = await world(stack, 'unavailable', {
        status: RunStatus.CANCELLED,
        offlineRunner: true,
        landingDisabled: true,
      });
      const before = await coordination(stack.db, w.projectId);
      const sessionsBefore = await sessionsOf(stack.db, w.ownerId);
      const turnsBefore = await turnsOwnedBy(stack.db, w.ownerId);

      await assert.rejects(() => send(stack, w), (error: unknown) => {
        assert.ok(error instanceof Error, `expected a refusal, got ${String(error)}`);
        const response = (error as { getResponse?: () => Record<string, unknown> }).getResponse?.();
        assert.ok(response, `expected a structured refusal, got ${String(error)}`);
        assert.equal(response.code, 'COORDINATOR_UNAVAILABLE');
        // The field that says who can fix it — and it is not this session, and it is not this
        // message. `owner: USER` is what separates this refusal from the delivery one below.
        assert.equal(response.owner, 'USER');
        assert.ok(response.requiredAction, 'a landing refusal names the repair');
        return true;
      });

      assert.deepEqual(await coordination(stack.db, w.projectId), before);
      assert.equal((await sessionsOf(stack.db, w.ownerId)).length, sessionsBefore.length);
      assert.equal(await turnsOwnedBy(stack.db, w.ownerId), turnsBefore, 'a refusal wrote a message');
      const standing = await stack.db.session.findUniqueOrThrow({
        where: { id: w.coordinatorSessionId },
        select: { completedAt: true },
      });
      assert.equal(standing.completedAt, null, 'the outgoing conversation was ended by a refusal');
    } finally {
      await stack.db.$disconnect();
    }
  });

test('a delivery the conversation refuses is its own code, and never COORDINATOR_UNAVAILABLE',
  { skip, timeout: 120_000 }, async () => {
    await verifyDisposableDatabase();
    const stack = connect();
    try {
      // The other half of the refusal surface, reached through the charge the door spends: the
      // conversation was resolved and reachable, and the write onto it was refused anyway. A caller
      // that could not tell this apart from "rebind this project's workspace" would go and change a
      // setting that has nothing to do with why its message is not there.
      const w = await world(stack, 'undelivered');
      const seen: string[] = [];
      const turnsBefore = await turnsOwnedBy(stack.db, w.ownerId);

      await assert.rejects(
        () => stack.projects.sendToCoordinator(
          w.ownerId, w.projectId, w.actingSessionId, MESSAGE, CLIENT_TURN_ID,
          {
            chargeSteer: async (sessionId) => {
              seen.push(sessionId);
              throw new ConflictException('STEER_BUDGET_EXHAUSTED');
            },
          },
        ),
        (error: unknown) => {
          const response = (error as { getResponse?: () => Record<string, unknown> }).getResponse?.();
          assert.ok(response, `expected a structured refusal, got ${String(error)}`);
          assert.equal(response.code, COORDINATOR_MESSAGE_UNDELIVERED_CODE);
          assert.notEqual(response.code, 'COORDINATOR_UNAVAILABLE');
          // Nothing to press on the owner's side: this one is the caller's own outcome to read.
          assert.equal(response.owner, undefined);
          assert.equal(response.requiredAction, undefined);
          // The sentence that actually refused it rides along — a code alone would make every
          // delivery refusal look like the same situation.
          assert.match(String(response.message), /STEER_BUDGET_EXHAUSTED/);
          return true;
        },
      );

      assert.deepEqual(seen, [w.coordinatorSessionId], 'the charge is spent on the conversation sent to');
      // The refusal rolled the whole transaction back: no turn, and the coordination untouched.
      assert.equal(await turnsOwnedBy(stack.db, w.ownerId), turnsBefore);
      assert.equal((await coordination(stack.db, w.projectId)).sessionId, w.coordinatorSessionId);
    } finally {
      await stack.db.$disconnect();
    }
  });

test('without an orchestration credential the door refuses and opens nothing',
  { skip, timeout: 120_000 }, async () => {
    await verifyDisposableDatabase();
    const stack = connect();
    try {
      // A world where a permitted call WOULD write — the coordinator is unreachable, so the door
      // would rotate and deliver. Were the gate missing, this fixture is what would show it.
      const w = await world(stack, 'ungated', { status: RunStatus.CANCELLED, offlineRunner: true });
      const before = await coordination(stack.db, w.projectId);
      const sessionsBefore = await sessionsOf(stack.db, w.ownerId);
      const turnsBefore = await turnsOwnedBy(stack.db, w.ownerId);
      const runner = { id: w.runnerId, ownerId: w.ownerId } as Runner;
      const dto = { message: MESSAGE, clientTurnId: CLIENT_TURN_ID };
      const forAnotherRunner = await stack.orchestration.issue(w.offlineRunnerId, w.actingSessionId);
      const forAnUnknownSession = await stack.orchestration.issue(w.runnerId, randomUUID());

      const refusals: Array<[string, () => Promise<unknown>]> = [
        // No credential at all: the header the runner always sends, absent.
        ['no credential', () => stack.controller.sendToCoordinator(
          runner, w.projectId, w.actingSessionId, undefined, dto,
        )],
        // A credential that is real but belongs to another machine. Binding the proof to a runner is
        // the whole reason a leaked one is not a skeleton key.
        ['another runner’s credential', () => stack.controller.sendToCoordinator(
          runner, w.projectId, w.actingSessionId, forAnotherRunner, dto,
        )],
        // A credential for a session this runner is not running: the live-session predicate is the
        // half of the proof that revocation actually reaches.
        ['a session that is not the caller’s', () => stack.controller.sendToCoordinator(
          runner, w.projectId, randomUUID(), forAnUnknownSession, dto,
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
      assert.equal(
        await turnsOwnedBy(stack.db, w.ownerId),
        turnsBefore,
        'a refused call wrote a turn',
      );
    } finally {
      await stack.db.$disconnect();
    }
  });
