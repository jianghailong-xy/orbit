/**
 * THE BATCH TAKEOVER ANSWERS EACH ROW AS THE SINGLE TAKEOVER DOES, IN ONE REQUEST.
 *
 * A restarted runner takes over every session its reclaim handed back. One request per session made a restart of a
 * machine with 339 sessions take three minutes (2026-11-13), so POST /runner/sessions/takeover-leases takes them over
 * in one request and one transaction. This file pins, through the runner door's own handlers:
 *
 *   (1) Every kind of row the single route answers — a first takeover, a takeover from the expected predecessor, a
 *       session this process already owns, a stale expected owner, a closed session, a pending worktree operation,
 *       a session of another runner of the same account and a session of another account — is answered by the batch
 *       with the same status or the same refusal, side by side in one call, and leaves the same rows behind: the
 *       lease owner, the retired predecessor generation, the expired in-flight turn and the reaped approval card.
 *   (2) 300 sessions taken over in one batch call, timed against 300 single calls on the same database.
 *
 *     bash scripts/run-pg-spec.sh src/apiserver/src/runner-api/batch-takeover.pg.spec.ts
 *
 * Not destructive: every id is freshly generated and every assertion is scoped to the rows it made.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { HttpException } from '@nestjs/common';
import { PrismaClient, RunStatus, RunnerStatus, SessionDispatchOrigin } from '@prisma/client';
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

/** A row's answer in the batch's own shape, whichever route gave it. */
type Answer = { status?: string; error?: { statusCode: number; message: string; code?: string } };

async function single(api: RunnerApiController, runner: { id: string; ownerId: string }, sessionId: string, leaseOwner: string, expected: string | null): Promise<Answer> {
  try {
    const answer = await api.takeoverLeases(runner, sessionId, { leaseOwner, expectedLeaseOwner: expected });
    return { status: answer.status };
  } catch (error) {
    if (!(error instanceof HttpException)) throw error;
    const body = error.getResponse();
    const message = typeof body === 'string' ? body : String((body as { message?: unknown }).message);
    const code = typeof body === 'object' ? (body as { code?: string }).code : undefined;
    return { error: { statusCode: error.getStatus(), message, ...(code ? { code } : {}) } };
  }
}

