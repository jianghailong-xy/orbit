import { describe, expect, it } from 'vitest';
import { keyDialect, openCodeBaseUrl, openCodeKeyModel, openCodeKeyOf } from './openCodeKeys';

describe('keyDialect', () => {
  it('reads the dialect off the runtime the row borrows', () => {
    expect(keyDialect('claude')).toBe('anthropic');
    expect(keyDialect('dsh')).toBe('anthropic');
    expect(keyDialect('codex')).toBe('openai');
    expect(keyDialect('kimi')).toBe('openai-compatible');
    expect(keyDialect('antigravity')).toBe('gemini');
    expect(keyDialect(null)).toBe('anthropic');
    expect(keyDialect('opencode')).toBeNull();
  });
});

describe('openCodeBaseUrl', () => {
  it('adds the API version the SDK expects and the CLI appends itself', () => {
    expect(openCodeBaseUrl('anthropic', 'https://api.deepseek.com/anthropic')).toBe('https://api.deepseek.com/anthropic/v1');
    expect(openCodeBaseUrl('anthropic', 'https://api.anthropic.com/')).toBe('https://api.anthropic.com/v1');
    expect(openCodeBaseUrl('anthropic', 'https://x.example/v1')).toBe('https://x.example/v1');
    expect(openCodeBaseUrl('gemini', 'https://generativelanguage.googleapis.com')).toBe('https://generativelanguage.googleapis.com/v1beta');
    expect(openCodeBaseUrl('openai', 'https://api.openai.com/v1')).toBe('https://api.openai.com/v1');
    expect(openCodeBaseUrl('openai-compatible', 'https://api.moonshot.ai/v1/')).toBe('https://api.moonshot.ai/v1');
  });
});

describe('openCodeKeyOf', () => {
  it('round-trips a key model and ignores every other OpenCode id', () => {
    expect(openCodeKeyOf(openCodeKeyModel('deepseek-2', 'deepseek-v4-pro'))).toEqual({ slug: 'deepseek-2', model: 'deepseek-v4-pro' });
    expect(openCodeKeyOf('orbit-glm/glm-5/turbo')).toEqual({ slug: 'glm', model: 'glm-5/turbo' });
    expect(openCodeKeyOf('anthropic/claude-opus-5')).toBeNull();
    expect(openCodeKeyOf('')).toBeNull();
    expect(openCodeKeyOf('orbit-/x')).toBeNull();
    expect(openCodeKeyOf('orbit-deepseek/')).toBeNull();
  });
});
