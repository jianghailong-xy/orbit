import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
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

import { uuidToBase62 } from '@orbit/shared';

import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { CompletionInputRouter } from '../projects/completion-input-router.service';
import { CoordinatorConvergenceService } from '../projects/coordinator-convergence.service';
import { CoordinatorDeliveryService } from '../projects/coordinator-delivery.service';
import { CoordinatorJudgmentService } from '../projects/coordinator-judgment.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { CoordinatorWakeService } from '../projects/coordinator-wake.service';
import { CriterionReadyProducer } from '../projects/criterion-ready.producer';
import { CriterionUnlandedProducer } from '../projects/criterion-unlanded.producer';
import { ProjectTasksSettledProducer } from '../projects/project-tasks-settled.producer';
import { TaskExceptionInputProducer } from '../projects/task-exception-input.producer';
import { WakeDispositionService } from '../projects/wake-disposition.service';
import { RunnerApiController } from '../runner-api/runner-api.controller';
import { SessionsService } from '../sessions/sessions.service';
import { EVIDENCE_ASK_TOOL, buildEvidenceAsk } from './coordinator-evidence-ask';
import { TaskCompletionEvidenceService } from './task-completion-evidence.service';

/**
 * A2's floor: a card nobody answers does not make the evidence go quiet.
 *
 *   COORDINATOR_PG_URL=postgresql://... \
 *   COORDINATOR_PG_EXPECTED_DATABASE=pcc... \
 *   COORDINATOR_PG_EXPECTED_USER=pcc... \
 *   COORDINATOR_PG_EXPECTED_SYSTEM_IDENTIFIER=... \
 *   node --test build/tasks/coordinator-evidence-unanswered.pg.spec.js
 *
 * THE THREE STATES, AND WHY THEY ARE ONE SUBJECT
 * ==============================================
 * The card is delivered by a message and asked by an engine, and there are three ways the asking
 * ends with nobody having answered — each of which writes NOTHING anywhere, which is what makes
 * them a subject rather than three bugs:
 *
 *   1. the engine gives up on the tool call (`runner-go/mcp.go` polls uncapped; the deadline is
 *      the engine's and `approval` has no expiry column), and the turn runs on;
 *   2. the turn itself is reclaimed — a 4h TTL and an LRU over long-blocked turns — so the poll
 *      loop dies with it and the runtime handshake parks the conversation;
 *   3. the conversation had no live runner when the fact arrived, so the message is sitting in an
 *      inbox nobody has picked up.
 *
 * In all three the wake is spent and holds its key, so nothing re-delivers the fact. What catches
 * it is the derived pending read behind the decision rail, which recomputes the question from the
 * committed rows every time a person opens a window — the fallback chosen in
 * `docs/completion-input-routing.md` §A2 D1, and the reason it was chosen is asserted below to be
 * written where the fallback is rather than only in a document.
 *
 * AND THE SECOND HALF: A DEAD CARD MUST STOP LOOKING ANSWERABLE
 * ============================================================
 * The approval row outlives the question in all three states. A surface that goes on offering it
 * takes a person's answer and delivers it to nobody, which is worse than showing nothing — so each
 * case asserts what the browser's own read (`SessionsService.listApprovals`, the door behind
 * `GET /sessions/:id/approvals?status=PENDING`) offers, and asserts it while the question was
 * still live as the paired positive.
 *
 * EVERY "STILL VISIBLE" HAS A CONTROL THAT MAKES IT ZERO
 * =====================================================
 * "The row is still on the rail" is also true of a read that filters nothing, so no case asserts
 * it alone: each one records a decision on the same fixture afterwards and asserts the same read
 * returns nothing. Two clauses take a row off that read and they are not the same clause, so the
 * controls use both — a CONFIRM (which settles the task) and a SEND_BACK with a note (which leaves
 * it OPEN and takes the row off by the answered-revision clause alone).
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

/** A collaborator this file's question is not about: every call answers undefined. */
function inert<T>(): T {
  return new Proxy({}, { get: () => () => undefined }) as T;
}

