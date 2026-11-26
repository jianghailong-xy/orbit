/**
 * ONE SERVER SERVES BOTH RUNNER PROTOCOLS: A TURN OUTCOME AND A RELEASE ARE TWO REPORTS UNDER THE NEW ONE.
 *
 * docs/session-three-state-plan.md step 6.1, design §3 and §12 (decision D9): a runner that declares
 * SESSION_RELEASE_V1 on a request reports a failed turn as the turn's outcome, which releases nothing, and the
 * release as a report of its own (POST /runner/sessions/:id/release). A runner that does not is served exactly as
 * before. Each case drives the real controller (and the real reaper and auto-retry sweeps) against PostgreSQL and
 * reads the rows back over a second connection:
 *
 *   (1) the same failed turn under both protocols ends in the same facts: the turn's outcome and error, the session's
 *       status, `finished_at`, `end_reason`, `last_turn_outcome` and error, the task FAILED with one comment, and both
 *       release questions; under the new one the turn report alone leaves the session held (RUNNING, the teardown
 *       cancel set, no `finished_at`) with the failure on the turn and the queue drained
 *   (2) the hold reads as an old-protocol session in its cancel window does: a message and a background wake get the
 *       same answer, and the auto-retry sweep does not revive it before `finished_at` is set
 *   (3) an ended session: an end asked during the hold files it and records no reason, and its release reads as the
 *       failure (as the old protocol's would); a release after an end asked before any failure settles as asked, and
 *       `cutOffTurnOutcome` is ignored there
 *   (4) a resume: a failure release revived keeps `last_turn_outcome` FAILED while held, a new-protocol answered turn
 *       replaces it, and a release before any turn completed is a stop (the cut-off turn CANCELLED)
 *   (5) `cutOffTurnOutcome: 'FAILED'` with no end asked: the turn in flight FAILED with the error, the release FAILED
 *       (the old finalize's W6); the release is refused without the token and for any other cut-off outcome
 *   (6) the backstop: a failed turn whose release never comes is released by the reaper's cancel grace with
 *       `end_reason` null, `last_turn_outcome` FAILED and the failure's own error, reads as a failure, and the retry armed
 *       for it fires
 *   (7) the token is read per request: declared on the failed turn and not on the end (the old finalize), or the
 *       reverse (the old failed turn, then a release), the session ends released and reads as the failure
 *   (8) the token in the body's `releaseProtocol` (how a runner on the link declares it, step 6.2) is the same
 *       declaration; any other word there is none
 *
 *     bash scripts/run-pg-spec.sh src/apiserver/src/runner-api/session-release-protocol.pg.spec.ts
 *
 * Not destructive: every id is freshly generated and every assertion is scoped to the rows it made.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import {
  CreatorType,
  PrismaClient,
  RunnerStatus,
  SessionDispatchOrigin,
  SessionRunSource,
  TaskStatus,
} from '@prisma/client';
import { RunStatus } from '@orbit/shared';
import { RunEventType, RunStatus as SharedRunStatus, SESSION_RELEASE_V1, SessionEndReason } from '@orbit/shared';
import { Client } from 'pg';

import { RELEASE_FACTS_SELECT, releaseFinishedTheWork, releaseWasFailure } from '../common/session-release';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import { QueueService } from '../queue/queue.service';
import type { RealtimeService } from '../realtime/realtime.service';
import { ReaperService } from '../realtime/reaper.service';
import { AutoRetryService } from '../sessions/auto-retry.service';
import { SessionsService } from '../sessions/sessions.service';
import type { BackgroundWakeDto } from './background-job-wake';
import { RunnerApiController } from './runner-api.controller';
import { turnStateOfWord } from '../sessions/session-turn-state';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

/** The new protocol's declaration, as a runner sends it beside its other capabilities. */
const NEW = `codex-account-remove/v1,${SESSION_RELEASE_V1}`;

interface Stack {
  db: PrismaClient;
  sql: Client;
  api: RunnerApiController;
  reaper: ReaperService;
  sessions: SessionsService;
  autoRetry: AutoRetryService;
}

