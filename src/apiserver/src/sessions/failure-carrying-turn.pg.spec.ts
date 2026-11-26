/**
 * EVERY WRITER THAT RELEASES A SESSION AFTER A FAILURE RECORDS IT ON THE TURN THAT CARRIES IT.
 *
 * docs/session-three-state-design.md §12.1 and §12.6 row R2 (decision D9, 2026-11-21): a failure is a fact of the
 * turn. The carrying turn is the IN_FLIGHT work turn, else the oldest PENDING work turn, else (the runner's finalize
 * with nothing queued, and the reaper's API-error backstop only) the latest work turn. It gets `outcome = 'FAILED'`
 * and the error, and `session.last_turn_outcome = 'FAILED'` rides on the release's own write. Each case drives the
 * real writer against PostgreSQL and reads both rows back over a second connection:
 *
 *   W1a turn-complete, an EXECUTABLE exit code the declaration did not ask for → the acceptance turn FAILED, the comparison
 *   W1b turn-complete, an acceptance result that cannot be compared            → the acceptance turn FAILED, the session error
 *   W1c turn-complete, a failed turn of a kind that is not a turn of work      → that turn FAILED
 *   W2  the reaper, runner offline: in flight, and lost between claim and inbox → that turn FAILED, `runner offline`
 *   W3  the reaper, runtime never initialized                                   → the PENDING turn FAILED
 *   W4  the runner refuses the source                                           → the PENDING turn FAILED, and no turn left PENDING
 *   W5  a failed transcript import                                              → no outcome on any turn, none on the session
 *   W6  the runner's finalize, FAILED with no end asked: mid-turn, and idle     → the in-flight turn, else the latest, FAILED
 *   W7  the reaper, an end asked for and not honoured                           → the turn in flight CANCELLED, nothing FAILED
 *   W8  the reaper's API-error backstop, through its sweep                      → the latest turn, ANSWERED before, FAILED
 *   A   the runner's finalize with no end asked and no failure (SUCCEEDED or CANCELLED; the coordinator's option A of
 *       R3/R4): a failure release revived, then finalized before a turn completed → the queued turn CANCELLED, and
 *       the session's copy with it, so the release reads as no failure; with nothing to cut off, nothing is written
 *   (tx) each writer's turn outcome commits with its release or not at all: a statement after both in the same
 *        transaction is made to fail, and neither the release nor the outcome is found (option A's too)
 *
 * Queued turns other than the carrying one are drained as before, with no outcome: they never ran.
 *
 *     bash scripts/run-pg-spec.sh src/apiserver/src/sessions/failure-carrying-turn.pg.spec.ts
 *
 * Not destructive: every id is freshly generated and the assertions read only the rows they made. The (tx) cases
 * install a trigger that refuses writes for the sessions named in a table of their own, and drop both.
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
import { RunEventType, RunStatus as SharedRunStatus, SessionEndReason } from '@orbit/shared';
import { Client } from 'pg';

import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import { freezeSessionSourcePin } from '../projects/session-source';
import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import { QueueService } from '../queue/queue.service';
import type { RealtimeService } from '../realtime/realtime.service';
import { ReaperService } from '../realtime/reaper.service';
import { RunnerApiController } from '../runner-api/runner-api.controller';
import { releaseWasFailure } from '../common/session-release';
import { TASK_ACCEPTANCE_CLIENT_TURN_PREFIX } from '../tasks/executable-acceptance-round';
import { SessionsService } from './sessions.service';
import { turnStateOfWord } from './session-turn-state';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

interface Stack {
  db: PrismaClient;
  sql: Client;
  api: RunnerApiController;
  reaper: ReaperService;
  sessions: SessionsService;
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

interface World {
  ownerId: string;
  runnerId: string;
  workspaceId: string;
}

async function world(db: PrismaClient, label: string): Promise<World> {
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  await db.user.create({
    data: { id: ownerId, email: `${label}-${ownerId}@carrying-turn.invalid`, name: label, passwordHash: 'x' },
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
    data: { id: workspaceId, ownerId, runnerId, name: `${label}-workspace`, enabled: true, workDir: `/srv/${label}` },
  });
  return { ownerId, runnerId, workspaceId };
}

async function task(db: PrismaClient, w: World, data: Record<string, unknown> = {}): Promise<string> {
  const id = randomUUID();
  await db.task.create({
    data: {
      id, ownerId: w.ownerId, assigneeId: w.workspaceId, title: 'the work', creatorType: CreatorType.USER,
      creatorId: w.ownerId, status: TaskStatus.IN_PROGRESS, completionCriterion: 'EVIDENCE_JUDGMENT', ...data,
    },
  });
  return id;
}

/** A conversation on the world's runner, in the given state (RUNNING by default). */
async function session(db: PrismaClient, w: World, data: Record<string, unknown> = {}): Promise<string> {
  const id = randomUUID();
  const status = (data.status as RunStatus | undefined) ?? RunStatus.RUNNING;
  await db.session.create({
    data: {
      id,
      ownerId: w.ownerId,
      creatorId: w.ownerId,
      workspaceId: w.workspaceId,
      assignedRunnerId: w.runnerId,
      title: 'a conversation',
      prompt: 'Explain the error in the log',
      turnState: turnStateOfWord(status),
      engineTurnActive: status === RunStatus.RUNNING,
      provider: 'claude',
      providerBuiltin: true,
      engine: 'claude',
      dispatchOrigin: SessionDispatchOrigin.USER,
      runSource: SessionRunSource.MANUAL,
      startedAt: new Date(),
      runtimeSessionId: randomUUID(),
      ...data,
    },
  });
  return id;
}

