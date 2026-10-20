import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { Prisma, PrismaClient, RunStatus, RunnerStatus } from '@prisma/client';
import { Client } from 'pg';

import { IntegrationCheckResult, IntegrationJobCommand, IntegrationJobResultRequest } from '@orbit/shared';

import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { QueueService } from '../queue/queue.service';
import { RealtimeService } from '../realtime/realtime.service';
import {
  IntegrationAbandonRefused,
  IntegrationJobRefused,
  IntegrationJobRelay,
  abandonIntegrationJob,
  receiveIntegrationJobProgress,
} from '../runner-api/integration-job-relay';
import { ProjectIntegrationRetryController } from './project-integration-retry.controller';
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
  endTimedOutLanding,
  enqueueForDoneTask,
} from './project-integration-job';
import { configureProjectIntegration, readInFlightJobs } from './project-integration-line';
import { ProjectPromotionService } from './project-promotion.service';

/**
 * The two doors that take work off the integration line without retrying it — the abandon door
 * (contract §2.2 J-T10, §4.7) and the owner's `LAND_TASK` stop (§2.2 J-T8):
 *
 *   * abandon's gate is LEASE_EXPIRED, read by §7.2 V6's one definition: a live claim is refused,
 *     a non-RUNNING job is refused, and only the project's current coordinator may press the
 *     runner door;
 *   * its answer is J12's: a v2 claim that recorded no PUSH — and every CHECK_PROMOTION — is
 *     RUNNER_LOST ("nothing was pushed"); a v2 claim that recorded PUSH, and every legacy landing
 *     claim, is PUSH_OUTCOME_UNKNOWN ("may have been pushed");
 *   * it ends the job as ERROR, opens the INTEGRATION_ERROR item (unless the generation had
 *     already been asked to stop — J-T8's exception, revision 24), moves a promotion to BLOCKED,
 *     queues no next generation, closes the claim to late reports and results, and releases the
 *     serial slot so the next job is claimed on the next beat;
 *   * stop ends a QUEUED landing CANCELLED on the spot, asks a live RUNNING claim
 *     (`cancel_requested_at`, settled by its result), ends one already past its lease as ERROR, and
 *     is refused past the push boundary and when nothing is in flight.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/projects/integration-abandon.pg.spec.ts
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
  /** The conversation the project is coordinated from, for the runner door. */
  coordinatorSessionId: string;
}

/** One project with its own owner, runner, workspace and coordinator session, and a started line. */
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
    data: { id: ownerId, email: `${label}-${ownerId}@abandon.invalid`, name: label, passwordHash: 'x' },
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
      coordinatorWorkspaceId: workspaceId, coordinatorSessionId,
    },
  });
  await db.projectRuntime.upsert({ where: { projectId }, create: { projectId }, update: {} });
  await db.$transaction((tx) => configureProjectIntegration(tx, {
    ownerId, projectId, settings: { line },
  }));
  return { label, ownerId, runnerId, workspaceId, projectId, repoUrl, coordinatorSessionId };
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
      cancelRequestedAt: true, heartbeatAt: true, errorCode: true, errorDetail: true,
      finishedAt: true, promotionId: true, taskId: true,
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
    if (error instanceof IntegrationAbandonRefused) return error.refusal;
    if (error instanceof IntegrationJobRefused) return error.refusal;
    throw error;
  }
  return 'ACCEPTED';
}

/** A MAIN-line world's offered candidate. */
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

/** A MAIN-line world with a candidate whose check passed and was confirmed, so its landing is QUEUED. */
async function confirmedLanding(stack: Stack, w: World, label: string) {
  const { candidate } = await offered(stack, w, label);
  const check = await claim(stack, w);
  assert.equal(check.kind, 'CHECK_PROMOTION');
  await report(stack, w, check, CLEAN(sha('a')));
  await stack.promotions.confirm({ userId: w.ownerId }, w.projectId, candidate.id, sha('a'));
  return { candidate };
}

