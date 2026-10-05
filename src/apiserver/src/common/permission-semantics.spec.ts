import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AgentProvider,
  PermissionMode,
  autoAvailable,
  derivePermissionSemantics,
  runtimeApprovalSupport,
} from '@orbit/shared';
import { withSessionCapabilities } from '../sessions/session-state';

const ASK_MODES = [PermissionMode.DEFAULT, PermissionMode.ACCEPT_EDITS, PermissionMode.PLAN];

test('an ask-me mode is honored only where the runtime can reach a human', () => {
  for (const mode of ASK_MODES) {
    // Claude blocks on a real approval card.
    assert.deepEqual(
      { u: derivePermissionSemantics(AgentProvider.CLAUDE, mode).unapproved, h: derivePermissionSemantics(AgentProvider.CLAUDE, mode).honored },
      { u: 'ask', h: true },
    );
    // Kimi asks too, but only about tools it deems worth asking about.
    const kimi = derivePermissionSemantics(AgentProvider.KIMI, mode);
    assert.equal(kimi.unapproved, 'ask');
    assert.equal(kimi.honored, true);
    assert.ok(kimi.note, 'the partial guarantee must be stated, not implied');
    // OpenCode cannot ask: it refuses rather than waving the action through.
    const opencode = derivePermissionSemantics(AgentProvider.OPENCODE, mode);
    assert.equal(opencode.unapproved, 'deny');
    assert.equal(opencode.honored, false);
    // agy asks through Orbit's approval hook, which every call that acts reaches (contract §14).
    const antigravity = derivePermissionSemantics(AgentProvider.ANTIGRAVITY, mode);
    assert.equal(antigravity.unapproved, 'ask');
    assert.equal(antigravity.honored, true);
    assert.equal(antigravity.note, undefined);
    // Codex now bridges its approval requests to the same card, so an ask-me mode means it.
    const codex = derivePermissionSemantics(AgentProvider.CODEX, mode);
    assert.equal(codex.unapproved, 'ask');
    assert.equal(codex.honored, true);
    assert.ok(codex.note?.includes('commands'), `codex note = ${codex.note}`);
  }
});

test("Don't Ask means deny everywhere a runtime can withhold, and is unenforced on Codex", () => {
  for (const provider of [
    AgentProvider.CLAUDE,
    AgentProvider.KIMI,
    AgentProvider.OPENCODE,
    AgentProvider.ANTIGRAVITY,
  ]) {
    const semantics = derivePermissionSemantics(provider, PermissionMode.DONT_ASK);
    assert.equal(semantics.unapproved, 'deny', `${provider} should deny`);
    assert.equal(semantics.honored, true);
  }
  // Codex is the exception, and says so: it takes no allowlist, so approvals stay off there.
  const codex = derivePermissionSemantics(AgentProvider.CODEX, PermissionMode.DONT_ASK);
  assert.deepEqual({ u: codex.unapproved, h: codex.honored }, { u: 'allow', h: false });
  assert.ok(codex.note?.includes('not enforced on Codex'), `codex note = ${codex.note}`);
});

test('Auto and Bypass are honored by supported runtimes and rejected on DeepSeek Harness', () => {
  const expected: Record<AgentProvider, { u: 'allow' | 'deny'; h: boolean }> = {
    [AgentProvider.CLAUDE]: { u: 'allow', h: true },
    [AgentProvider.CODEX]: { u: 'allow', h: true },
    [AgentProvider.KIMI]: { u: 'allow', h: true },
    [AgentProvider.OPENCODE]: { u: 'allow', h: true },
    [AgentProvider.ANTIGRAVITY]: { u: 'allow', h: true },
    [AgentProvider.DSH]: { u: 'deny', h: false },
  };
  for (const mode of [PermissionMode.AUTO, PermissionMode.BYPASS]) {
    for (const provider of Object.values(AgentProvider)) {
      const semantics = derivePermissionSemantics(provider, mode);
      assert.deepEqual(
        { u: semantics.unapproved, h: semantics.honored },
        expected[provider],
        `${provider}/${mode}`,
      );
    }
  }
});