type TurnStatus = 'PENDING' | 'IN_FLIGHT' | 'ANSWERED';

/** A turn as the doors that own it leave it: IN_FLIGHT is out on delivery, ANSWERED was completed. */
async function turn(
  db: PrismaClient,
  sessionId: string,
  seq: number,
  status: TurnStatus,
  row: { kind?: string; content?: string; clientTurnId?: string; outcome?: string } = {},
): Promise<string> {
  const created = await db.conversationTurn.create({
    data: {
      sessionId,
      seq,
      clientTurnId: row.clientTurnId ?? `turn-${seq}-${randomUUID()}`,
      kind: row.kind ?? 'message',
      content: row.content ?? `message ${seq}`,
      status,
      ...(status === 'PENDING' ? {} : { deliveredAt: new Date() }),
      ...(status === 'IN_FLIGHT' ? { leaseDeadlineAt: new Date(Date.now() + 300_000), leaseGeneration: randomUUID() } : {}),
      ...(status === 'ANSWERED' ? { answeredAt: new Date(), outcome: row.outcome ?? 'ANSWERED' } : {}),
    },
    select: { id: true },
  });
  return created.id;
}

interface TurnRow { status: string; outcome: string | null; error: string | null }
interface SessionRow {
  status: string;
  finished_at: Date | null;
  end_reason: string | null;
  error: string | null;
  last_turn_outcome: string | null;
}

async function turnRow(sql: Client, id: string): Promise<TurnRow> {
  const row = (await sql.query(
    `SELECT status, outcome, error FROM "conversation_turn" WHERE id = $1::uuid`, [id],
  )).rows[0] as TurnRow;
  console.log(`# turn ${id} ${JSON.stringify(row)}`);
  return row;
}

async function sessionRow(sql: Client, id: string): Promise<SessionRow> {
  const row = (await sql.query(
    `SELECT status::text AS status, finished_at, end_reason, error, last_turn_outcome
       FROM "session" WHERE id = $1::uuid`,
    [id],
  )).rows[0] as SessionRow;
  console.log(`# session ${id} ${JSON.stringify(row)}`);
  return row;
}

/** The carrying turn and the session both read FAILED, the turn with `error`, and the session is released as today. */
async function assertCarried(
  sql: Client, sessionId: string, turnId: string, error: string, release: { status?: string } = {},
): Promise<void> {
  const t = await turnRow(sql, turnId);
  assert.equal(t.outcome, 'FAILED', 'the carrying turn records the failure');
  assert.equal(t.error, error, 'with the error the release writes');
  assert.equal(t.status, 'ANSWERED', 'and is out of the queue, as the drain always left it');
  const s = await sessionRow(sql, sessionId);
  assert.equal(s.last_turn_outcome, 'FAILED', 'the session copies the outcome');
  assert.equal(s.status, release.status ?? 'FAILED', 'the status is written as before');
  assert.ok(s.finished_at instanceof Date, 'released');
}

/** A queued turn the release drained: out of the queue, and no outcome, because it never ran. */
async function assertDrainedUnrun(sql: Client, turnId: string): Promise<void> {
  const t = await turnRow(sql, turnId);
  assert.equal(t.status, 'ANSWERED', 'drained');
  assert.equal(t.outcome, null, 'a queued turn that never ran has no outcome');
  assert.equal(t.error, null);
}

type ForceFinalize = (id: string, runnerId: string, taskId: string | null, reason: string, opts: object) => Promise<void>;

