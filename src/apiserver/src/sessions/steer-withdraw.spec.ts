import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { RunStatus } from '@prisma/client';
import { SESSION_CLAUDE_STEER_WITHDRAW_V1, STEER_WITHDRAW_ERRORS } from '@orbit/shared';
import { SessionsService } from './sessions.service';
import {
  readSteerWithdrawRequest,
  settleSteerWithdrawal,
  steerWithdrawAnswer,
  steerWithdrawContent,
  steerWithdrawOutcome,
} from './steer-withdraw';

/**
 * Taking back a steer nothing has read yet (steer-withdraw.ts): what the withdraw turn carries, how
 * the runner's answer is settled, and what DELETE /sessions/:id/turns/:turnId says for each kind of
 * steer it is asked about.
 */

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const OWNER_ID = '22222222-2222-4222-8222-222222222222';
const STEER_ID = '33333333-3333-4333-8333-333333333333';
const RUNNER_ID = '44444444-4444-4444-8444-444444444444';
const WITHDRAW_ID = '55555555-5555-4555-8555-555555555555';

const codeOf = (err: unknown) => ((err as ConflictException).getResponse() as { code?: string }).code;

test('a withdraw turn names its steer, and reads back only what it says', () => {
  assert.deepEqual(readSteerWithdrawRequest(steerWithdrawContent(STEER_ID)), { turnId: STEER_ID });
  assert.deepEqual(
    readSteerWithdrawRequest(JSON.stringify({ turnId: STEER_ID, outcome: 'withdrawn', reason: '' })),
    { turnId: STEER_ID, outcome: 'withdrawn' },
  );
  // An outcome this control plane does not know is no outcome at all.
  assert.deepEqual(
    readSteerWithdrawRequest(JSON.stringify({ turnId: STEER_ID, outcome: 'gone-ish' })),
    { turnId: STEER_ID },
  );
  for (const unreadable of [null, '', 'not json', '{}', '{"turnId":""}', '"a string"']) {
    assert.equal(readSteerWithdrawRequest(unreadable), null, String(unreadable));
  }
});

test("a runner's report is read strictly: only a named outcome can remove a message", () => {
  assert.equal(steerWithdrawOutcome('withdrawn'), 'withdrawn');
  assert.equal(steerWithdrawOutcome('already_read'), 'already_read');
  assert.equal(steerWithdrawOutcome('not_waiting'), 'not_waiting');
  assert.equal(steerWithdrawOutcome('dropped'), 'failed');
  assert.equal(steerWithdrawOutcome(undefined), 'failed');
});

function settleTx() {
  const deletes: Array<Record<string, unknown>> = [];
  const updates: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }> = [];
  return {
    deletes,
    updates,
    tx: {
      conversationTurn: {
        deleteMany: async ({ where }: { where: Record<string, unknown> }) => {
          deletes.push(where);
          return { count: 1 };
        },
        updateMany: async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
          updates.push(args);
          return { count: 1 };
        },
      },
    },
  };
}

test('a withdrawn steer leaves with the completion that says so, and the outcome is written back', async () => {
  const h = settleTx();
  const applied = await settleSteerWithdrawal(
    h.tx as never,
    SESSION_ID,
    { id: WITHDRAW_ID, content: steerWithdrawContent(STEER_ID) },
    { result: 'withdrawn' },
  );

  assert.equal(applied, true);
  // Only the steer it names, only while it is still the in-flight, unread one it was filed against.
  assert.deepEqual(h.deletes, [
    { id: STEER_ID, sessionId: SESSION_ID, kind: 'steer', status: 'IN_FLIGHT', deliveryStatus: null },
  ]);
  assert.equal(h.updates.length, 1);
  assert.deepEqual(h.updates[0].where, { id: WITHDRAW_ID, sessionId: SESSION_ID, kind: 'withdraw' });
  assert.deepEqual(JSON.parse(String(h.updates[0].data.content)), { turnId: STEER_ID, outcome: 'withdrawn' });
});

test('every other outcome leaves the steer where it was, and says why', async () => {
  for (const [result, outcome] of [
    ['already_read', 'already_read'],
    ['not_waiting', 'not_waiting'],
    ['failed', 'failed'],
    ['something newer', 'failed'],
  ] as const) {
    const h = settleTx();
    await settleSteerWithdrawal(
      h.tx as never,
      SESSION_ID,
      { id: WITHDRAW_ID, content: steerWithdrawContent(STEER_ID) },
      { result, error: 'the engine said so' },
    );
    assert.deepEqual(h.deletes, [], `${result} removed the steer`);
    assert.deepEqual(JSON.parse(String(h.updates[0].data.content)), {
      turnId: STEER_ID,
      outcome,
      reason: 'the engine said so',
    });
  }
});

