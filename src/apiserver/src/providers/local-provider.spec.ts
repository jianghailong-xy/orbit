/**
 * Runner-scoped providers (a local Ollama) without a database: the rules a create and an edit are held to
 * (createScope, updateScope), what a provider read carries for them (providerScopeFields), and dispatch —
 * which runs such a row on its own runner with an in-memory placeholder token, and refuses it everywhere else
 * rather than falling back to a cloud engine's sign-in. The same rules against PostgreSQL, through the real
 * service, are in local-provider.pg.spec.ts.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AgentProvider, LOCAL_AUTH_PLACEHOLDER, LOCAL_PROVIDER_RUN_CAPABILITY, OLLAMA_PROBE_CAPABILITY, providerPreset } from '@orbit/shared';
import { assertRunnerScope, resolveProviderExec } from './custom-provider';
import { createScope, providerScopeFields, updateScope } from './local-provider';
import { encryptSecret } from './provider-crypto';

const OWNER = '00000000-0000-7000-8000-00000000a001';
const OTHER = '00000000-0000-7000-8000-00000000b001';
const MY_RUNNER = '00000000-0000-7000-8000-00000000a0a1';
const MY_OTHER_RUNNER = '00000000-0000-7000-8000-00000000a0a2';
const THEIR_RUNNER = '00000000-0000-7000-8000-00000000b0b1';
const RUNNERS: Record<string, string> = { [MY_RUNNER]: OWNER, [MY_OTHER_RUNNER]: OWNER, [THEIR_RUNNER]: OTHER };

/** The one query the rules make: is this runner the caller's? */
const db = {
  runner: {
    findFirst: async ({ where }: { where: { id: string; ownerId: string } }) =>
      RUNNERS[where.id] === where.ownerId ? { id: where.id } : null,
  },
} as never;

const ollama = providerPreset('ollama')!;
const deepseek = providerPreset('deepseek')!;

/** The refusal's code, or the class of a 404. */
async function refusal(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (e) {
    if (e instanceof NotFoundException) return `404:${(e.getResponse() as { code?: string }).code}`;
    if (e instanceof BadRequestException) return (e.getResponse() as { code: string }).code;
    throw e;
  }
  return 'accepted';
}

