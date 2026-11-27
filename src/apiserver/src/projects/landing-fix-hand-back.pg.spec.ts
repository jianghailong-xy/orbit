import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import {
  Prisma,
  PrismaClient,
  RunnerStatus,
  SessionDispatchOrigin,
  TaskStatus,
} from '@prisma/client';
import { RunStatus } from '@orbit/shared';
import { RunEventType, RunStatus as SharedRunStatus, type IntegrationJobCommand } from '@orbit/shared';
import { Client } from 'pg';

import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import type { PushService } from '../push/push.service';
import type { QueueService } from '../queue/queue.service';
import { ReaperService } from '../realtime/reaper.service';
import type { RealtimeService } from '../realtime/realtime.service';
import { IntegrationJobRelay } from '../runner-api/integration-job-relay';
import { RunnerApiController } from '../runner-api/runner-api.controller';
import { MergeReceiptService } from '../sessions/merge-receipt.service';
import { SessionsService } from '../sessions/sessions.service';
import { EvidenceReviewService } from '../tasks/evidence-review.service';
import { TaskOwnerConfirmationService } from '../tasks/task-owner-confirmation.service';
import { TasksService } from '../tasks/tasks.service';
import { AttemptBudgetMeterService } from './attempt-budget-meter.service';
import { CompletionInputRouter } from './completion-input-router.service';
import { ConvergenceLedgerService } from './convergence-ledger.service';
import { CoordinatorConvergenceService } from './coordinator-convergence.service';
import { CoordinatorDeliveryService } from './coordinator-delivery.service';
import { CoordinatorJudgmentService } from './coordinator-judgment.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from './coordinator-pg-test-safety';
import { CoordinatorWakeService } from './coordinator-wake.service';
import { CriterionReadyProducer } from './criterion-ready.producer';
import { CriterionUnlandedProducer } from './criterion-unlanded.producer';
import { landingFixTurnId } from './landing-fix-turn';
import { ProjectOpenItemEscalationService } from './open-item-escalation.service';
import { canonicalRepoUrl } from './project-integration-line';
import { openItemTurnId } from './project-open-item';
import { ProjectOpenItemService } from './project-open-item.service';
import { ProjectPromotionService } from './project-promotion.service';
import { ProjectTasksSettledProducer } from './project-tasks-settled.producer';
import { SessionAttemptService } from './session-attempt.service';
import { TaskExceptionInputProducer } from './task-exception-input.producer';
import { WakeDispositionService } from './wake-disposition.service';
import '../test-support/dequeue-under-lease';
import { WORD_SELECT, wordOf } from '../test-support/session-word';
import { turnStateFilter } from '../sessions/session-turn-state';

/**
 * W7's hand-backs and W8's rounds (`docs/project-integration-line-contract.md` §12.5, revision 42, ruling R2; W-T4, W-T5).
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/projects/landing-fix-hand-back.pg.spec.ts
 *
 * A failed landing handed to its task's own work session (W5, W6) comes back to the coordinator when that session cannot
 * land it, with the reason on the item: `work_session_returned_at` and `work_session_return_reason` written, the
 * payload's `workSession { sessionId, rounds, lastMessage }`, and from that moment the item is the coordinator's as any
 * is — delivered by X-D4, `waiting_since` and `escalate_at` counted from the hand-back. One case per reason:
 *
 *  - NO_NEW_COMMIT: the revived session's work settles on the failed job's source commit (a project branch and a MAIN
 *    line's candidate, whose item names no task);
 *  - TURN_FAILED: the fix turn fails, or is interrupted, or the session cannot get its runner (R3) — the identity W6
 *    cleared is frozen again first, and nothing is queued;
 *  - SESSION_ENDED: a person ends the revived session, or deletes it;
 *  - TASK_MOVED_ON: the task is reopened or cancelled (J-T8) — handed back, delivered to nobody and given no clock, and
 *    closed by §4.2's own facts (a cancel closes it TASK_CLOSED);
 *  - ROUNDS_EXHAUSTED (W8, W-T4 through H3): two generations asked for by the work session, and the third failure opens
 *    straight to the coordinator, delivered at once, while the second's item is SUPERSEDED / RETRIED.
 *
 * And W9 around it: while the item is in the work session's hands the coordinator's resolve door refuses it; once it is
 * handed back the door is the coordinator's again.
 *
 * Every job is queued by the product (the owner's Confirm writes DONE), claimed off a runner's beat and answered through
 * the runner's result door; the fix turn runs through the runner's own doors (claim, dequeue, its transcript,
 * `turnComplete`, `finalize`), and a person's end through `SessionsService.end` / `remove`.
 *
 * Not destructive: every case owns freshly generated ids and reads only its own rows.
 */
const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

const CAPABILITIES = ['integration-job/v1', 'integration-observe/v1'];
const sha = (nibble: string) => nibble.repeat(40);
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);
const UPSTREAM = sha('9');
/** The commit the work was delivered on, which the failed landing was handed. */
const DELIVERED = sha('a');
/** The commit the work session's fix ended on. */
const FIXED = sha('f');
/** What the fix turn says last, which the handed-back item carries. */
const LAST_WORDS = 'I merged the project branch in, but this is not mine to fix: the conflict is in generated code.';

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
  confirmations: TaskOwnerConfirmationService;
  openItems: ProjectOpenItemService;
  escalation: ProjectOpenItemEscalationService;
  reaper: ReaperService;
  api: RunnerApiController;
}

/**
 * The doors over one client, as production wires them: the completion router with its producers — the doors that give
 * a coordinator turns — behind the task writes and the landing receipts, and the runner's door with its relay, its
 * receipts and its promotions. Nothing reaches a device or a runner.
 */
