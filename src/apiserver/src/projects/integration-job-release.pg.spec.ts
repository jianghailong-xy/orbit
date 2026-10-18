/**
 * A stopping runner hands a claimed landing back (contract §2.2 J-T11), on real PostgreSQL.
 *
 * WHY THIS EXISTS
 * ---------------
 * On 2026-10-17 the managed-runner lab (task T03) stopped a runner Pod while a LAND_TASK's merge check
 * was running. The runner could not finish the check inside the Pod's grace and was killed, and the job
 * stayed RUNNING under the dead process's claim until the lease expired: the next Pod was handed it 10
 * min 26 s after the last report and ran it again from FETCH. The runner now stops such a job before its
 * push and gives the claim back; this is the control plane's half — the job goes back to the queue at
 * once, under a claim generation the old process can no longer report under.
 *
 * THE CASES
 * ---------
 *  (1) Without a hand-back, the claim of a process that went away holds the job: the runner's next
 *      process is handed nothing. Handed back, the job is QUEUED with its step and lease cleared, its
 *      claim generation moved on and its first start kept, and that next process is handed it on its
 *      first heartbeat. The process that gave it back is draining and is handed nothing.
 *  (2) The claim given back is fenced: its late progress, its late result and a second hand-back are
 *      refused STALE_CLAIM; a job already written down answers ALREADY_FINAL.
 *  (3) Another account's runner is told the job does not exist, and another runner of the same
 *      account that the claim is not its own; neither writes anything.
 *  (4) A job somebody asked to stop is not handed back — a QUEUED row with a stop request is never
 *      claimed again — and ends CANCELLED instead (J-T12).
 *  (5) A hand-back that names no claim is refused as invalid.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/projects/integration-job-release.pg.spec.ts
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { RunStatus, RunnerStatus, type PrismaClient } from '@prisma/client';
import { Client } from 'pg';
import { prismaClientFor } from '../prisma/prisma-client';
import { TasksService } from '../tasks/tasks.service';
import {
  IntegrationJobRefused,
  IntegrationJobRelay,
  applyIntegrationJobResult,
  dispatchIntegrationJobs,
  receiveIntegrationJobProgress,
} from '../runner-api/integration-job-relay';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from './coordinator-pg-test-safety';
import { INTEGRATION_JOB_CLAIM, enqueueForDoneTask } from './project-integration-job';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

/** The diff summary a session that delivered something reports. */
const WORK_REPORTED = [{ path: 'src/runner-go/integrate.go', status: 'M', additions: 12, deletions: 3 }];

