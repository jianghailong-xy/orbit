/**
 * THE ROLLING RECAP'S SETTLE WIRING, OVER A REAL POSTGRESQL.
 *
 * `recap.ts` writes one line about a session and is tested on its own; this file is about WHEN it
 * is asked to, which is the half a wrong hook makes wrong in production and a right one makes
 * invisible:
 *
 *   * A completed turn asks for a pass — through `recapDue`, so a settle inside the two-minute
 *     window reaches no provider at all, and through the real /turn-complete door, so the envelope
 *     is what would run in production rather than a call to the hook by name.
 *   * The session's LAST settle asks unconditionally: `RealtimeService.publish`'s `final` STATUS
 *     is the one event every finalization emits (the runner's /finalize, /turn-complete's failure,
 *     the reaper's forceFinalize, a spent retry), so a session that ends inside the window still
 *     gets the recap it keeps. Case (4) is that difference on one session: the same fresh
 *     `recapAt` that throttles the turn-complete does not stop the finalize.
 *   * `POST /sessions/:id/recap` is a person asking. `force` ignores the window, the owner gate
 *     still holds, and the answer is the pass's own outcome.
 *
 * THE PROPERTY THE WHOLE FEATURE RESTS ON is that the settle path does not wait for the model, and
 * every case here pins it without a stopwatch: the provider is PARKED — it accepts the request and
 * answers only when the test lets it — and the settle's own response is asserted to have returned
 * while the pass is still holding that connection. Whatever the provider then does (answer, 4xx,
 * or never what the pass can use), the settle has already answered the runner. The generator's own
 * `recap.spec.ts` bounds the timeout; this file is about the settle in front of it.
 *
 *     bash scripts/run-pg-spec.sh src/apiserver/src/sessions/recap-settle.pg.spec.ts
 *
 * Not destructive: every id is freshly generated and every assertion is scoped to the rows it made.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { PrismaClient, RunStatus, RunnerStatus, SessionDispatchOrigin } from '@prisma/client';
import { RunEventType, RunStatus as SharedRunStatus } from '@orbit/shared';
import { Client } from 'pg';

import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import type { PushService } from '../push/push.service';
import type { QueueService } from '../queue/queue.service';
import { RealtimeService } from '../realtime/realtime.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { RunnerApiController } from '../runner-api/runner-api.controller';
import { SessionsService } from './sessions.service';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

/** The production wiring for the doors under test, over one client and with no seam in them. */
function connect(url: string) {
  const db = prismaClientFor(url);
  const prisma = db as unknown as PrismaService;
  const push = {
    scheduleBadgeSync: () => undefined,
    notifySessionSettled: async () => undefined,
  } as unknown as PushService;
  // The real one, not a proxy: the last settle's recap is enqueued from inside `publish`, so the
  // `/finalize` case exercises that branch exactly as production does — NOTIFY and all.
  const realtime = new RealtimeService(prisma, push);
  const queue = { notifySessionQueued: () => undefined } as unknown as QueueService;
  return {
    db,
    realtime,
    sessions: new SessionsService(prisma, queue, realtime),
    api: new RunnerApiController(
      prisma,
      queue,
      realtime,
      {} as never,
      {} as never,
      // #references are expanded on the way out of the inbox; this spec is about a settle, not
      // about what is written into the message that carries it.
      { expand: async (_ownerId: string, content?: string) => content } as never,
      { appendFor: async (_tx: unknown, _sessionId: string, content?: string) => content } as never,
    ),
  };
}

interface Fixture {
  ownerId: string;
  runnerId: string;
  sessionId: string;
  /** The turn the runner is executing — the one whose completion settles the turn. */
  turnId: string;
}