async function connect(): Promise<Stack> {
  await verifyDisposableDatabase();
  const db = prismaClientFor(URL!);
  const prisma = db as unknown as PrismaService;
  const realtime = new Proxy({}, { get: () => () => undefined }) as unknown as RealtimeService;
  const queue = { notifySessionQueued: () => undefined } as unknown as QueueService;
  // The ModuleRef production resolves the item service through, after an end that finished a session here.
  let openItemsRef: ProjectOpenItemService | undefined;
  let routerRef: CompletionInputRouter | undefined;
  const moduleRef = {
    get: (token: { name?: string }) => (token.name === 'ProjectOpenItemService' ? openItemsRef
      : token.name === 'CompletionInputRouter' ? routerRef : undefined),
  };
  const sessions = new SessionsService(
    prisma, queue, realtime, undefined, undefined, undefined, moduleRef as never,
  );
  const push = new Proxy({}, { get: () => () => Promise.resolve() }) as unknown as PushService;
  const openItems = new ProjectOpenItemService(prisma, sessions, push);
  openItemsRef = openItems;
  const wakes = () => new CoordinatorWakeService(prisma);
  const judgment = () => new CoordinatorJudgmentService(prisma, wakes(), sessions);
  const delivery = () => new CoordinatorDeliveryService(prisma, wakes(), sessions);
  const router = new CompletionInputRouter(
    wakes(),
    new ProjectTasksSettledProducer(prisma, judgment(), new CoordinatorConvergenceService(prisma), delivery()),
    new TaskExceptionInputProducer(prisma, new CoordinatorConvergenceService(prisma)),
    new CriterionReadyProducer(prisma, new CoordinatorConvergenceService(prisma)),
    new WakeDispositionService(prisma, judgment(), delivery()),
    new CriterionUnlandedProducer(prisma, new CoordinatorConvergenceService(prisma)),
  );
  routerRef = router;
  const tasks = new TasksService(prisma, sessions, realtime, undefined, router, undefined, openItems);
  const convergence = new CoordinatorConvergenceService(prisma);
  const attempts = new SessionAttemptService(prisma, new ConvergenceLedgerService(prisma));
  const meter = new AttemptBudgetMeterService(prisma, attempts, wakes(), convergence);
  const api = new RunnerApiController(
    prisma, queue, realtime, push,
    {} as never,
    { expand: async (_ownerId: string, content?: string) => content } as never,
    { appendFor: async (_tx: unknown, _sessionId: string, content?: string) => content } as never,
    meter,
    undefined,
    tasks,
    new MergeReceiptService(prisma, router, tasks),
    sessions,
    openItems,
    new IntegrationJobRelay(prisma, openItems),
    undefined,
    new ProjectPromotionService(prisma),
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    new EvidenceReviewService(prisma, sessions),
  );
  return {
    db,
    prisma,
    sessions,
    tasks,
    confirmations: new TaskOwnerConfirmationService(prisma, sessions, tasks, realtime),
    openItems,
    escalation: new ProjectOpenItemEscalationService(prisma),
    reaper: new ReaperService(prisma, realtime, openItems),
    api,
  };
}

type Line = 'PROJECT_BRANCH' | 'MAIN';

interface World {
  ownerId: string;
  runnerId: string;
  workspaceId: string;
  projectId: string;
  coordinatorSessionId: string;
}

/**
 * One owner, the runner the work runs on, a live coordinator conversation, and a project on `line` — with one chore task
 * that serves nothing and never finishes, so the project cannot settle and no judgment of it is owed: every turn the
 * coordinator could be given here would be about the landing.
 */
async function world(stack: Stack, label: string, line: Line = 'PROJECT_BRANCH'): Promise<World> {
  const db = stack.db;
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const coordinatorSessionId = randomUUID();
  const repoUrl = `https://git.invalid/orbit/${label}-${projectId.slice(0, 8)}.git`;
  await db.user.create({
    data: { id: ownerId, email: `${label}-${ownerId}@landing-fix-hand-back.invalid`, name: label, passwordHash: 'x' },
  });
  await db.runner.create({
    data: {
      id: runnerId, ownerId, name: `${label}-runner`, tokenHash: `hash-${runnerId}`, status: RunnerStatus.ONLINE,
      capabilities: CAPABILITIES, maxConcurrent: 4, capabilitiesReportedAt: new Date(), lastHeartbeatAt: new Date(),
      heartbeatLeaseOwner: randomUUID(),
    },
  });
  await db.workspace.create({
    data: { id: workspaceId, ownerId, runnerId, name: `${label}-workspace`, enabled: true, repoUrl, workDir: `/srv/${label}` },
  });
  await db.session.create({
    data: {
      id: coordinatorSessionId, ownerId, creatorId: ownerId, workspaceId, assignedRunnerId: runnerId,
      title: `coordinator: ${label}`, prompt: `coordinator: ${label}`, provider: 'claude',
      turnState: null, dispatchOrigin: SessionDispatchOrigin.USER, startsTaskWork: false,
      titleManagedByProject: true, numTurns: 1, startedAt: new Date(), runtimeSessionId: `runtime-${coordinatorSessionId}`,
    },
  });
  await db.project.create({
    data: {
      id: projectId, ownerId, title: `${label} project`, goal: 'a landing failure goes to the work that caused it',
      coordinatorEnabled: true, coordinatorWorkspaceId: workspaceId, coordinatorSessionId,
    },
  });
  await db.projectRuntime.upsert({ where: { projectId }, create: { projectId }, update: {} });
  await db.projectCodebase.create({
    data: {
      ownerId, projectId, canonicalRepoUrl: canonicalRepoUrl(repoUrl)!, upstreamRef: 'refs/heads/main',
      integrationRef: line === 'PROJECT_BRANCH' ? `refs/heads/project/${projectId}` : 'refs/heads/main',
      refAuthority: 'REMOTE', remoteName: 'origin', integrationRefSource: 'EXPLICIT', deliveryMode: 'PLATFORM',
      integrationStartedAt: new Date(),
    },
  });
  await db.task.create({
    data: {
      ownerId, creatorType: 'USER', creatorId: ownerId, title: `${label} chore`, projectId,
      status: TaskStatus.OPEN, completionCriterion: 'OWNER_CONFIRMED', autoRunWhenReady: false,
    },
  });
  return { ownerId, runnerId, workspaceId, projectId, coordinatorSessionId };
}

