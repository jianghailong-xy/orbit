import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ForbiddenException } from '@nestjs/common';
import { RunnerSessionsController } from './runner-sessions.controller';

/**
 * `resumeIfEnded` is opt-in, unlike the browser composer's silent send→resume fallback. The
 * caller here is an agent: reviving burns tokens and holds a runner slot, and the 409 it replaces
 * is load-bearing for the paths that re-home a stranded message onto a fresh session instead.
 */

const RUNNER = { id: 'runner-1', ownerId: 'owner-1' } as never;
const CALLER_SESSION_ID = 'caller-session';
const ORCHESTRATION_TOKEN = 'signed-session-credential';
const TARGET_SESSION_ID = 'target-session';

function makeController() {
  const calls: Array<{ method: string; dto: unknown; charged: boolean }> = [];
  const sessions = new Proxy(
    {},
    {
      get:
        (_target, method: string) =>
        async (_owner: unknown, _id: unknown, dto: unknown, opts?: Record<string, unknown>) => {
          calls.push({
            method,
            dto,
            charged: typeof opts?.participateSendTransaction === 'function',
          });
          return { turnId: 'turn-1' };
        },
    },
  );
  const authorizer = { assert: async () => undefined };
  return {
    controller: new RunnerSessionsController(
      sessions as never,
      authorizer as never,
      {} as never,
      { chargeSteer: async () => undefined } as never,
    ),
    calls,
  };
}

test('a plain send still refuses an ended session rather than reviving it', async () => {
  const { controller, calls } = makeController();

  await controller.sendMessage(
    RUNNER, undefined, CALLER_SESSION_ID, ORCHESTRATION_TOKEN, TARGET_SESSION_ID,
    { message: 'continue' },
  );

  assert.deepEqual(calls.map((c) => c.method), ['createTurn']);
});

test('resumeIfEnded routes the same message through resume, which delegates back when live', async () => {
  const { controller, calls } = makeController();

  await controller.sendMessage(
    RUNNER, undefined, CALLER_SESSION_ID, ORCHESTRATION_TOKEN, TARGET_SESSION_ID,
    { message: 'continue', resumeIfEnded: true },
  );

  assert.deepEqual(calls.map((c) => c.method), ['resume']);
  // The same unqualified turn `createTurn` would have received. `resumeIfEnded` selects the door,
  // it is not part of the message, and it must not reach the service as a turn field.
  const dto = calls[0].dto as Record<string, unknown>;
  assert.deepEqual(Object.keys(dto).sort(), ['clientTurnId', 'content']);
  assert.equal(dto.content, 'continue');
});

test('the attempt charge follows the message onto the resume route', async () => {
  const { controller, calls } = makeController();

  await controller.sendMessage(
    RUNNER, undefined, CALLER_SESSION_ID, ORCHESTRATION_TOKEN, TARGET_SESSION_ID,
    { message: 'continue', resumeIfEnded: true },
  );

  // Otherwise `resumeIfEnded` is a way to buy a steer the budget already refused.
  assert.equal(calls[0].charged, true);
});

test('a headless caller may send but may not revive', async () => {
  const { controller, calls } = makeController();

  await assert.rejects(
    () =>
      controller.sendMessage(
        RUNNER, undefined, undefined, undefined, TARGET_SESSION_ID,
        { message: 'continue', resumeIfEnded: true },
      ),
    (error: unknown) =>
      error instanceof ForbiddenException &&
      error.message === 'resumeIfEnded requires a calling session; a headless credential may only send',
  );

  // Refused before the session is even resolved: reviving is a lifecycle verb, and none of those
  // are in the headless vocabulary.
  assert.deepEqual(calls, []);
});

test('a headless send without the flag is unchanged', async () => {
  const { controller, calls } = makeController();

  await controller.sendMessage(
    RUNNER, undefined, undefined, undefined, TARGET_SESSION_ID, { message: 'continue' },
  );

  assert.deepEqual(calls.map((c) => c.method), ['assertHostedByRunner', 'createTurn']);
});
