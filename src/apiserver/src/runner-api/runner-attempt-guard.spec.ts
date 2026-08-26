import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConflictException } from '@nestjs/common';

import { RunnerSessionsController } from './runner-sessions.controller';
import type { SessionLifecycleActor } from '../projects/attempt-budget';

// `[K3]` §3 at the door an agent actually knocks on.
//
// The refusals are only worth anything if they are checked where the difference between "a person
// stopped this run" and "another agent stopped somebody else's run" is still visible. By the time a
// request reaches SessionsService both carry the same `ownerId` and nothing else — which is exactly
// how a coordinator's `session complete` used to land on a live worker as an ordinary cancellation.
//
// So what this spec asserts is not the decision (that is `attempt-budget.spec.ts`) but the WIRING:
// which routes consult the guard, with which actor, and that a refusal stops the route before the
// session service is touched at all.

const RUNNER = { ownerId: 'owner-1' } as never;
const TARGET = 'target-session';
const COORDINATOR = 'coordinator-session';
const CREDENTIAL = 'orchestration-token';

interface GuardCall {
  guard: 'end' | 'steer';
  sessionId: string;
  actor: SessionLifecycleActor;
}

function makeController(refuse?: { guard: 'end' | 'steer'; code: string }) {
  const guardCalls: GuardCall[] = [];
  const serviceCalls: string[] = [];
  const sessions = new Proxy({}, {
    get: (_t, prop: string) => async () => {
      serviceCalls.push(prop);
      return { route: prop };
    },
  });
  const attempts = {
    assertMayEndSession: async (
      _ownerId: string, sessionId: string, actor: SessionLifecycleActor,
    ) => {
      guardCalls.push({ guard: 'end', sessionId, actor });
      if (refuse?.guard === 'end') throw new ConflictException(refuse.code);
    },
    chargeSteer: async (_ownerId: string, sessionId: string, actor: SessionLifecycleActor) => {
      guardCalls.push({ guard: 'steer', sessionId, actor });
      if (refuse?.guard === 'steer') throw new ConflictException(refuse.code);
    },
  };
  return {
    controller: new RunnerSessionsController(
      sessions as never,
      { assert: async () => undefined } as never,
      {} as never,
      attempts as never,
    ),
    guardCalls,
    serviceCalls,
  };
}

test('end, complete and delete consult the attempt guard, naming the CALLING session as the actor', async () => {
  const d = makeController();
  await d.controller.endSession(RUNNER, undefined, COORDINATOR, CREDENTIAL, TARGET);
  await d.controller.completeSession(RUNNER, undefined, COORDINATOR, CREDENTIAL, TARGET);
  await d.controller.deleteSession(RUNNER, undefined, COORDINATOR, CREDENTIAL, TARGET);

  assert.deepEqual(d.guardCalls, [
    { guard: 'end', sessionId: TARGET, actor: { kind: 'AGENT_SESSION', sessionId: COORDINATOR } },
    { guard: 'end', sessionId: TARGET, actor: { kind: 'AGENT_SESSION', sessionId: COORDINATOR } },
    { guard: 'end', sessionId: TARGET, actor: { kind: 'AGENT_SESSION', sessionId: COORDINATOR } },
  ]);
  assert.deepEqual(d.serviceCalls, ['end', 'complete', 'remove']);
});

test('the deprecated archive route is the same door and is guarded too', async () => {
  const d = makeController();
  await d.controller.archiveSessionCompatibility(
    RUNNER, undefined, COORDINATOR, CREDENTIAL, TARGET);
  assert.equal(d.guardCalls.length, 1);
  assert.equal(d.guardCalls[0].guard, 'end');
  // An older runner binary reaching a newer API must not be a way around the refusal.
  assert.deepEqual(d.serviceCalls, ['complete']);
});

test('a refused end or delete never reaches the session service (AU2)', async () => {
  for (const [name, invoke] of [
    ['complete', (d: ReturnType<typeof makeController>) =>
      d.controller.completeSession(RUNNER, undefined, COORDINATOR, CREDENTIAL, TARGET)],
    ['delete', (d: ReturnType<typeof makeController>) =>
      d.controller.deleteSession(RUNNER, undefined, COORDINATOR, CREDENTIAL, TARGET)],
  ] as const) {
    const d = makeController({ guard: 'end', code: 'ATTEMPT_OUTCOME_IS_THE_WORKERS' });
    await assert.rejects(
      () => invoke(d),
      (error: Error) => error.message.includes('ATTEMPT_OUTCOME_IS_THE_WORKERS'),
      name,
    );
    // The point of guarding HERE: nothing was settled, so there is no result to restore.
    assert.deepEqual(d.serviceCalls, [], name);
  }
});

test('a send is charged as a steer, and a refusal stops it before the turn is filed (AU3)', async () => {
  const d = makeController();
  await d.controller.sendMessage(
    RUNNER, undefined, COORDINATOR, CREDENTIAL, TARGET, { message: 'keep going' });
  assert.deepEqual(d.guardCalls, [
    { guard: 'steer', sessionId: TARGET, actor: { kind: 'AGENT_SESSION', sessionId: COORDINATOR } },
  ]);
  assert.deepEqual(d.serviceCalls, ['createTurn']);

  const refused = makeController({ guard: 'steer', code: 'ATTEMPT_STEER_BUDGET_EXHAUSTED' });
  await assert.rejects(
    () => refused.controller.sendMessage(
      RUNNER, undefined, COORDINATOR, CREDENTIAL, TARGET, { message: 'keep going' }),
    (error: Error) => error.message.includes('ATTEMPT_STEER_BUDGET_EXHAUSTED'),
  );
  assert.deepEqual(refused.serviceCalls, []);
});

test('an interrupt CARRYING a message is a steer; a bodyless one is not', async () => {
  const withMessage = makeController();
  await withMessage.controller.interruptSession(
    RUNNER, undefined, COORDINATOR, CREDENTIAL, TARGET, { message: 'stop, do this instead' });
  assert.deepEqual(withMessage.guardCalls.map((c) => c.guard), ['steer']);

  // A plain interrupt writes no outcome and injects no turn, so it can overwrite nothing. Charging
  // it would make "stop the runaway" cost the same budget as "keep going", which is backwards.
  const bodyless = makeController();
  await bodyless.controller.interruptSession(RUNNER, undefined, COORDINATOR, CREDENTIAL, TARGET);
  assert.deepEqual(bodyless.guardCalls, []);
  assert.deepEqual(bodyless.serviceCalls, ['interrupt']);
});

test('a headless caller carries no calling session, and is read as the USER door (AU1)', async () => {
  const d = makeController();
  await d.controller.sendMessage(RUNNER, undefined, '  ', undefined, TARGET, { message: 'hi' });
  assert.deepEqual(d.guardCalls, [
    { guard: 'steer', sessionId: TARGET, actor: { kind: 'USER' } },
  ]);
  // `assertMayEndSession` and `chargeSteer` both return immediately for a USER actor, so this is
  // the path a person's own client takes: bounded loops are the subject here, not people.
});
