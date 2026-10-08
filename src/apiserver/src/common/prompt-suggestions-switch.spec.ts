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
    maintenance: null,
    env: undefined,
    ...over,
  });

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
});

test('everything else is left without them', () => {
  assert.equal(claim({ owner: { preferences: { promptSuggestions: false } } }), false, 'owner turned it off');
  assert.equal(claim({ provider: AgentProvider.CODEX }), false, 'no native suggestions on codex');
  assert.equal(claim({ runSource: 'TASK_LIST_AUTO' }), false, 'nobody reads an automatic run');
  assert.equal(claim({ spawnDepth: 1 }), false, 'another session drives a session it spawned');
  assert.equal(claim({ maintenance: { runId: 'w' } }), false, 'a Wiki maintenance run');
  assert.equal(
    claim({ env: { ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic' } }),
    false,
    'a configured provider endpoint',
  );
});
