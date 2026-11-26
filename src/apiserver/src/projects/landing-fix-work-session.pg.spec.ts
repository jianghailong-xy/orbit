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
import { RunStatus as SharedRunStatus, type IntegrationJobCommand } from '@orbit/shared';
import { Client } from 'pg';

import { seedPromotionRequest } from '../test-support/promotion-request';
import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import type { PushService } from '../push/push.service';
import type { QueueService } from '../queue/queue.service';
import type { RealtimeService } from '../realtime/realtime.service';
import { applyIntegrationJobResult, dispatchIntegrationJobs } from '../runner-api/integration-job-relay';
import { RunnerApiController } from '../runner-api/runner-api.controller';
import { SessionsService } from '../sessions/sessions.service';
import { TaskOwnerConfirmationService } from '../tasks/task-owner-confirmation.service';
import { TasksService } from '../tasks/tasks.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from './coordinator-pg-test-safety';
import { canonicalRepoUrl } from './project-integration-line';
import { queueLandingRetry } from './project-integration-job';
import { ProjectOpenItemService } from './project-open-item.service';
import { ProjectPromotionService } from './project-promotion.service';
import { withWord, WORD_SELECT } from '../test-support/session-word';

/**
 * A landing failure goes first to the task's own work session (`docs/project-integration-line-contract.md`
 * §12.3, §12.4, W4, W5, W9, W-T1, W-T6; revision 42 part one, ruling R1).
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/projects/landing-fix-work-session.pg.spec.ts
 *
 * Every job below is queued by the product (the owner's Confirm writes DONE, which queues the landing or
 * the MAIN line's candidate check), claimed off a runner's heartbeat and answered through the J-T7 result
 * transaction (`applyIntegrationJobResult`); then the item is delivered the way the result route delivers
 * it after the commit (`deliverForItems`), and once more by the coordinator's backstop (`deliverOwed`).
 * The new columns are read with SQL, so this file compiles against a tree without them and fails there on
 * its assertions.
 *
 *  W-T1 — handed to the work session: `work_session_id` and `work_session_offered_at` written, no
 *  `escalate_at`, no delivery to the coordinator. One case per handed-off result: a task landing's
 *  CONFLICT in REBASE, MERGE and MAIN_SYNC, its CHECK_FAILED, and the CONFLICT and CHECK_FAILED of a MAIN
 *  line's TASK_BRANCH candidate (its check, and its landing). A work session still open is handed it too.
 *  W9: `open_item_resolve` and `integration_retry` refuse it with 409 OPEN_ITEM_WITH_WORK_SESSION.
 *
 *  Every work session ends as production ends it: parked on its branch when the DONE is written, the DONE
 *  asks for its end (`claimParkedSessionEnd`, which leaves `cancel_requested_at` beside
 *  `end_reason = 'task_done'`), and the runner's finalize writes the finish that queues the landing. That
 *  `cancel_requested_at` is the platform's own end of a done task's idle session, which W4 admits.
 *
 *  W-T6 — to the coordinator exactly as before (delivered, escalation time set, no work-session columns):
 *  one case per W4 condition negated (a session in Trash, an open one a person asked to end, one a person
 *  ended before its task's DONE, one a person ended after, a task whose newest work session is another, a
 *  task no longer DONE, and a segment whose work session already asked for two generations), and one per
 *  result that is not handed off (BASELINE_RED, CHECK_TIMED_OUT, ERROR, a PROJECT_BRANCH promotion's
 *  failure).
 *
 *  R1 — a CONFLICT retry row, with the work session as its requester, inserts under the widened
 *  `project_integration_job_retry_failure_class_chk`.
 *
 * Not destructive: every case owns freshly generated ids and reads only its own rows.
 */
const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

const CAPABILITIES = ['integration-job/v1', 'integration-observe/v1'];
const sha = (nibble: string) => nibble.repeat(40);
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);
const UPSTREAM = sha('9');

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
  api: RunnerApiController;
  confirmations: TaskOwnerConfirmationService;
  openItems: ProjectOpenItemService;
  promotions: ProjectPromotionService;
}

