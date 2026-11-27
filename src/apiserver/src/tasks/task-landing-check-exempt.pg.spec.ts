import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import type { IntegrationCheckResult, IntegrationJobCommand, IntegrationJobResultRequest } from '@orbit/shared';
import { type PrismaClient, RunnerStatus, SessionDispatchOrigin } from '@prisma/client';
import { RunStatus } from '@orbit/shared';
import { Client } from 'pg';

import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { readIntegrationJobTimeline } from '../projects/project-integration-event';
import { enqueueForDoneTask, INTEGRATION_JOB_CLAIM, INTEGRATION_PROGRESS_V2 } from '../projects/project-integration-job';
import { lastLandingCheck } from '../projects/project-integration-line';
import { ProjectOpenItemService } from '../projects/project-open-item.service';
import type { QueueService } from '../queue/queue.service';
import type { RealtimeService } from '../realtime/realtime.service';
import { IntegrationJobRelay } from '../runner-api/integration-job-relay';
import { SessionsService } from '../sessions/sessions.service';
import { TasksService } from './tasks.service';

/**
 * P-C2 (docs/project-integration-line-contract.md §12.15, columns §12.14): the project's coordinator, or
 * the owner, exempts one task from the project's landing check, with a reason, on a PROJECT_BRANCH line
 * only. That task's landing runs its own acceptance and not the landing check, and records the skip as
 * TASK_EXEMPT with the reason.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/tasks/task-landing-check-exempt.pg.spec.ts
 *
 * The new DTO fields go in through `as never` and the columns migration 1350 adds are read with SQL, so
 * this file compiles on a tree without the change and goes red there on what it asserts.
 *
 * Not destructive: every case owns freshly generated ids.
 */
const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

const MERGE_CHECK = 'bash scripts/merge-check.sh';
const REASON = 'Docs-only change; the landing build has nothing to say about it.';
const sha = (digit: string): string => digit.repeat(40);

interface Stack {
  db: PrismaClient;
  sql: Client;
  prisma: PrismaService;
  tasks: TasksService;
  jobs: IntegrationJobRelay;
  openItems: ProjectOpenItemService;
}

