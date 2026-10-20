import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { Prisma, PrismaClient, RunStatus, RunnerStatus } from '@prisma/client';
import { Client } from 'pg';

import { IntegrationCheckResult, IntegrationJobCommand, IntegrationJobResultRequest } from '@orbit/shared';

import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { QueueService } from '../queue/queue.service';
import { RealtimeService } from '../realtime/realtime.service';
import { MergeReceiptService } from '../sessions/merge-receipt.service';
import { SessionsService } from '../sessions/sessions.service';
import { TasksService } from '../tasks/tasks.service';
import {
  IntegrationJobRelay,
  abandonIntegrationJob,
  receiveIntegrationJobProgress,
  releaseIntegrationJob,
} from '../runner-api/integration-job-relay';
import { ownerItemAlert } from '../push/owner-item-alert';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from './coordinator-pg-test-safety';
import { ProjectOpenItemEscalationService } from './open-item-escalation.service';
import {
  INTEGRATION_JOB_CLAIM,
  INTEGRATION_PROGRESS_V2,
  enqueueForDoneTask,
} from './project-integration-job';
import { configureProjectIntegration, readInFlightJobs, stopInFlightJob } from './project-integration-line';
import { leaseExpiredDedupeKey, openItemOwed } from './project-open-item';
import { ProjectOpenItemService } from './project-open-item.service';
import { ProjectPromotionService, automaticLandingRefusal } from './project-promotion.service';

/**
 * X-E5: the owner's item about a landing attempt whose runner stopped reporting (contract §4.6
 * X-E5, migration 0439).
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/projects/landing-lease-expired.pg.spec.ts
 *
 * THE FACT. A RUNNING integration job whose current claim has been `LEASE_EXPIRED` — §7.2 V6's one
 * definition, the same limit `readInFlightJobs` reports as `timedOut` — for more than fifteen
 * minutes. Both protocols are covered: a v2 claim's limit is the ten-minute lease, a legacy CHECK's
 * is its checks' budgets plus the lease, and a job queueing on its runner's local lock is never
 * timed out. The clock opens ONE item per claim (`LE:<jobId>:<claimGeneration>`), assigned to the
 * owner from birth, and pushes once whatever the number of replicas or ticks.
 *
 * THE ENDINGS. Every edge writes RESOLVED / JOB_MOVED_ON in the transaction that moved the claim —
 * a report, a takeover's first report, a release, a result, J-T12's cancellation, the timeout ends
 * J-T9 / the candidate re-check / M-T13 make, a supersession, and both abandon doors (USER,
 * COORDINATOR). An edge that was missed leaves the item to `reconcile`, which writes the same
 * ending with a `backstop:` note, and `scripts/project-liveness-audit.sql` counts it until it does.
 *
 * It never blocks M-T11, and it writes nothing an agent would run: no turn, session, wake or
 * delivery.
 *
 * Not destructive: every case owns freshly generated ids and reads only its own project.
 */
const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;
const sha = (nibble: string) => nibble.repeat(40);
const MINUTE = 60_000;
const UPSTREAM_TIP = sha('9');

const GREEN_CHECK: IntegrationCheckResult = {
  name: 'MERGE_CHECK',
  command: 'npm test',
  expectedExitCode: 0,
  exitCode: 0,
  timedOut: false,
  durationMs: 1_200,
  outputTail: 'ok\n',
};

type Answer = Omit<IntegrationJobResultRequest, 'claimGeneration' | 'leaseOwner'>;

interface Stack {
  db: PrismaClient;
  prisma: PrismaService;
  openItems: ProjectOpenItemService;
  jobs: IntegrationJobRelay;
  promotions: ProjectPromotionService;
  tasks: TasksService;
  receipts: MergeReceiptService;
}

async function connect(): Promise<Stack> {
  const db = prismaClientFor(URL!);
  const prisma = db as unknown as PrismaService;
  const realtime = new Proxy({}, { get: () => () => undefined }) as unknown as RealtimeService;
  const queue = { notifySessionQueued: () => undefined } as unknown as QueueService;
  const sessions = new SessionsService(prisma, queue, realtime);
  return {
    db,
    prisma,
    openItems: new ProjectOpenItemService(prisma, sessions),
    jobs: new IntegrationJobRelay(prisma, new ProjectOpenItemService(prisma, sessions)),
    promotions: new ProjectPromotionService(prisma),
    tasks: new TasksService(prisma as never, {} as never, {
      publishTaskChanged() {},
      publishForUser() {},
    } as never),
    receipts: new MergeReceiptService(prisma),
  };
}

interface World {
  label: string;
  ownerId: string;
  runnerId: string;
  workspaceId: string;
  projectId: string;
  coordinatorSessionId: string;
  codebaseId: string;
  integrationRef: string;
  upstreamRef: string;
  repoUrl: string;
}

async function world(
  stack: Stack,
  label: string,
  line: 'MAIN' | 'PROJECT_BRANCH',
  over: { repoUrl?: string; mergeCheckTimeoutSeconds?: number } = {},
): Promise<World> {
  const db = stack.db;
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const repoUrl = over.repoUrl ?? `https://git.invalid/${label}-${randomUUID().slice(0, 8)}.git`;
  await db.user.create({
    data: { id: ownerId, email: `${label}-${ownerId}@lease.invalid`, name: label, passwordHash: 'x' },
  });
  await db.runner.create({
    data: {
      id: runnerId, ownerId, name: `${label}-runner`, tokenHash: `hash-${runnerId}`,
      status: RunnerStatus.ONLINE, capabilities: [], capabilitiesReportedAt: new Date(),
      lastHeartbeatAt: new Date(),
    },
  });
  await db.workspace.create({
    data: {
      id: workspaceId, ownerId, runnerId, name: `${label}-workspace`, enabled: true,
      repoUrl, workDir: `/srv/${label}`,
    },
  });
  const coordinatorSessionId = (await db.session.create({
    data: {
      ownerId, creatorId: ownerId, workspaceId, title: `${label} coordinator`,
      prompt: `${label} coordinator`, status: RunStatus.RUNNING, branch: null,
    },
    select: { id: true },
  })).id;
  await db.project.create({
    data: {
      id: projectId, ownerId, title: `${label} project`,
      coordinatorEnabled: true,
      coordinatorWorkspaceId: workspaceId, coordinatorSessionId,
    },
  });
  await db.projectRuntime.upsert({ where: { projectId }, create: { projectId }, update: {} });
  await db.$transaction((tx) => configureProjectIntegration(tx, {
    ownerId,
    projectId,
    settings: {
      line,
      ...(over.mergeCheckTimeoutSeconds !== undefined
        ? { mergeCheckCommand: 'npm test', mergeCheckTimeoutSeconds: over.mergeCheckTimeoutSeconds }
        : {}),
    },
  }));
  const codebase = await db.projectCodebase.findFirstOrThrow({
    where: { projectId, slot: 'primary' },
    select: { id: true, integrationRef: true, upstreamRef: true },
  });
  return {
    label, ownerId, runnerId, workspaceId, projectId, coordinatorSessionId,
    codebaseId: codebase.id, integrationRef: codebase.integrationRef,
    upstreamRef: codebase.upstreamRef, repoUrl,
  };
}

