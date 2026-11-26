/**
 * Coordinator handoff v2 §1 (docs/coordinator-handoff-v2-design.md): pending work that is not a watch follows a
 * handoff, over a real PostgreSQL.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/projects/coordinator-handoff-pending-work.pg.spec.ts
 *
 *   SUBAGENT — a `delegate` run's wake, owed to a coordinator that handed over, is filed onto the successor
 *              (fileSubagentWake), and onto the last one of a two-handoff chain.
 *   JOB      — a `bg_run` job's wake, through the runner's background-wake door, the same.
 *   WAKEUP   — a pending `schedule_wakeup` row moves to the successor in the swap, and the worker files it there.
 *   LOOP     — a running wakeup loop and its tick move in the swap, the loop keeping its schedule.
 *   In every kind, a parent that ended without a handoff still drops the wake.
 *   The swap moves watches, wakeups and loops in one transaction: a swap that rolls back moves none of them.
 *   The pending-waits preview lists each kind with its label, and `movedWaits` records them.
 *
 * `ProjectsService` (the swap), `RunnerApiController.backgroundWake`, `fileSubagentWake` and
 * `ScheduledWakeupWorker` are the real ones; the real `SessionsService` files every wake turn. The swap's own
 * session calls (`create` of the successor, `complete` of the outgoing coordinator) are a stand-in that writes
 * real rows, as in coordinator-handoff.pg.spec.ts.
 *
 * Not destructive: every row belongs to a user this run creates.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';

import { type PrismaClient, type Runner, SessionDispatchOrigin } from '@prisma/client';
import { RunStatus } from '@orbit/shared';
import type { CoordinatorPendingWait } from '@orbit/shared';
import { Client } from 'pg';

import { sha256 } from '../common/crypto.util';
import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import type { RealtimeService } from '../realtime/realtime.service';
import {
  appendBackgroundWakeContext,
  BACKGROUND_WAKE_TURN_PREFIX,
  BackgroundWakeDto,
} from '../runner-api/background-job-wake';
import { HandoffInFlight } from '../runner-api/handoff-wake-forward';
import { RunnerApiController } from '../runner-api/runner-api.controller';
import { ScheduledWakeupWorker } from '../runner-api/scheduled-wakeup.worker';
import { fileSubagentWake } from '../runner-api/subagent-wake';
import { SessionsService } from '../sessions/sessions.service';
import { readSessionCoordinatorHandoffs } from './coordinator-handoff';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from './coordinator-pg-test-safety';
import { ProjectsService } from './projects.service';

const URL = process.env.COORDINATOR_PG_URL;
process.env.PROVIDER_SECRET_KEY ??= 'coordinator-handoff-pending-work-spec';
const skip = !URL;

const PREVIOUS = 'Started by the previous coordinator: ';

let harness: Promise<{ db: PrismaClient; sql: Client }> | undefined;
function boot() {
  harness ??= (async () => {
    assertCoordinatorPgUrlIsIsolated(URL);
    const sql = new Client({ connectionString: URL, connectionTimeoutMillis: 5_000 });
    await sql.connect();
    await verifyCoordinatorPgIdentity(sql);
    return { db: prismaClientFor(URL!), sql };
  })();
  return harness;
}

after(async () => {
  const h = await harness?.catch(() => undefined);
  if (!h) return;
  await h.db.$disconnect();
  await h.sql.end();
});

/** A collaborator whose every method answers nothing: the broadcasts the handlers fire. */
const silent = (): never =>
  new Proxy({}, { get: (_target, key) => (key === 'then' ? undefined : () => undefined) }) as never;

interface Fixture {
  db: PrismaClient;
  ownerId: string;
  projectId: string;
  workspaceId: string;
  runner: Runner;
  /** The project's first coordinator, on the fixture's runner. */
  first: string;
  taskId: string;
  projects: ProjectsService;
  sessions: SessionsService;
  door: RunnerApiController;
  worker: ScheduledWakeupWorker;
}

