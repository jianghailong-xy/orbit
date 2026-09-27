import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ClaimedSession } from '@orbit/shared';
import type { PrismaService } from '../prisma/prisma.service';
import { encryptSecret } from '../providers/provider-crypto';
import { QueueService } from './queue.service';

// What the runner is handed for a session on a self-hosted Claude-runtime provider whose model
// declares the efforts it accepts: vLLM serving Qwen3.8, whose chat template raises on any
// `reasoning_effort` but xhigh/medium/low. Claude Code sends `high` for a model it does not know when
// it is given no effort at all, so the claim has to state one from the list — every request of the
// session is a 400 otherwise.

process.env.PROVIDER_SECRET_KEY = 'test-master-key';

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const RUNTIME_ID = '9d9aa83d-913b-4b6e-9016-db94b21e8671';

const vllmRow = (reasoningLevels?: string[]) => ({
  id: 'provider-1',
  slug: 'local-vllm',
  label: 'Local vLLM',
  ownerId: '22222222-2222-4222-8222-222222222222',
  runtime: 'claude',
  baseUrl: 'http://127.0.0.1:8000',
  apiKeyEnc: encryptSecret('EMPTY'),
  defaultModel: 'qwen3.8-27b-fp8',
  presetSlug: null,
  followsPreset: false,
  enabled: true,
  models: [
    {
      value: 'qwen3.8-27b-fp8',
      label: 'Qwen3.8 27B FP8',
      contextWindow: 131072,
      ...(reasoningLevels ? { reasoningLevels } : {}),
    },
  ],
});

function queueFor(opts: { effort: string | null; workspaceEffort?: string | null; row: unknown }) {
  const session = {
    id: SESSION_ID,
    ownerId: '22222222-2222-4222-8222-222222222222',
    provider: 'local-vllm',
    providerBuiltin: false,
    model: 'qwen3.8-27b-fp8',
    usesRuntimeDefaultModel: true,
    numTurns: 0,
    title: 'declared effort',
    prompt: 'hello',
    runtimeSessionId: RUNTIME_ID,
    inboxLeaseOwner: null,
    branch: null,
    mergeTarget: null,
    effort: opts.effort,
    permissionMode: null,
    spawnDepth: 0,
    workspaceId: '33333333-3333-4333-8333-333333333333',
    taskId: null,
    assignedRunner: { runtimeDefaultModels: null, modelCatalog: null },
    owner: { preferences: {} },
    workspace: {
      provider: 'claude',
      model: null,
      env: { ANTHROPIC_BASE_URL: 'https://typed-into-the-workspace' },
      workDir: null,
      autoInitGit: false,
      defaultMergeTarget: null,
      appendSystemPrompt: null,
      systemPrompt: null,
      allowedTools: [],
      disallowedTools: [],
      permissionMode: 'dontAsk',
      effort: opts.workspaceEffort ?? null,
      maxTurns: null,
      maxBudgetUsd: null,
      mcpConfig: null,
      permissionRules: [],
    },
  };
  const tx = {
    $queryRaw: async () => [],
    conversationTurn: { findUnique: async () => ({ id: 'seed-turn' }), findFirst: async () => null, count: async () => 0 },
  };
  const prisma = {
    session: { findUniqueOrThrow: async () => session, update: async () => session },
    runEvent: { aggregate: async () => ({ _max: { seq: null } }), findFirst: async () => null },
    modelProvider: { findFirst: async () => opts.row },
    $transaction: async (fn: (client: typeof tx) => unknown) => fn(tx),
    attachment: { updateMany: async () => ({ count: 0 }) },
    user: { findUnique: async () => null },
  } as unknown as PrismaService;
  return new QueueService(prisma, { publishSessionUpdated() {} } as never);
}

async function claim(opts: { effort: string | null; workspaceEffort?: string | null; row: unknown }) {
  const queue = queueFor(opts);
  return (queue as unknown as { buildSession(id: string): Promise<ClaimedSession> }).buildSession(SESSION_ID);
}

const QWEN38 = ['low', 'medium', 'xhigh'];

test('a session with no effort is handed a level its model accepts, not the CLI default', async () => {
  const claimed = await claim({ effort: null, row: vllmRow(QWEN38) });
  assert.equal(claimed.agent.effort, 'xhigh');
  // The provider's endpoint, not the one typed into the workspace, and the model's own window.
  assert.equal(claimed.agent.env?.ANTHROPIC_BASE_URL, 'http://127.0.0.1:8000');
  assert.equal(claimed.agent.env?.ANTHROPIC_AUTH_TOKEN, 'EMPTY');
  assert.equal(claimed.agent.env?.CLAUDE_CODE_MAX_CONTEXT_TOKENS, '131072');
});

test("a session's own effort, and its workspace's, are moved onto the declared levels", async () => {
  assert.equal((await claim({ effort: 'high', row: vllmRow(QWEN38) })).agent.effort, 'xhigh');
  assert.equal((await claim({ effort: 'medium', row: vllmRow(QWEN38) })).agent.effort, 'medium');
  assert.equal((await claim({ effort: 'low', row: vllmRow(QWEN38) })).agent.effort, 'low');
  assert.equal(
    (await claim({ effort: null, workspaceEffort: 'max', row: vllmRow(QWEN38) })).agent.effort,
    'xhigh',
  );
});

test('a model that declares nothing is dispatched exactly as before', async () => {
  assert.equal((await claim({ effort: null, row: vllmRow() })).agent.effort, undefined);
  assert.equal((await claim({ effort: 'high', row: vllmRow() })).agent.effort, 'high');
});