/** A DONE task whose branch is handed to the line, as its DONE would (J-T1a / M-F2). */
async function doneTask(
  stack: Stack,
  w: World,
  label: string,
): Promise<{ taskId: string; sessionId: string; branch: string; title: string }> {
  const title = `${label} ${randomUUID().slice(0, 8)}`;
  const created = await stack.tasks.create(w.ownerId, {
    title,
    projectId: w.projectId,
    completionCriterion: 'EXECUTABLE',
    acceptanceCommand: 'true',
    acceptanceExpectedExitCode: 0,
  } as never);
  const settled = await stack.db.$executeRawUnsafe(
    `UPDATE "task" SET "status" = 'DONE' WHERE "id" = $1::uuid AND "status" IN ('OPEN', 'IN_PROGRESS')`,
    created.id,
  );
  assert.equal(settled, 1, 'the task could not be marked DONE');
  const branch = `orbit/${label}-${randomUUID().slice(0, 8)}`;
  const session = await stack.db.session.create({
    data: {
      ownerId: w.ownerId, creatorId: w.ownerId, taskId: created.id, workspaceId: w.workspaceId,
      assignedRunnerId: w.runnerId, title, prompt: title, branch, isolationStatus: 'worktree',
      baseSha: sha('b'), status: RunStatus.SUCCEEDED, startsTaskWork: true,
      finishedAt: new Date(Date.now() - 60_000), worktreeBranch: branch, worktreeDirty: false,
      changedFiles: [{ path: 'src/the-work.ts' }] as never,
    },
    select: { id: true },
  });
  const queued = await stack.db.$transaction((tx) => enqueueForDoneTask(tx, w.ownerId, created.id));
  assert.ok(queued.enqueued, `the DONE queued nothing: ${JSON.stringify(queued)}`);
  return { taskId: created.id, sessionId: session.id, branch, title };
}

/** A task and a finished work session, written as rows — nothing is handed to the line. */
async function bareWork(
  stack: Stack,
  w: World,
  label: string,
): Promise<{ taskId: string; sessionId: string; branch: string }> {
  const taskId = randomUUID();
  await stack.db.task.create({
    data: {
      id: taskId, ownerId: w.ownerId, projectId: w.projectId, title: label,
      creatorType: 'USER', creatorId: w.ownerId, assigneeId: w.workspaceId, status: 'DONE',
      completionCriterion: 'EXECUTABLE', acceptanceCommand: 'true', acceptanceExpectedExitCode: 0,
    } as never,
  });
  const sessionId = randomUUID();
  const branch = `orbit/${label}`;
  await stack.db.session.create({
    data: {
      id: sessionId, ownerId: w.ownerId, creatorId: w.ownerId, taskId, workspaceId: w.workspaceId,
      assignedRunnerId: w.runnerId, title: label, prompt: label, provider: 'claude',
      status: RunStatus.SUCCEEDED, dispatchOrigin: 'USER', startsTaskWork: true, startedAt: new Date(),
      branch, isolationStatus: 'worktree', baseSha: sha('b'),
      finishedAt: new Date(),
    } as never,
  });
  return { taskId, sessionId, branch };
}

async function beat(
  stack: Stack,
  w: World,
  leaseOwner = `lease-${randomUUID()}`,
  capabilities: string[] = [INTEGRATION_JOB_CLAIM],
) {
  return stack.jobs.dispatch({ runnerId: w.runnerId, leaseOwner, draining: false, capabilities });
}

async function claim(
  stack: Stack,
  w: World,
  capabilities: string[] = [INTEGRATION_JOB_CLAIM, INTEGRATION_PROGRESS_V2],
  leaseOwner?: string,
): Promise<IntegrationJobCommand> {
  const [job] = await beat(stack, w, leaseOwner, capabilities);
  assert.ok(job, 'the heartbeat was handed nothing');
  return job;
}

async function report(
  stack: Stack,
  w: World,
  job: { jobId: string; claimGeneration: string; leaseOwner: string },
  answer: Answer,
) {
  const { answer: taken } = await stack.jobs.applyResult(job.jobId, w.runnerId, {
    claimGeneration: job.claimGeneration,
    leaseOwner: job.leaseOwner,
    ...answer,
  });
  assert.equal(taken.accepted, true, `the result was refused: ${JSON.stringify(taken)}`);
  return taken;
}

async function ageClaim(stack: Stack, jobId: string, milliseconds: number): Promise<void> {
  await stack.db.$executeRaw(Prisma.sql`
    UPDATE "project_integration_job"
       SET "heartbeat_at" = COALESCE("claimed_at", now()) - (${milliseconds}::int * interval '1 millisecond')
     WHERE "id" = ${jobId}::uuid`);
}

interface LeaseItem {
  id: string;
  kind: string;
  state: string;
  assignee: string;
  assigneeReason: string;
  dedupeKey: string;
  title: string;
  payload: Record<string, unknown>;
  taskId: string | null;
  sessionId: string | null;
  integrationJobId: string | null;
  promotionId: string | null;
  escalateAt: Date | null;
  escalatedAt: Date | null;
  remindAt: Date | null;
  waitingSince: Date;
  resolution: string | null;
  resolvedBy: string | null;
  resolvedByUserId: string | null;
  resolvedBySessionId: string | null;
  resolutionNote: string | null;
}

function leaseItems(stack: Stack, projectId: string): Promise<LeaseItem[]> {
  return stack.db.projectOpenItem.findMany({
    where: { projectId, kind: 'LANDING_LEASE_EXPIRED' },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true, kind: true, state: true, assignee: true, assigneeReason: true, dedupeKey: true,
      title: true, payload: true, taskId: true, sessionId: true, integrationJobId: true,
      promotionId: true, escalateAt: true, escalatedAt: true, remindAt: true, waitingSince: true,
      resolution: true, resolvedBy: true, resolvedByUserId: true, resolvedBySessionId: true,
      resolutionNote: true,
    },
  }) as unknown as Promise<LeaseItem[]>;
}

/** Every call made on a push that reaches no device. */
function recordingPush(): { push: object; told: Array<{ method: string; args: unknown[] }> } {
  const told: Array<{ method: string; args: unknown[] }> = [];
  const push = new Proxy({}, {
    get: (_target, method) => (...args: unknown[]) => {
      told.push({ method: String(method), args });
      return Promise.resolve();
    },
  });
  return { push, told };
}

/** The tick as production runs it: reconcile, sweep (with its pushes), then the lease alarm. */
async function tick(
  stack: Stack,
  clock: ProjectOpenItemEscalationService,
  push: object,
): Promise<void> {
  await clock.reconcile();
  const escalated = await clock.sweep();
  for (const item of escalated) {
    await (push as { notifyOwnerItem: (id: string) => Promise<void> }).notifyOwnerItem(item.itemId);
  }
  const opened = await clock.openLeaseExpiredItems();
  for (const item of opened) {
    await (push as { notifyOwnerItem: (id: string) => Promise<void> }).notifyOwnerItem(item.itemId);
  }
}

/** What an agent would have been made to do. All of it, database-wide. */
async function agentWork(db: PrismaClient): Promise<Record<string, number>> {
  const [row] = await db.$queryRaw<Array<Record<string, bigint>>>(Prisma.sql`
    SELECT (SELECT count(*) FROM "conversation_turn") AS "turns",
           (SELECT count(*) FROM "session") AS "sessions",
           (SELECT count(*) FROM "project_coordinator_wake") AS "wakes",
           (SELECT count(*) FROM "project_open_item_delivery") AS "deliveries"`);
  return Object.fromEntries(Object.entries(row!).map(([key, value]) => [key, Number(value)]));
}

