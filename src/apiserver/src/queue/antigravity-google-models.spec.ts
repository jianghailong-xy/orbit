import assert from 'node:assert/strict';
import { renderRawQuery } from '../test-support/prisma-transaction-double';
import { test } from 'node:test';
import { AgentProvider, PermissionMode, type ClaimedSession } from '@orbit/shared';
import type { PrismaService } from '../prisma/prisma.service';
import { QueueService } from './queue.service';

/**
 * What a claim DISPATCHES for Antigravity, on the runner's own `agy models` catalogue.
 *
 * A runner signed in with a Google account reports the API-key Gemini rows *plus* the account's
 * Claude Opus/Sonnet 5.5 and GPT-OSS rows (docs/antigravity-runtime-contract.md §16.7). The model
 * space used to be decided by `model.startsWith('gemini-')`, so every one of the account's extra
 * ids was replaced with the provider default — agy then started without a `--model` at all and the
 * session silently ran its own default instead of the model that was picked.
 *
 * These drive the real claim path (`QueueService.buildSession`), so they assert the field the
 * question is actually about: `claimed.agent.model`, what the runner receives and turns into
 * `--model` (runner-go `antigravityModelArgs`). A session row keeping the id proves nothing on its
 * own — it did that while dispatch was already dropping it.
 */