interface Finished {
  taskId: string;
  sessionId: string;
  branch: string;
}

/**
 * A code task whose work session parked on its branch at DELIVERED, written DONE by the owner's Confirm — and then ended
 * the way production ends it: the DONE asks for the end of its idle work session (`claimParkedSessionEnd`, which leaves
 * `cancel_requested_at` and `end_reason = 'task_done'` on the row), and the runner's finalize writes the finish, which
 * freezes the identity and queues the landing (PROJECT_BRANCH) or the candidate's check (MAIN).
 */
async function finishedTask(stack: Stack, w: World, label: string): Promise<Finished> {
  const { id: taskId } = await stack.db.task.create({
    data: {
      ownerId: w.ownerId, creatorType: 'USER', creatorId: w.ownerId, title: `Make ${label} land`, projectId: w.projectId,
      assigneeId: w.workspaceId, status: TaskStatus.IN_PROGRESS, completionCriterion: 'OWNER_CONFIRMED',
      acceptanceCriteria: 'the work lands',
    },
    select: { id: true },
  });
  const sessionId = randomUUID();
  const branch = `orbit/${label}`;
  await stack.db.session.create({
    data: {
      id: sessionId, ownerId: w.ownerId, creatorId: w.ownerId, taskId, workspaceId: w.workspaceId,
      assignedRunnerId: w.runnerId, title: `work ${label}`, prompt: 'work', provider: 'claude',
      turnState: null, dispatchOrigin: SessionDispatchOrigin.USER, startsTaskWork: true,
      isolationStatus: 'worktree', branch, branchSha: DELIVERED, baseSha: sha('b'), numTurns: 1,
      startedAt: minutesAgo(30), createdAt: minutesAgo(30), runtimeSessionId: randomUUID(),
      changedFiles: [{ path: 'src/a.ts', status: 'M', additions: 1, deletions: 0 }] as Prisma.InputJsonValue,
    },
  });
  const receipt = await stack.confirmations.decide(
    w.ownerId, taskId, { door: 'USER', userId: w.ownerId }, { decision: 'CONFIRM' } as never,
  );
  assert.equal(receipt.completed, true, 'CONTROL: the confirmation wrote DONE');
  assert.equal(await endRequested(stack, sessionId), true, 'CONTROL: the DONE asked for the end of its idle work session');
  const t = { taskId, sessionId, branch };
  await stack.api.finalize({ id: w.runnerId } as never, sessionId, {
    status: SharedRunStatus.SUCCEEDED, isolationStatus: 'worktree', branch, branchSha: DELIVERED, baseSha: sha('b'),
  } as never);
  const ended = await stack.db.session.findUniqueOrThrow({
    where: { id: sessionId }, select: { finishedAt: true, endReason: true, cancelRequestedAt: true },
  });
  assert.ok(ended.finishedAt && ended.cancelRequestedAt, 'CONTROL: the finish kept the end the DONE asked for');
  assert.equal(ended.endReason, 'task_done');
  const frozen = await stack.db.task.findUniqueOrThrow({ where: { id: taskId }, select: { deliveredSha: true } });
  assert.equal(frozen.deliveredSha, DELIVERED, 'CONTROL: the finish froze the delivered commit');
  return t;
}

/** The command one beat of the runner hands out, of `kind`. */
async function claim(stack: Stack, w: World, kind: string): Promise<IntegrationJobCommand> {
  const handed = await (stack.api as unknown as { integrationJobs: IntegrationJobRelay }).integrationJobs.dispatch({
    runnerId: w.runnerId, leaseOwner: randomUUID(), draining: false, capabilities: CAPABILITIES,
  });
  const command = handed.find((candidate) => candidate.kind === kind);
  assert.ok(command, `CONTROL: the runner was handed a ${kind} — it got ${JSON.stringify(handed.map((c) => c.kind))}`);
  return command;
}

/** The runner's result through its door: the J-T7 transaction, then what follows the commit. */
async function report(stack: Stack, w: World, command: IntegrationJobCommand, body: object): Promise<void> {
  const answer = await stack.api.integrationJobResult({ id: w.runnerId, ownerId: w.ownerId }, command.jobId, {
    claimGeneration: command.claimGeneration, leaseOwner: command.leaseOwner, ...body,
  } as never);
  assert.equal(answer.accepted, true, 'CONTROL: the result was taken');
  // And the coordinator's backstop (X-D4 3): nothing may hand the item over there either.
  await stack.openItems.deliverOwed(w.projectId);
}

const conflict = (phase: 'REBASE' | 'MERGE' | 'MAIN_SYNC', sourceSha = DELIVERED) => ({
  state: 'CONFLICT', phase, sourceSha, targetShaBefore: sha('c'), upstreamSha: UPSTREAM,
  conflicts: ['src/a.ts'],
});

const redCheck = () => ({
  state: 'CHECK_FAILED', phase: 'CHECK', sourceSha: DELIVERED, targetShaBefore: sha('c'), upstreamSha: UPSTREAM,
  testedSha: sha('d'), testedTreeSha: sha('e'),
  checks: [{
    name: 'LANDING_CHECK', command: 'npm test', expectedExitCode: 0, exitCode: 1, timedOut: false,
    durationMs: 1_000, outputTail: 'not ok 1 - the work broke it',
  }],
});

