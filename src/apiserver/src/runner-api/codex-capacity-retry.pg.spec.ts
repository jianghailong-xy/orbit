/**
 * A CODEX RUN A BUSY MODEL STOPPED GOES ON BY ITSELF, AND SAYS WHAT STOPPED IT.
 *
 * On 2026-09-29 a task run on gpt-5.6-sol worked for fifty minutes and then died on Codex's
 * "Selected model is at capacity. Please try a different model." Three things went wrong at once:
 *
 *   - Nothing retried it. The retry ladder only knew Claude Code's `API Error:` prefix, Codex reports
 *     the overload as the turn's error (an `error` event) rather than as a reply, and a task's run was
 *     left to its task besides. Its owner resumed it by hand seven minutes later with "continue", and
 *     the same model answered.
 *   - The session's error, and the task's failure comment, named the agent's last sentence — "代码核验
 *     结果与预期一致…" — as the reason: the runner put the turn's reply where the failure goes.
 *   - The comment told whoever read the task to re-run it, beside a run that should have been resuming.
 *
 * The cases below drive the runner's own reports through the real events and turn-complete paths:
 *
 *   (1) An ordinary session is armed on the first rung of the provider-error ladder, and records the
 *       engine's error, not the reply before it.
 *   (2) A task's run is armed the same way, in place, and its task is told nothing while it is.
 *   (3) A runner too old to report the error on its own is armed all the same — the events path reads
 *       the `error` event — and its task is still told nothing.
 *   (4) A task's run that died of something a re-send reproduces arms nothing, and its task is told —
 *       in the failure's own words.
 *
 *     bash scripts/run-pg-spec.sh src/apiserver/src/runner-api/codex-capacity-retry.pg.spec.ts
 *
 * Not destructive: every id is freshly generated and every assertion is scoped to the rows it made.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { PrismaClient, RunStatus, RunnerStatus, SessionDispatchOrigin } from '@prisma/client';
import { API_ERROR_RETRY_BACKOFF_MS, RunEventType, RunStatus as SharedRunStatus } from '@orbit/shared';
import { Client } from 'pg';

import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import type { QueueService } from '../queue/queue.service';
import type { RealtimeService } from '../realtime/realtime.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { RunnerApiController } from './runner-api.controller';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

/** Codex's own words, as the runner's `error` event carried them that day. */
const CAPACITY = 'Selected model is at capacity. Please try a different model.';
/** The last thing the agent said before it — what `session.error` recorded instead. */
const REPLY = '代码核验结果与预期一致。现在再点名跑 ledger spec 本身，补齐验收要求。';
const FAILURE_NOTE = '**Run failed (recorded by Orbit)**';

/** The production wiring, over one client and with no seam in the path under test. */
function connect(url: string): { db: PrismaClient; api: RunnerApiController } {
  const db = prismaClientFor(url);
  const realtime = new Proxy({}, { get: () => () => undefined }) as unknown as RealtimeService;
  const queue = { notifySessionQueued: () => undefined } as unknown as QueueService;
  return {
    db,
    api: new RunnerApiController(
      db as unknown as PrismaService,
      queue,
      realtime,
      {} as never,
      {} as never,
      { expand: async (_ownerId: string, content?: string) => content } as never,
      { appendFor: async (_tx: unknown, _sessionId: string, content?: string) => content } as never,
    ),
  };
}

interface Fixture {
  runnerId: string;
  sessionId: string;
  turnId: string;
  taskId: string | null;
}

/**
 * One owner, a runner, and a Codex session RUNNING with its turn out on delivery — a task's run when
 * `task` is set. `inbox_lease_owner` is left null so the lease checks pass with no token, as
 * turn-complete-unanswered.pg.spec.ts builds it.
 */
async function fixture(db: PrismaClient, label: string, { task = false } = {}): Promise<Fixture> {
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  const sessionId = randomUUID();
  await db.user.create({
    data: { id: ownerId, email: `${label}-${ownerId}@capacity.invalid`, name: 'The owner', passwordHash: 'x' },
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
    data: { id: workspaceId, ownerId, runnerId, name: `${label}-workspace`, enabled: true },
  });
  let taskId: string | null = null;
  if (task) {
    taskId = randomUUID();
    await db.task.create({
      data: {
        id: taskId,
        ownerId,
        assigneeId: workspaceId,
        title: `${label} 的任务`,
        creatorType: 'AGENT',
        creatorId: workspaceId,
        status: 'OPEN',
        completionCriterion: 'EVIDENCE_JUDGMENT',
      } as never,
    });
  }
  await db.session.create({
    data: {
      id: sessionId,
      ownerId,
      creatorId: ownerId,
      workspaceId,
      assignedRunnerId: runnerId,
      ...(taskId ? { taskId, startsTaskWork: true } : {}),
      title: `${label} session`,
      prompt: '再解集成线 MAIN_SYNC 冲突',
      provider: 'codex',
      model: 'gpt-5.6-sol',
      status: RunStatus.RUNNING,
      engineTurnActive: true,
      dispatchOrigin: SessionDispatchOrigin.USER,
      startedAt: new Date(),
      runtimeSessionId: randomUUID(),
    },
  });
  const turn = await db.conversationTurn.create({
    data: {
      sessionId,
      seq: 1,
      clientTurnId: `${label}-${randomUUID()}`,
      kind: 'message',
      content: '再解集成线 MAIN_SYNC 冲突',
      status: 'IN_FLIGHT',
      deliveredAt: new Date(),
      leaseDeadlineAt: new Date(Date.now() + 300_000),
      leaseGeneration: randomUUID(),
    },
    select: { id: true },
  });
  return { runnerId, sessionId, turnId: turn.id, taskId };
}

