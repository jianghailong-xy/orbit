import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BadRequestException } from '@nestjs/common';
import { SessionsController } from './sessions.controller';
import { RunnerSessionsController } from '../runner-api/runner-sessions.controller';
import { RunnerProjectsController } from '../runner-api/runner-projects.controller';
import { OPEN_ITEM_TURN_PREFIX, openItemIdOfTurn, openItemTurnId } from '../projects/project-open-item';
import { assertClientTurnIdNotReserved, OPEN_ITEM_TURN_KEY_PREFIX } from './watch-turn-key';
import type { SessionInterruptDto, SessionResumeDto, SessionTurnDto } from './dto';

/**
 * `open-item:v1:` is the namespace the platform hands an exception item to its coordinator in
 * (projects/project-open-item.ts `openItemTurnId`), and the item is read back off the turn's own key
 * wherever the turn is drawn — the card the queue and the echo show (sessions/turn-cards.ts). A
 * caller who could name a turn key in it named an item by id: before the tenant isolation census
 * (docs/google-sign-in-design.md §11 T2) another account's, whose card — its title, its task, its
 * conflict files, its project's branches — then came back on the caller's own turn. Every door that
 * lets a caller name a turn key refuses the namespace, as it refuses `watch:`.
 *
 * Every door also takes an ordinary key afterwards, and one that only starts with the same letters,
 * so no case can pass by refusing everything.
 */

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const OWNER_ID = '22222222-2222-4222-8222-222222222222';
const ORDINARY_KEY = '33333333-3333-4333-8333-333333333333';
/** A key exactly as the platform mints one for an item. */
const RESERVED_KEY = openItemTurnId('44444444-4444-4444-8444-444444444444', new Date('2026-10-07T00:00:00.000Z'));
/** The same letters, not the namespace. */
const LOOKALIKE_KEY = 'open-items-to-read';
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
  const autoRetry = {
    resendRetryMessage: async (_ownerId: string, _id: string) => ({ turnId: 'turn-4', seq: 4 }),
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

/** The seven doors a caller names a turn key at, each called with the key under test. */
const DOORS: Array<{ door: string; call: (d: Doors, clientTurnId: string) => Promise<unknown> }> = [
  { door: 'POST /api/sessions/:id/turns', call: (d, key) => d.browser.turn(USER, SESSION_ID, { clientTurnId: key, content: 'hi' }) },
  {
    door: 'POST /api/sessions/:id/turns/current-work-routing',
    call: (d, key) => d.browser.routedTurn(USER, SESSION_ID, { clientTurnId: key, content: 'hi', intent: 'NEXT_TURN' }),
  },
  { door: 'POST /api/sessions/:id/resume', call: (d, key) => d.browser.resume(USER, SESSION_ID, { clientTurnId: key, content: 'hi' }) },
  { door: 'POST /api/sessions/:id/interrupt', call: (d, key) => d.browser.interrupt(USER, SESSION_ID, { clientTurnId: key, content: 'hi' }) },
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

test('the open-item namespace refused at the doors is the one the platform keys item deliveries in', () => {
  assert.equal(OPEN_ITEM_TURN_KEY_PREFIX, OPEN_ITEM_TURN_PREFIX);
  assert.equal(openItemIdOfTurn(RESERVED_KEY), '44444444-4444-4444-8444-444444444444');
  assert.throws(() => assertClientTurnIdNotReserved(RESERVED_KEY), BadRequestException);
  assert.doesNotThrow(() => assertClientTurnIdNotReserved(LOOKALIKE_KEY));
});

for (const { door, call } of DOORS) {
  test(`${door} refuses a clientTurnId in the open-item: namespace`, async () => {
    const d = doors();
    const thrown = await (async () => call(d, RESERVED_KEY))().then(() => undefined, (error: unknown) => error);
    assert.ok(thrown instanceof BadRequestException, `${door} did not refuse it (${String(thrown)})`);
    assert.equal(thrown.getStatus(), 400);
    const refusal = JSON.stringify(thrown.getResponse());
    assert.match(refusal, /open-item:v1:/, `the refusal does not name the prefix: ${refusal}`);
    assert.match(refusal, /reserved/i);
    assert.deepEqual(d.keys, [], 'a refused call still reached the service');

    await call(d, ORDINARY_KEY);
    await call(d, LOOKALIKE_KEY);
    assert.deepEqual(d.keys.filter((key) => key === ORDINARY_KEY || key === LOOKALIKE_KEY), [ORDINARY_KEY, LOOKALIKE_KEY]);
  });
}
