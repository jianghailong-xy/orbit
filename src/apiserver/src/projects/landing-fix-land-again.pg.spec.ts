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
import { enqueueForDoneTask, settleDeliveredIdentityAfterFinish } from './project-integration-job';
import { canonicalRepoUrl } from './project-integration-line';
import { ProjectOpenItemService } from './project-open-item.service';
import { ProjectPromotionService } from './project-promotion.service';
import { ProjectTasksSettledProducer } from './project-tasks-settled.producer';
import { SessionAttemptService } from './session-attempt.service';
import { TaskExceptionInputProducer } from './task-exception-input.producer';
import { WakeDispositionService } from './wake-disposition.service';
import '../test-support/dequeue-under-lease';

/**
 * W7's land-again edge (`docs/project-integration-line-contract.md` §12.5, revision 42, ruling R2; W-T2, W-T3).
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/projects/landing-fix-land-again.pg.spec.ts
 *
 * A failed landing handed to its task's own work session (W5) revives it with the landing-fix turn (W6); when that
 * session's work settles — the turn ends, the DONE's end of its idle work is asked for, and the runner's finalize writes
 * the finish — the finish freezes the delivered identity from the branch as it now stands and decides there:
 *
 *  - a commit other than the failed job's source commit queues exactly one next generation through `queueLandingRetry`,
 *    with the work session as requester, the reason "Fixed by the task's own session" and the failed generation's
 *    class (CONFLICT too, R1); the item is marked H1 for it, by its id; the ordinary route queues nothing beside it;
 *    and when that generation lands, the item is RESOLVED / HANDLED in the work session's name — with no turn for the
 *    coordinator, no wake and no delivery, anywhere in the sequence;
 *  - on a MAIN line, the candidate that failed is superseded (M-T6) by one named by the delivered commit, whose
 *    CHECK_PROMOTION carries the same retry columns; the handed-off item stays OPEN through the supersession (and
 *    through the escalation backstop), while another failure item about the old candidate is closed as M-T6 closes
 *    it; the new check's READY closes the handed-off item as HANDLED;
 *  - `turnComplete` itself queues nothing; the same commit (NO_NEW_COMMIT) and a failed fix turn (TURN_FAILED) queue
 *    nothing either — those hand-backs are task 350mtSNTuKUVNMbsj7Srd's;
 *  - the reopen's H1 mark (`markEarlierLandingItemsHandling`, as the follow-up 350iSQS8qE2gdF2Po8EtT left it, by the
 *    DONE's actor) and W7's never mark the same item: a reopened task's next DONE leaves the item its work session holds
 *    as W7 marked it.
 *
 * And R2, checked before the edge was built: the platform's teardown of a DONE task's idle work session — the DONE's
 * own end request and the reaper's sweep — does not end a revived session that still has a wake source (a running
 * background job, a scheduled wakeup); it ends once nothing will wake it, or when its runner is gone. An ordinary DONE
 * task's idle session is ended by the reaper as before.
 *
 * Every job is queued by the product (the owner's Confirm writes DONE), claimed off a runner's beat and answered
 * through the runner's result door; the fix turn runs through the runner's own doors (claim, dequeue, its transcript,
 * `turnComplete`, `finalize`). Every work session ends as production ends it — the DONE asks for the end of its idle
 * session and the runner's finalize writes the finish. That end leaves `cancel_requested_at` beside
 * `end_reason = 'task_done'` on the row, and W4 admits it: it is the platform's own end of a done task's idle session.
 *
 * Not destructive: every case owns freshly generated ids and reads only its own rows. The reaper's sweep reads every
 * session; the other cases' sessions are finished or idle on a runner that is heard from.
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
const REASON = "Fixed by the task's own session";

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
  const sessions = new SessionsService(prisma, queue, realtime);
  const push = new Proxy({}, { get: () => () => Promise.resolve() }) as unknown as PushService;
  const openItems = new ProjectOpenItemService(prisma, sessions, push);
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
    data: { id: ownerId, email: `${label}-${ownerId}@landing-fix-land-again.invalid`, name: label, passwordHash: 'x' },
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

const conflict = (phase: 'REBASE' | 'MERGE' | 'MAIN_SYNC') => ({
  state: 'CONFLICT', phase, sourceSha: DELIVERED, targetShaBefore: sha('c'), upstreamSha: UPSTREAM,
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

const GREEN = {
  name: 'MERGE_CHECK', command: 'npm test', expectedExitCode: 0, exitCode: 0, timedOut: false, durationMs: 1_000,
  outputTail: 'ok',
};

const landed = (sourceSha: string) => ({
  state: 'LANDED', phase: 'VERIFY', sourceSha, targetShaBefore: sha('c'), upstreamSha: UPSTREAM,
  testedSha: sha('3'), testedTreeSha: sha('4'), landedSha: sha('3'), landedTreeSha: sha('4'), aheadOfUpstream: 1,
});

const ready = (sourceSha: string) => ({
  state: 'READY', phase: 'CHECK', sourceSha, targetShaBefore: UPSTREAM, upstreamSha: UPSTREAM,
  testedSha: sha('5'), testedTreeSha: sha('6'), aheadOfUpstream: 1, filesChanged: 1, checks: [GREEN], conflicts: [],
});

interface ItemRow {
  id: string;
  state: string;
  resolution: string | null;
  promotion_id: string | null;
  handling_job_id: string | null;
  handling_session_id: string | null;
  handling_user_id: string | null;
  handling_reason: string | null;
  resolved_by_session_id: string | null;
  resolved_by_job_id: string | null;
  resolution_note: string | null;
  work_session_id: string | null;
  work_session_returned_at: Date | null;
}

/** The one failure item `jobId` opened, with its work-session columns read by SQL. */
async function itemOf(stack: Stack, jobId: string): Promise<ItemRow> {
  const rows = await stack.db.$queryRaw<ItemRow[]>(Prisma.sql`
    SELECT i."id", i."state", i."resolution", i."promotion_id", i."handling_job_id", i."handling_session_id",
           i."handling_user_id", i."handling_reason", i."resolved_by_session_id", i."resolved_by_job_id",
           i."resolution_note",
           to_jsonb(i)->>'work_session_id' AS "work_session_id",
           (to_jsonb(i)->>'work_session_returned_at')::timestamptz AS "work_session_returned_at"
      FROM "project_open_item" i
     WHERE i."integration_job_id" = ${jobId}::uuid
       AND i."kind" IN ('INTEGRATION_CONFLICT', 'INTEGRATION_CHECK_FAILED', 'INTEGRATION_ERROR')`);
  assert.equal(rows.length, 1, `the job opened ${rows.length} failure items`);
  return rows[0]!;
}

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
  options: { branchSha: string; status?: SharedRunStatus; during?: () => Promise<void> },
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
      where: { id: t.sessionId, status: { in: [RunStatus.PENDING, RunStatus.AWAITING_INPUT] } },
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
      turnId: turn.id, payload: { text: 'merged the project branch in, fixed it and committed' },
    }],
  } as never);
  const ended = await stack.api.turnComplete({ id: w.runnerId } as never, t.sessionId, {
    turnId: turn.id, status: options.status ?? SharedRunStatus.SUCCEEDED, leaseOwner, branchSha: options.branchSha,
    ...(options.status === SharedRunStatus.FAILED ? { error: 'the engine exited with status 1' } : {}),
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

// ─── W-T2 → W-T3 on a project branch ─────────────────────────────────────────────────────────────

async function landsAgain(label: string, failure: object, failureClass: string): Promise<void> {
  const stack = await connect();
  try {
    const w = await world(stack, label);
    const t = await finishedTask(stack, w, label);
    const before = await coordinatorView(stack, w, t.sessionId);
    const first = await claim(stack, w, 'LAND_TASK');
    await report(stack, w, first, failure);
    let item = await itemOf(stack, first.jobId);
    assert.equal(item.work_session_id, t.sessionId, 'CONTROL: the failure was handed to the work session (W-T1)');

    const fix = await runFixTurn(stack, w, t, first.jobId, { branchSha: FIXED });
    // The turn's end decides nothing: it neither freezes nor queues (R2); it asks for the end of the idle session.
    assert.deepEqual((await jobsOf(stack, { taskId: t.taskId })).map((job) => job.id), [first.jobId],
      'turnComplete itself queued a landing');
    assert.equal((await stack.db.task.findUniqueOrThrow({ where: { id: t.taskId } })).deliveredAt, null,
      'turnComplete froze the identity W6 cleared');
    assert.equal(await endRequested(stack, t.sessionId), true, 'CONTROL: the DONE asked for the end of the idle session');

    await finalize(stack, w, t, fix, FIXED);

    // W-T2: the freeze from the branch, and exactly one next generation through queueLandingRetry.
    const task = await stack.db.task.findUniqueOrThrow({
      where: { id: t.taskId }, select: { status: true, deliveredSha: true, deliveredSessionId: true, deliveredBranch: true },
    });
    assert.deepEqual(task, {
      status: TaskStatus.DONE, deliveredSha: FIXED, deliveredSessionId: t.sessionId, deliveredBranch: t.branch,
    }, 'the finish did not freeze the delivered commit from the branch');
    const jobs = await jobsOf(stack, { taskId: t.taskId });
    assert.equal(jobs.length, 2, `the finish queued ${jobs.length - 1} generations`);
    const next = jobs[1]!;
    assert.deepEqual(next, {
      id: next.id, kind: 'LAND_TASK', generation: 2, state: 'QUEUED', sessionId: t.sessionId,
      sourceRef: `refs/heads/${t.branch}`, sourceSha: null, promotionId: null,
      retryOfJobId: first.jobId, retryFailureClass: failureClass, retryReason: REASON,
      retryRequestedBySessionId: t.sessionId, retryRequestedByUserId: null,
    }, 'the next generation is not the work session\'s retry of the failed one');
    item = await itemOf(stack, first.jobId);
    assert.equal(item.state, 'OPEN');
    assert.deepEqual(
      [item.handling_job_id, item.handling_session_id, item.handling_user_id, item.handling_reason],
      [next.id, t.sessionId, null, REASON],
      'the handed-off item was not marked H1 for the work session\'s generation',
    );
    assert.equal(item.work_session_returned_at, null, 'the item left the work session\'s hands');

    // The ordinary route reaches the same per-generation key and inserts nothing beside it.
    const ordinary = await stack.db.$transaction((tx) => enqueueForDoneTask(tx, w.ownerId, t.taskId));
    assert.equal(ordinary.enqueued, false, 'the ordinary route queued a second generation');
    const again = await stack.db.$transaction(async (tx) => settleDeliveredIdentityAfterFinish(tx, {
      id: t.sessionId, ownerId: w.ownerId, taskId: t.taskId, startsTaskWork: true,
    }));
    assert.equal(again, 'STANDING', 'a second settlement of the same finish froze or queued again');
    assert.equal((await jobsOf(stack, { taskId: t.taskId })).length, 2, 'a second generation was queued');

    // W-T3: the generation lands, and the item is handled in the work session's name.
    const rerun = await claim(stack, w, 'LAND_TASK');
    assert.equal(rerun.jobId, next.id);
    assert.equal(rerun.sourceRef, `refs/heads/${t.branch}`);
    await report(stack, w, rerun, landed(FIXED));
    item = await itemOf(stack, first.jobId);
    assert.deepEqual(
      [item.state, item.resolution, item.resolved_by_session_id, item.resolved_by_job_id, item.resolution_note],
      ['RESOLVED', 'HANDLED', t.sessionId, next.id, REASON],
      'the landing did not close the item as handled by the work session (H2)',
    );
    const done = await stack.db.projectIntegrationJob.findUniqueOrThrow({
      where: { id: next.id }, select: { state: true, sourceSha: true },
    });
    assert.deepEqual(done, { state: 'LANDED', sourceSha: FIXED });

    // No coordinator turn, wake or delivery anywhere in the sequence — nor any other conversation's turn.
    assert.deepEqual(await coordinatorView(stack, w, t.sessionId), before,
      'the coordinator was given something while the work session fixed its landing');
  } finally {
    await stack.db.$disconnect();
  }
}

test('W-T2/W-T3: a conflict fixed by the task\'s own session lands again — one generation, the work session its '
  + 'requester, the item handled then resolved, and no coordinator turn', { skip, timeout: 240_000 }, async () => {
  await landsAgain('conflict', conflict('REBASE'), 'CONFLICT');
});

test('W-T2/W-T3: a red check fixed by the task\'s own session lands again with the CHECK_FAILED class',
  { skip, timeout: 240_000 }, async () => {
    await landsAgain('red-check', redCheck(), 'CHECK_FAILED');
  });

// ─── W-T2 → W-T3 on a MAIN line ──────────────────────────────────────────────────────────────────

test('W-T2/W-T3 on a MAIN line: the failed candidate is superseded by one named by the new commit, the handed-off '
  + 'item stays OPEN through it, and the new check closes it', { skip, timeout: 240_000 }, async () => {
  const stack = await connect();
  try {
    const w = await world(stack, 'main-line', 'MAIN');
    const t = await finishedTask(stack, w, 'main-line');
    const before = await coordinatorView(stack, w, t.sessionId);
    const check = await claim(stack, w, 'CHECK_PROMOTION');
    assert.equal(check.promotionSourceKind, 'TASK_BRANCH', 'CONTROL: the candidate is the task branch');
    await report(stack, w, check, conflict('MERGE'));
    const old = (await stack.db.projectIntegrationJob.findUniqueOrThrow({
      where: { id: check.jobId }, select: { promotionId: true },
    })).promotionId!;
    let item = await itemOf(stack, check.jobId);
    assert.equal(item.work_session_id, t.sessionId, 'CONTROL: the failure was handed to the work session (W-T1)');
    assert.equal(item.promotion_id, old);
    // Another failure about the old candidate, still the coordinator's: M-T6 closes this one as it always has.
    const other = await stack.db.projectOpenItem.create({
      data: {
        projectId: w.projectId, ownerId: w.ownerId, kind: 'INTEGRATION_ERROR', assignee: 'COORDINATOR',
        assigneeReason: 'DEFAULT', promotionId: old, dedupeKey: `IE:${randomUUID()}`,
        title: 'an earlier failure of this candidate', payload: {}, waitingSince: new Date(), assignedAt: new Date(),
      },
      select: { id: true },
    });

    const fix = await runFixTurn(stack, w, t, check.jobId, { branchSha: FIXED });
    assert.equal((await jobsOf(stack, { projectId: w.projectId, kind: 'CHECK_PROMOTION' })).length, 1,
      'turnComplete itself queued a check');
    await finalize(stack, w, t, fix, FIXED);

    const candidates = await stack.db.projectPromotion.findMany({
      where: { taskId: t.taskId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { id: true, state: true, sourceSha: true, sourceRef: true, sessionId: true, checkJobId: true },
    });
    assert.equal(candidates.length, 2, `the finish made ${candidates.length - 1} candidates`);
    const [retired, fresh] = candidates as [typeof candidates[0], typeof candidates[0]];
    assert.equal(retired.id, old);
    assert.equal(retired.state, 'SUPERSEDED', 'the failed candidate was not superseded (M-T6)');
    assert.deepEqual(
      [fresh.state, fresh.sourceSha, fresh.sourceRef, fresh.sessionId],
      ['CHECKING', FIXED, `refs/heads/${t.branch}`, t.sessionId],
      'the new candidate is not named by the new delivered commit',
    );
    const jobs = await jobsOf(stack, { promotionId: fresh.id });
    assert.equal(jobs.length, 1, `the new candidate has ${jobs.length} jobs`);
    const recheck = jobs[0]!;
    assert.equal(recheck.id, fresh.checkJobId);
    assert.deepEqual(recheck, {
      id: recheck.id, kind: 'CHECK_PROMOTION', generation: 1, state: 'QUEUED', sessionId: t.sessionId,
      sourceRef: `refs/heads/${t.branch}`, sourceSha: FIXED, promotionId: fresh.id,
      retryOfJobId: check.jobId, retryFailureClass: 'CONFLICT', retryReason: REASON,
      retryRequestedBySessionId: t.sessionId, retryRequestedByUserId: null,
    }, 'the new check is not the work session\'s re-check of the failed one');
    item = await itemOf(stack, check.jobId);
    assert.equal(item.state, 'OPEN', 'the supersession closed the handed-off item');
    assert.equal(item.promotion_id, fresh.id, 'the handed-off item does not wait on the new candidate');
    assert.deepEqual(
      [item.handling_job_id, item.handling_session_id, item.handling_reason],
      [recheck.id, t.sessionId, REASON],
      'the handed-off item was not marked H1 for the new check',
    );
    const closed = await stack.db.projectOpenItem.findUniqueOrThrow({
      where: { id: other.id }, select: { state: true, resolution: true },
    });
    assert.deepEqual(closed, { state: 'SUPERSEDED', resolution: 'PROMOTION_MOVED_ON' },
      'the old candidate\'s other failure was not closed as M-T6 closes it');
    // The escalation tick's backstop finds it owed: it waits on a candidate that is live.
    await stack.escalation.reconcile();
    assert.equal((await itemOf(stack, check.jobId)).state, 'OPEN', 'the backstop closed the handed-off item');

    // W-T3: the new check is READY, and the item is handled in the work session's name.
    const rerun = await claim(stack, w, 'CHECK_PROMOTION');
    assert.equal(rerun.jobId, recheck.id);
    assert.equal(rerun.sourceSha, FIXED, 'the check was not handed the new delivered commit');
    await report(stack, w, rerun, ready(FIXED));
    item = await itemOf(stack, check.jobId);
    assert.deepEqual(
      [item.state, item.resolution, item.resolved_by_session_id, item.resolved_by_job_id],
      ['RESOLVED', 'HANDLED', t.sessionId, recheck.id],
      'the READY check did not close the item as handled by the work session (H2)',
    );
    assert.deepEqual(await coordinatorView(stack, w, t.sessionId), before,
      'the coordinator was given something while the work session fixed its candidate');
  } finally {
    await stack.db.$disconnect();
  }
});

// ─── The hand-backs' seams: nothing lands ────────────────────────────────────────────────────────

test('W7: work that settles on the commit the failed job was handed queues nothing (NO_NEW_COMMIT is the hand-back\'s)',
  { skip, timeout: 240_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'no-new-commit');
      const t = await finishedTask(stack, w, 'no-new-commit');
      const first = await claim(stack, w, 'LAND_TASK');
      await report(stack, w, first, conflict('MERGE'));
      const fix = await runFixTurn(stack, w, t, first.jobId, { branchSha: DELIVERED });
      await finalize(stack, w, t, fix, DELIVERED);
      assert.equal((await stack.db.task.findUniqueOrThrow({ where: { id: t.taskId } })).deliveredSha, DELIVERED,
        'CONTROL: the finish froze the same commit again');
      assert.deepEqual((await jobsOf(stack, { taskId: t.taskId })).map((job) => job.id), [first.jobId],
        'the same commit was landed again');
      assert.equal((await itemOf(stack, first.jobId)).handling_job_id, null, 'the item was marked for a generation');
    } finally {
      await stack.db.$disconnect();
    }
  });

test('W7: a fix turn that fails is no settled fix and queues nothing (TURN_FAILED is the hand-back\'s)',
  { skip, timeout: 240_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'turn-failed');
      const t = await finishedTask(stack, w, 'turn-failed');
      const first = await claim(stack, w, 'LAND_TASK');
      await report(stack, w, first, conflict('MERGE'));
      await runFixTurn(stack, w, t, first.jobId, { branchSha: FIXED, status: SharedRunStatus.FAILED });
      const session = await stack.db.session.findUniqueOrThrow({
        where: { id: t.sessionId }, select: { finishedAt: true },
      });
      assert.ok(session.finishedAt, 'CONTROL: the failed turn finished the session');
      assert.equal((await stack.db.task.findUniqueOrThrow({ where: { id: t.taskId } })).deliveredSha, FIXED,
        'CONTROL: the finish froze the identity it cleared');
      assert.deepEqual((await jobsOf(stack, { taskId: t.taskId })).map((job) => job.id), [first.jobId],
        'a failed fix turn landed again');
      assert.equal((await itemOf(stack, first.jobId)).handling_job_id, null, 'the item was marked for a generation');
    } finally {
      await stack.db.$disconnect();
    }
  });

