import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { Prisma, PrismaClient, RunStatus, RunnerStatus, TaskStatus } from '@prisma/client';
import { Client } from 'pg';

import {
  IntegrationCheckResult,
  IntegrationJobCommand,
  IntegrationJobResultRequest,
  IntegrationJobState,
} from '@orbit/shared';

import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { QueueService } from '../queue/queue.service';
import { RealtimeService } from '../realtime/realtime.service';
import { IntegrationJobRelay } from '../runner-api/integration-job-relay';
import { SessionsService } from '../sessions/sessions.service';
import { TasksService } from '../tasks/tasks.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from './coordinator-pg-test-safety';
import { managedRunnerWork } from '../managed-runners/managed-runner-work';
import { readDoneState } from './project-done-request';
import { readInFlightLandingJobs } from './criterion-landing-reason';
import { ProjectHandoffService } from './project-handoff.service';
import {
  INTEGRATION_JOB_CLAIM,
  enqueueForDoneTask,
  integrationSerialKey,
} from './project-integration-job';
import {
  configureProjectIntegration,
  readInFlightJobs,
  readProjectIntegrationView,
  readProjectListBindings,
  stopInFlightJob,
} from './project-integration-line';
import { landingInFlight } from './project-looks-finished';
import { ProjectOpenItemService } from './project-open-item.service';
import { ProjectPromotionService } from './project-promotion.service';

/**
 * J-T8's "a stop is a fact, not a request" (docs/project-integration-line-contract.md §2.2 J-T8,
 * revision 23; §3.3 M-T6 / M-T10 / M-T13; §2.6 J12):
 *
 *   * a QUEUED job somebody stops is ended CANCELLED in the transaction that asks, and no in-flight
 *     reader counts it any more;
 *   * a RUNNING job still reporting is only asked (cancel_requested_at) — its result decides;
 *   * a RUNNING job already silent past its limit is ended on the spot as the ERROR it is, with
 *     J12's code for its kind, so it stops holding its serial slot;
 *   * a cancel-requested RUNNING job can be taken over, and the process that takes it reports
 *     CANCELLED at once;
 *   * a task reopened or written CANCELLED / FAILED stops its landing, and the DONE written after
 *     the reopen gets its generation once the stopped one ends CANCELLED;
 *   * a result that arrives "too early" — or after the stop — never leaves a QUEUED row carrying a
 *     stop request.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/projects/integration-job-cancel.pg.spec.ts
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

const RED_CHECK: IntegrationCheckResult = {
  name: 'MERGE_CHECK',
  command: 'npm test',
  expectedExitCode: 0,
  exitCode: 1,
  timedOut: false,
  durationMs: 1_200,
  outputTail: 'not ok\n',
};

type Answer = Omit<IntegrationJobResultRequest, 'claimGeneration' | 'leaseOwner'>;

const MIGRATION = path.resolve(
  __dirname, '../../prisma/migrations/0433_integration_job_queued_cancel/migration.sql',
);

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
  integrationRef: string;
  upstreamRef: string;
  settings: Awaited<ReturnType<typeof configureProjectIntegration>>;
}

/**
 * One project with its own runner and workspace. `line` decides where work lands: its own branch,
 * or the upstream itself. Two worlds may share `repoUrl`, which is what J1's serial key is made of.
 */
async function world(
  stack: Stack,
  label: string,
  line: 'MAIN' | 'PROJECT_BRANCH',
  repoUrl = `https://git.invalid/${label}-${randomUUID().slice(0, 6)}.git`,
  /** An account to add a second project to: the unknown-push list is one account's own queue. */
  existingOwnerId?: string,
): Promise<World> {
  const db = stack.db;
  const ownerId = existingOwnerId ?? randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  if (!existingOwnerId) {
    await db.user.create({
      data: { id: ownerId, email: `${label}-${ownerId}@cancel.invalid`, name: label, passwordHash: 'x' },
    });
  }
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
      repoUrl,
      workDir: `/srv/${label}`,
    },
  });
  await db.project.create({
    data: { id: projectId, ownerId, title: `${label} project`, coordinatorWorkspaceId: workspaceId },
  });
  await db.projectRuntime.upsert({ where: { projectId }, create: { projectId }, update: {} });
  const settings = await db.$transaction((tx) => configureProjectIntegration(tx, {
    ownerId, projectId, settings: { line },
  }));
  const codebase = await db.projectCodebase.findFirstOrThrow({ where: { projectId, slot: 'primary' } });
  return {
    label,
    ownerId,
    runnerId,
    workspaceId,
    projectId,
    repoUrl,
    integrationRef: codebase.integrationRef,
    upstreamRef: codebase.upstreamRef,
    settings,
  };
}

/** A DONE task whose branch is handed to the line, as its DONE would (J-T1a). */
async function doneTask(
  stack: Stack,
  w: World,
  label: string,
): Promise<{ taskId: string; sessionId: string; branch: string }> {
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
  // Unique to this task: a v7 id's clock prefix is shared by rows made in one millisecond.
  const branch = `orbit/${label}-${randomUUID().slice(0, 8)}`;
  const session = await stack.db.session.create({
    data: {
      ownerId: w.ownerId,
      creatorId: w.ownerId,
      taskId: created.id,
      workspaceId: w.workspaceId,
      assignedRunnerId: w.runnerId,
      title,
      prompt: title,
      branch,
      isolationStatus: 'worktree',
      baseSha: 'b'.repeat(40),
      status: RunStatus.SUCCEEDED,
      startsTaskWork: true,
      finishedAt: new Date(Date.now() - 60_000),
      worktreeBranch: branch,
      worktreeDirty: false,
      changedFiles: [{ path: 'src/the-work.ts' }] as never,
    },
    select: { id: true },
  });
  const queued = await stack.db.$transaction((tx) => enqueueForDoneTask(tx, w.ownerId, created.id));
  assert.ok(queued.enqueued, `the DONE queued nothing: ${JSON.stringify(queued)}`);
  return { taskId: created.id, sessionId: session.id, branch };
}

/**
 * The task reopened and written DONE again while its stopped generation is still in flight: the
 * DONE cannot queue (J-T8's marker is kept for it, and `enqueueForDoneTask` answers ALREADY_QUEUED).
 */
async function reopenAndRedo(stack: Stack, w: World, taskId: string): Promise<void> {
  await stack.tasks.update(w.ownerId, taskId, {
    status: TaskStatus.OPEN, supersededByTaskId: null, terminalReason: null,
  } as never);
  await stack.db.$executeRawUnsafe(
    `UPDATE "task" SET "status" = 'DONE' WHERE "id" = $1::uuid`, taskId,
  );
  const again = await stack.db.$transaction((tx) => enqueueForDoneTask(tx, w.ownerId, taskId));
  assert.equal(again.enqueued, false);
  assert.equal(again.reason, 'ALREADY_QUEUED');
  assert.ok(await stack.db.taskReopenIntent.findUnique({ where: { taskId } }),
    'the marker is kept for the stopped generation to answer');
}

