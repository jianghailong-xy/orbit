/**
 * Claude Code on an OpenAI key, as dispatch builds it (docs/claude-engine-openai-gateway-design.md §4.2): with the
 * deployment flag on, the session's environment carries the gateway's URL and an `orbit-gwk-` token minted for
 * the build, and nothing of the key; with it off, nothing differs from before the gateway.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { AgentProvider } from '@orbit/shared';
import { sha256 } from '../common/crypto.util';
import { resolveProviderExec, type ModelProviderRow } from './custom-provider';
import {
  ANTHROPIC_GATEWAY_FLAG,
  KEY_GATEWAY_TOKEN_PREFIX,
  gatewaySmallModel,
  withKeyGatewayToken,
} from './key-gateway';
import { encryptSecret } from './provider-crypto';

const SECRET = 'sk-proj-key-gateway-spec-0123456789abcdefghij';

process.env.PROVIDER_SECRET_KEY = 'key-gateway-spec';
process.env.PUBLIC_ORIGIN = 'https://orbit.key-gateway.invalid/';

/** An OpenAI key as the Infrastructure page saves one from the `openai` preset. */
const openaiKey = (): ModelProviderRow & { id: string } => ({
  id: '0190f3c2-0000-7000-8000-000000000001',
  slug: 'openai',
  runtime: 'codex',
  baseUrl: 'https://api.openai.com/v1',
  apiKeyEnc: encryptSecret(SECRET),
  defaultModel: null,
  presetSlug: 'openai',
  followsPreset: true,
  enabled: true,
});

/** A stand-in for the token table: what was written, and nothing else. */
function fakeDb() {
  const created: Array<Record<string, unknown>> = [];
  const calls: string[] = [];
  const db = {
    keyGatewayToken: {
      deleteMany: async () => { calls.push('deleteMany'); return { count: 0 }; },
      updateMany: async () => { calls.push('updateMany'); return { count: 0 }; },
      create: async ({ data }: { data: Record<string, unknown> }) => { calls.push('create'); created.push(data); return data; },
    },
  };
  return { db: db as never, created, calls };
}

const SESSION = { id: '0190f3c2-0000-7000-8000-0000000000aa', ownerId: '0190f3c2-0000-7000-8000-0000000000bb' };

function withFlag<T>(value: string | undefined, run: () => Promise<T>): Promise<T> {
  const before = process.env[ANTHROPIC_GATEWAY_FLAG];
  if (value === undefined) delete process.env[ANTHROPIC_GATEWAY_FLAG];
  else process.env[ANTHROPIC_GATEWAY_FLAG] = value;
  return run().finally(() => {
    if (before === undefined) delete process.env[ANTHROPIC_GATEWAY_FLAG];
    else process.env[ANTHROPIC_GATEWAY_FLAG] = before;
  });
}

/** Whether any value of `env` carries the key or any part of its ciphertext, or the key's own endpoint. */
function keyMaterialIn(env: Record<string, string>, row: ModelProviderRow): string[] {
  return Object.entries(env)
    .filter(([, value]) => value.includes(SECRET) || value.includes(SECRET.slice(-12)) || value.includes(row.apiKeyEnc) || value.includes('api.openai.com'))
    .map(([name]) => name);
}

test('dispatch environment: a claude session on an OpenAI key carries the gateway and an orbit-gwk- token, and no key material', async () => {
  await withFlag('true', async () => {
    const { db, created, calls } = fakeDb();
    const row = await withKeyGatewayToken(db, SESSION, AgentProvider.CLAUDE, openaiKey());
    assert.ok(row?.sessionToken?.startsWith(KEY_GATEWAY_TOKEN_PREFIX), 'a token is minted for the build');
    assert.deepEqual(calls, ['deleteMany', 'updateMany', 'create']);
    // Only the hash is written, bound to the session, the key and the person.
    assert.equal(created.length, 1);
    assert.equal(created[0].tokenHash, sha256(row!.sessionToken!));
    assert.equal(created[0].sessionId, SESSION.id);
    assert.equal(created[0].providerId, openaiKey().id);
    assert.equal(created[0].userId, SESSION.ownerId);
    assert.ok(!Object.values(created[0]).includes(row!.sessionToken), 'the token itself is not stored');

    const exec = resolveProviderExec({ engine: AgentProvider.CLAUDE, customRow: row, declaredProvider: 'openai', declaredProviderBuiltin: false, sessionModel: 'gpt-5.1' });
    const env = exec.env!;
    assert.equal(exec.provider, AgentProvider.CLAUDE);
    assert.equal(exec.model, 'gpt-5.1');
    assert.equal(env.ANTHROPIC_BASE_URL, 'https://orbit.key-gateway.invalid/api/gw/anthropic');
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, row!.sessionToken);
    assert.ok(env.ANTHROPIC_AUTH_TOKEN.startsWith('orbit-gwk-'));
    assert.equal(env.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'gpt-5.1-mini');
    assert.equal(env.ANTHROPIC_MODEL, 'gpt-5.1');
    assert.equal(env.CLAUDE_CODE_INLINE_TOOLS, 'false');
    assert.equal(env.CLAUDE_CODE_DISABLE_EXPLORE_INHERIT_CAP, '1');
    // 400k declared by the preset, an eighth held back for the CLI's own compaction request.
    assert.equal(env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, '350000');
    assert.equal(env.OPENAI_API_KEY, undefined);
    assert.equal(env.ANTHROPIC_API_KEY, undefined);
    assert.deepEqual(keyMaterialIn(env, openaiKey()), [], 'no variable carries the key or its endpoint');
  });
});