async function fixture(): Promise<Fixture> {
  const { db } = await boot();
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  await db.user.create({ data: { id: ownerId, email: `${ownerId}@handoff-pending.invalid`, name: 'o', passwordHash: 'x' } });
  const runner = (await db.runner.create({
    data: { id: runnerId, name: 'the coordinator machine', ownerId, tokenHash: sha256(`handoff-pending-${runnerId}`) },
  })) as Runner;
  const workspaceId = (await db.workspace.create({
    data: { ownerId, runnerId, name: `orbit-${runnerId.slice(-8)}`, enabled: true },
  })).id;
  const projectId = (await db.project.create({ data: { ownerId, title: 'Scheduled tasks v1' } })).id;
  const first = await coordinatorSession(db, ownerId, workspaceId, runnerId, 'the coordinator');
  await db.project.update({ where: { id: projectId }, data: { coordinatorSessionId: first, coordinatorWorkspaceId: workspaceId } });
  const taskId = (await db.task.create({
    data: { ownerId, creatorType: 'USER', creatorId: ownerId, title: 'Fix login redirect', projectId, completionCriterion: 'OWNER_CONFIRMED' },
  })).id;

  const sessions = new SessionsService(db as unknown as PrismaService, { notifySessionQueued: () => undefined } as never, silent());
  // The swap's own session calls: the successor is created on the same runner, the outgoing one completed.
  const swapSessions = {
    create: async (owner: string, dto: { workspaceId: string; title: string; prompt: string }) =>
      ({ id: await coordinatorSession(db, owner, dto.workspaceId, runnerId, dto.title) }),
    complete: async (_owner: string, id: string) => {
      await db.session.update({ where: { id }, data: { completedAt: new Date() } });
      return { ok: true };
    },
    discardProjectCoordinatorCandidate: async (_owner: string, id: string) => {
      await db.session.update({ where: { id }, data: { deletedAt: new Date() } });
      return true;
    },
    announceProjectSessionChanged: () => undefined,
  } as unknown as SessionsService;
  const realtime = new Proxy({}, { get: () => () => undefined }) as unknown as RealtimeService;
  const projects = new ProjectsService(db as unknown as PrismaService, undefined, swapSessions, realtime);
  const door = new RunnerApiController(
    db as never, silent(), silent(), silent(), silent(), silent(),
    undefined, undefined, undefined, undefined, undefined, sessions,
  );
  const worker = new ScheduledWakeupWorker(db as never, sessions);
  return { db, ownerId, projectId, workspaceId, runner, first, taskId, projects, sessions, door, worker };
}

/** A coordinator conversation parked between turns, on the fixture's runner. */
async function coordinatorSession(db: PrismaClient, ownerId: string, workspaceId: string, runnerId: string, title: string) {
  return (await db.session.create({
    data: {
      ownerId, creatorId: ownerId, workspaceId, assignedRunnerId: runnerId, title, prompt: 'coordinate',
      provider: 'claude', engine: 'claude', model: 'claude-opus-5-5', turnState: null, numTurns: 1,
      dispatchOrigin: SessionDispatchOrigin.USER, startsTaskWork: false, titleManagedByProject: true,
    },
  })).id;
}

/** Hand the project's current coordinator over, through the real swap; the successor's id. */
async function handOver(f: Fixture): Promise<string> {
  const from = (await f.db.project.findUniqueOrThrow({ where: { id: f.projectId } })).coordinatorSessionId!;
  const waits = await f.projects.coordinatorPendingWaits(f.ownerId, f.projectId);
  const row = await f.db.coordinatorHandoff.create({
    data: { ownerId: f.ownerId, projectId: f.projectId, fromSessionId: from, state: 'HANDING_OVER' },
  });
  const opened = await f.projects.coordinator(f.ownerId, f.projectId, undefined, 'replace', {
    id: row.id, fromSessionId: from, note: null, waits,
  });
  assert.equal(opened.created, true);
  assert.equal((await f.db.coordinatorHandoff.findUniqueOrThrow({ where: { id: row.id } })).state, 'COMPLETED');
  return opened.sessionId;
}

/** End a session the way the owner's Complete does, with no handoff. */
async function completeWithoutHandoff(f: Fixture, sessionId: string) {
  await f.db.session.update({ where: { id: sessionId }, data: { completedAt: new Date() } });
}

const wakeTurns = (f: Fixture, sessionId: string) =>
  f.db.conversationTurn.findMany({
    where: { sessionId, clientTurnId: { startsWith: BACKGROUND_WAKE_TURN_PREFIX } },
    orderBy: { seq: 'asc' },
  });

