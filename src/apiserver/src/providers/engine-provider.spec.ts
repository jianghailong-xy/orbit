/**
 * The one resolution every door that takes an engine and a provider runs (providers/engine-provider.ts,
 * docs/provider-engine-contract.md §3), and the answers built on it that need no database: the four
 * combinations, the refusals and their wording, the two old spellings, retired provider names, a
 * session's switch, a task's pins, the remembered models, the v3 run receipt, the route that keeps a
 * key, the quota gate, and the provider lists. Named in scripts/test-provider-engine-api.mjs.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentProvider } from '@orbit/shared';
import {
  classifyProvider,
  defaultDeepSeekKey,
  normalizeDefaultModels,
  resolveEngineProvider,
  resolveSessionSwitch,
  resolveTaskPin,
  type EngineProviderDeps,
} from './engine-provider';
import { encryptSecret } from './provider-crypto';
import { ProvidersService } from './providers.service';
import { readBatchPlan, readExecuteTarget, taskRunEngine } from '../tasks/task-run-receipt';
import { routeTaskRun, type ModelRoutingInput } from '../tasks/model-routing';
import { TasksService } from '../tasks/tasks.service';

process.env.PROVIDER_SECRET_KEY ??= 'engine-provider-spec';

const OWNER = '11111111-1111-4111-8111-111111111111';

interface Key {
  id: string;
  slug: string;
  label: string;
  runtime: string;
  presetSlug: string | null;
  baseUrl: string;
  apiKeyEnc: string;
  enabled: boolean;
  ownerId: string | null;
  position: number | null;
  createdAt: Date;
  models: unknown;
  defaultModel: string | null;
  followsPreset: boolean;
}

let made = 0;
function key(slug: string, over: Partial<Key> & { apiKey?: string } = {}): Key {
  const { apiKey, ...rest } = over;
  made += 1;
  return {
    id: `key-${made}`,
    slug,
    label: slug,
    runtime: 'claude',
    presetSlug: null,
    baseUrl: 'https://api.example.test',
    apiKeyEnc: encryptSecret(apiKey ?? `sk-${slug}`),
    enabled: true,
    ownerId: OWNER,
    position: null,
    createdAt: new Date(Date.UTC(2026, 9, 1, 0, 0, made)),
    models: [],
    defaultModel: null,
    followsPreset: false,
    ...rest,
  };
}

const deepSeek = (slug: string, over: Partial<Key> = {}) =>
  key(slug, { presetSlug: 'deepseek', baseUrl: 'https://api.deepseek.com/anthropic', ...over });
const glm = (slug = 'glm') => key(slug, { presetSlug: 'glm', baseUrl: 'https://open.bigmodel.cn/api/anthropic' });
const gemini = (slug = 'gemini') => key(slug, { runtime: 'antigravity', presetSlug: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com' });
const subscription = (slug = 'claude-sub') =>
  key(slug, { presetSlug: 'anthropic', baseUrl: 'https://api.anthropic.com', apiKey: 'sk-ant-oat01-fixture' });
const responses = (slug = 'openai-key') => key(slug, { runtime: 'codex', presetSlug: 'openai', baseUrl: 'https://api.openai.com/v1' });

/** A database holding these keys, pools and retired names, answering the queries the resolution asks. */
function world(opts: {
  keys?: Key[];
  pools?: Array<{ slug: string; engine: string; shared?: boolean }>;
  aliases?: Array<{ slug: string; providerId: string; engine: string }>;
  role?: string;
} = {}) {
  const keys = opts.keys ?? [];
  const ordered = (rows: Key[]) => [...rows].sort((a, b) =>
    (a.position ?? Infinity) - (b.position ?? Infinity) || a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
  const inScope = (row: Key, where: Record<string, unknown>) => {
    if (where.ownerId !== undefined && row.ownerId !== where.ownerId) return false;
    const or = where.OR as Array<{ ownerId: string | null }> | undefined;
    if (or && !or.some((scope) => scope.ownerId === row.ownerId)) return false;
    return true;
  };
  const db = {
    user: { findUnique: async () => ({ role: opts.role ?? 'USER', preferences: {} }) },
    modelProvider: {
      findFirst: async ({ where }: { where: Record<string, unknown> }) => keys.find((row) =>
        (where.slug === undefined || row.slug === where.slug)
        && (where.id === undefined || row.id === where.id)
        && (where.enabled === undefined || row.enabled === where.enabled)
        && inScope(row, where)) ?? null,
      findMany: async ({ where }: { where: Record<string, unknown> }) => ordered(keys.filter((row) =>
        (where.enabled === undefined || row.enabled === where.enabled) && inScope(row, where))),
    },
    providerPool: {
      findFirst: async ({ where }: { where: { slug: string; ownerId?: string; engine?: string } }) => {
        const pool = (opts.pools ?? []).find((candidate) => candidate.slug === where.slug);
        if (!pool) return null;
        if (where.ownerId) return pool.shared ? null : { shared: false, engine: pool.engine };
        return pool.engine === 'codex' && pool.shared ? { id: pool.slug } : null;
      },
    },
    providerSlugAlias: {
      findUnique: async ({ where }: { where: { slug: string } }) =>
        (opts.aliases ?? []).find((alias) => alias.slug === where.slug) ?? null,
    },
  };
  const deps: EngineProviderDeps = { db: db as never, poolRefusal: async () => null };
  return { db, deps };
}

const refusal = (code: string, message?: string) =>
  (error: { response?: { code?: string; message?: string } }) =>
    error.response?.code === code && (message === undefined || error.response.message === message);

test('T3 resolution: a provider alone runs on the engine it ran on before the split', async () => {
  const keys = [deepSeek('deepseek'), glm(), responses(), gemini(), key('legacy-harness', { runtime: 'dsh', presetSlug: 'deepseek-harness', baseUrl: 'https://api.deepseek.com/anthropic' })];
  const { deps } = world({ keys, pools: [{ slug: 'codex-pool', engine: 'codex' }], aliases: [{ slug: 'old-harness', providerId: keys[0].id, engine: 'dsh' }] });
  const engineOf = async (provider: string) => (await resolveEngineProvider(deps, { ownerId: OWNER, provider, door: 'session' }));
  assert.equal((await engineOf('codex')).engine, AgentProvider.CODEX);
  assert.equal((await engineOf('opencode')).engine, AgentProvider.OPENCODE);
  // A key on its protocol's own CLI; a DeepSeek key is an Anthropic-protocol key, so Claude Code.
  assert.equal((await engineOf('deepseek')).engine, AgentProvider.CLAUDE);
  assert.equal((await engineOf('glm')).engine, AgentProvider.CLAUDE);
  assert.equal((await engineOf('openai-key')).engine, AgentProvider.CODEX);
  assert.equal((await engineOf('gemini')).engine, AgentProvider.ANTIGRAVITY);
  // A row still on the retired runtime ran on DeepSeek Harness, and a retired name is its key on Harness.
  assert.equal((await engineOf('legacy-harness')).engine, AgentProvider.DSH);
  const aliased = await engineOf('old-harness');
  assert.deepEqual([aliased.engine, aliased.provider, aliased.providerBuiltin], [AgentProvider.DSH, 'deepseek', false]);
  assert.equal((await engineOf('codex-pool')).engine, AgentProvider.CODEX);
});

test('T3 resolution: an engine alone runs on its own credential, DeepSeek Harness on the first enabled DeepSeek key', async () => {
  const keys = [
    glm('glm-first'),
    deepSeek('ds-later', { position: 2 }),
    deepSeek('ds-off', { position: 0, enabled: false }),
    deepSeek('ds-first', { position: 1 }),
  ];
  const { deps } = world({ keys });
  const resolve = (engine: string) => resolveEngineProvider(deps, { ownerId: OWNER, engine, door: 'session' });
  for (const engine of [AgentProvider.CLAUDE, AgentProvider.CODEX, AgentProvider.KIMI, AgentProvider.ANTIGRAVITY]) {
    assert.deepEqual(
      (({ engine: e, provider, providerBuiltin }) => ({ e, provider, providerBuiltin }))(await resolve(engine)),
      { e: engine, provider: engine, providerBuiltin: true },
    );
  }
  assert.deepEqual([(await resolve('opencode')).provider, (await resolve('opencode')).providerBuiltin], ['opencode', true]);
  const dsh = await resolve('dsh');
  // Position, then age: the disabled one is skipped and the GLM key is no DeepSeek key.
  assert.deepEqual([dsh.engine, dsh.provider, dsh.providerBuiltin], [AgentProvider.DSH, 'ds-first', false]);
  assert.equal((await defaultDeepSeekKey(world({ keys: [glm()] }).db as never, OWNER)), null);
  await assert.rejects(
    resolveEngineProvider(world({ keys: [glm()] }).deps, { ownerId: OWNER, engine: 'dsh', door: 'session' }),
    refusal('DEEPSEEK_KEY_REQUIRED', 'DeepSeek Harness runs on a DeepSeek API key; connect one, then try again'),
  );
});

test('T3 resolution: an engine and a provider named together are checked against each other', async () => {
  const keys = [deepSeek('deepseek'), subscription(), responses()];
  const { deps } = world({ keys });
  const pair = (engine: string, provider: string) => resolveEngineProvider(deps, { ownerId: OWNER, engine, provider, door: 'session' });
  for (const engine of [AgentProvider.CLAUDE, AgentProvider.OPENCODE, AgentProvider.DSH]) {
    const resolved = await pair(engine, 'deepseek');
    assert.deepEqual([resolved.engine, resolved.provider], [engine, 'deepseek']);
  }
  assert.equal((await pair('claude', 'claude-sub')).engine, AgentProvider.CLAUDE);
  assert.equal((await pair('opencode', 'openai-key')).engine, AgentProvider.OPENCODE);
  assert.equal((await pair('codex', 'codex')).provider, 'codex');
});

test('T3 resolution: neither named starts where the workspace last started, re-checked', async () => {
  const keys = [deepSeek('deepseek'), key('edited', { runtime: 'claude' })];
  const { deps } = world({ keys });
  const fromSeed = (seed: { engine: AgentProvider | null; provider: string; providerBuiltin: boolean }) =>
    resolveEngineProvider(deps, { ownerId: OWNER, door: 'session', seed: async () => seed });
  const harness = await fromSeed({ engine: AgentProvider.DSH, provider: 'deepseek', providerBuiltin: false });
  assert.deepEqual([harness.engine, harness.provider], [AgentProvider.DSH, 'deepseek']);
  // A key whose protocol moved under the seed's engine gives way to the key's own default engine.
  const moved = await fromSeed({ engine: AgentProvider.CODEX, provider: 'edited', providerBuiltin: false });
  assert.deepEqual([moved.engine, moved.provider], [AgentProvider.CLAUDE, 'edited']);
  const login = await fromSeed({ engine: AgentProvider.CODEX, provider: 'codex', providerBuiltin: true });
  assert.deepEqual([login.engine, login.provider, login.providerBuiltin], [AgentProvider.CODEX, 'codex', true]);
  await assert.rejects(fromSeed({ engine: AgentProvider.CLAUDE, provider: 'gone', providerBuiltin: false }), /provider not available: "gone"/);
  const floor = await resolveEngineProvider(deps, { ownerId: OWNER, door: 'session' });
  assert.deepEqual([floor.engine, floor.provider], [AgentProvider.CLAUDE, AgentProvider.CLAUDE]);
});

test('T3 resolution: incompatible pairs are refused, naming the engines the provider runs on', async () => {
  const { deps } = world({ keys: [glm(), subscription(), gemini(), key('nowhere', { runtime: 'unknown-runtime' })] });
  const pair = (engine: string | undefined, provider: string) =>
    resolveEngineProvider(deps, { ownerId: OWNER, engine, provider, door: 'session' });
  await assert.rejects(pair('dsh', 'glm'), refusal('PROVIDER_ENGINE_INCOMPATIBLE',
    'provider "glm" cannot run on DeepSeek Harness; it runs on Claude Code, OpenCode'));
  await assert.rejects(pair('opencode', 'claude-sub'), refusal('PROVIDER_ENGINE_INCOMPATIBLE',
    'provider "claude-sub" cannot run on OpenCode; it runs on Claude Code'));
  await assert.rejects(pair('claude', 'gemini'), refusal('PROVIDER_ENGINE_INCOMPATIBLE',
    'provider "gemini" cannot run on Claude Code; it runs on Antigravity CLI, OpenCode'));
  await assert.rejects(pair('claude', 'codex'), refusal('PROVIDER_ENGINE_INCOMPATIBLE',
    'provider "codex" cannot run on Claude Code; it runs on Codex'));
  await assert.rejects(pair(undefined, 'nowhere'), refusal('PROVIDER_ENGINE_INCOMPATIBLE',
    'provider "nowhere" cannot run on any engine'));
  await assert.rejects(pair('gpt', 'glm'), refusal('ENGINE_UNKNOWN',
    'engine "gpt" is not one of claude, codex, kimi, antigravity, opencode, dsh'));
});

test('T3 resolution: an old OpenCode model naming a key is written as that key on OpenCode', async () => {
  const keys = [deepSeek('deepseek'), subscription(), deepSeek('off', { enabled: false })];
  const { deps } = world({ keys });
  const old = (model: string, engine?: string) =>
    resolveEngineProvider(deps, { ownerId: OWNER, engine, provider: 'opencode', model, door: 'session' });
  const written = await old('orbit-deepseek/deepseek-v4-pro');
  assert.deepEqual([written.engine, written.provider, written.providerBuiltin, written.model],
    [AgentProvider.OPENCODE, 'deepseek', false, 'deepseek-v4-pro']);
  // Its own words for a key that is not there, or turned off; the table's for one OpenCode cannot spend.
  await assert.rejects(old('orbit-missing/m'), /provider not available on OpenCode: "missing"/);
  await assert.rejects(old('orbit-off/m'), /provider not available on OpenCode: "off"/);
  await assert.rejects(old('orbit-claude-sub/claude-opus-5'), refusal('PROVIDER_ENGINE_INCOMPATIBLE'));
  await assert.rejects(old('orbit-deepseek/m', 'claude'), refusal('PROVIDER_ENGINE_INCOMPATIBLE'));
  // OpenCode's own `provider/model` is no key: OpenCode's own configuration, as it always was.
  const own = await old('anthropic/claude-opus-5');
  assert.deepEqual([own.engine, own.provider, own.model], [AgentProvider.OPENCODE, 'opencode', 'anthropic/claude-opus-5']);
});

test('T3 resolution: the built-in dsh is DeepSeek Harness on the default DeepSeek key, or refused DEEPSEEK_KEY_REQUIRED', async () => {
  const withKey = world({ keys: [deepSeek('deepseek')] });
  const resolved = await resolveEngineProvider(withKey.deps, { ownerId: OWNER, provider: 'dsh', door: 'session' });
  assert.deepEqual([resolved.engine, resolved.provider, resolved.providerBuiltin], [AgentProvider.DSH, 'deepseek', false]);
  await assert.rejects(
    resolveEngineProvider(withKey.deps, { ownerId: OWNER, engine: 'claude', provider: 'dsh', door: 'session' }),
    refusal('PROVIDER_ENGINE_INCOMPATIBLE', 'provider "dsh" cannot run on Claude Code; it runs on DeepSeek Harness'),
  );
  await assert.rejects(
    resolveEngineProvider(world().deps, { ownerId: OWNER, provider: 'dsh', door: 'session' }),
    refusal('DEEPSEEK_KEY_REQUIRED'),
  );
  // A configured row named `dsh` is what the slug names (0377), never the built-in engine.
  const configured = await resolveEngineProvider(world({ keys: [key('dsh')] }).deps, { ownerId: OWNER, provider: 'dsh', door: 'session' });
  assert.deepEqual([configured.engine, configured.provider], [AgentProvider.CLAUDE, 'dsh']);
});

test('T3 resolution: a retired provider name resolves to its key, on its engine unless one is named', async () => {
  const target = deepSeek('deepseek-2');
  const { deps } = world({ keys: [target], aliases: [{ slug: 'deepseek-harness', providerId: target.id, engine: 'dsh' }] });
  const alone = await resolveEngineProvider(deps, { ownerId: OWNER, provider: 'deepseek-harness', door: 'session' });
  assert.deepEqual([alone.engine, alone.provider], [AgentProvider.DSH, 'deepseek-2']);
  const named = await resolveEngineProvider(deps, { ownerId: OWNER, engine: 'claude', provider: 'deepseek-harness', door: 'session' });
  assert.deepEqual([named.engine, named.provider], [AgentProvider.CLAUDE, 'deepseek-2']);
  const credential = await classifyProvider(deps, OWNER, 'deepseek-harness', 'pin');
  assert.equal(credential.kind === 'key' && credential.alias?.slug, 'deepseek-harness');
});

test('T3 switch: a session engine never changes, and its credential moves only within what that engine runs', async () => {
  const keys = [deepSeek('ds-a'), deepSeek('ds-b'), glm()];
  const { deps } = world({ keys });
  const session = (over: Record<string, unknown> = {}) => ({
    ownerId: OWNER, provider: 'ds-a', providerBuiltin: false, engine: 'dsh', model: 'opaque', runtimeSessionId: 'rt-1', ...over,
  });
  const moved = await resolveSessionSwitch(deps, session(), { provider: 'ds-b' });
  assert.deepEqual([moved.engine, moved.provider, moved.changed], [AgentProvider.DSH, 'ds-b', true]);
  await assert.rejects(resolveSessionSwitch(deps, session(), { engine: 'claude' }), refusal('ENGINE_IMMUTABLE',
    "this session runs on DeepSeek Harness, and a session's engine never changes; start a new session to use Claude Code"));
  await assert.rejects(resolveSessionSwitch(deps, session(), { provider: 'glm' }), refusal('PROVIDER_ENGINE_INCOMPATIBLE',
    'provider "glm" cannot run on DeepSeek Harness; it runs on Claude Code, OpenCode'));
  await assert.rejects(resolveSessionSwitch(deps, session({ engine: 'claude' }), { provider: 'codex' }), refusal('PROVIDER_ENGINE_INCOMPATIBLE'));
  // The same engine named again is no change.
  assert.equal((await resolveSessionSwitch(deps, session(), { engine: 'dsh' })).changed, false);
  // A legacy built-in dsh session stays on its workspace's key: staying is no switch.
  const legacy = await resolveSessionSwitch(deps, session({ provider: 'dsh', providerBuiltin: true }), {});
  assert.deepEqual([legacy.provider, legacy.providerBuiltin, legacy.changed], ['dsh', true, false]);
  // Never recorded and its key gone: placed by where it goes while it never ran, refused once it has.
  const gone = session({ provider: 'deleted', engine: null });
  await assert.rejects(resolveSessionSwitch(deps, gone, { provider: 'ds-b' }), refusal('SESSION_ENGINE_UNKNOWN'));
  const fresh = await resolveSessionSwitch(deps, { ...gone, runtimeSessionId: null }, { provider: 'ds-b' });
  assert.deepEqual([fresh.engine, fresh.recordsEngine], [AgentProvider.CLAUDE, true]);
});

test('T3 task pins: the engine and the provider are written together, each three-state', async () => {
  const keys = [deepSeek('deepseek'), glm()];
  const { deps } = world({ keys });
  const pin = (request: Record<string, unknown>, current: { engine: string | null; provider: string | null } | null = null) =>
    resolveTaskPin(deps, OWNER, request, current);
  assert.deepEqual(await pin({ provider: 'deepseek' }), { engine: AgentProvider.CLAUDE, provider: 'deepseek' });
  assert.deepEqual(await pin({ engine: 'dsh', provider: 'deepseek' }), { engine: AgentProvider.DSH, provider: 'deepseek' });
  assert.deepEqual(await pin({ engine: 'dsh' }), { engine: AgentProvider.DSH });
  assert.deepEqual(await pin({ provider: 'dsh' }), { engine: AgentProvider.DSH, provider: 'deepseek' });
  await assert.rejects(pin({ engine: 'dsh', provider: 'glm' }), refusal('PROVIDER_ENGINE_INCOMPATIBLE'));
  // An engine alone keeps the provider pin, which has to run on it.
  const current = { engine: AgentProvider.CLAUDE as string, provider: 'glm' };
  await assert.rejects(pin({ engine: 'dsh' }, current), refusal('PROVIDER_ENGINE_INCOMPATIBLE'));
  assert.deepEqual(await pin({ engine: 'opencode' }, current), { engine: AgentProvider.OPENCODE });
  assert.deepEqual(await pin({ provider: null }, current), { provider: null });
  assert.deepEqual(await pin({ engine: null }, current), { engine: null });
  assert.deepEqual(await pin({ provider: 'opencode', model: 'orbit-deepseek/deepseek-v4-pro' }),
    { engine: AgentProvider.OPENCODE, provider: 'deepseek', model: 'deepseek-v4-pro' });
  await assert.rejects(pin({ engine: 'nope' }), refusal('ENGINE_UNKNOWN'));
  await assert.rejects(pin({ provider: 'nobody' }), /^Error: provider not available$|provider not available/);
});

test('T3 preferences: a new key is checked, an old one kept as written and mirrored under the key it means', async () => {
  const keys = [deepSeek('deepseek'), glm()];
  const { db } = world({ keys, aliases: [{ slug: 'old-harness', providerId: keys[0].id, engine: 'dsh' }] });
  assert.deepEqual(await normalizeDefaultModels(db as never, OWNER, {
    'dsh:deepseek': 'opaque', codex: 'gpt-6', 'opencode/deepseek': 'orbit-deepseek/deepseek-v4-pro',
    opencode: 'anthropic/claude-opus-5', 'never-heard-of': 'x',
  }), {
    'dsh:deepseek': 'opaque',
    codex: 'gpt-6', 'codex:codex': 'gpt-6',
    'opencode/deepseek': 'orbit-deepseek/deepseek-v4-pro', 'opencode:deepseek': 'deepseek-v4-pro',
    opencode: 'anthropic/claude-opus-5', 'opencode:opencode': 'anthropic/claude-opus-5',
    // An old key nothing resolves is kept, and mirrored nowhere.
    'never-heard-of': 'x',
  });
  // A retired name's key means its key on DeepSeek Harness; a new key the same PATCH names wins over it.
  assert.deepEqual(await normalizeDefaultModels(db as never, OWNER, { 'old-harness': 'opaque-2' }),
    { 'old-harness': 'opaque-2', 'dsh:deepseek': 'opaque-2' });
  assert.deepEqual(await normalizeDefaultModels(db as never, OWNER, { 'old-harness': 'opaque-2', 'dsh:deepseek': 'mine' }),
    { 'old-harness': 'opaque-2', 'dsh:deepseek': 'mine' });
  // A new key names a pair that can run, by the key's own slug.
  assert.deepEqual(await normalizeDefaultModels(db as never, OWNER, { 'dsh:old-harness': 'z' }), { 'dsh:deepseek': 'z' });
  await assert.rejects(normalizeDefaultModels(db as never, OWNER, { 'dsh:glm': 'x' }), refusal('PROVIDER_ENGINE_INCOMPATIBLE'));
  await assert.rejects(normalizeDefaultModels(db as never, OWNER, { 'gpt:glm': 'x' }), refusal('ENGINE_UNKNOWN'));
});

test('T3 receipts: v3 is read as written, v1 and v2 with no engine, the engine pin read back beside a mixed-window one, v4 refused', () => {
  const base = {
    kind: 'RUN', plan: { kind: 'CREATE', sessionId: 's' }, taskId: 't', title: 'x', prompt: 'p', workspaceId: 'w', runnerId: 'r',
    provider: 'deepseek', model: null, projectId: null, batch: null, dispatchOrigin: 'USER', runSource: 'MANUAL', runAt: null,
    clearFailed: false, auto: false,
  };
  const v3 = { ...base, v: 3, engine: 'dsh', effort: null, route: null };
  assert.deepEqual(readExecuteTarget(v3), v3);
  const route = { policyVersion: 1, applied: true, level: 'M', provider: 'codex', model: 'gpt', effort: 'medium', baseline: {}, features: {}, reasons: [] };
  const v2 = readExecuteTarget({ ...base, v: 2, effort: 'high', route });
  assert.deepEqual([v2?.v, v2?.engine, v2?.fromVersion, v2?.route?.engine, v2?.route?.provider], [3, null, 2, null, 'codex']);
  const v1 = readExecuteTarget({ ...base, v: 1 });
  assert.deepEqual([v1?.engine, v1?.effort, v1?.route, v1?.fromVersion], [null, null, null, 1]);
  assert.equal(readExecuteTarget({ ...base, v: 4 }), null);
  const plan = readBatchPlan({ kind: 'BATCH', v: 2, batchId: null, maxConcurrent: null, skipped: [], runnerIds: [], items: [{ ...base, route: null, effort: null }] });
  assert.deepEqual([plan?.v, plan?.fromVersion, plan?.items[0].engine], [3, 2, null]);
  assert.equal(readBatchPlan({ kind: 'BATCH', v: 4, items: [] }), null);
  // An older replica's receipt for the task's own provider pin runs on its engine pin; anything else on the
  // provider's default (null: resolved at create).
  assert.equal(taskRunEngine({ engine: null, provider: 'deepseek' }, { engine: 'dsh', provider: 'deepseek' }), 'dsh');
  assert.equal(taskRunEngine({ engine: null, provider: 'other' }, { engine: 'dsh', provider: 'deepseek' }), null);
  assert.equal(taskRunEngine({ engine: 'claude', provider: 'deepseek' }, { engine: 'dsh', provider: 'deepseek' }), 'claude');
});

/** A routed run on Claude at tier M whose own engine is ruled out, with Codex allowed and reported. */
function routedAway(baseline: ModelRoutingInput['baseline']): ModelRoutingInput {
  return {
    task: { modelHint: 'M' },
    baseline,
    history: [],
    environment: {
      runtime: 'claude',
      modelCatalog: {
        claude: [{ value: 'claude-sonnet-5-5', label: 'Sonnet', priority: 0 }],
        codex: [{ value: 'gpt-default', label: 'GPT', priority: 0 }],
      },
      runtimeDefaultModels: { codex: 'gpt-default' },
    },
    engines: { allowed: ['codex'], states: { claude: { signedOut: true }, codex: {} }, verifiedRunEngine: 'claude' },
  };
}

test('T3 routing: a run moved to another engine keeps a key that engine can run, and otherwise takes its sign-in', () => {
  // A credential the routed engine runs keeps going (§4.4): the key is not swapped for the runner's login.
  const kept = routeTaskRun(routedAway({ engine: 'claude', engines: ['claude', 'codex'], provider: 'gateway-key', model: null, effort: null }));
  assert.deepEqual([kept.engine, kept.provider], ['codex', 'gateway-key']);
  // One it cannot run gives way to that engine's own sign-in, named by the engine.
  const login = routeTaskRun(routedAway({ engine: 'claude', engines: ['claude', 'opencode'], provider: 'anthropic-2', model: null, effort: null }));
  assert.deepEqual([login.engine, login.provider], ['codex', 'codex']);
  // Staying on its own engine, it stays on its own key.
  const stays = routeTaskRun({ ...routedAway({ engine: 'claude', provider: 'anthropic-2', model: null, effort: null }), engines: { allowed: [] } });
  assert.deepEqual([stays.engine, stays.provider, stays.level], ['claude', 'anthropic-2', 'M']);
});

test("T3 routing: a run on a key is never moved off its engine by the runner's report on its sign-in", () => {
  const value = routedAway({ engine: 'claude', engines: ['claude', 'opencode'], provider: 'anthropic-2', model: null, effort: null });
  value.engines!.verifiedRunEngine = null;
  const decision = routeTaskRun(value);
  assert.deepEqual([decision.engine, decision.provider], ['claude', 'anthropic-2']);
  assert.ok(decision.reasons.includes("Engine claude: this agent's own engine"));
  // The same report rules out a run on that sign-in itself.
  const onLogin = routeTaskRun({ ...value, baseline: { ...value.baseline, provider: 'claude', engines: ['claude'] } });
  assert.deepEqual([onLogin.engine, onLogin.provider], ['codex', 'codex']);
});

test('T3 quota gate: a run on a key is neither held by the runner report nor blind for want of one', async () => {
  const spent = { codex: { primary: { utilization: 100, resetsAt: new Date(Date.now() + 3_600_000).toISOString(), windowDurationMins: 300 } } };
  const prisma = {
    runner: { findMany: async () => [{ id: 'runner-1', planUsage: spent, engines: null }] },
    workspace: { findMany: async () => [{ id: 'workspace-1', env: null, codexAccount: null, claudeAccount: null }] },
    modelProvider: { findFirst: async ({ where }: { where: { slug: string } }) => (where.slug === 'openai-key' ? { id: 'k' } : null) },
  };
  const service = new TasksService(prisma as never, {} as never, {} as never);
  const gate = (service as unknown as {
    quotaGate(tasks: unknown[]): Promise<{ blocked: Map<string, Date>; blind: Set<string> }>;
  }).quotaGate.bind(service);
  const { blocked, blind } = await gate([
    { id: 'on-key', ownerId: OWNER, assignee: { provider: 'openai-key', login: false, runnerId: 'runner-1', workspaceId: 'workspace-1' } },
    { id: 'on-login', ownerId: OWNER, assignee: { provider: 'codex', login: true, runnerId: 'runner-1', workspaceId: 'workspace-1' } },
  ]);
  assert.equal(blocked.has('on-key'), false, 'a key is not held by the runner Codex quota');
  assert.equal(blind.has('on-key'), false, 'nor counted blind');
  assert.equal(blocked.has('on-login'), true, 'the runner sign-in at its limit still is');
});

test('T3 providers: /providers, /providers/mine and /runner/providers carry the engines each key runs on', async () => {
  const rows = [deepSeek('deepseek'), subscription(), gemini()];
  const prisma = {
    user: { findUnique: async () => ({ role: 'USER' }) },
    modelProvider: { findMany: async () => rows },
    providerPool: { findMany: async () => [{ slug: 'team-codex', label: 'Team', shared: true, engine: 'codex' }] },
  };
  const service = new ProvidersService(prisma as never, {} as never, { snapshot: () => null } as never);
  const listed = await service.listPublic(OWNER);
  assert.deepEqual(listed.map((row) => [row.slug, row.engines, row.runsOnOpenCode, row.runtime]), [
    ['deepseek', ['claude', 'opencode', 'dsh'], true, 'claude'],
    ['claude-sub', ['claude'], false, 'claude'],
    ['gemini', ['antigravity', 'opencode'], true, 'antigravity'],
  ]);
  const mine = await service.listMine(OWNER);
  assert.deepEqual(mine.map((row) => row.engines), [['claude', 'opencode', 'dsh'], ['claude'], ['antigravity', 'opencode']]);
  assert.ok(mine.every((row) => !('apiKeyEnc' in row)));
  const usable = await service.listUsable(OWNER);
  assert.deepEqual(usable.find((row) => row.slug === 'dsh')?.engines, ['dsh']);
  assert.deepEqual(usable.find((row) => row.slug === 'deepseek')?.engines, ['claude', 'opencode', 'dsh']);
  assert.deepEqual(usable.find((row) => row.slug === 'team-codex')?.engines, ['codex']);
  assert.ok(usable.every((row) => !('apiKeyEnc' in row) && !('baseUrl' in row)));
});

test('T3 providers: a DeepSeek key is connection-tested on Anthropic Messages whatever engine it runs on', async () => {
  const seen: Array<{ url: string; body: Record<string, unknown> }> = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: { body: string }) => {
    seen.push({ url: String(url), body: JSON.parse(init.body) });
    return new Response('{}', { status: 200 });
  }) as unknown as typeof fetch;
  try {
    const service = new ProvidersService({} as never, {} as never, {} as never);
    for (const runtime of ['dsh', 'claude', undefined]) {
      const verdict = await service.testConnection({
        runtime, baseUrl: 'https://api.deepseek.com/anthropic', apiKey: 'sk-deepseek', model: 'deepseek-v4-pro',
      });
      assert.deepEqual(verdict, { ok: true, status: 200, message: 'Connected' });
    }
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.deepEqual(seen.map((probe) => probe.url), Array(3).fill('https://api.deepseek.com/anthropic/v1/messages'));
  assert.ok(seen.every((probe) => probe.body.model === 'deepseek-v4-pro'));
});

