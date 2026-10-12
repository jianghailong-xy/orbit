import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { HttpException } from '@nestjs/common';
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

import { CompletionEvidenceProducer } from '../projects/completion-evidence.producer';
import { completionEvidenceWakeKey } from '../projects/completion-input';
import { CompletionInputRouter } from '../projects/completion-input-router.service';
import { CoordinatorConvergenceService } from '../projects/coordinator-convergence.service';
import {
  CoordinatorDeliveryService,
  coordinatorDeliveryTurnId,
} from '../projects/coordinator-delivery.service';
import { CoordinatorJudgmentService } from '../projects/coordinator-judgment.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { CoordinatorWakeService } from '../projects/coordinator-wake.service';
import { CriterionReadyProducer } from '../projects/criterion-ready.producer';
import { CriterionUnlandedProducer } from '../projects/criterion-unlanded.producer';
import { DependentReadyProducer } from '../projects/dependent-ready.producer';
import { criterionKeyOf } from '../projects/project-acceptance';
import { ProjectHandoffService } from '../projects/project-handoff.service';
import { ProjectTasksSettledProducer } from '../projects/project-tasks-settled.producer';
import { TaskDispatchRefusalProducer } from '../projects/task-dispatch-refusal.producer';
import { TaskExceptionInputProducer } from '../projects/task-exception-input.producer';
import { WakeDispositionService } from '../projects/wake-disposition.service';
import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { QueueService } from '../queue/queue.service';
import { RealtimeService } from '../realtime/realtime.service';
import { SessionsService } from '../sessions/sessions.service';
import { movedEvidenceTurnId } from './moved-task-evidence';
import { readPendingEvidenceJudgments } from './pending-evidence-judgments';
import { TaskCompletionEvidenceService } from './task-completion-evidence.service';
import { CRITERION_MOVED_CODE, TASK_IN_ANOTHER_PROJECT_CODE } from './task-evidence-decision';
import { TasksService } from './tasks.service';

/**
 * A CONFIRMED MOVE HANDS THE EVIDENCE NOBODY HAS DECIDED TO THE PROJECT THE TASK MOVED INTO.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/tasks/task-move-evidence-handover.pg.spec.ts
 *
 * Decision 2 of project 34b8pthjtmO06pvd8i3FW (account owner, 2026-10-06): a run in progress and
 * evidence nobody has decided go with the task, and the project it moves into decides. Before this,
 * the revision's notification had gone to the source's coordinator under a key that names no
 * project, so the target's coordinator was never told, and a revision quoting the criterion the move
 * took back could not be decided anywhere and nobody said so. Each case drives the real request
 * (`task_update` with a handoff, from the target's coordinator) and the owner's real confirmation
 * (`ProjectHandoffService.decide` → `TasksService.applyMoveApproval`), over the production wiring
 * of the evidence door, the wake ledger and the conversation turns:
 *
 *   (a) A revision quoting the task's own acceptance criteria is decidable in the Automatic target:
 *       its coordinator is handed it to decide, under a key that names the target (the source was
 *       told under the revision's own key before the move), the owner's card is held for it, the
 *       project the task left can no longer decide it — neither its coordinator nor the owner on a
 *       card drawn there — and the target's coordinator does.
 *   (b) A revision quoting the source's criterion, which the move took back, is handed to nobody
 *       to decide: the task's running session is told to file it again against the criterion the
 *       move declared, the target's coordinator is told the task arrived owing that, and the
 *       revision filed again is the target's to decide as usual.
 *   (c) The same with no criterion named by the move: the standard is the task's own acceptance
 *       criteria, a run that has ended is not revived to be told, and the coordinator hears that
 *       nobody will file it unless it acts.
 *   (d) No undecided evidence — none at all, or the latest revision already answered — and the
 *       move says nothing new to anybody.
 *   (e) A target that is not Automatic records the handed-over revision and tells its coordinator
 *       nothing; the owner is asked there at once.
 *
 * Not destructive: every case owns freshly generated ids and asserts over its own rows.
 */