/** What the runner is handed for the session's one wake turn. */
async function delivered(f: Fixture, sessionId: string): Promise<string> {
  const turns = await wakeTurns(f, sessionId);
  assert.equal(turns.length, 1, `want one wake turn on ${sessionId}, found ${turns.length}`);
  return String(await appendBackgroundWakeContext(f.db as never, sessionId, turns[0].clientTurnId!, turns[0].content));
}

async function subagentRun(f: Fixture, sessionId: string, status = 'RUNNING') {
  return (await f.db.subagentRun.create({
    data: {
      ownerId: f.ownerId, sessionId, toolUseId: `toolu_${randomUUID().slice(0, 8)}`, type: 'general',
      definitionSource: 'builtin', background: true, status, decision: {},
      description: 'Deploy 55a189aa3 to production', wakeOwed: true,
    },
  })).id;
}

/** The run's end, as the runner reports it: what makes its owed wake fileable. */
async function endRun(f: Fixture, runId: string) {
  await f.db.subagentRun.update({
    where: { id: runId },
    data: { status: 'DONE', resultSummary: 'Deployed 55a189aa3; health checks green.', endedAt: new Date() },
  });
}

const jobWake = (jobId: string): BackgroundWakeDto => Object.assign(new BackgroundWakeDto(), {
  wakeId: `${jobId}:exit`, jobId, trigger: 'exit', kind: 'job', command: 'bash scripts/upgrade.sh --deploy 55a189aa3',
  description: 'Deploy 55a189aa3 to production', status: 'completed', exitCode: 0,
  outputPath: `/tmp/${jobId}.output`, outputOffset: 0, outputSize: 12, outputExcerpt: 'deployed ok\n',
});

async function oneShotWakeup(f: Fixture, sessionId: string) {
  return (await f.db.sessionScheduledWakeup.create({
    data: {
      sessionId, delaySeconds: 1200, reason: 'Check the deploy of 55a189aa3', prompt: 'Read the deploy job',
      dueAt: new Date(Date.now() + 1_200_000),
    },
  })).id;
}

async function loopWithTick(f: Fixture, sessionId: string) {
  const firstDueAt = new Date(Date.now() + 600_000);
  const untilAt = new Date(Date.now() + 86_400_000);
  const loop = await f.db.sessionWakeupLoop.create({
    data: { sessionId, everySeconds: 600, prompt: 'Check CI on main', reason: 'Watch CI on main', firstDueAt, untilAt },
  });
  const tick = await f.db.sessionScheduledWakeup.create({
    data: { sessionId, loopId: loop.id, delaySeconds: 600, reason: 'Watch CI on main', dueAt: firstDueAt },
  });
  return { loopId: loop.id, tickId: tick.id, firstDueAt, untilAt };
}

// ── SUBAGENT ─────────────────────────────────────────────────────────────────────────────────────

test('SUBAGENT: a run that ends after its coordinator handed over wakes the successor, named as the previous coordinator\'s', { skip, timeout: 120_000 }, async () => {
  const f = await fixture();
  const runId = await subagentRun(f, f.first);
  const successor = await handOver(f);
  await endRun(f, runId);

  assert.equal(await fileSubagentWake(f.db, f.sessions, runId), 'FILED');

  assert.equal((await wakeTurns(f, f.first)).length, 0, 'nothing is filed on the completed coordinator');
  const text = await delivered(f, successor);
  assert.match(text, /<orbit-subagent-finished>/);
  assert.ok(text.includes(`${PREVIOUS}Deploy 55a189aa3 to production`), text);
  assert.ok(text.includes('health checks green'), 'the run\'s result rides along');
  assert.ok((await f.db.subagentRun.findUniqueOrThrow({ where: { id: runId } })).wakeFiledAt, 'settled once');
});

test('SUBAGENT: across a two-handoff chain the wake reaches the last coordinator', { skip, timeout: 120_000 }, async () => {
  const f = await fixture();
  const runId = await subagentRun(f, f.first);
  const second = await handOver(f);
  const third = await handOver(f);
  await endRun(f, runId);

  assert.equal(await fileSubagentWake(f.db, f.sessions, runId), 'FILED');

  assert.equal((await wakeTurns(f, f.first)).length, 0);
  assert.equal((await wakeTurns(f, second)).length, 0, 'not the middle of the chain');
  assert.ok((await delivered(f, third)).includes(`${PREVIOUS}Deploy 55a189aa3 to production`));
});

