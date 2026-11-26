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
import { JwtService } from '@nestjs/jwt';
import { Client } from 'pg';

import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import type { PushService } from '../push/push.service';
import type { QueueService } from '../queue/queue.service';
import { ReaperService } from '../realtime/reaper.service';
import type { RealtimeService } from '../realtime/realtime.service';
import { IntegrationJobRelay } from '../runner-api/integration-job-relay';
import { RunnerApiController } from '../runner-api/runner-api.controller';
import { RunnerOrchestrationAuthorizer } from '../runner-api/runner-orchestration-authorizer';
import { RunnerSessionsController } from '../runner-api/runner-sessions.controller';
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
import { readLandingView } from './landing-view';
import { readProjectListAttention } from './project-list-attention';
import { readTaskIntegrationViews } from './project-task-integration';
import { ProjectOpenItemService } from './project-open-item.service';
import { ProjectPromotionService } from './project-promotion.service';
import { ProjectTasksSettledProducer } from './project-tasks-settled.producer';
import { SessionAttemptService } from './session-attempt.service';
import { TaskExceptionInputProducer } from './task-exception-input.producer';
import { WakeDispositionService } from './wake-disposition.service';
import '../test-support/dequeue-under-lease';

/**
 * Where a landing failure handed to its task's own work session stands (`docs/project-integration-line-contract.md`
 * §12.7, revision 42): the four reads, on real PostgreSQL.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/projects/landing-fix-reads.pg.spec.ts
 *
 *  - the open-items read: each row carries `workSession { sessionId, offeredAt, returnedAt?, returnReason?, rounds }`;
 *    an item in the session's hands is listed under `withWorkSession` ("Being fixed by its session"), not in Needs you
 *    nor among the coordinator's, and is counted in no project's attention — even where the coordinator could not
 *    take it, which is where `openItemVisible` alone would have let it through;
 *  - the landing timeline: `Handed to the task's session`, `Fixed in <sha7> · landing again` and `Returned to the
 *    coordinator: <reason>`; the landing view's todos and the session list's landing row show the held item;
 *  - the task row: `FIXING` ("Landing · fixing"), naming the work session, while the session holds it;
 *  - the work session's own read of its task's landing (`GET /runner/sessions/:landingId`) without Session
 *    orchestration, and nothing else without it.
 *
 * Every job is queued by the product (the owner's Confirm writes DONE), claimed off a runner's beat and answered through
 * the runner's result door; the fix turn runs through the runner's own doors. Not destructive: every case owns freshly
 * generated ids and reads only its own rows.
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
    data: { id: ownerId, email: `${label}-${ownerId}@landing-fix-reads.invalid`, name: label, passwordHash: 'x' },
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

// ─── What the reads say ──────────────────────────────────────────────────────────────────────────

/** The failure handed to the work session (W-T1), on a project branch, and the landing it belongs to. */
async function handedOff(stack: Stack, label: string, failure: object = conflict('REBASE')) {
  const w = await world(stack, label);
  const t = await finishedTask(stack, w, label);
  const first = await claim(stack, w, 'LAND_TASK');
  await report(stack, w, first, failure);
  const item = await itemOf(stack, first.jobId);
  assert.equal(item.workSessionId, t.sessionId, 'CONTROL: the failure was handed to the work session (W-T1)');
  assert.equal(item.workSessionReturnedAt, null, 'CONTROL: the work session still holds it');
  const job = await stack.db.projectIntegrationJob.findUniqueOrThrow({ where: { id: first.jobId }, select: { landingId: true } });
  const landing = await stack.db.projectLanding.findUniqueOrThrow({ where: { id: job.landingId! }, select: { sessionId: true } });
  return { w, t, first, item, landingSessionId: landing.sessionId };
}

/** The project's open-items read, as `GET /projects/:id/open-items` serves it. */
async function openItems(stack: Stack, w: World) {
  return stack.openItems.list(w.ownerId, w.projectId);
}

/** The project's row on the projects index: what it asks of the owner and of its coordinator. */
async function attention(stack: Stack, w: World) {
  const all = await readProjectListAttention(stack.prisma, w.ownerId);
  return all.get(w.projectId) ?? null;
}