/** The audit's own text, split into its statements with the comments taken out. */
function auditStatements(): string[] {
  const file = path.resolve(__dirname, '../../../../scripts/project-liveness-audit.sql');
  return readFileSync(file, 'utf8')
    .replace(/--[^\n]*/g, '')
    .split(';')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

function layoutFree(sql: string): string {
  return sql.replace(/\s+/g, ' ').replace(/\(\s+/g, '(').replace(/\s+\)/g, ')').trim();
}

/** The audit's §4.2 query, narrowed to one project and the lease kind. */
async function audit(stack: Stack, projectId: string): Promise<Array<{ kind: string; openNotOwed: number }>> {
  const rows = await stack.db.$queryRawUnsafe<Array<{
    project_id: string; kind: string; open_not_owed: number;
  }>>(auditStatements()[1]!);
  return rows
    .filter((row) => row.project_id === projectId)
    .map((row) => ({ kind: row.kind, openNotOwed: row.open_not_owed }));
}

/** A RUNNING job row written by hand: the predicate under test is the clock's, not a claim's. */
async function rawRunningJob(
  stack: Stack,
  w: World,
  over: {
    label: string;
    kind?: string;
    claimedAtMsAgo?: number;
    heartbeatMsAgo?: number;
    progressProtocol?: string | null;
    phase?: string | null;
    targetRef?: string;
    taskId?: string | null;
    sessionId?: string | null;
    promotionId?: string | null;
    claimGeneration?: bigint;
  },
): Promise<string> {
  const id = randomUUID();
  // One clock read for both instants: two reads can straddle a millisecond and make the local-lock
  // predicate (`heartbeat_at <= claimed_at`) flicker between "silent since its claim" and not.
  const now = Date.now();
  const claimedAt = new Date(now - (over.claimedAtMsAgo ?? 30 * MINUTE));
  const heartbeatAt = new Date(now - (over.heartbeatMsAgo ?? 30 * MINUTE));
  await stack.db.projectIntegrationJob.create({
    data: {
      id,
      projectId: w.projectId,
      ownerId: w.ownerId,
      codebaseId: w.codebaseId,
      kind: over.kind ?? 'CHECK_PROMOTION',
      generation: 1,
      serialKey: `raw:${over.label}:${id}`,
      idempotencyKey: `raw:${id}`,
      targetRef: over.targetRef ?? w.integrationRef,
      upstreamRef: w.upstreamRef,
      sourceRef: 'refs/heads/orbit/raw',
      state: 'RUNNING',
      runnerId: w.runnerId,
      claimLeaseOwner: `raw-lease-${id}`,
      claimGeneration: over.claimGeneration ?? BigInt(1),
      claimedAt,
      heartbeatAt,
      progressProtocol: over.progressProtocol === undefined ? 'v2' : over.progressProtocol,
      phase: over.phase ?? 'FETCH',
      taskId: over.taskId ?? null,
      sessionId: over.sessionId ?? null,
      promotionId: over.promotionId ?? null,
    },
  });
  return id;
}

/** The heading and body the push service would send for one row, without a device. */
function alertFor(item: LeaseItem) {
  return ownerItemAlert({
    kind: item.kind,
    assignee: item.assignee,
    assigneeReason: item.assigneeReason,
    title: item.title,
    payload: item.payload,
    waitingSince: item.waitingSince,
    escalatedAt: item.escalatedAt,
    projectTitle: 'a project',
    promotion: null,
  });
}

test('X-E5: the lease-expired item, its edges, its backstop and what it does not touch', {
  skip, concurrency: 1, timeout: 900_000,
}, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const stack = await connect();
  t.after(async () => {
    await stack.db.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });

  await t.test('(1) a v2 claim opens one item after fifteen minutes past the lease, once', async () => {
    const w = await world(stack, 'v2', 'PROJECT_BRANCH');
    const { taskId, sessionId, title: taskTitle } = await doneTask(stack, w, 'v2');
    const job = await claim(stack, w);
    assert.equal(job.kind, 'LAND_TASK');
    const { push, told } = recordingPush();
    const clock = new ProjectOpenItemEscalationService(stack.prisma, push as never);

    // Fresh claim: nothing to say.
    await tick(stack, clock, push);
    assert.deepEqual(await leaseItems(stack, w.projectId), []);
    assert.equal(told.length, 0, 'a live claim is pushed to nobody');

    // Fourteen minutes of silence: the lease is expired, but X-E5's grace has not run out.
    await ageClaim(stack, job.jobId, 24 * MINUTE);
    await tick(stack, clock, push);
    assert.deepEqual(await leaseItems(stack, w.projectId), [],
      'an item was opened before the fifteen minutes past LEASE_EXPIRED');

    // Past it, and only then.
    await ageClaim(stack, job.jobId, 26 * MINUTE);
    const before = await agentWork(stack.db);
    await tick(stack, clock, push);
    const after = await agentWork(stack.db);
    const [item] = await leaseItems(stack, w.projectId);
    assert.ok(item, 'the clock opened nothing for a claim that stopped reporting');
    assert.deepEqual(
      [item.kind, item.state, item.assignee, item.assigneeReason],
      ['LANDING_LEASE_EXPIRED', 'OPEN', 'OWNER', 'ESCALATED'],
      'the item is the owner’s from birth',
    );
    assert.equal(item.dedupeKey, leaseExpiredDedupeKey(job.jobId, job.claimGeneration));
    assert.equal(item.title, `No word from the runner: ${taskTitle}`,
      '§4.2’s title names the landing, not the heading the push carries');
    assert.equal(item.taskId, taskId, 'task_id is the live task the job named');
    assert.equal(item.sessionId, sessionId, 'session_id is the job’s source session');
    assert.equal(item.integrationJobId, job.jobId);
    assert.equal(item.promotionId, null);
    assert.ok(item.escalatedAt, 'escalated_at is written at the opening instant');
    assert.equal(item.escalateAt, null, 'the owner’s item has nobody further to escalate to');
    assert.equal(item.remindAt, null, 'and no second reminder');
    assert.deepEqual(
      [item.payload.jobKind, item.payload.claimGeneration, item.payload.progressProtocol],
      ['LAND_TASK', Number(job.claimGeneration), 'v2'],
    );
    assert.ok(typeof item.payload.lastReportAt === 'string', 'the payload names the last report');
    assert.ok(typeof item.payload.runner === 'string' || item.payload.runner === null);
    const landing = await stack.db.projectLanding.findUniqueOrThrow({
      where: { id: (await stack.db.projectIntegrationJob.findUniqueOrThrow({
        where: { id: job.jobId }, select: { landingId: true },
      })).landingId! },
      select: { sessionId: true },
    });
    assert.equal(item.payload.landingSessionId, landing.sessionId,
      'the payload names the landing session the attempt belongs to');

    // The body said the silence, and nothing else: no turn, session, wake or delivery.
    assert.deepEqual(after, before, 'the clock writes nothing an agent would run: '
      + `${JSON.stringify(before)} → ${JSON.stringify(after)}`);
    assert.equal(await stack.db.projectOpenItemDelivery.count({ where: { itemId: item.id } }), 0,
      'the item was delivered to a coordinator conversation it must never reach (X-D7)');
    const alert = alertFor(item);
    assert.ok(alert);
    assert.equal(alert!.title, `Now yours — no report from the runner for ${Math.floor(26 * MINUTE / MINUTE)}m`);
    assert.equal(alert!.body, `${item.title} · a project`,
      'the body names the landing — the heading is the title');
    assert.deepEqual(told.filter((call) => call.method === 'notifyOwnerItem'),
      [{ method: 'notifyOwnerItem', args: [item.id] }],
      'the tick pushed the item it opened, once');

    // A second replica, and every later tick: the partial unique index is the compare-and-set.
    const second = new ProjectOpenItemEscalationService(stack.prisma, push as never);
    await tick(stack, second, push);
    await tick(stack, second, push);
    assert.equal((await leaseItems(stack, w.projectId)).length, 1, 'the same claim opened a second item');
    assert.equal(told.filter((call) => call.method === 'notifyOwnerItem').length, 1,
      'the claim was pushed more than once');
    assert.deepEqual((await leaseItems(stack, w.projectId))[0]!.id, item.id);
  });

  await t.test('(2) a legacy claim opens one too — its CHECK budget is part of the limit', async () => {
    const w = await world(stack, 'legacy', 'PROJECT_BRANCH', { mergeCheckTimeoutSeconds: 1_200 });
    const { taskId, title: taskTitle } = await doneTask(stack, w, 'legacy');
    // A legacy runner: it never declares the v2 protocol, so its claim records NULL.
    const job = await claim(stack, w, [INTEGRATION_JOB_CLAIM]);
    assert.equal(job.kind, 'LAND_TASK');
    await receiveIntegrationJobProgress(stack.prisma, w.runnerId, job.jobId, {
      claimGeneration: job.claimGeneration, leaseOwner: job.leaseOwner, phase: 'CHECK',
    });
    const row = await stack.db.projectIntegrationJob.findUniqueOrThrow({
      where: { id: job.jobId }, select: { progressProtocol: true },
    });
    assert.equal(row.progressProtocol, null, 'the claim is legacy');

    const { push } = recordingPush();
    const clock = new ProjectOpenItemEscalationService(stack.prisma, push as never);
    // The task's acceptance budget (the default 3,600 s) plus the merge check's 1,200 s, plus the
    // ten-minute lease: 5,400 s. Fifteen minutes short of that is inside the budget, not silence.
    await ageClaim(stack, job.jobId, (5_400 - 6 * 60) * 1_000);
    await tick(stack, clock, push);
    assert.deepEqual(await leaseItems(stack, w.projectId), [],
      'a legacy CHECK inside its checks’ budgets is not a lost runner');

    await ageClaim(stack, job.jobId, (5_400 + 16 * 60) * 1_000);
    await tick(stack, clock, push);
    const [item] = await leaseItems(stack, w.projectId);
    assert.ok(item, 'a legacy claim past its budget and X-E5’s grace opens one item');
    assert.equal(item.dedupeKey, leaseExpiredDedupeKey(job.jobId, job.claimGeneration));
    assert.equal(item.title, `No word from the runner: ${taskTitle}`);
    assert.equal(item.payload.progressProtocol, null);
    assert.equal(item.taskId, taskId);
  });

  await t.test('(3) a job queueing on its runner’s local lock is not a lost one', async () => {
    const w = await world(stack, 'local-lock', 'PROJECT_BRANCH');
    // Two RUNNING jobs on one runner, repository and ref: the older holds the in-process lock, and
    // the younger has said nothing since its claim, so it is waiting its turn rather than lost.
    const older = await rawRunningJob(stack, w, {
      label: 'local-lock-older', claimedAtMsAgo: 40 * MINUTE, heartbeatMsAgo: 40 * MINUTE,
      targetRef: w.integrationRef,
    });
    const younger = await rawRunningJob(stack, w, {
      label: 'local-lock-younger', claimedAtMsAgo: 35 * MINUTE, heartbeatMsAgo: 35 * MINUTE,
      targetRef: w.integrationRef,
    });
    const { push } = recordingPush();
    const clock = new ProjectOpenItemEscalationService(stack.prisma, push as never);
    await tick(stack, clock, push);

    const items = await leaseItems(stack, w.projectId);
    assert.deepEqual(items.map((item) => item.integrationJobId), [older],
      'the waiting job was read as silent, and the job holding the lock was the one that was lost');
    assert.equal(items.some((item) => item.integrationJobId === younger), false);
  });

  await t.test('(4) an accepted report ends it — the same claim’s, and a takeover’s first', async () => {
    const w = await world(stack, 'report', 'PROJECT_BRANCH');
    await doneTask(stack, w, 'report');
    const job = await claim(stack, w);
    const { push } = recordingPush();
    const clock = new ProjectOpenItemEscalationService(stack.prisma, push as never);
    await ageClaim(stack, job.jobId, 26 * MINUTE);
    await tick(stack, clock, push);
    const [item] = await leaseItems(stack, w.projectId);
    assert.ok(item);

    await receiveIntegrationJobProgress(stack.prisma, w.runnerId, job.jobId, {
      claimGeneration: job.claimGeneration, leaseOwner: job.leaseOwner, phase: 'FETCH',
    });
    const [sameClaim] = await leaseItems(stack, w.projectId);
    assert.deepEqual(
      [sameClaim!.state, sameClaim!.resolution, sameClaim!.resolvedBy, sameClaim!.resolutionNote],
      ['RESOLVED', 'JOB_MOVED_ON', 'PLATFORM', null],
      'the claim talking again is what the item was asking somebody to look at',
    );

    // A takeover: the NEXT claim takes the silent claim over, and the item stays open until that
    // claim makes its first report — the claim alone is not a report (its row is still silent).
    const wait = await world(stack, 'takeover', 'PROJECT_BRANCH');
    await doneTask(stack, wait, 'takeover');
    const first = await claim(stack, wait);
    const waitClock = new ProjectOpenItemEscalationService(stack.prisma, recordingPush().push as never);
    await ageClaim(stack, first.jobId, 26 * MINUTE);
    await tick(stack, waitClock, recordingPush().push);
    const [beforeTakeover] = await leaseItems(stack, wait.projectId);
    assert.ok(beforeTakeover);

    const second = await claim(stack, wait, [INTEGRATION_JOB_CLAIM, INTEGRATION_PROGRESS_V2], `next-${randomUUID()}`);
    assert.equal(second.jobId, first.jobId, 'the takeover must be of the same job');
    assert.notEqual(second.claimGeneration, first.claimGeneration);
    assert.deepEqual(
      [(await leaseItems(stack, wait.projectId))[0]!.state],
      ['OPEN'],
      'a takeover alone ends nothing: the new claim has not said anything yet',
    );
    await receiveIntegrationJobProgress(stack.prisma, wait.runnerId, second.jobId, {
      claimGeneration: second.claimGeneration, leaseOwner: second.leaseOwner, phase: 'FETCH',
    });
    const [afterReport] = await leaseItems(stack, wait.projectId);
    assert.deepEqual([afterReport!.state, afterReport!.resolution, afterReport!.resolvedBy],
      ['RESOLVED', 'JOB_MOVED_ON', 'PLATFORM'],
      'the new claim’s first report is the edge that ends the old claim’s item');
  });

  await t.test('(5) release, a result, J-T12’s cancellation and the timeout ends all write it', async () => {
    // Release (J-T11).
    const released = await world(stack, 'release', 'PROJECT_BRANCH');
    await doneTask(stack, released, 'release');
    const releaseJob = await claim(stack, released);
    const releaseClock = new ProjectOpenItemEscalationService(stack.prisma, recordingPush().push as never);
    await ageClaim(stack, releaseJob.jobId, 26 * MINUTE);
    await tick(stack, releaseClock, recordingPush().push);
    await releaseIntegrationJob(stack.prisma, {
      jobId: releaseJob.jobId, runnerId: released.runnerId, ownerId: released.ownerId,
      body: { claimGeneration: releaseJob.claimGeneration, leaseOwner: releaseJob.leaseOwner },
    });
    const [releasedItem] = await leaseItems(stack, released.projectId);
    assert.deepEqual([releasedItem!.state, releasedItem!.resolution, releasedItem!.resolvedBy],
      ['RESOLVED', 'JOB_MOVED_ON', 'PLATFORM'], 'release answers the item in its own transaction');

    // A runner's result.
    const resulted = await world(stack, 'result', 'PROJECT_BRANCH');
    await doneTask(stack, resulted, 'result');
    const resultJob = await claim(stack, resulted);
    const resultClock = new ProjectOpenItemEscalationService(stack.prisma, recordingPush().push as never);
    await ageClaim(stack, resultJob.jobId, 26 * MINUTE);
    await tick(stack, resultClock, recordingPush().push);
    await report(stack, resulted, resultJob, { state: 'ERROR', phase: 'FETCH', errorCode: 'FETCH_FAILED' });
    const [resultItem] = await leaseItems(stack, resulted.projectId);
    assert.deepEqual([resultItem!.state, resultItem!.resolution, resultItem!.resolvedBy],
      ['RESOLVED', 'JOB_MOVED_ON', 'PLATFORM'], 'a terminal result ends the item in its transaction');

    // J-T12: a stop was asked while the claim was live, the runner reports CANCELLED after it went
    // silent, and that result is the edge.
    const cancelled = await world(stack, 'cancelled', 'PROJECT_BRANCH');
    await doneTask(stack, cancelled, 'cancelled');
    const cancelJob = await claim(stack, cancelled);
    await stack.db.projectIntegrationJob.update({
      where: { id: cancelJob.jobId }, data: { cancelRequestedAt: new Date() },
    });
    const cancelClock = new ProjectOpenItemEscalationService(stack.prisma, recordingPush().push as never);
    await ageClaim(stack, cancelJob.jobId, 26 * MINUTE);
    await tick(stack, cancelClock, recordingPush().push);
    await report(stack, cancelled, cancelJob, { state: 'CANCELLED', phase: 'FETCH' });
    const [cancelItem] = await leaseItems(stack, cancelled.projectId);
    assert.deepEqual([cancelItem!.state, cancelItem!.resolution, cancelItem!.resolvedBy],
      ['RESOLVED', 'JOB_MOVED_ON', 'PLATFORM'], 'J-T12’s cancellation is the claim moving on');

    // The timeout ends: endTimedOutLanding is the one compare-and-set every door that ends a
    // timed-out job comes through (J-T9, the candidate re-check, M-T13, J-T8's stop). One caller here.
    const timedOut = await world(stack, 'timed-out', 'PROJECT_BRANCH');
    await doneTask(stack, timedOut, 'timed-out');
    const timeoutJob = await claim(stack, timedOut);
    const timeoutClock = new ProjectOpenItemEscalationService(stack.prisma, recordingPush().push as never);
    await ageClaim(stack, timeoutJob.jobId, 26 * MINUTE);
    await tick(stack, timeoutClock, recordingPush().push);
    const stopped = await stack.db.$transaction((tx) => stopInFlightJob(tx, {
      projectId: timedOut.projectId, jobId: timeoutJob.jobId, now: new Date(),
    }));
    assert.equal(stopped.outcome, 'ENDED');
    const [timeoutItem] = await leaseItems(stack, timedOut.projectId);
    assert.deepEqual([timeoutItem!.state, timeoutItem!.resolution, timeoutItem!.resolvedBy],
      ['RESOLVED', 'JOB_MOVED_ON', 'PLATFORM'], 'the J-T9 read writes the ending too');
  });

  await t.test('(6) both abandon doors write it — the owner’s as USER, the coordinator’s as COORDINATOR', async () => {
    const ownerWorld = await world(stack, 'abandon-owner', 'PROJECT_BRANCH');
    await doneTask(stack, ownerWorld, 'abandon-owner');
    const ownerJob = await claim(stack, ownerWorld);
    const ownerClock = new ProjectOpenItemEscalationService(stack.prisma, recordingPush().push as never);
    await ageClaim(stack, ownerJob.jobId, 26 * MINUTE);
    await tick(stack, ownerClock, recordingPush().push);
    const abandoned = await abandonIntegrationJob(stack.prisma, {
      jobId: ownerJob.jobId, projectId: ownerWorld.projectId, ownerId: ownerWorld.ownerId, by: 'owner',
    });
    assert.equal(abandoned.abandoned.state, 'ERROR');
    const [ownerItem] = await leaseItems(stack, ownerWorld.projectId);
    assert.deepEqual([ownerItem!.state, ownerItem!.resolution, ownerItem!.resolvedBy],
      ['RESOLVED', 'JOB_MOVED_ON', 'USER'], 'the owner’s press is recorded as the user’s');
    assert.equal(ownerItem!.resolvedByUserId, ownerWorld.ownerId,
      'and the person who pressed is on the row');
    assert.equal(ownerItem!.resolvedBySessionId, null);

    const coordinatorWorld = await world(stack, 'abandon-coordinator', 'PROJECT_BRANCH');
    await doneTask(stack, coordinatorWorld, 'abandon-coordinator');
    const coordinatorJob = await claim(stack, coordinatorWorld);
    const coordinatorClock = new ProjectOpenItemEscalationService(stack.prisma, recordingPush().push as never);
    await ageClaim(stack, coordinatorJob.jobId, 26 * MINUTE);
    await tick(stack, coordinatorClock, recordingPush().push);
    await abandonIntegrationJob(stack.prisma, {
      jobId: coordinatorJob.jobId, projectId: coordinatorWorld.projectId,
      ownerId: coordinatorWorld.ownerId, by: 'coordinator',
      sessionId: coordinatorWorld.coordinatorSessionId, reason: 'the runner was fenced',
    });
    const [coordinatorItem] = await leaseItems(stack, coordinatorWorld.projectId);
    assert.deepEqual([coordinatorItem!.state, coordinatorItem!.resolution, coordinatorItem!.resolvedBy],
      ['RESOLVED', 'JOB_MOVED_ON', 'COORDINATOR'], 'the coordinator’s integration_abandon is its own');
    assert.equal(coordinatorItem!.resolvedBySessionId, coordinatorWorld.coordinatorSessionId,
      'and the conversation that pressed is on the row');
    assert.equal(coordinatorItem!.resolvedByUserId, null);
  });

  await t.test('(7) a supersession and an M-T13 retirement end it in their own transactions', async () => {
    // M-T6: a new landing on the project branch retires the candidate standing on it, and the
    // retired candidate's check job — silent, with an item — is ended through endTimedOutLanding.
    const w = await world(stack, 'supersede', 'PROJECT_BRANCH');
    const { taskId } = await doneTask(stack, w, 'supersede-landing');
    const landing = await claim(stack, w);
    await report(stack, w, landing, {
      state: 'LANDED', phase: 'VERIFY', sourceSha: sha('a'), targetShaBefore: UPSTREAM_TIP,
      testedSha: sha('4'), testedTreeSha: sha('5'), landedSha: sha('6'), landedTreeSha: sha('5'),
      aheadOfUpstream: 1, filesChanged: 1, checks: [GREEN_CHECK],
    });
    const silentCheck = await rawRunningJob(stack, w, {
      label: 'supersede-check', kind: 'CHECK_PROMOTION', taskId, claimedAtMsAgo: 30 * MINUTE,
      heartbeatMsAgo: 30 * MINUTE, targetRef: w.upstreamRef,
    });
    const standingPromotion = randomUUID();
    await stack.db.projectPromotion.create({
      data: {
        id: standingPromotion, projectId: w.projectId, ownerId: w.ownerId, codebaseId: w.codebaseId,
        sourceKind: 'PROJECT_BRANCH', sourceRef: w.integrationRef, sourceSha: sha('a'),
        upstreamRef: w.upstreamRef, state: 'CHECKING', checkJobId: silentCheck,
      } as never,
    });
    const supersedeClock = new ProjectOpenItemEscalationService(stack.prisma, recordingPush().push as never);
    await tick(stack, supersedeClock, recordingPush().push);
    const [supersedeItem] = await leaseItems(stack, w.projectId);
    assert.ok(supersedeItem, 'the silent check opened its item');
    const considered = await stack.promotions.considerCandidate(w.projectId);
    assert.ok(considered, 'the new landing is owed a candidate');
    const [closedBySupersede] = await leaseItems(stack, w.projectId);
    assert.deepEqual(
      [closedBySupersede!.state, closedBySupersede!.resolution, closedBySupersede!.resolvedBy],
      ['RESOLVED', 'JOB_MOVED_ON', 'PLATFORM'],
      'M-T6 supersession ends the retired check’s item in its own transaction',
    );
    assert.equal((await stack.db.projectPromotion.findUniqueOrThrow({
      where: { id: standingPromotion }, select: { state: true },
    })).state, 'SUPERSEDED');

    // M-T13: a merge receipt for the task's own branch retires the TASK_BRANCH candidate offering it.
    const retire = await world(stack, 'retire', 'MAIN');
    const work = await bareWork(stack, retire, 'retire');
    const retireJob = await rawRunningJob(stack, retire, {
      label: 'retire-check', kind: 'CHECK_PROMOTION', taskId: work.taskId,
      claimedAtMsAgo: 30 * MINUTE, heartbeatMsAgo: 30 * MINUTE, targetRef: retire.upstreamRef,
    });
    const retirePromotion = randomUUID();
    await stack.db.projectPromotion.create({
      data: {
        id: retirePromotion, projectId: retire.projectId, ownerId: retire.ownerId,
        codebaseId: retire.codebaseId, sourceKind: 'TASK_BRANCH', taskId: work.taskId,
        sessionId: work.sessionId, sourceRef: `refs/heads/${work.branch}`, sourceSha: sha('c'),
        upstreamRef: retire.upstreamRef, state: 'CHECKING', checkJobId: retireJob,
      } as never,
    });
    const retireClock = new ProjectOpenItemEscalationService(stack.prisma, recordingPush().push as never);
    await tick(stack, retireClock, recordingPush().push);
    assert.ok((await leaseItems(stack, retire.projectId)).length === 1);
    await stack.receipts.record(retire.ownerId, work.sessionId, {
      result: 'MERGED',
      sourceSha: sha('d'),
      targetBranch: 'main',
      targetShaBefore: sha('e'),
      targetShaAfter: sha('f'),
    }, 'RUNNER');
    const [retiredItem] = await leaseItems(stack, retire.projectId);
    assert.deepEqual(
      [retiredItem!.state, retiredItem!.resolution, retiredItem!.resolvedBy],
      ['RESOLVED', 'JOB_MOVED_ON', 'PLATFORM'],
      'M-T13’s retirement ends it in the transaction that recorded the receipt',
    );
    assert.equal((await stack.db.projectPromotion.findUniqueOrThrow({
      where: { id: retirePromotion }, select: { state: true },
    })).state, 'SUPERSEDED');
  });

  await t.test('(8) the backstop writes the ending the missed edge would have, and the audit agrees', async () => {
    const w = await world(stack, 'backstop', 'PROJECT_BRANCH');
    await doneTask(stack, w, 'backstop');
    const job = await claim(stack, w);
    const { push } = recordingPush();
    const clock = new ProjectOpenItemEscalationService(stack.prisma, push as never);
    await ageClaim(stack, job.jobId, 26 * MINUTE);
    await tick(stack, clock, push);
    const [item] = await leaseItems(stack, w.projectId);
    assert.ok(item);

    // The audit spells the predicate the TypeScript does, and the item is still owed.
    const [, owedAudit] = auditStatements();
    assert.ok(layoutFree(owedAudit!).includes(layoutFree(openItemOwed('item').sql)),
      'scripts/project-liveness-audit.sql spells openItemOwed as the TypeScript does');
    assert.deepEqual(await audit(stack, w.projectId), []);

    // A missed edge: the job moves on without any of the doors that would have closed the item.
    await stack.db.$executeRaw(Prisma.sql`
      UPDATE "project_integration_job"
         SET "state" = 'ERROR', "error_code" = 'RUNNER_LOST', "finished_at" = now()
       WHERE "id" = ${job.jobId}::uuid`);
    assert.deepEqual(await audit(stack, w.projectId),
      [{ kind: 'LANDING_LEASE_EXPIRED', openNotOwed: 1 }],
      'the audit counts the item nobody owes any more');

    const closed = (await clock.reconcile()).filter((row) => row.projectId === w.projectId);
    assert.deepEqual(closed.map((row) => row.itemId), [item.id]);
    const [after] = await leaseItems(stack, w.projectId);
    assert.deepEqual([after!.state, after!.resolution, after!.resolvedBy],
      ['RESOLVED', 'JOB_MOVED_ON', 'PLATFORM'], 'the backstop writes the same ending as the edges');
    assert.equal(after!.resolutionNote,
      `backstop: job ${job.jobId}@ERROR is no longer the claim that stopped reporting; `
      + 'no edge closed this item when that happened');
    assert.deepEqual(await audit(stack, w.projectId), [], 'and the audit finds nothing left');

    // The edge and the backstop end the same fact the same way.
    const twinWorld = await world(stack, 'backstop-twin', 'PROJECT_BRANCH');
    await doneTask(stack, twinWorld, 'backstop-twin');
    const twinJob = await claim(stack, twinWorld);
    const twinClock = new ProjectOpenItemEscalationService(stack.prisma, recordingPush().push as never);
    await ageClaim(stack, twinJob.jobId, 26 * MINUTE);
    await tick(stack, twinClock, recordingPush().push);
    await report(stack, twinWorld, twinJob, { state: 'ERROR', phase: 'FETCH', errorCode: 'RUNNER_LOST' });
    const [edge] = await leaseItems(stack, twinWorld.projectId);
    assert.deepEqual([edge!.state, edge!.resolution, edge!.resolvedBy],
      [after!.state, after!.resolution, after!.resolvedBy],
      'the edge and the backstop wrote different endings for the same fact');
    assert.equal(edge!.resolutionNote, null, 'the edge writes no backstop note');
  });

  await t.test('(9) it does not hold M-T11 back, even with the candidate’s id on it', async () => {
    const w = await world(stack, 'm-t11', 'PROJECT_BRANCH');
    const confirmed = randomUUID();
    await stack.db.projectPromotion.create({
      data: {
        id: confirmed, projectId: w.projectId, ownerId: w.ownerId, codebaseId: w.codebaseId,
        sourceKind: 'PROJECT_BRANCH', sourceRef: w.integrationRef, sourceSha: sha('a'),
        upstreamRef: w.upstreamRef, state: 'CONFIRMED', confirmedAt: new Date(),
        confirmedAutomatically: true,
        checks: [GREEN_CHECK] as never,
        upstreamShaChecked: sha('f'), mergeTreeSha: sha('3'),
      } as never,
    });
    // The lease item NAMES the candidate — the generation that stopped reporting was its check —
    // and M-T11 still does not count it: it counts the INTEGRATION_* items owed about the merge.
    const job = await rawRunningJob(stack, w, {
      label: 'm-t11-check', claimedAtMsAgo: 30 * MINUTE, heartbeatMsAgo: 30 * MINUTE,
      targetRef: w.upstreamRef, promotionId: confirmed,
    });
    const clock = new ProjectOpenItemEscalationService(stack.prisma, recordingPush().push as never);
    await tick(stack, clock, recordingPush().push);
    const [item] = await leaseItems(stack, w.projectId);
    assert.ok(item, 'the item did not open');
    assert.equal(item.integrationJobId, job);
    assert.equal(item.promotionId, confirmed, 'the item names the candidate whose check stopped');
    assert.equal(await stack.db.$transaction((tx) => automaticLandingRefusal(tx, confirmed, true)), null,
      'a lease item is not an exception on the merge into main');

    // The control: an owed integration failure about the same candidate DOES hold it back.
    await stack.db.projectOpenItem.create({
      data: {
        projectId: w.projectId, ownerId: w.ownerId, kind: 'INTEGRATION_CONFLICT', state: 'OPEN',
        assignee: 'COORDINATOR', assigneeReason: 'DEFAULT', promotionId: confirmed,
        dedupeKey: `IC:${randomUUID()}`, title: 'Merge conflict', payload: {},
        waitingSince: new Date(), assignedAt: new Date(),
        escalateAt: new Date(Date.now() + 3_600_000),
      } as never,
    });
    assert.equal(await stack.db.$transaction((tx) => automaticLandingRefusal(tx, confirmed, true)),
      'an exception on this project\'s merge into main is still open',
      'the reader this item must not disturb still counts its own kind');
  });

  await t.test('(10) the row reads as the card draws it, and the door closes it by hand', async () => {
    const w = await world(stack, 'read', 'PROJECT_BRANCH');
    await doneTask(stack, w, 'read');
    const job = await claim(stack, w);
    // Where the runner had got to when it stopped reporting: the card's "Step" row is read off the
    // phase, the claim and the round. Its M comes from jobKind (§7.2 V6), never from the check's
    // count, which the row only passes through.
    const CHECK = { name: 'MERGE_CHECK', index: 2, count: 3, budgetSeconds: 600, startedAt: new Date() };
    await stack.db.projectIntegrationJob.update({
      where: { id: job.jobId },
      data: { phase: 'REBASE', round: 2, currentCheck: CHECK },
    });
    const clock = new ProjectOpenItemEscalationService(stack.prisma, recordingPush().push as never);
    await ageClaim(stack, job.jobId, 26 * MINUTE);
    await tick(stack, clock, recordingPush().push);
    const [item] = await leaseItems(stack, w.projectId);
    const stored = await stack.db.projectIntegrationJob.findUniqueOrThrow({ where: { id: job.jobId } });

    const listed = await stack.openItems.list(w.ownerId, w.projectId);
    const row = listed.needsYou.find((candidate) => candidate.itemId === item!.id);
    assert.ok(row, 'the owner’s item is not under needsYou');
    // Every claimed job belongs to a landing subject (LS1), so the landing door is offered too —
    // appended after the lead, never ahead of it.
    assert.deepEqual(row!.actions, ['ABANDON', 'OPEN_LANDING']);
    assert.equal(row!.primaryAction, 'ABANDON');
    assert.equal(row!.requiredAction,
      'The runner stopped reporting; abandon this landing, or wait for the runner to come back.');
    assert.match(row!.detailLine, /No report from/);
    assert.equal(row!.delivery.state, 'NOT_REQUIRED', 'nothing is ever delivered to a conversation for it');
    assert.equal(row!.chat.stage, 'WITH_OWNER', 'chat is still offered, as on every owner row');

    // The three rows the card draws (§4.6, board v4 06 c), pinned field by field: the landing's
    // generation, the runner with its last report and the lease's expiry, and the step with the
    // claim and the round — all of them the payload's own facts, none derived on the client.
    assert.deepEqual(row!.lease, {
      lastReportAt: item!.payload.lastReportAt,
      leaseExpiredAt: item!.payload.leaseExpiredAt,
      jobKind: 'LAND_TASK',
      generation: stored.generation,
      phase: 'REBASE',
      step: null,
      claimGeneration: Number(stored.claimGeneration),
      round: 2,
      checkCount: 3,
      runner: item!.payload.runner,
      progressProtocol: stored.progressProtocol,
      pushReported: false,
    });
    assert.equal(row!.facts?.task?.title, stored.taskId ? (await stack.db.task.findUniqueOrThrow({
      where: { id: stored.taskId! }, select: { title: true },
    })).title : null, 'the card names the task whose landing stopped');

    // The owner closes it by hand (HANDLED), and return-to-coordinator refuses it: it is never
    // delivered to a conversation (X-D7).
    await assert.rejects(
      stack.openItems.returnToCoordinator(w.ownerId, w.projectId, item!.id),
      (error: { getStatus?: () => number; getResponse?: () => { code?: string } }) => {
        assert.equal(error.getStatus?.(), 409);
        assert.equal(error.getResponse?.().code, 'OPEN_ITEM_NOT_RETURNABLE');
        return true;
      },
    );
    await stack.openItems.resolveOpenItem(w.ownerId, w.projectId, item!.id,
      { note: 'the runner is gone and the work was landed by hand' }, { kind: 'OWNER' });
    const [handled] = await leaseItems(stack, w.projectId);
    assert.deepEqual([handled!.state, handled!.resolution, handled!.resolvedBy],
      ['RESOLVED', 'HANDLED', 'USER']);
  });

  await t.test('(11) the row a job the landing session opened names its session', async () => {
    const w = await world(stack, 'landing', 'PROJECT_BRANCH');
    await doneTask(stack, w, 'landing');
    const job = await claim(stack, w);
    const landing = await stack.db.projectLanding.findFirstOrThrow({
      where: { projectId: w.projectId, settledAt: null },
      select: { id: true, sessionId: true },
    });
    await stack.db.projectIntegrationJob.update({
      where: { id: job.jobId }, data: { landingId: landing.id },
    });
    const clock = new ProjectOpenItemEscalationService(stack.prisma, recordingPush().push as never);
    await ageClaim(stack, job.jobId, 26 * MINUTE);
    await tick(stack, clock, recordingPush().push);
    const [item] = await leaseItems(stack, w.projectId);
    assert.equal(item!.payload.landingSessionId, landing.sessionId,
      'the payload names the landing session the attempt belongs to');
    const listed = await stack.openItems.list(w.ownerId, w.projectId);
    const row = listed.needsYou.find((candidate) => candidate.itemId === item!.id);
    assert.deepEqual(row!.actions, ['ABANDON', 'OPEN_LANDING'],
      'OPEN_LANDING is appended when there is a landing to open');
    assert.equal(row!.integrationJobId, job.jobId,
      'the row names the job ABANDON’s route needs');
  });

  await t.test('(12) a LAND_PROMOTION opens, and only the abandon door ends it', async () => {
    // The kind with no retry door at all (§4.7): a timed-out promotion landing is ended by Abandon
    // and by nothing else, so the card is the only way back to the owner.
    const w = await world(stack, 'land-promotion', 'PROJECT_BRANCH');
    const promotion = randomUUID();
    await stack.db.projectPromotion.create({
      data: {
        id: promotion, projectId: w.projectId, ownerId: w.ownerId, codebaseId: w.codebaseId,
        sourceKind: 'PROJECT_BRANCH', sourceRef: w.integrationRef, sourceSha: sha('a'),
        upstreamRef: w.upstreamRef, state: 'CONFIRMED', confirmedAt: new Date(),
        confirmedByUserId: w.ownerId,
      } as never,
    });
    const job = await rawRunningJob(stack, w, {
      label: 'land-promotion', kind: 'LAND_PROMOTION', phase: 'MERGE',
      claimedAtMsAgo: 30 * MINUTE, heartbeatMsAgo: 30 * MINUTE,
      targetRef: w.upstreamRef, promotionId: promotion,
    });
    const { push } = recordingPush();
    const clock = new ProjectOpenItemEscalationService(stack.prisma, push as never);
    await tick(stack, clock, push);
    const [item] = await leaseItems(stack, w.projectId);
    assert.ok(item, 'a silent LAND_PROMOTION opened no item');
    assert.equal(item!.title, 'No word from the runner: Merge to main',
      'a promotion job names what it was merging, not a task');
    assert.equal(item!.promotionId, promotion, 'the item names the candidate whose landing stopped');
    assert.equal(item!.integrationJobId, job);

    const abandoned = await abandonIntegrationJob(stack.prisma, {
      jobId: job, projectId: w.projectId, ownerId: w.ownerId, by: 'owner',
    });
    assert.equal(abandoned.abandoned.state, 'ERROR');
    assert.equal(abandoned.abandoned.errorCode, 'RUNNER_LOST',
      'a v2 claim that never recorded PUSH can prove nothing was pushed');
    const [after] = await leaseItems(stack, w.projectId);
    assert.deepEqual([after!.state, after!.resolution, after!.resolvedBy],
      ['RESOLVED', 'JOB_MOVED_ON', 'USER']);
    assert.equal((await stack.db.projectPromotion.findUniqueOrThrow({
      where: { id: promotion }, select: { state: true },
    })).state, 'BLOCKED', 'the abandoned candidate goes back to its owner as BLOCKED');
  });

  await t.test('(13) the J-T9 retry door ends a timed-out claim through endTimedOutLanding', async () => {
    const w = await world(stack, 'j-t9', 'PROJECT_BRANCH');
    const { taskId } = await doneTask(stack, w, 'j-t9');
    const job = await claim(stack, w);
    const clock = new ProjectOpenItemEscalationService(stack.prisma, recordingPush().push as never);
    await ageClaim(stack, job.jobId, 26 * MINUTE);
    await tick(stack, clock, recordingPush().push);
    assert.equal((await leaseItems(stack, w.projectId)).length, 1);

    const retried = await stack.openItems.retryIntegration(
      w.ownerId, w.projectId, taskId, { reason: 'the runner is gone; run it again' },
      w.coordinatorSessionId,
    );
    assert.ok(retried, 'the retry door refused a timed-out landing');
    const [item] = await leaseItems(stack, w.projectId);
    assert.deepEqual([item!.state, item!.resolution, item!.resolvedBy],
      ['RESOLVED', 'JOB_MOVED_ON', 'PLATFORM'],
      'the J-T9 end answers the item in the retry door’s transaction');
    const row = await stack.db.projectIntegrationJob.findUniqueOrThrow({
      where: { id: job.jobId }, select: { state: true, errorCode: true },
    });
    assert.deepEqual([row.state, row.errorCode], ['ERROR', 'RUNNER_LOST'],
      'the end the door wrote is the one the item’s edge rode on');
  });

  await t.test('(14) a tick after the owner closed the card does not reopen it', async () => {
    const w = await world(stack, 'handled', 'PROJECT_BRANCH');
    await doneTask(stack, w, 'handled');
    const job = await claim(stack, w);
    const { push, told } = recordingPush();
    const clock = new ProjectOpenItemEscalationService(stack.prisma, push as never);
    await ageClaim(stack, job.jobId, 26 * MINUTE);
    await tick(stack, clock, push);
    const [item] = await leaseItems(stack, w.projectId);
    assert.ok(item);
    await stack.openItems.resolveOpenItem(
      w.ownerId, w.projectId, item!.id,
      { note: 'the runner is gone and I dealt with it by hand' }, { kind: 'OWNER' },
    );
    const pushed = told.length;

    // The claim is still silent and still RUNNING — the fact X-E5 reads — but the owner has already
    // answered the card, and one claim is one card.
    await tick(stack, clock, push);
    const items = await leaseItems(stack, w.projectId);
    assert.equal(items.length, 1, 'the same claim was opened a second time after the owner closed it');
    assert.deepEqual([items[0]!.state, items[0]!.resolution, items[0]!.resolvedBy],
      ['RESOLVED', 'HANDLED', 'USER'], 'and its own ending is untouched');
    assert.equal(told.length, pushed, 'the owner was told about it twice');
  });

  await t.test('(15) two replicas ticking at the same moment open one item and push once', async () => {
    const w = await world(stack, 'concurrent', 'PROJECT_BRANCH');
    await doneTask(stack, w, 'concurrent');
    const job = await claim(stack, w);
    await ageClaim(stack, job.jobId, 26 * MINUTE);
    const { push, told } = recordingPush();
    const one = new ProjectOpenItemEscalationService(stack.prisma, push as never);
    const otherDb = prismaClientFor(URL!);
    try {
      const two = new ProjectOpenItemEscalationService(otherDb as unknown as PrismaService, push as never);
      // Both statements run at once: the partial unique index is the arbiter, and the loser's
      // ON CONFLICT DO NOTHING returns no row, so no push follows from it.
      const [a, b] = await Promise.all([one.openLeaseExpiredItems(), two.openLeaseExpiredItems()]);
      for (const item of [...a, ...b]) {
        await (push as { notifyOwnerItem: (id: string) => Promise<void> }).notifyOwnerItem(item.itemId);
      }
      assert.equal([...a, ...b].filter((row) => row.projectId === w.projectId).length, 1,
        'two replicas at one tick both inserted an item');
    } finally {
      await otherDb.$disconnect().catch(() => undefined);
    }
    assert.equal((await leaseItems(stack, w.projectId)).length, 1);
    assert.equal(told.filter((call) => call.method === 'notifyOwnerItem').length, 1,
      'and the claim was pushed once');
  });

  await t.test('(16) a J-T1e “judged too early” answer moves the claim, and closes the item', async () => {
    // The answer is not terminal: the job goes back to the queue (or ends CANCELLED when a stop was
    // asked), which clears the claim — so §4.2's ending is written in that same transaction too.
    for (const stopped of [false, true]) {
      const label = stopped ? 'too-early-stopped' : 'too-early';
      const w = await world(stack, label, 'PROJECT_BRANCH');
      const { sessionId } = await doneTask(stack, w, label);
      const job = await claim(stack, w);
      // The work finished AFTER the claim: an ALREADY_LANDED about this branch cannot have seen it.
      await stack.db.session.update({ where: { id: sessionId }, data: { finishedAt: new Date() } });
      if (stopped) {
        await stack.db.projectIntegrationJob.update({
          where: { id: job.jobId }, data: { cancelRequestedAt: new Date() },
        });
      }
      const clock = new ProjectOpenItemEscalationService(stack.prisma, recordingPush().push as never);
      await ageClaim(stack, job.jobId, 26 * MINUTE);
      await tick(stack, clock, recordingPush().push);
      assert.equal((await leaseItems(stack, w.projectId)).length, 1, `${label}: no item opened`);

      await report(stack, w, job, {
        state: 'ALREADY_LANDED', phase: 'VERIFY', sourceSha: sha('a'),
      });
      const [item] = await leaseItems(stack, w.projectId);
      assert.deepEqual(
        [item!.state, item!.resolution, item!.resolvedBy],
        ['RESOLVED', 'JOB_MOVED_ON', 'PLATFORM'],
        `${label}: the too-early answer did not close the item`,
      );
      assert.equal(
        (await stack.db.projectIntegrationJob.findUniqueOrThrow({
          where: { id: job.jobId }, select: { state: true },
        })).state,
        stopped ? 'CANCELLED' : 'QUEUED',
        `${label}: the claim did not move the way the case set up`,
      );
    }
  });
});

