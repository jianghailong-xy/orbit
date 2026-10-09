import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import {
  Prisma,
  PrismaClient,
  RunStatus,
  RunnerStatus,
  SessionDispatchOrigin,
  TaskStatus,
} from '@prisma/client';
import { Client } from 'pg';

import {
  IntegrationJobCommand,
  IntegrationJobResultRequest,
  IntegrationCheckResult,
  RunEventType,
  RunStatus as SharedRunStatus,
} from '@orbit/shared';
import { HttpException } from '@nestjs/common';

import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { QueueService } from '../queue/queue.service';
import { RealtimeService } from '../realtime/realtime.service';
import { IntegrationJobRelay } from '../runner-api/integration-job-relay';
import { RunnerApiController } from '../runner-api/runner-api.controller';
import { SessionsService } from '../sessions/sessions.service';
import { TasksService } from '../tasks/tasks.service';
import { CompletionInputRouter } from './completion-input-router.service';
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
import { INTEGRATION_JOB_CLAIM } from './project-integration-job';
import { ProjectOpenItemEscalationService } from './open-item-escalation.service';
import { configureProjectIntegration } from './project-integration-line';
import { ProjectOpenItemService } from './project-open-item.service';
import { ProjectIntegrationRetryController } from './project-integration-retry.controller';
import { INTEGRATION_SKIP_CHECK_TOOL_NAME } from './project-integration-skip-check';
import { ProjectPromotionService } from './project-promotion.service';
import { ProjectTasksSettledProducer } from './project-tasks-settled.producer';
import { TaskExceptionInputProducer } from './task-exception-input.producer';
import { WakeDispositionService } from './wake-disposition.service';

/**
 * `integration_skip_merge_check` (docs/project-integration-line-contract.md §2.4 J-S5): a project's
 * coordinator queues ONE landing of a DONE task again with its merge check NOT RUN — and only with
 * the account owner's yes on a confirmation card.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/projects/integration-skip-merge-check.pg.spec.ts
 *
 * WHAT IT REPRODUCES. On 2026-10-07 the merge check of project 34bZ3i4AvgJaaoaw5E9tH failed on the
 * machine the runner was on: bash 3.2 has no `mapfile` and the machine has no GNU `timeout`, so the
 * command could not pass there whatever the delivery did. The doors that existed were all wrong for
 * that red — a rerun meets the same command on the same machine, sending the task back blames work
 * that is not at fault, and the check COMMAND is the owner's to change. This door is the fourth
 * thing: the landing goes on without that check, once, with the owner's answer on the record.
 *
 * Every case starts from a real failed landing — queued by its task's own DONE, claimed off the
 * heartbeat and reported red by the runner's own route — and goes on through the product's doors: the
 * runner route the coordinator calls, the heartbeat that hands the new generation out, and the result
 * route that lands it or fails it again.
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
  sessions: SessionsService;
  tasks: TasksService;
  api: RunnerApiController;
  jobs: IntegrationJobRelay;
  openItems: ProjectOpenItemService;
  ownerDoor: ProjectIntegrationRetryController;
}

/** The production wiring over one client, with the real completion-input router behind task writes. */
async function connect(): Promise<Stack> {
  await verifyDisposableDatabase();
  const db = prismaClientFor(URL!);
  const prisma = db as unknown as PrismaService;
  const realtime = new Proxy({}, { get: () => () => undefined }) as unknown as RealtimeService;
  const queue = { notifySessionQueued: () => undefined } as unknown as QueueService;
  const sessions = new SessionsService(prisma, queue, realtime);
  const convergence = new CoordinatorConvergenceService(prisma);
  const router = new CompletionInputRouter(
    new CoordinatorWakeService(prisma),
    new ProjectTasksSettledProducer(
      prisma,
      new CoordinatorJudgmentService(prisma, new CoordinatorWakeService(prisma), sessions),
      convergence,
      new CoordinatorDeliveryService(prisma, new CoordinatorWakeService(prisma), sessions),
    ),
    new TaskExceptionInputProducer(prisma, convergence),
    new CriterionReadyProducer(prisma, convergence),
    new WakeDispositionService(
      prisma,
      new CoordinatorJudgmentService(prisma, new CoordinatorWakeService(prisma), sessions),
      new CoordinatorDeliveryService(prisma, new CoordinatorWakeService(prisma), sessions),
    ),
    new CriterionUnlandedProducer(prisma, convergence),
  );
  const openItems = new ProjectOpenItemService(prisma, sessions);
  const tasks = new TasksService(prisma, sessions, realtime, undefined, router, undefined, openItems);
  const jobs = new IntegrationJobRelay(prisma, openItems);
  const ownerDoor = new ProjectIntegrationRetryController(openItems);
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
    undefined,
    openItems,
    jobs,
    undefined,
    new ProjectPromotionService(prisma),
  );
  return { db, sessions, tasks, api, jobs, openItems, ownerDoor };
}