/** The one failure item `jobId` opened, with the columns a hand-back writes. */
async function itemOf(stack: Stack, jobId: string) {
  const rows = await stack.db.projectOpenItem.findMany({
    where: {
      integrationJobId: jobId, kind: { in: ['INTEGRATION_CONFLICT', 'INTEGRATION_CHECK_FAILED', 'INTEGRATION_ERROR'] },
    },
    select: {
      id: true, state: true, resolution: true, assignee: true, assigneeReason: true, waitingSince: true,
      assignedAt: true, escalateAt: true, payload: true, createdAt: true, workSessionId: true,
      workSessionOfferedAt: true, workSessionReturnedAt: true, workSessionReturnReason: true,
    },
  });
  assert.equal(rows.length, 1, `the job opened ${rows.length} failure items`);
  return rows[0]!;
}

type Item = Awaited<ReturnType<typeof itemOf>>;

/**
 * Everything that would say the coordinator — or any conversation of the owner's but the work session — was given
 * something: turns, wakes, and deliveries of an item.
 */
async function coordinatorView(stack: Stack, w: World, workSessionId: string) {
  return {
    coordinatorTurns: await stack.db.conversationTurn.count({ where: { sessionId: w.coordinatorSessionId } }),
    otherConversationTurns: await stack.db.conversationTurn.count({
      where: { session: { ownerId: w.ownerId, sessionKind: 'CONVERSATION', id: { not: workSessionId } } },
    }),
    wakes: await stack.db.projectCoordinatorWake.count({ where: { projectId: w.projectId } }),
    deliveries: await stack.db.projectOpenItemDelivery.count({ where: { sessionId: w.coordinatorSessionId } }),
  };
}

/** The task's integration jobs, oldest first, with the columns W7 writes. */
async function jobsOf(stack: Stack, where: Prisma.ProjectIntegrationJobWhereInput) {
  return stack.db.projectIntegrationJob.findMany({
    where,
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: {
      id: true, kind: true, generation: true, state: true, sessionId: true, sourceRef: true, sourceSha: true,
      promotionId: true, retryOfJobId: true, retryFailureClass: true, retryReason: true,
      retryRequestedBySessionId: true, retryRequestedByUserId: true,
    },
  });
}

interface FixTurn {
  leaseOwner: string;
  turnId: string;
}

/**
 * The landing-fix turn, run through the runner's doors on the work session it revived: the claim under an inbox
 * generation of its own, the dequeue that hands it over, its transcript, and `turnComplete` reporting the branch's
 * tip. `during` runs while the turn is in flight — where the session starts a background job or sets a wakeup.
 */
