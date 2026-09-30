/**
 * A MESSAGE TURN OWES ITS ACCEPTANCE ROUND ONCE — WHEN IT IS ANSWERED, NOT EACH TIME IT ENDS.
 *
 * On 2026-09-29 at 10:34 UTC the run of an EXECUTABLE task (session 2KNascj31sPkLf1PQylOsa) was
 * handed a background job's exit wake as a message turn. Its first completion came back SUCCEEDED
 * with nothing under the turn that answered it, so turn-complete put the turn back in the queue —
 * and, in the same transaction, queued the task's acceptance shell turn for it, under the key
 * `system:task-acceptance:v1:<turn id>:0`. The wake was delivered again, answered, and completed
 * again: the same key, a second INSERT, P2002 on `(session_id, client_turn_id)`, the ACK rolled
 * back with it, and a 500. The runner re-posts a 5xx without a ceiling, every two seconds — 20 158
 * times by 23:47 — so the turn stayed IN_FLIGHT, the session RUNNING, and the two acceptance rounds
 * queued behind it never ran.
 *
 * Two shapes, one per half of the repair:
 *
 *   (a) The whole sequence through the real doors: a completion nothing answered (the turn goes back
 *       in the queue), the inbox handing it out again, the reply, a second completion. The round is
 *       queued by the completion that answered the turn, and by no other.
 *   (b) The incident's rows as it left them: the round for the in-flight turn is already queued when
 *       the completion that answers it arrives. That completion is the runner's next retry once this
 *       is deployed; it has to go through without a hand edit of the database, and queue nothing.
 *
 *     bash scripts/run-pg-spec.sh src/apiserver/src/runner-api/turn-complete-requeued-acceptance.pg.spec.ts
 *
 * Not destructive: every id is freshly generated and every assertion is scoped to the rows it made.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import {
  CreatorType,
  PrismaClient,
  RunStatus,
  RunnerStatus,
  SessionDispatchOrigin,
} from '@prisma/client';
import { RunEventType, RunStatus as SharedRunStatus, type RunInboxResponse } from '@orbit/shared';
import { Client } from 'pg';

import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import type { QueueService } from '../queue/queue.service';
import type { RealtimeService } from '../realtime/realtime.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { TASK_ACCEPTANCE_CLIENT_TURN_PREFIX } from '../tasks/executable-acceptance-round';
import { BACKGROUND_WAKE_TURN_PREFIX } from './background-job-wake';
import { RunnerApiController } from './runner-api.controller';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

/** The task's declaration: the command its acceptance round runs, and the code that settles it. */
const ACCEPTANCE = { command: 'true', expectedExitCode: 0 } as const;

/** The production wiring, over one client and with no seam in the path under test. */
function connect(url: string): { db: PrismaClient; api: RunnerApiController } {
  const db = prismaClientFor(url);
  const prisma = db as unknown as PrismaService;
  const realtime = new Proxy({}, { get: () => () => undefined }) as unknown as RealtimeService;
  const queue = { notifySessionQueued: () => undefined } as unknown as QueueService;
  return {
    db,
    api: new RunnerApiController(
      prisma,
      queue,
      realtime,
      {} as never,
      {} as never,
      // #references are expanded on the way out of the inbox; this spec is about which turn the
      // inbox hands over, not what is written into it.
      { expand: async (_ownerId: string, content?: string) => content } as never,
      { appendFor: async (_tx: unknown, _sessionId: string, content?: string) => content } as never,
    ),
  };
}

interface Fixture {
  ownerId: string;
  runnerId: string;
  taskId: string;
  sessionId: string;
}

/**
 * One owner, one runner, and the RUNNING session of an EXECUTABLE task — the only kind of task a
 * successful message turn queues an acceptance round for.
 *
 * `inbox_lease_owner` and `inbox_lease_generation` are left null so the real boundaries' lease
 * checks pass with no lease token, as `turn-complete-unanswered.pg.spec.ts` builds it.
 */