test('Auto is unavailable on DeepSeek Harness and only Claude gates it per model', () => {
  // Codex has it as `on-request` ("the model decides when to ask"), Kimi and OpenCode
  // runtime-wide. It used to be refused on Codex, which is why a Codex session was told to
  // switch to a newer Claude model to get a mode its own CLI has had all along.
  assert.equal(autoAvailable(AgentProvider.CODEX, 'gpt-5.6-sol'), true);
  assert.equal(autoAvailable(AgentProvider.KIMI, 'any-local-alias'), true);
  assert.equal(autoAvailable(AgentProvider.OPENCODE, ''), true);
  // agy runs it as --dangerously-skip-permissions, on any model it lists.
  assert.equal(autoAvailable(AgentProvider.ANTIGRAVITY, 'gemini-3.1-pro'), true);
  assert.equal(autoAvailable(AgentProvider.CLAUDE, 'claude-opus-5'), true);
  assert.equal(autoAvailable(AgentProvider.CLAUDE, 'claude-haiku-4-5'), false);
  // A configured provider's model space is vendor-defined; the CLI decides for itself.
  assert.equal(autoAvailable(AgentProvider.CLAUDE, 'deepseek-v4', true), true);
  assert.equal(autoAvailable(AgentProvider.DSH, 'deepseek-v4-pro'), false);
});