interface Stack {
  db: PrismaClient;
  /** The ledger: the door the work submits through, the rail reads through, and answers land in. */
  evidence: TaskCompletionEvidenceService;
  /** The runner's permission tool, as the control plane receives it. */
  runner: RunnerApiController;
  /** The browser's session doors — including the approval listing this file is about. */
  sessions: SessionsService;
}

/**
 * The production wiring, over one client.
 *
 * The stand-ins are the notification transports and nothing else: a realtime publish, a push
 * notification and a queue nudge are how other processes hear about a row, never how the row is
 * read or decided, so a proxy for them removes no check this file makes.
 */
async function connect(): Promise<Stack> {
  await verifyDisposableDatabase();
  const db = prismaClientFor(URL!);
  const prisma = db as unknown as PrismaService;
  const realtime = inert<ConstructorParameters<typeof SessionsService>[2]>();
  const queue = inert<ConstructorParameters<typeof SessionsService>[1]>();
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
    new ProjectTasksSettledProducer(prisma, judgments, new CoordinatorConvergenceService(prisma)),
    new TaskExceptionInputProducer(prisma, new CoordinatorConvergenceService(prisma)),
    new CriterionReadyProducer(prisma, new CoordinatorConvergenceService(prisma)),
    disposition,
    new CriterionUnlandedProducer(prisma, new CoordinatorConvergenceService(prisma)),
  );
  return {
    db,
    evidence: new TaskCompletionEvidenceService(prisma, undefined, router),
    runner: new RunnerApiController(prisma, queue, realtime, inert(), inert(), inert()),
    sessions,
  };
}

interface Fixture {
  ownerId: string;
  runnerId: string;
  workspaceId: string;
  projectId: string;
  criterionId: string;
  taskId: string;
  /** The run whose tool call the evidence cites, and which submits it. */
  sourceSessionId: string;
  /** The standing conversation this project is coordinated from — where the card is asked. */
  coordinatorSessionId: string;
  /** Another window the same person has open, which took no part in any of this. */
  readerSessionId: string;
}

/** The project's one stated criterion, quoted verbatim by every envelope below. */
const STANDARD = 'an unanswered completion card leaves the evidence findable on the decision rail';

/** The tool-use id the card is raised under, one per fixture. */
const askToolUseId = (f: Fixture) => `toolu_ask_${uuidToBase62(f.taskId)}`;

/**
 * One project coordinated from a parked conversation, with one task waiting on a judgment.
 *
 * The coordinator conversation and the second window both have no `taskId` and have submitted
 * nothing, which is not a convenience: it is what `decidingSessionDisqualification` reads, so the
 * rows below reach them on the facts rather than by exemption.
 */
async function fixture(db: PrismaClient, label: string): Promise<Fixture> {
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const criterionId = randomUUID();
  const taskId = randomUUID();
  const sourceSessionId = randomUUID();
  const coordinatorSessionId = randomUUID();
  const readerSessionId = randomUUID();
  await db.user.create({
    data: {
      id: ownerId,
      email: `${label}-${ownerId}@evidence-unanswered.invalid`,
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
      title: `协调：${label}`,
      prompt: `协调：${label}`,
      provider: 'claude',
      providerBuiltin: true,
      status: RunStatus.AWAITING_INPUT,
      dispatchOrigin: SessionDispatchOrigin.USER,
      titleManagedByProject: true,
    },
  });
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
  await db.session.create({
    data: {
      id: readerSessionId,
      ownerId,
      creatorId: ownerId,
      workspaceId,
      assignedRunnerId: runnerId,
      title: `${label} 另一扇窗`,
      prompt: `${label} 另一扇窗`,
      provider: 'claude',
      providerBuiltin: true,
      status: RunStatus.AWAITING_INPUT,
      dispatchOrigin: SessionDispatchOrigin.USER,
    },
  });
  await db.project.create({
    data: {
      id: projectId,
      ownerId,
      title: `${label} 无人应答项目`,
      goal: '没人回答那张卡片时，这条完成证据仍然找得回来',
      coordinatorWorkspaceId: workspaceId,
      coordinatorSessionId,
    },
  });
  // The live stated standard. Without a definition row the quote below resolves to nothing and the
  // decision door refuses every answer about it, which would put the row where nobody can press
  // anything — a different file's subject, and it would make every assertion here vacuous.
  await db.projectAcceptanceCriterionDefinition.create({
    data: {
      id: criterionId,
      projectId,
      ordinal: 1,
      text: STANDARD,
      verificationMethod: 'the pg spec drives an unanswered card and reads the rail afterwards',
      contentHash: '0'.repeat(64),
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
      criterionDefinitionId: criterionId,
      criterionRevision: 1,
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
      providerBuiltin: true,
      status: RunStatus.AWAITING_INPUT,
      dispatchOrigin: SessionDispatchOrigin.USER,
      startsTaskWork: true,
    },
  });
  await db.toolCall.create({
    data: {
      sessionId: sourceSessionId,
      name: 'Bash',
      toolUseId: `toolu_${label}`,
      input: { command: 'npm test', description: 'the command this evidence is about' },
      isError: false,
      startedAt: new Date(),
      finishedAt: new Date(),
    },
  });
  return {
    ownerId,
    runnerId,
    workspaceId,
    projectId,
    criterionId,
    taskId,
    sourceSessionId,
    coordinatorSessionId,
    readerSessionId,
  };
}