test('createScope', async (t) => {
  await t.test('a local Ollama on the caller\'s own runner needs no key, and defaults to runner scope with none', async () => {
    assert.deepEqual(await createScope(db, OWNER, { runnerId: MY_RUNNER }, ollama), {
      scope: 'runner',
      authMode: 'none',
      runnerId: MY_RUNNER,
    });
    // An empty key field from a form is no key.
    assert.equal((await createScope(db, OWNER, { runnerId: MY_RUNNER, apiKey: '' }, ollama)).authMode, 'none');
  });

  await t.test('it must be bound to a runner the caller owns: none, another owner\'s, or an unknown one is refused alike', async () => {
    assert.equal(await refusal(() => createScope(db, OWNER, {}, ollama)), 'PROVIDER_RUNNER_REQUIRED');
    assert.equal(await refusal(() => createScope(db, OWNER, { runnerId: THEIR_RUNNER }, ollama)), '404:RUNNER_NOT_FOUND');
    assert.equal(
      await refusal(() => createScope(db, OWNER, { runnerId: '00000000-0000-7000-8000-0000000000ff' }, ollama)),
      '404:RUNNER_NOT_FOUND',
    );
  });

  await t.test('every other provider still refuses a missing or empty key, and names no runner', async () => {
    assert.equal(await refusal(() => createScope(db, OWNER, {}, deepseek)), 'PROVIDER_API_KEY_REQUIRED');
    assert.equal(await refusal(() => createScope(db, OWNER, { apiKey: '' }, deepseek)), 'PROVIDER_API_KEY_REQUIRED');
    assert.equal(await refusal(() => createScope(db, OWNER, { apiKey: '' }, undefined)), 'PROVIDER_API_KEY_REQUIRED');
    assert.equal(await refusal(() => createScope(db, null, {}, undefined)), 'PROVIDER_API_KEY_REQUIRED');
    assert.equal(
      await refusal(() => createScope(db, OWNER, { apiKey: 'sk-x', runnerId: MY_RUNNER }, deepseek)),
      'PROVIDER_RUNNER_NOT_SCOPED',
    );
    assert.deepEqual(await createScope(db, OWNER, { apiKey: 'sk-x' }, deepseek), {
      scope: 'account',
      authMode: 'bearer',
      runnerId: null,
    });
  });

  await t.test('no key is not a way around a key: authMode none exists for a runner-scoped local server only', async () => {
    assert.equal(await refusal(() => createScope(db, OWNER, { authMode: 'none' }, deepseek)), 'PROVIDER_SCOPE_AUTH_MISMATCH');
    assert.equal(await refusal(() => createScope(db, OWNER, { authMode: 'none' }, undefined)), 'PROVIDER_SCOPE_AUTH_MISMATCH');
    assert.equal(
      await refusal(() => createScope(db, OWNER, { scope: 'runner', runnerId: MY_RUNNER }, deepseek)),
      'PROVIDER_RUNNER_PRESET',
    );
    assert.equal(
      await refusal(() => createScope(db, OWNER, { scope: 'runner', runnerId: MY_RUNNER }, undefined)),
      'PROVIDER_RUNNER_PRESET',
    );
    assert.equal(
      await refusal(() => createScope(db, OWNER, { runnerId: MY_RUNNER, authMode: 'bearer' }, ollama)),
      'PROVIDER_SCOPE_AUTH_MISMATCH',
    );
    assert.equal(await refusal(() => createScope(db, OWNER, { scope: 'account', apiKey: 'k' }, ollama)), 'PROVIDER_RUNNER_REQUIRED');
  });

  await t.test('a local Ollama is personal, on Claude Code, keyless, and serves no cloud model', async () => {
    assert.equal(await refusal(() => createScope(db, null, { runnerId: MY_RUNNER }, ollama)), 'PROVIDER_RUNNER_SHARED');
    assert.equal(
      await refusal(() => createScope(db, OWNER, { runnerId: MY_RUNNER, runtime: 'codex' }, ollama)),
      'PROVIDER_RUNNER_RUNTIME',
    );
    assert.equal(
      await refusal(() => createScope(db, OWNER, { runnerId: MY_RUNNER, apiKey: 'sk-something' }, ollama)),
      'PROVIDER_API_KEY_UNUSED',
    );
    assert.equal(
      await refusal(() => createScope(db, OWNER, { runnerId: MY_RUNNER, models: [{ value: 'gpt-oss:20b-cloud', label: 'x' }] }, ollama)),
      'PROVIDER_CLOUD_MODEL',
    );
    assert.equal(
      await refusal(() => createScope(db, OWNER, { runnerId: MY_RUNNER, defaultModel: 'glm-4.6:cloud' }, ollama)),
      'PROVIDER_CLOUD_MODEL',
    );
  });
});

