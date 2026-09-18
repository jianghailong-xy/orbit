/**
 * A TURN IS ANSWERED BECAUSE SOMETHING ANSWERED IT — NOT BECAUSE THE ENGINE STOPPED.
 *
 * On 2026-09-17 a session's opening question was consumed by nothing. The engine was spawned with
 * `--resume` on a conversation that had never been opened, printed `No conversation found with
 * session ID`, and the turn came back through /turn-complete as `error_during_execution` with
 * numTurns 0 and costUsd 0. The control plane wrote `status = ANSWERED`, `answered_at =
 * 18:00:16.983` onto the person's turn — and with it the two PNGs hanging off that row — and the
 * question was never delivered again. ANSWERED meant "the engine stopped", where it has to mean
 * "there is an answer".
 *
 * WHY THIS FILE REFUSES TO NAME A FAILURE SUBTYPE
 * ----------------------------------------------
 * The code this replaces is the enumerating kind: `runner-go/session.go` carries a special case for
 * a Claude API error and one for an expired sign-in, whose own comment admits they "slip past
 * resultFrom", and `finalize-failed-run.spec.ts` opens with the constants `QUOTA_ERROR` and
 * `SIGNED_OUT_ERROR`. `--resume` failing is only the next one nobody had enumerated yet. So every
 * case below is built so that the failure's NAME cannot explain it:
 *
 *   (1) The incident. No assistant event of any kind under the turn, and the completion says
 *       `error_during_execution` / numTurns 0 / costUsd 0. The turn must not be ANSWERED, and the
 *       real inbox — `dequeueTurn`, the statement the runner's poll runs — must hand it out again.
 *   (2) The reverse. The SAME completion body, byte for byte, over a turn the engine did speak in.
 *       It must be ANSWERED with its `answered_at` set, and the inbox must offer nothing. Whatever
 *       (1) rests on, it is not the subtype and not the counters: those are identical here.
 *   (3) An ordinary success. SUCCEEDED, numTurns 1, an assistant reply — ANSWERED, as always.
 *   (4) An interrupt. The person pressed stop before the engine had said anything, so there is no
 *       assistant text either. Re-delivering what somebody just stopped is the one outcome a
 *       requeue must never produce, so the turn stays ANSWERED and the inbox offers nothing.
 *   (5) A `!`-shell turn. It is answered by its exit code and never produces assistant text at all;
 *       it must not be dragged back into the queue by a rule about replies.
 *
 * (2) is what makes (1) a fact about the absent answer rather than about the words in the report.
 *
 *     bash scripts/run-pg-spec.sh src/apiserver/src/runner-api/turn-complete-unanswered.pg.spec.ts
 *
 * Not destructive: every id is freshly generated and every assertion is scoped to the rows it made.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { PrismaClient, RunStatus, RunnerStatus, SessionDispatchOrigin } from '@prisma/client';
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
import { RunnerApiController } from './runner-api.controller';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

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
  sessionId: string;
  /** The turn the runner is executing — the one the person is waiting on an answer to. */
  turnId: string;
}

/**
 * One owner, one runner, and a session RUNNING with a turn out on delivery.
 *
 * `inbox_lease_owner` is left null so the real turn-complete boundary's lease check passes with no
 * lease token, exactly as `abandoned-approvals.pg.spec.ts` builds it. The turn is IN_FLIGHT with
 * `delivered_at` and a live lease because that is what the inbox statement leaves behind when it
 * hands a turn to a runner; nothing here writes the state the assertions read.
 */
