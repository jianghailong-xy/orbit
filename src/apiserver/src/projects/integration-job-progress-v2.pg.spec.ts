import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import { Prisma, PrismaClient, RunStatus, RunnerStatus } from '@prisma/client';
import { Client } from 'pg';

import { IntegrationCheckResult, IntegrationJobCommand, IntegrationJobResultRequest } from '@orbit/shared';

import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { QueueService } from '../queue/queue.service';
import { RealtimeService } from '../realtime/realtime.service';
import {
  IntegrationJobRefused,
  IntegrationJobRelay,
  INTEGRATION_RESULT_REFUSAL_STATUS,
  receiveIntegrationJobProgress,
} from '../runner-api/integration-job-relay';
import { readOpenListVersion } from '../sessions/open-list-version';
import { SessionsService } from '../sessions/sessions.service';
import { TasksService } from '../tasks/tasks.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from './coordinator-pg-test-safety';
import { ProjectOpenItemService } from './project-open-item.service';
import {
  INTEGRATION_JOB_CLAIM,
  INTEGRATION_PROGRESS_V2,
  enqueueForDoneTask,
  endTimedOutLanding,
} from './project-integration-job';
import { configureProjectIntegration, readInFlightJobs } from './project-integration-line';
import { ProjectPromotionService } from './project-promotion.service';

/**
 * The v2 progress protocol and the facts it leaves behind (docs/project-integration-line-contract.md
 * §2.1 revision 12's columns, §2.2 J-T2 / J-T3 / J-T4 / J-T9 / J-T12, §3.3 M-T8 / M-T10, §7.2 V6,
 * J12):
 *
 *   * a claim made by a runner declaring `integration-progress/v2` records `progress_protocol` and
 *     is handed `reportBeforePush`; a legacy claim records nothing;
 *   * a renewal writes the phase, step, round, current check and output-moved instant, keeps
 *     `step_started_at` while the step does not change, and answers with `cancelRequested`;
 *   * a `phase = PUSH` report records `push_reported_generation = claim_generation` in the same
 *     statement, so the push boundary is a row fact and not the phase column;
 *   * a fence miss is STALE_CLAIM, a terminal job ALREADY_FINAL, another account's job 404;
 *   * a renewal does not move the flat session list's version, while a state change does;
 *   * ten minutes of silence times out a v2 claim in every phase, and leaves a legacy claim in
 *     CHECK its budget plus the lease; J12's code branches on the claim's protocol and the kind;
 *   * taking over a legacy claim writes the taken-over generation as the push boundary, because
 *     that runner may have pushed; taking over a v2 claim does not;
 *   * Cancel on a live landing reads as "cancelling" and the job's own result decides: CANCELLED
 *     writes the promotion CANCELLED (the release gate's cancel branch too), and a LANDED result
 *     written after the ask is the fact — MERGED with a receipt.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/projects/integration-job-progress-v2.pg.spec.ts
 *
 * Every case owns freshly generated ids; nothing here reads another project.
 */
const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

const sha = (nibble: string) => nibble.repeat(40);
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

async function connect(): Promise<Stack> {
  const db = prismaClientFor(URL!);
  const prisma = db as unknown as PrismaService;
  const realtime = new Proxy({}, { get: () => () => undefined }) as unknown as RealtimeService;
  const queue = { notifySessionQueued: () => undefined } as unknown as QueueService;
  const sessions = new SessionsService(prisma, queue, realtime);
  const openItems = new ProjectOpenItemService(prisma, sessions);
  const jobs = new IntegrationJobRelay(prisma, openItems);
  const promotions = new ProjectPromotionService(prisma);
  const tasks = new TasksService(prisma as never, {} as never, {
    publishTaskChanged() {},
    publishForUser() {},
  } as never);
  return { db, prisma, sessions, openItems, jobs, promotions, tasks };
}

interface Stack {
  db: PrismaClient;
  prisma: PrismaService;
  sessions: SessionsService;
  openItems: ProjectOpenItemService;
  jobs: IntegrationJobRelay;
  promotions: ProjectPromotionService;
  tasks: TasksService;
}

interface World {
  label: string;
  ownerId: string;
  runnerId: string;
  workspaceId: string;
  projectId: string;
  repoUrl: string;
}

