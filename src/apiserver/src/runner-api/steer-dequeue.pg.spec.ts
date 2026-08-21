import assert from 'node:assert/strict';
import { before, after, beforeEach, test } from 'node:test';
import { Client } from 'pg';
import { RunStatus } from '@prisma/client';
import { AgentProvider, SESSION_CODEX_STEER_V1 } from '@orbit/shared';
import { RunnerApiController } from './runner-api.controller';

/**
 * What the inbox predicate actually selects, run as SQL against a real Postgres.
 *
 * The stubbed specs beside this one can only report the SQL they were handed; a predicate
 * that let everything through would satisfy every one of them. This runs the real statement
 * against real rows, which is the only way "the ordinary message is still gated" is a fact
 * rather than a regex.
 *
 * Needs a database: set ORBIT_TEST_PG_URL (any empty Postgres — the two tables the predicate
 * touches are created here, not the application schema). Without it the file reports that it
 * did not run, rather than passing quietly.
 */

const PG_URL = process.env.ORBIT_TEST_PG_URL;
const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const RUNNER_ID = '22222222-2222-4222-8222-222222222222';
const OWNER_ID = '33333333-3333-4333-8333-333333333333';
/** What a runner that implements codex `turn/steer` declares; irrelevant to a claude session. */
const DECLARES_CODEX_STEER = [SESSION_CODEX_STEER_V1];

type Dequeue = (
  sessionId: string,
  runnerId: string,
  leaseGeneration: string | null,
  acceptsSteer: boolean,
  declaredCapabilities: readonly string[],
) => Promise<{ turnId: string; kind: string; content?: string } | null>;

let client: Client;

before(async () => {
  if (!PG_URL) return;
  client = new Client({ connectionString: PG_URL });
  await client.connect();
  // Only the columns the predicate reads. Deliberately not the application schema: this is a
  // test of one WHERE clause, and pulling in migrations would make it a test of those too.
  await client.query(`
    DROP TABLE IF EXISTS "conversation_turn";
    DROP TABLE IF EXISTS "session";
    CREATE TABLE "session" (
      id uuid PRIMARY KEY,
      owner_id uuid,
      assigned_runner_id uuid,
      inbox_lease_generation uuid,
      inbox_lease_owner uuid,
      provider text NOT NULL DEFAULT 'claude',
      provider_builtin boolean NOT NULL DEFAULT true,
      status text NOT NULL,
      cancel_requested_at timestamptz
    );
    CREATE TABLE "conversation_turn" (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      session_id uuid NOT NULL,
      seq int NOT NULL,
      kind text NOT NULL,
      content text,
      status text NOT NULL,
      delivered_at timestamptz,
      lease_deadline_at timestamptz,
      lease_generation uuid
    );
  `);
});

after(async () => {
  await client?.end();
});

beforeEach(async () => {
  if (!PG_URL) return;
  await client.query(`TRUNCATE "conversation_turn"; DELETE FROM "session";`);
  await session(AgentProvider.CLAUDE);
});

/** (Re)create the session under test on a given runtime. */
async function session(provider: string) {
  await client.query(`DELETE FROM "session"`);
  await client.query(
    `INSERT INTO "session"(id, owner_id, assigned_runner_id, provider, status)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5)`,
    [SESSION_ID, OWNER_ID, RUNNER_ID, provider, RunStatus.RUNNING],
  );
}

/** Prisma's tagged-template $queryRaw, forwarded to a real connection as $1,$2,… */
function pgTx() {
  return {
    $queryRaw: async (strings: readonly string[], ...values: unknown[]) => {
      const text = strings.reduce((sql, part, i) => sql + part + (i < values.length ? `$${i + 1}` : ''), '');
      return (await client.query(text, values as never[])).rows;
    },
    // Everything past the predicate is stubbed: this file is about which row is chosen.
    runEvent: { findFirst: async () => null },
    attachment: { findMany: async () => [] },
    session: { findUnique: async () => null },
    conversationTurn: { updateMany: async () => ({ count: 1 }) },
  };
}

/**
 * `acceptsSteer` is the poller saying it knows the kind — what every current runner sends —
 * and `declared` is what it says it can actually deliver for. The two are separate on the wire
 * and separate here: a runner can know the word and still have no way to write a message into
 * this session's engine.
 */
function dequeue(
  acceptsSteer = true,
  declared: readonly string[] = DECLARES_CODEX_STEER,
): Promise<{ turnId: string; kind: string; content?: string } | null> {
  const tx = pgTx();
  const prisma = { $transaction: async (fn: (t: typeof tx) => unknown) => fn(tx) } as never;
  const controller = new RunnerApiController(
    prisma,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    { appendFor: async (_tx: unknown, _sessionId: unknown, content?: string) => content } as never,
  );
  return (controller as unknown as { dequeueTurn: Dequeue }).dequeueTurn.call(
    controller,
    SESSION_ID,
    RUNNER_ID,
    null,
    acceptsSteer,
    declared,
  );
}

