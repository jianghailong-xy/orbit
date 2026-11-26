import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import {
  CreatorType,
  PrismaClient,
  RunnerStatus,
  SessionDispatchOrigin,
  TaskStatus,
} from '@prisma/client';
import { RunStatus } from '@orbit/shared';

import { RunEventType, RunStatus as SharedRunStatus } from '@orbit/shared';

import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { assertCoordinatorPgUrlIsIsolated } from '../projects/coordinator-pg-test-safety';
import { establishProjectContractForPgTest } from '../projects/project-contract-test-helper';
import { QueueService } from '../queue/queue.service';
import { RealtimeService } from '../realtime/realtime.service';
import { RunnerApiController } from '../runner-api/runner-api.controller';
import { SessionsService } from '../sessions/sessions.service';
import { completeHumanTaskForPgTest } from './task-completion-test-helper';
import { TasksService } from './tasks.service';
import '../test-support/dequeue-under-lease';
import { turnStateOfWord } from '../sessions/session-turn-state';

/**
 * §12.15 P-M1 on a real runner: a DONE over an open work session releases its dependents at that
 * session's finish, which the DONE itself requests.
 *
 *   COORDINATOR_PG_URL=postgresql://... node --test build/tasks/done-ends-idle-work.pg.spec.js
 *
 * An EXECUTABLE task's DONE is written by `turnComplete` while its work session is still open
 * (`finished_at` NULL), so the delivered identity is not frozen and J9 holds the dependents until the
 * finish. Before this, the finish came when the reaper's next sweep (REAP_INTERVAL_MS, 30 s) ended the
 * parked session: measured on a real runner, every dependency layer waited ~29 s after its DONE. Now
 * the completion edge every DONE door runs asks for that end at once (`endIdleWorkOfDoneTask`).
 *
 * No reaper is constructed anywhere in this file: what ends the session is the DONE's own request,
 * drained by the runner's finalize, and nothing waits on a sweep interval.
 *
 * Not destructive: every case owns freshly generated ids.
 */
const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;
const RUN = randomUUID().slice(0, 8);
/** The commit the work forked from and, with no commit of its own, still ends on. */
const BASE = 'b'.repeat(40);

interface Stack {
  db: PrismaClient;
  api: RunnerApiController;
  tasks: TasksService;
  /** Runner ids the realtime layer was asked to hint, and sessions whose inbox was poked. */
  cancels: string[];
  inboxes: string[];
}

function connect(): Stack {
  assertCoordinatorPgUrlIsIsolated(URL!);
  const db = prismaClientFor(URL!);
  const prisma = db as unknown as PrismaService;
  const cancels: string[] = [];
  const inboxes: string[] = [];
  const realtime = new Proxy({}, {
    get: (_target, property) => {
      if (property === 'requestCancel') return (runnerId: string) => { cancels.push(runnerId); };
      if (property === 'notifyInbox') return (sessionId: string) => { inboxes.push(sessionId); };
      return () => undefined;
    },
  }) as unknown as RealtimeService;
  const queue = { notifySessionQueued: () => undefined } as unknown as QueueService;
  const sessions = new SessionsService(prisma, queue, realtime);
  const tasks = new TasksService(prisma, sessions, realtime);
  const api = new RunnerApiController(
    prisma,
    queue,
    realtime,
    {} as never,
    {} as never,
    {} as never,
    { appendFor: async (_tx: unknown, _sessionId: string, content?: string) => content } as never,
    undefined,
    undefined,
    tasks,
  );
  return { db, api, tasks, cancels, inboxes };
}

interface World {
  ownerId: string;
  runnerId: string;
  workspaceId: string;
  projectId: string;
}

/** An owner, one online runner with room, its workspace, and a started project with no line. */
async function world(db: PrismaClient, label: string): Promise<World> {
  const ids = { ownerId: randomUUID(), runnerId: randomUUID(), workspaceId: randomUUID(), projectId: randomUUID() };
  await db.user.create({
    data: { id: ids.ownerId, email: `${label}-${RUN}-${ids.ownerId}@done-ends.invalid`, name: label, passwordHash: 'x' },
  });
  await db.runner.create({
    data: {
      id: ids.runnerId, ownerId: ids.ownerId, name: `${label}-runner`, tokenHash: `hash-${ids.runnerId}`,
      status: RunnerStatus.ONLINE, capabilities: [], capabilitiesReportedAt: new Date(), maxConcurrent: 8,
    },
  });
  await db.workspace.create({
    data: { id: ids.workspaceId, ownerId: ids.ownerId, runnerId: ids.runnerId, name: `${label}-workspace`, enabled: true },
  });
  await db.project.create({
    data: {
      id: ids.projectId, ownerId: ids.ownerId, title: label, coordinatorEnabled: false,
      maxConcurrentTasks: 3, startedAt: new Date(),
    },
  });
  await establishProjectContractForPgTest(db, ids.ownerId, ids.projectId, label);
  return ids;
}