test('a completion retried after its answer was lost changes nothing', async () => {
  const h = settleTx();
  const applied = await settleSteerWithdrawal(
    h.tx as never,
    SESSION_ID,
    { id: WITHDRAW_ID, content: JSON.stringify({ turnId: STEER_ID, outcome: 'withdrawn' }) },
    { result: 'withdrawn' },
  );
  assert.equal(applied, false);
  assert.deepEqual(h.deletes, []);
  assert.deepEqual(h.updates, []);
});

test('the person hears one success and three kinds of refusal', () => {
  assert.deepEqual(steerWithdrawAnswer({ turnId: STEER_ID, outcome: 'withdrawn' }), { ok: true, withdrawn: true });
  for (const [outcome, code] of [
    ['already_read', STEER_WITHDRAW_ERRORS.ALREADY_READ],
    ['not_waiting', STEER_WITHDRAW_ERRORS.ALREADY_READ],
    ['failed', STEER_WITHDRAW_ERRORS.NOT_WITHDRAWABLE],
  ] as const) {
    assert.throws(
      () => steerWithdrawAnswer({ turnId: STEER_ID, outcome, reason: 'the engine did not answer' }),
      (err: unknown) => err instanceof ConflictException && codeOf(err) === code,
      outcome,
    );
  }
});

/** A service whose session holds one steer, as the request's transaction and the wait after it see. */
function makeService(opts: {
  steer: Record<string, unknown>;
  engine?: string;
  capabilities?: string[];
  /** What the withdraw turn's row says on each read after commit; the last one repeats. */
  answers?: Array<string | null>;
}) {
  const session = {
    id: SESSION_ID,
    ownerId: OWNER_ID,
    provider: opts.engine ?? 'claude',
    providerBuiltin: true,
    engine: opts.engine ?? 'claude',
    assignedRunnerId: RUNNER_ID,
    status: RunStatus.RUNNING,
    cancelRequestedAt: null,
    deletedAt: null,
    prompt: 'p',
    numTurns: 1,
  };
  const deleteFilters: Array<Record<string, unknown>> = [];
  const created: Array<Record<string, unknown>> = [];
  const afterCommitDeletes: Array<Record<string, unknown>> = [];
  let answerReads = 0;
  const tx = {
    $queryRaw: async () => [{ id: SESSION_ID }],
    session: {
      findUniqueOrThrow: async () => ({ ...session }),
      update: async () => ({ ...session }),
    },
    runner: { findUnique: async () => ({ capabilities: opts.capabilities ?? [] }) },
    conversationTurn: {
      findMany: async () => [],
      updateMany: async () => ({ count: 0 }),
      findUnique: async () => null,
      findFirst: async ({ where }: { where: Record<string, unknown> }) =>
        where.kind === 'steer' ? { id: STEER_ID, ...opts.steer } : { seq: 7 },
      deleteMany: async ({ where }: { where: Record<string, unknown> }) => {
        deleteFilters.push(where);
        // Cancel's own delete and the undelivered discard match nothing: this row is a live steer.
        return { count: where.kind === 'steer' && where.status === 'PENDING' ? 1 : 0 };
      },
      count: async () => 1,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        created.push(data);
        return { id: WITHDRAW_ID, ...data };
      },
    },
    attachment: { findMany: async () => [], updateMany: async () => ({ count: 0 }) },
    modelProvider: { findFirst: async () => null },
  };
  const answers = opts.answers ?? [null];
  const prisma = {
    session: { findFirst: async () => session, findUnique: async () => session },
    conversationTurn: {
      findFirst: async () => {
        const content = answers[Math.min(answerReads++, answers.length - 1)];
        return { content: content ?? steerWithdrawContent(STEER_ID) };
      },
      deleteMany: async ({ where }: { where: Record<string, unknown> }) => {
        afterCommitDeletes.push(where);
        return { count: 1 };
      },
    },
    $transaction: async (fn: (t: typeof tx) => unknown) => fn(tx),
  } as never;
  const notified: string[] = [];
  const service = new SessionsService(
    prisma,
    { notifySessionQueued: () => undefined } as never,
    { notifyInbox: (id: string) => notified.push(id), publishQueuedTurnsChanged: () => undefined } as never,
  );
  // An answer that is not coming is waited for briefly here.
  (service as unknown as { steerWithdrawWaitMs: number }).steerWithdrawWaitMs = 250;
  return { service, deleteFilters, created, afterCommitDeletes, notified };
}

const typedInFlight = { status: 'IN_FLIGHT', deliveryStatus: null, clientTurnId: 'typed', senderSessionId: null };
const withdrawCapable = [SESSION_CLAUDE_STEER_WITHDRAW_V1];

async function refusal(fn: () => Promise<unknown>) {
  try {
    await fn();
  } catch (e) {
    return e;
  }
  assert.fail('expected a refusal');
}