async function runFixTurn(
  stack: Stack,
  w: World,
  t: Finished,
  failedJobId: string,
  options: { branchSha: string; status?: SharedRunStatus; during?: () => Promise<void>; words?: string },
): Promise<FixTurn> {
  const [turn] = await stack.db.conversationTurn.findMany({
    where: { sessionId: t.sessionId, clientTurnId: landingFixTurnId(failedJobId) },
    select: { id: true },
  });
  assert.ok(turn, 'CONTROL: the landing-fix turn was delivered to the work session');
  const revived = await stack.db.session.findUniqueOrThrow({ where: { id: t.sessionId }, select: { finishedAt: true } });
  assert.equal(revived.finishedAt, null, 'CONTROL: the landing-fix turn revived the work session');
  const generation = randomUUID();
  const leaseOwner = randomUUID();
  await stack.db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('orbit.claim_reads_session_engine', '1', true)`;
    await tx.session.updateMany({
      where: { id: t.sessionId, ...turnStateFilter(['QUEUED', null]) },
      data: { turnState: 'IN_FLIGHT', inboxLeaseOwner: leaseOwner, inboxLeaseGeneration: generation },
    });
    await tx.inboxLeaseGeneration.updateMany({
      where: { sessionId: t.sessionId, retiredAt: null }, data: { retiredAt: new Date() },
    });
    await tx.inboxLeaseGeneration.create({ data: { generation, sessionId: t.sessionId, leaseOwner } });
  });
  const handed = await (stack.api as unknown as {
    dequeueTurn: (sessionId: string, runnerId: string, lease: string | null) => Promise<{ turnId: string } | null>;
  }).dequeueTurn(t.sessionId, w.runnerId, generation);
  assert.equal(handed?.turnId, turn.id, 'CONTROL: the runner was handed the landing-fix turn');
  if (options.during) await options.during();
  const last = await stack.db.runEvent.aggregate({ where: { sessionId: t.sessionId }, _max: { seq: true } });
  await stack.api.events({ id: w.runnerId } as never, t.sessionId, {
    leaseOwner,
    events: [{
      seq: (last._max.seq ?? 0) + 1, type: RunEventType.ASSISTANT, ts: new Date().toISOString(),
      turnId: turn.id, payload: { text: options.words ?? LAST_WORDS },
    }],
  } as never);
  const ended = await stack.api.turnComplete({ id: w.runnerId } as never, t.sessionId, {
    turnId: turn.id, status: options.status ?? SharedRunStatus.SUCCEEDED, leaseOwner, branchSha: options.branchSha,
    ...(options.status === SharedRunStatus.FAILED ? { error: 'the engine exited with status 1' } : {}),
    ...(options.status === SharedRunStatus.INTERRUPTED ? { error: 'interrupted by the person' } : {}),
  } as never);
  assert.equal((ended as { ok: boolean }).ok, true, 'CONTROL: the turn completed');
  return { leaseOwner, turnId: turn.id };
}

/** The runner's finalize of the ended session, reporting the tip after its finalize commit. */
async function finalize(stack: Stack, w: World, t: Finished, fix: FixTurn, branchSha: string): Promise<void> {
  await stack.api.finalize({ id: w.runnerId } as never, t.sessionId, {
    status: SharedRunStatus.SUCCEEDED, isolationStatus: 'worktree', branch: t.branch, branchSha, baseSha: sha('b'),
    leaseOwner: fix.leaseOwner,
  } as never);
  const row = await stack.db.session.findUniqueOrThrow({
    where: { id: t.sessionId }, select: { finishedAt: true, endReason: true },
  });
  assert.ok(row.finishedAt, 'CONTROL: the finalize wrote the finish');
  assert.equal(row.endReason, 'task_done', 'CONTROL: the session ended because its task is done');
}

/** Whether the DONE's end of this session's idle work has been asked for (`claimParkedSessionEnd`). */
async function endRequested(stack: Stack, sessionId: string): Promise<boolean> {
  const row = await stack.db.session.findUniqueOrThrow({
    where: { id: sessionId }, select: { cancelRequestedAt: true, endReason: true, finishedAt: true },
  });
  return row.cancelRequestedAt !== null && row.endReason === 'task_done';
}

/** The reaper's sweep, with this world's runner heard from just before it. */
async function sweep(stack: Stack, w: World): Promise<void> {
  await stack.db.runner.update({ where: { id: w.runnerId }, data: { lastHeartbeatAt: new Date() } });
  await stack.reaper.tick();
}

// ─── What every hand-back holds to ───────────────────────────────────────────────────────────────

/** The project's frozen window (§4.1 X-E2), the length `escalate_at` is counted by. */
async function windowOf(stack: Stack, w: World): Promise<number> {
  const project = await stack.db.project.findUniqueOrThrow({
    where: { id: w.projectId }, select: { exceptionEscalationSeconds: true },
  });
  return project.exceptionEscalationSeconds * 1_000;
}

/** The coordinator's ITEM delivery of this item, and the turn it was written on, under its current assignment. */
async function coordinatorDelivery(stack: Stack, w: World, item: Item) {
  const clientTurnId = openItemTurnId(item.id, item.assignedAt);
  const delivery = await stack.db.projectOpenItemDelivery.findFirst({
    where: { itemId: item.id, sessionId: w.coordinatorSessionId, purpose: 'ITEM', clientTurnId },
    select: { clientTurnId: true },
  });
  const turn = await stack.db.conversationTurn.findUnique({
    where: { sessionId_clientTurnId: { sessionId: w.coordinatorSessionId, clientTurnId } },
    select: { content: true },
  });
  return { delivery, turn };
}

/**
 * The hand-back as W7 writes it: the reason, the moment, `waiting_since` and `escalate_at` counted from it, the payload's
 * `workSession`, and — for every reason but TASK_MOVED_ON — the item delivered to the coordinator with the session's
 * last words in it. Returns the item as read.
 */
async function assertHandedBack(
  stack: Stack,
  w: World,
  jobId: string,
  expected: { reason: string; sessionId: string; rounds: number; lastMessage: string | null; before: Date },
): Promise<Item> {
  const item = await itemOf(stack, jobId);
  assert.equal(item.workSessionReturnReason, expected.reason, 'the hand-back did not record its reason');
  assert.equal(item.workSessionId, expected.sessionId);
  const returnedAt = item.workSessionReturnedAt;
  assert.ok(returnedAt, 'the item was not handed back');
  assert.ok(returnedAt.getTime() >= expected.before.getTime(), 'the hand-back is older than the fact it is about');
  assert.equal(item.assignee, 'COORDINATOR');
  assert.equal(item.waitingSince.getTime(), returnedAt.getTime(), 'waiting_since is not counted from the hand-back');
  assert.equal(item.assignedAt.getTime(), returnedAt.getTime(), 'the assignment is not the hand-back\'s');
  assert.deepEqual((item.payload as { workSession?: unknown }).workSession, {
    sessionId: expected.sessionId, rounds: expected.rounds, lastMessage: expected.lastMessage,
  }, 'the payload does not carry the work session');
  const { delivery, turn } = await coordinatorDelivery(stack, w, item);
  if (expected.reason === 'TASK_MOVED_ON') {
    assert.equal(item.escalateAt, null, 'a task that moved on was given a clock');
    assert.equal(delivery, null, 'a task that moved on was delivered to the coordinator');
    assert.equal(turn, null);
    return item;
  }
  assert.equal(item.state, 'OPEN');
  assert.equal(item.escalateAt?.getTime(), returnedAt.getTime() + await windowOf(stack, w),
    'escalate_at is not counted from the hand-back');
  assert.ok(delivery, 'the handed-back item was not delivered to the coordinator');
  assert.ok(turn?.content, 'the coordinator\'s delivery turn was not written');
  assert.match(turn.content, /handed back/, 'the delivery does not say the item was handed back');
  assert.ok(turn.content.includes(`(${expected.reason})`), 'the delivery does not name the reason');
  if (expected.lastMessage) {
    assert.ok(turn.content.includes(expected.lastMessage), 'the delivery does not carry the session\'s last words');
  }
  return item;
}

/** The coordinator's resolve door (W9), answered with the refusal's body or 'accepted'. */
async function coordinatorResolve(stack: Stack, w: World, itemId: string): Promise<unknown> {
  try {
    await stack.openItems.resolveOpenItem(w.ownerId, w.projectId, itemId, { note: 'handled by hand' }, {
      kind: 'SESSION', sessionId: w.coordinatorSessionId,
    });
  } catch (error) {
    return (error as { getResponse?: () => unknown }).getResponse?.() ?? error;
  }
  return 'accepted';
}

/** The failure handed to the work session (W-T1), on a project branch. */
async function handedOff(stack: Stack, label: string, failure: object = conflict('MERGE')) {
  const w = await world(stack, label);
  const t = await finishedTask(stack, w, label);
  const first = await claim(stack, w, 'LAND_TASK');
  await report(stack, w, first, failure);
  const item = await itemOf(stack, first.jobId);
  assert.equal(item.workSessionId, t.sessionId, 'CONTROL: the failure was handed to the work session (W-T1)');
  assert.equal(item.workSessionReturnedAt, null);
  assert.equal(item.escalateAt, null, 'CONTROL: nobody owes an item the work session holds');
  return { w, t, first, item };
}

/** The task's identity as the hand-back left it. */
async function identityOf(stack: Stack, taskId: string) {
  return stack.db.task.findUniqueOrThrow({
    where: { id: taskId }, select: { status: true, deliveredSha: true, deliveredAt: true },
  });
}

// ─── NO_NEW_COMMIT ───────────────────────────────────────────────────────────────────────────────

test('W-T5 NO_NEW_COMMIT: the revived session settles on the failed job\'s source commit — handed back with the reason, '
  + 'delivered to the coordinator, escalate_at from the hand-back, the payload\'s workSession; W9 refuses resolve until '
  + 'then', { skip, timeout: 240_000 }, async () => {
  const stack = await connect();
  try {
    const { w, t, first, item } = await handedOff(stack, 'no-new-commit');
    const fix = await runFixTurn(stack, w, t, first.jobId, { branchSha: DELIVERED });
    const refused = await coordinatorResolve(stack, w, item.id);
    assert.equal((refused as { code?: string }).code, 'OPEN_ITEM_WITH_WORK_SESSION',
      `CONTROL: W9 did not refuse the coordinator's resolve while the work session held it: ${JSON.stringify(refused)}`);
    const before = new Date();
    await finalize(stack, w, t, fix, DELIVERED);

    await assertHandedBack(stack, w, first.jobId, {
      reason: 'NO_NEW_COMMIT', sessionId: t.sessionId, rounds: 0, lastMessage: LAST_WORDS, before,
    });
    assert.equal((await identityOf(stack, t.taskId)).deliveredSha, DELIVERED, 'the finish did not freeze the identity');
    assert.deepEqual((await jobsOf(stack, { taskId: t.taskId })).map((job) => job.id), [first.jobId],
      'the same commit was landed again');
    // Handed back, the item is the coordinator's door's again.
    assert.equal(await coordinatorResolve(stack, w, item.id), 'accepted', 'W9 still refuses a handed-back item');
    assert.equal((await itemOf(stack, first.jobId)).state, 'RESOLVED');
  } finally {
    await stack.db.$disconnect();
  }
});

