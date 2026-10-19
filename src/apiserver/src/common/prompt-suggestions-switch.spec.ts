import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentProvider } from '@orbit/shared';
import { claimPromptSuggestions, promptSuggestionsEnabled } from './prompt-suggestions-switch';

const claim = (over: Partial<Parameters<typeof claimPromptSuggestions>[0]> = {}) =>
  claimPromptSuggestions({
    owner: { preferences: {} },
    provider: AgentProvider.CLAUDE,
    runSource: 'MANUAL',
    spawnDepth: 0,
    env: undefined,
    ...over,
  });

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function withoutDeepSeekKey(run: () => void): void {
  const originalKey = process.env.DEEPSEEK_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
  try {
    run();
  } finally {
    restoreEnv('DEEPSEEK_API_KEY', originalKey);
  }
}

test('the switch is on until the owner turns it off', () => {
  assert.equal(promptSuggestionsEnabled({ preferences: {} }), true);
  assert.equal(promptSuggestionsEnabled({ preferences: null }), true);
  assert.equal(promptSuggestionsEnabled({ preferences: { promptSuggestions: true } }), true);
  assert.equal(promptSuggestionsEnabled({ preferences: { promptSuggestions: false } }), false);
});

test('a Claude session a person converses in gets suggestions', () => {
  assert.equal(claim(), true);
  assert.equal(claim({ runSource: 'PROJECT_COORDINATOR' }), true);
  assert.equal(claim({ env: { ANTHROPIC_BASE_URL: 'https://api.anthropic.com/' } }), true);
  assert.equal(claim({ env: { ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic' } }), true, 'measured on DeepSeek');
});

test('a non-Claude session gets the server-written guess only while the server holds a DeepSeek key', () => {
  const originalKey = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = 'test-key';
  try {
    assert.equal(claim({ provider: AgentProvider.CODEX }), true);
    assert.equal(claim({ provider: AgentProvider.KIMI }), true);
    // The shared conditions still apply: the guess is written for a person who will read it.
    assert.equal(claim({ provider: AgentProvider.CODEX, runSource: 'TASK_LIST_AUTO' }), false, 'nobody reads an automatic run');
    assert.equal(claim({ provider: AgentProvider.CODEX, spawnDepth: 1 }), false, 'another session drives a session it spawned');
    assert.equal(
      claim({ provider: AgentProvider.CODEX, owner: { preferences: { promptSuggestions: false } } }),
      false,
      'owner turned it off',
    );
  } finally {
    restoreEnv('DEEPSEEK_API_KEY', originalKey);
  }
  // No key on the server: nothing could answer the runner's request, so the claim stays off.
  withoutDeepSeekKey(() => {
    assert.equal(claim({ provider: AgentProvider.CODEX }), false);
    assert.equal(claim({ provider: AgentProvider.KIMI }), false);
  });
});

test('everything else is left without them', () => {
  assert.equal(claim({ owner: { preferences: { promptSuggestions: false } } }), false, 'owner turned it off');
  assert.equal(claim({ runSource: 'TASK_LIST_AUTO' }), false, 'nobody reads an automatic run');
  assert.equal(claim({ spawnDepth: 1 }), false, 'another session drives a session it spawned');
  assert.equal(
    claim({ env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:8000' } }),
    false,
    'a configured provider endpoint nobody measured',
  );
});
