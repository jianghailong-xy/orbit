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

import { RunEventType, RunStatus as SharedRunStatus, uuidToBase62 } from '@orbit/shared';

import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { QueueService } from '../queue/queue.service';
import { RealtimeService } from '../realtime/realtime.service';
import { RunnerApiController } from '../runner-api/runner-api.controller';
import { SessionsService } from '../sessions/sessions.service';
import { EvidenceReviewService } from '../tasks/evidence-review.service';
import {
  countPendingEvidenceJudgments,
  readPendingEvidenceJudgments,
} from '../tasks/pending-evidence-judgments';
import { TaskCompletionEvidenceService } from '../tasks/task-completion-evidence.service';
import { TasksService } from '../tasks/tasks.service';
import { CompletionEvidenceProducer } from './completion-evidence.producer';
import { CompletionInputRouter } from './completion-input-router.service';
import { CoordinatorConvergenceService } from './coordinator-convergence.service';
import {
  DELIVERY_COORDINATOR_PAUSED,
  CoordinatorDeliveryService,
  coordinatorDeliveryTurnId,
  coordinatorRedeliveryTurnId,
} from './coordinator-delivery.service';
import { CoordinatorEvidenceQueueService } from './coordinator-evidence-queue.service';
import { CoordinatorJudgmentService } from './coordinator-judgment.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from './coordinator-pg-test-safety';
import { CoordinatorWakeService } from './coordinator-wake.service';
import { CriterionReadyProducer } from './criterion-ready.producer';
import { CriterionUnlandedProducer } from './criterion-unlanded.producer';
import { DependentReadyProducer } from './dependent-ready.producer';
import { readOwnerDecisionSignals } from './owner-decision-signal';
import { ProjectAcceptanceService } from './project-acceptance.service';
import { criterionKeyOf } from './project-acceptance';
import { PROJECT_FUSE_PAUSED } from './project-fuse';
import { ProjectOpenItemService } from './project-open-item.service';
import { ProjectsService } from './projects.service';
import { ProjectTasksSettledProducer } from './project-tasks-settled.producer';
import { TaskDispatchRefusalProducer } from './task-dispatch-refusal.producer';
import { TaskExceptionInputProducer } from './task-exception-input.producer';
import { WakeDispositionService } from './wake-disposition.service';

/**
 * WHILE AN AUTOMATIC PROJECT'S COORDINATOR IS PAUSED, ITS EVIDENCE WAITS FOR IT.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/projects/evidence-waits-for-coordinator.pg.spec.ts
 *
 * WHAT CHANGED (docs/evidence-waits-for-coordinator-design.md, owner's decision of 2026-10-09)
 * =========================================================================================
 * A coordinator whose run failed on its usage limit — FAILED, nobody ended it — was treated as a
 * coordinator that had ended: a revision submitted meanwhile was refused delivery and was the owner's
 * card at once, a revision delivered before it stopped stopped being held the moment it did, and
 * nothing handed either to it once it was back. Now such a coordinator is PAUSED, as one parked on a
 * retry is, and the revision waits for it: in nobody's `pending`, counted nowhere, listed for the
 * coordinator's conversation in `waitingOnCoordinator`, and handed over — oldest first, with a
 * sentence saying it waited — when a turn of the conversation ends, when the conversation is
 * replaced, and on the task service's tick for one that is back and idle.
 *
 * Every case drives the doors production drives: the evidence ledger's submit, the runner's
 * turn-complete for the coordinator's own turns, `sessions.resume` for a retry, the owner's decision
 * door, `ProjectsService.coordinator` for a replacement and `TasksService`'s own timer for the tick.
 * Each "the owner is asked" is paired with a "the owner is not asked" over the same read.
 *
 * Not destructive: every case owns freshly generated ids and asserts over its own rows.
 */
const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

/** The criterion every task here is measured against, quoted verbatim by every envelope. */
const STANDARD = 'the declared command exits zero and its output names the artifact';

/** The default `exceptionEscalationSeconds` (migration 0278), which every fixture starts on. */
const ESCALATION_SECONDS = 7200;

/** What the coordinator's account answered on 2026-10-09 at 18:08 — the turn that put it down. */
const WEEKLY_LIMIT = "You've hit your weekly limit · resets Oct 12, 7pm (Asia/Shanghai)";

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
  /** The evidence ledger holding the router with every door, the way the module wires it. */
  evidence: TaskCompletionEvidenceService;
  /** What hands a coordinator the evidence that waited for it. */
  waiting: CoordinatorEvidenceQueueService;
  /** The runner's door, for the coordinator's own turns: their ends are where waiting evidence goes. */
  api: RunnerApiController;
  /** Built with the waiting-evidence sweep its reconcile timer runs. */
  tasks: TasksService;
  projects: ProjectsService;
}

