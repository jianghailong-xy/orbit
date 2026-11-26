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
import { MAX_PROMPT_CHARS, RunStatus as SharedRunStatus, type IntegrationJobCommand } from '@orbit/shared';
import { Client } from 'pg';

import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import type { PushService } from '../push/push.service';
import type { QueueService } from '../queue/queue.service';
import type { RealtimeService } from '../realtime/realtime.service';
import {
  applyIntegrationJobResult,
  dispatchIntegrationJobs,
  receiveIntegrationJobOutput,
} from '../runner-api/integration-job-relay';
import { RunnerApiController } from '../runner-api/runner-api.controller';
import { SessionsService } from '../sessions/sessions.service';
import { TaskOwnerConfirmationService } from '../tasks/task-owner-confirmation.service';
import { TasksService } from '../tasks/tasks.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from './coordinator-pg-test-safety';
import { landingFixTurnId } from './landing-fix-turn';
import { canonicalRepoUrl } from './project-integration-line';
import { ProjectOpenItemService } from './project-open-item.service';

/**
 * An offer to a task's own work session never stays held without a delivered turn
 * (docs/project-integration-line-contract.md §12.5 W5–W7).
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/projects/landing-fix-undelivered-offer.pg.spec.ts
 *
 * The incident (2026-11-26, task 354Ej5LbLFQqigNNPHBNU): the task was CONFIRMed, its work session finished
 * (task_done), and its landing ended CHECK_FAILED. The item was opened in the session's hands, but no
 * landing-fix turn was ever written: the red LANDING_CHECK is run once more on the baseline under the same
 * check name, and the turn read every log row of that name — the baseline's whole output came after the
 * failure heading and was taken for failure lines. The message went past MAX_PROMPT_CHARS, the session door
 * refused it with a 400, and that refusal was dropped. Held with no turn, no escalation time and no delivery
 * to the coordinator, every door refused it with OPEN_ITEM_WITH_WORK_SESSION.
 *
 * Every job is queued by the product (the owner's Confirm writes DONE; the runner's finalize writes the
 * finish that queues the landing), claimed off a runner's beat, answered through the J-T7 result
 * transaction, and delivered the way the result route delivers it (`deliverForItems`) and once more by
 * the coordinator's turn-end backstop (`deliverOwed`).
 *
 *  1. The incident: a red check with a long green baseline run. The landing-fix turn is written on the
 *     finished session, and it carries the failed check's own failure lines and none of the baseline's.
 *  2. A delivery the session door refuses with something that is no answer about the session (a 409 that
 *     does not clear: a worktree operation still pending on the session) is handed back to the
 *     coordinator — returned, TURN_FAILED, escalation time set, delivered — and integration_retry is taken.
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
  api: RunnerApiController;
  confirmations: TaskOwnerConfirmationService;
  openItems: ProjectOpenItemService;
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
    db, prisma, api, openItems,
    confirmations: new TaskOwnerConfirmationService(prisma, sessions, tasks, realtime),
  };
}

interface World {
  ownerId: string;
  runnerId: string;
  workspaceId: string;
  projectId: string;
  coordinatorSessionId: string;
}

/** One owner, the runner the work runs on, a live coordinator conversation, and a project branch line. */
async function world(stack: Stack, label: string): Promise<World> {
  const db = stack.db;
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const coordinatorSessionId = randomUUID();
  const repoUrl = `https://git.invalid/orbit/${label}-${projectId.slice(0, 8)}.git`;
  await db.user.create({
    data: { id: ownerId, email: `${label}-${ownerId}@landing-fix-offer.invalid`, name: label, passwordHash: 'x' },
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
      status: RunStatus.AWAITING_INPUT, dispatchOrigin: SessionDispatchOrigin.USER, startsTaskWork: false,
      titleManagedByProject: true, numTurns: 1, startedAt: new Date(), runtimeSessionId: `runtime-${coordinatorSessionId}`,
    },
  });
  await db.project.create({
    data: {
      id: projectId, ownerId, title: `${label} project`, goal: 'a landing failure reaches somebody',
      coordinatorEnabled: true, coordinatorWorkspaceId: workspaceId, coordinatorSessionId,
    },
  });
  await db.projectRuntime.upsert({ where: { projectId }, create: { projectId }, update: {} });
  await db.projectCodebase.create({
    data: {
      ownerId, projectId, canonicalRepoUrl: canonicalRepoUrl(repoUrl)!, upstreamRef: 'refs/heads/main',
      integrationRef: `refs/heads/project/${projectId}`,
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

/**
 * A code task whose work session finishes on its CONFIRM, as production finishes it: parked on its branch, the
 * Confirm writes DONE and asks for the end of the idle session (`cancel_requested_at` beside `task_done`), and
 * the runner's finalize writes the finish, which queues the landing.
 */
async function finishedOnConfirm(stack: Stack, w: World, label: string): Promise<Finished> {
  const { id: taskId } = await stack.db.task.create({
    data: {
      ownerId: w.ownerId, creatorType: 'USER', creatorId: w.ownerId, title: `Make ${label} land`, projectId: w.projectId,
      assigneeId: w.workspaceId, status: TaskStatus.IN_PROGRESS, completionCriterion: 'OWNER_CONFIRMED',
      acceptanceCriteria: 'the work lands',
    },
    select: { id: true },
  });
  const sessionId = randomUUID();
  await stack.db.session.create({
    data: {
      id: sessionId, ownerId: w.ownerId, creatorId: w.ownerId, taskId, workspaceId: w.workspaceId,
      assignedRunnerId: w.runnerId, title: `work ${label}`, prompt: 'work', provider: 'claude',
      status: RunStatus.AWAITING_INPUT, dispatchOrigin: SessionDispatchOrigin.USER, startsTaskWork: true,
      isolationStatus: 'worktree', branch: `orbit/${label}`, branchSha: sha('a'), baseSha: sha('b'), numTurns: 1,
      startedAt: minutesAgo(30), createdAt: minutesAgo(30), runtimeSessionId: randomUUID(),
      changedFiles: [{ path: 'src/a.ts', status: 'M', additions: 1, deletions: 0 }] as Prisma.InputJsonValue,
    },
  });
  const receipt = await stack.confirmations.decide(
    w.ownerId, taskId, { door: 'USER', userId: w.ownerId }, { decision: 'CONFIRM' } as never,
  );
  assert.equal(receipt.completed, true, 'CONTROL: the confirmation wrote DONE');
  await stack.api.finalize({ id: w.runnerId } as never, sessionId, {
    status: SharedRunStatus.SUCCEEDED, isolationStatus: 'worktree', branch: `orbit/${label}`, branchSha: sha('a'),
    baseSha: sha('b'),
  } as never);
  const ended = await stack.db.session.findUniqueOrThrow({
    where: { id: sessionId }, select: { finishedAt: true, endReason: true },
  });
  assert.ok(ended.finishedAt, 'CONTROL: the work session finished on its CONFIRM');
  assert.equal(ended.endReason, 'task_done');
  return { taskId, sessionId };
}

async function claimLanding(stack: Stack, w: World): Promise<IntegrationJobCommand> {
  const handed = await dispatchIntegrationJobs(stack.prisma, {
    runnerId: w.runnerId, leaseOwner: randomUUID(), draining: false, capabilities: CAPABILITIES,
  });
  const command = handed.find((candidate) => candidate.kind === 'LAND_TASK');
  assert.ok(command, `CONTROL: the runner was handed a LAND_TASK — it got ${JSON.stringify(handed.map((c) => c.kind))}`);
  return command;
}

/** One check's output as a v2 runner streams it, chunk by chunk, under its place in the run. */
async function stream(stack: Stack, w: World, command: IntegrationJobCommand, index: number, chunks: string[]) {
  for (const [seq, text] of chunks.entries()) {
    await receiveIntegrationJobOutput(stack.prisma, {
      jobId: command.jobId, runnerId: w.runnerId, ownerId: w.ownerId,
      body: {
        claimGeneration: command.claimGeneration, leaseOwner: command.leaseOwner,
        check: { name: 'LANDING_CHECK', index }, seq, text,
      } as never,
    });
  }
}

/** The runner's CHECK_FAILED through J-T7, delivered as the result route delivers it, then by the backstop. */
async function failAndDeliver(stack: Stack, w: World, command: IntegrationJobCommand): Promise<string> {
  const applied = await applyIntegrationJobResult(stack.prisma, {
    jobId: command.jobId, runnerId: w.runnerId, ownerId: w.ownerId,
    body: {
      claimGeneration: command.claimGeneration, leaseOwner: command.leaseOwner,
      state: 'CHECK_FAILED', phase: 'CHECK', sourceSha: sha('a'), targetShaBefore: sha('c'), upstreamSha: UPSTREAM,
      testedSha: sha('d'), testedTreeSha: sha('e'),
      checks: [
        {
          name: 'LANDING_CHECK', command: 'npm test', expectedExitCode: 0, exitCode: 1, timedOut: false,
          durationMs: 1_000, outputTail: 'the tail the runner kept',
        },
        // K3's attribution: the same check, once more, on the baseline — green, so the red is the work's.
        {
          name: 'LANDING_CHECK', command: 'npm test', expectedExitCode: 0, exitCode: 0, timedOut: false,
          durationMs: 1_000, outputTail: 'the baseline passed', scope: 'BASELINE', treeSha: sha('f'),
        },
      ],
    } as never,
  });
  assert.equal(applied.answer.accepted, true, 'CONTROL: the result was taken');
  const [item] = await stack.db.$queryRaw<Array<{ id: string; work_session_offered_at: Date | null }>>(Prisma.sql`
    SELECT "id", (to_jsonb(i)->>'work_session_offered_at')::timestamptz AS "work_session_offered_at"
      FROM "project_open_item" i
     WHERE i."integration_job_id" = ${command.jobId}::uuid AND i."kind" = 'INTEGRATION_CHECK_FAILED'`);
  assert.ok(item?.work_session_offered_at, 'CONTROL: the CHECK_FAILED was offered to the work session (W-T1)');
  if (applied.after) await stack.openItems.deliverForItems(applied.after.openItemIds);
  await stack.openItems.deliverOwed(w.projectId);
  return item.id;
}

async function fixTurns(stack: Stack, sessionId: string, jobId: string) {
  return stack.db.conversationTurn.findMany({
    where: { sessionId, clientTurnId: landingFixTurnId(jobId) },
    select: { content: true, status: true },
  });
}

async function itemRow(stack: Stack, itemId: string) {
  return stack.db.projectOpenItem.findUniqueOrThrow({
    where: { id: itemId },
    select: {
      state: true, assignee: true, escalateAt: true,
      workSessionOfferedAt: true, workSessionReturnedAt: true, workSessionReturnReason: true,
    },
  });
}

/** What the coordinator's integration_retry answers: 'accepted', or the refusal's code. */
async function retryAnswer(stack: Stack, w: World, t: Finished): Promise<unknown> {
  try {
    await stack.openItems.retryIntegration(w.ownerId, w.projectId, t.taskId, { reason: 'try again' }, w.coordinatorSessionId);
    return 'accepted';
  } catch (error) {
    const body = (error as { getResponse?: () => unknown }).getResponse?.();
    return (body as { code?: string } | undefined)?.code ?? (error as Error).message;
  }
}

/** Within one offer: a landing-fix turn on the session, or the item handed back with a clock and retry open. */
async function assertNotHeldWithoutTurn(stack: Stack, w: World, t: Finished, jobId: string, itemId: string) {
  const turns = await fixTurns(stack, t.sessionId, jobId);
  if (turns.length === 1) return;
  const item = await itemRow(stack, itemId);
  assert.ok(item.workSessionReturnedAt,
    `the item is held in the work session's hands with no landing-fix turn written: ${JSON.stringify(item)}`);
  assert.equal(item.assignee, 'COORDINATOR');
  assert.ok(item.escalateAt, 'the handed-back item has no escalation time');
  assert.equal(await retryAnswer(stack, w, t), 'accepted', 'integration_retry was refused');
}

test('an offer to a session that finished on its CONFIRM, for a red check with a long green baseline run, '
  + 'writes the landing-fix turn with the failed check\'s own failure lines', { skip, timeout: 180_000 }, async () => {
  const stack = await connect();
  try {
    const w = await world(stack, 'baseline-output');
    const t = await finishedOnConfirm(stack, w, 'baseline-output');
    const command = await claimLanding(stack, w);
    // Check 1, the combined tree: its output, then the failure section `addFailureLines` uploads.
    await stream(stack, w, command, 1, [
      'npm test\n> vitest run\n',
      '\nFailure lines from the whole output:\n × src/a.test.ts > the work broke it 12ms',
    ]);
    // Check 2, the baseline run of the same LANDING_CHECK: green, and long — together over a turn's limit.
    const line = ' ✓ src/b.test.ts (3 tests) 9ms\n';
    const chunk = line.repeat(Math.ceil(16_000 / line.length));
    const baseline = [chunk, chunk, chunk, chunk];
    assert.ok(baseline.join('').length > MAX_PROMPT_CHARS, 'CONTROL: the baseline output alone is over the limit');
    await stream(stack, w, command, 2, baseline);

    const itemId = await failAndDeliver(stack, w, command);

    const turns = await fixTurns(stack, t.sessionId, command.jobId);
    assert.equal(turns.length, 1, 'no landing-fix turn was written to the work session that finished on its CONFIRM');
    assert.match(turns[0]!.content ?? '', /× src\/a\.test\.ts > the work broke it 12ms/);
    assert.doesNotMatch(turns[0]!.content ?? '', /src\/b\.test\.ts/, 'the baseline run\'s output was taken for failure lines');
    await assertNotHeldWithoutTurn(stack, w, t, command.jobId, itemId);
  } finally {
    await stack.db.$disconnect();
  }
});

test('an offer the session door refuses with no answer about the session is handed back to the coordinator, '
  + 'and integration_retry is taken', { skip, timeout: 180_000 }, async () => {
  const stack = await connect();
  try {
    const w = await world(stack, 'refused-offer');
    const t = await finishedOnConfirm(stack, w, 'refused-offer');
    const command = await claimLanding(stack, w);
    await stream(stack, w, command, 1, ['npm test\n', '\nFailure lines from the whole output:\n × the work broke it']);
    // A commit of the checkout still pending on the session: its revive answers 409 "wait for the pending
    // worktree operation to finish", which is no answer about the session and does not clear by itself.
    await stack.db.session.update({
      where: { id: t.sessionId },
      data: {
        commitStatus: 'pending', commitOperationId: randomUUID(), commitOperationOwner: randomUUID(),
        commitRequestedAt: new Date(),
      },
    });

    const itemId = await failAndDeliver(stack, w, command);

    assert.equal((await fixTurns(stack, t.sessionId, command.jobId)).length, 0, 'CONTROL: the turn was refused');
    const item = await itemRow(stack, itemId);
    assert.equal(item.state, 'OPEN');
    assert.ok(item.workSessionOfferedAt, 'CONTROL: it was offered to the work session');
    assert.ok(item.workSessionReturnedAt, 'the refused offer is still held in the work session\'s hands');
    assert.equal(item.workSessionReturnReason, 'TURN_FAILED');
    assert.equal(item.assignee, 'COORDINATOR');
    assert.ok(item.escalateAt, 'the handed-back item has no escalation time');
    const deliveries = await stack.db.projectOpenItemDelivery.count({
      where: { itemId, sessionId: w.coordinatorSessionId, purpose: 'ITEM' },
    });
    assert.equal(deliveries, 1, 'the handed-back item was not delivered to the coordinator');

    assert.equal(await retryAnswer(stack, w, t), 'accepted', 'integration_retry was refused');
    assert.equal(await stack.db.projectIntegrationJob.count({ where: { taskId: t.taskId } }), 2, 'no landing was queued again');
  } finally {
    await stack.db.$disconnect();
  }
});

test('the landing-fix offer PostgreSQL target is explicitly disposable', { skip }, () => {
  assert.doesNotThrow(() => assertCoordinatorPgUrlIsIsolated(URL));
});