interface World {
  ownerId: string;
  runnerId: string;
  workspaceId: string;
  projectId: string;
  coordinatorSessionId: string;
  /** A session of this owner that does NOT coordinate the project: the "someone else" of 403. */
  otherSessionId: string;
}

/**
 * One project integrating on a branch of its own (§1.2), with the conversation it is coordinated
 * from parked between turns, and a second conversation of the same account that coordinates nothing.
 */
async function world(stack: Stack, label: string, automatic = true): Promise<World> {
  const db = stack.db;
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const coordinatorSessionId = randomUUID();
  const otherSessionId = randomUUID();
  await db.user.create({
    data: { id: ownerId, email: `${label}-${ownerId}@skip.invalid`, name: label, passwordHash: 'x' },
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
  for (const [id, title] of [[coordinatorSessionId, `coordinator: ${label}`], [otherSessionId, `bystander: ${label}`]]) {
    await db.session.create({
      data: {
        id: id!,
        ownerId,
        creatorId: ownerId,
        workspaceId,
        assignedRunnerId: runnerId,
        title: title!,
        prompt: title!,
        provider: 'claude',
        status: RunStatus.AWAITING_INPUT,
        dispatchOrigin: SessionDispatchOrigin.USER,
        titleManagedByProject: id === coordinatorSessionId,
        numTurns: 1,
        startedAt: new Date(),
        runtimeSessionId: `runtime-${id}`,
      },
    });
    await db.conversationTurn.create({
      data: {
        sessionId: id!,
        seq: 1,
        clientTurnId: SessionsService.initialTurnClientId(id!),
        kind: 'message',
        content: title!,
        status: 'ANSWERED',
      },
    });
  }
  await db.project.create({
    data: {
      id: projectId,
      ownerId,
      title: `${label} project`,
      goal: 'every finished task reaches the line',
      coordinatorEnabled: automatic,
      coordinatorWorkspaceId: workspaceId,
      coordinatorSessionId,
    },
  });
  await db.projectRuntime.upsert({ where: { projectId }, create: { projectId }, update: {} });
  await db.$transaction((tx) => configureProjectIntegration(tx, {
    ownerId,
    projectId,
    settings: { line: 'PROJECT_BRANCH', mergeCheckCommand: 'npm test && go test ./...' },
  }));
  return { ownerId, runnerId, workspaceId, projectId, coordinatorSessionId, otherSessionId };
}

interface Attempt {
  taskId: string;
  title: string;
  sessionId: string;
  turnId: string;
  branch: string;
}

function dequeue(stack: Stack, sessionId: string, runnerId: string) {
  return (stack.api as unknown as {
    dequeueTurn: (
      sessionId: string,
      runnerId: string,
      leaseGeneration: string | null,
    ) => Promise<{ turnId: string; kind: string; content?: string; taskAcceptance?: boolean } | null>;
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
 * One code task carried to DONE through its own acceptance command — which queues its landing in the
 * same transaction (§2.3 J-T1a) — with the work session finished, as the runner leaves it.
 */
async function doneTask(stack: Stack, w: World, label: string): Promise<Attempt> {
  const title = `${label} ${randomUUID().slice(0, 8)}`;
  const branch = `orbit/${label}-${randomUUID().slice(0, 6)}`;
  const declared = await stack.tasks.create(w.ownerId, {
    title,
    assigneeId: w.workspaceId,
    projectId: w.projectId,
    acceptanceCommand: 'exit 0',
    acceptanceExpectedExitCode: 0,
  });
  const sessionId = randomUUID();
  const turnId = randomUUID();
  await stack.db.session.create({
    data: {
      id: sessionId,
      ownerId: w.ownerId,
      creatorId: w.ownerId,
      taskId: declared.id,
      workspaceId: w.workspaceId,
      assignedRunnerId: w.runnerId,
      title,
      prompt: title,
      provider: 'claude',
      status: RunStatus.RUNNING,
      dispatchOrigin: SessionDispatchOrigin.USER,
      startsTaskWork: true,
      startedAt: new Date(),
      branch,
      isolationStatus: 'worktree',
      baseSha: 'b'.repeat(40),
    },
  });
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
  await answerTurn(stack, w, sessionId, turnId, 'the work is on the branch');
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
  assert.equal(await taskStatus(stack.db, declared.id), TaskStatus.DONE, 'the acceptance command agreed');
  await stack.db.session.update({
    where: { id: sessionId },
    data: { finishedAt: new Date(), worktreeBranch: branch, worktreeDirty: false },
  });
  return { taskId: declared.id, title, sessionId, turnId, branch };
}

/** The runner asking for work, as its heartbeat does. */
function claim(stack: Stack, w: World, lease: string): Promise<IntegrationJobCommand[]> {
  return stack.jobs.dispatch({
    runnerId: w.runnerId,
    leaseOwner: lease,
    draining: false,
    capabilities: [INTEGRATION_JOB_CLAIM],
  });
}

type Failure = Omit<IntegrationJobResultRequest, 'claimGeneration' | 'leaseOwner'>;

/** The result a runner posts, over the route it posts it on. */
function report(stack: Stack, w: World, job: IntegrationJobCommand, result: Failure) {
  return stack.api.integrationJobResult({ id: w.runnerId }, job.jobId, {
    claimGeneration: job.claimGeneration,
    leaseOwner: job.leaseOwner,
    ...result,
  });
}

const RED_MERGE_CHECK: Failure = {
  state: 'CHECK_FAILED',
  phase: 'CHECK',
  sourceSha: 'a'.repeat(40),
  targetShaBefore: 'c'.repeat(40),
  testedSha: 'd'.repeat(40),
  testedTreeSha: 'e'.repeat(40),
  checks: [{
    name: 'MERGE_CHECK',
    command: 'npm test && go test ./...',
    expectedExitCode: 0,
    exitCode: 1,
    timedOut: false,
    durationMs: 1_609_148,
    outputTail: 'scripts/check.sh: line 12: mapfile: command not found\nFAIL',
  }],
};

/** What a runner reports for a job that landed: one tree tested and landed, as J2 demands. */
const LANDED: Failure = {
  state: 'LANDED',
  phase: 'PUSH',
  sourceSha: 'a'.repeat(40),
  targetShaBefore: 'c'.repeat(40),
  testedSha: 'd'.repeat(40),
  testedTreeSha: 'e'.repeat(40),
  landedSha: 'd'.repeat(40),
  landedTreeSha: 'e'.repeat(40),
  aheadOfUpstream: 1,
};

/** A DONE task whose first landing the runner reported failed in the given way. */
async function failedLanding(
  stack: Stack,
  w: World,
  label: string,
  failure: Failure = RED_MERGE_CHECK,
): Promise<{ task: Attempt; job: IntegrationJobCommand }> {
  const task = await doneTask(stack, w, label);
  const claimed = await claim(stack, w, `lease-${label}`);
  assert.equal(claimed.length, 1, `the DONE queued no landing — ${await jobsOf(stack.db, task.taskId)}`);
  const answer = await report(stack, w, claimed[0]!, failure);
  assert.equal(answer.accepted, true);
  return { task, job: claimed[0]! };
}

const REASON = 'this machine has no GNU timeout and bash 3.2 has no mapfile, so the check cannot pass here';

/**
 * The confirmation card the owner answered, as the runner's `askBeforeCreate` files it and the
 * server's own approvals route stores it — read back by the door that is called with its id.
 */
async function approvedCard(
  stack: Stack,
  w: World,
  taskId: string,
  status = 'ALLOWED',
  over: Record<string, unknown> = {},
): Promise<string> {
  const id = randomUUID();
  await stack.db.approval.create({
    data: {
      id,
      sessionId: w.coordinatorSessionId,
      toolName: INTEGRATION_SKIP_CHECK_TOOL_NAME,
      input: { projectId: w.projectId, projectTitle: 'skip project', taskId, reason: REASON },
      status,
      decidedAt: status === 'PENDING' ? null : new Date(),
      decidedById: status === 'PENDING' ? null : w.ownerId,
      ...over,
    },
  });
  return id;
}

/** The door as the runner route calls it: the acting session is the header's, the card the body's. */
function skipDoor(
  stack: Stack,
  w: World,
  taskId: string,
  given: { reason?: string; approvalId?: string },
  sessionId?: string,
) {
  return stack.openItems.skipIntegrationMergeCheck(
    w.ownerId,
    w.projectId,
    taskId,
    given,
    sessionId === undefined ? w.coordinatorSessionId : sessionId,
  );
}

/** The owner's own door, as the user controller calls it: no card, and a USER id recorded. */
function ownerSkip(stack: Stack, w: World, taskId: string, reason: string) {
  return stack.ownerDoor.skipIntegrationMergeCheck(
    { userId: w.ownerId, email: `${w.ownerId}@skip.invalid` },
    w.projectId,
    taskId,
    { reason },
  );
}

async function taskStatus(db: PrismaClient, taskId: string): Promise<TaskStatus> {
  return (await db.task.findUniqueOrThrow({ where: { id: taskId }, select: { status: true } })).status;
}

interface JobRow {
  id: string;
  generation: number;
  state: string;
  sourceRef: string;
  sessionId: string | null;
  retryOfJobId: string | null;
  retryFailureClass: string | null;
  retryReason: string | null;
  retryRequestedBySessionId: string | null;
  retryRequestedByUserId: string | null;
  skipMergeCheck: boolean;
  skipReason: string | null;
  skipApprovedByUserId: string | null;
  skipApprovalId: string | null;
}

function landings(db: PrismaClient, taskId: string): Promise<JobRow[]> {
  return db.projectIntegrationJob.findMany({
    where: { taskId, kind: 'LAND_TASK' },
    orderBy: [{ generation: 'asc' }, { createdAt: 'asc' }],
    select: {
      id: true, generation: true, state: true, sourceRef: true, sessionId: true,
      retryOfJobId: true, retryFailureClass: true, retryReason: true,
      retryRequestedBySessionId: true, retryRequestedByUserId: true,
      skipMergeCheck: true, skipReason: true, skipApprovedByUserId: true, skipApprovalId: true,
    },
  });
}

async function jobsOf(db: PrismaClient, taskId: string): Promise<string> {
  return `landings: ${JSON.stringify((await landings(db, taskId)).map((job) => [job.generation, job.state]))}`;
}

interface ItemRow {
  id: string;
  kind: string;
  state: string;
  assignee: string;
  integrationJobId: string | null;
  handlingJobId: string | null;
  handlingSessionId: string | null;
  handlingUserId: string | null;
  payload: {
    failureClass?: string;
    generation?: number;
    skippedCheck?: { reason?: string; approvedByUserId?: string; approvalId?: string | null };
  };
  supersededByItemId: string | null;
}

/** Every item about this task, oldest first. */
function itemsOf(db: PrismaClient, taskId: string): Promise<ItemRow[]> {
  return db.$queryRaw<ItemRow[]>(Prisma.sql`
    SELECT "id", "kind", "state", "assignee", "integration_job_id" AS "integrationJobId",
           "handling_job_id" AS "handlingJobId", "handling_session_id" AS "handlingSessionId",
           "handling_user_id" AS "handlingUserId",
           "payload", "superseded_by_item_id" AS "supersededByItemId"
      FROM "project_open_item"
     WHERE "task_id" = ${taskId}::uuid
     ORDER BY "created_at", "id"`);
}

/** The status and the code a refusal carries. */
async function denied(run: () => Promise<unknown>): Promise<{ status: number; code?: string; message: string }> {
  const thrown = await run().then(() => null, (error: unknown) => error);
  assert.ok(thrown instanceof HttpException, `the door answered instead of refusing: ${JSON.stringify(thrown)}`);
  const body = thrown.getResponse();
  const shaped = typeof body === 'string' ? { message: body } : (body as { code?: string; message?: string });
  return { status: thrown.getStatus(), code: shaped.code, message: shaped.message ?? '' };
}

test('an answered card queues one generation that is handed no merge check, and the record says who and why',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'skip-approved');
      const { task, job } = await failedLanding(stack, w, 'skip-approved');
      const [opened] = await itemsOf(stack.db, task.taskId);
      assert.equal(opened?.kind, 'INTEGRATION_CHECK_FAILED');
      assert.equal(opened?.assignee, 'COORDINATOR', 'Automatic hands the failure to the coordinator');

      const cardId = await approvedCard(stack, w, task.taskId);
      const skipped = await skipDoor(stack, w, task.taskId, { reason: `  ${REASON}  `, approvalId: cardId });

      const rows = await landings(stack.db, task.taskId);
      assert.deepEqual(rows.map((row) => [row.generation, row.state]), [[1, 'CHECK_FAILED'], [2, 'QUEUED']],
        'exactly one new generation, queued behind the failed one');
      const second = rows[1]!;
      assert.equal(skipped.jobId, second.id);
      assert.equal(skipped.generation, 2);
      assert.equal(skipped.retryOfJobId, job.jobId);
      assert.equal(skipped.failureClass, 'CHECK_FAILED');
      assert.equal(skipped.reason, REASON, 'the reason is kept as given, trimmed');
      assert.equal(skipped.sourceRef, `refs/heads/${task.branch}`);

      // THE RECORD: the skip, who approved it, and why — on the row itself, not inferred from an
      // empty checks array (which is also what a project with no check command produces).
      assert.equal(second.skipMergeCheck, true);
      assert.equal(second.skipReason, REASON);
      assert.equal(second.skipApprovedByUserId, w.ownerId, 'the person whose yes it is');
      assert.equal(second.skipApprovalId, cardId, 'and the card it was given on');
      assert.equal(second.retryRequestedBySessionId, w.coordinatorSessionId, 'the coordinator asked');
      assert.equal(second.retryRequestedByUserId, null);
      assert.deepEqual(skipped.skippedCheck, {
        reason: REASON, approvedByUserId: w.ownerId, approvalId: cardId,
      });

      // §4.7 H1: asking does not answer the item — the generation has not landed yet.
      const [after] = await itemsOf(stack.db, task.taskId);
      assert.equal(after?.state, 'OPEN');
      assert.equal(after?.handlingJobId, second.id, 'the coordinator\'s item is being handled by it');

      // WHAT THE RUNNER IS HANDED: the project's check is not among this generation's commands.
      const claimed = await claim(stack, w, 'lease-skip-approved');
      assert.equal(claimed.length, 1, `the skipped landing was not handed out — ${await jobsOf(stack.db, task.taskId)}`);
      const handed = claimed[0]!;
      assert.equal(handed.jobId, second.id);
      assert.deepEqual(handed.checks.map((check) => check.name), ['TASK_ACCEPTANCE'],
        'the merge check is NOT among them — skipped, not passed');
      assert.equal(handed.checks[0]!.command, 'exit 0', 'the task\'s own acceptance still runs');

      // …and it lands, with the project's own check command untouched by any of this. The only check
      // its result names is the task's own: there is no MERGE_CHECK to report because none ran.
      const landed = await report(stack, w, handed, LANDED);
      assert.equal(landed.accepted, true);
      const [final] = await landings(stack.db, task.taskId);
      assert.equal(final!.state, 'CHECK_FAILED', 'the failed generation is left exactly as it was');
      const merged = (await landings(stack.db, task.taskId))[1]!;
      assert.equal(merged.state, 'LANDED', 'and the skipped generation landed');
      const codebase = await stack.db.projectCodebase.findFirstOrThrow({
        where: { projectId: w.projectId, slot: 'primary' },
        select: { mergeCheckCommand: true },
      });
      assert.equal(codebase.mergeCheckCommand, 'npm test && go test ./...',
        'the project\'s check is a setting and is not what a skip touches');
    } finally {
      await stack.db.$disconnect();
    }
  });

test('no card and a declined card are both refused, and neither queues anything',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'skip-nocard');
      const { task } = await failedLanding(stack, w, 'skip-nocard');

      const missing = await denied(() => skipDoor(stack, w, task.taskId, { reason: REASON }));
      assert.equal(missing.status, 403);
      assert.equal(missing.code, 'INTEGRATION_SKIP_CHECK_APPROVAL_REQUIRED');
      assert.match(missing.message, /account owner's yes on a confirmation card/);

      const declinedCard = await approvedCard(stack, w, task.taskId, 'DENIED');
      const declined = await denied(() => skipDoor(stack, w, task.taskId, {
        reason: REASON, approvalId: declinedCard,
      }));
      assert.equal(declined.status, 403);
      assert.equal(declined.code, 'INTEGRATION_SKIP_CHECK_APPROVAL_REQUIRED');
      assert.match(declined.message, /no is an answer/);

      const pendingCard = await approvedCard(stack, w, task.taskId, 'PENDING');
      const pending = await denied(() => skipDoor(stack, w, task.taskId, {
        reason: REASON, approvalId: pendingCard,
      }));
      assert.equal(pending.status, 403);
      assert.match(pending.message, /still waiting for the account owner/);

      // A card about another landing of the same project is not this landing's yes either.
      const other = await doneTask(stack, w, 'skip-nocard-other');
      const otherCard = await approvedCard(stack, w, other.taskId);
      const mismatched = await denied(() => skipDoor(stack, w, task.taskId, {
        reason: REASON, approvalId: otherCard,
      }));
      assert.equal(mismatched.status, 403);
      assert.equal(mismatched.code, 'INTEGRATION_SKIP_CHECK_APPROVAL_MISMATCHED');

      // NOTHING WAS QUEUED by any of the four: one generation, the failed one, and no other.
      const rows = await landings(stack.db, task.taskId);
      assert.deepEqual(rows.map((row) => [row.generation, row.state]), [[1, 'CHECK_FAILED']],
        `a refused skip queued something — ${await jobsOf(stack.db, task.taskId)}`);
      const nothingSkipped = await stack.db.projectIntegrationJob.count({
        where: { taskId: task.taskId, skipMergeCheck: true },
      });
      assert.equal(nothingSkipped, 0);
    } finally {
      await stack.db.$disconnect();
    }
  });

