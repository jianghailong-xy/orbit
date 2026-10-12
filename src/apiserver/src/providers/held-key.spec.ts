import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { AgentProvider } from '@orbit/shared';
import { encryptSecret } from './provider-crypto';
import { isInternalHost, sessionHeldKey } from './held-key';

process.env.PROVIDER_SECRET_KEY = 'test-master-key';

interface Row {
  slug: string;
  runtime: string;
  baseUrl: string;
  apiKeyEnc: string;
  defaultModel: string | null;
  presetSlug: string | null;
  followsPreset: boolean;
  models: unknown;
  enabled: boolean;
  ownerId: string | null;
}

const OWNER = 'owner-1';

const row = (slug: string, runtime: string, baseUrl: string, secret: string, over: Partial<Row> = {}): Row => ({
  slug,
  runtime,
  baseUrl,
  apiKeyEnc: encryptSecret(secret),
  defaultModel: null,
  presetSlug: null,
  followsPreset: false,
  models: [],
  enabled: true,
  ownerId: OWNER,
  ...over,
});

/** A db that answers the scoped lookup the way Prisma would for these rows, and counts its reads. */
function fakeDb(rows: Row[]) {
  const reads: unknown[] = [];
  return {
    reads,
    user: { findUnique: async () => ({ role: 'MEMBER' }) },
    modelProvider: {
      findFirst: async ({ where }: { where: { slug: string; enabled: boolean; ownerId?: string } }) => {
        reads.push(where);
        return rows.find((r) => r.slug === where.slug && r.enabled === where.enabled && r.ownerId === where.ownerId) ?? null;
      },
    },
  } as never as Parameters<typeof sessionHeldKey>[0] & { reads: unknown[] };
}

const ROWS = [
  row('deepseek', 'claude', 'https://api.deepseek.com/anthropic', 'sk-ds', { defaultModel: 'deepseek-v4-flash' }),
  row('openai', 'codex', 'https://api.openai.com/v1', 'sk-oa'),
  row('moonshot', 'kimi', 'https://api.moonshot.ai/v1', 'sk-moon'),
  row('gemini', 'antigravity', 'https://generativelanguage.googleapis.com', 'AIza-g'),
  row('claude-sub', 'claude', 'https://api.anthropic.com', 'sk-ant-oat01-x'),
  row('ds-harness', 'dsh', 'https://api.deepseek.com/anthropic', 'sk-dsh'),
  row('vllm', 'kimi', 'http://192.168.1.20:8000/v1', 'sk-local'),
  row('off', 'claude', 'https://api.deepseek.com/anthropic', 'sk-off', { enabled: false }),
  row('theirs', 'claude', 'https://api.deepseek.com/anthropic', 'sk-theirs', { ownerId: 'someone-else' }),
];

const session = (provider: string, model: string | null, providerBuiltin = false) => ({
  provider,
  providerBuiltin,
  ownerId: OWNER,
  model,
});

test('a session on a configured key is named on that key, in its dialect, with the model it runs', async () => {
  const db = fakeDb(ROWS);
  assert.deepEqual(await sessionHeldKey(db, session('deepseek', 'deepseek-v4-pro')), {
    dialect: 'anthropic',
    baseUrl: 'https://api.deepseek.com/anthropic',
    apiKey: 'sk-ds',
    model: 'deepseek-v4-pro',
  });
  assert.equal((await sessionHeldKey(db, session('openai', 'gpt-5.5-codex')))?.dialect, 'openai');
  assert.equal((await sessionHeldKey(db, session('moonshot', 'kimi-k2.6')))?.dialect, 'openai-compatible');
  // agy's level-suffixed name is asked for by the API id the connection test probes.
  assert.deepEqual(await sessionHeldKey(db, session('gemini', 'gemini-3.1-pro-high')), {
    dialect: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com',
    apiKey: 'AIza-g',
    model: 'gemini-3.1-pro-preview',
  });
});

test("a model-less session falls back to its row's default model", async () => {
  assert.equal((await sessionHeldKey(fakeDb(ROWS), session('deepseek', null)))?.model, 'deepseek-v4-flash');
  // Nothing to ask for at all: no call rather than a guessed model.
  assert.equal(await sessionHeldKey(fakeDb(ROWS), session('moonshot', '  ')), null);
});

test('an OpenCode session on a configured key is named on the key its model names', async () => {
  assert.deepEqual(await sessionHeldKey(fakeDb(ROWS), session(AgentProvider.OPENCODE, 'orbit-moonshot/kimi-k2.6', true)), {
    dialect: 'openai-compatible',
    baseUrl: 'https://api.moonshot.ai/v1',
    apiKey: 'sk-moon',
    model: 'kimi-k2.6',
  });
  // OpenCode's own provider/model: the key is in OpenCode's config on the runner, not here.
  assert.equal(await sessionHeldKey(fakeDb(ROWS), session(AgentProvider.OPENCODE, 'anthropic/claude-x', true)), null);
});

test('the server spends no credential it does not hold or may not spend', async () => {
  const db = fakeDb(ROWS);
  // A built-in engine signs itself in on the runner: nothing is even looked up.
  assert.equal(await sessionHeldKey(db, session(AgentProvider.CLAUDE, 'opus', true)), null);
  assert.equal(await sessionHeldKey(db, session(AgentProvider.CODEX, 'gpt-5.5-codex', true)), null);
  assert.deepEqual(db.reads, []);
  // A Claude subscription token, a Harness row's opaque model value, an internal endpoint, a disabled
  // row, somebody else's row, and a slug no row holds (an account pool).
  for (const slug of ['claude-sub', 'ds-harness', 'vllm', 'off', 'theirs', 'my-pool']) {
    assert.equal(await sessionHeldKey(db, session(slug, 'some-model')), null, slug);
  }
});

test('internal hosts are refused, IPv6 loopback included', () => {
  for (const host of ['localhost', 'api.localhost', '127.0.0.1', '10.0.0.8', '172.20.1.1', '192.168.0.2', '169.254.169.254', '0.0.0.0', '[::1]']) {
    assert.equal(isInternalHost(new URL(`http://${host}/v1`).hostname), true, host);
  }
  for (const host of ['api.deepseek.com', '172.32.0.1', '8.8.8.8']) {
    assert.equal(isInternalHost(new URL(`https://${host}/v1`).hostname), false, host);
  }
});