test('updateScope', async (t) => {
  const local = { ownerId: OWNER, scope: 'runner', authMode: 'none', runnerId: MY_RUNNER, baseUrl: 'http://127.0.0.1:11434', label: 'Ollama' };
  const account = { ownerId: OWNER, scope: 'account', authMode: 'bearer', runnerId: null, baseUrl: 'https://api.deepseek.com/anthropic', label: 'DeepSeek' };

  await t.test('rebinds only to another runner of the owner\'s, and forgets what the old one probed', async () => {
    const data = await updateScope(db, local, { runnerId: MY_OTHER_RUNNER });
    assert.deepEqual(data.runner, { connect: { id: MY_OTHER_RUNNER } });
    assert.equal(data.probeState, null);
    assert.equal(data.probedAt, null);
    assert.equal(await refusal(() => updateScope(db, local, { runnerId: THEIR_RUNNER })), '404:RUNNER_NOT_FOUND');
    // A new endpoint on the same runner is unprobed too; an unchanged one keeps its probe.
    assert.equal((await updateScope(db, local, { baseUrl: 'http://127.0.0.1:11435' })).probeState, null);
    assert.deepEqual(await updateScope(db, local, { baseUrl: local.baseUrl }), {});
  });

  await t.test('takes no key, stays on Claude Code, follows no catalogue, names no cloud model', async () => {
    assert.equal(await refusal(() => updateScope(db, local, { apiKey: 'sk-new' })), 'PROVIDER_API_KEY_UNUSED');
    assert.equal(await refusal(() => updateScope(db, local, { runtime: 'codex' })), 'PROVIDER_RUNNER_RUNTIME');
    assert.equal(await refusal(() => updateScope(db, local, { followsPreset: true })), 'PROVIDER_RUNNER_CATALOGUE');
    assert.equal(await refusal(() => updateScope(db, local, { defaultModel: 'x:cloud' })), 'PROVIDER_CLOUD_MODEL');
  });

  await t.test('an account-scoped provider is edited exactly as before, and is never bound to a runner', async () => {
    assert.deepEqual(await updateScope(db, account, { apiKey: 'sk-rotated', runtime: 'codex', followsPreset: true }), {});
    assert.equal(await refusal(() => updateScope(db, account, { runnerId: MY_RUNNER })), 'PROVIDER_RUNNER_NOT_SCOPED');
  });
});

test('providerScopeFields', async (t) => {
  const base = {
    ownerId: OWNER,
    scope: 'runner',
    authMode: 'none',
    runnerId: MY_RUNNER,
    enabled: true,
    probeState: 'READY',
    probedAt: new Date(), // a fresh probe: an old one reads STALE
    probeVersion: '0.40.16',
    instanceModels: [{ value: 'qwen3.8:27b' }],
  };
  const probing = { id: MY_RUNNER, ownerId: OWNER, capabilities: [OLLAMA_PROBE_CAPABILITY], capabilitiesReportedAt: new Date() };

  await t.test('an account-scoped row reads as it always did, plus scope and auth mode', () => {
    assert.deepEqual(
      providerScopeFields({ ...base, scope: 'account', authMode: 'bearer', runnerId: null, runner: null }),
      { scope: 'account', authMode: 'bearer', runnerId: null },
    );
  });

  await t.test('names the runner only while it is the owner\'s own', () => {
    const own = providerScopeFields({ ...base, runner: probing });
    assert.equal(own.runnerId, MY_RUNNER);
    assert.equal(own.local?.state, 'READY');
    const moved = providerScopeFields({ ...base, runner: { ...probing, ownerId: OTHER } });
    assert.equal(moved.runnerId, null);
    assert.equal(moved.local?.state, 'NO_RUNNER');
    // Removed runner: runner_id was SET NULL.
    assert.equal(providerScopeFields({ ...base, runnerId: null, runner: null }).local?.state, 'NO_RUNNER');
  });

  await t.test('an old runner that cannot probe is capability UNKNOWN, and so is the state', () => {
    const old = providerScopeFields({ ...base, runner: { ...probing, capabilities: [], capabilitiesReportedAt: null } });
    assert.equal(old.local?.capability, 'UNKNOWN');
    assert.equal(old.local?.state, 'UNKNOWN');
  });

  await t.test('carries no endpoint, no key and no probe wording', () => {
    const text = JSON.stringify(providerScopeFields({ ...base, runner: probing }));
    assert.ok(!text.includes('127.0.0.1') && !text.includes('11434') && !text.includes('apiKey'));
  });
});