test('a conversation that does not coordinate the project cannot skip anything',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'skip-bystander');
      const { task } = await failedLanding(stack, w, 'skip-bystander');
      const cardId = await approvedCard(stack, w, task.taskId, 'ALLOWED', {
        // The card is the bystander's own, so the refusal that comes back is about the session and
        // not about a card that was never theirs.
        sessionId: w.otherSessionId,
      });

      const refused = await denied(() => skipDoor(
        stack, w, task.taskId, { reason: REASON, approvalId: cardId }, w.otherSessionId,
      ));
      assert.equal(refused.status, 403);
      assert.equal(refused.code, 'INTEGRATION_RETRY_COORDINATOR_ONLY');

      // A terminal outside any session sends no header, and that is NOT read as the account owner.
      const headless = await denied(() => skipDoor(
        stack, w, task.taskId, { reason: REASON, approvalId: cardId }, '',
      ));
      assert.equal(headless.status, 403);
      assert.equal(headless.code, 'INTEGRATION_RETRY_COORDINATOR_ONLY');

      const rows = await landings(stack.db, task.taskId);
      assert.deepEqual(rows.map((row) => [row.generation, row.state]), [[1, 'CHECK_FAILED']],
        `a non-coordinator queued a generation — ${await jobsOf(stack.db, task.taskId)}`);
    } finally {
      await stack.db.$disconnect();
    }
  });

