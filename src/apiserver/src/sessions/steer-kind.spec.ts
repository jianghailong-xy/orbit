import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RunStatus } from '@prisma/client';
import { SessionsService } from './sessions.service';

/**
 * Which kind a sent message is filed as, decided by the server at enqueue.
 *
 * No client asks to steer. A message sent while the engine is mid-turn IS a steer, and one
 * sent to an idle session is an ordinary turn — so every entry point (web, native, MCP, CLI)
 * gets mid-turn delivery without any of them knowing the word. The decision is made under
 * the same Session row lock the inbox dequeues under, which is what keeps it from racing the
 * turn it is about.
 */

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const OWNER_ID = '22222222-2222-4222-8222-222222222222';

function makeService(
  inFlight: number,
  status: RunStatus = RunStatus.RUNNING,
  provider: { provider: string; providerBuiltin: boolean; customRuntime?: string } = {
    provider: 'claude',
    providerBuiltin: true,
  },
) {
  const created: Record<string, unknown>[] = [];
  const countFilters: Record<string, unknown>[] = [];
  const session = {
    id: SESSION_ID,
    ownerId: OWNER_ID,
    provider: provider.provider,
    providerBuiltin: provider.providerBuiltin,
    status,
    cancelRequestedAt: null,
    prompt: 'opening prompt',
    numTurns: 1,
    mergeStatus: null,
    mergeOperationId: null,
    mergeOperationOwner: null,
    commitStatus: null,
    commitOperationId: null,
    commitOperationOwner: null,
  };
  const tx = {
    $queryRaw: async () => [{ id: SESSION_ID }],
    session: {
      findUniqueOrThrow: async () => ({ ...session }),
      update: async () => ({ ...session }),
    },
    conversationTurn: {
      findUnique: async () => null,
      findFirst: async () => ({ seq: 1 }),
      create: async ({ data }: { data: Record<string, unknown> }) => {
        created.push(data);
        return { id: 'turn-new', seq: 2, ...data };
      },
      count: async ({ where }: { where: Record<string, unknown> }) => {
        countFilters.push(where);
        return inFlight;
      },
    },
    attachment: { findMany: async () => [], updateMany: async () => ({ count: 0 }) },
    // Only consulted for a configured (BYOK) provider, which borrows a built-in runtime.
    modelProvider: {
      findFirst: async () =>
        provider.customRuntime ? { runtime: provider.customRuntime, enabled: true } : null,
    },
  };
  const prisma = {
    session: { findFirst: async () => ({ ...session }), findUnique: async () => ({ ...session }) },
    $transaction: async (fn: (t: typeof tx) => unknown) => fn(tx),
  } as never;
  const service = new SessionsService(
    prisma,
    { notifySessionQueued: () => undefined } as never,
    { notifyInbox: () => undefined, publishQueuedTurnsChanged: () => undefined } as never,
  );
  return { service, created, countFilters };
}

const send = (h: ReturnType<typeof makeService>, kind?: 'shell') =>
  h.service.createTurn(OWNER_ID, SESSION_ID, {
    clientTurnId: '44444444-4444-4444-8444-444444444444',
    content: 'actually, call it gadget',
    ...(kind ? { kind } : {}),
  });

test('a message sent while the engine is mid-turn is filed as a steer', async () => {
  const h = makeService(1);

  await send(h);

  assert.equal(h.created.length, 1);
  assert.equal(h.created[0].kind, 'steer');
  assert.equal(h.created[0].content, 'actually, call it gadget');
  // Same row as any other turn: its own seq, and the caller's idempotency key. The kind is
  // the only thing that was ever about timing.
  assert.equal(h.created[0].clientTurnId, '44444444-4444-4444-8444-444444444444');
  assert.equal(h.created[0].status, 'PENDING');
});

test('the running turn is looked for by a live lease, and only among engine turns', async () => {
  const h = makeService(1);

  await send(h);

  const probe = h.countFilters.at(-1) as { kind: unknown; status: unknown; leaseDeadlineAt: unknown };
  // Messages only: a `!cmd` shell turn holds the same slot with the engine idle beside it.
  assert.equal(probe.kind, 'message');
  assert.equal(probe.status, 'IN_FLIGHT');
  // An expired lease belongs to an engine that stopped answering — nothing to steer.
  assert.ok((probe.leaseDeadlineAt as { gt?: Date })?.gt instanceof Date);
});