test('W-T5 NO_NEW_COMMIT on a MAIN line: the candidate\'s item, which names no task, is handed back and delivered',
  { skip, timeout: 240_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'main-same', 'MAIN');
      const t = await finishedTask(stack, w, 'main-same');
      const check = await claim(stack, w, 'CHECK_PROMOTION');
      await report(stack, w, check, conflict('MERGE'));
      const opened = await itemOf(stack, check.jobId);
      assert.equal(opened.workSessionId, t.sessionId, 'CONTROL: the failure was handed to the work session (W-T1)');
      const fix = await runFixTurn(stack, w, t, check.jobId, { branchSha: DELIVERED });
      const before = new Date();
      await finalize(stack, w, t, fix, DELIVERED);
      await assertHandedBack(stack, w, check.jobId, {
        reason: 'NO_NEW_COMMIT', sessionId: t.sessionId, rounds: 0, lastMessage: LAST_WORDS, before,
      });
      assert.equal(await stack.db.projectIntegrationJob.count({ where: { projectId: w.projectId, kind: 'CHECK_PROMOTION' } }),
        1, 'the same commit was checked again');
    } finally {
      await stack.db.$disconnect();
    }
  });

// ─── TURN_FAILED ─────────────────────────────────────────────────────────────────────────────────

test('W-T5 TURN_FAILED: the fix turn fails — the identity is frozen again from the branch, nothing is queued, and the '
  + 'item is handed back and delivered', { skip, timeout: 240_000 }, async () => {
  const stack = await connect();
  try {
    const { w, t, first } = await handedOff(stack, 'turn-failed', redCheck());
    const before = new Date();
    await runFixTurn(stack, w, t, first.jobId, { branchSha: FIXED, status: SharedRunStatus.FAILED });
    const session = await stack.db.session.findUniqueOrThrow({ where: { id: t.sessionId }, select: { finishedAt: true } });
    assert.ok(session.finishedAt, 'CONTROL: the failed turn finished the session');
    await assertHandedBack(stack, w, first.jobId, {
      reason: 'TURN_FAILED', sessionId: t.sessionId, rounds: 0, lastMessage: LAST_WORDS, before,
    });
    const identity = await identityOf(stack, t.taskId);
    assert.equal(identity.status, TaskStatus.DONE);
    assert.equal(identity.deliveredSha, FIXED, 'the identity W6 cleared was not frozen again');
    assert.ok(identity.deliveredAt);
    assert.deepEqual((await jobsOf(stack, { taskId: t.taskId })).map((job) => job.id), [first.jobId],
      'a failed fix turn landed again');
  } finally {
    await stack.db.$disconnect();
  }
});