// ─── The reopen's H1 mark and W7's never mark the same item ──────────────────────────────────────

/**
 * An EXECUTABLE task's run on a fresh work session, to its derived DONE and its finish: a turn ends, the acceptance it
 * queues passes, the DONE's end of the idle session is asked for, and the runner's finalize writes the finish — the
 * DONE whose actor is the run itself, which the reopen's H1 mark reads as the session that finished.
 */
async function acceptedRun(stack: Stack, w: World, taskId: string, label: string, branchSha: string): Promise<Finished> {
  const sessionId = randomUUID();
  const turnId = randomUUID();
  const branch = `orbit/${label}`;
  await stack.db.session.create({
    data: {
      id: sessionId, ownerId: w.ownerId, creatorId: w.ownerId, taskId, workspaceId: w.workspaceId,
      assignedRunnerId: w.runnerId, title: label, prompt: label, provider: 'claude', turnState: 'IN_FLIGHT',
      dispatchOrigin: SessionDispatchOrigin.USER, startsTaskWork: true, startedAt: new Date(), branch,
      isolationStatus: 'worktree', baseSha: sha('b'), branchSha, runtimeSessionId: randomUUID(),
    },
  });
  await stack.db.conversationTurn.create({
    data: {
      id: turnId, sessionId, seq: 1, clientTurnId: `message:${turnId}`, kind: 'message', content: 'do the work',
      status: 'IN_FLIGHT', deliveredAt: new Date(),
    },
  });
  await stack.api.events({ id: w.runnerId } as never, sessionId, {
    events: [{
      seq: 1, type: RunEventType.ASSISTANT, ts: new Date().toISOString(), turnId, payload: { text: 'the work is on the branch' },
    }],
  } as never);
  await stack.api.turnComplete({ id: w.runnerId } as never, sessionId, {
    turnId, status: SharedRunStatus.SUCCEEDED, branchSha,
  } as never);
  const acceptance = await (stack.api as unknown as {
    dequeueTurn: (sessionId: string, runnerId: string, lease: string | null) =>
      Promise<{ turnId: string; taskAcceptance?: boolean } | null>;
  }).dequeueTurn(sessionId, w.runnerId, null);
  assert.equal(acceptance?.taskAcceptance, true, 'CONTROL: the run\'s acceptance was queued');
  await stack.api.turnComplete({ id: w.runnerId } as never, sessionId, {
    turnId: acceptance!.turnId, status: SharedRunStatus.SUCCEEDED, subtype: 'shell', shellExitCode: 0, shellOutput: '',
    branchSha,
  } as never);
  assert.equal((await stack.db.task.findUniqueOrThrow({ where: { id: taskId } })).status, TaskStatus.DONE,
    'CONTROL: the acceptance wrote DONE');
  assert.equal(await endRequested(stack, sessionId), true, 'CONTROL: the DONE asked for the end of the idle session');
  await stack.api.finalize({ id: w.runnerId } as never, sessionId, {
    status: SharedRunStatus.SUCCEEDED, isolationStatus: 'worktree', branch, branchSha, baseSha: sha('b'),
  } as never);
  return { taskId, sessionId, branch };
}