/** The four-field envelope, quoting the criterion this project states and citing the run's own call. */
function envelope(f: Fixture, label: string, claim: string) {
  return {
    claim,
    criterion: { key: uuidToBase62(f.criterionId), text: STANDARD },
    checks: [{ kind: 'TOOL_CALL', ref: `toolu_${label}`, command: 'npm test', succeeded: true }],
    gaps: ['nothing here proves a person ever looked at the card'],
  };
}

/** The work reports itself finished, through the real door, which routes the fact. */
async function submitEvidence(stack: Stack, f: Fixture, label: string) {
  const submitted = await stack.evidence.submit(
    f.ownerId,
    f.taskId,
    { type: CreatorType.AGENT, id: f.workspaceId },
    {
      sourceSessionId: f.sourceSessionId,
      evidence: envelope(f, label, 'the work is finished and the artifact is named in the output'),
      idempotencyKey: `${label}-1-complete`,
    },
  );
  assert.equal(submitted.revision, '1');
}

/** The messages the delivery put in the coordinator's inbox — its own opening turn excluded. */
function coordinatorMessages(db: PrismaClient, f: Fixture) {
  return db.conversationTurn.findMany({
    where: {
      sessionId: f.coordinatorSessionId,
      kind: 'message',
      clientTurnId: { not: SessionsService.initialTurnClientId(f.coordinatorSessionId) },
    },
    select: { content: true, status: true },
    orderBy: { seq: 'asc' },
  });
}

/**
 * The runner claims the queued message and the engine starts the turn.
 *
 * Written on the row rather than driven through the runner door, and named so the shortcut is
 * visible: what a delivery does to a parked conversation is move it to PENDING, and what ends that
 * state is a runner taking the turn. The status matters to this file because it is half of what
 * says a card can still be answered — a question can only be live while something is generating.
 */
async function theRunnerTakesTheTurn(db: PrismaClient, f: Fixture): Promise<void> {
  await db.session.update({
    where: { id: f.coordinatorSessionId },
    data: { status: RunStatus.RUNNING, engineTurnActive: true },
  });
}

/**
 * The model asks the person, through the door `--permission-prompt-tool` posts to.
 *
 * The `tool_call` row beside it is what the runner's own event ingestion writes when the tool_use
 * event lands (`runner-api.controller.ts`), and it is written here for the same reason: it is the
 * row that later carries the engine's result, and "this call already has a result" is the only
 * committed fact that tells a dead card from a live one while the turn runs on.
 */
async function theModelAsks(stack: Stack, f: Fixture): Promise<string> {
  const queue = await stack.evidence.pending(f.ownerId, f.coordinatorSessionId);
  const ask = buildEvidenceAsk(queue);
  assert.ok(ask, 'the coordinator was given nothing to ask about');
  const raised = await stack.runner.createApproval(
    { id: f.runnerId },
    f.coordinatorSessionId,
    { toolName: EVIDENCE_ASK_TOOL, input: ask, toolUseId: askToolUseId(f) },
  );
  await stack.db.toolCall.create({
    data: {
      sessionId: f.coordinatorSessionId,
      name: EVIDENCE_ASK_TOOL,
      toolUseId: askToolUseId(f),
      input: ask as unknown as object,
      startedAt: new Date(),
    },
  });
  return raised.id;
}

