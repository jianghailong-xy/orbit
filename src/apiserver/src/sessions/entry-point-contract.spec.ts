import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SessionsController } from './sessions.controller';
import { RunnerSessionsController } from '../runner-api/runner-sessions.controller';
import type { SessionTurnDto, SessionInterruptDto } from './dto';

/**
 * Every door onto a session — the browser, macOS/iOS, the HTTP API, the runner's MCP tools and
 * CLI — reaches ONE service. This pins that: the same intent, expressed at any of them, arrives
 * as the same call, with the same idempotency key, the same kind decision (the server's, never
 * the caller's) and the same shape of answer.
 *
 * The dimensions checked here are the ones that used to differ per door:
 *   - kind/mode: nobody may ASK to steer; the server decides (see steer-kind.spec.ts).
 *   - clientTurnId: every door is idempotent under retry, including the runner's.
 *   - interrupt vs interrupt-and-send: one endpoint, one transaction, from every door.
 *
 * Controllers are exercised directly with a recording service. What travels between the door and
 * the service is exactly what this is about; the service's own behaviour is tested next door.
 */

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const OWNER_ID = '22222222-2222-4222-8222-222222222222';
const CLIENT_TURN_ID = '33333333-3333-4333-8333-333333333333';

type TurnCall = { ownerId: string; id: string; dto: SessionTurnDto };
type InterruptCall = { ownerId: string; id: string; dto?: SessionInterruptDto };

function doors() {
  const turns: TurnCall[] = [];
  const interrupts: InterruptCall[] = [];
  const sessions = {
    createTurn: async (ownerId: string, id: string, dto: SessionTurnDto) => {
      turns.push({ ownerId, id, dto });
      // What every door hands back: the turn, its order, and what the server FILED it as.
      return { turnId: 'turn-1', seq: 7, kind: 'steer' };
    },
    interrupt: async (ownerId: string, id: string, dto?: SessionInterruptDto) => {
      interrupts.push({ ownerId, id, dto });
      return dto?.content ? { ok: true as const, turnId: 'turn-2', seq: 8 } : { ok: true as const };
    },
    assertHostedByRunner: async () => undefined,
  };
  const browser = new SessionsController(sessions as never, {} as never, {} as never, {} as never, {} as never);
  const runner = new RunnerSessionsController(sessions as never, {
    assert: async () => undefined,
  } as never, {} as never);
  return { turns, interrupts, browser, runner };
}

const RUNNER = { ownerId: OWNER_ID } as never;
// A live calling session with orchestration enabled: the runner door's own precondition, and
// not what is under test here.
const CALLER = 'caller-session';

test('a send arrives at one service from either door, carrying the same fields', async () => {
  const d = doors();

  await d.browser.turn({ userId: OWNER_ID } as never, SESSION_ID, {
    clientTurnId: CLIENT_TURN_ID,
    content: 'do the thing',
  });
  await d.runner.sendMessage(RUNNER, undefined, CALLER, 'tok', SESSION_ID, {
    message: 'do the thing',
    clientTurnId: CLIENT_TURN_ID,
  });

  assert.equal(d.turns.length, 2);
  const [fromBrowser, fromRunner] = d.turns;
  assert.deepEqual(
    { ...fromBrowser, dto: { ...fromBrowser.dto } },
    { ...fromRunner, dto: { ...fromRunner.dto } },
  );
  assert.equal(fromRunner.dto.content, 'do the thing');
  assert.equal(fromRunner.dto.clientTurnId, CLIENT_TURN_ID);
});

test('the runner door is idempotent when the caller supplies a key, and still works without one', async () => {
  const d = doors();

  // An MCP tool call or `orbit session send` retried after a lost answer repeats its key, and the
  // service returns the turn it already filed instead of queueing the message a second time.
  await d.runner.sendMessage(RUNNER, undefined, CALLER, 'tok', SESSION_ID, {
    message: 'again',
    clientTurnId: CLIENT_TURN_ID,
  });
  await d.runner.sendMessage(RUNNER, undefined, CALLER, 'tok', SESSION_ID, {
    message: 'again',
    clientTurnId: CLIENT_TURN_ID,
  });
  assert.equal(d.turns[0].dto.clientTurnId, CLIENT_TURN_ID);
  assert.equal(d.turns[1].dto.clientTurnId, CLIENT_TURN_ID);

  // Omitted, the door mints one — a caller that never retries keeps the behaviour it had.
  await d.runner.sendMessage(RUNNER, undefined, CALLER, 'tok', SESSION_ID, { message: 'fresh' });
  const minted = d.turns[2].dto.clientTurnId;
  assert.match(minted, /^[0-9a-f-]{36}$/);
  assert.notEqual(minted, CLIENT_TURN_ID);

  // A blank key is not a key. Filing one would make every blank-keyed send in a session collide
  // with the first, and the second message would silently return the first one's turn.
  await d.runner.sendMessage(RUNNER, undefined, CALLER, 'tok', SESSION_ID, {
    message: 'blank',
    clientTurnId: '   ',
  });
  assert.notEqual(d.turns[3].dto.clientTurnId.trim(), '');
  assert.notEqual(d.turns[3].dto.clientTurnId, d.turns[2].dto.clientTurnId);
});