test('W7 and the reopen\'s H1 never mark an item in the work session\'s hands: the reopen hands it back TASK_MOVED_ON, '
  + 'and only then does the reopened task\'s next DONE mark it for its own generation', { skip, timeout: 300_000 }, async () => {
  const stack = await connect();
  try {
    const w = await world(stack, 'reopened');
    const { id: taskId } = await stack.db.task.create({
      data: {
        ownerId: w.ownerId, creatorType: 'USER', creatorId: w.ownerId, title: 'Make reopened land', projectId: w.projectId,
        assigneeId: w.workspaceId, status: TaskStatus.IN_PROGRESS, completionCriterion: 'EXECUTABLE',
        acceptanceCommand: 'exit 0', acceptanceExpectedExitCode: 0, autoRunWhenReady: false,
      },
      select: { id: true },
    });
    const t = await acceptedRun(stack, w, taskId, 'reopened-first', DELIVERED);
    const first = await claim(stack, w, 'LAND_TASK');
    await report(stack, w, first, conflict('MERGE'));
    assert.equal((await itemOf(stack, first.jobId)).work_session_id, t.sessionId,
      'CONTROL: the failure was handed to the work session (W-T1)');
    const fix = await runFixTurn(stack, w, t, first.jobId, { branchSha: FIXED });
    await finalize(stack, w, t, fix, FIXED);
    const marked = await itemOf(stack, first.jobId);
    const fixed = (await jobsOf(stack, { taskId, generation: 2 }))[0];
    assert.ok(fixed, 'CONTROL: the work session\'s generation was queued');
    assert.deepEqual([marked.handling_job_id, marked.handling_session_id], [fixed.id, t.sessionId],
      'CONTROL: W7 marked the item for the work session\'s generation');

    // Reopened (J-T8 stops the work session's generation), run again on a new session, DONE again by its acceptance.
    const reopened = await stack.tasks.update(w.ownerId, taskId, {
      status: TaskStatus.OPEN, supersededByTaskId: null, terminalReason: null,
    } as never);
    assert.equal(reopened.status, TaskStatus.OPEN);
    assert.equal((await stack.db.projectIntegrationJob.findUniqueOrThrow({ where: { id: fixed.id } })).state, 'CANCELLED',
      'CONTROL: the reopen stopped the work session\'s generation');
    // W7: the reopen takes the item back from the work session (TASK_MOVED_ON), still as W7 marked it.
    const movedOn = await stack.db.projectOpenItem.findUniqueOrThrow({
      where: { id: marked.id },
      select: { workSessionReturnReason: true, handlingJobId: true, handlingSessionId: true },
    });
    assert.deepEqual(movedOn, { workSessionReturnReason: 'TASK_MOVED_ON', handlingJobId: fixed.id, handlingSessionId: t.sessionId },
      'the reopen did not hand the item back from the work session');
    const second = await acceptedRun(stack, w, taskId, 'reopened-second', sha('7'));
    const third = (await jobsOf(stack, { taskId, generation: 3 }))[0];
    assert.ok(third, 'CONTROL: the reopened DONE queued its own generation');
    assert.equal(third.sessionId, second.sessionId);

    // Handed back, the item is the reopened DONE's to mark (§4.2: its landing answers it), for its own generation.
    const item = await itemOf(stack, first.jobId);
    assert.equal(item.state, 'OPEN');
    assert.deepEqual(
      [item.handling_job_id, item.handling_session_id],
      [third.id, second.sessionId],
      'the reopened DONE\'s H1 did not take over the item the reopen handed back',
    );
  } finally {
    await stack.db.$disconnect();
  }
});

