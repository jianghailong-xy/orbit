import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validate } from 'class-validator';
import { AgentProvider } from '@orbit/shared';
import { isBuiltinProvider, resolveProviderExec } from './custom-provider';
import { classifyProvider, resolvedCredentialEngines } from './engine-provider';
import { sessionEngine } from './session-engine';
import { CreateModelProviderDto, TestModelProviderDto, UpdateModelProviderDto } from './dto';
import { encryptSecret } from './provider-crypto';
import { followsRuntimeCatalog, ownsModel, withPreset } from './preset-overlay';
import { pickFreeSlug } from './provider-slug';
import { ProvidersService } from './providers.service';
import { poolMemberRefusal } from './pool-admission';
import { renderRawQuery } from '../test-support/prisma-transaction-double';

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
    providerSlugAlias: { findMany: async () => [] },
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

test('T3 the retired Harness preset creates a DeepSeek key, which DeepSeek Harness runs on with its dedicated API key', async () => {
  let saved = harness();
  const service = serviceFor({
    modelProvider: { findMany: async () => [], create: async ({ data }: { data: object }) => (saved = { ...saved, ...data }) },
    providerPool: { findMany: async () => [] },
    providerSlugAlias: { findMany: async () => [] },
  });
  // An older client connecting "DeepSeek Harness" gets a DeepSeek key (docs/provider-engine-contract.md §3.6):
  // the DeepSeek preset, Anthropic's protocol, DeepSeek's own model list, and the vendor's name.
  const created = await service.create(OWNER, createDto({ presetSlug: 'deepseek-harness', label: 'DeepSeek Harness' }));
  assert.equal(created.runtime, 'claude');
  assert.equal(created.presetSlug, 'deepseek');
  assert.equal(created.slug, 'deepseek');
  assert.equal(created.label, 'DeepSeek');
  assert.ok((created.models as unknown[]).length > 0);
  assert.deepEqual(created.engines, [AgentProvider.CLAUDE, AgentProvider.OPENCODE, AgentProvider.DSH]);
  const exec = resolveProviderExec({
    engine: AgentProvider.DSH, declaredProvider: created.slug, customRow: saved, runtimeDefaultModels: { dsh: OPAQUE_MODEL },
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
  // A configured row or pool named `dsh` is what the slug names; the built-in one only when neither is there.
  const deps = (db: object) => ({ db: { user: admin, ...db } as never, poolRefusal: async () => null });
  const named = await classifyProvider(deps({ modelProvider: { findFirst: async () => colliding } }), OWNER, 'dsh', 'session');
  assert.equal(named.kind, 'key');
  assert.deepEqual(resolvedCredentialEngines(named), [AgentProvider.CLAUDE, AgentProvider.OPENCODE, AgentProvider.DSH]);
  const pooled = await classifyProvider(deps({
    modelProvider: { findFirst: async () => null },
    providerPool: { findFirst: async () => ({ shared: false, engine: 'codex' }) },
  }), OWNER, 'dsh', 'session');
  assert.deepEqual(pooled, { kind: 'pool', slug: 'dsh', engine: AgentProvider.CODEX });
  const builtin = await classifyProvider(deps({
    modelProvider: { findFirst: async () => null },
    providerPool: { findFirst: async () => null },
    providerSlugAlias: { findUnique: async () => null },
  }), OWNER, 'dsh', 'session');
  assert.deepEqual(builtin, { kind: 'legacy-dsh' });
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

test('T3 a key never becomes dsh, leaves it unless that strands what uses it, and is deleted whatever its history', async () => {
  // Into dsh: DeepSeek Harness is an engine, not a protocol (PROVIDER_RUNTIME_DSH_RETIRED), and nothing is written.
  {
    let wrote = false;
    const saved = legacyDeepSeek();
    const service = serviceFor({ modelProvider: { findFirst: async () => saved, update: async () => { wrote = true; return saved; } } });
    await assert.rejects(() => service.update(OWNER, saved.id, { runtime: 'dsh' }),
      (error: { response?: { code?: string } }) => error.response?.code === 'PROVIDER_RUNTIME_DSH_RETIRED');
    assert.equal(wrote, false);
  }
  // Out of dsh, judged by what uses the key: an open DeepSeek Harness session keeps a DeepSeek key on Anthropic's
  // protocol (it still runs there), and is stranded by OpenAI's (PROVIDER_DIALECT_IN_USE, 409).
  for (const [runtime, refused] of [['claude', false], ['codex', true]] as const) {
    let wrote = false;
    const current = harness();
    const service = serviceFor({
      modelProvider: { findFirst: async () => current, update: async ({ data }: { data: object }) => { wrote = true; return { ...current, ...data }; } },
      $queryRaw: async (...args: unknown[]) => (renderRawQuery(args).text.includes('FROM "session"')
        ? [{ engine: 'dsh', n: 1 }] : []),
      $executeRaw: async () => 0,
    });
    if (refused) {
      await assert.rejects(() => service.update(OWNER, current.id, { runtime }),
        (error: { response?: { code?: string; engines?: string[]; sessions?: number } }) =>
          error.response?.code === 'PROVIDER_DIALECT_IN_USE'
          && error.response.engines?.[0] === 'dsh' && error.response.sessions === 1);
      assert.equal(wrote, false);
    } else {
      assert.equal((await service.update(OWNER, current.id, { runtime })).runtime, runtime);
      assert.equal(wrote, true);
    }
  }
  // Deleted whatever its history: its sessions keep their engine and wait for another key.
  let deleted = false;
  const current = harness();
  const harnessService = serviceFor({
    modelProvider: { findFirst: async () => current, delete: async () => { deleted = true; } },
    $executeRaw: async () => 0,
  });
  assert.deepEqual(await harnessService.remove(OWNER, current.id), { ok: true });
  assert.equal(deleted, true);
  assert.throws(() => resolveProviderExec({ declaredProvider: 'deepseek-harness', customRow: { ...harness(), enabled: false } }), /provider is disabled/);
  assert.throws(() => resolveProviderExec({ declaredProvider: 'dsh', declaredProviderBuiltin: false,
    customRow: { ...legacyDeepSeek(), runtime: 'codex', enabled: false } }), /provider is disabled/);
});

test('T3 a Harness-shaped create keeps DeepSeek\'s own models, and a legacy dsh row edits like any key', async () => {
  assert.equal(poolMemberRefusal({
    ...harness(), baseUrl: 'https://api.anthropic.com', apiKeyEnc: encryptSecret('sk-ant-oat-fixture'),
  }), 'NOT_CLAUDE_RUNTIME');
  let saved = harness();
  const service = serviceFor({
    modelProvider: {
      findFirst: async () => harness(),
      findMany: async () => [],
      create: async ({ data }: { data: object }) => (saved = { ...saved, ...data }),
      update: async ({ data }: { data: object }) => ({ ...harness(), ...data }),
    },
    providerPool: { findMany: async () => [] },
    providerSlugAlias: { findMany: async () => [] },
  });
  for (const staticSelection of [
    { defaultModel: 'deepseek-v4-pro' }, { models: [{ value: 'guessed-model', label: 'Guessed model' }] },
  ]) {
    // The models a Harness form names are not the key's: it gets DeepSeek's own list.
    const created = await service.create(OWNER, createDto({ runtime: 'dsh', ...staticSelection }));
    assert.equal(created.runtime, 'claude');
    assert.ok(!(created.models as Array<{ value: string }>).some((model) => model.value === 'guessed-model'));
    // A row still on the retired runtime takes an edit of its models like any other key.
    await service.update(OWNER, 'harness-provider', staticSelection);
  }
});

test('T3 the dsh runtime is still accepted by the DTOs, and a DeepSeek key is probed on Anthropic Messages', async () => {
  for (const Dto of [CreateModelProviderDto, UpdateModelProviderDto, TestModelProviderDto]) {
    const dto = Object.assign(new Dto(), createDto({ runtime: 'dsh' }));
    assert.deepEqual(await validate(dto), []);
  }
  const seen: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    seen.push(String(url));
    return new Response('{}', { status: 200 });
  }) as typeof fetch;
  try {
    for (const runtime of ['dsh', 'claude']) {
      assert.deepEqual(await serviceFor({}).testConnection({
        runtime, baseUrl: 'https://api.deepseek.com/anthropic', apiKey: 'sk-test', model: 'deepseek-v4-pro',
      }), { ok: true, status: 200, message: 'Connected' });
    }
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.deepEqual(seen, [
    'https://api.deepseek.com/anthropic/v1/messages', 'https://api.deepseek.com/anthropic/v1/messages',
  ]);
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
