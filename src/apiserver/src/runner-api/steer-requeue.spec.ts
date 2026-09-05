import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RunStatus } from '@prisma/client';
import { TURN_COMPLETE_STEER_REQUEUE } from '@orbit/shared';
import { RunnerApiController } from './runner-api.controller';

/**
 * Taking a steer back: the runner reporting that the engine PROVABLY never read it.
 *
 * The turn a steer is aimed at can end between the control plane deciding the message joins it
 * and the runner getting there — that is a race by construction, and the commonest reason a
 * steer is refused at all. Ending it as a failure would show the person a message that did not
 * arrive when nothing actually went wrong; the row simply becomes the ordinary message it would
 * have been had it been sent a moment later, and runs when the turn it missed ends.
 *
 * Two things must hold, and the second is the dangerous one:
 *
 *  - the row goes back to PENDING/`message` on the SAME row, keeping its seq and clientTurnId,
 *    so the message keeps its place in the conversation rather than jumping to the back;
 *  - it happens ONLY for the explicit subtype. Every other completion for a steer is an ack, and
 *    re-filing an ack would run the message a second time — Codex does not de-duplicate, so a
 *    message it did take would be executed once inside the turn and once after it.
 */

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const RUNNER_ID = '22222222-2222-4222-8222-222222222222';
const TURN_ID = '33333333-3333-4333-8333-333333333333';