/**
 * What the runner streams for a Codex turn that said something and then died (codex_appserver.go):
 * the reply, the engine's `error` event, the turn's end — flushed before /turn-complete.
 */
async function streamFailedTurn(api: RunnerApiController, f: Fixture, error: string): Promise<void> {
  const ts = () => new Date().toISOString();
  await api.events({ id: f.runnerId }, f.sessionId, {
    events: [
      { seq: 1, type: RunEventType.USER, ts: ts(), turnId: f.turnId, payload: { text: '再解集成线 MAIN_SYNC 冲突' } },
      { seq: 2, type: RunEventType.ASSISTANT, ts: ts(), turnId: f.turnId, payload: { text: REPLY } },
      { seq: 3, type: RunEventType.ERROR, ts: ts(), turnId: f.turnId, payload: { message: error } },
      { seq: 4, type: RunEventType.TURN_END, ts: ts(), turnId: f.turnId, payload: { subtype: 'failed', numTurns: 1 } },
    ],
  });
}

/** The completion the runner reports for that turn. `error` is absent from runners older than it. */
const failed = (f: Fixture, error?: string) => ({
  turnId: f.turnId,
  status: SharedRunStatus.FAILED,
  subtype: 'failed',
  result: REPLY,
  ...(error ? { error } : {}),
  numTurns: 1,
  costUsd: 0,
});

test('a Codex run a busy model stopped goes on by itself, and says what stopped it', {
  skip, concurrency: 1, timeout: 300_000,
}, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const { db, api } = connect(url);
  t.after(async () => {
    await db.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });

  /** Read through Prisma: `retry_at` is a naive timestamp holding UTC, which `pg` reads as local. */
  const row = (sessionId: string) =>
    db.session.findUniqueOrThrow({
      where: { id: sessionId },
      select: { status: true, error: true, retryAt: true, retryAttempts: true },
    });
  const notes = async (taskId: string) =>
    (await db.taskComment.findMany({ where: { taskId }, select: { body: true } })).map((c) => c.body);
  /** On the first rung of the ladder, jitter included — armed between `from` and now. */
  const onFirstRung = (at: Date | null, from: number) => {
    const step = API_ERROR_RETRY_BACKOFF_MS[0];
    return !!at && at.getTime() >= from + step && at.getTime() <= Date.now() + step * 1.25;
  };

  await t.test('(1) a session is re-sent on the first rung, and records the engine’s error', async () => {
    const f = await fixture(db, 'session');
    const before = Date.now();
    await streamFailedTurn(api, f, CAPACITY);
    await api.turnComplete({ id: f.runnerId }, f.sessionId, failed(f, CAPACITY));

    const after = await row(f.sessionId);
    assert.equal(after.status, RunStatus.FAILED, 'this run of the session failed, as it did');
    assert.equal(after.error, CAPACITY, 'the reason is what stopped it, not what the agent said before');
    assert.ok(onFirstRung(after.retryAt, before), `not armed on the first rung: ${after.retryAt?.toISOString()}`);
    assert.equal(after.retryAttempts, 0, 'arming spends no attempt; the sweep does');
  });

  await t.test('(2) a task’s run is re-sent in place, and its task is told nothing while it is', async () => {
    const f = await fixture(db, 'task', { task: true });
    const before = Date.now();
    await streamFailedTurn(api, f, CAPACITY);
    await api.turnComplete({ id: f.runnerId }, f.sessionId, failed(f, CAPACITY));

    const after = await row(f.sessionId);
    assert.equal(after.error, CAPACITY);
    assert.ok(onFirstRung(after.retryAt, before), `a task's run was left to wait for a person: ${after.retryAt?.toISOString()}`);
    assert.deepEqual(await notes(f.taskId!), [], 'a failure note beside a run that is resuming says to re-run it');
    const task = await db.task.findUniqueOrThrow({ where: { id: f.taskId! }, select: { status: true } });
    assert.equal(task.status, 'OPEN');
  });

  await t.test('(3) a runner too old to report the error is armed from the `error` event all the same', async () => {
    const f = await fixture(db, 'old-runner', { task: true });
    const before = Date.now();
    await streamFailedTurn(api, f, CAPACITY);
    await api.turnComplete({ id: f.runnerId }, f.sessionId, failed(f));

    const after = await row(f.sessionId);
    assert.ok(onFirstRung(after.retryAt, before), `not armed: ${after.retryAt?.toISOString()}`);
    assert.deepEqual(await notes(f.taskId!), []);
  });

  await t.test('(4) a failure a re-send reproduces arms nothing, and the task hears it in its own words', async () => {
    const f = await fixture(db, 'other-failure', { task: true });
    const failure = 'stream disconnected before completion: error sending request';
    await streamFailedTurn(api, f, failure);
    await api.turnComplete({ id: f.runnerId }, f.sessionId, failed(f, failure));

    const after = await row(f.sessionId);
    assert.equal(after.retryAt, null);
    assert.equal(after.error, failure);
    const [note, ...more] = await notes(f.taskId!);
    assert.deepEqual(more, []);
    assert.ok(note?.startsWith(FAILURE_NOTE), `no failure note: ${note}`);
    assert.ok(note.includes(failure) && !note.includes(REPLY), `the note names the wrong reason: ${note}`);
  });
});
