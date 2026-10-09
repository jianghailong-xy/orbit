import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validate } from 'class-validator';
import { AgentProvider } from '@orbit/shared';
import { execRuntime, isBuiltinProvider, resolveProviderExec } from './custom-provider';
import { sessionEngine } from './session-engine';
import { CreateModelProviderDto, TestModelProviderDto, UpdateModelProviderDto } from './dto';
import { encryptSecret } from './provider-crypto';
import { followsRuntimeCatalog, ownsModel, withPreset } from './preset-overlay';
import { pickFreeSlug } from './provider-slug';
import { ProvidersService } from './providers.service';
import { poolMemberRefusal } from './pool-admission';

process.env.PROVIDER_SECRET_KEY = 'p1a-provider-fixture-secret';

const OWNER = 'owner-1';
const OPAQUE_MODEL = '["deepseek","v4-flash"]';
const OTHER_OPAQUE_MODEL = 'opaque-acp-selection-v2';

function legacyDeepSeek() {
  return {
    id: 'legacy-deepseek', ownerId: OWNER, slug: 'deepseek', label: 'DeepSeek',
    runtime: 'claude', baseUrl: 'https://api.deepseek.com/anthropic', apiKeyEnc: encryptSecret('sk-legacy'),
    models: [{ value: 'deepseek-chat', label: 'Saved DeepSeek model' }],
    defaultModel: 'deepseek-chat', presetSlug: null, followsPreset: false, enabled: true,
  };
}

function harness() {
  return {
    ...legacyDeepSeek(), id: 'harness-provider', slug: 'deepseek-harness', runtime: 'dsh',
    baseUrl: 'https://api.deepseek.com/anthropic', apiKeyEnc: encryptSecret('sk-harness'),
    presetSlug: 'deepseek-harness', followsPreset: true, models: [], defaultModel: null,
  };
}

/** An admin, for whom a shared row resolves as any row of theirs does (usableProviderScope). */
const admin = { findUnique: async () => ({ role: 'ADMIN' }) };

function serviceFor(db: object) {
  return new ProvidersService({ user: admin, ...db } as never, { publishForUser() {}, publishForAllUsers() {} } as never, {} as never);
}