/** One project with its own owner, runner and workspace, and a started line. */
async function world(
  stack: Stack,
  label: string,
  line: 'MAIN' | 'PROJECT_BRANCH',
): Promise<World> {
  const db = stack.db;
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const repoUrl = `https://git.invalid/${label}-${randomUUID().slice(0, 8)}.git`;
  await db.user.create({
    data: { id: ownerId, email: `${label}-${ownerId}@progress-v2.invalid`, name: label, passwordHash: 'x' },
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
  await db.project.create({
    data: { id: projectId, ownerId, title: `${label} project`, coordinatorWorkspaceId: workspaceId },
  });
  await db.projectRuntime.upsert({ where: { projectId }, create: { projectId }, update: {} });
  await db.$transaction((tx) => configureProjectIntegration(tx, {
    ownerId, projectId, settings: { line },
  }));
  return { label, ownerId, runnerId, workspaceId, projectId, repoUrl };
}

/** A DONE task whose branch is handed to the line, as its DONE would (J-T1a / M-F2). */
async function doneTask(stack: Stack, w: World, label: string): Promise<{ taskId: string; sessionId: string }> {
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
      baseSha: 'b'.repeat(40), status: RunStatus.SUCCEEDED, startsTaskWork: true,
      finishedAt: new Date(Date.now() - 60_000), worktreeBranch: branch, worktreeDirty: false,
      changedFiles: [{ path: 'src/the-work.ts' }] as never,
    },
    select: { id: true },
  });
  const queued = await stack.db.$transaction((tx) => enqueueForDoneTask(tx, w.ownerId, created.id));
  assert.ok(queued.enqueued, `the DONE queued nothing: ${JSON.stringify(queued)}`);
  return { taskId: created.id, sessionId: session.id };
}

/** One dispatch beat for a world's runner, declaring the capabilities it is given. */
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

async function jobRow(stack: Stack, jobId: string) {
  return stack.db.projectIntegrationJob.findUniqueOrThrow({
    where: { id: jobId },
    select: {
      id: true, kind: true, state: true, phase: true, progressProtocol: true,
      claimGeneration: true, claimLeaseOwner: true, pushReportedGeneration: true,
      round: true, step: true, stepStartedAt: true, outputMovedAt: true, currentCheck: true,
      cancelRequestedAt: true, heartbeatAt: true, errorCode: true, errorDetail: true,
    },
  });
}

/** The claim's heartbeat aged past any of the limits this spec uses. */
async function ageClaim(stack: Stack, jobId: string, milliseconds: number): Promise<void> {
  await stack.db.$executeRaw(Prisma.sql`
    UPDATE "project_integration_job"
       SET "heartbeat_at" = now() - (${milliseconds}::int * interval '1 millisecond')
     WHERE "id" = ${jobId}::uuid`);
}

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof IntegrationJobRefused) return error.refusal;
    throw error;
  }
  return 'ACCEPTED';
}

/** A MAIN-line world's offered candidate and the check it queued. */
async function offered(stack: Stack, w: World, label: string) {
  const work = await doneTask(stack, w, label);
  const candidate = await stack.db.projectPromotion.findFirstOrThrow({
    where: { projectId: w.projectId, sourceKind: 'TASK_BRANCH' },
    orderBy: { createdAt: 'desc' },
  });
  return { ...work, candidate };
}

const CLEAN: (sourceSha: string) => Answer = (sourceSha) => ({
  state: 'READY', phase: 'CHECK', sourceSha, targetShaBefore: UPSTREAM_TIP, upstreamSha: UPSTREAM_TIP,
  testedSha: sha('4'), testedTreeSha: sha('5'), aheadOfUpstream: 1, filesChanged: 1, checks: [GREEN_CHECK],
});

/**
 * A MAIN-line world with a candidate whose check has passed and been confirmed, so its landing is
 * QUEUED — the state M-T10's Cancel acts on.
 */
async function confirmedLanding(stack: Stack, w: World, label: string) {
  const { candidate } = await offered(stack, w, label);
  const check = await claim(stack, w);
  assert.equal(check.kind, 'CHECK_PROMOTION');
  await report(stack, w, check, CLEAN(sha('a')));
  const confirmed = await stack.promotions.confirm(
    { userId: w.ownerId }, w.projectId, candidate.id, sha('a'),
  );
  assert.equal(confirmed.state, 'CONFIRMED');
  return { candidate, confirmed };
}

