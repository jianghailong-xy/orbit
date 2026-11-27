import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentProvider, PermissionMode, type ClaimedSession } from '@orbit/shared';
import type { PrismaService } from '../prisma/prisma.service';
import { encryptSecret } from '../providers/provider-crypto';
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
    session: { findUniqueOrThrow: async () => session, findFirst: async () => null, update: async () => session, updateMany: async () => ({ count: 1 }) },
    $executeRaw: async () => 1,
    $transaction: async (fn: (client: typeof tx) => unknown) => fn(tx),
    // run_event max(seq), the high-water mark buildSession continues from: raw SQL, never
    // `aggregate` (Prisma compiles that into an OFFSET subquery the planner cannot flatten).
    $queryRaw: async () => [{ max: 0 }],
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

test("a claim never asks the engine to name the session: without DeepSeek's key, the session's provider is not spent on a title", async () => {
  await withoutDeepSeek(async () => {
    for (const provider of [AgentProvider.CLAUDE, AgentProvider.CODEX]) {
      assert.equal('naming' in (await claim({ provider })), false, provider);
    }
    const subscription = { runtime: 'claude', baseUrl: 'https://api.anthropic.com', secret: 'sk-ant-oat01-x' };
    assert.equal('naming' in (await claim({ provider: 'my-max', providerBuiltin: false, row: subscription })), false);
  });
});

test('with a DeepSeek key the server names the session itself, and the claim asks for no name either', async () => {
  const original = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = 'test-key';
  try {
    assert.equal('naming' in (await claim()), false);
  } finally {
    if (original === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = original;
  }
});
