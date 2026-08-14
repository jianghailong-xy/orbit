import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RunStatus } from '@prisma/client';

process.env.PROVIDER_SECRET_KEY = 'test-master-key';

import { encryptSecret } from '../providers/provider-crypto';
import { SessionsService } from './sessions.service';

const id = '11111111-1111-4111-8111-111111111111';
const ownerId = '22222222-2222-4222-8222-222222222222';

interface ProviderRow {
  slug: string;
  label: string;
  runtime: string;
  baseUrl: string;
  apiKeyEnc: string;
  models: unknown;
  defaultModel: string | null;
  presetSlug: string | null;
  followsPreset: boolean;
  enabled: boolean;
  ownerId: string | null;
}

const providerRow = (over: Partial<ProviderRow> & { slug: string }): ProviderRow => ({
  label: over.slug,
  runtime: 'claude',
  baseUrl: 'https://api.anthropic.com',
  apiKeyEnc: encryptSecret(`key-for-${over.slug}`),
  models: [],
  defaultModel: null,
  presetSlug: 'anthropic',
  followsPreset: true,
  enabled: true,
  ownerId,
  ...over,
});

/** A session row plus the providers that exist, wired into the tx shape updateConfig uses. */
function harness(
  session: Record<string, unknown>,
  providers: ProviderRow[] = [],
): {
  service: SessionsService;
  updated: () => Record<string, unknown>;
  reloads: () => Array<Record<string, unknown>>;
} {
  let updated: Record<string, unknown> = {};
  const reloads: Array<Record<string, unknown>> = [];
  const tx = {
    $queryRaw: async () => [{ id }],
    session: {
      findUniqueOrThrow: async () => ({
        id,
        ownerId,
        status: RunStatus.AWAITING_INPUT,
        providerBuiltin: true,
        permissionMode: 'default',
        usesRuntimeDefaultModel: true,
        numTurns: 1,
        workspace: null,
        assignedRunner: null,
        ...session,
      }),
      update: async ({ data }: { data: Record<string, unknown> }) => {
        updated = data;
        return { id };
      },
    },
    modelProvider: {
      findFirst: async ({ where }: { where: { slug: string; enabled?: boolean } }) =>
        providers.find(
          (p) => p.slug === where.slug && (where.enabled === undefined || p.enabled),
        ) ?? null,
    },
    conversationTurn: {
      findUnique: async () => null,
      findFirst: async () => null,
      create: async ({ data }: { data: Record<string, unknown> }) => {
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
  return { service, updated: () => updated, reloads: () => reloads };
}

test('switching between two Anthropic providers keeps the model and marks the reload', async () => {
  const { service, updated, reloads } = harness(
    { provider: 'anthropic', providerBuiltin: false, model: 'claude-opus-5' },
    [providerRow({ slug: 'anthropic' }), providerRow({ slug: 'anthropic-2' })],
  );

  await service.updateConfig(ownerId, id, { provider: 'anthropic-2' });

  assert.equal(updated().provider, 'anthropic-2');
  assert.equal(updated().providerBuiltin, false);
  // Both rows follow a preset whose models come from the runtime CLI, so it is one model space.
  assert.equal(updated().model, 'claude-opus-5');
  assert.deepEqual(JSON.parse(reloads()[0].content as string), {
    model: 'claude-opus-5',
    permissionMode: 'default',
    provider: 'anthropic-2',
  });
});

test('the built-in engine is a legal target for a claude-runtime provider', async () => {
  const { service, updated } = harness(
    { provider: 'anthropic', providerBuiltin: false, model: 'claude-opus-5' },
    [providerRow({ slug: 'anthropic' })],
  );

  await service.updateConfig(ownerId, id, { provider: 'claude' });

  assert.equal(updated().provider, 'claude');
  assert.equal(updated().providerBuiltin, true);
  assert.equal(updated().model, 'claude-opus-5');
});

test('a cross-runtime switch is refused rather than silently re-pointed', async () => {
  const { service, reloads } = harness(
    { provider: 'claude', providerBuiltin: true, model: 'claude-opus-5' },
    [providerRow({ slug: 'openai', runtime: 'codex', presetSlug: 'openai' })],
  );

  await assert.rejects(
    () => service.updateConfig(ownerId, id, { provider: 'openai' }),
    /claude session cannot switch to a provider that runs on codex/,
  );
  assert.equal(reloads().length, 0);
});

test('a built-in cross-runtime target is refused too', async () => {
  const { service } = harness({ provider: 'claude', providerBuiltin: true, model: 'claude-opus-5' });

  await assert.rejects(
    () => service.updateConfig(ownerId, id, { provider: 'codex' }),
    /claude session cannot switch to a provider that runs on codex/,
  );
});

test('a provider the caller cannot dispatch with is refused', async () => {
  const { service } = harness(
    { provider: 'claude', providerBuiltin: true, model: 'claude-opus-5' },
    [providerRow({ slug: 'disabled-row', enabled: false })],
  );

  await assert.rejects(
    () => service.updateConfig(ownerId, id, { provider: 'disabled-row' }),
    /provider not available/,
  );
  await assert.rejects(
    () => service.updateConfig(ownerId, id, { provider: 'never-configured' }),
    /provider not available/,
  );
});

test('a target that maintains its own model list restarts at its default', async () => {
  const { service, updated } = harness(
    { provider: 'anthropic', providerBuiltin: false, model: 'claude-opus-5' },
    [
      providerRow({ slug: 'anthropic' }),
      providerRow({
        slug: 'zhipu',
        presetSlug: null,
        followsPreset: false,
        models: [{ value: 'glm-5', label: 'GLM-5' }],
        defaultModel: 'glm-5',
      }),
    ],
  );

  await service.updateConfig(ownerId, id, { provider: 'zhipu' });

  assert.equal(updated().provider, 'zhipu');
  assert.equal(updated().model, 'glm-5');
});

test('an explicit model wins over the carried one', async () => {
  const { service, updated } = harness(
    { provider: 'anthropic', providerBuiltin: false, model: 'claude-opus-5' },
    [
      providerRow({ slug: 'anthropic' }),
      providerRow({
        slug: 'zhipu',
        presetSlug: null,
        followsPreset: false,
        models: [{ value: 'glm-5', label: 'GLM-5' }],
        defaultModel: 'glm-5',
      }),
    ],
  );

  await service.updateConfig(ownerId, id, { provider: 'zhipu', model: 'glm-5-air' });

  assert.equal(updated().model, 'glm-5-air');
});

// The Claude allow-list polices built-in models only. A configured provider's model space is the
// vendor's (GLM here), so the CLI is the one that decides whether it can run Auto — clamping on
// this side would downgrade a mode the runtime accepts. See normalizeBuiltinPermissionMode's
// `customProvider`, and note the clamp judges the provider being switched TO, not the one the
// session is leaving.
test('a switch to a configured provider leaves Auto alone — its models are the vendor\'s', async () => {
  const { service, updated } = harness(
    { provider: 'claude', providerBuiltin: true, model: 'claude-opus-5', permissionMode: 'auto' },
    [
      providerRow({
        slug: 'zhipu',
        presetSlug: null,
        followsPreset: false,
        models: [{ value: 'glm-5', label: 'GLM-5' }],
        defaultModel: 'glm-5',
      }),
    ],
  );

  await service.updateConfig(ownerId, id, { provider: 'zhipu' });

  assert.equal(updated().model, 'glm-5');
  assert.equal(updated().permissionMode, 'auto');
});

// The clamp itself still has to fire where the allow-list does apply: a built-in target, on a
// model Claude Code rejects Auto for.
test('a switch to the built-in engine re-clamps Auto for a model it cannot run', async () => {
  const { service, updated } = harness(
    { provider: 'anthropic', providerBuiltin: false, model: 'claude-opus-5', permissionMode: 'auto' },
    [providerRow({ slug: 'anthropic' })],
  );

  await service.updateConfig(ownerId, id, {
    provider: 'claude',
    model: 'claude-haiku-4-5-20251001',
  });

  assert.equal(updated().providerBuiltin, true);
  assert.equal(updated().model, 'claude-haiku-4-5-20251001');
  assert.equal(updated().permissionMode, 'default');
});

test('re-selecting the running provider changes nothing and carries no marker', async () => {
  const { service, updated, reloads } = harness(
    { provider: 'anthropic', providerBuiltin: false, model: 'claude-opus-5' },
    [providerRow({ slug: 'anthropic' })],
  );

  await service.updateConfig(ownerId, id, { provider: 'anthropic' });

  assert.equal('provider' in updated(), false);
  assert.equal(JSON.parse(reloads()[0].content as string).provider, undefined);
});

test('a PENDING session takes the new provider without a reload — its claim reads it', async () => {
  const { service, updated, reloads } = harness(
    {
      provider: 'anthropic',
      providerBuiltin: false,
      model: 'claude-opus-5',
      status: RunStatus.PENDING,
    },
    [providerRow({ slug: 'anthropic' }), providerRow({ slug: 'anthropic-2' })],
  );

  await service.updateConfig(ownerId, id, { provider: 'anthropic-2' });

  assert.equal(updated().provider, 'anthropic-2');
  assert.equal(reloads().length, 0);
});

test('a provider-only patch is a real update, not "nothing to update"', async () => {
  const { service } = harness({ provider: 'claude', providerBuiltin: true, model: 'claude-opus-5' });

  await assert.rejects(() => service.updateConfig(ownerId, id, {}), /nothing to update/);
});

/** The same switch, taken at revive time. There is no live process to reload: the row goes
 *  PENDING and the claim resolves the environment from it. */
function resumeHarness(session: Record<string, unknown>, providers: ProviderRow[] = []) {
  const now = new Date();
  const row = {
    id,
    ownerId,
    status: RunStatus.SUCCEEDED,
    startedAt: now,
    numTurns: 2,
    runtimeSessionId: '55555555-5555-4555-8555-555555555555',
    assignedRunnerId: 'runner-1',
    assignedRunner: { id: 'runner-1', status: 'ONLINE', lastHeartbeatAt: now },
    cancelRequestedAt: null,
    archivedAt: null,
    completedAt: null,
    deletedAt: null,
    providerBuiltin: true,
    mergeStatus: null,
    mergeOperationId: null,
    mergeOperationOwner: null,
    commitStatus: null,
    commitOperationId: null,
    commitOperationOwner: null,
    ...session,
  };
  const updates: Array<{ data: Record<string, unknown> }> = [];
  const sessionDelegate = {
    findFirst: async () => row,
    findUniqueOrThrow: async () => row,
    update: async (args: { data: Record<string, unknown> }) => {
      updates.push(args);
      return row;
    },
  };
  const conversationTurnDelegate = {
    findUnique: async () => null,
    findFirst: async () => ({ seq: 4 }),
    create: async ({ data }: { data: { seq: number } }) => ({ id: 'revive-turn', ...data }),
  };
  const prisma = {
    session: sessionDelegate,
    conversationTurn: conversationTurnDelegate,
    $transaction: async (fn: (tx: unknown) => unknown) =>
      fn({
        $queryRaw: async () => [{ id }],
        $executeRaw: async () => 1,
        session: sessionDelegate,
        conversationTurn: conversationTurnDelegate,
        modelProvider: {
          findFirst: async ({ where }: { where: { slug: string; enabled?: boolean } }) =>
            providers.find(
              (p) => p.slug === where.slug && (where.enabled === undefined || p.enabled),
            ) ?? null,
        },
      }),
  } as never;
  const service = new SessionsService(prisma, { notifySessionQueued: () => undefined } as never, {
    publishSessionCreated: () => undefined,
  } as never);
  return { service, updates };
}

const revive = { clientTurnId: 'revive-1', content: 'carry on, on the other account' };

test('an ended session can be revived on another provider of the same runtime', async () => {
  const { service, updates } = resumeHarness(
    { provider: 'anthropic', providerBuiltin: false, model: 'claude-opus-5' },
    [providerRow({ slug: 'anthropic' }), providerRow({ slug: 'anthropic-2' })],
  );

  await service.resume(ownerId, id, { ...revive, provider: 'anthropic-2' });

  const data = updates[0].data;
  assert.equal(data.status, RunStatus.PENDING);
  assert.equal(data.provider, 'anthropic-2');
  assert.equal(data.providerBuiltin, false);
  // Both share the runtime's model space, so the revived session keeps what it was running.
  assert.equal('model' in data, false);
});

test('a revive onto a provider with its own model list clears the model for the claim', async () => {
  const { service, updates } = resumeHarness(
    { provider: 'anthropic', providerBuiltin: false, model: 'claude-opus-5' },
    [
      providerRow({ slug: 'anthropic' }),
      providerRow({
        slug: 'zhipu',
        presetSlug: null,
        followsPreset: false,
        models: [{ value: 'glm-5', label: 'GLM-5' }],
        defaultModel: 'glm-5',
      }),
    ],
  );

  await service.resume(ownerId, id, { ...revive, provider: 'zhipu' });

  // Null, not glm-5: an unset model is what makes the claim resolve it against the provider it
  // is claiming for, using the runner's live catalogue rather than a guess made here.
  assert.equal(updates[0].data.model, null);
});

test('a revive cannot cross runtimes either', async () => {
  const { service } = resumeHarness({ provider: 'claude', model: 'claude-opus-5' });

  await assert.rejects(
    () => service.resume(ownerId, id, { ...revive, provider: 'codex' }),
    /claude session cannot switch to a provider that runs on codex/,
  );
});

test('a revive without a provider leaves the session on the one it ended with', async () => {
  const { service, updates } = resumeHarness(
    { provider: 'anthropic', providerBuiltin: false, model: 'claude-opus-5' },
    [providerRow({ slug: 'anthropic' })],
  );

  await service.resume(ownerId, id, revive);

  assert.equal('provider' in updates[0].data, false);
  assert.equal('model' in updates[0].data, false);
});