test('abandon: the lease gate, J12\'s code, and only-end-never-re-queue', {
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

  await t.test('(1) the gate: a live claim is refused, a queued or finished job is not RUNNING', async () => {
    const w = await world(stack, 'gate', 'PROJECT_BRANCH');
    const { taskId } = await doneTask(stack, w, 'gate');
    const queued = await stack.db.projectIntegrationJob.findFirstOrThrow({
      where: { taskId, kind: 'LAND_TASK', state: 'QUEUED' },
    });
    // A queued job was never claimed, so there is no lease to abandon.
    assert.equal(await refusal(abandonIntegrationJob(stack.prisma, {
      jobId: queued.id, projectId: w.projectId, ownerId: w.ownerId, by: 'owner',
    })), 'NOT_RUNNING');

    const job = await claim(stack, w);
    // The claim is fresh: its lease is live, and abandoning it would end work somebody is doing.
    assert.equal(await refusal(abandonIntegrationJob(stack.prisma, {
      jobId: job.jobId, projectId: w.projectId, ownerId: w.ownerId, by: 'owner',
    })), 'LEASE_LIVE');
    assert.equal((await jobRow(stack, job.jobId)).state, 'RUNNING');

    // A finished job is not RUNNING either.
    await report(stack, w, job, { state: 'ERROR', phase: 'FETCH', errorCode: 'FETCH_FAILED' });
    assert.equal(await refusal(abandonIntegrationJob(stack.prisma, {
      jobId: job.jobId, projectId: w.projectId, ownerId: w.ownerId, by: 'owner',
    })), 'NOT_RUNNING');

    // Another project's job, and a job of another account, are answered as ids that name nothing.
    const other = await world(stack, 'gate-other', 'PROJECT_BRANCH');
    assert.equal(await refusal(abandonIntegrationJob(stack.prisma, {
      jobId: job.jobId, projectId: other.projectId, ownerId: other.ownerId, by: 'owner',
    })), 'NOT_FOUND');
  });

  await t.test('(2) only the project\'s current coordinator may press the runner door', async () => {
    const w = await world(stack, 'coordinator', 'PROJECT_BRANCH');
    await doneTask(stack, w, 'coordinator');
    const job = await claim(stack, w);
    await ageClaim(stack, job.jobId, 11 * 60_000);

    assert.equal(await refusal(abandonIntegrationJob(stack.prisma, {
      jobId: job.jobId, projectId: w.projectId, ownerId: w.ownerId,
      by: 'coordinator', sessionId: randomUUID(), reason: 'its runner is gone',
    })), 'COORDINATOR_ONLY');
    assert.equal(await refusal(abandonIntegrationJob(stack.prisma, {
      jobId: job.jobId, projectId: w.projectId, ownerId: w.ownerId,
      by: 'coordinator', reason: 'its runner is gone',
    })), 'COORDINATOR_ONLY', 'a missing header is never read as the owner');
    assert.equal((await jobRow(stack, job.jobId)).state, 'RUNNING');

    // The project's own coordinator presses it, and the reason reaches the record.
    const abandoned = await abandonIntegrationJob(stack.prisma, {
      jobId: job.jobId, projectId: w.projectId, ownerId: w.ownerId,
      by: 'coordinator', sessionId: w.coordinatorSessionId, reason: 'the runner was fenced',
    });
    assert.equal(abandoned.abandoned.state, 'ERROR');
    const row = await jobRow(stack, job.jobId);
    assert.equal(row.state, 'ERROR');
    const detail = row.errorDetail as { abandoned: boolean; by: string; reason: string; sessionId: string };
    assert.equal(detail.abandoned, true);
    assert.equal(detail.by, 'coordinator');
    assert.equal(detail.reason, 'the runner was fenced');
    assert.equal(detail.sessionId, w.coordinatorSessionId);
  });

  await t.test('(3) J12: a v2 claim without PUSH is RUNNER_LOST; with PUSH it may have pushed', async () => {
    const clean = await world(stack, 'code-v2-clean', 'PROJECT_BRANCH');
    await doneTask(stack, clean, 'code-v2-clean');
    const cleanJob = await claim(stack, clean);
    await ageClaim(stack, cleanJob.jobId, 11 * 60_000);
    const lost = await abandonIntegrationJob(stack.prisma, {
      jobId: cleanJob.jobId, projectId: clean.projectId, ownerId: clean.ownerId, by: 'owner',
    });
    assert.equal(lost.abandoned.errorCode, 'RUNNER_LOST');
    const lostRow = await jobRow(stack, cleanJob.jobId);
    assert.equal(lostRow.errorCode, 'RUNNER_LOST');
    assert.equal((lostRow.errorDetail as { pushOutcome: string }).pushOutcome, 'NOT_PUSHED');
    assert.equal((lostRow.errorDetail as { by: string }).by, 'owner');

    const pushed = await world(stack, 'code-v2-pushed', 'PROJECT_BRANCH');
    await doneTask(stack, pushed, 'code-v2-pushed');
    const pushJob = await claim(stack, pushed);
    await receiveIntegrationJobProgress(stack.prisma, pushed.runnerId, pushJob.jobId, {
      claimGeneration: pushJob.claimGeneration, leaseOwner: pushJob.leaseOwner, phase: 'PUSH',
    });
    await ageClaim(stack, pushJob.jobId, 11 * 60_000);
    const unknown = await abandonIntegrationJob(stack.prisma, {
      jobId: pushJob.jobId, projectId: pushed.projectId, ownerId: pushed.ownerId, by: 'owner',
    });
    assert.equal(unknown.abandoned.errorCode, 'PUSH_OUTCOME_UNKNOWN');
    assert.equal(
      ((await jobRow(stack, pushJob.jobId)).errorDetail as { pushOutcome: string }).pushOutcome,
      'UNKNOWN',
    );
  });

  await t.test('(3b) J12: what an abandoned PUSH report left is offered to the next landing on the key', async () => {
    // The v2 PUSH report records the commit about to be pushed; the abandon that follows cannot say
    // whether it went out. The row keeps `tested_sha`, and the next landing on the same serial key
    // is handed it so its own fetch can check and repair (J12) — the abandon door enters the repair
    // exactly as a stop does.
    const w = await world(stack, 'repair', 'PROJECT_BRANCH');
    await doneTask(stack, w, 'repair-first');
    const land = await claim(stack, w);
    assert.equal(land.kind, 'LAND_TASK');
    const tested = sha('6');
    await receiveIntegrationJobProgress(stack.prisma, w.runnerId, land.jobId, {
      claimGeneration: land.claimGeneration,
      leaseOwner: land.leaseOwner,
      phase: 'PUSH',
      testedSha: tested,
      testedTreeSha: sha('7'),
      sourceSha: sha('8'),
      targetShaBefore: UPSTREAM_TIP,
    });
    await ageClaim(stack, land.jobId, 11 * 60_000);
    const abandoned = await abandonIntegrationJob(stack.prisma, {
      jobId: land.jobId, projectId: w.projectId, ownerId: w.ownerId, by: 'owner',
    });
    assert.equal(abandoned.abandoned.errorCode, 'PUSH_OUTCOME_UNKNOWN');
    const ended = await stack.db.projectIntegrationJob.findUniqueOrThrow({
      where: { id: land.jobId }, select: { testedSha: true },
    });
    assert.equal(ended.testedSha, tested, 'the PUSH report left the commit the next landing must check');

    await doneTask(stack, w, 'repair-next');
    const [handed] = await beat(stack, w);
    assert.ok(handed, 'the next landing is handed out on the released slot');
    assert.deepEqual(handed!.unknownPushes, [{ jobId: land.jobId, testedSha: tested }],
      'the abandoned unknown push is offered to the repair');
  });

  await t.test('(4) J12: a legacy landing may have pushed, and a check never can', async () => {
    const legacy = await world(stack, 'code-legacy', 'PROJECT_BRANCH');
    await doneTask(stack, legacy, 'code-legacy');
    const legacyJob = await claim(stack, legacy, [INTEGRATION_JOB_CLAIM]);
    await ageClaim(stack, legacyJob.jobId, 11 * 60_000);
    assert.equal((await abandonIntegrationJob(stack.prisma, {
      jobId: legacyJob.jobId, projectId: legacy.projectId, ownerId: legacy.ownerId, by: 'owner',
    })).abandoned.errorCode, 'PUSH_OUTCOME_UNKNOWN');

    const main = await world(stack, 'code-check', 'MAIN');
    await doneTask(stack, main, 'code-check');
    const check = await claim(stack, main);
    assert.equal(check.kind, 'CHECK_PROMOTION');
    await ageClaim(stack, check.jobId, 11 * 60_000);
    assert.equal((await abandonIntegrationJob(stack.prisma, {
      jobId: check.jobId, projectId: main.projectId, ownerId: main.ownerId, by: 'owner',
    })).abandoned.errorCode, 'RUNNER_LOST');
    assert.equal(
      ((await jobRow(stack, check.jobId)).errorDetail as { pushOutcome: string }).pushOutcome,
      'NOT_PUSHED',
    );
  });

  await t.test('(5) a landing: ERROR, an exception item, no next generation, and the slot is released', async () => {
    const w = await world(stack, 'slot', 'PROJECT_BRANCH');
    const first = await doneTask(stack, w, 'slot-first');
    const firstJob = await claim(stack, w);
    // A second task's landing queues behind the first on the same repository-and-branch slot.
    const second = await doneTask(stack, w, 'slot-second');
    const behind = await stack.db.projectIntegrationJob.findFirstOrThrow({
      where: { taskId: second.taskId, kind: 'LAND_TASK', state: 'QUEUED' },
    });
    assert.equal((await beat(stack, w)).length, 0, 'the slot is held by the running landing');

    await ageClaim(stack, firstJob.jobId, 11 * 60_000);
    const abandoned = await abandonIntegrationJob(stack.prisma, {
      jobId: firstJob.jobId, projectId: w.projectId, ownerId: w.ownerId, by: 'owner',
    });
    assert.equal(abandoned.abandoned.errorCode, 'RUNNER_LOST');

    // Only end, never re-queue: the abandoned task still has exactly one LAND_TASK.
    assert.equal(
      await stack.db.projectIntegrationJob.count({ where: { taskId: first.taskId, kind: 'LAND_TASK' } }),
      1,
    );
    // J-T10 / §4's INTEGRATION_ERROR row: an abandoned generation that was NOT stopped opens the
    // item a runner-reported ERROR would. Its work is not on the line, no result will ever say so,
    // and the item is the door through which the coordinator reaches integration_retry.
    assert.ok(abandoned.abandoned.openItemId, 'the abandon opened the failure item');
    const item = await stack.db.projectOpenItem.findUniqueOrThrow({
      where: { id: abandoned.abandoned.openItemId! },
    });
    assert.equal(item.kind, 'INTEGRATION_ERROR');
    assert.equal(item.state, 'OPEN');
    assert.equal(item.integrationJobId, firstJob.jobId);

    // The next job on the same serial key is claimed on the very next beat.
    const [next] = await beat(stack, w);
    assert.equal(next?.jobId, behind.id, 'the released slot goes to the job behind it');
  });

  await t.test('(6) a promotion: BLOCKED, no next job, and its item says it may have pushed', async () => {
    // LAND_PROMOTION, legacy: the push outcome is unknown, so the merge cannot read as cancelled.
    const landing = await world(stack, 'promo-landing', 'MAIN');
    const confirmed = await confirmedLanding(stack, landing, 'promo-landing');
    const landingJob = await claim(stack, landing, [INTEGRATION_JOB_CLAIM]);
    assert.equal(landingJob.kind, 'LAND_PROMOTION');
    await ageClaim(stack, landingJob.jobId, 11 * 60_000);
    assert.equal((await abandonIntegrationJob(stack.prisma, {
      jobId: landingJob.jobId, projectId: landing.projectId, ownerId: landing.ownerId, by: 'owner',
    })).abandoned.errorCode, 'PUSH_OUTCOME_UNKNOWN');
    assert.equal(
      (await stack.db.projectPromotion.findUniqueOrThrow({ where: { id: confirmed.candidate.id } })).state,
      'BLOCKED',
    );
    assert.equal(
      await stack.db.projectIntegrationJob.count({
        where: { promotionId: confirmed.candidate.id, kind: 'LAND_PROMOTION' },
      }),
      1,
      'nothing is queued in its place',
    );
    // The promotion's failure is a card like any other ERROR's, and it names the candidate.
    const landingItem = await stack.db.projectOpenItem.findFirstOrThrow({
      where: { integrationJobId: landingJob.jobId },
    });
    assert.equal(landingItem.kind, 'INTEGRATION_ERROR');
    assert.equal(landingItem.promotionId, confirmed.candidate.id);

    // CHECK_PROMOTION: the check never pushes, so its end says nothing was pushed and blocks the
    // candidate the same way an error from its runner would.
    const checking = await world(stack, 'promo-check', 'MAIN');
    const { candidate } = await offered(stack, checking, 'promo-check');
    const check = await claim(stack, checking);
    assert.equal(check.kind, 'CHECK_PROMOTION');
    await ageClaim(stack, check.jobId, 11 * 60_000);
    assert.equal((await abandonIntegrationJob(stack.prisma, {
      jobId: check.jobId, projectId: checking.projectId, ownerId: checking.ownerId, by: 'owner',
    })).abandoned.errorCode, 'RUNNER_LOST');
    assert.equal(
      (await stack.db.projectPromotion.findUniqueOrThrow({ where: { id: candidate.id } })).state,
      'BLOCKED',
    );
    assert.equal(
      await stack.db.projectIntegrationJob.count({ where: { promotionId: candidate.id, kind: 'CHECK_PROMOTION' } }),
      1,
    );
    const checkItem = await stack.db.projectOpenItem.findFirstOrThrow({
      where: { integrationJobId: check.jobId },
    });
    assert.equal(checkItem.kind, 'INTEGRATION_ERROR');
    assert.equal(checkItem.promotionId, candidate.id);
  });

  await t.test('(7) late reports and results are refused, and the claim generation moved on', async () => {
    const w = await world(stack, 'late', 'PROJECT_BRANCH');
    await doneTask(stack, w, 'late');
    const job = await claim(stack, w);
    const before = await jobRow(stack, job.jobId);
    await ageClaim(stack, job.jobId, 11 * 60_000);
    await abandonIntegrationJob(stack.prisma, {
      jobId: job.jobId, projectId: w.projectId, ownerId: w.ownerId, by: 'owner',
    });
    const after = await jobRow(stack, job.jobId);
    assert.equal(after.claimGeneration, before.claimGeneration + 1n, 'claim_generation + 1');

    assert.equal(await refusal(receiveIntegrationJobProgress(stack.prisma, w.runnerId, job.jobId, {
      claimGeneration: job.claimGeneration, leaseOwner: job.leaseOwner, phase: 'CHECK',
    })), 'ALREADY_FINAL');

    const late = await stack.jobs.applyResult(job.jobId, w.runnerId, {
      claimGeneration: job.claimGeneration,
      leaseOwner: job.leaseOwner,
      state: 'ERROR',
      errorCode: 'FETCH_FAILED',
    });
    assert.equal(late.answer.accepted, false, 'a result for the abandoned claim is not applied');
    assert.equal((await jobRow(stack, job.jobId)).errorCode, 'RUNNER_LOST');
  });

  await t.test('(8) an abandoned LAND_TASK releases the DONE that was deferred behind it (J-T8 rev 24)', async () => {
    const w = await world(stack, 'abandon-deferred', 'PROJECT_BRANCH');
    const { taskId } = await doneTask(stack, w, 'abandon-deferred');
    const job = await claim(stack, w);
    // The task was reopened and written DONE again while this generation was in flight: its own
    // enqueue was refused (J3), and its marker kept.
    await stack.db.taskReopenIntent.create({ data: { taskId } });
    await ageClaim(stack, job.jobId, 11 * 60_000);

    await abandonIntegrationJob(stack.prisma, {
      jobId: job.jobId, projectId: w.projectId, ownerId: w.ownerId, by: 'owner',
    });

    const second = await stack.db.projectIntegrationJob.findFirst({
      where: { taskId, kind: 'LAND_TASK', generation: 2 },
    });
    assert.ok(second, 'the deferred DONE\'s generation is queued in the same transaction');
    assert.equal(second.state, 'QUEUED');
    assert.equal(await stack.db.taskReopenIntent.count({ where: { taskId } }), 0, 'the marker is consumed');
    assert.equal((await jobRow(stack, job.jobId)).state, 'ERROR', 'the abandoned generation is its own row');
  });

  await t.test('(9) abandoning a generation that was already asked to stop opens no item (J-T8 rev 24)', async () => {
    const w = await world(stack, 'abandon-stopped', 'PROJECT_BRANCH');
    await doneTask(stack, w, 'abandon-stopped');
    const job = await claim(stack, w);
    await ageClaim(stack, job.jobId, 11 * 60_000);
    // Somebody asked this claim to stop before its runner went silent: the generation is not
    // wanted, and abandoning it only writes the end down.
    await stack.db.projectIntegrationJob.update({
      where: { id: job.jobId }, data: { cancelRequestedAt: new Date() },
    });

    const abandoned = await abandonIntegrationJob(stack.prisma, {
      jobId: job.jobId, projectId: w.projectId, ownerId: w.ownerId, by: 'owner',
    });
    assert.equal(abandoned.abandoned.state, 'ERROR');
    assert.equal(abandoned.abandoned.openItemId, null);
    assert.equal(
      await stack.db.projectOpenItem.count({ where: { integrationJobId: job.jobId } }),
      0,
      'a stopped generation opens no failure card, even when abandoned',
    );
  });

  await t.test('(10) the owner door refuses an acting session, and abandons a silent runner\'s job', async () => {
    const w = await world(stack, 'owner-door', 'PROJECT_BRANCH');
    await doneTask(stack, w, 'owner-door');
    const job = await claim(stack, w);
    await ageClaim(stack, job.jobId, 11 * 60_000);

    const door = new ProjectIntegrationRetryController(stack.openItems, stack.jobs);
    await assert.rejects(
      door.abandonIntegrationJob({ userId: w.ownerId } as never, w.projectId, job.jobId, 'a-session'),
      (error: { getStatus?: () => number; message?: string }) => {
        assert.equal(error.getStatus?.(), 403);
        assert.match(String(error.message), /acting session/);
        return true;
      },
    );
    assert.equal((await jobRow(stack, job.jobId)).state, 'RUNNING', 'the refused press wrote nothing');

    const abandoned = await door.abandonIntegrationJob(
      { userId: w.ownerId } as never, w.projectId, job.jobId, undefined,
    );
    assert.equal(abandoned.state, 'ERROR');
    assert.equal((await jobRow(stack, job.jobId)).state, 'ERROR');
  });
});

