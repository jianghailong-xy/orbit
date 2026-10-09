import { describe, expect, it } from 'vitest';
import { AgentProvider } from './enums';
import {
  ALL_ENGINES,
  ENGINE_CLI_NAMES,
  credentialEngines,
  defaultEngineOf,
  isDeepSeekKey,
  isEngine,
  isEngineCompatible,
  type EngineCredential,
} from './providerEngines';

const key = (
  runtime: string | null,
  presetSlug: string | null,
  baseUrl: string,
  subscriptionToken = false,
): EngineCredential => ({ kind: 'key', runtime, presetSlug, baseUrl, subscriptionToken });

const DEEPSEEK = key('claude', 'deepseek', 'https://api.deepseek.com/anthropic');
const GLM = key('claude', 'glm', 'https://api.z.ai/api/anthropic');

describe('engines', () => {
  it('lists every engine once, each under its CLI name', () => {
    expect([...ALL_ENGINES].sort()).toEqual(Object.values(AgentProvider).sort());
    expect(ENGINE_CLI_NAMES).toEqual({
      claude: 'Claude Code',
      codex: 'Codex',
      kimi: 'Kimi Code',
      antigravity: 'Antigravity CLI',
      opencode: 'OpenCode',
      dsh: 'DeepSeek Harness',
    });
    for (const engine of ALL_ENGINES) expect(isEngine(engine)).toBe(true);
    expect(isEngine('deepseek-harness')).toBe(false);
    expect(isEngine('')).toBe(false);
    expect(isEngine(null)).toBe(false);
  });
});

describe('credentialEngines', () => {
  it('runs a sign-in, a pool and OpenCode config on their own engine only', () => {
    for (const engine of ['claude', 'codex', 'kimi', 'antigravity'] as const) {
      expect(credentialEngines({ kind: 'login', engine })).toEqual([engine]);
    }
    expect(credentialEngines({ kind: 'pool', engine: AgentProvider.CLAUDE })).toEqual(['claude']);
    expect(credentialEngines({ kind: 'pool', engine: AgentProvider.CODEX })).toEqual(['codex']);
    expect(credentialEngines({ kind: 'opencode' })).toEqual(['opencode']);
  });

  it('runs a key on its dialect’s own engine first, then OpenCode', () => {
    expect(credentialEngines(GLM)).toEqual(['claude', 'opencode']);
    expect(credentialEngines(key('codex', 'openai', 'https://api.openai.com/v1'))).toEqual(['codex', 'opencode']);
    expect(credentialEngines(key('kimi', 'moonshot', 'https://api.moonshot.ai/v1'))).toEqual(['kimi', 'opencode']);
    expect(credentialEngines(key('antigravity', 'gemini', 'https://generativelanguage.googleapis.com')))
      .toEqual(['antigravity', 'opencode']);
  });

  it('adds DeepSeek Harness for a DeepSeek key, preset or custom host alike', () => {
    expect(credentialEngines(DEEPSEEK)).toEqual(['claude', 'opencode', 'dsh']);
    expect(credentialEngines(key('claude', null, 'https://api.deepseek.com/anthropic'))).toEqual(['claude', 'opencode', 'dsh']);
    expect(credentialEngines(key('claude', null, 'https://api.deepseek.com.evil.example/anthropic'))).toEqual(['claude', 'opencode']);
  });

  it('keeps a row still on the dsh runtime on DeepSeek Harness by default', () => {
    expect(credentialEngines(key('dsh', 'deepseek-harness', 'https://api.deepseek.com/anthropic'))).toEqual(['dsh', 'claude', 'opencode']);
    // A custom endpoint chosen for Harness (a mock, a proxy) ran on it whatever its host.
    expect(credentialEngines(key('dsh', null, 'http://127.0.0.1:8787/anthropic'))).toEqual(['dsh', 'claude', 'opencode']);
  });

  it('runs a Claude subscription token on Claude Code alone', () => {
    expect(credentialEngines(key('claude', 'anthropic', 'https://api.anthropic.com', true))).toEqual(['claude']);
    expect(credentialEngines(key('claude', 'deepseek', 'https://api.deepseek.com/anthropic', true))).toEqual(['claude']);
    expect(credentialEngines(key('codex', 'openai', 'https://api.openai.com/v1', true))).toEqual([]);
    // The token rule outranks a legacy Harness row's default: Harness cannot spend a subscription.
    const legacyToken = key('dsh', 'deepseek-harness', 'https://api.deepseek.com/anthropic', true);
    expect(credentialEngines(legacyToken)).toEqual(['claude']);
    expect(defaultEngineOf(legacyToken)).toBe('claude');
  });

  it('runs a key on a protocol no engine speaks nowhere', () => {
    expect(credentialEngines(key('opencode', null, 'https://x.example'))).toEqual([]);
    expect(defaultEngineOf(key('opencode', null, 'https://x.example'))).toBeNull();
  });
});

describe('defaultEngineOf', () => {
  it('is the engine the credential ran on before the split', () => {
    expect(defaultEngineOf({ kind: 'login', engine: 'kimi' })).toBe('kimi');
    expect(defaultEngineOf({ kind: 'pool', engine: AgentProvider.CODEX })).toBe('codex');
    expect(defaultEngineOf({ kind: 'opencode' })).toBe('opencode');
    expect(defaultEngineOf(DEEPSEEK)).toBe('claude');
    expect(defaultEngineOf(key('dsh', 'deepseek-harness', 'https://api.deepseek.com/anthropic'))).toBe('dsh');
    expect(defaultEngineOf(key('antigravity', 'gemini', 'https://generativelanguage.googleapis.com'))).toBe('antigravity');
  });
});

describe('isEngineCompatible', () => {
  it('pairs an engine with a credential only where the table allows it', () => {
    expect(isEngineCompatible('dsh', DEEPSEEK)).toBe(true);
    expect(isEngineCompatible('opencode', DEEPSEEK)).toBe(true);
    expect(isEngineCompatible('dsh', GLM)).toBe(false);
    expect(isEngineCompatible('codex', GLM)).toBe(false);
    expect(isEngineCompatible('claude', { kind: 'login', engine: 'codex' })).toBe(false);
    expect(isEngineCompatible('opencode', key('claude', 'anthropic', 'https://api.anthropic.com', true))).toBe(false);
    expect(isEngineCompatible('deepseek', DEEPSEEK)).toBe(false);
  });
});

describe('isDeepSeekKey', () => {
  it('is the two presets, else a custom endpoint on api.deepseek.com', () => {
    // The cases of the apiserver's isDeepSeekAccountRow (deepseek-balance.spec.ts), which this mirrors.
    expect(isDeepSeekKey({ presetSlug: 'deepseek', baseUrl: 'https://api.deepseek.com/anthropic' })).toBe(true);
    expect(isDeepSeekKey({ presetSlug: 'deepseek-harness', baseUrl: 'https://api.deepseek.com/anthropic' })).toBe(true);
    expect(isDeepSeekKey({ presetSlug: null, baseUrl: 'https://API.DeepSeek.com/v1' })).toBe(true);
    expect(isDeepSeekKey({ presetSlug: null, baseUrl: 'https://api.deepseek.com.evil.example/v1' })).toBe(false);
    expect(isDeepSeekKey({ presetSlug: null, baseUrl: 'not a url' })).toBe(false);
    expect(isDeepSeekKey({ presetSlug: 'moonshot', baseUrl: 'https://api.deepseek.com/anthropic' })).toBe(false);
  });
});