test('dispatch of a runner-scoped row', async (t) => {
  process.env.PROVIDER_SECRET_KEY = 'test-master-key';
  const local = {
    slug: 'ollama',
    runtime: 'claude',
    baseUrl: 'http://127.0.0.1:11434',
    apiKeyEnc: '',
    presetSlug: 'ollama',
    followsPreset: false,
    defaultModel: 'qwen3.8:27b',
    models: [{ value: 'qwen3.8:27b', label: 'Qwen', contextWindow: 65536 }],
    enabled: true,
    scope: 'runner',
    authMode: 'none',
    runnerId: MY_RUNNER,
    // What the runner's probe last found (phase 2): answering, a moment ago, the model there with tools.
    probeState: 'READY',
    probedAt: new Date(),
    instanceModels: [{ value: 'qwen3.8:27b', contextWindow: 262144, tools: true }],
  };
  const probing = { engines: null, defaultRemoved: null, accountPauses: null, planUsage: null,
    capabilities: [OLLAMA_PROBE_CAPABILITY, LOCAL_PROVIDER_RUN_CAPABILITY], capabilitiesReportedAt: new Date() };
  const resolve = (customRow: typeof local | null, runnerId: string | null | undefined, engine = AgentProvider.CLAUDE) =>
    resolveProviderExec({ engine, declaredProvider: 'ollama', declaredProviderBuiltin: false, customRow, sessionModel: null, runnerId, runner: probing });
  const code = (run: () => unknown) => {
    try {
      run();
    } catch (e) {
      const body = (e as BadRequestException).getResponse() as string | { code?: string; message?: string };
      return typeof body === 'string' ? body : (body.code ?? body.message);
    }
    return 'dispatched';
  };

  await t.test('on its own runner: Claude Code at the Ollama root, with an in-memory placeholder token', () => {
    const exec = resolve(local, MY_RUNNER);
    assert.equal(exec.provider, AgentProvider.CLAUDE);
    assert.equal(exec.model, 'qwen3.8:27b');
    assert.equal(exec.env?.ANTHROPIC_BASE_URL, 'http://127.0.0.1:11434');
    assert.equal(exec.env?.ANTHROPIC_AUTH_TOKEN, LOCAL_AUTH_PLACEHOLDER);
    assert.equal(exec.env?.CLAUDE_CODE_MAX_CONTEXT_TOKENS, String(65536 - 65536 / 8));
  });

  await t.test('fails closed everywhere else: another runner, no runner given, a removed runner', () => {
    assert.equal(code(() => resolve(local, MY_OTHER_RUNNER)), 'LOCAL_PROVIDER_ELSEWHERE');
    assert.equal(code(() => resolve(local, undefined)), 'LOCAL_PROVIDER_ELSEWHERE');
    assert.equal(code(() => resolve(local, null)), 'LOCAL_PROVIDER_ELSEWHERE');
    assert.equal(code(() => resolve({ ...local, runnerId: null as never }, MY_RUNNER)), 'LOCAL_PROVIDER_NO_RUNNER');
    // The refusal names the provider, never where it is.
    try {
      resolve(local, MY_OTHER_RUNNER);
    } catch (e) {
      assert.ok(!JSON.stringify((e as BadRequestException).getResponse()).includes('127.0.0.1'));
    }
  });

  await t.test('fails closed when disabled or gone — never onto the runner\'s own Claude sign-in', () => {
    assert.equal(code(() => resolve({ ...local, enabled: false }, MY_RUNNER)), 'provider is disabled');
    assert.equal(code(() => resolve(null, MY_RUNNER)), 'provider not available: "ollama"');
  });

  await t.test('runs on Claude Code alone: not OpenCode, DeepSeek Harness or Codex', () => {
    for (const engine of [AgentProvider.OPENCODE, AgentProvider.DSH, AgentProvider.CODEX]) {
      assert.equal(code(() => resolve(local, MY_RUNNER, engine)), 'PROVIDER_ENGINE_INCOMPATIBLE');
    }
  });

  await t.test('an account-scoped key dispatches exactly as before, on any runner, with its own key', () => {
    const keyed = { ...local, scope: 'account', authMode: 'bearer', runnerId: null as never, apiKeyEnc: encryptSecret('sk-real'), presetSlug: null as never };
    for (const runnerId of [MY_RUNNER, MY_OTHER_RUNNER, undefined]) {
      assert.equal(resolve(keyed, runnerId).env?.ANTHROPIC_AUTH_TOKEN, 'sk-real');
    }
    // assertRunnerScope ignores a row that never heard of scope (an older row shape, a minted pool row).
    assert.doesNotThrow(() => assertRunnerScope({ slug: 'x' }, undefined));
  });
});