async function addTurn(seq: number, kind: string, status: string, content: string, leaseMs?: number) {
  const lease = leaseMs === undefined ? null : new Date(Date.now() + leaseMs);
  await client.query(
    `INSERT INTO "conversation_turn"(session_id, seq, kind, status, content, lease_deadline_at)
     VALUES ($1::uuid, $2, $3, $4, $5, $6)`,
    [SESSION_ID, seq, kind, status, content, lease],
  );
}

const pgTest = (name: string, body: () => Promise<void>) =>
  test(name, { skip: PG_URL ? false : 'set ORBIT_TEST_PG_URL to run the inbox predicate against Postgres' }, body);

pgTest('a steer is handed over mid-turn while the message behind it keeps waiting', async () => {
  await addTurn(1, 'message', 'IN_FLIGHT', 'rename the widget', 60_000);
  await addTurn(2, 'steer', 'PENDING', 'actually, call it gadget');
  await addTurn(3, 'message', 'PENDING', 'and now revert it');

  const first = await dequeue();
  assert.equal(first?.kind, 'steer');
  assert.equal(first?.content, 'actually, call it gadget');

  // The queued message is still gated: the running turn holds the slot, and the steer that
  // just went past it took nothing.
  assert.equal(await dequeue(), null);
});

pgTest('a steer waits while nothing is running, and the ordinary message goes first', async () => {
  await addTurn(1, 'steer', 'PENDING', 'nothing to steer');
  await addTurn(2, 'message', 'PENDING', 'the real turn');

  const first = await dequeue();
  assert.equal(first?.kind, 'message');
  assert.equal(first?.content, 'the real turn');
});

pgTest('an expired lease is not a running turn, so a steer stays put', async () => {
  await addTurn(1, 'message', 'IN_FLIGHT', 'abandoned by a dead runner', -60_000);
  await addTurn(2, 'steer', 'PENDING', 'nobody is listening');

  // The abandoned turn is re-delivered to whoever took over; the steer is not, because
  // there is no live engine turn to fold it into.
  const first = await dequeue();
  assert.equal(first?.kind, 'message');
  assert.equal(first?.content, 'abandoned by a dead runner');
});

pgTest('a `!cmd` shell turn is not an engine turn, so a steer does not ride along with it', async () => {
  await addTurn(1, 'shell', 'IN_FLIGHT', 'ls -la', 60_000);
  await addTurn(2, 'steer', 'PENDING', 'there is no turn to steer');

  assert.equal(await dequeue(), null);
});

pgTest('a delivered steer is never leased a second time', async () => {
  await addTurn(1, 'message', 'IN_FLIGHT', 'rename the widget', 60_000);
  await addTurn(2, 'steer', 'IN_FLIGHT', 'already written', -60_000);

  // Its lease expired with the runner that held it. Re-writing a message the engine may
  // already have acted on is the one thing mid-turn delivery must not do.
  assert.equal(await dequeue(), null);
});

pgTest('an interrupt still overtakes a steer', async () => {
  await addTurn(1, 'message', 'IN_FLIGHT', 'rename the widget', 60_000);
  await addTurn(2, 'steer', 'PENDING', 'change course');
  await addTurn(3, 'interrupt', 'PENDING', '');

  const first = await dequeue();
  assert.equal(first?.kind, 'interrupt');
});

// ── interrupt-and-send ──────────────────────────────────────────────────────────────
//
// The two rows the interrupt endpoint writes, seen from the runner's side. What makes
// "interrupt, then do this instead" safe is not a promise in the runner but the predicate
// below: the interrupt goes through immediately, and the follow-up — an ordinary message,
// deliberately not a steer — is gated behind the very turn it is meant to replace. So the
// new frame cannot be folded into that turn, whether the interrupt lands or not.

pgTest('the interrupt goes first and its follow-up waits for the turn it is replacing', async () => {
  await addTurn(1, 'message', 'IN_FLIGHT', 'refactor everything', 60_000);
  await addTurn(2, 'interrupt', 'PENDING', '');
  await addTurn(3, 'message', 'PENDING', 'stop — just rename the one file');

  const first = await dequeue();
  assert.equal(first?.kind, 'interrupt');

  // Still nothing: the turn being stopped holds the slot. The redirection reaches the
  // engine as its own turn, after that one is over — never written into it.
  assert.equal(await dequeue(), null);
});

