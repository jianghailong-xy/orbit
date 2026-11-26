import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { CreatorType, type PrismaClient, RunnerStatus, SessionDispatchOrigin } from '@prisma/client';
import { RunStatus } from '@orbit/shared';
import { RunEventType } from '@orbit/shared';

import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import { assertCoordinatorPgUrlIsIsolated } from '../projects/coordinator-pg-test-safety';
import type { QueueService } from '../queue/queue.service';
import { SessionsService } from '../sessions/sessions.service';
import { TasksService } from '../tasks/tasks.service';
import { RUNNER_OFFLINE_JOB_REASON, RUNNER_OFFLINE_SUBAGENT_RESULT } from './lost-runner-work';
import type { RealtimeService } from './realtime.service';
import { ReaperService } from './reaper.service';
import { wordOf } from '../test-support/session-word';

/**
 * A lost runner settles the idle-looking session that was executing on it (plan step 1.7, design §11.3 item 4), against
 * a real PostgreSQL, through the reaper's own sweep:
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/realtime/reaper-lost-runner-work.pg.spec.ts
 *
 * A runner last heard from ten minutes ago holds three sessions, each parked at AWAITING_INPUT on a task of its own:
 *   - one with a runner-hosted job running (`bgj_lost`), whose task reads BACKGROUND_JOB;
 *   - one with a SubAgent run, whose task reads TURN;
 *   - one with nothing executing;
 *   - one with only an engine turn of its own.
 * After one sweep, the first has empty sets and the exit wake of `bgj_lost` filed as a turn (killed, `runner_offline`),
 * so its task no longer reads as carried by a background job; the second has its SubAgent run ended INTERRUPTED with its
 * wake filed; the idle one is untouched to the column; the last has its turn cleared and nothing filed. None is failed.
 *
 * The sweep is narrowed to this run's sessions (the reaper reads every session; other specs share the database).
 */
const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;
const RUN = randomUUID().slice(0, 8);

