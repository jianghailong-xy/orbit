import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import {
  CreatorType,
  PrismaClient,
  RunStatus,
  RunnerStatus,
  SessionDispatchOrigin,
  TaskStatus,
} from '@prisma/client';
import { Client } from 'pg';

import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { CompletionInputRouter } from '../projects/completion-input-router.service';
import { CoordinatorConvergenceService } from '../projects/coordinator-convergence.service';
import { CoordinatorDeliveryService, coordinatorDeliveryTurnId } from '../projects/coordinator-delivery.service';
import { CoordinatorJudgmentService } from '../projects/coordinator-judgment.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { wakeIdempotencyKey } from '../projects/coordinator-wake';
import { CoordinatorWakeService } from '../projects/coordinator-wake.service';
import { CriterionReadyProducer } from '../projects/criterion-ready.producer';
import { CriterionUnlandedProducer } from '../projects/criterion-unlanded.producer';
import { ProjectTasksSettledProducer } from '../projects/project-tasks-settled.producer';
import { TaskExceptionInputProducer } from '../projects/task-exception-input.producer';
import { WakeDispositionService } from '../projects/wake-disposition.service';
import { QueueService } from '../queue/queue.service';
import { RealtimeService } from '../realtime/realtime.service';
import { SessionsService } from '../sessions/sessions.service';
import { TaskCompletionEvidenceService } from './task-completion-evidence.service';

/**
 * A2's carrier: submitting completion evidence puts a turn in the inbox of the conversation the
 * project is ALREADY coordinated from.
 *
 *   COORDINATOR_PG_URL=postgresql://... \
 *   COORDINATOR_PG_EXPECTED_DATABASE=pcc... \
 *   COORDINATOR_PG_EXPECTED_USER=pcc... \
 *   COORDINATOR_PG_EXPECTED_SYSTEM_IDENTIFIER=... \
 *   node --test build/tasks/coordinator-evidence-inbox.pg.spec.js
 *
 * WHY THIS RUNS THE WHOLE ROUTE INSTEAD OF THE DELIVERY UNIT
 * =========================================================
 * `task-coordinator-session-delivery.pg.spec.ts` already holds the delivery unit to what it does
 * with one fact. Nothing held the EVIDENCE path to reaching it: the fact was claimed, recorded
 * against its consumer, and that was the end of it. So every case here starts at
 * `TaskCompletionEvidenceService.submit` — the real method, with the production wiring underneath
 * it — and reads the conversation's own turns at the other end. A case that called the router or
 * the delivery service directly would pass over exactly the wiring that was missing.
 *
 * THE TWO THINGS EVERY CASE CHECKS TOGETHER
 * =========================================
 * "A turn was enqueued on `project.coordinator_session_id`" and "no session was created" are one
 * claim in two halves, and the second half is a count of rows that must NOT appear. Asserted
 * alone it would be green over a system that delivers nothing at all, so it is never asserted
 * alone: the same fixture, in the same case, also asserts the message that DID get written.
 *
 * Not destructive: every case owns freshly generated ids and asserts over its own project.
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
  /** The unit under test: the real evidence ledger, holding the real router. */
  evidence: TaskCompletionEvidenceService;
}

/**
 * The production wiring, over one client.
 *
 * Every collaborator the router is given is the one the module provides, because the question this
 * file asks is whether the evidence path reaches the delivery unit THROUGH them. A stand-in for any
 * of them would be this spec answering its own question.
 */
async function connect(): Promise<Stack> {
  await verifyDisposableDatabase();
  const db = prismaClientFor(URL!);
  const prisma = db as unknown as PrismaService;
  const realtime = new Proxy({}, { get: () => () => undefined }) as unknown as RealtimeService;
  const queue = { notifySessionQueued: () => undefined } as unknown as QueueService;
  const sessions = new SessionsService(prisma, queue, realtime);
  const wakes = () => new CoordinatorWakeService(prisma);
  const judgments = new CoordinatorJudgmentService(prisma, wakes(), sessions);
  const disposition = new WakeDispositionService(
    prisma,
    judgments,
    new CoordinatorDeliveryService(prisma, wakes(), sessions),
  );
  const router = new CompletionInputRouter(
    wakes(),
    new ProjectTasksSettledProducer(
      prisma,
      judgments,
      new CoordinatorConvergenceService(prisma),
      new CoordinatorDeliveryService(prisma, new CoordinatorWakeService(prisma), sessions),
    ),
    new TaskExceptionInputProducer(prisma, new CoordinatorConvergenceService(prisma)),
    new CriterionReadyProducer(prisma, new CoordinatorConvergenceService(prisma)),
    disposition,
    new CriterionUnlandedProducer(prisma, new CoordinatorConvergenceService(prisma)),
  );
  return { db, evidence: new TaskCompletionEvidenceService(prisma, undefined, router) };
}

