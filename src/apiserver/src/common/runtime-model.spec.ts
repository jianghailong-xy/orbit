import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentProvider } from '@orbit/shared';
import {
  firstRuntimeCatalogModel,
  sanitizeRuntimeDefaultModels,
  savedRuntimeDefaultModel,
} from './runtime-model';

test('runtime defaults are sanitized to the three built-in provider keys', () => {
  assert.deepEqual(
    sanitizeRuntimeDefaultModels({
      claude: '  claude-opus-5 ',
      codex: '',
      kimi: 42,
      custom: 'must-not-leak',
    }),
    { claude: 'claude-opus-5' },
  );
  assert.deepEqual(sanitizeRuntimeDefaultModels(null), {});
  assert.equal(
    savedRuntimeDefaultModel({ codex: 'gpt-5.6-sol' }, AgentProvider.CODEX),
    'gpt-5.6-sol',
  );
});

test('catalog helpers reject malformed values', () => {
  assert.equal(
    firstRuntimeCatalogModel(
      { codex: [{ value: '', label: 'bad' }, { value: ' gpt-5.7 ', label: 'GPT' }] },
      AgentProvider.CODEX,
    ),
    'gpt-5.7',
  );
  assert.equal(firstRuntimeCatalogModel({ codex: 'bad' }, AgentProvider.CODEX), undefined);
});