/**
 * The engine gives up on the tool call and moves on, which writes exactly one thing: the result.
 *
 * Mirrors the ingestion's own update — output, `is_error`, `finished_at`, matched on
 * (sessionId, toolUseId) — because that is the only trace this failure leaves. The approval row is
 * deliberately not touched: nothing in the product writes to it here, and a spec that tidied it up
 * would be testing a cleanup nobody performs.
 */
async function theEngineAbandonsTheCall(db: PrismaClient, f: Fixture): Promise<void> {
  const updated = await db.toolCall.updateMany({
    where: { sessionId: f.coordinatorSessionId, toolUseId: askToolUseId(f) },
    data: {
      output: { content: 'the user did not answer in time' },
      isError: true,
      finishedAt: new Date(),
    },
  });
  assert.equal(updated.count, 1, 'the abandoned call was never recorded against its tool_use id');
}

/**
 * The engine's turn is reclaimed while the card is still open.
 *
 * What the control plane sees of it is a runtime handshake, which clears `engine_turn_active`, and
 * a conversation that parks with the message it was sent still unanswered. Nothing is written to
 * the approval and nothing answers the tool call: this failure is the one that leaves NO trace on
 * the question at all, which is why it is a separate case from the one above.
 */
async function theTurnIsReclaimed(db: PrismaClient, f: Fixture): Promise<void> {
  await db.session.update({
    where: { id: f.coordinatorSessionId },
    data: { status: RunStatus.AWAITING_INPUT, engineTurnActive: false },
  });
}

/** What the browser is offered when it asks for this conversation's pending approvals. */
function cardsOffered(stack: Stack, f: Fixture) {
  return stack.sessions.listApprovals(f.ownerId, f.coordinatorSessionId, 'PENDING');
}

/** What the decision rail shows one window, through the door the rail itself calls. */
async function railFor(stack: Stack, f: Fixture, sessionId: string) {
  const queue = await stack.evidence.pending(f.ownerId, sessionId);
  return queue.pending.map((row) => ({ taskId: row.taskId, revision: row.evidenceRevision }));
}

/** The one row this fixture's rail should be carrying. */
function theQuestion(f: Fixture) {
  return [{ taskId: f.taskId, revision: '1' }];
}

/** Both windows, so "a human-visible surface" is not one privileged reader. */
async function bothRails(stack: Stack, f: Fixture) {
  return {
    coordinator: await railFor(stack, f, f.coordinatorSessionId),
    otherWindow: await railFor(stack, f, f.readerSessionId),
  };
}

test('the engine abandons the card: it stops being offered, and the rail still has the question',
  { skip, timeout: 300_000 }, async () => {
    const stack = await connect();
    try {
      const f = await fixture(stack.db, 'abandoned');
      await submitEvidence(stack, f, 'abandoned');

      const told = await coordinatorMessages(stack.db, f);
      assert.equal(told.length, 1, 'the coordinator conversation was never told about the evidence');

      await theRunnerTakesTheTurn(stack.db, f);
      const approvalId = await theModelAsks(stack, f);

      // The paired positive: while the turn is running and the call has no result, this IS the
      // live question, and the browser is offered it.
      const live = await cardsOffered(stack, f);
      assert.deepEqual(
        live.map((card) => card.id), [approvalId],
        'the card was not offered while the question was still live',
      );
      assert.equal(live[0]!.toolName, EVIDENCE_ASK_TOOL);

      await theEngineAbandonsTheCall(stack.db, f);

      // Nothing was written to the approval — the row is still PENDING, and the conversation is
      // still generating, so the ONLY thing that changed is the committed fact that the call this
      // card was raised for already has its result.
      const row = await stack.db.approval.findUniqueOrThrow({ where: { id: approvalId } });
      assert.equal(row.status, 'PENDING');
      assert.equal(row.decidedAt, null);
      assert.equal(
        (await stack.db.session.findUniqueOrThrow({ where: { id: f.coordinatorSessionId } })).status,
        RunStatus.RUNNING,
      );
      assert.deepEqual(
        await cardsOffered(stack, f), [],
        'a card whose call the engine already answered is still offered as the live question',
      );

      // And the fallback: the question is on the rail, in both windows.
      assert.deepEqual(await bothRails(stack, f), {
        coordinator: theQuestion(f),
        otherWindow: theQuestion(f),
      }, 'the unanswered evidence fell off the rail');

      // The control that makes the assertion above mean something: an answer takes it off.
      await stack.evidence.decide(
        f.ownerId,
        f.taskId,
        { type: CreatorType.AGENT, id: f.workspaceId },
        { decidingSessionId: f.coordinatorSessionId, decision: 'CONFIRM', evidenceRevision: '1' },
      );
      assert.deepEqual(await bothRails(stack, f), { coordinator: [], otherWindow: [] });
    } finally {
      await stack.db.$disconnect();
    }
  });

