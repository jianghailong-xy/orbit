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
 * J-T9 / the candidate re-check / M-T13 make, a supersession, both abandon doors (USER,
 * COORDINATOR), and J-T1e's "too early" answer of a landing and of a candidate's check. An edge that
 * was missed leaves the item to `reconcile`, which writes the same ending with a `backstop:` note,
 * and `scripts/project-liveness-audit.sql` counts it until it does.
 *
 * THE RACES, each forced from a second connection rather than timed. The tick is one statement that
 * takes every row it writes about SKIP LOCKED, so a claim whose job, task, project or candidate
 * another transaction holds is left to the next tick and the tick returns at once; two ticks whose
 * inserts meet on one claim open one item; a tick and J-T8's `task_reopen` ending the same claim,
 * and a tick and a project delete reaching the same job, finish without a deadlock in either order;
 * a task_update that cancels the task while a report holds its job is not refused; a report that
 * commits after the tick's snapshot is seen; and what PostgreSQL's FOR KEY SHARE still waits for, a
 * parent's newer version held FOR UPDATE, comes before the tick holds any job — and, for a
 * project's, before it holds any task. Every wait the tick can still meet is cut at its lock
 * timeout: it then opens nothing and the claim is the next tick's, late by a tick and not lost, and
 * a card another tick opened and the owner closed while it waited is not opened a second time. The
 * cases that hold the tick at one of its waits while they arrange what happens beside it give it a
 * longer timeout than production's.
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

/** One call under test, started without being awaited: whether it has ended, and how. */
function started<T>(call: Promise<T>): {
  ended: { settled: boolean };
  result: Promise<{ value: T | null; error: unknown }>;
} {
  const ended = { settled: false };
  const result = call.then(
    (value) => { ended.settled = true; return { value, error: null as unknown }; },
    (error: unknown) => { ended.settled = true; return { value: null, error }; },
  );
  return { ended, result };
}

/** The statements of this database waiting on a lock right now, other than the asking connection's. */
async function lockWaits(sql: Client): Promise<string[]> {
  const { rows } = await sql.query<{ query: string }>(`
    SELECT left(regexp_replace("query", '\\s+', ' ', 'g'), 160) AS "query" FROM pg_stat_activity
     WHERE "wait_event_type" = 'Lock' AND "datname" = current_database() AND "pid" <> pg_backend_pid()
     ORDER BY "query_start"`);
  return rows.map((row) => row.query.trim());
}

/** Until `count` statements wait on a lock, or a call under test has already ended — whichever comes first. */
async function untilLockWaits(
  sql: Client,
  count: number,
  calls: ReadonlyArray<{ settled: boolean }>,
): Promise<string[]> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const waits = await lockWaits(sql);
    if (waits.length >= count || calls.some((call) => call.settled) || Date.now() > deadline) return waits;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** The backends of this database waiting on a lock right now, other than the asking connection's, and whom each waits for. */
async function lockWaiters(sql: Client): Promise<Array<{ pid: number; query: string; blockedBy: number[] }>> {
  const { rows } = await sql.query<{ pid: number; query: string; blocked_by: number[] }>(`
    SELECT "pid", left(regexp_replace("query", '\\s+', ' ', 'g'), 160) AS "query",
           pg_blocking_pids("pid") AS "blocked_by"
      FROM pg_stat_activity
     WHERE "wait_event_type" = 'Lock' AND "datname" = current_database() AND "pid" <> pg_backend_pid()
     ORDER BY "query_start"`);
  return rows.map((row) => ({ pid: row.pid, query: row.query.trim(), blockedBy: row.blocked_by }));
}

/** Until `accept` holds of the waiters, or a call under test has already ended — whichever comes first. */
async function untilWaiters(
  sql: Client,
  accept: (waiters: Awaited<ReturnType<typeof lockWaiters>>) => boolean,
  calls: ReadonlyArray<{ settled: boolean }>,
): Promise<Awaited<ReturnType<typeof lockWaiters>>> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const waiters = await lockWaiters(sql);
    if (accept(waiters) || calls.some((call) => call.settled) || Date.now() > deadline) return waiters;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Until every call has ended, or `ms` have passed — whichever comes first. */