const GEMINI_ROWS = [
  { value: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash', contextWindow: 1_048_576, reasoningLevels: ['low', 'medium', 'high'], defaultReasoningLevel: 'high' },
  { value: 'gemini-3.7-flash', label: 'Gemini 3.7 Flash', contextWindow: 1_048_576, reasoningLevels: ['low', 'medium', 'high'], defaultReasoningLevel: 'high' },
  { value: 'gemini-3.6-flash', label: 'Gemini 3.6 Flash', contextWindow: 1_048_576, reasoningLevels: ['low', 'medium', 'high'], defaultReasoningLevel: 'high' },
  { value: 'gemini-3.1-pro', label: 'Gemini 3.1 Pro', contextWindow: 1_048_576, reasoningLevels: ['low', 'high'], defaultReasoningLevel: 'high' },
];

/** The three rows a Google sign-in adds, as the runner folds `agy models` slugs into base rows. */
const GOOGLE_SIGN_IN_ROWS = [
  { value: 'claude-opus-5-5', label: 'Claude Opus 5.5', reasoningLevels: ['low', 'medium', 'high'], defaultReasoningLevel: 'high' },
  { value: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', reasoningLevels: ['low', 'medium', 'high'], defaultReasoningLevel: 'high' },
  { value: 'gpt-oss-120b', label: 'GPT-OSS 120B', reasoningLevels: ['medium'], defaultReasoningLevel: 'medium' },
];

// Read back from the production runner that signed in with a Google account: model_catalog ->
// 'antigravity' held exactly these seven rows, Gemini's first and the account's three last.
const GOOGLE_SIGN_IN_CATALOG = [...GEMINI_ROWS, ...GOOGLE_SIGN_IN_ROWS];

function harness(sessionModel: string | null, catalog: unknown) {
  const session = {
    id: '11111111-1111-4111-8111-111111111111',
    ownerId: '22222222-2222-4222-8222-222222222222',
    provider: AgentProvider.ANTIGRAVITY,
    providerBuiltin: true,
    model: sessionModel,
    effort: null,
    fastMode: false,
    permissionMode: PermissionMode.DEFAULT,
    usesRuntimeDefaultModel: true,
    numTurns: 0,
    title: 'antigravity google model dispatch',
    prompt: 'hello',
    runtimeSessionId: null,
    inboxLeaseOwner: null,
    branch: null,
    mergeTarget: null,
    workspaceId: '33333333-3333-4333-8333-333333333333',
    taskId: null,
    assignedRunner: { runtimeDefaultModels: {}, modelCatalog: catalog },
    owner: { preferences: {} },
    workspace: {
      provider: 'antigravity',
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
  const tx = {
    $queryRaw: async () => [],
    conversationTurn: { findUnique: async () => ({ id: 'seed-turn' }),
      findFirst: async () => null,
      count: async () => 0,
    },
  };
  const modelWrites: string[] = [];
  const prisma = {
    session: {
      findUniqueOrThrow: async () => session,
      update: async () => session,
    },
    $executeRaw: async (...args: unknown[]) => {
      const { values } = renderRawQuery(args);
      modelWrites.push(values[0] as string);
      return 1;
    },
    $transaction: async (fn: (client: typeof tx) => unknown) => fn(tx),
    runEvent: { aggregate: async () => ({ _max: { seq: null } }) },
    user: { findUnique: async () => null },
  } as unknown as PrismaService;
  return { queue: new QueueService(prisma, { publishSessionUpdated() {} } as never), modelWrites };
}

async function build(queue: QueueService): Promise<ClaimedSession> {
  return (
    queue as unknown as { buildSession(id: string): Promise<ClaimedSession> }
  ).buildSession('11111111-1111-4111-8111-111111111111');
}

async function dispatchedModel(
  sessionModel: string | null,
  catalog: unknown,
): Promise<{ model: string; modelWrites: string[] }> {
  const { queue, modelWrites } = harness(sessionModel, catalog);
  const claimed = await build(queue);
  return { model: claimed.agent.model, modelWrites };
}

test('dispatch carries a Google sign-in’s model through to the runner, verbatim', async () => {
  const catalog = { antigravity: GOOGLE_SIGN_IN_CATALOG };
  // The exact pick the end-to-end verification made, and the level-suffixed slug `agy models`
  // prints: both reach the job untouched, with no rewrite of the session row.
  for (const model of [
    'claude-sonnet-5-5',
    'claude-opus-5-5',
    'gpt-oss-120b',
    'claude-sonnet-5-5-medium',
    'claude-opus-5-5-high',
    'gpt-oss-120b-medium',
  ]) {
    const dispatched = await dispatchedModel(model, catalog);
    assert.equal(dispatched.model, model, `dispatch dropped ${model}`);
    assert.deepEqual(dispatched.modelWrites, [], `${model} was rewritten on the session`);
  }
});

test('the Gemini rows dispatch unchanged on the same signed-in runner', async () => {
  const dispatched = await dispatchedModel('gemini-3.1-pro', { antigravity: GOOGLE_SIGN_IN_CATALOG });
  assert.equal(dispatched.model, 'gemini-3.1-pro');
  assert.deepEqual(dispatched.modelWrites, []);
});

test('a model the catalogue does not carry is replaced by the runner’s current default', async () => {
  // `claude-opus-5` is not in the account's list, so agy would refuse to start on it. The pin is
  // retired rather than dispatched — to what the runner's catalogue actually runs, never to a
  // substitute chosen for it — and the row is re-materialized so the pickers stop showing the id.
  const dispatched = await dispatchedModel('claude-opus-5', { antigravity: GOOGLE_SIGN_IN_CATALOG });
  assert.equal(dispatched.model, 'gemini-3.8-flash');
  assert.deepEqual(dispatched.modelWrites, ['gemini-3.8-flash']);
});

test('an API-key runner keeps the Gemini-only rule: what agy cannot start on is still dropped', async () => {
  const catalog = { antigravity: GEMINI_ROWS };
  const gemini = await dispatchedModel('gemini-3.8-flash', catalog);
  assert.equal(gemini.model, 'gemini-3.8-flash');
  assert.deepEqual(gemini.modelWrites, []);
  // The session was pinned on another runner's account list; on this one agy would refuse it, so
  // the claim moves to what this runner does run — the same fallback a retired pin has always had.
  const claude = await dispatchedModel('claude-sonnet-5-5', catalog);
  assert.equal(claude.model, 'gemini-3.8-flash');
  assert.deepEqual(claude.modelWrites, ['gemini-3.8-flash']);
});

test('a runner that has reported no catalogue keeps the historical prefix rule', async () => {
  const gemini = await dispatchedModel('gemini-3.8-flash', {});
  assert.equal(gemini.model, 'gemini-3.8-flash');
  // Silence is not a no: with no catalogue to read, the account's id cannot be vouched for, so no
  // `--model` is sent and agy runs its own default — and the row is left alone, since a runner
  // that has said nothing cannot retire a pin.
  const claude = await dispatchedModel('claude-sonnet-5-5', {});
  assert.equal(claude.model, '');
  assert.deepEqual(claude.modelWrites, []);
});

test('an unpinned session on a signed-in runner inherits the catalogue’s first row', async () => {
  // agy's own order puts the Gemini rows first (production catalogue above), so the inherited
  // default is exactly what it was before the account's rows existed.
  const dispatched = await dispatchedModel(null, { antigravity: GOOGLE_SIGN_IN_CATALOG });
  assert.equal(dispatched.model, 'gemini-3.8-flash');
  assert.deepEqual(dispatched.modelWrites, ['gemini-3.8-flash']);
});