// ─── R2: the teardown does not end a revived session something will still wake ───────────────────

const WAKE_SOURCES: Record<string, {
  arm: (stack: Stack, sessionId: string) => Promise<void>;
  disarm: (stack: Stack, sessionId: string) => Promise<void>;
}> = {
  'a running background job': {
    arm: async (stack, sessionId) => {
      await stack.db.session.update({ where: { id: sessionId }, data: { runningBgJobs: ['bgj_landingfixtests'] } });
    },
    disarm: async (stack, sessionId) => {
      await stack.db.session.update({ where: { id: sessionId }, data: { runningBgJobs: [] } });
    },
  },
  'a scheduled wakeup': {
    arm: async (stack, sessionId) => {
      await stack.db.sessionScheduledWakeup.create({
        data: { sessionId, delaySeconds: 1800, reason: 'check the tests', dueAt: new Date(Date.now() + 30 * 60_000) },
      });
    },
    disarm: async (stack, sessionId) => {
      await stack.db.sessionScheduledWakeup.updateMany({
        where: { sessionId, state: 'PENDING' }, data: { state: 'CANCELLED', settledAt: new Date() },
      });
    },
  },
};

for (const [source, wake] of Object.entries(WAKE_SOURCES)) {
  test(`R2: a revived session with ${source} is not torn down by the DONE's end request or the reaper; `
    + 'it ends once nothing will wake it, and its finish lands the fix', { skip, timeout: 240_000 }, async () => {
    const stack = await connect();
    try {
      const label = `held-${source.split(' ').pop()}`;
      const w = await world(stack, label);
      const t = await finishedTask(stack, w, label);
      const first = await claim(stack, w, 'LAND_TASK');
      await report(stack, w, first, conflict('MERGE'));
      const fix = await runFixTurn(stack, w, t, first.jobId, {
        branchSha: FIXED,
        during: () => wake.arm(stack, t.sessionId),
      });
      assert.equal(await endRequested(stack, t.sessionId), false, `the DONE's end request ended a session with ${source}`);
      await sweep(stack, w);
      assert.equal(await endRequested(stack, t.sessionId), false, `the reaper ended a revived session with ${source}`);
      const held = await stack.db.session.findUniqueOrThrow({ where: { id: t.sessionId }, select: { finishedAt: true } });
      assert.equal(held.finishedAt, null);
      assert.deepEqual((await jobsOf(stack, { taskId: t.taskId })).map((job) => job.id), [first.jobId],
        'a landing was queued while the fix was still moving');

      await wake.disarm(stack, t.sessionId);
      await sweep(stack, w);
      assert.equal(await endRequested(stack, t.sessionId), true, 'the reaper did not end the session once nothing woke it');
      await finalize(stack, w, t, fix, FIXED);
      const jobs = await jobsOf(stack, { taskId: t.taskId });
      assert.deepEqual(jobs.map((job) => [job.generation, job.retryRequestedBySessionId]), [[1, null], [2, t.sessionId]],
        'the finish did not land the fix');
    } finally {
      await stack.db.$disconnect();
    }
  });
}