async function harness(t: { after(fn: () => Promise<void> | void): void }) {
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
  const relay = new IntegrationJobRelay(prisma as never);
  const tasks = new TasksService(prisma as never, {} as never, {
    publishTaskChanged() {},
    publishForUser() {},
  } as never);

  async function newOwner(label: string): Promise<string> {
    const ownerId = randomUUID();
    await prisma.user.create({
      data: { id: ownerId, email: `${label}-${ownerId}@integration-job-release.invalid`, name: label, passwordHash: 'x' },
    });
    return ownerId;
  }

  /** A runner with a workspace its sessions run in: the pair the job's claim joins. */
  async function newRunner(ownerId: string, name: string): Promise<{ runnerId: string; workspaceId: string }> {
    const runnerId = randomUUID();
    await prisma.runner.create({
      data: {
        id: runnerId,
        ownerId,
        name,
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
        id: workspaceId,
        ownerId,
        runnerId,
        name: `the workspace of ${name}`,
        enabled: true,
        repoUrl: 'ssh://git@example.invalid/integration-job-release',
        workDir: `/srv/${name}`,
      },
    });
    return { runnerId, workspaceId };
  }

  /**
   * A finished task of a project whose line is started, its work session done on `runner`, and the
   * landing its DONE queued: the job the runner's heartbeat is handed.
   */
  async function queuedLanding(ownerId: string, runner: { runnerId: string; workspaceId: string }, label: string): Promise<string> {
    const projectId = randomUUID();
    await prisma.project.create({ data: { id: projectId, ownerId, title: `The project ${label} lands into` } });
    await prisma.projectCodebase.create({
      data: {
        ownerId,
        projectId,
        canonicalRepoUrl: `ssh://git@example.invalid/integration-job-release-${projectId}`,
        upstreamRef: 'refs/heads/main',
        integrationRef: `refs/heads/project/${projectId}`,
        refAuthority: 'REMOTE',
        integrationRefSource: 'EXPLICIT',
        integrationStartedAt: new Date(Date.now() - 60_000),
      },
    });
    const task = await tasks.create(ownerId, {
      title: label,
      projectId,
      completionCriterion: 'EXECUTABLE',
      acceptanceCommand: 'true',
      acceptanceExpectedExitCode: 0,
    } as never);
    const written = await sql.query(
      `UPDATE "task" SET "status" = 'DONE'
        WHERE "id" = $1::uuid
          AND "status" IN ('OPEN', 'IN_PROGRESS')
          AND "completion_criterion" = 'EXECUTABLE'
          AND "acceptance_command" = 'true'
          AND "acceptance_expected_exit_code" = 0`,
      [task.id],
    );
    assert.equal(written.rowCount, 1, 'the EXECUTABLE task must reach DONE through the DONE fence');
    await prisma.session.create({
      data: {
        id: randomUUID(),
        ownerId,
        creatorId: ownerId,
        taskId: task.id,
        workspaceId: runner.workspaceId,
        assignedRunnerId: runner.runnerId,
        title: `ran ${label}`,
        prompt: 'do the work',
        branch: `orbit/release-${task.id}`,
        isolationStatus: 'worktree',
        status: RunStatus.SUCCEEDED,
        baseSha: '1'.repeat(40),
        changedFiles: WORK_REPORTED as never,
        createdAt: new Date(Date.now() - 5 * 60_000),
        finishedAt: new Date(Date.now() - 5 * 60_000),
      },
    });
    const queued = await prisma.$transaction((tx) => enqueueForDoneTask(tx, ownerId, task.id));
    assert.ok(queued.enqueued, `the DONE queued no landing: ${JSON.stringify(queued)}`);
    const job = await prisma.projectIntegrationJob.findFirstOrThrow({
      where: { taskId: task.id, kind: 'LAND_TASK' },
      select: { id: true },
    });
    return job.id;
  }

  /** One heartbeat of one runner process asking for work: what `dispatchIntegrationJobs` hands it. */
  function beat(runnerId: string, leaseOwner: string, draining = false) {
    return dispatchIntegrationJobs(prisma as never, {
      runnerId,
      leaseOwner,
      draining,
      capabilities: [INTEGRATION_JOB_CLAIM],
    });
  }

  function row(jobId: string) {
    return prisma.projectIntegrationJob.findUniqueOrThrow({
      where: { id: jobId },
      select: {
        state: true, phase: true, claimGeneration: true, claimLeaseOwner: true, claimedAt: true,
        heartbeatAt: true, startedAt: true, runnerId: true, finishedAt: true,
      },
    });
  }

  return { prisma, sql, relay, newOwner, newRunner, queuedLanding, beat, row };
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

test('a landing handed back goes to the next process at once, where the claim of a gone process held it', { skip }, async (t) => {
  const h = await harness(t);
  const ownerId = await h.newOwner('release-requeue');
  const runner = await h.newRunner(ownerId, 'the runner the work is on');
  const jobId = await h.queuedLanding(ownerId, runner, 'the landing a stop interrupts');

  const stopping = randomUUID();
  const [claimed] = await h.beat(runner.runnerId, stopping);
  assert.equal(claimed?.jobId, jobId, 'the first heartbeat claims the queued landing');
  await receiveIntegrationJobProgress(h.prisma as never, runner.runnerId, jobId, {
    claimGeneration: claimed.claimGeneration, leaseOwner: stopping, phase: 'CHECK',
  });
  const before = await h.row(jobId);
  assert.equal(before.state, 'RUNNING');

  // The control: the process that held the claim went away without a word. Its runner's next process
  // is handed nothing — the claim is another lease owner's and not stale until the lease runs out.
  const next = randomUUID();
  assert.deepEqual(await h.beat(runner.runnerId, next), [], 'a live claim of a gone process holds the job until its lease expires');

  const released = await h.relay.release(jobId, runner.runnerId, {
    claimGeneration: claimed.claimGeneration, leaseOwner: stopping,
  }, ownerId);
  assert.deepEqual(released.answer, { released: true, state: 'QUEUED' });
  const after = await h.row(jobId);
  assert.equal(after.state, 'QUEUED', 'the job is back in the queue');
  assert.equal(after.phase, null, 'with no step');
  assert.equal(after.claimLeaseOwner, null, 'and no lease');
  assert.equal(after.claimedAt, null);
  assert.equal(after.heartbeatAt, null);
  assert.equal(after.claimGeneration, before.claimGeneration + 1n, 'under a claim generation the old process cannot report under');
  assert.equal(after.startedAt?.getTime(), before.startedAt?.getTime(), 'its first start is kept');

  // The process that is stopping says so in its heartbeat, and is handed nothing back.
  assert.deepEqual(await h.beat(runner.runnerId, stopping, true), [], 'a draining process is handed nothing');
  // The next process is handed it on its first heartbeat, not ten minutes later.
  const [retaken] = await h.beat(runner.runnerId, next);
  assert.equal(retaken?.jobId, jobId, 'the next process of the runner claims the job it was handed back');
  assert.equal(BigInt(retaken.claimGeneration), after.claimGeneration + 1n);
  const rerun = await h.row(jobId);
  assert.equal(rerun.state, 'RUNNING');
  assert.equal(rerun.claimLeaseOwner, next);
  assert.equal(rerun.phase, 'FETCH', 'and runs it again from the start');
});

test('the claim given back is fenced, and a job already written down says so', { skip }, async (t) => {
  const h = await harness(t);
  const ownerId = await h.newOwner('release-fence');
  const runner = await h.newRunner(ownerId, 'the fenced runner');
  const jobId = await h.queuedLanding(ownerId, runner, 'the landing whose claim is given back');
  const leaseOwner = randomUUID();
  const [claimed] = await h.beat(runner.runnerId, leaseOwner);
  assert.equal(claimed?.jobId, jobId);
  const claim = { claimGeneration: claimed.claimGeneration, leaseOwner };

  assert.equal((await h.relay.release(jobId, runner.runnerId, claim, ownerId)).answer.released, true);
  assert.equal(await refusal(h.relay.release(jobId, runner.runnerId, claim, ownerId)), 'STALE_CLAIM',
    'a second hand-back of the same claim finds it moved on');
  assert.equal(await refusal(receiveIntegrationJobProgress(h.prisma as never, runner.runnerId, jobId, { ...claim, phase: 'CHECK' })),
    'STALE_CLAIM', 'a late progress report under the claim given back is refused');
  assert.equal(await refusal(applyIntegrationJobResult(h.prisma as never, {
    jobId, runnerId: runner.runnerId, ownerId, body: { ...claim, state: 'CHECK_FAILED', phase: 'CHECK' },
  })), 'STALE_CLAIM', 'and so is a late result: the job was not judged by the process that gave it back');
  assert.equal((await h.row(jobId)).state, 'QUEUED', 'none of them moved the job');

  // Claimed again and finished: a hand-back of the finished job's claim is told it is final.
  const next = randomUUID();
  const [retaken] = await h.beat(runner.runnerId, next);
  assert.equal(retaken?.jobId, jobId);
  const finished = { claimGeneration: retaken.claimGeneration, leaseOwner: next };
  await applyIntegrationJobResult(h.prisma as never, {
    jobId, runnerId: runner.runnerId, ownerId, body: { ...finished, state: 'ERROR', phase: 'FETCH', errorCode: 'FETCH_FAILED' },
  });
  assert.equal(await refusal(h.relay.release(jobId, runner.runnerId, finished, ownerId)), 'ALREADY_FINAL');
  assert.equal((await h.row(jobId)).state, 'ERROR');
});

test('a runner that does not hold the claim cannot give it back, and learns nothing of another account\'s job', { skip }, async (t) => {
  const h = await harness(t);
  const ownerId = await h.newOwner('release-owner');
  const runner = await h.newRunner(ownerId, 'the runner holding the claim');
  const sibling = await h.newRunner(ownerId, 'another runner of the same account');
  const strangerId = await h.newOwner('release-stranger');
  const stranger = await h.newRunner(strangerId, 'a runner of another account');
  const jobId = await h.queuedLanding(ownerId, runner, 'the landing somebody else tries to give back');
  const leaseOwner = randomUUID();
  const [claimed] = await h.beat(runner.runnerId, leaseOwner);
  assert.equal(claimed?.jobId, jobId);
  const claim = { claimGeneration: claimed.claimGeneration, leaseOwner };
  const held = await h.row(jobId);

  assert.equal(await refusal(h.relay.release(jobId, stranger.runnerId, claim, strangerId)), 'NOT_FOUND',
    'another account is answered as for an id that names nothing');
  assert.equal(await refusal(h.relay.release(jobId, sibling.runnerId, claim, ownerId)), 'STALE_CLAIM',
    'another runner of the account is told the claim is not its own');
  assert.deepEqual(await h.row(jobId), held, 'and neither wrote anything');
});

test('a landing somebody asked to stop ends CANCELLED rather than going back to a queue that never claims it', { skip }, async (t) => {
  const h = await harness(t);
  const ownerId = await h.newOwner('release-cancel');
  const runner = await h.newRunner(ownerId, 'the runner of a cancelled landing');
  const jobId = await h.queuedLanding(ownerId, runner, 'the landing a stop request is waiting on');
  const leaseOwner = randomUUID();
  const [claimed] = await h.beat(runner.runnerId, leaseOwner);
  assert.equal(claimed?.jobId, jobId);
  await receiveIntegrationJobProgress(h.prisma as never, runner.runnerId, jobId, {
    claimGeneration: claimed.claimGeneration, leaseOwner, phase: 'CHECK',
  });
  await h.sql.query(`UPDATE "project_integration_job" SET "cancel_requested_at" = now() WHERE "id" = $1::uuid`, [jobId]);

  const answered = await h.relay.release(jobId, runner.runnerId, {
    claimGeneration: claimed.claimGeneration, leaseOwner,
  }, ownerId);
  assert.deepEqual(answered.answer, { released: false, state: 'CANCELLED' });
  const ended = await h.row(jobId);
  assert.equal(ended.state, 'CANCELLED', 'the stop request is answered, not left on a queued row');
  assert.equal(ended.phase, 'CHECK', 'at the step the job had reached');
  assert.ok(ended.finishedAt, 'and the job is finished');
  assert.deepEqual(await h.beat(runner.runnerId, randomUUID()), [], 'nobody is handed it again');
});

test('a hand-back that names no claim is refused', { skip }, async (t) => {
  const h = await harness(t);
  const ownerId = await h.newOwner('release-invalid');
  const runner = await h.newRunner(ownerId, 'the runner sending nonsense');
  const jobId = await h.queuedLanding(ownerId, runner, 'the landing a malformed hand-back names');
  const [claimed] = await h.beat(runner.runnerId, randomUUID());
  assert.equal(claimed?.jobId, jobId);
  for (const body of [
    { claimGeneration: claimed.claimGeneration, leaseOwner: '' },
    { claimGeneration: 'one', leaseOwner: 'somebody' },
    {} as never,
  ]) {
    assert.equal(await refusal(h.relay.release(jobId, runner.runnerId, body, ownerId)), 'INVALID_RESULT', JSON.stringify(body));
  }
  assert.equal((await h.row(jobId)).state, 'RUNNING', 'nothing moved');
});