test("another account's card is no card here: refused as an id that names nothing is, repeating nothing of it",
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'skip-stranger');
      const { task } = await failedLanding(stack, w, 'skip-stranger');
      // Another account's coordinator, with a card its owner answered about a landing of its own.
      const them = await world(stack, 'skip-stranger-them');
      const theirs = await doneTask(stack, them, 'skip-stranger-theirs');
      const theirCard = await approvedCard(stack, them, theirs.taskId);

      const refusal = async (approvalId: string) => {
        const thrown = await skipDoor(stack, w, task.taskId, { reason: REASON, approvalId })
          .then(() => null, (error: unknown) => error);
        assert.ok(thrown instanceof HttpException, `the door answered instead of refusing: ${JSON.stringify(thrown)}`);
        return { status: thrown.getStatus(), body: thrown.getResponse() };
      };
      const stranger = await refusal(theirCard);
      assert.deepEqual(stranger, await refusal(randomUUID()), "another account's card was answered unlike no card");
      assert.equal(stranger.status, 403);
      assert.equal((stranger.body as { code?: string }).code, 'INTEGRATION_SKIP_CHECK_APPROVAL_REQUIRED');
      for (const theirFact of [theirCard, them.coordinatorSessionId, them.projectId, theirs.taskId]) {
        assert.equal(JSON.stringify(stranger.body).includes(theirFact), false, 'the refusal repeats their card');
      }

      const rows = await landings(stack.db, task.taskId);
      assert.deepEqual(rows.map((row) => [row.generation, row.state]), [[1, 'CHECK_FAILED']],
        `a stranger's card queued a generation — ${await jobsOf(stack.db, task.taskId)}`);
    } finally {
      await stack.db.$disconnect();
    }
  });