function stackFor(url: string, sql: Client): Stack {
  const db = prismaClientFor(url);
  const prisma = db as unknown as PrismaService;
  const realtime = new Proxy({}, { get: () => () => undefined }) as unknown as RealtimeService;
  const queue = new QueueService(prisma, realtime);
  const sessions = new SessionsService(prisma, queue, realtime);
  return {
    db,
    sql,
    sessions,
    reaper: new ReaperService(prisma, realtime),
    autoRetry: new AutoRetryService(prisma, sessions, realtime),
    api: new RunnerApiController(
      prisma,
      queue,
      realtime,
      new Proxy({}, { get: () => async () => undefined }) as never,
      { assert: async (_runner: unknown, callingSessionId?: string) => callingSessionId ?? randomUUID() } as never,
      { expand: async (_ownerId: string, content?: string) => content } as never,
      { appendFor: async (_tx: unknown, _sessionId: string, content?: string) => content } as never,
      undefined,
      undefined,
      undefined,
      undefined,
      sessions,
    ),
  };
}

interface World { ownerId: string; runnerId: string; workspaceId: string }

async function world(db: PrismaClient, label: string): Promise<World> {
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  await db.user.create({
    data: { id: ownerId, email: `${label}-${ownerId}@release-protocol.invalid`, name: label, passwordHash: 'x' },
  });
  await db.runner.create({
    data: {
      id: runnerId, ownerId, name: `${label}-runner`, tokenHash: `hash-${runnerId}`, status: RunnerStatus.ONLINE,
      capabilities: [], capabilitiesReportedAt: new Date(), lastHeartbeatAt: new Date(),
    },
  });
  await db.workspace.create({
    data: { id: workspaceId, ownerId, runnerId, name: `${label}-workspace`, enabled: true, workDir: `/srv/${label}` },
  });
  return { ownerId, runnerId, workspaceId };
}

async function task(db: PrismaClient, w: World): Promise<string> {
  const id = randomUUID();
  await db.task.create({
    data: {
      id, ownerId: w.ownerId, assigneeId: w.workspaceId, title: 'the work', creatorType: CreatorType.USER,
      creatorId: w.ownerId, status: TaskStatus.IN_PROGRESS, completionCriterion: 'EVIDENCE_JUDGMENT',
    },
  });
  return id;
}

async function session(db: PrismaClient, w: World, data: Record<string, unknown> = {}): Promise<string> {
  const id = randomUUID();
  const status = (data.status as RunStatus | undefined) ?? RunStatus.RUNNING;
  await db.session.create({
    data: {
      id, ownerId: w.ownerId, creatorId: w.ownerId, workspaceId: w.workspaceId, assignedRunnerId: w.runnerId,
      title: 'a conversation', prompt: 'Explain the error in the log', turnState: turnStateOfWord(status),
      engineTurnActive: status === RunStatus.RUNNING, provider: 'claude', providerBuiltin: true, engine: 'claude',
      dispatchOrigin: SessionDispatchOrigin.USER, runSource: SessionRunSource.MANUAL, startedAt: new Date(),
      runClaimedAt: new Date(), runtimeSessionId: randomUUID(), numTurns: 1, ...data,
    },
  });
  return id;
}

type TurnStatus = 'PENDING' | 'IN_FLIGHT' | 'ANSWERED';

async function turn(db: PrismaClient, sessionId: string, seq: number, status: TurnStatus): Promise<string> {
  const created = await db.conversationTurn.create({
    data: {
      sessionId, seq, clientTurnId: `turn-${seq}-${randomUUID()}`, kind: 'message', content: `message ${seq}`, status,
      ...(status === 'PENDING' ? {} : { deliveredAt: new Date() }),
      ...(status === 'IN_FLIGHT' ? { leaseDeadlineAt: new Date(Date.now() + 300_000), leaseGeneration: randomUUID() } : {}),
      ...(status === 'ANSWERED' ? { answeredAt: new Date(), outcome: 'ANSWERED' } : {}),
    },
    select: { id: true },
  });
  return created.id;
}

interface Facts {
  status: string;
  released: boolean;
  end_reason: string | null;
  last_turn_outcome: string | null;
  error: string | null;
  cancel_requested: boolean;
  turn_status: string;
  turn_outcome: string | null;
  turn_error: string | null;
}