const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

/** The task's own acceptance criteria — what a revision quotes when it declares no criterion. */
const OWN = 'the confirmed move hands its undecided evidence to the project it lands in';
const WANTS_A = 'project A: the work it does is on main and its spec passes';
const WANTS_B = 'project B: the work it does is on main, its spec passes, and B can decide it';

/** The default `exceptionEscalationSeconds` (migration 0278): how long a coordinator holds one. */
const ESCALATION_SECONDS = 7200;

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
  handoffs: ProjectHandoffService;
  evidence: TaskCompletionEvidenceService;
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
  const router = new CompletionInputRouter(
    wakes,
    new ProjectTasksSettledProducer(prisma, judgments, convergence, deliveries),
    new TaskExceptionInputProducer(prisma, convergence),
    new CriterionReadyProducer(prisma, convergence),
    new WakeDispositionService(prisma, judgments, deliveries),
    new CriterionUnlandedProducer(prisma, convergence),
    new TaskDispatchRefusalProducer(prisma, convergence, deliveries),
    new DependentReadyProducer(prisma, convergence, deliveries),
    // The eighth door is about settled projects' integration lines; nothing here settles one.
    undefined,
    new CompletionEvidenceProducer(prisma, convergence, deliveries),
  );
  const handoffs = new ProjectHandoffService(prisma as never);
  const tasks = new TasksService(prisma as never, sessions, realtime, handoffs, router);
  return {
    db,
    prisma,
    tasks,
    handoffs,
    evidence: new TaskCompletionEvidenceService(prisma, tasks, router),
  };
}

interface World {
  label: string;
  ownerId: string;
  runnerId: string;
  workspaceId: string;
  /** Where the task is: Automatic, with a live coordinator conversation. */
  projectA: string;
  /** Where it is asked to go, and its coordinator asks for it. */
  projectB: string;
  coordA: string;
  coordB: string;
  criterionA: string;
  criterionB: string;
  /** The EVIDENCE_JUDGMENT task that moves, IN_PROGRESS in A, holding `OWN` as its own criteria. */
  task: string;
  title: string;
  /** Its run: the session that submits its evidence. RUNNING unless the world says it ended. */
  run: string;
  /** The tool call its evidence cites. */
  cited: string;
}

