import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BadRequestException } from '@nestjs/common';
import { SessionsController } from './sessions.controller';
import { RunnerSessionsController } from '../runner-api/runner-sessions.controller';
import type { SessionInterruptDto, SessionResumeDto, SessionTurnDto } from './dto';

/**
 * `watch:` is the Watch delivery worker's turn-key namespace (docs/watch-contract.md §6), and
 * `clientTurnId` is the caller's own choice at every door onto a session. A client that queues an
 * ordinary message under `watch:<watchId>:<generation>` — or under a numeric alias of one, or under an
 * end's word — takes the key the worker is about to write: the wake can no longer be queued under it,
 * its delivery becomes a `WAKE_KEY_TAKEN` dead letter, and the observer is never woken.
 *
 * So every door refuses the prefix with a 400 that names it. Six doors let a caller name a turn key:
 * four on the public API and two on the runner API, which is what the MCP tools (`session_send`,
 * `session_interrupt`) and the CLI's `--client-turn-id` travel through. Each is pinned separately
 * because the guard has to be per-door: it cannot move into `SessionsService.createTurn`, which is
 * precisely where the delivery worker writes these keys from.
 *
 * Every case sends an ordinary key through the same door afterwards, so no case can pass by refusing
 * everything.
 */

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const OWNER_ID = '22222222-2222-4222-8222-222222222222';
const ORDINARY_KEY = '33333333-3333-4333-8333-333333333333';
/** A real wake key: a watch's REVOKED end, exactly as watch-delivery.service.ts writes one. */
const RESERVED_KEY = 'watch:44444444-4444-4444-8444-444444444444:revoked';

// `[K3]` guards attempts at the runner door; nothing here is an attempt, so both calls are no-ops.
const ATTEMPTS = { assertMayEndSession: async () => undefined, chargeSteer: async () => undefined };
const USER = { userId: OWNER_ID } as never;
const RUNNER = { ownerId: OWNER_ID } as never;
/** A live calling session with orchestration enabled: the runner door's own precondition. */
const CALLER = 'caller-session';

function doors() {
  const turns: SessionTurnDto[] = [];
  const resumes: SessionResumeDto[] = [];
  const interrupts: Array<SessionInterruptDto | undefined> = [];
  const sessions = {
    createTurn: async (_ownerId: string, _id: string, dto: SessionTurnDto) => {
      turns.push(dto);
      return { turnId: 'turn-1', seq: 1, kind: 'message', placement: 'queued' };
    },
    resume: async (_ownerId: string, _id: string, dto: SessionResumeDto) => {
      resumes.push(dto);
      return { turnId: 'turn-2', seq: 2 };
    },
    interrupt: async (_ownerId: string, _id: string, dto?: SessionInterruptDto) => {
      interrupts.push(dto);
      return dto?.content ? { ok: true as const, turnId: 'turn-3', seq: 3 } : { ok: true as const };
    },
    assertHostedByRunner: async () => undefined,
  };
  const browser = new SessionsController(sessions as never, {} as never, {} as never, {} as never, {} as never);
  const runner = new RunnerSessionsController(
    sessions as never,
    { assert: async () => undefined } as never,
    {} as never,
    ATTEMPTS as never,
  );
  return { turns, resumes, interrupts, browser, runner };
}

/** What each door owes a caller that named a reserved key: a 400 saying which prefix it may not use. */
async function refuses(door: string, call: () => Promise<unknown>): Promise<void> {
  const thrown = await call().then(
    () => undefined,
    (error: unknown) => error,
  );
  assert.ok(
    thrown instanceof BadRequestException,
    `${door} did not refuse a watch: clientTurnId (${thrown === undefined ? 'it succeeded' : String(thrown)})`,
  );
  assert.equal(thrown.getStatus(), 400, `${door} refused with the wrong status`);
  const refusal = JSON.stringify(thrown.getResponse());
  assert.match(refusal, /watch:/, `${door}'s refusal does not name the reserved prefix: ${refusal}`);
  assert.match(refusal, /reserved/i, `${door}'s refusal does not say the prefix is reserved: ${refusal}`);
}

test('POST /api/sessions/:id/turns refuses a clientTurnId in the wake namespace', async () => {
  const d = doors();

  await refuses('the public turn route', async () =>
    d.browser.turn(USER, SESSION_ID, {
      clientTurnId: RESERVED_KEY,
      content: 'a note from the owner, not a wake',
    }),
  );
  assert.equal(d.turns.length, 0, 'a refused turn still reached the service');

  // The control: an ordinary key travels through untouched, and so does a key that merely begins with
  // the same letters — the namespace is `watch:`, not every word starting with "watch".
  await d.browser.turn(USER, SESSION_ID, { clientTurnId: ORDINARY_KEY, content: 'an ordinary message' });
  await d.browser.turn(USER, SESSION_ID, { clientTurnId: 'watching:the-build', content: 'not a wake key' });
  assert.deepEqual(
    d.turns.map((dto) => dto.clientTurnId),
    [ORDINARY_KEY, 'watching:the-build'],
  );
});

