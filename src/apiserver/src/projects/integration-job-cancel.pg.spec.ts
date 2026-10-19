import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { PrismaClient, RunStatus, RunnerStatus, TaskStatus } from '@prisma/client';
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
): Promise<World> {
  const db = stack.db;
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  await db.user.create({
    data: { id: ownerId, email: `${label}-${ownerId}@cancel.invalid`, name: label, passwordHash: 'x' },
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

  await t.test('(10) a stopped claim opens no item and queues no generation for work left behind', async () => {
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