/** A task that depends on `prerequisiteId` and starts by itself once it is released. */
async function dependent(db: PrismaClient, w: World, prerequisiteId: string): Promise<string> {
  const id = randomUUID();
  await db.task.create({
    data: {
      id, ownerId: w.ownerId, projectId: w.projectId, assigneeId: w.workspaceId, title: 'the dependent',
      creatorType: CreatorType.USER, creatorId: w.ownerId, provider: 'claude',
      completionCriterion: 'EVIDENCE_JUDGMENT', status: TaskStatus.OPEN, autoRunWhenReady: true, dispatchHold: false,
    },
  });
  await db.taskDependency.create({ data: { taskId: id, dependsOnTaskId: prerequisiteId } });
  return id;
}

/**
 * The work session a real run leaves: in a worktree on its own branch, forked from BASE and still on
 * it — no commit of its own, nothing changed, nothing uncommitted.
 */
async function workSession(
  db: PrismaClient,
  w: World,
  taskId: string,
  status: RunStatus,
): Promise<{ sessionId: string; branch: string }> {
  const sessionId = randomUUID();
  const branch = `orbit/task-${sessionId.slice(0, 8)}`;
  await db.session.create({
    data: {
      id: sessionId, ownerId: w.ownerId, creatorId: w.ownerId, taskId, workspaceId: w.workspaceId,
      assignedRunnerId: w.runnerId, title: 'work', prompt: 'work', provider: 'claude', turnState: turnStateOfWord(status),
      dispatchOrigin: SessionDispatchOrigin.USER, startsTaskWork: true,
      isolationStatus: 'worktree', branch, worktreeBranch: branch, baseSha: BASE, branchSha: BASE,
      changedFiles: [], worktreeDirty: false,
    },
  });
  return { sessionId, branch };
}

/** A message turn the engine is running and has replied to, so its completion answers it. */
async function messageInFlight(db: PrismaClient, sessionId: string, seq: number): Promise<string> {
  const turnId = randomUUID();
  await db.conversationTurn.create({
    data: {
      id: turnId, sessionId, seq, clientTurnId: `message:${turnId}`, kind: 'message',
      content: 'do the task', status: 'IN_FLIGHT', deliveredAt: new Date(),
    },
  });
  await db.runEvent.create({
    data: { sessionId, seq: seq * 1000, type: RunEventType.ASSISTANT, payload: { text: 'done' }, turnId },
  });
  return turnId;
}

const endTurns = (db: PrismaClient, sessionId: string) =>
  db.conversationTurn.findMany({ where: { sessionId, kind: 'end' }, select: { status: true } });

