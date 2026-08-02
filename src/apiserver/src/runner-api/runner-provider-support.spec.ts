import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentProvider } from '@orbit/shared';
import { advertisedRunnerProviders, runnerAdvertisesProvider } from './runner-provider-support';

test('runner provider advertisements are exact, normalized, and ignore unknown values', () => {
  assert.deepEqual(advertisedRunnerProviders(' Claude,OPENCODE,unknown '), [
    AgentProvider.CLAUDE,
    AgentProvider.OPENCODE,
  ]);
  assert.equal(runnerAdvertisesProvider(undefined, AgentProvider.OPENCODE), false);
  assert.equal(runnerAdvertisesProvider('claude,codex', AgentProvider.OPENCODE), false);
  assert.equal(runnerAdvertisesProvider('claude,codex,opencode', AgentProvider.OPENCODE), true);
});
