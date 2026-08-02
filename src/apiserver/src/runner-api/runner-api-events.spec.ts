import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConflictException } from '@nestjs/common';
import { RunStatus } from '@prisma/client';
import { RunEventType } from '@orbit/shared';
import { RunnerApiController } from './runner-api.controller';

function makeController(status: RunStatus = RunStatus.AWAITING_INPUT) {
  const calls = { createMany: [] as any[], updateMany: [] as any[] };
  let published = 0;
  const tx = {
    $queryRaw: async () => [{ id: 'session-1', leaseOwnerMatches: true }],
    runEvent: {
      createMany: async (args: any) => {
        calls.createMany.push(args);
        return { count: args.data.length };
      },
    },
    session: {
      findUniqueOrThrow: async () => ({
        status,
        runtimeSessionId: 'runtime-1',
      }),
      updateMany: async (args: any) => {
        calls.updateMany.push(args);
        return { count: 1 };
      },
      update: async () => ({}),
    },
  };
  const prisma = {
    $transaction: async (fn: (client: typeof tx) => unknown) => fn(tx),
  };
  const realtime = { publish: () => published++ };
  return {
    calls,
    published: () => published,
    controller: new RunnerApiController(prisma as never, {} as never, realtime as never, {} as never, {} as never),
  };
}

test('a reclaimed session init is persisted without advancing lastTurnAt', async () => {
  const { calls, controller } = makeController();

  await controller.events({ id: 'runner-1' }, 'session-1', {
    events: [
      {
        seq: 42,
        type: RunEventType.SYSTEM,
        ts: '2026-07-31T12:00:00.000Z',
        payload: { subtype: 'init', sessionId: 'runtime-1' },
      },
    ],
  });

  assert.equal(calls.createMany.length, 1, 'the runtime handshake remains durable');
  assert.equal(calls.updateMany.length, 0, 'the old activity time remains unchanged');
});

test('a durable turn event still advances lastTurnAt', async () => {
  const { calls, controller } = makeController();

  await controller.events({ id: 'runner-1' }, 'session-1', {
    events: [
      {
        seq: 43,
        type: RunEventType.SYSTEM,
        ts: '2026-07-31T12:01:00.000Z',
        turnId: 'turn-1',
        payload: { subtype: 'status' },
      },
    ],
  });

  assert.equal(calls.updateMany.length, 1);
  assert.ok(calls.updateMany[0].data.lastTurnAt instanceof Date);
});

test('terminal sessions reject durable events before any write or publish', async () => {
  for (const status of [RunStatus.SUCCEEDED, RunStatus.FAILED, RunStatus.CANCELLED]) {
    const { calls, controller, published } = makeController(status);

    await assert.rejects(
      controller.events({ id: 'runner-1' }, 'session-1', {
        events: [
          {
            seq: 44,
            type: RunEventType.ASSISTANT,
            ts: '2026-07-31T12:02:00.000Z',
            turnId: 'turn-1',
            payload: { text: 'late zombie output' },
          },
        ],
      }),
      ConflictException,
    );

    assert.equal(calls.createMany.length, 0);
    assert.equal(calls.updateMany.length, 0);
    assert.equal(published(), 0);
  }
});

test('terminal sessions reject empty and streaming-only batches too', async () => {
  for (const events of [
    [],
    [
      {
        seq: 45,
        type: RunEventType.TEXT_DELTA,
        ts: '2026-07-31T12:03:00.000Z',
        payload: { text: 'late' },
      },
    ],
  ]) {
    const { calls, controller, published } = makeController(RunStatus.FAILED);
    await assert.rejects(
      controller.events({ id: 'runner-1' }, 'session-1', { events }),
      ConflictException,
    );
    assert.equal(calls.createMany.length, 0);
    assert.equal(calls.updateMany.length, 0);
    assert.equal(published(), 0);
  }
});

test('a recent turn-attributed batch cannot bypass the terminal fence', async () => {
  const { calls, controller, published } = makeController(RunStatus.FAILED);

  await assert.rejects(
    controller.events({ id: 'runner-1' }, 'session-1', {
      events: [
        {
          seq: 46,
          type: RunEventType.ASSISTANT,
          ts: new Date().toISOString(),
          turnId: 'turn-1',
          payload: { text: 'late zombie output' },
        },
      ],
    }),
    ConflictException,
  );

  assert.equal(calls.createMany.length, 0);
  assert.equal(calls.updateMany.length, 0);
  assert.equal(published(), 0);
});
