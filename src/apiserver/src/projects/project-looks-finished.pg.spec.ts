/**
 * Project closing, D4 and D5, on real PostgreSQL: a project that LOOKS finished and that Orbit still
 * cannot record done — why each criterion is not on main, who is told, and in what order.
 *
 * WHY THIS EXISTS
 * ---------------
 * On 2026-10-01 a project had every criterion met and every task settled, and the projection kept
 * withholding DONE because its go-live task had made no commits: no receipt could ever put that
 * criterion on `main`. Its "Why is this project not done?" card counted the same gap twice and
 * suggested forging a merge receipt; nobody who could act was told; and the one-shot judgment the
 * settled project opened — in the minutes between the work landing on the project branch and that
 * branch reaching main — filed a needless "merge into main" task against the criterion that was met.
 *
 * WHAT IT WITNESSES, AND THROUGH WHICH DOORS
 * ------------------------------------------
 *   (1) Every criterion's landing reason, as `derivedDone` serves it: one project with a criterion in
 *       each state, read through `readDerivedProjectDone` and through `GET /projects/:id`, which must
 *       agree, with every count added up once. The paired control is the criterion on main, whose
 *       reason is null.
 *   (2) A project that looks finished: the coordinator conversation receives the settled fact as a
 *       message naming each criterion Orbit cannot prove and why, and asking it to request done or go
 *       and do the work — and no judgment session opens. Driven through the runner's own doors: the
 *       last task's acceptance command derives DONE, which queues its landing in the same transaction;
 *       while that landing is in flight NOTHING is said to anybody; the line's answer is posted on
 *       the route a runner posts it, and that is when the coordinator is told.
 *   (3) The escalation, read through the session list: nothing before the project's
 *       `exceptionEscalationSeconds` have run out since the delivery; "Record as done…"
 *       (`RECORD_AS_DONE`) on the coordinator's row after; nothing while a request to record it done
 *       is open; nothing once the owner has recorded it done.
 *   (4) A landing that puts the last work on the project branch queues the merge into main BEFORE
 *       the settled fact is derived, so the project never looks finished in that gap.
 *   (5) A judgment opened because a project's tasks settled files no task while a landing is in
 *       flight, and the same task is filed once nothing is.
 *
 * Not destructive: every case owns freshly generated ids and asserts over its own project.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/projects/project-looks-finished.pg.spec.ts
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import {
  CreatorType,
  PrismaClient,
  ProjectStatus,
  RunStatus,
  RunnerStatus,
  SessionDispatchOrigin,
  TaskStatus,
} from '@prisma/client';
import {
  IntegrationJobCommand,
  IntegrationJobResultRequest,
  RunEventType,
  RunStatus as SharedRunStatus,
} from '@orbit/shared';
import { Client } from 'pg';

import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import { QueueService } from '../queue/queue.service';
import { RealtimeService } from '../realtime/realtime.service';
import { IntegrationJobRelay } from '../runner-api/integration-job-relay';
import { RunnerApiController } from '../runner-api/runner-api.controller';
import { MergeReceiptService } from '../sessions/merge-receipt.service';
import { SessionsService } from '../sessions/sessions.service';
import { TasksService } from '../tasks/tasks.service';
import { CompletionInputRouter } from './completion-input-router.service';
import { CoordinatorConvergenceService } from './coordinator-convergence.service';
import { CoordinatorDeliveryService, coordinatorDeliveryTurnId } from './coordinator-delivery.service';
import { CoordinatorJudgmentService } from './coordinator-judgment.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from './coordinator-pg-test-safety';
import { CoordinatorWakeService } from './coordinator-wake.service';
import { CriterionReadyProducer } from './criterion-ready.producer';
import { CriterionUnlandedProducer } from './criterion-unlanded.producer';
import { readOwnerDecisionSignals } from './owner-decision-signal';
import { criterionKeyOf } from './project-acceptance';
import { ProjectAcceptanceService } from './project-acceptance.service';
import { readDerivedProjectDone } from './project-done-derived';
import { branchName } from './project-criterion-landing';
import { INTEGRATION_JOB_CLAIM } from './project-integration-job';
import { configureProjectIntegration } from './project-integration-line';
import { ProjectOpenItemService } from './project-open-item.service';
import { ProjectPromotionService } from './project-promotion.service';
import { ProjectTasksSettledProducer } from './project-tasks-settled.producer';
import { ProjectsService } from './projects.service';
import { TaskExceptionInputProducer } from './task-exception-input.producer';
import { WakeDispositionService } from './wake-disposition.service';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

/** A full 40-hex object name, the only kind a receipt or a job accepts. */
const sha = (nibble: string) => nibble.repeat(40);

/** The verification method every criterion here declares; never the thing under test. */
const METHOD = 'A person reads it and says whether it holds';

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
  acceptance: ProjectAcceptanceService;
  /** The receipt writer, behind the same router a task write knocks on. */
  receipts: MergeReceiptService;
  /** The route a runner posts an integration job's result on, with every post-commit edge wired. */
  api: RunnerApiController;
  /** The heartbeat's half of the integration queue: what a runner claims and reports on. */
  jobs: IntegrationJobRelay;
}

/**
 * The production wiring over one client: the real completion-input router behind task writes and
 * receipts, the settled-task producer with both of its carriers, and the runner route that posts a
 * landing's result — considering the next merge into main, then deriving the facts.
 */
