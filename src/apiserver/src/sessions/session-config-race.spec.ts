import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RunStatus } from '@prisma/client';
import { SessionsService } from './sessions.service';

test('config update seeds the prompt before reload when claim just changed PENDING to RUNNING', async () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const ownerId = '22222222-2222-4222-8222-222222222222';
  const turns: Array<{ kind: string; content?: string; seq: number }> = [];
  let sequence = 0;
  let inboxWakes = 0;
  const tx = {
    $queryRaw: async () => [{ id }],
    session: {
      // The claim committed before updateConfig acquired its row lock, so the locked read sees
      // RUNNING and must queue a reload instead of relying on the claim path.
      findUniqueOrThrow: async () => ({
        id,
        ownerId,
        status: RunStatus.RUNNING,
        provider: 'codex',
        providerBuiltin: true,
        model: null,
        permissionMode: null,
        usesRuntimeDefaultModel: true,
        numTurns: 0,
        prompt: 'opening prompt',
        agent: null,
        assignedRunner: null,
      }),
      update: async () => ({ id }),
    },
    conversationTurn: {
      findUnique: async () => null,
      findFirst: async () => (sequence ? { seq: sequence } : null),
      create: async ({ data }: { data: { kind: string; content?: string; seq: number } }) => {
        sequence = data.seq;
        turns.push(data);
        return { id: `turn-${sequence}`, ...data };
      },
    },
    attachment: { updateMany: async () => ({ count: 0 }) },
  };
  const prisma = {
    $transaction: async (fn: (client: typeof tx) => unknown) => fn(tx),
  } as never;
  const realtime = { notifyInbox: () => inboxWakes++ } as never;
  const service = new SessionsService(prisma, {} as never, realtime);

  assert.deepEqual(await service.updateConfig(ownerId, id, { model: 'gpt-user-choice' }), {
    ok: true,
  });
  assert.equal(turns.length, 2);
  assert.deepEqual(
    turns.map(({ kind, seq }) => ({ kind, seq })),
    [
      { kind: 'message', seq: 1 },
      { kind: 'reload', seq: 2 },
    ],
  );
  assert.equal(turns[0].content, 'opening prompt');
  assert.equal(JSON.parse(turns[1].content ?? '{}').model, 'gpt-user-choice');
  assert.equal(inboxWakes, 1);
});

test('a live model change persists and reloads the normalized permission pair', async () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const ownerId = '22222222-2222-4222-8222-222222222222';
  let updatedData: Record<string, unknown> = {};
  const reloads: Array<{ content?: string }> = [];
  const tx = {
    $queryRaw: async () => [{ id }],
    session: {
      findUniqueOrThrow: async () => ({
        id,
        ownerId,
        status: RunStatus.AWAITING_INPUT,
        provider: 'claude',
        providerBuiltin: true,
        model: 'claude-opus-5',
        permissionMode: 'auto',
        usesRuntimeDefaultModel: true,
        numTurns: 1,
        agent: null,
        assignedRunner: null,
      }),
      update: async (args: { data: Record<string, unknown> }) => {
        updatedData = args.data;
        return { id };
      },
    },
    conversationTurn: {
      findUnique: async () => null,
      findFirst: async () => null,
      create: async ({ data }: { data: { content?: string } }) => {
        reloads.push(data);
        return { id: '33333333-3333-4333-8333-333333333333', ...data };
      },
    },
  };
  const prisma = {
    $transaction: async (fn: (client: typeof tx) => unknown) => fn(tx),
  } as never;
  const service = new SessionsService(
    prisma,
    {} as never,
    { notifyInbox: () => undefined } as never,
  );

  await service.updateConfig(ownerId, id, { model: 'claude-haiku-4-5' });

  assert.equal(updatedData.model, 'claude-haiku-4-5');
  assert.equal(updatedData.permissionMode, 'default');
  assert.deepEqual(JSON.parse(reloads[0].content ?? '{}'), {
    model: 'claude-haiku-4-5',
    permissionMode: 'default',
  });
});

test('concurrent partial config patches serialize without restoring a stale model/mode pair', async () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const ownerId = '22222222-2222-4222-8222-222222222222';
  const state = {
    model: 'claude-opus-5',
    permissionMode: 'auto',
  };
  const reloads: Array<{ content?: string }> = [];
  let sequence = 0;
  const tx = {
    $queryRaw: async () => [{ id }],
    session: {
      findUniqueOrThrow: async () => ({
        id,
        ownerId,
        status: RunStatus.AWAITING_INPUT,
        provider: 'claude',
        providerBuiltin: true,
        usesRuntimeDefaultModel: true,
        numTurns: 1,
        agent: null,
        assignedRunner: null,
        ...state,
      }),
      update: async ({ data }: { data: Record<string, unknown> }) => {
        state.model = data.model as string;
        state.permissionMode = data.permissionMode as string;
        return { id };
      },
    },
    conversationTurn: {
      findUnique: async () => null,
      findFirst: async () => (sequence ? { seq: sequence } : null),
      create: async ({ data }: { data: { content?: string; seq: number } }) => {
        sequence = data.seq;
        reloads.push(data);
        return { id: `turn-${sequence}`, ...data };
      },
    },
  };
  // Model PostgreSQL's row lock: each interactive transaction sees the previous transaction's
  // committed pair even when both HTTP requests begin concurrently.
  let tail = Promise.resolve();
  const prisma = {
    $transaction: async (fn: (client: typeof tx) => unknown) => {
      let release!: () => void;
      const previous = tail;
      tail = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      try {
        return await fn(tx);
      } finally {
        release();
      }
    },
  } as never;
  const service = new SessionsService(
    prisma,
    {} as never,
    { notifyInbox: () => undefined } as never,
  );

  await Promise.all([
    service.updateConfig(ownerId, id, { model: 'claude-haiku-4-5' }),
    service.updateConfig(ownerId, id, { permissionMode: 'auto' }),
  ]);

  assert.deepEqual(state, {
    model: 'claude-haiku-4-5',
    permissionMode: 'default',
  });
  assert.equal(reloads.length, 2);
  assert.deepEqual(JSON.parse(reloads[1].content ?? '{}'), state);
});