/** The session's release facts and the named turn's, read over the second connection. */
async function facts(sql: Client, sessionId: string, turnId: string): Promise<Facts> {
  const { rows } = await sql.query(
    `SELECT s.status::text AS status, s.finished_at IS NOT NULL AS released, s.end_reason, s.last_turn_outcome,
            s.error, s.cancel_requested_at IS NOT NULL AS cancel_requested,
            t.status AS turn_status, t.outcome AS turn_outcome, t.error AS turn_error
       FROM "session" s JOIN "conversation_turn" t ON t.session_id = s.id
      WHERE s.id = $1::uuid AND t.id = $2::uuid`,
    [sessionId, turnId],
  );
  assert.equal(rows.length, 1);
  return rows[0] as Facts;
}

async function questions(db: PrismaClient, sessionId: string): Promise<{ failed: boolean; finished: boolean }> {
  const row = await db.session.findUniqueOrThrow({ where: { id: sessionId }, select: RELEASE_FACTS_SELECT });
  return { failed: releaseWasFailure(row), finished: releaseFinishedTheWork(row) };
}

async function commentsOn(sql: Client, taskId: string): Promise<number> {
  const { rows } = await sql.query(`SELECT count(*)::int AS n FROM "task_comment" WHERE task_id = $1::uuid`, [taskId]);
  return (rows[0] as { n: number }).n;
}

async function taskStatus(sql: Client, taskId: string): Promise<string> {
  const { rows } = await sql.query(`SELECT status::text AS status FROM "task" WHERE id = $1::uuid`, [taskId]);
  return (rows[0] as { status: string }).status;
}

async function unansweredTurns(sql: Client, sessionId: string): Promise<number> {
  const { rows } = await sql.query(
    `SELECT count(*)::int AS n FROM "conversation_turn" WHERE session_id = $1::uuid AND status <> 'ANSWERED'`,
    [sessionId],
  );
  return (rows[0] as { n: number }).n;
}

const FAILED_TURN = { status: SharedRunStatus.FAILED, error: 'API Error: 400 the request was refused', numTurns: 1, costUsd: 0 };

/** One background job's wake, as runner-go reports it. */
function wakeOf(jobId: string): BackgroundWakeDto {
  return {
    wakeId: `${jobId}:exit`, jobId, trigger: 'exit', kind: 'build', command: 'npm run build', status: 'failed',
    exitCode: 2, outputPath: `/root/.orbit/runs/${jobId}.output`, outputOffset: 0, outputSize: 10, outputExcerpt: 'boom',
  } as BackgroundWakeDto;
}

/** What a refusal was, or that there was none. */
async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'accepted';
  } catch (error) {
    // The session's own id is not part of the answer.
    return `${(error as Error).constructor.name}: ${(error as Error).message}`
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<id>');
  }
}

