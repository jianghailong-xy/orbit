import { describe, expect, it } from 'vitest';
import { AgentProvider } from './enums';
import { DEFAULT_MODEL_BY_PROVIDER, isRetiredModel, modelForProvider } from './models';

describe('isRetiredModel', () => {
  const catalogue = [{ value: 'claude-opus-5' }, { value: 'claude-sonnet-5' }];

  it('retires an id the provider no longer offers', () => {
    expect(isRetiredModel('claude-opus-4-8', catalogue)).toBe(true);
    expect(isRetiredModel('claude-opus-5', catalogue)).toBe(false);
    // Whitespace is not a difference — the same normalization the resolvers apply.
    expect(isRetiredModel('  claude-sonnet-5 ', catalogue)).toBe(false);
  });

  it('never retires against an unknown or empty catalogue', () => {
    // A runner that has not reported one yet says nothing about what the provider offers;
    // reading silence as "offers nothing" would blank every pin the moment one goes offline.
    expect(isRetiredModel('claude-opus-4-8', undefined)).toBe(false);
    expect(isRetiredModel('claude-opus-4-8', null)).toBe(false);
    expect(isRetiredModel('claude-opus-4-8', [])).toBe(false);
  });

  it('keeps a blank model — OpenCode picking for itself is a choice, not a stale id', () => {
    expect(isRetiredModel('', catalogue)).toBe(false);
    expect(isRetiredModel(null, catalogue)).toBe(false);
    expect(isRetiredModel(undefined, catalogue)).toBe(false);
  });

  it('keeps what the Runtime itself reports, catalogued or not', () => {
    // claude's settings.json names aliases (`opus`, `opusplan`, `best`) and gateway ids that the
    // quick-pick catalogue never lists. The runtime vouching for it is what makes it current.
    expect(isRetiredModel('opus', catalogue, 'opus')).toBe(false);
    expect(isRetiredModel('claude-opus-5[1m]', catalogue, 'claude-opus-5[1m]')).toBe(false);
    // …but only the one it actually reports.
    expect(isRetiredModel('opusplan', catalogue, 'opus')).toBe(true);
  });
});

describe('modelForProvider', () => {
  it('keeps a matching override for each provider', () => {
    expect(modelForProvider(AgentProvider.CODEX, 'gpt-5.4')).toBe('gpt-5.4');
    expect(modelForProvider(AgentProvider.CLAUDE, 'claude-sonnet-5')).toBe('claude-sonnet-5');
    expect(modelForProvider(AgentProvider.KIMI, 'kimi-code/kimi-for-coding')).toBe(
      'kimi-code/kimi-for-coding',
    );
    expect(modelForProvider(AgentProvider.OPENCODE, 'anthropic/claude-sonnet-5')).toBe(
      'anthropic/claude-sonnet-5',
    );
  });

  it('falls back to the provider default when no override is given', () => {
    expect(modelForProvider(AgentProvider.CODEX, null)).toBe(DEFAULT_MODEL_BY_PROVIDER[AgentProvider.CODEX]);
    expect(modelForProvider(AgentProvider.CODEX, undefined)).toBe('gpt-5.6-sol');
    expect(modelForProvider(AgentProvider.CLAUDE, '')).toBe('claude-opus-5');
    expect(modelForProvider(AgentProvider.KIMI, undefined)).toBe('kimi-code/kimi-for-coding');
    expect(modelForProvider(AgentProvider.OPENCODE, undefined)).toBe('');
  });

  it('coerces a Claude model on a Codex session to the Codex default (the reported bug)', () => {
    // The exact mismatch from the 400: `codex -m claude-opus-4-8`.
    expect(modelForProvider(AgentProvider.CODEX, 'claude-opus-4-8')).toBe('gpt-5.6-sol');
    expect(modelForProvider(AgentProvider.CODEX, 'claude-fable-5')).toBe('gpt-5.6-sol');
  });

  it('coerces a GPT model on a Claude session to the Claude default', () => {
    expect(modelForProvider(AgentProvider.CLAUDE, 'gpt-5.5')).toBe('claude-opus-5');
  });

  it('coerces obvious cross-runtime models involving Kimi', () => {
    expect(modelForProvider(AgentProvider.KIMI, 'claude-opus-5')).toBe(
      'kimi-code/kimi-for-coding',
    );
    expect(modelForProvider(AgentProvider.KIMI, 'gpt-5.6-sol')).toBe(
      'kimi-code/kimi-for-coding',
    );
    expect(modelForProvider(AgentProvider.CLAUDE, 'kimi-code/kimi-for-coding')).toBe(
      'claude-opus-5',
    );
    expect(modelForProvider(AgentProvider.CODEX, 'kimi-k2.7-code')).toBe('gpt-5.6-sol');
  });

  it('leaves an unknown/custom id untouched (e.g. an ANTHROPIC_MODEL endpoint override)', () => {
    expect(modelForProvider(AgentProvider.CLAUDE, 'my-proxy/llama-3')).toBe('my-proxy/llama-3');
    expect(modelForProvider(AgentProvider.CODEX, 'o4-preview')).toBe('o4-preview');
  });

  it('drops a stale bare model when an older client switches an agent to OpenCode', () => {
    expect(modelForProvider(AgentProvider.OPENCODE, 'claude-opus-5')).toBe('');
    expect(modelForProvider(AgentProvider.OPENCODE, 'gpt-5.6-sol')).toBe('');
    expect(modelForProvider(AgentProvider.OPENCODE, 'anthropic/claude-sonnet-4')).toBe(
      'anthropic/claude-sonnet-4',
    );
    // A namespaced id is opaque: OpenCode legitimately routes to any upstream provider,
    // so the built-in prefix guards must not rewrite `kimi-code/…` here.
    expect(modelForProvider(AgentProvider.OPENCODE, 'kimi-code/kimi-for-coding')).toBe(
      'kimi-code/kimi-for-coding',
    );
  });
});
