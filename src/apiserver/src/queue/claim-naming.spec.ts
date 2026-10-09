import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentProvider, PermissionMode, type ClaimedSession } from '@orbit/shared';
import type { PrismaService } from '../prisma/prisma.service';
import { encryptSecret } from '../providers/provider-crypto';
import { ENGINE_NAMING_INSTRUCTIONS } from '../sessions/naming';
import { QueueService } from './queue.service';

process.env.PROVIDER_SECRET_KEY = 'test-master-key';

const OWNER = '22222222-2222-4222-8222-222222222222';

interface Options {
  provider?: string;
  providerBuiltin?: boolean;
  title?: string;
  prompt?: string;
  taskId?: string | null;
  titleManagedByProject?: boolean;
  /** The configured row the session's provider names, if any. */
  row?: { runtime: string; baseUrl: string; secret: string };
}

/** buildSession over a session row and nothing else: the claim's payload, read back. */
async function claim(options: Options = {}): Promise<ClaimedSession> {
  const provider = options.provider ?? AgentProvider.CLAUDE;
  const prompt = options.prompt ?? 'Fix the flaky login timeout on Safari\nIt fails about once in ten runs.';
  const session = {
    id: '11111111-1111-4111-8111-111111111111',
    ownerId: OWNER,
    provider,
    providerBuiltin: options.providerBuiltin ?? true,
    model: 'some-model',
    permissionMode: PermissionMode.AUTO,
    usesRuntimeDefaultModel: true,
    numTurns: 0,
    title: options.title ?? 'Fix the flaky login timeout on Safari',
    titleManagedByProject: options.titleManagedByProject ?? false,
    prompt,
    runtimeSessionId: null,
    inboxLeaseOwner: null,
    branch: null,
    mergeTarget: null,
    workspaceId: '33333333-3333-4333-8333-333333333333',
    taskId: options.taskId ?? null,
    assignedRunner: { runtimeDefaultModels: {}, modelCatalog: {} },
    owner: { preferences: {} },
    workspace: {
      provider,
      model: null,
      env: null,
      workDir: null,
      autoInitGit: false,
      defaultMergeTarget: null,
      appendSystemPrompt: null,
      systemPrompt: null,
      allowedTools: [],
      disallowedTools: [],
      permissionMode: 'dontAsk',
      effort: null,
      maxTurns: null,
      maxBudgetUsd: null,
      mcpConfig: null,
    },
  };
  const row = options.row
    ? {
        slug: provider,
        runtime: options.row.runtime,
        baseUrl: options.row.baseUrl,
        apiKeyEnc: encryptSecret(options.row.secret),
        defaultModel: null,
        presetSlug: null,
        followsPreset: false,
        models: [],
        enabled: true,
        ownerId: OWNER,
      }
    : null;
  const tx = {
    $queryRaw: async () => [],
    conversationTurn: { findUnique: async () => ({ id: 'seed-turn' }), findFirst: async () => null, count: async () => 0 },
  };
  const prisma = {
    // findFirst: a task's session is asked whether it is a Wiki maintenance run (it is not).
    session: { findUniqueOrThrow: async () => session, findFirst: async () => null, update: async () => session },
    $executeRaw: async () => 1,
    $transaction: async (fn: (client: typeof tx) => unknown) => fn(tx),
    runEvent: { aggregate: async () => ({ _max: { seq: null } }) },
    user: { findUnique: async () => ({ role: 'MEMBER' }) },
    modelProvider: { findFirst: async () => row },
  } as unknown as PrismaService;
  const queue = new QueueService(prisma, { publishSessionUpdated() {} } as never);
  return (queue as unknown as { buildSession(id: string): Promise<ClaimedSession> }).buildSession(session.id);
}

async function withoutDeepSeek<T>(fn: () => Promise<T>): Promise<T> {
  const original = process.env.DEEPSEEK_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
  try {
    return await fn();
  } finally {
    if (original === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = original;
  }
}

test("with no DeepSeek key, a session on an engine's own sign-in is named by that engine", async () => {
  await withoutDeepSeek(async () => {
    for (const provider of [AgentProvider.CLAUDE, AgentProvider.CODEX]) {
      const claimed = await claim({ provider });
      assert.deepEqual(claimed.naming, {
        description: 'Fix the flaky login timeout on Safari\nIt fails about once in ten runs.',
        instructions: ENGINE_NAMING_INSTRUCTIONS,
      }, provider);
    }
    // Bounded like every naming request.
    assert.equal((await claim({ prompt: 'x'.repeat(2_000), title: 'x'.repeat(80) })).naming?.description.length, 600);
  });
});

test('a session something else names, or that already has a real title, is not named again', async () => {
  // The server names it itself on its DeepSeek key.
  const original = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = 'test-key';
  try {
    assert.equal('naming' in (await claim()), false);
  } finally {
    if (original === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = original;
  }
  await withoutDeepSeek(async () => {
    // A title of its own: a person's, a task's, a project's, or an earlier naming's.
    assert.equal((await claim({ title: 'Safari login timeout' })).naming, undefined);
    assert.equal((await claim({ taskId: '44444444-4444-4444-8444-444444444444' })).naming, undefined);
    assert.equal((await claim({ titleManagedByProject: true })).naming, undefined);
    // An engine with no way to answer from inside its own process.
    assert.equal((await claim({ provider: AgentProvider.KIMI })).naming, undefined);
    assert.equal((await claim({ provider: AgentProvider.ANTIGRAVITY })).naming, undefined);
    // A key the server may spend: it named the session at creation.
    const deepseek = { runtime: 'claude', baseUrl: 'https://api.deepseek.com/anthropic', secret: 'sk-ds' };
    assert.equal((await claim({ provider: 'deepseek', providerBuiltin: false, row: deepseek })).naming, undefined);
  });
});

test('a configured Claude subscription is named by the Claude Code that runs on it', async () => {
  await withoutDeepSeek(async () => {
    const subscription = { runtime: 'claude', baseUrl: 'https://api.anthropic.com', secret: 'sk-ant-oat01-x' };
    const claimed = await claim({ provider: 'my-max', providerBuiltin: false, row: subscription });
    assert.equal(claimed.provider, AgentProvider.CLAUDE);
    assert.equal(claimed.naming?.instructions, ENGINE_NAMING_INSTRUCTIONS);
  });
});