async function connect(): Promise<Stack> {
  await verifyDisposableDatabase();
  const db = prismaClientFor(URL!);
  const prisma = db as unknown as PrismaService;
  const realtime = new Proxy({}, { get: () => () => undefined }) as unknown as RealtimeService;
  const queue = { notifySessionQueued: () => undefined } as unknown as QueueService;
  const sessions = new SessionsService(prisma, queue, realtime);
  const convergence = new CoordinatorConvergenceService(prisma);
  const judgments = new CoordinatorJudgmentService(prisma, new CoordinatorWakeService(prisma), sessions);
  const deliveries = new CoordinatorDeliveryService(prisma, new CoordinatorWakeService(prisma), sessions);
  const router = new CompletionInputRouter(
    new CoordinatorWakeService(prisma),
    new ProjectTasksSettledProducer(prisma, judgments, convergence, deliveries),
    new TaskExceptionInputProducer(prisma, convergence),
    new CriterionReadyProducer(prisma, convergence),
    new WakeDispositionService(prisma, judgments, deliveries),
    new CriterionUnlandedProducer(prisma, convergence),
  );
  const openItems = new ProjectOpenItemService(prisma, sessions);
  const tasks = new TasksService(prisma, sessions, realtime, undefined, router, undefined, openItems);
  const acceptance = new ProjectAcceptanceService(prisma);
  const projects = new ProjectsService(prisma, acceptance, sessions);
  const receipts = new MergeReceiptService(prisma, router);
  const jobs = new IntegrationJobRelay(prisma, openItems);
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
    receipts,
    sessions,
    openItems,
    jobs,
    undefined,
    new ProjectPromotionService(prisma),
  );
  return { db, sessions, tasks, projects, acceptance, receipts, api, jobs };
}

interface World {
  ownerId: string;
  runnerId: string;
  workspaceId: string;
  projectId: string;
  coordinatorSessionId: string;
}

/**
 * One owner, one runner, one project that integrates on a branch of its own, and the PARKED
 * conversation it is coordinated from. The line is chosen through the owner's settings door, the
 * criteria are stated through the owner's write and confirmed at the owner's door — which is also
 * what starts the project — so every fact below is produced the way the product produces it.
 */
async function world(stack: Stack, label: string, criteria: string[]): Promise<World & {
  keys: string[];
}> {
  const db = stack.db;
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const coordinatorSessionId = randomUUID();
  await db.user.create({
    data: { id: ownerId, email: `${label}-${ownerId}@looks-finished.invalid`, name: label, passwordHash: 'x' },
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
    data: {
      id: workspaceId,
      ownerId,
      runnerId,
      name: `${label}-workspace`,
      enabled: true,
      repoUrl: `https://git.invalid/orbit/${label}.git`,
      workDir: `/srv/${label}`,
    },
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
      content: `协调：${label}`,
      status: 'ANSWERED',
    },
  });
  await db.project.create({
    data: {
      id: projectId,
      ownerId,
      title: `${label} project`,
      goal: 'a project that is finished says so, and one that only looks finished asks',
      coordinatorEnabled: true,
      coordinatorWorkspaceId: workspaceId,
      coordinatorSessionId,
    },
  });
  await db.projectRuntime.upsert({ where: { projectId }, create: { projectId }, update: {} });
  await db.$transaction((tx) => configureProjectIntegration(tx, {
    ownerId,
    projectId,
    settings: { line: 'PROJECT_BRANCH' },
  }));
  // A line that has been integrating for a while, as a project nearing its end has: a DONE here is
  // not the beat that starts it, so it queues its own landing and back-fills nobody else's (L3).
  await db.projectCodebase.updateMany({
    where: { projectId, slot: 'primary' },
    data: { integrationStartedAt: new Date(Date.now() - 60_000) },
  });
  await stack.projects.update(ownerId, projectId, {
    acceptanceCriteriaItems: criteria.map((text) => ({ text, verificationMethod: METHOD })),
  } as never);
  const standing = await stack.acceptance.standardSetConfirmation(ownerId, projectId);
  await stack.acceptance.confirmStandardSet(ownerId, projectId, {
    criteriaDigest: standing.currentVersion.digest,
  });
  const definitions = await db.projectAcceptanceCriterionDefinition.findMany({
    where: { projectId }, orderBy: { ordinal: 'asc' }, select: { id: true },
  });
  return {
    ownerId, runnerId, workspaceId, projectId, coordinatorSessionId,
    keys: definitions.map((definition) => criterionKeyOf(definition.id)),
  };
}

/** One EXECUTABLE task serving `criterionKey`, filed through the product with no run on it yet. */
async function servingTask(stack: Stack, w: World, criterionKey: string, title: string) {
  return stack.tasks.create(w.ownerId, {
    title,
    projectId: w.projectId,
    criterionKey,
    completionCriterion: 'EXECUTABLE',
    acceptanceCommand: 'true',
    acceptanceExpectedExitCode: 0,
    autoRunWhenReady: false,
  } as never);
}

/** A run of that task, as the runner left it: a worktree on `branch`, or none at all. */
async function workSession(
  stack: Stack,
  w: World,
  taskId: string,
  branch: string | null,
  status: RunStatus = RunStatus.SUCCEEDED,
): Promise<string> {
  const id = randomUUID();
  await stack.db.session.create({
    data: {
      id,
      ownerId: w.ownerId,
      creatorId: w.ownerId,
      taskId,
      workspaceId: w.workspaceId,
      assignedRunnerId: w.runnerId,
      title: `ran ${branch ?? 'no worktree'}`,
      prompt: 'do the work',
      provider: 'claude',
      status,
      dispatchOrigin: SessionDispatchOrigin.USER,
      startsTaskWork: true,
      startedAt: new Date(),
      ...(branch ? { branch, isolationStatus: 'worktree', baseSha: sha('b') } : {}),
    },
  });
  return id;
}