test('W-T5 TURN_FAILED: the fix turn is interrupted — its commit is not landed, the item is handed back at the finish',
  { skip, timeout: 240_000 }, async () => {
    const stack = await connect();
    try {
      const { w, t, first } = await handedOff(stack, 'interrupted');
      const before = new Date();
      const fix = await runFixTurn(stack, w, t, first.jobId, { branchSha: FIXED, status: SharedRunStatus.INTERRUPTED });
      if (!(await endRequested(stack, t.sessionId))) await sweep(stack, w);
      assert.equal(await endRequested(stack, t.sessionId), true, 'CONTROL: the idle session of a DONE task was ended');
      await finalize(stack, w, t, fix, FIXED);
      await assertHandedBack(stack, w, first.jobId, {
        reason: 'TURN_FAILED', sessionId: t.sessionId, rounds: 0, lastMessage: LAST_WORDS, before,
      });
      assert.equal((await identityOf(stack, t.taskId)).deliveredSha, FIXED, 'the identity was not frozen again');
      assert.deepEqual((await jobsOf(stack, { taskId: t.taskId })).map((job) => job.id), [first.jobId],
        'an interrupted fix turn landed again');
    } finally {
      await stack.db.$disconnect();
    }
  });

test('W-T5 TURN_FAILED (R3): the session cannot get its runner — its revival is refused, nothing is cleared, and the '
  + 'item is handed back and delivered at once', { skip, timeout: 240_000 }, async () => {
  const stack = await connect();
  try {
    const w = await world(stack, 'runner-gone');
    const t = await finishedTask(stack, w, 'runner-gone');
    const first = await claim(stack, w, 'LAND_TASK');
    await stack.db.runner.update({
      where: { id: w.runnerId }, data: { status: RunnerStatus.OFFLINE, lastHeartbeatAt: minutesAgo(30) },
    });
    const before = new Date();
    await report(stack, w, first, conflict('REBASE'));
    // No landing-fix round: the session was never revived, so it said nothing about this failure.
    await assertHandedBack(stack, w, first.jobId, {
      reason: 'TURN_FAILED', sessionId: t.sessionId, rounds: 0, lastMessage: null, before,
    });
    const session = await stack.db.session.findUniqueOrThrow({ where: { id: t.sessionId }, select: { finishedAt: true } });
    assert.ok(session.finishedAt, 'a session whose runner is gone was revived');
    assert.equal(await stack.db.conversationTurn.count({
      where: { sessionId: t.sessionId, clientTurnId: landingFixTurnId(first.jobId) },
    }), 0, 'a landing-fix turn was written');
    const identity = await identityOf(stack, t.taskId);
    assert.equal(identity.deliveredSha, DELIVERED, 'the delivered identity was cleared by a refused revival');
    assert.ok(identity.deliveredAt);
  } finally {
    await stack.db.$disconnect();
  }
});

// ─── SESSION_ENDED ───────────────────────────────────────────────────────────────────────────────

test('W-T5 SESSION_ENDED: a person ends the revived session — handed back at its finish and delivered',
  { skip, timeout: 240_000 }, async () => {
    const stack = await connect();
    try {
      const { w, t, first } = await handedOff(stack, 'person-ended');
      // A background job keeps the revived session open past its turn (R2), where a person can end it.
      const fix = await runFixTurn(stack, w, t, first.jobId, {
        branchSha: FIXED,
        during: async () => {
          await stack.db.session.update({ where: { id: t.sessionId }, data: { runningBgJobs: ['bgj_handbacktests'] } });
        },
      });
      assert.equal(await endRequested(stack, t.sessionId), false, 'CONTROL: the session was left open by its wake source');
      const before = new Date();
      await stack.sessions.end(w.ownerId, t.sessionId);
      await stack.api.finalize({ id: w.runnerId } as never, t.sessionId, {
        status: SharedRunStatus.SUCCEEDED, isolationStatus: 'worktree', branch: t.branch, branchSha: FIXED,
        baseSha: sha('b'), leaseOwner: fix.leaseOwner,
      } as never);
      const ended = await stack.db.session.findUniqueOrThrow({
        where: { id: t.sessionId }, select: { finishedAt: true, endReason: true },
      });
      assert.ok(ended.finishedAt, 'CONTROL: the finalize wrote the finish');
      assert.equal(ended.endReason, 'ended', 'CONTROL: a person ended it');
      await assertHandedBack(stack, w, first.jobId, {
        reason: 'SESSION_ENDED', sessionId: t.sessionId, rounds: 0, lastMessage: LAST_WORDS, before,
      });
      assert.equal((await identityOf(stack, t.taskId)).deliveredSha, FIXED, 'the identity was not frozen again');
      assert.deepEqual((await jobsOf(stack, { taskId: t.taskId })).map((job) => job.id), [first.jobId],
        'a session a person ended landed its commit again');
    } finally {
      await stack.db.$disconnect();
    }
  });

test('W-T5 SESSION_ENDED: a person deletes the revived session before it runs — handed back at once and delivered',
  { skip, timeout: 240_000 }, async () => {
    const stack = await connect();
    try {
      const { w, t, first } = await handedOff(stack, 'person-deleted');
      const revived = await stack.db.session.findUniqueOrThrow({
        where: { id: t.sessionId }, select: { ...WORD_SELECT },
      });
      assert.equal(revived.finishedAt, null, 'CONTROL: the landing-fix turn revived the session');
      const before = new Date();
      await stack.sessions.remove(w.ownerId, t.sessionId);
      const deleted = await stack.db.session.findUniqueOrThrow({
        where: { id: t.sessionId }, select: { deletedAt: true },
      });
      assert.ok(deleted.deletedAt, 'CONTROL: the session is in Trash');
      if (wordOf(revived) !== RunStatus.PENDING) {
        // A session the runner holds finishes by its finalize.
        await stack.api.finalize({ id: w.runnerId } as never, t.sessionId, {
          status: SharedRunStatus.SUCCEEDED, isolationStatus: 'worktree', branch: t.branch, branchSha: DELIVERED,
          baseSha: sha('b'),
        } as never);
      }
      await assertHandedBack(stack, w, first.jobId, {
        reason: 'SESSION_ENDED', sessionId: t.sessionId, rounds: 0, lastMessage: null, before,
      });
      assert.deepEqual((await jobsOf(stack, { taskId: t.taskId })).map((job) => job.id), [first.jobId]);
    } finally {
      await stack.db.$disconnect();
    }
  });