test('SUBAGENT: a parent that ended without a handoff still drops the wake', { skip, timeout: 120_000 }, async () => {
  const f = await fixture();
  const runId = await subagentRun(f, f.first);
  await completeWithoutHandoff(f, f.first);
  await endRun(f, runId);

  assert.equal(await fileSubagentWake(f.db, f.sessions, runId), 'DROPPED');
  assert.equal((await f.db.conversationTurn.count({ where: { session: { ownerId: f.ownerId } } })), 0, 'no turn anywhere');
});

test('SUBAGENT: while the handoff is still HANDING_OVER the wake is neither filed nor dropped, and the sweep files it once COMPLETED', { skip, timeout: 120_000 }, async () => {
  const f = await fixture();
  const runId = await subagentRun(f, f.first);
  const row = await f.db.coordinatorHandoff.create({
    data: { ownerId: f.ownerId, projectId: f.projectId, fromSessionId: f.first, state: 'HANDING_OVER' },
  });
  await completeWithoutHandoff(f, f.first); // the replacement completes the outgoing coordinator before its swap
  await endRun(f, runId);

  await assert.rejects(fileSubagentWake(f.db, f.sessions, runId), HandoffInFlight);
  assert.equal((await f.db.subagentRun.findUniqueOrThrow({ where: { id: runId } })).wakeFiledAt, null, 'still owed');

  const successor = await coordinatorSession(f.db, f.ownerId, f.workspaceId, f.runner.id, 'the next coordinator');
  await f.db.coordinatorHandoff.update({ where: { id: row.id }, data: { state: 'COMPLETED', toSessionId: successor } });
  assert.equal(await fileSubagentWake(f.db, f.sessions, runId), 'FILED');
  assert.ok((await delivered(f, successor)).includes(`${PREVIOUS}Deploy 55a189aa3 to production`));
});

// ── JOB ──────────────────────────────────────────────────────────────────────────────────────────

test('JOB: a bg_run job that exits after its coordinator handed over wakes the successor, named as the previous coordinator\'s', { skip, timeout: 120_000 }, async () => {
  const f = await fixture();
  const successor = await handOver(f);
  const jobId = `bgj_${randomUUID().slice(0, 12)}`;

  const receipt = await f.door.backgroundWake(f.runner, f.first, jobWake(jobId));

  assert.equal(receipt.outcome, 'ENQUEUED');
  assert.equal((await wakeTurns(f, f.first)).length, 0);
  const text = await delivered(f, successor);
  assert.match(text, /<background-job-wake>/);
  assert.ok(text.includes(jobId));
  assert.ok(text.includes(`${PREVIOUS}Deploy 55a189aa3 to production`), text);
});

test('JOB: across a two-handoff chain the wake reaches the last coordinator', { skip, timeout: 120_000 }, async () => {
  const f = await fixture();
  const second = await handOver(f);
  const third = await handOver(f);
  const jobId = `bgj_${randomUUID().slice(0, 12)}`;

  assert.equal((await f.door.backgroundWake(f.runner, f.first, jobWake(jobId))).outcome, 'ENQUEUED');

  assert.equal((await wakeTurns(f, f.first)).length, 0);
  assert.equal((await wakeTurns(f, second)).length, 0, 'not the middle of the chain');
  assert.ok((await delivered(f, third)).includes(`${PREVIOUS}Deploy 55a189aa3 to production`));
});

test('JOB: a session that ended without a handoff still drops the wake; one HANDING_OVER is answered 503 to be asked again', { skip, timeout: 120_000 }, async () => {
  const f = await fixture();
  await completeWithoutHandoff(f, f.first);
  const jobId = `bgj_${randomUUID().slice(0, 12)}`;
  assert.deepEqual(await f.door.backgroundWake(f.runner, f.first, jobWake(jobId)), { outcome: 'DROPPED' });
  assert.equal((await f.db.conversationTurn.count({ where: { session: { ownerId: f.ownerId } } })), 0, 'no turn anywhere');

  await f.db.coordinatorHandoff.create({
    data: { ownerId: f.ownerId, projectId: f.projectId, fromSessionId: f.first, state: 'HANDING_OVER' },
  });
  await assert.rejects(f.door.backgroundWake(f.runner, f.first, jobWake(jobId)), (e: unknown) =>
    e instanceof HandoffInFlight && e.getStatus() === 503);
});