async function fixture(
  db: PrismaClient,
  label: string,
  kind: 'message' | 'shell' = 'message',
): Promise<Fixture> {
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  const sessionId = randomUUID();
  await db.user.create({
    data: {
      id: ownerId,
      email: `${label}-${ownerId}@unanswered.invalid`,
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
  await db.session.create({
    data: {
      id: sessionId,
      ownerId,
      creatorId: ownerId,
      workspaceId,
      assignedRunnerId: runnerId,
      title: `${label} 的会话`,
      prompt: '把这两张图里的报错讲清楚',
      provider: 'claude',
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
      kind,
      content: kind === 'shell' ? 'npm test' : '把这两张图里的报错讲清楚',
      status: 'IN_FLIGHT',
      deliveredAt: new Date(),
      leaseDeadlineAt: new Date(Date.now() + 300_000),
      leaseGeneration: randomUUID(),
    },
    select: { id: true },
  });
  return { ownerId, runnerId, sessionId, turnId: turn.id };
}

/** The transcript as the runner writes it: through the real ingest, not by hand. */
function say(
  api: RunnerApiController,
  f: Fixture,
  seq: number,
  type: RunEventType,
  payload: Record<string, unknown>,
) {
  return api.events({ id: f.runnerId }, f.sessionId, {
    events: [{ seq, type, ts: new Date().toISOString(), turnId: f.turnId, payload }],
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

/** What the incident's runner reported: the turn ended, and it ended saying nothing. */
const ENGINE_STOPPED = {
  status: SharedRunStatus.INTERRUPTED,
  subtype: 'error_during_execution',
  numTurns: 0,
  costUsd: 0,
} as const;

test('a turn nothing answered goes back in the queue instead of being marked ANSWERED', {
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
      `SELECT status, answered_at, delivered_at, lease_generation
         FROM "conversation_turn" WHERE id = $1::uuid`,
      [turnId],
    );
    return r.rows[0] as {
      status: string;
      answered_at: Date | null;
      delivered_at: Date | null;
      lease_generation: string | null;
    };
  }

  await t.test('(1) the incident: --resume failed, so nothing answered the person', async () => {
    const f = await fixture(db, 'incident');
    // The bubble the runner opens for the person's own message. It is the only thing under this
    // turn: the engine died before it could say a word.
    await say(api, f, 1, RunEventType.USER, { text: '把这两张图里的报错讲清楚' });
    // The two screenshots the question was sent with, in the incident's own sizes. They hang off
    // the turn, and nothing about them is remembered anywhere else: the delivery re-reads the row,
    // which is why a message that went back to the queue goes back out with what it was sent with.
    for (const [i, name] of ['27.png', '28.png'].entries()) {
      await db.attachment.create({
        data: {
          id: randomUUID(),
          ownerId: f.ownerId,
          sessionId: f.sessionId,
          turnId: f.turnId,
          fileName: name,
          mimeType: 'image/png',
          sizeBytes: 64,
          data: Buffer.from(`not a real image, attachment ${i + 1}`),
        },
      });
    }

    await api.turnComplete({ id: f.runnerId }, f.sessionId, { turnId: f.turnId, ...ENGINE_STOPPED });

    const after = await row(f.turnId);
    assert.notEqual(after.status, 'ANSWERED',
      'nothing answered this turn, so nothing may record it as answered');
    assert.equal(after.answered_at, null, 'and there is no moment at which it was answered');
    const offered = await poll(api, f);
    assert.equal(offered?.turnId, f.turnId,
      'the inbox hands the same turn out again — the question is still owed an answer');
    assert.equal(offered?.content, '把这两张图里的报错讲清楚',
      'and it is the person’s own words that go back to the engine, not a placeholder');
    assert.deepEqual(
      offered?.attachments?.map((a) => a.fileName),
      ['27.png', '28.png'],
      'the images the question was sent with are handed over again — the row they hang off is still the one owed an answer');
  });

  await t.test('(2) the same report over a turn the engine spoke in: ANSWERED', async () => {
    const f = await fixture(db, 'spoken');
    await say(api, f, 1, RunEventType.USER, { text: '把这两张图里的报错讲清楚' });
    await say(api, f, 2, RunEventType.ASSISTANT, { text: '两张图都是同一个 401。' });

    // Byte for byte the body case (1) sent. If the subtype or the counters were what decided
    // anything, this turn would go back in the queue too.
    await api.turnComplete({ id: f.runnerId }, f.sessionId, { turnId: f.turnId, ...ENGINE_STOPPED });

    const after = await row(f.turnId);
    assert.equal(after.status, 'ANSWERED', 'there is an answer under this turn, so it is answered');
    assert.ok(after.answered_at instanceof Date, 'and the moment it was answered is recorded');
    assert.equal(await poll(api, f), null, 'the inbox offers it to nobody');
  });

  await t.test('(3) an ordinary successful turn is still ANSWERED', async () => {
    const f = await fixture(db, 'ordinary');
    await say(api, f, 1, RunEventType.USER, { text: '把这两张图里的报错讲清楚' });
    await say(api, f, 2, RunEventType.ASSISTANT, { text: '两张图都是同一个 401。' });

    await api.turnComplete({ id: f.runnerId }, f.sessionId, {
      turnId: f.turnId,
      status: SharedRunStatus.SUCCEEDED,
      subtype: 'success',
      numTurns: 1,
      costUsd: 0.0123,
    });

    const after = await row(f.turnId);
    assert.equal(after.status, 'ANSWERED', 'the ordinary path is untouched');
    assert.ok(after.answered_at instanceof Date);
    assert.equal(await poll(api, f), null, 'and nothing is left queued behind it');
  });

  await t.test('(4) a turn the person stopped is not re-delivered', async () => {
    const f = await fixture(db, 'stopped');
    await say(api, f, 1, RunEventType.USER, { text: '把这两张图里的报错讲清楚' });
    // Stop pressed before the engine had said anything: there is no assistant text here either.
    // What separates this from (1) is that somebody asked for it to stop.
    await say(api, f, 2, RunEventType.INTERRUPT, { requestId: randomUUID() });

    await api.turnComplete({ id: f.runnerId }, f.sessionId, { turnId: f.turnId, ...ENGINE_STOPPED });

    const after = await row(f.turnId);
    assert.equal(after.status, 'ANSWERED',
      'a question somebody withdrew is not a question still owed an answer');
    assert.equal(await poll(api, f), null,
      're-running what the person just stopped is the one thing a requeue must never do');
  });

  await t.test('(5) a `!`-shell turn is answered by its exit code, not by a reply', async () => {
    const f = await fixture(db, 'shell', 'shell');
    // A shell turn runs on the runner. No engine speaks in it, ever.
    await api.turnComplete({ id: f.runnerId }, f.sessionId, {
      turnId: f.turnId,
      status: SharedRunStatus.SUCCEEDED,
      shellExitCode: 0,
      shellOutput: 'ok',
      numTurns: 0,
      costUsd: 0,
    });

    const after = await row(f.turnId);
    assert.equal(after.status, 'ANSWERED', 'a rule about replies must not strand a shell turn');
    assert.equal(await poll(api, f), null, 'and the queue is empty behind it');
  });

  await t.test('(6) a completion retried after the requeue does not bill twice', async () => {
    const f = await fixture(db, 'retried');
    await say(api, f, 1, RunEventType.USER, { text: '把这两张图里的报错讲清楚' });

    await api.turnComplete({ id: f.runnerId }, f.sessionId, {
      turnId: f.turnId, ...ENGINE_STOPPED, numTurns: 3,
    });
    const billed = await db.session.findUniqueOrThrow({
      where: { id: f.sessionId }, select: { numTurns: true },
    });
    assert.equal(billed.numTurns, 3, 'the first completion books what the runner reported');

    // The runner retries /turn-complete when the response is lost. The row it is about is no
    // longer out on a delivery, so the retry has nothing left to settle.
    await api.turnComplete({ id: f.runnerId }, f.sessionId, {
      turnId: f.turnId, ...ENGINE_STOPPED, numTurns: 3,
    });
    const after = await db.session.findUniqueOrThrow({
      where: { id: f.sessionId }, select: { numTurns: true },
    });
    assert.equal(after.numTurns, 3, 'and the retry books no second set of numbers');
  });
});