/** One dispatch beat for a world's runner. */
async function beat(stack: Stack, w: World, leaseOwner = `lease-${randomUUID()}`) {
  return stack.jobs.dispatch({
    runnerId: w.runnerId,
    leaseOwner,
    draining: false,
    capabilities: [INTEGRATION_JOB_CLAIM],
  });
}

async function claim(stack: Stack, w: World, leaseOwner?: string): Promise<IntegrationJobCommand> {
  const [job] = await beat(stack, w, leaseOwner);
  assert.ok(job, 'the heartbeat was handed nothing');
  return job;
}

async function report(stack: Stack, w: World, job: { jobId: string; claimGeneration: string; leaseOwner: string }, answer: Answer) {
  const { answer: taken } = await stack.jobs.applyResult(job.jobId, w.runnerId, {
    claimGeneration: job.claimGeneration,
    leaseOwner: job.leaseOwner,
    ...answer,
  });
  return taken;
}

async function jobRow(stack: Stack, jobId: string) {
  return stack.db.projectIntegrationJob.findUniqueOrThrow({
    where: { id: jobId },
    select: {
      id: true, kind: true, state: true, phase: true, serialKey: true, taskId: true,
      promotionId: true, claimGeneration: true, cancelRequestedAt: true, finishedAt: true,
      errorCode: true, errorDetail: true, generation: true, idempotencyKey: true,
    },
  });
}

/** A MAIN-line world's offered candidate: its work is a branch, and its check is queued. */
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