test('the clock’s SQL predicate agrees with readInFlightJobs.timedOut', {
  skip, concurrency: 1, timeout: 300_000,
}, async (t) => {
  const stack = await connect();
  t.after(async () => {
    await stack.db.$disconnect().catch(() => undefined);
  });

  // One world per limit shape: a v2 claim, a legacy git step, and a legacy CHECK whose budget is
  // what makes it silent. For each, a job aged just inside its limit plus X-E5's grace is not
  // opened, and one aged just past it is — the two definitions of §7.2 V6 agree on every one.
  const cases: Array<{ label: string; protocol: string | null; phase: string; msAgo: number; opened: boolean }> = [
    { label: 'v2-inside', protocol: 'v2', phase: 'FETCH', msAgo: (600 + 900 - 60) * 1_000, opened: false },
    { label: 'v2-outside', protocol: 'v2', phase: 'FETCH', msAgo: (600 + 900 + 60) * 1_000, opened: true },
    { label: 'legacy-git-inside', protocol: null, phase: 'FETCH', msAgo: (600 + 900 - 60) * 1_000, opened: false },
    { label: 'legacy-git-outside', protocol: null, phase: 'FETCH', msAgo: (600 + 900 + 60) * 1_000, opened: true },
  ];
  for (const one of cases) {
    await t.test(one.label, async () => {
      const w = await world(stack, `agree-${one.label}`, 'PROJECT_BRANCH');
      const job = await rawRunningJob(stack, w, {
        label: one.label, progressProtocol: one.protocol, phase: one.phase,
        claimedAtMsAgo: one.msAgo, heartbeatMsAgo: one.msAgo, targetRef: w.integrationRef,
      });
      const [view] = await readInFlightJobs(stack.prisma, w.projectId, job);
      assert.equal(view!.timedOut, true, `${one.label}: the lease is expired by V6`);
      const clock = new ProjectOpenItemEscalationService(stack.prisma, recordingPush().push as never);
      await clock.openLeaseExpiredItems();
      const items = await leaseItems(stack, w.projectId);
      assert.equal(items.length, one.opened ? 1 : 0,
        `${one.label}: the clock and inFlightJobs disagree about the grace`);
    });
  }

  await t.test('legacy-check-budget', async () => {
    const w = await world(stack, 'agree-legacy-check', 'PROJECT_BRANCH');
    const { taskId, sessionId } = await bareWork(stack, w, 'agree-legacy-check');
    // A legacy CHECK claim: the task's acceptance budget (default 3,600 s) plus the lease — 4,200 s.
    const job = await rawRunningJob(stack, w, {
      label: 'legacy-check', kind: 'LAND_TASK', progressProtocol: null, phase: 'CHECK',
      claimedAtMsAgo: (4_200 + 900 - 60) * 1_000, heartbeatMsAgo: (4_200 + 900 - 60) * 1_000,
      taskId, sessionId,
    });
    const [view] = await readInFlightJobs(stack.prisma, w.projectId, job);
    assert.equal(view!.timedOut, true);
    const clock = new ProjectOpenItemEscalationService(stack.prisma, recordingPush().push as never);
    await clock.openLeaseExpiredItems();
    assert.equal((await leaseItems(stack, w.projectId)).length, 0,
      'inside the legacy check budget plus the grace, nothing is opened');
    await ageClaim(stack, job, (4_200 + 900 + 60) * 1_000);
    await clock.openLeaseExpiredItems();
    assert.equal((await leaseItems(stack, w.projectId)).length, 1);
  });
});