test('the turn is reclaimed: the card goes with it, and the rail still has the question',
  { skip, timeout: 300_000 }, async () => {
    const stack = await connect();
    try {
      const f = await fixture(stack.db, 'reclaimed');
      await submitEvidence(stack, f, 'reclaimed');
      await theRunnerTakesTheTurn(stack.db, f);
      const approvalId = await theModelAsks(stack, f);
      assert.deepEqual((await cardsOffered(stack, f)).map((card) => card.id), [approvalId]);

      await theTurnIsReclaimed(stack.db, f);

      // This failure leaves no mark on the question at all: the approval is untouched and the call
      // it was raised for never got a result. What says the card is dead is the conversation.
      const row = await stack.db.approval.findUniqueOrThrow({ where: { id: approvalId } });
      assert.equal(row.status, 'PENDING');
      assert.equal(
        (await stack.db.toolCall.findFirstOrThrow({
          where: { sessionId: f.coordinatorSessionId, toolUseId: askToolUseId(f) },
        })).finishedAt,
        null,
        'the reclaimed turn answered the tool call, which is the other case',
      );
      assert.deepEqual(
        await cardsOffered(stack, f), [],
        'a card left behind by a reclaimed turn is still offered as the live question',
      );

      // The message it was sent is still in the inbox, unread. Nothing re-delivers it: the wake
      // that carried the fact is spent and holds its key.
      assert.deepEqual(
        (await coordinatorMessages(stack.db, f)).map((turn) => turn.status), ['PENDING'],
      );
      assert.deepEqual(await bothRails(stack, f), {
        coordinator: theQuestion(f),
        otherWindow: theQuestion(f),
      }, 'the evidence behind a reclaimed turn fell off the rail');

      // The control, through the clause a CONFIRM does not need: a SEND_BACK leaves the task OPEN
      // and the row still leaves the rail, because the latest revision now has an answer.
      await stack.evidence.decide(
        f.ownerId,
        f.taskId,
        { type: CreatorType.AGENT, id: f.workspaceId },
        {
          decidingSessionId: f.coordinatorSessionId,
          decision: 'SEND_BACK',
          evidenceRevision: '1',
          note: 'name the artifact the command wrote, and quote the line that names it',
        },
      );
      assert.equal(
        (await stack.db.task.findUniqueOrThrow({ where: { id: f.taskId } })).status,
        TaskStatus.IN_PROGRESS,
        'the send-back settled the task, so the control below proves the wrong clause',
      );
      assert.deepEqual(await bothRails(stack, f), { coordinator: [], otherWindow: [] });
    } finally {
      await stack.db.$disconnect();
    }
  });