/**
 * Settle an EXECUTABLE task the way `runnerApi.turnComplete` settles one: a compare-and-set through
 * 0193/0230's BEFORE UPDATE fence, which says nothing about any branch.
 */
async function settleExecutable(stack: Stack, taskId: string): Promise<void> {
  const written = await stack.db.$executeRaw`
    UPDATE "task" SET "status" = 'DONE'
     WHERE "id" = ${taskId}::uuid
       AND "status" IN ('OPEN', 'IN_PROGRESS')
       AND "completion_criterion" = 'EXECUTABLE'
       AND "acceptance_command" = 'true'
       AND "acceptance_expected_exit_code" = 0`;
  assert.equal(written, 1, 'the EXECUTABLE task must reach DONE through the DONE fence');
}

/** A task that is DONE and whose branch a receipt puts on main: a criterion's work, on main. */
async function onMain(stack: Stack, w: World, criterionKey: string, label: string) {
  const task = await servingTask(stack, w, criterionKey, label);
  const sessionId = await workSession(stack, w, task.id, `orbit/${label}`);
  await settleExecutable(stack, task.id);
  await stack.receipts.record(w.ownerId, sessionId, {
    result: 'MERGED',
    sourceSha: sha('1'),
    targetBranch: 'main',
    targetShaBefore: sha('2'),
    targetShaAfter: sha('3'),
  }, 'AGENT');
  return task.id;
}

/** The project branch's short name, the way a receipt spells its target — read off the binding the
 *  owner's settings door wrote, rather than guessed. */
async function projectBranch(stack: Stack, w: World): Promise<string> {
  const codebase = await stack.db.projectCodebase.findFirstOrThrow({
    where: { projectId: w.projectId, slot: 'primary' }, select: { integrationRef: true },
  });
  return branchName(codebase.integrationRef);
}

/** A landing or promotion row, written the way the queue writes one — for the cases that only need
 *  the queue to HOLD something rather than to run it. */
async function queuedJob(
  stack: Stack,
  w: World,
  kind: 'LAND_TASK' | 'CHECK_PROMOTION',
  taskId: string | null,
  state: string = 'QUEUED',
): Promise<string> {
  const codebase = await stack.db.projectCodebase.findFirstOrThrow({
    where: { projectId: w.projectId, slot: 'primary' },
    select: { id: true, canonicalRepoUrl: true, integrationRef: true, upstreamRef: true },
  });
  const id = randomUUID();
  await stack.db.projectIntegrationJob.create({
    data: {
      id,
      projectId: w.projectId,
      ownerId: w.ownerId,
      codebaseId: codebase.id,
      kind,
      taskId,
      serialKey: `fixture:${codebase.canonicalRepoUrl}:${kind}:${id}`,
      targetRef: kind === 'LAND_TASK' ? codebase.integrationRef : codebase.upstreamRef,
      upstreamRef: codebase.upstreamRef,
      sourceRef: kind === 'LAND_TASK' ? `refs/heads/orbit/${id}` : codebase.integrationRef,
      state,
      idempotencyKey: `fixture:${id}`,
    },
  });
  return id;
}

/** The settled-task wakes this project's ledger holds. */
function settledWakes(stack: Stack, w: World) {
  return stack.db.projectCoordinatorWake.findMany({
    where: { projectId: w.projectId, event: 'PROJECT_TASKS_SETTLED' },
    select: { id: true, status: true, sessionId: true, idempotencyKey: true, updatedAt: true },
    orderBy: { createdAt: 'asc' },
  });
}

/** Sessions a wake opened for this project: one-shot judgments. */
function judgmentSessions(stack: Stack, w: World) {
  return stack.db.session.findMany({
    where: { ownerId: w.ownerId, dispatchOrigin: SessionDispatchOrigin.PROJECT_COORDINATOR },
    select: { id: true, prompt: true },
  });
}

/** The coordinator conversation's row as the session list serves it. */
async function coordinatorRow(stack: Stack, w: World) {
  const rows = await stack.sessions.list(w.ownerId, {}) as unknown as Array<{
    id: string; pendingApprovals: number; waitingKind?: string | null;
  }>;
  const row = rows.find((s) => s.id === w.coordinatorSessionId);
  assert.ok(row, 'the coordinator conversation is in this owner’s Open list');
  return row;
}

/** The Needs-you signals that name this project. */
async function signalsFor(stack: Stack, w: World) {
  return (await readOwnerDecisionSignals(stack.db as never, w.ownerId))
    .filter((signal) => signal.projectId === w.projectId);
}

// ── the runner's own doors, for the cases whose order of events IS the claim ───────────────────────

/** The turn a runner is handed next on a session, as its long-poll asks for it. */
function dequeue(stack: Stack, sessionId: string, runnerId: string) {
  return (stack.api as unknown as {
    dequeueTurn: (
      sessionId: string,
      runnerId: string,
      leaseGeneration: string | null,
    ) => Promise<{ turnId: string; kind: string; content?: string; taskAcceptance?: boolean } | null>;
  }).dequeueTurn(sessionId, runnerId, null);
}