/** One conversation with its opening prompt as a turn, so nothing below is what seeds it. */
async function conversation(
  db: PrismaClient,
  w: Pick<World, 'ownerId' | 'runnerId' | 'workspaceId'>,
  title: string,
  options: { status?: RunStatus; ended?: boolean; taskId?: string } = {},
): Promise<string> {
  const id = randomUUID();
  await db.session.create({
    data: {
      id,
      ownerId: w.ownerId,
      creatorId: w.ownerId,
      workspaceId: w.workspaceId,
      assignedRunnerId: w.runnerId,
      taskId: options.taskId,
      startsTaskWork: options.taskId !== undefined,
      title,
      prompt: title,
      provider: 'claude',
      status: options.status ?? RunStatus.AWAITING_INPUT,
      dispatchOrigin: SessionDispatchOrigin.USER,
      ...(options.taskId === undefined ? { titleManagedByProject: true } : {}),
      ...(options.ended ? { completedAt: new Date() } : {}),
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

/**
 * One owner with an online runner, two projects A and B — each with a live coordinator conversation
 * and one stated criterion — a task in A that keeps A from settling, and the task that moves.
 */
async function world(
  stack: Stack,
  label: string,
  options: {
    /** Whether B is Automatic. */
    targetAutomatic?: boolean;
    /** Whether the moving task declares A's criterion, rather than holding its own criteria. */
    declaresA?: boolean;
    /** Whether its run has ended (submitted, then finished) rather than still running. */
    runEnded?: boolean;
  } = {},
): Promise<World> {
  const db = stack.db;
  const ids = { ownerId: randomUUID(), runnerId: randomUUID(), workspaceId: randomUUID() };
  await db.user.create({
    data: {
      id: ids.ownerId,
      email: `${label}-${ids.ownerId}@move-evidence.invalid`,
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
    data: {
      id: ids.workspaceId,
      ownerId: ids.ownerId,
      runnerId: ids.runnerId,
      name: `${label}-ws`,
      enabled: true,
      canCreateTasks: true,
      canDelegate: true,
    },
  });

  const coordA = await conversation(db, ids, `协调：${label} A`);
  const coordB = await conversation(db, ids, `协调：${label} B`);
  const [projectA, projectB] = [randomUUID(), randomUUID()];
  for (const [id, name, coordinatorSessionId, coordinatorEnabled] of [
    [projectA, 'A', coordA, true],
    [projectB, 'B', coordB, options.targetAutomatic ?? true],
  ] as const) {
    await db.project.create({
      data: {
        id,
        ownerId: ids.ownerId,
        title: `${label} project ${name}`,
        coordinatorEnabled,
        coordinatorWorkspaceId: ids.workspaceId,
        coordinatorSessionId,
      },
    });
    await db.projectRuntime.upsert({ where: { projectId: id }, create: { projectId: id }, update: {} });
  }
  const criterion = async (projectId: string, text: string) => {
    const id = randomUUID();
    await db.projectAcceptanceCriterionDefinition.create({
      data: {
        id,
        projectId,
        ordinal: 1,
        text,
        verificationMethod: 'EVIDENCE_JUDGMENT：读证据引用的检查',
        contentHash: '0'.repeat(64),
      },
    });
    return id;
  };
  const criterionA = await criterion(projectA, WANTS_A);
  const criterionB = await criterion(projectB, WANTS_B);

  // A's other work: OPEN, so the move never leaves A settled and wakes nobody about that.
  await db.task.create({
    data: {
      id: randomUUID(),
      ownerId: ids.ownerId,
      projectId: projectA,
      title: `${label} A 的另一件活`,
      creatorType: CreatorType.USER,
      creatorId: ids.ownerId,
      status: TaskStatus.OPEN,
      completionCriterion: 'EVIDENCE_JUDGMENT',
      acceptanceCriteria: 'it stays in A',
    },
  });

  const task = randomUUID();
  const title = `${label} 要移到 B 的活`;
  await db.task.create({
    data: {
      id: task,
      ownerId: ids.ownerId,
      projectId: projectA,
      title,
      creatorType: CreatorType.USER,
      creatorId: ids.ownerId,
      assigneeId: ids.workspaceId,
      status: TaskStatus.IN_PROGRESS,
      completionCriterion: 'EVIDENCE_JUDGMENT',
      acceptanceCriteria: OWN,
      ...(options.declaresA ? { criterionDefinitionId: criterionA, criterionRevision: 1 } : {}),
    },
  });
  const run = await conversation(db, ids, `${label} 执行会话`, options.runEnded
    ? { taskId: task, status: RunStatus.SUCCEEDED, ended: true }
    : { taskId: task, status: RunStatus.RUNNING });
  const cited = `toolu_${label}_${task.slice(0, 8)}`;
  await db.toolCall.create({
    data: {
      sessionId: run,
      name: 'Bash',
      toolUseId: cited,
      input: { command: 'npm test', description: 'the command this evidence is about' },
      isError: false,
    },
  });
  return {
    label, ...ids, projectA, projectB, coordA, coordB, criterionA, criterionB, task, title, run, cited,
  };
}

/** One revision of the four-field envelope from the task's run, quoting `quote`. */
function submit(stack: Stack, w: World, quote: { key: string; text: string }, key = `${w.task}-1`) {
  return stack.evidence.submit(
    w.ownerId,
    w.task,
    { type: CreatorType.AGENT, id: w.workspaceId },
    {
      sourceSessionId: w.run,
      idempotencyKey: key,
      evidence: {
        claim: 'the work is done and its spec passes',
        criterion: quote,
        checks: [{ kind: 'TOOL_CALL', ref: w.cited, command: 'npm test', succeeded: true }],
        gaps: [],
      },
    },
  );
}

/** What the task's own criteria are quoted as: its own public id, and their words. */
const ownQuote = (w: World) => ({ key: uuidToBase62(w.task), text: OWN });
const quoteA = (w: World) => ({ key: criterionKeyOf(w.criterionA), text: WANTS_A });
const quoteB = (w: World) => ({ key: criterionKeyOf(w.criterionB), text: WANTS_B });

type Refusal = { status: number; body: Record<string, unknown> };

async function refusalOf(run: () => Promise<unknown>): Promise<Refusal> {
  try {
    await run();
  } catch (error) {
    assert.ok(error instanceof HttpException, `expected a typed refusal, got ${error}`);
    return { status: error.getStatus(), body: error.getResponse() as Record<string, unknown> };
  }
  throw new assert.AssertionError({ message: 'the call was not refused' });
}

/**
 * The move, as it happens: B's coordinator asks for the task (`task_update` with a handoff) and the
 * account owner confirms the request at the card. Nothing else is sent by anybody.
 */
async function move(stack: Stack, w: World, over: Record<string, unknown> = {}): Promise<void> {
  const asked = await refusalOf(() => stack.tasks.update(w.ownerId, w.task, {
    projectId: w.projectB, handoff: { reason: 'it serves B' }, ...over,
  } as never, w.coordB));
  assert.equal(asked.body.code, 'CROSS_PROJECT_APPROVAL_REQUIRED');
  const answer = await stack.handoffs.decide(
    w.ownerId, w.ownerId, String(asked.body.handoffId), 'APPROVE', new Date(), { kind: 'LOGIN' },
  );
  assert.equal(answer.row.state, 'APPLIED');
  const moved = await stack.db.task.findUniqueOrThrow({ where: { id: w.task } });
  assert.equal(moved.projectId, w.projectB, 'the confirmation did not move the task');
}

/** The wake ledger's rows for the task's evidence, oldest first. */
function evidenceWakes(db: PrismaClient, taskId: string) {
  return db.projectCoordinatorWake.findMany({
    where: { event: 'COMPLETION_EVIDENCE_REVISED', subjectType: 'TASK', subjectId: taskId },
    select: {
      projectId: true,
      idempotencyKey: true,
      status: true,
      refusalCode: true,
      consumerType: true,
      sessionId: true,
      delivery: true,
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
}

/** Everything put on a conversation after its opening prompt, oldest first. */
function messagesOn(db: PrismaClient, sessionId: string) {
  return db.conversationTurn.findMany({
    where: { sessionId, clientTurnId: { not: SessionsService.initialTurnClientId(sessionId) } },
    select: { clientTurnId: true, content: true, sendIntent: true },
    orderBy: { seq: 'asc' },
  });
}

/** What each conversation of the world has been told so far, by conversation. */
async function told(db: PrismaClient, w: World) {
  return {
    coordA: await messagesOn(db, w.coordA),
    coordB: await messagesOn(db, w.coordB),
    run: await messagesOn(db, w.run),
  };
}

function judgmentSessions(db: PrismaClient, ownerId: string) {
  return db.session.findMany({
    where: { ownerId, dispatchOrigin: SessionDispatchOrigin.PROJECT_COORDINATOR, deletedAt: null },
    select: { id: true },
  });
}

/** The tasks the owner's evidence card is drawn for in `sessionId`'s conversation, at `readAt`. */
async function ownerAsked(stack: Stack, w: World, sessionId: string, readAt?: Date): Promise<string[]> {
  const queue = await readPendingEvidenceJudgments(
    stack.prisma, w.ownerId, { id: sessionId, taskId: null }, readAt,
  );
  return queue.pending.map((row) => row.taskId).filter((id) => id === w.task);
}

/** One decision, from `sessionId`, as an agent's `task_evidence_decide` makes it. */
function decide(
  stack: Stack,
  w: World,
  sessionId: string,
  evidenceRevision: string,
  decision: 'CONFIRM' | 'SEND_BACK' = 'CONFIRM',
) {
  return stack.evidence.decide(w.ownerId, w.task, { type: CreatorType.AGENT, id: w.workspaceId }, {
    decidingSessionId: sessionId,
    evidenceRevision,
    decision,
    ...(decision === 'SEND_BACK' ? { note: 'show the spec run, not only its name' } : {}),
  });
}

const taskStatus = async (stack: Stack, w: World) =>
  (await stack.db.task.findUniqueOrThrow({ where: { id: w.task } })).status;

const later = () => new Date(Date.now() + (ESCALATION_SECONDS + 60) * 1_000);

// -------------------------------------------------------------------------------------------------

test('(a) a decidable revision is handed to the target coordinator to decide, and the source can no longer decide it',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'decidable');
      const receipt = await submit(stack, w, ownQuote(w));
      assert.equal(receipt.revision, '1');
      const revision = {
        revision: receipt.revision,
        criterionRevision: receipt.criterionRevision,
        evidenceDigest: receipt.evidenceDigest,
      };

      // Before the move: A's coordinator was handed it, under the revision's own key.
      const [submitted] = await evidenceWakes(stack.db, w.task);
      assert.equal(submitted!.status, 'DELIVERED', `refused with ${submitted!.refusalCode}`);
      assert.equal(submitted!.projectId, w.projectA);
      assert.equal(submitted!.sessionId, w.coordA);
      assert.equal(submitted!.idempotencyKey, completionEvidenceWakeKey(w.task, revision));
      const before = await told(stack.db, w);
      assert.equal(before.coordA.length, 1);
      assert.deepEqual(before.coordB, []);
      assert.deepEqual(before.run, []);

      await move(stack, w);

      // The hand-over: a second wake, in B, under the key that names B, DELIVERED to B's coordinator.
      const wakes = await evidenceWakes(stack.db, w.task);
      assert.equal(wakes.length, 2, 'the revision was not handed over, or handed over twice');
      const handedOver = wakes[1]!;
      assert.equal(handedOver.status, 'DELIVERED', `refused with ${handedOver.refusalCode}`);
      assert.equal(handedOver.projectId, w.projectB);
      assert.equal(handedOver.sessionId, w.coordB);
      assert.equal(handedOver.idempotencyKey, completionEvidenceWakeKey(w.task, revision, w.projectB));
      assert.notEqual(handedOver.idempotencyKey, submitted!.idempotencyKey);
      assert.deepEqual(wakes[0], submitted, 'the delivery made to A before the move was touched');

      // B's coordinator: one message, the decision request, saying where the task came from.
      const after = await told(stack.db, w);
      assert.equal(after.coordB.length, 1, 'B\'s coordinator was told other than once');
      const [message] = after.coordB;
      assert.equal(message!.clientTurnId, coordinatorDeliveryTurnId(handedOver.idempotencyKey));
      assert.equal(message!.sendIntent, 'NEXT_TURN');
      const content = message!.content ?? '';
      assert.ok(content.includes(w.title), 'the task is not named by its title');
      assert.ok(content.includes(uuidToBase62(w.task)), 'the task is not named by its id');
      assert.ok(content.includes(`moved from project ${uuidToBase62(w.projectA)} into this project`),
        'the message does not say the task moved in from A');
      assert.ok(content.includes('evidenceRevision: "1"'));
      assert.ok(content.includes(`“${OWN}”`), 'the criterion the evidence quotes is not in it');
      assert.ok(content.includes('task_evidence_decide'));
      // A keeps what it was told before the move, and is told nothing more; the run is told nothing,
      // and nothing was opened to judge it: it went to the conversation B already has.
      assert.deepEqual(after.coordA, before.coordA);
      assert.deepEqual(after.run, []);
      assert.deepEqual(await judgmentSessions(stack.db, w.ownerId), []);

      // B's coordinator holds it: the owner is not asked there until the escalation clock runs out.
      // A is never asked again — it is not A's task any more.
      assert.deepEqual(await ownerAsked(stack, w, w.coordB), []);
      assert.deepEqual(await ownerAsked(stack, w, w.coordB, later()), [w.task]);
      assert.deepEqual(await ownerAsked(stack, w, w.coordA), []);
      assert.deepEqual(await ownerAsked(stack, w, w.coordA, later()), []);
      const elsewhere = await readPendingEvidenceJudgments(
        stack.prisma, w.ownerId, { id: w.coordA, taskId: null }, later(),
      );
      assert.equal(elsewhere.pending.some((row) => row.taskId === w.task), false);

      // The project the task left can no longer decide it: not its coordinator, and not the owner on
      // a card drawn in its conversation. Nothing is written either way.
      const fromA = await refusalOf(() => decide(stack, w, w.coordA, '1'));
      assert.equal(fromA.status, 403);
      assert.equal(fromA.body.code, TASK_IN_ANOTHER_PROJECT_CODE);
      assert.equal(fromA.body.requiredAction, 'DECIDE_FROM_THE_PROJECT_THE_TASK_IS_IN');
      assert.match(String(fromA.body.message), /nothing was written/);
      const ownerInA = await refusalOf(() => stack.evidence.decide(
        w.ownerId, w.task, { type: CreatorType.USER, id: w.ownerId },
        { decidingSessionId: w.coordA, evidenceRevision: '1', decision: 'CONFIRM' },
        { door: 'USER', userId: w.ownerId, actingSessionId: undefined },
      ));
      assert.equal(ownerInA.status, 403);
      assert.equal(ownerInA.body.code, TASK_IN_ANOTHER_PROJECT_CODE);
      assert.equal(await stack.db.taskEvidenceDecision.count({ where: { taskId: w.task } }), 0);
      assert.equal(await taskStatus(stack, w), TaskStatus.IN_PROGRESS);

      // The project it moved into decides it, and that settles the task.
      const confirmed = await decide(stack, w, w.coordB, '1');
      assert.equal(confirmed.decision, 'CONFIRM');
      assert.equal(confirmed.decidingSessionId, w.coordB);
      assert.equal(await taskStatus(stack, w), TaskStatus.DONE);
    } finally {
      await stack.db.$disconnect();
    }
  });

test('(b) a revision quoting the criterion the move took back is decided by nobody: the run and the target coordinator are told to file it again',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'withdrawn', { declaresA: true });
      const receipt = await submit(stack, w, quoteA(w));
      const [submitted] = await evidenceWakes(stack.db, w.task);
      assert.equal(submitted!.status, 'DELIVERED', 'decidable in A, so A\'s coordinator was handed it');
      const before = await told(stack.db, w);

      // B's coordinator asks for the task to serve B's criterion; A's is taken back by the move.
      await move(stack, w, { criterionKey: criterionKeyOf(w.criterionB) });
      const moved = await stack.db.task.findUniqueOrThrow({ where: { id: w.task } });
      assert.equal(moved.criterionDefinitionId, w.criterionB);

      // No decision is asked of anybody: the ledger holds only the delivery made before the move.
      assert.deepEqual(await evidenceWakes(stack.db, w.task), [submitted]);

      const after = await told(stack.db, w);
      assert.deepEqual(after.coordA, before.coordA, 'A was told something after the move');

      // The run: one message, keyed by the revision and B, saying what to quote instead.
      assert.equal(after.run.length, 1, 'the run was told other than once');
      const [toRun] = after.run;
      assert.equal(toRun!.clientTurnId, movedEvidenceTurnId('run', receipt.id, w.projectB));
      const runSays = toRun!.content ?? '';
      assert.ok(runSays.includes(w.title));
      assert.ok(runSays.includes(uuidToBase62(w.projectB)), 'the run is not told where the task went');
      assert.ok(runSays.includes(`key ${criterionKeyOf(w.criterionA)}`), 'the withdrawn quote is not named');
      assert.ok(runSays.includes('was taken back by the move'), 'the run is not told the criterion was taken back');
      assert.ok(runSays.includes(`key: ${criterionKeyOf(w.criterionB)}`), 'the criterion to quote is not named');
      assert.ok(runSays.includes(`“${WANTS_B}”`), 'the criterion to quote is not given word for word');
      assert.ok(runSays.includes('task_evidence_submit'));

      // B's coordinator: one message, not a decision request, saying the task arrived owing a new one.
      assert.equal(after.coordB.length, 1, 'B\'s coordinator was told other than once');
      const [toB] = after.coordB;
      assert.equal(toB!.clientTurnId, movedEvidenceTurnId('coordinator', receipt.id, w.projectB));
      assert.equal(toB!.sendIntent, 'NEXT_TURN');
      const coordinatorSays = toB!.content ?? '';
      assert.ok(coordinatorSays.includes(w.title));
      assert.ok(coordinatorSays.includes('to be submitted again'));
      assert.ok(coordinatorSays.includes(`key ${criterionKeyOf(w.criterionB)}`));
      assert.ok(coordinatorSays.includes(uuidToBase62(w.run)), 'it is not told the run was told');
      assert.ok(!coordinatorSays.includes('evidenceRevision:'), 'it was asked to decide a revision nobody can');

      // Nobody is asked to decide it, and the door would refuse whoever tried: the standard moved.
      assert.deepEqual(await ownerAsked(stack, w, w.coordB, later()), []);
      const runQueue = await readPendingEvidenceJudgments(
        stack.prisma, w.ownerId, { id: w.run, taskId: w.task },
      );
      assert.deepEqual(runQueue.waitingOnYou.map((row) => row.taskId), [w.task],
        'the run does not find the revision it has to file again');
      const stale = await refusalOf(() => decide(stack, w, w.coordB, '1'));
      assert.equal(stale.status, 409);
      assert.equal(stale.body.code, CRITERION_MOVED_CODE);

      // The revision the run files again is B's to decide, as any revision is.
      const again = await submit(stack, w, quoteB(w), `${w.task}-2`);
      assert.equal(again.revision, '2');
      const wakes = await evidenceWakes(stack.db, w.task);
      assert.equal(wakes.length, 2);
      assert.equal(wakes[1]!.status, 'DELIVERED', `refused with ${wakes[1]!.refusalCode}`);
      assert.equal(wakes[1]!.projectId, w.projectB);
      assert.equal(wakes[1]!.sessionId, w.coordB);
      const confirmed = await decide(stack, w, w.coordB, '2');
      assert.equal(confirmed.decision, 'CONFIRM');
      assert.equal(await taskStatus(stack, w), TaskStatus.DONE);
    } finally {
      await stack.db.$disconnect();
    }
  });

test('(c) with no target criterion the standard is the task own criteria, and a run that ended is not revived to be told',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'no-run', { declaresA: true, runEnded: true });
      const receipt = await submit(stack, w, quoteA(w));
      const before = await told(stack.db, w);

      // Asked for with no criterion of B's: the move takes A's back and declares none.
      await move(stack, w);
      const moved = await stack.db.task.findUniqueOrThrow({ where: { id: w.task } });
      assert.equal(moved.criterionDefinitionId, null);
      assert.equal((await evidenceWakes(stack.db, w.task)).length, 1, 'a decision was asked of somebody');

      const after = await told(stack.db, w);
      assert.deepEqual(after.run, before.run, 'a run that has ended was written to');
      assert.deepEqual(after.coordA, before.coordA);
      assert.equal(after.coordB.length, 1);
      const [toB] = after.coordB;
      assert.equal(toB!.clientTurnId, movedEvidenceTurnId('coordinator', receipt.id, w.projectB));
      const says = toB!.content ?? '';
      // The standard is the task's own criteria, quoted under the task's own id.
      assert.ok(says.includes(`key ${uuidToBase62(w.task)}`), 'the key to quote is not the task\'s own id');
      assert.ok(says.includes(`“${OWN}”`), 'the task\'s own criteria are not given word for word');
      // And nobody will file it unless the coordinator acts.
      assert.ok(says.includes('has no running session'));
      assert.ok(says.includes('task_start'));
    } finally {
      await stack.db.$disconnect();
    }
  });