async function untilSettled(calls: ReadonlyArray<{ settled: boolean }>, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (!calls.every((call) => call.settled) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Until `count` requests for `project_open_item` itself are queued behind a table lock, or a call has ended. */
async function untilInsertsQueued(
  sql: Client,
  count: number,
  calls: ReadonlyArray<{ settled: boolean }>,
): Promise<number> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const { rows: [row] } = await sql.query<{ n: number }>(`
      SELECT count(*)::int AS "n" FROM pg_locks
       WHERE "locktype" = 'relation' AND "relation" = '"project_open_item"'::regclass AND NOT "granted"
         AND "database" = (SELECT "oid" FROM pg_database WHERE "datname" = current_database())`);
    const queued = row?.n ?? 0;
    if (queued >= count || calls.some((call) => call.settled) || Date.now() > deadline) return queued;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/**
 * The lease alarm's statement as `lockWaits` reads it: its CTEs come first, so its text starts with them. An
 * alarm spelled as a bare INSERT names the table first, and is the same write.
 */
const TICK_STATEMENT = /^(?:WITH due AS MATERIALIZED|INSERT INTO "project_open_item")/;

/**
 * The lock timeout of a case that holds the alarm at one of its waits while it arranges what happens beside it: longer
 * than any of them holds it, so the wait is the one the case is about rather than the timeout's.
 */
const HELD_TICK_LOCK_TIMEOUT_MS = 60_000;

/** The lock timeout of the cases about the bound itself: short, so that it, and not the holder, ends the wait. */
const SHORT_LOCK_TIMEOUT_MS = 300;

/**
 * The alarm's lock timeout on this one clock. Set through a cast, so that this file compiles against a service that has
 * no such field — one whose alarm waits as long as PostgreSQL makes it, which the bound cases below are red against.
 */
function waitingUpTo(clock: ProjectOpenItemEscalationService, ms: number): ProjectOpenItemEscalationService {
  (clock as unknown as { leaseAlarmLockTimeoutMs: number }).leaseAlarmLockTimeoutMs = ms;
  return clock;
}

/** Every warning this one clock logs, kept in `said` instead of printed. */
function warningsOf(clock: ProjectOpenItemEscalationService, said: string[]): ProjectOpenItemEscalationService {
  (clock as unknown as { logger: object }).logger = {
    warn: (message: string) => { said.push(message); },
    log: () => undefined,
    error: () => undefined,
    debug: () => undefined,
  };
  return clock;
}

/** The lease alarm on a client of its own, started without being awaited — under `lockTimeoutMs` when given. */
function tickOn(db: PrismaClient, lockTimeoutMs?: number, warned?: string[]) {
  const clock = new ProjectOpenItemEscalationService(db as unknown as PrismaService, recordingPush().push as never);
  if (lockTimeoutMs !== undefined) waitingUpTo(clock, lockTimeoutMs);
  if (warned) warningsOf(clock, warned);
  return started(clock.openLeaseExpiredItems());
}

/**
 * A TasksService whose whole-transaction retry is observed: a deadlock an `update` absorbed shows as RETRYING.
 * `transientWriteRetry` is how every TasksService write asks for the shared retry; it is shadowed on this one
 * instance only.
 */
function observedTasks(stack: Stack, outcomes: string[]): TasksService {
  const tasks = new TasksService(stack.prisma as never, {} as never, {
    publishTaskChanged() {},
    publishForUser() {},
  } as never);
  (tasks as unknown as { transientWriteRetry: (operation: string, policy?: object) => object })
    .transientWriteRetry = (operation, policy = {}) => ({
      ...policy,
      label: operation,
      onOutcome: (event: { outcome: string }) => { outcomes.push(event.outcome); },
    });
  return tasks;
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

  await t.test('(17) a J-T1e “too early” READY from a candidate’s check closes the item too', async () => {
    // §3.4, J-T1e one level up: a TASK_BRANCH candidate's check answered READY before the task's work had stopped
    // moving, so the tip it resolved is not frozen. The check goes back to the queue (or ends CANCELLED when a stop
    // was asked), which clears the claim — so the item about that claim's silence is answered in that transaction.
    for (const stopped of [false, true]) {
      const label = stopped ? 'check-too-early-stopped' : 'check-too-early';
      const w = await world(stack, label, 'MAIN');
      const { sessionId } = await doneTask(stack, w, label);
      const candidate = await stack.db.projectPromotion.findFirstOrThrow({
        where: { projectId: w.projectId, sourceKind: 'TASK_BRANCH' }, select: { id: true },
      });
      const job = await claim(stack, w);
      assert.equal(job.kind, 'CHECK_PROMOTION', `${label}: a MAIN line's DONE queues the candidate's check`);
      // The work finished AFTER the claim: a READY about this branch cannot have seen its last commit.
      await stack.db.session.update({ where: { id: sessionId }, data: { finishedAt: new Date() } });
      if (stopped) {
        await stack.db.projectIntegrationJob.update({
          where: { id: job.jobId }, data: { cancelRequestedAt: new Date() },
        });
      }
      const clock = new ProjectOpenItemEscalationService(stack.prisma, recordingPush().push as never);
      await ageClaim(stack, job.jobId, 26 * MINUTE);
      await tick(stack, clock, recordingPush().push);
      const [opened] = await leaseItems(stack, w.projectId);
      assert.ok(opened, `${label}: no item opened`);
      assert.deepEqual(
        [opened.state, opened.title, opened.integrationJobId, opened.promotionId],
        ['OPEN', 'No word from the runner: Merge check', job.jobId, candidate.id],
        `${label}: the item is about the check's claim and names the candidate`,
      );

      const taken = await report(stack, w, job, {
        state: 'READY', phase: 'CHECK', sourceSha: sha('a'), upstreamSha: UPSTREAM_TIP,
        testedTreeSha: sha('c'), aheadOfUpstream: 1, filesChanged: 1, checks: [], conflicts: [],
      });
      assert.equal(taken.state, stopped ? 'CANCELLED' : 'QUEUED',
        `${label}: the READY was written down as an answer rather than asked again`);
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
      assert.equal(
        (await stack.db.projectPromotion.findUniqueOrThrow({
          where: { id: candidate.id }, select: { sourceSha: true },
        })).sourceSha,
        null,
        `${label}: the candidate was frozen on a check that answered too early`,
      );
    }
  });

  await t.test('(18) two ticks whose inserts meet on one claim open one item, and one of them says so', async () => {
    const w = await world(stack, 'overlap', 'PROJECT_BRANCH');
    await doneTask(stack, w, 'overlap');
    const job = await claim(stack, w);
    await ageClaim(stack, job.jobId, 26 * MINUTE);
    const key = leaseExpiredDedupeKey(job.jobId, job.claimGeneration);
    const holder = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
    await holder.connect();
    const oneDb = prismaClientFor(url);
    const twoDb = prismaClientFor(url);
    try {
      // Two replicas, each with its own client. A table lock that admits readers and no writer holds both at their
      // INSERT, and releasing it lets the two meet there: the partial unique index over OPEN items is the arbiter. Both
      // wait at the table lock, and the later one may then wait at the index for the other's commit, so both are given a
      // timeout longer than either wait.
      await holder.query('BEGIN');
      await holder.query('LOCK TABLE "project_open_item" IN SHARE MODE');
      const one = waitingUpTo(new ProjectOpenItemEscalationService(
        oneDb as unknown as PrismaService, recordingPush().push as never), HELD_TICK_LOCK_TIMEOUT_MS);
      const two = waitingUpTo(new ProjectOpenItemEscalationService(
        twoDb as unknown as PrismaService, recordingPush().push as never), HELD_TICK_LOCK_TIMEOUT_MS);
      const first = started(one.openLeaseExpiredItems());
      const second = started(two.openLeaseExpiredItems());
      assert.equal(await untilInsertsQueued(sql, 2, [first.ended, second.ended]), 2,
        'both ticks reached their insert and queued behind the table lock');
      await holder.query('COMMIT');
      const answers = await Promise.all([first.result, second.result]);
      for (const answer of answers) {
        assert.equal(answer.error, null, `a tick failed: ${(answer.error as Error | null)?.message}`);
      }
      const said = answers.map((answer) => (answer.value ?? []).filter((row) => row.projectId === w.projectId));
      assert.deepEqual(said.map((rows) => rows.length).sort(), [0, 1],
        'exactly one of the two calls returned the item, and the other returned nothing for this claim');
      const open = await stack.db.projectOpenItem.findMany({
        where: { projectId: w.projectId, dedupeKey: key, state: 'OPEN' }, select: { id: true },
      });
      assert.equal(open.length, 1, 'the claim has exactly one OPEN item');
      assert.equal(open[0]!.id, said.flat()[0]!.itemId, 'and it is the one that call returned');
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      await holder.end().catch(() => undefined);
      await oneDb.$disconnect().catch(() => undefined);
      await twoDb.$disconnect().catch(() => undefined);
    }
  });

  await t.test('(19) a tick and a task_reopen ending the same silent claim do not deadlock', async (race) => {
    // J-T8: reopening a DONE task stops its landing in the reopen's own transaction — task FOR UPDATE (rank 50),
    // then the job row's end (rank 60, `stopInFlightJob` → `endTimedOutLanding`). The item's foreign key takes the
    // task FOR KEY SHARE, which conflicts with FOR UPDATE, and the tick reads the same job FOR SHARE. Each order is
    // forced from a second connection: the reopen held at its job write after taking the task, with the tick
    // arriving — the tick leaves that claim and returns; and the tick held at its insert after taking the claim's
    // rows, with the reopen arriving — the reopen waits for the tick, then ends the job and closes the item.
    for (const order of ['reopen first', 'tick first'] as const) {
      await race.test(order === 'reopen first'
        ? '(19a) the reopen holds the task and waits at its job write when the tick arrives; the tick skips it'
        : '(19b) the tick has taken the claim’s rows and waits at its insert when the reopen arrives', async () => {
        const label = order === 'reopen first' ? 'reopen-race' : 'tick-race';
        const w = await world(stack, label, 'PROJECT_BRANCH');
        const { taskId } = await doneTask(stack, w, label);
        const job = await claim(stack, w);
        await ageClaim(stack, job.jobId, 26 * MINUTE);
        assert.deepEqual(await leaseItems(stack, w.projectId), [], `${order}: nothing is open before the race`);

        const holder = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
        await holder.connect();
        const tickDb = prismaClientFor(url);
        const reopenOutcomes: string[] = [];
        const reopening = () => started(observedTasks(stack, reopenOutcomes).update(w.ownerId, taskId, {
          status: 'OPEN', supersededByTaskId: null, terminalReason: null,
        } as never));
        let reopenCall: ReturnType<typeof reopening> | undefined;
        let tickCall: ReturnType<typeof tickOn> | undefined;
        try {
          await holder.query('BEGIN');
          if (order === 'reopen first') {
            // A share lock on the job: the tick's own mode, so the tick is not held by it, while the reopen's write of
            // the job waits for it — after the reopen has taken the task.
            await holder.query(
              `SELECT "id" FROM "project_integration_job" WHERE "id" = $1::uuid FOR SHARE`, [job.jobId]);
            reopenCall = reopening();
            const waitingFirst = await untilLockWaits(sql, 1, [reopenCall.ended]);
            assert.equal(waitingFirst.length, 1, 'the reopen was not held by the second connection');
            assert.match(waitingFirst[0]!, /^UPDATE "project_integration_job"/,
              'the reopen is held at its write of the job, after it has taken the task');
            tickCall = tickOn(tickDb);
            const waitingBoth = await untilLockWaits(sql, 2, [tickCall.ended]);
            assert.equal(tickCall.ended.settled, true, 'the tick waited instead of leaving the claim whose task '
              + `the reopen holds: ${JSON.stringify(waitingBoth)}`);
            assert.equal(reopenCall.ended.settled, false,
              'the reopen is still held at the job, so the tick ran beside it');
            await holder.query('COMMIT');
          } else {
            // Another replica's insert of this claim's item, not committed: the unique index over OPEN items holds the
            // tick at its own insert, with the claim's rows already taken. It names neither the task nor the job, so it
            // holds nothing the reopen waits on.
            await holder.query(`
              INSERT INTO "project_open_item" (
                "id", "project_id", "owner_id", "kind", "assignee", "assignee_reason", "dedupe_key", "title",
                "payload", "waiting_since", "assigned_at", "escalated_at")
              VALUES ($1::uuid, $2::uuid, $3::uuid, 'LANDING_LEASE_EXPIRED', 'OWNER', 'ESCALATED', $4,
                      'No word from the runner: another replica', '{}'::jsonb, now(), now(), now())`,
            [randomUUID(), w.projectId, w.ownerId, leaseExpiredDedupeKey(job.jobId, job.claimGeneration)]);
            tickCall = tickOn(tickDb, HELD_TICK_LOCK_TIMEOUT_MS);
            const waitingFirst = await untilLockWaits(sql, 1, [tickCall.ended]);
            assert.equal(waitingFirst.length, 1, 'the tick was not held by the second connection');
            assert.match(waitingFirst[0]!, TICK_STATEMENT,
              'the tick is held at its insert, after it has taken the claim’s rows');
            reopenCall = reopening();
            const waitingBoth = await untilLockWaits(sql, 2, [reopenCall.ended, tickCall.ended]);
            assert.equal(waitingBoth.length, 2,
              `the reopen did not meet the tick while it was held: ${JSON.stringify(waitingBoth)}`);
            // Met the tick, not merely waited beside it: the backend the reopen waits for is the tick's.
            const waiters = await lockWaiters(sql);
            const tickWaiter = waiters.find((waiter) => TICK_STATEMENT.test(waiter.query));
            const reopenWaiter = waiters.find((waiter) => waiter !== tickWaiter);
            assert.ok(tickWaiter && reopenWaiter, `two waiters, one of them the tick: ${JSON.stringify(waiters)}`);
            assert.ok(reopenWaiter.blockedBy.includes(tickWaiter.pid),
              `the reopen is not blocked by the tick: ${JSON.stringify(waiters)}`);
            await holder.query('ROLLBACK');
          }

          const [reopened, ticked] = await Promise.all([reopenCall.result, tickCall.result]);
          assert.equal(reopened.error, null,
            `${order}: the reopen failed: ${(reopened.error as Error | null)?.message}`);
          assert.equal(ticked.error, null,
            `${order}: the tick failed: ${(ticked.error as Error | null)?.message}`);
          assert.equal(reopenOutcomes.includes('RETRYING'), false,
            `${order}: the reopen was a deadlock victim and was run again: ${JSON.stringify(reopenOutcomes)}`);
          assert.equal(reopenOutcomes[0], 'COMMITTED', `${order}: the reopen committed on its first attempt`);
          assert.equal((reopened.value as { status?: string } | null)?.status, 'OPEN',
            `${order}: the task is reopened`);

          // The reopen stopped the silent landing either way: it was past its limit, so it is ended (J-T8, J12).
          const row = await stack.db.projectIntegrationJob.findUniqueOrThrow({
            where: { id: job.jobId }, select: { state: true, errorCode: true },
          });
          assert.deepEqual([row.state, row.errorCode], ['ERROR', 'RUNNER_LOST'], `${order}: the landing was not ended`);
          const opened = (ticked.value ?? []).filter((item) => item.projectId === w.projectId);
          const items = await leaseItems(stack, w.projectId);
          if (order === 'reopen first') {
            assert.deepEqual(opened, [], 'the tick left the claim whose task the reopen held, and opened nothing');
            assert.deepEqual(items, [], 'no item was written about a claim the reopen was ending');
          } else {
            assert.deepEqual(opened.map((item) => item.itemId), items.map((item) => item.id),
              'the tick opened the item before the reopen reached the task');
            assert.deepEqual(
              items.map((item) => [item.state, item.resolution, item.resolvedBy]),
              [['RESOLVED', 'JOB_MOVED_ON', 'PLATFORM']],
              'and the reopen, ending the job, closed it in its own transaction',
            );
          }
          // And the next tick finds nothing left to say about this claim.
          const { push } = recordingPush();
          await tick(stack, new ProjectOpenItemEscalationService(stack.prisma, push as never), push);
          assert.deepEqual(
            (await leaseItems(stack, w.projectId)).map((item) => [item.id, item.state]),
            items.map((item) => [item.id, item.state]),
            `${order}: a later tick opened or moved an item about the ended claim`,
          );
        } finally {
          await holder.query('ROLLBACK').catch(() => undefined);
          await holder.end().catch(() => undefined);
          // A call a failed assertion left running ends once the holder has; it is awaited before its client goes.
          await Promise.all([reopenCall?.result, tickCall?.result]);
          await tickDb.$disconnect().catch(() => undefined);
        }
      });
    }
  });

  await t.test('(20) a report that commits after the tick’s snapshot and before its lock is seen', async () => {
    // The tick does not wait for a report in flight — it leaves that claim (22). What it must still not miss is a
    // report that has COMMITTED after the statement's snapshot: READ COMMITTED locks the job's newest version and
    // checks the WHERE again on it. Forced here with two silent claims of one project. Another replica's uncommitted
    // items, one under each claim's key, hold the tick at the insert of whichever claim it reaches first, holding
    // that job FOR SHARE and not yet the other. A report then takes the other job as a report takes one, FOR NO KEY
    // UPDATE — SKIP LOCKED finds it, the one the tick holds being the one it skips — and commits a renewed
    // heartbeat while the tick is still held. Then the tick goes on.
    const w = await world(stack, 'report-race', 'PROJECT_BRANCH');
    const jobs = [
      await rawRunningJob(stack, w, {
        label: 'report-race-one', claimedAtMsAgo: 40 * MINUTE, heartbeatMsAgo: 30 * MINUTE,
        targetRef: w.integrationRef,
      }),
      await rawRunningJob(stack, w, {
        label: 'report-race-two', claimedAtMsAgo: 40 * MINUTE, heartbeatMsAgo: 30 * MINUTE,
        targetRef: w.upstreamRef,
      }),
    ];
    const holder = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
    const reporter = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
    await holder.connect();
    await reporter.connect();
    const tickDb = prismaClientFor(url);
    let ticking: ReturnType<typeof tickOn> | undefined;
    try {
      await holder.query('BEGIN');
      for (const job of jobs) {
        await holder.query(`
          INSERT INTO "project_open_item" (
            "id", "project_id", "owner_id", "kind", "assignee", "assignee_reason", "dedupe_key", "title",
            "payload", "waiting_since", "assigned_at", "escalated_at")
          VALUES ($1::uuid, $2::uuid, $3::uuid, 'LANDING_LEASE_EXPIRED', 'OWNER', 'ESCALATED', $4,
                  'No word from the runner: another replica', '{}'::jsonb, now(), now(), now())`,
        [randomUUID(), w.projectId, w.ownerId, leaseExpiredDedupeKey(job, 1)]);
      }
      ticking = tickOn(tickDb, HELD_TICK_LOCK_TIMEOUT_MS);
      const waiting = await untilLockWaits(sql, 1, [ticking.ended]);
      assert.equal(waiting.length, 1, 'the tick was not held at its first claim’s insert');
      assert.match(waiting[0]!, TICK_STATEMENT, 'the waiting statement is the tick’s');

      // The other claim talks again, and that commits while the tick is held: after its snapshot, before its lock.
      await reporter.query('BEGIN');
      const { rows: free } = await reporter.query<{ id: string }>(`
        SELECT "id" FROM "project_integration_job" WHERE "id" = ANY($1::uuid[])
         ORDER BY "id" FOR NO KEY UPDATE SKIP LOCKED`, [jobs]);
      assert.equal(free.length, 1,
        `the tick should hold exactly the claim it is inserting for: ${JSON.stringify(free)}`);
      const talking = free[0]!.id;
      const silent = jobs.find((job) => job !== talking)!;
      await reporter.query(`UPDATE "project_integration_job" SET "heartbeat_at" = now() WHERE "id" = $1::uuid`,
        [talking]);
      await reporter.query('COMMIT');
      assert.equal(ticking.ended.settled, false, 'the tick is still held at its first claim, so the report came first');

      await holder.query('ROLLBACK');
      const ticked = await ticking.result;
      assert.equal(ticked.error, null, `the tick failed: ${(ticked.error as Error | null)?.message}`);
      const items = await leaseItems(stack, w.projectId);
      assert.deepEqual(items.map((item) => item.integrationJobId), [silent],
        'the tick opened the silent claim’s item and none for the claim whose report committed under it');
      assert.deepEqual(
        (ticked.value ?? []).filter((item) => item.projectId === w.projectId).map((item) => item.itemId),
        items.map((item) => item.id),
        'and it says so',
      );
    } finally {
      await reporter.query('ROLLBACK').catch(() => undefined);
      await holder.query('ROLLBACK').catch(() => undefined);
      await holder.end().catch(() => undefined);
      await reporter.end().catch(() => undefined);
      await ticking?.result;
      await tickDb.$disconnect().catch(() => undefined);
    }
  });

  await t.test('(21) a tick and a project delete reaching the same silent job do not deadlock', async () => {
    // The cycle the item's keys closed with J-T8's stop in (19), one rank up: ProjectsService.remove takes the
    // project FOR UPDATE and then deletes it, and the job goes with it (`project_integration_job_project_fkey`,
    // ON DELETE CASCADE), while the item's key takes the project FOR KEY SHARE. The delete is spelled here as its
    // two locks on a connection of its own, held at the cascade by a share lock on the job — the tick's own mode —
    // until the tick has run: the tick finds the project held, leaves the claim and returns, and the delete then
    // goes through.
    const w = await world(stack, 'delete-race', 'PROJECT_BRANCH');
    const job = await rawRunningJob(stack, w, {
      label: 'delete-race', claimedAtMsAgo: 30 * MINUTE, heartbeatMsAgo: 30 * MINUTE,
    });
    const holder = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
    const remover = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
    await holder.connect();
    await remover.connect();
    const tickDb = prismaClientFor(url);
    let removing: ReturnType<typeof started<unknown>> | undefined;
    let ticking: ReturnType<typeof tickOn> | undefined;
    try {
      await holder.query('BEGIN');
      await holder.query(`SELECT "id" FROM "project_integration_job" WHERE "id" = $1::uuid FOR SHARE`, [job]);
      await remover.query('BEGIN');
      await remover.query(
        `SELECT "id" FROM "project" WHERE "id" = $1::uuid AND "owner_id" = $2::uuid FOR UPDATE`,
        [w.projectId, w.ownerId]);
      removing = started<unknown>(remover.query(`DELETE FROM "project" WHERE "id" = $1::uuid`, [w.projectId]));
      const waitingFirst = await untilLockWaits(sql, 1, [removing.ended]);
      assert.deepEqual(waitingFirst.map((query) => query.startsWith('DELETE FROM "project"')), [true],
        `the delete is held at its cascade into the job: ${JSON.stringify(waitingFirst)}`);
      ticking = tickOn(tickDb);
      const waitingBoth = await untilLockWaits(sql, 2, [ticking.ended]);
      assert.equal(ticking.ended.settled, true,
        `the tick waited for the delete instead of leaving its claim: ${JSON.stringify(waitingBoth)}`);
      const ticked = await ticking.result;
      assert.equal(ticked.error, null, `the tick failed: ${(ticked.error as Error | null)?.message}`);
      assert.deepEqual((ticked.value ?? []).filter((item) => item.projectId === w.projectId), [],
        'the tick opened an item about a project that was being deleted');
      assert.equal(removing.ended.settled, false, 'the delete is still held at its cascade, so the tick ran beside it');

      await holder.query('COMMIT');
      const removed = await removing.result;
      assert.equal(removed.error, null, `the delete failed: ${(removed.error as Error | null)?.message}`);
      await remover.query('COMMIT');
      assert.equal(await stack.db.project.count({ where: { id: w.projectId } }), 0, 'the project is gone');
      assert.equal(await stack.db.projectIntegrationJob.count({ where: { id: job } }), 0, 'and its job with it');
    } finally {
      // Both connections let go before any call is awaited: a call a failed assertion left running may be waiting on
      // either. The remover's ROLLBACK runs once its DELETE has ended.
      await holder.query('ROLLBACK').catch(() => undefined);
      await holder.end().catch(() => undefined);
      await remover.query('ROLLBACK').catch(() => undefined);
      await Promise.all([removing?.result, ticking?.result]);
      await remover.end().catch(() => undefined);
      await tickDb.$disconnect().catch(() => undefined);
    }
  });

  await t.test('(21b) a tick held at its insert, and a project delete that arrives and waits for it, do not deadlock', async () => {
    // (21) in the other order: the tick has taken the claim's rows, the project FOR KEY SHARE among them, and is held at
    // its insert when the delete arrives. What holds it there is another replica's uncommitted item under the same key,
    // whose own foreign key takes the project FOR KEY SHARE as well. That item is written once the tick holds the
    // project — while a first holder keeps the tick waiting in its CTE on the newer version of the claim's candidate, the
    // way (24) does with a task (a project that still has a task is not deleted) — so the tick is the project's first
    // locker, the one the delete's FOR UPDATE waits for first. The first holder then commits and the tick goes on to its
    // insert. The delete waits for the tick, and the tick for the other replica only; once that item is rolled back the
    // tick opens its own and commits, and the delete takes the project and goes through, the candidate, the job and the
    // item going with it.
    const w = await world(stack, 'delete-race-tick-first', 'PROJECT_BRANCH');
    const promotionId = randomUUID();
    await stack.db.projectPromotion.create({
      data: {
        id: promotionId, projectId: w.projectId, ownerId: w.ownerId, codebaseId: w.codebaseId,
        sourceKind: 'PROJECT_BRANCH', sourceRef: w.integrationRef, sourceSha: sha('a'),
        upstreamRef: w.upstreamRef, state: 'CONFIRMED', confirmedAt: new Date(), confirmedByUserId: w.ownerId,
      } as never,
    });
    const jobId = await rawRunningJob(stack, w, {
      label: 'delete-race-tick-first', kind: 'LAND_PROMOTION', phase: 'MERGE',
      claimedAtMsAgo: 30 * MINUTE, heartbeatMsAgo: 30 * MINUTE, targetRef: w.upstreamRef, promotionId,
    });
    const first = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
    const replica = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
    const remover = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
    await first.connect();
    await replica.connect();
    await remover.connect();
    // A statement that writes its item before it waits would hold the other replica's insert behind its own, and the
    // delete behind it in turn: each side connection gives up after ten seconds rather than hanging this file.
    await replica.query(`SET lock_timeout = '10s'`);
    await remover.query(`SET lock_timeout = '10s'`);
    const tickDb = prismaClientFor(url);
    let removing: ReturnType<typeof started<unknown>> | undefined;
    let ticking: ReturnType<typeof tickOn> | undefined;
    try {
      await first.query('BEGIN');
      await first.query(
        `UPDATE "project_promotion" SET "commits_ahead" = "commits_ahead" WHERE "id" = $1::uuid`, [promotionId]);
      await first.query(`SELECT "id" FROM "project_promotion" WHERE "id" = $1::uuid FOR UPDATE`, [promotionId]);
      ticking = tickOn(tickDb, HELD_TICK_LOCK_TIMEOUT_MS);
      const inCte = await untilLockWaits(sql, 1, [ticking.ended]);
      assert.deepEqual(inCte.map((query) => TICK_STATEMENT.test(query)), [true],
        `the tick waits in its CTE for the candidate, holding the project: ${JSON.stringify(inCte)}`);

      const { rows: [own] } = await replica.query<{ pid: number }>('SELECT pg_backend_pid() AS "pid"');
      const replicaPid = own!.pid;
      await replica.query('BEGIN');
      await replica.query(`
        INSERT INTO "project_open_item" (
          "id", "project_id", "owner_id", "kind", "assignee", "assignee_reason", "dedupe_key", "title",
          "payload", "waiting_since", "assigned_at", "escalated_at")
        VALUES ($1::uuid, $2::uuid, $3::uuid, 'LANDING_LEASE_EXPIRED', 'OWNER', 'ESCALATED', $4,
                'No word from the runner: another replica', '{}'::jsonb, now(), now(), now())`,
      [randomUUID(), w.projectId, w.ownerId, leaseExpiredDedupeKey(jobId, 1)]);
      await first.query('COMMIT');
      const atInsert = await untilWaiters(sql, (waiters) => waiters.some((waiter) =>
        TICK_STATEMENT.test(waiter.query) && waiter.blockedBy.includes(replicaPid)), [ticking.ended]);
      const tickWaiter = atInsert.find((waiter) => TICK_STATEMENT.test(waiter.query));
      assert.ok(tickWaiter && tickWaiter.blockedBy.includes(replicaPid),
        `the tick is held at its insert by the other replica's item: ${JSON.stringify(atInsert)}`);

      await remover.query('BEGIN');
      removing = started<unknown>(remover.query(
        `SELECT "id" FROM "project" WHERE "id" = $1::uuid AND "owner_id" = $2::uuid FOR UPDATE`,
        [w.projectId, w.ownerId]));
      const both = await untilWaiters(sql, (waiters) => waiters.some((waiter) =>
        waiter.query.startsWith('SELECT "id" FROM "project"')), [removing.ended, ticking.ended]);
      const removeWaiter = both.find((waiter) => waiter.query.startsWith('SELECT "id" FROM "project"'));
      assert.ok(removeWaiter?.blockedBy.includes(tickWaiter.pid),
        `the delete's FOR UPDATE of the project waits for the tick: ${JSON.stringify(both)}`);
      assert.equal(ticking.ended.settled, false, 'the tick is still held at its insert');

      await replica.query('ROLLBACK');
      const ticked = await ticking.result;
      assert.equal(ticked.error, null, `the tick failed: ${(ticked.error as Error | null)?.message}`);
      const opened = (ticked.value ?? []).filter((item) => item.projectId === w.projectId);
      assert.equal(opened.length, 1, 'the tick opened the claim’s item once the other replica’s was rolled back');
      const took = await removing.result;
      assert.equal(took.error, null, `the delete's lock failed: ${(took.error as Error | null)?.message}`);
      await remover.query(`DELETE FROM "project" WHERE "id" = $1::uuid`, [w.projectId]);
      await remover.query('COMMIT');
      assert.equal(await stack.db.project.count({ where: { id: w.projectId } }), 0, 'the project is gone');
      assert.equal(await stack.db.projectIntegrationJob.count({ where: { id: jobId } }), 0, 'and its job with it');
      assert.equal(await stack.db.projectOpenItem.count({ where: { id: opened[0]!.itemId } }), 0,
        'and the item the tick opened');
    } finally {
      // Every connection lets go before any call is awaited: a call a failed assertion left running may be waiting on
      // any of them. The remover's ROLLBACK runs once its lock has been granted.
      await first.query('ROLLBACK').catch(() => undefined);
      await replica.query('ROLLBACK').catch(() => undefined);
      await first.end().catch(() => undefined);
      await replica.end().catch(() => undefined);
      await remover.query('ROLLBACK').catch(() => undefined);
      await Promise.all([removing?.result, ticking?.result]);
      await remover.end().catch(() => undefined);
      await tickDb.$disconnect().catch(() => undefined);
    }
  });

  await t.test('(22) a claim whose rows another transaction holds is the next tick’s, with no wait', async (held) => {
    // The tick takes every row it writes about SKIP LOCKED — the job FOR SHARE, and its project, task and candidate
    // FOR KEY SHARE, the mode the item's keys take — so a row another transaction holds in a conflicting mode makes
    // it leave that claim instead of waiting. Each case holds one row on a second connection, as the writer named
    // holds it, and runs the tick beside it: the tick must end while that row is still held, having opened nothing.
    // Then the holder ends, and the next tick does what the claim's rows now say.
    const cases = [
      {
        name: '(22a) the job, held FOR NO KEY UPDATE by a report in flight that then commits a renewed heartbeat',
        lock: `SELECT "id" FROM "project_integration_job" WHERE "id" = $1::uuid FOR NO KEY UPDATE`,
        row: 'job', end: 'COMMIT', reports: true, opensAfter: false,
      },
      {
        name: '(22b) the job, held FOR NO KEY UPDATE by a report that is then rolled back',
        lock: `SELECT "id" FROM "project_integration_job" WHERE "id" = $1::uuid FOR NO KEY UPDATE`,
        row: 'job', end: 'ROLLBACK', reports: true, opensAfter: true,
      },
      {
        name: '(22c) the task, held FOR UPDATE as task_reopen and a supersession take it',
        lock: `SELECT "id" FROM "task" WHERE "id" = $1::uuid FOR UPDATE`,
        row: 'task', end: 'ROLLBACK', reports: false, opensAfter: true,
      },
      {
        name: '(22d) the project, held FOR UPDATE as a project delete takes it',
        lock: `SELECT "id", "coordinator_session_id" FROM "project" WHERE "id" = $1::uuid FOR UPDATE`,
        row: 'project', end: 'ROLLBACK', reports: false, opensAfter: true,
      },
      {
        name: '(22e) the candidate, held FOR UPDATE as a project delete’s cascade takes it',
        lock: `SELECT "id" FROM "project_promotion" WHERE "id" = $1::uuid FOR UPDATE`,
        row: 'promotion', end: 'ROLLBACK', reports: false, opensAfter: true,
      },
    ] as const;
    for (const one of cases) {
      await held.test(one.name, async () => {
        const w = await world(stack, `held-${one.row}`, 'PROJECT_BRANCH');
        // A landing for the job, the task and the project; a candidate's merge for the candidate.
        let jobId: string;
        let rowId: string;
        if (one.row === 'promotion') {
          rowId = randomUUID();
          await stack.db.projectPromotion.create({
            data: {
              id: rowId, projectId: w.projectId, ownerId: w.ownerId, codebaseId: w.codebaseId,
              sourceKind: 'PROJECT_BRANCH', sourceRef: w.integrationRef, sourceSha: sha('a'),
              upstreamRef: w.upstreamRef, state: 'CONFIRMED', confirmedAt: new Date(),
              confirmedByUserId: w.ownerId,
            } as never,
          });
          jobId = await rawRunningJob(stack, w, {
            label: 'held-promotion', kind: 'LAND_PROMOTION', phase: 'MERGE',
            claimedAtMsAgo: 30 * MINUTE, heartbeatMsAgo: 30 * MINUTE,
            targetRef: w.upstreamRef, promotionId: rowId,
          });
        } else {
          const { taskId } = await doneTask(stack, w, `held-${one.row}`);
          const job = await claim(stack, w);
          await ageClaim(stack, job.jobId, 26 * MINUTE);
          jobId = job.jobId;
          rowId = one.row === 'job' ? job.jobId : one.row === 'task' ? taskId : w.projectId;
        }
        const holder = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
        await holder.connect();
        const tickDb = prismaClientFor(url);
        let ticking: ReturnType<typeof tickOn> | undefined;
        try {
          await holder.query('BEGIN');
          await holder.query(one.lock, [rowId]);
          if (one.reports) {
            await holder.query(
              `UPDATE "project_integration_job" SET "heartbeat_at" = now() WHERE "id" = $1::uuid`, [jobId]);
          }
          ticking = tickOn(tickDb);
          const waits = await untilLockWaits(sql, 1, [ticking.ended]);
          assert.equal(ticking.ended.settled, true,
            `the tick waited for the ${one.row} another transaction holds: ${JSON.stringify(waits)}`);
          assert.deepEqual(waits.filter((query) => TICK_STATEMENT.test(query)), [],
            'the tick was seen waiting on a lock');
          const ticked = await ticking.result;
          assert.equal(ticked.error, null, `the tick failed: ${(ticked.error as Error | null)?.message}`);
          assert.deepEqual((ticked.value ?? []).filter((item) => item.projectId === w.projectId), [],
            `the tick opened an item about a claim whose ${one.row} another transaction holds`);
          assert.deepEqual(await leaseItems(stack, w.projectId), []);

          await holder.query(one.end);
          const next = await new ProjectOpenItemEscalationService(
            stack.prisma, recordingPush().push as never).openLeaseExpiredItems();
          const items = await leaseItems(stack, w.projectId);
          if (one.opensAfter) {
            assert.deepEqual(items.map((item) => [item.integrationJobId, item.state]), [[jobId, 'OPEN']],
              'the claim is still silent, and the next tick opens its item');
            assert.deepEqual(next.filter((item) => item.projectId === w.projectId).map((item) => item.itemId),
              items.map((item) => item.id), 'and says so');
            if (one.row === 'promotion') assert.equal(items[0]!.promotionId, rowId, 'naming the candidate');
          } else {
            assert.deepEqual(items, [],
              'the report committed, so the claim is talking and the next tick opens nothing');
          }
        } finally {
          await holder.query('ROLLBACK').catch(() => undefined);
          await holder.end().catch(() => undefined);
          await ticking?.result;
          await tickDb.$disconnect().catch(() => undefined);
        }
      });
    }
  });

  await t.test('(23) a task_update cancelling the task while a report holds its job is not refused', async () => {
    // A supersession — `{status: CANCELLED, terminalReason: ABANDONED}` here — takes the task FOR UPDATE
    // NOWAIT, and is refused with a 409 when another transaction holds the task in any mode. The tick holds a due
    // claim's task FOR KEY SHARE only for its own statement, which a report in flight does not make wait: it
    // leaves that claim. So the cancel is not refused, reaches the job, waits for the report there, and ends the
    // job once the report is rolled back — and no item is left about a claim the cancel moved on.
    const w = await world(stack, 'cancel-race', 'PROJECT_BRANCH');
    const { taskId } = await doneTask(stack, w, 'cancel-race');
    const job = await claim(stack, w);
    await ageClaim(stack, job.jobId, 26 * MINUTE);
    const reporter = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
    await reporter.connect();
    const tickDb = prismaClientFor(url);
    const outcomes: string[] = [];
    const cancel = () => started(observedTasks(stack, outcomes).update(w.ownerId, taskId, {
      status: 'CANCELLED', terminalReason: 'ABANDONED',
    } as never));
    let ticking: ReturnType<typeof tickOn> | undefined;
    let cancelling: ReturnType<typeof cancel> | undefined;
    try {
      // The report in flight: the job held FOR NO KEY UPDATE, as receiveIntegrationJobProgress holds it.
      await reporter.query('BEGIN');
      await reporter.query(
        `SELECT "id" FROM "project_integration_job" WHERE "id" = $1::uuid FOR NO KEY UPDATE`, [job.jobId]);
      ticking = tickOn(tickDb);
      // Until the tick has ended, or waits at a lock.
      await untilLockWaits(sql, 1, [ticking.ended]);
      cancelling = cancel();
      const waits = await untilLockWaits(sql, ticking.ended.settled ? 1 : 2, [cancelling.ended]);
      if (cancelling.ended.settled) {
        const early = await cancelling.result;
        assert.equal(early.error, null,
          `the cancel was refused while the tick ran: ${(early.error as Error | null)?.message}`);
      }
      assert.ok(waits.some((query) => /^UPDATE "project_integration_job"/.test(query)),
        `the cancel reached the job and waits for the report there: ${JSON.stringify(waits)}`);
      assert.equal(ticking.ended.settled, true, 'the tick waited for the report in flight');

      await reporter.query('ROLLBACK');
      const [cancelled, ticked] = await Promise.all([cancelling.result, ticking.result]);
      assert.equal(cancelled.error, null, `the cancel failed: ${(cancelled.error as Error | null)?.message}`);
      assert.equal(outcomes.includes('RETRYING'), false,
        `the cancel was a deadlock victim and was run again: ${JSON.stringify(outcomes)}`);
      assert.equal(outcomes[0], 'COMMITTED', 'the cancel committed on its first attempt');
      assert.equal((cancelled.value as { status?: string } | null)?.status, 'CANCELLED', 'the task is cancelled');
      assert.equal(ticked.error, null, `the tick failed: ${(ticked.error as Error | null)?.message}`);
      assert.deepEqual((ticked.value ?? []).filter((item) => item.projectId === w.projectId), [],
        'the tick opened an item about a claim whose report was in flight');

      // The cancel stopped the silent landing (J-T8): past its limit, so ended as J12 says.
      const row = await stack.db.projectIntegrationJob.findUniqueOrThrow({
        where: { id: job.jobId }, select: { state: true, errorCode: true },
      });
      assert.deepEqual([row.state, row.errorCode], ['ERROR', 'RUNNER_LOST'], 'the landing was not ended');
      const { push } = recordingPush();
      await tick(stack, new ProjectOpenItemEscalationService(stack.prisma, push as never), push);
      assert.deepEqual(await leaseItems(stack, w.projectId), [],
        'an item was opened about a claim the cancel moved on');
    } finally {
      await reporter.query('ROLLBACK').catch(() => undefined);
      await reporter.end().catch(() => undefined);
      await Promise.all([cancelling?.result, ticking?.result]);
      await tickDb.$disconnect().catch(() => undefined);
    }
  });

  await t.test('(24) what FOR KEY SHARE still waits for comes before the tick holds any job', async () => {
    // SKIP LOCKED does not cover a row's newer versions: PostgreSQL's FOR KEY SHARE also locks the versions an UPDATE
    // made without changing a key, and waits for one held FOR UPDATE by a transaction that is still open (16, the
    // version this repository deploys). Forced here on a due claim's task, which one open transaction has updated
    // without changing a key and then holds FOR UPDATE: the tick waits in its CTE, and holds no job while it does —
    // a third connection takes the job FOR UPDATE NOWAIT. Once the holder commits, the tick goes on and opens the
    // item, since the claim is still silent.
    const w = await world(stack, 'newer-version', 'PROJECT_BRANCH');
    const { taskId } = await doneTask(stack, w, 'newer-version');
    const job = await claim(stack, w);
    await ageClaim(stack, job.jobId, 26 * MINUTE);
    const holder = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
    const prober = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
    await holder.connect();
    await prober.connect();
    const tickDb = prismaClientFor(url);
    let ticking: ReturnType<typeof tickOn> | undefined;
    try {
      await holder.query('BEGIN');
      await holder.query(`UPDATE "task" SET "title" = "title" WHERE "id" = $1::uuid`, [taskId]);
      await holder.query(`SELECT "id" FROM "task" WHERE "id" = $1::uuid FOR UPDATE`, [taskId]);
      ticking = tickOn(tickDb, HELD_TICK_LOCK_TIMEOUT_MS);
      const waiting = await untilLockWaits(sql, 1, [ticking.ended]);
      assert.equal(ticking.ended.settled, false, 'the tick did not wait for the newer version of the task');
      assert.deepEqual(waiting.map((query) => TICK_STATEMENT.test(query)), [true],
        `the waiting statement is the tick’s: ${JSON.stringify(waiting)}`);
      await prober.query('BEGIN');
      await assert.doesNotReject(
        prober.query(`SELECT "id" FROM "project_integration_job" WHERE "id" = $1::uuid FOR UPDATE NOWAIT`, [job.jobId]),
        'the tick holds the job while it waits for the task');
      await prober.query('ROLLBACK');

      await holder.query('COMMIT');
      const ticked = await ticking.result;
      assert.equal(ticked.error, null, `the tick failed: ${(ticked.error as Error | null)?.message}`);
      const items = await leaseItems(stack, w.projectId);
      assert.deepEqual(items.map((item) => [item.integrationJobId, item.taskId, item.state]),
        [[job.jobId, taskId, 'OPEN']], 'the claim is still silent, and the tick opened its item once it went on');
      assert.deepEqual(
        (ticked.value ?? []).filter((item) => item.projectId === w.projectId).map((item) => item.itemId),
        items.map((item) => item.id),
        'and it says so',
      );
    } finally {
      await prober.query('ROLLBACK').catch(() => undefined);
      await holder.query('ROLLBACK').catch(() => undefined);
      await holder.end().catch(() => undefined);
      await prober.end().catch(() => undefined);
      await ticking?.result;
      await tickDb.$disconnect().catch(() => undefined);
    }
  });

  await t.test('(24b) a project’s newer version is waited for before the tick takes any task', async () => {
    // (24) one rank up, and what it shows about the CTE's order: the projects are taken before the tasks. One open
    // transaction has updated a due claim's project without changing a key and then holds it FOR UPDATE, so the tick waits
    // in its CTE at the project — and holds none of the due tasks while it does: a prober's FOR UPDATE NOWAIT on the
    // claim's task, which the tick's FOR KEY SHARE of it would refuse, is granted. A CTE that took the tasks first would
    // hold this one through the wait. Once the holder commits, the tick goes on and opens the item.
    const w = await world(stack, 'newer-project', 'PROJECT_BRANCH');
    const { taskId } = await doneTask(stack, w, 'newer-project');
    const job = await claim(stack, w);
    await ageClaim(stack, job.jobId, 26 * MINUTE);
    const holder = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
    const prober = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
    await holder.connect();
    await prober.connect();
    const tickDb = prismaClientFor(url);
    let ticking: ReturnType<typeof tickOn> | undefined;
    try {
      await holder.query('BEGIN');
      await holder.query(`UPDATE "project" SET "title" = "title" WHERE "id" = $1::uuid`, [w.projectId]);
      await holder.query(`SELECT "id" FROM "project" WHERE "id" = $1::uuid FOR UPDATE`, [w.projectId]);
      ticking = tickOn(tickDb, HELD_TICK_LOCK_TIMEOUT_MS);
      const waiting = await untilLockWaits(sql, 1, [ticking.ended]);
      assert.equal(ticking.ended.settled, false, 'the tick did not wait for the newer version of the project');
      assert.deepEqual(waiting.map((query) => TICK_STATEMENT.test(query)), [true],
        `the waiting statement is the tick’s: ${JSON.stringify(waiting)}`);
      await prober.query('BEGIN');
      await assert.doesNotReject(
        prober.query(`SELECT "id" FROM "task" WHERE "id" = $1::uuid FOR UPDATE NOWAIT`, [taskId]),
        'the tick holds the claim’s task while it waits for the project: it took the tasks first');
      await prober.query('ROLLBACK');

      await holder.query('COMMIT');
      const ticked = await ticking.result;
      assert.equal(ticked.error, null, `the tick failed: ${(ticked.error as Error | null)?.message}`);
      const items = await leaseItems(stack, w.projectId);
      assert.deepEqual(items.map((item) => [item.integrationJobId, item.taskId, item.state]),
        [[job.jobId, taskId, 'OPEN']], 'the claim is still silent, and the tick opened its item once it went on');
      assert.deepEqual(
        (ticked.value ?? []).filter((item) => item.projectId === w.projectId).map((item) => item.itemId),
        items.map((item) => item.id),
        'and it says so',
      );
    } finally {
      await prober.query('ROLLBACK').catch(() => undefined);
      await holder.query('ROLLBACK').catch(() => undefined);
      await holder.end().catch(() => undefined);
      await prober.end().catch(() => undefined);
      await ticking?.result;
      await tickDb.$disconnect().catch(() => undefined);
    }
  });

  await t.test('(25) a wait longer than the lock timeout leaves the alarm to the next tick, and loses nothing', async () => {
    // Every lock wait of the alarm is cut at its lock timeout. Forced with (24)'s wait — a due claim's task updated without
    // changing a key and then held FOR UPDATE by one open transaction — under a short timeout: the tick gives up while the
    // holder is still open, opens nothing and says so in one warning. Once the holder has ended, the next tick opens the
    // item: the claim's card is a tick late, not lost.
    const w = await world(stack, 'bounded-wait', 'PROJECT_BRANCH');
    const { taskId } = await doneTask(stack, w, 'bounded-wait');
    const job = await claim(stack, w);
    await ageClaim(stack, job.jobId, 26 * MINUTE);
    const holder = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
    await holder.connect();
    const tickDb = prismaClientFor(url);
    const warned: string[] = [];
    let ticking: ReturnType<typeof tickOn> | undefined;
    try {
      await holder.query('BEGIN');
      await holder.query(`UPDATE "task" SET "title" = "title" WHERE "id" = $1::uuid`, [taskId]);
      await holder.query(`SELECT "id" FROM "task" WHERE "id" = $1::uuid FOR UPDATE`, [taskId]);
      const startedAt = Date.now();
      ticking = tickOn(tickDb, SHORT_LOCK_TIMEOUT_MS, warned);
      await untilSettled([ticking.ended], 10_000);
      assert.equal(ticking.ended.settled, true,
        `the tick was still waiting for the task ${Date.now() - startedAt} ms later, with the holder open`);
      const ticked = await ticking.result;
      const tookMs = Date.now() - startedAt;
      assert.equal(ticked.error, null,
        `the tick failed instead of leaving its alarm to the next one: ${(ticked.error as Error | null)?.message}`);
      assert.deepEqual(ticked.value, [], 'a tick that gave up returns no item');
      assert.ok(tookMs >= SHORT_LOCK_TIMEOUT_MS, `it returned after ${tookMs} ms, so it did not wait out its timeout`);
      assert.deepEqual(await leaseItems(stack, w.projectId), [], 'and it opened nothing');
      assert.equal(warned.filter((line) => /alarm left to the next tick/.test(line)).length, 1,
        `it said once that it left the alarm to the next tick: ${JSON.stringify(warned)}`);

      await holder.query('COMMIT');
      const next = await new ProjectOpenItemEscalationService(
        stack.prisma, recordingPush().push as never).openLeaseExpiredItems();
      const items = await leaseItems(stack, w.projectId);
      assert.deepEqual(items.map((item) => [item.integrationJobId, item.taskId, item.state]),
        [[job.jobId, taskId, 'OPEN']], 'the claim is still silent, and the next tick opens its item');
      assert.deepEqual(next.filter((item) => item.projectId === w.projectId).map((item) => item.itemId),
        items.map((item) => item.id), 'and says so');
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      await holder.end().catch(() => undefined);
      await ticking?.result;
      await tickDb.$disconnect().catch(() => undefined);
    }
  });

  await t.test('(26) a tick cut at its lock timeout does not open a card the owner closed meanwhile a second time', async () => {
    // What the bound is for. A statement that waits keeps the snapshot it started with, and its NOT EXISTS reads that
    // snapshot, so a card another replica opened after it, and the owner closed during the wait, is not seen; the partial
    // unique index covers OPEN items only, so a tick that waited that out went on, opened the same key a second time, and
    // its caller pushed it again. Replayed here with two silent claims of one project. One open transaction holds the
    // second claim's task as (24) does, and tick A waits there in its CTE with both claims due in its snapshot. The second
    // claim then reports — A holds no job while it waits — so for tick B, another replica's, only the first claim is due,
    // and B opens its card without touching what A waits for. The owner closes that card by hand, and the holder ends. A
    // gave up at its timeout before any of that, so nothing of it goes on, and a later tick sees the closed card: one row,
    // ever, under the first claim's key.
    const w = await world(stack, 'one-card-ever', 'PROJECT_BRANCH');
    await doneTask(stack, w, 'one-card-ever');
    const first = await claim(stack, w);
    await ageClaim(stack, first.jobId, 26 * MINUTE);
    const firstKey = leaseExpiredDedupeKey(first.jobId, first.claimGeneration);
    const { taskId: secondTask, sessionId: secondSession } = await bareWork(stack, w, 'one-card-ever-second');
    const second = await rawRunningJob(stack, w, {
      label: 'one-card-ever-second', kind: 'LAND_TASK', claimedAtMsAgo: 40 * MINUTE, heartbeatMsAgo: 30 * MINUTE,
      targetRef: w.upstreamRef, taskId: secondTask, sessionId: secondSession,
    });
    const holder = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
    const reporter = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
    await holder.connect();
    await reporter.connect();
    // An alarm that does not give up may hold the second job through its wait; the report then gives up rather than
    // hanging this file.
    await reporter.query(`SET lock_timeout = '10s'`);
    const aDb = prismaClientFor(url);
    const warned: string[] = [];
    const running: Array<Promise<unknown>> = [];
    try {
      await holder.query('BEGIN');
      await holder.query(`UPDATE "task" SET "title" = "title" WHERE "id" = $1::uuid`, [secondTask]);
      await holder.query(`SELECT "id" FROM "task" WHERE "id" = $1::uuid FOR UPDATE`, [secondTask]);
      const tickA = tickOn(aDb, SHORT_LOCK_TIMEOUT_MS, warned);
      running.push(tickA.result);
      const waiting = await untilLockWaits(sql, 1, [tickA.ended]);
      assert.ok(tickA.ended.settled || waiting.some((query) => TICK_STATEMENT.test(query)),
        `tick A neither waited for the second claim's task nor ended: ${JSON.stringify(waiting)}`);
      await untilSettled([tickA.ended], 10_000);
      const aEndedWhileHeld = tickA.ended.settled;

      // The second claim talks again, committed.
      await reporter.query(`UPDATE "project_integration_job" SET "heartbeat_at" = now() WHERE "id" = $1::uuid`, [second]);
      // Tick B: only the first claim is due for it, and it opens that claim's card.
      const tickB = started(new ProjectOpenItemEscalationService(
        stack.prisma, recordingPush().push as never).openLeaseExpiredItems());
      running.push(tickB.result);
      await untilSettled([tickB.ended], 10_000);
      assert.equal(tickB.ended.settled, true, 'tick B did not end while tick A’s holder was open');
      const b = await tickB.result;
      assert.equal(b.error, null, `tick B failed: ${(b.error as Error | null)?.message}`);
      const [card] = (b.value ?? []).filter((item) => item.projectId === w.projectId);
      assert.ok(card, 'tick B opened the first claim’s card');
      await stack.openItems.resolveOpenItem(
        w.ownerId, w.projectId, card.itemId, { note: 'I restarted the runner by hand' }, { kind: 'OWNER' });

      await holder.query('COMMIT');
      const a = await tickA.result;
      const later = await new ProjectOpenItemEscalationService(
        stack.prisma, recordingPush().push as never).openLeaseExpiredItems();

      const rows = await stack.db.projectOpenItem.findMany({
        where: { projectId: w.projectId, dedupeKey: firstKey },
        select: { id: true, state: true, resolution: true, resolvedBy: true },
      });
      assert.deepEqual(rows.map((row) => [row.id, row.state, row.resolution, row.resolvedBy]),
        [[card.itemId, 'RESOLVED', 'HANDLED', 'USER']],
        'one row, ever, under the first claim’s key: the card tick B opened and the owner closed');
      assert.equal(a.error, null, `tick A failed: ${(a.error as Error | null)?.message}`);
      assert.deepEqual((a.value ?? []).filter((item) => item.projectId === w.projectId), [], 'tick A opened nothing');
      assert.equal(aEndedWhileHeld, true, 'tick A was still waiting long after its lock timeout');
      assert.equal(warned.filter((line) => /alarm left to the next tick/.test(line)).length, 1,
        `tick A said once that it left the alarm to the next tick: ${JSON.stringify(warned)}`);
      assert.deepEqual(later.filter((item) => item.projectId === w.projectId), [],
        'a later tick opened nothing: the first claim’s card is closed and the second claim is talking');
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      await holder.end().catch(() => undefined);
      await reporter.end().catch(() => undefined);
      await Promise.all(running);
      await aDb.$disconnect().catch(() => undefined);
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