test('stop: QUEUED ends now, RUNNING is asked, past the push boundary is refused', {
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

  await t.test('(1) a QUEUED landing ends CANCELLED on the spot and leaves the task as it was', async () => {
    const w = await world(stack, 'stop-queued', 'PROJECT_BRANCH');
    const { taskId } = await doneTask(stack, w, 'stop-queued');
    const job = await stack.db.projectIntegrationJob.findFirstOrThrow({
      where: { taskId, kind: 'LAND_TASK', state: 'QUEUED' },
    });

    const stopped = await stack.openItems.stopTaskIntegrationAsOwner(w.ownerId, w.projectId, taskId, undefined);
    assert.deepEqual(
      { state: stopped.state, errorCode: stopped.errorCode, jobId: stopped.jobId },
      { state: 'CANCELLED', errorCode: null, jobId: job.id },
    );
    const row = await jobRow(stack, job.id);
    assert.equal(row.state, 'CANCELLED');
    assert.ok(row.cancelRequestedAt, 'the row records the stop');
    assert.ok(row.finishedAt, 'and it is finished');
    assert.deepEqual(await readInFlightJobs(stack.prisma, w.projectId), [], 'it is no longer in flight');
    assert.equal(
      (await stack.db.task.findUniqueOrThrow({ where: { id: taskId } })).status,
      'DONE',
      'the task segment is not settled',
    );
  });

  await t.test('(2) a live RUNNING claim is only asked; its result settles the cancellation', async () => {
    const w = await world(stack, 'stop-running', 'PROJECT_BRANCH');
    const { taskId } = await doneTask(stack, w, 'stop-running');
    const job = await claim(stack, w);

    const stopped = await stack.openItems.stopTaskIntegrationAsOwner(w.ownerId, w.projectId, taskId, undefined);
    assert.equal(stopped.state, 'CANCELLING');
    const asked = await jobRow(stack, job.jobId);
    assert.equal(asked.state, 'RUNNING');
    assert.ok(asked.cancelRequestedAt, 'the runner is asked, not overruled');

    await report(stack, w, job, { state: 'CANCELLED', phase: 'CHECK' });
    assert.equal((await jobRow(stack, job.jobId)).state, 'CANCELLED', 'J-T12: the runner answers');
  });

  await t.test('(3) past the push boundary the stop is refused; nothing is in flight -> not applicable', async () => {
    // v2: the boundary is the recorded PUSH generation, not the phase.
    const v2 = await world(stack, 'stop-v2-pushed', 'PROJECT_BRANCH');
    const v2Work = await doneTask(stack, v2, 'stop-v2-pushed');
    const v2Job = await claim(stack, v2);
    await receiveIntegrationJobProgress(stack.prisma, v2.runnerId, v2Job.jobId, {
      claimGeneration: v2Job.claimGeneration, leaseOwner: v2Job.leaseOwner, phase: 'PUSH',
    });
    await receiveIntegrationJobProgress(stack.prisma, v2.runnerId, v2Job.jobId, {
      claimGeneration: v2Job.claimGeneration, leaseOwner: v2Job.leaseOwner, phase: 'CHECK',
    });
    await assert.rejects(
      stack.openItems.stopTaskIntegrationAsOwner(v2.ownerId, v2.projectId, v2Work.taskId, undefined),
      (error: { getResponse?: () => { code?: string } }) =>
        error.getResponse?.().code === 'INTEGRATION_STOP_PUSHED',
    );
    assert.equal((await jobRow(stack, v2Job.jobId)).cancelRequestedAt, null, 'nothing was written');

    // Legacy: `phase` is all there is, and VERIFY is reported after the push.
    const legacy = await world(stack, 'stop-legacy-verify', 'PROJECT_BRANCH');
    const legacyWork = await doneTask(stack, legacy, 'stop-legacy-verify');
    const legacyJob = await claim(stack, legacy, [INTEGRATION_JOB_CLAIM]);
    await receiveIntegrationJobProgress(stack.prisma, legacy.runnerId, legacyJob.jobId, {
      claimGeneration: legacyJob.claimGeneration, leaseOwner: legacyJob.leaseOwner, phase: 'VERIFY',
    });
    await assert.rejects(
      stack.openItems.stopTaskIntegrationAsOwner(legacy.ownerId, legacy.projectId, legacyWork.taskId, undefined),
      (error: { getResponse?: () => { code?: string } }) =>
        error.getResponse?.().code === 'INTEGRATION_STOP_PUSHED',
    );

    // A task with no landing at all has nothing to stop.
    const bare = await stack.tasks.create(legacy.ownerId, {
      title: `bare ${randomUUID().slice(0, 8)}`,
      projectId: legacy.projectId,
      completionCriterion: 'EXECUTABLE',
      acceptanceCommand: 'true',
      acceptanceExpectedExitCode: 0,
    } as never);
    await assert.rejects(
      stack.openItems.stopTaskIntegrationAsOwner(legacy.ownerId, legacy.projectId, bare.id, undefined),
      (error: { getResponse?: () => { code?: string } }) =>
        error.getResponse?.().code === 'INTEGRATION_STOP_NOT_APPLICABLE',
    );
  });

  await t.test('(4) a run past its lease is ended ERROR with J12\'s code, and the slot is released', async () => {
    const w = await world(stack, 'stop-timed-out', 'PROJECT_BRANCH');
    const { taskId } = await doneTask(stack, w, 'stop-timed-out');
    const job = await claim(stack, w, [INTEGRATION_JOB_CLAIM]);
    const behindTask = await doneTask(stack, w, 'stop-timed-out-behind');
    const behind = await stack.db.projectIntegrationJob.findFirstOrThrow({
      where: { taskId: behindTask.taskId, kind: 'LAND_TASK', state: 'QUEUED' },
    });
    await ageClaim(stack, job.jobId, 11 * 60_000);

    const stopped = await stack.openItems.stopTaskIntegrationAsOwner(w.ownerId, w.projectId, taskId, undefined);
    assert.deepEqual(
      { state: stopped.state, errorCode: stopped.errorCode },
      { state: 'ERROR', errorCode: 'PUSH_OUTCOME_UNKNOWN' },
      'a legacy landing cannot prove nothing was pushed',
    );
    assert.equal((await jobRow(stack, job.jobId)).errorCode, 'PUSH_OUTCOME_UNKNOWN');
    const [next] = await beat(stack, w);
    assert.equal(next?.jobId, behind.id, 'the serial slot is released');
  });

  await t.test('(5) a stopped generation releases the DONE that was deferred behind it (J-T8 rev 24)', async () => {
    const w = await world(stack, 'stop-deferred', 'PROJECT_BRANCH');
    const { taskId } = await doneTask(stack, w, 'stop-deferred');
    // The task was reopened and written DONE again while generation 1 was still in flight: its
    // enqueue was refused (J3) and its marker kept.
    await stack.db.taskReopenIntent.create({ data: { taskId } });
    const job = await stack.db.projectIntegrationJob.findFirstOrThrow({
      where: { taskId, kind: 'LAND_TASK', state: 'QUEUED' },
    });
    assert.equal(job.generation, 1);

    await stack.openItems.stopTaskIntegrationAsOwner(w.ownerId, w.projectId, taskId, undefined);

    const second = await stack.db.projectIntegrationJob.findFirst({
      where: { taskId, kind: 'LAND_TASK', generation: 2 },
    });
    assert.ok(second, 'the second DONE\'s generation is queued in the same transaction');
    assert.equal(second.state, 'QUEUED');
    assert.equal(await stack.db.taskReopenIntent.count({ where: { taskId } }), 0, 'the marker is consumed');
    assert.equal((await jobRow(stack, job.id)).state, 'CANCELLED');
  });

  await t.test('(6) the stop door is the owner\'s: an acting session is refused', async () => {
    const w = await world(stack, 'stop-session', 'PROJECT_BRANCH');
    const { taskId } = await doneTask(stack, w, 'stop-session');
    await assert.rejects(
      stack.openItems.stopTaskIntegrationAsOwner(w.ownerId, w.projectId, taskId, 'a-session'),
      (error: { getStatus?: () => number; message?: string }) => {
        assert.equal(error.getStatus?.(), 403);
        assert.match(String(error.message), /acting session/);
        return true;
      },
    );
    const job = await stack.db.projectIntegrationJob.findFirstOrThrow({
      where: { taskId, kind: 'LAND_TASK', state: 'QUEUED' },
    });
    assert.equal(job.state, 'QUEUED', 'the refused press wrote nothing');
  });
});
