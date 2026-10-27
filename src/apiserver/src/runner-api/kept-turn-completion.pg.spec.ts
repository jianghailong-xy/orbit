/**
 * A TURN WHOSE ENGINE FINISHED IT IS NOT HANDED TO AN ENGINE AGAIN BECAUSE ITS RUNNER STOPPED FIRST.
 *
 * On 2026-10-27 the C1a rollback drill ran a finished turn twice. Its runner (process P1) stopped with the link gateway
 * down and HTTPS refused, so the turn's completion never reached the control plane while the turn's events, its
 * turn_end among them, waited in P1's spool. The next process (P2) took the session over and stored those events, but
 * the turn was still IN_FLIGHT, its lease expired by the takeover, so the inbox handed it back with a resume
 * continuation and the engine answered a second time (task 34mwBTpOPo3S9LM2SXs10).
 *
 * The runner now keeps each completion on disk until the control plane answers it, and P2 sends what P1 kept after the
 * spool's events and before its first inbox fetch, under its own lease (runner-go turn_complete_journal.go). Nothing on
 * the server changed for it; this file pins the server half it relies on, through the runner door's own handlers:
 *
 *   (1) After takeover-leases, P2's completion of the turn P1 was handed is taken: the turn is ANSWERED, the session
 *       parks, and P2's first fetch is handed nothing. The turn has its one turn_end and no resume continuation.
 *   (2) The same completion sent again — P1's answer was lost, so P2 sends what it kept — changes nothing: the turn keeps
 *       its answered_at, and its cost and turns are booked once.
 *   (3) With nothing kept (P1 killed before its engine finished the turn), P2's first fetch hands the turn back with its
 *       resume continuation, as before: delivery stays at least once.
 *
 *     bash scripts/run-pg-spec.sh src/apiserver/src/runner-api/kept-turn-completion.pg.spec.ts
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

/** What the inbox writes in place of a message handed out again once its runtime had started (resume-continuation.ts). */
const CONTINUATION = '[Orbit] The last message you were working on was interrupted because its runner restarted';

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
      { expand: async (_ownerId: string, content?: string) => content } as never,
      { appendFor: async (_tx: unknown, _sessionId: string, content?: string) => content } as never,
    ),
  };
}

/** The statement a runner's inbox fetch runs, under a lease generation. Null is a fetch handed nothing. */
function fetchTurn(api: RunnerApiController, runnerId: string, sessionId: string, generation: string): Promise<RunInboxResponse | null> {
  return (
    api as unknown as {
      dequeueTurn: (sessionId: string, runnerId: string, leaseGeneration: string | null) => Promise<RunInboxResponse | null>;
    }
  ).dequeueTurn.call(api, sessionId, runnerId, generation);
}

interface Delivered {
  runnerId: string;
  sessionId: string;
  turnId: string;
  /** P1, the process the turn was handed to. */
  p1: string;
}