test('(d) a move with no undecided evidence says nothing new to anybody',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      // No evidence at all.
      const none = await world(stack, 'no-evidence');
      const quiet = await told(stack.db, none);
      await move(stack, none);
      assert.deepEqual(await evidenceWakes(stack.db, none.task), []);
      assert.deepEqual(await told(stack.db, none), quiet, 'a move with no evidence told somebody something');

      // Evidence whose latest revision was already answered, by the project it was in at the time.
      const answered = await world(stack, 'answered');
      await submit(stack, answered, ownQuote(answered));
      const sentBack = await decide(stack, answered, answered.coordA, '1', 'SEND_BACK');
      assert.equal(sentBack.decision, 'SEND_BACK');
      const wakesBefore = await evidenceWakes(stack.db, answered.task);
      const toldBefore = await told(stack.db, answered);
      await move(stack, answered);
      assert.deepEqual(await evidenceWakes(stack.db, answered.task), wakesBefore);
      assert.deepEqual(await told(stack.db, answered), toldBefore,
        'a move whose evidence was already answered told somebody something');
      assert.deepEqual(await ownerAsked(stack, answered, answered.coordB, later()), []);
      assert.deepEqual(await judgmentSessions(stack.db, answered.ownerId), []);
    } finally {
      await stack.db.$disconnect();
    }
  });