/** The task's row on its project's page. */
async function taskRow(stack: Stack, w: World, taskId: string) {
  const views = await readTaskIntegrationViews(stack.prisma, w.ownerId, w.projectId, [taskId]);
  return views.get(taskId)!;
}

/** The landing view, as `session_get` on the landing session id serves it. */
async function landingOf(stack: Stack, w: World, landingSessionId: string) {
  const view = await readLandingView(stack.prisma, w.ownerId, landingSessionId);
  assert.ok(view, 'CONTROL: the landing view reads');
  return view;
}

function sectionOf(view: Awaited<ReturnType<typeof landingOf>>, jobId: string) {
  const section = view.timeline?.sections.find((candidate) => candidate.jobId === jobId);
  assert.ok(section, `the timeline has no section for job ${jobId}`);
  return section;
}

/** The landing session's row on the project's session list (`GET /sessions?projectId=&includeLanding=1`). */
async function landingRow(stack: Stack, w: World, landingSessionId: string) {
  const rows = await stack.sessions.list(w.ownerId, { projectId: w.projectId, includeLanding: true }) as unknown as Array<{
    id: string; landing?: { state: string } | null;
  }>;
  return rows.find((row) => row.id === landingSessionId) ?? null;
}

/** `session_get` with Session orchestration off: the runner's own-landing door (`GET /runner/landings/:id`) as
 *  `callingSessionId` on `runnerId` — the answer, or the refusal's code. */
async function readWithoutOrchestration(stack: Stack, w: World, runnerId: string, callingSessionId: string, id: string) {
  const orchestration = new RunnerOrchestrationAuthorizer(stack.prisma, new JwtService({ secret: 'landing-fix-reads-pg' }));
  const door = new RunnerSessionsController(stack.sessions, orchestration, {} as never, {} as never);
  try {
    const body = await door.getOwnTaskLanding(
      { id: runnerId, ownerId: w.ownerId } as never, undefined, callingSessionId, id,
    ) as unknown as { id: string; landing?: { sessionId: string; taskId: string | null } };
    return { body, code: null as string | null };
  } catch (error) {
    const response = (error as { getResponse?: () => unknown }).getResponse?.() as { code?: string } | undefined;
    return { body: null, code: response?.code ?? (error as Error).message };
  }
}

test('§12.7 open items: an item in its task\'s own work session\'s hands carries workSession and is listed under '
  + 'withWorkSession — not in Needs you, not among the coordinator\'s, and in no attention even where the coordinator '
  + 'cannot take it', { skip, timeout: 240_000 }, async () => {
  const stack = await connect();
  try {
    const { w, t, item } = await handedOff(stack, 'reads-held');
    const read = await openItems(stack, w);
    const held = read.withWorkSession.find((row) => row.itemId === item.id);
    assert.ok(held, 'the held item is not listed under withWorkSession');
    assert.deepEqual(held.workSession, {
      sessionId: t.sessionId, offeredAt: item.workSessionOfferedAt, rounds: 0,
    }, 'the held item does not carry its work session');
    assert.equal(read.withCoordinator.some((row) => row.itemId === item.id), false,
      'the held item is listed among what the coordinator is handling');
    assert.equal(read.needsYou.some((row) => row.itemId === item.id), false, 'the held item is in Needs you');
    assert.deepEqual(held.actions, [], 'CONTROL: W9 offers no press on a held item');
    assert.equal(held.chat.sessionId, w.coordinatorSessionId, 'CONTROL: Chat about this still reaches the coordinator');
    assert.equal((await attention(stack, w))?.coordinatorBlockers ?? 0, 0, 'the held item is counted in attention');

    // The coordinator switched off: nothing can take the item's turn, so `openItemVisible` lets it through every
    // owner-facing read. It is still nobody's to act on.
    await stack.db.project.update({ where: { id: w.projectId }, data: { coordinatorEnabled: false } });
    const down = await attention(stack, w);
    assert.equal(down?.coordinatorBlockers ?? 0, 0,
      'with the coordinator unable to take it, the held item is counted in the coordinator\'s attention');
    assert.equal(down?.userBlockers ?? 0, 0, 'with the coordinator unable to take it, the held item asks the owner');
    assert.equal(down?.coordinatorItems ?? null, null, 'the held item is listed among the coordinator\'s items');
    assert.deepEqual(down?.ownerItems ?? [], [], 'the held item is listed among the owner\'s items');
    const unreachable = await openItems(stack, w);
    assert.ok(unreachable.withWorkSession.some((row) => row.itemId === item.id),
      'with the coordinator unable to take it, the held item left withWorkSession');
    assert.equal(unreachable.withCoordinator.some((row) => row.itemId === item.id), false);
    assert.equal(unreachable.needsYou.some((row) => row.itemId === item.id), false);
  } finally {
    await stack.db.$disconnect();
  }
});

