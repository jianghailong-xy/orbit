import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { AgentProvider } from '@orbit/shared';
import { encryptSecret } from './provider-crypto';
import { resolveProviderExec, runsOnOpenCode, type OpenCodeKeyRow } from './custom-provider';

process.env.PROVIDER_SECRET_KEY = 'test-master-key';

const key = (slug: string, runtime: string, baseUrl: string, secret: string, over: Partial<OpenCodeKeyRow> = {}): OpenCodeKeyRow => ({
  slug,
  runtime,
  baseUrl,
  apiKeyEnc: encryptSecret(secret),
  defaultModel: null,
  enabled: true,
  ...over,
});

const KEYS = [
  key('deepseek', 'claude', 'https://api.deepseek.com/anthropic', 'sk-ds'),
  key('openai', 'codex', 'https://api.openai.com/v1', 'sk-oa'),
  key('moonshot', 'kimi', 'https://api.moonshot.ai/v1', 'sk-moon'),
  key('gemini', 'antigravity', 'https://generativelanguage.googleapis.com', 'AIza-g'),
  key('claude-sub', 'claude', 'https://api.anthropic.com', 'sk-ant-oat01-x'),
  key('off', 'claude', 'https://api.deepseek.com/anthropic', 'sk-off', { enabled: false }),
];

const openCode = (model: string, workspaceEnv?: Record<string, string>) =>
  resolveProviderExec({
    declaredProvider: AgentProvider.OPENCODE,
    customRow: null,
    sessionModel: model,
    workspaceEnv,
    openCodeKeys: KEYS,
  });

const config = (env?: Record<string, string>) => JSON.parse(env?.OPENCODE_CONFIG_CONTENT ?? 'null');

test('an OpenCode model on a configured key runs on that key, through the SDK of its dialect', () => {
  const cases: Array<[string, string, string, string]> = [
    ['deepseek', '@ai-sdk/anthropic', 'https://api.deepseek.com/anthropic/v1', 'sk-ds'],
    ['openai', '@ai-sdk/openai', 'https://api.openai.com/v1', 'sk-oa'],
    ['moonshot', '@ai-sdk/openai-compatible', 'https://api.moonshot.ai/v1', 'sk-moon'],
    ['gemini', '@ai-sdk/google', 'https://generativelanguage.googleapis.com/v1beta', 'AIza-g'],
  ];
  for (const [slug, npm, baseURL, apiKey] of cases) {
    const exec = openCode(`orbit-${slug}/m-1`);
    assert.equal(exec.provider, AgentProvider.OPENCODE);
    assert.equal(exec.model, `orbit-${slug}/m-1`);
    assert.deepEqual(config(exec.env).provider, {
      [`orbit-${slug}`]: { npm, options: { baseURL, apiKey }, models: { 'm-1': { name: 'm-1' } } },
    });
  }
});

test("writes the key over the workspace's own OpenCode config, and only the one key", () => {
  const exec = openCode('orbit-deepseek/deepseek-v4-pro', {
    OPENCODE_CONFIG_CONTENT: JSON.stringify({ theme: 'x', provider: { mine: { npm: 'p' } } }),
    OTHER: '1',
  });
  const content = config(exec.env);
  assert.equal(content.theme, 'x');
  assert.deepEqual(Object.keys(content.provider), ['mine', 'orbit-deepseek']);
  assert.equal(exec.env?.OTHER, '1');
  assert.ok(!exec.env?.OPENCODE_CONFIG_CONTENT.includes('sk-oa'));
});

test("leaves OpenCode's own models alone", () => {
  assert.equal(openCode('anthropic/claude-opus-5').env, undefined);
});

test('refuses a key that is gone, disabled, or a Claude subscription token', () => {
  for (const slug of ['missing', 'off', 'claude-sub']) {
    assert.throws(() => openCode(`orbit-${slug}/m`), /provider not available on OpenCode/);
  }
});

test('runsOnOpenCode: an enabled API key of a known dialect', () => {
  assert.equal(runsOnOpenCode(KEYS[0]), true);
  assert.equal(runsOnOpenCode(KEYS[3]), true);
  assert.equal(runsOnOpenCode(KEYS[4]), false);
  assert.equal(runsOnOpenCode(KEYS[5]), false);
  assert.equal(runsOnOpenCode({ ...KEYS[0], runtime: 'opencode' }), false);
});