test('no door lets a caller ask to steer', async () => {
  const d = doors();

  // `kind` is a whitelist of what a caller may REQUEST — a normal message or a `!cmd`. Steering
  // is a decision about the moment a message arrives, made under the Session row lock; a caller
  // able to claim it could have a message written into a turn that is not running.
  await d.browser.turn({ userId: OWNER_ID } as never, SESSION_ID, {
    clientTurnId: CLIENT_TURN_ID,
    content: 'sneak in',
    kind: 'steer' as never,
  });
  await d.runner.sendMessage(RUNNER, undefined, CALLER, 'tok', SESSION_ID, {
    message: 'sneak in',
  });

  // The browser DTO carries whatever was sent, but createTurn only honours 'shell' (steer-kind
  // .spec.ts pins that); the runner door has no `kind` field at all to carry one.
  assert.equal((d.turns[1].dto as { kind?: string }).kind, undefined);
});

test('the answer says what the server filed the message as, from either door', async () => {
  const d = doors();

  const fromBrowser = await d.browser.turn({ userId: OWNER_ID } as never, SESSION_ID, {
    clientTurnId: CLIENT_TURN_ID,
    content: 'x',
  });
  const fromRunner = await d.runner.sendMessage(RUNNER, undefined, CALLER, 'tok', SESSION_ID, {
    message: 'x',
  });

  // Not an echo of what was asked: a steer joins the running turn and is not withdrawable, while
  // a message waits for its own. Both doors return it, so both can say which happened.
  assert.deepEqual(fromBrowser, { turnId: 'turn-1', seq: 7, kind: 'steer' });
  assert.deepEqual(fromRunner, fromBrowser);
});

test('a plain interrupt is the same call from either door', async () => {
  const d = doors();

  await d.browser.interrupt({ userId: OWNER_ID } as never, SESSION_ID, undefined);
  await d.runner.interruptSession(RUNNER, undefined, CALLER, 'tok', SESSION_ID, undefined);

  assert.equal(d.interrupts.length, 2);
  for (const call of d.interrupts) {
    assert.equal(call.ownerId, OWNER_ID);
    assert.equal(call.id, SESSION_ID);
    // No follow-up: stopping with nothing to put in its place.
    assert.ok(!call.dto?.content);
  }
});

test('interrupt-and-send is one call from either door, never a stop followed by a send', async () => {
  const d = doors();

  await d.browser.interrupt({ userId: OWNER_ID } as never, SESSION_ID, {
    clientTurnId: CLIENT_TURN_ID,
    content: 'do this instead',
  });
  await d.runner.interruptSession(RUNNER, undefined, CALLER, 'tok', SESSION_ID, {
    message: 'do this instead',
    clientTurnId: CLIENT_TURN_ID,
  });

  // The follow-up rides on the interrupt, so it is filed after the interrupt drops what was
  // queued behind the running turn. Two requests could not express this: whichever the server
  // saw first would decide whether the redirection survived.
  assert.equal(d.turns.length, 0);
  assert.equal(d.interrupts.length, 2);
  for (const call of d.interrupts) {
    assert.equal(call.dto?.content, 'do this instead');
    assert.equal(call.dto?.clientTurnId, CLIENT_TURN_ID);
  }
});

test('the runner door mints the follow-up key when the caller has none, and stays bodyless without a message', async () => {
  const d = doors();

  await d.runner.interruptSession(RUNNER, undefined, CALLER, 'tok', SESSION_ID, {
    message: 'stop, do this',
  });
  assert.match(d.interrupts[0].dto!.clientTurnId!, /^[0-9a-f-]{36}$/);

  // Whitespace is not a follow-up: a `--message ' '` must stop the turn, not queue a blank
  // message behind it — and the service requires a key for anything it files.
  await d.runner.interruptSession(RUNNER, undefined, CALLER, 'tok', SESSION_ID, { message: '  ' });
  assert.equal(d.interrupts[1].dto, undefined);
});

test('an interrupt answers with the follow-up it queued, or with nothing but ok', async () => {
  const d = doors();

  const redirected = await d.runner.interruptSession(RUNNER, undefined, CALLER, 'tok', SESSION_ID, {
    message: 'do this instead',
  });
  const stopped = await d.runner.interruptSession(RUNNER, undefined, CALLER, 'tok', SESSION_ID, undefined);

  assert.deepEqual(redirected, { ok: true, turnId: 'turn-2', seq: 8 });
  // Accepting either is not a claim the engine stopped — the runner reports that as an
  // `interrupt` transcript event — so neither answer pretends to say so.
  assert.deepEqual(stopped, { ok: true });
});
