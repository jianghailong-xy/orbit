import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RunStatus } from '@prisma/client';
import { RunnerApiController } from './runner-api.controller';

/**
 * A steer settles only itself.
 *
 * It joined a turn that is still running: the result that ends that turn belongs to the
 * message it was folded into, and so do the slot, the billing and the session's status. The
 * danger this pins down is a steer's completion reaching any of them — parking a session
 * mid-turn, or ending one because a steer failed to reach the engine.
 */

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const RUNNER_ID = '22222222-2222-4222-8222-222222222222';
const TURN_ID = '33333333-3333-4333-8333-333333333333';

function harness(kind: 'steer' | 'message') {
  const sessionWrites: Record<string, unknown>[] = [];
  const turnWrites: { where: Record<string, unknown>; data: Record<string, unknown> }[] = [];
  const inboxWakes: string[] = [];
  const queueChanges: string[] = [];
  const tx = {
    $queryRaw: async () => [{ id: SESSION_ID, leaseOwnerMatches: true }],
    $executeRaw: async () => 1,
    conversationTurn: {
      findFirst: async ({ where }: { where: { kind?: string } }) =>
        where.kind === 'steer' && kind === 'steer' ? { id: TURN_ID } : null,
      findUnique: async () => ({ kind }),
      updateMany: async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        turnWrites.push(args);
        return { count: 1 };
      },
      count: async () => 0,
    },
    session: {
      findUniqueOrThrow: async () => ({
        status: RunStatus.RUNNING,
        taskId: null,
        mergeStatus: null,
        mergedSourceSha: null,
        retryAt: null,
      }),
      findUnique: async () => ({ status: RunStatus.RUNNING }),
      updateMany: async ({ data }: { data: Record<string, unknown> }) => {
        sessionWrites.push(data);
        return { count: 1 };
      },
    },
    sessionDiff: { upsert: async () => undefined },
    llmUsage: { createMany: async () => undefined },
    task: { updateMany: async () => ({ count: 1 }), findUnique: async () => null },
  };
  const prisma = { $transaction: async (fn: (t: typeof tx) => unknown) => fn(tx) } as never;
  const realtime = {
    notifyInbox: (id: string) => inboxWakes.push(id),
    publish: () => undefined,
    publishSessionUpdated: () => undefined,
    publishQueuedTurnsChanged: (id: string) => queueChanges.push(id),
  } as never;
  const controller = new RunnerApiController(
    prisma,
    { notifySessionQueued: () => undefined } as never,
    realtime,
    {} as never,
    {} as never,
    {} as never,
    { appendFor: async (_tx: unknown, _sessionId: unknown, content?: string) => content } as never,
  );
  return { controller, sessionWrites, turnWrites, inboxWakes, queueChanges };
}

const complete = (h: ReturnType<typeof harness>, status: string, result?: string) =>
  h.controller.turnComplete({ id: RUNNER_ID }, SESSION_ID, {
    turnId: TURN_ID,
    status,
    subtype: 'steer',
    numTurns: 0,
    costUsd: 0,
    ...(result ? { result } : {}),
  } as never);

test('completing a steer acks its own turn and touches nothing else about the session', async () => {
  const h = harness('steer');

  const out = await complete(h, 'SUCCEEDED');

  assert.deepEqual(out, { ok: true, status: RunStatus.RUNNING });
  assert.equal(h.sessionWrites.length, 0, 'a steer must not write the session row at all');
  assert.equal(h.turnWrites.length, 1);
  assert.deepEqual(h.turnWrites[0].data, { status: 'ANSWERED', answeredAt: h.turnWrites[0].data.answeredAt });
  assert.deepEqual(h.turnWrites[0].where, { id: TURN_ID, sessionId: SESSION_ID, status: { not: 'ANSWERED' } });
  // The queue view changed and nothing else did, so that is the only thing announced —
  // no status publish, and no inbox wake competing with the turn still in progress.
  assert.deepEqual(h.queueChanges, [SESSION_ID]);
  assert.deepEqual(h.inboxWakes, []);
});

test('a steer that failed to reach the engine does not end the session it was aimed at', async () => {
  const h = harness('steer');

  const out = await complete(h, 'FAILED', 'steer not delivered to the engine: claude stdin is closed');

  // The turn it was steering is still running. A FAILED session here would stop work that
  // is going perfectly well because a side message missed its window.
  assert.equal(out.status, RunStatus.RUNNING);
  assert.equal(h.sessionWrites.length, 0);
  assert.equal(h.turnWrites.length, 1, 'only the steer’s own row settles');
});

test('an ordinary turn still settles the session, so the steer branch is not a way out of it', async () => {
  const h = harness('message');

  await complete(h, 'SUCCEEDED');

  assert.equal(h.sessionWrites.length, 1);
  assert.equal(h.sessionWrites[0].status, RunStatus.AWAITING_INPUT);
  // A steer left queued when its turn ends becomes the ordinary message it would have been
  // had it arrived a moment later.
  const promoted = h.turnWrites.find((w) => w.data.kind === 'message');
  assert.ok(promoted, 'a queued steer is not filed as a message when its turn ends');
  assert.deepEqual(promoted.where, { sessionId: SESSION_ID, kind: 'steer', status: 'PENDING' });
});