async function fixture(db: PrismaClient, label: string): Promise<Fixture> {
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  const taskId = randomUUID();
  const sessionId = randomUUID();
  await db.user.create({
    data: {
      id: ownerId,
      email: `${label}-${ownerId}@requeued-acceptance.invalid`,
      name: 'The account owner',
      passwordHash: 'x',
    },
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
  await db.task.create({
    data: {
      id: taskId,
      ownerId,
      assigneeId: workspaceId,
      title: `${label} task`,
      creatorType: CreatorType.USER,
      creatorId: ownerId,
      completionCriterion: 'EXECUTABLE',
      acceptanceCommand: ACCEPTANCE.command,
      acceptanceExpectedExitCode: ACCEPTANCE.expectedExitCode,
    },
  });
  await db.session.create({
    data: {
      id: sessionId,
      ownerId,
      creatorId: ownerId,
      taskId,
      workspaceId,
      assignedRunnerId: runnerId,
      title: `${label} run`,
      prompt: 'do the task',
      provider: 'claude',
      status: RunStatus.RUNNING,
      engineTurnActive: true,
      dispatchOrigin: SessionDispatchOrigin.USER,
      startsTaskWork: true,
      startedAt: new Date(),
      runtimeSessionId: randomUUID(),
    },
  });
  return { ownerId, runnerId, taskId, sessionId };
}

/**
 * One conversation turn, in the state the doors that own it leave it in: IN_FLIGHT is what the inbox
 * statement writes when it hands a turn to a runner (the claim and the delivery are one UPDATE), and
 * ANSWERED is what a completion writes.
 */
async function turn(
  db: PrismaClient,
  f: Fixture,
  row: {
    seq: number;
    clientTurnId: string;
    kind: 'message' | 'shell';
    content: string;
    status: 'PENDING' | 'IN_FLIGHT' | 'ANSWERED';
  },
): Promise<string> {
  const delivered = row.status === 'PENDING' ? {} : { deliveredAt: new Date() };
  const created = await db.conversationTurn.create({
    data: {
      sessionId: f.sessionId,
      ...row,
      ...delivered,
      ...(row.status === 'IN_FLIGHT' ? { leaseDeadlineAt: new Date(Date.now() + 300_000) } : {}),
      ...(row.status === 'ANSWERED' ? { answeredAt: new Date() } : {}),
    },
    select: { id: true },
  });
  return created.id;
}

/** The key turn-complete queues a message turn's acceptance round under. */
function acceptanceKey(messageTurnId: string): string {
  return `${TASK_ACCEPTANCE_CLIENT_TURN_PREFIX}${messageTurnId}:${ACCEPTANCE.expectedExitCode}`;
}

/** The transcript as the runner writes it: through the real ingest, not by hand. */
function say(
  api: RunnerApiController,
  f: Fixture,
  turnId: string,
  seq: number,
  type: RunEventType,
  payload: Record<string, unknown>,
) {
  return api.events({ id: f.runnerId }, f.sessionId, {
    events: [{ seq, type, ts: new Date().toISOString(), turnId, payload }],
  });
}

/** The statement the runner's own inbox poll runs. Null means it was offered nothing. */
function poll(api: RunnerApiController, f: Fixture): Promise<RunInboxResponse | null> {
  return (
    api as unknown as {
      dequeueTurn: (
        sessionId: string,
        runnerId: string,
        leaseGeneration: string | null,
      ) => Promise<RunInboxResponse | null>;
    }
  ).dequeueTurn.call(api, f.sessionId, f.runnerId, null);
}

/**
 * A successful engine turn reported the way the runner reports it, and required to go through.
 *
 * A throw here is what the runner receives as a 500, and it re-posts a 5xx without a ceiling — so
 * the error is named as that rather than left to read as a fixture problem.
 */
async function complete(api: RunnerApiController, f: Fixture, turnId: string) {
  try {
    return await api.turnComplete({ id: f.runnerId }, f.sessionId, {
      turnId,
      status: SharedRunStatus.SUCCEEDED,
      subtype: 'success',
      numTurns: 1,
      costUsd: 0.0123,
    });
  } catch (error) {
    assert.fail(
      'turn-complete threw, which the runner receives as a 500 and re-posts every two seconds '
        + `for as long as the session lives: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

test('a message turn owes its acceptance round once, and only once it is answered', {
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

  /** Read back over a second connection, never through the answer that wrote it. */
  async function row(turnId: string) {
    const r = await sql.query(
      `SELECT status, answered_at, delivered_at FROM "conversation_turn" WHERE id = $1::uuid`,
      [turnId],
    );
    return r.rows[0] as { status: string; answered_at: Date | null; delivered_at: Date | null };
  }

  /** Every acceptance round queued in the session, in queue order. */
  async function acceptanceRounds(sessionId: string) {
    const r = await sql.query(
      `SELECT id, seq, client_turn_id, content, status FROM "conversation_turn"
        WHERE session_id = $1::uuid AND kind = 'shell' AND client_turn_id LIKE $2
        ORDER BY seq`,
      [sessionId, `${TASK_ACCEPTANCE_CLIENT_TURN_PREFIX}%`],
    );
    return r.rows as Array<{
      id: string;
      seq: number;
      client_turn_id: string;
      content: string;
      status: string;
    }>;
  }

  // ═══ (a) the sequence, through the real doors ════════════════════════════════════════════════
  // One session for both halves: (a2) continues from the rows (a1) leaves.
  const a = await fixture(db, 'requeued');
  const message = await turn(db, a, {
    seq: 1,
    clientTurnId: `initial-${a.sessionId}`,
    kind: 'message',
    content: 'do the task',
    status: 'IN_FLIGHT',
  });

  await t.test('(a1) the completion nothing answered puts the turn back and queues no round', async () => {
    // The runner echoes what it delivered, and the engine says nothing under this turn.
    await say(api, a, message, 1, RunEventType.USER, { text: 'do the task' });

    const answer = await complete(api, a, message);
    assert.deepEqual(answer, { ok: true, status: RunStatus.RUNNING },
      'the turn is owed an answer still, so the session carries on');

    const after = await row(message);
    assert.equal(after.status, 'PENDING', 'nothing answered it, so it goes back in the queue');
    assert.equal(after.delivered_at, null, 'and it is no longer out on a delivery');
    assert.deepEqual(await acceptanceRounds(a.sessionId), [],
      'a turn put back in the queue has not been answered: the work it asked for is not finished, '
        + 'and its acceptance round is owed by the completion that answers it, not by this one');
  });

  await t.test('(a2) the completion that answers it on its second delivery queues exactly one', async () => {
    const offered = await poll(api, a);
    assert.equal(offered?.turnId, message, 'the inbox hands the same turn out again');
    // The second delivery, and this time the engine answers.
    await say(api, a, message, 2, RunEventType.USER, { text: 'do the task' });
    await say(api, a, message, 3, RunEventType.ASSISTANT, { text: 'done — the build is green' });

    const answer = await complete(api, a, message);
    assert.deepEqual(answer, { ok: true, status: RunStatus.RUNNING },
      'the completion goes through, and the session carries on into the acceptance round');

    const after = await row(message);
    assert.equal(after.status, 'ANSWERED', 'there is an answer under this turn, so it is answered');
    assert.ok(after.answered_at instanceof Date, 'and the moment it was answered is recorded');
    const rounds = await acceptanceRounds(a.sessionId);
    assert.deepEqual(
      rounds.map(({ client_turn_id, content, status }) => ({ client_turn_id, content, status })),
      [{ client_turn_id: acceptanceKey(message), content: ACCEPTANCE.command, status: 'PENDING' }],
      'exactly one acceptance round, for this turn, running the declared command');

    // The runner re-posts a completion whose response it lost. Nothing is left to settle.
    assert.deepEqual(await complete(api, a, message), { ok: true, status: RunStatus.RUNNING });
    assert.equal((await acceptanceRounds(a.sessionId)).length, 1, 'and the retry queues no second round');

    // And the round is what the inbox hands out next: the task moves.
    const next = await poll(api, a);
    assert.equal(next?.turnId, rounds[0].id);
    assert.equal(next?.kind, 'shell');
    assert.equal(next?.taskAcceptance, true);
    assert.equal(next?.content, ACCEPTANCE.command);
  });

  // ═══ (b) the incident's rows ═════════════════════════════════════════════════════════════════
  await t.test('(b) the round is already queued when the completion that answers the turn arrives', async () => {
    const b = await fixture(db, 'incident');
    // The rows as the incident left them, seq for seq: the opening message answered, with its round
    // queued; the wake out on its second delivery; and the wake's round, queued by the completion
    // that put it back in the queue.
    const opening = await turn(db, b, {
      seq: 1,
      clientTurnId: `initial-${b.sessionId}`,
      kind: 'message',
      content: 'do the task',
      status: 'ANSWERED',
    });
    const wake = await turn(db, b, {
      seq: 2,
      clientTurnId: `${BACKGROUND_WAKE_TURN_PREFIX}bgj_5fdec1fab141:exit`,
      kind: 'message',
      content: '',
      status: 'IN_FLIGHT',
    });
    const openingRound = await turn(db, b, {
      seq: 3,
      clientTurnId: acceptanceKey(opening),
      kind: 'shell',
      content: ACCEPTANCE.command,
      status: 'PENDING',
    });
    const wakeRound = await turn(db, b, {
      seq: 4,
      clientTurnId: acceptanceKey(wake),
      kind: 'shell',
      content: ACCEPTANCE.command,
      status: 'PENDING',
    });
    // Both deliveries of the wake, and the reply the first one never got.
    await say(api, b, wake, 1, RunEventType.USER, { text: 'background job bgj_5fdec1fab141 exited' });
    await say(api, b, wake, 2, RunEventType.USER, { text: 'background job bgj_5fdec1fab141 exited' });
    await say(api, b, wake, 3, RunEventType.ASSISTANT, { text: 'the job finished; carrying on' });

    const answer = await complete(api, b, wake);
    assert.deepEqual(answer, { ok: true, status: RunStatus.RUNNING },
      'the completion goes through, and the session carries on into the acceptance rounds');

    const after = await row(wake);
    assert.equal(after.status, 'ANSWERED', 'the wake is answered, and no longer IN_FLIGHT');
    assert.ok(after.answered_at instanceof Date);
    const rounds = await acceptanceRounds(b.sessionId);
    assert.deepEqual(
      rounds.map(({ id, client_turn_id, status }) => ({ id, client_turn_id, status })),
      [
        { id: openingRound, client_turn_id: acceptanceKey(opening), status: 'PENDING' },
        { id: wakeRound, client_turn_id: acceptanceKey(wake), status: 'PENDING' },
      ],
      'one round per answered message turn — the one already queued for the wake is its round, '
        + 'not a reason to fail the completion or to queue another');

    // The first round is what the inbox hands out next: the task moves again.
    const next = await poll(api, b);
    assert.equal(next?.turnId, openingRound);
    assert.equal(next?.kind, 'shell');
    assert.equal(next?.taskAcceptance, true);
  });
});