/**
 * The engine's reply to a turn it ran, up the door the runner posts its transcript to: a turn is
 * ANSWERED because something answered it.
 */
async function answerTurn(stack: Stack, runnerId: string, sessionId: string, turnId: string) {
  const last = await stack.db.runEvent.aggregate({ where: { sessionId }, _max: { seq: true } });
  await stack.api.events({ id: runnerId }, sessionId, {
    events: [{
      seq: (last._max.seq ?? 0) + 1,
      type: RunEventType.ASSISTANT,
      ts: new Date().toISOString(),
      turnId,
      payload: { text: 'the work is on the branch' },
    }],
  });
}

/**
 * One code task carried to the point where a runner holds its landing — every step a door a real
 * runner knocks on: its run ends, its acceptance command derives DONE, and THAT transaction queues
 * the landing on the project branch (§2.3 J-T1a); the session's finish is recorded; the heartbeat
 * hands the landing out. Returned before the runner answers, so a case can look at the project
 * while the landing is in flight.
 */
async function claimedLanding(
  stack: Stack,
  w: World,
  criterionKey: string,
  label: string,
  /** A task already filed, for a case that needs the project's whole plan filed before any of it
   *  settles; otherwise one is filed here. */
  filed?: { id: string },
) {
  const task = filed ?? await servingTask(stack, w, criterionKey, label);
  const branch = `orbit/${label}`;
  const sessionId = await workSession(stack, w, task.id, branch, RunStatus.RUNNING);
  const turnId = randomUUID();
  await stack.db.conversationTurn.create({
    data: {
      id: turnId,
      sessionId,
      seq: 1,
      clientTurnId: `message:${turnId}`,
      kind: 'message',
      content: 'execute the task',
      status: 'IN_FLIGHT',
      deliveredAt: new Date(),
    },
  });
  await answerTurn(stack, w.runnerId, sessionId, turnId);
  await stack.api.turnComplete({ id: w.runnerId }, sessionId, {
    turnId,
    status: SharedRunStatus.SUCCEEDED,
  });
  const acceptance = await dequeue(stack, sessionId, w.runnerId);
  assert.equal(acceptance?.taskAcceptance, true, 'the acceptance command was queued for this task');
  await stack.api.turnComplete({ id: w.runnerId }, sessionId, {
    turnId: acceptance!.turnId,
    status: SharedRunStatus.SUCCEEDED,
    subtype: 'shell',
    shellExitCode: 0,
    shellOutput: '',
  });
  const settled = await stack.db.task.findUniqueOrThrow({ where: { id: task.id }, select: { status: true } });
  assert.equal(settled.status, TaskStatus.DONE, 'the acceptance command agreed');
  // The runner commits a worktree when it FINISHES the session, and a landing is not handed over
  // before that (J-T1a): the finish, and where HEAD ended, are what the queue reads.
  await stack.db.session.update({
    where: { id: sessionId },
    data: { finishedAt: new Date(), worktreeBranch: branch, worktreeDirty: false },
  });
  const claimed = await stack.jobs.dispatch({
    runnerId: w.runnerId,
    leaseOwner: `lease-${label}`,
    draining: false,
    capabilities: [INTEGRATION_JOB_CLAIM],
  });
  assert.equal(claimed.length, 1, 'the DONE queued one landing, and the heartbeat handed it out');
  return { taskId: task.id, sessionId, job: claimed[0]! };
}

/** What the runner posts for a job, over the route it posts it on — every post-commit edge wired. */
async function report(
  stack: Stack,
  w: World,
  job: IntegrationJobCommand,
  result: Omit<IntegrationJobResultRequest, 'claimGeneration' | 'leaseOwner'>,
) {
  const answer = await stack.api.integrationJobResult({ id: w.runnerId }, job.jobId, {
    claimGeneration: job.claimGeneration,
    leaseOwner: job.leaseOwner,
    ...result,
  });
  assert.equal(answer.accepted, true, `the runner's answer was refused: ${JSON.stringify(answer)}`);
  return answer;
}

// ═══ (1) the reason every criterion is not on main ═══════════════════════════════════════════════

