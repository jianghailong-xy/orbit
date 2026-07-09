import { describe, expect, it } from 'vitest';
import { AgentProvider } from './enums';
import { DEFAULT_MODEL_BY_PROVIDER, modelForProvider } from './models';

describe('modelForProvider', () => {
  it('keeps a matching override for each provider', () => {
    expect(modelForProvider(AgentProvider.CODEX, 'gpt-5.4')).toBe('gpt-5.4');
    expect(modelForProvider(AgentProvider.CLAUDE, 'claude-sonnet-5')).toBe('claude-sonnet-5');
  });

  it('falls back to the provider default when no override is given', () => {
    expect(modelForProvider(AgentProvider.CODEX, null)).toBe(DEFAULT_MODEL_BY_PROVIDER[AgentProvider.CODEX]);
    expect(modelForProvider(AgentProvider.CODEX, undefined)).toBe('gpt-5.5');
    expect(modelForProvider(AgentProvider.CLAUDE, '')).toBe('claude-opus-4-8');
  });

  it('coerces a Claude model on a Codex session to the Codex default (the reported bug)', () => {
    // The exact mismatch from the 400: `codex -m claude-opus-4-8`.
    expect(modelForProvider(AgentProvider.CODEX, 'claude-opus-4-8')).toBe('gpt-5.5');
    expect(modelForProvider(AgentProvider.CODEX, 'claude-fable-5')).toBe('gpt-5.5');
  });

  it('coerces a GPT model on a Claude session to the Claude default', () => {
    expect(modelForProvider(AgentProvider.CLAUDE, 'gpt-5.5')).toBe('claude-opus-4-8');
  });

  it('leaves an unknown/custom id untouched (e.g. an ANTHROPIC_MODEL endpoint override)', () => {
    expect(modelForProvider(AgentProvider.CLAUDE, 'my-proxy/llama-3')).toBe('my-proxy/llama-3');
    expect(modelForProvider(AgentProvider.CODEX, 'o4-preview')).toBe('o4-preview');
  });
});
