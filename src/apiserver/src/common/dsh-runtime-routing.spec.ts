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
import { sanitizeRuntimeDefaultModels } from './runtime-model';

const MODEL = '["deepseek-api-key","deepseek-v4-pro"]';

test('P1a runtime identity keeps legacy DeepSeek and other engines compatible', () => {
  assert.equal(normalizeRuntimeProvider('deepseek', false), AgentProvider.CLAUDE);
  assert.equal(normalizeRuntimeProvider('dsh', false), AgentProvider.CLAUDE);
  assert.equal(normalizeRuntimeProvider('dsh', true), AgentProvider.DSH);
  for (const runtime of ['claude', 'codex', 'kimi', 'opencode', 'antigravity']) {
    assert.equal(normalizeRuntimeProvider(runtime), runtime);
  }
  assert.equal(normalizeRuntimeProvider('removed-provider'), AgentProvider.CLAUDE);
});

test('P1a dsh initializes its own session id and preserves opaque live model defaults', () => {
  assert.equal(initializesRuntimeDynamically(AgentProvider.DSH), true);
  assert.equal(initializesRuntimeDynamically(AgentProvider.CLAUDE), false);
  assert.deepEqual(sanitizeRuntimeDefaultModels({ dsh: MODEL, claude: 'claude-opus-5', stale: MODEL }), {
    dsh: MODEL,
    claude: 'claude-opus-5',
  });
});

test('P1a dsh effort routing preserves opaque values and obeys the live model catalog', () => {
  for (const value of ['', 'off', 'low', 'high', 'max']) {
    assert.equal(normalizeEffortForProvider(AgentProvider.DSH, value), value);
  }
  assert.equal(normalizeEffortForProvider(AgentProvider.DSH, null), undefined);
  const catalog = { dsh: [{ value: MODEL, label: 'Pro', reasoningLevels: ['off', 'high', 'vendor/effort'] }] };
  assert.equal(normalizeEffortForRuntimeModel(AgentProvider.DSH, 'off', MODEL, catalog), 'off');
  assert.equal(normalizeEffortForRuntimeModel(AgentProvider.DSH, 'max', MODEL, catalog), '');
  assert.equal(normalizeEffortForRuntimeModel(AgentProvider.DSH, 'high', MODEL, catalog), 'high');
  assert.equal(normalizeEffortForRuntimeModel(AgentProvider.DSH, 'medium', MODEL, catalog), '');
  assert.equal(normalizeEffortForRuntimeModel(AgentProvider.DSH, 'vendor/effort', MODEL, catalog), 'vendor/effort');
  assert.equal(normalizeEffortForRuntimeModel(AgentProvider.DSH, 'high', MODEL, {
    dsh: [{ value: MODEL, label: 'Pro', reasoningLevels: [] }],
  }), '');
});

test('P1a dsh rejects unverified permission modes including account defaults', () => {
  // P4 measured Default, Auto and Don't Ask; every other mode stays refused, never substituted.
  for (const mode of [PermissionMode.PLAN, PermissionMode.ACCEPT_EDITS, PermissionMode.BYPASS, 'unknown']) {
    assert.throws(() => normalizeBuiltinPermissionMode(
      AgentProvider.DSH, MODEL, mode as PermissionMode, true, true,
    ), /DeepSeek Harness cannot enforce permission mode/);
  }
  for (const mode of [PermissionMode.DEFAULT, PermissionMode.AUTO, PermissionMode.DONT_ASK]) {
    assert.equal(normalizeBuiltinPermissionMode(AgentProvider.DSH, MODEL, mode, true, true), mode);
  }
  assert.equal(normalizeBuiltinPermissionMode(
    AgentProvider.CLAUDE, 'deepseek-v4-pro', PermissionMode.AUTO, true,
  ), PermissionMode.AUTO);
});