test('(1) derivedDone gives every criterion that is not on main its reason, and counts them once', {
  skip, concurrency: 1, timeout: 300_000,
}, async (t) => {
  const stack = await connect();
  t.after(() => stack.db.$disconnect().catch(() => undefined));
  const w = await world(stack, 'reasons', [
    'on main', 'in flight', 'on the project branch', 'nothing to land', 'no receipt',
    'looks codeless', 'declared codeless',
  ]);
  const [ON_MAIN, IN_FLIGHT, ON_BRANCH, NOTHING, NO_RECEIPT, LOOKS_CODELESS, DECLARED] = w.keys;

  // On main: the paired control, whose work a receipt puts on the upstream — no reason at all.
  await onMain(stack, w, ON_MAIN!, 'on-main');

  // In flight: finished, and its landing onto the project branch is still queued.
  const moving = await servingTask(stack, w, IN_FLIGHT!, 'in-flight');
  await workSession(stack, w, moving.id, 'orbit/in-flight');
  await settleExecutable(stack, moving.id);
  await queuedJob(stack, w, 'LAND_TASK', moving.id);

  // On the project branch: a receipt says the line moved with it, and nothing takes it further.
  const branched = await servingTask(stack, w, ON_BRANCH!, 'on-branch');
  const branchedSession = await workSession(stack, w, branched.id, 'orbit/on-branch');
  await settleExecutable(stack, branched.id);
  await stack.receipts.record(w.ownerId, branchedSession, {
    result: 'MERGED',
    sourceSha: sha('4'),
    targetBranch: await projectBranch(stack, w),
    targetShaBefore: sha('5'),
    targetShaAfter: sha('6'),
  }, 'RUNNER');

  // Nothing to land: the 10-01 go-live task. Its landing answered that the branch carried nothing
  // of its own, on a line that had moved past the upstream — so the answer cannot say the tip is on
  // main — and wrote the ALREADY_MERGED receipt onto the project branch that answer writes. The
  // landing lane reads ON_INTEGRATION_LINE; the reason says what that means.
  const empty = await servingTask(stack, w, NOTHING!, 'nothing-to-land');
  const emptySession = await workSession(stack, w, empty.id, 'orbit/nothing-to-land');
  await settleExecutable(stack, empty.id);
  await queuedJob(stack, w, 'LAND_TASK', empty.id, 'NOTHING_TO_LAND');
  await stack.receipts.record(w.ownerId, emptySession, {
    result: 'ALREADY_MERGED',
    sourceSha: sha('7'),
    targetBranch: await projectBranch(stack, w),
    targetShaBefore: sha('7'),
  }, 'RUNNER');

  // No receipt: it ran a branch, and nothing anywhere says where that branch went.
  const unreceipted = await servingTask(stack, w, NO_RECEIPT!, 'no-receipt');
  await workSession(stack, w, unreceipted.id, 'orbit/no-receipt');
  await settleExecutable(stack, unreceipted.id);

  // Looks codeless: its run took no worktree at all, so no landing was ever queued — and it never
  // declared what it is.
  const noBranch = await servingTask(stack, w, LOOKS_CODELESS!, 'looks-codeless');
  await workSession(stack, w, noBranch.id, null);
  await settleExecutable(stack, noBranch.id);

  // Declared codeless: LANDED, with nothing of its own to land — the other kind of landed.
  const definition = await stack.db.projectAcceptanceCriterionDefinition.findFirstOrThrow({
    where: { projectId: w.projectId, ordinal: 7 }, select: { id: true, revision: true },
  });
  assert.equal(criterionKeyOf(definition.id), DECLARED);
  const declared = await stack.db.task.create({
    data: {
      ownerId: w.ownerId,
      projectId: w.projectId,
      title: 'declared codeless',
      creatorType: CreatorType.USER,
      creatorId: w.ownerId,
      status: TaskStatus.OPEN,
      criterionDefinitionId: definition.id,
      criterionRevision: definition.revision,
      completionCriterion: 'EXECUTABLE',
      acceptanceCommand: 'true',
      acceptanceExpectedExitCode: 0,
      codeless: true,
    },
  });
  await settleExecutable(stack, declared.id);

  const derived = await readDerivedProjectDone(stack.db as unknown as PrismaService, w.ownerId, w.projectId);
  const byKey = new Map(derived.criteria.map((criterion) => [criterionKeyOf(criterion.definitionId), criterion]));
  const answer = (key: string | undefined) => {
    const criterion = byKey.get(key!);
    assert.ok(criterion, `criterion ${key} is not in the projection`);
    return [criterion.satisfied, criterion.landing, criterion.landingReason];
  };

  assert.deepEqual(answer(ON_MAIN), [true, 'LANDED', null], 'work on main by its own receipt has no reason');
  assert.deepEqual(answer(IN_FLIGHT), [true, 'UNKNOWN', 'IN_FLIGHT']);
  assert.deepEqual(answer(ON_BRANCH), [true, 'ON_INTEGRATION_LINE', 'ON_PROJECT_BRANCH']);
  assert.deepEqual(answer(NOTHING), [true, 'ON_INTEGRATION_LINE', 'NOTHING_TO_LAND'],
    'a branch with nothing on it is "nothing to land", not "on the project branch"');
  assert.deepEqual(answer(NO_RECEIPT), [true, 'UNKNOWN', 'NO_RECEIPT']);
  assert.deepEqual(answer(LOOKS_CODELESS), [true, 'UNKNOWN', 'CODELESS']);
  assert.deepEqual(answer(DECLARED), [true, 'LANDED', 'CODELESS'],
    'declared codeless is LANDED, and the reason says it had nothing to land');

  // Counted once, from those answers: on main and every reason partition the criteria, so two
  // numbers on one card can no longer disagree about one gap.
  assert.deepEqual(derived.counts, {
    criteria: 7,
    met: 7,
    landed: 2,
    onMain: 1,
    byReason: { IN_FLIGHT: 1, ON_PROJECT_BRANCH: 1, NOTHING_TO_LAND: 1, NO_RECEIPT: 1, CODELESS: 2 },
  });
  assert.equal(
    derived.counts.onMain + Object.values(derived.counts.byReason).reduce((sum, n) => sum + n, 0),
    derived.counts.criteria,
  );
  assert.deepEqual(derived.withheld, ['CRITERION_UNLANDED']);

  // And the project document serves the SAME reading — one read model, whoever asks.
  const document = await stack.projects.get(w.ownerId, w.projectId) as unknown as {
    derivedDone: typeof derived;
  };
  assert.deepEqual(document.derivedDone, derived, 'project_get and the projection read differently');

  // The control for IN_FLIGHT: the landing ends, and the same criterion is "no receipt" again —
  // the reason follows the queue rather than being a property of the task.
  await stack.db.projectIntegrationJob.updateMany({
    where: { projectId: w.projectId, taskId: moving.id, state: 'QUEUED' },
    data: { state: 'CANCELLED' },
  });
  const after = await readDerivedProjectDone(stack.db as unknown as PrismaService, w.ownerId, w.projectId);
  assert.equal(
    after.criteria.find((criterion) => criterionKeyOf(criterion.definitionId) === IN_FLIGHT)?.landingReason,
    'NO_RECEIPT',
  );
});