test('an EXECUTABLE DONE requests its idle work session\'s end, and that finish releases the dependent',
  { skip, timeout: 180_000 }, async () => {
    const s = connect();
    try {
      const w = await world(s.db, 'executable-done');
      const declared = await s.tasks.create(w.ownerId, {
        title: 'no commit of its own',
        assigneeId: w.workspaceId,
        projectId: w.projectId,
        acceptanceCommand: 'true',
        acceptanceExpectedExitCode: 0,
        autoRunWhenReady: false,
      });
      assert.equal(declared.completionCriterion, 'EXECUTABLE');
      const taskId = declared.id;
      const next = await dependent(s.db, w, taskId);
      const { sessionId, branch } = await workSession(s.db, w, taskId, RunStatus.RUNNING);
      const messageTurnId = await messageInFlight(s.db, sessionId, 1);

      // The model turn ends and queues the declared command; the runner runs it and reports 0.
      assert.deepEqual(
        await s.api.turnComplete({ id: w.runnerId }, sessionId, { turnId: messageTurnId, status: SharedRunStatus.SUCCEEDED }),
        { ok: true, status: RunStatus.RUNNING },
      );
      const acceptance = await (s.api as unknown as {
        dequeueTurn: (sessionId: string, runnerId: string, lease: string | null) =>
          Promise<{ turnId: string; kind: string; content?: string } | null>;
      }).dequeueTurn(sessionId, w.runnerId, null);
      assert.ok(acceptance);
      assert.equal(acceptance.kind, 'shell');
      const shell = spawnSync('bash', ['-lc', acceptance.content!], { encoding: 'utf8' });
      assert.equal(shell.status, 0);
      const doneAt = Date.now();
      const reported = await s.api.turnComplete({ id: w.runnerId }, sessionId, {
        turnId: acceptance.turnId,
        status: SharedRunStatus.SUCCEEDED,
        subtype: 'shell',
        shellExitCode: 0,
        shellOutput: '',
      });
      assert.deepEqual(reported, { ok: true, status: RunStatus.AWAITING_INPUT });
      assert.equal((await s.db.task.findUniqueOrThrow({ where: { id: taskId } })).status, TaskStatus.DONE);

      // The DONE asked for its work session's end in the call that wrote it: no sweep came between.
      const parked = await s.db.session.findUniqueOrThrow({
        where: { id: sessionId },
        select: { status: true, finishedAt: true, cancelRequestedAt: true, endReason: true },
      });
      assert.equal(parked.finishedAt, null, 'the work is still open: the runner has not finished it yet');
      assert.ok(parked.cancelRequestedAt, 'the DONE requested the end of its idle work session');
      assert.equal(parked.endReason, 'task_done');
      assert.ok(parked.cancelRequestedAt.getTime() >= doneAt);
      assert.deepEqual(await endTurns(s.db, sessionId), [{ status: 'PENDING' }], 'one end turn waits for the runner');
      assert.ok(s.cancels.includes(w.runnerId), 'the runner was told to drain it');
      assert.ok(s.inboxes.includes(sessionId));
      // J9 still holds the dependent: the work has not settled, so whether it lands is not known yet.
      assert.equal(await s.db.session.count({ where: { taskId: next } }), 0);

      // The runner drains the end: its finalize writes the finish on the branch the work forked from.
      const finalized = await s.api.finalize({ id: w.runnerId }, sessionId, {
        status: SharedRunStatus.SUCCEEDED,
        subtype: 'success',
        numTurns: 2,
        costUsd: 0,
        isolationStatus: 'worktree',
        worktreeBranch: branch,
        baseSha: BASE,
        branchSha: BASE,
        changedFiles: [],
        worktreeDirty: false,
      } as never);
      assert.equal(finalized.ok, true);

      const task = await s.db.task.findUniqueOrThrow({
        where: { id: taskId }, select: { deliveredSha: true, deliveredBaseSha: true },
      });
      assert.equal(task.deliveredSha, BASE, 'the finish froze the branch it ended on');
      assert.equal(task.deliveredBaseSha, BASE, 'with no commit of its own');
      const runs = await s.db.session.findMany({
        where: { taskId: next }, select: { startsTaskWork: true },
      });
      assert.equal(runs.length, 1, 'the finish the DONE requested dispatched the dependent');
      assert.equal(runs[0]!.startsTaskWork, true);
      assert.equal(await s.db.projectIntegrationJob.count({ where: { taskId } }), 0, 'no integration job');
      assert.equal(await s.db.projectCodebase.count({ where: { projectId: w.projectId } }), 0, 'no codebase row, no line');
    } finally {
      await s.db.$disconnect();
    }
  });

