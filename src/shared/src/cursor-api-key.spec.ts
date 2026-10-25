import { describe, expect, it } from 'vitest';
import { AgentProvider } from './enums';
import { keyDialect, OPENCODE_DIALECT_NPM, openCodeDialect } from './openCodeKeys';
import {
  ALL_ENGINES,
  credentialEngines,
  defaultEngineOf,
  isEngineCompatible,
  type EngineCredential,
} from './providerEngines';
import { PROVIDER_PRESETS, providerPreset } from './providerPresets';

// A Cursor User API Key saved in Orbit (project P2, docs/cursor-runtime-contract.md §9, §16.2): a key on
// Cursor's own dialect, which Cursor CLI alone spends. The acceptance script
// (scripts/test-cursor-api-key.mjs) runs every case below by name.

const key = (
  runtime: string | null,
  presetSlug: string | null,
  baseUrl: string,
  subscriptionToken = false,
): EngineCredential => ({ kind: 'key', runtime, presetSlug, baseUrl, subscriptionToken });

const CURSOR_KEY = key('cursor', 'cursor-api', 'https://api2.cursor.sh');

describe('P2 a Cursor API key in the shared tables', () => {
  it('P2 the Cursor preset is a key of the vendor Cursor, on Cursor’s own dialect, with no model list of its own', () => {
    const preset = providerPreset('cursor-api')!;
    expect(preset).toMatchObject({
      label: 'Cursor',
      runtime: 'cursor',
      baseUrl: 'https://api2.cursor.sh',
      keyUrl: 'https://cursor.com/dashboard',
    });
    // Cursor CLI's ACP catalogue on each runner is the model list, as DeepSeek Harness's is.
    expect(preset.models).toEqual([]);
    expect(preset.defaultModel).toBe('');
    expect(preset.modelsFromRuntime).toBe(true);
    expect(preset.catalog).toBeUndefined();
    // The engine's name is no preset's: a key derives its slug from the preset, and `cursor` is reserved.
    expect(providerPreset(AgentProvider.CURSOR)).toBeUndefined();
    expect(PROVIDER_PRESETS.filter((p) => p.runtime === 'cursor').map((p) => p.slug)).toEqual(['cursor-api']);

    expect(keyDialect('cursor')).toBe('cursor');
    // OpenCode speaks every dialect but Cursor's: it has no AI SDK package for a Cursor key.
    expect(openCodeDialect('cursor')).toBeNull();
    expect(Object.keys(OPENCODE_DIALECT_NPM)).not.toContain('cursor');
    for (const [runtime, dialect] of [
      ['claude', 'anthropic'], ['dsh', 'anthropic'], ['codex', 'openai'], ['kimi', 'openai-compatible'], ['antigravity', 'gemini'],
    ] as const) {
      expect(keyDialect(runtime)).toBe(dialect);
      expect(openCodeDialect(runtime)).toBe(dialect);
    }
    expect(openCodeDialect('opencode')).toBeNull();
  });

  it('P2 a Cursor key runs on Cursor CLI alone, and every other key and engine keeps its own', () => {
    expect(credentialEngines(CURSOR_KEY)).toEqual([AgentProvider.CURSOR]);
    expect(defaultEngineOf(CURSOR_KEY)).toBe(AgentProvider.CURSOR);
    for (const engine of ALL_ENGINES) {
      expect(isEngineCompatible(engine, CURSOR_KEY)).toBe(engine === AgentProvider.CURSOR);
    }
    // The dialect decides, not the preset: a Cursor key typed in by hand is the same key.
    expect(credentialEngines(key('cursor', null, 'https://api2.cursor.sh'))).toEqual([AgentProvider.CURSOR]);
    // Cursor CLI runs a Cursor key and its own sign-in; no other key runs on it, and they keep their engines.
    expect(credentialEngines({ kind: 'login', engine: 'cursor' })).toEqual([AgentProvider.CURSOR]);
    for (const [credential, engines] of [
      [key('claude', 'glm', 'https://api.z.ai/api/anthropic'), ['claude', 'opencode']],
      [key('claude', 'deepseek', 'https://api.deepseek.com/anthropic'), ['claude', 'opencode', 'dsh']],
      [key('dsh', 'deepseek-harness', 'https://api.deepseek.com/anthropic'), ['dsh', 'claude', 'opencode']],
      [key('claude', 'anthropic', 'https://api.anthropic.com', true), ['claude']],
      [key('codex', 'openai', 'https://api.openai.com/v1'), ['codex', 'opencode']],
      [key('kimi', 'moonshot', 'https://api.moonshot.ai/v1'), ['kimi', 'opencode']],
      [key('antigravity', 'gemini', 'https://generativelanguage.googleapis.com'), ['antigravity', 'opencode']],
      [key('claude', 'cursor-api', 'https://api2.cursor.sh'), ['claude', 'opencode']],
      [key('opencode', null, 'https://x.example'), []],
    ] as const) {
      expect(credentialEngines(credential)).toEqual(engines);
      expect(isEngineCompatible(AgentProvider.CURSOR, credential)).toBe(false);
    }
  });
});
