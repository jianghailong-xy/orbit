import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { RunStatus, RunnerStatus, type PrismaClient } from '@prisma/client';
import type {
  IntegrationJobCommand,
  IntegrationJobResultRequest,
} from '@orbit/shared';
import { Client } from 'pg';
import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import type { QueueService } from '../queue/queue.service';
import type { RealtimeService } from '../realtime/realtime.service';
import { IntegrationJobRelay } from '../runner-api/integration-job-relay';
import { SessionsService } from '../sessions/sessions.service';
import { prerequisiteLandedSql } from '../tasks/task-dependencies';
import { TasksService } from '../tasks/tasks.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from './coordinator-pg-test-safety';
import { INTEGRATION_JOB_CLAIM, enqueueForDoneTask } from './project-integration-job';
import { ProjectOpenItemService } from './project-open-item.service';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

/** A full 40-hex object name, which is the only kind a job column and a receipt accept. */
const sha = (nibble: string) => nibble.repeat(40);
const UPSTREAM_TIP = sha('9');
const LINE_TIP = sha('a');

type Answer = Omit<IntegrationJobResultRequest, 'claimGeneration' | 'leaseOwner'>;

test('direct MAIN delivery records receipts and releases dependency gates once', {
  skip, concurrency: 1, timeout: 300_000,
}, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const prisma: PrismaClient = prismaClientFor(url);
  t.after(async () => {
    await prisma.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });

  // The production wiring over one client. Only the publishes and the queue nudge are inert.
  const db = prisma as unknown as PrismaService;
  const realtime = new Proxy({}, { get: () => () => undefined }) as unknown as RealtimeService;
  const queue = { notifySessionQueued: () => undefined } as unknown as QueueService;
  const sessions = new SessionsService(db, queue, realtime);
  const openItems = new ProjectOpenItemService(db, sessions);
  const jobs = new IntegrationJobRelay(db, openItems);
  const tasks = new TasksService(prisma as never, {} as never, {
    publishTaskChanged() {},
    publishForUser() {},
  } as never);

  const ownerId = randomUUID();
  await prisma.user.create({
    data: { id: ownerId, email: `blocked-reason-${ownerId}@promotion.invalid`, name: 'The owner', passwordHash: 'x' },
  });

  /** One candidate's world: its own runner (a heartbeat hands out the oldest job it may), the
   *  workspace its checkout is bound to, and a project on a branch of its own that is integrating. */
  async function world(label: string) {
    const runnerId = randomUUID();
    await prisma.runner.create({
      data: {
        id: runnerId,
        ownerId,
        name: `${label}: the runner`,
        tokenHash: `hash-${runnerId}`,
        status: RunnerStatus.ONLINE,
        capabilities: [],
        capabilitiesReportedAt: new Date(),
        lastHeartbeatAt: new Date(),
      },
    });
    const workspaceId = randomUUID();
    await prisma.workspace.create({
      data: {
        id: workspaceId, ownerId, runnerId, name: `${label}: the workspace`, enabled: true,
        repoUrl: 'ssh://git@example.invalid/the-project', workDir: `/srv/blocked-reason-${label}`,
      },
    });
    const projectId = randomUUID();
    await prisma.project.create({ data: { id: projectId, ownerId, title: `${label}: the project` } });
    await prisma.projectCodebase.create({
      data: {
        ownerId,
        projectId,
        canonicalRepoUrl: 'ssh://git@example.invalid/the-project',
        upstreamRef: 'refs/heads/main',
        integrationRef: 'refs/heads/main',
        refAuthority: 'REMOTE',
        integrationRefSource: 'EXPLICIT',
        integrationStartedAt: new Date(Date.now() - 60_000),
      },
    });
    return { runnerId, workspaceId, projectId };
  }
  type World = Awaited<ReturnType<typeof world>>;

  /** The world's runner asks for work, and is handed the one job of this kind it is owed. */
  async function claim(w: World, kind: IntegrationJobCommand['kind']): Promise<IntegrationJobCommand> {
    const handed = await jobs.dispatch({
      runnerId: w.runnerId, leaseOwner: `lease-${randomUUID()}`, draining: false, capabilities: [INTEGRATION_JOB_CLAIM],
    });
    const job = handed.find((command) => command.kind === kind);
    assert.ok(job, `the heartbeat was handed no ${kind}: ${JSON.stringify(handed.map((command) => command.kind))}`);
    return job;
  }

  async function report(w: World, job: IntegrationJobCommand, answer: Answer) {
    const { answer: taken } = await jobs.applyResult(job.jobId, w.runnerId, {
      claimGeneration: job.claimGeneration, leaseOwner: job.leaseOwner, ...answer,
    });
    assert.ok(taken.accepted, `the answer was refused: ${JSON.stringify(taken)}`);
  }

  async function mainTask(w: World, suffix: string, finished = true) {
    const task = await tasks.create(ownerId, {
      title: suffix, projectId: w.projectId, completionCriterion: 'EXECUTABLE',
      acceptanceCommand: 'true', acceptanceExpectedExitCode: 0,
    } as never);
    await sql.query(`UPDATE "task" SET "status" = 'DONE' WHERE "id" = $1::uuid`, [task.id]);
    const branch = `orbit/direct-${task.id.slice(0, 8)}`;
    const session = await prisma.session.create({ data: {
      ownerId, creatorId: ownerId, taskId: task.id, workspaceId: w.workspaceId,
      assignedRunnerId: w.runnerId, title: suffix, prompt: 'work', branch, worktreeBranch: branch,
      isolationStatus: 'worktree', status: RunStatus.SUCCEEDED, startsTaskWork: true,
      finishedAt: finished ? new Date(Date.now() - 60_000) : null,
      baseSha: sha('1'), branchSha: LINE_TIP, worktreeDirty: false,
      changedFiles: [{ path: 'delivery.txt' }],
    } });
    const queued = await prisma.$transaction((tx) => enqueueForDoneTask(tx, ownerId, task.id));
    assert.ok(queued.enqueued && queued.kind === 'PROMOTION');
    return { task, session, promotionId: queued.promotionId };
  }
  async function landed(taskId: string) {
    const result = await sql.query(`SELECT ${prerequisiteLandedSql('t')} AS landed FROM "task" t WHERE t."id" = $1`, [taskId]);
    return result.rows[0].landed;
  }
  const delivery: Answer = {
    state: 'ALREADY_LANDED', phase: 'MERGE', sourceSha: LINE_TIP,
    targetShaBefore: UPSTREAM_TIP, upstreamSha: UPSTREAM_TIP,
  };

  await t.test('verified delivery writes a receipt, resolves an earlier failure, and duplicate reports are fenced', async () => {
    const w = await world('delivered');
    const own = await mainTask(w, 'delivered');
    assert.equal(await landed(own.task.id), false, 'DONE alone cannot release the gate');
    const failed = await claim(w, 'CHECK_PROMOTION');
    assert.equal(failed.sourceSha, LINE_TIP, 'the settled runner-reported commit is frozen at claim');
    await report(w, failed, { state: 'ERROR', phase: 'FETCH', errorCode: 'SOURCE_BRANCH_MISSING' });
    assert.equal(await landed(own.task.id), false, 'closing or retrying a failure is not delivery');
    await openItems.retryPromotionCheckAsOwner(ownerId, w.projectId, own.promotionId,
      { reason: 'Verify the direct delivery against the current target' });
    const job = await claim(w, 'CHECK_PROMOTION');
    const body = { claimGeneration: job.claimGeneration, leaseOwner: job.leaseOwner, ...delivery };
    const answers = await Promise.all([
      jobs.applyResult(job.jobId, w.runnerId, body), jobs.applyResult(job.jobId, w.runnerId, body),
    ]);
    assert.equal(answers.filter((result) => result.answer.accepted).length, 1);
    const accepted = answers.find((result) => result.answer.accepted)!;
    assert.equal(accepted.answer.receiptIds.length, 1);
    assert.equal(accepted.after?.landedTaskId, own.task.id, 'the committed receipt dispatches downstream work');
    assert.equal(await landed(own.task.id), true, 'the real dependency predicate now permits start');
    const promotion = await prisma.projectPromotion.findUniqueOrThrow({ where: { id: own.promotionId } });
    assert.equal(promotion.state, 'SUPERSEDED');
    assert.equal(promotion.confirmedByUserId, null);
    assert.equal(promotion.confirmedAutomatically, false);
    assert.equal(promotion.sourceSha, LINE_TIP);
    const receipts = await prisma.sessionMergeReceipt.findMany({ where: { taskId: own.task.id } });
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0].sourceSha, LINE_TIP);
    assert.equal(receipts[0].result, 'ALREADY_MERGED');
    assert.equal(receipts[0].targetShaBefore, UPSTREAM_TIP);
    assert.equal(receipts[0].targetShaAfter, null, 'verification moved no branch');
    assert.equal(await prisma.projectOpenItem.count({ where: { projectId: w.projectId, state: 'OPEN' } }), 0);
    const replay = await jobs.applyResult(job.jobId, w.runnerId, body);
    assert.equal(replay.answer.accepted, false);
    assert.equal(await prisma.sessionMergeReceipt.count({ where: { taskId: own.task.id } }), 1);
  });

  for (const failure of ['CONFLICT', 'ERROR', 'CHECK_FAILED', 'EMPTY_SOURCE', 'WRONG_COMMIT', 'MISSING_TARGET'] as const) {
    await t.test(`${failure} keeps the dependency gate closed`, async () => {
      const w = await world(failure);
      const own = await mainTask(w, failure);
      const job = await claim(w, 'CHECK_PROMOTION');
      await report(w, job, failure === 'EMPTY_SOURCE'
        ? { ...delivery, sourceSha: sha('1') }
        : failure === 'WRONG_COMMIT' ? { ...delivery, sourceSha: sha('b') }
          : failure === 'MISSING_TARGET' ? { state: 'ALREADY_LANDED', sourceSha: LINE_TIP }
        : { state: failure, phase: 'MERGE', conflicts: failure === 'CONFLICT' ? ['delivery.txt'] : [] });
      assert.equal(await landed(own.task.id), false);
      assert.equal(await prisma.sessionMergeReceipt.count({ where: { taskId: own.task.id } }), 0);
    });
  }

  await t.test('a finish newer than the claim requeues the check without writing a receipt', async () => {
    const w = await world('moving');
    const own = await mainTask(w, 'moving');
    const job = await claim(w, 'CHECK_PROMOTION');
    await prisma.session.update({ where: { id: own.session.id }, data: { finishedAt: new Date(Date.now() + 1_000) } });
    await report(w, job, delivery);
    assert.equal(await landed(own.task.id), false);
    assert.equal(await prisma.sessionMergeReceipt.count({ where: { taskId: own.task.id } }), 0);
    const requeued = await prisma.projectIntegrationJob.findUniqueOrThrow({ where: { id: job.jobId } });
    assert.equal(requeued.state, 'QUEUED');
  });

  await t.test('an ALREADY_LANDED about the former branch cannot stand for work finished elsewhere', async () => {
    const w = await world('switched');
    const own = await mainTask(w, 'switched');
    const job = await claim(w, 'CHECK_PROMOTION');
    await prisma.session.update({ where: { id: own.session.id }, data: { worktreeBranch: 'delivery/actual' } });
    await report(w, job, delivery);
    assert.equal(await landed(own.task.id), false);
    assert.equal(await prisma.sessionMergeReceipt.count({ where: { taskId: own.task.id } }), 0);
    const next = await claim(w, 'CHECK_PROMOTION');
    assert.equal(next.sourceRef, 'refs/heads/delivery/actual');
    await report(w, next, delivery);
    assert.equal(await landed(own.task.id), true);
  });
});