test('(e) a target that is not Automatic records the handed-over revision, tells its coordinator nothing, and asks the owner',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'manual-target', { targetAutomatic: false });
      const receipt = await submit(stack, w, ownQuote(w));
      const before = await told(stack.db, w);

      await move(stack, w);

      // Recorded against B, under the key naming B, reaching no session — as every revision of a
      // project whose switch is off is recorded.
      const wakes = await evidenceWakes(stack.db, w.task);
      assert.equal(wakes.length, 2);
      const [, row] = wakes;
      assert.equal(row!.projectId, w.projectB);
      assert.equal(row!.idempotencyKey, completionEvidenceWakeKey(w.task, {
        revision: receipt.revision,
        criterionRevision: receipt.criterionRevision,
        evidenceDigest: receipt.evidenceDigest,
      }, w.projectB));
      assert.equal(row!.status, 'CONSUMED');
      assert.equal(row!.consumerType, 'JUDGMENT_REQUEST_DERIVER');
      assert.equal(row!.sessionId, null);
      assert.deepEqual(await told(stack.db, w), before, 'somebody was told about a revision B records');
      assert.deepEqual(await judgmentSessions(stack.db, w.ownerId), []);

      // The owner is asked in B's conversation at once — and never in A's.
      assert.deepEqual(await ownerAsked(stack, w, w.coordB), [w.task]);
      assert.deepEqual(await ownerAsked(stack, w, w.coordA, later()), []);
    } finally {
      await stack.db.$disconnect();
    }
  });

test('the move-evidence PostgreSQL target is explicitly disposable', { skip }, () => {
  assertCoordinatorPgUrlIsIsolated(URL);
});
