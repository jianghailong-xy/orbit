/**
 * A queued landing wakes the runner that will run it — at COMMIT, and only if the transaction
 * commits.
 *
 * WHY THE COMMIT IS THE SUBJECT, NOT THE NUDGE
 * -------------------------------------------
 * A runner parks in `GET /runner/wake` and beats the moment the control plane asks it to; without a
 * wake, the job queued for it waits for that machine's next 30s heartbeat before it even starts.
 * That floor was taken out from under a Merge press on 2026-10-06 (sessions.service calls
 * `notifyRunnerWake` after its transaction commits) and is still there for every task the platform
 * completes: a DONE queues a landing, and the landing starts whenever the runner happens to tick.
 *
 * A wake the queue emits itself has to arrive after the row it is about is visible — a wake sent
 * while the transaction is open buys one heartbeat that finds nothing and the same wait — and must
 * not arrive at all for a transaction the server discards. `pg_notify` gives both properties for
 * free: Postgres delivers a NOTIFY at COMMIT, so a rolled-back attempt (every `withTransactionRetry`
 * attempt a retry throws away) never wakes anyone. That is why the queue says it in the transaction
 * that writes the job row (realtime/runner-wake.ts#notifyRunnerWakeOnCommit) rather than at a
 * post-commit call site, of which this queue has a dozen.
 *
 * THE CASES
 * ---------
 *  (1) The DONE's landing wakes the runner the claim will hand it to — the WORKSPACE's runner, which
 *      is the join `claimOne` reads, not the session's own column.
 *  (2) Nothing is delivered while the queueing transaction is still open.
 *  (3) A transaction that rolls back wakes nobody — with a second runner as the positive control, so
 *      "nothing arrived" cannot be satisfied by a listener that is not working.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/projects/integration-job-queue-wake.pg.spec.ts
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { RunStatus, RunnerStatus, type PrismaClient } from '@prisma/client';
import { Client } from 'pg';
import { prismaClientFor } from '../prisma/prisma-client';
import { TasksService } from '../tasks/tasks.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from './coordinator-pg-test-safety';
import { enqueueForDoneTask } from './project-integration-job';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

const WOKEN = 'orbit_runner_wake';

/** The diff summary a session that delivered something reports. */
const WORK_REPORTED = [{ path: 'src/runner-go/worktree.go', status: 'M', additions: 36, deletions: 5 }];