test('every failure writer records FAILED and the error on the turn that carries it (design §12.1, R2)', {
  skip, concurrency: 1, timeout: 300_000,
}, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const s = stackFor(url, sql);
  const forceFinalize = (s.reaper as unknown as { forceFinalize: ForceFinalize }).forceFinalize.bind(s.reaper);
  const sweep = () => (s.reaper as unknown as { sweep(): Promise<void> }).sweep();
  t.after(async () => {
    await s.db.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });

  /** An EXECUTABLE task's run whose reserved acceptance turn (`true`, expecting 0) is out on delivery. */
  async function acceptanceRun(label: string) {
    const w = await world(s.db, label);
    const taskId = await task(s.db, w, {
      completionCriterion: 'EXECUTABLE', acceptanceCommand: 'true', acceptanceExpectedExitCode: 0,
    });
    const sessionId = await session(s.db, w, { taskId, startsTaskWork: true });
    await turn(s.db, sessionId, 1, 'ANSWERED', { content: 'do the task' });
    const shellTurn = await turn(s.db, sessionId, 2, 'IN_FLIGHT', {
      kind: 'shell', content: 'true', clientTurnId: `${TASK_ACCEPTANCE_CLIENT_TURN_PREFIX}${randomUUID()}:0`,
    });
    return { w, taskId, sessionId, shellTurn };
  }

  await t.test('W1a turn-complete: an exit code the declaration did not ask for fails the acceptance turn', async () => {
    const r = await acceptanceRun('w1a');
    await s.api.turnComplete({ id: r.w.runnerId }, r.sessionId, {
      turnId: r.shellTurn, status: SharedRunStatus.SUCCEEDED, shellExitCode: 1, numTurns: 0, costUsd: 0,
    } as never);
    const error = 'acceptance command exited 1; expected 0';
    await assertCarried(sql, r.sessionId, r.shellTurn, error);
    assert.equal((await sessionRow(sql, r.sessionId)).error, error, 'the session error is written as before');
    const taskRow = await s.db.task.findUniqueOrThrow({ where: { id: r.taskId }, select: { status: true } });
    assert.equal(taskRow.status, TaskStatus.FAILED, 'and the task is judged as before');
  });

  await t.test('W1b turn-complete: an acceptance result that cannot be compared fails the acceptance turn', async () => {
    const r = await acceptanceRun('w1b');
    // An older runner omits the exit code.
    await s.api.turnComplete({ id: r.w.runnerId }, r.sessionId, {
      turnId: r.shellTurn, status: SharedRunStatus.SUCCEEDED, numTurns: 0, costUsd: 0,
    } as never);
    const error = 'acceptance command result no longer matches the current declaration';
    await assertCarried(sql, r.sessionId, r.shellTurn, error);
    assert.equal((await sessionRow(sql, r.sessionId)).error, error);
  });

  await t.test('W1c turn-complete: a failed turn that is not a turn of work still carries the failure', async () => {
    const w = await world(s.db, 'w1c');
    const id = await session(s.db, w);
    const control = await turn(s.db, id, 1, 'IN_FLIGHT', { kind: 'control', content: '/compact' });
    await s.api.turnComplete({ id: w.runnerId }, id, {
      turnId: control, status: SharedRunStatus.FAILED, error: 'compaction failed', numTurns: 0, costUsd: 0,
    } as never);
    await assertCarried(sql, id, control, 'compaction failed');
  });

  await t.test('W2 the reaper, runner offline: the turn in flight, else the one the claim was for', async () => {
    const w = await world(s.db, 'w2');
    const opts = { expectedStatuses: [RunStatus.RUNNING], onlyIfNotCancelling: true, armRetry: true,
      carryingTurn: { outcome: 'FAILED', orLatest: false } };
    const inFlight = await session(s.db, w);
    const answered = await turn(s.db, inFlight, 1, 'ANSWERED');
    const running = await turn(s.db, inFlight, 2, 'IN_FLIGHT');
    const queued = await turn(s.db, inFlight, 3, 'PENDING');
    await forceFinalize(inFlight, w.runnerId, null, 'runner offline', opts);
    await assertCarried(sql, inFlight, running, 'runner offline');
    await assertDrainedUnrun(sql, queued);
    assert.equal((await turnRow(sql, answered)).outcome, 'ANSWERED', 'an earlier turn keeps its own outcome');
    // Lost between the claim and the inbox read: the first PENDING turn is the one the claim was for.
    const claimed = await session(s.db, w);
    const first = await turn(s.db, claimed, 1, 'PENDING');
    const second = await turn(s.db, claimed, 2, 'PENDING');
    await forceFinalize(claimed, w.runnerId, null, 'runner offline', opts);
    await assertCarried(sql, claimed, first, 'runner offline');
    await assertDrainedUnrun(sql, second);
  });

  await t.test('W3 the reaper, runtime never initialized: the PENDING turn', async () => {
    const w = await world(s.db, 'w3');
    const id = await session(s.db, w, { runtimeSessionId: null });
    const pending = await turn(s.db, id, 1, 'PENDING');
    await forceFinalize(id, w.runnerId, null, 'claude runtime not initialized', {
      expectedStatuses: [RunStatus.RUNNING], onlyIfNotCancelling: true,
      taskFailure: 'ATTEMPT_LOST_RUNTIME_NOT_INITIALIZED', 
      carryingTurn: { outcome: 'FAILED', orLatest: false },
    });
    await assertCarried(sql, id, pending, 'claude runtime not initialized');
  });

  /** A RUNNING chat run whose source is SELECTED and not yet pinned, as a runner holds it right after the claim. */
  async function refusableRun(w: World): Promise<string> {
    return session(s.db, w, {
      runtimeSessionId: null, runClaimedAt: new Date(), numTurns: 0,
      sourceState: 'SELECTED', sourceKind: 'CHAT_UPSTREAM', sourceRepoUrl: 'https://git.invalid/acme/widgets',
      sourceRefAuthority: 'REMOTE', sourceRef: 'refs/heads/main',
    });
  }

  await t.test('W4 the runner refuses the source: the PENDING turn fails, and nothing is left queued', async () => {
    const w = await world(s.db, 'w4');
    const id = await refusableRun(w);
    const dispatched = await turn(s.db, id, 1, 'PENDING');
    const followUp = await turn(s.db, id, 2, 'PENDING');
    const stderr = "fatal: couldn't find remote ref refs/heads/main";
    const out = await s.db.$transaction((tx) => freezeSessionSourcePin(
      tx, { sessionId: id, runnerId: w.runnerId, ownerId: w.ownerId },
      { refusal: { code: 'BASE_REF_NOT_FOUND', detail: { ref: 'refs/heads/main', stderr } } },
    ));
    assert.equal(out.wonRace, true);
    const error = `BASE_REF_NOT_FOUND: ${stderr}`;
    await assertCarried(sql, id, dispatched, error);
    assert.equal((await sessionRow(sql, id)).error, error, 'the session error is written as before');
    await assertDrainedUnrun(sql, followUp);
    const pending = (await sql.query(
      `SELECT count(*)::int AS n FROM "conversation_turn" WHERE session_id = $1::uuid AND status = 'PENDING'`, [id],
    )).rows[0] as { n: number };
    assert.equal(pending.n, 0, 'the released session leaves no PENDING turn');
  });

  await t.test('W5 a failed transcript import: nothing failed in a conversation, so no outcome anywhere', async () => {
    const w = await world(s.db, 'w5');
    const id = await session(s.db, w, { importSourceCwd: '/home/someone/project' });
    // A message sent during the import can be queued.
    const queued = await turn(s.db, id, 1, 'PENDING');
    const answer = await s.api.importResult({ id: w.runnerId, ownerId: w.ownerId } as never, id, {
      ok: false, error: 'transcript holds no conversation',
    });
    assert.equal(answer.failed, true);
    const row = await sessionRow(sql, id);
    assert.equal(row.status, 'FAILED', 'released as before');
    assert.equal(row.last_turn_outcome, null, 'no turn outcome on the session');
    assert.equal((await turnRow(sql, queued)).outcome, null, 'and none on the turn');
  });

  await t.test('W6 the runner finalize, FAILED with no end asked: the turn in flight, else the latest', async () => {
    const w = await world(s.db, 'w6');
    const midTurn = await session(s.db, w);
    await turn(s.db, midTurn, 1, 'ANSWERED');
    const running = await turn(s.db, midTurn, 2, 'IN_FLIGHT');
    const queued = await turn(s.db, midTurn, 3, 'PENDING');
    await s.api.finalize({ id: w.runnerId }, midTurn, { status: SharedRunStatus.FAILED, error: 'engine crashed' } as never);
    await assertCarried(sql, midTurn, running, 'engine crashed');
    await assertDrainedUnrun(sql, queued);
    // Idle: the link gave up events with nothing queued (runner-go session.go, the periodic flusher). The last turn.
    const idle = await session(s.db, w, { status: RunStatus.AWAITING_INPUT });
    await turn(s.db, idle, 1, 'ANSWERED');
    const last = await turn(s.db, idle, 2, 'ANSWERED');
    const why = "the runner link gave up the session's events: the control plane refused the events after seq 41 5 times in a row";
    await s.api.finalize({ id: w.runnerId }, idle, { status: SharedRunStatus.FAILED, error: why } as never);
    await assertCarried(sql, idle, last, why);
    // Not a failure: a finalize after an end that was asked for writes no outcome.
    const ended = await session(s.db, w, { cancelRequestedAt: new Date(), endReason: SessionEndReason.ENDED });
    const endedTurn = await turn(s.db, ended, 1, 'IN_FLIGHT');
    await s.api.finalize({ id: w.runnerId }, ended, { status: SharedRunStatus.FAILED, error: 'killed' } as never);
    assert.equal((await turnRow(sql, endedTurn)).outcome, null, 'an end asked for records no failure');
    assert.equal((await sessionRow(sql, ended)).last_turn_outcome, null);
  });

  await t.test('W7 the reaper, an end asked for and not honoured: the turn in flight is CANCELLED, nothing FAILED', async () => {
    const w = await world(s.db, 'w7');
    const stale = new Date(Date.now() - 10 * 60_000);
    const running = await session(s.db, w, { cancelRequestedAt: stale });
    const before = await turn(s.db, running, 1, 'ANSWERED');
    const cutOff = await turn(s.db, running, 2, 'IN_FLIGHT');
    const queued = await turn(s.db, running, 3, 'PENDING');
    // Idle when the end was asked: no turn in flight, so no turn outcome at all.
    const idle = await session(s.db, w, {
      status: RunStatus.AWAITING_INPUT, cancelRequestedAt: stale, endReason: SessionEndReason.DELETED, deletedAt: stale,
    });
    const idleLast = await turn(s.db, idle, 1, 'ANSWERED');
    await sweep();
    const cut = await turnRow(sql, cutOff);
    assert.equal(cut.outcome, 'CANCELLED', 'the turn the end cut off ends CANCELLED');
    assert.equal(cut.error, 'cancel not honored');
    const row = await sessionRow(sql, running);
    assert.equal(row.last_turn_outcome, 'CANCELLED', 'and the session copies it: no FAILED');
    assert.equal(row.status, 'FAILED', 'the status is written as before');
    assert.equal((await turnRow(sql, before)).outcome, 'ANSWERED');
    await assertDrainedUnrun(sql, queued);
    const idleRow = await sessionRow(sql, idle);
    assert.equal(idleRow.status, 'FAILED');
    assert.equal(idleRow.end_reason, 'deleted');
    assert.equal(idleRow.last_turn_outcome, null, 'nothing was in flight: no outcome is written');
    assert.equal((await turnRow(sql, idleLast)).outcome, 'ANSWERED', 'the last turn keeps its own');
    const failed = (await sql.query(
      `SELECT count(*)::int AS n FROM "conversation_turn" WHERE session_id = ANY($1::uuid[]) AND outcome = 'FAILED'`,
      [[running, idle]],
    )).rows[0] as { n: number };
    assert.equal(failed.n, 0, 'no turn of either reads FAILED');
  });

  /**
   * A failure release revived, as the owner's message revives it, then claimed again: the revive keeps
   * last_turn_outcome (FAILED, the copy of the failed turn) and queues its message as a PENDING turn. The claim is
   * written as the queue writes it: RUNNING, the claim's markers, and the inbox lease owned by the runner process
   * that took it, which that process names in its finalize (`leaseOwner`).
   */
  async function revivedFailure(w: World, label: string): Promise<{
    id: string; failedTurn: string; revivedTurn: string; leaseOwner: string;
  }> {
    const id = await session(s.db, w, { title: label });
    const failedTurn = await turn(s.db, id, 1, 'IN_FLIGHT');
    await s.api.finalize({ id: w.runnerId }, id, { status: SharedRunStatus.FAILED, error: 'engine crashed' } as never);
    await assertCarried(sql, id, failedTurn, 'engine crashed');
    await s.sessions.resume(w.ownerId, id, { clientTurnId: `revive-${randomUUID()}`, content: 'Try again' });
    const revived = await sessionRow(sql, id);
    assert.equal(revived.status, 'PENDING', 'revived');
    assert.equal(revived.finished_at, null, 'held again');
    assert.equal(revived.last_turn_outcome, 'FAILED', 'the revive keeps the copy of the failed turn');
    const queued = (await sql.query(
      `SELECT id FROM "conversation_turn" WHERE session_id = $1::uuid AND status = 'PENDING' AND kind = 'message'`, [id],
    )).rows as Array<{ id: string }>;
    assert.equal(queued.length, 1, 'the revive queued its message');
    // In one transaction that declares it reads session engines, as the claim does: without it the engine guard
    // (guard_session_engine_acquisition) skips a PENDING to RUNNING write on an engine session, silently.
    const leaseOwner = randomUUID();
    await sql.query('BEGIN');
    try {
      await sql.query(`SELECT set_config('orbit.claim_reads_session_engine', '1', true)`);
      const claimed = await sql.query(
        `UPDATE "session" SET "turn_state" = 'IN_FLIGHT', engine_turn_active = true, run_claimed_at = now(),
                inbox_lease_owner = $2::uuid
          WHERE id = $1::uuid AND status = 'PENDING'`, [id, leaseOwner]);
      assert.equal(claimed.rowCount, 1, 'claimed');
      await sql.query('COMMIT');
    } catch (error) {
      await sql.query('ROLLBACK');
      throw error;
    }
    return { id, failedTurn, revivedTurn: queued[0].id, leaseOwner };
  }

  await t.test('A the runner finalize with no end asked and no failure: the turn it cuts off CANCELLED (option A)', async () => {
    const w = await world(s.db, 'option-a');
    // The coordinator's shape: a failure release, revived, finalized CANCELLED with no end asked before a turn completed.
    const revived = await revivedFailure(w, 'revived');
    await s.api.finalize({ id: w.runnerId }, revived.id, {
      status: SharedRunStatus.CANCELLED, leaseOwner: revived.leaseOwner,
    } as never);
    const cut = await turnRow(sql, revived.revivedTurn);
    assert.equal(cut.outcome, 'CANCELLED', 'the queued turn the release cut off ends CANCELLED');
    assert.equal(cut.status, 'ANSWERED', 'and is drained as before');
    const row = await sessionRow(sql, revived.id);
    assert.equal(row.last_turn_outcome, 'CANCELLED', 'the session copies it: the FAILED of the run before is gone');
    assert.equal(row.status, 'CANCELLED', 'the status is written as before');
    assert.equal(row.end_reason, null, 'no end was asked');
    assert.equal(releaseWasFailure({
      finishedAt: row.finished_at, endReason: row.end_reason, lastTurnOutcome: row.last_turn_outcome, turnState: turnStateOfWord(row.status),
    }), false, 'so the release reads as no failure (common/session-release.ts), as nothing but the turn and the end reason say');
    assert.equal((await turnRow(sql, revived.failedTurn)).outcome, 'FAILED', 'the failed turn keeps its own');

    // A turn in flight and one queued, the runner's word SUCCEEDED: the one in flight is cut off, the queued one drained.
    const busy = await session(s.db, w);
    const inFlight = await turn(s.db, busy, 1, 'IN_FLIGHT');
    const queued = await turn(s.db, busy, 2, 'PENDING');
    await s.api.finalize({ id: w.runnerId }, busy, { status: SharedRunStatus.SUCCEEDED } as never);
    assert.equal((await turnRow(sql, inFlight)).outcome, 'CANCELLED');
    await assertDrainedUnrun(sql, queued);
    const busyRow = await sessionRow(sql, busy);
    assert.equal(busyRow.last_turn_outcome, 'CANCELLED');
    assert.equal(busyRow.status, 'SUCCEEDED', 'the runner\'s word, written as before');

    // Nothing in flight or queued: nothing is written, and the copy keeps the last turn's outcome.
    const idle = await session(s.db, w, { status: RunStatus.AWAITING_INPUT, lastTurnOutcome: 'ANSWERED' });
    const last = await turn(s.db, idle, 1, 'ANSWERED');
    await s.api.finalize({ id: w.runnerId }, idle, { status: SharedRunStatus.CANCELLED } as never);
    assert.equal((await sessionRow(sql, idle)).last_turn_outcome, 'ANSWERED', 'no turn to cut off: no outcome written');
    assert.equal((await turnRow(sql, last)).outcome, 'ANSWERED');

    // An end that was asked for: not this rule's (the end's own status, no outcome written by the finalize).
    const ended = await session(s.db, w, { cancelRequestedAt: new Date(), endReason: SessionEndReason.ENDED });
    const endedTurn = await turn(s.db, ended, 1, 'IN_FLIGHT');
    await s.api.finalize({ id: w.runnerId }, ended, { status: SharedRunStatus.CANCELLED } as never);
    assert.equal((await turnRow(sql, endedTurn)).outcome, null, 'an end asked for is not cut off by this rule');
    assert.equal((await sessionRow(sql, ended)).last_turn_outcome, null);
  });

  await t.test('A (tx) the finalize\'s CANCELLED commits with its release or not at all', async () => {
    // A trigger that refuses, for the sessions listed, the drain's write of a turn that never ran.
    await sql.query(`CREATE TABLE IF NOT EXISTS option_a_poison (session_id uuid PRIMARY KEY)`);
    await sql.query(`
      CREATE OR REPLACE FUNCTION option_a_poison_refuse() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.status = 'ANSWERED' AND OLD.status <> 'ANSWERED' AND OLD.outcome IS NULL
           AND EXISTS (SELECT 1 FROM option_a_poison WHERE session_id = NEW.session_id) THEN
          RAISE EXCEPTION 'option a: the drain is refused';
        END IF;
        RETURN NEW;
      END $$`);
    await sql.query(`DROP TRIGGER IF EXISTS option_a_poison_turn ON "conversation_turn"`);
    await sql.query(`CREATE TRIGGER option_a_poison_turn BEFORE UPDATE ON "conversation_turn" FOR EACH ROW EXECUTE FUNCTION option_a_poison_refuse()`);
    t.after(async () => {
      await sql.query(`DROP TRIGGER IF EXISTS option_a_poison_turn ON "conversation_turn"`).catch(() => undefined);
      await sql.query(`DROP FUNCTION IF EXISTS option_a_poison_refuse()`).catch(() => undefined);
      await sql.query(`DROP TABLE IF EXISTS option_a_poison`).catch(() => undefined);
    });
    const w = await world(s.db, 'option-a-tx');
    const revived = await revivedFailure(w, 'revived-tx');
    // A second queued turn, which the drain answers after the cut-off one is recorded: refused.
    await turn(s.db, revived.id, 3, 'PENDING');
    await sql.query(`INSERT INTO option_a_poison (session_id) VALUES ($1::uuid)`, [revived.id]);
    await assert.rejects(s.api.finalize({ id: w.runnerId }, revived.id, {
      status: SharedRunStatus.CANCELLED, leaseOwner: revived.leaseOwner,
    } as never), /option a: the drain is refused/);
    const row = await sessionRow(sql, revived.id);
    assert.equal(row.finished_at, null, 'the release rolled back');
    assert.equal(row.status, 'RUNNING');
    assert.equal(row.last_turn_outcome, 'FAILED', 'and the copy with it: still the one the revive kept');
    const t1 = await turnRow(sql, revived.revivedTurn);
    assert.equal(t1.outcome, null, 'and the cut-off turn\'s outcome with it');
    assert.equal(t1.status, 'PENDING');
  });

  await t.test('W8 the reaper\'s API-error backstop, through its sweep: the latest turn, ANSWERED before, FAILED', async () => {
    const w = await world(s.db, 'w8');
    const taskId = await task(s.db, w);
    const id = await session(s.db, w, { status: RunStatus.AWAITING_INPUT, taskId, startsTaskWork: true });
    const first = await turn(s.db, id, 1, 'ANSWERED');
    const last = await turn(s.db, id, 2, 'ANSWERED');
    const reply = 'API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"Output blocked by content filtering policy"}}';
    await s.db.runEvent.create({
      data: { sessionId: id, seq: 1, type: RunEventType.ASSISTANT, payload: { text: reply }, turnId: last },
    });
    await sweep();
    await assertCarried(sql, id, last, reply);
    assert.equal((await sessionRow(sql, id)).error, 'run failed (API error)', 'the session error is written as before');
    assert.equal((await turnRow(sql, first)).outcome, 'ANSWERED', 'an earlier turn keeps its own outcome');
  });

  await t.test('(tx) a statement after the release and the outcome fails: neither is found', async () => {
    // A trigger that refuses, for the sessions listed, the drain's write (a turn answered) or the release's own write.
    await sql.query(`CREATE TABLE IF NOT EXISTS r2_poison (session_id uuid PRIMARY KEY, target text NOT NULL)`);
    await sql.query(`
      CREATE OR REPLACE FUNCTION r2_poison_refuse() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_TABLE_NAME = 'conversation_turn' THEN
          IF NEW.status = 'ANSWERED' AND OLD.status <> 'ANSWERED' AND OLD.outcome IS NULL
             AND EXISTS (SELECT 1 FROM r2_poison WHERE session_id = NEW.session_id AND target = 'drain') THEN
            RAISE EXCEPTION 'r2: the drain is refused';
          END IF;
        ELSIF NEW.status = 'FAILED' AND OLD.status <> 'FAILED'
          AND EXISTS (SELECT 1 FROM r2_poison WHERE session_id = NEW.id AND target = 'release') THEN
          RAISE EXCEPTION 'r2: the release is refused';
        END IF;
        RETURN NEW;
      END $$`);
    await sql.query(`DROP TRIGGER IF EXISTS r2_poison_turn ON "conversation_turn"`);
    await sql.query(`CREATE TRIGGER r2_poison_turn BEFORE UPDATE ON "conversation_turn" FOR EACH ROW EXECUTE FUNCTION r2_poison_refuse()`);
    await sql.query(`DROP TRIGGER IF EXISTS r2_poison_session ON "session"`);
    await sql.query(`CREATE TRIGGER r2_poison_session BEFORE UPDATE ON "session" FOR EACH ROW EXECUTE FUNCTION r2_poison_refuse()`);
    t.after(async () => {
      await sql.query(`DROP TRIGGER IF EXISTS r2_poison_turn ON "conversation_turn"`).catch(() => undefined);
      await sql.query(`DROP TRIGGER IF EXISTS r2_poison_session ON "session"`).catch(() => undefined);
      await sql.query(`DROP FUNCTION IF EXISTS r2_poison_refuse()`).catch(() => undefined);
      await sql.query(`DROP TABLE IF EXISTS r2_poison`).catch(() => undefined);
    });
    const poison = (id: string, target: 'drain' | 'release') =>
      sql.query(`INSERT INTO r2_poison (session_id, target) VALUES ($1::uuid, $2)`, [id, target]);
    /** Neither half committed: the session is not released and carries no outcome, the turn has none. */
    async function assertNeither(sessionId: string, turnId: string): Promise<void> {
      const row = await sessionRow(sql, sessionId);
      assert.equal(row.finished_at, null, 'the release rolled back');
      assert.equal(row.last_turn_outcome, null, 'and the session copy with it');
      assert.equal((await turnRow(sql, turnId)).outcome, null, 'and the turn outcome with it');
    }
    const w = await world(s.db, 'tx');

    // W1: the turn outcome is written before the park that releases the session; the park is refused.
    const w1 = await session(s.db, w);
    const w1Turn = await turn(s.db, w1, 1, 'IN_FLIGHT');
    await poison(w1, 'release');
    await assert.rejects(s.api.turnComplete({ id: w.runnerId }, w1, {
      turnId: w1Turn, status: SharedRunStatus.FAILED, error: 'API Error: 500', numTurns: 1, costUsd: 0,
    } as never), /r2: the release is refused/);
    await assertNeither(w1, w1Turn);

    // W2 and W8 (forceFinalize): the release and the outcome are written, then the drain of a queued turn is refused.
    const w2 = await session(s.db, w);
    const w2Turn = await turn(s.db, w2, 1, 'IN_FLIGHT');
    await turn(s.db, w2, 2, 'PENDING');
    await poison(w2, 'drain');
    await assert.rejects(forceFinalize(w2, w.runnerId, null, 'runner offline', {
      expectedStatuses: [RunStatus.RUNNING], onlyIfNotCancelling: true, 
      carryingTurn: { outcome: 'FAILED', orLatest: false },
    }), /r2: the drain is refused/);
    await assertNeither(w2, w2Turn);

    // W4: the same, in the source refusal's transaction.
    const w4 = await refusableRun(w);
    const w4Turn = await turn(s.db, w4, 1, 'PENDING');
    await turn(s.db, w4, 2, 'PENDING');
    await poison(w4, 'drain');
    await assert.rejects(s.db.$transaction((tx) => freezeSessionSourcePin(
      tx, { sessionId: w4, runnerId: w.runnerId, ownerId: w.ownerId },
      { refusal: { code: 'BASE_REF_NOT_FOUND', detail: { stderr: 'no such ref' } } },
    )), /r2: the drain is refused/);
    await assertNeither(w4, w4Turn);

    // W6: the same, in the finalize's transaction.
    const w6 = await session(s.db, w);
    const w6Turn = await turn(s.db, w6, 1, 'IN_FLIGHT');
    await turn(s.db, w6, 2, 'PENDING');
    await poison(w6, 'drain');
    await assert.rejects(s.api.finalize({ id: w.runnerId }, w6, {
      status: SharedRunStatus.FAILED, error: 'engine crashed',
    } as never), /r2: the drain is refused/);
    await assertNeither(w6, w6Turn);
  });
});