test('R2: a revived session with a running background job on a runner that is gone is ended as before',
  { skip, timeout: 240_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'held-offline');
      const t = await finishedTask(stack, w, 'held-offline');
      const first = await claim(stack, w, 'LAND_TASK');
      await report(stack, w, first, conflict('MERGE'));
      await runFixTurn(stack, w, t, first.jobId, {
        branchSha: FIXED,
        during: () => WAKE_SOURCES['a running background job']!.arm(stack, t.sessionId),
      });
      assert.equal(await endRequested(stack, t.sessionId), false, 'CONTROL: the DONE\'s end request left it');
      await stack.db.runner.update({
        where: { id: w.runnerId }, data: { status: RunnerStatus.OFFLINE, lastHeartbeatAt: minutesAgo(30) },
      });
      await stack.db.session.update({ where: { id: t.sessionId }, data: { runClaimedAt: minutesAgo(30) } });
      await stack.reaper.tick();
      assert.equal(await endRequested(stack, t.sessionId), true, 'a session no runner will wake was kept open');
    } finally {
      await stack.db.$disconnect();
    }
  });

test('R2, CONTROL: an ordinary DONE task\'s idle session with a running background job is ended by the reaper as before',
  { skip, timeout: 240_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'ordinary');
      const { id: taskId } = await stack.db.task.create({
        data: {
          ownerId: w.ownerId, creatorType: 'USER', creatorId: w.ownerId, title: 'ordinary', projectId: w.projectId,
          assigneeId: w.workspaceId, status: TaskStatus.IN_PROGRESS, completionCriterion: 'OWNER_CONFIRMED',
        },
        select: { id: true },
      });
      const sessionId = randomUUID();
      await stack.db.session.create({
        data: {
          id: sessionId, ownerId: w.ownerId, creatorId: w.ownerId, taskId, workspaceId: w.workspaceId,
          assignedRunnerId: w.runnerId, title: 'ordinary work', prompt: 'work', provider: 'claude',
          turnState: null, dispatchOrigin: SessionDispatchOrigin.USER, startsTaskWork: true,
          isolationStatus: 'worktree', branch: 'orbit/ordinary', branchSha: DELIVERED, baseSha: sha('b'), numTurns: 1,
          startedAt: minutesAgo(30), runtimeSessionId: randomUUID(), runningBgJobs: ['bgj_ordinaryjob1'],
        },
      });
      const receipt = await stack.confirmations.decide(
        w.ownerId, taskId, { door: 'USER', userId: w.ownerId }, { decision: 'CONFIRM' } as never,
      );
      assert.equal(receipt.completed, true, 'CONTROL: the confirmation wrote DONE');
      assert.equal(await endRequested(stack, sessionId), false, 'CONTROL: the DONE\'s end request left a session with a job');
      await sweep(stack, w);
      assert.equal(await endRequested(stack, sessionId), true, 'the reaper no longer ends an ordinary DONE task\'s session');
    } finally {
      await stack.db.$disconnect();
    }
  });

test('the land-again PostgreSQL target is explicitly disposable', { skip }, () => {
  assertCoordinatorPgUrlIsIsolated(URL);
});