async function connect(): Promise<Stack> {
  await verifyDisposableDatabase();
  const db = prismaClientFor(URL!);
  const prisma = db as unknown as PrismaService;
  const realtime = new Proxy({}, { get: () => () => undefined }) as unknown as RealtimeService;
  const queue = { notifySessionQueued: () => undefined } as unknown as QueueService;
  const sessions = new SessionsService(prisma, queue, realtime);
  const push = new Proxy({}, { get: () => () => Promise.resolve() }) as unknown as PushService;
  const openItems = new ProjectOpenItemService(prisma, sessions, push);
  const tasks = new TasksService(prisma, sessions, realtime, undefined, undefined, undefined, openItems);
  // The runner's door, for the finalize that writes a work session's finish.
  const api = new RunnerApiController(
    prisma, queue, realtime, push,
    {} as never,
    { expand: async (_ownerId: string, content?: string) => content } as never,
    { appendFor: async (_tx: unknown, _sessionId: string, content?: string) => content } as never,
    undefined,
    undefined,
    tasks,
    undefined,
    sessions,
    openItems,
  );
  return {
    db,
    prisma,
    sessions,
    api,
    confirmations: new TaskOwnerConfirmationService(prisma, sessions, tasks, realtime),
    openItems,
    promotions: new ProjectPromotionService(prisma),
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

/** One owner, the runner the work runs on, a live coordinator conversation, and a project on `line`. */
async function world(stack: Stack, label: string, line: Line): Promise<World> {
  const db = stack.db;
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const coordinatorSessionId = randomUUID();
  const repoUrl = `https://git.invalid/orbit/${label}-${projectId.slice(0, 8)}.git`;
  await db.user.create({
    data: { id: ownerId, email: `${label}-${ownerId}@landing-fix.invalid`, name: label, passwordHash: 'x' },
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
  return { ownerId, runnerId, workspaceId, projectId, coordinatorSessionId };
}

interface Finished {
  taskId: string;
  sessionId: string;
}

/** A code task whose work session is parked on its branch (AWAITING_INPUT), its task still IN_PROGRESS. */
async function parkedTask(stack: Stack, w: World, label: string): Promise<Finished> {
  const { id: taskId } = await stack.db.task.create({
    data: {
      ownerId: w.ownerId, creatorType: 'USER', creatorId: w.ownerId, title: label, projectId: w.projectId,
      assigneeId: w.workspaceId, status: TaskStatus.IN_PROGRESS, completionCriterion: 'OWNER_CONFIRMED',
    },
    select: { id: true },
  });
  const sessionId = randomUUID();
  await stack.db.session.create({
    data: {
      id: sessionId, ownerId: w.ownerId, creatorId: w.ownerId, taskId, workspaceId: w.workspaceId,
      assignedRunnerId: w.runnerId, title: `work ${label}`, prompt: 'work', provider: 'claude',
      turnState: null, dispatchOrigin: SessionDispatchOrigin.USER, startsTaskWork: true,
      isolationStatus: 'worktree', branch: `orbit/${label}`, branchSha: sha('a'), baseSha: sha('b'), numTurns: 1,
      startedAt: minutesAgo(30), createdAt: minutesAgo(30), runtimeSessionId: randomUUID(),
      changedFiles: [{ path: 'src/a.ts', status: 'M', additions: 1, deletions: 0 }] as Prisma.InputJsonValue,
    },
  });
  return { taskId, sessionId };
}

/** The owner's Confirm, which writes the task DONE. */
async function confirm(stack: Stack, w: World, t: Finished): Promise<void> {
  const receipt = await stack.confirmations.decide(
    w.ownerId, t.taskId, { door: 'USER', userId: w.ownerId }, { decision: 'CONFIRM' } as never,
  );
  assert.equal(receipt.completed, true, 'CONTROL: the confirmation wrote DONE');
}

/** The runner's finalize of the session, on the commit its work ended on. */
async function finalize(stack: Stack, w: World, t: Finished, label: string): Promise<void> {
  await stack.api.finalize({ id: w.runnerId } as never, t.sessionId, {
    status: SharedRunStatus.SUCCEEDED, isolationStatus: 'worktree', branch: `orbit/${label}`, branchSha: sha('a'),
    baseSha: sha('b'),
  } as never);
}

async function endingOf(stack: Stack, sessionId: string) {
  return withWord(await stack.db.session.findUniqueOrThrow({
    where: { id: sessionId }, select: { ...WORD_SELECT, finishedAt: true, endReason: true, cancelRequestedAt: true },
  }), 'finishedAt', 'endReason');
}

/**
 * A code task written DONE by the owner's Confirm over its parked work session, which then ends the way
 * production ends it: the DONE asks for the end of its idle work session (`claimParkedSessionEnd`, which
 * leaves `cancel_requested_at` and `end_reason = 'task_done'` on the row), and the runner's finalize writes
 * the finish, which queues the landing (PROJECT_BRANCH) or its candidate's check (MAIN).
 */
async function finishedTask(stack: Stack, w: World, label: string): Promise<Finished> {
  const t = await parkedTask(stack, w, label);
  await confirm(stack, w, t);
  const asked = await endingOf(stack, t.sessionId);
  assert.ok(asked.cancelRequestedAt, 'CONTROL: the DONE asked for the end of its idle work session');
  assert.equal(asked.endReason, 'task_done');
  await finalize(stack, w, t, label);
  const ended = await endingOf(stack, t.sessionId);
  assert.ok(ended.finishedAt && ended.cancelRequestedAt, 'CONTROL: the finish kept the end the DONE asked for');
  assert.equal(ended.endReason, 'task_done');
  return t;
}

/** The command one beat of the runner hands out for this task's (or this project's) job of `kind`. */
async function claim(stack: Stack, w: World, kind: string): Promise<IntegrationJobCommand> {
  const handed = await dispatchIntegrationJobs(stack.prisma, {
    runnerId: w.runnerId, leaseOwner: randomUUID(), draining: false, capabilities: CAPABILITIES,
  });
  const command = handed.find((candidate) => candidate.kind === kind);
  assert.ok(command, `CONTROL: the runner was handed a ${kind} — it got ${JSON.stringify(handed.map((c) => c.kind))}`);
  return command;
}

/** The runner's result, through the J-T7 transaction, then delivered as the result route delivers it. */
async function report(stack: Stack, w: World, command: IntegrationJobCommand, body: object): Promise<string> {
  const applied = await applyIntegrationJobResult(stack.prisma, {
    jobId: command.jobId, runnerId: w.runnerId, ownerId: w.ownerId,
    body: { claimGeneration: command.claimGeneration, leaseOwner: command.leaseOwner, ...body } as never,
  });
  assert.equal(applied.answer.accepted, true, 'CONTROL: the result was taken');
  if (applied.after) await stack.openItems.deliverForItems(applied.after.openItemIds);
  // And the backstop a coordinator's turn end runs (X-D4 3): nothing else may hand it over either.
  await stack.openItems.deliverOwed(w.projectId);
  return command.jobId;
}

interface ItemRow {
  id: string;
  kind: string;
  state: string;
  assignee: string;
  escalate_at: Date | null;
  work_session_id: string | null;
  work_session_offered_at: Date | null;
  work_session_returned_at: Date | null;
  work_session_return_reason: string | null;
  deliveries: number;
}

/** The one item the job opened, with its work-session columns and its deliveries to the coordinator. */
async function itemOf(stack: Stack, w: World, jobId: string): Promise<ItemRow> {
  const rows = await stack.db.$queryRaw<ItemRow[]>(Prisma.sql`
    SELECT i."id", i."kind", i."state", i."assignee", i."escalate_at",
           to_jsonb(i)->>'work_session_id' AS "work_session_id",
           (to_jsonb(i)->>'work_session_offered_at')::timestamptz AS "work_session_offered_at",
           (to_jsonb(i)->>'work_session_returned_at')::timestamptz AS "work_session_returned_at",
           to_jsonb(i)->>'work_session_return_reason' AS "work_session_return_reason",
           (SELECT count(*)::int FROM "project_open_item_delivery" d
             WHERE d."item_id" = i."id" AND d."purpose" = 'ITEM'
               AND d."session_id" = ${w.coordinatorSessionId}::uuid) AS "deliveries"
      FROM "project_open_item" i
     WHERE i."integration_job_id" = ${jobId}::uuid
       AND i."kind" IN ('INTEGRATION_CONFLICT', 'INTEGRATION_CHECK_FAILED', 'INTEGRATION_ERROR')`);
  assert.equal(rows.length, 1, `the job opened ${rows.length} failure items`);
  return rows[0]!;
}

/** W-T1: in the work session's hands — and nobody else's. */
function assertHandedToWorkSession(item: ItemRow, sessionId: string, what: string): void {
  assert.equal(item.state, 'OPEN', `${what}: the item is open`);
  assert.equal(item.work_session_id, sessionId, `${what}: the item was not handed to the task's work session`);
  assert.ok(item.work_session_offered_at, `${what}: no offered time`);
  assert.equal(item.work_session_returned_at, null);
  assert.equal(item.work_session_return_reason, null);
  assert.equal(item.escalate_at, null, `${what}: an item the work session holds has no escalation time`);
  assert.equal(item.deliveries, 0, `${what}: the item was delivered to the coordinator`);
  assert.equal(item.assignee, 'COORDINATOR', `${what}: the assignee is unchanged (§12.4)`);
}

/** W-T6: today's path, unchanged. */
function assertCoordinatorsAsToday(item: ItemRow, what: string): void {
  assert.equal(item.state, 'OPEN', `${what}: the item is open`);
  assert.equal(item.work_session_id, null, `${what}: the item was handed to a work session`);
  assert.equal(item.work_session_offered_at, null);
  assert.equal(item.assignee, 'COORDINATOR');
  assert.ok(item.escalate_at, `${what}: the coordinator's item has no escalation time`);
  assert.equal(item.deliveries, 1, `${what}: the item was not delivered to the coordinator`);
}

const conflict = (phase: 'REBASE' | 'MERGE' | 'MAIN_SYNC') => ({
  state: 'CONFLICT', phase, sourceSha: sha('a'), targetShaBefore: sha('c'), upstreamSha: UPSTREAM,
  conflicts: ['src/a.ts'],
});

const redCheck = (overrides: Record<string, unknown> = {}) => ({
  state: 'CHECK_FAILED', phase: 'CHECK', sourceSha: sha('a'), targetShaBefore: sha('c'), upstreamSha: UPSTREAM,
  testedSha: sha('d'), testedTreeSha: sha('e'),
  checks: [{
    name: 'LANDING_CHECK', command: 'npm test', expectedExitCode: 0, exitCode: 1, timedOut: false,
    durationMs: 1_000, outputTail: 'not ok 1 - the work broke it',
  }],
  ...overrides,
});

/** A task landing on a project branch, claimed and answered with `body`. */
async function landing(stack: Stack, label: string, body: object,
  before?: (w: World, t: Finished) => Promise<void>) {
  const w = await world(stack, label, 'PROJECT_BRANCH');
  const t = await finishedTask(stack, w, label);
  const command = await claim(stack, w, 'LAND_TASK');
  if (before) await before(w, t);
  const jobId = await report(stack, w, command, body);
  return { w, t, jobId, item: await itemOf(stack, w, jobId) };
}

// ─── W-T1: the results that are handed off ────────────────────────────────────────────────────────

for (const phase of ['REBASE', 'MERGE', 'MAIN_SYNC'] as const) {
  test(`W-T1: a task landing's CONFLICT in ${phase} opens its item in the work session's hands`, { skip }, async () => {
    const stack = await connect();
    try {
      const { t, item } = await landing(stack, `conflict-${phase.toLowerCase()}`, conflict(phase));
      assert.equal(item.kind, 'INTEGRATION_CONFLICT');
      assertHandedToWorkSession(item, t.sessionId, `CONFLICT ${phase}`);
    } finally {
      await stack.db.$disconnect();
    }
  });
}

test('W-T1: a task landing\'s CHECK_FAILED of its own making is handed off, and W9 refuses resolve and retry',
  { skip }, async () => {
    const stack = await connect();
    try {
      const { w, t, item } = await landing(stack, 'check-failed', redCheck());
      assert.equal(item.kind, 'INTEGRATION_CHECK_FAILED');
      assertHandedToWorkSession(item, t.sessionId, 'CHECK_FAILED');

      // W9: the coordinator's two doors refuse it while the work session holds it, and so do the owner's.
      const refusal = async (attempt: Promise<unknown>): Promise<unknown> => {
        try {
          await attempt;
        } catch (error) {
          return (error as { getResponse?: () => unknown }).getResponse?.();
        }
        return 'accepted';
      };
      const byCoordinator = { kind: 'SESSION', sessionId: w.coordinatorSessionId } as const;
      for (const [door, attempt] of [
        ['open_item_resolve', () => stack.openItems.resolveOpenItem(w.ownerId, w.projectId, item.id, { note: 'done by hand' }, byCoordinator)],
        ['the owner\'s resolve', () => stack.openItems.resolveOpenItem(w.ownerId, w.projectId, item.id, { note: 'done by hand' }, { kind: 'OWNER' })],
        ['integration_retry', () => stack.openItems.retryIntegration(w.ownerId, w.projectId, t.taskId, { reason: 'try again' }, w.coordinatorSessionId)],
        ['the owner\'s retry', () => stack.openItems.retryIntegrationAsOwner(w.ownerId, w.projectId, t.taskId, { reason: 'try again' })],
      ] as const) {
        const answer = await refusal(attempt());
        assert.equal((answer as { code?: string })?.code, 'OPEN_ITEM_WITH_WORK_SESSION',
          `${door} was not refused OPEN_ITEM_WITH_WORK_SESSION: ${JSON.stringify(answer)}`);
        assert.match((answer as { message: string }).message, /work session/);
      }
      assert.equal((await stack.db.projectOpenItem.findUniqueOrThrow({ where: { id: item.id } })).state, 'OPEN',
        'the refused doors wrote nothing');
      assert.equal(await stack.db.projectIntegrationJob.count({ where: { taskId: t.taskId } }), 1, 'no rerun was queued');

      // W9's second door: "Chat about this" stays — it is not in the door table (§4.7: it writes nothing),
      // and the project's open-items read still offers it for the item, toward the coordinator, while no
      // press (no door of the coordinator's or the owner's) is drawn on the card.
      // §12.7: it is read under "Being fixed by its session", and in neither of the other two groups.
      const read = await stack.openItems.list(w.ownerId, w.projectId);
      const row = read.withWorkSession.find((candidate) => candidate.itemId === item.id);
      assert.ok(row, 'the item in the work session\'s hands is still read');
      assert.equal([...read.needsYou, ...read.withCoordinator].some((candidate) => candidate.itemId === item.id), false,
        'the item in the work session\'s hands is listed in a group that waits on somebody');
      assert.deepEqual(row.chat, { sessionId: w.coordinatorSessionId, stage: 'WITH_COORDINATOR', refusal: null },
        'Chat about this is not offered for the item in the work session\'s hands');
      assert.deepEqual(row.actions, [], 'the card draws a press the item in the work session\'s hands refuses');
    } finally {
      await stack.db.$disconnect();
    }
  });

test('W-T1: a work session that is still open is handed the failure too (W4 condition 2)', { skip }, async () => {
  const stack = await connect();
  try {
    const { t, item } = await landing(stack, 'open-session', conflict('MERGE'), async (w, t) => {
      // Revived by its owner's message and live when the result comes in: open, not ended. The revive
      // (`SessionsService.resume`) clears the end its task's DONE asked for, `cancel_requested_at` with it.
      await stack.sessions.resume(w.ownerId, t.sessionId, { clientTurnId: randomUUID(), content: 'one more thing' });
      const revived = await endingOf(stack, t.sessionId);
      assert.deepEqual(
        { finishedAt: revived.finishedAt, endReason: revived.endReason, cancelRequestedAt: revived.cancelRequestedAt },
        { finishedAt: null, endReason: null, cancelRequestedAt: null },
        'CONTROL: the revive left an end on the session',
      );
    });
    assertHandedToWorkSession(item, t.sessionId, 'an open work session');
  } finally {
    await stack.db.$disconnect();
  }
});

/** A MAIN line's TASK_BRANCH candidate check, claimed and answered with `body`. */
async function candidateCheck(stack: Stack, label: string, body: object) {
  const w = await world(stack, label, 'MAIN');
  const t = await finishedTask(stack, w, label);
  const command = await claim(stack, w, 'CHECK_PROMOTION');
  assert.equal(command.promotionSourceKind, 'TASK_BRANCH', 'CONTROL: the candidate is the task branch');
  const jobId = await report(stack, w, command, body);
  return { w, t, jobId, item: await itemOf(stack, w, jobId) };
}

test('W-T1: a MAIN line\'s TASK_BRANCH candidate check that conflicts is handed to the task\'s work session',
  { skip }, async () => {
    const stack = await connect();
    try {
      const { t, item } = await candidateCheck(stack, 'main-conflict', conflict('MERGE'));
      assert.equal(item.kind, 'INTEGRATION_CONFLICT');
      assertHandedToWorkSession(item, t.sessionId, 'MAIN-line candidate CONFLICT');
    } finally {
      await stack.db.$disconnect();
    }
  });

test('W-T1: a MAIN line\'s TASK_BRANCH candidate check that goes red is handed to the task\'s work session',
  { skip }, async () => {
    const stack = await connect();
    try {
      const { w, t, item } = await candidateCheck(stack, 'main-red', redCheck());
      assert.equal(item.kind, 'INTEGRATION_CHECK_FAILED');
      assertHandedToWorkSession(item, t.sessionId, 'MAIN-line candidate CHECK_FAILED');
      // W9 for a candidate: the coordinator's re-check refuses it too.
      const promotion = await stack.db.projectPromotion.findFirstOrThrow({ where: { taskId: t.taskId } });
      await assert.rejects(
        stack.openItems.retryPromotionCheck(w.ownerId, w.projectId, promotion.id, { reason: 'try again' }, w.coordinatorSessionId),
        (error: { getResponse?: () => { code?: string } }) => error.getResponse?.()?.code === 'OPEN_ITEM_WITH_WORK_SESSION',
      );
    } finally {
      await stack.db.$disconnect();
    }
  });

test('W-T1: a MAIN line\'s TASK_BRANCH candidate whose landing conflicts is handed to the task\'s work session',
  { skip }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'main-land', 'MAIN');
      const t = await finishedTask(stack, w, 'main-land');
      const check = await claim(stack, w, 'CHECK_PROMOTION');
      await report(stack, w, check, {
        state: 'READY', phase: 'CHECK', sourceSha: sha('a'), upstreamSha: UPSTREAM, targetShaBefore: UPSTREAM,
        testedSha: sha('7'), testedTreeSha: sha('6'), aheadOfUpstream: 1, filesChanged: 1, checks: [], conflicts: [],
      });
      const promotion = await stack.db.projectPromotion.findFirstOrThrow({ where: { taskId: t.taskId } });
      await stack.promotions.confirm({ userId: w.ownerId }, w.projectId, promotion.id, sha('a'));
      const land = await claim(stack, w, 'LAND_PROMOTION');
      const jobId = await report(stack, w, land, conflict('MERGE'));
      assertHandedToWorkSession(await itemOf(stack, w, jobId), t.sessionId, 'MAIN-line candidate landing CONFLICT');
    } finally {
      await stack.db.$disconnect();
    }
  });

// ─── W4 condition 1 and the DONE's own end of its idle work session ──────────────────────────────

test('W-T1: a work session its DONE ended through the parked-session end (cancel_requested_at beside task_done) is '
  + 'handed its conflict, and the landing-fix turn revives it', { skip }, async () => {
  const stack = await connect();
  try {
    const w = await world(stack, 'parked-end', 'PROJECT_BRANCH');
    const t = await finishedTask(stack, w, 'parked-end');
    const command = await claim(stack, w, 'LAND_TASK');
    const before = await endingOf(stack, t.sessionId);
    assert.ok(before.finishedAt, 'CONTROL: the session had finished when its landing failed');
    assert.ok(before.cancelRequestedAt, 'CONTROL: the parked-session end left cancel_requested_at');
    assert.equal(before.endReason, 'task_done');

    const jobId = await report(stack, w, command, conflict('MERGE'));
    const item = await itemOf(stack, w, jobId);
    assert.equal(item.kind, 'INTEGRATION_CONFLICT');
    assertHandedToWorkSession(item, t.sessionId, 'a session its DONE ended');

    // W6: the landing-fix turn was delivered to it, through the revive, which clears its end.
    const turns = await stack.db.conversationTurn.findMany({
      where: { sessionId: t.sessionId, clientTurnId: { startsWith: 'landing-fix:v1:' } },
      select: { status: true },
    });
    assert.equal(turns.length, 1, 'the landing-fix turn was not written to the work session');
    assert.equal(turns[0]!.status, 'PENDING');
    const revived = await endingOf(stack, t.sessionId);
    assert.deepEqual(revived, { status: RunStatus.PENDING, finishedAt: null, endReason: null, cancelRequestedAt: null },
      'the landing-fix turn did not revive the session');
  } finally {
    await stack.db.$disconnect();
  }
});

test('W-T6: a work session a person ended before its task\'s DONE (cancel_requested_at beside end_reason ended) '
  + 'leaves its conflict to the coordinator as today', { skip }, async () => {
  const stack = await connect();
  try {
    const w = await world(stack, 'person-ended', 'PROJECT_BRANCH');
    const t = await parkedTask(stack, w, 'person-ended');
    // The owner ends the parked session, the runner drains it, and only then does the owner confirm.
    await stack.sessions.end(w.ownerId, t.sessionId);
    await finalize(stack, w, t, 'person-ended');
    await confirm(stack, w, t);
    const ended = await endingOf(stack, t.sessionId);
    assert.ok(ended.finishedAt && ended.cancelRequestedAt, 'CONTROL: the person\'s end left cancel_requested_at');
    assert.equal(ended.endReason, 'ended');

    const command = await claim(stack, w, 'LAND_TASK');
    const jobId = await report(stack, w, command, conflict('MERGE'));
    assertCoordinatorsAsToday(await itemOf(stack, w, jobId), 'a session a person ended');
    assert.equal(
      await stack.db.conversationTurn.count({
        where: { sessionId: t.sessionId, clientTurnId: { startsWith: 'landing-fix:v1:' } },
      }), 0, 'the person-ended session was handed a landing-fix turn');
    assert.ok((await endingOf(stack, t.sessionId)).finishedAt, 'the person-ended session was revived');
  } finally {
    await stack.db.$disconnect();
  }
});

// ─── W-T6: one W4 condition negated at a time ────────────────────────────────────────────────────

const negated: Array<[string, (stack: Stack, w: World, t: Finished) => Promise<void>]> = [
  ['1: the work session is in Trash', async (stack, _w, t) => {
    await stack.db.session.update({ where: { id: t.sessionId }, data: { deletedAt: new Date() } });
  }],
  ['1: a person asked to end the work session while it was open (its end not yet drained)', async (stack, _w, t) => {
    // Revived, running, and asked to end by a person: `cancel_requested_at` beside `end_reason = 'ended'`.
    await stack.db.session.update({
      where: { id: t.sessionId },
      data: { turnState: 'IN_FLIGHT', finishedAt: null, endReason: 'ended', cancelRequestedAt: new Date() },
    });
  }],
  ['2: a person ended the work session', async (stack, _w, t) => {
    await stack.db.session.update({ where: { id: t.sessionId }, data: { endReason: 'ended', turnState: null } });
  }],
  ['3: the task\'s newest work session is another one', async (stack, w, t) => {
    await stack.db.session.create({
      data: {
        id: randomUUID(), ownerId: w.ownerId, creatorId: w.ownerId, taskId: t.taskId, workspaceId: w.workspaceId,
        assignedRunnerId: w.runnerId, title: 'a later run', prompt: 'work', provider: 'claude',
        turnState: null, dispatchOrigin: SessionDispatchOrigin.USER, startsTaskWork: true,
        isolationStatus: 'worktree', branch: 'orbit/a-later-run', branchSha: sha('f'), baseSha: sha('b'), numTurns: 1,
        startedAt: new Date(), createdAt: new Date(), runtimeSessionId: randomUUID(), finishedAt: new Date(),
        endReason: 'task_done',
      },
    });
  }],
  ['3: the task is no longer DONE', async (stack, _w, t) => {
    await stack.db.$executeRaw(Prisma.sql`UPDATE "task" SET "status" = 'IN_PROGRESS' WHERE "id" = ${t.taskId}::uuid`);
  }],
];

for (const [condition, negate] of negated) {
  test(`W-T6: W4 condition ${condition} — the item goes to the coordinator as today`, { skip }, async () => {
    const stack = await connect();
    try {
      const { item } = await landing(stack, `negated-${randomUUID().slice(0, 8)}`, conflict('REBASE'),
        (w, t) => negate(stack, w, t));
      assertCoordinatorsAsToday(item, `condition ${condition}`);
    } finally {
      await stack.db.$disconnect();
    }
  });
}

test('W-T6: W4 condition 4 — after two generations asked for by the work session, the next failure is the coordinator\'s; '
  + 'R1: a CONFLICT retry row inserts', { skip }, async () => {
  const stack = await connect();
  try {
    const { w, t, jobId: first, item: firstItem } = await landing(stack, 'rounds', conflict('MERGE'));
    assertHandedToWorkSession(firstItem, t.sessionId, 'the first failure');

    // One round: the work session's next generation, recorded as a retry of the CONFLICT one (R1).
    const rerun = async (ofJobId: string): Promise<string> => {
      // The failure's landing-fix turn revived the work session (W6), and J-T1e holds the next landing
      // until that session's work settles: its fix turn ends and it finishes, task_done again.
      const revived = await stack.db.session.findUniqueOrThrow({ where: { id: t.sessionId }, select: { finishedAt: true } });
      assert.equal(revived.finishedAt, null, 'CONTROL: the landing-fix turn revived the work session');
      // Its DONE's end, as `claimParkedSessionEnd` and the finalize leave it: `cancel_requested_at` too.
      await stack.db.session.update({
        where: { id: t.sessionId },
        data: { turnState: null, finishedAt: new Date(), endReason: 'task_done', cancelRequestedAt: new Date() },
      });
      const queued = await stack.db.$transaction((tx) => queueLandingRetry(tx, {
        ownerId: w.ownerId, projectId: w.projectId, taskId: t.taskId,
        retry: {
          ofJobId, failureClass: 'CONFLICT' as never, reason: 'Fixed by the task\'s own session',
          requestedBySessionId: t.sessionId,
        },
      }));
      assert.ok(queued, 'CONTROL: the next generation was queued');
      const row = await stack.db.projectIntegrationJob.findUniqueOrThrow({
        where: { id: queued.jobId },
        select: { retryFailureClass: true, retryRequestedBySessionId: true, retryOfJobId: true },
      });
      assert.deepEqual(row, { retryFailureClass: 'CONFLICT', retryRequestedBySessionId: t.sessionId, retryOfJobId: ofJobId },
        'R1: the CONFLICT retry row carries its class and the work session as requester');
      const command = await claim(stack, w, 'LAND_TASK');
      assert.equal(command.jobId, queued.jobId);
      return report(stack, w, command, conflict('MERGE'));
    };

    const second = await rerun(first);
    assertHandedToWorkSession(await itemOf(stack, w, second), t.sessionId, 'round 1 of 2 failed again');
    const third = await rerun(second);
    // W8 (W-T4): the rounds are used, so the failure is the coordinator's at once — opened already handed back from
    // the work session, ROUNDS_EXHAUSTED, with its clock running and delivered (landing-fix-hand-back.pg.spec.ts).
    const exhausted = await itemOf(stack, w, third);
    assert.equal(exhausted.state, 'OPEN');
    assert.equal(exhausted.assignee, 'COORDINATOR');
    assert.equal(exhausted.work_session_id, t.sessionId);
    assert.equal(exhausted.work_session_return_reason, 'ROUNDS_EXHAUSTED', 'round 2 of 2 failed: the rounds are used');
    assert.ok(exhausted.work_session_returned_at && exhausted.escalate_at);
    assert.equal(exhausted.deliveries, 1, 'the exhausted failure was not delivered to the coordinator');
  } finally {
    await stack.db.$disconnect();
  }
});

// ─── W-T6: the results that are not handed off ───────────────────────────────────────────────────

test('W-T6: a BASELINE_RED landing goes to the coordinator as today', { skip }, async () => {
  const stack = await connect();
  try {
    const check = redCheck().checks[0]!;
    const { item } = await landing(stack, 'baseline-red', redCheck({
      baselineRed: true,
      mainSyncSha: sha('b'),
      checks: [check, { ...check, scope: 'BASELINE', treeSha: sha('8') }],
    }));
    assert.equal(item.kind, 'INTEGRATION_CHECK_FAILED');
    assertCoordinatorsAsToday(item, 'BASELINE_RED');
  } finally {
    await stack.db.$disconnect();
  }
});

// Task 352ZEtmx7cOXY91yIodUk: the first landing on a line that is not on origin yet measures against main's own
// tip (T0 = U, nothing absorbed). A red main is attributed there now (K3 on T0), and that result stays off the
// task's session: no hand-off, no landing-fix turn, one baseline item keyed on (U, U).
test('W-T6: a BASELINE_RED first landing on a fresh line (T0 = U, no absorb) never reaches the task\'s session',
  { skip }, async () => {
    const stack = await connect();
    try {
      const check = redCheck().checks[0]!;
      const { w, t, jobId, item } = await landing(stack, 'fresh-line-baseline-red', redCheck({
        baselineRed: true,
        targetShaBefore: UPSTREAM,
        checks: [check, { ...check, scope: 'BASELINE', treeSha: sha('8') }],
      }));
      assert.equal(item.kind, 'INTEGRATION_CHECK_FAILED');
      assertCoordinatorsAsToday(item, 'a fresh line\'s BASELINE_RED');
      const [row] = await stack.db.$queryRaw<Array<{ dedupe_key: string; failure_class: string | null; baseline_red: boolean }>>(Prisma.sql`
        SELECT i."dedupe_key", i."payload"->>'failureClass' AS "failure_class", j."baseline_red"
          FROM "project_open_item" i JOIN "project_integration_job" j ON j."id" = i."integration_job_id"
         WHERE i."id" = ${item.id}::uuid`);
      assert.equal(row!.baseline_red, true, 'the job did not record baseline_red');
      assert.equal(row!.failure_class, 'BASELINE_RED');
      assert.ok(row!.dedupe_key.startsWith('ICB:') && row!.dedupe_key.endsWith(`:${UPSTREAM}:${UPSTREAM}`), row!.dedupe_key);
      await stack.openItems.deliverOwed(w.projectId);
      assert.equal(
        await stack.db.conversationTurn.count({
          where: { sessionId: t.sessionId, clientTurnId: { startsWith: 'landing-fix:v1:' } },
        }), 0, 'a baseline-red landing handed the task\'s session a landing-fix turn');
      assert.ok(jobId);
    } finally {
      await stack.db.$disconnect();
    }
  });

test('W-T6: a CHECK_TIMED_OUT landing goes to the coordinator as today', { skip }, async () => {
  const stack = await connect();
  try {
    const { item } = await landing(stack, 'timed-out', redCheck({
      checks: [{ ...redCheck().checks[0]!, exitCode: null, timedOut: true }],
    }));
    assertCoordinatorsAsToday(item, 'CHECK_TIMED_OUT');
  } finally {
    await stack.db.$disconnect();
  }
});

test('W-T6: an ERROR landing goes to the coordinator as today', { skip }, async () => {
  const stack = await connect();
  try {
    const { item } = await landing(stack, 'error', {
      state: 'ERROR', phase: 'PUSH', sourceSha: sha('a'), targetShaBefore: sha('c'),
      errorCode: 'PUSH_REJECTED', errorDetail: { reason: 'the remote refused a non-fast-forward push' },
    });
    assert.equal(item.kind, 'INTEGRATION_ERROR');
    assertCoordinatorsAsToday(item, 'ERROR');
  } finally {
    await stack.db.$disconnect();
  }
});

test('W-T6: a PROJECT_BRANCH promotion\'s conflict goes to the coordinator as today', { skip }, async () => {
  const stack = await connect();
  try {
    const w = await world(stack, 'project-branch-promotion', 'PROJECT_BRANCH');
    await finishedTask(stack, w, 'project-branch-promotion');
    const land = await claim(stack, w, 'LAND_TASK');
    await report(stack, w, land, {
      state: 'LANDED', phase: 'VERIFY', sourceSha: sha('a'), targetShaBefore: UPSTREAM, upstreamSha: UPSTREAM,
      testedSha: sha('c'), testedTreeSha: sha('e'), landedSha: sha('c'), landedTreeSha: sha('e'), aheadOfUpstream: 1,
    });
    await seedPromotionRequest(stack.prisma, w.projectId);
    assert.ok(await stack.promotions.considerCandidate(w.projectId), 'CONTROL: the landing made a candidate');
    const check = await claim(stack, w, 'CHECK_PROMOTION');
    assert.equal(check.promotionSourceKind, 'PROJECT_BRANCH');
    const jobId = await report(stack, w, check, conflict('MERGE'));
    assertCoordinatorsAsToday(await itemOf(stack, w, jobId), 'PROJECT_BRANCH promotion CONFLICT');
  } finally {
    await stack.db.$disconnect();
  }
});

test('the landing-fix PostgreSQL target is explicitly disposable', { skip }, () => {
  assert.doesNotThrow(() => assertCoordinatorPgUrlIsIsolated(URL));
});