test('DeepSeek Harness rejects every permission mode with partial approval and explanatory notes', () => {
  const catalog = {
    [AgentProvider.DSH]: [{
      value: 'opaque-model', label: 'Model', permissionModes: [PermissionMode.AUTO],
    }],
  };
  for (const mode of [undefined, null, ...Object.values(PermissionMode), 'unknown-mode']) {
    for (const runsAsRoot of [undefined, false, true]) {
      const semantics = derivePermissionSemantics(
        AgentProvider.DSH, mode, 'opaque-model', runsAsRoot, catalog,
      );
      assert.equal(semantics.mode, mode ?? PermissionMode.DONT_ASK);
      assert.equal(semantics.unapproved, 'deny', `${mode}/${runsAsRoot}`);
      assert.equal(semantics.honored, false, `${mode}/${runsAsRoot}`);
      assert.equal(semantics.approvalSupport, 'partial');
      assert.match(semantics.note ?? '', /does not support these permission modes/);
      assert.match(semantics.note ?? '', /Session configuration is rejected/);
      assert.match(semantics.shortNote ?? '', /unsupported on DeepSeek Harness/);
      assert.match(semantics.shortNote ?? '', /session configuration is rejected/);
      assert.doesNotMatch(semantics.note ?? '', /runs as Default|runs as Don't Ask/);
    }
  }
  for (const customProvider of [false, true]) {
    assert.equal(autoAvailable(AgentProvider.DSH, 'opaque-model', customProvider, catalog), false);
  }
});

test('Auto on a Claude model without it is disclosed, not hidden', () => {
  const degraded = derivePermissionSemantics(
    AgentProvider.CLAUDE,
    PermissionMode.AUTO,
    'claude-haiku-4-5',
  );
  // It degrades toward asking (the server runs it as Default), so the guarantee is stronger
  // than the mode's plain reading rather than weaker — and it is stated either way.
  assert.deepEqual({ u: degraded.unapproved, h: degraded.honored }, { u: 'ask', h: false });
  assert.match(degraded.shortNote ?? '', /runs as Default/);
  // Omitting the model means "already normalized for dispatch" and must not invent a caveat.
  assert.equal(derivePermissionSemantics(AgentProvider.CLAUDE, PermissionMode.AUTO).honored, true);
});

test('a caveat is carried as data exactly when the mode is not honored', () => {
  // The picker renders `shortNote` verbatim instead of rebuilding the wording from
  // honored/unapproved. That is only safe if the table always supplies one — the missing pair
  // here is precisely how a greyed Auto option came to state a reason the gate did not use.
  for (const provider of Object.values(AgentProvider)) {
    for (const mode of Object.values(PermissionMode)) {
      for (const model of ['claude-opus-5', 'claude-haiku-4-5']) {
        const semantics = derivePermissionSemantics(provider, mode, model);
        assert.equal(
          semantics.shortNote !== undefined,
          !semantics.honored,
          `${provider}/${mode}/${model}: shortNote must accompany an unhonored mode, and only one`,
        );
      }
    }
  }
});

test('approval support is reported per runtime', () => {
  assert.equal(runtimeApprovalSupport(AgentProvider.CLAUDE), 'full');
  assert.equal(runtimeApprovalSupport(AgentProvider.KIMI), 'partial');
  assert.equal(runtimeApprovalSupport(AgentProvider.OPENCODE), 'none');
  // Through Orbit's PreToolUse hook; subagents, whose calls the hook never sees, are refused.
  assert.equal(runtimeApprovalSupport(AgentProvider.ANTIGRAVITY), 'full');
  // Codex gates its dangerous primitives (commands, patches) but not every tool.
  assert.equal(runtimeApprovalSupport(AgentProvider.CODEX), 'partial');
  // Harness can ask about file sandbox expansion, but its Orbit mode mappings remain unverified.
  assert.equal(runtimeApprovalSupport(AgentProvider.DSH), 'partial');
});

const ROW = {
  status: 'RUNNING',
  cancelRequestedAt: null,
  startedAt: new Date(),
  numTurns: 1,
  runtimeSessionId: 'rt-1',
  assignedRunner: null,
};

test('a session payload carries the semantics of the runtime that runs it', () => {
  const codex = withSessionCapabilities({
    ...ROW,
    provider: 'codex',
    providerBuiltin: true,
    permissionMode: PermissionMode.DONT_ASK,
  });
  assert.equal(codex.permissionSemantics?.unapproved, 'allow');
  assert.equal(codex.permissionSemantics?.honored, false);
  assert.equal(codex.permissionSemantics?.mode, PermissionMode.DONT_ASK, 'intent is echoed alongside reality');
});

test('a custom provider omits the field rather than guessing its borrowed runtime', () => {
  const byok = withSessionCapabilities({
    ...ROW,
    provider: 'my-deepseek',
    providerBuiltin: false,
    permissionMode: PermissionMode.DEFAULT,
  });
  assert.equal(byok.permissionSemantics, undefined);
  // Lifecycle capabilities are unaffected by the addition.
  assert.equal(typeof byok.capabilities.canSend, 'boolean');
});

test('a row with no provider information still derives lifecycle capabilities', () => {
  const bare = withSessionCapabilities({ ...ROW });
  assert.equal(bare.permissionSemantics, undefined);
  assert.equal(typeof bare.capabilities.canResume, 'boolean');
});

test('an Antigravity session payload says what its mode means on agy, not on Claude', () => {
  // Resolved as the built-in runtime it is: Default asks through Orbit's approval hook, and Don't
  // Ask keeps agy's own refusal.
  const agy = withSessionCapabilities({
    ...ROW,
    provider: 'antigravity',
    providerBuiltin: true,
    permissionMode: PermissionMode.DEFAULT,
  });
  assert.equal(agy.permissionSemantics?.approvalSupport, 'full');
  assert.equal(agy.permissionSemantics?.unapproved, 'ask');
  assert.equal(agy.permissionSemantics?.honored, true);
  const dontAsk = withSessionCapabilities({
    ...ROW,
    provider: 'antigravity',
    providerBuiltin: true,
    permissionMode: PermissionMode.DONT_ASK,
  });
  assert.equal(dontAsk.permissionSemantics?.unapproved, 'deny');
  assert.equal(dontAsk.permissionSemantics?.honored, true);
});
