import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentProvider, PermissionMode } from '@orbit/shared';
import {
  initializesRuntimeDynamically,
  normalizeBuiltinPermissionMode,
  normalizeEffortForProvider,
  normalizeEffortForRuntimeModel,
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

test('unsupported built-in models safely downgrade Auto permission mode', () => {
  assert.equal(
    normalizeBuiltinPermissionMode(
      AgentProvider.CLAUDE,
      'claude-haiku-4-5-20251001',
      PermissionMode.AUTO,
    ),
    PermissionMode.DEFAULT,
  );
  assert.equal(
    normalizeBuiltinPermissionMode(AgentProvider.CODEX, 'claude-opus-5', PermissionMode.AUTO),
    PermissionMode.DEFAULT,
  );
  assert.equal(
    normalizeBuiltinPermissionMode(
      AgentProvider.CLAUDE,
      'claude-opus-5',
      PermissionMode.AUTO,
    ),
    PermissionMode.AUTO,
  );
  assert.equal(
    normalizeBuiltinPermissionMode(
      AgentProvider.CLAUDE,
      'claude-haiku-4-5-20251001',
      PermissionMode.PLAN,
    ),
    PermissionMode.PLAN,
  );
  assert.equal(
    normalizeBuiltinPermissionMode(AgentProvider.KIMI, 'company/kimi-alias', PermissionMode.AUTO),
    PermissionMode.AUTO,
  );
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

test('OpenCode preserves provider-defined variants; closed CLI enums reject leaked ones', () => {
  assert.equal(normalizeEffortForProvider(AgentProvider.OPENCODE, 'ultra'), 'ultra');
  assert.equal(
    normalizeEffortForProvider(AgentProvider.OPENCODE, 'project-custom'),
    'project-custom',
  );
  assert.equal(normalizeEffortForProvider(AgentProvider.CLAUDE, 'ultra'), '');
  assert.equal(normalizeEffortForProvider(AgentProvider.CLAUDE, 'max'), 'max');
  assert.equal(normalizeEffortForProvider(AgentProvider.CODEX, 'ultra'), '');
  assert.equal(normalizeEffortForProvider(AgentProvider.CODEX, 'minimal'), 'minimal');
  assert.equal(normalizeEffortForProvider(AgentProvider.CLAUDE, null), undefined);
});

test('model-defined effort vocabularies are clamped against the assigned runner catalog', () => {
  // What a signed-in runner reports: Kimi's K2.7 Coding declares no thinking levels and answers
  // any of them with invalid_params, while K3 declares low/high/max.
  const catalog = {
    kimi: [
      { value: 'kimi-code/kimi-for-coding', label: 'K2.7 Coding' },
      { value: 'kimi-code/k3', label: 'K3', reasoningLevels: ['low', 'high', 'max'] },
    ],
    opencode: [{ value: 'anthropic/claude-sonnet-5', label: 'Sonnet 5', reasoningLevels: [] }],
  };
  assert.equal(
    normalizeEffortForRuntimeModel(AgentProvider.KIMI, 'max', 'kimi-code/kimi-for-coding', catalog),
    '',
  );
  assert.equal(
    normalizeEffortForRuntimeModel(AgentProvider.KIMI, 'max', 'kimi-code/k3', catalog),
    'max',
  );
  // The vocabulary map still runs first, so a Claude/Codex-shaped level lands on a real Kimi one.
  assert.equal(
    normalizeEffortForRuntimeModel(AgentProvider.KIMI, 'xhigh', 'kimi-code/k3', catalog),
    'max',
  );
  // A model the runner-wide catalog does not report keeps its value: an env-injected
  // KIMI_MODEL_* alias, or a runner whose CLI predates the catalog probe.
  assert.equal(
    normalizeEffortForRuntimeModel(AgentProvider.KIMI, 'max', 'company/kimi-alias', catalog),
    'max',
  );
  assert.equal(normalizeEffortForRuntimeModel(AgentProvider.KIMI, 'max', 'kimi-code/k3', null), 'max');
  assert.equal(
    normalizeEffortForRuntimeModel(AgentProvider.OPENCODE, 'max', 'anthropic/claude-sonnet-5', catalog),
    '',
  );
  // Closed-vocabulary runtimes never consult the catalog.
  assert.equal(
    normalizeEffortForRuntimeModel(AgentProvider.CLAUDE, 'max', 'claude-opus-5', catalog),
    'max',
  );
});

test('OpenCode is a dynamically-initialized runtime whose Auto mode is never downgraded', () => {
  assert.equal(normalizeRuntimeProvider(AgentProvider.OPENCODE), AgentProvider.OPENCODE);
  assert.equal(initializesRuntimeDynamically(AgentProvider.OPENCODE), true);
  // OpenCode owns model selection, so its Auto does not depend on a Claude model allow-list.
  assert.equal(
    normalizeBuiltinPermissionMode(AgentProvider.OPENCODE, '', PermissionMode.AUTO),
    PermissionMode.AUTO,
  );
});