test('a lost runner: the idle-looking session with a job and a SubAgent is settled and woken; an idle one is untouched',
  { skip, timeout: 120_000 }, async () => {
    assertCoordinatorPgUrlIsIsolated(URL!);
    const db: PrismaClient = prismaClientFor(URL!);
    try {
      const prisma = db as unknown as PrismaService;
      const realtime = new Proxy({}, { get: () => () => undefined }) as unknown as RealtimeService;
      const sessions = new SessionsService(prisma, { notifySessionQueued: () => undefined } as unknown as QueueService, realtime);
      const tasks = new TasksService(prisma, sessions, realtime);

      const ownerId = randomUUID();
      const runnerId = randomUUID();
      const workspaceId = randomUUID();
      await db.user.create({ data: { id: ownerId, email: `lost-${RUN}-${ownerId}@lost-runner.invalid`, name: 'owner', passwordHash: 'x' } });
      await db.runner.create({
        data: {
          id: runnerId, ownerId, name: `lost-${RUN}`, tokenHash: `hash-${runnerId}`, status: RunnerStatus.ONLINE,
          capabilities: [], capabilitiesReportedAt: new Date(), maxConcurrent: 8,
          // Silent for ten minutes: past the five-minute reap line, and it never came back.
          lastHeartbeatAt: new Date(Date.now() - 10 * 60_000),
        },
      });
      await db.workspace.create({ data: { id: workspaceId, ownerId, runnerId, name: `lost-${RUN}`, enabled: true } });

      async function parked(label: string, data: Record<string, unknown>) {
        const taskId = randomUUID();
        const sessionId = randomUUID();
        await db.task.create({
          data: {
            id: taskId, ownerId, assigneeId: workspaceId, title: `${label} task`, creatorType: CreatorType.USER,
            creatorId: ownerId, provider: 'claude', completionCriterion: 'OWNER_CONFIRMED',
          },
        });
        await db.session.create({
          data: {
            id: sessionId, ownerId, creatorId: ownerId, taskId, workspaceId, assignedRunnerId: runnerId, title: label,
            prompt: 'the task brief', provider: 'claude', turnState: null,
            dispatchOrigin: SessionDispatchOrigin.USER, startsTaskWork: true, numTurns: 1,
            startedAt: new Date(Date.now() - 60 * 60_000), runClaimedAt: new Date(Date.now() - 60 * 60_000),
            ...data,
          },
        });
        return { taskId, sessionId };
      }

      const withJob = await parked('with a job', {
        runningBgShells: ['bgj_lost'], runningBgJobs: ['bgj_lost'], runningBgJobActivity: { bgj_lost: Date.now() - 60_000 },
      });
      const withSubagent = await parked('with a SubAgent', { runningSubagents: ['toolu_sub'] });
      await db.runEvent.create({
        data: {
          sessionId: withJob.sessionId, seq: 1, type: RunEventType.BACKGROUND_TASK,
          payload: { toolUseId: 'bgj_lost', shellId: 'bgj_lost', status: 'running', kind: 'job', command: 'npm test', outputPath: '/runs/bgj_lost.output' },
        },
      });
      const subRun = await db.subagentRun.create({
        data: {
          ownerId, sessionId: withSubagent.sessionId, toolUseId: 'toolu_sub', type: 'general', definitionSource: 'builtin',
          background: true, decision: {}, description: 'look into the flake',
        },
      });
      const idle = await parked('idle', {});
      const engineOnly = await parked('engine turn only', { engineTurnActive: true });

      const before = await tasks.withRunning(ownerId, [{ id: withJob.taskId }, { id: withSubagent.taskId }], true);
      assert.deepEqual(before.map((t) => t.runReason), ['BACKGROUND_JOB', 'TURN'],
        'the control: before the sweep one task reads carried by its job, the other by its SubAgent');
      const idleBefore = await db.session.findUniqueOrThrow({ where: { id: idle.sessionId } });

      // The sweep, narrowed to this run's sessions.
      const scoped = new Proxy(db, {
        get(target, key, receiver) {
          if (key !== 'session') return Reflect.get(target, key, receiver);
          const delegate = target.session;
          return new Proxy(delegate, {
            get(d, k, r) {
              if (k !== 'findMany') return Reflect.get(d, k, r);
              return (args: { where?: object }) => d.findMany({ ...args, where: { ...(args?.where ?? {}), ownerId } } as never);
            },
          });
        },
      }) as unknown as PrismaService;
      const reaper = new ReaperService(scoped, realtime, undefined, undefined, undefined, undefined, { get: () => sessions } as never);
      await (reaper as unknown as { sweep(): Promise<void> }).sweep();

      // The session with a job: sets emptied, not failed, woken.
      const settled = await db.session.findUniqueOrThrow({ where: { id: withJob.sessionId } });
      assert.deepEqual(
        {
          shells: settled.runningBgShells, jobs: settled.runningBgJobs, activity: settled.runningBgJobActivity,
          subagents: settled.runningSubagents, turn: settled.engineTurnActive, error: settled.error,
        },
        { shells: [], jobs: [], activity: {}, subagents: [], turn: false, error: null },
      );
      assert.notEqual(wordOf(settled), RunStatus.FAILED, 'nothing the session was asked to do failed');
      const wakes = await db.backgroundJobWake.findMany({ where: { sessionId: withJob.sessionId } });
      assert.deepEqual(
        wakes.map((w) => ({ jobId: w.jobId, trigger: w.trigger, status: w.status, reason: w.reason, command: w.command, outputPath: w.outputPath })),
        [{ jobId: 'bgj_lost', trigger: 'exit', status: 'killed', reason: RUNNER_OFFLINE_JOB_REASON, command: 'npm test', outputPath: '/runs/bgj_lost.output' }],
        'the wake a killed job would have sent is recorded',
      );
      const wakeTurns = await db.conversationTurn.findMany({ where: { sessionId: withJob.sessionId, clientTurnId: { startsWith: 'bg-wake:' } } });
      assert.deepEqual(wakeTurns.map((t) => [t.clientTurnId, t.status]), [['bg-wake:bgj_lost:lost', 'PENDING']], 'one queued wake turn');

      // The session with a SubAgent: its set emptied, the run ended INTERRUPTED and its wake filed onto a turn.
      const sub = await db.session.findUniqueOrThrow({ where: { id: withSubagent.sessionId } });
      assert.deepEqual(sub.runningSubagents, []);
      assert.notEqual(wordOf(sub), RunStatus.FAILED);
      assert.equal(await db.conversationTurn.count({ where: { sessionId: withSubagent.sessionId, clientTurnId: { startsWith: 'bg-wake:' } } }), 1,
        'the SubAgent\'s wake is a queued turn of its parent');
      const run = await db.subagentRun.findUniqueOrThrow({ where: { id: subRun.id } });
      assert.equal(run.status, 'INTERRUPTED');
      assert.equal(run.resultSummary, RUNNER_OFFLINE_SUBAGENT_RESULT);
      assert.ok(run.wakeOwed && run.wakeFiledAt, 'the SubAgent run owes its parent a wake, and it was filed');
      const after = await tasks.withRunning(ownerId, [{ id: withJob.taskId }], true);
      assert.notEqual(after[0]?.runReason, 'BACKGROUND_JOB', 'the task no longer reads as carried by a background job');

      // The idle session: untouched to the column.
      const idleAfter = await db.session.findUniqueOrThrow({ where: { id: idle.sessionId } });
      assert.deepEqual(idleAfter, idleBefore, 'a session with nothing executing is not touched');
      assert.equal(await db.conversationTurn.count({ where: { sessionId: idle.sessionId, clientTurnId: { startsWith: 'bg-wake:' } } }), 0);

      // An engine turn alone: cleared, nothing filed, not failed.
      const engine = await db.session.findUniqueOrThrow({ where: { id: engineOnly.sessionId } });
      assert.equal(engine.engineTurnActive, false);
      assert.equal(wordOf(engine), RunStatus.AWAITING_INPUT);
      assert.equal(await db.conversationTurn.count({ where: { sessionId: engineOnly.sessionId, clientTurnId: { startsWith: 'bg-wake:' } } }), 0);

      // A second sweep finds nothing left to settle.
      const settledAgain = await db.session.findUniqueOrThrow({ where: { id: withJob.sessionId } });
      await (reaper as unknown as { sweep(): Promise<void> }).sweep();
      assert.equal(await db.backgroundJobWake.count({ where: { sessionId: withJob.sessionId } }), 1, 'no second wake');
      assert.deepEqual(
        (await db.session.findUniqueOrThrow({ where: { id: withJob.sessionId } })).updatedAt, settledAgain.updatedAt,
        'the second sweep wrote nothing',
      );
    } finally {
      await db.$disconnect();
    }
  });