// ── WAKEUP ───────────────────────────────────────────────────────────────────────────────────────

test('WAKEUP: the pending wakeup moves to the successor in the swap, keeps its due time, and is filed there', { skip, timeout: 120_000 }, async () => {
  const f = await fixture();
  const wakeupId = await oneShotWakeup(f, f.first);
  const before = await f.db.sessionScheduledWakeup.findUniqueOrThrow({ where: { id: wakeupId } });
  const successor = await handOver(f);

  const moved = await f.db.sessionScheduledWakeup.findUniqueOrThrow({ where: { id: wakeupId } });
  assert.equal(moved.sessionId, successor);
  assert.equal(moved.state, 'PENDING');
  assert.equal(moved.dueAt.getTime(), before.dueAt.getTime(), 'its due time is kept');

  await f.db.sessionScheduledWakeup.update({ where: { id: wakeupId }, data: { dueAt: new Date(Date.now() - 1_000) } });
  // A pass that read the row before the swap, against the session it left, settles nothing.
  assert.equal(await f.worker.deliver(wakeupId, f.first, f.ownerId), 'SETTLED_ELSEWHERE');
  assert.equal((await f.db.sessionScheduledWakeup.findUniqueOrThrow({ where: { id: wakeupId } })).state, 'PENDING');

  assert.equal(await f.worker.deliver(wakeupId, successor, f.ownerId), 'DELIVERED');
  assert.equal((await wakeTurns(f, successor)).length, 1);
  assert.equal((await wakeTurns(f, f.first)).length, 0);
});

test('WAKEUP: across a two-handoff chain the row reaches the last coordinator', { skip, timeout: 120_000 }, async () => {
  const f = await fixture();
  const wakeupId = await oneShotWakeup(f, f.first);
  await handOver(f);
  const third = await handOver(f);
  assert.equal((await f.db.sessionScheduledWakeup.findUniqueOrThrow({ where: { id: wakeupId } })).sessionId, third);
});

test('WAKEUP: a coordinator that ended without a handoff still drops its due wakeup', { skip, timeout: 120_000 }, async () => {
  const f = await fixture();
  const wakeupId = await oneShotWakeup(f, f.first);
  await completeWithoutHandoff(f, f.first);
  await f.db.sessionScheduledWakeup.update({ where: { id: wakeupId }, data: { dueAt: new Date(Date.now() - 1_000) } });
  assert.equal(await f.worker.deliver(wakeupId, f.first, f.ownerId), 'DROPPED');
  const row = await f.db.sessionScheduledWakeup.findUniqueOrThrow({ where: { id: wakeupId } });
  assert.equal(row.sessionId, f.first);
  assert.equal(row.state, 'DROPPED');
});

// ── LOOP ─────────────────────────────────────────────────────────────────────────────────────────

test('LOOP: the running loop and its tick move to the successor in the swap, keeping the schedule, and tick there', { skip, timeout: 120_000 }, async () => {
  const f = await fixture();
  const { loopId, tickId, firstDueAt, untilAt } = await loopWithTick(f, f.first);
  const successor = await handOver(f);

  const loop = await f.db.sessionWakeupLoop.findUniqueOrThrow({ where: { id: loopId } });
  assert.equal(loop.sessionId, successor);
  assert.equal(loop.state, 'ACTIVE');
  assert.equal(loop.everySeconds, 600);
  assert.equal(loop.firstDueAt.getTime(), firstDueAt.getTime());
  assert.equal(loop.untilAt.getTime(), untilAt.getTime());
  const tick = await f.db.sessionScheduledWakeup.findUniqueOrThrow({ where: { id: tickId } });
  assert.equal(tick.sessionId, successor);
  assert.equal(tick.dueAt.getTime(), firstDueAt.getTime(), 'the tick keeps its due time');

  await f.db.sessionScheduledWakeup.update({ where: { id: tickId }, data: { dueAt: new Date(Date.now() - 1_000) } });
  assert.equal(await f.worker.deliverTick(tickId), 'DELIVERED');
  assert.equal((await wakeTurns(f, successor)).length, 1);
  const next = await f.db.sessionScheduledWakeup.findFirstOrThrow({ where: { loopId, state: 'PENDING' } });
  assert.equal(next.sessionId, successor, 'the next tick is the successor\'s');
  assert.equal((await f.db.sessionWakeupLoop.findUniqueOrThrow({ where: { id: loopId } })).state, 'ACTIVE');
});