test('a stop is a fact: QUEUED jobs end now, RUNNING ones are asked or ended, and nothing leaves a queued row carrying a stop', {
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

  await t.test('(1) the owner cancels a QUEUED promotion landing: it is CANCELLED at once and no reader counts it', async () => {
    const w = await world(stack, 'cancel-queued-merge', 'MAIN');
    const { candidate } = await offered(stack, w, 'queued');
    const check = await claim(stack, w);
    assert.equal(check.kind, 'CHECK_PROMOTION');
    const clean = await report(stack, w, check, CLEAN(sha('a')));
    assert.equal(clean.accepted, true);
    const confirmed = await stack.promotions.confirm(
      { userId: w.ownerId }, w.projectId, candidate.id, sha('a'),
    );
    assert.equal(confirmed.state, 'CONFIRMED');
    assert.equal(confirmed.execution?.state, 'QUEUED', 'the landing waits for a claim');

    const view = await stack.promotions.cancel({ userId: w.ownerId }, w.projectId, candidate.id);
    assert.equal(view.state, 'CANCELLED');
    assert.equal(view.execution, null);

    const landJob = await stack.db.projectIntegrationJob.findFirstOrThrow({
      where: { promotionId: candidate.id, kind: 'LAND_PROMOTION' },
    });
    const ended = await jobRow(stack, landJob.id);
    assert.equal(ended.state, 'CANCELLED', 'a queued job is ended, not merely asked');
    assert.ok(ended.cancelRequestedAt, 'the stop that ended it is recorded');
    assert.ok(ended.finishedAt, 'and so is the instant');

    // Every in-flight reader agrees.
    assert.deepEqual(await readInFlightJobs(stack.db, w.projectId), []);
    const integrationView = await readProjectIntegrationView(stack.db, w.projectId, w.settings);
    assert.equal(integrationView.queuedCount, 0);
    assert.equal(integrationView.integratingCount, 0);
    assert.equal(integrationView.inFlight, null);
    assert.deepEqual(integrationView.inFlightJobs, []);
    const bindings = await readProjectListBindings(stack.db, [w.projectId]);
    assert.equal(bindings.get(w.projectId)?.integration?.activeJobCount, 0);
    assert.equal(bindings.get(w.projectId)?.integration?.inFlight ?? null, null);
    assert.deepEqual(await readInFlightLandingJobs(stack.db, w.projectId), []);
    assert.equal(await landingInFlight(stack.db, w.projectId), false);
    const done = await readDoneState(stack.db as never, w.ownerId, w.projectId, null);
    assert.deepEqual(done.jobs, [], 'a done request would not name it');
    assert.deepEqual(await managedRunnerWork(stack.db as never, w.runnerId), [],
      'the managed runner has no work left to stay awake for');
    await new ProjectHandoffService(stack.prisma).assertMoveNotLanding(stack.db as never, w.ownerId, candidate.taskId!);
  });

  await t.test('(2) a task taken away stops its QUEUED landing at once, and an ordinary status edit does not', async () => {
    const w = await world(stack, 'cancel-queued-landing', 'PROJECT_BRANCH');
    const work = await doneTask(stack, w, 'landing');
    const jobs = await stack.db.projectIntegrationJob.findMany({ where: { taskId: work.taskId } });
    assert.deepEqual(jobs.map((job) => [job.kind, job.state]), [['LAND_TASK', 'QUEUED']]);

    // Continuing the work is not a stop: the claim already waits for a running work session.
    await stack.tasks.update(w.ownerId, work.taskId, { status: TaskStatus.IN_PROGRESS } as never);
    let row = await jobRow(stack, jobs[0]!.id);
    assert.equal(row.state, 'QUEUED');
    assert.equal(row.cancelRequestedAt, null, 'DONE → IN_PROGRESS keeps the landing');

    // Taking the task away is. This write and the stop are one transaction.
    await stack.tasks.update(w.ownerId, work.taskId, { status: TaskStatus.CANCELLED } as never);
    row = await jobRow(stack, jobs[0]!.id);
    assert.equal(row.state, 'CANCELLED');
    assert.ok(row.cancelRequestedAt);
    assert.ok(row.finishedAt);
    assert.deepEqual(await readInFlightJobs(stack.db, w.projectId), []);
    const view = await readProjectIntegrationView(stack.db, w.projectId, w.settings);
    assert.equal(view.queuedCount, 0);
    assert.equal(view.inFlight, null);
    assert.deepEqual(view.inFlightJobs, []);
    assert.deepEqual(await managedRunnerWork(stack.db as never, w.runnerId), []);
    await new ProjectHandoffService(stack.prisma).assertMoveNotLanding(stack.db as never, w.ownerId, work.taskId);
  });

  await t.test('(3) a cancel is refused once the claim may have pushed (PUSH or VERIFY)', async () => {
    const w = await world(stack, 'refuse-pushed', 'MAIN');
    const { candidate } = await offered(stack, w, 'pushed');
    const check = await claim(stack, w);
    await report(stack, w, check, CLEAN(sha('a')));
    await stack.promotions.confirm({ userId: w.ownerId }, w.projectId, candidate.id, sha('a'));
    const land = await claim(stack, w);
    assert.equal(land.kind, 'LAND_PROMOTION');

    for (const phase of ['PUSH', 'VERIFY'] as const) {
      await stack.jobs.progress(w.runnerId, land.jobId, {
        claimGeneration: land.claimGeneration, leaseOwner: land.leaseOwner, phase,
      });
      await assert.rejects(
        stack.promotions.cancel({ userId: w.ownerId }, w.projectId, candidate.id),
        /cannot be called back|already being pushed/,
        `${phase} must refuse the cancel`,
      );
      const row = await jobRow(stack, land.jobId);
      assert.equal(row.state, 'RUNNING');
      assert.equal(row.cancelRequestedAt, null, 'a refused cancel writes nothing');
    }
    assert.equal((await stack.db.projectPromotion.findUniqueOrThrow({ where: { id: candidate.id } })).state,
      'CONFIRMED');
  });

  await t.test('(4) a RUNNING check inside its window is only asked to stop; a timed-out one is ended on the spot', async () => {
    const w = await world(stack, 'supersede-checks', 'PROJECT_BRANCH');
    // A first landing puts the project branch somewhere candidate 1 can offer.
    const first = await doneTask(stack, w, 'first');
    const firstJob = await claim(stack, w);
    await report(stack, w, firstJob, {
      state: 'LANDED', phase: 'VERIFY', landedSha: sha('1'), targetShaBefore: sha('0'),
      testedSha: sha('2'), testedTreeSha: sha('3'), landedTreeSha: sha('3'), sourceSha: sha('a'),
      checks: [GREEN_CHECK], conflicts: [],
    });
    const candidate1 = await stack.promotions.considerCandidate(w.projectId);
    assert.ok(candidate1);
    const check1 = await claim(stack, w);
    assert.equal(check1.kind, 'CHECK_PROMOTION');

    // A second landing makes a newer tip; the next candidate supersedes the first (M-T6).
    const second = await doneTask(stack, w, 'second');
    const secondJob = await claim(stack, w);
    await report(stack, w, secondJob, {
      state: 'LANDED', phase: 'VERIFY', landedSha: sha('4'), targetShaBefore: sha('1'),
      testedSha: sha('5'), testedTreeSha: sha('6'), landedTreeSha: sha('6'), sourceSha: sha('b'),
      checks: [GREEN_CHECK], conflicts: [],
    });
    const candidate2 = await stack.promotions.considerCandidate(w.projectId);
    assert.ok(candidate2);
    assert.equal((await stack.db.projectPromotion.findUniqueOrThrow({ where: { id: candidate1.promotionId } })).state,
      'SUPERSEDED');

    const asked = await jobRow(stack, check1.jobId);
    assert.equal(asked.state, 'RUNNING', 'a check still reporting is asked, not cancelled');
    assert.ok(asked.cancelRequestedAt, 'only the request is written');

    // The runner takes the stopped claim over (J-T3) and answers CANCELLED at once (J-T12).
    const silentSince = new Date(Date.now() - 11 * 60_000);
    await stack.db.projectIntegrationJob.update({
      where: { id: check1.jobId }, data: { claimedAt: silentSince, heartbeatAt: silentSince },
    });
    const takenOver = await claim(stack, w, `lease-takeover-${randomUUID()}`);
    assert.equal(takenOver.jobId, check1.jobId);
    assert.equal(takenOver.cancelRequested, true, 'the new process is told to stop');
    const cancelled = await report(stack, w, takenOver, { state: 'CANCELLED', phase: 'FETCH' });
    assert.equal(cancelled.accepted, true, 'the CANCELLED result of the taken-over claim is accepted');
    assert.equal(cancelled.state, 'CANCELLED');
    assert.equal((await jobRow(stack, check1.jobId)).state, 'CANCELLED');

    // The timed-out shape: candidate 2's check is claimed and running, a third landing moves the
    // tip, and candidate 3 supersedes candidate 2 while its check is silent past its limit.
    const check2 = await claim(stack, w);
    assert.equal(check2.kind, 'CHECK_PROMOTION');
    const third = await doneTask(stack, w, 'third');
    const thirdJob = await claim(stack, w);
    assert.equal(thirdJob.kind, 'LAND_TASK');
    await report(stack, w, thirdJob, {
      state: 'LANDED', phase: 'VERIFY', landedSha: sha('7'), targetShaBefore: sha('4'),
      testedSha: sha('8'), testedTreeSha: sha('c'), landedTreeSha: sha('c'), sourceSha: sha('d'),
      checks: [GREEN_CHECK], conflicts: [],
    });
    // Silence it only now: claimed long enough ago, and nothing else will take it over.
    await stack.db.projectIntegrationJob.update({
      where: { id: check2.jobId },
      data: { claimedAt: new Date(Date.now() - 11 * 60_000), heartbeatAt: new Date(Date.now() - 11 * 60_000) },
    });
    const candidate3 = await stack.promotions.considerCandidate(w.projectId);
    assert.ok(candidate3);
    const ended = await jobRow(stack, check2.jobId);
    assert.equal(ended.state, 'ERROR', 'a dead runner\'s check is ended, not asked');
    assert.equal(ended.errorCode, 'RUNNER_LOST', 'a check never pushes (J12)');
    assert.equal(ended.cancelRequestedAt, null, 'no request is left standing over it');
    assert.equal(Number(ended.claimGeneration), Number(check2.claimGeneration) + 1);
    // Its serial slot is free: the new candidate's check is handed out at once.
    const next = await claim(stack, w);
    assert.notEqual(next.jobId, check2.jobId);
    assert.equal((await jobRow(stack, next.jobId)).promotionId, candidate3.promotionId);
    void first;
    void second;
    void third;
  });

  await t.test('(5) the owner cancels a timed-out LAND_PROMOTION: it ends PUSH_OUTCOME_UNKNOWN, the candidate is BLOCKED, and the serial slot frees', async () => {
    const w = await world(stack, 'cancel-timed-out-merge', 'MAIN');
    const { candidate } = await offered(stack, w, 'timed-out');
    const check = await claim(stack, w);
    await report(stack, w, check, CLEAN(sha('a')));
    await stack.promotions.confirm({ userId: w.ownerId }, w.projectId, candidate.id, sha('a'));
    const land = await claim(stack, w);
    assert.equal(land.kind, 'LAND_PROMOTION');
    await stack.db.projectIntegrationJob.update({
      where: { id: land.jobId },
      data: { claimedAt: new Date(Date.now() - 11 * 60_000), heartbeatAt: new Date(Date.now() - 11 * 60_000) },
    });

    const view = await stack.promotions.cancel({ userId: w.ownerId }, w.projectId, candidate.id);
    assert.equal(view.state, 'BLOCKED', 'an unknown push outcome cannot be recorded as cancelled');
    const ended = await jobRow(stack, land.jobId);
    assert.equal(ended.state, 'ERROR');
    assert.equal(ended.errorCode, 'PUSH_OUTCOME_UNKNOWN', 'a legacy landing claim cannot prove nothing was pushed');
    assert.equal((ended.errorDetail as { pushOutcome?: string }).pushOutcome, 'UNKNOWN');
    assert.equal(Number(ended.claimGeneration), Number(land.claimGeneration) + 1, 'the lost claim is fenced off');
    const late = await report(stack, w, land, { state: 'LANDED', phase: 'VERIFY', landedSha: sha('1'), testedSha: sha('2'), testedTreeSha: sha('3'), landedTreeSha: sha('3') });
    assert.equal(late.accepted, false, 'a late result of the ended claim is refused');

    // A second project landing into the same upstream shares the serial key (J1); its job is handed
    // out because the ended one no longer holds it.
    const other = await world(stack, 'same-upstream', 'MAIN', w.repoUrl);
    await doneTask(stack, other, 'other');
    const otherCodebase = await stack.db.projectCodebase.findFirstOrThrow({ where: { projectId: other.projectId } });
    const otherCandidate = await stack.db.projectPromotion.findFirstOrThrow({
      where: { projectId: other.projectId, sourceKind: 'TASK_BRANCH' },
    });
    const otherSession = await stack.db.session.findFirstOrThrow({ where: { taskId: otherCandidate.taskId! } });
    const queuedLanding = await stack.db.projectIntegrationJob.create({
      data: {
        ownerId: other.ownerId,
        projectId: other.projectId,
        codebaseId: otherCodebase.id,
        kind: 'LAND_PROMOTION',
        generation: 1,
        taskId: otherCandidate.taskId,
        sessionId: otherSession.id,
        promotionId: otherCandidate.id,
        serialKey: ended.serialKey,
        targetRef: other.upstreamRef,
        upstreamRef: other.upstreamRef,
        sourceRef: `refs/heads/${otherSession.branch}`,
        runnerId: other.runnerId,
        confirmedAutomatically: false,
        idempotencyKey: `ij:v1:LAND_PROMOTION:${otherCandidate.id}:1`,
      },
    });
    const handed = await beat(stack, other);
    assert.ok(handed.some((command) => command.jobId === queuedLanding.id),
      'the freed slot hands the next job out');
  });

  await t.test('(6) a task reopened and DONE again gets a new generation when the stopped one ends CANCELLED', async () => {
    const w = await world(stack, 'reopen-redone', 'PROJECT_BRANCH');
    const work = await doneTask(stack, w, 'redone');
    const first = await claim(stack, w);
    assert.equal(first.kind, 'LAND_TASK');

    // Taking the task away asks the running landing to stop (it is still reporting).
    await stack.tasks.update(w.ownerId, work.taskId, { status: TaskStatus.CANCELLED } as never);
    let row = await jobRow(stack, first.jobId);
    assert.equal(row.state, 'RUNNING');
    assert.ok(row.cancelRequestedAt);

    // Reopened and DONE again while that generation is still in flight: the DONE cannot queue (J3),
    // and the reopen marker is kept for the moment the stopped generation ends.
    await stack.tasks.update(w.ownerId, work.taskId, {
      status: TaskStatus.OPEN, supersededByTaskId: null, terminalReason: null,
    } as never);
    assert.ok(await stack.db.taskReopenIntent.findUnique({ where: { taskId: work.taskId } }),
      'the marker survives the DONE that could not queue');
    await stack.db.$executeRawUnsafe(
      `UPDATE "task" SET "status" = 'DONE' WHERE "id" = $1::uuid`, work.taskId,
    );
    const again = await stack.db.$transaction((tx) => enqueueForDoneTask(tx, w.ownerId, work.taskId));
    assert.equal(again.enqueued, false);
    assert.equal(again.reason, 'ALREADY_QUEUED');
    assert.ok(await stack.db.taskReopenIntent.findUnique({ where: { taskId: work.taskId } }),
      'the marker is kept while a stopped generation is in flight');

    // The stopped generation ends CANCELLED: the DONE's generation is queued in that transaction.
    const cancelled = await report(stack, w, first, { state: 'CANCELLED', phase: 'FETCH' });
    assert.equal(cancelled.accepted, true);
    assert.equal((await jobRow(stack, first.jobId)).state, 'CANCELLED');
    const rows = await stack.db.projectIntegrationJob.findMany({
      where: { taskId: work.taskId, kind: 'LAND_TASK' },
      orderBy: { generation: 'asc' },
    });
    assert.deepEqual(rows.map((job) => [job.generation, job.state]), [[1, 'CANCELLED'], [2, 'QUEUED']]);
    assert.equal(await stack.db.taskReopenIntent.findUnique({ where: { taskId: work.taskId } }), null,
      'the marker is consumed by the generation it was kept for');
    row = await jobRow(stack, rows[1]!.id);
    assert.equal(row.state, 'QUEUED');
  });

  await t.test('(11) a stopped generation that lands anyway still queues the DONE written after the reopen', async () => {
    const w = await world(stack, 'stopped-landed', 'PROJECT_BRANCH');
    const work = await doneTask(stack, w, 'stopped-landed');
    const first = await claim(stack, w);
    await stack.tasks.update(w.ownerId, work.taskId, { status: TaskStatus.CANCELLED } as never);
    await reopenAndRedo(stack, w, work.taskId);

    // Today's runner read `cancelRequested` once, at the start: the stop never reaches it, and it
    // reports the landing of the OLD content.
    const landed = await report(stack, w, first, {
      state: 'LANDED', phase: 'VERIFY', landedSha: sha('1'), targetShaBefore: sha('0'),
      testedSha: sha('2'), testedTreeSha: sha('3'), landedTreeSha: sha('3'), sourceSha: sha('a'),
      checks: [GREEN_CHECK], conflicts: [],
    });
    assert.equal(landed.accepted, true);
    const rows = await stack.db.projectIntegrationJob.findMany({
      where: { taskId: work.taskId, kind: 'LAND_TASK' },
      orderBy: { generation: 'asc' },
    });
    assert.deepEqual(rows.map((job) => [job.generation, job.state]), [[1, 'LANDED'], [2, 'QUEUED']],
      'the DONE written after the reopen is owed its own generation');
    assert.equal(await stack.db.taskReopenIntent.findUnique({ where: { taskId: work.taskId } }), null,
      'the marker is consumed by the generation it was kept for');
  });

  await t.test('(12) a stopped generation that fails still queues the next one, and opens no item', async () => {
    const w = await world(stack, 'stopped-failed', 'PROJECT_BRANCH');
    const work = await doneTask(stack, w, 'stopped-failed');
    const first = await claim(stack, w);
    await stack.tasks.update(w.ownerId, work.taskId, { status: TaskStatus.CANCELLED } as never);
    await reopenAndRedo(stack, w, work.taskId);

    const failed = await report(stack, w, first, {
      state: 'CHECK_FAILED', phase: 'CHECK', checks: [RED_CHECK], conflicts: [],
    });
    assert.equal(failed.accepted, true);
    assert.equal(failed.openItemId, null, 'nothing is opened about a landing nobody is waiting for');
    assert.equal(await stack.db.projectOpenItem.count({
      where: { projectId: w.projectId, kind: { startsWith: 'INTEGRATION_' }, state: 'OPEN' },
    }), 0);
    const rows = await stack.db.projectIntegrationJob.findMany({
      where: { taskId: work.taskId, kind: 'LAND_TASK' },
      orderBy: { generation: 'asc' },
    });
    assert.deepEqual(rows.map((job) => [job.generation, job.state]),
      [[1, 'CHECK_FAILED'], [2, 'QUEUED']]);
    assert.equal(await stack.db.taskReopenIntent.findUnique({ where: { taskId: work.taskId } }), null);
  });

  await t.test('(13) a stopped generation that answers too early ends CANCELLED and queues the next one', async () => {
    const w = await world(stack, 'stopped-early', 'PROJECT_BRANCH');
    const work = await doneTask(stack, w, 'stopped-early');
    const first = await claim(stack, w);
    await stack.tasks.update(w.ownerId, work.taskId, { status: TaskStatus.CANCELLED } as never);
    await reopenAndRedo(stack, w, work.taskId);

    // The work starts moving again after the claim, so the answer is too early (J-T1e).
    await stack.db.session.create({
      data: {
        ownerId: w.ownerId, creatorId: w.ownerId, taskId: work.taskId, workspaceId: w.workspaceId,
        assignedRunnerId: w.runnerId, title: 'still working', prompt: 'still working',
        branch: `orbit/still-${randomUUID().slice(0, 6)}`, isolationStatus: 'worktree',
        status: RunStatus.RUNNING, startsTaskWork: true, startedAt: new Date(),
      },
    });
    const early = await report(stack, w, first, {
      state: 'ALREADY_LANDED', phase: 'FETCH', sourceSha: sha('a'),
    });
    assert.equal(early.accepted, true);
    assert.equal(early.state, 'CANCELLED', 'the stopped claim ends; it does not go back to the queue');
    const rows = await stack.db.projectIntegrationJob.findMany({
      where: { taskId: work.taskId, kind: 'LAND_TASK' },
      orderBy: { generation: 'asc' },
    });
    assert.deepEqual(rows.map((job) => [job.generation, job.state]), [[1, 'CANCELLED'], [2, 'QUEUED']],
      'the DONE after the reopen is queued in the too-early branch too');
    assert.equal(await stack.db.taskReopenIntent.findUnique({ where: { taskId: work.taskId } }), null);
  });

  await t.test('(14) a result racing the DONE transaction cannot lose the next generation', async () => {
    const w = await world(stack, 'requeue-race', 'PROJECT_BRANCH');
    const work = await doneTask(stack, w, 'requeue-race');
    const first = await claim(stack, w);
    // Take the task away, then reopen it: the marker is written and the task is OPEN again. It has
    // NOT been written DONE yet — the DONE transaction is the one this result races.
    await stack.tasks.update(w.ownerId, work.taskId, { status: TaskStatus.CANCELLED } as never);
    await stack.tasks.update(w.ownerId, work.taskId, {
      status: TaskStatus.OPEN, supersededByTaskId: null, terminalReason: null,
    } as never);
    assert.ok(await stack.db.taskReopenIntent.findUnique({ where: { taskId: work.taskId } }));

    // D, the DONE transaction, in its own connection and not committed: task row (50), the project
    // binding (55), then the write. Its in-flight count would see this stopped generation as
    // RUNNING, answer ALREADY_QUEUED and keep the marker — the state the result must not race past.
    await sql.query('BEGIN');
    await sql.query(`SELECT "id" FROM "task" WHERE "id" = $1::uuid FOR UPDATE`, [work.taskId]);
    await sql.query(
      `SELECT "id" FROM "project_codebase" WHERE "project_id" = $1::uuid AND "slot" = 'primary' FOR UPDATE`,
      [w.projectId],
    );
    await sql.query(`UPDATE "task" SET "status" = 'DONE' WHERE "id" = $1::uuid`, [work.taskId]);

    // R, the result. With the binding taken first it waits here; without that lock it would commit
    // while D is still invisible, and both would decide the other was queueing.
    const result = stack.jobs.applyResult(first.jobId, w.runnerId, {
      claimGeneration: first.claimGeneration,
      leaseOwner: first.leaseOwner,
      state: 'CHECK_FAILED', phase: 'CHECK', checks: [RED_CHECK], conflicts: [],
    });
    let settled = false;
    void result.then(() => { settled = true; }, () => { settled = true; });
    const deadline = Date.now() + 10_000;
    let waiting = false;
    while (!settled && !waiting && Date.now() < deadline) {
      const [row] = await stack.db.$queryRaw<Array<{ n: number }>>(Prisma.sql`
        SELECT count(*)::int AS "n" FROM pg_stat_activity
         WHERE "wait_event_type" = 'Lock' AND "datname" = current_database()
           AND "pid" <> pg_backend_pid()`);
      waiting = (row?.n ?? 0) > 0;
      if (!waiting) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await sql.query('COMMIT');
    const answered = await result;

    assert.equal(answered.answer.accepted, true);
    const rows = await stack.db.projectIntegrationJob.findMany({
      where: { taskId: work.taskId, kind: 'LAND_TASK' },
      orderBy: { generation: 'asc' },
    });
    assert.deepEqual(rows.map((job) => [job.generation, job.state]),
      [[1, 'CHECK_FAILED'], [2, 'QUEUED']],
      'either D queued the DONE itself or R found it; neither may lose it');
    assert.equal(await stack.db.taskReopenIntent.findUnique({ where: { taskId: work.taskId } }), null);
  });

  await t.test('(15) a cancel asked before the push does not erase a landing that happened: MERGED, with a receipt', async () => {
    const w = await world(stack, 'landed-after-cancel', 'MAIN');
    const { candidate } = await offered(stack, w, 'landed-after-cancel');
    const check = await claim(stack, w);
    await report(stack, w, check, CLEAN(sha('a')));
    await stack.promotions.confirm({ userId: w.ownerId }, w.projectId, candidate.id, sha('a'));
    const land = await claim(stack, w);
    assert.equal(land.kind, 'LAND_PROMOTION');

    // The owner calls it back while the runner is still reporting: the job is asked to stop, and
    // the candidate stays CONFIRMED (M-T10/J-T8) — its result is what decides it.
    const view = await stack.promotions.cancel({ userId: w.ownerId }, w.projectId, candidate.id);
    assert.equal(view.state, 'CONFIRMED', 'a landing still reporting is asked, not declared stopped');
    assert.ok((await jobRow(stack, land.jobId)).cancelRequestedAt);

    // The runner had already pushed before it read the stop. The fact wins (M-T8): MERGED, and the
    // upstream receipt that says the work is there.
    const merged = await report(stack, w, land, {
      state: 'LANDED', phase: 'VERIFY', landedSha: sha('1'), targetShaBefore: sha('0'),
      upstreamSha: sha('0'), testedSha: sha('2'), testedTreeSha: sha('3'), landedTreeSha: sha('3'),
      sourceSha: sha('a'), checks: [GREEN_CHECK], conflicts: [],
    });
    assert.equal(merged.accepted, true);
    assert.equal((await jobRow(stack, land.jobId)).state, 'LANDED');
    const promotion = await stack.db.projectPromotion.findUniqueOrThrow({ where: { id: candidate.id } });
    assert.equal(promotion.state, 'MERGED', 'an answer that landed is not written off as cancelled');
    assert.equal(promotion.mergedSha, sha('1'));
    assert.ok(promotion.receiptIds.length > 0, 'the landing wrote its upstream receipt');
    assert.equal(await stack.db.sessionMergeReceipt.count({
      where: { id: { in: promotion.receiptIds } },
    }), promotion.receiptIds.length);
  });

  await t.test('(7) a stopped running landing that answers too early ends CANCELLED, never a QUEUED row with a stop', async () => {
    const w = await world(stack, 'too-early-cancel', 'PROJECT_BRANCH');
    const work = await doneTask(stack, w, 'early');
    const job = await claim(stack, w);
    await stack.tasks.update(w.ownerId, work.taskId, { status: TaskStatus.CANCELLED } as never);
    assert.ok((await jobRow(stack, job.jobId)).cancelRequestedAt);

    // The work starts moving again after the claim (J-T1e): an ALREADY_LANDED answer is too early.
    await stack.db.session.create({
      data: {
        ownerId: w.ownerId, creatorId: w.ownerId, taskId: work.taskId, workspaceId: w.workspaceId,
        assignedRunnerId: w.runnerId, title: 'still working', prompt: 'still working',
        branch: `orbit/still-${randomUUID().slice(0, 6)}`, isolationStatus: 'worktree',
        status: RunStatus.RUNNING, startsTaskWork: true, startedAt: new Date(),
      },
    });
    const tooEarly = await report(stack, w, job, { state: 'ALREADY_LANDED', phase: 'FETCH', sourceSha: sha('a') });
    assert.equal(tooEarly.accepted, true);
    assert.equal(tooEarly.state, 'CANCELLED', 'the stopped claim ends, it does not go back to the queue');
    const row = await jobRow(stack, job.jobId);
    assert.equal(row.state, 'CANCELLED');
    assert.ok(row.finishedAt);
    assert.equal(await stack.db.projectIntegrationJob.count({
      where: { taskId: work.taskId, state: 'QUEUED', cancelRequestedAt: { not: null } },
    }), 0, 'no QUEUED row carrying a stop request exists');
  });

  await t.test('(8) a stop asked of a QUEUED check ends it, and the upgrade insert refuses the old shape', async () => {
    const w = await world(stack, 'queued-check-stop', 'PROJECT_BRANCH');
    void w;
    // The CHECK itself: a QUEUED row cannot be given a stop request, whatever writes it.
    const anyWorld = await world(stack, 'check-constraint', 'PROJECT_BRANCH');
    const work = await doneTask(stack, anyWorld, 'constraint');
    const job = await stack.db.projectIntegrationJob.findFirstOrThrow({ where: { taskId: work.taskId } });
    await assert.rejects(
      stack.db.projectIntegrationJob.update({
        where: { id: job.id }, data: { cancelRequestedAt: new Date() },
      }),
      /project_integration_job_queued_cancel_chk/,
    );
    const still = await jobRow(stack, job.id);
    assert.equal(still.state, 'QUEUED');
    assert.equal(still.cancelRequestedAt, null);
  });

  await t.test('(10) a stopped claim whose task was NOT written DONE again opens no item and queues no generation', async () => {
    const w = await world(stack, 'stopped-result', 'PROJECT_BRANCH');
    const work = await doneTask(stack, w, 'stopped');
    const job = await claim(stack, w);
    await stack.tasks.update(w.ownerId, work.taskId, { status: TaskStatus.CANCELLED } as never);

    // A failure the runner reports before it reads the stop is kept on the row and opens nothing:
    // the task it was landing has already been taken away.
    const failed = await report(stack, w, job, {
      state: 'CHECK_FAILED', phase: 'CHECK', checks: [RED_CHECK], conflicts: [],
    });
    assert.equal(failed.accepted, true);
    assert.equal(failed.openItemId, null, 'no card about a landing nobody is waiting for');
    assert.equal(await stack.db.projectOpenItem.count({
      where: { projectId: w.projectId, kind: { startsWith: 'INTEGRATION_' }, state: 'OPEN' },
    }), 0);

    // An ALREADY_LANDED about a branch the work did not end on would ordinarily queue the branch
    // the work DID end on (J-T1e). A stopped claim does not: the stop is the answer.
    const second = await doneTask(stack, w, 'left-behind');
    const secondJob = await claim(stack, w);
    await stack.tasks.update(w.ownerId, second.taskId, { status: TaskStatus.CANCELLED } as never);
    const before = await stack.db.projectIntegrationJob.count({
      where: { taskId: second.taskId, kind: 'LAND_TASK' },
    });
    const left = await report(stack, w, secondJob, {
      state: 'ALREADY_LANDED', phase: 'VERIFY', sourceSha: sha('e'),
    });
    assert.equal(left.accepted, true);
    const after = await stack.db.projectIntegrationJob.count({
      where: { taskId: second.taskId, kind: 'LAND_TASK' },
    });
    assert.equal(after, before, 'no generation was queued behind a stopped one');
  });

  await t.test('(9) the 0433 backfill replays on representative rows, and the CHECK refuses a new one', async () => {
    // Take the constraint out so the pre-migration shape can be stored, as the data predates it.
    await sql.query(`ALTER TABLE "project_integration_job" DROP CONSTRAINT IF EXISTS "project_integration_job_queued_cancel_chk"`);
    const w = await world(stack, 'backfill', 'MAIN');
    const { candidate } = await offered(stack, w, 'backfill');
    const codebase = await stack.db.projectCodebase.findFirstOrThrow({ where: { projectId: w.projectId } });
    const work = await stack.db.session.findFirstOrThrow({ where: { taskId: candidate.taskId! } });
    const queuedLanding = await stack.db.projectIntegrationJob.create({
      data: {
        ownerId: w.ownerId,
        projectId: w.projectId,
        codebaseId: codebase.id,
        kind: 'LAND_PROMOTION',
        generation: 1,
        taskId: candidate.taskId,
        sessionId: work.id,
        promotionId: candidate.id,
        serialKey: integrationSerialKey({
          kind: 'LAND_PROMOTION', canonicalRepoUrl: w.repoUrl, targetRef: w.upstreamRef, projectId: w.projectId,
        }),
        targetRef: w.upstreamRef,
        upstreamRef: w.upstreamRef,
        sourceRef: `refs/heads/${work.branch}`,
        runnerId: w.runnerId,
        cancelRequestedAt: new Date(Date.now() - 60_000),
        idempotencyKey: `ij:v1:LAND_PROMOTION:${candidate.id}:1`,
      },
    });
    await stack.db.projectPromotion.update({
      where: { id: candidate.id },
      data: { state: 'CONFIRMED', confirmedByUserId: w.ownerId, confirmedAt: new Date(), landJobId: queuedLanding.id },
    });
    const item = await stack.db.projectOpenItem.create({
      data: {
        projectId: w.projectId,
        ownerId: w.ownerId,
        kind: 'INTEGRATION_ERROR',
        assignee: 'COORDINATOR',
        assigneeReason: 'NO_COORDINATOR',
        title: 'a failure about the merge',
        payload: {},
        promotionId: candidate.id,
        dedupeKey: `backfill-item-${candidate.id}`,
        waitingSince: new Date(),
        assignedAt: new Date(),
      },
    });
    // A second representative: a QUEUED LAND_TASK with a stop request, on a project branch.
    const w2 = await world(stack, 'backfill-task', 'PROJECT_BRANCH');
    const taskWork = await doneTask(stack, w2, 'backfill-task');
    const queuedTask = await stack.db.projectIntegrationJob.findFirstOrThrow({
      where: { taskId: taskWork.taskId, kind: 'LAND_TASK' },
    });
    await stack.db.projectIntegrationJob.update({
      where: { id: queuedTask.id }, data: { cancelRequestedAt: new Date(Date.now() - 30_000) },
    });

    await sql.query(readFileSync(MIGRATION, 'utf8'));

    const endedLanding = await jobRow(stack, queuedLanding.id);
    assert.equal(endedLanding.state, 'CANCELLED');
    assert.ok(endedLanding.finishedAt);
    assert.ok(endedLanding.cancelRequestedAt, 'the request that ended it stays recorded');
    const endedTask = await jobRow(stack, queuedTask.id);
    assert.equal(endedTask.state, 'CANCELLED');
    assert.ok(endedTask.finishedAt);
    const promotion = await stack.db.projectPromotion.findUniqueOrThrow({ where: { id: candidate.id } });
    assert.equal(promotion.state, 'CANCELLED', 'a queued landing can never have pushed (M-T10)');
    assert.ok(promotion.decidedAt);
    const closed = await stack.db.projectOpenItem.findUniqueOrThrow({ where: { id: item.id } });
    assert.deepEqual(
      [closed.state, closed.resolution, closed.resolvedBy],
      ['RESOLVED', 'PROMOTION_MOVED_ON', 'PLATFORM'],
    );

    // Replayed, it writes nothing new: the predicate no longer matches.
    await sql.query(readFileSync(MIGRATION, 'utf8'));
    assert.equal((await jobRow(stack, queuedLanding.id)).state, 'CANCELLED');
    // And the invariant is installed: a QUEUED row cannot be INSERTED with a stop request (23514).
    const w2Codebase = await stack.db.projectCodebase.findFirstOrThrow({ where: { projectId: w2.projectId } });
    await assert.rejects(
      stack.db.projectIntegrationJob.create({
        data: {
          ownerId: w2.ownerId,
          projectId: w2.projectId,
          codebaseId: w2Codebase.id,
          kind: 'LAND_TASK',
          taskId: taskWork.taskId,
          sessionId: taskWork.sessionId,
          serialKey: `${w2.repoUrl}#${w2.integrationRef}`,
          targetRef: w2.integrationRef,
          upstreamRef: w2.upstreamRef,
          sourceRef: `refs/heads/${taskWork.branch}`,
          runnerId: w2.runnerId,
          cancelRequestedAt: new Date(),
          idempotencyKey: `ij:v1:LAND_TASK:${taskWork.taskId}:99`,
        },
      }),
      /project_integration_job_queued_cancel_chk|violates check constraint/,
    );
  });
});

// ── J12's receipt repair: an unknown push found later, by the next landing on the queue ─────────

/** The synchronous PUSH report a v2 runner sends before it pushes (§2.2 J-T4, J12): the commit it
 *  is about to push and what the row has to keep in case nobody hears from it again. */
function pushReport(
  stack: Stack,
  w: World,
  job: { jobId: string; claimGeneration: string; leaseOwner: string },
  facts: { testedSha: string; testedTreeSha: string; sourceSha: string; targetShaBefore: string },
) {
  return stack.jobs.progress(w.runnerId, job.jobId, {
    claimGeneration: job.claimGeneration,
    leaseOwner: job.leaseOwner,
    phase: 'PUSH',
    ...facts,
  });
}

/** A landing left silent past its claim limit, so the next door that asks ends it as J12 says. */
async function goSilent(stack: Stack, jobId: string): Promise<void> {
  await stack.db.projectIntegrationJob.update({
    where: { id: jobId },
    data: { claimedAt: new Date(Date.now() - 11 * 60_000), heartbeatAt: new Date(Date.now() - 11 * 60_000) },
  });
}

function receiptsForUnknown(db: PrismaClient, jobId: string) {
  return db.sessionMergeReceipt.findMany({
    where: { detail: { path: ['integrationJobId'], equals: jobId } },
    select: { id: true, taskId: true, result: true, sourceSha: true, targetShaBefore: true, targetShaAfter: true, detail: true },
  });
}

test('J12: the next landing on a serial key repairs a push whose outcome nobody could read', {
  skip, concurrency: 1, timeout: 600_000,
}, async (t) => {
  const stack = await connect();
  t.after(async () => {
    await stack.db.$disconnect().catch(() => undefined);
  });

  /** One MAIN-line world whose promotion landing ended PUSH_OUTCOME_UNKNOWN after recording its
   *  PUSH report, and the next landing queued on the same serial key by a second project of the
   *  same account (the queue one runner may be told about). */
  async function unknownPushOnTheQueue(label: string) {
    const w = await world(stack, label, 'MAIN');
    const { taskId, candidate } = await offered(stack, w, label);
    const check = await claim(stack, w);
    await report(stack, w, check, CLEAN(sha('a')));
    await stack.promotions.confirm({ userId: w.ownerId }, w.projectId, candidate.id, sha('a'));
    const land = await claim(stack, w);
    assert.equal(land.kind, 'LAND_PROMOTION');
    const tested = sha('1');
    await pushReport(stack, w, land, {
      testedSha: tested,
      testedTreeSha: sha('2'),
      sourceSha: sha('3'),
      targetShaBefore: UPSTREAM_TIP,
    });
    await goSilent(stack, land.jobId);
    // The door that ends a silent claim: the owner's Cancel refuses once the push boundary is
    // passed (M-T10), but the abandon / stop path ends it as the ERROR it is, and the candidate with
    // it — which is the shape J12's repair is for.
    const stopped = await stack.db.$transaction((tx) => stopInFlightJob(tx, {
      projectId: w.projectId, jobId: land.jobId, now: new Date(),
    }));
    assert.equal(stopped.outcome, 'ENDED');
    assert.equal(stopped.errorCode, 'PUSH_OUTCOME_UNKNOWN');
    await stack.db.projectPromotion.update({
      where: { id: candidate.id },
      data: { state: 'BLOCKED', blockedReason: 'ERROR', decidedAt: new Date() },
    });
    const ended = await stack.db.projectIntegrationJob.findUniqueOrThrow({
      where: { id: land.jobId },
      select: { id: true, state: true, errorCode: true, testedSha: true, serialKey: true, claimGeneration: true },
    });
    assert.equal(ended.state, 'ERROR');
    assert.equal(ended.errorCode, 'PUSH_OUTCOME_UNKNOWN');
    assert.equal(ended.testedSha, tested, 'the PUSH report left the row the commit to check');

    // The next landing on this serial key is this ACCOUNT's — the runner of another account is
    // never told about a job of this one (tenant isolation), so the repair happens on the same
    // account's queue.
    const other = await world(stack, `${label}-next`, 'MAIN', w.repoUrl, w.ownerId);
    await doneTask(stack, other, `${label}-other`);
    const otherCodebase = await stack.db.projectCodebase.findFirstOrThrow({ where: { projectId: other.projectId } });
    const otherCandidate = await stack.db.projectPromotion.findFirstOrThrow({
      where: { projectId: other.projectId, sourceKind: 'TASK_BRANCH' },
    });
    const otherSession = await stack.db.session.findFirstOrThrow({ where: { taskId: otherCandidate.taskId! } });
    const nextJob = await stack.db.projectIntegrationJob.create({
      data: {
        ownerId: other.ownerId,
        projectId: other.projectId,
        codebaseId: otherCodebase.id,
        kind: 'LAND_PROMOTION',
        generation: 1,
        taskId: otherCandidate.taskId,
        sessionId: otherSession.id,
        promotionId: otherCandidate.id,
        serialKey: ended.serialKey,
        targetRef: other.upstreamRef,
        upstreamRef: other.upstreamRef,
        sourceRef: `refs/heads/${otherSession.branch}`,
        runnerId: other.runnerId,
        confirmedAutomatically: false,
        idempotencyKey: `ij:v1:LAND_PROMOTION:${otherCandidate.id}:1`,
      },
    });
    return { w, other, taskId, ended, nextJob };
  }

  await t.test('(1) a LAND_PROMOTION: found on the target, the receipt is written against the unknown job and the old row is unchanged', async () => {
    const { other, ended, nextJob } = await unknownPushOnTheQueue('unknown-found');
    const handed = (await beat(stack, other)).find((command) => command.jobId === nextJob.id);
    assert.ok(handed, 'the next landing is handed out');
    assert.deepEqual(handed!.unknownPushes, [{ jobId: ended.id, testedSha: ended.testedSha }],
      'the next landing is told which earlier result to check');

    const before = await stack.db.projectIntegrationJob.findUniqueOrThrow({ where: { id: ended.id } });
    // This landing's own answer is a push that was rejected for a reason that is not a race; what
    // matters here is that its result transaction is the one that repairs the earlier unknown push.
    const taken = await report(stack, other, handed!, {
      state: 'ERROR',
      phase: 'PUSH',
      errorCode: 'PUSH_REJECTED',
      unknownPushes: [{ jobId: ended.id, landed: true }],
    });
    assert.equal(taken.accepted, true);
    const receipts = await receiptsForUnknown(stack.db, ended.id);
    assert.equal(receipts.length, 1, 'the unknown push was found on the target: its receipt exists now');
    assert.equal(receipts[0]!.result, 'MERGED');
    assert.equal(receipts[0]!.targetShaAfter, ended.testedSha, 'the commit that was pushed is where the target went');
    assert.equal((receipts[0]!.detail as { recoveredUnknownPush?: boolean }).recoveredUnknownPush, true,
      'the ledger says this receipt is a repair');
    assert.ok(taken.receiptIds.includes(receipts[0]!.id), 'the job that wrote it keeps it beside its own');
    const after = await stack.db.projectIntegrationJob.findUniqueOrThrow({ where: { id: ended.id } });
    assert.deepEqual(after, before, 'the old ERROR row is not rewritten (J4)');
  });

  await t.test('(2) not found on the target: nothing is written', async () => {
    const { other, ended, nextJob } = await unknownPushOnTheQueue('unknown-absent');
    const handed = (await beat(stack, other)).find((command) => command.jobId === nextJob.id);
    assert.ok(handed, 'the next landing is handed out');
    await report(stack, other, handed!, {
      state: 'ERROR',
      phase: 'PUSH',
      errorCode: 'PUSH_REJECTED',
      unknownPushes: [{ jobId: ended.id, landed: false }],
    });
    assert.deepEqual(await receiptsForUnknown(stack.db, ended.id), [],
      'a commit that is not on the target is not a landing');
  });

  await t.test('(3) a result that names no checks at all (an older runner) writes nothing', async () => {
    const { other, ended, nextJob } = await unknownPushOnTheQueue('unknown-old-runner');
    const handed = (await beat(stack, other)).find((command) => command.jobId === nextJob.id);
    assert.ok(handed, 'the next landing is handed out');
    await report(stack, other, handed!, {
      state: 'ERROR',
      phase: 'PUSH',
      errorCode: 'PUSH_REJECTED',
    });
    assert.deepEqual(await receiptsForUnknown(stack.db, ended.id), [],
      'a runner that does not check leaves the unknown result to the coordinator, as before');
  });

  await t.test('(4) a LAND_TASK: the J8 receipt is written against the unknown job, with the facts its PUSH report left', async () => {
    const w = await world(stack, 'unknown-task', 'PROJECT_BRANCH');
    const work = await doneTask(stack, w, 'unknown-task');
    const land = await claim(stack, w);
    assert.equal(land.kind, 'LAND_TASK');
    const tested = sha('7');
    const source = sha('8');
    await pushReport(stack, w, land, {
      testedSha: tested,
      testedTreeSha: sha('9'),
      sourceSha: source,
      targetShaBefore: sha('a'),
    });
    await goSilent(stack, land.jobId);
    await stack.tasks.update(w.ownerId, work.taskId, { status: TaskStatus.CANCELLED } as never);
    const ended = await stack.db.projectIntegrationJob.findUniqueOrThrow({
      where: { id: land.jobId },
      select: { id: true, state: true, errorCode: true, testedSha: true },
    });
    assert.equal(ended.state, 'ERROR');
    assert.equal(ended.errorCode, 'PUSH_OUTCOME_UNKNOWN');
    assert.equal(ended.testedSha, tested);

    await doneTask(stack, w, 'unknown-task-next');
    const [handed] = await beat(stack, w);
    assert.ok(handed, 'the next landing is handed out');
    assert.deepEqual(handed!.unknownPushes, [{ jobId: ended.id, testedSha: tested }]);
    await report(stack, w, handed!, {
      state: 'LANDED',
      phase: 'VERIFY',
      sourceSha: sha('b'),
      targetShaBefore: sha('c'),
      testedSha: sha('d'),
      testedTreeSha: sha('e'),
      landedSha: sha('d'),
      landedTreeSha: sha('e'),
      unknownPushes: [{ jobId: ended.id, landed: true }],
    });
    const receipts = await receiptsForUnknown(stack.db, ended.id);
    assert.equal(receipts.length, 1, 'J8\'s receipt, written after the fact');
    assert.equal(receipts[0]!.taskId, work.taskId);
    assert.equal(receipts[0]!.result, 'MERGED');
    assert.equal(receipts[0]!.sourceSha, source, 'the branch tip the PUSH report left');
    assert.equal(receipts[0]!.targetShaAfter, tested);
    const after = await stack.db.projectIntegrationJob.findUniqueOrThrow({ where: { id: ended.id } });
    assert.equal(after.state, 'ERROR');
    assert.equal(after.errorCode, 'PUSH_OUTCOME_UNKNOWN');
  });
});