test('§12.7 task row, landing view, session list: while the session holds it the task reads FIXING and names the '
  + 'session, the landing view lists the item with that session and draws "Handed to the task\'s session", and the '
  + 'session list\'s landing row reads FIXING', { skip, timeout: 240_000 }, async () => {
  const stack = await connect();
  try {
    const { w, t, first, item, landingSessionId } = await handedOff(stack, 'reads-row');
    const row = await taskRow(stack, w, t.taskId);
    assert.equal(row.state, 'FIXING', `the task row reads ${row.state}, not FIXING`);
    assert.equal(row.workSessionId, t.sessionId, 'the task row does not name the session fixing it');
    assert.equal(row.openItemId, item.id);
    assert.equal(row.handler, null, 'the task row names somebody else to act');
    assert.equal(row.since?.getTime(), item.workSessionOfferedAt!.getTime());

    const view = await landingOf(stack, w, landingSessionId);
    const todo = view.todos.find((candidate) => candidate.id === item.id);
    assert.ok(todo, 'the landing view hides the item its task\'s own session holds');
    assert.equal(todo.workSessionId, t.sessionId, 'the landing view\'s todo does not name the session');
    const section = sectionOf(view, first.jobId);
    const handed = section.entries.find((entry) => entry.kind === 'HANDED_TO_SESSION');
    assert.ok(handed, `the failed attempt's section has no hand-off line: ${JSON.stringify(section.entries.map((e) => e.kind))}`);
    assert.equal(handed.text, "Handed to the task's session");
    assert.equal(handed.at.getTime(), item.workSessionOfferedAt!.getTime());
    assert.equal((handed.data as { sessionId?: string }).sessionId, t.sessionId);
    assert.equal(section.entries.at(-1)?.kind, 'HANDED_TO_SESSION', 'the hand-off is not drawn after the attempt ended');
    assert.equal(section.entries.some((entry) => entry.kind === 'RETURNED_TO_COORDINATOR'), false);

    assert.equal((await landingRow(stack, w, landingSessionId))?.landing?.state, 'FIXING',
      'the session list\'s landing row does not say the failure is being fixed');
  } finally {
    await stack.db.$disconnect();
  }
});

test('§12.7 the fix lands again: the next generation reads "Fixed in <sha7> · landing again" by the task, the task row '
  + 'follows the new attempt, and a second failure is handed over again with rounds 1', { skip, timeout: 240_000 }, async () => {
  const stack = await connect();
  try {
    const { w, t, first, landingSessionId } = await handedOff(stack, 'reads-again');
    const fix = await runFixTurn(stack, w, t, first.jobId, { branchSha: FIXED });
    await finalize(stack, w, t, fix, FIXED);
    const jobs = await jobsOf(stack, { taskId: t.taskId, kind: 'LAND_TASK' });
    assert.equal(jobs.length, 2, 'CONTROL: the fix was queued to land again (W-T2)');
    const again = jobs[1]!;
    assert.equal(again.retryRequestedBySessionId, t.sessionId, 'CONTROL: the work session asked for the next generation');

    const queued = await taskRow(stack, w, t.taskId);
    assert.equal(queued.state, 'QUEUED', 'the task row does not follow the fix landing again');
    const view = await landingOf(stack, w, landingSessionId);
    const section = sectionOf(view, again.id);
    const fixed = section.entries.find((entry) => entry.kind === 'FIXED_BY_SESSION');
    assert.ok(fixed, `the next generation has no fix line: ${JSON.stringify(section.entries.map((e) => e.kind))}`);
    assert.equal(fixed.text, `Fixed in ${FIXED.slice(0, 7)} · landing again`);
    assert.deepEqual(fixed.actor, { type: 'TASK_SESSION', sessionId: t.sessionId });
    assert.equal(section.entries.some((entry) => entry.kind === 'RETRY'), false,
      'the fix landing again is drawn as a coordinator\'s rerun');
    assert.equal(section.trigger?.by, 'TASK', 'the fix landing again is not the task\'s');
    assert.equal(section.trigger?.sessionId, t.sessionId);

    // It fails again: W8 still has a round, so the new item goes to the same session, one round in.
    const second = await claim(stack, w, 'LAND_TASK');
    assert.equal(second.jobId, again.id);
    await report(stack, w, second, conflict('MERGE', FIXED));
    const reopened = await itemOf(stack, again.id);
    assert.equal(reopened.workSessionId, t.sessionId, 'CONTROL: the second failure went to the work session');
    const held = (await openItems(stack, w)).withWorkSession.find((row) => row.itemId === reopened.id);
    assert.equal(held?.workSession?.rounds, 1, 'the held item does not count the round its session used');
  } finally {
    await stack.db.$disconnect();
  }
});