/** Every wake payload the listener has been handed, in arrival order. */
interface WakeLog {
  readonly payloads: string[];
  /** Wait for one more delivery, or say it never came. */
  next(from: number, ms: number): Promise<string | null>;
}

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

  const payloads: string[] = [];
  sql.on('notification', (message) => {
    if (message.channel === WOKEN) payloads.push(message.payload ?? '');
  });
  await sql.query(`LISTEN ${WOKEN}`);
  const wakeLog: WakeLog = {
    payloads,
    async next(from, ms) {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) {
        if (payloads.length > from) return payloads[from];
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      return null;
    },
  };

  const tasks = new TasksService(prisma as never, {} as never, {
    publishTaskChanged() {},
    publishForUser() {},
  } as never);

  const ownerId = randomUUID();
  await prisma.user.create({
    data: {
      id: ownerId,
      email: `queue-wake-${ownerId}@integration-job-queue-wake.invalid`,
      name: 'Queue wake',
      passwordHash: 'x',
    },
  });

  /** A runner with a workspace its sessions run in: the pair the job's claim joins. */
  async function newRunner(name: string): Promise<{ runnerId: string; workspaceId: string }> {
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
        repoUrl: 'ssh://git@example.invalid/integration-job-queue-wake',
        workDir: `/srv/${name}`,
      },
    });
    return { runnerId, workspaceId };
  }

  /** One project whose line is already started: a DONE queues exactly its own landing. */
  async function newProject(): Promise<string> {
    const id = randomUUID();
    await prisma.project.create({ data: { id, ownerId, title: 'The project a DONE is landing into' } });
    await prisma.projectCodebase.create({
      data: {
        ownerId,
        projectId: id,
        canonicalRepoUrl: 'ssh://git@example.invalid/integration-job-queue-wake',
        upstreamRef: 'refs/heads/main',
        integrationRef: `refs/heads/project/${id}`,
        refAuthority: 'REMOTE',
        integrationRefSource: 'EXPLICIT',
        integrationStartedAt: new Date(Date.now() - 60_000),
      },
    });
    return id;
  }

  /** One work session, as the runner's finalize left it. */
  async function workSession(input: {
    taskId: string;
    workspaceId: string;
    runnerId: string;
    branch: string;
  }): Promise<string> {
    const id = randomUUID();
    await prisma.session.create({
      data: {
        id,
        ownerId,
        creatorId: ownerId,
        taskId: input.taskId,
        workspaceId: input.workspaceId,
        assignedRunnerId: input.runnerId,
        title: `ran ${input.branch}`,
        prompt: 'do the work',
        branch: input.branch,
        isolationStatus: 'worktree',
        status: RunStatus.SUCCEEDED,
        baseSha: '1'.repeat(40),
        changedFiles: WORK_REPORTED as never,
        createdAt: new Date(Date.now() - 5 * 60_000),
        finishedAt: new Date(Date.now() - 5 * 60_000),
      },
    });
    return id;
  }

  /** One finished task, through the same DONE fence the product writes. */
  async function settledTask(projectId: string, title: string): Promise<string> {
    const task = await tasks.create(ownerId, {
      title,
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
    return task.id;
  }

  return { prisma, sql, wakeLog, ownerId, tasks, newRunner, newProject, workSession, settledTask };
}

test('a DONE wakes the runner its landing will be handed to, and only once its transaction commits', { skip }, async (t) => {
  const h = await harness(t);
  const projectId = await h.newProject();
  const runner = await h.newRunner('the runner the work is on');
  const taskId = await h.settledTask(projectId, 'the work a landing is queued for');
  await h.workSession({ ...runner, taskId, branch: 'orbit/queue-wake-1' });

  await h.prisma.$transaction(async (tx) => {
    const queued = await enqueueForDoneTask(tx, h.ownerId, taskId);
    assert.ok(queued.enqueued, `the DONE queued no landing: ${JSON.stringify(queued)}`);
    // The notification is transactional: while this is open, nothing has been handed to the
    // listener. (What proves it is the rollback case below — delivery is asynchronous, so a wake
    // sent too early would still be in flight here rather than absent.)
    assert.equal(h.wakeLog.payloads.length, 0, 'the wake must not be delivered before commit');
  });

  const first = await h.wakeLog.next(0, 3_000);
  assert.ok(first, 'the committed landing must wake a runner');
  const payload = JSON.parse(first) as { r?: string; c?: boolean };
  assert.equal(payload.r, runner.runnerId, 'the wake names the runner whose workspace the session ran in');
  assert.equal(payload.c, true, 'and is marked as a committed-transaction wake (realtime/runner-wake.ts)');
});

test('a queueing transaction that rolls back wakes nobody', { skip }, async (t) => {
  const h = await harness(t);
  const projectId = await h.newProject();
  const landingRunner = await h.newRunner('the runner whose landing commits');
  const rolledBackRunner = await h.newRunner('the runner whose landing rolls back');
  const landingTask = await h.settledTask(projectId, 'the work that commits');
  const rolledBackTask = await h.settledTask(projectId, 'the work whose transaction rolls back');
  await h.workSession({ ...landingRunner, taskId: landingTask, branch: 'orbit/queue-wake-2' });
  await h.workSession({ ...rolledBackRunner, taskId: rolledBackTask, branch: 'orbit/queue-wake-3' });

  await assert.rejects(
    h.prisma.$transaction(async (tx) => {
      const queued = await enqueueForDoneTask(tx, h.ownerId, rolledBackTask);
      assert.ok(queued.enqueued, 'the rolled-back DONE did queue its landing');
      throw new Error('the transaction this queue ran in was discarded');
    }),
    /discarded/,
  );

  // The positive control: the same harness, the same listener, a transaction that DOES commit.
  await h.prisma.$transaction(async (tx) => {
    const queued = await enqueueForDoneTask(tx, h.ownerId, landingTask);
    assert.ok(queued.enqueued, 'the committed DONE queued its landing');
  });
  const delivered = await h.wakeLog.next(0, 3_000);
  assert.ok(delivered, 'the committed landing must wake its runner');
  assert.equal(
    (JSON.parse(delivered) as { r?: string }).r,
    landingRunner.runnerId,
    'the only wake delivered is the committed one, for its own runner',
  );
  assert.equal(
    h.wakeLog.payloads.filter((p) => p.includes(rolledBackRunner.runnerId)).length,
    0,
    'the discarded transaction woke nobody: a rolled-back attempt is not work to beat for',
  );
});
