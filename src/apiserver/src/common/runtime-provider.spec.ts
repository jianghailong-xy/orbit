import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentProvider } from '@orbit/shared';
import {
  initializesRuntimeDynamically,
  normalizeEffortForProvider,
  normalizeRuntimeProvider,
} from './runtime-provider';

test('normalizeRuntimeProvider preserves every built-in runtime and safely defaults unknown ids', () => {
  assert.equal(normalizeRuntimeProvider(AgentProvider.CLAUDE), AgentProvider.CLAUDE);
  assert.equal(normalizeRuntimeProvider(AgentProvider.CODEX), AgentProvider.CODEX);
  assert.equal(normalizeRuntimeProvider(AgentProvider.KIMI), AgentProvider.KIMI);
  assert.equal(
    normalizeRuntimeProvider(AgentProvider.KIMI, false),
    AgentProvider.CLAUDE,
    'an old replica custom-provider write must not become first-class Kimi',
  );
  assert.equal(normalizeRuntimeProvider('removed-provider'), AgentProvider.CLAUDE);
  assert.equal(normalizeRuntimeProvider(null), AgentProvider.CLAUDE);
});

test('Codex and Kimi initialize their runtime id dynamically; Claude does not', () => {
  assert.equal(initializesRuntimeDynamically(AgentProvider.CODEX), true);
  assert.equal(initializesRuntimeDynamically(AgentProvider.KIMI), true);
  assert.equal(initializesRuntimeDynamically(AgentProvider.CLAUDE), false);
});

test('effort normalization maps stale provider levels onto each runtime vocabulary', () => {
  assert.equal(normalizeEffortForProvider(AgentProvider.CODEX, 'max'), 'xhigh');
  assert.equal(normalizeEffortForProvider(AgentProvider.KIMI, 'minimal'), 'low');
  assert.equal(normalizeEffortForProvider(AgentProvider.KIMI, 'medium'), 'high');
  assert.equal(normalizeEffortForProvider(AgentProvider.KIMI, 'xhigh'), 'max');
  assert.equal(normalizeEffortForProvider(AgentProvider.KIMI, 'high'), 'high');
  assert.equal(normalizeEffortForProvider(AgentProvider.CLAUDE, 'medium'), 'medium');
  assert.equal(normalizeEffortForProvider(AgentProvider.KIMI, null), undefined);
});