// ═══ (2) and (3): looks finished → the coordinator, with every reason → the owner ════════════════

test('(2)(3) a project that looks finished is handed to its coordinator with every reason, then to its owner', {
  skip, concurrency: 1, timeout: 300_000,
}, async (t) => {
  const stack = await connect();
  t.after(() => stack.db.$disconnect().catch(() => undefined));
  const w = await world(stack, 'looks-finished', [
    'the dispatcher change is on main',
    'the go-live walkthrough was done on production',
  ]);
  const [MAIN, GO_LIVE] = w.keys;

  // Both tasks are filed first, so the project settles exactly once: when the last of them does.
  const dispatcher = await servingTask(stack, w, MAIN!, 'dispatcher');
  const goLive = await servingTask(stack, w, GO_LIVE!, 'go-live');
  const dispatcherSession = await workSession(stack, w, dispatcher.id, 'orbit/dispatcher');
  await settleExecutable(stack, dispatcher.id);
  await stack.receipts.record(w.ownerId, dispatcherSession, {
    result: 'MERGED', sourceSha: sha('1'), targetBranch: 'main',
    targetShaBefore: sha('2'), targetShaAfter: sha('3'),
  }, 'AGENT');

  // ── the go-live task ends, and its DONE queues its landing: the work is in flight ──────────────
  let landing: IntegrationJobCommand | undefined;
  await t.test('(2a) while the last landing is in flight, nobody is told anything', async () => {
    // The go-live task: a run on a branch it committed nothing to.
    const { job } = await claimedLanding(stack, w, GO_LIVE!, 'go-live', goLive);
    assert.equal(job.kind, 'LAND_TASK');
    assert.deepEqual(await settledWakes(stack, w), [],
      'the settled project was told or judged while its work was still landing');
    assert.deepEqual(await judgmentSessions(stack, w), [],
      'a judgment opened in the gap between the landing and main — the 10-01 incident');
    const turns = await stack.db.conversationTurn.findMany({
      where: { sessionId: w.coordinatorSessionId, content: { contains: '看起来做完了' } },
    });
    assert.deepEqual(turns, [], 'the coordinator was told the project looks finished mid-landing');
    landing = job;
  });

  await t.test('(2b) when the line says the go-live branch had nothing to land, the coordinator is told why the project is not done', async () => {
    assert.ok(landing, 'the landing of (2a) is the one this case answers');
    // A line that has moved past the upstream: the answer cannot say the branch's tip is on main,
    // so the go-live criterion stays off LANDED — the 10-01 state exactly.
    await report(stack, w, landing!, {
      state: 'NOTHING_TO_LAND',
      phase: 'REBASE',
      sourceSha: sha('b'),
      targetShaBefore: sha('8'),
      upstreamSha: sha('9'),
    });

    const wakes = await settledWakes(stack, w);
    assert.equal(wakes.length, 1, 'the settled fact was derived once the landing ended');
    assert.equal(wakes[0]!.status, 'DELIVERED',
      'a finished-looking project goes to the conversation that can ask, not to a judgment');
    assert.equal(wakes[0]!.sessionId, w.coordinatorSessionId);
    assert.deepEqual(await judgmentSessions(stack, w), [], 'and no judgment session was opened');

    const delivered = await stack.db.conversationTurn.findFirst({
      where: {
        sessionId: w.coordinatorSessionId,
        clientTurnId: coordinatorDeliveryTurnId(wakes[0]!.idempotencyKey),
      },
      select: { content: true },
    });
    assert.ok(delivered, 'the delivery names a turn the conversation does not have');
    const message = delivered.content ?? '';
    assert.match(message, /看起来做完了，但 Orbit 自己记不了 Done/);
    // Every criterion Orbit cannot prove, with its reason; the one on main is not a gap.
    assert.ok(
      message.includes(`「the go-live walkthrough was done on production」（key ${GO_LIVE}）：NOTHING_TO_LAND`),
      `the go-live criterion's reason is missing:\n${message}`,
    );
    assert.equal(message.includes('「the dispatcher change is on main」'), false);
    assert.match(message, /2 条验收标准 · 2 条已满足 · 1 条在 main 上 · 1 条 NOTHING_TO_LAND/);
    // The two things it may do.
    assert.match(message, /project_request_done/);
    assert.match(message, /去干活/);
    // And what happens if it does neither, in the project's own window.
    assert.match(message, /exceptionEscalationSeconds（现在是 7200 秒）/);
    assert.match(message, /Record as done…/);

    const project = await stack.db.project.findUniqueOrThrow({
      where: { id: w.projectId }, select: { status: true },
    });
    assert.equal(project.status, ProjectStatus.OPEN, 'nothing records the project done for anybody');
  });

  // ── (3) and then the owner ─────────────────────────────────────────────────────────────────────
  const backdate = (table: 'project_coordinator_wake' | 'project_open_item', id: string, seconds: number) =>
    stack.db.$executeRawUnsafe(
      `UPDATE "${table}" SET "updated_at" = "updated_at" - make_interval(secs => $1) WHERE "id" = $2::uuid`,
      seconds,
      id,
    );

  await t.test('(3a) inside the escalation window the owner is not asked', async () => {
    assert.deepEqual(await signalsFor(stack, w), [], 'the owner was asked before the window ran out');
    const row = await coordinatorRow(stack, w);
    assert.notEqual(row.waitingKind, 'RECORD_AS_DONE');
  });

  await t.test('(3b) once exceptionEscalationSeconds have passed with no request, the owner’s Needs you shows Record as done…', async () => {
    const [wake] = await settledWakes(stack, w);
    await backdate('project_coordinator_wake', wake!.id, 7_200 + 1);

    assert.deepEqual(await signalsFor(stack, w), [{
      sessionId: w.coordinatorSessionId,
      projectId: w.projectId,
      count: 1,
      kind: 'RECORD_AS_DONE',
    }], 'it lands on the conversation the card is drawn in, as Record as done…');
    const row = await coordinatorRow(stack, w);
    assert.equal(row.pendingApprovals, 1, 'the coordinator row lights');
    assert.equal(row.waitingKind, 'RECORD_AS_DONE', 'and says what is waiting: Record as done…');
    const tally = (await stack.sessions.workspaceSessionCounts(w.ownerId))
      .find((counts) => counts.workspaceId === w.workspaceId);
    assert.equal(tally?.needsYou, 1, 'and the workspace tally counts it');
  });

  /** A request to record the project done, as the coordinator's `project_request_done` leaves it:
   *  owner-assigned from birth, about the criteria that stand. */
  async function requestDone(): Promise<string> {
    const standing = await stack.acceptance.standardSetConfirmation(w.ownerId, w.projectId);
    const id = randomUUID();
    const now = new Date();
    await stack.db.projectOpenItem.create({
      data: {
        id,
        projectId: w.projectId,
        ownerId: w.ownerId,
        kind: 'DONE_REQUEST',
        state: 'OPEN',
        assignee: 'OWNER',
        assigneeReason: 'DEFAULT',
        askedBySessionId: w.coordinatorSessionId,
        dedupeKey: 'DONE_REQUEST',
        title: 'Is this project done?',
        payload: {
          criteriaDigest: standing.currentVersion.digest,
          judgment: 'The goal is met; the go-live had nothing to land.',
          gaps: [{ criterionKey: GO_LIVE, whyNotProven: 'its task made no commits' }],
        },
        waitingSince: now,
        assignedAt: now,
        escalateAt: null,
      },
    });
    return id;
  }
  const recordAsDone = async () =>
    (await signalsFor(stack, w)).some((signal) => signal.kind === 'RECORD_AS_DONE');

  let requestId = '';
  await t.test('(3c) a request to record it done takes it back off the owner’s Needs you', async () => {
    requestId = await requestDone();
    assert.equal(await recordAsDone(), false,
      'Record as done… stood beside an open request to record the project done');
  });

  await t.test('(3d) after the owner answers "Not yet…", the clock runs from the answer', async () => {
    // Answered a window ago, and nothing asked since: the owner's again. One statement, because a
    // finished item is final (`project_open_item` refuses any later write to it).
    await stack.db.$executeRaw`
      UPDATE "project_open_item"
         SET "state" = 'RESOLVED', "resolution" = 'DECLINED', "resolved_by" = 'USER',
             "resolved_by_user_id" = ${w.ownerId}::uuid,
             "resolved_at" = now() - make_interval(secs => 7201),
             "updated_at" = now() - make_interval(secs => 7201)
       WHERE "id" = ${requestId}::uuid`;
    assert.deepEqual((await signalsFor(stack, w)).map((signal) => signal.kind), ['RECORD_AS_DONE'],
      'a window after the answer, with nothing asked since, it is the owner’s again');

    // Asked again, and answered "Not yet…" just now: the coordinator was just handed the question
    // back, so the owner is not asked the moment they said not yet.
    const again = await requestDone();
    assert.equal(await recordAsDone(), false);
    await stack.db.projectOpenItem.update({
      where: { id: again },
      data: {
        state: 'RESOLVED',
        resolution: 'DECLINED',
        resolvedAt: new Date(),
        resolvedBy: 'USER',
        resolvedByUserId: w.ownerId,
      },
    });
    assert.equal(await recordAsDone(), false, 'the owner was asked again the moment they said not yet');
  });

  await t.test('(3e) recording it done ends it', async () => {
    const standing = await stack.acceptance.standardSetConfirmation(w.ownerId, w.projectId);
    await stack.acceptance.recordProjectDone(w.ownerId, w.projectId, {
      requestId: null,
      criteriaDigest: standing.currentVersion.digest,
      acceptedGaps: [{ criterionKey: GO_LIVE!, whyNotProven: 'its task made no commits' }],
    });
    assert.deepEqual(await signalsFor(stack, w), [], 'a project recorded done still asked its owner');
  });
});