/** One owner, one runner, and a session RUNNING with a turn out on delivery. */
async function fixture(
  db: PrismaClient,
  label: string,
  recap: { recapText?: string; recapAt?: Date; recapEventSeq?: number } = {},
): Promise<Fixture> {
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  const sessionId = randomUUID();
  await db.user.create({
    data: {
      id: ownerId,
      email: `${label}-${ownerId}@recap-settle.invalid`,
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
      title: `${label}`,
      prompt: 'fix the login flow',
      provider: 'claude',
      status: RunStatus.RUNNING,
      engineTurnActive: true,
      dispatchOrigin: SessionDispatchOrigin.USER,
      startedAt: new Date(),
      runtimeSessionId: randomUUID(),
      ...(recap.recapText !== undefined ? { recapText: recap.recapText } : {}),
      ...(recap.recapAt !== undefined ? { recapAt: recap.recapAt } : {}),
      ...(recap.recapEventSeq !== undefined ? { recapEventSeq: recap.recapEventSeq } : {}),
    },
  });
  const turn = await db.conversationTurn.create({
    data: {
      sessionId,
      seq: 1,
      clientTurnId: `${label}-${randomUUID()}`,
      kind: 'message',
      content: 'fix the login flow',
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

/** The completion a turn's runner reports for a turn its engine answered. */
const TURN_SUCCEEDED = {
  status: SharedRunStatus.SUCCEEDED,
  subtype: 'success',
  numTurns: 1,
  costUsd: 0.01,
} as const;

function textResponse(content: string): Response {
  return { ok: true, json: async () => ({ choices: [{ message: { content } }] }) } as Response;
}

function fourOhOh(): Response {
  return { ok: false, body: { cancel: async () => undefined } } as unknown as Response;
}

/**
 * A provider whose first attempt is parked and whose retries refuse outright: the failure path,
 * with the first attempt still holding the connection when the settle answers.
 */
function failingProvider(): { calls: number; answered: boolean; release: () => void } {
  const state = { calls: 0, answered: false };
  let release: (() => void) | null = null;
  globalThis.fetch = (() => {
    state.calls += 1;
    if (state.calls === 1) {
      return new Promise<Response>((resolve) => {
        release = () => {
          state.answered = true;
          resolve(fourOhOh());
        };
      });
    }
    return Promise.resolve(fourOhOh());
  }) as unknown as typeof fetch;
  return {
    get calls() {
      return state.calls;
    },
    get answered() {
      return state.answered;
    },
    release: () => release?.(),
  };
}

/**
 * The pass a settle asked for, counted once it has reached the provider. Both hooks are
 * fire-and-forget, so the settle answers FIRST and the request goes out just after it — a test
 * that looked for the provider call before this point would be racing the hook, not testing it.
 */
function passedThrough(provider: { calls: number }): Promise<number | null> {
  return until(async () => (provider.calls >= 1 ? provider.calls : null), 20_000);
}

/**
 * A provider a pass reaches and gets no answer out of until the test lets it go: `calls` says how
 * many requests it holds, and `answered` only turns true when the test releases one. A settle that
 * waited for its recap could not come back while one of these is unanswered.
 */
function parkedProvider(): { calls: number; answered: boolean; release: (text: string) => void } {
  const state = { calls: 0, answered: false };
  let release: ((r: Response) => void) | null = null;
  globalThis.fetch = (() => {
    state.calls += 1;
    return new Promise<Response>((resolve) => {
      release = (r) => {
        state.answered = true;
        resolve(r);
      };
    });
  }) as unknown as typeof fetch;
  return {
    get calls() {
      return state.calls;
    },
    get answered() {
      return state.answered;
    },
    release: (text: string) => release?.(textResponse(text)),
  };
}

/** The recap as a row — read over a second connection, never through the pass that wrote it. */
async function recapRow(sql: Client, sessionId: string) {
  const r = await sql.query(
    `SELECT recap_text, recap_at, recap_event_seq FROM "session" WHERE id = $1::uuid`,
    [sessionId],
  );
  return r.rows[0] as { recap_text: string | null; recap_at: Date | null; recap_event_seq: number | null };
}

/** Poll `check` until it answers something, or the deadline passes and it answers null. */
async function until<T>(check: () => Promise<T | null>, ms = 20_000): Promise<T | null> {
  const deadline = Date.now() + ms;
  for (;;) {
    const hit = await check();
    if (hit !== null) return hit;
    if (Date.now() > deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** The session's recap, once its cursor has reached `seq` — i.e. once the released pass wrote. */
function recapped(sql: Client, sessionId: string, seq: number) {
  return until(async () => {
    const row = await recapRow(sql, sessionId);
    return row.recap_event_seq === seq ? row : null;
  });
}

test('the settle hooks write the recap, and only on the terms they promise', {
  skip, concurrency: 1, timeout: 300_000,
}, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const { db, api, sessions } = connect(url);

  // Every pass spends the server's own key, which is what the settle hooks resolve to on a
  // deployment that has one; the provider behind it is answered by this file, never by the network.
  const originalKey = process.env.DEEPSEEK_API_KEY;
  const originalFetch = globalThis.fetch;
  process.env.DEEPSEEK_API_KEY = 'recap-settle-spec';
  t.after(async () => {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = originalKey;
    await db.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });

  await t.test('(1) a completed turn recaps what it just committed, and the cursor covers it', async () => {
    const f = await fixture(db, 'turn');
    const provider = parkedProvider();
    await say(api, f, 1, RunEventType.USER, { text: 'fix the login flow' });
    await say(api, f, 2, RunEventType.ASSISTANT, { text: 'The redirect lost its cookie.' });
    await say(api, f, 3, RunEventType.TOOL_USE, { name: 'Edit', input: { file: 'login.ts' } });
    await say(api, f, 4, RunEventType.ASSISTANT, { text: 'The suite passes now.' });
    // A settled stream carries events a recap never reads. The cursor must name the last event the
    // RECAP covers, not the last row the settle happened to leave behind.
    await say(api, f, 5, RunEventType.STATUS, { status: 'AWAITING_INPUT' });

    await api.turnComplete({ id: f.runnerId }, f.sessionId, { turnId: f.turnId, ...TURN_SUCCEEDED });

    // The settle is back — it had to be, this line ran — and the pass it asked for is on the wire,
    // parked on a provider that answers only when this test says so. A hook the settle waited for
    // would still be holding the response here instead.
    assert.equal(await passedThrough(provider), 1, 'the completed turn asked for a pass');
    assert.equal(provider.answered, false, 'and the settle answered while that pass was unanswered');
    const before = await recapRow(sql, f.sessionId);
    assert.equal(before.recap_event_seq, null, 'nothing is written until the model answers');

    provider.release('Fixed the login flow; tests pass. Next: ship it.');
    const row = await recapped(sql, f.sessionId, 4);
    assert.ok(row, 'the queued pass lands on its own, after the settle has answered');
    assert.equal(row.recap_text, 'Fixed the login flow; tests pass. Next: ship it.');
    assert.ok(row.recap_at instanceof Date, 'and it is stamped when it was written');
    assert.equal(row.recap_event_seq, 4, 'the cursor is the seq of the last event the recap covers');
  });

  await t.test('(2) a second settle inside the two-minute window asks nobody', async () => {
    // As a session recapped a minute ago reads: a fresh recap and the cursor it left.
    const f = await fixture(db, 'throttled', {
      recapText: 'Earlier: the redirect lost its cookie.',
      recapAt: new Date(Date.now() - 60_000),
      recapEventSeq: 2,
    });
    const provider = parkedProvider();
    // The first two events are the ones the recap that is already there covers; 3 and 4 are what
    // this settle would have folded in.
    await say(api, f, 1, RunEventType.USER, { text: 'fix the login flow' });
    await say(api, f, 2, RunEventType.ASSISTANT, { text: 'The redirect lost its cookie.' });
    await say(api, f, 3, RunEventType.USER, { text: 'and the tests?' });
    await say(api, f, 4, RunEventType.ASSISTANT, { text: 'Green.' });

    await api.turnComplete({ id: f.runnerId }, f.sessionId, { turnId: f.turnId, ...TURN_SUCCEEDED });

    // The due check is the throttle's whole body: it is read BEFORE anything is queued, so a
    // settle inside the window costs two reads and no provider call at all. The wait is only long
    // enough for a pass that WAS queued to have reached the parked provider.
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(provider.calls, 0, 'a throttled settle reaches no provider');
    const row = await recapRow(sql, f.sessionId);
    assert.equal(row.recap_text, 'Earlier: the redirect lost its cookie.', 'and rewrites nothing');
    assert.equal(row.recap_event_seq, 2);
  });

  await t.test('(3) a provider that fails delays nothing and is never written', async () => {
    const f = await fixture(db, 'failing');
    const provider = failingProvider();
    await say(api, f, 1, RunEventType.USER, { text: 'fix the login flow' });
    await say(api, f, 2, RunEventType.ASSISTANT, { text: 'Looking at it.' });
    await say(api, f, 3, RunEventType.ASSISTANT, { text: 'Still looking.' });
    await say(api, f, 4, RunEventType.ASSISTANT, { text: 'Nothing yet.' });

    await api.turnComplete({ id: f.runnerId }, f.sessionId, { turnId: f.turnId, ...TURN_SUCCEEDED });
    assert.equal(await passedThrough(provider), 1, 'the settle answered while the provider held on');
    assert.equal(provider.answered, false, 'the request was still unanswered when it did');

    // Let it fail: the retries are the pass's own, and they are its whole cost to the settle.
    provider.release();
    const spent = await until(async () => (provider.calls === 4 ? true : null), 20_000);
    assert.equal(spent, true, 'the pass retried to its own limit and gave up');
    const row = await recapRow(sql, f.sessionId);
    assert.equal(row.recap_text, null, 'a provider that failed writes nothing');
    assert.equal(row.recap_at, null);
    assert.equal(row.recap_event_seq, null);
  });

  await t.test('(4) the last settle recaps inside the window, where a turn-complete does not', async () => {
    const f = await fixture(db, 'finalize', {
      recapText: 'Earlier: the redirect lost its cookie.',
      recapAt: new Date(Date.now() - 60_000),
      recapEventSeq: 2,
    });
    const provider = parkedProvider();
    await say(api, f, 1, RunEventType.USER, { text: 'fix the login flow' });
    await say(api, f, 2, RunEventType.ASSISTANT, { text: 'The redirect lost its cookie.' });
    await say(api, f, 3, RunEventType.USER, { text: 'and the tests?' });
    await say(api, f, 4, RunEventType.ASSISTANT, { text: 'Green.' });

    const seeded = await recapRow(sql, f.sessionId);
    assert.equal(seeded.recap_event_seq, 2, 'the session reads as one recapped a minute ago');

    await api.turnComplete({ id: f.runnerId }, f.sessionId, { turnId: f.turnId, ...TURN_SUCCEEDED });
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(provider.calls, 0, 'the window still holds for a turn that is not the last');

    // The session ends inside that same window. `finalize` publishes the one `final` STATUS every
    // ending emits, and THAT is where the recap that the session keeps is asked for.
    const finalized = await api.finalize({ id: f.runnerId }, f.sessionId, {
      status: SharedRunStatus.SUCCEEDED,
      subtype: 'success',
      numTurns: 1,
      costUsd: 0.01,
    });
    assert.equal(finalized.ok, true);
    assert.equal(await passedThrough(provider), 1, 'the finalization asked for its pass');
    assert.equal(provider.answered, false, 'and answered before that pass was answered either');

    provider.release('Fixed the login flow; the suite passes.');
    const row = await recapped(sql, f.sessionId, 4);
    assert.ok(row, 'and the pass lands after the finalize has answered');
    assert.equal(row.recap_text, 'Fixed the login flow; the suite passes.');
    assert.equal(row.recap_event_seq, 4, 'covering the events the throttled turn-complete left behind');
    // Two reads over the same connection, so this compares the two stamps and not the database's
    // clock with this process's.
    assert.ok(
      row.recap_at!.getTime() > seeded.recap_at!.getTime(),
      'and stamped when it was actually written, not when the recap it replaces was',
    );
  });

  await t.test('(5) POST /sessions/:id/recap forces a pass on the owner\'s own session', async () => {
    const f = await fixture(db, 'manual', {
      recapText: 'Earlier: the redirect lost its cookie.',
      recapAt: new Date(Date.now() - 60_000),
      recapEventSeq: 2,
    });
    const provider = parkedProvider();
    await say(api, f, 1, RunEventType.USER, { text: 'fix the login flow' });
    await say(api, f, 2, RunEventType.ASSISTANT, { text: 'The redirect lost its cookie.' });
    await say(api, f, 3, RunEventType.USER, { text: 'and the tests?' });
    await say(api, f, 4, RunEventType.ASSISTANT, { text: 'Green.' });

    // Somebody else's id reaches no session of theirs, and is told so rather than served the recap.
    await assert.rejects(
      () => sessions.refreshRecap(randomUUID(), f.sessionId),
      /session not found/,
      'the door is the owner\'s, and it is refused before any pass is queued',
    );
    assert.equal(provider.calls, 0);

    const answered = sessions.refreshRecap(f.ownerId, f.sessionId);
    assert.equal(await passedThrough(provider), 1, 'the window does not stop a person asking');
    assert.equal(provider.answered, false, 'and this door WAITS for the pass it asked for');
    provider.release('Refreshed by hand: tests pass.');
    const outcome = await answered;
    assert.deepEqual(outcome, {
      written: true,
      recapText: 'Refreshed by hand: tests pass.',
      recapEventSeq: 4,
    });
    const row = await recapRow(sql, f.sessionId);
    assert.equal(row.recap_text, 'Refreshed by hand: tests pass.');
    assert.equal(row.recap_event_seq, 4, 'and the cursor moves to what this pass covered');
  });
});