async function connect(): Promise<Stack> {
  assertCoordinatorPgUrlIsIsolated(URL);
  const sql = new Client({ connectionString: URL, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const db = prismaClientFor(URL!);
  const prisma = db as unknown as PrismaService;
  const realtime = new Proxy({}, { get: () => () => undefined }) as unknown as RealtimeService;
  const queue = { notifySessionQueued: () => undefined } as unknown as QueueService;
  const sessions = new SessionsService(prisma, queue, realtime);
  const openItems = new ProjectOpenItemService(prisma, sessions);
  const tasks = new TasksService(prisma as never, {} as never, {
    publishTaskChanged() {},
    publishForUser() {},
  } as never);
  return { db, sql, prisma, tasks, jobs: new IntegrationJobRelay(prisma, openItems), openItems };
}

async function hangUp(stack: Stack): Promise<void> {
  await stack.db.$disconnect().catch(() => undefined);
  await stack.sql.end().catch(() => undefined);
}

interface World {
  ownerId: string;
  runnerId: string;
  workspaceId: string;
  projectId: string;
  coordinatorSessionId: string;
  /** A session of the same account and workspace that does not coordinate the project. */
  otherSessionId: string;
}

/** One owner, runner and workspace, a project coordinated from one of two sessions, and its started line. */
async function world(stack: Stack, label: string, line: 'MAIN' | 'PROJECT_BRANCH'): Promise<World> {
  const { db } = stack;
  const [ownerId, runnerId, workspaceId, projectId, coordinatorSessionId, otherSessionId] = [
    randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID(),
  ];
  const repoUrl = `ssh://git@example.invalid/${label}-${projectId.slice(0, 8)}`;
  await db.user.create({
    data: { id: ownerId, email: `${label}-${ownerId}@landing-exempt.invalid`, name: label, passwordHash: 'x' },
  });
  await db.runner.create({
    data: {
      id: runnerId, ownerId, name: `${label}-runner`, tokenHash: `hash-${runnerId}`, status: RunnerStatus.ONLINE,
      capabilities: [], capabilitiesReportedAt: new Date(), lastHeartbeatAt: new Date(),
    },
  });
  await db.workspace.create({
    data: { id: workspaceId, ownerId, runnerId, name: `${label}-workspace`, enabled: true, repoUrl, workDir: `/srv/${label}` },
  });
  for (const id of [coordinatorSessionId, otherSessionId]) {
    await db.session.create({
      data: {
        id, ownerId, creatorId: ownerId, workspaceId, assignedRunnerId: runnerId,
        title: `session: ${label}`, prompt: `session: ${label}`, provider: 'claude',
        turnState: null, dispatchOrigin: SessionDispatchOrigin.USER,
        numTurns: 1, startedAt: new Date(), runtimeSessionId: `runtime-${id}`,
      },
    });
    await db.conversationTurn.create({
      data: {
        sessionId: id, seq: 1, clientTurnId: SessionsService.initialTurnClientId(id),
        kind: 'message', content: `session: ${label}`, status: 'ANSWERED',
      },
    });
  }
  await db.project.create({
    data: {
      id: projectId, ownerId, title: `${label} project`, coordinatorEnabled: true,
      coordinatorWorkspaceId: workspaceId, coordinatorSessionId,
    },
  });
  await db.projectRuntime.upsert({ where: { projectId }, create: { projectId }, update: {} });
  await db.projectCodebase.create({
    data: {
      ownerId, projectId, canonicalRepoUrl: repoUrl, upstreamRef: 'refs/heads/main',
      integrationRef: line === 'MAIN' ? 'refs/heads/main' : `refs/heads/project/${projectId}`,
      refAuthority: 'REMOTE', integrationRefSource: 'EXPLICIT',
      integrationStartedAt: new Date(Date.now() - 60_000), mergeCheckCommand: MERGE_CHECK,
    },
  });
  return { ownerId, runnerId, workspaceId, projectId, coordinatorSessionId, otherSessionId };
}

/** A task of the project, filed by the owner, settled by a command so its landing carries an acceptance. */
async function ownerTask(stack: Stack, w: World, label: string): Promise<string> {
  const task = await stack.tasks.create(w.ownerId, {
    title: `${label} ${randomUUID().slice(0, 8)}`,
    projectId: w.projectId,
    completionCriterion: 'EXECUTABLE',
    acceptanceCommand: 'npm test',
    acceptanceExpectedExitCode: 0,
  } as never);
  return task.id;
}

interface ExemptRow {
  exempt: boolean;
  reason: string | null;
  bySessionId: string | null;
}

async function exemptionOf(stack: Stack, taskId: string): Promise<ExemptRow> {
  const { rows } = await stack.sql.query<ExemptRow>(`
    SELECT "landing_check_exempt" AS "exempt", "landing_check_exempt_reason" AS "reason",
           "landing_check_exempt_by_session_id"::text AS "bySessionId"
      FROM "task" WHERE "id" = $1::uuid`, [taskId]);
  assert.equal(rows.length, 1);
  return rows[0];
}

/** The refusal a write met, as status and code; fails the case when it was not refused. */
async function refusal(write: Promise<unknown>): Promise<{ status: number | undefined; code: string | undefined }> {
  try {
    await write;
  } catch (error) {
    return {
      status: (error as { getStatus?: () => number }).getStatus?.(),
      code: (error as { getResponse?: () => { code?: string } }).getResponse?.()?.code,
    };
  }
  assert.fail('the write went through');
}

const NOT_EXEMPT: ExemptRow = { exempt: false, reason: null, bySessionId: null };

test('the coordinator exempts a task with a reason; no reason, a long one, or another session is refused', {
  skip, concurrency: 1, timeout: 120_000,
}, async () => {
  const stack = await connect();
  try {
    const w = await world(stack, 'exempt-update', 'PROJECT_BRANCH');
    const taskId = await ownerTask(stack, w, 'exempt-update');
    const update = (dto: Record<string, unknown>, sessionId?: string) =>
      stack.tasks.update(w.ownerId, taskId, dto as never, sessionId);

    assert.deepEqual(await refusal(update({ landingCheckExempt: true }, w.coordinatorSessionId)),
      { status: 400, code: 'LANDING_CHECK_EXEMPT_REASON_REQUIRED' });
    assert.deepEqual(await refusal(update({ landingCheckExempt: true, landingCheckExemptReason: '   ' }, w.coordinatorSessionId)),
      { status: 400, code: 'LANDING_CHECK_EXEMPT_REASON_REQUIRED' });
    assert.deepEqual(
      await refusal(update({ landingCheckExempt: true, landingCheckExemptReason: 'x'.repeat(281) }, w.coordinatorSessionId)),
      { status: 400, code: 'LANDING_CHECK_EXEMPT_REASON_TOO_LONG' });
    assert.deepEqual(await refusal(update({ landingCheckExempt: true, landingCheckExemptReason: REASON }, w.otherSessionId)),
      { status: 403, code: 'LANDING_CHECK_EXEMPT_COORDINATOR_ONLY' });
    assert.deepEqual(await exemptionOf(stack, taskId), NOT_EXEMPT, 'a refused write wrote nothing');

    await update({ landingCheckExempt: true, landingCheckExemptReason: `  ${REASON}  ` }, w.coordinatorSessionId);
    assert.deepEqual(await exemptionOf(stack, taskId),
      { exempt: true, reason: REASON, bySessionId: w.coordinatorSessionId });
    // Another session may not take it back either.
    assert.deepEqual(await refusal(update({ landingCheckExempt: false }, w.otherSessionId)),
      { status: 403, code: 'LANDING_CHECK_EXEMPT_COORDINATOR_ONLY' });

    // The owner, at their own door (no session), takes it back and sets it again; their write names no session.
    await update({ landingCheckExempt: false });
    assert.deepEqual(await exemptionOf(stack, taskId), NOT_EXEMPT);
    await update({ landingCheckExempt: true, landingCheckExemptReason: REASON });
    assert.deepEqual(await exemptionOf(stack, taskId), { exempt: true, reason: REASON, bySessionId: null });
    // A reason beside false is a contradiction, not a no-op.
    assert.deepEqual(await refusal(update({ landingCheckExempt: false, landingCheckExemptReason: REASON })),
      { status: 400, code: 'LANDING_CHECK_EXEMPT_REASON_WITHOUT_EXEMPTION' });
  } finally {
    await hangUp(stack);
  }
});

test('the coordinator exempts a task as it files it, alone or in a batch; a reason is still required', {
  skip, concurrency: 1, timeout: 120_000,
}, async () => {
  const stack = await connect();
  try {
    const w = await world(stack, 'exempt-create', 'PROJECT_BRANCH');
    const item = (title: string, extra: Record<string, unknown>) => ({
      title, projectId: w.projectId, completionCriterion: 'EVIDENCE_JUDGMENT', acceptanceCriteria: 'it is done', ...extra,
    });
    assert.deepEqual(
      await refusal(stack.tasks.create(w.ownerId, item('no reason', { landingCheckExempt: true }) as never,
        undefined, w.coordinatorSessionId)),
      { status: 400, code: 'LANDING_CHECK_EXEMPT_REASON_REQUIRED' });

    const created = await stack.tasks.create(w.ownerId,
      item('single', { landingCheckExempt: true, landingCheckExemptReason: REASON }) as never,
      undefined, w.coordinatorSessionId);
    assert.deepEqual(await exemptionOf(stack, created.id),
      { exempt: true, reason: REASON, bySessionId: w.coordinatorSessionId });

    const batch = await stack.tasks.createMany(w.ownerId, {
      tasks: [item('batch exempt', { landingCheckExempt: true, landingCheckExemptReason: REASON }), item('batch plain', {})],
    } as never, undefined, w.coordinatorSessionId) as Array<{ id: string }>;
    assert.deepEqual(await exemptionOf(stack, batch[0].id),
      { exempt: true, reason: REASON, bySessionId: w.coordinatorSessionId });
    assert.deepEqual(await exemptionOf(stack, batch[1].id), NOT_EXEMPT);
  } finally {
    await hangUp(stack);
  }
});

test('on a MAIN line the exemption is refused 409 LANDING_CHECK_EXEMPT_NEEDS_PROJECT_BRANCH, for the owner too', {
  skip, concurrency: 1, timeout: 120_000,
}, async () => {
  const stack = await connect();
  try {
    const w = await world(stack, 'exempt-main', 'MAIN');
    const taskId = await ownerTask(stack, w, 'exempt-main');
    const exempt = { landingCheckExempt: true, landingCheckExemptReason: REASON };
    const needsBranch = { status: 409, code: 'LANDING_CHECK_EXEMPT_NEEDS_PROJECT_BRANCH' };
    assert.deepEqual(await refusal(stack.tasks.update(w.ownerId, taskId, exempt as never, w.coordinatorSessionId)), needsBranch);
    assert.deepEqual(await refusal(stack.tasks.update(w.ownerId, taskId, exempt as never)), needsBranch);
    assert.deepEqual(await refusal(stack.tasks.create(w.ownerId, {
      title: 'main create', projectId: w.projectId, completionCriterion: 'EVIDENCE_JUDGMENT', acceptanceCriteria: 'done', ...exempt,
    } as never, undefined, w.coordinatorSessionId)), needsBranch);
    assert.deepEqual(await exemptionOf(stack, taskId), NOT_EXEMPT);

    // A task in no project lands on no project branch either.
    const loose = await stack.tasks.create(w.ownerId, {
      title: 'no project', completionCriterion: 'EXECUTABLE', acceptanceCommand: 'true', acceptanceExpectedExitCode: 0,
    } as never);
    assert.deepEqual(await refusal(stack.tasks.update(w.ownerId, loose.id, exempt as never)), needsBranch);
  } finally {
    await hangUp(stack);
  }
});

type Answer = Omit<IntegrationJobResultRequest, 'claimGeneration' | 'leaseOwner'>;

/** Settle a task DONE and queue its landing, as the DONE edge does, with one commit on its branch. */
async function land(stack: Stack, w: World, taskId: string, label: string): Promise<void> {
  const settled = await stack.sql.query(
    `UPDATE "task" SET "status" = 'DONE' WHERE "id" = $1::uuid AND "status" IN ('OPEN', 'IN_PROGRESS')`, [taskId]);
  assert.equal(settled.rowCount, 1);
  const branch = `orbit/${label}-${taskId.slice(0, 8)}`;
  await stack.db.session.create({
    data: {
      ownerId: w.ownerId, creatorId: w.ownerId, taskId, workspaceId: w.workspaceId, assignedRunnerId: w.runnerId,
      title: label, prompt: label, branch, isolationStatus: 'worktree', baseSha: sha('b'), turnState: null,
      startsTaskWork: true, finishedAt: new Date(Date.now() - 60_000), worktreeBranch: branch, worktreeDirty: false,
      changedFiles: [{ path: 'docs/the-work.md' }] as never,
    },
  });
  const queued = await stack.db.$transaction((tx) => enqueueForDoneTask(tx, w.ownerId, taskId));
  assert.ok(queued.enqueued, JSON.stringify(queued));
}

async function claim(stack: Stack, w: World): Promise<IntegrationJobCommand> {
  const handed = await stack.jobs.dispatch({
    runnerId: w.runnerId, leaseOwner: `lease-${randomUUID()}`, draining: false,
    capabilities: [INTEGRATION_JOB_CLAIM, INTEGRATION_PROGRESS_V2],
  });
  const job = handed.find((command) => command.kind === 'LAND_TASK');
  assert.ok(job, `the heartbeat was handed no LAND_TASK: ${JSON.stringify(handed.map((command) => command.kind))}`);
  return job;
}

async function report(stack: Stack, w: World, job: IntegrationJobCommand, answer: Answer): Promise<void> {
  const { answer: taken } = await stack.jobs.applyResult(job.jobId, w.runnerId, {
    claimGeneration: job.claimGeneration, leaseOwner: job.leaseOwner, ...answer,
  });
  assert.ok(taken.accepted, `the answer was refused: ${JSON.stringify(taken)}`);
}

const ACCEPTANCE_PASSED: IntegrationCheckResult = {
  name: 'TASK_ACCEPTANCE', command: 'npm test', expectedExitCode: 0, exitCode: 0, timedOut: false,
  durationMs: 1_000, outputTail: 'ok\n',
};

const LANDED: Answer = {
  state: 'LANDED', phase: 'VERIFY', sourceSha: sha('d'), targetShaBefore: sha('c'), upstreamSha: sha('c'),
  testedSha: sha('f'), testedTreeSha: sha('e'), landedSha: sha('f'), landedTreeSha: sha('e'),
};

/** The skipped landing check a TASK_EXEMPT landing records. */
const exemptEntry = (reason: string): IntegrationCheckResult => ({
  name: 'LANDING_CHECK', command: '', expectedExitCode: 0, exitCode: null, timedOut: false,
  durationMs: 0, outputTail: '', skipped: 'TASK_EXEMPT', reason,
} as unknown as IntegrationCheckResult);

test('an exempt task lands with its acceptance and no landing check, and the result records TASK_EXEMPT', {
  skip, concurrency: 1, timeout: 120_000,
}, async () => {
  const stack = await connect();
  try {
    const w = await world(stack, 'exempt-land', 'PROJECT_BRANCH');
    const taskId = await ownerTask(stack, w, 'exempt-land');
    await stack.tasks.update(w.ownerId, taskId,
      { landingCheckExempt: true, landingCheckExemptReason: REASON } as never, w.coordinatorSessionId);
    await land(stack, w, taskId, 'exempt-land');
    const job = await claim(stack, w);
    assert.deepEqual(job.checks.map((check) => check.name), ['TASK_ACCEPTANCE'],
      'the command carries the task acceptance and not the landing check');
    assert.equal(job.checks[0].command, 'npm test');
    assert.equal((job as unknown as { landingCheckExemptReason?: string }).landingCheckExemptReason, REASON);

    // A skipped TASK_EXEMPT entry must say why, within the column's limit, and only for the landing check.
    for (const invalid of [
      { ...exemptEntry(REASON), reason: '' },
      { ...exemptEntry(REASON), reason: 'x'.repeat(281) },
      { ...exemptEntry(REASON), name: 'TASK_ACCEPTANCE' },
      { ...exemptEntry(REASON), files: ['docs/a.md'] },
    ]) {
      const { answer } = await stack.jobs.applyResult(job.jobId, w.runnerId, {
        claimGeneration: job.claimGeneration, leaseOwner: job.leaseOwner, ...LANDED,
        checks: [ACCEPTANCE_PASSED, invalid as IntegrationCheckResult],
      }).catch((error: unknown) => ({ answer: { refused: (error as { refusal?: string }).refusal } }));
      assert.deepEqual(answer, { refused: 'INVALID_RESULT' }, JSON.stringify(invalid));
    }

    // What this change's runner answers: the acceptance it ran, then the landing check it skipped and why.
    await report(stack, w, job, { ...LANDED, checks: [ACCEPTANCE_PASSED, exemptEntry(REASON)] });
    const row = await stack.db.projectIntegrationJob.findUniqueOrThrow({ where: { id: job.jobId } });
    assert.deepEqual(row.checks, [ACCEPTANCE_PASSED, exemptEntry(REASON)]);
    assert.equal(lastLandingCheck(row.checks), 'PASSING');
    const timeline = await readIntegrationJobTimeline(stack.prisma, w.projectId, { jobId: job.jobId });
    assert.deepEqual(timeline.entries.filter((entry) => entry.kind === 'CHECK_FINISHED').map((entry) => entry.text), [
      'Task acceptance passed · 0m 01s',
      `Landing check skipped · this task is exempt: ${REASON}`,
    ]);

    // The same project's other tasks still get the landing check.
    const plainId = await ownerTask(stack, w, 'exempt-land-plain');
    await land(stack, w, plainId, 'exempt-land-plain');
    const plain = await claim(stack, w);
    assert.deepEqual(plain.checks.map((check) => check.name), ['TASK_ACCEPTANCE', 'LANDING_CHECK']);
    assert.equal(plain.checks[1].command, MERGE_CHECK);
    assert.equal((plain as unknown as { landingCheckExemptReason?: string }).landingCheckExemptReason, undefined);
  } finally {
    await hangUp(stack);
  }
});

test('a runner from before TASK_EXEMPT runs only the acceptance it is handed, and the server records the skip', {
  skip, concurrency: 1, timeout: 120_000,
}, async () => {
  const stack = await connect();
  try {
    const w = await world(stack, 'exempt-old-runner', 'PROJECT_BRANCH');
    const taskId = await ownerTask(stack, w, 'exempt-old-runner');
    await stack.tasks.update(w.ownerId, taskId,
      { landingCheckExempt: true, landingCheckExemptReason: REASON } as never, w.coordinatorSessionId);
    await land(stack, w, taskId, 'exempt-old-runner');
    const job = await claim(stack, w);
    assert.deepEqual(job.checks.map((check) => check.name), ['TASK_ACCEPTANCE']);
    // An older runner ignores `landingCheckExemptReason`, runs the one check it was handed and says nothing of
    // the landing check; the record still names the skip and its reason.
    await report(stack, w, job, { ...LANDED, checks: [ACCEPTANCE_PASSED] });
    const row = await stack.db.projectIntegrationJob.findUniqueOrThrow({ where: { id: job.jobId } });
    assert.deepEqual(row.checks, [ACCEPTANCE_PASSED, exemptEntry(REASON)]);
  } finally {
    await hangUp(stack);
  }
});