// ═══ (4) the gap between a landing and main ═══════════════════════════════════════════════════════

test('(4) a landing that leaves work on the project branch queues the merge into main before the settled fact is read', {
  skip, concurrency: 1, timeout: 300_000,
}, async (t) => {
  const stack = await connect();
  t.after(() => stack.db.$disconnect().catch(() => undefined));
  const w = await world(stack, 'gap', ['the change reaches main']);
  const [ONLY] = w.keys;

  const { taskId, job } = await claimedLanding(stack, w, ONLY!, 'gap');
  assert.deepEqual(await settledWakes(stack, w), [], 'settled while the landing was queued: nobody is told');

  // The runner lands the branch on the project branch. Everything on this edge is the product's own:
  // the receipt in the result's transaction, then the next merge into main considered, then the
  // facts derived — in that order.
  await report(stack, w, job, {
    state: 'LANDED',
    phase: 'PUSH',
    sourceSha: sha('a'),
    targetShaBefore: sha('c'),
    testedSha: sha('d'),
    testedTreeSha: sha('e'),
    landedSha: sha('d'),
    landedTreeSha: sha('e'),
    aheadOfUpstream: 1,
  });

  const merge = await stack.db.projectIntegrationJob.findMany({
    where: { projectId: w.projectId, kind: 'CHECK_PROMOTION' },
    select: { state: true },
  });
  assert.deepEqual(merge, [{ state: 'QUEUED' }], 'the landing did not queue the merge into main');
  // Read with the merge queued, the project does not look finished: the work is on its way to main.
  assert.deepEqual(await settledWakes(stack, w), [],
    'the settled fact was derived before the merge into main was queued, and the project looked finished in the gap');
  assert.deepEqual(await judgmentSessions(stack, w), []);
  const derived = await readDerivedProjectDone(stack.db as unknown as PrismaService, w.ownerId, w.projectId);
  assert.deepEqual(
    derived.criteria.map((criterion) => [criterion.landing, criterion.landingReason]),
    [['ON_INTEGRATION_LINE', 'IN_FLIGHT']],
    'its work is on the project branch and the merge into main that carries it is queued',
  );
  const receipts = await stack.db.sessionMergeReceipt.findMany({
    where: { taskId }, select: { result: true, targetBranch: true },
  });
  assert.deepEqual(receipts, [{ result: 'MERGED', targetBranch: await projectBranch(stack, w) }]);
});

