import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { PrismaClient, RunStatus, RunnerStatus } from '@prisma/client';
import { Client } from 'pg';

import { IntegrationJobCommand, IntegrationJobResultRequest } from '@orbit/shared';

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
import { INTEGRATION_JOB_CLAIM, enqueueForDoneTask } from './project-integration-job';
import { configureProjectIntegration } from './project-integration-line';
import { ProjectOpenItemService } from './project-open-item.service';

/**
 * J-T1e's judgement under a claim that no longer locks the source session
 * (docs/project-integration-line-contract.md §2.2 J-T1e, §2.9 LS2).
 *
 * `claimOne` takes `FOR UPDATE OF c SKIP LOCKED`: it locks the JOB row and reads the source session
 * and workspace for their committed values. Before that narrowing, a session row written by another
 * transaction made the whole candidate un-lockable and SKIP LOCKED dropped the claim for that beat.
 * Narrowing it is only safe if a session written concurrently still cannot make a too-early answer
 * final, and that is what this file witnesses:
 *
 *   * the claim is handed out WHILE a transaction holds the source session row — it neither waits
 *     for the session nor skips the job;
 *   * the session then commits as unfinished (a resume), and the `ALREADY_LANDED` the runner reports
 *     is NOT written down: the result gate re-reads the sessions against the claim's own instant and
 *     sends the job back to the queue (J-T1e);
 *   * once the work really has stopped, the same answer is final.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/projects/integration-job-claim-race.pg.spec.ts
 */
const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;
const sha = (nibble: string) => nibble.repeat(40);

type Answer = Omit<IntegrationJobResultRequest, 'claimGeneration' | 'leaseOwner'>;

async function world(db: PrismaClient) {
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  await db.user.create({
    data: { id: ownerId, email: `claim-race-${ownerId}@cancel.invalid`, name: 'race', passwordHash: 'x' },
  });
  await db.runner.create({
    data: {
      id: runnerId, ownerId, name: 'race-runner', tokenHash: `hash-${runnerId}`,
      status: RunnerStatus.ONLINE, capabilities: [], capabilitiesReportedAt: new Date(),
      lastHeartbeatAt: new Date(),
    },
  });
  await db.workspace.create({
    data: {
      id: workspaceId, ownerId, runnerId, name: 'race-workspace', enabled: true,
      repoUrl: `https://git.invalid/race-${randomUUID().slice(0, 6)}.git`, workDir: '/srv/race',
    },
  });
  await db.project.create({
    data: { id: projectId, ownerId, title: 'race project', coordinatorWorkspaceId: workspaceId },
  });
  await db.projectRuntime.upsert({ where: { projectId }, create: { projectId }, update: {} });
  return { ownerId, runnerId, workspaceId, projectId };
}