test('LOOP: across a two-handoff chain the loop reaches the last coordinator', { skip, timeout: 120_000 }, async () => {
  const f = await fixture();
  const { loopId, tickId } = await loopWithTick(f, f.first);
  await handOver(f);
  const third = await handOver(f);
  assert.equal((await f.db.sessionWakeupLoop.findUniqueOrThrow({ where: { id: loopId } })).sessionId, third);
  assert.equal((await f.db.sessionScheduledWakeup.findUniqueOrThrow({ where: { id: tickId } })).sessionId, third);
});

test('LOOP: a coordinator that ended without a handoff still ends its loop at the next tick', { skip, timeout: 120_000 }, async () => {
  const f = await fixture();
  const { loopId, tickId } = await loopWithTick(f, f.first);
  await completeWithoutHandoff(f, f.first);
  await f.db.sessionScheduledWakeup.update({ where: { id: tickId }, data: { dueAt: new Date(Date.now() - 1_000) } });
  await f.worker.deliverTick(tickId);
  const loop = await f.db.sessionWakeupLoop.findUniqueOrThrow({ where: { id: loopId } });
  assert.equal(loop.sessionId, f.first);
  assert.equal(loop.state, 'ENDED');
  assert.equal((await f.db.conversationTurn.count({ where: { session: { ownerId: f.ownerId } } })), 0, 'no turn anywhere');
});

// ── The swap: one transaction ────────────────────────────────────────────────────────────────────

test('swap: watches, the wakeup and the loop move in one transaction — a swap that rolls back moves none of them', { skip, timeout: 120_000 }, async () => {
  const f = await fixture();
  const watchId = await watch(f, f.first);
  const wakeupId = await oneShotWakeup(f, f.first);
  const { loopId, tickId } = await loopWithTick(f, f.first);
  const owners = async () => ({
    watch: (await f.db.watch.findUniqueOrThrow({ where: { id: watchId } })).observerSessionId,
    wakeup: (await f.db.sessionScheduledWakeup.findUniqueOrThrow({ where: { id: wakeupId } })).sessionId,
    loop: (await f.db.sessionWakeupLoop.findUniqueOrThrow({ where: { id: loopId } })).sessionId,
    tick: (await f.db.sessionScheduledWakeup.findUniqueOrThrow({ where: { id: tickId } })).sessionId,
  });

  // A handoff that is no longer HANDING_OVER when the swap's last statement checks it: that statement throws
  // after the watch, wakeup and loop moves, and the transaction rolls all of them back.
  const stale = await f.db.coordinatorHandoff.create({
    data: { ownerId: f.ownerId, projectId: f.projectId, fromSessionId: f.first, state: 'WRITING' },
  });
  await assert.rejects(
    f.projects.coordinator(f.ownerId, f.projectId, undefined, 'replace', { id: stale.id, fromSessionId: f.first, note: null, waits: [] }),
    /no longer in progress/,
  );
  assert.deepEqual(await owners(), { watch: f.first, wakeup: f.first, loop: f.first, tick: f.first });
  await f.db.coordinatorHandoff.update({ where: { id: stale.id }, data: { state: 'CANCELLED' } });
  await f.db.session.update({ where: { id: f.first }, data: { completedAt: null } });

  // The swap that commits moves all of them together.
  const successor = await handOver(f);
  assert.deepEqual(await owners(), { watch: successor, wakeup: successor, loop: successor, tick: successor });
});

// ── The preview and movedWaits ───────────────────────────────────────────────────────────────────