// ─── TASK_MOVED_ON ───────────────────────────────────────────────────────────────────────────────

test('W-T5 TASK_MOVED_ON: the task is reopened while its session holds the item — handed back with the reason, '
  + 'delivered to nobody and given no clock', { skip, timeout: 240_000 }, async () => {
  const stack = await connect();
  try {
    const { w, t, first } = await handedOff(stack, 'reopened');
    const view = await coordinatorView(stack, w, t.sessionId);
    const before = new Date();
    const reopened = await stack.tasks.update(w.ownerId, t.taskId, {
      status: TaskStatus.OPEN, supersededByTaskId: null, terminalReason: null,
    } as never);
    assert.equal(reopened.status, TaskStatus.OPEN, 'CONTROL: the task was reopened');
    await stack.openItems.deliverOwed(w.projectId);
    const item = await assertHandedBack(stack, w, first.jobId, {
      reason: 'TASK_MOVED_ON', sessionId: t.sessionId, rounds: 0, lastMessage: null, before,
    });
    assert.equal(item.state, 'OPEN', 'a reopened task\'s landing failure is answered by its next landing (§4.2)');
    assert.deepEqual(await coordinatorView(stack, w, t.sessionId), view,
      'the coordinator was given something about a task that moved on');
  } finally {
    await stack.db.$disconnect();
  }
});

test('W-T5 TASK_MOVED_ON: the task is cancelled — handed back, closed by §4.2 as TASK_CLOSED, and never delivered',
  { skip, timeout: 240_000 }, async () => {
    const stack = await connect();
    try {
      const { w, t, first } = await handedOff(stack, 'cancelled');
      const view = await coordinatorView(stack, w, t.sessionId);
      const before = new Date();
      await stack.tasks.update(w.ownerId, t.taskId, { status: TaskStatus.CANCELLED } as never);
      await stack.openItems.deliverOwed(w.projectId);
      const item = await assertHandedBack(stack, w, first.jobId, {
        reason: 'TASK_MOVED_ON', sessionId: t.sessionId, rounds: 0, lastMessage: null, before,
      });
      assert.deepEqual([item.state, item.resolution], ['RESOLVED', 'TASK_CLOSED'], 'the cancel did not close the item');
      assert.deepEqual(await coordinatorView(stack, w, t.sessionId), view,
        'the coordinator was given something about a cancelled task');
    } finally {
      await stack.db.$disconnect();
    }
  });

// ─── W8: ROUNDS_EXHAUSTED ────────────────────────────────────────────────────────────────────────

test('W8 / W-T4: after two rounds by the work session, the third failure opens straight to the coordinator — '
  + 'ROUNDS_EXHAUSTED, delivered at once, escalate_at from its opening — and the second\'s item is RETRIED',
  { skip, timeout: 300_000 }, async () => {
    const stack = await connect();
    try {
      const { w, t, first } = await handedOff(stack, 'rounds');
      const FIXED_AGAIN = sha('e');

      // Round 1: fixed, landed again, and the second generation fails too — handed to the session again.
      let fix = await runFixTurn(stack, w, t, first.jobId, { branchSha: FIXED, words: 'first fix' });
      await finalize(stack, w, t, fix, FIXED);
      const second = await claim(stack, w, 'LAND_TASK');
      await report(stack, w, second, conflict('MERGE', FIXED));
      const secondItem = await itemOf(stack, second.jobId);
      assert.equal(secondItem.workSessionId, t.sessionId, 'CONTROL: one round used, the failure went to the session again');
      assert.equal(secondItem.workSessionReturnedAt, null);

      // Round 2: fixed again, and the third generation fails.
      fix = await runFixTurn(stack, w, t, second.jobId, { branchSha: FIXED_AGAIN });
      await finalize(stack, w, t, fix, FIXED_AGAIN);
      const jobs = await jobsOf(stack, { taskId: t.taskId });
      assert.deepEqual(jobs.map((job) => [job.generation, job.retryRequestedBySessionId]),
        [[1, null], [2, t.sessionId], [3, t.sessionId]], 'CONTROL: two generations asked for by the work session');
      const third = await claim(stack, w, 'LAND_TASK');
      const before = new Date();
      await report(stack, w, third, conflict('MERGE', FIXED_AGAIN));

      const item = await assertHandedBack(stack, w, third.jobId, {
        reason: 'ROUNDS_EXHAUSTED', sessionId: t.sessionId, rounds: 2, lastMessage: LAST_WORDS, before,
      });
      assert.equal(item.workSessionOfferedAt?.getTime(), item.workSessionReturnedAt?.getTime(),
        'the exhausted failure was held by the work session at all');
      // No landing-fix turn for the third failure: it was never the session's.
      assert.equal(await stack.db.conversationTurn.count({
        where: { sessionId: t.sessionId, clientTurnId: landingFixTurnId(third.jobId) },
      }), 0, 'the third failure was offered to the work session');
      // H3: the second's item, which the work session's generation was handling, is superseded by the new one.
      const superseded = await itemOf(stack, second.jobId);
      assert.deepEqual([superseded.state, superseded.resolution], ['SUPERSEDED', 'RETRIED'],
        'the second generation\'s item was not superseded by the third\'s (H3)');
    } finally {
      await stack.db.$disconnect();
    }
  });

test('the hand-back PostgreSQL target is explicitly disposable', { skip }, () => {
  assertCoordinatorPgUrlIsIsolated(URL);
});