function harness({
  isSteer = true,
  /** What the re-file update matched. Zero is a row that is no longer a leased steer — a repeat
   *  of this report, or one that lost the race with the turn ending. */
  requeued = 1,
  status = RunStatus.RUNNING,
  sendIntent = null,
}: {
  isSteer?: boolean;
  requeued?: number;
  status?: RunStatus;
  sendIntent?: 'CURRENT_WORK' | null;
} = {}) {
  const turnState = {
    kind: isSteer ? 'steer' : 'message',
    status: 'IN_FLIGHT',
  };
  const sessionWrites: { where: Record<string, unknown>; data: Record<string, unknown> }[] = [];
  const turnWrites: { where: Record<string, unknown>; data: Record<string, unknown> }[] = [];
  const inboxWakes: string[] = [];
  const queueChanges: string[] = [];
  const tx = {
    $queryRaw: async () => [{ id: SESSION_ID, leaseOwnerMatches: true }],
    $executeRaw: async () => 1,
    conversationTurn: {
      findMany: async () => [],
      findFirst: async ({ where }: { where: { kind?: string } }) =>
        where.kind === 'steer' && turnState.kind === 'steer'
          ? { id: TURN_ID, sendIntent, targetTurnId: null }
          : null,
      findUnique: async () => ({ kind: turnState.kind, sendIntent }),
      updateMany: async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        turnWrites.push(args);
        if (args.data.kind === 'message' && args.where.kind === 'steer') {
          if (requeued > 0 && turnState.kind === 'steer' && turnState.status === 'IN_FLIGHT') {
            turnState.kind = 'message';
            turnState.status = 'PENDING';
          }
          return { count: requeued };
        }
        if (args.data.status === 'ANSWERED') turnState.status = 'ANSWERED';
        return { count: 1 };
      },
      count: async () => 0,
    },
    session: {
      findUniqueOrThrow: async () => ({
        status,
        taskId: null,
        mergeStatus: null,
        mergedSourceSha: null,
        retryAt: null,
      }),
      findUnique: async () => ({ status }),
      updateMany: async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        sessionWrites.push(args);
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
  return { controller, sessionWrites, turnWrites, inboxWakes, queueChanges, turnState };
}

const report = (h: ReturnType<typeof harness>, subtype: string) =>
  h.controller.turnComplete({ id: RUNNER_ID }, SESSION_ID, {
    turnId: TURN_ID,
    status: 'SUCCEEDED',
    subtype,
    numTurns: 0,
    costUsd: 0,
  } as never);

test('a steer the engine never read goes back to being the next ordinary message', async () => {
  const h = harness();

  const out = await report(h, TURN_COMPLETE_STEER_REQUEUE);

  assert.deepEqual(out, { ok: true, status: RunStatus.RUNNING });
  assert.equal(h.turnWrites.length, 1, 'the row is re-filed, not acked as well');
  const [write] = h.turnWrites;
  // The kind was the only thing about this message that was ever a matter of timing.
  assert.deepEqual(write.data, {
    kind: 'message',
    status: 'PENDING',
    deliveredAt: null,
    leaseDeadlineAt: null,
    leaseGeneration: null,
  });
  // Not `answeredAt`, and above all not ANSWERED: an answered row is never delivered again by
  // anything, which is how this message would go missing.
  assert.equal('answeredAt' in write.data, false);
  assert.notEqual(write.data.status, 'ANSWERED');
  // Same row, so its seq and clientTurnId are untouched by construction — the message keeps its
  // place in the conversation instead of being re-sent to the back of the queue.
  assert.equal('seq' in write.data, false);
  assert.equal('clientTurnId' in write.data, false);
  // Only a LEASED steer: the guard is what makes a repeat of this report a no-op, and what keeps
  // it off a row the turn-ending path has already re-filed.
  assert.deepEqual(write.where, {
    id: TURN_ID,
    sessionId: SESSION_ID,
    kind: 'steer',
    status: 'IN_FLIGHT',
  });
  // It is an executable turn again, and the completion that would normally notice one has
  // already happened — so this is the wake.
  assert.deepEqual(h.inboxWakes, [SESSION_ID]);
  assert.deepEqual(h.queueChanges, [SESSION_ID]);
});

test('re-filing the same steer twice changes nothing the second time', async () => {
  // The runner retrying a lost response, or two reports for one message. The row is no longer a
  // leased steer, so the update matches nothing — and nothing is woken on the strength of it.
  const h = harness({ requeued: 0 });

  const out = await report(h, TURN_COMPLETE_STEER_REQUEUE);

  assert.deepEqual(out, { ok: true, status: RunStatus.RUNNING });
  assert.equal(h.turnWrites.length, 1);
  assert.deepEqual(h.inboxWakes, [], 'a no-op must not wake an inbox');
  assert.deepEqual(h.queueChanges, [], 'and must not announce a queue change that did not happen');
  assert.equal(h.sessionWrites.length, 0);
});

test('a lost committed requeue response cannot make its retry answer the requeued message', async () => {
  const h = harness();

  // First request commits, but model the HTTP response being lost by simply issuing the exact
  // same idempotent report again. The row is now a normal PENDING message — and may be leased for
  // its real execution before the retry reaches the server.
  await report(h, TURN_COMPLETE_STEER_REQUEUE);
  await report(h, TURN_COMPLETE_STEER_REQUEUE);

  assert.deepEqual(h.turnState, { kind: 'message', status: 'PENDING' });
  assert.equal(h.turnWrites.length, 1, 'the retry neither ACKs nor mutates the requeued message');
  assert.equal(h.sessionWrites.length, 1, 'only the first requeue attempts its normal wake; the retry cannot settle the session');
  assert.deepEqual(h.inboxWakes, [SESSION_ID]);
  assert.deepEqual(h.queueChanges, [SESSION_ID]);
});

test('a re-filed steer wakes a session its turn already parked', async () => {
  // The race this exists for: the turn ended first, counted the executable turns before this row
  // became one, and parked. Without the wake the message sits PENDING behind nothing, which is
  // the lost-wakeup state the whole enqueue path is built to avoid.
  const h = harness({ status: RunStatus.AWAITING_INPUT });

  await report(h, TURN_COMPLETE_STEER_REQUEUE);

  assert.equal(h.sessionWrites.length, 1);
  assert.deepEqual(h.sessionWrites[0].where, {
    id: SESSION_ID,
    status: RunStatus.AWAITING_INPUT,
    cancelRequestedAt: null,
  });
  assert.equal(h.sessionWrites[0].data.status, RunStatus.PENDING);
  assert.deepEqual(h.inboxWakes, [SESSION_ID]);
});

test('an ordinary steer completion still acks, so re-filing is not what any of them do', async () => {
  // The guard that matters most. Every other completion for a steer means "this message is
  // answered"; treating one as a re-file would put a message the engine took back in the queue
  // and run it a second time.
  const h = harness();

  await report(h, 'steer');

  assert.equal(h.turnWrites.length, 1);
  assert.equal(h.turnWrites[0].data.status, 'ANSWERED');
  assert.equal(h.turnWrites[0].data.kind, undefined);
  assert.deepEqual(h.inboxWakes, []);
});

test('explicit CURRENT_WORK is re-filed too, shedding the columns only a steer may carry', async () => {
  // It used to be settled ANSWERED here — the fallback was reserved for legacy rows, so an
  // explicit one that provably never reached the engine became a receipt the sender could
  // answer only by retyping the message. The reservation is what changed; the proof standard
  // did not, and it is still the runner's to meet.
  const h = harness({ sendIntent: 'CURRENT_WORK' });

  await report(h, TURN_COMPLETE_STEER_REQUEUE);

  assert.equal(h.turnWrites.length, 1);
  assert.equal(h.turnWrites[0].data.status, 'PENDING');
  assert.equal(h.turnWrites[0].data.kind, 'message');
  // NEXT_TURN with no target is the only message shape the row constraints accept.
  assert.equal(h.turnWrites[0].data.sendIntent, 'NEXT_TURN');
  assert.equal(h.turnWrites[0].data.targetTurnId, null);
  // No receipt beside it: one row, one message, one place it can be answered.
  assert.equal(h.turnWrites[0].data.deliveryStatus, undefined);
  assert.deepEqual(h.inboxWakes, [SESSION_ID]);
});

test('the reserved requeue operation cannot settle an ordinary turn', async () => {
  // This is both fail-closed validation and the idempotency fence above: after a successful
  // requeue the row really is an ordinary message, so a retry of the reserved operation must not
  // ACK it. No normal runner completion uses this subtype.
  const h = harness({ isSteer: false });

  await report(h, TURN_COMPLETE_STEER_REQUEUE);

  const refiled = h.turnWrites.find((w) => w.data.kind === 'message' && w.where.kind === 'steer' && w.where.id);
  assert.equal(refiled, undefined, 'a message turn was re-filed through the steer path');
  assert.equal(h.turnWrites.length, 0, 'the reserved operation did not ACK the ordinary message');
  assert.equal(h.sessionWrites.length, 0, 'the reserved operation did not settle the session');
});