async function watch(f: Fixture, observer: string) {
  const expiresAt = new Date(Date.now() + 3_600_000);
  return (await f.db.watch.create({
    data: {
      ownerId: f.ownerId, observerType: 'SESSION', observerSessionId: observer,
      predicate: { kind: 'ALL', over: 'ALL_TARGETS', leaf: 'TASK_DONE' }, action: 'RESUME_SESSION',
      state: 'ACTIVE', generation: 0, expiresAt, nextEvaluateAt: expiresAt,
      targets: { create: [{ targetKind: 'TASK', targetResourceId: f.taskId }] },
    },
  })).id;
}

test('pending-waits lists each kind with its label, oldest first, and movedWaits records them', { skip, timeout: 120_000 }, async () => {
  const f = await fixture();
  const watchId = await watch(f, f.first);
  const runId = await subagentRun(f, f.first);
  // A run that owes no wake (a foreground call still waiting for it) is not listed.
  await f.db.subagentRun.update({ where: { id: await subagentRun(f, f.first) }, data: { wakeOwed: false } });
  const jobId = `bgj_${randomUUID().slice(0, 12)}`;
  await f.db.toolCall.create({
    data: {
      sessionId: f.first, name: 'Bash', toolUseId: jobId, startedAt: new Date(),
      input: { command: 'bash scripts/upgrade.sh --deploy 55a189aa3', description: 'Deploy 55a189aa3 to production', run_in_background: true },
    },
  });
  await f.db.session.update({ where: { id: f.first }, data: { runningBgJobs: [jobId], runningBgShells: [jobId] } });
  const wakeupId = await oneShotWakeup(f, f.first);
  const { loopId, tickId } = await loopWithTick(f, f.first);

  const expected: CoordinatorPendingWait[] = [
    { id: watchId, kind: 'WATCH', label: 'Waiting for "Fix login redirect" to be DONE', paused: false },
    { id: runId, kind: 'SUBAGENT', label: 'Deploy 55a189aa3 to production', paused: false },
    { id: jobId, kind: 'JOB', label: 'Deploy 55a189aa3 to production', paused: false },
    { id: wakeupId, kind: 'WAKEUP', label: 'Check the deploy of 55a189aa3', paused: false },
    { id: loopId, kind: 'LOOP', label: 'Watch CI on main', paused: false },
  ];
  const preview = await f.projects.coordinatorPendingWaits(f.ownerId, f.projectId);
  assert.deepEqual(preview, expected);
  assert.ok(!preview.some((wait) => wait.id === tickId), 'a loop\'s tick is listed as its loop');

  const successor = await handOver(f);
  const received = (await readSessionCoordinatorHandoffs(f.db as unknown as PrismaService, successor)).coordinatorHandoffReceived;
  assert.deepEqual(received?.movedWaits, expected);
  assert.deepEqual(await f.projects.coordinatorPendingWaits(f.ownerId, f.projectId), [
    { id: watchId, kind: 'WATCH', label: 'Waiting for "Fix login redirect" to be DONE', paused: false },
    { id: wakeupId, kind: 'WAKEUP', label: 'Check the deploy of 55a189aa3', paused: false },
    { id: loopId, kind: 'LOOP', label: 'Watch CI on main', paused: false },
  ], 'what moved is the successor\'s now; the run and the job stay where they run, their wakes forwarded');
});

test('movedWaits recorded before kinds existed read as WATCH', { skip, timeout: 120_000 }, async () => {
  const f = await fixture();
  const successor = await coordinatorSession(f.db, f.ownerId, f.workspaceId, f.runner.id, 'the next coordinator');
  await f.db.coordinatorHandoff.create({
    data: {
      ownerId: f.ownerId, projectId: f.projectId, fromSessionId: f.first, toSessionId: successor, state: 'COMPLETED',
      movedWaits: [{ id: 'w1', label: 'Waiting for "Fix login redirect" to be DONE', paused: false }],
      endedAt: new Date(),
    },
  });
  const received = (await readSessionCoordinatorHandoffs(f.db as unknown as PrismaService, successor)).coordinatorHandoffReceived;
  assert.deepEqual(received?.movedWaits, [{ id: 'w1', kind: 'WATCH', label: 'Waiting for "Fix login redirect" to be DONE', paused: false }]);
});