test('§12.7 handed back: the row\'s workSession carries returnedAt, the reason and the rounds, the item is the '
  + 'coordinator\'s again everywhere, and the timeline draws "Returned to the coordinator: no new commit"',
{ skip, timeout: 240_000 }, async () => {
  const stack = await connect();
  try {
    const { w, t, first, item, landingSessionId } = await handedOff(stack, 'reads-back');
    const fix = await runFixTurn(stack, w, t, first.jobId, { branchSha: DELIVERED });
    await finalize(stack, w, t, fix, DELIVERED);
    const back = await itemOf(stack, first.jobId);
    assert.equal(back.workSessionReturnReason, 'NO_NEW_COMMIT', 'CONTROL: the item was handed back (W-T5)');

    // The coordinator's own undelivered items stay off the owner's read while its conversation can take them
    // (`openItemVisible`); with it switched off the handed-back item is on the read, as the coordinator's.
    await stack.db.project.update({ where: { id: w.projectId }, data: { coordinatorEnabled: false } });
    const read = await openItems(stack, w);
    assert.equal(read.withWorkSession.some((row) => row.itemId === item.id), false, 'a handed-back item is still held');
    const row = read.withCoordinator.find((candidate) => candidate.itemId === item.id);
    assert.ok(row, 'the handed-back item is not the coordinator\'s');
    assert.deepEqual(row.workSession, {
      sessionId: t.sessionId, offeredAt: item.workSessionOfferedAt, returnedAt: back.workSessionReturnedAt,
      returnReason: 'NO_NEW_COMMIT', rounds: 0, lastMessage: LAST_WORDS,
    }, 'the handed-back row does not say where it was and why it came back');

    const task = await taskRow(stack, w, t.taskId);
    assert.equal(task.state, 'CONFLICT');
    assert.equal(task.handler, 'COORDINATOR');
    assert.equal(task.workSessionId, undefined);

    const section = sectionOf(await landingOf(stack, w, landingSessionId), first.jobId);
    const kinds = section.entries.map((entry) => entry.kind);
    assert.deepEqual(kinds.slice(-2), ['HANDED_TO_SESSION', 'RETURNED_TO_COORDINATOR'],
      `the hand-off and hand-back do not close the attempt's section: ${JSON.stringify(kinds)}`);
    const returned = section.entries.at(-1)!;
    assert.equal(returned.text, 'Returned to the coordinator: no new commit');
    assert.equal(returned.reason, 'NO_NEW_COMMIT');
    assert.equal((returned.data as { lastMessage?: string | null }).lastMessage, LAST_WORDS,
      'the hand-back line does not carry the session\'s last words');
    assert.equal(returned.at.getTime(), back.workSessionReturnedAt!.getTime());
    assert.notEqual((await landingRow(stack, w, landingSessionId))?.landing?.state, 'FIXING',
      'the session list still says a handed-back failure is being fixed');
  } finally {
    await stack.db.$disconnect();
  }
});