test('dispatch environment: a build that minted no token gets no credential, never the key', async () => {
  await withFlag('true', async () => {
    const exec = resolveProviderExec({ engine: AgentProvider.CLAUDE, customRow: openaiKey(), declaredProvider: 'openai', declaredProviderBuiltin: false, sessionModel: 'gpt-5.1' });
    assert.equal(exec.env!.ANTHROPIC_AUTH_TOKEN, '');
    assert.deepEqual(keyMaterialIn(exec.env!, openaiKey()), []);
    // A pool's token on the same row shape is not ours, and is not handed over either.
    const pooled = resolveProviderExec({ engine: AgentProvider.CLAUDE, customRow: { ...openaiKey(), sessionToken: 'orbit-gw-pool' }, declaredProvider: 'openai', declaredProviderBuiltin: false, sessionModel: 'gpt-5.1' });
    assert.equal(pooled.env!.ANTHROPIC_AUTH_TOKEN, '');
  });
});

test('dispatch environment: other engines on the same key, and Claude keys, are untouched with the flag on', async () => {
  await withFlag('true', async () => {
    const { db, calls } = fakeDb();
    // Codex on the OpenAI key: no token minted, the key as it always was.
    const codexRow = await withKeyGatewayToken(db, SESSION, AgentProvider.CODEX, openaiKey());
    assert.equal(codexRow?.sessionToken, undefined);
    const codex = resolveProviderExec({ engine: AgentProvider.CODEX, customRow: codexRow, declaredProvider: 'openai', declaredProviderBuiltin: false, sessionModel: 'gpt-5.1' });
    assert.deepEqual(codex.env, { OPENAI_BASE_URL: 'https://api.openai.com/v1', OPENAI_API_KEY: SECRET });
    // Claude Code on an Anthropic-dialect key: its own endpoint and key, as before.
    const deepseek = { ...openaiKey(), runtime: 'claude', baseUrl: 'https://api.deepseek.com/anthropic', presetSlug: 'deepseek', apiKeyEnc: encryptSecret('sk-ds') };
    const claudeRow = await withKeyGatewayToken(db, SESSION, AgentProvider.CLAUDE, deepseek);
    assert.equal(claudeRow?.sessionToken, undefined);
    const claude = resolveProviderExec({ engine: AgentProvider.CLAUDE, customRow: claudeRow, declaredProvider: 'deepseek', declaredProviderBuiltin: false, sessionModel: 'deepseek-chat' });
    assert.equal(claude.env!.ANTHROPIC_BASE_URL, 'https://api.deepseek.com/anthropic');
    assert.equal(claude.env!.ANTHROPIC_AUTH_TOKEN, 'sk-ds');
    assert.equal(claude.env!.ANTHROPIC_DEFAULT_HAIKU_MODEL, undefined);
    // A disabled key mints nothing (dispatch refuses it in its own words).
    assert.equal((await withKeyGatewayToken(db, SESSION, AgentProvider.CLAUDE, { ...openaiKey(), enabled: false }))?.sessionToken, undefined);
    assert.deepEqual(calls, []);
  });
});

test('dispatch environment: with the flag off nothing is minted and Claude Code cannot run an OpenAI key', async () => {
  for (const value of [undefined, '', 'false', 'yes']) {
    await withFlag(value, async () => {
      const { db, calls } = fakeDb();
      const row = await withKeyGatewayToken(db, SESSION, AgentProvider.CLAUDE, openaiKey());
      assert.equal(row?.sessionToken, undefined);
      assert.deepEqual(calls, []);
      assert.throws(
        () => resolveProviderExec({ engine: AgentProvider.CLAUDE, customRow: row, declaredProvider: 'openai', declaredProviderBuiltin: false, sessionModel: 'gpt-5.1' }),
        (error: { getResponse?: () => { code?: string; engines?: string[] } }) =>
          error.getResponse?.().code === 'PROVIDER_ENGINE_INCOMPATIBLE'
          && JSON.stringify(error.getResponse?.().engines) === JSON.stringify(['codex', 'opencode']),
      );
    });
  }
});

test('the small model is the key’s mini model: the preset’s, or the row’s own list', () => {
  assert.equal(gatewaySmallModel({ presetSlug: 'openai', followsPreset: true }), 'gpt-5.1-mini');
  assert.equal(gatewaySmallModel({ presetSlug: 'openai', followsPreset: false, models: [{ value: 'gpt-5.5' }, { value: 'gpt-5.5-mini' }] }), 'gpt-5.5-mini');
  assert.equal(gatewaySmallModel({ presetSlug: null, models: [{ value: 'gpt-5.5' }] }), undefined);
  // `gemini` is no mini.
  assert.equal(gatewaySmallModel({ presetSlug: null, models: [{ value: 'gemini-x' }] }), undefined);
});