pgTest('the follow-up is handed over once the interrupted turn is out of flight', async () => {
  await addTurn(1, 'message', 'ANSWERED', 'refactor everything');
  await addTurn(2, 'interrupt', 'ANSWERED', '');
  await addTurn(3, 'message', 'PENDING', 'stop — just rename the one file');

  const next = await dequeue();
  assert.equal(next?.kind, 'message');
  assert.equal(next?.content, 'stop — just rename the one file');
});

pgTest('a follow-up filed as an ordinary message can never ride into the running turn', async () => {
  await addTurn(1, 'message', 'IN_FLIGHT', 'refactor everything', 60_000);
  await addTurn(2, 'interrupt', 'ANSWERED', '');
  await addTurn(3, 'message', 'PENDING', 'stop — just rename the one file');

  // The same three rows with the follow-up filed as a steer WOULD be handed over here.
  // That difference is the whole reason interrupt files a message rather than letting
  // createTurn decide the kind.
  assert.equal(await dequeue(), null);
});

pgTest('a poller that does not know the kind is handed no steer, and the queue is not stuck on it', async () => {
  await addTurn(1, 'message', 'IN_FLIGHT', 'rename the widget', 60_000);
  await addTurn(2, 'steer', 'PENDING', 'actually, call it gadget');

  // A runner older than the control plane has no case for a steer in its inbox switch, so
  // leasing it to that poller would drop the message for good — a steer's lease is never
  // reclaimed. Withheld, it stays PENDING, which turn-complete turns back into an ordinary
  // message when the running turn ends: a turn later, not lost.
  assert.equal(await dequeue(false), null);

  // Still there, and still a steer, for a poller that can act on it.
  const forACurrentRunner = await dequeue(true);
  assert.equal(forACurrentRunner?.kind, 'steer');
});

// ── which engine the poller can steer, not merely whether it knows the word ──────────────
//
// Every runner in the field sends acceptsSteer. Only some of them can write a message into a
// codex turn (`turn/steer`), and the ones that cannot answer it by failing the message in
// front of the user. So the gate is per runtime, re-asked of the poller on every poll, and
// what it withholds is never lost: the row stays PENDING and turn-complete re-files it as an
// ordinary message when the running turn ends.

pgTest('a codex steer waits for a poller that can deliver one, and is not lost meanwhile', async () => {
  await session(AgentProvider.CODEX);
  await addTurn(1, 'message', 'IN_FLIGHT', 'rename the widget', 60_000);
  await addTurn(2, 'steer', 'PENDING', 'actually, call it gadget');

  // Knows the kind, cannot deliver it for this engine: this is every runner shipped before
  // `turn/steer`, and handing it the steer would fail the message instead of queueing it.
  assert.equal(await dequeue(true, []), null);
  assert.equal(await dequeue(true, ['session-worktree-ops-v1']), null);

  // The row is untouched by having been withheld — the runner that can steer codex still gets it.
  const forACapableRunner = await dequeue(true, DECLARES_CODEX_STEER);
  assert.equal(forACapableRunner?.kind, 'steer');
  assert.equal(forACapableRunner?.content, 'actually, call it gadget');
});

pgTest('a claude steer is never gated on the codex declaration', async () => {
  await addTurn(1, 'message', 'IN_FLIGHT', 'rename the widget', 60_000);
  await addTurn(2, 'steer', 'PENDING', 'actually, call it gadget');

  // Claude's mid-turn delivery shipped with the kind itself. A runner that declares nothing
  // beyond knowing the word still steers claude, exactly as it does in production today.
  assert.equal((await dequeue(true, []))?.kind, 'steer');
});

pgTest('withholding a codex steer withholds nothing else on that session', async () => {
  await session(AgentProvider.CODEX);
  await addTurn(1, 'message', 'PENDING', 'the real turn');
  await addTurn(2, 'interrupt', 'PENDING', '');

  // The gate covers one kind for one runtime. A poller that cannot steer codex still gets its
  // interrupts and its ordinary turns at exactly the priority it always did.
  assert.equal((await dequeue(true, []))?.kind, 'interrupt');
  assert.equal((await dequeue(true, []))?.content, 'the real turn');
});

pgTest('withholding a steer does not withhold anything else', async () => {
  await addTurn(1, 'message', 'PENDING', 'the real turn');
  await addTurn(2, 'interrupt', 'PENDING', '');

  // The capability covers one kind. An old poller still gets its interrupts, its messages
  // and everything else at exactly the priority it always did.
  assert.equal((await dequeue(false))?.kind, 'interrupt');
  assert.equal((await dequeue(false))?.content, 'the real turn');
});