test('§12.7 handed back with no last words: the hand-back line and the row carry lastMessage null',
{ skip, timeout: 240_000 }, async () => {
  const stack = await connect();
  try {
    const { w, t, first, item, landingSessionId } = await handedOff(stack, 'reads-silent');
    const fix = await runFixTurn(stack, w, t, first.jobId, { branchSha: DELIVERED, words: '' });
    await finalize(stack, w, t, fix, DELIVERED);
    assert.equal((await itemOf(stack, first.jobId)).workSessionReturnReason, 'NO_NEW_COMMIT', 'CONTROL: handed back');
    await stack.db.project.update({ where: { id: w.projectId }, data: { coordinatorEnabled: false } });
    const row = (await openItems(stack, w)).withCoordinator.find((candidate) => candidate.itemId === item.id);
    assert.equal(row?.workSession?.lastMessage, null);
    const section = sectionOf(await landingOf(stack, w, landingSessionId), first.jobId);
    const returned = section.entries.at(-1)!;
    assert.equal(returned.kind, 'RETURNED_TO_COORDINATOR');
    assert.equal((returned.data as { lastMessage?: string | null }).lastMessage, null);
  } finally {
    await stack.db.$disconnect();
  }
});

test('§12.7 the work session reads its own task\'s landing through session_get without Session orchestration, and '
  + 'nothing else', { skip, timeout: 240_000 }, async () => {
  const stack = await connect();
  try {
    const { w, t, first, landingSessionId } = await handedOff(stack, 'reads-own');
    const fix = await runFixTurn(stack, w, t, first.jobId, { branchSha: FIXED });
    // In its fix turn the session is live on its runner, and the account has Session orchestration off.
    const own = await readWithoutOrchestration(stack, w, w.runnerId, t.sessionId, landingSessionId);
    const caller = await stack.db.session.findUniqueOrThrow({
      where: { id: t.sessionId },
      select: { assignedRunnerId: true, deletedAt: true, cancelRequestedAt: true, finishedAt: true, taskId: true },
    });
    const subject = await stack.db.projectLanding.findUnique({ where: { sessionId: landingSessionId } });
    assert.equal(own.code, null, `the work session could not read its own task's landing: ${own.code} `
      + `(caller ${JSON.stringify(caller)}, landing ${JSON.stringify(subject)})`);
    assert.equal(own.body?.id, landingSessionId);
    assert.equal(own.body?.landing?.sessionId, landingSessionId, 'the read did not serve the landing view');
    assert.equal(own.body?.landing?.taskId, t.taskId);

    // Anything else is refused: another session, the work session itself, another task's landing.
    const refused = 'LANDING_NOT_THIS_SESSIONS_TASK';
    const coordinator = await readWithoutOrchestration(stack, w, w.runnerId, t.sessionId, w.coordinatorSessionId);
    assert.equal(coordinator.code, refused, 'the work session read another session');
    const self = await readWithoutOrchestration(stack, w, w.runnerId, t.sessionId, t.sessionId);
    assert.equal(self.code, refused, 'the door reads more than a landing');
    const other = await handedOff(stack, 'reads-other');
    const foreign = await readWithoutOrchestration(stack, w, w.runnerId, t.sessionId, other.landingSessionId);
    assert.equal(foreign.code, refused, 'the work session read another task\'s landing');
    // Not from another runner, and not as a session of no task.
    const elsewhere = await readWithoutOrchestration(stack, w, randomUUID(), t.sessionId, landingSessionId);
    assert.equal(elsewhere.code, refused, 'a session was read as another runner\'s');
    const notWork = await readWithoutOrchestration(stack, w, w.runnerId, w.coordinatorSessionId, landingSessionId);
    assert.equal(notWork.code, refused, 'a session of no task read the task\'s landing');
    // And the orchestration door is as it was: without a credential, session_get is refused.
    const orchestrationDoor = new RunnerSessionsController(stack.sessions,
      new RunnerOrchestrationAuthorizer(stack.prisma, new JwtService({ secret: 'landing-fix-reads-pg' })), {} as never, {} as never);
    await assert.rejects(orchestrationDoor.getSession(
      { id: w.runnerId, ownerId: w.ownerId } as never, undefined, t.sessionId, undefined, landingSessionId,
    ), /missing orchestration credential/);
    await finalize(stack, w, t, fix, FIXED);
  } finally {
    await stack.db.$disconnect();
  }
});
