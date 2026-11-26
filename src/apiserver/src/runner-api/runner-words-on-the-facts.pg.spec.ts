/**
 * THE RUNNER API ON THE FACTS: RUNNERS ARE ANSWERED TODAY'S WORDS (task T8 of docs/session-status-retirement-plan.md,
 * §2.3 and §3.2).
 *
 * The runner API no longer reads `session.status`: it reads the turn state (`turn_state`, through
 * sessions/session-turn-state.ts) and answers runners the projector's word (sessions/session-legacy-words.ts). A held row the backfill (task T3) has not
 * reached has no turn state, and reads its stored word's. This file pins, through the runner door's own handlers, for
 * every held word, both with its turn state (as the D1 trigger keeps it) and without one (as a row not written since
 * migration 1611 has it):
 *
 *   (1) the reclaim answers every held session with its stored word
 *   (2) the single and the batch takeover answer the stored word, on a first takeover and on one this process owns
 *   (3) a turn-complete that settles nothing answers the stored word; on a released row of every shape it answers the
 *       projector's word, which is the stored word but for the kinds of the plan's §3.4 (the golden names them)
 *   (4) the runner-driven writers find the rows they found on the word: a turn completing on a RUNNING session parks
 *       it, a finalize releases a parked one, and each writes the turn state beside the word
 *   (5) the runner link's claim and inbox hints name the sessions they named on the word
 *
 *     bash scripts/run-pg-spec.sh src/apiserver/src/runner-api/runner-words-on-the-facts.pg.spec.ts
 *
 * Not destructive: every id is freshly generated and every assertion is scoped to the rows it made.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { PrismaClient, RunnerStatus, SessionDispatchOrigin } from '@prisma/client';
import { RunEventType, RunStatus } from '@orbit/shared';
import { Client } from 'pg';

import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import type { QueueService } from '../queue/queue.service';
import type { RealtimeService } from '../realtime/realtime.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { WORD_SHAPES } from '../sessions/session-legacy-words.fixture';
import { RunnerApiController } from './runner-api.controller';
import { readRunnerLinkHints } from './runner-link-hints';
import { ALLOW_UNFILLED_SESSIONS } from '../test-support/unfilled-sessions';
import { turnStateOfWord } from '../sessions/session-turn-state';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

const HELD_WORDS = [RunStatus.PENDING, RunStatus.RUNNING, RunStatus.AWAITING_INPUT, RunStatus.INTERRUPTED] as const;
const FILLS = ['filled', 'unfilled'] as const;
type Fill = (typeof FILLS)[number];

const GOLDEN = path.resolve(__dirname, '../../../../src/apiserver/src/sessions/session-legacy-words.golden.json');
const golden = JSON.parse(readFileSync(GOLDEN, 'utf8')) as {
  rows: Array<{ shape: string; stored: string; word: string; kind?: string }>;
};

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
      // The reclaim hands an orchestration credential to a session that may orchestrate.
      { issue: async () => 'orchestration-token' } as never,
      { expand: async (_ownerId: string, content?: string) => content } as never,
      { appendFor: async (_tx: unknown, _sessionId: string, content?: string) => content } as never,
    ),
  };
}

test('the runner API answers runners today\'s words from the facts', { skip, concurrency: 1, timeout: 600_000 }, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  await sql.query(ALLOW_UNFILLED_SESSIONS);
  const { db, api } = connect(url);
  t.after(async () => {
    await db.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });

  /** An account with a runner and a workspace on it; a runner of its own for each part, so their sets stay apart. */
  async function account(label: string) {
    const ownerId = randomUUID();
    const runnerId = randomUUID();
    const workspaceId = randomUUID();
    await db.user.create({ data: { id: ownerId, email: `${label}-${ownerId}@runner-words.invalid`, name: label, passwordHash: 'x' } });
    await db.runner.create({
      data: {
        id: runnerId, ownerId, name: `${label}-${runnerId}`, tokenHash: `hash-${runnerId}`, status: RunnerStatus.ONLINE,
        capabilities: [], capabilitiesReportedAt: new Date(), lastHeartbeatAt: new Date(),
      },
    });
    await db.workspace.create({ data: { id: workspaceId, ownerId, runnerId, name: `${label}-workspace`, enabled: true } });
    return { ownerId, runnerId, workspaceId, runner: { id: runnerId, ownerId } };
  }
  type Account = Awaited<ReturnType<typeof account>>;

  /**
   * A session of `of` stored at `status`, with the turn state the D1 trigger derives from it, or (unfilled) with
   * none, as a row nothing has written since migration 1611. `facts` are the other columns of a released shape.
   */
  async function session(of: Account, status: string, fill: Fill, facts: Record<string, unknown> = {}): Promise<string> {
    const id = randomUUID();
    await db.session.create({
      data: {
        id, ownerId: of.ownerId, creatorId: of.ownerId, workspaceId: of.workspaceId, assignedRunnerId: of.runnerId,
        title: `${status} ${fill}`, prompt: 'hi', provider: 'claude', providerBuiltin: true,
        turnState: turnStateOfWord(status as RunStatus), dispatchOrigin: SessionDispatchOrigin.USER, startedAt: new Date(),
        // An engine conversation to resume: the reclaim hands back none without one (reclaimRuntimeIds).
        runtimeSessionId: randomUUID(),
        ...facts,
      },
    });
    if (fill === 'unfilled') await sql.query('UPDATE "session" SET turn_state = NULL WHERE id = $1::uuid', [id]);
    const { rows } = await sql.query('SELECT turn_state FROM "session" WHERE id = $1::uuid', [id]);
    assert.equal(rows[0].turn_state == null, fill === 'unfilled' || !['PENDING', 'RUNNING', 'INTERRUPTED'].includes(status),
      `${status} ${fill}: the turn state as set up`);
    return id;
  }

  /** One session per held word and fill, by `<word> <fill>`. */
  async function heldMatrix(of: Account): Promise<Map<string, string>> {
    const ids = new Map<string, string>();
    for (const word of HELD_WORDS) for (const fill of FILLS) ids.set(`${word} ${fill}`, await session(of, word, fill));
    return ids;
  }
  const expectedWords = (ids: Map<string, string>) =>
    Object.fromEntries([...ids.keys()].map((key) => [key, key.split(' ')[0]]));

  await t.test('(1) the reclaim answers every held session its stored word', async () => {
    const of = await account('reclaim');
    const ids = await heldMatrix(of);
    await session(of, RunStatus.CANCELLED, 'filled', { finishedAt: new Date() });
    const answer = await api.reclaim(of.runner, 'claude');
    const byId = new Map(answer.sessions.map((row) => [row.sessionId, row.status]));
    assert.equal(answer.sessions.length, ids.size, 'the held sessions, and no released one');
    assert.deepEqual(Object.fromEntries([...ids].map(([key, id]) => [key, byId.get(id)])), expectedWords(ids));
  });

  await t.test('(2) the single and the batch takeover answer the stored word', async () => {
    const single = await account('takeover');
    const singleIds = await heldMatrix(single);
    const process = randomUUID();
    const first: Record<string, unknown> = {};
    const again: Record<string, unknown> = {};
    for (const [key, id] of singleIds) {
      first[key] = (await api.takeoverLeases(single.runner, id, { leaseOwner: process, expectedLeaseOwner: null })).status;
      again[key] = (await api.takeoverLeases(single.runner, id, { leaseOwner: process, expectedLeaseOwner: null })).status;
    }
    assert.deepEqual(first, expectedWords(singleIds), 'a first takeover');
    assert.deepEqual(again, expectedWords(singleIds), 'a takeover this process already holds');

    const batch = await account('batch');
    const batchIds = await heldMatrix(batch);
    const ordered = [...batchIds];
    const request = (sessions: typeof ordered) => ({
      leaseOwner: process, sessions: sessions.map(([, sessionId]) => ({ sessionId, expectedLeaseOwner: null })),
    });
    for (const label of ['a first takeover', 'a takeover this process already holds']) {
      const answer = await api.takeoverLeasesBatch(batch.runner, request(ordered));
      assert.deepEqual(Object.fromEntries(ordered.map(([key], i) => [key, answer.results[i].status ?? answer.results[i].error])),
        expectedWords(batchIds), label);
    }
  });

  await t.test('(3) a turn-complete that settles nothing answers the stored word, or the projector\'s when released', async () => {
    const of = await account('settles-nothing');
    const ids = await heldMatrix(of);
    const held: Record<string, unknown> = {};
    for (const [key, id] of ids) {
      // A turn the server never handed out: the completion's compare-and-set matches nothing.
      held[key] = (await api.turnComplete(of.runner, id, { turnId: randomUUID(), status: RunStatus.SUCCEEDED } as never)).status;
    }
    assert.deepEqual(held, expectedWords(ids));

    const released = WORD_SHAPES.filter((shape) => shape.facts.finishedAt != null && shape.facts.sessionKind === 'CONVERSATION');
    assert.ok(released.length > 10, 'the released shapes');
    const answers: Record<string, unknown> = {};
    const expected: Record<string, unknown> = {};
    for (const shape of released) {
      const { turnState: _turnState, ...facts } = shape.facts;
      const id = await session(of, shape.stored, 'filled', facts);
      answers[shape.name] = (await api.turnComplete(of.runner, id, { turnId: randomUUID(), status: RunStatus.SUCCEEDED } as never)).status;
      const row = golden.rows.find((r) => r.shape === shape.name)!;
      expected[shape.name] = row.word;
      // The golden's own rule (session-legacy-words.spec.ts): a word other than the stored one is a §3.4 kind.
      assert.equal(row.word === shape.stored, row.kind === undefined, `${shape.name}: golden kind`);
    }
    assert.deepEqual(answers, expected);
  });

  await t.test('(4) the runner-driven writers find their rows on the turn state, and write it beside the word', async () => {
    const of = await account('writers');
    const facts = async (id: string) =>
      (await sql.query('SELECT status::text AS status, turn_state AS "turnState", finished_at IS NOT NULL AS released FROM "session" WHERE id = $1::uuid', [id])).rows[0];
    const parked: Record<string, unknown> = {};
    const released: Record<string, unknown> = {};
    for (const fill of FILLS) {
      // A dispatched turn completes: the session parks, its slot freed (the guard was `status = 'RUNNING'`).
      const running = await session(of, RunStatus.RUNNING, fill);
      const turn = await db.conversationTurn.create({
        data: {
          sessionId: running, seq: 1, clientTurnId: randomUUID(), kind: 'message', content: 'x', status: 'IN_FLIGHT',
          deliveredAt: new Date(), leaseDeadlineAt: new Date(Date.now() + 3_600_000),
        },
      });
      // Answered: a turn the engine said nothing in goes back in the queue, keeping the slot for itself.
      await api.events(of.runner, running, {
        events: [{ seq: 1, type: RunEventType.ASSISTANT, ts: new Date().toISOString(), turnId: turn.id, payload: { text: 'done' } }],
      });
      const reply = await api.turnComplete(of.runner, running, { turnId: turn.id, status: RunStatus.SUCCEEDED, result: 'done' } as never);
      parked[fill] = { reply: reply.status, row: await facts(running) };
      // A parked session is finalized: released (the guard was the held words but PENDING).
      const idle = await session(of, RunStatus.AWAITING_INPUT, fill);
      await api.finalize(of.runner, idle, { status: RunStatus.CANCELLED } as never);
      released[fill] = await facts(idle);
    }
    const parkedRow = { reply: RunStatus.AWAITING_INPUT, row: { status: 'AWAITING_INPUT', turnState: null, released: false } };
    assert.deepEqual(parked, { filled: parkedRow, unfilled: parkedRow });
    const releasedRow = { status: 'CANCELLED', turnState: null, released: true };
    assert.deepEqual(released, { filled: releasedRow, unfilled: releasedRow });

    // A queued session is not finalized: /finalize never ends a turn still waiting for its claim.
    for (const fill of FILLS) {
      const queued = await session(of, RunStatus.PENDING, fill);
      await api.finalize(of.runner, queued, { status: RunStatus.CANCELLED } as never);
      assert.deepEqual(await facts(queued), { status: 'PENDING', turnState: fill === 'filled' ? 'QUEUED' : null, released: false }, fill);
    }
  });

  await t.test('(5) the claim and inbox hints name the sessions they named on the word', async () => {
    for (const fill of FILLS) {
      const of = await account(`hints-${fill}`);
      assert.equal((await readRunnerLinkHints(db, of.runnerId)).claim, false, `${fill}: nothing queued`);
      const queued = await session(of, RunStatus.PENDING, fill);
      assert.equal((await readRunnerLinkHints(db, of.runnerId)).claim, true, `${fill}: a queued session`);
      await sql.query('DELETE FROM "session" WHERE id = $1::uuid', [queued]);
      // The inbox hint: a held session past its claim with a turn waiting, never a queued one.
      const waiting: Record<string, string> = {};
      for (const word of HELD_WORDS) {
        const id = await session(of, word, fill);
        await db.conversationTurn.create({ data: { sessionId: id, seq: 1, clientTurnId: randomUUID(), kind: 'message', content: 'x', status: 'PENDING' } });
        waiting[id] = word;
      }
      const named = (await readRunnerLinkHints(db, of.runnerId)).inboxSessionIds.map((id) => waiting[id]).sort();
      assert.deepEqual(named, ['AWAITING_INPUT', 'INTERRUPTED', 'RUNNING'], fill);
    }
  });
});