test('one server serves the old and the new runner protocol (plan step 6.1)', {
  skip, concurrency: 1, timeout: 600_000,
}, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const s = stackFor(url, sql);
  const sweep = () => (s.reaper as unknown as { sweep(): Promise<void> }).sweep();
  t.after(async () => {
    await s.db.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });

  /** A task's run with a turn out on delivery and one queued behind it. */
  async function taskRun(label: string) {
    const w = await world(s.db, label);
    const taskId = await task(s.db, w);
    const id = await session(s.db, w, { taskId, startsTaskWork: true });
    const failing = await turn(s.db, id, 1, 'IN_FLIGHT');
    const queued = await turn(s.db, id, 2, 'PENDING');
    return { w, taskId, id, failing, queued };
  }

  await t.test('(1) a failed turn: the same facts under both protocols; the new one holds until its release', async () => {
    const old = await taskRun('old-failed');
    await s.api.turnComplete({ id: old.w.runnerId }, old.id, { turnId: old.failing, ...FAILED_TURN } as never);
    // The old runner's finalize after it, which finds the session released.
    await s.api.finalize({ id: old.w.runnerId }, old.id, { status: SharedRunStatus.FAILED } as never);
    const oldFacts = await facts(sql, old.id, old.failing);

    const neu = await taskRun('new-failed');
    const answer = await s.api.turnComplete({ id: neu.w.runnerId }, neu.id, { turnId: neu.failing, ...FAILED_TURN } as never, NEW);
    assert.equal(answer.status, RunStatus.RUNNING, 'the turn report answers a held status: no release yet');
    const held = await facts(sql, neu.id, neu.failing);
    assert.deepEqual(held, {
      status: 'RUNNING', released: false, end_reason: null, last_turn_outcome: 'FAILED', error: FAILED_TURN.error,
      cancel_requested: true, turn_status: 'ANSWERED', turn_outcome: 'FAILED', turn_error: FAILED_TURN.error,
    }, 'held: the failure on the turn and copied, the teardown asked, nothing released');
    assert.equal(await unansweredTurns(sql, neu.id), 0, 'the queue behind the failed turn is drained, as before');
    assert.equal((await s.db.conversationTurn.findUniqueOrThrow({ where: { id: neu.queued } })).outcome, null,
      'a queued turn that never ran records no outcome');
    assert.deepEqual(await questions(s.db, neu.id), { failed: false, finished: false }, 'held: no release question says yes');
    // A task with a session still held is not reclaimed (reclaimStalledTask): it is told at the release, as the old
    // protocol tells it in the write that releases its session.
    assert.equal(await taskStatus(sql, neu.taskId), 'IN_PROGRESS', 'the task waits for the release');
    assert.equal(await commentsOn(sql, neu.taskId), 0);

    const released = await s.api.release({ id: neu.w.runnerId }, neu.id, { mergeTargets: ['main', 'release'] } as never, NEW);
    assert.equal(released.ok, true);
    const newFacts = await facts(sql, neu.id, neu.failing);
    assert.deepEqual({ ...newFacts }, { ...oldFacts }, 'the new protocol ends in the old protocol\'s facts');
    assert.deepEqual(newFacts, {
      status: 'FAILED', released: true, end_reason: null, last_turn_outcome: 'FAILED', error: FAILED_TURN.error,
      cancel_requested: true, turn_status: 'ANSWERED', turn_outcome: 'FAILED', turn_error: FAILED_TURN.error,
    });
    assert.deepEqual(await questions(s.db, neu.id), await questions(s.db, old.id), 'both release questions, alike');
    assert.deepEqual(await questions(s.db, neu.id), { failed: true, finished: false });
    assert.equal(await taskStatus(sql, neu.taskId), await taskStatus(sql, old.taskId));
    assert.equal(await taskStatus(sql, neu.taskId), 'FAILED', 'the release tells the task');
    assert.equal(await commentsOn(sql, neu.taskId), 1, 'with one comment, as the old protocol');
    assert.equal(await commentsOn(sql, old.taskId), 1);
    const checkout = await s.db.session.findUniqueOrThrow({ where: { id: neu.id }, select: { mergeTargets: true } });
    assert.deepEqual(checkout.mergeTargets, ['main', 'release'], 'and the release writes what the runner reports of its checkout');
    // A second release, or a late duplicate of the turn report, changes nothing.
    await s.api.release({ id: neu.w.runnerId }, neu.id, {} as never, NEW);
    await s.api.turnComplete({ id: neu.w.runnerId }, neu.id, { turnId: neu.failing, ...FAILED_TURN } as never, NEW);
    assert.deepEqual(await facts(sql, neu.id, neu.failing), newFacts);
    assert.equal(await commentsOn(sql, neu.taskId), 1);
  });

  await t.test('(2) the hold answers a message, a wake and the retry sweep as a session in its cancel window', async () => {
    const w = await world(s.db, 'hold-reads');
    const retryAt = new Date(Date.now() - 1_000);
    // Old protocol: an end asked for, not yet honoured, a retry armed (as the event batch of a quota arms it).
    const ending = await session(s.db, w, { cancelRequestedAt: new Date(), endReason: SessionEndReason.ENDED, retryAt });
    await turn(s.db, ending, 1, 'IN_FLIGHT');
    // New protocol: a failed turn reported, its release not yet, the same retry armed.
    const holding = await session(s.db, w, { retryAt });
    const failing = await turn(s.db, holding, 1, 'IN_FLIGHT');
    await s.api.turnComplete({ id: w.runnerId }, holding, { turnId: failing, ...FAILED_TURN } as never, NEW);
    assert.equal((await facts(sql, holding, failing)).status, 'RUNNING');

    const message = (id: string) => refusal(s.sessions.createTurn(w.ownerId, id, { content: 'hello?', clientTurnId: randomUUID() } as never));
    assert.equal(await message(holding), await message(ending), 'a message: the same answer');
    assert.notEqual(await message(holding), 'accepted');
    const wake = async (id: string) => JSON.stringify(await s.api.backgroundWake({ id: w.runnerId, ownerId: w.ownerId }, id, wakeOf(`job-${randomUUID()}`)));
    assert.equal(await wake(holding), await wake(ending), 'a background wake: the same answer');
    assert.equal(await wake(holding), JSON.stringify({ outcome: 'DROPPED' }));

    await s.autoRetry.sweep(new Date());
    const after = await s.db.session.findUniqueOrThrow({ where: { id: holding }, select: { status: true, finishedAt: true, retryAt: true } });
    assert.equal(after.status, RunStatus.RUNNING, 'the retry sweep does not revive a held session');
    assert.equal(after.finishedAt, null);
    assert.ok(after.retryAt, 'and its armed retry waits for the release');
  });

  await t.test('(3) an ended session: an end during the hold, and an end before any failure', async () => {
    const r = await taskRun('end-in-hold');
    await s.api.turnComplete({ id: r.w.runnerId }, r.id, { turnId: r.failing, ...FAILED_TURN } as never, NEW);
    // The person ends it while the runner tears down: the end in flight is the teardown's, as in the old cancel window.
    await s.sessions.complete(r.w.ownerId, r.id);
    const filed = await s.db.session.findUniqueOrThrow({ where: { id: r.id }, select: { completedAt: true, endReason: true, status: true } });
    assert.ok(filed.completedAt, 'Complete files it');
    assert.equal(filed.endReason, null, 'and records no end reason: the end in flight is the teardown\'s');
    assert.equal(filed.status, RunStatus.RUNNING, 'still held until the release');
    await s.api.release({ id: r.w.runnerId }, r.id, {} as never, NEW);
    const f = await facts(sql, r.id, r.failing);
    assert.equal(f.status, 'FAILED');
    assert.equal(f.released, true);
    assert.equal(f.end_reason, null, 'the end asked during the hold records no reason');
    assert.equal(f.last_turn_outcome, 'FAILED');
    assert.deepEqual(await questions(s.db, r.id), { failed: true, finished: false }, 'it reads as the failure it was');

    // An end asked before any failure; the runner's release claims a failed cut-off turn: ignored.
    const w = await world(s.db, 'end-first');
    const id = await session(s.db, w, { cancelRequestedAt: new Date(), endReason: SessionEndReason.ENDED });
    const last = await turn(s.db, id, 1, 'ANSWERED');
    await s.api.release({ id: w.runnerId }, id, { cutOffTurnOutcome: 'FAILED', error: 'killed' } as never, NEW);
    const ended = await facts(sql, id, last);
    assert.equal(ended.status, 'CANCELLED', 'an end asked settles as asked');
    assert.equal(ended.released, true);
    assert.equal(ended.end_reason, 'ended');
    assert.equal(ended.last_turn_outcome, null, 'cutOffTurnOutcome is ignored when an end was asked: nothing FAILED');
    assert.equal(ended.turn_outcome, 'ANSWERED');
    assert.deepEqual(await questions(s.db, id), { failed: false, finished: false });
    // The old protocol's finalize for the same event answers the same.
    const oldId = await session(s.db, w, { cancelRequestedAt: new Date(), endReason: SessionEndReason.ENDED });
    const oldLast = await turn(s.db, oldId, 1, 'ANSWERED');
    await s.api.finalize({ id: w.runnerId }, oldId, { status: SharedRunStatus.FAILED, error: 'killed' } as never);
    const oldEnded = await facts(sql, oldId, oldLast);
    assert.deepEqual({ ...oldEnded, error: null }, { ...ended, error: null });
    assert.deepEqual(await questions(s.db, oldId), await questions(s.db, id));
  });

  await t.test('(4) a resume: the revived session, an answered turn, and a release before any turn completed', async () => {
    const w = await world(s.db, 'resume');
    const id = await session(s.db, w);
    const failing = await turn(s.db, id, 1, 'IN_FLIGHT');
    await s.api.turnComplete({ id: w.runnerId }, id, { turnId: failing, ...FAILED_TURN } as never, NEW);
    await s.api.release({ id: w.runnerId }, id, {} as never, NEW);
    assert.deepEqual(await questions(s.db, id), { failed: true, finished: false });

    await s.sessions.resume(w.ownerId, id, { content: 'try again', clientTurnId: randomUUID() } as never);
    const revived = await s.db.session.findUniqueOrThrow({
      where: { id }, select: { status: true, finishedAt: true, cancelRequestedAt: true, lastTurnOutcome: true, endReason: true },
    });
    assert.equal(revived.status, RunStatus.PENDING);
    assert.equal(revived.finishedAt, null);
    assert.equal(revived.cancelRequestedAt, null, 'the revive clears the teardown cancel');
    assert.equal(revived.lastTurnOutcome, 'FAILED', 'and keeps the last outcome until a turn completes');
    assert.deepEqual(await questions(s.db, id), { failed: false, finished: false }, 'held again: no failure');

    // As the claim leaves it (RUNNING, its turn out on delivery, the kept FAILED copy), the turn answered under the new
    // protocol.
    const claimedId = await session(s.db, w, { lastTurnOutcome: 'FAILED' });
    const retry = { id: await turn(s.db, claimedId, 1, 'IN_FLIGHT') };
    // The turn's events, flushed before its completion as the runner flushes them: a reply, so the turn answered.
    await s.api.events({ id: w.runnerId }, claimedId, {
      events: [
        { seq: 1, type: RunEventType.USER, ts: new Date().toISOString(), turnId: retry.id, payload: { text: 'try again' } },
        { seq: 2, type: RunEventType.ASSISTANT, ts: new Date().toISOString(), turnId: retry.id, payload: { text: 'Fixed it.' } },
      ],
    } as never);
    const answer = await s.api.turnComplete({ id: w.runnerId }, claimedId, {
      turnId: retry.id, status: SharedRunStatus.SUCCEEDED, result: 'Fixed it.', numTurns: 1, costUsd: 0,
    } as never, NEW);
    assert.equal(answer.status, RunStatus.AWAITING_INPUT, 'an answered turn parks as under the old protocol');
    const answered = await facts(sql, claimedId, retry.id);
    assert.equal(answered.last_turn_outcome, 'ANSWERED');
    assert.equal(answered.turn_outcome, 'ANSWERED');
    assert.equal(answered.released, false);

    // Revived again after a failure, and released before its turn completed: a stop, the cut-off turn CANCELLED.
    const w2 = await world(s.db, 'resume-stop');
    const id2 = await session(s.db, w2, { lastTurnOutcome: 'FAILED' });
    await turn(s.db, id2, 1, 'ANSWERED');
    const cut = await turn(s.db, id2, 2, 'IN_FLIGHT');
    await s.api.release({ id: w2.runnerId }, id2, {} as never, NEW);
    const stopped = await facts(sql, id2, cut);
    assert.equal(stopped.status, 'CANCELLED');
    assert.equal(stopped.released, true);
    assert.equal(stopped.end_reason, null);
    assert.equal(stopped.turn_outcome, 'CANCELLED', 'the cut-off turn ends CANCELLED (option A)');
    assert.equal(stopped.last_turn_outcome, 'CANCELLED', 'so the kept FAILED is not read as this run\'s');
    assert.deepEqual(await questions(s.db, id2), { failed: false, finished: false });
  });

  await t.test('(5) cutOffTurnOutcome FAILED with no end asked, and the refusals', async () => {
    const w = await world(s.db, 'cut-off');
    const taskId = await task(s.db, w);
    const id = await session(s.db, w, { taskId, startsTaskWork: true });
    const inFlight = await turn(s.db, id, 1, 'IN_FLIGHT');
    await s.api.release({ id: w.runnerId }, id, { cutOffTurnOutcome: 'FAILED', error: 'engine crashed' } as never, NEW);
    const f = await facts(sql, id, inFlight);
    assert.deepEqual(
      { status: f.status, released: f.released, end_reason: f.end_reason, last: f.last_turn_outcome, turn: f.turn_outcome, turnError: f.turn_error },
      { status: 'FAILED', released: true, end_reason: null, last: 'FAILED', turn: 'FAILED', turnError: 'engine crashed' },
    );
    assert.deepEqual(await questions(s.db, id), { failed: true, finished: false });
    assert.equal(await taskStatus(sql, taskId), 'FAILED', 'the task is told, as by the old finalize\'s FAILED');
    assert.equal(await commentsOn(sql, taskId), 1);
    // The old finalize for the same event.
    const oldTask = await task(s.db, w);
    const oldId = await session(s.db, w, { taskId: oldTask, startsTaskWork: true });
    const oldInFlight = await turn(s.db, oldId, 1, 'IN_FLIGHT');
    await s.api.finalize({ id: w.runnerId }, oldId, { status: SharedRunStatus.FAILED, error: 'engine crashed' } as never);
    assert.deepEqual(await facts(sql, oldId, oldInFlight), f);
    assert.equal(await taskStatus(sql, oldTask), 'FAILED');

    const other = await session(s.db, w);
    await turn(s.db, other, 1, 'IN_FLIGHT');
    assert.match(await refusal(s.api.release({ id: w.runnerId }, other, {} as never)), /BadRequestException: .*session-release\/v1/,
      'a release from a request that does not declare the protocol is refused');
    assert.match(await refusal(s.api.release({ id: w.runnerId }, other, {} as never, 'codex-account-remove/v1')), /BadRequestException/);
    assert.match(await refusal(s.api.release({ id: w.runnerId }, other, { cutOffTurnOutcome: 'CANCELLED' } as never, NEW)),
      /BadRequestException: cutOffTurnOutcome may only be 'FAILED'/);
    const untouched = await s.db.session.findUniqueOrThrow({ where: { id: other }, select: { status: true, finishedAt: true } });
    assert.equal(untouched.status, RunStatus.RUNNING, 'a refused release changes nothing');
    assert.equal(untouched.finishedAt, null);
  });

  await t.test('(6) the backstop: no release after a failed turn; the cancel grace releases it as a failure, and the retry fires', async () => {
    const w = await world(s.db, 'backstop');
    const id = await session(s.db, w, { retryAt: new Date(Date.now() + 60_000) });
    const failing = await turn(s.db, id, 1, 'IN_FLIGHT');
    await s.api.turnComplete({ id: w.runnerId }, id, { turnId: failing, ...FAILED_TURN } as never, NEW);
    // The release never comes. Past the cancel grace (two minutes), the reaper's sweep.
    await sql.query(`UPDATE "session" SET cancel_requested_at = now() - interval '10 minutes' WHERE id = $1::uuid`, [id]);
    await sweep();
    const f = await facts(sql, id, failing);
    assert.equal(f.status, 'FAILED');
    assert.equal(f.released, true, 'released by the backstop');
    assert.equal(f.end_reason, null);
    assert.equal(f.last_turn_outcome, 'FAILED', 'the copy of the failed turn is kept, not overwritten with CANCELLED');
    assert.equal(f.error, FAILED_TURN.error,
      'and the session keeps the failure\'s own words, as the release would have, not the sweep\'s "cancel not honored"');
    assert.equal(f.turn_outcome, 'FAILED');
    assert.deepEqual(await questions(s.db, id), { failed: true, finished: false }, 'it reads as the failure it is');

    const armed = await s.db.session.findUniqueOrThrow({ where: { id }, select: { retryAt: true, retryAttempts: true } });
    assert.ok(armed.retryAt, 'the retry armed for the failure still stands');
    const at = new Date(armed.retryAt!.getTime() + 1_000);
    await s.db.runner.update({ where: { id: w.runnerId }, data: { lastHeartbeatAt: at } });
    await s.autoRetry.sweep(at);
    const after = await s.db.session.findUniqueOrThrow({ where: { id }, select: { status: true, retryAt: true, retryAttempts: true, finishedAt: true } });
    assert.equal(after.status, RunStatus.PENDING, 'the armed retry fires: the session is revived');
    assert.equal(after.finishedAt, null);
    assert.equal(after.retryAt, null);
    assert.equal(after.retryAttempts, armed.retryAttempts + 1);

    // A task's run with no retry armed: the backstop tells the task what the release would have.
    const r = await taskRun('backstop-task');
    await s.api.turnComplete({ id: r.w.runnerId }, r.id, { turnId: r.failing, ...FAILED_TURN } as never, NEW);
    await sql.query(`UPDATE "session" SET cancel_requested_at = now() - interval '10 minutes' WHERE id = $1::uuid`, [r.id]);
    await sweep();
    const rf = await facts(sql, r.id, r.failing);
    assert.equal(rf.released, true);
    assert.equal(rf.last_turn_outcome, 'FAILED');
    assert.deepEqual(await questions(s.db, r.id), { failed: true, finished: false });
    assert.equal(await taskStatus(sql, r.taskId), 'FAILED', 'the task FAILED, as the old protocol\'s failed turn');
    assert.equal(await commentsOn(sql, r.taskId), 1);
  });

  await t.test('(7) the token per request: declared on the failed turn and not on the end, or the reverse', async () => {
    // Declared on the failed turn; the end comes as the old protocol's finalize.
    const a = await taskRun('mixed-new-old');
    await s.api.turnComplete({ id: a.w.runnerId }, a.id, { turnId: a.failing, ...FAILED_TURN } as never, NEW);
    await s.api.finalize({ id: a.w.runnerId }, a.id, { status: SharedRunStatus.CANCELLED } as never);
    const fa = await facts(sql, a.id, a.failing);
    assert.equal(fa.status, 'FAILED', 'the old finalize releases the hold as the failure it is');
    assert.equal(fa.released, true);
    assert.equal(fa.end_reason, null);
    assert.equal(fa.last_turn_outcome, 'FAILED');
    assert.deepEqual(await questions(s.db, a.id), { failed: true, finished: false });
    assert.equal(await commentsOn(sql, a.taskId), 1, 'and reclaims nothing twice');

    // Not declared on the failed turn (the old release in the same write); then a release that declares it.
    const b = await taskRun('mixed-old-new');
    await s.api.turnComplete({ id: b.w.runnerId }, b.id, { turnId: b.failing, ...FAILED_TURN } as never);
    const before = await facts(sql, b.id, b.failing);
    assert.equal(before.status, 'FAILED');
    assert.equal(before.released, true);
    await s.api.release({ id: b.w.runnerId }, b.id, {} as never, NEW);
    assert.deepEqual(await facts(sql, b.id, b.failing), before, 'a release of a released session changes nothing');
    assert.equal(await commentsOn(sql, b.taskId), 1);
    // And declared on the failed turn with nothing after it is (6): the cancel grace releases it.
  });

  await t.test('(8) the declaration in the body, as a runner on the link sends it, is the same declaration', async () => {
    // The link forwards only what its Hello declared and carries no header of its own (plan step 6.2): the body's
    // releaseProtocol says it instead.
    const old = await taskRun('body-old');
    await s.api.turnComplete({ id: old.w.runnerId }, old.id, { turnId: old.failing, ...FAILED_TURN } as never);
    await s.api.finalize({ id: old.w.runnerId }, old.id, { status: SharedRunStatus.FAILED } as never);
    const r = await taskRun('body-declared');
    const answer = await s.api.turnComplete({ id: r.w.runnerId }, r.id,
      { turnId: r.failing, ...FAILED_TURN, releaseProtocol: SESSION_RELEASE_V1 } as never);
    assert.equal(answer.status, RunStatus.RUNNING, 'held, as under the header');
    assert.equal((await facts(sql, r.id, r.failing)).released, false);
    await s.api.release({ id: r.w.runnerId }, r.id, { releaseProtocol: SESSION_RELEASE_V1 } as never);
    assert.deepEqual(await facts(sql, r.id, r.failing), await facts(sql, old.id, old.failing),
      'and its release ends in the old protocol\'s facts');
    // Any other word in the field declares nothing: the old protocol.
    const other = await taskRun('body-other');
    const oldAnswer = await s.api.turnComplete({ id: other.w.runnerId }, other.id,
      { turnId: other.failing, ...FAILED_TURN, releaseProtocol: 'session-release/v2' } as never);
    assert.equal(oldAnswer.status, RunStatus.FAILED);
    assert.match(await refusal(s.api.release({ id: other.w.runnerId }, other.id, { releaseProtocol: 'yes' } as never)),
      /session-release\/v1/);
  });
});