// ═══ (5) a settled project's judgment files nothing while a landing is in flight ════════════════

test('(5) a judgment opened because the tasks settled files no task while a landing is in flight', {
  skip, concurrency: 1, timeout: 300_000,
}, async (t) => {
  const stack = await connect();
  t.after(() => stack.db.$disconnect().catch(() => undefined));
  const w = await world(stack, 'judged', ['the served part works', 'the unserved part works']);
  const [SERVED, UNSERVED] = w.keys;

  // One criterion served and finished, the other served by nothing: the project's tasks settle with
  // a criterion unmet, which is a judgment — through the task write's own post-commit edge.
  const served = await servingTask(stack, w, SERVED!, 'served');
  await workSession(stack, w, served.id, 'orbit/served');
  await settleExecutable(stack, served.id);
  await stack.tasks.update(w.ownerId, served.id, { title: 'served, renamed' } as never);
  const [opened] = await settledWakes(stack, w);
  assert.equal(opened?.status, 'SESSION_OPENED', 'a criterion nobody serves is still a judgment');
  const judgment = await stack.db.session.findUniqueOrThrow({
    where: { id: opened!.sessionId! }, select: { id: true, dispatchOrigin: true, prompt: true },
  });
  assert.equal(judgment.dispatchOrigin, SessionDispatchOrigin.PROJECT_COORDINATOR);
  // Its protocol no longer tells it to file a "merge into main" task, and says why it may not.
  assert.equal((judgment.prompt ?? '').includes('合并并录入主干证据'), false);
  assert.match(judgment.prompt ?? '', /TASK_LANDING_IN_FLIGHT/);

  // A landing starts after the judgment opened — the race the producer cannot see.
  const landingId = await queuedJob(stack, w, 'LAND_TASK', served.id);
  const merge = { title: '把成果合进 main', projectId: w.projectId, criterionKey: UNSERVED };
  await assert.rejects(
    () => stack.tasks.create(w.ownerId, merge as never, { type: CreatorType.AGENT, id: w.workspaceId }, judgment.id),
    (error: unknown) => {
      const body = (error as { getResponse?: () => unknown })?.getResponse?.() as
        { code?: string; requiredAction?: string } | undefined;
      assert.equal(body?.code, 'TASK_LANDING_IN_FLIGHT');
      assert.equal(body?.requiredAction, 'WAIT_FOR_THE_LANDING');
      return true;
    },
  );
  assert.equal(
    await stack.db.task.count({ where: { projectId: w.projectId, creatorSessionId: judgment.id } }), 0,
    'the judgment filed a task while the project’s work was landing',
  );

  // The control: the landing ends, and the same judgment files real work for the unmet criterion.
  await stack.db.projectIntegrationJob.update({ where: { id: landingId }, data: { state: 'CANCELLED' } });
  const filed = await stack.tasks.create(w.ownerId, {
    title: 'build the unserved part', projectId: w.projectId, criterionKey: UNSERVED,
  } as never, { type: CreatorType.AGENT, id: w.workspaceId }, judgment.id);
  assert.equal(filed.creatorSessionId, judgment.id, 'with nothing landing, the bound is the bound it was');
});

test('the looks-finished PostgreSQL target is explicitly disposable', { skip }, () => {
  assertCoordinatorPgUrlIsIsolated(URL);
});
