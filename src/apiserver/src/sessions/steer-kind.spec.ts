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
const RUNNER_ID = '33333333-3333-4333-8333-333333333333';

function makeService(
  inFlight: number,
  status: RunStatus = RunStatus.RUNNING,
  provider: { provider: string; providerBuiltin: boolean; customRuntime?: string } = {
    provider: 'claude',
    providerBuiltin: true,
  },
  /** What the runner holding this session declared on its last heartbeat — `null` for a
   *  session with no runner assigned at all. */
  runnerCapabilities: string[] | null = [],
  /** A row already filed under the clientTurnId being sent — what a retried send finds. */
  existingTurn: Record<string, unknown> | null = null,
) {
  const created: Record<string, unknown>[] = [];
  const countFilters: Record<string, unknown>[] = [];
  const session = {
    id: SESSION_ID,
    ownerId: OWNER_ID,
    provider: provider.provider,
    providerBuiltin: provider.providerBuiltin,
    assignedRunnerId: runnerCapabilities === null ? null : RUNNER_ID,
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
      findUnique: async () => existingTurn,
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
    // What the machine that will execute this turn last said it can do.
    runner: {
      findUnique: async () =>
        runnerCapabilities === null ? null : { capabilities: runnerCapabilities },
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
 * Which engines a steer may be filed for, and on whose word.
 *
 * Filing one for an engine that cannot take a mid-turn message delivered a turn nobody
 * consumes: leased (so gone from the queued list) and never re-leased (so never coming back) —
 * the message would simply disappear. Filing one for an engine that CAN, on a runner too old to
 * do it, is not silent but is still a regression: that runner refuses every steer handed to it,
 * so a message that quietly queued yesterday fails in front of the user today. Both questions
 * are asked here, before the row is written, and either one unanswered keeps the session on the
 * behaviour it already had: an ordinary queued message.
 */
const CODEX = { provider: 'codex', providerBuiltin: true };
const KIMI = { provider: 'kimi', providerBuiltin: true };
const OPENCODE = { provider: 'opencode', providerBuiltin: true };
/** What a runner that implements codex `turn/steer` declares on its heartbeat. */
const DECLARES_CODEX_STEER = ['session-codex-steer-v1'];

test('an engine with nothing to fold a message into queues it, however capable the runner is', async () => {
  // Codex and kimi are both driven over JSON-RPC and only codex has a call for this, so a
  // runner's declaration cannot be read as a claim about kimi — or about a one-shot engine
  // that exits with the turn.
  for (const provider of [KIMI, OPENCODE]) {
    const h = makeService(1, RunStatus.RUNNING, provider, DECLARES_CODEX_STEER);

    await send(h);

    assert.equal(h.created[0].kind, 'message', `${provider.provider} must not be handed a steer`);
  }
});

test('codex steers only once the runner holding the session says it can deliver one', async () => {
  const declared = makeService(1, RunStatus.RUNNING, CODEX, DECLARES_CODEX_STEER);
  await send(declared);
  assert.equal(declared.created[0].kind, 'steer');

  // The same session on a runner that predates `turn/steer`: it knows the kind (every runner
  // in the field does) and answers it by refusing, so the message queues instead — a turn
  // later, which is exactly what it does today.
  const older = makeService(1, RunStatus.RUNNING, CODEX, ['session-worktree-ops-v1']);
  await send(older);
  assert.equal(older.created[0].kind, 'message');
});

test('a runner that has declared nothing is never read as declaring this', async () => {
  // A machine that has not heartbeated since the column existed, and a session with no runner
  // assigned at all. Unknown withholds the steer; it never invents one.
  for (const capabilities of [[], null]) {
    const h = makeService(1, RunStatus.RUNNING, CODEX, capabilities);

    await send(h);

    assert.equal(h.created[0].kind, 'message');
  }
});

test('claude steers on any runner, without waiting for a declaration', async () => {
  // Claude's mid-turn delivery shipped with the kind itself. Gating it on a new word would
  // withdraw a working feature from the whole installed fleet the day this deployed.
  const h = makeService(1, RunStatus.RUNNING, { provider: 'claude', providerBuiltin: true }, []);

  await send(h);

  assert.equal(h.created[0].kind, 'steer');
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

  // …and one on the codex runtime is gated like codex, however claude-like its slug looks.
  const onCodex = makeService(1, RunStatus.RUNNING, {
    provider: 'some-openai-endpoint',
    providerBuiltin: false,
    customRuntime: 'codex',
  });
  await send(onCodex);
  assert.equal(onCodex.created[0].kind, 'message');

  const onCodexDeclared = makeService(
    1,
    RunStatus.RUNNING,
    { provider: 'some-openai-endpoint', providerBuiltin: false, customRuntime: 'codex' },
    DECLARES_CODEX_STEER,
  );
  await send(onCodexDeclared);
  assert.equal(onCodexDeclared.created[0].kind, 'steer');
});

test('the answer tells a non-steering session what it got, so no client shows the wrong thing', async () => {
  const accepted = await send(makeService(1, RunStatus.RUNNING, CODEX));

  // 'message' is what a client renders as "Queued" with a withdraw — which is exactly what this
  // is. A blank kind would leave every door guessing from a status it may not have caught up on.
  assert.equal(accepted.kind, 'message');
});

test('a steer still needs a live engine turn, not merely a runner that could deliver one', async () => {
  // The capability says the message CAN be written into a running turn — not that there is one.
  // An idle session, or an in-flight row whose lease has expired (an engine that stopped
  // answering), leaves nothing to fold it into.
  const idle = makeService(0, RunStatus.AWAITING_INPUT, CODEX, DECLARES_CODEX_STEER);
  await send(idle);
  assert.equal(idle.created[0].kind, 'message');

  const running = makeService(1, RunStatus.RUNNING, CODEX, DECLARES_CODEX_STEER);
  await send(running);
  const probe = running.countFilters.at(-1) as { kind: unknown; status: unknown; leaseDeadlineAt: unknown };
  assert.equal(probe.kind, 'message');
  assert.equal(probe.status, 'IN_FLIGHT');
  assert.ok((probe.leaseDeadlineAt as { gt?: Date })?.gt instanceof Date);
});

/**
 * A retried send never becomes a second message.
 *
 * This is the only de-duplication in the whole path, and everything downstream leans on it:
 * Codex does not de-duplicate on the id Orbit sends it (docs/codex-turn-steer-contract.md §0.1),
 * so a second row here is a second `turn/steer` and a second copy of the person's message in the
 * conversation — which the model reads as being asked twice. A network retry, a double-tap on
 * Send, an MCP client replaying a request: all of them arrive as the same clientTurnId.
 */
test('sending the same clientTurnId twice mid-turn files one steer, not two', async () => {
  const already = {
    id: 'turn-existing',
    seq: 2,
    kind: 'steer',
    clientTurnId: '44444444-4444-4444-8444-444444444444',
    status: 'IN_FLIGHT',
  };
  const h = makeService(1, RunStatus.RUNNING, { provider: 'claude', providerBuiltin: true }, [], already);

  const out = await send(h);

  assert.equal(h.created.length, 0, 'a retry created a second row for one message');
  assert.equal(out.turnId, 'turn-existing');
  // Answered as the steer it already is, so the client goes on showing the delivery it was
  // already watching rather than starting a second bubble beside it.
  assert.equal(out.kind, 'steer');
});

test('a retry does not re-decide the kind, even if the turn ended in between', async () => {
  // The engine is idle now, so a fresh message here would be filed as an ordinary turn. The
  // existing row is what this message IS, though — re-deciding would tell the client its
  // in-flight steer had become a queued message and leave two things watching one row.
  const already = {
    id: 'turn-existing',
    seq: 2,
    kind: 'steer',
    clientTurnId: '44444444-4444-4444-8444-444444444444',
    status: 'IN_FLIGHT',
  };
  const h = makeService(0, RunStatus.RUNNING, { provider: 'claude', providerBuiltin: true }, [], already);

  const out = await send(h);

  assert.equal(h.created.length, 0);
  assert.equal(out.kind, 'steer');
});