test('a turn completion kept across a runner restart settles the turn, and no fetch hands it to an engine again', {
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

  /**
   * One owner, one runner and a claimed session whose message P1 took over, fetched and ran: its engine answered and
   * ended the turn, and the events said so went through the real ingest. P1's completion never came.
   */
  async function deliveredToP1(label: string): Promise<Delivered> {
    const ownerId = randomUUID();
    const runnerId = randomUUID();
    const workspaceId = randomUUID();
    const sessionId = randomUUID();
    await db.user.create({
      data: { id: ownerId, email: `${label}-${ownerId}@kept-completion.invalid`, name: 'The account owner', passwordHash: 'x' },
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
    await db.workspace.create({ data: { id: workspaceId, ownerId, runnerId, name: `${label}-workspace`, enabled: true } });
    await db.session.create({
      data: {
        id: sessionId,
        ownerId,
        creatorId: ownerId,
        workspaceId,
        assignedRunnerId: runnerId,
        title: `${label}: a session whose runner stops mid-answer`,
        prompt: 'stream the drill ticks',
        provider: 'claude',
        status: RunStatus.RUNNING,
        dispatchOrigin: SessionDispatchOrigin.USER,
        startedAt: new Date(),
        runtimeSessionId: randomUUID(),
      },
    });
    const queued = await db.conversationTurn.create({
      data: { sessionId, seq: 1, clientTurnId: `${label}-${randomUUID()}`, kind: 'message', content: 'stream the drill ticks', status: 'PENDING' },
      select: { id: true },
    });
    const runner = { id: runnerId };
    const p1 = randomUUID();
    const g1 = randomUUID();
    await api.takeoverLeases(runner, sessionId, { leaseOwner: p1, expectedLeaseOwner: null } as never);
    await api.activateLeases(runner, sessionId, { leaseGeneration: g1, leaseOwner: p1 } as never);
    const handed = await fetchTurn(api, runnerId, sessionId, g1);
    assert.equal(handed?.turnId, queued.id, 'the fixture: P1 is handed the person\'s message');
    assert.equal(handed?.content, 'stream the drill ticks', 'the fixture: the first delivery carries the person\'s words');
    await api.events(runner, sessionId, {
      leaseOwner: p1,
      events: [
        { seq: 1, type: RunEventType.USER, ts: new Date().toISOString(), turnId: queued.id, payload: { text: 'stream the drill ticks' } },
        { seq: 2, type: RunEventType.ASSISTANT, ts: new Date().toISOString(), turnId: queued.id, payload: { text: 'tick 1' } },
        { seq: 3, type: RunEventType.ASSISTANT, ts: new Date().toISOString(), turnId: queued.id, payload: { text: 'tick 2' } },
        { seq: 4, type: RunEventType.TURN_END, ts: new Date().toISOString(), turnId: queued.id, payload: { subtype: 'success', numTurns: 1 } },
      ],
    } as never);
    return { runnerId, sessionId, turnId: queued.id, p1 };
  }

  /** P2 takes the session over from P1, as the startup reclaim does, and returns P2. */
  async function takenOverByP2(d: Delivered): Promise<string> {
    const p2 = randomUUID();
    await api.takeoverLeases({ id: d.runnerId }, d.sessionId, { leaseOwner: p2, expectedLeaseOwner: d.p1 } as never);
    return p2;
  }

  /** Read back over a second connection, never through the answer that wrote it. */
  async function turnRow(turnId: string) {
    const r = await sql.query(
      `SELECT status, answered_at, lease_deadline_at < now() AS "leaseExpired" FROM "conversation_turn" WHERE id = $1::uuid`,
      [turnId],
    );
    return r.rows[0] as { status: string; answered_at: Date | null; leaseExpired: boolean | null };
  }
  async function sessionRow(sessionId: string) {
    const r = await sql.query(`SELECT status, cost_usd::float AS "costUsd", num_turns AS "numTurns" FROM "session" WHERE id = $1::uuid`, [sessionId]);
    return r.rows[0] as { status: string; costUsd: number; numTurns: number };
  }
  async function turnRows(sessionId: string, turnId: string) {
    const r = await sql.query(
      `SELECT count(*) FILTER (WHERE type = 'turn_end')::int AS "turnEnds",
              count(*) FILTER (WHERE type = 'user' AND payload::text LIKE '%interrupted because its runner restarted%')::int AS "continuations"
         FROM "run_event" WHERE session_id = $1::uuid AND turn_id = $2::uuid`,
      [sessionId, turnId],
    );
    return r.rows[0] as { turnEnds: number; continuations: number };
  }

  /** What P1's supervisor wrote to disk before it could send it, and P2 sends: the completion of the turn P1 ran. */
  const kept = (turnId: string, leaseOwner: string) => ({
    turnId,
    leaseOwner,
    status: SharedRunStatus.SUCCEEDED,
    result: 'tick 2',
    subtype: 'success',
    numTurns: 1,
    costUsd: 0.25,
  });

  let settled: Delivered & { p2: string; answeredAt: Date | null; costUsd: number; numTurns: number };

  await t.test('(1) after the takeover, the next process\'s kept completion settles the turn, and its first fetch is handed nothing', async () => {
    const d = await deliveredToP1('kept');
    const p2 = await takenOverByP2(d);
    const before = await turnRow(d.turnId);
    assert.equal(before.status, 'IN_FLIGHT', 'the fixture: the turn P1 ran is still in flight');
    assert.equal(before.leaseExpired, true, 'the fixture: the takeover expired its lease, so a fetch would hand it out again');

    const answer = await api.turnComplete({ id: d.runnerId }, d.sessionId, kept(d.turnId, p2) as never);
    assert.equal((answer as { status?: string }).status, RunStatus.AWAITING_INPUT, 'the session did not park on the kept completion');

    const after = await turnRow(d.turnId);
    assert.equal(after.status, 'ANSWERED', 'the next process\'s completion of the turn P1 ran was not taken');
    assert.notEqual(after.answered_at, null);
    const session = await sessionRow(d.sessionId);
    assert.equal(session.status, RunStatus.AWAITING_INPUT);

    const g2 = randomUUID();
    await api.activateLeases({ id: d.runnerId }, d.sessionId, { leaseGeneration: g2, leaseOwner: p2 } as never);
    assert.equal(await fetchTurn(api, d.runnerId, d.sessionId, g2), null,
      'the next process\'s first fetch was handed something: the turn its engine finished, again');
    assert.deepEqual(await turnRows(d.sessionId, d.turnId), { turnEnds: 1, continuations: 0 },
      'the turn has its own turn_end and no resume continuation');
    settled = { ...d, p2, answeredAt: after.answered_at, costUsd: session.costUsd, numTurns: session.numTurns };
  });

  await t.test('(2) the same completion sent again changes nothing: answered once, booked once', async () => {
    assert.ok(settled, 'needs (1)');
    await api.turnComplete({ id: settled.runnerId }, settled.sessionId, kept(settled.turnId, settled.p2) as never);
    const after = await turnRow(settled.turnId);
    assert.equal(after.status, 'ANSWERED');
    assert.equal(after.answered_at?.toISOString(), settled.answeredAt?.toISOString(), 'a completion sent again answered the turn a second time');
    const session = await sessionRow(settled.sessionId);
    assert.equal(session.costUsd, settled.costUsd, 'a completion sent again booked its cost twice');
    assert.equal(session.numTurns, settled.numTurns, 'a completion sent again counted its turn twice');
    assert.equal(session.status, RunStatus.AWAITING_INPUT);
  });

  await t.test('(3) with nothing kept, the next process\'s first fetch hands the turn back with its resume continuation, as before', async () => {
    const d = await deliveredToP1('lost');
    const p2 = await takenOverByP2(d);
    const g2 = randomUUID();
    await api.activateLeases({ id: d.runnerId }, d.sessionId, { leaseGeneration: g2, leaseOwner: p2 } as never);
    const handed = await fetchTurn(api, d.runnerId, d.sessionId, g2);
    assert.equal(handed?.turnId, d.turnId, 'the turn whose completion was lost with P1 was not handed out again');
    assert.ok(handed?.content?.startsWith(CONTINUATION), `the turn went back without its resume continuation: ${handed?.content}`);
    assert.equal((await turnRow(d.turnId)).status, 'IN_FLIGHT');
  });
});