test('POST /api/sessions/:id/turns/current-work-routing refuses a clientTurnId in the wake namespace', async () => {
  const d = doors();

  await refuses('the routed turn route', async () =>
    d.browser.routedTurn(USER, SESSION_ID, {
      clientTurnId: RESERVED_KEY,
      content: 'join the turn that is running',
      intent: 'CURRENT_WORK',
    }),
  );
  assert.equal(d.turns.length, 0, 'a refused routed turn still reached the service');

  await d.browser.routedTurn(USER, SESSION_ID, {
    clientTurnId: ORDINARY_KEY,
    content: 'join the turn that is running',
    intent: 'CURRENT_WORK',
  });
  assert.equal(d.turns.length, 1);
  assert.equal(d.turns[0].clientTurnId, ORDINARY_KEY);
});

test('POST /api/sessions/:id/resume refuses a clientTurnId in the wake namespace', async () => {
  const d = doors();

  // Reviving is a superset of sending, and the turn it seeds carries the caller's key just the same.
  await refuses('the resume route', async () =>
    d.browser.resume(USER, SESSION_ID, {
      clientTurnId: RESERVED_KEY,
      content: 'wake up and carry on',
    }),
  );
  assert.equal(d.resumes.length, 0, 'a refused resume still reached the service');

  await d.browser.resume(USER, SESSION_ID, { clientTurnId: ORDINARY_KEY, content: 'wake up and carry on' });
  assert.equal(d.resumes.length, 1);
  assert.equal(d.resumes[0].clientTurnId, ORDINARY_KEY);
});

test('POST /api/sessions/:id/interrupt refuses a follow-up keyed in the wake namespace', async () => {
  const d = doors();

  await refuses('the interrupt route', async () =>
    d.browser.interrupt(USER, SESSION_ID, {
      clientTurnId: RESERVED_KEY,
      content: 'stop that and do this instead',
    }),
  );
  assert.equal(d.interrupts.length, 0, 'a refused interrupt-and-send still reached the service');

  // The control, and the case the guard must not touch: an ordinary follow-up, and a bodyless
  // interrupt, which names no key at all.
  await d.browser.interrupt(USER, SESSION_ID, {
    clientTurnId: ORDINARY_KEY,
    content: 'stop that and do this instead',
  });
  await d.browser.interrupt(USER, SESSION_ID, undefined);
  assert.deepEqual(
    d.interrupts.map((dto) => dto?.clientTurnId),
    [ORDINARY_KEY, undefined],
  );
});

test('POST /runner/sessions/:id/turns refuses a clientTurnId in the wake namespace, trimmed first', async () => {
  const d = doors();

  await refuses('the runner send door', async () =>
    d.runner.sendMessage(RUNNER, undefined, CALLER, 'tok', SESSION_ID, {
      message: 'a message from an agent, not a wake',
      clientTurnId: RESERVED_KEY,
    }),
  );
  // This door trims before it files, so the padded key is the same key and is refused as one. Judging
  // the untrimmed value would let `session_send` file a wake key with a space on the end.
  await refuses('the runner send door, padded', async () =>
    d.runner.sendMessage(RUNNER, undefined, CALLER, 'tok', SESSION_ID, {
      message: 'a message from an agent, not a wake',
      clientTurnId: `  ${RESERVED_KEY}  `,
    }),
  );
  assert.equal(d.turns.length, 0, 'a refused runner send still reached the service');

  // The controls: the caller's own key survives, and a caller that names none still gets one minted.
  await d.runner.sendMessage(RUNNER, undefined, CALLER, 'tok', SESSION_ID, {
    message: 'again',
    clientTurnId: ORDINARY_KEY,
  });
  await d.runner.sendMessage(RUNNER, undefined, CALLER, 'tok', SESSION_ID, { message: 'fresh' });
  assert.equal(d.turns.length, 2);
  assert.equal(d.turns[0].clientTurnId, ORDINARY_KEY);
  assert.match(d.turns[1].clientTurnId, /^[0-9a-f-]{36}$/);
});

test('POST /runner/sessions/:id/interrupt refuses a follow-up keyed in the wake namespace', async () => {
  const d = doors();

  await refuses('the runner interrupt door', async () =>
    d.runner.interruptSession(RUNNER, undefined, CALLER, 'tok', SESSION_ID, {
      message: 'stop, do this instead',
      clientTurnId: RESERVED_KEY,
    }),
  );
  assert.equal(d.interrupts.length, 0, 'a refused runner interrupt-and-send still reached the service');

  await d.runner.interruptSession(RUNNER, undefined, CALLER, 'tok', SESSION_ID, {
    message: 'stop, do this instead',
    clientTurnId: ORDINARY_KEY,
  });
  await d.runner.interruptSession(RUNNER, undefined, CALLER, 'tok', SESSION_ID, undefined);
  assert.deepEqual(
    d.interrupts.map((dto) => dto?.clientTurnId),
    [ORDINARY_KEY, undefined],
  );
});