test('the batch takeover answers each row as the single takeover does, and takes 300 over in one call', {
  skip, concurrency: 1, timeout: 600_000,
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

  /** An account with a runner and a workspace on it. */
  async function account(label: string) {
    const ownerId = randomUUID();
    const runnerId = randomUUID();
    const otherRunnerId = randomUUID();
    const workspaceId = randomUUID();
    await db.user.create({ data: { id: ownerId, email: `${label}-${ownerId}@batch-takeover.invalid`, name: label, passwordHash: 'x' } });
    for (const id of [runnerId, otherRunnerId]) {
      await db.runner.create({
        data: {
          id, ownerId, name: `${label}-${id}`, tokenHash: `hash-${id}`, status: RunnerStatus.ONLINE,
          capabilities: [], capabilitiesReportedAt: new Date(), lastHeartbeatAt: new Date(),
        },
      });
    }
    await db.workspace.create({ data: { id: workspaceId, ownerId, runnerId, name: `${label}-workspace`, enabled: true } });
    return { ownerId, runnerId, otherRunnerId, workspaceId, runner: { id: runnerId, ownerId } };
  }
  type Account = Awaited<ReturnType<typeof account>>;

  async function session(of: Account, opts: {
    status?: RunStatus; owner?: string | null; generation?: string | null; runnerId?: string; pendingMerge?: boolean;
  } = {}): Promise<string> {
    const id = randomUUID();
    await db.session.create({
      data: {
        id, ownerId: of.ownerId, creatorId: of.ownerId, workspaceId: of.workspaceId,
        assignedRunnerId: opts.runnerId ?? of.runnerId, title: 'batch takeover', prompt: 'hi', provider: 'claude',
        status: opts.status ?? RunStatus.RUNNING, dispatchOrigin: SessionDispatchOrigin.USER, startedAt: new Date(),
        inboxLeaseOwner: opts.owner ?? null, inboxLeaseGeneration: opts.generation ?? null,
        ...(opts.pendingMerge ? { mergeStatus: 'pending', mergeOperationOwner: randomUUID(), mergeOperationId: randomUUID(), mergeRequestedAt: new Date() } : {}),
      },
    });
    if (opts.generation) {
      await db.inboxLeaseGeneration.create({ data: { generation: opts.generation, sessionId: id, leaseOwner: opts.owner ?? null } });
    }
    return id;
  }

  /** What a takeover leaves behind on a row, read over a second connection. */
  async function after(sessionId: string) {
    const s = await sql.query(
      `SELECT inbox_lease_owner AS owner, (inbox_lease_generation IS NOT NULL) AS "hasFence", engine_turn_active AS "engineTurnActive"
         FROM "session" WHERE id = $1::uuid`, [sessionId]);
    const g = await sql.query(
      `SELECT count(*) FILTER (WHERE retired_at IS NOT NULL)::int AS retired, count(*)::int AS generations
         FROM "inbox_lease_generation" WHERE session_id = $1::uuid`, [sessionId]);
    const turn = await sql.query(
      `SELECT bool_and(lease_deadline_at < now()) AS expired FROM "conversation_turn" WHERE session_id = $1::uuid AND status = 'IN_FLIGHT'`, [sessionId]);
    const cards = await sql.query(`SELECT status FROM "approval" WHERE session_id = $1::uuid ORDER BY id`, [sessionId]);
    return { ...s.rows[0], ...g.rows[0], turnExpired: turn.rows[0].expired, cards: cards.rows.map((r) => r.status) };
  }

  await t.test('(1) every row is answered and written as the single route answers and writes it', async () => {
    const mine = await account('mine');
    const stranger = await account('stranger');
    const process = randomUUID();
    const predecessor = randomUUID();

    /** One of each kind of row, built twice: once for the single route and once for the batch. */
    async function world() {
      const rows: Array<{ kind: string; sessionId: string; expected: string | null }> = [];
      const fresh = await session(mine);
      rows.push({ kind: 'never owned', sessionId: fresh, expected: null });
      const handed = await session(mine, { status: RunStatus.AWAITING_INPUT, owner: predecessor, generation: randomUUID() });
      // A predecessor's in-flight turn and pending card: the takeover expires the one and reaps the other.
      await db.conversationTurn.create({
        data: { sessionId: handed, seq: 1, clientTurnId: randomUUID(), kind: 'message', content: 'x', status: 'IN_FLIGHT', leaseDeadlineAt: new Date(Date.now() + 3_600_000) },
      });
      await db.approval.create({ data: { sessionId: handed, toolName: 'Bash', input: { command: 'ls' } } });
      rows.push({ kind: 'from the expected predecessor', sessionId: handed, expected: predecessor });
      rows.push({ kind: 'already this process', sessionId: await session(mine, { owner: process, generation: randomUUID() }), expected: predecessor });
      rows.push({ kind: 'stale expected owner', sessionId: await session(mine, { owner: randomUUID(), generation: randomUUID() }), expected: predecessor });
      rows.push({ kind: 'closed', sessionId: await session(mine, { status: RunStatus.SUCCEEDED, owner: predecessor }), expected: predecessor });
      rows.push({ kind: 'pending worktree operation', sessionId: await session(mine, { owner: predecessor, pendingMerge: true }), expected: predecessor });
      rows.push({ kind: 'another runner of the account', sessionId: await session(mine, { runnerId: mine.otherRunnerId }), expected: null });
      rows.push({ kind: 'another account', sessionId: await session(stranger), expected: null });
      rows.push({ kind: 'names nothing', sessionId: randomUUID(), expected: null });
      return rows;
    }

    const bySingle = await world();
    const byBatch = await world();
    const singleAnswers: Answer[] = [];
    for (const row of bySingle) singleAnswers.push(await single(api, mine.runner, row.sessionId, process, row.expected));
    const batch = await api.takeoverLeasesBatch(mine.runner, {
      leaseOwner: process,
      sessions: byBatch.map((row) => ({ sessionId: row.sessionId, expectedLeaseOwner: row.expected })),
    });

    assert.deepEqual(batch.results.map((r) => r.sessionId), byBatch.map((row) => row.sessionId), 'answered in request order');
    const label = (answers: Answer[], rows: typeof bySingle) => Object.fromEntries(rows.map((row, i) => [row.kind, {
      ...(answers[i].status ? { status: answers[i].status } : {}),
      ...(answers[i].error ? { error: answers[i].error } : {}),
    }]));
    const batchAnswers = batch.results.map(({ status, error }) => ({ status, error }));
    assert.deepEqual(label(batchAnswers, byBatch), label(singleAnswers, bySingle));

    // The answers are the ones each kind is owed, not merely the same twice.
    const got = label(batchAnswers, byBatch);
    assert.deepEqual(got['never owned'], { status: 'RUNNING' });
    assert.deepEqual(got['from the expected predecessor'], { status: 'AWAITING_INPUT' });
    assert.deepEqual(got['already this process'], { status: 'RUNNING' });
    assert.deepEqual(got['stale expected owner'], { error: { statusCode: 409, message: 'inbox lease owner changed; refresh the session snapshot' } });
    assert.deepEqual(got['closed'], { error: { statusCode: 409, message: 'session is no longer open' } });
    assert.deepEqual(got['pending worktree operation'], { error: { statusCode: 409, message: 'wait for the pending worktree operation to finish' } });
    assert.deepEqual(got['another runner of the account'], { error: { statusCode: 403, message: 'session does not belong to this runner' } });
    assert.deepEqual(got['another account'], { error: { statusCode: 403, message: 'session does not belong to this runner' } });

    // And each row is left as the single route leaves it.
    for (let i = 0; i < bySingle.length; i += 1) {
      if (bySingle[i].kind === 'names nothing') continue;
      const [s, b] = [await after(bySingle[i].sessionId), await after(byBatch[i].sessionId)];
      const shape = (r: Record<string, unknown>) => ({ ...r, owner: r.owner === process ? 'this process' : r.owner === predecessor ? 'predecessor' : r.owner ? 'another' : null });
      assert.deepEqual(shape(b), shape(s), `${bySingle[i].kind}: the rows the batch left`);
    }
    const handed = await after(byBatch[1].sessionId);
    assert.deepEqual(
      { owner: handed.owner, retired: handed.retired, turnExpired: handed.turnExpired, cards: handed.cards },
      { owner: process, retired: 1, turnExpired: true, cards: ['ABANDONED'] },
      'the fixture: the handed-over row did rotate, retire, expire and reap',
    );
    const refused = await after(byBatch[3].sessionId);
    assert.notEqual(refused.owner, process, 'the conflicted row kept its owner');
  });

  await t.test('(2) 300 sessions: one batch call against 300 single calls', async () => {
    const mine = await account('timing');
    const N = 300;
    const singles: string[] = [];
    const batched: string[] = [];
    for (let i = 0; i < N; i += 1) {
      singles.push(await session(mine, { owner: randomUUID(), generation: randomUUID() }));
      batched.push(await session(mine, { owner: randomUUID(), generation: randomUUID() }));
    }
    const expectedOf = async (ids: string[]) => {
      const r = await sql.query(`SELECT id, inbox_lease_owner AS owner FROM "session" WHERE id = ANY($1::uuid[])`, [ids]);
      return new Map(r.rows.map((row) => [row.id as string, row.owner as string]));
    };
    const singleExpected = await expectedOf(singles);
    const batchExpected = await expectedOf(batched);
    const process = randomUUID();

    const singleStart = performance.now();
    for (const id of singles) {
      await api.takeoverLeases(mine.runner, id, { leaseOwner: process, expectedLeaseOwner: singleExpected.get(id)! });
    }
    const singleMs = performance.now() - singleStart;

    const batchStart = performance.now();
    const answer = await api.takeoverLeasesBatch(mine.runner, {
      leaseOwner: process,
      sessions: batched.map((sessionId) => ({ sessionId, expectedLeaseOwner: batchExpected.get(sessionId)! })),
    });
    const batchMs = performance.now() - batchStart;

    assert.equal(answer.results.filter((r) => r.status === 'RUNNING').length, N, 'every row taken over');
    const owners = await sql.query(`SELECT count(*)::int AS n FROM "session" WHERE id = ANY($1::uuid[]) AND inbox_lease_owner = $2::uuid`, [[...singles, ...batched], process]);
    assert.equal(owners.rows[0].n, 2 * N);
    const line = `takeover of ${N} sessions: ${N} single calls ${singleMs.toFixed(0)} ms, one batch call ${batchMs.toFixed(0)} ms (${(singleMs / batchMs).toFixed(1)}x)`;
    t.diagnostic(line);
    console.log(`# TIMING ${line}`);
    assert.ok(batchMs < singleMs, line);
  });
});
