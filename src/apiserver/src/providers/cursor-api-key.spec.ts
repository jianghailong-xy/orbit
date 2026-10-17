/**
 * A Cursor API key saved in Orbit (project P2; docs/cursor-runtime-contract.md §9, §16.2, §16.3;
 * docs/provider-engine-contract.md §2.1, §4.2): a key on Cursor's own dialect (`runtime` `cursor`),
 * which Cursor CLI alone runs on — handed to the runner as ORBIT_CURSOR_API_KEY, and spent by nothing on
 * this side. scripts/test-cursor-api-key.mjs runs every case below by name; the doors, the claim and
 * the key's check run on PostgreSQL in cursor-api-key.pg.spec.ts.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ALL_ENGINES, AgentProvider, credentialEngines, ENGINE_CLI_NAMES, type RunnerModelCatalog } from '@orbit/shared';
import { validate } from 'class-validator';
import {
  CURSOR_KEY_VAR,
  keyCredential,
  keyRowEngine,
  resolveProviderExec,
  runsOnOpenCode,
  type ModelProviderRow,
} from './custom-provider';
import { CreateModelProviderDto, CursorKeyCheckDto, TestModelProviderDto, UpdateModelProviderDto } from './dto';
import { resolvedCredentialEngines } from './engine-provider';
import { heldKeyOf, sessionHeldKey } from './held-key';
import { subscriptionUsageRefusal } from './plan-usage';
import { poolMemberRefusal } from './pool-admission';
import { followsRuntimeCatalog, presetDefaultModel, withPreset } from './preset-overlay';
import { encryptSecret } from './provider-crypto';
import { ProvidersService } from './providers.service';

process.env.PROVIDER_SECRET_KEY = 'cursor-api-key-spec';

const KEY = 'key_p2-unit-7d1e4b0c93a2465f8e1b2c3d4e5f6a7b';

/** A Cursor key as connecting the Cursor preset stores it. */
function cursorKey(overrides: Partial<ModelProviderRow> = {}): ModelProviderRow & { slug: string } {
  return {
    slug: 'cursor-api',
    runtime: 'cursor',
    baseUrl: 'https://api2.cursor.sh',
    apiKeyEnc: encryptSecret(KEY),
    defaultModel: '',
    presetSlug: 'cursor-api',
    followsPreset: true,
    enabled: true,
    models: [],
    ...overrides,
  };
}

/** What Cursor CLI's ACP catalogue on a runner reports (cursor_models.go): opaque variant values. */
const CATALOG = {
  cursor: [
    { value: 'default[]', label: 'Auto' },
    { value: 'gpt-5.5[context=272k,reasoning=medium,fast=false]', label: 'GPT-5.5' },
  ],
} as unknown as RunnerModelCatalog;

/** The status a refusal answers with, and its body. */
function refusal(run: () => unknown): { status: number; body: Record<string, unknown> } {
  try {
    run();
  } catch (error) {
    const e = error as { getStatus(): number; getResponse(): Record<string, unknown> };
    return { status: e.getStatus(), body: e.getResponse() };
  }
  return assert.fail('accepted what it should have refused');
}