test('a DONE leaves to the reaper a work session that still has something to do',
  { skip, timeout: 120_000 }, async () => {
    const s = connect();
    try {
      const w = await world(s.db, 'still-busy');
      const doneTask = async (title: string) => {
        const id = randomUUID();
        await s.db.task.create({
          data: {
            id, ownerId: w.ownerId, projectId: w.projectId, assigneeId: w.workspaceId, title,
            creatorType: CreatorType.USER, creatorId: w.ownerId, completionCriterion: 'EVIDENCE_JUDGMENT',
            status: TaskStatus.DONE, autoRunWhenReady: false,
          },
        });
        return id;
      };

      // A queued turn: the session is parked but has a message waiting for it.
      const queuedTask = await doneTask('queued turn');
      const queued = await workSession(s.db, w, queuedTask, RunStatus.AWAITING_INPUT);
      await s.db.conversationTurn.create({
        data: { sessionId: queued.sessionId, seq: 1, clientTurnId: randomUUID(), kind: 'message', content: 'one more', status: 'PENDING' },
      });

      // An open request addressed to it, from another session that waits for its answer.
      const askedTask = await doneTask('open request');
      const asked = await workSession(s.db, w, askedTask, RunStatus.AWAITING_INPUT);
      const asker = await workSession(s.db, w, await doneTask('asker'), RunStatus.AWAITING_INPUT);
      const askTurn = await s.db.conversationTurn.create({
        data: { sessionId: asked.sessionId, seq: 1, clientTurnId: randomUUID(), kind: 'message', content: 'a question', status: 'ANSWERED', deliveredAt: new Date() },
      });
      await s.db.sessionRequest.create({
        data: {
          ownerId: w.ownerId, fromSessionId: asker.sessionId, toSessionId: asked.sessionId, turnId: askTurn.id,
          clientTurnId: askTurn.clientTurnId, requestPreview: 'a question', replyBy: new Date(Date.now() + 3_600_000),
        },
      });

      // The control: the same parked work with nothing left to do.
      const idleTask = await doneTask('idle');
      const idle = await workSession(s.db, w, idleTask, RunStatus.AWAITING_INPUT);

      for (const taskId of [queuedTask, askedTask, idleTask]) {
        await s.tasks.dispatchDependentsAfterCompletion(w.ownerId, taskId);
      }
      const requested = async (sessionId: string) =>
        (await s.db.session.findUniqueOrThrow({ where: { id: sessionId }, select: { cancelRequestedAt: true } }))
          .cancelRequestedAt !== null;
      assert.equal(await requested(queued.sessionId), false, 'a queued turn keeps the session');
      assert.equal(await requested(asked.sessionId), false, 'an open request keeps the session');
      assert.equal(await requested(idle.sessionId), true, 'idle work of a DONE task is ended by the DONE');
      assert.deepEqual(await endTurns(s.db, queued.sessionId), []);
      assert.deepEqual(await endTurns(s.db, asked.sessionId), []);
      assert.deepEqual(await endTurns(s.db, idle.sessionId), [{ status: 'PENDING' }]);
    } finally {
      await s.db.$disconnect();
    }
  });

test('a DONE written while its work session was in a turn is answered by that turn\'s park',
  { skip, timeout: 120_000 }, async () => {
    const s = connect();
    try {
      const w = await world(s.db, 'done-mid-turn');
      const taskId = randomUUID();
      await s.db.task.create({
        data: {
          id: taskId, ownerId: w.ownerId, projectId: w.projectId, assigneeId: w.workspaceId, title: 'confirmed mid-turn',
          creatorType: CreatorType.USER, creatorId: w.ownerId, completionCriterion: 'EVIDENCE_JUDGMENT',
          status: TaskStatus.IN_PROGRESS, autoRunWhenReady: false,
        },
      });
      const { sessionId } = await workSession(s.db, w, taskId, RunStatus.RUNNING);
      const turnId = await messageInFlight(s.db, sessionId, 1);
      // Another door (an evidence CONFIRM, the owner's Confirm done) writes DONE while the turn runs;
      // its edge finds the session busy and leaves it.
      await completeHumanTaskForPgTest(s.db, w.ownerId, taskId, 'confirmed mid-turn');
      assert.equal((await s.db.task.findUniqueOrThrow({ where: { id: taskId } })).status, TaskStatus.DONE);
      await s.tasks.dispatchDependentsAfterCompletion(w.ownerId, taskId);
      assert.equal(
        (await s.db.session.findUniqueOrThrow({ where: { id: sessionId }, select: { cancelRequestedAt: true } })).cancelRequestedAt,
        null,
        'a session in its turn is not ended under it',
      );

      assert.deepEqual(
        await s.api.turnComplete({ id: w.runnerId }, sessionId, { turnId, status: SharedRunStatus.SUCCEEDED }),
        { ok: true, status: RunStatus.AWAITING_INPUT },
      );
      const after = await s.db.session.findUniqueOrThrow({
        where: { id: sessionId }, select: { cancelRequestedAt: true, endReason: true },
      });
      assert.ok(after.cancelRequestedAt, 'the park of a DONE task\'s work asks for its end');
      assert.equal(after.endReason, 'task_done');
      assert.deepEqual(await endTurns(s.db, sessionId), [{ status: 'PENDING' }]);
    } finally {
      await s.db.$disconnect();
    }
  });
