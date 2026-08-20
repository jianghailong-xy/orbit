import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RunStatus } from '@prisma/client';

process.env.PROVIDER_SECRET_KEY = 'test-master-key';

import { encryptSecret } from '../providers/provider-crypto';
import { RunnerApiController } from './runner-api.controller';

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const RUNNER_ID = '22222222-2222-4222-8222-222222222222';
const GENERATION = '33333333-3333-4333-8333-333333333333';
const OWNER_ID = '44444444-4444-4444-8444-444444444444';

type Dequeue = (
  sessionId: string,
  runnerId: string,
  leaseGeneration: string | null,
) => Promise<{ kind: string; env?: Record<string, string> } | null>;

/** One `reload` turn waiting on the inbox, with the session it belongs to. */
function harness(reloadContent: string, session: Record<string, unknown>, provider?: unknown) {
  const tx = {
    $queryRaw: async (...args: unknown[]) => {
      const sql = (args[0] as readonly string[]).join('?');
      if (/SELECT id, "inbox_lease_generation"[\s\S]*FROM "session"/.test(sql)) {
        return [
          {
            id: SESSION_ID,
            inboxLeaseGeneration: GENERATION,
            inboxLeaseOwner: GENERATION,
            status: RunStatus.AWAITING_INPUT,
          },
        ];
      }
      if (/FROM "inbox_lease_generation"/.test(sql)) return [{ generation: GENERATION }];
      if (/UPDATE "conversation_turn"/.test(sql)) {
        return [{ id: 'turn-1', seq: 7, kind: 'reload', content: reloadContent }];
      }
      return [];
    },
    conversationTurn: { updateMany: async () => ({ count: 1 }),
      findFirst: async () => null,
    },
    session: {
      findUnique: async () => ({
        ownerId: OWNER_ID,
        model: 'claude-opus-5',
        usesRuntimeDefaultModel: true,
        workspace: null,
        assignedRunner: null,
        ...session,
      }),
    },
    modelProvider: { findFirst: async () => provider ?? null },
  };
  const prisma = {
    $transaction: async (fn: (transaction: typeof tx) => Promise<unknown>) => fn(tx),
  } as never;
  const controller = new RunnerApiController(
    prisma,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    { appendFor: async (_tx: unknown, _sessionId: unknown, content?: string) => content } as never,
  );
  return (controller as unknown as { dequeueTurn: Dequeue }).dequeueTurn.bind(controller);
}

test('a reload naming a provider is delivered with that provider resolved environment', async () => {
  const dequeue = harness(
    JSON.stringify({ model: 'claude-opus-5', permissionMode: 'default', provider: 'anthropic-2' }),
    { provider: 'anthropic-2', providerBuiltin: false },
    {
      runtime: 'claude',
      baseUrl: 'https://api.anthropic.com',
      apiKeyEnc: encryptSecret('second-account-key'),
      defaultModel: 'claude-opus-5',
      presetSlug: 'anthropic',
      followsPreset: true,
      enabled: true,
    },
  );

  const turn = await dequeue(SESSION_ID, RUNNER_ID, GENERATION);

  assert.equal(turn?.kind, 'reload');
  assert.equal(turn?.env?.ANTHROPIC_AUTH_TOKEN, 'second-account-key');
  assert.equal(turn?.env?.ANTHROPIC_BASE_URL, 'https://api.anthropic.com');
});

test('switching onto a built-in engine delivers an empty env, clearing the old key', async () => {
  const dequeue = harness(
    JSON.stringify({ model: 'claude-opus-5', permissionMode: 'default', provider: 'claude' }),
    { provider: 'claude', providerBuiltin: true },
  );

  const turn = await dequeue(SESSION_ID, RUNNER_ID, GENERATION);

  // Not undefined: the runner has to be told to drop the previous provider's variables, and an
  // empty map is that instruction. Undefined would mean "keep what you have".
  assert.deepEqual(turn?.env, {});
});

test('a model-only reload carries no env, so the engine keeps the process it has', async () => {
  const dequeue = harness(
    JSON.stringify({ model: 'claude-haiku-4-5', permissionMode: 'default' }),
    { provider: 'anthropic', providerBuiltin: false },
  );

  const turn = await dequeue(SESSION_ID, RUNNER_ID, GENERATION);

  assert.equal(turn?.kind, 'reload');
  assert.equal(turn?.env, undefined);
});

test('an unreadable reload payload never fails the poll', async () => {
  const dequeue = harness('not json', { provider: 'claude', providerBuiltin: true });

  assert.equal((await dequeue(SESSION_ID, RUNNER_ID, GENERATION))?.env, undefined);
});