test('no live runner: the message waits unread, no card is ever raised, and the rail has the question',
  { skip, timeout: 300_000 }, async () => {
    const stack = await connect();
    try {
      const f = await fixture(stack.db, 'norunner');
      // The state this case is about, established before the fact is routed: the conversation of
      // record has no runner behind it, so nothing will pick the message up.
      await stack.db.runner.update({
        where: { id: f.runnerId },
        data: {
          status: RunnerStatus.OFFLINE,
          lastHeartbeatAt: new Date(Date.now() - 6 * 60 * 60 * 1000),
        },
      });

      await submitEvidence(stack, f, 'norunner');

      // The delivery still happened — the message is a row, not a live call — and it is sitting
      // where a conversation nobody is running leaves it.
      assert.deepEqual(
        (await coordinatorMessages(stack.db, f)).map((turn) => turn.status), ['PENDING'],
        'the fact reached no inbox at all, which is a different failure',
      );
      assert.equal(
        await stack.db.approval.count({ where: { sessionId: f.coordinatorSessionId } }), 0,
        'a card was raised by a conversation that is not running',
      );
      // The wake is spent: recorded against its consumer, holding its key. There is no second
      // delivery to wait for, which is why the read below is the whole of the fallback.
      const wakes = await stack.db.projectCoordinatorWake.findMany({
        where: { projectId: f.projectId, event: 'COMPLETION_EVIDENCE_REVISED' },
        select: { status: true, refusalCode: true },
      });
      assert.deepEqual(wakes, [{ status: 'CONSUMED', refusalCode: null }]);

      assert.deepEqual(await bothRails(stack, f), {
        coordinator: theQuestion(f),
        otherWindow: theQuestion(f),
      }, 'evidence delivered to a conversation with no runner fell off the rail');

      // The paired positive for the zero above: the door that raises a card is not broken, it was
      // never reached. A runner coming back finds the message still queued and can still ask.
      await stack.db.runner.update({
        where: { id: f.runnerId },
        data: { status: RunnerStatus.ONLINE, lastHeartbeatAt: new Date() },
      });
      await theRunnerTakesTheTurn(stack.db, f);
      const approvalId = await theModelAsks(stack, f);
      assert.deepEqual((await cardsOffered(stack, f)).map((card) => card.id), [approvalId]);

      // And the control: an answer takes the question off the rail.
      await stack.evidence.decide(
        f.ownerId,
        f.taskId,
        { type: CreatorType.AGENT, id: f.workspaceId },
        { decidingSessionId: f.coordinatorSessionId, decision: 'CONFIRM', evidenceRevision: '1' },
      );
      assert.deepEqual(await bothRails(stack, f), { coordinator: [], otherWindow: [] });
    } finally {
      await stack.db.$disconnect();
    }
  });

/** A source file, read from the tree this build came from. */
function source(relative: string): string {
  return readFileSync(path.resolve(__dirname, '../../src', relative), 'utf8');
}

/**
 * The chosen reason lives with the implementation, not only in the design document.
 *
 * Deliberately NOT skipped with the rest of this file. The reason is the whole of what this task
 * implemented — the fallback itself is a read that was already there — so a check that only runs
 * when a disposable PostgreSQL is configured would let the one thing being added go unwitnessed by
 * the acceptance command. Sentences rather than paragraphs, so a re-wording of the surrounding
 * prose does not fail it, but deleting the argument does.
 */
test('the reason the fallback was chosen is written where the fallback is', () => {
  const delivery = source('projects/coordinator-delivery.service.ts');
  assert.match(
    delivery, /AN UNANSWERED QUESTION IS NOT A FAILED DELIVERY/,
    'the delivery unit does not say that a question nobody answered is not a delivery that failed',
  );
  assert.match(
    delivery, /deadline is the ENGINE's/,
    'the delivery unit does not say whose deadline the unanswered question ran out of',
  );
  assert.match(
    delivery, /readPendingEvidenceJudgments/,
    'the delivery unit does not name what catches a card nobody answers',
  );

  const read = source('tasks/pending-evidence-judgments.ts');
  assert.match(
    read, /FALLBACK/,
    'the derived read does not say it is the floor under the coordinator card',
  );
  assert.match(
    read, /permanent silence/,
    'the derived read does not say what deleting it would cost',
  );
});

test('the coordinator-evidence PostgreSQL target is explicitly disposable', { skip }, () => {
  assertCoordinatorPgUrlIsIsolated(URL);
});
