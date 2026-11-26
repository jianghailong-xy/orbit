import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { CreatorType, PrismaClient, RunnerStatus, SessionDispatchOrigin } from '@prisma/client';
import { RunStatus } from '@orbit/shared';

import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { assertCoordinatorPgUrlIsIsolated } from '../projects/coordinator-pg-test-safety';
import { QueueService } from '../queue/queue.service';
import { RealtimeService } from '../realtime/realtime.service';
import { TasksService } from '../tasks/tasks.service';
import { SessionsService } from './sessions.service';

/**
 * One background job, one verdict (docs/session-three-state-design.md §11.3 item 5, plan step 1.5),
 * against a real PostgreSQL:
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/sessions/quiet-job-one-verdict.pg.spec.ts
 *
 * Before: the task carrier counted any job in `running_bg_jobs`, while the session row and the
 * workspace rail counted only jobs that wrote output in the last ten minutes — so after ten quiet
 * minutes the task said running and the session said idle. Now one rule (common/session-working.ts):
 * a quiet job is still executing, and "no output for a while" is a flag beside it.
 *
 * A work session parked at AWAITING_INPUT with one `bg_run` job silent for eleven minutes is read
 * through each surface's production door: the task (`TasksService.withRunning`), the session row
 * (`SessionsService.listRowsByIds` and `get`) and the workspace rail (`workspaceSessionCounts`).
 * Each says executing with the stalled flag on. A twin whose job wrote a second ago is the control:
 * executing, flag off — so a reader that flagged every job, or none, fails here.
 */
const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;
const RUN = randomUUID().slice(0, 8);
const ELEVEN_MINUTES_MS = 11 * 60_000;

function connect() {
  const db = prismaClientFor(URL!);
  const prisma = db as unknown as PrismaService;
  const publishes = new Proxy({}, { get: () => () => undefined }) as unknown as RealtimeService;
  const sessions = new SessionsService(
    prisma,
    { notifySessionQueued: () => undefined } as unknown as QueueService,
    publishes,
  );
  return { db, sessions, tasks: new TasksService(prisma, sessions, publishes) };
}

/** An owner, a runner, a workspace and one task whose work session is parked with one job. */
async function world(db: PrismaClient, label: string, lastOutputAgoMs: number) {
  const ids = {
    ownerId: randomUUID(), runnerId: randomUUID(), workspaceId: randomUUID(), taskId: randomUUID(),
    sessionId: randomUUID(),
  };
  await db.user.create({
    data: { id: ids.ownerId, email: `${label}-${RUN}-${ids.ownerId}@quiet-job.invalid`, name: label, passwordHash: 'x' },
  });
  await db.runner.create({
    data: {
      id: ids.runnerId, ownerId: ids.ownerId, name: `${label}-runner`, tokenHash: `hash-${ids.runnerId}`,
      status: RunnerStatus.ONLINE, capabilities: [], capabilitiesReportedAt: new Date(), maxConcurrent: 8,
    },
  });
  await db.workspace.create({
    data: { id: ids.workspaceId, ownerId: ids.ownerId, runnerId: ids.runnerId, name: `${label}-agent`, enabled: true },
  });
  await db.task.create({
    data: {
      id: ids.taskId, ownerId: ids.ownerId, assigneeId: ids.workspaceId, title: `${label} task`,
      creatorType: CreatorType.USER, creatorId: ids.ownerId, provider: 'claude', completionCriterion: 'OWNER_CONFIRMED',
    },
  });
  await db.session.create({
    data: {
      id: ids.sessionId, ownerId: ids.ownerId, creatorId: ids.ownerId, taskId: ids.taskId,
      workspaceId: ids.workspaceId, assignedRunnerId: ids.runnerId, title: `${label} run`,
      prompt: 'the task brief', provider: 'claude', turnState: null,
      dispatchOrigin: SessionDispatchOrigin.USER, startsTaskWork: true,
      startedAt: new Date(Date.now() - 60 * 60_000), numTurns: 1,
      runningBgShells: ['bgj_build'],
      runningBgJobs: ['bgj_build'],
      runningBgJobActivity: { bgj_build: Date.now() - lastOutputAgoMs },
    },
  });
  return ids;
}

/** What the task, the session row (list and detail) and the workspace rail say about the job. */
async function readEverySurface(stack: ReturnType<typeof connect>, w: Awaited<ReturnType<typeof world>>) {
  const [task] = await stack.tasks.withRunning(w.ownerId, [{ id: w.taskId }], true);
  const [row] = await stack.sessions.listRowsByIds(w.ownerId, [w.sessionId]);
  const detail = await stack.sessions.get(w.ownerId, w.sessionId);
  const rail = (await stack.sessions.workspaceSessionCounts(w.ownerId)).find((r) => r.workspaceId === w.workspaceId);
  assert.ok(task && row && detail && rail, 'a surface did not answer for the session');
  return {
    task: { running: task.running, runReason: task.runReason, runStalled: task.runStalled },
    row: { activity: row.activity, runningBgJobsStalled: row.runningBgJobsStalled },
    detail: { runningBgJobsStalled: detail.runningBgJobsStalled },
    // Executing in the rail is `jobs + stalledJobs`; the split is the flag.
    rail: { executing: rail.jobs + rail.stalledJobs, stalled: rail.stalledJobs === 1, running: rail.running },
  };
}

test('a job silent for eleven minutes reads as executing, flagged stalled, on the task, the session row and the rail alike',
  { skip, timeout: 120_000 }, async () => {
    assertCoordinatorPgUrlIsIsolated(URL!);
    const stack = connect();
    try {
      const quiet = await readEverySurface(stack, await world(stack.db, 'quiet-job', ELEVEN_MINUTES_MS));
      assert.deepEqual(quiet.task, { running: true, runReason: 'BACKGROUND_JOB', runStalled: true }, 'the task');
      assert.deepEqual(quiet.row, { activity: 'BACKGROUND_JOB', runningBgJobsStalled: true }, 'the session row');
      assert.equal(quiet.detail.runningBgJobsStalled, true, 'the session detail');
      assert.deepEqual(quiet.rail, { executing: 1, stalled: true, running: 0 }, 'the workspace rail');

      const moving = await readEverySurface(stack, await world(stack.db, 'moving-job', 1_000));
      assert.deepEqual(moving.task, { running: true, runReason: 'BACKGROUND_JOB', runStalled: false }, 'the task (control)');
      assert.deepEqual(moving.row, { activity: 'BACKGROUND_JOB', runningBgJobsStalled: false }, 'the session row (control)');
      assert.equal(moving.detail.runningBgJobsStalled, false, 'the session detail (control)');
      assert.deepEqual(moving.rail, { executing: 1, stalled: false, running: 0 }, 'the workspace rail (control)');
    } finally {
      await stack.db.$disconnect();
    }
  });