test('P2 a Cursor key is its own dialect: Cursor CLI alone runs it, on the models Cursor CLI reports', async () => {
  const row = cursorKey();
  assert.equal(keyRowEngine('cursor'), AgentProvider.CURSOR, 'a key on the cursor runtime runs on Cursor CLI by default');
  assert.deepEqual(credentialEngines(keyCredential(row)), [AgentProvider.CURSOR]);
  assert.deepEqual(resolvedCredentialEngines({ kind: 'key', row: row as never, slug: row.slug, alias: null }), [AgentProvider.CURSOR]);
  // Its models are Cursor CLI's ACP catalogue on each runner, whether the row follows the preset or not.
  for (const candidate of [row, cursorKey({ presetSlug: null, followsPreset: false, models: [{ value: 'typed', label: 'Typed' }], defaultModel: 'typed' })]) {
    assert.deepEqual(withPreset(candidate), { ...candidate, models: [], defaultModel: null, modelsFromRuntime: true });
    assert.equal(presetDefaultModel(candidate), null);
    assert.equal(followsRuntimeCatalog(candidate), true);
  }
  // Every door that takes a key's protocol accepts Cursor's; the protocols stay closed to anything else.
  for (const runtime of ['cursor', 'claude', 'codex', 'kimi', 'antigravity', 'dsh']) {
    const create = Object.assign(new CreateModelProviderDto(), { label: 'Cursor', baseUrl: 'https://api2.cursor.sh', apiKey: KEY, runtime });
    const update = Object.assign(new UpdateModelProviderDto(), { runtime });
    const probe = Object.assign(new TestModelProviderDto(), { baseUrl: 'https://api2.cursor.sh', apiKey: KEY, runtime });
    for (const dto of [create, update, probe]) assert.equal((await validate(dto)).length, 0, `${runtime} on ${dto.constructor.name}`);
  }
  for (const runtime of ['opencode', 'Cursor', 'cursor-api']) {
    assert.notEqual((await validate(Object.assign(new UpdateModelProviderDto(), { runtime }))).length, 0, runtime);
  }
  // A runner's answer names one of three states, and the key by its fingerprint alone.
  const check = (body: Record<string, unknown>) => validate(Object.assign(new CursorKeyCheckDto(), body));
  for (const state of ['VALID', 'INVALID', 'UNREACHABLE']) {
    assert.equal((await check({ state, keyFingerprint: '0123456789abcdef' })).length, 0, state);
  }
  for (const body of [
    { state: 'valid', keyFingerprint: '0123456789abcdef' },
    { state: 'UNKNOWN', keyFingerprint: '0123456789abcdef' },
    { state: 'VALID', keyFingerprint: KEY },
    { state: 'VALID', keyFingerprint: '0123456789ABCDEF' },
    { state: 'VALID' },
  ]) {
    assert.notEqual((await check(body)).length, 0, JSON.stringify(body));
  }
});

test('P2 dispatch hands a Cursor key to Cursor CLI as ORBIT_CURSOR_API_KEY, and a sign-in session no typed one', () => {
  const row = cursorKey();
  const exec = resolveProviderExec({
    engine: AgentProvider.CURSOR, declaredProvider: row.slug, declaredProviderBuiltin: false, customRow: row,
    sessionModel: 'gpt-5.5[context=272k,reasoning=medium,fast=false]', modelCatalog: CATALOG,
    // The workspace's own env goes with it; the key the dispatch hands over is the one that counts.
    workspaceEnv: { FOO: 'bar', [CURSOR_KEY_VAR]: 'key_typed-into-the-workspace' },
  });
  assert.equal(exec.provider, AgentProvider.CURSOR);
  assert.equal(exec.model, 'gpt-5.5[context=272k,reasoning=medium,fast=false]');
  assert.deepEqual(exec.env, { FOO: 'bar', [CURSOR_KEY_VAR]: KEY });
  assert.equal(CURSOR_KEY_VAR, 'ORBIT_CURSOR_API_KEY');
  assert.equal(exec.runnerModel, undefined);
  assert.equal(exec.reasoningLevels, undefined);
  // Named by nothing else: the key's own engine.
  assert.equal(resolveProviderExec({ declaredProvider: row.slug, declaredProviderBuiltin: false, customRow: row }).provider, AgentProvider.CURSOR);
  // No model of the session's own: the runner's default for Cursor CLI, else its catalogue's first, else
  // none (Auto) — never a model from the row or a models.dev list. One the catalogue dropped moves on too.
  const unpinned = (runtimeDefaultModels: unknown, modelCatalog: unknown, sessionModel: string | null = null) =>
    resolveProviderExec({ engine: AgentProvider.CURSOR, declaredProvider: row.slug, customRow: row, sessionModel, runtimeDefaultModels, modelCatalog });
  assert.equal(unpinned({ cursor: 'gpt-5.5[context=272k,reasoning=medium,fast=false]' }, CATALOG).model, 'gpt-5.5[context=272k,reasoning=medium,fast=false]');
  assert.equal(unpinned(undefined, CATALOG).model, 'default[]');
  assert.equal(unpinned(undefined, undefined).model, '');
  const retired = unpinned(undefined, CATALOG, 'claude-4-sonnet[thinking=true]');
  assert.equal(retired.retiredPin, true);
  assert.equal(retired.model, 'default[]');

  // A session on the runner's own Cursor sign-in runs on that, not on a key typed into the workspace.
  const login = resolveProviderExec({
    engine: AgentProvider.CURSOR, declaredProvider: AgentProvider.CURSOR, declaredProviderBuiltin: true, customRow: null,
    workspaceEnv: { FOO: 'bar', [CURSOR_KEY_VAR]: 'key_typed-into-the-workspace' },
  });
  assert.equal(login.provider, AgentProvider.CURSOR);
  assert.deepEqual(login.env, { FOO: 'bar' });
});

