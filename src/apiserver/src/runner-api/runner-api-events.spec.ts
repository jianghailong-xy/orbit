import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RunStatus } from '@prisma/client';
import { RunEventType } from '@orbit/shared';
import { RunnerApiController } from './runner-api.controller';

function makeController() {
  const calls = { createMany: [] as any[], updateMany: [] as any[] };
  const prisma = {
    runEvent: {
      createMany: async (args: any) => {
        calls.createMany.push(args);
        return { count: args.data.length };
      },
    },
    session: {
      findUnique: async () => ({
        id: 'session-1',
        assignedRunnerId: 'runner-1',
        status: RunStatus.AWAITING_INPUT,
        runtimeSessionId: 'runtime-1',
        lastTurnAt: new Date('2026-07-01T00:00:00.000Z'),
      }),
      updateMany: async (args: any) => {
        calls.updateMany.push(args);
        return { count: 1 };
      },
      update: async () => ({}),
    },
  };
  const realtime = { publish: () => undefined };
  return {
    calls,
    controller: new RunnerApiController(
      prisma as never,
      {} as never,
      realtime as never,
      {} as never,
      {} as never,
    ),
  };
}

test('a reclaimed session init is persisted without advancing lastTurnAt', async () => {
  const { calls, controller } = makeController();

  await controller.events(
    { id: 'runner-1' },
    'session-1',
    {
      events: [
        {
          seq: 42,
          type: RunEventType.SYSTEM,
          ts: '2026-07-31T12:00:00.000Z',
          payload: { subtype: 'init', sessionId: 'runtime-1' },
        },
      ],
    },
  );

  assert.equal(calls.createMany.length, 1, 'the runtime handshake remains durable');
  assert.equal(calls.updateMany.length, 0, 'the old activity time remains unchanged');
});

test('a durable turn event still advances lastTurnAt', async () => {
  const { calls, controller } = makeController();

  await controller.events(
    { id: 'runner-1' },
    'session-1',
    {
      events: [
        {
          seq: 43,
          type: RunEventType.SYSTEM,
          ts: '2026-07-31T12:01:00.000Z',
          turnId: 'turn-1',
          payload: { subtype: 'status' },
        },
      ],
    },
  );

  assert.equal(calls.updateMany.length, 1);
  assert.ok(calls.updateMany[0].data.lastTurnAt instanceof Date);
});