interface Fixture {
  ownerId: string;
  workspaceId: string;
  projectId: string;
  taskId: string;
  /** The run whose tool call the evidence cites, and which submits it. */
  sourceSessionId: string;
  /** The standing conversation this project is coordinated from. */
  coordinatorSessionId: string;
}

/** The task's stated standard, quoted verbatim by every envelope below. */
const STANDARD = 'the declared command exits zero and its output names the artifact';

/**
 * One project being coordinated from a parked conversation, with one task submitting evidence.
 *
 * `dispatch_origin` on the standing conversation is USER because that is what `ProjectsService`
 * writes for a person's own coordinator, and telling it apart from a session something opened
 * automatically is the whole of the second assertion below.
 */
async function fixture(db: PrismaClient, label: string): Promise<Fixture> {
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const taskId = randomUUID();
  const sourceSessionId = randomUUID();
  const coordinatorSessionId = randomUUID();
  await db.user.create({
    data: {
      id: ownerId,
      email: `${label}-${ownerId}@evidence-inbox.invalid`,
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
  await db.session.create({
    data: {
      id: coordinatorSessionId,
      ownerId,
      creatorId: ownerId,
      workspaceId,
      assignedRunnerId: runnerId,
      title: `协调：${label}`,
      prompt: `协调：${label}`,
      provider: 'claude',
      status: RunStatus.AWAITING_INPUT,
      dispatchOrigin: SessionDispatchOrigin.USER,
      titleManagedByProject: true,
    },
  });
  // A conversation somebody has actually been talking to already carries its opening prompt as a
  // turn. Written here so the delivery below is not the thing that seeds it, and so the message
  // count can exclude it the way the product's own queued-turn reader does.
  await db.conversationTurn.create({
    data: {
      sessionId: coordinatorSessionId,
      seq: 1,
      clientTurnId: SessionsService.initialTurnClientId(coordinatorSessionId),
      kind: 'message',
      content: `协调：${label}`,
      status: 'ANSWERED',
    },
  });
  await db.project.create({
    data: {
      id: projectId,
      ownerId,
      title: `${label} 证据收件箱项目`,
      goal: '提交完成证据时，让正在协调这个项目的那条会话收到一个 turn',
      coordinatorWorkspaceId: workspaceId,
      coordinatorSessionId,
    },
  });
  await db.task.create({
    data: {
      id: taskId,
      ownerId,
      projectId,
      title: `${label} 要交证据的活`,
      creatorType: CreatorType.USER,
      creatorId: ownerId,
      assigneeId: workspaceId,
      status: TaskStatus.IN_PROGRESS,
      completionCriterion: 'EVIDENCE_JUDGMENT',
      acceptanceCriteria: STANDARD,
    },
  });
  await db.session.create({
    data: {
      id: sourceSessionId,
      ownerId,
      creatorId: ownerId,
      taskId,
      workspaceId,
      assignedRunnerId: runnerId,
      title: `${label} 执行会话`,
      prompt: `${label} 执行会话`,
      provider: 'claude',
      status: RunStatus.AWAITING_INPUT,
      dispatchOrigin: SessionDispatchOrigin.USER,
      startsTaskWork: true,
    },
  });
  // The envelope has to cite a row of this task's own, so the submissions below pass that check
  // rather than go around it.
  await db.toolCall.create({
    data: {
      sessionId: sourceSessionId,
      name: 'Bash',
      toolUseId: `toolu_${label}`,
      input: { command: 'npm test', description: 'the command this evidence is about' },
      isError: false,
    },
  });
  return { ownerId, workspaceId, projectId, taskId, sourceSessionId, coordinatorSessionId };
}

/** The four-field envelope, quoting the standard this task states and citing its own tool call. */
function envelope(f: Fixture, label: string, claim: string) {
  return {
    claim,
    criterion: { key: 'evidence-inbox', text: STANDARD },
    checks: [{ kind: 'TOOL_CALL', ref: `toolu_${label}`, command: 'npm test', succeeded: true }],
    gaps: [],
  };
}

/**
 * Every message the standing conversation has been SENT, oldest first.
 *
 * The seeded opening turn is excluded, exactly as the product's own queued-turn reader excludes it:
 * it is the conversation's own prompt rather than something anybody told it, and counting it would
 * make "was this coordinator told about the evidence" answer yes for a conversation nobody has said
 * a word to.
 */
function coordinatorMessages(db: PrismaClient, f: Fixture) {
  return db.conversationTurn.findMany({
    where: {
      sessionId: f.coordinatorSessionId,
      kind: 'message',
      clientTurnId: { not: SessionsService.initialTurnClientId(f.coordinatorSessionId) },
    },
    select: { clientTurnId: true, content: true, status: true },
    orderBy: { seq: 'asc' },
  });
}

/** The sessions something opened automatically for this project's coordination. */
function coordinatorSessions(db: PrismaClient, ownerId: string) {
  return db.session.findMany({
    where: { ownerId, dispatchOrigin: SessionDispatchOrigin.PROJECT_COORDINATOR, deletedAt: null },
    select: { id: true },
  });
}

/** Every session row this owner has — the count "nothing was opened" is really about. */
function allSessions(db: PrismaClient, ownerId: string) {
  return db.session.count({ where: { ownerId } });
}

function evidenceWakes(db: PrismaClient, projectId: string) {
  return db.projectCoordinatorWake.findMany({
    where: { projectId, event: 'COMPLETION_EVIDENCE_REVISED' },
    select: {
      subjectType: true,
      subjectId: true,
      subjectVersion: true,
      status: true,
      consumerType: true,
      refusalCode: true,
    },
    orderBy: { createdAt: 'asc' },
  });
}

/** The turn key one recorded fact's message is written under, derived the way the product derives it. */
function expectedTurnId(row: { subjectType: string; subjectId: string; subjectVersion: string }) {
  return coordinatorDeliveryTurnId(wakeIdempotencyKey({
    event: 'COMPLETION_EVIDENCE_REVISED',
    subjectType: row.subjectType as 'TASK',
    subjectId: row.subjectId,
    subjectVersion: row.subjectVersion,
  }));
}

/**
 * The runner picks the message up, answers it, and the conversation parks again.
 *
 * Written on the row rather than driven through the runner door, and named so the shortcut is
 * visible: what a delivery does to a parked conversation is move it to PENDING, and what ends that
 * state is a runner claiming the session and completing the turn. Nothing here is about that half;
 * what it is about is the state a coordinator is in when the NEXT fact arrives.
 */
async function coordinatorReadsIt(db: PrismaClient, f: Fixture) {
  await db.conversationTurn.updateMany({
    where: { sessionId: f.coordinatorSessionId, status: 'PENDING' },
    data: { status: 'ANSWERED', answeredAt: new Date() },
  });
  await db.session.update({
    where: { id: f.coordinatorSessionId },
    data: { status: RunStatus.AWAITING_INPUT },
  });
}

test('submitting completion evidence enqueues a turn on the project\'s coordinator session',
  { skip, timeout: 300_000 }, async () => {
    const stack = await connect();
    try {
      const f = await fixture(stack.db, 'inbox');

      // Counted BEFORE the submission, so "nothing was opened" is a comparison rather than a guess
      // about how many rows a fixture leaves behind.
      const sessionsBefore = await allSessions(stack.db, f.ownerId);
      assert.deepEqual(await coordinatorSessions(stack.db, f.ownerId), []);
      assert.deepEqual(await coordinatorMessages(stack.db, f), []);

      const submitted = await stack.evidence.submit(
        f.ownerId,
        f.taskId,
        { type: CreatorType.AGENT, id: f.workspaceId },
        {
          sourceSessionId: f.sourceSessionId,
          evidence: envelope(f, 'inbox', 'the declared command ran and passed in this session'),
          idempotencyKey: 'turn-1-complete',
        },
      );
      assert.equal(submitted.revision, '1');

      // The fact reached the ledger, once, and ended where it always has: against its named
      // consumer. Delivering it did not move that terminal, and the row is read here so the
      // message below is matched to the fact rather than to whatever turn happens to be last.
      const wakes = await evidenceWakes(stack.db, f.projectId);
      assert.equal(wakes.length, 1, 'the evidence revision never reached the wake ledger');
      const wake = wakes[0]!;
      assert.equal(wake.status, 'CONSUMED');
      assert.equal(wake.consumerType, 'JUDGMENT_REQUEST_DERIVER');
      assert.equal(wake.refusalCode, null);
      assert.equal(wake.subjectId, f.taskId);

      // (1) The turn is on the conversation the PROJECT names, read back off the project rather
      // than out of the fixture: what this task asks is that those two are the same row.
      const project = await stack.db.project.findUniqueOrThrow({
        where: { id: f.projectId },
        select: { coordinatorSessionId: true },
      });
      assert.equal(project.coordinatorSessionId, f.coordinatorSessionId);
      const said = await coordinatorMessages(stack.db, f);
      assert.equal(said.length, 1, 'the coordinator conversation was told nothing');
      assert.equal(
        said[0]!.clientTurnId, expectedTurnId(wake),
        'the turn was written under a key that is not the fact\'s own identity',
      );
      assert.equal(said[0]!.status, 'PENDING', 'the turn is not waiting in the inbox');
      assert.match(
        said[0]!.content ?? '', /完成证据/,
        'the message does not say which kind of fact it is about',
      );

      // The conversation itself is what a coordinator that has just been told something looks
      // like: a queued message needs a fresh runner slot, so the row moves to PENDING.
      assert.equal(
        (await stack.db.session.findUniqueOrThrow({ where: { id: f.coordinatorSessionId } })).status,
        RunStatus.PENDING,
      );

      // (2) And nothing was opened to carry it — not a session for this project's coordination,
      // not any other row either.
      assert.deepEqual(
        await coordinatorSessions(stack.db, f.ownerId), [],
        'the evidence opened a coordinator session instead of writing to the standing one',
      );
      assert.equal(
        await allSessions(stack.db, f.ownerId), sessionsBefore,
        'the delivery created a session instead of writing to the one that was already there',
      );
    } finally {
      await stack.db.$disconnect();
    }
  });

test('the same revision says it once; a later revision says it again',
  { skip, timeout: 300_000 }, async () => {
    const stack = await connect();
    try {
      const f = await fixture(stack.db, 'twice');
      const actor = { type: CreatorType.AGENT, id: f.workspaceId };
      const first = envelope(f, 'twice', 'the declared command ran and passed in this session');

      await stack.evidence.submit(f.ownerId, f.taskId, actor, {
        sourceSessionId: f.sourceSessionId, evidence: first, idempotencyKey: 'turn-1-complete',
      });
      const once = await coordinatorMessages(stack.db, f);
      assert.equal(once.length, 1);

      // The same fact again — a replayed submission under a second key, which the ledger answers
      // with the SAME revision. One fact, one message: the wake's idempotency key is a total
      // function of the fact, so the second route never reaches the conversation.
      const replay = await stack.evidence.submit(f.ownerId, f.taskId, actor, {
        sourceSessionId: f.sourceSessionId, evidence: first, idempotencyKey: 'turn-1-equivalent',
      });
      assert.equal(replay.revision, '1');
      assert.deepEqual(await coordinatorMessages(stack.db, f), once, 'one fact said it twice');

      // The paired positive, so the count above is not green over a system that stopped delivering
      // after the first message: a DIFFERENT fact does reach the same conversation. The coordinator
      // reads the first message before it arrives, because a conversation that has not read the
      // last one is refused by the path that writes it.
      await coordinatorReadsIt(stack.db, f);
      const second = await stack.evidence.submit(f.ownerId, f.taskId, actor, {
        sourceSessionId: f.sourceSessionId,
        evidence: envelope(f, 'twice', 're-read the artifact and the claim still holds'),
        idempotencyKey: 'turn-2-complete',
      });
      assert.equal(second.revision, '2');

      const wakes = await evidenceWakes(stack.db, f.projectId);
      assert.equal(wakes.length, 2, 'the second revision never reached the wake ledger');
      const said = await coordinatorMessages(stack.db, f);
      assert.equal(said.length, 2, 'the second revision was recorded and never delivered');
      assert.deepEqual(
        said.map((turn) => turn.clientTurnId), wakes.map(expectedTurnId),
        'the two messages are not the two facts, in the order they were recorded',
      );

      // Still nothing opened, over two deliveries rather than one.
      assert.deepEqual(await coordinatorSessions(stack.db, f.ownerId), []);
    } finally {
      await stack.db.$disconnect();
    }
  });

test('the coordinator-evidence PostgreSQL target is explicitly disposable', { skip }, () => {
  assertCoordinatorPgUrlIsIsolated(URL);
});