test('the v2 claim, its reports, and the push boundary', {
  skip, concurrency: 1, timeout: 600_000,
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

  await t.test('(1) a v2 claim records the protocol and is handed reportBeforePush; a legacy claim is not', async () => {
    const v2 = await world(stack, 'claim-v2', 'PROJECT_BRANCH');
    await doneTask(stack, v2, 'v2');
    const job = await claim(stack, v2);
    assert.equal(job.kind, 'LAND_TASK');
    assert.equal(job.reportBeforePush, true, 'a v2 claim asks for the synchronous PUSH report');
    const row = await jobRow(stack, job.jobId);
    assert.equal(row.progressProtocol, 'v2');

    const legacy = await world(stack, 'claim-legacy', 'PROJECT_BRANCH');
    await doneTask(stack, legacy, 'legacy');
    const old = await claim(stack, legacy, [INTEGRATION_JOB_CLAIM]);
    assert.equal(old.reportBeforePush, undefined, 'a legacy claim is handed the old shape');
    assert.equal((await jobRow(stack, old.jobId)).progressProtocol, null);
  });

  await t.test('(2) a renewal writes the facts; step_started_at is the (phase, step) clock', async () => {
    const w = await world(stack, 'renewal', 'PROJECT_BRANCH');
    await doneTask(stack, w, 'renewal');
    const job = await claim(stack, w);
    const claimFence = { claimGeneration: job.claimGeneration, leaseOwner: job.leaseOwner };

    // §7.2 V6 counts the landing's main clock from the step's start, and the claim is where FETCH
    // begins (J-T2/J-T3).
    const claimed = await jobRow(stack, job.jobId);
    assert.equal(claimed.phase, 'FETCH');
    assert.equal(claimed.step, null);
    assert.ok(claimed.stepStartedAt, 'the claim starts the FETCH step clock');

    // The first report of the same (phase, step) is a renewal: it does not move the clock.
    await sleep(25);
    const first = await receiveIntegrationJobProgress(stack.prisma, w.runnerId, job.jobId, {
      ...claimFence, phase: 'FETCH',
    });
    assert.deepEqual(first, { accepted: true, cancelRequested: false });
    const one = await jobRow(stack, job.jobId);
    assert.equal(one.stepStartedAt!.getTime(), claimed.stepStartedAt!.getTime(),
      'the first same-step report keeps the claim\'s instant');

    // A sub-step starts the clock, and the renewal facts are written.
    await sleep(25);
    await receiveIntegrationJobProgress(stack.prisma, w.runnerId, job.jobId, {
      ...claimFence, phase: 'FETCH', step: 'WAITING_LOCAL_LOCK', round: 1, outputIdleMs: 5_000,
    });
    const localLock = await jobRow(stack, job.jobId);
    assert.equal(localLock.step, 'WAITING_LOCAL_LOCK');
    assert.equal(localLock.round, 1);
    assert.equal(localLock.currentCheck, null);
    assert.ok(localLock.stepStartedAt!.getTime() > one.stepStartedAt!.getTime(),
      'FETCH + WAITING_LOCAL_LOCK starts the clock now');
    assert.ok(localLock.outputMovedAt, 'the output-moved instant is recorded');
    const idle = Math.abs(localLock.heartbeatAt!.getTime() - localLock.outputMovedAt!.getTime() - 5_000);
    assert.ok(idle < 2_000, `output_moved_at is the receipt minus outputIdleMs (off by ${idle}ms)`);

    // The same (phase, step) again: the lease moves, the step's start does not.
    await sleep(25);
    await receiveIntegrationJobProgress(stack.prisma, w.runnerId, job.jobId, {
      ...claimFence, phase: 'FETCH', step: 'WAITING_LOCAL_LOCK', round: 1, outputIdleMs: 10,
    });
    const renewed = await jobRow(stack, job.jobId);
    assert.equal(renewed.stepStartedAt!.getTime(), localLock.stepStartedAt!.getTime(),
      'a repeated (phase, step) keeps its start');
    assert.ok(renewed.heartbeatAt!.getTime() > localLock.heartbeatAt!.getTime(), 'and the lease was renewed');

    // The sub-step ends: (FETCH, WAITING_LOCAL_LOCK) → (FETCH, none) starts it again.
    await sleep(25);
    await receiveIntegrationJobProgress(stack.prisma, w.runnerId, job.jobId, {
      ...claimFence, phase: 'FETCH',
    });
    const subStepEnded = await jobRow(stack, job.jobId);
    assert.equal(subStepEnded.step, null);
    assert.ok(subStepEnded.stepStartedAt!.getTime() > localLock.stepStartedAt!.getTime(),
      'a sub-step going back to none moves the clock');

    // The phase moves on: FETCH → MERGE starts it again.
    await sleep(25);
    await receiveIntegrationJobProgress(stack.prisma, w.runnerId, job.jobId, {
      ...claimFence, phase: 'MERGE',
    });
    const merged = await jobRow(stack, job.jobId);
    assert.equal(merged.phase, 'MERGE');
    assert.ok(merged.stepStartedAt!.getTime() > subStepEnded.stepStartedAt!.getTime(),
      'a phase change moves the clock');

    // CHECK + PREPARE moves it, and the check in flight is written whole.
    const startedAt = new Date(Date.now() - 30_000).toISOString();
    await sleep(25);
    await receiveIntegrationJobProgress(stack.prisma, w.runnerId, job.jobId, {
      ...claimFence, phase: 'CHECK', step: 'PREPARE', round: 1, outputIdleMs: 0,
      check: { name: 'MERGE_CHECK', index: 2, count: 3, budgetSeconds: 900, startedAt },
    });
    const preparing = await jobRow(stack, job.jobId);
    assert.equal(preparing.phase, 'CHECK');
    assert.equal(preparing.step, 'PREPARE');
    assert.ok(preparing.stepStartedAt!.getTime() > merged.stepStartedAt!.getTime(),
      'CHECK + PREPARE starts the clock now');
    assert.deepEqual(preparing.currentCheck, {
      name: 'MERGE_CHECK', index: 2, count: 3, budgetSeconds: 900, startedAt,
    });

    // Leaving PREPARE starts it again, and a report that names no check is not running one.
    await sleep(25);
    await receiveIntegrationJobProgress(stack.prisma, w.runnerId, job.jobId, {
      ...claimFence, phase: 'CHECK', round: 1,
    });
    const checking = await jobRow(stack, job.jobId);
    assert.equal(checking.currentCheck, null);
    assert.equal(checking.step, null);
    assert.ok(checking.stepStartedAt!.getTime() > preparing.stepStartedAt!.getTime(),
      'CHECK + PREPARE → CHECK moves the clock');
  });

  await t.test('(3) every answer carries cancelRequested', async () => {
    const w = await world(stack, 'answer-cancel', 'PROJECT_BRANCH');
    await doneTask(stack, w, 'answer');
    const job = await claim(stack, w);
    const claimFence = { claimGeneration: job.claimGeneration, leaseOwner: job.leaseOwner };
    assert.equal(
      (await receiveIntegrationJobProgress(stack.prisma, w.runnerId, job.jobId, { ...claimFence, phase: 'FETCH' }))
        .cancelRequested,
      false,
    );
    await sql.query(`UPDATE "project_integration_job" SET "cancel_requested_at" = now() WHERE "id" = $1::uuid`,
      [job.jobId]);
    assert.equal(
      (await receiveIntegrationJobProgress(stack.prisma, w.runnerId, job.jobId, { ...claimFence, phase: 'CHECK' }))
        .cancelRequested,
      true,
      'a stop written between reports is read from the answer',
    );
  });

  await t.test('(4) a PUSH report records push_reported_generation in the statement that answers it', async () => {
    const w = await world(stack, 'push-report', 'PROJECT_BRANCH');
    await doneTask(stack, w, 'push');
    const job = await claim(stack, w);
    const claimFence = { claimGeneration: job.claimGeneration, leaseOwner: job.leaseOwner };
    const before = await jobRow(stack, job.jobId);
    assert.equal(before.pushReportedGeneration, null);

    const answered = await receiveIntegrationJobProgress(stack.prisma, w.runnerId, job.jobId, {
      ...claimFence, phase: 'PUSH',
    });
    assert.equal(answered.accepted, true);
    const pushed = await jobRow(stack, job.jobId);
    assert.equal(pushed.pushReportedGeneration, pushed.claimGeneration,
      'the boundary is this claim generation, written before the answer');

    // The boundary is the ROW FACT, not the phase column: a later report that changes the phase
    // leaves it standing.
    await receiveIntegrationJobProgress(stack.prisma, w.runnerId, job.jobId, {
      ...claimFence, phase: 'CHECK',
    });
    assert.equal((await jobRow(stack, job.jobId)).pushReportedGeneration, pushed.claimGeneration);
  });

  await t.test('(5) a fence miss is STALE_CLAIM, a terminal job ALREADY_FINAL, a stranger\'s job 404', async () => {
    // The statuses the controller answers each refusal with (runner-api.controller.ts, the same
    // table the release and result doors use).
    assert.equal(INTEGRATION_RESULT_REFUSAL_STATUS.STALE_CLAIM, 409);
    assert.equal(INTEGRATION_RESULT_REFUSAL_STATUS.ALREADY_FINAL, 409);
    assert.equal(INTEGRATION_RESULT_REFUSAL_STATUS.NOT_FOUND, 404);

    const w = await world(stack, 'refusals', 'PROJECT_BRANCH');
    await doneTask(stack, w, 'refusals');
    const job = await claim(stack, w);
    const claimFence = { claimGeneration: job.claimGeneration, leaseOwner: job.leaseOwner };
    assert.equal(await refusal(receiveIntegrationJobProgress(stack.prisma, w.runnerId, job.jobId, {
      ...claimFence, claimGeneration: (BigInt(job.claimGeneration) + 1n).toString(), phase: 'CHECK',
    })), 'STALE_CLAIM', 'a generation that is not the row\'s is a claim that moved on');

    // A takeover by this runner's next process: the old claim is refused.
    const taker = `lease-${randomUUID()}`;
    await ageClaim(stack, job.jobId, 11 * 60_000);
    const [taken] = await beat(stack, w, taker);
    assert.equal(taken?.jobId, job.jobId, 'the stale claim is taken over');
    assert.equal(await refusal(receiveIntegrationJobProgress(stack.prisma, w.runnerId, job.jobId, {
      ...claimFence, phase: 'CHECK',
    })), 'STALE_CLAIM', 'the process that lost the claim is told to stop');

    // Written down: no report can move it again.
    await report(stack, w, taken, { state: 'ERROR', phase: 'FETCH', errorCode: 'FETCH_FAILED' });
    assert.equal(await refusal(receiveIntegrationJobProgress(stack.prisma, w.runnerId, job.jobId, {
      claimGeneration: taken.claimGeneration, leaseOwner: taker, phase: 'CHECK',
    })), 'ALREADY_FINAL');

    // Another account's job is answered as one that does not exist, and so is an id that names
    // nothing; a sibling runner of the same account is told the claim is not its own.
    const stranger = await world(stack, 'stranger', 'PROJECT_BRANCH');
    const other = await world(stack, 'sibling', 'PROJECT_BRANCH');
    await doneTask(stack, other, 'sibling');
    const siblingJob = await claim(stack, other);
    const siblingRunner = randomUUID();
    await stack.db.runner.create({
      data: {
        id: siblingRunner, ownerId: other.ownerId, name: 'a sibling', tokenHash: `hash-${siblingRunner}`,
        status: RunnerStatus.ONLINE, capabilities: [], capabilitiesReportedAt: new Date(),
        lastHeartbeatAt: new Date(),
      },
    });
    assert.equal(await refusal(receiveIntegrationJobProgress(stack.prisma, stranger.runnerId, siblingJob.jobId,
      { claimGeneration: siblingJob.claimGeneration, leaseOwner: siblingJob.leaseOwner, phase: 'CHECK' },
      stranger.ownerId)), 'NOT_FOUND');
    assert.equal(await refusal(receiveIntegrationJobProgress(stack.prisma, siblingRunner, siblingJob.jobId,
      { claimGeneration: siblingJob.claimGeneration, leaseOwner: siblingJob.leaseOwner, phase: 'CHECK' },
      other.ownerId)), 'STALE_CLAIM');
    assert.equal(await refusal(receiveIntegrationJobProgress(stack.prisma, w.runnerId, randomUUID(),
      { claimGeneration: '1', leaseOwner: 'nobody', phase: 'CHECK' }, w.ownerId)), 'NOT_FOUND');
  });

  await t.test('(6) a renewal leaves the flat session list\'s version alone; any other change moves it', async () => {
    const w = await world(stack, 'list-version', 'PROJECT_BRANCH');
    await doneTask(stack, w, 'version');
    const job = await claim(stack, w);
    const claimFence = { claimGeneration: job.claimGeneration, leaseOwner: job.leaseOwner };
    // A second task queued behind the same project, never claimed: the non-RUNNING half of the
    // fingerprint, where tuple identity is what moves the version.
    await doneTask(stack, w, 'version-queued');
    const queued = await stack.db.projectIntegrationJob.findFirstOrThrow({
      where: { projectId: w.projectId, state: 'QUEUED' },
      select: { id: true },
    });
    const before = await readOpenListVersion(stack.prisma, w.ownerId);

    // A renewal writes every renewal-only column, and nothing else: the version does not move.
    await receiveIntegrationJobProgress(stack.prisma, w.runnerId, job.jobId, {
      ...claimFence, phase: 'CHECK', step: 'PREPARE', round: 2, outputIdleMs: 250,
      check: { name: 'TASK_ACCEPTANCE', index: 1, count: 2, budgetSeconds: 300, startedAt: new Date().toISOString() },
    });
    const renewed = await readOpenListVersion(stack.prisma, w.ownerId);
    assert.equal(renewed, before, 'a lease renewal must not invalidate every client\'s If-None-Match');

    // A RUNNING row's NON-renewal column is content the hash keeps, so it moves the version.
    await sql.query(`UPDATE "project_integration_job" SET "cancel_requested_at" = now() WHERE "id" = $1::uuid`,
      [job.jobId]);
    const afterAsk = await readOpenListVersion(stack.prisma, w.ownerId);
    assert.notEqual(afterAsk, renewed, 'a non-renewal change on the RUNNING row moves the version');

    // ... and a renewal after that still leaves it alone, with the new value in the row.
    await receiveIntegrationJobProgress(stack.prisma, w.runnerId, job.jobId, {
      ...claimFence, phase: 'CHECK', step: 'PREPARE', round: 2, outputIdleMs: 10,
    });
    assert.equal(await readOpenListVersion(stack.prisma, w.ownerId), afterAsk,
      'a renewal with the new state in the row is still not a change');

    // RUNNING → terminal: the row leaves the hashed half and enters the tuple-identity half.
    await report(stack, w, job, { state: 'ERROR', phase: 'CHECK', errorCode: 'FETCH_FAILED' });
    const afterEnd = await readOpenListVersion(stack.prisma, w.ownerId);
    assert.notEqual(afterEnd, afterAsk, 'a job ending moves the version');

    // Any write to a non-RUNNING row moves it, because that half is tuple identity.
    await sql.query(`UPDATE "project_integration_job" SET "heartbeat_at" = now() WHERE "id" = $1::uuid`,
      [queued.id]);
    assert.notEqual(await readOpenListVersion(stack.prisma, w.ownerId), afterEnd,
      'a write to a QUEUED job moves the version');
  });

  await t.test('(7) the failure’s payload names the landing and the round at its top level, never '
    + 'inside the quoted error detail', async () => {
    const w = await world(stack, 'item-payload', 'PROJECT_BRANCH');
    await doneTask(stack, w, 'item-payload');
    const job = await claim(stack, w);
    await receiveIntegrationJobProgress(stack.prisma, w.runnerId, job.jobId, {
      claimGeneration: job.claimGeneration, leaseOwner: job.leaseOwner, phase: 'CHECK', round: 2,
    });
    await report(stack, w, job, {
      state: 'ERROR', phase: 'CHECK', errorCode: 'FETCH_FAILED',
      errorDetail: { code: 'FETCH_FAILED', step: 'CHECK' },
    });

    const opened = await stack.db.projectOpenItem.findFirstOrThrow({
      where: { projectId: w.projectId, kind: 'INTEGRATION_ERROR' },
      select: { payload: true },
    });
    const payload = opened.payload as {
      round?: number | null;
      landingSessionId?: string;
      errorDetail?: Record<string, unknown> | null;
    };
    const failed = await stack.db.projectIntegrationJob.findUniqueOrThrow({
      where: { id: job.jobId },
      select: { landingId: true, round: true },
    });
    const landing = await stack.db.projectLanding.findUniqueOrThrow({
      where: { id: failed.landingId! },
      select: { sessionId: true },
    });
    assert.equal(failed.round, 2, 'the row kept the round the last report named');
    assert.equal(payload.landingSessionId, landing.sessionId,
      'the item names the landing its attempt belongs to');
    assert.equal(payload.round, 2, 'the item names the round the failure happened in');
    // G6: `errorDetail` is quoted verbatim by the delivery text, so the two new fields are theirs
    // at the top level and never inside it.
    assert.deepEqual(payload.errorDetail, { code: 'FETCH_FAILED', step: 'CHECK' },
      'the runner’s own error detail is carried through unextended');
    for (const field of ['landingSessionId', 'round', 'upstreamMovedCommits']) {
      assert.equal(field in (payload.errorDetail ?? {}), false,
        `${field} was hidden inside the quoted error detail`);
    }
  });
});

