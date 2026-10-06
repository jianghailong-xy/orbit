import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentProvider } from '@orbit/shared';
import {
  ADVERTISED_RUNTIMES,
  ANTIGRAVITY_RUNNER_UPGRADE_ERROR,
  DSH_RUNNER_UPGRADE_ERROR,
  OPENCODE_RUNNER_UPGRADE_ERROR,
  advertisedRunnerProviders,
  runnerAdvertisesProvider,
} from './runner-provider-support';

test('runner provider advertisements are exact, normalized, and ignore unknown values', () => {
  assert.deepEqual(advertisedRunnerProviders(' Claude,OPENCODE,unknown '), [
    AgentProvider.CLAUDE,
    AgentProvider.OPENCODE,
  ]);
  assert.equal(runnerAdvertisesProvider(undefined, AgentProvider.OPENCODE), false);
  assert.equal(runnerAdvertisesProvider('claude,codex', AgentProvider.OPENCODE), false);
  assert.equal(runnerAdvertisesProvider('claude,codex,opencode', AgentProvider.OPENCODE), true);
});

test('Antigravity is advertised only by a runner that names it', () => {
  // What every runner in the field sends today: OpenCode-capable, and nothing said about agy.
  assert.equal(runnerAdvertisesProvider('claude,codex,opencode', AgentProvider.ANTIGRAVITY), false);
  assert.equal(
    runnerAdvertisesProvider('claude,codex,opencode,antigravity', AgentProvider.ANTIGRAVITY),
    true,
  );
  assert.deepEqual(advertisedRunnerProviders('claude, codex, opencode, ANTIGRAVITY'), [
    AgentProvider.CLAUDE,
    AgentProvider.CODEX,
    AgentProvider.OPENCODE,
    AgentProvider.ANTIGRAVITY,
  ]);
  // A prefix is not the name: nothing about `antigravity-preview` says agy can be driven.
  assert.equal(runnerAdvertisesProvider('antigravity-preview', AgentProvider.ANTIGRAVITY), false);
});

test('the gated runtimes are exactly the runtimes a legacy runner would start as Claude', () => {
  assert.deepEqual(ADVERTISED_RUNTIMES, [
    { provider: AgentProvider.OPENCODE, upgradeError: OPENCODE_RUNNER_UPGRADE_ERROR },
    { provider: AgentProvider.ANTIGRAVITY, upgradeError: ANTIGRAVITY_RUNNER_UPGRADE_ERROR },
    { provider: AgentProvider.DSH, upgradeError: DSH_RUNNER_UPGRADE_ERROR },
  ]);
  // The stalled row says which runtime it is waiting for and what to do about it.
  assert.match(ANTIGRAVITY_RUNNER_UPGRADE_ERROR, /^Antigravity requires a newer Orbit runner/);
  assert.match(ANTIGRAVITY_RUNNER_UPGRADE_ERROR, /update this runner first$/);
});