test('P2 a Cursor key on any other engine, and any other key on Cursor CLI, is refused PROVIDER_ENGINE_INCOMPATIBLE', () => {
  const row = cursorKey();
  for (const engine of ALL_ENGINES.filter((candidate) => candidate !== AgentProvider.CURSOR)) {
    assert.deepEqual(refusal(() => resolveProviderExec({ engine, declaredProvider: row.slug, customRow: row, sessionModel: 'm' })), {
      status: 400,
      body: {
        code: 'PROVIDER_ENGINE_INCOMPATIBLE',
        message: `provider "cursor-api" cannot run on ${ENGINE_CLI_NAMES[engine]}; it runs on Cursor CLI`,
        engine,
        provider: 'cursor-api',
        engines: [AgentProvider.CURSOR],
      },
    });
  }
  // No other key runs on Cursor CLI.
  const glm: ModelProviderRow = {
    slug: 'glm', runtime: 'claude', baseUrl: 'https://api.z.ai/api/anthropic', apiKeyEnc: encryptSecret('sk-glm'),
    defaultModel: 'glm-5.2', presetSlug: 'glm', followsPreset: true, enabled: true,
  };
  assert.deepEqual(refusal(() => resolveProviderExec({ engine: AgentProvider.CURSOR, declaredProvider: 'glm', customRow: glm })), {
    status: 400,
    body: {
      code: 'PROVIDER_ENGINE_INCOMPATIBLE',
      message: 'provider "glm" cannot run on Cursor CLI; it runs on Claude Code, OpenCode',
      engine: AgentProvider.CURSOR,
      provider: 'glm',
      engines: [AgentProvider.CLAUDE, AgentProvider.OPENCODE],
    },
  });
  // OpenCode cannot spend a Cursor key, named in its model the old way or not.
  assert.equal(runsOnOpenCode(row), false);
  const openCode = refusal(() => resolveProviderExec({
    engine: AgentProvider.OPENCODE, declaredProvider: AgentProvider.OPENCODE, customRow: null,
    sessionModel: 'orbit-cursor-api/default[]', openCodeKeys: [row],
  }));
  assert.equal(openCode.status, 400);
  assert.equal(openCode.body.message, 'provider not available on OpenCode: "cursor-api"');
});

test('P2 the server never spends a Cursor key itself: no held key, no quota probe, no pool, no connection test', async () => {
  const row = cursorKey();
  // Naming and recaps are never asked of a Cursor key: it is no model API.
  for (const ownProvider of [true, false]) assert.equal(heldKeyOf(row as never, 'default[]', ownProvider), null);
  const db = {
    user: { findUnique: async () => ({ role: 'USER' }) },
    modelProvider: { findFirst: async () => row },
  };
  assert.equal(await sessionHeldKey(db as never, { provider: row.slug, providerBuiltin: false, ownerId: 'o', model: 'default[]' }), null);
  // Never sent to Anthropic's usage endpoint, and never admitted into an account pool.
  assert.equal(subscriptionUsageRefusal(row, KEY), 'NOT_CLAUDE_RUNTIME');
  assert.equal(poolMemberRefusal({ ...row, ownerId: 'o' } as never), 'NOT_CLAUDE_RUNTIME');

  // A connection test of a Cursor key sends it nowhere from here: a runner of the caller's checks it with
  // `agent models` (cursor-key-check-relay.ts), and with none that can, the answer says so.
  const originalFetch = globalThis.fetch;
  const sent: string[] = [];
  globalThis.fetch = (async (input: unknown) => {
    sent.push(String(input));
    throw new Error('a request was made');
  }) as typeof fetch;
  try {
    const providers = new ProvidersService({ runner: { findMany: async () => [] } } as never, {} as never, {} as never);
    const checked = await providers.testConnection(
      { baseUrl: 'https://api2.cursor.sh', apiKey: KEY, model: 'default[]', runtime: 'cursor' },
      'o',
    );
    assert.deepEqual({ ok: checked.ok, keyCheck: (checked as { keyCheck?: string }).keyCheck }, { ok: false, keyCheck: 'NO_RUNNER' });
    assert.ok(!checked.message.includes(KEY), 'the answer repeats the key');
    assert.deepEqual(sent, []);
    // The other protocols are probed exactly as before.
    const answer = await providers.testConnection({ baseUrl: 'https://api.z.ai/api/anthropic', apiKey: 'sk-glm', model: 'glm-5.2', runtime: 'claude' });
    assert.deepEqual(answer, { ok: false, message: 'Could not reach the endpoint' });
    assert.deepEqual(sent, ['https://api.z.ai/api/anthropic/v1/messages']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
