import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BadRequestException } from '@nestjs/common';
import { SessionsController } from './sessions.controller';
import { RunnerSessionsController } from '../runner-api/runner-sessions.controller';
import { RunnerProjectsController } from '../runner-api/runner-projects.controller';
import { SESSION_REPLY_TURN_PREFIX } from './session-request';
import { assertClientTurnIdNotReserved, SESSION_REPLY_TURN_KEY_PREFIX } from './watch-turn-key';
import type { SessionInterruptDto, SessionResumeDto, SessionTurnDto } from './dto';

/**
 * `session-reply:` is the namespace the platform hands a session request's outcome back in
 * (docs/session-request-reply-contract.md §4.2, §8 criterion 10). An asker's queued reply turn is found
 * by that prefix and the outcomes that arrive while it waits are filed onto it, so a message a caller
 * queued under the prefix would be taken for one: outcomes would be delivered as whatever its author
 * wrote. Every door that lets a caller name a turn key refuses it, as it refuses `watch:` — the same
 * eight doors `watch-turn-key-reserved.spec.ts` pins, through the same guard.
 *
 * Every door also takes an ordinary key afterwards, and one that only starts with the same letters,
 * so no case can pass by refusing everything.
 */

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const OWNER_ID = '22222222-2222-4222-8222-222222222222';
const ORDINARY_KEY = '33333333-3333-4333-8333-333333333333';
/** A key shaped exactly like the ones SessionRequestService.handOff mints. */
const RESERVED_KEY = `${SESSION_REPLY_TURN_PREFIX}44444444-4444-4444-8444-444444444444:0a1b2c3d`;
/** The same letters, not the namespace. */
const LOOKALIKE_KEY = 'session-replying-later';
const PROJECT_ID = '55555555-5555-4555-8555-555555555555';

const ATTEMPTS = { assertMayEndSession: async () => undefined, chargeSteer: async () => undefined };
const USER = { userId: OWNER_ID } as never;
const RUNNER = { ownerId: OWNER_ID } as never;
const CALLER = 'caller-session';

function doors() {
  const keys: Array<string | undefined> = [];
  const sessions = {
    createTurn: async (_ownerId: string, _id: string, dto: SessionTurnDto) => {
      keys.push(dto.clientTurnId);
      return { turnId: 'turn-1', seq: 1, kind: 'message', placement: 'queued' };
    },
    resume: async (_ownerId: string, _id: string, dto: SessionResumeDto) => {
      keys.push(dto.clientTurnId);
      return { turnId: 'turn-2', seq: 2 };
    },
    interrupt: async (_ownerId: string, _id: string, dto?: SessionInterruptDto) => {
      keys.push(dto?.clientTurnId);
      return { ok: true as const };
    },
    assertHostedByRunner: async () => undefined,
  };
  // The failure card's Retry asks the server to re-send under a key the caller chose.
  const autoRetry = {
    resendRetryMessage: async (_ownerId: string, _id: string, clientTurnId: string) => {
      keys.push(clientTurnId);
      return { turnId: 'turn-4', seq: 4 };
    },
  };
  const projects = {
    sendToCoordinator: async (_o: string, _p: string, _a: string, _m: string, clientTurnId: string) => {
      keys.push(clientTurnId);
      return { sessionId: 'coordinator-session', created: false, workspaceId: null, turn: { clientTurnId } };
    },
  };
  return {
    keys,
    browser: new SessionsController(sessions as never, {} as never, {} as never, {} as never, {} as never, autoRetry as never),
    runner: new RunnerSessionsController(sessions as never, { assert: async () => undefined } as never, {} as never, ATTEMPTS as never),
    project: new RunnerProjectsController(projects as never, {} as never, {} as never, { assert: async () => CALLER } as never),
  };
}

type Doors = ReturnType<typeof doors>;

/** The eight doors, each called with the key under test. */
const DOORS: Array<{ door: string; call: (d: Doors, clientTurnId: string) => Promise<unknown> }> = [
  { door: 'POST /api/sessions/:id/turns', call: (d, key) => d.browser.turn(USER, SESSION_ID, { clientTurnId: key, content: 'hi' }) },
  {
    door: 'POST /api/sessions/:id/turns/current-work-routing',
    call: (d, key) => d.browser.routedTurn(USER, SESSION_ID, { clientTurnId: key, content: 'hi', intent: 'NEXT_TURN' }),
  },
  { door: 'POST /api/sessions/:id/resume', call: (d, key) => d.browser.resume(USER, SESSION_ID, { clientTurnId: key, content: 'hi' }) },
  { door: 'POST /api/sessions/:id/interrupt', call: (d, key) => d.browser.interrupt(USER, SESSION_ID, { clientTurnId: key, content: 'hi' }) },
  {
    door: 'POST /api/sessions/:id/retry-message',
    call: (d, key) => d.browser.resendRetryMessage(USER, SESSION_ID, { clientTurnId: key }),
  },
  {
    door: 'POST /runner/sessions/:id/turns',
    call: (d, key) => d.runner.sendMessage(RUNNER, undefined, CALLER, 'tok', SESSION_ID, { message: 'hi', clientTurnId: key }),
  },
  {
    door: 'POST /runner/sessions/:id/interrupt',
    call: (d, key) => d.runner.interruptSession(RUNNER, undefined, CALLER, 'tok', SESSION_ID, { message: 'hi', clientTurnId: key }),
  },
  {
    door: 'POST /runner/projects/:id/coordinator/messages',
    call: (d, key) => d.project.sendToCoordinator(RUNNER, PROJECT_ID, CALLER, 'tok', { message: 'hi', clientTurnId: key }),
  },
];

test('the reply namespace is the one the hand-off writes', () => {
  assert.equal(SESSION_REPLY_TURN_PREFIX, SESSION_REPLY_TURN_KEY_PREFIX);
  assert.equal(SESSION_REPLY_TURN_KEY_PREFIX, 'session-reply:');
  assert.throws(() => assertClientTurnIdNotReserved(RESERVED_KEY), BadRequestException);
  assert.doesNotThrow(() => assertClientTurnIdNotReserved(LOOKALIKE_KEY));
  assert.doesNotThrow(() => assertClientTurnIdNotReserved(undefined));
});

for (const { door, call } of DOORS) {
  test(`${door} refuses a clientTurnId in the session-reply: namespace`, async () => {
    const d = doors();
    // Wrapped, as watch-turn-key-reserved.spec.ts wraps its calls: the browser routes are not async
    // and refuse by throwing before they return a promise at all.
    const thrown = await (async () => call(d, RESERVED_KEY))().then(() => undefined, (error: unknown) => error);
    assert.ok(thrown instanceof BadRequestException, `${door} did not refuse it (${String(thrown)})`);
    assert.equal(thrown.getStatus(), 400);
    const refusal = JSON.stringify(thrown.getResponse());
    assert.match(refusal, /session-reply:/, `the refusal does not name the prefix: ${refusal}`);
    assert.match(refusal, /reserved/i);
    assert.deepEqual(d.keys, [], 'a refused call still reached the service');

    // The controls: an ordinary key, and one that only looks like the namespace, go through as given.
    await call(d, ORDINARY_KEY);
    await call(d, LOOKALIKE_KEY);
    assert.deepEqual(d.keys.filter((key) => key === ORDINARY_KEY || key === LOOKALIKE_KEY), [ORDINARY_KEY, LOOKALIKE_KEY]);
  });
}
