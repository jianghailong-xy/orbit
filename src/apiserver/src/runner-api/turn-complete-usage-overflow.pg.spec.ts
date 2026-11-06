/**
 * A turn's completion is what lets its session take the next message, so nothing it merely reports
 * may hold it. On 2026-11-05 a coordinator's running cache-read total reached 2,148,742,656, past
 * `usage`'s int4; every completion rolled back with P2020, the runner re-posted it 5,958 times, and
 * the session stood still for over three hours behind a turn its engine had already finished.
 *
 * scripts/run-pg-spec.sh src/apiserver/src/runner-api/turn-complete-usage-overflow.pg.spec.ts
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { Prisma, RunStatus, RunnerStatus, SessionDispatchOrigin } from '@prisma/client';
import { RunEventType, RunStatus as SharedRunStatus, type TurnCompleteRequest } from '@orbit/shared';
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
/** The value the incident's first refused completion carried. */
const PAST_INT4 = 2_148_742_656;

test('nothing a turn reports can hold its completion', {
  skip: !URL, concurrency: 1, timeout: 300_000,
}, async (t) => {
  assertCoordinatorPgUrlIsIsolated(URL!);
  const sql = new Client({ connectionString: URL!, connectionTimeoutMillis: 5_000 });
  t.after(async () => { await sql.end(); });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const db = prismaClientFor(URL!);
  t.after(async () => { await db.$disconnect(); });

  const controllerOn = (prisma: unknown) => new RunnerApiController(
    prisma as PrismaService,
    { notifySessionQueued: () => undefined } as unknown as QueueService,
    new Proxy({}, { get: () => () => undefined }) as unknown as RealtimeService,
    {} as never,
    {} as never,
    { expand: async (_ownerId: string, content?: string) => content } as never,
    { appendFor: async (_tx: unknown, _sessionId: string, content?: string) => content } as never,
  );
  const api = controllerOn(db);
  const warnings: string[] = [];
  (api as unknown as { logger: { warn: (line: string) => void } }).logger.warn = (line) => {
    warnings.push(line);
  };

  const ownerId = randomUUID();
  const runnerId = randomUUID();
  await db.user.create({
    data: { id: ownerId, email: `${ownerId}@usage-overflow.invalid`, name: 'Owner', passwordHash: 'x' },
  });
  await db.runner.create({
    data: {
      id: runnerId, ownerId, name: 'usage runner', tokenHash: `hash-${runnerId}`,
      status: RunnerStatus.ONLINE,
    },
  });

  async function session(model = 'claude-opus-5-5') {
    return db.session.create({
      data: {
        ownerId, creatorId: ownerId, assignedRunnerId: runnerId, provider: 'claude', model,
        title: 'usage session', prompt: 'report usage', status: RunStatus.RUNNING,
        engineTurnActive: true, dispatchOrigin: SessionDispatchOrigin.USER,
      },
      select: { id: true },
    });
  }

  async function turn(sessionId: string, seq = 1) {
    await db.session.update({
      where: { id: sessionId }, data: { status: RunStatus.RUNNING, engineTurnActive: true },
    });
    const row = await db.conversationTurn.create({
      data: {
        sessionId, seq, clientTurnId: `usage-${randomUUID()}`, kind: 'message',
        content: 'report usage', status: 'IN_FLIGHT', deliveredAt: new Date(),
        leaseDeadlineAt: new Date(Date.now() + 300_000),
      },
      select: { id: true },
    });
    await api.events({ id: runnerId }, sessionId, {
      events: [{
        seq, type: RunEventType.ASSISTANT, ts: new Date().toISOString(),
        turnId: row.id, payload: { text: 'done' },
      }],
    });
    return row.id;
  }

  const completion = (turnId: string, report: Partial<TurnCompleteRequest> = {}): TurnCompleteRequest => ({
    turnId, status: SharedRunStatus.SUCCEEDED, subtype: 'success', numTurns: 1, costUsd: 0, ...report,
  });

  /** As a string, the way `pg` reads a bigint: a JS number could not show a lost digit. */
  async function cacheReads(sessionId: string): Promise<string[]> {
    const { rows } = await sql.query<{ reads: string }>(
      `SELECT cache_read_input_tokens::text AS reads FROM usage
        WHERE session_id = $1::uuid ORDER BY created_at, id`,
      [sessionId],
    );
    return rows.map((row) => row.reads);
  }

  async function settled(sessionId: string, turnId: string) {
    const [row, answered] = await Promise.all([
      db.session.findUniqueOrThrow({ where: { id: sessionId } }),
      db.conversationTurn.findUniqueOrThrow({ where: { id: turnId } }),
    ]);
    assert.equal(answered.status, 'ANSWERED', 'the turn is answered');
    assert.equal(row.status, RunStatus.AWAITING_INPUT, 'and its session takes the next message');
    return row;
  }

  await t.test('all four token counts are bigint in the catalog', async () => {
    const { rows } = await sql.query<{ column_name: string; data_type: string }>(
      `SELECT column_name, data_type FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'usage' AND column_name LIKE '%tokens'
        ORDER BY column_name`,
    );
    assert.deepEqual(rows, [
      { column_name: 'cache_creation_input_tokens', data_type: 'bigint' },
      { column_name: 'cache_read_input_tokens', data_type: 'bigint' },
      { column_name: 'input_tokens', data_type: 'bigint' },
      { column_name: 'output_tokens', data_type: 'bigint' },
    ]);
  });

  await t.test('the count that wedged the session settles and is kept to the digit', async () => {
    const s = await session();
    const turnId = await turn(s.id);
    const report = completion(turnId, {
      modelUsage: {
        'claude-opus-5-5': {
          inputTokens: 1, outputTokens: 2, cacheCreationInputTokens: 3,
          cacheReadInputTokens: PAST_INT4, costUSD: 0.5,
        },
      } as TurnCompleteRequest['modelUsage'],
    });
    const before = warnings.length;
    assert.deepEqual(await api.turnComplete({ id: runnerId }, s.id, report), {
      ok: true, status: RunStatus.AWAITING_INPUT,
    });
    await settled(s.id, turnId);
    assert.deepEqual(await cacheReads(s.id), [String(PAST_INT4)]);
    assert.equal(warnings.length, before, 'a count the column holds is nothing to warn about');
    await api.turnComplete({ id: runnerId }, s.id, report);
    assert.deepEqual(await cacheReads(s.id), [String(PAST_INT4)], 'the re-post books no second row');
  });

  await t.test('so does the same count on the engines that report one aggregate', async () => {
    const s = await session('gpt-6-sol');
    const turnId = await turn(s.id);
    await api.turnComplete({ id: runnerId }, s.id, completion(turnId, {
      usage: {
        input_tokens: PAST_INT4, output_tokens: PAST_INT4,
        cache_creation_input_tokens: PAST_INT4, cache_read_input_tokens: PAST_INT4,
      },
    }));
    await settled(s.id, turnId);
    assert.deepEqual(await cacheReads(s.id), [String(PAST_INT4)]);
  });

  // Each of these is refused by a different layer. All are reports, so none may hold the turn.
  const refused: Array<[string, Partial<TurnCompleteRequest>, RegExp]> = [
    ['a count past bigint, refused by the database', {
      modelUsage: {
        'claude-opus-5-5': {
          inputTokens: 1, outputTokens: 1, cacheCreationInputTokens: 1,
          cacheReadInputTokens: 2 ** 70, costUSD: 1,
        },
      } as TurnCompleteRequest['modelUsage'],
    }, /type bigint/],
    ['a model entry with nothing in it, refused by the mapping', {
      modelUsage: { 'claude-opus-5-5': null } as unknown as TurnCompleteRequest['modelUsage'],
    }, /TypeError: .*inputTokens/],
    ['a count that is not one, refused by the client', {
      modelUsage: {
        'claude-opus-5-5': { inputTokens: 'many' },
      } as unknown as TurnCompleteRequest['modelUsage'],
    }, /PrismaClientValidationError: .*inputTokens/],
    ['a turn count past the session row\'s int4, the 0347 shape', {
      numTurns: 3_000_000_000,
    }, /P2020: .*3000000000/],
  ];
  for (const [name, report, why] of refused) {
    await t.test(`${name}: settles without its reports`, async () => {
      const s = await session();
      const turnId = await turn(s.id);
      const full = completion(turnId, {
        ...report,
        result: 'the answer',
        runtimeSessionId: 'runtime-of-this-turn',
        baseSha: 'a'.repeat(40),
        changedFiles: [{ path: 'a.txt', status: 'M', additions: 1, deletions: 0 }],
        changedDiff: [{ path: 'a.txt', patch: '+a' }],
        costUsd: 0.25,
      });

      const before = warnings.length;
      assert.deepEqual(await api.turnComplete({ id: runnerId }, s.id, full), {
        ok: true, status: RunStatus.AWAITING_INPUT,
      });
      const row = await settled(s.id, turnId);
      assert.equal(row.runtimeSessionId, 'runtime-of-this-turn', 'the next start resumes the same conversation');
      assert.equal(row.numTurns, 1, 'the completion books its one turn');

      // The first attempt rolled back whole: not a part of the report stayed behind.
      assert.equal(row.costUsd, 0);
      assert.equal(row.baseSha, null);
      assert.equal(row.changedFiles, null);
      assert.equal(await db.sessionDiff.count({ where: { sessionId: s.id } }), 0);
      assert.deepEqual(await cacheReads(s.id), []);

      const said = warnings.slice(before);
      assert.equal(said.length, 1, `one line says so, once: ${JSON.stringify(said)}`);
      assert.match(said[0]!, new RegExp(turnId));
      assert.match(said[0]!, new RegExp(s.id));
      assert.match(said[0]!, why, 'and it says why');
      assert.doesNotMatch(said[0]!, /\n/, 'on one line, without the code frame Prisma opens with');

      // The runner's copy of a lost answer: absorbed, and no second line.
      assert.deepEqual(await api.turnComplete({ id: runnerId }, s.id, completion(turnId, report)), {
        ok: true, status: RunStatus.AWAITING_INPUT,
      });
      assert.equal(warnings.length, before + 1, 'a turn already answered reports nothing again');

      // And the session goes on: its next turn reports as usual.
      const next = await turn(s.id, 2);
      await api.turnComplete({ id: runnerId }, s.id, completion(next, {
        modelUsage: {
          'claude-opus-5-5': {
            inputTokens: 1, outputTokens: 1, cacheCreationInputTokens: 1,
            cacheReadInputTokens: PAST_INT4, costUSD: 1,
          },
        } as TurnCompleteRequest['modelUsage'],
      }));
      await settled(s.id, next);
      assert.deepEqual(await cacheReads(s.id), [String(PAST_INT4)]);
    });
  }

  await t.test('a turn no engine ran is still owed its delivery without its reports', async () => {
    // `numTurns: 0` is the one count that decides anything. A message from another session is settled
    // by its turn running to a normal end, said or silent, unless no engine turn ran: then it was
    // never read, and goes back in the queue. Reading a dropped count as 1 would answer it unread.
    const sender = await session();
    const s = await session();
    const { id: turnId } = await db.conversationTurn.create({
      data: {
        sessionId: s.id, seq: 1, clientTurnId: `usage-${randomUUID()}`, kind: 'message',
        content: 'read this', status: 'IN_FLIGHT', deliveredAt: new Date(),
        leaseDeadlineAt: new Date(Date.now() + 300_000), senderSessionId: sender.id,
      },
      select: { id: true },
    });
    const before = warnings.length;
    await api.turnComplete({ id: runnerId }, s.id, completion(turnId, {
      numTurns: 0,
      costUsd: 0,
      modelUsage: { 'claude-opus-5-5': null } as unknown as TurnCompleteRequest['modelUsage'],
    }));
    assert.equal(warnings.length, before + 1, 'it went without its reports');
    const { status } = await db.conversationTurn.findUniqueOrThrow({ where: { id: turnId } });
    assert.notEqual(status, 'ANSWERED', 'the message was never read, so it is not answered');
  });

  /** A client whose every transaction fails with `fault`, counting the attempts. */
  function refusing(fault: Error) {
    const attempts = { count: 0 };
    const client = new Proxy(db, {
      get(target, property, receiver) {
        if (property !== '$transaction') return Reflect.get(target, property, receiver);
        return async () => {
          attempts.count += 1;
          throw fault;
        };
      },
    });
    return { attempts, api: controllerOn(client) };
  }

  const knownError = (code: string) => new Prisma.PrismaClientKnownRequestError('refused', {
    code, clientVersion: 'spec',
  });
  const notAboutTheReport: Array<[string, Error, number]> = [
    ['the pool having no connection (P2024)', knownError('P2024'), 1],
    ['the transaction closed under it (P2028)', knownError('P2028'), 1],
    ['a shutdown (57P01)', knownError('57P01'), 1],
    ['a deadlock its retries did not absorb (40P01)', knownError('40P01'), 4],
  ];
  for (const [name, fault, expected] of notAboutTheReport) {
    await t.test(`${name} keeps the whole completion for the runner's re-post`, async () => {
      const s = await session();
      const turnId = await turn(s.id);
      const client = refusing(fault);
      await assert.rejects(
        client.api.turnComplete({ id: runnerId }, s.id, completion(turnId)),
        (error) => error === fault,
      );
      assert.equal(client.attempts.count, expected, 'and no attempt went without the report');
    });
  }

  await t.test('a refusal the route already decided is the answer, and is not re-run', async () => {
    const s = await session();
    const turnId = await turn(s.id);
    const before = warnings.length;
    await assert.rejects(
      api.turnComplete({ id: runnerId }, s.id, completion(turnId, { leaseOwner: randomUUID() })),
      (error) => (error as { getStatus?: () => number }).getStatus?.() === 409,
    );
    assert.equal(warnings.length, before);
    const { status } = await db.conversationTurn.findUniqueOrThrow({ where: { id: turnId } });
    assert.equal(status, 'IN_FLIGHT', 'a process that lost the session settles nothing');
  });
});