test('timeouts and J12 branch on the claim\'s protocol', {
  skip, concurrency: 1, timeout: 600_000,
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

  const endTimedOut = async (w: World, jobId: string) => {
    const [job] = await readInFlightJobs(stack.prisma, w.projectId, jobId);
    assert.ok(job, 'the job is in flight');
    return stack.db.$transaction((tx) => endTimedOutLanding(tx, job));
  };

  await t.test('(1) ten minutes of silence times out a v2 claim wherever it is; a legacy claim in CHECK keeps its budget', async () => {
    const v2 = await world(stack, 'timeout-v2', 'PROJECT_BRANCH');
    await doneTask(stack, v2, 'v2-timeout');
    const v2Job = await claim(stack, v2);
    await receiveIntegrationJobProgress(stack.prisma, v2.runnerId, v2Job.jobId, {
      claimGeneration: v2Job.claimGeneration, leaseOwner: v2Job.leaseOwner, phase: 'CHECK',
    });
    await ageClaim(stack, v2Job.jobId, 11 * 60_000);
    const [silentV2] = await readInFlightJobs(stack.prisma, v2.projectId, v2Job.jobId);
    assert.equal(silentV2?.timedOut, true, 'a v2 claim is due a report every 30 seconds in every phase');
    assert.equal(silentV2?.limitSeconds, 600);

    const legacy = await world(stack, 'timeout-legacy', 'PROJECT_BRANCH');
    await doneTask(stack, legacy, 'legacy-timeout');
    const legacyJob = await claim(stack, legacy, [INTEGRATION_JOB_CLAIM]);
    await receiveIntegrationJobProgress(stack.prisma, legacy.runnerId, legacyJob.jobId, {
      claimGeneration: legacyJob.claimGeneration, leaseOwner: legacyJob.leaseOwner, phase: 'CHECK',
    });
    await ageClaim(stack, legacyJob.jobId, 11 * 60_000);
    const [silentLegacy] = await readInFlightJobs(stack.prisma, legacy.projectId, legacyJob.jobId);
    assert.equal(silentLegacy?.timedOut, false, 'a legacy check is silent for its budget plus the lease');
    assert.equal(silentLegacy?.limitSeconds, 3_600 + 600);
  });

  await t.test('(2) J12: a v2 claim that never recorded PUSH is RUNNER_LOST; once recorded, PUSH_OUTCOME_UNKNOWN', async () => {
    const w = await world(stack, 'j12-v2', 'PROJECT_BRANCH');
    await doneTask(stack, w, 'j12-not-pushed');
    const job = await claim(stack, w);
    await ageClaim(stack, job.jobId, 11 * 60_000);
    assert.equal(await endTimedOut(w, job.jobId), 'RUNNER_LOST');
    const ended = await jobRow(stack, job.jobId);
    assert.equal(ended.state, 'ERROR');
    assert.equal(ended.errorCode, 'RUNNER_LOST');
    assert.equal((ended.errorDetail as { pushOutcome: string }).pushOutcome, 'NOT_PUSHED');

    const pushed = await world(stack, 'j12-v2-pushed', 'PROJECT_BRANCH');
    await doneTask(stack, pushed, 'j12-pushed');
    const pushJob = await claim(stack, pushed);
    await receiveIntegrationJobProgress(stack.prisma, pushed.runnerId, pushJob.jobId, {
      claimGeneration: pushJob.claimGeneration, leaseOwner: pushJob.leaseOwner, phase: 'PUSH',
    });
    await ageClaim(stack, pushJob.jobId, 11 * 60_000);
    assert.equal(await endTimedOut(pushed, pushJob.jobId), 'PUSH_OUTCOME_UNKNOWN');
    assert.equal((await jobRow(stack, pushJob.jobId)).errorCode, 'PUSH_OUTCOME_UNKNOWN');
  });

  await t.test('(3) J12: a legacy landing cannot prove the negative, and a check never pushes', async () => {
    const legacy = await world(stack, 'j12-legacy', 'PROJECT_BRANCH');
    await doneTask(stack, legacy, 'j12-legacy');
    const legacyJob = await claim(stack, legacy, [INTEGRATION_JOB_CLAIM]);
    await ageClaim(stack, legacyJob.jobId, 11 * 60_000);
    assert.equal(await endTimedOut(legacy, legacyJob.jobId), 'PUSH_OUTCOME_UNKNOWN');

    // A check answers READY before the push step exists for it, whatever its claim.
    const main = await world(stack, 'j12-check', 'MAIN');
    await doneTask(stack, main, 'j12-check');
    const check = await claim(stack, main);
    assert.equal(check.kind, 'CHECK_PROMOTION');
    await ageClaim(stack, check.jobId, 11 * 60_000);
    assert.equal(await endTimedOut(main, check.jobId), 'RUNNER_LOST');
    assert.equal((await jobRow(stack, check.jobId)).errorCode, 'RUNNER_LOST');
  });
});