/** The production wiring, over one client. The notification transports are the only stand-ins. */
async function connect(): Promise<Stack> {
  await verifyDisposableDatabase();
  const db = prismaClientFor(URL!);
  const prisma = db as unknown as PrismaService;
  const realtime = new Proxy({}, { get: () => () => undefined }) as unknown as RealtimeService;
  const queue = { notifySessionQueued: () => undefined } as unknown as QueueService;
  const sessions = new SessionsService(prisma, queue, realtime);
  const wakes = new CoordinatorWakeService(prisma);
  const convergence = new CoordinatorConvergenceService(prisma);
  const deliveries = new CoordinatorDeliveryService(prisma, wakes, sessions);
  const judgments = new CoordinatorJudgmentService(prisma, wakes, sessions);
  const producer = new CompletionEvidenceProducer(prisma, convergence, deliveries);
  const router = new CompletionInputRouter(
    wakes,
    new ProjectTasksSettledProducer(prisma, judgments, convergence, deliveries),
    new TaskExceptionInputProducer(prisma, convergence),
    new CriterionReadyProducer(prisma, convergence),
    new WakeDispositionService(prisma, judgments, deliveries),
    new CriterionUnlandedProducer(prisma, convergence),
    new TaskDispatchRefusalProducer(prisma, convergence, deliveries),
    new DependentReadyProducer(prisma, convergence, deliveries),
    undefined,
    producer,
  );
  const waiting = new CoordinatorEvidenceQueueService(prisma, producer);
  const openItems = new ProjectOpenItemService(prisma, sessions);
  const tasks = new TasksService(
    prisma, sessions, realtime, undefined, router, undefined, openItems, undefined, queue, waiting,
  );
  const push = new Proxy({}, { get: () => async () => undefined }) as never;
  const api = new RunnerApiController(
    prisma,
    queue,
    realtime,
    push,
    {} as never,
    { expand: async (_ownerId: string, content?: string) => content } as never,
    { appendFor: async (_tx: unknown, _sessionId: string, content?: string) => content } as never,
    undefined,
    undefined,
    tasks,
    undefined,
    sessions,
    openItems,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    waiting,
  );
  return {
    db,
    prisma,
    sessions,
    evidence: new TaskCompletionEvidenceService(
      prisma, undefined, router, undefined, new EvidenceReviewService(prisma, sessions),
    ),
    waiting,
    api,
    tasks,
    projects: new ProjectsService(
      prisma, new ProjectAcceptanceService(prisma), sessions, realtime, openItems, convergence, waiting,
    ),
  };
}

interface Ids {
  ownerId: string;
  runnerId: string;
  workspaceId: string;
}

interface JudgedTask {
  taskId: string;
  title: string;
  /** The run doing the work — the one that submits its evidence. */
  runSessionId: string;
  /** The tool call its evidence cites. */
  cited: string;
}

interface World extends Ids, JudgedTask {
  projectId: string;
  definitionId: string;
  coordinatorSessionId: string;
  /** The coordinator's own turn in flight, when it was created RUNNING. */
  runningTurnId: string | null;
  /** A conversation of the same owner that took part in nothing. */
  readerSessionId: string;
  criterionKey: string;
}

/** One conversation with its opening prompt as a turn, so nothing below is what seeds it. */
async function conversation(
  db: PrismaClient,
  ids: Ids,
  title: string,
  options: { taskId?: string } = {},
): Promise<string> {
  const id = randomUUID();
  await db.session.create({
    data: {
      id,
      ownerId: ids.ownerId,
      creatorId: ids.ownerId,
      workspaceId: ids.workspaceId,
      assignedRunnerId: ids.runnerId,
      taskId: options.taskId,
      startsTaskWork: options.taskId !== undefined,
      title,
      prompt: title,
      provider: 'claude',
      status: RunStatus.AWAITING_INPUT,
      dispatchOrigin: SessionDispatchOrigin.USER,
    },
  });
  await db.conversationTurn.create({
    data: {
      sessionId: id,
      seq: 1,
      clientTurnId: SessionsService.initialTurnClientId(id),
      kind: 'message',
      content: title,
      status: 'ANSWERED',
    },
  });
  return id;
}

/** An EVIDENCE_JUDGMENT task filed under the project, the run working it, and a check to cite. */
async function judgedTask(
  db: PrismaClient,
  ids: Ids & { projectId: string; definitionId: string },
  label: string,
): Promise<JudgedTask> {
  const taskId = randomUUID();
  const title = `${label}: work that submits evidence`;
  await db.task.create({
    data: {
      id: taskId,
      ownerId: ids.ownerId,
      projectId: ids.projectId,
      title,
      creatorType: CreatorType.USER,
      creatorId: ids.ownerId,
      assigneeId: ids.workspaceId,
      status: TaskStatus.IN_PROGRESS,
      completionCriterion: 'EVIDENCE_JUDGMENT',
      acceptanceCriteria: STANDARD,
      criterionDefinitionId: ids.definitionId,
      criterionRevision: 1,
    },
  });
  const runSessionId = await conversation(db, ids, `${label}: the run`, { taskId });
  const cited = `toolu_${label.replace(/[^a-z0-9]/gi, '_')}_${taskId.slice(0, 8)}`;
  await db.toolCall.create({
    data: {
      sessionId: runSessionId,
      name: 'Bash',
      toolUseId: cited,
      input: { command: 'npm test', description: 'the command this evidence is about' },
      isError: false,
    },
  });
  return { taskId, title, runSessionId, cited };
}

/**
 * One owner with an online runner and a workspace, one Automatic project stating one criterion, the
 * conversation it is coordinated from — between turns (`PARKED`) or running one (`RUNNING`), which is
 * the state a coordinator is in when a usage limit takes it down — an unrelated reader, and one task
 * to judge.
 */