test('a message sent to an idle session is an ordinary turn, and queues as one', async () => {
  const h = makeService(0, RunStatus.AWAITING_INPUT);

  await send(h);

  assert.equal(h.created[0].kind, 'message');
});

test('a client cannot claim the kind: asking to steer an idle session files a message', async () => {
  const h = makeService(0, RunStatus.AWAITING_INPUT);

  // `kind` is a whitelist of what a caller may REQUEST — a message or a `!cmd`. If a caller could
  // claim `steer`, it could have a message filed into a turn that is not running: the runner would
  // refuse to write it (nothing to steer) and the message would fail for no reason the sender
  // could see, while the dequeue gate for a steer is not the one the message needed.
  await h.service.createTurn(OWNER_ID, SESSION_ID, {
    clientTurnId: '55555555-5555-4555-8555-555555555555',
    content: 'pretend this is mid-turn',
    kind: 'steer' as never,
  });

  assert.equal(h.created[0].kind, 'message');
});

test('a `!cmd` shell turn never becomes a steer, however busy the engine is', async () => {
  const h = makeService(1);

  await send(h, 'shell');

  assert.equal(h.created[0].kind, 'shell');
});

// The decision is the server's, but the sender has to be told what it decided: a steer joins the
// running turn while a message waits for its own, and a client that cannot tell them apart shows
// the same "Queued, Cancel" for both — offering to withdraw a message already on its way, and
// then dropping it from the queue it was never in.
test('the response says which kind the message was filed as', async () => {
  const steered = await send(makeService(1));
  assert.equal(steered.kind, 'steer');

  const queued = await send(makeService(0, RunStatus.AWAITING_INPUT));
  assert.equal(queued.kind, 'message');
});

test('the response still carries the turn id and seq it always did', async () => {
  const accepted = await send(makeService(1));

  assert.equal(accepted.turnId, 'turn-new');
  assert.equal(accepted.seq, 2);
});

/**
 * A steer is written into a stdin that stays open across the turn, which only claude's
 * stream-json transport has. Filing one for any other engine delivered a turn nobody consumes:
 * leased (so gone from the queued list) and never re-leased (so never coming back) — the message
 * would simply disappear. Those sessions keep the behaviour they always had: an ordinary queued
 * message, which is what their clients already know how to show.
 */
const CODEX = { provider: 'codex', providerBuiltin: true };
const KIMI = { provider: 'kimi', providerBuiltin: true };
const OPENCODE = { provider: 'opencode', providerBuiltin: true };

test('an engine that cannot be written to mid-turn queues the message instead of steering it', async () => {
  for (const provider of [CODEX, KIMI, OPENCODE]) {
    const h = makeService(1, RunStatus.RUNNING, provider);

    await send(h);

    assert.equal(h.created[0].kind, 'message', `${provider.provider} must not be handed a steer`);
  }
});

test('a configured provider is judged by the runtime it borrows, not by its slug', async () => {
  // A BYOK identity on the claude runtime steers exactly like claude — the stdin is the same one.
  const onClaude = makeService(1, RunStatus.RUNNING, {
    provider: 'deepseek',
    providerBuiltin: false,
    customRuntime: 'claude',
  });
  await send(onClaude);
  assert.equal(onClaude.created[0].kind, 'steer');

  // …and one on the codex runtime does not, however claude-like its slug looks.
  const onCodex = makeService(1, RunStatus.RUNNING, {
    provider: 'some-openai-endpoint',
    providerBuiltin: false,
    customRuntime: 'codex',
  });
  await send(onCodex);
  assert.equal(onCodex.created[0].kind, 'message');
});

test('the answer tells a non-steering session what it got, so no client shows the wrong thing', async () => {
  const accepted = await send(makeService(1, RunStatus.RUNNING, CODEX));

  // 'message' is what a client renders as "Queued" with a withdraw — which is exactly what this
  // is. A blank kind would leave every door guessing from a status it may not have caught up on.
  assert.equal(accepted.kind, 'message');
});
