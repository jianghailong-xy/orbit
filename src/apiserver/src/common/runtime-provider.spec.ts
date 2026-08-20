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
  // Codex keeps Auto: the runner starts it with approvalPolicy "on-request", Codex's name for
  // letting the model decide when to ask. Only Claude gates Auto per model.
  assert.equal(
    normalizeBuiltinPermissionMode(AgentProvider.CODEX, 'gpt-5.6-sol', PermissionMode.AUTO),
    PermissionMode.AUTO,
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

test('configured providers keep Auto on the Claude runtime regardless of model id', () => {
  assert.equal(
    normalizeBuiltinPermissionMode(AgentProvider.CLAUDE, 'deepseek-v4', PermissionMode.AUTO, true),
    PermissionMode.AUTO,
  );
  // Claude's own ids through a configured provider follow the CLI too, not the allow-list.
  assert.equal(
    normalizeBuiltinPermissionMode(
      AgentProvider.CLAUDE,
      'claude-haiku-4-5-20251001',
      PermissionMode.AUTO,
      true,
    ),
    PermissionMode.AUTO,
  );
  // Built-in Claude is unchanged: only the known capable families.
  assert.equal(
    normalizeBuiltinPermissionMode(AgentProvider.CLAUDE, 'deepseek-v4', PermissionMode.AUTO),
    PermissionMode.DEFAULT,
  );
  // A configured provider on the Codex runtime keeps Auto for the same reason built-in Codex does.
  assert.equal(
    normalizeBuiltinPermissionMode(AgentProvider.CODEX, 'deepseek-v4', PermissionMode.AUTO, true),
    PermissionMode.AUTO,
  );
});

test('Codex and Kimi initialize their runtime id dynamically; Claude does not', () => {
  assert.equal(initializesRuntimeDynamically(AgentProvider.CODEX), true);
  assert.equal(initializesRuntimeDynamically(AgentProvider.KIMI), true);
  assert.equal(initializesRuntimeDynamically(AgentProvider.CLAUDE), false);
});

test('effort normalization maps stale provider levels onto each runtime vocabulary', () => {
  assert.equal(normalizeEffortForProvider(AgentProvider.CODEX, 'max'), 'max');
  assert.equal(normalizeEffortForProvider(AgentProvider.CODEX, 'ultra'), 'ultra');
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
  assert.equal(normalizeEffortForProvider(AgentProvider.CODEX, 'ultra'), 'ultra');
  assert.equal(normalizeEffortForProvider(AgentProvider.CODEX, 'project-custom'), '');
  assert.equal(normalizeEffortForProvider(AgentProvider.CODEX, 'minimal'), 'minimal');
  assert.equal(normalizeEffortForProvider(AgentProvider.CLAUDE, null), undefined);
});

test('model-defined effort vocabularies are clamped against the assigned runner catalog', () => {
  // What a signed-in runner reports: Kimi's K2.7 Coding declares no thinking levels and answers
  // any of them with invalid_params, while K3 declares low/high/max.
  const catalog = {
    codex: [
      {
        value: 'gpt-5.6-sol',
        label: 'GPT-5.6-Sol',
        reasoningLevels: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
      },
    ],
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
  assert.equal(
    normalizeEffortForRuntimeModel(AgentProvider.CODEX, 'ultra', 'gpt-5.6-sol', catalog),
    'ultra',
  );
  assert.equal(
    normalizeEffortForRuntimeModel(AgentProvider.CODEX, 'minimal', 'gpt-5.6-sol', catalog),
    '',
  );
  // Claude's closed vocabulary does not consult the catalog.
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

// The observed failure: a session created with Bypass landed on a runner running as root, claude
// refused with "--dangerously-skip-permissions cannot be used with root/sudo privileges for
// security reasons" and exited during startup, and the session finished FAILED in 5s with zero
// turns and an empty error column. Substituting here is what keeps an account-level Bypass default
// from doing that to every session on that machine.
test('a root runner runs Don’t Ask in place of Bypass', () => {
  assert.equal(
    normalizeBuiltinPermissionMode(
      AgentProvider.CLAUDE,
      'claude-opus-5',
      PermissionMode.BYPASS,
      false,
      true,
    ),
    PermissionMode.DONT_ASK,
  );
});

test('Bypass survives everywhere the root refusal does not apply', () => {
  // A non-root runner is the ordinary case and must be untouched.
  assert.equal(
    normalizeBuiltinPermissionMode(
      AgentProvider.CLAUDE,
      'claude-opus-5',
      PermissionMode.BYPASS,
      false,
      false,
    ),
    PermissionMode.BYPASS,
  );
  // A runner too old to report its uid: "we don't know" must not silently narrow the mode, or
  // shipping this would change what every un-upgraded runner in the fleet does.
  for (const unreported of [undefined, null]) {
    assert.equal(
      normalizeBuiltinPermissionMode(
        AgentProvider.CLAUDE,
        'claude-opus-5',
        PermissionMode.BYPASS,
        false,
        unreported,
      ),
      PermissionMode.BYPASS,
    );
  }
});

test('root does not disturb the modes it has no claim on', () => {
  // Only Bypass is refused under root — every other mode starts normally, verified against claude
  // 2.1.233 as uid 0. Auto in particular keeps its own per-model rule rather than being shadowed.
  for (const mode of [
    PermissionMode.DEFAULT,
    PermissionMode.PLAN,
    PermissionMode.ACCEPT_EDITS,
    PermissionMode.DONT_ASK,
  ]) {
    assert.equal(
      normalizeBuiltinPermissionMode(AgentProvider.CLAUDE, 'claude-opus-5', mode, false, true),
      mode,
    );
  }
  assert.equal(
    normalizeBuiltinPermissionMode(AgentProvider.CLAUDE, 'claude-opus-5', PermissionMode.AUTO, false, true),
    PermissionMode.AUTO,
  );
  assert.equal(
    normalizeBuiltinPermissionMode(
      AgentProvider.CLAUDE,
      'claude-haiku-4-5-20251001',
      PermissionMode.AUTO,
      false,
      true,
    ),
    PermissionMode.DEFAULT,
  );
});