function createDto(overrides: Partial<CreateModelProviderDto> = {}): CreateModelProviderDto {
  return { label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/anthropic', apiKey: 'sk-created', ...overrides };
}

test('P1a existing DeepSeek configuration keeps Claude for new tasks', async () => {
  let saved = legacyDeepSeek();
  const service = serviceFor({
    modelProvider: {
      findMany: async () => [],
      create: async ({ data }: { data: object }) => (saved = { ...saved, ...data }),
    },
    providerPool: { findMany: async () => [] },
  });
  const created = await service.create(OWNER, createDto({ presetSlug: 'deepseek' }));
  assert.equal(created.runtime, 'claude');
  assert.equal(created.slug, 'deepseek');
  const exec = resolveProviderExec({ declaredProvider: created.slug, customRow: saved });
  assert.equal(exec.provider, AgentProvider.CLAUDE);
  assert.equal(exec.env?.ANTHROPIC_AUTH_TOKEN, 'sk-created');
  assert.equal(exec.env?.ANTHROPIC_BASE_URL, 'https://api.deepseek.com/anthropic');
  assert.equal(exec.env?.ORBIT_DSH_API_KEY, undefined);
  assert.equal(exec.model, created.defaultModel);
});

test('P1a historical DeepSeek model pins stay on Claude', () => {
  for (const model of ['deepseek-chat', 'deepseek-reasoner']) {
    const row = legacyDeepSeek();
    const before = { ...row };
    const exec = resolveProviderExec({
      declaredProvider: 'deepseek', customRow: row, sessionModel: model,
      runtimeDefaultModels: { dsh: OPAQUE_MODEL },
      modelCatalog: { dsh: [{ value: OPAQUE_MODEL, label: 'Harness' }] },
    });
    assert.equal(exec.provider, AgentProvider.CLAUDE);
    assert.equal(exec.model, model);
    assert.equal(exec.env?.ANTHROPIC_MODEL, model);
    assert.deepEqual(row, before);
  }
});

test('P1a explicit Harness preset resolves dsh with dedicated API key', async () => {
  let saved = harness();
  const service = serviceFor({
    modelProvider: { findMany: async () => [], create: async ({ data }: { data: object }) => (saved = { ...saved, ...data }) },
    providerPool: { findMany: async () => [] },
  });
  const created = await service.create(OWNER, createDto({ presetSlug: 'deepseek-harness' }));
  assert.equal(created.runtime, 'dsh');
  assert.deepEqual(created.models, []);
  assert.equal(created.defaultModel, null);
  assert.equal((created as { modelsFromRuntime?: boolean }).modelsFromRuntime, true);
  const exec = resolveProviderExec({
    declaredProvider: created.slug, customRow: saved, runtimeDefaultModels: { dsh: OPAQUE_MODEL },
    workspaceEnv: { ORBIT_DSH_API_KEY: 'wrong-key', ORBIT_DSH_BASE_URL: 'https://wrong.test', EXTRA: 'kept' },
  });
  assert.equal(exec.provider, AgentProvider.DSH);
  assert.equal(exec.model, OPAQUE_MODEL);
  assert.deepEqual(exec.env, {
    ORBIT_DSH_API_KEY: 'sk-created', ORBIT_DSH_BASE_URL: 'https://api.deepseek.com/anthropic', EXTRA: 'kept',
  });
});

test('P1a dsh models use opaque runtime defaults without static fallback', () => {
  const row = { ...harness(), presetSlug: null, followsPreset: false, defaultModel: 'deepseek-v4-pro' };
  const view = withPreset(row);
  assert.equal(followsRuntimeCatalog(row), true);
  assert.equal(ownsModel(row, OPAQUE_MODEL), true);
  assert.equal(view.defaultModel, null);
  assert.deepEqual(view.models, []);
  assert.equal((view as { modelsFromRuntime?: boolean }).modelsFromRuntime, true);
  const args = { declaredProvider: row.slug, customRow: row };
  const spaced = `  ${OPAQUE_MODEL}  `;
  const offered = { dsh: [{ value: spaced, label: 'Opaque pin' }, { value: OTHER_OPAQUE_MODEL, label: 'Default' }] };
  for (const customRow of [row, null]) {
    const kept = resolveProviderExec({ ...args, declaredProvider: customRow ? row.slug : 'dsh', customRow,
      sessionModel: spaced, modelCatalog: offered, runtimeDefaultModels: { dsh: OTHER_OPAQUE_MODEL } });
    assert.equal(kept.model, spaced);
    assert.equal(kept.retiredPin, undefined);
  }
  assert.equal(resolveProviderExec(args).model, '');
  assert.equal(resolveProviderExec({ ...args, runtimeDefaultModels: { dsh: OPAQUE_MODEL } }).model, OPAQUE_MODEL);
  assert.equal(resolveProviderExec({ ...args, modelCatalog: { dsh: [{ value: OTHER_OPAQUE_MODEL }] } }).model, OTHER_OPAQUE_MODEL);
  assert.equal(resolveProviderExec({ ...args, sessionModel: OTHER_OPAQUE_MODEL }).model, OTHER_OPAQUE_MODEL);
  assert.equal(resolveProviderExec({ ...args, usesRuntimeDefaultModel: false, workspaceModel: 'deepseek-chat' }).model, '');
  assert.equal(resolveProviderExec({ ...args, customRow: { ...row, sessionToken: 'one-session-key', apiKeyEnc: 'unused' } }).env?.ORBIT_DSH_API_KEY, 'one-session-key');
  const native = { declaredProvider: 'dsh', customRow: null, usesRuntimeDefaultModel: false, workspaceModel: 'claude-opus-5' };
  assert.equal(resolveProviderExec(native).model, '');
  assert.equal(resolveProviderExec({ ...native, runtimeDefaultModels: { dsh: OPAQUE_MODEL } }).model, OPAQUE_MODEL);
  assert.equal(resolveProviderExec({ ...native, modelCatalog: { dsh: [{ value: OTHER_OPAQUE_MODEL }] } }).model, OTHER_OPAQUE_MODEL);
  const paddedToken = `  ${OPAQUE_MODEL}  `;
  for (const selection of [args, { declaredProvider: 'dsh', customRow: null }]) {
    assert.equal(resolveProviderExec({ ...selection, sessionModel: paddedToken }).model, paddedToken);
    assert.equal(resolveProviderExec({ ...selection, runtimeDefaultModels: { dsh: paddedToken } }).model, paddedToken);
    assert.equal(resolveProviderExec({ ...selection, modelCatalog: { dsh: [{ value: paddedToken }] } }).model, paddedToken);
  }
});

test('P1a dsh keyword collisions preserve configured providers and pools', async () => {
  const colliding = { ...legacyDeepSeek(), slug: 'dsh' };
  assert.equal(isBuiltinProvider('dsh'), true);
  assert.equal(isBuiltinProvider('dsh', false), false);
  assert.equal(execRuntime({ declaredProvider: 'dsh', declaredProviderBuiltin: false, customRow: colliding }), AgentProvider.CLAUDE);
  assert.equal(execRuntime({ declaredProvider: 'dsh', declaredProviderBuiltin: false, customRow: null }), AgentProvider.CLAUDE);
  assert.equal(execRuntime({ declaredProvider: 'dsh', declaredProviderBuiltin: true, customRow: null }), AgentProvider.DSH);
  const session = { provider: 'dsh', providerBuiltin: false, ownerId: OWNER };
  const rowDb = { user: admin, modelProvider: { findFirst: async () => colliding } };
  assert.equal(await sessionEngine(rowDb as never, session), AgentProvider.CLAUDE);
  const poolDb = {
    user: admin,
    modelProvider: { findFirst: async () => null },
    providerPool: { findFirst: async () => ({ shared: false, engine: 'codex' }) },
  };
  assert.equal(await sessionEngine(poolDb as never, session), AgentProvider.CODEX);
  assert.equal(await sessionEngine({} as never, { ...session, providerBuiltin: true }), AgentProvider.DSH);
  for (const [rows, pools, runtime] of [
    [[colliding], [], 'claude'], [[], [{ slug: 'dsh', label: 'Existing pool', shared: false, engine: 'codex' }], 'codex'],
  ] as const) {
    const listed = await serviceFor({
      modelProvider: { findMany: async () => rows }, providerPool: { findMany: async () => pools },
    }).listUsable(OWNER);
    const entries = listed.filter((entry) => entry.slug === 'dsh');
    assert.equal(entries.length, 1);
    assert.equal(entries[0].builtin, false);
    assert.equal(entries[0].runtime, runtime);
  }
  const disabled = await serviceFor({
    modelProvider: { findMany: async () => [{ ...colliding, enabled: false }] },
    providerPool: { findMany: async () => [] },
  }).listUsable(OWNER);
  assert.deepEqual(disabled.filter((entry) => entry.slug === 'dsh'), []);
});

test('P1a new provider slugs reserve dsh without renaming old rows', () => {
  assert.equal(pickFreeSlug('dsh', []), 'dsh-2');
  const savedSlugs = ['dsh', 'dsh-2', 'deepseek', 'other-provider'];
  assert.equal(pickFreeSlug('dsh', savedSlugs), 'dsh-3');
  assert.deepEqual(savedSlugs, ['dsh', 'dsh-2', 'deepseek', 'other-provider']);
});

test('P1a legacy dsh provider edits preserve its runtime and slug', async () => {
  const saved = { ...legacyDeepSeek(), slug: 'dsh' };
  let data: object | undefined;
  const service = serviceFor({
    modelProvider: {
      findFirst: async () => saved,
      update: async (args: { data: object }) => {
        data = args.data;
        // Prisma omits undefined update fields, preserving the persisted runtime.
        return { ...saved, ...Object.fromEntries(Object.entries(args.data).filter(([, value]) => value !== undefined)) };
      },
    },
  });
  const updated = await service.update(OWNER, saved.id, { label: 'Renamed saved provider' });
  assert.equal(updated.runtime, 'claude');
  assert.equal(updated.slug, 'dsh');
  assert.equal((data as { runtime?: string }).runtime, undefined);
});

test('P1a provider history blocks cross-runtime dsh conversion', async () => {
  for (const saved of [legacyDeepSeek(), harness()]) {
    let wrote = false;
    const service = serviceFor({ modelProvider: {
      findFirst: async () => saved,
      update: async () => { wrote = true; return saved; },
    } });
    await assert.rejects(() => service.update(OWNER, saved.id, {
      runtime: saved.runtime === 'dsh' ? 'claude' : 'dsh',
    }), /cannot change into or out of dsh/);
    assert.equal(wrote, false);
  }
  for (const history of ['session', 'task'] as const) {
    const seen: Array<{ provider: string; ownerId?: string; providerBuiltin?: boolean }> = [];
    let wrote = false;
    const record = async ({ where }: { where: (typeof seen)[number] }) => { seen.push(where); return { id: 'history' }; };
    const current = harness();
    const harnessService = serviceFor({
      modelProvider: { findFirst: async () => current, delete: async () => { wrote = true; } },
      session: { findFirst: history === 'session' ? record : async () => null },
      task: { findFirst: history === 'task' ? record : async () => null },
    });
    await assert.rejects(() => harnessService.remove(OWNER, current.id), /history and cannot be removed/);
    assert.equal(wrote, false);
    assert.equal(seen[0].provider, current.slug);
    assert.equal(seen[0].ownerId, OWNER);
    if (history === 'session') assert.equal(seen[0].providerBuiltin, false);
  }
  assert.throws(() => resolveProviderExec({ declaredProvider: 'deepseek-harness', customRow: { ...harness(), enabled: false } }), /provider is disabled/);
  assert.throws(() => resolveProviderExec({ declaredProvider: 'dsh', declaredProviderBuiltin: false,
    customRow: { ...legacyDeepSeek(), runtime: 'codex', enabled: false } }), /provider is disabled/);
});

test('P1a dsh configuration rejects static model guesses', async () => {
  assert.equal(poolMemberRefusal({
    ...harness(), baseUrl: 'https://api.anthropic.com', apiKeyEnc: encryptSecret('sk-ant-oat-fixture'),
  }), 'NOT_CLAUDE_RUNTIME');
  const service = serviceFor({ modelProvider: { findFirst: async () => harness() } });
  for (const staticSelection of [
    { defaultModel: 'deepseek-v4-pro' }, { models: [{ value: 'deepseek-v4-pro', label: 'Guessed model' }] },
  ]) {
    await assert.rejects(() => service.create(OWNER, createDto({ runtime: 'dsh', ...staticSelection })), /runtime ACP catalogue/);
    await assert.rejects(() => service.update(OWNER, 'harness-provider', staticSelection), /runtime ACP catalogue/);
  }
});

test('P1a dsh DTOs accept its runtime and HTTP probes require runtime validation', async () => {
  for (const Dto of [CreateModelProviderDto, UpdateModelProviderDto, TestModelProviderDto]) {
    const dto = Object.assign(new Dto(), createDto({ runtime: 'dsh' }));
    assert.deepEqual(await validate(dto), []);
  }
  await assert.rejects(() => serviceFor({}).testConnection({
    runtime: 'dsh', baseUrl: 'https://api.deepseek.com/anthropic', apiKey: 'sk-test', model: OPAQUE_MODEL,
  }), /requires runtime prompt validation/);
});

test('P1a other built-in engine routes remain unchanged', () => {
  const cases = [
    ['claude', 'claude-sonnet-4-5'], ['codex', 'gpt-5'], ['kimi', 'kimi-code/kimi-for-coding'],
    ['opencode', 'anthropic/claude-sonnet-4-5'], ['antigravity', 'gemini-3.1-pro'],
  ];
  for (const [provider, model] of cases) {
    const exec = resolveProviderExec({ declaredProvider: provider, customRow: null, sessionModel: model });
    assert.equal(exec.provider, provider);
    assert.equal(exec.model, model);
    assert.equal(exec.env, undefined);
  }
});