async function world(
  stack: Stack,
  label: string,
  options: { coordinator?: 'PARKED' | 'RUNNING'; coordinatorEnabled?: boolean } = {},
): Promise<World> {
  const db = stack.db;
  const ids: Ids = { ownerId: randomUUID(), runnerId: randomUUID(), workspaceId: randomUUID() };
  await db.user.create({
    data: {
      id: ids.ownerId,
      email: `${label}-${ids.ownerId}@evidence-waits.invalid`,
      name: label,
      passwordHash: 'x',
    },
  });
  await db.runner.create({
    data: {
      id: ids.runnerId,
      ownerId: ids.ownerId,
      name: `${label}-runner`,
      tokenHash: `hash-${ids.runnerId}`,
      status: RunnerStatus.ONLINE,
      capabilities: [],
      capabilitiesReportedAt: new Date(),
      lastHeartbeatAt: new Date(),
    },
  });
  await db.workspace.create({
    data: { id: ids.workspaceId, ownerId: ids.ownerId, runnerId: ids.runnerId, name: `${label}-ws`, enabled: true },
  });
  const readerSessionId = await conversation(db, ids, `${label}: another conversation`);

  const running = (options.coordinator ?? 'PARKED') === 'RUNNING';
  const coordinatorSessionId = randomUUID();
  await db.session.create({
    data: {
      id: coordinatorSessionId,
      ownerId: ids.ownerId,
      creatorId: ids.ownerId,
      workspaceId: ids.workspaceId,
      assignedRunnerId: ids.runnerId,
      title: `coordinator: ${label}`,
      prompt: `coordinator: ${label}`,
      provider: 'claude',
      status: running ? RunStatus.RUNNING : RunStatus.AWAITING_INPUT,
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
  const runningTurnId = running ? randomUUID() : null;
  if (runningTurnId) {
    await db.conversationTurn.create({
      data: {
        id: runningTurnId,
        sessionId: coordinatorSessionId,
        seq: 2,
        clientTurnId: `message:${runningTurnId}`,
        kind: 'message',
        content: 'look at the project',
        status: 'IN_FLIGHT',
        deliveredAt: new Date(),
      },
    });
  }

  const projectId = randomUUID();
  await db.project.create({
    data: {
      id: projectId,
      ownerId: ids.ownerId,
      title: `${label}: the coordinator decides its evidence`,
      coordinatorEnabled: options.coordinatorEnabled ?? true,
      coordinatorWorkspaceId: ids.workspaceId,
      coordinatorSessionId,
    },
  });
  await db.projectRuntime.upsert({ where: { projectId }, create: { projectId }, update: {} });
  const definitionId = randomUUID();
  await db.projectAcceptanceCriterionDefinition.create({
    data: {
      id: definitionId,
      projectId,
      ordinal: 1,
      text: STANDARD,
      verificationMethod: 'EVIDENCE_JUDGMENT: read the command and its output',
      contentHash: '0'.repeat(64),
    },
  });
  const judged = await judgedTask(db, { ...ids, projectId, definitionId }, label);
  return {
    ...ids,
    ...judged,
    projectId,
    definitionId,
    coordinatorSessionId,
    runningTurnId,
    readerSessionId,
    criterionKey: criterionKeyOf(definitionId),
  };
}

/** Submit one revision of the four-field envelope, quoting the live criterion, from the task's run. */
function submit(stack: Stack, w: World, task: JudgedTask = w, key = `evidence-${task.taskId}-1`) {
  return stack.evidence.submit(
    w.ownerId,
    task.taskId,
    { type: CreatorType.AGENT, id: w.workspaceId },
    {
      sourceSessionId: task.runSessionId,
      idempotencyKey: key,
      evidence: {
        claim: 'the declared command ran and its output names dist/server.js',
        criterion: { key: w.criterionKey, text: STANDARD },
        checks: [{ kind: 'TOOL_CALL', ref: task.cited, command: 'npm test', succeeded: true }],
        gaps: ['did not run the suite on a second machine'],
      },
    },
  );
}

/** When the task's latest revision was submitted — the moment the coordinator is told it waited since. */
async function submittedAt(db: PrismaClient, taskId: string): Promise<Date> {
  const latest = await db.taskCompletionEvidence.findFirstOrThrow({
    where: { taskId },
    orderBy: { revision: 'desc' },
    select: { submittedAt: true },
  });
  return latest.submittedAt;
}

/** The sentence a revision that waited is handed over with. */
function waitedSentence(at: Date): string {
  return `This revision was submitted at ${at.toISOString()} while you were unavailable. `
    + 'It waited for you; nobody has decided it yet.';
}

/** The wake ledger's rows for one task's evidence revisions, oldest first. */
function evidenceWakes(db: PrismaClient, taskId: string) {
  return db.projectCoordinatorWake.findMany({
    where: { event: 'COMPLETION_EVIDENCE_REVISED', subjectType: 'TASK', subjectId: taskId },
    select: {
      id: true,
      idempotencyKey: true,
      status: true,
      refusalCode: true,
      sessionId: true,
      delivery: true,
      updatedAt: true,
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
}

/** The turns on a conversation that ask it to decide this task's evidence, oldest first. */
async function evidenceMessages(db: PrismaClient, sessionId: string, taskId: string) {
  const turns = await db.conversationTurn.findMany({
    where: { sessionId },
    select: { clientTurnId: true, content: true, status: true, deliveredAt: true },
    orderBy: { seq: 'asc' },
  });
  return turns.filter((turn) => (turn.content ?? '').includes('task_evidence_decide')
    && (turn.content ?? '').includes(uuidToBase62(taskId)));
}

function judgmentSessions(db: PrismaClient, ownerId: string) {
  return db.session.findMany({
    where: { ownerId, dispatchOrigin: SessionDispatchOrigin.PROJECT_COORDINATOR, deletedAt: null },
    select: { id: true },
  });
}

/** The evidence read as the app makes it for one conversation, at `readAt`. */
function readFor(stack: Stack, w: World, sessionId: string, readAt?: Date) {
  return readPendingEvidenceJudgments(stack.prisma, w.ownerId, { id: sessionId, taskId: null }, readAt);
}

/** The tasks the owner's card is drawn for in the coordinator's conversation. */
async function ownerAsked(stack: Stack, w: World, readAt?: Date): Promise<string[]> {
  return (await readFor(stack, w, w.coordinatorSessionId, readAt)).pending.map((row) => row.taskId);
}

/** The "Needs you" evidence count keyed on this project's coordinator conversation. */
async function ownerCount(stack: Stack, w: World, readAt?: Date): Promise<number> {
  const counts = await countPendingEvidenceJudgments(
    stack.prisma,
    w.ownerId,
    [{ projectId: w.projectId, session: { id: w.coordinatorSessionId, taskId: null } }],
    readAt,
  );
  return counts.get(w.projectId) ?? 0;
}

/** What the session list's badge counts on the coordinator's row, through the production read. */
async function badge(stack: Stack, w: World): Promise<number> {
  const signals = await readOwnerDecisionSignals(stack.prisma, w.ownerId);
  return signals
    .filter((signal) => signal.sessionId === w.coordinatorSessionId && signal.kind === 'PROJECT_DECISION')
    .reduce((sum, signal) => sum + signal.count, 0);
}

/** The tasks listed as waiting for the coordinator, in the coordinator's own conversation. */
async function waitingFor(stack: Stack, w: World, sessionId = w.coordinatorSessionId): Promise<string[]> {
  return (await readFor(stack, w, sessionId)).waitingOnCoordinator.map((row) => row.taskId);
}

function dequeue(stack: Stack, sessionId: string, runnerId: string) {
  return (stack.api as unknown as {
    dequeueTurn: (
      sessionId: string,
      runnerId: string,
      leaseGeneration: string | null,
    ) => Promise<{ turnId: string; kind: string; content?: string } | null>;
  }).dequeueTurn(sessionId, runnerId, null);
}

/** The engine's reply to a turn it ran, up the door the runner posts its transcript to. */
async function answerTurn(stack: Stack, w: World, sessionId: string, turnId: string, text: string) {
  const last = await stack.db.runEvent.aggregate({ where: { sessionId }, _max: { seq: true } });
  await stack.api.events({ id: w.runnerId }, sessionId, {
    events: [{
      seq: (last._max.seq ?? 0) + 1,
      type: RunEventType.ASSISTANT,
      ts: new Date().toISOString(),
      turnId,
      payload: { text },
    }],
  });
}

/**
 * The coordinator's running turn fails the way a spent weekly limit fails it, reported through the
 * door the runner reports it on: FAILED, no end recorded, still Open — down, not over.
 */
async function knockDown(stack: Stack, w: World): Promise<void> {
  assert.ok(w.runningTurnId, 'only a running coordinator can be knocked down');
  const outcome = await stack.api.turnComplete({ id: w.runnerId }, w.coordinatorSessionId, {
    turnId: w.runningTurnId,
    status: SharedRunStatus.FAILED,
    result: WEEKLY_LIMIT,
  });
  assert.deepEqual(outcome, { ok: true, status: RunStatus.FAILED });
}

/** The owner retries the coordinator: the conversation is revived with a turn of its own. */
async function revive(stack: Stack, w: World): Promise<string> {
  const retried = await stack.sessions.resume(w.ownerId, w.coordinatorSessionId, {
    clientTurnId: randomUUID(),
    content: 'carry on',
  });
  return retried.turnId;
}

/**
 * The runner's claim of the queued conversation, written by hand as a current replica writes it: one
 * that reads the session's engine (migration 0414's acquisition guard), and owned by the process this
 * fixture reports as.
 */
async function claim(stack: Stack, w: World): Promise<void> {
  await stack.db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('orbit.claim_reads_session_engine', '1', true)`;
    await tx.session.updateMany({
      where: { id: w.coordinatorSessionId, status: RunStatus.PENDING },
      data: { status: RunStatus.RUNNING, inboxLeaseOwner: null },
    });
  });
}

/** The runner claims the conversation, runs `turnId` and reports it done: the committed turn end. */
async function runToTheEnd(stack: Stack, w: World, turnId: string): Promise<void> {
  await claim(stack, w);
  const delivered = await dequeue(stack, w.coordinatorSessionId, w.runnerId);
  assert.equal(delivered?.turnId, turnId, 'the turn the runner was handed is not the one expected');
  await endTurn(stack, w, turnId);
}

/** A turn the runner was handed is answered and reported done. */
async function endTurn(stack: Stack, w: World, turnId: string): Promise<void> {
  await answerTurn(stack, w, w.coordinatorSessionId, turnId, 'back on the project');
  await stack.api.turnComplete({ id: w.runnerId }, w.coordinatorSessionId, {
    turnId,
    status: SharedRunStatus.SUCCEEDED,
  });
}

// -------------------------------------------------------------------------------------------------

test('a revision submitted while the coordinator is down waits for it: not asked of the owner, not counted, listed as waiting',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'down-at-submit', { coordinator: 'RUNNING' });
      const badgeBefore = await badge(stack, w);
      await knockDown(stack, w);

      await submit(stack, w);

      // Refused on the pause, in front of the convergence ledger, and nothing reached the conversation.
      const [row, ...more] = await evidenceWakes(stack.db, w.taskId);
      assert.deepEqual(more, [], 'the revision reached the ledger other than once');
      assert.equal(row!.status, 'REFUSED');
      assert.equal(row!.refusalCode, DELIVERY_COORDINATOR_PAUSED);
      assert.equal(row!.sessionId, null);
      assert.deepEqual(await evidenceMessages(stack.db, w.coordinatorSessionId, w.taskId), []);
      assert.equal(await stack.db.projectConvergenceDecision.count({ where: { projectId: w.projectId } }), 0);
      const coordinator = await stack.db.session.findUniqueOrThrow({ where: { id: w.coordinatorSessionId } });
      assert.equal(coordinator.status, RunStatus.FAILED, 'the coordinator was revived to be told');

      // Not the owner's: not in the card's read, not in the count, not on the badge.
      assert.deepEqual(await ownerAsked(stack, w), []);
      assert.equal(await ownerCount(stack, w), 0);
      assert.equal(await badge(stack, w), badgeBefore, 'Needs you counted a revision that waits for the coordinator');
      assert.deepEqual(await ownerAsked(stack, w, new Date(Date.now() + (ESCALATION_SECONDS + 60) * 1_000)), [],
        'no clock runs while the coordinator is paused');

      // Listed as waiting in the coordinator's conversation, shaped as a pending row is.
      const read = await readFor(stack, w, w.coordinatorSessionId);
      assert.deepEqual(read.waitingOnCoordinator.map((r) => r.taskId), [w.taskId]);
      const [waiting] = read.waitingOnCoordinator;
      assert.equal(waiting!.title, w.title);
      assert.equal(waiting!.projectId, w.projectId);
      assert.equal(waiting!.evidenceRevision, '1');
      assert.deepEqual(waiting!.criterion, { key: w.criterionKey, text: STANDARD });
      assert.deepEqual(waiting!.decidability, { decidable: true, refusal: null, requiredAction: null });
      assert.equal(waiting!.independence.independent, true);
      assert.deepEqual(waiting!.gaps, ['did not run the suite on a second machine']);
      assert.equal(read.count, 0);
      assert.equal(read.oldestAgeSeconds, null);
      assert.deepEqual(read.sentToCoordinator, []);
      // ...and for nobody else.
      const reader = await readFor(stack, w, w.readerSessionId);
      assert.deepEqual(reader.waitingOnCoordinator, []);
      assert.deepEqual(reader.pending.filter((r) => r.taskId === w.taskId), []);
    } finally {
      await stack.db.$disconnect();
    }
  });

test('a revision submitted while the coordinator is parked on a retry waits too, writes no turn and leaves the retry armed',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'retry-armed');
      const retryAt = new Date(Date.now() + 3 * 3_600_000);
      await stack.db.session.update({ where: { id: w.coordinatorSessionId }, data: { retryAt } });
      const turnsBefore = await stack.db.conversationTurn.count({ where: { sessionId: w.coordinatorSessionId } });

      await submit(stack, w);

      const [row] = await evidenceWakes(stack.db, w.taskId);
      assert.equal(row!.status, 'REFUSED');
      assert.equal(row!.refusalCode, DELIVERY_COORDINATOR_PAUSED);
      assert.equal(await stack.db.conversationTurn.count({ where: { sessionId: w.coordinatorSessionId } }), turnsBefore,
        'a turn was written to a conversation parked on a retry');
      const parked = await stack.db.session.findUniqueOrThrow({ where: { id: w.coordinatorSessionId } });
      assert.equal(parked.retryAt?.getTime(), retryAt.getTime(), 'the retry was disarmed');
      assert.equal(parked.status, RunStatus.AWAITING_INPUT);

      assert.deepEqual(await ownerAsked(stack, w), []);
      assert.equal(await ownerCount(stack, w), 0);
      assert.deepEqual(await waitingFor(stack, w), [w.taskId]);

      // A turn end while it is still parked hands nothing over either.
      await stack.waiting.deliverOwedTo(w.coordinatorSessionId);
      assert.equal(await stack.db.conversationTurn.count({ where: { sessionId: w.coordinatorSessionId } }), turnsBefore);
      assert.equal(
        (await stack.db.session.findUniqueOrThrow({ where: { id: w.coordinatorSessionId } })).retryAt?.getTime(),
        retryAt.getTime(),
      );
    } finally {
      await stack.db.$disconnect();
    }
  });

test('once the coordinator is back and its turn ends, the waiting revision is delivered, says it waited, and is held from then',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'back', { coordinator: 'RUNNING' });
      await knockDown(stack, w);
      await submit(stack, w);
      const submitted = await submittedAt(stack.db, w.taskId);
      assert.deepEqual(await waitingFor(stack, w), [w.taskId]);

      // Back: revived, queued, claimed, running its turn. Until that turn ends nothing is handed over,
      // and the owner is still not asked.
      const turnId = await revive(stack, w);
      assert.deepEqual(await ownerAsked(stack, w), [], 'asked between the recovery and the end of its turn');
      assert.equal(await ownerCount(stack, w), 0);
      assert.deepEqual(await waitingFor(stack, w), [w.taskId]);
      assert.deepEqual(await evidenceMessages(stack.db, w.coordinatorSessionId, w.taskId), []);
      await claim(stack, w);
      assert.equal((await dequeue(stack, w.coordinatorSessionId, w.runnerId))?.turnId, turnId);
      assert.deepEqual(await ownerAsked(stack, w), [], 'asked while its first turn back was running');
      assert.equal(await ownerCount(stack, w), 0);

      await endTurn(stack, w, turnId);

      // One delivery, under the fact's own key, that says when it was submitted and that it waited.
      const wakes = await evidenceWakes(stack.db, w.taskId);
      assert.deepEqual(wakes.map((wake) => [wake.status, wake.refusalCode]), [
        ['REFUSED', DELIVERY_COORDINATOR_PAUSED],
        ['DELIVERED', null],
      ]);
      const delivered = wakes[1]!;
      assert.equal(delivered.sessionId, w.coordinatorSessionId);
      const turnKey = coordinatorDeliveryTurnId(delivered.idempotencyKey);
      assert.deepEqual(delivered.delivery, { clientTurnId: turnKey, waited: true });
      const messages = await evidenceMessages(stack.db, w.coordinatorSessionId, w.taskId);
      assert.equal(messages.length, 1, 'the coordinator was told other than once');
      assert.equal(messages[0]!.clientTurnId, turnKey);
      assert.ok(messages[0]!.content!.includes(waitedSentence(submitted)), messages[0]!.content!);
      assert.match(messages[0]!.content!, /evidenceRevision 传 "1"/);

      // Held from the delivery for the project's window, and listed as sent meanwhile.
      const deliveredAt = delivered.updatedAt.getTime();
      const justBefore = new Date(deliveredAt + ESCALATION_SECONDS * 1_000 - 1_000);
      assert.deepEqual(await ownerAsked(stack, w), []);
      assert.deepEqual(await ownerAsked(stack, w, justBefore), []);
      assert.equal(await ownerCount(stack, w, justBefore), 0);
      const read = await readFor(stack, w, w.coordinatorSessionId);
      assert.deepEqual(read.waitingOnCoordinator, []);
      assert.deepEqual(read.sentToCoordinator, [{
        taskId: w.taskId,
        title: w.title,
        projectId: w.projectId,
        evidenceRevision: '1',
        deliveredAt: delivered.updatedAt,
      }]);
      assert.deepEqual((await readFor(stack, w, w.readerSessionId)).sentToCoordinator, [],
        'sent is told to the conversation it was sent to, and nobody else');

      // And once the window has run out the owner is asked, as for any delivery.
      const due = new Date(deliveredAt + ESCALATION_SECONDS * 1_000);
      assert.deepEqual(await ownerAsked(stack, w, due), [w.taskId]);
      assert.equal(await ownerCount(stack, w, due), 1);
      assert.deepEqual((await readFor(stack, w, w.coordinatorSessionId, due)).sentToCoordinator, []);
    } finally {
      await stack.db.$disconnect();
    }
  });

test('a delivery the coordinator never read before it went down waits for it, and is delivered again once when it is back',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      // Delivered while the coordinator is busy: queued behind its running turn.
      const w = await world(stack, 'unread', { coordinator: 'RUNNING' });
      await submit(stack, w);
      const submitted = await submittedAt(stack.db, w.taskId);
      const [first] = await evidenceWakes(stack.db, w.taskId);
      assert.equal(first!.status, 'DELIVERED', `refused with ${first!.refusalCode}`);
      const firstKey = coordinatorDeliveryTurnId(first!.idempotencyKey);
      assert.deepEqual(first!.delivery, { clientTurnId: firstKey });

      // The running turn fails on the weekly limit, and its drain answers the queued delivery unread.
      await knockDown(stack, w);
      const [drained] = await evidenceMessages(stack.db, w.coordinatorSessionId, w.taskId);
      assert.equal(drained!.clientTurnId, firstKey);
      assert.equal(drained!.status, 'ANSWERED');
      assert.equal(drained!.deliveredAt, null, 'the drained delivery was read after all');

      // Still nobody else's: it waits for the coordinator, and no clock runs.
      assert.deepEqual(await ownerAsked(stack, w), []);
      assert.deepEqual(await ownerAsked(stack, w, new Date(Date.now() + (ESCALATION_SECONDS + 60) * 1_000)), []);
      assert.equal(await ownerCount(stack, w), 0);
      assert.deepEqual(await waitingFor(stack, w), [w.taskId]);

      // Back, and its turn ends: delivered again, under a key of its own, the hold restarting now.
      const turnId = await revive(stack, w);
      await runToTheEnd(stack, w, turnId);
      const [requeued, ...others] = await evidenceWakes(stack.db, w.taskId);
      assert.deepEqual(others, [], 'a second wake was claimed for a fact whose key is held');
      assert.equal(requeued!.status, 'DELIVERED');
      const secondKey = coordinatorRedeliveryTurnId(first!.idempotencyKey, firstKey);
      assert.deepEqual(requeued!.delivery, { clientTurnId: secondKey, waited: true, replaces: firstKey });
      assert.ok(requeued!.updatedAt.getTime() > first!.updatedAt.getTime(), 'the hold did not restart');
      let messages = await evidenceMessages(stack.db, w.coordinatorSessionId, w.taskId);
      assert.deepEqual(messages.map((m) => m.clientTurnId), [firstKey, secondKey]);
      assert.ok(messages[1]!.content!.includes(waitedSentence(submitted)));
      assert.deepEqual(await ownerAsked(stack, w), []);
      assert.deepEqual((await readFor(stack, w, w.coordinatorSessionId)).sentToCoordinator.map((s) => s.taskId),
        [w.taskId]);

      // Once: another turn end hands nothing over again — not while the re-sent turn is queued, and not
      // once the coordinator has read it.
      await stack.waiting.deliverOwedTo(w.coordinatorSessionId);
      assert.equal((await evidenceMessages(stack.db, w.coordinatorSessionId, w.taskId)).length, 2);
      const resent = await stack.db.conversationTurn.findFirstOrThrow({
        where: { sessionId: w.coordinatorSessionId, clientTurnId: secondKey },
        select: { id: true },
      });
      await runToTheEnd(stack, w, resent.id);
      messages = await evidenceMessages(stack.db, w.coordinatorSessionId, w.taskId);
      assert.deepEqual(messages.map((m) => m.clientTurnId), [firstKey, secondKey], 'delivered more than once');
      assert.equal((await evidenceWakes(stack.db, w.taskId)).length, 1);
      assert.deepEqual(await ownerAsked(stack, w), []);
    } finally {
      await stack.db.$disconnect();
    }
  });

test('a coordinator that is back and idle is handed what waits for it within one tick of the task service timer',
  { skip, timeout: 180_000 }, async (t) => {
    const stack = await connect();
    try {
      const w = await world(stack, 'idle');
      await stack.db.session.update({
        where: { id: w.coordinatorSessionId },
        data: { retryAt: new Date(Date.now() + 3_600_000) },
      });
      await submit(stack, w);
      const submitted = await submittedAt(stack.db, w.taskId);
      assert.deepEqual(await waitingFor(stack, w), [w.taskId]);

      // The retry it was parked on is withdrawn without a turn: live and idle, and no turn of its own
      // is going to end. Still waiting — nothing has handed it over yet.
      await stack.db.session.update({ where: { id: w.coordinatorSessionId }, data: { retryAt: null } });
      assert.deepEqual(await waitingFor(stack, w), [w.taskId]);
      assert.deepEqual(await evidenceMessages(stack.db, w.coordinatorSessionId, w.taskId), []);

      // One tick of the timer the task service owns.
      t.mock.timers.enable({ apis: ['setInterval'] });
      stack.tasks.onModuleInit();
      try {
        t.mock.timers.tick(60_000);
        const deadline = Date.now() + 60_000;
        while ((await evidenceMessages(stack.db, w.coordinatorSessionId, w.taskId)).length === 0) {
          assert.ok(Date.now() < deadline, 'one tick went by and the waiting revision was not delivered');
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      } finally {
        stack.tasks.onModuleDestroy();
        t.mock.timers.reset();
      }

      const messages = await evidenceMessages(stack.db, w.coordinatorSessionId, w.taskId);
      assert.equal(messages.length, 1);
      assert.ok(messages[0]!.content!.includes(waitedSentence(submitted)));
      const [, delivered] = await evidenceWakes(stack.db, w.taskId);
      assert.equal(delivered!.status, 'DELIVERED');
      assert.deepEqual(delivered!.delivery, { clientTurnId: messages[0]!.clientTurnId, waited: true });
      assert.deepEqual(await waitingFor(stack, w), []);
      assert.deepEqual(await ownerAsked(stack, w), []);
    } finally {
      await stack.db.$disconnect();
    }
  });

test('the revisions waiting for a coordinator that is replaced go to the conversation that replaces it',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'replaced', { coordinator: 'RUNNING' });
      await knockDown(stack, w);
      await submit(stack, w);
      const submitted = await submittedAt(stack.db, w.taskId);
      assert.deepEqual(await waitingFor(stack, w), [w.taskId]);

      const replaced = await stack.projects.coordinator(w.ownerId, w.projectId, undefined, 'replace');
      assert.equal(replaced.created, true);
      const next = replaced.sessionId;
      assert.notEqual(next, w.coordinatorSessionId);

      // Delivered to the new conversation, not the old one.
      const [, delivered] = await evidenceWakes(stack.db, w.taskId);
      assert.equal(delivered?.status, 'DELIVERED');
      assert.equal(delivered!.sessionId, next);
      const told = await evidenceMessages(stack.db, next, w.taskId);
      assert.equal(told.length, 1, 'the new coordinator was told other than once');
      assert.ok(told[0]!.content!.includes(waitedSentence(submitted)));
      assert.deepEqual(await evidenceMessages(stack.db, w.coordinatorSessionId, w.taskId), []);

      // The new coordinator holds it; the old conversation is asked nothing and shown nothing waiting.
      const read = await readPendingEvidenceJudgments(stack.prisma, w.ownerId, { id: next, taskId: null });
      assert.deepEqual(read.pending.map((r) => r.taskId), []);
      assert.deepEqual(read.waitingOnCoordinator, []);
      assert.deepEqual(read.sentToCoordinator.map((s) => [s.taskId, s.deliveredAt.getTime()]),
        [[w.taskId, delivered!.updatedAt.getTime()]]);
      assert.deepEqual(await waitingFor(stack, w, w.coordinatorSessionId), []);
    } finally {
      await stack.db.$disconnect();
    }
  });

test('a coordinator that was ended or put in Trash leaves the revision with the owner, as before',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      // Ended while the revision waited for it: filed as Completed by its owner.
      const ended = await world(stack, 'ended', { coordinator: 'RUNNING' });
      await knockDown(stack, ended);
      await submit(stack, ended);
      assert.deepEqual(await ownerAsked(stack, ended), [], 'the paused coordinator did not hold it');
      await stack.sessions.complete(ended.ownerId, ended.coordinatorSessionId);
      assert.deepEqual(await ownerAsked(stack, ended), [ended.taskId]);
      assert.equal(await ownerCount(stack, ended), 1);
      assert.deepEqual(await waitingFor(stack, ended), []);
      // A turn end hands nothing to a conversation that is over.
      await stack.waiting.deliverOwedTo(ended.coordinatorSessionId);
      assert.deepEqual(await evidenceMessages(stack.db, ended.coordinatorSessionId, ended.taskId), []);

      // In Trash, after it was handed the revision: the hold ends.
      const trashed = await world(stack, 'trashed', { coordinator: 'RUNNING' });
      await submit(stack, trashed);
      const [held] = await evidenceWakes(stack.db, trashed.taskId);
      assert.equal(held!.status, 'DELIVERED', `refused with ${held!.refusalCode}`);
      await knockDown(stack, trashed);
      assert.deepEqual(await ownerAsked(stack, trashed), []);
      await stack.db.session.update({ where: { id: trashed.coordinatorSessionId }, data: { deletedAt: new Date() } });
      assert.deepEqual(await ownerAsked(stack, trashed), [trashed.taskId]);
      assert.equal(await ownerCount(stack, trashed), 1);
      assert.deepEqual(await waitingFor(stack, trashed), []);
    } finally {
      await stack.db.$disconnect();
    }
  });

test('switched off, a waiting revision goes to the owner, and the coordinator is not handed it when it is back',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'switched-off', { coordinator: 'RUNNING' });
      await knockDown(stack, w);
      await submit(stack, w);
      assert.deepEqual(await ownerAsked(stack, w), []);

      await stack.db.project.update({ where: { id: w.projectId }, data: { coordinatorEnabled: false } });
      assert.deepEqual(await ownerAsked(stack, w), [w.taskId]);
      assert.equal(await ownerCount(stack, w), 1);
      assert.deepEqual(await waitingFor(stack, w), []);

      // Back, and its turn ends: nothing is handed over, nothing is opened, nothing new is claimed.
      const turnId = await revive(stack, w);
      await runToTheEnd(stack, w, turnId);
      await stack.waiting.deliverToIdleCoordinators();
      assert.deepEqual(await evidenceMessages(stack.db, w.coordinatorSessionId, w.taskId), []);
      assert.deepEqual(await judgmentSessions(stack.db, w.ownerId), []);
      const wakes = await evidenceWakes(stack.db, w.taskId);
      assert.equal(wakes.length, 1);
      assert.equal(wakes[0]!.status, 'REFUSED');
      assert.equal(wakes[0]!.sessionId, null);
      assert.deepEqual(await ownerAsked(stack, w), [w.taskId]);
      // Asked directly, the door that hands waiting revisions over claims nothing either.
      await stack.waiting.deliverOwed(w.projectId);
      assert.equal((await evidenceWakes(stack.db, w.taskId)).length, 1);
    } finally {
      await stack.db.$disconnect();
    }
  });

test('a coordinator that took part in the work is not waited for: the revision is recorded and asked of a reader who may answer',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      // The project's coordinator conversation is the run being judged.
      const w = await world(stack, 'not-independent');
      await stack.db.project.update({ where: { id: w.projectId }, data: { coordinatorSessionId: w.runSessionId } });

      await submit(stack, w);

      const [recorded] = await evidenceWakes(stack.db, w.taskId);
      assert.equal(recorded!.status, 'CONSUMED');
      assert.equal(recorded!.sessionId, null);
      // And then it goes down: still not a coordinator anything waits for.
      await stack.db.session.update({ where: { id: w.runSessionId }, data: { status: RunStatus.FAILED } });
      await stack.waiting.deliverOwed(w.projectId);
      assert.equal((await evidenceWakes(stack.db, w.taskId)).length, 1);
      const own = await readPendingEvidenceJudgments(stack.prisma, w.ownerId, { id: w.runSessionId, taskId: w.taskId });
      assert.deepEqual(own.waitingOnCoordinator, [], 'waiting for a coordinator that may not decide it');
      assert.deepEqual(own.pending, []);
      const reader = await readFor(stack, w, w.readerSessionId);
      assert.deepEqual(reader.pending.map((r) => r.taskId), [w.taskId]);
      assert.deepEqual(await judgmentSessions(stack.db, w.ownerId), []);
    } finally {
      await stack.db.$disconnect();
    }
  });

test('a fuse pause leaves the revision with the owner even while the coordinator is down',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'fused', { coordinator: 'RUNNING' });
      await knockDown(stack, w);
      await stack.db.projectFuseEpisode.create({
        data: {
          projectId: w.projectId,
          ownerId: w.ownerId,
          generation: 1,
          dimension: 'SELF_STARTED_TURNS',
          observed: 31,
          limitValue: 30,
          windowStart: new Date(Date.now() - 3_600_000),
          spend: { selfStartedTurns: 31, sessionsOpened: 0, successorRetries: 0 },
          crossingFact: { kind: 'SELF_STARTED_TURN' },
        },
      });

      await submit(stack, w);

      const [row] = await evidenceWakes(stack.db, w.taskId);
      assert.equal(row!.status, 'REFUSED');
      assert.equal(row!.refusalCode, PROJECT_FUSE_PAUSED);
      assert.deepEqual(await ownerAsked(stack, w), [w.taskId]);
      assert.equal(await ownerCount(stack, w), 1);
      assert.deepEqual(await waitingFor(stack, w), []);
    } finally {
      await stack.db.$disconnect();
    }
  });

test('a revision the owner decided while the coordinator was down is not handed to it when it is back',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'decided-meanwhile', { coordinator: 'RUNNING' });
      await knockDown(stack, w);
      await submit(stack, w);
      assert.deepEqual(await waitingFor(stack, w), [w.taskId]);

      // "Decide it myself", pressed on the waiting card in the coordinator's conversation.
      const decided = await stack.evidence.decide(
        w.ownerId,
        w.taskId,
        { type: CreatorType.USER, id: w.ownerId },
        {
          decidingSessionId: w.coordinatorSessionId,
          evidenceRevision: '1',
          decision: 'SEND_BACK',
          note: 'show the run on a second machine',
        },
      );
      assert.equal(decided.decision, 'SEND_BACK');
      assert.deepEqual(await waitingFor(stack, w), []);
      assert.deepEqual(await ownerAsked(stack, w), []);

      const turnId = await revive(stack, w);
      await runToTheEnd(stack, w, turnId);
      await stack.waiting.deliverToIdleCoordinators();
      assert.deepEqual(await evidenceMessages(stack.db, w.coordinatorSessionId, w.taskId), [],
        'the coordinator was handed a revision the owner had decided');
      assert.deepEqual((await evidenceWakes(stack.db, w.taskId)).map((wake) => wake.status), ['REFUSED']);
      const read = await readFor(stack, w, w.coordinatorSessionId);
      assert.deepEqual(read.sentToCoordinator, []);
      assert.deepEqual(read.decided.map((d) => [d.taskId, d.decision, d.decidedByType]),
        [[w.taskId, 'SEND_BACK', CreatorType.USER]]);
    } finally {
      await stack.db.$disconnect();
    }
  });

test('the evidence-waits PostgreSQL target is explicitly disposable', { skip }, () => {
  assertCoordinatorPgUrlIsIsolated(URL);
});