test('the skip is ONE generation: the next landing of the same task is handed its merge check again',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'skip-once');
      const { task } = await failedLanding(stack, w, 'skip-once');
      const cardId = await approvedCard(stack, w, task.taskId);
      await skipDoor(stack, w, task.taskId, { reason: REASON, approvalId: cardId });

      const skippedClaim = await claim(stack, w, 'lease-skip-once');
      assert.deepEqual(skippedClaim[0]!.checks.map((check) => check.name), ['TASK_ACCEPTANCE']);
      // That landing fails on the one check it did run: the task's own acceptance.
      const failed = await report(stack, w, skippedClaim[0]!, {
        state: 'CHECK_FAILED',
        phase: 'CHECK',
        sourceSha: 'a'.repeat(40),
        targetShaBefore: 'c'.repeat(40),
        testedSha: 'd'.repeat(40),
        testedTreeSha: 'e'.repeat(40),
        checks: [{
          name: 'TASK_ACCEPTANCE',
          command: 'exit 0',
          expectedExitCode: 0,
          exitCode: 1,
          timedOut: false,
          durationMs: 12,
          outputTail: 'the task\'s own criterion disagreed on the combined tree',
        }],
      });
      assert.equal(failed.accepted, true);

      // The failure says the merge check did not run on that generation, so a red of the task's own
      // acceptance is not read as the check the owner had just taken off it.
      const items = await itemsOf(stack.db, task.taskId);
      const latest = items[items.length - 1]!;
      assert.equal(latest.kind, 'INTEGRATION_CHECK_FAILED');
      assert.equal(latest.payload.generation, 2);
      assert.deepEqual(latest.payload.skippedCheck, {
        reason: REASON, approvedByUserId: w.ownerId, approvalId: cardId,
      });

      // The rerun that follows is an ORDINARY one — the same door, no card — and it is handed both
      // checks: the skip belonged to generation 2 and to nothing after it.
      const rerun = await stack.openItems.retryIntegration(
        w.ownerId, w.projectId, task.taskId, { reason: 'the acceptance command was repaired' }, w.coordinatorSessionId,
      );
      const rows = await landings(stack.db, task.taskId);
      assert.deepEqual(rows.map((row) => [row.generation, row.skipMergeCheck]), [[1, false], [2, true], [3, false]],
        'the next generation carries no skip');
      assert.equal(rerun.jobId, rows[2]!.id);
      const rerunClaim = await claim(stack, w, 'lease-skip-once-2');
      assert.equal(rerunClaim[0]!.jobId, rows[2]!.id);
      assert.deepEqual(rerunClaim[0]!.checks.map((check) => check.name), ['TASK_ACCEPTANCE', 'MERGE_CHECK'],
        'the check runs again on the generation after the skipped one');
    } finally {
      await stack.db.$disconnect();
    }
  });

