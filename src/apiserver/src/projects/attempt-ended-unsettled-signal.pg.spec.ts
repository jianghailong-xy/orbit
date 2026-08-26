/**
 * T11's missing-judgment-path exit against real PostgreSQL.
 *
 * The claim under test is a committed row, not a return value: a terminal task-work Session whose
 * Task is unsettled and has no L0/L1/L2 path must leave one open USER/HUMAN project blocker plus a
 * readable Task comment. The negative controls prove that a declared L0 path and a usable L2
 * landing keep ownership of the verdict, and every branch proves this producer never writes DONE.
 *
 * Destructive only to rows this file creates. COORDINATOR_PG_URL must name the disposable database
 * accepted by coordinator-pg-test-safety, with all migrations applied.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import {
  CreatorType,
  PrismaClient,
  RunStatus,
  RunnerStatus,
  SessionDispatchOrigin,
  TaskStatus,
} from '@prisma/client';

import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { QueueService } from '../queue/queue.service';
import { RealtimeService } from '../realtime/realtime.service';
import { SessionsService } from '../sessions/sessions.service';
import {
  ATTEMPT_UNJUDGED_BLOCKER_KIND,
  ATTEMPT_UNJUDGED_SIGNAL_CODE,
  ATTEMPT_WAKE_SESSION_PARKED,
  AttemptEndedUnsettledProducer,
} from './attempt-ended-unsettled.producer';
import {
  CoordinatorJudgmentService,
  JUDGMENT_NO_LANDING,
} from './coordinator-judgment.service';
import { CoordinatorConvergenceService } from './coordinator-convergence.service';
import { CoordinatorWakeService } from './coordinator-wake.service';
import { assertCoordinatorPgUrlIsIsolated } from './coordinator-pg-test-safety';

const URL = process.env.COORDINATOR_PG_URL;
const suite = URL ? test : test.skip;

interface Stack {
  db: PrismaClient;
  producer: AttemptEndedUnsettledProducer;
}

interface Fixture {
  ownerId: string;
  runnerId: string;
  workspaceId: string;
  projectId: string;
  taskId: string;
  sessionId: string;
}

function connect(): Stack {
  const db = prismaClientFor(URL!);
  const prisma = db as unknown as PrismaService;
  const queue = { notifySessionQueued: () => undefined } as unknown as QueueService;
  const realtime = new Proxy({}, { get: () => () => undefined }) as unknown as RealtimeService;
  const sessions = new SessionsService(prisma, queue, realtime);
  const convergence = new CoordinatorConvergenceService(prisma);
  return {
    db,
    producer: new AttemptEndedUnsettledProducer(
      prisma,
      new CoordinatorJudgmentService(
        prisma,
        new CoordinatorWakeService(prisma),
        sessions,
      ),
      convergence,
    ),
  };
}

async function fixture(
  db: PrismaClient,
  label: string,
  options: {
    landed?: boolean;
    acceptanceCommand?: string;
    liveVerifier?: boolean;
    sessionStatus?: RunStatus;
  } = {},
): Promise<Fixture> {
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const taskId = randomUUID();
  const sessionId = randomUUID();
  await db.user.create({
    data: {
      id: ownerId,
      email: `${label}-${ownerId}@t11.invalid`,
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
    data: {
      id: workspaceId,
      ownerId,
      runnerId,
      name: `${label}-workspace`,
      enabled: true,
    },
  });
  await db.project.create({
    data: {
      id: projectId,
      ownerId,
      title: `${label}-project`,
      coordinatorEnabled: true,
      ...(options.landed ? { coordinatorWorkspaceId: workspaceId } : {}),
    },
  });
  await db.task.create({
    data: {
      id: taskId,
      ownerId,
      projectId,
      assigneeId: workspaceId,
      title: `${label}-task`,
      creatorType: CreatorType.USER,
      creatorId: ownerId,
      status: TaskStatus.OPEN,
      ...(options.acceptanceCommand
        ? { acceptanceCommand: options.acceptanceCommand, acceptanceExpectedExitCode: 0 }
        : {}),
    },
  });
  if (options.liveVerifier) {
    await db.task.create({
      data: {
        ownerId,
        projectId,
        assigneeId: workspaceId,
        title: `${label}-verifier`,
        creatorType: CreatorType.USER,
        creatorId: ownerId,
        status: TaskStatus.OPEN,
        verifiesTaskId: taskId,
      },
    });
  }

  const sessionStatus = options.sessionStatus ?? RunStatus.SUCCEEDED;
  const parked = sessionStatus === RunStatus.AWAITING_INPUT;
  await db.session.create({
    data: {
      id: sessionId,
      ownerId,
      creatorId: ownerId,
      taskId,
      workspaceId,
      assignedRunnerId: runnerId,
      title: `${label}-session`,
      prompt: label,
      provider: 'claude',
      status: sessionStatus,
      dispatchOrigin: SessionDispatchOrigin.USER,
      startsTaskWork: true,
      numTurns: 1,
      engineTurnActive: false,
      ...(parked ? {} : { finishedAt: new Date() }),
    },
  });
  if (parked) {
    await db.conversationTurn.create({
      data: {
        sessionId,
        seq: 1,
        clientTurnId: `${label}-answered`,
        kind: 'message',
        content: 'do the work',
        status: 'ANSWERED',
        answeredAt: new Date(),
      },
    });
  }
  return { ownerId, runnerId, workspaceId, projectId, taskId, sessionId };
}

async function signalRows(db: PrismaClient, f: Fixture) {
  const blocker = await db.projectBlocker.findFirst({
    where: {
      projectId: f.projectId,
      kind: ATTEMPT_UNJUDGED_BLOCKER_KIND,
      subjectType: 'TASK',
      subjectId: f.taskId,
      resolvedAt: null,
    },
  });
  const comments = await db.taskComment.findMany({
    where: { taskId: f.taskId, body: { contains: ATTEMPT_UNJUDGED_SIGNAL_CODE } },
    orderBy: { createdAt: 'asc' },
  });
  return { blocker, comments };
}

suite('terminal attempt with no L0, L1 or reachable L2 persists one needs-human signal',
  { timeout: 180_000 }, async (t) => {
    assertCoordinatorPgUrlIsIsolated(URL);
    const stack = connect();
    t.after(() => stack.db.$disconnect());
    const f = await fixture(stack.db, 'no-path');

    const first = await stack.producer.afterCommit(f.sessionId);
    assert.equal(first.outcome, 'REFUSED');
    assert.equal(
      first.outcome === 'REFUSED' ? first.signal?.signalCode : null,
      ATTEMPT_UNJUDGED_SIGNAL_CODE,
    );
    const { blocker, comments } = await signalRows(stack.db, f);
    assert.ok(blocker, 'the signal must be a committed project_blocker row');
    assert.equal(blocker.kind, 'HUMAN_DECISION_REQUIRED');
    assert.equal(blocker.owner, 'USER');
    assert.equal(blocker.recovery, 'HUMAN');
    assert.equal(blocker.severity, 'CRITICAL');
    assert.match(blocker.requiredAction, /没有合法判定路径/);
    const detail = blocker.detail as {
      signalCode: string;
      source: string;
      paths: Record<'L0' | 'L1' | 'L2', { outcome: string; reason: string }>;
      automaticTaskStatusWrite: string;
    };
    assert.equal(detail.signalCode, ATTEMPT_UNJUDGED_SIGNAL_CODE);
    assert.equal(detail.source, 'ATTEMPT_ENDED_UNSETTLED');
    assert.deepEqual(detail.paths.L0, {
      outcome: 'UNAVAILABLE', reason: 'NO_ACCEPTANCE_COMMAND',
    });
    assert.deepEqual(detail.paths.L1, {
      outcome: 'UNAVAILABLE', reason: 'NO_LIVE_VERIFICATION_TASK',
    });
    assert.deepEqual(detail.paths.L2, { outcome: 'REFUSED', reason: JUDGMENT_NO_LANDING });
    assert.equal(detail.automaticTaskStatusWrite, 'NONE');
    assert.equal(comments.length, 1);
    assert.match(comments[0].body, /工作可能已经完成/);
    assert.match(comments[0].body, /没有合法证据自动判定 DONE；任务状态未被修改/);
    assert.equal(
      (await stack.db.task.findUniqueOrThrow({ where: { id: f.taskId } })).status,
      TaskStatus.OPEN,
      'the human signal is not a disguised DONE write',
    );

    // A redelivery may leave another REFUSED wake audit row, but not another open episode or
    // comment. Dedupe is a database property, not a process-local guard.
    await stack.producer.afterCommit(f.sessionId);
    assert.equal((await signalRows(stack.db, f)).comments.length, 1);
    assert.equal(
      await stack.db.projectBlocker.count({
        where: { projectId: f.projectId, subjectId: f.taskId, resolvedAt: null },
      }),
      1,
    );
  });

suite('a declared L0 path owns the verdict and suppresses the human signal',
  { timeout: 120_000 }, async (t) => {
    assertCoordinatorPgUrlIsIsolated(URL);
    const stack = connect();
    t.after(() => stack.db.$disconnect());
    const f = await fixture(stack.db, 'l0-path', { acceptanceCommand: 'exit 0' });

    const delivery = await stack.producer.afterCommit(f.sessionId);
    assert.equal(delivery.outcome, 'JUDGMENT_PATH_AVAILABLE');
    const signal = await signalRows(stack.db, f);
    assert.equal(signal.blocker, null);
    assert.equal(signal.comments.length, 0);
    assert.equal(
      await stack.db.projectCoordinatorWake.count({ where: { projectId: f.projectId } }),
      0,
      'this producer does not preempt L0 with an L2 wake',
    );
    assert.notEqual(
      (await stack.db.task.findUniqueOrThrow({ where: { id: f.taskId } })).status,
      TaskStatus.DONE,
      'the producer itself never converts path availability into DONE',
    );
  });

suite('a live L1 verifier owns the verdict and suppresses the human signal',
  { timeout: 120_000 }, async (t) => {
    assertCoordinatorPgUrlIsIsolated(URL);
    const stack = connect();
    t.after(() => stack.db.$disconnect());
    const f = await fixture(stack.db, 'l1-path', { liveVerifier: true });

    const delivery = await stack.producer.afterCommit(f.sessionId);
    assert.equal(delivery.outcome, 'JUDGMENT_PATH_AVAILABLE');
    assert.equal((await signalRows(stack.db, f)).blocker, null);
    assert.equal(
      (await stack.db.task.findUniqueOrThrow({ where: { id: f.taskId } })).status,
      TaskStatus.OPEN,
    );
  });

suite('a usable L2 landing opens one judgment and does not duplicate a human signal',
  { timeout: 180_000 }, async (t) => {
    assertCoordinatorPgUrlIsIsolated(URL);
    const stack = connect();
    t.after(() => stack.db.$disconnect());
    const f = await fixture(stack.db, 'l2-path', { landed: true });

    const delivery = await stack.producer.afterCommit(f.sessionId);
    assert.equal(delivery.outcome, 'OPENED');
    assert.equal((await signalRows(stack.db, f)).blocker, null);
    assert.equal(
      await stack.db.session.count({
        where: {
          ownerId: f.ownerId,
          dispatchOrigin: SessionDispatchOrigin.PROJECT_COORDINATOR,
        },
      }),
      1,
    );
    assert.equal(
      (await stack.db.task.findUniqueOrThrow({ where: { id: f.taskId } })).status,
      TaskStatus.OPEN,
      'opening a judgment is not itself a DONE verdict',
    );

    const again = await stack.producer.afterCommit(f.sessionId);
    assert.equal(again.outcome, 'ALREADY_AWAKE');
    assert.equal((await signalRows(stack.db, f)).blocker, null);
  });

suite('startup compatibility turns a fully answered parked work turn into the explicit signal',
  { timeout: 180_000 }, async (t) => {
    assertCoordinatorPgUrlIsIsolated(URL);
    const stack = connect();
    t.after(() => stack.db.$disconnect());
    const f = await fixture(stack.db, 'parked', {
      landed: true,
      sessionStatus: RunStatus.AWAITING_INPUT,
    });

    const result = await stack.producer.reconcileUnsettledAttempts(100);
    assert.ok(result.scanned >= 1);
    assert.ok(result.signaled >= 1);
    const { blocker, comments } = await signalRows(stack.db, f);
    assert.ok(blocker);
    const detail = blocker.detail as {
      paths: { L2: { reason: string } };
      sessionStatus: string;
    };
    assert.equal(detail.sessionStatus, RunStatus.AWAITING_INPUT);
    assert.equal(detail.paths.L2.reason, ATTEMPT_WAKE_SESSION_PARKED);
    assert.equal(comments.length, 1);
    assert.match(comments[0].body, /工作回合已结束，当前停在 AWAITING_INPUT/);
    assert.equal(
      (await stack.db.task.findUniqueOrThrow({ where: { id: f.taskId } })).status,
      TaskStatus.OPEN,
      'legacy recovery signals a person; it never guesses DONE',
    );
  });

test('the database under test really is a disposable one', { skip: !URL }, () => {
  assertCoordinatorPgUrlIsIsolated(URL);
});