test('cancelling reads from the live job, and the result is the fact', {
  skip, concurrency: 1, timeout: 600_000,
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

  await t.test('(1) past the push boundary Cancel is refused: v2 by the recorded generation, legacy by phase', async () => {
    const v2 = await world(stack, 'cancel-v2-pushed', 'MAIN');
    const v2Landing = await confirmedLanding(stack, v2, 'v2-pushed');
    const v2Job = await claim(stack, v2);
    assert.equal(v2Job.kind, 'LAND_PROMOTION');
    await receiveIntegrationJobProgress(stack.prisma, v2.runnerId, v2Job.jobId, {
      claimGeneration: v2Job.claimGeneration, leaseOwner: v2Job.leaseOwner, phase: 'PUSH',
    });
    // Move the phase away again: the boundary is push_reported_generation, not the phase column.
    await receiveIntegrationJobProgress(stack.prisma, v2.runnerId, v2Job.jobId, {
      claimGeneration: v2Job.claimGeneration, leaseOwner: v2Job.leaseOwner, phase: 'CHECK',
    });
    await assert.rejects(
      stack.promotions.cancel({ userId: v2.ownerId }, v2.projectId, v2Landing.candidate.id),
      /cannot be called back/,
    );
    const kept = await stack.db.projectPromotion.findUniqueOrThrow({ where: { id: v2Landing.candidate.id } });
    assert.equal(kept.state, 'CONFIRMED');
    assert.equal((await jobRow(stack, v2Job.jobId)).cancelRequestedAt, null);

    // A legacy claim has only the phase: VERIFY is reported after the push, so it counts.
    const legacy = await world(stack, 'cancel-legacy-verify', 'MAIN');
    const legacyLanding = await confirmedLanding(stack, legacy, 'legacy-verify');
    const legacyJob = await claim(stack, legacy, [INTEGRATION_JOB_CLAIM]);
    assert.equal(legacyJob.kind, 'LAND_PROMOTION');
    await receiveIntegrationJobProgress(stack.prisma, legacy.runnerId, legacyJob.jobId, {
      claimGeneration: legacyJob.claimGeneration, leaseOwner: legacyJob.leaseOwner, phase: 'VERIFY',
    });
    await assert.rejects(
      stack.promotions.cancel({ userId: legacy.ownerId }, legacy.projectId, legacyLanding.candidate.id),
      /cannot be called back/,
    );
    assert.equal((await jobRow(stack, legacyJob.jobId)).cancelRequestedAt, null);
  });

  await t.test('(2) a live landing reads as cancelling, and its CANCELLED result writes the promotion CANCELLED', async () => {
    const w = await world(stack, 'cancel-cancelling', 'MAIN');
    const { candidate } = await confirmedLanding(stack, w, 'cancelling');
    const job = await claim(stack, w);
    await receiveIntegrationJobProgress(stack.prisma, w.runnerId, job.jobId, {
      claimGeneration: job.claimGeneration, leaseOwner: job.leaseOwner, phase: 'CHECK',
    });

    const cancelling = await stack.promotions.cancel({ userId: w.ownerId }, w.projectId, candidate.id);
    assert.equal(cancelling.state, 'CONFIRMED', 'the promotion keeps the state it was in');
    assert.equal(cancelling.cancelRequested, true, 'and the card draws it as cancelling');
    assert.equal(cancelling.pushBoundaryPassed, false);
    const asked = await jobRow(stack, job.jobId);
    assert.equal(asked.state, 'RUNNING');
    assert.ok(asked.cancelRequestedAt, 'the job was asked, not ended');

    await report(stack, w, job, {
      state: 'CANCELLED', phase: 'CHECK',
    });
    const ended = await stack.db.projectPromotion.findUniqueOrThrow({ where: { id: candidate.id } });
    assert.equal(ended.state, 'CANCELLED', 'the runner\'s own answer settles the cancellation');
    assert.equal((await jobRow(stack, job.jobId)).state, 'CANCELLED');
    const after = await stack.promotions.readCurrent(w.ownerId, w.projectId);
    assert.equal(after?.state, 'CANCELLED');
    assert.equal(after?.cancelRequested, false, 'nothing is in flight to cancel any more');
  });

  await t.test('(3) a LANDED result written after the ask is the fact: MERGED, with a receipt', async () => {
    const w = await world(stack, 'cancel-landed', 'MAIN');
    const { candidate } = await confirmedLanding(stack, w, 'landed');
    const job = await claim(stack, w);
    await receiveIntegrationJobProgress(stack.prisma, w.runnerId, job.jobId, {
      claimGeneration: job.claimGeneration, leaseOwner: job.leaseOwner, phase: 'CHECK',
    });
    const cancelling = await stack.promotions.cancel({ userId: w.ownerId }, w.projectId, candidate.id);
    assert.equal(cancelling.cancelRequested, true);

    await report(stack, w, job, {
      state: 'LANDED', phase: 'VERIFY', sourceSha: sha('a'), targetShaBefore: UPSTREAM_TIP,
      upstreamSha: UPSTREAM_TIP, testedSha: sha('4'), testedTreeSha: sha('5'),
      landedSha: sha('6'), landedTreeSha: sha('5'), aheadOfUpstream: 1, filesChanged: 1,
      checks: [GREEN_CHECK],
    });
    const merged = await stack.db.projectPromotion.findUniqueOrThrow({ where: { id: candidate.id } });
    assert.equal(merged.state, 'MERGED', 'M-T8: a push that happened is not cancelled by an ask');
    assert.equal(merged.mergedSha, sha('6'));
    assert.ok(merged.receiptIds.length > 0, 'and the merge left its receipt');
    const receipts = await stack.db.sessionMergeReceipt.count({ where: { projectId: w.projectId } });
    assert.ok(receipts > 0);
  });

  await t.test('(4) the release gate\'s cancel branch settles the promotion the same way', async () => {
    const w = await world(stack, 'cancel-release', 'MAIN');
    const { candidate } = await confirmedLanding(stack, w, 'release');
    const job = await claim(stack, w);
    await receiveIntegrationJobProgress(stack.prisma, w.runnerId, job.jobId, {
      claimGeneration: job.claimGeneration, leaseOwner: job.leaseOwner, phase: 'CHECK',
    });
    await stack.promotions.cancel({ userId: w.ownerId }, w.projectId, candidate.id);

    const released = await stack.jobs.release(job.jobId, w.runnerId, {
      claimGeneration: job.claimGeneration, leaseOwner: job.leaseOwner,
    }, w.ownerId);
    assert.deepEqual(released.answer, { released: false, state: 'CANCELLED' });
    assert.equal(
      (await stack.db.projectPromotion.findUniqueOrThrow({ where: { id: candidate.id } })).state,
      'CANCELLED',
      'a job somebody asked to stop is not handed back to the queue, and the merge is called off',
    );
  });

  await t.test('(5) taking over a legacy claim records the generation it took over; a v2 claim is not backfilled', async () => {
    const w = await world(stack, 'takeover', 'PROJECT_BRANCH');
    await doneTask(stack, w, 'takeover');
    const old = await claim(stack, w, [INTEGRATION_JOB_CLAIM]);
    const before = await jobRow(stack, old.jobId);
    assert.equal(before.progressProtocol, null);
    assert.equal(before.pushReportedGeneration, null);

    await ageClaim(stack, old.jobId, 11 * 60_000);
    const [taken] = await beat(stack, w, `lease-${randomUUID()}`,
      [INTEGRATION_JOB_CLAIM, INTEGRATION_PROGRESS_V2]);
    assert.equal(taken?.jobId, old.jobId, 'the legacy claim is taken over');
    const after = await jobRow(stack, old.jobId);
    assert.equal(after.progressProtocol, 'v2');
    assert.equal(after.pushReportedGeneration, before.claimGeneration,
      'the taken-over legacy generation is the push boundary: it may have pushed');

    // A v2 claim that recorded no PUSH leaves the column NULL: its silence proves nothing was pushed.
    const v2 = await world(stack, 'takeover-v2', 'PROJECT_BRANCH');
    await doneTask(stack, v2, 'takeover-v2');
    const v2Old = await claim(stack, v2);
    await ageClaim(stack, v2Old.jobId, 11 * 60_000);
    const [v2Taken] = await beat(stack, v2, `lease-${randomUUID()}`,
      [INTEGRATION_JOB_CLAIM, INTEGRATION_PROGRESS_V2]);
    assert.equal(v2Taken?.jobId, v2Old.jobId);
    const v2After = await jobRow(stack, v2Old.jobId);
    assert.equal(v2After.progressProtocol, 'v2');
    assert.equal(v2After.pushReportedGeneration, null,
      'a v2 claim that never reported PUSH is not turned into an unknown outcome by the takeover');
  });
});