test('the account owner needs no card: their own press is the approval, and the row records them',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      // The owner's own door answers an item that is THEIRS, and who a failed landing's item belongs
      // to is the contract's answer, not this file's: in an Automatic project the failure opens a
      // coordinator item and this door refuses by name ("use the project coordinator's
      // integration_retry door") — integration-retry.pg.spec's own refusal case. In a project whose
      // Automatic switch is off there is no hand-over to make, so the item is the owner's from
      // birth, and their press on it is what this case is about. Same for the two refusals below:
      // each is about a failure that is not a check failure, so each needs the same switch off to
      // reach it rather than the ownership refusal in front of it.
      const w = await world(stack, 'skip-owner', false);
      const { task } = await failedLanding(stack, w, 'skip-owner');
      const skipped = await ownerSkip(stack, w, task.taskId, REASON);

      const rows = await landings(stack.db, task.taskId);
      const second = rows[1]!;
      assert.equal(skipped.jobId, second.id);
      assert.equal(second.skipMergeCheck, true);
      assert.equal(second.skipReason, REASON);
      assert.equal(second.skipApprovedByUserId, w.ownerId);
      assert.equal(second.skipApprovalId, null, 'no card was raised, and none is claimed');
      assert.equal(second.retryRequestedByUserId, w.ownerId, 'the owner asked, on the user channel');
      assert.equal(second.retryRequestedBySessionId, null);

      // An error is not a check: the machinery stopping is answered by running the landing again,
      // and the next task's landing is where that is said — its own world, so the queue this case
      // reads holds exactly the one job it is about.
      const other = await world(stack, 'skip-owner-error', false);
      const errored = await failedLanding(stack, other, 'skip-owner-error', {
        state: 'ERROR',
        phase: 'PUSH',
        sourceSha: 'a'.repeat(40),
        targetShaBefore: 'c'.repeat(40),
        errorCode: 'PUSH_REJECTED',
        errorDetail: { reason: 'the remote refused a non-fast-forward push' },
      });
      const refused = await denied(() => ownerSkip(stack, other, errored.task.taskId, REASON));
      assert.equal(refused.status, 409);
      assert.equal(refused.code, 'INTEGRATION_SKIP_CHECK_NOT_A_CHECK_FAILURE');
      assert.match(refused.message, /integration_retry/);
      // And a conflict, which is the branch's: only a branch that changed answers one.
      const conflicted = await world(stack, 'skip-owner-conflict', false);
      const clashed = await failedLanding(stack, conflicted, 'skip-owner-conflict', {
        state: 'CONFLICT',
        phase: 'REBASE',
        sourceSha: 'a'.repeat(40),
        targetShaBefore: 'c'.repeat(40),
        conflicts: ['src/apiserver/src/projects/project-open-item.ts'],
      });
      const conflictRefusal = await denied(() => ownerSkip(stack, conflicted, clashed.task.taskId, REASON));
      assert.equal(conflictRefusal.status, 409);
      assert.equal(conflictRefusal.code, 'INTEGRATION_RETRY_NOT_APPLICABLE');
    } finally {
      await stack.db.$disconnect();
    }
  });