test('a claim narrowed to the job row neither waits for nor skips a concurrently written source session, and J-T1e still holds', {
  skip, timeout: 300_000,
}, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const side = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await side.connect();
  await verifyCoordinatorPgIdentity(side);
  const db: PrismaClient = prismaClientFor(url);
  const prisma = db as unknown as PrismaService;
  const realtime = new Proxy({}, { get: () => () => undefined }) as unknown as RealtimeService;
  const queue = { notifySessionQueued: () => undefined } as unknown as QueueService;
  const sessions = new SessionsService(prisma, queue, realtime);
  const openItems = new ProjectOpenItemService(prisma, sessions);
  const jobs = new IntegrationJobRelay(prisma, openItems);
  const tasks = new TasksService(prisma as never, {} as never, {
    publishTaskChanged() {}, publishForUser() {},
  } as never);
  t.after(async () => {
    await db.$disconnect().catch(() => undefined);
    await side.end().catch(() => undefined);
  });

  const w = await world(db);
  await db.$transaction((tx) => configureProjectIntegration(tx, {
    ownerId: w.ownerId, projectId: w.projectId, settings: { line: 'PROJECT_BRANCH' },
  }));
  const created = await tasks.create(w.ownerId, {
    title: 'the work', projectId: w.projectId,
    completionCriterion: 'EXECUTABLE', acceptanceCommand: 'true', acceptanceExpectedExitCode: 0,
  } as never);
  await db.$executeRawUnsafe(
    `UPDATE "task" SET "status" = 'DONE' WHERE "id" = $1::uuid`, created.id,
  );
  const branch = `orbit/race-${randomUUID().slice(0, 8)}`;
  const session = await db.session.create({
    data: {
      ownerId: w.ownerId, creatorId: w.ownerId, taskId: created.id, workspaceId: w.workspaceId,
      assignedRunnerId: w.runnerId, title: 'the work', prompt: 'the work', branch,
      isolationStatus: 'worktree', baseSha: sha('b'), status: RunStatus.SUCCEEDED,
      startsTaskWork: true, finishedAt: new Date(Date.now() - 60_000), worktreeBranch: branch,
      worktreeDirty: false, changedFiles: [{ path: 'src/work.ts' }] as never,
    },
    select: { id: true },
  });
  const queued = await db.$transaction((tx) => enqueueForDoneTask(tx, w.ownerId, created.id));
  assert.ok(queued.enqueued);
  const job = await db.projectIntegrationJob.findFirstOrThrow({ where: { taskId: created.id } });
  assert.equal(job.state, 'QUEUED');

  const beat = (leaseOwner: string) => jobs.dispatch({
    runnerId: w.runnerId, leaseOwner, draining: false, capabilities: [INTEGRATION_JOB_CLAIM],
  });

  await t.test('the claim is handed out while another transaction holds the source session row', async () => {
    // A resume begins: the session is unfinished again, in a transaction that has not committed.
    await side.query('BEGIN');
    const held = await side.query(
      `UPDATE "session" SET "finished_at" = NULL WHERE "id" = $1::uuid`, [session.id],
    );
    assert.equal(held.rowCount, 1);

    // With `FOR UPDATE OF c` this neither waits for the session nor skips the job. (Before the
    // narrowing the candidate joined the session and SKIP LOCKED silently dropped it for the beat.)
    const handed = await Promise.race([
      beat(`lease-race-${randomUUID()}`),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('the claim waited on the session lock')), 10_000)),
    ]);
    const claimed = handed.find((command) => command.jobId === job.id);
    assert.ok(claimed, 'the claim was not skipped because its source session was being written');

    // The transaction holding the session commits the resume.
    await side.query('COMMIT');

    // The runner answers about work that can still move: J-T1e refuses to write it down.
    const tooEarly = await jobs.applyResult(job.id, w.runnerId, {
      claimGeneration: claimed.claimGeneration,
      leaseOwner: claimed.leaseOwner,
      state: 'ALREADY_LANDED', phase: 'FETCH', sourceSha: sha('a'),
    });
    assert.equal(tooEarly.answer.accepted, true);
    assert.equal(tooEarly.answer.state, 'QUEUED',
      'the answer was taken too early: the job goes back to the queue');
    const after = await db.projectIntegrationJob.findUniqueOrThrow({ where: { id: job.id } });
    assert.equal(after.state, 'QUEUED');
    assert.equal(after.claimLeaseOwner, null);
  });

  await t.test('once the work has stopped, the same answer is final', async () => {
    // The resumed session finishes again.
    await db.session.update({ where: { id: session.id }, data: { finishedAt: new Date() } });
    const [claimed] = await beat(`lease-final-${randomUUID()}`);
    assert.ok(claimed);
    assert.equal(claimed.jobId, job.id);
    const answer: Answer = { state: 'ALREADY_LANDED', phase: 'FETCH', sourceSha: sha('a') };
    const taken = await jobs.applyResult(job.id, w.runnerId, {
      claimGeneration: claimed.claimGeneration, leaseOwner: claimed.leaseOwner, ...answer,
    });
    assert.equal(taken.answer.accepted, true);
    assert.equal(taken.answer.state, 'ALREADY_LANDED', 'the work had settled: the answer stands');
    const row = await db.projectIntegrationJob.findUniqueOrThrow({ where: { id: job.id } });
    assert.equal(row.state, 'ALREADY_LANDED');
  });
});