test('T3 providers: an older client connecting DeepSeek Harness gets a DeepSeek key, named for the vendor', async () => {
  const rows: Array<Record<string, unknown>> = [{ id: 'existing', ownerId: OWNER, slug: 'deepseek', label: 'DeepSeek', presetSlug: 'deepseek' }];
  const prisma = {
    modelProvider: {
      findMany: async ({ where }: { where: Record<string, unknown> }) =>
        where.presetSlug ? rows.filter((row) => row.presetSlug === where.presetSlug) : rows.map((row) => ({ slug: row.slug })),
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `new-${rows.length}`, position: null, createdAt: new Date(), updatedAt: new Date(), ...data };
        rows.push(row);
        return row;
      },
    },
    providerPool: { findMany: async () => [] },
    providerSlugAlias: { findMany: async () => [] },
  };
  const service = new ProvidersService(prisma as never, { publishForUser() {} } as never, {} as never);
  for (const legacy of [{ presetSlug: 'deepseek-harness' }, { runtime: 'dsh' }]) {
    const created = await service.create(OWNER, {
      label: 'DeepSeek Harness', baseUrl: 'https://api.deepseek.com/anthropic', apiKey: 'sk-ds',
      models: [{ value: 'guess', label: 'Guess' }], ...legacy,
    } as never);
    assert.equal(created.presetSlug, 'deepseek');
    assert.equal(created.runtime, 'claude');
    assert.ok((created.models as Array<{ value: string }>).every((model) => model.value !== 'guess'));
    assert.deepEqual(created.engines, ['claude', 'opencode', 'dsh']);
  }
  // The vendor's name, numbered past the DeepSeek keys already there: `DeepSeek 2`, then `DeepSeek 3`.
  assert.deepEqual(rows.slice(1).map((row) => [row.label, row.slug]), [['DeepSeek 2', 'deepseek-2'], ['DeepSeek 3', 'deepseek-3']]);
});