test('a steer the runner holds is asked for through it, and goes when the engine says it dropped it', async () => {
  const h = makeService({
    steer: typedInFlight,
    capabilities: withdrawCapable,
    answers: [null, null, JSON.stringify({ turnId: STEER_ID, outcome: 'withdrawn' })],
  });

  assert.deepEqual(await h.service.cancelQueuedTurn(OWNER_ID, SESSION_ID, STEER_ID), { ok: true, withdrawn: true });

  // One withdraw turn, naming the steer, and the runner woken to take it.
  assert.equal(h.created.length, 1);
  assert.equal(h.created[0].kind, 'withdraw');
  assert.deepEqual(JSON.parse(String(h.created[0].content)), { turnId: STEER_ID });
  assert.match(String(h.created[0].clientTurnId), new RegExp(`^withdraw:${STEER_ID}:`));
  assert.deepEqual(h.notified, [SESSION_ID]);
  // Nothing here deletes the live steer: only the completion that carries the engine's answer does.
  // (The undelivered-receipt discard is asked first and names settled rows only.)
  assert.ok(
    h.deleteFilters.every((w) => !(w.kind === 'steer' && 'status' in w)),
    JSON.stringify(h.deleteFilters),
  );
});

test('a steer the engine had already read stays, and the refusal says so', async () => {
  const h = makeService({
    steer: typedInFlight,
    capabilities: withdrawCapable,
    answers: [JSON.stringify({ turnId: STEER_ID, outcome: 'already_read' })],
  });

  const err = await refusal(() => h.service.cancelQueuedTurn(OWNER_ID, SESSION_ID, STEER_ID));
  assert.ok(err instanceof ConflictException);
  assert.equal(codeOf(err), STEER_WITHDRAW_ERRORS.ALREADY_READ);
  assert.match((err as Error).message, /already read this message/);
});

test('no answer in time is a refusal, and the request is taken back before anything can act on it', async () => {
  const h = makeService({ steer: typedInFlight, capabilities: withdrawCapable, answers: [null] });

  const err = await refusal(() => h.service.cancelQueuedTurn(OWNER_ID, SESSION_ID, STEER_ID));
  assert.ok(err instanceof ServiceUnavailableException);
  assert.equal(codeOf(err), STEER_WITHDRAW_ERRORS.NO_ANSWER);
  assert.deepEqual(h.afterCommitDeletes, [
    { id: WITHDRAW_ID, sessionId: SESSION_ID, kind: 'withdraw', status: 'PENDING' },
  ]);
});

test('a steer no runner here can ask for back is refused before anything is filed', async () => {
  for (const [engine, capabilities, said] of [
    ['codex', withdrawCapable, /Codex already has this message and can't give it back/],
    ['claude', [], /Claude already has this message and can't give it back/],
  ] as const) {
    const h = makeService({ steer: typedInFlight, engine, capabilities: [...capabilities] });
    const err = await refusal(() => h.service.cancelQueuedTurn(OWNER_ID, SESSION_ID, STEER_ID));
    assert.ok(err instanceof ConflictException, engine);
    assert.equal(codeOf(err), STEER_WITHDRAW_ERRORS.NOT_WITHDRAWABLE, engine);
    assert.match((err as Error).message, said);
    assert.deepEqual(h.created, [], `${engine} filed a withdraw turn`);
  }
});

test('a steer already read into its turn is refused as read, whatever the runner could do', async () => {
  for (const steer of [
    { ...typedInFlight, deliveryStatus: 'ACKNOWLEDGED' },
    { ...typedInFlight, status: 'ANSWERED' },
  ]) {
    const h = makeService({ steer, capabilities: withdrawCapable });
    const err = await refusal(() => h.service.cancelQueuedTurn(OWNER_ID, SESSION_ID, STEER_ID));
    assert.equal(codeOf(err), STEER_WITHDRAW_ERRORS.ALREADY_READ, JSON.stringify(steer));
    assert.deepEqual(h.created, []);
  }
});

test('only words the reader typed can be withdrawn', async () => {
  for (const steer of [
    { ...typedInFlight, senderSessionId: '66666666-6666-4666-8666-666666666666' },
    { ...typedInFlight, clientTurnId: 'bg-wake:job-1' },
  ]) {
    const h = makeService({ steer, capabilities: withdrawCapable });
    const err = await refusal(() => h.service.cancelQueuedTurn(OWNER_ID, SESSION_ID, STEER_ID));
    assert.equal(codeOf(err), STEER_WITHDRAW_ERRORS.NOT_WITHDRAWABLE, JSON.stringify(steer));
    assert.deepEqual(h.created, []);
  }
});

test('a steer nothing has taken yet goes the way a queued message does, on any engine', async () => {
  const h = makeService({ steer: { ...typedInFlight, status: 'PENDING' }, engine: 'codex' });

  assert.deepEqual(await h.service.cancelQueuedTurn(OWNER_ID, SESSION_ID, STEER_ID), { ok: true });
  assert.deepEqual(h.deleteFilters.at(-1), { id: STEER_ID, sessionId: SESSION_ID, kind: 'steer', status: 'PENDING' });
  assert.deepEqual(h.created, []);
});
